/**
 * Vue Rapports & historique : indicateurs de maintenance sur une période (filtres période prédéfinie ou
 * personnalisée, secteur, technicien) répartis en onglets :
 *   Synthèse (KPI, OT par type / secteur, coûts par mois, répartition par statut),
 *   Équipements (fiabilité : pannes, heures d'arrêt, MTBF, MTTR, disponibilité, coûts ; clic → fiche de vie),
 *   Techniciens (OT réalisés, heures, taux d'occupation), Coûts (par mois, secteur, équipement, type),
 *   Stock (valeur, consommation), Historique (OT clôturés : recherche, tri, filtres) et
 *   Fiche de vie d'un équipement (#/rapports/:equipementId : chronologie, totaux, plans, compteur).
 * Chaque onglet propose l'export CSV (serveur, droit rapports.exporter, audité) et l'impression.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'rapports';
  const CLE_LOCALE = 'gmao.rapports.filtres';
  const C = { bleu: '#2563eb', vert: '#16a34a', orange: '#f59e0b', rouge: '#dc2626', violet: '#8b5cf6', cyan: '#0891b2', sarcelle: '#0f766e', gris: '#6b7280' };
  const can = (a) => GMAO.can(MODULE, a || 'voir');
  const esc = ui.esc;

  // ----- Préférences du poste (filtres mémorisés) -------------------------------------------------
  function lireLocal() { try { return JSON.parse(localStorage.getItem(CLE_LOCALE) || 'null'); } catch (e) { return null; } }
  function ecrireLocal(v) { try { localStorage.setItem(CLE_LOCALE, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }

  // ----- Périodes prédéfinies ----------------------------------------------------------------------
  const PERIODES = [
    ['mois', 'Mois en cours'], ['mois_prec', 'Mois précédent'], ['30j', '30 derniers jours'], ['trimestre', 'Trimestre en cours'],
    ['annee', 'Année en cours'], ['12m', '12 derniers mois'], ['annee_prec', 'Année précédente'], ['perso', 'Personnalisée'],
  ];
  function bornesPeriode(cle) {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth(); const iso = ui.dateISO; const auj = iso(d);
    switch (cle) {
      case 'mois': return { du: iso(new Date(y, m, 1)), au: auj };
      case 'mois_prec': return { du: iso(new Date(y, m - 1, 1)), au: iso(new Date(y, m, 0)) };
      case '30j': return { du: iso(new Date(y, m, d.getDate() - 29)), au: auj };
      case 'trimestre': return { du: iso(new Date(y, Math.floor(m / 3) * 3, 1)), au: auj };
      case '12m': return { du: iso(new Date(y - 1, m, d.getDate() + 1)), au: auj };
      case 'annee_prec': return { du: `${y - 1}-01-01`, au: `${y - 1}-12-31` };
      default: return { du: `${y}-01-01`, au: auj };
    }
  }

  // ----- Formats ----------------------------------------------------------------------------------
  const fmtPct = (v) => `${ui.formatNombre(v || 0, 1)} %`;
  const fmtH = (h) => (Number(h) > 0 ? ui.formatDuree(h) : '0 h');
  const fmtJ = (j) => `${ui.formatNombre(j || 0, 1)} j`;
  const pluriel = (n, s, p) => `${ui.formatNombre(n)} ${n > 1 ? (p || s + 's') : s}`;
  /** Contenu non sécable (montants, durées). */
  const nw = (contenu) => el('span', { style: { whiteSpace: 'nowrap' } }, contenu);
  const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  /** « 2026-03 » → « mars 26 » (libellé court des graphiques). */
  const moisCourt = (k) => { const [y, m] = String(k).split('-').map(Number); return `${MOIS_COURTS[m - 1] || k} ${String(y).slice(2)}`; };
  /** Montant compact pour les indicateurs (sans centimes au-delà de 1 000). */
  const montantKpi = (n) => (Math.abs(Number(n) || 0) >= 1000 ? `${ui.formatNombre(Math.round(Number(n)), 0)} ${((GMAO.config || {}).general || {}).devise || '€'}` : ui.formatMontant(n || 0));
  /** Quantité suivie de l'unité (code court : u, l, kg, m, lot…). */
  const quantiteUnite = (q, unite) => `${ui.formatNombre(q)}${unite ? ' ' + unite : ''}`;
  function ico(nom, px = 14) { const svg = icone(nom); Object.assign(svg.style, { width: px + 'px', height: px + 'px', flexShrink: '0' }); return svg; }
  function couleurTaux(v, seuils) { return v >= seuils[0] ? C.vert : v >= seuils[1] ? C.orange : C.rouge; }
  function barre(pct, couleur, largeur) {
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } },
      el('div', { class: 'barre-progression', style: { width: largeur || '70px', flexShrink: '0' } }, el('div', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%', background: couleur || 'var(--primaire)' } })),
      el('span', { class: 'texte-petit' }, fmtPct(pct)));
  }

  // ----- Composants ---------------------------------------------------------------------------------
  /** Grille d'indicateurs : 4 par ligne (8 indicateurs), 3 par ligne (5 à 6), largeur minimale pour les petits écrans. */
  function grilleKpi(items) {
    const k = items.filter(Boolean);
    const min = k.length >= 7 ? 240 : k.length >= 5 ? 300 : 220;
    return el('div', { class: 'grille', style: { gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '12px', marginBottom: '16px' } }, k.map((x) => ui.kpi(x)));
  }
  function barreOnglet(titre, sousTitre, actions) {
    return el('div', { class: 'barre-outils' },
      el('div', null, el('div', { class: 'texte-gras' }, titre), sousTitre ? el('div', { class: 'texte-2 texte-petit' }, sousTitre) : null),
      el('span', { class: 'espace' }), ...(actions || []).filter(Boolean));
  }
  function graphique(donnees, opts = {}) {
    const d = donnees.filter((x) => opts.zeros || x.valeur > 0);
    if (!d.length) return ui.vide(opts.vide || 'Aucune donnée sur la période', 'rapports');
    return ui.graphiqueBarres(d, { hauteur: opts.hauteur || 180 });
  }
  /** Lignes « libellé — barre — valeur » (répartition). */
  function repartition(items, opts = {}) {
    const total = items.reduce((s, x) => s + (Number(x.nb) || 0), 0);
    const lignes = items.filter((x) => opts.zeros || x.nb > 0);
    if (!total || !lignes.length) return ui.vide(opts.vide || 'Aucune donnée sur la période', 'rapports');
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, lignes.map((x) => {
      const p = total ? Math.round((x.nb / total) * 1000) / 10 : 0;
      return el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(110px, 1.2fr) 2fr minmax(86px, auto)', alignItems: 'center', gap: '10px' } },
        el('div', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.label || '' }, opts.badge ? opts.badge(x) : frag(ui.pastille(x.couleur || C.gris), ' ', x.label)),
        el('div', { class: 'barre-progression' }, el('div', { style: { width: p + '%', background: x.couleur || 'var(--primaire)' } })),
        el('div', { class: 'texte-petit', style: { textAlign: 'right', whiteSpace: 'nowrap' } }, el('span', { class: 'texte-gras' }, opts.valeur ? opts.valeur(x) : ui.formatNombre(x.nb)), ` · ${ui.formatNombre(p, 1)} %`));
    }));
  }
  function tableSimple(entetes, lignes, opts = {}) {
    if (!lignes.length) return ui.vide(opts.vide || 'Aucune donnée sur la période', 'rapports');
    return el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' },
      el('thead', null, el('tr', null, entetes.map((h) => el('th', { class: h.num ? 'num' : '' }, h.label || h)))),
      el('tbody', null, lignes.map((l) => el('tr', { class: l.onClic ? 'cliquable' : (l.total ? 'texte-gras' : ''), onclick: l.onClic || null }, l.cellules.map((c, i) => el('td', entetes[i] && entetes[i].num ? { class: 'num', style: { whiteSpace: 'nowrap' } } : null, c)))))));
  }
  function aide(texte) { return el('p', { class: 'texte-2 texte-petit', style: { margin: '0 0 12px' } }, ico('info', 13), ' ', texte); }

  // ----- Impression -----------------------------------------------------------------------------------
  const tableHtml = (entetes, lignes) => `<table><thead><tr>${entetes.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${lignes.length ? lignes.map((l) => `<tr>${l.map((c) => `<td>${c == null || c === '' ? '—' : esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${entetes.length}">Aucune donnée</td></tr>`}</tbody></table>`;
  const dlHtml = (items) => '<dl>' + items.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v == null || v === '' ? '—' : esc(v)}</dd>`).join('') + '</dl>';

  GMAO.registerView(MODULE, {
    titre: 'Rapports & historique', icone: 'rapports',
    async rendu(container, { params, query }) {
      const voirOt = GMAO.can('ot', 'voir');
      const voirDemandes = GMAO.can('demandes', 'voir');
      const voirStock = GMAO.can('stock', 'voir');
      const voirEquipements = GMAO.can('equipements', 'voir');

      // ----- État des filtres (mémorisé sur le poste) -----------------------------------------------------
      const memo = lireLocal() || {};
      const etat = { periode: PERIODES.some((p) => p[0] === memo.periode) ? memo.periode : 'annee', du: memo.du, au: memo.au, secteurId: memo.secteurId || '', technicienId: memo.technicienId || '', ficheId: memo.ficheId || '', ficheSous: !!memo.ficheSous, fichePeriode: !!memo.fichePeriode, ficheRecents: memo.ficheRecents !== false };
      const dateValide = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      if (etat.periode !== 'perso') Object.assign(etat, bornesPeriode(etat.periode));
      else if (!dateValide(etat.du) || !dateValide(etat.au) || etat.du > etat.au) Object.assign(etat, { periode: 'annee' }, bornesPeriode('annee'));
      if (params[0] && /^\d+$/.test(params[0])) etat.ficheId = String(params[0]);
      const memoriser = () => ecrireLocal({ periode: etat.periode, du: etat.du, au: etat.au, secteurId: etat.secteurId, technicienId: etat.technicienId, ficheId: etat.ficheId, ficheSous: etat.ficheSous, fichePeriode: etat.fichePeriode, ficheRecents: etat.ficheRecents });

      let refs = { equipements: [], techniciens: [] };
      try { refs = await api.get('/api/rapports/references'); } catch (e) { erreur(e); }
      if (etat.technicienId && !refs.techniciens.some((t) => String(t.id) === String(etat.technicienId))) etat.technicienId = '';
      if (etat.secteurId && !ui.secteur(etat.secteurId)) etat.secteurId = '';

      const filtresApi = (extra) => Object.assign({ du: etat.du, au: etat.au, secteurId: etat.secteurId, technicienId: etat.technicienId }, extra || {});
      const qs = (extra) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(filtresApi(extra))) if (v !== undefined && v !== null && v !== '') p.set(k, v); return p.toString(); };
      const libellePeriode = () => `Du ${ui.formatDate(etat.du)} au ${ui.formatDate(etat.au)}`;
      const libelleFiltres = () => [libellePeriode(), etat.secteurId ? `Secteur : ${ui.cheminSecteur(etat.secteurId)}` : null, etat.technicienId ? `Technicien : ${(refs.techniciens.find((t) => String(t.id) === String(etat.technicienId)) || {}).nom || ''}` : null].filter(Boolean).join(' · ');
      function exporter(type, extra) {
        api.telecharger('/api/rapports/export?' + qs(Object.assign({ type }, extra || {}))).then(() => toast('Export CSV généré', 'succes')).catch(erreur);
      }
      // Les exports qui reprennent le détail des OT (historique, fiche, équipements, techniciens, coûts) exigent aussi
      // Ordres de travail › Exporter, et l'export du stock Stock & pièces › Exporter (mêmes règles que le serveur)
      const peutExporterOt = () => can('exporter') && GMAO.can('ot', 'exporter');
      const peutExporterStock = () => can('exporter') && GMAO.can('stock', 'exporter');
      const ouvrirOt = (id) => { if (GMAO.can('ot', 'voir')) GMAO.navigate('#/ot/' + id); };

      // ----- Chargement des indicateurs -----------------------------------------------------------------
      let synthese = null;
      let enCours = null;
      let historique = { cle: null, lignes: null };
      let fiche = { cle: null, donnees: null };
      function charger() {
        synthese = null;
        historique = { cle: null, lignes: null };
        fiche = { cle: null, donnees: null };
        const p = api.get('/api/rapports/synthese', filtresApi());
        enCours = p;
        return p.then((s) => { if (enCours === p) { synthese = s; majSousTitre(); } return s; }).catch((e) => { if (enCours === p) erreur(e); return null; });
      }
      /** Rendu d'un onglet dépendant de la synthèse (attend le chargement en cours si nécessaire). */
      function avecSynthese(fn) {
        if (synthese) return fn(synthese);
        if (!enCours) return ui.vide('Indicateurs non chargés', 'rapports');
        return enCours.then((s) => (s ? fn(s) : ui.vide('Indicateurs indisponibles : vérifiez les filtres puis actualisez.', 'alerte')));
      }

      // ----- En-tête et filtres -----------------------------------------------------------------------------
      const entete = ui.pageEntete({
        titre: GMAO.moduleLabel(MODULE), icone: 'rapports', sousTitre: libelleFiltres(),
        actions: [ui.bouton('Actualiser', { icone: 'rafraichir', onClic: () => { charger(); onglets.activer(onglets.actif); } })],
      });
      function majSousTitre() { const s = entete.querySelector('.page-sous-titre'); if (s) s.textContent = libelleFiltres(); }
      container.appendChild(entete);

      const selPeriode = el('select', { title: 'Période analysée' }, PERIODES.map(([v, l]) => el('option', { value: v, selected: v === etat.periode }, l)));
      const inputDu = el('input', { type: 'date', value: etat.du, title: 'Du', max: etat.au, style: { width: '150px' } });
      const inputAu = el('input', { type: 'date', value: etat.au, title: 'Au', min: etat.du, style: { width: '150px' } });
      const selSecteur = el('select', { title: 'Secteur (sous-secteurs inclus)' }, ui.optionsSecteurs({ vide: 'Tous les secteurs' }).map((o) => el('option', { value: o.value, selected: String(o.value) === String(etat.secteurId) }, o.label)));
      const selTech = el('select', { title: 'Technicien' }, [el('option', { value: '' }, 'Tous les techniciens')].concat(refs.techniciens.map((t) => el('option', { value: t.id, selected: String(t.id) === String(etat.technicienId) }, t.nom + (t.actif === false ? ' (inactif)' : '')))));
      function appliquer() { memoriser(); majSousTitre(); charger(); onglets.activer(onglets.actif); }
      selPeriode.addEventListener('change', () => {
        etat.periode = selPeriode.value;
        if (etat.periode !== 'perso') { Object.assign(etat, bornesPeriode(etat.periode)); inputDu.value = etat.du; inputAu.value = etat.au; }
        inputDu.max = etat.au; inputAu.min = etat.du;
        if (etat.periode !== 'perso') appliquer(); else inputDu.focus();
      });
      const changerDate = () => {
        if (!inputDu.value || !inputAu.value) return;
        if (inputDu.value > inputAu.value) { toast('La date de début doit précéder la date de fin', 'alerte'); return; }
        etat.du = inputDu.value; etat.au = inputAu.value; etat.periode = 'perso'; selPeriode.value = 'perso';
        inputDu.max = etat.au; inputAu.min = etat.du;
        appliquer();
      };
      inputDu.addEventListener('change', changerDate);
      inputAu.addEventListener('change', changerDate);
      selSecteur.addEventListener('change', () => { etat.secteurId = selSecteur.value; appliquer(); });
      selTech.addEventListener('change', () => { etat.technicienId = selTech.value; appliquer(); });
      selSecteur.style.maxWidth = '210px';
      selTech.style.maxWidth = '220px';
      const groupe = (...enfants) => el('span', { class: 'inline', style: { gap: '8px', flexWrap: 'nowrap' } }, ...enfants);
      container.appendChild(el('div', { class: 'barre-outils carte', style: { padding: '10px 14px', columnGap: '18px' } },
        groupe(el('span', { class: 'inline texte-2' }, ico('filtre'), 'Période'), selPeriode),
        groupe(el('span', { class: 'texte-petit texte-2' }, 'du'), inputDu, el('span', { class: 'texte-petit texte-2' }, 'au'), inputAu),
        groupe(el('span', { class: 'inline texte-2' }, ico('secteur'), 'Secteur'), selSecteur),
        voirOt ? groupe(el('span', { class: 'inline texte-2' }, ico('utilisateur'), 'Technicien'), selTech) : null));
      if (!voirOt && !voirDemandes && !voirStock) container.appendChild(ui.alerte('Votre profil ne donne accès à aucune des données sources des rapports (ordres de travail, demandes, stock). Seule la fiche d\'identité des équipements est disponible.', 'info'));

      // ===== Onglet Synthèse ================================================================================
      function rendreSynthese(s) {
        const cont = el('div');
        cont.appendChild(barreOnglet('Synthèse de la période', libelleFiltres(), [
          can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('synthese') }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => imprimerSynthese(s) }),
        ]));
        const o = s.ot;
        const k = [];
        if (s.acces.ot) {
          k.push({ label: 'Ordres de travail créés', valeur: ui.formatNombre(o.total), icone: 'ot', couleur: C.bleu, detail: `${pluriel(o.termines, 'terminé')} · ${pluriel(o.ouverts, 'ouvert')}${o.enRetard ? ` (${o.enRetard} en retard)` : ''}`, onClic: () => onglets.activer('historique') });
          k.push({ label: 'MTTR (temps moyen de réparation)', valeur: o.nbCorrectifsTermines ? fmtH(o.mttrHeures) : '—', icone: 'horloge', couleur: C.orange, detail: o.nbCorrectifsTermines ? `sur ${pluriel(o.nbCorrectifsTermines, 'correctif terminé', 'correctifs terminés')}` : 'aucun correctif terminé' });
          k.push({ label: 'Respect des délais', valeur: o.nbEvaluesDelai ? fmtPct(o.respectDelais) : '—', icone: 'check', couleur: o.nbEvaluesDelai ? couleurTaux(o.respectDelais, [90, 70]) : C.gris, detail: o.nbEvaluesDelai ? `${o.nbDansDelai} / ${o.nbEvaluesDelai} OT dans le délai de leur priorité` : 'aucun OT terminé évaluable' });
          k.push({ label: 'Taux de préventif', valeur: o.termines ? fmtPct(o.tauxPreventif) : '—', icone: 'preventif', couleur: C.vert, detail: o.termines ? `${o.nbPreventifsTermines} préventif(s) sur ${pluriel(o.termines, 'OT terminé', 'OT terminés')}` : 'aucun OT terminé' });
          k.push({ label: 'Coût total de maintenance', valeur: montantKpi(s.couts.total), icone: 'euro', couleur: C.violet, detail: `MO ${montantKpi(s.couts.mainOeuvre)} · pièces ${montantKpi(s.couts.pieces)} · ext. ${montantKpi(s.couts.externe)}`, onClic: () => onglets.activer('couts') });
          k.push({ label: 'Pannes', valeur: ui.formatNombre(s.equipements.totalPannes), icone: 'alerte', couleur: s.equipements.totalPannes ? C.rouge : C.vert, detail: s.equipements.nbPannes.length ? `la plus fréquente : ${s.equipements.nbPannes[0].nom}` : 'aucune panne signalée', onClic: () => onglets.activer('equipements') });
          k.push({ label: 'Heures de main d\'œuvre', valeur: fmtH(o.heuresTotal), icone: 'utilisateur', couleur: C.sarcelle, detail: `${pluriel(o.parTechnicien.length, 'intervenant')} · durée moyenne ${fmtH(o.dureeMoyenneHeures)}`, onClic: () => onglets.activer('techniciens') });
        }
        if (s.acces.demandes) k.push({ label: 'Demandes d\'intervention', valeur: ui.formatNombre(s.demandes.total), icone: 'demandes', couleur: C.cyan, detail: s.demandes.nbDecidees ? `validation en ${fmtH(s.demandes.delaiMoyenValidationHeures)} · refus ${fmtPct(s.demandes.tauxRefus)}` : 'aucune demande traitée' });
        if (!k.length) { cont.appendChild(ui.vide('Aucun indicateur disponible avec vos droits', 'rapports')); return cont; }
        cont.appendChild(grilleKpi(k));
        if (s.acces.ot) {
          cont.appendChild(el('div', { class: 'grille grille-2', style: { marginBottom: '16px' } },
            ui.carte('OT par type d\'intervention', graphique(o.parType.map((x) => ({ label: x.label, valeur: x.nb, couleur: x.couleur || C.bleu })))),
            ui.carte('OT par secteur', graphique(o.parSecteur.map((x) => ({ label: x.nom, valeur: x.nb, couleur: x.couleur || C.bleu })), { vide: 'Aucun OT créé sur la période' }))));
          const cm = s.couts.parMois;
          cont.appendChild(el('div', { class: 'grille grille-2', style: { marginBottom: '16px' } },
            ui.carte('Coûts par mois', cm.some((m) => m.total > 0)
              ? frag(ui.graphiqueBarres(cm.map((m) => ({ label: moisCourt(m.mois), valeur: Math.round(m.total), couleur: C.violet })), { hauteur: 180 }), el('div', { class: 'texte-2 texte-petit' }, `Total ${ui.formatMontant(s.couts.total)} · moyenne ${ui.formatMontant(cm.length ? s.couts.total / cm.length : 0)} par mois`))
              : ui.vide('Aucun coût engagé sur la période', 'euro')),
            ui.carte('Répartition par statut', repartition(o.parStatut, { badge: (x) => ui.badgeListe('statutsOT', x.code), vide: 'Aucun OT créé sur la période' }))));
          cont.appendChild(el('div', { class: 'grille grille-2' },
            ui.carte('OT par priorité', repartition(o.parPriorite, { badge: (x) => frag(ui.badgeListe('priorites', x.code), x.delaiHeures ? el('span', { class: 'texte-2 texte-petit' }, ` délai ${fmtH(x.delaiHeures)}`) : null), vide: 'Aucun OT créé sur la période' })),
            s.acces.demandes ? ui.carte('Demandes par statut', repartition(s.demandes.parStatut, { badge: (x) => ui.badgeListe('statutsDemande', x.code), vide: 'Aucune demande sur la période' })) : el('div')));
          cont.appendChild(aide('Volumes : OT créés dans la période. Réalisation (MTTR, délais, taux de préventif) : OT terminés dans la période. Coûts : engagés dans la période (temps saisis, sorties de pièces, prestations à la date de fin).'));
        } else if (s.acces.demandes) {
          cont.appendChild(ui.carte('Demandes par statut', repartition(s.demandes.parStatut, { badge: (x) => ui.badgeListe('statutsDemande', x.code), vide: 'Aucune demande sur la période' })));
        }
        return cont;
      }
      function imprimerSynthese(s) {
        let html = `<h1>Synthèse de la maintenance</h1><div>${esc(libelleFiltres())}</div>`;
        if (s.acces.ot) {
          const o = s.ot;
          html += '<h2>Indicateurs clés</h2>' + dlHtml([
            ['OT créés', `${o.total} (${o.termines} terminé(s), ${o.ouverts} ouvert(s), ${o.annules} annulé(s))`], ['MTTR', o.nbCorrectifsTermines ? fmtH(o.mttrHeures) : '—'],
            ['Respect des délais', o.nbEvaluesDelai ? `${fmtPct(o.respectDelais)} (${o.nbDansDelai}/${o.nbEvaluesDelai})` : '—'], ['Taux de préventif', o.termines ? fmtPct(o.tauxPreventif) : '—'],
            ['Durée moyenne d\'intervention', fmtH(o.dureeMoyenneHeures)], ['Heures de main d\'œuvre', fmtH(o.heuresTotal)], ['Pannes', String(s.equipements.totalPannes)],
            ['Coût total', `${ui.formatMontant(s.couts.total)} (MO ${ui.formatMontant(s.couts.mainOeuvre)}, pièces ${ui.formatMontant(s.couts.pieces)}, externe ${ui.formatMontant(s.couts.externe)})`],
          ]);
          html += '<h2>OT par statut</h2>' + tableHtml(['Statut', 'Nombre'], o.parStatut.map((x) => [x.label, x.nb]));
          html += '<h2>OT par type</h2>' + tableHtml(['Type', 'Nombre'], o.parType.map((x) => [x.label, x.nb]));
          html += '<h2>OT par secteur</h2>' + tableHtml(['Secteur', 'Nombre'], o.parSecteur.map((x) => [x.chemin, x.nb]));
          html += '<h2>Coûts par mois</h2>' + tableHtml(['Mois', 'Pièces', 'Main d\'œuvre', 'Externe', 'Total'], s.couts.parMois.map((m) => [m.libelle, ui.formatMontant(m.pieces), ui.formatMontant(m.mainOeuvre), ui.formatMontant(m.externe), ui.formatMontant(m.total)]));
        }
        if (s.acces.demandes) html += '<h2>Demandes d\'intervention</h2>' + dlHtml([['Demandes déposées', String(s.demandes.total)], ['Délai moyen de validation', fmtH(s.demandes.delaiMoyenValidationHeures)], ['Taux de refus', fmtPct(s.demandes.tauxRefus)], ['Converties en OT', String(s.demandes.nbConverties)]]);
        if (s.acces.stock) html += '<h2>Stock</h2>' + dlHtml([['Valeur du stock', ui.formatMontant(s.stock.valeur)], ['Mouvements', String(s.stock.nbMouvements)], ['Montant consommé', ui.formatMontant(s.stock.montantConsomme)]]);
        ui.imprimer('Synthèse de la maintenance', html);
      }

      // ===== Onglet Équipements ==============================================================================
      function rendreEquipements(s) {
        const cont = el('div');
        const lignes = s.equipements.disponibilite;
        cont.appendChild(barreOnglet('Fiabilité des équipements', 'Pannes = OT correctifs créés dans la période (hors annulés) · arrêts, MTTR = correctifs terminés · MTBF = temps de bon fonctionnement / pannes', [
          peutExporterOt() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('equipements') }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => ui.imprimer('Fiabilité des équipements', `<h1>Fiabilité des équipements</h1><div>${esc(libelleFiltres())}</div>` + tableHtml(['N°', 'Équipement', 'Secteur', 'OT', 'Pannes', 'Heures d\'arrêt', 'MTBF', 'MTTR', 'Disponibilité', 'Coût'], lignes.map((x) => [x.numero, x.nom, x.secteurNom, x.nbOt, x.nbPannes, fmtH(x.heuresArret), x.nbPannes ? fmtJ(x.mtbfJours) : '—', x.nbReparations ? fmtH(x.mttrHeures) : '—', fmtPct(x.tauxDisponibilite), ui.formatMontant(x.cout)]))) }),
        ]));
        const totalArret = lignes.reduce((t, x) => t + x.heuresArret, 0);
        const avecPannes = lignes.filter((x) => x.nbPannes > 0);
        cont.appendChild(grilleKpi([
          { label: 'Équipements concernés', valeur: ui.formatNombre(lignes.length), icone: 'equipements', couleur: C.bleu, detail: 'au moins un OT ou un coût sur la période' },
          { label: 'Pannes', valeur: ui.formatNombre(s.equipements.totalPannes), icone: 'alerte', couleur: s.equipements.totalPannes ? C.rouge : C.vert, detail: `${pluriel(avecPannes.length, 'équipement')} en panne au moins une fois` },
          { label: 'Heures d\'arrêt', valeur: fmtH(totalArret), icone: 'horloge', couleur: C.orange, detail: 'réparations correctives terminées' },
          { label: 'MTTR global', valeur: s.ot.nbCorrectifsTermines ? fmtH(s.ot.mttrHeures) : '—', icone: 'ot', couleur: C.violet, detail: 'temps moyen de réparation' },
        ]));
        if (s.equipements.nbPannes.length) cont.appendChild(ui.carte('Top 10 des équipements les plus en panne', graphique(s.equipements.nbPannes.map((x) => ({ label: x.nom, valeur: x.nbPannes, couleur: C.rouge, onClic: () => ouvrirFiche(x.equipementId) }))), { classe: 'mb' }));
        const t = ui.table({
          colonnes: [
            { cle: 'nom', label: 'Équipement', rendu: (x) => el('div', null, el('div', { class: 'cellule-principale' }, x.nom), el('div', { class: 'cellule-secondaire', title: x.secteurNom }, [x.numero, x.secteurId != null ? ui.nomSecteur(x.secteurId) : ''].filter(Boolean).join(' · '))) },
            { cle: 'criticiteCode', label: 'Criticité', liste: 'criticites', aligner: 'centre' },
            { cle: 'nbOt', label: 'OT', aligner: 'droite', type: 'nombre' },
            { cle: 'nbPannes', label: 'Pannes', aligner: 'droite', rendu: (x) => (x.nbPannes ? el('span', { class: 'texte-gras texte-danger' }, String(x.nbPannes)) : '0') },
            { cle: 'heuresArret', label: 'Heures d\'arrêt', aligner: 'droite', rendu: (x) => nw(fmtH(x.heuresArret)) },
            { cle: 'mtbfJours', label: 'MTBF', aligner: 'droite', rendu: (x) => (x.nbPannes ? nw(fmtJ(x.mtbfJours)) : '—'), valeurTri: (x) => (x.nbPannes ? x.mtbfJours : 1e9) },
            { cle: 'mttrHeures', label: 'MTTR', aligner: 'droite', rendu: (x) => (x.nbReparations ? nw(fmtH(x.mttrHeures)) : '—'), valeurTri: (x) => (x.nbReparations ? x.mttrHeures : -1) },
            { cle: 'tauxDisponibilite', label: 'Disponibilité', rendu: (x) => barre(x.tauxDisponibilite, couleurTaux(x.tauxDisponibilite, [99, 95]), '56px') },
            { cle: 'cout', label: 'Coût', aligner: 'droite', rendu: (x) => nw(ui.formatMontant(x.cout)), exportValeur: (x) => x.cout },
          ],
          lignes, recherche: 'Rechercher un équipement…', vide: 'Aucun équipement concerné sur la période',
          onClic: (x) => ouvrirFiche(x.equipementId),
          actions: [{ icone: 'voir', titre: 'Fiche de vie', onClic: (x) => ouvrirFiche(x.equipementId) }],
        });
        cont.appendChild(t.el);
        return cont;
      }

      // ===== Onglet Techniciens ==============================================================================
      function rendreTechniciens(s) {
        const cont = el('div');
        const p = s.periode;
        const lignes = s.ot.parTechnicien;
        cont.appendChild(barreOnglet('Activité des techniciens', `Heures ouvrées : ${p.joursOuvres} jour(s) ouvré(s) × ${ui.formatNombre(p.heuresParJour)} h = ${fmtH(p.heuresOuvrees)} par technicien`, [
          peutExporterOt() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('techniciens') }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => ui.imprimer('Activité des techniciens', `<h1>Activité des techniciens</h1><div>${esc(libelleFiltres())}</div><p>Heures ouvrées par technicien : ${esc(fmtH(p.heuresOuvrees))} (${p.joursOuvres} jours ouvrés)</p>` + tableHtml(['Technicien', 'OT réalisés', 'OT affectés', 'Heures saisies', 'Taux d\'occupation'], lignes.map((x) => [x.nom, x.nb, x.nbAffectes, fmtH(x.heures), fmtPct(x.tauxOccupation)]))) }),
        ]));
        const heures = lignes.reduce((t, x) => t + x.heures, 0);
        const capacite = p.heuresOuvrees * lignes.length;
        cont.appendChild(grilleKpi([
          { label: 'Intervenants actifs', valeur: ui.formatNombre(lignes.length), icone: 'utilisateur', couleur: C.bleu, detail: 'ayant réalisé un OT ou saisi du temps' },
          { label: 'OT réalisés', valeur: ui.formatNombre(s.ot.termines), icone: 'check', couleur: C.vert, detail: 'terminés dans la période' },
          { label: 'Heures saisies', valeur: fmtH(heures), icone: 'horloge', couleur: C.sarcelle, detail: `coût main d'œuvre ${ui.formatMontant(s.couts.mainOeuvre)}` },
          { label: 'Taux d\'occupation moyen', valeur: capacite ? fmtPct((heures / capacite) * 100) : '—', icone: 'rapports', couleur: C.violet, detail: capacite ? `${fmtH(heures)} sur ${fmtH(capacite)} ouvrées` : 'aucun intervenant' },
        ]));
        if (lignes.length) cont.appendChild(ui.carte('Heures saisies par technicien', graphique(lignes.map((x) => ({ label: x.nom, valeur: x.heures, couleur: C.sarcelle })), { vide: 'Aucune heure saisie' }), { classe: 'mb' }));
        const t = ui.table({
          colonnes: [
            { cle: 'nom', label: 'Technicien', rendu: (x) => el('div', { class: 'inline' }, ui.avatar(x.nom, 26), el('span', { class: 'cellule-principale' }, x.nom)) },
            { cle: 'nb', label: 'OT réalisés', aligner: 'droite', type: 'nombre' },
            { cle: 'nbAffectes', label: 'OT affectés (créés)', aligner: 'droite', type: 'nombre' },
            { cle: 'heures', label: 'Heures saisies', aligner: 'droite', rendu: (x) => nw(fmtH(x.heures)) },
            { cle: 'heuresOuvrees', label: 'Heures ouvrées', aligner: 'droite', rendu: (x) => nw(fmtH(x.heuresOuvrees)) },
            { cle: 'tauxOccupation', label: 'Taux d\'occupation', rendu: (x) => barre(x.tauxOccupation, x.tauxOccupation > 100 ? C.rouge : x.tauxOccupation >= 60 ? C.vert : C.bleu, '90px') },
          ],
          lignes, recherche: false, pagination: false, vide: 'Aucune activité de technicien sur la période', triInitial: { cle: 'heures', sens: 'desc' },
          onClic: (x) => { etat.technicienId = String(x.userId); selTech.value = etat.technicienId; appliquer(); onglets.activer('historique'); },
        });
        cont.appendChild(t.el);
        cont.appendChild(aide('Cliquez sur un technicien pour filtrer les rapports sur son activité. OT réalisés : terminés dans la période (responsable, intervenant ou temps saisi).'));
        return cont;
      }

      // ===== Onglet Coûts ===================================================================================
      function rendreCouts(s) {
        const cont = el('div');
        const c = s.couts;
        const lignesMois = c.parMois.map((m) => ({ cellules: [m.libelle, ui.formatMontant(m.pieces), ui.formatMontant(m.mainOeuvre), ui.formatMontant(m.externe), el('span', { class: 'texte-gras' }, ui.formatMontant(m.total))] }));
        lignesMois.push({ total: true, cellules: ['Total', ui.formatMontant(c.pieces), ui.formatMontant(c.mainOeuvre), ui.formatMontant(c.externe), ui.formatMontant(c.total)] });
        const enteteMontants = [{ label: 'Pièces', num: true }, { label: 'Main d\'œuvre', num: true }, { label: 'Externe', num: true }, { label: 'Total', num: true }];
        cont.appendChild(barreOnglet('Coûts de maintenance', 'Coûts engagés dans la période : main d\'œuvre à la date des temps passés, pièces à la date de sortie, prestations à la date de fin', [
          peutExporterOt() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('couts') }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => ui.imprimer('Coûts de maintenance', `<h1>Coûts de maintenance</h1><div>${esc(libelleFiltres())}</div>`
            + '<h2>Par mois</h2>' + tableHtml(['Mois', 'Pièces', 'Main d\'œuvre', 'Externe', 'Total'], c.parMois.map((m) => [m.libelle, ui.formatMontant(m.pieces), ui.formatMontant(m.mainOeuvre), ui.formatMontant(m.externe), ui.formatMontant(m.total)]).concat([['Total', ui.formatMontant(c.pieces), ui.formatMontant(c.mainOeuvre), ui.formatMontant(c.externe), ui.formatMontant(c.total)]]))
            + '<h2>Par secteur</h2>' + tableHtml(['Secteur', 'OT', 'Pièces', 'Main d\'œuvre', 'Externe', 'Total'], c.parSecteur.map((x) => [x.chemin, x.nbOt, ui.formatMontant(x.pieces), ui.formatMontant(x.mainOeuvre), ui.formatMontant(x.externe), ui.formatMontant(x.total)]))
            + '<h2>Top 10 des équipements</h2>' + tableHtml(['Équipement', 'OT', 'Pièces', 'Main d\'œuvre', 'Externe', 'Total'], c.parEquipement.map((x) => [[x.numero, x.nom].filter(Boolean).join(' — '), x.nbOt, ui.formatMontant(x.pieces), ui.formatMontant(x.mainOeuvre), ui.formatMontant(x.externe), ui.formatMontant(x.total)]))
            + '<h2>Par type d\'intervention</h2>' + tableHtml(['Type', 'OT', 'Total'], c.parType.map((x) => [x.label, x.nbOt, ui.formatMontant(x.total)]))) }),
        ]));
        const part = (v) => (c.total > 0 ? ` · ${ui.formatNombre((v / c.total) * 100, 0)} %` : '');
        cont.appendChild(grilleKpi([
          { label: 'Coût total', valeur: montantKpi(c.total), icone: 'euro', couleur: C.violet, detail: `${pluriel(c.nbOt, 'OT concerné', 'OT concernés')}` },
          { label: 'Main d\'œuvre', valeur: montantKpi(c.mainOeuvre), icone: 'utilisateur', couleur: C.sarcelle, detail: `taux horaire ${ui.formatMontant(c.tauxHoraire)} / h${part(c.mainOeuvre)}` },
          { label: 'Pièces détachées', valeur: montantKpi(c.pieces), icone: 'piece', couleur: C.bleu, detail: `sorties de stock imputées${part(c.pieces)}` },
          { label: 'Prestations externes', valeur: montantKpi(c.externe), icone: 'fournisseurs', couleur: C.orange, detail: `sous-traitance${part(c.externe)}` },
        ]));
        cont.appendChild(ui.carte('Évolution mensuelle', c.parMois.some((m) => m.total > 0)
          ? frag(ui.graphiqueBarres(c.parMois.map((m) => ({ label: moisCourt(m.mois), valeur: Math.round(m.total), couleur: C.violet })), { hauteur: 190 }), tableSimple([{ label: 'Mois' }].concat(enteteMontants), lignesMois))
          : ui.vide('Aucun coût engagé sur la période', 'euro'), { classe: 'mb' }));
        cont.appendChild(el('div', { class: 'grille grille-2', style: { marginBottom: '16px' } },
          ui.carte('Par secteur', tableSimple([{ label: 'Secteur' }, { label: 'OT', num: true }].concat(enteteMontants), c.parSecteur.map((x) => ({ cellules: [el('span', { title: x.chemin }, ui.pastille(x.couleur || C.gris), ' ', x.nom), String(x.nbOt), ui.formatMontant(x.pieces), ui.formatMontant(x.mainOeuvre), ui.formatMontant(x.externe), el('span', { class: 'texte-gras' }, ui.formatMontant(x.total))] })))),
          ui.carte('Top 10 des équipements', tableSimple([{ label: 'Équipement' }, { label: 'OT', num: true }, { label: 'Total', num: true }], c.parEquipement.map((x) => ({ onClic: () => ouvrirFiche(x.equipementId), cellules: [el('div', null, el('div', { class: 'cellule-principale' }, x.nom), el('div', { class: 'cellule-secondaire' }, `${x.numero} · MO ${ui.formatMontant(x.mainOeuvre)} · pièces ${ui.formatMontant(x.pieces)} · ext. ${ui.formatMontant(x.externe)}`)), String(x.nbOt), el('span', { class: 'texte-gras' }, ui.formatMontant(x.total))] }))))));
        cont.appendChild(ui.carte('Par type d\'intervention', repartition(c.parType.map((x) => ({ code: x.code, label: x.label, couleur: x.couleur, nb: x.total })), { badge: (x) => ui.badgeListe('typesIntervention', x.code), valeur: (x) => ui.formatMontant(x.nb), vide: 'Aucun coût engagé sur la période' })));
        return cont;
      }

      // ===== Onglet Stock ===================================================================================
      function rendreStock(s) {
        const cont = el('div');
        const st = s.stock;
        cont.appendChild(barreOnglet('Stock et consommation de pièces', etat.secteurId || etat.technicienId ? 'Filtre actif : seules les sorties imputées aux OT filtrés sont prises en compte' : 'Valeur actuelle du stock · mouvements et consommation (sorties − retours) de la période', [
          peutExporterStock() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('stock') }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => ui.imprimer('Consommation de pièces', `<h1>Stock et consommation de pièces</h1><div>${esc(libelleFiltres())}</div>` + dlHtml([['Valeur du stock', ui.formatMontant(st.valeur)], ['Articles actifs', `${st.nbArticles} (dont ${st.nbSousSeuil} sous le seuil)`], ['Mouvements de la période', String(st.nbMouvements)], ['Montant consommé', ui.formatMontant(st.montantConsomme)]])
            + '<h2>Top 10 des consommations</h2>' + tableHtml(['Code', 'Désignation', 'Quantité', 'Sorties', 'Montant'], st.consommationTop10.map((x) => [x.code, x.designation, quantiteUnite(x.quantite, x.uniteCode), x.nbSorties, ui.formatMontant(x.montant)]))) }),
        ]));
        cont.appendChild(grilleKpi([
          { label: 'Valeur du stock', valeur: montantKpi(st.valeur), icone: 'stock', couleur: C.bleu, detail: `${pluriel(st.nbArticles, 'article actif', 'articles actifs')}`, onClic: GMAO.can('stock', 'voir') ? () => GMAO.navigate('#/stock') : null },
          { label: 'Sous le seuil minimum', valeur: ui.formatNombre(st.nbSousSeuil), icone: 'alerte', couleur: st.nbSousSeuil ? C.orange : C.vert, detail: 'articles à réapprovisionner' },
          { label: 'Mouvements', valeur: ui.formatNombre(st.nbMouvements), icone: 'liste', couleur: C.sarcelle, detail: `${pluriel(st.nbSorties, 'sortie')} sur la période` },
          { label: 'Montant consommé', valeur: montantKpi(st.montantConsomme), icone: 'euro', couleur: C.violet, detail: 'sorties − retours valorisés' },
        ]));
        const lignes = st.consommationTop10;
        cont.appendChild(el('div', { class: 'grille grille-2' },
          ui.carte('Top 10 des consommations (montant)', graphique(lignes.map((x) => ({ label: x.designation, valeur: Math.round(x.montant), couleur: C.bleu })), { vide: 'Aucune consommation sur la période' })),
          ui.carte('Détail', tableSimple([{ label: 'Article' }, { label: 'Quantité', num: true }, { label: 'Montant', num: true }, { label: 'Part', num: true }], lignes.map((x) => ({ cellules: [el('div', null, el('div', { class: 'cellule-principale' }, x.designation), el('div', { class: 'cellule-secondaire' }, `${x.code} · ${pluriel(x.nbSorties, 'sortie')}`)), quantiteUnite(x.quantite, x.uniteCode), ui.formatMontant(x.montant), st.montantConsomme > 0 ? fmtPct((x.montant / st.montantConsomme) * 100) : '—'] })), { vide: 'Aucune consommation sur la période' }))));
        return cont;
      }

      // ===== Onglet Historique =================================================================================
      const filtresHisto = { typeCode: '', statut: '', annules: true, recherche: '' };
      function rendreHistorique(cont) {
        const cle = qs();
        const finaux = (GMAO.liste('statutsOT') || []).filter((x) => x.final);
        const selType = el('select', { title: 'Type d\'intervention' }, ui.optionsListe('typesIntervention', { vide: 'Tous les types' }).map((o) => el('option', { value: o.value, selected: o.value === filtresHisto.typeCode }, o.label)));
        const selStatut = el('select', { title: 'Statut de clôture' }, [el('option', { value: '' }, 'Tous les statuts de clôture')].concat(finaux.map((x) => el('option', { value: x.code, selected: x.code === filtresHisto.statut }, x.label))));
        const cbAnnules = el('input', { type: 'checkbox', checked: filtresHisto.annules });
        const recherche = el('input', { type: 'search', placeholder: 'Rechercher (n°, équipement, technicien, cause, compte rendu…)', value: filtresHisto.recherche, style: { minWidth: '280px' } });
        const resume = el('div', { class: 'texte-2 texte-petit', style: { margin: '-4px 0 10px' } });
        const paramsExport = () => ({ typeCode: filtresHisto.typeCode, statut: filtresHisto.statut, annules: filtresHisto.annules ? '' : '0', recherche: filtresHisto.recherche });
        let affichees = [];
        cont.appendChild(barreOnglet('Historique des interventions', 'Ordres de travail clôturés (terminés ou annulés) dont la date de fin est dans la période', [
          peutExporterOt() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => exporter('historique', paramsExport()) }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => imprimerHistorique(affichees) }),
        ]));
        cont.appendChild(el('div', { class: 'barre-outils' }, recherche, selType, selStatut, el('label', { class: 'inline' }, cbAnnules, 'Inclure les annulés')));
        cont.appendChild(resume);
        const table = ui.table({
          colonnes: [
            { cle: 'numero', label: 'N°', rendu: (o) => el('span', { class: 'cellule-principale', style: { whiteSpace: 'nowrap' } }, o.numero) },
            { cle: 'titre', label: 'Intervention', rendu: (o) => el('div', { style: { minWidth: '230px' } }, el('div', null, o.titre), el('div', { class: 'cellule-secondaire' }, [o.equipementNumero, o.equipementNom, o.secteurNom].filter(Boolean).join(' · ') || 'Sans équipement')) },
            { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
            { cle: 'statut', label: 'Statut', liste: 'statutsOT' },
            { cle: 'technicienNom', label: 'Technicien', rendu: (o) => (o.technicienNom ? nw(o.technicienNom) : el('span', { class: 'texte-2' }, '—')) },
            { cle: 'dateFin', label: 'Fin', rendu: (o) => nw(ui.formatDate(o.dateFin)) },
            { cle: 'dureeHeures', label: 'Durée / temps', aligner: 'droite', rendu: (o) => el('div', { style: { whiteSpace: 'nowrap' } }, el('div', null, o.dureeHeures == null ? '—' : fmtH(o.dureeHeures)), el('div', { class: 'cellule-secondaire', title: 'Temps passé saisi' }, `${fmtH(o.heures)} saisies`)) },
            { cle: 'coutTotal', label: 'Coût', aligner: 'droite', rendu: (o) => nw(ui.formatMontant(o.coutTotal)) },
            { cle: 'causeLibelle', label: 'Cause', rendu: (o) => o.causeLibelle || el('span', { class: 'texte-2' }, '—') },
            { cle: 'dansDelai', label: 'Délai', aligner: 'centre', rendu: (o) => (o.dansDelai === true ? ui.badge('Respecté', C.vert) : o.dansDelai === false ? ui.badge('Dépassé', C.rouge) : el('span', { class: 'texte-2' }, '—')), valeurTri: (o) => (o.dansDelai === true ? 1 : o.dansDelai === false ? 0 : 2) },
          ],
          lignes: [], recherche: false, vide: 'Aucune intervention clôturée sur la période', triInitial: { cle: 'dateFin', sens: 'desc' },
          ligneClasse: (o) => (o.annule ? 'inactif' : ''),
          onClic: GMAO.can('ot', 'voir') ? (o) => ouvrirOt(o.id) : null,
        });
        cont.appendChild(table.el);
        const normaliser = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        function filtrer() {
          const termes = normaliser(filtresHisto.recherche).split(/\s+/).filter(Boolean);
          affichees = (historique.lignes || []).filter((o) => (!filtresHisto.typeCode || o.typeCode === filtresHisto.typeCode)
            && (!filtresHisto.statut || o.statut === filtresHisto.statut) && (filtresHisto.annules || !o.annule)
            && (!termes.length || termes.every((t) => normaliser([o.numero, o.titre, o.equipementNumero, o.equipementNom, o.secteurChemin, o.technicienNom, o.intervenants.join(' '), o.causeLibelle, o.rapport, o.demandeNumero, o.fournisseurNom, o.statutLibelle].join(' ')).includes(t))));
          table.maj(affichees);
          const termines = affichees.filter((o) => !o.annule);
          const evalues = termines.filter((o) => o.dansDelai !== null);
          ui.vider(resume).appendChild(frag(
            el('span', { class: 'texte-gras' }, pluriel(affichees.length, 'intervention')), ` · ${pluriel(termines.length, 'terminée')} · ${pluriel(affichees.length - termines.length, 'annulée')}`,
            ` · ${fmtH(affichees.reduce((t, o) => t + o.heures, 0))} de main d'œuvre · ${ui.formatMontant(affichees.reduce((t, o) => t + o.coutTotal, 0))}`,
            evalues.length ? ` · délais respectés : ${fmtPct((evalues.filter((o) => o.dansDelai).length / evalues.length) * 100)}` : ''));
        }
        recherche.addEventListener('input', ui.debounce(() => { filtresHisto.recherche = recherche.value.trim(); filtrer(); }, 200));
        selType.addEventListener('change', () => { filtresHisto.typeCode = selType.value; filtrer(); });
        selStatut.addEventListener('change', () => { filtresHisto.statut = selStatut.value; filtrer(); });
        cbAnnules.addEventListener('change', () => { filtresHisto.annules = cbAnnules.checked; filtrer(); });
        if (historique.cle === cle && historique.lignes) filtrer();
        else {
          resume.textContent = 'Chargement de l\'historique…';
          api.get('/api/rapports/historique', filtresApi()).then((rows) => { historique = { cle, lignes: rows }; if (cont.isConnected) filtrer(); }).catch((e) => { resume.textContent = ''; erreur(e); });
        }
      }
      function imprimerHistorique(lignes) {
        ui.imprimer('Historique des interventions', `<h1>Historique des interventions</h1><div>${esc(libelleFiltres())} · ${lignes.length} intervention(s)</div>`
          + tableHtml(['N°', 'Intervention', 'Équipement', 'Type', 'Statut', 'Technicien', 'Fin', 'Durée', 'Temps', 'Coût', 'Cause'], lignes.map((o) => [o.numero, o.titre, [o.equipementNumero, o.equipementNom].filter(Boolean).join(' — '), ui.libelle('typesIntervention', o.typeCode), o.statutLibelle, o.technicienNom, ui.formatDate(o.dateFin), o.dureeHeures == null ? '' : fmtH(o.dureeHeures), fmtH(o.heures), ui.formatMontant(o.coutTotal), o.causeLibelle])));
      }

      // ===== Onglet Fiche de vie ==================================================================================
      function ouvrirFiche(id) {
        etat.ficheId = String(id); memoriser();
        history.replaceState(null, '', '#/' + MODULE + '/' + id);
        onglets.activer('fiche');
      }
      function rendreFiche(cont) {
        const options = refs.equipements.map((e) => el('option', { value: e.id, selected: String(e.id) === String(etat.ficheId) }, `${e.numero ? e.numero + ' — ' : ''}${e.nom}${e.actif === false ? ' (inactif)' : ''}`));
        const selEq = el('select', { title: 'Équipement', style: { minWidth: '280px' } }, [el('option', { value: '' }, '— Choisir un équipement —')].concat(options));
        const cbSous = el('input', { type: 'checkbox', checked: etat.ficheSous });
        const selPortee = el('select', { title: 'Étendue' }, el('option', { value: 'vie', selected: !etat.fichePeriode }, 'Toute la durée de vie'), el('option', { value: 'periode', selected: etat.fichePeriode }, 'Période sélectionnée uniquement'));
        const zone = el('div');
        let donnees = null;
        const paramsFiche = () => Object.assign({ sousEquipements: etat.ficheSous ? '1' : '' }, etat.fichePeriode ? { du: etat.du, au: etat.au } : {});
        cont.appendChild(barreOnglet('Fiche de vie d\'un équipement', 'Chronologie complète des interventions, coûts cumulés, fiabilité, plans préventifs et compteur', [
          peutExporterOt() ? ui.bouton('Exporter CSV', { icone: 'export', onClic: () => { if (!etat.ficheId) return toast('Choisissez d\'abord un équipement', 'alerte'); api.telecharger('/api/rapports/export?' + new URLSearchParams(Object.entries(Object.assign({ type: 'fiche', equipementId: etat.ficheId }, paramsFiche())).filter(([, v]) => v !== '' && v != null)).toString()).then(() => toast('Export CSV généré', 'succes')).catch(erreur); } }) : null,
          ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => { if (!donnees) return toast('Choisissez d\'abord un équipement', 'alerte'); imprimerFiche(donnees); } }),
        ]));
        cont.appendChild(el('div', { class: 'barre-outils' }, el('span', { class: 'inline texte-2' }, ico('equipements'), 'Équipement'), selEq, selPortee, el('label', { class: 'inline' }, cbSous, 'Inclure les sous-équipements')));
        cont.appendChild(zone);
        function chargerFiche() {
          ui.vider(zone);
          donnees = null;
          if (!etat.ficheId) { zone.appendChild(ui.vide(refs.equipements.length ? 'Choisissez un équipement pour afficher sa fiche de vie, ou cliquez sur un équipement dans les onglets Équipements et Coûts.' : 'Aucun équipement accessible.', 'equipements')); return; }
          const cle = JSON.stringify([etat.ficheId, paramsFiche()]);
          const afficher = (f) => { donnees = f; ui.vider(zone); zone.appendChild(contenuFiche(f)); };
          if (fiche.cle === cle && fiche.donnees) return afficher(fiche.donnees);
          zone.appendChild(ui.chargement('Chargement de la fiche de vie…'));
          api.get(`/api/rapports/equipement/${etat.ficheId}`, paramsFiche()).then((f) => { fiche = { cle, donnees: f }; if (zone.isConnected) afficher(f); })
            .catch((e) => { ui.vider(zone); if (e.status === 404) { etat.ficheId = ''; memoriser(); zone.appendChild(ui.vide('Équipement introuvable ou hors de votre périmètre.', 'alerte')); } else erreur(e); });
        }
        selEq.addEventListener('change', () => { etat.ficheId = selEq.value; memoriser(); history.replaceState(null, '', '#/' + MODULE + (etat.ficheId ? '/' + etat.ficheId : '') + '?onglet=fiche'); chargerFiche(); });
        cbSous.addEventListener('change', () => { etat.ficheSous = cbSous.checked; memoriser(); chargerFiche(); });
        selPortee.addEventListener('change', () => { etat.fichePeriode = selPortee.value === 'periode'; memoriser(); chargerFiche(); });
        chargerFiche();
      }
      function contenuFiche(f) {
        const e = f.equipement;
        const t = f.totaux;
        const cont = el('div');
        const lienEq = voirEquipements ? el('a', { href: '#/equipements/' + e.id, class: 'texte-petit' }, 'Ouvrir la fiche équipement') : null;
        const compteur = e.compteur && e.compteur.unite ? `${ui.formatNombre(e.compteur.valeur)} ${e.compteur.unite}` : '';
        cont.appendChild(ui.carte(frag(e.numero ? `${e.numero} — ` : '', e.nom, e.actif === false ? ui.badge('Inactif', C.gris, { classe: 'mt' }) : null), frag(
          el('div', { class: 'texte-2 texte-petit mb' }, e.chemin || e.secteurChemin || 'Sans secteur', f.sousEquipementsInclus ? ' · sous-équipements inclus' : '', f.periode ? ` · du ${ui.formatDate(f.periode.du)} au ${ui.formatDate(f.periode.au)}` : ' · toute la durée de vie'),
          ui.details([
            { label: 'Type', valeur: ui.libelle('typesEquipement', e.typeCode) }, { label: 'État', valeur: ui.badgeListe('etatsEquipement', e.etatCode) },
            { label: 'Criticité', valeur: ui.badgeListe('criticites', e.criticiteCode) }, { label: 'Localisation', valeur: e.localisation },
            { label: 'Marque / modèle', valeur: [e.marque, e.modele].filter(Boolean).join(' ') }, { label: 'N° de série', valeur: e.numeroSerie },
            { label: 'Mise en service', valeur: ui.formatDate(e.dateMiseEnService) }, { label: 'Valeur d\'achat', valeur: e.valeurAchat != null ? ui.formatMontant(e.valeurAchat) : '' },
            { label: 'Fin de garantie', valeur: ui.formatDate(e.garantieFin) }, { label: 'Compteur', valeur: compteur },
            { label: 'Équipement parent', valeur: e.parent ? el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); ouvrirFiche(e.parent.id); } }, `${e.parent.numero} ${e.parent.nom}`.trim()) : '' },
            { label: 'Sous-équipements', valeur: e.sousEquipements.length ? frag(...e.sousEquipements.map((x, i) => frag(i ? ', ' : '', el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); ouvrirFiche(x.id); } }, x.nom)))) : '' },
          ], { colonnes: 2 })), { actions: lienEq ? [lienEq] : null, classe: 'mb' }));
        if (!f.acces.ot) { cont.appendChild(ui.alerte('Votre profil ne permet pas de consulter les ordres de travail : l\'historique des interventions n\'est pas affiché.', 'info')); return cont; }
        cont.appendChild(grilleKpi([
          { label: 'Interventions', valeur: ui.formatNombre(t.nbOt), icone: 'ot', couleur: C.bleu, detail: `${pluriel(t.nbTermines, 'terminée')} · ${pluriel(t.nbOuverts, 'en cours', 'en cours')} · ${pluriel(t.nbPreventifs, 'préventive')}` },
          { label: 'Pannes', valeur: ui.formatNombre(t.nbPannes), icone: 'alerte', couleur: t.nbPannes ? C.rouge : C.vert, detail: `${fmtH(t.heuresArret)} d'arrêt cumulées` },
          { label: 'MTBF', valeur: t.nbPannes ? fmtJ(t.mtbfJours) : '—', icone: 'horloge', couleur: C.vert, detail: t.nbPannes ? `sur ${ui.formatNombre(t.joursObserves, 0)} jours suivis` : 'aucune panne enregistrée' },
          { label: 'MTTR', valeur: t.mttrHeures ? fmtH(t.mttrHeures) : '—', icone: 'ot', couleur: C.orange, detail: 'temps moyen de réparation' },
          { label: 'Coût cumulé', valeur: montantKpi(t.coutTotal), icone: 'euro', couleur: C.violet, detail: t.valeurAchat ? `${fmtPct(t.ratioCoutValeur)} de la valeur d'achat` : `MO ${ui.formatMontant(t.coutMainOeuvre)} · pièces ${ui.formatMontant(t.coutPieces)}` },
          { label: 'Main d\'œuvre', valeur: fmtH(t.heures), icone: 'utilisateur', couleur: C.sarcelle, detail: t.derniereIntervention ? `dernière intervention le ${ui.formatDate(t.derniereIntervention)}` : 'aucune intervention terminée' },
        ]));
        // Chronologie
        const evenements = [];
        if (e.dateMiseEnService && !f.periode) evenements.push({ date: e.dateMiseEnService, rendu: () => frag(el('div', { class: 'texte-gras' }, 'Mise en service'), el('div', { class: 'chrono-date' }, ui.formatDate(e.dateMiseEnService))), couleur: C.vert });
        for (const h of f.etats) if (!f.periode || (ui.dateISO(h.date) >= f.periode.du && ui.dateISO(h.date) <= f.periode.au)) evenements.push({ date: h.date, couleur: ui.couleur('etatsEquipement', h.nouveau), rendu: () => frag(el('div', { class: 'inline', style: { flexWrap: 'wrap' } }, el('span', { class: 'texte-gras' }, 'Changement d\'état'), ui.badgeListe('etatsEquipement', h.ancien), '→', ui.badgeListe('etatsEquipement', h.nouveau)), el('div', { class: 'chrono-date' }, `${ui.formatDateHeure(h.date)}${h.userNom ? ' · ' + h.userNom : ''}`), h.commentaire ? el('div', { class: 'texte-2' }, h.commentaire) : null) });
        for (const o of f.ot) {
          evenements.push({ date: o.date, couleur: o.annule ? C.gris : ui.couleur('typesIntervention', o.typeCode), rendu: () => frag(
            el('div', { class: 'inline', style: { flexWrap: 'wrap' } },
              GMAO.can('ot', 'voir') ? el('a', { href: '#/ot/' + o.id, class: 'texte-gras' }, o.numero) : el('span', { class: 'texte-gras' }, o.numero),
              el('span', { class: 'texte-gras' }, o.titre), ui.badgeListe('typesIntervention', o.typeCode), ui.badgeListe('statutsOT', o.statut), o.estPanne ? ui.badge('Panne', C.rouge, { contour: true }) : null),
            el('div', { class: 'chrono-date' }, [ui.formatDateHeure(o.date), f.sousEquipementsInclus && o.equipementId !== e.id ? o.equipementNom : null, o.technicienNom, o.dureeHeures != null ? `durée ${fmtH(o.dureeHeures)}` : null, o.heures ? `${fmtH(o.heures)} saisies` : null, o.coutTotal ? ui.formatMontant(o.coutTotal) : null, o.causeLibelle ? `cause : ${o.causeLibelle}` : null].filter(Boolean).join(' · ')),
            o.rapport ? el('div', { class: 'texte-2', style: { whiteSpace: 'pre-wrap', marginTop: '2px' } }, o.rapport.length > 320 ? o.rapport.slice(0, 317) + '…' : o.rapport) : null,
            o.pieces.length ? el('div', { class: 'texte-petit texte-2' }, ico('piece', 12), ' ', o.pieces.map((p) => `${ui.formatNombre(p.quantite)} × ${p.designation}`).join(' ; ')) : null) });
        }
        const ordonner = () => evenements.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) * (etat.ficheRecents ? -1 : 1));
        const liste = el('div');
        const majChrono = () => {
          ui.vider(liste);
          if (!evenements.length) { liste.appendChild(ui.vide('Aucune intervention enregistrée pour cet équipement', 'horloge')); return; }
          liste.appendChild(el('ul', { class: 'chronologie' }, ordonner().map((x) => { const li = el('li', null, x.rendu()); li.style.setProperty('--primaire', x.couleur || C.bleu); return li; })));
        };
        /** Bouton de tri de la chronologie (se remplace lui-même à chaque bascule). */
        function boutonOrdre() {
          const b = ui.bouton(etat.ficheRecents ? 'Plus récents d\'abord' : 'Plus anciens d\'abord', { icone: etat.ficheRecents ? 'bas' : 'haut', classe: 'btn-sm', titre: 'Inverser l\'ordre chronologique', onClic: () => { etat.ficheRecents = !etat.ficheRecents; memoriser(); b.replaceWith(boutonOrdre()); majChrono(); } });
          return b;
        }
        majChrono();
        const droite = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
          ui.carte('Synthèse par année', tableSimple([{ label: 'Année' }, { label: 'OT', num: true }, { label: 'Pannes', num: true }, { label: 'Heures', num: true }, { label: 'Coût', num: true }], f.parAnnee.map((a) => ({ cellules: [a.annee, String(a.nbOt), String(a.nbPannes), fmtH(a.heures), ui.formatMontant(a.coutTotal)] })).concat(f.parAnnee.length > 1 ? [{ total: true, cellules: ['Total', String(t.nbOt), String(t.nbPannes), fmtH(t.heures), ui.formatMontant(t.coutTotal)] }] : []), { vide: 'Aucune intervention' })),
          ui.carte('Causes de panne', repartition(f.parCause.map((x) => ({ code: x.code, label: x.label, nb: x.nb, couleur: C.rouge })), { vide: 'Aucune panne enregistrée' })),
          f.acces.preventif ? ui.carte('Plans de maintenance préventive', tableSimple([{ label: 'Plan' }, { label: 'Périodicité' }, { label: 'Prochaine échéance' }], f.plans.map((p) => ({ onClic: GMAO.can('preventif', 'voir') ? () => GMAO.navigate('#/preventif/' + p.id) : null, cellules: [el('div', null, el('div', { class: 'cellule-principale' }, p.nom), el('div', { class: 'cellule-secondaire' }, [p.numero, p.technicienNom, p.actif ? null : 'inactif'].filter(Boolean).join(' · '))), p.periodiciteLibelle || '—', frag(echeance(p, e), ' ', etatPlan(p.etat))] })), { vide: 'Aucun plan préventif' })) : null,
          f.compteur.releves.length ? ui.carte(`Relevés de compteur (${f.compteur.unite})`, tableSimple([{ label: 'Date' }, { label: 'Valeur', num: true }, { label: 'Relevé par' }], f.compteur.releves.slice(0, 8).map((r) => ({ cellules: [ui.formatDateHeure(r.date), ui.formatNombre(r.valeur), r.userNom || '—'] })))) : null);
        cont.appendChild(el('div', { class: 'grille', style: { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: '16px', alignItems: 'start' } },
          ui.carte('Chronologie', liste, { actions: [boutonOrdre()] }), droite));
        return cont;
      }
      function echeance(p, e) {
        if (p.prochaineEcheance == null || p.prochaineEcheance === '') return '—';
        if (p.periodicite && p.periodicite.type === 'compteur') return `${ui.formatNombre(p.prochaineEcheance)} ${(e.compteur && e.compteur.unite) || ''}`;
        return ui.formatDate(p.prochaineEcheance);
      }
      function etatPlan(code) {
        const E = { a_jour: ['À jour', C.vert], proche: ['Échéance proche', C.orange], en_retard: ['En retard', C.rouge], inactif: ['Inactif', C.gris] };
        return code && E[code] ? ui.badge(E[code][0], E[code][1]) : null;
      }
      function imprimerFiche(f) {
        const e = f.equipement; const t = f.totaux;
        let html = `<h1>Fiche de vie — ${esc(e.numero)} ${esc(e.nom)}</h1><div>${esc(e.chemin || e.secteurChemin || '')}${f.periode ? esc(` · du ${ui.formatDate(f.periode.du)} au ${ui.formatDate(f.periode.au)}`) : ' · toute la durée de vie'}</div>`;
        html += '<h2>Identification</h2>' + dlHtml([['Type', ui.libelle('typesEquipement', e.typeCode)], ['État', ui.libelle('etatsEquipement', e.etatCode)], ['Criticité', ui.libelle('criticites', e.criticiteCode)], ['Localisation', e.localisation], ['Marque / modèle', [e.marque, e.modele].filter(Boolean).join(' ')], ['N° de série', e.numeroSerie], ['Mise en service', ui.formatDate(e.dateMiseEnService)], ['Valeur d\'achat', e.valeurAchat != null ? ui.formatMontant(e.valeurAchat) : ''], ['Compteur', e.compteur && e.compteur.unite ? `${ui.formatNombre(e.compteur.valeur)} ${e.compteur.unite}` : '']]);
        if (f.acces.ot) {
          html += '<h2>Indicateurs</h2>' + dlHtml([['Interventions', `${t.nbOt} (${t.nbTermines} terminée(s), ${t.nbOuverts} en cours, ${t.nbAnnules} annulée(s))`], ['Pannes', `${t.nbPannes} — ${fmtH(t.heuresArret)} d'arrêt`], ['MTBF', t.nbPannes ? fmtJ(t.mtbfJours) : '—'], ['MTTR', t.mttrHeures ? fmtH(t.mttrHeures) : '—'], ['Main d\'œuvre', fmtH(t.heures)], ['Coût cumulé', `${ui.formatMontant(t.coutTotal)} (MO ${ui.formatMontant(t.coutMainOeuvre)}, pièces ${ui.formatMontant(t.coutPieces)}, externe ${ui.formatMontant(t.coutExterne)})`]]);
          html += '<h2>Interventions</h2>' + tableHtml(['Date', 'N°', 'Intervention', 'Type', 'Statut', 'Technicien', 'Durée', 'Coût', 'Compte rendu'], f.ot.map((o) => [ui.formatDate(o.date), o.numero, o.titre, ui.libelle('typesIntervention', o.typeCode), o.statutLibelle, o.technicienNom, o.dureeHeures == null ? '' : fmtH(o.dureeHeures), ui.formatMontant(o.coutTotal), o.rapport]));
          if (f.parAnnee.length) html += '<h2>Synthèse par année</h2>' + tableHtml(['Année', 'OT', 'Pannes', 'Heures', 'Coût'], f.parAnnee.map((a) => [a.annee, a.nbOt, a.nbPannes, fmtH(a.heures), ui.formatMontant(a.coutTotal)]));
        }
        if (f.plans.length) html += '<h2>Plans préventifs</h2>' + tableHtml(['N°', 'Plan', 'Périodicité', 'Prochaine échéance'], f.plans.map((p) => [p.numero, p.nom, p.periodiciteLibelle, echeance(p, e)]));
        html += '<div class="signature"><div>Responsable maintenance</div><div>Date / visa</div></div>';
        ui.imprimer(`Fiche de vie ${e.numero || e.nom}`, html);
      }

      // ----- Onglets ------------------------------------------------------------------------------------------------
      const sansOt = () => ui.alerte('Votre profil ne permet pas de consulter les ordres de travail : cet onglet n\'est pas disponible.', 'info');
      const items = [
        { cle: 'synthese', label: 'Synthèse', icone: 'dashboard', rendu: () => avecSynthese(rendreSynthese) },
        voirOt ? { cle: 'equipements', label: 'Équipements', icone: 'equipements', rendu: () => avecSynthese((s) => (s.acces.ot ? rendreEquipements(s) : sansOt())) } : null,
        voirOt ? { cle: 'techniciens', label: 'Techniciens', icone: 'utilisateur', rendu: () => avecSynthese((s) => (s.acces.ot ? rendreTechniciens(s) : sansOt())) } : null,
        voirOt ? { cle: 'couts', label: 'Coûts', icone: 'euro', rendu: () => avecSynthese((s) => (s.acces.ot ? rendreCouts(s) : sansOt())) } : null,
        voirStock ? { cle: 'stock', label: 'Stock', icone: 'stock', rendu: () => avecSynthese((s) => (s.acces.stock ? rendreStock(s) : ui.alerte('Accès au stock non autorisé.', 'info'))) } : null,
        voirOt ? { cle: 'historique', label: 'Historique', icone: 'liste', rendu: (c) => { rendreHistorique(c); } } : null,
        { cle: 'fiche', label: 'Fiche de vie', icone: 'dossier', rendu: (c) => { rendreFiche(c); } },
      ].filter(Boolean);
      charger();
      // #/rapports/:equipementId ouvre directement la fiche de vie (sauf onglet explicitement demandé)
      const onglets = ui.onglets(items, { hash: true, actif: params[0] && !query.onglet ? 'fiche' : undefined });
      container.appendChild(onglets.el);
    },
  });
})();
