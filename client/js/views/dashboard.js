/**
 * Vue Tableau de bord (page d'accueil) : accueil personnalisé, points d'attention, indicateurs
 * cliquables, actions rapides, graphiques (anneau des statuts, évolution, types, secteurs,
 * équipements les plus sollicités, part du préventif) et listes compactes (mes OT, retards,
 * demandes à valider, préventifs, alertes de stock, équipements à l'arrêt, activité récente).
 * Données : GET /api/dashboard (calculées côté serveur selon les droits et la portée).
 * Chaque carte n'apparaît que si le module correspondant est visible pour l'utilisateur.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  const MODULE = 'dashboard';
  const ROUGE = '#dc2626';
  const ORANGE = '#f59e0b';
  const VERT = '#16a34a';
  const VIOLET = '#8b5cf6';
  const CYAN = '#0891b2';
  const GRIS = '#6b7280';
  const BLEU = 'var(--primaire)';
  const ACTUALISATION_AUTO_MS = 5 * 60 * 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  let minuteur = null;

  // ----- Utilitaires ---------------------------------------------------------------------
  const voir = (m) => GMAO.moduleVisible(m);
  const nb = (n) => ui.formatNombre(n || 0);
  const pluriel = (n, singulier, plurielTxt) => `${nb(n)} ${Number(n) > 1 ? (plurielTxt || singulier + 's') : singulier}`;
  const aller = (hash) => (hash ? () => GMAO.navigate(hash) : null);
  function lireLocal(cle) { try { return localStorage.getItem(cle); } catch (e) { return null; } }
  function ecrireLocal(cle, v) { try { localStorage.setItem(cle, v); } catch (e) { /* ignore */ } }
  function arreterMinuteur() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }
  function majuscule(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function dateLongue(d) { return majuscule((d || new Date()).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })); }
  function montantCompact(n) {
    const dev = ((GMAO.config || {}).general || {}).devise || '€';
    return `${ui.formatNombre(Math.round(Number(n) || 0), 0)} ${dev}`;
  }
  /** « Aujourd'hui », « Demain », « Hier », « dans 3 j », « il y a 5 j » pour une date AAAA-MM-JJ. */
  function jourRelatif(jour) {
    if (!jour) return '';
    const n = ui.joursEntre(ui.aujourdhui() + 'T12:00:00', String(jour).slice(0, 10) + 'T12:00:00');
    if (n === null) return '';
    if (n === 0) return 'aujourd\'hui';
    if (n === 1) return 'demain';
    if (n === -1) return 'hier';
    return n > 0 ? `dans ${n} j` : `il y a ${-n} j`;
  }
  function svg(tag, attrs, ...enfants) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
    for (const c of enfants) { if (c == null) continue; e.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); }
    return e;
  }
  const titreSvg = (txt) => svg('title', null, txt);

  /** Carte avec en-tête (icône, titre, compteur) et lien « Tout voir ». */
  function carte(titre, contenu, { icone: ic, compteur, couleurCompteur, lien, lienLabel, sousTitre, actions } = {}) {
    const c = el('div', { class: 'carte', style: { marginBottom: '0', display: 'flex', flexDirection: 'column', minWidth: '0' } });
    c.appendChild(el('div', { class: 'carte-titre', style: { marginBottom: sousTitre ? '2px' : '12px', flexWrap: 'wrap', rowGap: '4px' } },
      el('h3', { class: 'inline', style: { gap: '8px', whiteSpace: 'nowrap' } }, ic ? el('span', { style: { color: 'var(--primaire)', display: 'inline-flex' } }, icone(ic)) : null, titre,
        compteur != null ? ui.badge(nb(compteur), couleurCompteur || null) : null),
      el('div', { class: 'inline' }, actions || null, lien ? el('a', { href: lien, class: 'btn btn-lien btn-sm' }, lienLabel || 'Tout voir', icone('chevron_droite')) : null)));
    if (sousTitre) c.appendChild(el('div', { class: 'texte-2 texte-petit', style: { marginBottom: '10px' } }, sousTitre));
    const corps = el('div', { style: { flex: '1', minWidth: '0' } });
    ui.append(corps, contenu);
    c.appendChild(corps);
    return c;
  }
  function vide(message, ic) { return el('div', { class: 'texte-2 texte-centre', style: { padding: '22px 8px', fontSize: '13px' } }, el('div', { style: { color: 'var(--texte-2)', marginBottom: '6px', display: 'flex', justifyContent: 'center' } }, icone(ic || 'check')), message); }

  /** Ligne cliquable compacte : barre de couleur, titre, sous-titre, zone droite. */
  function ligne({ href, couleur, titre, sousTitre, droite, titreAttr }) {
    return el('a', {
      href, class: 'notif-item', title: titreAttr || null,
      style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 6px', color: 'inherit', textDecoration: 'none', borderRadius: '6px' },
    },
    el('span', { style: { width: '4px', alignSelf: 'stretch', borderRadius: '2px', background: couleur || 'var(--bordure-2)', flexShrink: '0' } }),
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { style: { fontWeight: '600', fontSize: '13px', lineHeight: '1.35', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', wordBreak: 'break-word' } }, titre),
      sousTitre ? el('div', { class: 'texte-2', style: { fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '1px' } }, sousTitre) : null),
    droite ? el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: '0', fontSize: '12px' } }, droite) : null);
  }
  const sep = () => el('span', { style: { margin: '0 5px', opacity: '0.6' } }, '·');
  function joindre(parts) { const out = []; parts.filter((p) => p !== null && p !== undefined && p !== '' && p !== false).forEach((p, i) => { if (i) out.push(sep()); out.push(p); }); return out; }

  // ----- Bannière d'accueil ----------------------------------------------------------------
  function pointsAttention(d) {
    const k = d.kpis; const c = d.compteurs || {};
    const pts = [];
    const ajouter = (n, texte, couleur, hash, ic) => { if (n) pts.push({ n, texte, couleur, hash, ic }); };
    if (voir('ot')) {
      ajouter(c.mesOTEnRetard, pluriel(c.mesOTEnRetard, 'de mes OT en retard', 'de mes OT en retard'), ROUGE, '#/ot?onglet=mes', 'horloge');
      ajouter(k.otEnRetard, pluriel(k.otEnRetard, 'OT en retard', 'OT en retard'), ROUGE, '#/ot?onglet=retard&filtre=enRetard', 'alerte');
    }
    if (voir('demandes') && d.droits.demandesValider) ajouter(k.demandesAValider, pluriel(k.demandesAValider, 'demande à valider', 'demandes à valider'), ORANGE, '#/demandes?onglet=aValider', 'check');
    if (voir('equipements')) ajouter(k.equipementsArret, pluriel(k.equipementsArret, 'équipement à l\'arrêt', 'équipements à l\'arrêt'), ROUGE, '#/equipements?etatCode=' + encodeURIComponent((d.filtres.etatsArret || ['arret'])[0] || 'arret'), 'equipements');
    if (voir('preventif')) ajouter(k.preventifsEnRetard, pluriel(k.preventifsEnRetard, 'préventif en retard', 'préventifs en retard'), ROUGE, '#/preventif?etat=en_retard', 'preventif');
    if (voir('stock')) ajouter(c.articlesRupture, pluriel(c.articlesRupture, 'article en rupture', 'articles en rupture'), ROUGE, '#/stock?onglet=alertes', 'stock');
    if (voir('stock')) ajouter((k.articlesSousSeuil || 0) - (c.articlesRupture || 0), pluriel((k.articlesSousSeuil || 0) - (c.articlesRupture || 0), 'article sous le seuil', 'articles sous le seuil'), ORANGE, '#/stock?onglet=alertes', 'stock');
    return pts;
  }

  function banniere(d) {
    const u = GMAO.user || {};
    const prenom = (d.utilisateur && d.utilisateur.prenom) || u.prenom || '';
    const nomComplet = `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login || '';
    const heure = new Date().getHours();
    const salutation = heure >= 18 || heure < 5 ? 'Bonsoir' : 'Bonjour';
    const message = (d.accueil && d.accueil.message) || (((GMAO.config || {}).general || {}).messageAccueil) || '';
    const pts = pointsAttention(d);
    const auMoinsUneSection = Object.keys(d.kpis).length > 0;

    const resume = [];
    const c = d.compteurs || {};
    if (voir('ot') && c.mesOT != null && (c.mesOT || !GMAO.can('ot', 'affecter'))) {
      resume.push(c.mesOT ? `Vous avez ${pluriel(c.mesOT, 'ordre de travail ouvert', 'ordres de travail ouverts')}${c.mesOTAujourdhui ? `, dont ${nb(c.mesOTAujourdhui)} prévu${c.mesOTAujourdhui > 1 ? 's' : ''} aujourd'hui` : ''}.` : 'Aucun ordre de travail ouvert ne vous est affecté.');
    }
    if (voir('demandes') && !d.droits.demandesValider && c.mesDemandesOuvertes) resume.push(`${pluriel(c.mesDemandesOuvertes, 'demande en cours', 'demandes en cours')} de traitement.`);

    const chips = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' } });
    if (pts.length) {
      pts.forEach((p) => chips.appendChild(el('a', {
        href: p.hash, title: 'Ouvrir la liste correspondante',
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '14px', fontSize: '12.5px', fontWeight: '600', textDecoration: 'none', color: 'var(--texte)', background: 'var(--surface)', border: '1px solid var(--bordure-2)' },
      }, el('span', { class: 'pastille', style: { background: p.couleur, margin: '0' } }), p.texte)));
    } else if (auMoinsUneSection) {
      chips.appendChild(el('span', { class: 'inline texte-ok', style: { fontSize: '13px', fontWeight: '600' } }, icone('check'), 'Aucun retard ni alerte : tout est sous contrôle.'));
    }

    const actions = [];
    if (voir('demandes') && GMAO.can('demandes', 'creer')) actions.push(ui.bouton('Nouvelle demande', { icone: 'plus', classe: 'btn-primaire', onClic: aller('#/demandes?nouveau=1') }));
    if (voir('ot') && GMAO.can('ot', 'creer')) actions.push(ui.bouton('Nouvel OT', { icone: 'ot', classe: actions.length ? '' : 'btn-primaire', onClic: aller('#/ot?nouveau=1') }));
    if (voir('stock') && (GMAO.can('stock', 'modifier') || GMAO.can('stock', 'creer'))) actions.push(ui.bouton('Entrée de stock', { icone: 'stock', onClic: aller('#/stock') }));
    if (voir('planning')) actions.push(ui.bouton('Planning', { icone: 'planning', onClic: aller('#/planning') }));

    return el('div', { class: 'carte', style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap', background: 'linear-gradient(120deg, var(--primaire-clair) 0%, var(--surface) 62%)' } },
      ui.avatar(nomComplet, 48),
      el('div', { style: { flex: '1 1 320px', minWidth: '0' } },
        el('h2', { style: { margin: '0 0 2px' } }, `${salutation}${prenom ? ' ' + prenom : ''},`),
        el('div', { class: 'texte-2', style: { fontSize: '13px' } }, joindre([dateLongue(), d.utilisateur && d.utilisateur.profil ? d.utilisateur.profil : null, d.utilisateur && d.utilisateur.fonction ? d.utilisateur.fonction : null])),
        resume.length ? el('div', { style: { marginTop: '8px', fontSize: '13.5px' } }, resume.join(' ')) : null,
        message ? el('div', { class: 'inline', style: { marginTop: '10px', alignItems: 'flex-start', gap: '8px', fontSize: '13px', padding: '8px 10px', borderRadius: '6px', background: 'var(--surface)', border: '1px solid var(--bordure)', maxWidth: '900px' } },
          el('span', { style: { color: 'var(--primaire)', display: 'inline-flex', marginTop: '1px' } }, icone('info')), el('span', { style: { whiteSpace: 'pre-line' } }, message)) : null,
        chips),
      actions.length ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'stretch', minWidth: '170px' } }, el('div', { class: 'texte-2 texte-petit texte-gras', style: { textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Actions rapides'), actions) : null);
  }

  // ----- Indicateurs ----------------------------------------------------------------------
  /** Définitions des indicateurs visibles (utilisées aussi pour l'export CSV et l'impression). */
  function indicateurs(d) {
    const k = d.kpis; const c = d.compteurs || {};
    const moisNom = MOIS_LONGS[Number(String(d.mois || ui.aujourdhui()).slice(5, 7)) - 1] || '';
    const etatArret = (d.filtres.etatsArret || ['arret'])[0] || 'arret';
    const out = [];
    const a = (cond, def) => { if (cond) out.push(def); };
    const has = (cle) => Object.prototype.hasOwnProperty.call(k, cle);
    const rapports = voir('rapports') ? '#/rapports' : null;
    a(has('otOuverts') && voir('ot'), { label: 'OT ouverts', valeur: nb(k.otOuverts), icone: 'ot', couleur: BLEU, detail: c.otNonAffectes ? `${pluriel(c.otNonAffectes, 'non affecté', 'non affectés')}` : 'tous affectés', hash: '#/ot?onglet=tous' });
    a(has('otEnRetard') && voir('ot'), { label: 'OT en retard', valeur: nb(k.otEnRetard), icone: 'alerte', couleur: k.otEnRetard ? ROUGE : VERT, detail: k.otEnRetard ? 'date prévue dépassée' : 'aucun retard', hash: '#/ot?onglet=retard&filtre=enRetard' });
    a(has('otEnCours') && voir('ot'), { label: 'OT en cours', valeur: nb(k.otEnCours), icone: 'horloge', couleur: ORANGE, detail: c.otEnAttente ? `${nb(c.otEnAttente)} en attente` : 'aucun en attente', hash: '#/ot?onglet=enCours' });
    a(has('otTerminesMois') && voir('ot'), { label: `Terminés en ${moisNom}`, valeur: nb(k.otTerminesMois), icone: 'check', couleur: VERT, detail: 'ordres de travail clôturés', hash: '#/ot?onglet=termines' });
    if (has('demandesAValider') && voir('demandes')) {
      if (d.droits.demandesValider) a(true, { label: 'Demandes à valider', valeur: nb(k.demandesAValider), icone: 'check', couleur: k.demandesAValider ? ORANGE : VERT, detail: k.demandesAValider ? 'en attente de votre décision' : 'rien à valider', hash: '#/demandes?onglet=aValider' });
      else a(true, { label: 'Mes demandes en cours', valeur: nb(c.mesDemandesOuvertes), icone: 'demandes', couleur: VIOLET, detail: 'non clôturées', hash: '#/demandes?onglet=mes' });
    }
    a(has('demandesOuvertes') && voir('demandes'), { label: 'Demandes ouvertes', valeur: nb(k.demandesOuvertes), icone: 'demandes', couleur: VIOLET, detail: c.demandesEnRetard ? `${pluriel(c.demandesEnRetard, 'hors délai', 'hors délai')}` : 'toutes dans les délais', hash: '#/demandes?onglet=toutes' });
    a(has('preventifsEnRetard') && voir('preventif'), { label: 'Préventifs en retard', valeur: nb(k.preventifsEnRetard), icone: 'preventif', couleur: k.preventifsEnRetard ? ROUGE : VERT, detail: k.preventifsEnRetard ? 'échéance dépassée' : 'plans à jour', hash: '#/preventif?etat=en_retard' });
    a(has('preventifsAVenir7j') && voir('preventif'), { label: 'Préventifs sous 7 jours', valeur: nb(k.preventifsAVenir7j), icone: 'calendrier', couleur: CYAN, detail: 'échéances à venir', hash: '#/preventif?onglet=echeancier' });
    a(has('articlesSousSeuil') && voir('stock'), { label: 'Articles sous le seuil', valeur: nb(k.articlesSousSeuil), icone: 'stock', couleur: k.articlesSousSeuil ? ORANGE : VERT, detail: c.articlesRupture ? `dont ${nb(c.articlesRupture)} en rupture` : 'aucune rupture', hash: '#/stock?onglet=alertes' });
    a(has('equipementsArret') && voir('equipements'), { label: 'Équipements à l\'arrêt', valeur: nb(k.equipementsArret), icone: 'equipements', couleur: k.equipementsArret ? ROUGE : VERT, detail: c.equipementsDegrades ? `${nb(c.equipementsDegrades)} en mode dégradé` : 'hors équipements réformés', hash: '#/equipements?etatCode=' + encodeURIComponent(etatArret) });
    a(has('heuresMois') && voir('ot'), { label: `Heures en ${moisNom}`, valeur: ui.formatDuree(k.heuresMois) || '0 h', icone: 'horloge', couleur: CYAN, detail: 'temps passé saisi sur les OT', hash: rapports });
    if (has('coutMois') && voir('ot')) {
      const cd = c.coutMoisDetail || {};
      a(true, { label: `Coût des OT terminés en ${moisNom}`, valeur: montantCompact(k.coutMois), icone: 'euro', couleur: GRIS, detail: `MO ${montantCompact(cd.mainOeuvre)} · pièces ${montantCompact(cd.pieces)} · ext. ${montantCompact(cd.externe)}`, hash: rapports });
    }
    return out;
  }
  function rangeeKpi(defs) {
    if (!defs.length) return null;
    // Grille fluide : 4 indicateurs par ligne sur un écran courant, 2 sur un écran étroit, 6 sur un grand écran
    return el('div', { class: 'grille grille-auto', style: { marginBottom: '16px' } }, defs.map((x) => {
      const k = ui.kpi({ label: x.label, valeur: x.valeur, couleur: x.couleur, icone: x.icone, detail: x.detail, onClic: aller(x.hash) });
      if (x.hash) { k.setAttribute('role', 'link'); k.setAttribute('tabindex', '0'); k.title = 'Ouvrir la liste correspondante'; k.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); GMAO.navigate(x.hash); } }); }
      return k;
    }));
  }

  // ----- Graphiques -----------------------------------------------------------------------
  /** Anneau SVG (part d'un tout) : segments [{ label, valeur, couleur }]. */
  function anneau(segments, { taille = 160, epaisseur = 22, centre, sousCentre } = {}) {
    const cx = taille / 2; const r = (taille - epaisseur) / 2 - 1; const circ = 2 * Math.PI * r;
    const total = segments.reduce((s, x) => s + (Number(x.valeur) || 0), 0);
    const visibles = segments.filter((x) => x.valeur > 0);
    const g = svg('svg', { viewBox: `0 0 ${taille} ${taille}`, width: taille, height: taille, role: 'img', 'aria-label': `${centre} ${sousCentre || ''}`.trim(), style: 'flex-shrink:0;max-width:100%' });
    if (!total) g.appendChild(svg('circle', { cx, cy: cx, r, fill: 'none', 'stroke-width': epaisseur, style: 'stroke: var(--fond-2)' }));
    const ecart = visibles.length > 1 ? 2 : 0; // séparation de 2 px (couleur de la surface)
    let decalage = 0;
    for (const s of visibles) {
      const longueur = (s.valeur / total) * circ;
      const trait = Math.max(0.5, longueur - ecart);
      g.appendChild(svg('circle', {
        cx, cy: cx, r, fill: 'none', 'stroke-width': epaisseur, stroke: s.couleur,
        'stroke-dasharray': `${trait} ${circ - trait}`, 'stroke-dashoffset': -decalage, transform: `rotate(-90 ${cx} ${cx})`,
        style: s.onClic ? 'cursor:pointer' : null,
      }, titreSvg(`${s.label} : ${nb(s.valeur)} (${Math.round((s.valeur / total) * 100)} %)`)));
      if (s.onClic) g.lastChild.addEventListener('click', s.onClic);
      decalage += longueur;
    }
    g.appendChild(svg('text', { x: cx, y: cx - 4, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 28, 'font-weight': 700, style: 'fill: var(--texte)' }, centre));
    if (sousCentre) g.appendChild(svg('text', { x: cx, y: cx + 20, 'text-anchor': 'middle', 'font-size': 11.5, style: 'fill: var(--texte-2)' }, sousCentre));
    return g;
  }
  function legende(segments, { total, onClic } = {}) {
    const t = total != null ? total : segments.reduce((s, x) => s + (Number(x.valeur) || 0), 0);
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1', minWidth: '150px' } }, segments.map((s) => el(onClic && onClic(s) ? 'a' : 'div', {
      href: onClic && onClic(s) ? onClic(s) : null, class: onClic && onClic(s) ? 'notif-item' : null,
      style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', borderRadius: '6px', fontSize: '13px', color: 'var(--texte)', textDecoration: 'none', borderBottom: '0', opacity: s.valeur ? '1' : '0.55' },
    }, el('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: s.couleur, flexShrink: '0' } }),
    el('span', { style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
    el('span', { class: 'texte-gras', style: { fontVariantNumeric: 'tabular-nums' } }, nb(s.valeur)),
    el('span', { class: 'texte-2 texte-petit', style: { width: '38px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, t ? `${Math.round((s.valeur / t) * 100)} %` : '—'))));
  }

  function carteStatuts(d) {
    const tous = d.graphiques.otParStatut || [];
    const corps = el('div');
    let mode = lireLocal('gmao.tdb.statuts') === 'tous' ? 'tous' : 'ouverts';
    const boutons = {};
    const groupe = el('div', { class: 'btn-groupe' }, ['ouverts', 'tous'].map((m) => (boutons[m] = el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { mode = m; ecrireLocal('gmao.tdb.statuts', m); rendre(); } }, m === 'ouverts' ? 'Ouverts' : 'Tous'))));
    function rendre() {
      Object.entries(boutons).forEach(([m, b]) => b.classList.toggle('actif', m === mode));
      ui.vider(corps);
      const segs = tous.filter((s) => (mode === 'tous' ? true : !s.final)).map((s) => Object.assign({}, s, { onClic: s.code ? aller('#/ot?statut=' + encodeURIComponent(s.code)) : null }));
      const total = segs.reduce((a, s) => a + s.valeur, 0);
      if (!tous.some((s) => s.valeur)) { corps.appendChild(vide('Aucun ordre de travail pour le moment.', 'ot')); return; }
      corps.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap', justifyContent: 'center' } },
        anneau(segs, { centre: nb(total), sousCentre: mode === 'tous' ? 'OT au total' : (total > 1 ? 'OT ouverts' : 'OT ouvert') }),
        legende(segs, { total, onClic: (s) => (s.code ? '#/ot?statut=' + encodeURIComponent(s.code) : null) })));
    }
    rendre();
    return carte('Répartition par statut', corps, { icone: 'ot', actions: groupe, sousTitre: 'Ordres de travail de votre périmètre' });
  }

  function carteEvolution(d) {
    const mois = d.graphiques.evolution6Mois || [];
    const statutTermine = ui.itemListe('statutsOT', d.filtres.statutTermine || 'termine');
    const couleurs = { crees: 'var(--primaire)', termines: (statutTermine && statutTermine.couleur) || VERT };
    const max = Math.max(1, ...mois.map((m) => Math.max(m.crees, m.termines)));
    const totalCrees = mois.reduce((a, m) => a + m.crees, 0);
    const totalTermines = mois.reduce((a, m) => a + m.termines, 0);
    if (!totalCrees && !totalTermines) return carte('Évolution sur 6 mois', vide('Aucune activité sur les six derniers mois.', 'rapports'), { icone: 'rapports' });
    const HAUT = 130;
    const graphe = el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '6px', height: HAUT + 'px', borderBottom: '1px solid var(--bordure)', padding: '0 2px' } }, mois.map((m, i) => {
      const dernier = i === mois.length - 1;
      const barre = (v, coul, lib) => el('div', { title: `${m.libelle} — ${lib} : ${nb(v)}`, style: { width: '16px', maxWidth: '45%', height: Math.max(v ? 3 : 0, Math.round((v / max) * (HAUT - 18))) + 'px', background: coul, borderRadius: '4px 4px 0 0' } });
      return el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', minWidth: '0' } },
        dernier ? el('div', { class: 'texte-petit texte-gras', style: { marginBottom: '2px', whiteSpace: 'nowrap' } }, `${nb(m.crees)} / ${nb(m.termines)}`) : null,
        el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '2px', justifyContent: 'center', width: '100%' } }, barre(m.crees, couleurs.crees, 'créés'), barre(m.termines, couleurs.termines, 'terminés')));
    }));
    const axe = el('div', { style: { display: 'flex', gap: '6px', padding: '4px 2px 0' } }, mois.map((m, i) => el('div', { class: 'texte-2', style: { flex: '1', textAlign: 'center', fontSize: '11px', fontWeight: i === mois.length - 1 ? '700' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, m.libelle)));
    const cle = (coul, txt) => el('span', { class: 'inline', style: { gap: '6px', fontSize: '12.5px' } }, el('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: coul } }), txt);
    const leg = el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
      cle(couleurs.crees, `Créés (${nb(totalCrees)})`), cle(couleurs.termines, `Terminés (${nb(totalTermines)})`),
      el('span', { class: 'texte-2 texte-petit', style: { marginLeft: 'auto' } }, `Moyenne : ${ui.formatNombre(totalCrees / Math.max(1, mois.length), 1)} créés / mois`));
    return carte('Évolution sur 6 mois', frag(graphe, axe, leg), { icone: 'rapports', sousTitre: 'OT créés et terminés par mois (mois en cours : créés / terminés)' });
  }

  function carteTypes(d) {
    const types = d.graphiques.otParType30j || [];
    const total = types.reduce((a, t) => a + t.valeur, 0);
    if (!total) return carte('OT créés par type (30 j)', vide('Aucun ordre de travail créé sur les 30 derniers jours.', 'ot'), { icone: 'liste' });
    const g = ui.graphiqueBarres(types.map((t) => ({ label: t.label, valeur: t.valeur, couleur: t.couleur, onClic: t.code ? aller('#/ot?typeCode=' + encodeURIComponent(t.code)) : null })), { hauteur: 170 });
    g.querySelectorAll('.barre').forEach((b, i) => { const t = types[i]; if (t && t.code) b.style.cursor = 'pointer'; const colonne = b.querySelector(':scope > div'); if (colonne) { colonne.style.width = '24px'; colonne.style.maxWidth = '100%'; } });
    return carte('OT créés par type (30 j)', g, { icone: 'liste', compteur: total, sousTitre: 'Hors OT annulés — cliquez sur une barre pour filtrer' });
  }

  /** Barres horizontales (une seule série : une seule couleur). */
  function barresHorizontales(items, { lien, couleur = 'var(--primaire)', detail } = {}) {
    const max = Math.max(1, ...items.map((x) => x.valeur));
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, items.map((x) => {
      const href = lien ? lien(x) : null;
      return el(href ? 'a' : 'div', { href, class: href ? 'notif-item' : null, title: `${x.label} : ${nb(x.valeur)}`, style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 38%) 1fr auto', alignItems: 'center', gap: '10px', padding: '5px 6px', borderRadius: '6px', color: 'var(--texte)', textDecoration: 'none', borderBottom: '0', fontSize: '13px' } },
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.label, detail ? el('div', { class: 'texte-2', style: { fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis' } }, detail(x)) : null),
        el('span', { style: { height: '10px', background: 'var(--fond-2)', borderRadius: '5px', overflow: 'hidden', display: 'block' } }, el('span', { style: { display: 'block', height: '100%', width: Math.max(2, Math.round((x.valeur / max) * 100)) + '%', background: couleur, borderRadius: '5px' } })),
        el('span', { class: 'texte-gras', style: { minWidth: '22px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nb(x.valeur)));
    }));
  }

  function carteSecteurs(d) {
    const s = d.graphiques.otParSecteur || [];
    if (!s.length) return carte('OT ouverts par secteur', vide('Aucun ordre de travail ouvert.', 'secteur'), { icone: 'secteur' });
    return carte('OT ouverts par secteur', barresHorizontales(s, { lien: (x) => (typeof x.secteurId === 'number' ? '#/ot?secteurId=' + x.secteurId : null) }), { icone: 'secteur', sousTitre: 'Charge en cours par secteur' });
  }

  function carteTopEquipements(d) {
    const top = d.graphiques.topEquipements90j || [];
    if (!top.length) return carte('Équipements les plus sollicités (90 j)', vide('Aucune intervention sur un équipement ces 90 derniers jours.', 'equipements'), { icone: 'equipements' });
    const max = Math.max(1, ...top.map((x) => x.nbOt));
    const lienEq = voir('equipements');
    return carte('Équipements les plus sollicités (90 j)', el('div', null, top.map((x, i) => el(lienEq ? 'a' : 'div', {
      href: lienEq ? '#/equipements/' + x.equipementId : null, class: lienEq ? 'notif-item' : null,
      style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 6px', borderRadius: '6px', color: 'inherit', textDecoration: 'none' },
    },
    el('span', { style: { width: '24px', height: '24px', borderRadius: '50%', background: i === 0 ? 'var(--primaire)' : 'var(--fond-2)', color: i === 0 ? '#fff' : 'var(--texte)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '12px', flexShrink: '0' } }, String(i + 1)),
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', minWidth: '0' } },
        el('span', { style: { fontWeight: '600', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.nom),
        x.etatCode && (d.filtres.etatsArret || []).includes(x.etatCode) ? ui.badgeListe('etatsEquipement', x.etatCode) : null),
      el('div', { class: 'texte-2', style: { fontSize: '11.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, joindre([x.numero, x.nbCorrectifs ? pluriel(x.nbCorrectifs, 'correctif') : 'aucun correctif', x.heures ? ui.formatDuree(x.heures) : null, x.cout ? montantCompact(x.cout) : null])),
      el('div', { style: { height: '6px', background: 'var(--fond-2)', borderRadius: '3px', marginTop: '4px', overflow: 'hidden' } }, el('div', { style: { height: '100%', width: Math.round((x.nbOt / max) * 100) + '%', background: 'var(--primaire)', borderRadius: '3px' } }))),
    el('span', { style: { textAlign: 'right', flexShrink: '0' } }, el('div', { class: 'texte-gras', style: { fontSize: '15px' } }, nb(x.nbOt)), el('div', { class: 'texte-2', style: { fontSize: '11px' } }, 'OT'))))), { icone: 'equipements', sousTitre: 'Nombre d\'OT (hors annulés) créés sur 90 jours' });
  }

  function carteRepartition(d) {
    const r = d.graphiques.repartitionPreventifCorrectif || {};
    if (!r.total) return carte('Préventif / correctif (90 j)', vide('Pas encore assez d\'interventions pour calculer la répartition.', 'preventif'), { icone: 'preventif' });
    const segs = (r.segments || []).filter((s) => s.valeur > 0);
    const barre = el('div', { style: { display: 'flex', gap: '2px', height: '14px', borderRadius: '7px', overflow: 'hidden', margin: '12px 0 10px' } },
      segs.map((s) => el('div', { title: `${s.label} : ${nb(s.valeur)} (${Math.round((s.valeur / r.total) * 100)} %)`, style: { flex: String(s.valeur), background: s.couleur, minWidth: '3px' } })));
    const taux = r.tauxPreventif == null ? 0 : r.tauxPreventif;
    return carte('Préventif / correctif (90 j)', frag(
      el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
        el('span', { style: { fontSize: '34px', fontWeight: '700', lineHeight: '1' } }, `${taux} %`),
        el('span', { class: 'texte-2', style: { fontSize: '13px' } }, `de maintenance préventive sur ${pluriel(r.total, 'OT', 'OT')}`)),
      barre,
      legende((r.segments || []).map((s) => ({ label: s.label, valeur: s.valeur, couleur: s.couleur })), { total: r.total })), { icone: 'preventif', sousTitre: 'Part des interventions planifiées dans l\'activité (hors annulés)' });
  }

  // ----- Listes ------------------------------------------------------------------------------
  function badgeRetard(jours) { return ui.badge(jours > 0 ? `retard ${jours} j` : 'en retard', ROUGE); }
  function sousTitreOt(o, { technicien } = {}) {
    const date = o.datePrevue ? (o.enRetard ? el('span', { class: 'texte-danger texte-gras' }, `prévu ${ui.formatDate(o.datePrevue)}`) : `prévu ${jourRelatif(o.datePrevue) === 'aujourd\'hui' || jourRelatif(o.datePrevue) === 'demain' ? jourRelatif(o.datePrevue) : 'le ' + ui.formatDate(o.datePrevue)}`) : 'non planifié';
    return joindre([o.equipementNom || o.secteurNom || null, date, technicien ? (o.technicienNom || 'non affecté') : null, o.nbTaches ? `${o.nbTachesFaites}/${o.nbTaches} tâches` : null]);
  }
  function ligneOt(o, opts = {}) {
    return ligne({
      href: '#/ot/' + o.id, couleur: ui.couleur('priorites', o.prioriteCode), titreAttr: `${o.numero} — ${o.titre}`,
      titre: frag(el('span', { class: 'texte-2', style: { fontWeight: '500', marginRight: '6px' } }, o.numero), o.titre),
      sousTitre: sousTitreOt(o, opts),
      droite: [ui.badgeListe('statutsOT', o.statut), o.enRetard ? badgeRetard(o.joursRetard) : (o.aujourdhui ? ui.badge('aujourd\'hui', ORANGE) : (o.prioriteCode ? ui.badgeListe('priorites', o.prioriteCode, { contour: true }) : null))],
    });
  }

  function carteMesOt(d) {
    const rows = d.listes.mesOT || [];
    const total = (d.compteurs || {}).mesOT || 0;
    const contenu = rows.length ? el('div', null, rows.map((o) => {
      const l = ligneOt(o);
      if (o.nbTaches) {
        const pct = Math.round((o.nbTachesFaites / o.nbTaches) * 100);
        l.querySelector('div').appendChild(el('div', { class: 'barre-progression', style: { height: '4px', marginTop: '5px', maxWidth: '260px' }, title: `${pct} % des tâches réalisées` }, el('div', { style: { width: pct + '%', background: pct === 100 ? VERT : 'var(--primaire)' } })));
      }
      return l;
    })) : vide('Aucun ordre de travail ouvert ne vous est affecté pour le moment.', 'check');
    return carte('Mes ordres de travail', frag(contenu, total > rows.length ? el('div', { class: 'texte-2 texte-petit mt' }, `… et ${pluriel(total - rows.length, 'autre')} : `, el('a', { href: '#/ot?onglet=mes' }, 'voir la liste complète')) : null),
      { icone: 'ot', compteur: total, couleurCompteur: (d.compteurs || {}).mesOTEnRetard ? ROUGE : null, lien: '#/ot?onglet=mes', sousTitre: (d.compteurs || {}).mesOTEnRetard ? `${pluriel(d.compteurs.mesOTEnRetard, 'en retard', 'en retard')} — en cours d'abord, puis par date prévue` : 'En cours d\'abord, puis par date prévue' });
  }

  function carteOtRetard(d) {
    const rows = d.listes.otEnRetard || [];
    return carte('OT en retard', rows.length ? el('div', null, rows.map((o) => ligneOt(o, { technicien: true }))) : vide('Aucun ordre de travail en retard. Bravo !', 'check'),
      { icone: 'alerte', compteur: d.kpis.otEnRetard, couleurCompteur: d.kpis.otEnRetard ? ROUGE : null, lien: '#/ot?onglet=retard&filtre=enRetard' });
  }

  function ligneDemande(x, { statut } = {}) {
    return ligne({
      href: '#/demandes/' + x.id, couleur: ui.couleur('priorites', x.prioriteCode), titreAttr: `${x.numero} — ${x.titre}`,
      titre: frag(el('span', { class: 'texte-2', style: { fontWeight: '500', marginRight: '6px' } }, x.numero), x.titre),
      sousTitre: joindre([statut ? null : (x.demandeurNom || null), x.equipementNom || x.secteurNom || null, x.dateDemande ? ui.relatif(x.dateDemande) : null]),
      droite: [statut ? ui.badgeListe('statutsDemande', x.statut) : ui.badgeListe('priorites', x.prioriteCode), x.arretProduction ? ui.badge('arrêt production', ROUGE) : (x.enRetard ? ui.badge('hors délai', ORANGE) : null)],
    });
  }
  function carteDemandes(d) {
    if (d.droits.demandesValider) {
      const rows = d.listes.demandesAValider || [];
      return carte('Demandes à valider', rows.length ? el('div', null, rows.map((x) => ligneDemande(x))) : vide('Aucune demande n\'attend votre validation.', 'check'),
        { icone: 'demandes', compteur: d.kpis.demandesAValider, couleurCompteur: d.kpis.demandesAValider ? ORANGE : null, lien: '#/demandes?onglet=aValider', sousTitre: rows.length ? 'Arrêts de production et priorités hautes en tête' : null });
    }
    const rows = d.listes.mesDemandes || [];
    return carte('Mes demandes en cours', rows.length ? el('div', null, rows.map((x) => ligneDemande(x, { statut: true }))) : vide('Vous n\'avez aucune demande en cours.', 'demandes'),
      { icone: 'demandes', compteur: (d.compteurs || {}).mesDemandesOuvertes, lien: '#/demandes?onglet=mes', actions: GMAO.can('demandes', 'creer') ? el('a', { href: '#/demandes?nouveau=1', class: 'btn btn-sm' }, icone('plus'), 'Signaler') : null });
  }

  function cartePreventifs(d) {
    const rows = d.listes.prochainsPreventifs || [];
    const contenu = rows.length ? el('div', null, rows.map((p) => {
      const quand = p.date ? (p.enRetard ? `en retard (${ui.formatDate(p.date)})` : `${ui.formatDate(p.date)} · ${jourRelatif(p.date)}`) : (p.valeurCompteur != null ? `à ${nb(p.valeurCompteur)} ${p.uniteCompteur || ''}`.trim() : 'échéance proche');
      return ligne({
        href: '#/preventif/' + p.planId, couleur: p.enRetard ? ROUGE : (p.etat === 'proche' ? ORANGE : VERT), titreAttr: `${p.numero} — ${p.nom}`,
        titre: frag(el('span', { class: 'texte-2', style: { fontWeight: '500', marginRight: '6px' } }, p.numero), p.nom),
        sousTitre: joindre([p.equipementNom || null, p.technicienNom || null, p.periodiciteLibelle || null]),
        droite: [el('span', { class: p.enRetard ? 'texte-danger texte-gras' : 'texte-gras', style: { whiteSpace: 'nowrap' } }, quand, p.estimee ? el('span', { class: 'texte-2', title: 'Date estimée d\'après le rythme d\'utilisation du compteur' }, ' (estimée)') : null),
          p.otOuvertId ? ui.badge(p.otOuvertNumero ? (/^OT/i.test(p.otOuvertNumero) ? p.otOuvertNumero : `OT ${p.otOuvertNumero}`) : 'OT généré', CYAN, { titre: 'Un ordre de travail est déjà ouvert pour cette échéance' }) : null],
      });
    })) : vide('Aucune échéance préventive programmée.', 'preventif');
    return carte('Prochains préventifs', contenu, { icone: 'preventif', compteur: d.kpis.preventifsEnRetard || null, couleurCompteur: ROUGE, lien: '#/preventif?onglet=echeancier', lienLabel: 'Échéancier' });
  }

  function carteStock(d) {
    const rows = d.listes.alertesStock || [];
    const contenu = rows.length ? el('div', null, rows.map((a) => ligne({
      href: '#/stock/' + a.id, couleur: a.rupture ? ROUGE : ORANGE, titreAttr: `${a.code} — ${a.designation}`,
      titre: frag(el('span', { class: 'texte-2', style: { fontWeight: '500', marginRight: '6px' } }, a.code), a.designation),
      sousTitre: joindre([a.emplacement || null, a.fournisseurNom || null, a.quantiteACommander ? `à commander : ${nb(a.quantiteACommander)}` : null]),
      droite: [ui.badge(`${nb(a.quantite)} / ${nb(a.seuilMin)}${a.uniteCode && a.uniteCode !== 'u' ? ' ' + ui.libelle('unites', a.uniteCode).toLowerCase() : ''}`, a.rupture ? ROUGE : ORANGE, { titre: 'Stock / seuil minimum' }), a.rupture ? el('span', { class: 'texte-danger texte-petit texte-gras' }, 'rupture') : null],
    }))) : vide('Aucun article sous le seuil de réapprovisionnement.', 'check');
    return carte('Alertes de stock', contenu, { icone: 'stock', compteur: d.kpis.articlesSousSeuil, couleurCompteur: d.kpis.articlesSousSeuil ? ORANGE : null, lien: '#/stock?onglet=alertes' });
  }

  function carteEquipementsArret(d) {
    const rows = d.listes.equipementsArret || [];
    if (!rows.length) return null;
    return carte('Équipements à l\'arrêt', el('div', null, rows.map((e) => ligne({
      href: '#/equipements/' + e.id, couleur: ui.couleur('etatsEquipement', e.etatCode), titreAttr: `${e.numero} — ${e.nom}`,
      titre: frag(el('span', { class: 'texte-2', style: { fontWeight: '500', marginRight: '6px' } }, e.numero), e.nom),
      sousTitre: joindre([e.secteurNom || null, e.motif || e.localisation || null]),
      droite: [ui.badgeListe('etatsEquipement', e.etatCode), e.depuis ? el('span', { class: 'texte-2' }, 'depuis ' + ui.relatif(e.depuis).replace(/^il y a /, '')) : (e.criticiteCode ? ui.badgeListe('criticites', e.criticiteCode, { contour: true }) : null)],
    }))), { icone: 'equipements', compteur: d.kpis.equipementsArret, couleurCompteur: ROUGE, lien: '#/equipements?etatCode=' + encodeURIComponent((d.filtres.etatsArret || ['arret'])[0] || 'arret') });
  }

  const COULEURS_ACTION = { creation: 'var(--primaire)', duplication: 'var(--primaire)', generation: CYAN, cloture: VERT, validation: VERT, statut: ORANGE, affectation: VIOLET, reouverture: ORANGE, annulation: ROUGE, refus: ROUGE, suppression: ROUGE, desactivation: ROUGE };
  function carteActivites(d) {
    const rows = d.listes.dernieresActivites || [];
    const source = (d.sources || {}).activites;
    const contenu = rows.length ? el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '8px' } }, rows.map((a) => {
      const cible = a.libelle || `${a.entiteLibelle || ''}${a.entiteId != null ? ' #' + a.entiteId : ''}${a.supprime ? ' (supprimé)' : ''}`;
      const qui = majuscule(a.userNom || '');
      return el(a.lien ? 'a' : 'div', {
        href: a.lien || null, class: a.lien ? 'notif-item' : null, title: [ui.formatDateHeure(a.date), qui, a.actionLibelle, cible, a.details].filter(Boolean).join('\n'),
        style: { display: 'block', padding: '8px 10px', border: '1px solid var(--bordure)', borderRadius: '8px', color: 'inherit', textDecoration: 'none', minWidth: '0' },
      },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' } },
        el('span', { class: 'pastille', style: { background: COULEURS_ACTION[a.action] || GRIS, margin: '0', flexShrink: '0' } }),
        el('span', { class: 'texte-gras', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.actionLibelle || a.action),
        el('span', { class: 'texte-2', style: { marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: '11.5px' } }, ui.relatif(a.date))),
      el('div', { style: { fontSize: '13px', fontWeight: '600', color: a.lien ? 'var(--primaire)' : 'var(--texte-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '3px' } }, cible),
      el('div', { class: 'texte-2', style: { fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' } }, joindre([qui || null, a.details || null])));
    })) : vide('Aucune activité récente.', 'horloge');
    return carte('Dernières activités', contenu, {
      icone: 'horloge', lien: source === 'audit' && voir('audit') ? '#/audit' : (source === 'ot' ? '#/ot' : null), lienLabel: source === 'audit' ? 'Journal d\'audit' : 'Tout voir',
      sousTitre: source === 'audit' ? 'Journal d\'audit : OT, demandes et équipements de votre périmètre' : 'Derniers ordres de travail mis à jour (dernière étape de chacun)',
    });
  }

  // ----- Export et impression -----------------------------------------------------------------
  function lignesExport(d, defs) {
    const out = defs.map((x) => ({ rubrique: 'Indicateurs', libelle: x.label, valeur: x.valeur, detail: x.detail || '' }));
    const g = d.graphiques || {};
    (g.otParStatut || []).forEach((s) => out.push({ rubrique: 'OT par statut', libelle: s.label, valeur: nb(s.valeur), detail: s.final ? 'statut final' : '' }));
    (g.otParType30j || []).forEach((s) => out.push({ rubrique: 'OT créés par type (30 j)', libelle: s.label, valeur: nb(s.valeur), detail: '' }));
    (g.otParSecteur || []).forEach((s) => out.push({ rubrique: 'OT ouverts par secteur', libelle: s.label, valeur: nb(s.valeur), detail: '' }));
    (g.topEquipements90j || []).forEach((s) => out.push({ rubrique: 'Équipements les plus sollicités (90 j)', libelle: `${s.numero} ${s.nom}`.trim(), valeur: nb(s.nbOt), detail: `${nb(s.nbCorrectifs)} correctif(s), ${ui.formatDuree(s.heures) || '0 h'}, ${montantCompact(s.cout)}` }));
    (g.evolution6Mois || []).forEach((m) => out.push({ rubrique: 'Évolution mensuelle', libelle: m.libelle, valeur: `${nb(m.crees)} créés`, detail: `${nb(m.termines)} terminés` }));
    if (g.repartitionPreventifCorrectif && g.repartitionPreventifCorrectif.total) {
      const r = g.repartitionPreventifCorrectif;
      out.push({ rubrique: 'Préventif / correctif (90 j)', libelle: 'Taux de préventif', valeur: `${r.tauxPreventif} %`, detail: `${nb(r.preventif)} préventifs, ${nb(r.correctif)} correctifs, ${nb(r.autres)} autres` });
    }
    return out;
  }
  function exporter(d, defs) {
    const lignes = lignesExport(d, defs);
    if (!lignes.length) { toast('Aucun indicateur à exporter', 'alerte'); return; }
    ui.exportCsv(`tableau-de-bord-${d.aujourdhui || ui.aujourdhui()}.csv`, [
      { label: 'Rubrique', cle: 'rubrique' }, { label: 'Indicateur', cle: 'libelle' }, { label: 'Valeur', cle: 'valeur' }, { label: 'Détail', cle: 'detail' },
    ], lignes);
    toast('Export CSV du tableau de bord téléchargé', 'succes');
  }
  function imprimer(d, defs) {
    const e = ui.esc;
    const table = (titre, entetes, lignes) => (lignes.length ? `<h2>${e(titre)}</h2><table><thead><tr>${entetes.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '');
    let html = table('Indicateurs', ['Indicateur', 'Valeur', 'Détail'], defs.map((x) => [x.label, x.valeur, x.detail || '']));
    const L = d.listes || {};
    if (L.otEnRetard && voir('ot')) html += table('OT en retard', ['Numéro', 'Titre', 'Équipement', 'Prévu le', 'Responsable', 'Statut'], L.otEnRetard.map((o) => [o.numero, o.titre, o.equipementNom, ui.formatDate(o.datePrevue), o.technicienNom, ui.libelle('statutsOT', o.statut)]));
    if (L.mesOT && L.mesOT.length && voir('ot')) html += table('Mes ordres de travail', ['Numéro', 'Titre', 'Équipement', 'Prévu le', 'Statut'], L.mesOT.map((o) => [o.numero, o.titre, o.equipementNom, ui.formatDate(o.datePrevue), ui.libelle('statutsOT', o.statut)]));
    if (L.demandesAValider && d.droits.demandesValider && voir('demandes')) html += table('Demandes à valider', ['Numéro', 'Titre', 'Demandeur', 'Priorité', 'Date'], L.demandesAValider.map((x) => [x.numero, x.titre, x.demandeurNom, ui.libelle('priorites', x.prioriteCode), ui.formatDateHeure(x.dateDemande)]));
    if (L.prochainsPreventifs && voir('preventif')) html += table('Prochains préventifs', ['Plan', 'Nom', 'Équipement', 'Échéance', 'Technicien'], L.prochainsPreventifs.map((p) => [p.numero, p.nom, p.equipementNom, p.date ? ui.formatDate(p.date) + (p.enRetard ? ' (en retard)' : '') : '—', p.technicienNom]));
    if (L.alertesStock && voir('stock')) html += table('Alertes de stock', ['Code', 'Désignation', 'Stock', 'Seuil', 'À commander', 'Fournisseur'], L.alertesStock.map((a) => [a.code, a.designation, nb(a.quantite), nb(a.seuilMin), nb(a.quantiteACommander), a.fournisseurNom]));
    if (L.equipementsArret && L.equipementsArret.length && voir('equipements')) html += table('Équipements à l\'arrêt', ['Numéro', 'Équipement', 'Secteur', 'Motif'], L.equipementsArret.map((x) => [x.numero, x.nom, x.secteurNom, x.motif]));
    ui.imprimer(`Tableau de bord du ${ui.formatDate(new Date())}`, html || '<p>Aucun indicateur disponible.</p>');
  }

  function majBadges(d) {
    const k = d.kpis;
    if ('otEnRetard' in k) GMAO.setNavBadge('ot', k.otEnRetard || 0);
    if ('demandesAValider' in k && d.droits.demandesValider) GMAO.setNavBadge('demandes', k.demandesAValider || 0);
    if ('preventifsEnRetard' in k) GMAO.setNavBadge('preventif', k.preventifsEnRetard || 0);
    if ('articlesSousSeuil' in k) GMAO.setNavBadge('stock', k.articlesSousSeuil || 0);
  }

  // ----- Assemblage ----------------------------------------------------------------------------
  function grille(cartes, colonnes) {
    const liste = cartes.filter(Boolean);
    if (!liste.length) return null;
    const n = colonnes || (liste.length === 3 || liste.length >= 5 ? 3 : 2);
    return el('div', { class: 'grille grille-' + Math.min(n, liste.length === 1 ? 1 : n), style: { marginBottom: '16px', alignItems: 'stretch' } }, liste);
  }

  function baseVide(d) {
    const g = d.graphiques || {};
    const aucunOt = !(g.otParStatut || []).some((s) => s.valeur);
    const sansDonnees = aucunOt && !d.kpis.demandesOuvertes && !d.kpis.articlesSousSeuil && !(d.listes.prochainsPreventifs || []).length;
    if (!sansDonnees || !Object.keys(d.kpis).length) return null;
    const demo = voir('systeme') && GMAO.can('systeme', 'modifier');
    return ui.alerte(frag(
      el('strong', null, 'Votre GMAO est prête. '),
      'Les indicateurs se rempliront au fil des demandes d\'intervention, des ordres de travail et des plans préventifs. ',
      voir('equipements') && GMAO.can('equipements', 'creer') ? frag('Commencez par ', el('a', { href: '#/equipements?nouveau=1' }, 'créer vos équipements'), '. ') : null,
      demo ? frag('Pour découvrir l\'application, vous pouvez aussi ', el('a', { href: '#/systeme' }, 'charger les données de démonstration'), '.') : null), 'info');
  }

  function construire(d) {
    const f = frag();
    const defs = indicateurs(d);
    f.appendChild(banniere(d));
    const info = baseVide(d);
    if (info) f.appendChild(info);
    const k = rangeeKpi(defs);
    if (k) f.appendChild(k);

    const L = d.listes || {};
    const otVisible = voir('ot') && 'mesOT' in L;
    const terrain = otVisible && (((d.compteurs || {}).mesOT || 0) > 0 || !GMAO.can('ot', 'affecter'));

    // Technicien : « Mes OT » en premier, sur toute la largeur
    if (terrain) f.appendChild(el('div', { style: { marginBottom: '16px' } }, carteMesOt(d)));

    if (voir('ot') && d.graphiques && d.graphiques.otParStatut) {
      f.appendChild(grille([carteStatuts(d), carteEvolution(d), carteTypes(d)], 3));
      f.appendChild(grille([carteSecteurs(d), carteTopEquipements(d), carteRepartition(d)], 3));
    }
    const listes = [
      otVisible && 'otEnRetard' in L ? carteOtRetard(d) : null,
      voir('demandes') && ('demandesAValider' in L) && (d.droits.demandesValider || (L.mesDemandes || []).length || GMAO.can('demandes', 'creer')) ? carteDemandes(d) : null,
      voir('preventif') && 'prochainsPreventifs' in L ? cartePreventifs(d) : null,
      voir('stock') && 'alertesStock' in L ? carteStock(d) : null,
      voir('equipements') && 'equipementsArret' in L ? carteEquipementsArret(d) : null,
    ].filter(Boolean);
    const g = grille(listes);
    if (g) f.appendChild(g);
    if ('dernieresActivites' in L) f.appendChild(carteActivites(d));
    if (!Object.keys(d.kpis).length && !listes.length && !('dernieresActivites' in L)) {
      const liens = GMAO.modules.filter((m) => m.key !== MODULE && GMAO.moduleVisible(m.key));
      f.appendChild(carte('Aucun indicateur disponible', frag(
        el('p', { class: 'texte-2' }, 'Votre profil ne donne accès à aucun module de maintenance suivi par le tableau de bord.'),
        liens.length ? el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, liens.map((m) => el('a', { href: '#/' + m.key, class: 'btn' }, icone((GMAO.vues[m.key] || {}).icone || m.icon || 'info'), m.label))) : null), { icone: 'info' }));
    }
    return f;
  }

  GMAO.registerView(MODULE, {
    titre: 'Tableau de bord', icone: 'dashboard',
    async rendu(container) {
      arreterMinuteur();
      let donnees = null;
      let defs = [];
      const infoMaj = el('span', { class: 'texte-2 texte-petit', style: { alignSelf: 'center' } });
      const btnActualiser = ui.bouton('Actualiser', { icone: 'rafraichir', titre: 'Recalculer les indicateurs', onClic: () => charger(true) });
      const btnExport = ui.bouton('Exporter CSV', { icone: 'export', titre: 'Exporter les indicateurs au format CSV', onClic: () => { if (donnees) exporter(donnees, defs); } });
      const btnImprimer = ui.bouton('Imprimer', { icone: 'imprimer', titre: 'Imprimer la synthèse', onClic: () => { if (donnees) imprimer(donnees, defs); } });
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'dashboard', sousTitre: 'Synthèse de la maintenance de votre périmètre', actions: [infoMaj, btnExport, btnImprimer, btnActualiser] }));
      const zone = el('div', { style: { transition: 'opacity 0.15s' } });
      container.appendChild(zone);

      async function charger(manuel) {
        btnActualiser.disabled = true;
        if (donnees) zone.style.opacity = '0.55';
        try {
          const d = await api.get('/api/dashboard');
          if (!container.isConnected) return;
          d.kpis = d.kpis || {}; d.graphiques = d.graphiques || {}; d.listes = d.listes || {}; d.compteurs = d.compteurs || {}; d.filtres = d.filtres || {}; d.droits = d.droits || {}; d.sources = d.sources || {};
          donnees = d;
          defs = indicateurs(d);
          btnExport.classList.toggle('masque', !defs.length);
          btnImprimer.classList.toggle('masque', !defs.length);
          ui.vider(zone);
          zone.appendChild(construire(d));
          majBadges(d);
          infoMaj.textContent = `Mis à jour à ${ui.formatHeure(new Date())}`;
          if (manuel) toast('Tableau de bord actualisé', 'succes');
        } catch (e) {
          if (!container.isConnected) return;
          if (!donnees) { ui.vider(zone); zone.appendChild(ui.alerte(frag(el('strong', null, 'Impossible de calculer le tableau de bord. '), e.message || String(e), ' ', el('button', { type: 'button', class: 'btn btn-sm', onclick: () => charger(true) }, 'Réessayer')), 'danger')); }
          if (manuel) erreur(e);
        } finally {
          btnActualiser.disabled = false;
          zone.style.opacity = '';
        }
      }

      await charger(false);
      minuteur = setInterval(() => {
        if (!container.isConnected || GMAO._vueCourante !== MODULE) { arreterMinuteur(); return; }
        if (document.hidden || document.querySelector('.modal-fond')) return;
        charger(false);
      }, ACTUALISATION_AUTO_MS);
    },
  });
})();
