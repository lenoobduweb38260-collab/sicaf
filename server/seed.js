'use strict';
/**
 * Données par défaut : configuration, profils, secteurs, compte administrateur.
 * Idempotent : complète ce qui manque sans écraser les personnalisations.
 */
const { hashPassword } = require('./auth');
const { MODULES, matriceVide } = require('./permissions');

function configParDefaut() {
  const modules = {};
  for (const m of MODULES) modules[m.key] = { actif: true, label: '', ordre: m.ordre };
  return {
    societe: { nom: 'SICAF', slogan: 'Gestion de Maintenance Assistée par Ordinateur', logo: '', adresse: '', telephone: '', email: '' },
    general: {
      formatDate: 'dd/MM/yyyy',
      devise: '€',
      theme: 'clair',
      lignesParPage: 25,
      couleurPrincipale: '#2563eb',
      messageAccueil: '',
      heuresParJour: 8,
      tauxHoraire: 45,
    },
    securite: { longueurMinMdp: 4, forcerChangementMdpInitial: true, dureeSessionHeures: 12 },
    numerotation: { ot: 'OT-{annee}-{num:4}', di: 'DI-{annee}-{num:4}', eq: 'EQ-{num:4}', art: 'ART-{num:4}', pp: 'PP-{num:3}' },
    modules,
    profils: { triParSecteur: true, grouperParSecteur: true, afficherNiveau: true },
    utilisateurs: { triParSecteur: true, grouperParSecteur: false, afficherSuperieur: true },
    workflow: {
      validationDemandes: true,
      validerParSuperieurUniquement: false,
      otAutoDepuisDemande: true,
      cloturerDemandeAvecOt: true,
      notifierValidateurs: true,
      autoriserTechnicienCloture: true,
      stockNegatif: false,
    },
    preventif: { horizonJours: 30, genererAuto: true },
    listes: {
      statutsOT: [
        { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
        { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
        { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
        { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
        { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
      ],
      statutsDemande: [
        { code: 'soumise', label: 'Soumise', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'validee', label: 'Validée', couleur: '#2563eb', ordre: 2, final: false },
        { code: 'refusee', label: 'Refusée', couleur: '#dc2626', ordre: 3, final: true },
        { code: 'convertie', label: 'Convertie en OT', couleur: '#f59e0b', ordre: 4, final: false },
        { code: 'cloturee', label: 'Clôturée', couleur: '#16a34a', ordre: 5, final: true },
      ],
      typesIntervention: [
        { code: 'correctif', label: 'Correctif', couleur: '#dc2626', ordre: 1 },
        { code: 'preventif', label: 'Préventif', couleur: '#2563eb', ordre: 2 },
        { code: 'amelioration', label: 'Amélioration', couleur: '#16a34a', ordre: 3 },
        { code: 'reglementaire', label: 'Contrôle réglementaire', couleur: '#8b5cf6', ordre: 4 },
        { code: 'securite', label: 'Sécurité', couleur: '#f59e0b', ordre: 5 },
      ],
      priorites: [
        { code: 'basse', label: 'Basse', couleur: '#6b7280', ordre: 1, delaiHeures: 168 },
        { code: 'normale', label: 'Normale', couleur: '#2563eb', ordre: 2, delaiHeures: 72 },
        { code: 'haute', label: 'Haute', couleur: '#f59e0b', ordre: 3, delaiHeures: 24 },
        { code: 'urgente', label: 'Urgente', couleur: '#dc2626', ordre: 4, delaiHeures: 4 },
      ],
      typesEquipement: [
        { code: 'machine', label: 'Machine', ordre: 1 },
        { code: 'ligne', label: 'Ligne de production', ordre: 2 },
        { code: 'batiment', label: 'Bâtiment / Infrastructure', ordre: 3 },
        { code: 'vehicule', label: 'Véhicule', ordre: 4 },
        { code: 'outillage', label: 'Outillage', ordre: 5 },
        { code: 'instrument', label: 'Instrument de mesure', ordre: 6 },
        { code: 'autre', label: 'Autre', ordre: 7 },
      ],
      etatsEquipement: [
        { code: 'en_service', label: 'En service', couleur: '#16a34a', ordre: 1 },
        { code: 'degrade', label: 'Mode dégradé', couleur: '#f59e0b', ordre: 2 },
        { code: 'arret', label: 'À l\'arrêt', couleur: '#dc2626', ordre: 3 },
        { code: 'reforme', label: 'Réformé', couleur: '#6b7280', ordre: 4 },
      ],
      criticites: [
        { code: 'A', label: 'A - Critique', couleur: '#dc2626', ordre: 1 },
        { code: 'B', label: 'B - Important', couleur: '#f59e0b', ordre: 2 },
        { code: 'C', label: 'C - Secondaire', couleur: '#16a34a', ordre: 3 },
      ],
      unites: [
        { code: 'u', label: 'Unité', ordre: 1 },
        { code: 'm', label: 'Mètre', ordre: 2 },
        { code: 'kg', label: 'Kilogramme', ordre: 3 },
        { code: 'l', label: 'Litre', ordre: 4 },
        { code: 'h', label: 'Heure', ordre: 5 },
        { code: 'lot', label: 'Lot', ordre: 6 },
      ],
      categoriesArticles: [
        { code: 'mecanique', label: 'Mécanique', ordre: 1 },
        { code: 'electrique', label: 'Électrique', ordre: 2 },
        { code: 'pneumatique', label: 'Pneumatique', ordre: 3 },
        { code: 'hydraulique', label: 'Hydraulique', ordre: 4 },
        { code: 'consommable', label: 'Consommable', ordre: 5 },
        { code: 'lubrifiant', label: 'Lubrifiant', ordre: 6 },
        { code: 'autre', label: 'Autre', ordre: 7 },
      ],
      typesFournisseur: [
        { code: 'fournisseur', label: 'Fournisseur de pièces', ordre: 1 },
        { code: 'prestataire', label: 'Prestataire de services', ordre: 2 },
        { code: 'constructeur', label: 'Constructeur', ordre: 3 },
      ],
      causesPanne: [
        { code: 'usure', label: 'Usure', ordre: 1 },
        { code: 'casse', label: 'Casse', ordre: 2 },
        { code: 'electrique', label: 'Défaut électrique', ordre: 3 },
        { code: 'reglage', label: 'Déréglage', ordre: 4 },
        { code: 'erreur_humaine', label: 'Erreur humaine', ordre: 5 },
        { code: 'inconnue', label: 'Inconnue', ordre: 6 },
      ],
    },
    champsPersonnalises: { equipements: [], ot: [], demandes: [], articles: [], fournisseurs: [], utilisateurs: [] },
  };
}

/** Fusion profonde : les clés manquantes de `cible` sont complétées par `defaut`. */
function completer(cible, defaut) {
  if (Array.isArray(defaut)) return Array.isArray(cible) ? cible : defaut.slice();
  if (defaut && typeof defaut === 'object') {
    const out = (cible && typeof cible === 'object' && !Array.isArray(cible)) ? cible : {};
    for (const k of Object.keys(defaut)) out[k] = completer(out[k], defaut[k]);
    return out;
  }
  return cible === undefined || cible === null ? defaut : cible;
}

function profilsParDefaut() {
  const vide = () => matriceVide();
  const set = (m, mods) => { for (const k of Object.keys(mods)) for (const a of mods[k]) m[k][a] = true; return m; };
  const TOUT = (keys) => keys.reduce((o, k) => { o[k] = MODULES.find((m) => m.key === k).actions; return o; }, {});
  return [
    { nom: 'Administrateur', description: 'Accès complet à toute l\'application', niveau: 1, estAdmin: true, portee: 'tous', couleur: '#dc2626', permissions: vide(), systeme: true },
    {
      nom: 'Responsable maintenance', description: 'Pilote la maintenance : valide, affecte, clôture, gère le stock et le préventif', niveau: 2, estAdmin: false, portee: 'tous', couleur: '#2563eb', systeme: true,
      permissions: set(vide(), Object.assign(TOUT(['dashboard', 'equipements', 'demandes', 'ot', 'preventif', 'planning', 'stock', 'fournisseurs', 'rapports']), { utilisateurs: ['voir', 'creer', 'modifier'], profils: ['voir'], audit: ['voir', 'exporter'], configuration: ['voir'] })),
    },
    {
      nom: 'Chef de secteur', description: 'Valide les demandes et suit les interventions de son secteur', niveau: 3, estAdmin: false, portee: 'secteurs', couleur: '#8b5cf6', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], equipements: ['voir', 'modifier'], demandes: ['voir', 'creer', 'modifier', 'valider', 'exporter'], ot: ['voir', 'creer', 'modifier', 'affecter', 'cloturer', 'exporter'], preventif: ['voir'], planning: ['voir', 'modifier'], stock: ['voir'], fournisseurs: ['voir'], rapports: ['voir', 'exporter'], utilisateurs: ['voir'] }),
    },
    {
      nom: 'Technicien', description: 'Réalise les interventions et renseigne les comptes rendus', niveau: 4, estAdmin: false, portee: 'secteurs', couleur: '#16a34a', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], equipements: ['voir'], demandes: ['voir', 'creer'], ot: ['voir', 'creer', 'modifier', 'cloturer'], preventif: ['voir'], planning: ['voir'], stock: ['voir', 'modifier'], fournisseurs: ['voir'] }),
    },
    {
      nom: 'Demandeur', description: 'Signale les pannes et suit ses demandes', niveau: 5, estAdmin: false, portee: 'perso', couleur: '#6b7280', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], demandes: ['voir', 'creer', 'modifier'], equipements: ['voir'] }),
    },
  ];
}

function secteursParDefaut() {
  return [
    { nom: 'Production', code: 'PROD', couleur: '#2563eb', ordre: 1, parentId: null },
    { nom: 'Maintenance', code: 'MAINT', couleur: '#f59e0b', ordre: 2, parentId: null },
    { nom: 'Logistique', code: 'LOG', couleur: '#16a34a', ordre: 3, parentId: null },
    { nom: 'Qualité / Laboratoire', code: 'QUAL', couleur: '#8b5cf6', ordre: 4, parentId: null },
    { nom: 'Services généraux', code: 'SG', couleur: '#6b7280', ordre: 5, parentId: null },
  ];
}

/**
 * Initialise la base si nécessaire.
 * @param {Db} db
 * @param {{adminPassword?:string}} options
 */
function seed(db, options = {}) {
  // Configuration : complète les clés manquantes
  db.setConfig(completer(db.getConfig(), configParDefaut()));

  // Profils
  if (db.count('profils') === 0) {
    for (const p of profilsParDefaut()) db.insert('profils', Object.assign({ secteurId: null, actif: true }, p));
  }
  if (!db.findOne('profils', (p) => p.estAdmin)) {
    db.insert('profils', Object.assign({ secteurId: null, actif: true }, profilsParDefaut()[0]));
  }

  // Secteurs
  if (db.count('secteurs') === 0) {
    for (const s of secteursParDefaut()) db.insert('secteurs', Object.assign({ responsableId: null, actif: true, description: '' }, s));
  }

  // Compte administrateur initial
  if (db.count('users') === 0) {
    const admin = db.findOne('profils', (p) => p.estAdmin);
    db.insert('users', {
      login: 'admin',
      nom: 'Administrateur',
      prenom: '',
      email: '',
      telephone: '',
      fonction: 'Administrateur du système',
      passwordHash: hashPassword(options.adminPassword || 'admin'),
      profilId: admin.id,
      secteurIds: [],
      managerId: null,
      actif: true,
      overrides: {},
      porteeOverride: null,
      doitChangerMdp: true,
      preferences: { theme: 'clair' },
      derniereConnexion: null,
    });
  }
  db.saveNow();
}

module.exports = { seed, configParDefaut, profilsParDefaut, secteursParDefaut, completer };
