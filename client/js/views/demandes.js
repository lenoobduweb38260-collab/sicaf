/**
 * Vue Demandes d'intervention (DI) : liste par onglets (toutes, à valider, mes demandes, en cours,
 * clôturées), filtres, fiche détaillée #/demandes/:id (détails, chronologie, commentaires, pièces
 * jointes, actions de workflow), formulaire de création / modification, export CSV.
 * Support de #/demandes?nouveau=1&equipementId=ID (formulaire pré-rempli).
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const ENTITE = 'demandes';
  const S = { soumise: 'soumise', validee: 'validee', refusee: 'refusee', convertie: 'convertie', cloturee: 'cloturee' };
  const TAILLE_MAX_PJ = 5 * 1024 * 1024;
  const wf = () => (GMAO.config.workflow || {});
  const can = (a) => GMAO.can(ENTITE, a);
  /** Icône dimensionnée explicitement (hors boutons, le CSS cœur ne fixe pas la taille des SVG). */
  function ico(nomIcone, px = 14) { const svg = icone(nomIcone); Object.assign(svg.style, { width: px + 'px', height: px + 'px', flexShrink: '0' }); return svg; }

  // ----- Utilitaires ---------------------------------------------------------
  function statutsFinaux() {
    const l = GMAO.liste('statutsDemande').filter((s) => s.final).map((s) => s.code);
    return new Set(l.length ? l : [S.refusee, S.cloturee]);
  }
  function codeParDefaut(liste, voulu) {
    const l = GMAO.liste(liste);
    if (!l.length) return voulu;
    return l.some((x) => x.code === voulu) ? voulu : l[0].code;
  }
  function lienOt(d) {
    const id = d.otId || (d.ot && d.ot.id);
    const numero = d.otNumero || (d.ot && d.ot.numero);
    if (!id) return el('span', { class: 'texte-2' }, '—');
    return el('a', { href: '#/ot/' + id, class: 'inline', title: 'Ouvrir l\'ordre de travail', onclick: (ev) => ev.stopPropagation() }, ico('ot'), numero || ('OT #' + id));
  }
  function lienEquipement(d) {
    const id = d.equipementId || (d.equipement && d.equipement.id);
    const nomEq = d.equipementNom || (d.equipement && d.equipement.nom);
    const numero = d.equipementNumero || (d.equipement && d.equipement.numero);
    if (!id) return el('span', { class: 'texte-2' }, d.secteurChemin ? 'Sans équipement · ' + d.secteurChemin : 'Sans équipement');
    return el('a', { href: '#/equipements/' + id, title: 'Ouvrir la fiche équipement', onclick: (ev) => ev.stopPropagation() }, el('div', { class: 'cellule-principale' }, nomEq || ('#' + id)), el('div', { class: 'cellule-secondaire' }, [numero, d.secteurChemin].filter(Boolean).join(' · ')));
  }
  function badgeArret(d) { return d.arretProduction ? ui.badge('Arrêt de production', '#dc2626', { contour: true, titre: 'Équipement à l\'arrêt : production impactée' }) : null; }
  function majBadgeNavigation(compteurs) {
    if (!can('valider')) { GMAO.setNavBadge(ENTITE, 0); return; }
    GMAO.setNavBadge(ENTITE, compteurs ? compteurs.aValider : 0);
  }
  async function rafraichirBadge() {
    if (!can('valider')) return;
    try { majBadgeNavigation(await api.get('/api/demandes-compteurs')); } catch (e) { /* silencieux */ }
  }

  // ----- Formulaire de création / modification -------------------------------
  let equipementsCache = null;
  async function chargerEquipements() {
    if (equipementsCache) return equipementsCache;
    try { equipementsCache = await api.get('/api/equipements', { actif: '1' }); } catch (e) { equipementsCache = []; }
    setTimeout(() => { equipementsCache = null; }, 60000);
    return equipementsCache;
  }
  /** <select> des équipements regroupés par secteur (optgroup). */
  function selectEquipements(equipements, valeur, existantId) {
    const sel = el('select', { id: 'f_equipementId' });
    sel.appendChild(el('option', { value: '' }, '— Aucun équipement (demande générale) —'));
    const groupes = new Map();
    for (const e of equipements) { const k = e.secteurId == null ? 0 : Number(e.secteurId); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(e); }
    const ordreSecteur = (id) => { const s = ui.secteur(id); return s ? (s.ordre || 0) : 999; };
    const cles = Array.from(groupes.keys()).sort((a, b) => ordreSecteur(a) - ordreSecteur(b) || ui.cheminSecteur(a).localeCompare(ui.cheminSecteur(b)));
    for (const k of cles) {
      const og = el('optgroup', { label: k ? ui.cheminSecteur(k) : 'Sans secteur' });
      groupes.get(k).sort((a, b) => String(a.nom).localeCompare(String(b.nom))).forEach((e) => og.appendChild(el('option', { value: String(e.id) }, `${e.nom}${e.numero ? ' (' + e.numero + ')' : ''}${e.parentNom ? ' — ' + e.parentNom : ''}`)));
      sel.appendChild(og);
    }
    if (valeur != null && valeur !== '') {
      sel.value = String(valeur);
      if (sel.value !== String(valeur)) { sel.appendChild(el('option', { value: String(valeur) }, existantId ? 'Équipement actuel (#' + valeur + ')' : 'Équipement #' + valeur)); sel.value = String(valeur); }
    }
    return sel;
  }

  async function ouvrirFormulaire(existant, opts = {}, apres) {
    if (!can('creer') && !existant) return toast('Vous n\'avez pas le droit de créer une demande', 'alerte');
    const creation = !existant;
    const equipements = await chargerEquipements();
    const eqInitial = existant ? existant.equipementId : (opts.equipementId || null);
    const selEq = selectEquipements(equipements, eqInitial, existant ? existant.id : null);
    if (!creation && existant.statut !== S.soumise) { selEq.disabled = true; selEq.title = 'L\'équipement ne peut plus être modifié après validation'; }
    const infoEq = el('div', { class: 'aide' });
    let formRef = null;
    const majInfo = () => {
      const e = equipements.find((x) => String(x.id) === selEq.value);
      ui.vider(infoEq);
      if (e) infoEq.append(frag(e.secteurChemin || e.secteurNom ? `Secteur : ${e.secteurChemin || e.secteurNom}` : 'Équipement sans secteur', e.localisation ? ` · ${e.localisation}` : '', e.etatCode ? frag(' · ', ui.badgeListe('etatsEquipement', e.etatCode)) : null));
      else if (!equipements.length) infoEq.textContent = 'Aucun équipement disponible : la demande sera rattachée à un secteur.';
      else infoEq.textContent = 'Choisissez l\'équipement concerné ; le secteur de la demande en est déduit.';
      const champSecteur = formRef && formRef.champ('secteurId');
      if (champSecteur) champSecteur.classList.toggle('masque', !!e);
    };
    selEq.addEventListener('change', majInfo);
    const priorites = GMAO.liste('priorites');
    const aidePriorite = priorites.filter((p) => p.delaiHeures).map((p) => `${p.label} : ${p.delaiHeures} h`).join(' · ');
    const champs = [
      { nom: 'titre', label: 'Titre de la demande', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'ex. Fuite d\'huile sur la presse hydraulique', maxLength: 200 },
      { type: 'html', label: 'Équipement concerné', rendu: (f) => { formRef = f; setTimeout(majInfo, 0); return frag(selEq, infoEq); } },
      { nom: 'secteurId', label: 'Secteur (si aucun équipement)', type: 'select', options: ui.optionsSecteurs({ vide: '— Aucun —' }), aide: 'Utilisé pour la portée et le choix des valideurs' },
      { nom: 'typeCode', label: 'Type d\'intervention', type: 'select', requis: true, options: ui.optionsListe('typesIntervention', { vide: false }) },
      { nom: 'prioriteCode', label: 'Priorité', type: 'select', requis: true, options: ui.optionsListe('priorites', { vide: false }), aide: aidePriorite ? 'Délais de traitement — ' + aidePriorite : '' },
      { nom: 'description', label: 'Description du problème', type: 'texte_long', lignes: 5, placeholder: 'Symptômes constatés, circonstances, conséquences pour la production…' },
      { nom: 'arretProduction', label: 'Arrêt de production (équipement immobilisé)', type: 'interrupteur', sansDecalage: true },
      can('modifier') ? { nom: 'demandeurId', label: 'Demandeur', type: 'select', options: ui.optionsUsers({ vide: false }), aide: 'Par défaut : vous-même' } : null,
      creation ? { nom: 'pieceJointe', label: 'Pièce jointe (photo, document — 5 Mo max.)', type: 'fichier', tailleMax: TAILLE_MAX_PJ } : null,
      ...ui.champsPersoDefs(ENTITE),
    ];
    const valeurs = existant
      ? Object.assign({}, existant, { secteurId: existant.equipementId ? '' : (existant.secteurId == null ? '' : existant.secteurId) }, ui.champsPersoInitiaux(existant))
      : { typeCode: codeParDefaut('typesIntervention', 'correctif'), prioriteCode: codeParDefaut('priorites', 'normale'), demandeurId: GMAO.user.id, arretProduction: false, secteurId: opts.secteurId == null ? '' : opts.secteurId };
    ui.formModal({
      titre: creation ? 'Nouvelle demande d\'intervention' : `Modifier ${existant.numero}`, taille: 'large', champs, valeurs,
      submitLabel: creation ? 'Soumettre la demande' : 'Enregistrer',
      avant: creation && wf().validationDemandes === false ? ui.alerte('Le circuit de validation est désactivé : la demande sera validée immédiatement' + (wf().otAutoDepuisDemande !== false ? ' et un ordre de travail sera créé automatiquement.' : '.'), 'info') : null,
      onSubmit: async (v) => {
        const body = {
          titre: v.titre, description: v.description, typeCode: v.typeCode, prioriteCode: v.prioriteCode, arretProduction: !!v.arretProduction,
          equipementId: selEq.value ? Number(selEq.value) : null,
          secteurId: selEq.value ? null : (v.secteurId === '' || v.secteurId == null ? null : v.secteurId),
          champs: ui.champsPersoValeurs(v),
        };
        if (!creation && selEq.disabled) delete body.equipementId;
        if (v.demandeurId !== undefined && v.demandeurId !== '' && v.demandeurId != null) body.demandeurId = v.demandeurId;
        if (creation && v.pieceJointe && v.pieceJointe.contenu) body.pieceJointes = [v.pieceJointe];
        const res = creation ? await api.post('/api/demandes', body) : await api.put('/api/demandes/' + existant.id, body);
        if (res.avertissement) toast(res.avertissement, 'alerte', 8000);
        toast(creation ? `Demande ${res.numero} ${res.statut === S.soumise ? 'soumise' : 'créée'}${res.otCree ? ' — ordre de travail ' + res.otCree.numero + ' généré' : ''}` : 'Demande enregistrée', 'succes');
        rafraichirBadge();
        if (apres) apres(res);
      },
    });
  }

  // ----- Actions de workflow -------------------------------------------------
  async function validerDemande(d, apres) {
    const auto = wf().otAutoDepuisDemande !== false;
    ui.formModal({
      titre: `Valider la demande ${d.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Valider',
      avant: ui.alerte(auto ? 'La validation créera automatiquement un ordre de travail à partir de cette demande.' : 'La demande sera validée ; vous pourrez ensuite la convertir en ordre de travail.', 'info'),
      champs: [{ nom: 'commentaire', label: 'Commentaire (facultatif)', type: 'texte_long', lignes: 3, placeholder: 'Consignes pour l\'intervention…' }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/demandes/${d.id}/valider`, { commentaire: v.commentaire });
        toast(r.otCree ? `Demande validée — ordre de travail ${r.otCree.numero} créé` : 'Demande validée', 'succes');
        if (r.avertissement) toast(r.avertissement, 'alerte', 8000);
        rafraichirBadge();
        if (apres) apres(r);
      },
    });
  }
  async function refuserDemande(d, apres) {
    ui.formModal({
      titre: `Refuser la demande ${d.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Refuser',
      champs: [{ nom: 'motif', label: 'Motif du refus', type: 'texte_long', lignes: 4, requis: true, placeholder: 'Le motif est communiqué au demandeur' }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/demandes/${d.id}/refuser`, { motif: v.motif });
        toast('Demande refusée', 'succes');
        rafraichirBadge();
        if (apres) apres(r);
      },
    });
  }
  async function convertirDemande(d, apres) {
    if (!(await ui.confirm({ titre: 'Convertir en ordre de travail', message: `Créer un ordre de travail à partir de la demande ${d.numero} « ${d.titre} » ? Le type, la priorité, l'équipement et la description seront repris.`, okLabel: 'Créer l\'OT' }))) return;
    try {
      const r = await api.post(`/api/demandes/${d.id}/convertir`, {});
      toast(`Ordre de travail ${r.otCree ? r.otCree.numero : ''} créé`, 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }
  async function cloturerDemande(d, apres) {
    ui.formModal({
      titre: `Clôturer la demande ${d.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Clôturer',
      avant: d.otId && d.otStatut && !['termine', 'annule'].includes(d.otStatut) ? ui.alerte('Un ordre de travail est encore ouvert pour cette demande.', 'alerte') : null,
      champs: [{ nom: 'commentaire', label: 'Commentaire de clôture (facultatif)', type: 'texte_long', lignes: 3 }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/demandes/${d.id}/cloturer`, { commentaire: v.commentaire });
        toast('Demande clôturée', 'succes');
        if (apres) apres(r);
      },
    });
  }
  async function reouvrirDemande(d, apres) {
    ui.formModal({
      titre: `Réouvrir la demande ${d.numero}`, taille: 'petite', colonnes: 1, submitLabel: 'Réouvrir',
      avant: ui.alerte(d.statut === S.refusee ? 'La demande repassera au statut « soumise » et sera de nouveau proposée aux valideurs.' : 'La demande reprendra son statut précédent (validée ou convertie).', 'info'),
      champs: [{ nom: 'commentaire', label: 'Motif de la réouverture (facultatif)', type: 'texte_long', lignes: 3 }],
      onSubmit: async (v) => {
        const r = await api.post(`/api/demandes/${d.id}/reouvrir`, { commentaire: v.commentaire });
        toast('Demande réouverte', 'succes');
        rafraichirBadge();
        if (apres) apres(r);
      },
    });
  }
  async function supprimerDemande(d, apres) {
    if (!(await ui.confirm({ titre: 'Supprimer la demande', message: `Supprimer définitivement la demande ${d.numero} « ${d.titre} » ? Cette action est irréversible.`, okLabel: 'Supprimer', danger: true }))) return;
    try {
      await api.del('/api/demandes/' + d.id);
      toast('Demande supprimée', 'succes');
      rafraichirBadge();
      if (apres) apres();
    } catch (e) { erreur(e); }
  }
  function ajouterPieceJointe(d, apres) {
    ui.formModal({
      titre: 'Ajouter une pièce jointe', taille: 'petite', colonnes: 1, submitLabel: 'Ajouter',
      champs: [
        { nom: 'fichier', label: 'Fichier (5 Mo max.)', type: 'fichier', requis: true, tailleMax: TAILLE_MAX_PJ },
        { nom: 'description', label: 'Description', type: 'texte', placeholder: 'ex. Photo du constat' },
      ],
      onSubmit: async (v) => {
        if (!v.fichier || !v.fichier.contenu) throw new Error('Choisissez un fichier');
        const r = await api.post(`/api/demandes/${d.id}/documents`, Object.assign({}, v.fichier, { description: v.description }));
        toast('Pièce jointe ajoutée', 'succes');
        if (apres) apres(r);
      },
    });
  }

  // ----- Fiche détaillée -----------------------------------------------------
  function imprimerFiche(d) {
    const esc = ui.esc;
    const lignes = [
      ['Numéro', d.numero], ['Titre', d.titre], ['Statut', ui.libelle('statutsDemande', d.statut)], ['Priorité', ui.libelle('priorites', d.prioriteCode)], ['Type', ui.libelle('typesIntervention', d.typeCode)],
      ['Équipement', d.equipement ? `${d.equipement.numero || ''} ${d.equipement.nom}`.trim() : '—'], ['Secteur', d.secteurChemin || '—'], ['Demandeur', d.demandeurNom || '—'], ['Date de la demande', ui.formatDateHeure(d.dateDemande)],
      ['Arrêt de production', d.arretProduction ? 'Oui' : 'Non'], ['Validateur', d.validateurNom || '—'], ['Date de validation', ui.formatDateHeure(d.dateValidation) || '—'], ['Motif de refus', d.motifRefus || '—'], ['Ordre de travail', d.ot ? d.ot.numero : '—'], ['Date de clôture', ui.formatDateHeure(d.dateCloture) || '—'],
    ].concat(ui.champsPersoAffichage(ENTITE, d).map((c) => [c.label, c.valeur]));
    const html = `<h1>Demande d'intervention ${esc(d.numero)}</h1><h2>Informations</h2><dl>${lignes.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h2>Description</h2><p>${esc(d.description || '—').replace(/\n/g, '<br>')}</p>
      <h2>Chronologie</h2><table><tr><th>Date</th><th>Étape</th><th>Par</th><th>Commentaire</th></tr>${(d.historique || []).map((h) => `<tr><td>${esc(ui.formatDateHeure(h.date))}</td><td>${esc(h.libelle)}</td><td>${esc(h.userNom)}</td><td>${esc(h.commentaire || '')}</td></tr>`).join('')}</table>
      ${(d.commentaires || []).length ? `<h2>Commentaires</h2><table><tr><th>Date</th><th>Auteur</th><th>Commentaire</th></tr>${d.commentaires.map((c) => `<tr><td>${esc(ui.formatDateHeure(c.date))}</td><td>${esc(c.userNom)}</td><td>${esc(c.texte)}</td></tr>`).join('')}</table>` : ''}
      <div class="signature"><div>Demandeur</div><div>Validateur</div></div>`;
    ui.imprimer(`Demande ${d.numero}`, html);
  }

  function rendreChronologie(d) {
    const etapes = (d.historique || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!etapes.length) return ui.vide('Aucune étape enregistrée', 'horloge');
    const couleurs = { creation: '#6b7280', validation: '#2563eb', refus: '#dc2626', conversion: '#f59e0b', cloture: '#16a34a', reouverture: '#8b5cf6', modification: '#9ca3af', ot_annule: '#dc2626' };
    return el('ul', { class: 'chronologie' }, etapes.map((h) => el('li', null,
      el('div', { class: 'inline' }, ui.pastille(couleurs[h.action] || '#2563eb'), el('span', { class: 'texte-gras' }, h.libelle || h.action), h.statut ? ui.badgeListe('statutsDemande', h.statut) : null),
      el('div', { class: 'chrono-date' }, `${ui.formatDateHeure(h.date)} · ${h.userNom || 'Système'}`),
      h.commentaire ? el('div', { class: 'texte-2', style: { whiteSpace: 'pre-wrap', marginTop: '2px' } }, h.commentaire) : null)));
  }

  function rendreCommentaires(d, cont, recharger) {
    ui.vider(cont);
    const liste = el('div', { class: 'commentaires' });
    if (!(d.commentaires || []).length) liste.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucun commentaire pour le moment.'));
    for (const c of (d.commentaires || [])) {
      liste.appendChild(el('div', { class: 'commentaire' }, el('div', { class: 'inline' }, ui.avatar(c.userNom || '?', 24), el('span', { class: 'c-auteur' }, c.userNom || ('#' + c.userId)), el('span', { class: 'c-date', title: ui.formatDateHeure(c.date) }, ui.relatif(c.date))), el('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, c.texte)));
    }
    cont.appendChild(liste);
    if (d.actions && d.actions.commenter) {
      const ta = el('textarea', { rows: 3, placeholder: 'Ajouter un commentaire (visible par le demandeur et les valideurs)…', style: { width: '100%' } });
      const btn = el('button', { type: 'button', class: 'btn btn-primaire btn-sm', onclick: async () => {
        const texte = ta.value.trim();
        if (!texte) return toast('Saisissez un commentaire', 'alerte');
        btn.disabled = true;
        try { await api.post(`/api/demandes/${d.id}/commentaires`, { texte }); toast('Commentaire ajouté', 'succes'); recharger(); } catch (e) { erreur(e); } finally { btn.disabled = false; }
      } }, icone('commentaire'), 'Commenter');
      ta.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') btn.click(); });
      cont.appendChild(el('div', { class: 'mt' }, ta, el('div', { class: 'mt', style: { display: 'flex', justifyContent: 'flex-end' } }, btn)));
    }
  }

  function rendrePiecesJointes(d, cont, recharger) {
    ui.vider(cont);
    const pjs = d.pieceJointes || [];
    if (!pjs.length) cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucune pièce jointe.'));
    const tailleLisible = (t) => (t > 1024 * 1024 ? (t / 1024 / 1024).toFixed(1) + ' Mo' : Math.max(1, Math.round(t / 1024)) + ' Ko');
    for (const p of pjs) {
      const url = `/api/demandes/${d.id}/documents/${p.index}`;
      cont.appendChild(el('div', { class: 'inline', style: { gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--bordure)', width: '100%' } },
        /^image\//.test(p.type || '') ? el('img', { src: url, alt: p.nom, style: { width: '48px', height: '48px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--bordure)' } }) : el('span', { class: 'inline', style: { color: 'var(--primaire)', width: '48px', height: '48px', justifyContent: 'center', background: 'var(--primaire-clair)', borderRadius: '6px' } }, ico('piece_jointe', 22)),
        el('div', { style: { flex: 1, minWidth: 0 } }, el('a', { href: url, target: '_blank', class: 'texte-gras' }, p.nom), el('div', { class: 'texte-2 texte-petit' }, [p.description, tailleLisible(p.taille), `${p.userNom || ''} · ${ui.formatDateHeure(p.date)}`].filter(Boolean).join(' · '))),
        el('a', { href: url + '?telecharger=1', class: 'btn btn-icone btn-sm', title: 'Télécharger' }, icone('export')),
        d.actions && d.actions.joindre ? el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer', onclick: async () => {
          if (!(await ui.confirm({ titre: 'Supprimer la pièce jointe', message: `Supprimer « ${p.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { await api.del(`/api/demandes/${d.id}/documents/${p.index}`); toast('Pièce jointe supprimée', 'succes'); recharger(); } catch (e) { erreur(e); }
        } }, icone('supprimer')) : null));
    }
  }

  async function rendreFiche(container, id) {
    let d;
    try { d = await api.get('/api/demandes/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: 'Demande introuvable', icone: 'demandes', filAriane: [{ label: GMAO.moduleLabel(ENTITE), href: '#/demandes' }, { label: '#' + id }] }));
      container.appendChild(ui.vide(e.message || 'Cette demande n\'existe pas ou n\'est pas dans votre portée.', 'alerte'));
      return;
    }
    const a = d.actions || {};
    const recharger = () => GMAO.navigate('#/demandes/' + d.id);
    const actions = [
      a.valider ? ui.bouton('Valider', { icone: 'check', classe: 'btn-ok', onClic: () => validerDemande(d, recharger) }) : null,
      a.refuser ? ui.bouton('Refuser', { icone: 'fermer', classe: 'btn-danger', onClic: () => refuserDemande(d, recharger) }) : null,
      a.convertir ? ui.bouton('Convertir en OT', { icone: 'ot', classe: 'btn-primaire', onClic: () => convertirDemande(d, recharger), disabled: !a.otDisponible, titre: a.otDisponible ? '' : 'Module Ordres de travail indisponible' }) : null,
      a.cloturer ? ui.bouton('Clôturer', { icone: 'check', onClic: () => cloturerDemande(d, recharger) }) : null,
      a.reouvrir ? ui.bouton('Réouvrir', { icone: 'rafraichir', onClic: () => reouvrirDemande(d, recharger) }) : null,
      a.modifier ? ui.bouton('Modifier', { icone: 'modifier', onClic: () => ouvrirFormulaire(d, {}, recharger) }) : null,
      ui.bouton('Imprimer', { icone: 'imprimer', onClic: () => imprimerFiche(d) }),
      a.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'texte-danger', onClic: () => supprimerDemande(d, () => GMAO.navigate('#/demandes')) }) : null,
    ];
    container.appendChild(ui.pageEntete({
      titre: `${d.numero} — ${d.titre}`, icone: 'demandes', actions,
      filAriane: [{ label: GMAO.moduleLabel(ENTITE), href: '#/demandes' }, { label: d.numero }],
      sousTitre: el('span', { class: 'inline', style: { flexWrap: 'wrap' } }, ui.badgeListe('statutsDemande', d.statut), ui.badgeListe('priorites', d.prioriteCode), ui.badgeListe('typesIntervention', d.typeCode), badgeArret(d), el('span', null, `Demandée par ${d.demandeurNom || '—'} ${ui.relatif(d.dateDemande)}`)),
    }));
    if (d.enRetard) container.appendChild(ui.alerte(`Délai de traitement dépassé : échéance ${ui.formatDateHeure(d.echeance)} (priorité ${ui.libelle('priorites', d.prioriteCode)}).`, 'alerte'));
    if (d.statut === S.refusee && d.motifRefus) container.appendChild(ui.alerte(frag(el('strong', null, 'Demande refusée'), ` par ${d.validateurNom || '—'} le ${ui.formatDateHeure(d.dateValidation)} : `, d.motifRefus), 'alerte'));
    if (d.statut === S.soumise && (d.valideurs || []).length) container.appendChild(ui.alerte(el('span', { class: 'inline' }, ico('horloge', 16), el('span', null, 'En attente de validation par : ', el('strong', null, d.valideurs.map((u) => u.nomComplet).join(', ')))), 'info'));
    if (d.statut === S.soumise && !(d.valideurs || []).length && wf().validationDemandes !== false) container.appendChild(ui.alerte('Aucun valideur habilité n\'a été trouvé pour cette demande (vérifiez les droits et les secteurs des valideurs, ou l\'option « valider par le supérieur uniquement »).', 'alerte'));

    const details = ui.details([
      { label: 'Statut', valeur: ui.badgeListe('statutsDemande', d.statut) }, { label: 'Priorité', valeur: frag(ui.badgeListe('priorites', d.prioriteCode), d.echeance && !d.final ? el('span', { class: 'texte-2 texte-petit ml' }, 'échéance ' + ui.formatDateHeure(d.echeance)) : null) },
      { label: 'Type', valeur: ui.badgeListe('typesIntervention', d.typeCode) }, { label: 'Arrêt de production', valeur: d.arretProduction ? el('span', { class: 'texte-danger texte-gras' }, 'Oui') : 'Non' },
      { label: 'Équipement', valeur: d.equipement ? frag(el('a', { href: '#/equipements/' + d.equipement.id }, `${d.equipement.nom}`), el('span', { class: 'texte-2' }, ` (${d.equipement.numero || '#' + d.equipement.id})`), d.equipement.etatCode ? frag(' ', ui.badgeListe('etatsEquipement', d.equipement.etatCode)) : null) : '—' },
      { label: 'Secteur', valeur: d.secteurChemin || '—' },
      { label: 'Demandeur', valeur: d.demandeur ? frag(ui.avatar(d.demandeur.nomComplet, 22), ' ', d.demandeur.nomComplet, d.demandeur.fonction ? el('span', { class: 'texte-2' }, ` · ${d.demandeur.fonction}`) : null) : d.demandeurNom },
      { label: 'Date de la demande', valeur: ui.formatDateHeure(d.dateDemande) },
      { label: 'Validateur', valeur: d.validateur ? d.validateur.nomComplet : '—' }, { label: 'Date de validation', valeur: ui.formatDateHeure(d.dateValidation) || '—' },
      { label: 'Ordre de travail', valeur: d.ot ? frag(lienOt(d), ' ', ui.badgeListe('statutsOT', d.ot.statut), d.ot.technicienId ? el('span', { class: 'texte-2' }, ` · ${ui.nomUser(d.ot.technicienId)}`) : null) : '—' },
      { label: 'Date de clôture', valeur: ui.formatDateHeure(d.dateCloture) || '—' },
      d.motifRefus ? { label: 'Motif du refus', valeur: d.motifRefus } : null,
      { label: 'Créée le', valeur: `${ui.formatDateHeure(d.createdAt)} par ${ui.nomUser(d.createdBy)}` },
      ...ui.champsPersoAffichage(ENTITE, d),
    ], { colonnes: 2 });

    const contCommentaires = el('div');
    const contPj = el('div');
    container.appendChild(el('div', { class: 'grille grille-2' },
      el('div', null,
        ui.carte('Informations', details),
        ui.carte('Description', el('div', { style: { whiteSpace: 'pre-wrap' } }, d.description || el('span', { class: 'texte-2' }, 'Aucune description'))),
      ),
      el('div', null,
        ui.carte('Chronologie', rendreChronologie(d)),
        ui.carte(`Pièces jointes (${(d.pieceJointes || []).length})`, contPj, { actions: a.joindre ? [ui.bouton('Ajouter', { icone: 'plus', classe: 'btn-sm', onClic: () => ajouterPieceJointe(d, recharger) })] : null }),
      )));
    container.appendChild(ui.carte(`Commentaires (${(d.commentaires || []).length})`, contCommentaires));
    rendreCommentaires(d, contCommentaires, recharger);
    rendrePiecesJointes(d, contPj, recharger);
  }

  // ----- Liste ---------------------------------------------------------------
  async function rendreListe(container, query) {
    let demandes = [];
    let compteurs = null;
    let onglet = query.onglet || (can('valider') ? 'toutes' : 'toutes');
    const filtres = { prioriteCode: '', statut: '', secteurId: '', du: '', au: '', arret: false };
    const finaux = statutsFinaux();
    const moi = GMAO.user.id;

    let onglets = null;
    const setBadgeOnglet = (cle, n) => { if (!onglets) return; onglets.setBadge(cle, n); const b = onglets.el.querySelector(`.onglets button[data-cle="${cle}"] .badge`); if (b) b.classList.toggle('masque', !n); };
    const colonnes = [
      { cle: 'numero', label: 'Numéro', rendu: (d) => el('div', null, el('div', { class: 'cellule-principale' }, d.numero), el('div', { class: 'cellule-secondaire' }, ui.formatDate(d.dateDemande))), valeurTri: (d) => d.numero, largeur: '130px' },
      { cle: 'titre', label: 'Titre', rendu: (d) => el('div', null, el('div', { class: 'cellule-principale' }, d.titre), el('div', { class: 'cellule-secondaire inline' }, ui.libelle('typesIntervention', d.typeCode), badgeArret(d), d.nbCommentaires ? el('span', { class: 'inline', style: { gap: '3px' }, title: `${d.nbCommentaires} commentaire(s)` }, ico('commentaire', 12), String(d.nbCommentaires)) : null, d.nbPieceJointes ? el('span', { class: 'inline', style: { gap: '3px' }, title: `${d.nbPieceJointes} pièce(s) jointe(s)` }, ico('piece_jointe', 12), String(d.nbPieceJointes)) : null)), valeurTri: (d) => String(d.titre).toLowerCase() },
      { cle: 'equipementNom', label: 'Équipement', rendu: lienEquipement, valeurTri: (d) => (d.equipementNom || '').toLowerCase() },
      { cle: 'prioriteCode', label: 'Priorité', liste: 'priorites', aligner: 'centre', rendu: (d) => frag(ui.badgeListe('priorites', d.prioriteCode), d.enRetard ? el('div', { class: 'texte-danger texte-petit', title: 'Échéance ' + ui.formatDateHeure(d.echeance) }, 'en retard') : null), valeurTri: (d) => { const it = ui.itemListe('priorites', d.prioriteCode); return it ? -(it.ordre || 0) : 0; } },
      { cle: 'statut', label: 'Statut', liste: 'statutsDemande', aligner: 'centre' },
      { cle: 'demandeurId', label: 'Demandeur', type: 'user' },
      { cle: 'dateDemande', label: 'Date', type: 'datetime', largeur: '140px' },
      { cle: 'otNumero', label: 'OT lié', rendu: lienOt, valeurTri: (d) => d.otNumero || '' },
    ];
    const tableau = ui.table({
      colonnes, lignes: [], recherche: 'Rechercher (numéro, titre, équipement, demandeur)…', exportCsv: false,
      triInitial: { cle: 'dateDemande', sens: 'desc' },
      onClic: (d) => GMAO.navigate('#/demandes/' + d.id),
      ligneClasse: (d) => (d.final ? 'inactif' : ''),
      rechercheDans: (d) => [d.numero, d.titre, d.description, d.equipementNom, d.equipementNumero, d.demandeurNom, d.otNumero, d.secteurChemin].filter(Boolean).join(' '),
      vide: 'Aucune demande d\'intervention',
      actions: [
        { icone: 'voir', titre: 'Ouvrir la fiche', onClic: (d) => GMAO.navigate('#/demandes/' + d.id) },
        { icone: 'check', titre: 'Valider', classe: 'texte-ok', visible: (d) => d.peutValider, onClic: (d) => validerDemande(d, rafraichir) },
        { icone: 'fermer', titre: 'Refuser', classe: 'texte-danger', visible: (d) => d.peutValider, onClic: (d) => refuserDemande(d, rafraichir) },
        { icone: 'modifier', titre: 'Modifier', visible: (d) => !d.final && ((d.statut === S.soumise && (d.demandeurId === moi || d.createdBy === moi)) || can('modifier')), onClic: (d) => ouvrirFormulaire(d, {}, rafraichir) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (d) => can('supprimer') && !d.otId, onClic: (d) => supprimerDemande(d, rafraichir) },
      ],
    });

    function appliquer() {
      let rows = demandes.slice();
      if (onglet === 'aValider') rows = rows.filter((d) => d.peutValider);
      else if (onglet === 'mes') rows = rows.filter((d) => d.demandeurId === moi || d.createdBy === moi);
      else if (onglet === 'enCours') rows = rows.filter((d) => !finaux.has(d.statut));
      else if (onglet === 'cloturees') rows = rows.filter((d) => finaux.has(d.statut));
      if (filtres.prioriteCode) rows = rows.filter((d) => d.prioriteCode === filtres.prioriteCode);
      if (filtres.statut) rows = rows.filter((d) => d.statut === filtres.statut);
      if (filtres.secteurId) rows = rows.filter((d) => String(d.secteurId) === filtres.secteurId);
      if (filtres.du) rows = rows.filter((d) => String(d.dateDemande || '').slice(0, 10) >= filtres.du);
      if (filtres.au) rows = rows.filter((d) => String(d.dateDemande || '').slice(0, 10) <= filtres.au);
      if (filtres.arret) rows = rows.filter((d) => d.arretProduction);
      tableau.maj(rows);
      setBadgeOnglet('aValider', demandes.filter((d) => d.peutValider).length);
      setBadgeOnglet('mes', demandes.filter((d) => d.demandeurId === moi || d.createdBy === moi).length);
      setBadgeOnglet('enCours', demandes.filter((d) => !finaux.has(d.statut)).length);
    }
    async function rafraichir() {
      try {
        [demandes, compteurs] = await Promise.all([api.get('/api/demandes'), api.get('/api/demandes-compteurs')]);
        majBadgeNavigation(compteurs);
        rendreKpis();
        appliquer();
      } catch (e) { erreur(e); }
    }

    // Indicateurs
    const kpis = el('div', { class: 'grille grille-4 mb' });
    function rendreKpis() {
      ui.vider(kpis);
      if (!compteurs) return;
      const aller = (cle) => () => onglets.activer(cle);
      kpis.appendChild(ui.kpi({ label: 'À valider', valeur: compteurs.aValider, icone: 'check', couleur: compteurs.aValider ? '#f59e0b' : '#16a34a', detail: can('valider') ? 'demandes en attente de votre validation' : 'demandes en attente de validation', onClic: can('valider') ? aller('aValider') : aller('toutes') }));
      kpis.appendChild(ui.kpi({ label: 'En cours', valeur: compteurs.ouvertes, icone: 'horloge', couleur: '#2563eb', detail: compteurs.enRetard ? `${compteurs.enRetard} en retard` : 'aucune en retard', onClic: aller('enCours') }));
      kpis.appendChild(ui.kpi({ label: 'Arrêts de production', valeur: compteurs.arretProduction, icone: 'alerte', couleur: compteurs.arretProduction ? '#dc2626' : '#6b7280', detail: 'demandes ouvertes avec arrêt', onClic: () => { filtres.arret = true; cbArret.checked = true; onglets.activer('enCours'); } }));
      kpis.appendChild(ui.kpi({ label: 'Mes demandes', valeur: compteurs.mesOuvertes, icone: 'utilisateur', couleur: '#8b5cf6', detail: `${compteurs.mesDemandes} au total`, onClic: aller('mes') }));
    }

    // Filtres
    const selPriorite = el('select', { onchange: () => { filtres.prioriteCode = selPriorite.value; appliquer(); } }, ui.optionsListe('priorites', { vide: 'Toutes les priorités' }).map((o) => el('option', { value: o.value }, o.label)));
    const selStatut = el('select', { onchange: () => { filtres.statut = selStatut.value; appliquer(); } }, ui.optionsListe('statutsDemande', { vide: 'Tous les statuts' }).map((o) => el('option', { value: o.value }, o.label)));
    const selSecteur = el('select', { onchange: () => { filtres.secteurId = selSecteur.value; appliquer(); } }, ui.optionsSecteurs({ vide: 'Tous les secteurs' }).map((o) => el('option', { value: o.value }, o.label)));
    const inDu = el('input', { type: 'date', title: 'Demandées à partir du', onchange: () => { filtres.du = inDu.value; appliquer(); } });
    const inAu = el('input', { type: 'date', title: 'Demandées jusqu\'au', onchange: () => { filtres.au = inAu.value; appliquer(); } });
    const cbArret = el('input', { type: 'checkbox', onchange: () => { filtres.arret = cbArret.checked; appliquer(); } });
    const btnReinit = el('button', { type: 'button', class: 'btn btn-sm', title: 'Réinitialiser les filtres', onclick: () => { selPriorite.value = ''; selStatut.value = ''; selSecteur.value = ''; inDu.value = ''; inAu.value = ''; cbArret.checked = false; Object.assign(filtres, { prioriteCode: '', statut: '', secteurId: '', du: '', au: '', arret: false }); tableau.rechercher(''); appliquer(); } }, icone('filtre'), 'Réinitialiser');
    const barreFiltres = el('div', { class: 'barre-outils' }, selPriorite, selStatut, selSecteur, el('label', { class: 'inline' }, 'Du', inDu), el('label', { class: 'inline' }, 'au', inAu), el('label', { class: 'inline' }, cbArret, 'Arrêt de production'), el('span', { class: 'espace' }), btnReinit, el('button', { type: 'button', class: 'btn btn-sm', title: 'Actualiser', onclick: rafraichir }, icone('rafraichir'), 'Actualiser'));

    const vueTableau = el('div', null, barreFiltres, tableau.el);
    const rendreOnglet = (cle) => () => { onglet = cle; appliquer(); return vueTableau; };
    onglets = ui.onglets([
      { cle: 'toutes', label: 'Toutes', icone: 'liste', rendu: rendreOnglet('toutes') },
      can('valider') ? { cle: 'aValider', label: 'À valider', icone: 'check', rendu: rendreOnglet('aValider') } : null,
      { cle: 'mes', label: 'Mes demandes', icone: 'utilisateur', rendu: rendreOnglet('mes') },
      { cle: 'enCours', label: 'En cours', icone: 'horloge', rendu: rendreOnglet('enCours') },
      { cle: 'cloturees', label: 'Clôturées', icone: 'dossier', rendu: rendreOnglet('cloturees') },
    ].filter(Boolean), { actif: query.onglet || 'toutes' });

    function exporter() {
      const q = new URLSearchParams();
      if (filtres.prioriteCode) q.set('prioriteCode', filtres.prioriteCode);
      if (filtres.statut) q.set('statut', filtres.statut);
      if (filtres.secteurId) q.set('secteurId', filtres.secteurId);
      if (filtres.du) q.set('du', filtres.du);
      if (filtres.au) q.set('au', filtres.au);
      if (filtres.arret) q.set('arretProduction', '1');
      if (onglet === 'aValider') q.set('aValider', '1');
      if (onglet === 'mes') q.set('mesDemandes', '1');
      if (onglet === 'enCours') q.set('ouvertes', '1');
      if (onglet === 'cloturees') q.set('cloturees', '1');
      api.telecharger('/api/demandes-export' + (q.toString() ? '?' + q.toString() : ''), `demandes-${ui.aujourdhui()}.csv`).then(() => toast('Export CSV généré', 'succes')).catch(erreur);
    }

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(ENTITE), icone: 'demandes', sousTitre: 'Signalements, circuit de validation et suivi des demandes',
      actions: [
        can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', onClic: exporter }) : null,
        can('creer') ? ui.bouton('Nouvelle demande', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, {}, (res) => GMAO.navigate('#/demandes/' + res.id)) }) : null,
      ],
    }));
    container.appendChild(kpis);
    container.appendChild(onglets.el);
    await rafraichir();

    if (query.nouveau === '1' || query.nouveau === 'true') {
      history.replaceState(null, '', '#/demandes');
      ouvrirFormulaire(null, { equipementId: query.equipementId ? Number(query.equipementId) : null, secteurId: query.secteurId ? Number(query.secteurId) : null }, (res) => GMAO.navigate('#/demandes/' + res.id));
    }
  }

  GMAO.registerView(ENTITE, {
    titre: 'Demandes d\'intervention', icone: 'demandes',
    async rendu(container, { params, query }) {
      if (params[0]) { rafraichirBadge(); await rendreFiche(container, params[0]); }
      else await rendreListe(container, query || {});
    },
  });
})();
