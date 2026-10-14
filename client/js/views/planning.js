/**
 * Vue Planning : calendrier des interventions.
 *   - Vue Mois (grille lundi → dimanche), vue Semaine (7 colonnes détaillées), vue Par technicien
 *     (lignes = techniciens, colonnes = jours, dernière colonne = charge de la semaine).
 *   - OT colorés selon leur type d'intervention (bordure selon le statut), échéances préventives
 *     en pointillé (prévisionnel en italique), retards soulignés en rouge.
 *   - Glisser-déposer HTML5 des OT entre jours / techniciens et depuis le panneau « Non planifiés »
 *     (droit planning.modifier) ; génération de l'OT d'une échéance préventive.
 *   - Filtres secteur / technicien / type, impression et export CSV de la période.
 * Routes : #/planning, #/planning/AAAA-MM-JJ, #/planning?vue=semaine&date=AAAA-MM-JJ&secteurId=…&technicienId=…
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  const MODULE = 'planning';
  const JOURS_COURTS = ['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'];
  const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const VUES = [
    { cle: 'mois', label: 'Mois', icone: 'planning' },
    { cle: 'semaine', label: 'Semaine', icone: 'liste' },
    { cle: 'technicien', label: 'Par technicien', icone: 'utilisateurs' },
  ];
  const MAX_EVT_JOUR = 3;
  const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const FLEX = (extra) => Object.assign({ display: 'flex', alignItems: 'center', gap: '6px' }, extra || {});
  const ELLIPSE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const ROUGE = '#dc2626';

  // ----- Dates (chaînes « AAAA-MM-JJ », heure locale) ---------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  function versDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d, 12); }
  function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function ajouterJours(s, n) { const d = versDate(s); d.setDate(d.getDate() + n); return iso(d); }
  function premierDuMois(s) { return String(s).slice(0, 8) + '01'; }
  function ajouterMois(s, n) { const d = versDate(premierDuMois(s)); d.setMonth(d.getMonth() + n); return iso(d); }
  function dernierDuMois(s) { return ajouterJours(ajouterMois(s, 1), -1); }
  function jourSemaine(s) { return (versDate(s).getDay() + 6) % 7; }
  function lundi(s) { return ajouterJours(s, -jourSemaine(s)); }
  function numeroSemaine(s) {
    const d = versDate(s);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }
  function jourDe(v) { if (!v) return null; const s = String(v); if (RE_DATE.test(s)) return s; const d = new Date(s); return isNaN(d) ? null : iso(d); }
  function libelleJour(s, annee = true) { const d = versDate(s); return `${JOURS[jourSemaine(s)]} ${d.getDate()} ${MOIS[d.getMonth()]}${annee ? ' ' + d.getFullYear() : ''}`; }
  function jourCourt(s) { const d = versDate(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; }
  const majuscule = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  function libelleSemaine(du) {
    const au = ajouterJours(du, 6);
    const a = versDate(du); const b = versDate(au);
    let plage;
    if (a.getFullYear() !== b.getFullYear()) plage = `${a.getDate()} ${MOIS[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MOIS[b.getMonth()]} ${b.getFullYear()}`;
    else if (a.getMonth() !== b.getMonth()) plage = `${a.getDate()} ${MOIS[a.getMonth()]} – ${b.getDate()} ${MOIS[b.getMonth()]} ${b.getFullYear()}`;
    else plage = `${a.getDate()} – ${b.getDate()} ${MOIS[b.getMonth()]} ${b.getFullYear()}`;
    return `Semaine ${numeroSemaine(du)} · ${plage}`;
  }

  // ----- Utilitaires d'affichage ----------------------------------------------------------------------
  function teinte(couleur, alpha) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(couleur || '');
    if (!m) return 'var(--surface-2)';
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const duree = (h) => (h ? ui.formatDuree(h) : '0 h');
  const pluriel = (n, mot, motPluriel) => `${n} ${n > 1 ? (motPluriel || mot + 's') : mot}`;
  function couleurType(code, repli) { const it = ui.itemListe('typesIntervention', code); return (it && it.couleur) || repli || '#6b7280'; }
  function couleurStatut(code, repli) { const it = ui.itemListe('statutsOT', code); return (it && it.couleur) || repli || '#6b7280'; }
  function lireLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function ecrireLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  function kpi(opts) {
    const k = ui.kpi(opts);
    if (opts.couleur) k.style.setProperty('--kpi-couleur', opts.couleur);
    return k;
  }
  function petitBadge(noeud) { if (noeud && noeud.style) { noeud.style.fontSize = '10.5px'; noeud.style.padding = '0 6px'; } return noeud; }
  function infobulleOt(o) {
    return [
      `${o.numero} — ${o.titre}`,
      `${ui.libelle('statutsOT', o.statut) || o.statutLibelle} · ${ui.libelle('typesIntervention', o.typeCode) || o.typeLibelle}${o.prioriteCode ? ' · priorité ' + ui.libelle('priorites', o.prioriteCode).toLowerCase() : ''}`,
      o.datePrevue ? `Prévu le ${ui.formatDate(o.jour || o.datePrevue)}${o.heure ? ' à ' + o.heure : ''}${o.enRetard ? ' (en retard)' : ''}` : (o.jour ? 'En cours, sans date prévue' : 'Non planifié'),
      o.equipementNom ? `Équipement : ${o.equipementNom}` : null,
      `Responsable : ${o.technicienNom || 'non affecté'}${(o.techniciensNoms || []).length > 1 ? ' · intervenants : ' + o.techniciensNoms.join(', ') : ''}`,
      o.dureeEstimee ? `Durée estimée : ${ui.formatDuree(o.dureeEstimee)}` : null,
      o.deplacable ? 'Glisser-déposer pour replanifier · clic pour ouvrir' : 'Clic pour ouvrir l\'ordre de travail',
    ].filter(Boolean).join('\n');
  }
  function infobulleEcheance(e) {
    return [
      `${e.numero} — ${e.nom}`,
      `Échéance préventive ${e.projection ? 'prévisionnelle ' : ''}du ${ui.formatDate(e.date)}${e.estimee ? ' (estimée d\'après le compteur)' : ''}${e.enRetard ? ' — dépassée' : ''}`,
      e.periodiciteLibelle ? `Périodicité : ${e.periodiciteLibelle}` : null,
      e.equipementNom ? `Équipement : ${e.equipementNom}` : null,
      `Technicien : ${e.technicienNom || 'non désigné'}`,
      e.dureeEstimee ? `Durée estimée : ${ui.formatDuree(e.dureeEstimee)}` : null,
      'Clic pour le détail et la génération de l\'OT',
    ].filter(Boolean).join('\n');
  }

  // ----- Vue ----------------------------------------------------------------------------------------------
  async function rendrePlanning(container, params, query) {
    const aujourdhui = ui.aujourdhui();
    const vueMemo = lireLocal('gmao.planning.vue');
    const etat = {
      vue: VUES.some((v) => v.cle === query.vue) ? query.vue : (VUES.some((v) => v.cle === vueMemo) ? vueMemo : 'mois'),
      date: params[0] && RE_DATE.test(params[0]) ? params[0] : (RE_DATE.test(query.date || '') ? query.date : aujourdhui),
      secteurId: query.secteurId || '', technicienId: query.technicienId || '', typeCode: query.typeCode || '',
      echeances: lireLocal('gmao.planning.echeances') !== '0',
      projection: lireLocal('gmao.planning.projection') === '1',
      masquerClotures: lireLocal('gmao.planning.clotures') === '1',
      masquerVides: lireLocal('gmao.planning.vides') === '1',
      panneau: lireLocal('gmao.planning.panneau') !== '0',
      rechercheNP: '',
    };
    let donnees = null;
    let techniciens = [];
    let jeton = 0;
    let glisse = null; // { id, source } pendant un glisser-déposer

    const droits = () => (donnees && donnees.droits) || {};
    const peutModifier = () => GMAO.can(MODULE, 'modifier') && !!droits().modifier;
    const peutGenerer = () => GMAO.can(MODULE, 'modifier') && !!droits().generer;
    const peutCreerOt = () => GMAO.can('ot', 'creer');
    const echeancesVisibles = () => (etat.echeances && donnees ? donnees.echeances : []);

    // ----- Période ---------------------------------------------------------------------------------
    function bornes() {
      if (etat.vue === 'mois') {
        const mois = premierDuMois(etat.date);
        return { du: lundi(mois), au: ajouterJours(lundi(dernierDuMois(mois)), 6), mois };
      }
      const du = lundi(etat.date);
      return { du, au: ajouterJours(du, 6) };
    }
    function libellePeriode() {
      if (etat.vue === 'mois') { const d = versDate(etat.date); return majuscule(`${MOIS[d.getMonth()]} ${d.getFullYear()}`); }
      return libelleSemaine(lundi(etat.date));
    }
    function majHash() {
      const q = new URLSearchParams();
      q.set('vue', etat.vue); q.set('date', etat.date);
      if (etat.secteurId) q.set('secteurId', etat.secteurId);
      if (etat.technicienId) q.set('technicienId', etat.technicienId);
      if (etat.typeCode) q.set('typeCode', etat.typeCode);
      try { history.replaceState(null, '', '#/planning?' + q.toString()); } catch (e) { /* ignore */ }
    }
    function naviguer(sens) {
      etat.date = sens === 0 ? ui.aujourdhui() : (etat.vue === 'mois' ? ajouterMois(etat.date, sens) : ajouterJours(etat.date, 7 * sens));
      charger();
    }

    // ----- Barre d'outils --------------------------------------------------------------------------
    const titrePeriode = el('div', { style: { fontSize: '17px', fontWeight: 600, minWidth: '230px' } });
    const boutonsVue = {};
    const groupeVues = el('div', { class: 'btn-groupe', role: 'tablist', 'aria-label': 'Affichage' }, VUES.map((v) => {
      const b = el('button', { type: 'button', class: 'btn btn-sm', dataset: { vue: v.cle }, onclick: () => { if (etat.vue === v.cle) return; etat.vue = v.cle; ecrireLocal('gmao.planning.vue', v.cle); charger(); } }, icone(v.icone), v.label);
      boutonsVue[v.cle] = b;
      return b;
    }));
    const groupeNav = el('div', { class: 'btn-groupe' },
      el('button', { type: 'button', class: 'btn btn-sm', title: 'Période précédente (←)', 'aria-label': 'Période précédente', onclick: () => naviguer(-1) }, icone('fleche_gauche')),
      el('button', { type: 'button', class: 'btn btn-sm', title: 'Revenir à aujourd\'hui', onclick: () => naviguer(0) }, 'Aujourd\'hui'),
      el('button', { type: 'button', class: 'btn btn-sm', title: 'Période suivante (→)', 'aria-label': 'Période suivante', onclick: () => naviguer(1) }, icone('fleche_droite')));
    const inputDate = el('input', { type: 'date', title: 'Aller à la date…', style: { width: '150px' }, onchange: () => { if (RE_DATE.test(inputDate.value)) { etat.date = inputDate.value; charger(); } } });
    const selectSecteur = el('select', { title: 'Secteur', onchange: () => { etat.secteurId = selectSecteur.value; charger(); } },
      [{ value: '', label: 'Tous les secteurs' }, { value: 'aucun', label: 'Sans secteur' }].concat(ui.optionsSecteurs({ vide: false })).map((o) => el('option', { value: o.value, selected: String(o.value) === String(etat.secteurId) }, o.label)));
    const selectTechnicien = el('select', { title: 'Technicien', onchange: () => { etat.technicienId = selectTechnicien.value; charger(); } });
    const selectType = el('select', { title: 'Type d\'intervention', onchange: () => { etat.typeCode = selectType.value; charger(); } },
      [{ value: '', label: 'Tous les types' }].concat(ui.optionsListe('typesIntervention', { vide: false })).map((o) => el('option', { value: o.value, selected: o.value === etat.typeCode }, o.label)));
    function majOptionsTechniciens() {
      ui.vider(selectTechnicien);
      [{ value: '', label: 'Tous les techniciens' }, { value: 'aucun', label: 'Non affectés' }]
        .concat(techniciens.map((t) => ({ value: String(t.id), label: t.nomComplet + (t.fonction ? ` (${t.fonction})` : '') })))
        .forEach((o) => selectTechnicien.appendChild(el('option', { value: o.value, selected: o.value === String(etat.technicienId) }, o.label)));
      if (etat.technicienId && etat.technicienId !== 'aucun' && !techniciens.some((t) => String(t.id) === String(etat.technicienId))) {
        selectTechnicien.appendChild(el('option', { value: etat.technicienId, selected: true }, ui.nomUser(etat.technicienId)));
      }
    }
    const caseOption = (label, cle, memo, aide, apres) => {
      const cb = el('input', { type: 'checkbox', checked: etat[cle], onchange: () => { etat[cle] = cb.checked; ecrireLocal(memo, cb.checked ? '1' : '0'); if (apres) apres(); else charger(); } });
      return el('label', { class: 'inline', title: aide }, cb, label);
    };
    const optProjection = caseOption('Prévisionnel', 'projection', 'gmao.planning.projection', 'Projeter les échéances préventives suivantes selon la périodicité des plans');
    const optEcheances = caseOption('Échéances préventives', 'echeances', 'gmao.planning.echeances', 'Afficher les échéances des plans préventifs sans ordre de travail', () => { majOptions(); charger(); });
    const optClotures = caseOption('Masquer les OT clôturés', 'masquerClotures', 'gmao.planning.clotures', 'Masquer les ordres de travail terminés ou annulés');
    const optVides = caseOption('Masquer les techniciens sans intervention', 'masquerVides', 'gmao.planning.vides', 'Vue par technicien : n\'afficher que les lignes chargées', () => rendreCalendrier());
    function majOptions() {
      optProjection.classList.toggle('masque', !etat.echeances);
      optVides.classList.toggle('masque', etat.vue !== 'technicien');
    }
    const boutonPanneau = el('button', { type: 'button', class: 'btn btn-sm', title: 'Afficher / masquer les ordres de travail non planifiés', onclick: () => { etat.panneau = !etat.panneau; ecrireLocal('gmao.planning.panneau', etat.panneau ? '1' : '0'); rendrePanneau(); } });

    const legende = el('div', { class: 'texte-petit', style: FLEX({ flexWrap: 'wrap', gap: '4px 14px', color: 'var(--texte-2)' }) });
    function rendreLegende() {
      ui.vider(legende);
      legende.appendChild(el('span', { class: 'texte-gras' }, 'Légende :'));
      const types = donnees && donnees.legende && donnees.legende.length ? donnees.legende : ui.liste('typesIntervention');
      for (const t of types) legende.appendChild(el('span', { class: 'inline', style: { gap: '0' } }, el('span', { class: 'puce-couleur', style: { background: couleurType(t.code, t.couleur) } }), ui.libelle('typesIntervention', t.code) || t.label));
      const echantillon = (style, label) => el('span', { class: 'inline' }, el('span', { style: Object.assign({ display: 'inline-block', width: '22px', height: '12px', borderRadius: '3px' }, style) }), label);
      legende.appendChild(el('span', { style: { borderLeft: '1px solid var(--bordure-2)', height: '14px' } }));
      legende.appendChild(echantillon({ border: '1px dashed var(--texte-2)', background: 'var(--surface-2)' }, 'Échéance préventive'));
      if (etat.projection && etat.echeances) legende.appendChild(echantillon({ border: '1px dashed var(--texte-2)', opacity: 0.6 }, 'Prévisionnel'));
      legende.appendChild(echantillon({ background: '#9ca3af', boxShadow: `0 0 0 2px ${ROUGE}` }, 'En retard'));
      legende.appendChild(echantillon({ background: '#9ca3af', opacity: 0.45 }, 'Clôturé'));
      legende.appendChild(el('span', null, 'Bordure gauche = statut de l\'OT'));
    }

    [selectSecteur, selectTechnicien, selectType].forEach((s) => { s.style.maxWidth = '240px'; });
    const barre = el('div', { class: 'carte', style: { padding: '12px 14px' } },
      el('div', { class: 'barre-outils', style: { marginBottom: '10px' } }, groupeVues, groupeNav, titrePeriode, el('span', { class: 'espace' }), el('label', { class: 'inline texte-2 texte-petit' }, 'Aller au', inputDate)),
      el('div', { class: 'barre-outils', style: { marginBottom: '8px' } }, el('span', { class: 'texte-2', style: FLEX(), title: 'Filtres' }, icone('filtre')), selectSecteur, selectTechnicien, selectType, el('span', { class: 'espace' }), boutonPanneau),
      el('div', { class: 'barre-outils texte-petit', style: { marginBottom: 0, gap: '6px 18px' } }, optEcheances, optProjection, optClotures, optVides));

    const zoneKpis = el('div', { class: 'grille grille-4 mb' });
    const zoneAlerte = el('div');
    const zoneCal = el('div', { style: { flex: '1 1 640px', minWidth: 0, transition: 'opacity 0.15s' } });
    const panneau = el('div', { style: { flex: '0 1 300px', minWidth: '260px', position: 'sticky', top: 'calc(var(--entete-hauteur) + 12px)', alignSelf: 'flex-start' } });
    const principal = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } }, zoneCal, panneau);

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'planning',
      sousTitre: 'Calendrier des interventions, charge des techniciens et échéances préventives',
      actions: [
        ui.bouton('Imprimer', { icone: 'imprimer', onClic: imprimer }),
        ui.bouton('Exporter CSV', { icone: 'export', onClic: exporter }),
        peutCreerOt() ? ui.bouton('Nouvel OT', { icone: 'plus', classe: 'btn-primaire', onClic: () => nouvelOt(null) }) : null,
      ],
    }));
    container.appendChild(barre);
    container.appendChild(zoneAlerte);
    container.appendChild(zoneKpis);
    container.appendChild(principal);

    // ----- Glisser-déposer -----------------------------------------------------------------------------
    function rendreGlissable(noeud, o, source) {
      noeud.setAttribute('draggable', 'true');
      noeud.style.cursor = 'grab';
      noeud.addEventListener('dragstart', (ev) => {
        glisse = { id: o.id, source };
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'ot:' + o.id); } catch (e) { /* ignore */ }
        setTimeout(() => { noeud.style.opacity = '0.4'; }, 0);
      });
      noeud.addEventListener('dragend', () => { noeud.style.opacity = ''; glisse = null; nettoyerCibles(); });
    }
    function nettoyerCibles() { container.querySelectorAll('[data-cible]').forEach((n) => { n.style.outline = ''; n.style.boxShadow = ''; }); }
    function cibleDepot(noeud, onDepot) {
      noeud.setAttribute('data-cible', '1');
      noeud.addEventListener('dragover', (ev) => {
        if (!glisse) return;
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* ignore */ }
        noeud.style.outline = '2px dashed var(--primaire)';
        noeud.style.outlineOffset = '-3px';
      });
      noeud.addEventListener('dragleave', (ev) => { if (!noeud.contains(ev.relatedTarget)) noeud.style.outline = ''; });
      noeud.addEventListener('drop', (ev) => {
        ev.preventDefault();
        noeud.style.outline = '';
        const g = glisse;
        glisse = null;
        if (g) onDepot(g);
      });
    }
    function trouverOt(id) {
      if (!donnees) return null;
      return donnees.ot.find((o) => o.id === id) || donnees.nonPlanifies.find((o) => o.id === id) || donnees.enRetard.ot.find((o) => o.id === id) || null;
    }
    /** Replanifie un OT : jour (null = retirer du planning), technicienId (undefined = inchangé). */
    async function deplacer(g, jour, technicienId) {
      const o = trouverOt(g.id);
      if (!o) return;
      if (!o.deplacable) { toast(`L'OT ${o.numero} ne peut pas être replanifié`, 'alerte'); return; }
      const body = {};
      const jourActuel = jourDe(o.datePrevue);
      if (jour !== undefined && jour !== jourActuel) body.datePrevue = jour;
      if (technicienId !== undefined && technicienId !== o.technicienId) {
        // Depuis une ligne de technicien : seul un changement de ligne réaffecte ; depuis le panneau : la ligne cible fait foi
        const changeLigne = g.source === undefined ? true : technicienId !== g.source;
        if (changeLigne) body.technicienId = technicienId;
      }
      if (!Object.keys(body).length) return;
      try {
        const r = await api.put('/api/planning/ot/' + o.id, body);
        let msg;
        if (body.datePrevue === null) msg = `OT ${r.numero} retiré du planning`;
        else if (body.datePrevue) msg = `OT ${r.numero} planifié le ${libelleJour(body.datePrevue, false)}`;
        else msg = `OT ${r.numero}`;
        if (body.technicienId !== undefined) msg += body.technicienId == null ? ' — responsable retiré' : ` — confié à ${r.technicienNom || ui.nomUser(body.technicienId)}`;
        toast(msg, 'succes');
        await charger();
      } catch (e) { erreur(e); }
    }

    // ----- Éléments graphiques -----------------------------------------------------------------------------
    function evtOt(o, opts = {}) {
      const coul = couleurType(o.typeCode, o.couleur);
      const n = el('div', {
        class: 'cal-evt', title: infobulleOt(o), dataset: { ot: o.id },
        style: Object.assign({
          display: 'block', padding: '2px 5px', borderRadius: '4px', marginBottom: '2px', color: '#fff', fontSize: '11px', cursor: 'pointer', lineHeight: 1.45,
          background: coul, borderLeft: `4px solid ${couleurStatut(o.statut, o.couleurStatut)}`,
          opacity: o.final ? 0.5 : (opts.intervenant ? 0.7 : 1), textDecoration: o.annule ? 'line-through' : '',
          boxShadow: o.enRetard ? `0 0 0 2px ${ROUGE}` : '', outline: opts.intervenant ? '1px dotted rgba(255,255,255,0.9)' : '', outlineOffset: '-3px',
        }, ELLIPSE),
        onclick: (ev) => { ev.stopPropagation(); GMAO.navigate('#/ot/' + o.id); },
      }, o.sansDate ? el('span', { title: 'En cours, sans date prévue' }, icone('lecture'), ' ') : null, o.heure ? el('strong', null, o.heure + ' ') : null, opts.avecNumero ? el('strong', null, o.numero + ' ') : null, o.titre);
      if (opts.glissable) rendreGlissable(n, o, opts.source);
      return n;
    }
    function evtEcheance(e) {
      const coul = couleurType(e.typeCode, e.couleur);
      return el('div', {
        class: 'cal-evt cal-echeance', title: infobulleEcheance(e), dataset: { plan: e.planId },
        style: Object.assign({
          display: 'block', padding: '1px 5px', borderRadius: '4px', marginBottom: '2px', fontSize: '11px', cursor: 'pointer', lineHeight: 1.45,
          background: teinte(coul, e.projection ? 0.06 : 0.14), color: coul, border: `1px dashed ${coul}`, fontWeight: 600,
          opacity: e.projection ? 0.75 : 1, fontStyle: e.projection ? 'italic' : '', boxShadow: e.enRetard ? `0 0 0 2px ${ROUGE}` : '',
        }, ELLIPSE),
        onclick: (ev) => { ev.stopPropagation(); ouvrirEcheance(e); },
      }, icone('preventif'), ' ', e.nom);
    }
    function carteOt(o, opts = {}) {
      const coul = couleurType(o.typeCode, o.couleur);
      const c = el('div', {
        class: 'planning-carte', title: infobulleOt(o), dataset: { ot: o.id },
        style: {
          background: 'var(--surface)', border: '1px solid var(--bordure)', borderLeft: `4px solid ${coul}`, borderRadius: '6px', padding: '6px 8px', marginBottom: '6px',
          cursor: 'pointer', boxShadow: o.enRetard ? `0 0 0 1px ${ROUGE}, var(--ombre)` : 'var(--ombre)', opacity: o.final ? 0.6 : 1, fontSize: '12px', minWidth: 0,
        },
        onclick: () => GMAO.navigate('#/ot/' + o.id),
      },
      el('div', { style: FLEX({ justifyContent: 'space-between', gap: '4px', flexWrap: 'wrap' }) },
        el('span', { class: 'texte-2 texte-gras', style: Object.assign({ fontSize: '11px', minWidth: 0, flex: '1 1 auto' }, ELLIPSE) }, (o.heure ? o.heure + ' · ' : '') + o.numero),
        petitBadge(opts.priorite ? ui.badgeListe('priorites', o.prioriteCode) : ui.badgeListe('statutsOT', o.statut))),
      el('div', { style: { fontWeight: 600, margin: '2px 0', lineHeight: 1.3, textDecoration: o.annule ? 'line-through' : '', wordBreak: 'break-word' } }, o.titre),
      o.equipementNom ? el('div', { class: 'texte-2', style: ELLIPSE, title: o.equipementNom }, o.equipementNom) : (o.secteurNom ? el('div', { class: 'texte-2', style: ELLIPSE }, o.secteurNom) : null),
      el('div', { style: FLEX({ justifyContent: 'space-between', marginTop: '4px', gap: '2px 6px', flexWrap: 'wrap' }) },
        o.technicienId != null
          ? el('span', { class: 'inline', style: { gap: '4px', minWidth: 0, maxWidth: '100%' } }, ui.avatar(o.technicienNom || '?', 18), el('span', { style: ELLIPSE }, o.technicienNom), (o.techniciens || []).length > 1 ? el('span', { class: 'texte-2' }, `+${o.techniciens.length - 1}`) : null)
          : el('span', { class: 'texte-2' }, 'Non affecté'),
        el('span', { class: 'inline texte-2', style: { gap: '3px', whiteSpace: 'nowrap', marginLeft: 'auto' } },
          opts.afficherDate && o.datePrevue ? el('span', { class: o.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(o.jour || o.datePrevue)) : null,
          o.dureeEstimee ? frag(icone('horloge'), duree(o.dureeEstimee)) : null)));
      if (opts.glissable) rendreGlissable(c, o, opts.source);
      return c;
    }
    function carteEcheance(e, opts = {}) {
      const coul = couleurType(e.typeCode, e.couleur);
      return el('div', {
        class: 'planning-carte cal-echeance', title: infobulleEcheance(e), dataset: { plan: e.planId },
        style: {
          background: teinte(coul, e.projection ? 0.04 : 0.08), border: `1px dashed ${coul}`, borderRadius: '6px', padding: '6px 8px', marginBottom: '6px', cursor: 'pointer',
          fontSize: '12px', opacity: e.projection ? 0.8 : 1, boxShadow: e.enRetard ? `0 0 0 1px ${ROUGE}` : '', minWidth: 0,
        },
        onclick: () => ouvrirEcheance(e),
      },
      el('div', { style: FLEX({ justifyContent: 'space-between', gap: '4px' }) },
        el('span', { class: 'inline texte-gras', style: { color: coul, fontSize: '11px', gap: '4px' } }, icone('preventif'), e.numero),
        el('span', { class: 'texte-petit' + (e.enRetard ? ' texte-danger texte-gras' : ' texte-2'), style: { fontStyle: e.projection ? 'italic' : '', fontSize: '10.5px' } }, e.projection ? 'Prévisionnel' : (e.enRetard ? 'Dépassée' : 'À générer'))),
      el('div', { style: { fontWeight: 600, margin: '2px 0', lineHeight: 1.3, fontStyle: e.projection ? 'italic' : '' } }, e.nom),
      e.equipementNom ? el('div', { class: 'texte-2', style: ELLIPSE }, e.equipementNom) : null,
      el('div', { class: 'texte-2', style: FLEX({ justifyContent: 'space-between', marginTop: '4px', gap: '2px 6px', flexWrap: 'wrap' }) },
        el('span', { style: Object.assign({ minWidth: 0, maxWidth: '100%' }, ELLIPSE) }, e.technicienNom || 'Technicien non désigné'),
        el('span', { class: 'inline', style: { gap: '3px', whiteSpace: 'nowrap', marginLeft: 'auto' } },
          opts.afficherDate ? el('span', { class: e.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(e.date)) : null,
          e.dureeEstimee ? frag(icone('horloge'), duree(e.dureeEstimee)) : null)));
    }

    /** Éléments indexés par jour : { ot: [], ech: [] }. */
    function parJour() {
      const m = new Map();
      const cle = (j) => { if (!m.has(j)) m.set(j, { ot: [], ech: [] }); return m.get(j); };
      for (const o of donnees.ot) if (o.jour) cle(o.jour).ot.push(o);
      for (const e of echeancesVisibles()) cle(e.date).ech.push(e);
      return m;
    }
    const heuresDe = (ots) => ots.filter((o) => !o.annule).reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0);

    // ----- Vue Mois ---------------------------------------------------------------------------------------
    function rendreMois(zone) {
      const { du, au, mois } = bornes();
      const moisCourant = mois.slice(0, 7);
      const idx = parJour();
      const cal = el('div', { class: 'calendrier', role: 'region', 'aria-label': `Planning de ${libellePeriode()}` });
      JOURS_COURTS.forEach((j, i) => cal.appendChild(el('div', { class: 'cal-entete', title: majuscule(JOURS[i]) }, j)));
      for (let jour = du; jour <= au; jour = ajouterJours(jour, 1)) {
        const items = idx.get(jour) || { ot: [], ech: [] };
        const horsMois = jour.slice(0, 7) !== moisCourant;
        const weekEnd = jourSemaine(jour) >= 5;
        const cell = el('div', {
          class: 'cal-jour' + (horsMois ? ' hors-mois' : '') + (jour === donnees.aujourdhui ? ' aujourdhui' : ''), dataset: { jour },
          style: Object.assign({ minHeight: '112px', minWidth: 0 }, weekEnd && !horsMois ? { background: 'var(--surface-2)' } : {}),
          title: peutCreerOt() ? 'Double-clic : nouvel OT ce jour' : null,
        });
        const total = heuresDe(items.ot);
        cell.appendChild(el('div', { style: FLEX({ justifyContent: 'space-between', marginBottom: '2px' }) },
          el('span', { class: 'cal-num', style: { cursor: 'pointer', marginBottom: 0 }, title: `Détail du ${libelleJour(jour)}`, onclick: (ev) => { ev.stopPropagation(); ouvrirJour(jour); } }, String(versDate(jour).getDate())),
          total ? el('span', { class: 'texte-2', style: { fontSize: '10.5px', whiteSpace: 'nowrap' }, title: 'Durée estimée des OT du jour' }, duree(total)) : null));
        const tous = items.ot.map((o) => ({ k: 'ot', v: o })).concat(items.ech.map((e) => ({ k: 'ech', v: e })));
        const limite = tous.length > MAX_EVT_JOUR + 1 ? MAX_EVT_JOUR : tous.length;
        for (const it of tous.slice(0, limite)) cell.appendChild(it.k === 'ot' ? evtOt(it.v, { glissable: peutModifier() && it.v.deplacable }) : evtEcheance(it.v));
        if (tous.length > limite) {
          const reste = tous.length - limite;
          cell.appendChild(el('button', { type: 'button', class: 'btn btn-lien btn-sm cal-plus', style: { padding: '0 4px', fontSize: '11px' }, onclick: (ev) => { ev.stopPropagation(); ouvrirJour(jour); } }, `+${reste} autre${reste > 1 ? 's' : ''}`));
        }
        if (peutModifier()) cibleDepot(cell, (g) => deplacer(g, jour));
        if (peutCreerOt()) cell.addEventListener('dblclick', (ev) => { if (ev.target.closest('.cal-evt, button')) return; nouvelOt(jour); });
        cal.appendChild(cell);
      }
      zone.appendChild(cal);
    }

    // ----- Vue Semaine ------------------------------------------------------------------------------------
    function rendreSemaine(zone) {
      const { du } = bornes();
      const idx = parJour();
      const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(du, i));
      const cal = el('div', { class: 'calendrier', role: 'region', 'aria-label': `Planning de la ${libellePeriode()}` });
      jours.forEach((jour, i) => {
        const items = idx.get(jour) || { ot: [], ech: [] };
        const estAuj = jour === donnees.aujourdhui;
        const total = heuresDe(items.ot);
        cal.appendChild(el('div', { class: 'cal-entete', style: { textAlign: 'left', padding: '8px 10px', background: estAuj ? 'var(--primaire-clair)' : '' } },
          el('div', { style: FLEX({ justifyContent: 'space-between' }) },
            el('span', { style: { color: estAuj ? 'var(--primaire)' : 'var(--texte)', fontSize: '13px', cursor: 'pointer' }, title: `Détail du ${libelleJour(jour)}`, onclick: () => ouvrirJour(jour) }, `${JOURS_COURTS[i]} ${jourCourt(jour)}`),
            peutCreerOt() ? el('button', { type: 'button', class: 'btn btn-icone btn-sm', style: { padding: '1px' }, title: 'Nouvel OT ce jour', onclick: () => nouvelOt(jour) }, icone('plus')) : null),
          el('div', { style: { fontWeight: 400, fontSize: '11.5px' } },
            items.ot.length ? `${pluriel(items.ot.length, 'OT', 'OT')} · ${duree(total)}` : 'Aucun OT',
            items.ech.length ? ` · ${pluriel(items.ech.length, 'échéance')}` : '')));
      });
      jours.forEach((jour) => {
        const items = idx.get(jour) || { ot: [], ech: [] };
        const cell = el('div', {
          class: 'cal-jour' + (jour === donnees.aujourdhui ? ' aujourdhui' : ''), dataset: { jour },
          style: Object.assign({ minHeight: '380px', padding: '6px', minWidth: 0 }, jourSemaine(jour) >= 5 ? { background: 'var(--surface-2)' } : {}),
        });
        items.ot.forEach((o) => cell.appendChild(carteOt(o, { glissable: peutModifier() && o.deplacable })));
        items.ech.forEach((e) => cell.appendChild(carteEcheance(e)));
        if (!items.ot.length && !items.ech.length) cell.appendChild(el('div', { class: 'texte-2 texte-petit texte-centre', style: { paddingTop: '24px' } }, peutModifier() ? 'Déposez un OT ici' : '—'));
        if (peutModifier()) cibleDepot(cell, (g) => deplacer(g, jour));
        if (peutCreerOt()) cell.addEventListener('dblclick', (ev) => { if (ev.target.closest('.planning-carte, button')) return; nouvelOt(jour); });
        cal.appendChild(cell);
      });
      zone.appendChild(cal);
    }

    // ----- Vue Par technicien ----------------------------------------------------------------------------
    function lignesTechniciens() {
      const lignes = [];
      const vus = new Set();
      const filtreTech = etat.technicienId;
      if (filtreTech !== 'aucun') {
        for (const t of techniciens) {
          if (filtreTech && String(t.id) !== String(filtreTech)) continue;
          lignes.push({ userId: t.id, nom: t.nomComplet, fonction: t.fonction || t.profilNom || '' });
          vus.add(t.id);
        }
        // Intervenants hors liste (ex. hors de vos secteurs) présents dans la période
        for (const c of donnees.charge || []) {
          if (c.userId == null || vus.has(c.userId) || !(c.nbOt || c.nbEcheances)) continue;
          if (filtreTech && String(c.userId) !== String(filtreTech)) continue;
          lignes.push({ userId: c.userId, nom: c.nom || ui.nomUser(c.userId), fonction: '' });
          vus.add(c.userId);
        }
      }
      if (!filtreTech || filtreTech === 'aucun') lignes.push({ userId: null, nom: 'Non affecté', fonction: 'OT sans responsable' });
      return lignes;
    }
    function rendreTechniciens(zone) {
      const { du } = bornes();
      const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(du, i));
      const hpj = Number(donnees.heuresParJour) || 8;
      const capacite = hpj * 5;
      // Index utilisateur|jour → { ot: [{ o, responsable }], ech: [] }
      const cellules = new Map();
      const cle = (uid, jour) => { const k = `${uid == null ? 'aucun' : uid}|${jour}`; if (!cellules.has(k)) cellules.set(k, { ot: [], ech: [] }); return cellules.get(k); };
      for (const o of donnees.ot) {
        if (!o.jour) continue;
        const ids = Array.from(new Set([o.technicienId].concat(o.techniciens || []).filter((x) => x != null)));
        if (!ids.length) cle(null, o.jour).ot.push({ o, responsable: true });
        for (const uid of ids) cle(uid, o.jour).ot.push({ o, responsable: uid === o.technicienId || o.technicienId == null });
      }
      for (const e of echeancesVisibles()) cle(e.technicienId, e.date).ech.push(e);
      let lignes = lignesTechniciens();
      const aDesItems = (uid) => jours.some((j) => { const c = cellules.get(`${uid == null ? 'aucun' : uid}|${j}`); return c && (c.ot.length || c.ech.length); });
      if (etat.masquerVides) lignes = lignes.filter((l) => aDesItems(l.userId));
      if (!lignes.length) { zone.appendChild(ui.vide(etat.masquerVides ? 'Aucun technicien n\'a d\'intervention cette semaine' : 'Aucun technicien dans votre périmètre', 'utilisateurs')); return; }

      const thJour = (jour, i) => el('th', { style: { textAlign: 'center', background: jour === donnees.aujourdhui ? 'var(--primaire-clair)' : '', color: jour === donnees.aujourdhui ? 'var(--primaire)' : '' } },
        el('div', null, JOURS_COURTS[i]), el('div', { style: { fontWeight: 400, textTransform: 'none', letterSpacing: 0 } }, jourCourt(jour)));
      const thead = el('thead', null, el('tr', null,
        el('th', { style: { width: '180px' } }, 'Technicien'),
        jours.map(thJour),
        el('th', { style: { width: '180px' } }, `Charge (sur ${duree(capacite)})`)));
      const tbody = el('tbody');
      const chargeDe = (uid) => (donnees.charge || []).find((c) => (c.userId == null ? null : c.userId) === uid) || null;
      for (const l of lignes) {
        const tr = el('tr', { dataset: { technicien: l.userId == null ? 'aucun' : l.userId } });
        tr.appendChild(el('td', { style: { verticalAlign: 'top', background: 'var(--surface-2)' } },
          el('div', { class: 'inline', style: { minWidth: 0, width: '100%' } },
            l.userId != null ? ui.avatar(l.nom, 26) : el('span', { class: 'avatar', style: { width: '26px', height: '26px', background: 'var(--bordure-2)', color: 'var(--texte-2)' } }, '?'),
            el('div', { style: { minWidth: 0 } }, el('div', { class: 'texte-gras', style: ELLIPSE }, l.nom), l.fonction ? el('div', { class: 'texte-2 texte-petit', style: ELLIPSE }, l.fonction) : null))));
        let heuresSemaine = 0;
        jours.forEach((jour) => {
          const c = cellules.get(`${l.userId == null ? 'aucun' : l.userId}|${jour}`) || { ot: [], ech: [] };
          const h = heuresDe(c.ot.map((x) => x.o));
          heuresSemaine += h;
          const surcharge = l.userId != null && h > hpj;
          const td = el('td', {
            dataset: { jour }, style: {
              verticalAlign: 'top', padding: '4px', minWidth: 0, borderLeft: '1px solid var(--bordure)', height: '64px',
              background: surcharge ? teinte(ROUGE, 0.08) : (jourSemaine(jour) >= 5 ? 'var(--surface-2)' : ''),
            },
          });
          if (h) td.appendChild(el('div', { style: { textAlign: 'right', fontSize: '10.5px', color: surcharge ? 'var(--danger)' : 'var(--texte-2)', fontWeight: surcharge ? 600 : 400 }, title: surcharge ? `Surcharge : plus de ${duree(hpj)} prévues ce jour` : 'Durée estimée du jour' }, duree(h)));
          c.ot.forEach(({ o, responsable }) => td.appendChild(evtOt(o, { intervenant: !responsable, glissable: responsable && peutModifier() && o.deplacable, source: l.userId })));
          c.ech.forEach((e) => td.appendChild(evtEcheance(e)));
          if (peutModifier()) cibleDepot(td, (g) => deplacer(g, jour, l.userId));
          tr.appendChild(td);
        });
        const ch = chargeDe(l.userId);
        const h = ch ? Number(ch.heures) || 0 : heuresSemaine;
        const hPrev = ch ? Number(ch.heuresPreventif) || 0 : 0;
        const tdCharge = el('td', { style: { verticalAlign: 'top', borderLeft: '1px solid var(--bordure)' } });
        if (l.userId == null) {
          tdCharge.appendChild(el('div', { class: h ? 'texte-gras texte-alerte' : 'texte-2' }, h ? `${duree(h)} à affecter` : 'Rien à affecter'));
          if (hPrev) tdCharge.appendChild(el('div', { class: 'texte-2 texte-petit' }, `+ ${duree(hPrev)} d'échéances préventives`));
        } else {
          const pct = capacite ? Math.round((h / capacite) * 100) : 0;
          const coul = pct > 100 ? 'var(--danger)' : (pct >= 80 ? 'var(--alerte)' : 'var(--ok)');
          tdCharge.appendChild(el('div', { style: FLEX({ justifyContent: 'space-between' }) }, el('span', { class: 'texte-gras' }, `${duree(h)} / ${duree(capacite)}`), el('span', { class: pct > 100 ? 'texte-danger texte-gras' : 'texte-2' }, `${pct} %`)));
          tdCharge.appendChild(el('div', { class: 'barre-progression', style: { margin: '5px 0 3px' }, title: `Charge : ${pct} % de la capacité hebdomadaire (${duree(hpj)} × 5 jours)` }, el('div', { style: { width: Math.min(100, pct) + '%', background: coul } })));
          tdCharge.appendChild(el('div', { class: 'texte-2 texte-petit' }, ch && ch.nbOt ? pluriel(ch.nbOt, 'OT', 'OT') : 'Aucun OT', hPrev ? ` · + ${duree(hPrev)} préventif` : ''));
        }
        tr.appendChild(tdCharge);
        tbody.appendChild(tr);
      }
      // Totaux par jour (chaque OT compté une fois)
      const idx = parJour();
      const tfoot = el('tfoot', null, el('tr', null,
        el('td', { class: 'texte-gras', style: { background: 'var(--surface-2)' } }, 'Total'),
        jours.map((j) => { const it = idx.get(j) || { ot: [] }; const h = heuresDe(it.ot); return el('td', { class: 'texte-centre texte-petit', style: { borderLeft: '1px solid var(--bordure)', background: 'var(--surface-2)' } }, it.ot.length ? `${pluriel(it.ot.length, 'OT', 'OT')} · ${duree(h)}` : '—'); }),
        el('td', { class: 'texte-gras', style: { borderLeft: '1px solid var(--bordure)', background: 'var(--surface-2)' } }, duree(heuresDe(donnees.ot)))));
      zone.appendChild(el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact', style: { tableLayout: 'fixed', minWidth: '980px' } }, thead, tbody, tfoot)));
    }

    // ----- Panneau latéral « Non planifiés » ------------------------------------------------------------
    function dispositionPanneau() {
      const lateral = etat.vue === 'mois';
      zoneCal.style.flex = lateral ? '1 1 640px' : '1 1 100%';
      Object.assign(panneau.style, lateral
        ? { flex: '0 1 300px', minWidth: '260px', position: 'sticky', top: 'calc(var(--entete-hauteur) + 12px)' }
        : { flex: '1 1 100%', minWidth: '0', position: 'static', top: '' });
      return lateral;
    }
    function rendrePanneau() {
      const lateral = dispositionPanneau();
      ui.vider(panneau);
      const nb = donnees ? donnees.nonPlanifies.length : 0;
      ui.vider(boutonPanneau);
      boutonPanneau.appendChild(icone('horloge'));
      boutonPanneau.appendChild(document.createTextNode(` Non planifiés (${nb})`));
      boutonPanneau.classList.toggle('btn-primaire', !etat.panneau && nb > 0);
      panneau.classList.toggle('masque', !etat.panneau);
      if (!etat.panneau || !donnees) return;
      const modif = peutModifier();
      const grille = lateral ? {} : { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '0 10px' };
      const liste = el('div', { style: Object.assign({ minHeight: '60px', borderRadius: '6px', padding: '2px' }, grille) });
      const terme = etat.rechercheNP.trim().toLowerCase();
      const np = donnees.nonPlanifies.filter((o) => !terme || [o.numero, o.titre, o.equipementNom, o.technicienNom, o.secteurNom].some((v) => String(v || '').toLowerCase().includes(terme)));
      np.forEach((o) => liste.appendChild(carteOt(o, { glissable: modif && o.deplacable, priorite: true })));
      if (!np.length) liste.appendChild(el('div', { class: 'texte-2 texte-petit texte-centre', style: { padding: '16px 6px', gridColumn: '1 / -1' } }, terme ? 'Aucun résultat' : 'Tous les OT ouverts sont planifiés'));
      if (modif) cibleDepot(liste, (g) => deplacer(g, null));
      const recherche = nb > 4 ? el('input', { type: 'search', placeholder: 'Filtrer…', value: etat.rechercheNP, style: { marginBottom: '8px', maxWidth: lateral ? '' : '320px' }, oninput: ui.debounce(() => { etat.rechercheNP = recherche.value; rendrePanneau(); const r = panneau.querySelector('input[type=search]'); if (r) { r.focus(); r.setSelectionRange(r.value.length, r.value.length); } }, 250) }) : null;

      const carte = el('div', { class: 'carte', style: { padding: '12px', maxHeight: lateral ? 'calc(100vh - var(--entete-hauteur) - 40px)' : '', overflowY: lateral ? 'auto' : '', marginBottom: 0 } },
        el('div', { class: 'carte-titre', style: { marginBottom: '6px' } },
          el('h3', { class: 'inline' }, icone('horloge'), 'Non planifiés', el('span', { class: 'badge' }, String(nb))),
          el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Masquer le panneau', onclick: () => { etat.panneau = false; ecrireLocal('gmao.planning.panneau', '0'); rendrePanneau(); } }, icone('fermer'))),
        el('p', { class: 'texte-2 texte-petit' }, modif ? 'Glissez un OT sur un jour pour le planifier ; déposez ici un OT planifié pour le retirer du calendrier.' : 'Ordres de travail ouverts sans date prévue.'),
        recherche, liste);

      const retardOt = donnees.enRetard.ot;
      const retardEch = etat.echeances ? donnees.enRetard.echeances : [];
      if (retardOt.length) {
        carte.appendChild(el('h4', { class: 'inline texte-danger', style: { margin: '14px 0 6px', fontSize: '13px' } }, icone('alerte'), `À replanifier (${retardOt.length})`));
        carte.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'OT ouverts dont la date prévue est dépassée, antérieure à la période affichée.'));
        carte.appendChild(el('div', { style: grille }, retardOt.map((o) => carteOt(o, { glissable: modif && o.deplacable, afficherDate: true }))));
      }
      if (retardEch.length) {
        carte.appendChild(el('h4', { class: 'inline texte-danger', style: { margin: '14px 0 6px', fontSize: '13px' } }, icone('preventif'), `Échéances dépassées (${retardEch.length})`));
        carte.appendChild(el('div', { style: grille }, retardEch.map((e) => carteEcheance(e, { afficherDate: true }))));
      }
      panneau.appendChild(carte);
    }

    // ----- Indicateurs ------------------------------------------------------------------------------------
    function rendreKpis() {
      ui.vider(zoneKpis);
      const t = donnees.totaux || {};
      const ech = etat.echeances;
      zoneKpis.appendChild(kpi({ label: 'Interventions sur la période', valeur: t.nbOt || 0, icone: 'ot', couleur: '#2563eb', detail: `${duree(t.heures)} estimées · ${pluriel(t.nbOuverts || 0, 'ouverte')}` }));
      zoneKpis.appendChild(kpi({ label: 'Échéances préventives', valeur: ech ? (t.nbEcheances || 0) : '—', icone: 'preventif', couleur: '#8b5cf6', detail: ech ? `${duree(t.heuresEcheances)} à prévoir${etat.projection ? ' (prévisionnel inclus)' : ''}` : 'Affichage désactivé' }));
      zoneKpis.appendChild(kpi({ label: 'Non planifiés', valeur: t.nbNonPlanifies || 0, icone: 'horloge', couleur: '#f59e0b', detail: 'OT ouverts sans date prévue', onClic: () => { etat.panneau = true; ecrireLocal('gmao.planning.panneau', '1'); rendrePanneau(); panneau.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }));
      const retards = (t.nbEnRetard || 0) + (ech ? (t.nbEcheancesEnRetard || 0) : 0);
      zoneKpis.appendChild(kpi({ label: 'En retard', valeur: retards, icone: 'alerte', couleur: ROUGE, detail: `${pluriel(t.nbEnRetard || 0, 'OT', 'OT')}${ech ? ' · ' + pluriel(t.nbEcheancesEnRetard || 0, 'échéance') : ''}` }));
    }

    function rendreCalendrier() {
      ui.vider(zoneCal);
      if (!donnees) return;
      if (etat.vue === 'semaine') rendreSemaine(zoneCal);
      else if (etat.vue === 'technicien') rendreTechniciens(zoneCal);
      else rendreMois(zoneCal);
      const aides = [];
      if (peutModifier()) aides.push(etat.vue === 'technicien' ? 'Glissez un OT vers un autre jour ou un autre technicien pour le replanifier.' : 'Glissez un OT vers un autre jour pour le replanifier.');
      if (peutCreerOt() && etat.vue !== 'technicien') aides.push('Double-cliquez sur un jour pour créer un OT.');
      aides.push(peutGenerer() ? 'Cliquez sur une échéance préventive pour générer son ordre de travail.' : 'Cliquez sur une échéance préventive pour en voir le détail.');
      legende.style.marginTop = '10px';
      zoneCal.appendChild(legende);
      zoneCal.appendChild(el('div', { class: 'texte-2 texte-petit', style: FLEX({ alignItems: 'flex-start', marginTop: '6px' }) }, icone('info'), el('span', null, aides.join(' '))));
    }

    function rendreTout() {
      Object.entries(boutonsVue).forEach(([k, b]) => { b.classList.toggle('actif', k === etat.vue); b.setAttribute('aria-selected', k === etat.vue ? 'true' : 'false'); });
      titrePeriode.textContent = libellePeriode();
      inputDate.value = etat.date;
      majOptions();
      rendreLegende();
      ui.vider(zoneAlerte);
      if (donnees && !droits().voirOt) zoneAlerte.appendChild(ui.alerte('Vous n\'avez pas accès aux ordres de travail : seules les échéances préventives sont affichées.', 'info'));
      if (donnees) { rendreKpis(); rendreCalendrier(); }
      rendrePanneau();
    }

    async function charger() {
      const j = ++jeton;
      majHash();
      const { du, au } = bornes();
      titrePeriode.textContent = libellePeriode();
      Object.entries(boutonsVue).forEach(([k, b]) => b.classList.toggle('actif', k === etat.vue));
      majOptions();
      if (donnees) zoneCal.style.opacity = '0.55'; else { ui.vider(zoneCal); zoneCal.appendChild(ui.chargement('Chargement du planning…')); }
      try {
        const d = await api.get('/api/planning', {
          du, au, secteurId: etat.secteurId, technicienId: etat.technicienId, typeCode: etat.typeCode,
          projection: etat.echeances && etat.projection ? '1' : '', finaux: etat.masquerClotures ? '0' : '',
        });
        if (j !== jeton || !container.isConnected) return;
        donnees = d;
        rendreTout();
      } catch (e) {
        if (j !== jeton) return;
        erreur(e);
        if (!donnees) { ui.vider(zoneCal); zoneCal.appendChild(ui.alerte('Impossible de charger le planning : ' + (e.message || e), 'danger')); }
      } finally { if (j === jeton) zoneCal.style.opacity = ''; }
    }

    // ----- Modales ----------------------------------------------------------------------------------------
    function nouvelOt(jour) {
      const q = new URLSearchParams({ nouveau: '1' });
      if (jour) q.set('datePrevue', jour);
      if (etat.secteurId && etat.secteurId !== 'aucun') q.set('secteurId', etat.secteurId);
      GMAO.navigate('#/ot?' + q.toString());
    }

    function ouvrirJour(jour) {
      if (!donnees) return;
      const items = parJour().get(jour) || { ot: [], ech: [] };
      const total = heuresDe(items.ot);
      const contenu = el('div');
      contenu.appendChild(el('p', { class: 'texte-2' }, items.ot.length || items.ech.length
        ? `${pluriel(items.ot.length, 'ordre de travail', 'ordres de travail')} (${duree(total)} estimées)${items.ech.length ? ' · ' + pluriel(items.ech.length, 'échéance préventive', 'échéances préventives') : ''}`
        : 'Aucune intervention prévue ce jour.'));
      if (items.ot.length) {
        contenu.appendChild(el('div', { class: 'grille grille-2', style: { gap: '8px' } }, items.ot.map((o) => carteOt(o, {}))));
      }
      if (items.ech.length) {
        contenu.appendChild(el('h3', { class: 'mt' }, 'Échéances préventives'));
        contenu.appendChild(el('div', { class: 'grille grille-2', style: { gap: '8px' } }, items.ech.map((e) => carteEcheance(e))));
      }
      const m = ui.modal({
        titre: majuscule(libelleJour(jour)), taille: 'large', contenu,
        boutons: [
          etat.vue !== 'semaine' ? { label: 'Voir la semaine', icone: 'liste', gauche: true, onClic: () => { etat.vue = 'semaine'; etat.date = jour; ecrireLocal('gmao.planning.vue', 'semaine'); charger(); } } : null,
          peutCreerOt() ? { label: 'Nouvel OT ce jour', icone: 'plus', onClic: () => { nouvelOt(jour); } } : null,
          { label: 'Fermer', classe: 'btn-primaire' },
        ],
      });
      // Un clic sur une carte navigue : la modale se ferme d'elle-même au changement de vue
      m.corps.addEventListener('click', (ev) => { if (ev.target.closest('.cal-echeance')) m.fermer(); });
    }

    function ouvrirEcheance(e) {
      const generer = peutGenerer() && !e.projection && e.generable !== false;
      const jours = e.joursRestants;
      const proposee = e.date >= ui.aujourdhui() ? e.date : ui.aujourdhui();
      const f = generer ? ui.form({ colonnes: 1, champs: [{ nom: 'datePrevue', label: 'Date prévue de l\'ordre de travail', type: 'date', requis: true, valeur: proposee, aide: 'Par défaut : la date d\'échéance (ou aujourd\'hui si elle est dépassée).' }] }) : null;
      const contenu = frag(
        e.enRetard ? ui.alerte(`Échéance dépassée de ${pluriel(Math.abs(jours || 0), 'jour')} : aucun ordre de travail n'a encore été généré pour ce plan.`, 'alerte') : null,
        e.projection ? ui.alerte('Échéance prévisionnelle, calculée à partir de la périodicité du plan : l\'ordre de travail sera généré à l\'approche de l\'échéance, une fois la précédente réalisée.', 'info') : null,
        e.equipementActif === false ? ui.alerte('L\'équipement de ce plan est inactif : la génération est impossible.', 'alerte') : null,
        ui.details([
          { label: 'Plan préventif', valeur: `${e.numero} — ${e.nom}` },
          { label: 'Type', valeur: ui.badgeListe('typesIntervention', e.typeCode) },
          { label: 'Priorité', valeur: ui.badgeListe('priorites', e.prioriteCode) },
          { label: 'Échéance', valeur: frag(majuscule(libelleJour(e.date)), e.estimee ? el('span', { class: 'texte-2' }, ' (estimée d\'après le compteur)') : null, !e.projection && jours != null ? el('span', { class: jours < 0 ? 'texte-danger texte-gras' : 'texte-2' }, jours < 0 ? ` — dépassée de ${pluriel(-jours, 'jour')}` : (jours === 0 ? ' — aujourd\'hui' : ` — dans ${pluriel(jours, 'jour')}`)) : null) },
          { label: 'Périodicité', valeur: e.periodiciteLibelle || '—' },
          e.valeurCompteur != null ? { label: 'Seuil du compteur', valeur: `${ui.formatNombre(e.valeurCompteur)} ${e.uniteCompteur || ''}`.trim() } : null,
          { label: 'Équipement', valeur: e.equipementId != null && GMAO.can('equipements', 'voir') ? el('a', { href: '#/equipements/' + e.equipementId }, [e.equipementNumero, e.equipementNom].filter(Boolean).join(' — ')) : (e.equipementNom || '—') },
          { label: 'Secteur', valeur: e.secteurId != null ? ui.cheminSecteur(e.secteurId) : '—' },
          { label: 'Technicien', valeur: e.technicienNom || 'Non désigné' },
          { label: 'Durée estimée', valeur: e.dureeEstimee ? ui.formatDuree(e.dureeEstimee) : '—' },
          { label: 'Gamme', valeur: e.nbTaches ? pluriel(e.nbTaches, 'tâche') : '—' },
        ], { colonnes: 2 }),
        e.description ? el('p', { class: 'texte-2 mt' }, e.description) : null,
        f ? el('div', { class: 'mt' }, f.el) : null,
        !generer && !e.projection && GMAO.can(MODULE, 'modifier') ? el('p', { class: 'texte-2 texte-petit mt' }, !peutGenerer() ? 'La génération d\'un OT nécessite le droit de créer des ordres de travail et de consulter la maintenance préventive.' : (GMAO.siteLectureSeule && GMAO.siteLectureSeule(e.secteurId) ? 'Ce site est accessible en lecture seule : génération impossible.' : 'Génération impossible pour ce plan.')) : null);
      ui.modal({
        titre: 'Échéance préventive', taille: 'large', contenu,
        boutons: [
          GMAO.can('preventif', 'voir') ? { label: 'Voir le plan', icone: 'preventif', gauche: true, onClic: () => { GMAO.navigate('#/preventif/' + e.planId); } } : null,
          { label: 'Fermer' },
          generer ? { label: 'Générer l\'OT', icone: 'ot', classe: 'btn-primaire', onClic: async () => {
            if (!f.valider()) return false;
            const r = await api.post(`/api/planning/preventif/${e.planId}/generer`, { datePrevue: f.valeurs().datePrevue });
            toast(`Ordre de travail ${r.ot.numero} généré pour le ${ui.formatDate(r.ot.datePrevue)}`, 'succes');
            await charger();
            return true;
          } } : null,
        ],
      });
    }

    // ----- Export CSV et impression -----------------------------------------------------------------------
    function lignesExport() {
      const lignes = [];
      for (const o of donnees.ot) lignes.push({ nature: 'ot', date: o.jour, heure: o.heure, numero: o.numero, intitule: o.titre, typeCode: o.typeCode, prioriteCode: o.prioriteCode, statut: ui.libelle('statutsOT', o.statut) || o.statutLibelle, equipement: o.equipementNom, secteurId: o.secteurId, technicien: [o.technicienNom].concat((o.techniciensNoms || []).filter((n) => n !== o.technicienNom)).filter(Boolean).join(', '), duree: o.dureeEstimee, couleur: couleurType(o.typeCode, o.couleur), source: o });
      for (const e of echeancesVisibles()) lignes.push({ nature: 'echeance', date: e.date, heure: null, numero: e.numero, intitule: e.nom, typeCode: e.typeCode, prioriteCode: e.prioriteCode, statut: e.projection ? 'Prévisionnelle' : (e.enRetard ? 'Dépassée, OT à générer' : 'OT à générer'), equipement: e.equipementNom, secteurId: e.secteurId, technicien: e.technicienNom, duree: e.dureeEstimee, couleur: couleurType(e.typeCode, e.couleur), projection: e.projection, source: e });
      return lignes.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.heure || '').localeCompare(String(b.heure || '')) || (a.nature === b.nature ? 0 : a.nature === 'ot' ? -1 : 1));
    }
    function exporter() {
      if (!donnees) return;
      const lignes = lignesExport();
      if (!lignes.length) { toast('Aucun élément à exporter sur cette période', 'alerte'); return; }
      ui.exportCsv(`planning-${donnees.du}-au-${donnees.au}.csv`, [
        { label: 'Date', exportValeur: (l) => ui.formatDate(l.date) },
        { label: 'Heure', exportValeur: (l) => l.heure || '' },
        { label: 'Élément', exportValeur: (l) => (l.nature === 'ot' ? 'Ordre de travail' : 'Échéance préventive') },
        { label: 'Numéro', exportValeur: (l) => l.numero },
        { label: 'Intitulé', exportValeur: (l) => l.intitule },
        { label: 'Type d\'intervention', exportValeur: (l) => ui.libelle('typesIntervention', l.typeCode) },
        { label: 'Priorité', exportValeur: (l) => ui.libelle('priorites', l.prioriteCode) },
        { label: 'Statut', exportValeur: (l) => l.statut },
        { label: 'Équipement', exportValeur: (l) => l.equipement || '' },
        { label: 'Secteur', exportValeur: (l) => (l.secteurId != null ? ui.cheminSecteur(l.secteurId) : '') },
        { label: 'Technicien(s)', exportValeur: (l) => l.technicien || '' },
        { label: 'Durée estimée (h)', exportValeur: (l) => (l.duree == null ? '' : ui.formatNombre(l.duree, 2)) },
      ], lignes);
      toast(`${pluriel(lignes.length, 'élément exporté', 'éléments exportés')}`, 'succes');
    }

    function imprimer() {
      if (!donnees) return;
      const esc = ui.esc;
      const { du, au, mois } = bornes();
      const filtres = [
        etat.secteurId ? `Secteur : ${etat.secteurId === 'aucun' ? 'sans secteur' : ui.cheminSecteur(etat.secteurId)}` : null,
        etat.technicienId ? `Technicien : ${etat.technicienId === 'aucun' ? 'non affectés' : ui.nomUser(etat.technicienId)}` : null,
        etat.typeCode ? `Type : ${ui.libelle('typesIntervention', etat.typeCode)}` : null,
      ].filter(Boolean);
      const idx = parJour();
      const ligneItem = (it, detail) => {
        const ech = it.nature === 'echeance';
        const s = it.source;
        return `<div style="font-size:10.5px;margin:2px 0;padding-left:4px;border-left:3px ${ech ? 'dashed' : 'solid'} ${esc(it.couleur)};${s.final ? 'opacity:.6;' : ''}${ech && it.projection ? 'font-style:italic;' : ''}">`
          + `${it.heure ? '<b>' + esc(it.heure) + '</b> ' : ''}<b>${esc(it.numero)}</b> ${esc(it.intitule)}`
          + (detail ? `<br><span style="color:#555">${esc([it.equipement, it.technicien, it.duree ? ui.formatDuree(it.duree) : '', it.statut].filter(Boolean).join(' · '))}</span>` : '')
          + '</div>';
      };
      const itemsDuJour = (jour) => {
        const it = idx.get(jour) || { ot: [], ech: [] };
        return lignesExport().filter((l) => l.date === jour && (l.nature === 'ot' ? it.ot.includes(l.source) : it.ech.includes(l.source)));
      };
      let grille = '';
      if (etat.vue === 'mois') {
        grille += '<table><thead><tr>' + JOURS.map((j) => `<th style="width:14.28%">${esc(majuscule(j))}</th>`).join('') + '</tr></thead><tbody>';
        for (let jour = du; jour <= au; jour = ajouterJours(jour, 1)) {
          if (jourSemaine(jour) === 0) grille += '<tr>';
          const hors = jour.slice(0, 7) !== mois.slice(0, 7);
          grille += `<td style="height:70px;${hors ? 'background:#f3f4f6;color:#888;' : ''}"><div style="font-weight:700">${versDate(jour).getDate()}</div>${itemsDuJour(jour).map((l) => ligneItem(l, false)).join('')}</td>`;
          if (jourSemaine(jour) === 6) grille += '</tr>';
        }
        grille += '</tbody></table>';
      } else if (etat.vue === 'semaine') {
        const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(du, i));
        grille += '<table><thead><tr>' + jours.map((j, i) => `<th>${esc(JOURS_COURTS[i])} ${esc(jourCourt(j))}<br><span style="font-weight:400">${esc(duree(heuresDe((idx.get(j) || { ot: [] }).ot)))}</span></th>`).join('') + '</tr></thead><tbody><tr>';
        grille += jours.map((j) => `<td style="height:200px">${itemsDuJour(j).map((l) => ligneItem(l, true)).join('') || '&nbsp;'}</td>`).join('');
        grille += '</tr></tbody></table>';
      } else {
        const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(du, i));
        const capacite = (Number(donnees.heuresParJour) || 8) * 5;
        grille += '<table><thead><tr><th>Technicien</th>' + jours.map((j, i) => `<th>${esc(JOURS_COURTS[i])} ${esc(jourCourt(j))}</th>`).join('') + '<th>Charge</th></tr></thead><tbody>';
        for (const l of lignesTechniciens()) {
          const lignesTech = (jour) => lignesExport().filter((x) => x.date === jour && (x.nature === 'ot'
            ? (l.userId == null ? x.source.technicienId == null && !(x.source.techniciens || []).length : (x.source.technicienId === l.userId || (x.source.techniciens || []).includes(l.userId)))
            : (x.source.technicienId == null ? l.userId == null : x.source.technicienId === l.userId)));
          const cellules = jours.map((j) => lignesTech(j));
          if (etat.masquerVides && !cellules.some((c) => c.length)) continue;
          const ch = (donnees.charge || []).find((c) => (c.userId == null ? null : c.userId) === l.userId);
          const h = ch ? Number(ch.heures) || 0 : 0;
          grille += `<tr><td><b>${esc(l.nom)}</b></td>${cellules.map((c) => `<td>${c.map((x) => ligneItem(x, false)).join('') || '&nbsp;'}</td>`).join('')}<td>${esc(duree(h))}${l.userId != null ? ' / ' + esc(duree(capacite)) + ` (${capacite ? Math.round((h / capacite) * 100) : 0} %)` : ''}</td></tr>`;
        }
        grille += '</tbody></table>';
      }
      const lignes = lignesExport();
      const detail = lignes.length
        ? '<table><thead><tr><th>Date</th><th>Élément</th><th>Intitulé</th><th>Type</th><th>Statut</th><th>Équipement</th><th>Technicien(s)</th><th>Durée</th></tr></thead><tbody>'
          + lignes.map((l) => `<tr><td>${esc(ui.formatDate(l.date))}${l.heure ? ' ' + esc(l.heure) : ''}</td><td>${esc(l.numero)}${l.nature === 'echeance' ? '<br><i>échéance préventive</i>' : ''}</td><td>${esc(l.intitule)}</td><td>${esc(ui.libelle('typesIntervention', l.typeCode))}</td><td>${esc(l.statut)}</td><td>${esc(l.equipement || '')}</td><td>${esc(l.technicien || '')}</td><td>${esc(l.duree ? ui.formatDuree(l.duree) : '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p>Aucune intervention sur la période.</p>';
      const t = donnees.totaux || {};
      const html = `<h1>${esc(libellePeriode())}</h1>`
        + `<p>Du ${esc(ui.formatDate(du))} au ${esc(ui.formatDate(au))}${filtres.length ? ' · ' + esc(filtres.join(' · ')) : ''}<br>`
        + `${esc(pluriel(t.nbOt || 0, 'ordre de travail', 'ordres de travail'))} (${esc(duree(t.heures))} estimées)${etat.echeances ? ' · ' + esc(pluriel(t.nbEcheances || 0, 'échéance préventive', 'échéances préventives')) : ''} · ${esc(pluriel(t.nbNonPlanifies || 0, 'OT non planifié', 'OT non planifiés'))}</p>`
        + `<h2>${esc({ mois: 'Calendrier du mois', semaine: 'Calendrier de la semaine', technicien: 'Planning par technicien' }[etat.vue])}</h2>${grille}`
        + `<h2>Détail des interventions (${lignes.length})</h2>${detail}`;
      ui.imprimer(`Planning — ${libellePeriode()}`, html);
    }

    // ----- Raccourcis clavier (← / →) ------------------------------------------------------------------
    function surTouche(ev) {
      if (!container.isConnected) { document.removeEventListener('keydown', surTouche); return; }
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || document.querySelector('.modal-fond')) return;
      const t = ev.target;
      if (t && (/^(input|select|textarea|button)$/i.test(t.tagName || '') || t.isContentEditable)) return;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); naviguer(-1); } else if (ev.key === 'ArrowRight') { ev.preventDefault(); naviguer(1); }
    }
    document.addEventListener('keydown', surTouche);

    // ----- Chargement initial ----------------------------------------------------------------------------
    try { techniciens = await api.get('/api/planning-techniciens'); } catch (e) { techniciens = []; erreur(e); }
    majOptionsTechniciens();
    rendreLegende();
    rendrePanneau();
    await charger();
  }

  GMAO.registerView(MODULE, {
    titre: 'Planning', icone: 'planning',
    async rendu(container, { params, query }) { await rendrePlanning(container, params || [], query || {}); },
  });
})();
