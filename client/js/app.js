/**
 * Noyau de l'application cliente : amorçage, connexion, navigation, droits, thème.
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
    exploitation: { label: 'Exploitation', modules: ['dashboard', 'equipements', 'demandes', 'ot', 'preventif', 'planning', 'stock', 'fournisseurs', 'rapports'] },
    administration: { label: 'Administration', modules: ['utilisateurs', 'profils', 'configuration', 'audit'] },
  };

  const GMAO = window.GMAO = {
    user: null, perms: null, config: {}, modules: [], refs: { users: [], secteurs: [], profils: [] }, catalogue: { modules: [], actions: {}, portees: {} }, version: '',
    vues: {}, route: { module: null, params: [], query: {} },
    _badges: {}, _vueCourante: null,

    registerView(cle, def) { this.vues[cle] = Object.assign({ cle }, def); },

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
      const data = await api.get('/api/auth/me', null, { silent401: true });
      appliquerBootstrap(data);
      construireNavigation();
      appliquerTheme();
      if (rerendre) this.rendre();
    },
    async refreshRefs() { return this.refresh(false); },

    onNonAuthentifie() {
      if (GMAO.user) { GMAO.user = null; toast('Session expirée, veuillez vous reconnecter', 'alerte'); afficherConnexion(); }
    },

    async deconnexion() {
      try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ }
      GMAO.user = null; GMAO.perms = null;
      location.hash = '';
      afficherConnexion();
    },

    ouvrirChangementMdp(force) {
      const f = ui.form({ colonnes: 1, champs: [
        force ? null : { nom: 'ancien', label: 'Mot de passe actuel', type: 'mdp', requis: true },
        { nom: 'nouveau', label: 'Nouveau mot de passe', type: 'mdp', requis: true, aide: `Au moins ${((GMAO.config.securite || {}).longueurMinMdp) || 4} caractères` },
        { nom: 'confirmation', label: 'Confirmer le nouveau mot de passe', type: 'mdp', requis: true, valider: (v, vals) => (v !== vals.nouveau ? 'Les mots de passe ne correspondent pas' : '') },
      ] });
      const m = ui.modal({
        titre: force ? 'Définissez votre mot de passe' : 'Changer mon mot de passe', taille: 'petite', fermable: !force,
        contenu: frag(force ? ui.alerte('Pour sécuriser votre compte, vous devez choisir un nouveau mot de passe avant de continuer.', 'info') : null, f.el),
        boutons: [force ? null : { label: 'Annuler' }, { label: 'Enregistrer', classe: 'btn-primaire', onClic: async () => {
          if (!f.valider()) return false;
          const v = f.valeurs();
          await api.post('/api/auth/mot-de-passe', { ancien: v.ancien, nouveau: v.nouveau });
          GMAO.user.doitChangerMdp = false;
          toast('Mot de passe modifié', 'succes');
        } }],
      });
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
      ui.fermerModales();
      ui.vider(contenu);
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
      try {
        const r = vue.rendu(conteneur, { params: GMAO.route.params, query });
        if (r && typeof r.then === 'function') {
          conteneur.appendChild(ui.chargement());
          r.then((n) => { if (GMAO._vueCourante !== module || !conteneur.isConnected) return; const ch = conteneur.querySelector(':scope > .chargement'); if (ch) ch.remove(); if (n instanceof Node) conteneur.appendChild(n); })
            .catch((e) => { const ch = conteneur.querySelector(':scope > .chargement'); if (ch) ch.remove(); conteneur.appendChild(ui.alerte('Erreur : ' + (e.message || e), 'danger')); console.error(e); });
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
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 99, 235];
  }
  function assombrir(hex, f) { const [r, g, b] = hexToRgb(hex).map((c) => Math.max(0, Math.round(c * (1 - f)))); return `rgb(${r},${g},${b})`; }

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
  }

  async function chargerVues() {
    const fichiers = await api.get('/api/views');
    await Promise.all(fichiers.map((src) => new Promise((resolve) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = el('script', { src, onload: resolve, onerror: () => { console.error('Vue non chargée', src); resolve(); } });
      document.head.appendChild(s);
    })));
  }

  // ----- Page de connexion -----------------------------------------------
  async function afficherConnexion() {
    const app = document.getElementById('app');
    let infos = { societe: {}, general: {} };
    try { infos = await api.get('/api/auth/infos'); } catch (e) { /* serveur injoignable */ }
    GMAO.config = { societe: infos.societe, general: infos.general };
    appliquerTheme();
    ui.vider(app);
    const err = el('div', { class: 'connexion-erreur masque' });
    const f = ui.form({ colonnes: 1, champs: [
      { nom: 'login', label: 'Identifiant', type: 'texte', requis: true, placeholder: 'ex. admin' },
      { nom: 'password', label: 'Mot de passe', type: 'mdp', requis: true },
    ] });
    const btn = el('button', { class: 'btn btn-primaire', type: 'submit' }, 'Se connecter');
    f.el.appendChild(el('div', { class: 'champ pleine-largeur' }, btn));
    f.el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!f.valider()) return;
      btn.disabled = true; err.classList.add('masque');
      try {
        const data = await api.post('/api/auth/login', f.valeurs(), { silent401: true });
        await demarrer(data);
      } catch (e) {
        err.textContent = e.message; err.classList.remove('masque');
      } finally { btn.disabled = false; }
    });
    const soc = infos.societe || {};
    app.appendChild(el('div', { class: 'connexion' }, el('div', { class: 'connexion-carte' },
      el('div', { class: 'connexion-logo' }, soc.logo ? el('img', { src: soc.logo, alt: soc.nom }) : el('div', { class: 'connexion-titre' }, soc.nom || 'GMAO'), el('div', { class: 'connexion-sous-titre' }, soc.slogan || 'Gestion de Maintenance Assistée par Ordinateur')),
      (infos.general || {}).messageAccueil ? el('div', { class: 'connexion-accueil' }, infos.general.messageAccueil) : null,
      err, f.el,
      el('div', { class: 'connexion-pied' }, `GMAO ${infos.version ? 'v' + infos.version : ''} · Compte initial : admin / admin`))));
    setTimeout(() => { const i = f.el.querySelector('input'); if (i) i.focus(); }, 50);
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
      el('div', { style: { position: 'relative' } }, el('button', { class: 'btn btn-icone btn-notifs', title: 'Notifications', onclick: (ev) => { ev.stopPropagation(); basculerNotifications(); } }, icone('cloche'))),
      el('div', { style: { position: 'relative' } }, el('div', { class: 'entete-utilisateur', onclick: (ev) => { ev.stopPropagation(); basculerMenuUtilisateur(); } },
        ui.avatar(`${GMAO.user.prenom || ''} ${GMAO.user.nom || ''}`.trim() || GMAO.user.login),
        el('div', null, el('div', { class: 'u-nom' }, `${GMAO.user.prenom || ''} ${GMAO.user.nom || ''}`.trim() || GMAO.user.login), el('div', { class: 'u-profil' }, GMAO.perms.profilNom || '')),
        icone('chevron_bas'))));
    const layout = el('div', { class: 'layout' }, sidebar, el('div', { class: 'principal' }, entete, el('main', { class: 'contenu' })));
    try { if (localStorage.getItem('gmao.sidebar') === '1') layout.classList.add('sidebar-reduite'); } catch (e) { /* ignore */ }
    app.appendChild(layout);
    construireNavigation();
    document.addEventListener('click', fermerMenus);
    GMAO.rendre();
    if (GMAO.user.doitChangerMdp && (GMAO.config.securite || {}).forcerChangementMdpInitial !== false) GMAO.ouvrirChangementMdp(true);
    majNotifications();
    if (GMAO._notifTimer) clearInterval(GMAO._notifTimer);
    GMAO._notifTimer = setInterval(majNotifications, 60000);
  }

  function construireNavigation() {
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
  function fermerMenus() { document.querySelectorAll('.menu-deroulant').forEach((m) => m.remove()); }
  function basculerMenuUtilisateur() {
    const existant = document.querySelector('.menu-utilisateur');
    fermerMenus();
    if (existant) return;
    const theme = document.documentElement.getAttribute('data-theme');
    const menu = el('div', { class: 'menu-deroulant menu-utilisateur', onclick: (ev) => ev.stopPropagation() },
      el('div', { class: 'menu-entete' }, `Connecté en tant que ${GMAO.user.login}`, el('br'), `Profil : ${GMAO.perms.profilNom || '—'} · Portée : ${(GMAO.catalogue.portees || {})[GMAO.perms.portee] || GMAO.perms.portee}`),
      el('div', { class: 'menu-sep' }),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); afficherMonCompte(); } }, icone('utilisateur'), 'Mon compte'),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.ouvrirChangementMdp(false); } }, icone('cle'), 'Changer mon mot de passe'),
      el('button', { class: 'menu-item', onclick: () => { fermerMenus(); GMAO.setTheme(theme === 'sombre' ? 'clair' : 'sombre'); } }, icone(theme === 'sombre' ? 'soleil' : 'lune'), theme === 'sombre' ? 'Thème clair' : 'Thème sombre'),
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
      ], { colonnes: 2 }),
      el('h3', { class: 'mt' }, 'Mes droits'),
      el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Module'), el('th', null, 'Actions autorisées'))), el('tbody', null, mods)))
    ), boutons: [{ label: 'Fermer' }] });
  }

  // ----- Notifications ----------------------------------------------------
  let notifs = { nonLues: 0, notifications: [] };
  async function majNotifications() {
    if (!GMAO.user) return;
    try {
      notifs = await api.get('/api/notifications', null, { silent401: true });
      const btn = document.querySelector('.btn-notifs');
      if (!btn) return;
      let c = btn.querySelector('.notif-compteur');
      if (notifs.nonLues) { if (!c) { c = el('span', { class: 'notif-compteur' }); btn.appendChild(c); } c.textContent = String(notifs.nonLues); } else if (c) c.remove();
    } catch (e) { /* silencieux */ }
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
        if (n.lien) GMAO.navigate(n.lien);
      } }, el('div', { class: 'notif-titre' }, n.titre), el('div', { class: 'notif-message' }, n.message), el('div', { class: 'notif-date' }, ui.relatif(n.date))));
    }
    const menu = el('div', { class: 'menu-deroulant notif-panneau', onclick: (ev) => ev.stopPropagation() },
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
