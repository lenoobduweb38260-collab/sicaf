/**
 * Bibliothèque de composants d'interface (vanilla JS, zéro dépendance).
 *
 * Principaux composants :
 *   ui.el(tag, attrs, ...enfants)        création d'éléments DOM
 *   ui.table({...})                        tableau triable, filtrable, paginé, groupable
 *   ui.form({...}) / ui.formModal({...})   formulaires déclaratifs (+ champs personnalisés)
 *   ui.modal / ui.confirm / ui.prompt / ui.toast
 *   ui.onglets / ui.arbre / ui.kpi / ui.details / ui.pageEntete / ui.badge
 *   ui.formatDate / ui.formatDateHeure / ui.formatNombre / ui.formatMontant / ui.formatDuree
 *   ui.optionsListe / ui.optionsUsers / ui.optionsSecteurs / ui.optionsProfils
 *   ui.exportCsv / ui.imprimer / ui.telecharger
 */
(function () {
  'use strict';

  // ----- Icônes (SVG inline, trait 2px, 24x24) ----------------------------
  const ICONES = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    equipements: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    demandes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/>',
    ot: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    preventif: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/>',
    planning: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    stock: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
    fournisseurs: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    rapports: '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>',
    utilisateurs: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    profils: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    configuration: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    audit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    modifier: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    supprimer: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"/>',
    voir: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    fermer: '<path d="M18 6L6 18M6 6l12 12"/>',
    recherche: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    imprimer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    cloche: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    deconnexion: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    cle: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    soleil: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    lune: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alerte: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    horloge: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    fleche_droite: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    fleche_gauche: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    chevron_bas: '<path d="M6 9l6 6 6-6"/>',
    chevron_droite: '<path d="M9 18l6-6-6-6"/>',
    dossier: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    copier: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    utilisateur: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    secteur: '<path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/>',
    sauvegarde: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    liste: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    filtre: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    rafraichir: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    organigramme: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v4M5 17v-3h14v3M12 11v3"/>',
    piece: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    euro: '<path d="M4 10h12M4 14h9M19 6a7 7 0 0 0-11 1 7 7 0 0 0 0 10 7 7 0 0 0 11 1"/>',
    piece_jointe: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    commentaire: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    lecture: '<path d="M5 3l14 9-14 9V3z"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    glisser: '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>',
    haut: '<path d="M18 15l-6-6-6 6"/>',
    bas: '<path d="M6 9l6 6 6-6"/>',
    serveur: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    codebarre: '<path d="M3 5v14M6 5v14M8 5v14M11 5v14M14 5v14M16 5v14M19 5v14M21 5v14"/>',
    plan3d: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
    site: '<path d="M2 21h20M4 21V10l6-4v15M10 21V4l10 5v12M14 9v.01M14 13v.01M14 17v.01M17 11v.01M17 15v.01M7 13v.01M7 17v.01"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
    achats: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    facture: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .67V2l-1 .67L16 2l-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    rh: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    diplome: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89L17 22l-5-3-5 3 1.52-9.11"/>',
    calendrier: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    engrenage: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };

  function icone(nom, classe) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (classe) svg.setAttribute('class', classe);
    svg.innerHTML = ICONES[nom] || ICONES.info;
    return svg;
  }

  // ----- Utilitaires DOM --------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach((c) => append(parent, c)); return; }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  /**
   * ui.el('div', { class: 'carte', onclick: fn, style: { color: 'red' }, dataset: { id: 3 }, html: '<b>..</b>' }, 'texte', autreElement)
   */
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class' || k === 'className') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly' || k === 'multiple' || k === 'required') e[k] = !!v;
        else if (k === 'value') e.value = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    } else if (attrs !== undefined) {
      children.unshift(attrs);
    }
    children.forEach((c) => append(e, c));
    return e;
  }

  function frag(...children) { const f = document.createDocumentFragment(); children.forEach((c) => append(f, c)); return f; }
  function vider(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms || 250); }; }

  // ----- Formats ----------------------------------------------------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function formatDate(v) {
    const d = parseDate(v);
    if (!d) return '';
    const fmt = ((window.GMAO && GMAO.config && GMAO.config.general) || {}).formatDate || 'dd/MM/yyyy';
    return fmt.replace('dd', pad(d.getDate())).replace('MM', pad(d.getMonth() + 1)).replace('yyyy', d.getFullYear());
  }
  function formatHeure(v) { const d = parseDate(v); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
  function formatDateHeure(v) { const d = parseDate(v); return d ? `${formatDate(d)} ${formatHeure(d)}` : ''; }
  function dateISO(v) { const d = parseDate(v === undefined ? new Date() : v); return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''; }
  function dateHeureLocale(v) { const d = parseDate(v === undefined ? new Date() : v); return d ? `${dateISO(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
  function aujourdhui() { return dateISO(new Date()); }
  function formatNombre(n, dec) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: dec === undefined ? 0 : dec, maximumFractionDigits: dec === undefined ? 2 : dec });
  }
  function formatMontant(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '';
    const dev = ((window.GMAO && GMAO.config && GMAO.config.general) || {}).devise || '€';
    return formatNombre(n, 2) + ' ' + dev;
  }
  function formatDuree(h) {
    if (h === null || h === undefined || h === '' || isNaN(Number(h))) return '';
    const total = Math.round(Number(h) * 60);
    const hh = Math.floor(total / 60); const mm = total % 60;
    return mm ? `${hh} h ${pad(mm)}` : `${hh} h`;
  }
  function relatif(v) {
    const d = parseDate(v); if (!d) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    const abs = Math.abs(diff); const futur = diff < 0;
    const f = (n, u) => (futur ? `dans ${n} ${u}` : `il y a ${n} ${u}`);
    if (abs < 60) return futur ? 'dans un instant' : 'à l\'instant';
    if (abs < 3600) return f(Math.round(abs / 60), 'min');
    if (abs < 86400) return f(Math.round(abs / 3600), 'h');
    if (abs < 86400 * 30) return f(Math.round(abs / 86400), 'j');
    return formatDate(d);
  }
  function joursEntre(a, b) { const da = parseDate(a), db = parseDate(b); if (!da || !db) return null; return Math.round((db - da) / 86400000); }
  function initiales(nom) { return String(nom || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?'; }

  // ----- Références (config, listes, utilisateurs, secteurs) --------------
  const G = () => window.GMAO || {};
  function liste(nom) { return (G().liste ? G().liste(nom) : []) || []; }
  function itemListe(nom, code) { return liste(nom).find((x) => x.code === code) || null; }
  function libelle(nom, code) { const it = itemListe(nom, code); return it ? it.label : (code == null ? '' : String(code)); }
  function couleur(nom, code) { const it = itemListe(nom, code); return (it && it.couleur) || '#6b7280'; }
  function refs() { return (G().refs) || { users: [], secteurs: [], profils: [] }; }
  function user(id) { return refs().users.find((u) => u.id === Number(id)) || null; }
  function nomUser(id) { const u = user(id); return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : (id == null ? '' : '#' + id); }
  function secteur(id) { return refs().secteurs.find((s) => s.id === Number(id)) || null; }
  function nomSecteur(id) { const s = secteur(id); return s ? s.nom : (id == null ? '' : '#' + id); }
  function cheminSecteur(id) {
    const parts = []; let cur = secteur(id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? secteur(cur.parentId) : null; }
    return parts.join(' › ');
  }
  function profil(id) { return refs().profils.find((p) => p.id === Number(id)) || null; }
  function nomProfil(id) { const p = profil(id); return p ? p.nom : ''; }

  function optionsListe(nom, opts = {}) {
    const out = liste(nom).map((x) => ({ value: x.code, label: x.label, couleur: x.couleur }));
    if (opts.vide !== false) out.unshift({ value: '', label: opts.vide || '— Choisir —' });
    return out;
  }
  /** Identifiants des secteurs du site choisi dans l'en-tête (null = tous les sites). */
  function secteursDuSiteCourant() {
    const g = G();
    const siteId = g.siteCourant ? g.siteCourant() : null;
    if (siteId == null) return null;
    const all = refs().secteurs;
    const out = new Set([siteId]);
    let change = true;
    while (change) { change = false; for (const s of all) if (s.parentId != null && out.has(Number(s.parentId)) && !out.has(s.id)) { out.add(s.id); change = true; } }
    return out;
  }
  function optionsUsers(opts = {}) {
    let us = refs().users.filter((u) => opts.inactifs ? true : u.actif !== false);
    const duSite = opts.tousSites ? null : secteursDuSiteCourant();
    if (duSite) us = us.filter((u) => !(u.secteurIds || []).length || u.secteurIds.some((s) => duSite.has(Number(s))) || (u.siteAcces || []).some((a) => duSite.has(Number(a.siteId))));
    if (opts.filtre) us = us.filter(opts.filtre);
    const out = us.sort((a, b) => nomUser(a.id).localeCompare(nomUser(b.id))).map((u) => ({ value: u.id, label: nomUser(u.id) + (u.fonction ? ` (${u.fonction})` : '') }));
    if (opts.vide !== false) out.unshift({ value: '', label: opts.vide || '— Aucun —' });
    return out;
  }
  function optionsSecteurs(opts = {}) {
    const duSite = opts.tousSites ? null : secteursDuSiteCourant();
    const all = refs().secteurs.filter((s) => (opts.inactifs ? true : s.actif !== false) && (!duSite || duSite.has(s.id)));
    if (opts.typeSite) return all.filter((s) => s.type === 'site').map((s) => ({ value: s.id, label: s.nom, couleur: s.couleur }));
    const out = [];
    const walk = (parentId, niveau) => {
      all.filter((s) => (s.parentId == null ? null : s.parentId) === parentId).sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || a.nom.localeCompare(b.nom)).forEach((s) => {
        out.push({ value: s.id, label: (niveau ? '  '.repeat(niveau) + '└ ' : '') + s.nom, couleur: s.couleur });
        walk(s.id, niveau + 1);
      });
    };
    walk(null, 0);
    // racines du sous-arbre (site courant) et secteurs orphelins (parent supprimé ou hors site)
    all.filter((s) => s.parentId != null && !all.some((p) => p.id === s.parentId) && !out.some((o) => o.value === s.id)).forEach((s) => { out.push({ value: s.id, label: s.nom, couleur: s.couleur }); walk(s.id, 1); });
    if (opts.vide !== false) out.unshift({ value: '', label: opts.vide || '— Aucun —' });
    return out;
  }
  function optionsProfils(opts = {}) {
    const out = refs().profils.filter((p) => opts.inactifs ? true : p.actif !== false).sort((a, b) => (a.niveau || 99) - (b.niveau || 99)).map((p) => ({ value: p.id, label: `${p.nom} (niveau ${p.niveau})` }));
    if (opts.vide) out.unshift({ value: '', label: opts.vide });
    return out;
  }

  // ----- Badges -------------------------------------------------------------
  function badge(label, coul, opts = {}) {
    const b = el('span', { class: 'badge' + (coul ? ' couleur' : '') + (opts.contour ? ' contour' : '') + (opts.classe ? ' ' + opts.classe : ''), title: opts.titre }, label);
    if (coul) { if (opts.contour) { b.style.color = coul; b.style.background = 'transparent'; } else b.style.background = coul; }
    return b;
  }
  function badgeListe(nom, code, opts) {
    if (code == null || code === '') return el('span', { class: 'texte-2' }, '—');
    return badge(libelle(nom, code), couleur(nom, code), opts);
  }
  function pastille(coul) { return el('span', { class: 'pastille', style: { background: coul || '#6b7280' } }); }

  // ----- Toasts -------------------------------------------------------------
  function toast(message, type = 'info', duree) {
    const cont = document.getElementById('toasts');
    if (!cont) return;
    const t = el('div', { class: 'toast ' + type }, icone(type === 'succes' ? 'check' : type === 'erreur' ? 'alerte' : type === 'alerte' ? 'alerte' : 'info'), el('span', null, message), el('button', { onclick: () => t.remove(), title: 'Fermer' }, '×'));
    cont.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, duree || (type === 'erreur' ? 7000 : 3500));
    return t;
  }
  function erreur(e) { toast((e && e.message) || String(e), 'erreur'); if (window.console) console.error(e); }

  // ----- Modales ------------------------------------------------------------
  const modales = [];
  function modal({ titre, contenu, boutons, taille, onFermer, fermable = true, classe } = {}) {
    const corps = el('div', { class: 'modal-corps' });
    append(corps, typeof contenu === 'function' ? contenu() : contenu);
    const pied = el('div', { class: 'modal-pied' });
    const boite = el('div', { class: 'modal' + (taille ? ' ' + taille : '') + (classe ? ' ' + classe : ''), role: 'dialog', 'aria-modal': 'true' });
    const fond = el('div', { class: 'modal-fond' }, boite);
    const api = {
      el: fond, boite, corps, pied, fermable,
      fermer(resultat) {
        if (!fond.parentNode) return;
        fond.remove();
        const i = modales.indexOf(api); if (i >= 0) modales.splice(i, 1);
        if (onFermer) onFermer(resultat);
      },
      setTitre(t) { titreEl.textContent = t; },
      setBoutons(bs) { vider(pied); construireBoutons(bs); },
    };
    const titreEl = el('h2', null, titre || '');
    const entete = el('div', { class: 'modal-entete' }, titreEl, fermable ? el('button', { class: 'btn btn-icone', title: 'Fermer', onclick: () => api.fermer() }, icone('fermer')) : null);
    boite.appendChild(entete);
    boite.appendChild(corps);
    function construireBoutons(bs) {
      (bs || []).forEach((b) => {
        if (!b) return;
        const btn = el('button', { class: 'btn ' + (b.classe || '') + (b.gauche ? ' a-gauche' : ''), type: 'button', disabled: b.disabled }, b.icone ? icone(b.icone) : null, b.label);
        btn.addEventListener('click', async () => {
          if (b.onClic) {
            btn.disabled = true;
            try { const r = await b.onClic(api, btn); if (r !== false && b.fermer !== false) api.fermer(r); } catch (e) { erreur(e); } finally { btn.disabled = false; }
          } else api.fermer(b.valeur);
        });
        pied.appendChild(btn);
      });
      if (pied.children.length) boite.appendChild(pied); else pied.remove();
    }
    construireBoutons(boutons);
    if (fermable) {
      fond.addEventListener('mousedown', (ev) => { if (ev.target === fond) api._fermerSurFond = true; else api._fermerSurFond = false; });
      fond.addEventListener('mouseup', (ev) => { if (ev.target === fond && api._fermerSurFond) api.fermer(); });
    }
    document.body.appendChild(fond);
    modales.push(api);
    const focusable = corps.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, button');
    if (focusable) setTimeout(() => focusable.focus(), 30);
    return api;
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modales.length) { const m = modales[modales.length - 1]; if (m.boite.querySelector('.modal-entete .btn-icone')) m.fermer(); }
  });
  /** Ferme toutes les modales ouvertes (changement de vue). */
  function fermerModales() { modales.slice().forEach((m) => { if (m.fermable !== false) m.fermer(); }); }

  function confirm({ titre = 'Confirmation', message, okLabel = 'Confirmer', annulerLabel = 'Annuler', danger = false } = {}) {
    return new Promise((resolve) => {
      let repondu = false;
      modal({
        titre, taille: 'petite', contenu: el('p', null, message),
        onFermer: () => { if (!repondu) resolve(false); },
        boutons: [
          { label: annulerLabel, onClic: () => { repondu = true; resolve(false); } },
          { label: okLabel, classe: danger ? 'btn-danger' : 'btn-primaire', onClic: () => { repondu = true; resolve(true); } },
        ],
      });
    });
  }

  function prompt({ titre = 'Saisie', message, label, valeur = '', type = 'texte', okLabel = 'Valider', requis = true, options } = {}) {
    return new Promise((resolve) => {
      let repondu = false;
      const f = form({ champs: [{ nom: 'v', label: label || message, type, valeur, requis, options, pleineLargeur: true }], colonnes: 1 });
      const m = modal({
        titre, taille: 'petite', contenu: frag(message && label ? el('p', null, message) : null, f.el),
        onFermer: () => { if (!repondu) resolve(null); },
        boutons: [
          { label: 'Annuler', onClic: () => { repondu = true; resolve(null); } },
          { label: okLabel, classe: 'btn-primaire', onClic: () => { if (!f.valider()) return false; repondu = true; resolve(f.valeurs().v); } },
        ],
      });
      f.el.addEventListener('submit', (ev) => { ev.preventDefault(); if (f.valider()) { repondu = true; resolve(f.valeurs().v); m.fermer(); } });
    });
  }

  // ----- Formulaires --------------------------------------------------------
  function optionsNormalisees(opts, def) {
    let o = typeof opts === 'function' ? opts() : opts;
    if (!o && def.liste) o = optionsListe(def.liste, { vide: def.vide });
    if (!o) o = [];
    return o.map((x) => (typeof x === 'object' && x !== null ? x : { value: x, label: String(x) }));
  }

  /**
   * Définition d'un champ : { nom, label, type, requis, valeur, placeholder, aide, options|liste, pleineLargeur,
   *   disabled, min, max, step, onChange(valeur, form), rendu(form) [type html], afficherSi(valeurs), lignes }
   * Types : texte, texte_long, nombre, date, datetime, heure, select, multiselect, cases, radio, booleen, interrupteur,
   *         couleur, mdp, email, tel, fichier, image, lecture, separateur, html, cache
   */
  function form({ champs = [], valeurs = {}, colonnes = 2, classe } = {}) {
    const formEl = el('form', { class: 'formulaire colonnes-' + colonnes + (classe ? ' ' + classe : ''), novalidate: true, autocomplete: 'off' });
    const controles = {};
    const defs = champs.filter(Boolean);
    const api = {
      el: formEl, defs, controles,
      get(nom) { const c = controles[nom]; return c ? c.get() : undefined; },
      set(nom, v) { const c = controles[nom]; if (c) c.set(v); },
      champ(nom) { return controles[nom] ? controles[nom].wrap : null; },
      valeurs() { const out = {}; for (const [k, c] of Object.entries(controles)) if (c.def.type !== 'separateur' && c.def.type !== 'html' && c.def.type !== 'lecture') out[k] = c.get(); return out; },
      erreur(nom, msg) { const c = controles[nom]; if (!c) return; c.wrap.classList.toggle('invalide', !!msg); c.err.textContent = msg || ''; },
      valider() {
        let ok = true; let premier = null;
        for (const c of Object.values(controles)) {
          if (c.wrap.classList.contains('masque')) { api.erreur(c.def.nom, ''); continue; }
          const v = c.get();
          let msg = '';
          if (c.def.requis && (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length))) msg = 'Champ obligatoire';
          else if (c.def.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) msg = 'Adresse e-mail invalide';
          else if (c.def.type === 'nombre' && v !== '' && v !== null && isNaN(Number(v))) msg = 'Nombre invalide';
          else if (c.def.type === 'nombre' && v !== '' && v !== null && c.def.min !== undefined && Number(v) < Number(c.def.min)) msg = `Minimum : ${c.def.min}`;
          else if (c.def.type === 'nombre' && v !== '' && v !== null && c.def.max !== undefined && Number(v) > Number(c.def.max)) msg = `Maximum : ${c.def.max}`;
          else if (c.def.valider) msg = c.def.valider(v, api.valeurs()) || '';
          api.erreur(c.def.nom, msg);
          if (msg) { ok = false; if (!premier) premier = c; }
        }
        if (premier && premier.input && premier.input.focus) premier.input.focus();
        return ok;
      },
      rafraichirVisibilite() {
        const vals = api.valeurs();
        for (const c of Object.values(controles)) if (c.def.afficherSi) c.wrap.classList.toggle('masque', !c.def.afficherSi(vals, api));
      },
      majOptions(nom, options) { const c = controles[nom]; if (c && c.majOptions) c.majOptions(options); },
    };

    for (const def of defs) {
      const type = def.type || 'texte';
      const nomChamp = def.nom || ('champ_' + Object.keys(controles).length);
      let valeur = valeurs[nomChamp] !== undefined ? valeurs[nomChamp] : (def.valeur !== undefined ? def.valeur : (type === 'multiselect' || type === 'cases' ? [] : (type === 'booleen' || type === 'interrupteur' ? false : '')));
      const wrap = el('div', { class: 'champ' + (def.pleineLargeur || type === 'texte_long' || type === 'separateur' || type === 'html' ? ' pleine-largeur' : '') + (def.classe ? ' ' + def.classe : '') });
      const err = el('div', { class: 'erreur-champ' });
      const ctrl = { def: Object.assign({ nom: nomChamp, type }, def), wrap, err, input: null };
      const labelEl = def.label !== undefined && type !== 'separateur' && type !== 'html' && type !== 'cache' ? el('label', { for: 'f_' + nomChamp }, def.label, def.requis ? el('span', { class: 'requis' }, '*') : null) : null;
      const notifier = () => { if (def.onChange) def.onChange(ctrl.get(), api); api.rafraichirVisibilite(); };

      if (type === 'separateur') {
        wrap.className = 'formulaire-separateur';
        wrap.textContent = def.label || '';
        ctrl.get = () => undefined; ctrl.set = () => {};
      } else if (type === 'html') {
        wrap.className = 'champ pleine-largeur' + (def.classe ? ' ' + def.classe : '');
        if (def.label) wrap.appendChild(el('div', { class: 'label' }, def.label));
        append(wrap, typeof def.rendu === 'function' ? def.rendu(api) : def.rendu);
        ctrl.get = () => undefined; ctrl.set = () => {};
      } else if (type === 'cache') {
        wrap.classList.add('masque');
        let v = valeur; ctrl.get = () => v; ctrl.set = (x) => { v = x; };
      } else if (type === 'lecture') {
        const span = el('div', { class: 'champ-lecture' });
        append(span, valeur);
        wrap.appendChild(labelEl); wrap.appendChild(span);
        ctrl.get = () => valeur; ctrl.set = (v) => { valeur = v; vider(span); append(span, v); };
      } else if (type === 'booleen' || type === 'interrupteur') {
        wrap.classList.add('champ-case');
        if (def.sansDecalage || colonnes === 1) wrap.classList.add('sans-decalage');
        if (type === 'interrupteur') {
          const sw = el('div', { class: 'interrupteur' + (valeur ? ' actif' : ''), role: 'switch', tabindex: 0 });
          let v = !!valeur;
          const bascule = () => { if (def.disabled) return; v = !v; sw.classList.toggle('actif', v); notifier(); };
          sw.addEventListener('click', bascule);
          sw.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); bascule(); } });
          const lbl = el('label', { onclick: bascule }, def.label || '');
          wrap.appendChild(sw); wrap.appendChild(lbl);
          ctrl.input = sw; ctrl.get = () => v; ctrl.set = (x) => { v = !!x; sw.classList.toggle('actif', v); };
        } else {
          const input = el('input', { type: 'checkbox', id: 'f_' + nomChamp, checked: !!valeur, disabled: def.disabled });
          input.addEventListener('change', notifier);
          wrap.appendChild(input); wrap.appendChild(el('label', { for: 'f_' + nomChamp }, def.label || ''));
          ctrl.input = input; ctrl.get = () => input.checked; ctrl.set = (x) => { input.checked = !!x; };
        }
      } else if (type === 'select') {
        const sel = el('select', { id: 'f_' + nomChamp, disabled: def.disabled });
        const originaux = new Map(); // valeur affichée (chaîne) -> valeur d'origine (nombre, etc.)
        const remplir = (opts) => {
          vider(sel); originaux.clear();
          for (const o of optionsNormalisees(opts, def)) {
            const s = o.value == null ? '' : String(o.value);
            originaux.set(s, o.value == null ? '' : o.value);
            sel.appendChild(el('option', { value: s, disabled: o.disabled }, o.label));
          }
        };
        remplir(def.options);
        sel.value = valeur == null ? '' : String(valeur);
        if (sel.value !== String(valeur == null ? '' : valeur) && valeur != null && valeur !== '') { originaux.set(String(valeur), valeur); sel.appendChild(el('option', { value: String(valeur) }, String(valeur))); sel.value = String(valeur); }
        sel.addEventListener('change', notifier);
        wrap.appendChild(labelEl); wrap.appendChild(sel);
        ctrl.input = sel;
        ctrl.get = () => { const v = sel.value; if (v === '') return def.vide === undefined ? '' : def.vide; return originaux.has(v) ? originaux.get(v) : v; };
        ctrl.set = (v) => { sel.value = v == null ? '' : String(v); };
        ctrl.majOptions = (opts) => { const cur = sel.value; remplir(opts); sel.value = cur; };
      } else if (type === 'multiselect' || type === 'cases') {
        const cont = el('div', { class: 'cases-liste' });
        const inputs = [];
        const remplir = (opts) => {
          vider(cont); inputs.length = 0;
          for (const o of optionsNormalisees(opts, def)) {
            if (o.value === '' || o.value == null) continue;
            const input = el('input', { type: 'checkbox', value: o.value, checked: (valeur || []).map(String).includes(String(o.value)), disabled: def.disabled });
            input.addEventListener('change', notifier);
            inputs.push({ input, o });
            cont.appendChild(el('label', null, input, o.couleur ? pastille(o.couleur) : null, o.label));
          }
        };
        remplir(def.options);
        wrap.appendChild(labelEl); wrap.appendChild(cont);
        ctrl.input = cont;
        ctrl.get = () => inputs.filter((x) => x.input.checked).map((x) => x.o.value);
        ctrl.set = (v) => { const arr = (v || []).map(String); inputs.forEach((x) => { x.input.checked = arr.includes(String(x.o.value)); }); };
        ctrl.majOptions = (opts) => { valeur = ctrl.get(); remplir(opts); };
      } else if (type === 'radio') {
        const cont = el('div', { class: 'cases-liste' });
        const inputs = [];
        for (const o of optionsNormalisees(def.options, def)) {
          if (o.value === '' || o.value == null) continue;
          const input = el('input', { type: 'radio', name: 'r_' + nomChamp, value: o.value, checked: String(valeur) === String(o.value), disabled: def.disabled });
          input.addEventListener('change', notifier);
          inputs.push({ input, o });
          cont.appendChild(el('label', null, input, o.couleur ? pastille(o.couleur) : null, o.label));
        }
        wrap.appendChild(labelEl); wrap.appendChild(cont);
        ctrl.input = cont;
        ctrl.get = () => { const x = inputs.find((i) => i.input.checked); return x ? x.o.value : ''; };
        ctrl.set = (v) => inputs.forEach((x) => { x.input.checked = String(x.o.value) === String(v); });
      } else if (type === 'fichier' || type === 'image') {
        const input = el('input', { type: 'file', id: 'f_' + nomChamp, accept: def.accept || (type === 'image' ? 'image/*' : undefined), disabled: def.disabled });
        const apercu = el('div', { class: 'champ-fichier' });
        let data = valeur || null;
        const majApercu = () => {
          vider(apercu);
          if (data && typeof data === 'object' && data.contenu) {
            if (type === 'image' || /^data:image/.test(data.contenu)) apercu.appendChild(el('img', { src: data.contenu, alt: data.nom || '' }));
            apercu.appendChild(el('div', { class: 'texte-petit texte-2' }, data.nom || 'fichier', ' ', el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: () => { data = null; input.value = ''; majApercu(); notifier(); } }, 'Retirer')));
          } else if (typeof data === 'string' && data) {
            if (/^data:image/.test(data)) apercu.appendChild(el('img', { src: data }));
            apercu.appendChild(el('button', { type: 'button', class: 'btn btn-lien btn-sm', onclick: () => { data = null; input.value = ''; majApercu(); notifier(); } }, 'Retirer'));
          }
        };
        input.addEventListener('change', async () => {
          const f = input.files && input.files[0];
          if (!f) return;
          if (def.tailleMax && f.size > def.tailleMax) { toast(`Fichier trop volumineux (max ${Math.round(def.tailleMax / 1024)} Ko)`, 'erreur'); input.value = ''; return; }
          const contenu = await lireFichier(f);
          data = def.simple ? contenu : { nom: f.name, type: f.type, taille: f.size, contenu };
          majApercu(); notifier();
        });
        majApercu();
        wrap.appendChild(labelEl); wrap.appendChild(input); wrap.appendChild(apercu);
        ctrl.input = input; ctrl.get = () => data; ctrl.set = (v) => { data = v; majApercu(); };
      } else {
        const typesHtml = { texte: 'text', nombre: 'number', date: 'date', datetime: 'datetime-local', heure: 'time', couleur: 'color', mdp: 'password', email: 'email', tel: 'tel', url: 'url' };
        let input;
        if (type === 'texte_long') {
          input = el('textarea', { id: 'f_' + nomChamp, placeholder: def.placeholder, disabled: def.disabled, readOnly: def.lectureSeule, rows: def.lignes || 3 });
          input.value = valeur == null ? '' : valeur;
        } else {
          input = el('input', { type: typesHtml[type] || 'text', id: 'f_' + nomChamp, placeholder: def.placeholder, disabled: def.disabled, readOnly: def.lectureSeule, min: def.min, max: def.max, step: def.step || (type === 'nombre' ? 'any' : undefined), maxlength: def.maxLength, list: def.suggestions ? 'dl_' + nomChamp : undefined });
          if (type === 'datetime' && valeur) valeur = dateHeureLocale(valeur);
          if (type === 'date' && valeur) valeur = dateISO(valeur);
          input.value = valeur == null ? '' : valeur;
          if (type === 'couleur' && !valeur) input.value = '#6b7280';
          if (def.suggestions) wrap.appendChild(el('datalist', { id: 'dl_' + nomChamp }, def.suggestions.map((s) => el('option', { value: s }))));
        }
        input.addEventListener('change', notifier);
        if (def.onInput) input.addEventListener('input', () => def.onInput(input.value, api));
        wrap.appendChild(labelEl); wrap.appendChild(input);
        ctrl.input = input;
        ctrl.get = () => {
          const v = input.value;
          if (type === 'nombre') return v === '' ? (def.vide === undefined ? null : def.vide) : Number(v);
          if (type === 'datetime') return v ? new Date(v).toISOString() : null;
          return v;
        };
        ctrl.set = (v) => { input.value = v == null ? '' : (type === 'datetime' ? dateHeureLocale(v) : type === 'date' ? dateISO(v) : v); };
      }
      if (def.aide && type !== 'separateur') wrap.appendChild(el('div', { class: 'aide' }, def.aide));
      if (type !== 'separateur' && type !== 'html') wrap.appendChild(err);
      formEl.appendChild(wrap);
      controles[nomChamp] = ctrl;
    }
    api.rafraichirVisibilite();
    return api;
  }

  function lireFichier(file, texte) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Lecture du fichier impossible'));
      if (texte) r.readAsText(file); else r.readAsDataURL(file);
    });
  }

  /** Modale contenant un formulaire. onSubmit(valeurs, modal, form) ; retourner false pour laisser ouvert. */
  function formModal({ titre, champs, valeurs, colonnes = 2, taille, onSubmit, submitLabel = 'Enregistrer', annulerLabel = 'Annuler', boutonsSupp = [], apres, avant, onFermer } = {}) {
    const f = form({ champs, valeurs, colonnes });
    const m = modal({
      titre, taille, onFermer,
      contenu: frag(avant || null, f.el, apres || null),
      boutons: [
        ...boutonsSupp.map((b) => Object.assign({}, b, { onClic: b.onClic ? (mm, btn) => b.onClic(f, mm, btn) : undefined })),
        { label: annulerLabel },
        { label: submitLabel, classe: 'btn-primaire', onClic: async () => { if (!f.valider()) return false; const r = await onSubmit(f.valeurs(), m, f); return r === false ? false : r; } },
      ],
    });
    f.el.addEventListener('submit', (ev) => { ev.preventDefault(); const btns = m.pied.querySelectorAll('button'); btns[btns.length - 1].click(); });
    m.form = f;
    return m;
  }

  // ----- Champs personnalisés ---------------------------------------------
  function champsPersoDefs(entite, prefixe = 'champs') {
    const defs = (((G().config || {}).champsPersonnalises || {})[entite]) || [];
    const types = { texte: 'texte', texte_long: 'texte_long', nombre: 'nombre', date: 'date', liste: 'select', booleen: 'booleen' };
    const out = defs.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map((d) => ({
      nom: `${prefixe}.${d.cle}`, label: d.label, type: types[d.type] || 'texte', requis: !!d.obligatoire, aide: d.aide || '',
      options: d.type === 'liste' ? [{ value: '', label: '— Choisir —' }].concat((d.options || []).map((o) => ({ value: o, label: o }))) : undefined,
    }));
    if (out.length) out.unshift({ type: 'separateur', label: 'Informations complémentaires' });
    return out;
  }
  /** Extrait { cle: valeur } depuis les valeurs d'un formulaire (clés "champs.xxx"). */
  function champsPersoValeurs(valeursForm, prefixe = 'champs') {
    const out = {};
    for (const [k, v] of Object.entries(valeursForm || {})) if (k.startsWith(prefixe + '.')) out[k.slice(prefixe.length + 1)] = v;
    return out;
  }
  /** Valeurs initiales de formulaire pour un enregistrement ({ champs: {...} } → { 'champs.cle': v }). */
  function champsPersoInitiaux(record, prefixe = 'champs') {
    const out = {};
    for (const [k, v] of Object.entries((record && record.champs) || {})) out[`${prefixe}.${k}`] = v;
    return out;
  }
  function champsPersoAffichage(entite, record) {
    const defs = (((G().config || {}).champsPersonnalises || {})[entite]) || [];
    const vals = (record && record.champs) || {};
    return defs.map((d) => {
      let v = vals[d.cle];
      if (v === null || v === undefined || v === '') v = '—';
      else if (d.type === 'booleen') v = v ? 'Oui' : 'Non';
      else if (d.type === 'date') v = formatDate(v);
      else if (d.type === 'nombre') v = formatNombre(v);
      return { label: d.label, valeur: v };
    });
  }

  // ----- Tableau ------------------------------------------------------------
  function texteDe(node) {
    if (node == null) return '';
    if (node instanceof Node) return node.textContent || '';
    return String(node);
  }

  /**
   * ui.table({ colonnes:[{cle,label,rendu(row),tri,classe,aligner,valeurTri(row)}], lignes, cleId, onClic(row), actions:[{icone,label,titre,onClic(row),visible(row),classe}],
   *   recherche:true|'placeholder', tailleParPage, pagination, vide, triInitial:{cle,sens}, groupe:{cle(row),label(val),ordre(a,b)}, ligneClasse(row), compact, exportCsv:'nom.csv', outils:[Node], selection:bool })
   */
  function table(options) {
    const o = Object.assign({ cleId: 'id', recherche: true, pagination: true, tailleParPage: ((G().config || {}).general || {}).lignesParPage || 25, vide: 'Aucun élément à afficher' }, options);
    let lignes = (o.lignes || []).slice();
    let filtre = '';
    let page = 1;
    let tri = o.triInitial ? Object.assign({}, o.triInitial) : null;
    const selection = new Set();

    const conteneur = el('div', { class: 'tableau-composant' });
    const barre = el('div', { class: 'barre-outils' });
    let inputRecherche = null;
    if (o.recherche) {
      inputRecherche = el('input', { type: 'search', placeholder: typeof o.recherche === 'string' ? o.recherche : 'Rechercher…', style: { maxWidth: '280px' } });
      inputRecherche.addEventListener('input', debounce(() => { filtre = inputRecherche.value.trim().toLowerCase(); page = 1; rendre(); }, 200));
      barre.appendChild(inputRecherche);
    }
    (o.outils || []).forEach((n) => append(barre, n));
    if (o.exportCsv) {
      barre.appendChild(el('span', { class: 'espace' }));
      barre.appendChild(el('button', { class: 'btn btn-sm', type: 'button', onclick: () => exportCsv(typeof o.exportCsv === 'string' ? o.exportCsv : 'export.csv', o.colonnes, lignesFiltrees()) }, icone('export'), 'Exporter CSV'));
    }
    if (barre.children.length) conteneur.appendChild(barre);
    const wrapper = el('div', { class: 'tableau-conteneur' });
    conteneur.appendChild(wrapper);

    function valeurCellule(col, row) {
      if (col.rendu) return col.rendu(row);
      const v = col.cle ? col.cle.split('.').reduce((a, k) => (a == null ? a : a[k]), row) : '';
      if (col.type === 'date') return formatDate(v);
      if (col.type === 'datetime') return formatDateHeure(v);
      if (col.type === 'nombre') return formatNombre(v, col.decimales);
      if (col.type === 'montant') return formatMontant(v);
      if (col.type === 'booleen') return v ? 'Oui' : 'Non';
      if (col.type === 'user') return nomUser(v);
      if (col.type === 'secteur') return nomSecteur(v);
      if (col.liste) return badgeListe(col.liste, v);
      return v == null ? '' : v;
    }
    function valeurTri(col, row) {
      if (col.valeurTri) return col.valeurTri(row);
      const v = col.cle ? col.cle.split('.').reduce((a, k) => (a == null ? a : a[k]), row) : '';
      if (col.rendu && (v === undefined || v === null)) return texteDe(col.rendu(row)).toLowerCase();
      if (col.type === 'user') return nomUser(v).toLowerCase();
      if (col.type === 'secteur') return nomSecteur(v).toLowerCase();
      if (col.liste) { const it = itemListe(col.liste, v); return it ? (it.ordre || 0) : 999; }
      return typeof v === 'string' ? v.toLowerCase() : (v == null ? '' : v);
    }
    function lignesFiltrees() {
      let rows = lignes;
      if (filtre) {
        rows = rows.filter((r) => o.colonnes.some((c) => texteDe(valeurCellule(c, r)).toLowerCase().includes(filtre)) || (o.rechercheDans && o.rechercheDans(r).toLowerCase().includes(filtre)));
      }
      if (tri) {
        const col = o.colonnes.find((c) => c.cle === tri.cle || c.label === tri.cle);
        if (col) {
          const sens = tri.sens === 'desc' ? -1 : 1;
          rows = rows.slice().sort((a, b) => {
            if (typeof col.tri === 'function') return col.tri(a, b) * sens;
            const va = valeurTri(col, a), vb = valeurTri(col, b);
            if (va === vb) return 0;
            if (va === '' || va == null) return 1;
            if (vb === '' || vb == null) return -1;
            return (va < vb ? -1 : 1) * sens;
          });
        }
      }
      if (o.groupe) {
        const grp = o.groupe;
        rows = rows.slice().sort((a, b) => {
          const ga = grp.cle(a), gb = grp.cle(b);
          if (ga === gb) return 0;
          if (grp.ordre) return grp.ordre(ga, gb);
          return String(ga == null ? '' : ga).localeCompare(String(gb == null ? '' : gb));
        });
      }
      return rows;
    }

    function rendre() {
      vider(wrapper);
      const rows = lignesFiltrees();
      const total = rows.length;
      const parPage = o.pagination ? o.tailleParPage : Infinity;
      const nbPages = Math.max(1, Math.ceil(total / parPage));
      if (page > nbPages) page = nbPages;
      const visibles = o.pagination ? rows.slice((page - 1) * parPage, page * parPage) : rows;

      const tbl = el('table', { class: 'tableau' + (o.compact ? ' tableau-compact' : '') });
      const thead = el('thead');
      const trh = el('tr');
      if (o.selection) {
        const all = el('input', { type: 'checkbox', title: 'Tout sélectionner' });
        all.addEventListener('change', () => { visibles.forEach((r) => { if (all.checked) selection.add(r[o.cleId]); else selection.delete(r[o.cleId]); }); rendre(); if (o.onSelection) o.onSelection(api.selection()); });
        trh.appendChild(el('th', { style: { width: '32px' } }, all));
      }
      for (const col of o.colonnes) {
        const triable = col.tri !== false;
        const th = el('th', { class: (triable ? 'triable ' : '') + (col.aligner === 'droite' ? 'num ' : col.aligner === 'centre' ? 'centre ' : '') + (col.classe || ''), style: col.largeur ? { width: col.largeur } : null }, col.label);
        if (triable) {
          const cle = col.cle || col.label;
          if (tri && tri.cle === cle) th.appendChild(el('span', { class: 'tri-indic' }, tri.sens === 'desc' ? '▼' : '▲'));
          th.addEventListener('click', () => { tri = tri && tri.cle === cle ? { cle, sens: tri.sens === 'asc' ? 'desc' : 'asc' } : { cle, sens: 'asc' }; rendre(); });
        }
        trh.appendChild(th);
      }
      const actionsVisibles = (o.actions || []).length > 0;
      if (actionsVisibles) trh.appendChild(el('th', { class: 'actions' }, ''));
      thead.appendChild(trh);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      if (!visibles.length) {
        tbody.appendChild(el('tr', null, el('td', { colspan: o.colonnes.length + (actionsVisibles ? 1 : 0) + (o.selection ? 1 : 0), class: 'tableau-vide' }, filtre ? 'Aucun résultat pour cette recherche' : o.vide)));
      }
      let groupeCourant;
      for (const row of visibles) {
        if (o.groupe) {
          const g = o.groupe.cle(row);
          if (g !== groupeCourant) {
            groupeCourant = g;
            const td = el('td', { colspan: o.colonnes.length + (actionsVisibles ? 1 : 0) + (o.selection ? 1 : 0) });
            append(td, o.groupe.label ? o.groupe.label(g, rows.filter((r) => o.groupe.cle(r) === g)) : (g == null || g === '' ? 'Sans groupe' : String(g)));
            tbody.appendChild(el('tr', { class: 'groupe-ligne' }, td));
          }
        }
        const tr = el('tr', { class: (o.onClic ? 'cliquable ' : '') + (o.ligneClasse ? o.ligneClasse(row) || '' : '') });
        if (o.selection) {
          const cb = el('input', { type: 'checkbox', checked: selection.has(row[o.cleId]) });
          cb.addEventListener('click', (ev) => ev.stopPropagation());
          cb.addEventListener('change', () => { if (cb.checked) selection.add(row[o.cleId]); else selection.delete(row[o.cleId]); if (o.onSelection) o.onSelection(api.selection()); });
          tr.appendChild(el('td', null, cb));
        }
        for (const col of o.colonnes) {
          const td = el('td', { class: (col.aligner === 'droite' ? 'num ' : col.aligner === 'centre' ? 'centre ' : '') + (col.classeCellule ? col.classeCellule(row) || '' : col.classe || '') });
          append(td, valeurCellule(col, row));
          tr.appendChild(td);
        }
        if (actionsVisibles) {
          const td = el('td', { class: 'actions' });
          for (const a of o.actions) {
            if (a.visible && !a.visible(row)) continue;
            const btn = el('button', { type: 'button', class: 'btn btn-icone btn-sm ' + (a.classe || ''), title: a.titre || a.label, onclick: (ev) => { ev.stopPropagation(); a.onClic(row, ev); } }, a.icone ? icone(a.icone) : null, a.icone ? null : a.label);
            td.appendChild(btn);
          }
          tr.appendChild(td);
        }
        if (o.onClic) tr.addEventListener('click', (ev) => o.onClic(row, ev));
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      wrapper.appendChild(tbl);

      if (o.pagination && (total > parPage || o.piedToujours)) {
        const pied = el('div', { class: 'tableau-pied' });
        pied.appendChild(el('span', null, `${total} élément${total > 1 ? 's' : ''} · page ${page}/${nbPages}`));
        const pag = el('div', { class: 'pagination' });
        const b = (label, p, dis) => el('button', { class: 'btn', type: 'button', disabled: dis, onclick: () => { page = p; rendre(); } }, label);
        pag.appendChild(b('«', 1, page === 1));
        pag.appendChild(b('‹', page - 1, page === 1));
        const debut = Math.max(1, page - 2), fin = Math.min(nbPages, debut + 4);
        for (let p = debut; p <= fin; p++) pag.appendChild(el('button', { class: 'btn' + (p === page ? ' btn-primaire' : ''), type: 'button', onclick: () => { page = p; rendre(); } }, String(p)));
        pag.appendChild(b('›', page + 1, page === nbPages));
        pag.appendChild(b('»', nbPages, page === nbPages));
        pied.appendChild(pag);
        wrapper.appendChild(pied);
      } else if (total && o.pagination) {
        wrapper.appendChild(el('div', { class: 'tableau-pied' }, el('span', null, `${total} élément${total > 1 ? 's' : ''}`)));
      }
    }

    const api = {
      el: conteneur,
      maj(nouvelles) { lignes = (nouvelles || []).slice(); rendre(); },
      get lignes() { return lignes; },
      filtrees: lignesFiltrees,
      rendre,
      selection() { return Array.from(selection); },
      viderSelection() { selection.clear(); rendre(); },
      setGroupe(g) { o.groupe = g || null; rendre(); },
      setTri(t) { tri = t || null; rendre(); },
      rechercher(txt) { filtre = String(txt || '').toLowerCase(); if (inputRecherche) inputRecherche.value = txt || ''; page = 1; rendre(); },
    };
    rendre();
    return api;
  }

  function exportCsv(nom, colonnes, lignes) {
    const sep = ';';
    const escCsv = (v) => { const s = texteDe(v).replace(/\r?\n/g, ' '); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cols = colonnes.filter((c) => c.export !== false);
    const out = ['﻿' + cols.map((c) => escCsv(c.label)).join(sep)];
    for (const r of lignes) {
      out.push(cols.map((c) => {
        if (c.exportValeur) return escCsv(c.exportValeur(r));
        if (c.rendu) return escCsv(c.rendu(r));
        const v = c.cle ? c.cle.split('.').reduce((a, k) => (a == null ? a : a[k]), r) : '';
        if (c.type === 'date') return escCsv(formatDate(v));
        if (c.type === 'datetime') return escCsv(formatDateHeure(v));
        if (c.type === 'user') return escCsv(nomUser(v));
        if (c.type === 'secteur') return escCsv(nomSecteur(v));
        if (c.type === 'booleen') return v ? 'Oui' : 'Non';
        if (c.liste) return escCsv(libelle(c.liste, v));
        return escCsv(v);
      }).join(sep));
    }
    telecharger(nom, out.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function telecharger(nom, contenu, type) {
    const blob = contenu instanceof Blob ? contenu : new Blob([contenu], { type: type || 'application/octet-stream' });
    const a = el('a', { href: URL.createObjectURL(blob), download: nom });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function imprimer(titre, html) {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { toast('Fenêtre bloquée : autorisez les fenêtres surgissantes pour imprimer', 'alerte'); return; }
    const societe = ((G().config || {}).societe || {}).nom || '';
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title>
      <style>body{font-family:Segoe UI,Arial,sans-serif;font-size:12.5px;color:#111;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;border-bottom:1px solid #999;padding-bottom:3px;margin:16px 0 8px}
      table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#eee}
      .entete{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:14px}.entete .soc{font-weight:700;font-size:15px}
      dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}dt{font-weight:600;color:#444}dd{margin:0}.signature{margin-top:30px;display:flex;gap:40px}.signature div{flex:1;border-top:1px solid #333;padding-top:4px}
      .badge{display:inline-block;padding:1px 6px;border:1px solid #666;border-radius:8px;font-size:11px}@media print{button{display:none}}</style></head>
      <body><div class="entete"><div><div class="soc">${esc(societe)}</div><div>${esc(titre)}</div></div><div>Imprimé le ${esc(formatDateHeure(new Date()))}</div></div>${html}
      <script>window.onload=function(){window.print();}</script></body></html>`);
    w.document.close();
  }

  // ----- Composants de page -------------------------------------------------
  function pageEntete({ titre, icone: ic, sousTitre, actions, filAriane } = {}) {
    const gauche = el('div');
    if (filAriane) gauche.appendChild(el('div', { class: 'fil-ariane' }, filAriane.map((x, i) => frag(i ? '›' : null, x.href ? el('a', { href: x.href }, x.label) : el('span', null, x.label)))));
    gauche.appendChild(el('h1', null, ic ? icone(ic) : null, titre));
    if (sousTitre) gauche.appendChild(el('div', { class: 'page-sous-titre' }, sousTitre));
    const droite = el('div', { class: 'page-actions' });
    (actions || []).forEach((a) => append(droite, a));
    return el('div', { class: 'page-entete' }, gauche, droite);
  }
  function bouton(label, opts = {}) {
    return el('button', { type: 'button', class: 'btn ' + (opts.classe || ''), title: opts.titre, disabled: opts.disabled, onclick: opts.onClic }, opts.icone ? icone(opts.icone) : null, label);
  }
  function vide(message, ic) { return el('div', { class: 'vide' }, el('div', null, icone(ic || 'info')), el('div', null, message || 'Aucun élément')); }
  function chargement(msg) { return el('div', { class: 'chargement' }, el('div', { class: 'spinner petit' }), msg || 'Chargement…'); }
  function kpi({ label, valeur, couleur: c, icone: ic, detail, onClic }) {
    const k = el('div', { class: 'kpi' + (onClic ? ' cliquable' : ''), style: c ? { '--kpi-couleur': c } : null, onclick: onClic },
      ic ? el('div', { class: 'kpi-icone' }, icone(ic)) : null,
      el('div', null, el('div', { class: 'kpi-valeur' }, String(valeur)), el('div', { class: 'kpi-label' }, label), detail ? el('div', { class: 'kpi-detail' }, detail) : null));
    return k;
  }
  function details(items, opts = {}) {
    const dl = el('dl', { class: 'details' + (opts.colonnes === 2 ? ' colonnes-2' : '') });
    for (const it of items) {
      if (!it) continue;
      dl.appendChild(el('dt', null, it.label));
      const dd = el('dd'); append(dd, it.valeur === '' || it.valeur == null ? '—' : it.valeur); dl.appendChild(dd);
    }
    return dl;
  }
  function alerte(message, type = 'info') { const a = el('div', { class: 'alerte alerte-' + type }); append(a, message); return a; }
  function carte(titre, contenu, opts = {}) {
    const c = el('div', { class: 'carte' + (opts.classe ? ' ' + opts.classe : '') });
    if (titre || opts.actions) c.appendChild(el('div', { class: 'carte-titre' }, el('h3', null, titre), opts.actions ? el('div', { class: 'inline' }, opts.actions) : null));
    append(c, contenu);
    return c;
  }

  /** Onglets : [{ cle, label, rendu(container) | contenu, badge, icone }] ; rendu appelé à chaque activation (lazy). */
  function onglets(items, opts = {}) {
    const barre = el('div', { class: 'onglets' });
    const corps = el('div', { class: 'onglets-corps' });
    const cont = el('div', null, barre, corps);
    let actif = null;
    const boutons = {};
    function activer(cle) {
      const it = items.find((x) => x.cle === cle) || items[0];
      if (!it) return;
      actif = it.cle;
      Object.values(boutons).forEach((b) => b.classList.toggle('actif', b.dataset.cle === actif));
      vider(corps);
      if (it.rendu) { const r = it.rendu(corps); if (r instanceof Node) corps.appendChild(r); else if (r && typeof r.then === 'function') { corps.appendChild(chargement()); r.then((n) => { if (actif === it.cle) { vider(corps); if (n instanceof Node) corps.appendChild(n); } }).catch(erreur); } }
      else append(corps, it.contenu);
      if (opts.onChange) opts.onChange(actif);
      if (opts.hash) { const h = location.hash.split('?')[0]; history.replaceState(null, '', h + '?onglet=' + actif); }
    }
    items.forEach((it) => {
      const b = el('button', { type: 'button', dataset: { cle: it.cle }, onclick: () => activer(it.cle) }, it.icone ? icone(it.icone) : null, it.label, it.badge != null ? el('span', { class: 'badge' }, String(it.badge)) : null);
      boutons[it.cle] = b; barre.appendChild(b);
    });
    let initial = opts.actif;
    if (!initial && opts.hash) { const q = new URLSearchParams((location.hash.split('?')[1] || '')); initial = q.get('onglet'); }
    activer(initial || (items[0] && items[0].cle));
    return { el: cont, activer, get actif() { return actif; }, setBadge(cle, v) { const b = boutons[cle]; if (!b) return; let bd = b.querySelector('.badge'); if (!bd) { bd = el('span', { class: 'badge' }); b.appendChild(bd); } bd.textContent = String(v); } };
  }

  /** Arbre : noeuds [{ id, label, enfants:[], icone, compteur, ... }] */
  function arbre(noeuds, opts = {}) {
    const racine = el('div', { class: 'arbre' });
    let selectionne = opts.selectionne == null ? null : opts.selectionne;
    const elements = new Map();
    function construire(liste, niveau) {
      const ul = el('ul');
      for (const n of liste) {
        const enfants = (opts.enfants ? opts.enfants(n) : n.enfants) || [];
        const li = el('li', { class: niveau >= (opts.niveauReplie == null ? 99 : opts.niveauReplie) && enfants.length ? 'replie' : '' });
        const bascule = el('span', { class: 'bascule' + (enfants.length ? '' : ' vide') }, enfants.length ? '▼' : '');
        const id = opts.cle ? opts.cle(n) : n.id;
        const noeud = el('div', { class: 'noeud' + (selectionne === id ? ' actif' : ''), dataset: { id } }, bascule, opts.icone ? icone(opts.icone(n)) : null, opts.couleur && opts.couleur(n) ? pastille(opts.couleur(n)) : null, el('span', { class: 'noeud-label' }, opts.label ? opts.label(n) : n.label || n.nom), opts.compteur && opts.compteur(n) != null ? el('span', { class: 'noeud-compteur' }, String(opts.compteur(n))) : null);
        bascule.addEventListener('click', (ev) => { ev.stopPropagation(); li.classList.toggle('replie'); bascule.textContent = li.classList.contains('replie') ? '▶' : '▼'; });
        if (li.classList.contains('replie')) bascule.textContent = '▶';
        noeud.addEventListener('click', () => { api.selectionner(id); if (opts.onSelect) opts.onSelect(n, noeud); });
        elements.set(id, noeud);
        li.appendChild(noeud);
        if (enfants.length) li.appendChild(construire(enfants, niveau + 1));
        ul.appendChild(li);
      }
      return ul;
    }
    racine.appendChild(construire(noeuds, 0));
    const api = {
      el: racine,
      selectionner(id) { selectionne = id; elements.forEach((e, k) => e.classList.toggle('actif', k === id)); },
      get selectionne() { return selectionne; },
    };
    return api;
  }

  /** Avatar (initiales) */
  function avatar(nom, taille) { return el('div', { class: 'avatar', style: taille ? { width: taille + 'px', height: taille + 'px', fontSize: Math.round(taille / 2.5) + 'px' } : null }, initiales(nom)); }

  /** Lien vers une vue (hash). */
  function lien(href, label, opts = {}) { return el('a', { href, class: opts.classe, onclick: opts.onClic }, label); }

  /** Graphique en barres très simple : [{label, valeur, couleur}] */
  function graphiqueBarres(donnees, opts = {}) {
    const max = Math.max(1, ...donnees.map((d) => d.valeur));
    return el('div', { class: 'graphique-barres', style: opts.hauteur ? { height: opts.hauteur + 'px' } : null }, donnees.map((d) => el('div', { class: 'barre', title: `${d.label} : ${formatNombre(d.valeur)}`, onclick: d.onClic },
      el('span', { class: 'texte-gras', style: { color: 'var(--texte)' } }, formatNombre(d.valeur)),
      el('div', { style: { height: Math.round((d.valeur / max) * 100) + '%', background: d.couleur || 'var(--primaire)' } }),
      el('span', null, d.label))));
  }

  /**
   * Matrice des droits (module × action).
   *  mode 'profil'     : cases à cocher, valeurs = { module: { action: bool } }
   *  mode 'surcharges' : tri-état hérité / accordé / retiré, valeurs = { module: { action: true|false } } (absent = hérité), base = droits du profil
   * Retourne { el, valeurs() }.
   */
  function matriceDroits({ modules, actions, valeurs, base, mode = 'profil', disabled = false, onChange } = {}) {
    const mods = (modules || G().modules || []).filter((m) => m.actif !== false);
    const acts = actions || (G().catalogue || {}).actions || {};
    const cles = Object.keys(acts);
    const etat = JSON.parse(JSON.stringify(valeurs || {}));
    const tbl = el('table', { class: 'matrice' });
    const trh = el('tr', null, el('th', null, 'Module'));
    for (const a of cles) {
      const th = el('th', null, acts[a]);
      if (mode === 'profil' && !disabled) {
        th.style.cursor = 'pointer'; th.title = 'Tout cocher / décocher la colonne';
        th.addEventListener('click', () => {
          const tous = mods.filter((m) => m.actions.includes(a)).every((m) => etat[m.key] && etat[m.key][a]);
          mods.forEach((m) => { if (m.actions.includes(a)) { etat[m.key] = etat[m.key] || {}; etat[m.key][a] = !tous; if (!tous && a !== 'voir') etat[m.key].voir = true; } });
          rendre();
        });
      }
      trh.appendChild(th);
    }
    tbl.appendChild(el('thead', null, trh));
    const tbody = el('tbody');
    tbl.appendChild(tbody);
    function rendre() {
      vider(tbody);
      for (const m of mods) {
        const tr = el('tr');
        const tdNom = el('td', null, el('div', { class: 'ligne-module' }, icone(m.icon || 'info'), m.label));
        if (mode === 'profil' && !disabled) {
          tdNom.style.cursor = 'pointer'; tdNom.title = 'Tout cocher / décocher la ligne';
          tdNom.addEventListener('click', () => { const tous = m.actions.every((a) => etat[m.key] && etat[m.key][a]); etat[m.key] = {}; m.actions.forEach((a) => { etat[m.key][a] = !tous; }); rendre(); if (onChange) onChange(api.valeurs()); });
        }
        tr.appendChild(tdNom);
        for (const a of cles) {
          if (!m.actions.includes(a)) { tr.appendChild(el('td', { class: 'na' }, '')); continue; }
          const td = el('td');
          if (mode === 'profil') {
            const cb = el('input', { type: 'checkbox', checked: !!(etat[m.key] && etat[m.key][a]), disabled });
            cb.addEventListener('change', () => { etat[m.key] = etat[m.key] || {}; etat[m.key][a] = cb.checked; if (cb.checked && a !== 'voir') { etat[m.key].voir = true; } if (!cb.checked && a === 'voir') { m.actions.forEach((x) => { etat[m.key][x] = false; }); } rendre(); if (onChange) onChange(api.valeurs()); });
            td.appendChild(cb);
          } else {
            const herite = !!(base && base[m.key] && base[m.key][a]);
            const ov = etat[m.key] && typeof etat[m.key][a] === 'boolean' ? etat[m.key][a] : null;
            const effectif = ov === null ? herite : ov;
            td.className = ov === true && !herite ? 'surcharge-plus' : ov === false && herite ? 'surcharge-moins' : '';
            const btn = el('button', { type: 'button', class: 'btn btn-sm' + (effectif ? ' btn-ok' : ''), disabled, title: ov === null ? `Hérité du profil (${herite ? 'oui' : 'non'})` : (ov ? 'Accordé en plus du profil' : 'Retiré par rapport au profil'), style: { minWidth: '72px', justifyContent: 'center' } }, ov === null ? (herite ? 'Oui' : 'Non') : (ov ? 'Oui +' : 'Non −'));
            btn.addEventListener('click', () => {
              etat[m.key] = etat[m.key] || {};
              if (ov === null) etat[m.key][a] = !herite; // première bascule : inverse l'héritage
              else if (ov !== herite) etat[m.key][a] = herite; // puis retour explicite à la valeur du profil
              else delete etat[m.key][a]; // puis retour à "hérité"
              if (etat[m.key][a] === undefined && !Object.keys(etat[m.key]).length) delete etat[m.key];
              rendre(); if (onChange) onChange(api.valeurs());
            });
            td.appendChild(btn);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    const api = { el: tbl, valeurs: () => JSON.parse(JSON.stringify(etat)), rendre, setBase(b) { base = b; rendre(); } };
    rendre();
    return api;
  }

  window.ui = {
    ICONES, icone, esc, el, frag, vider, append, debounce, matriceDroits,
    formatDate, formatHeure, formatDateHeure, dateISO, dateHeureLocale, aujourdhui, formatNombre, formatMontant, formatDuree, relatif, joursEntre, initiales, parseDate,
    liste, itemListe, libelle, couleur, user, nomUser, secteur, nomSecteur, cheminSecteur, profil, nomProfil, secteursDuSiteCourant,
    optionsListe, optionsUsers, optionsSecteurs, optionsProfils,
    badge, badgeListe, pastille, toast, erreur, modal, fermerModales, confirm, prompt,
    form, formModal, lireFichier, champsPersoDefs, champsPersoValeurs, champsPersoInitiaux, champsPersoAffichage,
    table, exportCsv, telecharger, imprimer,
    pageEntete, bouton, vide, chargement, kpi, details, alerte, carte, onglets, arbre, avatar, lien, graphiqueBarres,
  };
})();
