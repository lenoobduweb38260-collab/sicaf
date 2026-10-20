/**
 * Noyau de l'application cliente : amorçage, connexion (en deux étapes si la double authentification
 * est active), navigation, droits, thème, enrôlement de la double authentification.
 *
 * Les vues s'enregistrent avec :
 *   GMAO.registerView('ot', { titre: 'Ordres de travail', rendu(container, { params, query }) { ... } });
 * et sont affichées via le hash : #/ot, #/ot/12, #/ot/12?onglet=historique
 *
 * Helpers : GMAO.can('ot', 'modifier'), GMAO.liste('statutsOT'), GMAO.refs.users, GMAO.config, GMAO.user, GMAO.perms
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  const GROUPES = {
    exploitation: { label: 'Exploitation', modules: ['dashboard', 'equipements', 'plans', 'demandes', 'ot', 'preventif', 'planning'] },
    magasin: { label: 'Magasin & achats', modules: ['stock', 'inventaire', 'fournisseurs', 'achats'] },
    qualite: { label: 'Qualité & visites', modules: ['visites'] },
    pilotage: { label: 'Pilotage', modules: ['rapports', 'rh'] },
    administration: { label: 'Administration', modules: ['utilisateurs', 'profils', 'configuration', 'systeme', 'audit'] },
  };

  const GMAO = window.GMAO = {
    user: null, perms: null, config: {}, modules: [], refs: { users: [], secteurs: [], profils: [] }, catalogue: { modules: [], actions: {}, portees: {} }, version: '',
    /** Libellés du journal d'activité (actions et éléments), partagés par les vues qui affichent un historique. */
    libelles: { actions: {}, entites: {} },
    libelleAction(code) { return (this.libelles.actions || {})[code] || (code == null ? '' : String(code)); },
    libelleEntite(code) { return (this.libelles.entites || {})[code] || (code == null ? '' : String(code)); },
    /** État de la double authentification du compte : { actif, activeLe, codesSecoursRestants, mode, exige, enrolementRequis }. */
    deuxFacteurs: null,
    /** État du mot de passe : { doitChanger (changement imposé par le serveur), raison, dateMdp, expireLe, joursRestants, rappel }. */
    motDePasse: null,
    vues: {}, route: { module: null, params: [], query: {} },
    _badges: {}, _vueCourante: null,

    registerView(cle, def) { this.vues[cle] = Object.assign({ cle }, def); },

    /**
     * Fonctions appelées à chaque connexion (après l'amorçage, avant l'affichage de la première vue) : les modules
     * peuvent y initialiser leurs compteurs du menu. Appelée aussitôt si un utilisateur est déjà connecté. Tant qu'un
     * écran est imposé (changement de mot de passe, enrôlement de la double authentification), ces fonctions attendent :
     * elles sont appelées une fois l'écran imposé terminé (`GMAO.refresh`).
     */
    _surConnexion: [],
    onConnexion(fn) {
      if (typeof fn !== 'function') return;
      this._surConnexion.push(fn);
      if (this.user && !this.ecranImpose()) { try { fn(this.user); } catch (e) { console.error(e); } }
    },
    /** Changement de mot de passe ou enrôlement de la double authentification imposé : aucune donnée avant. */
    ecranImpose() { return this.changementMdpRequis() || this.deuxFacteursRequis(); },
    /** Crochets de connexion et notifications : après l'amorçage, ou une fois l'écran imposé terminé. */
    _apresConnexion() {
      for (const fn of this._surConnexion) { try { fn(this.user); } catch (e) { console.error(e); } }
      majNotifications();
    },
    /** Sortie de la vue affichée (changement de vue, déconnexion) : appelle son crochet `quitter()` s'il existe. */
    _quitterVue() {
      const def = this._vueDef;
      this._vueDef = null;
      if (def && typeof def.quitter === 'function') { try { def.quitter(); } catch (e) { console.error(e); } }
    },

    can(module, action) {
      action = action || 'voir';
      return !!(this.perms && this.perms.modules && this.perms.modules[module] && this.perms.modules[module][action]);
    },
    moduleDef(key) { return this.modules.find((m) => m.key === key) || null; },
    moduleLabel(key) { const m = this.moduleDef(key); return m ? m.label : key; },
    moduleVisible(key) { const m = this.moduleDef(key); return !!(m && m.actif && this.can(key, 'voir') && this.vues[key]); },
    liste(nom) {
      const l = ((this.config || {}).listes || {})[nom];
      return Array.isArray(l) ? l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
    },
    estAdmin() { return !!(this.perms && this.perms.estAdmin); },

    navigate(hash) { if (location.hash === hash) this.rendre(); else location.hash = hash; },

    setNavBadge(module, valeur) {
      this._badges[module] = valeur;
      const item = document.querySelector(`.nav-item[data-module="${module}"]`);
      if (!item) return;
      let b = item.querySelector('.nav-badge');
      if (!valeur) { if (b) b.remove(); return; }
      if (!b) { b = el('span', { class: 'nav-badge' }); item.appendChild(b); }
      b.textContent = String(valeur);
    },

    /** Recharge l'amorçage (droits, config, références) sans recharger la page. */
    async refresh(rerendre = true) {
      // Écran imposé en cours ou tout juste terminé (changement de mot de passe, enrôlement) : les crochets de connexion
      // (compteurs du menu…) et les notifications n'ont pas encore été appelés
      const etaitImpose = this.ecranImpose() || !!this._changementMdpEffectue;
      this._changementMdpEffectue = false;
      const data = await api.get('/api/auth/me', null, { silent401: true });
      appliquerBootstrap(data);
      construireNavigation();
      appliquerTheme();
      majRappelMdp();
      if (rerendre) this.rendre();
      if (GMAO.changementMdpRequis()) imposerChangementMdp();
      else if (GMAO.deuxFacteursRequis()) imposerEnrolement();
      else if (etaitImpose) this._apresConnexion();
    },
    async refreshRefs() { return this.refresh(false); },

    onNonAuthentifie() {
      if (GMAO.user) { GMAO.user = null; GMAO._badges = {}; ui.fermerToasts(); toast('Session expirée, veuillez vous reconnecter', 'alerte'); afficherConnexion(); }
    },

    /**
     * Réponse 403 « changement de mot de passe requis » (mot de passe expiré, réinitialisé…) : plus aucun écran
     * n'est chargé et la fenêtre de changement est imposée (une seule fois, sans nouvel appel au serveur).
     */
    onChangementMdpRequis(details) {
      if (!GMAO.user) return;
      if (!GMAO.changementMdpRequis()) {
        GMAO.motDePasse = Object.assign({}, GMAO.motDePasse || {}, { doitChanger: true, rappel: false, raison: (details && details.raison) || (GMAO.motDePasse && GMAO.motDePasse.raison) || null });
        majRappelMdp();
        GMAO.rendre();
      }
      imposerChangementMdp();
    },

    async deconnexion() {
      GMAO._quitterVue();
      try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ }
      GMAO.user = null; GMAO.perms = null;
      GMAO._badges = {}; // compteurs du menu propres à la session
      ui.fermerToasts(); // rien de la session (code de secours utilisé, mot de passe modifié…) pour la personne suivante
      location.hash = '';
      afficherConnexion();
    },

    /**
     * Changement du mot de passe : règles cochées pendant la saisie et robustesse ; `force` : changement imposé
     * (raison affichée, fenêtre impossible à fermer sauf déconnexion) ; `apres` est appelé une fois le nouveau
     * mot de passe enregistré.
     */
    ouvrirChangementMdp(force, apres) {
      const etat = GMAO.motDePasse || {};
      const raison = etat.raison || 'initial';
      const sc = GMAO.config.securite || {};
      const messages = {
        initial: 'Pour sécuriser votre compte, vous devez choisir un nouveau mot de passe personnel avant de continuer.',
        reinitialise: 'Votre mot de passe a été réinitialisé par le pôle informatique : remplacez le mot de passe temporaire par un mot de passe personnel avant de continuer.',
        expire: `Votre mot de passe a expiré${sc.expirationMdpJours ? ` (il doit être changé tous les ${sc.expirationMdpJours} jours)` : ''} : choisissez-en un nouveau pour continuer.`,
        administrateur: 'Votre mot de passe a été défini par un administrateur : choisissez un nouveau mot de passe personnel avant de continuer.',
      };
      // Mot de passe actuel : toujours demandé, sauf changement imposé dès l'ouverture de la session (il vient d'être saisi)
      const ancienRequis = !force || etat.ancienRequis !== false;
      const f = ui.form({ colonnes: 1, entreeSoumet: true, champs: [
        ancienRequis ? { nom: 'ancien', label: 'Mot de passe actuel', type: 'mdp', requis: true } : null,
        { nom: 'nouveau', label: 'Nouveau mot de passe', type: 'mdp', requis: true },
        { nom: 'confirmation', label: 'Confirmer le nouveau mot de passe', type: 'mdp', requis: true, valider: (v, vals) => (v !== vals.nouveau ? 'Les mots de passe ne correspondent pas' : '') },
      ] });
      if (ancienRequis) f.controles.ancien.input.setAttribute('autocomplete', 'current-password');
      f.controles.nouveau.input.setAttribute('autocomplete', 'new-password');
      f.controles.confirmation.input.setAttribute('autocomplete', 'new-password');
      const regles = ui.reglesMdp(f.controles.nouveau.input, {
        politique: { longueurMin: sc.longueurMinMdp, complexite: sc.complexite !== false, interdireIdentifiant: sc.interdireIdentifiant !== false, refuserCourants: sc.refuserCourants },
        login: GMAO.user ? GMAO.user.login : '', confirmation: f.controles.confirmation.input, historique: Math.max(0, Number(sc.historiqueMdp) || 0),
      });
      f.champ('nouveau').insertBefore(regles.el, f.champ('nouveau').querySelector('.erreur-champ'));
      const echeance = !force && etat.expireLe
        ? el('p', { class: 'texte-2 texte-petit' }, `Votre mot de passe actuel expire le ${ui.formatDate(etat.expireLe)}${etat.joursRestants != null ? ` (${etat.joursRestants <= 0 ? 'aujourd\'hui' : etat.joursRestants === 1 ? 'demain' : `dans ${etat.joursRestants} jours`})` : ''}.`)
        : null;
      const m = ui.modal({
        titre: force ? (raison === 'expire' ? 'Mot de passe expiré' : 'Définissez votre mot de passe') : 'Changer mon mot de passe', taille: 'petite', fermable: !force, classe: 'modal-mdp',
        onFermer: () => { modalesImposees.delete(m); if (modaleMdpImposee === m) modaleMdpImposee = null; },
        contenu: frag(force ? ui.alerte(messages[raison] || messages.initial, raison === 'expire' ? 'alerte' : 'info') : echeance, f.el),
        boutons: [
          force ? { label: 'Se déconnecter', icone: 'deconnexion', gauche: true, onClic: () => { setTimeout(() => GMAO.deconnexion(), 0); } } : { label: 'Annuler' },
          { label: 'Enregistrer', classe: 'btn-primaire', onClic: async () => {
            if (!f.valider()) return false;
            if (!regles.conforme()) { f.erreur('nouveau', 'Le nouveau mot de passe ne respecte pas toutes les règles indiquées'); f.controles.nouveau.input.focus(); return false; }
            const v = f.valeurs();
            try {
              await api.post('/api/auth/mot-de-passe', { ancien: v.ancien, nouveau: v.nouveau });
            } catch (e) {
              // Refus du serveur (mot de passe actuel incorrect, historique, politique) : message sous le champ concerné,
              // qui reprend le focus
              if (e.status !== 400) throw e;
              const champ = ancienRequis && /mot de passe actuel|ancien mot de passe incorrect/i.test(e.message) ? 'ancien' : 'nouveau';
              f.erreur(champ, e.message);
              f.controles[champ].input.select();
              f.controles[champ].input.focus();
              return false;
            }
            GMAO.user.doitChangerMdp = false;
            if (GMAO.motDePasse) GMAO.motDePasse = Object.assign({}, GMAO.motDePasse, { doitChanger: false, raison: null, rappel: false });
            majRappelMdp();
            toast('Mot de passe modifié', 'succes');
            if (force) GMAO._changementMdpEffectue = true; // l'amorçage qui suit appelle les crochets de connexion restés en attente
            if (apres) setTimeout(apres, 0);
            else GMAO.refresh(false).catch(() => {}); // nouvelle échéance
          } },
        ],
      });
      if (force) { modalesImposees.add(m); modaleMdpImposee = m; }
      f.el.addEventListener('submit', (ev) => { ev.preventDefault(); m.pied.querySelector('.btn-primaire').click(); });
    },

    async setTheme(theme) {
      GMAO.user.preferences = Object.assign({}, GMAO.user.preferences, { theme });
      appliquerTheme();
      try { await api.put('/api/auth/preferences', { theme }); } catch (e) { /* ignore */ }
    },

    /** Affiche la vue correspondant au hash courant. */
    rendre() {
      const app = document.getElementById('app');
      const contenu = app.querySelector('.contenu');
      if (!contenu) return;
      const hash = location.hash.replace(/^#\/?/, '');
      const [chemin, qs] = hash.split('?');
      const parts = chemin.split('/').filter(Boolean);
      let module = parts[0];
      const query = Object.fromEntries(new URLSearchParams(qs || '').entries());
      if (!module) {
        const premier = GMAO.modules.find((m) => GMAO.moduleVisible(m.key));
        if (premier) { location.replace('#/' + premier.key); return; }
      }
      GMAO.route = { module, params: parts.slice(1), query };
      const vue = GMAO.vues[module];
      // Vue précédente : libération de ses ressources (écouteurs, caméra, minuteries) avant d'afficher la suivante
      GMAO._quitterVue();
      ui.fermerModales();
      ui.vider(contenu);
      if (GMAO.changementMdpRequis()) {
        // Changement de mot de passe imposé : aucun écran (ni appel au serveur) avant le nouveau mot de passe
        const titre = app.querySelector('.entete-titre');
        if (titre) titre.textContent = 'Changement de mot de passe';
        contenu.appendChild(el('div', { class: 'vue' }, ui.vide('Vous devez choisir un nouveau mot de passe pour accéder à la GMAO.', 'cle'),
          el('div', { class: 'texte-centre' }, ui.bouton('Changer mon mot de passe', { classe: 'btn-primaire', icone: 'cle', onClic: () => imposerChangementMdp() }))));
        return;
      }
      if (GMAO.deuxFacteursRequis()) {
        // Double authentification imposée et pas encore activée : aucun écran avant l'enrôlement
        const titre = app.querySelector('.entete-titre');
        if (titre) titre.textContent = 'Double authentification';
        contenu.appendChild(el('div', { class: 'vue' }, ui.vide('La double authentification est obligatoire pour votre compte : activez-la pour accéder à la GMAO.', 'cle'),
          el('div', { class: 'texte-centre' }, ui.bouton('Activer la double authentification', { classe: 'btn-primaire', icone: 'cle', onClic: () => imposerEnrolement() }))));
        return;
      }
      document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('actif', a.dataset.module === module));
      const titreEl = app.querySelector('.entete-titre');
      if (!vue || !GMAO.moduleVisible(module)) {
        if (titreEl) titreEl.textContent = 'Accès non autorisé';
        contenu.appendChild(el('div', { class: 'vue' }, ui.vide(module && !vue ? `La vue « ${module} » n'existe pas.` : 'Vous n\'avez pas accès à ce module. Contactez votre administrateur.', 'alerte')));
        return;
      }
      if (titreEl) titreEl.textContent = typeof vue.titre === 'function' ? vue.titre() : (GMAO.moduleLabel(module) || vue.titre);
      document.title = `${GMAO.moduleLabel(module)} · ${(GMAO.config.societe || {}).nom || 'GMAO'}`;
      const conteneur = el('div', { class: 'vue', dataset: { module } });
      contenu.appendChild(conteneur);
      GMAO._vueCourante = module;
      GMAO._vueDef = vue;
      try {
        const r = vue.rendu(conteneur, { params: GMAO.route.params, query });
        if (r && typeof r.then === 'function') {
          conteneur.appendChild(ui.chargement());
          r.then((n) => { if (GMAO._vueCourante !== module || !conteneur.isConnected) return; const ch = conteneur.querySelector(':scope > .chargement'); if (ch) ch.remove(); if (n instanceof Node) conteneur.appendChild(n); })
            .catch((e) => {
              const ch = conteneur.querySelector(':scope > .chargement'); if (ch) ch.remove();
              if (e && e.details && e.details.deuxFacteursRequis) { if (!GMAO.deuxFacteursRequis()) GMAO.refresh(true).catch(() => {}); return; } // obligation activée entre-temps
              if (e && e.details && e.details.changementMdpRequis) return; // fenêtre de changement déjà imposée (api.js)
              conteneur.appendChild(ui.alerte('Erreur : ' + (e.message || e), 'danger')); console.error(e);
            });
        } else if (r instanceof Node) conteneur.appendChild(r);
      } catch (e) {
        conteneur.appendChild(ui.alerte('Erreur d\'affichage : ' + (e.message || e), 'danger'));
        console.error(e);
      }
    },
  };

  // ----- Amorçage --------------------------------------------------------
  function appliquerBootstrap(data) {
    GMAO.user = data.user;
    GMAO.perms = data.permissions;
    GMAO.config = data.config || {};
    GMAO.modules = data.modules || [];
    GMAO.catalogue = data.catalogue || GMAO.catalogue;
    GMAO.refs = data.references || GMAO.refs;
    GMAO.version = data.version || '';
    GMAO.deuxFacteurs = data.deuxFacteurs || null;
    GMAO.motDePasse = data.motDePasse || null;
    if (data.libelles) GMAO.libelles = { actions: data.libelles.actions || {}, entites: data.libelles.entites || {} };
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 99, 235];
  }
  function assombrir(hex, f) { const [r, g, b] = hexToRgb(hex).map((c) => Math.max(0, Math.round(c * (1 - f)))); return `rgb(${r},${g},${b})`; }

  /** Luminance relative (WCAG) d'une couleur [r, g, b]. */
  function luminance(rgb) {
    const c = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contraste(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
  /**
   * Couleur des liens et des éléments actifs : la couleur principale, éclaircie (thème sombre) ou assombrie (thème
   * clair) juste assez pour un contraste d'au moins 4,5:1 sur les fonds de l'application (lisibilité des textes).
   */
  function couleurLien(couleur, theme) {
    const fonds = theme === 'sombre' ? [[30, 41, 59], [15, 23, 42], [39, 52, 73]] : [[255, 255, 255], [243, 244, 246], [249, 250, 251]];
    const vers = theme === 'sombre' ? 255 : 0;
    const base = hexToRgb(couleur);
    // Fond « --primaire-clair » (élément actif d'un arbre, groupe de boutons) posé sur la surface ou sur le fond de page
    const alpha = theme === 'sombre' ? 0.28 : 0.14;
    fonds.slice(0, 2).forEach((fd) => fonds.push(fd.map((v, i) => Math.round(base[i] * alpha + v * (1 - alpha)))));
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const rgb = base.map((v) => Math.round(v + (vers - v) * f));
      if (fonds.every((fd) => contraste(rgb, fd) >= 4.6)) return `rgb(${rgb.join(',')})`;
    }
    return theme === 'sombre' ? '#ffffff' : '#000000';
  }

  function appliquerTheme() {
    const pref = (GMAO.user && GMAO.user.preferences && GMAO.user.preferences.theme) || ((GMAO.config.general || {}).theme) || 'clair';
    let theme = pref;
    if (pref === 'auto') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
    document.documentElement.setAttribute('data-theme', theme);
    const couleur = (GMAO.config.general || {}).couleurPrincipale || '#2563eb';
    const [r, g, b] = hexToRgb(couleur);
    const root = document.documentElement.style;
    root.setProperty('--primaire', couleur);
    root.setProperty('--primaire-fonce', assombrir(couleur, 0.15));
    root.setProperty('--primaire-clair', theme === 'sombre' ? `rgba(${r},${g},${b},0.28)` : `rgba(${r},${g},${b},0.14)`);
    root.setProperty('--lien', couleurLien(couleur, theme));
  }

  function chargerScript(src) {
    return new Promise((resolve) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = el('script', { src, onload: resolve, onerror: () => { console.error('Script non chargé', src); resolve(); } });
      document.head.appendChild(s);
    });
  }
  async function chargerVues() {
    const r = await api.get('/api/views');
    const libs = Array.isArray(r) ? [] : (r.libs || []);
    const vues = Array.isArray(r) ? r : (r.vues || []);
    for (const src of libs) await chargerScript(src); // bibliothèques partagées, dans l'ordre
    await Promise.all(vues.map(chargerScript));
  }

  // ----- Page de connexion -----------------------------------------------
  /**
   * Page de connexion ; `message` : erreur à afficher d'emblée (ex. délai de saisie du code dépassé) ; `login` :
   * identifiant prérempli (nouvelle saisie du mot de passe seulement).
   * La même carte affiche, selon le lien choisi : la connexion, la demande de réinitialisation
   * (« Mot de passe oublié ? ») et le nouveau mot de passe avec un code de réinitialisation ou un code
   * de l'application d'authentification.
   */
  async function afficherConnexion(message, login) {
    const app = document.getElementById('app');
    // Fin de session : aucune fenêtre ne reste ouverte (code ou mot de passe temporaire affiché, saisie en cours)
    fermerModalesImposees();
    ui.fermerModales(true);
    let infos = { societe: {}, general: {} };
    try { infos = await api.get('/api/auth/infos'); } catch (e) { /* serveur injoignable */ }
    GMAO.config = { societe: infos.societe, general: infos.general };
    appliquerTheme();
    ui.vider(app);
    const err = el('div', { class: 'connexion-erreur masque', role: 'alert' });
    const zone = el('div');
    const soc = infos.societe || {};
    app.appendChild(el('div', { class: 'connexion' }, el('div', { class: 'connexion-carte' },
      el('div', { class: 'connexion-logo' }, soc.logo ? el('img', { src: soc.logo, alt: soc.nom }) : el('div', { class: 'connexion-titre' }, soc.nom || 'GMAO'), el('div', { class: 'connexion-sous-titre' }, soc.slogan || 'Gestion de Maintenance Assistée par Ordinateur')),
      (infos.general || {}).messageAccueil ? el('div', { class: 'connexion-accueil' }, infos.general.messageAccueil) : null,
      err, zone,
      el('div', { class: 'connexion-pied' }, `GMAO ${infos.version ? 'v' + infos.version : ''}${infos.premierDemarrage ? ' · Première connexion : admin / admin (mot de passe à changer immédiatement)' : ''}`))));
    const c = { zone, err, infos, login: login || '' };
    vueConnexion(c);
    if (message) erreurConnexion(c, message);
  }

  /**
   * Message d'erreur de la carte de connexion (vide = masqué). La carte peut dépasser la hauteur de l'écran (nouveau
   * mot de passe avec un code) et la page être défilée jusqu'au bouton d'envoi : le message, en haut de la carte, est
   * ramené dans la zone visible avant que le champ concerné ne reprenne le focus.
   */
  function erreurConnexion(c, message) {
    c.err.textContent = message || '';
    c.err.classList.toggle('masque', !message);
    if (message && typeof c.err.scrollIntoView === 'function') c.err.scrollIntoView({ block: 'nearest' });
  }
  /** Liens discrets sous un formulaire de la carte de connexion : [[libellé, action, classe?], …]. */
  function liensConnexion(liens) {
    return el('div', { class: 'connexion-liens' }, liens.filter(Boolean).map(([label, action, classe]) => el('button', { type: 'button', class: 'btn btn-lien btn-sm' + (classe ? ' ' + classe : ''), onclick: action }, label)));
  }
  /** Titre d'un panneau de la carte de connexion. */
  function titrePanneau(ic, titre, texte) {
    return frag(el('div', { class: 'connexion-panneau-titre' }, icone(ic), titre), texte ? el('p', { class: 'texte-2 texte-petit connexion-panneau-texte' }, texte) : null);
  }
  /** Mise au point différée d'un champ de la carte, sauf si la saisie a déjà commencé dans la carte. */
  function mettreAuPoint(c, element) {
    setTimeout(() => { if (element.isConnected && !c.zone.contains(document.activeElement)) element.focus(); }, 50);
  }
  /** Bouton d'envoi : désactivé, avec un libellé d'attente, pendant `action`. */
  async function pendantEnvoi(btn, libelle, action) {
    const initial = btn.textContent;
    btn.disabled = true; btn.textContent = libelle;
    try { return await action(); } finally { btn.disabled = false; btn.textContent = initial; }
  }

  /** Formulaire de connexion (identifiant, mot de passe) et liens « Mot de passe oublié ? », « J'ai un code ». */
  function vueConnexion(c) {
    ui.vider(c.zone);
    erreurConnexion(c, '');
    const f = ui.form({ colonnes: 1, champs: [
      { nom: 'login', label: 'Identifiant', type: 'texte', requis: true, placeholder: 'ex. admin', valeur: c.login },
      { nom: 'password', label: 'Mot de passe', type: 'mdp', requis: true },
    ] });
    const inLogin = f.controles.login.input;
    inLogin.setAttribute('autocomplete', 'username');
    f.controles.password.input.setAttribute('autocomplete', 'current-password');
    const btn = el('button', { class: 'btn btn-primaire', type: 'submit' }, 'Se connecter');
    f.el.appendChild(el('div', { class: 'champ pleine-largeur' }, btn));
    let envoi = false;
    f.el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (envoi || !f.valider()) return;
      envoi = true; erreurConnexion(c, '');
      try {
        await pendantEnvoi(btn, 'Connexion…', async () => {
          const data = await api.post('/api/auth/login', f.valeurs(), { silent401: true });
          if (data && data.deuxFacteurs === true && data.jeton) { c.login = inLogin.value.trim(); etapeCode(c, data.jeton); return; }
          await demarrer(data);
        });
      } catch (e) {
        erreurConnexion(c, e.message);
      } finally { envoi = false; }
    });
    const memoriser = () => { c.login = inLogin.value.trim(); };
    c.zone.appendChild(f.el);
    c.zone.appendChild(liensConnexion([
      c.infos.motDePasseOublie ? ['Mot de passe oublié ?', () => { memoriser(); vueDemande(c); }, 'lien-oubli'] : null,
      ['J\'ai un code de réinitialisation', () => { memoriser(); vueCode(c, 'code'); }, 'lien-code'],
    ]));
    mettreAuPoint(c, c.login ? f.controles.password.input : inLogin);
  }

  /** « Mot de passe oublié ? » : demande adressée au pôle informatique (réponse identique pour tout identifiant). */
  function vueDemande(c) {
    ui.vider(c.zone);
    erreurConnexion(c, '');
    const f = ui.form({ colonnes: 1, champs: [
      { nom: 'identifiant', label: 'Identifiant', type: 'texte', requis: true, valeur: c.login, placeholder: 'Votre identifiant de connexion' },
      { nom: 'message', label: 'Message pour le pôle informatique (facultatif)', type: 'texte_long', lignes: 2, placeholder: 'ex. atelier 2, joignable au poste 2145' },
    ] });
    const inLogin = f.controles.identifiant.input;
    inLogin.setAttribute('autocomplete', 'username');
    const msg = f.controles.message.input;
    msg.setAttribute('maxlength', '300');
    const compteur = el('div', { class: 'aide texte-droite' }, '0 / 300');
    msg.addEventListener('input', () => { compteur.textContent = `${msg.value.length} / 300`; });
    f.champ('message').insertBefore(compteur, f.champ('message').querySelector('.erreur-champ'));
    const btn = el('button', { class: 'btn btn-primaire', type: 'submit' }, 'Envoyer la demande');
    f.el.appendChild(el('div', { class: 'champ pleine-largeur' }, btn));
    let envoi = false;
    f.el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (envoi || !f.valider()) return;
      const v = f.valeurs();
      envoi = true; erreurConnexion(c, '');
      try {
        await pendantEnvoi(btn, 'Envoi…', () => api.post('/api/auth/mot-de-passe-oublie', { login: v.identifiant.trim(), message: v.message.trim() || undefined }, { silent401: true }));
        c.login = v.identifiant.trim();
        vueDemandeEnvoyee(c);
      } catch (e) {
        erreurConnexion(c, e.message);
      } finally { envoi = false; }
    });
    c.zone.appendChild(frag(
      titrePanneau('cle', 'Demander une réinitialisation', 'Indiquez votre identifiant : le pôle informatique recevra votre demande et vous remettra un code de réinitialisation. Vous choisirez ensuite vous-même votre nouveau mot de passe.'),
      f.el,
      liensConnexion([['Retour à la connexion', () => { c.login = inLogin.value.trim(); vueConnexion(c); }], ['J\'ai déjà un code', () => { c.login = inLogin.value.trim(); vueCode(c, 'code'); }]])));
    mettreAuPoint(c, inLogin.value ? msg : inLogin);
  }

  /** Confirmation générique de la demande (aucune indication sur l'existence du compte) et suite de la procédure. */
  function vueDemandeEnvoyee(c) {
    ui.vider(c.zone);
    erreurConnexion(c, '');
    const btn = el('button', { class: 'btn btn-primaire', type: 'button', onclick: () => vueCode(c, 'code') }, 'J\'ai reçu un code');
    c.zone.appendChild(frag(
      titrePanneau('check', 'Demande envoyée'),
      ui.alerte('Si cet identifiant correspond à un compte actif, le pôle informatique a été prévenu de votre demande.', 'ok'),
      el('div', { class: 'texte-petit texte-gras' }, 'Et ensuite ?'),
      el('ol', { class: 'connexion-etapes' },
        el('li', null, 'Le pôle informatique vérifie votre identité, puis vous remet un code de réinitialisation (8 caractères, valable un temps limité) ou un mot de passe temporaire.'),
        el('li', null, 'Avec un code : revenez sur cet écran et choisissez « J\'ai un code de réinitialisation ».'),
        el('li', null, 'Saisissez votre identifiant, le code et votre nouveau mot de passe : vous êtes aussitôt connecté.')),
      c.infos.reinitialisationAutonome ? el('p', { class: 'texte-2 texte-petit' }, 'Double authentification active sur votre compte ? Vous pouvez aussi choisir vous-même un nouveau mot de passe avec votre application d\'authentification, depuis « J\'ai un code de réinitialisation ».') : null,
      el('div', { class: 'champ' }, btn),
      liensConnexion([['Retour à la connexion', () => vueConnexion(c)]])));
    mettreAuPoint(c, btn);
  }

  /** Normalise la saisie d'un code de réinitialisation (minuscules, espaces et tirets tolérés) : « ABCD-EF23 ». */
  const ALPHABET_CODE_REINIT = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function formaterCodeReinit(saisie) {
    const brut = String(saisie || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 8);
    return brut.length > 4 ? `${brut.slice(0, 4)}-${brut.slice(4)}` : brut;
  }

  /**
   * Nouveau mot de passe depuis l'écran de connexion, avec un code de réinitialisation remis par le pôle
   * informatique (`mode` « code ») ou, si la configuration le permet, un code de l'application
   * d'authentification (`mode` « application »). Aucune session n'est ouverte par la réinitialisation :
   * une connexion normale suit (double authentification comprise).
   */
  function vueCode(c, mode) {
    ui.vider(c.zone);
    erreurConnexion(c, '');
    const viaApplication = mode === 'application' && !!c.infos.reinitialisationAutonome;
    const pol = c.infos.politiqueMdp || {};
    const f = ui.form({ colonnes: 1, champs: [
      { nom: 'identifiant', label: 'Identifiant', type: 'texte', requis: true, valeur: c.login, placeholder: 'Votre identifiant de connexion' },
      { nom: 'codeReinit', label: viaApplication ? 'Code de votre application d\'authentification' : 'Code de réinitialisation', type: 'texte', requis: true, placeholder: viaApplication ? '000000' : 'XXXX-XXXX',
        aide: viaApplication ? 'Code à 6 chiffres affiché par votre application (les codes de secours ne sont pas acceptés).' : 'Code de 8 caractères remis par le pôle informatique (majuscules ou minuscules, avec ou sans tiret).' },
      { nom: 'nouveauMdp', label: 'Nouveau mot de passe', type: 'mdp', requis: true },
      { nom: 'confirmationMdp', label: 'Confirmer le nouveau mot de passe', type: 'mdp', requis: true, valider: (v, vals) => (v !== vals.nouveauMdp ? 'Les mots de passe ne correspondent pas' : '') },
    ] });
    const inLogin = f.controles.identifiant.input;
    const inCode = f.controles.codeReinit.input;
    const inNouveau = f.controles.nouveauMdp.input;
    const inConfirmation = f.controles.confirmationMdp.input;
    inLogin.setAttribute('autocomplete', 'username');
    inNouveau.setAttribute('autocomplete', 'new-password');
    inConfirmation.setAttribute('autocomplete', 'new-password');
    inCode.classList.add('saisie-code');
    inCode.setAttribute('spellcheck', 'false');
    inCode.setAttribute('autocomplete', viaApplication ? 'one-time-code' : 'off');
    inCode.setAttribute('inputmode', viaApplication ? 'numeric' : 'text');
    inCode.setAttribute('autocapitalize', 'characters');
    inCode.setAttribute('maxlength', viaApplication ? '6' : '20');
    inCode.addEventListener('input', () => {
      const v = viaApplication ? inCode.value.replace(/\D/g, '').slice(0, 6) : formaterCodeReinit(inCode.value);
      if (v !== inCode.value) inCode.value = v;
    });
    const regles = ui.reglesMdp(inNouveau, { politique: pol, login: () => inLogin.value, confirmation: inConfirmation });
    inLogin.addEventListener('input', regles.maj);
    f.champ('nouveauMdp').insertBefore(regles.el, f.champ('nouveauMdp').querySelector('.erreur-champ'));
    const btn = el('button', { class: 'btn btn-primaire', type: 'submit' }, 'Enregistrer et me connecter');
    f.el.appendChild(el('div', { class: 'champ pleine-largeur' }, btn));
    let envoi = false;
    f.el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (envoi || !f.valider()) return;
      const v = f.valeurs();
      const code = viaApplication ? v.codeReinit.replace(/\s/g, '') : formaterCodeReinit(v.codeReinit).replace('-', '');
      if (viaApplication ? !/^\d{6}$/.test(code) : (code.length !== 8 || [...code].some((x) => !ALPHABET_CODE_REINIT.includes(x)))) {
        f.erreur('codeReinit', viaApplication ? 'Saisissez les 6 chiffres affichés par votre application' : 'Le code comporte 8 caractères, par exemple ABCD-EF23 (il ne contient ni I, ni O, ni 0, ni 1)');
        inCode.focus();
        return;
      }
      if (!regles.conforme()) { f.erreur('nouveauMdp', 'Le nouveau mot de passe ne respecte pas toutes les règles indiquées'); inNouveau.focus(); return; }
      const login = v.identifiant.trim();
      envoi = true; erreurConnexion(c, '');
      try {
        await pendantEnvoi(btn, 'Enregistrement…', async () => {
          await api.post(viaApplication ? '/api/auth/reinitialiser-autonome' : '/api/auth/reinitialiser', { login, code, nouveau: v.nouveauMdp }, { silent401: true });
          await connexionApresReinitialisation(c, login, v.nouveauMdp, viaApplication);
        });
      } catch (e) {
        erreurConnexion(c, e.message);
        // Code refusé : nouvelle saisie du code ; mot de passe refusé : nouvelle saisie du mot de passe
        if (e.status === 400 && /code/i.test(e.message)) { inCode.select(); inCode.focus(); } else inNouveau.focus();
      } finally { envoi = false; }
    });
    const memoriser = () => { c.login = inLogin.value.trim(); };
    c.zone.appendChild(frag(
      titrePanneau(viaApplication ? 'profils' : 'cle', viaApplication ? 'Nouveau mot de passe avec votre application' : 'Nouveau mot de passe avec un code',
        viaApplication ? 'Possible uniquement si la double authentification est active sur votre compte. Le pôle informatique en est informé.' : null),
      f.el,
      liensConnexion([
        c.infos.reinitialisationAutonome ? [viaApplication ? 'Utiliser un code du pôle informatique' : 'Utiliser mon application d\'authentification', () => { memoriser(); vueCode(c, viaApplication ? 'code' : 'application'); }, 'lien-mode'] : null,
        !viaApplication && c.infos.motDePasseOublie ? ['Je n\'ai pas de code', () => { memoriser(); vueDemande(c); }] : null,
        ['Retour à la connexion', () => { memoriser(); vueConnexion(c); }],
      ])));
    mettreAuPoint(c, inLogin.value ? inCode : inLogin);
  }

  /**
   * Après une réinitialisation réussie : connexion normale avec le nouveau mot de passe, code de la double
   * authentification demandé si elle est active (la réinitialisation ne la contourne jamais).
   */
  async function connexionApresReinitialisation(c, login, motDePasse, viaApplication) {
    c.login = login;
    let data;
    try {
      data = await api.post('/api/auth/login', { login, password: motDePasse }, { silent401: true });
    } catch (e) {
      vueConnexion(c);
      erreurConnexion(c, `Votre nouveau mot de passe est enregistré, mais la connexion automatique a échoué : ${e.message}`);
      return;
    }
    if (data && data.deuxFacteurs === true && data.jeton) {
      etapeCode(c, data.jeton, viaApplication
        ? 'Nouveau mot de passe enregistré. Pour vous connecter, saisissez le prochain code affiché par votre application (celui que vous venez d\'utiliser n\'est plus valable).'
        : 'Nouveau mot de passe enregistré. La double authentification reste exigée : saisissez le code de votre application pour vous connecter.');
      return;
    }
    await demarrer(data);
    toast('Nouveau mot de passe enregistré : vous êtes connecté', 'succes');
  }

  /** Champ de saisie d'un code de vérification (6 chiffres) ou, en mode secours, d'un code de secours. */
  function champCode(id, onComplet) {
    const input = el('input', { type: 'text', id, name: 'code', spellcheck: 'false', autocapitalize: 'off', style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: '22px', textAlign: 'center' } });
    input.definirMode = (secours) => {
      input.dataset.mode = secours ? 'secours' : 'application';
      input.value = '';
      input.setAttribute('inputmode', secours ? 'text' : 'numeric');
      input.setAttribute('autocomplete', secours ? 'off' : 'one-time-code');
      input.setAttribute('maxlength', secours ? '11' : '6');
      input.setAttribute('placeholder', secours ? 'xxxxx-xxxxx' : '000000');
      if (secours) input.removeAttribute('pattern'); else input.setAttribute('pattern', '[0-9]*');
      input.style.letterSpacing = secours ? '2px' : '8px';
    };
    input.definirMode(false);
    input.addEventListener('input', () => {
      if (input.dataset.mode === 'secours') return;
      const v = input.value.replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      if (v.length === 6 && onComplet) onComplet(v);
    });
    return input;
  }

  /**
   * Seconde étape de la connexion : code de l'application d'authentification ou code de secours.
   * `info` : message affiché au-dessus (ex. nouveau mot de passe enregistré après une réinitialisation).
   */
  function etapeCode(c, jeton, info) {
    const zone = c.zone;
    ui.vider(zone);
    erreurConnexion(c, '');
    let secours = false;
    let envoi = false;
    const input = champCode('f_code', () => soumettre());
    const label = el('label', { for: 'f_code' }, 'Code de vérification');
    const aide = el('div', { class: 'aide' });
    const btn = el('button', { class: 'btn btn-primaire', type: 'submit' }, 'Valider');
    const lienSecours = el('button', { type: 'button', class: 'btn btn-lien btn-sm', style: { width: 'auto' } });
    const lienRetour = el('button', { type: 'button', class: 'btn btn-lien btn-sm', style: { width: 'auto' }, onclick: () => afficherConnexion() }, 'Changer d\'identifiant');
    const majMode = () => {
      input.definirMode(secours);
      label.textContent = secours ? 'Code de secours' : 'Code de vérification';
      aide.textContent = secours
        ? 'Saisissez l\'un de vos codes de secours (10 caractères). Chaque code ne peut servir qu\'une seule fois.'
        : 'Code à 6 chiffres affiché par votre application d\'authentification (Microsoft Authenticator, Google Authenticator, FreeOTP…).';
      lienSecours.textContent = secours ? 'Utiliser le code de l\'application' : 'Utiliser un code de secours';
      input.focus();
    };
    lienSecours.addEventListener('click', () => { secours = !secours; majMode(); });
    async function soumettre() {
      if (envoi) return;
      const code = input.value.trim();
      if (!code) { input.focus(); return; }
      envoi = true; btn.disabled = true; erreurConnexion(c, '');
      try {
        const data = await api.post('/api/auth/login/code', { jeton, code }, { silent401: true });
        await demarrer(data);
        const cnx = data.connexion || {};
        if (cnx.codeSecours) toast(`Connexion avec un code de secours : il vous en reste ${cnx.codesSecoursRestants}.${cnx.codesSecoursRestants <= 2 ? ' Générez-en de nouveaux (menu de votre compte › Double authentification).' : ''}`, cnx.codesSecoursRestants <= 2 ? 'alerte' : 'info', 9000);
      } catch (e) {
        // Nouvelle saisie du mot de passe demandée : l'identifiant reste rempli (seul « Changer d'identifiant » le vide)
        if (e && e.details && e.details.recommencer) { afficherConnexion(e.message, c.login); return; }
        erreurConnexion(c, e.message);
        input.value = ''; input.focus();
      } finally { envoi = false; btn.disabled = false; }
    }
    const form = el('form', { class: 'formulaire colonnes-1', novalidate: true },
      el('div', { class: 'champ pleine-largeur' }, label, input, aide),
      el('div', { class: 'champ pleine-largeur' }, btn),
      el('div', { class: 'connexion-liens' }, lienSecours, lienRetour));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); soumettre(); });
    if (info) zone.appendChild(ui.alerte(info, 'ok'));
    zone.appendChild(el('div', { class: 'inline texte-gras', style: { fontSize: '16px', marginBottom: '6px' } }, icone('cle'), 'Vérification en deux étapes'));
    zone.appendChild(el('p', { class: 'texte-2 texte-petit', style: { marginTop: '0' } }, info ? 'Ouvrez votre application d\'authentification et saisissez le code affiché pour « GMAO SICAF ».' : 'Mot de passe correct. Ouvrez votre application d\'authentification et saisissez le code affiché pour « GMAO SICAF ».'));
    zone.appendChild(form);
    majMode();
  }

  // ----- Application connectée ------------------------------------------
  async function demarrer(data) {
    appliquerBootstrap(data);
    appliquerTheme();
    const app = document.getElementById('app');
    ui.vider(app);
    const sidebar = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-logo' }),
      el('nav', { class: 'sidebar-nav' }),
      el('div', { class: 'sidebar-pied' }, el('span', null, 'GMAO v' + GMAO.version), el('button', { class: 'btn btn-icone', title: 'Réduire / agrandir le menu', style: { color: 'inherit' }, onclick: () => { app.firstChild.classList.toggle('sidebar-reduite'); try { localStorage.setItem('gmao.sidebar', app.firstChild.classList.contains('sidebar-reduite') ? '1' : '0'); } catch (e) { /* ignore */ } } }, icone('menu'))));
    const entete = el('header', { class: 'entete' },
      el('div', { class: 'entete-titre' }),
      el('div', { class: 'entete-site' }),
      el('div', { style: { position: 'relative' } }, el('button', { class: 'btn btn-icone btn-notifs', title: 'Notifications', onclick: (ev) => { ev.stopPropagation(); basculerNotifications(); } }, icone('cloche'))),
      el('div', { style: { position: 'relative' } }, el('div', { class: 'entete-utilisateur', role: 'button', tabindex: '0', 'aria-haspopup': 'true', title: 'Mon compte',
        onclick: (ev) => { ev.stopPropagation(); basculerMenuUtilisateur(); },
        // Au clavier (Entrée, Espace) : menu ouvert sur sa première entrée
        onkeydown: (ev) => { if (ev.key !== 'Enter' && ev.key !== ' ') return; ev.preventDefault(); ev.stopPropagation(); basculerMenuUtilisateur(); const item = document.querySelector('.menu-utilisateur .menu-item'); if (item) item.focus(); } },
        ui.avatar(`${GMAO.user.prenom || ''} ${GMAO.user.nom || ''}`.trim() || GMAO.user.login),
        el('div', null, el('div', { class: 'u-nom' }, `${GMAO.user.prenom || ''} ${GMAO.user.nom || ''}`.trim() || GMAO.user.login), el('div', { class: 'u-profil' }, GMAO.perms.profilNom || '')),
        icone('chevron_bas'))));
    const layout = el('div', { class: 'layout' }, sidebar, el('div', { class: 'principal' }, entete, el('main', { class: 'contenu' })));
    try { if (localStorage.getItem('gmao.sidebar') === '1') layout.classList.add('sidebar-reduite'); } catch (e) { /* ignore */ }
    app.appendChild(layout);
    construireNavigation();
    document.addEventListener('click', fermerMenus);
    majRappelMdp();
    GMAO.rendre();
    if (GMAO._notifTimer) clearInterval(GMAO._notifTimer);
    GMAO._notifTimer = setInterval(majNotifications, 60000);
    // Écrans imposés : nouveau mot de passe, puis enrôlement de la double authentification si elle est obligatoire ;
    // crochets de connexion et notifications ensuite seulement (GMAO.refresh), aucune donnée avant
    if (GMAO.changementMdpRequis()) imposerChangementMdp();
    else if (GMAO.deuxFacteursRequis()) imposerEnrolement();
    else GMAO._apresConnexion();
  }

  /** Sélecteur de site (multi-site) : affiché dès qu'au moins un site est accessible. */
  function construireSelecteurSite() {
    const zone = document.querySelector('.entete-site');
    if (!zone) return;
    ui.vider(zone);
    const sites = (GMAO.perms && GMAO.perms.sites) || [];
    if (!sites.length) return;
    const courant = GMAO.perms.siteCourantId == null ? 'tous' : String(GMAO.perms.siteCourantId);
    const sel = el('select', { class: 'select-site', title: 'Site affiché : les listes, tableaux de bord et rapports sont filtrés sur ce site' },
      sites.length > 1 ? el('option', { value: 'tous' }, sites.length === GMAO.refs.secteurs.filter((s) => s.type === 'site').length ? 'Tous les sites' : 'Tous mes sites') : null,
      sites.map((s) => el('option', { value: String(s.id) }, s.nom + (s.mode === 'lecture' ? ' (lecture seule)' : ''))));
    sel.value = sites.length > 1 ? courant : String(sites[0].id);
    sel.addEventListener('change', async () => {
      api.setSiteCourant(sel.value);
      try { await GMAO.refresh(true); toast(sel.value === 'tous' ? 'Affichage de tous vos sites' : `Site affiché : ${sel.options[sel.selectedIndex].text}`, 'info'); } catch (e) { erreur(e); }
    });
    zone.appendChild(el('label', { class: 'inline', style: { gap: '6px' } }, icone('site'), sel));
  }
  GMAO.siteCourant = () => (GMAO.perms && GMAO.perms.siteCourantId != null ? GMAO.perms.siteCourantId : null);
  GMAO.siteLectureSeule = (secteurId) => {
    const p = GMAO.perms || {};
    return secteurId != null && Array.isArray(p.secteurIdsLecture) && p.secteurIdsLecture.includes(Number(secteurId));
  };

  function construireNavigation() {
    construireSelecteurSite();
    const logo = document.querySelector('.sidebar-logo');
    const nav = document.querySelector('.sidebar-nav');
    if (!logo || !nav) return;
    const soc = GMAO.config.societe || {};
    ui.vider(logo);
    logo.appendChild(soc.logo ? el('img', { src: soc.logo, alt: '' }) : el('div', { class: 'logo-carre' }, ui.initiales(soc.nom || 'GMAO').slice(0, 2)));
    logo.appendChild(el('div', { style: { minWidth: 0 } }, el('div', { class: 'logo-texte' }, soc.nom || 'GMAO'), el('div', { class: 'logo-sous' }, 'GMAO')));
    ui.vider(nav);
    const places = new Set();
    for (const [, g] of Object.entries(GROUPES)) {
      const mods = GMAO.modules.filter((m) => g.modules.includes(m.key) && GMAO.moduleVisible(m.key));
      mods.forEach((m) => places.add(m.key));
      if (!mods.length) continue;
      nav.appendChild(el('div', { class: 'nav-groupe' }, g.label));
      mods.forEach((m) => nav.appendChild(itemNav(m)));
    }
    const autres = GMAO.modules.filter((m) => !places.has(m.key) && GMAO.moduleVisible(m.key));
    if (autres.length) { nav.appendChild(el('div', { class: 'nav-groupe' }, 'Autres')); autres.forEach((m) => nav.appendChild(itemNav(m))); }
    for (const [k, v] of Object.entries(GMAO._badges)) GMAO.setNavBadge(k, v);
  }
  function itemNav(m) {
    const vue = GMAO.vues[m.key] || {};
    return el('a', { class: 'nav-item' + (GMAO.route.module === m.key ? ' actif' : ''), href: '#/' + m.key, dataset: { module: m.key }, title: m.description || m.label }, icone(vue.icone || m.icon || 'info'), el('span', { class: 'nav-label' }, m.label));
  }

  // ----- Menus de l'en-tête -----------------------------------------------
  /**
   * Ferme les menus de l'en-tête. Si le focus y était (entrée choisie), il revient au bouton du menu, qui le reprendra
   * aussi à la fermeture d'une fenêtre ouverte depuis le menu.
   */
  function fermerMenus() {
    document.querySelectorAll('.menu-deroulant').forEach((m) => {
      const focusDedans = m.contains(document.activeElement);
      m.remove();
      if (focusDedans && m.declencheur && m.declencheur.isConnected) m.declencheur.focus({ preventScroll: true });
    });
  }
  /** Menu de l'en-tête : Échap le ferme. */
  function menuDeroulant(classe, declencheur, ...enfants) {
    const menu = el('div', { class: 'menu-deroulant ' + classe, onclick: (ev) => ev.stopPropagation(),
      onkeydown: (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); fermerMenus(); } } }, ...enfants);
    menu.declencheur = declencheur;
    return menu;
  }
  function basculerMenuUtilisateur() {
    const existant = document.querySelector('.menu-utilisateur');
    fermerMenus();
    if (existant) return;
    const theme = document.documentElement.getAttribute('data-theme');
    const menu = menuDeroulant('menu-utilisateur', document.querySelector('.entete-utilisateur'),
      el('div', { class: 'menu-entete' }, `Connecté en tant que ${GMAO.user.login}`, el('br'), `Profil : ${GMAO.perms.profilNom || '—'} · Portée : ${(GMAO.catalogue.portees || {})[GMAO.perms.portee] || GMAO.perms.portee}`),
      el('div', { class: 'menu-sep' }),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); afficherMonCompte(); } }, icone('utilisateur'), 'Mon compte'),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.ouvrirChangementMdp(false); } }, icone('cle'), 'Changer mon mot de passe',
        GMAO.motDePasse && GMAO.motDePasse.rappel ? el('span', { class: 'texte-alerte texte-petit', style: { marginLeft: 'auto', whiteSpace: 'nowrap' }, title: `Votre mot de passe ${libelleEcheance(GMAO.motDePasse.joursRestants)}` }, GMAO.motDePasse.joursRestants <= 1 ? libelleEcheance(GMAO.motDePasse.joursRestants).replace('expire ', '') : `dans ${GMAO.motDePasse.joursRestants} j`) : null),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.ouvrirDoubleAuthentification(); } }, icone('profils'), 'Double authentification',
        el('span', { class: 'texte-2 texte-petit', style: { marginLeft: 'auto' } }, GMAO.deuxFacteurs && GMAO.deuxFacteurs.actif ? 'activée' : 'désactivée')),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.setTheme(theme === 'sombre' ? 'clair' : 'sombre'); } }, icone(theme === 'sombre' ? 'soleil' : 'lune'), theme === 'sombre' ? 'Thème clair' : 'Thème sombre'),
      typeof GMAO.ouvrirMonDossierRH === 'function' ? el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.ouvrirMonDossierRH(); } }, icone('rh'), 'Mon dossier RH') : null,
      window.gmaoBureau ? el('button', { class: 'menu-item', onclick: () => { fermerMenus(); window.gmaoBureau.verifierMisesAJour(); } }, icone('rafraichir'), 'Rechercher les mises à jour') : null,
      el('div', { class: 'menu-sep' }),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.deconnexion(); } }, icone('deconnexion'), 'Se déconnecter'));
    document.querySelector('.entete-utilisateur').parentNode.appendChild(menu);
  }

  function afficherMonCompte() {
    const u = GMAO.user;
    const p = GMAO.perms;
    const mods = GMAO.modules.filter((m) => m.actif).map((m) => {
      const droits = m.actions.filter((a) => GMAO.can(m.key, a)).map((a) => GMAO.catalogue.actions[a] || a);
      return el('tr', null, el('td', null, m.label), el('td', null, droits.length ? droits.join(', ') : el('span', { class: 'texte-2' }, 'aucun accès')));
    });
    ui.modal({ titre: 'Mon compte', taille: 'large', contenu: frag(
      ui.details([
        { label: 'Identifiant', valeur: u.login }, { label: 'Nom', valeur: `${u.prenom || ''} ${u.nom || ''}`.trim() }, { label: 'Fonction', valeur: u.fonction },
        { label: 'E-mail', valeur: u.email }, { label: 'Téléphone', valeur: u.telephone },
        { label: 'Profil', valeur: `${p.profilNom || ''} (niveau ${p.niveau})` }, { label: 'Portée des données', valeur: (GMAO.catalogue.portees || {})[p.portee] || p.portee },
        { label: 'Secteurs', valeur: (u.secteurIds || []).length ? u.secteurIds.map((s) => ui.nomSecteur(s)).join(', ') : 'Tous' },
        { label: 'Supérieur hiérarchique', valeur: u.managerId != null ? ui.nomUser(u.managerId) : '—' },
        { label: 'Dernière connexion', valeur: ui.formatDateHeure(u.derniereConnexion) },
        { label: 'Mot de passe', valeur: frag(resumeMdp(GMAO.motDePasse), ' ', el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: () => GMAO.ouvrirChangementMdp(false) }, 'Changer')) },
        { label: 'Double authentification', valeur: frag(badgeDeuxFacteurs(GMAO.deuxFacteurs), ' ', el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: () => GMAO.ouvrirDoubleAuthentification() }, 'Gérer')) },
      ], { colonnes: 2 }),
      el('h3', { class: 'mt' }, 'Mes droits'),
      el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Module'), el('th', null, 'Actions autorisées'))), el('tbody', null, mods)))
    ), boutons: [{ label: 'Fermer' }] });
  }

  // ----- Changement de mot de passe imposé -----------------------------------
  /** Changement imposé par le serveur (mot de passe initial, réinitialisé, expiré ou défini par un administrateur). */
  GMAO.changementMdpRequis = () => {
    if (!GMAO.user) return false;
    if (GMAO.motDePasse) return !!GMAO.motDePasse.doitChanger;
    return !!GMAO.user.doitChangerMdp && (GMAO.config.securite || {}).forcerChangementMdpInitial !== false;
  };
  let modaleMdpImposee = null;
  /** Fenêtre de changement imposée (une seule à la fois) ; ensuite, amorçage rechargé (droits, enrôlement éventuel). */
  function imposerChangementMdp() {
    if (modaleMdpImposee || !GMAO.user) return;
    GMAO.ouvrirChangementMdp(true, () => { GMAO.refresh(true).catch(erreur); }); // crochets de connexion et notifications rejoués
  }

  /** « aujourd'hui », « demain », « dans 5 jours ». */
  function libelleEcheance(jours) {
    if (jours == null) return '';
    return jours <= 0 ? 'expire aujourd\'hui' : jours === 1 ? 'expire demain' : `expire dans ${jours} jours`;
  }
  /** Résumé de l'état de son mot de passe (fenêtre « Mon compte »). */
  function resumeMdp(etat) {
    if (!etat) return '—';
    const parts = [etat.dateMdp ? `modifié le ${ui.formatDate(etat.dateMdp)}` : 'jamais modifié', etat.expireLe ? `expire le ${ui.formatDate(etat.expireLe)}` : 'sans expiration'];
    return el('span', { class: etat.rappel ? 'texte-alerte' : '' }, parts.join(' · '));
  }
  /**
   * Rappel discret sous l'en-tête quand l'échéance du mot de passe approche (config.securite.rappelExpirationJours),
   * masquable jusqu'à la prochaine session.
   */
  function majRappelMdp() {
    const existant = document.querySelector('.rappel-mdp');
    if (existant) existant.remove();
    const etat = GMAO.motDePasse;
    if (!GMAO.user || !etat || !etat.rappel || etat.joursRestants == null || GMAO.changementMdpRequis()) return;
    const entete = document.querySelector('.principal > .entete');
    if (!entete) return;
    const cle = 'gmao.rappelMdp.' + GMAO.user.id;
    try { if (sessionStorage.getItem(cle) === String(etat.expireLe)) return; } catch (e) { /* stockage indisponible */ }
    const bandeau = el('div', { class: 'rappel-mdp', role: 'status' },
      icone('cle'),
      el('span', null, `Votre mot de passe ${libelleEcheance(etat.joursRestants)} (le ${ui.formatDate(etat.expireLe)}).`),
      ui.bouton('Changer maintenant', { classe: 'btn-sm btn-primaire', onClic: () => GMAO.ouvrirChangementMdp(false) }),
      el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Masquer ce rappel', 'aria-label': 'Masquer ce rappel', onclick: () => {
        try { sessionStorage.setItem(cle, String(etat.expireLe)); } catch (e) { /* stockage indisponible */ }
        bandeau.remove();
      } }, icone('fermer')));
    entete.after(bandeau);
  }

  // ----- Double authentification -------------------------------------------
  const MODULES_SENSIBLES = ['systeme', 'utilisateurs', 'profils', 'configuration'];
  /** Enrôlement imposé (obligation configurée et double authentification non activée). */
  GMAO.deuxFacteursRequis = () => !!(GMAO.user && GMAO.deuxFacteurs && GMAO.deuxFacteurs.enrolementRequis);
  /** Compte concerné par l'obligation « comptes sensibles » (même règle que le serveur). */
  GMAO.compteSensible = () => GMAO.estAdmin() || MODULES_SENSIBLES.some((m) => GMAO.can(m, 'modifier'));
  /** Gestion de sa propre double authentification (activation, codes de secours, désactivation). */
  GMAO.ouvrirDoubleAuthentification = () => {
    if (GMAO.deuxFacteursRequis()) return imposerEnrolement();
    if (GMAO.deuxFacteurs && GMAO.deuxFacteurs.actif) return afficherEtatDeuxFacteurs();
    return enrolerDeuxFacteurs(false).then((active) => { if (active && GMAO.user) GMAO.refresh(false).catch(erreur); });
  };

  function badgeDeuxFacteurs(etat) {
    if (etat && etat.actif) return frag(ui.badge('Activée', '#15803d'), etat.activeLe ? el('span', { class: 'texte-2 texte-petit' }, ` depuis le ${ui.formatDate(etat.activeLe)}`) : null);
    if (etat && etat.exige) return ui.badge('Obligatoire, à activer', '#f59e0b');
    return ui.badge('Désactivée', '#6b7280');
  }

  let enrolementEnCours = false;
  function imposerEnrolement() {
    if (enrolementEnCours) return;
    enrolementEnCours = true;
    enrolerDeuxFacteurs(true).then((issue) => {
      enrolementEnCours = false;
      if (issue === 'deconnexion' || !GMAO.user) return;
      GMAO.refresh(true).catch(erreur);
    });
  }

  /** Fenêtres imposées (mot de passe initial, enrôlement) : fermées lorsque la session se termine. */
  const modalesImposees = new Set();
  function fermerModalesImposees() { modalesImposees.forEach((m) => m.fermer()); modalesImposees.clear(); modaleMdpImposee = null; }

  /** Champ de mot de passe ou de code dans un petit formulaire (Entrée = bouton principal de la modale). */
  function formulaireConfirmation(m, avecCode) {
    const f = ui.form({ colonnes: 1, entreeSoumet: true, champs: [
      { nom: 'motDePasse', label: 'Mot de passe actuel', type: 'mdp', requis: true },
      avecCode ? { nom: 'code', label: 'Code de l\'application ou code de secours', type: 'texte', requis: true, placeholder: '000000' } : null,
    ] });
    const mdp = f.controles.motDePasse.input;
    mdp.setAttribute('autocomplete', 'current-password');
    if (avecCode) {
      const c = f.controles.code.input;
      c.setAttribute('autocomplete', 'one-time-code');
      c.setAttribute('maxlength', '11');
      c.setAttribute('spellcheck', 'false');
    }
    f.el.addEventListener('submit', (ev) => { ev.preventDefault(); const b = m.pied.querySelector('.btn-primaire, .btn-danger'); if (b) b.click(); });
    return f;
  }
  /**
   * Envoi d'un formulaire de confirmation : un refus du serveur (mot de passe ou code incorrect) est affiché sous le
   * champ concerné, qui reprend le focus ; les autres erreurs remontent (message de la fenêtre).
   */
  async function envoyerConfirmation(f, url) {
    try {
      return await api.post(url, f.valeurs());
    } catch (e) {
      if (e.status !== 400) throw e;
      const champ = f.controles.code && /code/i.test(e.message) ? 'code' : 'motDePasse';
      f.erreur(champ, e.message);
      f.controles[champ].input.select();
      f.controles[champ].input.focus();
      return null;
    }
  }

  /** Liste des codes de secours avec impression, téléchargement et copie. */
  function blocCodesSecours(codes) {
    const login = GMAO.user ? GMAO.user.login : '';
    const texte = ['GMAO SICAF — codes de secours de la double authentification', `Compte : ${login}`, `Générés le ${ui.formatDateHeure(new Date())}`, '',
      ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`), '', 'Chaque code ne peut être utilisé qu\'une seule fois.', 'Conservez cette liste en lieu sûr, à l\'écart de votre téléphone.'].join('\r\n');
    const grille = el('ol', { style: { columns: '2', columnGap: '28px', fontFamily: 'Consolas, "Courier New", monospace', fontSize: '16px', margin: '10px 0', paddingLeft: '28px' } },
      codes.map((c) => el('li', { style: { margin: '4px 0', userSelect: 'all' } }, c)));
    const imprimer = () => {
      const html = `<p>Compte : <strong>${ui.esc(login)}</strong></p><p>Chaque code ne peut être utilisé qu'une seule fois, à la place du code de l'application d'authentification. Conservez cette feuille en lieu sûr, à l'écart de votre téléphone.</p>`
        + `<ol style="font-family:Consolas,'Courier New',monospace;font-size:18px;line-height:1.9">${codes.map((c) => `<li>${ui.esc(c)}</li>`).join('')}</ol>`
        + '<p><button type="button" data-imprimer>Imprimer</button></p>';
      ui.imprimer('Codes de secours — double authentification', html);
    };
    // Repli par sélection d'ui.copier sur une adresse http (poste client du réseau), comme pour le code de réinitialisation
    const copier = async () => {
      if (await ui.copier(texte)) { toast('Codes copiés dans le presse-papiers', 'succes'); return; }
      const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(grille); sel.removeAllRanges(); sel.addRange(r);
      toast('Copie automatique impossible : les codes sont sélectionnés, utilisez Ctrl+C', 'info');
    };
    return el('div', { class: 'codes-secours' },
      grille,
      el('div', { class: 'barre-outils' },
        ui.bouton('Imprimer', { icone: 'imprimer', onClic: imprimer }),
        ui.bouton('Télécharger (.txt)', { icone: 'export', onClic: () => ui.telecharger(`codes-secours-gmao-${login}.txt`, texte, 'text/plain;charset=utf-8') }),
        ui.bouton('Copier', { icone: 'copier', onClic: copier })));
  }

  /**
   * Enrôlement en trois étapes : confirmation du mot de passe, QR code (et clé à saisir manuellement)
   * avec vérification d'un premier code, puis affichage des codes de secours.
   * @param {boolean} force fenêtre impossible à fermer (double authentification obligatoire)
   * @returns {Promise<boolean|'deconnexion'>} vrai si la double authentification a été activée
   */
  function enrolerDeuxFacteurs(force) {
    return new Promise((resolve) => {
      let active = false;
      let deconnexion = false;
      const m = ui.modal({ titre: 'Activer la double authentification', fermable: !force, contenu: el('div'), onFermer: () => { modalesImposees.delete(m); resolve(deconnexion ? 'deconnexion' : active); } });
      if (force) modalesImposees.add(m);
      const corps = (...enfants) => { ui.vider(m.corps); enfants.forEach((x) => { if (x) m.corps.appendChild(x); }); };
      const quitter = force ? { label: 'Se déconnecter', icone: 'deconnexion', gauche: true, onClic: () => { deconnexion = true; setTimeout(() => GMAO.deconnexion(), 0); } } : { label: 'Annuler' };

      function etapeMotDePasse() {
        m.setTitre('Activer la double authentification');
        const f = formulaireConfirmation(m, false);
        corps(
          force ? ui.alerte('La double authentification est obligatoire pour votre compte : activez-la pour accéder à la GMAO.', 'alerte') : null,
          el('p', null, 'En plus de votre mot de passe, un code à 6 chiffres généré par une application de votre téléphone vous sera demandé à chaque connexion. Même si votre mot de passe était découvert, votre compte resterait protégé.'),
          el('ol', { class: 'texte-petit' },
            el('li', null, 'Installez sur votre téléphone une application d\'authentification : Microsoft Authenticator, Google Authenticator ou FreeOTP.'),
            el('li', null, 'Confirmez votre mot de passe ci-dessous.'),
            el('li', null, 'Scannez le QR code affiché (ou saisissez la clé), puis entrez le code proposé par l\'application.')),
          f.el);
        m.setBoutons([quitter, { label: 'Continuer', classe: 'btn-primaire', icone: 'fleche_droite', onClic: async () => {
          if (!f.valider()) return false;
          const p = await api.post('/api/auth/2fa/preparer', { motDePasse: f.valeurs().motDePasse });
          etapeQrCode(p);
          return false;
        } }]);
        setTimeout(() => f.controles.motDePasse.input.focus(), 30);
      }

      function etapeQrCode(p) {
        m.setTitre('Scannez le QR code');
        let qr = null;
        try { qr = window.QRCode ? window.QRCode.element(p.uri, { taille: 216, titre: 'QR code d\'enrôlement GMAO SICAF' }) : null; } catch (e) { qr = null; }
        const input = champCode('f_code_activation', () => { const b = m.pied.querySelector('.btn-primaire'); if (b && !b.disabled) b.click(); });
        const form = el('form', { class: 'formulaire colonnes-1', novalidate: true },
          el('div', { class: 'champ pleine-largeur' }, el('label', { for: 'f_code_activation' }, 'Code affiché par l\'application'), input));
        form.addEventListener('submit', (ev) => { ev.preventDefault(); const b = m.pied.querySelector('.btn-primaire'); if (b) b.click(); });
        corps(el('div', { class: 'grille grille-2', style: { alignItems: 'start', gap: '20px' } },
          el('div', { class: 'texte-centre' },
            qr ? el('div', { class: 'qr-enrolement', style: { display: 'inline-block', background: '#ffffff', padding: '8px', borderRadius: '8px', border: '1px solid var(--bordure)' } }, qr)
              : ui.alerte('QR code indisponible : saisissez la clé manuellement.', 'info'),
            el('div', { class: 'texte-2 texte-petit mt' }, `${p.emetteur} · ${p.compte}`)),
          el('div', null,
            el('p', { style: { marginTop: '0' } }, 'Dans l\'application, ajoutez un compte puis scannez ce QR code.'),
            el('p', { class: 'texte-petit texte-2' }, 'Impossible de scanner ? Choisissez « Saisir une clé » (compte « basé sur le temps ») et recopiez :'),
            el('div', { class: 'cle-manuelle', style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: '16px', letterSpacing: '1px', padding: '8px 10px', background: 'var(--fond)', border: '1px dashed var(--bordure-2)', borderRadius: '6px', userSelect: 'all', wordBreak: 'break-word' } }, p.cleManuelle),
            el('div', { class: 'texte-petit texte-2 mt' }, `Nom du compte : ${p.emetteur} (${p.compte}) · ${p.chiffres} chiffres · toutes les ${p.periode} secondes`),
            el('div', { class: 'mt' }, form))));
        m.setBoutons([{ label: 'Retour', icone: 'fleche_gauche', onClic: () => { etapeMotDePasse(); return false; } }, { label: 'Activer', classe: 'btn-primaire', icone: 'check', onClic: async () => {
          const code = input.value.trim();
          if (!/^\d{6}$/.test(code)) { toast('Saisissez le code à 6 chiffres affiché par l\'application', 'alerte'); input.focus(); return false; }
          try {
            const r = await api.post('/api/auth/2fa/activer', { code });
            active = true;
            etapeCodesSecours(r.codesSecours);
          } catch (e) { input.value = ''; input.focus(); throw e; }
          return false;
        } }]);
        setTimeout(() => input.focus(), 30);
      }

      function etapeCodesSecours(codes) {
        m.setTitre('Codes de secours');
        // Double authentification déjà active et codes affichés une seule fois : ni croix, ni fond, ni Échap, seulement
        // « Terminer » après la case « J'ai conservé mes codes » (fenêtre fermée en fin de session, afficherConnexion)
        m.setFermable(false);
        const cb = el('input', { type: 'checkbox', id: 'f_codes_conserves' });
        corps(
          ui.alerte('La double authentification est activée. Les autres postes connectés avec votre compte ont été déconnectés.', 'ok'),
          el('p', null, 'Si vous perdez votre téléphone, ces codes de secours vous permettront de vous connecter. Chacun ne fonctionne qu\'une seule fois. ', el('strong', null, 'Ils ne seront plus jamais affichés : imprimez-les ou enregistrez-les maintenant.')),
          blocCodesSecours(codes),
          el('label', { class: 'inline mt', for: 'f_codes_conserves' }, cb, 'J\'ai conservé mes codes de secours en lieu sûr'));
        m.setBoutons([{ label: 'Terminer', classe: 'btn-primaire', icone: 'check', onClic: () => {
          if (!cb.checked) { toast('Confirmez d\'abord que vous avez conservé vos codes de secours', 'alerte'); return false; }
          toast('Double authentification activée', 'succes');
          return true;
        } }]);
      }

      etapeMotDePasse();
    });
  }

  /** Double authentification active : état, nouveaux codes de secours, désactivation. */
  function afficherEtatDeuxFacteurs() {
    const etat = GMAO.deuxFacteurs || {};
    const restants = etat.codesSecoursRestants || 0;
    const m = ui.modal({ titre: 'Double authentification', contenu: frag(
      ui.details([
        { label: 'État', valeur: badgeDeuxFacteurs(etat) },
        { label: 'Codes de secours restants', valeur: el('span', { class: restants <= 2 ? 'texte-danger texte-gras' : '' }, String(restants)) },
        { label: 'Règle de l\'entreprise', valeur: etat.exige ? 'Obligatoire pour votre compte' : 'Facultative pour votre compte' },
      ], { colonnes: 1 }),
      restants <= 2 ? ui.alerte('Il vous reste peu de codes de secours : générez-en de nouveaux.', 'alerte') : null,
      el('p', { class: 'texte-2 texte-petit mt' }, 'Nouveau téléphone ? Désactivez puis réactivez la double authentification pour scanner un nouveau QR code. En cas de perte du téléphone et des codes de secours, contactez le pôle informatique.')),
    boutons: [
      { label: 'Désactiver', classe: 'btn-danger', gauche: true, icone: 'fermer', onClic: () => { m.fermer(); desactiverDeuxFacteurs(); } },
      { label: 'Nouveaux codes de secours', icone: 'rafraichir', onClic: () => { m.fermer(); regenererCodesSecours(); } },
      { label: 'Fermer' },
    ] });
  }

  function regenererCodesSecours() {
    const m = ui.modal({ titre: 'Nouveaux codes de secours', contenu: el('div') });
    const f = formulaireConfirmation(m, true);
    m.corps.appendChild(frag(el('p', null, 'Les codes de secours actuels deviendront inutilisables. Confirmez votre identité :'), f.el));
    m.setBoutons([{ label: 'Annuler' }, { label: 'Générer', classe: 'btn-primaire', onClic: async () => {
      if (!f.valider()) return false;
      const r = await envoyerConfirmation(f, '/api/auth/2fa/codes-secours');
      if (!r) return false;
      // Nouveaux codes affichés une seule fois : fermeture par le bouton seulement
      m.setFermable(false);
      ui.vider(m.corps);
      m.corps.appendChild(frag(ui.alerte('Nouveaux codes générés : les anciens ne fonctionnent plus. Ils ne seront plus affichés.', 'ok'), blocCodesSecours(r.codesSecours)));
      m.setBoutons([{ label: 'Fermer', classe: 'btn-primaire' }]);
      GMAO.refresh(false).catch(() => {});
      return false;
    } }]);
  }

  function desactiverDeuxFacteurs() {
    const etat = GMAO.deuxFacteurs || {};
    const m = ui.modal({ titre: 'Désactiver la double authentification', contenu: el('div') });
    const f = formulaireConfirmation(m, true);
    m.corps.appendChild(frag(
      etat.exige ? ui.alerte('La double authentification est obligatoire pour votre compte : vous devrez la réactiver immédiatement (par exemple avec votre nouveau téléphone).', 'alerte') : ui.alerte('Votre compte ne sera plus protégé que par votre mot de passe.', 'alerte'),
      f.el));
    m.setBoutons([{ label: 'Annuler' }, { label: 'Désactiver', classe: 'btn-danger', onClic: async () => {
      if (!f.valider()) return false;
      if (!(await envoyerConfirmation(f, '/api/auth/2fa/desactiver'))) return false;
      toast('Double authentification désactivée', 'succes');
      await GMAO.refresh(false); // impose aussitôt un nouvel enrôlement si elle est obligatoire
      return true;
    } }]);
  }

  // ----- Notifications ----------------------------------------------------
  let notifs = { nonLues: 0, notifications: [] };
  async function majNotifications() {
    if (!GMAO.user || GMAO.ecranImpose()) return; // aucune donnée avant le changement de mot de passe ou l'enrôlement imposé
    try {
      notifs = await api.get('/api/notifications', null, { silent401: true });
      const btn = document.querySelector('.btn-notifs');
      if (!btn) return;
      let c = btn.querySelector('.notif-compteur');
      if (notifs.nonLues) { if (!c) { c = el('span', { class: 'notif-compteur' }); btn.appendChild(c); } c.textContent = String(notifs.nonLues); } else if (c) c.remove();
    } catch (e) {
      // Double authentification rendue obligatoire pendant la session : enrôlement imposé
      if (e && e.details && e.details.deuxFacteursRequis && !GMAO.deuxFacteursRequis()) GMAO.refresh(true).catch(() => {});
    }
  }
  function basculerNotifications() {
    const existant = document.querySelector('.notif-panneau');
    fermerMenus();
    if (existant) return;
    const liste = el('div');
    if (!notifs.notifications.length) liste.appendChild(el('div', { class: 'menu-entete' }, 'Aucune notification'));
    for (const n of notifs.notifications) {
      liste.appendChild(el('div', { class: 'notif-item' + (n.lu ? '' : ' non-lue'), onclick: async () => {
        try { await api.post('/api/notifications/lues', { ids: [n.id] }); } catch (e) { /* ignore */ }
        fermerMenus(); majNotifications();
        // Lien d'action « #/mon-dossier-rh » : dossier RH personnel (fenêtre de la vue RH), sinon navigation
        if (n.lien === '#/mon-dossier-rh' && typeof GMAO.ouvrirMonDossierRH === 'function') GMAO.ouvrirMonDossierRH();
        else if (n.lien) GMAO.navigate(n.lien);
      } }, el('div', { class: 'notif-titre' }, n.titre), el('div', { class: 'notif-message' }, n.message), el('div', { class: 'notif-date' }, ui.relatif(n.date))));
    }
    const menu = menuDeroulant('notif-panneau', document.querySelector('.btn-notifs'),
      el('div', { class: 'menu-entete', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, el('strong', null, 'Notifications'), notifs.nonLues ? el('button', { class: 'btn btn-lien btn-sm', onclick: async () => { await api.post('/api/notifications/lues', {}); fermerMenus(); majNotifications(); } }, 'Tout marquer lu') : null),
      liste);
    document.querySelector('.btn-notifs').parentNode.appendChild(menu);
  }
  GMAO.majNotifications = majNotifications;

  // ----- Démarrage --------------------------------------------------------
  window.addEventListener('hashchange', () => { if (GMAO.user) GMAO.rendre(); });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (GMAO.user) appliquerTheme(); });

  (async function boot() {
    try {
      await chargerVues();
      const data = await api.get('/api/auth/me', null, { silent401: true });
      await demarrer(data);
    } catch (e) {
      if (e && e.status === 401) await afficherConnexion();
      else {
        const app = document.getElementById('app');
        ui.vider(app);
        app.appendChild(el('div', { class: 'chargement-initial' }, icone('alerte'), el('p', null, 'Impossible de contacter le serveur de la GMAO. ' + (e.message || '')), el('button', { class: 'btn btn-primaire', onclick: () => location.reload() }, 'Réessayer')));
      }
    }
  })();
})();
