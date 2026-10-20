/**
 * Vue Ordres de travail (OT) : liste par onglets (tous, mes OT, en cours, en retard, terminés),
 * filtres, bascule tableau / kanban par statut (glisser-déposer selon les droits), fiche détaillée
 * #/ot/:id (en-tête de workflow, détails, réalisation : gamme, temps, pièces, compte rendu ;
 * commentaires, documents, historique), formulaires modaux (création, modification, affectation,
 * clôture, annulation, réouverture), impression du bon de travail, export CSV.
 * Support de #/ot?nouveau=1&equipementId=&demandeId=&planPreventifId= et #/ot?equipementId=ID (filtre).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const ENTITE = 'ot';
  const TAILLE_MAX_DOC = 5 * 1024 * 1024;
  const LIMITE_KANBAN_FINAL = 30;
  /** Couleur du badge des pièces dédiées (identique à la vue Stock). */
  const VIOLET_DEDIEE = '#7c3aed';
  const can = (a) => GMAO.can(ENTITE, a);
  const moi = () => (GMAO.user ? GMAO.user.id : null);
  /** Icône dimensionnée explicitement (hors boutons). */
  function ico(nomIcone, px = 14) { const svg = icone(nomIcone); Object.assign(svg.style, { width: px + 'px', height: px + 'px', flexShrink: '0' }); return svg; }
  /** Ligne flexible pleine largeur (la classe .inline est un inline-flex). */
  const FLEX = (extra) => Object.assign({ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }, extra || {});
  function lireLocal(cle) { try { return localStorage.getItem(cle); } catch (e) { return null; } }
  function ecrireLocal(cle, v) { try { localStorage.setItem(cle, v); } catch (e) { /* ignore */ } }

  // ----- Statuts (liste configurable ; codes par défaut uniquement en repli) ------------
  const STATUTS_DEFAUT = [
    { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
    { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
    { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
    { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
    { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
    { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
  ];
  function S() {
    const l = GMAO.liste('statutsOT');
    const liste = l.length ? l : STATUTS_DEFAUT;
    const item = (code) => liste.find((s) => s.code === code) || null;
    const estFinal = (code) => { const s = item(code); return !!(s && s.final); };
    const estAnnulation = (code) => { const s = item(code); return !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || ''))); };
    const nonFinal = (code, re) => { const s = item(code); if (s && !s.final) return s.code; const t = liste.find((x) => !x.final && re.test(`${x.code} ${x.label || ''}`)); return t ? t.code : null; };
    const finaux = liste.filter((s) => s.final);
    const termine = (finaux.find((s) => s.code === 'termine') || finaux.find((s) => !estAnnulation(s.code)) || finaux[0] || { code: 'termine' }).code;
    const annuleItem = finaux.find((s) => s.code === 'annule') || finaux.find((s) => estAnnulation(s.code));
    return {
      liste, item, estFinal, estAnnulation, termine,
      annule: annuleItem && annuleItem.code !== termine ? annuleItem.code : null,
      initial: (liste.find((s) => !s.final) || { code: 'nouveau' }).code,
      enCours: nonFinal('en_cours', /cours/i), attente: nonFinal('en_attente', /attente/i), planifie: nonFinal('planifie', /planifi/i),
      libelle: (code) => { const s = item(code); return s ? s.label : String(code == null ? '' : code); },
      couleur: (code) => { const s = item(code); return (s && s.couleur) || '#6b7280'; },
    };
  }
  function badgeStatut(code) {
    const st = S();
    return GMAO.liste('statutsOT').length ? ui.badgeListe('statutsOT', code) : ui.badge(st.libelle(code), st.couleur(code));
  }
  function estAffecte(o, uid) {
    uid = uid == null ? moi() : uid;
    return Number(o.technicienId) === Number(uid) || (o.techniciens || []).map(Number).includes(Number(uid));
  }
  const dateFr = (d) => (d ? ui.formatDate(d) : '');
  function duree(h) { return h == null || h === '' ? '—' : ui.formatDuree(h); }

  // ----- Badge de navigation ------------------------------------------------------------
  let derniereMajBadge = 0;
  async function majBadge(compteurs) {
    try {
      derniereMajBadge = Date.now();
      const c = compteurs || await api.get('/api/ot-compteurs', null, { silent401: true });
      GMAO.setNavBadge(ENTITE, c.enRetard || 0);
      return c;
    } catch (e) { return null; }
  }

  // ----- Références (caches courts) -------------------------------------------------------
  const cache = {};
  async function charger(cle, fn, ttl = 60000) {
    if (cache[cle] && Date.now() - cache[cle].t < ttl) return cache[cle].v;
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    cache[cle] = { v, t: Date.now() };
    return v;
  }
  const invalider = (...cles) => cles.forEach((c) => { delete cache[c]; });
  const chargerEquipements = async () => (await charger('equipements', () => (GMAO.can('equipements', 'voir') ? api.get('/api/equipements', { actif: '1' }) : Promise.resolve([])))) || [];
  const chargerTechniciens = async () => (await charger('techniciens', () => api.get('/api/ot-techniciens'))) || [];
  const chargerFournisseurs = async () => {
    const v = await charger('fournisseurs', () => (GMAO.can('fournisseurs', 'voir') ? api.get('/api/fournisseurs') : Promise.resolve([])), 120000);
    return Array.isArray(v) ? v.filter((f) => f.actif !== false) : (v && Array.isArray(v.lignes) ? v.lignes : []);
  };

  /**
   * Options d'intervenants. La liste du serveur est limitée au périmètre de l'utilisateur : les intervenants
   * déjà affectés (`actuels`) qui n'y figurent pas sont conservés pour ne pas être retirés à leur insu.
   */
  function optionsTechniciens(techs, vide, actuels) {
    const base = techs.length ? techs.map((t) => ({ value: t.id, label: `${t.nomComplet}${t.fonction ? ' — ' + t.fonction : ''} · ${t.charge} OT ouvert${t.charge > 1 ? 's' : ''}${t.absent ? ' — absent ce jour' : ''}` }))
      : ui.optionsUsers({ vide: false });
    const connus = new Set(base.map((x) => String(x.value)));
    for (const id of Array.from(new Set((actuels || []).filter((x) => x != null && x !== '').map(Number)))) {
      if (!connus.has(String(id))) base.push({ value: id, label: `${ui.nomUser(id) || '#' + id} — hors de votre périmètre` });
    }
    return vide === false ? base : [{ value: '', label: vide || '— Non affecté —' }].concat(base);
  }
  /** Intervenants à une date prévue : absence validée (module RH) signalée par le serveur ; sans date, la liste mémorisée. */
  async function techniciensPour(date) {
    const jour = date ? String(date).slice(0, 10) : '';
    if (!jour) return chargerTechniciens();
    try { return await api.get('/api/ot-techniciens', { datePrevue: jour }); } catch (e) { return chargerTechniciens(); }
  }
  /**
   * Confirmation avant d'affecter un intervenant absent à la date prévue (absence validée dans le module RH), comme le
   * planning au dépôt d'un OT. Vrai sans date, sans intervenant ou sans module RH.
   */
  async function confirmerAbsents(ids, date) {
    const choisis = Array.from(new Set((ids || []).filter((x) => x != null && x !== '').map(Number)));
    const jour = date ? String(date).slice(0, 10) : '';
    if (!choisis.length || !jour) return true;
    let absents = [];
    try { absents = (await api.get('/api/ot-techniciens', { datePrevue: jour })).filter((t) => t.absent && choisis.includes(Number(t.id))); } catch (e) { return true; }
    if (!absents.length) return true;
    return ui.confirm({
      titre: absents.length > 1 ? 'Intervenants absents' : 'Intervenant absent', okLabel: 'Affecter quand même',
      message: `${absents.map((t) => `${t.nomComplet} (${t.absenceLibelle || 'absent'})`).join(', ')} : absence prévue le ${ui.formatDate(jour)}. Affecter quand même ?`,
    });
  }
  /**
   * Bouton « Localiser sur le plan » (module Plans 3D) : masqué tant que GET /api/plans-localiser/:id ne renvoie aucun
   * plan ; la vue Plans gère le choix entre plusieurs plans et le centrage sur l'objet.
   */
  function boutonPlan(equipementId, classe) {
    if (!GMAO.moduleVisible('plans') || equipementId == null) return null;
    const btn = ui.bouton('Localiser sur le plan', { icone: 'plan3d', classe: `${classe || ''} masque`.trim(), onClic: () => GMAO.navigate('#/plans?equipementId=' + equipementId) });
    api.get('/api/plans-localiser/' + equipementId).then((plans) => { if (Array.isArray(plans) && plans.length) btn.classList.remove('masque'); }).catch(() => {});
    return btn;
  }
  /** Référence d'une ligne (temps, pièce, tâche, commentaire, document) dans les routes : identifiant stable, sinon index. */
  const refLigne = (x) => (x && x.uid ? x.uid : x.index);

  /** <select> des équipements regroupés par secteur (optgroup). */
  function selectEquipements(equipements, valeur, libelleActuel) {
    const sel = el('select', { id: 'f_equipementId' });
    sel.appendChild(el('option', { value: '' }, '— Aucun équipement (intervention générale) —'));
    const groupes = new Map();
    for (const e of equipements) { const k = e.secteurId == null ? 0 : Number(e.secteurId); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(e); }
    const ordreSecteur = (id) => { const s = ui.secteur(id); return s ? (s.ordre || 0) : 999; };
    const cles = Array.from(groupes.keys()).sort((a, b) => ordreSecteur(a) - ordreSecteur(b) || ui.cheminSecteur(a).localeCompare(ui.cheminSecteur(b)));
    for (const k of cles) {
      const og = el('optgroup', { label: k ? ui.cheminSecteur(k) : 'Sans secteur' });
      groupes.get(k).sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr')).forEach((e) => og.appendChild(el('option', { value: String(e.id) }, `${e.nom}${e.numero ? ' (' + e.numero + ')' : ''}${e.parentNom ? ' — ' + e.parentNom : ''}`)));
      sel.appendChild(og);
    }
    if (valeur != null && valeur !== '') {
      sel.value = String(valeur);
      if (sel.value !== String(valeur)) { sel.appendChild(el('option', { value: String(valeur) }, libelleActuel || ('Équipement #' + valeur))); sel.value = String(valeur); }
    }
    return sel;
  }

  // ----- Cellules de liste ------------------------------------------------------------------
  function lienEquipement(o) {
    if (!o.equipementId) return el('span', { class: 'texte-2' }, o.secteurChemin ? 'Sans équipement · ' + o.secteurChemin : 'Sans équipement');
    // Fiche équipement hors de la portée de l'utilisateur (intervenant d'un autre secteur) : pas de lien
    const ouvrable = o.equipementAccessible !== false && GMAO.can('equipements', 'voir');
    return el(ouvrable ? 'a' : 'div', { href: ouvrable ? '#/equipements/' + o.equipementId : null, title: o.secteurChemin ? 'Secteur : ' + o.secteurChemin : (ouvrable ? 'Ouvrir la fiche équipement' : ''), onclick: ouvrable ? (ev) => ev.stopPropagation() : null, style: { display: 'block', minWidth: '140px' } },
      el('div', { class: 'cellule-principale' }, o.equipementNom || ('#' + o.equipementId)),
      el('div', { class: 'cellule-secondaire' }, [o.equipementNumero, o.secteurNom].filter(Boolean).join(' · ')));
  }
  function celluleTechnicien(o) {
    if (!o.technicienId && !(o.techniciens || []).length) return el('span', { class: 'texte-2', title: 'Aucun intervenant' }, 'Non affecté');
    const nomResp = o.technicienNom || ui.nomUser(o.technicienId);
    const autres = (o.techniciens || []).filter((id) => Number(id) !== Number(o.technicienId));
    return el('div', { class: 'inline', title: (o.techniciensNoms || []).join(', '), style: { whiteSpace: 'nowrap' } }, ui.avatar(nomResp || '?', 24), el('span', null, nomResp || '—'), autres.length ? el('span', { class: 'texte-2 texte-petit' }, `+${autres.length}`) : null);
  }
  function celluleDatePrevue(o) {
    if (!o.datePrevue) return el('span', { class: 'texte-2' }, '—');
    return el('div', { style: { whiteSpace: 'nowrap' } }, el('div', { class: o.enRetard ? 'texte-danger texte-gras' : '' }, dateFr(o.datePrevue)), o.enRetard ? el('div', { class: 'texte-danger texte-petit' }, `en retard (${Math.abs(ui.joursEntre(ui.aujourdhui(), String(o.datePrevue).slice(0, 10)) || 0)} j)`) : (o.dureeEstimee ? el('div', { class: 'cellule-secondaire' }, duree(o.dureeEstimee)) : null));
  }
  function barreProgression(fait, total, couleur) {
    const pct = total ? Math.round((fait / total) * 100) : 0;
    return el('div', { class: 'barre-progression', title: `${fait} / ${total}`, style: { minWidth: '60px' } }, el('div', { style: { width: pct + '%', background: couleur || (pct === 100 ? 'var(--ok)' : 'var(--primaire)') } }));
  }
  /** Avancement compact (gamme + temps passé), affiché sous le statut. */
  function celluleAvancement(o) {
    if (!o.nbTaches) return o.tempsTotal ? el('div', { class: 'cellule-secondaire', style: { marginTop: '4px', whiteSpace: 'nowrap' } }, duree(o.tempsTotal)) : null;
    return el('div', { style: { marginTop: '5px' }, title: `${o.nbTachesFaites}/${o.nbTaches} tâche(s) réalisée(s)` }, barreProgression(o.nbTachesFaites, o.nbTaches), el('div', { class: 'cellule-secondaire', style: { whiteSpace: 'nowrap', marginTop: '2px' } }, `${o.nbTachesFaites}/${o.nbTaches}${o.tempsTotal ? ' · ' + duree(o.tempsTotal) : ''}`));
  }

  // ----- Formulaire de création / modification ------------------------------------------------
  async function ouvrirFormulaire(existant, opts = {}, apres) {
    const creation = !existant;
    if (creation && !can('creer')) return toast('Vous n\'avez pas le droit de créer un ordre de travail', 'alerte');
    const [equipements, techs, fournisseurs] = await Promise.all([chargerEquipements(), chargerTechniciens(), chargerFournisseurs()]);
    let demande = opts.demande || (existant && existant.demande) || null;
    if (creation && opts.demandeId && !demande) {
      demande = { id: Number(opts.demandeId), numero: 'DI #' + opts.demandeId };
      if (GMAO.can('demandes', 'voir')) { try { demande = await api.get('/api/demandes/' + opts.demandeId); } catch (e) { /* demande non visible : lien conservé */ } }
    }
    const plan = (existant && existant.plan) || null;
    const affecter = can('affecter');
    const eqInitial = existant ? existant.equipementId : (opts.equipementId || (demande && demande.equipementId) || null);
    const selEq = selectEquipements(equipements, eqInitial, existant && existant.equipement ? `${existant.equipement.nom} (${existant.equipement.numero || '#' + existant.equipementId})` : null);
    const infoEq = el('div', { class: 'aide' });
    let formRef = null;
    const majInfo = () => {
      const e = equipements.find((x) => String(x.id) === selEq.value);
      ui.vider(infoEq);
      if (e) infoEq.append(frag(e.secteurChemin || e.secteurNom ? `Secteur : ${e.secteurChemin || e.secteurNom}` : 'Équipement sans secteur', e.localisation ? ` · ${e.localisation}` : '', e.etatCode ? frag(' · ', ui.badgeListe('etatsEquipement', e.etatCode)) : null, e.nbOtOuverts ? el('span', { class: 'texte-alerte' }, ` · ${e.nbOtOuverts} OT déjà ouvert(s)`) : null));
      else if (selEq.value) infoEq.textContent = 'Équipement actuel de l\'ordre de travail.';
      else if (!equipements.length) infoEq.textContent = 'Aucun équipement disponible : l\'ordre de travail sera rattaché à un secteur.';
      else infoEq.textContent = 'Le secteur de l\'ordre de travail est repris de l\'équipement.';
      const champSecteur = formRef && formRef.champ('secteurId');
      if (champSecteur) champSecteur.classList.toggle('masque', !!selEq.value);
    };
    selEq.addEventListener('change', majInfo);
    const priorites = GMAO.liste('priorites');
    const aidePriorite = priorites.filter((p) => p.delaiHeures).map((p) => `${p.label} : ${p.delaiHeures} h`).join(' · ');
    const actuels = existant ? [existant.technicienId].concat(existant.techniciens || []) : [];
    const optTech = affecter ? optionsTechniciens(techs, '— Non affecté —', actuels) : [{ value: '', label: '— Non affecté —' }, { value: moi(), label: 'Moi-même' }];
    const lienDemande = demande ? el('a', { href: '#/demandes/' + demande.id, target: '_blank' }, `${demande.numero || 'DI #' + demande.id}${demande.titre ? ' — ' + demande.titre : ''}`) : null;
    const champs = [
      { type: 'separateur', label: 'Intervention' },
      { nom: 'titre', label: 'Titre', type: 'texte', requis: true, pleineLargeur: true, maxLength: 200, placeholder: 'ex. Remplacement du joint de tige du vérin principal', valider: (v) => (v && v.trim().length < 3 ? 'Au moins 3 caractères' : '') },
      { nom: 'typeCode', label: 'Type d\'intervention', type: 'select', requis: true, options: ui.optionsListe('typesIntervention', { vide: false }) },
      { nom: 'prioriteCode', label: 'Priorité', type: 'select', requis: true, options: ui.optionsListe('priorites', { vide: false }), aide: aidePriorite ? 'Délais cibles — ' + aidePriorite : '' },
      { type: 'html', label: 'Équipement', rendu: (f) => { formRef = f; setTimeout(majInfo, 0); return frag(selEq, infoEq); } },
      { nom: 'secteurId', label: 'Secteur (si aucun équipement)', type: 'select', options: ui.optionsSecteurs({ vide: '— Aucun —' }) },
      { nom: 'description', label: 'Description / consignes', type: 'texte_long', lignes: 4, placeholder: 'Symptômes, travaux à réaliser, consignes de sécurité (consignation, EPI)…' },
      { type: 'separateur', label: 'Planification' },
      { nom: 'technicienId', label: 'Technicien responsable', type: 'select', options: optTech, disabled: !creation && !affecter, aide: !affecter ? 'L\'affectation d\'autres personnes nécessite le droit « Affecter »' : '' },
      { nom: 'datePrevue', label: 'Date prévue', type: 'date' },
      affecter ? { nom: 'techniciens', label: 'Intervenants', type: 'multiselect', options: optionsTechniciens(techs, false, actuels), pleineLargeur: true, aide: 'Le technicien responsable fait automatiquement partie des intervenants.' } : null,
      { nom: 'dureeEstimee', label: 'Durée estimée (heures)', type: 'nombre', min: 0, step: 0.25 },
      fournisseurs.length ? { nom: 'fournisseurId', label: 'Prestataire externe', type: 'select', options: [{ value: '', label: '— Aucun —' }].concat(fournisseurs.map((f) => ({ value: f.id, label: f.nom }))) } : null,
      lienDemande ? { nom: 'demandeLiee', label: 'Demande d\'origine', type: 'lecture', valeur: lienDemande } : null,
      plan ? { nom: 'planLie', label: 'Plan préventif', type: 'lecture', valeur: `${plan.numero || ''} ${plan.nom || ''}`.trim() } : null,
      creation && opts.planPreventifId ? { nom: 'planInfo', label: 'Plan préventif', type: 'lecture', valeur: 'La gamme opératoire du plan sera copiée dans l\'ordre de travail.' } : null,
      ...ui.champsPersoDefs(ENTITE),
    ];
    const valeurs = existant
      ? Object.assign({}, existant, { secteurId: existant.equipementId ? '' : (existant.secteurId == null ? '' : existant.secteurId), technicienId: existant.technicienId == null ? '' : existant.technicienId, fournisseurId: existant.fournisseurId == null ? '' : existant.fournisseurId, datePrevue: existant.datePrevue ? String(existant.datePrevue).slice(0, 10) : '' }, ui.champsPersoInitiaux(existant))
      : {
        titre: demande && demande.titre ? demande.titre : '', description: demande && demande.description ? demande.description : '',
        typeCode: demande && demande.typeCode ? demande.typeCode : codeParDefaut('typesIntervention', 'correctif'),
        prioriteCode: demande && demande.prioriteCode ? demande.prioriteCode : codeParDefaut('priorites', 'normale'),
        secteurId: opts.secteurId == null ? (demande && !demande.equipementId && demande.secteurId ? demande.secteurId : '') : opts.secteurId,
        technicienId: !affecter && opts.moiMeme ? moi() : '', datePrevue: opts.datePrevue || '', techniciens: [],
      };
    ui.formModal({
      titre: creation ? 'Nouvel ordre de travail' : `Modifier ${existant.numero}`, taille: 'large', champs, valeurs,
      submitLabel: creation ? 'Créer l\'ordre de travail' : 'Enregistrer',
      avant: creation && demande ? ui.alerte(`Ordre de travail créé à partir de la demande ${demande.numero || '#' + demande.id} : la demande passera au statut « convertie ».`, 'info') : null,
      onSubmit: async (v) => {
        const body = {
          titre: v.titre, typeCode: v.typeCode, prioriteCode: v.prioriteCode, description: v.description,
          equipementId: selEq.value ? Number(selEq.value) : null,
          secteurId: selEq.value ? null : (v.secteurId === '' || v.secteurId == null ? null : v.secteurId),
          datePrevue: v.datePrevue || null, dureeEstimee: v.dureeEstimee == null || v.dureeEstimee === '' ? null : v.dureeEstimee,
          champs: ui.champsPersoValeurs(v),
        };
        if (fournisseurs.length) body.fournisseurId = v.fournisseurId === '' || v.fournisseurId == null ? null : v.fournisseurId;
        if (creation || affecter) body.technicienId = v.technicienId === '' || v.technicienId == null ? null : v.technicienId;
        if (affecter) body.techniciens = v.techniciens || [];
        if (creation && demande) body.demandeId = demande.id;
        if (creation && opts.planPreventifId) body.planPreventifId = Number(opts.planPreventifId);
        if (!(await confirmerAbsents([body.technicienId].concat(body.techniciens || []), body.datePrevue))) return false;
        const res = creation ? await api.post('/api/ot', body) : await api.put('/api/ot/' + existant.id, body);
        invalider('techniciens', 'equipements');
        toast(creation ? `Ordre de travail ${res.numero} créé` : 'Ordre de travail enregistré', 'succes');
        // Pièces prévues non reprises ou retirées (pièces dédiées non autorisées pour l'équipement de l'OT)
        (res.avertissements || []).forEach((a) => toast(a, 'alerte', 9000));
        majBadge();
        if (apres) apres(res);
      },
    });
  }
  function codeParDefaut(liste, voulu) {
    const l = GMAO.liste(liste);
    if (!l.length) return voulu;
    return l.some((x) => x.code === voulu) ? voulu : l[0].code;
  }

  // ----- Actions de workflow ---------------------------------------------------------------
  async function changerStatut(o, statut, apres, commentaire) {
    try {
      const r = await api.post(`/api/ot/${o.id}/statut`, { statut, commentaire: commentaire || '' });
      toast(`${r.numero} : ${S().libelle(r.statut)}`, 'succes');
      majBadge();
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  function mettreEnAttente(o, apres) {
    const st = S();
    ui.formModal({
      titre: `Mettre en attente ${o.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Mettre en attente',
      champs: [{ nom: 'commentaire', label: 'Motif de l\'attente', type: 'texte_long', lignes: 3, placeholder: 'ex. Attente de pièce, arrêt de production nécessaire, prestataire…' }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/ot/${o.id}/statut`, { statut: st.attente, commentaire: v.commentaire });
        toast(`${r.numero} mis en attente`, 'succes');
        if (apres) apres(r);
      },
    });
  }
  async function affecterOt(o, apres) {
    const st = S();
    const techs = await techniciensPour(o.datePrevue);
    const planifiable = o.statut === st.initial && st.planifie && st.planifie !== st.initial;
    const actuels = [o.technicienId].concat(o.techniciens || []);
    // Changement de la date prévue : les absences signalées à côté des intervenants suivent la nouvelle date
    const majAbsences = async (date, form) => {
      const t = await techniciensPour(date);
      form.majOptions('technicienId', optionsTechniciens(t, '— Non affecté —', actuels));
      form.majOptions('techniciens', optionsTechniciens(t, false, actuels));
    };
    ui.formModal({
      titre: `Affecter ${o.numero}`, taille: 'large', submitLabel: 'Affecter',
      avant: el('p', { class: 'texte-2 texte-petit', style: { marginTop: 0 } }, 'La charge indiquée correspond au nombre d\'ordres de travail ouverts de chaque intervenant ; une absence validée à la date prévue est signalée. Les nouveaux intervenants sont notifiés.'),
      champs: [
        { nom: 'technicienId', label: 'Technicien responsable', type: 'select', options: optionsTechniciens(techs, '— Non affecté —', actuels) },
        { nom: 'datePrevue', label: 'Date prévue', type: 'date', onChange: (v, form) => { majAbsences(v, form).catch(() => {}); } },
        { nom: 'techniciens', label: 'Intervenants', type: 'multiselect', options: optionsTechniciens(techs, false, actuels), pleineLargeur: true },
        { nom: 'dureeEstimee', label: 'Durée estimée (heures)', type: 'nombre', min: 0, step: 0.25 },
        planifiable ? { nom: 'planifier', label: `Passer au statut « ${st.libelle(st.planifie)} »`, type: 'booleen', valeur: true } : null,
        { nom: 'commentaire', label: 'Consignes (facultatif)', type: 'texte_long', lignes: 2 },
      ],
      valeurs: { technicienId: o.technicienId == null ? '' : o.technicienId, techniciens: o.techniciens || [], datePrevue: o.datePrevue ? String(o.datePrevue).slice(0, 10) : '', dureeEstimee: o.dureeEstimee, planifier: true },
      onSubmit: async (v) => {
        const body = { technicienId: v.technicienId === '' || v.technicienId == null ? null : v.technicienId, techniciens: v.techniciens || [], datePrevue: v.datePrevue || null, dureeEstimee: v.dureeEstimee, commentaire: v.commentaire };
        if (planifiable) body.planifier = !!v.planifier;
        if (!(await confirmerAbsents([body.technicienId].concat(body.techniciens), body.datePrevue))) return false;
        const r = await api.post(`/api/ot/${o.id}/affecter`, body);
        invalider('techniciens');
        toast(`${r.numero} affecté${r.technicienNom ? ' à ' + r.technicienNom : ''}`, 'succes');
        if (apres) apres(r);
      },
    });
  }
  async function cloturerOt(o, apres) {
    const fournisseurs = await chargerFournisseurs();
    const nonFaites = (o.taches || []).filter((t) => !t.fait).length;
    const compteur = o.equipement && o.equipement.compteur;
    const alertes = [];
    if (nonFaites) alertes.push(ui.alerte(`${nonFaites} tâche(s) de la gamme ne sont pas cochées.`, 'alerte'));
    if (!(o.tempsPasse || []).length) alertes.push(ui.alerte('Aucun temps passé n\'a été saisi : pensez à le renseigner (onglet Réalisation) pour le calcul des coûts.', 'info'));
    ui.formModal({
      titre: `Clôturer ${o.numero}`, taille: 'large', submitLabel: 'Clôturer l\'ordre de travail',
      avant: alertes.length ? el('div', null, alertes) : null,
      champs: [
        { nom: 'rapport', label: 'Compte rendu d\'intervention', type: 'texte_long', lignes: 6, requis: true, placeholder: 'Constat, travaux réalisés, pièces remplacées, essais, recommandations…', valider: (v) => (v && v.trim().length < 3 ? 'Compte rendu trop court' : '') },
        { nom: 'causeCode', label: 'Cause de la panne', type: 'select', options: ui.optionsListe('causesPanne', { vide: '— Non renseignée —' }) },
        { nom: 'dateFin', label: 'Fin de l\'intervention', type: 'datetime', requis: true },
        o.equipement ? { nom: 'compteurReleve', label: `Relevé du compteur${compteur && compteur.unite ? ' (' + compteur.unite + ')' : ''}`, type: 'nombre', min: 0, aide: compteur ? `Compteur actuel de l'équipement : ${ui.formatNombre(compteur.valeur)} ${compteur.unite || ''}` : 'Facultatif' } : null,
        { nom: 'coutExterne', label: 'Coût externe (sous-traitance, €)', type: 'nombre', min: 0, step: 0.01 },
        fournisseurs.length ? { nom: 'fournisseurId', label: 'Prestataire', type: 'select', options: [{ value: '', label: '— Aucun —' }].concat(fournisseurs.map((f) => ({ value: f.id, label: f.nom }))) } : null,
      ],
      valeurs: { rapport: o.rapport || '', causeCode: o.causeCode || '', dateFin: new Date().toISOString(), compteurReleve: o.compteurReleve, coutExterne: o.coutExterne || 0, fournisseurId: o.fournisseurId == null ? '' : o.fournisseurId },
      onSubmit: async (v) => {
        const body = { rapport: v.rapport, causeCode: v.causeCode || null, dateFin: v.dateFin, coutExterne: v.coutExterne == null ? 0 : v.coutExterne };
        if (o.equipement && v.compteurReleve != null && v.compteurReleve !== '') body.compteurReleve = v.compteurReleve;
        if (fournisseurs.length) body.fournisseurId = v.fournisseurId === '' || v.fournisseurId == null ? null : v.fournisseurId;
        const r = await api.post(`/api/ot/${o.id}/cloturer`, body);
        toast(`Ordre de travail ${r.numero} clôturé`, 'succes');
        (r.avertissements || []).forEach((a) => toast(a, 'alerte', 6000));
        majBadge();
        if (apres) apres(r);
      },
    });
  }
  function annulerOt(o, apres) {
    const st = S();
    if (!st.annule) return toast('Aucun statut d\'annulation n\'est configuré', 'alerte');
    ui.formModal({
      titre: `Annuler ${o.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Annuler l\'ordre de travail',
      avant: ui.alerte('L\'ordre de travail sera clôturé sans réalisation. Il pourra être réouvert par un utilisateur ayant le droit « Modifier ».', 'alerte'),
      champs: [{ nom: 'commentaire', label: 'Motif de l\'annulation', type: 'texte_long', lignes: 3, requis: true, placeholder: 'ex. Doublon, intervention réalisée sous garantie…' }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/ot/${o.id}/statut`, { statut: st.annule, commentaire: v.commentaire });
        toast(`Ordre de travail ${r.numero} annulé`, 'succes');
        majBadge();
        if (apres) apres(r);
      },
    });
  }
  function reouvrirOt(o, apres) {
    ui.formModal({
      titre: `Réouvrir ${o.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Réouvrir',
      avant: ui.alerte('L\'ordre de travail reprendra son dernier statut actif ; la date de fin et la clôture seront effacées.', 'info'),
      champs: [{ nom: 'motif', label: 'Motif de la réouverture', type: 'texte_long', lignes: 3, placeholder: 'ex. Défaut réapparu, compte rendu à compléter…' }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/ot/${o.id}/reouvrir`, { motif: v.motif });
        toast(`Ordre de travail ${r.numero} réouvert`, 'succes');
        majBadge();
        if (apres) apres(r);
      },
    });
  }
  function dupliquerOt(o, apres) {
    ui.formModal({
      titre: `Dupliquer ${o.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Dupliquer',
      avant: el('p', { class: 'texte-2 texte-petit', style: { marginTop: 0 } }, 'Le titre, la description, l\'équipement, la gamme et l\'affectation sont repris ; les temps, pièces et le compte rendu ne le sont pas.'),
      champs: [{ nom: 'titre', label: 'Titre', type: 'texte', requis: true, maxLength: 200 }, { nom: 'datePrevue', label: 'Date prévue', type: 'date' }],
      valeurs: { titre: o.titre },
      onSubmit: async (v) => {
        const r = await api.post(`/api/ot/${o.id}/dupliquer`, { titre: v.titre, datePrevue: v.datePrevue || null });
        toast(`Ordre de travail ${r.numero} créé par duplication`, 'succes');
        majBadge();
        if (apres) apres(r);
      },
    });
  }
  async function supprimerOt(o, apres) {
    if (!(await ui.confirm({ titre: 'Supprimer l\'ordre de travail', message: `Supprimer définitivement ${o.numero} « ${o.titre} » ? Pour garder la trace de l'intervention, préférez l'annulation.`, okLabel: 'Supprimer', danger: true }))) return;
    try {
      await api.del('/api/ot/' + o.id);
      toast(`Ordre de travail ${o.numero} supprimé`, 'succes');
      invalider('techniciens');
      majBadge();
      if (apres) apres();
    } catch (e) { erreur(e); }
  }

  // ----- Impression du bon de travail ------------------------------------------------------------
  function imprimerBon(o) {
    const esc = ui.esc;
    const st = S();
    const lignes = [
      ['Statut', st.libelle(o.statut)], ['Type', ui.libelle('typesIntervention', o.typeCode)], ['Priorité', ui.libelle('priorites', o.prioriteCode)],
      ['Équipement', o.equipement ? `${o.equipement.numero || ''} ${o.equipement.nom}`.trim() : '—'], ['Localisation', o.equipement && o.equipement.localisation ? o.equipement.localisation : '—'], ['Secteur', o.secteurChemin || '—'],
      ['Responsable', o.technicienNom || '—'], ['Intervenants', (o.techniciensNoms || []).join(', ') || '—'], ['Date prévue', dateFr(o.datePrevue) || '—'], ['Durée estimée', duree(o.dureeEstimee)],
      ['Demande d\'origine', o.demande ? `${o.demande.numero} — ${o.demande.titre}` : '—'], ['Plan préventif', o.plan ? `${o.plan.numero} — ${o.plan.nom}` : '—'], ['Prestataire', o.fournisseurNom || '—'],
      ['Créé le', `${ui.formatDateHeure(o.createdAt)} par ${o.createdByNom || '—'}`],
    ].concat(ui.champsPersoAffichage(ENTITE, o).map((c) => [c.label, c.valeur]));
    const zoneLibre = (h) => `<div style="border:1px solid #bbb;min-height:${h}px;padding:6px"></div>`;
    const taches = (o.taches || []).length
      ? `<table><tr><th style="width:40px">N°</th><th>Opération</th><th style="width:60px">Fait</th><th style="width:140px">Par / le</th></tr>${o.taches.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.libelle)}</td><td style="text-align:center;font-size:15px">${t.fait ? '☑' : '☐'}</td><td>${t.fait ? esc(`${t.faitParNom || ''} ${ui.formatDate(t.dateFait)}`) : ''}</td></tr>`).join('')}</table>`
      : zoneLibre(60);
    const pieces = (o.pieces || []).length
      ? `<table><tr><th>Code</th><th>Désignation</th><th>Qté</th><th>P.U.</th><th>Montant</th></tr>${o.pieces.map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(p.designation)}</td><td>${esc(ui.formatNombre(p.quantite))}</td><td>${esc(ui.formatMontant(p.prixUnitaire))}</td><td>${esc(ui.formatMontant(p.montant))}</td></tr>`).join('')}</table>`
      : '';
    const prevues = (o.piecesPrevues || []).length ? `<p><strong>Pièces prévues :</strong> ${o.piecesPrevues.map((p) => esc(`${p.quantite} × ${p.code ? p.code + ' ' : ''}${p.designation}`)).join(' ; ')}</p>` : '';
    const lignesVides = '<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>'.repeat(3);
    const temps = `<table><tr><th style="width:110px">Date</th><th>Intervenant</th><th style="width:70px">Heures</th><th>Commentaire</th></tr>${(o.tempsPasse || []).map((t) => `<tr><td>${esc(ui.formatDate(t.date))}</td><td>${esc(t.userNom)}</td><td>${esc(ui.formatNombre(t.heures, 2))}</td><td>${esc(t.commentaire || '')}</td></tr>`).join('')}${st.estFinal(o.statut) ? '' : lignesVides}</table>`;
    const rapport = o.rapport ? `<p style="white-space:pre-wrap">${esc(o.rapport)}</p>${o.causeCode ? `<p><strong>Cause :</strong> ${esc(ui.libelle('causesPanne', o.causeCode))}</p>` : ''}` : `${zoneLibre(110)}<p>Cause : ${GMAO.liste('causesPanne').map((c) => '☐ ' + esc(c.label)).join('&nbsp;&nbsp; ')}</p>`;
    const html = `<h1>Bon de travail ${esc(o.numero)}</h1><p style="font-size:15px;margin:2px 0 10px"><strong>${esc(o.titre)}</strong></p>
      <h2>Informations</h2><dl>${lignes.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h2>Description / consignes</h2><p style="white-space:pre-wrap">${esc(o.description || '—')}</p>
      <h2>Gamme opératoire</h2>${taches}
      <h2>Pièces</h2>${prevues}${pieces || (prevues ? '' : zoneLibre(50))}
      <h2>Temps passé</h2>${temps}
      <h2>Compte rendu d'intervention</h2>${rapport}
      <p>Début : ${esc(ui.formatDateHeure(o.dateDebut) || '____/____/________ ____:____')} &nbsp;&nbsp; Fin : ${esc(ui.formatDateHeure(o.dateFin) || '____/____/________ ____:____')}${o.equipement && o.equipement.compteur ? ` &nbsp;&nbsp; Compteur (${esc(o.equipement.compteur.unite || '')}) : ${o.compteurReleve != null ? esc(ui.formatNombre(o.compteurReleve)) : '__________'}` : ''}</p>
      <div class="signature"><div>Intervenant(s)</div><div>Responsable maintenance</div><div>Production / demandeur</div></div>`;
    ui.imprimer(`Bon de travail ${o.numero}`, html);
  }

  // ----- Fiche : blocs ------------------------------------------------------------------------
  function menuPlus(items) {
    const visibles = items.filter(Boolean);
    if (!visibles.length) return null;
    const wrap = el('div', { style: { position: 'relative' } });
    const btn = ui.bouton('Plus', { icone: 'chevron_bas', onClic: (ev) => {
      ev.stopPropagation();
      const existant = wrap.querySelector('.menu-deroulant');
      document.querySelectorAll('.menu-deroulant').forEach((m) => m.remove());
      if (existant) return;
      const menu = el('div', { class: 'menu-deroulant', onclick: (e) => e.stopPropagation() }, visibles.map((it) => el('button', { type: 'button', class: 'menu-item' + (it.danger ? ' texte-danger' : ''), onclick: () => { menu.remove(); it.onClic(); } }, icone(it.icone), it.label)));
      wrap.appendChild(menu);
    } });
    wrap.appendChild(btn);
    return wrap;
  }

  function rendreChronologie(o) {
    const st = S();
    const etapes = (o.historique || []).map((h) => ({ date: h.date, titre: h.libelle || h.action, statut: h.statut, qui: h.userNom || 'Système', commentaire: h.commentaire, couleur: h.statut ? st.couleur(h.statut) : '#2563eb', ancien: h.ancien }));
    // Dates clés absentes de l'historique
    const actions = new Set((o.historique || []).map((h) => h.action));
    if (!actions.has('creation') && !actions.has('duplication')) etapes.push({ date: o.createdAt, titre: 'Ordre de travail créé', qui: o.createdByNom || '—', couleur: '#6b7280' });
    if (o.dateDebut && !(o.historique || []).some((h) => h.statut === st.enCours)) etapes.push({ date: o.dateDebut, titre: 'Début de l\'intervention', qui: '', couleur: st.couleur(st.enCours) });
    if (o.dateFin && !actions.has('cloture') && !actions.has('annulation')) etapes.push({ date: o.dateFin, titre: 'Fin de l\'intervention', qui: o.clotureParNom || '', couleur: '#16a34a' });
    etapes.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const futur = o.datePrevue && !st.estFinal(o.statut) ? el('li', null, el('div', { class: 'inline' }, el('span', { class: 'texte-gras' + (o.enRetard ? ' texte-danger' : ' texte-2') }, o.enRetard ? 'Date prévue dépassée' : 'Intervention prévue')), el('div', { class: 'chrono-date' }, dateFr(o.datePrevue))) : null;
    if (!etapes.length && !futur) return ui.vide('Aucune étape enregistrée', 'horloge');
    return el('ul', { class: 'chronologie' }, etapes.map((h) => el('li', null,
      el('div', { class: 'inline', style: { flexWrap: 'wrap' } }, el('span', { class: 'texte-gras', style: { color: h.couleur && !h.statut ? h.couleur : '' } }, h.titre), h.ancien && h.statut ? el('span', { class: 'texte-2 texte-petit' }, `${st.libelle(h.ancien)} →`) : null, h.statut ? badgeStatut(h.statut) : null),
      el('div', { class: 'chrono-date' }, `${ui.formatDateHeure(h.date)}${h.qui ? ' · ' + h.qui : ''}`),
      h.commentaire ? el('div', { class: 'texte-2', style: { whiteSpace: 'pre-wrap', marginTop: '2px' } }, h.commentaire) : null)), futur);
  }

  function carteCouts(o) {
    const ligne = (label, detail, montant, gras) => el('tr', null, el('td', null, el('div', { class: gras ? 'texte-gras' : '' }, label), detail ? el('div', { class: 'texte-2 texte-petit' }, detail) : null), el('td', { class: 'num' + (gras ? ' texte-gras' : '') }, ui.formatMontant(montant || 0)));
    return ui.carte('Coûts', el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('tbody', null,
      ligne('Pièces', `${(o.pieces || []).length} ligne(s) de sortie de stock`, o.coutPieces),
      ligne('Main d\'œuvre', `${duree(o.tempsTotal)} × ${ui.formatMontant(o.tauxHoraire)} / h`, o.coutMainOeuvre),
      ligne('Prestations externes', o.fournisseurNom || '', o.coutExterne),
      ligne('Total', '', o.coutTotal, true)))));
  }

  function rendreDetails(o) {
    const st = S();
    const e = o.equipement;
    const infos = ui.details([
      { label: 'Statut', valeur: badgeStatut(o.statut) }, { label: 'Priorité', valeur: ui.badgeListe('priorites', o.prioriteCode) },
      { label: 'Type', valeur: ui.badgeListe('typesIntervention', o.typeCode) }, { label: 'Secteur', valeur: o.secteurChemin || '—' },
      { label: 'Responsable', valeur: o.technicienId ? el('span', { class: 'inline' }, ui.avatar(o.technicienNom || '?', 22), o.technicienNom) : el('span', { class: 'texte-2' }, 'Non affecté') },
      { label: 'Intervenants', valeur: (o.techniciensNoms || []).length ? o.techniciensNoms.join(', ') : '—' },
      { label: 'Date prévue', valeur: o.datePrevue ? el('span', { class: o.enRetard ? 'texte-danger texte-gras' : '' }, dateFr(o.datePrevue) + (o.enRetard ? ' (en retard)' : '')) : '—' },
      { label: 'Durée estimée', valeur: duree(o.dureeEstimee) },
      { label: 'Début', valeur: ui.formatDateHeure(o.dateDebut) || '—' }, { label: 'Fin', valeur: ui.formatDateHeure(o.dateFin) || '—' },
      { label: 'Prestataire', valeur: o.fournisseur ? frag(o.fournisseur.nom, o.fournisseur.telephone ? el('span', { class: 'texte-2' }, ' · ' + o.fournisseur.telephone) : null) : '—' },
      { label: 'Cause', valeur: o.causeCode ? ui.libelle('causesPanne', o.causeCode) : '—' },
      { label: 'Créé le', valeur: `${ui.formatDateHeure(o.createdAt)} par ${o.createdByNom || '—'}` },
      { label: 'Clôture', valeur: o.dateCloture ? `${ui.formatDateHeure(o.dateCloture)} par ${o.clotureParNom || '—'}` : '—' },
      ...ui.champsPersoAffichage(ENTITE, o),
    ], { colonnes: 2 });
    const gauche = el('div', null,
      ui.carte('Informations', infos),
      ui.carte('Description / consignes', el('div', { style: { whiteSpace: 'pre-wrap' } }, o.description || el('span', { class: 'texte-2' }, 'Aucune description'))),
      st.estFinal(o.statut) && o.rapport ? ui.carte('Compte rendu', el('div', { style: { whiteSpace: 'pre-wrap' } }, o.rapport)) : null);
    const droite = el('div', null,
      e ? ui.carte('Équipement', frag(
        el('div', { class: 'inline', style: { marginBottom: '8px', flexWrap: 'wrap' } }, ico('equipements', 18), e.accessible !== false && GMAO.can('equipements', 'voir') ? el('a', { href: '#/equipements/' + e.id, class: 'texte-gras' }, e.nom) : el('span', { class: 'texte-gras' }, e.nom), el('span', { class: 'texte-2' }, e.numero), e.etatCode ? ui.badgeListe('etatsEquipement', e.etatCode) : null, e.criticiteCode ? ui.badgeListe('criticites', e.criticiteCode, { contour: true }) : null, e.actif === false ? ui.badge('Inactif', '#6b7280') : null),
        ui.details([
          e.chemin ? { label: 'Emplacement', valeur: e.chemin } : null,
          { label: 'Localisation', valeur: e.localisation || '—' },
          e.marque || e.modele ? { label: 'Marque / modèle', valeur: [e.marque, e.modele].filter(Boolean).join(' ') } : null,
          e.compteur ? { label: 'Compteur', valeur: `${ui.formatNombre(e.compteur.valeur)} ${e.compteur.unite || ''}` } : null,
          o.compteurReleve != null ? { label: 'Relevé à la clôture', valeur: `${ui.formatNombre(o.compteurReleve)} ${(e.compteur || {}).unite || ''}` } : null,
        ])), { actions: [GMAO.can(ENTITE, 'voir') ? ui.bouton('Historique', { icone: 'liste', classe: 'btn-sm', onClic: () => GMAO.navigate('#/ot?equipementId=' + e.id) }) : null, e.accessible !== false ? boutonPlan(e.id, 'btn-sm') : null] }) : null,
      o.demande ? ui.carte('Demande d\'origine', ui.details([
        { label: 'Demande', valeur: el('a', { href: '#/demandes/' + o.demande.id }, `${o.demande.numero} — ${o.demande.titre}`) },
        { label: 'Statut', valeur: o.demande.statut ? ui.badgeListe('statutsDemande', o.demande.statut) : '—' },
        { label: 'Demandeur', valeur: o.demande.demandeurNom || '—' }, { label: 'Date', valeur: ui.formatDateHeure(o.demande.dateDemande) },
        o.demande.arretProduction ? { label: 'Arrêt de production', valeur: el('span', { class: 'texte-danger texte-gras' }, 'Oui') } : null,
      ])) : null,
      o.plan ? ui.carte('Plan préventif', ui.details([
        { label: 'Plan', valeur: el('a', { href: '#/preventif/' + o.plan.id }, `${o.plan.numero || ''} ${o.plan.nom}`.trim()) },
        o.plan.periodicite ? { label: 'Périodicité', valeur: `Tous les ${o.plan.periodicite.valeur} ${o.plan.periodicite.type}` } : null,
        { label: 'Prochaine échéance', valeur: o.plan.prochaineEcheance ? (/^\d{4}-/.test(String(o.plan.prochaineEcheance)) ? dateFr(o.plan.prochaineEcheance) : String(o.plan.prochaineEcheance)) : '—' },
      ])) : null,
      carteCouts(o));
    return el('div', { class: 'grille grille-2' }, gauche, droite);
  }

  // ----- Fiche : réalisation -------------------------------------------------------------------
  function rendreTaches(o, maj) {
    const a = o.actions || {};
    const taches = o.taches || [];
    const cont = el('div');
    if (taches.length) {
      cont.appendChild(el('div', { class: 'mb', style: FLEX({ gap: '10px' }) }, el('div', { style: { flex: 1 } }, barreProgression(o.nbTachesFaites, o.nbTaches)), el('span', { class: 'texte-petit texte-2' }, `${o.nbTachesFaites} / ${o.nbTaches}`)));
      cont.appendChild(el('div', null, taches.map((t) => {
        const cb = el('input', { type: 'checkbox', checked: !!t.fait, disabled: !a.realiser, title: a.realiser ? 'Cocher / décocher' : '' });
        cb.addEventListener('change', async () => {
          cb.disabled = true;
          try { maj(await api.put(`/api/ot/${o.id}/taches/${refLigne(t)}`, { fait: cb.checked })); } catch (e) { cb.checked = !cb.checked; cb.disabled = false; erreur(e); }
        });
        return el('div', { style: FLEX({ padding: '6px 0', borderBottom: '1px solid var(--bordure)', alignItems: 'flex-start', gap: '10px' }) },
          el('label', { class: 'inline', style: { flex: 1, cursor: a.realiser ? 'pointer' : 'default', alignItems: 'flex-start' } }, cb,
            el('div', null, el('div', { style: { textDecoration: t.fait ? 'line-through' : 'none', color: t.fait ? 'var(--texte-2)' : 'inherit' } }, `${t.ordre || t.index + 1}. ${t.libelle}`),
              t.fait ? el('div', { class: 'texte-2 texte-petit' }, `Fait${t.faitParNom ? ' par ' + t.faitParNom : ''}${t.dateFait ? ' le ' + ui.formatDateHeure(t.dateFait) : ''}`) : (t.duree ? el('div', { class: 'texte-2 texte-petit' }, 'Durée indicative : ' + duree(t.duree)) : null))),
          // Retirer une étape de la gamme est réservé au droit « modifier » (un intervenant coche et ajoute, sans réduire la gamme)
          a.modifier ? el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer la tâche', onclick: async () => {
            if (!(await ui.confirm({ titre: 'Supprimer la tâche', message: `Supprimer « ${t.libelle} » de la gamme ?`, okLabel: 'Supprimer', danger: true }))) return;
            try { maj(await api.del(`/api/ot/${o.id}/taches/${refLigne(t)}`)); toast('Tâche supprimée', 'succes'); } catch (e) { erreur(e); }
          } }, icone('supprimer')) : null);
      })));
    } else cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucune tâche : ajoutez les opérations à réaliser pour suivre l\'avancement.'));
    if (a.realiser) {
      const input = el('input', { type: 'text', placeholder: 'Nouvelle opération (ex. Contrôler le serrage des fixations)', maxlength: 300, style: { flex: 1 } });
      const btn = el('button', { type: 'button', class: 'btn btn-sm', onclick: async () => {
        const libelle = input.value.trim();
        if (libelle.length < 2) return toast('Saisissez le libellé de la tâche', 'alerte');
        btn.disabled = true;
        try { maj(await api.post(`/api/ot/${o.id}/taches`, { libelle })); toast('Tâche ajoutée', 'succes'); } catch (e) { erreur(e); btn.disabled = false; }
      } }, icone('plus'), 'Ajouter');
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); btn.click(); } });
      cont.appendChild(el('div', { class: 'mt', style: FLEX() }, input, btn));
    }
    return ui.carte(`Gamme opératoire (${taches.length})`, cont);
  }

  function rendreTemps(o, maj) {
    const a = o.actions || {};
    const temps = o.tempsPasse || [];
    const cont = el('div');
    if (temps.length) {
      cont.appendChild(ui.table({
        compact: true, recherche: false, pagination: false, lignes: temps, triInitial: { cle: 'date', sens: 'asc' },
        colonnes: [
          { cle: 'date', label: 'Date', type: 'date', largeur: '100px' },
          { cle: 'userNom', label: 'Intervenant' },
          { cle: 'heures', label: 'Heures', aligner: 'droite', rendu: (t) => duree(t.heures), valeurTri: (t) => Number(t.heures) || 0 },
          { cle: 'commentaire', label: 'Commentaire', rendu: (t) => t.commentaire || el('span', { class: 'texte-2' }, '—') },
        ],
        actions: a.realiser ? [{ icone: 'supprimer', titre: 'Supprimer la saisie', classe: 'texte-danger', visible: (t) => a.modifier || Number(t.userId) === moi() || Number(t.saisiPar) === moi(), onClic: async (t) => {
          if (!(await ui.confirm({ titre: 'Supprimer la saisie de temps', message: `Supprimer ${duree(t.heures)} du ${ui.formatDate(t.date)} (${t.userNom}) ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { maj(await api.del(`/api/ot/${o.id}/temps/${refLigne(t)}`)); toast('Saisie supprimée', 'succes'); } catch (e) { erreur(e); }
        } }] : [],
      }).el);
      const ecart = o.dureeEstimee ? o.tempsTotal - o.dureeEstimee : null;
      cont.appendChild(el('div', { class: 'mt', style: FLEX({ justifyContent: 'space-between', flexWrap: 'wrap' }) },
        el('span', null, el('strong', null, 'Total : ' + duree(o.tempsTotal)), o.dureeEstimee ? el('span', { class: ecart > 0 ? 'texte-danger texte-petit' : 'texte-2 texte-petit' }, ` (estimé ${duree(o.dureeEstimee)}${ecart > 0 ? ', dépassement ' + duree(ecart) : ''})`) : null),
        el('span', { class: 'texte-2 texte-petit' }, `Main d'œuvre : ${ui.formatMontant(o.coutMainOeuvre)}`)));
    } else cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucun temps saisi.'));
    if (a.realiser) {
      const inDate = el('input', { type: 'date', value: ui.aujourdhui(), max: ui.aujourdhui(), title: 'Date', style: { width: '150px' } });
      const inHeures = el('input', { type: 'number', min: 0.25, max: 24, step: 0.25, placeholder: 'Heures', title: 'Heures', style: { width: '90px' } });
      let selUser = null;
      if (a.saisirPourAutrui) {
        const ids = Array.from(new Set([moi()].concat((o.techniciens || []).map(Number))));
        selUser = el('select', { title: 'Intervenant', style: { width: '190px' } }, ids.map((id) => el('option', { value: String(id), selected: id === moi() }, ui.nomUser(id))));
      }
      const inCom = el('input', { type: 'text', placeholder: 'Commentaire (facultatif)', maxlength: 500, style: { flex: 1, minWidth: '160px' } });
      const btn = el('button', { type: 'button', class: 'btn btn-sm btn-primaire', onclick: async () => {
        const heures = Number(String(inHeures.value).replace(',', '.'));
        if (!heures || heures <= 0) { inHeures.focus(); return toast('Saisissez un nombre d\'heures', 'alerte'); }
        btn.disabled = true;
        try {
          maj(await api.post(`/api/ot/${o.id}/temps`, { date: inDate.value || ui.aujourdhui(), heures, commentaire: inCom.value, userId: selUser ? Number(selUser.value) : undefined }));
          toast(`${duree(heures)} ajoutée(s)`, 'succes');
        } catch (e) { erreur(e); btn.disabled = false; }
      } }, icone('plus'), 'Ajouter');
      inHeures.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); btn.click(); } });
      cont.appendChild(el('div', { class: 'mt', style: FLEX({ flexWrap: 'wrap' }) }, inDate, inHeures, selUser, inCom, btn));
    }
    return ui.carte(`Temps passé (${duree(o.tempsTotal || 0)})`, cont);
  }

  function rendrePieces(o, maj) {
    const a = o.actions || {};
    const pieces = o.pieces || [];
    const cont = el('div');
    if (pieces.length) {
      cont.appendChild(ui.table({
        compact: true, recherche: false, pagination: false, lignes: pieces,
        colonnes: [
          { cle: 'designation', label: 'Article', rendu: (p) => el('div', null, el('div', { class: 'cellule-principale' }, p.designation || ('#' + p.articleId)), el('div', { class: 'cellule-secondaire' }, [p.code, ui.formatDate(p.date)].filter(Boolean).join(' · '))) },
          { cle: 'quantite', label: 'Qté', aligner: 'droite', rendu: (p) => `${ui.formatNombre(p.quantite)}${p.uniteCode && p.uniteCode !== 'u' ? ' ' + p.uniteCode : ''}` },
          { cle: 'prixUnitaire', label: 'P.U.', type: 'montant', aligner: 'droite' },
          { cle: 'montant', label: 'Montant', type: 'montant', aligner: 'droite' },
        ],
        actions: a.realiser && o.stockDisponible ? [{ icone: 'supprimer', titre: 'Retour en stock', classe: 'texte-danger', onClic: async (p) => {
          if (!(await ui.confirm({ titre: 'Retour en stock', message: `Annuler la sortie de ${ui.formatNombre(p.quantite)} × ${p.designation} ? Les pièces seront remises en stock.`, okLabel: 'Remettre en stock', danger: true }))) return;
          try { maj(await api.del(`/api/ot/${o.id}/pieces/${refLigne(p)}`)); toast('Pièce remise en stock', 'succes'); } catch (e) { erreur(e); }
        } }] : [],
      }).el);
      cont.appendChild(el('div', { class: 'mt texte-droite' }, el('strong', null, 'Total pièces : ' + ui.formatMontant(o.coutPieces))));
    } else cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucune pièce consommée.'));
    if ((o.piecesPrevues || []).length) {
      cont.appendChild(el('div', { class: 'mt texte-petit' }, el('strong', null, 'Pièces prévues par la gamme : '), o.piecesPrevues.map((p, i) => frag(i ? ' ; ' : '', `${ui.formatNombre(p.quantite)} × ${p.code ? p.code + ' ' : ''}${p.designation || '#' + p.articleId}`,
        p.disponible != null ? el('span', { class: p.disponible < p.quantite ? 'texte-danger' : 'texte-2' }, ` (stock ${ui.formatNombre(p.disponible)})`) : null,
        p.reservee ? frag(' ', p.utilisable ? ui.badge('Dédiée', VIOLET_DEDIEE, { titre: `Pièce dédiée : ${p.reserveeTexte}` }) : ui.badge('Non autorisée', '#dc2626', { titre: p.raison })) : null))));
    }
    if (a.realiser) {
      if (!o.stockDisponible) {
        cont.appendChild(el('div', { class: 'mt' }, ui.alerte('Module Stock indisponible : la saisie des pièces consommées est désactivée.', 'info')));
      } else {
        const sel = el('select', { style: { flex: 1, minWidth: '220px' }, disabled: true }, el('option', { value: '' }, 'Chargement des articles…'));
        const inQte = el('input', { type: 'number', min: 0.01, step: 'any', value: '1', title: 'Quantité', style: { width: '90px' } });
        const btn = el('button', { type: 'button', class: 'btn btn-sm btn-primaire', disabled: true, onclick: async () => {
          const articleId = Number(sel.value);
          const quantite = Number(String(inQte.value).replace(',', '.'));
          if (!articleId) return toast('Choisissez un article', 'alerte');
          if (!quantite || quantite <= 0) { inQte.focus(); return toast('Quantité invalide', 'alerte'); }
          btn.disabled = true;
          try { maj(await api.post(`/api/ot/${o.id}/pieces`, { articleId, quantite })); toast('Sortie de stock enregistrée', 'succes'); } catch (e) { erreur(e); btn.disabled = false; }
        } }, icone('piece'), 'Sortir du stock');
        const info = el('div', { class: 'aide' });
        // Aide sur les pièces dédiées grisées : élément distinct, conservé quand l'article choisi change
        const aideRefus = el('div', { class: 'aide' });
        cont.appendChild(el('div', { class: 'mt', style: FLEX({ flexWrap: 'wrap' }) }, sel, inQte, btn));
        cont.appendChild(info);
        cont.appendChild(aideRefus);
        api.get('/api/ot-articles', { otId: o.id }).then((r) => {
          ui.vider(sel);
          if (!r.disponible) { sel.appendChild(el('option', { value: '' }, 'Module Stock indisponible')); info.textContent = 'La saisie des pièces est désactivée.'; return; }
          if (!r.articles.length) { sel.appendChild(el('option', { value: '' }, 'Aucun article en stock')); return; }
          sel.appendChild(el('option', { value: '' }, '— Choisir un article —'));
          const libelleStock = (x) => `${x.code ? x.code + ' — ' : ''}${x.designation} (stock : ${ui.formatNombre(x.quantite)}${x.uniteCode ? ' ' + ui.libelle('unites', x.uniteCode).toLowerCase() : ''})`;
          const option = (x) => el('option', { value: String(x.id), disabled: !r.stockNegatif && x.quantite <= 0 }, libelleStock(x));
          // Pièces dédiées (règle du serveur) : utilisables en tête avec la mention « Dédiée », les autres désactivées avec la raison
          const dediees = r.articles.filter((x) => x.reservee && x.utilisable);
          const refusees = r.articles.filter((x) => x.reservee && !x.utilisable && !x.sansEquipement);
          const orphelines = r.articles.filter((x) => x.reservee && !x.utilisable && x.sansEquipement);
          // OT sans équipement : une pièce dédiée n'est utilisable qu'une fois l'équipement de l'OT renseigné
          const sansEquipementOt = r.equipementId == null;
          const compat = r.articles.filter((x) => !x.reservee && x.compatible);
          const autres = r.articles.filter((x) => !x.reservee && !x.compatible);
          if (dediees.length) sel.appendChild(el('optgroup', { label: 'Pièces dédiées à cet équipement' }, dediees.map((x) => el('option', { value: String(x.id), disabled: !r.stockNegatif && x.quantite <= 0, title: `Pièce dédiée : ${x.reserveeTexte}`, dataset: { dediee: '1' } }, `Dédiée · ${libelleStock(x)}`))));
          if (compat.length) sel.appendChild(el('optgroup', { label: 'Compatibles avec l\'équipement' }, compat.map(option)));
          if (autres.length) sel.appendChild(el('optgroup', { label: dediees.length || compat.length ? 'Autres articles' : 'Articles' }, autres.map(option)));
          if (refusees.length) {
            sel.appendChild(el('optgroup', { label: sansEquipementOt ? 'Pièces dédiées (renseignez d\'abord l\'équipement de l\'OT)' : 'Pièces dédiées à d\'autres équipements (non utilisables)' }, refusees.map((x) => el('option', {
              value: String(x.id), disabled: true, dataset: { dediee: '1', refusee: '1' },
              title: sansEquipementOt ? `Pièce dédiée à ${x.reserveeTexte} : renseignez d'abord l'équipement de l'ordre de travail` : x.raison,
            }, `${x.code ? x.code + ' — ' : ''}${x.designation} — réservée à ${x.reserveeTexte}`))));
          }
          if (orphelines.length) {
            sel.appendChild(el('optgroup', { label: 'Pièces dédiées sans équipement (à réaffecter)' }, orphelines.map((x) => el('option', { value: String(x.id), disabled: true, title: x.raison, dataset: { dediee: '1', refusee: '1' } },
              `${x.code ? x.code + ' — ' : ''}${x.designation} — pièce dédiée sans équipement (à réaffecter)`))));
          }
          sel.disabled = false; btn.disabled = false;
          sel.addEventListener('change', () => {
            const x = r.articles.find((y) => String(y.id) === sel.value);
            ui.vider(info);
            if (!x) return;
            if (x.reservee) info.appendChild(frag(ui.badge('Pièce dédiée', VIOLET_DEDIEE), ` Utilisable uniquement sur ${x.reserveeTexte}. `));
            info.appendChild(document.createTextNode(`${x.emplacement ? 'Emplacement : ' + x.emplacement + ' · ' : ''}Prix unitaire : ${ui.formatMontant(x.prixUnitaire)}${x.seuilMin != null && x.quantite <= x.seuilMin ? ' · stock sous le seuil minimum' : ''}`));
          });
          const aides = [];
          if (refusees.length && sansEquipementOt) {
            aides.push(refusees.length > 1
              ? `${refusees.length} pièces dédiées sont grisées en fin de liste : renseignez d'abord l'équipement de l'ordre de travail (seules les pièces autorisées pour cet équipement pourront être utilisées).`
              : '1 pièce dédiée est grisée en fin de liste : renseignez d\'abord l\'équipement de l\'ordre de travail (seules les pièces autorisées pour cet équipement pourront être utilisées).');
          } else if (refusees.length) {
            aides.push(refusees.length > 1
              ? `${refusees.length} pièces dédiées à d'autres équipements sont grisées en fin de liste : elles ne sont pas utilisables sur cet ordre de travail.`
              : '1 pièce dédiée à d\'autres équipements est grisée en fin de liste : elle n\'est pas utilisable sur cet ordre de travail.');
          }
          if (orphelines.length) {
            aides.push(orphelines.length > 1
              ? `${orphelines.length} pièces dédiées sans équipement sont grisées : elles sont à réaffecter dans le stock.`
              : '1 pièce dédiée sans équipement est grisée : elle est à réaffecter dans le stock.');
          }
          aideRefus.textContent = aides.join(' ');
        }).catch((e) => { ui.vider(sel); sel.appendChild(el('option', { value: '' }, 'Articles indisponibles')); info.textContent = e.message; });
      }
    }
    return ui.carte(`Pièces consommées (${pieces.length})`, cont);
  }

  function rendreCompteRendu(o, maj) {
    const a = o.actions || {};
    const st = S();
    const cont = el('div');
    if (!a.realiser) {
      cont.appendChild(o.rapport ? el('div', { style: { whiteSpace: 'pre-wrap' } }, o.rapport) : el('p', { class: 'texte-2 texte-petit' }, st.estFinal(o.statut) ? 'Aucun compte rendu.' : 'Le compte rendu sera saisi par les intervenants.'));
      cont.appendChild(ui.details([
        { label: 'Cause', valeur: o.causeCode ? ui.libelle('causesPanne', o.causeCode) : '—' },
        o.equipement && o.equipement.compteur ? { label: 'Relevé compteur', valeur: o.compteurReleve != null ? `${ui.formatNombre(o.compteurReleve)} ${o.equipement.compteur.unite || ''}` : '—' } : null,
        { label: 'Coût externe', valeur: ui.formatMontant(o.coutExterne || 0) },
      ]));
      return ui.carte('Compte rendu', cont);
    }
    const f = ui.form({ colonnes: 2, champs: [
      { nom: 'brouillonRapport', label: 'Compte rendu (brouillon)', type: 'texte_long', lignes: 5, placeholder: 'Constat, travaux réalisés, essais… (obligatoire pour clôturer)' },
      { nom: 'brouillonCause', label: 'Cause', type: 'select', options: ui.optionsListe('causesPanne', { vide: '— Non renseignée —' }) },
      o.equipement ? { nom: 'brouillonCompteur', label: `Relevé du compteur${o.equipement.compteur && o.equipement.compteur.unite ? ' (' + o.equipement.compteur.unite + ')' : ''}`, type: 'nombre', min: 0 } : null,
      { nom: 'brouillonCoutExterne', label: 'Coût externe (€)', type: 'nombre', min: 0, step: 0.01 },
    ], valeurs: { brouillonRapport: o.rapport || '', brouillonCause: o.causeCode || '', brouillonCompteur: o.compteurReleve, brouillonCoutExterne: o.coutExterne || 0 } });
    // Lecture du brouillon sous les noms attendus par l'API
    const lireBrouillon = () => { const x = f.valeurs(); return { rapport: x.brouillonRapport, causeCode: x.brouillonCause, compteurReleve: x.brouillonCompteur, coutExterne: x.brouillonCoutExterne }; };
    cont.appendChild(f.el);
    const btnEnr = el('button', { type: 'button', class: 'btn btn-sm', onclick: async () => {
      if (!f.valider()) return;
      const v = lireBrouillon();
      const body = { rapport: v.rapport, causeCode: v.causeCode || null, coutExterne: v.coutExterne == null ? 0 : v.coutExterne };
      if (o.equipement) body.compteurReleve = v.compteurReleve == null || v.compteurReleve === '' ? null : v.compteurReleve;
      btnEnr.disabled = true;
      try { maj(await api.put(`/api/ot/${o.id}`, body)); toast('Compte rendu enregistré', 'succes'); } catch (e) { erreur(e); btnEnr.disabled = false; }
    } }, icone('sauvegarde'), 'Enregistrer');
    // Clôture depuis le brouillon : tout ce qui vient d'être saisi (compte rendu, cause, relevé, coût externe)
    // pré-remplit la fenêtre de clôture, même sans « Enregistrer » préalable
    const avecBrouillon = () => {
      const v = lireBrouillon();
      const vide = (x) => x == null || x === '';
      return Object.assign({}, o, {
        rapport: v.rapport || o.rapport, causeCode: v.causeCode || o.causeCode,
        compteurReleve: vide(v.compteurReleve) ? o.compteurReleve : v.compteurReleve,
        coutExterne: vide(v.coutExterne) ? o.coutExterne : v.coutExterne,
      });
    };
    cont.appendChild(el('div', { class: 'mt', style: FLEX({ justifyContent: 'flex-end' }) }, btnEnr,
      a.cloturer ? el('button', { type: 'button', class: 'btn btn-sm btn-ok', onclick: () => cloturerOt(avecBrouillon(), maj) }, icone('check'), 'Clôturer l\'OT') : null));
    return ui.carte('Compte rendu', cont);
  }

  function rendreRealisation(o, maj) {
    return el('div', { class: 'grille grille-2' },
      el('div', null, rendreTaches(o, maj), rendreCompteRendu(o, maj)),
      el('div', null, rendreTemps(o, maj), rendrePieces(o, maj)));
  }

  // ----- Fiche : commentaires, documents, historique ---------------------------------------------
  function rendreCommentaires(o, maj) {
    const cont = el('div');
    const liste = el('div', { class: 'commentaires' });
    if (!(o.commentaires || []).length) liste.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucun commentaire pour le moment.'));
    for (const c of (o.commentaires || [])) {
      const supprimable = Number(c.userId) === moi() || can('modifier');
      liste.appendChild(el('div', { class: 'commentaire' },
        el('div', { style: FLEX({ gap: '6px' }) }, ui.avatar(c.userNom || '?', 24), el('span', { class: 'c-auteur' }, c.userNom || ('#' + c.userId)), el('span', { class: 'c-date', title: ui.formatDateHeure(c.date) }, ui.relatif(c.date)),
          supprimable ? el('button', { type: 'button', class: 'btn btn-icone btn-sm', style: { marginLeft: 'auto' }, title: 'Supprimer le commentaire', onclick: async () => {
            if (!(await ui.confirm({ titre: 'Supprimer le commentaire', message: 'Supprimer ce commentaire ?', okLabel: 'Supprimer', danger: true }))) return;
            try { maj(await api.del(`/api/ot/${o.id}/commentaires/${refLigne(c)}`)); toast('Commentaire supprimé', 'succes'); } catch (e) { erreur(e); }
          } }, icone('supprimer')) : null),
        el('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, c.texte)));
    }
    cont.appendChild(liste);
    const ta = el('textarea', { rows: 3, placeholder: 'Ajouter un commentaire (visible par les intervenants et le créateur de l\'OT)… Ctrl+Entrée pour envoyer', style: { width: '100%' } });
    const btn = el('button', { type: 'button', class: 'btn btn-primaire btn-sm', onclick: async () => {
      const texte = ta.value.trim();
      if (!texte) return toast('Saisissez un commentaire', 'alerte');
      btn.disabled = true;
      try { maj(await api.post(`/api/ot/${o.id}/commentaires`, { texte })); toast('Commentaire ajouté', 'succes'); } catch (e) { erreur(e); btn.disabled = false; }
    } }, icone('commentaire'), 'Commenter');
    ta.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') btn.click(); });
    cont.appendChild(el('div', { class: 'mt' }, ta, el('div', { class: 'mt', style: { display: 'flex', justifyContent: 'flex-end' } }, btn)));
    return ui.carte(`Commentaires (${(o.commentaires || []).length})`, cont);
  }

  function ajouterDocument(o, recharger) {
    ui.formModal({
      titre: 'Ajouter un document', taille: 'petite', colonnes: 1, submitLabel: 'Ajouter',
      champs: [
        { nom: 'fichier', label: 'Fichier (photo, rapport, schéma — 5 Mo max.)', type: 'fichier', requis: true, tailleMax: TAILLE_MAX_DOC },
        { nom: 'description', label: 'Description', type: 'texte', placeholder: 'ex. Photo avant intervention' },
      ],
      onSubmit: async (v) => {
        if (!v.fichier || !v.fichier.contenu) throw new Error('Choisissez un fichier');
        await api.post(`/api/ot/${o.id}/documents`, Object.assign({}, v.fichier, { description: v.description }));
        toast('Document ajouté', 'succes');
        recharger();
      },
    });
  }
  function rendreDocuments(o, recharger) {
    const a = o.actions || {};
    const cont = el('div');
    const docs = o.documents || [];
    if (!docs.length) cont.appendChild(ui.vide('Aucun document joint', 'piece_jointe'));
    const tailleLisible = (t) => (t > 1024 * 1024 ? (t / 1024 / 1024).toFixed(1) + ' Mo' : Math.max(1, Math.round(t / 1024)) + ' Ko');
    for (const d of docs) {
      const url = `/api/ot/${o.id}/documents/${refLigne(d)}`;
      const supprimable = a.supprimerDocuments || (Number(d.userId) === moi() && a.joindre);
      cont.appendChild(el('div', { class: 'inline', style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--bordure)', width: '100%' } },
        d.estImage ? el('img', { src: url, alt: d.nom, style: { width: '48px', height: '48px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--bordure)' } })
          : el('span', { class: 'inline', style: { color: 'var(--primaire)', width: '48px', height: '48px', justifyContent: 'center', background: 'var(--primaire-clair)', borderRadius: '6px' } }, ico('piece_jointe', 20)),
        el('div', { style: { flex: 1, minWidth: 0 } }, el('a', { href: url, target: '_blank', class: 'texte-gras' }, d.nom), el('div', { class: 'texte-2 texte-petit' }, [d.description, tailleLisible(d.taille || 0), `${d.userNom || ''} · ${ui.formatDateHeure(d.date)}`].filter(Boolean).join(' · '))),
        el('a', { href: url + '?telecharger=1', class: 'btn btn-icone btn-sm', title: 'Télécharger' }, icone('export')),
        supprimable ? el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer', onclick: async () => {
          if (!(await ui.confirm({ titre: 'Supprimer le document', message: `Supprimer « ${d.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { await api.del(url); toast('Document supprimé', 'succes'); recharger(); } catch (e) { erreur(e); }
        } }, icone('supprimer')) : null));
    }
    return ui.carte(`Documents (${docs.length})`, cont, { actions: a.joindre ? [ui.bouton('Ajouter', { icone: 'plus', classe: 'btn-sm', onClic: () => ajouterDocument(o, recharger) })] : null });
  }
  const LIBELLES_AUDIT = { creation: 'Création', modification: 'Modification', suppression: 'Suppression', duplication: 'Duplication', statut: 'Changement de statut', cloture: 'Clôture', reouverture: 'Réouverture', affectation: 'Affectation', temps: 'Temps passé', pieces: 'Pièces', commentaire: 'Commentaire', document: 'Document', export: 'Export', compteur: 'Relevé de compteur', mouvement: 'Mouvement de stock' };
  function rendreHistorique(o) {
    const cont = el('div', { class: 'grille grille-2' });
    cont.appendChild(el('div', null, ui.carte('Chronologie', rendreChronologie(o))));
    if (GMAO.can('audit', 'voir')) {
      const zone = el('div', null, ui.chargement());
      cont.appendChild(el('div', null, ui.carte('Journal d\'audit', zone)));
      api.get(`/api/audit/${ENTITE}/${o.id}`).then((rows) => {
        ui.vider(zone);
        if (!rows.length) { zone.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucune entrée dans le journal d\'audit.')); return; }
        zone.appendChild(ui.table({
          compact: true, recherche: false, lignes: rows, tailleParPage: 15, triInitial: { cle: 'date', sens: 'desc' },
          colonnes: [
            { cle: 'date', label: 'Date', type: 'datetime', largeur: '130px' },
            { cle: 'userNom', label: 'Utilisateur' },
            { cle: 'action', label: 'Action', rendu: (r) => ui.badge(LIBELLES_AUDIT[r.action] || r.action) },
            { cle: 'details', label: 'Détails', rendu: (r) => el('span', { class: 'texte-petit' }, r.details) },
          ],
        }).el);
      }).catch((e) => { ui.vider(zone); zone.appendChild(el('p', { class: 'texte-2 texte-petit' }, e.message)); });
    }
    return cont;
  }

  // ----- Fiche détaillée -------------------------------------------------------------------------
  async function rendreFiche(container, id) {
    let o;
    try { o = await api.get('/api/ot/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: 'Ordre de travail introuvable', icone: 'ot', filAriane: [{ label: GMAO.moduleLabel(ENTITE), href: '#/ot' }, { label: '#' + id }] }));
      container.appendChild(ui.vide(e.message || 'Cet ordre de travail n\'existe pas ou n\'est pas dans votre périmètre.', 'alerte'));
      return;
    }
    majBadge();
    afficherFiche(container, o);
  }

  function afficherFiche(container, o) {
    const st = S();
    const a = o.actions || {};
    const maj = (n) => {
      if (!container.isConnected || !n) return;
      const y = window.scrollY;
      ui.vider(container);
      afficherFiche(container, n);
      window.scrollTo(0, y);
    };
    const recharger = async () => { try { maj(await api.get('/api/ot/' + o.id)); majBadge(); } catch (e) { erreur(e); } };
    const actions = [
      a.demarrer ? ui.bouton(o.dateDebut ? 'Reprendre' : 'Démarrer', { icone: 'lecture', classe: 'btn-primaire', onClic: () => changerStatut(o, st.enCours, maj) }) : null,
      a.reprendre ? ui.bouton('Reprendre', { icone: 'lecture', classe: 'btn-primaire', onClic: () => changerStatut(o, st.enCours, maj) }) : null,
      a.mettreEnAttente ? ui.bouton('Mettre en attente', { icone: 'pause', onClic: () => mettreEnAttente(o, maj) }) : null,
      a.cloturer ? ui.bouton('Clôturer', { icone: 'check', classe: 'btn-ok', onClic: () => cloturerOt(o, maj) }) : null,
      a.reouvrir ? ui.bouton('Réouvrir', { icone: 'rafraichir', onClic: () => reouvrirOt(o, maj) }) : null,
      a.affecter ? ui.bouton('Affecter', { icone: 'utilisateur', onClic: () => affecterOt(o, maj) }) : null,
      a.modifier ? ui.bouton('Modifier', { icone: 'modifier', onClic: () => ouvrirFormulaire(o, {}, maj) }) : null,
      ui.bouton('Imprimer le bon', { icone: 'imprimer', onClic: () => imprimerBon(o) }),
      menuPlus([
        a.dupliquer ? { label: 'Dupliquer', icone: 'copier', onClic: () => dupliquerOt(o, (r) => GMAO.navigate('#/ot/' + r.id)) } : null,
        a.annuler ? { label: 'Annuler l\'ordre de travail', icone: 'fermer', danger: true, onClic: () => annulerOt(o, maj) } : null,
        a.supprimer ? { label: 'Supprimer', icone: 'supprimer', danger: true, onClic: () => supprimerOt(o, () => GMAO.navigate('#/ot')) } : null,
      ]),
    ];
    container.appendChild(ui.pageEntete({
      titre: `${o.numero} — ${o.titre}`, icone: 'ot', actions,
      filAriane: [{ label: GMAO.moduleLabel(ENTITE), href: '#/ot' }, { label: o.numero }],
      sousTitre: el('span', { class: 'inline', style: { flexWrap: 'wrap' } }, badgeStatut(o.statut), ui.badgeListe('priorites', o.prioriteCode), ui.badgeListe('typesIntervention', o.typeCode),
        o.enRetard ? ui.badge('En retard', '#dc2626', { contour: true }) : null,
        o.equipement ? el('span', null, ico('equipements', 13), ' ', o.equipement.nom) : null,
        el('span', null, `Créé par ${o.createdByNom || '—'} ${ui.relatif(o.createdAt)}`)),
    }));
    if (o.enRetard) container.appendChild(ui.alerte(`Date prévue dépassée : intervention prévue le ${dateFr(o.datePrevue)}.`, 'alerte'));
    if (st.estFinal(o.statut)) {
      const annule = st.estAnnulation(o.statut);
      const motif = annule ? ((o.historique || []).slice().reverse().find((h) => h.action === 'annulation') || {}).commentaire : '';
      container.appendChild(ui.alerte(frag(el('strong', null, annule ? 'Ordre de travail annulé' : 'Ordre de travail clôturé'), ` le ${ui.formatDateHeure(o.dateCloture || o.dateFin)} par ${o.clotureParNom || '—'}`, motif ? ` — motif : ${motif}` : '', a.reouvrir ? '. Utilisez « Réouvrir » pour le modifier.' : '.'), annule ? 'alerte' : 'ok'));
    } else if (o.statut === st.attente) {
      const motif = ((o.historique || []).slice().reverse().find((h) => h.statut === st.attente) || {}).commentaire;
      if (motif) container.appendChild(ui.alerte(frag(el('strong', null, 'En attente : '), motif), 'info'));
    }
    if (!st.estFinal(o.statut) && !o.technicienId && !(o.techniciens || []).length) container.appendChild(ui.alerte(a.affecter ? frag('Cet ordre de travail n\'est affecté à personne. ', el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); affecterOt(o, maj); } }, 'Affecter maintenant')) : 'Cet ordre de travail n\'est pas encore affecté.', 'info'));

    // Indicateurs
    const depasse = o.dureeEstimee && o.tempsTotal > o.dureeEstimee;
    container.appendChild(el('div', { class: 'grille grille-4 mb' },
      ui.kpi({ label: 'Coût total', valeur: ui.formatMontant(o.coutTotal || 0), icone: 'euro', couleur: '#2563eb', detail: `pièces ${ui.formatMontant(o.coutPieces || 0)} · MO ${ui.formatMontant(o.coutMainOeuvre || 0)}${o.coutExterne ? ' · ext. ' + ui.formatMontant(o.coutExterne) : ''}` }),
      ui.kpi({ label: 'Temps passé', valeur: duree(o.tempsTotal || 0), icone: 'horloge', couleur: depasse ? '#dc2626' : '#8b5cf6', detail: o.dureeEstimee ? `estimé ${duree(o.dureeEstimee)}` : 'pas d\'estimation' }),
      ui.kpi({ label: 'Avancement', valeur: o.nbTaches ? `${Math.round((o.nbTachesFaites / o.nbTaches) * 100)} %` : '—', icone: 'check', couleur: o.nbTaches && o.nbTachesFaites === o.nbTaches ? '#16a34a' : '#f59e0b', detail: o.nbTaches ? `${o.nbTachesFaites} / ${o.nbTaches} tâches` : 'aucune gamme' }),
      ui.kpi({ label: 'Date prévue', valeur: o.datePrevue ? dateFr(o.datePrevue) : '—', icone: 'planning', couleur: o.enRetard ? '#dc2626' : '#16a34a', detail: o.dateFin ? `terminé le ${ui.formatDate(o.dateFin)}` : (o.technicienNom ? o.technicienNom : 'non affecté') })));

    if (GMAO.moduleVisible('achats')) container.appendChild(carteAchats(o));

    container.appendChild(ui.onglets([
      { cle: 'details', label: 'Détails', icone: 'info', rendu: () => rendreDetails(o) },
      { cle: 'realisation', label: 'Réalisation', icone: 'ot', badge: o.nbTaches ? `${o.nbTachesFaites}/${o.nbTaches}` : null, rendu: () => rendreRealisation(o, maj) },
      { cle: 'commentaires', label: 'Commentaires', icone: 'commentaire', badge: o.nbCommentaires || null, rendu: () => rendreCommentaires(o, maj) },
      { cle: 'documents', label: 'Documents', icone: 'piece_jointe', badge: o.nbDocuments || null, rendu: () => rendreDocuments(o, recharger) },
      { cle: 'historique', label: 'Historique', icone: 'horloge', rendu: () => rendreHistorique(o) },
    ], { hash: true }).el);
  }

  /** Achats liés à l'OT (module Achats & factures) : commandes et factures imputées, totaux ; rien n'est affiché sans élément. */
  function carteAchats(o) {
    const zone = el('div');
    api.get('/api/achats/couts-ot/' + o.id).then((r) => {
      if (!zone.isConnected || !r || (!(r.commandes || []).length && !(r.factures || []).length)) return;
      const lignes = [];
      for (const c of r.commandes || []) lignes.push(el('li', null, el('a', { href: '#/achats/commande/' + c.id, class: 'texte-gras' }, c.numero), ` — ${c.fournisseurNom || 'fournisseur non renseigné'} · ${ui.formatMontant(c.montantHT || 0)} HT `, ui.badgeListe('statutsCommande', c.statut)));
      for (const f of r.factures || []) lignes.push(el('li', null, el('a', { href: '#/achats/facture/' + f.id, class: 'texte-gras' }, f.numero), ` — ${f.fournisseurNom || 'fournisseur non renseigné'} · ${ui.formatMontant(f.montantTTC || 0)} TTC `, ui.badgeListe('statutsFacture', f.statut)));
      zone.appendChild(ui.carte('Achats liés', frag(
        el('ul', { style: { margin: '0 0 8px', paddingLeft: '18px' } }, lignes),
        el('div', { class: 'texte-2 texte-petit' }, `Commandes : ${ui.formatMontant(r.totalCommandeHT || 0)} HT · Factures : ${ui.formatMontant(r.totalFactureHT || 0)} HT (${ui.formatMontant(r.totalFactureTTC || 0)} TTC, payé ${ui.formatMontant(r.totalPayeTTC || 0)})`)),
      { actions: [GMAO.can('achats', 'creer') ? ui.bouton('Nouvelle facture', { icone: 'plus', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/achats?onglet=factures&nouveau=facture&otId=${o.id}`) }) : null] }));
    }).catch(() => {});
    return zone;
  }

  // ----- Kanban ----------------------------------------------------------------------------------
  function rendreKanban(rows, { onDeplacer }) {
    const st = S();
    const cont = el('div', { style: { display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '10px', alignItems: 'flex-start' } });
    let glisse = null;
    const peutGlisser = (o) => (st.estFinal(o.statut) ? can('modifier') : (can('modifier') || estAffecte(o)));
    for (const s of st.liste) {
      let items = rows.filter((o) => o.statut === s.code);
      const total = items.length;
      if (s.final) items = items.slice().sort((a, b) => String(b.dateFin || b.updatedAt || '').localeCompare(String(a.dateFin || a.updatedAt || ''))).slice(0, LIMITE_KANBAN_FINAL);
      else items = items.slice().sort((a, b) => (Number(b.enRetard) - Number(a.enRetard)) || ((ui.itemListe('priorites', b.prioriteCode) || {}).ordre || 0) - ((ui.itemListe('priorites', a.prioriteCode) || {}).ordre || 0) || String(a.datePrevue || '9999').localeCompare(String(b.datePrevue || '9999')));
      const zone = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px', minHeight: '80px', maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' } });
      items.forEach((o) => zone.appendChild(carteKanban(o, peutGlisser(o), (id) => { glisse = id; })));
      if (!items.length) zone.appendChild(el('div', { class: 'texte-2 texte-petit texte-centre', style: { padding: '14px 4px' } }, 'Aucun OT'));
      if (total > items.length) zone.appendChild(el('div', { class: 'texte-2 texte-petit texte-centre' }, `${total - items.length} autre(s) non affiché(s) — utilisez le tableau`));
      const colonne = el('div', { dataset: { statut: s.code }, class: 'kanban-colonne', style: { flex: '1 0 250px', minWidth: '250px', maxWidth: '340px', background: 'var(--surface-2)', border: '1px solid var(--bordure)', borderTop: `3px solid ${s.couleur || '#6b7280'}`, borderRadius: 'var(--rayon)' } },
        el('div', { style: FLEX({ padding: '10px 12px 6px', justifyContent: 'space-between' }) }, el('span', { class: 'inline texte-gras' }, ui.pastille(s.couleur), s.label), el('span', { class: 'badge' }, String(total))),
        zone);
      colonne.addEventListener('dragover', (ev) => { if (glisse == null) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; colonne.style.outline = '2px dashed var(--primaire)'; });
      colonne.addEventListener('dragleave', (ev) => { if (!colonne.contains(ev.relatedTarget)) colonne.style.outline = ''; });
      colonne.addEventListener('drop', (ev) => {
        ev.preventDefault(); colonne.style.outline = '';
        const id = glisse != null ? glisse : Number(ev.dataTransfer.getData('text/plain'));
        glisse = null;
        const o = rows.find((x) => x.id === Number(id));
        if (o && o.statut !== s.code) onDeplacer(o, s.code);
      });
      cont.appendChild(colonne);
    }
    cont.addEventListener('dragend', () => { glisse = null; cont.querySelectorAll('.kanban-colonne').forEach((c) => { c.style.outline = ''; }); });
    return cont;
  }
  function carteKanban(o, glissable, onDebut) {
    const couleurPrio = ui.couleur('priorites', o.prioriteCode);
    const carte = el('div', {
      class: 'kanban-carte', draggable: glissable ? 'true' : null, title: glissable ? 'Glisser vers une autre colonne pour changer le statut' : '',
      style: { background: 'var(--surface)', border: '1px solid var(--bordure)', borderLeft: `4px solid ${couleurPrio}`, borderRadius: '6px', padding: '8px 10px', cursor: glissable ? 'grab' : 'pointer', boxShadow: 'var(--ombre)' },
      onclick: () => GMAO.navigate('#/ot/' + o.id),
    },
    el('div', { style: FLEX({ justifyContent: 'space-between' }) }, el('span', { class: 'texte-petit texte-2 texte-gras' }, o.numero), ui.badgeListe('priorites', o.prioriteCode)),
    el('div', { style: { fontWeight: 600, margin: '4px 0', fontSize: '13px', lineHeight: 1.3 } }, o.titre),
    o.equipementNom ? el('div', { class: 'texte-petit texte-2 inline', style: { gap: '4px' } }, ico('equipements', 12), o.equipementNom) : (o.secteurNom ? el('div', { class: 'texte-petit texte-2' }, o.secteurNom) : null),
    o.nbTaches ? el('div', { style: { margin: '6px 0 2px' } }, barreProgression(o.nbTachesFaites, o.nbTaches)) : null,
    el('div', { style: FLEX({ justifyContent: 'space-between', marginTop: '6px', gap: '6px' }) },
      o.technicienId ? el('span', { class: 'inline texte-petit', style: { gap: '4px', minWidth: 0 } }, ui.avatar(o.technicienNom || '?', 20), el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, o.technicienNom), (o.techniciens || []).length > 1 ? el('span', { class: 'texte-2' }, `+${o.techniciens.length - 1}`) : null) : el('span', { class: 'texte-petit texte-2' }, 'Non affecté'),
      o.datePrevue ? el('span', { class: 'texte-petit inline' + (o.enRetard ? ' texte-danger texte-gras' : ' texte-2'), style: { gap: '3px', whiteSpace: 'nowrap' } }, ico('horloge', 12), dateFr(o.datePrevue)) : null));
    if (glissable) {
      carte.addEventListener('dragstart', (ev) => { onDebut(o.id); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(o.id)); } catch (e) { /* ignore */ } carte.style.opacity = '0.5'; });
      carte.addEventListener('dragend', () => { carte.style.opacity = ''; });
    }
    return carte;
  }

  // ----- Liste ------------------------------------------------------------------------------------
  async function rendreListe(container, query) {
    const st = S();
    let ots = [];
    let compteurs = null;
    let onglet = ['tous', 'mes', 'enCours', 'retard', 'termines'].includes(query.onglet) ? query.onglet : 'tous';
    let mode = query.vue === 'kanban' || query.vue === 'tableau' ? query.vue : (lireLocal('gmao.ot.vue') === 'kanban' ? 'kanban' : 'tableau');
    const nouveau = query.nouveau === '1' || query.nouveau === 'true';
    const filtres = {
      statut: query.statut || '', typeCode: query.typeCode || '', prioriteCode: query.prioriteCode || '', secteurId: query.secteurId || '',
      technicienId: query.technicienId || '', du: '', au: '', recherche: '',
      equipementId: !nouveau && query.equipementId ? String(query.equipementId) : '', demandeId: !nouveau && query.demandeId ? String(query.demandeId) : '',
    };

    let onglets = null;
    const setBadgeOnglet = (cle, n) => { if (!onglets) return; onglets.setBadge(cle, n); const b = onglets.el.querySelector(`.onglets button[data-cle="${cle}"] .badge`); if (b) b.classList.toggle('masque', !n); };

    const colonnes = [
      { cle: 'numero', label: 'Numéro', largeur: '120px', rendu: (o) => el('div', { style: { whiteSpace: 'nowrap' } }, el('div', { class: 'cellule-principale' }, o.numero), el('div', { class: 'cellule-secondaire' }, ui.formatDate(o.createdAt))), valeurTri: (o) => o.numero, exportValeur: (o) => o.numero },
      { cle: 'titre', label: 'Intervention', rendu: (o) => el('div', { style: { minWidth: '200px' } }, el('div', { class: 'cellule-principale' }, o.titre),
        el('div', { class: 'cellule-secondaire inline', style: { flexWrap: 'wrap' } }, ui.libelle('typesIntervention', o.typeCode),
          o.demandeNumero ? el('span', { title: 'Demande d\'origine' }, '· ' + o.demandeNumero) : null,
          o.planNumero ? el('span', { title: 'Plan préventif' }, '· ' + o.planNumero) : null,
          o.nbCommentaires ? el('span', { class: 'inline', style: { gap: '3px' }, title: `${o.nbCommentaires} commentaire(s)` }, ico('commentaire', 12), String(o.nbCommentaires)) : null,
          o.nbDocuments ? el('span', { class: 'inline', style: { gap: '3px' }, title: `${o.nbDocuments} document(s)` }, ico('piece_jointe', 12), String(o.nbDocuments)) : null)), exportValeur: (o) => o.titre },
      { cle: 'equipementNom', label: 'Équipement', rendu: lienEquipement, valeurTri: (o) => (o.equipementNom || '').toLowerCase(), exportValeur: (o) => o.equipementNom },
      { cle: 'prioriteCode', label: 'Priorité', liste: 'priorites', aligner: 'centre', valeurTri: (o) => -((ui.itemListe('priorites', o.prioriteCode) || {}).ordre || 0) },
      { cle: 'statut', label: 'Statut', aligner: 'centre', rendu: (o) => el('div', { style: { minWidth: '96px' } }, badgeStatut(o.statut), celluleAvancement(o)), valeurTri: (o) => (st.item(o.statut) || {}).ordre || 0, exportValeur: (o) => st.libelle(o.statut) },
      { cle: 'technicienId', label: 'Technicien', rendu: celluleTechnicien, valeurTri: (o) => (o.technicienNom || 'zzz').toLowerCase(), exportValeur: (o) => o.technicienNom },
      { cle: 'datePrevue', label: 'Date prévue', rendu: celluleDatePrevue, valeurTri: (o) => o.datePrevue || '9999', exportValeur: (o) => dateFr(o.datePrevue) },
      { cle: 'coutTotal', label: 'Coût', aligner: 'droite', rendu: (o) => el('span', { style: { whiteSpace: 'nowrap' } }, ui.formatMontant(o.coutTotal || 0)), valeurTri: (o) => Number(o.coutTotal) || 0, exportValeur: (o) => ui.formatMontant(o.coutTotal || 0) },
    ];
    const tableau = ui.table({
      colonnes, lignes: [], recherche: false, exportCsv: false,
      triInitial: { cle: 'numero', sens: 'desc' },
      onClic: (o) => GMAO.navigate('#/ot/' + o.id),
      ligneClasse: (o) => (o.final ? 'inactif' : ''),
      vide: 'Aucun ordre de travail',
      actions: [
        { icone: 'utilisateur', titre: 'Affecter', visible: (o) => can('affecter') && !o.final && !o.technicienId && !(o.techniciens || []).length, onClic: async (o) => { try { affecterOt(await api.get('/api/ot/' + o.id), rafraichir); } catch (e) { erreur(e); } } },
        { icone: 'modifier', titre: 'Modifier', visible: (o) => can('modifier') && !o.final, onClic: async (o) => { try { ouvrirFormulaire(await api.get('/api/ot/' + o.id), {}, rafraichir); } catch (e) { erreur(e); } } },
      ],
    });
    const zoneKanban = el('div');

    function lignesFiltrees() {
      let rows = ots.slice();
      if (onglet === 'mes') rows = rows.filter((o) => estAffecte(o));
      else if (onglet === 'enCours') rows = rows.filter((o) => !o.final);
      else if (onglet === 'retard') rows = rows.filter((o) => o.enRetard);
      else if (onglet === 'termines') rows = rows.filter((o) => o.final);
      if (filtres.statut) rows = rows.filter((o) => o.statut === filtres.statut);
      if (filtres.typeCode) rows = rows.filter((o) => o.typeCode === filtres.typeCode);
      if (filtres.prioriteCode) rows = rows.filter((o) => o.prioriteCode === filtres.prioriteCode);
      if (filtres.secteurId) {
        const ids = new Set([Number(filtres.secteurId)]);
        let ajout = true;
        while (ajout) { ajout = false; for (const s of GMAO.refs.secteurs || []) if (s.parentId != null && ids.has(Number(s.parentId)) && !ids.has(s.id)) { ids.add(s.id); ajout = true; } }
        rows = rows.filter((o) => o.secteurId != null && ids.has(Number(o.secteurId)));
      }
      if (filtres.technicienId === 'aucun') rows = rows.filter((o) => !o.technicienId && !(o.techniciens || []).length);
      else if (filtres.technicienId) rows = rows.filter((o) => estAffecte(o, Number(filtres.technicienId)));
      if (filtres.equipementId) rows = rows.filter((o) => String(o.equipementId) === filtres.equipementId);
      if (filtres.demandeId) rows = rows.filter((o) => String(o.demandeId) === filtres.demandeId);
      if (filtres.du) rows = rows.filter((o) => o.datePrevue && String(o.datePrevue).slice(0, 10) >= filtres.du);
      if (filtres.au) rows = rows.filter((o) => o.datePrevue && String(o.datePrevue).slice(0, 10) <= filtres.au);
      if (filtres.recherche) {
        const s = filtres.recherche.toLowerCase();
        rows = rows.filter((o) => [o.numero, o.titre, o.description, o.equipementNom, o.equipementNumero, o.technicienNom, (o.techniciensNoms || []).join(' '), o.demandeNumero, o.planNumero, o.secteurChemin, o.rapport].some((v) => String(v || '').toLowerCase().includes(s)));
      }
      return rows;
    }
    function appliquer() {
      const rows = lignesFiltrees();
      if (mode === 'kanban') {
        tableau.el.classList.add('masque');
        zoneKanban.classList.remove('masque');
        ui.vider(zoneKanban);
        zoneKanban.appendChild(rendreKanban(rows, { onDeplacer: deplacer }));
        if (!rows.length) zoneKanban.appendChild(el('p', { class: 'texte-2 texte-petit texte-centre' }, 'Aucun ordre de travail ne correspond aux filtres.'));
      } else {
        zoneKanban.classList.add('masque');
        tableau.el.classList.remove('masque');
        tableau.maj(rows);
      }
      compteur.textContent = `${rows.length} ordre${rows.length > 1 ? 's' : ''} de travail`;
      setBadgeOnglet('mes', ots.filter((o) => estAffecte(o) && !o.final).length);
      setBadgeOnglet('enCours', ots.filter((o) => !o.final).length);
      setBadgeOnglet('retard', ots.filter((o) => o.enRetard).length);
      majPuces();
    }
    async function rafraichir() {
      try {
        [ots, compteurs] = await Promise.all([api.get('/api/ot'), api.get('/api/ot-compteurs')]);
        majBadge(compteurs);
        rendreKpis();
        appliquer();
      } catch (e) { erreur(e); }
    }
    async function deplacer(o, cible) {
      const finalCible = st.estFinal(cible);
      const finalSource = st.estFinal(o.statut);
      if (finalSource && finalCible) return toast('Cet ordre de travail est déjà clôturé', 'alerte');
      if (finalSource) {
        if (!can('modifier')) return toast('La réouverture nécessite le droit « Modifier »', 'alerte');
        if (!(await ui.confirm({ titre: 'Réouvrir l\'ordre de travail', message: `Réouvrir ${o.numero} au statut « ${st.libelle(cible)} » ?`, okLabel: 'Réouvrir' }))) return;
        return changerStatut(o, cible, rafraichir, 'Réouverture depuis le tableau kanban');
      }
      if (finalCible) {
        let detail;
        try { detail = await api.get('/api/ot/' + o.id); } catch (e) { return erreur(e); }
        const act = detail.actions || {};
        if (st.estAnnulation(cible)) { if (!act.annuler) return toast('Droit insuffisant pour annuler cet ordre de travail', 'alerte'); return annulerOt(detail, rafraichir); }
        if (!act.cloturer) return toast('Droit insuffisant pour clôturer cet ordre de travail', 'alerte');
        return cloturerOt(detail, rafraichir);
      }
      if (cible === st.attente) return mettreEnAttente(o, rafraichir);
      return changerStatut(o, cible, rafraichir);
    }

    // Indicateurs
    const kpis = el('div', { class: 'grille grille-4 mb' });
    function rendreKpis() {
      ui.vider(kpis);
      if (!compteurs) return;
      const aller = (cle, statut) => () => { filtres.statut = statut || ''; selStatut.value = filtres.statut; onglets.activer(cle); };
      kpis.appendChild(ui.kpi({ label: 'OT ouverts', valeur: compteurs.ouverts, icone: 'ot', couleur: '#2563eb', detail: compteurs.nonAffectes ? `${compteurs.nonAffectes} non affecté(s)` : 'tous affectés', onClic: aller('enCours') }));
      kpis.appendChild(ui.kpi({ label: 'En cours d\'intervention', valeur: compteurs.enCours, icone: 'lecture', couleur: '#f59e0b', detail: compteurs.enAttente ? `${compteurs.enAttente} en attente` : (compteurs.aujourdhui ? `${compteurs.aujourdhui} prévu(s) aujourd'hui` : ''), onClic: st.enCours ? aller('tous', st.enCours) : aller('enCours') }));
      kpis.appendChild(ui.kpi({ label: 'En retard', valeur: compteurs.enRetard, icone: 'alerte', couleur: compteurs.enRetard ? '#dc2626' : '#16a34a', detail: compteurs.enRetard ? 'date prévue dépassée' : 'aucun retard', onClic: aller('retard') }));
      kpis.appendChild(ui.kpi({ label: 'Mes OT', valeur: compteurs.mesOT, icone: 'utilisateur', couleur: '#8b5cf6', detail: compteurs.mesOTEnRetard ? `${compteurs.mesOTEnRetard} en retard` : `${compteurs.terminesMois} terminé(s) ce mois`, onClic: aller('mes') }));
    }

    // Filtres
    const opt = (o) => el('option', { value: o.value }, o.label);
    const selStatut = el('select', { title: 'Statut', onchange: () => { filtres.statut = selStatut.value; appliquer(); } }, [{ value: '', label: 'Tous les statuts' }].concat(st.liste.map((s) => ({ value: s.code, label: s.label }))).map(opt));
    const selType = el('select', { title: 'Type', onchange: () => { filtres.typeCode = selType.value; appliquer(); } }, ui.optionsListe('typesIntervention', { vide: 'Tous les types' }).map(opt));
    const selPrio = el('select', { title: 'Priorité', onchange: () => { filtres.prioriteCode = selPrio.value; appliquer(); } }, ui.optionsListe('priorites', { vide: 'Toutes les priorités' }).map(opt));
    const selSecteur = el('select', { title: 'Secteur', onchange: () => { filtres.secteurId = selSecteur.value; appliquer(); } }, ui.optionsSecteurs({ vide: 'Tous les secteurs' }).map(opt));
    const selTech = el('select', { title: 'Technicien', onchange: () => { filtres.technicienId = selTech.value; appliquer(); } }, [{ value: '', label: 'Tous les techniciens' }, { value: 'aucun', label: 'Non affectés' }].map(opt));
    chargerTechniciens().then((techs) => { techs.forEach((t) => selTech.appendChild(el('option', { value: String(t.id) }, t.nomComplet))); selTech.value = filtres.technicienId; });
    const inDu = el('input', { type: 'date', title: 'Date prévue à partir du', onchange: () => { filtres.du = inDu.value; appliquer(); } });
    const inAu = el('input', { type: 'date', title: 'Date prévue jusqu\'au', onchange: () => { filtres.au = inAu.value; appliquer(); } });
    const inRecherche = el('input', { type: 'search', placeholder: 'Rechercher (numéro, titre, équipement, technicien)…', style: { maxWidth: '300px' } });
    inRecherche.addEventListener('input', ui.debounce(() => { filtres.recherche = inRecherche.value.trim(); appliquer(); }, 200));
    [[selStatut, 'statut'], [selType, 'typeCode'], [selPrio, 'prioriteCode'], [selSecteur, 'secteurId']].forEach(([s, k]) => { s.value = filtres[k]; });
    const btnReinit = el('button', { type: 'button', class: 'btn btn-sm', title: 'Réinitialiser les filtres', onclick: () => {
      [selStatut, selType, selPrio, selSecteur, selTech, inDu, inAu, inRecherche].forEach((x) => { x.value = ''; });
      Object.keys(filtres).forEach((k) => { filtres[k] = ''; });
      appliquer();
    } }, ico('filtre'), 'Réinitialiser');
    const compteur = el('span', { class: 'texte-2 texte-petit' });
    const btnTableau = el('button', { type: 'button', class: 'btn btn-sm', title: 'Vue tableau', onclick: () => basculer('tableau') }, icone('liste'), 'Tableau');
    const btnKanban = el('button', { type: 'button', class: 'btn btn-sm', title: 'Vue kanban par statut', onclick: () => basculer('kanban') }, icone('dashboard'), 'Kanban');
    function basculer(m) {
      mode = m; ecrireLocal('gmao.ot.vue', m);
      btnTableau.classList.toggle('actif', m === 'tableau'); btnKanban.classList.toggle('actif', m === 'kanban');
      appliquer();
    }
    btnTableau.classList.toggle('actif', mode === 'tableau'); btnKanban.classList.toggle('actif', mode === 'kanban');
    const puces = el('div', { class: 'inline', style: { flexWrap: 'wrap', gap: '6px' } });
    function majPuces() {
      ui.vider(puces);
      const puce = (texte, retirer) => el('span', { class: 'badge contour', style: { color: 'var(--primaire)', display: 'inline-flex', alignItems: 'center', gap: '4px' } }, texte, el('button', { type: 'button', class: 'btn-lien', style: { border: 0, background: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }, title: 'Retirer ce filtre', onclick: retirer }, '×'));
      if (filtres.equipementId) {
        const o = ots.find((x) => String(x.equipementId) === filtres.equipementId);
        puces.appendChild(puce(`Équipement : ${o ? o.equipementNom : '#' + filtres.equipementId}`, () => { filtres.equipementId = ''; history.replaceState(null, '', '#/ot'); appliquer(); }));
      }
      if (filtres.demandeId) puces.appendChild(puce(`Demande #${filtres.demandeId}`, () => { filtres.demandeId = ''; history.replaceState(null, '', '#/ot'); appliquer(); }));
    }
    const barreFiltres = el('div', { class: 'barre-outils' }, inRecherche, selStatut, selType, selPrio, selSecteur, selTech,
      el('label', { class: 'inline', style: { whiteSpace: 'nowrap' } }, 'Prévu du', inDu), el('label', { class: 'inline' }, 'au', inAu), btnReinit,
      el('span', { class: 'espace' }), compteur, el('div', { class: 'btn-groupe' }, btnTableau, btnKanban),
      el('button', { type: 'button', class: 'btn btn-sm btn-icone', title: 'Actualiser', onclick: rafraichir }, icone('rafraichir')));
    const contenu = el('div', null, barreFiltres, puces, tableau.el, zoneKanban);
    const rendreOnglet = (cle) => () => { onglet = cle; appliquer(); return contenu; };
    onglets = ui.onglets([
      { cle: 'tous', label: 'Tous', icone: 'liste', rendu: rendreOnglet('tous') },
      { cle: 'mes', label: 'Mes OT', icone: 'utilisateur', rendu: rendreOnglet('mes') },
      { cle: 'enCours', label: 'En cours', icone: 'lecture', rendu: rendreOnglet('enCours') },
      { cle: 'retard', label: 'En retard', icone: 'alerte', rendu: rendreOnglet('retard') },
      { cle: 'termines', label: 'Terminés', icone: 'check', rendu: rendreOnglet('termines') },
    ], { actif: onglet });

    function exporter() {
      const q = new URLSearchParams();
      for (const k of ['statut', 'typeCode', 'prioriteCode', 'secteurId', 'technicienId', 'du', 'au', 'equipementId', 'demandeId', 'recherche']) if (filtres[k]) q.set(k, filtres[k]);
      if (onglet === 'mes') q.set('mesOT', '1');
      if (onglet === 'enCours') q.set('ouverts', '1');
      if (onglet === 'retard') q.set('enRetard', '1');
      if (onglet === 'termines') q.set('finaux', '1');
      api.telecharger('/api/ot-export' + (q.toString() ? '?' + q.toString() : ''), `ordres-de-travail-${ui.aujourdhui()}.csv`).then(() => toast('Export CSV généré', 'succes')).catch(erreur);
    }

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(ENTITE), icone: 'ot', sousTitre: 'Planification, réalisation et suivi des interventions de maintenance',
      actions: [
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: exporter }) : null,
        can('creer') ? ui.bouton('Nouvel OT', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, {}, (res) => GMAO.navigate('#/ot/' + res.id)) }) : null,
      ],
    }));
    container.appendChild(kpis);
    container.appendChild(onglets.el);
    await rafraichir();

    if (nouveau) {
      history.replaceState(null, '', '#/ot');
      ouvrirFormulaire(null, {
        equipementId: query.equipementId ? Number(query.equipementId) : null, demandeId: query.demandeId ? Number(query.demandeId) : null,
        planPreventifId: query.planPreventifId ? Number(query.planPreventifId) : null, secteurId: query.secteurId ? Number(query.secteurId) : null,
        datePrevue: query.datePrevue || '',
      }, (res) => GMAO.navigate('#/ot/' + res.id));
    }
  }

  GMAO.registerView(ENTITE, {
    titre: 'Ordres de travail', icone: 'ot',
    async rendu(container, { params, query }) {
      if (params[0]) await rendreFiche(container, params[0]);
      else await rendreListe(container, query || {});
    },
  });

  // Badge « en retard » dans la navigation, mis à jour hors de la vue OT (au plus une fois par minute)
  function majBadgeSiNecessaire() {
    if (!GMAO.user || !GMAO.perms || !GMAO.can(ENTITE, 'voir')) return;
    if (Date.now() - derniereMajBadge < 60000) return;
    majBadge();
  }
  window.addEventListener('hashchange', majBadgeSiNecessaire);
  setTimeout(majBadgeSiNecessaire, 1500);
  setInterval(majBadgeSiNecessaire, 120000);
})();
