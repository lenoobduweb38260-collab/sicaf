/**
 * Vue Fournisseurs & prestataires.
 *   #/fournisseurs        liste : indicateurs, filtres type / statut, recherche, export CSV
 *   #/fournisseurs/:id    fiche : Informations · Contacts · Articles fournis · Équipements · Interventions externes · Achats
 * Paramètres reconnus sur #/fournisseurs : typeCode, actif (1 | 0 | tous), recherche.
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;
  const MODULE = 'fournisseurs';
  const LISTE = 'typesFournisseur';
  const can = (action) => GMAO.can(MODULE, action);
  const esc = ui.esc;

  const PALETTE = ['#2563eb', '#0891b2', '#8b5cf6', '#16a34a', '#f59e0b', '#db2777', '#65a30d', '#6b7280'];
  const VERT = '#16a34a';
  const ROUGE = '#dc2626';
  const ORANGE = '#f59e0b';
  const GRIS = '#6b7280';
  const RE_EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;
  const RE_TELEPHONE = /^\+?[0-9\s().\/-]{4,30}$/;

  // ----- Utilitaires d'affichage ------------------------------------------------------------
  const normaliser = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const nowrap = (x, style) => el('span', { style: Object.assign({ whiteSpace: 'nowrap' }, style || {}) }, x);
  const stop = (ev) => ev.stopPropagation();
  const tronque = (texte, largeur, classe) => el('div', { class: classe || null, title: texte || '', style: { maxWidth: largeur, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, texte || '');
  const tiret = () => el('span', { class: 'texte-2' }, '—');

  /** Couleur d'un type : celle de la liste configurée, sinon une couleur de palette stable selon sa position. */
  function couleurType(code) {
    const l = ui.liste(LISTE);
    const i = l.findIndex((x) => x.code === code);
    if (i < 0) return GRIS;
    return l[i].couleur || PALETTE[i % PALETTE.length];
  }
  function badgeType(code) { return code ? ui.badge(ui.libelle(LISTE, code), couleurType(code)) : tiret(); }
  function badgeStatut(f) { return f.actif === false ? ui.badge('Inactif', GRIS) : ui.badge('Actif', VERT); }
  function formatSiret(s) {
    const d = String(s || '').replace(/\D/g, '');
    return d.length === 14 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : String(s || '');
  }
  /** Dernière ligne non vide de l'adresse (souvent « code postal + ville »). */
  function adresseCourte(adresse) {
    const lignes = String(adresse || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lignes.length ? lignes[lignes.length - 1] : '';
  }
  function siteAffiche(u) { return String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
  function lienTel(t) { return t ? el('a', { href: 'tel:' + String(t).replace(/[^\d+]/g, ''), onclick: stop, style: { whiteSpace: 'nowrap' } }, t) : tiret(); }
  function lienMail(m) { return m ? el('a', { href: 'mailto:' + m, onclick: stop, title: 'Écrire à ' + m }, m) : tiret(); }
  function lienSite(u) { return u ? el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', onclick: stop }, siteAffiche(u)) : tiret(); }
  /** Lien vers une autre vue si l'utilisateur y a accès, sinon texte simple. */
  function lienVue(href, label, module) {
    if (module && !(GMAO.can(module, 'voir') && GMAO.vues[module])) return el('span', null, label);
    return el('a', { href, onclick: stop, style: { whiteSpace: 'nowrap' } }, label);
  }
  function qte(n, uniteCode) { return `${ui.formatNombre(n == null ? 0 : n)}${uniteCode ? ' ' + uniteCode : ''}`; }
  function nomMois(cle) {
    const [a, m] = String(cle).split('-').map(Number);
    if (!a || !m) return cle;
    return new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  }
  const LIBELLES_COLLECTIONS = { commandes: 'commande(s) fournisseur', commandesFournisseurs: 'commande(s) fournisseur', receptions: 'réception(s)', factures: 'facture(s)', contrats: 'contrat(s)', plansPreventifs: 'plan(s) préventif(s)', demandes: 'demande(s) d\'intervention', documents: 'document(s)' };
  function libelleReferences(r) {
    if (!r) return '';
    return [r.articles ? `${r.articles} article(s)` : '', r.equipements ? `${r.equipements} équipement(s)` : '', r.ot ? `${r.ot} ordre(s) de travail` : '', r.mouvements ? `${r.mouvements} mouvement(s) de stock` : '']
      .concat(Object.entries(r.autres || {}).map(([col, n]) => `${n} ${LIBELLES_COLLECTIONS[col] || 'autre(s) enregistrement(s)'}`)).filter(Boolean).join(', ');
  }
  const validerTelephone = (v) => (v && (!RE_TELEPHONE.test(String(v).trim()) || String(v).replace(/\D/g, '').length < 4) ? 'Numéro invalide (chiffres, espaces, + . - ( ) /)' : '');
  const validerEmail = (v) => (v && !RE_EMAIL.test(String(v).trim()) ? 'Adresse e-mail invalide' : '');
  function validerSite(v) {
    let s = String(v || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol) || !/^[^.\s]+(\.[^.\s]+)+$/.test(u.hostname) || /\s/.test(s)) throw new Error(); } catch (e) { return 'Adresse invalide (ex. https://www.exemple.fr)'; }
    return '';
  }

  // ----- Éditeur de la liste des contacts ------------------------------------------------------
  function editeurContacts(initiaux) {
    const items = (initiaux || []).map((c) => ({ nom: c.nom || '', fonction: c.fonction || '', telephone: c.telephone || '', email: c.email || '' }));
    const corps = el('div', { class: 'liste-editable' });
    const compteur = el('span', { class: 'texte-2 texte-petit' });
    const grille = 'minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.2fr) 34px';
    const champs = [
      { cle: 'nom', label: 'Nom', placeholder: 'ex. Marie Durand', type: 'text', max: 150 },
      { cle: 'fonction', label: 'Fonction', placeholder: 'ex. Commerciale', type: 'text', max: 150 },
      { cle: 'telephone', label: 'Téléphone', placeholder: 'ex. 06 12 34 56 78', type: 'tel', max: 30 },
      { cle: 'email', label: 'E-mail', placeholder: 'ex. m.durand@fournisseur.fr', type: 'email', max: 200 },
    ];
    const nonVide = (c) => champs.some((x) => String(c[x.cle] || '').trim());
    function majCompteur() { const n = items.filter(nonVide).length; compteur.textContent = n ? `${n} contact${n > 1 ? 's' : ''}` : 'Aucun contact secondaire'; }
    function ajouter() {
      items.push({ nom: '', fonction: '', telephone: '', email: '' }); rendre();
      const inputs = corps.querySelectorAll('input[data-champ="nom"]'); if (inputs.length) inputs[inputs.length - 1].focus();
    }
    function rendre() {
      ui.vider(corps);
      if (!items.length) {
        corps.appendChild(el('div', { class: 'texte-2 texte-petit', style: { padding: '2px 0 8px' } }, 'Ajoutez les interlocuteurs utiles : commercial, administration des ventes, support technique, astreinte…'));
      } else {
        corps.appendChild(el('div', { class: 'ligne texte-2 texte-petit texte-gras', style: { gridTemplateColumns: grille } }, champs.map((c) => el('span', null, c.label)), el('span')));
      }
      items.forEach((it, i) => {
        const inputs = champs.map((c) => {
          const inp = el('input', { type: c.type, value: it[c.cle], placeholder: c.placeholder, maxlength: String(c.max), dataset: { champ: c.cle, index: i }, 'aria-label': `${c.label} du contact ${i + 1}` });
          inp.addEventListener('input', () => { it[c.cle] = inp.value; inp.style.borderColor = ''; majCompteur(); });
          inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (i === items.length - 1) ajouter(); } });
          return inp;
        });
        corps.appendChild(el('div', { class: 'ligne', style: { gridTemplateColumns: grille } }, inputs,
          el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Retirer ce contact', onclick: () => { items.splice(i, 1); rendre(); } }, icone('supprimer'))));
      });
      majCompteur();
    }
    rendre();
    const racine = el('div', null, corps, el('div', { class: 'barre-outils', style: { marginTop: '4px', marginBottom: '0' } },
      ui.bouton('Ajouter un contact', { icone: 'plus', classe: 'btn-sm', onClic: ajouter }), el('span', { class: 'espace' }), compteur));
    function marquer(i, cle) {
      const inp = corps.querySelector(`input[data-champ="${cle}"][data-index="${i}"]`);
      if (inp) { inp.style.borderColor = 'var(--danger, #dc2626)'; inp.focus(); }
    }
    return {
      el: racine,
      valeurs: () => items.filter(nonVide).map((c) => ({ nom: c.nom.trim(), fonction: c.fonction.trim(), telephone: c.telephone.trim().replace(/\s+/g, ' '), email: c.email.trim() })),
      valider() {
        for (let i = 0; i < items.length; i++) {
          const c = items[i];
          if (!nonVide(c)) continue;
          if (!c.nom.trim()) { marquer(i, 'nom'); return `Contact n°${i + 1} : le nom est obligatoire`; }
          if (validerTelephone(c.telephone)) { marquer(i, 'telephone'); return `Contact n°${i + 1} : numéro de téléphone invalide`; }
          if (validerEmail(c.email)) { marquer(i, 'email'); return `Contact n°${i + 1} : adresse e-mail invalide`; }
        }
        return '';
      },
    };
  }

  // ----- Formulaire de création / modification ------------------------------------------------
  function ouvrirFormulaire(existant, { apres } = {}) {
    const creation = !existant;
    let editeur = null;
    const types = ui.optionsListe(LISTE, { vide: false });
    const champs = [
      { type: 'separateur', label: 'Identification' },
      { nom: 'nom', label: 'Nom / raison sociale', type: 'texte', requis: true, maxLength: 150, placeholder: 'ex. SKF France' },
      { nom: 'typeCode', label: 'Type', type: 'select', options: types.length ? types : [{ value: '', label: '— Aucun type configuré —' }], requis: types.length > 0 },
      { nom: 'siret', label: 'SIRET', type: 'texte', placeholder: 'ex. 123 456 789 00012', maxLength: 20, aide: '14 chiffres (identifiant de l\'établissement)', valider: (v) => (v && !/^\d{14}$/.test(String(v).replace(/[\s.-]/g, '')) ? 'SIRET invalide : 14 chiffres attendus' : '') },
      { nom: 'delaiLivraisonJours', label: 'Délai de livraison (jours)', type: 'nombre', min: 0, max: 365, step: 1, placeholder: 'ex. 5', aide: 'Délai moyen constaté entre commande et réception', valider: (v) => (v !== null && v !== '' && !Number.isInteger(Number(v)) ? 'Nombre entier de jours attendu' : '') },
      { nom: 'actif', label: 'Fiche active (proposée dans les listes de choix)', type: 'booleen', valeur: true },
      { type: 'separateur', label: 'Coordonnées' },
      { nom: 'contact', label: 'Contact principal', type: 'texte', maxLength: 150, placeholder: 'ex. Laurent Girard' },
      { nom: 'telephone', label: 'Téléphone', type: 'tel', maxLength: 30, placeholder: 'ex. 04 72 00 00 00', valider: validerTelephone },
      { nom: 'email', label: 'E-mail', type: 'email', maxLength: 200, placeholder: 'ex. commandes@fournisseur.fr' },
      { nom: 'siteWeb', label: 'Site web', type: 'texte', maxLength: 300, placeholder: 'ex. www.fournisseur.fr', valider: validerSite },
      { nom: 'adresse', label: 'Adresse', type: 'texte_long', lignes: 3, placeholder: 'N° et rue\nCode postal et ville' },
      { type: 'separateur', label: 'Autres contacts' },
      { type: 'html', rendu: () => { editeur = editeurContacts(existant ? existant.contacts : []); return editeur.el; } },
      { type: 'separateur', label: 'Notes et conditions' },
      { nom: 'notes', label: 'Notes', type: 'texte_long', lignes: 4, placeholder: 'Conditions commerciales, contrat de service, franco de port, consignes de commande…' },
      ...ui.champsPersoDefs(MODULE),
    ];
    const valeurs = existant
      ? Object.assign({}, existant, {
        typeCode: existant.typeCode || '', siret: formatSiret(existant.siret), delaiLivraisonJours: existant.delaiLivraisonJours == null ? '' : existant.delaiLivraisonJours,
        actif: existant.actif !== false,
      }, ui.champsPersoInitiaux(existant))
      : { actif: true, typeCode: types.length ? types[0].value : '' };
    ui.formModal({
      titre: creation ? 'Nouveau fournisseur ou prestataire' : `Modifier « ${existant.nom} »`, taille: 'large', champs, valeurs,
      submitLabel: creation ? 'Créer la fiche' : 'Enregistrer',
      onSubmit: async (v) => {
        const err = editeur ? editeur.valider() : '';
        if (err) { toast(err, 'erreur'); return false; }
        const body = {
          nom: v.nom, typeCode: v.typeCode || null, contact: v.contact, telephone: v.telephone, email: v.email, siteWeb: v.siteWeb, adresse: v.adresse,
          siret: v.siret, delaiLivraisonJours: v.delaiLivraisonJours === '' || v.delaiLivraisonJours == null ? null : Number(v.delaiLivraisonJours),
          notes: v.notes, actif: !!v.actif, contacts: editeur ? editeur.valeurs() : [], champs: ui.champsPersoValeurs(v),
        };
        const r = creation ? await api.post('/api/fournisseurs', body) : await api.put('/api/fournisseurs/' + existant.id, body);
        toast(creation ? `Fiche « ${r.nom} » créée` : `Fiche « ${r.nom} » enregistrée`, 'succes');
        if (apres) apres(r);
      },
    });
  }

  /** Ajout / modification d'un seul contact depuis la fiche (enregistrement immédiat de la liste). */
  function ouvrirContact(f, index, apres) {
    const existant = index != null ? f.contacts[index] : null;
    ui.formModal({
      titre: existant ? `Modifier le contact « ${existant.nom} »` : `Nouveau contact — ${f.nom}`, taille: 'petite', colonnes: 1,
      champs: [
        { nom: 'nom', label: 'Nom', type: 'texte', requis: true, maxLength: 150, placeholder: 'ex. Marie Durand' },
        { nom: 'fonction', label: 'Fonction', type: 'texte', maxLength: 150, placeholder: 'ex. Administration des ventes' },
        { nom: 'telephone', label: 'Téléphone', type: 'tel', maxLength: 30, valider: validerTelephone },
        { nom: 'email', label: 'E-mail', type: 'email', maxLength: 200 },
      ],
      valeurs: existant || {},
      submitLabel: existant ? 'Enregistrer' : 'Ajouter',
      onSubmit: async (v) => {
        const contacts = (f.contacts || []).slice();
        const c = { nom: v.nom.trim(), fonction: (v.fonction || '').trim(), telephone: (v.telephone || '').trim(), email: (v.email || '').trim() };
        if (existant) contacts[index] = c; else contacts.push(c);
        const r = await api.put('/api/fournisseurs/' + f.id, { contacts });
        toast(existant ? 'Contact modifié' : `Contact « ${c.nom} » ajouté`, 'succes');
        if (apres) apres(r);
      },
    });
  }

  async function retirerContact(f, index, apres) {
    const c = f.contacts[index];
    if (!(await ui.confirm({ titre: 'Retirer le contact', message: `Retirer « ${c.nom} » des contacts de ${f.nom} ?`, okLabel: 'Retirer', danger: true }))) return;
    try {
      const contacts = f.contacts.filter((x, i) => i !== index);
      const r = await api.put('/api/fournisseurs/' + f.id, { contacts });
      toast('Contact retiré', 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }

  // ----- Actions ------------------------------------------------------------------------------
  async function dupliquer(f) {
    const suggestion = `${f.nom} (copie)`;
    const saisi = await ui.prompt({
      titre: 'Dupliquer la fiche', label: 'Nom de la nouvelle fiche', valeur: suggestion, okLabel: 'Dupliquer',
      message: `Une nouvelle fiche sera créée à partir de « ${f.nom} » : type, coordonnées, contacts, notes et champs personnalisés. Le SIRET, propre à chaque établissement, n'est pas recopié.`,
    });
    if (saisi === null) return;
    try {
      const nomVoulu = String(saisi).trim();
      const r = await api.post(`/api/fournisseurs/${f.id}/dupliquer`, nomVoulu && nomVoulu !== suggestion ? { nom: nomVoulu } : {});
      toast(`Fiche « ${r.nom} » créée par duplication`, 'succes');
      GMAO.navigate('#/fournisseurs/' + r.id);
    } catch (e) { erreur(e); }
  }

  async function supprimer(f, apres) {
    let refs = f.references;
    if (!refs) { try { refs = (await api.get('/api/fournisseurs/' + f.id)).references; } catch (e) { refs = null; } }
    const message = refs && refs.total
      ? `« ${f.nom} » est référencé par ${libelleReferences(refs)}. Pour conserver l'historique, la fiche sera désactivée au lieu d'être supprimée.`
      : `Supprimer définitivement la fiche « ${f.nom} » ? Cette action est irréversible.`;
    if (!(await ui.confirm({ titre: refs && refs.total ? 'Désactiver le fournisseur' : 'Supprimer le fournisseur', message, okLabel: refs && refs.total ? 'Désactiver' : 'Supprimer', danger: true }))) return;
    try {
      const r = await api.del('/api/fournisseurs/' + f.id);
      toast(r.desactive ? `« ${f.nom} » désactivé (référencé dans l'historique)` : `« ${f.nom} » supprimé`, 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }

  async function reactiver(f, apres) {
    try {
      const r = await api.put('/api/fournisseurs/' + f.id, { actif: true });
      toast(`« ${f.nom} » réactivé`, 'succes');
      if (apres) apres(r);
    } catch (e) { erreur(e); }
  }

  // ----- Liste -----------------------------------------------------------------------------------
  async function afficherListe(container, query) {
    const filtres = {
      recherche: query.recherche || '', typeCode: query.typeCode || '',
      actif: query.actif === '0' || query.actif === 'tous' ? query.actif : '1',
    };
    let fournisseurs = [];
    const voirOt = GMAO.can('ot', 'voir');
    const voirStock = GMAO.can('stock', 'voir');

    container.appendChild(ui.pageEntete({
      titre: GMAO.moduleLabel(MODULE), icone: 'fournisseurs',
      sousTitre: 'Fournisseurs de pièces, prestataires de services et constructeurs : coordonnées, contacts, achats et interventions externes',
      actions: [can('creer') ? ui.bouton('Nouveau fournisseur', { icone: 'plus', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(null, { apres: (r) => GMAO.navigate('#/fournisseurs/' + r.id) }) }) : null],
    }));
    const kpis = el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '14px' } });
    container.appendChild(kpis);

    const recherche = el('input', { type: 'search', placeholder: 'Rechercher (nom, contact, ville, SIRET…)', value: filtres.recherche, style: { maxWidth: '300px' }, 'aria-label': 'Rechercher un fournisseur' });
    recherche.addEventListener('input', ui.debounce(() => { filtres.recherche = recherche.value; appliquer(); }, 200));
    const selType = el('select', { title: 'Type', onchange: () => { filtres.typeCode = selType.value; appliquer(); } });
    function majOptionsType() {
      const base = fournisseurs.filter((f) => (filtres.actif === '1' ? f.actif !== false : filtres.actif === '0' ? f.actif === false : true));
      ui.vider(selType);
      selType.appendChild(el('option', { value: '' }, `Tous les types (${base.length})`));
      for (const t of ui.liste(LISTE)) selType.appendChild(el('option', { value: t.code }, `${t.label} (${base.filter((f) => f.typeCode === t.code).length})`));
      selType.value = filtres.typeCode;
      if (selType.value !== filtres.typeCode) { filtres.typeCode = ''; selType.value = ''; }
    }
    const selActif = el('select', { title: 'Statut', onchange: () => { filtres.actif = selActif.value; appliquer(); } },
      [['1', 'Actifs uniquement'], ['0', 'Inactifs uniquement'], ['tous', 'Actifs et inactifs']].map(([v, l]) => el('option', { value: v, selected: v === filtres.actif }, l)));
    const compteur = el('span', { class: 'texte-2 texte-petit' });
    const btnExport = can('exporter') ? ui.bouton('Exporter CSV', { icone: 'export', classe: 'btn-sm', titre: 'Exporter la sélection courante (filtres appliqués)', onClic: async () => {
      const qs = new URLSearchParams();
      if (filtres.typeCode) qs.set('typeCode', filtres.typeCode);
      qs.set('actif', filtres.actif);
      if (filtres.recherche.trim()) qs.set('recherche', filtres.recherche.trim());
      try { await api.telecharger('/api/fournisseurs-export?' + qs.toString()); toast('Export CSV généré', 'succes'); } catch (e) { erreur(e); }
    } }) : null;
    container.appendChild(el('div', { class: 'barre-outils' }, recherche, selType, selActif, el('span', { class: 'espace' }), compteur, btnExport));

    const ordreType = (code) => { const i = ui.liste(LISTE).findIndex((x) => x.code === code); return i < 0 ? 999 : i; };
    // Écrans étroits (portables 1280 à 1366 px) : téléphone et e-mail dans une même cellule, textes plus courts
    const compact = window.innerWidth < 1400;
    const L = compact ? { nom: '165px', contact: '120px', email: '165px' } : { nom: '205px', contact: '135px', email: '165px' };
    const celluleEmail = (f) => (f.emailPrincipal ? el('div', { style: { maxWidth: L.email, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.emailPrincipal }, lienMail(f.emailPrincipal)) : tiret());
    const colonnesCoordonnees = compact
      ? [{ cle: 'telephonePrincipal', label: 'Téléphone / e-mail', valeurTri: (f) => f.telephonePrincipal || '', exportValeur: (f) => [f.telephonePrincipal, f.emailPrincipal].filter(Boolean).join(' — '),
        rendu: (f) => (f.telephonePrincipal || f.emailPrincipal ? el('div', null, f.telephonePrincipal ? el('div', null, lienTel(f.telephonePrincipal)) : null, f.emailPrincipal ? el('div', { class: 'texte-petit' }, celluleEmail(f)) : null) : tiret()) }]
      : [{ cle: 'telephonePrincipal', label: 'Téléphone', rendu: (f) => lienTel(f.telephonePrincipal) }, { cle: 'emailPrincipal', label: 'E-mail', rendu: celluleEmail }];
    const tableau = ui.table({
      lignes: [], recherche: false, vide: 'Aucun fournisseur ne correspond aux filtres',
      triInitial: { cle: 'nom', sens: 'asc' },
      onClic: (f) => GMAO.navigate('#/fournisseurs/' + f.id),
      ligneClasse: (f) => (f.actif === false ? 'inactif' : ''),
      colonnes: [
        { cle: 'nom', label: 'Fournisseur', valeurTri: (f) => normaliser(f.nom), rendu: (f) => {
          const sec = [adresseCourte(f.adresse), f.delaiLivraisonJours != null ? `livraison ${f.delaiLivraisonJours} j` : ''].filter(Boolean).join(' · ') || (f.siteWeb ? siteAffiche(f.siteWeb) : '');
          return el('div', { style: { minWidth: '150px', maxWidth: L.nom } }, el('div', { class: 'cellule-principale' }, f.nom), sec ? tronque(sec, L.nom, 'cellule-secondaire') : null);
        } },
        { cle: 'typeCode', label: 'Type', rendu: (f) => badgeType(f.typeCode), valeurTri: (f) => ordreType(f.typeCode) },
        { cle: 'contactPrincipal', label: 'Contact principal', valeurTri: (f) => normaliser(f.contactPrincipal), rendu: (f) => {
          if (!f.contactPrincipal) return tiret();
          const sec = [f.fonctionPrincipale, f.nbContacts ? `${f.nbContacts} contact${f.nbContacts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
          return el('div', null, tronque(f.contactPrincipal, L.contact), sec ? tronque(sec, L.contact, 'cellule-secondaire') : null);
        } },
        ...colonnesCoordonnees,
        voirStock ? { cle: 'nbArticles', label: 'Articles', aligner: 'droite', valeurTri: (f) => f.nbArticles || 0, rendu: (f) => (f.nbArticles ? el('span', { class: 'texte-gras' }, String(f.nbArticles)) : tiret()) } : null,
        { cle: 'actif', label: 'Statut', aligner: 'centre', rendu: badgeStatut, valeurTri: (f) => (f.actif === false ? 1 : 0) },
      ].filter(Boolean),
      actions: [
        { icone: 'modifier', titre: 'Modifier', visible: () => can('modifier'), onClic: (f) => ouvrirFormulaire(f, { apres: () => charger() }) },
        { icone: 'copier', titre: 'Dupliquer', visible: () => can('creer'), onClic: (f) => dupliquer(f) },
        { icone: 'check', titre: 'Réactiver', classe: 'texte-ok', visible: (f) => f.actif === false && can('modifier'), onClic: (f) => reactiver(f, () => charger()) },
        { icone: 'supprimer', titre: 'Supprimer', classe: 'texte-danger', visible: (f) => f.actif !== false && can('supprimer'), onClic: (f) => supprimer(f, () => charger()) },
      ],
    });
    container.appendChild(tableau.el);

    function majKpis() {
      ui.vider(kpis);
      const actifs = fournisseurs.filter((f) => f.actif !== false);
      const inactifs = fournisseurs.length - actifs.length;
      kpis.appendChild(ui.kpi({ label: 'Fiches actives', valeur: actifs.length, icone: 'fournisseurs', couleur: '#2563eb',
        detail: inactifs ? `${inactifs} fiche${inactifs > 1 ? 's' : ''} inactive${inactifs > 1 ? 's' : ''} (cliquer pour les afficher)` : 'aucune fiche inactive',
        onClic: () => { filtres.typeCode = ''; filtres.actif = inactifs && filtres.actif === '1' ? '0' : '1'; selActif.value = filtres.actif; appliquer(); } }));
      if (voirStock && fournisseurs.some((f) => f.totalAchats != null)) {
        const total = actifs.reduce((s, f) => s + (Number(f.totalAchats) || 0), 0);
        const avecAchats = actifs.filter((f) => Number(f.totalAchats) > 0).length;
        kpis.appendChild(ui.kpi({ label: 'Achats réceptionnés', valeur: ui.formatMontant(total), icone: 'euro', couleur: '#8b5cf6', detail: `entrées en stock · ${avecAchats} fournisseur${avecAchats > 1 ? 's' : ''}` }));
      }
      if (voirOt) {
        const ouverts = actifs.reduce((s, f) => s + (f.nbOtOuverts || 0), 0);
        const prestataires = actifs.filter((f) => f.nbOtOuverts).length;
        kpis.appendChild(ui.kpi({ label: 'Interventions externes en cours', valeur: ouverts, icone: 'ot', couleur: ouverts ? ORANGE : VERT, detail: ouverts ? `chez ${prestataires} prestataire${prestataires > 1 ? 's' : ''}` : 'aucun OT confié à un prestataire' }));
      }
      const delais = actifs.map((f) => f.delaiLivraisonJours).filter((d) => d != null);
      const moyenne = delais.length ? delais.reduce((s, d) => s + Number(d), 0) / delais.length : null;
      kpis.appendChild(ui.kpi({ label: 'Délai moyen de livraison', valeur: moyenne == null ? '—' : `${ui.formatNombre(moyenne, moyenne < 10 ? 1 : 0)} j`, icone: 'horloge', couleur: '#0891b2',
        detail: delais.length ? `renseigné pour ${delais.length} fiche${delais.length > 1 ? 's' : ''} active${delais.length > 1 ? 's' : ''}` : 'aucun délai renseigné' }));
    }

    function appliquer() {
      majOptionsType();
      const termes = normaliser(filtres.recherche).split(' ').filter(Boolean);
      const rows = fournisseurs.filter((f) => {
        if (filtres.actif === '1' && f.actif === false) return false;
        if (filtres.actif === '0' && f.actif !== false) return false;
        if (filtres.typeCode && f.typeCode !== filtres.typeCode) return false;
        if (termes.length) {
          const t = normaliser([f.nom, f.contact, f.email, f.telephone, f.adresse, f.siteWeb, f.siret, formatSiret(f.siret), f.notes, f.typeLibelle]
            .concat((f.contacts || []).flatMap((c) => [c.nom, c.fonction, c.email, c.telephone])).join(' '));
          if (!termes.every((x) => t.includes(x))) return false;
        }
        return true;
      });
      tableau.maj(rows);
      compteur.textContent = `${rows.length} fiche${rows.length > 1 ? 's' : ''}${rows.length !== fournisseurs.length ? ` sur ${fournisseurs.length}` : ''}`;
      majKpis();
      // Mémorise les filtres dans l'adresse (retour arrière, favoris) sans recharger la vue
      const qs = new URLSearchParams();
      if (filtres.typeCode) qs.set('typeCode', filtres.typeCode);
      if (filtres.actif !== '1') qs.set('actif', filtres.actif);
      if (filtres.recherche.trim()) qs.set('recherche', filtres.recherche.trim());
      const s = qs.toString();
      try { history.replaceState(null, '', '#/' + MODULE + (s ? '?' + s : '')); } catch (e) { /* ignore */ }
    }

    async function charger() {
      try { fournisseurs = await api.get('/api/fournisseurs'); } catch (e) { erreur(e); fournisseurs = []; }
      appliquer();
    }
    await charger();
  }

  // ----- Fiche -----------------------------------------------------------------------------------
  async function afficherFiche(container, id) {
    let f;
    try { f = await api.get('/api/fournisseurs/' + id); } catch (e) {
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel(MODULE), icone: 'fournisseurs', filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/fournisseurs' }, { label: 'Fiche' }] }));
      container.appendChild(ui.vide(e.status === 404 ? 'Fournisseur introuvable : il a peut-être été supprimé.' : e.message, 'alerte'));
      container.appendChild(el('div', { class: 'texte-centre' }, ui.bouton('Retour à la liste', { icone: 'fleche_gauche', onClic: () => GMAO.navigate('#/fournisseurs') })));
      return;
    }
    const recharger = () => GMAO.rendre();
    const actif = f.actif !== false;
    const st = f.stats || {};
    const acces = f.acces || {};

    container.appendChild(ui.pageEntete({
      titre: frag(f.nom, ' ', badgeType(f.typeCode), actif ? null : frag(' ', ui.badge('Inactif', GRIS))),
      icone: 'fournisseurs',
      filAriane: [{ label: GMAO.moduleLabel(MODULE), href: '#/fournisseurs' }].concat(f.typeCode ? [{ label: ui.libelle(LISTE, f.typeCode), href: '#/fournisseurs?typeCode=' + encodeURIComponent(f.typeCode) }] : []).concat([{ label: f.nom }]),
      sousTitre: [adresseCourte(f.adresse), f.siret ? `SIRET ${formatSiret(f.siret)}` : '', f.delaiLivraisonJours != null ? `délai de livraison ${f.delaiLivraisonJours} jour${f.delaiLivraisonJours > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || null,
      actions: [
        ui.bouton('Imprimer la fiche', { icone: 'imprimer', onClic: () => imprimerFiche(f) }),
        can('creer') ? ui.bouton('Dupliquer', { icone: 'copier', onClic: () => dupliquer(f) }) : null,
        !actif && can('modifier') ? ui.bouton('Réactiver', { icone: 'check', classe: 'btn-ok', onClic: () => reactiver(f, recharger) }) : null,
        actif && can('supprimer') ? ui.bouton('Supprimer', { icone: 'supprimer', classe: 'texte-danger', onClic: () => supprimer(f, (r) => (r.desactive ? recharger() : GMAO.navigate('#/fournisseurs'))) }) : null,
        can('modifier') ? ui.bouton('Modifier', { icone: 'modifier', classe: 'btn-primaire', onClic: () => ouvrirFormulaire(f, { apres: recharger }) }) : null,
      ],
    }));

    if (!actif) container.appendChild(ui.alerte('Cette fiche est inactive : elle est conservée pour l\'historique (articles, équipements, interventions, réceptions) mais n\'est plus proposée dans les listes de choix.', 'alerte'));

    const kpis = el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginBottom: '14px' } });
    let onglets = null;
    const aller = (cle) => () => { if (onglets) onglets.activer(cle); };
    if (acces.articles) kpis.appendChild(ui.kpi({ label: 'Articles fournis', valeur: st.nbArticles || 0, icone: 'piece', couleur: st.nbArticlesSousSeuil ? ORANGE : '#2563eb', detail: st.nbArticlesSousSeuil ? `${st.nbArticlesSousSeuil} sous le seuil minimum` : `stock valorisé ${ui.formatMontant(st.valeurStock || 0)}`, onClic: aller('articles') }));
    if (acces.equipements) kpis.appendChild(ui.kpi({ label: 'Équipements', valeur: st.nbEquipements || 0, icone: 'equipements', couleur: '#0891b2', detail: st.nbEquipementsSousGarantie ? `${st.nbEquipementsSousGarantie} sous garantie` : 'fournis ou construits', onClic: aller('equipements') }));
    if (acces.ot) kpis.appendChild(ui.kpi({ label: 'Interventions externes', valeur: st.nbInterventions || 0, icone: 'ot', couleur: st.nbInterventionsOuvertes ? ORANGE : VERT, detail: `${st.nbInterventionsOuvertes || 0} en cours · coût externe ${ui.formatMontant(st.coutExterneTotal || 0)}`, onClic: aller('interventions') }));
    if (acces.achats) kpis.appendChild(ui.kpi({ label: 'Total des achats', valeur: ui.formatMontant(st.totalAchats || 0), icone: 'euro', couleur: '#8b5cf6', detail: `${st.nbReceptions || 0} réception(s) · ${ui.formatMontant(st.totalAchats12Mois || 0)} sur 12 mois`, onClic: aller('achats') }));
    if (kpis.children.length) container.appendChild(kpis);

    onglets = ui.onglets([
      { cle: 'infos', label: 'Informations', icone: 'info', rendu: () => rendreInfos(f) },
      { cle: 'contacts', label: 'Contacts', icone: 'utilisateur', badge: (f.contacts || []).length + (f.contact ? 1 : 0) || null, rendu: () => rendreContacts(f, recharger) },
      { cle: 'articles', label: 'Articles fournis', icone: 'piece', badge: acces.articles && f.articles.length ? f.articles.length : null, rendu: () => rendreArticles(f) },
      { cle: 'equipements', label: 'Équipements', icone: 'equipements', badge: acces.equipements && f.equipements.length ? f.equipements.length : null, rendu: () => rendreEquipements(f) },
      { cle: 'interventions', label: 'Interventions externes', icone: 'ot', badge: acces.ot && f.interventions.length ? f.interventions.length : null, rendu: () => rendreInterventions(f) },
      { cle: 'achats', label: 'Achats', icone: 'euro', badge: acces.achats && f.achats.nbReceptions ? f.achats.nbReceptions : null, rendu: () => rendreAchats(f) },
    ], { hash: true });
    container.appendChild(onglets.el);
  }

  function rendreInfos(f) {
    const cont = el('div');
    cont.appendChild(el('div', { class: 'grille grille-2' },
      ui.carte('Coordonnées', ui.details([
        { label: 'Contact principal', valeur: f.contact || (f.contactPrincipal ? frag(f.contactPrincipal, el('span', { class: 'texte-2 texte-petit' }, ' (premier contact)')) : '') },
        { label: 'Téléphone', valeur: f.telephone ? lienTel(f.telephone) : '' },
        { label: 'E-mail', valeur: f.email ? lienMail(f.email) : '' },
        { label: 'Site web', valeur: f.siteWeb ? lienSite(f.siteWeb) : '' },
        { label: 'Adresse', valeur: f.adresse ? el('div', { style: { whiteSpace: 'pre-wrap' } }, f.adresse) : '' },
      ])),
      ui.carte('Informations administratives', ui.details([
        { label: 'Type', valeur: badgeType(f.typeCode) },
        { label: 'SIRET', valeur: f.siret ? el('span', { style: { fontVariantNumeric: 'tabular-nums' } }, formatSiret(f.siret)) : '' },
        { label: 'Délai de livraison', valeur: f.delaiLivraisonJours != null ? `${f.delaiLivraisonJours} jour${f.delaiLivraisonJours > 1 ? 's' : ''}` : '' },
        { label: 'Statut', valeur: badgeStatut(f) },
        { label: 'Fiche créée le', valeur: f.createdAt ? `${ui.formatDateHeure(f.createdAt)}${f.createdByNom ? ' par ' + f.createdByNom : ''}` : '' },
        { label: 'Dernière modification', valeur: f.updatedAt ? `${ui.formatDateHeure(f.updatedAt)} (${ui.relatif(f.updatedAt)})` : '' },
        ...ui.champsPersoAffichage(MODULE, f),
      ]))));
    cont.appendChild(ui.carte('Notes et conditions', f.notes ? el('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.55' } }, f.notes) : el('div', { class: 'texte-2' }, 'Aucune note. Utilisez « Modifier » pour consigner les conditions commerciales, le contrat de service ou les consignes de commande.')));
    return cont;
  }

  function carteContact({ nom, fonction, telephone, email }, { principal, actions } = {}) {
    return el('div', { class: 'carte', style: { marginBottom: 0, padding: '12px 14px', display: 'flex', gap: '12px', alignItems: 'flex-start' } },
      ui.avatar(nom, 38),
      el('div', { style: { minWidth: 0, flex: '1' } },
        el('div', { class: 'inline', style: { flexWrap: 'wrap' } }, el('strong', null, nom), principal ? ui.badge('Principal', '#2563eb') : null),
        fonction ? el('div', { class: 'texte-2 texte-petit' }, fonction) : null,
        el('div', { class: 'texte-petit', style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '2px' } },
          telephone ? el('div', { class: 'inline' }, el('span', { class: 'texte-2' }, 'Tél.'), lienTel(telephone)) : null,
          email ? el('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lienMail(email)) : null,
          !telephone && !email ? el('span', { class: 'texte-2' }, 'Aucune coordonnée') : null)),
      actions && actions.length ? el('div', { style: { display: 'flex', gap: '2px' } }, actions) : null);
  }

  function rendreContacts(f, recharger) {
    const cont = el('div');
    const modifiable = can('modifier');
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, 'Interlocuteurs chez le fournisseur ou le prestataire'),
      el('span', { class: 'espace' }),
      modifiable ? ui.bouton('Ajouter un contact', { icone: 'plus', classe: 'btn-sm btn-primaire', onClic: () => ouvrirContact(f, null, recharger) }) : null));
    const grille = el('div', { class: 'grille', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' } });
    if (f.contact || f.telephone || f.email) {
      grille.appendChild(carteContact({ nom: f.contact || f.nom, fonction: f.contact ? 'Contact principal' : 'Coordonnées générales', telephone: f.telephone, email: f.email }, { principal: true,
        actions: modifiable ? [el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Modifier le contact principal', onclick: () => ouvrirFormulaire(f, { apres: recharger }) }, icone('modifier'))] : [] }));
    }
    (f.contacts || []).forEach((c, i) => {
      grille.appendChild(carteContact(c, { actions: modifiable ? [
        el('button', { type: 'button', class: 'btn btn-icone btn-sm', title: 'Modifier ce contact', onclick: () => ouvrirContact(f, i, recharger) }, icone('modifier')),
        el('button', { type: 'button', class: 'btn btn-icone btn-sm texte-danger', title: 'Retirer ce contact', onclick: () => retirerContact(f, i, recharger) }, icone('supprimer')),
      ] : [] }));
    });
    if (!grille.children.length) cont.appendChild(ui.vide('Aucun contact enregistré pour cette fiche.', 'utilisateur'));
    else cont.appendChild(grille);
    return cont;
  }

  function sansAcces(module) { return ui.vide(`Vous n'avez pas accès au module « ${GMAO.moduleLabel(module)} ».`, 'alerte'); }

  function rendreArticles(f) {
    const acces = f.acces || {};
    if (!acces.articles) return sansAcces('stock');
    const cont = el('div');
    const rows = f.articles || [];
    const st = f.stats || {};
    cont.appendChild(el('div', { class: 'barre-outils' },
      el('span', { class: 'texte-2' }, rows.length ? `${rows.length} article(s) dont ce fournisseur est le fournisseur habituel` : ''),
      el('span', { class: 'espace' }),
      GMAO.vues.stock ? ui.bouton('Voir dans le stock', { icone: 'stock', classe: 'btn-sm', onClic: () => GMAO.navigate('#/stock?fournisseurId=' + f.id) }) : null));
    if (!rows.length) { cont.appendChild(ui.vide('Aucun article du stock n\'a ce fournisseur comme fournisseur habituel.', 'piece')); return cont; }
    if (st.nbArticlesSousSeuil) cont.appendChild(ui.alerte(`${st.nbArticlesSousSeuil} article(s) sous le seuil minimum : une commande auprès de ${f.nom} est à prévoir${f.delaiLivraisonJours != null ? ` (délai de livraison ${f.delaiLivraisonJours} j)` : ''}.`, 'alerte'));
    cont.appendChild(ui.table({
      lignes: rows, recherche: rows.length > 10 ? 'Rechercher un article…' : false, compact: true, triInitial: { cle: 'designation', sens: 'asc' },
      onClic: (a) => (GMAO.vues.stock ? GMAO.navigate('#/stock/' + a.id) : null),
      ligneClasse: (a) => (a.actif === false ? 'inactif' : ''),
      colonnes: [
        { cle: 'code', label: 'Code', rendu: (a) => lienVue('#/stock/' + a.id, a.code || '#' + a.id, 'stock') },
        { cle: 'designation', label: 'Désignation', rendu: (a) => el('div', null, el('div', { class: 'cellule-principale' }, a.designation), a.emplacement ? el('div', { class: 'cellule-secondaire' }, a.emplacement) : null) },
        { cle: 'referenceFournisseur', label: 'Réf. fournisseur', rendu: (a) => (a.referenceFournisseur ? nowrap(a.referenceFournisseur) : tiret()) },
        { cle: 'categorieCode', label: 'Catégorie', liste: 'categoriesArticles' },
        { cle: 'quantite', label: 'Stock', aligner: 'droite', valeurTri: (a) => a.quantite, rendu: (a) => el('div', { title: `Seuil minimum : ${qte(a.seuilMin, a.uniteCode)}` },
          a.sousSeuil ? ui.badge(qte(a.quantite, a.uniteCode), a.rupture ? ROUGE : ORANGE) : el('span', { class: 'texte-gras' }, qte(a.quantite, a.uniteCode)),
          el('div', { class: 'cellule-secondaire' }, `min. ${ui.formatNombre(a.seuilMin)}`)) },
        { cle: 'prixUnitaire', label: 'Prix unitaire', aligner: 'droite', valeurTri: (a) => a.prixUnitaire, rendu: (a) => nowrap(ui.formatMontant(a.prixUnitaire)) },
        { cle: 'valeur', label: 'Valeur', aligner: 'droite', valeurTri: (a) => a.valeur, rendu: (a) => nowrap(ui.formatMontant(a.valeur)) },
        { cle: 'actif', label: 'État', aligner: 'centre', valeurTri: (a) => (a.actif ? (a.rupture ? 1 : a.sousSeuil ? 2 : 3) : 4), rendu: (a) => (!a.actif ? ui.badge('Désactivé', GRIS) : a.rupture ? ui.badge('Rupture', ROUGE) : a.sousSeuil ? ui.badge('Sous le seuil', ORANGE) : ui.badge('Disponible', VERT)) },
      ],
    }).el);
    cont.appendChild(el('div', { class: 'tableau-pied', style: { justifyContent: 'flex-end' } }, el('span', null, 'Valeur du stock des articles actifs : ', el('strong', null, ui.formatMontant(st.valeurStock || 0)))));
    return cont;
  }

  function rendreEquipements(f) {
    const acces = f.acces || {};
    if (!acces.equipements) return sansAcces('equipements');
    const rows = f.equipements || [];
    if (!rows.length) return ui.vide('Aucun équipement n\'est rattaché à ce fournisseur (champ « Fournisseur / constructeur » de la fiche équipement).', 'equipements');
    return ui.table({
      lignes: rows, recherche: rows.length > 10 ? 'Rechercher un équipement…' : false, compact: true, triInitial: { cle: 'numero', sens: 'asc' },
      onClic: (e) => (GMAO.vues.equipements ? GMAO.navigate('#/equipements/' + e.id) : null),
      ligneClasse: (e) => (e.actif === false ? 'inactif' : ''),
      colonnes: [
        { cle: 'numero', label: 'Numéro', rendu: (e) => lienVue('#/equipements/' + e.id, e.numero || '#' + e.id, 'equipements') },
        { cle: 'nom', label: 'Équipement', rendu: (e) => el('div', null, el('div', { class: 'cellule-principale' }, e.nom), e.localisation ? el('div', { class: 'cellule-secondaire' }, e.localisation) : null) },
        { cle: 'marque', label: 'Marque / modèle', rendu: (e) => ([e.marque, e.modele].filter(Boolean).join(' ') || tiret()) },
        { cle: 'numeroSerie', label: 'N° de série', rendu: (e) => (e.numeroSerie ? nowrap(e.numeroSerie) : tiret()) },
        { cle: 'secteurId', label: 'Secteur', rendu: (e) => (e.secteurId != null ? ui.cheminSecteur(e.secteurId) : tiret()), valeurTri: (e) => (e.secteurId != null ? ui.cheminSecteur(e.secteurId) : '') },
        { cle: 'etatCode', label: 'État', liste: 'etatsEquipement' },
        { cle: 'garantieFin', label: 'Garantie', valeurTri: (e) => e.garantieFin || '', rendu: (e) => (e.garantieFin ? el('div', null, nowrap(ui.formatDate(e.garantieFin)), el('div', null, e.sousGarantie ? ui.badge('Sous garantie', VERT) : el('span', { class: 'texte-2 texte-petit' }, 'expirée'))) : tiret()) },
      ],
    }).el;
  }

  function rendreInterventions(f) {
    const acces = f.acces || {};
    if (!acces.ot) return sansAcces('ot');
    const rows = f.interventions || [];
    if (!rows.length) return ui.vide('Aucun ordre de travail n\'a été confié à ce prestataire.', 'ot');
    const cont = el('div');
    const st = f.stats || {};
    cont.appendChild(ui.table({
      lignes: rows, recherche: rows.length > 10 ? 'Rechercher une intervention…' : false, compact: true, triInitial: { cle: 'dateReference', sens: 'desc' },
      onClic: (o) => (GMAO.vues.ot ? GMAO.navigate('#/ot/' + o.id) : null),
      colonnes: [
        { cle: 'numero', label: 'OT', rendu: (o) => lienVue('#/ot/' + o.id, o.numero || 'OT #' + o.id, 'ot') },
        { cle: 'titre', label: 'Intitulé', rendu: (o) => el('div', null, el('div', { class: 'cellule-principale' }, o.titre), o.equipementNom ? el('div', { class: 'cellule-secondaire' }, [o.equipementNumero, o.equipementNom].filter(Boolean).join(' — ')) : null) },
        { cle: 'typeCode', label: 'Type', liste: 'typesIntervention' },
        { cle: 'statut', label: 'Statut', liste: 'statutsOT' },
        { cle: 'dateReference', label: 'Date', valeurTri: (o) => o.dateReference || '', rendu: (o) => el('div', null, nowrap(ui.formatDate(o.dateReference)), el('div', { class: 'cellule-secondaire' }, o.dateFin || o.dateCloture ? 'réalisée' : o.dateDebut ? 'commencée' : o.datePrevue ? 'prévue' : 'créée')) },
        { cle: 'coutExterne', label: 'Coût externe', aligner: 'droite', valeurTri: (o) => o.coutExterne, rendu: (o) => (o.coutExterne ? el('span', { class: 'texte-gras', style: { whiteSpace: 'nowrap' } }, ui.formatMontant(o.coutExterne)) : tiret()) },
        { cle: 'coutTotal', label: 'Coût total', aligner: 'droite', valeurTri: (o) => o.coutTotal, rendu: (o) => el('span', { style: { whiteSpace: 'nowrap' }, title: `Externe ${ui.formatMontant(o.coutExterne)} · pièces ${ui.formatMontant(o.coutPieces)} · main-d'œuvre ${ui.formatMontant(o.coutMainOeuvre)}` }, ui.formatMontant(o.coutTotal)) },
      ],
    }).el);
    cont.appendChild(el('div', { class: 'tableau-pied', style: { justifyContent: 'flex-end', gap: '18px' } },
      el('span', null, `${rows.length} intervention(s), dont ${st.nbInterventionsOuvertes || 0} en cours`),
      el('span', null, `Coût externe ${new Date().getFullYear()} : `, el('strong', null, ui.formatMontant(st.coutExterneAnnee || 0))),
      el('span', null, 'Coût externe cumulé : ', el('strong', null, ui.formatMontant(st.coutExterneTotal || 0))),
      el('span', null, 'Coût total des interventions : ', el('strong', null, ui.formatMontant(st.coutTotalInterventions || 0)))));
    return cont;
  }

  function rendreAchats(f) {
    const acces = f.acces || {};
    if (!acces.achats) return sansAcces('stock');
    const a = f.achats || {};
    const cont = el('div');
    // Module Achats & factures : commandes et factures de ce fournisseur
    if (GMAO.moduleVisible('achats')) {
      cont.appendChild(el('div', { class: 'barre-outils', style: { marginBottom: '10px' } },
        ui.bouton('Commandes du fournisseur', { icone: 'liste', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/achats?onglet=commandes&fournisseurId=${f.id}`) }),
        ui.bouton('Factures du fournisseur', { icone: 'euro', classe: 'btn-sm', onClic: () => GMAO.navigate(`#/achats?onglet=factures&fournisseurId=${f.id}`) })));
    }
    if (!a.nbReceptions) {
      cont.appendChild(ui.vide('Aucune réception en stock n\'a été enregistrée auprès de ce fournisseur (mouvements d\'entrée du module Stock).', 'euro'));
      return cont;
    }
    if ((a.parMois || []).some((m) => m.montant > 0)) {
      cont.appendChild(ui.carte('Achats réceptionnés — 12 derniers mois', ui.graphiqueBarres(a.parMois.map((m) => ({ label: nomMois(m.mois), valeur: m.montant, couleur: '#8b5cf6' })), { hauteur: 170 }),
        { actions: el('span', { class: 'texte-2 texte-petit' }, `Total 12 mois : ${ui.formatMontant(a.total12Mois || 0)}`) }));
    }
    const rows = a.receptions || [];
    cont.appendChild(ui.table({
      lignes: rows, recherche: rows.length > 10 ? 'Rechercher une réception…' : false, compact: true, triInitial: { cle: 'date', sens: 'desc' },
      onClic: (m) => (m.articleExiste && GMAO.vues.stock ? GMAO.navigate('#/stock/' + m.articleId) : null),
      colonnes: [
        { cle: 'date', label: 'Date', valeurTri: (m) => m.date || '', rendu: (m) => el('div', null, nowrap(ui.formatDate(m.date)), el('div', { class: 'cellule-secondaire' }, ui.formatHeure(m.date))) },
        { cle: 'articleDesignation', label: 'Article', rendu: (m) => el('div', null, m.articleExiste ? lienVue('#/stock/' + m.articleId, m.articleCode || '#' + m.articleId, 'stock') : el('span', { class: 'texte-2' }, '—'), el('div', { class: 'cellule-secondaire' }, m.articleDesignation)) },
        { cle: 'quantite', label: 'Quantité', aligner: 'droite', valeurTri: (m) => m.quantite, rendu: (m) => nowrap(qte(m.quantite, m.uniteCode), { fontWeight: '600' }) },
        { cle: 'prixUnitaire', label: 'Prix unitaire', aligner: 'droite', valeurTri: (m) => m.prixUnitaire, rendu: (m) => nowrap(ui.formatMontant(m.prixUnitaire)) },
        { cle: 'montant', label: 'Montant', aligner: 'droite', valeurTri: (m) => m.montant, rendu: (m) => nowrap(ui.formatMontant(m.montant), { fontWeight: '600' }) },
        { cle: 'motif', label: 'Motif', rendu: (m) => tronque(m.motif, '260px') },
        { cle: 'userNom', label: 'Par', rendu: (m) => nowrap(m.userNom || '') },
      ],
    }).el);
    cont.appendChild(el('div', { class: 'tableau-pied', style: { justifyContent: 'flex-end', gap: '18px' } },
      el('span', null, a.nbReceptions > rows.length ? `${rows.length} dernières réceptions sur ${a.nbReceptions}` : `${a.nbReceptions} réception(s)`),
      a.derniereReception ? el('span', null, `Dernière réception ${ui.relatif(a.derniereReception)}`) : null,
      el('span', null, 'Total des achats : ', el('strong', null, ui.formatMontant(a.total || 0)))));
    return cont;
  }

  // ----- Impression ------------------------------------------------------------------------------
  function imprimerFiche(f) {
    const ligne = (l, v) => `<dt>${esc(l)}</dt><dd>${esc(v == null || v === '' ? '—' : v).replace(/\n/g, '<br>')}</dd>`;
    const acces = f.acces || {};
    const st = f.stats || {};
    let html = `<h1>${esc(f.nom)}</h1><p><span class="badge">${esc(ui.libelle(LISTE, f.typeCode))}</span>${f.actif === false ? ' <span class="badge">Inactif</span>' : ''}</p>`;
    html += '<h2>Coordonnées</h2><dl>';
    html += ligne('Contact principal', f.contact || f.contactPrincipal);
    html += ligne('Téléphone', f.telephone);
    html += ligne('E-mail', f.email);
    html += ligne('Site web', f.siteWeb);
    html += ligne('Adresse', f.adresse);
    html += ligne('SIRET', formatSiret(f.siret));
    html += ligne('Délai de livraison', f.delaiLivraisonJours != null ? `${f.delaiLivraisonJours} jour(s)` : '');
    for (const c of ui.champsPersoAffichage(MODULE, f)) html += ligne(c.label, c.valeur);
    html += '</dl>';
    if ((f.contacts || []).length) {
      html += `<h2>Contacts</h2><table><thead><tr><th>Nom</th><th>Fonction</th><th>Téléphone</th><th>E-mail</th></tr></thead><tbody>${f.contacts.map((c) => `<tr><td>${esc(c.nom)}</td><td>${esc(c.fonction)}</td><td>${esc(c.telephone)}</td><td>${esc(c.email)}</td></tr>`).join('')}</tbody></table>`;
    }
    if (f.notes) html += `<h2>Notes et conditions</h2><p style="white-space:pre-wrap">${esc(f.notes)}</p>`;
    if (acces.articles && (f.articles || []).length) {
      html += `<h2>Articles fournis (${f.articles.length})</h2><table><thead><tr><th>Code</th><th>Désignation</th><th>Réf. fournisseur</th><th>Stock</th><th>Seuil</th><th>Prix unitaire</th></tr></thead><tbody>${f.articles.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.designation)}${a.actif ? '' : ' (désactivé)'}</td><td>${esc(a.referenceFournisseur)}</td><td>${esc(qte(a.quantite, a.uniteCode))}${a.sousSeuil ? ' ⚠' : ''}</td><td>${esc(ui.formatNombre(a.seuilMin))}</td><td>${esc(ui.formatMontant(a.prixUnitaire))}</td></tr>`).join('')}</tbody></table>`;
    }
    if (acces.equipements && (f.equipements || []).length) {
      html += `<h2>Équipements (${f.equipements.length})</h2><table><thead><tr><th>Numéro</th><th>Équipement</th><th>Marque / modèle</th><th>N° de série</th><th>Fin de garantie</th></tr></thead><tbody>${f.equipements.map((e) => `<tr><td>${esc(e.numero)}</td><td>${esc(e.nom)}</td><td>${esc([e.marque, e.modele].filter(Boolean).join(' '))}</td><td>${esc(e.numeroSerie)}</td><td>${esc(ui.formatDate(e.garantieFin))}</td></tr>`).join('')}</tbody></table>`;
    }
    if (acces.ot && (f.interventions || []).length) {
      html += `<h2>Interventions externes (${f.interventions.length})</h2><table><thead><tr><th>OT</th><th>Intitulé</th><th>Équipement</th><th>Statut</th><th>Date</th><th>Coût externe</th><th>Coût total</th></tr></thead><tbody>${f.interventions.map((o) => `<tr><td>${esc(o.numero)}</td><td>${esc(o.titre)}</td><td>${esc(o.equipementNom)}</td><td>${esc(ui.libelle('statutsOT', o.statut))}</td><td>${esc(ui.formatDate(o.dateReference))}</td><td>${esc(ui.formatMontant(o.coutExterne))}</td><td>${esc(ui.formatMontant(o.coutTotal))}</td></tr>`).join('')}</tbody></table>`;
      html += `<p>Coût externe cumulé : <b>${esc(ui.formatMontant(st.coutExterneTotal || 0))}</b></p>`;
    }
    if (acces.achats && st.totalAchats != null) html += `<h2>Achats</h2><dl>${ligne('Total des achats réceptionnés', ui.formatMontant(st.totalAchats))}${ligne('Sur les 12 derniers mois', ui.formatMontant(st.totalAchats12Mois || 0))}${ligne('Nombre de réceptions', String(st.nbReceptions || 0))}</dl>`;
    ui.imprimer(`Fiche fournisseur — ${f.nom}`, html);
  }

  // ----- Enregistrement de la vue ----------------------------------------------------------------
  GMAO.registerView(MODULE, {
    titre: 'Fournisseurs', icone: 'fournisseurs',
    async rendu(container, { params, query }) {
      if (params[0]) {
        const id = Number(params[0]);
        if (!Number.isInteger(id) || id <= 0) {
          container.appendChild(ui.vide('Fournisseur introuvable', 'alerte'));
          return;
        }
        await afficherFiche(container, id);
        return;
      }
      await afficherListe(container, query || {});
    },
  });
})();
