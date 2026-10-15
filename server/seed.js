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
    securite: {
      longueurMinMdp: 10, complexite: true, refuserCourants: true, interdireIdentifiant: true, forcerChangementMdpInitial: true, dureeSessionHeures: 12, inactiviteMinutes: 60, notifierBlocages: true,
      // Double authentification : 'facultatif' | 'obligatoire_sensibles' (administrateurs, gestion du système, des utilisateurs, des profils, de la configuration) | 'obligatoire_tous'
      deuxFacteurs: 'facultatif',
      // Mot de passe oublié : demandes depuis l'écran de connexion, codes de réinitialisation à usage unique
      motDePasseOublie: true,
      dureeCodeReinitialisationMinutes: 60,
      // Réinitialisation par l'utilisateur lui-même avec un code de son application d'authentification
      reinitialisationAutonome: false,
      // Expiration du mot de passe (0 = jamais, sinon 30 à 730 jours) et rappel avant l'échéance
      expirationMdpJours: 0,
      rappelExpirationJours: 14,
      // Nombre de mots de passe précédents refusés (0 à 24)
      historiqueMdp: 5,
    },
    numerotation: { ot: 'OT-{annee}-{num:4}', di: 'DI-{annee}-{num:4}', eq: 'EQ-{num:4}', art: 'ART-{num:4}', pp: 'PP-{num:3}', inv: 'INV-{annee}-{num:3}', vis: 'VIS-{annee}-{num:3}', cmd: 'CMD-{annee}-{num:4}', fac: 'FAC-{annee}-{num:4}', pl: 'PL-{num:3}', mat: 'MAT-{num:4}' },
    etiquettes: {
      format: 'a4-3x7', symbologie: 'code128', hauteurCodeMm: 12, decalage: 0,
      contenu: { codeBarre: true, code: true, designation: true, emplacement: true, referenceFournisseur: false, unite: false, categorie: false, societe: true, prix: false, secteur: false },
      formatPersonnalise: { largeurMm: 63.5, hauteurMm: 38.1, colonnes: 3, lignes: 7, margeHautMm: 15.1, margeGaucheMm: 7.2, espaceHorizontalMm: 2.5, espaceVerticalMm: 0, pageLargeurMm: 210, pageHauteurMm: 297 },
    },
    inventaire: { aveugle: false, modeScan: 'quantite', sons: true, nonComptesAZero: false, scanGlobal: true },
    achats: { tauxTVA: 20, seuilValidationHT: 1000, delaiPaiementJours: 30, entreeStockAReception: true, alerteEcheanceJours: 7 },
    rh: { alerteJoursAvantEcheance: 60, afficherAbsencesPlanning: true, heuresHebdo: 35 },
    plans: { grilleM: 0.5, uniteAffichage: 'm', couleurParDefaut: 'etat', afficherEtiquettes: true },
    visites: {
      charteSecurite: 'Port des équipements de protection individuelle obligatoire dans les zones de production. Interdiction de photographier sans autorisation. Respect des cheminements piétons et des consignes de l\'accompagnateur. En cas d\'alarme, suivre l\'accompagnateur jusqu\'au point de rassemblement.',
      accompagnementObligatoire: true,
      rappelJoursAvant: 2,
      badgeAvecCodeBarre: true,
      demanderPieceIdentite: false,
      conserverVisiteursJours: 365,
    },
    reseau: { accesNavigateur: false, nomsAutorises: [] },
    journal: {
      notifications: true,
      profilsNotifies: null, // null = profils « Responsable maintenance » et « Pôle informatique » (renseigné au premier démarrage)
      actions: ['creation', 'suppression', 'desactivation', 'restauration', 'import', 'reinitialisation_mdp', 'demande_reinitialisation_mdp', 'recuperation_urgence'],
      entites: [],           // vide = toutes les entités
    },
    sauvegardes: {
      automatique: true, frequenceHeures: 24, heure: '22:00', conserverLocal: 30, compresser: true, chiffrer: false,
      destinations: [], cleReception: '', accepterReception: false,
    },
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
      typesVisite: [
        { code: 'audit_client', label: 'Audit client', couleur: '#2563eb', ordre: 1 },
        { code: 'audit_certification', label: 'Audit de certification (ISO, IFS, BRC…)', couleur: '#7c3aed', ordre: 2 },
        { code: 'audit_interne', label: 'Audit interne', couleur: '#0891b2', ordre: 3 },
        { code: 'inspection', label: 'Inspection (autorité, assureur, DREAL…)', couleur: '#dc2626', ordre: 4 },
        { code: 'visite_client', label: 'Visite client / prospect', couleur: '#16a34a', ordre: 5 },
        { code: 'visite_fournisseur', label: 'Visite fournisseur / prestataire', couleur: '#f59e0b', ordre: 6 },
        { code: 'visite_groupe', label: 'Visite de groupe (école, presse…)', couleur: '#6b7280', ordre: 7 },
      ],
      statutsVisite: [
        { code: 'planifiee', label: 'Planifiée', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'confirmee', label: 'Confirmée', couleur: '#2563eb', ordre: 2, final: false },
        { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
        { code: 'terminee', label: 'Terminée', couleur: '#16a34a', ordre: 4, final: true },
        { code: 'annulee', label: 'Annulée', couleur: '#dc2626', ordre: 5, final: true },
      ],
      typesConstat: [
        { code: 'nc_majeure', label: 'Non-conformité majeure', couleur: '#dc2626', ordre: 1 },
        { code: 'nc_mineure', label: 'Non-conformité mineure', couleur: '#f59e0b', ordre: 2 },
        { code: 'observation', label: 'Observation / remarque', couleur: '#2563eb', ordre: 3 },
        { code: 'piste_amelioration', label: 'Piste d\'amélioration', couleur: '#0891b2', ordre: 4 },
        { code: 'point_fort', label: 'Point fort', couleur: '#16a34a', ordre: 5 },
      ],
      statutsAction: [
        { code: 'a_faire', label: 'À faire', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 2, final: false },
        { code: 'realisee', label: 'Réalisée (à vérifier)', couleur: '#2563eb', ordre: 3, final: false },
        { code: 'verifiee', label: 'Vérifiée / efficace', couleur: '#16a34a', ordre: 4, final: true },
        { code: 'abandonnee', label: 'Abandonnée', couleur: '#9ca3af', ordre: 5, final: true },
      ],
      typesSecteur: [
        { code: 'site', label: 'Site / usine', couleur: '#0f766e', ordre: 1 },
        { code: 'batiment', label: 'Bâtiment', couleur: '#7c3aed', ordre: 2 },
        { code: 'service', label: 'Service', couleur: '#2563eb', ordre: 3 },
        { code: 'atelier', label: 'Atelier', couleur: '#f59e0b', ordre: 4 },
        { code: 'ligne', label: 'Ligne de production', couleur: '#16a34a', ordre: 5 },
        { code: 'zone', label: 'Zone', couleur: '#6b7280', ordre: 6 },
        { code: 'magasin', label: 'Magasin', couleur: '#0891b2', ordre: 7 },
      ],
      typesHabilitation: [
        { code: 'elec_b0', label: 'Habilitation électrique B0/H0V', couleur: '#f59e0b', ordre: 1, dureeMois: 36 },
        { code: 'elec_b1v', label: 'Habilitation électrique B1V', couleur: '#f59e0b', ordre: 2, dureeMois: 36 },
        { code: 'elec_b2v', label: 'Habilitation électrique B2V / BR / BC', couleur: '#f59e0b', ordre: 3, dureeMois: 36 },
        { code: 'elec_h1', label: 'Habilitation haute tension H1/H2', couleur: '#dc2626', ordre: 4, dureeMois: 36 },
        { code: 'caces_r489', label: 'CACES R489 (chariots élévateurs)', couleur: '#2563eb', ordre: 5, dureeMois: 60 },
        { code: 'caces_r486', label: 'CACES R486 (nacelles PEMP)', couleur: '#2563eb', ordre: 6, dureeMois: 60 },
        { code: 'travail_hauteur', label: 'Travail en hauteur / harnais', couleur: '#8b5cf6', ordre: 7, dureeMois: 36 },
        { code: 'atex', label: 'ATEX niveau 1 / 2', couleur: '#dc2626', ordre: 8, dureeMois: 36 },
        { code: 'sst', label: 'Sauveteur secouriste du travail (SST)', couleur: '#16a34a', ordre: 9, dureeMois: 24 },
        { code: 'permis_feu', label: 'Permis feu', couleur: '#dc2626', ordre: 10, dureeMois: 12 },
        { code: 'frigoriste', label: 'Attestation d\'aptitude fluides frigorigènes', couleur: '#0891b2', ordre: 11, dureeMois: 60 },
        { code: 'espaces_confines', label: 'Espaces confinés (CATEC)', couleur: '#6b7280', ordre: 12, dureeMois: 36 },
      ],
      typesAbsence: [
        { code: 'conges', label: 'Congés payés', couleur: '#16a34a', ordre: 1 },
        { code: 'rtt', label: 'RTT', couleur: '#0891b2', ordre: 2 },
        { code: 'maladie', label: 'Arrêt maladie', couleur: '#dc2626', ordre: 3 },
        { code: 'formation', label: 'Formation', couleur: '#8b5cf6', ordre: 4 },
        { code: 'accident', label: 'Accident du travail', couleur: '#b91c1c', ordre: 5 },
        { code: 'astreinte', label: 'Astreinte', couleur: '#f59e0b', ordre: 6 },
        { code: 'autre', label: 'Autre absence', couleur: '#6b7280', ordre: 7 },
      ],
      typesContrat: [
        { code: 'cdi', label: 'CDI', ordre: 1 }, { code: 'cdd', label: 'CDD', ordre: 2 }, { code: 'interim', label: 'Intérim', ordre: 3 },
        { code: 'apprentissage', label: 'Apprentissage / alternance', ordre: 4 }, { code: 'stage', label: 'Stage', ordre: 5 }, { code: 'prestataire', label: 'Prestataire externe', ordre: 6 },
      ],
      statutsCommande: [
        { code: 'brouillon', label: 'Brouillon', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'a_valider', label: 'À valider', couleur: '#f59e0b', ordre: 2, final: false },
        { code: 'validee', label: 'Validée', couleur: '#2563eb', ordre: 3, final: false },
        { code: 'envoyee', label: 'Envoyée au fournisseur', couleur: '#8b5cf6', ordre: 4, final: false },
        { code: 'partielle', label: 'Reçue partiellement', couleur: '#0891b2', ordre: 5, final: false },
        { code: 'recue', label: 'Reçue', couleur: '#16a34a', ordre: 6, final: true },
        { code: 'annulee', label: 'Annulée', couleur: '#dc2626', ordre: 7, final: true },
      ],
      statutsFacture: [
        { code: 'recue', label: 'Reçue / à contrôler', couleur: '#6b7280', ordre: 1, final: false },
        { code: 'a_valider', label: 'À valider', couleur: '#f59e0b', ordre: 2, final: false },
        { code: 'validee', label: 'Bon à payer', couleur: '#2563eb', ordre: 3, final: false },
        { code: 'payee', label: 'Payée', couleur: '#16a34a', ordre: 4, final: true },
        { code: 'litige', label: 'En litige', couleur: '#dc2626', ordre: 5, final: false },
        { code: 'annulee', label: 'Annulée / avoir', couleur: '#9ca3af', ordre: 6, final: true },
      ],
      categoriesDepense: [
        { code: 'pieces', label: 'Pièces détachées', couleur: '#2563eb', ordre: 1 },
        { code: 'sous_traitance', label: 'Sous-traitance / prestations', couleur: '#8b5cf6', ordre: 2 },
        { code: 'interim', label: 'Intérim / personnel extérieur', couleur: '#f59e0b', ordre: 3 },
        { code: 'formation', label: 'Formation', couleur: '#16a34a', ordre: 4 },
        { code: 'outillage', label: 'Outillage / EPI', couleur: '#0891b2', ordre: 5 },
        { code: 'controle', label: 'Contrôles réglementaires', couleur: '#dc2626', ordre: 6 },
        { code: 'investissement', label: 'Investissement', couleur: '#7c3aed', ordre: 7 },
        { code: 'autre', label: 'Autre', couleur: '#6b7280', ordre: 8 },
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
    champsPersonnalises: { equipements: [], ot: [], demandes: [], articles: [], fournisseurs: [], utilisateurs: [], personnel: [], commandes: [], factures: [], visites: [] },
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
      nom: 'Pôle informatique', description: 'Gère les comptes, les profils, la base de données, les sauvegardes, le réseau et les mises à jour', niveau: 1, estAdmin: false, portee: 'tous', couleur: '#0f766e', systeme: true,
      permissions: set(vide(), Object.assign(TOUT(['utilisateurs', 'profils', 'configuration', 'systeme', 'audit']), { dashboard: ['voir'] })),
    },
    {
      nom: 'Responsable maintenance', description: 'Pilote la maintenance : valide, affecte, clôture, gère le stock et le préventif', niveau: 2, estAdmin: false, portee: 'tous', couleur: '#2563eb', systeme: true,
      permissions: set(vide(), Object.assign(TOUT(['dashboard', 'equipements', 'plans', 'demandes', 'ot', 'preventif', 'planning', 'stock', 'inventaire', 'fournisseurs', 'rapports']), { achats: ['voir', 'creer', 'modifier', 'valider', 'exporter'], rh: ['voir', 'creer', 'modifier', 'valider', 'exporter'], visites: ['voir', 'creer', 'modifier', 'exporter'], utilisateurs: ['voir'], profils: ['voir'], audit: ['voir', 'exporter'], configuration: ['voir'] })),
    },
    {
      nom: 'Chef de secteur', description: 'Valide les demandes et suit les interventions de son secteur', niveau: 3, estAdmin: false, portee: 'secteurs', couleur: '#8b5cf6', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], equipements: ['voir', 'modifier'], demandes: ['voir', 'creer', 'modifier', 'valider', 'exporter'], ot: ['voir', 'creer', 'modifier', 'affecter', 'cloturer', 'exporter'], preventif: ['voir'], planning: ['voir', 'modifier'], stock: ['voir'], fournisseurs: ['voir'], rapports: ['voir', 'exporter'], utilisateurs: ['voir'], plans: ['voir'], inventaire: ['voir'], achats: ['voir', 'creer'], rh: ['voir'], visites: ['voir', 'modifier'] }),
    },
    {
      nom: 'Technicien', description: 'Réalise les interventions et renseigne les comptes rendus', niveau: 4, estAdmin: false, portee: 'secteurs', couleur: '#16a34a', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], equipements: ['voir'], demandes: ['voir', 'creer'], ot: ['voir', 'creer', 'modifier', 'cloturer'], preventif: ['voir'], planning: ['voir'], stock: ['voir', 'modifier'], fournisseurs: ['voir'], plans: ['voir'], inventaire: ['voir', 'modifier'] }),
    },
    {
      nom: 'Demandeur', description: 'Signale les pannes et suit ses demandes', niveau: 5, estAdmin: false, portee: 'perso', couleur: '#6b7280', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], demandes: ['voir', 'creer', 'modifier'], equipements: ['voir'], plans: ['voir'] }),
    },
    {
      nom: 'Responsable qualité', description: 'Organise les audits clients, certifications et visites du site ; suit les constats et les plans d\'actions', niveau: 2, estAdmin: false, portee: 'site', couleur: '#7c3aed', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], visites: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], demandes: ['voir', 'creer'], ot: ['voir'], equipements: ['voir'], plans: ['voir'], rapports: ['voir', 'exporter'], fournisseurs: ['voir'], rh: ['voir'], audit: ['voir'] }),
    },
    {
      nom: 'Gestionnaire RH', description: 'Suit le personnel : contrats, habilitations, formations, visites médicales, absences', niveau: 3, estAdmin: false, portee: 'site', couleur: '#db2777', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], rh: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], utilisateurs: ['voir'], planning: ['voir'], rapports: ['voir'] }),
    },
    {
      nom: 'Acheteur / comptabilité', description: 'Gère les commandes fournisseurs, les réceptions et les factures', niveau: 4, estAdmin: false, portee: 'site', couleur: '#ca8a04', systeme: true,
      permissions: set(vide(), { dashboard: ['voir'], achats: ['voir', 'creer', 'modifier', 'supprimer', 'valider', 'exporter'], fournisseurs: ['voir', 'creer', 'modifier', 'exporter'], stock: ['voir', 'exporter'], ot: ['voir'], rapports: ['voir', 'exporter'] }),
    },
  ];
}

/** Site par défaut (racine) et ses services ; `parentCode` désigne le parent par son code. */
function secteursParDefaut() {
  return [
    { nom: 'Site principal', code: 'SITE', type: 'site', couleur: '#0f766e', ordre: 1, parentCode: null, description: 'Renommez ce site (ex. « Usine de Carpentras ») et ajoutez vos autres sites dans Configuration › Secteurs & sites.' },
    { nom: 'Production', code: 'PROD', type: 'service', couleur: '#2563eb', ordre: 1, parentCode: 'SITE' },
    { nom: 'Maintenance', code: 'MAINT', type: 'service', couleur: '#f59e0b', ordre: 2, parentCode: 'SITE' },
    { nom: 'Logistique', code: 'LOG', type: 'service', couleur: '#16a34a', ordre: 3, parentCode: 'SITE' },
    { nom: 'Qualité / Laboratoire', code: 'QUAL', type: 'service', couleur: '#8b5cf6', ordre: 4, parentCode: 'SITE' },
    { nom: 'Services généraux', code: 'SG', type: 'service', couleur: '#6b7280', ordre: 5, parentCode: 'SITE' },
  ];
}

/**
 * Migration douce des profils fournis par défaut : ajoute les droits des modules apparus
 * depuis leur création (ex. Plans 3D, Inventaire, Achats, RH) sans toucher aux droits existants.
 */
function migrerProfilsSysteme(db) {
  const defauts = new Map(profilsParDefaut().map((p) => [p.nom, p]));
  // Bases antérieures : création du profil « Pôle informatique » si personne ne gère le système
  const it = defauts.get('Pôle informatique');
  if (it && !db.findOne('profils', (p) => p.nom === it.nom) && !db.findOne('profils', (p) => !p.estAdmin && p.permissions && p.permissions.systeme && p.permissions.systeme.modifier)) {
    db.insert('profils', Object.assign({ secteurId: null, actif: true }, it));
  }
  for (const p of db.list('profils', (x) => x.systeme && !x.estAdmin)) {
    const def = defauts.get(p.nom);
    if (!def) continue;
    const perms = Object.assign({}, p.permissions || {});
    let change = false;
    for (const m of MODULES) {
      if (perms[m.key] === undefined) { perms[m.key] = Object.assign({}, def.permissions[m.key]); change = true; }
    }
    if (change) db.update('profils', p.id, { permissions: perms });
  }
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
  migrerProfilsSysteme(db);

  // Journal d'activité : destinataires des notifications par défaut (rôles responsables)
  const cfgJ = db.getConfig();
  if (cfgJ.journal && !Array.isArray(cfgJ.journal.profilsNotifies)) {
    cfgJ.journal.profilsNotifies = db.list('profils', (p) => ['Responsable maintenance', 'Pôle informatique'].includes(p.nom)).map((p) => p.id);
    db.setConfig(cfgJ);
  }
  // Bases antérieures : si les réinitialisations de mot de passe sont notifiées, les demandes de réinitialisation
  // et les récupérations d'urgence le sont aussi (une seule fois : un retrait ultérieur est respecté)
  const migrations = db.data.meta.migrations = db.data.meta.migrations || {};
  if (!migrations.journalMotsDePasse) {
    const cfgM = db.getConfig();
    const actions = cfgM.journal && Array.isArray(cfgM.journal.actions) ? cfgM.journal.actions : null;
    if (actions && actions.includes('reinitialisation_mdp')) {
      for (const a of ['demande_reinitialisation_mdp', 'recuperation_urgence']) if (!actions.includes(a)) actions.push(a);
      db.setConfig(cfgM);
    }
    migrations.journalMotsDePasse = true;
    db.touch();
  }

  // Secteurs : un site principal et ses services
  if (db.count('secteurs') === 0) {
    const ids = {};
    for (const { parentCode, ...s } of secteursParDefaut()) {
      const cree = db.insert('secteurs', Object.assign({ responsableId: null, actif: true, description: '' }, s, { parentId: parentCode ? ids[parentCode] : null }));
      ids[s.code] = cree.id;
    }
  }
  // Secteurs sans type (bases antérieures) : racines = sites, autres = services
  for (const s of db.list('secteurs', (x) => !x.type)) db.update('secteurs', s.id, { type: s.parentId == null ? 'site' : 'service' });

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
      siteAcces: [],
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
