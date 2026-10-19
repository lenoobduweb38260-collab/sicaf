/**
 * Vue Stock & pièces détachées.
 *   #/stock            onglets Articles · Mouvements · Alertes · Valorisation
 *   #/stock/:id        fiche article (détails, entrée / sortie / inventaire, mouvements, consommation par OT, équipements)
 * Paramètres reconnus sur #/stock : categorieCode, fournisseurId, equipementId, secteurId, sousSeuil=1, recherche,
 * articleId / otId / type (journal des mouvements), onglet.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'stock';
  const can = (action) => GMAO.can(MODULE, action);

  /** Types de mouvement : codes techniques fixes du contrat de données (non configurables). */
  const TYPES = {
    entree: { label: 'Entrée', couleur: '#16a34a', icone: 'export', enregistre: 'Entrée enregistrée' },
    sortie: { label: 'Sortie', couleur: '#ea580c', icone: 'import', enregistre: 'Sortie enregistrée' },
    inventaire: { label: 'Inventaire', couleur: '#2563eb', icone: 'liste', enregistre: 'Inventaire enregistré' },
    retour: { label: 'Retour', couleur: '#8b5cf6', icone: 'rafraichir', enregistre: 'Retour enregistré' },
  };
  const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#0891b2', '#dc2626', '#db2777', '#65a30d', '#6b7280'];
  const ROUGE = '#dc2626';
  const ORANGE = '#f59e0b';
  const VERT = '#16a34a';

  // ----- Utilitaires d'affichage ----------------------------------------------------------
  function lienVue(href, label) { return el('a', { href, onclick: (ev) => ev.stopPropagation(), style: { whiteSpace: 'nowrap' } }, label); }
  /** Colonne OT d'un mouvement : lien vers l'OT, ou mention neutre quand l'OT est hors de la portée du lecteur. */
  function celluleOt(m) {
    if (m.otMasque) return el('span', { class: 'texte-2', title: 'Ordre de travail hors de votre périmètre' }, 'Hors périmètre');
    return m.otId ? lienVue('#/ot/' + m.otId, m.otNumero || 'OT #' + m.otId) : el('span', { class: 'texte-2' }, '—');
  }
  /** Contenu sans retour à la ligne (montants, dates, numéros). */
  const nowrap = (x, style) => el('span', { style: Object.assign({ whiteSpace: 'nowrap' }, style || {}) }, x);
  /** Texte tronqué sur une ligne avec infobulle. */
  const tronque = (texte, largeur, classe) => el('div', { class: classe || null, title: texte || '', style: { maxWidth: largeur, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, texte || '');
  const colMontant = (cle, label, extra) => Object.assign({ cle, label, aligner: 'droite', rendu: (r) => nowrap(ui.formatMontant(r[cle] || 0)), valeurTri: (r) => Number(r[cle]) || 0 }, extra || {});
  const colDate = (cle, label, avecHeure) => ({ cle, label, rendu: (r) => nowrap(avecHeure ? ui.formatDateHeure(r[cle]) : ui.formatDate(r[cle])), valeurTri: (r) => r[cle] || '' });
  const colDate2 = (cle, label) => ({ cle, label, rendu: (r) => el('div', null, nowrap(ui.formatDate(r[cle])), el('div', { class: 'cellule-secondaire' }, ui.formatHeure(r[cle]))), valeurTri: (r) => r[cle] || '' });
  const colCode = (cle = 'code') => ({ cle, label: 'Code', rendu: (a) => nowrap(a[cle], { fontWeight: '600' }), valeurTri: (a) => String(a[cle] || '').toLowerCase() });
  /** Quantité + code d'unité, ex. « 12 u », « 57,5 l ». */
  function qte(n, uniteCode) { return `${ui.formatNombre(n == null ? 0 : n)}${uniteCode ? ' ' + uniteCode : ''}`; }
  function libUnite(code) { return code ? ui.libelle('unites', code) : ''; }
  function badgeType(type) { const t = TYPES[type]; return t ? ui.badge(t.label, t.couleur) : ui.badge(type || '?'); }
  function badgeDispo(a) {
    if (a.actif === false) return ui.badge('Désactivé', '#6b7280');
    if (Number(a.quantite) <= 0) return ui.badge('Rupture', ROUGE);
    if (a.sousSeuil) return ui.badge('Sous le seuil', ORANGE);
    return ui.badge('Disponible', VERT);
  }
  function quantiteCellule(a) {
    const sous = a.actif !== false && a.sousSeuil;
    return el('div', { title: `Seuil minimum : ${qte(a.seuilMin, a.uniteCode)}` },
      sous ? ui.badge(ui.formatNombre(a.quantite), ROUGE) : el('span', { class: 'texte-gras' }, ui.formatNombre(a.quantite)),
      el('div', { class: 'cellule-secondaire' }, `min. ${ui.formatNombre(a.seuilMin)}`));
  }
  function mouvementSigne(m) {
    if (m.type === 'inventaire') {
      const e = Number(m.ecart) || 0;
      return el('span', { title: 'Quantité constatée lors de l\'inventaire' }, '= ', el('span', { class: 'texte-gras' }, ui.formatNombre(m.quantite)),
        el('span', { class: 'texte-petit ' + (e < 0 ? 'texte-danger' : e > 0 ? 'texte-ok' : 'texte-2') }, ` (${e > 0 ? '+' : ''}${ui.formatNombre(e)})`));
    }
    const plus = m.type === 'entree' || m.type === 'retour';
    return el('span', { class: 'texte-gras ' + (plus ? 'texte-ok' : 'texte-danger') }, `${plus ? '+' : '−'}${ui.formatNombre(m.quantite)}`);
  }
  function nomMois(cle) {
    const [a, m] = String(cle).split('-').map(Number);
    if (!a || !m) return cle;
    return new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  }
  function exempleCode() {
    const g = ((GMAO.config || {}).numerotation || {}).art || 'ART-{num:4}';
    const d = new Date();
    return g.replace(/\{annee\}/g, d.getFullYear()).replace(/\{aa\}/g, String(d.getFullYear()).slice(2)).replace(/\{mois\}/g, String(d.getMonth() + 1).padStart(2, '0')).replace(/\{num(?::(\d+))?\}/g, (x, w) => '1'.padStart(Number(w || 1), '0'));
  }
  function couleurCategorie(code, i) {
    if (!code) return '#9ca3af';
    const it = ui.itemListe('categoriesArticles', code);
    return (it && it.couleur) || PALETTE[i % PALETTE.length];
  }
  const esc = ui.esc;

  // ----- Badge de navigation (articles sous le seuil) ---------------------------------------
  let dernierBadge = { t: 0, user: null };
  async function majBadge(force) {
    if (!GMAO.user || !GMAO.can(MODULE, 'voir')) return;
    const maintenant = Date.now();
    if (!force && dernierBadge.user === GMAO.user.id && maintenant - dernierBadge.t < 60000) return;
    dernierBadge = { t: maintenant, user: GMAO.user.id };
    try { const rows = await api.get('/api/stock-alertes', null, { silent401: true }); GMAO.setNavBadge(MODULE, rows.length); } catch (e) { /* silencieux */ }
  }
  window.addEventListener('hashchange', () => majBadge(false));
  setInterval(() => majBadge(false), 5 * 60 * 1000);
  (function attendreConnexion() { if (GMAO.user) majBadge(true); else setTimeout(attendreConnexion, 1500); })();

  // ----- Références des formulaires ---------------------------------------------------------
  let cacheRefs = null;
  async function references(force) {
    if (!cacheRefs || force) {
      try { cacheRefs = await api.get('/api/stock-references'); } catch (e) { cacheRefs = { fournisseurs: [], equipements: [], otOuverts: [], emplacements: [], stockNegatif: false }; }
    }
    return cacheRefs;
  }
  /** Équipements pour la compatibilité : GET /api/equipements si disponible, sinon références du stock. */
  async function listeEquipements() {
    if (GMAO.can('equipements', 'voir')) {
      try { const rows = await api.get('/api/equipements'); if (Array.isArray(rows)) return rows; } catch (e) { /* repli */ }
    }
    return (await references()).equipements || [];
  }
  function optionsFournisseurs(refs, courant, vide) {
    const opts = (refs.fournisseurs || []).filter((f) => f.actif !== false || Number(f.id) === Number(courant)).map((f) => ({ value: f.id, label: f.nom + (f.actif === false ? ' (inactif)' : '') }));
    if (vide !== false) opts.unshift({ value: '', label: vide || '— Aucun —' });
    return opts;
  }

  // ----- Formulaire article ----------------------------------------------------------------
  async function ouvrirFormulaire(existant, { apres, copie } = {}) {
    const [refs, equipements] = await Promise.all([references(true), listeEquipements()]);
    const creation = !existant || !!copie;
    const source = existant || {};
    const selection = (source.equipementIds || []).map(Number);
    const optionsEq = equipements
      .filter((e) => e.actif !== false || selection.includes(Number(e.id)))
      .slice().sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr'))
      .map((e) => ({ value: e.id, label: `${e.numero ? e.numero + ' — ' : ''}${e.nom}${e.actif === false ? ' (inactif)' : ''}` }));
    let optionsSect = ui.optionsSecteurs({ vide: '— Magasin central (tous secteurs) —' });
    if (GMAO.perms && GMAO.perms.portee === 'secteurs' && !GMAO.estAdmin()) {
      const miens = (GMAO.perms.secteurIds || []).map(Number);
      optionsSect = optionsSect.filter((o) => o.value === '' || miens.includes(Number(o.value)) || Number(o.value) === Number(source.secteurId));
    }
    const champs = [
      { type: 'separateur', label: 'Identification' },
      { nom: 'code', label: 'Code article', type: 'texte', placeholder: `Automatique (${exempleCode()}…)`, aide: creation ? 'Laissez vide pour une numérotation automatique' : '', maxLength: 50 },
      { nom: 'designation', label: 'Désignation', type: 'texte', requis: true, placeholder: 'ex. Roulement à billes 6205-2RS', maxLength: 200 },
      { nom: 'categorieCode', label: 'Catégorie', type: 'select', options: ui.optionsListe('categoriesArticles', { vide: '— Aucune —' }) },
      { nom: 'uniteCode', label: 'Unité de gestion', type: 'select', requis: true, options: ui.optionsListe('unites', { vide: '— Choisir —' }) },
      { type: 'separateur', label: 'Gestion du stock' },
      creation
        ? { nom: 'quantite', label: 'Quantité initiale en stock', type: 'nombre', min: 0, step: 'any', aide: 'Enregistrée comme un mouvement d\'inventaire' }
        : { nom: 'quantiteLecture', label: 'Quantité en stock', type: 'lecture', valeur: frag(el('span', { class: 'texte-gras' }, qte(source.quantite, source.uniteCode)), el('span', { class: 'texte-2 texte-petit' }, ' — modifiable uniquement par un mouvement (entrée, sortie, inventaire)')) },
      { nom: 'emplacement', label: 'Emplacement', type: 'texte', placeholder: 'ex. Magasin central — A1 — Étagère 2', suggestions: refs.emplacements || [], maxLength: 120 },
      { nom: 'seuilMin', label: 'Seuil minimum', type: 'nombre', min: 0, step: 'any', aide: 'Alerte de réapprovisionnement quand le stock atteint ce seuil (0 : article non suivi, aucune alerte)' },
      { nom: 'quantiteCommande', label: 'Quantité de réapprovisionnement', type: 'nombre', min: 0, step: 'any', aide: 'Quantité habituellement commandée (à commander = max(cette quantité, 2 × seuil − stock))' },
      { nom: 'prixUnitaire', label: `Prix unitaire HT (${((GMAO.config || {}).general || {}).devise || '€'})`, type: 'nombre', min: 0, step: 0.01, aide: 'Mis à jour au coût moyen pondéré lors des réceptions' },
      { nom: 'secteurId', label: 'Magasin / secteur', type: 'select', options: optionsSect, aide: 'Restreint la visibilité de l\'article aux utilisateurs de ce secteur' },
      { type: 'separateur', label: 'Approvisionnement' },
      { nom: 'fournisseurId', label: 'Fournisseur habituel', type: 'select', options: optionsFournisseurs(refs, source.fournisseurId), aide: (refs.fournisseurs || []).length ? '' : 'Aucun fournisseur enregistré' },
      { nom: 'referenceFournisseur', label: 'Référence fournisseur', type: 'texte', placeholder: 'ex. 6205-2RSH', maxLength: 120 },
      { type: 'separateur', label: 'Compatibilité' },
      optionsEq.length
        ? { nom: 'equipementIds', label: 'Équipements compatibles', type: 'multiselect', options: optionsEq, pleineLargeur: true, aide: 'La pièce apparaîtra dans l\'onglet « Pièces compatibles » de ces équipements' }
        : { nom: 'equipementsInfo', label: 'Équipements compatibles', type: 'lecture', valeur: el('span', { class: 'texte-2' }, 'Aucun équipement accessible'), pleineLargeur: true },
      { nom: 'description', label: 'Description / caractéristiques techniques', type: 'texte_long', lignes: 3 },
      !creation ? { nom: 'actif', label: 'Article actif', type: 'booleen', aide: 'Un article désactivé est conservé pour l\'historique mais n\'accepte plus d\'entrée ni de sortie' } : null,
      ...ui.champsPersoDefs('articles'),
    ];
    const unites = GMAO.liste('unites');
    const valeurs = existant
      ? Object.assign({}, existant, { fournisseurId: existant.fournisseurId == null ? '' : existant.fournisseurId, secteurId: existant.secteurId == null ? '' : existant.secteurId, categorieCode: existant.categorieCode || '' }, ui.champsPersoInitiaux(existant))
      : { uniteCode: unites.length ? unites[0].code : '', seuilMin: 0, quantiteCommande: 0, prixUnitaire: 0, quantite: 0, actif: true };
    if (copie) Object.assign(valeurs, { code: '', designation: `${existant.designation} (copie)`, quantite: 0 });
    ui.formModal({
      titre: copie ? `Dupliquer l'article ${existant.code}` : (creation ? 'Nouvel article' : `Modifier l'article ${existant.code}`),
      taille: 'large', champs, valeurs,
      onSubmit: async (v) => {
        const body = Object.assign({}, v, { champs: ui.champsPersoValeurs(v) });
        for (const k of Object.keys(body)) if (k.startsWith('champs.')) delete body[k];
        delete body.quantiteLecture; delete body.equipementsInfo;
        for (const k of ['fournisseurId', 'secteurId', 'categorieCode']) if (body[k] === '') body[k] = null;
        if (!optionsEq.length) delete body.equipementIds;
        if (!creation) delete body.quantite;
        const res = creation ? await api.post('/api/articles', body) : await api.put('/api/articles/' + existant.id, body);
        toast(creation ? `Article ${res.code} créé` : `Article ${res.code} enregistré`, 'succes');
        cacheRefs = null;
        majBadge(true);
        if (apres) apres(res);
      },
    });
  }

  async function supprimer(a, apres) {
    const ok = await ui.confirm({
      titre: 'Supprimer l\'article',
      message: `Supprimer l'article ${a.code} — ${a.designation} ? S'il possède un historique de mouvements ou est référencé par un OT ou un plan préventif, il sera désactivé au lieu d'être supprimé.`,
      okLabel: 'Supprimer', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.del('/api/articles/' + a.id);
      toast(r.desactive ? `Article désactivé (historique conservé : ${r.raisons || 'mouvements'})` : 'Article supprimé', 'succes');
      majBadge(true);
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }

  async function reactiver(a, apres) {
    try {
      const r = await api.put('/api/articles/' + a.id, { actif: true });
      toast('Article réactivé', 'succes');
      majBadge(true);
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }

  // ----- Formulaire de mouvement (entrée / sortie / inventaire) -------------------------------
  /**
   * @param {{ article?, type?, articles?, quantite?, apres? }} o  article fixé (fiche, ligne) ou choix parmi `articles`
   */
  async function ouvrirMouvement({ article, type, articles, quantite, apres } = {}) {
    const refs = await references(true);
    const fixe = !!article;
    const actifs = (articles || []).filter((a) => a.actif !== false).slice().sort((a, b) => String(a.code).localeCompare(String(b.code), 'fr', { numeric: true }));
    const parId = new Map(actifs.map((a) => [Number(a.id), a]));
    if (fixe) parId.set(Number(article.id), article);
    const courant = (v) => (fixe ? article : parId.get(Number(v.articleId)) || null);
    const typeDe = (v) => (v && v.type) || type || 'entree';
    const infoEl = el('div', { class: 'alerte alerte-info', style: { margin: 0 } });
    const ecartEl = el('div', { class: 'texte-petit', style: { minHeight: '18px' } });
    const majInfo = (form) => {
      const v = form ? form.valeurs() : { articleId: article && article.id, type };
      const a = courant(v);
      ui.vider(infoEl);
      if (!a) { infoEl.appendChild(el('span', null, 'Choisissez l\'article concerné.')); return; }
      infoEl.appendChild(frag(
        el('strong', null, `${a.code} — ${a.designation}`), el('br'),
        `Stock actuel : `, el('strong', null, qte(a.quantite, a.uniteCode)), ` · seuil minimum ${qte(a.seuilMin, a.uniteCode)}`,
        a.emplacement ? ` · ${a.emplacement}` : '',
        a.actif !== false && a.sousSeuil ? frag(' · ', el('span', { class: 'texte-danger texte-gras' }, 'sous le seuil')) : null));
      majEcart(form);
    };
    const majEcart = (form) => {
      ui.vider(ecartEl);
      if (!form) return;
      const v = form.valeurs();
      const a = courant(v);
      if (!a || typeDe(v) !== 'inventaire' || v.quantiteConstatee == null || v.quantiteConstatee === '') return;
      const e = Math.round((Number(v.quantiteConstatee) - Number(a.quantite)) * 1000) / 1000;
      ecartEl.appendChild(frag('Écart d\'inventaire : ', el('strong', { class: e < 0 ? 'texte-danger' : e > 0 ? 'texte-ok' : 'texte-2' }, `${e > 0 ? '+' : ''}${qte(e, a.uniteCode)}`), e === 0 ? ' (stock conforme)' : ''));
    };
    const ots = refs.otOuverts || [];
    const champs = [
      fixe ? null : { nom: 'articleId', label: 'Article', type: 'select', requis: true, pleineLargeur: true, options: [{ value: '', label: '— Choisir un article —' }].concat(actifs.map((a) => ({ value: a.id, label: `${a.code} — ${a.designation} (stock : ${qte(a.quantite, a.uniteCode)})` }))), onChange: (x, f) => majInfo(f) },
      fixe ? { nom: 'type', type: 'cache', valeur: type } : { nom: 'type', label: 'Type de mouvement', type: 'radio', requis: true, pleineLargeur: true, options: ['entree', 'sortie', 'inventaire'].map((t) => ({ value: t, label: TYPES[t].label, couleur: TYPES[t].couleur })), onChange: (x, f) => majInfo(f) },
      { type: 'html', rendu: () => infoEl },
      { nom: 'quantite', label: 'Quantité', type: 'nombre', requis: true, min: 0, step: 'any', afficherSi: (v) => typeDe(v) !== 'inventaire',
        valider: (q, v) => {
          if (!(Number(q) > 0)) return 'La quantité doit être supérieure à 0';
          const a = courant(v);
          if (typeDe(v) === 'sortie' && a && !refs.stockNegatif && Number(q) > Number(a.quantite)) return `Stock insuffisant : ${qte(Math.max(0, a.quantite), a.uniteCode)} disponible(s)`;
          return '';
        } },
      { nom: 'quantiteConstatee', label: 'Quantité constatée (comptage physique)', type: 'nombre', requis: true, min: 0, step: 'any', afficherSi: (v) => typeDe(v) === 'inventaire', onInput: (x, f) => majEcart(f), onChange: (x, f) => majEcart(f) },
      { type: 'html', rendu: () => ecartEl, afficherSi: (v) => typeDe(v) === 'inventaire' },
      { nom: 'prixUnitaire', label: 'Prix unitaire d\'achat HT', type: 'nombre', min: 0, step: 0.01, afficherSi: (v) => typeDe(v) === 'entree', aide: 'Facultatif : met à jour le coût moyen pondéré de l\'article' },
      { nom: 'fournisseurId', label: 'Fournisseur', type: 'select', options: optionsFournisseurs(refs, article && article.fournisseurId, '— Non précisé —'), afficherSi: (v) => typeDe(v) === 'entree' },
      ots.length ? { nom: 'otId', label: 'Imputer à un ordre de travail', type: 'select', pleineLargeur: true, options: [{ value: '', label: '— Aucun (sortie hors OT) —' }].concat(ots.map((o) => ({ value: o.id, label: `${o.numero} — ${o.titre}` }))), afficherSi: (v) => typeDe(v) === 'sortie', aide: 'La pièce sera ajoutée aux pièces consommées de l\'OT et à son coût' } : null,
      { nom: 'motif', label: 'Motif / commentaire', type: 'texte', pleineLargeur: true, maxLength: 500, placeholder: 'ex. Réception commande CDE-2026-0123, dépannage convoyeur, inventaire tournant zone A…' },
    ];
    const valeurs = {
      type: type || 'entree', articleId: article ? article.id : '',
      quantite: quantite != null ? quantite : '',
      quantiteConstatee: article && type === 'inventaire' ? article.quantite : '',
      prixUnitaire: article ? article.prixUnitaire : '', fournisseurId: article && article.fournisseurId != null ? article.fournisseurId : '',
    };
    const titre = fixe ? `${TYPES[type].label} — ${article.code}` : 'Nouveau mouvement de stock';
    const m = ui.formModal({
      titre, champs, valeurs, taille: fixe ? null : 'large', submitLabel: 'Enregistrer le mouvement',
      onSubmit: async (v) => {
        const a = courant(v);
        if (!a) { toast('Choisissez un article', 'alerte'); return false; }
        const t = typeDe(v);
        const body = { type: t, quantite: t === 'inventaire' ? v.quantiteConstatee : v.quantite, motif: v.motif || '' };
        if (t === 'entree') { if (v.prixUnitaire !== null && v.prixUnitaire !== '') body.prixUnitaire = v.prixUnitaire; body.fournisseurId = v.fournisseurId === '' ? null : v.fournisseurId; }
        if (t === 'sortie' && v.otId) body.otId = v.otId;
        const r = await api.post(`/api/articles/${a.id}/mouvements`, body);
        toast(`${TYPES[t].enregistre} — stock : ${qte(r.article.quantite, r.article.uniteCode)}`, 'succes');
        if (r.article.actif !== false && r.article.sousSeuil && t !== 'entree') toast(`« ${r.article.designation} » est sous le seuil minimum (${qte(r.article.seuilMin, r.article.uniteCode)}) : à réapprovisionner`, 'alerte', 6000);
        majBadge(true);
        if (apres) apres(r);
      },
    });
    majInfo(m.form);
  }

  // ----- Liste : onglets ---------------------------------------------------------------------
  async function afficherListe(container, query) {
    const filtres = {
      recherche: query.recherche || '', categorieCode: query.categorieCode || '', fournisseurId: query.fournisseurId || '', secteurId: query.secteurId || '',
      dispo: query.sousSeuil === '1' || query.sousSeuil === 'true' ? 'sous_seuil' : '', inactifs: query.actif === '0' || query.actif === 'tous', equipementId: query.equipementId || '',
    };
    const filtresMvt = { type: query.type || '', articleId: query.articleId || '', userId: '', otId: query.otId || '', du: query.du || '', au: query.au || '', recherche: '' };
    let articles = [];
    let nbAlertes = 0;
    let onglets = null;
    let equipementFiltre = null;

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'stock',
      sousTitre: 'Pièces détachées, consommables, mouvements, alertes de réapprovisionnement et valorisation',
      actions: [
        can('modifier') ? ui.bouton('Nouveau mouvement', { icone: 'rafraichir', onClic: () => ouvrirMouvement({ articles, apres: () => rafraichir() }) }) : null,
        can('creer') ? ui.bouton('Nouvel article', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, { apres: (a) => GMAO.navigate('#/stock/' + a.id) }) }) : null,
      ],
    }));
    const kpis = el('div', { class: 'grille grille-4 mb' });
    container.appendChild(kpis);
    const zoneOnglets = el('div');
    container.appendChild(zoneOnglets);

    function majKpis() {
      ui.vider(kpis);
      const actifs = articles.filter((a) => a.actif !== false);
      const sous = actifs.filter((a) => a.sousSeuil);
      const ruptures = actifs.filter((a) => Number(a.quantite) <= 0);
      const valeur = actifs.reduce((s, a) => s + (Number(a.valeur) || 0), 0);
      kpis.appendChild(ui.kpi({ label: 'Articles actifs', valeur: actifs.length, icone: 'piece', couleur: '#2563eb', detail: articles.length > actifs.length ? `${articles.length - actifs.length} désactivé(s)` : 'références en stock', onClic: () => { filtres.dispo = ''; onglets.activer('articles'); } }));
      kpis.appendChild(ui.kpi({ label: 'Sous le seuil minimum', valeur: sous.length, icone: 'alerte', couleur: sous.length ? ORANGE : VERT, detail: sous.length ? 'à réapprovisionner' : 'stock à niveau', onClic: () => onglets.activer('alertes') }));
      kpis.appendChild(ui.kpi({ label: 'En rupture', valeur: ruptures.length, icone: 'stock', couleur: ruptures.length ? ROUGE : VERT, detail: ruptures.length ? 'stock nul ou négatif' : 'aucune rupture', onClic: () => { filtres.dispo = 'rupture'; onglets.activer('articles'); } }));
      kpis.appendChild(ui.kpi({ label: 'Valeur du stock', valeur: ui.formatMontant(valeur), icone: 'euro', couleur: '#8b5cf6', detail: 'quantité × prix unitaire', onClic: () => onglets.activer('valorisation') }));
    }

    /** Badge du nombre d'alertes sur l'onglet (masqué à zéro) et dans le menu. */
    function majCompteurAlertes(n) {
      nbAlertes = n;
      GMAO.setNavBadge(MODULE, n);
      if (!onglets) return;
      if (n) onglets.setBadge('alertes', n);
      else { const b = onglets.el.querySelector('.onglets button[data-cle="alertes"] .badge'); if (b) b.remove(); }
    }
    async function chargerArticles() {
      articles = await api.get('/api/articles');
      majCompteurAlertes(articles.filter((a) => a.actif !== false && a.sousSeuil).length);
      majKpis();
    }
    async function rafraichir() {
      try { await chargerArticles(); if (onglets) onglets.activer(onglets.actif); } catch (e) { erreur(e); }
    }

    // ---- Onglet Articles ----
    function filtrerArticles() {
      const termes = filtres.recherche ? String(filtres.recherche).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter(Boolean) : [];
      return articles.filter((a) => {
        if (!filtres.inactifs && a.actif === false) return false;
        if (filtres.categorieCode && (filtres.categorieCode === 'aucune' ? a.categorieCode : a.categorieCode !== filtres.categorieCode)) return false;
        if (filtres.fournisseurId && (filtres.fournisseurId === 'aucun' ? a.fournisseurId != null : Number(a.fournisseurId) !== Number(filtres.fournisseurId))) return false;
        if (filtres.secteurId && (filtres.secteurId === 'aucun' ? a.secteurId != null : Number(a.secteurId) !== Number(filtres.secteurId))) return false;
        if (filtres.equipementId && !(a.equipementIds || []).map(Number).includes(Number(filtres.equipementId))) return false;
        if (filtres.dispo === 'sous_seuil' && !(a.actif !== false && a.sousSeuil)) return false;
        if (filtres.dispo === 'rupture' && !(Number(a.quantite) <= 0)) return false;
        if (filtres.dispo === 'disponible' && a.sousSeuil) return false;
        if (termes.length) {
          const t = [a.code, a.designation, a.referenceFournisseur, a.emplacement].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          if (!termes.every((x) => t.includes(x))) return false;
        }
        return true;
      });
    }
    function paramsExport() {
      const p = new URLSearchParams();
      if (filtres.recherche) p.set('recherche', filtres.recherche);
      if (filtres.categorieCode) p.set('categorieCode', filtres.categorieCode);
      if (filtres.fournisseurId) p.set('fournisseurId', filtres.fournisseurId);
      if (filtres.secteurId) p.set('secteurId', filtres.secteurId);
      if (filtres.equipementId) p.set('equipementId', filtres.equipementId);
      if (filtres.dispo === 'sous_seuil') p.set('sousSeuil', '1');
      if (!filtres.inactifs) p.set('actif', '1');
      return p.toString();
    }
    function rendreArticles(cont) {
      const fournisseurs = new Map();
      for (const f of (cacheRefs && cacheRefs.fournisseurs) || []) fournisseurs.set(Number(f.id), f.nom);
      for (const a of articles) if (a.fournisseurId != null && a.fournisseurNom) fournisseurs.set(Number(a.fournisseurId), a.fournisseurNom);
      const selectOpts = (opts, valeur) => opts.map((o) => el('option', { value: o.value, selected: String(o.value) === String(valeur) }, o.label));
      const tableau = ui.table({
        lignes: [], recherche: false, triInitial: { cle: 'code', sens: 'asc' }, vide: 'Aucun article ne correspond aux critères',
        onClic: (a) => GMAO.navigate('#/stock/' + a.id),
        ligneClasse: (a) => (a.actif === false ? 'inactif' : ''),
        colonnes: [
          colCode(),
          { cle: 'designation', label: 'Désignation', rendu: (a) => el('div', { style: { minWidth: '230px' } }, el('div', { class: 'cellule-principale' }, a.designation), (a.referenceFournisseur || a.actif === false) ? el('div', { class: 'cellule-secondaire' }, a.actif === false ? 'Désactivé' : '', a.actif === false && a.referenceFournisseur ? ' · ' : '', a.referenceFournisseur ? `Réf. ${a.referenceFournisseur}` : '') : null) },
          { cle: 'categorieCode', label: 'Catégorie', liste: 'categoriesArticles' },
          { cle: 'quantite', label: 'Quantité', aligner: 'droite', rendu: quantiteCellule, valeurTri: (a) => Number(a.quantite) || 0 },
          { cle: 'uniteCode', label: 'Unité', rendu: (a) => libUnite(a.uniteCode) },
          { cle: 'emplacement', label: 'Emplacement', rendu: (a) => (a.emplacement ? el('div', { style: { minWidth: '140px', maxWidth: '210px' } }, a.emplacement) : el('span', { class: 'texte-2' }, '—')) },
          colMontant('prixUnitaire', 'Prix unitaire'),
          colMontant('valeur', 'Valeur'),
          { cle: 'fournisseurNom', label: 'Fournisseur', rendu: (a) => (a.fournisseurNom ? tronque(a.fournisseurNom, '150px') : el('span', { class: 'texte-2' }, '—')) },
        ],
        actions: [
          { icone: 'export', titre: 'Entrée en stock', visible: (a) => can('modifier') && a.actif !== false, onClic: (a) => ouvrirMouvement({ article: a, type: 'entree', apres: rafraichir }) },
          { icone: 'import', titre: 'Sortie de stock', visible: (a) => can('modifier') && a.actif !== false, onClic: (a) => ouvrirMouvement({ article: a, type: 'sortie', apres: rafraichir }) },
          { icone: 'modifier', titre: 'Modifier', visible: () => can('modifier'), onClic: (a) => ouvrirFormulaire(a, { apres: rafraichir }) },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (a) => can('supprimer') && a.actif !== false, onClic: (a) => supprimer(a, rafraichir) },
        ],
      });
      const resume = el('span', { class: 'texte-2 texte-petit' });
      const appliquer = () => {
        const rows = filtrerArticles();
        tableau.maj(rows);
        const valeur = rows.reduce((s, a) => s + (Number(a.valeur) || 0), 0);
        resume.textContent = `${rows.length} article${rows.length > 1 ? 's' : ''} · valeur ${ui.formatMontant(valeur)}`;
      };
      const recherche = el('input', { type: 'search', placeholder: 'Rechercher (code, désignation, réf.)…', value: filtres.recherche, style: { maxWidth: '260px' } });
      recherche.addEventListener('input', ui.debounce(() => { filtres.recherche = recherche.value.trim(); appliquer(); }, 200));
      const selCat = el('select', { title: 'Catégorie', onchange: () => { filtres.categorieCode = selCat.value; appliquer(); } }, selectOpts([{ value: '', label: 'Toutes les catégories' }].concat(ui.optionsListe('categoriesArticles', { vide: false })).concat([{ value: 'aucune', label: 'Sans catégorie' }]), filtres.categorieCode));
      const selFour = el('select', { title: 'Fournisseur', onchange: () => { filtres.fournisseurId = selFour.value; appliquer(); } }, selectOpts([{ value: '', label: 'Tous les fournisseurs' }].concat(Array.from(fournisseurs.entries()).sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([id, n]) => ({ value: id, label: n }))).concat([{ value: 'aucun', label: 'Sans fournisseur' }]), filtres.fournisseurId));
      const selDispo = el('select', { title: 'Disponibilité', onchange: () => { filtres.dispo = selDispo.value; appliquer(); } }, selectOpts([{ value: '', label: 'Toutes disponibilités' }, { value: 'sous_seuil', label: 'Sous le seuil minimum' }, { value: 'rupture', label: 'En rupture' }, { value: 'disponible', label: 'Au-dessus du seuil' }], filtres.dispo));
      const secteursUtilises = Array.from(new Set(articles.filter((a) => a.secteurId != null).map((a) => Number(a.secteurId))));
      const selSect = secteursUtilises.length ? el('select', { title: 'Magasin / secteur', onchange: () => { filtres.secteurId = selSect.value; appliquer(); } }, selectOpts([{ value: '', label: 'Tous les magasins' }, { value: 'aucun', label: 'Magasin central' }].concat(secteursUtilises.map((id) => ({ value: id, label: ui.nomSecteur(id) }))), filtres.secteurId)) : null;
      const cbInactifs = el('input', { type: 'checkbox', checked: filtres.inactifs, onchange: () => { filtres.inactifs = cbInactifs.checked; appliquer(); } });
      const puceEq = filtres.equipementId ? el('span', { class: 'badge contour', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, icone('equipements'), `Compatibles : ${equipementFiltre ? equipementFiltre.nom : '#' + filtres.equipementId}`,
        el('button', { type: 'button', class: 'btn btn-lien btn-sm', title: 'Retirer ce filtre', onclick: () => { filtres.equipementId = ''; onglets.activer('articles'); } }, '×')) : null;
      cont.appendChild(el('div', { class: 'barre-outils' }, recherche, selCat, selFour, selDispo, selSect, el('label', { class: 'inline' }, cbInactifs, 'Inclure les désactivés'), puceEq,
        el('span', { class: 'espace' }), resume,
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: () => api.telecharger('/api/articles-export?' + paramsExport()).catch(erreur) }) : null));
      cont.appendChild(tableau.el);
      appliquer();
    }

    // ---- Onglet Mouvements ----
    function rendreMouvements(cont) {
      const tableau = ui.table({
        lignes: [], recherche: false, vide: 'Aucun mouvement sur la période', compact: true,
        colonnes: [
          colDate2('date', 'Date'),
          { cle: 'type', label: 'Type', rendu: (m) => frag(badgeType(m.type), m.annuleParId ? el('span', { class: 'texte-2 texte-petit', title: 'Sortie annulée par un retour en stock' }, ' annulée') : null), valeurTri: (m) => m.type },
          { cle: 'articleDesignation', label: 'Article', rendu: (m) => el('div', null, lienVue('#/stock/' + m.articleId, m.articleCode || '#' + m.articleId), tronque(m.articleDesignation, '170px', 'cellule-secondaire')), valeurTri: (m) => String(m.articleCode || '').toLowerCase() },
          { cle: 'quantite', label: 'Quantité', aligner: 'droite', rendu: (m) => nowrap(frag(mouvementSigne(m), m.uniteCode ? el('span', { class: 'texte-2 texte-petit' }, ' ' + m.uniteCode) : null)), valeurTri: (m) => Number(m.ecart) || 0 },
          { cle: 'quantiteApres', label: 'Stock', aligner: 'droite', rendu: (m) => el('span', { class: 'texte-2', style: { whiteSpace: 'nowrap' } }, `${ui.formatNombre(m.quantiteAvant)} → `, el('span', { class: 'texte-gras', style: { color: 'var(--texte)' } }, ui.formatNombre(m.quantiteApres))) },
          colMontant('valeur', 'Valeur', { rendu: (m) => el('span', { style: { whiteSpace: 'nowrap' }, title: `${ui.formatNombre(m.quantite)} × ${ui.formatMontant(m.prixUnitaire || 0)}` }, ui.formatMontant(m.valeur || 0)) }),
          { cle: 'otNumero', label: 'OT', rendu: celluleOt },
          { cle: 'motif', label: 'Motif', rendu: (m) => tronque(m.fournisseurNom && m.type === 'entree' ? `${m.motif ? m.motif + ' · ' : ''}${m.fournisseurNom}` : (m.motif || ''), '180px') },
          { cle: 'userNom', label: 'Par', rendu: (m) => nowrap(m.userNom || '') },
        ],
        actions: [
          { icone: 'rafraichir', titre: 'Annuler la sortie (retour en stock)', visible: (m) => can('modifier') && m.annulable, onClic: (m) => annulerSortie(m) },
        ],
      });
      const resume = el('div', { class: 'texte-2 texte-petit mb' });
      async function charger() {
        try {
          const params = {};
          for (const [k, v] of Object.entries(filtresMvt)) if (v) params[k] = v;
          const rows = await api.get('/api/mouvements', params);
          tableau.maj(rows);
          const tot = (t) => rows.filter((m) => m.type === t).reduce((s, m) => s + (Number(m.valeur) || 0), 0);
          resume.textContent = `${rows.length} mouvement${rows.length > 1 ? 's' : ''} · entrées ${ui.formatMontant(tot('entree'))} · sorties ${ui.formatMontant(tot('sortie'))} · retours ${ui.formatMontant(tot('retour'))}`;
        } catch (e) { erreur(e); }
      }
      async function annulerSortie(m) {
        const ok = await ui.confirm({ titre: 'Annuler la sortie', message: `Annuler la sortie de ${qte(m.quantite, m.uniteCode)} de « ${m.articleDesignation} » du ${ui.formatDateHeure(m.date)} ? Un mouvement de retour ré-incrémentera le stock.`, okLabel: 'Remettre en stock' });
        if (!ok) return;
        try {
          const r = await api.post(`/api/mouvements/${m.id}/annuler`, {});
          toast(`Retour en stock enregistré — stock : ${qte(r.article.quantite, r.article.uniteCode)}`, 'succes');
          try { await chargerArticles(); } catch (e) { /* liste rechargée au prochain affichage */ }
          charger();
        } catch (e) { erreur(e); }
      }
      const selectOpts = (opts, valeur) => opts.map((o) => el('option', { value: o.value, selected: String(o.value) === String(valeur) }, o.label));
      const selType = el('select', { title: 'Type', onchange: () => { filtresMvt.type = selType.value; charger(); } }, selectOpts([{ value: '', label: 'Tous les types' }].concat(Object.entries(TYPES).map(([k, t]) => ({ value: k, label: t.label }))), filtresMvt.type));
      const selArticle = el('select', { title: 'Article', style: { maxWidth: '260px' }, onchange: () => { filtresMvt.articleId = selArticle.value; charger(); } }, selectOpts([{ value: '', label: 'Tous les articles' }].concat(articles.slice().sort((a, b) => String(a.code).localeCompare(String(b.code), 'fr', { numeric: true })).map((a) => ({ value: a.id, label: `${a.code} — ${a.designation}` }))), filtresMvt.articleId));
      const selUser = el('select', { title: 'Utilisateur', onchange: () => { filtresMvt.userId = selUser.value; charger(); } }, selectOpts([{ value: '', label: 'Tous les utilisateurs' }].concat(ui.optionsUsers({ vide: false, inactifs: true })), filtresMvt.userId));
      const selOt = el('select', { title: 'Imputation', onchange: () => { filtresMvt.otId = selOt.value; charger(); } }, selectOpts([{ value: '', label: 'Avec ou sans OT' }, { value: 'tous', label: 'Imputés à un OT' }, { value: 'aucun', label: 'Hors OT' }].concat(filtresMvt.otId && !['tous', 'aucun'].includes(filtresMvt.otId) ? [{ value: filtresMvt.otId, label: `OT #${filtresMvt.otId}` }] : []), filtresMvt.otId));
      const du = el('input', { type: 'date', value: filtresMvt.du, title: 'Du', onchange: () => { filtresMvt.du = du.value; charger(); } });
      const au = el('input', { type: 'date', value: filtresMvt.au, title: 'Au', onchange: () => { filtresMvt.au = au.value; charger(); } });
      const recherche = el('input', { type: 'search', placeholder: 'Motif, article, OT…', value: filtresMvt.recherche, style: { maxWidth: '200px' } });
      recherche.addEventListener('input', ui.debounce(() => { filtresMvt.recherche = recherche.value.trim(); charger(); }, 300));
      const periode = (jours) => () => { const d = new Date(); d.setDate(d.getDate() - jours); filtresMvt.du = ui.dateISO(d); filtresMvt.au = ''; du.value = filtresMvt.du; au.value = ''; charger(); };
      cont.appendChild(el('div', { class: 'barre-outils' }, recherche, selType, selArticle, selUser, selOt,
        el('label', { class: 'inline texte-2' }, 'Du', du), el('label', { class: 'inline texte-2' }, 'au', au),
        el('div', { class: 'btn-groupe' }, ui.bouton('7 j', { classe: 'btn-sm', onClic: periode(7) }), ui.bouton('30 j', { classe: 'btn-sm', onClic: periode(30) }), ui.bouton('90 j', { classe: 'btn-sm', onClic: periode(90) })),
        ui.bouton('Réinitialiser', { icone: 'filtre', classe: 'btn-sm btn-lien', onClic: () => { Object.keys(filtresMvt).forEach((k) => { filtresMvt[k] = ''; }); onglets.activer('mouvements'); } }),
        el('span', { class: 'espace' }),
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(filtresMvt)) if (v) p.set(k, v); api.telecharger('/api/mouvements-export?' + p.toString()).catch(erreur); } }) : null));
      cont.appendChild(resume);
      cont.appendChild(tableau.el);
      charger();
    }

    // ---- Onglet Alertes ----
    function rendreAlertes(cont) {
      cont.appendChild(ui.chargement());
      api.get('/api/stock-alertes').then((rows) => {
        ui.vider(cont);
        majCompteurAlertes(rows.length);
        if (!rows.length) { cont.appendChild(ui.vide('Aucun article sous le seuil minimum : le stock est à niveau.', 'check')); return; }
        const total = rows.reduce((s, a) => s + (Number(a.valeurCommande) || 0), 0);
        const parFournisseur = new Map();
        for (const a of rows) { const k = a.fournisseurNom || ''; parFournisseur.set(k, (parFournisseur.get(k) || []).concat([a])); }
        const ruptures = rows.filter((a) => Number(a.quantite) <= 0).length;
        const nbFournisseurs = Array.from(parFournisseur.keys()).filter(Boolean).length;
        cont.appendChild(ui.alerte(frag(icone('alerte'), ' ', el('strong', null, `${rows.length} article${rows.length > 1 ? 's' : ''} à réapprovisionner`), ruptures ? ` (dont ${ruptures} en rupture)` : '',
          nbFournisseurs ? ` auprès de ${nbFournisseurs} fournisseur${nbFournisseurs > 1 ? 's' : ''}` : '', ` — montant estimé ${ui.formatMontant(total)}. Quantité proposée = max(quantité de réapprovisionnement, 2 × seuil − stock).`), 'alerte'));
        const colonnesExport = [
          { label: 'Fournisseur', exportValeur: (a) => a.fournisseurNom || 'Sans fournisseur' },
          { label: 'Code', cle: 'code' }, { label: 'Désignation', cle: 'designation' }, { label: 'Référence fournisseur', cle: 'referenceFournisseur' },
          { label: 'Emplacement', cle: 'emplacement' }, { label: 'Stock', exportValeur: (a) => ui.formatNombre(a.quantite) }, { label: 'Seuil minimum', exportValeur: (a) => ui.formatNombre(a.seuilMin) },
          { label: 'Quantité à commander', exportValeur: (a) => ui.formatNombre(a.quantiteACommander) }, { label: 'Unité', exportValeur: (a) => libUnite(a.uniteCode) },
          { label: 'Prix unitaire', exportValeur: (a) => ui.formatNombre(a.prixUnitaire, 2) }, { label: 'Montant estimé', exportValeur: (a) => ui.formatNombre(a.valeurCommande, 2) },
        ];
        const triees = rows.slice().sort((a, b) => (a.fournisseurNom ? 0 : 1) - (b.fournisseurNom ? 0 : 1) || String(a.fournisseurNom).localeCompare(String(b.fournisseurNom), 'fr') || String(a.code).localeCompare(String(b.code), 'fr', { numeric: true }));
        cont.appendChild(el('div', { class: 'barre-outils' },
          el('span', { class: 'texte-2' }, 'Regroupement par fournisseur habituel'), el('span', { class: 'espace' }),
          GMAO.moduleVisible('achats') && GMAO.can('achats', 'creer') ? ui.bouton('Créer les commandes', { icone: 'euro', classe: 'btn-sm', titre: 'Commandes fournisseurs depuis les alertes (module Achats & factures)', onClic: () => GMAO.navigate('#/achats?alertes=1') }) : null,
          ui.bouton('Imprimer les bons de commande', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerCommandes(parFournisseur) }),
          can('exporter') ? ui.bouton('Exporter la liste à commander', { icone: 'export', classe: 'btn-sm btn-primaire', onClic: () => ui.exportCsv(`stock-a-commander-${ui.aujourdhui()}.csv`, colonnesExport, triees) }) : null));
        const tableau = ui.table({
          lignes: triees, recherche: rows.length > 10 ? 'Rechercher un article…' : false, pagination: false,
          onClic: (a) => GMAO.navigate('#/stock/' + a.id),
          groupe: {
            cle: (a) => a.fournisseurNom || '',
            ordre: (x, y) => (x ? 0 : 1) - (y ? 0 : 1) || String(x).localeCompare(String(y), 'fr'),
            label: (val, lignes) => frag(icone('fournisseurs'), ' ', val || 'Sans fournisseur habituel', el('span', { class: 'texte-2' }, ` · ${lignes.length} article${lignes.length > 1 ? 's' : ''} · ${ui.formatMontant(lignes.reduce((s, a) => s + (Number(a.valeurCommande) || 0), 0))}${lignes[0] && lignes[0].delaiLivraisonJours != null && val ? ` · délai ${lignes[0].delaiLivraisonJours} j` : ''}`)),
          },
          colonnes: [
            colCode(),
            { cle: 'designation', label: 'Désignation', rendu: (a) => el('div', null, el('div', { class: 'cellule-principale' }, a.designation), a.referenceFournisseur ? el('div', { class: 'cellule-secondaire' }, `Réf. ${a.referenceFournisseur}`) : null) },
            { cle: 'emplacement', label: 'Emplacement', rendu: (a) => tronque(a.emplacement, '200px') },
            { cle: 'quantite', label: 'Stock', aligner: 'droite', rendu: (a) => ui.badge(ui.formatNombre(a.quantite), Number(a.quantite) <= 0 ? ROUGE : ORANGE), valeurTri: (a) => Number(a.quantite) },
            { cle: 'seuilMin', label: 'Seuil', aligner: 'droite', type: 'nombre' },
            { cle: 'quantiteACommander', label: 'À commander', aligner: 'droite', rendu: (a) => el('span', { class: 'texte-gras', style: { fontSize: '15px' } }, ui.formatNombre(a.quantiteACommander)), valeurTri: (a) => Number(a.quantiteACommander) },
            { cle: 'uniteCode', label: 'Unité', rendu: (a) => libUnite(a.uniteCode) },
            colMontant('prixUnitaire', 'Prix unitaire'),
            colMontant('valeurCommande', 'Montant estimé'),
          ],
          actions: [
            { icone: 'export', titre: 'Réception (entrée en stock)', visible: () => can('modifier'), onClic: (a) => ouvrirMouvement({ article: a, type: 'entree', quantite: a.quantiteACommander, apres: rafraichir }) },
          ],
        });
        cont.appendChild(tableau.el);
        cont.appendChild(el('div', { class: 'tableau-pied texte-droite', style: { justifyContent: 'flex-end' } }, el('span', null, 'Total estimé : ', el('strong', null, ui.formatMontant(total)))));
      }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'danger')); });
    }

    function imprimerCommandes(parFournisseur) {
      let html = '';
      const groupes = Array.from(parFournisseur.entries()).sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0], 'fr'));
      for (const [f, rows] of groupes) {
        const total = rows.reduce((s, a) => s + (Number(a.valeurCommande) || 0), 0);
        html += `<h2>${esc(f || 'Sans fournisseur habituel')}</h2><table><thead><tr><th>Code</th><th>Désignation</th><th>Réf. fournisseur</th><th>Stock</th><th>Seuil</th><th>Quantité à commander</th><th>Prix unitaire</th><th>Montant estimé</th></tr></thead><tbody>`;
        html += rows.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.designation)}</td><td>${esc(a.referenceFournisseur || '')}</td><td>${esc(qte(a.quantite, a.uniteCode))}</td><td>${esc(ui.formatNombre(a.seuilMin))}</td><td><b>${esc(qte(a.quantiteACommander, a.uniteCode))}</b></td><td>${esc(ui.formatMontant(a.prixUnitaire))}</td><td>${esc(ui.formatMontant(a.valeurCommande))}</td></tr>`).join('');
        html += `</tbody></table><p style="text-align:right">Total estimé : <b>${esc(ui.formatMontant(total))}</b></p>`;
      }
      html += '<div class="signature"><div>Demandé par</div><div>Validé par</div></div>';
      ui.imprimer('Articles à commander', html);
    }

    // ---- Onglet Valorisation ----
    function rendreValorisation(cont) {
      cont.appendChild(ui.chargement());
      api.get('/api/stock-valorisation').then((v) => {
        ui.vider(cont);
        cont.appendChild(el('div', { class: 'grille grille-4 mb' },
          ui.kpi({ label: 'Valeur totale du stock', valeur: ui.formatMontant(v.total), icone: 'euro', couleur: '#8b5cf6', detail: `au ${ui.formatDateHeure(v.date)}` }),
          ui.kpi({ label: 'Articles actifs', valeur: v.nbArticles, icone: 'piece', couleur: '#2563eb', detail: `${v.nbValorises} valorisé(s)` }),
          ui.kpi({ label: 'Valeur moyenne par article', valeur: ui.formatMontant(v.nbValorises ? v.total / v.nbValorises : 0), icone: 'rapports', couleur: '#0891b2', detail: 'articles valorisés' }),
          ui.kpi({ label: 'Articles sans prix', valeur: v.nbSansPrix, icone: 'alerte', couleur: v.nbSansPrix ? ORANGE : VERT, detail: v.nbSansPrix ? 'valorisation incomplète' : 'tous les articles ont un prix' })));
        if (!v.parCategorie.length) { cont.appendChild(ui.vide('Aucun article actif à valoriser.')); return; }
        const cats = v.parCategorie.map((c, i) => Object.assign({}, c, { couleurAff: c.couleur || couleurCategorie(c.categorieCode, i) }));
        const tableCat = ui.table({
          lignes: cats, recherche: false, pagination: false, compact: true, triInitial: { cle: 'valeur', sens: 'desc' },
          onClic: (c) => { filtres.categorieCode = c.categorieCode || 'aucune'; filtres.dispo = ''; onglets.activer('articles'); },
          colonnes: [
            { cle: 'label', label: 'Catégorie', rendu: (c) => el('span', { class: 'inline' }, ui.pastille(c.couleurAff), c.label) },
            { cle: 'nbArticles', label: 'Articles', aligner: 'droite', type: 'nombre' },
            { cle: 'nbSousSeuil', label: 'Sous seuil', aligner: 'droite', rendu: (c) => (c.nbSousSeuil ? el('span', { class: 'texte-danger texte-gras' }, String(c.nbSousSeuil)) : el('span', { class: 'texte-2' }, '0')), valeurTri: (c) => c.nbSousSeuil },
            colMontant('valeur', 'Valeur'),
            { cle: 'part', label: 'Part', rendu: (c) => el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } }, el('div', { class: 'barre-progression', style: { width: '48px', flexShrink: '0' } }, el('div', { style: { width: Math.min(100, c.part) + '%', background: c.couleurAff } })), el('span', { class: 'texte-petit' }, ui.formatNombre(c.part, 1) + ' %')), valeurTri: (c) => c.part },
          ],
        });
        cont.appendChild(el('div', { class: 'grille grille-2' },
          ui.carte('Valeur du stock par catégorie', ui.graphiqueBarres(cats.slice().sort((a, b) => b.valeur - a.valeur).map((c) => ({ label: c.label, valeur: Math.round(c.valeur), couleur: c.couleurAff })), { hauteur: 220 })),
          ui.carte('Répartition', frag(tableCat.el, el('div', { class: 'tableau-pied', style: { justifyContent: 'space-between' } }, el('span', null, 'Total'), el('strong', null, ui.formatMontant(v.total)))), {
            actions: can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: () => ui.exportCsv(`valorisation-stock-${ui.aujourdhui()}.csv`, [
              { label: 'Catégorie', cle: 'label' }, { label: 'Articles', cle: 'nbArticles' }, { label: 'Sous le seuil', cle: 'nbSousSeuil' },
              { label: 'Valeur', exportValeur: (c) => ui.formatNombre(c.valeur, 2) }, { label: 'Part (%)', exportValeur: (c) => ui.formatNombre(c.part, 1) },
            ], cats.concat([{ label: 'Total', nbArticles: v.nbArticles, nbSousSeuil: v.nbSousSeuil, valeur: v.total, part: 100 }])) }) : null,
          })));
        if (v.topArticles.length) {
          cont.appendChild(ui.carte('Articles les plus valorisés', ui.table({
            lignes: v.topArticles, recherche: false, pagination: false, compact: true, onClic: (a) => GMAO.navigate('#/stock/' + a.id),
            colonnes: [
              colCode(),
              { cle: 'designation', label: 'Désignation' },
              { cle: 'categorieCode', label: 'Catégorie', liste: 'categoriesArticles' },
              { cle: 'quantite', label: 'Quantité', aligner: 'droite', rendu: (a) => qte(a.quantite, a.uniteCode), valeurTri: (a) => a.quantite },
              colMontant('prixUnitaire', 'Prix unitaire'),
              { cle: 'valeur', label: 'Valeur', aligner: 'droite', rendu: (a) => el('span', { class: 'texte-gras' }, ui.formatMontant(a.valeur)), valeurTri: (a) => a.valeur },
              { cle: 'part', label: 'Part du total', aligner: 'droite', rendu: (a) => (v.total ? ui.formatNombre((a.valeur / v.total) * 100, 1) + ' %' : '—'), valeurTri: (a) => a.valeur },
            ],
          }).el, { classe: 'mt' }));
        }
      }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'danger')); });
    }

    // ---- Assemblage ----
    try { await Promise.all([chargerArticles(), references()]); } catch (e) { container.appendChild(ui.alerte('Chargement du stock impossible : ' + e.message, 'danger')); return; }
    if (filtres.equipementId) {
      const e = ((cacheRefs && cacheRefs.equipements) || []).find((x) => Number(x.id) === Number(filtres.equipementId));
      equipementFiltre = e || null;
    }
    const ongletInitial = query.onglet || (query.articleId || query.otId || query.type ? 'mouvements' : 'articles');
    onglets = ui.onglets([
      { cle: 'articles', label: 'Articles', icone: 'piece', rendu: rendreArticles },
      { cle: 'mouvements', label: 'Mouvements', icone: 'liste', rendu: rendreMouvements },
      { cle: 'alertes', label: 'Alertes', icone: 'alerte', badge: nbAlertes || null, rendu: rendreAlertes },
      { cle: 'valorisation', label: 'Valorisation', icone: 'euro', rendu: rendreValorisation },
    ], { hash: true, actif: ongletInitial });
    zoneOnglets.appendChild(onglets.el);
    // Lien direct vers une saisie de mouvement (ex. action rapide du tableau de bord : #/stock?mouvement=entree) ;
    // le paramètre est retiré de l'adresse pour qu'un rechargement ne rouvre pas la fenêtre
    if (can('modifier') && ['entree', 'sortie', 'inventaire'].includes(query.mouvement)) {
      try { history.replaceState(null, '', location.hash.replace(/[?&]mouvement=[^&]*/, '').replace(/\?$/, '')); } catch (e) { /* adresse conservée */ }
      ouvrirMouvement({ articles, type: query.mouvement, apres: rafraichir });
    }
  }

  // ----- Fiche article ------------------------------------------------------------------------
  async function afficherFiche(container, id) {
    let a;
    try { a = await api.get('/api/articles/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'stock', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/stock' }, { label: 'Fiche article' }] }));
      container.appendChild(ui.vide(e.status === 404 ? 'Article introuvable ou hors de votre périmètre.' : e.message, 'alerte'));
      container.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour au stock', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/stock') })));
      return;
    }
    const recharger = () => GMAO.rendre();
    const u = a.uniteCode;
    const actif = a.actif !== false;
    const mvt = (type) => () => ouvrirMouvement({ article: a, type, apres: recharger });

    container.appendChild(ui.pageEntete({
      titre: frag(a.designation, ' ', a.categorieCode ? ui.badgeListe('categoriesArticles', a.categorieCode) : null, ' ', badgeDispo(a)),
      icone: 'stock',
      filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/stock' }].concat(a.secteurId != null ? [{ label: ui.nomSecteur(a.secteurId), href: '#/stock?secteurId=' + a.secteurId }] : []).concat([{ label: a.code }]),
      sousTitre: [a.code, a.emplacement, a.referenceFournisseur ? `Réf. fournisseur ${a.referenceFournisseur}` : null].filter(Boolean).join(' · '),
      actions: [
        can('modifier') && actif ? ui.bouton('Entrée', { icone: TYPES.entree.icone, classe: 'btn-ok', onClic: mvt('entree') }) : null,
        can('modifier') && actif ? ui.bouton('Sortie', { icone: TYPES.sortie.icone, classe: 'btn-alerte', onClic: mvt('sortie') }) : null,
        can('modifier') ? ui.bouton('Inventaire', { icone: TYPES.inventaire.icone, onClic: mvt('inventaire') }) : null,
        can('modifier') ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(a, { apres: recharger }) }) : null,
      ],
    }));

    container.appendChild(el('div', { class: 'barre-outils' },
      can('creer') ? ui.bouton('Dupliquer', { icone: 'copier', classe: 'btn-sm', onClic: () => ouvrirFormulaire(a, { copie: true, apres: (n) => GMAO.navigate('#/stock/' + n.id) }) }) : null,
      ui.bouton('Imprimer la fiche', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerFiche(a) }),
      GMAO.moduleVisible('inventaire') ? ui.bouton('Imprimer l\'étiquette', { icone: 'imprimer', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/inventaire?onglet=etiquettes&source=articles&ids=${a.id}`) }) : null,
      ui.bouton('Journal complet', { icone: 'liste', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/stock?onglet=mouvements&articleId=${a.id}`) }),
      el('span', { class: 'espace' }),
      !actif && can('modifier') ? ui.bouton('Réactiver', { icone: 'check', classe: 'btn-sm btn-ok', onClic: () => reactiver(a, recharger) }) : null,
      actif && can('supprimer') ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: () => supprimer(a, (r) => (r.desactive ? recharger() : GMAO.navigate('#/stock'))) }) : null));

    if (!actif) container.appendChild(ui.alerte('Cet article est désactivé : il est conservé pour l\'historique mais n\'accepte plus d\'entrée ni de sortie.', 'alerte'));
    else if (Number(a.quantite) <= 0) container.appendChild(ui.alerte(frag(el('strong', null, 'Rupture de stock. '), `Quantité à commander : ${qte(a.quantiteACommander, u)}${a.fournisseurNom ? ' auprès de ' + a.fournisseurNom : ''}.`), 'danger'));
    else if (a.sousSeuil) container.appendChild(ui.alerte(frag(el('strong', null, 'Stock sous le seuil minimum. '), `Quantité à commander : ${qte(a.quantiteACommander, u)}${a.fournisseurNom ? ' auprès de ' + a.fournisseurNom : ''}.`), 'alerte'));

    const st = a.stats || {};
    container.appendChild(el('div', { class: 'grille grille-4 mb' },
      ui.kpi({ label: 'Stock actuel', valeur: qte(a.quantite, u), icone: 'stock', couleur: !actif ? '#6b7280' : (Number(a.quantite) <= 0 ? ROUGE : (a.sousSeuil ? ORANGE : VERT)), detail: a.dernierMouvement ? `dernier mouvement ${ui.relatif(a.dernierMouvement)}` : 'aucun mouvement' }),
      ui.kpi({ label: 'Seuil minimum', valeur: qte(a.seuilMin, u), icone: 'alerte', couleur: '#f59e0b', detail: `réapprovisionnement : ${qte(a.quantiteCommande, u)}` }),
      ui.kpi({ label: 'Valeur du stock', valeur: ui.formatMontant(a.valeur), icone: 'euro', couleur: '#8b5cf6', detail: `prix unitaire ${ui.formatMontant(a.prixUnitaire)}` }),
      ui.kpi({ label: 'Consommation 90 jours', valeur: qte(st.consommation90j || 0, u), icone: 'rapports', couleur: '#0891b2', detail: st.couvertureJours != null ? `couverture estimée ≈ ${ui.formatNombre(st.couvertureJours)} jour(s)` : 'pas de consommation récente' })));

    container.appendChild(ui.onglets([
      { cle: 'infos', label: 'Informations', icone: 'info', rendu: () => rendreInfos(a) },
      { cle: 'mouvements', label: 'Mouvements', icone: 'liste', badge: a.nbMouvements || null, rendu: () => rendreMouvementsArticle(a, recharger) },
      { cle: 'consommation', label: 'Consommation par OT', icone: 'ot', badge: (a.ots || []).length || null, rendu: () => rendreConsommation(a) },
      { cle: 'equipements', label: 'Équipements', icone: 'equipements', badge: (a.equipements || []).length || null, rendu: () => rendreEquipements(a) },
    ], { hash: true }).el);
  }

  function rendreInfos(a) {
    const f = a.fournisseur;
    const st = a.stats || {};
    return el('div', { class: 'grille grille-2' },
      ui.carte('Caractéristiques', frag(
        ui.details([
          { label: 'Code', valeur: el('span', { class: 'texte-gras' }, a.code) },
          { label: 'Désignation', valeur: a.designation },
          { label: 'Catégorie', valeur: ui.badgeListe('categoriesArticles', a.categorieCode) },
          { label: 'Unité de gestion', valeur: a.uniteCode ? `${libUnite(a.uniteCode)} (${a.uniteCode})` : '' },
          { label: 'Emplacement', valeur: a.emplacement },
          { label: 'Magasin / secteur', valeur: a.secteurId != null ? ui.cheminSecteur(a.secteurId) : 'Magasin central (tous secteurs)' },
          { label: 'Statut', valeur: badgeDispo(a) },
          { label: 'Dernier inventaire', valeur: st.dernierInventaire ? ui.formatDateHeure(st.dernierInventaire) : 'jamais' },
          { label: 'Créé le', valeur: ui.formatDateHeure(a.createdAt) },
          { label: 'Créé par', valeur: a.createdBy != null ? ui.nomUser(a.createdBy) : '' },
          ...ui.champsPersoAffichage('articles', a),
        ], { colonnes: 2 }),
        a.description ? el('div', { class: 'mt' }, el('div', { class: 'texte-2 texte-petit mb', style: { marginBottom: '4px' } }, 'Description'), el('div', { style: { whiteSpace: 'pre-wrap' } }, a.description)) : null)),
      ui.carte('Approvisionnement', ui.details([
        { label: 'Fournisseur habituel', valeur: f ? (GMAO.can('fournisseurs', 'voir') && GMAO.vues.fournisseurs ? lienVue('#/fournisseurs/' + f.id, f.nom) : f.nom) : '' },
        { label: 'Référence fournisseur', valeur: a.referenceFournisseur },
        f && f.contact ? { label: 'Contact', valeur: f.contact } : null,
        f && f.telephone ? { label: 'Téléphone', valeur: el('a', { href: 'tel:' + f.telephone }, f.telephone) } : null,
        f && f.email ? { label: 'E-mail', valeur: el('a', { href: 'mailto:' + f.email }, f.email) } : null,
        f && f.delaiLivraisonJours != null ? { label: 'Délai de livraison', valeur: `${f.delaiLivraisonJours} jour(s)` } : null,
        { label: 'Prix unitaire (CUMP)', valeur: ui.formatMontant(a.prixUnitaire) },
        { label: 'Seuil minimum', valeur: qte(a.seuilMin, a.uniteCode) },
        { label: 'Quantité de réapprovisionnement', valeur: qte(a.quantiteCommande, a.uniteCode) },
        { label: 'À commander maintenant', valeur: a.sousSeuil && a.actif !== false ? el('span', { class: 'texte-danger texte-gras' }, qte(a.quantiteACommander, a.uniteCode)) : el('span', { class: 'texte-2' }, Number(a.seuilMin) > 0 ? 'rien (stock au-dessus du seuil)' : 'rien (aucun seuil défini : article non suivi)') },
        { label: 'Entrées sur 90 jours', valeur: qte(st.entrees90j || 0, a.uniteCode) },
      ])));
  }

  function tableMouvements(lignes, { avecArticle, apres } = {}) {
    return ui.table({
      lignes, recherche: lignes.length > 10 ? 'Rechercher dans les mouvements…' : false, compact: true, vide: 'Aucun mouvement enregistré', triInitial: { cle: 'date', sens: 'desc' },
      colonnes: [
        colDate('date', 'Date', true),
        { cle: 'type', label: 'Type', rendu: (m) => frag(badgeType(m.type), m.annuleParId ? el('span', { class: 'texte-2 texte-petit' }, ' annulée') : null), valeurTri: (m) => m.type },
        avecArticle ? { cle: 'articleCode', label: 'Article' } : null,
        { cle: 'quantite', label: 'Quantité', aligner: 'droite', rendu: (m) => nowrap(mouvementSigne(m)), valeurTri: (m) => Number(m.ecart) || 0 },
        { cle: 'quantiteApres', label: 'Stock avant → après', aligner: 'droite', rendu: (m) => el('span', { class: 'texte-2', style: { whiteSpace: 'nowrap' } }, `${ui.formatNombre(m.quantiteAvant)} → `, el('span', { class: 'texte-gras', style: { color: 'var(--texte)' } }, ui.formatNombre(m.quantiteApres))) },
        colMontant('prixUnitaire', 'Prix unit.'),
        { cle: 'otNumero', label: 'OT', rendu: celluleOt },
        { cle: 'motif', label: 'Motif', rendu: (m) => tronque(m.type === 'entree' && m.fournisseurNom ? `${m.motif ? m.motif + ' · ' : ''}${m.fournisseurNom}` : m.motif || '', '320px') },
        { cle: 'userNom', label: 'Par', rendu: (m) => nowrap(m.userNom || '') },
      ].filter(Boolean),
      actions: [
        { icone: 'rafraichir', titre: 'Annuler la sortie (retour en stock)', visible: (m) => GMAO.can(MODULE, 'modifier') && m.annulable, onClic: async (m) => {
          const ok = await ui.confirm({ titre: 'Annuler la sortie', message: `Annuler la sortie de ${qte(m.quantite, m.uniteCode)} du ${ui.formatDateHeure(m.date)} ? Un mouvement de retour ré-incrémentera le stock.`, okLabel: 'Remettre en stock' });
          if (!ok) return;
          try { const r = await api.post(`/api/mouvements/${m.id}/annuler`, {}); toast(`Retour en stock enregistré — stock : ${qte(r.article.quantite, r.article.uniteCode)}`, 'succes'); majBadge(true); if (apres) apres(r); } catch (e) { erreur(e); }
        } },
      ],
    });
  }

  function rendreMouvementsArticle(a, recharger) {
    const cont = el('div');
    const lignes = a.mouvements || [];
    if (lignes.length >= 2) {
      const derniers = lignes.slice(0, 20).reverse();
      cont.appendChild(ui.carte(`Niveau de stock (${derniers.length} derniers mouvements)`, ui.graphiqueBarres(derniers.map((m) => ({
        label: ui.formatDate(m.date), valeur: Math.max(0, Number(m.quantiteApres) || 0),
        couleur: Number(a.seuilMin) > 0 && Number(m.quantiteApres) <= Number(a.seuilMin) ? ROUGE : (TYPES[m.type] || {}).couleur,
      })), { hauteur: 170 }), { actions: el('span', { class: 'texte-2 texte-petit' }, 'Rouge : niveau au seuil ou en dessous') }));
    }
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, a.nbMouvements > lignes.length ? `${lignes.length} derniers mouvements sur ${a.nbMouvements}` : `${lignes.length} mouvement(s)`),
      el('span', { class: 'espace' }),
      ui.bouton('Voir le journal complet', { icone: 'liste', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/stock?onglet=mouvements&articleId=${a.id}`) })));
    cont.appendChild(tableMouvements(lignes, { apres: recharger }).el);
    return cont;
  }

  function rendreConsommation(a) {
    const cont = el('div');
    const st = a.stats || {};
    const mois = st.consommationMensuelle || [];
    if (mois.some((m) => m.quantite > 0)) {
      cont.appendChild(ui.carte('Consommation mensuelle (12 derniers mois, toutes sorties)', ui.graphiqueBarres(mois.map((m) => ({ label: nomMois(m.mois), valeur: m.quantite, couleur: TYPES.sortie.couleur })), { hauteur: 170 })));
    }
    const ots = a.ots || [];
    if (!ots.length) {
      cont.appendChild(ui.vide('Cet article n\'a encore été consommé par aucun ordre de travail.', 'ot'));
      return cont;
    }
    const total = ots.reduce((s, o) => s + (Number(o.valeur) || 0), 0);
    cont.appendChild(ui.table({
      lignes: ots, recherche: ots.length > 10 ? 'Rechercher un OT…' : false, compact: true, triInitial: { cle: 'derniereDate', sens: 'desc' },
      onClic: (o) => (o.existe ? GMAO.navigate('#/ot/' + o.otId) : null),
      colonnes: [
        { cle: 'numero', label: 'OT', rendu: (o) => (o.existe ? lienVue('#/ot/' + o.otId, o.numero || 'OT #' + o.otId) : el('span', { class: 'texte-2' }, 'OT #' + o.otId)) },
        { cle: 'titre', label: 'Intitulé', rendu: (o) => el('span', { class: 'cellule-principale' }, o.titre) },
        { cle: 'equipementNom', label: 'Équipement', rendu: (o) => (o.equipementId ? lienVue('#/equipements/' + o.equipementId, o.equipementNom) : el('span', { class: 'texte-2' }, '—')) },
        { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
        { cle: 'statut', label: 'Statut', liste: 'statutsOT' },
        { cle: 'quantite', label: 'Quantité nette', aligner: 'droite', rendu: (o) => el('span', { class: 'texte-gras' }, qte(o.quantite, a.uniteCode)), valeurTri: (o) => o.quantite },
        colMontant('valeur', 'Valeur'),
        colDate('derniereDate', 'Dernière sortie', false),
      ],
    }).el);
    cont.appendChild(el('div', { class: 'tableau-pied', style: { justifyContent: 'flex-end' } }, el('span', null, `${ots.length} OT · valeur consommée `, el('strong', null, ui.formatMontant(total)))));
    return cont;
  }

  function rendreEquipements(a) {
    const cont = el('div');
    const eqs = a.equipements || [];
    if (!eqs.length) cont.appendChild(ui.vide('Aucun équipement compatible n\'est déclaré pour cet article.', 'equipements'));
    else {
      cont.appendChild(ui.table({
        lignes: eqs, recherche: eqs.length > 10 ? 'Rechercher un équipement…' : false, compact: true, pagination: false,
        onClic: (e) => GMAO.navigate('#/equipements/' + e.id), ligneClasse: (e) => (e.actif === false ? 'inactif' : ''),
        colonnes: [
          { cle: 'numero', label: 'Numéro', rendu: (e) => lienVue('#/equipements/' + e.id, e.numero || '#' + e.id) },
          { cle: 'nom', label: 'Équipement', rendu: (e) => el('div', null, el('div', { class: 'cellule-principale' }, e.nom), e.localisation ? el('div', { class: 'cellule-secondaire' }, e.localisation) : null) },
          { cle: 'secteurId', label: 'Secteur', rendu: (e) => (e.secteurId != null ? ui.cheminSecteur(e.secteurId) : '—') },
          { cle: 'typeCode', label: 'Type', rendu: (e) => (e.typeCode ? ui.libelle('typesEquipement', e.typeCode) : '—') },
          { cle: 'etatCode', label: 'État', liste: 'etatsEquipement' },
          { cle: 'criticiteCode', label: 'Criticité', liste: 'criticites' },
        ],
      }).el);
    }
    cont.appendChild(el('p', { class: 'texte-2 texte-petit mt' }, 'La compatibilité se modifie depuis le formulaire de l\'article (bouton « Modifier », champ « Équipements compatibles »).'));
    return cont;
  }

  function imprimerFiche(a) {
    const ligne = (l, v) => `<dt>${esc(l)}</dt><dd>${esc(v == null || v === '' ? '—' : v)}</dd>`;
    let html = `<h1>${esc(a.code)} — ${esc(a.designation)}</h1><dl>`;
    html += ligne('Catégorie', a.categorieCode ? ui.libelle('categoriesArticles', a.categorieCode) : '');
    html += ligne('Unité', libUnite(a.uniteCode));
    html += ligne('Stock actuel', qte(a.quantite, a.uniteCode));
    html += ligne('Seuil minimum', qte(a.seuilMin, a.uniteCode));
    html += ligne('Quantité de réapprovisionnement', qte(a.quantiteCommande, a.uniteCode));
    html += ligne('Emplacement', a.emplacement);
    html += ligne('Magasin / secteur', a.secteurId != null ? ui.cheminSecteur(a.secteurId) : 'Magasin central');
    html += ligne('Prix unitaire', ui.formatMontant(a.prixUnitaire));
    html += ligne('Valeur du stock', ui.formatMontant(a.valeur));
    html += ligne('Fournisseur', a.fournisseurNom);
    html += ligne('Référence fournisseur', a.referenceFournisseur);
    for (const c of ui.champsPersoAffichage('articles', a)) html += ligne(c.label, c.valeur);
    html += '</dl>';
    if (a.description) html += `<h2>Description</h2><p style="white-space:pre-wrap">${esc(a.description)}</p>`;
    if ((a.equipements || []).length) html += `<h2>Équipements compatibles</h2><table><thead><tr><th>Numéro</th><th>Équipement</th><th>Secteur</th></tr></thead><tbody>${a.equipements.map((e) => `<tr><td>${esc(e.numero)}</td><td>${esc(e.nom)}</td><td>${esc(e.secteurId != null ? ui.cheminSecteur(e.secteurId) : '')}</td></tr>`).join('')}</tbody></table>`;
    const mv = (a.mouvements || []).slice(0, 20);
    if (mv.length) html += `<h2>Derniers mouvements</h2><table><thead><tr><th>Date</th><th>Type</th><th>Quantité</th><th>Stock après</th><th>OT</th><th>Motif</th><th>Par</th></tr></thead><tbody>${mv.map((m) => `<tr><td>${esc(ui.formatDateHeure(m.date))}</td><td>${esc((TYPES[m.type] || {}).label || m.type)}</td><td>${esc(m.type === 'inventaire' ? '= ' + ui.formatNombre(m.quantite) : ((m.type === 'sortie' ? '−' : '+') + ui.formatNombre(m.quantite)))}</td><td>${esc(ui.formatNombre(m.quantiteApres))}</td><td>${esc(m.otNumero || (m.otMasque ? 'Hors périmètre' : ''))}</td><td>${esc(m.motif || '')}</td><td>${esc(m.userNom || '')}</td></tr>`).join('')}</tbody></table>`;
    ui.imprimer(`Fiche article ${a.code}`, html);
  }

  // ----- Enregistrement de la vue ----------------------------------------------------------------
  GMAO.registerView(MODULE, {
    titre: 'Stock & pièces', icone: 'stock',
    async rendu(container, { params, query }) {
      cacheRefs = null;
      if (params[0]) {
        const id = Number(params[0]);
        if (!Number.isInteger(id) || id <= 0) { container.appendChild(ui.vide('Article introuvable', 'alerte')); return; }
        await afficherFiche(container, id);
        majBadge(false);
        return;
      }
      await afficherListe(container, query || {});
    },
  });
})();
