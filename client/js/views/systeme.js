/**
 * Vue Système & informatique (réservée au pôle informatique, droits « systeme ») :
 * base de données et sauvegardes (locales et multi-destinations), réseau et postes connectés,
 * informations du serveur, application de bureau (version, mises à jour).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const peutModifier = () => GMAO.can('systeme', 'modifier');

  // ----- Onglet Sauvegardes -------------------------------------------------
  function ongletSauvegardes(cont) {
    async function rendre() {
      ui.vider(cont);
      let infos = { sauvegardes: [], dossier: '' };
      try { infos = await api.get('/api/sauvegardes'); } catch (e) { erreur(e); }
      const tableau = ui.table({ colonnes: [{ cle: 'nom', label: 'Fichier' }, { cle: 'date', label: 'Date', type: 'datetime' }, { cle: 'taille', label: 'Taille', rendu: (s) => ui.formatNombre(s.taille / 1024, 0) + ' Ko', aligner: 'droite' }], lignes: infos.sauvegardes, recherche: false, pagination: false, vide: 'Aucune sauvegarde (une sauvegarde quotidienne est créée automatiquement au démarrage)',
        actions: [{ icone: 'rafraichir', titre: 'Restaurer cette sauvegarde', visible: () => peutModifier(), onClic: async (s) => {
          if (!(await ui.confirm({ titre: 'Restaurer', message: `Remplacer toutes les données actuelles par la sauvegarde « ${s.nom} » ? Une copie de l'état actuel sera faite avant.`, okLabel: 'Restaurer', danger: true }))) return;
          try { await api.post('/api/sauvegardes/restaurer', { nom: s.nom }); toast('Sauvegarde restaurée', 'succes'); await GMAO.refresh(false); rendre(); } catch (e) { erreur(e); }
        } }] });
      const inputImport = el('input', { type: 'file', accept: '.json,application/json', class: 'masque' });
      inputImport.addEventListener('change', async () => {
        const f = inputImport.files && inputImport.files[0]; if (!f) return;
        try {
          const txt = await ui.lireFichier(f, true);
          const data = JSON.parse(txt);
          if (!(await ui.confirm({ titre: 'Importer', message: 'Remplacer TOUTES les données actuelles par le contenu de ce fichier ? Une sauvegarde sera faite avant. Vous devrez vous reconnecter.', okLabel: 'Importer', danger: true }))) return;
          await api.post('/api/import', data);
          toast('Import terminé, reconnectez-vous', 'succes');
          setTimeout(() => location.reload(), 800);
        } catch (e) { erreur(e); } finally { inputImport.value = ''; }
      });
      cont.appendChild(ui.carte('Sauvegardes', frag(
        el('p', { class: 'texte-2 texte-petit' }, `Dossier : ${infos.dossier || '—'}. Copiez ce dossier sur un autre support pour une sauvegarde externe.`),
        el('div', { class: 'barre-outils' },
          peutModifier() ? ui.bouton('Créer une sauvegarde maintenant', { icone: 'sauvegarde', classe: 'btn-primaire', onClic: async () => { try { await api.post('/api/sauvegardes'); toast('Sauvegarde créée', 'succes'); rendre(); } catch (e) { erreur(e); } } }) : null,
          peutModifier() ? ui.bouton('Exporter toutes les données (JSON)', { icone: 'export', onClic: () => api.telecharger('/api/export').catch(erreur) }) : null,
          peutModifier() ? ui.bouton('Importer un fichier d\'export', { icone: 'import', onClic: () => inputImport.click() }) : null, inputImport),
        tableau.el)));
      // Sauvegardes avancées (destinations multiples, autres sites) fournies par client/js/lib/sauvegardes-ui.js
      if (typeof GMAO.rendreSauvegardesAvancees === 'function') {
        const zone = el('div');
        cont.appendChild(zone);
        try { GMAO.rendreSauvegardesAvancees(zone); } catch (e) { zone.appendChild(ui.alerte('Sauvegardes avancées indisponibles : ' + e.message, 'danger')); }
      }
      cont.appendChild(ui.carte('Données de démonstration', frag(
        el('p', { class: 'texte-2 texte-petit' }, 'Ajoute des utilisateurs (mot de passe « demo »), secteurs, équipements, interventions, articles et fournisseurs d\'exemple pour découvrir l\'application. Les données existantes sont conservées.'),
        peutModifier() ? ui.bouton('Charger les données de démonstration', { icone: 'lecture', onClic: async () => {
          if (!(await ui.confirm({ titre: 'Données de démonstration', message: 'Charger les données d\'exemple dans la base actuelle ?', okLabel: 'Charger' }))) return;
          try { const r = await api.post('/api/demo'); await GMAO.refresh(false); ui.modal({ titre: 'Données de démonstration', taille: 'petite', contenu: el('ul', null, r.map((x) => el('li', null, `${x.module} : ${x.ok ? (x.details || 'ok') : 'erreur — ' + x.erreur}`))), boutons: [{ label: 'Fermer' }] }); } catch (e) { erreur(e); }
        } }) : null)));
    }
    rendre();
  }

  // ----- Onglet Système -----------------------------------------------------
  function ongletSysteme(cont) {
    cont.appendChild(ui.chargement());
    api.get('/api/systeme').then((s) => {
      ui.vider(cont);
      cont.appendChild(ui.carte('Informations système', ui.details([
        { label: 'Version GMAO', valeur: s.version }, { label: 'Node.js', valeur: s.node }, { label: 'Plateforme', valeur: s.plateforme },
        { label: 'Dossier des données', valeur: el('code', null, s.dossierDonnees) }, { label: 'Fichier de données', valeur: el('code', null, s.fichierDonnees) }, { label: 'Taille', valeur: ui.formatNombre(s.taille / 1024, 0) + ' Ko' },
        { label: 'Démarré le', valeur: ui.formatDateHeure(s.demarrage) }, { label: 'Modules serveur', valeur: (s.modulesServeur || []).join(', ') },
      ], { colonnes: 2 })));
      cont.appendChild(ui.carte('Contenu de la base', el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Collection'), el('th', { class: 'num' }, 'Éléments'))), el('tbody', null, s.collections.map((c) => el('tr', null, el('td', null, c.nom), el('td', { class: 'num' }, String(c.nombre)))))))));
    }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'danger')); });
  }


  // ----- Onglet Réseau & postes ---------------------------------------------
  function ongletReseau(cont) {
    async function rendre() {
      ui.vider(cont);
      let r;
      try { r = await api.get('/api/systeme/reseau'); } catch (e) { cont.appendChild(ui.alerte(e.message, 'danger')); return; }
      const adresses = (r.adresses || []).map((a) => `http://${a.adresse}:${r.port || 8585}/`);
      const inter = el('div', { class: 'interrupteur' + (r.accesNavigateur ? ' actif' : ''), role: 'switch', tabindex: 0, title: peutModifier() ? '' : 'Droit Système › Modifier requis' });
      const bascule = async () => {
        if (!peutModifier()) return;
        const nouveau = !inter.classList.contains('actif');
        if (nouveau && !(await ui.confirm({ titre: 'Accès par navigateur', message: 'Autoriser l\'ouverture de la GMAO depuis un navigateur web (Edge, Chrome…) en plus de l\'application GMAO SICAF ?', okLabel: 'Autoriser' }))) return;
        try { await api.put('/api/systeme/reseau', { accesNavigateur: nouveau }); toast(nouveau ? 'Accès par navigateur autorisé' : 'Accès par navigateur désactivé', 'succes'); rendre(); } catch (e) { erreur(e); }
      };
      inter.addEventListener('click', bascule);
      inter.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); bascule(); } });
      cont.appendChild(ui.carte('Accès au serveur GMAO', frag(
        ui.details([
          { label: 'Poste serveur', valeur: r.nomPoste },
          { label: 'Adresse(s) pour les autres postes', valeur: adresses.length ? el('div', null, adresses.map((a) => el('div', null, el('code', null, a)))) : '—' },
          { label: 'Mode', valeur: r.applicationBureau ? 'Application de bureau GMAO SICAF (serveur intégré)' : 'Serveur Node.js autonome (développement)' },
        ], { colonnes: 1 }),
        el('p', { class: 'texte-2 texte-petit mt' }, 'Sur chaque poste, installez l\'application GMAO SICAF et choisissez « Se connecter à la GMAO d\'un autre poste » avec l\'une des adresses ci-dessus. Les paramètres de connexion des postes sont protégés par le code du pôle informatique.'),
        el('div', { class: 'inline mt' }, inter, el('span', null, 'Autoriser l\'accès depuis un navigateur web'), r.applicationBureau ? null : el('span', { class: 'texte-2 texte-petit' }, ' (sans effet en mode développement : le navigateur est toujours autorisé)')),
      )));
      const tableau = ui.table({
        colonnes: [
          { cle: 'nom', label: 'Utilisateur', rendu: (s) => el('div', null, el('div', { class: 'cellule-principale' }, s.nom, s.courante ? frag(' ', ui.badge('vous', '#2563eb')) : null), el('div', { class: 'cellule-secondaire' }, s.login)) },
          { cle: 'poste', label: 'Poste', rendu: (s) => ui.badge(s.poste, s.poste === 'Application GMAO' ? '#16a34a' : '#f59e0b') },
          { cle: 'ip', label: 'Adresse IP' },
          { cle: 'connexion', label: 'Connecté depuis', type: 'datetime' },
          { cle: 'derniereActivite', label: 'Dernière activité', rendu: (s) => ui.relatif(s.derniereActivite), valeurTri: (s) => s.derniereActivite },
        ],
        lignes: r.sessions, recherche: false, pagination: false, vide: 'Aucune session ouverte',
        actions: [{ icone: 'deconnexion', titre: 'Fermer la session', classe: 'texte-danger', visible: (s) => peutModifier() && !s.courante, onClic: async (s) => {
          if (!(await ui.confirm({ titre: 'Fermer la session', message: `Déconnecter ${s.nom} (${s.ip || 'poste inconnu'}) ?`, okLabel: 'Déconnecter', danger: true }))) return;
          try { await api.del('/api/systeme/sessions/' + s.id); toast('Session fermée', 'succes'); rendre(); } catch (e) { erreur(e); }
        } }],
      });
      cont.appendChild(ui.carte(`Postes connectés (${r.sessions.length})`, tableau.el, { actions: [ui.bouton('Actualiser', { icone: 'rafraichir', classe: 'btn-sm', onClic: rendre })] }));
    }
    rendre();
  }

  // ----- Onglet Application de bureau ---------------------------------------
  function ongletApplication(cont) {
    const B = window.gmaoBureau;
    if (!B) {
      cont.appendChild(ui.alerte('Vous utilisez la GMAO hors de l\'application de bureau. Installez « GMAO SICAF » (GMAO-SICAF-Setup.exe) sur chaque poste : aucun prérequis (Node.js est intégré), aucune fenêtre de commandes, mises à jour automatiques.', 'info'));
      return;
    }
    cont.appendChild(ui.chargement());
    B.infos().then((i) => {
      ui.vider(cont);
      cont.appendChild(ui.carte('Application GMAO SICAF sur ce poste', frag(
        ui.details([
          { label: 'Version', valeur: i.version + (i.portable ? ' (version portable)' : '') },
          { label: 'Mode', valeur: i.mode === 'client' ? 'Connecté au serveur d\'un autre poste' : 'Ce poste héberge la GMAO' },
          { label: 'Accès', valeur: i.acces },
          i.mode === 'serveur' ? { label: 'Dossier des données', valeur: el('code', null, i.dossierDonnees) } : null,
        ], { colonnes: 1 }),
        el('div', { class: 'barre-outils mt' },
          ui.bouton('Rechercher les mises à jour', { icone: 'rafraichir', onClic: () => B.verifierMisesAJour() }),
          ui.bouton('Paramètres de connexion du poste…', { icone: 'cle', onClic: () => B.ouvrirParametres() })),
        el('p', { class: 'texte-2 texte-petit' }, 'Les paramètres de connexion (mode serveur ou client, partage réseau, port, dossier des données, source des mises à jour) sont protégés par le code du pôle informatique.'),
      )));
    }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'danger')); });
  }

  GMAO.registerView('systeme', {
    titre: 'Système & informatique', icone: 'serveur',
    async rendu(container) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel('systeme'), icone: 'serveur', sousTitre: 'Base de données, sauvegardes, réseau, postes connectés et mises à jour — réservé au pôle informatique.' }));
      if (!peutModifier()) container.appendChild(ui.alerte('Consultation seule : les modifications sont réservées au pôle informatique.', 'info'));
      container.appendChild(ui.onglets([
        { cle: 'donnees', label: 'Base de données & sauvegardes', icone: 'sauvegarde', rendu: (c) => { ongletSauvegardes(c); } },
        { cle: 'reseau', label: 'Réseau & postes', icone: 'site', rendu: (c) => { ongletReseau(c); } },
        { cle: 'application', label: 'Application & mises à jour', icone: 'rafraichir', rendu: (c) => { ongletApplication(c); } },
        { cle: 'infos', label: 'Informations système', icone: 'info', rendu: (c) => { ongletSysteme(c); } },
      ], { hash: true }).el);
    },
  });
})();
