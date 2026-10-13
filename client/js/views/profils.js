/**
 * Vue Profils & droits : matrice module × action, niveau hiérarchique, portée,
 * rattachement à un secteur, tri / regroupement par secteur (option de configuration).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  let rafraichir = () => {};

  function peutModifier(p) {
    if (!GMAO.can('profils', 'modifier')) return false;
    if (GMAO.estAdmin()) return true;
    return !p.estAdmin && p.niveau > GMAO.perms.niveau;
  }

  function ouvrirFormulaire(existant, apres) {
    const creation = !existant;
    let matrice = null;
    const champs = [
      { nom: 'nom', label: 'Nom du profil', type: 'texte', requis: true, placeholder: 'ex. Technicien électricité' },
      { nom: 'niveau', label: 'Niveau hiérarchique', type: 'nombre', requis: true, min: 1, max: 99, valeur: 5, aide: '1 = le plus élevé. Un utilisateur ne peut gérer que des profils de niveau inférieur au sien.' },
      { nom: 'description', label: 'Description', type: 'texte_long', lignes: 2 },
      { nom: 'portee', label: 'Portée des données', type: 'select', requis: true, options: Object.entries(GMAO.catalogue.portees || {}).map(([k, v]) => ({ value: k, label: v })), valeur: 'tous', aide: 'Détermine quelles fiches (OT, demandes, équipements…) sont visibles.' },
      { nom: 'secteurId', label: 'Secteur de rattachement', type: 'select', options: ui.optionsSecteurs({ vide: '— Aucun (transversal) —' }), aide: 'Permet de trier et regrouper les profils par secteur.' },
      { nom: 'couleur', label: 'Couleur', type: 'couleur', valeur: '#6b7280' },
      { nom: 'actif', label: 'Profil actif (attribuable)', type: 'booleen', valeur: true },
      GMAO.estAdmin() ? { nom: 'estAdmin', label: 'Profil administrateur (tous les droits, sans restriction)', type: 'booleen', valeur: false, onChange: (v, f) => { if (matrice) matrice.el.closest('.champ').classList.toggle('masque', !!v); } } : null,
      { type: 'html', rendu: () => {
        matrice = ui.matriceDroits({ mode: 'profil', valeurs: existant ? existant.permissions || {} : {} });
        const cont = el('div', null, el('div', { class: 'formulaire-separateur', style: { marginBottom: '8px' } }, 'Droits par module'), el('p', { class: 'texte-2 texte-petit' }, 'Cochez les actions autorisées. Cliquer sur le nom d\'un module ou d\'une action coche / décoche toute la ligne ou la colonne. « Voir » est accordé automatiquement dès qu\'une autre action l\'est.'), matrice.el);
        if (existant && existant.estAdmin) setTimeout(() => cont.closest('.champ') && cont.closest('.champ').classList.add('masque'), 0);
        return cont;
      } },
    ].filter(Boolean);
    ui.formModal({
      titre: creation ? 'Nouveau profil' : `Modifier le profil « ${existant.nom} »`, taille: 'large', champs,
      valeurs: existant ? Object.assign({}, existant, { secteurId: existant.secteurId == null ? '' : existant.secteurId }) : {},
      onSubmit: async (v) => {
        const body = Object.assign({}, v, { secteurId: v.secteurId === '' ? null : v.secteurId, permissions: matrice ? matrice.valeurs() : {} });
        const res = creation ? await api.post('/api/profils', body) : await api.put('/api/profils/' + existant.id, body);
        toast(creation ? 'Profil créé' : 'Profil enregistré', 'succes');
        await GMAO.refresh(false);
        if (apres) apres(res);
      },
    });
  }

  async function afficherFiche(id) {
    let p;
    try { p = await api.get('/api/profils/' + id); } catch (e) { return erreur(e); }
    const m = ui.modal({
      titre: frag(ui.pastille(p.couleur), p.nom), taille: 'large',
      contenu: frag(
        ui.details([
          { label: 'Description', valeur: p.description }, { label: 'Niveau hiérarchique', valeur: String(p.niveau) },
          { label: 'Portée des données', valeur: (GMAO.catalogue.portees || {})[p.portee] || p.portee }, { label: 'Secteur', valeur: p.secteurNom || 'Transversal' },
          { label: 'Type', valeur: p.estAdmin ? ui.badge('Administrateur', '#dc2626') : (p.systeme ? 'Profil fourni par défaut (modifiable)' : 'Profil personnalisé') }, { label: 'Statut', valeur: p.actif === false ? ui.badge('Inactif', '#6b7280') : ui.badge('Actif', '#16a34a') },
          { label: 'Utilisateurs', valeur: (p.utilisateurs || []).length ? p.utilisateurs.map((u) => `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login).join(', ') : 'Aucun' },
        ], { colonnes: 2 }),
        el('h3', { class: 'mt' }, 'Droits'),
        p.estAdmin ? ui.alerte('Profil administrateur : accès complet à tous les modules et toutes les données.', 'info') : ui.matriceDroits({ mode: 'profil', valeurs: p.permissions, disabled: true }).el,
      ),
      boutons: [
        peutModifier(p) ? { label: 'Modifier', icone: 'modifier', classe: 'btn-primaire', onClic: () => { m.fermer(); ouvrirFormulaire(p, rafraichir); } } : null,
        { label: 'Fermer' },
      ],
    });
  }

  async function dupliquer(p) {
    try { await api.post(`/api/profils/${p.id}/dupliquer`); toast('Profil dupliqué', 'succes'); await GMAO.refresh(false); rafraichir(); } catch (e) { erreur(e); }
  }
  async function supprimer(p) {
    if (!(await ui.confirm({ titre: 'Supprimer le profil', message: `Supprimer le profil « ${p.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
    try { await api.del('/api/profils/' + p.id); toast('Profil supprimé', 'succes'); await GMAO.refresh(false); rafraichir(); } catch (e) { erreur(e); }
  }

  GMAO.registerView('profils', {
    titre: 'Profils & droits', icone: 'profils',
    async rendu(container, { params }) {
      const cfg = GMAO.config.profils || {};
      let tri = cfg.triParSecteur ? 'secteur' : 'niveau';
      let grouper = !!cfg.grouperParSecteur;
      let filtreSecteur = '';

      const groupeSecteur = { cle: (p) => (p.secteurId == null ? 0 : p.secteurId), label: (id, rows) => frag(id ? ui.pastille((ui.secteur(id) || {}).couleur) : null, id ? ui.cheminSecteur(id) : 'Profils transversaux (sans secteur)', el('span', { class: 'texte-2' }, ` · ${rows.length}`)), ordre: (a, b) => ((a ? (ui.secteur(a) || {}).ordre || 0 : -1) - (b ? (ui.secteur(b) || {}).ordre || 0 : -1)) };

      const colonnes = [
        { cle: 'nom', label: 'Profil', rendu: (p) => el('div', null, el('div', { class: 'cellule-principale' }, ui.pastille(p.couleur), p.nom, p.estAdmin ? frag(' ', ui.badge('Admin', '#dc2626')) : null), p.description ? el('div', { class: 'cellule-secondaire' }, p.description) : null), valeurTri: (p) => p.nom.toLowerCase() },
        cfg.afficherNiveau !== false ? { cle: 'niveau', label: 'Niveau', aligner: 'centre', rendu: (p) => el('span', { class: 'badge', title: '1 = le plus élevé' }, String(p.niveau)) } : null,
        { cle: 'portee', label: 'Portée', rendu: (p) => (GMAO.catalogue.portees || {})[p.portee] || p.portee },
        { cle: 'secteurId', label: 'Secteur', rendu: (p) => { const s = ui.secteur(p.secteurId); return s ? ui.badge(s.nom, s.couleur, { contour: true }) : el('span', { class: 'texte-2' }, 'Transversal'); }, valeurTri: (p) => (p.secteurId == null ? -1 : (ui.secteur(p.secteurId) || {}).ordre || 0) },
        { cle: 'modules', label: 'Modules accessibles', tri: false, rendu: (p) => { if (p.estAdmin) return el('span', { class: 'texte-2' }, 'Tous'); const mods = GMAO.modules.filter((m) => m.actif && p.permissions && p.permissions[m.key] && p.permissions[m.key].voir); return mods.length ? el('span', { class: 'texte-petit' }, mods.map((m) => m.label).join(', ')) : el('span', { class: 'texte-2' }, 'Aucun'); } },
        { cle: 'nbUtilisateurs', label: 'Utilisateurs', aligner: 'centre', type: 'nombre' },
        { cle: 'actif', label: 'Statut', aligner: 'centre', rendu: (p) => (p.actif === false ? ui.badge('Inactif', '#6b7280') : ui.badge('Actif', '#16a34a')) },
      ].filter(Boolean);

      const tableau = ui.table({
        colonnes, lignes: [], recherche: 'Rechercher un profil…', exportCsv: 'profils.csv', pagination: false,
        onClic: (p) => afficherFiche(p.id),
        ligneClasse: (p) => (p.actif === false ? 'inactif' : ''),
        groupe: grouper ? groupeSecteur : null,
        actions: [
          { icone: 'modifier', titre: 'Modifier', visible: peutModifier, onClic: (p) => ouvrirFormulaire(p, rafraichir) },
          { icone: 'copier', titre: 'Dupliquer', visible: () => GMAO.can('profils', 'creer'), onClic: dupliquer },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (p) => GMAO.can('profils', 'supprimer') && !p.estAdmin && peutModifier(p), onClic: supprimer },
        ],
      });

      rafraichir = async () => {
        try {
          const rows = await api.get('/api/profils', { tri, secteurId: filtreSecteur || undefined });
          tableau.setTri(null); tableau.maj(rows);
        } catch (e) { erreur(e); }
      };

      const selectTri = el('select', { onchange: () => { tri = selectTri.value; rafraichir(); } }, [['secteur', 'Trier par secteur'], ['niveau', 'Trier par niveau hiérarchique'], ['nom', 'Trier par nom']].map(([v, l]) => el('option', { value: v, selected: v === tri }, l)));
      const selectSecteur = el('select', { onchange: () => { filtreSecteur = selectSecteur.value; rafraichir(); } }, [{ value: '', label: 'Tous les secteurs' }, { value: 'aucun', label: 'Transversaux uniquement' }].concat(ui.optionsSecteurs({ vide: false })).map((o) => el('option', { value: o.value }, o.label)));
      const cbGrouper = el('input', { type: 'checkbox', checked: grouper, onchange: () => { grouper = cbGrouper.checked; tableau.setGroupe(grouper ? groupeSecteur : null); } });

      container.appendChild(ui.pageEntete({
        titre: GMAO.moduleLabel('profils'), icone: 'profils', sousTitre: 'Chaque profil définit ce que ses utilisateurs voient et peuvent faire ; les droits sont ensuite ajustables individuellement.',
        actions: [
          GMAO.can('configuration', 'modifier') ? ui.bouton('Options d\'affichage', { icone: 'configuration', onClic: () => GMAO.navigate('#/configuration?onglet=affichage') }) : null,
          GMAO.can('profils', 'creer') ? ui.bouton('Nouveau profil', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, rafraichir) }) : null,
        ],
      }));
      container.appendChild(ui.alerte(frag(el('strong', null, 'Hiérarchie : '), 'le niveau 1 est le plus élevé. Un gestionnaire ne peut créer ou modifier que des profils et utilisateurs de niveau strictement inférieur au sien, et ne peut accorder que des droits qu\'il possède lui-même. La portée « secteurs » inclut automatiquement les sous-secteurs.'), 'info'));
      container.appendChild(el('div', { class: 'barre-outils' }, selectTri, selectSecteur, el('label', { class: 'inline' }, cbGrouper, 'Grouper par secteur')));
      container.appendChild(tableau.el);
      await rafraichir();
      if (params[0]) afficherFiche(params[0]);
    },
  });
})();
