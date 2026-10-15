/**
 * Vue Utilisateurs : comptes internes, hiérarchie (supérieur, niveau), secteurs,
 * surcharges individuelles de droits (« voit plus ou moins » que son profil),
 * état et réinitialisation de la double authentification.
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
    const m = ui.modal({
      titre: nomComplet(u), taille: 'large',
      contenu: ui.onglets([
        { cle: 'infos', label: 'Informations', rendu: () => frag(
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
            ...ui.champsPersoAffichage('utilisateurs', u),
          ], { colonnes: 2 }),
        ) },
        { cle: 'droits', label: 'Droits effectifs', rendu: () => frag(
          el('p', { class: 'texte-2 texte-petit' }, 'Droits réellement appliqués : profil + surcharges individuelles (vert = accordé en plus, rouge = retiré). Les modules désactivés dans la configuration sont exclus.'),
          ui.matriceDroits({ mode: 'surcharges', valeurs: u.overrides || {}, base: p.modules, disabled: true }).el,
        ) },
      ]).el,
      boutons: [
        peutReinitialiserDeuxFacteurs(u) ? { label: 'Réinitialiser la double authentification', icone: 'profils', gauche: true, onClic: () => { m.fermer(); reinitialiserDeuxFacteurs(u, () => rafraichir()); } } : null,
        u.id === GMAO.user.id ? { label: 'Ma double authentification', icone: 'profils', gauche: true, onClic: () => { m.fermer(); GMAO.ouvrirDoubleAuthentification(); } } : null,
        peutModifier(u) ? { label: 'Modifier', icone: 'modifier', classe: 'btn-primaire', onClic: () => { m.fermer(); ouvrirFormulaire(u, () => rafraichir()); } } : null,
        { label: 'Fermer' },
      ],
    });
  }

  async function reinitialiserMdp(u) {
    const pwd = await ui.prompt({ titre: 'Réinitialiser le mot de passe', message: `Nouveau mot de passe pour ${nomComplet(u)} (vide = généré automatiquement)`, label: 'Mot de passe', type: 'texte', requis: false });
    if (pwd === null) return;
    try {
      const r = await api.post(`/api/utilisateurs/${u.id}/reinitialiser-mdp`, { password: pwd || undefined });
      ui.modal({ titre: 'Mot de passe réinitialisé', taille: 'petite', contenu: frag(el('p', null, `Nouveau mot de passe de ${nomComplet(u)} :`), el('p', null, el('code', { style: { fontSize: '16px' } }, r.motDePasse)), el('p', { class: 'texte-2 texte-petit' }, 'L\'utilisateur devra le changer à sa prochaine connexion.')), boutons: [{ label: 'Fermer' }] });
    } catch (e) { erreur(e); }
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
    async rendu(container, { params }) {
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
          { icone: 'cle', titre: 'Réinitialiser le mot de passe', visible: (u) => peutModifier(u) && u.id !== GMAO.user.id, onClic: reinitialiserMdp },
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
      rafraichir = async () => { try { utilisateurs = await api.get('/api/utilisateurs'); appliquer(); } catch (e) { erreur(e); } };

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
        actions: [GMAO.can('utilisateurs', 'creer') ? ui.bouton('Nouvel utilisateur', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, rafraichir) }) : null],
      }));
      container.appendChild(ui.onglets([
        { cle: 'liste', label: 'Liste', icone: 'liste', contenu: vueListe },
        { cle: 'organigramme', label: 'Organigramme', icone: 'organigramme', rendu: (c) => { rendreOrganigramme(c); } },
      ], { hash: true }).el);
      await rafraichir();
      if (params[0]) afficherFiche(params[0]);
    },
  });
})();
