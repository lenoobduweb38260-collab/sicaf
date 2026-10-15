/**
 * Vue Audits & visites : clients, organismes certificateurs, autorités et fournisseurs qui viennent
 * sur le site.
 *
 *   #/visites        onglets Tableau de bord, Visites (liste ou calendrier), Registre d'accueil,
 *                    Plan d'actions
 *   #/visites/:id    fiche : Informations, Préparation, Visiteurs, Constats & actions, Documents,
 *                    Historique
 *
 * Registre d'accueil : arrivée (charte de sécurité, accompagnateur, EPI), départ, scan du badge à la
 * sortie (douchette ou saisie), impression des badges (carte 86 × 54 mm ou A6, code-barres Code 128)
 * et de la liste des personnes présentes pour l'évacuation.
 * Impressions : programme de la visite, liste des visiteurs, rapport des constats et du plan d'actions.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'visites';
  const TAILLE_MAX_DOC = 10 * 1024 * 1024;
  const TYPES_ACCEPTES = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp';
  const EPI = ['Blouse', 'Charlotte', 'Sur-chaussures', 'Chaussures de sécurité', 'Casque', 'Gilet haute visibilité', 'Lunettes de protection', 'Bouchons d\'oreilles', 'Gants'];
  const REFERENTIELS = ['ISO 9001:2015', 'ISO 14001:2015', 'ISO 45001:2018', 'ISO 50001:2018', 'ISO 22000:2018', 'FSSC 22000 v6', 'IFS Food v8', 'BRCGS Food Safety v9', 'Cahier des charges client', 'Arrêté préfectoral ICPE'];
  const CHECKLIST_TYPE = [
    'Nettoyage et rangement (5S) des zones visitées',
    'Vérifier l\'affichage : modes opératoires à jour, consignes de sécurité, plans d\'évacuation',
    'Préparer les documents : procédures, enregistrements, indicateurs, rapports précédents',
    'Préparer les EPI visiteurs (blouses, charlottes, chaussures, bouchons d\'oreilles)',
    'Réserver la salle de réunion et prévoir l\'accueil (café, déjeuner)',
    'Prévenir l\'accueil, les équipes des zones visitées et les accompagnateurs',
    'Vérifier les actions de la visite précédente (soldées ou en cours)',
  ];
  const CATEGORIES_DOC = [{ value: 'programme', label: 'Programme' }, { value: 'rapport', label: 'Rapport d\'audit' }, { value: 'certificat', label: 'Certificat' }, { value: 'autre', label: 'Autre document' }];
  const ETATS_VISITEUR = { attendu: { label: 'Attendu', couleur: '#6b7280' }, present: { label: 'Sur le site', couleur: '#16a34a' }, parti: { label: 'Parti', couleur: '#2563eb' } };

  /** État conservé entre deux affichages (filtres, mode d'affichage, format de badge, écoute de la douchette). */
  const memo = {
    mode: 'liste', mois: null, filtres: { typeCode: '', statut: '', secteurId: '', du: '', au: '', recherche: '' },
    filtresActions: { responsableUserId: '', echeance: '', secteurId: '', typeCode: '', toutes: false },
    dateRegistre: null, formatBadge: 'carte', arreterDouchette: null,
  };

  // ----- Utilitaires ------------------------------------------------------------------------------
  const can = (action) => GMAO.can(MODULE, action);
  const cfg = () => (GMAO.config && GMAO.config.visites) || {};
  const esc = ui.esc;
  const pad = (n) => String(n).padStart(2, '0');
  const estFinal = (code) => { const it = ui.itemListe('statutsVisite', code); return it ? !!it.final : ['terminee', 'annulee'].includes(code); };
  const nomVisiteur = (x) => `${x.prenom || ''} ${x.nom || ''}`.trim() || 'Visiteur';
  function lienVue(href, label) {
    const cible = (String(href).match(/^#\/([^/?]+)/) || [])[1];
    if (cible && !GMAO.moduleVisible(cible)) return el('span', null, label);
    return el('a', { href, onclick: (ev) => ev.stopPropagation() }, label);
  }
  function iconeDim(nom, taille) { const ic = icone(nom); Object.assign(ic.style, { width: taille + 'px', height: taille + 'px', flexShrink: 0 }); return ic; }
  function periode(v) {
    if (!v || !v.dateDebut) return '';
    const d = ui.dateISO(v.dateDebut); const f = ui.dateISO(v.dateFin || v.dateDebut);
    return d === f ? `${ui.formatDate(v.dateDebut)} · ${ui.formatHeure(v.dateDebut)} – ${ui.formatHeure(v.dateFin || v.dateDebut)}` : `${ui.formatDateHeure(v.dateDebut)} → ${ui.formatDateHeure(v.dateFin)}`;
  }
  function badgeEtat(etat) { const e = ETATS_VISITEUR[etat] || ETATS_VISITEUR.attendu; return ui.badge(e.label, e.couleur); }
  function tailleLisible(o) { const n = Number(o) || 0; return n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`; }
  function nettoyer(v) { const o = Object.assign({}, v); for (const k of Object.keys(o)) if (o[k] === '') o[k] = null; return o; }
  function progression(faits, total) {
    const pct = total ? Math.round((faits / total) * 100) : 0;
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '120px' } },
      el('div', { class: 'barre-progression', style: { flex: 1 } }, el('div', { style: { width: pct + '%', background: pct === 100 ? 'var(--ok)' : 'var(--primaire)' } })),
      el('span', { class: 'texte-petit texte-2' }, `${faits}/${total}`));
  }
  /** Contenu chargé de façon asynchrone dans un conteneur (indicateur de chargement, message d'erreur). */
  function charger(cont, fn) {
    ui.vider(cont);
    cont.appendChild(ui.chargement());
    return Promise.resolve().then(fn).then((n) => { if (!cont.isConnected && cont.parentNode === null) return; ui.vider(cont); if (n) cont.appendChild(n); })
      .catch((e) => { ui.vider(cont); cont.appendChild(ui.vide(e.message || String(e), 'alerte')); });
  }
  function optionsZones(secteurId) {
    const s = ui.secteur(secteurId);
    const siteId = s ? (s.siteId != null ? s.siteId : (s.type === 'site' ? s.id : null)) : null;
    return ui.optionsSecteurs({ vide: false, tousSites: true }).filter((o) => {
      const x = ui.secteur(o.value);
      return x && x.id !== siteId && (siteId == null || x.siteId === siteId);
    });
  }

  // ----- Impressions ---------------------------------------------------------------------------------
  /** Fenêtre d'impression sans script (politique de sécurité) : impression pilotée par ui.lancerImpression. */
  function fenetreImpression(titre, style, corps, options = {}) {
    const w = window.open('', '_blank', 'width=760,height=720');
    if (!w) { toast('Fenêtre bloquée : autorisez les fenêtres surgissantes pour imprimer', 'alerte'); return; }
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title><style>${style}</style></head><body>`
      + `<div class="outils"><button type="button" data-imprimer>Imprimer</button></div>${corps}</body></html>`);
    w.document.close();
    ui.lancerImpression(w, options);
  }

  /** Badges visiteurs : [{ visiteur, visite }] ; format « carte » (86 × 54 mm) ou « a6 ». */
  function imprimerBadges(elements, format) {
    if (!elements.length) return toast('Aucun badge à imprimer', 'info');
    const a6 = (format || memo.formatBadge) === 'a6';
    const avecCode = cfg().badgeAvecCodeBarre !== false && window.CodeBarre;
    const societe = ((GMAO.config.societe || {}).nom) || '';
    const accompagne = cfg().accompagnementObligatoire !== false;
    const l = a6 ? { w: 105, h: 148, nom: 9, soc: 5, info: 3.6, bandeau: 5, code: 16, mod: 0.42 } : { w: 86, h: 54, nom: 5.2, soc: 3.3, info: 2.5, bandeau: 3.2, code: 9, mod: 0.3 };
    const style = `@page { size: ${l.w}mm ${l.h}mm; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #111; background: #e5e7eb; }
      .outils { padding: 10px; text-align: center; } .outils button { font: inherit; padding: 6px 16px; cursor: pointer; }
      .badge { width: ${l.w}mm; height: ${l.h}mm; background: #fff; margin: 5mm auto; overflow: hidden; display: flex; flex-direction: column; border: 0.2mm solid #bbb; page-break-after: always; break-after: page; }
      .bandeau { color: #fff; padding: ${a6 ? 3 : 1.4}mm ${a6 ? 5 : 3}mm; display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: ${l.bandeau}mm; letter-spacing: 0.3mm; }
      .bandeau span:last-child { font-weight: 400; font-size: ${l.bandeau * 0.8}mm; }
      .corps { flex: 1; padding: ${a6 ? 6 : 2}mm ${a6 ? 6 : 3}mm ${a6 ? 3 : 1}mm; display: flex; flex-direction: column; min-height: 0; }
      .nom { font-size: ${l.nom}mm; font-weight: 700; line-height: 1.1; word-break: break-word; }
      .societe { font-size: ${l.soc}mm; color: #333; margin-top: ${a6 ? 2 : 0.6}mm; }
      .infos { font-size: ${l.info}mm; color: #222; margin-top: ${a6 ? 5 : 1.2}mm; line-height: 1.4; }
      .infos b { font-weight: 600; }
      .mention { font-size: ${l.info}mm; font-weight: 700; color: #b91c1c; margin-top: ${a6 ? 3 : 0.8}mm; }
      .code { margin-top: auto; text-align: center; } .code svg { height: ${l.code + (a6 ? 5 : 3)}mm; width: auto; max-width: ${l.w - 8}mm; }
      .numero { margin-top: auto; text-align: center; font-family: monospace; font-size: ${l.soc}mm; letter-spacing: 0.5mm; }
      @media print { body { background: #fff; } .outils { display: none; } .badge { margin: 0; border: 0; } }`;
    const corps = elements.map(({ visiteur: x, visite: v }) => {
      const couleur = /^#[0-9a-f]{3,8}$/i.test(ui.couleur('typesVisite', v.typeCode)) ? ui.couleur('typesVisite', v.typeCode) : '#2563eb';
      let code = '';
      if (x.badgeNumero && avecCode) { try { code = `<div class="code">${window.CodeBarre.svg(x.badgeNumero, { hauteur: l.code, largeurModule: l.mod, unite: 'mm', taillePolice: a6 ? 3.4 : 2.4 })}</div>`; } catch (e) { code = ''; } }
      if (!code && x.badgeNumero) code = `<div class="numero">${esc(x.badgeNumero)}</div>`;
      const zones = (v.zones || []).join(', ');
      return `<div class="badge"><div class="bandeau" style="background:${couleur}"><span>VISITEUR</span><span>${esc(societe)}</span></div><div class="corps">`
        + `<div class="nom">${esc(nomVisiteur(x))}</div>${x.societe ? `<div class="societe">${esc(x.societe)}${x.fonction && a6 ? ' — ' + esc(x.fonction) : ''}</div>` : ''}`
        + `<div class="infos"><b>Date :</b> ${esc(periode(v))}<br><b>Hôte :</b> ${esc(v.hoteNom || '—')}${x.accompagnateurNom && x.accompagnateurNom !== v.hoteNom ? ` · <b>Accompagnateur :</b> ${esc(x.accompagnateurNom)}` : ''}`
        + `<br><b>Zones autorisées :</b> ${esc(zones || 'accueil et salles de réunion')}${a6 ? `<br><b>Visite :</b> ${esc(v.numero)} — ${esc(v.titre)}` : ''}</div>`
        + (accompagne ? '<div class="mention">Doit être accompagné(e) en permanence</div>' : '')
        + `${code}</div></div>`;
    }).join('');
    fenetreImpression('Badges visiteurs', style, corps);
  }
  /** Données de badge depuis une fiche de visite. */
  function badgeDepuisFiche(v, x) { return { visiteur: x, visite: { numero: v.numero, titre: v.titre, typeCode: v.typeCode, hoteNom: v.hoteNom, dateDebut: v.dateDebut, dateFin: v.dateFin, zones: (v.zones || []).map((z) => z.nom) } }; }
  /** Données de badge depuis une ligne du registre. */
  function badgeDepuisRegistre(l) { return { visiteur: l, visite: { numero: l.visiteNumero, titre: l.visiteTitre, typeCode: l.typeCode, hoteNom: l.hoteNom, dateDebut: l.dateDebut, dateFin: l.dateFin, zones: l.zones || [] } }; }

  function imprimerEvacuation(presents) {
    const lignes = presents.slice().sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'));
    const html = `<h1>Personnes extérieures présentes sur le site</h1><p><strong>${lignes.length}</strong> visiteur(s) présent(s) au ${esc(ui.formatDateHeure(new Date()))}. À remettre au responsable de l'évacuation : cocher chaque personne au point de rassemblement.</p>`
      + `<table><thead><tr><th>Nom</th><th>Prénom</th><th>Société</th><th>Visite</th><th>Hôte / accompagnateur</th><th>Arrivée</th><th>Badge</th><th>Au point de rassemblement</th></tr></thead><tbody>`
      + (lignes.length ? lignes.map((l) => `<tr><td>${esc(l.nom)}</td><td>${esc(l.prenom)}</td><td>${esc(l.societe)}</td><td>${esc(l.visiteNumero)} — ${esc(l.visiteTitre)}<br>${esc(l.siteNom)}</td><td>${esc(l.hoteNom)}${l.accompagnateurNom && l.accompagnateurNom !== l.hoteNom ? '<br>' + esc(l.accompagnateurNom) : ''}</td><td>${esc(ui.formatDateHeure(l.arrivee))}</td><td>${esc(l.badgeNumero)}</td><td style="text-align:center;font-size:18px">☐</td></tr>`).join('')
        : '<tr><td colspan="8" style="text-align:center">Aucun visiteur présent sur le site</td></tr>')
      + '</tbody></table><div class="signature"><div>Responsable de l\'évacuation</div><div>Heure du comptage</div></div>';
    ui.imprimer('Liste d\'évacuation — visiteurs présents', html);
  }

  function enteteImpression(v) {
    return `<h1>${esc(v.numero)} — ${esc(v.titre)}</h1><dl>`
      + `<dt>Type</dt><dd>${esc(ui.libelle('typesVisite', v.typeCode))}</dd><dt>Statut</dt><dd>${esc(ui.libelle('statutsVisite', v.statut))}</dd>`
      + `<dt>Date</dt><dd>${esc(periode(v))}</dd><dt>Site visité</dt><dd>${esc(v.secteurChemin || '—')}</dd>`
      + `<dt>Organisme</dt><dd>${esc(v.organisme || '—')}</dd><dt>Référentiel</dt><dd>${esc(v.referentiel || '—')}</dd>`
      + `<dt>Contact</dt><dd>${esc([v.contactOrganisme.nom, v.contactOrganisme.email, v.contactOrganisme.telephone].filter(Boolean).join(' · ') || '—')}</dd>`
      + `<dt>Hôte</dt><dd>${esc(v.hoteNom || '—')}</dd><dt>Participants</dt><dd>${esc(v.participants.map((p) => p.nom).join(', ') || '—')}</dd></dl>`;
  }
  function imprimerProgramme(v) {
    let html = enteteImpression(v);
    html += `<h2>Programme</h2>${v.programme ? `<p>${esc(v.programme).replace(/\n/g, '<br>')}</p>` : '<p>Programme non renseigné.</p>'}`;
    if (v.zones.length) html += `<h2>Zones visitées</h2><p>${v.zones.map((z) => esc(z.chemin || z.nom)).join('<br>')}</p>`;
    if (v.visiteurs.length) html += `<h2>Visiteurs attendus (${v.visiteurs.length})</h2><table><thead><tr><th>Nom</th><th>Société</th><th>Fonction</th><th>Accompagnateur</th></tr></thead><tbody>${v.visiteurs.map((x) => `<tr><td>${esc(nomVisiteur(x))}</td><td>${esc(x.societe)}</td><td>${esc(x.fonction)}</td><td>${esc(x.accompagnateurNom)}</td></tr>`).join('')}</tbody></table>`;
    if (cfg().charteSecurite) html += `<h2>Consignes de sécurité</h2><p>${esc(cfg().charteSecurite).replace(/\n/g, '<br>')}</p>`;
    if (v.preparation.length) html += `<h2>Préparation (${v.preparationFaits}/${v.preparationTotal})</h2><table><thead><tr><th>Point</th><th>Responsable</th><th>Échéance</th><th>Fait</th></tr></thead><tbody>${v.preparation.map((p) => `<tr><td>${esc(p.libelle)}</td><td>${esc(p.responsableNom)}</td><td>${esc(ui.formatDate(p.echeance))}</td><td>${p.fait ? 'Oui' : '☐'}</td></tr>`).join('')}</tbody></table>`;
    ui.imprimer(`Programme de la visite ${v.numero}`, html);
  }
  function imprimerVisiteurs(v) {
    const html = enteteImpression(v) + `<h2>Liste des visiteurs (${v.visiteurs.length})</h2><table><thead><tr><th>Nom</th><th>Société</th><th>Fonction</th><th>Accompagnateur</th><th>Charte</th><th>Arrivée</th><th>Départ</th><th>Badge</th><th>Signature</th></tr></thead><tbody>`
      + (v.visiteurs.map((x) => `<tr><td>${esc(nomVisiteur(x))}</td><td>${esc(x.societe)}</td><td>${esc(x.fonction)}</td><td>${esc(x.accompagnateurNom)}</td><td>${x.charteAcceptee ? 'Acceptée' : '—'}</td><td>${esc(ui.formatDateHeure(x.arrivee))}</td><td>${esc(ui.formatDateHeure(x.depart))}</td><td>${esc(x.badgeNumero)}</td><td style="min-width:90px"></td></tr>`).join('') || '<tr><td colspan="9">Aucun visiteur</td></tr>')
      + '</tbody></table>';
    ui.imprimer(`Visiteurs — ${v.numero}`, html);
  }
  function imprimerRapport(v) {
    let html = enteteImpression(v);
    const r = v.resultat || {};
    html += `<h2>Résultat</h2><dl><dt>Conclusion</dt><dd>${r.conclusion ? esc(r.conclusion).replace(/\n/g, '<br>') : '—'}</dd><dt>Note / score</dt><dd>${esc(r.note || '—')}</dd><dt>Certificat</dt><dd>${r.certificatObtenu == null ? 'Sans objet' : (r.certificatObtenu ? 'Obtenu' : 'Non obtenu')}</dd><dt>Date du rapport</dt><dd>${esc(ui.formatDate(r.dateRapport) || '—')}</dd></dl>`;
    html += `<h2>Constats (${v.constats.length})</h2>`;
    if (!v.constats.length) html += '<p>Aucun constat enregistré.</p>';
    v.constats.forEach((c, i) => {
      html += `<h3 style="font-size:13.5px;margin:14px 0 4px">${i + 1}. <span class="badge">${esc(ui.libelle('typesConstat', c.typeCode))}</span> ${esc(c.exigence || '')}</h3>`
        + `<p>${esc(c.description).replace(/\n/g, '<br>')}</p>${c.preuve ? `<p><em>Preuve : ${esc(c.preuve)}</em></p>` : ''}${c.secteurNom || c.equipement ? `<p>${esc([c.secteurNom, c.equipement ? `${c.equipement.numero} ${c.equipement.nom}` : ''].filter(Boolean).join(' · '))}</p>` : ''}`;
      if (c.actions.length) html += `<table><thead><tr><th>Action</th><th>Responsable</th><th>Échéance</th><th>Statut</th><th>Vérification</th></tr></thead><tbody>${c.actions.map((a) => `<tr><td>${esc(a.libelle)}${a.demande ? '<br>Demande ' + esc(a.demande.numero) : ''}</td><td>${esc(a.responsableNom)}</td><td>${esc(ui.formatDate(a.echeance))}${a.enRetard ? ' (en retard)' : ''}</td><td>${esc(ui.libelle('statutsAction', a.statut))}</td><td>${a.dateVerification ? esc(`${ui.formatDate(a.dateVerification)} — ${a.verifieParNom}`) + (a.commentaireVerification ? '<br>' + esc(a.commentaireVerification) : '') : '—'}</td></tr>`).join('')}</tbody></table>`;
    });
    html += '<div class="signature"><div>Responsable qualité</div><div>Date / visa</div></div>';
    ui.imprimer(`Rapport des constats — ${v.numero}`, html);
  }

  // ----- Formulaires : visite -------------------------------------------------------------------------
  async function ouvrirFormulaire(existant, options = {}) {
    const creation = !existant;
    const portee = (GMAO.perms || {}).portee;
    const avecPlans = GMAO.moduleVisible('plans');
    let plans = [];
    const chargerPlans = async (secteurId) => {
      if (!avecPlans) return [];
      const s = ui.secteur(secteurId);
      const siteId = s ? (s.siteId != null ? s.siteId : s.id) : null;
      try { return await api.get('/api/plans', siteId ? { siteId } : null); } catch (e) { return []; }
    };
    const optionsPlans = () => [{ value: '', label: '— Aucun plan —' }].concat(plans.map((p) => ({ value: p.id, label: `${p.numero} · ${p.nom}` })));
    const chargerObjets = async (planId) => {
      if (!planId) return [];
      try {
        const p = await api.get('/api/plans/' + planId);
        return (p.objets || []).filter((o) => o.nom && ['zone', 'batiment', 'machine', 'installation'].includes(o.type)).map((o) => ({ value: String(o.id), label: `${o.nom} (${o.type === 'batiment' ? 'bâtiment' : o.type})` }));
      } catch (e) { return []; }
    };
    const sites = (GMAO.refs.secteurs || []).filter((s) => s.type === 'site' && s.actif !== false);
    const secteurInitial = existant ? existant.secteurId : (options.secteurId || GMAO.siteCourant() || (sites.length === 1 ? sites[0].id : ''));
    plans = await chargerPlans(secteurInitial);
    let objets = existant && existant.planId ? await chargerObjets(existant.planId) : [];
    const demain = new Date(Date.now() + 86400000);
    const debutDefaut = new Date(demain.getFullYear(), demain.getMonth(), demain.getDate(), 9, 0).toISOString();
    const finDefaut = new Date(demain.getFullYear(), demain.getMonth(), demain.getDate(), 12, 0).toISOString();
    const statutsInitiaux = GMAO.liste('statutsVisite').filter((s) => !s.final).map((s) => ({ value: s.code, label: s.label }));

    const champs = [
      { type: 'separateur', label: 'Visite' },
      { nom: 'titre', label: 'Titre', type: 'texte', requis: true, pleineLargeur: true, placeholder: 'ex. Audit fournisseur annuel du client Distrifrais', maxLength: 200 },
      { nom: 'typeCode', label: 'Type', type: 'select', liste: 'typesVisite', vide: false, requis: true },
      creation ? { nom: 'statut', label: 'Statut', type: 'select', options: statutsInitiaux, requis: true } : null,
      { nom: 'secteurId', label: 'Site visité', type: 'select', options: ui.optionsSecteurs({ vide: portee === 'tous' ? '— Tous les sites —' : '— Choisir —' }), requis: portee !== 'tous',
        aide: 'Détermine qui voit la visite (portée par site / secteur).',
        onChange: async (val, f) => {
          f.majOptions('zonesVisitees', optionsZones(val));
          if (avecPlans) { plans = await chargerPlans(val); f.majOptions('planId', optionsPlans()); }
        } },
      { nom: 'organisme', label: 'Client / organisme', type: 'texte', placeholder: 'ex. Distrifrais SAS, organisme certificateur…', maxLength: 200 },
      { nom: 'referentiel', label: 'Référentiel', type: 'texte', suggestions: REFERENTIELS, placeholder: 'ex. ISO 9001:2015', maxLength: 200 },
      { type: 'separateur', label: 'Dates' },
      { nom: 'dateDebut', label: 'Début', type: 'datetime', requis: true },
      { nom: 'dateFin', label: 'Fin', type: 'datetime', requis: true, valider: (val, vals) => (val && vals.dateDebut && val < vals.dateDebut ? 'La fin doit suivre le début' : '') },
      { type: 'separateur', label: 'Contact de l\'organisme' },
      { nom: 'contactNom', label: 'Nom du contact', type: 'texte', maxLength: 120 },
      { nom: 'contactEmail', label: 'E-mail', type: 'email' },
      { nom: 'contactTelephone', label: 'Téléphone', type: 'tel' },
      { type: 'separateur', label: 'Équipe interne' },
      { nom: 'hoteUserId', label: 'Hôte (responsable de l\'accueil)', type: 'select', options: ui.optionsUsers({ vide: '— Choisir —' }), requis: true },
      { nom: 'participantsUserIds', label: 'Participants', type: 'multiselect', options: ui.optionsUsers({ vide: false }), pleineLargeur: true },
      { type: 'separateur', label: 'Programme et zones' },
      { nom: 'programme', label: 'Programme', type: 'texte_long', lignes: 6, placeholder: '08:30 Accueil et consignes de sécurité\n09:00 Revue documentaire\n10:30 Visite des ateliers…' },
      { nom: 'zonesVisitees', label: 'Zones visitées (autorisées sur le badge)', type: 'multiselect', options: optionsZones(secteurInitial), pleineLargeur: true },
      avecPlans ? { nom: 'planId', label: 'Plan 3D du site', type: 'select', options: optionsPlans(), aide: 'Facultatif : localisation des zones visitées sur le plan 3D.',
        onChange: async (val, f) => { objets = await chargerObjets(val); f.majOptions('objetIds', objets); } } : null,
      avecPlans ? { nom: 'objetIds', label: 'Zones / équipements du plan', type: 'multiselect', options: objets, pleineLargeur: true, afficherSi: (vals) => !!vals.planId } : null,
      ...ui.champsPersoDefs(MODULE),
    ];
    const valeurs = existant
      ? Object.assign({}, existant, {
        secteurId: existant.secteurId == null ? '' : existant.secteurId, hoteUserId: existant.hoteUserId == null ? '' : existant.hoteUserId,
        contactNom: existant.contactOrganisme.nom, contactEmail: existant.contactOrganisme.email, contactTelephone: existant.contactOrganisme.telephone,
        planId: existant.planId == null ? '' : existant.planId, objetIds: (existant.objetIds || []).map(String),
      }, ui.champsPersoInitiaux(existant))
      : { typeCode: (GMAO.liste('typesVisite')[0] || {}).code || '', statut: (statutsInitiaux[0] || {}).value || '', secteurId: secteurInitial, hoteUserId: GMAO.user.id, dateDebut: debutDefaut, dateFin: finDefaut, participantsUserIds: [], zonesVisitees: [] };
    if (options.valeurs) Object.assign(valeurs, options.valeurs);

    ui.formModal({
      titre: creation ? 'Nouvelle visite' : `Modifier ${existant.numero}`, taille: 'large', champs, valeurs,
      onSubmit: async (v) => {
        const body = {
          titre: v.titre, typeCode: v.typeCode, secteurId: v.secteurId === '' ? null : v.secteurId, organisme: v.organisme, referentiel: v.referentiel,
          dateDebut: v.dateDebut, dateFin: v.dateFin, hoteUserId: v.hoteUserId === '' ? null : v.hoteUserId,
          participantsUserIds: v.participantsUserIds || [], programme: v.programme, zonesVisitees: v.zonesVisitees || [],
          contactOrganisme: { nom: v.contactNom, email: v.contactEmail, telephone: v.contactTelephone },
          champs: ui.champsPersoValeurs(v),
        };
        if (creation) body.statut = v.statut;
        if (avecPlans) { body.planId = v.planId === '' || v.planId == null ? null : v.planId; body.objetIds = body.planId ? (v.objetIds || []) : []; }
        const res = creation ? await api.post('/api/visites', body) : await api.put('/api/visites/' + existant.id, body);
        toast(creation ? `Visite ${res.numero} créée` : `Visite ${res.numero} enregistrée`, 'succes');
        if (options.apres) options.apres(res); else GMAO.navigate('#/visites/' + res.id);
      },
    });
  }

  function ouvrirResultat(v, apres) {
    const r = v.resultat || {};
    ui.formModal({
      titre: `Résultat — ${v.numero}`, colonnes: 2,
      champs: [
        { nom: 'conclusion', label: 'Conclusion', type: 'texte_long', lignes: 5, placeholder: 'Avis de l\'auditeur, décision de certification, suites à donner…' },
        { nom: 'note', label: 'Note / score', type: 'texte', placeholder: 'ex. 92/100, niveau A, 1 NC mineure', maxLength: 60 },
        { nom: 'dateRapport', label: 'Date du rapport', type: 'date' },
        { nom: 'certificatObtenu', label: 'Certificat', type: 'radio', options: [{ value: 'oui', label: 'Obtenu / renouvelé' }, { value: 'non', label: 'Non obtenu' }, { value: 'na', label: 'Sans objet' }], pleineLargeur: true },
      ],
      valeurs: { conclusion: r.conclusion, note: r.note, dateRapport: r.dateRapport || '', certificatObtenu: r.certificatObtenu == null ? 'na' : (r.certificatObtenu ? 'oui' : 'non') },
      onSubmit: async (x) => {
        const res = await api.put('/api/visites/' + v.id, { resultat: { conclusion: x.conclusion, note: x.note, dateRapport: x.dateRapport || null, certificatObtenu: x.certificatObtenu === 'na' || !x.certificatObtenu ? null : x.certificatObtenu === 'oui' } });
        toast('Résultat enregistré', 'succes');
        apres(res);
      },
    });
  }

  function ouvrirStatut(v, apres) {
    const options = GMAO.liste('statutsVisite').filter((s) => s.code !== v.statut).map((s) => ({ value: s.code, label: s.label, couleur: s.couleur }));
    const annulee = (GMAO.liste('statutsVisite').find((s) => s.code === 'annulee') || GMAO.liste('statutsVisite').filter((s) => s.final).slice(-1)[0] || {}).code;
    ui.formModal({
      titre: `Statut de la visite ${v.numero}`, taille: 'petite', colonnes: 1,
      avant: el('p', { class: 'texte-2' }, 'Statut actuel : ', ui.badgeListe('statutsVisite', v.statut)),
      champs: [
        { nom: 'statut', label: 'Nouveau statut', type: 'radio', options, requis: true },
        { nom: 'motif', label: 'Motif / commentaire', type: 'texte_long', lignes: 3, valider: (m, vals) => (vals.statut === annulee && !m ? 'Le motif d\'annulation est obligatoire' : '') },
      ],
      submitLabel: 'Changer le statut',
      onSubmit: async (x) => {
        const envoyer = (departs) => api.post(`/api/visites/${v.id}/statut`, { statut: x.statut, motif: x.motif || '', enregistrerDeparts: departs });
        let res;
        try { res = await envoyer(false); } catch (e) {
          if (e.status !== 409) throw e;
          const presents = (e.details && e.details.presents) || [];
          const ok = await ui.confirm({ titre: 'Visiteurs encore présents', message: `${presents.length} visiteur(s) encore présent(s) sur le site (${presents.join(', ')}). Enregistrer leur départ maintenant et changer le statut ?`, okLabel: 'Enregistrer les départs' });
          if (!ok) return false;
          res = await envoyer(true);
        }
        toast(`Visite ${res.numero} : ${ui.libelle('statutsVisite', res.statut)}`, 'succes');
        apres(res);
      },
    });
  }

  // ----- Formulaires : visiteurs et registre ------------------------------------------------------------
  async function ouvrirVisiteur(v, existant, apres) {
    let complet = existant;
    if (existant && cfg().demanderPieceIdentite) { try { complet = await api.get(`/api/visites/${v.id}/visiteurs/${existant.id}`); } catch (e) { complet = existant; } }
    // La pièce d'identité n'est modifiable que si sa valeur complète a pu être lue (jamais la valeur masquée)
    const avecPiece = cfg().demanderPieceIdentite && (!existant || complet !== existant);
    const epi = EPI.concat(((complet && complet.epiFournis) || []).filter((x) => !EPI.includes(x))).map((x) => ({ value: x, label: x }));
    ui.formModal({
      titre: existant ? `Modifier ${nomVisiteur(existant)}` : 'Ajouter un visiteur', taille: 'large',
      champs: [
        { nom: 'nom', label: 'Nom', type: 'texte', requis: true, maxLength: 80 },
        { nom: 'prenom', label: 'Prénom', type: 'texte', maxLength: 80 },
        { nom: 'societe', label: 'Société', type: 'texte', maxLength: 150 },
        { nom: 'fonction', label: 'Fonction', type: 'texte', maxLength: 100 },
        { nom: 'email', label: 'E-mail', type: 'email' },
        { nom: 'telephone', label: 'Téléphone', type: 'tel' },
        { nom: 'vehicule', label: 'Véhicule (immatriculation)', type: 'texte', maxLength: 40 },
        avecPiece ? { nom: 'pieceIdentite', label: 'Pièce d\'identité (type et numéro)', type: 'texte', maxLength: 60, aide: 'Donnée personnelle : anonymisée automatiquement après la durée de conservation.' } : null,
        { nom: 'accompagnateurUserId', label: 'Accompagnateur', type: 'select', options: ui.optionsUsers({ vide: cfg().accompagnementObligatoire !== false ? '— L\'hôte de la visite —' : '— Aucun —' }) },
        { nom: 'epiFournis', label: 'EPI à fournir', type: 'multiselect', options: epi, pleineLargeur: true },
        !existant || !existant.arrivee ? { nom: 'charteAcceptee', label: 'Charte de sécurité déjà acceptée (envoyée avant la visite)', type: 'booleen' } : null,
      ],
      valeurs: complet ? Object.assign({}, complet, { accompagnateurUserId: complet.accompagnateurUserId == null ? '' : complet.accompagnateurUserId, pieceIdentite: avecPiece ? complet.pieceIdentite || '' : undefined }) : { societe: v.organisme || '', epiFournis: [] },
      onSubmit: async (x) => {
        const body = nettoyer(x);
        body.epiFournis = x.epiFournis || [];
        if (existant && existant.arrivee) delete body.charteAcceptee;
        const res = existant ? await api.put(`/api/visites/${v.id}/visiteurs/${existant.id}`, body) : await api.post(`/api/visites/${v.id}/visiteurs`, body);
        toast(existant ? 'Visiteur enregistré' : `${nomVisiteur(x)} ajouté(e)`, 'succes');
        apres(res);
      },
    });
  }

  /**
   * Arrivée d'un visiteur : charte de sécurité, pièce d'identité, accompagnateur, EPI ; impression du badge.
   * x : visiteur (fiche ou ligne du registre) ; contexteVisite : { id, hoteUserId, hoteNom } ; apres(fiche).
   */
  function ouvrirArrivee(visiteId, x, hoteUserId, apres) {
    const c = cfg();
    const charte = (c.charteSecurite || '').trim();
    const epi = EPI.concat((x.epiFournis || []).filter((e) => !EPI.includes(e))).map((e) => ({ value: e, label: e }));
    ui.formModal({
      titre: `Arrivée de ${nomVisiteur(x)}`, colonnes: 1,
      avant: frag(
        el('p', { class: 'texte-2', style: { marginTop: 0 } }, [x.societe, x.fonction].filter(Boolean).join(' · ') || ''),
        charte && !x.charteAcceptee ? el('div', { class: 'alerte alerte-alerte', style: { whiteSpace: 'pre-wrap' } }, el('strong', null, 'Charte de sécurité du site'), el('br'), charte) : null,
        x.charteAcceptee ? ui.alerte('Charte de sécurité déjà acceptée.', 'ok') : null),
      champs: [
        charte && !x.charteAcceptee ? { nom: 'charteAcceptee', label: 'Le visiteur a pris connaissance de la charte de sécurité et l\'accepte', type: 'booleen', requis: true, valider: (val) => (val ? '' : 'Acceptation obligatoire avant l\'entrée sur le site') } : null,
        c.demanderPieceIdentite && !x.pieceIdentiteRenseignee ? { nom: 'pieceIdentite', label: 'Pièce d\'identité présentée (type et numéro)', type: 'texte', requis: true, maxLength: 60 } : null,
        { nom: 'accompagnateurUserId', label: 'Accompagnateur', type: 'select', options: ui.optionsUsers({ vide: c.accompagnementObligatoire !== false ? '— L\'hôte de la visite —' : '— Aucun —' }) },
        { nom: 'epiFournis', label: 'EPI remis', type: 'multiselect', options: epi },
        { nom: 'vehicule', label: 'Véhicule (immatriculation)', type: 'texte', maxLength: 40 },
        { nom: 'imprimer', label: 'Imprimer le badge', type: 'booleen' },
      ],
      valeurs: { accompagnateurUserId: x.accompagnateurUserId == null ? (hoteUserId == null ? '' : hoteUserId) : x.accompagnateurUserId, epiFournis: x.epiFournis || [], vehicule: x.vehicule || '', imprimer: true },
      submitLabel: 'Enregistrer l\'arrivée',
      onSubmit: async (f) => {
        const body = { epiFournis: f.epiFournis || [] };
        if (f.charteAcceptee) body.charteAcceptee = true;
        if (f.pieceIdentite) body.pieceIdentite = f.pieceIdentite;
        if (f.accompagnateurUserId !== '' && f.accompagnateurUserId != null) body.accompagnateurUserId = f.accompagnateurUserId;
        if (f.vehicule !== undefined && (f.vehicule || x.vehicule)) body.vehicule = f.vehicule;
        const fiche = await api.post(`/api/visites/${visiteId}/visiteurs/${x.visiteurId || x.id}/arrivee`, body);
        const vis = fiche.visiteurs.find((y) => y.id === (x.visiteurId || x.id));
        toast(`Arrivée enregistrée : ${nomVisiteur(vis)} (${ui.formatHeure(vis.arrivee)})`, 'succes');
        if (f.imprimer) imprimerBadges([badgeDepuisFiche(fiche, vis)]);
        apres(fiche);
      },
    });
  }
  async function enregistrerDepart(visiteId, visiteurId, nom, apres) {
    try {
      const fiche = await api.post(`/api/visites/${visiteId}/visiteurs/${visiteurId}/depart`, {});
      toast(`Départ enregistré : ${nom}`, 'succes');
      apres(fiche);
    } catch (e) { erreur(e); }
  }

  // ----- Formulaires : préparation, constats, actions -------------------------------------------------------
  function ouvrirPreparation(v, existant, apres) {
    ui.formModal({
      titre: existant ? 'Modifier le point de préparation' : 'Ajouter un point de préparation', taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'libelle', label: 'Point à préparer', type: 'texte', requis: true, maxLength: 200, suggestions: CHECKLIST_TYPE },
        { nom: 'responsableUserId', label: 'Responsable', type: 'select', options: ui.optionsUsers({ vide: '— Aucun —' }) },
        { nom: 'echeance', label: 'Échéance', type: 'date' },
      ],
      valeurs: existant ? Object.assign({}, existant, { responsableUserId: existant.responsableUserId == null ? '' : existant.responsableUserId }) : { echeance: ui.dateISO(new Date(new Date(v.dateDebut).getTime() - 86400000)) },
      onSubmit: async (x) => {
        const res = existant ? await api.put(`/api/visites/${v.id}/preparation/${existant.id}`, nettoyer(x)) : await api.post(`/api/visites/${v.id}/preparation`, nettoyer(x));
        toast('Préparation enregistrée', 'succes');
        apres(res);
      },
    });
  }

  async function ouvrirConstat(v, existant, apres) {
    let equipements = [];
    if (GMAO.can('equipements', 'voir')) { try { equipements = await api.get('/api/equipements', { actif: '1' }); } catch (e) { equipements = []; } }
    const siteId = v.siteId;
    const eqSite = equipements.filter((e) => siteId == null || (ui.secteur(e.secteurId) || {}).siteId === siteId);
    ui.formModal({
      titre: existant ? 'Modifier le constat' : 'Nouveau constat', taille: 'large',
      champs: [
        { nom: 'typeCode', label: 'Type de constat', type: 'select', liste: 'typesConstat', vide: false, requis: true },
        { nom: 'exigence', label: 'Exigence (clause du référentiel)', type: 'texte', placeholder: 'ex. §8.7 Maîtrise des éléments de sortie non conformes', maxLength: 200 },
        { nom: 'description', label: 'Description du constat', type: 'texte_long', lignes: 4, requis: true },
        { nom: 'preuve', label: 'Preuve / élément observé', type: 'texte_long', lignes: 2 },
        { nom: 'secteurId', label: 'Secteur concerné', type: 'select', options: [{ value: '', label: '— Aucun —' }].concat(optionsZones(v.secteurId)) },
        eqSite.length ? { nom: 'equipementId', label: 'Équipement concerné', type: 'select', options: [{ value: '', label: '— Aucun —' }].concat(eqSite.map((e) => ({ value: e.id, label: `${e.numero} · ${e.nom}` }))), aide: 'Le secteur de l\'équipement est repris.' } : null,
      ],
      valeurs: existant ? Object.assign({}, existant, { secteurId: existant.secteurId == null ? '' : existant.secteurId, equipementId: existant.equipementId == null ? '' : existant.equipementId }) : { typeCode: (GMAO.liste('typesConstat')[0] || {}).code },
      onSubmit: async (x) => {
        const body = nettoyer(x);
        const res = existant ? await api.put(`/api/visites/${v.id}/constats/${existant.id}`, body) : await api.post(`/api/visites/${v.id}/constats`, body);
        toast('Constat enregistré', 'succes');
        apres(res);
      },
    });
  }

  /** Action : formulaire complet (gestionnaire) ou avancement (responsable de l'action). */
  function ouvrirAction(visiteId, constatId, existant, gestion, apres) {
    const statuts = GMAO.liste('statutsAction').filter((s) => (s.code !== 'verifiee' || (existant && existant.statut === 'verifiee')) && (gestion || !s.final || (existant && existant.statut === s.code))).map((s) => ({ value: s.code, label: s.label }));
    const champs = gestion ? [
      { nom: 'libelle', label: 'Action', type: 'texte', requis: true, pleineLargeur: true, maxLength: 300 },
      { nom: 'responsableUserId', label: 'Responsable', type: 'select', options: ui.optionsUsers({ vide: '— Choisir —' }), requis: true },
      { nom: 'echeance', label: 'Échéance', type: 'date' },
      existant ? { nom: 'statut', label: 'Statut', type: 'select', options: statuts, requis: true } : null,
      existant ? { nom: 'dateRealisation', label: 'Réalisée le', type: 'date', afficherSi: (vals) => vals.statut === 'realisee' } : null,
      { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 3 },
    ] : [
      { nom: 'statut', label: 'Avancement', type: 'radio', options: statuts, requis: true },
      { nom: 'commentaire', label: 'Commentaire', type: 'texte_long', lignes: 3, placeholder: 'Ce qui a été fait, preuves disponibles…' },
    ];
    ui.formModal({
      titre: existant ? (gestion ? 'Modifier l\'action' : `Avancement — ${existant.libelle}`) : 'Nouvelle action', taille: gestion ? 'large' : 'petite', colonnes: gestion ? 2 : 1, champs,
      valeurs: existant ? Object.assign({}, existant, { responsableUserId: existant.responsableUserId == null ? '' : existant.responsableUserId, dateRealisation: existant.dateRealisation || '' }) : { echeance: ui.dateISO(new Date(Date.now() + 30 * 86400000)) },
      onSubmit: async (x) => {
        const body = gestion ? nettoyer(x) : { statut: x.statut, commentaire: x.commentaire || '' };
        if (gestion && !existant) delete body.statut;
        const url = `/api/visites/${visiteId}/constats/${constatId}/actions`;
        const res = existant ? await api.put(`${url}/${existant.id}`, body) : await api.post(url, body);
        toast('Action enregistrée', 'succes');
        apres(res);
      },
    });
  }

  function ouvrirVerification(visiteId, constatId, a, apres) {
    ui.formModal({
      titre: 'Vérification de l\'efficacité', taille: 'petite', colonnes: 1,
      avant: el('p', null, el('strong', null, a.libelle), el('br'), el('span', { class: 'texte-2' }, `Responsable : ${a.responsableNom || '—'} · réalisée le ${ui.formatDate(a.dateRealisation) || '—'}`), a.commentaire ? frag(el('br'), el('em', null, a.commentaire)) : null),
      champs: [
        { nom: 'efficace', label: 'L\'action est-elle efficace ?', type: 'radio', options: [{ value: 'oui', label: 'Oui : action soldée' }, { value: 'non', label: 'Non : action à reprendre' }], requis: true },
        { nom: 'commentaire', label: 'Commentaire de vérification', type: 'texte_long', lignes: 3, valider: (c, vals) => (vals.efficace === 'non' && !c ? 'Expliquez pourquoi l\'action n\'est pas efficace' : '') },
      ],
      submitLabel: 'Enregistrer la vérification',
      onSubmit: async (x) => {
        const res = await api.post(`/api/visites/${visiteId}/constats/${constatId}/actions/${a.id || a.actionId}/valider`, { efficace: x.efficace === 'oui', commentaire: x.commentaire || '' });
        toast(x.efficace === 'oui' ? 'Action vérifiée efficace' : 'Action renvoyée à son responsable', 'succes');
        apres(res);
      },
    });
  }

  function ouvrirCreationDemande(visiteId, constatId, a, apres) {
    ui.formModal({
      titre: 'Créer une demande d\'intervention', colonnes: 2,
      avant: el('p', { class: 'texte-2', style: { marginTop: 0 } }, 'La demande suit le circuit habituel (validation, ordre de travail) ; elle reste liée à l\'action du plan d\'actions.'),
      champs: [
        { nom: 'titre', label: 'Titre de la demande', type: 'texte', requis: true, pleineLargeur: true, maxLength: 200 },
        { nom: 'prioriteCode', label: 'Priorité', type: 'select', liste: 'priorites', vide: false },
        { nom: 'typeCode', label: 'Type d\'intervention', type: 'select', liste: 'typesIntervention', vide: false },
        { nom: 'description', label: 'Description (laisser vide pour reprendre le constat et l\'action)', type: 'texte_long', lignes: 3 },
      ],
      valeurs: { titre: String(a.libelle || '').slice(0, 200), prioriteCode: 'normale', typeCode: GMAO.liste('typesIntervention').some((t) => t.code === 'amelioration') ? 'amelioration' : (GMAO.liste('typesIntervention')[0] || {}).code },
      submitLabel: 'Créer la demande',
      onSubmit: async (x) => {
        const body = nettoyer(x);
        if (!body.description) delete body.description;
        const r = await api.post(`/api/visites/${visiteId}/constats/${constatId}/actions/${a.id || a.actionId}/creer-demande`, body);
        toast(`Demande ${r.demande.numero} créée`, 'succes');
        apres(r.visite);
      },
    });
  }

  function ouvrirDocument(v, apres) {
    ui.formModal({
      titre: 'Ajouter un document', taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'fichier', label: 'Fichier', type: 'fichier', requis: true, tailleMax: TAILLE_MAX_DOC, accept: TYPES_ACCEPTES, aide: 'PDF, images, documents bureautiques, texte ou CSV ; 10 Mo maximum.' },
        { nom: 'categorie', label: 'Catégorie', type: 'select', options: CATEGORIES_DOC, requis: true },
        { nom: 'description', label: 'Description', type: 'texte', maxLength: 500 },
      ],
      valeurs: { categorie: 'rapport' },
      submitLabel: 'Ajouter',
      onSubmit: async (x) => {
        if (!x.fichier || !x.fichier.contenu) { toast('Sélectionnez un fichier', 'erreur'); return false; }
        const res = await api.post(`/api/visites/${v.id}/documents`, { nom: x.fichier.nom, type: x.fichier.type, contenu: x.fichier.contenu, categorie: x.categorie, description: x.description || '' });
        toast('Document ajouté', 'succes');
        apres(res);
      },
    });
  }

  // ----- Accueil : onglet Tableau de bord ---------------------------------------------------------------------
  function ongletTableau() {
    const cont = el('div');
    charger(cont, async () => {
      const t = await api.get('/api/visites-tableau');
      const k = t.kpi;
      const out = el('div');
      out.appendChild(el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginBottom: '16px' } },
        ui.kpi({ label: 'Visites à venir', valeur: k.aVenir, icone: 'calendrier', detail: `${k.aVenir30} dans les 30 jours · ${k.aujourdhui} aujourd'hui`, couleur: '#2563eb' }),
        ui.kpi({ label: 'Présents sur le site', valeur: k.presents, icone: 'visite', detail: 'visiteurs extérieurs', couleur: k.presents ? '#16a34a' : '#6b7280', onClic: () => GMAO.navigate('#/visites?onglet=registre') }),
        ui.kpi({ label: 'Non-conformités ouvertes', valeur: k.ncOuvertes, icone: 'alerte', detail: 'constats avec actions non soldées', couleur: k.ncOuvertes ? '#f59e0b' : '#16a34a' }),
        ui.kpi({ label: 'Actions en retard', valeur: k.actionsEnRetard, icone: 'horloge', detail: `${k.actionsOuvertes} action(s) ouverte(s)`, couleur: k.actionsEnRetard ? '#dc2626' : '#16a34a', onClic: () => { memo.filtresActions.echeance = 'retard'; GMAO.navigate('#/visites?onglet=actions'); } })));
      const grille = el('div', { class: 'grille grille-2', style: { alignItems: 'start' } });
      grille.appendChild(ui.carte('Prochaines visites', t.prochaines.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: t.prochaines, onClic: (v) => GMAO.navigate('#/visites/' + v.id),
        colonnes: [
          { cle: 'dateDebut', label: 'Date', rendu: (v) => el('span', { style: { whiteSpace: 'nowrap' } }, ui.formatDate(v.dateDebut), el('div', { class: 'cellule-secondaire' }, ui.relatif(v.dateDebut))) },
          { cle: 'titre', label: 'Visite', rendu: (v) => el('div', null, el('div', { class: 'cellule-principale' }, v.titre), el('div', { class: 'cellule-secondaire', title: ui.libelle('typesVisite', v.typeCode) }, ui.pastille(ui.couleur('typesVisite', v.typeCode)), ' ', [v.numero, v.organisme].filter(Boolean).join(' · '))) },
          { cle: 'preparation', label: 'Préparation', largeur: '150px', rendu: (v) => (v.preparationTotal ? progression(v.preparationFaits, v.preparationTotal) : el('span', { class: 'texte-2' }, '—')) },
        ],
      }).el : ui.vide('Aucune visite planifiée', 'calendrier')));
      const presents = ui.carte(`Présents sur le site (${t.presents.length})`, t.presents.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: t.presents, onClic: (l) => GMAO.navigate('#/visites/' + l.visiteId + '?onglet=visiteurs'),
        colonnes: [
          { cle: 'nom', label: 'Visiteur', rendu: (l) => el('div', null, el('div', { class: 'cellule-principale' }, nomVisiteur(l)), el('div', { class: 'cellule-secondaire' }, l.societe)) },
          { cle: 'accompagnateurNom', label: 'Accompagnateur' },
          { cle: 'arrivee', label: 'Arrivée', type: 'datetime' },
        ],
      }).el : ui.vide('Aucun visiteur extérieur sur le site', 'visite'), { actions: ui.bouton('Liste d\'évacuation', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerEvacuation(t.presents) }) });
      grille.appendChild(presents);
      const parType = t.constatsOuvertsParType.filter((x) => x.nombre > 0 || /^nc/.test(x.typeCode));
      grille.appendChild(ui.carte('Constats ouverts par type', parType.some((x) => x.nombre) ? ui.graphiqueBarres(parType.map((x) => ({ label: x.label, valeur: x.nombre, couleur: x.couleur || undefined })), { hauteur: 190 }) : ui.vide('Aucun constat ouvert', 'check')));
      grille.appendChild(ui.carte(`Actions en retard (${k.actionsEnRetard})`, t.actionsEnRetard.length ? ui.table({
        compact: true, recherche: false, pagination: false, lignes: t.actionsEnRetard, onClic: (a) => GMAO.navigate(`#/visites/${a.visiteId}?onglet=constats`),
        colonnes: [
          { cle: 'libelle', label: 'Action', rendu: (a) => el('div', null, el('div', { class: 'cellule-principale' }, a.libelle), el('div', { class: 'cellule-secondaire' }, `${a.visiteNumero} · ${ui.libelle('typesConstat', a.constatTypeCode)}`)) },
          { cle: 'responsableNom', label: 'Responsable' },
          { cle: 'echeance', label: 'Échéance', rendu: (a) => el('span', { class: 'texte-danger texte-gras' }, ui.formatDate(a.echeance)) },
        ],
      }).el : ui.vide('Aucune action en retard', 'check')));
      out.appendChild(grille);
      if (t.preparationsIncompletes.length) {
        out.appendChild(ui.carte('Préparations à terminer (visites des 14 prochains jours)', ui.table({
          compact: true, recherche: false, pagination: false, lignes: t.preparationsIncompletes, onClic: (v) => GMAO.navigate(`#/visites/${v.id}?onglet=preparation`),
          colonnes: [
            { cle: 'titre', label: 'Visite', rendu: (v) => el('span', { class: 'cellule-principale' }, `${v.numero} · ${v.titre}`) },
            { cle: 'dateDebut', label: 'Date', type: 'datetime' },
            { cle: 'hoteNom', label: 'Hôte' },
            { cle: 'preparation', label: 'Avancement', rendu: (v) => progression(v.preparationFaits, v.preparationTotal) },
          ],
        }).el));
      }
      return out;
    });
    return cont;
  }

  // ----- Accueil : onglet Visites (liste / calendrier) -----------------------------------------------------------
  function rendreCalendrier(zone, visites, mois, changerMois) {
    const [a, m] = mois.split('-').map(Number);
    const premier = new Date(a, m - 1, 1);
    const debut = new Date(a, m - 1, 1 - ((premier.getDay() + 6) % 7));
    const nomMois = premier.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    zone.appendChild(el('div', { class: 'barre-outils' },
      ui.bouton('', { icone: 'fleche_gauche', classe: 'btn-sm', titre: 'Mois précédent', onClic: () => changerMois(-1) }),
      el('strong', { style: { minWidth: '150px', textAlign: 'center', textTransform: 'capitalize' } }, nomMois),
      ui.bouton('', { icone: 'fleche_droite', classe: 'btn-sm', titre: 'Mois suivant', onClic: () => changerMois(1) }),
      ui.bouton('Aujourd\'hui', { classe: 'btn-sm', onClic: () => changerMois(0) })));
    const cal = el('div', { class: 'calendrier' });
    ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].forEach((j) => cal.appendChild(el('div', { class: 'cal-entete' }, j)));
    const auj = ui.aujourdhui();
    for (let i = 0; i < 42; i++) {
      const d = new Date(debut.getFullYear(), debut.getMonth(), debut.getDate() + i);
      const iso = ui.dateISO(d);
      const cellule = el('div', { class: 'cal-jour' + (d.getMonth() !== m - 1 ? ' hors-mois' : '') + (iso === auj ? ' aujourdhui' : '') }, el('div', { class: 'cal-num' }, String(d.getDate())));
      visites.filter((v) => ui.dateISO(v.dateDebut) <= iso && iso <= ui.dateISO(v.dateFin || v.dateDebut)).forEach((v) => {
        cellule.appendChild(el('span', { class: 'cal-evt', title: `${v.numero} · ${v.titre}\n${periode(v)}\n${ui.libelle('statutsVisite', v.statut)}`, style: { background: ui.couleur('typesVisite', v.typeCode), opacity: v.statut === 'annulee' ? 0.5 : 1, textDecoration: v.statut === 'annulee' ? 'line-through' : 'none' }, onclick: () => GMAO.navigate('#/visites/' + v.id) },
          `${ui.dateISO(v.dateDebut) === iso ? ui.formatHeure(v.dateDebut) + ' ' : ''}${v.titre}`));
      });
      cal.appendChild(cellule);
    }
    zone.appendChild(cal);
    zone.appendChild(el('div', { class: 'inline mt', style: { flexWrap: 'wrap', gap: '12px' } }, GMAO.liste('typesVisite').map((t) => el('span', { class: 'inline texte-petit', style: { gap: '5px' } }, ui.pastille(t.couleur), t.label))));
  }

  function ongletVisites() {
    const cont = el('div');
    const f = memo.filtres;
    if (!memo.mois) memo.mois = ui.aujourdhui().slice(0, 7);
    const opt = (o, cur) => el('option', { value: o.value, selected: String(o.value) === String(cur) }, o.label);
    const selType = el('select', { title: 'Type', onchange: () => { f.typeCode = selType.value; maj(); } }, ui.optionsListe('typesVisite', { vide: 'Tous les types' }).map((o) => opt(o, f.typeCode)));
    const selStatut = el('select', { title: 'Statut', onchange: () => { f.statut = selStatut.value; maj(); } }, ui.optionsListe('statutsVisite', { vide: 'Tous les statuts' }).map((o) => opt(o, f.statut)));
    const selSite = el('select', { title: 'Site / secteur', onchange: () => { f.secteurId = selSite.value; maj(); } }, ui.optionsSecteurs({ vide: 'Tous les sites' }).map((o) => opt(o, f.secteurId)));
    const du = el('input', { type: 'date', value: f.du, title: 'Du', onchange: () => { f.du = du.value; maj(); } });
    const au = el('input', { type: 'date', value: f.au, title: 'Au', onchange: () => { f.au = au.value; maj(); } });
    const rech = el('input', { type: 'search', placeholder: 'Rechercher (titre, organisme, visiteur…)', value: f.recherche, style: { maxWidth: '260px' } });
    rech.addEventListener('input', ui.debounce(() => { f.recherche = rech.value.trim(); maj(); }, 300));
    const btnListe = ui.bouton('Liste', { icone: 'liste', classe: 'btn-sm' + (memo.mode === 'liste' ? ' btn-primaire' : ''), onClic: () => { memo.mode = 'liste'; btnListe.classList.add('btn-primaire'); btnCal.classList.remove('btn-primaire'); maj(); } });
    const btnCal = ui.bouton('Calendrier', { icone: 'calendrier', classe: 'btn-sm' + (memo.mode === 'calendrier' ? ' btn-primaire' : ''), onClic: () => { memo.mode = 'calendrier'; btnCal.classList.add('btn-primaire'); btnListe.classList.remove('btn-primaire'); maj(); } });
    const reinit = ui.bouton('Réinitialiser', { icone: 'fermer', classe: 'btn-sm', onClic: () => { Object.assign(f, { typeCode: '', statut: '', secteurId: '', du: '', au: '', recherche: '' }); selType.value = ''; selStatut.value = ''; selSite.value = ''; du.value = ''; au.value = ''; rech.value = ''; maj(); } });
    const exporter = can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: () => api.telecharger('/api/visites-export/visites?' + new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString(), 'visites.csv').catch(erreur) }) : null;
    cont.appendChild(el('div', { class: 'barre-outils' }, selType, selStatut, selSite, el('label', { class: 'inline texte-petit' }, 'Du', du), el('label', { class: 'inline texte-petit' }, 'au', au), rech, reinit, el('span', { class: 'espace' }), btnListe, btnCal, exporter));
    const zone = el('div');
    cont.appendChild(zone);

    async function maj() {
      const q = Object.assign({}, f);
      if (memo.mode === 'calendrier') {
        const [a, m] = memo.mois.split('-').map(Number);
        q.du = ui.dateISO(new Date(a, m - 1, -6)); q.au = ui.dateISO(new Date(a, m, 7));
      }
      for (const k of Object.keys(q)) if (!q[k]) delete q[k];
      await charger(zone, async () => {
        const rows = await api.get('/api/visites', q);
        const out = el('div');
        if (memo.mode === 'calendrier') {
          rendreCalendrier(out, rows, memo.mois, (delta) => {
            if (delta === 0) memo.mois = ui.aujourdhui().slice(0, 7);
            else { const [a, m] = memo.mois.split('-').map(Number); const d = new Date(a, m - 1 + delta, 1); memo.mois = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
            maj();
          });
          return out;
        }
        out.appendChild(ui.table({
          lignes: rows, recherche: false, onClic: (v) => GMAO.navigate('#/visites/' + v.id), triInitial: { cle: 'dateDebut', sens: 'desc' }, vide: 'Aucune visite ne correspond aux filtres',
          ligneClasse: (v) => (v.statut === 'annulee' ? 'inactif' : ''),
          colonnes: [
            { cle: 'numero', label: 'Numéro', rendu: (v) => el('span', { class: 'cellule-principale', style: { whiteSpace: 'nowrap' } }, v.numero), valeurTri: (v) => v.numero },
            { cle: 'titre', label: 'Visite', largeur: '28%', rendu: (v) => el('div', { title: v.referentiel ? 'Référentiel : ' + v.referentiel : null }, el('div', { class: 'cellule-principale' }, v.titre), el('div', { class: 'cellule-secondaire' }, v.organisme || '')), valeurTri: (v) => String(v.titre).toLowerCase() },
            { cle: 'typeCode', label: 'Type', liste: 'typesVisite' },
            { cle: 'statut', label: 'Statut', liste: 'statutsVisite' },
            { cle: 'dateDebut', label: 'Date', rendu: (v) => el('span', { class: 'texte-petit' }, periode(v)), valeurTri: (v) => v.dateDebut },
            { cle: 'secteurChemin', label: 'Site', rendu: (v) => v.secteurChemin || el('span', { class: 'texte-2' }, 'Tous les sites') },
            { cle: 'hoteNom', label: 'Hôte' },
            { cle: 'nbVisiteurs', label: 'Visiteurs', aligner: 'centre', rendu: (v) => frag(String(v.nbVisiteurs), v.nbPresents ? frag(' ', ui.badge(`${v.nbPresents} sur site`, '#16a34a')) : null), valeurTri: (v) => v.nbVisiteurs },
            { cle: 'nbConstats', label: 'Constats', aligner: 'centre', rendu: (v) => (v.nbConstats ? frag(String(v.nbConstats), v.ncOuvertes ? frag(' ', ui.badge(`${v.ncOuvertes} NC`, '#f59e0b')) : null) : el('span', { class: 'texte-2' }, '—')), valeurTri: (v) => v.nbConstats },
            { cle: 'actionsEnRetard', label: 'Retards', aligner: 'centre', rendu: (v) => (v.actionsEnRetard ? ui.badge(String(v.actionsEnRetard), '#dc2626') : el('span', { class: 'texte-2' }, '0')), valeurTri: (v) => v.actionsEnRetard },
          ],
        }).el);
        return out;
      });
    }
    maj();
    return cont;
  }

  // ----- Accueil : onglet Registre d'accueil ----------------------------------------------------------------------
  function ongletRegistre() {
    if (memo.arreterDouchette) { memo.arreterDouchette(); memo.arreterDouchette = null; }
    const cont = el('div');
    const peutAccueillir = can('modifier');
    if (!memo.dateRegistre) memo.dateRegistre = ui.aujourdhui();
    const date = el('input', { type: 'date', value: memo.dateRegistre, title: 'Journée affichée', onchange: () => { memo.dateRegistre = date.value || ui.aujourdhui(); maj(); } });
    const scan = el('input', { type: 'search', placeholder: 'Scanner un badge à la sortie (ou saisir son numéro)', style: { minWidth: '300px' }, autocomplete: 'off' });
    scan.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const c = scan.value.trim(); scan.value = ''; if (c) scanner(c); } });
    const selFormat = el('select', { title: 'Format des badges', onchange: () => { memo.formatBadge = selFormat.value; } }, el('option', { value: 'carte', selected: memo.formatBadge === 'carte' }, 'Badge carte 86 × 54 mm'), el('option', { value: 'a6', selected: memo.formatBadge === 'a6' }, 'Badge A6'));
    let donnees = { attendus: [], presents: [] };
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('label', { class: 'inline' }, iconeDim('calendrier', 16), date),
      ui.bouton('Aujourd\'hui', { classe: 'btn-sm', onClic: () => { memo.dateRegistre = ui.aujourdhui(); date.value = memo.dateRegistre; maj(); } }),
      peutAccueillir ? el('label', { class: 'inline' }, iconeDim('codebarre', 16), scan) : null,
      el('span', { class: 'espace' }), selFormat,
      ui.bouton('Badges du jour', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerBadges(donnees.attendus.filter((l) => l.etat !== 'parti').map(badgeDepuisRegistre)) }),
      ui.bouton('Liste d\'évacuation', { icone: 'alerte', classe: 'btn-sm btn-danger', titre: 'Imprimer la liste des personnes extérieures présentes sur le site', onClic: () => imprimerEvacuation(donnees.presents) }),
      can('exporter') ? ui.bouton('Exporter', { icone: 'export', classe: 'btn-sm', onClic: () => api.telecharger(`/api/visites-export/registre?du=${memo.dateRegistre}&au=${memo.dateRegistre}`, `registre-${memo.dateRegistre}.csv`).catch(erreur) }) : null));
    const zone = el('div');
    cont.appendChild(zone);

    async function scanner(code) {
      try {
        const r = await api.post('/api/visites-registre/scan', { code });
        if (window.CodeBarre) window.CodeBarre.bip(true);
        toast(`Départ enregistré : ${nomVisiteur(r.visiteur)} (${ui.formatHeure(r.visiteur.depart)})`, 'succes');
        maj();
      } catch (e) { if (window.CodeBarre) window.CodeBarre.bip(false); erreur(e); }
    }
    if (peutAccueillir && window.CodeBarre) {
      const arreter = window.CodeBarre.ecouterDouchette((code) => { if (!cont.isConnected) { arreter(); return; } scanner(code); });
      memo.arreterDouchette = arreter;
    }

    function tableau(lignes, vide, avecRecherche) {
      return ui.table({
        lignes, recherche: avecRecherche ? 'Recherche rapide : nom, société, badge…' : false, pagination: false, vide,
        rechercheDans: (l) => `${l.badgeNumero} ${l.visiteNumero} ${l.organisme}`,
        triInitial: { cle: 'etat', sens: 'asc' },
        colonnes: [
          { cle: 'etat', label: 'État', rendu: (l) => badgeEtat(l.etat), valeurTri: (l) => ({ present: 0, attendu: 1, parti: 2 }[l.etat]) },
          { cle: 'nom', label: 'Visiteur', rendu: (l) => el('div', null, el('div', { class: 'cellule-principale' }, nomVisiteur(l)), el('div', { class: 'cellule-secondaire' }, [l.societe, l.fonction].filter(Boolean).join(' · '))), valeurTri: (l) => `${l.nom} ${l.prenom}`.toLowerCase() },
          { cle: 'visiteTitre', label: 'Visite', rendu: (l) => el('div', null, lienVue('#/visites/' + l.visiteId, `${l.visiteNumero} · ${l.visiteTitre}`), el('div', { class: 'cellule-secondaire' }, periode(l))) },
          { cle: 'hoteNom', label: 'Hôte / accompagnateur', rendu: (l) => el('div', null, l.hoteNom || '—', l.accompagnateurNom && l.accompagnateurNom !== l.hoteNom ? el('div', { class: 'cellule-secondaire' }, l.accompagnateurNom) : null) },
          { cle: 'arrivee', label: 'Arrivée', rendu: (l) => (l.arrivee ? el('span', null, ui.formatHeure(l.arrivee), ui.dateISO(l.arrivee) !== memo.dateRegistre ? el('div', { class: 'cellule-secondaire' }, ui.formatDate(l.arrivee)) : null) : el('span', { class: 'texte-2' }, '—')) },
          { cle: 'depart', label: 'Départ', rendu: (l) => (l.depart ? ui.formatHeure(l.depart) : el('span', { class: 'texte-2' }, '—')) },
          { cle: 'badgeNumero', label: 'Badge', rendu: (l) => el('code', { class: 'texte-petit' }, l.badgeNumero) },
        ],
        actions: [
          { icone: 'check', titre: 'Enregistrer l\'arrivée', classe: 'texte-ok', visible: (l) => peutAccueillir && l.etat === 'attendu' && !estFinal(l.statut), onClic: (l) => ouvrirArrivee(l.visiteId, l, l.hoteUserId, () => maj()) },
          { icone: 'deconnexion', titre: 'Enregistrer le départ', classe: 'texte-danger', visible: (l) => peutAccueillir && l.etat === 'present', onClic: (l) => enregistrerDepart(l.visiteId, l.visiteurId, nomVisiteur(l), () => maj()) },
          { icone: 'imprimer', titre: 'Imprimer le badge', visible: (l) => l.etat !== 'parti', onClic: (l) => imprimerBadges([badgeDepuisRegistre(l)]) },
        ],
      }).el;
    }

    async function maj() {
      await charger(zone, async () => {
        donnees = await api.get('/api/visites-registre', { date: memo.dateRegistre });
        const out = el('div');
        out.appendChild(el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '14px' } },
          ui.kpi({ label: memo.dateRegistre === ui.aujourdhui() ? 'Visiteurs attendus aujourd\'hui' : `Visiteurs du ${ui.formatDate(memo.dateRegistre)}`, valeur: donnees.nbAttendus, icone: 'utilisateurs' }),
          ui.kpi({ label: 'Arrivés', valeur: donnees.nbArrives, icone: 'check', couleur: '#2563eb' }),
          ui.kpi({ label: 'Présents sur le site (maintenant)', valeur: donnees.nbPresents, icone: 'visite', couleur: donnees.nbPresents ? '#16a34a' : '#6b7280' }),
          ui.kpi({ label: 'Partis', valeur: donnees.nbPartis, icone: 'deconnexion', couleur: '#6b7280' })));
        if (peutAccueillir && cfg().charteSecurite) out.appendChild(el('p', { class: 'texte-2 texte-petit', style: { marginTop: 0 } }, 'L\'arrivée d\'un visiteur nécessite l\'acceptation de la charte de sécurité ; le badge peut être imprimé immédiatement. Le scan du badge à la sortie enregistre le départ.'));
        out.appendChild(ui.carte('Visiteurs de la journée', tableau(donnees.attendus, 'Aucun visiteur attendu ce jour-là', true)));
        const autres = donnees.presents.filter((p) => !donnees.attendus.some((a) => a.visiteId === p.visiteId && a.visiteurId === p.visiteurId));
        if (autres.length) out.appendChild(ui.carte('Encore présents depuis un autre jour', frag(ui.alerte('Ces personnes n\'ont pas de départ enregistré : vérifiez qu\'elles ont bien quitté le site.', 'alerte'), tableau(autres, '', false))));
        return out;
      });
      if (peutAccueillir && cont.isConnected) setTimeout(() => { if (document.activeElement === document.body) scan.focus(); }, 50);
    }
    maj();
    return cont;
  }

  // ----- Accueil : onglet Plan d'actions --------------------------------------------------------------------------
  function ongletActions() {
    const cont = el('div');
    const f = memo.filtresActions;
    const opt = (o, cur) => el('option', { value: o.value, selected: String(o.value) === String(cur) }, o.label);
    const selResp = el('select', { title: 'Responsable', onchange: () => { f.responsableUserId = selResp.value; maj(); } }, [{ value: '', label: 'Tous les responsables' }, { value: 'moi', label: 'Mes actions' }].concat(ui.optionsUsers({ vide: false })).map((o) => opt(o, f.responsableUserId)));
    const selEch = el('select', { title: 'Échéance', onchange: () => { f.echeance = selEch.value; maj(); } }, [{ value: '', label: 'Toutes les échéances' }, { value: 'retard', label: 'En retard' }, { value: '7', label: 'Sous 7 jours' }, { value: '30', label: 'Sous 30 jours' }].map((o) => opt(o, f.echeance)));
    const selSite = el('select', { title: 'Site / secteur', onchange: () => { f.secteurId = selSite.value; maj(); } }, ui.optionsSecteurs({ vide: 'Tous les sites' }).map((o) => opt(o, f.secteurId)));
    const selType = el('select', { title: 'Type de constat', onchange: () => { f.typeCode = selType.value; maj(); } }, ui.optionsListe('typesConstat', { vide: 'Tous les constats' }).map((o) => opt(o, f.typeCode)));
    const cbToutes = el('input', { type: 'checkbox', checked: f.toutes, onchange: () => { f.toutes = cbToutes.checked; maj(); } });
    const params = () => {
      const q = { responsableUserId: f.responsableUserId, secteurId: f.secteurId, typeCode: f.typeCode, toutes: f.toutes ? '1' : '' };
      if (f.echeance === 'retard') q.echeance = 'retard';
      else if (f.echeance) q.echeanceAvant = ui.dateISO(new Date(Date.now() + Number(f.echeance) * 86400000));
      for (const k of Object.keys(q)) if (!q[k]) delete q[k];
      return q;
    };
    cont.appendChild(el('div', { class: 'barre-outils' }, selResp, selEch, selSite, selType, el('label', { class: 'inline' }, cbToutes, 'Inclure les actions soldées'), el('span', { class: 'espace' }),
      can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', onClic: () => api.telecharger('/api/visites-export/actions?' + new URLSearchParams(params()).toString(), 'plan-actions.csv').catch(erreur) }) : null));
    const zone = el('div');
    cont.appendChild(zone);
    async function maj() {
      await charger(zone, async () => {
        const rows = await api.get('/api/visites-actions', params());
        const moi = GMAO.user.id;
        return ui.table({
          lignes: rows, recherche: 'Rechercher une action, une visite, un responsable…', vide: 'Aucune action ne correspond aux filtres',
          rechercheDans: (a) => `${a.constatDescription} ${a.organisme} ${a.visiteTitre}`,
          ligneClasse: (a) => (a.final ? 'inactif' : ''), triInitial: { cle: 'echeance', sens: 'asc' },
          onClic: (a) => GMAO.navigate(`#/visites/${a.visiteId}?onglet=constats`),
          colonnes: [
            { cle: 'libelle', label: 'Action', largeur: '36%', rendu: (a) => el('div', null, el('div', { class: 'cellule-principale' }, a.libelle), a.commentaire ? el('div', { class: 'cellule-secondaire' }, a.commentaire) : null) },
            { cle: 'constatTypeCode', label: 'Constat', rendu: (a) => el('div', null, ui.badgeListe('typesConstat', a.constatTypeCode), a.exigence ? el('div', { class: 'cellule-secondaire' }, a.exigence) : null) },
            { cle: 'visiteNumero', label: 'Visite', rendu: (a) => el('div', { style: { maxWidth: '180px' } }, el('span', { style: { whiteSpace: 'nowrap' } }, lienVue('#/visites/' + a.visiteId, a.visiteNumero)), el('div', { class: 'cellule-secondaire', title: `${a.visiteTitre}${a.organisme ? ' — ' + a.organisme : ''}`, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.organisme || a.visiteTitre)) },
            { cle: 'responsableNom', label: 'Responsable' },
            { cle: 'echeance', label: 'Échéance', rendu: (a) => (a.echeance ? el('span', { class: a.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(a.echeance), a.enRetard ? ' (retard)' : '') : el('span', { class: 'texte-2' }, '—')), valeurTri: (a) => a.echeance || '9999' },
            { cle: 'statut', label: 'Statut', liste: 'statutsAction' },
            { cle: 'demande', label: 'Demande', rendu: (a) => (a.demande ? lienVue('#/demandes/' + a.demande.id, a.demande.numero || ('#' + a.demande.id)) : el('span', { class: 'texte-2' }, '—')), valeurTri: (a) => (a.demande ? a.demande.numero : '') },
          ],
          actions: [
            { icone: 'modifier', titre: 'Mettre à jour l\'avancement', visible: (a) => !a.final && (can('modifier') || Number(a.responsableUserId) === moi), onClic: (a) => ouvrirAction(a.visiteId, a.constatId, a, false, () => maj()) },
            { icone: 'check', titre: 'Vérifier l\'efficacité', classe: 'texte-ok', visible: (a) => can('valider') && a.statut === 'realisee', onClic: (a) => ouvrirVerification(a.visiteId, a.constatId, a, () => maj()) },
            { icone: 'demandes', titre: 'Créer une demande d\'intervention', visible: (a) => !a.final && !a.demande && can('modifier') && GMAO.can('demandes', 'creer'), onClic: (a) => ouvrirCreationDemande(a.visiteId, a.constatId, a, () => maj()) },
          ],
        }).el;
      });
    }
    maj();
    return cont;
  }

  async function afficherAccueil(container, query) {
    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'visite',
      sousTitre: 'Audits clients, certifications, inspections et visites du site : préparation, accueil des visiteurs, constats et plans d\'actions',
      actions: [can('creer') ? ui.bouton('Nouvelle visite', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null) }) : null],
    }));
    container.appendChild(ui.onglets([
      { cle: 'tableau', label: 'Tableau de bord', icone: 'dashboard', rendu: () => ongletTableau() },
      { cle: 'visites', label: 'Visites', icone: 'calendrier', rendu: () => ongletVisites() },
      { cle: 'registre', label: 'Registre d\'accueil', icone: 'visite', rendu: () => ongletRegistre() },
      { cle: 'actions', label: 'Plan d\'actions', icone: 'liste', rendu: () => ongletActions() },
    ], { hash: true }).el);
    if (query.nouveau === '1' && can('creer')) ouvrirFormulaire(null);
  }

  // ----- Fiche : onglets ------------------------------------------------------------------------------------------
  function rendreInfos(v, recharger) {
    const d = v.droits;
    const cont = el('div');
    const c = v.contactOrganisme || {};
    cont.appendChild(el('div', { class: 'carte' }, ui.details([
      { label: 'Numéro', valeur: el('code', null, v.numero) },
      { label: 'Type', valeur: ui.badgeListe('typesVisite', v.typeCode) },
      { label: 'Statut', valeur: frag(ui.badgeListe('statutsVisite', v.statut), v.motifAnnulation ? el('span', { class: 'texte-2' }, ' — ' + v.motifAnnulation) : null) },
      { label: 'Date', valeur: periode(v) },
      { label: 'Site visité', valeur: v.secteurChemin || 'Tous les sites' },
      { label: 'Client / organisme', valeur: v.organisme },
      { label: 'Référentiel', valeur: v.referentiel },
      { label: 'Contact', valeur: [c.nom, c.email, c.telephone].filter(Boolean).join(' · ') },
      { label: 'Hôte', valeur: v.hoteNom },
      { label: 'Participants', valeur: v.participants.map((p) => p.nom).join(', ') },
      { label: 'Zones visitées', valeur: v.zones.length ? el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px' } }, v.zones.map((z) => el('span', { class: 'inline', style: { gap: '5px' }, title: z.chemin }, ui.pastille(z.couleur || '#6b7280'), z.nom))) : '' },
      v.plan ? { label: 'Plan 3D', valeur: frag(lienVue('#/plans/' + v.plan.id, `${v.plan.numero} · ${v.plan.nom}`), v.plan.objets.length ? el('div', { class: 'texte-petit texte-2' }, v.plan.objets.map((o) => o.nom).join(', ')) : null) } : null,
      { label: 'Créée', valeur: `${ui.formatDateHeure(v.createdAt)}${v.createdByNom ? ' par ' + v.createdByNom : ''}` },
      { label: 'Dernière modification', valeur: ui.formatDateHeure(v.updatedAt) },
      ...ui.champsPersoAffichage(MODULE, v),
    ], { colonnes: 2 })));
    cont.appendChild(ui.carte('Programme', v.programme ? el('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, v.programme) : el('p', { class: 'texte-2', style: { margin: 0 } }, 'Programme non renseigné.'),
      { actions: ui.bouton('Imprimer le programme', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerProgramme(v) }) }));
    const r = v.resultat || {};
    cont.appendChild(ui.carte('Résultat', ui.details([
      { label: 'Conclusion', valeur: r.conclusion ? el('span', { style: { whiteSpace: 'pre-wrap' } }, r.conclusion) : '' },
      { label: 'Note / score', valeur: r.note },
      { label: 'Certificat', valeur: r.certificatObtenu == null ? 'Sans objet' : (r.certificatObtenu ? ui.badge('Obtenu', '#16a34a') : ui.badge('Non obtenu', '#dc2626')) },
      { label: 'Date du rapport', valeur: ui.formatDate(r.dateRapport) },
    ]), { actions: d.modifier && v.statut !== 'annulee' ? ui.bouton('Saisir le résultat', { icone: 'modifier', classe: 'btn-sm', onClic: () => ouvrirResultat(v, recharger) }) : null }));
    return cont;
  }

  function rendrePreparation(v, recharger) {
    const d = v.droits;
    const moi = GMAO.user.id;
    const modifiable = v.statut !== 'annulee';
    const cont = el('div');
    const existants = new Set(v.preparation.map((p) => p.libelle));
    const manquants = CHECKLIST_TYPE.filter((l) => !existants.has(l));
    cont.appendChild(el('div', { class: 'barre-outils' },
      v.preparationTotal ? progression(v.preparationFaits, v.preparationTotal) : null,
      el('span', { class: 'espace' }),
      d.modifier && modifiable && manquants.length ? ui.bouton('Ajouter la check-list type', { icone: 'liste', classe: 'btn-sm', onClic: async () => {
        const veille = new Date(new Date(v.dateDebut).getTime() - 86400000);
        const echeance = ui.dateISO(veille < new Date() ? new Date() : veille);
        try { const res = await api.post(`/api/visites/${v.id}/preparation`, { elements: manquants.map((libelle) => ({ libelle, responsableUserId: v.hoteUserId, echeance })) }); toast(`${manquants.length} point(s) ajouté(s)`, 'succes'); recharger(res); } catch (e) { erreur(e); }
      } }) : null,
      d.modifier && modifiable ? ui.bouton('Ajouter un point', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => ouvrirPreparation(v, null, recharger) }) : null));
    if (!v.preparation.length) { cont.appendChild(ui.vide('Aucun point de préparation : propreté des zones, documents, EPI visiteurs, salle…', 'liste')); return cont; }
    cont.appendChild(ui.table({
      lignes: v.preparation, recherche: false, pagination: false, ligneClasse: (p) => (p.fait ? 'inactif' : ''),
      colonnes: [
        { cle: 'fait', label: 'Fait', aligner: 'centre', largeur: '60px', rendu: (p) => {
          const peut = modifiable && (d.modifier || Number(p.responsableUserId) === moi);
          const cb = el('input', { type: 'checkbox', checked: !!p.fait, disabled: !peut, title: peut ? 'Cocher / décocher' : '' });
          cb.addEventListener('click', (ev) => ev.stopPropagation());
          cb.addEventListener('change', async () => { try { recharger(await api.put(`/api/visites/${v.id}/preparation/${p.id}`, { fait: cb.checked })); } catch (e) { cb.checked = !cb.checked; erreur(e); } });
          return cb;
        } },
        { cle: 'libelle', label: 'Point à préparer', rendu: (p) => el('div', null, el('div', { class: 'cellule-principale' }, p.libelle), p.fait ? el('div', { class: 'cellule-secondaire' }, `Fait le ${ui.formatDateHeure(p.faitLe)}${p.faitParNom ? ' par ' + p.faitParNom : ''}`) : null) },
        { cle: 'responsableNom', label: 'Responsable' },
        { cle: 'echeance', label: 'Échéance', rendu: (p) => (p.echeance ? el('span', { class: p.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(p.echeance)) : el('span', { class: 'texte-2' }, '—')) },
      ],
      actions: [
        { icone: 'modifier', titre: 'Modifier', visible: () => d.modifier && modifiable, onClic: (p) => ouvrirPreparation(v, p, recharger) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: () => d.modifier && modifiable, onClic: async (p) => {
          if (!(await ui.confirm({ titre: 'Supprimer le point', message: `Supprimer « ${p.libelle} » ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { recharger(await api.del(`/api/visites/${v.id}/preparation/${p.id}`)); toast('Point supprimé', 'succes'); } catch (e) { erreur(e); }
        } },
      ],
    }).el);
    return cont;
  }

  function rendreVisiteurs(v, recharger) {
    const d = v.droits;
    const modifiable = v.statut !== 'annulee';
    const cloturee = estFinal(v.statut);
    const cont = el('div');
    const avecCoordonnees = v.visiteurs.some((x) => 'telephone' in x);
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${v.nbVisiteurs} visiteur(s) · ${v.nbArrives} arrivé(s) · ${v.nbPresents} sur le site`),
      el('span', { class: 'espace' }),
      v.visiteurs.length ? ui.bouton('Imprimer les badges', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerBadges(v.visiteurs.filter((x) => x.etat !== 'parti').map((x) => badgeDepuisFiche(v, x))) }) : null,
      v.visiteurs.length ? ui.bouton('Imprimer la liste', { icone: 'liste', classe: 'btn-sm', onClic: () => imprimerVisiteurs(v) }) : null,
      d.modifier && modifiable ? ui.bouton('Ajouter un visiteur', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => ouvrirVisiteur(v, null, recharger) }) : null));
    if (!v.visiteurs.length) { cont.appendChild(ui.vide('Aucun visiteur enregistré pour cette visite', 'utilisateurs')); return cont; }
    cont.appendChild(ui.table({
      lignes: v.visiteurs, recherche: v.visiteurs.length > 8, pagination: false,
      colonnes: [
        { cle: 'etat', label: 'État', rendu: (x) => badgeEtat(x.etat) },
        { cle: 'nom', label: 'Visiteur', rendu: (x) => el('div', null, el('div', { class: 'cellule-principale' }, nomVisiteur(x)), el('div', { class: 'cellule-secondaire' }, [x.societe, x.fonction].filter(Boolean).join(' · '))) },
        avecCoordonnees ? { cle: 'telephone', label: 'Coordonnées', rendu: (x) => (x.anonymiseLe ? el('span', { class: 'texte-2 texte-petit' }, `Anonymisées le ${ui.formatDate(x.anonymiseLe)}`) : el('div', { class: 'texte-petit' }, [x.telephone, x.email, x.vehicule ? 'Véhicule ' + x.vehicule : '', x.pieceIdentite ? 'Pièce ' + x.pieceIdentite : ''].filter(Boolean).join(' · ') || '—')) } : null,
        { cle: 'accompagnateurNom', label: 'Accompagnateur' },
        { cle: 'charteAcceptee', label: 'Charte', aligner: 'centre', rendu: (x) => (x.charteAcceptee ? ui.badge('Acceptée', '#16a34a', { titre: ui.formatDateHeure(x.charteAccepteeLe) }) : el('span', { class: 'texte-2' }, '—')) },
        { cle: 'epiFournis', label: 'EPI', rendu: (x) => el('span', { class: 'texte-petit' }, (x.epiFournis || []).join(', ')) },
        { cle: 'arrivee', label: 'Arrivée', type: 'datetime' },
        { cle: 'depart', label: 'Départ', type: 'datetime' },
        { cle: 'badgeNumero', label: 'Badge', rendu: (x) => el('code', { class: 'texte-petit' }, x.badgeNumero) },
      ].filter(Boolean),
      actions: [
        { icone: 'check', titre: 'Enregistrer l\'arrivée', classe: 'texte-ok', visible: (x) => d.accueil && !cloturee && x.etat === 'attendu', onClic: (x) => ouvrirArrivee(v.id, x, v.hoteUserId, recharger) },
        { icone: 'deconnexion', titre: 'Enregistrer le départ', classe: 'texte-danger', visible: (x) => d.accueil && x.etat === 'present', onClic: (x) => enregistrerDepart(v.id, x.id, nomVisiteur(x), recharger) },
        { icone: 'imprimer', titre: 'Imprimer le badge', visible: (x) => x.etat !== 'parti', onClic: (x) => imprimerBadges([badgeDepuisFiche(v, x)]) },
        { icone: 'modifier', titre: 'Modifier', visible: (x) => d.modifier && modifiable && !x.anonymiseLe, onClic: (x) => ouvrirVisiteur(v, x, recharger) },
        { icone: 'supprimer', titre: 'Retirer', classe: 'texte-danger', visible: (x) => d.modifier && modifiable && x.etat !== 'present' && (!x.arrivee || d.supprimer), onClic: async (x) => {
          if (!(await ui.confirm({ titre: 'Retirer le visiteur', message: x.arrivee ? `${nomVisiteur(x)} figure au registre d'accueil : son passage sera effacé. Continuer ?` : `Retirer ${nomVisiteur(x)} de la visite ?`, okLabel: 'Retirer', danger: true }))) return;
          try { recharger(await api.del(`/api/visites/${v.id}/visiteurs/${x.id}`)); toast('Visiteur retiré', 'succes'); } catch (e) { erreur(e); }
        } },
      ],
    }).el);
    if (avecCoordonnees) cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, `Coordonnées personnelles visibles des seuls gestionnaires de la visite ; elles sont anonymisées ${cfg().conserverVisiteursJours || 365} jours après la visite.`));
    return cont;
  }

  function rendreConstats(v, recharger) {
    const d = v.droits;
    const moi = GMAO.user.id;
    const modifiable = v.statut !== 'annulee';
    const cont = el('div');
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${v.nbConstats} constat(s) · ${v.nbNc} non-conformité(s), ${v.ncOuvertes} ouverte(s) · ${v.actionsOuvertes} action(s) ouverte(s)${v.actionsEnRetard ? `, dont ${v.actionsEnRetard} en retard` : ''}`),
      el('span', { class: 'espace' }),
      ui.bouton('Imprimer le rapport', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerRapport(v) }),
      d.modifier && modifiable ? ui.bouton('Nouveau constat', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => ouvrirConstat(v, null, recharger) }) : null));
    if (!v.constats.length) { cont.appendChild(ui.vide('Aucun constat : non-conformités, observations, pistes d\'amélioration et points forts relevés lors de la visite', 'audit')); return cont; }
    v.constats.forEach((c, i) => {
      const actions = ui.table({
        compact: true, recherche: false, pagination: false, lignes: c.actions, vide: 'Aucune action', ligneClasse: (a) => (a.final ? 'inactif' : ''),
        colonnes: [
          { cle: 'libelle', label: 'Action', rendu: (a) => el('div', null, el('div', { class: 'cellule-principale' }, a.libelle), a.commentaire ? el('div', { class: 'cellule-secondaire' }, a.commentaire) : null, a.commentaireVerification ? el('div', { class: 'cellule-secondaire' }, `Vérification (${a.verifieParNom}, ${ui.formatDate(a.dateVerification)}) : ${a.commentaireVerification}`) : null) },
          { cle: 'responsableNom', label: 'Responsable' },
          { cle: 'echeance', label: 'Échéance', rendu: (a) => (a.echeance ? el('span', { class: a.enRetard ? 'texte-danger texte-gras' : '' }, ui.formatDate(a.echeance), a.enRetard ? ' (retard)' : '') : el('span', { class: 'texte-2' }, '—')) },
          { cle: 'statut', label: 'Statut', liste: 'statutsAction' },
          { cle: 'demande', label: 'Demande / OT', rendu: (a) => (a.demande ? el('div', null, lienVue('#/demandes/' + a.demande.id, a.demande.numero || '#' + a.demande.id), a.demande.statut ? frag(' ', ui.badgeListe('statutsDemande', a.demande.statut)) : null, a.demande.ot ? el('div', { class: 'cellule-secondaire' }, lienVue('#/ot/' + a.demande.ot.id, a.demande.ot.numero)) : null) : el('span', { class: 'texte-2' }, '—')) },
        ],
        actions: [
          { icone: 'modifier', titre: 'Modifier / avancement', visible: (a) => modifiable && (d.modifier || (Number(a.responsableUserId) === moi && !a.final)), onClic: (a) => ouvrirAction(v.id, c.id, a, d.modifier, recharger) },
          { icone: 'check', titre: 'Vérifier l\'efficacité', classe: 'texte-ok', visible: (a) => modifiable && d.valider && a.statut === 'realisee', onClic: (a) => ouvrirVerification(v.id, c.id, a, recharger) },
          { icone: 'demandes', titre: 'Créer une demande d\'intervention', visible: (a) => modifiable && d.modifier && !a.final && !a.demande && GMAO.can('demandes', 'creer'), onClic: (a) => ouvrirCreationDemande(v.id, c.id, a, recharger) },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (a) => modifiable && d.modifier && !a.demande && (a.statut !== 'verifiee' || d.supprimer), onClic: async (a) => {
            if (!(await ui.confirm({ titre: 'Supprimer l\'action', message: `Supprimer « ${a.libelle} » ?`, okLabel: 'Supprimer', danger: true }))) return;
            try { recharger(await api.del(`/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`)); toast('Action supprimée', 'succes'); } catch (e) { erreur(e); }
          } },
        ],
      });
      const titre = frag(`${i + 1}. `, ui.badgeListe('typesConstat', c.typeCode), ' ', c.exigence || '', ' ', c.ouvert ? ui.badge('Ouvert', '#f59e0b', { contour: true }) : (c.actions.length ? ui.badge('Soldé', '#16a34a', { contour: true }) : null));
      cont.appendChild(ui.carte(titre, frag(
        el('p', { style: { whiteSpace: 'pre-wrap', marginTop: 0 } }, c.description),
        c.preuve ? el('p', { class: 'texte-2 texte-petit', style: { whiteSpace: 'pre-wrap' } }, 'Preuve : ', c.preuve) : null,
        c.secteurNom || c.equipement ? el('p', { class: 'texte-petit' }, c.secteurNom || '', c.equipement ? frag(c.secteurNom ? ' · ' : '', lienVue('#/equipements/' + c.equipement.id, `${c.equipement.numero} · ${c.equipement.nom}`)) : null) : null,
        c.actions.length ? actions.el : (c.ouvert ? ui.alerte('Aucune action définie pour ce constat.', 'alerte') : null)),
      { actions: d.modifier && modifiable ? frag(
        ui.bouton('Action', { icone: 'plus', classe: 'btn-sm', titre: 'Ajouter une action', onClic: () => ouvrirAction(v.id, c.id, null, true, recharger) }),
        ui.bouton('', { icone: 'modifier', classe: 'btn-sm btn-icone', titre: 'Modifier le constat', onClic: () => ouvrirConstat(v, c, recharger) }),
        c.actions.some((a) => a.demande) ? null : ui.bouton('', { icone: 'supprimer', classe: 'btn-sm btn-icone texte-danger', titre: 'Supprimer le constat', onClic: async () => {
          if (!(await ui.confirm({ titre: 'Supprimer le constat', message: `Supprimer ce constat et ses ${c.actions.length} action(s) ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { recharger(await api.del(`/api/visites/${v.id}/constats/${c.id}`)); toast('Constat supprimé', 'succes'); } catch (e) { erreur(e); }
        } })) : null }));
    });
    return cont;
  }

  function rendreDocuments(v, recharger) {
    const d = v.droits;
    const cont = el('div');
    const url = (doc, telecharger) => `/api/visites/${v.id}/documents/${doc.id}${telecharger ? '?telecharger=1' : ''}`;
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, `${v.documents.length} document(s) · programme, rapport d'audit, certificats · 10 Mo maximum par fichier`),
      el('span', { class: 'espace' }),
      d.modifier && v.statut !== 'annulee' ? ui.bouton('Ajouter un document', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => ouvrirDocument(v, recharger) }) : null));
    if (!v.documents.length) { cont.appendChild(ui.vide('Aucun document joint', 'piece_jointe')); return cont; }
    cont.appendChild(ui.table({
      lignes: v.documents, recherche: false, pagination: false,
      colonnes: [
        { cle: 'nom', label: 'Document', rendu: (doc) => el('div', null, el('a', { href: url(doc), target: '_blank', rel: 'noopener', class: 'cellule-principale', onclick: (ev) => ev.stopPropagation() }, doc.nom), doc.description ? el('div', { class: 'cellule-secondaire' }, doc.description) : null) },
        { cle: 'categorie', label: 'Catégorie', rendu: (doc) => (CATEGORIES_DOC.find((c) => c.value === doc.categorie) || {}).label || doc.categorie },
        { cle: 'taille', label: 'Taille', aligner: 'droite', rendu: (doc) => tailleLisible(doc.taille), valeurTri: (doc) => doc.taille },
        { cle: 'date', label: 'Ajouté le', type: 'datetime' },
        { cle: 'userNom', label: 'Par' },
      ],
      actions: [
        { icone: 'export', titre: 'Télécharger', onClic: (doc) => api.telecharger(url(doc, true), doc.nom).catch(erreur) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: () => d.modifier && v.statut !== 'annulee', onClic: async (doc) => {
          if (!(await ui.confirm({ titre: 'Supprimer le document', message: `Supprimer « ${doc.nom} » ?`, okLabel: 'Supprimer', danger: true }))) return;
          try { recharger(await api.del(`/api/visites/${v.id}/documents/${doc.id}`)); toast('Document supprimé', 'succes'); } catch (e) { erreur(e); }
        } },
      ],
    }).el);
    return cont;
  }

  function rendreHistorique(v) {
    if (!v.historique.length) return ui.vide('Aucun historique', 'horloge');
    return ui.carte(`Historique (${v.historique.length})`, el('ul', { class: 'chronologie' }, v.historique.map((h) => el('li', null,
      el('div', null, h.details || h.action),
      el('div', { class: 'chrono-date' }, `${ui.formatDateHeure(h.date)} · ${h.userNom || 'Système'}`)))));
  }

  async function afficherFiche(container, id) {
    let v;
    try { v = await api.get('/api/visites/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'visite', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/visites' }, { label: 'Fiche' }] }));
      container.appendChild(ui.vide(e.status === 404 ? 'Visite introuvable ou hors de votre portée.' : e.message, 'alerte'));
      container.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour aux visites', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/visites?onglet=visites') })));
      return;
    }
    const entete = el('div');
    const corps = el('div');
    container.appendChild(entete);
    container.appendChild(corps);
    let ongletCourant = null;
    function dessiner(fiche) {
      v = fiche;
      const d = v.droits;
      ui.vider(entete); ui.vider(corps);
      entete.appendChild(ui.pageEntete({
        titre: frag(v.titre, ' ', ui.badgeListe('statutsVisite', v.statut)), icone: 'visite',
        filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/visites?onglet=visites' }, { label: v.numero }],
        sousTitre: [v.numero, ui.libelle('typesVisite', v.typeCode), v.organisme, periode(v)].filter(Boolean).join(' · '),
        actions: [
          d.modifier ? ui.bouton('Statut', { icone: 'rafraichir', onClic: () => ouvrirStatut(v, dessiner) }) : null,
          d.modifier && v.statut !== 'annulee' ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(v, { apres: dessiner }) }) : null,
        ],
      }));
      corps.appendChild(el('div', { class: 'barre-outils' },
        ui.bouton('Programme', { icone: 'imprimer', classe: 'btn-sm', titre: 'Imprimer le programme de la visite', onClic: () => imprimerProgramme(v) }),
        ui.bouton('Liste des visiteurs', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerVisiteurs(v) }),
        ui.bouton('Rapport des constats', { icone: 'imprimer', classe: 'btn-sm', onClic: () => imprimerRapport(v) }),
        el('span', { class: 'espace' }),
        d.supprimer ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'btn-sm btn-danger', onClic: async () => {
          if (!(await ui.confirm({ titre: 'Supprimer la visite', message: `Supprimer définitivement ${v.numero} « ${v.titre} » ? Une visite ayant accueilli des visiteurs ne peut pas être supprimée : annulez-la plutôt.`, okLabel: 'Supprimer', danger: true }))) return;
          try { await api.del('/api/visites/' + v.id); toast('Visite supprimée', 'succes'); GMAO.navigate('#/visites?onglet=visites'); } catch (e) { erreur(e); }
        } }) : null));
      if (d.lectureSeule) corps.appendChild(ui.alerte('Ce site est accessible en lecture seule pour vous.', 'info'));
      else if (!d.modifier && (d.roles.hote || d.roles.participant || d.roles.accompagnateur || d.roles.responsableAction || d.roles.responsablePreparation)) corps.appendChild(ui.alerte('Vous êtes concerné(e) par cette visite : seules les opérations qui vous concernent (accueil de vos visiteurs, vos actions, vos points de préparation) sont possibles.', 'info'));
      if (v.statut === 'annulee') corps.appendChild(ui.alerte(`Visite annulée${v.motifAnnulation ? ' : ' + v.motifAnnulation : ''}.`, 'alerte'));
      if (v.nbPresents) corps.appendChild(ui.alerte(`${v.nbPresents} visiteur(s) actuellement sur le site.`, 'ok'));
      const recharger = (nouvelle) => { if (nouvelle && nouvelle.id === v.id) dessiner(nouvelle); else api.get('/api/visites/' + v.id).then(dessiner).catch(erreur); };
      const tabs = ui.onglets([
        { cle: 'infos', label: 'Informations', icone: 'info', rendu: () => rendreInfos(v, recharger) },
        { cle: 'preparation', label: 'Préparation', icone: 'check', badge: v.preparationTotal ? `${v.preparationFaits}/${v.preparationTotal}` : null, rendu: () => rendrePreparation(v, recharger) },
        { cle: 'visiteurs', label: 'Visiteurs', icone: 'utilisateurs', badge: v.nbVisiteurs || null, rendu: () => rendreVisiteurs(v, recharger) },
        { cle: 'constats', label: 'Constats & actions', icone: 'audit', badge: v.nbConstats || null, rendu: () => rendreConstats(v, recharger) },
        { cle: 'documents', label: 'Documents', icone: 'piece_jointe', badge: v.nbDocuments || null, rendu: () => rendreDocuments(v, recharger) },
        { cle: 'historique', label: 'Historique', icone: 'horloge', rendu: () => rendreHistorique(v) },
      ], { hash: true, actif: ongletCourant || undefined, onChange: (cle) => { ongletCourant = cle; } });
      corps.appendChild(tabs.el);
    }
    dessiner(v);
  }

  // ----- Vue -------------------------------------------------------------------------------------------------------
  GMAO.registerView(MODULE, {
    titre: 'Audits & visites', icone: 'visite',
    async rendu(container, { params, query }) {
      if (memo.arreterDouchette) { memo.arreterDouchette(); memo.arreterDouchette = null; }
      const id = params[0] ? Number(params[0]) : null;
      if (params[0] && !Number.isInteger(id)) { container.appendChild(ui.vide('Visite introuvable', 'alerte')); return; }
      if (id) await afficherFiche(container, id); else await afficherAccueil(container, query);
    },
  });
})();
