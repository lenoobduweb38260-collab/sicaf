/**
 * Vue Étiquettes code-barres & inventaire du magasin.
 *
 *  #/inventaire                 onglets : Étiquettes · Inventaires · Scanner · Paramètres
 *  #/inventaire/:id             écran de comptage (optimisé pour la douchette)
 *  #/inventaire?onglet=etiquettes&source=articles|equipements&ids=1,2   présélection d'étiquettes
 *
 * Étiquettes : sélection d'articles ou d'équipements, planches A4 / rouleaux thermiques / format
 * personnalisé, contenu paramétrable, aperçu fidèle, impression au millimètre (codes-barres SVG).
 * Scan global : un code scanné à la douchette depuis n'importe quel écran (hors champ de saisie)
 * ouvre la fiche correspondante (config.inventaire.scanGlobal).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'inventaire';
  const esc = ui.esc;
  const can = (action) => GMAO.can(MODULE, action);
  const CB = () => window.CodeBarre || null;

  // ----- Préférences locales du poste (mode de scan, sons, options d'impression) -------------
  const prefs = {
    get(cle, defaut) { try { const v = localStorage.getItem('gmao.inventaire.' + cle); return v == null ? defaut : JSON.parse(v); } catch (e) { return defaut; } },
    set(cle, v) { try { localStorage.setItem('gmao.inventaire.' + cle, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
  };

  // ----- Configuration ----------------------------------------------------------------------
  const CONTENU_DEFAUT = { codeBarre: true, code: true, designation: true, emplacement: true, referenceFournisseur: false, unite: false, categorie: false, societe: true, prix: false, secteur: false };
  const PERSO_DEFAUT = { largeurMm: 63.5, hauteurMm: 38.1, colonnes: 3, lignes: 7, margeHautMm: 15.1, margeGaucheMm: 7.2, espaceHorizontalMm: 2.5, espaceVerticalMm: 0, pageLargeurMm: 210, pageHauteurMm: 297 };
  function cfgInv() { return Object.assign({ aveugle: false, modeScan: 'quantite', sons: true, nonComptesAZero: false, scanGlobal: true }, (GMAO.config || {}).inventaire || {}); }
  function cfgEt() {
    const c = (GMAO.config || {}).etiquettes || {};
    return {
      format: c.format || 'a4-3x7', symbologie: c.symbologie || 'code128', hauteurCodeMm: Number(c.hauteurCodeMm) > 0 ? Number(c.hauteurCodeMm) : 12, decalage: Math.max(0, Number(c.decalage) || 0),
      contenu: Object.assign({}, CONTENU_DEFAUT, c.contenu || {}), formatPersonnalise: Object.assign({}, PERSO_DEFAUT, c.formatPersonnalise || {}),
    };
  }
  const modeScanDefaut = () => (cfgInv().modeScan === 'unitaire' ? 'unitaire' : 'quantite');
  const sonsActifs = () => prefs.get('sons', cfgInv().sons !== false);
  function bip(ok) { const c = CB(); if (c && sonsActifs()) c.bip(ok); }

  // ----- Statuts (liste « statutsInventaire » si configurée, sinon valeurs par défaut) -------------
  const STATUTS_DEFAUT = [
    { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 1 },
    { code: 'valide', label: 'Validé', couleur: '#16a34a', ordre: 2 },
    { code: 'annule', label: 'Annulé', couleur: '#6b7280', ordre: 3 },
  ];
  function statuts() { const l = GMAO.liste('statutsInventaire'); return STATUTS_DEFAUT.map((d) => Object.assign({}, d, l.find((x) => x.code === d.code) || {})); }
  function statut(code) { return statuts().find((s) => s.code === code) || { code, label: code || '—', couleur: '#6b7280' }; }
  const badgeStatut = (code) => ui.badge(statut(code).label, statut(code).couleur);
  const badgeAveugle = () => ui.badge('Comptage à l\'aveugle', '#8b5cf6', { contour: true, titre: 'Les compteurs ne voient ni les quantités théoriques ni les écarts' });

  // ----- Utilitaires ------------------------------------------------------------------------
  const cle = (s) => { const c = CB(); const t = String(s == null ? '' : s); return (c ? c.translitterer(t) : t).trim().replace(/\s+/g, ' ').toLowerCase(); };
  const unite = (code) => (code ? ui.libelle('unites', code) : '');
  const qte = (n, u) => (n == null || n === '' ? '—' : `${ui.formatNombre(n, Number.isInteger(Number(n)) ? 0 : undefined)}${u ? ' ' + u : ''}`);
  const signe = (n) => (n == null ? '—' : `${Number(n) > 0 ? '+' : ''}${ui.formatNombre(n)}`);
  const montantSigne = (n) => (n == null ? '—' : `${Number(n) > 0 ? '+' : ''}${ui.formatMontant(n)}`);
  const classeEcart = (n) => (Number(n) > 0 ? 'inv-ecart-pos' : (Number(n) < 0 ? 'inv-ecart-neg' : ''));
  const lienVue = (href, label) => el('a', { href, onclick: (ev) => ev.stopPropagation() }, label);
  function iconeDim(nom, taille, couleur) { const ic = icone(nom); Object.assign(ic.style, { width: taille + 'px', height: taille + 'px', flexShrink: 0, color: couleur || 'currentColor' }); return ic; }
  function barreProgression(pct, couleur) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return el('div', { class: 'barre-progression', title: `${ui.formatNombre(p, 0)} %` }, el('div', { style: { width: p + '%', background: couleur || (p >= 100 ? 'var(--ok)' : 'var(--primaire)') } }));
  }
  const pluriel = (n, s, p) => `${ui.formatNombre(n)} ${Number(n) > 1 ? (p || s + 's') : s}`;

  // ----- Styles propres à la vue (variables du thème : clair et sombre) ----------------------
  const CSS_ETIQUETTES = `
.et-planche{position:relative;overflow:hidden;background:#fff;color:#000;font-family:Arial,"Segoe UI",Helvetica,sans-serif}
.et{position:absolute;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;line-height:1.15}
.et>*+*{margin-top:.45mm}
.et-soc{font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.et-des{font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:100%;word-break:break-word}
.et-cb{line-height:0;max-width:100%}.et-cb svg{display:block;margin:0 auto}
.et-code{font-family:Consolas,"Courier New",monospace;font-weight:700;letter-spacing:.03em}
.et-det{color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.et-erreur{color:#b91c1c;font-weight:700}
.et-contour{outline:.25mm dashed #9ca3af;outline-offset:-.25mm}
.et-vide{outline:.2mm dashed #d1d5db;outline-offset:-.2mm}
.et-utilisee{background:repeating-linear-gradient(45deg,#eef1f5 0,#eef1f5 1.5mm,#dde3ea 1.5mm,#dde3ea 3mm);outline:.2mm dashed #cbd5e1;outline-offset:-.2mm}
.et-dense{box-shadow:inset 0 0 0 .5mm #f59e0b}`;
  function injecterStyles() {
    if (document.getElementById('styles-inventaire')) return;
    const st = document.createElement('style');
    st.id = 'styles-inventaire';
    st.textContent = CSS_ETIQUETTES + `
.inv-intro{color:var(--texte-2);font-size:13px;margin:-6px 0 14px}
.vue[data-module="inventaire"] table.tableau td.num{white-space:nowrap}
.inv-nowrap{white-space:nowrap}
.inv-ligne-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;margin-top:2px}
.inv-ligne-meta .badge{font-size:10.5px;padding:0 6px}
table.tableau tr.inv-selectionnee td{background:var(--primaire-clair)}
[data-theme="sombre"] .vue[data-module="inventaire"] .btn-groupe .btn.actif{color:#bfdbfe;border-color:#3b82f6}
.inv-aide{font-size:11.5px;color:var(--texte-2);margin:-8px 0 4px 46px}
.inv-et-grille{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(340px,1fr);gap:16px;align-items:start}
.inv-et-cote{position:sticky;top:calc(var(--entete-hauteur) + 12px)}
@media (max-width:1180px){.inv-et-grille{grid-template-columns:1fr}.inv-et-cote{position:static}}
.inv-apercu{background:var(--fond-2);border:1px solid var(--bordure);border-radius:8px;padding:14px;display:flex;justify-content:center;align-items:flex-start;overflow:hidden;min-height:180px}
.inv-apercu-cadre{box-shadow:0 2px 10px rgba(0,0,0,.28);background:#fff;overflow:hidden;position:relative;flex-shrink:0}
.inv-apercu-cadre>.et-planche{transform-origin:0 0;position:absolute;left:0;top:0}
.inv-apercu-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;font-size:12.5px;color:var(--texte-2)}
.inv-resume-impression{display:flex;gap:18px;flex-wrap:wrap;margin:4px 0 12px}
.inv-resume-impression .v{font-size:20px;font-weight:700;color:var(--texte);font-variant-numeric:tabular-nums}
.inv-resume-impression .l{font-size:11.5px;color:var(--texte-2);text-transform:uppercase;letter-spacing:.4px}
.inv-contenu-cases{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;padding:4px 0}
.inv-contenu-cases label{display:inline-flex;gap:7px;align-items:center;font-size:13px;cursor:pointer;color:var(--texte)}
.inv-champs-ligne{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}
.inv-champs-ligne .champ{margin:0}
.inv-exemplaires{width:68px!important;min-width:0!important;padding:4px 6px!important;text-align:center}
.inv-scan-champ{position:relative}
.inv-scan-champ>svg{position:absolute;left:15px;top:50%;transform:translateY(-50%);width:26px;height:26px;color:var(--primaire);pointer-events:none}
.inv-scan-champ input{height:58px;font-size:21px;padding-left:54px;font-family:Consolas,"Courier New",monospace;letter-spacing:.5px;border-width:2px;border-color:var(--primaire)}
.inv-scan-outils{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.inv-scan-outils .espace{flex:1}
.inv-carte-article{margin-top:14px;border:1px solid var(--bordure);border-left:5px solid var(--bordure-2);border-radius:10px;background:var(--surface-2);padding:14px 16px}
.inv-carte-article.ok{border-left-color:var(--ok)}.inv-carte-article.attente{border-left-color:var(--primaire)}
.inv-carte-article.erreur{border-left-color:var(--danger)}.inv-carte-article.horsp{border-left-color:var(--alerte)}
.inv-art-titre{font-size:18px;font-weight:700;line-height:1.25;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.inv-art-sous{color:var(--texte-2);font-size:13px;margin-top:3px}
.inv-chiffres{display:flex;gap:26px;flex-wrap:wrap;margin-top:12px}
.inv-chiffre .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
.inv-chiffre .l{font-size:11px;color:var(--texte-2);text-transform:uppercase;letter-spacing:.45px}
.inv-saisie{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
.inv-saisie input.inv-qte{width:150px;height:52px;font-size:26px;font-weight:700;text-align:center}
.inv-total{font-size:13px;color:var(--texte-2);margin-top:8px}
.inv-total strong{color:var(--texte)}
.inv-historique{list-style:none;margin:0;padding:0;max-height:380px;overflow-y:auto}
.inv-historique li{display:flex;gap:10px;align-items:flex-start;padding:7px 2px;border-bottom:1px solid var(--bordure);font-size:13px}
.inv-historique li:last-child{border-bottom:0}
.inv-historique .h-icone{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;margin-top:1px}
.inv-historique li.ok .h-icone{background:var(--ok)}.inv-historique li.erreur .h-icone{background:var(--danger)}.inv-historique li.info .h-icone{background:var(--info)}
.inv-historique .h-icone svg{width:13px;height:13px}
.inv-historique .h-heure{color:var(--texte-2);font-size:11.5px;margin-left:auto;white-space:nowrap;padding-left:6px}
.inv-historique .h-texte{min-width:0}
.inv-comptage{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:16px;align-items:start}
@media (max-width:1100px){.inv-comptage{grid-template-columns:1fr}}
.inv-progression-globale{display:flex;align-items:center;gap:12px;margin:-4px 0 16px}
.inv-progression-globale .barre-progression{flex:1;height:12px;border-radius:6px}
.inv-progression-globale .barre-progression>div{border-radius:6px}
.inv-progression-globale span{font-size:13px;color:var(--texte-2);white-space:nowrap;font-variant-numeric:tabular-nums}
.inv-ecart-pos{color:var(--ok);font-weight:600}.inv-ecart-neg{color:var(--danger);font-weight:600}
.inv-flash td{animation:inv-flash 1.2s ease-out}
@keyframes inv-flash{from{background:var(--primaire-clair)}to{background:transparent}}
.inv-camera{position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:16/9}
.inv-camera video{width:100%;height:100%;object-fit:cover;display:block}
.inv-viseur{position:absolute;left:12%;right:12%;top:34%;bottom:34%;border:3px solid rgba(255,255,255,.9);border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,.35)}
.inv-viseur::after{content:"";position:absolute;left:4%;right:4%;top:50%;height:2px;background:#ef4444;box-shadow:0 0 8px #ef4444;animation:inv-laser 1.4s ease-in-out infinite alternate}
@keyframes inv-laser{from{transform:translateY(-14px)}to{transform:translateY(14px)}}
.inv-scanner-grille{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr);gap:16px;align-items:start}
@media (max-width:1100px){.inv-scanner-grille{grid-template-columns:1fr}}
.inv-resultat-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.inv-param-grille{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
@media (max-width:1000px){.inv-param-grille{grid-template-columns:1fr}}
.inv-test-douchette{border:2px dashed var(--bordure-2);border-radius:8px;padding:14px;color:var(--texte-2);font-size:13px}
.inv-test-douchette input{margin-top:8px;font-family:Consolas,"Courier New",monospace;font-size:16px}
.inv-cellule-code{font-weight:600;font-family:Consolas,"Courier New",monospace;font-size:13px;white-space:nowrap}
.inv-kpi-masque .kpi-valeur{font-size:16px}
.inv-perimetre{background:var(--surface-2);border:1px solid var(--bordure);border-radius:8px;padding:10px 12px;font-size:13px}
.inv-perimetre strong{font-size:15px}
.inv-recap-chiffres{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
@media (max-width:760px){.inv-recap-chiffres{grid-template-columns:repeat(2,minmax(0,1fr))}}
.inv-recap-chiffres>div{background:var(--surface-2);border:1px solid var(--bordure);border-radius:8px;padding:10px 12px}
.inv-recap-chiffres .v{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums}
.inv-recap-chiffres .l{font-size:11.5px;color:var(--texte-2)}`;
    document.head.appendChild(st);
  }

  // =====================================================================================
  //  Formats d'étiquettes et rendu (aperçu = impression)
  // =====================================================================================
  const FORMATS = [
    { code: 'a4-3x7', groupe: 'Planches A4', label: 'A4 — 21 étiquettes 63,5 × 38,1 mm (type Avery L7160)', page: [210, 297], et: [63.5, 38.1], grille: [3, 7], marges: [15.15, 7.21], espaces: [2.54, 0] },
    { code: 'a4-3x8', groupe: 'Planches A4', label: 'A4 — 24 étiquettes 70 × 37 mm (type Avery 3474)', page: [210, 297], et: [70, 37], grille: [3, 8], marges: [0.5, 0], espaces: [0, 0] },
    { code: 'a4-2x7', groupe: 'Planches A4', label: 'A4 — 14 étiquettes 99,1 × 38,1 mm (type Avery L7163)', page: [210, 297], et: [99.1, 38.1], grille: [2, 7], marges: [15.15, 4.65], espaces: [2.5, 0] },
    { code: 'a4-4x10', groupe: 'Planches A4', label: 'A4 — 40 étiquettes 48,5 × 25,4 mm (type Avery 3657)', page: [210, 297], et: [48.5, 25.4], grille: [4, 10], marges: [21.5, 8], espaces: [0, 0] },
    { code: 'a4-5x13', groupe: 'Planches A4', label: 'A4 — 65 étiquettes 38,1 × 21,2 mm (type Avery L7651)', page: [210, 297], et: [38.1, 21.2], grille: [5, 13], marges: [10.7, 4.75], espaces: [2.5, 0] },
    { code: 'rouleau-50x25', groupe: 'Rouleaux (imprimante thermique)', label: 'Rouleau 50 × 25 mm', page: [50, 25], et: [50, 25], grille: [1, 1], marges: [0, 0], espaces: [0, 0], rouleau: true },
    { code: 'rouleau-57x32', groupe: 'Rouleaux (imprimante thermique)', label: 'Rouleau 57 × 32 mm', page: [57, 32], et: [57, 32], grille: [1, 1], marges: [0, 0], espaces: [0, 0], rouleau: true },
    { code: 'rouleau-100x50', groupe: 'Rouleaux (imprimante thermique)', label: 'Rouleau 100 × 50 mm', page: [100, 50], et: [100, 50], grille: [1, 1], marges: [0, 0], espaces: [0, 0], rouleau: true },
    { code: 'personnalise', groupe: 'Autre', label: 'Format personnalisé' },
  ];
  /** Format normalisé (dimensions en mm). */
  function format(code, perso) {
    let f = FORMATS.find((x) => x.code === code);
    if (!f) f = FORMATS[0];
    if (f.code === 'personnalise') {
      const p = Object.assign({}, PERSO_DEFAUT, perso || {});
      const n = (v, d, min) => { const x = Number(v); return Number.isFinite(x) && x >= (min || 0) ? x : d; };
      const colonnes = Math.max(1, Math.min(20, Math.round(n(p.colonnes, 1, 1))));
      const lignes = Math.max(1, Math.min(50, Math.round(n(p.lignes, 1, 1))));
      const pageL = n(p.pageLargeurMm, 210, 10), pageH = n(p.pageHauteurMm, 297, 10);
      const rouleau = colonnes === 1 && lignes === 1;
      return { code: 'personnalise', label: `Personnalisé ${ui.formatNombre(n(p.largeurMm, 50, 5))} × ${ui.formatNombre(n(p.hauteurMm, 25, 5))} mm`, pageL, pageH, l: n(p.largeurMm, 50, 5), h: n(p.hauteurMm, 25, 5), colonnes, lignes, margeHaut: n(p.margeHautMm, 0), margeGauche: n(p.margeGaucheMm, 0), espaceH: n(p.espaceHorizontalMm, 0), espaceV: n(p.espaceVerticalMm, 0), parPage: colonnes * lignes, rouleau };
    }
    return { code: f.code, label: f.label, pageL: f.page[0], pageH: f.page[1], l: f.et[0], h: f.et[1], colonnes: f.grille[0], lignes: f.grille[1], margeHaut: f.marges[0], margeGauche: f.marges[1], espaceH: f.espaces[0], espaceV: f.espaces[1], parPage: f.grille[0] * f.grille[1], rouleau: !!f.rouleau };
  }
  /** Le format tient-il dans la page ? (message sinon) */
  function controleFormat(f) {
    const largeur = f.margeGauche + f.colonnes * f.l + (f.colonnes - 1) * f.espaceH;
    const hauteur = f.margeHaut + f.lignes * f.h + (f.lignes - 1) * f.espaceV;
    if (largeur > f.pageL + 0.3) return `Les étiquettes dépassent la largeur de la page (${ui.formatNombre(largeur)} mm pour ${ui.formatNombre(f.pageL)} mm).`;
    if (hauteur > f.pageH + 0.3) return `Les étiquettes dépassent la hauteur de la page (${ui.formatNombre(hauteur)} mm pour ${ui.formatNombre(f.pageH)} mm).`;
    return '';
  }
  const mm = (n) => `${Math.round(Number(n) * 100) / 100}mm`;
  const borne = (v, min, max) => Math.max(min, Math.min(max, v));

  /** HTML d'une étiquette (dimensions en millimètres). */
  function htmlEtiquette(it, f, o) {
    const c = o.contenu;
    const W = f.l, H = f.h;
    const pad = borne(Math.min(W, H) * 0.07, 1.2, 3.2);
    const largeurUtile = W - 2 * pad;
    const fs = borne(H * 0.085, 2.0, 4.6);
    const fsPetit = borne(fs * 0.74, 1.65, 3.2);
    const fsCode = borne(fs * 0.78, 1.8, 3.6);
    const eq = it.type === 'equipement';
    const blocs = [];
    let hTexte = 0;
    if (c.societe && o.societe) {
      blocs.push(`<div class="et-soc" style="font-size:${mm(fsPetit)}">${esc(o.societe)}${eq ? ' · Immobilisation' : ''}</div>`);
      hTexte += fsPetit * 1.2 + 0.45;
    }
    if (c.designation && it.designation) {
      const parLigne = Math.max(4, largeurUtile / (fs * 0.52));
      const nb = Math.min(2, Math.ceil(String(it.designation).length / parLigne));
      blocs.push(`<div class="et-des" style="font-size:${mm(fs)}">${esc(it.designation)}</div>`);
      hTexte += fs * 1.16 * nb + 0.45;
    }
    const det = [];
    if (c.emplacement && it.emplacement) det.push((eq ? '' : 'Empl. ') + it.emplacement);
    if (c.referenceFournisseur && it.referenceFournisseur) det.push((eq ? 'N° série ' : 'Réf. ') + it.referenceFournisseur);
    if (c.unite && it.uniteLibelle) det.push('Unité : ' + it.uniteLibelle);
    if (c.categorie && (it.categorieLibelle || it.typeLibelle)) det.push(it.categorieLibelle || it.typeLibelle);
    if (c.prix && !eq && Number(it.prixUnitaire) > 0) det.push(ui.formatMontant(it.prixUnitaire));
    if (c.secteur && it.secteurNom) det.push(it.secteurNom);
    // Détails : une ou deux lignes selon la place
    const lignesDet = [];
    if (det.length) {
      const parLigne = Math.max(6, largeurUtile / (fsPetit * 0.5));
      let cur = '';
      for (const d of det) { const essai = cur ? cur + ' · ' + d : d; if (essai.length > parLigne && cur) { lignesDet.push(cur); cur = d; } else cur = essai; }
      if (cur) lignesDet.push(cur);
    }
    const nbDet = Math.min(lignesDet.length, H >= 30 ? 2 : 1);
    hTexte += nbDet ? (fsPetit * 1.2 * nbDet + 0.45) : 0;
    let cb = '';
    let dense = false;
    const code = String(it.code || '');
    if (c.codeBarre && code && CB()) {
      try {
        const nbModules = CB().modules(code).length;
        const xMax = W >= 90 ? 0.6 : 0.5;
        const x = Math.min(xMax, largeurUtile / nbModules);
        dense = x < 0.19;
        const hTxt = c.code ? fsCode * 1.2 : 0;
        const hb = borne(Math.min(Number(o.hauteurCodeMm) || 12, H - 2 * pad - hTexte - hTxt - 0.45), 3, 60);
        cb = `<div class="et-cb">${CB().svg(code, { hauteur: hb, largeurModule: x, unite: 'mm', texteVisible: !!c.code, taillePolice: fsCode, police: 'Consolas, "Courier New", monospace', fond: 'none' })}</div>`;
      } catch (e) {
        cb = `<div class="et-code et-erreur" style="font-size:${mm(fsCode)}" title="${esc(e.message)}">${esc(code)} — code non encodable</div>`;
      }
    } else if (c.code && code) {
      cb = `<div class="et-code" style="font-size:${mm(fs * 1.25)}">${esc(code)}</div>`;
    }
    // Ordre : société, désignation, code-barres, détails
    const html = blocs.slice(0, 2).join('') + cb + lignesDet.slice(0, nbDet).map((l) => `<div class="et-det" style="font-size:${mm(fsPetit)}">${esc(l)}</div>`).join('');
    return { html, pad, dense };
  }

  /**
   * Planches (pages) d'étiquettes. items = [{ it, n }] (n exemplaires).
   * o : { contenu, hauteurCodeMm, societe, decalage, contour, apercu, pagesMax }
   */
  function construirePlanches(items, f, o) {
    const liste = [];
    for (const x of items) for (let k = 0; k < Math.max(1, Number(x.n) || 1); k++) liste.push(x.it);
    const decalage = f.rouleau ? 0 : borne(Math.floor(Number(o.decalage) || 0), 0, f.parPage - 1);
    const pages = [];
    let page = [];
    let slot = decalage;
    for (let i = 0; i < decalage; i++) page.push({ slot: i, utilisee: true });
    for (const it of liste) {
      if (slot >= f.parPage) { pages.push(page); page = []; slot = 0; }
      page.push({ slot, it });
      slot++;
    }
    if (page.length) pages.push(page);
    const pos = (s) => {
      const col = s % f.colonnes, lig = Math.floor(s / f.colonnes);
      return { x: f.margeGauche + col * (f.l + f.espaceH), y: f.margeHaut + lig * (f.h + f.espaceV) };
    };
    let nbDenses = 0;
    const rendrePage = (p) => {
      const occupes = new Set(p.map((x) => x.slot));
      let h = `<div class="et-planche" style="width:${mm(f.pageL)};height:${mm(o.apercu ? f.pageH : Math.max(1, f.pageH - 0.3))}">`;
      for (const x of p) {
        const { x: X, y: Y } = pos(x.slot);
        const style = `left:${mm(X)};top:${mm(Y)};width:${mm(f.l)};height:${mm(f.h)}`;
        if (x.utilisee) { h += o.apercu ? `<div class="et et-utilisee" style="${style}" title="Étiquette déjà utilisée"></div>` : ''; continue; }
        const r = htmlEtiquette(x.it, f, o);
        if (r.dense) nbDenses++;
        h += `<div class="et${o.contour || o.apercu ? ' et-contour' : ''}${r.dense && o.apercu ? ' et-dense' : ''}" style="${style};padding:${mm(r.pad)}">${r.html}</div>`;
      }
      if (o.apercu) for (let s = 0; s < f.parPage; s++) if (!occupes.has(s)) { const { x: X, y: Y } = pos(s); h += `<div class="et et-vide" style="left:${mm(X)};top:${mm(Y)};width:${mm(f.l)};height:${mm(f.h)}"></div>`; }
      return h + '</div>';
    };
    const max = o.pagesMax == null ? pages.length : Math.min(pages.length, o.pagesMax);
    const debut = o.page == null ? 0 : borne(o.page, 0, Math.max(0, pages.length - 1));
    const html = pages.slice(debut, debut + max).map(rendrePage).join('');
    return { html, nbPages: pages.length, nbEtiquettes: liste.length, nbDenses };
  }

  /** Fenêtre d'impression : @page au format exact, positionnement en millimètres. */
  function imprimerEtiquettes(items, f, o) {
    const r = construirePlanches(items, f, Object.assign({}, o, { apercu: false }));
    if (!r.nbEtiquettes) { toast('Aucune étiquette à imprimer', 'alerte'); return; }
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) { toast('Fenêtre bloquée : autorisez les fenêtres surgissantes pour imprimer', 'alerte'); return; }
    const titre = `Étiquettes — ${pluriel(r.nbEtiquettes, 'étiquette')} (${f.label})`;
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title><style>
@page{size:${mm(f.pageL)} ${mm(f.pageH)};margin:0}
html,body{margin:0;padding:0;background:#fff}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
${CSS_ETIQUETTES}
.et-planche{page-break-after:always;break-after:page}
.et-planche:last-of-type{page-break-after:auto;break-after:auto}
.barre{font-family:"Segoe UI",Arial,sans-serif;font-size:13px;background:#111827;color:#e5e7eb;padding:10px 16px;display:flex;gap:14px;align-items:center;position:sticky;top:0;z-index:2}
.barre button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer}
.barre span{opacity:.85}
@media screen{body{background:#6b7280}.et-planche{margin:8mm auto;box-shadow:0 2px 12px rgba(0,0,0,.45)}}
@media print{.barre{display:none}}
</style></head><body><div class="barre"><button type="button" data-imprimer>Imprimer</button><span>${esc(titre)} — ${pluriel(r.nbPages, 'page')}. Réglez l'impression sur « Taille réelle / 100 % » et « Marges : aucune ».</span></div>${r.html}
</body></html>`);
    w.document.close();
    ui.lancerImpression(w);
    toast(`${pluriel(r.nbEtiquettes, 'étiquette')} envoyée${r.nbEtiquettes > 1 ? 's' : ''} à l'impression (${pluriel(r.nbPages, 'page')})`, 'succes');
  }

  /** Aperçu à l'échelle d'une page (largeur disponible en pixels). */
  function apercuPlanche(items, f, o, largeurPx) {
    const r = construirePlanches(items, f, Object.assign({}, o, { apercu: true, pagesMax: 1 }));
    const pxParMm = 96 / 25.4;
    const echelle = Math.min(f.rouleau ? 2.4 : 1, largeurPx / (f.pageL * pxParMm));
    const cadre = el('div', { class: 'inv-apercu-cadre', style: { width: Math.round(f.pageL * pxParMm * echelle) + 'px', height: Math.round(f.pageH * pxParMm * echelle) + 'px' } });
    cadre.innerHTML = r.html;
    const planche = cadre.firstElementChild;
    if (planche) planche.style.transform = `scale(${echelle})`;
    return { el: cadre, r };
  }

  // =====================================================================================
  //  Scan : écoute globale de la douchette et caméra
  // =====================================================================================
  /** Gestionnaire de l'écran actif (comptage, scanner) ; sinon le scan ouvre la fiche. */
  let scanLocal = null;
  function definirScanLocal(elAncre, fn) { scanLocal = { el: elAncre, fn }; }

  async function scanGlobal(code) {
    if (!GMAO.user || !GMAO.perms) return;
    if (scanLocal && scanLocal.el && scanLocal.el.isConnected) { scanLocal.fn(code); return; }
    scanLocal = null;
    if (cfgInv().scanGlobal === false) return;
    if (document.querySelector('.modal-fond')) return; // pas de navigation sous une fenêtre ouverte
    try {
      const r = await api.get('/api/codes/' + encodeURIComponent(code), null, { silent401: true });
      bip(true);
      toast(`${r.libelle || r.code} — ouverture de la fiche`, 'info');
      GMAO.navigate(r.lien);
    } catch (e) {
      if (e && (e.status === 401 || e.status === 0)) return;
      bip(false);
      toast(e.status === 404 ? `Code « ${code} » : aucun élément accessible ne correspond` : (e.message || String(e)), 'erreur');
    }
  }
  if (CB() && !window.__gmaoDouchetteInventaire) {
    window.__gmaoDouchetteInventaire = CB().ecouterDouchette((code) => { scanGlobal(code); }, { delaiMaxMs: 35, longueurMin: 3 });
  }

  /** Lecture par caméra dans une fenêtre modale ; onCode(code) à la première lecture. */
  async function ouvrirCamera(onCode) {
    if (!CB()) { toast('Bibliothèque code-barres indisponible', 'erreur'); return; }
    const video = el('video', { muted: true, playsinline: true, autoplay: true });
    const zone = el('div', { class: 'inv-camera' }, video, el('div', { class: 'inv-viseur' }));
    const statutEl = el('div', { class: 'texte-2 texte-petit mt' }, 'Démarrage de la caméra…');
    let cam = null;
    const m = ui.modal({
      titre: 'Scanner avec la caméra', taille: 'large',
      contenu: frag(zone, statutEl),
      boutons: [{ label: 'Fermer', icone: 'fermer' }],
      onFermer: () => { if (cam) cam.arreter(); },
    });
    try {
      cam = await CB().camera(video, (code) => { m.fermer(); onCode(code); });
      if (!m.el.isConnected) { cam.arreter(); return; }
      statutEl.textContent = `Placez le code-barres dans le cadre, à 10–20 cm de l'objectif (détecteur ${cam.mode === 'natif' ? 'natif du navigateur' : 'intégré'}).`;
    } catch (e) {
      if (!m.el.isConnected) return;
      zone.remove();
      statutEl.replaceWith(ui.alerte(frag(el('strong', null, 'Caméra indisponible. '), e.message || String(e)), 'alerte'));
    }
  }

  // =====================================================================================
  //  Onglet « Étiquettes »
  // =====================================================================================
  const etatEt = {
    source: null, filtres: { articles: {}, equipements: {} },
    selection: { articles: new Map(), equipements: new Map() },
    options: null, page: 0, lignes: [], refs: null,
  };
  function optionsEt() {
    if (!etatEt.options) {
      const c = cfgEt();
      etatEt.options = { format: c.format, hauteurCodeMm: c.hauteurCodeMm, decalage: c.decalage, contenu: Object.assign({}, c.contenu), formatPersonnalise: Object.assign({}, c.formatPersonnalise), contour: prefs.get('contour', false) };
    }
    return etatEt.options;
  }
  const sourcesDisponibles = () => [GMAO.can('stock', 'voir') ? 'articles' : null, GMAO.can('equipements', 'voir') ? 'equipements' : null].filter(Boolean);

  function exempleEtiquette(source) {
    return source === 'equipements'
      ? { type: 'equipement', code: 'EQ-0001', designation: 'Compresseur d\'air GA 37', emplacement: 'Local compresseurs', referenceFournisseur: 'API 625 118', typeLibelle: 'Machine', secteurNom: 'Maintenance' }
      : { type: 'article', code: 'ART-0001', designation: 'Roulement à billes 6205-2RS', emplacement: 'Magasin central — A1 — Étagère 2', referenceFournisseur: '6205-2RSH', uniteLibelle: 'Unité', categorieLibelle: 'Mécanique', prixUnitaire: 8.9, secteurNom: 'Maintenance' };
  }

  function rendreEtiquettes(query) {
    const sources = sourcesDisponibles();
    const racine = el('div');
    if (!sources.length) { racine.appendChild(ui.vide('L\'impression d\'étiquettes nécessite l\'accès au stock ou aux équipements.', 'alerte')); return racine; }
    if (query && (query.source === 'articles' || query.source === 'equipements') && sources.includes(query.source)) etatEt.source = query.source;
    if (!etatEt.source || !sources.includes(etatEt.source)) etatEt.source = sources[0];
    const o = optionsEt();

    racine.appendChild(el('p', { class: 'inv-intro' }, 'Sélectionnez les articles ou les équipements, choisissez le format de vos planches ou de votre rouleau, puis imprimez : les codes-barres Code 128 sont vectoriels et lisibles par toutes les douchettes.'));
    const grille = el('div', { class: 'inv-et-grille' });
    const gauche = el('div');
    const droite = el('div', { class: 'inv-et-cote' });
    grille.append(gauche, droite);
    racine.appendChild(grille);

    // ----- Sélection -----
    const zoneFiltres = el('div', { class: 'barre-outils' });
    const zoneTable = el('div');
    const resumeSel = el('div', { class: 'texte-2 texte-petit' });
    const boutonsSource = el('div', { class: 'btn-groupe' }, sources.map((s) => el('button', { type: 'button', class: 'btn btn-sm' + (s === etatEt.source ? ' actif' : ''), onclick: () => { if (etatEt.source === s) return; etatEt.source = s; etatEt.page = 0; ui.vider(racine); racine.replaceWith(rendreEtiquettes({})); } }, icone(s === 'articles' ? 'stock' : 'equipements'), s === 'articles' ? 'Articles du stock' : 'Équipements (immobilisations)')));
    gauche.appendChild(ui.carte('Éléments à étiqueter', frag(el('div', { class: 'barre-outils' }, boutonsSource, el('span', { class: 'espace' }), resumeSel), zoneFiltres, zoneTable)));

    // ----- Mise en page + aperçu -----
    const carteFormat = el('div');
    const zoneApercu = el('div');
    droite.appendChild(ui.carte('Mise en page', carteFormat));
    droite.appendChild(ui.carte('Aperçu', zoneApercu, { actions: [
      ui.bouton('Imprimer', { icone: 'imprimer', classe: 'btn-primaire btn-sm', onClic: () => imprimer() }),
    ] }));

    const selection = () => etatEt.selection[etatEt.source];
    const filtres = () => etatEt.filtres[etatEt.source];

    function itemsAImprimer() { return Array.from(selection().values()).map((x) => ({ it: x.it, n: x.n })); }
    function imprimer() {
      const items = itemsAImprimer();
      if (!items.length) { toast('Sélectionnez au moins un élément à étiqueter', 'alerte'); return; }
      const f = format(o.format, o.formatPersonnalise);
      const pb = controleFormat(f);
      if (pb) { toast(pb, 'erreur'); return; }
      imprimerEtiquettes(items, f, optionsRendu());
    }
    function optionsRendu() { return { contenu: o.contenu, hauteurCodeMm: o.hauteurCodeMm, decalage: o.decalage, contour: o.contour, societe: ((GMAO.config || {}).societe || {}).nom || '' }; }

    // Filtres
    let chargement = 0;
    const recharger = ui.debounce(() => charger(), 250);
    function construireFiltres() {
      ui.vider(zoneFiltres);
      const f = filtres();
      const champ = (nom, elt, evt) => { elt.addEventListener(evt || 'change', () => { f[nom] = elt.type === 'checkbox' ? elt.checked : elt.value; recharger(); }); return elt; };
      const recherche = champ('recherche', el('input', { type: 'search', placeholder: 'Rechercher (code, désignation, référence…)', value: f.recherche || '', style: { maxWidth: '260px' } }), 'input');
      zoneFiltres.appendChild(recherche);
      if (etatEt.source === 'articles') {
        zoneFiltres.appendChild(champ('categorieCode', el('select', null, ui.optionsListe('categoriesArticles', { vide: 'Toutes les catégories' }).map((x) => el('option', { value: x.value, selected: String(f.categorieCode || '') === String(x.value) }, x.label)))));
        const dl = el('datalist', { id: 'inv-dl-emplacements' }, ((etatEt.refs || {}).zones || []).concat((etatEt.refs || {}).emplacements || []).map((z) => el('option', { value: z })));
        zoneFiltres.appendChild(dl);
        zoneFiltres.appendChild(champ('emplacement', el('input', { type: 'text', list: 'inv-dl-emplacements', placeholder: 'Emplacement (début)…', value: f.emplacement || '', style: { maxWidth: '200px' } }), 'input'));
        zoneFiltres.appendChild(champ('fournisseurId', el('select', null, [el('option', { value: '' }, 'Tous les fournisseurs')].concat(((etatEt.refs || {}).fournisseurs || []).map((x) => el('option', { value: String(x.id), selected: String(f.fournisseurId || '') === String(x.id) }, x.nom))))));
        const cb = champ('sousSeuil', el('input', { type: 'checkbox', checked: !!f.sousSeuil }));
        zoneFiltres.appendChild(el('label', { class: 'inline' }, cb, 'Sous le seuil'));
      } else {
        zoneFiltres.appendChild(champ('secteurId', el('select', null, ui.optionsSecteurs({ vide: 'Tous les secteurs' }).map((x) => el('option', { value: String(x.value), selected: String(f.secteurId || '') === String(x.value) }, x.label)))));
        zoneFiltres.appendChild(champ('typeCode', el('select', null, ui.optionsListe('typesEquipement', { vide: 'Tous les types' }).map((x) => el('option', { value: x.value, selected: String(f.typeCode || '') === String(x.value) }, x.label)))));
      }
    }

    // Tableau de sélection
    let table = null;
    const caseTout = el('input', { type: 'checkbox', title: 'Tout sélectionner / désélectionner' });
    caseTout.addEventListener('change', () => {
      for (const it of etatEt.lignes) {
        if (caseTout.checked) { if (!selection().has(it.id)) selection().set(it.id, { it, n: 1 }); } else selection().delete(it.id);
      }
      majSelection(true);
    });
    function colonnes() {
      const art = etatEt.source === 'articles';
      return [
        { cle: '_sel', label: caseTout, tri: false, largeur: '34px', export: false, rendu: (r) => {
          const c = el('input', { type: 'checkbox', checked: selection().has(r.id), title: 'Sélectionner' });
          c.addEventListener('click', (ev) => ev.stopPropagation());
          c.addEventListener('change', () => { if (c.checked) selection().set(r.id, { it: r, n: (selection().get(r.id) || {}).n || 1 }); else selection().delete(r.id); majSelection(true); });
          return c;
        } },
        { cle: 'designation', label: art ? 'Article' : 'Équipement', valeurTri: (r) => String(r.designation || '').toLowerCase(), rendu: (r) => {
          const second = art ? [r.referenceFournisseur ? `Réf. ${r.referenceFournisseur}` : '', r.fournisseurNom].filter(Boolean).join(' · ') : [r.marque, r.modele].filter(Boolean).join(' ');
          return frag(el('div', { class: 'cellule-principale' }, r.designation),
            el('div', { class: 'cellule-secondaire inv-ligne-meta' }, el('span', { class: 'inv-cellule-code' }, r.code || '—'),
              r.encodable === false ? el('span', { title: r.erreurCode || 'Code non encodable' }, iconeDim('alerte', 13, 'var(--danger)')) : null,
              art ? (r.categorieCode ? ui.badgeListe('categoriesArticles', r.categorieCode) : null) : (r.typeCode ? ui.badgeListe('typesEquipement', r.typeCode) : null),
              second ? el('span', null, second) : null));
        } },
        { cle: 'emplacement', label: art ? 'Emplacement' : 'Localisation', rendu: (r) => frag(el('div', null, r.emplacement || el('span', { class: 'texte-2' }, '—')), !art && r.secteurNom ? el('div', { class: 'cellule-secondaire' }, r.secteurNom) : null) },
        art ? { cle: 'quantite', label: 'Stock', aligner: 'droite', valeurTri: (r) => Number(r.quantite) || 0, rendu: (r) => el('span', { class: r.sousSeuil ? 'texte-danger texte-gras' : '' }, qte(r.quantite, r.uniteCode)) } : null,
        { cle: '_n', label: 'Ex.', tri: false, aligner: 'centre', largeur: '84px', export: false, rendu: (r) => {
          const x = selection().get(r.id);
          const i = el('input', { type: 'number', class: 'inv-exemplaires', min: 1, max: 500, step: 1, value: x ? x.n : 1, disabled: !x, title: 'Nombre d\'exemplaires à imprimer' });
          i.addEventListener('click', (ev) => ev.stopPropagation());
          i.addEventListener('change', () => { const y = selection().get(r.id); if (!y) return; y.n = borne(Math.round(Number(i.value) || 1), 1, 500); i.value = y.n; majSelection(false); });
          return i;
        } },
      ].filter(Boolean);
    }
    function construireTable() {
      ui.vider(zoneTable);
      table = ui.table({
        colonnes: colonnes(), lignes: etatEt.lignes, recherche: false, compact: true, tailleParPage: 15,
        vide: etatEt.source === 'articles' ? 'Aucun article ne correspond aux filtres' : 'Aucun équipement ne correspond aux filtres',
        onClic: (r) => { if (selection().has(r.id)) selection().delete(r.id); else selection().set(r.id, { it: r, n: 1 }); majSelection(true); },
        ligneClasse: (r) => (selection().has(r.id) ? 'inv-selectionnee' : ''),
        outils: [
          ui.bouton('Tout sélectionner', { icone: 'check', classe: 'btn-sm', onClic: () => { for (const it of etatEt.lignes) if (!selection().has(it.id)) selection().set(it.id, { it, n: 1 }); majSelection(true); } }),
          ui.bouton('Vider la sélection', { icone: 'fermer', classe: 'btn-sm', onClic: () => { selection().clear(); majSelection(true); } }),
          etatEt.source === 'articles' ? ui.bouton('1 étiquette par pièce en stock', { icone: 'stock', classe: 'btn-sm', titre: 'Nombre d\'exemplaires = quantité en stock (articles sélectionnés, 500 au maximum)', onClic: () => { if (!selection().size) { toast('Sélectionnez d\'abord des articles', 'alerte'); return; } for (const x of selection().values()) x.n = borne(Math.round(Number(x.it.quantite) || 1), 1, 500); majSelection(true); } }) : null,
        ],
      });
      zoneTable.appendChild(table.el);
    }
    function majSelection(rerendre) {
      const n = selection().size;
      const total = Array.from(selection().values()).reduce((s, x) => s + x.n, 0);
      ui.vider(resumeSel);
      resumeSel.appendChild(document.createTextNode(n ? `${pluriel(n, etatEt.source === 'articles' ? 'article sélectionné' : 'équipement sélectionné', etatEt.source === 'articles' ? 'articles sélectionnés' : 'équipements sélectionnés')} · ${pluriel(total, 'étiquette')}` : 'Aucune sélection'));
      caseTout.checked = !!etatEt.lignes.length && etatEt.lignes.every((x) => selection().has(x.id));
      caseTout.indeterminate = !caseTout.checked && etatEt.lignes.some((x) => selection().has(x.id));
      if (rerendre && table) table.rendre();
      etatEt.page = 0;
      majApercu();
    }

    async function charger() {
      const num = ++chargement;
      const f = filtres();
      const q = { source: etatEt.source, recherche: f.recherche || '' };
      if (etatEt.source === 'articles') Object.assign(q, { categorieCode: f.categorieCode || '', emplacement: f.emplacement || '', fournisseurId: f.fournisseurId || '', sousSeuil: f.sousSeuil ? '1' : '' });
      else Object.assign(q, { secteurId: f.secteurId || '', typeCode: f.typeCode || '' });
      try {
        const r = await api.get('/api/etiquettes/donnees', q);
        if (num !== chargement || !racine.isConnected) return;
        etatEt.lignes = r.lignes || [];
        // Les données des éléments déjà sélectionnés sont rafraîchies
        for (const it of etatEt.lignes) { const s = selection().get(it.id); if (s) s.it = it; }
        if (table) table.maj(etatEt.lignes); else construireTable();
        majSelection(false);
      } catch (e) { erreur(e); }
    }

    // ----- Formulaire de mise en page -----
    function construireFormat() {
      ui.vider(carteFormat);
      const selFormat = el('select', { id: 'inv-format' });
      const groupes = new Map();
      for (const f of FORMATS) { if (!groupes.has(f.groupe)) groupes.set(f.groupe, el('optgroup', { label: f.groupe })); groupes.get(f.groupe).appendChild(el('option', { value: f.code, selected: f.code === o.format }, f.label)); }
      groupes.forEach((g) => selFormat.appendChild(g));
      if (!FORMATS.some((f) => f.code === o.format)) { o.format = 'a4-3x7'; selFormat.value = o.format; }
      selFormat.addEventListener('change', () => { o.format = selFormat.value; etatEt.page = 0; construireFormat(); majApercu(); });
      const fmt = format(o.format, o.formatPersonnalise);
      const champNombre = (label, valeur, attrs, onChange) => {
        const i = el('input', Object.assign({ type: 'number', value: valeur, step: 'any' }, attrs || {}));
        i.addEventListener('change', () => onChange(i));
        return el('div', { class: 'champ' }, el('label', null, label), i);
      };
      const hauteur = champNombre('Hauteur du code-barres (mm)', o.hauteurCodeMm, { min: 4, max: 40, step: 0.5, id: 'inv-hauteur' }, (i) => { o.hauteurCodeMm = borne(Number(i.value) || 12, 4, 40); i.value = o.hauteurCodeMm; majApercu(); });
      const decalage = champNombre('Étiquettes déjà utilisées sur la planche', o.decalage, { min: 0, max: Math.max(0, fmt.parPage - 1), step: 1, id: 'inv-decalage', disabled: fmt.rouleau }, (i) => { o.decalage = borne(Math.round(Number(i.value) || 0), 0, Math.max(0, fmt.parPage - 1)); i.value = o.decalage; etatEt.page = 0; majApercu(); });
      const libContenu = { codeBarre: 'Code-barres', code: 'Code en clair', designation: 'Désignation', emplacement: etatEt.source === 'equipements' ? 'Localisation' : 'Emplacement', referenceFournisseur: etatEt.source === 'equipements' ? 'N° de série' : 'Réf. fournisseur', unite: 'Unité', categorie: etatEt.source === 'equipements' ? 'Type' : 'Catégorie', societe: 'Société', prix: 'Prix unitaire', secteur: 'Secteur / magasin' };
      const cases = el('div', { class: 'inv-contenu-cases' }, Object.keys(CONTENU_DEFAUT).map((k) => {
        const c = el('input', { type: 'checkbox', checked: !!o.contenu[k], dataset: { contenu: k } });
        c.addEventListener('change', () => { o.contenu[k] = c.checked; majApercu(); });
        return el('label', null, c, libContenu[k]);
      }));
      const contour = el('input', { type: 'checkbox', checked: !!o.contour });
      contour.addEventListener('change', () => { o.contour = contour.checked; prefs.set('contour', o.contour); });
      ui.append(carteFormat, [
        el('div', { class: 'champ' }, el('label', { for: 'inv-format' }, 'Format'), selFormat),
        o.format === 'personnalise' ? formatPerso() : null,
        el('div', { class: 'inv-champs-ligne mt' }, hauteur, decalage),
        el('div', { class: 'champ mt' }, el('div', { class: 'label' }, 'Contenu des étiquettes'), cases),
        el('label', { class: 'inline texte-petit mt', style: { cursor: 'pointer' } }, contour, 'Imprimer le contour des étiquettes (essai sur papier blanc)'),
        GMAO.can('configuration', 'modifier') ? el('div', { class: 'mt' }, ui.bouton('Enregistrer comme format par défaut', { icone: 'sauvegarde', classe: 'btn-sm', onClic: enregistrerDefaut })) : null,
      ]);
    }
    function formatPerso() {
      const p = o.formatPersonnalise;
      const defs = [['largeurMm', 'Largeur étiquette (mm)'], ['hauteurMm', 'Hauteur étiquette (mm)'], ['colonnes', 'Colonnes'], ['lignes', 'Lignes'], ['margeHautMm', 'Marge haute (mm)'], ['margeGaucheMm', 'Marge gauche (mm)'], ['espaceHorizontalMm', 'Espace horizontal (mm)'], ['espaceVerticalMm', 'Espace vertical (mm)'], ['pageLargeurMm', 'Largeur page (mm)'], ['pageHauteurMm', 'Hauteur page (mm)']];
      const avert = el('div');
      const maj = () => { ui.vider(avert); const pb = controleFormat(format('personnalise', p)); if (pb) avert.appendChild(ui.alerte(pb, 'alerte')); };
      const grille = el('div', { class: 'inv-champs-ligne mt' }, defs.map(([k, label]) => {
        const i = el('input', { type: 'number', min: 0, step: k === 'colonnes' || k === 'lignes' ? 1 : 0.1, value: p[k] });
        i.addEventListener('change', () => { const v = Number(i.value); if (Number.isFinite(v) && v >= 0) p[k] = v; else i.value = p[k]; etatEt.page = 0; maj(); majApercu(); });
        return el('div', { class: 'champ' }, el('label', null, label), i);
      }));
      maj();
      return frag(grille, avert);
    }
    async function enregistrerDefaut() {
      try {
        const res = await api.put('/api/configuration', { etiquettes: { format: o.format, hauteurCodeMm: o.hauteurCodeMm, decalage: o.decalage, contenu: o.contenu, formatPersonnalise: o.formatPersonnalise } });
        if (res && res.etiquettes) GMAO.config.etiquettes = res.etiquettes;
        toast('Format d\'étiquettes enregistré par défaut pour tous les utilisateurs', 'succes');
      } catch (e) { erreur(e); }
    }

    function majApercu() {
      ui.vider(zoneApercu);
      const f = format(o.format, o.formatPersonnalise);
      const items = itemsAImprimer();
      const exemple = !items.length;
      const liste = exemple ? [{ it: etatEt.lignes[0] || exempleEtiquette(etatEt.source), n: 1 }] : items;
      const largeur = Math.max(240, Math.min(520, (zoneApercu.parentNode && zoneApercu.parentNode.clientWidth ? zoneApercu.parentNode.clientWidth - 70 : 420)));
      const total = construirePlanches(liste, f, Object.assign(optionsRendu(), { apercu: true, pagesMax: 0 }));
      etatEt.page = borne(etatEt.page, 0, Math.max(0, total.nbPages - 1));
      const { el: cadre, r } = apercuPlanche(liste, f, Object.assign(optionsRendu(), { page: etatEt.page }), largeur);
      zoneApercu.appendChild(el('div', { class: 'inv-resume-impression' },
        el('div', null, el('div', { class: 'v' }, exemple ? '0' : ui.formatNombre(total.nbEtiquettes)), el('div', { class: 'l' }, 'Étiquettes')),
        el('div', null, el('div', { class: 'v' }, exemple ? '0' : ui.formatNombre(total.nbPages)), el('div', { class: 'l' }, f.rouleau ? 'Étiquettes (rouleau)' : 'Planches')),
        el('div', null, el('div', { class: 'v' }, `${ui.formatNombre(f.l)} × ${ui.formatNombre(f.h)}`), el('div', { class: 'l' }, 'Millimètres'))));
      if (exemple) zoneApercu.appendChild(ui.alerte('Aperçu d\'exemple : sélectionnez des éléments dans la liste pour préparer l\'impression.', 'info'));
      const pb = controleFormat(f);
      if (pb) zoneApercu.appendChild(ui.alerte(pb, 'alerte'));
      if (r.nbDenses) zoneApercu.appendChild(ui.alerte('Certains codes sont trop longs pour la largeur de l\'étiquette (barres très fines, lecture difficile) : choisissez un format plus large.', 'alerte'));
      zoneApercu.appendChild(el('div', { class: 'inv-apercu' }, cadre));
      if (total.nbPages > 1) {
        zoneApercu.appendChild(el('div', { class: 'inv-apercu-nav' },
          ui.bouton('Précédente', { icone: 'fleche_gauche', classe: 'btn-sm', disabled: etatEt.page <= 0, onClic: () => { etatEt.page--; majApercu(); } }),
          el('span', null, `${f.rouleau ? 'Étiquette' : 'Planche'} ${etatEt.page + 1} / ${total.nbPages}`),
          ui.bouton('Suivante', { icone: 'fleche_droite', classe: 'btn-sm', disabled: etatEt.page >= total.nbPages - 1, onClic: () => { etatEt.page++; majApercu(); } })));
      }
      zoneApercu.appendChild(el('div', { class: 'texte-2 texte-petit mt' }, f.rouleau
        ? 'Rouleau : une étiquette par page. Dans le pilote de l\'imprimante thermique, choisissez le même format d\'étiquette.'
        : 'Imprimez en « Taille réelle / 100 % », sans marges. Les cases hachurées correspondent aux étiquettes déjà utilisées.'));
    }

    // Initialisation
    (async () => {
      try { etatEt.refs = await api.get('/api/inventaire/references'); } catch (e) { etatEt.refs = { zones: [], emplacements: [], fournisseurs: [] }; }
      construireFiltres();
      // Présélection par l'URL : ?source=…&ids=1,2
      if (query && query.ids && etatEt.source === (query.source || etatEt.source)) {
        try {
          const r = await api.get('/api/etiquettes/donnees', { source: etatEt.source, ids: String(query.ids) });
          for (const it of r.lignes || []) selection().set(it.id, { it, n: 1 });
          if (r.manquants) toast(`${pluriel(r.manquants, 'élément introuvable ou hors de votre périmètre', 'éléments introuvables ou hors de votre périmètre')}`, 'alerte');
        } catch (e) { erreur(e); }
      }
      await charger();
      if (!table) construireTable();
    })();
    construireFiltres();
    construireFormat();
    majApercu();
    return racine;
  }

  // =====================================================================================
  //  Onglet « Inventaires » (liste) et création
  // =====================================================================================
  async function ouvrirNouvelInventaire() {
    let refs = { zones: [], emplacements: [], fournisseurs: [] };
    try { refs = await api.get('/api/inventaire/references'); } catch (e) { /* listes vides */ }
    const tous = (GMAO.perms || {}).portee === 'tous';
    const optsSecteurs = ui.optionsSecteurs({ vide: tous ? '— Tous les sites —' : false }).filter((x) => x.value === '' || !GMAO.siteLectureSeule(x.value));
    const defaut = GMAO.siteCourant() || (tous ? '' : ((GMAO.user.secteurIds || []).find((s) => optsSecteurs.some((o) => o.value === Number(s))) || (optsSecteurs[0] || {}).value || ''));
    const apercu = el('div', { class: 'inv-perimetre' }, ui.chargement('Calcul du périmètre…'));
    let jeton = 0;
    const majApercu = ui.debounce(async (f) => {
      const n = ++jeton;
      const v = f.valeurs();
      try {
        const r = await api.get('/api/inventaires-apercu', { secteurId: v.secteurId || '', emplacement: v.emplacement || '', categorieCode: v.categorieCode || '', fournisseurId: v.fournisseurId || '', magasinId: v.magasinId || '' });
        if (n !== jeton) return;
        ui.vider(apercu);
        if (!r.nbArticles) { apercu.appendChild(el('span', { class: 'texte-danger' }, 'Aucun article actif ne correspond à ce périmètre.')); return; }
        apercu.append(el('div', null, el('strong', null, pluriel(r.nbArticles, 'article')), ' à compter', r.valeurTheorique > 0 ? ` · valeur théorique ${ui.formatMontant(r.valeurTheorique)}` : ''),
          el('div', { class: 'texte-2 texte-petit', style: { marginTop: '4px' } }, r.exemples.map((x) => `${x.code} ${x.designation}`).join(' · ') + (r.nbArticles > r.exemples.length ? ' …' : '')));
      } catch (e) { if (n === jeton) { ui.vider(apercu); apercu.appendChild(el('span', { class: 'texte-danger' }, e.message)); } }
    }, 300);
    const imposeAveugle = cfgInv().aveugle && !can('valider');
    const m = ui.formModal({
      titre: 'Nouvel inventaire', taille: 'large', submitLabel: 'Ouvrir l\'inventaire',
      champs: [
        { nom: 'nom', label: 'Nom de l\'inventaire', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'ex. Inventaire tournant — allée A' },
        { nom: 'secteurId', label: 'Site / magasin', type: 'select', options: optsSecteurs, requis: !tous, aide: tous ? 'Détermine qui voit l\'inventaire (portée, multi-site).' : 'Obligatoire : un de vos secteurs.', onChange: (v, f) => majApercu(f) },
        { nom: 'aveugle', label: 'Comptage à l\'aveugle', type: 'interrupteur', valeur: !!cfgInv().aveugle, disabled: imposeAveugle, aide: 'Les compteurs ne voient ni les quantités théoriques ni les écarts (seuls les valideurs les voient).' },
        { type: 'separateur', label: 'Périmètre : articles actifs à compter' },
        { nom: 'emplacement', label: 'Emplacement (début du libellé)', type: 'texte', placeholder: 'ex. Magasin central — A', suggestions: (refs.zones || []).concat(refs.emplacements || []), aide: 'Inclut tous les emplacements qui commencent par ce texte. Vide : tout le magasin.', onInput: (v, f) => majApercu(f), onChange: (v, f) => majApercu(f) },
        { nom: 'categorieCode', label: 'Catégorie d\'articles', type: 'select', options: ui.optionsListe('categoriesArticles', { vide: 'Toutes les catégories' }), onChange: (v, f) => majApercu(f) },
        { nom: 'fournisseurId', label: 'Fournisseur', type: 'select', options: [{ value: '', label: 'Tous les fournisseurs' }].concat((refs.fournisseurs || []).map((x) => ({ value: x.id, label: x.nom }))), onChange: (v, f) => majApercu(f) },
        { nom: 'magasinId', label: 'Magasin des articles', type: 'select', options: ui.optionsSecteurs({ vide: 'Tous (articles du site et sans magasin)' }), onChange: (v, f) => majApercu(f) },
        { type: 'html', rendu: () => apercu },
        { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 2, placeholder: 'Consignes aux compteurs, motif de l\'inventaire…' },
      ],
      valeurs: { nom: `Inventaire du ${ui.formatDate(new Date())}`, secteurId: defaut, aveugle: !!cfgInv().aveugle },
      onSubmit: async (v) => {
        const body = { nom: v.nom, secteurId: v.secteurId === '' ? null : v.secteurId, aveugle: !!v.aveugle, commentaire: v.commentaire || '', filtres: { emplacement: v.emplacement || '', categorieCode: v.categorieCode || null, fournisseurId: v.fournisseurId === '' ? null : v.fournisseurId, secteurId: v.magasinId === '' ? null : v.magasinId } };
        const r = await api.post('/api/inventaires', body);
        toast(`Inventaire ${r.numero} ouvert : ${pluriel(r.lignes.length, 'article')} à compter`, 'succes');
        if (r.chevauchements && r.chevauchements.length) toast(`Attention : ${r.chevauchements.map((c) => `${pluriel(c.nbArticles, 'article')} déjà dans ${c.numero}`).join(', ')} (inventaire en cours)`, 'alerte', 8000);
        GMAO.navigate('#/inventaire/' + r.id);
      },
    });
    majApercu(m.form);
  }

  /** Secteur et ses descendants (références chargées au démarrage). */
  function descendants(id) {
    const out = new Set([Number(id)]);
    let change = true;
    const all = (GMAO.refs || {}).secteurs || [];
    while (change) { change = false; for (const s of all) if (s.parentId != null && out.has(Number(s.parentId)) && !out.has(s.id)) { out.add(s.id); change = true; } }
    return out;
  }

  function rendreInventaires() {
    const racine = el('div');
    const memo = rendreInventaires.memo || (rendreInventaires.memo = { statut: '', secteurId: '' });
    const zoneKpi = el('div', { class: 'grille grille-4 mb' });
    const zoneTable = el('div');
    const selStatut = el('select', { 'aria-label': 'Statut' }, el('option', { value: '' }, 'Tous les statuts'), statuts().map((s) => el('option', { value: s.code, selected: memo.statut === s.code }, s.label)));
    const selSecteur = el('select', { 'aria-label': 'Site / magasin' }, ui.optionsSecteurs({ vide: 'Tous les sites / magasins' }).map((x) => el('option', { value: String(x.value), selected: String(memo.secteurId) === String(x.value) }, x.label)));
    racine.append(zoneKpi, zoneTable);
    let table = null;
    let toutes = [];
    const filtrees = () => {
      let rows = toutes;
      if (memo.statut) rows = rows.filter((i) => i.statut === memo.statut);
      if (memo.secteurId) { const ids = descendants(memo.secteurId); rows = rows.filter((i) => i.secteurId != null && ids.has(Number(i.secteurId))); }
      return rows;
    };
    const filtrer = () => { if (table) table.maj(filtrees()); };
    selStatut.addEventListener('change', () => { memo.statut = selStatut.value; filtrer(); });
    selSecteur.addEventListener('change', () => { memo.secteurId = selSecteur.value; filtrer(); });
    function kpis() {
      ui.vider(zoneKpi);
      const enCours = toutes.filter((i) => i.statut === 'en_cours');
      const restant = enCours.reduce((s, i) => s + ((i.resume || {}).nbNonComptees || 0), 0);
      const valides = toutes.filter((i) => i.statut === 'valide').sort((a, b) => String(b.dateValidation || '').localeCompare(String(a.dateValidation || '')));
      const dernier = valides[0];
      const annee = String(new Date().getFullYear());
      const deLAnnee = valides.filter((i) => String(i.dateValidation || '').slice(0, 4) === annee);
      const valeurAnnee = deLAnnee.filter((i) => !i.masque).reduce((s, i) => s + ((i.resume || {}).valeurEcart || 0), 0);
      const rd = dernier ? dernier.resume || {} : {};
      zoneKpi.append(
        ui.kpi({ label: 'Inventaires en cours', valeur: enCours.length, icone: 'codebarre', couleur: '#f59e0b', detail: enCours.length ? `${pluriel(restant, 'article')} restant à compter` : 'aucun comptage en cours', onClic: () => { memo.statut = 'en_cours'; selStatut.value = 'en_cours'; filtrer(); } }),
        ui.kpi({ label: 'Dernier inventaire validé', valeur: dernier ? dernier.numero : '—', icone: 'check', couleur: '#16a34a', detail: dernier ? `${ui.formatDate(dernier.dateValidation)} · ${dernier.nom}` : 'aucun inventaire validé', onClic: dernier ? () => GMAO.navigate('#/inventaire/' + dernier.id) : null }),
        ui.kpi({ label: 'Écarts du dernier inventaire', valeur: dernier && !dernier.masque ? montantSigne(rd.valeurEcart || 0) : '—', icone: 'euro', couleur: dernier && (rd.valeurEcart || 0) < 0 ? '#dc2626' : '#2563eb', detail: dernier && !dernier.masque ? `${pluriel(rd.nbEcarts || 0, 'article')} en écart sur ${ui.formatNombre(rd.nbLignes || 0)}` : (dernier ? 'comptage à l\'aveugle' : '') }),
        ui.kpi({ label: `Écarts valorisés ${annee}`, valeur: montantSigne(Math.round(valeurAnnee * 100) / 100), icone: 'rapports', couleur: valeurAnnee < 0 ? '#dc2626' : '#16a34a', detail: `${pluriel(deLAnnee.length, 'inventaire validé', 'inventaires validés')} cette année` }));
    }
    function construire() {
      const colonnes = [
        { cle: 'numero', label: 'Numéro', rendu: (r) => el('span', { class: 'cellule-principale inv-nowrap' }, r.numero), exportValeur: (r) => r.numero },
        { cle: 'nom', label: 'Inventaire', rendu: (r) => frag(el('div', { class: 'cellule-principale' }, r.nom, r.aveugle ? el('span', { style: { marginLeft: '6px' } }, badgeAveugle()) : null), el('div', { class: 'cellule-secondaire' }, [r.filtres && r.filtres.emplacement ? `Emplacement : ${r.filtres.emplacement}…` : 'Tout le magasin', r.filtres && r.filtres.categorieCode ? ui.libelle('categoriesArticles', r.filtres.categorieCode) : null].filter(Boolean).join(' · '))), exportValeur: (r) => r.nom },
        { cle: 'secteurNom', label: 'Site / magasin', rendu: (r) => (r.secteurId != null ? ui.cheminSecteur(r.secteurId) || r.secteurNom : el('span', { class: 'texte-2' }, 'Tous les sites')), exportValeur: (r) => r.secteurChemin || r.secteurNom || '' },
        { cle: 'statut', label: 'Statut', rendu: (r) => badgeStatut(r.statut), valeurTri: (r) => statut(r.statut).ordre || 0, exportValeur: (r) => statut(r.statut).label },
        { cle: 'progression', label: 'Progression', largeur: '170px', valeurTri: (r) => (r.resume || {}).progression || 0, rendu: (r) => { const x = r.resume || {}; return el('div', { title: `${x.nbComptees || 0} / ${x.nbLignes || 0} article(s) compté(s)` }, barreProgression(x.progression, r.statut === 'annule' ? 'var(--texte-2)' : null), el('div', { class: 'cellule-secondaire', style: { marginTop: '3px' } }, `${ui.formatNombre(x.nbComptees || 0)} / ${ui.formatNombre(x.nbLignes || 0)} · ${ui.formatNombre(x.progression || 0, 0)} %`)); }, exportValeur: (r) => `${(r.resume || {}).nbComptees || 0}/${(r.resume || {}).nbLignes || 0}` },
        { cle: 'ecarts', label: 'Écarts', aligner: 'droite', valeurTri: (r) => (r.masque ? -1 : (r.resume || {}).nbEcarts || 0), rendu: (r) => (r.masque ? el('span', { class: 'texte-2', title: 'Comptage à l\'aveugle' }, 'masqués') : ui.formatNombre((r.resume || {}).nbEcarts || 0)), exportValeur: (r) => (r.masque ? '' : (r.resume || {}).nbEcarts || 0) },
        { cle: 'valeur', label: 'Valeur des écarts', aligner: 'droite', valeurTri: (r) => (r.masque ? 0 : (r.resume || {}).valeurEcart || 0), rendu: (r) => (r.masque ? el('span', { class: 'texte-2' }, '—') : el('span', { class: classeEcart((r.resume || {}).valeurEcart) }, montantSigne((r.resume || {}).valeurEcart || 0))), exportValeur: (r) => (r.masque ? '' : String((r.resume || {}).valeurEcart || 0).replace('.', ',')) },
        { cle: 'dateOuverture', label: 'Ouvert le', valeurTri: (r) => r.dateOuverture || '', rendu: (r) => frag(el('div', null, ui.formatDate(r.dateOuverture)), el('div', { class: 'cellule-secondaire' }, r.createdByNom || '')), exportValeur: (r) => `${ui.formatDate(r.dateOuverture)} ${r.createdByNom || ''}` },
        { cle: 'dateValidation', label: 'Validé le', valeurTri: (r) => r.dateValidation || '', rendu: (r) => (r.dateValidation ? frag(el('div', null, ui.formatDate(r.dateValidation)), el('div', { class: 'cellule-secondaire' }, r.valideParNom || '')) : el('span', { class: 'texte-2' }, '—')), exportValeur: (r) => (r.dateValidation ? `${ui.formatDate(r.dateValidation)} ${r.valideParNom || ''}` : '') },
      ];
      table = ui.table({
        colonnes, lignes: filtrees(), recherche: 'Rechercher un inventaire…', onClic: (r) => GMAO.navigate('#/inventaire/' + r.id),
        triInitial: { cle: 'dateOuverture', sens: 'desc' }, exportCsv: can('exporter') ? `inventaires-${ui.aujourdhui()}.csv` : null,
        ligneClasse: (r) => (r.statut === 'annule' ? 'inactif' : ''),
        vide: 'Aucun inventaire. Ouvrez un premier inventaire pour compter le magasin avec la douchette.',
        outils: [selStatut, selSecteur],
      });
      zoneTable.appendChild(table.el);
    }
    return api.get('/api/inventaires').then((rows) => { toutes = rows || []; kpis(); construire(); return racine; });
  }

  // =====================================================================================
  //  Écran de comptage (#/inventaire/:id)
  // =====================================================================================
  async function afficherInventaire(container, id) {
    let inv;
    try { inv = await api.get('/api/inventaires/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'codebarre', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/inventaire' }, { label: 'Inventaire' }] }));
      container.appendChild(ui.vide(e.status === 404 ? 'Inventaire introuvable ou hors de votre périmètre.' : e.message, 'alerte'));
      container.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour aux inventaires', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/inventaire?onglet=inventaires') })));
      return;
    }
    const d = inv.droits || {};
    const enCours = inv.statut === 'en_cours';
    const masque = !!inv.masque;
    const etat = { historique: [], segment: prefs.get('segment', 'toutes'), mode: prefs.get('modeScan', inv.config && inv.config.modeScan ? inv.config.modeScan : modeScanDefaut()), enAttente: null };
    if (!['toutes', 'non_comptees', 'ecarts', 'hors', 'mouvements'].includes(etat.segment) || (masque && etat.segment === 'ecarts')) etat.segment = 'toutes';
    if (!['quantite', 'unitaire'].includes(etat.mode)) etat.mode = 'quantite';
    const recharger = () => GMAO.rendre();

    // ----- En-tête -----
    const sousTitre = [inv.nom, inv.secteurId != null ? ui.cheminSecteur(inv.secteurId) || inv.secteurNom : 'Tous les sites', `ouvert le ${ui.formatDateHeure(inv.dateOuverture)} par ${inv.createdByNom || '—'}`].filter(Boolean).join(' · ');
    container.appendChild(ui.pageEntete({
      titre: frag(inv.numero, ' ', badgeStatut(inv.statut), inv.aveugle ? frag(' ', badgeAveugle()) : null),
      icone: 'codebarre', sousTitre,
      filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/inventaire' }, { label: 'Inventaires', href: '#/inventaire?onglet=inventaires' }, { label: inv.numero }],
      actions: [
        ui.bouton('Feuille de comptage', { icone: 'imprimer', onClic: () => imprimerFeuille(inv) }),
        d.exporter ? ui.bouton('Exporter CSV', { icone: 'export', onClic: async () => { try { await api.telecharger(`/api/inventaires/${inv.id}/export`); toast('Export CSV téléchargé', 'succes'); } catch (e) { erreur(e); } } }) : null,
        d.modifier ? ui.bouton('Modifier', { icone: 'modifier', onClic: () => modifierInventaire(inv, recharger) }) : null,
        d.annuler ? ui.bouton('Annuler l\'inventaire', { icone: 'fermer', onClic: () => annulerInventaire(inv, recharger) }) : null,
        d.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-danger', onClic: () => supprimerInventaire(inv) }) : null,
        d.valider ? ui.bouton('Valider l\'inventaire', { icone: 'check', classe: 'btn-ok', onClic: () => ouvrirValidation(inv, recharger) }) : null,
      ],
    }));

    // ----- Alertes -----
    if (inv.statut === 'valide') container.appendChild(ui.alerte(frag(el('strong', null, `Inventaire validé le ${ui.formatDateHeure(inv.dateValidation)} par ${inv.valideParNom || '—'}. `), `${pluriel((inv.mouvementIds || []).length, 'mouvement')} d'inventaire enregistré${(inv.mouvementIds || []).length > 1 ? 's' : ''} dans le stock${masque ? '' : ` · écart total ${montantSigne((inv.resume || {}).valeurEcart || 0)}`}${inv.nonComptesAZero ? ' · articles non comptés mis à zéro' : ''}.`), 'ok'));
    if (inv.statut === 'annule') container.appendChild(ui.alerte(frag(el('strong', null, `Inventaire annulé le ${ui.formatDateHeure(inv.dateAnnulation)} par ${inv.annuleParNom || '—'}. `), inv.motifAnnulation ? `Motif : ${inv.motifAnnulation}. ` : '', 'Aucun mouvement de stock n\'a été enregistré.'), 'info'));
    if (enCours && d.lectureSeule) container.appendChild(ui.alerte('Ce site vous est accessible en lecture seule : consultation uniquement.', 'info'));
    const zoneAlerteMvts = el('div');
    container.appendChild(zoneAlerteMvts);
    if (inv.commentaire) container.appendChild(el('div', { class: 'texte-2 mb', style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, iconeDim('commentaire', 14), ' ', inv.commentaire));

    // ----- Indicateurs -----
    const zoneKpi = el('div', { class: 'grille grille-4 mb' });
    const zoneProgression = el('div', { class: 'inv-progression-globale' });
    container.append(zoneKpi, zoneProgression);

    // ----- Zone de scan -----
    let champScan = null;
    let zoneCarte = null;
    let listeHisto = null;
    if (enCours && d.compter) {
      champScan = el('input', { type: 'text', id: 'inv-scan', autocomplete: 'off', spellcheck: 'false', placeholder: 'Scannez ou saisissez un code…', 'aria-label': 'Code à scanner' });
      zoneCarte = el('div');
      listeHisto = el('ul', { class: 'inv-historique' });
      const boutonsMode = el('div', { class: 'btn-groupe', title: 'Mode de scan' });
      const majModes = () => { ui.vider(boutonsMode); for (const [m, label, ic] of [['quantite', 'Quantité après chaque scan', 'modifier'], ['unitaire', '+1 à chaque scan', 'plus']]) boutonsMode.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (etat.mode === m ? ' actif' : ''), onclick: () => { etat.mode = m; prefs.set('modeScan', m); majModes(); annulerAttente(); focusScan(); } }, icone(ic), label)); };
      majModes();
      const boutonSon = el('button', { type: 'button', class: 'btn btn-sm', title: 'Bips sonores' });
      const majSon = () => { ui.vider(boutonSon); boutonSon.append(icone('cloche'), sonsActifs() ? 'Sons activés' : 'Sons coupés'); boutonSon.classList.toggle('actif', sonsActifs()); };
      boutonSon.addEventListener('click', () => { prefs.set('sons', !sonsActifs()); majSon(); if (sonsActifs()) bip(true); focusScan(); });
      majSon();
      champScan.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); const code = champScan.value.trim(); champScan.value = ''; if (code) traiterCode(code); }
        else if (ev.key === 'Escape') { champScan.value = ''; annulerAttente(); }
      });
      const carteScan = ui.carte(null, frag(
        el('div', { class: 'inv-scan-outils' }, boutonsMode, el('span', { class: 'espace' }), boutonSon, ui.bouton('Caméra', { icone: 'camera', classe: 'btn-sm', onClic: () => ouvrirCamera((code) => { traiterCode(code); setTimeout(focusScan, 50); }) })),
        el('div', { class: 'inv-scan-champ' }, icone('codebarre'), champScan),
        el('div', { class: 'texte-2 texte-petit', style: { marginTop: '6px' } }, 'Douchette USB / Bluetooth : le champ reste actif, scannez simplement les étiquettes. Échap pour annuler une saisie.'),
        zoneCarte));
      const carteHisto = ui.carte('Derniers scans', listeHisto, { actions: [el('span', { class: 'texte-2 texte-petit' }, 'cette session')] });
      container.appendChild(el('div', { class: 'inv-comptage' }, carteScan, carteHisto));
      majHistorique();
      // Un scan reçu alors que le champ n'a pas le focus est traité ici (et non par le scan global)
      definirScanLocal(champScan, (code) => { traiterCode(code); focusScan(); });
    }

    // ----- Lignes -----
    const zoneSegments = el('div', { class: 'btn-groupe' });
    const zoneTable = el('div');
    container.appendChild(ui.carte('Lignes de l\'inventaire', frag(el('div', { class: 'barre-outils' }, zoneSegments), zoneTable)));
    let table = null;

    function lignesSegment() {
      const L = inv.lignes || [];
      switch (etat.segment) {
        case 'non_comptees': return L.filter((l) => l.quantiteComptee == null);
        case 'ecarts': return L.filter((l) => l.quantiteComptee != null && Number(l.ecart) !== 0);
        case 'hors': return L.filter((l) => l.horsPerimetre);
        case 'mouvements': return L.filter((l) => l.nbMouvementsDepuis > 0);
        default: return L;
      }
    }
    function majSegments() {
      ui.vider(zoneSegments);
      const L = inv.lignes || [];
      const segs = [['toutes', 'Toutes', L.length], ['non_comptees', 'Non comptées', L.filter((l) => l.quantiteComptee == null).length]];
      if (!masque) segs.push(['ecarts', 'Écarts', L.filter((l) => l.quantiteComptee != null && Number(l.ecart) !== 0).length]);
      segs.push(['hors', 'Hors périmètre', L.filter((l) => l.horsPerimetre).length]);
      const nbMv = L.filter((l) => l.nbMouvementsDepuis > 0).length;
      if (nbMv && enCours) segs.push(['mouvements', 'Mouvements depuis l\'ouverture', nbMv]);
      for (const [cleSeg, label, n] of segs) zoneSegments.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (etat.segment === cleSeg ? ' actif' : ''), dataset: { segment: cleSeg }, onclick: () => { etat.segment = cleSeg; prefs.set('segment', cleSeg); majSegments(); table.maj(lignesSegment()); } }, label, el('span', { class: 'badge', style: { marginLeft: '4px' } }, String(n))));
    }
    function colonnesLignes() {
      const valide = inv.statut === 'valide';
      const cols = [
        { cle: 'emplacement', label: 'Emplacement', rendu: (l) => l.emplacement || el('span', { class: 'texte-2' }, '—') },
        { cle: 'code', label: 'Code', rendu: (l) => el('span', { class: 'inv-cellule-code' }, l.code || '—') },
        { cle: 'designation', label: 'Désignation', rendu: (l) => frag(el('div', { class: 'cellule-principale' }, l.designation || '—'), l.horsPerimetre ? ui.badge('Hors périmètre', '#f59e0b') : null, !l.existe ? ui.badge('Article supprimé', '#dc2626') : null, l.misAZero ? ui.badge('Mis à zéro', '#6b7280') : null), exportValeur: (l) => l.designation },
        { cle: 'uniteCode', label: 'Unité', rendu: (l) => l.uniteLibelle || l.uniteCode || '' },
      ];
      if (!masque) cols.push({ cle: 'quantiteTheorique', label: 'Théorique', aligner: 'droite', rendu: (l) => qte(l.quantiteTheorique), valeurTri: (l) => Number(l.quantiteTheorique) || 0, exportValeur: (l) => l.quantiteTheorique });
      cols.push({ cle: 'quantiteComptee', label: 'Compté', aligner: 'droite', valeurTri: (l) => (l.quantiteComptee == null ? -1 : Number(l.quantiteComptee)), rendu: (l) => (l.quantiteComptee == null ? el('span', { class: 'texte-2' }, l.misAZero ? '0' : '—') : el('strong', null, qte(l.quantiteComptee))), exportValeur: (l) => (l.quantiteComptee == null ? '' : l.quantiteComptee) });
      if (!masque) {
        cols.push({ cle: 'ecart', label: 'Écart', aligner: 'droite', valeurTri: (l) => (l.ecart == null ? 0 : Number(l.ecart)), rendu: (l) => (l.ecart == null ? el('span', { class: 'texte-2' }, '—') : el('span', { class: classeEcart(l.ecart) }, signe(l.ecart))), exportValeur: (l) => (l.ecart == null ? '' : l.ecart) });
        cols.push({ cle: 'valeurEcart', label: 'Valeur', aligner: 'droite', valeurTri: (l) => (l.valeurEcart == null ? 0 : Number(l.valeurEcart)), rendu: (l) => (l.valeurEcart == null || Number(l.valeurEcart) === 0 ? el('span', { class: 'texte-2' }, l.valeurEcart == null ? '—' : ui.formatMontant(0)) : el('span', { class: classeEcart(l.valeurEcart) }, montantSigne(l.valeurEcart))), exportValeur: (l) => (l.valeurEcart == null ? '' : l.valeurEcart) });
      }
      if (valide && !masque) cols.push({ cle: 'ecartApplique', label: 'Écart appliqué', aligner: 'droite', valeurTri: (l) => Number(l.ecartApplique) || 0, rendu: (l) => (l.ecartApplique == null ? el('span', { class: 'texte-2' }, '—') : el('span', { class: classeEcart(l.ecartApplique), title: `Stock avant validation : ${qte(l.quantiteAvantValidation)}` }, signe(l.ecartApplique))) });
      cols.push({ cle: 'dernierComptage', label: 'Dernier comptage', valeurTri: (l) => l.dernierComptage || '', rendu: (l) => (l.dernierComptage ? frag(el('div', null, l.dernierCompteurNom || '—'), el('div', { class: 'cellule-secondaire', title: ui.formatDateHeure(l.dernierComptage) }, `${ui.relatif(l.dernierComptage)}${(l.comptages || []).length > 1 ? ` · ${(l.comptages || []).length} scans` : ''}`)) : el('span', { class: 'texte-2' }, '—')), exportValeur: (l) => (l.dernierComptage ? `${l.dernierCompteurNom} ${ui.formatDateHeure(l.dernierComptage)}` : '') });
      if (enCours) cols.push({ cle: 'nbMouvementsDepuis', label: 'Mvts', aligner: 'centre', valeurTri: (l) => l.nbMouvementsDepuis || 0, rendu: (l) => (l.nbMouvementsDepuis ? el('span', { class: 'inline texte-alerte', title: `${pluriel(l.nbMouvementsDepuis, 'mouvement')} de stock depuis l'ouverture${l.variationDepuis != null ? ` (variation ${signe(l.variationDepuis)}, stock actuel ${qte(l.quantiteActuelle)})` : ''}` }, iconeDim('alerte', 14), String(l.nbMouvementsDepuis)) : ''), exportValeur: (l) => l.nbMouvementsDepuis || 0 });
      return cols;
    }
    function construireTable() {
      table = ui.table({
        colonnes: colonnesLignes(), lignes: lignesSegment(), cleId: 'articleId', recherche: 'Filtrer les lignes (code, désignation, emplacement)…', compact: true,
        tailleParPage: 50, triInitial: { cle: 'emplacement', sens: 'asc' },
        exportCsv: d.exporter ? `${inv.numero}-lignes.csv` : null,
        vide: etat.segment === 'toutes' ? 'Aucune ligne' : 'Aucune ligne dans cette sélection',
        onClic: d.compter ? (l) => selectionnerLigne(l, 'remplacer') : null,
        ligneClasse: (l) => (etat.dernierArticle === l.articleId ? 'inv-flash' : '') + (!l.existe ? ' inactif' : ''),
        actions: d.compter ? [
          { icone: 'modifier', titre: 'Corriger la quantité comptée', onClic: (l) => selectionnerLigne(l, 'remplacer') },
          { icone: 'supprimer', titre: 'Annuler le comptage de cet article', visible: (l) => l.quantiteComptee != null, onClic: (l) => annulerComptage(l) },
        ] : null,
      });
      zoneTable.appendChild(table.el);
    }

    function majIndicateurs() {
      const r = inv.resume || {};
      ui.vider(zoneKpi);
      zoneKpi.append(
        ui.kpi({ label: 'Articles comptés', valeur: `${ui.formatNombre(r.nbComptees || 0)} / ${ui.formatNombre(r.nbLignes || 0)}`, icone: 'check', couleur: '#16a34a', detail: `${ui.formatNombre(r.progression || 0, 0)} % du périmètre` }),
        ui.kpi({ label: enCours ? 'Restant à compter' : 'Non comptés', valeur: ui.formatNombre(r.nbNonComptees || 0), icone: 'horloge', couleur: '#f59e0b', detail: enCours ? (r.nbHorsPerimetre ? `${pluriel(r.nbHorsPerimetre, 'article')} hors périmètre ajouté${r.nbHorsPerimetre > 1 ? 's' : ''}` : 'aucun article hors périmètre') : (inv.statut === 'valide' ? (inv.nonComptesAZero ? 'stock mis à zéro à la validation' : 'stock inchangé à la validation') : 'inventaire annulé'), onClic: () => { etat.segment = 'non_comptees'; majSegments(); table.maj(lignesSegment()); } }),
        masque
          ? el('div', { class: 'inv-kpi-masque' }, ui.kpi({ label: 'Écarts', valeur: 'Comptage à l\'aveugle', icone: 'voir', couleur: '#8b5cf6', detail: 'visibles par les valideurs uniquement' }))
          : ui.kpi({ label: 'Articles en écart', valeur: ui.formatNombre(r.nbEcarts || 0), icone: 'alerte', couleur: (r.nbEcarts || 0) ? '#dc2626' : '#16a34a', detail: `${ui.formatNombre(r.nbEcartsPositifs || 0)} en plus · ${ui.formatNombre(r.nbEcartsNegatifs || 0)} en moins`, onClic: () => { etat.segment = 'ecarts'; majSegments(); table.maj(lignesSegment()); } }),
        masque
          ? ui.kpi({ label: 'Hors périmètre', valeur: ui.formatNombre(r.nbHorsPerimetre || 0), icone: 'info', couleur: '#0891b2', detail: 'articles trouvés hors de la liste' })
          : ui.kpi({ label: 'Valeur des écarts', valeur: montantSigne(r.valeurEcart || 0), icone: 'euro', couleur: (r.valeurEcart || 0) < 0 ? '#dc2626' : '#2563eb', detail: `valeur théorique ${ui.formatMontant(r.valeurTheorique || 0)}` }));
      ui.vider(zoneProgression);
      zoneProgression.append(barreProgression(r.progression), el('span', null, `${ui.formatNombre(r.progression || 0, 0)} % compté`));
      ui.vider(zoneAlerteMvts);
      const nbMv = (inv.lignes || []).filter((l) => l.nbMouvementsDepuis > 0).length;
      if (enCours && nbMv) {
        zoneAlerteMvts.appendChild(ui.alerte(frag(el('strong', null, `Des mouvements de stock ont eu lieu depuis l'ouverture sur ${pluriel(nbMv, 'article')}. `), 'La validation fixe le stock à la quantité comptée : vérifiez que ces comptages tiennent compte des entrées et sorties effectuées pendant l\'inventaire. ', el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); etat.segment = 'mouvements'; majSegments(); table.maj(lignesSegment()); } }, 'Voir les articles concernés')), 'alerte'));
      }
    }

    function majTout() { majIndicateurs(); majSegments(); if (table) table.maj(lignesSegment()); }
    majIndicateurs();
    majSegments();
    construireTable();

    // ----- Logique de comptage -----
    function focusScan() { if (champScan && champScan.isConnected && !document.querySelector('.modal-fond')) champScan.focus(); }
    function trouverLocal(code) {
      const k = cle(code);
      for (const champ of ['code', 'referenceFournisseur', 'codeBarre']) {
        const l = (inv.lignes || []).find((x) => x[champ] && cle(x[champ]) === k);
        if (l) return l;
      }
      return null;
    }
    function remplacerLigne(l) {
      const i = (inv.lignes || []).findIndex((x) => x.articleId === l.articleId);
      if (i >= 0) inv.lignes[i] = l; else inv.lignes.push(l);
      etat.dernierArticle = l.articleId;
    }
    function ajouterHisto(type, texteHtml, detail) {
      etat.historique.unshift({ type, texte: texteHtml, detail, date: new Date() });
      etat.historique = etat.historique.slice(0, 40);
      majHistorique();
    }
    function majHistorique() {
      if (!listeHisto) return;
      ui.vider(listeHisto);
      if (!etat.historique.length) { listeHisto.appendChild(el('li', { class: 'texte-2' }, 'Aucun scan pour l\'instant. Scannez la première étiquette.')); return; }
      for (const h of etat.historique.slice(0, 15)) {
        listeHisto.appendChild(el('li', { class: h.type }, el('span', { class: 'h-icone' }, icone(h.type === 'ok' ? 'check' : (h.type === 'erreur' ? 'fermer' : 'info'))),
          el('div', { class: 'h-texte' }, el('div', { class: 'texte-gras' }, h.texte), h.detail ? el('div', { class: 'texte-2 texte-petit' }, h.detail) : null),
          el('span', { class: 'h-heure' }, ui.formatHeure(h.date))));
      }
    }
    function annulerAttente() { etat.enAttente = null; if (zoneCarte && zoneCarte.querySelector('.attente')) ui.vider(zoneCarte); }

    function carteLigne(l, opts = {}) {
      const u = l.uniteLibelle || unite(l.uniteCode) || '';
      const classe = opts.erreur ? 'erreur' : (opts.saisie ? (l.horsPerimetre ? 'horsp' : 'attente') : 'ok');
      const carte = el('div', { class: 'inv-carte-article ' + classe });
      carte.appendChild(el('div', { class: 'inv-art-titre' }, l.designation || l.code, l.horsPerimetre ? ui.badge(opts.nouvelle ? 'Hors périmètre : sera ajouté' : 'Hors périmètre', '#f59e0b') : null));
      carte.appendChild(el('div', { class: 'inv-art-sous' }, [l.code, l.emplacement, u].filter(Boolean).join(' · ')));
      const chiffres = el('div', { class: 'inv-chiffres' });
      if (!masque && l.quantiteTheorique !== undefined) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v' }, qte(l.quantiteTheorique, l.uniteCode)), el('div', { class: 'l' }, 'Théorique')));
      chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v' }, l.quantiteComptee == null ? '—' : qte(l.quantiteComptee, l.uniteCode)), el('div', { class: 'l' }, opts.saisie ? 'Déjà compté' : 'Compté')));
      if (!masque && l.ecart != null && !opts.saisie) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v ' + classeEcart(l.ecart) }, signe(l.ecart)), el('div', { class: 'l' }, 'Écart')));
      if (l.dernierComptage) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px', fontWeight: '600' } }, l.dernierCompteurNom || '—'), el('div', { class: 'l' }, `Dernier comptage ${ui.relatif(l.dernierComptage)}`)));
      if (l.nbMouvementsDepuis) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v texte-alerte' }, String(l.nbMouvementsDepuis)), el('div', { class: 'l' }, 'Mouvements depuis l\'ouverture')));
      carte.appendChild(chiffres);
      return carte;
    }

    function afficherSaisie(l, { nouvelle = false, modeDefaut } = {}) {
      etat.enAttente = { ligne: l, nouvelle };
      ui.vider(zoneCarte);
      const carte = carteLigne(l, { saisie: true, nouvelle });
      const dejaCompte = l.quantiteComptee != null;
      let mode = modeDefaut || (dejaCompte ? 'ajouter' : 'remplacer');
      const champQte = el('input', { type: 'text', inputmode: 'decimal', class: 'inv-qte', id: 'inv-quantite', autocomplete: 'off', placeholder: '0', 'aria-label': 'Quantité comptée' });
      const total = el('div', { class: 'inv-total' });
      const groupeMode = el('div', { class: 'btn-groupe' });
      const majMode = () => {
        ui.vider(groupeMode);
        if (dejaCompte) for (const [m, label] of [['ajouter', 'Ajouter au comptage'], ['remplacer', 'Remplacer']]) groupeMode.appendChild(el('button', { type: 'button', class: 'btn btn-sm' + (mode === m ? ' actif' : ''), onclick: () => { mode = m; majMode(); majTotal(); champQte.focus(); } }, label));
      };
      const lireQte = () => { const s = champQte.value.trim().replace(',', '.'); if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return null; return Number(s); };
      const majTotal = () => {
        const q = lireQte();
        ui.vider(total);
        if (q == null) { total.appendChild(document.createTextNode(champQte.value.trim() ? 'Saisissez une quantité (nombre positif).' : 'Saisissez la quantité trouvée puis Entrée.')); return; }
        const res = mode === 'ajouter' && dejaCompte ? Number(l.quantiteComptee) + q : q;
        total.append('Quantité comptée après validation : ', el('strong', null, qte(res, l.uniteCode)));
      };
      champQte.addEventListener('input', majTotal);
      const valider = async () => {
        const brut = champQte.value.trim();
        const q = /^\d{7,}$/.test(brut) ? null : lireQte();
        if (q == null) {
          // Un code scanné par erreur dans le champ quantité : nouveau scan, sans compter l'article en attente
          if (brut && (/[a-z]/i.test(brut) || /^\d{7,}$/.test(brut))) { toast(`Quantité non saisie pour ${l.code} : nouveau scan pris en compte`, 'alerte'); etat.enAttente = null; traiterCode(brut); return; }
          bip(false); champQte.select(); return;
        }
        await enregistrer({ articleId: l.articleId, quantite: q, mode: dejaCompte ? mode : 'remplacer' }, l);
      };
      champQte.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); valider(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); annulerAttente(); focusScan(); }
      });
      majMode();
      majTotal();
      carte.appendChild(el('div', { class: 'inv-saisie' }, champQte, groupeMode, ui.bouton('Valider', { icone: 'check', classe: 'btn-primaire', onClic: valider }), ui.bouton('Annuler', { onClic: () => { annulerAttente(); focusScan(); } })));
      carte.appendChild(total);
      zoneCarte.appendChild(carte);
      champQte.focus();
      setTimeout(() => { if (champQte.isConnected && document.activeElement !== champQte && etat.enAttente && etat.enAttente.ligne === l) champQte.focus(); }, 0);
    }

    async function enregistrer(body, ligneAvant) {
      try {
        const r = await api.post(`/api/inventaires/${inv.id}/comptage`, body);
        remplacerLigne(r.ligne);
        inv.resume = r.resume;
        etat.enAttente = null;
        bip(true);
        ui.vider(zoneCarte);
        zoneCarte.appendChild(carteLigne(r.ligne, {}));
        const ajout = body.mode === 'ajouter';
        const quantiteTexte = qte(r.ligne.quantiteComptee, r.ligne.uniteCode);
        ajouterHisto('ok', `${r.ligne.code} — ${r.ligne.designation}`, `${ajout ? `+${ui.formatNombre(body.quantite == null ? 1 : body.quantite)} → ${quantiteTexte}` : (r.quantitePrecedente != null ? `corrigé : ${qte(r.quantitePrecedente)} → ${quantiteTexte}` : `compté : ${quantiteTexte}`)}${r.nouvelle ? ' · ajouté hors périmètre' : ''}`);
        if (r.nouvelle) toast(`${r.ligne.code} ajouté à l'inventaire (hors périmètre)`, 'alerte');
        majTout();
      } catch (e) {
        bip(false);
        ajouterHisto('erreur', ligneAvant ? `${ligneAvant.code} — ${ligneAvant.designation}` : (body.code || 'Scan'), e.message);
        if (!ligneAvant) { ui.vider(zoneCarte); zoneCarte.appendChild(el('div', { class: 'inv-carte-article erreur' }, el('div', { class: 'inv-art-titre' }, iconeDim('alerte', 20, 'var(--danger)'), 'Scan refusé'), el('div', { class: 'inv-art-sous' }, e.message))); } else erreur(e);
      } finally { focusScan(); }
    }

    async function traiterCode(code) {
      if (!enCours || !d.compter) return;
      if (etat.mode === 'unitaire') { await enregistrer({ code, mode: 'ajouter', quantite: 1 }, null); return; }
      const local = trouverLocal(code);
      if (local) { afficherSaisie(local); return; }
      try {
        const r = await api.get(`/api/inventaires/${inv.id}/resoudre`, { code });
        if (r.nouvelle) bip(true);
        afficherSaisie(r.ligne, { nouvelle: r.nouvelle });
      } catch (e) {
        bip(false);
        ajouterHisto('erreur', code, e.message);
        ui.vider(zoneCarte);
        zoneCarte.appendChild(el('div', { class: 'inv-carte-article erreur' }, el('div', { class: 'inv-art-titre' }, iconeDim('alerte', 20, 'var(--danger)'), `Code « ${code} » non reconnu`), el('div', { class: 'inv-art-sous' }, e.message)));
        focusScan();
      }
    }
    function selectionnerLigne(l, mode) {
      if (!d.compter) return;
      afficherSaisie(l, { modeDefaut: l.quantiteComptee != null ? mode : 'remplacer' });
      zoneCarte.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    async function annulerComptage(l) {
      const ok = await ui.confirm({ titre: 'Annuler le comptage', message: `Annuler le comptage de ${l.code} — ${l.designation}${l.horsPerimetre ? ' (la ligne hors périmètre sera retirée)' : ''} ?`, okLabel: 'Annuler le comptage', danger: true });
      if (!ok) { focusScan(); return; }
      try {
        const r = await api.del(`/api/inventaires/${inv.id}/lignes/${l.articleId}/comptage`);
        if (r.supprimee) inv.lignes = inv.lignes.filter((x) => x.articleId !== l.articleId); else remplacerLigne(r.ligne);
        inv.resume = r.resume;
        ajouterHisto('info', `${l.code} — ${l.designation}`, r.supprimee ? 'ligne hors périmètre retirée' : 'comptage annulé');
        toast('Comptage annulé', 'succes');
        majTout();
      } catch (e) { erreur(e); } finally { focusScan(); }
    }

    // Le champ de scan reste actif : clic dans le vide → retour au champ
    if (champScan) {
      const surClic = (ev) => {
        if (!champScan.isConnected) { document.removeEventListener('click', surClic, true); return; }
        if (document.querySelector('.modal-fond')) return;
        const t = ev.target;
        if (t.closest && t.closest('input, select, textarea, button, a, label, [contenteditable], .tableau-composant')) return;
        if (window.getSelection && String(window.getSelection())) return;
        setTimeout(() => { if (!document.activeElement || !CB() || !CB().estChampSaisie(document.activeElement)) focusScan(); }, 0);
      };
      document.addEventListener('click', surClic, true);
      setTimeout(focusScan, 60);
    }
  }

  async function modifierInventaire(inv, apres) {
    ui.formModal({
      titre: `Modifier ${inv.numero}`, taille: 'petite',
      champs: [
        { nom: 'nom', label: 'Nom de l\'inventaire', type: 'texte', requis: true },
        { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 3 },
        inv.droits && inv.droits.modifierAveugle ? { nom: 'aveugle', label: 'Comptage à l\'aveugle', type: 'interrupteur' } : null,
      ],
      valeurs: { nom: inv.nom, commentaire: inv.commentaire || '', aveugle: !!inv.aveugle },
      onSubmit: async (v) => {
        const body = { nom: v.nom, commentaire: v.commentaire || '' };
        if (inv.droits && inv.droits.modifierAveugle) body.aveugle = !!v.aveugle;
        await api.put('/api/inventaires/' + inv.id, body);
        toast('Inventaire modifié', 'succes');
        apres();
      },
    });
  }

  async function annulerInventaire(inv, apres) {
    const motif = await ui.prompt({ titre: `Annuler l'inventaire ${inv.numero}`, message: 'Les comptages sont conservés pour consultation, mais aucun mouvement de stock ne sera enregistré.', label: 'Motif de l\'annulation', type: 'texte', requis: false, okLabel: 'Annuler l\'inventaire' });
    if (motif === null) return;
    try {
      await api.post(`/api/inventaires/${inv.id}/annuler`, { motif: motif || '' });
      toast(`Inventaire ${inv.numero} annulé`, 'succes');
      apres();
    } catch (e) { erreur(e); }
  }

  async function supprimerInventaire(inv) {
    const ok = await ui.confirm({ titre: 'Supprimer l\'inventaire', message: `Supprimer définitivement l'inventaire ${inv.numero} — ${inv.nom} et ses ${pluriel((inv.lignes || []).length, 'ligne')} ? Aucun mouvement de stock n'est concerné.`, okLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try {
      await api.del('/api/inventaires/' + inv.id);
      toast(`Inventaire ${inv.numero} supprimé`, 'succes');
      GMAO.navigate('#/inventaire?onglet=inventaires');
    } catch (e) { erreur(e); }
  }

  /** Récapitulatif des écarts et confirmation de la validation. */
  function ouvrirValidation(inv, apres) {
    const L = inv.lignes || [];
    const comptees = L.filter((l) => l.quantiteComptee != null);
    const nonComptees = L.filter((l) => l.quantiteComptee == null && l.existe !== false);
    const ecarts = comptees.filter((l) => Number(l.ecart) !== 0).sort((a, b) => Math.abs(Number(b.valeurEcart) || 0) - Math.abs(Number(a.valeurEcart) || 0));
    const valeurComptes = comptees.reduce((s, l) => s + (Number(l.valeurEcart) || 0), 0);
    const valeurZero = nonComptees.reduce((s, l) => s - Math.max(0, Number(l.quantiteTheorique) || 0) * (Number(l.prixUnitaire) || 0), 0);
    const nbMv = L.filter((l) => l.nbMouvementsDepuis > 0).length;
    let zero = !!((inv.config || {}).nonComptesAZero);
    const chiffres = el('div', { class: 'inv-recap-chiffres' });
    const caseZero = el('input', { type: 'checkbox', id: 'inv-zero', checked: zero, disabled: !nonComptees.length });
    const majChiffres = () => {
      ui.vider(chiffres);
      const total = valeurComptes + (zero ? valeurZero : 0);
      const nbMvts = comptees.length + (zero ? nonComptees.length : 0);
      chiffres.append(
        el('div', null, el('div', { class: 'v' }, `${ui.formatNombre(comptees.length)} / ${ui.formatNombre(L.length)}`), el('div', { class: 'l' }, 'Articles comptés')),
        el('div', null, el('div', { class: 'v' }, ui.formatNombre(ecarts.length + (zero ? nonComptees.filter((l) => Number(l.quantiteTheorique) > 0).length : 0))), el('div', { class: 'l' }, 'Articles en écart')),
        el('div', null, el('div', { class: 'v ' + classeEcart(total) }, montantSigne(Math.round(total * 100) / 100)), el('div', { class: 'l' }, 'Valeur des écarts')),
        el('div', null, el('div', { class: 'v' }, ui.formatNombre(nbMvts)), el('div', { class: 'l' }, 'Mouvements de stock')));
    };
    caseZero.addEventListener('change', () => { zero = caseZero.checked; majChiffres(); });
    majChiffres();
    const tableEcarts = ecarts.length ? el('div', { class: 'tableau-conteneur', style: { maxHeight: '300px', overflowY: 'auto' } }, el('table', { class: 'tableau tableau-compact' },
      el('thead', null, el('tr', null, el('th', null, 'Code'), el('th', null, 'Désignation'), el('th', { class: 'num' }, 'Théorique'), el('th', { class: 'num' }, 'Compté'), el('th', { class: 'num' }, 'Écart'), el('th', { class: 'num' }, 'Valeur'))),
      el('tbody', null, ecarts.map((l) => el('tr', null, el('td', { class: 'inv-cellule-code' }, l.code), el('td', null, l.designation, l.nbMouvementsDepuis ? el('span', { title: 'Mouvements de stock depuis l\'ouverture', style: { marginLeft: '6px' } }, iconeDim('alerte', 13, 'var(--alerte)')) : null), el('td', { class: 'num' }, qte(l.quantiteTheorique)), el('td', { class: 'num' }, qte(l.quantiteComptee)), el('td', { class: 'num ' + classeEcart(l.ecart) }, signe(l.ecart)), el('td', { class: 'num ' + classeEcart(l.valeurEcart) }, montantSigne(l.valeurEcart)))))))
      : ui.alerte('Aucun écart sur les articles comptés : le stock correspond aux quantités théoriques.', 'ok');
    ui.modal({
      titre: `Valider l'inventaire ${inv.numero}`, taille: 'large',
      contenu: frag(
        chiffres,
        nbMv ? ui.alerte(`${pluriel(nbMv, 'article')} ${nbMv > 1 ? 'ont' : 'a'} eu des mouvements de stock depuis l'ouverture : la validation fixera leur stock à la quantité comptée.`, 'alerte') : null,
        el('h3', { class: 'mt' }, `Écarts constatés (${ecarts.length})`),
        tableEcarts,
        el('div', { class: 'mt' }, el('label', { class: 'inline', for: 'inv-zero', style: { cursor: nonComptees.length ? 'pointer' : 'default' } }, caseZero,
          nonComptees.length ? `Mettre à zéro les ${pluriel(nonComptees.length, 'article non compté', 'articles non comptés')} (écart ${montantSigne(Math.round(valeurZero * 100) / 100)})` : 'Tous les articles ont été comptés')),
        el('p', { class: 'texte-2 texte-petit mt' }, 'La validation enregistre un mouvement d\'inventaire pour chaque article retenu : le stock est fixé à la quantité comptée. Cette opération est définitive.')),
      boutons: [
        { label: 'Retour au comptage' },
        { label: 'Valider l\'inventaire', icone: 'check', classe: 'btn-ok', onClic: async () => {
          const r = await api.post(`/api/inventaires/${inv.id}/valider`, { nonComptesAZero: zero });
          toast(`Inventaire ${r.numero} validé : ${pluriel((r.mouvementIds || []).length, 'mouvement')} de stock enregistré${(r.mouvementIds || []).length > 1 ? 's' : ''}`, 'succes');
          apres();
        } },
      ],
    });
  }

  /** Feuille de comptage imprimable (avec codes-barres) ; quantités théoriques omises en mode aveugle. */
  function imprimerFeuille(inv) {
    const avecTheo = !inv.aveugle && !inv.masque;
    const cbHtml = (code, h, x) => { try { return CB() ? CB().svg(code, { hauteur: h, largeurModule: x, unite: 'mm', texteVisible: false, fond: 'none' }) : ''; } catch (e) { return ''; } };
    const lignes = (inv.lignes || []).slice().sort((a, b) => String(a.emplacement || '').localeCompare(String(b.emplacement || ''), 'fr', { numeric: true }) || String(a.code).localeCompare(String(b.code), 'fr', { numeric: true }));
    const r = inv.resume || {};
    const html = `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px">
      <dl><dt>Inventaire</dt><dd><strong>${esc(inv.numero)}</strong> — ${esc(inv.nom)}</dd><dt>Site / magasin</dt><dd>${esc(inv.secteurId != null ? ui.cheminSecteur(inv.secteurId) || inv.secteurNom : 'Tous les sites')}</dd>
      <dt>Périmètre</dt><dd>${esc((inv.filtresLibelles || []).join(', ') || 'Tout le magasin')}</dd><dt>Ouvert le</dt><dd>${esc(ui.formatDateHeure(inv.dateOuverture))} par ${esc(inv.createdByNom || '')}</dd>
      <dt>Articles</dt><dd>${r.nbLignes || 0} (${r.nbComptees || 0} déjà comptés)${inv.aveugle ? ' — comptage à l\'aveugle' : ''}</dd></dl>
      <div style="text-align:center">${cbHtml(inv.numero, 10, 0.33)}<div style="font-family:Consolas,monospace;font-size:11px">${esc(inv.numero)}</div></div></div>
      <h2>Lignes à compter</h2>
      <table><thead><tr><th>Emplacement</th><th>Code</th><th>Désignation</th><th>Unité</th>${avecTheo ? '<th style="text-align:right">Théorique</th>' : ''}<th style="width:22mm">Compté</th><th style="width:40mm">Observations</th></tr></thead><tbody>
      ${lignes.map((l) => `<tr style="page-break-inside:avoid"><td>${esc(l.emplacement || '')}</td><td style="white-space:nowrap">${cbHtml(l.code, 6, 0.25)}<div style="font-family:Consolas,monospace;font-size:11px">${esc(l.code)}</div></td><td>${esc(l.designation || '')}${l.horsPerimetre ? ' <span class="badge">hors périmètre</span>' : ''}</td><td>${esc(l.uniteLibelle || l.uniteCode || '')}</td>${avecTheo ? `<td style="text-align:right">${esc(qte(l.quantiteTheorique))}</td>` : ''}<td>${l.quantiteComptee != null ? `<span style="color:#666;font-size:10px">déjà : ${esc(qte(l.quantiteComptee))}</span>` : ''}</td><td></td></tr>`).join('')}
      </tbody></table>
      <div class="signature"><div>Compté par (nom, date, signature)</div><div>Contrôlé par (nom, date, signature)</div></div>`;
    ui.imprimer(`Feuille de comptage ${inv.numero}`, html);
  }

  // =====================================================================================
  //  Onglet « Scanner » (consultation rapide)
  // =====================================================================================
  const etatScanner = { historique: [] };
  function rendreScanner() {
    const racine = el('div');
    const champ = el('input', { type: 'text', id: 'inv-scanner', autocomplete: 'off', spellcheck: 'false', placeholder: 'Scannez ou saisissez un code…', 'aria-label': 'Code à consulter' });
    const zone = el('div');
    const histo = el('ul', { class: 'inv-historique' });
    racine.appendChild(el('p', { class: 'inv-intro' }, 'Consultation rapide : scannez une étiquette pour afficher l\'article (stock, emplacement) ou l\'équipement, et agir sans changer d\'écran.'));
    racine.appendChild(el('div', { class: 'inv-scanner-grille' },
      ui.carte(null, frag(
        el('div', { class: 'inv-scan-outils' }, el('span', { class: 'texte-2 texte-petit' }, 'Article, équipement, OT, demande ou inventaire — douchette, clavier ou caméra'), el('span', { class: 'espace' }), ui.bouton('Caméra', { icone: 'camera', classe: 'btn-sm', onClic: () => ouvrirCamera((c) => consulter(c)) })),
        el('div', { class: 'inv-scan-champ' }, icone('codebarre'), champ), zone)),
      ui.carte('Consultations récentes', histo)));
    champ.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const c = champ.value.trim(); champ.value = ''; if (c) consulter(c); } });
    definirScanLocal(champ, (c) => { consulter(c); champ.focus(); });
    majHisto();
    setTimeout(() => champ.focus(), 60);

    function majHisto() {
      ui.vider(histo);
      if (!etatScanner.historique.length) { histo.appendChild(el('li', { class: 'texte-2' }, 'Aucune consultation.')); return; }
      for (const h of etatScanner.historique.slice(0, 12)) {
        histo.appendChild(el('li', { class: h.ok ? 'ok' : 'erreur', style: { cursor: h.ok ? 'pointer' : 'default' }, onclick: h.ok ? () => consulter(h.code) : null },
          el('span', { class: 'h-icone' }, icone(h.ok ? 'check' : 'fermer')),
          el('div', { class: 'h-texte' }, el('div', { class: 'texte-gras' }, h.code), el('div', { class: 'texte-2 texte-petit' }, h.libelle)),
          el('span', { class: 'h-heure' }, ui.formatHeure(h.date))));
      }
    }
    async function consulter(code, actualisation) {
      ui.vider(zone);
      zone.appendChild(ui.chargement('Recherche…'));
      try {
        const r = await api.get('/api/codes/' + encodeURIComponent(code));
        if (!actualisation) { bip(true); etatScanner.historique.unshift({ code, ok: true, libelle: r.libelle, date: new Date() }); }
        ui.vider(zone);
        zone.appendChild(carteResultat(r, () => consulter(code, true)));
      } catch (e) {
        bip(false);
        etatScanner.historique.unshift({ code, ok: false, libelle: e.message, date: new Date() });
        ui.vider(zone);
        zone.appendChild(el('div', { class: 'inv-carte-article erreur' }, el('div', { class: 'inv-art-titre' }, iconeDim('alerte', 20, 'var(--danger)'), `Code « ${code} » non reconnu`), el('div', { class: 'inv-art-sous' }, e.status === 404 ? 'Aucun article, équipement, OT, demande ou inventaire accessible ne correspond à ce code.' : e.message)));
      }
      etatScanner.historique = etatScanner.historique.slice(0, 30);
      majHisto();
      if (champ.isConnected && !document.querySelector('.modal-fond')) champ.focus();
    }
    return racine;
  }

  function carteResultat(r, rafraichir) {
    const x = r.details || {};
    const carte = el('div', { class: 'inv-carte-article ok' });
    const titres = { article: 'Article', equipement: 'Équipement', ot: 'Ordre de travail', demande: 'Demande d\'intervention', inventaire: 'Inventaire' };
    const icones = { article: 'stock', equipement: 'equipements', ot: 'ot', demande: 'demandes', inventaire: 'codebarre' };
    carte.appendChild(el('div', { class: 'texte-2 texte-petit inline', style: { textTransform: 'uppercase', letterSpacing: '.5px' } }, iconeDim(icones[r.type] || 'info', 14), titres[r.type] || r.type));
    carte.appendChild(el('div', { class: 'inv-art-titre', style: { marginTop: '4px' } }, r.libelle || r.code));
    carte.appendChild(el('div', { class: 'inv-art-sous' }, r.sousTitre || r.code));
    const chiffres = el('div', { class: 'inv-chiffres' });
    const actions = el('div', { class: 'inv-resultat-actions' }, ui.bouton('Ouvrir la fiche', { icone: 'voir', classe: 'btn-primaire', onClic: () => GMAO.navigate(r.lien) }));
    const chiffre = (v, l, classe) => chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v' + (classe ? ' ' + classe : '') }, v), el('div', { class: 'l' }, l)));
    if (r.type === 'article') {
      chiffre(qte(x.quantite, x.unite), 'En stock', x.quantite <= 0 ? 'texte-danger' : (x.sousSeuil ? 'texte-alerte' : 'texte-ok'));
      chiffre(qte(x.seuilMin, x.unite), 'Seuil minimum');
      chiffre(ui.formatMontant(x.prixUnitaire), 'Prix unitaire');
      if (x.categorieCode) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px' } }, ui.badgeListe('categoriesArticles', x.categorieCode)), el('div', { class: 'l' }, 'Catégorie')));
      carte.appendChild(chiffres);
      carte.appendChild(ui.details([
        { label: 'Emplacement', valeur: x.emplacement },
        { label: 'Référence fournisseur', valeur: [x.referenceFournisseur, x.fournisseurNom].filter(Boolean).join(' · ') },
        x.sousSeuil ? { label: 'Alerte', valeur: el('span', { class: 'texte-alerte texte-gras' }, 'Stock sous le seuil minimum') } : null,
        !x.actif ? { label: 'Statut', valeur: el('span', { class: 'texte-danger' }, 'Article désactivé') } : null,
        (x.inventairesEnCours || []).length ? { label: 'Inventaire en cours', valeur: frag(...x.inventairesEnCours.map((i, k) => frag(k ? ', ' : '', lienVue('#/inventaire/' + i.id, `${i.numero} — ${i.nom}`)))) } : null,
      ].filter(Boolean)));
      if (GMAO.can('stock', 'modifier') && !GMAO.siteLectureSeule(x.secteurId) && x.actif) {
        actions.append(ui.bouton('Entrée', { icone: 'import', classe: 'btn-ok', onClic: () => mouvementRapide(r, 'entree', rafraichir) }), ui.bouton('Sortie', { icone: 'export', classe: 'btn-alerte', onClic: () => mouvementRapide(r, 'sortie', rafraichir) }));
      }
      actions.appendChild(ui.bouton('Imprimer l\'étiquette', { icone: 'imprimer', onClic: () => imprimerUne('articles', r.id) }));
    } else if (r.type === 'equipement') {
      chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px' } }, ui.badgeListe('etatsEquipement', x.etatCode)), el('div', { class: 'l' }, 'État')));
      if (x.criticiteCode) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px' } }, ui.badgeListe('criticites', x.criticiteCode)), el('div', { class: 'l' }, 'Criticité')));
      carte.appendChild(chiffres);
      carte.appendChild(ui.details([
        { label: 'Secteur', valeur: x.secteurChemin || ui.cheminSecteur(x.secteurId) },
        { label: 'Localisation', valeur: x.localisation },
        { label: 'Marque / modèle', valeur: [x.marque, x.modele].filter(Boolean).join(' ') },
        { label: 'N° de série', valeur: x.numeroSerie },
      ]));
      if (GMAO.can('demandes', 'creer') && !GMAO.siteLectureSeule(x.secteurId)) actions.appendChild(ui.bouton('Nouvelle demande', { icone: 'demandes', onClic: () => GMAO.navigate(`#/demandes?nouveau=1&equipementId=${r.id}`) }));
      actions.appendChild(ui.bouton('Imprimer l\'étiquette', { icone: 'imprimer', onClic: () => imprimerUne('equipements', r.id) }));
    } else {
      const liste = r.type === 'ot' ? 'statutsOT' : (r.type === 'demande' ? 'statutsDemande' : null);
      chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px' } }, liste ? ui.badgeListe(liste, x.statut) : badgeStatut(x.statut)), el('div', { class: 'l' }, 'Statut')));
      if (x.prioriteCode) chiffres.appendChild(el('div', { class: 'inv-chiffre' }, el('div', { class: 'v', style: { fontSize: '14px' } }, ui.badgeListe('priorites', x.prioriteCode)), el('div', { class: 'l' }, 'Priorité')));
      if (r.type === 'inventaire') chiffre(`${ui.formatNombre(x.progression || 0, 0)} %`, 'Compté');
      carte.appendChild(chiffres);
    }
    carte.appendChild(actions);
    return carte;
  }

  async function imprimerUne(source, id) {
    try {
      const r = await api.get('/api/etiquettes/donnees', { source, ids: String(id) });
      if (!r.lignes.length) { toast('Élément introuvable', 'erreur'); return; }
      const c = cfgEt();
      const f = format(c.format, c.formatPersonnalise);
      imprimerEtiquettes([{ it: r.lignes[0], n: 1 }], f, { contenu: c.contenu, hauteurCodeMm: c.hauteurCodeMm, decalage: f.rouleau ? 0 : c.decalage, contour: prefs.get('contour', false), societe: ((GMAO.config || {}).societe || {}).nom || '' });
    } catch (e) { erreur(e); }
  }

  function mouvementRapide(r, type, apres) {
    const x = r.details || {};
    const u = x.unite || '';
    ui.formModal({
      titre: `${type === 'entree' ? 'Entrée en stock' : 'Sortie de stock'} — ${r.code}`, taille: 'petite', submitLabel: type === 'entree' ? 'Enregistrer l\'entrée' : 'Enregistrer la sortie',
      avant: el('p', { class: 'texte-2' }, `${r.libelle} · stock actuel ${qte(x.quantite, u)}`),
      champs: [
        { nom: 'quantite', label: `Quantité${u ? ' (' + u + ')' : ''}`, type: 'nombre', requis: true, min: 0.001, step: 'any', valeur: 1 },
        type === 'entree' ? { nom: 'prixUnitaire', label: `Prix unitaire (${((GMAO.config || {}).general || {}).devise || '€'}, facultatif)`, type: 'nombre', min: 0, step: '0.01' } : null,
        { nom: 'motif', label: 'Motif', type: 'texte', placeholder: type === 'entree' ? 'ex. Réception commande' : 'ex. Dépannage convoyeur', pleineLargeur: true },
      ],
      colonnes: 1,
      onSubmit: async (v) => {
        const body = { type, quantite: v.quantite, motif: v.motif || '' };
        if (type === 'entree' && v.prixUnitaire != null && v.prixUnitaire !== '') body.prixUnitaire = v.prixUnitaire;
        const res = await api.post(`/api/articles/${r.id}/mouvements`, body);
        toast(`${type === 'entree' ? 'Entrée' : 'Sortie'} enregistrée : stock ${qte(res.article.quantite, u)}`, 'succes');
        apres();
      },
    });
  }

  // =====================================================================================
  //  Onglet « Paramètres »
  // =====================================================================================
  function rendreParametres() {
    const racine = el('div');
    const ci = cfgInv();
    const ce = cfgEt();
    const aide = (texte) => ({ type: 'html', rendu: () => el('div', { class: 'inv-aide' }, texte) });
    const fInv = ui.form({ colonnes: 1, champs: [
      { nom: 'aveugle', label: 'Comptage à l\'aveugle par défaut', type: 'interrupteur', valeur: !!ci.aveugle },
      aide('Les compteurs ne voient ni les quantités théoriques ni les écarts. Seuls les utilisateurs ayant le droit « valider » peuvent alors ouvrir un inventaire non aveugle.'),
      { nom: 'modeScan', label: 'Mode de scan par défaut', type: 'radio', valeur: ci.modeScan === 'unitaire' ? 'unitaire' : 'quantite', options: [{ value: 'quantite', label: 'Saisir la quantité après chaque scan' }, { value: 'unitaire', label: '+1 à chaque scan' }], aide: 'Chaque poste peut changer de mode sur l\'écran de comptage (choix mémorisé sur le poste).' },
      { nom: 'sons', label: 'Bips sonores (succès / erreur)', type: 'interrupteur', valeur: ci.sons !== false },
      { nom: 'nonComptesAZero', label: 'Mettre à zéro les articles non comptés à la validation (option cochée par défaut)', type: 'interrupteur', valeur: !!ci.nonComptesAZero },
      { nom: 'scanGlobal', label: 'Scan global depuis n\'importe quel écran', type: 'interrupteur', valeur: ci.scanGlobal !== false },
      aide('Un code scanné hors champ de saisie ouvre la fiche correspondante. Douchettes USB ou Bluetooth configurées en émulation clavier, suffixe « Entrée ».'),
    ] });
    const fEt = ui.form({ colonnes: 2, champs: [
      { nom: 'format', label: 'Format par défaut', type: 'select', options: FORMATS.map((f) => ({ value: f.code, label: f.label })), valeur: FORMATS.some((f) => f.code === ce.format) ? ce.format : 'a4-3x7', pleineLargeur: true },
      { nom: 'hauteurCodeMm', label: 'Hauteur du code-barres (mm)', type: 'nombre', min: 4, max: 40, step: 0.5, valeur: ce.hauteurCodeMm },
      { nom: 'decalage', label: 'Étiquettes déjà utilisées (planche entamée)', type: 'nombre', min: 0, max: 64, step: 1, valeur: ce.decalage },
      { nom: 'symbologie', label: 'Symbologie', type: 'lecture', valeur: 'Code 128 (jeux B et C, contrôle modulo 103)' },
      { type: 'separateur', label: 'Contenu par défaut' },
      ...Object.keys(CONTENU_DEFAUT).map((k) => ({ nom: 'contenu.' + k, label: { codeBarre: 'Code-barres', code: 'Code en clair', designation: 'Désignation', emplacement: 'Emplacement / localisation', referenceFournisseur: 'Référence fournisseur / n° de série', unite: 'Unité', categorie: 'Catégorie / type', societe: 'Nom de la société', prix: 'Prix unitaire', secteur: 'Secteur / magasin' }[k], type: 'booleen', valeur: !!ce.contenu[k], sansDecalage: true })),
      { type: 'separateur', label: 'Format personnalisé (dimensions en mm)' },
      ...Object.keys(PERSO_DEFAUT).map((k) => ({ nom: 'perso.' + k, label: { largeurMm: 'Largeur de l\'étiquette', hauteurMm: 'Hauteur de l\'étiquette', colonnes: 'Colonnes', lignes: 'Lignes', margeHautMm: 'Marge haute', margeGaucheMm: 'Marge gauche', espaceHorizontalMm: 'Espace horizontal', espaceVerticalMm: 'Espace vertical', pageLargeurMm: 'Largeur de la page', pageHauteurMm: 'Hauteur de la page' }[k], type: 'nombre', min: 0, step: k === 'colonnes' || k === 'lignes' ? 1 : 0.1, valeur: ce.formatPersonnalise[k] })),
    ] });
    async function enregistrer() {
      if (!fInv.valider() || !fEt.valider()) return;
      const vi = fInv.valeurs();
      const ve = fEt.valeurs();
      const contenu = {}; const perso = {};
      for (const k of Object.keys(CONTENU_DEFAUT)) contenu[k] = !!ve['contenu.' + k];
      for (const k of Object.keys(PERSO_DEFAUT)) perso[k] = Number(ve['perso.' + k]) || 0;
      const pb = controleFormat(format('personnalise', perso));
      if (pb && ve.format === 'personnalise') { toast('Format personnalisé : ' + pb, 'erreur'); return; }
      try {
        const res = await api.put('/api/configuration', {
          inventaire: { aveugle: !!vi.aveugle, modeScan: vi.modeScan === 'unitaire' ? 'unitaire' : 'quantite', sons: !!vi.sons, nonComptesAZero: !!vi.nonComptesAZero, scanGlobal: !!vi.scanGlobal },
          etiquettes: { format: ve.format, hauteurCodeMm: Number(ve.hauteurCodeMm) || 12, decalage: Math.max(0, Math.round(Number(ve.decalage) || 0)), contenu, formatPersonnalise: perso },
        });
        if (res && res.inventaire) GMAO.config.inventaire = res.inventaire;
        if (res && res.etiquettes) GMAO.config.etiquettes = res.etiquettes;
        etatEt.options = null;
        toast('Paramètres d\'étiquettes et d\'inventaire enregistrés', 'succes');
      } catch (e) { erreur(e); }
    }
    // Test de la douchette : diagnostic du clavier (AZERTY / QWERTY)
    const resultatTest = el('div', { class: 'mt' });
    const champTest = el('input', { type: 'text', placeholder: 'Cliquez ici puis scannez une étiquette…', autocomplete: 'off' });
    champTest.addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = champTest.value; champTest.value = '';
      ui.vider(resultatTest);
      if (!v) return;
      const azerty = /[&é"'(èçà]/.test(v) && !/\d/.test(v);
      resultatTest.appendChild(ui.alerte(frag(el('div', null, 'Code reçu : ', el('strong', { style: { fontFamily: 'Consolas, monospace' } }, v)),
        azerty ? el('div', null, 'Les chiffres semblent remplacés par « & é " \' ( - è _ ç à » : configurez la douchette en clavier français (AZERTY) ou activez son mode « verrouillage majuscules ».') : null), azerty ? 'alerte' : 'ok'));
      try { const r = await api.get('/api/codes/' + encodeURIComponent(v)); resultatTest.appendChild(el('div', { class: 'texte-petit texte-ok' }, `Reconnu : ${r.libelle} (${r.type})`)); bip(true); } catch (e) { resultatTest.appendChild(el('div', { class: 'texte-petit texte-2' }, 'Aucun élément accessible ne correspond à ce code (la lecture fonctionne).')); bip(false); }
    });
    racine.appendChild(el('div', { class: 'inv-param-grille' },
      el('div', null,
        ui.carte('Inventaire et scan', fInv.el),
        ui.carte('Tester la douchette et les sons', frag(
          el('div', { class: 'inv-test-douchette' }, 'Vérifiez que la douchette envoie bien le code suivi de « Entrée » et que les caractères sont corrects.', champTest, resultatTest),
          el('div', { class: 'barre-outils mt', style: { marginBottom: 0 } }, ui.bouton('Bip de succès', { icone: 'check', classe: 'btn-sm', onClic: () => { if (CB()) CB().bip(true); } }), ui.bouton('Bip d\'erreur', { icone: 'alerte', classe: 'btn-sm', onClic: () => { if (CB()) CB().bip(false); } }))))),
      ui.carte('Étiquettes par défaut', fEt.el)));
    racine.appendChild(el('div', { class: 'barre-outils' }, el('span', { class: 'espace' }), ui.bouton('Enregistrer les paramètres', { icone: 'sauvegarde', classe: 'btn-primaire', onClic: enregistrer })));
    return racine;
  }

  // =====================================================================================
  //  Accueil (onglets)
  // =====================================================================================
  function afficherAccueil(container, query) {
    const items = [];
    if (sourcesDisponibles().length) items.push({ cle: 'etiquettes', label: 'Étiquettes', icone: 'imprimer', rendu: () => rendreEtiquettes(query) });
    items.push({ cle: 'inventaires', label: 'Inventaires', icone: 'liste', rendu: () => rendreInventaires() });
    items.push({ cle: 'scanner', label: 'Scanner', icone: 'codebarre', rendu: () => rendreScanner() });
    if (GMAO.can('configuration', 'modifier')) items.push({ cle: 'parametres', label: 'Paramètres', icone: 'engrenage', rendu: () => rendreParametres() });
    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'codebarre',
      sousTitre: 'Étiquettes code-barres des pièces et des équipements, scan à la douchette et inventaires du magasin',
      actions: [can('creer') ? ui.bouton('Nouvel inventaire', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirNouvelInventaire().catch(erreur) }) : null],
    }));
    if (!CB()) container.appendChild(ui.alerte('La bibliothèque de codes-barres n\'est pas chargée : rechargez la page.', 'alerte'));
    container.appendChild(ui.onglets(items, { hash: true }).el);
  }

  GMAO.registerView(MODULE, {
    titre: 'Étiquettes & inventaire', icone: 'codebarre',
    async rendu(container, { params, query }) {
      injecterStyles();
      scanLocal = null;
      if (params[0]) {
        const id = Number(params[0]);
        if (!Number.isInteger(id) || id <= 0) { container.appendChild(ui.vide('Inventaire introuvable', 'alerte')); return; }
        await afficherInventaire(container, id);
        return;
      }
      afficherAccueil(container, query || {});
    },
  });
})();
