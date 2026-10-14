/**
 * Vue Journal d'audit : traçabilité des actions (filtres, recherche, export CSV).
 */
(function () {
  'use strict';
  const { el, erreur } = ui;

  const LIBELLES_ACTION = { connexion: 'Connexion', creation: 'Création', modification: 'Modification', suppression: 'Suppression', desactivation: 'Désactivation', changement_mdp: 'Changement de mot de passe', reinitialisation_mdp: 'Réinitialisation de mot de passe', duplication: 'Duplication', sauvegarde: 'Sauvegarde', restauration: 'Restauration', import: 'Import', demo: 'Données de démonstration', reinitialisation: 'Réinitialisation', validation: 'Validation', refus: 'Refus', cloture: 'Clôture', affectation: 'Affectation', statut: 'Changement de statut', mouvement: 'Mouvement de stock', generation: 'Génération', compteur: 'Relevé de compteur', document: 'Document', export: 'Export', etat: 'Changement d\'état', commentaire: 'Commentaire', convertir: 'Conversion', reouverture: 'Réouverture', temps: 'Temps passé', pieces: 'Pièces' };
  const LIBELLES_ENTITE = { users: 'Utilisateurs', profils: 'Profils', secteurs: 'Secteurs', configuration: 'Configuration', equipements: 'Équipements', demandes: 'Demandes', ot: 'Ordres de travail', plansPreventifs: 'Plans préventifs', articles: 'Articles', mouvementsStock: 'Mouvements de stock', fournisseurs: 'Fournisseurs' };

  GMAO.registerView('audit', {
    titre: 'Journal d\'audit', icone: 'audit',
    async rendu(container) {
      const filtres = { entite: '', action: '', userId: '', du: '', au: '', recherche: '' };
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
          { cle: 'action', label: 'Action', rendu: (r) => ui.badge(LIBELLES_ACTION[r.action] || r.action) },
          { cle: 'entite', label: 'Entité', rendu: (r) => LIBELLES_ENTITE[r.entite] || r.entite },
          { cle: 'entiteId', label: 'Réf.', aligner: 'centre' },
          { cle: 'details', label: 'Détails', rendu: (r) => el('span', { class: 'texte-petit', style: { wordBreak: 'break-word' } }, r.details) },
          { cle: 'ip', label: 'IP', classe: 'texte-2 texte-petit' },
        ],
        lignes: [], recherche: false, triInitial: { cle: 'date', sens: 'desc' },
      });

      async function charger() {
        try {
          const r = await api.get('/api/audit', { entite: filtres.entite, action: filtres.action, userId: filtres.userId, du: filtres.du, au: filtres.au, recherche: filtres.recherche, limite: 1000 });
          tableau.maj(r.lignes);
          compteur.textContent = `${r.total} entrée(s)${r.total > r.lignes.length ? ` (${r.lignes.length} affichées)` : ''}`;
          const remplir = (sel, valeurs, libelles, vide) => { const cur = sel.value; ui.vider(sel); sel.appendChild(el('option', { value: '' }, vide)); valeurs.forEach((v) => sel.appendChild(el('option', { value: v }, libelles[v] || v))); sel.value = cur; };
          remplir(selEntite, r.entites, LIBELLES_ENTITE, 'Toutes les entités');
          remplir(selAction, r.actions, LIBELLES_ACTION, 'Toutes les actions');
        } catch (e) { erreur(e); }
      }

      container.appendChild(ui.pageEntete({
        titre: GMAO.moduleLabel('audit'), icone: 'audit', sousTitre: 'Qui a fait quoi, et quand.',
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
