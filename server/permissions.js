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
  { key: 'demandes', label: "Demandes d'intervention", icon: 'demandes', ordre: 30, actions: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], description: 'Signalements et demandes avec circuit de validation' },
  { key: 'ot', label: 'Ordres de travail', icon: 'ot', ordre: 40, actions: ['voir', 'creer', 'modifier', 'supprimer', 'affecter', 'cloturer', 'exporter'], description: 'Interventions correctives, préventives et améliorations' },
  { key: 'preventif', label: 'Maintenance préventive', icon: 'preventif', ordre: 50, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Plans et gammes de maintenance périodiques' },
  { key: 'planning', label: 'Planning', icon: 'planning', ordre: 60, actions: ['voir', 'modifier'], description: 'Calendrier des interventions' },
  { key: 'stock', label: 'Stock & pièces', icon: 'stock', ordre: 70, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Pièces détachées, mouvements et alertes de stock' },
  { key: 'fournisseurs', label: 'Fournisseurs', icon: 'fournisseurs', ordre: 80, actions: ['voir', 'creer', 'modifier', 'supprimer', 'exporter'], description: 'Fournisseurs et prestataires externes' },
  { key: 'rapports', label: 'Rapports & historique', icon: 'rapports', ordre: 90, actions: ['voir', 'exporter'], description: 'Historique, statistiques et exports' },
  { key: 'utilisateurs', label: 'Utilisateurs', icon: 'utilisateurs', ordre: 100, actions: ['voir', 'creer', 'modifier', 'supprimer'], description: 'Comptes internes et hiérarchie' },
  { key: 'profils', label: 'Profils & droits', icon: 'profils', ordre: 110, actions: ['voir', 'creer', 'modifier', 'supprimer'], description: 'Profils, matrice des droits, secteurs' },
  { key: 'configuration', label: 'Configuration', icon: 'configuration', ordre: 120, actions: ['voir', 'modifier'], description: 'Paramètres, listes de valeurs, champs personnalisés, sauvegardes' },
  { key: 'audit', label: "Journal d'audit", icon: 'audit', ordre: 130, actions: ['voir', 'exporter'], description: 'Traçabilité des actions' },
];

const PORTEES = {
  tous: 'Toutes les données',
  secteurs: 'Ses secteurs uniquement (et sous-secteurs)',
  perso: 'Ses propres éléments uniquement',
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

  const portee = estAdmin ? 'tous' : ((user && user.porteeOverride) || (profil && profil.portee) || 'tous');
  const secteursBase = (user && Array.isArray(user.secteurIds)) ? user.secteurIds : [];
  const secteurIds = portee === 'tous' ? secteursDescendants(db, secteursBase) : secteursDescendants(db, secteursBase);

  return {
    modules,
    portee: PORTEES[portee] ? portee : 'tous',
    secteurIds,
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

/** L'utilisateur peut-il voir cet enregistrement selon sa portée ? */
function canSeeRecord(perms, user, record) {
  if (!record) return false;
  if (!perms || perms.portee === 'tous') return true;
  if (perms.portee === 'secteurs') {
    if (record.secteurId == null || record.secteurId === '') return true; // élément non rattaché à un secteur
    return perms.secteurIds.includes(Number(record.secteurId));
  }
  // perso
  const uid = user.id;
  for (const c of CHAMPS_PERSO) if (record[c] != null && Number(record[c]) === uid) return true;
  if (Array.isArray(record.techniciens) && record.techniciens.map(Number).includes(uid)) return true;
  return false;
}

/** Un utilisateur peut-il gérer (modifier, désactiver) un autre utilisateur ? Règle hiérarchique. */
function canManageUser(actorPerms, targetProfil) {
  if (actorPerms.estAdmin) return true;
  if (!targetProfil) return true;
  if (targetProfil.estAdmin) return false;
  return actorPerms.niveau < Number(targetProfil.niveau || 99);
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
  ACTIONS, MODULES, PORTEES,
  moduleByKey, matriceVide, matricePleine, normaliserMatrice, normaliserOverrides,
  secteursDescendants, modulesConfigures, effectivePermissions, can, canSeeRecord,
  canManageUser, droitsNonPossedes,
};
