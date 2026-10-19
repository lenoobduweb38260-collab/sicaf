/**
 * Vue Achats & factures : tableau de bord (KPI, à payer, retards, graphiques par mois et par catégorie),
 * commandes fournisseurs (liste filtrable, formulaire avec éditeur de lignes et totaux en direct, fiche
 * #/achats/commande/ID avec circuit de validation, réceptions partielles, impression du bon de commande),
 * factures (filtres, saisie avec calcul TVA / TTC, pièce jointe PDF avec aperçu, rapprochement, bon à payer,
 * paiement, litige ; fiche #/achats/facture/ID), échéancier hebdomadaire, commandes depuis les alertes de stock.
 *
 * Liens acceptés : #/achats?onglet=commandes|factures|echeancier, &fournisseurId=ID, &secteurId=ID, &statutCommande=,
 * &statutFacture=, &filtre=retard|apayer, &nouveau=commande|facture (&commandeId=, &otId=), &alertes=1.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'achats';
  const TAILLE_MAX_DOC = 10 * 1024 * 1024;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STATUTS_CMD_OUVERTS = ['validee', 'envoyee', 'partielle'];

  const STATUTS_CMD_ENGAGES = ['validee', 'envoyee', 'partielle', 'recue'];
  const STATUTS_CMD_IMPRIMABLES = STATUTS_CMD_ENGAGES;
  const FILTRES_CMD = () => ({ statut: '', fournisseurId: '', secteurId: '', categorieCode: '', du: '', au: '', enRetard: false });
  const FILTRES_FAC = () => ({ statut: '', fournisseurId: '', secteurId: '', categorieCode: '', du: '', au: '', echeanceDepassee: false, aPayer: false });
  /** Filtres conservés entre deux affichages, pour un utilisateur et un site affiché donnés. */
  const memo = { periode: '12m', cmd: FILTRES_CMD(), fac: FILTRES_FAC(), contexte: '' };
  /** Remet les filtres à zéro au changement d'utilisateur ou de site affiché (la page n'est pas rechargée). */
  function filtres() {
    const contexte = `${(GMAO.user || {}).id || ''}|${GMAO.siteCourant() || ''}`;
    if (memo.contexte !== contexte) { memo.contexte = contexte; memo.periode = '12m'; memo.cmd = FILTRES_CMD(); memo.fac = FILTRES_FAC(); }
    return memo;
  }
  /** Une valeur mémorisée absente des options proposées (secteur d'un autre site, fournisseur supprimé…) est abandonnée. */
  function purgerFiltre(f, cle, options) { if (f[cle] !== '' && !options.some((o) => String(o.value) === String(f[cle]))) f[cle] = ''; }
  const filtreActif = (f) => Object.values(f).some((v) => v !== '' && v !== false && v != null);

  // ----- Styles locaux (thèmes clair et sombre via les variables CSS de l'application) -------------
  (function styles() {
    if (document.getElementById('achats-styles')) return;
    const css = `
.ach-viz { --serie-1: #2a78d6; --serie-2: #eb6834; }
[data-theme="sombre"] .ach-viz { --serie-1: #3987e5; --serie-2: #d95926; }
.ach-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.ach-kpis .kpi { padding: 12px 14px; }
.ach-kpis .kpi .kpi-valeur { font-size: 20px; white-space: nowrap; }
.ach-kpis.k3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ach-kpis.k4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 1100px) { .ach-kpis.k3, .ach-kpis.k4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .ach-kpis.k3, .ach-kpis.k4 { grid-template-columns: 1fr; } }
.ach-liste table.tableau td { vertical-align: top; }
.ach-liste table.tableau td .nowrap, .ach-liste table.tableau td.num { white-space: nowrap; }
.ach-liste .ach-objet { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1500px) { .ach-liste th.ach-col-secondaire, .ach-liste td.ach-col-secondaire { display: none; } }
.ach-bulle .ach-bulle-serie { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.ach-recherche-article { position: relative; flex: 1; min-width: 260px; max-width: 460px; }
.ach-recherche-article input { width: 100%; }
.ach-suggestions { position: absolute; left: 0; right: 0; top: 100%; z-index: 20; max-height: 280px; overflow: auto; background: var(--surface); border: 1px solid var(--bordure-2); border-radius: 6px; box-shadow: var(--ombre-2); margin-top: 2px; }
.ach-suggestion { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: var(--texte); padding: 6px 10px; font-size: 13px; cursor: pointer; border-bottom: 1px solid var(--bordure); }
.ach-suggestion:last-child { border-bottom: 0; }
.ach-suggestion:hover, .ach-suggestion.actif { background: var(--primaire-clair); }
.ach-suggestion .s { display: block; font-size: 11.5px; color: var(--texte-2); }
.ach-lignes input.invalide { border-color: var(--danger); box-shadow: 0 0 0 2px rgba(220, 38, 38, .15); }
.ach-lignes .ach-erreur { font-size: 11.5px; color: var(--danger); margin-top: 2px; text-align: right; }
.ach-scan { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ach-scan input { max-width: 280px; }
.ach-scan .ach-scan-info { font-size: 12.5px; color: var(--texte-2); }
.ach-scan .ach-scan-info.ko { color: var(--danger); }
.ach-scan .ach-scan-info.ok { color: var(--ok); }
.ach-groupe-kpi { font-size: 12px; color: var(--texte-2); text-transform: uppercase; letter-spacing: .4px; margin: 2px 0 6px; }
.alerte a.ach-lien-alerte { color: inherit; text-decoration: underline; font-weight: 600; }
.ach-pdf-repli { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 34px 16px; border: 1px dashed var(--bordure-2); border-radius: 8px; background: var(--surface-2); text-align: center; color: var(--texte-2); }
.ach-etapes { display: flex; align-items: center; gap: 0; margin: 0 0 16px; flex-wrap: wrap; row-gap: 8px; }
.ach-etape { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--texte-2); }
.ach-etape .ach-puce { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--bordure-2); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 11px; background: var(--surface); flex-shrink: 0; }
.ach-etape .ach-puce svg { width: 13px; height: 13px; }
.ach-etape.faite .ach-puce { background: var(--ok); border-color: var(--ok); color: #fff; }
.ach-etape.courante .ach-puce { border-color: var(--primaire); color: var(--primaire); box-shadow: 0 0 0 3px var(--primaire-clair); }
.ach-etape.courante { color: var(--texte); font-weight: 600; }
.ach-etape.echec .ach-puce { background: var(--danger); border-color: var(--danger); color: #fff; }
.ach-etape.echec { color: var(--danger); font-weight: 600; }
.ach-trait { width: 36px; height: 2px; background: var(--bordure-2); margin: 0 8px; flex-shrink: 0; }
.ach-trait.fait { background: var(--ok); }
.ach-lignes { width: 100%; border-collapse: collapse; font-size: 13px; }
.ach-lignes th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .3px; color: var(--texte-2); font-weight: 600; padding: 6px 6px; border-bottom: 1px solid var(--bordure); background: var(--surface-2); white-space: nowrap; }
.ach-lignes td { padding: 5px 6px; border-bottom: 1px solid var(--bordure); vertical-align: top; }
.ach-lignes td.num, .ach-lignes th.num { text-align: right; font-variant-numeric: tabular-nums; }
.ach-lignes input, .ach-lignes select { padding: 5px 7px; font-size: 13px; }
.ach-lignes .ach-info { font-size: 11.5px; color: var(--texte-2); margin-top: 2px; }
.ach-lignes tfoot td { border-bottom: 0; }
.ach-totaux { display: grid; grid-template-columns: auto auto; gap: 4px 18px; justify-content: end; margin-top: 10px; font-size: 13.5px; font-variant-numeric: tabular-nums; }
.ach-totaux .lib { color: var(--texte-2); text-align: right; }
.ach-totaux .val { text-align: right; font-weight: 600; min-width: 110px; }
.ach-totaux .ttc { font-size: 16px; color: var(--texte); }
.ach-progression { display: flex; align-items: center; gap: 8px; min-width: 96px; }
.ach-progression .barre-progression { flex: 1; min-width: 50px; }
.ach-progression span { font-size: 12px; color: var(--texte-2); min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.ach-semaine { border-left: 4px solid var(--primaire); }
.ach-semaine.retard { border-left-color: var(--danger); }
.ach-semaine.courante { border-left-color: var(--alerte); }
.ach-apercu { width: 100%; height: 560px; border: 1px solid var(--bordure); border-radius: 6px; background: var(--fond); display: block; }
.ach-apercu-img { max-width: 100%; max-height: 560px; border: 1px solid var(--bordure); border-radius: 6px; display: block; margin: 0 auto; background: #fff; }
.ach-docs { display: flex; flex-direction: column; gap: 6px; }
.ach-doc { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--bordure); border-radius: 6px; background: var(--surface-2); }
.ach-doc.actif { border-color: var(--primaire); box-shadow: 0 0 0 2px var(--primaire-clair); }
.ach-doc .ach-doc-nom { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ach-legende { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--texte-2); }
.ach-legende span { display: inline-flex; align-items: center; gap: 6px; }
.ach-legende i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.ach-graph { position: relative; }
.ach-graph svg { display: block; width: 100%; height: auto; overflow: visible; }
.ach-graph .ach-bulle { position: absolute; pointer-events: none; background: var(--surface); color: var(--texte); border: 1px solid var(--bordure-2); border-radius: 6px; box-shadow: var(--ombre-2); padding: 7px 10px; font-size: 12px; white-space: nowrap; z-index: 5; display: none; }
.ach-graph .ach-bulle b { display: block; margin-bottom: 3px; }
.ach-hbar { display: grid; grid-template-columns: minmax(120px, 34%) 1fr auto; align-items: center; gap: 10px; padding: 5px 4px; font-size: 13px; border-radius: 6px; }
.ach-hbar .piste { height: 10px; background: var(--fond-2); border-radius: 5px; overflow: hidden; }
.ach-hbar .piste i { display: block; height: 100%; border-radius: 5px; }
.ach-hbar .val { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.ach-hbar .lib { overflow: hidden; display: flex; align-items: center; gap: 6px; min-width: 0; }
.ach-hbar .lib .ach-hbar-texte { min-width: 0; overflow: hidden; }
.ach-hbar .lib .ach-hbar-texte > div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ach-mini { display: flex; flex-direction: column; }
.ach-mini a, .ach-mini div.ligne { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 7px 6px; border-bottom: 1px solid var(--bordure); color: var(--texte); text-decoration: none; font-size: 13px; }
.ach-mini a:last-child { border-bottom: 0; }
.ach-mini a:hover { background: var(--surface-2); }
.ach-mini .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ach-mini .s { font-size: 12px; color: var(--texte-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ach-mini .d { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ach-controle { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 8px 10px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--bordure); }
.ach-controle.ok { color: var(--ok); }
.ach-controle.ko { color: var(--danger); }
.ach-controle svg { width: 16px; height: 16px; }
.ach-rap { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.ach-rap td { padding: 6px 4px; border-bottom: 1px solid var(--bordure); }
.ach-rap td:last-child { text-align: right; font-weight: 600; }
.ach-rap tr.ecart td { border-bottom: 0; font-size: 14px; }
.ach-alerte-ligne { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
@media (max-width: 900px) { .ach-apercu { height: 380px; } .ach-hbar { grid-template-columns: 1fr; } }
`;
    document.head.appendChild(el('style', { id: 'achats-styles', text: css }));
  })();

  // ----- Utilitaires -----------------------------------------------------------------------------
  const can = (action) => GMAO.can(MODULE, action);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const arrondi = (n, d = 2) => { const f = 10 ** d; return Math.round((num(n) + (num(n) >= 0 ? 1e-9 : -1e-9)) * f) / f; };
  const montant = (n) => ui.formatMontant(num(n));
  const cfg = () => Object.assign({ tauxTVA: 20, seuilValidationHT: 1000, delaiPaiementJours: 30, entreeStockAReception: true, alerteEcheanceJours: 7 }, (GMAO.config || {}).achats || {});
  /** Date AAAA-MM-JJ affichée selon le format configuré, sans décalage de fuseau. */
  const dateFr = (j) => (j ? ui.formatDate(/^\d{4}-\d{2}-\d{2}$/.test(String(j)) ? `${j}T12:00:00` : j) : '');
  const aujourdhui = () => ui.aujourdhui();
  function ajouterJours(j, n) { const d = new Date(`${j}T12:00:00`); d.setDate(d.getDate() + Number(n || 0)); return ui.dateISO(d); }
  function joursEntre(a, b) { return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000); }
  function montantCompact(n) {
    const v = num(n); const a = Math.abs(v);
    if (a >= 1e6) return `${ui.formatNombre(v / 1e6, 1)} M€`;
    if (a >= 1e4) return `${ui.formatNombre(v / 1e3, 0)} k€`;
    if (a >= 1e3) return `${ui.formatNombre(v / 1e3, 1)} k€`;
    return `${ui.formatNombre(v, 0)} €`;
  }
  function pluriel(n, s, p) { return `${ui.formatNombre(n)} ${n > 1 ? (p || s + 's') : s}`; }
  const lienVue = (href, label) => el('a', { href, onclick: (ev) => ev.stopPropagation() }, label);
  function iconeDim(nom, taille, couleur) { const ic = icone(nom); Object.assign(ic.style, { width: taille + 'px', height: taille + 'px', flexShrink: '0', color: couleur || 'currentColor' }); return ic; }
  function tailleLisible(o) { const n = num(o); if (n < 1024) return `${n} o`; if (n < 1048576) return `${Math.round(n / 1024)} Ko`; return `${ui.formatNombre(n / 1048576, 1)} Mo`; }
  /** Unité affichée en abrégé (code de la liste « unites », ex. u, m, l, lot). */
  const libUnite = (code) => (code ? String(code) : '');
  const normalTri = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const secondaire = (txt) => (txt ? el('div', { class: 'cellule-secondaire' }, txt) : null);
  /** Texte tronqué (infobulle avec le texte complet). */
  const texteCourt = (txt, max) => el('div', { class: 'ach-objet', title: txt || '', style: { maxWidth: (max || 200) + 'px' } }, txt || '');
  /** Texte secondaire tronqué (infobulle avec le texte complet). */
  const objetCourt = (txt, max) => (txt ? el('div', { class: 'cellule-secondaire ach-objet', title: txt, style: max ? { maxWidth: max + 'px' } : null }, txt) : null);
  function lectureSeule(r) { return !!(r && (r.lectureSeule || GMAO.siteLectureSeule(r.secteurId))); }
  /** Secteurs proposés en saisie : site affiché, hors sites en lecture seule, dans la portée modifiable. */
  function optionsSecteursEcriture(vide) {
    const p = GMAO.perms || {};
    const modifiables = ['secteurs', 'site'].includes(p.portee) && Array.isArray(p.secteurIds) ? new Set(p.secteurIds.map(Number)) : null;
    return ui.optionsSecteurs({ vide: vide || '— Choisir —' }).filter((o) => o.value === '' || (!GMAO.siteLectureSeule(o.value) && (!modifiables || modifiables.has(Number(o.value)))));
  }
  function nomSite(secteurId) { const s = ui.secteur(secteurId); if (!s) return ''; return s.siteId != null && s.siteId !== s.id ? ui.nomSecteur(s.siteId) : ''; }
  function qsFiltres(f) { const qs = new URLSearchParams(); for (const [k, v] of Object.entries(f || {})) if (v !== '' && v !== false && v != null) qs.set(k, v === true ? '1' : v); return qs.toString(); }
  function exporter(quoi, filtres) { const qs = qsFiltres(filtres); api.telecharger(`/api/achats/export/${quoi}${qs ? '?' + qs : ''}`).then(() => toast('Export CSV téléchargé', 'succes')).catch(erreur); }
  async function demanderMotif(titre, label, aide) {
    return ui.prompt({ titre, label, type: 'texte_long', message: aide || undefined, okLabel: 'Confirmer' });
  }

  /** Références des formulaires (fournisseurs, articles, OT, personnel, commandes facturables). */
  let refsCache = null; let refsDate = 0;
  async function references(force) {
    if (!force && refsCache && Date.now() - refsDate < 20000) return refsCache;
    refsCache = await api.get('/api/achats/references');
    refsDate = Date.now();
    return refsCache;
  }
  const invaliderRefs = () => { refsCache = null; };

  /** Pastille du menu : commandes et factures à valider (droit valider) et factures en retard — dès la connexion et après chaque action. */
  let badgeEnCours = null;
  function majBadge() {
    if (!GMAO.user || !can('voir')) return Promise.resolve();
    if (!badgeEnCours) {
      badgeEnCours = api.get('/api/achats/compteurs', null, { silent401: true }).then((k) => GMAO.setNavBadge(MODULE, k.total || 0)).catch(() => {}).then(() => { badgeEnCours = null; });
    }
    return badgeEnCours;
  }
  // Dès la connexion (y compris après un changement de mot de passe imposé, qui ne repasse pas par onConnexion),
  // puis à chaque changement de vue au plus une fois par minute
  let dernierBadge = { t: 0, user: null };
  function majBadgeSiBesoin(force) {
    if (!GMAO.user || GMAO.changementMdpRequis()) return;
    const maintenant = Date.now();
    if (!force && dernierBadge.user === GMAO.user.id && maintenant - dernierBadge.t < 60000) return;
    dernierBadge = { t: maintenant, user: GMAO.user.id };
    majBadge();
  }
  GMAO.onConnexion(() => majBadgeSiBesoin(true));
  window.addEventListener('hashchange', () => majBadgeSiBesoin(false));
  (function attendreConnexion() { if (GMAO.user && !GMAO.changementMdpRequis()) majBadgeSiBesoin(true); else setTimeout(attendreConnexion, 1500); })();

  /** Une seule ouverture de fenêtre à la fois (double clic pendant le chargement des références). */
  let ouvertureEnCours = false;
  async function ouvrirUnique(fn) {
    if (ouvertureEnCours) return;
    ouvertureEnCours = true;
    try { await fn(); } finally { ouvertureEnCours = false; }
  }
  /** Peut-on créer une commande ou une facture sur le site affiché (au moins un site / service modifiable) ? */
  const creationPossible = () => can('creer') && optionsSecteursEcriture().some((o) => o.value !== '');

  // ----- Étapes du circuit -------------------------------------------------------------------------
  function etapes(liste, courant, { echec } = {}) {
    const cont = el('div', { class: 'ach-etapes' });
    const idx = liste.findIndex((e) => e.codes.includes(courant));
    liste.forEach((e, i) => {
      if (i) cont.appendChild(el('span', { class: 'ach-trait' + (idx >= i && !echec ? ' fait' : (idx >= i ? ' fait' : '')) }));
      const fait = idx > i || (idx === i && e.final);
      const cls = echec && i === idx ? 'echec' : (fait ? 'faite' : (i === idx ? 'courante' : ''));
      cont.appendChild(el('span', { class: 'ach-etape ' + cls }, el('span', { class: 'ach-puce' }, fait ? icone('check') : (echec && i === idx ? icone('fermer') : String(i + 1))), e.label));
    });
    return cont;
  }
  const lib = (liste, code, defaut) => { const it = ui.itemListe(liste, code); return it ? it.label : (defaut || code); };

  // =================================================================================================
  // GRAPHIQUES
  // =================================================================================================
  function svg(tag, attrs, ...enfants) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
    for (const c of enfants) if (c != null) e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  /** Barres groupées (deux séries de même unité, un seul axe) avec info-bulle au survol de chaque mois. */
  function graphiqueMois(donnees, series) {
    const W = 640; const H = 230; const g = { haut: 14, bas: 28, gauche: 52, droite: 8 };
    const max = Math.max(1, ...donnees.flatMap((d) => series.map((s) => num(d[s.cle]))));
    const pas = (() => { const brut = max / 4; const p = 10 ** Math.floor(Math.log10(brut)); const m = brut / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; })();
    const haut = pas * Math.ceil(max / pas);
    const hz = H - g.haut - g.bas; const lz = W - g.gauche - g.droite;
    const y = (v) => g.haut + hz - (num(v) / haut) * hz;
    const col = lz / Math.max(1, donnees.length);
    const largeurBarre = Math.max(3, Math.min(18, (col - 10) / series.length - 2));
    const racine = el('div', { class: 'ach-graph ach-viz' });
    const bulle = el('div', { class: 'ach-bulle' });
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Montants par mois' });
    for (let v = 0; v <= haut + 1e-9; v += pas) {
      s.appendChild(svg('line', { x1: g.gauche, x2: W - g.droite, y1: y(v), y2: y(v), style: 'stroke: var(--bordure); stroke-width: 1' }));
      s.appendChild(svg('text', { x: g.gauche - 6, y: y(v) + 4, 'text-anchor': 'end', style: 'fill: var(--texte-2); font-size: 10.5px' }, montantCompact(v)));
    }
    donnees.forEach((d, i) => {
      const x0 = g.gauche + i * col;
      const groupe = series.length * largeurBarre + (series.length - 1) * 2;
      series.forEach((se, k) => {
        const v = num(d[se.cle]);
        const xb = x0 + (col - groupe) / 2 + k * (largeurBarre + 2);
        const hb = Math.max(v > 0 ? 2 : 0, g.haut + hz - y(v));
        if (hb > 0) s.appendChild(svg('path', { d: barreArrondie(xb, g.haut + hz - hb, largeurBarre, hb, Math.min(4, largeurBarre / 2)), style: `fill: ${se.couleur}` }));
      });
      const [a, m] = String(d.mois).split('-').map(Number);
      const lbl = new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '');
      s.appendChild(svg('text', { x: x0 + col / 2, y: H - 10, 'text-anchor': 'middle', style: 'fill: var(--texte-2); font-size: 10.5px' }, lbl));
      const zone = svg('rect', { x: x0, y: g.haut, width: col, height: hz, fill: 'transparent', style: 'cursor: default' });
      zone.addEventListener('mouseenter', () => {
        zone.setAttribute('style', 'fill: var(--primaire-clair); opacity: .35');
        ui.vider(bulle);
        bulle.appendChild(el('b', null, new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })));
        series.forEach((se) => bulle.appendChild(el('div', { class: 'ach-bulle-serie' }, el('i', { style: { width: '9px', height: '9px', borderRadius: '2px', background: se.couleur, display: 'inline-block' } }), `${se.label} : `, el('strong', null, montant(d[se.cle])))));
        bulle.style.display = 'block';
        const r = racine.getBoundingClientRect();
        const px = ((x0 + col / 2) / W) * r.width;
        bulle.style.left = Math.min(Math.max(4, px - bulle.offsetWidth / 2), r.width - bulle.offsetWidth - 4) + 'px';
        bulle.style.top = '-6px';
      });
      zone.addEventListener('mouseleave', () => { zone.setAttribute('style', 'fill: transparent'); bulle.style.display = 'none'; });
      s.appendChild(zone);
    });
    s.appendChild(svg('line', { x1: g.gauche, x2: W - g.droite, y1: g.haut + hz, y2: g.haut + hz, style: 'stroke: var(--bordure-2); stroke-width: 1' }));
    racine.appendChild(el('div', { class: 'ach-legende', style: { marginBottom: '6px' } }, series.map((se) => el('span', null, el('i', { style: { background: se.couleur } }), se.label))));
    racine.appendChild(s);
    racine.appendChild(bulle);
    return racine;
  }
  function barreArrondie(x, y, w, h, r) {
    const rr = Math.min(r, h);
    return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
  }
  /** Barres horizontales : couleur de l'entité (catégorie configurée) ou couleur unique. */
  function barresH(items, { valeur = 'valeur', couleur, lien, detail } = {}) {
    const max = Math.max(1, ...items.map((x) => num(x[valeur])));
    const total = items.reduce((s, x) => s + num(x[valeur]), 0);
    return el('div', null, items.map((x) => {
      const href = lien ? lien(x) : null;
      return el(href ? 'a' : 'div', { class: 'ach-hbar' + (href ? ' notif-item' : ''), href, style: href ? { color: 'var(--texte)', textDecoration: 'none' } : null, title: `${x.label} : ${montant(x[valeur])}` },
        el('span', { class: 'lib' }, x.couleur ? ui.pastille(x.couleur) : null, el('span', { class: 'ach-hbar-texte' }, el('div', null, x.label), detail ? el('div', { class: 'texte-2', style: { fontSize: '11px' } }, detail(x)) : null)),
        el('span', { class: 'piste' }, el('i', { style: { width: Math.max(2, Math.round((num(x[valeur]) / max) * 100)) + '%', background: x.couleur || couleur || 'var(--primaire)' } })),
        el('span', { class: 'val' }, montant(x[valeur]), el('span', { class: 'texte-2', style: { fontWeight: '400', marginLeft: '6px', fontSize: '11.5px', display: 'inline-block', minWidth: '34px' } }, total > 0 ? `${ui.formatNombre((num(x[valeur]) / total) * 100, 0)} %` : '')));
    }));
  }

  // =================================================================================================
  // TABLEAU DE BORD
  // =================================================================================================
  function periodeDates(code) {
    const auj = aujourdhui(); const d = new Date();
    if (code === 'annee') return { du: `${d.getFullYear()}-01-01`, au: auj };
    if (code === 'annee_prec') return { du: `${d.getFullYear() - 1}-01-01`, au: `${d.getFullYear() - 1}-12-31` };
    if (code === '3m') { const x = new Date(d.getFullYear(), d.getMonth() - 2, 1); return { du: ui.dateISO(x), au: auj }; }
    const x = new Date(d.getFullYear(), d.getMonth() - 11, 1); return { du: ui.dateISO(x), au: auj };
  }

  function miniListe(items, rendu, videMsg) {
    if (!items.length) return el('div', { class: 'texte-2 texte-centre', style: { padding: '18px 6px', fontSize: '13px' } }, el('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: '6px', color: 'var(--ok)' } }, iconeDim('check', 22)), videMsg);
    return el('div', { class: 'ach-mini' }, items.map(rendu));
  }
  function ligneFactureMini(f) {
    const ech = f.enRetard ? el('span', { class: 'texte-danger texte-gras' }, `retard ${f.joursRetard} j`) : (f.joursAvantEcheance != null ? el('span', { class: f.joursAvantEcheance <= cfg().alerteEcheanceJours ? 'texte-alerte texte-gras' : 'texte-2' }, f.joursAvantEcheance === 0 ? 'aujourd\'hui' : `dans ${f.joursAvantEcheance} j`) : '');
    return el('a', { href: '#/achats/facture/' + f.id },
      el('div', { style: { minWidth: '0' } }, el('div', { class: 't' }, f.fournisseurNom, el('span', { class: 'texte-2', style: { fontWeight: '400' } }, ` · n° ${f.numeroFournisseur}`)), el('div', { class: 's' }, `${f.numero} · échéance ${dateFr(f.dateEcheance)}${f.objet ? ' · ' + f.objet : ''}`)),
      el('div', { class: 'd' }, el('div', { class: 'texte-gras' }, montant(f.montantTTC)), el('div', { style: { fontSize: '12px' } }, ech, ' ', ui.badgeListe('statutsFacture', f.statut))));
  }
  function ligneCommandeMini(c, extra) {
    return el('a', { href: '#/achats/commande/' + c.id },
      el('div', { style: { minWidth: '0' } }, el('div', { class: 't' }, `${c.numero} · ${c.fournisseurNom}`), el('div', { class: 's' }, [c.objet, c.demandeurNom ? `demandée par ${c.demandeurNom}` : '', c.siteNom].filter(Boolean).join(' · '))),
      el('div', { class: 'd' }, el('div', { class: 'texte-gras' }, `${montant((c.totaux || {}).ht)} HT`), el('div', { style: { fontSize: '12px' } }, extra ? extra(c) : ui.badgeListe('statutsCommande', c.statut))));
  }

  async function rendreTableau(cont, ong) {
    const selPeriode = el('select', { title: 'Période analysée' },
      [['12m', '12 derniers mois'], ['3m', '3 derniers mois'], ['annee', 'Année en cours'], ['annee_prec', 'Année précédente']].map(([v, l]) => el('option', { value: v }, l)));
    selPeriode.value = filtres().periode;
    const zone = el('div');
    selPeriode.addEventListener('change', () => { memo.periode = selPeriode.value; charger(); });
    cont.appendChild(el('div', { class: 'barre-outils' }, el('label', { class: 'inline' }, iconeDim('calendrier', 16, 'var(--texte-2)'), selPeriode), el('span', { class: 'espace' }),
      ui.bouton('Actualiser', { icone: 'rafraichir', classe: 'btn-sm', onClic: () => charger() })));
    cont.appendChild(zone);
    const allerOnglet = (cle, filtres) => () => { if (filtres) Object.assign(cle === 'factures' ? memo.fac : memo.cmd, filtres); ong.activer(cle); };

    async function charger() {
      ui.vider(zone); zone.appendChild(ui.chargement());
      let t;
      try { t = await api.get('/api/achats/tableau', periodeDates(memo.periode)); } catch (e) { ui.vider(zone); zone.appendChild(ui.alerte(e.message, 'danger')); return; }
      ui.vider(zone);
      const k = t.kpis;
      GMAO.setNavBadge(MODULE, (can('valider') ? k.nbCommandesAValider + k.nbFacturesAValider : 0) + k.nbEnRetard);
      const per = `${dateFr(t.periode.du)} – ${dateFr(t.periode.au)}`;
      // Les listes ouvertes depuis un indicateur reprennent sa définition (statuts et période) ; « à recevoir » et les
      // indicateurs de la seconde ligne décrivent la situation du jour, indépendante de la période
      const periode = { du: t.periode.du, au: t.periode.au };
      const facturesNonAnnulees = GMAO.liste('statutsFacture').map((s) => s.code).filter((x) => x !== 'annulee').join(',');
      zone.appendChild(el('div', { class: 'ach-groupe-kpi' }, `Sur la période · ${per}`));
      zone.appendChild(el('div', { class: 'ach-kpis k3' },
        ui.kpi({ label: 'Engagé (HT)', valeur: montant(k.engageHT), icone: 'achats', detail: `${pluriel(k.nbCommandes, 'commande validée', 'commandes validées')} sur la période · ${montant(k.enCoursHT)} à recevoir à ce jour`, onClic: allerOnglet('commandes', Object.assign(FILTRES_CMD(), periode, { statut: STATUTS_CMD_ENGAGES.join(',') })) }),
        ui.kpi({ label: 'Facturé (HT)', valeur: montant(k.factureHT), icone: 'facture', couleur: '#6250d6', detail: `${pluriel(k.nbFactures, 'facture')} hors annulées · ${montant(k.factureTTC)} TTC`, onClic: allerOnglet('factures', Object.assign(FILTRES_FAC(), periode, { statut: facturesNonAnnulees })) }),
        ui.kpi({ label: 'Payé (TTC)', valeur: montant(k.payeTTC), icone: 'check', couleur: '#16a34a', detail: `${pluriel(k.nbPayees, 'facture réglée', 'factures réglées')} sur la période`, onClic: allerOnglet('factures', Object.assign(FILTRES_FAC(), periode, { statut: 'payee' })) })));
      zone.appendChild(el('div', { class: 'ach-groupe-kpi' }, 'Situation à ce jour'));
      zone.appendChild(el('div', { class: 'ach-kpis k3' },
        ui.kpi({ label: 'À payer (TTC)', valeur: montant(k.aPayerTTC), icone: 'euro', couleur: '#0891b2', detail: `${pluriel(k.nbAPayer, 'facture')} dont ${montant(k.bonAPayerTTC)} bon à payer${k.nbLitiges ? ` · hors ${montant(k.litigesTTC)} en litige` : ''}`, onClic: () => ong.activer('echeancier') }),
        ui.kpi({ label: 'En retard de paiement', valeur: montant(k.enRetardTTC), icone: 'alerte', couleur: k.nbEnRetard ? '#dc2626' : '#16a34a', detail: k.nbEnRetard ? pluriel(k.nbEnRetard, 'facture échue', 'factures échues') : 'aucune facture échue', onClic: allerOnglet('factures', Object.assign(FILTRES_FAC(), { echeanceDepassee: true })) }),
        ui.kpi({ label: 'Commandes à valider', valeur: ui.formatNombre(k.nbCommandesAValider), icone: 'horloge', couleur: k.nbCommandesAValider ? '#f59e0b' : '#16a34a', detail: k.nbCommandesAValider ? `${montant(k.commandesAValiderHT)} HT en attente` : 'aucune en attente', onClic: allerOnglet('commandes', Object.assign(FILTRES_CMD(), { statut: 'a_valider' })) })));

      const alertes = [];
      if (k.nbLitiges) alertes.push(ui.alerte(el('div', { class: 'ach-alerte-ligne' }, iconeDim('alerte', 16), el('strong', null, pluriel(k.nbLitiges, 'facture en litige', 'factures en litige')), `(${montant(k.litigesTTC)} TTC) : réglez le différend avec le fournisseur avant paiement.`, el('a', { href: '#', class: 'ach-lien-alerte', onclick: (ev) => { ev.preventDefault(); allerOnglet('factures', { statut: 'litige', echeanceDepassee: false, aPayer: false })(); } }, 'Voir les litiges')), 'alerte'));
      if (k.nbLivraisonsEnRetard) alertes.push(ui.alerte(el('div', { class: 'ach-alerte-ligne' }, iconeDim('horloge', 16), el('strong', null, pluriel(k.nbLivraisonsEnRetard, 'livraison en retard', 'livraisons en retard')), 'par rapport à la date prévue : relancez les fournisseurs concernés.', el('a', { href: '#', class: 'ach-lien-alerte', onclick: (ev) => { ev.preventDefault(); allerOnglet('commandes', { statut: '', enRetard: true })(); } }, 'Voir les commandes')), 'info'));
      alertes.forEach((a) => zone.appendChild(a));

      const series = [{ cle: 'engageHT', label: 'Commandé (HT)', couleur: 'var(--serie-1)' }, { cle: 'factureHT', label: 'Facturé (HT)', couleur: 'var(--serie-2)' }];
      const totalCat = t.parCategorie.reduce((s, x) => s + num(x.factureHT), 0);
      zone.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } },
        ui.carte('Commandes et factures par mois', frag(el('div', { class: 'texte-2 texte-petit', style: { marginTop: '-6px', marginBottom: '8px' } }, `Montants HT · ${per}${t.serieMoisLimitee ? ' · 36 derniers mois' : ''}`), t.parMois.some((m) => m.engageHT || m.factureHT) ? graphiqueMois(t.parMois, series) : ui.vide('Aucune commande ni facture sur la période', 'rapports'))),
        ui.carte('Dépenses facturées par catégorie', frag(el('div', { class: 'texte-2 texte-petit', style: { marginTop: '-6px', marginBottom: '8px' } }, `${montant(totalCat)} HT facturés · ${per}`),
          t.parCategorie.filter((x) => x.factureHT > 0).length ? barresH(t.parCategorie.filter((x) => x.factureHT > 0).map((x) => Object.assign({}, x, { valeur: x.factureHT, couleur: x.couleur || '#6b7280' }))) : ui.vide('Aucune facture sur la période', 'facture')))));

      zone.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } },
        ui.carte(frag('Factures en retard ', t.enRetard.length ? ui.badge(String(t.enRetard.length), '#dc2626') : null), miniListe(t.enRetard.slice(0, 8), ligneFactureMini, 'Aucune facture échue non payée.'), { actions: t.enRetard.length ? ui.bouton('Toutes', { classe: 'btn-lien btn-sm', onClic: allerOnglet('factures', { statut: '', echeanceDepassee: true, aPayer: false }) }) : null }),
        ui.carte(frag('Prochaines échéances ', t.aPayer.length ? ui.badge(String(t.aPayer.length)) : null), miniListe(t.aPayer.slice(0, 8), ligneFactureMini, 'Aucune facture à payer.'), { actions: ui.bouton('Échéancier', { classe: 'btn-lien btn-sm', icone: 'calendrier', onClic: () => ong.activer('echeancier') }) })));

      zone.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } },
        ui.carte(frag('Commandes à valider ', t.commandesAValider.length ? ui.badge(String(t.commandesAValider.length), '#f59e0b') : null), miniListe(t.commandesAValider, (c) => ligneCommandeMini(c, (x) => (x.validationPropreInterdite ? el('span', { class: 'texte-2' }, 'votre demande') : ui.badgeListe('statutsCommande', x.statut))), `Aucune commande en attente (seuil de validation : ${montant(t.config.seuilValidationHT)} HT).`)),
        ui.carte('Principaux fournisseurs', t.parFournisseur.length ? barresH(t.parFournisseur.map((x) => Object.assign({}, x, { valeur: x.factureHT + x.engageHT })), { couleur: 'var(--primaire)', detail: (x) => `${montant(x.factureHT)} fact. · ${montant(x.engageHT)} cmd.`, lien: (x) => (x.fournisseurId && GMAO.can('fournisseurs', 'voir') ? '#/fournisseurs/' + x.fournisseurId : null) }) : ui.vide('Aucun achat sur la période', 'fournisseurs'))));

      if (t.livraisonsEnRetard.length || t.parSite.length > 1) {
        zone.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } },
          ui.carte('Livraisons en retard', miniListe(t.livraisonsEnRetard, (c) => ligneCommandeMini(c, (x) => el('span', { class: 'texte-danger texte-gras' }, `prévue le ${dateFr(x.dateLivraisonPrevue)} (+${x.joursRetardLivraison} j)`)), 'Toutes les livraisons sont dans les délais.')),
          t.parSite.length > 1 ? ui.carte('Répartition par site', barresH(t.parSite.map((x) => Object.assign({}, x, { valeur: x.factureHT + x.engageHT })), { couleur: '#0f766e', detail: (x) => `${montant(x.factureHT)} fact. · ${montant(x.engageHT)} cmd.` })) : el('div')));
      }
    }
    await charger();
  }

  // =================================================================================================
  // LISTE DES COMMANDES
  // =================================================================================================
  function selectFiltre(options, valeur, onChange, titre) {
    const s = el('select', { title: titre }, options.map((o) => el('option', { value: o.value == null ? '' : String(o.value) }, o.label)));
    s.value = valeur == null ? '' : String(valeur);
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function champDate(valeur, onChange, titre) { const i = el('input', { type: 'date', value: valeur || '', title: titre }); i.addEventListener('change', () => onChange(i.value)); return i; }
  function caseFiltre(label, valeur, onChange) { const c = el('input', { type: 'checkbox', checked: !!valeur }); c.addEventListener('change', () => onChange(c.checked)); return el('label', { class: 'inline' }, c, label); }

  function progression(pct) {
    const p = Math.max(0, Math.min(100, num(pct)));
    return el('div', { class: 'ach-progression', title: 'Taux de réception en valeur (montant reçu / montant commandé)' }, el('div', { class: 'barre-progression' }, el('div', { style: { width: p + '%', background: p >= 100 ? 'var(--ok)' : 'var(--primaire)' } })), el('span', null, `${Math.round(p)} %`));
  }

  /** Texte du champ de recherche d'un tableau (transmis aux exports pour exporter ce qui est affiché). */
  const rechercheTableau = (tableau) => { const i = tableau.el.querySelector('input[type=search]'); return i ? i.value.trim() : ''; };
  /** Bouton « Réinitialiser les filtres », affiché seulement quand un filtre est actif. */
  function boutonReinitialiser(f, defauts, rendre) {
    if (!filtreActif(f)) return null;
    return ui.bouton('Réinitialiser les filtres', { icone: 'fermer', classe: 'btn-sm btn-lien', onClic: () => { Object.assign(f, defauts()); rendre(); } });
  }

  async function rendreCommandes(cont) {
    const refs = await references().catch(() => ({ fournisseurs: [] }));
    const f = filtres().cmd;
    const resume = el('span', { class: 'texte-2 texte-petit' });
    const optsStatut = [{ value: '', label: 'Tous les statuts' }, { value: STATUTS_CMD_OUVERTS.join(','), label: 'En cours (validées, envoyées, partielles)' }, { value: STATUTS_CMD_ENGAGES.join(','), label: 'Engagées (validées à reçues)' }].concat(GMAO.liste('statutsCommande').map((s) => ({ value: s.code, label: s.label })));
    const optsFournisseurs = [{ value: '', label: 'Tous les fournisseurs' }].concat((refs.fournisseurs || []).map((x) => ({ value: x.id, label: x.nom + (x.actif ? '' : ' (désactivé)') })));
    const optsSecteurs = ui.optionsSecteurs({ vide: 'Tous les sites / services' });
    const optsCategories = ui.optionsListe('categoriesDepense', { vide: 'Toutes les catégories' });
    purgerFiltre(f, 'statut', optsStatut); purgerFiltre(f, 'fournisseurId', optsFournisseurs); purgerFiltre(f, 'secteurId', optsSecteurs); purgerFiltre(f, 'categorieCode', optsCategories);
    const tableau = ui.table({
      lignes: [], recherche: 'Rechercher (n°, objet, fournisseur…)', triInitial: { cle: 'dateCommande', sens: 'desc' }, vide: 'Aucune commande ne correspond aux filtres',
      onClic: (c) => GMAO.navigate('#/achats/commande/' + c.id),
      ligneClasse: (c) => (c.statut === 'annulee' ? 'inactif' : ''),
      rechercheDans: (c) => [c.objet, c.fournisseurNom, (c.lignes || []).map((l) => `${l.designation} ${l.referenceFournisseur || ''}`).join(' ')].join(' '),
      colonnes: [
        { cle: 'dateCommande', label: 'Commande', rendu: (c) => frag(el('div', { class: 'cellule-principale nowrap' }, c.numero), secondaire(dateFr(c.dateCommande))), valeurTri: (c) => `${c.dateCommande || ''}|${c.numero}` },
        { cle: 'fournisseurNom', label: 'Fournisseur / objet', rendu: (c) => frag(el('div', null, c.fournisseurNom), objetCourt(c.objet || ui.libelle('categoriesDepense', c.categorieCode), 200)), valeurTri: (c) => normalTri(c.fournisseurNom) },
        { cle: 'secteurNom', label: 'Site / service', rendu: (c) => frag(texteCourt(c.secteurNom, 140), secondaire(c.siteNom && c.siteNom !== c.secteurNom ? c.siteNom : '')) },
        { cle: 'statut', label: 'Statut', liste: 'statutsCommande' },
        { cle: 'totaux.ht', label: 'Montant HT', aligner: 'droite', rendu: (c) => el('span', { class: 'texte-gras nowrap' }, montant(c.totaux.ht)), valeurTri: (c) => num(c.totaux.ht), exportValeur: (c) => ui.formatNombre(c.totaux.ht, 2) },
        { cle: 'dateLivraisonPrevue', label: 'Livraison', rendu: (c) => (c.dateLivraisonPrevue ? frag(el('div', { class: (c.enRetardLivraison ? 'texte-danger texte-gras ' : '') + 'nowrap' }, dateFr(c.dateLivraisonPrevue)), c.enRetardLivraison ? el('div', { class: 'cellule-secondaire texte-danger' }, `retard ${c.joursRetardLivraison} j`) : null) : el('span', { class: 'texte-2' }, '—')), valeurTri: (c) => c.dateLivraisonPrevue || '9999' },
        { cle: 'tauxReception', label: 'Réception', rendu: (c) => (['brouillon', 'a_valider', 'annulee'].includes(c.statut) ? el('span', { class: 'texte-2' }, '—') : progression(c.tauxReception)), valeurTri: (c) => num(c.tauxReception) },
        { cle: 'montantFactureHT', label: 'Facturé HT', aligner: 'droite', classe: 'ach-col-secondaire', rendu: (c) => (c.montantFactureHT ? el('span', { class: 'nowrap' }, montant(c.montantFactureHT)) : el('span', { class: 'texte-2' }, '—')), valeurTri: (c) => num(c.montantFactureHT) },
      ],
    });
    const charger = async () => {
      try {
        const rows = await api.get('/api/commandes', { statut: f.statut, fournisseurId: f.fournisseurId, secteurId: f.secteurId, categorieCode: f.categorieCode, du: f.du, au: f.au, enRetard: f.enRetard ? '1' : '' });
        tableau.maj(rows);
        const ht = rows.filter((c) => c.statut !== 'annulee').reduce((s, c) => s + num(c.totaux.ht), 0);
        resume.textContent = `${pluriel(rows.length, 'commande')} · ${montant(ht)} HT (hors annulées)`;
      } catch (e) { erreur(e); }
    };
    const rendre = () => { ui.vider(cont); rendreCommandes(cont); };
    const maj = (k) => (v) => { f[k] = v; charger(); };
    cont.appendChild(el('div', { class: 'barre-outils' },
      selectFiltre(optsStatut, f.statut, maj('statut'), 'Statut'),
      selectFiltre(optsFournisseurs, f.fournisseurId, maj('fournisseurId'), 'Fournisseur'),
      selectFiltre(optsSecteurs, f.secteurId, maj('secteurId'), 'Site / service'),
      selectFiltre(optsCategories, f.categorieCode, maj('categorieCode'), 'Catégorie de dépense'),
      el('label', { class: 'inline' }, 'Du', champDate(f.du, maj('du'), 'Date de commande à partir du')),
      el('label', { class: 'inline' }, 'au', champDate(f.au, maj('au'), 'Date de commande jusqu\'au')),
      caseFiltre('Livraison en retard', f.enRetard, maj('enRetard')),
      boutonReinitialiser(f, FILTRES_CMD, rendre),
      el('span', { class: 'espace' }),
      can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', titre: 'Commandes affichées (filtres et recherche)', onClic: () => exporter('commandes', Object.assign({}, f, { recherche: rechercheTableau(tableau) })) }) : null,
      can('exporter') ? ui.bouton('Lignes (CSV)', { icone: 'liste', classe: 'btn-sm', titre: 'Export détaillé des lignes des commandes affichées', onClic: () => exporter('lignes', Object.assign({}, f, { recherche: rechercheTableau(tableau) })) }) : null));
    cont.appendChild(el('div', { class: 'barre-outils', style: { marginTop: '-6px' } }, resume));
    tableau.el.classList.add('ach-liste'); cont.appendChild(tableau.el);
    await charger();
  }

  // =================================================================================================
  // LISTE DES FACTURES
  // =================================================================================================
  function celluleEcheance(f) {
    if (!f.dateEcheance) return el('span', { class: 'texte-2' }, '—');
    if (f.enRetard) return frag(el('div', { class: 'texte-danger texte-gras' }, dateFr(f.dateEcheance)), el('div', { class: 'cellule-secondaire texte-danger' }, `échue depuis ${f.joursRetard} j`));
    if (f.statut === 'payee') return frag(el('div', null, dateFr(f.dateEcheance)), el('div', { class: 'cellule-secondaire' }, `payée le ${dateFr(f.datePaiement)}`));
    if (f.joursAvantEcheance != null && f.statut !== 'annulee') return frag(el('div', { class: f.joursAvantEcheance <= cfg().alerteEcheanceJours ? 'texte-alerte texte-gras' : '' }, dateFr(f.dateEcheance)), el('div', { class: 'cellule-secondaire' }, f.joursAvantEcheance === 0 ? 'aujourd\'hui' : `dans ${f.joursAvantEcheance} j`));
    return dateFr(f.dateEcheance);
  }

  async function rendreFactures(cont) {
    const refs = await references().catch(() => ({ fournisseurs: [] }));
    const f = filtres().fac;
    const resume = el('span', { class: 'texte-2 texte-petit' });
    const nonAnnulees = GMAO.liste('statutsFacture').map((s) => s.code).filter((x) => x !== 'annulee').join(',');
    const optsStatut = [{ value: '', label: 'Tous les statuts' }, { value: nonAnnulees, label: 'Tous sauf annulées' }].concat(GMAO.liste('statutsFacture').map((s) => ({ value: s.code, label: s.label })));
    const optsFournisseurs = [{ value: '', label: 'Tous les fournisseurs' }].concat((refs.fournisseurs || []).map((x) => ({ value: x.id, label: x.nom })));
    const optsSecteurs = ui.optionsSecteurs({ vide: 'Tous les sites / services' });
    const optsCategories = ui.optionsListe('categoriesDepense', { vide: 'Toutes les catégories' });
    purgerFiltre(f, 'statut', optsStatut); purgerFiltre(f, 'fournisseurId', optsFournisseurs); purgerFiltre(f, 'secteurId', optsSecteurs); purgerFiltre(f, 'categorieCode', optsCategories);
    const tableau = ui.table({
      lignes: [], recherche: 'Rechercher (n°, fournisseur, objet…)', triInitial: { cle: 'dateFacture', sens: 'desc' }, vide: 'Aucune facture ne correspond aux filtres',
      onClic: (x) => GMAO.navigate('#/achats/facture/' + x.id),
      ligneClasse: (x) => (x.statut === 'annulee' ? 'inactif' : ''),
      colonnes: [
        { cle: 'dateFacture', label: 'Facture', rendu: (x) => frag(el('div', { class: 'cellule-principale inline nowrap', style: { gap: '5px' } }, x.numero, x.nbDocuments ? el('span', { title: `${x.nbDocuments} pièce(s) jointe(s)`, class: 'inline', style: { color: x.aPdf ? 'var(--danger)' : 'var(--texte-2)' } }, iconeDim('piece_jointe', 13)) : null), objetCourt(`n° ${x.numeroFournisseur} · ${dateFr(x.dateFacture)}`, 170)), valeurTri: (x) => `${x.dateFacture || ''}|${x.numero}` },
        { cle: 'fournisseurNom', label: 'Fournisseur / objet', rendu: (x) => frag(el('div', null, x.fournisseurNom), objetCourt(x.objet || ui.libelle('categoriesDepense', x.categorieCode), 190)), valeurTri: (x) => normalTri(x.fournisseurNom) },
        { cle: 'commandeNumero', label: 'Imputation', classe: 'ach-col-secondaire', rendu: (x) => frag(x.commandeNumero ? el('div', { class: 'nowrap' }, lienVue('#/achats/commande/' + x.commandeId, x.commandeNumero)) : null, x.otNumero ? el('div', { class: 'cellule-secondaire nowrap' }, /^OT/i.test(x.otNumero) ? x.otNumero : `OT ${x.otNumero}`) : null, x.personnelNom ? el('div', { class: 'cellule-secondaire' }, x.personnelNom) : null, !x.commandeNumero && !x.otNumero && !x.personnelNom ? el('span', { class: 'texte-2' }, '—') : null), valeurTri: (x) => x.commandeNumero || x.otNumero || '' },
        { cle: 'secteurNom', label: 'Site / service', rendu: (x) => frag(texteCourt(x.secteurNom, 140), secondaire(x.siteNom && x.siteNom !== x.secteurNom ? x.siteNom : '')) },
        { cle: 'montantTTC', label: 'Montant', aligner: 'droite', rendu: (x) => frag(el('div', { class: 'texte-gras nowrap' }, `${montant(x.montantTTC)} TTC`), el('div', { class: 'cellule-secondaire nowrap' }, `${montant(x.montantHT)} HT`)), valeurTri: (x) => num(x.montantTTC) },
        { cle: 'dateEcheance', label: 'Échéance', rendu: celluleEcheance, valeurTri: (x) => x.dateEcheance || '' },
        { cle: 'statut', label: 'Statut', liste: 'statutsFacture', rendu: (x) => frag(ui.badgeListe('statutsFacture', x.statut), x.rapprochement && !x.rapprochement.conforme && !['payee', 'annulee'].includes(x.statut) ? el('div', { class: 'cellule-secondaire texte-alerte', title: 'Écart de rapprochement avec la commande' }, `écart ${montant(x.rapprochement.ecartHT)}`) : null) },
      ],
    });
    const charger = async () => {
      try {
        const rows = await api.get('/api/factures', { statut: f.statut, fournisseurId: f.fournisseurId, secteurId: f.secteurId, categorieCode: f.categorieCode, du: f.du, au: f.au, echeanceDepassee: f.echeanceDepassee ? '1' : '', aPayer: f.aPayer ? '1' : '' });
        tableau.maj(rows);
        const valides = rows.filter((x) => x.statut !== 'annulee');
        resume.textContent = `${pluriel(rows.length, 'facture')} · ${montant(valides.reduce((s, x) => s + num(x.montantHT), 0))} HT · ${montant(valides.reduce((s, x) => s + num(x.montantTTC), 0))} TTC (hors annulées)`;
      } catch (e) { erreur(e); }
    };
    const rendre = () => { ui.vider(cont); rendreFactures(cont); };
    const maj = (k) => (v) => { f[k] = v; charger(); };
    cont.appendChild(el('div', { class: 'barre-outils' },
      selectFiltre(optsStatut, f.statut, maj('statut'), 'Statut'),
      selectFiltre(optsFournisseurs, f.fournisseurId, maj('fournisseurId'), 'Fournisseur'),
      selectFiltre(optsSecteurs, f.secteurId, maj('secteurId'), 'Site / service'),
      selectFiltre(optsCategories, f.categorieCode, maj('categorieCode'), 'Catégorie de dépense'),
      el('label', { class: 'inline' }, 'Du', champDate(f.du, maj('du'), 'Date de facture à partir du')),
      el('label', { class: 'inline' }, 'au', champDate(f.au, maj('au'), 'Date de facture jusqu\'au')),
      caseFiltre('Échéance dépassée', f.echeanceDepassee, maj('echeanceDepassee')),
      caseFiltre('À payer', f.aPayer, maj('aPayer')),
      boutonReinitialiser(f, FILTRES_FAC, rendre),
      el('span', { class: 'espace' }),
      can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', titre: 'Factures affichées (filtres et recherche)', onClic: () => exporter('factures', Object.assign({}, f, { recherche: rechercheTableau(tableau) })) }) : null));
    cont.appendChild(el('div', { class: 'barre-outils', style: { marginTop: '-6px' } }, resume));
    tableau.el.classList.add('ach-liste'); cont.appendChild(tableau.el);
    await charger();
  }

  // =================================================================================================
  // ÉCHÉANCIER
  // =================================================================================================
  async function rendreEcheancier(cont, recharger) {
    let e;
    try { e = await api.get('/api/achats/echeancier'); } catch (err) { cont.appendChild(ui.alerte(err.message, 'danger')); return; }
    const semaineCourante = e.semaines.find((s) => s.courante);
    const quatre = e.semaines.filter((s) => s.debut <= ajouterJours(e.aujourdhui, 28)).reduce((s, x) => s + num(x.total), 0);
    // Même définition que le tableau de bord : les factures en litige sont comptées à part
    const litiges = e.enRetard.factures.concat(...e.semaines.map((s) => s.factures)).filter((x) => x.statut === 'litige');
    const litigeTTC = litiges.reduce((s, x) => s + num(x.montantTTC), 0);
    cont.appendChild(el('div', { class: 'ach-kpis k4' },
      ui.kpi({ label: 'Total à payer (TTC)', valeur: montant(e.total), icone: 'euro', detail: `${pluriel(e.nbFactures, 'facture non réglée', 'factures non réglées')}${litiges.length ? ` · dont ${montant(litigeTTC)} en litige` : ' · aucune en litige'}` }),
      ui.kpi({ label: 'Échu non payé', valeur: montant(e.enRetard.total), icone: 'alerte', couleur: e.enRetard.factures.length ? '#dc2626' : '#16a34a', detail: e.enRetard.factures.length ? pluriel(e.enRetard.factures.length, 'facture') : 'aucune' }),
      ui.kpi({ label: 'Cette semaine', valeur: montant(semaineCourante ? semaineCourante.total : 0), icone: 'calendrier', couleur: '#f59e0b', detail: semaineCourante ? pluriel(semaineCourante.factures.length, 'échéance') : 'aucune échéance' }),
      ui.kpi({ label: 'Dans les 4 semaines', valeur: montant(quatre), icone: 'horloge', couleur: '#0891b2', detail: 'hors factures échues' })));
    cont.appendChild(el('div', { class: 'barre-outils' }, el('span', { class: 'texte-2 texte-petit' }, 'Factures non réglées (reçues, à valider, bons à payer, en litige) classées par semaine d\'échéance. Seules les factures « bon à payer » peuvent être réglées.'), el('span', { class: 'espace' }),
      can('exporter') ? ui.bouton('Exporter l\'échéancier', { icone: 'export', classe: 'btn-sm', onClic: () => exporter('echeancier', {}) }) : null));
    if (!e.nbFactures) { cont.appendChild(ui.vide('Aucune facture en attente de paiement.', 'check')); return; }
    const tableSemaine = (factures, retard) => ui.table({
      lignes: factures, recherche: false, pagination: false, compact: true, triInitial: { cle: 'dateEcheance', sens: 'asc' }, onClic: (x) => GMAO.navigate('#/achats/facture/' + x.id),
      colonnes: [
        { cle: 'dateEcheance', label: 'Échéance', rendu: (x) => el('span', { class: (retard ? 'texte-danger texte-gras ' : '') + 'nowrap' }, dateFr(x.dateEcheance)), valeurTri: (x) => x.dateEcheance },
        { cle: 'fournisseurNom', label: 'Fournisseur', rendu: (x) => frag(el('div', { class: 'cellule-principale' }, x.fournisseurNom), objetCourt(x.objet, 180)) },
        { cle: 'numeroFournisseur', label: 'N° fournisseur', rendu: (x) => frag(el('div', null, x.numeroFournisseur), secondaire(x.numero)) },
        { cle: 'siteNom', label: 'Site', rendu: (x) => x.siteNom || x.secteurNom },
        { cle: 'statut', label: 'Statut', liste: 'statutsFacture' },
        retard ? { cle: 'joursRetard', label: 'Retard', aligner: 'droite', rendu: (x) => el('span', { class: 'texte-danger texte-gras' }, `${x.joursRetard} j`) } : null,
        { cle: 'montantTTC', label: 'Montant TTC', aligner: 'droite', rendu: (x) => el('span', { class: 'texte-gras nowrap' }, montant(x.montantTTC)), valeurTri: (x) => num(x.montantTTC) },
      ].filter(Boolean),
      actions: [{ icone: 'euro', titre: 'Enregistrer le paiement', classe: 'texte-ok', visible: (x) => can('valider') && x.statut === 'validee' && !GMAO.siteLectureSeule(x.secteurId), onClic: (x) => ouvrirPaiement(x, recharger) }],
    }).el;
    const tableSemaineCompacte = (factures, retard) => { const t = tableSemaine(factures, retard); t.classList.add('ach-liste'); return t; };
    if (e.enRetard.factures.length) {
      cont.appendChild(ui.carte(frag(iconeDim('alerte', 16, 'var(--danger)'), ' Échues — en retard de paiement'), tableSemaineCompacte(e.enRetard.factures, true), { classe: 'ach-semaine retard', actions: el('span', { class: 'texte-danger texte-gras' }, montant(e.enRetard.total)) }));
    }
    for (const s of e.semaines) {
      cont.appendChild(ui.carte(frag(`Semaine ${s.numero}`, el('span', { class: 'texte-2', style: { fontWeight: '400', marginLeft: '8px', fontSize: '13px' } }, `du ${dateFr(s.debut)} au ${dateFr(s.fin)}`), s.courante ? ui.badge('Cette semaine', '#f59e0b', { classe: 'ml' }) : null),
        tableSemaineCompacte(s.factures, false),
        { classe: 'ach-semaine' + (s.courante ? ' courante' : ''), actions: el('div', { style: { textAlign: 'right' } }, el('div', { class: 'texte-gras' }, montant(s.total)), s.totalBonAPayer ? el('div', { class: 'texte-2 texte-petit' }, `dont ${montant(s.totalBonAPayer)} bon à payer`) : null) }));
    }
  }

  // =================================================================================================
  // ÉDITEUR DE LIGNES DE COMMANDE
  // =================================================================================================
  function editeurLignes({ lignes, articles, ots, getFournisseurId, verrouille, onChange }) {
    const tvaDefaut = num(cfg().tauxTVA);
    let rows = (lignes || []).map((l) => Object.assign({}, l));
    const racine = el('div');
    const corps = el('tbody');
    const totaux = el('div', { class: 'ach-totaux' });
    const messageSeuil = el('div', { class: 'texte-petit', style: { textAlign: 'right', marginTop: '4px' } });
    const otsOuverts = (ots || []).filter((o) => !o.final);
    const optOts = [{ value: '', label: '—' }].concat(otsOuverts.map((o) => ({ value: o.id, label: `${o.numero} — ${o.titre}`.slice(0, 70) })));
    const parId = new Map((articles || []).map((a) => [a.id, a]));

    // Recherche d'un article du stock (code, désignation, référence) validée par Entrée ou par un clic : une
    // frappe au clavier ou un scan à la douchette n'ajoute jamais de ligne par touche ; un code exact (douchette)
    // ajoute l'article directement, et un article déjà présent voit sa quantité augmentée.
    const champArticle = el('input', { type: 'text', placeholder: '+ Ajouter un article du stock : code, désignation ou référence…', disabled: verrouille, autocomplete: 'off', dataset: { achArticle: '1' }, title: 'Tapez ou scannez un code article, puis Entrée ; ou choisissez dans les propositions' });
    const suggestions = el('div', { class: 'ach-suggestions masque' });
    let candidats = []; let actif = -1;
    const cle = (s) => normalTri(s).replace(/\s+/g, ' ').trim();
    function chercher(texte) {
      const mots = cle(texte).split(' ').filter(Boolean);
      const fid = Number(getFournisseurId()) || null;
      const liste = (articles || []).filter((a) => { const t = cle(`${a.code} ${a.designation} ${a.referenceFournisseur}`); return mots.every((m) => t.includes(m)); });
      return liste.sort((a, b) => ((b.fournisseurId === fid) - (a.fournisseurId === fid)) || a.designation.localeCompare(b.designation, 'fr')).slice(0, 12);
    }
    function masquerSuggestions() { suggestions.classList.add('masque'); ui.vider(suggestions); candidats = []; actif = -1; }
    function afficherSuggestions() {
      const texte = champArticle.value;
      if (!cle(texte)) { masquerSuggestions(); return; }
      candidats = chercher(texte); actif = candidats.length ? 0 : -1;
      ui.vider(suggestions);
      if (!candidats.length) suggestions.appendChild(el('div', { class: 'ach-suggestion texte-2' }, 'Aucun article ne correspond'));
      const fid = Number(getFournisseurId()) || null;
      candidats.forEach((a, i) => suggestions.appendChild(el('button', { type: 'button', class: 'ach-suggestion' + (i === actif ? ' actif' : ''), dataset: { id: a.id }, onclick: () => ajouterArticle(a) },
        `${a.code ? a.code + ' — ' : ''}${a.designation}`,
        el('span', { class: 's' }, [`${montant(a.prixUnitaire)} HT`, `stock ${ui.formatNombre(a.quantite)} ${libUnite(a.uniteCode)}`.trim(), a.quantite <= a.seuilMin ? 'sous le seuil' : '', a.referenceFournisseur ? `réf. ${a.referenceFournisseur}` : '', fid && a.fournisseurId === fid ? 'fournisseur habituel' : ''].filter(Boolean).join(' · ')))));
      suggestions.classList.remove('masque');
    }
    function surligner() { suggestions.querySelectorAll('.ach-suggestion').forEach((b, i) => b.classList.toggle('actif', i === actif)); const b = suggestions.children[actif]; if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' }); }
    function ajouterArticle(a) {
      const existante = rows.find((l) => Number(l.articleId) === a.id);
      if (existante) { existante.quantite = num(existante.quantite) + 1; toast(`${a.designation} : quantité portée à ${ui.formatNombre(existante.quantite)}`, 'info'); }
      else rows.push({ articleId: a.id, designation: a.designation, referenceFournisseur: a.referenceFournisseur || '', quantite: Math.max(1, num(a.seuilMin) * 2 - num(a.quantite)) || 1, prixUnitaireHT: num(a.prixUnitaire), tauxTVA: tvaDefaut, otId: null, uniteCode: a.uniteCode || '' });
      champArticle.value = ''; masquerSuggestions();
      rendre(true);
      champArticle.focus();
    }
    champArticle.addEventListener('input', afficherSuggestions);
    champArticle.addEventListener('focus', () => { if (cle(champArticle.value)) afficherSuggestions(); });
    champArticle.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' && candidats.length) { ev.preventDefault(); actif = (actif + 1) % candidats.length; surligner(); }
      else if (ev.key === 'ArrowUp' && candidats.length) { ev.preventDefault(); actif = (actif - 1 + candidats.length) % candidats.length; surligner(); }
      else if (ev.key === 'Enter') {
        ev.preventDefault(); ev.stopPropagation();
        const code = cle(champArticle.value);
        if (!code) return;
        const exact = (articles || []).find((a) => cle(a.code) === code || cle(a.referenceFournisseur) === code);
        const choix = exact || (candidats.length ? candidats[Math.max(0, actif)] : null);
        if (choix) ajouterArticle(choix); else toast(`Aucun article du stock ne correspond à « ${champArticle.value.trim()} »`, 'alerte');
      } else if (ev.key === 'Escape' && !suggestions.classList.contains('masque')) { ev.stopPropagation(); masquerSuggestions(); }
    });
    champArticle.addEventListener('blur', () => setTimeout(masquerSuggestions, 150));
    suggestions.addEventListener('mousedown', (ev) => ev.preventDefault()); // le clic sur une proposition garde la saisie active
    function remplirArticles() { if (!suggestions.classList.contains('masque')) afficherSuggestions(); }
    const btnLibre = ui.bouton('Ligne libre', { icone: 'plus', classe: 'btn-sm', disabled: verrouille, onClic: () => { rows.push({ articleId: null, designation: '', referenceFournisseur: '', quantite: 1, prixUnitaireHT: 0, tauxTVA: tvaDefaut, otId: null, uniteCode: 'u' }); rendre(true); const inputs = corps.querySelectorAll('input[data-champ="designation"]'); if (inputs.length) inputs[inputs.length - 1].focus(); } });

    function calcul() {
      let ht = 0; let tva = 0;
      for (const l of rows) { const lht = arrondi(num(l.quantite) * num(l.prixUnitaireHT)); ht += lht; tva += arrondi((lht * num(l.tauxTVA)) / 100); }
      return { ht: arrondi(ht), tva: arrondi(tva), ttc: arrondi(arrondi(ht) + arrondi(tva)) };
    }
    function majTotaux() {
      const t = calcul();
      ui.vider(totaux);
      totaux.appendChild(el('span', { class: 'lib' }, 'Total HT')); totaux.appendChild(el('span', { class: 'val' }, montant(t.ht)));
      totaux.appendChild(el('span', { class: 'lib' }, 'TVA')); totaux.appendChild(el('span', { class: 'val' }, montant(t.tva)));
      totaux.appendChild(el('span', { class: 'lib ttc' }, 'Total TTC')); totaux.appendChild(el('span', { class: 'val ttc' }, montant(t.ttc)));
      const seuil = num(cfg().seuilValidationHT);
      messageSeuil.className = 'texte-petit ' + (t.ht >= seuil ? 'texte-alerte' : 'texte-2');
      messageSeuil.textContent = t.ht >= seuil ? `Montant ≥ ${montant(seuil)} HT : la commande devra être validée par un valideur (autre que le demandeur).` : `Sous le seuil de ${montant(seuil)} HT : validation automatique à la soumission.`;
      corps.querySelectorAll('[data-montant]').forEach((td) => { const l = rows[Number(td.dataset.montant)]; if (l) td.textContent = montant(arrondi(num(l.quantite) * num(l.prixUnitaireHT))); });
      if (onChange) onChange(t, valeurs());
    }
    const valeurs = () => rows.map((l) => ({ articleId: l.articleId == null ? null : Number(l.articleId), designation: String(l.designation || '').trim(), referenceFournisseur: String(l.referenceFournisseur || '').trim(), quantite: num(l.quantite), prixUnitaireHT: num(l.prixUnitaireHT), tauxTVA: num(l.tauxTVA), otId: l.otId == null || l.otId === '' ? null : Number(l.otId), uniteCode: l.uniteCode || '' }));
    function input(l, champ, attrs) {
      const i = el('input', Object.assign({ value: l[champ] == null ? '' : String(l[champ]), disabled: verrouille, dataset: { champ } }, attrs));
      i.addEventListener('input', () => { l[champ] = attrs && attrs.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value; majTotaux(); });
      return i;
    }
    function rendre(changement) {
      ui.vider(corps);
      if (!rows.length) corps.appendChild(el('tr', null, el('td', { colspan: 9, class: 'texte-2 texte-centre', style: { padding: '18px' } }, 'Aucune ligne : ajoutez un article du stock ou une ligne libre.')));
      rows.forEach((l, i) => {
        const a = l.articleId != null ? parId.get(Number(l.articleId)) : null;
        const selOt = el('select', { disabled: verrouille, style: { maxWidth: '150px' } }, optOts.concat(l.otId && !otsOuverts.some((o) => o.id === Number(l.otId)) ? [{ value: l.otId, label: `OT #${l.otId}` }] : []).map((o) => el('option', { value: o.value == null ? '' : String(o.value) }, o.label)));
        selOt.value = l.otId == null ? '' : String(l.otId);
        selOt.addEventListener('change', () => { l.otId = selOt.value ? Number(selOt.value) : null; });
        corps.appendChild(el('tr', null,
          el('td', { class: 'texte-2', style: { paddingTop: '11px' } }, String(i + 1)),
          el('td', { style: { minWidth: '220px' } }, input(l, 'designation', { type: 'text', placeholder: 'Désignation', maxlength: 300 }), a ? el('div', { class: 'ach-info' }, `${a.code} · stock ${ui.formatNombre(a.quantite)} ${libUnite(a.uniteCode)} · seuil ${ui.formatNombre(a.seuilMin)}`) : (l.articleId != null ? el('div', { class: 'ach-info' }, 'Article du stock') : el('div', { class: 'ach-info' }, 'Ligne libre (hors stock)'))),
          el('td', { style: { width: '130px' } }, input(l, 'referenceFournisseur', { type: 'text', placeholder: 'Réf.', maxlength: 100 })),
          el('td', { style: { width: '90px' } }, input(l, 'quantite', { type: 'number', min: 0, step: 'any', style: { textAlign: 'right' } }), el('div', { class: 'ach-info', style: { textAlign: 'right' } }, libUnite(l.uniteCode))),
          el('td', { style: { width: '110px' } }, input(l, 'prixUnitaireHT', { type: 'number', min: 0, step: '0.01', style: { textAlign: 'right' } })),
          el('td', { style: { width: '72px' } }, input(l, 'tauxTVA', { type: 'number', min: 0, max: 100, step: '0.1', style: { textAlign: 'right' } })),
          el('td', null, selOt),
          el('td', { class: 'num texte-gras', style: { paddingTop: '11px', whiteSpace: 'nowrap' }, dataset: { montant: i } }, montant(arrondi(num(l.quantite) * num(l.prixUnitaireHT)))),
          el('td', { style: { width: '34px' } }, verrouille ? null : el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer la ligne', onclick: () => { rows.splice(i, 1); rendre(true); } }, icone('supprimer')))));
      });
      majTotaux();
      if (changement && onChange) onChange(calcul(), valeurs());
    }
    remplirArticles();
    racine.appendChild(el('div', { class: 'barre-outils', style: { marginBottom: '8px' } }, el('div', { class: 'ach-recherche-article' }, champArticle, suggestions), btnLibre, el('span', { class: 'espace' }), el('span', { class: 'texte-2 texte-petit' }, 'Prix et références repris de la fiche article ; TVA par défaut ', `${ui.formatNombre(tvaDefaut)} %`)));
    racine.appendChild(el('div', { class: 'tableau-conteneur', style: { boxShadow: 'none' } }, el('table', { class: 'ach-lignes' },
      el('thead', null, el('tr', null, el('th', null, '#'), el('th', null, 'Désignation'), el('th', null, 'Réf. fournisseur'), el('th', { class: 'num' }, 'Qté'), el('th', { class: 'num' }, 'PU HT'), el('th', { class: 'num' }, 'TVA %'), el('th', null, 'OT'), el('th', { class: 'num' }, 'Montant HT'), el('th', null, ''))),
      corps)));
    racine.appendChild(totaux);
    racine.appendChild(messageSeuil);
    rendre(false);
    return {
      el: racine,
      majFournisseur: remplirArticles,
      totaux: calcul,
      valider() {
        if (!rows.length) return 'Ajoutez au moins une ligne';
        for (const [i, l] of rows.entries()) {
          if (!String(l.designation || '').trim()) return `Ligne ${i + 1} : désignation obligatoire`;
          if (!(num(l.quantite) > 0)) return `Ligne ${i + 1} : quantité supérieure à 0 obligatoire`;
          if (l.prixUnitaireHT === '' || num(l.prixUnitaireHT) < 0) return `Ligne ${i + 1} : prix unitaire HT invalide`;
          if (num(l.tauxTVA) < 0 || num(l.tauxTVA) > 100) return `Ligne ${i + 1} : taux de TVA invalide`;
        }
        return '';
      },
      valeurs,
    };
  }

  // =================================================================================================
  // FORMULAIRE COMMANDE
  // =================================================================================================
  function ouvrirFormCommande(existant, options = {}) { return ouvrirUnique(() => formCommande(existant, options)); }
  async function formCommande(existant, options = {}) {
    let refs;
    try { refs = await references(true); } catch (e) { erreur(e); return; }
    const creation = !existant;
    const verrouillee = !!existant && STATUTS_CMD_OUVERTS.includes(existant.statut);
    const base = existant || options.modele || {};
    const fournisseurs = refs.fournisseurs.filter((f) => f.actif || (base.fournisseurId && f.id === base.fournisseurId));
    const optsSecteurs = optionsSecteursEcriture();
    if (existant && base.secteurId && !optsSecteurs.some((o) => String(o.value) === String(base.secteurId))) optsSecteurs.push({ value: base.secteurId, label: ui.cheminSecteur(base.secteurId) || ui.nomSecteur(base.secteurId) });
    const secteurParDefaut = (base.secteurId && optsSecteurs.some((o) => String(o.value) === String(base.secteurId)) ? base.secteurId : '') || (() => { const u = GMAO.user || {}; const s = (u.secteurIds || []).find((x) => optsSecteurs.some((o) => String(o.value) === String(x))); return s || ''; })();
    let editeur = null;
    let livraisonTouchee = !!base.dateLivraisonPrevue;
    const champs = [
      { type: 'separateur', label: 'Fournisseur et imputation' },
      { nom: 'fournisseurId', label: 'Fournisseur', type: 'select', requis: true, disabled: verrouillee, options: [{ value: '', label: '— Choisir le fournisseur —' }].concat(fournisseurs.map((f) => ({ value: f.id, label: f.nom + (f.actif ? '' : ' (désactivé)') }))),
        onChange: (v, form) => { if (editeur) editeur.majFournisseur(); const f = fournisseurs.find((x) => x.id === Number(v)); if (f && f.delaiLivraisonJours != null && !livraisonTouchee) form.set('dateLivraisonPrevue', ajouterJours(form.get('dateCommande') || aujourdhui(), f.delaiLivraisonJours)); } },
      { nom: 'secteurId', label: 'Site / service', type: 'select', requis: true, disabled: verrouillee, options: optsSecteurs, aide: 'Détermine qui voit et valide la commande (multi-site).' },
      { nom: 'categorieCode', label: 'Catégorie de dépense', type: 'select', liste: 'categoriesDepense', vide: false },
      { nom: 'objet', label: 'Objet', type: 'texte', placeholder: 'ex. Réapprovisionnement roulements ligne 1', maxLength: 200 },
      { nom: 'dateCommande', label: 'Date de commande', type: 'date', requis: true, disabled: verrouillee },
      { nom: 'dateLivraisonPrevue', label: 'Livraison souhaitée', type: 'date', onChange: () => { livraisonTouchee = true; } },
      { type: 'separateur', label: 'Lignes de commande' },
      // Empreinte des lignes : une ligne ajoutée ou modifiée compte comme une saisie à ne pas perdre (confirmation avant fermeture)
      { nom: 'lignesEmpreinte', type: 'cache' },
      { type: 'html', rendu: (form) => {
        editeur = editeurLignes({ lignes: base.lignes || [], articles: refs.articles, ots: refs.ot, getFournisseurId: () => form.get('fournisseurId'), verrouille: verrouillee, onChange: (t, lignes) => form.set('lignesEmpreinte', JSON.stringify(lignes)) });
        return frag(verrouillee ? ui.alerte('Commande validée : les lignes, le fournisseur et le site ne sont plus modifiables. Seuls l\'objet, la catégorie, la livraison, les conditions et le commentaire peuvent être mis à jour.', 'info') : null, editeur.el);
      } },
      { type: 'separateur', label: 'Livraison et conditions' },
      { nom: 'adresseLivraison', label: 'Lieu de livraison', type: 'texte', placeholder: (GMAO.config.societe || {}).adresse ? 'Adresse de la société par défaut' : 'ex. Quai 2, magasin central', maxLength: 500 },
      { nom: 'conditions', label: 'Conditions particulières (imprimées sur le bon)', type: 'texte', placeholder: 'ex. Franco de port, livraison avant 10 h', maxLength: 2000 },
      { nom: 'commentaire', label: 'Commentaire interne', type: 'texte_long', lignes: 2, maxLength: 5000 },
      ...ui.champsPersoDefs('commandes'),
    ];
    const valeurs = Object.assign({
      fournisseurId: base.fournisseurId || '', secteurId: secteurParDefaut, categorieCode: base.categorieCode || ((GMAO.liste('categoriesDepense').find((x) => x.code === 'pieces') || GMAO.liste('categoriesDepense')[0] || {}).code || ''),
      objet: base.objet || '', dateCommande: (existant && existant.dateCommande) || aujourdhui(), dateLivraisonPrevue: base.dateLivraisonPrevue || '',
      adresseLivraison: base.adresseLivraison || '', conditions: base.conditions || '', commentaire: base.commentaire || '',
      lignesEmpreinte: JSON.stringify((base.lignes || []).map((l) => ({ articleId: l.articleId == null ? null : Number(l.articleId), designation: String(l.designation || '').trim(), referenceFournisseur: String(l.referenceFournisseur || '').trim(), quantite: num(l.quantite), prixUnitaireHT: num(l.prixUnitaireHT), tauxTVA: num(l.tauxTVA), otId: l.otId == null || l.otId === '' ? null : Number(l.otId), uniteCode: l.uniteCode || '' }))),
    }, ui.champsPersoInitiaux(base));
    async function envoyer(v, soumettre) {
      const err = editeur.valider();
      if (err && !verrouillee) { toast(err, 'erreur'); return false; }
      const body = { fournisseurId: v.fournisseurId, secteurId: v.secteurId, categorieCode: v.categorieCode || '', objet: v.objet, dateCommande: v.dateCommande, dateLivraisonPrevue: v.dateLivraisonPrevue || null, adresseLivraison: v.adresseLivraison, conditions: v.conditions, commentaire: v.commentaire, champs: ui.champsPersoValeurs(v) };
      if (!verrouillee) body.lignes = editeur.valeurs(); else { delete body.fournisseurId; delete body.secteurId; delete body.dateCommande; }
      if (creation && soumettre) body.soumettre = true;
      let res = creation ? await api.post('/api/commandes', body) : await api.put('/api/commandes/' + existant.id, body);
      if (!creation && soumettre) res = await api.post(`/api/commandes/${res.id}/soumettre`);
      invaliderRefs(); majBadge();
      toast(soumettre ? (res.statut === 'a_valider' ? `Commande ${res.numero} soumise à validation` : `Commande ${res.numero} validée (sous le seuil)`) : (creation ? `Commande ${res.numero} enregistrée en brouillon` : `Commande ${res.numero} enregistrée`), 'succes');
      if (options.apres) options.apres(res); else GMAO.navigate('#/achats/commande/' + res.id);
      return true;
    }
    const peutSoumettre = creation || (existant && existant.statut === 'brouillon' && existant.actions && existant.actions.soumettre);
    ui.formModal({
      titre: creation ? (options.modele ? 'Nouvelle commande (copie)' : 'Nouvelle commande fournisseur') : `Modifier la commande ${existant.numero}`,
      taille: 'tres-large', champs, valeurs,
      submitLabel: creation ? 'Enregistrer le brouillon' : 'Enregistrer',
      boutonsSupp: peutSoumettre ? [{ label: 'Enregistrer et soumettre', icone: 'check', classe: 'btn-ok a-gauche', onClic: async (form) => { if (!form.valider()) return false; return envoyer(form.valeurs(), true); } }] : [],
      onSubmit: async (v) => envoyer(v, false),
    });
  }

  // =================================================================================================
  // COMMANDER LES ALERTES DE STOCK
  // =================================================================================================
  function ouvrirAlertesStock(apres) { return ouvrirUnique(() => alertesStock(apres)); }
  async function alertesStock(apres) {
    let alertes;
    try { alertes = await api.get('/api/achats/alertes-stock'); } catch (e) { erreur(e); return; }
    if (!alertes.length) { ui.modal({ titre: 'Commander les alertes de stock', taille: 'petite', contenu: ui.vide('Aucun article n\'est sous son seuil minimum.', 'check'), boutons: [{ label: 'Fermer' }] }); return; }
    const choix = new Map(alertes.filter((a) => a.fournisseurId && a.fournisseurActif !== false && a.resteACommander > 0).map((a) => [a.id, a.resteACommander]));
    const optsSect = optionsSecteursEcriture('— Site / service des commandes —');
    const u = GMAO.user || {};
    const defaut = (u.secteurIds || []).find((x) => optsSect.some((o) => String(o.value) === String(x))) || (optsSect[1] ? optsSect[1].value : '');
    const selSecteur = selectFiltre(optsSect, defaut, () => {}, 'Site / service de rattachement des commandes');
    const totalEl = el('strong');
    const majTotal = () => { let t = 0; for (const a of alertes) if (choix.has(a.id)) t += num(choix.get(a.id)) * num(a.prixUnitaire); const nbF = new Set(alertes.filter((a) => choix.has(a.id)).map((a) => a.fournisseurId)).size; totalEl.textContent = `${pluriel(choix.size, 'article')} · ${pluriel(nbF, 'brouillon')} de commande · ${montant(t)} HT estimés`; };
    const groupes = new Map();
    for (const a of alertes) { const k = a.fournisseurNom || 'Sans fournisseur habituel'; if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(a); }
    const corps = el('div');
    for (const [nomF, liste] of Array.from(groupes.entries()).sort((x, y) => (x[0] === 'Sans fournisseur habituel') - (y[0] === 'Sans fournisseur habituel') || x[0].localeCompare(y[0], 'fr'))) {
      const sans = !liste[0].fournisseurId;
      const tbody = el('tbody');
      for (const a of liste) {
        // Quantité proposée = besoin restant, déduction faite des commandes en cours (0 si le besoin est déjà couvert)
        const couvert = a.dejaEnCommande > 0 && !(a.resteACommander > 0);
        const cb = el('input', { type: 'checkbox', checked: choix.has(a.id), disabled: sans || a.fournisseurActif === false || !(a.resteACommander > 0) });
        const q = el('input', { type: 'number', min: 0, step: 'any', value: String(a.resteACommander), disabled: sans, style: { width: '90px', textAlign: 'right' } });
        const mt = el('td', { class: 'num' }, montant(num(q.value) * num(a.prixUnitaire)));
        cb.addEventListener('change', () => { if (cb.checked && num(q.value) > 0) choix.set(a.id, num(q.value)); else choix.delete(a.id); majTotal(); });
        q.addEventListener('input', () => {
          mt.textContent = montant(num(q.value) * num(a.prixUnitaire));
          cb.disabled = sans || a.fournisseurActif === false || !(num(q.value) > 0);
          if (cb.disabled) cb.checked = false;
          if (cb.checked) { if (num(q.value) > 0) choix.set(a.id, num(q.value)); else choix.delete(a.id); } else choix.delete(a.id);
          majTotal();
        });
        tbody.appendChild(el('tr', null, el('td', null, cb),
          el('td', null, el('div', { class: 'texte-gras' }, a.designation), el('div', { class: 'ach-info' }, [a.code, a.referenceFournisseur ? `réf. ${a.referenceFournisseur}` : '', a.emplacement].filter(Boolean).join(' · ')),
            couvert ? el('div', { class: 'ach-info texte-ok' }, `Besoin couvert par ${(a.commandesEnCours || []).length ? (a.commandesEnCours || []).map((c) => c.numero).join(', ') : 'une commande en cours'}`) : null),
          el('td', { class: 'num' }, el('span', { class: a.quantite <= 0 ? 'texte-danger texte-gras' : 'texte-alerte texte-gras' }, ui.formatNombre(a.quantite)), el('span', { class: 'texte-2' }, ` / ${ui.formatNombre(a.seuilMin)} ${libUnite(a.uniteCode)}`)),
          el('td', { class: 'num' }, a.dejaEnCommande ? el('span', { title: (a.commandesEnCours || []).map((c) => c.numero).join(', ') }, ui.formatNombre(a.dejaEnCommande), el('div', { class: 'ach-info' }, (a.commandesEnCours || []).map((c) => c.numero).join(', '))) : el('span', { class: 'texte-2' }, '—')),
          el('td', { class: 'num' }, q),
          el('td', { class: 'num' }, montant(a.prixUnitaire)), mt));
      }
      corps.appendChild(el('div', { class: 'mb' },
        el('div', { class: 'inline', style: { margin: '10px 0 6px', fontWeight: '600' } }, iconeDim('fournisseurs', 16, 'var(--primaire)'), nomF, liste[0].delaiLivraisonJours != null ? el('span', { class: 'texte-2 texte-petit', style: { fontWeight: '400' } }, `· délai ${liste[0].delaiLivraisonJours} j`) : null, sans ? el('span', { class: 'texte-alerte texte-petit', style: { fontWeight: '400' } }, '· renseignez le fournisseur habituel sur la fiche article') : null),
        el('div', { class: 'tableau-conteneur', style: { boxShadow: 'none' } }, el('table', { class: 'ach-lignes' }, el('thead', null, el('tr', null, el('th', { style: { width: '30px' } }, ''), el('th', null, 'Article'), el('th', { class: 'num' }, 'Stock / seuil'), el('th', { class: 'num' }, 'Déjà commandé'), el('th', { class: 'num' }, 'À commander'), el('th', { class: 'num' }, 'PU HT'), el('th', { class: 'num' }, 'Montant HT'))), tbody))));
    }
    majTotal();
    ui.modal({
      titre: 'Commander les alertes de stock', taille: 'tres-large',
      contenu: frag(
        el('p', { class: 'texte-2' }, 'Articles sous leur seuil minimum. Un brouillon de commande est créé par fournisseur avec les quantités proposées (déduction faite des quantités déjà en commande) ; vous pourrez le compléter avant de le soumettre.'),
        el('div', { class: 'barre-outils' }, el('label', { class: 'inline' }, 'Rattacher les commandes à', selSecteur), el('span', { class: 'espace' }), totalEl),
        corps),
      boutons: [{ label: 'Annuler' }, { label: 'Créer les brouillons', icone: 'achats', classe: 'btn-primaire', onClic: async () => {
        if (!choix.size) { toast('Sélectionnez au moins un article', 'alerte'); return false; }
        const r = await api.post('/api/commandes/depuis-alertes', { secteurId: selSecteur.value || null, lignes: Array.from(choix.entries()).map(([articleId, quantite]) => ({ articleId, quantite })) });
        invaliderRefs();
        if (r.commandes.length) toast(`${pluriel(r.commandes.length, 'brouillon')} de commande créé${r.commandes.length > 1 ? 's' : ''} (${r.commandes.map((c) => c.numero).join(', ')})`, 'succes');
        if (r.ignores.length) toast(`${pluriel(r.ignores.length, 'article ignoré', 'articles ignorés')} : ${r.ignores.map((x) => `${x.designation} (${x.raison})`).join(' ; ')}`, 'alerte', 9000);
        if (r.commandes.length === 1) GMAO.navigate('#/achats/commande/' + r.commandes[0].id);
        else if (apres) apres(r);
      } }],
    });
  }

  // =================================================================================================
  // FICHE COMMANDE
  // =================================================================================================
  const ETAPES_CMD = [
    { label: 'Brouillon', codes: ['brouillon'] }, { label: 'À valider', codes: ['a_valider'] }, { label: 'Validée', codes: ['validee'] },
    { label: 'Envoyée', codes: ['envoyee'] }, { label: 'Reçue', codes: ['partielle', 'recue'], final: true },
  ];
  function etapesCommande(c) {
    const liste = ETAPES_CMD.filter((e) => e.codes[0] !== 'a_valider' || c.validationRequise || c.statut === 'a_valider').map((e) => Object.assign({}, e, { label: e.codes[0] === 'brouillon' ? lib('statutsCommande', 'brouillon', 'Brouillon') : (e.codes.includes('partielle') && c.statut === 'partielle' ? lib('statutsCommande', 'partielle', 'Reçue partiellement') : lib('statutsCommande', e.codes[e.codes.length - 1], e.label)) }));
    liste[liste.length - 1].final = c.statut === 'recue';
    if (c.statut === 'annulee') {
      const etapeAtteinte = c.dateEnvoi ? 'envoyee' : (c.dateValidation ? 'validee' : (c.dateSoumission ? 'a_valider' : 'brouillon'));
      const l = liste.slice(0, liste.findIndex((e) => e.codes.includes(etapeAtteinte)) + 1).concat([{ label: lib('statutsCommande', 'annulee', 'Annulée'), codes: ['annulee'] }]);
      return etapes(l, 'annulee', { echec: true });
    }
    return etapes(liste, c.statut);
  }

  function rendreLignesCommande(c) {
    const lignes = c.lignes || [];
    const avecReception = !['brouillon', 'a_valider'].includes(c.statut);
    const t = ui.table({
      lignes, recherche: lignes.length > 10 ? 'Rechercher une ligne…' : false, pagination: false, compact: true, cleId: 'index',
      colonnes: [
        { cle: 'index', label: '#', rendu: (l) => String(l.index + 1), valeurTri: (l) => l.index },
        { cle: 'designation', label: 'Désignation', rendu: (l) => frag(el('div', { class: 'cellule-principale' }, l.designation), el('div', { class: 'cellule-secondaire' }, [l.articleCode ? (GMAO.can('stock', 'voir') ? lienVue('#/stock/' + l.articleId, l.articleCode) : l.articleCode) : 'Ligne libre', l.articleStock != null ? ` · stock ${ui.formatNombre(l.articleStock)}` : ''])) },
        { cle: 'referenceFournisseur', label: 'Réf. fournisseur' },
        { cle: 'quantite', label: 'Qté', aligner: 'droite', rendu: (l) => `${ui.formatNombre(l.quantite)} ${libUnite(l.uniteCode)}`.trim() },
        avecReception ? { cle: 'quantiteRecue', label: 'Reçu', aligner: 'droite', rendu: (l) => el('span', { class: num(l.quantiteRecue) >= num(l.quantite) ? 'texte-ok texte-gras' : (num(l.quantiteRecue) > 0 ? 'texte-alerte texte-gras' : 'texte-2') }, ui.formatNombre(l.quantiteRecue)) } : null,
        avecReception ? { cle: 'resteARecevoir', label: 'Reste', aligner: 'droite', rendu: (l) => (l.resteARecevoir > 0 && c.statut !== 'annulee' && !c.solde ? ui.formatNombre(l.resteARecevoir) : el('span', { class: 'texte-2' }, '—')) } : null,
        { cle: 'prixUnitaireHT', label: 'PU HT', aligner: 'droite', rendu: (l) => montant(l.prixUnitaireHT) },
        { cle: 'tauxTVA', label: 'TVA', aligner: 'droite', rendu: (l) => `${ui.formatNombre(l.tauxTVA)} %` },
        { cle: 'otNumero', label: 'OT', rendu: (l) => (l.otId ? (GMAO.can('ot', 'voir') ? lienVue('#/ot/' + l.otId, l.otNumero || `#${l.otId}`) : l.otNumero) : el('span', { class: 'texte-2' }, '—')) },
        { cle: 'montantHT', label: 'Montant HT', aligner: 'droite', rendu: (l) => el('span', { class: 'texte-gras' }, montant(l.montantHT)) },
      ].filter(Boolean),
    });
    const totaux = el('div', { class: 'ach-totaux' },
      el('span', { class: 'lib' }, 'Total HT'), el('span', { class: 'val' }, montant(c.totaux.ht)),
      el('span', { class: 'lib' }, 'TVA'), el('span', { class: 'val' }, montant(c.totaux.tva)),
      el('span', { class: 'lib ttc' }, 'Total TTC'), el('span', { class: 'val ttc' }, montant(c.totaux.ttc)));
    return frag(t.el, totaux);
  }

  function rendreInfosCommande(c) {
    const cont = el('div');
    cont.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } },
      ui.carte('Commande', ui.details([
        { label: 'Fournisseur', valeur: c.fournisseur ? frag(GMAO.can('fournisseurs', 'voir') ? lienVue('#/fournisseurs/' + c.fournisseur.id, c.fournisseur.nom) : c.fournisseur.nom, c.fournisseur.actif === false ? ui.badge('désactivé', '#6b7280', { classe: 'ml' }) : null) : c.fournisseurNom },
        { label: 'Contact', valeur: c.fournisseur ? [c.fournisseur.contact, c.fournisseur.telephone, c.fournisseur.email].filter(Boolean).join(' · ') : '' },
        { label: 'Site / service', valeur: c.secteurChemin },
        { label: 'Catégorie', valeur: ui.badgeListe('categoriesDepense', c.categorieCode) },
        { label: 'Objet', valeur: c.objet },
        { label: 'Date de commande', valeur: dateFr(c.dateCommande) },
        { label: 'Livraison souhaitée', valeur: c.dateLivraisonPrevue ? el('span', { class: c.enRetardLivraison ? 'texte-danger texte-gras' : '' }, dateFr(c.dateLivraisonPrevue) + (c.enRetardLivraison ? ` (retard ${c.joursRetardLivraison} j)` : '')) : '' },
        { label: 'Lieu de livraison', valeur: c.adresseLivraison || ((GMAO.config.societe || {}).adresse ? 'Adresse de la société' : '') },
        { label: 'Conditions', valeur: c.conditions },
      ])),
      ui.carte('Circuit', ui.details([
        { label: 'Demandeur', valeur: c.demandeurNom },
        { label: 'Saisie par', valeur: c.createdByNom },
        { label: 'Validation', valeur: c.validationAuto ? el('span', null, 'Automatique', el('span', { class: 'texte-2' }, ` (sous le seuil de ${montant(c.seuilValidationHT)} HT)`)) : (c.valideurNom ? `${c.valideurNom} — ${ui.formatDateHeure(c.dateValidation)}` : (c.validationRequise ? el('span', { class: 'texte-alerte' }, `requise (≥ ${montant(c.seuilValidationHT)} HT)`) : '')) },
        { label: 'Envoi au fournisseur', valeur: c.dateEnvoi ? dateFr(c.dateEnvoi) : '' },
        { label: 'Réception', valeur: ['brouillon', 'a_valider', 'annulee'].includes(c.statut) ? '' : frag(progression(c.tauxReception), c.dateReceptionComplete ? el('div', { class: 'texte-2 texte-petit' }, `complète le ${dateFr(c.dateReceptionComplete)}${c.solde ? ' (soldée)' : ''}`) : null) },
        { label: 'Montant reçu HT', valeur: c.nbReceptions ? montant(c.montantRecuHT) : '' },
        { label: 'Facturé HT', valeur: c.nbFactures ? `${montant(c.montantFactureHT)} (${pluriel(c.nbFactures, 'facture')})` : '' },
        { label: 'Commentaire', valeur: c.commentaire ? el('div', { style: { whiteSpace: 'pre-wrap' } }, c.commentaire) : '' },
        ...ui.champsPersoAffichage('commandes', c),
      ]))));
    cont.appendChild(ui.carte(`Lignes (${(c.lignes || []).length})`, rendreLignesCommande(c)));
    return cont;
  }

  function rendreReceptions(c) {
    const cont = el('div');
    if (c.entreeStockAReception) cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Les quantités reçues des lignes liées à un article du stock sont entrées automatiquement en stock (mouvement d\'entrée au prix de la commande).'));
    if (!(c.receptions || []).length) { cont.appendChild(ui.vide('Aucune réception enregistrée.', 'stock')); return cont; }
    for (const r of c.receptions) {
      cont.appendChild(ui.carte(frag(`Réception du ${dateFr(r.date)}`, r.bonLivraison ? el('span', { class: 'texte-2', style: { fontWeight: '400', marginLeft: '8px' } }, `BL ${r.bonLivraison}`) : null),
        frag(el('div', { class: 'texte-2 texte-petit mb' }, `Enregistrée par ${r.userNom || '—'} le ${ui.formatDateHeure(r.createdAt)} · ${montant(r.montantHT)} HT${r.commentaire ? ' · ' + r.commentaire : ''}`),
          ui.table({ lignes: r.lignes, recherche: false, pagination: false, compact: true, cleId: 'index', colonnes: [
            { cle: 'designation', label: 'Ligne', rendu: (l) => `${l.index + 1}. ${l.designation}` },
            { cle: 'quantite', label: 'Quantité reçue', aligner: 'droite', rendu: (l) => `${ui.formatNombre(l.quantite)} ${libUnite(l.uniteCode)}`.trim() },
            { cle: 'mouvementId', label: 'Entrée en stock', rendu: (l) => (l.mouvementId ? ui.badge('Oui', '#16a34a') : el('span', { class: 'texte-2' }, '—')) },
          ] }).el)));
    }
    return cont;
  }

  function rendreFacturesCommande(c, recharger) {
    const cont = el('div');
    const facturable = c.actions && c.actions.facturer && !lectureSeule(c);
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `Facturé : ${montant(c.montantFactureHT)} HT sur ${montant(c.totaux.ht)} HT commandés${c.nbReceptions ? ` (${montant(c.montantRecuHT)} HT reçus)` : ''}`),
      el('span', { class: 'espace' }),
      facturable ? ui.bouton('Saisir une facture', { icone: 'facture', classe: 'btn-primaire btn-sm', onClic: () => ouvrirFormFacture(null, { commandeId: c.id, apres: recharger }) }) : null));
    if (!(c.factures || []).length) { cont.appendChild(ui.vide('Aucune facture rattachée à cette commande.', 'facture')); return cont; }
    cont.appendChild(ui.table({ lignes: c.factures, recherche: false, pagination: false, onClic: (f) => GMAO.navigate('#/achats/facture/' + f.id), colonnes: [
      { cle: 'numero', label: 'N° interne', rendu: (f) => el('span', { class: 'cellule-principale' }, f.numero) },
      { cle: 'numeroFournisseur', label: 'N° fournisseur' },
      { cle: 'dateFacture', label: 'Date', rendu: (f) => dateFr(f.dateFacture) },
      { cle: 'dateEcheance', label: 'Échéance', rendu: (f) => dateFr(f.dateEcheance) },
      { cle: 'montantHT', label: 'HT', aligner: 'droite', rendu: (f) => montant(f.montantHT) },
      { cle: 'montantTTC', label: 'TTC', aligner: 'droite', rendu: (f) => el('span', { class: 'texte-gras' }, montant(f.montantTTC)) },
      { cle: 'statut', label: 'Statut', liste: 'statutsFacture' },
    ] }).el);
    return cont;
  }

  function rendreHistorique(h) {
    if (!(h || []).length) return ui.vide('Aucun historique.', 'horloge');
    const libs = { creation: 'Création', modification: 'Modification', soumission: 'Soumission à validation', validation: 'Validation', refus: 'Refus', envoi: 'Envoi au fournisseur', reception: 'Réception', solde: 'Solde du reliquat', annulation: 'Annulation', paiement: 'Paiement', litige: 'Mise en litige' };
    return el('ul', { class: 'chronologie' }, h.map((x) => el('li', null,
      el('div', null, el('strong', null, libs[x.action] || x.action), x.userNom ? el('span', { class: 'texte-2' }, ` — ${x.userNom}`) : null),
      x.details ? el('div', { class: 'texte-petit' }, x.details) : null,
      el('div', { class: 'chrono-date' }, ui.formatDateHeure(x.date)))));
  }

  /** Documents (commande ou facture) : liste, aperçu PDF / image, ajout, suppression. */
  function rendreDocuments(type, r, recharger, { apercu = false } = {}) {
    const base = `/api/${type === 'facture' ? 'factures' : 'commandes'}/${r.id}/documents`;
    const cont = el('div');
    const peut = r.actions && r.actions.documents && !lectureSeule(r);
    const zoneApercu = el('div', { class: 'mt' });
    let urlCourante = null;
    async function afficher(d) {
      cont.querySelectorAll('.ach-doc').forEach((x) => x.classList.toggle('actif', Number(x.dataset.index) === d.index));
      ui.vider(zoneApercu);
      if (!d.estPdf && !d.estImage) { zoneApercu.appendChild(el('div', { class: 'texte-2 texte-petit' }, 'Aperçu indisponible pour ce format : utilisez « Télécharger ».')); return; }
      if (d.estPdf && navigator.pdfViewerEnabled === false) {
        // Lecteur PDF intégré indisponible sur ce poste : fiche du document avec ouverture / téléchargement
        zoneApercu.appendChild(el('div', { class: 'ach-pdf-repli' }, iconeDim('facture', 40, 'var(--danger)'), el('div', { class: 'texte-gras', style: { color: 'var(--texte)' } }, d.nom),
          el('div', { class: 'texte-petit' }, `Document PDF · ${tailleLisible(d.taille)} — l'aperçu intégré n'est pas disponible sur ce poste.`),
          el('div', { class: 'inline' }, el('a', { class: 'btn btn-sm', href: `${base}/${d.index}`, target: '_blank', rel: 'noopener' }, icone('voir'), 'Ouvrir'),
            el('button', { type: 'button', class: 'btn btn-sm btn-primaire', onclick: () => api.telecharger(`${base}/${d.index}?telecharger=1`, d.nom).catch(erreur) }, icone('export'), 'Télécharger'))));
        return;
      }
      zoneApercu.appendChild(ui.chargement('Chargement de l\'aperçu…'));
      try {
        const h = { 'X-Requested-With': 'GMAO' };
        if (api.siteCourant()) h['X-GMAO-Site'] = api.siteCourant();
        const res = await fetch(`${base}/${d.index}`, { credentials: 'same-origin', headers: h });
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        const blob = await res.blob();
        if (urlCourante) URL.revokeObjectURL(urlCourante);
        urlCourante = URL.createObjectURL(new Blob([blob], { type: d.type }));
        ui.vider(zoneApercu);
        zoneApercu.appendChild(d.estPdf ? el('iframe', { class: 'ach-apercu', src: urlCourante, title: `Aperçu de ${d.nom}` }) : el('img', { class: 'ach-apercu-img', src: urlCourante, alt: d.nom }));
      } catch (e) { ui.vider(zoneApercu); zoneApercu.appendChild(ui.alerte('Aperçu impossible : ' + e.message, 'alerte')); }
    }
    const docs = r.documents || [];
    cont.appendChild(el('div', { class: 'barre-outils', style: { marginBottom: '8px' } },
      el('span', { class: 'texte-2 texte-petit' }, type === 'facture' ? 'PDF ou image (PNG, JPEG), 10 Mo maximum' : 'Devis, accusé de réception, bon de livraison… (PDF, image, bureautique — 10 Mo maximum)'),
      el('span', { class: 'espace' }),
      peut ? ui.bouton('Joindre un fichier', { icone: 'piece_jointe', classe: 'btn-sm btn-primaire', onClic: () => ouvrirAjoutDocument(type, r, recharger) }) : null));
    if (!docs.length) { cont.appendChild(ui.vide(type === 'facture' ? 'Aucune pièce jointe : joignez la facture du fournisseur (PDF ou scan).' : 'Aucun document joint.', 'piece_jointe')); return cont; }
    cont.appendChild(el('div', { class: 'ach-docs' }, docs.map((d) => el('div', { class: 'ach-doc', dataset: { index: d.index } },
      iconeDim(d.estPdf ? 'facture' : (d.estImage ? 'camera' : 'piece_jointe'), 18, d.estPdf ? 'var(--danger)' : 'var(--texte-2)'),
      el('span', { class: 'ach-doc-nom', title: d.nom, onclick: () => afficher(d) }, d.nom),
      el('span', { class: 'texte-2 texte-petit', style: { whiteSpace: 'nowrap' } }, `${tailleLisible(d.taille)} · ${dateFr(String(d.date || '').slice(0, 10))}`),
      (d.estPdf || d.estImage) ? el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Aperçu', onclick: () => afficher(d) }, icone('voir')) : null,
      el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Télécharger', onclick: () => api.telecharger(`${base}/${d.index}?telecharger=1`, d.nom).catch(erreur) }, icone('export')),
      peut ? el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer', onclick: async () => {
        if (!(await ui.confirm({ titre: 'Supprimer la pièce jointe', message: `Supprimer « ${d.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
        try { await api.del(`${base}/${d.index}`); toast('Pièce jointe supprimée', 'succes'); recharger(); } catch (e) { erreur(e); }
      } }, icone('supprimer')) : null))));
    cont.appendChild(zoneApercu);
    const premier = docs.find((d) => d.estPdf || d.estImage);
    if (apercu && premier) setTimeout(() => afficher(premier), 0);
    return cont;
  }

  function ouvrirAjoutDocument(type, r, apres) {
    ui.formModal({
      titre: `Joindre un fichier — ${r.numero}`, taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'fichier', label: 'Fichier', type: 'fichier', requis: true, tailleMax: TAILLE_MAX_DOC, accept: type === 'facture' ? 'application/pdf,image/png,image/jpeg,image/gif,image/webp' : undefined, aide: '10 Mo maximum.' },
        { nom: 'description', label: 'Description', type: 'texte', placeholder: type === 'facture' ? 'ex. Facture originale reçue par e-mail' : 'ex. Devis n° 2026-118, accusé de réception…' },
      ],
      submitLabel: 'Joindre',
      onSubmit: async (v) => {
        const f = v.fichier;
        if (!f || !f.contenu) { toast('Sélectionnez un fichier', 'erreur'); return false; }
        await api.post(`/api/${type === 'facture' ? 'factures' : 'commandes'}/${r.id}/documents`, { nom: f.nom, type: f.type, contenu: f.contenu, description: v.description || '' });
        toast('Fichier joint', 'succes');
        if (apres) apres();
      },
    });
  }

  function ouvrirReception(c, apres) {
    const lignes = (c.lignes || []).filter((l) => l.resteARecevoir > 0);
    if (!lignes.length) { toast('Toutes les lignes ont été reçues', 'info'); return; }
    const inputs = [];
    const recap = el('div', { class: 'texte-2 texte-petit', style: { marginTop: '6px', textAlign: 'right' } });
    /** Quantité saisie d'une ligne : nombre ≥ 0 et ≤ reste à recevoir, sinon message d'erreur (null). */
    function lire(i, l) {
      const brut = String(i.value || '').trim().replace(',', '.');
      const q = brut === '' ? 0 : Number(brut);
      if (!Number.isFinite(q) || q < 0) return { erreur: 'Quantité invalide : saisissez un nombre positif ou 0' };
      if (q > num(l.resteARecevoir) + 1e-9) return { erreur: `Au plus ${ui.formatNombre(l.resteARecevoir)} (reste à recevoir)` };
      return { quantite: q };
    }
    function controler(afficher) {
      let nb = 0; let ht = 0; let erreurs = 0;
      for (const [i, l, err] of inputs) {
        const r = lire(i, l);
        if (afficher) { i.classList.toggle('invalide', !!r.erreur); err.textContent = r.erreur || ''; }
        if (r.erreur) erreurs++; else if (r.quantite > 0) { nb++; ht += arrondi(r.quantite * num(l.prixUnitaireHT)); }
      }
      recap.className = 'texte-petit ' + (erreurs ? 'texte-danger' : 'texte-2');
      recap.textContent = erreurs ? `${pluriel(erreurs, 'ligne')} à corriger` : (nb ? `Seront réceptionnées : ${pluriel(nb, 'ligne')} sur ${lignes.length} · ${montant(ht)} HT` : 'Aucune quantité reçue saisie');
      return { nb, erreurs };
    }
    const tbody = el('tbody', null, lignes.map((l) => {
      const i = el('input', { type: 'number', min: 0, max: l.resteARecevoir, step: 'any', value: String(l.resteARecevoir), style: { width: '100px', textAlign: 'right' } });
      const err = el('div', { class: 'ach-erreur' });
      i.addEventListener('input', () => { const r = lire(i, l); i.classList.toggle('invalide', !!r.erreur); err.textContent = r.erreur || ''; controler(false); });
      inputs.push([i, l, err]);
      return el('tr', null,
        el('td', null, el('div', { class: 'texte-gras' }, `${l.index + 1}. ${l.designation}`), el('div', { class: 'ach-info' }, [l.referenceFournisseur, l.articleCode ? `article ${l.articleCode}` : 'ligne libre (hors stock)'].filter(Boolean).join(' · '))),
        el('td', { class: 'num' }, ui.formatNombre(l.quantite)), el('td', { class: 'num' }, ui.formatNombre(l.quantiteRecue)),
        el('td', { class: 'num texte-gras' }, ui.formatNombre(l.resteARecevoir)), el('td', { class: 'num' }, i, err), el('td', null, libUnite(l.uniteCode)));
    }));
    const tout = (valeur) => { inputs.forEach(([i, l]) => { i.value = valeur == null ? String(l.resteARecevoir) : valeur; }); controler(true); };
    // Douchette : un code article (ou une référence fournisseur) reconnu ajoute 1 à la ligne correspondante
    const champScan = el('input', { type: 'text', placeholder: 'Scanner ou saisir un code article', autocomplete: 'off', dataset: { scan: '1' } });
    const infoScan = el('span', { class: 'ach-scan-info' });
    const bip = (ok) => { try { if (window.CodeBarre && CodeBarre.bip) CodeBarre.bip(ok); } catch (e) { /* audio indisponible */ } };
    function scanner(code) {
      const c0 = normalTri(code).trim();
      if (!c0) return;
      const cible = inputs.find(([, l]) => normalTri(l.articleCode) === c0 || (l.referenceFournisseur && normalTri(l.referenceFournisseur) === c0));
      infoScan.className = 'ach-scan-info ' + (cible ? 'ok' : 'ko');
      if (!cible) { infoScan.textContent = `« ${code.trim()} » : aucune ligne de cette commande`; bip(false); return; }
      const [i, l] = cible;
      const actuel = lire(i, l);
      const q = (actuel.erreur ? 0 : actuel.quantite) + 1;
      if (q > num(l.resteARecevoir) + 1e-9) { infoScan.textContent = `${l.designation} : reste à recevoir atteint (${ui.formatNombre(l.resteARecevoir)})`; bip(false); return; }
      i.value = String(q); i.dispatchEvent(new Event('input'));
      infoScan.textContent = `${l.designation} : ${ui.formatNombre(q)} ${libUnite(l.uniteCode)}`.trim();
      bip(true);
    }
    champScan.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); scanner(champScan.value); champScan.value = ''; } });
    let arreterDouchette = () => {};
    const f = ui.form({ colonnes: 3, champs: [
      { nom: 'date', label: 'Date de réception', type: 'date', requis: true, valeur: aujourdhui(), max: aujourdhui(), min: c.dateCommande || undefined },
      { nom: 'bonLivraison', label: 'N° de bon de livraison', type: 'texte', placeholder: 'ex. BL-458721', maxLength: 100 },
      { nom: 'commentaire', label: 'Commentaire', type: 'texte', placeholder: 'ex. colis abîmé, reliquat annoncé…', maxLength: 1000 },
    ] });
    const m = ui.modal({
      titre: `Réceptionner la commande ${c.numero}`, taille: 'large',
      onFermer: () => arreterDouchette(),
      contenu: frag(f.el,
        el('div', { class: 'barre-outils mt', style: { marginBottom: '6px' } }, el('strong', null, 'Quantités livrées'), el('span', { class: 'espace' }),
          ui.bouton('Tout reçu', { classe: 'btn-sm', onClic: () => tout(null) }),
          ui.bouton('Remettre à zéro', { classe: 'btn-sm', onClic: () => tout('0') })),
        lignes.some((l) => l.articleCode) ? el('div', { class: 'ach-scan mb' }, iconeDim('codebarre', 16, 'var(--texte-2)'), champScan, infoScan) : null,
        el('div', { class: 'tableau-conteneur', style: { boxShadow: 'none' } }, el('table', { class: 'ach-lignes' }, el('thead', null, el('tr', null, el('th', null, 'Ligne'), el('th', { class: 'num' }, 'Commandé'), el('th', { class: 'num' }, 'Déjà reçu'), el('th', { class: 'num' }, 'Reste'), el('th', { class: 'num' }, 'Reçu ce jour'), el('th', null, ''))), tbody)),
        recap,
        c.entreeStockAReception ? el('p', { class: 'texte-2 texte-petit mt' }, 'Les lignes liées à un article du stock feront l\'objet d\'une entrée en stock automatique au prix de la commande.') : null),
      boutons: [{ label: 'Annuler' }, { label: 'Enregistrer la réception', icone: 'check', classe: 'btn-primaire', onClic: async () => {
        const ctrl = controler(true);
        if (ctrl.erreurs) { toast(`${pluriel(ctrl.erreurs, 'quantité invalide', 'quantités invalides')} : corrigez les lignes signalées`, 'erreur'); return false; }
        if (!f.valider()) return false;
        const v = f.valeurs();
        const lignesRecues = inputs.map(([i, l]) => ({ index: l.index, quantite: lire(i, l).quantite })).filter((x) => x.quantite > 0);
        if (!lignesRecues.length) { toast('Saisissez au moins une quantité reçue', 'alerte'); return false; }
        const res = await api.post(`/api/commandes/${c.id}/receptionner`, { date: v.date, bonLivraison: v.bonLivraison, commentaire: v.commentaire, lignes: lignesRecues });
        toast(`${res.statut === 'recue' ? 'Commande entièrement reçue' : 'Réception partielle enregistrée'}${res.nbEntreesStock ? ` · ${pluriel(res.nbEntreesStock, 'entrée')} en stock` : ''}`, 'succes');
        (res.avertissements || []).forEach((a) => toast(a, 'alerte'));
        majBadge();
        if (apres) apres(res);
      } }],
    });
    controler(false);
    if (window.CodeBarre && typeof CodeBarre.ecouterDouchette === 'function') {
      arreterDouchette = CodeBarre.ecouterDouchette((code) => scanner(code), { actif: () => m.el.isConnected && document.querySelector('.modal-fond:last-of-type') === m.el });
    }
  }

  /**
   * Bon de commande imprimable avec l'en-tête de la société (config.societe). Seule une commande validée (validée,
   * envoyée, reçue) produit un bon ; sinon le document est un projet de travail, marqué « NON VALIDÉ » ou « ANNULÉE ».
   */
  function imprimerBonCommande(c) {
    const esc = ui.esc;
    const soc = GMAO.config.societe || {};
    const four = c.fournisseur || { nom: c.fournisseurNom };
    const parTaux = new Map();
    for (const l of c.lignes || []) { const k = num(l.tauxTVA); const ht = num(l.montantHT); parTaux.set(k, (parTaux.get(k) || 0) + ht); }
    const nl = (s) => esc(s || '').replace(/\n/g, '<br>');
    const bloc = (...parts) => parts.filter((p) => p != null && p !== '').join('<br>');
    const bon = STATUTS_CMD_IMPRIMABLES.includes(c.statut);
    const annulee = c.statut === 'annulee';
    const mention = annulee ? `COMMANDE ANNULÉE${c.dateAnnulation ? ' LE ' + esc(ui.formatDate(c.dateAnnulation)).toUpperCase() : ''}` : (bon ? '' : `PROJET — NON VALIDÉ (${esc(String(c.statutLibelle || lib('statutsCommande', c.statut, c.statut)).toUpperCase())})`);
    const validation = bon && !c.validationAuto && c.valideurNom ? `<br>Commande validée par ${esc(c.valideurNom)} le ${esc(ui.formatDate(c.dateValidation))}.` : '';
    const lignes = (c.lignes || []).map((l) => `<tr><td>${esc(l.referenceFournisseur || '')}</td><td>${esc(l.designation)}${l.otNumero ? `<div class="petit">Imputation : ${esc(/^OT/i.test(l.otNumero) ? l.otNumero : 'OT ' + l.otNumero)}</div>` : ''}</td><td class="num">${esc(ui.formatNombre(l.quantite))}</td><td>${esc(libUnite(l.uniteCode))}</td><td class="num">${esc(montant(l.prixUnitaireHT))}</td><td class="num">${esc(ui.formatNombre(l.tauxTVA))} %</td><td class="num">${esc(montant(l.montantHT))}</td></tr>`).join('');
    const tva = Array.from(parTaux.entries()).sort((a, b) => a[0] - b[0]).map(([t, ht]) => `<tr><td>TVA ${esc(ui.formatNombre(t))} % (base ${esc(montant(ht))})</td><td class="num">${esc(montant(arrondi((ht * t) / 100)))}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${bon ? 'Bon de commande' : 'Projet de commande'} ${esc(c.numero)}</title><style>
      @page { size: A4; margin: 14mm; } body{font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#111;margin:0}
      .entete{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:3px solid #1f2937;padding-bottom:12px;margin-bottom:16px}
      .soc{display:flex;gap:12px;align-items:flex-start}.soc img{max-height:60px;max-width:150px}.soc .nom{font-size:18px;font-weight:700}.soc .coord{color:#444;line-height:1.45}
      .titre{text-align:right}.titre h1{font-size:20px;margin:0 0 4px;letter-spacing:.5px}.titre .num{font-size:15px;font-weight:700}
      .blocs{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}.bloc{border:1px solid #bbb;border-radius:6px;padding:9px 11px;line-height:1.5}.bloc h3{margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#555;letter-spacing:.5px}
      table.l{width:100%;border-collapse:collapse}table.l th,table.l td{border:1px solid #bbb;padding:5px 7px;vertical-align:top}table.l th{background:#eee;text-align:left;font-size:11px;text-transform:uppercase}
      .num{text-align:right;white-space:nowrap}.petit{font-size:10.5px;color:#555}
      .totaux{width:320px;margin:10px 0 0 auto;border-collapse:collapse}.totaux td{padding:4px 7px;border-bottom:1px solid #ddd}.totaux tr.ttc td{font-size:14px;font-weight:700;border-top:2px solid #111;border-bottom:0}
      .cond{margin-top:16px;border-top:1px solid #bbb;padding-top:8px;line-height:1.5}.sign{display:flex;gap:30px;margin-top:30px}.sign div{flex:1;border-top:1px solid #111;padding-top:5px;min-height:60px}
      .pied{margin-top:24px;font-size:10px;color:#666;text-align:center}@media screen{body{margin:24px auto;max-width:860px}}@media print{.noprint{display:none}}
      .bandeau{border:3px solid #b91c1c;color:#b91c1c;font-weight:700;font-size:15px;letter-spacing:1px;text-align:center;padding:8px;margin:0 0 14px}
      .filigrane{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:72px;font-weight:700;color:#b91c1c;opacity:.13;transform:rotate(-28deg);pointer-events:none;letter-spacing:4px}</style></head><body>
      ${mention ? `<div class="filigrane">${annulee ? 'ANNULÉE' : 'PROJET'}</div><div class="bandeau">${mention}</div>` : ''}
      <div class="entete"><div class="soc">${soc.logo ? `<img src="${esc(soc.logo)}" alt="">` : ''}<div><div class="nom">${esc(soc.nom || '')}</div><div class="coord">${bloc(nl(soc.adresse), soc.telephone ? `Tél. ${esc(soc.telephone)}` : '', esc(soc.email || ''))}</div></div></div>
      <div class="titre"><h1>${bon ? 'BON DE COMMANDE' : 'PROJET DE COMMANDE'}</h1><div class="num">N° ${esc(c.numero)}</div><div>du ${esc(dateFr(c.dateCommande))}</div></div></div>
      <div class="blocs"><div class="bloc"><h3>Fournisseur</h3>${bloc(`<strong>${esc(four.nom || '')}</strong>`, nl(four.adresse), four.contact ? `À l'attention de : ${esc(four.contact)}` : '', four.telephone ? `Tél. ${esc(four.telephone)}` : '', esc(four.email || ''), four.siret ? `<span class="petit">SIRET ${esc(four.siret)}</span>` : '')}</div>
      <div class="bloc"><h3>Livraison</h3>${bloc(`<strong>${esc(c.secteurChemin || '')}</strong>`, nl(c.adresseLivraison || soc.adresse || ''), c.dateLivraisonPrevue ? `Livraison souhaitée le <strong>${esc(dateFr(c.dateLivraisonPrevue))}</strong>` : '', `Demandeur : ${esc(c.demandeurNom || '')}`)}</div></div>
      ${c.objet ? `<p><strong>Objet :</strong> ${esc(c.objet)}</p>` : ''}
      <table class="l"><thead><tr><th style="width:110px">Réf. fournisseur</th><th>Désignation</th><th class="num">Qté</th><th>Unité</th><th class="num">PU HT</th><th class="num">TVA</th><th class="num">Montant HT</th></tr></thead><tbody>${lignes}</tbody></table>
      <table class="totaux"><tr><td>Total HT</td><td class="num">${esc(montant(c.totaux.ht))}</td></tr>${tva}<tr class="ttc"><td>Total TTC</td><td class="num">${esc(montant(c.totaux.ttc))}</td></tr></table>
      <div class="cond">${c.conditions ? `<strong>Conditions particulières :</strong> ${nl(c.conditions)}<br>` : ''}${bon ? `Merci de rappeler le numéro de commande <strong>${esc(c.numero)}</strong> sur le bon de livraison et la facture.` : (annulee ? 'Cette commande a été annulée : ce document ne vaut pas commande.' : 'Document de travail : cette commande n\'a pas été validée et ne vaut pas commande.')}${validation}</div>
      <div class="sign"><div>Émetteur<br><span class="petit">${esc(c.demandeurNom || '')}</span></div><div>Bon pour accord<br><span class="petit">${esc(bon && !c.validationAuto ? (c.valideurNom || '') : '')}</span></div><div>Accusé de réception du fournisseur<br><span class="petit">date, cachet et signature</span></div></div>
      <div class="pied">${esc(soc.nom || '')} — ${bon ? 'Bon de commande' : 'Projet de commande'} ${esc(c.numero)} — imprimé le ${esc(ui.formatDateHeure(new Date()))}</div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { toast('Fenêtre bloquée : autorisez les fenêtres surgissantes pour imprimer', 'alerte'); return; }
    w.document.write(html);
    w.document.close();
    ui.lancerImpression(w);
  }

  async function afficherCommande(container, id) {
    const entete = el('div'); const zone = el('div');
    container.appendChild(entete); container.appendChild(zone);
    const filAriane = [{ label: GMAO.moduleLabel(MODULE), href: '#/achats' }, { label: 'Commandes', href: '#/achats?onglet=commandes' }];
    let c;
    try { c = await api.get('/api/commandes/' + Number(id)); } catch (e) {
      entete.appendChild(ui.pageEntete({ titre: 'Commande', icone: 'achats', filAriane: filAriane.concat([{ label: 'Fiche' }]) }));
      zone.appendChild(ui.vide(e.status === 404 ? 'Commande introuvable ou hors de votre périmètre.' : e.message, 'alerte'));
      zone.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour aux commandes', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/achats?onglet=commandes') })));
      return;
    }
    const recharger = () => GMAO.navigate(location.hash.split('?')[0] === '#/achats/commande/' + c.id ? location.hash : '#/achats/commande/' + c.id);
    const ro = lectureSeule(c);
    const a = ro ? {} : (c.actions || {});
    // Une action à la fois : les boutons de la fiche sont désactivés pendant l'appel (double clic)
    let actionEnCours = false;
    const action = (url, corps, message) => async () => {
      if (actionEnCours) return;
      actionEnCours = true;
      const boutons = container.querySelectorAll('.page-actions button, .barre-outils button');
      boutons.forEach((b) => { b.disabled = true; });
      try { const r = await api.post(url, corps || {}); invaliderRefs(); majBadge(); toast(typeof message === 'function' ? message(r) : message, 'succes'); recharger(); } catch (e) { erreur(e); boutons.forEach((b) => { b.disabled = false; }); } finally { actionEnCours = false; }
    };
    const soumettre = async () => {
      const auDela = c.validationRequise;
      if (!(await ui.confirm({ titre: 'Soumettre la commande', message: auDela ? `Le montant (${montant(c.totaux.ht)} HT) atteint le seuil de validation : la commande sera transmise aux valideurs.` : `Montant ${montant(c.totaux.ht)} HT inférieur au seuil de ${montant(c.seuilValidationHT)} HT : la commande sera validée automatiquement.`, okLabel: 'Soumettre' }))) return;
      action(`/api/commandes/${c.id}/soumettre`, {}, (r) => (r.statut === 'a_valider' ? 'Commande transmise aux valideurs' : 'Commande validée automatiquement'))();
    };
    const valider = async () => {
      const v = await ui.prompt({ titre: `Valider la commande ${c.numero}`, message: `${c.fournisseurNom} — ${montant(c.totaux.ht)} HT (${montant(c.totaux.ttc)} TTC). Commentaire facultatif :`, label: 'Commentaire', requis: false, okLabel: 'Valider la commande' });
      if (v === null) return;
      action(`/api/commandes/${c.id}/valider`, { commentaire: v || '' }, 'Commande validée')();
    };
    const refuser = async () => { const m = await demanderMotif(`Refuser la commande ${c.numero}`, 'Motif du refus', 'La commande repassera en brouillon et le demandeur sera notifié.'); if (m) action(`/api/commandes/${c.id}/refuser`, { motif: m }, 'Commande refusée (retour en brouillon)')(); };
    const envoyer = async () => {
      if (!(await ui.confirm({ titre: 'Envoyer au fournisseur', message: `Marquer la commande ${c.numero} comme envoyée à ${c.fournisseurNom}${c.fournisseur && c.fournisseur.email ? ` (${c.fournisseur.email})` : ''} ? Pensez à lui transmettre le bon de commande imprimé ou en PDF.`, okLabel: 'Marquer comme envoyée' }))) return;
      action(`/api/commandes/${c.id}/envoyer`, {}, 'Commande marquée comme envoyée')();
    };
    const annuler = async () => { const m = await demanderMotif(`Annuler la commande ${c.numero}`, 'Motif de l\'annulation'); if (m) action(`/api/commandes/${c.id}/annuler`, { motif: m }, 'Commande annulée')(); };
    const solder = async () => { const m = await demanderMotif(`Solder la commande ${c.numero}`, 'Motif (reliquat abandonné)', 'Les quantités restant à recevoir sont abandonnées ; la commande passe au statut « reçue ».'); if (m) action(`/api/commandes/${c.id}/solder`, { motif: m }, 'Commande soldée')(); };
    const supprimer = async () => {
      if (!(await ui.confirm({ titre: 'Supprimer le brouillon', message: `Supprimer définitivement le brouillon ${c.numero} ?`, okLabel: 'Supprimer', danger: true }))) return;
      try { await api.del('/api/commandes/' + c.id); toast('Brouillon supprimé', 'succes'); GMAO.navigate('#/achats?onglet=commandes'); } catch (e) { erreur(e); }
    };
    const actions = [];
    if (a.modifier) actions.push(ui.bouton('Modifier', { icone: 'modifier', onClic: () => ouvrirFormCommande(c, { apres: recharger }) }));
    if (a.refuser) actions.push(ui.bouton('Refuser', { icone: 'fermer', onClic: refuser }));
    if (a.valider) actions.push(ui.bouton('Valider', { icone: 'check', classe: 'btn-ok', onClic: valider }));
    if (a.soumettre) actions.push(ui.bouton(c.validationRequise ? 'Soumettre à validation' : 'Soumettre (validation automatique)', { icone: 'check', classe: 'btn-primaire', onClic: soumettre }));
    if (a.envoyer) actions.push(ui.bouton('Envoyer au fournisseur', { icone: 'fleche_droite', classe: 'btn-primaire', onClic: envoyer }));
    if (a.receptionner) actions.push(ui.bouton('Réceptionner', { icone: 'stock', classe: c.statut === 'validee' ? '' : 'btn-primaire', onClic: () => ouvrirReception(c, recharger) }));
    if (a.facturer) actions.push(ui.bouton('Saisir la facture', { icone: 'facture', onClic: () => ouvrirFormFacture(null, { commandeId: c.id, apres: recharger }) }));
    entete.appendChild(ui.pageEntete({
      titre: frag(c.numero, ui.badgeListe('statutsCommande', c.statut), c.enRetardLivraison ? ui.badge(`Livraison en retard (${c.joursRetardLivraison} j)`, '#dc2626') : null),
      icone: 'achats', filAriane: filAriane.concat([{ label: c.numero }]),
      sousTitre: [c.fournisseurNom, c.secteurChemin, `commandée le ${dateFr(c.dateCommande)}`, c.objet].filter(Boolean).join(' · '),
      actions,
    }));
    const bonImprimable = STATUTS_CMD_IMPRIMABLES.includes(c.statut);
    zone.appendChild(el('div', { class: 'barre-outils' },
      bonImprimable ? ui.bouton('Imprimer le bon de commande', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerBonCommande(c) })
        : ui.bouton('Imprimer un projet', { icone: 'imprimer', classe: 'btn-sm', titre: c.statut === 'annulee' ? 'Commande annulée : document marqué « annulée », sans valeur de commande' : 'Commande non validée : document de travail marqué « projet — non validé »', onClic: () => imprimerBonCommande(c) }),
      can('creer') && !ro && creationPossible() ? ui.bouton('Dupliquer', { icone: 'copier', classe: 'btn-sm', titre: 'Nouvelle commande reprenant le fournisseur et les lignes', onClic: () => ouvrirFormCommande(null, { modele: { fournisseurId: c.fournisseurId, secteurId: c.secteurId, categorieCode: c.categorieCode, objet: c.objet, adresseLivraison: c.adresseLivraison, conditions: c.conditions, lignes: (c.lignes || []).map((l) => ({ articleId: l.articleId, designation: l.designation, referenceFournisseur: l.referenceFournisseur, quantite: l.quantite, prixUnitaireHT: l.prixUnitaireHT, tauxTVA: l.tauxTVA, otId: null, uniteCode: l.uniteCode })) } }) }) : null,
      el('span', { class: 'espace' }),
      a.solder ? ui.bouton('Solder le reliquat', { icone: 'check', classe: 'btn-sm', onClic: solder }) : null,
      a.annuler ? ui.bouton('Annuler la commande', { icone: 'fermer', classe: 'btn-sm', onClic: annuler }) : null,
      a.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: supprimer }) : null));
    if (ro) zone.appendChild(ui.alerte('Ce site est accessible en lecture seule pour vous : consultation uniquement.', 'info'));
    if (c.statut === 'a_valider') zone.appendChild(ui.alerte(c.actions && c.actions.validationPropreInterdite ? `Vous êtes le demandeur de cette commande de ${montant(c.totaux.ht)} HT (≥ seuil de ${montant(c.seuilValidationHT)} HT) : elle doit être validée par un autre valideur.` : `En attente de validation : montant ${montant(c.totaux.ht)} HT supérieur ou égal au seuil de ${montant(c.seuilValidationHT)} HT.`, 'alerte'));
    if (c.statut === 'brouillon' && c.motifRefus) zone.appendChild(ui.alerte(frag(el('strong', null, 'Commande refusée : '), c.motifRefus, ' — modifiez-la puis soumettez-la à nouveau.'), 'danger'));
    if (c.statut === 'annulee') zone.appendChild(ui.alerte(frag(el('strong', null, 'Commande annulée'), c.motifAnnulation ? ` : ${c.motifAnnulation}` : ''), 'alerte'));
    if (c.solde) zone.appendChild(ui.alerte(frag(el('strong', null, 'Commande soldée : '), c.motifSolde || 'reliquat abandonné'), 'info'));
    if (!ro && c.nbFacturesActives && !['recue', 'annulee'].includes(c.statut)) zone.appendChild(ui.alerte(`${pluriel(c.nbFacturesActives, 'facture rattachée', 'factures rattachées')} : la commande ne peut plus être annulée tant qu'elles ne sont pas annulées.`, 'info'));
    zone.appendChild(etapesCommande(c));
    zone.appendChild(el('div', { class: 'ach-kpis k4' },
      ui.kpi({ label: 'Montant HT', valeur: montant(c.totaux.ht), icone: 'euro', detail: `${montant(c.totaux.ttc)} TTC · ${pluriel((c.lignes || []).length, 'ligne')}` }),
      ui.kpi({ label: 'Réception (en valeur)', valeur: `${c.tauxReception} %`, icone: 'stock', couleur: c.tauxReception >= 100 ? '#16a34a' : '#0891b2', detail: c.nbReceptions ? `${pluriel(c.nbReceptions, 'réception')} · ${montant(c.montantRecuHT)} HT reçus sur ${montant(c.totaux.ht)}` : 'aucune réception' }),
      ui.kpi({ label: 'Facturé HT', valeur: montant(c.montantFactureHT), icone: 'facture', couleur: '#6250d6', detail: c.nbFactures ? pluriel(c.nbFactures, 'facture') : 'aucune facture' }),
      ui.kpi({ label: 'Livraison souhaitée', valeur: c.dateLivraisonPrevue ? dateFr(c.dateLivraisonPrevue) : '—', icone: 'calendrier', couleur: c.enRetardLivraison ? '#dc2626' : '#6b7280', detail: c.enRetardLivraison ? `en retard de ${c.joursRetardLivraison} j` : (c.fournisseur && c.fournisseur.delaiLivraisonJours != null ? `délai fournisseur ${c.fournisseur.delaiLivraisonJours} j` : '') })));
    zone.appendChild(ui.onglets([
      { cle: 'detail', label: 'Détail', icone: 'liste', rendu: () => rendreInfosCommande(c) },
      { cle: 'receptions', label: 'Réceptions', icone: 'stock', badge: c.nbReceptions || null, rendu: () => rendreReceptions(c) },
      { cle: 'factures', label: 'Factures', icone: 'facture', badge: c.nbFactures || null, rendu: () => rendreFacturesCommande(c, recharger) },
      { cle: 'documents', label: 'Documents', icone: 'piece_jointe', badge: (c.documents || []).length || null, rendu: () => rendreDocuments('commande', c, recharger) },
      { cle: 'historique', label: 'Historique', icone: 'horloge', rendu: () => ui.carte(null, rendreHistorique(c.historique)) },
    ], { hash: true }).el);
  }

  // =================================================================================================
  // FORMULAIRE FACTURE
  // =================================================================================================
  function ouvrirFormFacture(existant, options = {}) { return ouvrirUnique(() => formFacture(existant, options)); }
  async function formFacture(existant, options = {}) {
    let refs;
    try { refs = await references(true); } catch (e) { erreur(e); return; }
    const creation = !existant;
    const verrouillee = !!existant && existant.statut === 'validee';
    const config = refs.config || cfg();
    const base = existant || {};
    const commandes = refs.commandes || [];
    if (base.commandeId && !commandes.some((c) => c.id === base.commandeId) && base.commandeNumero) commandes.push({ id: base.commandeId, numero: base.commandeNumero, fournisseurId: base.fournisseurId, secteurId: base.secteurId, objet: '', totaux: { ht: 0 }, montantRecuHT: 0, montantFactureHT: 0 });
    const fourNom = (id) => (refs.fournisseurs.find((f) => f.id === Number(id)) || {}).nom || '';
    const optsCommandes = [{ value: '', label: '— Sans commande (frais, prestation, formation…) —' }].concat(commandes.map((c) => ({ value: c.id, label: `${c.numero} — ${fourNom(c.fournisseurId)}${c.objet ? ' — ' + c.objet : ''} (${montant(c.totaux.ht)} HT${c.montantFactureHT ? `, ${montant(c.montantFactureHT)} déjà facturés` : ''})` })));
    const optsSecteurs = optionsSecteursEcriture();
    if (existant && base.secteurId && !optsSecteurs.some((o) => String(o.value) === String(base.secteurId))) optsSecteurs.push({ value: base.secteurId, label: ui.cheminSecteur(base.secteurId) });
    const optsOt = [{ value: '', label: '— Aucun —' }].concat((refs.ot || []).map((o) => ({ value: o.id, label: `${o.numero} — ${o.titre}`.slice(0, 90) + (o.final ? ' (clôturé)' : '') })));
    const optsPers = [{ value: '', label: '— Aucune —' }].concat((refs.personnel || []).map((p) => ({ value: p.id, label: `${p.nom}${p.fonction ? ' — ' + p.fonction : ''}` })));
    const controle = el('div', { class: 'ach-controle' });
    const rappro = el('div');
    let echeanceTouchee = !!(existant && existant.dateEcheance);
    const commandeDe = (id) => commandes.find((c) => c.id === Number(id)) || null;

    function majControle(form) {
      const ht = num(form.get('montantHT')); const tva = num(form.get('montantTVA')); const ttc = num(form.get('montantTTC'));
      const ok = Math.abs(arrondi(ht + tva) - ttc) <= 0.01 + 1e-9;
      controle.className = 'ach-controle ' + (ok ? 'ok' : 'ko');
      ui.vider(controle);
      controle.appendChild(icone(ok ? 'check' : 'alerte'));
      controle.appendChild(el('span', null, ok ? `Contrôle TTC : ${montant(ht)} HT + ${montant(tva)} TVA = ${montant(ttc)} TTC` : `Incohérence : HT + TVA = ${montant(arrondi(ht + tva))}, TTC saisi ${montant(ttc)} (écart toléré : 0,01 €)`));
      // Rapprochement prévisionnel
      ui.vider(rappro);
      const c = commandeDe(form.get('commandeId'));
      if (c) {
        const dejaFacture = num(c.montantFactureHT) - (existant && Number(existant.commandeId) === c.id && existant.statut !== 'annulee' ? num(existant.montantHT) : 0);
        const reference = num(c.montantRecuHT) > 0 ? num(c.montantRecuHT) : num(c.totaux.ht);
        const ecart = arrondi(ht + dejaFacture - reference);
        const conforme = Math.abs(ecart) <= 0.01 + 1e-9;
        rappro.appendChild(el('div', { class: 'ach-controle ' + (conforme ? 'ok' : 'ko'), style: { marginTop: '6px' } }, icone(conforme ? 'check' : 'alerte'),
          el('span', null, `Rapprochement avec ${c.numero} : commandé ${montant(c.totaux.ht)}, reçu ${montant(c.montantRecuHT)}, déjà facturé ${montant(dejaFacture)} → ${conforme ? 'conforme' : `écart de ${ecart > 0 ? '+' : ''}${montant(ecart)} HT`}`)));
      }
    }
    function recalculer(form, depuis) {
      const ht = form.get('montantHT');
      if (depuis === 'ht' || depuis === 'taux') {
        if (ht === null || ht === '') return majControle(form);
        const tva = arrondi((num(ht) * num(form.get('tauxTVA'))) / 100);
        form.set('montantTVA', tva);
        form.set('montantTTC', arrondi(num(ht) + tva));
      } else if (depuis === 'tva') {
        form.set('montantTTC', arrondi(num(ht) + num(form.get('montantTVA'))));
      }
      majControle(form);
    }
    const champs = [
      { type: 'separateur', label: 'Fournisseur et imputation' },
      { nom: 'commandeId', label: 'Commande rattachée', type: 'select', options: optsCommandes, disabled: verrouillee, pleineLargeur: true, aide: 'La commande permet le rapprochement (commandé / reçu / facturé) et reprend le fournisseur, le site et la catégorie.',
        onChange: (v, form) => {
          const c = commandeDe(v);
          if (c) {
            form.set('fournisseurId', c.fournisseurId); form.set('secteurId', c.secteurId);
            if (c.categorieCode) form.set('categorieCode', c.categorieCode);
            if (!form.get('objet')) form.set('objet', c.objet || '');
            const reste = arrondi((num(c.montantRecuHT) > 0 ? num(c.montantRecuHT) : num(c.totaux.ht)) - num(c.montantFactureHT));
            if (reste > 0 && (form.get('montantHT') === null || form.get('montantHT') === '')) { form.set('montantHT', reste); recalculer(form, 'ht'); }
          }
          majControle(form);
        } },
      { nom: 'fournisseurId', label: 'Fournisseur', type: 'select', requis: true, disabled: verrouillee, options: [{ value: '', label: '— Choisir —' }].concat(refs.fournisseurs.filter((f) => f.actif || f.id === base.fournisseurId).map((f) => ({ value: f.id, label: f.nom }))) },
      { nom: 'numeroFournisseur', label: 'N° de facture du fournisseur', type: 'texte', requis: true, disabled: verrouillee, maxLength: 60, placeholder: 'ex. FA-26-104577', aide: 'Unique par fournisseur (contrôle des doublons).' },
      { nom: 'objet', label: 'Objet', type: 'texte', maxLength: 200, placeholder: 'ex. Contrat de maintenance — visite trimestrielle' },
      { nom: 'secteurId', label: 'Site / service', type: 'select', requis: true, disabled: verrouillee, options: optsSecteurs },
      { nom: 'categorieCode', label: 'Catégorie de dépense', type: 'select', liste: 'categoriesDepense', vide: false },
      { nom: 'otId', label: 'Ordre de travail', type: 'select', options: optsOt, disabled: verrouillee, aide: 'Pour imputer une prestation ou des pièces au coût d\'une intervention.' },
      refs.rhDisponible && (refs.personnel || []).length ? { nom: 'personnelId', label: 'Personne concernée', type: 'select', options: optsPers, disabled: verrouillee, aide: 'Formation, intérim, visite médicale…' } : null,
      { type: 'separateur', label: 'Dates' },
      { nom: 'dateFacture', label: 'Date de facture', type: 'date', requis: true, disabled: verrouillee, onChange: (v, form) => { if (v && !echeanceTouchee) form.set('dateEcheance', ajouterJours(v, num(config.delaiPaiementJours))); } },
      { nom: 'dateEcheance', label: 'Date d\'échéance', type: 'date', requis: true, aide: `Par défaut : date de facture + ${ui.formatNombre(config.delaiPaiementJours)} jours.`, onChange: () => { echeanceTouchee = true; } },
      { type: 'separateur', label: 'Montants' },
      { nom: 'montantHT', label: 'Montant HT (€)', type: 'nombre', requis: true, min: 0, step: '0.01', disabled: verrouillee, onInput: (v, form) => recalculer(form, 'ht') },
      { nom: 'tauxTVA', label: 'Taux de TVA (%)', type: 'nombre', min: 0, max: 100, step: '0.1', disabled: verrouillee, onInput: (v, form) => recalculer(form, 'taux') },
      { nom: 'montantTVA', label: 'Montant de TVA (€)', type: 'nombre', requis: true, min: 0, step: '0.01', disabled: verrouillee, onInput: (v, form) => recalculer(form, 'tva') },
      { nom: 'montantTTC', label: 'Montant TTC (€)', type: 'nombre', requis: true, min: 0, step: '0.01', disabled: verrouillee, onInput: (v, form) => majControle(form),
        valider: (v, vals) => (Math.abs(arrondi(num(vals.montantHT) + num(vals.montantTVA)) - num(v)) > 0.01 + 1e-9 ? 'Le TTC doit être égal au HT + TVA (à 0,01 € près)' : '') },
      { type: 'html', rendu: () => frag(controle, rappro) },
      creation ? { type: 'separateur', label: 'Pièce jointe et commentaire' } : null,
      creation ? { nom: 'fichier', label: 'Facture (PDF ou image)', type: 'fichier', tailleMax: TAILLE_MAX_DOC, accept: 'application/pdf,image/png,image/jpeg,image/gif,image/webp', aide: '10 Mo maximum — consultable ensuite dans la fiche (aperçu).' } : null,
      creation ? { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 2, maxLength: 2000 } : null,
      ...ui.champsPersoDefs('factures'),
    ].filter(Boolean);
    const commandeInitiale = options.commandeId ? commandeDe(options.commandeId) : null;
    const dateF = base.dateFacture || aujourdhui();
    const valeurs = Object.assign({
      commandeId: base.commandeId || (commandeInitiale ? commandeInitiale.id : ''), fournisseurId: base.fournisseurId || (commandeInitiale ? commandeInitiale.fournisseurId : ''),
      numeroFournisseur: base.numeroFournisseur || '', objet: base.objet || (commandeInitiale ? commandeInitiale.objet || '' : ''),
      secteurId: base.secteurId || (commandeInitiale ? commandeInitiale.secteurId : '') || '', categorieCode: base.categorieCode || (commandeInitiale ? commandeInitiale.categorieCode : '') || ((GMAO.liste('categoriesDepense')[0] || {}).code || ''),
      otId: base.otId || options.otId || '', personnelId: base.personnelId || '',
      dateFacture: dateF, dateEcheance: base.dateEcheance || ajouterJours(dateF, num(config.delaiPaiementJours)),
      montantHT: base.montantHT != null ? base.montantHT : '', tauxTVA: base.tauxTVA != null ? base.tauxTVA : num(config.tauxTVA), montantTVA: base.montantTVA != null ? base.montantTVA : '', montantTTC: base.montantTTC != null ? base.montantTTC : '',
    }, ui.champsPersoInitiaux(base));
    if (commandeInitiale && valeurs.montantHT === '') {
      const reste = arrondi((num(commandeInitiale.montantRecuHT) > 0 ? num(commandeInitiale.montantRecuHT) : num(commandeInitiale.totaux.ht)) - num(commandeInitiale.montantFactureHT));
      if (reste > 0) { valeurs.montantHT = reste; valeurs.montantTVA = arrondi((reste * num(valeurs.tauxTVA)) / 100); valeurs.montantTTC = arrondi(reste + valeurs.montantTVA); }
    }
    const nbLignesDetail = existant ? (existant.lignes || []).length : 0;
    const m = ui.formModal({
      titre: creation ? 'Saisir une facture fournisseur' : `Modifier la facture ${existant.numero}`, taille: 'large', champs, valeurs,
      avant: frag(verrouillee ? ui.alerte('Facture validée (bon à payer) : les montants et références sont verrouillés. Mettez-la en litige pour les corriger.', 'info') : null,
        nbLignesDetail && !verrouillee ? ui.alerte(`Cette facture comporte un détail de ${pluriel(nbLignesDetail, 'ligne')} (total ${montant(existant.montantHT)} HT). Si vous modifiez le montant HT, ce détail sera retiré de la facture (le montant corrigé fait foi).`, 'info') : null),
      submitLabel: creation ? 'Enregistrer la facture' : 'Enregistrer',
      onSubmit: async (v) => {
        const body = {
          commandeId: v.commandeId || null, fournisseurId: v.fournisseurId, numeroFournisseur: v.numeroFournisseur, objet: v.objet, secteurId: v.secteurId, categorieCode: v.categorieCode || '',
          otId: v.otId || null, personnelId: v.personnelId || null, dateFacture: v.dateFacture, dateEcheance: v.dateEcheance,
          montantHT: v.montantHT, tauxTVA: v.tauxTVA, montantTVA: v.montantTVA, montantTTC: v.montantTTC, champs: ui.champsPersoValeurs(v),
        };
        if (verrouillee) { for (const k of ['commandeId', 'fournisseurId', 'numeroFournisseur', 'secteurId', 'otId', 'personnelId', 'dateFacture', 'montantHT', 'tauxTVA', 'montantTVA', 'montantTTC']) delete body[k]; }
        if (creation && v.commentaire) body.commentaire = v.commentaire;
        const res = creation ? await api.post('/api/factures', body) : await api.put('/api/factures/' + existant.id, body);
        if (creation && v.fichier && v.fichier.contenu) {
          try { await api.post(`/api/factures/${res.id}/documents`, { nom: v.fichier.nom, type: v.fichier.type, contenu: v.fichier.contenu, description: 'Facture du fournisseur' }); } catch (e) { toast('Facture enregistrée, mais la pièce jointe a été refusée : ' + e.message, 'alerte', 8000); }
        }
        invaliderRefs(); majBadge();
        toast(creation ? `Facture ${res.numero} enregistrée${res.rapprochement && !res.rapprochement.conforme ? ` — écart de rapprochement ${montant(res.rapprochement.ecartHT)} HT` : ''}` : `Facture ${res.numero} enregistrée`, res.rapprochement && !res.rapprochement.conforme ? 'alerte' : 'succes');
        if (options.apres && !creation) options.apres(res); else GMAO.navigate('#/achats/facture/' + res.id);
      },
    });
    majControle(m.form);
  }

  function ouvrirPaiement(f, apres) {
    references().then((refs) => {
      ui.formModal({
        titre: `Paiement de la facture ${f.numero}`, taille: 'petite', colonnes: 1,
        avant: el('div', { class: 'mb' }, el('div', { class: 'texte-gras', style: { fontSize: '15px' } }, `${montant(f.montantTTC)} TTC`), el('div', { class: 'texte-2' }, `${f.fournisseurNom} · n° ${f.numeroFournisseur} · échéance ${dateFr(f.dateEcheance)}`)),
        champs: [
          { nom: 'datePaiement', label: 'Date de paiement', type: 'date', requis: true, valeur: aujourdhui(), max: aujourdhui() },
          { nom: 'modePaiement', label: 'Mode de paiement', type: 'select', requis: true, options: [{ value: '', label: '— Choisir —' }].concat((refs.modesPaiement || []).map((x) => ({ value: x.code, label: x.label }))), valeur: 'virement' },
          { nom: 'reference', label: 'Référence (n° de virement, de chèque…)', type: 'texte', maxLength: 100 },
        ],
        submitLabel: 'Enregistrer le paiement',
        onSubmit: async (v) => {
          await api.post(`/api/factures/${f.id}/payer`, v);
          invaliderRefs(); majBadge();
          toast(`Facture ${f.numero} payée`, 'succes');
          if (apres) apres();
        },
      });
    }).catch(erreur);
  }

  // =================================================================================================
  // FICHE FACTURE
  // =================================================================================================
  const ETAPES_FAC = [{ label: 'Reçue', codes: ['recue'] }, { label: 'À valider', codes: ['a_valider'] }, { label: 'Bon à payer', codes: ['validee'] }, { label: 'Payée', codes: ['payee'], final: true }];
  function etapesFacture(f) {
    const liste = ETAPES_FAC.map((e) => Object.assign({}, e, { label: lib('statutsFacture', e.codes[0], e.label) }));
    if (f.statut === 'litige') return etapes(liste.slice(0, f.dateValidation ? 3 : 2).concat([{ label: lib('statutsFacture', 'litige', 'En litige'), codes: ['litige'] }]), 'litige', { echec: true });
    if (f.statut === 'annulee') return etapes(liste.slice(0, 1).concat([{ label: lib('statutsFacture', 'annulee', 'Annulée'), codes: ['annulee'] }]), 'annulee', { echec: true });
    return etapes(liste, f.statut);
  }

  function carteRapprochement(f) {
    const r = f.rapprochement;
    if (!f.commande) return null;
    if (!r) return ui.carte('Rapprochement avec la commande', el('p', { class: 'texte-2' }, 'Rapprochement indisponible.'));
    const ligne = (l, v, cls) => el('tr', { class: cls || '' }, el('td', null, l), el('td', null, v));
    const contenu = el('div', null,
      el('table', { class: 'ach-rap' }, el('tbody', null,
        ligne('Commandé (HT)', montant(r.commandeHT)),
        ligne('Reçu (HT)', r.recuHT ? montant(r.recuHT) : el('span', { class: 'texte-2' }, 'aucune réception')),
        ligne('Déjà facturé par d\'autres factures (HT)', montant(r.dejaFactureHT)),
        ligne('Cette facture (HT)', montant(r.factureHT)),
        ligne(`Écart par rapport au ${r.base === 'recu' ? 'reçu' : 'commandé'}`, el('span', { class: r.conforme ? 'texte-ok' : 'texte-danger' }, `${r.ecartHT > 0 ? '+' : ''}${montant(r.ecartHT)}`), 'ecart'))),
      el('div', { class: 'ach-alerte-ligne mt' }, r.conforme ? ui.badge('Conforme', '#16a34a') : ui.badge('Écart à justifier', '#dc2626'),
        el('span', { class: 'espace', style: { flex: '1' } }), ui.bouton('Détail par ligne', { icone: 'liste', classe: 'btn-sm', onClic: () => detailRapprochement(f) })));
    return ui.carte(frag('Rapprochement avec ', f.commande.visible ? lienVue('#/achats/commande/' + f.commande.id, f.commande.numero) : f.commande.numero), contenu);
  }

  async function detailRapprochement(f) {
    let d;
    try { d = await api.get(`/api/factures/${f.id}/rapprochement`); } catch (e) { erreur(e); return; }
    ui.modal({
      titre: `Rapprochement ${d.facture.numero} ↔ ${d.commande ? d.commande.numero : ''}`, taille: 'large',
      contenu: frag(
        d.commande && d.commande.visible === false ? ui.alerte(`La commande ${d.commande.numero} est hors de votre périmètre : seuls les montants du rapprochement sont affichés.`, 'info') : null,
        ui.table({ lignes: d.lignes, recherche: false, pagination: false, compact: true, cleId: 'index', vide: d.commande && d.commande.visible === false ? 'Détail des lignes non disponible' : undefined, colonnes: [
          { cle: 'designation', label: 'Ligne de commande', rendu: (l) => `${l.index + 1}. ${l.designation}` },
          { cle: 'quantite', label: 'Commandé', aligner: 'droite', rendu: (l) => ui.formatNombre(l.quantite) },
          { cle: 'quantiteRecue', label: 'Reçu', aligner: 'droite', rendu: (l) => ui.formatNombre(l.quantiteRecue) },
          { cle: 'prixUnitaireHT', label: 'PU HT', aligner: 'droite', rendu: (l) => montant(l.prixUnitaireHT) },
          { cle: 'montantHT', label: 'Commandé HT', aligner: 'droite', rendu: (l) => montant(l.montantHT) },
          { cle: 'montantRecuHT', label: 'Reçu HT', aligner: 'droite', rendu: (l) => el('span', { class: 'texte-gras' }, montant(l.montantRecuHT)) },
        ] }).el,
        el('h3', { class: 'mt' }, 'Factures de la commande'),
        ui.table({ lignes: [Object.assign({ courante: true, statut: f.statut }, d.facture)].concat(d.autresFactures), recherche: false, pagination: false, compact: true, colonnes: [
          { cle: 'numero', label: 'Facture', rendu: (x) => frag(x.numero, x.courante ? ui.badge('cette facture', null, { classe: 'ml' }) : null) },
          { cle: 'numeroFournisseur', label: 'N° fournisseur' },
          { cle: 'dateFacture', label: 'Date', rendu: (x) => dateFr(x.dateFacture) },
          { cle: 'statut', label: 'Statut', liste: 'statutsFacture' },
          { cle: 'montantHT', label: 'HT', aligner: 'droite', rendu: (x) => el('span', { class: x.compte === false ? 'texte-2' : 'texte-gras', style: x.compte === false ? { textDecoration: 'line-through' } : null }, montant(x.montantHT)) },
        ] }).el,
        d.receptions.length ? el('p', { class: 'texte-2 texte-petit mt' }, `Réceptions : ${d.receptions.map((r) => `${dateFr(r.date)}${r.bonLivraison ? ' (BL ' + r.bonLivraison + ')' : ''} : ${montant(r.montantHT)} HT`).join(' · ')}`) : null,
        el('p', { class: 'texte-2 texte-petit' }, `Le rapprochement compare le cumul facturé au montant reçu (ou commandé en l'absence de réception) ; tolérance d'arrondi : ${montant(d.tolerance)}.`)),
      boutons: [{ label: 'Fermer' }],
    });
  }

  function rendreCommentaires(f, recharger) {
    const cont = el('div');
    const liste = el('div', { class: 'commentaires' }, (f.commentaires || []).length ? f.commentaires.slice().reverse().map((x) => el('div', { class: 'commentaire' }, el('div', null, el('span', { class: 'c-auteur' }, x.userNom || '—'), el('span', { class: 'c-date' }, ui.formatDateHeure(x.date))), el('div', { style: { whiteSpace: 'pre-wrap' } }, x.texte))) : el('p', { class: 'texte-2' }, 'Aucun commentaire.'));
    if (f.actions && f.actions.commenter && !lectureSeule(f)) {
      const zone = el('textarea', { rows: 2, placeholder: 'Ajouter un commentaire (relance, accord, justification…)', maxlength: 2000 });
      let envoi = false;
      const btn = ui.bouton('Ajouter', { icone: 'commentaire', classe: 'btn-sm btn-primaire', onClic: async () => {
        if (!zone.value.trim() || envoi) return;
        envoi = true; btn.disabled = true;
        try { await api.post(`/api/factures/${f.id}/commentaires`, { texte: zone.value.trim() }); toast('Commentaire ajouté', 'succes'); recharger(); } catch (e) { erreur(e); envoi = false; btn.disabled = false; }
      } });
      cont.appendChild(el('div', { class: 'mb' }, zone, el('div', { class: 'texte-droite', style: { marginTop: '6px' } }, btn)));
    }
    cont.appendChild(liste);
    return cont;
  }

  async function afficherFacture(container, id) {
    const entete = el('div'); const zone = el('div');
    container.appendChild(entete); container.appendChild(zone);
    const filAriane = [{ label: GMAO.moduleLabel(MODULE), href: '#/achats' }, { label: 'Factures', href: '#/achats?onglet=factures' }];
    let f;
    try { f = await api.get('/api/factures/' + Number(id)); } catch (e) {
      entete.appendChild(ui.pageEntete({ titre: 'Facture', icone: 'facture', filAriane: filAriane.concat([{ label: 'Fiche' }]) }));
      zone.appendChild(ui.vide(e.status === 404 ? 'Facture introuvable ou hors de votre périmètre.' : e.message, 'alerte'));
      zone.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour aux factures', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/achats?onglet=factures') })));
      return;
    }
    const recharger = () => GMAO.navigate(location.hash.split('?')[0] === '#/achats/facture/' + f.id ? location.hash : '#/achats/facture/' + f.id);
    const ro = lectureSeule(f);
    const a = ro ? {} : (f.actions || {});
    // Une action à la fois : les boutons de la fiche sont désactivés pendant l'appel (double clic)
    let actionEnCours = false;
    const post = async (url, corps, message) => {
      if (actionEnCours) return null;
      actionEnCours = true;
      const boutons = container.querySelectorAll('.page-actions button, .barre-outils button');
      boutons.forEach((b) => { b.disabled = true; });
      try { const r = await api.post(url, corps || {}); invaliderRefs(); majBadge(); toast(message, 'succes'); recharger(); return r; } catch (e) { boutons.forEach((b) => { b.disabled = false; }); throw e; } finally { actionEnCours = false; }
    };
    const valider = async () => {
      const rap = f.rapprochement;
      if (rap && !rap.conforme) {
        ui.formModal({
          titre: `Valider malgré l'écart — ${f.numero}`, taille: 'petite', colonnes: 1,
          avant: ui.alerte(`Écart de ${rap.ecartHT > 0 ? '+' : ''}${montant(rap.ecartHT)} HT par rapport au ${rap.base === 'recu' ? 'montant reçu' : 'montant commandé'} de ${rap.commandeNumero}.`, 'alerte'),
          champs: [{ nom: 'commentaire', label: 'Justification (obligatoire)', type: 'texte_long', requis: true, placeholder: 'ex. frais de port acceptés, hausse tarifaire validée…' }],
          submitLabel: 'Valider (bon à payer)',
          onSubmit: async (v) => { await post(`/api/factures/${f.id}/valider`, { forcer: true, commentaire: v.commentaire }, 'Facture validée (bon à payer)'); },
        });
        return;
      }
      if (!(await ui.confirm({ titre: 'Bon à payer', message: `Valider la facture ${f.numero} (${montant(f.montantTTC)} TTC) et la déclarer « bon à payer » ?`, okLabel: 'Valider' }))) return;
      try { await post(`/api/factures/${f.id}/valider`, {}, 'Facture validée (bon à payer)'); } catch (e) {
        if (e.status === 409) { f.rapprochement = (e.details || {}).rapprochement || f.rapprochement; valider(); } else erreur(e);
      }
    };
    const soumettre = async () => { try { await post(`/api/factures/${f.id}/soumettre`, {}, 'Facture transmise aux valideurs'); } catch (e) { erreur(e); } };
    const litige = async () => { const m = await demanderMotif(`Mettre la facture ${f.numero} en litige`, 'Motif du litige', 'Le paiement est suspendu jusqu\'à résolution (validation ou annulation).'); if (m) { try { await post(`/api/factures/${f.id}/litige`, { motif: m }, 'Facture mise en litige'); } catch (e) { erreur(e); } } };
    const annuler = async () => { const m = await demanderMotif(`Annuler la facture ${f.numero}`, 'Motif de l\'annulation (doublon, avoir reçu…)'); if (m) { try { await post(`/api/factures/${f.id}/annuler`, { motif: m }, 'Facture annulée'); } catch (e) { erreur(e); } } };
    const supprimer = async () => {
      if (!(await ui.confirm({ titre: 'Supprimer la facture', message: `Supprimer définitivement la facture ${f.numero} (n° ${f.numeroFournisseur}) ? Préférez l'annulation pour conserver la trace.`, okLabel: 'Supprimer', danger: true }))) return;
      try { await api.del('/api/factures/' + f.id); toast('Facture supprimée', 'succes'); GMAO.navigate('#/achats?onglet=factures'); } catch (e) { erreur(e); }
    };
    const actions = [];
    if (a.modifier) actions.push(ui.bouton('Modifier', { icone: 'modifier', onClic: () => ouvrirFormFacture(f, { apres: recharger }) }));
    if (a.litige) actions.push(ui.bouton('Mettre en litige', { icone: 'alerte', onClic: litige }));
    if (a.soumettre) actions.push(ui.bouton('Soumettre à validation', { icone: 'fleche_droite', onClic: soumettre }));
    if (a.valider) actions.push(ui.bouton(f.statut === 'litige' ? 'Lever le litige (bon à payer)' : 'Valider (bon à payer)', { icone: 'check', classe: 'btn-ok', onClic: valider }));
    if (a.payer) actions.push(ui.bouton('Enregistrer le paiement', { icone: 'euro', classe: 'btn-primaire', onClic: () => ouvrirPaiement(f, recharger) }));
    entete.appendChild(ui.pageEntete({
      titre: frag(f.numero, ui.badgeListe('statutsFacture', f.statut), f.enRetard ? ui.badge(`Échue depuis ${f.joursRetard} j`, '#dc2626') : null),
      icone: 'facture', filAriane: filAriane.concat([{ label: f.numero }]),
      sousTitre: [f.fournisseurNom, `n° ${f.numeroFournisseur}`, `${montant(f.montantTTC)} TTC`, f.objet].filter(Boolean).join(' · '),
      actions,
    }));
    if (a.annuler || a.supprimer) {
      zone.appendChild(el('div', { class: 'barre-outils' }, el('span', { class: 'espace' }),
        a.annuler ? ui.bouton('Annuler la facture', { icone: 'fermer', classe: 'btn-sm', onClic: annuler }) : null,
        a.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: supprimer }) : null));
    }
    if (ro) zone.appendChild(ui.alerte('Ce site est accessible en lecture seule pour vous : consultation uniquement.', 'info'));
    if (f.enRetard) zone.appendChild(ui.alerte(frag(el('strong', null, 'Échéance dépassée : '), `la facture devait être réglée le ${dateFr(f.dateEcheance)} (${f.joursRetard} j de retard).${f.statut === 'validee' ? ' Elle est bonne à payer.' : ''}`), 'danger'));
    if (f.statut === 'litige') zone.appendChild(ui.alerte(frag(el('strong', null, 'En litige : '), f.motifLitige || '', ' — paiement suspendu.'), 'alerte'));
    if (!ro && f.actions && f.actions.validationPropreInterdite) zone.appendChild(ui.alerte(`Vous avez saisi cette facture de ${montant(f.montantHT)} HT (≥ seuil de ${montant(cfg().seuilValidationHT)} HT) : le bon à payer doit être donné par un autre valideur.`, 'alerte'));
    if (f.statut === 'annulee') zone.appendChild(ui.alerte(frag(el('strong', null, 'Facture annulée'), f.motifAnnulation ? ` : ${f.motifAnnulation}` : ''), 'alerte'));
    if (f.rapprochement && !f.rapprochement.conforme && !['payee', 'annulee'].includes(f.statut)) zone.appendChild(ui.alerte(`Écart de rapprochement de ${f.rapprochement.ecartHT > 0 ? '+' : ''}${montant(f.rapprochement.ecartHT)} HT avec la commande ${f.rapprochement.commandeNumero} : la validation devra être justifiée.`, 'alerte'));
    zone.appendChild(etapesFacture(f));
    const infos = ui.carte('Facture', ui.details([
      { label: 'Fournisseur', valeur: f.fournisseur ? (GMAO.can('fournisseurs', 'voir') ? lienVue('#/fournisseurs/' + f.fournisseur.id, f.fournisseur.nom) : f.fournisseur.nom) : f.fournisseurNom },
      { label: 'N° fournisseur', valeur: el('span', { class: 'texte-gras' }, f.numeroFournisseur) },
      { label: 'N° interne', valeur: f.numero },
      { label: 'Objet', valeur: f.objet },
      { label: 'Date de facture', valeur: dateFr(f.dateFacture) },
      { label: 'Échéance', valeur: el('span', { class: f.enRetard ? 'texte-danger texte-gras' : '' }, dateFr(f.dateEcheance) + (f.enRetard ? ` (retard ${f.joursRetard} j)` : (f.joursAvantEcheance != null && f.statut !== 'payee' && f.statut !== 'annulee' ? ` (dans ${f.joursAvantEcheance} j)` : ''))) },
      { label: 'Site / service', valeur: f.secteurChemin },
      { label: 'Catégorie', valeur: ui.badgeListe('categoriesDepense', f.categorieCode) },
      { label: 'Commande', valeur: f.commande ? (f.commande.visible ? lienVue('#/achats/commande/' + f.commande.id, `${f.commande.numero}${f.commande.objet ? ' — ' + f.commande.objet : ''}`) : f.commande.numero) : '' },
      { label: 'Ordre de travail', valeur: f.otId ? (GMAO.can('ot', 'voir') ? lienVue('#/ot/' + f.otId, `${f.otNumero} — ${f.otTitre}`) : `${f.otNumero} — ${f.otTitre}`) : '' },
      { label: 'Personne concernée', valeur: f.personnelNom },
      ...ui.champsPersoAffichage('factures', f),
    ]));
    const montants = ui.carte('Montants et paiement', frag(
      el('div', { class: 'ach-totaux', style: { justifyContent: 'start', marginTop: '0' } },
        el('span', { class: 'lib', style: { textAlign: 'left' } }, 'Montant HT'), el('span', { class: 'val' }, montant(f.montantHT)),
        el('span', { class: 'lib', style: { textAlign: 'left' } }, `TVA (${ui.formatNombre(f.tauxTVA)} %)`), el('span', { class: 'val' }, montant(f.montantTVA)),
        el('span', { class: 'lib ttc', style: { textAlign: 'left' } }, 'Montant TTC'), el('span', { class: 'val ttc' }, montant(f.montantTTC))),
      el('hr'),
      ui.details([
        { label: 'Saisie par', valeur: f.createdByNom ? `${f.createdByNom} — ${ui.formatDateHeure(f.createdAt)}` : '' },
        { label: 'Bon à payer', valeur: f.valideurNom ? `${f.valideurNom} — ${ui.formatDateHeure(f.dateValidation)}` : '' },
        { label: 'Paiement', valeur: f.datePaiement ? `${dateFr(f.datePaiement)} — ${f.modePaiementLibelle}${f.referencePaiement ? ' (réf. ' + f.referencePaiement + ')' : ''}` : el('span', { class: 'texte-2' }, 'non réglée') },
        { label: 'Réglé par', valeur: f.payeParNom },
      ])));
    const gauche = el('div', null, infos, montants, carteRapprochement(f));
    if ((f.lignes || []).length) {
      gauche.appendChild(ui.carte(`Lignes de la facture (${f.lignes.length})`, ui.table({ lignes: f.lignes.map((l, i) => Object.assign({ index: i }, l)), cleId: 'index', recherche: false, pagination: false, compact: true, colonnes: [
        { cle: 'designation', label: 'Désignation' },
        { cle: 'quantite', label: 'Qté', aligner: 'droite', rendu: (l) => ui.formatNombre(l.quantite) },
        { cle: 'prixUnitaireHT', label: 'PU HT', aligner: 'droite', rendu: (l) => montant(l.prixUnitaireHT) },
        { cle: 'tauxTVA', label: 'TVA', aligner: 'droite', rendu: (l) => `${ui.formatNombre(l.tauxTVA)} %` },
        { cle: 'montantHT', label: 'Montant HT', aligner: 'droite', rendu: (l) => el('span', { class: 'texte-gras' }, montant(l.montantHT)) },
      ] }).el));
    }
    const droite = el('div', null,
      ui.carte(frag('Pièce jointe ', (f.documents || []).length ? ui.badge(String(f.documents.length)) : null), rendreDocuments('facture', f, recharger, { apercu: true })),
      ui.carte(frag('Commentaires ', (f.commentaires || []).length ? ui.badge(String(f.commentaires.length)) : null), rendreCommentaires(f, recharger)),
      ui.carte('Historique', rendreHistorique(f.historique)));
    zone.appendChild(el('div', { class: 'grille grille-2', style: { alignItems: 'start' } }, gauche, droite));
  }

  // =================================================================================================
  // VUE
  // =================================================================================================
  async function afficherAccueil(container, query) {
    filtres();
    // Filtres transmis par lien (ex. #/achats?onglet=factures&filtre=retard)
    if (query.filtre === 'retard') Object.assign(memo.fac, { statut: '', echeanceDepassee: true, aPayer: false });
    if (query.filtre === 'apayer') Object.assign(memo.fac, { statut: '', echeanceDepassee: false, aPayer: true });
    if (query.statutCommande) memo.cmd.statut = query.statutCommande;
    if (query.fournisseurId) { memo.cmd.fournisseurId = String(query.fournisseurId); memo.fac.fournisseurId = String(query.fournisseurId); }
    if (query.secteurId) { memo.cmd.secteurId = String(query.secteurId); memo.fac.secteurId = String(query.secteurId); }
    if (query.statutFacture) memo.fac.statut = query.statutFacture;
    let ong = null;
    const rafraichir = () => { if (ong) ong.activer(ong.actif); };
    // Sur un site affiché en lecture seule, aucun site / service n'est modifiable : les créations sont masquées
    const creer = creationPossible();
    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'achats',
      sousTitre: 'Commandes fournisseurs, réceptions, factures et échéances de paiement',
      actions: [
        creer ? ui.bouton('Commander les alertes de stock', { icone: 'stock', onClic: () => ouvrirAlertesStock(() => { memo.cmd.statut = 'brouillon'; ong.activer('commandes'); }) }) : null,
        creer ? ui.bouton('Saisir une facture', { icone: 'facture', onClic: () => ouvrirFormFacture(null, {}) }) : null,
        creer ? ui.bouton('Nouvelle commande', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormCommande(null) }) : null,
      ],
    }));
    if (can('creer') && !creer) container.appendChild(ui.alerte('Le site affiché est accessible en lecture seule pour vous : aucune commande ni facture ne peut y être créée. Choisissez un autre site dans l\'en-tête pour saisir.', 'info'));
    majBadge();
    // Les onglets asynchrones construisent leur contenu hors du DOM puis le renvoient (ui.onglets remplace le corps à la résolution)
    const asynchrone = (fn) => () => { const c = el('div'); return fn(c).then(() => c); };
    ong = ui.onglets([
      { cle: 'tableau', label: 'Tableau de bord', icone: 'dashboard', rendu: asynchrone((c) => rendreTableau(c, { activer: (k) => ong && ong.activer(k) })) },
      { cle: 'commandes', label: 'Commandes', icone: 'achats', rendu: asynchrone((c) => rendreCommandes(c)) },
      { cle: 'factures', label: 'Factures', icone: 'facture', rendu: asynchrone((c) => rendreFactures(c)) },
      { cle: 'echeancier', label: 'Échéancier', icone: 'calendrier', rendu: asynchrone((c) => rendreEcheancier(c, rafraichir)) },
    ], { hash: true });
    container.appendChild(ong.el);
    if (creer && query.nouveau === 'commande') ouvrirFormCommande(null);
    if (creer && query.nouveau === 'facture') ouvrirFormFacture(null, { commandeId: query.commandeId ? Number(query.commandeId) : null, otId: query.otId ? Number(query.otId) : null });
    if (creer && query.alertes === '1') ouvrirAlertesStock(() => ong.activer('commandes'));
  }

  GMAO.registerView(MODULE, {
    titre: 'Achats & factures', icone: 'achats',
    async rendu(container, { params, query }) {
      if (params[0] === 'commande' && /^\d+$/.test(params[1] || '')) return afficherCommande(container, params[1]);
      if (params[0] === 'facture' && /^\d+$/.test(params[1] || '')) return afficherFacture(container, params[1]);
      if (params[0]) { container.appendChild(ui.vide('Page introuvable', 'alerte')); return; }
      return afficherAccueil(container, query || {});
    },
  });
})();
