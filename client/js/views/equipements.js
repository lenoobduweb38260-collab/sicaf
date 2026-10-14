/**
 * Vue Équipements : arborescence (secteurs → équipements → sous-équipements) dans la colonne
 * de gauche ; liste filtrable OU fiche détaillée (#/equipements/:id) dans la zone principale.
 * Fiche à onglets : informations, interventions (OT / demandes), préventif, documents,
 * pièces compatibles, compteur (relevés historisés). Formulaires modaux, changement d'état
 * rapide, duplication, impression, export CSV.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'equipements';
  const UNITES_COMPTEUR = ['heures', 'cycles', 'km', 'pièces', 'tonnes', 'm³', 'litres'];
  const TAILLE_MAX_DOC = 5 * 1024 * 1024;

  /** État conservé entre deux rendus : cache de l'arbre, nœuds dépliés / repliés, filtre de l'arbre. */
  const memo = { arbre: null, replies: new Set(), ouverts: new Set(), filtreArbre: '' };

  // ----- Utilitaires ------------------------------------------------------
  const can = (action) => GMAO.can(MODULE, action);
  const urlDocument = (eqId, index, telecharger) => `/api/equipements/${eqId}/documents/${index}${telecharger ? '?telecharger=1' : ''}`;
  function tailleLisible(octets) {
    const n = Number(octets) || 0;
    if (n < 1024) return `${n} o`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
    return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  }
  function formatCompteur(c) {
    if (!c) return '—';
    return `${ui.formatNombre(c.valeur || 0)} ${c.unite || ''}`.trim();
  }
  function typeDocLisible(type) {
    const t = String(type || '').toLowerCase();
    if (t === 'application/pdf') return 'PDF';
    if (t.startsWith('image/')) return 'Image';
    if (t.startsWith('text/')) return 'Texte';
    if (/word/.test(t)) return 'Word';
    if (/excel|spreadsheet/.test(t)) return 'Excel';
    if (/zip|compressed/.test(t)) return 'Archive';
    return t.split('/').pop().toUpperCase().slice(0, 12) || 'Fichier';
  }
  function periodiciteLisible(p, unite) {
    if (!p || !p.type) return '—';
    if (p.type === 'compteur') return `Tous les ${ui.formatNombre(p.valeur)} ${unite || ''}`.trim();
    const libs = { jours: 'jour(s)', semaines: 'semaine(s)', mois: 'mois' };
    return `Tous les ${ui.formatNombre(p.valeur)} ${libs[p.type] || p.type}`;
  }
  function echeanceLisible(v, p, unite) {
    if (v == null || v === '') return '—';
    if (p && p.type === 'compteur') return `${ui.formatNombre(v)} ${unite || ''}`.trim();
    return ui.formatDate(v);
  }
  /** Icône SVG dimensionnée (hors contexte .btn / .arbre, le SVG n'a pas de taille par défaut). */
  function iconeDim(nom, taille, couleur) { const ic = icone(nom); Object.assign(ic.style, { width: taille + 'px', height: taille + 'px', flexShrink: 0, color: couleur || 'currentColor' }); return ic; }
  /** Lien vers une autre vue, utilisable dans une ligne de tableau cliquable. */
  /** Lien vers une autre vue ; simple texte si le module cible n'est pas accessible à l'utilisateur. */
  function lienVue(href, label) {
    const cible = (String(href).match(/^#\/([^/?]+)/) || [])[1];
    if (cible && typeof GMAO.moduleVisible === 'function' && !GMAO.moduleVisible(cible)) return el('span', null, label);
    return el('a', { href, onclick: (ev) => ev.stopPropagation() }, label);
  }
  function libelleEq(e) { return `${e.numero || ''} · ${e.nom || ''}`.replace(/^ · /, ''); }

  // ----- Formulaire de création / modification --------------------------
  /**
   * options : { parentId, secteurId } (valeurs initiales), apres(res) (sinon navigation vers la fiche).
   */
  async function ouvrirFormulaire(existant, options = {}) {
    const creation = !existant;
    let equipements = [];
    let fournisseurs = [];
    try { equipements = await api.get('/api/equipements', { actif: '1' }); } catch (e) { equipements = []; }
    if (GMAO.can('fournisseurs', 'voir')) {
      try { const r = await api.get('/api/fournisseurs'); fournisseurs = Array.isArray(r) ? r : (r && Array.isArray(r.lignes) ? r.lignes : []); } catch (e) { fournisseurs = []; }
    }
    // Un équipement ne peut pas être rattaché à lui-même ni à l'un de ses descendants
    const exclus = new Set();
    if (existant) {
      exclus.add(existant.id);
      let change = true;
      while (change) { change = false; for (const x of equipements) if (x.parentId != null && exclus.has(Number(x.parentId)) && !exclus.has(x.id)) { exclus.add(x.id); change = true; } }
    }
    const optionsParents = [{ value: '', label: '— Aucun (équipement principal) —' }].concat(
      equipements.filter((x) => !exclus.has(x.id)).sort((a, b) => String(a.numero).localeCompare(String(b.numero), 'fr', { numeric: true }))
        .map((x) => ({ value: x.id, label: `${x.numero} · ${x.nom}${x.secteurChemin ? ' (' + x.secteurChemin + ')' : ''}` })));
    const optionsFournisseurs = [{ value: '', label: '— Aucun —' }].concat(fournisseurs.filter((f) => f.actif !== false).sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr')).map((f) => ({ value: f.id, label: f.nom })));
    const unites = UNITES_COMPTEUR.slice();
    const uniteCourante = existant && existant.compteur && existant.compteur.unite;
    if (uniteCourante && !unites.includes(uniteCourante)) unites.push(uniteCourante);
    const devise = (GMAO.config.general || {}).devise || '€';
    const gabarit = ((GMAO.config.numerotation || {}).eq) || 'EQ-{num:4}';

    const champs = [
      { type: 'separateur', label: 'Identification' },
      { nom: 'nom', label: 'Désignation', type: 'texte', requis: true, placeholder: 'ex. Compresseur d\'air GA 37' },
      { nom: 'numero', label: 'Numéro', type: 'texte', placeholder: 'Généré automatiquement si vide', aide: creation ? `Gabarit configuré : ${gabarit}` : 'Doit rester unique.' },
      { nom: 'typeCode', label: 'Type d\'équipement', type: 'select', liste: 'typesEquipement', vide: false, requis: true },
      { nom: 'criticiteCode', label: 'Criticité', type: 'select', liste: 'criticites', vide: false, requis: true, aide: 'Impact d\'une panne sur la production / la sécurité.' },
      { nom: 'etatCode', label: 'État', type: 'select', liste: 'etatsEquipement', vide: false, requis: true },
      { nom: 'actif', label: 'Équipement actif (non archivé)', type: 'booleen', valeur: true },
      { type: 'separateur', label: 'Rattachement' },
      { nom: 'parentId', label: 'Équipement parent', type: 'select', options: optionsParents, aide: 'Pour un sous-équipement (ex. moteur d\'une ligne). Le secteur du parent est repris si aucun secteur n\'est choisi.',
        onChange: (v, f) => { if (v !== '' && v != null && !f.get('secteurId')) { const p = equipements.find((x) => x.id === Number(v)); if (p && p.secteurId != null) f.set('secteurId', p.secteurId); } } },
      { nom: 'secteurId', label: 'Secteur', type: 'select', options: ui.optionsSecteurs({ vide: '— Hérité de l\'équipement parent —' }), aide: 'Obligatoire pour un équipement principal ; détermine qui voit la fiche (portée).' },
      { nom: 'localisation', label: 'Localisation', type: 'texte', placeholder: 'ex. Hall A, travée 2', pleineLargeur: true },
      { type: 'separateur', label: 'Caractéristiques' },
      { nom: 'marque', label: 'Marque', type: 'texte' },
      { nom: 'modele', label: 'Modèle', type: 'texte' },
      { nom: 'numeroSerie', label: 'Numéro de série', type: 'texte' },
      { nom: 'fournisseurId', label: 'Fournisseur / constructeur', type: 'select', options: optionsFournisseurs, aide: fournisseurs.length ? '' : 'Aucun fournisseur enregistré (module Fournisseurs).' },
      { nom: 'dateAchat', label: 'Date d\'achat', type: 'date' },
      { nom: 'dateMiseEnService', label: 'Date de mise en service', type: 'date' },
      { nom: 'valeurAchat', label: `Valeur d'achat (${devise})`, type: 'nombre', min: 0, step: '0.01' },
      { nom: 'garantieFin', label: 'Fin de garantie', type: 'date' },
      { type: 'separateur', label: 'Compteur' },
      { nom: 'compteurValeur', label: 'Valeur du compteur', type: 'nombre', min: 0, aide: creation ? 'Valeur initiale : un premier relevé est enregistré si elle est non nulle.' : 'Pour un relevé historisé, utilisez l\'onglet « Compteur » de la fiche.' },
      { nom: 'compteurUnite', label: 'Unité du compteur', type: 'select', options: unites.map((u) => ({ value: u, label: u })), valeur: 'heures' },
      { type: 'separateur', label: 'Description' },
      { nom: 'description', label: 'Description', type: 'texte_long', lignes: 3, placeholder: 'Fonction, caractéristiques principales, capacité…' },
      { nom: 'notes', label: 'Notes de maintenance', type: 'texte_long', lignes: 3, placeholder: 'Consignes, périodicités constructeur, points de vigilance…' },
      ...ui.champsPersoDefs(MODULE),
    ];
    const valeurs = existant
      ? Object.assign({}, existant, {
        secteurId: existant.secteurId == null ? '' : existant.secteurId, parentId: existant.parentId == null ? '' : existant.parentId, fournisseurId: existant.fournisseurId == null ? '' : existant.fournisseurId,
        compteurValeur: existant.compteur ? existant.compteur.valeur : 0, compteurUnite: (existant.compteur && existant.compteur.unite) || 'heures', actif: existant.actif !== false,
      }, ui.champsPersoInitiaux(existant))
      : { actif: true, secteurId: options.secteurId == null ? '' : options.secteurId, parentId: options.parentId == null ? '' : options.parentId, compteurValeur: 0, compteurUnite: 'heures' };
    // Les listes de valeurs n'ont pas d'option vide : on propose le premier code configuré par défaut
    const premierCode = (nomListe) => ((GMAO.liste(nomListe)[0] || {}).code) || '';
    for (const [champ, nomListe] of [['typeCode', 'typesEquipement'], ['criticiteCode', 'criticites'], ['etatCode', 'etatsEquipement']]) {
      if (valeurs[champ] == null || valeurs[champ] === '' || !GMAO.liste(nomListe).some((x) => x.code === valeurs[champ])) valeurs[champ] = premierCode(nomListe);
    }

    ui.formModal({
      titre: creation ? (options.parentId != null ? 'Nouveau sous-équipement' : 'Nouvel équipement') : `Modifier ${libelleEq(existant)}`,
      taille: 'large', champs, valeurs,
      onSubmit: async (v, modal, form) => {
        if ((v.secteurId === '' || v.secteurId == null) && (v.parentId === '' || v.parentId == null)) { form.erreur('secteurId', 'Le secteur est obligatoire pour un équipement principal'); return false; }
        for (const k of Object.keys(v)) if (v[k] === false && /Code$/.test(k)) v[k] = '';
        const body = Object.assign({}, v, {
          secteurId: v.secteurId === '' ? null : v.secteurId,
          parentId: v.parentId === '' ? null : v.parentId,
          fournisseurId: v.fournisseurId === '' ? null : v.fournisseurId,
          compteur: { valeur: v.compteurValeur == null || v.compteurValeur === '' ? 0 : v.compteurValeur, unite: v.compteurUnite || 'heures' },
          champs: ui.champsPersoValeurs(v),
        });
        delete body.compteurValeur; delete body.compteurUnite;
        for (const k of Object.keys(body)) if (k.startsWith('champs.')) delete body[k];
        const res = creation ? await api.post('/api/equipements', body) : await api.put('/api/equipements/' + existant.id, body);
        toast(creation ? `Équipement ${res.numero} créé` : `Équipement ${res.numero} enregistré`, 'succes');
        if (options.apres) options.apres(res); else GMAO.navigate('#/equipements/' + res.id);
      },
    });
  }

  // ----- Actions ----------------------------------------------------------
  function ouvrirChangementEtat(e, apres) {
    const options = GMAO.liste('etatsEquipement').filter((x) => x.code !== e.etatCode).map((x) => ({ value: x.code, label: x.label, couleur: x.couleur }));
    if (!options.length) return toast('Aucun autre état n\'est configuré', 'alerte');
    ui.formModal({
      titre: `Changer l'état — ${e.nom}`, taille: 'petite', colonnes: 1,
      avant: el('p', { class: 'texte-2' }, 'État actuel : ', ui.badgeListe('etatsEquipement', e.etatCode)),
      champs: [
        { nom: 'etatCode', label: 'Nouvel état', type: 'radio', options, requis: true },
        { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 3, placeholder: 'Motif, symptômes constatés, actions engagées…' },
      ],
      submitLabel: 'Changer l\'état',
      onSubmit: async (v) => {
        const res = await api.put(`/api/equipements/${e.id}/etat`, { etatCode: v.etatCode, commentaire: v.commentaire || '' });
        toast(`${res.numero} : ${ui.libelle('etatsEquipement', res.etatCode)}`, 'succes');
        if (apres) apres(res);
      },
    });
  }

  function ouvrirReleve(e, apres) {
    const unite = (e.compteur && e.compteur.unite) || 'heures';
    ui.formModal({
      titre: `Relevé du compteur — ${e.nom}`, taille: 'petite', colonnes: 1,
      avant: el('p', { class: 'texte-2' }, `Valeur actuelle : ${formatCompteur(e.compteur)}`),
      champs: [
        { nom: 'valeur', label: `Nouvelle valeur (${unite})`, type: 'nombre', requis: true, min: 0, valeur: (e.compteur && e.compteur.valeur) || 0 },
        { nom: 'date', label: 'Date du relevé', type: 'datetime', valeur: new Date().toISOString() },
        { nom: 'commentaire', label: 'Commentaire', type: 'texte', placeholder: 'ex. relevé lors de la ronde hebdomadaire' },
      ],
      submitLabel: 'Enregistrer le relevé',
      onSubmit: async (v) => {
        const res = await api.post(`/api/equipements/${e.id}/compteur`, { valeur: v.valeur, date: v.date || undefined, commentaire: v.commentaire || '' });
        toast(`Compteur mis à jour : ${formatCompteur(res.compteur)}`, 'succes');
        if (apres) apres(res);
      },
    });
  }

  async function dupliquer(e) {
    const nom = await ui.prompt({ titre: 'Dupliquer l\'équipement', message: `Copie de ${libelleEq(e)} (documents, relevés et numéro de série non repris).`, label: 'Désignation de la copie', valeur: `${e.nom} (copie)` });
    if (nom === null) return;
    try {
      const res = await api.post(`/api/equipements/${e.id}/dupliquer`, { nom });
      toast(`Équipement ${res.numero} créé par duplication`, 'succes');
      GMAO.navigate('#/equipements/' + res.id);
    } catch (err) { erreur(err); }
  }

  async function supprimer(e, apres) {
    const ok = await ui.confirm({ titre: 'Supprimer l\'équipement', message: `Supprimer ${libelleEq(e)} ? S'il est référencé par des interventions, des demandes ou des plans préventifs, il sera désactivé (archivé) au lieu d'être supprimé.`, okLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try {
      const r = await api.del('/api/equipements/' + e.id);
      toast(r.desactive ? 'Équipement désactivé (référencé dans l\'historique de maintenance)' : 'Équipement supprimé', 'succes');
      if (apres) apres(r);
    } catch (err) { erreur(err); }
  }

  function ouvrirAjoutDocument(e, apres) {
    ui.formModal({
      titre: `Ajouter un document — ${e.nom}`, taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'fichier', label: 'Fichier', type: 'fichier', requis: true, tailleMax: TAILLE_MAX_DOC, aide: 'Photo, notice, schéma, certificat… 5 Mo maximum. La première image jointe sert de photo à la fiche.' },
        { nom: 'description', label: 'Description', type: 'texte', placeholder: 'ex. Notice constructeur, schéma électrique…' },
      ],
      submitLabel: 'Ajouter',
      onSubmit: async (v) => {
        const f = v.fichier;
        if (!f || !f.contenu) { toast('Sélectionnez un fichier', 'erreur'); return false; }
        await api.post(`/api/equipements/${e.id}/documents`, { nom: f.nom, type: f.type, taille: f.taille, contenu: f.contenu, description: v.description || '' });
        toast('Document ajouté', 'succes');
        if (apres) apres();
      },
    });
  }

  function imprimerFiche(e) {
    const esc = ui.esc;
    const lib = (l, c) => esc(ui.libelle(l, c));
    const ligne = (label, val) => `<dt>${esc(label)}</dt><dd>${val == null || val === '' ? '—' : val}</dd>`;
    const tableau = (entetes, lignes) => `<table><thead><tr>${entetes.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${c == null || c === '' ? '—' : c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const chemin = [e.secteurChemin].concat((e.chemin || []).map((a) => a.nom), [e.nom]).filter(Boolean).map(esc).join(' › ');
    const unite = (e.compteur || {}).unite || '';
    let html = `<h1>${esc(e.numero)} — ${esc(e.nom)}</h1><div>${chemin}</div>`;
    html += '<h2>Informations</h2><dl>'
      + ligne('Type', lib('typesEquipement', e.typeCode)) + ligne('État', `<span class="badge">${lib('etatsEquipement', e.etatCode)}</span>`) + ligne('Criticité', lib('criticites', e.criticiteCode))
      + ligne('Secteur', esc(e.secteurChemin)) + ligne('Équipement parent', e.parent ? esc(`${e.parent.numero} · ${e.parent.nom}`) : '') + ligne('Localisation', esc(e.localisation))
      + ligne('Marque / modèle', esc([e.marque, e.modele].filter(Boolean).join(' '))) + ligne('Numéro de série', esc(e.numeroSerie)) + ligne('Fournisseur', e.fournisseur ? esc(e.fournisseur.nom) : '')
      + ligne('Date d\'achat', esc(ui.formatDate(e.dateAchat))) + ligne('Mise en service', esc(ui.formatDate(e.dateMiseEnService))) + ligne('Valeur d\'achat', e.valeurAchat != null ? esc(ui.formatMontant(e.valeurAchat)) : '')
      + ligne('Fin de garantie', e.garantieFin ? esc(ui.formatDate(e.garantieFin)) + (e.garantie === 'expiree' ? ' (expirée)' : '') : '') + ligne('Compteur', esc(formatCompteur(e.compteur)))
      + ligne('Statut', e.actif === false ? 'Désactivé' : 'Actif')
      + ui.champsPersoAffichage(MODULE, e).map((c) => ligne(c.label, esc(c.valeur))).join('')
      + '</dl>';
    if (e.description) html += `<h2>Description</h2><p>${esc(e.description).replace(/\n/g, '<br>')}</p>`;
    if (e.notes) html += `<h2>Notes de maintenance</h2><p>${esc(e.notes).replace(/\n/g, '<br>')}</p>`;
    if ((e.enfants || []).length) html += '<h2>Sous-équipements</h2>' + tableau(['Numéro', 'Désignation', 'Type', 'État', 'Criticité'], e.enfants.map((x) => [esc(x.numero), esc(x.nom), lib('typesEquipement', x.typeCode), lib('etatsEquipement', x.etatCode), lib('criticites', x.criticiteCode)]));
    if ((e.derniersOt || []).length) html += `<h2>Derniers ordres de travail (${e.nbOtTotal} au total, ${e.nbOtOuverts} ouvert(s))</h2>` + tableau(['N°', 'Titre', 'Type', 'Statut', 'Technicien', 'Prévu le', 'Terminé le'], e.derniersOt.map((o) => [esc(o.numero), esc(o.titre), lib('typesIntervention', o.typeCode), lib('statutsOT', o.statut), esc(ui.nomUser(o.technicienId)), esc(ui.formatDate(o.datePrevue)), esc(ui.formatDate(o.dateFin))]));
    if ((e.plansPreventifs || []).length) html += '<h2>Plans de maintenance préventive</h2>' + tableau(['N°', 'Plan', 'Périodicité', 'Dernière exécution', 'Prochaine échéance', 'Actif'], e.plansPreventifs.map((p) => [esc(p.numero), esc(p.nom), esc(periodiciteLisible(p.periodicite, unite)), esc(echeanceLisible(p.derniereExecution, p.periodicite, unite)), esc(echeanceLisible(p.prochaineEcheance, p.periodicite, unite)), p.actif === false ? 'Non' : 'Oui']));
    if ((e.articlesCompatibles || []).length) html += '<h2>Pièces compatibles</h2>' + tableau(['Code', 'Désignation', 'Stock', 'Seuil', 'Emplacement'], e.articlesCompatibles.map((a) => [esc(a.code), esc(a.designation), esc(ui.formatNombre(a.quantite)), esc(ui.formatNombre(a.seuilMin)), esc(a.emplacement)]));
    if ((e.compteurReleves || []).length) html += '<h2>Derniers relevés de compteur</h2>' + tableau(['Date', `Valeur (${esc(unite)})`, 'Relevé par', 'Commentaire'], e.compteurReleves.slice(0, 15).map((r) => [esc(ui.formatDateHeure(r.date)), esc(ui.formatNombre(r.valeur)), esc(r.userNom), esc(r.commentaire)]));
    if ((e.documents || []).length) html += '<h2>Documents joints</h2><ul>' + e.documents.map((d) => `<li>${esc(d.nom)} (${esc(tailleLisible(d.taille))}, ${esc(ui.formatDate(d.date))})</li>`).join('') + '</ul>';
    html += '<div class="signature"><div>Responsable maintenance</div><div>Date / visa</div></div>';
    ui.imprimer(`Fiche équipement ${e.numero}`, html);
  }

  // ----- Arborescence (colonne de gauche) ---------------------------------
  const cleNoeud = (n) => `${n.type}:${n.id}`;
  function estOuvert(n) { const k = cleNoeud(n); return n.type === 'secteur' ? !memo.replies.has(k) : memo.ouverts.has(k); }
  function basculer(n, ouvert) {
    const k = cleNoeud(n);
    if (n.type === 'secteur') { if (ouvert) memo.replies.delete(k); else memo.replies.add(k); } else if (ouvert) memo.ouverts.add(k); else memo.ouverts.delete(k);
  }
  function parcourir(noeuds, fn, chemin = []) { for (const n of noeuds || []) { fn(n, chemin); parcourir(n.enfants, fn, chemin.concat([n])); } }
  /** Conserve les nœuds correspondant au filtre (et leurs ancêtres) ; un nœud qui correspond garde tous ses enfants. */
  function filtrerNoeuds(noeuds, filtre) {
    const out = [];
    for (const n of noeuds || []) {
      const enfants = filtrerNoeuds(n.enfants, filtre);
      const texte = (n.type === 'secteur' ? `${n.nom} ${n.code || ''}` : `${n.numero} ${n.nom}`).toLowerCase();
      const correspond = texte.includes(filtre);
      if (correspond || enfants.length) out.push(Object.assign({}, n, { enfants: correspond ? n.enfants || [] : enfants }));
    }
    return out;
  }
  function ouvrirCheminVers(selection) {
    if (!selection || !memo.arbre) return;
    parcourir(memo.arbre, (n, chemin) => { if (cleNoeud(n) === selection) chemin.forEach((a) => basculer(a, true)); });
  }

  function rendreArbre(cont, selectionInitiale) {
    let selection = selectionInitiale;
    ui.vider(cont);
    const corps = el('div', { class: 'arbre', style: { marginTop: '8px', fontSize: '13px' } });
    const total = el('span', { class: 'texte-2 texte-petit', style: { marginLeft: 'auto', fontWeight: 400 } });
    const recherche = el('input', { type: 'search', placeholder: 'Filtrer l\'arborescence…', value: memo.filtreArbre, style: { width: '100%' } });
    recherche.addEventListener('input', ui.debounce(() => { memo.filtreArbre = recherche.value; dessiner(); }, 200));
    const btnDeplier = el('button', { class: 'btn btn-sm btn-lien', type: 'button', title: 'Tout déplier', onclick: () => { memo.replies.clear(); parcourir(memo.arbre, (n) => { if (n.type === 'equipement' && (n.enfants || []).length) memo.ouverts.add(cleNoeud(n)); }); dessiner(); } }, icone('chevron_bas'), 'Tout déplier');
    const btnReplier = el('button', { class: 'btn btn-sm btn-lien', type: 'button', title: 'Tout replier', onclick: () => { memo.ouverts.clear(); parcourir(memo.arbre, (n) => { if (n.type === 'secteur') memo.replies.add(cleNoeud(n)); }); dessiner(); } }, icone('chevron_droite'), 'Tout replier');
    const btnTous = el('button', { class: 'btn btn-sm btn-lien', type: 'button', title: 'Afficher tous les équipements', onclick: () => GMAO.navigate('#/equipements') }, icone('liste'), 'Tous');
    cont.appendChild(el('div', { class: 'texte-gras', style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' } }, iconeDim('secteur', 18, 'var(--primaire)'), 'Arborescence', total));
    cont.appendChild(recherche);
    cont.appendChild(el('div', { style: { display: 'flex', gap: '2px', marginTop: '4px', flexWrap: 'wrap' } }, btnDeplier, btnReplier, btnTous));
    cont.appendChild(corps);

    function construire(liste, forcerOuvert) {
      const ul = el('ul');
      for (const n of liste) {
        const enfants = n.enfants || [];
        const cle = cleNoeud(n);
        const ouvert = forcerOuvert || estOuvert(n);
        const estSecteur = n.type === 'secteur';
        const li = el('li', { class: enfants.length && !ouvert ? 'replie' : '' });
        // Pas de classe « vide » (elle entre en collision avec le style global des listes vides) : masquage inline
        const bascule = el('span', { class: 'bascule', style: enfants.length ? null : { visibility: 'hidden' } }, enfants.length ? (ouvert ? '▼' : '▶') : '');
        bascule.addEventListener('click', (ev) => { ev.stopPropagation(); const replie = li.classList.toggle('replie'); bascule.textContent = replie ? '▶' : '▼'; basculer(n, !replie); });
        const noeud = el('div', { class: 'noeud' + (selection === cle ? ' actif' : ''), dataset: { cle }, title: estSecteur ? `${n.nom}${n.code ? ' (' + n.code + ')' : ''} — ${n.nbEquipements || 0} équipement(s)` : `${n.numero} · ${n.nom}` },
          bascule, icone(estSecteur ? 'secteur' : 'equipements'),
          ui.pastille(estSecteur ? n.couleur : ui.couleur('etatsEquipement', n.etatCode)),
          el('span', { class: 'noeud-label', style: Object.assign({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, n.actif === false ? { textDecoration: 'line-through', opacity: 0.6 } : {}) }, n.nom),
          n.nbEquipements ? el('span', { class: 'noeud-compteur' }, String(n.nbEquipements)) : null);
        noeud.addEventListener('click', () => GMAO.navigate(estSecteur ? `#/equipements?secteurId=${n.id ? n.id : 'aucun'}` : `#/equipements/${n.id}`));
        li.appendChild(noeud);
        if (enfants.length) li.appendChild(construire(enfants, forcerOuvert));
        ul.appendChild(li);
      }
      return ul;
    }
    function dessiner() {
      ui.vider(corps);
      if (!memo.arbre) { corps.appendChild(ui.chargement()); return; }
      const filtre = memo.filtreArbre.trim().toLowerCase();
      const noeuds = filtre ? filtrerNoeuds(memo.arbre, filtre) : memo.arbre;
      total.textContent = `${memo.arbre.reduce((s, n) => s + (n.nbEquipements || 0), 0)} éq.`;
      if (!noeuds.length) { corps.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '8px' } }, filtre ? 'Aucun résultat pour ce filtre' : 'Aucun équipement')); return; }
      corps.appendChild(construire(noeuds, !!filtre));
    }
    async function recharger() {
      try {
        memo.arbre = await api.get('/api/equipements-arbre');
        ouvrirCheminVers(selection);
        if (cont.isConnected) dessiner();
      } catch (e) { if (cont.isConnected) { ui.vider(corps); corps.appendChild(el('div', { class: 'texte-danger texte-petit', style: { padding: '8px' } }, 'Arborescence indisponible : ' + e.message)); } }
    }
    dessiner();
    recharger();
    return {
      recharger,
      selectionner(cle) { selection = cle; corps.querySelectorAll('.noeud').forEach((n) => n.classList.toggle('actif', n.dataset.cle === cle)); },
    };
  }

  // ----- Liste ------------------------------------------------------------
  async function afficherListe(entete, zone, query, arbre) {
    const filtres = { secteurId: query.secteurId || '', typeCode: query.typeCode || '', etatCode: query.etatCode || '', criticiteCode: query.criticiteCode || '', inactifs: query.inactifs === '1', principaux: query.principaux === '1' };
    let toutes = [];
    const secteurFiltre = () => (filtres.secteurId && filtres.secteurId !== 'aucun' ? Number(filtres.secteurId) : null);
    const paramsApi = () => ({ secteurId: secteurFiltre() || undefined, typeCode: filtres.typeCode || undefined, criticiteCode: filtres.criticiteCode || undefined, actif: filtres.inactifs ? undefined : '1', parentId: filtres.principaux ? 'aucun' : undefined });
    const qsCourant = () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(filtres)) if (v) p.set(k, v === true ? '1' : v); const s = p.toString(); return s ? '?' + s : ''; };

    entete.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'equipements', sousTitre: 'Parc machines : arborescence, fiches, historique des interventions et compteurs',
      actions: [
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => {
          const p = new URLSearchParams(); for (const [k, v] of Object.entries(Object.assign(paramsApi(), { etatCode: filtres.etatCode || undefined }))) if (v !== undefined) p.set(k, v);
          api.telecharger('/api/equipements-export' + (p.toString() ? '?' + p : ''), 'equipements.csv').catch(erreur);
        } }) : null,
        can('creer') ? ui.bouton('Nouvel équipement', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, { secteurId: secteurFiltre() }) }) : null,
      ],
    }));

    // Indicateurs
    const kpis = el('div', { class: 'grille grille-auto', style: { gap: '12px', marginBottom: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } });
    function majKpis() {
      ui.vider(kpis);
      kpis.appendChild(ui.kpi({ label: 'Équipements', valeur: toutes.length, icone: 'equipements', detail: filtres.inactifs ? 'inactifs inclus' : 'actifs', onClic: () => { filtres.etatCode = ''; selEtat.value = ''; charger(); } }));
      for (const s of GMAO.liste('etatsEquipement')) {
        const n = toutes.filter((x) => x.etatCode === s.code).length;
        kpis.appendChild(ui.kpi({ label: s.label, valeur: n, couleur: s.couleur, detail: filtres.etatCode === s.code ? 'filtre actif' : '', onClic: () => { filtres.etatCode = filtres.etatCode === s.code ? '' : s.code; selEtat.value = filtres.etatCode; charger(); } }));
      }
      const ouverts = toutes.reduce((s, x) => s + (x.nbOtOuverts || 0), 0);
      kpis.appendChild(ui.kpi({ label: 'OT ouverts', valeur: ouverts, icone: 'ot', couleur: ouverts ? '#f59e0b' : '#16a34a', detail: 'interventions en cours' }));
    }

    // Filtres
    const opt = (o, courant) => el('option', { value: o.value, selected: String(o.value) === String(courant) }, o.label);
    const selSecteur = el('select', { title: 'Secteur', onchange: () => { filtres.secteurId = selSecteur.value; charger(); } }, [{ value: '', label: 'Tous les secteurs' }, { value: 'aucun', label: 'Sans secteur' }].concat(ui.optionsSecteurs({ vide: false })).map((o) => opt(o, filtres.secteurId)));
    const selType = el('select', { title: 'Type', onchange: () => { filtres.typeCode = selType.value; charger(); } }, ui.optionsListe('typesEquipement', { vide: 'Tous les types' }).map((o) => opt(o, filtres.typeCode)));
    const selEtat = el('select', { title: 'État', onchange: () => { filtres.etatCode = selEtat.value; charger(); } }, ui.optionsListe('etatsEquipement', { vide: 'Tous les états' }).map((o) => opt(o, filtres.etatCode)));
    const selCrit = el('select', { title: 'Criticité', onchange: () => { filtres.criticiteCode = selCrit.value; charger(); } }, ui.optionsListe('criticites', { vide: 'Toutes les criticités' }).map((o) => opt(o, filtres.criticiteCode)));
    const cbPrincipaux = el('input', { type: 'checkbox', checked: filtres.principaux, onchange: () => { filtres.principaux = cbPrincipaux.checked; charger(); } });
    const cbInactifs = el('input', { type: 'checkbox', checked: filtres.inactifs, onchange: () => { filtres.inactifs = cbInactifs.checked; charger(); } });
    const btnReinit = ui.bouton('Réinitialiser', { icone: 'fermer', classe: 'btn-sm', titre: 'Effacer les filtres', onClic: () => {
      Object.assign(filtres, { secteurId: '', typeCode: '', etatCode: '', criticiteCode: '', inactifs: false, principaux: false });
      selSecteur.value = ''; selType.value = ''; selEtat.value = ''; selCrit.value = ''; cbPrincipaux.checked = false; cbInactifs.checked = false;
      charger();
    } });

    const colonnes = [
      { cle: 'numero', label: 'Numéro', rendu: (e) => el('span', { class: 'cellule-principale', style: { whiteSpace: 'nowrap' } }, e.numero), valeurTri: (e) => String(e.numero || '') },
      { cle: 'nom', label: 'Désignation', largeur: '28%', rendu: (e) => el('div', null, el('div', { class: 'cellule-principale' }, e.nom, e.actif === false ? frag(' ', ui.badge('Inactif', '#6b7280')) : null), el('div', { class: 'cellule-secondaire' }, [e.parentNumero ? `↳ ${e.parentNumero} ${e.parentNom}` : '', [e.marque, e.modele].filter(Boolean).join(' ')].filter(Boolean).join(' · '))), valeurTri: (e) => String(e.nom || '').toLowerCase() },
      { cle: 'typeCode', label: 'Type', liste: 'typesEquipement' },
      { cle: 'etatCode', label: 'État', liste: 'etatsEquipement' },
      { cle: 'criticiteCode', label: 'Criticité', liste: 'criticites', aligner: 'centre' },
      { cle: 'secteurChemin', label: 'Secteur', rendu: (e) => { const s = ui.secteur(e.secteurId); return s ? frag(ui.pastille(s.couleur), e.secteurChemin || s.nom) : el('span', { class: 'texte-2' }, '—'); }, valeurTri: (e) => e.secteurChemin || '' },
      { cle: 'localisation', label: 'Localisation', rendu: (e) => el('span', { class: 'texte-petit' }, e.localisation || '') },
      { cle: 'compteur', label: 'Compteur', aligner: 'droite', rendu: (e) => (e.compteur && e.compteur.valeur ? formatCompteur(e.compteur) : el('span', { class: 'texte-2' }, '—')), valeurTri: (e) => (e.compteur ? Number(e.compteur.valeur) || 0 : 0) },
      { cle: 'nbOtOuverts', label: 'OT ouverts', aligner: 'centre', rendu: (e) => (e.nbOtOuverts ? ui.badge(String(e.nbOtOuverts), '#f59e0b') : el('span', { class: 'texte-2' }, '0')), valeurTri: (e) => e.nbOtOuverts || 0 },
    ];
    const tableau = ui.table({
      colonnes, lignes: [], recherche: 'Rechercher (numéro, désignation, marque, n° de série…)', rechercheDans: (e) => [e.numeroSerie, e.description, e.notes, e.parentNumero].filter(Boolean).join(' '),
      onClic: (e) => GMAO.navigate('#/equipements/' + e.id), ligneClasse: (e) => (e.actif === false ? 'inactif' : ''), triInitial: { cle: 'numero', sens: 'asc' }, vide: 'Aucun équipement ne correspond aux filtres',
      actions: [
        { icone: 'voir', titre: 'Ouvrir la fiche', onClic: (e) => GMAO.navigate('#/equipements/' + e.id) },
        { icone: 'modifier', titre: 'Modifier', visible: () => can('modifier'), onClic: (e) => ouvrirFormulaire(e, { apres: () => charger(true) }) },
        { icone: 'copier', titre: 'Dupliquer', visible: () => can('creer'), onClic: (e) => dupliquer(e) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: () => can('supprimer'), onClic: (e) => supprimer(e, () => charger(true)) },
      ],
    });

    async function charger(avecArbre) {
      try {
        let rows = await api.get('/api/equipements', paramsApi());
        if (filtres.secteurId === 'aucun') rows = rows.filter((e) => e.secteurId == null);
        toutes = rows;
        majKpis();
        tableau.maj(filtres.etatCode ? rows.filter((e) => e.etatCode === filtres.etatCode) : rows);
        if (location.hash.split('?')[0].replace(/\/$/, '') === '#/equipements') history.replaceState(null, '', '#/equipements' + qsCourant());
        if (arbre) { arbre.selectionner(filtres.secteurId ? `secteur:${filtres.secteurId === 'aucun' ? 0 : filtres.secteurId}` : null); if (avecArbre) arbre.recharger(); }
      } catch (e) { erreur(e); }
    }

    zone.appendChild(kpis);
    zone.appendChild(el('div', { class: 'barre-outils' }, selSecteur, selType, selEtat, selCrit, el('label', { class: 'inline' }, cbPrincipaux, 'Équipements principaux uniquement'), el('label', { class: 'inline' }, cbInactifs, 'Inclure les inactifs'), btnReinit));
    zone.appendChild(tableau.el);
    await charger(false);
    if (query.nouveau === '1' && can('creer')) ouvrirFormulaire(null, { secteurId: secteurFiltre() });
  }

  // ----- Fiche ------------------------------------------------------------
  function cheminHierarchique(e) {
    const parts = [];
    if (e.secteurId != null) parts.push(lienVue('#/equipements?secteurId=' + e.secteurId, e.secteurChemin || ui.nomSecteur(e.secteurId)));
    for (const a of e.chemin || []) parts.push(lienVue('#/equipements/' + a.id, `${a.numero} · ${a.nom}`));
    parts.push(el('strong', null, e.nom));
    return el('span', null, parts.flatMap((p, i) => (i ? [' › ', p] : [p])));
  }

  function rendreInfos(e) {
    const cont = el('div');
    const photo = e.photoIndex >= 0 ? el('a', { href: urlDocument(e.id, e.photoIndex), target: '_blank', rel: 'noopener', title: 'Ouvrir la photo' }, el('img', { src: urlDocument(e.id, e.photoIndex), alt: e.nom, style: { width: '100%', maxWidth: '260px', borderRadius: '8px', border: '1px solid var(--bordure)', display: 'block', background: 'var(--surface)' } })) : null;
    const items = [
      { label: 'Numéro', valeur: el('code', null, e.numero) },
      { label: 'Désignation', valeur: e.nom },
      { label: 'Type', valeur: ui.badgeListe('typesEquipement', e.typeCode) },
      { label: 'État', valeur: ui.badgeListe('etatsEquipement', e.etatCode) },
      { label: 'Criticité', valeur: ui.badgeListe('criticites', e.criticiteCode) },
      { label: 'Statut', valeur: e.actif === false ? ui.badge('Désactivé', '#6b7280') : ui.badge('Actif', '#16a34a') },
      { label: 'Secteur', valeur: e.secteurId != null ? lienVue('#/equipements?secteurId=' + e.secteurId, frag(ui.pastille((ui.secteur(e.secteurId) || {}).couleur), e.secteurChemin || ui.nomSecteur(e.secteurId))) : '' },
      { label: 'Équipement parent', valeur: e.parent ? lienVue('#/equipements/' + e.parent.id, `${e.parent.numero} · ${e.parent.nom}`) : '' },
      { label: 'Chemin hiérarchique', valeur: cheminHierarchique(e) },
      { label: 'Localisation', valeur: e.localisation },
      { label: 'Marque', valeur: e.marque },
      { label: 'Modèle', valeur: e.modele },
      { label: 'Numéro de série', valeur: e.numeroSerie },
      { label: 'Fournisseur', valeur: e.fournisseur ? lienVue('#/fournisseurs/' + e.fournisseur.id, e.fournisseur.nom) : '' },
      { label: 'Date d\'achat', valeur: ui.formatDate(e.dateAchat) },
      { label: 'Mise en service', valeur: ui.formatDate(e.dateMiseEnService) },
      { label: 'Valeur d\'achat', valeur: e.valeurAchat != null ? ui.formatMontant(e.valeurAchat) : '' },
      { label: 'Garantie', valeur: e.garantieFin ? frag(ui.formatDate(e.garantieFin), ' ', e.garantie === 'expiree' ? ui.badge('Expirée', '#6b7280') : ui.badge('Sous garantie', '#16a34a')) : '' },
      { label: 'Compteur', valeur: e.compteur ? frag(formatCompteur(e.compteur), e.dernierReleve ? el('span', { class: 'texte-2 texte-petit' }, ` (relevé ${ui.relatif(e.dernierReleve)})`) : null) : '' },
      { label: 'Créé', valeur: `${ui.formatDateHeure(e.createdAt)}${e.createdByNom ? ' par ' + e.createdByNom : ''}` },
      { label: 'Dernière modification', valeur: ui.formatDateHeure(e.updatedAt) },
      ...ui.champsPersoAffichage(MODULE, e),
    ];
    const details = ui.details(items, { colonnes: 2 });
    cont.appendChild(el('div', { class: 'carte' }, photo ? el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(160px, 260px) minmax(0, 1fr)', gap: '20px', alignItems: 'start' } }, photo, details) : details));
    if (e.description) cont.appendChild(ui.carte('Description', el('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, e.description)));
    if (e.notes) cont.appendChild(ui.carte('Notes de maintenance', el('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, e.notes)));

    const enfants = e.enfants || [];
    cont.appendChild(ui.carte(`Sous-équipements (${enfants.length})`,
      enfants.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: enfants, onClic: (x) => GMAO.navigate('#/equipements/' + x.id),
        ligneClasse: (x) => (x.actif === false ? 'inactif' : ''),
        colonnes: [
          { cle: 'numero', label: 'Numéro', rendu: (x) => el('span', { class: 'cellule-principale' }, x.numero) },
          { cle: 'nom', label: 'Désignation' },
          { cle: 'typeCode', label: 'Type', liste: 'typesEquipement' },
          { cle: 'etatCode', label: 'État', liste: 'etatsEquipement' },
          { cle: 'criticiteCode', label: 'Criticité', liste: 'criticites', aligner: 'centre' },
          { cle: 'nbEnfants', label: 'Sous-éq.', aligner: 'centre', rendu: (x) => (x.nbEnfants ? String(x.nbEnfants) : el('span', { class: 'texte-2' }, '—')) },
        ],
      }).el : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucun sous-équipement rattaché.'),
      { actions: can('creer') ? ui.bouton('Ajouter un sous-équipement', { icone: 'plus', classe: 'btn-sm', onClic: () => ouvrirFormulaire(null, { parentId: e.id, secteurId: e.secteurId }) }) : null }));

    if ((e.historiqueEtats || []).length) {
      cont.appendChild(ui.carte('Historique des états', el('ul', { class: 'chronologie' }, e.historiqueEtats.map((h) => el('li', null,
        el('div', null, ui.badgeListe('etatsEquipement', h.ancien), ' → ', ui.badgeListe('etatsEquipement', h.nouveau), h.commentaire ? el('span', null, ' — ', h.commentaire) : null),
        el('div', { class: 'chrono-date' }, `${ui.formatDateHeure(h.date)}${h.userNom ? ' · ' + h.userNom : ''}`))))));
    }
    return cont;
  }

  function rendreInterventions(e) {
    const cont = el('div');
    const ot = e.derniersOt || [];
    if (GMAO.can('ot', 'voir')) cont.appendChild(ui.carte(`Ordres de travail (${e.nbOtTotal || 0}${e.nbOtOuverts ? `, dont ${e.nbOtOuverts} ouvert(s)` : ''})`,
      ot.length ? frag(ui.table({
        compact: true, recherche: false, pagination: false, lignes: ot, onClic: (o) => GMAO.navigate('#/ot/' + o.id),
        colonnes: [
          { cle: 'numero', label: 'N°', rendu: (o) => lienVue('#/ot/' + o.id, o.numero || ('#' + o.id)) },
          { cle: 'titre', label: 'Titre', rendu: (o) => el('span', { class: 'cellule-principale' }, o.titre) },
          { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
          { cle: 'prioriteCode', label: 'Priorité', liste: 'priorites' },
          { cle: 'statut', label: 'Statut', liste: 'statutsOT' },
          { cle: 'technicienId', label: 'Technicien', type: 'user' },
          { cle: 'datePrevue', label: 'Prévu le', type: 'date' },
          { cle: 'dateFin', label: 'Terminé le', type: 'date' },
        ],
      }).el, (e.nbOtTotal || 0) > ot.length ? el('p', { class: 'texte-2 texte-petit mt', style: { marginBottom: 0 } }, `Les ${ot.length} derniers ordres de travail sont affichés.`) : null)
        : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucun ordre de travail pour cet équipement.'),
      { actions: frag(
        GMAO.can('ot', 'voir') && (e.nbOtTotal || 0) > ot.length ? ui.bouton('Tout l\'historique', { icone: 'liste', classe: 'btn-sm', onClic: () => GMAO.navigate('#/ot?equipementId=' + e.id) }) : null,
        GMAO.can('ot', 'creer') ? ui.bouton('Nouvel OT', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => GMAO.navigate(`#/ot?nouveau=1&equipementId=${e.id}`) }) : null) }));

    const demandes = e.demandes || [];
    if (GMAO.can('demandes', 'voir')) cont.appendChild(ui.carte(`Demandes d'intervention (${e.nbDemandesTotal || 0}${e.nbDemandesOuvertes ? `, dont ${e.nbDemandesOuvertes} en cours` : ''})`,
      demandes.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: demandes, onClic: (d) => GMAO.navigate('#/demandes/' + d.id),
        colonnes: [
          { cle: 'numero', label: 'N°', rendu: (d) => lienVue('#/demandes/' + d.id, d.numero || ('#' + d.id)) },
          { cle: 'titre', label: 'Titre', rendu: (d) => frag(el('span', { class: 'cellule-principale' }, d.titre), d.arretProduction ? frag(' ', ui.badge('Arrêt de production', '#dc2626')) : null) },
          { cle: 'prioriteCode', label: 'Priorité', liste: 'priorites' },
          { cle: 'statut', label: 'Statut', liste: 'statutsDemande' },
          { cle: 'demandeurId', label: 'Demandeur', type: 'user' },
          { cle: 'dateDemande', label: 'Date', type: 'date' },
          { cle: 'otId', label: 'OT', rendu: (d) => (d.otId ? lienVue('#/ot/' + d.otId, 'OT #' + d.otId) : el('span', { class: 'texte-2' }, '—')) },
        ],
      }).el : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucune demande d\'intervention pour cet équipement.'),
      { actions: GMAO.can('demandes', 'creer') ? ui.bouton('Nouvelle demande', { icone: 'plus', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/demandes?nouveau=1&equipementId=${e.id}`) }) : null }));
    return cont;
  }

  function rendrePreventif(e) {
    const cont = el('div');
    const plans = e.plansPreventifs || [];
    const unite = (e.compteur || {}).unite || '';
    const aujourdhui = ui.aujourdhui();
    cont.appendChild(ui.carte(`Plans de maintenance préventive (${plans.length})`,
      plans.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: plans, onClic: (p) => GMAO.navigate('#/preventif/' + p.id), ligneClasse: (p) => (p.actif === false ? 'inactif' : ''),
        colonnes: [
          { cle: 'numero', label: 'N°', rendu: (p) => lienVue('#/preventif/' + p.id, p.numero || ('#' + p.id)) },
          { cle: 'nom', label: 'Plan', rendu: (p) => el('span', { class: 'cellule-principale' }, p.nom) },
          { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
          { cle: 'periodicite', label: 'Périodicité', rendu: (p) => periodiciteLisible(p.periodicite, unite) },
          { cle: 'derniereExecution', label: 'Dernière exécution', rendu: (p) => echeanceLisible(p.derniereExecution, p.periodicite, unite) },
          { cle: 'prochaineEcheance', label: 'Prochaine échéance', rendu: (p) => {
            const v = p.prochaineEcheance;
            if (v == null || v === '') return el('span', { class: 'texte-2' }, '—');
            const surCompteur = p.periodicite && p.periodicite.type === 'compteur';
            const retard = surCompteur ? (e.compteur && Number(e.compteur.valeur) >= Number(v)) : String(v).slice(0, 10) < aujourdhui;
            return el('span', { class: retard && p.actif !== false ? 'texte-danger texte-gras' : '' }, echeanceLisible(v, p.periodicite, unite), retard && p.actif !== false ? ' (échue)' : '');
          } },
          { cle: 'technicienId', label: 'Technicien', type: 'user' },
          { cle: 'dureeEstimee', label: 'Durée', rendu: (p) => ui.formatDuree(p.dureeEstimee) },
          { cle: 'actif', label: 'Actif', aligner: 'centre', rendu: (p) => (p.actif === false ? ui.badge('Inactif', '#6b7280') : ui.badge('Actif', '#16a34a')) },
        ],
      }).el : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucun plan préventif associé à cet équipement.'),
      { actions: GMAO.can('preventif', 'creer') ? ui.bouton('Nouveau plan', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => GMAO.navigate(`#/preventif?nouveau=1&equipementId=${e.id}`) }) : null }));
    cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Les plans périodiques génèrent automatiquement des ordres de travail à l\'échéance (par date ou par valeur de compteur).'));
    return cont;
  }

  function rendreDocuments(e, recharger) {
    const cont = el('div');
    const docs = e.documents || [];
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${docs.length} document(s) · 5 Mo maximum par fichier · images et PDF consultables directement`),
      el('span', { class: 'espace' }),
      can('modifier') ? ui.bouton('Ajouter un document', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirAjoutDocument(e, recharger) }) : null));
    if (!docs.length) { cont.appendChild(ui.vide('Aucun document joint (photos, notices, schémas, certificats…)', 'piece_jointe')); return cont; }
    const grille = el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } });
    for (const d of docs) {
      const url = urlDocument(e.id, d.index);
      grille.appendChild(el('div', { class: 'carte', style: { marginBottom: 0, padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        d.estImage
          ? el('a', { href: url, target: '_blank', rel: 'noopener', title: 'Ouvrir l\'image' }, el('img', { src: url, alt: d.nom, style: { width: '100%', height: '140px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--bordure)', display: 'block' } }))
          : el('div', { style: { height: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--fond)', borderRadius: '6px', color: 'var(--texte-2)' } }, el('div', { style: { textAlign: 'center' } }, iconeDim('piece_jointe', 32), el('div', { class: 'texte-petit texte-gras' }, typeDocLisible(d.type)))),
        el('div', { class: 'texte-gras', style: { wordBreak: 'break-word' }, title: d.nom }, d.nom),
        el('div', { class: 'texte-2 texte-petit' }, `${tailleLisible(d.taille)} · ${ui.formatDate(d.date)}${d.userNom ? ' · ' + d.userNom : ''}`),
        d.description ? el('div', { class: 'texte-petit' }, d.description) : null,
        el('div', { class: 'inline', style: { marginTop: 'auto', gap: '4px', flexWrap: 'wrap' } },
          el('a', { class: 'btn btn-sm', href: url, target: '_blank', rel: 'noopener', title: 'Ouvrir dans un nouvel onglet' }, icone('voir'), 'Ouvrir'),
          el('button', { class: 'btn btn-sm', type: 'button', title: 'Télécharger', onclick: () => api.telecharger(urlDocument(e.id, d.index, true), d.nom).catch(erreur) }, icone('export'), 'Télécharger'),
          can('modifier') ? el('button', { class: 'btn btn-sm btn-icone texte-danger', type: 'button', title: 'Supprimer', style: { marginLeft: 'auto' }, onclick: async () => {
            if (!(await ui.confirm({ titre: 'Supprimer le document', message: `Supprimer « ${d.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
            try { await api.del(`/api/equipements/${e.id}/documents/${d.index}`); toast('Document supprimé', 'succes'); recharger(); } catch (err) { erreur(err); }
          } }, icone('supprimer')) : null)));
    }
    cont.appendChild(grille);
    return cont;
  }

  function rendrePieces(e) {
    const cont = el('div');
    const articles = e.articlesCompatibles || [];
    cont.appendChild(ui.carte(`Pièces compatibles (${articles.length})`,
      articles.length ? ui.table({
        compact: true, recherche: articles.length > 8 ? 'Rechercher une pièce…' : false, pagination: false, lignes: articles, onClic: (a) => GMAO.navigate('#/stock/' + a.id), ligneClasse: (a) => (a.actif === false ? 'inactif' : ''),
        colonnes: [
          { cle: 'code', label: 'Code', rendu: (a) => lienVue('#/stock/' + a.id, a.code || ('#' + a.id)) },
          { cle: 'designation', label: 'Désignation', rendu: (a) => el('span', { class: 'cellule-principale' }, a.designation) },
          { cle: 'categorieCode', label: 'Catégorie', liste: 'categoriesArticles' },
          { cle: 'quantite', label: 'En stock', aligner: 'droite', rendu: (a) => `${ui.formatNombre(a.quantite)} ${ui.libelle('unites', a.uniteCode) !== String(a.uniteCode || '') ? ui.libelle('unites', a.uniteCode) : (a.uniteCode || '')}`.trim() },
          { cle: 'seuilMin', label: 'Seuil mini', aligner: 'droite', type: 'nombre' },
          { cle: 'emplacement', label: 'Emplacement' },
          { cle: 'prixUnitaire', label: 'Prix unitaire', aligner: 'droite', type: 'montant' },
          { cle: 'alerte', label: 'Disponibilité', aligner: 'centre', rendu: (a) => (Number(a.quantite) <= 0 ? ui.badge('Rupture', '#dc2626') : (a.seuilMin != null && Number(a.quantite) <= Number(a.seuilMin) ? ui.badge('Sous le seuil', '#f59e0b') : ui.badge('Disponible', '#16a34a'))) },
        ],
      }).el : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucune pièce de rechange n\'est déclarée compatible avec cet équipement.'),
      { actions: GMAO.can('stock', 'voir') ? ui.bouton('Ouvrir le stock', { icone: 'stock', classe: 'btn-sm', onClic: () => GMAO.navigate('#/stock?equipementId=' + e.id) }) : null }));
    cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'La compatibilité équipement ↔ pièce se définit sur la fiche de l\'article (module Stock & pièces, champ « Équipements compatibles »).'));
    return cont;
  }

  function rendreCompteur(e, recharger) {
    const cont = el('div');
    const c = e.compteur || { valeur: 0, unite: 'heures' };
    const releves = (e.compteurReleves || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const asc = releves.slice().reverse();
    const premier = asc[0];
    const dernier = asc[asc.length - 1];
    let moyenne = null;
    let jours = 0;
    if (asc.length >= 2) { jours = ui.joursEntre(premier.date, dernier.date); if (jours > 0) moyenne = (Number(dernier.valeur) - Number(premier.valeur)) / jours; }
    cont.appendChild(el('div', { class: 'grille grille-auto', style: { gap: '12px', marginBottom: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } },
      ui.kpi({ label: `Valeur actuelle (${c.unite})`, valeur: ui.formatNombre(c.valeur), icone: 'horloge' }),
      ui.kpi({ label: 'Dernier relevé', valeur: dernier ? ui.formatDate(dernier.date) : '—', detail: dernier ? `par ${dernier.userNom || '—'}` : 'aucun relevé', icone: 'check', couleur: '#16a34a' }),
      ui.kpi({ label: 'Relevés enregistrés', valeur: releves.length, icone: 'liste', couleur: '#8b5cf6' }),
      ui.kpi({ label: 'Moyenne par jour', valeur: moyenne != null ? ui.formatNombre(moyenne, 1) : '—', detail: moyenne != null ? `${c.unite}/jour sur ${jours} jour(s)` : 'au moins deux relevés requis', icone: 'rapports', couleur: '#f59e0b' })));
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, 'Chaque relevé est historisé ; la valeur courante est celle du relevé le plus récent. Les plans préventifs « par compteur » s\'appuient sur cette valeur.'),
      el('span', { class: 'espace' }),
      can('modifier') ? ui.bouton('Nouveau relevé', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirReleve(e, recharger) }) : null));
    if (asc.length >= 2) cont.appendChild(ui.carte('Évolution (12 derniers relevés)', ui.graphiqueBarres(asc.slice(-12).map((r) => ({ label: ui.formatDate(r.date), valeur: Number(r.valeur) || 0 })), { hauteur: 180 })));
    const lignes = releves.map((r, i) => Object.assign({}, r, { ecart: releves[i + 1] ? Number(r.valeur) - Number(releves[i + 1].valeur) : null }));
    cont.appendChild(ui.table({
      compact: true, recherche: false, lignes, vide: 'Aucun relevé enregistré', triInitial: { cle: 'date', sens: 'desc' },
      colonnes: [
        { cle: 'date', label: 'Date', type: 'datetime' },
        { cle: 'valeur', label: `Valeur (${c.unite})`, aligner: 'droite', rendu: (r) => el('span', { class: 'texte-gras' }, ui.formatNombre(r.valeur)) },
        { cle: 'ecart', label: 'Écart', aligner: 'droite', rendu: (r) => (r.ecart == null ? el('span', { class: 'texte-2' }, '—') : el('span', { class: r.ecart < 0 ? 'texte-danger' : 'texte-2' }, (r.ecart > 0 ? '+' : '') + ui.formatNombre(r.ecart))) },
        { cle: 'userNom', label: 'Relevé par' },
        { cle: 'commentaire', label: 'Commentaire' },
        { cle: 'otId', label: 'OT', rendu: (r) => (r.otId ? lienVue('#/ot/' + r.otId, 'OT #' + r.otId) : el('span', { class: 'texte-2' }, '—')) },
      ],
    }).el);
    return cont;
  }

  async function afficherFiche(entete, zone, id) {
    let e;
    try { e = await api.get('/api/equipements/' + id); } catch (err) {
      entete.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'equipements', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/equipements' }, { label: 'Fiche' }] }));
      zone.appendChild(ui.vide(err.status === 404 ? 'Équipement introuvable ou hors de votre portée.' : err.message, 'alerte'));
      zone.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour à la liste', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/equipements') })));
      return;
    }
    const recharger = () => GMAO.navigate(location.hash.split('?')[0] === '#/equipements/' + e.id ? location.hash : '#/equipements/' + e.id);
    const filAriane = [{ label: GMAO.moduleLabel(MODULE), href: '#/equipements' }];
    if (e.secteurId != null) filAriane.push({ label: e.secteurChemin || ui.nomSecteur(e.secteurId), href: '#/equipements?secteurId=' + e.secteurId });
    (e.chemin || []).forEach((a) => filAriane.push({ label: a.nom, href: '#/equipements/' + a.id }));
    filAriane.push({ label: e.nom });

    entete.appendChild(ui.pageEntete({
      titre: frag(e.nom, ui.badgeListe('etatsEquipement', e.etatCode), ui.badgeListe('criticites', e.criticiteCode), e.actif === false ? ui.badge('Désactivé', '#6b7280') : null),
      icone: 'equipements', filAriane,
      sousTitre: [e.numero, ui.libelle('typesEquipement', e.typeCode), [e.marque, e.modele].filter(Boolean).join(' '), e.localisation].filter(Boolean).join(' · '),
      actions: [
        GMAO.can('demandes', 'creer') ? ui.bouton('Nouvelle demande', { icone: 'demandes', onClic: () => GMAO.navigate(`#/demandes?nouveau=1&equipementId=${e.id}`) }) : null,
        GMAO.can('ot', 'creer') ? ui.bouton('Nouvel OT', { icone: 'ot', onClic: () => GMAO.navigate(`#/ot?nouveau=1&equipementId=${e.id}`) }) : null,
        can('modifier') ? ui.bouton('Changer l\'état', { icone: 'rafraichir', onClic: () => ouvrirChangementEtat(e, recharger) }) : null,
        can('modifier') ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(e, { apres: recharger }) }) : null,
      ],
    }));

    zone.appendChild(el('div', { class: 'barre-outils' },
      can('creer') ? ui.bouton('Ajouter un sous-équipement', { icone: 'plus', classe: 'btn-sm', onClic: () => ouvrirFormulaire(null, { parentId: e.id, secteurId: e.secteurId }) }) : null,
      can('creer') ? ui.bouton('Dupliquer', { icone: 'copier', classe: 'btn-sm', onClic: () => dupliquer(e) }) : null,
      ui.bouton('Imprimer la fiche', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerFiche(e) }),
      el('span', { class: 'espace' }),
      can('supprimer') ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: () => supprimer(e, (r) => (r.desactive ? recharger() : GMAO.navigate('#/equipements'))) }) : null));

    if (e.actif === false) zone.appendChild(ui.alerte('Cet équipement est désactivé (archivé) : il est conservé pour l\'historique mais n\'apparaît plus dans les listes par défaut.', 'alerte'));
    if (e.nbOtOuverts && GMAO.can('ot', 'voir')) zone.appendChild(ui.alerte(frag(`${e.nbOtOuverts} ordre(s) de travail ouvert(s) sur cet équipement. `, lienVue('#/ot?equipementId=' + e.id, 'Voir les interventions')), 'info'));

    // Onglets des autres modules : affichés seulement avec le droit de consultation correspondant
    zone.appendChild(ui.onglets([
      { cle: 'infos', label: 'Informations', icone: 'info', rendu: () => rendreInfos(e) },
      GMAO.can('ot', 'voir') || GMAO.can('demandes', 'voir') ? { cle: 'interventions', label: 'Interventions', icone: 'ot', badge: (e.nbOtOuverts || 0) || null, rendu: () => rendreInterventions(e) } : null,
      GMAO.can('preventif', 'voir') ? { cle: 'preventif', label: 'Préventif', icone: 'preventif', badge: (e.plansPreventifs || []).length || null, rendu: () => rendrePreventif(e) } : null,
      { cle: 'documents', label: 'Documents', icone: 'piece_jointe', badge: (e.documents || []).length || null, rendu: () => rendreDocuments(e, recharger) },
      GMAO.can('stock', 'voir') ? { cle: 'pieces', label: 'Pièces compatibles', icone: 'piece', badge: (e.articlesCompatibles || []).length || null, rendu: () => rendrePieces(e) } : null,
      { cle: 'compteur', label: 'Compteur', icone: 'horloge', rendu: () => rendreCompteur(e, recharger) },
    ].filter(Boolean), { hash: true }).el);
  }

  // ----- Vue --------------------------------------------------------------
  GMAO.registerView(MODULE, {
    titre: 'Équipements', icone: 'equipements',
    async rendu(container, { params, query }) {
      const id = params[0] ? Number(params[0]) : null;
      if (params[0] && !Number.isInteger(id)) { container.appendChild(ui.vide('Équipement introuvable', 'alerte')); return; }
      const entete = el('div');
      const colonneArbre = el('div', { class: 'carte', style: { padding: '12px', position: 'sticky', top: '0', maxHeight: 'calc(100vh - 100px)', overflow: 'auto' } });
      const zone = el('div', { style: { minWidth: 0 } });
      const etroit = window.innerWidth < 1000;
      container.appendChild(entete);
      container.appendChild(etroit
        ? el('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '16px' } }, zone, colonneArbre)
        : el('div', { style: { display: 'grid', gridTemplateColumns: '290px minmax(0, 1fr)', gap: '16px', alignItems: 'start' } }, colonneArbre, zone));
      const selection = id ? `equipement:${id}` : (query.secteurId ? `secteur:${query.secteurId === 'aucun' ? 0 : query.secteurId}` : null);
      const arbre = rendreArbre(colonneArbre, selection);
      if (id) await afficherFiche(entete, zone, id); else await afficherListe(entete, zone, query, arbre);
    },
  });
})();
