/**
 * Vue Ressources humaines.
 *   #/rh            onglets : Tableau de bord RH, Personnel, Habilitations (matrice personnel × types),
 *                   Formations (plan, réalisation → renouvellement), Absences (calendrier mensuel + demandes à valider)
 *   #/rh/:id        fiche individuelle : Identité, Habilitations, Formations, Visites médicales, Absences,
 *                   Activité maintenance ; impression de la fiche.
 * Fournit aussi GMAO.ouvrirMonDossierRH() : modale « Mon dossier RH » utilisable par tout utilisateur
 * (consultation de son dossier, demande d'absence, demandes de son équipe à valider pour un N+1).
 * Données sensibles : aucune donnée médicale (dates, type de visite et aptitude uniquement).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'rh';
  const TAILLE_MAX_DOC = 5 * 1024 * 1024;

  /** Listes propres au module (codes figés pour les statuts ; libellés surchargeables par la configuration). */
  const LISTES_DEFAUT = {
    statutsAbsence: [
      { code: 'demandee', label: 'En attente de validation', couleur: '#f59e0b', ordre: 1 },
      { code: 'validee', label: 'Validée', couleur: '#16a34a', ordre: 2 },
      { code: 'refusee', label: 'Refusée', couleur: '#dc2626', ordre: 3 },
      { code: 'annulee', label: 'Annulée', couleur: '#9ca3af', ordre: 4 },
    ],
    statutsFormation: [
      { code: 'planifiee', label: 'Planifiée', couleur: '#2563eb', ordre: 1 },
      { code: 'realisee', label: 'Réalisée', couleur: '#16a34a', ordre: 2 },
      { code: 'annulee', label: 'Annulée', couleur: '#9ca3af', ordre: 3 },
    ],
    typesVisiteMedicale: [
      { code: 'embauche', label: 'Visite d\'embauche (VIP)', couleur: '#2563eb', ordre: 1 },
      { code: 'periodique', label: 'Visite périodique', couleur: '#0891b2', ordre: 2 },
      { code: 'reprise', label: 'Visite de reprise', couleur: '#8b5cf6', ordre: 3 },
      { code: 'autre', label: 'Autre visite', couleur: '#6b7280', ordre: 4 },
    ],
    aptitudesMedicales: [
      { code: 'apte', label: 'Apte', couleur: '#16a34a', ordre: 1 },
      { code: 'apte_restrictions', label: 'Apte avec restrictions', couleur: '#f59e0b', ordre: 2 },
      { code: 'inapte', label: 'Inapte', couleur: '#dc2626', ordre: 3 },
      { code: 'en_attente', label: 'En attente', couleur: '#6b7280', ordre: 4 },
    ],
  };
  const LISTES_FIGEES = new Set(['statutsAbsence', 'statutsFormation']);
  const ETATS = {
    valide: { label: 'Valide', couleur: '#16a34a' },
    bientot: { label: 'À renouveler', couleur: '#f59e0b' },
    expiree: { label: 'Expirée', couleur: '#dc2626' },
    remplacee: { label: 'Renouvelée', couleur: '#9ca3af' },
    programmee: { label: 'Visite programmée', couleur: '#2563eb' },
  };
  const NIVEAUX = { 1: 'Notions', 2: 'Application', 3: 'Maîtrise', 4: 'Expert' };
  const DEMI = { matin: 'Matin', apres_midi: 'Après-midi' };
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const JOURS_INIT = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

  /** État conservé entre deux rendus (filtres, mois du calendrier, mode de l'onglet habilitations). */
  const memo = {
    personnel: { siteId: '', secteurId: '', typeContratCode: '', actif: '1', habilitationTypeCode: '' },
    matrice: { siteId: '', secteurId: '', masquerVides: false, typeFiltre: '', recherche: '' },
    habListe: { etat: '', typeCode: '' },
    formations: { statut: '', annee: '' },
    absences: { mois: null, secteurId: '', typeCode: '', attente: true, tous: false },
    alertes: 'toutes',
    modeHab: 'matrice',
  };

  // ----- Styles locaux (thèmes clair et sombre via les variables CSS) ----------------------------------
  function injecterStyles() {
    if (document.getElementById('style-vue-rh')) return;
    document.head.appendChild(el('style', { id: 'style-vue-rh', text: `
      .rh-grille-kpi { display: grid; gap: 12px; margin-bottom: 16px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
      .rh-grille-kpi.serre { grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); }
      .rh-grille-kpi .kpi > div:last-child { min-width: 0; }
      .rh-grille-kpi.serre .kpi-valeur { font-size: 19px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .rh-grille-kpi.tableau { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      @media (max-width: 1000px) { .rh-grille-kpi.tableau { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      .rh-deux-colonnes { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr); align-items: start; }
      @media (max-width: 1400px) { .rh-deux-colonnes { grid-template-columns: 1fr; } }
      [data-theme="sombre"] .badge.contour.rh-contour { color: var(--rh-contour-sombre) !important; }
      .rh-defilement { overflow: auto; border: 1px solid var(--bordure); border-radius: var(--rayon); background: var(--surface); max-height: calc(100vh - 290px); }
      .rh-matrice, .rh-cal { border-collapse: separate; border-spacing: 0; font-size: 12.5px; min-width: 100%; }
      .rh-matrice th, .rh-matrice td, .rh-cal th, .rh-cal td { border-bottom: 1px solid var(--bordure); border-right: 1px solid var(--bordure); background: var(--surface); }
      .rh-matrice thead th, .rh-cal thead th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--texte-2); font-weight: 600; }
      .rh-matrice tfoot td { position: sticky; bottom: 0; z-index: 2; background: var(--surface-2); font-weight: 600; font-size: 11.5px; color: var(--texte-2); }
      .rh-col-personne { position: sticky; left: 0; z-index: 1; text-align: left; min-width: 230px; max-width: 280px; padding: 6px 10px !important; }
      thead .rh-col-personne, tfoot .rh-col-personne { z-index: 3; }
      .rh-matrice td.rh-col-personne, .rh-matrice th.rh-col-personne, .rh-cal td.rh-col-personne, .rh-cal th.rh-col-personne { text-align: left; width: 250px; min-width: 250px; max-width: 250px; }
      .rh-matrice th.rh-type { height: 132px; width: 46px; min-width: 46px; padding: 8px 2px; vertical-align: bottom; cursor: pointer; }
      .rh-matrice th.rh-type:hover, .rh-matrice th.rh-type.actif { background: var(--primaire-clair); color: var(--lien); }
      .rh-matrice th.rh-type > div { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; margin: 0 auto; max-height: 118px; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
      .rh-matrice td { text-align: center; padding: 3px 3px; height: 32px; }
      .rh-matrice td.rh-col-personne { padding: 3px 10px !important; }
      .rh-matrice .rh-col-personne .cellule-principale, .rh-matrice .rh-col-personne .cellule-secondaire { line-height: 1.2; }
      .rh-matrice tbody tr:hover td { background: var(--surface-2); }
      .rh-cellule { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 24px; padding: 0 5px; border-radius: 6px; font-size: 11px; font-weight: 700; color: #fff; cursor: pointer; letter-spacing: .2px; }
      .rh-cellule:hover { filter: brightness(1.08); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--bordure-2); }
      .rh-ajout { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 24px; border-radius: 6px; border: 1px dashed var(--bordure-2); color: var(--texte-2); background: transparent; cursor: pointer; opacity: 0; font-size: 15px; line-height: 1; padding: 0; }
      .rh-matrice tbody tr:hover .rh-ajout { opacity: .75; }
      .rh-ajout:hover, .rh-ajout:focus-visible { opacity: 1 !important; color: var(--lien); border-color: var(--primaire); }
      .rh-cal th, .rh-cal td { padding: 0; min-width: 24px; width: 24px; text-align: center; }
      .rh-cal thead th { height: 40px; font-size: 11px; line-height: 1.15; }
      .rh-cal thead th .rh-num { font-size: 12.5px; color: var(--texte); }
      .rh-cal td { height: 34px; }
      .rh-cal .we { background: var(--fond) !important; }
      .rh-cal thead th.auj { background: var(--primaire-clair); color: var(--lien); }
      .rh-cal thead th.auj .rh-num { color: var(--lien); }
      .rh-cal td.auj { box-shadow: inset 2px 0 0 var(--primaire), inset -2px 0 0 var(--primaire); }
      .rh-cal td.rh-cliquable { cursor: pointer; }
      .rh-cal td.rh-cliquable:hover { background: var(--primaire-clair) !important; }
      .rh-bloc { display: block; height: 22px; margin: 5px 0; cursor: pointer; }
      .rh-bloc.debut { margin-left: 3px; border-top-left-radius: 5px; border-bottom-left-radius: 5px; }
      .rh-bloc.fin { margin-right: 3px; border-top-right-radius: 5px; border-bottom-right-radius: 5px; }
      .rh-legende { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--texte-2); align-items: center; }
      .rh-puce { width: 14px; height: 14px; border-radius: 4px; display: inline-block; vertical-align: middle; margin-right: 6px; }
      .rh-niveau { display: inline-flex; gap: 3px; vertical-align: middle; }
      .rh-niveau span { width: 18px; height: 7px; border-radius: 4px; background: var(--fond-2); }
      .rh-niveau span.on { background: var(--primaire); }
      .rh-liste-simple { list-style: none; margin: 0; padding: 0; }
      .rh-liste-simple li { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid var(--bordure); }
      .rh-liste-simple li:last-child { border-bottom: 0; }
      .rh-liste-simple li.cliquable { cursor: pointer; border-radius: 6px; }
      .rh-liste-simple li.cliquable:hover { background: var(--surface-2); }
      .rh-profil { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
      .rh-profil .avatar { flex-shrink: 0; }
      .rh-competences { display: grid; gap: 8px 24px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
      .rh-competences > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px dashed var(--bordure); }
      .rh-editeur-comp { display: grid; gap: 6px; }
      .rh-editeur-comp .ligne { display: grid; grid-template-columns: minmax(0, 1fr) 170px 34px; gap: 6px; align-items: center; }
      .rh-filtre-actif { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 14px; background: var(--primaire-clair); color: var(--lien); font-size: 12.5px; font-weight: 600; }
      .rh-filtre-actif button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; padding: 0 6px; }
      .rh-separateur-titre { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--texte-2); font-weight: 700; margin: 4px 0 8px; }
    ` }));
  }

  // ----- Utilitaires -------------------------------------------------------------------------------
  const can = (action) => GMAO.can(MODULE, action);
  const lectureSeule = (secteurId) => GMAO.siteLectureSeule(secteurId);
  /** Le site affiché (en-tête) n'est pas accessible en lecture seule. */
  const siteAffichableEnEcriture = () => !(GMAO.siteCourant() != null && lectureSeule(GMAO.siteCourant()));
  /** Création possible : droit rh › créer et site affiché (en-tête) non accessible en lecture seule. */
  const peutCreer = () => can('creer') && siteAffichableEnEcriture();
  /** Écriture possible sur cet enregistrement (droit, site non en lecture seule, portée serveur). */
  const ecriture = (action, rec) => can(action) && !(rec && lectureSeule(rec.secteurId)) && !(rec && rec.modifiable === false);
  function listeRh(nom) {
    const conf = GMAO.liste(nom);
    const def = LISTES_DEFAUT[nom];
    if (!def) return conf;
    if (!conf.length) return def;
    if (!LISTES_FIGEES.has(nom)) return conf;
    return def.map((d) => Object.assign({}, d, conf.find((x) => x.code === d.code) || {}, { code: d.code }));
  }
  const itemRh = (nom, code) => listeRh(nom).find((x) => x.code === code) || null;
  const libelleRh = (nom, code) => { const it = itemRh(nom, code); return it ? it.label : (code == null ? '' : String(code)); };
  function badgeRh(nom, code, opts) {
    if (code == null || code === '') return el('span', { class: 'texte-2' }, '—');
    const it = itemRh(nom, code);
    return (opts && opts.contour ? badgeContour : ui.badge)(it ? it.label : String(code), (it && it.couleur) || '#6b7280', opts);
  }
  // Badges « contour » (texte coloré sur la surface) : en thème sombre, la teinte est éclaircie jusqu'à un contraste
  // d'au moins 4,5:1 sur les surfaces du thème (fond, surface, surface-2), via une variable CSS lue par .rh-contour
  const FONDS_SOMBRES = [[30, 41, 59], [15, 23, 42], [39, 52, 73]];
  const hexRgb = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const luminance = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
  const contraste = (a, b) => { const la = luminance(a); const lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const cacheSombre = new Map();
  /** Fond et texte d'une cellule colorée de la matrice : texte blanc ou foncé lisible (ui.couleursBadge). */
  function celluleLisible(coul) { const c = ui.couleursBadge(coul); return c.texte ? { background: c.fond, color: c.texte } : { background: c.fond }; }
  function couleurSombre(coul) {
    if (cacheSombre.has(coul)) return cacheSombre.get(coul);
    const base = hexRgb(coul);
    let res = base ? '#ffffff' : coul;
    for (let f = 0; base && f <= 1.0001; f += 0.05) {
      const rgb = base.map((v) => Math.round(v + (255 - v) * f));
      if (FONDS_SOMBRES.every((fd) => contraste(rgb, fd) >= 4.6)) { res = `rgb(${rgb.join(',')})`; break; }
    }
    cacheSombre.set(coul, res);
    return res;
  }
  function badgeContour(label, coul, opts) {
    const b = ui.badge(label, coul || '#6b7280', Object.assign({}, opts, { contour: true }));
    b.classList.add('rh-contour');
    b.style.setProperty('--rh-contour-sombre', couleurSombre(coul || '#6b7280'));
    return b;
  }
  const badgeListeContour = (nom, code, opts) => (code == null || code === '' ? el('span', { class: 'texte-2' }, '—') : badgeContour(ui.libelle(nom, code), ui.couleur(nom, code), opts));
  const optionsRh = (nom, vide) => { const o = listeRh(nom).map((x) => ({ value: x.code, label: x.label })); if (vide !== false) o.unshift({ value: '', label: vide || '— Choisir —' }); return o; };
  const badgeEtat = (etat, titre) => (ETATS[etat] ? ui.badge(ETATS[etat].label, ETATS[etat].couleur, { titre }) : el('span', { class: 'texte-2' }, '—'));
  const typeHab = (code) => GMAO.liste('typesHabilitation').find((t) => t.code === code) || null;
  /** Libellé court d'un type d'habilitation (en-têtes de la matrice, badges compacts). */
  function labelCourt(label) {
    let s = String(label || '').replace(/^Habilitation électrique\s+/i, 'Élec. ').replace(/^Habilitation haute tension\s+/i, 'HT ');
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
    if (m) { const base = m[1].trim(); const par = m[2].trim(); if (base.length <= 22) s = base; else if (/^[A-Z0-9 .\/-]{2,10}$/.test(par)) s = par; }
    return s.length > 26 ? s.slice(0, 25).trim() + '…' : s;
  }
  const badgeHab = (code) => { if (!code) return el('span', { class: 'texte-2' }, '—'); const t = typeHab(code); return ui.badge(labelCourt(t ? t.label : code), (t && t.couleur) || '#6b7280', { titre: t ? t.label : code }); };
  function iconeDim(nom, taille, couleur) { const ic = icone(nom); Object.assign(ic.style, { width: taille + 'px', height: taille + 'px', flexShrink: 0, color: couleur || 'currentColor' }); return ic; }
  function lienVue(href, label) { return el('a', { href, onclick: (ev) => ev.stopPropagation() }, label); }
  const devise = () => ((GMAO.config.general || {}).devise) || '€';
  const joursAlerte = () => Number(((GMAO.config.rh || {}).alerteJoursAvantEcheance)) || 60;

  // Dates ISO (AAAA-MM-JJ) : calculs en UTC pour ignorer les changements d'heure
  const pad = (n) => String(n).padStart(2, '0');
  const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const versUTC = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const depuisUTC = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const ajouterJours = (iso, n) => depuisUTC(versUTC(iso) + n * 86400000);
  function ajouterMois(iso, n) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    const total = y * 12 + (m - 1) + Number(n); const ny = Math.floor(total / 12); const nm = total - ny * 12;
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()))}`;
  }
  const joursEntre = (a, b) => Math.round((versUTC(b) - versUTC(a)) / 86400000);
  const jourSemaine = (iso) => new Date(versUTC(iso)).getUTCDay();
  function fmt(iso) {
    if (!iso) return '';
    const s = String(iso).slice(0, 10);
    if (!RE_DATE.test(s)) return ui.formatDate(iso);
    const [y, m, d] = s.split('-').map(Number);
    return ui.formatDate(new Date(y, m - 1, d));
  }
  const moisAnnee = (iso) => `${String(iso).slice(5, 7)}/${String(iso).slice(2, 4)}`;
  function periode(du, au, demi) {
    if (!du) return '—';
    if (!au || au === du) return fmt(du) + (demi && DEMI[demi] ? ` (${DEMI[demi].toLowerCase()})` : '');
    return `${fmt(du)} → ${fmt(au)}`;
  }
  function relatifJours(n) { if (n == null) return ''; if (n === 0) return 'aujourd\'hui'; return n > 0 ? `dans ${n} j` : `depuis ${-n} j`; }
  function anciennete(mois) {
    if (mois == null) return '';
    const a = Math.floor(mois / 12); const m = mois % 12;
    return [a ? `${a} an${a > 1 ? 's' : ''}` : '', m ? `${m} mois` : ''].filter(Boolean).join(' ') || 'moins d\'un mois';
  }
  function paques(annee) {
    const a = annee % 19; const b = Math.floor(annee / 100); const c = annee % 100; const d = Math.floor(b / 4); const e = b % 4;
    const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
    return `${annee}-${pad(Math.floor((h + l - 7 * m + 114) / 31))}-${pad(((h + l - 7 * m + 114) % 31) + 1)}`;
  }
  const cacheFeries = new Map();
  function feries(annee) {
    if (!cacheFeries.has(annee)) {
      const p = paques(annee);
      cacheFeries.set(annee, new Map([['01-01', 'Jour de l\'an'], ['05-01', 'Fête du travail'], ['05-08', 'Victoire 1945'], ['07-14', 'Fête nationale'], ['08-15', 'Assomption'], ['11-01', 'Toussaint'], ['11-11', 'Armistice'], ['12-25', 'Noël']].map(([k, v]) => [`${annee}-${k}`, v])
        .concat([[ajouterJours(p, 1), 'Lundi de Pâques'], [ajouterJours(p, 39), 'Ascension'], [ajouterJours(p, 50), 'Lundi de Pentecôte']])));
    }
    return cacheFeries.get(annee);
  }
  const ferie = (iso) => feries(Number(String(iso).slice(0, 4))).get(iso) || null;
  const estOuvre = (iso) => { const j = jourSemaine(iso); return j !== 0 && j !== 6 && !ferie(iso); };
  function joursOuvres(du, au) { if (!du || !au || au < du) return 0; let n = 0; for (let d = du; d <= au; d = ajouterJours(d, 1)) if (estOuvre(d)) n++; return n; }
  const jours = (n) => `${ui.formatNombre(n, n % 1 ? 1 : 0)} j`;

  // ----- Petits composants ----------------------------------------------------------------------------
  function resumeHabilitations(r) {
    if (!r || !r.total) return el('span', { class: 'texte-2' }, '—');
    return el('span', { class: 'inline', style: { gap: '4px' } },
      r.valides ? ui.badge(String(r.valides), ETATS.valide.couleur, { titre: `${r.valides} valide(s)` }) : null,
      r.bientot ? ui.badge(String(r.bientot), ETATS.bientot.couleur, { titre: `${r.bientot} à renouveler` }) : null,
      r.expirees ? ui.badge(String(r.expirees), ETATS.expiree.couleur, { titre: `${r.expirees} expirée(s)` }) : null);
  }
  function niveauCompetence(n) {
    return el('span', { class: 'inline', style: { gap: '8px' }, title: NIVEAUX[n] || '' },
      el('span', { class: 'rh-niveau' }, [1, 2, 3, 4].map((i) => el('span', { class: i <= n ? 'on' : '' }))),
      el('span', { class: 'texte-2 texte-petit', style: { minWidth: '72px' } }, NIVEAUX[n] || ''));
  }
  function personneCellule(nomComplet, sous, taille, largeur) {
    return el('div', { class: 'inline', style: { gap: '10px', flexWrap: 'nowrap', minWidth: 0, width: largeur ? largeur + 'px' : '', maxWidth: largeur ? largeur + 'px' : '' } }, ui.avatar(nomComplet || '?', taille || 30),
      el('div', { style: { minWidth: 0 } }, el('div', { class: 'cellule-principale', style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, nomComplet || '—'),
        sous ? el('div', { class: 'cellule-secondaire texte-2 texte-petit', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, sous) : null));
  }
  function secteurCellule(id, chemin) {
    const s = ui.secteur(id);
    return s ? frag(ui.pastille(s.couleur), chemin || s.nom) : el('span', { class: 'texte-2' }, '—');
  }
  function echeance(dateIso, joursRestants, etat) {
    if (!dateIso) return el('span', { class: 'texte-2' }, 'Sans échéance');
    const coul = etat === 'expiree' ? 'texte-danger texte-gras' : etat === 'bientot' ? 'texte-alerte texte-gras' : '';
    return el('div', null, el('div', { class: coul }, fmt(dateIso)), joursRestants != null ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, relatifJours(joursRestants)) : null);
  }
  /** Prochaine visite médicale à afficher : la visite déjà programmée, sinon l'échéance fixée lors de la dernière visite. */
  function prochaineVisite(dv) {
    if (!dv) return null;
    if (dv.programmee) return { date: dv.programmee.date, etat: 'programmee', libelle: `Programmée le ${fmt(dv.programmee.date)}` };
    if (dv.prochaineVisite) return { date: dv.prochaineVisite, etat: dv.etat || 'valide', libelle: fmt(dv.prochaineVisite) };
    return { date: null, etat: null, libelle: `Non planifiée (dernière le ${fmt(dv.date)})` };
  }
  function selectFiltre(options, valeur, titre, onChange) {
    const s = el('select', { title: titre, onchange: () => onChange(s.value) }, options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(valeur) }, o.label)));
    return s;
  }
  /** Options du filtre site / service (sites accessibles, puis services du site courant). */
  function optionsSitesServices() {
    const sites = (GMAO.perms.sites || []);
    const out = [{ value: '', label: 'Tous les sites et services' }];
    if (sites.length > 1 && GMAO.siteCourant() == null) sites.forEach((s) => out.push({ value: 'site:' + s.id, label: `Site : ${s.nom}${s.mode === 'lecture' ? ' (lecture seule)' : ''}` }));
    return out.concat(ui.optionsSecteurs({ vide: false }).map((o) => ({ value: 'sect:' + o.value, label: o.label })));
  }
  /** Filtre site / service mémorisé : remis à zéro si son option n'existe plus (site changé dans l'en-tête). */
  function filtreSiteService(f) {
    if (f.siteService && !optionsSitesServices().some((o) => o.value === f.siteService)) f.siteService = '';
    return f.siteService || '';
  }
  function paramsSiteService(v) {
    if (!v) return {};
    const [k, id] = String(v).split(':');
    return k === 'site' ? { siteId: id } : { secteurId: id };
  }
  function boutonExport(quoi, params, libelle) {
    if (!can('exporter')) return null;
    return ui.bouton(libelle || 'Exporter CSV', { icone: 'export', classe: 'btn-sm', titre: 'Export CSV (séparateur point-virgule, compatible Excel)', onClic: () => {
      const p = new URLSearchParams(); for (const [k, v] of Object.entries(params ? params() : {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
      api.telecharger(`/api/rh/export/${quoi}${p.toString() ? '?' + p : ''}`, `rh-${quoi}-${ui.aujourdhui()}.csv`).then(() => toast('Export CSV téléchargé', 'succes')).catch(erreur);
    } });
  }
  async function chargerPersonnes(actifs = true) {
    try { return await api.get('/api/rh/personnel', actifs ? { actif: '1' } : {}); } catch (e) { erreur(e); return []; }
  }
  const optionsPersonnes = (personnes, vide) => [{ value: '', label: vide || '— Choisir une personne —' }].concat(personnes.filter((p) => !lectureSeule(p.secteurId) && p.modifiable !== false).map((p) => ({ value: p.id, label: `${p.nomComplet} · ${p.matricule}${p.secteurNom ? ' · ' + p.secteurNom : ''}` })));
  function tailleLisible(o) { const n = Number(o) || 0; if (n < 1024) return `${n} o`; if (n < 1048576) return `${Math.round(n / 1024)} Ko`; return `${(n / 1048576).toFixed(1)} Mo`; }

  // ====================================================================================================
  // Formulaires
  // ====================================================================================================
  /** Fiche du personnel : création / modification. */
  async function ouvrirFormulairePersonnel(existant, options = {}) {
    const creation = !existant;
    let tous = [];
    try { tous = await api.get('/api/rh/personnel'); } catch (e) { tous = []; }
    const lies = new Set(tous.filter((p) => p.userId != null && (!existant || p.id !== existant.id)).map((p) => Number(p.userId)));
    const moi = GMAO.user ? Number(GMAO.user.id) : null;
    // Comptes proposés : actifs (plus celui déjà enregistré, même désactivé, pour ne pas afficher un identifiant brut) ;
    // lier sa propre fiche ou se désigner N+1 relève d'un autre gestionnaire (refusé par le serveur), sauf administrateur
    const optionsComptes = (vide, deja, filtre) => ui.optionsUsers({ tousSites: true, inactifs: true, vide, filtre: (u) => (u.actif !== false || u.id === deja) && (u.id !== moi || GMAO.estAdmin() || u.id === deja) && filtre(u) })
      .map((o) => { const u = o.value === '' ? null : ui.user(o.value); return u && u.actif === false ? Object.assign({}, o, { label: `${o.label} (désactivé)` }) : o; });
    const userIdActuel = existant && existant.userId != null ? Number(existant.userId) : null;
    const managerActuel = existant && existant.managerUserId != null ? Number(existant.managerUserId) : null;
    const suggestions = Array.from(new Set(tous.flatMap((p) => (p.competences || []).map((c) => c.libelle)))).sort((a, b) => a.localeCompare(b, 'fr'));
    let competences = ((existant && existant.competences) || []).map((c) => Object.assign({}, c));
    const gabarit = ((GMAO.config.numerotation || {}).mat) || 'MAT-{num:4}';

    function editeurCompetences() {
      const cont = el('div', { class: 'rh-editeur-comp' });
      const dl = el('datalist', { id: 'dl_rh_competences' }, suggestions.map((s) => el('option', { value: s })));
      function dessiner() {
        ui.vider(cont);
        cont.appendChild(dl);
        if (!competences.length) cont.appendChild(el('div', { class: 'texte-2 texte-petit' }, 'Aucune compétence renseignée.'));
        competences.forEach((c, i) => {
          const lib = el('input', { type: 'text', value: c.libelle || '', placeholder: 'ex. Hydraulique industrielle', list: 'dl_rh_competences', maxlength: 100, oninput: () => { c.libelle = lib.value; } });
          const niv = el('select', { onchange: () => { c.niveau = Number(niv.value); } }, [1, 2, 3, 4].map((n) => el('option', { value: n, selected: Number(c.niveau || 1) === n }, `${n} – ${NIVEAUX[n]}`)));
          cont.appendChild(el('div', { class: 'ligne' }, lib, niv, el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Retirer', onclick: () => { competences.splice(i, 1); dessiner(); } }, icone('supprimer'))));
        });
        cont.appendChild(el('div', null, el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { competences.push({ libelle: '', niveau: 2 }); dessiner(); const ins = cont.querySelectorAll('input[type=text]'); if (ins.length) ins[ins.length - 1].focus(); } }, icone('plus'), 'Ajouter une compétence')));
      }
      dessiner();
      return cont;
    }

    const champs = [
      { type: 'separateur', label: 'Identité' },
      { nom: 'nom', label: 'Nom', type: 'texte', requis: true, maxLength: 100 },
      { nom: 'prenom', label: 'Prénom', type: 'texte', maxLength: 100 },
      { nom: 'matricule', label: 'Matricule', type: 'texte', maxLength: 30, placeholder: creation ? 'Attribué automatiquement si vide' : '', aide: creation ? `Gabarit : ${gabarit} (ou matricule du compte GMAO lié).` : 'Doit rester unique.' },
      { nom: 'fonction', label: 'Fonction / poste', type: 'texte', maxLength: 150, placeholder: 'ex. Technicien de maintenance' },
      { nom: 'userId', label: 'Compte GMAO lié', type: 'select', options: optionsComptes('— Aucun compte —', userIdActuel, (u) => !lies.has(u.id) || u.id === userIdActuel),
        aide: 'Permet à la personne de consulter « Mon dossier RH » et relie son activité de maintenance (OT, temps passé).',
        onChange: (v, f) => { if (!creation || !v) return; const u = ui.user(v); if (!u) return; if (!f.get('nom')) f.set('nom', u.nom || ''); if (!f.get('prenom')) f.set('prenom', u.prenom || ''); if (!f.get('fonction') && u.fonction) f.set('fonction', u.fonction); if (!f.get('managerUserId') && u.managerId != null) f.set('managerUserId', u.managerId); } },
      { type: 'separateur', label: 'Rattachement et contrat' },
      { nom: 'secteurId', label: 'Site / service', type: 'select', requis: true, options: ui.optionsSecteurs({ vide: '— Choisir —' }).filter((o) => o.value === '' || !lectureSeule(o.value)), aide: 'Détermine qui peut consulter la fiche (portée, multi-site).' },
      { nom: 'managerUserId', label: 'Responsable hiérarchique (N+1)', type: 'select', options: optionsComptes('— Aucun —', managerActuel, () => true), aide: 'Valide les demandes d\'absence de la personne.' },
      { nom: 'typeContratCode', label: 'Type de contrat', type: 'select', liste: 'typesContrat', vide: false, requis: true },
      { nom: 'dateEntree', label: 'Date d\'entrée', type: 'date' },
      { nom: 'dateSortie', label: 'Date de sortie / fin de contrat', type: 'date', aide: 'Fin de CDD, de mission d\'intérim ou départ : une alerte est émise avant l\'échéance.' },
      can('modifier') ? { nom: 'coutHoraire', label: `Coût horaire chargé (${devise()}/h)`, type: 'nombre', min: 0, step: '0.01', aide: 'Confidentiel : visible uniquement des personnes autorisées à modifier le RH.' } : null,
      { nom: 'actif', label: 'Fiche active (personne présente dans l\'effectif)', type: 'booleen', valeur: true },
      { type: 'separateur', label: 'Coordonnées' },
      { nom: 'telephone', label: 'Téléphone', type: 'tel', maxLength: 30 },
      { nom: 'email', label: 'E-mail', type: 'email', maxLength: 150 },
      { nom: 'urgenceNom', label: 'Contact d\'urgence', type: 'texte', maxLength: 100, placeholder: 'Nom et lien (ex. conjoint)' },
      { nom: 'urgenceTelephone', label: 'Téléphone d\'urgence', type: 'tel', maxLength: 30 },
      { type: 'separateur', label: 'Compétences' },
      { type: 'html', nom: 'competencesEditeur', rendu: editeurCompetences },
      { nom: 'notes', label: 'Notes RH', type: 'texte_long', lignes: 3, placeholder: 'Informations utiles au suivi (aucune donnée médicale)' },
      ...ui.champsPersoDefs('personnel'),
    ];
    const premierContrat = (GMAO.liste('typesContrat')[0] || {}).code || '';
    const valeurs = existant
      ? Object.assign({}, existant, {
        userId: existant.userId == null ? '' : existant.userId, managerUserId: existant.managerUserId == null ? '' : existant.managerUserId, secteurId: existant.secteurId == null ? '' : existant.secteurId,
        urgenceNom: (existant.contactUrgence || {}).nom || '', urgenceTelephone: (existant.contactUrgence || {}).telephone || '', actif: existant.actif !== false,
        typeContratCode: existant.typeContratCode || premierContrat,
      }, ui.champsPersoInitiaux(existant))
      : { actif: true, typeContratCode: premierContrat, secteurId: options.secteurId || '' };
    ui.formModal({
      titre: creation ? 'Nouvelle fiche du personnel' : `Modifier la fiche — ${existant.nomComplet}`, taille: 'large', champs, valeurs,
      submitLabel: creation ? 'Créer la fiche' : 'Enregistrer',
      onSubmit: async (v, modal, form) => {
        const comps = competences.map((c) => ({ libelle: String(c.libelle || '').trim(), niveau: Number(c.niveau) || 1 })).filter((c) => c.libelle);
        const doublon = comps.find((c, i) => comps.findIndex((x) => x.libelle.toLowerCase() === c.libelle.toLowerCase()) !== i);
        if (doublon) { toast(`Compétence en double : « ${doublon.libelle} »`, 'erreur'); return false; }
        if (v.dateEntree && v.dateSortie && v.dateSortie < v.dateEntree) { form.erreur('dateSortie', 'La date de sortie précède la date d\'entrée'); return false; }
        const body = {
          nom: v.nom, prenom: v.prenom, matricule: v.matricule, fonction: v.fonction, userId: v.userId === '' ? null : v.userId,
          secteurId: v.secteurId === '' ? null : v.secteurId, managerUserId: v.managerUserId === '' ? null : v.managerUserId, typeContratCode: v.typeContratCode,
          dateEntree: v.dateEntree || null, dateSortie: v.dateSortie || null, telephone: v.telephone, email: v.email,
          contactUrgence: { nom: v.urgenceNom || '', telephone: v.urgenceTelephone || '' }, competences: comps, notes: v.notes, actif: !!v.actif,
          champs: ui.champsPersoValeurs(v),
        };
        if (can('modifier')) body.coutHoraire = v.coutHoraire == null || v.coutHoraire === '' ? null : v.coutHoraire;
        const res = creation ? await api.post('/api/rh/personnel', body) : await api.put('/api/rh/personnel/' + existant.id, body);
        toast(creation ? `Fiche ${res.matricule} créée` : `Fiche ${res.matricule} enregistrée`, 'succes');
        if (options.apres) options.apres(res); else GMAO.navigate('#/rh/' + res.id);
      },
    });
  }

  /** Habilitation : création (personne / type pré-remplis possibles) ou modification. */
  async function ouvrirHabilitation(existant, options = {}) {
    const creation = !existant;
    let personnes = [];
    if (creation && !options.personnelId) personnes = await chargerPersonnes(true);
    const personneFixe = existant ? { id: existant.personnelId, nom: existant.personnelNom } : (options.personnelId ? { id: options.personnelId, nom: options.personnelNom } : null);
    const libDuree = (code) => { const t = typeHab(code); return t && Number(t.dureeMois) > 0 ? `${t.dureeMois} mois` : null; };
    const apercu = el('div', { class: 'texte-petit texte-2' });
    function majApercu(f) {
      const type = f.get('typeCode'); const obt = f.get('dateObtention'); const exp = f.get('dateExpiration');
      const t = typeHab(type);
      ui.vider(apercu);
      if (!type) return;
      if (exp) { apercu.appendChild(frag('Échéance saisie : ', el('strong', null, fmt(exp)))); return; }
      if (t && Number(t.dureeMois) > 0) apercu.appendChild(obt ? frag(`Durée de validité : ${t.dureeMois} mois — échéance calculée : `, el('strong', null, fmt(ajouterMois(obt, t.dureeMois)))) : frag(`Durée de validité du type : ${t.dureeMois} mois.`));
      else apercu.appendChild(frag('Aucune durée de validité configurée pour ce type : habilitation sans échéance (sauf date saisie).'));
    }
    const champs = [
      personneFixe ? { nom: 'personneLecture', label: 'Personne', type: 'lecture', valeur: personneFixe.nom || '' } : { nom: 'personnelId', label: 'Personne', type: 'select', requis: true, options: optionsPersonnes(personnes) },
      { nom: 'typeCode', label: 'Type d\'habilitation', type: 'select', requis: true, options: ui.optionsListe('typesHabilitation', { vide: '— Choisir —' }).map((o) => (o.value && libDuree(o.value) ? Object.assign({}, o, { label: `${o.label} (${libDuree(o.value)})` }) : o)), onChange: (v, f) => majApercu(f) },
      { nom: 'intitule', label: 'Intitulé précis', type: 'texte', maxLength: 200, placeholder: 'ex. B2V / BR / BC, CACES R489 catégories 1A et 3…', aide: 'Laisser vide pour reprendre le libellé du type.' },
      { nom: 'organisme', label: 'Organisme / formateur', type: 'texte', maxLength: 150 },
      { nom: 'numero', label: 'N° de titre / d\'attestation', type: 'texte', maxLength: 60 },
      { nom: 'dateObtention', label: 'Date d\'obtention', type: 'date', requis: true, max: ui.aujourdhui(), onChange: (v, f) => majApercu(f) },
      { nom: 'dateExpiration', label: 'Date d\'expiration', type: 'date', aide: 'Laisser vide : calculée selon la durée de validité du type (listes de la configuration).', onChange: (v, f) => majApercu(f) },
      { type: 'html', nom: 'apercu', rendu: () => apercu },
      { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 2, placeholder: 'Restrictions d\'usage, équipements concernés…' },
      creation ? { nom: 'fichier', label: 'Pièce justificative (facultatif)', type: 'fichier', tailleMax: TAILLE_MAX_DOC, accept: 'image/*,application/pdf', aide: 'Titre d\'habilitation, attestation, carte CACES… (PDF ou image, 5 Mo maximum).' } : null,
    ];
    const valeurs = existant ? Object.assign({}, existant, { dateExpiration: existant.expirationCalculee ? '' : existant.dateExpiration }) : { typeCode: options.typeCode || '', personnelId: options.personnelId || '' };
    const m = ui.formModal({
      titre: creation ? 'Nouvelle habilitation' : `Modifier l'habilitation — ${existant.personnelNom}`, taille: 'large', champs, valeurs,
      submitLabel: creation ? 'Enregistrer l\'habilitation' : 'Enregistrer',
      onSubmit: async (v) => {
        const body = { typeCode: v.typeCode, intitule: v.intitule, organisme: v.organisme, numero: v.numero, dateObtention: v.dateObtention, dateExpiration: v.dateExpiration || null, commentaire: v.commentaire };
        let res;
        if (creation) {
          body.personnelId = personneFixe ? personneFixe.id : v.personnelId;
          if (v.fichier && v.fichier.contenu) body.documents = [{ nom: v.fichier.nom, type: v.fichier.type, contenu: v.fichier.contenu }];
          res = await api.post('/api/rh/habilitations', body);
        } else res = await api.put('/api/rh/habilitations/' + existant.id, body);
        toast(`${res.intitule} : ${res.dateExpiration ? 'valable jusqu\'au ' + fmt(res.dateExpiration) : 'sans échéance'}`, 'succes');
        if (options.apres) options.apres(res);
      },
    });
    majApercu(m.form);
  }

  function ouvrirDocumentsHabilitation(h, apres) {
    const corps = el('div');
    let docs = h.documents || [];
    const modifiable = ecriture('modifier', h);
    // La vue appelante n'est rafraîchie qu'à la fermeture (si la vue est toujours affichée) : la fenêtre reste ouverte
    // entre deux ajouts (recto puis verso d'une carte, par exemple)
    let modifie = false;
    const hashInitial = location.hash;
    function dessiner() {
      ui.vider(corps);
      corps.appendChild(el('p', { class: 'texte-2', style: { marginTop: 0 } }, `${h.intitule} — ${h.personnelNom}. Pièces justificatives : PDF ou images, 5 Mo maximum par fichier.`));
      if (!docs.length) corps.appendChild(ui.vide('Aucune pièce justificative jointe', 'piece_jointe'));
      else corps.appendChild(el('ul', { class: 'rh-liste-simple' }, docs.map((d) => el('li', null,
        iconeDim('piece_jointe', 18, 'var(--texte-2)'),
        el('div', { style: { flex: 1, minWidth: 0 } }, el('div', { class: 'texte-gras', style: { wordBreak: 'break-word' } }, d.nom), el('div', { class: 'texte-2 texte-petit' }, `${tailleLisible(d.taille)} · ${fmt(d.date)}${d.userNom ? ' · ' + d.userNom : ''}`)),
        el('a', { class: 'btn btn-sm', href: `/api/rh/habilitations/${h.id}/documents/${d.uid || d.index}`, target: '_blank', rel: 'noopener' }, icone('voir'), 'Ouvrir'),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => api.telecharger(`/api/rh/habilitations/${h.id}/documents/${d.uid || d.index}?telecharger=1`, d.nom).catch(erreur) }, icone('export'), 'Télécharger'),
        modifiable ? el('button', { type: 'button', class: 'btn btn-sm btn-icone texte-danger', title: 'Supprimer', onclick: async () => {
          if (!(await ui.confirm({ titre: 'Supprimer la pièce jointe', message: `Supprimer « ${d.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { const r = await api.del(`/api/rh/habilitations/${h.id}/documents/${d.uid || d.index}`); docs = r.documents; modifie = true; dessiner(); toast('Pièce jointe supprimée', 'succes'); } catch (e) { erreur(e); }
        } }, icone('supprimer')) : null))));
      if (modifiable) {
        const input = el('input', { type: 'file', accept: 'image/*,application/pdf', style: { display: 'none' }, onchange: async () => {
          const f = input.files && input.files[0];
          if (!f) return;
          if (f.size > TAILLE_MAX_DOC) { toast('Fichier trop volumineux (5 Mo maximum)', 'erreur'); return; }
          try { const contenu = await ui.lireFichier(f); const r = await api.post(`/api/rh/habilitations/${h.id}/documents`, { nom: f.name, type: f.type, contenu }); docs = r.documents; modifie = true; dessiner(); toast('Pièce jointe ajoutée', 'succes'); } catch (e) { erreur(e); }
        } });
        corps.appendChild(el('div', { class: 'mt' }, input, ui.bouton('Ajouter une pièce jointe', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => input.click() })));
      }
    }
    dessiner();
    ui.modal({ titre: 'Pièces justificatives', taille: 'large', contenu: corps, boutons: [{ label: 'Fermer' }], onFermer: () => { if (modifie && apres && location.hash === hashInitial) apres(); } });
  }

  /** Visite médicale : uniquement date, type, aptitude et aménagement de poste (aucune donnée médicale). */
  async function ouvrirVisite(existant, options = {}) {
    const creation = !existant;
    let personnes = [];
    if (creation && !options.personnelId) personnes = await chargerPersonnes(true);
    const personneFixe = existant ? { id: existant.personnelId, nom: existant.personnelNom } : (options.personnelId ? { id: options.personnelId, nom: options.personnelNom } : null);
    ui.formModal({
      titre: creation ? 'Nouvelle visite médicale' : `Visite médicale — ${existant.personnelNom}`, taille: 'large',
      avant: ui.alerte('Données sensibles : seules la date, le type de visite et l\'avis d\'aptitude sont enregistrés. Ne saisissez aucune information médicale (diagnostic, traitement, pathologie) et ne joignez aucun document médical.', 'info'),
      champs: [
        personneFixe ? { nom: 'personneLecture', label: 'Personne', type: 'lecture', valeur: personneFixe.nom || '' } : { nom: 'personnelId', label: 'Personne', type: 'select', requis: true, options: optionsPersonnes(personnes) },
        { nom: 'type', label: 'Type de visite', type: 'select', requis: true, options: optionsRh('typesVisiteMedicale', false) },
        { nom: 'date', label: 'Date de la visite', type: 'date', requis: true, aide: 'Une date future correspond à une visite programmée.', onChange: (v, f) => { if (v && !f.get('prochaineVisite') && f.get('type') === 'periodique') f.set('prochaineVisite', ajouterMois(v, 24)); } },
        { nom: 'aptitude', label: 'Avis d\'aptitude', type: 'select', requis: true, options: optionsRh('aptitudesMedicales', false) },
        { nom: 'restrictions', label: 'Aménagement de poste / restrictions', type: 'texte', maxLength: 200, pleineLargeur: true, placeholder: 'ex. Port de charges limité à 15 kg', aide: 'Texte court, sans information médicale.', afficherSi: (v) => v.aptitude === 'apte_restrictions' || v.aptitude === 'inapte' || !!(existant && existant.restrictions) },
        { nom: 'prochaineVisite', label: 'Prochaine visite', type: 'date', aide: 'Date fixée par le service de prévention et de santé au travail ; une alerte est émise avant l\'échéance.' },
      ],
      valeurs: existant ? Object.assign({}, existant) : { type: 'periodique', aptitude: 'en_attente', date: ui.aujourdhui() },
      onSubmit: async (v) => {
        if (v.prochaineVisite && v.date && v.prochaineVisite < v.date) { toast('La prochaine visite ne peut pas précéder la visite', 'erreur'); return false; }
        const body = { type: v.type, date: v.date, aptitude: v.aptitude, restrictions: (v.aptitude === 'apte_restrictions' || v.aptitude === 'inapte') ? (v.restrictions || '') : '', prochaineVisite: v.prochaineVisite || null };
        const res = creation ? await api.post('/api/rh/visites', Object.assign(body, { personnelId: personneFixe ? personneFixe.id : v.personnelId })) : await api.put('/api/rh/visites/' + existant.id, body);
        toast(`Visite du ${fmt(res.date)} enregistrée`, 'succes');
        if (options.apres) options.apres(res);
      },
    });
  }

  /** Détail d'une visite en consultation (sans droit de modification sur la fiche). */
  function ouvrirDetailVisite(v) {
    ui.modal({
      titre: `Visite médicale — ${v.personnelNom || ''}`, taille: 'petite',
      contenu: frag(
        el('div', { class: 'inline mb', style: { gap: '8px' } }, badgeRh('typesVisiteMedicale', v.type, { contour: true }), badgeRh('aptitudesMedicales', v.aptitude)),
        ui.details([
          { label: 'Date', valeur: `${fmt(v.date)}${v.date > ui.aujourdhui() ? ' (programmée)' : ''}` },
          { label: 'Aménagement de poste', valeur: v.restrictions },
          { label: 'Prochaine visite', valeur: v.prochaineVisite ? frag(fmt(v.prochaineVisite), ' ', v.etat && v.etat !== 'remplacee' ? badgeEtat(v.etat) : null) : '' },
        ])),
      boutons: [{ label: 'Fermer' }],
    });
  }

  /** Absence saisie par les RH (ou demande pour soi via « Mon dossier RH » : options.moi). */
  async function ouvrirAbsence(existant, options = {}) {
    const creation = !existant;
    let personnes = [];
    if (creation && !options.personnelId && !options.moi) personnes = await chargerPersonnes(true);
    const personneFixe = existant ? { id: existant.personnelId, nom: existant.personnelNom } : (options.personnelId ? { id: options.personnelId, nom: options.personnelNom } : null);
    const calcul = el('div', { class: 'texte-petit texte-2' });
    const types = options.types || GMAO.liste('typesAbsence');
    function majCalcul(f) {
      const du = f.get('dateDebut'); const au = f.get('dateFin') || du; const demi = f.get('demiJournee');
      ui.vider(calcul);
      if (!du) return;
      if (au < du) { calcul.appendChild(el('span', { class: 'texte-danger' }, 'La date de fin précède la date de début.')); return; }
      const n = demi && au === du ? (estOuvre(du) ? 0.5 : 0) : joursOuvres(du, au);
      const f2 = []; for (let d = du; d <= au && f2.length < 5; d = ajouterJours(d, 1)) if (ferie(d) && jourSemaine(d) % 6 !== 0) f2.push(`${ferie(d)} (${fmt(d)})`);
      calcul.appendChild(frag('Durée : ', el('strong', { style: { color: 'var(--texte)' } }, `${jours(n)} ouvré${n > 1 ? 's' : ''}`), ' (hors week-ends et jours fériés)', f2.length ? ` — férié(s) : ${f2.join(', ')}` : ''));
    }
    const champs = [
      options.moi ? null : (personneFixe ? { nom: 'personneLecture', label: 'Personne', type: 'lecture', valeur: personneFixe.nom || '' } : { nom: 'personnelId', label: 'Personne', type: 'select', requis: true, options: optionsPersonnes(personnes) }),
      { nom: 'typeCode', label: 'Type d\'absence', type: 'select', requis: true, options: [{ value: '', label: '— Choisir —' }].concat(types.map((t) => ({ value: t.code, label: t.label }))) },
      { nom: 'dateDebut', label: 'Du', type: 'date', requis: true, onChange: (v, f) => { if (v && (!f.get('dateFin') || f.get('dateFin') < v)) f.set('dateFin', v); majCalcul(f); } },
      { nom: 'dateFin', label: 'Au (inclus)', type: 'date', onChange: (v, f) => majCalcul(f) },
      { nom: 'demiJournee', label: 'Demi-journée', type: 'select', options: [{ value: '', label: 'Journée(s) entière(s)' }, { value: 'matin', label: 'Matin uniquement' }, { value: 'apres_midi', label: 'Après-midi uniquement' }], afficherSi: (v) => !!v.dateDebut && (!v.dateFin || v.dateFin === v.dateDebut), onChange: (v, f) => majCalcul(f) },
      { type: 'html', nom: 'calcul', rendu: () => calcul },
      { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 2, placeholder: options.moi ? 'Précision facultative pour votre responsable' : 'Motif, justificatif reçu… (aucune information médicale)' },
      creation && !options.moi && (can('valider') || options.manager) ? { nom: 'valider', label: 'Valider directement (absence déjà accordée ou justifiée)', type: 'booleen', valeur: true } : null,
    ];
    const valeurs = existant ? Object.assign({}, existant, { demiJournee: existant.demiJournee || '' }) : { dateDebut: options.date || '', dateFin: options.date || '', typeCode: options.typeCode || '', personnelId: options.personnelId || '' };
    const m = ui.formModal({
      titre: options.moi ? 'Demander une absence' : (creation ? 'Nouvelle absence' : `Modifier l'absence — ${existant.personnelNom}`), taille: 'large', champs, valeurs,
      avant: options.moi ? ui.alerte('Votre demande est transmise à votre responsable hiérarchique (N+1) et aux valideurs RH. Vous serez notifié de la décision.', 'info') : null,
      submitLabel: options.moi ? 'Envoyer la demande' : 'Enregistrer',
      onSubmit: async (v) => {
        if (v.dateFin && v.dateFin < v.dateDebut) { toast('La date de fin précède la date de début', 'erreur'); return false; }
        const memeJour = !v.dateFin || v.dateFin === v.dateDebut;
        const body = { typeCode: v.typeCode, dateDebut: v.dateDebut, dateFin: v.dateFin || v.dateDebut, demiJournee: memeJour && v.demiJournee ? v.demiJournee : null, commentaire: v.commentaire };
        let res;
        if (options.moi) res = await api.post('/api/rh/moi/absences', body);
        else if (creation) res = await api.post('/api/rh/absences', Object.assign(body, { personnelId: personneFixe ? personneFixe.id : v.personnelId, statut: v.valider ? 'validee' : 'demandee' }));
        else res = await api.put('/api/rh/absences/' + existant.id, body);
        toast(options.moi ? 'Demande d\'absence envoyée' : `Absence ${res.statut === 'validee' ? 'validée' : 'enregistrée'} : ${periode(res.dateDebut, res.dateFin, res.demiJournee)}`, 'succes');
        if (options.apres) options.apres(res);
      },
    });
    majCalcul(m.form);
  }

  /** Modification proposée : demande en attente, ou absence validée pour un valideur (sinon la validation serait à refaire). */
  const absenceModifiable = (a) => ecriture('modifier', a) && (a.statut === 'demandee' || (a.statut === 'validee' && a.peutValider));
  async function deciderAbsence(a, decision, apres) {
    try {
      if (decision === 'valider') {
        const r = await api.post(`/api/rh/absences/${a.id}/valider`, {});
        toast(`Absence de ${r.personnelNom} validée`, 'succes');
      } else {
        const motif = await ui.prompt({ titre: 'Refuser la demande d\'absence', message: `${a.personnelNom} — ${a.typeLibelle} ${periode(a.dateDebut, a.dateFin, a.demiJournee)}`, label: 'Motif du refus (communiqué à la personne)', type: 'texte_long', okLabel: 'Refuser la demande' });
        if (motif === null) return;
        const r = await api.post(`/api/rh/absences/${a.id}/refuser`, { motif });
        toast(`Demande de ${r.personnelNom} refusée`, 'alerte');
      }
      GMAO.majNotifications && GMAO.majNotifications();
      if (apres) apres();
    } catch (e) { erreur(e); }
  }
  async function annulerAbsence(a, apres, moi) {
    const ok = await ui.confirm({ titre: 'Annuler l\'absence', message: `Annuler ${moi ? 'votre absence' : 'l\'absence de ' + a.personnelNom} (${a.typeLibelle}, ${periode(a.dateDebut, a.dateFin, a.demiJournee)}) ? Les personnes concernées seront informées.`, okLabel: 'Annuler l\'absence', annulerLabel: 'Retour', danger: true });
    if (!ok) return;
    try { await api.post(moi ? `/api/rh/moi/absences/${a.id}/annuler` : `/api/rh/absences/${a.id}/annuler`, {}); toast('Absence annulée', 'succes'); if (apres) apres(); } catch (e) { erreur(e); }
  }
  async function supprimerAbsence(a, apres) {
    if (!(await ui.confirm({ titre: 'Supprimer l\'absence', message: `Supprimer définitivement l'absence de ${a.personnelNom} (${periode(a.dateDebut, a.dateFin, a.demiJournee)}) ? Préférez l'annulation pour conserver l'historique.`, okLabel: 'Supprimer', danger: true }))) return;
    try { await api.del('/api/rh/absences/' + a.id); toast('Absence supprimée', 'succes'); if (apres) apres(); } catch (e) { erreur(e); }
  }
  /** Détail d'une absence (calendrier, listes) avec les actions possibles. */
  function ouvrirDetailAbsence(a, apres) {
    const actions = [];
    if (a.peutDecider) {
      actions.push({ label: 'Refuser', classe: 'btn-danger', icone: 'fermer', onClic: () => { deciderAbsence(a, 'refuser', apres); } });
      actions.push({ label: 'Valider', classe: 'btn-ok', icone: 'check', onClic: () => { deciderAbsence(a, 'valider', apres); } });
    }
    if (ecriture('modifier', a) && (a.statut === 'demandee' || a.statut === 'validee')) actions.unshift({ label: 'Annuler l\'absence', icone: 'fermer', gauche: true, onClic: () => { annulerAbsence(a, apres); } });
    if (absenceModifiable(a)) actions.unshift({ label: 'Modifier', icone: 'modifier', gauche: true, onClic: () => { ouvrirAbsence(a, { apres }); } });
    ui.modal({
      // Taille standard dès que plusieurs actions sont proposées (sinon les boutons passent sur deux lignes)
      titre: `Absence — ${a.personnelNom}`, taille: actions.length > 1 ? undefined : 'petite',
      contenu: frag(
        el('div', { class: 'inline mb', style: { gap: '8px' } }, ui.badge(a.typeLibelle, a.typeCouleur), badgeRh('statutsAbsence', a.statut)),
        ui.details([
          { label: 'Période', valeur: periode(a.dateDebut, a.dateFin, a.demiJournee) },
          { label: 'Durée', valeur: `${jours(a.nbJours)} ouvré(s)` },
          { label: 'Demandée par', valeur: a.demandeurNom ? `${a.demandeurNom}, le ${ui.formatDate(a.createdAt)}` : '' },
          { label: a.statut === 'refusee' ? 'Refusée par' : 'Validée par', valeur: a.valideurNom ? `${a.valideurNom}, le ${ui.formatDate(a.dateValidation)}` : '' },
          a.motifDecision ? { label: 'Motif', valeur: a.motifDecision } : null,
          { label: 'Responsable (N+1)', valeur: a.managerNom },
          { label: 'Commentaire', valeur: a.commentaire },
        ])),
      boutons: actions.concat([{ label: 'Fermer' }]),
    });
  }

  /** Formation : création / modification. */
  async function ouvrirFormation(existant, options = {}) {
    const creation = !existant;
    const [personnes, refs] = await Promise.all([chargerPersonnes(true), api.get('/api/rh/references').catch(() => ({ fournisseurs: [], factures: null }))]);
    const participantsActuels = new Set(((existant && existant.personnelIds) || options.personnelIds || []).map(Number));
    // Les participants déjà inscrits restent affichés même s'ils sont inactifs ou hors du site courant
    const opts = personnes.filter((p) => participantsActuels.has(p.id) || (!lectureSeule(p.secteurId) && p.modifiable !== false)).map((p) => ({ value: p.id, label: `${p.nomComplet} (${p.secteurNom || '—'})` }));
    for (const part of (existant && existant.participants) || []) if (!opts.some((o) => o.value === part.id)) opts.push({ value: part.id, label: `${part.nomComplet} (hors liste)` });
    const champs = [
      { type: 'separateur', label: 'Session' },
      { nom: 'intitule', label: 'Intitulé', type: 'texte', requis: true, maxLength: 200, pleineLargeur: true, placeholder: 'ex. Recyclage habilitation électrique B1V / B2V / BR' },
      { nom: 'habilitationTypeCode', label: 'Habilitation visée', type: 'select', options: ui.optionsListe('typesHabilitation', { vide: '— Aucune (formation sans habilitation) —' }), aide: 'Une fois la formation réalisée, l\'habilitation de chaque participant présent est créée ou renouvelée automatiquement.' },
      { nom: 'statut', label: 'Statut', type: 'select', options: optionsRh('statutsFormation', false).filter((o) => creation ? o.value !== 'annulee' : (existant.statut === 'realisee' ? o.value === 'realisee' : true)), aide: creation ? '« Réalisée » permet de saisir une formation passée (historique).' : '' },
      { nom: 'dateDebut', label: 'Date de début', type: 'date', requis: true, onChange: (v, f) => { if (v && (!f.get('dateFin') || f.get('dateFin') < v)) f.set('dateFin', v); } },
      { nom: 'dateFin', label: 'Date de fin', type: 'date' },
      { nom: 'dureeHeures', label: 'Durée (heures)', type: 'nombre', min: 0, step: '0.5' },
      { nom: 'cout', label: `Coût total HT (${devise()})`, type: 'nombre', min: 0, step: '0.01' },
      { type: 'separateur', label: 'Organisme' },
      { nom: 'organisme', label: 'Organisme de formation', type: 'texte', maxLength: 150, suggestions: refs.fournisseurs.map((f) => f.nom) },
      { nom: 'fournisseurId', label: 'Prestataire (fichier fournisseurs)', type: 'select', options: [{ value: '', label: '— Aucun —' }].concat(refs.fournisseurs.map((f) => ({ value: f.id, label: f.nom }))), onChange: (v, f) => { if (v && !f.get('organisme')) { const fo = refs.fournisseurs.find((x) => x.id === Number(v)); if (fo) f.set('organisme', fo.nom); } } },
      { nom: 'lieu', label: 'Lieu', type: 'texte', maxLength: 150 },
      Array.isArray(refs.factures) ? { nom: 'factureId', label: 'Facture associée (Achats)', type: 'select', options: [{ value: '', label: '— Aucune —' }].concat(refs.factures.map((f) => ({ value: f.id, label: `${f.numero}${f.fournisseurNom ? ' · ' + f.fournisseurNom : ''}${f.montant != null ? ' · ' + ui.formatMontant(f.montant) : ''}` }))) } : null,
      { nom: 'secteurId', label: 'Site / service organisateur', type: 'select', options: ui.optionsSecteurs({ vide: '— Service du premier participant —' }).filter((o) => o.value === '' || !lectureSeule(o.value)) },
      { type: 'separateur', label: `Participants` },
      { nom: 'personnelIds', label: 'Personnes inscrites', type: 'cases', options: opts, pleineLargeur: true, aide: opts.length ? '' : 'Aucune fiche du personnel active.' },
      { nom: 'description', label: 'Programme / objectifs', type: 'texte_long', lignes: 3 },
    ];
    const valeurs = existant
      ? Object.assign({}, existant, { habilitationTypeCode: existant.habilitationTypeCode || '', fournisseurId: existant.fournisseurId == null ? '' : existant.fournisseurId, factureId: existant.factureId == null ? '' : existant.factureId, secteurId: existant.secteurId == null ? '' : existant.secteurId, personnelIds: (existant.personnelIds || []).map(Number) })
      : { statut: 'planifiee', personnelIds: (options.personnelIds || []).map(Number), habilitationTypeCode: options.habilitationTypeCode || '', dateDebut: options.dateDebut || '' };
    ui.formModal({
      titre: creation ? 'Nouvelle formation' : `Modifier la formation — ${existant.intitule}`, taille: 'tres-large', champs, valeurs,
      submitLabel: creation ? 'Enregistrer la formation' : 'Enregistrer',
      onSubmit: async (v, modal, form) => {
        if (v.dateFin && v.dateFin < v.dateDebut) { form.erreur('dateFin', 'La date de fin précède la date de début'); return false; }
        if (v.statut === 'realisee' && (v.dateFin || v.dateDebut) > ui.aujourdhui()) { form.erreur('statut', 'Une formation future ne peut pas être réalisée'); return false; }
        if (!v.personnelIds.length && !v.secteurId) { form.erreur('secteurId', 'Choisissez le service organisateur ou au moins un participant'); return false; }
        const body = {
          intitule: v.intitule, habilitationTypeCode: v.habilitationTypeCode || null, statut: v.statut, dateDebut: v.dateDebut, dateFin: v.dateFin || v.dateDebut, dureeHeures: v.dureeHeures, cout: v.cout,
          organisme: v.organisme, fournisseurId: v.fournisseurId === '' ? null : v.fournisseurId, lieu: v.lieu, secteurId: v.secteurId === '' ? null : v.secteurId, personnelIds: v.personnelIds, description: v.description,
        };
        if (Array.isArray(refs.factures)) body.factureId = v.factureId === '' ? null : v.factureId;
        const res = creation ? await api.post('/api/rh/formations', body) : await api.put('/api/rh/formations/' + existant.id, body);
        const gen = (res.habilitationsGenerees || []).filter((g) => g.action !== 'inchangee').length;
        toast(res.statut === 'realisee' && (!existant || existant.statut !== 'realisee') && res.habilitationTypeCode ? `Formation réalisée : ${gen} habilitation(s) créée(s) ou renouvelée(s)` : `Formation « ${res.intitule} » enregistrée`, 'succes');
        if (options.apres) options.apres(res);
      },
    });
  }

  function ouvrirRealisation(f, apres) {
    const t = f.habilitationTypeCode ? typeHab(f.habilitationTypeCode) : null;
    ui.formModal({
      titre: `Déclarer la formation réalisée — ${f.intitule}`, taille: 'large',
      avant: t ? ui.alerte(frag('Chaque participant présent obtiendra ou renouvellera l\'habilitation ', el('strong', null, t.label), Number(t.dureeMois) > 0 ? ` (validité ${t.dureeMois} mois à compter de la date de fin).` : ' (sans échéance).'), 'info') : ui.alerte('Cette formation ne vise aucune habilitation : seule la réalisation est enregistrée.', 'info'),
      champs: [
        { nom: 'dateFin', label: 'Date de fin effective', type: 'date', requis: true, max: ui.aujourdhui() },
        { nom: 'presents', label: 'Participants présents', type: 'cases', pleineLargeur: true, options: (f.participants || []).map((p) => ({ value: p.id, label: p.nomComplet })) },
      ],
      valeurs: { dateFin: f.dateFin && f.dateFin <= ui.aujourdhui() ? f.dateFin : ui.aujourdhui(), presents: (f.participants || []).map((p) => p.id) },
      submitLabel: 'Déclarer réalisée',
      onSubmit: async (v) => {
        if (v.dateFin > ui.aujourdhui()) { toast('La date de fin ne peut pas être dans le futur', 'erreur'); return false; }
        const r = await api.post(`/api/rh/formations/${f.id}/realiser`, { dateFin: v.dateFin, presents: v.presents });
        const gen = (r.habilitationsGenerees || []).filter((g) => g.action !== 'inchangee');
        toast(r.habilitationTypeCode ? `Formation réalisée : ${gen.filter((g) => g.action === 'renouvelee').length} habilitation(s) renouvelée(s), ${gen.filter((g) => g.action === 'creee').length} créée(s)` : 'Formation déclarée réalisée', 'succes');
        if (apres) apres(r);
      },
    });
  }

  async function ouvrirDetailFormation(id, apres) {
    let f;
    try { f = await api.get('/api/rh/formations/' + id); } catch (e) { erreur(e); return; }
    const generees = new Map((f.habilitationsGenerees || []).map((g) => [g.personnelId, g]));
    const actions = [];
    if (ecriture('modifier', f) && f.statut === 'planifiee' && (f.dateFin || f.dateDebut) <= ui.aujourdhui()) actions.push({ label: 'Déclarer réalisée', classe: 'btn-ok', icone: 'check', onClic: () => { ouvrirRealisation(f, apres); } });
    if (ecriture('modifier', f)) actions.unshift({ label: 'Modifier', icone: 'modifier', gauche: true, onClic: () => { ouvrirFormation(f, { apres }); } });
    ui.modal({
      titre: f.intitule, taille: 'large',
      contenu: frag(
        el('div', { class: 'inline mb', style: { gap: '8px' } }, badgeRh('statutsFormation', f.statut), f.habilitationTypeCode ? ui.badgeListe('typesHabilitation', f.habilitationTypeCode) : null),
        ui.details([
          { label: 'Dates', valeur: periode(f.dateDebut, f.dateFin) },
          { label: 'Durée', valeur: f.dureeHeures != null ? ui.formatDuree(f.dureeHeures) : '' },
          { label: 'Organisme', valeur: f.organisme },
          { label: 'Lieu', valeur: f.lieu },
          { label: 'Coût total', valeur: f.cout != null ? `${ui.formatMontant(f.cout)}${f.coutParParticipant != null ? ` (${ui.formatMontant(f.coutParParticipant)} / participant)` : ''}` : '' },
          { label: 'Facture', valeur: f.factureNumero },
          { label: 'Organisateur', valeur: f.secteurId != null ? ui.cheminSecteur(f.secteurId) : '' },
          { label: 'Réalisée le', valeur: f.dateRealisation ? ui.formatDateHeure(f.dateRealisation) : '' },
        ], { colonnes: 2 }),
        f.description ? el('p', { style: { whiteSpace: 'pre-wrap' } }, f.description) : null,
        el('h3', { class: 'mt' }, `Participants (${f.nbParticipants})`),
        f.participants.length ? ui.table({
          compact: true, recherche: false, pagination: false, lignes: f.participants, onClic: (p) => GMAO.navigate('#/rh/' + p.id),
          colonnes: [
            { cle: 'nomComplet', label: 'Personne', rendu: (p) => personneCellule(p.nomComplet, p.matricule, 26) },
            { cle: 'secteurId', label: 'Service', rendu: (p) => secteurCellule(p.secteurId) },
            { cle: 'present', label: 'Présence', rendu: (p) => (p.present == null ? el('span', { class: 'texte-2' }, 'Inscrit') : p.present ? ui.badge('Présent', '#16a34a') : ui.badge('Absent', '#6b7280')) },
            { cle: 'hab', label: 'Habilitation', rendu: (p) => { const g = generees.get(p.id); if (!g) return el('span', { class: 'texte-2' }, '—'); return g.action === 'inchangee' ? el('span', { class: 'texte-2' }, 'Déjà à jour') : frag(ui.badge(g.action === 'creee' ? 'Obtenue' : 'Renouvelée', '#16a34a'), g.dateExpiration ? el('span', { class: 'texte-2 texte-petit' }, ` jusqu'au ${fmt(g.dateExpiration)}`) : null); } },
          ],
        }).el : ui.vide('Aucun participant inscrit', 'utilisateur')),
      boutons: actions.concat([{ label: 'Fermer' }]),
    });
  }

  async function supprimerPersonne(p, apres) {
    const ok = await ui.confirm({ titre: 'Supprimer la fiche du personnel', message: `Supprimer la fiche de ${p.nomComplet} (${p.matricule}) ? Si elle comporte un historique (habilitations, formations, visites, absences), elle sera désactivée au lieu d'être supprimée.`, okLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try {
      const r = await api.del('/api/rh/personnel/' + p.id);
      toast(r.desactive ? 'Fiche désactivée (historique conservé)' : 'Fiche supprimée', 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  async function effacerPersonne(p) {
    const ok = await ui.confirm({ titre: 'Effacement définitif du dossier', message: `Effacer définitivement le dossier de ${p.nomComplet} et TOUS les éléments rattachés (habilitations, visites médicales, absences) ? Cette action est irréversible (droit à l'effacement).`, okLabel: 'Effacer définitivement', danger: true });
    if (!ok) return;
    try { await api.del(`/api/rh/personnel/${p.id}?definitif=1`); toast('Dossier effacé définitivement', 'succes'); GMAO.navigate('#/rh?onglet=personnel'); } catch (e) { erreur(e); }
  }

  // ====================================================================================================
  // Onglet « Tableau de bord RH »
  // ====================================================================================================
  async function ongletTableau(nav) {
    const [t, al] = await Promise.all([api.get('/api/rh/tableau'), api.get('/api/rh/alertes')]);
    GMAO.setNavBadge(MODULE, t.demandesAValider || null);
    nav.setBadge('absences', t.demandesAValider);
    const cont = el('div');
    const temporaires = t.effectifs.parContrat.filter((c) => ['cdd', 'interim', 'apprentissage', 'stage'].includes(c.code)).reduce((s, c) => s + c.n, 0);
    const moisLib = `${MOIS[Number(t.mois.slice(5, 7)) - 1]} ${t.mois.slice(0, 4)}`;
    cont.appendChild(el('div', { class: 'rh-grille-kpi tableau' },
      ui.kpi({ label: 'Effectif actif', valeur: t.effectifs.total, icone: 'utilisateurs', detail: temporaires ? `dont ${temporaires} contrat(s) temporaire(s)` : `${t.effectifs.avecCompte} avec un compte GMAO`, onClic: () => nav.activer('personnel') }),
      ui.kpi({ label: 'Absents aujourd\'hui', valeur: t.absentsAujourdhui.length, icone: 'calendrier', couleur: '#0891b2', detail: t.effectifs.total ? `${ui.formatNombre((t.absentsAujourdhui.length / t.effectifs.total) * 100, 0)} % de l'effectif` : '', onClic: () => nav.activer('absences') }),
      ui.kpi({ label: `Absentéisme (${moisLib})`, valeur: `${ui.formatNombre(t.absenteisme.taux, 1)} %`, icone: 'rapports', couleur: t.absenteisme.taux > 5 ? '#dc2626' : t.absenteisme.taux > 3 ? '#f59e0b' : '#16a34a', detail: `${jours(t.absenteisme.joursAbsenteisme)} sur ${ui.formatNombre(t.absenteisme.joursTheoriques)} j théoriques` }),
      ui.kpi({ label: 'Demandes à valider', valeur: t.demandesAValider, icone: 'check', couleur: t.demandesAValider ? '#f59e0b' : '#16a34a', detail: t.demandesEnAttente > t.demandesAValider ? `${t.demandesEnAttente} en attente au total` : 'demandes d\'absence', onClic: () => nav.activer('absences') }),
      ui.kpi({ label: 'Habilitations expirées', valeur: t.habilitations.expirees, icone: 'alerte', couleur: t.habilitations.expirees ? '#dc2626' : '#16a34a', detail: `${t.habilitations.total} habilitation(s) suivie(s)`, onClic: () => { memo.modeHab = 'liste'; memo.habListe.etat = 'expiree'; nav.activer('habilitations'); } }),
      ui.kpi({ label: `À renouveler (≤ ${al.joursAlerte} j)`, valeur: t.habilitations.bientot, icone: 'horloge', couleur: '#f59e0b', detail: 'recyclages à planifier', onClic: () => { memo.modeHab = 'liste'; memo.habListe.etat = 'bientot'; nav.activer('habilitations'); } }),
      ui.kpi({ label: 'Visites médicales', valeur: al.visites.length, icone: 'info', couleur: al.visites.some((v) => v.etat === 'expiree') ? '#dc2626' : '#8b5cf6', detail: 'échues ou à programmer', onClic: () => { memo.alertes = 'visite'; nav.activer('tableau'); } }),
      ui.kpi({ label: `Formation ${t.formations.annee}`, valeur: ui.formatMontant(t.formations.cout), icone: 'diplome', couleur: '#16a34a', detail: `${t.formations.nbRealisees} réalisée(s) · ${t.formations.nbPlanifiees} planifiée(s)`, onClic: () => nav.activer('formations') })));

    // Alertes
    const toutes = al.habilitations.concat(al.visites, al.contrats).sort((a, b) => String(a.dateEcheance).localeCompare(String(b.dateEcheance)));
    const LIB_CAT = { habilitation: 'Habilitation', visite: 'Visite médicale', contrat: 'Fin de contrat' };
    const COUL_CAT = { habilitation: '#2563eb', visite: '#8b5cf6', contrat: '#0f766e' };
    const ONGLET_CAT = { habilitation: 'habilitations', visite: 'visites', contrat: 'identite' };
    const tableAlertes = ui.table({
      lignes: [], compact: true, recherche: 'Filtrer les alertes…', tailleParPage: 12, vide: 'Aucune alerte : habilitations, visites et contrats sont à jour.',
      onClic: (x) => GMAO.navigate(`#/rh/${x.personnelId}?onglet=${ONGLET_CAT[x.categorie]}`),
      ligneClasse: (x) => (x.etat === 'expiree' ? '' : ''),
      colonnes: [
        { cle: 'dateEcheance', label: 'Échéance', largeur: '110px', rendu: (x) => echeance(x.dateEcheance, x.joursRestants, x.etat), valeurTri: (x) => x.dateEcheance },
        { cle: 'personnelNom', label: 'Personne', rendu: (x) => personneCellule(x.personnelNom, [x.fonction, x.secteurNom].filter(Boolean).join(' · '), 26, 230) },
        { cle: 'libelle', label: 'Objet', rendu: (x) => el('div', null, badgeContour(LIB_CAT[x.categorie], COUL_CAT[x.categorie]),
          el('div', { style: { marginTop: '3px' } }, x.categorie === 'habilitation' ? x.intitule || x.libelle : x.categorie === 'contrat' ? `Contrat ${x.libelle}` : x.libelle),
          x.categorie === 'visite' && x.dateDerniere ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, `Dernière visite le ${fmt(x.dateDerniere)}`) : null), valeurTri: (x) => x.categorie + (x.libelle || '') },
        { cle: 'etat', label: 'État / action', rendu: (x) => el('div', null,
          x.categorie === 'contrat' ? ui.badge(x.etat === 'expiree' ? 'Contrat échu' : 'Fin proche', ETATS[x.etat].couleur) : x.categorie === 'visite' ? ui.badge(x.etat === 'expiree' ? 'Échue' : 'À programmer', ETATS[x.etat].couleur) : badgeEtat(x.etat),
          x.renouvellementPrevu ? el('div', { class: 'inline texte-ok texte-petit', style: { gap: '4px', marginTop: '4px', display: 'flex' } }, iconeDim('check', 13), `Formation le ${fmt(x.renouvellementPrevu.dateDebut)}`)
            : x.categorie === 'habilitation' && peutCreer() ? el('div', null, el('button', { type: 'button', class: 'btn btn-lien btn-sm', style: { paddingLeft: 0 }, onclick: (ev) => { ev.stopPropagation(); ouvrirFormation(null, { personnelIds: [x.personnelId], habilitationTypeCode: x.typeCode, apres: () => nav.activer('tableau') }); } }, icone('plus'), 'Planifier un recyclage')) : null),
        valeurTri: (x) => ({ expiree: 0, bientot: 1 }[x.etat] || 2) },
      ],
    });
    const filtres = [['toutes', 'Toutes', toutes.length], ['habilitation', 'Habilitations', al.habilitations.length], ['visite', 'Visites', al.visites.length], ['contrat', 'Contrats', al.contrats.length]];
    const groupe = el('div', { class: 'btn-groupe' });
    function filtrerAlertes() {
      groupe.querySelectorAll('.btn').forEach((b) => b.classList.toggle('actif', b.dataset.cle === memo.alertes));
      tableAlertes.maj(memo.alertes === 'toutes' ? toutes : toutes.filter((x) => x.categorie === memo.alertes));
    }
    for (const [cle, label, n] of filtres) groupe.appendChild(el('button', { type: 'button', class: 'btn btn-sm', dataset: { cle }, onclick: () => { memo.alertes = cle; filtrerAlertes(); } }, label, el('span', { class: 'badge', style: { marginLeft: '4px' } }, String(n))));
    filtrerAlertes();
    const parSite = al.parSite.length > 1 ? el('div', { class: 'inline mb', style: { gap: '8px', flexWrap: 'wrap' } }, al.parSite.map((s) => badgeContour(`${s.siteNom} : ${s.total} alerte(s)${s.expirees ? ` dont ${s.expirees} échue(s)` : ''}`, s.expirees ? '#dc2626' : '#f59e0b'))) : null;
    const carteAlertes = ui.carte(`Alertes et échéances (${toutes.length})`, frag(parSite, el('div', { class: 'texte-2 texte-petit mb' }, `Habilitations et visites échues ou arrivant à échéance sous ${al.joursAlerte} jours (paramètre « alerte avant échéance » de la configuration RH), fins de contrat.`), tableAlertes.el), { actions: groupe });

    // Absents du jour
    const absents = t.absentsAujourdhui;
    const carteAbsents = ui.carte(`Absents aujourd'hui (${absents.length})`, absents.length
      ? el('ul', { class: 'rh-liste-simple' }, absents.map((a) => el('li', { class: 'cliquable', onclick: () => GMAO.navigate(`#/rh/${a.personnelId}?onglet=absences`) },
        ui.avatar(a.nom, 30), el('div', { style: { flex: 1, minWidth: 0 } }, el('div', { class: 'texte-gras' }, a.nom), el('div', { class: 'texte-2 texte-petit' }, [a.fonction, ui.nomSecteur(a.secteurId)].filter(Boolean).join(' · '))),
        el('div', { style: { textAlign: 'right' } }, ui.badgeListe('typesAbsence', a.typeCode), el('div', { class: 'texte-2 texte-petit', style: { marginTop: '2px' } }, a.demiJournee ? DEMI[a.demiJournee] : (a.dateFin > t.date ? `jusqu'au ${fmt(a.dateFin)}` : 'aujourd\'hui'))))))
      : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Tout le monde est présent aujourd\'hui.'));

    // Effectifs
    const carteEffectifs = ui.carte('Effectifs par service', t.effectifs.parService.length
      ? ui.graphiqueBarres(t.effectifs.parService.slice(0, 10).map((s) => ({ label: s.nom, valeur: s.n, couleur: s.couleur })), { hauteur: 170 })
      : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucune personne dans l\'effectif.'));
    const maxC = Math.max(1, ...t.effectifs.parContrat.map((c) => c.n));
    const carteContrats = ui.carte('Répartition par contrat', t.effectifs.parContrat.length ? el('div', null, t.effectifs.parContrat.map((c) => el('div', { style: { marginBottom: '9px' } },
      el('div', { class: 'inline', style: { justifyContent: 'space-between', width: '100%' } }, el('span', null, c.label), el('span', { class: 'texte-gras' }, `${c.n} (${ui.formatNombre((c.n / t.effectifs.total) * 100, 0)} %)`)),
      el('div', { class: 'barre-progression', style: { marginTop: '4px' } }, el('div', { style: { width: Math.round((c.n / maxC) * 100) + '%', background: c.couleur || 'var(--primaire)' } }))))) : el('p', { class: 'texte-2' }, '—'));
    const carteAbsenteisme = ui.carte(`Absences validées — ${moisLib}`, frag(
      ui.details([
        { label: 'Jours ouvrés du mois', valeur: String(t.absenteisme.joursOuvres) },
        { label: 'Jours théoriques', valeur: `${ui.formatNombre(t.absenteisme.joursTheoriques)} j (${t.absenteisme.effectif} pers.)` },
        { label: 'Absentéisme', valeur: `${jours(t.absenteisme.joursAbsenteisme)} · ${ui.formatNombre(t.absenteisme.taux, 2)} %` },
        { label: 'Toutes absences', valeur: `${jours(t.absenteisme.joursAbsence)} · ${ui.formatNombre(t.absenteisme.tauxGlobal, 2)} %` },
      ]),
      t.absenteisme.parType.length ? el('div', { class: 'inline mt', style: { gap: '6px', flexWrap: 'wrap' } }, t.absenteisme.parType.map((p) => ui.badge(`${ui.libelle('typesAbsence', p.code)} : ${jours(p.jours)}`, ui.couleur('typesAbsence', p.code)))) : null,
      el('div', { class: 'texte-2 texte-petit mt' }, `Absentéisme : ${t.absenteisme.typesComptes.map((c) => ui.libelle('typesAbsence', c)).join(', ') || '—'} (congés, RTT et formations exclus).`)));
    cont.appendChild(el('div', { class: 'rh-deux-colonnes' }, el('div', { style: { minWidth: 0 } }, carteAlertes, carteEffectifs), el('div', { style: { minWidth: 0 } }, carteAbsents, carteContrats, carteAbsenteisme)));
    return cont;
  }

  // ====================================================================================================
  // Onglet « Personnel »
  // ====================================================================================================
  async function ongletPersonnel() {
    const f = memo.personnel;
    filtreSiteService(f);
    const cont = el('div');
    const params = () => Object.assign({ typeContratCode: f.typeContratCode, actif: f.actif === 'tous' ? '' : f.actif, habilitationTypeCode: f.habilitationTypeCode }, paramsSiteService(f.siteService));
    const compteur = el('span', { class: 'texte-2 texte-petit' });
    const tableau = ui.table({
      lignes: [], recherche: 'Rechercher (nom, matricule, fonction, e-mail…)', rechercheDans: (p) => [p.matricule, p.email, p.telephone, p.userLogin, (p.competences || []).map((c) => c.libelle).join(' ')].join(' '),
      onClic: (p) => GMAO.navigate('#/rh/' + p.id), ligneClasse: (p) => (p.actif === false ? 'inactif' : ''), triInitial: { cle: 'nom', sens: 'asc' }, vide: 'Aucune personne ne correspond aux filtres',
      colonnes: [
        { cle: 'nom', label: 'Personne', rendu: (p) => personneCellule(p.nomComplet, [p.matricule, p.fonction].filter(Boolean).join(' · '), 30, 230), valeurTri: (p) => `${p.nom} ${p.prenom}`.toLowerCase(), exportValeur: (p) => p.nomComplet },
        { cle: 'secteurChemin', label: 'Service', rendu: (p) => el('div', { style: { maxWidth: '180px' } }, el('div', null, secteurCellule(p.secteurId, p.secteurNom)), p.siteNom && p.siteNom !== p.secteurNom ? el('div', { class: 'cellule-secondaire texte-2 texte-petit', style: { paddingLeft: '16px' } }, p.siteNom) : null), valeurTri: (p) => p.secteurChemin || '', exportValeur: (p) => p.secteurChemin },
        { cle: 'typeContratCode', label: 'Contrat', rendu: (p) => el('div', null, badgeListeContour('typesContrat', p.typeContratCode), p.dateSortie ? el('div', { class: 'cellule-secondaire texte-2 texte-petit', style: { marginTop: '2px' } }, `jusqu'au ${fmt(p.dateSortie)}`) : null), exportValeur: (p) => ui.libelle('typesContrat', p.typeContratCode) },
        { cle: 'dateEntree', label: 'Entrée', rendu: (p) => (p.dateEntree ? el('div', { style: { whiteSpace: 'nowrap' } }, fmt(p.dateEntree), el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, anciennete(p.ancienneteMois))) : el('span', { class: 'texte-2' }, '—')), valeurTri: (p) => p.dateEntree || '', exportValeur: (p) => fmt(p.dateEntree) },
        { cle: 'habilitationsResume', label: 'Habilitations', rendu: (p) => resumeHabilitations(p.habilitationsResume), valeurTri: (p) => -((p.habilitationsResume.expirees * 1000) + (p.habilitationsResume.bientot * 100) + p.habilitationsResume.valides), exportValeur: (p) => `${p.habilitationsResume.valides} valides / ${p.habilitationsResume.bientot} à renouveler / ${p.habilitationsResume.expirees} expirées` },
        { cle: 'derniereVisite', label: 'Prochaine visite', rendu: (p) => { const pv = prochaineVisite(p.derniereVisite); if (!pv) return el('span', { class: 'texte-2' }, '—'); if (!pv.date) return el('span', { class: 'texte-2 texte-petit' }, pv.libelle); return el('div', null, badgeEtat(pv.etat), el('div', { class: 'cellule-secondaire texte-2 texte-petit', style: { marginTop: '2px' }, title: pv.etat === 'programmee' ? 'Visite programmée' : 'Échéance de la prochaine visite' }, fmt(pv.date))); }, valeurTri: (p) => { const pv = prochaineVisite(p.derniereVisite); return (pv && pv.date) || '9999'; }, exportValeur: (p) => { const pv = prochaineVisite(p.derniereVisite); return pv && pv.date ? fmt(pv.date) : ''; } },
        { cle: 'userLogin', label: 'Compte', aligner: 'centre', rendu: (p) => (p.userLogin ? el('span', { title: `Compte GMAO : ${p.userLogin}`, style: { color: 'var(--primaire)' } }, iconeDim('utilisateur', 17)) : el('span', { class: 'texte-2', title: 'Aucun compte GMAO lié' }, '—')), exportValeur: (p) => p.userLogin || '' },
        { cle: 'presence', label: 'Présence', rendu: (p) => (p.actif === false ? ui.badge('Inactif', '#6b7280') : p.absentAujourdhui ? ui.badge(ui.libelle('typesAbsence', p.absentAujourdhui.typeCode), ui.couleur('typesAbsence', p.absentAujourdhui.typeCode), { titre: `Absent ${periode(p.absentAujourdhui.dateDebut, p.absentAujourdhui.dateFin, p.absentAujourdhui.demiJournee)}` }) : badgeContour('Présent', '#16a34a')), valeurTri: (p) => (p.actif === false ? 2 : p.absentAujourdhui ? 1 : 0), exportValeur: (p) => (p.actif === false ? 'Inactif' : p.absentAujourdhui ? 'Absent' : 'Présent') },
      ],
      actions: [
        { icone: 'modifier', titre: 'Modifier', visible: (p) => ecriture('modifier', p), onClic: (p) => ouvrirFormulairePersonnel(p, { apres: charger }) },
        { icone: 'supprimer', titre: 'Supprimer / désactiver', classe: 'texte-danger', visible: (p) => ecriture('supprimer', p), onClic: (p) => supprimerPersonne(p, charger) },
      ],
    });
    async function charger() {
      try {
        const rows = await api.get('/api/rh/personnel', params());
        tableau.maj(rows);
        const absents = rows.filter((p) => p.absentAujourdhui && p.actif !== false).length;
        compteur.textContent = `${rows.length} personne(s)${absents ? ` · ${absents} absente(s) aujourd'hui` : ''}`;
      } catch (e) { erreur(e); }
    }
    const habOptions = [{ value: '', label: 'Toutes habilitations' }].concat(GMAO.liste('typesHabilitation').map((t) => ({ value: t.code, label: `Habilité : ${t.label}` })));
    cont.appendChild(el('div', { class: 'barre-outils' },
      selectFiltre(optionsSitesServices(), f.siteService || '', 'Site / service', (v) => { f.siteService = v; charger(); }),
      selectFiltre(ui.optionsListe('typesContrat', { vide: 'Tous les contrats' }), f.typeContratCode, 'Type de contrat', (v) => { f.typeContratCode = v; charger(); }),
      selectFiltre([{ value: '1', label: 'Actifs' }, { value: '0', label: 'Inactifs' }, { value: 'tous', label: 'Actifs et inactifs' }], f.actif, 'Statut', (v) => { f.actif = v; charger(); }),
      selectFiltre(habOptions, f.habilitationTypeCode, 'Qui est habilité ?', (v) => { f.habilitationTypeCode = v; charger(); }),
      compteur, el('span', { class: 'espace' }),
      boutonExport('personnel', params),
      peutCreer() ? ui.bouton('Nouvelle personne', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirFormulairePersonnel(null) }) : null));
    cont.appendChild(tableau.el);
    await charger();
    return cont;
  }

  // ====================================================================================================
  // Onglet « Habilitations » : matrice personnel × types (et liste)
  // ====================================================================================================
  async function ongletHabilitations() {
    const cont = el('div');
    const zone = el('div');
    const groupe = el('div', { class: 'btn-groupe' },
      el('button', { type: 'button', class: 'btn btn-sm' + (memo.modeHab === 'matrice' ? ' actif' : ''), onclick: () => { memo.modeHab = 'matrice'; basculer(); } }, icone('dashboard'), 'Matrice'),
      el('button', { type: 'button', class: 'btn btn-sm' + (memo.modeHab === 'liste' ? ' actif' : ''), onclick: () => { memo.modeHab = 'liste'; basculer(); } }, icone('liste'), 'Liste des échéances'));
    async function basculer() {
      groupe.querySelectorAll('.btn').forEach((b, i) => b.classList.toggle('actif', (i === 0) === (memo.modeHab === 'matrice')));
      ui.vider(zone); zone.appendChild(ui.chargement());
      try { const n = memo.modeHab === 'matrice' ? await rendreMatrice() : await rendreListeHabilitations(); ui.vider(zone); zone.appendChild(n); } catch (e) { ui.vider(zone); zone.appendChild(ui.alerte('Erreur : ' + e.message, 'danger')); }
    }
    cont.appendChild(el('div', { class: 'barre-outils' }, groupe, el('span', { class: 'texte-2 texte-petit' }, 'Qui peut intervenir sur quoi : habilitations électriques, CACES, travail en hauteur, SST…'), el('span', { class: 'espace' }),
      // L'export reprend les filtres affichés : état et type en mode liste, site / service en mode matrice
      boutonExport('habilitations', () => (memo.modeHab === 'liste' ? { etat: memo.habListe.etat || undefined, typeCode: memo.habListe.typeCode || undefined, actif: '1' } : Object.assign({ actif: '1' }, paramsSiteService(memo.matrice.siteService)))),
      peutCreer() ? ui.bouton('Nouvelle habilitation', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirHabilitation(null, { apres: basculer }) }) : null));
    cont.appendChild(zone);
    await basculer();
    return cont;

    async function rendreMatrice() {
      const fm = memo.matrice;
      filtreSiteService(fm);
      const out = el('div');
      const m = await api.get('/api/rh/matrice', paramsSiteService(fm.siteService));
      const corps = el('div');
      const recherche = el('input', { type: 'search', placeholder: 'Filtrer le personnel…', value: fm.recherche || '', style: { maxWidth: '240px' }, oninput: ui.debounce(() => { fm.recherche = recherche.value; dessiner(); }, 150) });
      const cbVides = el('input', { type: 'checkbox', checked: fm.masquerVides, onchange: () => { fm.masquerVides = cbVides.checked; dessiner(); } });
      const filtreActif = el('span');
      out.appendChild(el('div', { class: 'barre-outils' },
        selectFiltre(optionsSitesServices(), fm.siteService || '', 'Site / service', (v) => { fm.siteService = v; basculer(); }),
        recherche, el('label', { class: 'inline' }, cbVides, 'Masquer les types sans titulaire'), filtreActif, el('span', { class: 'espace' }),
        el('div', { class: 'rh-legende' },
          el('span', null, el('span', { class: 'rh-puce', style: { background: ETATS.valide.couleur } }), 'Valide'),
          el('span', null, el('span', { class: 'rh-puce', style: { background: ETATS.bientot.couleur } }), `À renouveler (≤ ${m.joursAlerte} j)`),
          el('span', null, el('span', { class: 'rh-puce', style: { background: ETATS.expiree.couleur } }), 'Expirée'),
          el('span', null, el('span', { class: 'rh-puce', style: { border: '1px dashed var(--bordure-2)' } }), 'Non habilité'))));
      out.appendChild(corps);
      out.appendChild(el('p', { class: 'texte-2 texte-petit mt' }, 'Chaque case indique le mois d\'échéance (MM/AA). Cliquez sur un type pour n\'afficher que les personnes habilitées, sur une case pour consulter ou saisir l\'habilitation.'));
      function dessiner() {
        ui.vider(corps); ui.vider(filtreActif);
        const s = String(fm.recherche || '').toLowerCase().trim();
        let types = m.types;
        if (fm.masquerVides) types = types.filter((t) => t.valides + t.bientot + t.expirees > 0);
        let lignes = m.personnel.filter((p) => !s || `${p.nomComplet} ${p.matricule} ${p.fonction} ${p.secteurNom}`.toLowerCase().includes(s));
        const typeF = fm.typeFiltre && m.types.find((t) => t.code === fm.typeFiltre);
        if (typeF) {
          lignes = lignes.filter((p) => p.cellules[typeF.code] && p.cellules[typeF.code].etat !== 'expiree');
          filtreActif.appendChild(el('span', { class: 'rh-filtre-actif' }, `Habilités « ${typeF.label} » : ${lignes.length}`, el('button', { type: 'button', title: 'Retirer le filtre', onclick: () => { fm.typeFiltre = ''; dessiner(); } }, '×')));
        }
        if (!m.personnel.length) { corps.appendChild(ui.vide('Aucune personne active dans votre périmètre', 'utilisateurs')); return; }
        if (!types.length) { corps.appendChild(ui.vide('Aucun type d\'habilitation à afficher (liste « typesHabilitation » de la configuration)', 'diplome')); return; }
        const thead = el('thead', null, el('tr', null, el('th', { class: 'rh-col-personne', style: { verticalAlign: 'bottom' } }, `Personnel (${lignes.length})`),
          types.map((t) => el('th', { class: 'rh-type' + (fm.typeFiltre === t.code ? ' actif' : ''), title: `${t.label}${t.dureeMois ? ` — validité ${t.dureeMois} mois` : ''}\nCliquez pour n'afficher que les personnes habilitées`, onclick: () => { fm.typeFiltre = fm.typeFiltre === t.code ? '' : t.code; dessiner(); } },
            el('div', null, el('span', { class: 'rh-puce', style: { background: t.couleur, width: '10px', height: '10px', margin: 0 } }), labelCourt(t.label))))));
        const tbody = el('tbody');
        for (const p of lignes) {
          const tr = el('tr');
          tr.appendChild(el('td', { class: 'rh-col-personne' }, el('a', { href: '#/rh/' + p.id + '?onglet=habilitations', style: { color: 'inherit', textDecoration: 'none', display: 'block' } }, personneCellule(p.nomComplet, [p.fonction, p.secteurNom].filter(Boolean).join(' · '), 24, 228))));
          for (const t of types) {
            const c = p.cellules[t.code];
            const td = el('td');
            if (c) {
              const titre = `${t.label}\n${c.intitule || ''}\nObtenue le ${fmt(c.dateObtention)}\n${c.dateExpiration ? `Expire le ${fmt(c.dateExpiration)} (${relatifJours(c.joursRestants)})` : 'Sans échéance'}`;
              const ouvrir = () => ouvrirHabilitationParId(c.id, basculer);
              td.appendChild(el('span', { class: 'rh-cellule', style: celluleLisible(ETATS[c.etat].couleur), title: titre, role: 'button', tabindex: 0, onclick: ouvrir, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ouvrir(); } } }, c.dateExpiration ? moisAnnee(c.dateExpiration) : '∞'));
            } else if (peutCreer() && !lectureSeule(p.secteurId) && p.modifiable !== false) {
              td.appendChild(el('button', { type: 'button', class: 'rh-ajout', title: `Saisir « ${t.label} » pour ${p.nomComplet}`, onclick: () => ouvrirHabilitation(null, { personnelId: p.id, personnelNom: p.nomComplet, typeCode: t.code, apres: basculer }) }, '+'));
            }
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        if (!lignes.length) tbody.appendChild(el('tr', null, el('td', { colspan: types.length + 1, class: 'tableau-vide', style: { padding: '24px', textAlign: 'center' } }, 'Aucune personne ne correspond au filtre')));
        const tfoot = el('tfoot', null, el('tr', null, el('td', { class: 'rh-col-personne' }, 'Personnes habilitées'),
          types.map((t) => { const n = lignes.filter((p) => p.cellules[t.code] && p.cellules[t.code].etat !== 'expiree').length; return el('td', { title: `${n} personne(s) habilitée(s) (valide ou à renouveler)`, style: { color: n ? 'var(--texte)' : 'var(--danger)' } }, String(n)); })));
        corps.appendChild(el('div', { class: 'rh-defilement' }, el('table', { class: 'rh-matrice' }, thead, tbody, tfoot)));
      }
      dessiner();
      return out;
    }

    async function rendreListeHabilitations() {
      const fl = memo.habListe;
      const out = el('div');
      const params = () => ({ etat: fl.etat || undefined, typeCode: fl.typeCode || undefined, actif: '1' });
      const tableau = ui.table({
        lignes: [], recherche: 'Rechercher (personne, intitulé, organisme, n°…)', rechercheDans: (h) => [h.numero, h.organisme, h.matricule].join(' '),
        onClic: (h) => ouvrirHabilitation(h, { apres: charger }), triInitial: { cle: 'dateExpiration', sens: 'asc' }, vide: 'Aucune habilitation ne correspond aux filtres',
        colonnes: [
          { cle: 'personnelNom', label: 'Personne', rendu: (h) => personneCellule(h.personnelNom, h.matricule, 26) },
          { cle: 'typeCode', label: 'Type', liste: 'typesHabilitation' },
          { cle: 'intitule', label: 'Intitulé', rendu: (h) => el('div', null, el('div', null, h.intitule), h.numero ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, `N° ${h.numero}`) : null) },
          { cle: 'organisme', label: 'Organisme' },
          { cle: 'dateObtention', label: 'Obtention', rendu: (h) => fmt(h.dateObtention), valeurTri: (h) => h.dateObtention },
          { cle: 'dateExpiration', label: 'Échéance', rendu: (h) => echeance(h.dateExpiration, h.joursRestants, h.etat), valeurTri: (h) => h.dateExpiration || '9999', exportValeur: (h) => fmt(h.dateExpiration) },
          { cle: 'etat', label: 'État', rendu: (h) => el('div', null, badgeEtat(h.etat), h.renouvellementPrevu ? el('div', { class: 'cellule-secondaire texte-ok texte-petit', style: { marginTop: '2px' } }, `Formation le ${fmt(h.renouvellementPrevu.dateDebut)}`) : null), valeurTri: (h) => ({ expiree: 0, bientot: 1, valide: 2, remplacee: 3 }[h.etat]), exportValeur: (h) => (ETATS[h.etat] || {}).label },
          { cle: 'nbDocuments', label: 'Pièces', aligner: 'centre', rendu: (h) => (h.nbDocuments ? el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: (ev) => { ev.stopPropagation(); ouvrirDocumentsHabilitation(h, charger); } }, icone('piece_jointe'), String(h.nbDocuments)) : el('span', { class: 'texte-2' }, '—')) },
        ],
        actions: [
          { icone: 'modifier', titre: 'Modifier', visible: (h) => ecriture('modifier', h), onClic: (h) => ouvrirHabilitation(h, { apres: charger }) },
          { icone: 'piece_jointe', titre: 'Pièces justificatives', onClic: (h) => ouvrirDocumentsHabilitation(h, charger) },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (h) => ecriture('supprimer', h), onClic: (h) => supprimerHabilitation(h, charger) },
        ],
      });
      async function charger() { try { tableau.maj(await api.get('/api/rh/habilitations', params())); } catch (e) { erreur(e); } }
      out.appendChild(el('div', { class: 'barre-outils' },
        selectFiltre([{ value: '', label: 'Tous les états' }, { value: 'expiree', label: 'Expirées' }, { value: 'bientot', label: 'À renouveler' }, { value: 'expiree,bientot', label: 'Expirées et à renouveler' }, { value: 'valide', label: 'Valides' }], fl.etat, 'État', (v) => { fl.etat = v; charger(); }),
        selectFiltre(ui.optionsListe('typesHabilitation', { vide: 'Tous les types' }), fl.typeCode, 'Type', (v) => { fl.typeCode = v; charger(); })));
      out.appendChild(tableau.el);
      await charger();
      return out;
    }
  }
  async function ouvrirHabilitationParId(id, apres) {
    try {
      const h = await api.get('/api/rh/habilitations/' + id);
      if (ecriture('modifier', h)) ouvrirHabilitation(h, { apres });
      else {
        ui.modal({ titre: h.intitule, taille: 'petite', contenu: frag(el('div', { class: 'inline mb', style: { gap: '8px' } }, ui.badgeListe('typesHabilitation', h.typeCode), badgeEtat(h.etat)), ui.details([
          { label: 'Personne', valeur: h.personnelNom }, { label: 'Organisme', valeur: h.organisme }, { label: 'N°', valeur: h.numero },
          { label: 'Obtention', valeur: fmt(h.dateObtention) }, { label: 'Échéance', valeur: h.dateExpiration ? `${fmt(h.dateExpiration)} (${relatifJours(h.joursRestants)})` : 'Sans échéance' }, { label: 'Commentaire', valeur: h.commentaire }])),
        boutons: [h.nbDocuments ? { label: `Pièces jointes (${h.nbDocuments})`, icone: 'piece_jointe', gauche: true, onClic: () => { ouvrirDocumentsHabilitation(h); } } : null, { label: 'Fermer' }] });
      }
    } catch (e) { erreur(e); }
  }
  async function supprimerHabilitation(h, apres) {
    if (!(await ui.confirm({ titre: 'Supprimer l\'habilitation', message: `Supprimer « ${h.intitule} » de ${h.personnelNom} et ses pièces justificatives ?`, okLabel: 'Supprimer', danger: true }))) return;
    try { await api.del('/api/rh/habilitations/' + h.id); toast('Habilitation supprimée', 'succes'); if (apres) apres(); } catch (e) { erreur(e); }
  }

  // ====================================================================================================
  // Onglet « Formations »
  // ====================================================================================================
  async function ongletFormations() {
    const ff = memo.formations;
    const cont = el('div');
    const annee = String(new Date().getFullYear());
    if (!ff.annee) ff.annee = annee;
    const kpis = el('div', { class: 'rh-grille-kpi' });
    const tableau = ui.table({
      lignes: [], recherche: 'Rechercher (intitulé, organisme, participant…)', rechercheDans: (f) => [f.organisme, f.lieu, f.participants.map((p) => p.nomComplet).join(' ')].join(' '),
      onClic: (f) => ouvrirDetailFormation(f.id, charger), triInitial: { cle: 'dateDebut', sens: 'desc' }, vide: 'Aucune formation ne correspond aux filtres',
      ligneClasse: (f) => (f.statut === 'annulee' ? 'inactif' : ''),
      colonnes: [
        { cle: 'dateDebut', label: 'Dates', rendu: (f) => el('div', { style: { whiteSpace: 'nowrap' } }, periode(f.dateDebut, f.dateFin)), valeurTri: (f) => f.dateDebut, exportValeur: (f) => periode(f.dateDebut, f.dateFin) },
        { cle: 'intitule', label: 'Formation', largeur: '34%', rendu: (f) => el('div', null, el('div', { class: 'cellule-principale' }, f.intitule), el('div', { class: 'cellule-secondaire' }, f.organisme || '')) },
        { cle: 'habilitationTypeCode', label: 'Habilitation visée', rendu: (f) => badgeHab(f.habilitationTypeCode), exportValeur: (f) => f.habilitationLibelle },
        { cle: 'nbParticipants', label: 'Participants', rendu: (f) => el('div', { title: f.participants.map((p) => p.nomComplet).join('\n') }, el('div', { class: 'texte-gras' }, String(f.nbParticipants)), el('div', { class: 'cellule-secondaire texte-2 texte-petit', style: { maxWidth: '170px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, f.participants.map((p) => p.nomComplet).join(', '))), valeurTri: (f) => f.nbParticipants, exportValeur: (f) => f.participants.map((p) => p.nomComplet).join(', ') },
        { cle: 'dureeHeures', label: 'Durée', aligner: 'droite', rendu: (f) => (f.dureeHeures != null ? ui.formatDuree(f.dureeHeures) : '—'), valeurTri: (f) => Number(f.dureeHeures) || 0 },
        { cle: 'cout', label: 'Coût', aligner: 'droite', rendu: (f) => el('span', { style: { whiteSpace: 'nowrap' } }, f.cout != null ? ui.formatMontant(f.cout) : '—'), valeurTri: (f) => Number(f.cout) || 0, exportValeur: (f) => (f.cout == null ? '' : String(f.cout).replace('.', ',')) },
        { cle: 'statut', label: 'Statut', rendu: (f) => badgeRh('statutsFormation', f.statut), valeurTri: (f) => (itemRh('statutsFormation', f.statut) || {}).ordre || 9, exportValeur: (f) => libelleRh('statutsFormation', f.statut) },
      ],
      actions: [
        { icone: 'voir', titre: 'Détail', onClic: (f) => ouvrirDetailFormation(f.id, charger) },
        { icone: 'check', titre: 'Déclarer réalisée', classe: 'texte-ok', visible: (f) => f.statut === 'planifiee' && ecriture('modifier', f) && (f.dateFin || f.dateDebut) <= ui.aujourdhui(), onClic: (f) => ouvrirRealisation(f, charger) },
        { icone: 'modifier', titre: 'Modifier', visible: (f) => ecriture('modifier', f), onClic: (f) => ouvrirFormation(f, { apres: charger }) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (f) => ecriture('supprimer', f) && f.statut !== 'realisee', onClic: async (f) => {
          if (!(await ui.confirm({ titre: 'Supprimer la formation', message: `Supprimer « ${f.intitule} » du ${fmt(f.dateDebut)} ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { await api.del('/api/rh/formations/' + f.id); toast('Formation supprimée', 'succes'); charger(); } catch (e) { erreur(e); }
        } },
      ],
    });
    async function charger() {
      try {
        const rows = await api.get('/api/rh/formations', { statut: ff.statut || undefined, annee: ff.annee === 'toutes' ? undefined : ff.annee });
        tableau.maj(rows);
        const actives = rows.filter((f) => f.statut !== 'annulee');
        const realisees = actives.filter((f) => f.statut === 'realisee');
        const heures = realisees.reduce((s, f) => s + (Number(f.dureeHeures) || 0) * ((f.participants || []).filter((p) => p.present !== false).length || 0), 0);
        const prochaine = actives.filter((f) => f.statut === 'planifiee' && f.dateDebut >= ui.aujourdhui()).sort((a, b) => a.dateDebut.localeCompare(b.dateDebut))[0];
        ui.vider(kpis);
        kpis.appendChild(ui.kpi({ label: 'Formations planifiées', valeur: actives.filter((f) => f.statut === 'planifiee').length, icone: 'calendrier', detail: prochaine ? `prochaine le ${fmt(prochaine.dateDebut)}` : 'aucune session à venir' }));
        kpis.appendChild(ui.kpi({ label: 'Formations réalisées', valeur: realisees.length, icone: 'check', couleur: '#16a34a', detail: `${realisees.reduce((s, f) => s + (f.participants || []).filter((p) => p.present !== false).length, 0)} stagiaire(s) formé(s)` }));
        kpis.appendChild(ui.kpi({ label: 'Heures-stagiaires', valeur: ui.formatNombre(heures, 0), icone: 'horloge', couleur: '#8b5cf6', detail: 'formations réalisées' }));
        kpis.appendChild(ui.kpi({ label: 'Budget formation', valeur: ui.formatMontant(actives.reduce((s, f) => s + (Number(f.cout) || 0), 0)), icone: 'euro', couleur: '#0891b2', detail: `dont ${ui.formatMontant(realisees.reduce((s, f) => s + (Number(f.cout) || 0), 0))} réalisé` }));
      } catch (e) { erreur(e); }
    }
    const annees = [];
    for (let a = Number(annee) + 1; a >= Number(annee) - 4; a--) annees.push({ value: String(a), label: `Année ${a}` });
    annees.push({ value: 'toutes', label: 'Toutes les années' });
    cont.appendChild(kpis);
    cont.appendChild(el('div', { class: 'barre-outils' },
      selectFiltre(annees, ff.annee, 'Année', (v) => { ff.annee = v; charger(); }),
      selectFiltre(optionsRh('statutsFormation', 'Tous les statuts'), ff.statut, 'Statut', (v) => { ff.statut = v; charger(); }),
      el('span', { class: 'espace' }),
      boutonExport('formations', () => ({ statut: ff.statut || undefined, annee: ff.annee === 'toutes' ? undefined : ff.annee })),
      peutCreer() ? ui.bouton('Nouvelle formation', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirFormation(null, { apres: charger }) }) : null));
    cont.appendChild(tableau.el);
    await charger();
    return cont;
  }

  // ====================================================================================================
  // Onglet « Absences » : demandes à valider + calendrier mensuel par personne
  // ====================================================================================================
  async function ongletAbsences(nav) {
    const fa = memo.absences;
    filtreSiteService(fa);
    if (!fa.mois) fa.mois = ui.aujourdhui().slice(0, 7);
    const cont = el('div');
    const zoneValider = el('div');
    const zoneCal = el('div');
    const zoneListe = el('div');
    const titreMois = el('div', { style: { fontSize: '17px', fontWeight: 600, minWidth: '170px', textAlign: 'center', textTransform: 'capitalize' } });
    const recharger = () => { chargerValider(); chargerCalendrier(); };
    const changerMois = (n) => { fa.mois = ajouterMois(fa.mois + '-01', n).slice(0, 7); chargerCalendrier(); };
    const cbAttente = el('input', { type: 'checkbox', checked: fa.attente, onchange: () => { fa.attente = cbAttente.checked; chargerCalendrier(); } });
    const cbTous = el('input', { type: 'checkbox', checked: fa.tous, onchange: () => { fa.tous = cbTous.checked; chargerCalendrier(); } });

    async function chargerValider() {
      try {
        const rows = await api.get('/api/rh/absences', { aValider: '1' });
        GMAO.setNavBadge(MODULE, rows.length || null);
        nav.setBadge('absences', rows.length);
        ui.vider(zoneValider);
        if (!rows.length) return;
        zoneValider.appendChild(ui.carte(`Demandes à valider (${rows.length})`, ui.table({
          lignes: rows, compact: true, recherche: false, pagination: false, triInitial: { cle: 'dateDebut', sens: 'asc' },
          onClic: (a) => ouvrirDetailAbsence(a, recharger),
          colonnes: [
            { cle: 'personnelNom', label: 'Personne', rendu: (a) => personneCellule(a.personnelNom, a.matricule, 26) },
            { cle: 'typeCode', label: 'Type', rendu: (a) => ui.badge(a.typeLibelle, a.typeCouleur) },
            { cle: 'dateDebut', label: 'Période', rendu: (a) => periode(a.dateDebut, a.dateFin, a.demiJournee), valeurTri: (a) => a.dateDebut },
            { cle: 'nbJours', label: 'Jours ouvrés', aligner: 'droite', rendu: (a) => jours(a.nbJours) },
            { cle: 'createdAt', label: 'Demandée', rendu: (a) => el('div', null, el('div', null, ui.relatif(a.createdAt)), el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, a.demandeurNom)) },
            { cle: 'commentaire', label: 'Commentaire', rendu: (a) => el('span', { class: 'texte-petit' }, a.commentaire || '') },
            { cle: 'decision', label: '', tri: false, rendu: (a) => el('div', { class: 'inline', style: { gap: '6px', justifyContent: 'flex-end', flexWrap: 'nowrap' } },
              el('button', { type: 'button', class: 'btn btn-sm btn-ok', onclick: (ev) => { ev.stopPropagation(); deciderAbsence(a, 'valider', recharger); } }, icone('check'), 'Valider'),
              el('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: (ev) => { ev.stopPropagation(); deciderAbsence(a, 'refuser', recharger); } }, icone('fermer'), 'Refuser')) },
          ],
        }).el, { classe: 'carte-alerte' }));
      } catch (e) { erreur(e); }
    }

    async function chargerCalendrier() {
      const du = fa.mois + '-01';
      const au = ajouterJours(ajouterMois(du, 1), -1);
      titreMois.textContent = `${MOIS[Number(fa.mois.slice(5, 7)) - 1]} ${fa.mois.slice(0, 4)}`;
      ui.vider(zoneCal); zoneCal.appendChild(ui.chargement());
      let personnes; let absences;
      try {
        const ps = paramsSiteService(fa.siteService);
        [personnes, absences] = await Promise.all([
          api.get('/api/rh/personnel', Object.assign({ actif: '1' }, ps)),
          api.get('/api/rh/absences', Object.assign({ du, au, statut: fa.attente ? 'validee,demandee' : 'validee', typeCode: fa.typeCode || undefined }, ps)),
        ]);
      } catch (e) { ui.vider(zoneCal); zoneCal.appendChild(ui.alerte('Erreur : ' + e.message, 'danger')); return; }
      const parPers = new Map();
      for (const a of absences) { if (!parPers.has(a.personnelId)) parPers.set(a.personnelId, []); parPers.get(a.personnelId).push(a); }
      const lignes = fa.tous ? personnes : personnes.filter((p) => parPers.has(p.id));
      for (const a of absences) if (!lignes.some((p) => p.id === a.personnelId) && !personnes.some((p) => p.id === a.personnelId)) lignes.push({ id: a.personnelId, nomComplet: a.personnelNom, fonction: '', secteurId: a.secteurId, inactif: true });
      const nbJ = joursEntre(du, au) + 1;
      const auj = ui.aujourdhui();
      const jourss = Array.from({ length: nbJ }, (_, i) => ajouterJours(du, i));
      const thead = el('thead', null, el('tr', null, el('th', { class: 'rh-col-personne' }, `Personnel (${lignes.length})`),
        jourss.map((d) => { const fe = ferie(d); const we = jourSemaine(d) % 6 === 0; return el('th', { class: (we || fe ? 'we ' : '') + (d === auj ? 'auj' : ''), title: `${fmt(d)}${fe ? ' — ' + fe : ''}` }, el('div', null, JOURS_INIT[jourSemaine(d)]), el('div', { class: 'rh-num' }, String(Number(d.slice(8))))); })));
      const tbody = el('tbody');
      const creerPossible = peutCreer();
      for (const p of lignes) {
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'rh-col-personne' }, el('a', { href: `#/rh/${p.id}?onglet=absences`, style: { color: 'inherit', textDecoration: 'none', display: 'block' } }, personneCellule(p.nomComplet, [p.fonction, ui.nomSecteur(p.secteurId)].filter(Boolean).join(' · '), 26, 228))));
        const abs = parPers.get(p.id) || [];
        for (const d of jourss) {
          const fe = ferie(d); const we = jourSemaine(d) % 6 === 0;
          const a = abs.find((x) => x.dateDebut <= d && x.dateFin >= d);
          const td = el('td', { class: (we || fe ? 'we ' : '') + (d === auj ? 'auj ' : '') });
          if (a) {
            const attente = a.statut === 'demandee';
            const c = a.typeCouleur || '#6b7280';
            let fond = c;
            if (a.demiJournee) fond = a.demiJournee === 'matin' ? `linear-gradient(90deg, ${c} 50%, transparent 50%)` : `linear-gradient(90deg, transparent 50%, ${c} 50%)`;
            if (attente) fond = `repeating-linear-gradient(135deg, ${c} 0 4px, transparent 4px 8px)`;
            const debut = a.dateDebut === d || d === du; const fin = a.dateFin === d || d === au;
            td.appendChild(el('span', {
              class: 'rh-bloc' + (debut ? ' debut' : '') + (fin ? ' fin' : ''),
              style: { background: fond, opacity: (we || fe) && !a.demiJournee ? '0.55' : '1', boxShadow: attente ? `inset 0 0 0 1.5px ${c}` : '' },
              title: `${a.personnelNom}\n${a.typeLibelle}${attente ? ' (en attente de validation)' : ''}\n${periode(a.dateDebut, a.dateFin, a.demiJournee)} — ${jours(a.nbJours)} ouvré(s)${a.commentaire ? '\n' + a.commentaire : ''}`,
              onclick: (ev) => { ev.stopPropagation(); ouvrirDetailAbsence(a, recharger); },
            }));
          } else if (creerPossible && !p.inactif && !lectureSeule(p.secteurId) && p.modifiable !== false) {
            td.classList.add('rh-cliquable');
            td.title = `Saisir une absence pour ${p.nomComplet} le ${fmt(d)}`;
            td.addEventListener('click', () => ouvrirAbsence(null, { personnelId: p.id, personnelNom: p.nomComplet, date: d, apres: recharger }));
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      if (!lignes.length) tbody.appendChild(el('tr', null, el('td', { colspan: nbJ + 1, style: { padding: '28px', textAlign: 'center', color: 'var(--texte-2)' } }, fa.tous ? 'Aucune personne dans ce périmètre' : 'Aucune absence ce mois-ci. Cochez « Afficher tout le personnel » pour saisir une absence.')));
      ui.vider(zoneCal);
      zoneCal.appendChild(el('div', { class: 'rh-defilement', style: { maxHeight: 'none' } }, el('table', { class: 'rh-cal' }, thead, tbody)));
      // Liste détaillée du mois
      ui.vider(zoneListe);
      zoneListe.appendChild(ui.carte(`Absences du mois (${absences.length})`, ui.table({
        lignes: absences, compact: true, recherche: absences.length > 8 ? 'Rechercher…' : false, triInitial: { cle: 'dateDebut', sens: 'asc' }, vide: 'Aucune absence sur la période',
        // Pas d'export de ce tableau dans le navigateur : l'export CSV du mois passe par le serveur (droit rh › exporter, journalisé)
        onClic: (a) => ouvrirDetailAbsence(a, recharger),
        colonnes: [
          { cle: 'personnelNom', label: 'Personne', rendu: (a) => el('span', { class: 'cellule-principale' }, a.personnelNom), exportValeur: (a) => a.personnelNom },
          { cle: 'typeCode', label: 'Type', rendu: (a) => ui.badge(a.typeLibelle, a.typeCouleur), exportValeur: (a) => a.typeLibelle },
          { cle: 'dateDebut', label: 'Période', rendu: (a) => periode(a.dateDebut, a.dateFin, a.demiJournee), valeurTri: (a) => a.dateDebut, exportValeur: (a) => periode(a.dateDebut, a.dateFin, a.demiJournee) },
          { cle: 'nbJours', label: 'Jours ouvrés', aligner: 'droite', rendu: (a) => jours(a.nbJours), exportValeur: (a) => String(a.nbJours).replace('.', ',') },
          { cle: 'statut', label: 'Statut', rendu: (a) => badgeRh('statutsAbsence', a.statut), exportValeur: (a) => libelleRh('statutsAbsence', a.statut) },
          { cle: 'valideurNom', label: 'Décision', rendu: (a) => (a.valideurNom ? el('span', { class: 'texte-petit' }, `${a.valideurNom}, ${ui.formatDate(a.dateValidation)}`) : el('span', { class: 'texte-2' }, '—')), exportValeur: (a) => a.valideurNom || '' },
          { cle: 'commentaire', label: 'Commentaire', rendu: (a) => el('span', { class: 'texte-petit' }, a.commentaire || '') },
        ],
        actions: [
          { icone: 'check', titre: 'Valider', classe: 'texte-ok', visible: (a) => a.peutDecider, onClic: (a) => deciderAbsence(a, 'valider', recharger) },
          { icone: 'modifier', titre: 'Modifier', visible: absenceModifiable, onClic: (a) => ouvrirAbsence(a, { apres: recharger }) },
          { icone: 'fermer', titre: 'Annuler l\'absence', visible: (a) => ecriture('modifier', a) && (a.statut === 'demandee' || a.statut === 'validee'), onClic: (a) => annulerAbsence(a, recharger) },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (a) => ecriture('supprimer', a), onClic: (a) => supprimerAbsence(a, recharger) },
        ],
      }).el));
    }

    const legende = el('div', { class: 'rh-legende' }, GMAO.liste('typesAbsence').map((t) => el('span', null, el('span', { class: 'rh-puce', style: { background: t.couleur || '#6b7280' } }), t.label)),
      el('span', null, el('span', { class: 'rh-puce', style: { background: 'repeating-linear-gradient(135deg, #6b7280 0 3px, transparent 3px 6px)', boxShadow: 'inset 0 0 0 1.5px #6b7280' } }), 'En attente de validation'),
      el('span', null, el('span', { class: 'rh-puce', style: { background: 'var(--fond)', border: '1px solid var(--bordure)' } }), 'Week-end / jour férié'));
    cont.appendChild(zoneValider);
    cont.appendChild(el('div', { class: 'carte', style: { padding: '12px 14px' } },
      el('div', { class: 'barre-outils', style: { marginBottom: '10px' } },
        el('div', { class: 'btn-groupe' }, el('button', { type: 'button', class: 'btn btn-sm', title: 'Mois précédent', onclick: () => changerMois(-1) }, icone('fleche_gauche')), el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { fa.mois = ui.aujourdhui().slice(0, 7); chargerCalendrier(); } }, 'Ce mois-ci'), el('button', { type: 'button', class: 'btn btn-sm', title: 'Mois suivant', onclick: () => changerMois(1) }, icone('fleche_droite'))),
        titreMois,
        selectFiltre(optionsSitesServices(), fa.siteService || '', 'Site / service', (v) => { fa.siteService = v; chargerCalendrier(); }),
        selectFiltre(ui.optionsListe('typesAbsence', { vide: 'Tous les types' }), fa.typeCode, 'Type d\'absence', (v) => { fa.typeCode = v; chargerCalendrier(); }),
        el('label', { class: 'inline' }, cbAttente, 'Inclure les demandes en attente'),
        el('label', { class: 'inline' }, cbTous, 'Afficher tout le personnel'),
        el('span', { class: 'espace' }),
        // L'export reprend les filtres du calendrier : période, site / service, type et statuts affichés
        boutonExport('absences', () => Object.assign({ du: fa.mois + '-01', au: ajouterJours(ajouterMois(fa.mois + '-01', 1), -1), typeCode: fa.typeCode || undefined, statut: fa.attente ? 'validee,demandee' : 'validee' }, paramsSiteService(fa.siteService))),
        peutCreer() ? ui.bouton('Nouvelle absence', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirAbsence(null, { apres: recharger }) }) : null),
      legende, el('div', { class: 'mt' }, zoneCal)));
    cont.appendChild(zoneListe);
    await Promise.all([chargerValider(), chargerCalendrier()]);
    return cont;
  }

  // ====================================================================================================
  // Fiche individuelle (#/rh/:id)
  // ====================================================================================================
  function ongletIdentite(p, recharger) {
    const cont = el('div');
    const urgence = p.contactUrgence || {};
    const contrat = el('span', null, badgeListeContour('typesContrat', p.typeContratCode));
    cont.appendChild(el('div', { class: 'grille grille-2' },
      ui.carte('Identité et contrat', ui.details([
        { label: 'Matricule', valeur: el('code', null, p.matricule) },
        { label: 'Nom', valeur: p.nom }, { label: 'Prénom', valeur: p.prenom },
        { label: 'Fonction', valeur: p.fonction },
        { label: 'Site', valeur: p.siteNom },
        { label: 'Service', valeur: secteurCellule(p.secteurId, p.siteNom && p.secteurChemin.startsWith(p.siteNom + ' › ') ? p.secteurChemin.slice(p.siteNom.length + 3) : p.secteurChemin) },
        { label: 'Responsable (N+1)', valeur: p.managerNom },
        { label: 'Type de contrat', valeur: contrat },
        { label: 'Date d\'entrée', valeur: p.dateEntree ? `${fmt(p.dateEntree)}${p.ancienneteMois != null ? ` (ancienneté : ${anciennete(p.ancienneteMois)})` : ''}` : '' },
        { label: 'Date de sortie', valeur: p.dateSortie ? frag(fmt(p.dateSortie), ' ', p.dateSortie < ui.aujourdhui() ? ui.badge('Échue', '#dc2626') : joursEntre(ui.aujourdhui(), p.dateSortie) <= joursAlerte() ? ui.badge(`Fin ${relatifJours(joursEntre(ui.aujourdhui(), p.dateSortie))}`, '#f59e0b') : null) : '' },
        p.coutHoraire !== undefined ? { label: 'Coût horaire chargé', valeur: p.coutHoraire != null ? `${ui.formatMontant(p.coutHoraire)} / h` : '' } : null,
        { label: 'Statut', valeur: p.actif === false ? ui.badge('Inactif', '#6b7280') : ui.badge('Actif', '#16a34a') },
        ...ui.champsPersoAffichage('personnel', p),
      ])),
      el('div', null,
        ui.carte('Coordonnées', ui.details([
          { label: 'Téléphone', valeur: p.telephone ? el('a', { href: 'tel:' + p.telephone.replace(/\s/g, '') }, p.telephone) : '' },
          { label: 'E-mail', valeur: p.email ? el('a', { href: 'mailto:' + p.email }, p.email) : '' },
          { label: 'Contact d\'urgence', valeur: urgence.nom || urgence.telephone ? frag(urgence.nom || '', urgence.telephone ? frag(' — ', el('a', { href: 'tel:' + urgence.telephone.replace(/\s/g, '') }, urgence.telephone)) : '') : '' },
        ])),
        ui.carte('Compte GMAO', p.compte ? ui.details([
          { label: 'Identifiant', valeur: GMAO.can('utilisateurs', 'voir') ? lienVue('#/utilisateurs/' + p.compte.id, p.compte.login) : el('code', null, p.compte.login) },
          { label: 'Nom du compte', valeur: p.compte.nom },
          { label: 'État', valeur: p.compte.actif ? ui.badge('Actif', '#16a34a') : ui.badge('Désactivé', '#6b7280') },
        ]) : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucun compte lié : la personne ne peut pas consulter « Mon dossier RH » et son activité de maintenance n\'est pas reliée.'),
        { actions: !p.compte && ecriture('modifier', p) ? ui.bouton('Lier un compte', { icone: 'utilisateur', classe: 'btn-sm', onClic: () => ouvrirFormulairePersonnel(p, { apres: recharger }) }) : null }))));
    const comps = (p.competences || []).slice().sort((a, b) => b.niveau - a.niveau || a.libelle.localeCompare(b.libelle, 'fr'));
    cont.appendChild(ui.carte(`Compétences (${comps.length})`, comps.length
      ? el('div', { class: 'rh-competences' }, comps.map((c) => el('div', null, el('span', null, c.libelle), niveauCompetence(c.niveau))))
      : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucune compétence renseignée.'),
    { actions: ecriture('modifier', p) ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-sm', onClic: () => ouvrirFormulairePersonnel(p, { apres: recharger }) }) : null }));
    if (p.notes) cont.appendChild(ui.carte('Notes RH', el('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, p.notes)));
    cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, `Fiche créée le ${ui.formatDateHeure(p.createdAt)}${p.createdByNom ? ' par ' + p.createdByNom : ''} · dernière modification le ${ui.formatDateHeure(p.updatedAt)}`));
    return cont;
  }

  function ongletHabilitationsPersonne(p, recharger) {
    const cont = el('div');
    const habs = p.habilitations || [];
    // Recyclage : l'habilitation la plus urgente (expirée, puis à renouveler, par échéance) est présélectionnée
    const urgence = { expiree: 0, bientot: 1 };
    const aRecycler = habs.filter((h) => h.etat in urgence).sort((a, b) => urgence[a.etat] - urgence[b.etat] || String(a.dateExpiration || '9999').localeCompare(String(b.dateExpiration || '9999')))[0] || habs.find((h) => h.etat !== 'remplacee');
    const recyclage = (h) => ouvrirFormation(null, { personnelIds: [p.id], habilitationTypeCode: h ? h.typeCode : '', apres: recharger });
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${habs.filter((h) => h.etat !== 'remplacee').length} habilitation(s) en cours · alerte ${joursAlerte()} jours avant l'échéance`),
      el('span', { class: 'espace' }),
      ecriture('creer', p) ? ui.bouton('Inscrire à un recyclage', { icone: 'diplome', classe: 'btn-sm', onClic: () => recyclage(aRecycler) }) : null,
      ecriture('creer', p) ? ui.bouton('Nouvelle habilitation', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirHabilitation(null, { personnelId: p.id, personnelNom: p.nomComplet, apres: recharger }) }) : null));
    if (!habs.length) { cont.appendChild(ui.vide('Aucune habilitation enregistrée', 'diplome')); return cont; }
    cont.appendChild(ui.table({
      lignes: habs, compact: false, recherche: habs.length > 8, pagination: false, ligneClasse: (h) => (h.etat === 'remplacee' ? 'inactif' : ''),
      onClic: (h) => (ecriture('modifier', h) ? ouvrirHabilitation(h, { apres: recharger }) : ouvrirHabilitationParId(h.id)),
      colonnes: [
        { cle: 'typeCode', label: 'Type', liste: 'typesHabilitation' },
        { cle: 'intitule', label: 'Intitulé', rendu: (h) => el('div', null, el('div', { class: 'cellule-principale' }, h.intitule), [h.numero ? `N° ${h.numero}` : '', h.formationId ? 'via formation' : ''].filter(Boolean).length ? el('div', { class: 'cellule-secondaire' }, [h.numero ? `N° ${h.numero}` : '', h.formationId ? 'obtenue / renouvelée par formation' : ''].filter(Boolean).join(' · ')) : null) },
        { cle: 'organisme', label: 'Organisme' },
        { cle: 'dateObtention', label: 'Obtention', rendu: (h) => fmt(h.dateObtention), valeurTri: (h) => h.dateObtention },
        { cle: 'dateExpiration', label: 'Échéance', rendu: (h) => echeance(h.dateExpiration, h.etat === 'remplacee' ? null : h.joursRestants, h.etat), valeurTri: (h) => h.dateExpiration || '9999' },
        { cle: 'etat', label: 'État', rendu: (h) => el('div', null, badgeEtat(h.etat), h.renouvellementPrevu && h.etat !== 'valide' ? el('div', { class: 'cellule-secondaire texte-ok texte-petit', style: { marginTop: '2px' } }, `Recyclage le ${fmt(h.renouvellementPrevu.dateDebut)}`) : null) },
        { cle: 'nbDocuments', label: 'Pièces', aligner: 'centre', rendu: (h) => (h.nbDocuments ? el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: (ev) => { ev.stopPropagation(); ouvrirDocumentsHabilitation(h, recharger); } }, icone('piece_jointe'), String(h.nbDocuments)) : el('span', { class: 'texte-2' }, '—')) },
      ],
      actions: [
        { icone: 'piece_jointe', titre: 'Pièces justificatives', onClic: (h) => ouvrirDocumentsHabilitation(h, recharger) },
        { icone: 'diplome', titre: 'Planifier un recyclage', visible: (h) => ecriture('creer', p) && h.etat !== 'remplacee', onClic: (h) => recyclage(h) },
        { icone: 'modifier', titre: 'Modifier', visible: (h) => ecriture('modifier', h), onClic: (h) => ouvrirHabilitation(h, { apres: recharger }) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (h) => ecriture('supprimer', h), onClic: (h) => supprimerHabilitation(h, recharger) },
      ],
    }).el);
    const historique = habs.filter((h) => (h.historique || []).length);
    if (historique.length) {
      cont.appendChild(ui.carte('Historique des renouvellements', el('ul', { class: 'chronologie' }, historique.flatMap((h) => h.historique.slice().reverse().map((x) => el('li', null,
        el('div', null, el('strong', null, h.intitule), ` : obtenue le ${fmt(x.dateObtention)}${x.dateExpiration ? `, valable jusqu'au ${fmt(x.dateExpiration)}` : ''}${x.organisme ? ' — ' + x.organisme : ''}${x.numero ? ` — n° ${x.numero}` : ''}`),
        // Pièces de la période renouvelée (archivées avec elle)
        (x.documents || []).length ? el('div', { class: 'inline texte-petit', style: { gap: '10px', flexWrap: 'wrap', marginTop: '3px' } }, x.documents.map((d) => el('a', { href: `/api/rh/habilitations/${h.id}/historique/${x.rang}/documents/${d.uid || d.index}`, target: '_blank', rel: 'noopener', title: `${tailleLisible(d.taille)} · ${fmt(d.date)}` }, icone('piece_jointe'), d.nom))) : null,
        el('div', { class: 'chrono-date' }, `Renouvelée le ${ui.formatDate(x.remplaceeLe)}`))))), { classe: 'mt' }));
    }
    return cont;
  }

  function ongletFormationsPersonne(p, recharger) {
    const cont = el('div');
    const fs = p.formations || [];
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${p.statistiques.nbFormations} formation(s) réalisée(s) · ${ui.formatDuree(p.statistiques.heuresFormation) || '0 h'} de formation`),
      el('span', { class: 'espace' }),
      ecriture('creer', p) ? ui.bouton('Inscrire à une formation', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirFormation(null, { personnelIds: [p.id], apres: recharger }) }) : null));
    if (!fs.length) { cont.appendChild(ui.vide('Aucune formation suivie ou planifiée', 'diplome')); return cont; }
    cont.appendChild(ui.table({
      lignes: fs, recherche: false, pagination: false, ligneClasse: (f) => (f.statut === 'annulee' ? 'inactif' : ''),
      onClic: (f) => (f.visible ? ouvrirDetailFormation(f.id, recharger) : toast('Formation organisée par un autre site', 'info')),
      colonnes: [
        { cle: 'dateDebut', label: 'Dates', rendu: (f) => el('span', { style: { whiteSpace: 'nowrap' } }, periode(f.dateDebut, f.dateFin)), valeurTri: (f) => f.dateDebut },
        { cle: 'intitule', label: 'Formation', rendu: (f) => el('div', null, el('div', { class: 'cellule-principale' }, f.intitule), el('div', { class: 'cellule-secondaire' }, [f.organisme, f.lieu].filter(Boolean).join(' · '))) },
        { cle: 'habilitationTypeCode', label: 'Habilitation', rendu: (f) => badgeHab(f.habilitationTypeCode) },
        { cle: 'dureeHeures', label: 'Durée', aligner: 'droite', rendu: (f) => (f.dureeHeures != null ? ui.formatDuree(f.dureeHeures) : '—') },
        { cle: 'coutParParticipant', label: 'Coût / pers.', aligner: 'droite', type: 'montant' },
        { cle: 'statut', label: 'Statut', rendu: (f) => badgeRh('statutsFormation', f.statut) },
        { cle: 'present', label: 'Présence', rendu: (f) => (f.present == null ? el('span', { class: 'texte-2' }, 'Inscrit') : f.present ? ui.badge('Présent', '#16a34a') : ui.badge('Absent', '#6b7280')) },
      ],
    }).el);
    return cont;
  }

  function ongletVisitesPersonne(p, recharger) {
    const cont = el('div');
    const vs = p.visites || [];
    cont.appendChild(ui.alerte('Données sensibles : seules la date, le type de visite et l\'avis d\'aptitude sont conservés (aucune information ni document médical).', 'info'));
    const pv = prochaineVisite(p.derniereVisite);
    cont.appendChild(el('div', { class: 'barre-outils' },
      pv && pv.date ? el('span', null, 'Prochaine visite : ', el('strong', null, fmt(pv.date)), ' ', badgeEtat(pv.etat)) : el('span', { class: 'texte-2' }, pv ? `Aucune prochaine visite planifiée (dernière le ${fmt(p.derniereVisite.date)})` : 'Aucune prochaine visite planifiée'),
      el('span', { class: 'espace' }),
      ecriture('creer', p) ? ui.bouton('Nouvelle visite', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirVisite(null, { personnelId: p.id, personnelNom: p.nomComplet, apres: recharger }) }) : null));
    if (!vs.length) { cont.appendChild(ui.vide('Aucune visite médicale enregistrée', 'info')); return cont; }
    cont.appendChild(ui.table({
      lignes: vs, recherche: false, pagination: false, ligneClasse: (v) => (v.etat === 'remplacee' ? 'inactif' : ''), triInitial: { cle: 'date', sens: 'desc' },
      // En consultation, la ligne ouvre le détail de la visite (comme les habilitations)
      onClic: (v) => (ecriture('modifier', v) ? ouvrirVisite(v, { apres: recharger }) : ouvrirDetailVisite(v)),
      colonnes: [
        { cle: 'date', label: 'Date', rendu: (v) => el('div', null, fmt(v.date), v.date > ui.aujourdhui() ? el('div', { class: 'cellule-secondaire texte-petit', style: { color: 'var(--lien)' } }, 'programmée') : null), valeurTri: (v) => v.date },
        { cle: 'type', label: 'Type', rendu: (v) => badgeRh('typesVisiteMedicale', v.type, { contour: true }) },
        { cle: 'aptitude', label: 'Aptitude', rendu: (v) => badgeRh('aptitudesMedicales', v.aptitude) },
        { cle: 'restrictions', label: 'Aménagement de poste', rendu: (v) => el('span', { class: 'texte-petit' }, v.restrictions || '') },
        { cle: 'prochaineVisite', label: 'Prochaine visite', rendu: (v) => (v.prochaineVisite ? el('div', null, fmt(v.prochaineVisite), v.etat && v.etat !== 'remplacee' ? el('div', { style: { marginTop: '2px' } }, badgeEtat(v.etat)) : null) : el('span', { class: 'texte-2' }, '—')), valeurTri: (v) => v.prochaineVisite || '' },
      ],
      actions: [
        { icone: 'modifier', titre: 'Modifier', visible: (v) => ecriture('modifier', v), onClic: (v) => ouvrirVisite(v, { apres: recharger }) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (v) => ecriture('supprimer', v), onClic: async (v) => {
          if (!(await ui.confirm({ titre: 'Supprimer la visite', message: `Supprimer la visite du ${fmt(v.date)} ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { await api.del('/api/rh/visites/' + v.id); toast('Visite supprimée', 'succes'); recharger(); } catch (e) { erreur(e); }
        } },
      ],
    }).el);
    return cont;
  }

  function ongletAbsencesPersonne(p, recharger) {
    const cont = el('div');
    const abs = p.absences || [];
    const st = p.statistiques || {};
    const parType = Object.entries(st.joursParType || {});
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', null, `Absences validées ${st.annee} : `, el('strong', null, jours(st.joursAbsenceAnnee || 0)), ' ouvrés'),
      parType.length ? el('span', { class: 'inline', style: { gap: '6px', flexWrap: 'wrap' } }, parType.map(([code, j]) => ui.badge(`${ui.libelle('typesAbsence', code)} : ${jours(j)}`, ui.couleur('typesAbsence', code)))) : null,
      el('span', { class: 'espace' }),
      ecriture('creer', p) ? ui.bouton('Nouvelle absence', { icone: 'plus', classe: 'btn-primaire btn-sm', onClic: () => ouvrirAbsence(null, { personnelId: p.id, personnelNom: p.nomComplet, apres: recharger }) }) : null));
    if (!abs.length) { cont.appendChild(ui.vide('Aucune absence enregistrée', 'calendrier')); return cont; }
    cont.appendChild(ui.table({
      lignes: abs, recherche: false, triInitial: { cle: 'dateDebut', sens: 'desc' }, ligneClasse: (a) => (a.statut === 'annulee' || a.statut === 'refusee' ? 'inactif' : ''),
      onClic: (a) => ouvrirDetailAbsence(a, recharger),
      colonnes: [
        { cle: 'dateDebut', label: 'Période', rendu: (a) => el('span', { style: { whiteSpace: 'nowrap' } }, periode(a.dateDebut, a.dateFin, a.demiJournee)), valeurTri: (a) => a.dateDebut },
        { cle: 'typeCode', label: 'Type', rendu: (a) => ui.badge(a.typeLibelle, a.typeCouleur) },
        { cle: 'nbJours', label: 'Jours ouvrés', aligner: 'droite', rendu: (a) => jours(a.nbJours) },
        { cle: 'statut', label: 'Statut', rendu: (a) => badgeRh('statutsAbsence', a.statut) },
        { cle: 'demandeurNom', label: 'Demandée par' },
        { cle: 'valideurNom', label: 'Décision', rendu: (a) => (a.valideurNom ? el('div', null, el('div', { class: 'texte-petit' }, `${a.valideurNom}, ${ui.formatDate(a.dateValidation)}`), a.motifDecision ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, a.motifDecision) : null) : el('span', { class: 'texte-2' }, '—')) },
        { cle: 'commentaire', label: 'Commentaire', rendu: (a) => el('span', { class: 'texte-petit' }, a.commentaire || '') },
      ],
      actions: [
        { icone: 'check', titre: 'Valider', classe: 'texte-ok', visible: (a) => a.peutDecider, onClic: (a) => deciderAbsence(a, 'valider', recharger) },
        { icone: 'modifier', titre: 'Modifier', visible: absenceModifiable, onClic: (a) => ouvrirAbsence(a, { apres: recharger }) },
        { icone: 'fermer', titre: 'Annuler l\'absence', visible: (a) => ecriture('modifier', a) && (a.statut === 'demandee' || a.statut === 'validee'), onClic: (a) => annulerAbsence(a, recharger) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (a) => ecriture('supprimer', a), onClic: (a) => supprimerAbsence(a, recharger) },
      ],
    }).el);
    return cont;
  }

  function ongletActivite(p) {
    const cont = el('div');
    const a = p.activite || {};
    if (!a.compteLie) {
      cont.appendChild(ui.vide('Aucun compte GMAO n\'est lié à cette fiche : l\'activité de maintenance (ordres de travail, temps passé) est calculée à partir du compte de l\'intervenant.', 'ot'));
      return cont;
    }
    cont.appendChild(el('div', { class: 'rh-grille-kpi' },
      ui.kpi({ label: 'Ordres de travail', valeur: a.nbOt, icone: 'ot', detail: 'responsable ou intervenant' }),
      ui.kpi({ label: 'OT en cours', valeur: a.nbOtOuverts, icone: 'horloge', couleur: a.nbOtOuverts ? '#f59e0b' : '#16a34a', detail: `${a.nbOtTermines} clôturé(s)` }),
      ui.kpi({ label: 'Heures (12 mois)', valeur: ui.formatDuree(a.heures12Mois) || '0 h', icone: 'rapports', couleur: '#8b5cf6', detail: 'temps passé saisi' }),
      ui.kpi({ label: 'Heures (total)', valeur: ui.formatDuree(a.heures) || '0 h', icone: 'check', couleur: '#0891b2', detail: p.coutHoraire != null ? `≈ ${ui.formatMontant(a.heures12Mois * p.coutHoraire)} sur 12 mois` : 'depuis la mise en service' })));
    if ((a.parType || []).length) cont.appendChild(ui.carte('Répartition par type d\'intervention', ui.graphiqueBarres(a.parType.map((t) => ({ label: ui.libelle('typesIntervention', t.code) || 'Non renseigné', valeur: t.n, couleur: ui.couleur('typesIntervention', t.code) })), { hauteur: 160 })));
    if (a.voirOt) {
      cont.appendChild(ui.carte(`Derniers ordres de travail (${(a.derniersOt || []).length})`, (a.derniersOt || []).length ? ui.table({
        lignes: a.derniersOt, compact: true, recherche: false, pagination: false, onClic: (o) => GMAO.navigate('#/ot/' + o.id),
        colonnes: [
          { cle: 'numero', label: 'N°', rendu: (o) => el('span', { style: { whiteSpace: 'nowrap' } }, lienVue('#/ot/' + o.id, o.numero || '#' + o.id)) },
          { cle: 'titre', label: 'Titre', rendu: (o) => el('span', { class: 'cellule-principale' }, o.titre) },
          { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
          { cle: 'statut', label: 'Statut', liste: 'statutsOT' },
          { cle: 'responsable', label: 'Rôle', rendu: (o) => (o.responsable ? 'Responsable' : 'Intervenant') },
          { cle: 'datePrevue', label: 'Prévu', type: 'date' },
          { cle: 'dateFin', label: 'Terminé', type: 'date' },
          { cle: 'heures', label: 'Heures', aligner: 'droite', rendu: (o) => (o.heures ? ui.formatDuree(o.heures) : el('span', { class: 'texte-2' }, '—')) },
        ],
      }).el : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Aucun ordre de travail dans votre périmètre.')));
    } else cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Le détail des ordres de travail nécessite le droit « Ordres de travail › Voir ».'));
    return cont;
  }

  function imprimerFiche(p) {
    const esc = ui.esc;
    const ligne = (l, v) => `<dt>${esc(l)}</dt><dd>${v == null || v === '' ? '—' : v}</dd>`;
    const tab = (entetes, lignes) => (lignes.length ? `<table><thead><tr>${entetes.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${c == null || c === '' ? '—' : c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p>—</p>');
    const u = p.contactUrgence || {};
    let html = `<h1>${esc(p.nomComplet)}</h1><div>${esc([p.matricule, p.fonction, p.secteurChemin].filter(Boolean).join(' · '))}</div>`;
    html += '<h2>Identité et contrat</h2><dl>' + ligne('Matricule', esc(p.matricule)) + ligne('Nom', esc(p.nom)) + ligne('Prénom', esc(p.prenom)) + ligne('Fonction', esc(p.fonction))
      + ligne('Site / service', esc(p.secteurChemin)) + ligne('Responsable (N+1)', esc(p.managerNom)) + ligne('Type de contrat', esc(ui.libelle('typesContrat', p.typeContratCode)))
      + ligne('Date d\'entrée', esc(fmt(p.dateEntree))) + ligne('Ancienneté', esc(anciennete(p.ancienneteMois))) + ligne('Date de sortie', esc(fmt(p.dateSortie)))
      + ligne('Téléphone', esc(p.telephone)) + ligne('E-mail', esc(p.email)) + ligne('Contact d\'urgence', esc([u.nom, u.telephone].filter(Boolean).join(' — ')))
      + ligne('Compte GMAO', esc(p.userLogin)) + ligne('Statut', p.actif === false ? 'Inactif' : 'Actif')
      + ui.champsPersoAffichage('personnel', p).map((c) => ligne(c.label, esc(c.valeur))).join('') + '</dl>';
    html += '<h2>Compétences</h2>' + tab(['Compétence', 'Niveau'], (p.competences || []).map((c) => [esc(c.libelle), `${c.niveau}/4 — ${esc(NIVEAUX[c.niveau] || '')}`]));
    html += '<h2>Habilitations en cours</h2>' + tab(['Type', 'Intitulé', 'Organisme', 'N°', 'Obtention', 'Échéance', 'État'], (p.habilitations || []).filter((h) => h.etat !== 'remplacee').map((h) => [esc(ui.libelle('typesHabilitation', h.typeCode)), esc(h.intitule), esc(h.organisme), esc(h.numero), esc(fmt(h.dateObtention)), esc(h.dateExpiration ? fmt(h.dateExpiration) : 'Sans échéance'), `<span class="badge">${esc((ETATS[h.etat] || {}).label || '')}</span>`]));
    html += '<h2>Formations</h2>' + tab(['Dates', 'Formation', 'Organisme', 'Durée', 'Statut', 'Présence'], (p.formations || []).filter((f) => f.statut !== 'annulee').map((f) => [esc(periode(f.dateDebut, f.dateFin)), esc(f.intitule), esc(f.organisme), esc(f.dureeHeures != null ? ui.formatDuree(f.dureeHeures) : ''), esc(libelleRh('statutsFormation', f.statut)), f.present == null ? 'Inscrit' : (f.present ? 'Présent' : 'Absent')]));
    html += '<h2>Suivi médical (dates et aptitude uniquement)</h2>' + tab(['Date', 'Type', 'Aptitude', 'Aménagement de poste', 'Prochaine visite'], (p.visites || []).map((v) => [esc(fmt(v.date)), esc(libelleRh('typesVisiteMedicale', v.type)), esc(libelleRh('aptitudesMedicales', v.aptitude)), esc(v.restrictions), esc(fmt(v.prochaineVisite))]));
    const annee = (p.statistiques || {}).annee;
    html += `<h2>Absences validées ${esc(annee)} (${esc(jours((p.statistiques || {}).joursAbsenceAnnee || 0))} ouvrés)</h2>` + tab(['Période', 'Type', 'Jours ouvrés'], (p.absences || []).filter((a) => a.statut === 'validee' && a.rendAbsent !== false && (String(a.dateDebut).startsWith(annee) || String(a.dateFin).startsWith(annee))).map((a) => [esc(periode(a.dateDebut, a.dateFin, a.demiJournee)), esc(a.typeLibelle), esc(jours(a.nbJours))]));
    html += '<div class="signature"><div>Le / la salarié(e)</div><div>Le responsable hiérarchique</div><div>Le service RH</div></div>';
    ui.imprimer(`Fiche individuelle — ${p.nomComplet}`, html);
  }

  async function afficherFiche(container, id) {
    let p;
    try { p = await api.get('/api/rh/personnel/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'rh', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/rh' }, { label: 'Fiche' }] }));
      container.appendChild(ui.vide(e.status === 404 ? 'Fiche du personnel introuvable ou hors de votre périmètre.' : e.message, 'alerte'));
      container.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour au personnel', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/rh?onglet=personnel') })));
      return;
    }
    const recharger = () => GMAO.navigate(location.hash.split('?')[0] === '#/rh/' + p.id ? location.hash : '#/rh/' + p.id);
    const r = p.habilitationsResume;
    container.appendChild(ui.pageEntete({
      titre: frag(p.nomComplet, ' ', badgeListeContour('typesContrat', p.typeContratCode), p.actif === false ? frag(' ', ui.badge('Inactif', '#6b7280')) : null, p.absentAujourdhui ? frag(' ', ui.badge(`Absent : ${ui.libelle('typesAbsence', p.absentAujourdhui.typeCode)}`, ui.couleur('typesAbsence', p.absentAujourdhui.typeCode))) : null),
      icone: 'rh',
      filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/rh' }, { label: 'Personnel', href: '#/rh?onglet=personnel' }, { label: p.nomComplet }],
      sousTitre: [p.matricule, p.fonction, p.secteurChemin].filter(Boolean).join(' · '),
      actions: [
        ui.bouton('Imprimer la fiche', { icone: 'imprimer', onClic: () => imprimerFiche(p) }),
        ecriture('supprimer', p) ? ui.bouton('Supprimer', { icone: 'supprimer', onClic: () => supprimerPersonne(p, (res) => (res.desactive ? recharger() : GMAO.navigate('#/rh?onglet=personnel'))) }) : null,
        GMAO.estAdmin() ? ui.bouton('Effacer', { icone: 'supprimer', classe: 'btn-danger', titre: 'Effacement définitif du dossier (droit à l\'effacement)', onClic: () => effacerPersonne(p) }) : null,
        ecriture('modifier', p) ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulairePersonnel(p, { apres: recharger }) }) : null,
      ],
    }));
    if (lectureSeule(p.secteurId)) container.appendChild(ui.alerte('Ce site est accessible en lecture seule pour vous : consultation uniquement.', 'info'));
    if (p.actif === false) container.appendChild(ui.alerte('Cette fiche est désactivée : la personne ne fait plus partie de l\'effectif (historique conservé).', 'alerte'));
    if (r.expirees) container.appendChild(ui.alerte(`${r.expirees} habilitation(s) expirée(s) : la personne ne doit plus intervenir sous ces habilitations tant qu'elles ne sont pas renouvelées.`, 'danger'));
    const v = p.derniereVisite;
    const pv = prochaineVisite(v);
    const st = p.statistiques || {};
    container.appendChild(el('div', { class: 'rh-grille-kpi serre' },
      ui.kpi({ label: 'Habilitations valides', valeur: r.valides, icone: 'diplome', couleur: '#16a34a', detail: `${r.total} en cours` }),
      ui.kpi({ label: 'À renouveler / expirées', valeur: `${r.bientot} / ${r.expirees}`, icone: 'alerte', couleur: r.expirees ? '#dc2626' : r.bientot ? '#f59e0b' : '#16a34a', detail: `alerte ${joursAlerte()} j avant l'échéance` }),
      ui.kpi({ label: 'Prochaine visite médicale', valeur: pv && pv.date ? fmt(pv.date) : '—', icone: 'info', couleur: pv && pv.etat === 'expiree' ? '#dc2626' : pv && pv.etat === 'bientot' ? '#f59e0b' : '#8b5cf6', detail: v ? `${pv.etat === 'programmee' ? 'Programmée · ' : pv.etat === 'expiree' ? 'Échue · ' : pv.etat === 'bientot' ? 'À programmer · ' : !pv.date ? 'Non planifiée · ' : ''}${libelleRh('aptitudesMedicales', v.aptitude)} · visite du ${fmt(v.date)}` : 'aucune visite' }),
      ui.kpi({ label: `Absences ${st.annee || ''}`, valeur: jours(st.joursAbsenceAnnee || 0), icone: 'calendrier', couleur: '#0891b2', detail: 'jours ouvrés validés' }),
      p.activite && p.activite.compteLie ? ui.kpi({ label: 'Maintenance (12 mois)', valeur: ui.formatDuree(p.activite.heures12Mois) || '0 h', icone: 'ot', couleur: '#f59e0b', detail: `${p.activite.nbOt} OT · ${p.activite.nbOtOuverts} en cours` }) : null));
    container.appendChild(ui.onglets([
      { cle: 'identite', label: 'Identité', icone: 'utilisateur', rendu: () => ongletIdentite(p, recharger) },
      { cle: 'habilitations', label: 'Habilitations', icone: 'diplome', badge: r.bientot + r.expirees || null, rendu: () => ongletHabilitationsPersonne(p, recharger) },
      { cle: 'formations', label: 'Formations', icone: 'check', badge: (p.formations || []).filter((f) => f.statut === 'planifiee').length || null, rendu: () => ongletFormationsPersonne(p, recharger) },
      { cle: 'visites', label: 'Visites médicales', icone: 'info', rendu: () => ongletVisitesPersonne(p, recharger) },
      { cle: 'absences', label: 'Absences', icone: 'calendrier', badge: (p.absences || []).filter((a) => a.statut === 'demandee').length || null, rendu: () => ongletAbsencesPersonne(p, recharger) },
      { cle: 'activite', label: 'Activité maintenance', icone: 'ot', rendu: () => ongletActivite(p) },
    ], { hash: true }).el);
  }

  // ====================================================================================================
  // « Mon dossier RH » (tout utilisateur authentifié)
  // ====================================================================================================
  GMAO.ouvrirMonDossierRH = async function ouvrirMonDossierRH() {
    injecterStyles();
    let d;
    try { d = await api.get('/api/rh/moi'); } catch (e) { erreur(e); return; }
    const corps = el('div');
    const modale = ui.modal({
      titre: 'Mon dossier RH', taille: 'tres-large', contenu: corps,
      boutons: [
        d.personnel && d.personnel.actif !== false ? { label: 'Demander une absence', icone: 'plus', classe: 'btn-primaire', gauche: true, fermer: false, onClic: () => { ouvrirAbsence(null, { moi: true, types: d.typesAbsence, apres: rafraichir }); return false; } } : null,
        d.personnel ? { label: 'Imprimer', icone: 'imprimer', fermer: false, onClic: () => { imprimerMonDossier(d); return false; } } : null,
        { label: 'Fermer' },
      ],
    });
    async function rafraichir() {
      try { d = await api.get('/api/rh/moi'); dessiner(); GMAO.majNotifications && GMAO.majNotifications(); } catch (e) { erreur(e); }
    }
    function dessiner() {
      ui.vider(corps);
      const p = d.personnel;
      if (!p) corps.appendChild(ui.alerte('Aucune fiche du personnel n\'est associée à votre compte. Contactez le service des ressources humaines pour la créer : vous pourrez alors consulter vos habilitations, formations et demander vos absences ici.', 'info'));
      else {
        const r = p.habilitationsResume;
        corps.appendChild(el('div', { class: 'rh-profil mb' }, ui.avatar(p.nomComplet, 54),
          el('div', { style: { flex: 1, minWidth: '220px' } }, el('div', { style: { fontSize: '18px', fontWeight: 700 } }, p.nomComplet), el('div', { class: 'texte-2' }, [p.fonction, p.secteurChemin].filter(Boolean).join(' · ')),
            el('div', { class: 'texte-2 texte-petit', style: { marginTop: '2px' } }, [`Matricule ${p.matricule}`, ui.libelle('typesContrat', p.typeContratCode), p.dateEntree ? `entrée le ${fmt(p.dateEntree)}` : '', p.managerNom ? `responsable : ${p.managerNom}` : ''].filter(Boolean).join(' · '))),
          el('div', { class: 'inline', style: { gap: '6px', flexWrap: 'wrap' } },
            ui.badge(`${r.valides} habilitation(s) valide(s)`, ETATS.valide.couleur), r.bientot ? ui.badge(`${r.bientot} à renouveler`, ETATS.bientot.couleur) : null, r.expirees ? ui.badge(`${r.expirees} expirée(s)`, ETATS.expiree.couleur) : null,
            (() => { const pv = prochaineVisite(p.derniereVisite); return pv && pv.date ? badgeContour(pv.etat === 'programmee' ? `Visite ${pv.libelle.toLowerCase()}` : `Prochaine visite : ${pv.libelle}`, '#8b5cf6') : null; })())));
      }
      const items = [];
      if (d.aValider.length) {
        items.push({ cle: 'equipe', label: 'À valider (mon équipe)', icone: 'check', badge: d.aValider.length, rendu: () => ui.table({
          lignes: d.aValider, compact: true, recherche: false, pagination: false,
          colonnes: [
            { cle: 'personnelNom', label: 'Personne', rendu: (a) => personneCellule(a.personnelNom, a.matricule, 26) },
            { cle: 'typeCode', label: 'Type', rendu: (a) => ui.badge(a.typeLibelle, a.typeCouleur) },
            { cle: 'dateDebut', label: 'Période', rendu: (a) => periode(a.dateDebut, a.dateFin, a.demiJournee) },
            { cle: 'nbJours', label: 'Jours', aligner: 'droite', rendu: (a) => jours(a.nbJours) },
            { cle: 'commentaire', label: 'Commentaire', rendu: (a) => el('span', { class: 'texte-petit' }, a.commentaire || '') },
            { cle: 'decision', label: '', tri: false, rendu: (a) => el('div', { class: 'inline', style: { gap: '6px', justifyContent: 'flex-end', flexWrap: 'nowrap' } },
              el('button', { type: 'button', class: 'btn btn-sm btn-ok', onclick: () => deciderAbsence(a, 'valider', rafraichir) }, icone('check'), 'Valider'),
              el('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => deciderAbsence(a, 'refuser', rafraichir) }, icone('fermer'), 'Refuser')) },
          ],
        }).el });
      }
      if (p) {
        items.push({ cle: 'absences', label: 'Mes absences', icone: 'calendrier', badge: d.absences.filter((a) => a.statut === 'demandee').length || null, rendu: () => (d.absences.length ? ui.table({
          lignes: d.absences, compact: true, recherche: false, tailleParPage: 10, ligneClasse: (a) => (a.statut === 'annulee' || a.statut === 'refusee' ? 'inactif' : ''),
          colonnes: [
            { cle: 'dateDebut', label: 'Période', rendu: (a) => periode(a.dateDebut, a.dateFin, a.demiJournee), valeurTri: (a) => a.dateDebut },
            { cle: 'typeCode', label: 'Type', rendu: (a) => ui.badge(a.typeLibelle, a.typeCouleur) },
            { cle: 'nbJours', label: 'Jours ouvrés', aligner: 'droite', rendu: (a) => jours(a.nbJours) },
            { cle: 'statut', label: 'Statut', rendu: (a) => el('div', null, badgeRh('statutsAbsence', a.statut), a.motifDecision ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, a.motifDecision) : null) },
            { cle: 'valideurNom', label: 'Décision', rendu: (a) => (a.valideurNom ? `${a.valideurNom}, ${ui.formatDate(a.dateValidation)}` : el('span', { class: 'texte-2' }, '—')) },
            { cle: 'annuler', label: '', tri: false, rendu: (a) => (a.annulable ? el('button', { type: 'button', class: 'btn btn-sm', onclick: () => annulerAbsence(a, rafraichir, true) }, icone('fermer'), 'Annuler') : null) },
          ],
        }).el : ui.vide('Aucune absence enregistrée. Utilisez « Demander une absence ».', 'calendrier')) });
        items.push({ cle: 'habilitations', label: 'Mes habilitations', icone: 'diplome', badge: (p.habilitationsResume.bientot + p.habilitationsResume.expirees) || null, rendu: () => (d.habilitations.length ? ui.table({
          lignes: d.habilitations, compact: true, recherche: false, pagination: false,
          colonnes: [
            { cle: 'typeCode', label: 'Type', liste: 'typesHabilitation' },
            { cle: 'intitule', label: 'Intitulé', rendu: (h) => el('div', null, h.intitule, h.numero ? el('div', { class: 'cellule-secondaire texte-2 texte-petit' }, `N° ${h.numero}`) : null) },
            { cle: 'organisme', label: 'Organisme' },
            { cle: 'dateObtention', label: 'Obtention', rendu: (h) => fmt(h.dateObtention) },
            { cle: 'dateExpiration', label: 'Échéance', rendu: (h) => echeance(h.dateExpiration, h.joursRestants, h.etat) },
            { cle: 'etat', label: 'État', rendu: (h) => badgeEtat(h.etat) },
          ],
        }).el : ui.vide('Aucune habilitation enregistrée', 'diplome')) });
        items.push({ cle: 'formations', label: 'Mes formations', icone: 'check', rendu: () => (d.formations.length ? ui.table({
          lignes: d.formations, compact: true, recherche: false, pagination: false,
          colonnes: [
            { cle: 'dateDebut', label: 'Dates', rendu: (f) => periode(f.dateDebut, f.dateFin) },
            { cle: 'intitule', label: 'Formation', rendu: (f) => el('div', null, el('div', { class: 'cellule-principale' }, f.intitule), el('div', { class: 'cellule-secondaire' }, [f.organisme, f.lieu].filter(Boolean).join(' · '))) },
            { cle: 'dureeHeures', label: 'Durée', rendu: (f) => (f.dureeHeures != null ? ui.formatDuree(f.dureeHeures) : '—') },
            { cle: 'statut', label: 'Statut', rendu: (f) => badgeRh('statutsFormation', f.statut) },
          ],
        }).el : ui.vide('Aucune formation', 'diplome')) });
        items.push({ cle: 'visites', label: 'Mes visites médicales', icone: 'info', rendu: () => frag(el('p', { class: 'texte-2 texte-petit', style: { marginTop: 0 } }, 'Seules la date, le type et l\'avis d\'aptitude sont enregistrés.'), d.visites.length ? ui.table({
          lignes: d.visites, compact: true, recherche: false, pagination: false,
          colonnes: [
            { cle: 'date', label: 'Date', rendu: (v) => fmt(v.date) },
            { cle: 'type', label: 'Type', rendu: (v) => badgeRh('typesVisiteMedicale', v.type, { contour: true }) },
            { cle: 'aptitude', label: 'Aptitude', rendu: (v) => badgeRh('aptitudesMedicales', v.aptitude) },
            { cle: 'restrictions', label: 'Aménagement', rendu: (v) => v.restrictions || '' },
            { cle: 'prochaineVisite', label: 'Prochaine visite', rendu: (v) => fmt(v.prochaineVisite) || '—' },
          ],
        }).el : ui.vide('Aucune visite enregistrée', 'info')) });
      }
      if (items.length) corps.appendChild(ui.onglets(items, { actif: d.aValider.length && !(d.personnel && d.absences.some((a) => a.statut === 'demandee')) ? 'equipe' : (p ? 'absences' : 'equipe') }).el);
    }
    dessiner();
    return modale;
  };

  function imprimerMonDossier(d) {
    const p = d.personnel;
    const esc = ui.esc;
    const tab = (entetes, lignes) => (lignes.length ? `<table><thead><tr>${entetes.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${esc(c || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p>—</p>');
    let html = `<h1>${esc(p.nomComplet)}</h1><div>${esc([p.matricule, p.fonction, p.secteurChemin].filter(Boolean).join(' · '))}</div>`;
    html += '<h2>Habilitations</h2>' + tab(['Intitulé', 'Organisme', 'Obtention', 'Échéance', 'État'], d.habilitations.map((h) => [h.intitule, h.organisme, fmt(h.dateObtention), h.dateExpiration ? fmt(h.dateExpiration) : 'Sans échéance', (ETATS[h.etat] || {}).label]));
    html += '<h2>Formations</h2>' + tab(['Dates', 'Formation', 'Organisme', 'Statut'], d.formations.map((f) => [periode(f.dateDebut, f.dateFin), f.intitule, f.organisme, libelleRh('statutsFormation', f.statut)]));
    html += '<h2>Absences</h2>' + tab(['Période', 'Type', 'Jours ouvrés', 'Statut'], d.absences.map((a) => [periode(a.dateDebut, a.dateFin, a.demiJournee), a.typeLibelle, jours(a.nbJours), libelleRh('statutsAbsence', a.statut)]));
    ui.imprimer(`Mon dossier RH — ${p.nomComplet}`, html);
  }

  // ====================================================================================================
  // Vue
  // ====================================================================================================
  async function afficherAccueil(container, query) {
    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'rh',
      sousTitre: 'Personnel, habilitations, formations, visites médicales et absences — multi-site',
      actions: [
        ui.bouton('Mon dossier RH', { icone: 'utilisateur', onClic: () => GMAO.ouvrirMonDossierRH() }),
        can('modifier') && siteAffichableEnEcriture() ? ui.bouton('Vérifier les échéances', { icone: 'cloche', titre: 'Contrôle immédiat des échéances (habilitations, visites) de votre périmètre et envoi des notifications — effectué automatiquement chaque jour pour l\'ensemble', onClic: async () => {
          try { const r = await api.post('/api/rh/verifier-echeances', {}); toast(`Vérification effectuée : ${r.expirees} expirée(s), ${r.bientot} à renouveler, ${r.visites} visite(s) échue(s) — ${r.notifications} notification(s) envoyée(s)`, r.notifications ? 'alerte' : 'succes', 6000); GMAO.majNotifications && GMAO.majNotifications(); } catch (e) { erreur(e); }
        } }) : null,
        peutCreer() ? ui.bouton('Nouvelle personne', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulairePersonnel(null) }) : null,
      ],
    }));
    if (GMAO.siteCourant() != null) container.appendChild(el('div', { class: 'texte-2 texte-petit mb' }, frag(iconeDim('site', 14), ` Affichage limité au site « ${ui.nomSecteur(GMAO.siteCourant())} » (sélecteur de site de l'en-tête).`)));
    const nav = { activer: () => {}, setBadge: () => {} };
    const tabs = ui.onglets([
      { cle: 'tableau', label: 'Tableau de bord RH', icone: 'dashboard', rendu: () => ongletTableau(nav) },
      { cle: 'personnel', label: 'Personnel', icone: 'utilisateurs', rendu: () => ongletPersonnel() },
      { cle: 'habilitations', label: 'Habilitations', icone: 'diplome', rendu: () => ongletHabilitations() },
      { cle: 'formations', label: 'Formations', icone: 'check', rendu: () => ongletFormations() },
      { cle: 'absences', label: 'Absences', icone: 'calendrier', rendu: () => ongletAbsences(nav) },
    ], { hash: true, actif: query.onglet });
    nav.activer = (cle) => tabs.activer(cle);
    nav.setBadge = (cle, v) => {
      tabs.setBadge(cle, v || '');
      const b = tabs.el.querySelector(`.onglets button[data-cle="${cle}"] .badge`);
      if (b) b.style.display = v ? '' : 'none';
    };
    container.appendChild(tabs.el);
    // Badge des demandes à valider (sans attendre l'onglet Absences)
    api.get('/api/rh/absences', { aValider: '1' }).then((rows) => { nav.setBadge('absences', rows.length); GMAO.setNavBadge(MODULE, rows.length || null); }).catch(() => {});
    if (query.nouveau === '1' && peutCreer()) ouvrirFormulairePersonnel(null);
  }

  GMAO.registerView(MODULE, {
    titre: 'Ressources humaines', icone: 'rh',
    async rendu(container, { params, query }) {
      injecterStyles();
      if (params[0]) {
        const id = Number(params[0]);
        if (!Number.isInteger(id) || id <= 0) { container.appendChild(ui.vide('Fiche du personnel introuvable', 'alerte')); return; }
        await afficherFiche(container, id);
        return;
      }
      await afficherAccueil(container, query || {});
    },
  });
})();
