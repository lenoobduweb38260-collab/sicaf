/**
 * Vue Configuration : société, paramètres généraux, modules (activation / libellés / ordre),
 * options d'affichage des profils & utilisateurs (tri par secteur), secteurs, listes de valeurs,
 * champs personnalisés, numérotation, secteurs & sites. (Base de données et réseau : vue systeme.js.)
 */
(function () {
  'use strict';
  const { el, icone, toast, erreur, frag } = ui;

  const LISTES = [
    { cle: 'statutsOT', label: 'Statuts des ordres de travail', couleur: true, final: true },
    { cle: 'statutsDemande', label: 'Statuts des demandes d\'intervention', couleur: true, final: true },
    { cle: 'typesIntervention', label: 'Types d\'intervention', couleur: true },
    { cle: 'priorites', label: 'Priorités', couleur: true, delai: true },
    { cle: 'typesEquipement', label: 'Types d\'équipement' },
    { cle: 'etatsEquipement', label: 'États des équipements', couleur: true },
    { cle: 'criticites', label: 'Criticités', couleur: true },
    { cle: 'unites', label: 'Unités' },
    { cle: 'categoriesArticles', label: 'Catégories d\'articles (stock)' },
    { cle: 'typesFournisseur', label: 'Types de fournisseur' },
    { cle: 'causesPanne', label: 'Causes de panne' },
    { cle: 'typesSecteur', label: 'Types de secteur (site, bâtiment, service…)', couleur: true },
    { cle: 'typesHabilitation', label: 'RH : habilitations et certifications', couleur: true, duree: true },
    { cle: 'typesAbsence', label: 'RH : types d\'absence', couleur: true },
    { cle: 'typesContrat', label: 'RH : types de contrat' },
    { cle: 'statutsCommande', label: 'Achats : statuts des commandes', couleur: true, final: true },
    { cle: 'statutsFacture', label: 'Achats : statuts des factures', couleur: true, final: true },
    { cle: 'categoriesDepense', label: 'Achats : catégories de dépense', couleur: true },
  ];
  const ENTITES_CHAMPS = [
    { cle: 'equipements', label: 'Équipements' }, { cle: 'ot', label: 'Ordres de travail' }, { cle: 'demandes', label: 'Demandes d\'intervention' },
    { cle: 'articles', label: 'Articles (stock)' }, { cle: 'fournisseurs', label: 'Fournisseurs' }, { cle: 'utilisateurs', label: 'Utilisateurs' },
    { cle: 'personnel', label: 'Personnel (RH)' }, { cle: 'commandes', label: 'Commandes fournisseurs' }, { cle: 'factures', label: 'Factures' },
  ];
  const TYPES_CHAMPS = [['texte', 'Texte'], ['texte_long', 'Texte long'], ['nombre', 'Nombre'], ['date', 'Date'], ['liste', 'Liste de choix'], ['booleen', 'Oui / Non']];

  let config = null;
  const peutModifier = () => GMAO.can('configuration', 'modifier');
  /** Les secteurs et sites se gèrent aussi avec Plans 3D › Modifier (responsable maintenance). */
  const peutGererSecteurs = () => GMAO.can('configuration', 'modifier') || GMAO.can('plans', 'modifier');

  async function enregistrer(partie, message) {
    try {
      config = await api.put('/api/configuration', partie);
      toast(message || 'Configuration enregistrée', 'succes');
      await GMAO.refresh(false);
      construireNavigationSiBesoin();
      return true;
    } catch (e) { erreur(e); return false; }
  }
  function construireNavigationSiBesoin() { /* GMAO.refresh reconstruit déjà la navigation */ }

  // ----- Onglet Général -----------------------------------------------------
  function ongletGeneral() {
    const c = config;
    const f = ui.form({ champs: [
      { type: 'separateur', label: 'Société' },
      { nom: 'societe.nom', label: 'Nom de la société', type: 'texte', requis: true },
      { nom: 'societe.slogan', label: 'Sous-titre (affiché à la connexion)', type: 'texte' },
      { nom: 'societe.adresse', label: 'Adresse', type: 'texte' },
      { nom: 'societe.telephone', label: 'Téléphone', type: 'tel' },
      { nom: 'societe.email', label: 'E-mail', type: 'email' },
      { nom: 'societe.logo', label: 'Logo (PNG, JPG ou SVG, 300 Ko max)', type: 'image', simple: true, tailleMax: 300 * 1024 },
      { type: 'separateur', label: 'Affichage général' },
      { nom: 'general.couleurPrincipale', label: 'Couleur principale', type: 'couleur' },
      { nom: 'general.theme', label: 'Thème par défaut', type: 'select', options: [{ value: 'clair', label: 'Clair' }, { value: 'sombre', label: 'Sombre' }, { value: 'auto', label: 'Selon Windows (auto)' }] },
      { nom: 'general.formatDate', label: 'Format des dates', type: 'select', options: ['dd/MM/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'] },
      { nom: 'general.devise', label: 'Devise', type: 'texte' },
      { nom: 'general.lignesParPage', label: 'Lignes par page dans les tableaux', type: 'nombre', min: 5, max: 500 },
      { nom: 'general.heuresParJour', label: 'Heures de travail par jour', type: 'nombre', min: 1, max: 24 },
      { nom: 'general.tauxHoraire', label: 'Taux horaire main d\'œuvre (pour les coûts)', type: 'nombre', min: 0 },
      { nom: 'general.messageAccueil', label: 'Message affiché sur la page de connexion', type: 'texte_long', lignes: 2 },
      { type: 'separateur', label: 'Sécurité' },
      { nom: 'securite.longueurMinMdp', label: 'Longueur minimale des mots de passe', type: 'nombre', min: 1, max: 64 },
      { nom: 'securite.forcerChangementMdpInitial', label: 'Forcer le changement du mot de passe initial', type: 'booleen' },
      { type: 'separateur', label: 'Circuit de travail (workflow)' },
      { nom: 'workflow.validationDemandes', label: 'Les demandes d\'intervention doivent être validées avant de devenir des OT', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.validerParSuperieurUniquement', label: 'Seul le supérieur hiérarchique du demandeur (ou un admin) peut valider sa demande', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.otAutoDepuisDemande', label: 'Créer automatiquement l\'OT à la validation d\'une demande', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.cloturerDemandeAvecOt', label: 'Clôturer la demande quand l\'OT associé est terminé', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.notifierValidateurs', label: 'Notifier les valideurs à chaque nouvelle demande', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.autoriserTechnicienCloture', label: 'Un technicien peut clôturer ses propres OT', type: 'booleen', sansDecalage: true },
      { nom: 'workflow.stockNegatif', label: 'Autoriser les sorties de stock au-delà de la quantité disponible', type: 'booleen', sansDecalage: true },
      { type: 'separateur', label: 'Maintenance préventive' },
      { nom: 'preventif.genererAuto', label: 'Générer automatiquement les OT préventifs à échéance', type: 'booleen', sansDecalage: true },
      { nom: 'preventif.horizonJours', label: 'Horizon de génération (jours)', type: 'nombre', min: 1 },
    ], valeurs: {
      'societe.nom': c.societe.nom, 'societe.slogan': c.societe.slogan, 'societe.adresse': c.societe.adresse, 'societe.telephone': c.societe.telephone, 'societe.email': c.societe.email, 'societe.logo': c.societe.logo,
      'general.couleurPrincipale': c.general.couleurPrincipale, 'general.theme': c.general.theme, 'general.formatDate': c.general.formatDate, 'general.devise': c.general.devise, 'general.lignesParPage': c.general.lignesParPage, 'general.heuresParJour': c.general.heuresParJour, 'general.tauxHoraire': c.general.tauxHoraire, 'general.messageAccueil': c.general.messageAccueil,
      'securite.longueurMinMdp': c.securite.longueurMinMdp, 'securite.forcerChangementMdpInitial': c.securite.forcerChangementMdpInitial,
      'workflow.validationDemandes': c.workflow.validationDemandes, 'workflow.validerParSuperieurUniquement': c.workflow.validerParSuperieurUniquement, 'workflow.otAutoDepuisDemande': c.workflow.otAutoDepuisDemande, 'workflow.cloturerDemandeAvecOt': c.workflow.cloturerDemandeAvecOt, 'workflow.notifierValidateurs': c.workflow.notifierValidateurs, 'workflow.autoriserTechnicienCloture': c.workflow.autoriserTechnicienCloture, 'workflow.stockNegatif': c.workflow.stockNegatif,
      'preventif.genererAuto': c.preventif.genererAuto, 'preventif.horizonJours': c.preventif.horizonJours,
    } });
    const btn = ui.bouton('Enregistrer', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => {
      if (!f.valider()) return;
      const v = f.valeurs();
      const d = {};
      for (const [k, val] of Object.entries(v)) { const [a, b] = k.split('.'); d[a] = d[a] || {}; d[a][b] = val == null ? '' : val; }
      if (await enregistrer(d)) GMAO.rendre();
    } });
    return ui.carte(null, frag(f.el, el('div', { class: 'mt texte-droite' }, btn)));
  }

  // ----- Onglet Modules -----------------------------------------------------
  function ongletModules() {
    const lignes = GMAO.catalogue.modules.map((m) => {
      const cm = config.modules[m.key] || {};
      const verrou = ['configuration', 'profils', 'utilisateurs'].includes(m.key);
      return { m, actif: el('input', { type: 'checkbox', checked: cm.actif !== false, disabled: verrou || !peutModifier() }), label: el('input', { type: 'text', value: cm.label || '', placeholder: m.label, disabled: !peutModifier() }), ordre: el('input', { type: 'number', value: cm.ordre != null ? cm.ordre : m.ordre, style: { width: '80px' }, disabled: !peutModifier() }) };
    });
    const tbl = el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Module'), el('th', { class: 'centre' }, 'Actif'), el('th', null, 'Libellé personnalisé (menu)'), el('th', null, 'Ordre'), el('th', null, 'Description'))),
      el('tbody', null, lignes.map((l) => el('tr', null, el('td', null, el('div', { class: 'ligne-module' }, icone(l.m.icon), l.m.label)), el('td', { class: 'centre' }, l.actif), el('td', null, l.label), el('td', null, l.ordre), el('td', { class: 'texte-2 texte-petit' }, l.m.description)))));
    const btn = ui.bouton('Enregistrer', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => {
      const modules = {};
      for (const l of lignes) modules[l.m.key] = { actif: l.actif.checked, label: l.label.value.trim(), ordre: Number(l.ordre.value) };
      if (await enregistrer({ modules })) GMAO.rendre();
    } });
    return ui.carte('Modules de l\'application', frag(
      el('p', { class: 'texte-2 texte-petit' }, 'Désactivez les modules inutiles (ils disparaissent du menu pour tout le monde), renommez-les et ordonnez-les. Les modules Utilisateurs, Profils et Configuration restent toujours actifs.'),
      el('div', { class: 'tableau-conteneur' }, tbl), el('div', { class: 'mt texte-droite' }, btn)));
  }

  // ----- Onglet Affichage (profils / utilisateurs) -------------------------
  function ongletAffichage() {
    const f = ui.form({ colonnes: 1, champs: [
      { type: 'separateur', label: 'Profils & droits' },
      { nom: 'profils.triParSecteur', label: 'Trier les profils par secteur (par défaut)', type: 'booleen', sansDecalage: true, aide: 'Sinon, tri par niveau hiérarchique. Les profils sans secteur apparaissent en premier.' },
      { nom: 'profils.grouperParSecteur', label: 'Regrouper les profils par secteur (en-têtes de groupe)', type: 'booleen', sansDecalage: true },
      { nom: 'profils.afficherNiveau', label: 'Afficher la colonne « Niveau hiérarchique »', type: 'booleen', sansDecalage: true },
      { type: 'separateur', label: 'Utilisateurs' },
      { nom: 'utilisateurs.triParSecteur', label: 'Trier les utilisateurs par secteur (par défaut)', type: 'booleen', sansDecalage: true },
      { nom: 'utilisateurs.grouperParSecteur', label: 'Regrouper les utilisateurs par secteur', type: 'booleen', sansDecalage: true },
      { nom: 'utilisateurs.afficherSuperieur', label: 'Afficher la colonne « Supérieur hiérarchique »', type: 'booleen', sansDecalage: true },
    ], valeurs: {
      'profils.triParSecteur': config.profils.triParSecteur, 'profils.grouperParSecteur': config.profils.grouperParSecteur, 'profils.afficherNiveau': config.profils.afficherNiveau,
      'utilisateurs.triParSecteur': config.utilisateurs.triParSecteur, 'utilisateurs.grouperParSecteur': config.utilisateurs.grouperParSecteur, 'utilisateurs.afficherSuperieur': config.utilisateurs.afficherSuperieur,
    } });
    const btn = ui.bouton('Enregistrer', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => {
      const v = f.valeurs(); const d = {};
      for (const [k, val] of Object.entries(v)) { const [a, b] = k.split('.'); d[a] = d[a] || {}; d[a][b] = val; }
      await enregistrer(d);
    } });
    return ui.carte('Tri et regroupement par secteur', frag(el('p', { class: 'texte-2 texte-petit' }, 'Chaque profil et chaque utilisateur peut être rattaché à un secteur. Ces options définissent l\'affichage par défaut des listes ; chacun peut ensuite changer le tri à la volée.'), f.el, el('div', { class: 'mt texte-droite' }, btn)));
  }

  // ----- Onglet Secteurs ----------------------------------------------------
  function ongletSecteurs(cont) {
    cont.appendChild(ui.chargement());
    const formulaireSecteur = (existant) => {
      ui.formModal({
        titre: existant && existant.id ? `Modifier « ${existant.nom} »` : 'Nouveau site / secteur',
        champs: [
          { nom: 'nom', label: 'Nom', type: 'texte', requis: true },
          { nom: 'code', label: 'Code court', type: 'texte', placeholder: 'ex. PROD' },
          { nom: 'type', label: 'Type', type: 'select', liste: 'typesSecteur', vide: false, requis: true, aide: 'Un « site » est une usine / un établissement : il porte les droits d\'accès multi-site.' },
          { nom: 'parentId', label: 'Secteur parent', type: 'select', options: ui.optionsSecteurs({ vide: '— Aucun (racine) —', tousSites: true }).filter((o) => !existant || o.value !== existant.id) },
          { nom: 'responsableId', label: 'Responsable', type: 'select', options: ui.optionsUsers() },
          { nom: 'couleur', label: 'Couleur', type: 'couleur', valeur: '#2563eb' },
          { nom: 'ordre', label: 'Ordre d\'affichage', type: 'nombre', valeur: 0 },
          { nom: 'actif', label: 'Actif', type: 'booleen', valeur: true },
          { nom: 'description', label: 'Description', type: 'texte_long', lignes: 2 },
        ],
        valeurs: existant ? Object.assign({ type: existant.parentId == null ? 'site' : 'service' }, existant, { parentId: existant.parentId == null ? '' : existant.parentId, responsableId: existant.responsableId == null ? '' : existant.responsableId }) : { type: 'site' },
        onSubmit: async (v) => {
          const body = Object.assign({}, v, { parentId: v.parentId === '' ? null : v.parentId, responsableId: v.responsableId === '' ? null : v.responsableId });
          if (existant && existant.id) await api.put('/api/secteurs/' + existant.id, body); else await api.post('/api/secteurs', body);
          toast('Secteur enregistré', 'succes');
          await GMAO.refresh(false); rendre();
        },
      });
    };
    async function rendre() {
      let arbre;
      try { arbre = await api.get('/api/secteurs-arbre'); } catch (e) { return erreur(e); }
      ui.vider(cont);
      const liste = el('div');
      const construire = (noeuds, niveau) => noeuds.forEach((s) => {
        liste.appendChild(el('div', { class: 'carte', style: { marginLeft: (niveau * 24) + 'px', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '12px' } },
          ui.pastille(s.couleur),
          el('div', { style: { flex: 1 } }, el('div', { class: 'texte-gras' }, s.type === 'site' ? frag(icone('site'), ' ') : null, s.nom, s.code ? el('span', { class: 'texte-2 texte-petit' }, ` (${s.code})`) : null, ' ', ui.badgeListe('typesSecteur', s.type, { contour: true }), s.actif === false ? frag(' ', ui.badge('Inactif', '#6b7280')) : null),
            el('div', { class: 'texte-2 texte-petit' }, [s.responsableNom ? 'Responsable : ' + s.responsableNom : null, `${s.nbUtilisateurs} utilisateur(s)`, `${s.nbProfils} profil(s)`, `${s.nbEquipements} équipement(s)`].filter(Boolean).join(' · '))),
          peutGererSecteurs() ? el('div', null,
            el('button', { class: 'btn btn-icone btn-sm', title: 'Ajouter un sous-secteur', onclick: () => formulaireSecteur({ parentId: s.id, nom: '', couleur: s.couleur, actif: true, ordre: 0, type: s.type === 'site' ? 'service' : 'zone' }) }, icone('plus')),
            el('button', { class: 'btn btn-icone btn-sm', title: 'Modifier', onclick: () => formulaireSecteur(s) }, icone('modifier')),
            el('button', { class: 'btn btn-icone btn-sm texte-danger', title: 'Supprimer', onclick: async () => {
              if (!(await ui.confirm({ titre: 'Supprimer le secteur', message: `Supprimer « ${s.nom} » ? Les éléments rattachés seront détachés.`, okLabel: 'Supprimer', danger: true }))) return;
              try { await api.del(`/api/secteurs/${s.id}?forcer=1`); toast('Secteur supprimé', 'succes'); await GMAO.refresh(false); rendre(); } catch (e) { erreur(e); }
            } }, icone('supprimer'))) : null));
        construire(s.enfants || [], niveau + 1);
      });
      construire(arbre, 0);
      if (!arbre.length) liste.appendChild(ui.vide('Aucun secteur défini'));
      cont.appendChild(el('div', { class: 'barre-outils' }, el('p', { class: 'texte-2 texte-petit', style: { margin: 0 } }, 'Structurez l\'entreprise : sites (usines), puis bâtiments, services, ateliers, lignes, zones, magasins. Les sites portent les accès multi-site ; les secteurs servent à trier les profils et utilisateurs, à restreindre la portée des données et à classer les équipements.'), el('span', { class: 'espace' }), peutGererSecteurs() ? ui.bouton('Nouveau site / secteur', { icone: 'plus', classe: 'btn-primaire', onClic: () => formulaireSecteur(null) }) : null));
      cont.appendChild(liste);
    }
    rendre();
  }

  // ----- Onglet Listes de valeurs ------------------------------------------
  function ongletListes() {
    const cont = el('div');
    let courante = LISTES[0].cle;
    const select = el('select', { onchange: () => { courante = select.value; rendreListe(); } }, LISTES.map((l) => el('option', { value: l.cle }, l.label)));
    const zone = el('div');
    function rendreListe() {
      const def = LISTES.find((l) => l.cle === courante);
      const items = (config.listes[courante] || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map((x) => Object.assign({}, x));
      ui.vider(zone);
      const corps = el('div', { class: 'liste-editable' });
      const colonnes = ['28px', '140px', '1fr'].concat(def.couleur ? ['60px'] : [], def.final ? ['70px'] : [], def.delai ? ['110px'] : [], def.duree ? ['120px'] : [], ['36px']);
      const entete = el('div', { class: 'ligne texte-2 texte-petit texte-gras', style: { gridTemplateColumns: colonnes.join(' ') } }, el('span'), el('span', null, 'Code'), el('span', null, 'Libellé'), def.couleur ? el('span', null, 'Couleur') : null, def.final ? el('span', null, 'Final') : null, def.delai ? el('span', null, 'Délai (h)') : null, def.duree ? el('span', null, 'Validité (mois)') : null, el('span'));
      corps.appendChild(entete);
      const lignes = [];
      const construire = () => {
        corps.querySelectorAll('.ligne:not(:first-child)').forEach((x) => x.remove());
        lignes.length = 0;
        items.forEach((it, i) => {
          const l = { it, code: el('input', { type: 'text', value: it.code, disabled: !peutModifier() }), label: el('input', { type: 'text', value: it.label, disabled: !peutModifier() }), couleur: def.couleur ? el('input', { type: 'color', value: it.couleur || '#6b7280', disabled: !peutModifier() }) : null, final: def.final ? el('input', { type: 'checkbox', checked: !!it.final, disabled: !peutModifier() }) : null, delai: def.delai ? el('input', { type: 'number', value: it.delaiHeures || 0, disabled: !peutModifier() }) : null, duree: def.duree ? el('input', { type: 'number', value: it.dureeMois || 0, min: 0, disabled: !peutModifier() }) : null };
          lignes.push(l);
          const monter = el('button', { class: 'btn btn-icone btn-sm', title: 'Monter', type: 'button', disabled: i === 0 || !peutModifier(), onclick: () => { lire(); [items[i - 1], items[i]] = [items[i], items[i - 1]]; construire(); } }, icone('haut'));
          corps.appendChild(el('div', { class: 'ligne', style: { gridTemplateColumns: colonnes.join(' ') } }, monter, l.code, l.label, l.couleur, l.final ? el('div', { class: 'texte-centre' }, l.final) : null, l.delai, l.duree, el('button', { class: 'btn btn-icone btn-sm texte-danger', type: 'button', title: 'Supprimer', disabled: !peutModifier(), onclick: () => { lire(); items.splice(i, 1); construire(); } }, icone('supprimer'))));
        });
      };
      const lire = () => { lignes.forEach((l, i) => { l.it.code = l.code.value; l.it.label = l.label.value; if (l.couleur) l.it.couleur = l.couleur.value; if (l.final) l.it.final = l.final.checked; if (l.delai) l.it.delaiHeures = Number(l.delai.value) || 0; if (l.duree) l.it.dureeMois = Number(l.duree.value) || 0; l.it.ordre = i + 1; }); };
      construire();
      zone.appendChild(corps);
      zone.appendChild(el('div', { class: 'mt', style: { display: 'flex', gap: '8px' } },
        ui.bouton('Ajouter une valeur', { icone: 'plus', disabled: !peutModifier(), onClic: () => { lire(); items.push({ code: '', label: '', couleur: '#6b7280', ordre: items.length + 1 }); construire(); } }),
        el('span', { class: 'espace', style: { flex: 1 } }),
        ui.bouton('Enregistrer cette liste', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => { lire(); await enregistrer({ listes: { [courante]: items } }, 'Liste enregistrée'); rendreListe(); } })));
    }
    rendreListe();
    cont.appendChild(ui.carte('Listes de valeurs', frag(
      el('p', { class: 'texte-2 texte-petit' }, 'Statuts, types, priorités… Tout est modifiable : code technique (stable, utilisé dans les données), libellé affiché, couleur, ordre. Un statut « final » clôture l\'élément.'),
      el('div', { class: 'barre-outils' }, select, el('span', { class: 'espace' }), peutModifier() ? ui.bouton('Rétablir toutes les listes par défaut', { icone: 'rafraichir', onClic: async () => { if (!(await ui.confirm({ titre: 'Rétablir', message: 'Remplacer toutes les listes par les valeurs d\'origine ?', danger: true, okLabel: 'Rétablir' }))) return; try { config = await api.post('/api/configuration/reinitialiser/listes'); await GMAO.refresh(false); toast('Listes rétablies', 'succes'); rendreListe(); } catch (e) { erreur(e); } } }) : null),
      zone)));
    return cont;
  }

  // ----- Onglet Champs personnalisés ----------------------------------------
  function ongletChamps() {
    const cont = el('div');
    let entite = ENTITES_CHAMPS[0].cle;
    const select = el('select', { onchange: () => { entite = select.value; rendre(); } }, ENTITES_CHAMPS.map((e) => el('option', { value: e.cle }, e.label)));
    const zone = el('div');
    function rendre() {
      const defs = (config.champsPersonnalises[entite] || []).map((d) => Object.assign({}, d));
      ui.vider(zone);
      const tbody = el('tbody');
      const lignes = [];
      const construire = () => {
        ui.vider(tbody); lignes.length = 0;
        defs.forEach((d, i) => {
          const l = { d, label: el('input', { type: 'text', value: d.label, disabled: !peutModifier() }), cle: el('input', { type: 'text', value: d.cle || '', placeholder: 'auto', disabled: !peutModifier() }), type: el('select', { disabled: !peutModifier() }, TYPES_CHAMPS.map(([v, lab]) => el('option', { value: v, selected: v === d.type }, lab))), options: el('input', { type: 'text', value: (d.options || []).join('; '), placeholder: 'valeurs séparées par ;', disabled: !peutModifier() }), obligatoire: el('input', { type: 'checkbox', checked: !!d.obligatoire, disabled: !peutModifier() }), afficherListe: el('input', { type: 'checkbox', checked: !!d.afficherListe, disabled: !peutModifier() }), aide: el('input', { type: 'text', value: d.aide || '', disabled: !peutModifier() }) };
          lignes.push(l);
          tbody.appendChild(el('tr', null, el('td', null, l.label), el('td', null, l.cle), el('td', null, l.type), el('td', null, l.options), el('td', { class: 'centre' }, l.obligatoire), el('td', { class: 'centre' }, l.afficherListe), el('td', null, l.aide),
            el('td', { class: 'actions' }, el('button', { class: 'btn btn-icone btn-sm', type: 'button', disabled: i === 0 || !peutModifier(), onclick: () => { lire(); [defs[i - 1], defs[i]] = [defs[i], defs[i - 1]]; construire(); } }, icone('haut')), el('button', { class: 'btn btn-icone btn-sm texte-danger', type: 'button', disabled: !peutModifier(), onclick: () => { lire(); defs.splice(i, 1); construire(); } }, icone('supprimer')))));
        });
        if (!defs.length) tbody.appendChild(el('tr', null, el('td', { colspan: 8, class: 'tableau-vide' }, 'Aucun champ personnalisé pour cette entité')));
      };
      const lire = () => lignes.forEach((l, i) => { l.d.label = l.label.value; l.d.cle = l.cle.value; l.d.type = l.type.value; l.d.options = l.options.value.split(';').map((s) => s.trim()).filter(Boolean); l.d.obligatoire = l.obligatoire.checked; l.d.afficherListe = l.afficherListe.checked; l.d.aide = l.aide.value; l.d.ordre = i + 1; });
      construire();
      zone.appendChild(el('div', { class: 'tableau-conteneur' }, el('table', { class: 'tableau tableau-compact' }, el('thead', null, el('tr', null, el('th', null, 'Libellé'), el('th', null, 'Clé'), el('th', null, 'Type'), el('th', null, 'Options (liste)'), el('th', { class: 'centre' }, 'Obligatoire'), el('th', { class: 'centre' }, 'Colonne liste'), el('th', null, 'Aide'), el('th'))), tbody)));
      zone.appendChild(el('div', { class: 'mt', style: { display: 'flex', gap: '8px' } },
        ui.bouton('Ajouter un champ', { icone: 'plus', disabled: !peutModifier(), onClic: () => { lire(); defs.push({ label: '', cle: '', type: 'texte', options: [], obligatoire: false, aide: '' }); construire(); } }),
        el('span', { style: { flex: 1 } }),
        ui.bouton('Enregistrer', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => { lire(); if (defs.some((d) => !d.label.trim())) return toast('Chaque champ doit avoir un libellé', 'erreur'); await enregistrer({ champsPersonnalises: { [entite]: defs } }, 'Champs enregistrés'); rendre(); } })));
    }
    rendre();
    cont.appendChild(ui.carte('Champs personnalisés', frag(el('p', { class: 'texte-2 texte-petit' }, 'Ajoutez vos propres champs aux fiches (numéro de série interne, centre de coût, zone ATEX…). Ils apparaissent dans les formulaires et les fiches de l\'entité choisie.'), el('div', { class: 'barre-outils' }, select), zone)));
    return cont;
  }

  // ----- Onglet Numérotation ------------------------------------------------
  function ongletNumerotation() {
    const n = config.numerotation;
    const f = ui.form({ champs: [
      { nom: 'ot', label: 'Ordres de travail', type: 'texte', requis: true, valeur: n.ot },
      { nom: 'di', label: 'Demandes d\'intervention', type: 'texte', requis: true, valeur: n.di },
      { nom: 'eq', label: 'Équipements (code automatique)', type: 'texte', requis: true, valeur: n.eq },
      { nom: 'art', label: 'Articles de stock', type: 'texte', requis: true, valeur: n.art },
      { nom: 'pp', label: 'Plans de maintenance préventive', type: 'texte', requis: true, valeur: n.pp },
      { nom: 'inv', label: 'Inventaires', type: 'texte', requis: true, valeur: n.inv },
      { nom: 'cmd', label: 'Commandes fournisseurs', type: 'texte', requis: true, valeur: n.cmd },
      { nom: 'fac', label: 'Factures (référence interne)', type: 'texte', requis: true, valeur: n.fac },
      { nom: 'pl', label: 'Plans 3D', type: 'texte', requis: true, valeur: n.pl },
      { nom: 'mat', label: 'Matricules du personnel', type: 'texte', requis: true, valeur: n.mat },
    ] });
    const btn = ui.bouton('Enregistrer', { classe: 'btn-primaire', icone: 'check', disabled: !peutModifier(), onClic: async () => { if (!f.valider()) return; await enregistrer({ numerotation: f.valeurs() }); } });
    return ui.carte('Numérotation automatique', frag(el('p', { class: 'texte-2 texte-petit' }, 'Gabarits disponibles : {annee} (2026), {aa} (26), {mois} (01), {num:4} (compteur sur 4 chiffres, réinitialisé chaque année si {annee} est présent). Exemple : OT-{annee}-{num:4} → OT-2026-0001.'), f.el, el('div', { class: 'mt texte-droite' }, btn)));
  }

  GMAO.registerView('configuration', {
    titre: 'Configuration', icone: 'configuration',
    async rendu(container) {
      config = await api.get('/api/configuration');
      container.appendChild(ui.pageEntete({ titre: GMAO.moduleLabel('configuration'), icone: 'configuration', sousTitre: 'Tout est modifiable : société, modules, listes, champs, secteurs, numérotation. Base de données, sauvegardes et réseau : écran « Système & informatique ».' }));
      if (!peutModifier()) container.appendChild(ui.alerte('Vous consultez la configuration en lecture seule.', 'info'));
      container.appendChild(ui.onglets([
        { cle: 'general', label: 'Général', icone: 'configuration', rendu: () => ongletGeneral() },
        { cle: 'modules', label: 'Modules', icone: 'liste', rendu: () => ongletModules() },
        { cle: 'affichage', label: 'Profils & secteurs', icone: 'profils', rendu: () => ongletAffichage() },
        { cle: 'secteurs', label: 'Secteurs & sites', icone: 'site', rendu: (c) => { ongletSecteurs(c); } },
        { cle: 'listes', label: 'Listes de valeurs', icone: 'filtre', rendu: () => ongletListes() },
        { cle: 'champs', label: 'Champs personnalisés', icone: 'modifier', rendu: () => ongletChamps() },
        { cle: 'numerotation', label: 'Numérotation', icone: 'ot', rendu: () => ongletNumerotation() },
      ], { hash: true }).el);
    },
  });
})();
