/**
 * Vue Journal d'audit : traçabilité des actions (filtres, recherche, export CSV).
 */
(function () {
  'use strict';
  const { el, erreur } = ui;

  // Libellés de repli ; les libellés complets (toutes les actions, tous les modules) sont fournis par le serveur
  // (GET /api/audit → libellesActions, libellesEntites)
  const LIBELLES_ACTION = { connexion: 'Connexion', creation: 'Création', modification: 'Modification', suppression: 'Suppression', desactivation: 'Désactivation', validation: 'Validation', refus: 'Refus', cloture: 'Clôture', statut: 'Changement de statut', conversion: 'Conversion en OT', echec_connexion: 'Échec de connexion', reinitialisation: 'Réinitialisation' };
  const LIBELLES_ENTITE = { users: 'Utilisateurs', profils: 'Profils', secteurs: 'Secteurs & sites', configuration: 'Configuration', equipements: 'Équipements', demandes: 'Demandes', ot: 'Ordres de travail' };

  GMAO.registerView('audit', {
    titre: 'Journal d\'activité', icone: 'audit',
    async rendu(container, { query }) {
      const libellesActions = Object.assign({}, LIBELLES_ACTION);
      const libellesEntites = Object.assign({}, LIBELLES_ENTITE);
      const filtres = { entite: (query && query.entite) || '', action: (query && query.action) || '', userId: '', du: '', au: '', recherche: '' };
      const selEntite = el('select', { onchange: () => { filtres.entite = selEntite.value; charger(); } });
      const selAction = el('select', { onchange: () => { filtres.action = selAction.value; charger(); } });
      const selUser = el('select', { onchange: () => { filtres.userId = selUser.value; charger(); } }, [{ value: '', label: 'Tous les utilisateurs' }].concat(ui.optionsUsers({ vide: false, inactifs: true })).map((o) => el('option', { value: o.value }, o.label)));
      const du = el('input', { type: 'date', onchange: () => { filtres.du = du.value; charger(); } });
      const au = el('input', { type: 'date', onchange: () => { filtres.au = au.value; charger(); } });
      const recherche = el('input', { type: 'search', placeholder: 'Rechercher…' });
      recherche.addEventListener('input', ui.debounce(() => { filtres.recherche = recherche.value; charger(); }, 300));
      const compteur = el('span', { class: 'texte-2' });

      const tableau = ui.table({
        colonnes: [
          { cle: 'date', label: 'Date', type: 'datetime', largeur: '150px' },
          { cle: 'userNom', label: 'Utilisateur' },
          { cle: 'action', label: 'Action', rendu: (r) => ui.badge(libellesActions[r.action] || r.action) },
          { cle: 'entite', label: 'Élément', rendu: (r) => libellesEntites[r.entite] || r.entite },
          { cle: 'entiteId', label: 'Réf.', aligner: 'centre' },
          { cle: 'details', label: 'Détails', rendu: (r) => el('span', { class: 'texte-petit', style: { wordBreak: 'break-word' } }, r.details) },
          { cle: 'ip', label: 'IP', classe: 'texte-2 texte-petit' },
        ],
        lignes: [], recherche: false, triInitial: { cle: 'date', sens: 'desc' },
      });

      async function charger() {
        try {
          const r = await api.get('/api/audit', { entite: filtres.entite, action: filtres.action, userId: filtres.userId, du: filtres.du, au: filtres.au, recherche: filtres.recherche, limite: 1000 });
          Object.assign(libellesActions, r.libellesActions || {});
          Object.assign(libellesEntites, r.libellesEntites || {});
          tableau.maj(r.lignes);
          compteur.textContent = `${r.total} entrée(s)${r.total > r.lignes.length ? ` (${r.lignes.length} affichées)` : ''}`;
          const remplir = (sel, valeurs, libelles, vide) => { const cur = sel.value || (sel === selEntite ? filtres.entite : sel === selAction ? filtres.action : ''); ui.vider(sel); sel.appendChild(el('option', { value: '' }, vide)); valeurs.slice().sort((a, b) => String(libelles[a] || a).localeCompare(String(libelles[b] || b), 'fr')).forEach((v) => sel.appendChild(el('option', { value: v }, libelles[v] || v))); sel.value = cur; };
          remplir(selEntite, r.entites, libellesEntites, 'Tous les éléments');
          remplir(selAction, r.actions, libellesActions, 'Toutes les actions');
        } catch (e) { erreur(e); }
      }

      container.appendChild(ui.pageEntete({
        titre: GMAO.moduleLabel('audit'), icone: 'audit', sousTitre: 'Journal de toutes les actions. Les rôles responsables sont notifiés des événements importants (Configuration › Journal & notifications).',
        actions: [
          ui.bouton('Actualiser', { icone: 'rafraichir', onClic: charger }),
          GMAO.can('audit', 'exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => { const qs = new URLSearchParams(Object.entries(filtres).filter(([, v]) => v)).toString(); api.telecharger('/api/audit/export' + (qs ? '?' + qs : ''), 'journal-audit.csv').catch(erreur); } }) : null,
        ],
      }));
      container.appendChild(el('div', { class: 'barre-outils' }, selEntite, selAction, selUser, el('label', { class: 'inline' }, 'Du', du), el('label', { class: 'inline' }, 'au', au), recherche, el('span', { class: 'espace' }), compteur));
      container.appendChild(tableau.el);
      await charger();
    },
  });
})();
