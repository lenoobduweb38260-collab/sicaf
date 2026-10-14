/**
 * Vue Plans 3D des sites.
 *  - #/plans : liste des plans (cartes avec miniature), recherche, filtre par site, export CSV,
 *    création (assistant : dimensions, niveaux, modèle de départ), import / export JSON, duplication.
 *    #/plans?equipementId=ID : localise un équipement et ouvre le plan correspondant.
 *  - #/plans/:id : fiche plein écran (canevas 3D + panneau latéral).
 *    Consultation : navigation 3D, vue de dessus, niveaux, recherche, modes de couleur (état, criticité,
 *    secteur, OT ouverts, couleurs d'origine), légende, étiquettes, plein écran, capture PNG,
 *    panneau d'information (état, OT, demandes, liens vers l'équipement, nouvelle demande, nouvel OT),
 *    rafraîchissement de l'état des équipements toutes les 60 s. ?equipementId=ID → focus direct.
 *    Édition (plans › modifier) : sélection / déplacement (magnétisme), rotation, zones, bâtiments, murs,
 *    allées, machines, installations, portes, textes ; dupliquer, supprimer, copier / coller,
 *    annuler / rétablir ; propriétés ; liaison aux équipements (ou création) et aux secteurs (ou création) ;
 *    fond de plan à décalquer (calibrage par deux points) ; niveaux ; enregistrement avec contrôle de version.
 * Le rendu est assuré par la bibliothèque client/js/lib/moteur3d.js (WebGL, repli Canvas 2D).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'plans';
  const SVGNS = 'http://www.w3.org/2000/svg';

  // =====================================================================================
  // Référentiels
  // =====================================================================================
  const TYPES = {
    zone: { label: 'Zone', pluriel: 'Zones', icone: 'zone', couleur: '#3b82f6' },
    batiment: { label: 'Bâtiment', pluriel: 'Bâtiments', icone: 'batiment', couleur: '#cbd5e1' },
    mur: { label: 'Mur / cloison', pluriel: 'Murs', icone: 'mur', couleur: '#94a3b8' },
    allee: { label: 'Allée de circulation', pluriel: 'Allées', icone: 'allee', couleur: '#facc15' },
    machine: { label: 'Machine', pluriel: 'Machines', icone: 'machine', couleur: '#2563eb' },
    installation: { label: 'Installation', pluriel: 'Installations', icone: 'installation', couleur: '#6b7280' },
    porte: { label: 'Porte', pluriel: 'Portes', icone: 'porte', couleur: '#92400e' },
    texte: { label: 'Texte', pluriel: 'Textes', icone: 'texte', couleur: '#1f2937' },
  };
  /** Catégories d'installations : dimensions (m) et couleurs réalistes par défaut. */
  const CATEGORIES = {
    armoire_electrique: { label: 'Armoire électrique', l: 1.2, p: 0.6, h: 2.0, couleur: '#9ca3af' },
    convoyeur: { label: 'Convoyeur', l: 6, p: 0.8, h: 0.9, couleur: '#475569' },
    rack: { label: 'Rack de stockage', l: 2.7, p: 1.1, h: 5, couleur: '#f97316' },
    compresseur: { label: 'Compresseur', l: 1.9, p: 1.1, h: 1.6, couleur: '#0284c7' },
    chaudiere: { label: 'Chaudière', l: 2, p: 1.5, h: 2, couleur: '#ef4444' },
    cuve: { label: 'Cuve / réservoir', l: 2, p: 2, h: 3, couleur: '#94a3b8', forme: 'cylindre' },
    reseau_air: { label: 'Réseau d\'air comprimé', segment: true, epaisseur: 0.15, z: 4, couleur: '#0284c7' },
    reseau_eau: { label: 'Réseau d\'eau', segment: true, epaisseur: 0.15, z: 3.5, couleur: '#059669' },
    extincteur: { label: 'Extincteur', l: 0.3, p: 0.3, h: 0.7, couleur: '#dc2626', forme: 'cylindre' },
    issue_secours: { label: 'Issue de secours', l: 1.4, p: 0.3, h: 2.2, couleur: '#16a34a' },
    poste_travail: { label: 'Poste de travail', l: 1.6, p: 0.8, h: 0.9, couleur: '#a16207' },
    bureau: { label: 'Bureau', l: 1.6, p: 0.8, h: 0.75, couleur: '#78716c' },
    quai: { label: 'Quai de chargement', l: 3.5, p: 3.5, h: 1.2, couleur: '#64748b' },
    autre: { label: 'Autre installation', l: 1, p: 1, h: 1, couleur: '#6b7280' },
  };
  const SANS_ETIQUETTE = new Set(['extincteur', 'issue_secours', 'reseau_air', 'reseau_eau', 'poste_travail', 'bureau']);
  const MODES_COULEUR = [
    { code: 'etat', label: 'État des équipements' },
    { code: 'ot', label: 'OT ouverts' },
    { code: 'criticite', label: 'Criticité' },
    { code: 'secteur', label: 'Secteur' },
    { code: 'origine', label: 'Couleurs d\'origine' },
  ];
  const ALERTES = { urgent: { label: 'Intervention urgente', couleur: '#dc2626' }, en_cours: { label: 'OT / demande en cours', couleur: '#f59e0b' }, aucun: { label: 'Aucune intervention', couleur: '#16a34a' } };
  const NEUTRE = '#9ca3af';
  const OUTILS = [
    { cle: 'selection', label: 'Sélection / déplacement', icone: 'curseur', touche: 'V', aide: 'Cliquez pour sélectionner (Maj : ajouter à la sélection), glissez pour déplacer (Alt : sans magnétisme). Suppr : supprimer · Ctrl+D : dupliquer · R / Maj+R : pivoter de 15° · flèches : décaler.' },
    { cle: 'rotation', label: 'Rotation', icone: 'rotation', touche: 'O', aide: 'Glissez autour de la sélection pour la faire pivoter (pas de 15°, Alt : rotation libre).' },
    { cle: 'zone', label: 'Zone', icone: 'zone', touche: 'Z', aide: 'Glissez pour tracer une zone rectangulaire, ou cliquez sommet par sommet puis double-cliquez (ou Entrée) pour fermer le polygone. Échap : annuler.' },
    { cle: 'batiment', label: 'Bâtiment', icone: 'batiment', touche: 'B', aide: 'Glissez pour tracer un bâtiment rectangulaire, ou cliquez sommet par sommet puis double-cliquez (ou Entrée) pour fermer. Échap : annuler.' },
    { cle: 'mur', label: 'Mur', icone: 'mur', touche: 'M', aide: 'Cliquez le départ puis chaque angle : les murs s\'enchaînent. Maj : angles de 45°. Double-clic, Entrée ou Échap pour terminer.' },
    { cle: 'allee', label: 'Allée de circulation', icone: 'allee', touche: 'A', aide: 'Cliquez le départ puis l\'arrivée de l\'allée (tracé enchaîné). Maj : angles de 45°. Échap pour terminer.' },
    { cle: 'machine', label: 'Machine', icone: 'machine', touche: 'E', aide: 'Cliquez sur le plan pour placer une machine, puis liez-la à un équipement dans le panneau Propriétés.' },
    { cle: 'installation', label: 'Installation', icone: 'installation', touche: 'I', aide: 'Choisissez une catégorie dans la palette puis cliquez sur le plan pour la placer (réseaux : cliquez départ et arrivée).' },
    { cle: 'porte', label: 'Porte', icone: 'porte', touche: 'P', aide: 'Cliquez sur un mur (ou à proximité) pour y placer une porte alignée.' },
    { cle: 'texte', label: 'Texte', icone: 'texte', touche: 'T', aide: 'Cliquez sur le plan pour poser un texte.' },
  ];
  const ICONES_LOCALES = {
    curseur: '<path d="M5 3l6.5 17 2.4-7.1L21 10.5z"/>',
    rotation: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
    zone: '<path d="M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8"/>',
    batiment: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6M3 21h18"/>',
    mur: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 12h18M9 5v7M15 12v7"/>',
    allee: '<path d="M8 3L4 21M16 3l4 18M12 4v3M12 10.5v3M12 17v3"/>',
    machine: '<rect x="3" y="8" width="18" height="11" rx="1.5"/><path d="M7 8V5h10v3M7 13.5h5M16 13.5h1.5"/>',
    installation: '<path d="M13 2L4 14h7l-1 8 10-12h-7z"/>',
    porte: '<path d="M4 21h16M6 21V3h12v18"/><circle cx="14.5" cy="12" r="1"/>',
    texte: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    annuler: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    retablir: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
    pleinEcran: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    quitterPleinEcran: '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>',
    recentrer: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    dessus: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
    niveaux: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    etiquette: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
    verrou: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    coller: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    grille: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
    moins: '<path d="M5 12h14"/>',
    panneau: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    lien: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  };
  function ic(nom, taille) {
    let svg;
    if (ICONES_LOCALES[nom]) {
      svg = document.createElementNS(SVGNS, 'svg');
      for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
      svg.innerHTML = ICONES_LOCALES[nom];
    } else svg = icone(nom);
    if (taille) Object.assign(svg.style, { width: taille + 'px', height: taille + 'px' });
    return svg;
  }

  // =====================================================================================
  // Utilitaires
  // =====================================================================================
  const can = (action) => GMAO.can(MODULE, action);
  const cfg = () => Object.assign({ grilleM: 0.5, uniteAffichage: 'm', couleurParDefaut: 'etat', afficherEtiquettes: true }, (GMAO.config || {}).plans || {});
  const UNITES = { m: { f: 1, l: 'm', dec: 2 }, cm: { f: 100, l: 'cm', dec: 0 }, mm: { f: 1000, l: 'mm', dec: 0 } };
  const unite = () => UNITES[cfg().uniteAffichage] || UNITES.m;
  const versU = (v) => (v == null || v === '' ? '' : Math.round(Number(v) * unite().f * 1000) / 1000);
  const depuisU = (v) => (v == null || v === '' ? null : Number(v) / unite().f);
  const fmtL = (v) => (v == null || isNaN(Number(v)) ? '—' : `${ui.formatNombre(Number(v) * unite().f, unite().dec)} ${unite().l}`);
  const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
  const copie = (o) => JSON.parse(JSON.stringify(o));
  const estSegment = (o) => o.type === 'mur' || o.type === 'allee' || (o.type === 'installation' && (CATEGORIES[o.categorie] || {}).segment);
  const sombre = () => document.documentElement.getAttribute('data-theme') === 'sombre';
  const libType = (o) => (o.type === 'installation' ? (CATEGORIES[o.categorie] || CATEGORIES.autre).label : (TYPES[o.type] || {}).label || o.type);
  function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x6b7280; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function melanger(a, b, t) { const x = hexRgb(a), y = hexRgb(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
  function nouvelId(existants) {
    for (let i = 0; i < 100; i++) {
      const id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (!existants || !existants.has(id)) return id;
    }
    return 'o' + Math.random().toString(36).slice(2, 12);
  }
  function rectPoints(o) {
    const a = (o.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), w = (o.largeur || 1) / 2, p = (o.profondeur || 1) / 2;
    return [[-w, -p], [w, -p], [w, p], [-w, p]].map(([lx, ly]) => [r3(o.x + lx * c - ly * s), r3(o.y + lx * s + ly * c)]);
  }
  function pointDans(x, y, pts) {
    let d = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)) d = !d;
    }
    return d;
  }
  function aire(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a / 2); }
  function telechargerCanvas(canvas, nom) {
    if (canvas.toBlob) canvas.toBlob((b) => { if (b) ui.telecharger(nom, b, 'image/png'); }, 'image/png');
    else { const a = el('a', { href: canvas.toDataURL('image/png'), download: nom }); document.body.appendChild(a); a.click(); a.remove(); }
  }
  /** Secteurs dans lesquels l'utilisateur peut créer / déplacer un plan (portée d'écriture, hors lecture seule). */
  function optionsSecteursEcrivables(opts = {}) {
    const p = GMAO.perms || {};
    const tous = p.portee === 'tous';
    return ui.optionsSecteurs({ vide: false }).filter((o) => tous || (p.secteurIds || []).includes(Number(o.value))).map((o) => {
      const s = ui.secteur(o.value);
      return Object.assign({}, o, { label: o.label + (s && s.type ? ` — ${ui.libelle('typesSecteur', s.type)}` : '') });
    }).concat(opts.vide ? [] : []);
  }
  const siteDe = (secteurId) => { const s = ui.secteur(secteurId); return s ? (s.siteId != null ? s.siteId : (s.type === 'site' ? s.id : null)) : null; };

  // ----- Styles de la vue (injectés une fois, variables de thème) --------------------------
  function injecterStyles() {
    if (document.getElementById('plans3d-styles')) return;
    const st = el('style', { id: 'plans3d-styles' });
    st.textContent = `
      .p3d-cartes { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 16px; }
      .p3d-carte { padding: 0; margin: 0; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; transition: box-shadow .15s, transform .15s; }
      .p3d-carte:hover { box-shadow: var(--ombre-2); transform: translateY(-2px); }
      .p3d-mini { height: 176px; background: var(--surface-2); border-bottom: 1px solid var(--bordure); position: relative; }
      .p3d-mini svg { width: 100%; height: 100%; display: block; }
      .p3d-mini .p3d-mini-badge { position: absolute; top: 8px; left: 8px; }
      .p3d-carte-corps { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
      .p3d-carte-titre { font-weight: 600; font-size: 15px; line-height: 1.3; }
      .p3d-carte-stats { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--texte-2); }
      .p3d-carte-stats span { display: inline-flex; align-items: center; gap: 4px; }
      .p3d-carte-stats svg { width: 14px; height: 14px; }
      .p3d-carte-pied { display: flex; align-items: center; gap: 4px; border-top: 1px solid var(--bordure); padding: 6px 8px; }
      .p3d-carte-pied .espace { flex: 1; }
      .p3d-fiche { display: flex; flex-direction: column; height: calc(100vh - var(--entete-hauteur) - 44px); min-height: 520px; background: var(--surface); border: 1px solid var(--bordure); border-radius: var(--rayon); box-shadow: var(--ombre); overflow: hidden; }
      .p3d-fiche.p3d-plein-ecran { position: fixed; inset: 0; z-index: 90; height: auto; min-height: 0; border-radius: 0; border: 0; }
      .p3d-barre { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--bordure); flex-wrap: wrap; background: var(--surface); position: relative; z-index: 6; }
      .p3d-barre select { width: auto; padding: 5px 8px; font-size: 13px; }
      .p3d-barre .espace { flex: 1; }
      .p3d-barre .btn { padding: 5px 9px; }
      .p3d-barre .btn-icone { padding: 6px; border: 1px solid var(--bordure-2); background: var(--surface); }
      .p3d-barre .btn-icone.actif { background: var(--primaire-clair); color: var(--primaire); border-color: var(--primaire); }
      .p3d-titre { display: flex; flex-direction: column; min-width: 0; margin: 0 6px 0 2px; }
      .p3d-titre .t { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
      .p3d-titre .s { font-size: 12px; color: var(--texte-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
      .p3d-point { width: 9px; height: 9px; border-radius: 50%; background: var(--alerte); box-shadow: 0 0 0 2px var(--surface); margin-left: 2px; }
      .p3d-corps { flex: 1; display: flex; min-height: 0; position: relative; }
      .p3d-outils { width: 50px; flex-shrink: 0; border-right: 1px solid var(--bordure); display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 0; background: var(--surface-2); overflow-y: auto; }
      .p3d-outil { width: 38px; height: 36px; display: flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--texte-2); cursor: pointer; flex-shrink: 0; }
      .p3d-outil:hover:not(:disabled) { background: var(--fond); color: var(--texte); }
      .p3d-outil.actif { background: var(--primaire-clair); color: var(--primaire); border-color: var(--primaire); }
      .p3d-outil svg { width: 19px; height: 19px; }
      .p3d-outil:disabled { opacity: .35; cursor: default; }
      .p3d-sep { width: 26px; border-top: 1px solid var(--bordure-2); margin: 5px 0; flex-shrink: 0; }
      .p3d-scene { flex: 1; position: relative; min-width: 0; background: var(--fond); }
      .p3d-panneau { width: 330px; flex-shrink: 0; border-left: 1px solid var(--bordure); overflow-y: auto; background: var(--surface); padding: 12px 14px 20px; }
      .p3d-panneau.masque-panneau { display: none; }
      .p3d-panneau h3 { font-size: 15px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
      .p3d-panneau h3 svg { width: 18px; height: 18px; color: var(--primaire); flex-shrink: 0; }
      .p3d-section { margin-top: 14px; }
      .p3d-section > .p3d-section-titre { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--texte-2); font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      .p3d-panneau .details { grid-template-columns: max-content 1fr; font-size: 13px; gap: 5px 12px; }
      .p3d-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .p3d-actions .btn { flex: 1 1 auto; justify-content: center; }
      .p3d-indicateurs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
      .p3d-ind { border: 1px solid var(--bordure); border-radius: 8px; padding: 7px 9px; background: var(--surface-2); }
      .p3d-ind .v { font-size: 19px; font-weight: 700; line-height: 1.1; }
      .p3d-ind .l { font-size: 11.5px; color: var(--texte-2); }
      .p3d-liste { display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow-y: auto; }
      .p3d-item { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 6px; cursor: pointer; font-size: 13px; min-width: 0; }
      .p3d-item:hover { background: var(--fond); }
      .p3d-item .nom { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .p3d-item .num { color: var(--texte-2); font-size: 11.5px; }
      .p3d-pastille { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; border: 1px solid rgba(0,0,0,.15); }
      .p3d-commandes { position: absolute; right: 10px; top: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 4; }
      .p3d-cmd-groupe { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--bordure); border-radius: 8px; box-shadow: var(--ombre); overflow: hidden; }
      .p3d-cmd { width: 34px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: 0; border-bottom: 1px solid var(--bordure); color: var(--texte-2); cursor: pointer; padding: 0; }
      .p3d-cmd:last-child { border-bottom: 0; }
      .p3d-cmd:hover:not(:disabled) { background: var(--fond); color: var(--texte); }
      .p3d-cmd.actif { background: var(--primaire-clair); color: var(--primaire); }
      .p3d-cmd:disabled { opacity: .35; cursor: default; }
      .p3d-cmd svg { width: 17px; height: 17px; }
      .p3d-legende { position: absolute; left: 10px; bottom: 34px; background: color-mix(in srgb, var(--surface) 93%, transparent); border: 1px solid var(--bordure); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: var(--ombre); max-height: 46%; overflow: auto; z-index: 3; min-width: 150px; color: var(--texte); }
      .p3d-legende .lt { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--texte-2); margin-bottom: 4px; }
      .p3d-legende .li { display: flex; align-items: center; gap: 7px; padding: 1px 0; white-space: nowrap; }
      .p3d-statut { position: absolute; left: 0; right: 0; bottom: 0; min-height: 26px; display: flex; align-items: center; gap: 14px; padding: 3px 10px; font-size: 12px; color: var(--texte-2); background: color-mix(in srgb, var(--surface) 92%, transparent); border-top: 1px solid var(--bordure); z-index: 3; font-variant-numeric: tabular-nums; }
      .p3d-statut > span { white-space: nowrap; flex-shrink: 0; }
      .p3d-statut .espace { flex: 1; }
      .p3d-statut .aide-outil { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex-shrink: 1; }
      .p3d-infobulle { position: absolute; pointer-events: none; background: var(--surface); color: var(--texte); border: 1px solid var(--bordure-2); border-radius: 8px; padding: 6px 9px; font-size: 12px; box-shadow: var(--ombre-2); z-index: 4; max-width: 280px; }
      .p3d-infobulle .t { font-weight: 600; }
      .p3d-recherche { position: relative; }
      .p3d-recherche input { width: 210px; padding: 5px 9px 5px 28px; font-size: 13px; }
      .p3d-recherche > svg { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--texte-2); }
      .p3d-resultats { position: absolute; top: calc(100% + 4px); left: 0; width: 320px; max-height: 340px; overflow-y: auto; background: var(--surface); border: 1px solid var(--bordure); border-radius: 8px; box-shadow: var(--ombre-2); z-index: 20; padding: 4px; }
      .p3d-resultats .p3d-item.actif { background: var(--primaire-clair); }
      .p3d-palette { position: absolute; left: 8px; top: 8px; z-index: 5; width: 236px; background: var(--surface); border: 1px solid var(--bordure); border-radius: 10px; box-shadow: var(--ombre-2); padding: 6px; max-height: calc(100% - 50px); overflow-y: auto; }
      .p3d-palette .pt { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--texte-2); font-weight: 700; padding: 4px 6px; }
      .p3d-palette .p3d-item.actif { background: var(--primaire-clair); color: var(--primaire); font-weight: 600; }
      .p3d-bandeau { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 5; display: flex; gap: 8px; align-items: center; background: var(--surface); border: 1px solid var(--bordure); border-radius: 10px; box-shadow: var(--ombre-2); padding: 7px 10px; font-size: 13px; max-width: calc(100% - 40px); }
      .p3d-lien-eq { border: 1px solid var(--bordure); border-radius: 8px; padding: 8px 10px; background: var(--surface-2); display: flex; flex-direction: column; gap: 6px; }
      .p3d-recherche-eq { position: relative; }
      .p3d-recherche-eq .p3d-resultats { width: 100%; }
      .p3d-panneau .formulaire { gap: 8px 10px; }
      .p3d-panneau .champ label { font-size: 11.5px; }
      .p3d-panneau input, .p3d-panneau select { padding: 5px 8px; font-size: 13px; }
      .p3d-niveaux-ligne { display: grid; grid-template-columns: 1fr 90px 90px 34px; gap: 6px; align-items: center; margin-bottom: 6px; }
      .p3d-vide-scene { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2; }
      .p3d-vide-scene > div { pointer-events: auto; background: var(--surface); border: 1px dashed var(--bordure-2); border-radius: 12px; padding: 16px 20px; max-width: 380px; text-align: center; color: var(--texte-2); box-shadow: var(--ombre); }
      @media (max-width: 1100px) { .p3d-panneau { width: 280px; } .p3d-recherche input { width: 170px; } }
      @media (max-width: 760px) { .p3d-panneau { position: absolute; right: 0; top: 0; bottom: 0; z-index: 7; box-shadow: var(--ombre-2); } }
    `;
    document.head.appendChild(st);
  }

  // =====================================================================================
  // Miniature SVG (vue de dessus) à partir de l'aperçu géométrique
  // =====================================================================================
  function miniature(plan) {
    const L = (plan.dimensions || {}).largeur || 50, P = (plan.dimensions || {}).profondeur || 50;
    const svg = document.createElementNS(SVGNS, 'svg');
    const m = Math.max(L, P) * 0.04;
    svg.setAttribute('viewBox', `${-m} ${-m} ${L + 2 * m} ${P + 2 * m}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Miniature du plan ' + (plan.nom || ''));
    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.appendChild(e); return e; };
    mk('rect', { x: 0, y: 0, width: L, height: P, fill: 'var(--surface)', stroke: 'var(--bordure-2)', 'stroke-width': Math.max(L, P) * 0.004 });
    const fin = Math.max(L, P) * 0.0025;
    for (const a of plan.apercu || []) {
      const c = a.c || '#6b7280';
      if (a.p) mk('polygon', { points: a.p.map((q) => q.join(',')).join(' '), fill: c, 'fill-opacity': a.t === 'batiment' ? 0.28 : 0.3, stroke: a.t === 'batiment' ? melanger(c, '#000000', 0.45) : c, 'stroke-width': a.t === 'batiment' ? fin * 2 : fin });
      else if (a.x2 != null) mk('line', { x1: a.x, y1: a.y, x2: a.x2, y2: a.y2, stroke: a.t === 'mur' ? '#64748b' : c, 'stroke-width': Math.max(a.e || 0.2, fin * 2), 'stroke-opacity': a.t === 'allee' ? 0.75 : 1, 'stroke-linecap': 'butt' });
      else if (a.f) mk('ellipse', { cx: a.x, cy: a.y, rx: a.l / 2, ry: a.d / 2, fill: c, transform: `rotate(${a.r || 0} ${a.x} ${a.y})` });
      else mk('rect', { x: a.x - a.l / 2, y: a.y - a.d / 2, width: a.l, height: a.d, fill: c, 'fill-opacity': a.t === 'zone' || a.t === 'batiment' ? 0.3 : 0.95, transform: `rotate(${a.r || 0} ${a.x} ${a.y})` });
    }
    return svg;
  }

  // =====================================================================================
  // LISTE DES PLANS
  // =====================================================================================
  const memo = { recherche: '', siteId: '', tri: 'numero' };

  async function rendreListe(container, query) {
    injecterStyles();
    const actions = [];
    if (can('creer')) {
      actions.push(ui.bouton('Importer', { icone: 'import', onClic: () => importerPlan() }));
      actions.push(ui.bouton('Nouveau plan', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirNouveauPlan() }));
    }
    container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'plan3d', sousTitre: 'Implantation 3D des sites : bâtiments, zones, machines et installations, avec l\'état des équipements en temps réel', actions }));

    // Localisation d'un équipement (#/plans?equipementId=ID)
    if (query.equipementId) {
      try {
        const loc = await api.get('/api/plans-localiser/' + encodeURIComponent(query.equipementId));
        if (loc.length === 1) { GMAO.navigate(`#/plans/${loc[0].planId}?equipementId=${encodeURIComponent(query.equipementId)}`); return; }
        if (loc.length > 1) {
          container.appendChild(ui.carte('Cet équipement figure sur plusieurs plans', el('div', { class: 'p3d-liste' }, loc.map((l) => el('a', { class: 'p3d-item', href: `#/plans/${l.planId}?equipementId=${encodeURIComponent(query.equipementId)}` }, ic('plan3d', 16), el('span', { class: 'nom' }, l.planNom), el('span', { class: 'num' }, l.planNumero))))));
        } else container.appendChild(ui.alerte('Cet équipement n\'est placé sur aucun plan que vous pouvez consulter.', 'alerte'));
      } catch (e) { container.appendChild(ui.alerte(e.message, 'alerte')); }
    }

    let plans = [];
    try { plans = await api.get('/api/plans'); } catch (e) { container.appendChild(ui.alerte(e.message, 'danger')); return; }

    const sites = (GMAO.refs.secteurs || []).filter((s) => s.type === 'site');
    const inputRech = el('input', { type: 'search', placeholder: 'Rechercher un plan, un site…', value: memo.recherche, style: { maxWidth: '280px' } });
    const selSite = el('select', { title: 'Filtrer par site' }, el('option', { value: '' }, 'Tous les sites'), sites.map((s) => el('option', { value: String(s.id) }, s.nom)));
    selSite.value = memo.siteId;
    const selTri = el('select', { title: 'Trier' }, el('option', { value: 'numero' }, 'Tri : numéro'), el('option', { value: 'nom' }, 'Tri : nom'), el('option', { value: 'recent' }, 'Tri : modifiés récemment'));
    selTri.value = memo.tri;
    const compteur = el('span', { class: 'texte-2 texte-petit' });
    const grille = el('div', { class: 'p3d-cartes' });
    const filtrees = () => {
      const q = memo.recherche.toLowerCase();
      let rows = plans.filter((p) => (!memo.siteId || String(p.siteId) === memo.siteId) && (!q || [p.numero, p.nom, p.description, p.secteurChemin, p.siteNom].some((v) => String(v || '').toLowerCase().includes(q))));
      if (memo.tri === 'nom') rows = rows.slice().sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'));
      else if (memo.tri === 'recent') rows = rows.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return rows;
    };
    const exporter = () => ui.exportCsv('plans-3d.csv', [
      { label: 'Numéro', cle: 'numero' }, { label: 'Nom', cle: 'nom' }, { label: 'Site', cle: 'siteNom' }, { label: 'Secteur', cle: 'secteurChemin' },
      { label: 'Largeur (m)', exportValeur: (p) => ui.formatNombre(p.dimensions.largeur) }, { label: 'Profondeur (m)', exportValeur: (p) => ui.formatNombre(p.dimensions.profondeur) },
      { label: 'Niveaux', exportValeur: (p) => (p.niveaux || []).map((n) => n.nom).join(', ') }, { label: 'Objets', cle: 'nbObjets' }, { label: 'Équipements liés', cle: 'nbLies' },
      { label: 'Machines', exportValeur: (p) => (p.parType || {}).machine || 0 }, { label: 'Fond de plan', exportValeur: (p) => (p.fond ? 'Oui' : 'Non') },
      { label: 'Modifié le', exportValeur: (p) => ui.formatDateHeure(p.updatedAt) }, { label: 'Modifié par', cle: 'updatedByNom' }, { label: 'Description', cle: 'description' },
    ], filtrees());
    const rendre = () => {
      ui.vider(grille);
      const rows = filtrees();
      compteur.textContent = `${rows.length} plan${rows.length > 1 ? 's' : ''}`;
      if (!rows.length) {
        grille.appendChild(el('div', { style: { gridColumn: '1 / -1' } }, ui.vide(plans.length ? 'Aucun plan ne correspond à la recherche.' : 'Aucun plan 3D pour le moment. Créez le plan de votre site pour y placer vos bâtiments, zones, machines et installations.', 'plan3d'),
          !plans.length && can('creer') ? el('div', { class: 'texte-centre' }, ui.bouton('Créer le premier plan', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirNouveauPlan() })) : null));
        return;
      }
      for (const p of rows) grille.appendChild(carte(p, rafraichir));
    };
    const rafraichir = async () => { try { plans = await api.get('/api/plans'); rendre(); } catch (e) { erreur(e); } };
    inputRech.addEventListener('input', ui.debounce(() => { memo.recherche = inputRech.value.trim(); rendre(); }, 150));
    selSite.addEventListener('change', () => { memo.siteId = selSite.value; rendre(); });
    selTri.addEventListener('change', () => { memo.tri = selTri.value; rendre(); });
    container.appendChild(el('div', { class: 'barre-outils' }, inputRech, sites.length > 1 ? selSite : null, selTri, compteur, el('span', { class: 'espace' }), ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: exporter })));
    container.appendChild(grille);
    rendre();
  }

  function carte(p, rafraichir) {
    const lecture = GMAO.siteLectureSeule(p.secteurId);
    const peutModifier = can('modifier') && p.droits && p.droits.modifier && !lecture;
    const peutSupprimer = can('supprimer') && p.droits && p.droits.supprimer && !lecture;
    const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };
    const nbMachines = (p.parType || {}).machine || 0;
    return el('div', { class: 'carte p3d-carte', dataset: { id: p.id }, tabindex: 0, onclick: () => GMAO.navigate('#/plans/' + p.id), onkeydown: (ev) => { if (ev.key === 'Enter') GMAO.navigate('#/plans/' + p.id); } },
      el('div', { class: 'p3d-mini' }, miniature(p), lecture ? el('span', { class: 'p3d-mini-badge' }, ui.badge('Lecture seule', '#6b7280')) : null),
      el('div', { class: 'p3d-carte-corps' },
        el('div', { class: 'p3d-carte-titre' }, p.nom),
        el('div', { class: 'texte-2 texte-petit' }, [p.numero, p.secteurChemin || 'Sans site'].filter(Boolean).join(' · ')),
        el('div', { class: 'p3d-carte-stats' },
          el('span', { title: 'Objets' }, ic('cube'), `${p.nbObjets} objet${p.nbObjets > 1 ? 's' : ''}`),
          el('span', { title: 'Machines' }, ic('machine'), `${nbMachines} machine${nbMachines > 1 ? 's' : ''}`),
          el('span', { title: 'Équipements liés' }, ic('lien'), `${p.nbLies} lié${p.nbLies > 1 ? 's' : ''}`),
          el('span', { title: 'Niveaux' }, ic('niveaux'), `${(p.niveaux || []).length} niveau${(p.niveaux || []).length > 1 ? 'x' : ''}`),
          el('span', { title: 'Dimensions' }, `${ui.formatNombre(p.dimensions.largeur)} × ${ui.formatNombre(p.dimensions.profondeur)} m`)),
        el('div', { class: 'texte-2 texte-petit' }, `Modifié ${ui.relatif(p.updatedAt)}${p.updatedByNom ? ' par ' + p.updatedByNom : ''}`)),
      el('div', { class: 'p3d-carte-pied' },
        ui.bouton('Ouvrir', { icone: 'voir', classe: 'btn-sm btn-lien', onClic: stop(() => GMAO.navigate('#/plans/' + p.id)) }),
        peutModifier ? ui.bouton('Éditer', { icone: 'modifier', classe: 'btn-sm btn-lien', onClic: stop(() => GMAO.navigate('#/plans/' + p.id + '?edition=1')) }) : null,
        el('span', { class: 'espace' }),
        peutModifier ? el('button', { class: 'btn btn-icone btn-sm', title: 'Propriétés du plan', onclick: stop(() => ouvrirProprietesPlan(p, rafraichir)) }, icone('engrenage')) : null,
        can('creer') ? el('button', { class: 'btn btn-icone btn-sm', title: 'Dupliquer', onclick: stop(() => dupliquerPlan(p)) }, icone('copier')) : null,
        el('button', { class: 'btn btn-icone btn-sm', title: 'Exporter (JSON)', onclick: stop(() => api.telecharger(`/api/plans/${p.id}/export`).catch(erreur)) }, icone('export')),
        peutSupprimer ? el('button', { class: 'btn btn-icone btn-sm', title: 'Supprimer', onclick: stop(() => supprimerPlan(p, rafraichir)) }, icone('supprimer')) : null));
  }

  // ----- Création / propriétés / duplication / suppression / import ------------------------------
  function ouvrirNouveauPlan() {
    const options = optionsSecteursEcrivables();
    if (!options.length && (GMAO.perms || {}).portee !== 'tous') { toast('Aucun site ou secteur ne vous est accessible en écriture.', 'alerte'); return; }
    const site = options.find((o) => (ui.secteur(o.value) || {}).type === 'site') || options[0];
    const enfants = (secteurId) => (GMAO.refs.secteurs || []).filter((s) => Number(s.parentId) === Number(secteurId) && s.actif !== false);
    ui.formModal({
      titre: 'Nouveau plan 3D', taille: 'large',
      champs: [
        { nom: 'nom', label: 'Nom du plan', requis: true, placeholder: 'ex. Atelier de production – bâtiment A', pleineLargeur: true },
        { nom: 'secteurId', label: 'Site ou bâtiment', type: 'select', requis: (GMAO.perms || {}).portee !== 'tous', options: ((GMAO.perms || {}).portee === 'tous' ? [{ value: '', label: '— Aucun (plan général) —' }] : []).concat(options), aide: 'Le plan est consultable par les personnes de ce site / bâtiment.' },
        { nom: 'modele', label: 'Modèle de départ', type: 'select', options: [{ value: 'vide', label: 'Plan vide' }, { value: 'batiment', label: 'Un bâtiment couvrant le plan' }, { value: 'secteurs', label: 'Bâtiment + une zone par secteur du site' }], valeur: 'batiment' },
        { type: 'separateur', label: 'Dimensions et niveaux' },
        { nom: 'largeur', label: 'Largeur (m, est-ouest)', type: 'nombre', requis: true, min: 1, max: 2000, valeur: 60 },
        { nom: 'profondeur', label: 'Profondeur (m, nord-sud)', type: 'nombre', requis: true, min: 1, max: 2000, valeur: 40 },
        { nom: 'nbNiveaux', label: 'Nombre de niveaux', type: 'nombre', min: 1, max: 10, step: 1, valeur: 1, aide: 'Rez-de-chaussée, puis R+1, R+2…' },
        { nom: 'hauteur', label: 'Hauteur sous plafond (m)', type: 'nombre', min: 0.5, max: 100, valeur: 6 },
        { nom: 'description', label: 'Description', type: 'texte_long', pleineLargeur: true },
      ],
      valeurs: { secteurId: site ? site.value : '' },
      submitLabel: 'Créer et éditer',
      onSubmit: async (v) => {
        const L = Number(v.largeur), P = Number(v.profondeur), H = Number(v.hauteur) || 6;
        const n = Math.max(1, Math.min(10, Math.round(Number(v.nbNiveaux) || 1)));
        const niveaux = Array.from({ length: n }, (_, i) => ({ id: i === 0 ? 'rdc' : 'r' + i, nom: i === 0 ? 'Rez-de-chaussée' : `R+${i}`, altitude: r3(i * H), hauteur: H }));
        const objets = [];
        const ids = new Set();
        const id = () => { const x = nouvelId(ids); ids.add(x); return x; };
        if (v.modele !== 'vide') {
          const m = Math.min(L, P) * 0.05;
          const pts = [[m, m], [L - m, m], [L - m, P - m], [m, P - m]].map((q) => q.map(r3));
          objets.push({ id: id(), type: 'batiment', nom: v.nom, points: pts, x: L / 2, y: P / 2, largeur: L - 2 * m, profondeur: P - 2 * m, hauteur: H, couleur: '#cbd5e1', niveauId: 'rdc' });
          if (v.modele === 'secteurs' && v.secteurId !== '' && v.secteurId != null) {
            const ss = enfants(v.secteurId);
            const w = (L - 2 * m) / Math.max(1, ss.length);
            ss.forEach((s, i) => {
              const x1 = m + i * w, x2 = x1 + w;
              objets.push({ id: id(), type: 'zone', nom: s.nom, points: [[x1, m], [x2, m], [x2, P - m], [x1, P - m]].map((q) => q.map(r3)), x: (x1 + x2) / 2, y: P / 2, largeur: w, profondeur: P - 2 * m, hauteur: 0.05, couleur: s.couleur || '#3b82f6', secteurId: s.id, niveauId: 'rdc' });
            });
          }
        }
        const body = { nom: v.nom, description: v.description || '', secteurId: v.secteurId === '' ? null : v.secteurId, dimensions: { largeur: L, profondeur: P }, niveaux, objets, vue: null };
        const p = await api.post('/api/plans', body);
        toast(`Plan ${p.numero} créé`, 'succes');
        GMAO.navigate(`#/plans/${p.id}?edition=1`);
      },
    });
  }

  function ouvrirProprietesPlan(p, apres) {
    const options = optionsSecteursEcrivables();
    if (p.secteurId != null && !options.some((o) => Number(o.value) === Number(p.secteurId))) options.unshift({ value: p.secteurId, label: ui.cheminSecteur(p.secteurId) || ui.nomSecteur(p.secteurId) });
    ui.formModal({
      titre: `Propriétés du plan ${p.numero}`,
      champs: [
        { nom: 'nom', label: 'Nom du plan', requis: true, pleineLargeur: true },
        { nom: 'secteurId', label: 'Site ou bâtiment', type: 'select', options: ((GMAO.perms || {}).portee === 'tous' ? [{ value: '', label: '— Aucun —' }] : []).concat(options), pleineLargeur: true },
        { nom: 'largeur', label: 'Largeur (m)', type: 'nombre', requis: true, min: 1, max: 2000 },
        { nom: 'profondeur', label: 'Profondeur (m)', type: 'nombre', requis: true, min: 1, max: 2000 },
        { nom: 'description', label: 'Description', type: 'texte_long', pleineLargeur: true },
      ],
      valeurs: { nom: p.nom, secteurId: p.secteurId == null ? '' : p.secteurId, largeur: p.dimensions.largeur, profondeur: p.dimensions.profondeur, description: p.description || '' },
      onSubmit: async (v) => {
        const body = { version: p.version, nom: v.nom, description: v.description || '', secteurId: v.secteurId === '' ? null : v.secteurId, dimensions: { largeur: Number(v.largeur), profondeur: Number(v.profondeur) } };
        if (typeof apres === 'function' && apres.local) { apres.local(body); return; }
        try {
          await api.put('/api/plans/' + p.id, body);
          toast('Propriétés du plan enregistrées', 'succes');
          if (apres) apres();
        } catch (e) {
          if (e.status === 409) { toast('Le plan a été modifié par quelqu\'un d\'autre entre-temps : rechargez la liste.', 'alerte'); if (apres) apres(); return; }
          throw e;
        }
      },
    });
  }

  async function dupliquerPlan(p) {
    const options = optionsSecteursEcrivables();
    const defaut = options.some((o) => Number(o.value) === Number(p.secteurId)) ? p.secteurId : (options[0] ? options[0].value : '');
    ui.formModal({
      titre: `Dupliquer le plan ${p.numero}`, taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'nom', label: 'Nom de la copie', requis: true },
        { nom: 'secteurId', label: 'Site ou bâtiment', type: 'select', options: ((GMAO.perms || {}).portee === 'tous' ? [{ value: '', label: '— Aucun —' }] : []).concat(options) },
        { nom: 'sansLiens', label: 'Ne pas conserver les liens vers les équipements et secteurs', type: 'booleen' },
      ],
      valeurs: { nom: `${p.nom} (copie)`, secteurId: defaut },
      avant: ui.alerte('Les liens vers les équipements et les secteurs ne sont conservés que si la copie reste sur le même site.', 'info'),
      submitLabel: 'Dupliquer',
      onSubmit: async (v) => {
        const c = await api.post(`/api/plans/${p.id}/dupliquer`, { nom: v.nom, secteurId: v.secteurId === '' ? null : v.secteurId, sansLiens: !!v.sansLiens });
        toast(`Plan ${c.numero} créé (copie de ${p.numero})`, 'succes');
        GMAO.navigate('#/plans/' + c.id);
      },
    });
  }

  async function supprimerPlan(p, apres) {
    const ok = await ui.confirm({ titre: 'Supprimer le plan', message: `Supprimer définitivement le plan ${p.numero} « ${p.nom} » et ses ${p.nbObjets} objet(s) ? Les équipements liés ne sont pas supprimés.`, okLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try { await api.del('/api/plans/' + p.id); toast(`Plan ${p.numero} supprimé`, 'succes'); if (apres) apres(); } catch (e) { erreur(e); }
  }

  function importerPlan() {
    const input = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      if (f.size > 40 * 1024 * 1024) { toast('Fichier trop volumineux (40 Mo maximum)', 'erreur'); return; }
      let fichier;
      try { fichier = JSON.parse(await ui.lireFichier(f, true)); } catch (e) { toast('Ce fichier n\'est pas un export de plan valide (JSON illisible)', 'erreur'); return; }
      if (!fichier || fichier.format !== 'sicaf-plan-3d' || !fichier.plan) { toast('Ce fichier n\'est pas un export de plan 3D de la GMAO', 'erreur'); return; }
      const options = optionsSecteursEcrivables();
      const code = fichier.plan.secteur && fichier.plan.secteur.code;
      const correspondant = code ? options.find((o) => String((ui.secteur(o.value) || {}).code || '').toUpperCase() === String(code).toUpperCase()) : null;
      ui.formModal({
        titre: 'Importer un plan 3D', colonnes: 1,
        avant: ui.alerte(`Fichier « ${f.name} » : ${fichier.plan.nom || 'plan'} (${(fichier.plan.objets || []).length} objet(s)). Les liens vers les équipements sont rétablis par numéro d'équipement sur le site choisi.`, 'info'),
        champs: [
          { nom: 'nom', label: 'Nom du nouveau plan', requis: true },
          { nom: 'secteurId', label: 'Site ou bâtiment', type: 'select', options: ((GMAO.perms || {}).portee === 'tous' ? [{ value: '', label: '— Aucun —' }] : []).concat(options) },
        ],
        valeurs: { nom: fichier.plan.nom || 'Plan importé', secteurId: correspondant ? correspondant.value : (options[0] ? options[0].value : '') },
        submitLabel: 'Importer',
        onSubmit: async (v) => {
          const p = await api.post('/api/plans/import', { fichier, nom: v.nom, secteurId: v.secteurId === '' ? null : v.secteurId });
          const r = p.rapport || {};
          toast(`Plan ${p.numero} importé : ${r.liensConserves || 0} lien(s) rétabli(s)${r.liensRetires ? `, ${r.liensRetires} retiré(s)` : ''}`, r.liensRetires ? 'alerte' : 'succes');
          GMAO.navigate('#/plans/' + p.id);
        },
      });
    });
    input.click();
  }

  // =====================================================================================
  // FICHE : canevas 3D + panneau
  // =====================================================================================
  const brouillons = new Map(); // planId → état non enregistré conservé lors d'une navigation

  class Fiche {
    constructor(container, plan, query) {
      this.container = container;
      this.query = query || {};
      this.chargerPlan(plan);
      this.mode = 'consultation';
      this.outil = 'selection';
      this.categorie = 'armoire_electrique';
      this.selection = [];
      this.niveau = 'tous';
      this.couleurMode = MODES_COULEUR.some((m) => m.code === cfg().couleurParDefaut) ? cfg().couleurParDefaut : 'etat';
      this.avecEtiquettes = cfg().afficherEtiquettes !== false;
      this.historique = []; this.indexHisto = 0;
      this.pressePapier = [];
      this.modifie = false;
      this.trace = null; // tracé en cours (mur, allée, polygone)
      this.drag = null;
      this.curseurSol = null;
      this.equipementsSite = null;
      this.minuteurs = [];
      this.nettoyages = [];
      this.construire();
    }
    chargerPlan(plan) {
      this.plan = plan;
      this.version = plan.version;
      this.infos = new Map();
      this.objets = (plan.objets || []).map((o) => {
        if (o.equipement) this.infos.set(Number(o.equipementId), o.equipement);
        const { equipement, secteur, ...reste } = o;
        return reste;
      });
      this.niveaux = copie(plan.niveaux || [{ id: 'rdc', nom: 'Rez-de-chaussée', altitude: 0, hauteur: 4 }]);
      this.dimensions = copie(plan.dimensions);
      this.fond = plan.fond ? Object.assign({}, plan.fond) : null;
      this.fondModifie = false;
      this.proprietes = { nom: plan.nom, description: plan.description || '', secteurId: plan.secteurId };
      this.vue = plan.vue || null;
    }
    get peutEditer() { return can('modifier') && this.plan.droits && this.plan.droits.modifier && !GMAO.siteLectureSeule(this.plan.secteurId); }
    get edition() { return this.mode === 'edition'; }
    niveauDe(id) { return this.niveaux.find((n) => n.id === id) || this.niveaux[0]; }
    niveauActifId() { return this.niveau === 'tous' ? this.niveaux[0].id : this.niveau; }
    objet(id) { return this.objets.find((o) => o.id === id) || null; }

    // ----- Construction de l'interface ---------------------------------------------------
    construire() {
      injecterStyles();
      const c = this.container;
      this.racine = el('div', { class: 'p3d-fiche' });
      this.barre = el('div', { class: 'p3d-barre' });
      this.outilsEl = el('div', { class: 'p3d-outils masque' });
      this.sceneEl = el('div', { class: 'p3d-scene' });
      this.panneau = el('div', { class: 'p3d-panneau' });
      this.corps = el('div', { class: 'p3d-corps' }, this.outilsEl, this.sceneEl, this.panneau);
      this.racine.appendChild(this.barre);
      this.racine.appendChild(this.corps);
      c.appendChild(this.racine);

      this.legende = el('div', { class: 'p3d-legende' });
      this.statut = el('div', { class: 'p3d-statut' });
      this.infobulle = el('div', { class: 'p3d-infobulle masque' });
      const zoneMoteur = el('div', { style: { position: 'absolute', inset: '0 0 26px 0' } });
      this.sceneEl.appendChild(zoneMoteur);
      this.sceneEl.appendChild(this.legende);
      this.sceneEl.appendChild(this.statut);
      this.sceneEl.appendChild(this.infobulle);

      const th = this.couleursTheme();
      this.moteur = Moteur3D.creer(zoneMoteur, Object.assign({}, th, {
        pasGrille: cfg().grilleM || 0.5,
        grille: true,
        forcer2D: (() => { try { return localStorage.getItem('gmao.plans.2d') === '1'; } catch (e) { return false; } })(),
        onClic: (inf) => this.surClic(inf),
        onDoubleClic: (inf) => this.surDoubleClic(inf),
        onSurvol: (id, p) => this.surSurvol(id, p),
        onDeplacement: (inf) => this.surDeplacementSouris(inf),
        intercepteur: { down: (inf) => this.surDown(inf), move: (inf) => this.surMove(inf), up: (inf) => this.surUp(inf) },
        altitudeInteraction: () => (this.edition ? this.niveauDe(this.niveauActifId()).altitude : 0),
        clavier: (ev) => !(this.edition && this.selection.length && ev.key.startsWith('Arrow')),
        onPerteContexte: () => toast('Le contexte graphique a été perdu : restauration en cours…', 'alerte'),
        onRestauration: () => { this.synchroniser(); toast('Affichage 3D restauré', 'info'); },
        onCamera: () => { this.infobulle.classList.add('masque'); this.majStatut(); },
        onFondCharge: () => this.majStatut(),
      }));
      this.moteur.etiquettes(this.avecEtiquettes);
      GMAO._plan3d = this; // accès de diagnostic (tests d'interface)

      this.construireBarre();
      this.construireCommandes();
      this.construireOutils();
      this.appliquerFond();
      this.synchroniser();
      // Vue initiale : vue enregistrée, sinon cadrage du plan
      if (this.vue) this.moteur.definirCamera({ x: this.vue.x, y: this.vue.y, z: this.vue.z || 0, distance: this.vue.distance, azimut: this.moteur.mode === '2d' ? 0 : this.vue.azimut, elevation: this.vue.elevation, dessus: !!this.vue.dessus || this.moteur.mode === '2d' }, false);
      else this.moteur.recentrer(false);
      this.majBoutonsVue();
      this.rendrePanneau();
      this.majStatut();
      this.installerEcouteurs();

      // Brouillon non enregistré d'une visite précédente
      const brouillon = brouillons.get(this.plan.id);
      if (brouillon && this.peutEditer) {
        brouillons.delete(this.plan.id);
        if (brouillon.version === this.version) {
          ui.confirm({ titre: 'Modifications non enregistrées', message: `Vous aviez quitté ce plan sans enregistrer ${brouillon.nb} modification(s). Voulez-vous les restaurer ?`, okLabel: 'Restaurer' }).then((ok) => {
            if (!ok) return;
            this.objets = brouillon.objets; this.niveaux = brouillon.niveaux; this.fond = brouillon.fond; this.fondModifie = brouillon.fondModifie; this.dimensions = brouillon.dimensions; this.proprietes = brouillon.proprietes;
            this.historique = brouillon.historique || []; this.indexHisto = brouillon.indexHisto || 0;
            this.basculerMode('edition'); this.marquerModifie(true); this.appliquerFond(); this.synchroniser(); this.rendrePanneau();
            toast('Modifications restaurées (non enregistrées)', 'info');
          });
        }
      }
      if (this.query.edition === '1' && this.peutEditer && !brouillon) this.basculerMode('edition');
      if (this.query.equipementId) setTimeout(() => this.focaliserEquipement(Number(this.query.equipementId)), 120);
      if (this.moteur.mode === '2d') toast('WebGL indisponible : le plan est affiché en vue de dessus 2D.', 'alerte');
    }
    couleursTheme() {
      return sombre()
        ? { couleurFond: '#0b1220', couleurSol: '#1e293b', couleurMarge: '#131c2e', couleurGrille: '#64748b', couleurSelection: '#3b82f6' }
        : { couleurFond: '#e6ebf1', couleurSol: '#f8fafc', couleurMarge: '#dbe2ea', couleurGrille: '#94a3b8', couleurSelection: '#2563eb' };
    }

    construireBarre() {
      const b = this.barre;
      ui.vider(b);
      b.appendChild(el('a', { class: 'btn btn-icone', href: '#/plans', title: 'Retour à la liste des plans' }, icone('fleche_gauche')));
      this.titreEl = el('div', { class: 'p3d-titre' });
      b.appendChild(this.titreEl);
      this.majTitre();
      b.appendChild(el('span', { class: 'espace' }));
      // recherche d'équipement / d'objet
      const inp = el('input', { type: 'search', placeholder: 'Rechercher un équipement…', 'aria-label': 'Rechercher un équipement ou un objet du plan' });
      const res = el('div', { class: 'p3d-resultats masque' });
      let resultats = [], actif = 0;
      const choisir = (o) => { res.classList.add('masque'); inp.value = ''; inp.blur(); this.focaliserObjet(o.id); };
      const majRes = () => {
        const q = inp.value.trim().toLowerCase();
        ui.vider(res);
        if (!q) { res.classList.add('masque'); return; }
        resultats = this.objets.filter((o) => {
          const info = this.infos.get(Number(o.equipementId));
          return [o.nom, o.texte, info && info.nom, info && info.numero, libType(o)].some((v) => String(v || '').toLowerCase().includes(q));
        }).sort((a, b2) => (b2.equipementId != null) - (a.equipementId != null)).slice(0, 14);
        actif = 0;
        if (!resultats.length) res.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '8px' } }, 'Aucun résultat sur ce plan'));
        resultats.forEach((o, i) => {
          const info = this.infos.get(Number(o.equipementId));
          res.appendChild(el('div', { class: 'p3d-item' + (i === 0 ? ' actif' : ''), onmousedown: (ev) => { ev.preventDefault(); choisir(o); } },
            el('span', { class: 'p3d-pastille', style: { background: this.couleurObjet(o) } }),
            el('span', { class: 'nom' }, (info && info.nom) || o.nom || o.texte || libType(o)),
            el('span', { class: 'num' }, info ? info.numero : libType(o))));
        });
        res.classList.remove('masque');
      };
      inp.addEventListener('input', majRes);
      inp.addEventListener('focus', majRes);
      inp.addEventListener('blur', () => setTimeout(() => res.classList.add('masque'), 150));
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); actif = Math.max(0, Math.min(resultats.length - 1, actif + (ev.key === 'ArrowDown' ? 1 : -1))); Array.from(res.children).forEach((x, i) => x.classList.toggle('actif', i === actif)); }
        else if (ev.key === 'Enter' && resultats[actif]) { ev.preventDefault(); choisir(resultats[actif]); }
        else if (ev.key === 'Escape') { inp.value = ''; res.classList.add('masque'); inp.blur(); }
      });
      this.inputRecherche = inp;
      b.appendChild(el('div', { class: 'p3d-recherche' }, ic('recherche'), inp, res));
      // mode de couleur
      const selC = el('select', { title: 'Couleur des machines selon…', 'aria-label': 'Mode de couleur' }, MODES_COULEUR.map((m) => el('option', { value: m.code }, m.label)));
      selC.value = this.couleurMode;
      selC.addEventListener('change', () => { this.couleurMode = selC.value; this.synchroniser(); this.rendrePanneau(); });
      b.appendChild(selC);
      // niveaux
      this.selNiveau = el('select', { title: 'Niveau affiché' });
      this.selNiveau.addEventListener('change', () => { this.niveau = this.selNiveau.value; this.selection = this.selection.filter((id) => { const o = this.objet(id); return o && (this.niveau === 'tous' || o.niveauId === this.niveau); }); this.annulerTrace(); this.appliquerFond(); this.synchroniser(); this.rendrePanneau(); });
      b.appendChild(this.selNiveau);
      this.majSelectNiveau();
      // menu « plus »
      const plus = el('button', { class: 'btn btn-icone', title: 'Plus d\'actions' }, icone('liste'));
      plus.addEventListener('click', (ev) => { ev.stopPropagation(); this.ouvrirMenu(plus); });
      b.appendChild(plus);
      // édition
      this.zoneEdition = el('div', { class: 'inline', style: { gap: '6px' } });
      b.appendChild(this.zoneEdition);
      this.majZoneEdition();
    }
    /** Commandes de vue en surimpression (coin supérieur droit du canevas). */
    construireCommandes() {
      const cmd = (ico, titre, fn) => el('button', { class: 'p3d-cmd', type: 'button', title: titre, 'aria-label': titre, onclick: fn }, ic(ico));
      this.btn3d = cmd('cube', 'Vue 3D (perspective)', () => this.basculerDessus(false));
      this.btnDessus = cmd('dessus', 'Vue de dessus (orthographique)', () => this.basculerDessus(true));
      this.btnEtiq = cmd('etiquette', 'Afficher / masquer les étiquettes', () => { this.avecEtiquettes = !this.avecEtiquettes; this.moteur.etiquettes(this.avecEtiquettes); this.btnEtiq.classList.toggle('actif', this.avecEtiquettes); });
      this.btnEtiq.classList.toggle('actif', this.avecEtiquettes);
      this.btnPlein = cmd('pleinEcran', 'Plein écran', () => this.basculerPleinEcran());
      this.commandes = el('div', { class: 'p3d-commandes' },
        el('div', { class: 'p3d-cmd-groupe' }, this.btn3d, this.btnDessus),
        el('div', { class: 'p3d-cmd-groupe' }, cmd('recentrer', 'Recentrer sur le plan (Origine)', () => this.moteur.recentrer(true)), cmd('plus', 'Zoom avant', () => this.zoomer(0.75)), cmd('moins', 'Zoom arrière', () => this.zoomer(1 / 0.75))),
        el('div', { class: 'p3d-cmd-groupe' }, this.btnEtiq, this.btnPlein, cmd('camera', 'Capture d\'écran (PNG)', () => this.capturer())));
      this.sceneEl.appendChild(this.commandes);
    }
    zoomer(f) { const c = this.moteur.camera; this.moteur.definirCamera({ distance: c.distance * f }, 250); }
    majTitre() {
      ui.vider(this.titreEl);
      const lecture = GMAO.siteLectureSeule(this.plan.secteurId);
      this.titreEl.appendChild(el('div', { class: 't', title: this.proprietes.nom }, this.proprietes.nom));
      this.titreEl.appendChild(el('div', { class: 's' }, [this.plan.numero, ui.cheminSecteur(this.proprietes.secteurId) || this.plan.secteurChemin, lecture ? 'lecture seule' : ''].filter(Boolean).join(' · ')));
    }
    majSelectNiveau() {
      const s = this.selNiveau;
      ui.vider(s);
      if (!this.edition && this.niveaux.length > 1) s.appendChild(el('option', { value: 'tous' }, 'Tous les niveaux'));
      for (const n of this.niveaux) s.appendChild(el('option', { value: n.id }, n.nom));
      if (this.niveau !== 'tous' && !this.niveaux.some((n) => n.id === this.niveau)) this.niveau = this.niveaux[0].id;
      if (this.edition && this.niveau === 'tous') this.niveau = this.niveaux[0].id;
      if (this.niveaux.length === 1) this.niveau = this.edition ? this.niveaux[0].id : 'tous';
      s.value = this.niveau === 'tous' && this.niveaux.length === 1 ? this.niveaux[0].id : this.niveau;
      s.classList.toggle('masque', this.niveaux.length < 2 && !this.edition);
    }
    majZoneEdition() {
      const z = this.zoneEdition;
      ui.vider(z);
      if (!this.peutEditer) return;
      if (!this.edition) {
        z.appendChild(ui.bouton('Éditer le plan', { icone: 'modifier', classe: 'btn-primaire', onClic: () => this.basculerMode('edition') }));
        return;
      }
      z.appendChild(ui.bouton('Terminer', { titre: 'Revenir en consultation', onClic: () => this.basculerMode('consultation') }));
      this.btnEnregistrer = ui.bouton('Enregistrer', { icone: 'sauvegarde', classe: 'btn-primaire', titre: 'Enregistrer le plan (Ctrl+S)', onClic: () => this.enregistrer() });
      this.indicModif = el('span', { class: 'p3d-point' + (this.modifie ? '' : ' masque'), title: 'Modifications non enregistrées', 'aria-label': 'Modifications non enregistrées' });
      this.btnEnregistrer.appendChild(this.indicModif);
      z.appendChild(this.btnEnregistrer);
    }
    ouvrirMenu(ancre) {
      document.querySelectorAll('.menu-deroulant').forEach((m) => m.remove());
      const item = (ico, label, fn, visible = true) => (visible ? el('button', { class: 'menu-item', onclick: () => { menu.remove(); fn(); } }, ic(ico), label) : null);
      const menu = el('div', { class: 'menu-deroulant', style: { top: (ancre.offsetTop + ancre.offsetHeight + 6) + 'px', left: Math.max(8, ancre.offsetLeft - 200) + 'px', right: 'auto' }, onclick: (ev) => ev.stopPropagation() },
        item('export', 'Exporter le plan (JSON)', () => api.telecharger(`/api/plans/${this.plan.id}/export`).catch(erreur)),
        item('liste', 'Exporter la liste des objets (CSV)', () => this.exporterObjetsCsv()),
        item('copier', 'Dupliquer le plan', () => dupliquerPlan(Object.assign({}, this.plan, { nom: this.proprietes.nom })), can('creer')),
        item('rafraichir', 'Rafraîchir l\'état des équipements', () => this.majEtat(true)),
        item('panneau', this.panneau.classList.contains('masque-panneau') ? 'Afficher le panneau latéral' : 'Masquer le panneau latéral', () => { this.panneau.classList.toggle('masque-panneau'); setTimeout(() => this.moteur.redimensionner(), 30); }),
        item('dessus', this.moteur.mode === '2d' ? 'Revenir à l\'affichage 3D (WebGL)' : 'Basculer en affichage 2D (sans WebGL)', () => { try { localStorage.setItem('gmao.plans.2d', this.moteur.mode === '2d' ? '0' : '1'); } catch (e) { /* ignore */ } this.recharger(); }),
        el('div', { class: 'menu-sep' }),
        item('info', 'Raccourcis clavier', () => this.aideClavier()));
      this.barre.appendChild(menu);
      const fermer = () => { menu.remove(); document.removeEventListener('click', fermer); };
      setTimeout(() => document.addEventListener('click', fermer), 0);
    }
    construireOutils() {
      const o = this.outilsEl;
      ui.vider(o);
      this.boutonsOutils = {};
      for (const t of OUTILS) {
        const btn = el('button', { class: 'p3d-outil' + (this.outil === t.cle ? ' actif' : ''), title: `${t.label} (${t.touche})`, 'aria-label': t.label, dataset: { outil: t.cle }, onclick: () => this.choisirOutil(t.cle) }, ic(t.icone));
        this.boutonsOutils[t.cle] = btn;
        o.appendChild(btn);
        if (t.cle === 'rotation' || t.cle === 'allee') o.appendChild(el('div', { class: 'p3d-sep' }));
      }
      o.appendChild(el('div', { class: 'p3d-sep' }));
      const act = (ico, titre, fn) => { const b = el('button', { class: 'p3d-outil', title: titre, 'aria-label': titre, onclick: fn }, ic(ico)); o.appendChild(b); return b; };
      this.btnAnnuler = act('annuler', 'Annuler (Ctrl+Z)', () => this.annuler());
      this.btnRetablir = act('retablir', 'Rétablir (Ctrl+Y)', () => this.retablir());
      this.btnDupliquer = act('copier', 'Dupliquer (Ctrl+D)', () => this.dupliquerSelection());
      this.btnColler = act('coller', 'Coller (Ctrl+V)', () => this.coller());
      this.btnSupprimer = act('supprimer', 'Supprimer (Suppr)', () => this.supprimerSelection());
      o.appendChild(el('div', { class: 'p3d-sep' }));
      act('image', 'Fond de plan à décalquer', () => this.ouvrirFond());
      act('niveaux', 'Niveaux', () => this.ouvrirNiveaux());
      act('engrenage', 'Propriétés du plan', () => this.ouvrirProprietes());
      this.majBoutonsActions();
    }
    majBoutonsActions() {
      if (!this.btnAnnuler) return;
      this.btnAnnuler.disabled = this.indexHisto <= 0;
      this.btnRetablir.disabled = this.indexHisto >= this.historique.length;
      this.btnDupliquer.disabled = !this.selection.length;
      this.btnSupprimer.disabled = !this.selection.length;
      this.btnColler.disabled = !this.pressePapier.length;
    }
    majBoutonsVue() {
      const dessus = this.moteur.camera.dessus;
      this.btn3d.classList.toggle('actif', !dessus);
      this.btnDessus.classList.toggle('actif', dessus);
      this.btn3d.disabled = this.moteur.mode === '2d';
    }

    // ----- Modes ------------------------------------------------------------------------------
    basculerMode(mode) {
      if (mode === 'edition' && !this.peutEditer) return;
      if (mode === 'consultation' && this.modifie) {
        ui.confirm({ titre: 'Modifications non enregistrées', message: 'Enregistrer les modifications avant de revenir en consultation ?', okLabel: 'Enregistrer', annulerLabel: 'Continuer l\'édition' }).then(async (ok) => {
          if (ok && await this.enregistrer()) this.basculerMode('consultation');
        });
        return;
      }
      if (mode === 'edition' && this.mode !== 'edition') {
        this.niveauConsultation = this.niveau;
        // l'édition se fait de préférence en vue de dessus (orthographique, nord en haut)
        this.cameraConsultation = this.moteur.camera.dessus ? null : this.moteur.camera;
        if (this.cameraConsultation) this.moteur.definirCamera({ dessus: true, elevation: 89, azimut: 0 }, 500);
      }
      if (mode === 'consultation' && this.mode === 'edition') {
        if (this.niveauConsultation != null) this.niveau = this.niveauConsultation;
        if (this.cameraConsultation && this.moteur.camera.dessus && this.moteur.mode !== '2d') this.moteur.definirCamera(Object.assign({}, this.cameraConsultation, { x: this.moteur.camera.x, y: this.moteur.camera.y }), 500);
        this.cameraConsultation = null;
      }
      this.mode = mode;
      this.annulerTrace();
      this.outil = 'selection';
      this.outilsEl.classList.toggle('masque', mode !== 'edition');
      if (mode === 'edition' && this.niveau === 'tous') this.niveau = this.niveaux[0].id;
      this.majSelectNiveau();
      this.appliquerFond();
      this.majZoneEdition();
      this.construireOutils();
      this.fermerPalette();
      this.moteur.definirCurseur('default');
      this.moteur.redimensionner();
      this.synchroniser();
      this.rendrePanneau();
      this.majBoutonsVue();
      this.majStatut();
      if (mode === 'edition') toast('Mode édition : choisissez un outil à gauche. Pensez à enregistrer.', 'info');
    }
    basculerDessus(actif) {
      if (this.moteur.mode === '2d' && !actif) return;
      this.moteur.vueDessus(actif);
      if (actif) this.moteur.definirCamera({ azimut: 0 }, 400);
      this.majBoutonsVue();
      this.majStatut();
    }
    /**
     * Plein écran : le document passe en plein écran et la fiche occupe toute la fenêtre (position fixe),
     * ce qui laisse visibles les fenêtres modales et les notifications. Sans API plein écran, la fiche
     * occupe simplement toute la fenêtre.
     */
    basculerPleinEcran() {
      const actif = this.racine.classList.contains('p3d-plein-ecran');
      if (actif) {
        this.racine.classList.remove('p3d-plein-ecran');
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } else {
        this.racine.classList.add('p3d-plein-ecran');
        const de = document.documentElement;
        if (de.requestFullscreen && !document.fullscreenElement) de.requestFullscreen().catch(() => { /* fenêtre agrandie seulement */ });
      }
      this.majBoutonPlein();
      setTimeout(() => this.moteur.redimensionner(), 60);
    }
    majBoutonPlein() {
      const actif = this.racine.classList.contains('p3d-plein-ecran');
      ui.vider(this.btnPlein); this.btnPlein.appendChild(ic(actif ? 'quitterPleinEcran' : 'pleinEcran'));
      this.btnPlein.title = actif ? 'Quitter le plein écran (Échap)' : 'Plein écran';
      this.btnPlein.classList.toggle('actif', actif);
    }
    choisirOutil(cle) {
      if (!this.edition) return;
      this.annulerTrace();
      this.outil = cle;
      Object.entries(this.boutonsOutils || {}).forEach(([k, b]) => b.classList.toggle('actif', k === cle));
      this.moteur.definirCurseur(cle === 'selection' ? 'default' : (cle === 'rotation' ? 'alias' : 'crosshair'));
      if (cle === 'installation') this.ouvrirPalette(); else this.fermerPalette();
      this.majStatut();
    }
    ouvrirPalette() {
      this.fermerPalette();
      const pal = el('div', { class: 'p3d-palette' }, el('div', { class: 'pt' }, 'Catégorie d\'installation'));
      for (const [code, c] of Object.entries(CATEGORIES)) {
        pal.appendChild(el('div', { class: 'p3d-item' + (this.categorie === code ? ' actif' : ''), dataset: { categorie: code }, onclick: () => { this.categorie = code; this.annulerTrace(); pal.querySelectorAll('.p3d-item').forEach((x) => x.classList.toggle('actif', x.dataset.categorie === code)); this.majStatut(); } },
          el('span', { class: 'p3d-pastille', style: { background: c.couleur, borderRadius: c.forme === 'cylindre' ? '50%' : '3px' } }),
          el('span', { class: 'nom' }, c.label),
          el('span', { class: 'num' }, c.segment ? 'tracé' : `${ui.formatNombre(c.l)}×${ui.formatNombre(c.p)} m`)));
      }
      this.palette = pal;
      this.sceneEl.appendChild(pal);
    }
    fermerPalette() { if (this.palette) { this.palette.remove(); this.palette = null; } }

    // ----- Descripteurs pour le moteur ------------------------------------------------------
    couleurEquipement(o) {
      const info = o.equipementId != null ? this.infos.get(Number(o.equipementId)) : null;
      if (!info) return null;
      switch (this.couleurMode) {
        case 'etat': return ui.couleur('etatsEquipement', info.etatCode);
        case 'criticite': return ui.couleur('criticites', info.criticiteCode);
        case 'secteur': { const s = ui.secteur(info.secteurId); return (s && s.couleur) || NEUTRE; }
        case 'ot': return (ALERTES[info.alerte] || ALERTES.aucun).couleur;
        default: return null;
      }
    }
    couleurObjet(o) {
      if (o.type === 'machine') return this.couleurMode === 'origine' ? o.couleur : (this.couleurEquipement(o) || NEUTRE);
      if (o.type === 'installation') return (this.couleurMode !== 'origine' && this.couleurEquipement(o)) || o.couleur;
      if (o.type === 'zone' && this.couleurMode === 'secteur' && o.secteurId != null) { const s = ui.secteur(o.secteurId); if (s && s.couleur) return s.couleur; }
      return o.couleur || (TYPES[o.type] || {}).couleur || '#6b7280';
    }
    estVisible(o) {
      if (this.niveau === 'tous') return 'normal';
      if (o.niveauId === this.niveau) return 'normal';
      const nv = this.niveauDe(o.niveauId), actif = this.niveauDe(this.niveau);
      return nv.altitude < actif.altitude ? 'fantome' : 'cache';
    }
    descripteurs(o) {
      const vis = this.estVisible(o);
      if (vis === 'cache') return [];
      const fantome = vis === 'fantome';
      const alt = this.niveauDe(o.niveauId).altitude;
      const coul = this.couleurObjet(o);
      const base = { id: o.id, pickable: !fantome };
      const op = (a) => (fantome ? Math.min(a, 0.1) : a);
      const lab = (texte, classe, priorite, extra) => (fantome || !texte ? null : Object.assign({ texte, classe, priorite }, extra || {}));
      const info = o.equipementId != null ? this.infos.get(Number(o.equipementId)) : null;
      const pts = o.points && o.points.length >= 3 ? o.points : rectPoints(o);
      switch (o.type) {
        case 'zone': {
          const nom = o.nom || (o.secteurId != null ? ui.nomSecteur(o.secteurId) : '');
          const haute = (o.hauteur || 0) > 0.5;
          return [Object.assign({}, base, { forme: 'prisme', points: pts, y0: alt, hauteur: Math.max(0.03, o.hauteur || 0.05), couleur: coul, opacite: op(haute ? 0.2 : (sombre() ? 0.3 : 0.26)), aretes: true, couleurAretes: coul, etiquette: lab(nom, 'zone', 2, { z: alt + Math.max(0.05, o.hauteur || 0) + 0.05 }) })];
        }
        case 'batiment': {
          const c = sombre() ? melanger(coul, '#1e293b', 0.6) : coul;
          return [
            Object.assign({}, base, { forme: 'prisme', points: pts, y0: alt - 0.09, hauteur: 0.07, couleur: c, opacite: fantome ? 0.08 : 1, aretes: true, couleurAretes: melanger(c, '#000000', 0.35) }),
            { id: o.id, pickable: false, forme: 'prisme', points: pts, y0: alt, hauteur: Math.max(0.1, o.hauteur || 6), couleur: sombre() ? '#94a3b8' : melanger(coul, '#64748b', 0.3), opacite: op(sombre() ? 0.1 : 0.14), aretes: !fantome, couleurAretes: sombre() ? '#64748b' : '#94a3b8', faces: { toit: false, cotes: true, sol: false }, etiquette: lab(o.nom, 'batiment', 1, { z: alt + (o.hauteur || 6) + 0.6 }) },
          ];
        }
        case 'mur':
          return [Object.assign({}, base, { forme: 'segment', x: o.x, y: o.y, x2: o.x2, y2: o.y2, epaisseur: o.epaisseur || 0.2, y0: alt, hauteur: o.hauteur || 3, couleur: sombre() ? melanger(coul, '#334155', 0.35) : coul, opacite: op(1), aretes: true })];
        case 'allee': {
          // bande de circulation neutre + marquages latéraux (couleur de l'allée)
          const e = o.epaisseur || 3, l = Math.hypot(o.x2 - o.x, o.y2 - o.y) || 1;
          const nx = -(o.y2 - o.y) / l, ny = (o.x2 - o.x) / l, dec = Math.max(0, e / 2 - 0.1);
          const out = [Object.assign({}, base, { forme: 'segment', x: o.x, y: o.y, x2: o.x2, y2: o.y2, epaisseur: e, y0: alt + 0.055, hauteur: 0.012, couleur: sombre() ? '#2f3b4f' : '#dfe4ea', opacite: op(1), aretes: false })];
          if (!fantome) for (const k of [-1, 1]) out.push(Object.assign({}, base, { forme: 'segment', x: o.x + nx * dec * k, y: o.y + ny * dec * k, x2: o.x2 + nx * dec * k, y2: o.y2 + ny * dec * k, epaisseur: Math.min(0.14, e / 4), y0: alt + 0.068, hauteur: 0.006, couleur: coul, opacite: 1, aretes: false }));
          return out;
        }
        case 'porte':
          return [Object.assign({}, base, { forme: 'boite', x: o.x, y: o.y, largeur: o.largeur, profondeur: o.profondeur, hauteur: o.hauteur || 2.1, rotation: o.rotation || 0, y0: alt + (o.z || 0), couleur: coul, opacite: op(0.95), aretes: true })];
        case 'texte': {
          const taille = o.taille || 1;
          const texte = o.texte || o.nom;
          if (!this.edition) return fantome ? [] : [{ id: o.id, forme: 'aucune', x: o.x, y: o.y, y0: alt + 0.1, pickable: false, etiquette: { texte, classe: 'texte-sol', priorite: 3, tailleM: taille } }];
          return [Object.assign({}, base, { forme: 'quad', x: o.x, y: o.y, largeur: Math.max(1, String(texte || '').length * taille * 0.55), profondeur: taille * 1.3, rotation: o.rotation || 0, y0: alt + 0.08, couleur: '#2563eb', opacite: op(0.1), aretes: true, etiquette: lab(texte, 'texte-sol', 3, { tailleM: taille }) })];
        }
        case 'machine':
        case 'installation': {
          const cat = CATEGORIES[o.categorie] || CATEGORIES.autre;
          const nom = (info && info.nom) || o.nom || (o.type === 'installation' ? cat.label : '');
          const montrer = o.type === 'machine' || !SANS_ETIQUETTE.has(o.categorie) || this.selection.includes(o.id);
          const classe = 'machine' + (info && info.alerte === 'urgent' ? ' alerte-urgent' : (info && info.alerte === 'en_cours' && this.couleurMode === 'ot' ? ' alerte-en_cours' : ''));
          const et = montrer ? lab(nom, classe, (o.type === 'machine' ? 6 : 4) + (info && info.alerte === 'urgent' ? 3 : 0), Object.assign({ pixelsMin: 16, toujours: !!(info && info.alerte === 'urgent') }, info ? { pastille: this.couleurMode !== 'origine' ? coul : null } : {})) : null;
          if (estSegment(o)) return [Object.assign({}, base, { forme: 'segment', x: o.x, y: o.y, x2: o.x2, y2: o.y2, epaisseur: o.epaisseur || 0.15, y0: alt + (o.z || 0), hauteur: Math.max(0.03, o.epaisseur || 0.15), couleur: coul, opacite: op(1), aretes: false, etiquette: et })];
          const d = Object.assign({}, base, { forme: o.forme === 'cylindre' ? 'cylindre' : 'boite', x: o.x, y: o.y, largeur: o.largeur, profondeur: o.profondeur, hauteur: Math.max(0.05, o.hauteur || 1), rotation: o.rotation || 0, y0: alt + (o.z || 0), couleur: coul, opacite: op(1), aretes: true, etiquette: et });
          if (o.categorie === 'rack' && !fantome) {
            // lisses horizontales du rack
            const out = [d];
            const n = Math.max(2, Math.min(6, Math.round((o.hauteur || 5) / 1.4)));
            for (let i = 1; i < n; i++) out.push({ id: o.id, pickable: !fantome, forme: 'boite', x: o.x, y: o.y, largeur: o.largeur * 1.01, profondeur: o.profondeur * 1.04, hauteur: 0.08, rotation: o.rotation || 0, y0: alt + (o.z || 0) + (o.hauteur || 5) * i / n, couleur: '#c2410c', opacite: 1, aretes: false });
            return out;
          }
          return [d];
        }
        default: return [];
      }
    }
    synchroniser() {
      const desc = [];
      for (const o of this.objets) for (const d of this.descripteurs(o)) desc.push(d);
      this.moteur.definirScene({ largeur: this.dimensions.largeur, profondeur: this.dimensions.profondeur, objets: desc });
      // grille : pas de magnétisme en édition, maillage de 5 m discret en consultation
      if (this.edition) this.moteur.definirGrille(true, cfg().grilleM || 0.5, 0.8);
      else this.moteur.definirGrille(true, Math.max(5, cfg().grilleM || 0.5), 0.55);
      this.moteur.selection(this.selection);
      this.majLegende();
      this.majBoutonsActions();
    }
    majObjetsMoteur(ids) {
      const s = new Set(ids);
      const presents = this.objets.filter((o) => s.has(o.id));
      const desc = [];
      for (const o of presents) for (const d of this.descripteurs(o)) desc.push(d);
      const absents = ids.filter((id) => !presents.some((o) => o.id === id));
      if (absents.length) this.moteur.supprimerObjets(absents);
      // les identifiants sans descripteur (objets masqués) sont retirés
      const sansDesc = presents.filter((o) => !desc.some((d) => d.id === o.id)).map((o) => o.id);
      if (sansDesc.length) this.moteur.supprimerObjets(sansDesc);
      if (desc.length) this.moteur.majObjets(desc);
      this.moteur.selection(this.selection);
    }
    appliquerFond() {
      const f = this.fond;
      if (!f || (!f.imageUrl && !f.imageDataUrl)) { this.moteur.definirFond(null); return; }
      const nv = this.niveauDe(f.niveauId);
      const visible = this.niveau === 'tous' || this.niveau === f.niveauId || nv.altitude < this.niveauDe(this.niveau).altitude;
      this.moteur.definirFond({ url: f.imageDataUrl || f.imageUrl, x: f.x, y: f.y, rotation: f.rotation || 0, echelle: f.echelle, opacite: f.opacite == null ? 0.6 : f.opacite, y0: nv.altitude, visible });
      if (this.moteur.fond) this.moteur.fond.visible = visible;
    }

    // ----- Légende, statut, infobulle ------------------------------------------------------------
    majLegende() {
      const l = this.legende;
      ui.vider(l);
      const { titre, items } = this.itemsLegende();
      l.appendChild(el('div', { class: 'lt' }, titre));
      if (!items.length) l.appendChild(el('div', { class: 'texte-2' }, 'Couleurs définies sur le plan'));
      for (const [c, t] of items) l.appendChild(el('div', { class: 'li' }, el('span', { class: 'p3d-pastille', style: { background: c } }), t));
    }
    itemsLegende() {
      let items = [];
      let titre = '';
      switch (this.couleurMode) {
        case 'etat': titre = 'État des équipements'; items = GMAO.liste('etatsEquipement').map((x) => [x.couleur || '#6b7280', x.label]); break;
        case 'criticite': titre = 'Criticité'; items = GMAO.liste('criticites').map((x) => [x.couleur || '#6b7280', x.label]); break;
        case 'ot': titre = 'Interventions'; items = Object.values(ALERTES).map((a) => [a.couleur, a.label]); break;
        case 'secteur': {
          titre = 'Secteurs';
          const ids = new Set();
          for (const info of this.infos.values()) if (info.secteurId != null) ids.add(info.secteurId);
          for (const o of this.objets) if (o.type === 'zone' && o.secteurId != null) ids.add(o.secteurId);
          items = Array.from(ids).map((id) => ui.secteur(id)).filter(Boolean).map((s) => [s.couleur || '#6b7280', s.nom]);
          break;
        }
        default: titre = 'Couleurs d\'origine'; items = [];
      }
      if (this.couleurMode !== 'origine') items.push([NEUTRE, 'Machine non liée']);
      return { titre, items };
    }
    majStatut(info) {
      const s = this.statut;
      if (!s) return;
      ui.vider(s);
      const coord = this.curseurSol ? `x ${fmtL(this.curseurSol.x)} · y ${fmtL(this.curseurSol.y)}` : '';
      s.appendChild(el('span', { title: 'Position du curseur sur le plan' }, coord || `${ui.formatNombre(this.dimensions.largeur)} × ${ui.formatNombre(this.dimensions.profondeur)} m`));
      if (info) s.appendChild(el('span', { class: 'texte-gras' }, info));
      if (this.edition) {
        const t = OUTILS.find((x) => x.cle === this.outil);
        let aide = t ? t.aide : '';
        if (this.outil === 'installation') aide = `${CATEGORIES[this.categorie].label} : ` + (CATEGORIES[this.categorie].segment ? 'cliquez le départ puis l\'arrivée du réseau (tracé enchaîné, Échap pour terminer).' : 'cliquez sur le plan pour la placer.');
        if (this.calibrage) aide = this.calibrage.points.length ? 'Cliquez le second point de référence sur le fond de plan.' : 'Cliquez le premier point de référence sur le fond de plan.';
        s.appendChild(el('span', { class: 'aide-outil', title: aide }, aide));
      } else {
        s.appendChild(el('span', { class: 'aide-outil' }, this.moteur.mode === '2d' ? 'Glisser : déplacer · molette : zoom · clic : sélectionner' : 'Glisser : pivoter · clic droit ou Maj : déplacer · molette : zoom · clic : sélectionner'));
      }
      s.appendChild(el('span', { class: 'espace' }));
      if (this.selection.length > 1) s.appendChild(el('span', null, `${this.selection.length} objets sélectionnés`));
      s.appendChild(el('span', null, `${this.objets.length} objet${this.objets.length > 1 ? 's' : ''}`));
      if (this.moteur.mode === '2d') s.appendChild(ui.badge('Vue 2D', '#b45309'));
    }
    surSurvol(id, p) {
      const o = id ? this.objet(id) : null;
      if (!o || !p || this.drag || this.trace || (this.edition && this.outil !== 'selection')) { this.infobulle.classList.add('masque'); return; }
      const info = o.equipementId != null ? this.infos.get(Number(o.equipementId)) : null;
      ui.vider(this.infobulle);
      this.infobulle.appendChild(el('div', { class: 't' }, (info && info.nom) || o.nom || o.texte || libType(o)));
      const lignes = [info ? `${info.numero} · ${ui.libelle('etatsEquipement', info.etatCode)}` : libType(o)];
      if (info && (info.nbOtOuverts || info.nbDemandesOuvertes)) lignes.push(`${info.nbOtOuverts} OT ouvert(s) · ${info.nbDemandesOuvertes} demande(s)`);
      if (o.type === 'zone' && o.secteurId != null) lignes.push('Secteur : ' + ui.nomSecteur(o.secteurId));
      if (o.equipementMasque) lignes.push('Équipement hors de votre périmètre');
      lignes.forEach((t) => this.infobulle.appendChild(el('div', { class: 'texte-2' }, t)));
      const W = this.sceneEl.clientWidth;
      this.infobulle.style.left = Math.min(p.x + 14, W - 290) + 'px';
      this.infobulle.style.top = (p.y + 16) + 'px';
      this.infobulle.classList.remove('masque');
    }

    // ----- Sélection & focus --------------------------------------------------------------------
    selectionner(ids, ajouter) {
      const liste = (ids || []).filter((id) => this.objet(id));
      if (ajouter) {
        const s = new Set(this.selection);
        for (const id of liste) { if (s.has(id)) s.delete(id); else s.add(id); }
        this.selection = Array.from(s);
      } else this.selection = liste;
      // les étiquettes des installations sans étiquette apparaissent à la sélection
      this.synchroniserEtiquettesSelection();
      this.moteur.selection(this.selection);
      this.rendrePanneau();
      this.majBoutonsActions();
      this.majStatut();
    }
    synchroniserEtiquettesSelection() {
      const ids = new Set(this.selection.concat(this._selPrec || []));
      this._selPrec = this.selection.slice();
      const aMaj = Array.from(ids).filter((id) => { const o = this.objet(id); return o && o.type === 'installation' && SANS_ETIQUETTE.has(o.categorie); });
      if (aMaj.length) this.majObjetsMoteur(aMaj);
    }
    focaliserObjet(id) {
      const o = this.objet(id);
      if (!o) return;
      if (this.niveau !== 'tous' && o.niveauId !== this.niveau) { this.niveau = this.edition ? o.niveauId : 'tous'; this.majSelectNiveau(); this.appliquerFond(); this.synchroniser(); }
      this.selectionner([id]);
      this.infobulle.classList.add('masque');
      const b = this.moteur.boiteDe([id]);
      const taille = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 1) : 2;
      this.moteur.allerVers(id, { clignoter: true, distance: Math.max(22, taille * 4) });
    }
    focaliserEquipement(eqId) {
      const o = this.objets.find((x) => Number(x.equipementId) === Number(eqId));
      if (o) this.focaliserObjet(o.id);
      else toast('Cet équipement n\'est pas placé sur ce plan.', 'alerte');
    }

    // ----- Événements du moteur ---------------------------------------------------------------
    selectionnable(id) {
      const o = id ? this.objet(id) : null;
      if (!o) return null;
      if (this.edition && o.niveauId !== this.niveauActifId()) return null;
      return o;
    }
    surClic(inf) {
      if (this.edition && this.outil !== 'selection') return;
      const o = this.selectionnable(inf.id);
      if (o) this.selectionner([o.id], inf.shift);
      else if (!inf.shift) this.selectionner([]);
    }
    surDoubleClic(inf) {
      if (this.trace) { this.terminerTrace(true); return; }
      const o = this.selectionnable(inf.id);
      if (o) this.moteur.allerVers(o.id, { clignoter: false });
    }
    snap(v, sansSnap) { const g = Number(cfg().grilleM) || 0.5; return sansSnap ? r3(v) : r3(Math.round(v / g) * g); }
    surDeplacementSouris(inf) {
      this.curseurSol = inf.sol;
      if (this.edition && inf.sol) this.majApercuTrace(inf);
      clearTimeout(this._tStatut);
      this._tStatut = setTimeout(() => this.majStatut(this._infoTrace || null), 30);
    }
    surDown(inf) {
      if (!this.edition || inf.bouton !== 0 || !inf.sol) return false;
      this.infobulle.classList.add('masque');
      const p = { x: this.snap(inf.sol.x, inf.alt), y: this.snap(inf.sol.y, inf.alt) };
      if (this.calibrage) { this.drag = { type: 'clic', p, brut: inf.sol }; return true; }
      switch (this.outil) {
        case 'selection': {
          const o = this.selectionnable(inf.id);
          if (!o) return false;
          if (inf.shift) { this.selectionner([o.id], true); this.drag = { type: 'rien' }; return true; }
          if (!this.selection.includes(o.id)) this.selectionner([o.id]);
          const mobiles = this.selection.map((id) => this.objet(id)).filter((x) => x && !x.verrouille);
          if (!mobiles.length) { this.drag = { type: 'rien' }; if (o.verrouille) toast('Objet verrouillé : déverrouillez-le dans le panneau Propriétés pour le déplacer.', 'info'); return true; }
          this.drag = { type: 'deplacer', ids: mobiles.map((x) => x.id), depart: inf.sol, ref: { x: o.x, y: o.y }, dx: 0, dy: 0 };
          return true;
        }
        case 'rotation': {
          let ids = this.selection.slice();
          const o = this.selectionnable(inf.id);
          if (o && !ids.includes(o.id)) { this.selectionner([o.id]); ids = [o.id]; }
          const mobiles = ids.map((id) => this.objet(id)).filter((x) => x && !x.verrouille);
          if (!mobiles.length) return false;
          const c = this.centreDe(mobiles);
          this.drag = { type: 'rotation', ids: mobiles.map((x) => x.id), c, a0: Math.atan2(inf.sol.y - c.y, inf.sol.x - c.x), drot: 0 };
          return true;
        }
        case 'zone': case 'batiment':
          this.drag = { type: 'rectangle', p0: p, p1: p };
          return true;
        default:
          this.drag = { type: 'clic', p, brut: inf.sol };
          return true;
      }
    }
    surMove(inf) {
      const d = this.drag;
      if (!d || !inf.sol) return;
      this.curseurSol = inf.sol;
      if (d.type === 'deplacer') {
        const ref = d.ref;
        const nx = this.snap(ref.x + (inf.sol.x - d.depart.x), inf.alt), ny = this.snap(ref.y + (inf.sol.y - d.depart.y), inf.alt);
        d.dx = r3(nx - ref.x); d.dy = r3(ny - ref.y);
        this.moteur.decalageTemporaire({ ids: d.ids, dx: d.dx, dy: d.dy });
        this.majStatut(`Déplacement : ${fmtL(d.dx)} ; ${fmtL(d.dy)}`);
      } else if (d.type === 'rotation') {
        let a = (Math.atan2(inf.sol.y - d.c.y, inf.sol.x - d.c.x) - d.a0) * 180 / Math.PI;
        if (!inf.alt) a = Math.round(a / 15) * 15;
        d.drot = a;
        this.moteur.decalageTemporaire({ ids: d.ids, drot: a, cx: d.c.x, cy: d.c.y });
        this.majStatut(`Rotation : ${ui.formatNombre(((a % 360) + 360) % 360, 0)}°`);
      } else if (d.type === 'rectangle') {
        d.p1 = { x: this.snap(inf.sol.x, inf.alt), y: this.snap(inf.sol.y, inf.alt) };
        const w = Math.abs(d.p1.x - d.p0.x), h = Math.abs(d.p1.y - d.p0.y);
        if (w > 0.2 || h > 0.2) {
          d.trace = true;
          const alt = this.niveauDe(this.niveauActifId()).altitude;
          this.moteur.definirApercus([{ forme: 'prisme', points: [[d.p0.x, d.p0.y], [d.p1.x, d.p0.y], [d.p1.x, d.p1.y], [d.p0.x, d.p1.y]], y0: alt, hauteur: this.outil === 'batiment' ? 3 : 0.06, couleur: this.outil === 'batiment' ? '#64748b' : '#3b82f6', opacite: 0.35, aretes: true }]);
          this.majStatut(`${ui.formatNombre(w)} × ${ui.formatNombre(h)} m (${ui.formatNombre(w * h, 1)} m²)`);
        }
      }
    }
    surUp(inf) {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (inf.annule) { this.moteur.decalageTemporaire(null); this.moteur.definirApercus([]); return; }
      if (d.type === 'deplacer') {
        this.moteur.decalageTemporaire(null);
        if (d.dx || d.dy) this.deplacer(d.ids, d.dx, d.dy, 'Déplacement');
        return;
      }
      if (d.type === 'rotation') {
        this.moteur.decalageTemporaire(null);
        if (d.drot) this.pivoter(d.ids, d.drot, d.c);
        return;
      }
      if (d.type === 'rectangle') {
        this.moteur.definirApercus([]);
        const w = Math.abs(d.p1.x - d.p0.x), h = Math.abs(d.p1.y - d.p0.y);
        if (d.trace && w >= 0.3 && h >= 0.3 && !this.trace) {
          const x1 = Math.min(d.p0.x, d.p1.x), x2 = Math.max(d.p0.x, d.p1.x), y1 = Math.min(d.p0.y, d.p1.y), y2 = Math.max(d.p0.y, d.p1.y);
          this.creerPolygone([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
        } else this.ajouterSommet(d.p0);
        return;
      }
      if (d.type === 'clic' && !inf.bouge) this.clicOutil(d.p, d.brut, inf);
    }

    // ----- Outils de création -----------------------------------------------------------------
    clicOutil(p, brut, inf) {
      if (this.calibrage) { this.pointCalibrage(brut); return; }
      const alt = this.niveauActifId();
      const ids = new Set(this.objets.map((o) => o.id));
      const base = { id: nouvelId(ids), niveauId: alt, z: 0, rotation: 0, verrouille: false };
      switch (this.outil) {
        case 'machine':
          this.ajouterObjets([Object.assign(base, { type: 'machine', nom: 'Nouvelle machine', x: p.x, y: p.y, largeur: 2, profondeur: 1.5, hauteur: 1.8, forme: 'boite', couleur: '#2563eb', equipementId: null })], 'Ajout d\'une machine', true);
          this.choisirOutil('selection');
          break;
        case 'installation': {
          const c = CATEGORIES[this.categorie] || CATEGORIES.autre;
          if (c.segment) { this.pointSegment(p, inf); return; }
          this.ajouterObjets([Object.assign(base, { type: 'installation', categorie: this.categorie, nom: c.label, x: p.x, y: p.y, largeur: c.l, profondeur: c.p, hauteur: c.h, forme: c.forme || 'boite', couleur: c.couleur, equipementId: null })], 'Ajout : ' + c.label, true);
          break;
        }
        case 'porte': {
          const mur = this.murProche(brut);
          const o = Object.assign(base, { type: 'porte', nom: 'Porte', x: p.x, y: p.y, largeur: 1.2, profondeur: 0.35, hauteur: 2.1, couleur: '#92400e' });
          if (mur) Object.assign(o, { x: r3(mur.x), y: r3(mur.y), rotation: r3(mur.angle), profondeur: r3((mur.mur.epaisseur || 0.2) + 0.15) });
          this.ajouterObjets([o], 'Ajout d\'une porte', true);
          if (!mur) toast('Aucun mur à proximité : porte placée librement.', 'info');
          break;
        }
        case 'texte':
          ui.prompt({ titre: 'Nouveau texte', label: 'Texte affiché sur le plan', okLabel: 'Ajouter' }).then((t) => {
            if (!t || !String(t).trim()) return;
            this.ajouterObjets([Object.assign(base, { type: 'texte', nom: String(t).trim().slice(0, 120), texte: String(t).trim().slice(0, 200), taille: 1, x: p.x, y: p.y, largeur: 4, profondeur: 1, hauteur: 0, couleur: '#1f2937' })], 'Ajout d\'un texte', true);
          });
          break;
        case 'mur': case 'allee':
          this.pointSegment(p, inf);
          break;
        case 'zone': case 'batiment':
          this.ajouterSommet(p);
          break;
        default:
      }
    }
    contraindre(depart, p, inf) {
      if (!inf || !inf.shift || !depart) return p;
      const dx = p.x - depart.x, dy = p.y - depart.y, l = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x: r3(depart.x + Math.cos(a) * l), y: r3(depart.y + Math.sin(a) * l) };
    }
    pointSegment(p, inf) {
      if (!this.trace) { this.trace = { type: 'segment', points: [p] }; this.majStatut(); return; }
      const dernier = this.trace.points[this.trace.points.length - 1];
      const q = this.contraindre(dernier, p, inf);
      if (Math.hypot(q.x - dernier.x, q.y - dernier.y) < 0.05) return;
      const ids = new Set(this.objets.map((o) => o.id));
      const base = { id: nouvelId(ids), niveauId: this.niveauActifId(), rotation: 0, verrouille: false, x: dernier.x, y: dernier.y, x2: q.x, y2: q.y, largeur: r3(Math.hypot(q.x - dernier.x, q.y - dernier.y)) };
      let o;
      if (this.outil === 'mur') o = Object.assign(base, { type: 'mur', nom: 'Mur', epaisseur: 0.2, hauteur: Math.min(4, this.niveauDe(this.niveauActifId()).hauteur || 4), z: 0, couleur: '#94a3b8', profondeur: 0.2 });
      else if (this.outil === 'allee') o = Object.assign(base, { type: 'allee', nom: 'Allée', epaisseur: 3, hauteur: 0.02, z: 0, couleur: '#facc15', profondeur: 3 });
      else { const c = CATEGORIES[this.categorie]; o = Object.assign(base, { type: 'installation', categorie: this.categorie, nom: c.label, epaisseur: c.epaisseur, hauteur: c.epaisseur, z: c.z, couleur: c.couleur, profondeur: c.epaisseur, forme: 'boite', equipementId: null }); }
      this.ajouterObjets([o], 'Tracé : ' + libType(o), false);
      this.trace.points.push(q);
      this.majApercuTrace({ sol: q });
    }
    ajouterSommet(p) {
      if (!this.trace) this.trace = { type: 'polygone', points: [] };
      const pts = this.trace.points;
      if (pts.length >= 3) {
        const d0 = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
        if (d0 < Math.max(0.4, (Number(cfg().grilleM) || 0.5) * 0.9)) { this.terminerTrace(true); return; }
      }
      const dernier = pts[pts.length - 1];
      if (dernier && Math.hypot(p.x - dernier.x, p.y - dernier.y) < 0.05) return;
      pts.push(p);
      this.majApercuTrace({ sol: p });
      this.majStatut(`${pts.length} sommet(s) — double-clic ou Entrée pour fermer`);
    }
    majApercuTrace(inf) {
      if (this.calibrage) return; // les repères de calibrage restent affichés
      const t = this.trace;
      this._infoTrace = null;
      const alt = this.niveauDe(this.niveauActifId()).altitude;
      const cur = inf && inf.sol ? { x: this.snap(inf.sol.x, inf.alt), y: this.snap(inf.sol.y, inf.alt) } : null;
      if (!t || !cur) {
        // fantôme de placement
        if (cur && !this.drag && ['machine', 'installation', 'porte'].includes(this.outil) && !(this.outil === 'installation' && CATEGORIES[this.categorie].segment)) {
          const c = this.outil === 'machine' ? { l: 2, p: 1.5, h: 1.8, couleur: '#2563eb' } : this.outil === 'porte' ? { l: 1.2, p: 0.35, h: 2.1, couleur: '#92400e' } : CATEGORIES[this.categorie];
          let x = cur.x, y = cur.y, rot = 0;
          if (this.outil === 'porte') { const m = this.murProche(inf.sol); if (m) { x = m.x; y = m.y; rot = m.angle; } }
          this.moteur.definirApercus([{ forme: c.forme === 'cylindre' ? 'cylindre' : 'boite', x, y, largeur: c.l, profondeur: c.p, hauteur: c.h, rotation: rot, y0: alt, couleur: c.couleur, opacite: 0.45 }]);
        } else if (this.moteur.apercus.length && !this.drag) this.moteur.definirApercus([]);
        return;
      }
      const pts = t.points;
      const dernier = pts[pts.length - 1];
      const q = t.type === 'segment' ? this.contraindre(dernier, cur, inf) : cur;
      const apercus = [];
      if (t.type === 'segment') {
        const ep = this.outil === 'mur' ? 0.2 : this.outil === 'allee' ? 3 : (CATEGORIES[this.categorie].epaisseur || 0.15);
        const h = this.outil === 'mur' ? 3 : this.outil === 'allee' ? 0.02 : ep;
        const z = this.outil === 'installation' ? CATEGORIES[this.categorie].z || 0 : 0;
        if (Math.hypot(q.x - dernier.x, q.y - dernier.y) > 0.02) apercus.push({ forme: 'segment', x: dernier.x, y: dernier.y, x2: q.x, y2: q.y, epaisseur: ep, y0: alt + z + (this.outil === 'allee' ? 0.06 : 0), hauteur: h, couleur: this.outil === 'allee' ? '#facc15' : '#2563eb', opacite: 0.5 });
        this._infoTrace = `Longueur : ${fmtL(Math.hypot(q.x - dernier.x, q.y - dernier.y))}`;
      } else {
        const tous = pts.concat([q]);
        for (let i = 0; i < tous.length - 1; i++) apercus.push({ forme: 'segment', x: tous[i].x, y: tous[i].y, x2: tous[i + 1].x, y2: tous[i + 1].y, epaisseur: 0.12, y0: alt + 0.06, hauteur: 0.05, couleur: '#2563eb', opacite: 0.9 });
        if (tous.length >= 3) apercus.push({ forme: 'prisme', points: tous.map((a) => [a.x, a.y]), y0: alt, hauteur: 0.04, couleur: '#3b82f6', opacite: 0.25 });
        for (const a of pts) apercus.push({ forme: 'cylindre', x: a.x, y: a.y, largeur: 0.35, profondeur: 0.35, hauteur: 0.12, y0: alt + 0.05, couleur: '#1d4ed8', opacite: 0.9 });
      }
      this.moteur.definirApercus(apercus);
    }
    terminerTrace(fermer) {
      const t = this.trace;
      if (t && t.type === 'polygone' && fermer && t.points.length >= 3) {
        const pts = t.points.map((p) => [p.x, p.y]);
        if (aire(pts) >= 0.1) this.creerPolygone(pts); else toast('Polygone trop petit', 'alerte');
      }
      this.annulerTrace();
    }
    annulerTrace() {
      this.trace = null; this.drag = null; this._infoTrace = null;
      if (this.calibrage) { this.calibrage = null; }
      if (this.moteur) { this.moteur.definirApercus([]); this.moteur.decalageTemporaire(null); }
      this.majStatut();
    }
    creerPolygone(pts) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
      const ids = new Set(this.objets.map((o) => o.id));
      const batiment = this.outil === 'batiment';
      const nb = this.objets.filter((o) => o.type === this.outil).length + 1;
      const o = { id: nouvelId(ids), type: batiment ? 'batiment' : 'zone', nom: batiment ? `Bâtiment ${nb}` : `Zone ${nb}`, niveauId: this.niveauActifId(), points: pts.map((p) => p.map(r3)), x: r3((x1 + x2) / 2), y: r3((y1 + y2) / 2), largeur: r3(x2 - x1), profondeur: r3(y2 - y1), hauteur: batiment ? Math.max(3, this.niveauDe(this.niveauActifId()).hauteur || 6) : 0.05, rotation: 0, z: 0, couleur: batiment ? '#cbd5e1' : ['#3b82f6', '#16a34a', '#f59e0b', '#8b5cf6', '#0891b2', '#db2777'][nb % 6], secteurId: null, verrouille: false };
      this.trace = null;
      this.moteur.definirApercus([]);
      this.ajouterObjets([o], batiment ? 'Ajout d\'un bâtiment' : 'Ajout d\'une zone', true);
      this.choisirOutil('selection');
    }
    murProche(p) {
      if (!p) return null;
      let best = null;
      for (const m of this.objets) {
        if (m.type !== 'mur' || m.niveauId !== this.niveauActifId()) continue;
        const dx = m.x2 - m.x, dy = m.y2 - m.y, l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((p.x - m.x) * dx + (p.y - m.y) * dy) / l2));
        const px = m.x + t * dx, py = m.y + t * dy, d = Math.hypot(p.x - px, p.y - py);
        if (d < 1.5 && (!best || d < best.d)) best = { d, x: px, y: py, angle: Math.atan2(dy, dx) * 180 / Math.PI, mur: m };
      }
      return best;
    }

    // ----- Modifications & historique ----------------------------------------------------------
    /** changements : [{ id, avant: objet | null, apres: objet | null }] ; plan : { avant, apres } (niveaux, fond, dimensions, propriétés). */
    appliquer(changements, libelle, plan) {
      const entree = { libelle, changements: changements.map((c) => ({ id: c.id, avant: c.avant ? copie(c.avant) : null, apres: c.apres ? copie(c.apres) : null })), plan: plan ? copie(plan) : null };
      this.historique = this.historique.slice(0, this.indexHisto);
      this.historique.push(entree);
      if (this.historique.length > 100) this.historique.shift();
      this.indexHisto = this.historique.length;
      this.rejouer(entree, 'apres');
    }
    rejouer(entree, sens) {
      const ids = [];
      for (const c of entree.changements) {
        const cible = c[sens];
        const i = this.objets.findIndex((o) => o.id === c.id);
        if (cible) { if (i >= 0) this.objets[i] = copie(cible); else this.objets.push(copie(cible)); } else if (i >= 0) this.objets.splice(i, 1);
        ids.push(c.id);
      }
      if (entree.plan) {
        const etatPlan = entree.plan[sens];
        if (etatPlan.niveaux) this.niveaux = copie(etatPlan.niveaux);
        if (etatPlan.dimensions) this.dimensions = copie(etatPlan.dimensions);
        if (etatPlan.fond !== undefined) { this.fond = etatPlan.fond ? copie(etatPlan.fond) : null; this.fondModifie = true; }
        if (etatPlan.proprietes) { this.proprietes = copie(etatPlan.proprietes); this.majTitre(); }
        this.majSelectNiveau();
        this.appliquerFond();
        this.selection = this.selection.filter((id) => this.objet(id));
        this.synchroniser();
      } else {
        this.selection = this.selection.filter((id) => this.objet(id));
        this.majObjetsMoteur(ids);
      }
      this.marquerModifie(true);
      this.rendrePanneau();
      this.majBoutonsActions();
      this.majStatut();
    }
    annuler() {
      if (!this.edition || this.indexHisto <= 0) return;
      const e = this.historique[--this.indexHisto];
      this.rejouer(e, 'avant');
      this.reselectionner(e, 'avant');
      toast('Annulé : ' + e.libelle, 'info', 1800);
    }
    retablir() {
      if (!this.edition || this.indexHisto >= this.historique.length) return;
      const e = this.historique[this.indexHisto++];
      this.rejouer(e, 'apres');
      this.reselectionner(e, 'apres');
      toast('Rétabli : ' + e.libelle, 'info', 1800);
    }
    /** Après annuler / rétablir : les objets concernés encore présents sont sélectionnés. */
    reselectionner(entree, sens) {
      const ids = entree.changements.filter((c) => c[sens]).map((c) => c.id).filter((id) => this.objet(id));
      if (ids.length && ids.length <= 200) this.selectionner(ids);
    }
    marquerModifie(v) {
      this.modifie = !!v;
      if (this.indicModif) this.indicModif.classList.toggle('masque', !this.modifie);
    }
    ajouterObjets(objs, libelle, selectionner) {
      this.appliquer(objs.map((o) => ({ id: o.id, avant: null, apres: o })), libelle);
      if (selectionner) this.selectionner(objs.map((o) => o.id));
    }
    modifierObjet(id, patch, libelle) {
      const o = this.objet(id);
      if (!o) return;
      const apres = Object.assign(copie(o), patch);
      this.appliquer([{ id, avant: o, apres }], libelle || 'Modification');
    }
    translater(o, dx, dy) {
      const r = copie(o);
      r.x = r3(r.x + dx); r.y = r3(r.y + dy);
      if (r.x2 != null) { r.x2 = r3(r.x2 + dx); r.y2 = r3(r.y2 + dy); }
      if (r.points) r.points = r.points.map(([x, y]) => [r3(x + dx), r3(y + dy)]);
      return r;
    }
    deplacer(ids, dx, dy, libelle) {
      const ch = ids.map((id) => this.objet(id)).filter((o) => o && !o.verrouille).map((o) => ({ id: o.id, avant: o, apres: this.translater(o, dx, dy) }));
      if (ch.length) this.appliquer(ch, libelle || 'Déplacement');
    }
    centreDe(objs) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const o of objs) {
        const pts = o.points || (o.x2 != null ? [[o.x, o.y], [o.x2, o.y2]] : [[o.x, o.y]]);
        for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
    pivoter(ids, angle, centre) {
      const objs = ids.map((id) => this.objet(id)).filter((o) => o && !o.verrouille);
      if (!objs.length) return;
      const c = centre || this.centreDe(objs);
      const a = angle * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
      const rot = (x, y) => [r3(c.x + (x - c.x) * co - (y - c.y) * si), r3(c.y + (x - c.x) * si + (y - c.y) * co)];
      const ch = objs.map((o) => {
        const r = copie(o);
        [r.x, r.y] = rot(o.x, o.y);
        if (o.x2 != null) [r.x2, r.y2] = rot(o.x2, o.y2);
        if (o.points) {
          r.points = o.points.map(([x, y]) => rot(x, y));
          const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]);
          Object.assign(r, { x: r3((Math.min(...xs) + Math.max(...xs)) / 2), y: r3((Math.min(...ys) + Math.max(...ys)) / 2), largeur: r3(Math.max(...xs) - Math.min(...xs)), profondeur: r3(Math.max(...ys) - Math.min(...ys)), rotation: 0 });
        } else if (o.x2 == null) r.rotation = r3((((o.rotation || 0) + angle) % 360 + 360) % 360);
        return { id: o.id, avant: o, apres: r };
      });
      this.appliquer(ch, `Rotation de ${ui.formatNombre(angle, 0)}°`);
    }
    copierObjets(objs, dx, dy) {
      const ids = new Set(this.objets.map((o) => o.id));
      return objs.map((o) => {
        const c = this.translater(o, dx, dy);
        c.id = nouvelId(ids); ids.add(c.id);
        c.equipementId = o.equipementId != null || o.equipementMasque ? null : c.equipementId;
        delete c.equipementMasque;
        c.verrouille = false;
        return c;
      });
    }
    dupliquerSelection() {
      if (!this.edition || !this.selection.length) return;
      const objs = this.selection.map((id) => this.objet(id)).filter(Boolean);
      const g = Math.max(1, Number(cfg().grilleM) || 0.5) * 2;
      const copies = this.copierObjets(objs, g, g).map((c) => (c.type === 'zone' ? Object.assign(c, { secteurId: c.secteurId }) : c));
      this.ajouterObjets(copies, `Duplication de ${copies.length} objet(s)`, true);
      if (objs.some((o) => o.equipementId != null)) toast('Les copies ne sont pas liées aux équipements (un équipement n\'est placé qu\'une fois par plan).', 'info');
    }
    copier() {
      if (!this.selection.length) return;
      this.pressePapier = this.selection.map((id) => copie(this.objet(id))).filter(Boolean);
      this.majBoutonsActions();
      toast(`${this.pressePapier.length} objet(s) copié(s)`, 'info', 1500);
    }
    coller() {
      if (!this.edition || !this.pressePapier.length) return;
      const c = this.centreDe(this.pressePapier);
      const cible = this.curseurSol || { x: c.x + 2, y: c.y + 2 };
      const dx = this.snap(cible.x - c.x), dy = this.snap(cible.y - c.y);
      const copies = this.copierObjets(this.pressePapier, dx, dy).map((o) => Object.assign(o, { niveauId: this.niveauActifId() }));
      this.ajouterObjets(copies, `Collage de ${copies.length} objet(s)`, true);
    }
    supprimerSelection() {
      if (!this.edition || !this.selection.length) return;
      const objs = this.selection.map((id) => this.objet(id)).filter(Boolean);
      const verrouilles = objs.filter((o) => o.verrouille);
      const libres = objs.filter((o) => !o.verrouille);
      if (verrouilles.length) toast(`${verrouilles.length} objet(s) verrouillé(s) non supprimé(s)`, 'alerte');
      if (!libres.length) return;
      this.selection = [];
      this.appliquer(libres.map((o) => ({ id: o.id, avant: o, apres: null })), `Suppression de ${libres.length} objet(s)`);
    }

    // ----- Panneau latéral --------------------------------------------------------------------
    rendrePanneau() {
      const p = this.panneau;
      ui.vider(p);
      const objs = this.selection.map((id) => this.objet(id)).filter(Boolean);
      if (objs.length > 1) return this.panneauMulti(objs);
      if (objs.length === 1) return this.edition ? this.panneauProprietes(objs[0]) : this.panneauConsultation(objs[0]);
      return this.panneauPlan();
    }
    section(titre, contenu, actions) {
      return el('div', { class: 'p3d-section' }, el('div', { class: 'p3d-section-titre' }, el('span', null, titre), actions || null), contenu);
    }
    panneauPlan() {
      const p = this.panneau;
      p.appendChild(el('h3', null, ic('plan3d'), this.proprietes.nom));
      p.appendChild(el('div', { class: 'texte-2 texte-petit' }, [this.plan.numero, ui.cheminSecteur(this.proprietes.secteurId)].filter(Boolean).join(' · ')));
      if (this.proprietes.description) p.appendChild(el('p', { class: 'texte-petit mt', style: { whiteSpace: 'pre-wrap' } }, this.proprietes.description));
      const parType = {};
      for (const o of this.objets) parType[o.type] = (parType[o.type] || 0) + 1;
      const lies = this.objets.filter((o) => o.equipementId != null && this.infos.has(Number(o.equipementId)));
      const urgents = lies.filter((o) => this.infos.get(Number(o.equipementId)).alerte === 'urgent').length;
      const enCours = lies.filter((o) => this.infos.get(Number(o.equipementId)).alerte === 'en_cours').length;
      p.appendChild(el('div', { class: 'p3d-indicateurs' },
        el('div', { class: 'p3d-ind' }, el('div', { class: 'v' }, String(parType.machine || 0)), el('div', { class: 'l' }, 'machines')),
        el('div', { class: 'p3d-ind' }, el('div', { class: 'v' }, String(lies.length)), el('div', { class: 'l' }, 'équipements liés')),
        el('div', { class: 'p3d-ind', style: { borderLeft: '3px solid ' + ALERTES.urgent.couleur } }, el('div', { class: 'v' }, String(urgents)), el('div', { class: 'l' }, 'interventions urgentes')),
        el('div', { class: 'p3d-ind', style: { borderLeft: '3px solid ' + ALERTES.en_cours.couleur } }, el('div', { class: 'v' }, String(enCours)), el('div', { class: 'l' }, 'en cours'))));
      p.appendChild(this.section('Plan', ui.details([
        { label: 'Dimensions', valeur: `${fmtL(this.dimensions.largeur)} × ${fmtL(this.dimensions.profondeur)}` },
        { label: 'Niveaux', valeur: this.niveaux.map((n) => n.nom).join(', ') },
        { label: 'Objets', valeur: Object.entries(parType).map(([t, n]) => `${n} ${(TYPES[t] || {}).pluriel ? (n > 1 ? TYPES[t].pluriel : TYPES[t].label).toLowerCase() : t}`).join(', ') || 'aucun' },
        { label: 'Fond de plan', valeur: this.fond ? (this.fond.nomFichier || 'oui') : 'aucun' },
        { label: 'Modifié', valeur: `${ui.formatDateHeure(this.plan.updatedAt)}${this.plan.updatedByNom ? ' par ' + this.plan.updatedByNom : ''}` },
        { label: 'Version', valeur: String(this.version) },
      ])));
      // équipements du plan, triés par urgence
      const ordre = { urgent: 0, en_cours: 1, aucun: 2 };
      const machines = this.objets.filter((o) => o.equipementId != null && this.infos.has(Number(o.equipementId)))
        .sort((a, b) => (ordre[this.infos.get(Number(a.equipementId)).alerte] - ordre[this.infos.get(Number(b.equipementId)).alerte]) || String(this.infos.get(Number(a.equipementId)).nom).localeCompare(String(this.infos.get(Number(b.equipementId)).nom), 'fr'));
      const liste = el('div', { class: 'p3d-liste' });
      for (const o of machines) {
        const info = this.infos.get(Number(o.equipementId));
        liste.appendChild(el('div', { class: 'p3d-item', title: 'Localiser sur le plan', onclick: () => this.focaliserObjet(o.id) },
          el('span', { class: 'p3d-pastille', style: { background: this.couleurObjet(o) } }),
          el('span', { class: 'nom' }, info.nom),
          info.nbOtOuverts ? ui.badge(`${info.nbOtOuverts} OT`, (ALERTES[info.alerte] || ALERTES.en_cours).couleur) : null,
          el('span', { class: 'num' }, info.numero)));
      }
      p.appendChild(this.section(`Équipements sur le plan (${machines.length})`, machines.length ? liste : el('div', { class: 'texte-2 texte-petit' }, this.peutEditer ? 'Aucun équipement lié : passez en édition, sélectionnez une machine et liez-la à un équipement.' : 'Aucun équipement lié à ce plan.')));
      if (this.edition) {
        p.appendChild(this.section('Édition', el('div', { class: 'p3d-actions' },
          ui.bouton('Propriétés', { icone: 'engrenage', classe: 'btn-sm', onClic: () => this.ouvrirProprietes() }),
          ui.bouton('Niveaux', { classe: 'btn-sm', onClic: () => this.ouvrirNiveaux() }),
          ui.bouton('Fond de plan', { classe: 'btn-sm', onClic: () => this.ouvrirFond() }),
          ui.bouton('Mémoriser la vue', { icone: 'camera', classe: 'btn-sm', titre: 'La vue actuelle devient la vue par défaut à l\'ouverture du plan', onClic: () => { const c = this.moteur.camera; this.vue = { x: c.x, y: c.y, z: c.z, distance: c.distance, azimut: c.azimut, elevation: c.elevation, dessus: c.dessus }; this.vueModifiee = true; this.marquerModifie(true); toast('Vue par défaut mémorisée (à enregistrer)', 'info'); } }))));
      }
    }
    panneauConsultation(o) {
      const p = this.panneau;
      const info = o.equipementId != null ? this.infos.get(Number(o.equipementId)) : null;
      p.appendChild(el('div', { class: 'inline', style: { justifyContent: 'space-between', width: '100%' } }, el('span', { class: 'texte-2 texte-petit' }, libType(o)), el('button', { class: 'btn btn-icone btn-sm', title: 'Fermer', onclick: () => this.selectionner([]) }, icone('fermer'))));
      p.appendChild(el('h3', null, ic(TYPES[o.type] ? TYPES[o.type].icone : 'cube'), (info && info.nom) || o.nom || o.texte || libType(o)));
      if (info) {
        p.appendChild(el('div', { class: 'texte-2 texte-petit' }, info.numero + (info.actif === false ? ' · inactif' : '')));
        p.appendChild(el('div', { class: 'inline mt', style: { flexWrap: 'wrap' } }, ui.badgeListe('etatsEquipement', info.etatCode), ui.badgeListe('criticites', info.criticiteCode), info.typeCode ? ui.badge(ui.libelle('typesEquipement', info.typeCode)) : null));
        p.appendChild(el('div', { class: 'p3d-indicateurs' },
          el('div', { class: 'p3d-ind', style: { borderLeft: '3px solid ' + (ALERTES[info.alerte] || ALERTES.aucun).couleur } }, el('div', { class: 'v' }, String(info.nbOtOuverts)), el('div', { class: 'l' }, 'OT ouvert(s)')),
          el('div', { class: 'p3d-ind' }, el('div', { class: 'v' }, String(info.nbDemandesOuvertes)), el('div', { class: 'l' }, 'demande(s) ouverte(s)'))));
        p.appendChild(this.section('Équipement', ui.details([
          { label: 'Secteur', valeur: ui.cheminSecteur(info.secteurId) || '—' },
          { label: 'Priorité max.', valeur: info.prioriteMax ? ui.badgeListe('priorites', info.prioriteMax) : '—' },
          { label: 'Situation', valeur: el('span', { class: 'inline' }, el('span', { class: 'p3d-pastille', style: { background: (ALERTES[info.alerte] || ALERTES.aucun).couleur } }), (ALERTES[info.alerte] || ALERTES.aucun).label) },
          info.arretProduction ? { label: 'Production', valeur: el('span', { class: 'texte-danger texte-gras' }, 'Arrêt de production signalé') } : null,
        ])));
        const actions = el('div', { class: 'p3d-actions' });
        if (GMAO.can('equipements', 'voir')) actions.appendChild(el('a', { class: 'btn btn-sm', href: '#/equipements/' + info.id }, icone('equipements'), 'Fiche équipement'));
        if (GMAO.can('demandes', 'creer')) actions.appendChild(el('a', { class: 'btn btn-sm', href: `#/demandes?nouveau=1&equipementId=${info.id}` }, icone('demandes'), 'Nouvelle demande'));
        if (GMAO.can('ot', 'creer')) actions.appendChild(el('a', { class: 'btn btn-sm btn-primaire', href: `#/ot?nouveau=1&equipementId=${info.id}` }, icone('ot'), 'Nouvel OT'));
        if (GMAO.can('ot', 'voir') && info.nbOtOuverts) actions.appendChild(el('a', { class: 'btn btn-sm btn-lien', href: `#/ot?equipementId=${info.id}` }, 'Voir les OT'));
        p.appendChild(actions);
      } else if (o.equipementMasque) {
        p.appendChild(ui.alerte('Équipement hors de votre périmètre : ses informations ne sont pas affichées.', 'info'));
      } else if (o.type === 'machine') {
        p.appendChild(el('div', { class: 'texte-2 texte-petit mt' }, 'Machine non liée à un équipement de la GMAO.'));
      }
      if (o.type === 'zone' || o.type === 'batiment') {
        const pts = o.points && o.points.length >= 3 ? o.points : rectPoints(o);
        const dedans = this.objets.filter((x) => (x.type === 'machine' || (x.type === 'installation' && !estSegment(x))) && x.niveauId === o.niveauId && pointDans(x.x, x.y, pts));
        p.appendChild(this.section(o.type === 'zone' ? 'Zone' : 'Bâtiment', ui.details([
          o.secteurId != null ? { label: 'Secteur', valeur: ui.cheminSecteur(o.secteurId) } : null,
          { label: 'Surface', valeur: `${ui.formatNombre(aire(pts), 1)} m²` },
          { label: 'Emprise', valeur: `${fmtL(o.largeur)} × ${fmtL(o.profondeur)}` },
          o.type === 'batiment' ? { label: 'Hauteur', valeur: fmtL(o.hauteur) } : null,
          { label: 'Niveau', valeur: this.niveauDe(o.niveauId).nom },
        ])));
        if (dedans.length) {
          p.appendChild(this.section(`Contenu (${dedans.length})`, el('div', { class: 'p3d-liste' }, dedans.map((x) => {
            const i2 = this.infos.get(Number(x.equipementId));
            return el('div', { class: 'p3d-item', onclick: () => this.focaliserObjet(x.id) }, el('span', { class: 'p3d-pastille', style: { background: this.couleurObjet(x) } }), el('span', { class: 'nom' }, (i2 && i2.nom) || x.nom || libType(x)), el('span', { class: 'num' }, i2 ? i2.numero : libType(x)));
          }))));
        }
      } else {
        p.appendChild(this.section('Implantation', ui.details([
          { label: 'Type', valeur: libType(o) },
          estSegment(o) ? { label: 'Longueur', valeur: fmtL(Math.hypot(o.x2 - o.x, o.y2 - o.y)) } : { label: 'Dimensions', valeur: `${fmtL(o.largeur)} × ${fmtL(o.profondeur)}${o.hauteur ? ' × ' + fmtL(o.hauteur) : ''}` },
          { label: 'Position', valeur: `x ${fmtL(o.x)} · y ${fmtL(o.y)}` },
          o.z ? { label: 'Élévation', valeur: fmtL(o.z) } : null,
          { label: 'Niveau', valeur: this.niveauDe(o.niveauId).nom },
        ])));
      }
      p.appendChild(el('div', { class: 'p3d-actions' }, ui.bouton('Centrer la vue', { icone: 'recherche', classe: 'btn-sm', onClic: () => this.moteur.allerVers(o.id, { clignoter: true }) })));
    }
    panneauMulti(objs) {
      const p = this.panneau;
      p.appendChild(el('h3', null, ic('curseur'), `${objs.length} objets sélectionnés`));
      const liste = el('div', { class: 'p3d-liste' }, objs.map((o) => el('div', { class: 'p3d-item', onclick: () => this.selectionner([o.id]) }, el('span', { class: 'p3d-pastille', style: { background: this.couleurObjet(o) } }), el('span', { class: 'nom' }, o.nom || o.texte || libType(o)), el('span', { class: 'num' }, libType(o)))));
      p.appendChild(this.section('Sélection', liste));
      if (this.edition) {
        const selNiv = el('select', null, this.niveaux.map((n) => el('option', { value: n.id }, n.nom)));
        selNiv.value = objs[0].niveauId;
        p.appendChild(this.section('Actions', el('div', null,
          el('div', { class: 'p3d-actions' },
            ui.bouton('Dupliquer', { icone: 'copier', classe: 'btn-sm', onClic: () => this.dupliquerSelection() }),
            ui.bouton('Pivoter de 15°', { icone: 'rafraichir', classe: 'btn-sm', onClic: () => this.pivoter(this.selection, 15) }),
            ui.bouton('Verrouiller', { classe: 'btn-sm', onClic: () => this.appliquer(objs.map((o) => ({ id: o.id, avant: o, apres: Object.assign(copie(o), { verrouille: true }) })), 'Verrouillage') }),
            ui.bouton('Déverrouiller', { classe: 'btn-sm', onClic: () => this.appliquer(objs.map((o) => ({ id: o.id, avant: o, apres: Object.assign(copie(o), { verrouille: false }) })), 'Déverrouillage') }),
            ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: () => this.supprimerSelection() })),
          el('div', { class: 'champ mt' }, el('label', null, 'Déplacer vers le niveau'), el('div', { class: 'inline' }, selNiv, ui.bouton('Appliquer', { classe: 'btn-sm', onClic: () => { const n = selNiv.value; this.appliquer(objs.map((o) => ({ id: o.id, avant: o, apres: Object.assign(copie(o), { niveauId: n }) })), 'Changement de niveau'); this.selectionner([]); } }))))));
      }
    }
    panneauProprietes(o) {
      const p = this.panneau;
      const pre = (cle) => ({ nom: cle });
      p.appendChild(el('div', { class: 'inline', style: { justifyContent: 'space-between', width: '100%' } }, el('span', { class: 'texte-2 texte-petit' }, libType(o) + (o.verrouille ? ' · verrouillé' : '')), el('button', { class: 'btn btn-icone btn-sm', title: 'Désélectionner (Échap)', onclick: () => this.selectionner([]) }, icone('fermer'))));
      p.appendChild(el('h3', null, ic(TYPES[o.type] ? TYPES[o.type].icone : 'cube'), o.nom || o.texte || libType(o)));
      const u = unite().l;
      const champs = [];
      const seg = estSegment(o);
      const poly = !!(o.points && o.points.length >= 3);
      champs.push({ nom: 'nom', label: 'Nom', pleineLargeur: true });
      if (o.type === 'installation') champs.push({ nom: 'categorie', label: 'Catégorie', type: 'select', options: Object.entries(CATEGORIES).filter(([, c]) => !!c.segment === !!seg).map(([k, c]) => ({ value: k, label: c.label })), pleineLargeur: true });
      if (o.type === 'texte') { champs.push({ nom: 'texte', label: 'Texte', pleineLargeur: true }); champs.push({ nom: 'taille', label: `Taille des lettres (m)`, type: 'nombre', min: 0.1, max: 50, step: 0.1 }); }
      if (seg) {
        champs.push({ nom: 'x', label: `Départ x (${u})`, type: 'nombre' }, { nom: 'y', label: `Départ y (${u})`, type: 'nombre' }, { nom: 'x2', label: `Arrivée x (${u})`, type: 'nombre' }, { nom: 'y2', label: `Arrivée y (${u})`, type: 'nombre' });
        champs.push({ nom: 'epaisseur', label: o.type === 'allee' ? `Largeur (${u})` : (o.type === 'mur' ? `Épaisseur (${u})` : `Diamètre (${u})`), type: 'nombre', min: 0 });
        if (o.type === 'mur') champs.push({ nom: 'hauteur', label: `Hauteur (${u})`, type: 'nombre', min: 0 });
        if (o.type === 'installation') champs.push({ nom: 'z', label: `Altitude du réseau (${u})`, type: 'nombre' });
        champs.push({ nom: 'longueur', label: 'Longueur', type: 'lecture' });
      } else {
        champs.push({ nom: 'x', label: `Position x (${u})`, type: 'nombre' }, { nom: 'y', label: `Position y (${u})`, type: 'nombre' });
        if (!poly) {
          champs.push({ nom: 'largeur', label: `Largeur (${u})`, type: 'nombre', min: 0 }, { nom: 'profondeur', label: `Profondeur (${u})`, type: 'nombre', min: 0 });
          if (o.type !== 'zone') champs.push({ nom: 'rotation', label: 'Rotation (°)', type: 'nombre', step: 1 });
        } else champs.push({ nom: 'sommets', label: 'Forme', type: 'lecture' }, { nom: 'surface', label: 'Surface', type: 'lecture' });
        if (o.type !== 'texte') champs.push({ nom: 'hauteur', label: o.type === 'zone' ? `Hauteur du volume (${u})` : `Hauteur (${u})`, type: 'nombre', min: 0, aide: o.type === 'zone' ? 'Laissez une faible valeur pour un marquage au sol' : undefined });
        if (o.type === 'machine' || o.type === 'installation' || o.type === 'porte') champs.push({ nom: 'z', label: `Élévation (${u})`, type: 'nombre', aide: 'Hauteur au-dessus du sol du niveau (ex. pont roulant)' });
        if (o.type === 'machine' || o.type === 'installation') champs.push({ nom: 'forme', label: 'Forme', type: 'select', options: [{ value: 'boite', label: 'Parallélépipède' }, { value: 'cylindre', label: 'Cylindre' }] });
      }
      if (o.type !== 'texte') champs.push({ nom: 'couleur', label: 'Couleur', type: 'couleur' });
      champs.push({ nom: 'niveauId', label: 'Niveau', type: 'select', options: this.niveaux.map((n) => ({ value: n.id, label: n.nom })) });
      champs.push({ nom: 'verrouille', label: 'Verrouillé (protégé contre le déplacement)', type: 'booleen', pleineLargeur: true, sansDecalage: true });
      const valeurs = {
        nom: o.nom || '', categorie: o.categorie, texte: o.texte || '', taille: o.taille || 1,
        x: versU(o.x), y: versU(o.y), x2: versU(o.x2), y2: versU(o.y2), epaisseur: versU(o.epaisseur), largeur: versU(o.largeur), profondeur: versU(o.profondeur), hauteur: versU(o.hauteur), z: versU(o.z || 0),
        rotation: Math.round((o.rotation || 0) * 10) / 10, forme: o.forme || 'boite', couleur: o.couleur || '#6b7280', niveauId: o.niveauId, verrouille: !!o.verrouille,
        longueur: seg ? fmtL(Math.hypot(o.x2 - o.x, o.y2 - o.y)) : '', sommets: poly ? `Polygone de ${o.points.length} sommets` : '', surface: poly ? `${ui.formatNombre(aire(o.points), 1)} m²` : '',
      };
      const NUM = new Set(['x', 'y', 'x2', 'y2', 'epaisseur', 'largeur', 'profondeur', 'hauteur', 'z']);
      champs.forEach((c) => {
        if (c.type === 'lecture') return;
        c.onChange = (v) => {
          const actuel = this.objet(o.id);
          if (!actuel) return;
          let patch = {};
          if (NUM.has(c.nom)) {
            const n = depuisU(v);
            if (n == null || isNaN(n)) { toast('Valeur numérique invalide', 'erreur'); this.rendrePanneau(); return; }
            if (['epaisseur', 'largeur', 'profondeur'].includes(c.nom) && n <= 0) { toast('La dimension doit être positive', 'erreur'); this.rendrePanneau(); return; }
            if ((c.nom === 'x' || c.nom === 'y') && poly) { const r = this.translater(actuel, c.nom === 'x' ? r3(n - actuel.x) : 0, c.nom === 'y' ? r3(n - actuel.y) : 0); patch = { x: r.x, y: r.y, points: r.points }; } else patch[c.nom] = r3(n);
            if (seg && ['x', 'y', 'x2', 'y2'].includes(c.nom)) { const t = Object.assign({}, actuel, patch); if (Math.hypot(t.x2 - t.x, t.y2 - t.y) < 0.01) { toast('Le segment doit avoir une longueur non nulle', 'erreur'); this.rendrePanneau(); return; } patch.largeur = r3(Math.hypot(t.x2 - t.x, t.y2 - t.y)); }
            if (c.nom === 'epaisseur') patch.profondeur = r3(n);
            if (c.nom === 'epaisseur' && o.type === 'installation') patch.hauteur = r3(n);
          } else if (c.nom === 'rotation') patch.rotation = r3((((Number(v) || 0) % 360) + 360) % 360);
          else if (c.nom === 'taille') patch.taille = Math.max(0.1, Math.min(50, Number(v) || 1));
          else if (c.nom === 'texte') { if (!String(v).trim()) { toast('Le texte ne peut pas être vide', 'erreur'); this.rendrePanneau(); return; } patch.texte = String(v).slice(0, 200); }
          else if (c.nom === 'categorie') { const cat = CATEGORIES[v]; patch.categorie = v; if (cat && !actuel.equipementId && (actuel.nom === (CATEGORIES[actuel.categorie] || {}).label || !actuel.nom)) patch.nom = cat.label; if (cat && cat.couleur && actuel.couleur === (CATEGORIES[actuel.categorie] || {}).couleur) patch.couleur = cat.couleur; }
          else if (c.nom === 'niveauId') { patch.niveauId = v; }
          else patch[c.nom] = c.type === 'booleen' ? !!v : v;
          this.modifierObjet(o.id, patch, 'Modification : ' + (c.label || c.nom).replace(/ \(.*\)$/, '').toLowerCase());
          if (c.nom === 'niveauId' && v !== this.niveau) { this.niveau = v; this.majSelectNiveau(); this.appliquerFond(); this.synchroniser(); }
        };
      });
      const f = ui.form({ champs, valeurs, colonnes: 2 });
      p.appendChild(f.el);
      // Liens
      if (o.type === 'machine' || o.type === 'installation') p.appendChild(this.section('Équipement lié', this.blocLienEquipement(o)));
      if (o.type === 'zone' || o.type === 'batiment') p.appendChild(this.section('Secteur lié', this.blocLienSecteur(o)));
      p.appendChild(el('div', { class: 'p3d-actions' },
        ui.bouton('Centrer', { icone: 'recherche', classe: 'btn-sm', onClic: () => this.moteur.allerVers(o.id, { clignoter: true }) }),
        ui.bouton('Pivoter', { icone: 'rafraichir', classe: 'btn-sm', titre: 'Pivoter de 15° (R)', onClic: () => this.pivoter([o.id], 15) }),
        ui.bouton('Dupliquer', { icone: 'copier', classe: 'btn-sm', onClic: () => this.dupliquerSelection() }),
        ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: () => this.supprimerSelection() })));
    }
    async chargerEquipementsSite() {
      if (this.equipementsSite) return this.equipementsSite;
      try {
        const rows = await api.get('/api/equipements', { actif: '1' });
        const siteId = siteDe(this.proprietes.secteurId);
        this.equipementsSite = rows.filter((e) => siteId == null || e.secteurId == null || siteDe(e.secteurId) === siteId);
      } catch (e) { this.equipementsSite = []; }
      return this.equipementsSite;
    }
    blocLienEquipement(o) {
      const bloc = el('div', { class: 'p3d-lien-eq' });
      const info = o.equipementId != null ? this.infos.get(Number(o.equipementId)) : null;
      if (o.equipementMasque) bloc.appendChild(el('div', { class: 'texte-2 texte-petit' }, 'Lié à un équipement hors de votre périmètre (lien conservé).'));
      else if (o.equipementId != null) {
        bloc.appendChild(el('div', { class: 'inline', style: { justifyContent: 'space-between' } },
          el('div', { style: { minWidth: 0 } }, el('div', { class: 'texte-gras' }, info ? info.nom : `Équipement n°${o.equipementId}`), el('div', { class: 'texte-2 texte-petit' }, info ? `${info.numero} · ${ui.libelle('etatsEquipement', info.etatCode)}` : '')),
          ui.bouton('Délier', { classe: 'btn-sm', onClic: () => this.modifierObjet(o.id, { equipementId: null }, 'Lien équipement retiré') })));
      } else bloc.appendChild(el('div', { class: 'texte-2 texte-petit' }, 'Aucun équipement lié. Recherchez un équipement du site :'));
      if (o.equipementMasque) return bloc;
      const inp = el('input', { type: 'search', placeholder: 'Numéro ou désignation…' });
      const res = el('div', { class: 'p3d-resultats masque' });
      const majRes = async () => {
        const liste = await this.chargerEquipementsSite();
        const q = inp.value.trim().toLowerCase();
        const deja = new Set(this.objets.filter((x) => x.equipementId != null && x.id !== o.id).map((x) => Number(x.equipementId)));
        const rows = liste.filter((e) => !deja.has(e.id) && (!q || [e.numero, e.nom, e.secteurNom].some((v) => String(v || '').toLowerCase().includes(q)))).slice(0, 30);
        ui.vider(res);
        if (!rows.length) res.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '8px' } }, liste.length ? 'Aucun équipement disponible' : 'Aucun équipement visible sur ce site'));
        for (const e of rows) {
          res.appendChild(el('div', { class: 'p3d-item', onmousedown: (ev) => {
            ev.preventDefault();
            res.classList.add('masque');
            this.infos.set(e.id, { id: e.id, numero: e.numero, nom: e.nom, etatCode: e.etatCode, criticiteCode: e.criticiteCode, typeCode: e.typeCode, secteurId: e.secteurId, actif: e.actif !== false, nbOtOuverts: e.nbOtOuverts || 0, prioriteMax: null, nbDemandesOuvertes: 0, alerte: e.nbOtOuverts ? 'en_cours' : 'aucun' });
            const patch = { equipementId: e.id };
            const actuel = this.objet(o.id);
            if (!actuel.nom || /^Nouvelle machine$|^Machine \d*$/.test(actuel.nom) || actuel.nom === (CATEGORIES[actuel.categorie] || {}).label) patch.nom = e.nom;
            this.modifierObjet(o.id, patch, 'Lien vers ' + e.numero);
            toast(`Lié à ${e.numero} · ${e.nom}`, 'succes', 2000);
            this.majEtat(false);
          } }, el('span', { class: 'p3d-pastille', style: { background: ui.couleur('etatsEquipement', e.etatCode) } }), el('span', { class: 'nom' }, e.nom), el('span', { class: 'num' }, e.numero)));
        }
        res.classList.remove('masque');
      };
      inp.addEventListener('focus', majRes);
      inp.addEventListener('input', ui.debounce(majRes, 120));
      inp.addEventListener('blur', () => setTimeout(() => res.classList.add('masque'), 150));
      bloc.appendChild(el('div', { class: 'p3d-recherche-eq' }, inp, res));
      if (GMAO.can('equipements', 'creer')) bloc.appendChild(ui.bouton('Créer un nouvel équipement', { icone: 'plus', classe: 'btn-sm btn-lien', onClic: () => this.creerEquipement(o) }));
      return bloc;
    }
    secteurContenant(o) {
      const zones = this.objets.filter((z) => z.type === 'zone' && z.secteurId != null && z.niveauId === o.niveauId && pointDans(o.x, o.y, z.points && z.points.length >= 3 ? z.points : rectPoints(z)));
      return zones.length ? zones[zones.length - 1].secteurId : null;
    }
    creerEquipement(o) {
      const siteId = siteDe(this.proprietes.secteurId);
      const p = GMAO.perms || {};
      const options = ui.optionsSecteurs({ vide: false, tousSites: true }).filter((s) => (siteId == null || siteDe(s.value) === siteId) && (p.portee === 'tous' || (p.secteurIds || []).includes(Number(s.value))));
      const defaut = this.secteurContenant(o) || (options.some((s) => Number(s.value) === Number(this.proprietes.secteurId)) ? this.proprietes.secteurId : (options[0] || {}).value);
      ui.formModal({
        titre: 'Créer un équipement et le lier', taille: 'petite', colonnes: 1,
        champs: [
          { nom: 'nom', label: 'Désignation', requis: true },
          { nom: 'secteurId', label: 'Secteur', type: 'select', requis: true, options: options },
          { nom: 'typeCode', label: 'Type', type: 'select', liste: 'typesEquipement', vide: undefined },
          { nom: 'criticiteCode', label: 'Criticité', type: 'select', liste: 'criticites' },
          { nom: 'marque', label: 'Marque' },
          { nom: 'modele', label: 'Modèle' },
        ],
        valeurs: { nom: o.nom && !/^Nouvelle machine$/.test(o.nom) ? o.nom : '', secteurId: defaut, typeCode: o.type === 'machine' ? 'machine' : '', criticiteCode: '' },
        submitLabel: 'Créer et lier',
        onSubmit: async (v) => {
          const e = await api.post('/api/equipements', { nom: v.nom, secteurId: v.secteurId, typeCode: v.typeCode || undefined, criticiteCode: v.criticiteCode || undefined, marque: v.marque, modele: v.modele, localisation: this.proprietes.nom });
          this.infos.set(e.id, { id: e.id, numero: e.numero, nom: e.nom, etatCode: e.etatCode, criticiteCode: e.criticiteCode, typeCode: e.typeCode, secteurId: e.secteurId, actif: true, nbOtOuverts: 0, prioriteMax: null, nbDemandesOuvertes: 0, alerte: 'aucun' });
          if (this.equipementsSite) this.equipementsSite.push(e);
          this.modifierObjet(o.id, { equipementId: e.id, nom: e.nom }, 'Création et lien de ' + e.numero);
          toast(`Équipement ${e.numero} créé et lié (pensez à enregistrer le plan)`, 'succes');
        },
      });
    }
    blocLienSecteur(o) {
      const bloc = el('div', { class: 'p3d-lien-eq' });
      const siteId = siteDe(this.proprietes.secteurId);
      const p = GMAO.perms || {};
      const options = ui.optionsSecteurs({ vide: false, tousSites: true }).filter((s) => (siteId == null || siteDe(s.value) === siteId) && (p.portee === 'tous' || (p.secteurIds || []).includes(Number(s.value)) || Number(s.value) === Number(o.secteurId)));
      const sel = el('select', null, el('option', { value: '' }, '— Aucun secteur —'), options.map((s) => el('option', { value: String(s.value) }, s.label)));
      sel.value = o.secteurId == null ? '' : String(o.secteurId);
      sel.addEventListener('change', () => {
        const sid = sel.value === '' ? null : Number(sel.value);
        const patch = { secteurId: sid };
        const s = sid != null ? ui.secteur(sid) : null;
        if (s && o.type === 'zone' && (!o.nom || /^Zone \d+$/.test(o.nom))) patch.nom = s.nom;
        if (s && s.couleur && o.type === 'zone') patch.couleur = s.couleur;
        this.modifierObjet(o.id, patch, sid ? 'Lien vers le secteur ' + (s ? s.nom : sid) : 'Lien secteur retiré');
      });
      bloc.appendChild(sel);
      bloc.appendChild(el('div', { class: 'texte-2 texte-petit' }, o.type === 'zone' ? 'La zone matérialise ce secteur sur le plan (couleur, légende, contenu).' : 'Bâtiment correspondant à un secteur de type « bâtiment ».'));
      bloc.appendChild(ui.bouton('Créer un secteur', { icone: 'plus', classe: 'btn-sm btn-lien', onClic: () => this.creerSecteur(o) }));
      return bloc;
    }
    creerSecteur(o) {
      const siteId = siteDe(this.proprietes.secteurId);
      const p = GMAO.perms || {};
      const parents = ui.optionsSecteurs({ vide: false, tousSites: true }).filter((s) => (siteId == null || siteDe(s.value) === siteId) && (p.portee === 'tous' || (p.secteurIds || []).includes(Number(s.value))));
      if (!parents.length) { toast('Aucun secteur parent accessible en écriture sur ce site.', 'alerte'); return; }
      ui.formModal({
        titre: 'Créer un secteur', taille: 'petite', colonnes: 1,
        champs: [
          { nom: 'nom', label: 'Nom du secteur', requis: true },
          { nom: 'code', label: 'Code (facultatif)', placeholder: 'ex. PROD-L3' },
          { nom: 'type', label: 'Type', type: 'select', liste: 'typesSecteur' },
          { nom: 'parentId', label: 'Secteur parent', type: 'select', requis: true, options: parents },
          { nom: 'couleur', label: 'Couleur', type: 'couleur' },
        ],
        valeurs: { nom: o.nom && !/^Zone \d+$|^Bâtiment \d+$/.test(o.nom) ? o.nom : '', type: o.type === 'batiment' ? 'batiment' : 'zone', parentId: parents.some((s) => Number(s.value) === Number(this.proprietes.secteurId)) ? this.proprietes.secteurId : parents[0].value, couleur: o.couleur || '#3b82f6' },
        submitLabel: 'Créer et lier',
        onSubmit: async (v) => {
          const s = await api.post('/api/secteurs', { nom: v.nom, code: v.code || '', type: v.type || 'zone', parentId: v.parentId, couleur: v.couleur });
          await GMAO.refreshRefs();
          this.modifierObjet(o.id, { secteurId: s.id, nom: o.type === 'zone' ? s.nom : o.nom, couleur: o.type === 'zone' ? (s.couleur || o.couleur) : o.couleur }, 'Création du secteur ' + s.nom);
          toast(`Secteur « ${s.nom} » créé et lié`, 'succes');
        },
      });
    }

    // ----- Fond de plan ---------------------------------------------------------------------
    ouvrirFond() {
      if (!this.edition) return;
      const f = this.fond ? copie(this.fond) : null;
      let image = null; // { dataUrl, largeur, hauteur, nom, taille }
      const apercu = el('div', { class: 'texte-2 texte-petit' });
      const majApercu = () => {
        ui.vider(apercu);
        const src = image ? image.dataUrl : (f && (f.imageDataUrl || f.imageUrl));
        if (src) apercu.appendChild(el('img', { src, alt: 'Fond de plan', style: { maxWidth: '100%', maxHeight: '160px', border: '1px solid var(--bordure)', borderRadius: '6px', background: '#fff' } }));
        else apercu.appendChild(el('span', null, 'Aucun fond de plan. Importez un plan 2D (PNG ou JPEG, 8 Mo maximum) pour le décalquer.'));
      };
      const m = ui.formModal({
        titre: 'Fond de plan à décalquer', taille: 'large',
        champs: [
          { nom: 'apercu', type: 'html', rendu: () => apercu },
          { nom: 'fichier', label: 'Image (PNG ou JPEG)', type: 'fichier', accept: 'image/png,image/jpeg', tailleMax: 8 * 1024 * 1024, pleineLargeur: true, onChange: (v, form) => {
            if (!v || !v.contenu) return;
            if (!/^data:image\/(png|jpeg)/.test(v.contenu)) { toast('Seules les images PNG ou JPEG sont acceptées', 'erreur'); return; }
            const img = new Image();
            img.onload = () => {
              image = { dataUrl: v.contenu, largeur: img.naturalWidth, hauteur: img.naturalHeight, nom: v.nom };
              const ech = r3(this.dimensions.largeur / img.naturalWidth * 100000) / 100000;
              form.set('echelle', ech); form.set('x', versU(this.dimensions.largeur / 2)); form.set('y', versU(this.dimensions.profondeur / 2));
              majApercu();
            };
            img.src = v.contenu;
          } },
          { nom: 'echelle', label: 'Échelle (mètres par pixel)', type: 'nombre', min: 0.00001, max: 1000, step: 'any', aide: 'Utilisez « Calibrer » pour la déterminer à partir de deux points de distance connue' },
          { nom: 'opacite', label: 'Opacité (0 à 100 %)', type: 'nombre', min: 0, max: 100, step: 5 },
          { nom: 'x', label: `Centre x (${unite().l})`, type: 'nombre' },
          { nom: 'y', label: `Centre y (${unite().l})`, type: 'nombre' },
          { nom: 'rotation', label: 'Rotation (°)', type: 'nombre' },
          { nom: 'niveauId', label: 'Niveau', type: 'select', options: this.niveaux.map((n) => ({ value: n.id, label: n.nom })) },
        ],
        valeurs: f ? { echelle: f.echelle, opacite: Math.round((f.opacite == null ? 0.6 : f.opacite) * 100), x: versU(f.x), y: versU(f.y), rotation: f.rotation || 0, niveauId: f.niveauId || this.niveaux[0].id } : { echelle: '', opacite: 60, x: versU(this.dimensions.largeur / 2), y: versU(this.dimensions.profondeur / 2), rotation: 0, niveauId: this.niveauActifId() },
        boutonsSupp: [
          f ? { label: 'Retirer le fond', classe: 'btn-danger a-gauche', onClic: async () => { this.appliquer([], 'Fond de plan retiré', { avant: { fond: this.fond }, apres: { fond: null } }); toast('Fond de plan retiré (à enregistrer)', 'info'); } } : null,
          { label: 'Calibrer par 2 points', onClic: async (form) => {
            const v = form.valeurs();
            const nouveau = this.valeursFond(v, image, f);
            if (!nouveau) { toast('Choisissez d\'abord une image et une échelle approximative', 'alerte'); return false; }
            this.appliquer([], 'Fond de plan', { avant: { fond: this.fond }, apres: { fond: nouveau } });
            this.demarrerCalibrage();
          } },
        ].filter(Boolean),
        submitLabel: 'Appliquer',
        onSubmit: async (v) => {
          const nouveau = this.valeursFond(v, image, f);
          if (!nouveau) { toast('Choisissez une image et indiquez l\'échelle', 'erreur'); return false; }
          this.appliquer([], 'Fond de plan', { avant: { fond: this.fond }, apres: { fond: nouveau } });
          toast('Fond de plan appliqué (à enregistrer)', 'succes');
        },
      });
      majApercu();
      return m;
    }
    valeursFond(v, image, f) {
      const echelle = Number(v.echelle);
      if (!(echelle > 0) || (!image && !f)) return null;
      const out = Object.assign({}, f || {}, {
        echelle: r3(echelle * 100000) / 100000 || echelle, opacite: Math.max(0, Math.min(100, Number(v.opacite) || 0)) / 100,
        x: depuisU(v.x) || 0, y: depuisU(v.y) || 0, rotation: Number(v.rotation) || 0, niveauId: v.niveauId || this.niveaux[0].id,
      });
      if (image) Object.assign(out, { imageDataUrl: image.dataUrl, imageUrl: null, nomFichier: image.nom || 'fond.png' });
      return out;
    }
    demarrerCalibrage() {
      this.annulerTrace();
      this.calibrage = { points: [] };
      if (!this.moteur.camera.dessus) this.basculerDessus(true);
      this.moteur.definirCurseur('crosshair');
      toast('Cliquez deux points du fond de plan dont vous connaissez la distance réelle.', 'info', 6000);
      this.majStatut();
    }
    pointCalibrage(p) {
      const c = this.calibrage;
      if (!c || !p) return;
      c.points.push({ x: p.x, y: p.y });
      const alt = this.niveauDe(this.niveauActifId()).altitude;
      this.moteur.definirApercus(c.points.map((q) => ({ forme: 'cylindre', x: q.x, y: q.y, largeur: 0.5, profondeur: 0.5, hauteur: 0.3, y0: alt, couleur: '#dc2626', opacite: 0.9 })).concat(c.points.length === 2 ? [{ forme: 'segment', x: c.points[0].x, y: c.points[0].y, x2: c.points[1].x, y2: c.points[1].y, epaisseur: 0.12, hauteur: 0.1, y0: alt + 0.05, couleur: '#dc2626', opacite: 0.9 }] : []));
      this.majStatut();
      if (c.points.length < 2) return;
      const [a, b] = c.points;
      const mesure = Math.hypot(b.x - a.x, b.y - a.y);
      this.calibrage = null;
      this.moteur.definirCurseur(this.outil === 'selection' ? 'default' : 'crosshair');
      if (mesure < 0.01) { toast('Points trop proches', 'erreur'); this.moteur.definirApercus([]); return; }
      ui.prompt({ titre: 'Calibrage du fond de plan', message: `Distance mesurée sur le plan : ${ui.formatNombre(mesure, 2)} m.`, label: 'Distance réelle entre les deux points (m)', type: 'nombre', okLabel: 'Calibrer' }).then((reelle) => {
        this.moteur.definirApercus([]);
        const d = Number(reelle);
        if (!(d > 0) || !this.fond) return;
        const k = d / mesure;
        const f = copie(this.fond);
        f.echelle = f.echelle * k;
        // le premier point reste fixe
        f.x = r3(a.x + (f.x - a.x) * k); f.y = r3(a.y + (f.y - a.y) * k);
        this.appliquer([], 'Calibrage du fond de plan', { avant: { fond: this.fond }, apres: { fond: f } });
        toast(`Échelle calibrée : ${ui.formatNombre(f.echelle, 5)} m/pixel`, 'succes');
      });
    }

    // ----- Niveaux & propriétés ----------------------------------------------------------------
    ouvrirNiveaux() {
      if (!this.edition) return;
      let lignes = copie(this.niveaux);
      const cont = el('div');
      const rendre = () => {
        ui.vider(cont);
        cont.appendChild(el('div', { class: 'p3d-niveaux-ligne texte-2 texte-petit texte-gras' }, el('span', null, 'Nom'), el('span', null, 'Altitude (m)'), el('span', null, 'Hauteur (m)'), el('span')));
        lignes.forEach((n, i) => {
          const nb = this.objets.filter((o) => o.niveauId === n.id).length;
          const nom = el('input', { type: 'text', value: n.nom, maxlength: 60, oninput: (e) => { n.nom = e.target.value; } });
          const alt = el('input', { type: 'number', value: n.altitude, step: '0.1', oninput: (e) => { n.altitude = Number(e.target.value); } });
          const h = el('input', { type: 'number', value: n.hauteur, step: '0.1', min: 0.5, oninput: (e) => { n.hauteur = Number(e.target.value); } });
          const sup = el('button', { class: 'btn btn-icone btn-sm', type: 'button', title: nb ? `Supprimer (${nb} objet(s) sur ce niveau)` : 'Supprimer', disabled: lignes.length <= 1, onclick: async () => {
            if (nb && !(await ui.confirm({ titre: 'Supprimer le niveau', message: `Le niveau « ${n.nom} » contient ${nb} objet(s), qui seront supprimés à l'application. Continuer ?`, okLabel: 'Supprimer', danger: true }))) return;
            lignes.splice(i, 1); rendre();
          } }, icone('supprimer'));
          cont.appendChild(el('div', { class: 'p3d-niveaux-ligne' }, nom, alt, h, sup));
        });
        cont.appendChild(ui.bouton('Ajouter un niveau', { icone: 'plus', classe: 'btn-sm', onClic: () => {
          const dernier = lignes.reduce((a, b) => (b.altitude > a.altitude ? b : a), lignes[0]);
          const ids = new Set(lignes.map((x) => x.id));
          let k = lignes.length; while (ids.has('r' + k)) k++;
          lignes.push({ id: 'r' + k, nom: `R+${k}`, altitude: r3((dernier.altitude || 0) + (dernier.hauteur || 4)), hauteur: dernier.hauteur || 4 });
          rendre();
        } }));
      };
      rendre();
      ui.modal({
        titre: 'Niveaux du plan', taille: 'large', contenu: frag(ui.alerte('Chaque niveau a une altitude (plancher) et une hauteur sous plafond. Les objets sont placés sur le niveau actif choisi dans la barre d\'outils.', 'info'), cont),
        boutons: [{ label: 'Annuler' }, { label: 'Appliquer', classe: 'btn-primaire', onClic: () => {
          for (const n of lignes) {
            if (!String(n.nom || '').trim()) { toast('Chaque niveau doit avoir un nom', 'erreur'); return false; }
            if (!Number.isFinite(n.altitude) || !(n.hauteur >= 0.5)) { toast(`Niveau « ${n.nom} » : altitude ou hauteur invalide`, 'erreur'); return false; }
            n.nom = String(n.nom).trim().slice(0, 60);
          }
          lignes = lignes.slice().sort((a, b) => a.altitude - b.altitude);
          const ids = new Set(lignes.map((n) => n.id));
          const supprimes = this.objets.filter((o) => !ids.has(o.niveauId));
          const fond = this.fond && !ids.has(this.fond.niveauId) ? Object.assign(copie(this.fond), { niveauId: lignes[0].id }) : this.fond;
          this.appliquer(supprimes.map((o) => ({ id: o.id, avant: o, apres: null })), 'Niveaux modifiés', { avant: { niveaux: this.niveaux, fond: this.fond }, apres: { niveaux: lignes, fond } });
          toast('Niveaux mis à jour (à enregistrer)', 'succes');
        } }],
      });
    }
    ouvrirProprietes() {
      const local = (body) => {
        const avant = { proprietes: this.proprietes, dimensions: this.dimensions };
        const apres = { proprietes: { nom: body.nom, description: body.description, secteurId: body.secteurId === '' || body.secteurId == null ? null : Number(body.secteurId) }, dimensions: body.dimensions };
        if (siteDe(apres.proprietes.secteurId) !== siteDe(this.proprietes.secteurId)) this.equipementsSite = null;
        this.appliquer([], 'Propriétés du plan', { avant, apres });
        toast('Propriétés modifiées (à enregistrer)', 'info');
      };
      local.local = local;
      ouvrirProprietesPlan(Object.assign({}, this.plan, { nom: this.proprietes.nom, description: this.proprietes.description, secteurId: this.proprietes.secteurId, dimensions: this.dimensions, version: this.version }), local);
    }

    // ----- Enregistrement ---------------------------------------------------------------------
    corpsEnregistrement(version) {
      const objets = this.objets.map((o) => { const { equipement, secteur, ...r } = o; return r; });
      const body = { version, nom: this.proprietes.nom, description: this.proprietes.description, secteurId: this.proprietes.secteurId, dimensions: this.dimensions, niveaux: this.niveaux, objets };
      if (this.fondModifie) {
        if (!this.fond) body.fond = null;
        else {
          const { imageUrl, imageDataUrl, image, type, taille, ...params } = this.fond;
          body.fond = Object.assign(params, imageDataUrl ? { image: imageDataUrl } : {});
        }
      }
      if (this.vueModifiee) body.vue = this.vue;
      return body;
    }
    async enregistrer(versionForcee) {
      if (!this.edition || this.enregistrement) return false;
      this.enregistrement = true;
      if (this.btnEnregistrer) this.btnEnregistrer.disabled = true;
      try {
        const r = await api.put('/api/plans/' + this.plan.id, this.corpsEnregistrement(versionForcee || this.version));
        const selection = this.selection.slice();
        this.chargerPlan(r);
        this.selection = selection.filter((id) => this.objet(id));
        this.vueModifiee = false;
        this.marquerModifie(false);
        this.majTitre(); this.majSelectNiveau(); this.appliquerFond(); this.synchroniser(); this.rendrePanneau(); this.majStatut();
        toast(`Plan enregistré (version ${r.version})`, 'succes');
        return true;
      } catch (e) {
        if (e.status === 409) { this.conflit(e); return false; }
        erreur(e);
        return false;
      } finally {
        this.enregistrement = false;
        if (this.btnEnregistrer) this.btnEnregistrer.disabled = false;
      }
    }
    conflit(e) {
      const d = e.details || {};
      ui.modal({
        titre: 'Le plan a été modifié par quelqu\'un d\'autre', taille: 'petite',
        contenu: frag(el('p', null, `${d.updatedByNom ? d.updatedByNom + ' a' : 'Quelqu\'un a'} enregistré une nouvelle version de ce plan (version ${d.version || '?'}${d.updatedAt ? ', ' + ui.relatif(d.updatedAt) : ''}) pendant que vous l'éditiez.`), el('p', { class: 'texte-2' }, 'Vous pouvez recharger le plan (vos modifications seront perdues) ou écraser la nouvelle version avec la vôtre.')),
        boutons: [
          { label: 'Annuler' },
          { label: 'Recharger le plan', onClic: () => { this.marquerModifie(false); this.recharger(); } },
          { label: 'Écraser avec ma version', classe: 'btn-danger', onClic: async () => { const actuel = await api.get('/api/plans/' + this.plan.id); await this.enregistrer(actuel.version); } },
        ],
      });
    }
    recharger() { this.nettoyer(); GMAO.rendre(); }
    exporterObjetsCsv() {
      const lignes = this.objets.map((o) => Object.assign({}, o, { _info: this.infos.get(Number(o.equipementId)) }));
      ui.exportCsv(`plan-${this.plan.numero}-objets.csv`, [
        { label: 'Identifiant', cle: 'id' }, { label: 'Type', exportValeur: (o) => (TYPES[o.type] || {}).label || o.type }, { label: 'Catégorie', exportValeur: (o) => (o.categorie ? (CATEGORIES[o.categorie] || {}).label : '') },
        { label: 'Nom', exportValeur: (o) => o.nom || o.texte || '' }, { label: 'Niveau', exportValeur: (o) => this.niveauDe(o.niveauId).nom },
        { label: 'X (m)', exportValeur: (o) => ui.formatNombre(o.x, 2) }, { label: 'Y (m)', exportValeur: (o) => ui.formatNombre(o.y, 2) },
        { label: 'X2 (m)', exportValeur: (o) => (o.x2 != null ? ui.formatNombre(o.x2, 2) : '') }, { label: 'Y2 (m)', exportValeur: (o) => (o.y2 != null ? ui.formatNombre(o.y2, 2) : '') },
        { label: 'Largeur (m)', exportValeur: (o) => ui.formatNombre(o.largeur, 2) }, { label: 'Profondeur (m)', exportValeur: (o) => ui.formatNombre(o.profondeur, 2) }, { label: 'Hauteur (m)', exportValeur: (o) => ui.formatNombre(o.hauteur, 2) },
        { label: 'Rotation (°)', exportValeur: (o) => ui.formatNombre(o.rotation || 0, 1) },
        { label: 'Équipement (n°)', exportValeur: (o) => (o._info ? o._info.numero : '') }, { label: 'Équipement', exportValeur: (o) => (o._info ? o._info.nom : '') },
        { label: 'État', exportValeur: (o) => (o._info ? ui.libelle('etatsEquipement', o._info.etatCode) : '') }, { label: 'OT ouverts', exportValeur: (o) => (o._info ? o._info.nbOtOuverts : '') },
        { label: 'Secteur lié', exportValeur: (o) => (o.secteurId != null ? ui.cheminSecteur(o.secteurId) : '') },
      ], lignes);
    }
    capturer() {
      try {
        const c = this.moteur.capture({ titre: this.proprietes.nom, sousTitre: `${this.plan.numero} · ${ui.cheminSecteur(this.proprietes.secteurId) || ''} · ${ui.formatDateHeure(new Date())}` });
        // légende du mode de couleur (coin inférieur gauche)
        const { titre, items } = this.itemsLegende();
        if (items.length) {
          const g = c.getContext('2d');
          const k = c.width / Math.max(1, this.moteur.cssW || c.width);
          g.save(); g.scale(k, k);
          const h = 26 + items.length * 18, w = 190, x = 10, y = (c.height / k) - h - 10;
          g.fillStyle = 'rgba(255,255,255,0.94)'; g.strokeStyle = 'rgba(0,0,0,0.18)';
          g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, 8); else g.rect(x, y, w, h); g.fill(); g.stroke();
          g.fillStyle = '#4b5563'; g.font = '700 10.5px "Segoe UI", Arial, sans-serif'; g.textBaseline = 'middle';
          g.fillText(titre.toUpperCase(), x + 10, y + 13);
          items.forEach(([coul, t], i) => {
            const yy = y + 30 + i * 18;
            g.fillStyle = coul; g.beginPath(); g.arc(x + 15, yy, 5, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#111827'; g.font = '12px "Segoe UI", Arial, sans-serif'; g.fillText(t, x + 27, yy);
          });
          g.restore();
        }
        telechargerCanvas(c, `plan-${this.plan.numero}-${ui.dateISO(new Date())}.png`);
        toast('Capture enregistrée', 'succes', 1800);
      } catch (e) { erreur(e); }
    }
    aideClavier() {
      const l = [
        ['Navigation', 'Glisser : pivoter · clic droit / Maj + glisser : déplacer · molette : zoom · flèches : pivoter (Maj : déplacer) · + / − : zoom · Origine : recentrer'],
        ['Sélection', 'Clic : sélectionner · Maj + clic : ajouter / retirer · Ctrl+A : tout sélectionner (niveau actif) · Échap : désélectionner'],
        ['Édition', 'Glisser : déplacer (Alt : sans magnétisme) · flèches : décaler (Maj : ×10) · R / Maj+R : pivoter de ±15° · Suppr : supprimer · Ctrl+D : dupliquer · Ctrl+C / Ctrl+V : copier / coller · Ctrl+Z / Ctrl+Y : annuler / rétablir · Ctrl+S : enregistrer'],
        ['Outils', OUTILS.map((t) => `${t.touche} : ${t.label}`).join(' · ')],
      ];
      ui.modal({ titre: 'Raccourcis clavier', taille: 'large', contenu: ui.details(l.map(([label, valeur]) => ({ label, valeur }))), boutons: [{ label: 'Fermer' }] });
    }

    // ----- État vivant (toutes les 60 s) --------------------------------------------------------
    async majEtat(manuel) {
      try {
        const e = await api.get(`/api/plans/${this.plan.id}/etat`);
        for (const [id, info] of Object.entries(e.equipements || {})) this.infos.set(Number(id), info);
        if (e.version !== this.version) {
          if (!this.modifie) {
            toast(`Le plan a été mis à jour par ${e.updatedByNom || 'un autre utilisateur'} : rechargement.`, 'info');
            const p = await api.get('/api/plans/' + this.plan.id);
            const sel = this.selection.slice();
            this.chargerPlan(p);
            this.selection = sel.filter((id) => this.objet(id));
            this.majTitre(); this.majSelectNiveau(); this.appliquerFond();
          } else if (!this._avertiVersion) {
            this._avertiVersion = true;
            toast(`Attention : ${e.updatedByNom || 'un autre utilisateur'} a enregistré une version plus récente de ce plan.`, 'alerte', 8000);
          }
        }
        // pas de reconstruction pendant un glisser / tracé, ni de panneau rafraîchi pendant une saisie
        if (!this.drag && !this.trace) this.synchroniser();
        if (!this.panneau.contains(document.activeElement)) this.rendrePanneau();
        if (manuel === true) toast('État des équipements actualisé', 'succes', 1500);
      } catch (err) { if (manuel === true) erreur(err); }
    }

    // ----- Écouteurs globaux et nettoyage -------------------------------------------------------
    installerEcouteurs() {
      const clavier = (ev) => this.surClavier(ev);
      document.addEventListener('keydown', clavier);
      this.nettoyages.push(() => document.removeEventListener('keydown', clavier));
      // protection des modifications non enregistrées : liens internes et fermeture de la page
      const clicLien = (ev) => {
        if (!this.modifie || !this.edition) return;
        const a = ev.target.closest && ev.target.closest('a[href^="#"]');
        if (!a || this.racine.contains(a) && a.getAttribute('href').startsWith('#/plans/' + this.plan.id)) return;
        ev.preventDefault(); ev.stopPropagation();
        ui.confirm({ titre: 'Modifications non enregistrées', message: 'Quitter le plan sans enregistrer ? Vos modifications seront conservées en brouillon jusqu\'à la fermeture de l\'application.', okLabel: 'Quitter sans enregistrer', danger: true }).then((ok) => { if (ok) GMAO.navigate(a.getAttribute('href')); });
      };
      document.addEventListener('click', clicLien, true);
      this.nettoyages.push(() => document.removeEventListener('click', clicLien, true));
      const avantFermeture = (ev) => { if (this.modifie) { ev.preventDefault(); ev.returnValue = ''; } };
      window.addEventListener('beforeunload', avantFermeture);
      this.nettoyages.push(() => window.removeEventListener('beforeunload', avantFermeture));
      const plein = () => { if (!document.fullscreenElement && this.racine.classList.contains('p3d-plein-ecran')) { this.racine.classList.remove('p3d-plein-ecran'); this.majBoutonPlein(); } setTimeout(() => this.moteur.redimensionner(), 60); };
      document.addEventListener('fullscreenchange', plein);
      this.nettoyages.push(() => document.removeEventListener('fullscreenchange', plein));
      // thème clair / sombre
      const obsTheme = new MutationObserver(() => { this.moteur.definirTheme(this.couleursTheme()); this.synchroniser(); });
      obsTheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.nettoyages.push(() => obsTheme.disconnect());
      // état vivant
      const t = setInterval(() => { if (!this.container.isConnected) { this.nettoyer(); return; } this.majEtat(false); }, 60000);
      this.nettoyages.push(() => clearInterval(t));
      // détachement de la vue (navigation)
      const parent = this.container.parentNode;
      if (parent) {
        const obs = new MutationObserver(() => { if (!this.container.isConnected) this.nettoyer(); });
        obs.observe(parent, { childList: true });
        this.nettoyages.push(() => obs.disconnect());
      }
    }
    surClavier(ev) {
      if (!this.container.isConnected) { this.nettoyer(); return; }
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal-fond')) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      const k = ev.key;
      let traite = true;
      if (k === 'Escape') {
        if (this.trace || this.calibrage) this.terminerTrace(false);
        else if (this.selection.length) this.selectionner([]);
        else if (this.edition && this.outil !== 'selection') this.choisirOutil('selection');
        else if (this.racine.classList.contains('p3d-plein-ecran')) this.basculerPleinEcran();
        else traite = false;
      } else if (k === 'f' || k === 'F') { if (this.selection.length) this.moteur.cadrer(this.selection); else this.moteur.recentrer(true); }
      else if (!this.edition) traite = false;
      else if (ctrl && (k === 'z' || k === 'Z') && !ev.shiftKey) this.annuler();
      else if (ctrl && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && ev.shiftKey))) this.retablir();
      else if (ctrl && (k === 'd' || k === 'D')) this.dupliquerSelection();
      else if (ctrl && (k === 'c' || k === 'C')) this.copier();
      else if (ctrl && (k === 'v' || k === 'V')) this.coller();
      else if (ctrl && (k === 's' || k === 'S')) this.enregistrer();
      else if (ctrl && (k === 'a' || k === 'A')) this.selectionner(this.objets.filter((o) => o.niveauId === this.niveauActifId()).map((o) => o.id));
      else if (k === 'Delete' || k === 'Backspace') this.supprimerSelection();
      else if (k === 'Enter' && this.trace) this.terminerTrace(true);
      else if ((k === 'r' || k === 'R') && !ctrl && this.selection.length) this.pivoter(this.selection, ev.shiftKey ? -15 : 15);
      else if (k.startsWith('Arrow') && this.selection.length) {
        const pas = (Number(cfg().grilleM) || 0.5) * (ev.shiftKey ? 10 : 1);
        const dx = k === 'ArrowLeft' ? -pas : k === 'ArrowRight' ? pas : 0, dy = k === 'ArrowUp' ? -pas : k === 'ArrowDown' ? pas : 0;
        this.deplacer(this.selection, dx, dy, 'Décalage');
      } else if (!ctrl && !ev.altKey && k.length === 1) {
        const outil = OUTILS.find((o) => o.touche === k.toUpperCase());
        if (outil) this.choisirOutil(outil.cle); else traite = false;
      } else traite = false;
      if (traite) { ev.preventDefault(); ev.stopPropagation(); }
    }
    nettoyer() {
      if (this.nettoye) return;
      this.nettoye = true;
      if (this.modifie && this.edition) brouillons.set(this.plan.id, { version: this.version, objets: this.objets, niveaux: this.niveaux, fond: this.fond, fondModifie: this.fondModifie, dimensions: this.dimensions, proprietes: this.proprietes, historique: this.historique, indexHisto: this.indexHisto, nb: this.indexHisto || 1 });
      for (const f of this.nettoyages) { try { f(); } catch (e) { /* ignore */ } }
      this.nettoyages = [];
      if (this.racine.classList.contains('p3d-plein-ecran') && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (this.moteur) this.moteur.detruire();
      if (GMAO._plan3d === this) GMAO._plan3d = null;
    }
  }

  // =====================================================================================
  // Enregistrement de la vue
  // =====================================================================================
  GMAO.registerView(MODULE, {
    titre: 'Plans 3D',
    icone: 'plan3d',
    async rendu(container, { params, query }) {
      if (GMAO._plan3d) GMAO._plan3d.nettoyer();
      if (!params[0]) return rendreListe(container, query || {});
      if (typeof window.Moteur3D === 'undefined') { container.appendChild(ui.alerte('La bibliothèque de rendu 3D (moteur3d.js) n\'est pas chargée.', 'danger')); return; }
      let plan;
      try { plan = await api.get('/api/plans/' + encodeURIComponent(params[0])); } catch (e) {
        container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'plan3d', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/plans' }, { label: 'Plan introuvable' }] }));
        container.appendChild(ui.vide(e.status === 404 ? 'Ce plan n\'existe pas ou n\'est pas accessible avec vos droits.' : e.message, 'alerte'));
        return;
      }
      if (!container.isConnected) return;
      new Fiche(container, plan, query || {});
    },
  });
})();
