'use strict';
/**
 * Catalogue des modules / actions et calcul des droits effectifs.
 *
 * Droits effectifs d'un utilisateur =
 *     droits du profil (matrice module × action)
 *   + surcharges individuelles de l'utilisateur (`overrides`, qui peuvent
 *     ajouter OU retirer un droit : « voir plus ou moins »)
 *   + portée des données (tous / ses secteurs / ses propres éléments)
 *   + niveau hiérarchique du profil (1 = plus haut).
 *
 * Les modules désactivés dans la configuration sont invisibles pour tous.
 */

const ACTIONS = {
  voir: 'Voir',
  creer: 'Créer',
  modifier: 'Modifier',
  supprimer: 'Supprimer',
  valider: 'Valider',
  affecter: 'Affecter',
  cloturer: 'Clôturer',
  exporter: 'Exporter',
};

const MODULES = [
  { key: 'dashboard', label: 'Tableau de bord', icon: 'dashboard', ordre: 10, actions: ['voir'], description: 'Indicateurs et synthèse de la maintenance' },
  { key: 'equipements', label: 'Équipements', icon: 'equipements', ordre: 20, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Arborescence et fiches des équipements' },
  { key: 'visites', label: 'Audits & visites', icon: 'visite', ordre: 28, actions: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], description: 'Audits clients, certifications, visites du site : planning, registre des visiteurs, badges, constats et plans d\'actions' },
  { key: 'demandes', label: "Demandes d'intervention", icon: 'demandes', ordre: 30, actions: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], description: 'Signalements et demandes avec circuit de validation' },
  { key: 'ot', label: 'Ordres de travail', icon: 'ot', ordre: 40, actions: ['voir', 'creer', 'modifier', 'supprimer', 'affecter', 'cloturer', 'exporter'], description: 'Interventions correctives, préventives et améliorations' },
  { key: 'plans', label: 'Plans 3D', icon: 'plan3d', ordre: 25, actions: ['voir', 'creer', 'modifier', 'supprimer'], description: 'Plans 3D des sites : implantation des bâtiments, zones, machines et installations' },
  { key: 'preventif', label: 'Maintenance préventive', icon: 'preventif', ordre: 50, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Plans et gammes de maintenance périodiques' },
  { key: 'planning', label: 'Planning', icon: 'planning', ordre: 60, actions: ['voir', 'modifier'], description: 'Calendrier des interventions' },
  { key: 'stock', label: 'Stock & pièces', icon: 'stock', ordre: 70, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Pièces détachées, mouvements et alertes de stock' },
  { key: 'inventaire', label: 'Étiquettes & inventaire', icon: 'codebarre', ordre: 75, actions: ['voir', 'creer', 'modifier', 'valider', 'supprimer', 'exporter'], description: 'Étiquettes code-barres, scan et inventaires du magasin' },
  { key: 'fournisseurs', label: 'Fournisseurs', icon: 'fournisseurs', ordre: 80, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Fournisseurs et prestataires externes' },
  { key: 'achats', label: 'Achats & factures', icon: 'achats', ordre: 85, actions: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], description: 'Commandes fournisseurs, réceptions, factures et échéances de paiement' },
  { key: 'rapports', label: 'Rapports & historique', icon: 'rapports', ordre: 90, actions: ['voir', 'exporter'], description: 'Historique, statistiques et exports' },
  { key: 'rh', label: 'Ressources humaines', icon: 'rh', ordre: 95, actions: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], description: 'Personnel, habilitations, formations, visites médicales, absences' },
  { key: 'utilisateurs', label: 'Utilisateurs', icon: 'utilisateurs', ordre: 100, actions: ['voir', 'creer', 'modifier', 'supprimer'], description: 'Comptes internes et hiérarchie' },
  { key: 'profils', label: 'Profils & droits', icon: 'profils', ordre: 110, actions: ['voir', 'creer', 'modifier', 'supprimer'], description: 'Profils, matrice des droits, secteurs' },
  { key: 'configuration', label: 'Configuration', icon: 'configuration', ordre: 120, actions: ['voir', 'modifier'], description: 'Paramètres, listes de valeurs, champs personnalisés, sauvegardes' },
  { key: 'systeme', label: 'Système & informatique', icon: 'serveur', ordre: 125, actions: ['voir', 'modifier'], description: 'Base de données, sauvegardes, réseau, postes connectés, mises à jour (réservé au pôle informatique)' },
  { key: 'audit', label: "Journal d'activité", icon: 'audit', ordre: 130, actions: ['voir', 'exporter'], description: 'Journal de toutes les actions (logs) et notifications aux responsables' },
];

const PORTEES = {
  tous: 'Toutes les données (tous les sites)',
  site: 'Ses sites (tous les secteurs des sites de rattachement)',
  secteurs: 'Ses secteurs uniquement (et sous-secteurs)',
  perso: 'Ses propres éléments uniquement',
};

/** Modes d'accès à un site supplémentaire (champ utilisateur `siteAcces`). */
const MODES_SITE = {
  lecture: 'Lecture seule (consulter les problèmes, interventions, équipements…)',
  complet: 'Accès complet (selon les droits du profil)',
};

function moduleByKey(key) { return MODULES.find((m) => m.key === key) || null; }

/** Matrice vide (tout à false). */
function matriceVide() {
  const out = {};
  for (const m of MODULES) {
    out[m.key] = {};
    for (const a of m.actions) out[m.key][a] = false;
  }
  return out;
}

/** Matrice complète (tout à true). */
function matricePleine() {
  const out = matriceVide();
  for (const k of Object.keys(out)) for (const a of Object.keys(out[k])) out[k][a] = true;
  return out;
}

/** Nettoie une matrice reçue du client : ne garde que les modules/actions connus. */
function normaliserMatrice(input) {
  const out = matriceVide();
  if (!input || typeof input !== 'object') return out;
  for (const m of MODULES) {
    const src = input[m.key];
    if (!src || typeof src !== 'object') continue;
    for (const a of m.actions) out[m.key][a] = !!src[a];
    // "voir" est implicite dès qu'une autre action est accordée
    if (m.actions.some((a) => a !== 'voir' && out[m.key][a])) out[m.key].voir = true;
  }
  return out;
}

/** Surcharges : objet { module: { action: true|false } } ; les valeurs non booléennes sont ignorées. */
function normaliserOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const m of MODULES) {
    const src = input[m.key];
    if (!src || typeof src !== 'object') continue;
    for (const a of m.actions) {
      if (typeof src[a] === 'boolean') {
        out[m.key] = out[m.key] || {};
        out[m.key][a] = src[a];
      }
    }
  }
  return out;
}

/** Secteurs descendants (inclus) d'une liste d'identifiants. */
function secteursDescendants(db, ids) {
  const all = db.list('secteurs');
  const result = new Set((ids || []).map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of all) {
      if (s.parentId != null && result.has(Number(s.parentId)) && !result.has(s.id)) {
        result.add(s.id);
        changed = true;
      }
    }
  }
  return Array.from(result);
}

/** Secteurs de type « site ». */
function sites(db) {
  return db.list('secteurs', (s) => s.type === 'site').sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || String(a.nom).localeCompare(String(b.nom)));
}

/** Site (ancêtre ou soi-même de type « site ») d'un secteur, ou null. */
function siteDuSecteur(db, secteurId, cache) {
  if (secteurId == null || secteurId === '') return null;
  const all = cache || new Map(db.list('secteurs').map((s) => [s.id, s]));
  let cur = all.get(Number(secteurId));
  const vus = new Set();
  while (cur && !vus.has(cur.id)) {
    if (cur.type === 'site') return cur.id;
    vus.add(cur.id);
    cur = cur.parentId != null ? all.get(Number(cur.parentId)) : null;
  }
  return null;
}

/** Normalise `siteAcces` : [{ siteId, mode }] (sites existants uniquement, un seul mode par site). */
function normaliserSiteAcces(db, input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set(sites(db).map((s) => s.id));
  const out = new Map();
  for (const x of input) {
    if (!x || typeof x !== 'object') continue;
    const id = Number(x.siteId);
    if (!ids.has(id) || !MODES_SITE[x.mode]) continue;
    if (out.get(id) === 'complet') continue;
    out.set(id, x.mode);
  }
  return Array.from(out.entries()).map(([siteId, mode]) => ({ siteId, mode }));
}

/** Modules visibles selon la configuration (actif + libellé personnalisé). */
function modulesConfigures(config) {
  const cfg = (config && config.modules) || {};
  return MODULES.map((m) => {
    const c = cfg[m.key] || {};
    return {
      key: m.key,
      label: c.label || m.label,
      labelOrigine: m.label,
      icon: m.icon,
      ordre: typeof c.ordre === 'number' ? c.ordre : m.ordre,
      actif: c.actif !== false,
      actions: m.actions,
      description: m.description,
    };
  }).sort((a, b) => a.ordre - b.ordre);
}

/**
 * Calcule les droits effectifs.
 * @returns {{modules:Object, portee:string, secteurIds:number[], niveau:number, estAdmin:boolean}}
 */
function effectivePermissions(db, user, profil, config) {
  config = config || db.getConfig();
  profil = profil || (user && db.get('profils', user.profilId)) || null;
  const estAdmin = !!(profil && profil.estAdmin);
  let modules = estAdmin ? matricePleine() : normaliserMatrice(profil && profil.permissions);

  // Surcharges individuelles (sauf pour un administrateur : il a déjà tout)
  if (!estAdmin && user && user.overrides) {
    const ov = normaliserOverrides(user.overrides);
    for (const k of Object.keys(ov)) {
      for (const a of Object.keys(ov[k])) modules[k][a] = ov[k][a];
      if (MODULES.find((m) => m.key === k).actions.some((a) => a !== 'voir' && modules[k][a])) modules[k].voir = true;
    }
  }

  // Modules désactivés globalement
  const cfgModules = (config && config.modules) || {};
  for (const m of MODULES) {
    if (cfgModules[m.key] && cfgModules[m.key].actif === false) {
      for (const a of m.actions) modules[m.key][a] = false;
    }
  }

  let portee = estAdmin ? 'tous' : ((user && user.porteeOverride) || (profil && profil.portee) || 'tous');
  if (!PORTEES[portee]) portee = 'tous';
  const secteursBase = (user && Array.isArray(user.secteurIds)) ? user.secteurIds.map(Number) : [];

  // ----- Sites : rattachement + accès supplémentaires (lecture seule ou complet) -----
  const cache = new Map(db.list('secteurs').map((s) => [s.id, s]));
  const tousSites = sites(db);
  const sitesAttaches = Array.from(new Set(secteursBase.map((s) => siteDuSecteur(db, s, cache)).filter((x) => x != null)));
  const acces = estAdmin || portee === 'tous' ? [] : normaliserSiteAcces(db, user && user.siteAcces);
  const sitesComplets = new Set(acces.filter((a) => a.mode === 'complet').map((a) => a.siteId));
  const sitesLecture = new Set(acces.filter((a) => a.mode === 'lecture').map((a) => a.siteId));

  let secteurIds;
  if (portee === 'site') secteurIds = secteursDescendants(db, sitesAttaches.concat(Array.from(sitesComplets)));
  else if (portee === 'secteurs') secteurIds = secteursDescendants(db, secteursBase.concat(Array.from(sitesComplets)));
  else if (portee === 'perso') secteurIds = secteursDescendants(db, secteursBase.concat(Array.from(sitesComplets)));
  else secteurIds = secteursDescendants(db, secteursBase);
  const ecriture = new Set(secteurIds);
  const secteurIdsLecture = secteursDescendants(db, Array.from(sitesLecture)).filter((id) => !ecriture.has(id));

  // Liste des sites accessibles (pour le sélecteur de site)
  const sitesAccessibles = tousSites.filter((s) => {
    if (portee === 'tous') return true;
    if (sitesAttaches.includes(s.id) || sitesComplets.has(s.id) || sitesLecture.has(s.id)) return true;
    // portée secteurs : site contenant au moins un des secteurs de l'utilisateur
    return secteurIds.some((id) => siteDuSecteur(db, id, cache) === s.id);
  }).map((s) => ({
    id: s.id, nom: s.nom, code: s.code || '', couleur: s.couleur || '#6b7280',
    mode: portee === 'tous' || sitesAttaches.includes(s.id) || sitesComplets.has(s.id) ? 'complet' : (sitesLecture.has(s.id) ? 'lecture' : 'complet'),
    attache: sitesAttaches.includes(s.id),
  }));

  return {
    modules,
    portee,
    secteurIds,
    secteurIdsLecture,
    sites: sitesAccessibles,
    siteCourantId: null,
    siteFiltre: null,
    niveau: profil ? Number(profil.niveau || 99) : 99,
    estAdmin,
    profilId: profil ? profil.id : null,
    profilNom: profil ? profil.nom : null,
  };
}

function can(perms, module, action) {
  return !!(perms && perms.modules && perms.modules[module] && perms.modules[module][action]);
}

/** Champs d'un enregistrement considérés comme « appartenance » pour la portée « perso ». */
const CHAMPS_PERSO = ['createdBy', 'demandeurId', 'technicienId', 'responsableId', 'utilisateurId', 'assigneA'];

/** L'utilisateur est-il l'intervenant désigné (OT, plan préventif : `technicienId`, `techniciens[]`) ? */
function estIntervenant(record, uid) {
  if (uid == null) return false;
  if (record.technicienId != null && Number(record.technicienId) === uid) return true;
  return Array.isArray(record.techniciens) && record.techniciens.map(Number).includes(uid);
}

/**
 * L'utilisateur peut-il voir cet enregistrement selon sa portée ?
 * @param {object} [options] { ecriture: true } pour une modification : les sites en lecture seule sont exclus.
 * Le filtre de site courant (sélecteur de l'en-tête, `perms.siteFiltre`) s'applique en plus.
 */
function canSeeRecord(perms, user, record, options) {
  if (!record) return false;
  if (!perms) return true;
  const sid = record.secteurId == null || record.secteurId === '' ? null : Number(record.secteurId);
  if (sid != null && Array.isArray(perms.siteFiltre) && !perms.siteFiltre.includes(sid)) return false;
  if (perms.portee === 'tous') return true;
  const ecriture = !!(options && options.ecriture);
  const lecture = !ecriture && sid != null && Array.isArray(perms.secteurIdsLecture) && perms.secteurIdsLecture.includes(sid);
  if (perms.portee === 'secteurs' || perms.portee === 'site') {
    if (sid == null) return true; // élément non rattaché à un secteur
    // L'intervenant désigné d'un élément (OT, plan préventif) le voit même hors de ses secteurs, comme en portée « perso »
    return perms.secteurIds.includes(sid) || lecture || estIntervenant(record, user ? user.id : null);
  }
  // perso
  if (lecture) return true;
  const uid = user.id;
  for (const c of CHAMPS_PERSO) if (record[c] != null && Number(record[c]) === uid) return true;
  return estIntervenant(record, uid);
}

/** Applique le site choisi dans l'en-tête (« tous » ou id d'un site accessible). */
function appliquerSiteCourant(db, perms, valeur) {
  if (!perms || valeur == null || valeur === '' || valeur === 'tous') return perms;
  const id = Number(valeur);
  if (!perms.sites.some((s) => s.id === id)) return perms;
  perms.siteCourantId = id;
  perms.siteFiltre = secteursDescendants(db, [id]);
  return perms;
}

/** Un utilisateur peut-il gérer (modifier, désactiver) un autre utilisateur ? Règle hiérarchique. */
function canManageUser(actorPerms, targetProfil) {
  if (actorPerms.estAdmin) return true;
  if (!targetProfil) return true;
  if (targetProfil.estAdmin) return false;
  return actorPerms.niveau < Number(targetProfil.niveau || 99);
}

/** Rang des portées (une portée plus large a un rang plus élevé). */
const RANG_PORTEE = { perso: 1, secteurs: 2, site: 3, tous: 4 };

/**
 * Ce qu'un gestionnaire ne pourrait pas accorder lui-même sur ce compte : droits individuels (surcharges) qu'il ne
 * possède pas, portée individuelle plus large que la sienne, secteurs hors de son périmètre d'écriture, accès à un
 * site qu'il n'a pas (ou seulement en lecture pour un accès complet). Liste vide pour un administrateur.
 * Sert à refuser la réinitialisation du mot de passe ou de la double authentification d'un compte qui dépasse
 * ses propres droits (prise de contrôle du compte).
 */
function depassementsGestion(db, actorPerms, cible) {
  if (!actorPerms || actorPerms.estAdmin || !cible) return [];
  const out = [];
  const accordes = {};
  const ov = normaliserOverrides(cible.overrides);
  for (const m of Object.keys(ov)) for (const a of Object.keys(ov[m])) if (ov[m][a] === true) { accordes[m] = accordes[m] || {}; accordes[m][a] = true; }
  const manquants = droitsNonPossedes(actorPerms, accordes);
  if (manquants.length) out.push('droits individuels : ' + manquants.join(', '));
  if (cible.porteeOverride && PORTEES[cible.porteeOverride] && (RANG_PORTEE[cible.porteeOverride] || 0) > (RANG_PORTEE[actorPerms.portee] || 0)) {
    out.push('portée « ' + PORTEES[cible.porteeOverride] + ' »');
  }
  if (actorPerms.portee !== 'tous') {
    const ecriture = new Set((actorPerms.secteurIds || []).map(Number));
    const hors = (cible.secteurIds || []).map(Number).filter((id) => !ecriture.has(id));
    if (hors.length) out.push('secteurs hors de votre périmètre : ' + hors.map((id) => (db.get('secteurs', id) || {}).nom || '#' + id).join(', '));
    for (const a of normaliserSiteAcces(db, cible.siteAcces)) {
      const mien = (actorPerms.sites || []).find((x) => x.id === a.siteId);
      if (!mien || (a.mode === 'complet' && mien.mode !== 'complet')) out.push(`accès au site « ${(db.get('secteurs', a.siteId) || {}).nom || a.siteId} »`);
    }
  }
  return out;
}

/** Un utilisateur ne peut accorder que des droits qu'il possède lui-même (sauf administrateur). */
function droitsNonPossedes(actorPerms, matrice) {
  if (actorPerms.estAdmin) return [];
  const manquants = [];
  for (const m of MODULES) {
    const src = matrice && matrice[m.key];
    if (!src) continue;
    for (const a of m.actions) {
      if (src[a] === true && !can(actorPerms, m.key, a)) manquants.push(`${m.label} › ${ACTIONS[a] || a}`);
    }
  }
  return manquants;
}

module.exports = {
  ACTIONS, MODULES, PORTEES, MODES_SITE,
  sites, siteDuSecteur, normaliserSiteAcces, appliquerSiteCourant,
  moduleByKey, matriceVide, matricePleine, normaliserMatrice, normaliserOverrides,
  secteursDescendants, modulesConfigures, effectivePermissions, can, canSeeRecord,
  canManageUser, droitsNonPossedes, depassementsGestion,
};
