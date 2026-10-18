/**
 * Vue Utilisateurs : comptes internes, hiérarchie (supérieur, niveau), secteurs,
 * surcharges individuelles de droits (« voit plus ou moins » que son profil),
 * état et réinitialisation de la double authentification, réinitialisation du mot de passe
 * (code à usage unique ou mot de passe temporaire) et demandes faites depuis l'écran de connexion.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  function nomComplet(u) { return `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login; }
  function premierSecteur(u) {
    const ids = u.secteurIds || [];
    if (!ids.length) return null;
    const secteurs = ids.map((id) => ui.secteur(id)).filter(Boolean).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
    return secteurs[0] || null;
  }
  function peutModifier(u) {
    const p = ui.profil(u.profilId);
    return GMAO.can('utilisateurs', 'modifier') && (GMAO.estAdmin() || u.id === GMAO.user.id || !p || (!p.estAdmin && p.niveau > GMAO.perms.niveau));
  }

  /** Réinitialisation de la double authentification d'un autre compte (pôle informatique). */
  function peutReinitialiserDeuxFacteurs(u) {
    return GMAO.can('utilisateurs', 'modifier') && u.id !== GMAO.user.id && peutModifier(u) && !!(u.deuxFacteurs && u.deuxFacteurs.actif);
  }

  /** Badge d'état de la double authentification. */
  function badgeDeuxFacteurs(u, detaille) {
    const d = u.deuxFacteurs || {};
    if (d.actif) {
      return frag(ui.badge('Activée', '#16a34a', { titre: d.activeLe ? 'Depuis le ' + ui.formatDate(d.activeLe) : '' }),
        detaille && d.activeLe ? el('span', { class: 'texte-2 texte-petit' }, ` depuis le ${ui.formatDate(d.activeLe)} · ${d.codesSecoursRestants} code(s) de secours restant(s)`) : null);
    }
    if (d.exige) return ui.badge('À activer (obligatoire)', '#f59e0b');
    return detaille ? ui.badge('Désactivée', '#6b7280') : el('span', { class: 'texte-2' }, '—');
  }

  async function reinitialiserDeuxFacteurs(u, apres) {
    const ok = await ui.confirm({
      titre: 'Réinitialiser la double authentification',
      message: `Réinitialiser la double authentification de ${nomComplet(u)} (téléphone perdu ou remplacé) ? Sa clé et ses codes de secours seront supprimés et ses sessions fermées. ${u.deuxFacteurs && u.deuxFacteurs.exige ? 'Elle lui étant imposée, il devra la configurer de nouveau à sa prochaine connexion.' : 'Il pourra la configurer de nouveau depuis le menu de son compte.'}`,
      okLabel: 'Réinitialiser', danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/api/utilisateurs/${u.id}/2fa/reinitialiser`);
      toast(`Double authentification de ${nomComplet(u)} réinitialisée`, 'succes');
      if (apres) apres();
    } catch (e) { erreur(e); }
  }

  let rafraichir = () => {};

  /** Tableau « site → aucun / lecture seule / complet » ; le site de rattachement est indiqué. */
  function rendreAccesSites(existant, verrou, exposer) {
    const sites = (GMAO.refs.secteurs || []).filter((s) => s.type === 'site');
    const cont = el('div');
    if (!sites.length) { cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Aucun site défini (Configuration › Secteurs & sites).')); exposer({ valeurs: () => [] }); return cont; }
    const actuels = new Map(((existant && existant.siteAcces) || []).map((a) => [Number(a.siteId), a.mode]));
    const mesSites = new Map(((GMAO.perms && GMAO.perms.sites) || []).map((x) => [x.id, x.mode]));
    const selects = [];
    const lignes = sites.map((site) => {
      const rattache = ((existant && existant.secteurIds) || []).some((id) => { const sec = ui.secteur(id); return sec && sec.siteId === site.id; });
      const peutLecture = GMAO.estAdmin() || GMAO.perms.portee === 'tous' || mesSites.has(site.id);
      const peutComplet = GMAO.estAdmin() || GMAO.perms.portee === 'tous' || mesSites.get(site.id) === 'complet';
      const sel = el('select', { disabled: verrou || !peutLecture, style: { maxWidth: '240px' } },
        el('option', { value: '' }, rattache ? 'Site de rattachement' : 'Pas d\'accès'),
        el('option', { value: 'lecture' }, 'Lecture seule'),
        el('option', { value: 'complet', disabled: !peutComplet }, 'Accès complet'));
      sel.value = actuels.get(site.id) || '';
      selects.push({ site, sel });
      return el('tr', null, el('td', null, ui.pastille(site.couleur), site.nom, rattache ? el('span', { class: 'texte-2 texte-petit' }, ' (rattachement)') : null), el('td', null, sel));
    });
    cont.appendChild(el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Site'), el('th', null, 'Accès supplémentaire'))), el('tbody', null, lignes))));
    cont.appendChild(el('div', { class: 'aide' }, 'Lecture seule : l\'utilisateur consulte les équipements, demandes, OT… de ce site sans pouvoir les modifier. Accès complet : il y agit selon les droits de son profil.'));
    exposer({ valeurs: () => selects.filter((x) => x.sel.value).map((x) => ({ siteId: x.site.id, mode: x.sel.value })) });
    return cont;
  }

  async function ouvrirFormulaire(existant, apres) {
    const estMoi = !!existant && existant.id === GMAO.user.id;
    const creation = !existant;
    const verrou = estMoi && !GMAO.estAdmin();
    let matrice = null;
    let accesSites = null;
    async function chargerBase(profilId) {
      if (!matrice || !profilId) return;
      try {
        const p = await api.get('/api/profils/' + profilId);
        matrice.setBase(p.estAdmin ? Object.fromEntries(GMAO.modules.map((m) => [m.key, Object.fromEntries(m.actions.map((a) => [a, true]))])) : p.permissions);
      } catch (e) { matrice.setBase({}); }
    }
    const champs = [
      { type: 'separateur', label: 'Identité' },
      { nom: 'login', label: 'Identifiant de connexion', type: 'texte', requis: true, placeholder: 'ex. jdupont' },
      { nom: 'fonction', label: 'Fonction / poste', type: 'texte', placeholder: 'ex. Technicien de maintenance' },
      { nom: 'nom', label: 'Nom', type: 'texte', requis: true },
      { nom: 'prenom', label: 'Prénom', type: 'texte' },
      { nom: 'email', label: 'E-mail', type: 'email' },
      { nom: 'telephone', label: 'Téléphone', type: 'tel' },
      { nom: 'matricule', label: 'Matricule', type: 'texte' },
      { nom: 'actif', label: 'Compte actif', type: 'booleen', valeur: true, disabled: verrou },
      { type: 'separateur', label: 'Accès et hiérarchie' },
      { nom: 'profilId', label: 'Profil (niveau de droits)', type: 'select', requis: true, options: ui.optionsProfils({ vide: '— Choisir un profil —' }), disabled: verrou, onChange: (v) => chargerBase(v) },
      { nom: 'managerId', label: 'Supérieur hiérarchique (N+1)', type: 'select', options: ui.optionsUsers({ vide: '— Aucun —', filtre: (u) => !existant || u.id !== existant.id }), aide: 'Utilisé pour la validation des demandes et l\'organigramme' },
      { nom: 'secteurIds', label: 'Secteurs rattachés', type: 'multiselect', options: ui.optionsSecteurs({ vide: false }), aide: 'Aucun secteur coché = pas de restriction de secteur (si la portée le permet). Les sous-secteurs sont inclus automatiquement.', pleineLargeur: true, disabled: verrou },
      { type: 'html', label: 'Accès aux autres sites', rendu: () => rendreAccesSites(existant, verrou, (api) => { accesSites = api; }) },
      { nom: 'porteeOverride', label: 'Portée des données (surcharge)', type: 'select', options: [{ value: '', label: 'Héritée du profil' }].concat(Object.entries(GMAO.catalogue.portees || {}).map(([k, v]) => ({ value: k, label: v }))), disabled: verrou },
      { type: 'separateur', label: 'Mot de passe' },
      { nom: 'password', label: creation ? 'Mot de passe initial' : 'Nouveau mot de passe (vide = inchangé)', type: 'mdp', aide: creation ? 'Vide = mot de passe aléatoire sécurisé, affiché une seule fois' : '' },
      { nom: 'doitChangerMdp', label: 'Obliger à changer le mot de passe à la prochaine connexion', type: 'booleen', valeur: true },
      ...ui.champsPersoDefs('utilisateurs'),
    ];
    if (!verrou) {
      champs.push({ type: 'separateur', label: 'Droits individuels (surcharges du profil)' });
      champs.push({ type: 'html', rendu: () => {
        matrice = ui.matriceDroits({ mode: 'surcharges', valeurs: existant ? existant.overrides || {} : {}, base: {} });
        return el('div', null, el('p', { class: 'texte-2 texte-petit' }, 'Chaque case affiche le droit hérité du profil. Cliquez pour accorder un droit en plus (vert) ou le retirer (rouge) pour cet utilisateur uniquement ; un nouveau clic revient à la valeur héritée.'), matrice.el);
      } });
    }
    const valeurs = existant
      ? Object.assign({}, existant, { porteeOverride: existant.porteeOverride || '', password: '', doitChangerMdp: false }, ui.champsPersoInitiaux(existant))
      : { doitChangerMdp: true, actif: true };
    ui.formModal({
      titre: creation ? 'Nouvel utilisateur' : `Modifier ${nomComplet(existant)}`, taille: 'large', champs, valeurs,
      onSubmit: async (v) => {
        const body = Object.assign({}, v, { champs: ui.champsPersoValeurs(v), porteeOverride: v.porteeOverride || null, managerId: v.managerId === '' ? null : v.managerId });
        if (matrice) body.overrides = matrice.valeurs();
        if (accesSites && !verrou) body.siteAcces = accesSites.valeurs();
        if (!body.password) delete body.password;
        for (const k of Object.keys(body)) if (k.startsWith('champs.')) delete body[k];
        const res = creation ? await api.post('/api/utilisateurs', body) : await api.put('/api/utilisateurs/' + existant.id, body);
        toast(creation ? 'Utilisateur créé' : 'Utilisateur enregistré', 'succes');
        if (res && res.motDePasseInitial) {
          ui.modal({ titre: 'Mot de passe initial', taille: 'petite', contenu: frag(el('p', null, `Mot de passe généré pour ${res.login} :`), el('p', null, el('code', { style: { fontSize: '16px', userSelect: 'all' } }, res.motDePasseInitial)), el('p', { class: 'texte-2 texte-petit' }, 'Communiquez-le à l\'utilisateur de façon confidentielle : il ne sera plus affiché. Il devra le changer à sa première connexion.')), boutons: [{ label: 'Fermer' }] });
        }
        if (estMoi) await GMAO.refresh(false); else await GMAO.refreshRefs();
        if (apres) apres(res);
      },
    });
    if (existant) chargerBase(existant.profilId);
  }

  async function afficherFiche(id) {
    let u;
    try { u = await api.get('/api/utilisateurs/' + id); } catch (e) { return erreur(e); }
    const p = u.permissionsEffectives;
    const profil = ui.profil(u.profilId);
    const demande = demandeDe(u);
    const recharger = () => { m.fermer(); afficherFiche(u.id); };
    const m = ui.modal({
      titre: nomComplet(u), taille: 'large',
      contenu: ui.onglets([
        { cle: 'infos', label: 'Informations', rendu: () => frag(
          demande && peutReinitialiserMdp(u) ? el('div', { class: 'alerte alerte-alerte bandeau-demandes' }, icone('cle'),
            el('span', null, `Demande de réinitialisation du mot de passe en attente (${ui.relatif(demande.derniereDemande)}${demande.repetitions > 1 ? `, ${demande.repetitions} demandes` : ''}).`),
            ui.bouton('Traiter', { classe: 'btn-sm btn-primaire', onClic: () => { m.fermer(); reinitialiserMdp(u, { demande, apres: () => { majDemandes(true); } }); } })) : null,
          ui.details([
            { label: 'Identifiant', valeur: u.login }, { label: 'Statut', valeur: u.actif === false ? ui.badge('Désactivé', '#dc2626') : ui.badge('Actif', '#16a34a') },
            { label: 'Fonction', valeur: u.fonction }, { label: 'Matricule', valeur: u.matricule },
            { label: 'E-mail', valeur: u.email ? el('a', { href: 'mailto:' + u.email }, u.email) : '' }, { label: 'Téléphone', valeur: u.telephone },
            { label: 'Profil', valeur: profil ? frag(ui.pastille(profil.couleur), `${profil.nom} (niveau ${profil.niveau})`) : '' },
            { label: 'Portée des données', valeur: (GMAO.catalogue.portees || {})[p.portee] || p.portee },
            { label: 'Secteurs', valeur: (u.secteurIds || []).length ? u.secteurIds.map((s) => ui.cheminSecteur(s)).join(', ') : 'Tous (aucune restriction)' },
            { label: 'Sites accessibles', valeur: (p.sites || []).length ? p.sites.map((x) => `${x.nom}${x.mode === 'lecture' ? ' (lecture seule)' : ''}`).join(', ') : '—' },
            { label: 'Supérieur hiérarchique', valeur: u.managerId != null ? el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); m.fermer(); afficherFiche(u.managerId); } }, ui.nomUser(u.managerId)) : '—' },
            { label: 'Subordonnés', valeur: (u.subordonnes || []).length ? u.subordonnes.map((s) => nomComplet(s)).join(', ') : '—' },
            { label: 'Dernière connexion', valeur: ui.formatDateHeure(u.derniereConnexion) }, { label: 'Créé le', valeur: ui.formatDateHeure(u.createdAt) },
            { label: 'Double authentification', valeur: badgeDeuxFacteurs(u, true) },
            u.motDePasse ? { label: 'Mot de passe', valeur: etatMotDePasse(u, recharger) } : null,
            ...ui.champsPersoAffichage('utilisateurs', u),
          ], { colonnes: 2 }),
        ) },
        { cle: 'droits', label: 'Droits effectifs', rendu: () => frag(
          el('p', { class: 'texte-2 texte-petit' }, 'Droits réellement appliqués : profil + surcharges individuelles (vert = accordé en plus, rouge = retiré). Les modules désactivés dans la configuration sont exclus.'),
          ui.matriceDroits({ mode: 'surcharges', valeurs: u.overrides || {}, base: p.modules, disabled: true }).el,
        ) },
      ]).el,
      boutons: [
        peutReinitialiserMdp(u) ? { label: 'Réinitialiser le mot de passe', icone: 'cle', gauche: true, onClic: () => { m.fermer(); reinitialiserMdp(u, { demande, apres: () => { majDemandes(true); } }); } } : null,
        peutReinitialiserDeuxFacteurs(u) ? { label: 'Réinitialiser la double authentification', icone: 'profils', gauche: true, onClic: () => { m.fermer(); reinitialiserDeuxFacteurs(u, () => rafraichir()); } } : null,
        u.id === GMAO.user.id ? { label: 'Ma double authentification', icone: 'profils', gauche: true, onClic: () => { m.fermer(); GMAO.ouvrirDoubleAuthentification(); } } : null,
        peutModifier(u) ? { label: 'Modifier', icone: 'modifier', classe: 'btn-primaire', onClic: () => { m.fermer(); ouvrirFormulaire(u, () => rafraichir()); } } : null,
        { label: 'Fermer' },
      ],
    });
  }

  // ----- Mots de passe : réinitialisation (code ou mot de passe temporaire), demandes de l'écran de connexion -----
  /** Demandes de réinitialisation en attente (comptes que l'on peut gérer) ; rechargées par `majDemandes`. */
  let demandesEnAttente = [];
  let majDemandes = async () => {};
  /** Dernière liste des comptes chargée par la vue (état de la double authentification compris). */
  let utilisateursCharges = [];

  const LIBELLES_RAISON = { initial: 'mot de passe initial', reinitialise: 'mot de passe temporaire', expire: 'mot de passe expiré', administrateur: 'défini par un administrateur' };
  const LIBELLES_TRAITEMENT = { code: 'Code de réinitialisation remis', temporaire: 'Mot de passe temporaire remis', utilisateur: 'Mot de passe changé par l\'utilisateur' };
  /** Issue d'une demande traitée ou rejetée : « Code de réinitialisation remis par … le … ». */
  function issueDemande(d) {
    const le = d.traiteeLe ? `le ${ui.formatDateHeure(d.traiteeLe)}` : '';
    if (d.statut === 'rejetee') return [d.traiteeParNom ? `Par ${d.traiteeParNom}` : '', le].filter(Boolean).join(' ');
    if (d.mode === 'utilisateur') return [LIBELLES_TRAITEMENT.utilisateur, le].filter(Boolean).join(' ');
    const par = d.traiteeParNom ? `par ${d.traiteeParNom}` : (d.mode === 'code' ? 'par récupération d\'urgence' : '');
    return [LIBELLES_TRAITEMENT[d.mode] || 'Traitée', par, le].filter(Boolean).join(' ');
  }

  function peutReinitialiserMdp(u) {
    return GMAO.can('utilisateurs', 'modifier') && u.id !== GMAO.user.id && peutModifier(u) && u.actif !== false;
  }
  const demandeDe = (u) => demandesEnAttente.find((d) => d.userId === u.id) || null;
  /** Adresse du poste (IPv4 sans préfixe IPv6). */
  const adresse = (ip) => String(ip || '').replace(/^::ffff:/, '') || 'adresse inconnue';
  /** Résumé du poste à partir de son identification (application ou navigateur, système). */
  function resumePoste(ua) {
    const s = String(ua || '');
    if (!s) return 'Poste non identifié';
    const appli = /GMAO|Electron/i.test(s) ? 'Application GMAO' : /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Navigateur';
    const os = /Windows NT 10/.test(s) ? 'Windows 10/11' : /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${appli} · ${os}` : appli;
  }
  /** Durée lisible : « 60 minutes », « 2 heures », « 1 h 30 ». */
  function duree(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} minute${m > 1 ? 's' : ''}`;
    const h = Math.floor(m / 60); const r = m % 60;
    return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} heure${h > 1 ? 's' : ''}`;
  }

  /** Mode d'emploi remis à l'utilisateur (fenêtre de résultat et fiche imprimée). */
  function etapesUtilisateur(u, r) {
    if (r.mode === 'code') {
      return [
        'Sur l\'écran de connexion de la GMAO, cliquez sur « J\'ai un code de réinitialisation ».',
        `Saisissez votre identifiant « ${u.login} » et le code ${r.code} (majuscules ou minuscules, avec ou sans tiret).`,
        'Choisissez votre nouveau mot de passe : vous êtes aussitôt connecté (le code de votre application d\'authentification vous est demandé si la double authentification est active).',
      ];
    }
    return [
      `Sur l'écran de connexion de la GMAO, saisissez votre identifiant « ${u.login} » et ce mot de passe temporaire.`,
      'Choisissez aussitôt votre nouveau mot de passe personnel : il vous est demandé avant tout autre écran.',
      'Détruisez ce document une fois votre mot de passe changé.',
    ];
  }

  /** Fiche à remettre à l'utilisateur (impression sans script : bouton [data-imprimer] piloté par l'application). */
  function imprimerFiche(u, r) {
    const code = r.mode === 'code';
    const valeur = code ? r.code : r.motDePasse;
    const html = `<h2>${code ? 'Code de réinitialisation de votre mot de passe' : 'Mot de passe temporaire'}</h2>`
      + `<dl><dt>Nom</dt><dd>${ui.esc(nomComplet(u))}</dd><dt>Identifiant</dt><dd><strong>${ui.esc(u.login)}</strong></dd>`
      + `<dt>${code ? 'Code' : 'Mot de passe temporaire'}</dt><dd><span style="font-family:Consolas,'Courier New',monospace;font-size:26px;font-weight:700;letter-spacing:3px">${ui.esc(valeur)}</span></dd>`
      + `<dt>Validité</dt><dd>${code ? `jusqu'au ${ui.esc(ui.formatDateHeure(r.expireLe))}, utilisable une seule fois` : 'à remplacer dès la première connexion'}</dd></dl>`
      + `<h2>Mode d'emploi</h2><ol style="font-size:14px;line-height:1.7">${etapesUtilisateur(u, r).map((t) => `<li>${ui.esc(t)}</li>`).join('')}</ol>`
      + '<p>Document confidentiel : ne le confiez à personne et détruisez-le une fois votre mot de passe changé. Le pôle informatique ne vous demandera jamais votre mot de passe.</p>'
      + `<p class="texte-2">Remis par ${ui.esc(ui.nomUser(GMAO.user.id) || GMAO.user.login)} le ${ui.esc(ui.formatDateHeure(new Date()))}.</p>`
      + '<p><button type="button" data-imprimer>Imprimer</button></p>';
    ui.imprimer(code ? 'Réinitialisation du mot de passe' : 'Mot de passe temporaire', html);
  }

  /** Résultat affiché une seule fois : code (ou mot de passe temporaire) en grand, validité, copie, fiche imprimable. */
  function afficherResultat(m, u, r) {
    const code = r.mode === 'code';
    const valeur = code ? r.code : r.motDePasse;
    m.setTitre(code ? 'Code de réinitialisation' : 'Mot de passe temporaire');
    ui.vider(m.corps);
    m.corps.appendChild(frag(
      el('p', null, 'Pour ', el('strong', null, nomComplet(u)), ` (identifiant « ${u.login} »)`),
      el('div', { class: 'secret-unique' + (code ? '' : ' mdp'), 'aria-label': code ? 'Code de réinitialisation' : 'Mot de passe temporaire' }, valeur),
      el('div', { class: 'texte-centre texte-petit texte-2 mb' }, code
        ? `Valable jusqu'au ${ui.formatDateHeure(r.expireLe)} (${duree((Date.parse(r.expireLe) - Date.now()) / 60000)}) · utilisable une seule fois`
        : 'À changer à la première connexion · ses sessions ouvertes ont été fermées'),
      ui.alerte(`${code ? 'Ce code' : 'Ce mot de passe'} ne sera plus affiché. Remettez-le à l'utilisateur en personne ou par téléphone, après avoir vérifié son identité.`, 'alerte'),
      el('div', { class: 'texte-gras texte-petit' }, 'Mode d\'emploi pour l\'utilisateur'),
      el('ol', { class: 'texte-petit etapes-reinit' }, etapesUtilisateur(u, r).map((t) => el('li', null, t)))));
    m.setBoutons([
      { label: 'Copier', icone: 'copier', gauche: true, onClic: async () => {
        if (await ui.copier(valeur)) toast(code ? 'Code copié' : 'Mot de passe copié', 'succes');
        else toast('Copie impossible : sélectionnez le texte et utilisez Ctrl+C', 'info');
        return false;
      } },
      { label: 'Imprimer la fiche', icone: 'imprimer', onClic: () => { imprimerFiche(u, r); return false; } },
      { label: 'Fermer', classe: 'btn-primaire' },
    ]);
  }

  /**
   * Réinitialisation du mot de passe d'un compte : code de réinitialisation (recommandé, l'utilisateur choisit
   * lui-même son mot de passe) ou mot de passe temporaire. `options.demande` : demande traitée ; `options.apres`.
   */
  function reinitialiserMdp(u, options = {}) {
    const sc = GMAO.config.securite || {};
    const demande = options.demande || null;
    let mode = 'code';
    const cartes = [];
    const fTemp = ui.form({ colonnes: 1, champs: [{ nom: 'motDePasseTemporaire', label: 'Mot de passe temporaire (facultatif)', type: 'mdp', placeholder: 'Vide = généré automatiquement', aide: 'Doit respecter la politique de mot de passe.' }] });
    fTemp.controles.motDePasseTemporaire.input.setAttribute('autocomplete', 'new-password');
    const detailTemp = el('div', { class: 'choix-detail masque' }, fTemp.el);
    const choix = (valeur, titre, texte, recommande) => {
      const radio = el('input', { type: 'radio', name: 'modeReinitialisation', value: valeur, id: 'f_mode_' + valeur, checked: valeur === mode });
      radio.addEventListener('change', () => { if (radio.checked) { mode = valeur; maj(); } });
      const carte = el('label', { class: 'choix-carte', for: 'f_mode_' + valeur }, radio,
        el('div', null, el('div', { class: 'choix-titre' }, titre, recommande ? ui.badge('Recommandé', '#16a34a') : null), el('div', { class: 'texte-2 texte-petit' }, texte)));
      cartes.push({ valeur, carte });
      return carte;
    };
    const m = ui.modal({ titre: 'Réinitialiser le mot de passe', classe: 'modal-reinit', contenu: frag(
      el('p', null, 'Compte de ', el('strong', null, nomComplet(u)), ` (identifiant « ${u.login} »)`),
      demande ? ui.alerte(`Demande faite depuis l'écran de connexion ${ui.relatif(demande.derniereDemande)} (poste ${adresse(demande.ip)})${demande.repetitions > 1 ? `, ${demande.repetitions} fois` : ''} : elle sera marquée comme traitée.`, 'info') : null,
      demande && demande.nbPostes > 1 ? ui.alerte(`Attention : cette demande a été faite depuis ${demande.nbPostes} postes différents. Vérifiez l'identité de la personne avant de lui remettre un code ou un mot de passe.`, 'alerte') : null,
      el('div', { class: 'choix-liste', role: 'radiogroup', 'aria-label': 'Mode de réinitialisation' },
        choix('code', 'Code de réinitialisation', `L'utilisateur choisit lui-même son nouveau mot de passe depuis l'écran de connexion. Code à usage unique, valable ${duree(Number(sc.dureeCodeReinitialisationMinutes) || 60)} ; son mot de passe actuel reste valable d'ici là.`, true),
        choix('temporaire', 'Mot de passe temporaire', 'À changer à la première connexion. Ses sessions ouvertes sont fermées immédiatement.'),
        detailTemp),
      u.deuxFacteurs && u.deuxFacteurs.actif ? el('p', { class: 'texte-2 texte-petit' }, 'La double authentification de ce compte reste exigée à la connexion.') : null,
      el('p', { class: 'texte-2 texte-petit' }, 'Vérifiez l\'identité de la personne (en face à face ou en la rappelant à un numéro connu) avant de lui remettre le code ou le mot de passe.')) });
    function maj() {
      cartes.forEach((c) => c.carte.classList.toggle('actif', c.valeur === mode));
      detailTemp.classList.toggle('masque', mode !== 'temporaire');
      m.setBoutons([{ label: 'Annuler' }, { label: mode === 'code' ? 'Générer le code' : 'Réinitialiser', classe: 'btn-primaire', icone: 'cle', onClic: async () => {
        const body = { mode };
        if (demande) body.demandeId = demande.id;
        if (mode === 'temporaire' && fTemp.valeurs().motDePasseTemporaire) body.password = fTemp.valeurs().motDePasseTemporaire;
        const r = await api.post(`/api/utilisateurs/${u.id}/reinitialiser-mdp`, body);
        afficherResultat(m, u, r);
        toast(mode === 'code' ? 'Code de réinitialisation créé' : 'Mot de passe réinitialisé', 'succes');
        if (options.apres) options.apres(r);
        return false;
      } }]);
    }
    fTemp.el.addEventListener('submit', (ev) => { ev.preventDefault(); const b = m.pied.querySelector('.btn-primaire'); if (b) b.click(); });
    maj();
  }

  /** Annulation du code de réinitialisation actif d'un compte. */
  async function annulerCode(u, apres) {
    const ok = await ui.confirm({ titre: 'Annuler le code de réinitialisation', message: `Annuler le code de réinitialisation de ${nomComplet(u)} ? Il ne pourra plus être utilisé.`, okLabel: 'Annuler le code', annulerLabel: 'Conserver', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/utilisateurs/${u.id}/code-reinitialisation`);
      toast('Code de réinitialisation annulé', 'succes');
      if (apres) apres();
    } catch (e) { erreur(e); }
  }

  /** État du mot de passe dans la fiche (gestionnaires de comptes) : dernier changement, expiration, code actif. */
  function etatMotDePasse(u, recharger) {
    const mp = u.motDePasse || {};
    const lignes = [el('div', null, mp.dateMdp ? `Modifié le ${ui.formatDateHeure(mp.dateMdp)}` : 'Jamais modifié')];
    lignes.push(el('div', { class: mp.expireLe && Date.parse(mp.expireLe) < Date.now() ? 'texte-danger' : 'texte-2 texte-petit' }, mp.expireLe ? `Expire le ${ui.formatDate(mp.expireLe)}` : 'Sans expiration'));
    if (mp.doitChanger) lignes.push(el('div', null, ui.badge('À changer à la prochaine connexion', '#f59e0b'), mp.raison && LIBELLES_RAISON[mp.raison] ? el('span', { class: 'texte-2 texte-petit' }, ` (${LIBELLES_RAISON[mp.raison]})`) : null));
    if (mp.codeActif) {
      lignes.push(el('div', { class: 'inline', style: { flexWrap: 'wrap' } },
        ui.badge(mp.codeOrigine === 'recuperation_urgence' ? 'Code de récupération d\'urgence actif' : 'Code de réinitialisation actif', '#2563eb'),
        el('span', { class: 'texte-2 texte-petit' }, `jusqu'au ${ui.formatDateHeure(mp.codeExpireLe)}`),
        peutModifier(u) && u.id !== GMAO.user.id ? ui.bouton('Annuler le code', { classe: 'btn-sm btn-lien texte-danger', onClic: () => annulerCode(u, recharger) }) : null));
    }
    return el('div', { class: 'etat-mdp' }, lignes);
  }

  /** Demandes de réinitialisation : en attente (réinitialiser, rejeter) et, sur demande, historique. */
  function ouvrirDemandes() {
    let historique = false;
    const corps = el('div');
    const cb = el('input', { type: 'checkbox', id: 'f_historique_demandes' });
    const m = ui.modal({ titre: 'Demandes de réinitialisation de mot de passe', taille: 'large', classe: 'modal-demandes-mdp', contenu: frag(
      el('p', { class: 'texte-2 texte-petit' }, 'Demandes faites depuis l\'écran de connexion (« Mot de passe oublié ? »). Vérifiez l\'identité de la personne avant de lui remettre un code ; rejetez une demande dont elle n\'est pas à l\'origine.'),
      el('div', { class: 'barre-outils' }, el('label', { class: 'inline', for: 'f_historique_demandes' }, cb, 'Afficher aussi les demandes traitées ou rejetées')),
      corps), boutons: [{ label: 'Fermer' }] });
    cb.addEventListener('change', () => { historique = cb.checked; charger(); });

    const colUtilisateur = { cle: 'nom', label: 'Utilisateur', rendu: (d) => el('div', null, el('div', { class: 'cellule-principale' }, d.nom), el('div', { class: 'cellule-secondaire' }, [d.login, d.profilNom].filter(Boolean).join(' · '))) };
    const colDemande = { cle: 'derniereDemande', label: 'Demande', rendu: (d) => el('div', null,
      el('div', { title: ui.formatDateHeure(d.derniereDemande) }, ui.relatif(d.derniereDemande), d.repetitions > 1 ? frag(' ', ui.badge(`${d.repetitions} demandes`, '#f59e0b')) : null),
      el('div', { class: 'cellule-secondaire' }, d.repetitions > 1 ? `première le ${ui.formatDateHeure(d.createdAt)}` : ui.formatDateHeure(d.createdAt))) };
    // Poste et message d'origine ; demandes suivantes venues d'autres postes signalées (vérifier l'identité du demandeur)
    const autresProvenances = (d) => (d.provenances || []).filter((p) => p.ip !== d.ip || p.message);
    const colPoste = { cle: 'ip', label: 'Poste', rendu: (d) => el('div', { title: d.poste || '' }, el('div', null, adresse(d.ip)), el('div', { class: 'cellule-secondaire' }, resumePoste(d.poste)),
      d.nbPostes > 1 ? el('div', { title: (d.provenances || []).map((p) => `${ui.formatDateHeure(p.date)} : ${adresse(p.ip)}`).join('\n') }, ui.badge(`${d.nbPostes} postes différents`, '#dc2626')) : null) };
    const colMessage = { cle: 'message', label: 'Message', tri: false, rendu: (d) => el('div', null,
      d.message ? el('div', { class: 'message-demande' }, d.message) : el('span', { class: 'texte-2' }, '—'),
      autresProvenances(d).map((p) => el('div', { class: 'cellule-secondaire message-demande' }, `${ui.formatDateHeure(p.date)}, poste ${adresse(p.ip)}${p.message ? ' : ' + p.message : ''}`))) };

    function utilisateurDe(d) {
      return utilisateursCharges.find((x) => x.id === d.userId) || (GMAO.refs.users || []).find((x) => x.id === d.userId) || { id: d.userId, login: d.login, nom: d.nom };
    }
    async function rejeter(d) {
      const motif = await ui.prompt({ titre: 'Rejeter la demande', message: `Rejeter la demande de réinitialisation de ${d.nom} ? L'utilisateur en est informé par une notification.`, label: 'Motif (facultatif, communiqué à l\'utilisateur)', type: 'texte_long', requis: false, okLabel: 'Rejeter la demande' });
      if (motif === null) return;
      try {
        await api.post(`/api/utilisateurs-demandes-mdp/${d.id}/rejeter`, { motif: motif.trim() || undefined });
        toast('Demande rejetée', 'succes');
        charger();
      } catch (e) { erreur(e); }
    }
    async function charger() {
      ui.vider(corps);
      corps.appendChild(ui.chargement());
      let rows;
      try { rows = await api.get('/api/utilisateurs-demandes-mdp', historique ? { toutes: 1 } : null); } catch (e) { ui.vider(corps); corps.appendChild(ui.alerte(e.message, 'danger')); return; }
      const attente = rows.filter((d) => d.statut === 'en_attente');
      demandesEnAttente = attente;
      majDemandes(false);
      ui.vider(corps);
      corps.appendChild(ui.table({
        colonnes: [colUtilisateur, colDemande, colPoste, colMessage, { cle: 'actions', label: '', tri: false, rendu: (d) => el('div', { class: 'inline', style: { justifyContent: 'flex-end' } },
          ui.bouton('Réinitialiser…', { classe: 'btn-sm btn-primaire', icone: 'cle', onClic: () => reinitialiserMdp(utilisateurDe(d), { demande: d, apres: () => { charger(); } }) }),
          ui.bouton('Rejeter', { classe: 'btn-sm', onClic: () => rejeter(d) })) }],
        lignes: attente, recherche: false, pagination: false, compact: true, vide: 'Aucune demande en attente',
      }).el);
      if (historique) {
        const traitees = rows.filter((d) => d.statut !== 'en_attente');
        corps.appendChild(el('h3', { class: 'mt' }, 'Demandes traitées ou rejetées'));
        corps.appendChild(ui.table({
          colonnes: [colUtilisateur, { cle: 'createdAt', label: 'Demande', rendu: (d) => el('div', null, ui.formatDateHeure(d.createdAt), d.repetitions > 1 ? el('div', { class: 'cellule-secondaire' }, `${d.repetitions} demandes`) : null) },
            { cle: 'statut', label: 'Issue', rendu: (d) => el('div', null, d.statut === 'rejetee' ? ui.badge('Rejetée', '#dc2626') : ui.badge('Traitée', '#16a34a'),
              el('div', { class: 'cellule-secondaire' }, issueDemande(d)),
              d.motifRejet ? el('div', { class: 'cellule-secondaire message-demande' }, `Motif : ${d.motifRejet}`) : null) },
            colPoste, colMessage],
          lignes: traitees, recherche: false, pagination: false, compact: true, vide: 'Aucune demande traitée au cours des 90 derniers jours',
        }).el);
      }
    }
    charger();
    return m;
  }

  async function supprimer(u) {
    if (!(await ui.confirm({ titre: 'Supprimer l\'utilisateur', message: `Supprimer le compte de ${nomComplet(u)} ? S'il est référencé dans des interventions, il sera désactivé au lieu d'être supprimé.`, okLabel: 'Supprimer', danger: true }))) return;
    try {
      const r = await api.del('/api/utilisateurs/' + u.id);
      toast(r.desactive ? 'Utilisateur désactivé (référencé dans l\'historique)' : 'Utilisateur supprimé', 'succes');
      await GMAO.refreshRefs(); rafraichir();
    } catch (e) { erreur(e); }
  }

  function rendreOrganigramme(cont) {
    cont.appendChild(ui.chargement());
    api.get('/api/utilisateurs-organigramme').then((racines) => {
      ui.vider(cont);
      if (!racines.length) return cont.appendChild(ui.vide('Aucun utilisateur'));
      cont.appendChild(el('p', { class: 'texte-2 texte-petit' }, 'Arbre construit à partir du champ « Supérieur hiérarchique » de chaque utilisateur.'));
      const construire = (liste) => el('ul', null, liste.map((u) => {
        const p = ui.profil(u.profilId);
        return el('li', null, el('div', { class: 'personne', onclick: () => afficherFiche(u.id), style: { cursor: 'pointer' } }, ui.avatar(nomComplet(u)), el('div', null, el('div', { class: 'p-nom' }, nomComplet(u), ' ', p ? ui.badge(p.nom, p.couleur) : null), el('div', { class: 'p-fonction' }, [u.fonction, (u.secteurIds || []).map((s) => ui.nomSecteur(s)).join(', ')].filter(Boolean).join(' · ')))), u.enfants.length ? construire(u.enfants) : null);
      }));
      cont.appendChild(el('div', { class: 'organigramme' }, construire(racines)));
    }).catch((e) => { ui.vider(cont); cont.appendChild(ui.alerte(e.message, 'danger')); });
  }

  GMAO.registerView('utilisateurs', {
    titre: 'Utilisateurs', icone: 'utilisateurs',
    async rendu(container, { params, query }) {
      const cfg = GMAO.config.utilisateurs || {};
      let utilisateurs = [];
      let tri = cfg.triParSecteur ? 'secteur' : 'nom';
      let grouper = !!cfg.grouperParSecteur;
      let filtreSecteur = '', filtreProfil = '', actifsSeuls = true;

      const groupeSecteur = { cle: (u) => { const s = premierSecteur(u); return s ? s.id : 0; }, label: (id, rows) => frag(id ? ui.pastille((ui.secteur(id) || {}).couleur) : null, id ? ui.cheminSecteur(id) : 'Sans secteur', el('span', { class: 'texte-2' }, ` · ${rows.length}`)), ordre: (a, b) => ((a ? (ui.secteur(a) || {}).ordre || 0 : 999) - (b ? (ui.secteur(b) || {}).ordre || 0 : 999)) };

      const colonnes = [
        { cle: 'nom', label: 'Utilisateur', rendu: (u) => el('div', { class: 'inline' }, ui.avatar(nomComplet(u), 28), el('div', null, el('div', { class: 'cellule-principale' }, nomComplet(u)), el('div', { class: 'cellule-secondaire' }, u.login + (u.fonction ? ' · ' + u.fonction : '')))), valeurTri: (u) => nomComplet(u).toLowerCase() },
        { cle: 'profilId', label: 'Profil', rendu: (u) => { const p = ui.profil(u.profilId); return p ? ui.badge(p.nom, p.couleur, { titre: 'Niveau ' + p.niveau }) : '—'; }, valeurTri: (u) => (ui.profil(u.profilId) || {}).niveau || 99 },
        { cle: 'secteurIds', label: 'Secteurs', rendu: (u) => (u.secteurIds || []).length ? el('div', null, u.secteurIds.map((s) => ui.secteur(s)).filter(Boolean).flatMap((s, i) => [i ? ' ' : null, ui.badge(s.nom, s.couleur, { contour: true })])) : el('span', { class: 'texte-2' }, 'Tous'), valeurTri: (u) => { const s = premierSecteur(u); return s ? (s.ordre || 0) : 999; } },
        cfg.afficherSuperieur !== false ? { cle: 'managerId', label: 'Supérieur', type: 'user' } : null,
        { cle: 'derniereConnexion', label: 'Dernière connexion', rendu: (u) => (u.derniereConnexion ? el('span', { title: ui.formatDateHeure(u.derniereConnexion) }, ui.relatif(u.derniereConnexion)) : el('span', { class: 'texte-2' }, 'jamais')), valeurTri: (u) => u.derniereConnexion || '' },
        { cle: 'deuxFacteurs', label: 'Double auth.', rendu: (u) => badgeDeuxFacteurs(u, false), valeurTri: (u) => (u.deuxFacteurs && u.deuxFacteurs.actif ? 0 : (u.deuxFacteurs && u.deuxFacteurs.exige ? 1 : 2)), aligner: 'centre' },
        { cle: 'actif', label: 'Statut', rendu: (u) => (u.actif === false ? ui.badge('Désactivé', '#dc2626') : ui.badge('Actif', '#16a34a')), aligner: 'centre' },
      ].filter(Boolean);

      const tableau = ui.table({
        colonnes, lignes: [], recherche: 'Rechercher un utilisateur…', exportCsv: 'utilisateurs.csv',
        onClic: (u) => afficherFiche(u.id),
        ligneClasse: (u) => (u.actif === false ? 'inactif' : ''),
        groupe: grouper ? groupeSecteur : null,
        actions: [
          { icone: 'modifier', titre: 'Modifier', visible: peutModifier, onClic: (u) => ouvrirFormulaire(u, rafraichir) },
          { icone: 'cle', titre: 'Réinitialiser le mot de passe', visible: peutReinitialiserMdp, onClic: (u) => reinitialiserMdp(u, { demande: demandeDe(u), apres: () => { majDemandes(true); } }) },
          { icone: 'profils', titre: 'Réinitialiser la double authentification', visible: peutReinitialiserDeuxFacteurs, onClic: (u) => reinitialiserDeuxFacteurs(u, rafraichir) },
          { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (u) => GMAO.can('utilisateurs', 'supprimer') && u.id !== GMAO.user.id && peutModifier(u), onClic: supprimer },
        ],
      });

      function appliquer() {
        let rows = utilisateurs.slice();
        if (actifsSeuls) rows = rows.filter((u) => u.actif !== false);
        if (filtreSecteur === 'aucun') rows = rows.filter((u) => !(u.secteurIds || []).length);
        else if (filtreSecteur) rows = rows.filter((u) => (u.secteurIds || []).map(String).includes(filtreSecteur));
        if (filtreProfil) rows = rows.filter((u) => String(u.profilId) === filtreProfil);
        const cmpNom = (a, b) => nomComplet(a).localeCompare(nomComplet(b));
        if (tri === 'secteur') rows.sort((a, b) => { const sa = premierSecteur(a), sb = premierSecteur(b); return ((sa ? sa.ordre || 0 : 999) - (sb ? sb.ordre || 0 : 999)) || ((sa ? sa.nom : '').localeCompare(sb ? sb.nom : '')) || cmpNom(a, b); });
        else if (tri === 'profil') rows.sort((a, b) => (((ui.profil(a.profilId) || {}).niveau || 99) - ((ui.profil(b.profilId) || {}).niveau || 99)) || cmpNom(a, b));
        else if (tri === 'connexion') rows.sort((a, b) => (b.derniereConnexion || '').localeCompare(a.derniereConnexion || ''));
        else rows.sort(cmpNom);
        tableau.setTri(null);
        tableau.maj(rows);
      }
      rafraichir = async () => { try { utilisateurs = await api.get('/api/utilisateurs'); utilisateursCharges = utilisateurs; appliquer(); } catch (e) { erreur(e); } };

      // Demandes de réinitialisation en attente : bandeau, compteur du menu ; `recharger` : nouvelle lecture du serveur
      const zoneDemandes = el('div');
      const gestionnaire = GMAO.can('utilisateurs', 'modifier');
      majDemandes = async (recharger) => {
        if (!gestionnaire) return;
        if (recharger) {
          try { demandesEnAttente = await api.get('/api/utilisateurs-demandes-mdp'); } catch (e) { return; }
        }
        GMAO.setNavBadge('utilisateurs', demandesEnAttente.length);
        ui.vider(zoneDemandes);
        const n = demandesEnAttente.length;
        if (!n) return;
        zoneDemandes.appendChild(el('div', { class: 'alerte alerte-alerte bandeau-demandes' }, icone('cle'),
          el('span', null, `${n} demande${n > 1 ? 's' : ''} de réinitialisation de mot de passe en attente`),
          ui.bouton('Traiter', { classe: 'btn-sm btn-primaire', onClic: () => ouvrirDemandes() })));
      };

      const selectSecteur = el('select', { onchange: () => { filtreSecteur = selectSecteur.value; appliquer(); } }, [{ value: '', label: 'Tous les secteurs' }, { value: 'aucun', label: 'Sans secteur' }].concat(ui.optionsSecteurs({ vide: false })).map((o) => el('option', { value: o.value }, o.label)));
      const selectProfil = el('select', { onchange: () => { filtreProfil = selectProfil.value; appliquer(); } }, [{ value: '', label: 'Tous les profils' }].concat(ui.optionsProfils({ inactifs: true })).map((o) => el('option', { value: o.value }, o.label)));
      const selectTri = el('select', { onchange: () => { tri = selectTri.value; appliquer(); } }, [['secteur', 'Trier par secteur'], ['nom', 'Trier par nom'], ['profil', 'Trier par profil (niveau)'], ['connexion', 'Trier par dernière connexion']].map(([v, l]) => el('option', { value: v, selected: v === tri }, l)));
      const cbGrouper = el('input', { type: 'checkbox', checked: grouper, onchange: () => { grouper = cbGrouper.checked; tableau.setGroupe(grouper ? groupeSecteur : null); } });
      const cbActifs = el('input', { type: 'checkbox', checked: actifsSeuls, onchange: () => { actifsSeuls = cbActifs.checked; appliquer(); } });

      const vueListe = el('div',
        el('div', { class: 'barre-outils' }, selectSecteur, selectProfil, selectTri, el('label', { class: 'inline' }, cbGrouper, 'Grouper par secteur'), el('label', { class: 'inline' }, cbActifs, 'Actifs uniquement')),
        tableau.el);

      container.appendChild(ui.pageEntete({
        titre: GMAO.moduleLabel('utilisateurs'), icone: 'utilisateurs', sousTitre: 'Comptes internes, profils et hiérarchie',
        actions: [
          gestionnaire ? ui.bouton('Demandes de mot de passe', { icone: 'cle', titre: 'Demandes de réinitialisation faites depuis l\'écran de connexion', onClic: () => ouvrirDemandes() }) : null,
          GMAO.can('utilisateurs', 'creer') ? ui.bouton('Nouvel utilisateur', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, rafraichir) }) : null,
        ],
      }));
      container.appendChild(zoneDemandes);
      container.appendChild(ui.onglets([
        { cle: 'liste', label: 'Liste', icone: 'liste', contenu: vueListe },
        { cle: 'organigramme', label: 'Organigramme', icone: 'organigramme', rendu: (c) => { rendreOrganigramme(c); } },
      ], { hash: true }).el);
      await Promise.all([rafraichir(), majDemandes(true)]);
      if (params[0]) afficherFiche(params[0]);
      // Lien des notifications « demande de réinitialisation » : #/utilisateurs?demandesMdp=1
      else if (gestionnaire && query && query.demandesMdp === '1') ouvrirDemandes();
    },
  });
})();
