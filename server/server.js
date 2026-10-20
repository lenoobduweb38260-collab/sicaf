'use strict';
/**
 * Serveur HTTP de la GMAO : fichiers statiques du client + API JSON.
 * Aucune dépendance externe (modules Node intégrés uniquement).
 */
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Db } = require('./db');
const { Router, HttpError } = require('./router');
const csv = require('./csv');
const auth = require('./auth');
const totp = require('./totp');
const perms = require('./permissions');
const { seed, MODES_DEUX_FACTEURS } = require('./seed');
const { loadModules } = require('./modules');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf',
};
const MAX_BODY = 25 * 1024 * 1024; // 25 Mo (logos, pièces jointes en base64)
/** Quota global des pièces jointes (Mo, base64 compris) : défaut et bornes de config.general.quotaPiecesJointesMo. */
const QUOTA_PIECES_DEFAUT_MO = 400;
const QUOTA_PIECES_MIN_MO = 50;
const QUOTA_PIECES_MAX_MO = 4000;
const AUDIT_MAX = 5000;
const NOTIF_MAX = 2000;

function readBody(req, max) {
  const limite = max || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limite) { reject(new HttpError(413, 'Requête trop volumineuse')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * En-têtes de sécurité appliqués à toutes les réponses.
 * CSP : aucun script externe ni en ligne, aucune intégration de la GMAO dans une page tierce.
 */
const POLITIQUE_CONTENU = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "object-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
function entetesSecurite(res) {
  res.setHeader('Content-Security-Policy', POLITIQUE_CONTENU);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
}

/**
 * Filet de sécurité : empreintes de mot de passe (actuel et précédents) et codes de réinitialisation ne quittent
 * jamais le serveur, même si une route renvoyait un compte utilisateur complet par erreur. Seules les valeurs de
 * la forme d'un compte sont retirées (le réglage numérique securite.historiqueMdp reste transmis).
 */
const MARQUEURS_SECRETS = ['"passwordHash":"', '"historiqueMdp":[', '"reinitialisation":{'];
const sansSecrets = (k, v) => ((k === 'passwordHash' && typeof v === 'string') || (k === 'historiqueMdp' && Array.isArray(v))
  || (k === 'reinitialisation' && typeof v === 'object') ? undefined : v);

function sendJson(res, status, data) {
  let body = JSON.stringify(data === undefined ? null : data);
  if (MARQUEURS_SECRETS.some((m) => body.includes(m))) body = JSON.stringify(data, sansSecrets);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Lecture JSON sans clés dangereuses (pollution de prototype). */
function analyserJson(texte) {
  return JSON.parse(texte, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
}

/**
 * Crée l'application.
 * @param {{dataDir?:string, inMemory?:boolean, adminPassword?:string, log?:Function}} options
 */
function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.GMAO_DATA_DIR || path.join(__dirname, '..', 'data');
  const log = options.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const db = new Db(dataDir, { inMemory: !!options.inMemory, saveDelay: options.saveDelay, log }).load();
  seed(db, { adminPassword: options.adminPassword });

  /**
   * Configuration figée : copie profonde gelée de db.data.config, recalculée seulement quand la base remplace
   * sa configuration (db.setConfig, import, restauration). Les lectures du cœur et des modules (ctx.config(),
   * ctx.liste(), permissions, notifications du journal) n'ont ainsi plus à recopier toute la configuration
   * (logo en base64 compris) à chaque appel ; une modification de la copie lève une erreur au lieu de la corrompre.
   */
  let configFigee = null;
  let configSource = null;
  function gelerProfond(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) gelerProfond(v); }
    return o;
  }
  function configCourante() {
    const source = db.data.config || {};
    if (!configFigee || configSource !== source) { configFigee = gelerProfond(JSON.parse(JSON.stringify(source))); configSource = source; }
    return configFigee;
  }
  const sec = () => (configCourante().securite || {});
  const sessions = new auth.Sessions({
    inactiviteMs: () => Math.max(5, Number(sec().inactiviteMinutes) || 60) * 60 * 1000,
    dureeMaxMs: () => Math.max(1, Number(sec().dureeSessionHeures) || 12) * 60 * 60 * 1000,
  });
  const router = new Router();
  const hooks = {}; // événements inter-modules : ctx.on('ot:cree', fn) / ctx.emit('ot:cree', data)
  const arrets = []; // fonctions appelées à l'arrêt du serveur (minuteurs des modules)

  /**
   * Entrées les plus anciennes du journal d'activité (au-delà de AUDIT_MAX) : archivées dans
   * <données>/journal/audit-AAAA-MM.jsonl (une ligne JSON par entrée) au lieu d'être perdues.
   */
  function archiverJournal(entrees) {
    if (db.inMemory || !entrees.length) return;
    try {
      const dossier = path.join(dataDir, 'journal');
      fs.mkdirSync(dossier, { recursive: true });
      const parMois = new Map();
      for (const e of entrees) {
        const mois = String(e.date || '').slice(0, 7);
        const cle = /^\d{4}-\d{2}$/.test(mois) ? mois : 'divers';
        if (!parMois.has(cle)) parMois.set(cle, []);
        parMois.get(cle).push(JSON.stringify(e));
      }
      for (const [mois, lignes] of parMois) fs.appendFileSync(path.join(dossier, `audit-${mois}.jsonl`), lignes.join('\n') + '\n', 'utf8');
    } catch (e) { log('Archivage du journal d\'activité impossible :', e.message); }
  }

  const ctx = {
    db, router, sessions, perms, auth, HttpError, log, dataDir,
    /** Vrai quand le serveur tourne dans l'application de bureau (accès navigateur contrôlé). */
    bureau: !!options.bureau,
    clientDir: CLIENT_DIR,
    version: require('../package.json').version,
    /** Empreinte SHA-256 du certificat du serveur (HTTPS), vide en HTTP : affichée aux postes pour confirmation. */
    empreinteCertificat: (() => { try { return options.tls && options.tls.cert ? require('./tls').empreinte(options.tls.cert) : ''; } catch (e) { return ''; } })(),
    /** Services publiés par les modules (ex. ctx.services.stock.sortir), consultés au moment des requêtes. */
    services: {},

    /** Fonction appelée à l'arrêt du serveur (app.stop()) : les modules y arrêtent leurs minuteurs. */
    onArret(fn) { if (typeof fn === 'function') arrets.push(fn); },

    /** Configuration courante : copie figée (lecture seule, partagée entre les appels ; db.getConfig() pour une copie modifiable). */
    config() { return configCourante(); },

    /** Cellule CSV (guillemets, formules de tableur neutralisées) : même règle pour tous les exports (server/csv.js). */
    csvEscape: csv.csvEscape,

    /** Liste de valeurs configurée (ex. 'statutsOT') : copie triée de cette seule liste (éléments modifiables). */
    liste(nom) {
      const l = (configCourante().listes || {})[nom];
      return Array.isArray(l) ? l.map((x) => Object.assign({}, x)).sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
    },

    /** Vérifie une permission, lève 403 sinon. */
    requirePerm(req, module, action) {
      if (!req.perms || !perms.can(req.perms, module, action)) {
        const m = perms.moduleByKey(module);
        throw new HttpError(403, `Droit insuffisant : ${m ? m.label : module} › ${perms.ACTIONS[action] || action}`);
      }
    },

    /**
     * L'utilisateur courant peut-il voir cet enregistrement (portée, site courant) ?
     * Pendant une requête de modification (POST/PUT/PATCH/DELETE), les sites accessibles
     * en lecture seule sont exclus.
     */
    canSee(req, record) { return perms.canSeeRecord(req.perms, req.user, record, { ecriture: !!req.ecriture }); },

    /** Filtre une liste selon la portée de l'utilisateur (et le site courant). */
    scope(req, rows) { const o = { ecriture: !!req.ecriture }; return (rows || []).filter((r) => perms.canSeeRecord(req.perms, req.user, r, o)); },

    /** Récupère un enregistrement visible ou lève 404 (403 si le site n'est accessible qu'en lecture). */
    getVisible(req, collection, id) {
      const rec = db.get(collection, id);
      if (!rec) throw new HttpError(404, 'Élément introuvable');
      if (perms.canSeeRecord(req.perms, req.user, rec, { ecriture: !!req.ecriture })) return rec;
      if (req.ecriture && perms.canSeeRecord(req.perms, req.user, rec)) {
        throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
      }
      throw new HttpError(404, 'Élément introuvable');
    },

    /** Site (secteur de type « site ») d'un secteur, ou null. */
    siteDuSecteur(secteurId) { return perms.siteDuSecteur(db, secteurId); },

    /**
     * Un compte utilisateur est-il visible par un lecteur (droits `droits`) ? Soi-même, un compte rattaché à
     * aucun secteur ou partageant un secteur accessible (en modification, les sites en lecture seule sont
     * exclus) ; le site choisi dans l'en-tête (droits.siteFiltre) filtre en plus.
     */
    utilisateurVisible(lecteur, droits, u, ecriture) {
      if (!u || !lecteur || !droits) return false;
      if (u.id === lecteur.id) return true;
      const ids = (u.secteurIds || []).map(Number);
      if (droits.portee !== 'tous') {
        const accessibles = new Set(ecriture ? droits.secteurIds : droits.secteurIds.concat(droits.secteurIdsLecture || []));
        if (ids.length && !ids.some((s) => accessibles.has(s))) return false;
      }
      if (droits.siteFiltre) {
        const site = new Set(droits.siteFiltre);
        if (ids.length && !ids.some((x) => site.has(x)) && !(u.siteAcces || []).some((a) => site.has(Number(a.siteId)))) return false;
      }
      return true;
    },

    /**
     * Journal d'audit. `options.notifier === false` : pas de notification des rôles responsables
     * (ex. demande anonyme pour un identifiant inconnu).
     */
    audit(req, action, entite, entiteId, details, options) {
      const col = db.data.collections.audit;
      col.push({
        id: db.nextId('audit'),
        date: new Date().toISOString(),
        userId: req && req.user ? req.user.id : null,
        // Requête sans compte (connexion, mot de passe oublié, autre site) : « Non connecté » ; tâche automatique : « Système »
        userNom: req && req.user ? `${req.user.prenom || ''} ${req.user.nom || ''}`.trim() || req.user.login : (req && req.socket ? 'Non connecté' : 'Système'),
        action, entite, entiteId: entiteId == null ? null : entiteId,
        details: details == null ? '' : (typeof details === 'string' ? details : JSON.stringify(details)),
        ip: req && req.socket ? req.socket.remoteAddress : '',
      });
      if (col.length > AUDIT_MAX) archiverJournal(col.splice(0, col.length - AUDIT_MAX));
      db.touch();
      if (options && options.notifier === false) return;
      try { notifierJournal(req, action, entite, entiteId, details); } catch (e) { log('Notification du journal impossible', e.message); }
    },

    /** Notification interne pour un ou plusieurs utilisateurs. */
    notify(userIds, { titre, message, lien, type }) {
      const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x) => x != null).map(Number)));
      const col = db.data.collections.notifications;
      for (const uid of ids) {
        col.push({ id: db.nextId('notifications'), userId: uid, titre: titre || '', message: message || '', lien: lien || '', type: type || 'info', lu: false, date: new Date().toISOString() });
      }
      if (col.length > NOTIF_MAX) {
        // Les notifications déjà lues partent les premières : une rafale d'alertes n'efface pas celles des autres
        let enTrop = col.length - NOTIF_MAX;
        const garder = col.filter((n) => { if (enTrop > 0 && n.lu) { enTrop -= 1; return false; } return true; });
        if (enTrop > 0) garder.splice(0, enTrop);
        col.splice(0, col.length, ...garder);
      }
      if (ids.length) db.touch();
    },

    /** Utilisateurs possédant une permission donnée (actifs). */
    usersAvecDroit(module, action, filtre) {
      const config = configCourante();
      return db.list('users', (u) => u.actif !== false).filter((u) => {
        const p = perms.effectivePermissions(db, u, null, config);
        if (!perms.can(p, module, action)) return false;
        return filtre ? filtre(u, p) : true;
      });
    },

    /** Validation d'un code de liste de valeurs (retourne le code ou le premier code par défaut). */
    codeListe(nom, code, obligatoire) {
      const l = ctx.liste(nom);
      if (code != null && code !== '' && l.some((x) => x.code === code)) return code;
      if (obligatoire === false) return code == null ? null : (code === '' ? null : code);
      return l.length ? l[0].code : null;
    },

    /** Valide et nettoie les champs personnalisés d'une entité. */
    champsPerso(entite, input) {
      const defs = ((configCourante().champsPersonnalises || {})[entite]) || [];
      const out = {};
      const src = input && typeof input === 'object' ? input : {};
      for (const d of defs) {
        let v = src[d.cle];
        if (v === undefined || v === null || v === '') {
          if (d.obligatoire) throw new HttpError(400, `Le champ « ${d.label} » est obligatoire`);
          out[d.cle] = null;
          continue;
        }
        if (d.type === 'nombre') { v = Number(v); if (Number.isNaN(v)) throw new HttpError(400, `Le champ « ${d.label} » doit être un nombre`); }
        else if (d.type === 'booleen') v = !!v;
        else if (d.type === 'liste') { if (!(d.options || []).includes(v)) throw new HttpError(400, `Valeur invalide pour « ${d.label} »`); }
        else v = String(v);
        out[d.cle] = v;
      }
      return out;
    },

    on(event, fn) { (hooks[event] = hooks[event] || []).push(fn); },
    emit(event, data) { for (const fn of hooks[event] || []) { try { fn(data); } catch (e) { log('Erreur hook', event, e.message); } } },

    /** Nom affichable d'un utilisateur. */
    nomUser(id) {
      const u = id == null ? null : db.get('users', id);
      return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '';
    },
  };

  /**
   * Journal d'activité → notification des rôles responsables (config.journal) : les événements
   * semblables (même action, même entité) sont regroupés dans une notification non lue de moins de 15 min.
   */
  const LIBELLES_ACTION = {
    creation: 'Création', modification: 'Modification', suppression: 'Suppression', desactivation: 'Désactivation', duplication: 'Duplication',
    validation: 'Validation', validee: 'Validation', refus: 'Refus', cloture: 'Clôture', reouverture: 'Réouverture', affectation: 'Affectation',
    statut: 'Changement de statut', etat: 'Changement d\'état', conversion: 'Conversion en OT', convertir: 'Conversion en OT', generation: 'Génération',
    mouvement: 'Mouvement de stock', compteur: 'Relevé de compteur', document: 'Document', commentaire: 'Commentaire', temps: 'Temps passé', pieces: 'Pièces',
    export: 'Export', import: 'Import de données', sauvegarde: 'Sauvegarde', restauration: 'Restauration', reception: 'Réception d\'une sauvegarde',
    purge: 'Purge', renouvellement: 'Renouvellement', retablissement: 'Rétablissement des valeurs par défaut', demo: 'Données de démonstration',
    connexion: 'Connexion', deconnexion: 'Déconnexion forcée', echec_connexion: 'Échec de connexion', blocage: 'Blocage temporaire',
    changement_mdp: 'Changement de mot de passe', reinitialisation_mdp: 'Réinitialisation de mot de passe', echec_confirmation: 'Confirmation incorrecte',
    activation_double_auth: 'Activation de la double authentification', desactivation_double_auth: 'Désactivation de la double authentification',
    reinitialisation_double_auth: 'Réinitialisation de la double authentification', codes_secours: 'Nouveaux codes de secours', echec_double_auth: 'Code de vérification incorrect',
    demande_reinitialisation_mdp: 'Demande de réinitialisation de mot de passe', rejet_demande_reinitialisation_mdp: 'Demande de réinitialisation refusée',
    code_reinitialisation_mdp: 'Code de réinitialisation de mot de passe', annulation_code_reinitialisation: 'Annulation d\'un code de réinitialisation',
    echec_reinitialisation_mdp: 'Code de réinitialisation incorrect', reinitialisation_mdp_code: 'Mot de passe réinitialisé avec un code',
    reinitialisation_mdp_autonome: 'Mot de passe réinitialisé avec l\'application d\'authentification', recuperation_urgence: 'Récupération d\'urgence d\'un compte',
    expiration_mdp: 'Mot de passe expiré',
  };
  /** Libellés des actions du journal (repris par la vue Journal d'activité via GET /api/audit). */
  ctx.libellesActions = LIBELLES_ACTION;
  const LIBELLES_ENTITE = {
    users: 'Utilisateurs', profils: 'Profils', secteurs: 'Secteurs & sites', configuration: 'Configuration', systeme: 'Système', equipements: 'Équipements',
    demandes: 'Demandes', ot: 'Ordres de travail', plansPreventifs: 'Préventif', preventif: 'Préventif', planning: 'Planning', articles: 'Stock', stock: 'Stock',
    mouvementsStock: 'Mouvements de stock', fournisseurs: 'Fournisseurs', plans: 'Plans 3D', inventaires: 'Inventaires', inventaire: 'Étiquettes & inventaire',
    achats: 'Achats & factures', commandes: 'Commandes fournisseurs', factures: 'Factures fournisseurs', rh: 'Ressources humaines', personnel: 'Personnel',
    habilitations: 'Habilitations', formations: 'Formations', visitesMedicales: 'Visites médicales', absences: 'Absences', visites: 'Audits & visites',
    sauvegardes: 'Sauvegardes', sauvegardesHistorique: 'Sauvegardes', rapports: 'Rapports', dashboard: 'Tableau de bord', audit: 'Journal d\'activité',
  };
  /** Libellés des éléments du journal (repris par la vue Journal d'activité via GET /api/audit). */
  ctx.libellesEntites = LIBELLES_ENTITE;
  function notifierJournal(req, action, entite, entiteId, details) {
    const j = configCourante().journal || {};
    if (!j.notifications || !Array.isArray(j.actions) || !j.actions.includes(action)) return;
    if (Array.isArray(j.entites) && j.entites.length && !j.entites.includes(entite)) return;
    const profils = new Set((j.profilsNotifies || []).map(Number));
    if (!profils.size) return;
    const auteurId = req && req.user ? req.user.id : null;
    const auteur = req && req.user ? (`${req.user.prenom || ''} ${req.user.nom || ''}`.trim() || req.user.login) : (req && req.socket ? 'Non connecté' : 'Système');
    // Destinataires : profils choisis, mais seulement les comptes qui ont accès au Journal d'activité (le texte en
    // reprend les détails) et qui peuvent voir l'élément concerné (portée, sites)
    const config = configCourante();
    const element = entiteId != null && Array.isArray(db.data.collections[entite]) ? db.get(entite, entiteId) : null;
    const dest = db.list('users', (u) => u.actif !== false && profils.has(Number(u.profilId)) && u.id !== auteurId).filter((u) => {
      const p = perms.effectivePermissions(db, u, null, config);
      return perms.can(p, 'audit', 'voir') && (!element || perms.canSeeRecord(p, u, element));
    });
    if (!dest.length) return;
    const titre = `${LIBELLES_ACTION[action] || action} — ${LIBELLES_ENTITE[entite] || entite}`;
    const texte = `${auteur} : ${String(details || (entiteId != null ? '#' + entiteId : '')).slice(0, 160)}`;
    const cle = `journal:${action}:${entite}`;
    const limite = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const col = db.data.collections.notifications;
    const nouveaux = [];
    for (const u of dest) {
      const existante = col.find((n) => n.userId === u.id && n.cle === cle && !n.lu && n.date >= limite);
      if (existante) {
        existante.nombre = (existante.nombre || 1) + 1;
        existante.titre = `${titre} (${existante.nombre})`;
        existante.message = texte;
        existante.date = new Date().toISOString();
        db.touch();
      } else nouveaux.push(u.id);
    }
    if (nouveaux.length) {
      ctx.notify(nouveaux, { titre, message: texte, lien: `#/audit?entite=${encodeURIComponent(entite)}&action=${encodeURIComponent(action)}`, type: 'journal' });
      for (const n of col.slice(-nouveaux.length)) { n.cle = cle; n.nombre = 1; }
    }
  }

  // ----- Routes cœur : authentification & amorçage -------------------------
  registerCoreRoutes(ctx);
  loadModules(ctx);

  // Écriture de la base impossible (disque plein, droits…) : le serveur continue avec les données en mémoire,
  // retente l'écriture et prévient le pôle informatique (au plus une fois par heure).
  let derniereAlerteEcriture = 0;
  db.onErreurEcriture = (e) => {
    if (Date.now() - derniereAlerteEcriture < 60 * 60 * 1000) return;
    derniereAlerteEcriture = Date.now();
    const ids = ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id);
    ctx.notify(ids, { titre: 'Enregistrement des données impossible', message: `Les dernières modifications n'ont pas pu être écrites sur le disque du serveur (${String((e && e.code) || (e && e.message) || 'erreur').slice(0, 80)}). Elles sont conservées en mémoire et l'écriture est retentée automatiquement : vérifiez l'espace disque et les droits du dossier des données, et ne fermez pas le serveur avant le retour à la normale.`, lien: '#/systeme', type: 'alerte' });
  };

  // Nettoyage périodique des sessions, des connexions en deux étapes inachevées, des codes de réinitialisation
  // expirés et des anciennes demandes de réinitialisation
  ctx.motsDePasse.purger();
  const sweeper = setInterval(() => { sessions.sweep(); ctx.deuxFacteurs.purger(); ctx.motsDePasse.purger(); }, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  /**
   * Quota global des pièces jointes (config.general.quotaPiecesJointesMo) : les photos et documents sont gardés en
   * mémoire par le serveur et repris dans chaque sauvegarde ; au-delà du quota, les nouvelles pièces sont refusées.
   */
  function verifierQuotaPieces(corpsRequete) {
    if (!corpsRequete || typeof corpsRequete !== 'object' || Buffer.isBuffer(corpsRequete)) return;
    const ajout = db.taillePiecesNouvelles(corpsRequete);
    if (!ajout) return;
    const mo = Math.min(QUOTA_PIECES_MAX_MO, Math.max(QUOTA_PIECES_MIN_MO, Number(((db.data.config || {}).general || {}).quotaPiecesJointesMo) || QUOTA_PIECES_DEFAUT_MO));
    const actuel = db.taillePieces();
    if (actuel + ajout <= mo * 1024 * 1024) return;
    const enMo = (n) => Math.round(n / (1024 * 1024));
    throw new HttpError(413, `Espace réservé aux pièces jointes plein (${enMo(actuel)} Mo utilisés sur ${mo} Mo) : supprimez des pièces jointes devenues inutiles ou demandez au pôle informatique d'augmenter la limite (Configuration › Général).`);
  }

  async function handleApi(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Route inconnue : ' + req.method + ' ' + url.pathname);
    if (match.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée');
    const { route, params } = match;
    req.params = params;
    req.query = Object.fromEntries(url.searchParams.entries());

    // Corps JSON
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Contrôle avant la lecture du corps (clé d'une route brute publique, par exemple) : une requête refusée
      // n'est jamais chargée en mémoire, et la connexion est fermée après la réponse sans lire la suite
      if (typeof route.opts.avantCorps === 'function') {
        try { await route.opts.avantCorps(req, ctx); } catch (e) { res.setHeader('Connection', 'close'); throw e; }
      }
      const raw = await readBody(req, route.opts.maxBody);
      const ct = String(req.headers['content-type'] || '');
      if (route.opts.brut) {
        req.body = raw; // corps binaire brut (ex. réception d'une sauvegarde d'un autre site)
      } else if (raw.length && ct.includes('application/json')) {
        try { req.body = analyserJson(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide'); }
      } else if (raw.length && ct.includes('text/')) {
        req.body = raw.toString('utf8');
      } else {
        req.body = raw.length ? raw : {};
      }
      // Protection CSRF simple : en-tête personnalisé obligatoire pour les mutations
      if (!route.opts.public && !route.opts.brut && req.headers['x-requested-with'] !== 'GMAO') {
        throw new HttpError(403, 'En-tête X-Requested-With manquant');
      }
    } else {
      req.body = {};
    }

    // Session
    const cookies = auth.parseCookies(req.headers.cookie);
    req.cookies = cookies;
    const session = sessions.get(cookies.gmao_session);
    req.session = session;
    req.user = session ? db.get('users', session.userId) : null;
    if (req.user && req.user.actif === false) { sessions.destroy(session.token); req.user = null; req.session = null; }
    req.ecriture = req.method !== 'GET' && req.method !== 'HEAD';
    if (req.user) {
      req.profil = db.get('profils', req.user.profilId);
      req.perms = perms.effectivePermissions(db, req.user, req.profil, configCourante());
      perms.appliquerSiteCourant(db, req.perms, req.headers['x-gmao-site']);
    }

    if (!route.opts.public && !req.user) throw new HttpError(401, 'Authentification requise');
    // Changement de mot de passe imposé (mot de passe initial, réinitialisé, expiré ou défini par un administrateur) :
    // seules les routes d'authentification (amorçage, changement du mot de passe, double authentification) restent
    // accessibles ; les notifications aussi sont refusées (aucune donnée de l'application avant le changement).
    if (req.user && !route.opts.public && !url.pathname.startsWith('/api/auth/') && ctx.motsDePasse.changementImpose(req.user)) {
      const raison = ctx.motsDePasse.raison(req.user);
      const err = new HttpError(403, 'Vous devez changer votre mot de passe avant de continuer.', { changementMdpRequis: true, raison });
      err.racine = { changementMdpRequis: true };
      throw err;
    }
    // Double authentification obligatoire pour ce compte mais pas encore activée : seules les routes
    // d'authentification (profil, mot de passe, enrôlement) restent accessibles.
    if (req.user && !route.opts.public && !url.pathname.startsWith('/api/auth/') && ctx.deuxFacteurs.enrolementRequis(req.user, req.perms)) {
      throw new HttpError(403, 'La double authentification est obligatoire pour votre compte : activez-la pour continuer.', { deuxFacteursRequis: true });
    }
    if (route.opts.perm) ctx.requirePerm(req, route.opts.perm[0], route.opts.perm[1]);
    if (req.ecriture && !route.opts.brut && !route.opts.sansQuotaPieces) verifierQuotaPieces(req.body);

    const result = await route.handler(req, res, ctx);
    if (res.writableEnded) return;
    if (result === undefined) return sendJson(res, 204, null);
    sendJson(res, 200, result);
  }

  function serveStatic(req, res, url) {
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Adresse invalide'); }
    if (p.includes('\0')) { res.writeHead(400); return res.end('Adresse invalide'); }
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(CLIENT_DIR, p));
    if (file !== CLIENT_DIR && !file.startsWith(CLIENT_DIR + path.sep)) { res.writeHead(403); return res.end('Accès refusé'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // Application monopage : on renvoie index.html pour les chemins inconnus (hors fichiers avec extension)
        if (!path.extname(p)) return serveFile(path.join(CLIENT_DIR, 'index.html'), res);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Fichier introuvable');
      }
      serveFile(file, res);
    });
  }

  function serveFile(file, res) {
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  /** Application de bureau : accès réservé à l'application GMAO SICAF (pas de navigateur web), sauf autorisation du pôle informatique. */
  const MARQUEUR_BUREAU = /GMAO-SICAF-Bureau\//;
  function accesNavigateurRefuse(req, url) {
    if (!options.bureau) return false;
    if (url.pathname.startsWith('/api/replication/')) return false; // sauvegardes reçues d'un autre site
    if (MARQUEUR_BUREAU.test(String(req.headers['user-agent'] || ''))) return false;
    const reseau = configCourante().reseau || {};
    return !reseau.accesNavigateur;
  }
  const PAGE_APPLICATION = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>GMAO SICAF</title><style>body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{max-width:520px;background:#1e293b;padding:28px 32px;border-radius:12px}h1{color:#60a5fa;margin-top:0}</style></head><body><div><h1>GMAO SICAF</h1><p>La GMAO s'utilise avec l'<strong>application GMAO SICAF</strong> installée sur votre poste (mode « Se connecter à la GMAO d'un autre poste »).</p><p>L'accès par un navigateur web est désactivé. Contactez le pôle informatique.</p></div></body></html>`;

  /**
   * Protection contre le « DNS rebinding » : seules les adresses IP, localhost, le nom du poste
   * et les noms déclarés par le pôle informatique (config.reseau.nomsAutorises) sont acceptés.
   */
  function hoteAutorise(req) {
    const brut = String(req.headers.host || '').trim().toLowerCase();
    if (!brut) return false;
    let hote = brut;
    if (hote.startsWith('[')) hote = hote.slice(1, hote.indexOf(']')); // IPv6 [::1]:8585
    else hote = hote.replace(/:\d+$/, '');
    if (net.isIP(hote)) return true;
    if (hote === 'localhost' || hote.endsWith('.localhost')) return true;
    const poste = os.hostname().toLowerCase();
    if (hote === poste || hote.split('.')[0] === poste.split('.')[0]) return true;
    const noms = ((configCourante().reseau || {}).nomsAutorises || []).map((n) => String(n).toLowerCase().trim()).filter(Boolean);
    return noms.includes(hote);
  }

  function handler(req, res) {
    entetesSecurite(res);
    if (!hoteAutorise(req)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nom de serveur non autorisé. Le pôle informatique peut l\'ajouter dans Système & informatique › Réseau.');
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('Adresse invalide'); }
    if (accesNavigateurRefuse(req, url)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 403, { erreur: 'Accès réservé à l\'application GMAO SICAF (accès par navigateur désactivé par le pôle informatique)' });
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE_APPLICATION);
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        if (res.writableEnded) return;
        if (err instanceof HttpError) {
          sendJson(res, err.status, Object.assign({ erreur: err.message, details: err.details }, err.racine || {}));
        } else {
          // Aucun détail technique n'est renvoyé au poste : référence d'incident à communiquer au pôle informatique
          const reference = crypto.randomBytes(4).toString('hex').toUpperCase();
          log('Erreur serveur', reference, req.method, url.pathname, err && err.stack ? err.stack : err);
          sendJson(res, 500, { erreur: `Erreur interne du serveur (référence ${reference}). Si le problème persiste, contactez le pôle informatique.` });
        }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  }

  // HTTPS (réseau partagé) : options.tls = { key, cert } (PEM) ; sinon HTTP (poste local uniquement)
  const server = options.tls
    ? require('https').createServer({ key: options.tls.key, cert: options.tls.cert, minVersion: 'TLSv1.2' }, (req, res) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      handler(req, res);
    })
    : http.createServer(handler);
  server.headersTimeout = 30000;   // protection contre les connexions lentes
  server.requestTimeout = 10 * 60 * 1000;

  return {
    db, ctx, router, sessions, server, handler,
    start(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port || 0, host || '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    stop() {
      clearInterval(sweeper);
      for (const fn of arrets.splice(0)) { try { fn(); } catch (e) { log('Erreur à l\'arrêt d\'un module', e && e.message); } }
      db.saveNow();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Modules dont le droit « Modifier » rend un compte sensible (en plus des administrateurs). */
const MODULES_SENSIBLES = ['systeme', 'utilisateurs', 'profils', 'configuration'];
const JETON_DEUX_FACTEURS_MS = 5 * 60 * 1000;        // validité d'une connexion en attente du code
const ESSAIS_PAR_JETON = 5;                          // codes incorrects tolérés avant de redemander le mot de passe
const JETONS_PAR_COMPTE = 3;                         // connexions en attente simultanées pour un même compte
const PREPARATION_DEUX_FACTEURS_MS = 30 * 60 * 1000; // délai pour terminer un enrôlement commencé

/**
 * Double authentification (TOTP) : politique, clés chiffrées au repos, connexions en attente du code,
 * vérification des codes (application ou code de secours) avec anti-rejeu. Exposé dans ctx.deuxFacteurs.
 */
function installerDeuxFacteurs(ctx) {
  const { db, perms: droits, log } = ctx;
  const coffre = new totp.Coffre({ dossier: db.inMemory ? null : db.dataDir, enMemoire: db.inMemory });
  const attentes = new Map(); // jeton → { userId, login, mdp, ip, ua, expire, essais }
  /** Empreinte courte du mot de passe enregistré : un changement de mot de passe invalide les connexions en attente. */
  const empreinteMdp = (user) => crypto.createHash('sha256').update(String(user.passwordHash || '')).digest('hex').slice(0, 32);

  const df = {
    MODES: MODES_DEUX_FACTEURS,
    /** Horloge (millisecondes) utilisée pour les codes et les délais. */
    maintenant: () => Date.now(),

    mode() {
      const m = ((db.data.config || {}).securite || {}).deuxFacteurs;
      return MODES_DEUX_FACTEURS.includes(m) ? m : 'facultatif';
    },
    actif(user) { return !!(user && user.deuxFacteurs && user.deuxFacteurs.actif); },
    /** Compte sensible : administrateur, ou droit « Modifier » sur le système, les utilisateurs, les profils ou la configuration. */
    sensible(user, p) {
      const d = p || droits.effectivePermissions(db, user, null, ctx.config());
      return !!d.estAdmin || MODULES_SENSIBLES.some((m) => droits.can(d, m, 'modifier'));
    },
    /** La configuration impose-t-elle la double authentification à ce compte ? */
    exige(user, p) {
      const mode = df.mode();
      if (!user || mode === 'facultatif') return false;
      return mode === 'obligatoire_tous' || df.sensible(user, p);
    },
    enrolementRequis(user, p) { return !!user && !df.actif(user) && df.exige(user, p); },
    /** État transmis au poste (aucun secret). */
    etat(user, p) {
      if (!user) return null;
      return Object.assign(auth.resumeDeuxFacteurs(user), { mode: df.mode(), exige: df.exige(user, p), enrolementRequis: df.enrolementRequis(user, p) });
    },

    chiffrer: (texte) => coffre.chiffrer(texte),
    dechiffrer: (chiffre) => coffre.dechiffrer(chiffre),
    /** Relit la clé de chiffrement depuis <données>/cle-double-authentification.key (restaurée avec une sauvegarde). */
    rechargerCle: () => coffre.recharger(),

    // ----- Connexions en attente du code (après un mot de passe correct) -----
    creerJeton(user, poste) {
      df.purger();
      const miens = Array.from(attentes.entries()).filter(([, a]) => a.userId === user.id).sort((a, b) => a[1].expire - b[1].expire);
      while (miens.length >= JETONS_PAR_COMPTE) attentes.delete(miens.shift()[0]);
      const jeton = crypto.randomBytes(32).toString('hex');
      attentes.set(jeton, { userId: user.id, login: user.login, mdp: empreinteMdp(user), ip: poste.ip, ua: poste.ua, expire: df.maintenant() + JETON_DEUX_FACTEURS_MS, essais: 0 });
      return jeton;
    },
    /**
     * Connexion en attente du jeton et son compte, ou null : jeton inconnu ou expiré, présenté depuis un autre
     * poste, compte supprimé, désactivé, renommé, dont le mot de passe ou la double authentification a changé.
     */
    lireJeton(jeton, poste) {
      if (typeof jeton !== 'string' || !/^[0-9a-f]{64}$/.test(jeton)) return null;
      const a = attentes.get(jeton);
      if (!a) return null;
      const user = db.get('users', a.userId);
      const valide = a.expire > df.maintenant() && a.ip === poste.ip && a.ua === poste.ua
        && !!user && user.actif !== false && df.actif(user) && user.login === a.login && empreinteMdp(user) === a.mdp;
      if (!valide) { attentes.delete(jeton); return null; }
      return { attente: a, user };
    },
    supprimerJeton(jeton) { attentes.delete(jeton); },
    /** Annule les connexions en attente d'un compte (mot de passe changé, double authentification réinitialisée…). */
    annulerAttentes(userId) { for (const [j, a] of attentes) if (a.userId === Number(userId)) attentes.delete(j); },
    purger() { const t = df.maintenant(); for (const [j, a] of attentes) if (a.expire <= t) attentes.delete(j); },

    /**
     * Vérifie un code de l'application (TOTP) ou un code de secours et consigne son utilisation :
     * pas mémorisé (un code déjà utilisé est refusé) ou code de secours consommé.
     * @returns {Promise<null|{type:'application'}|{type:'secours', restants:number}>}
     */
    async verifierCode(userId, code) {
      const saisi = (typeof code === 'string' || typeof code === 'number') ? String(code).trim().slice(0, 40) : '';
      const user = db.get('users', userId);
      if (!user || !df.actif(user)) return null;
      if (totp.normaliserCode(saisi)) return df.verifierCodeApplication(user.id, saisi, { enregistrer: true }) === null ? null : { type: 'application' };
      if (totp.normaliserCodeSecours(saisi)) {
        const empreinte = await totp.trouverCodeSecours(saisi, user.codesSecours);
        if (!empreinte) return null;
        // Relecture après le calcul : un même code de secours ne peut pas être consommé deux fois
        const actuel = db.get('users', user.id);
        const restants = actuel && df.actif(actuel) && Array.isArray(actuel.codesSecours) ? actuel.codesSecours : [];
        if (!restants.includes(empreinte)) return null;
        db.update('users', user.id, { codesSecours: restants.filter((e) => e !== empreinte) });
        return { type: 'secours', restants: restants.length - 1 };
      }
      return null;
    },

    /**
     * Code de l'application d'authentification uniquement (jamais un code de secours), avec anti-rejeu.
     * Sans `enregistrer`, le pas n'est pas consigné : le code reste utilisable pour l'opération qu'il confirme
     * (ex. réinitialisation refusée par la politique de mot de passe, à corriger puis renvoyer).
     * @returns {number|null} pas accepté ou null
     */
    verifierCodeApplication(userId, code, options = {}) {
      const saisi = (typeof code === 'string' || typeof code === 'number') ? String(code).trim().slice(0, 40) : '';
      if (!totp.normaliserCode(saisi)) return null;
      const user = db.get('users', userId);
      if (!user || !df.actif(user)) return null;
      const d = user.deuxFacteurs;
      let secret = null;
      try { secret = d.secret ? coffre.dechiffrer(d.secret) : null; } catch (e) {
        log('Double authentification : clé du compte n°' + user.id + ' indéchiffrable (base provenant d\'un autre serveur ?)');
      }
      if (!secret) return null;
      const pas = totp.verifier(secret, saisi, { instant: df.maintenant(), dernierPas: d.dernierPas });
      if (pas === null) return null;
      if (options.enregistrer) db.update('users', user.id, { deuxFacteurs: Object.assign({}, d, { dernierPas: pas, derniereUtilisation: new Date().toISOString() }) });
      return pas;
    },

    /** Nouveaux codes de secours : `codes` en clair (affichés une seule fois) et `empreintes` (stockées). */
    async nouveauxCodesSecours() {
      const codes = totp.genererCodesSecours();
      const empreintes = await Promise.all(codes.map((c) => totp.empreinteCodeSecours(c)));
      return { codes, empreintes };
    },
  };
  return df;
}

// ----- Mots de passe : expiration, historique, codes de réinitialisation, demandes ------------------------
const MINUTE_MS = 60 * 1000;
const JOUR_MS = 24 * 60 * MINUTE_MS;
const ESSAIS_CODE_REINIT = 5;                     // codes incorrects tolérés pour un même code de réinitialisation
const DEMANDES_OUBLI_PAR_POSTE = 5;               // demandes « mot de passe oublié » par poste…
const FENETRE_DEMANDES_OUBLI_MS = 15 * MINUTE_MS; // …sur 15 minutes
const RELANCE_DEMANDE_MS = 30 * MINUTE_MS;        // notifications d'une même demande au plus toutes les 30 minutes
const MAX_PROVENANCES = 10;                       // demandes suivantes d'une même demande en attente conservées
const CONSERVATION_DEMANDES_MS = 90 * JOUR_MS;    // demandes traitées ou rejetées conservées 90 jours
const MAX_HISTORIQUE_MDP = 24;
const ECHECS_PAR_POSTE = 20;                      // échecs d'authentification tolérés par poste (tous identifiants)…
const FENETRE_ECHECS_POSTE_MS = 15 * MINUTE_MS;   // …sur 15 minutes
/** Adresses du poste serveur lui-même (application locale, sessions Windows du serveur) : pas de blocage par poste. */
const ADRESSES_LOCALES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Raisons d'un changement de mot de passe toujours imposé (le mot de passe initial dépend de la configuration). */
const RAISONS_IMPOSEES = ['reinitialise', 'expire', 'administrateur'];
const RAISONS_MDP = ['initial'].concat(RAISONS_IMPOSEES);
const LIBELLES_RAISON = { initial: 'mot de passe initial', reinitialise: 'mot de passe réinitialisé', expire: 'mot de passe expiré', administrateur: 'mot de passe défini par un administrateur' };

/** Date et heure lisibles (« 15/10/2026 à 14:32 »). */
function dateHeureFr(d) {
  const x = new Date(d);
  return `${x.toLocaleDateString('fr-FR')} à ${x.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Texte brut sur une ligne ou quelques lignes : caractères de contrôle (C0, C1), de mise en forme (direction
 * d'écriture, largeur nulle…) et séparateurs de ligne ou de paragraphe Unicode remplacés par une espace (les
 * retours à la ligne ordinaires sont conservés), longueur limitée.
 */
function texteBrut(v, max) {
  return String(v == null ? '' : v).replace(/[^\P{Cc}\n]|\p{Cf}|[\u2028\u2029]/gu, ' ').trim().slice(0, max);
}

/** Identifiant de compte possible (même format que les comptes : lettres, chiffres, . _ @ -). */
const RE_IDENTIFIANT = /^[\w.@-]{1,100}$/;
/** Identifiant cité dans le journal et les alertes : caractères hors format remplacés par « ? », 60 caractères au plus. */
function identifiantAffiche(login) {
  return String(login == null ? '' : login).slice(0, 60).replace(/[^\w.@-]/g, '?');
}

/**
 * Cycle de vie des mots de passe : changement imposé, expiration, historique, codes de réinitialisation
 * (empreinte scrypt, usage unique, durée limitée, essais limités) et demandes de réinitialisation faites
 * depuis l'écran de connexion. Exposé dans ctx.motsDePasse ; aucune de ces données ne quitte le serveur.
 */
function installerMotsDePasse(ctx) {
  const { db, perms: droits } = ctx;
  const sec = () => ((db.data.config || {}).securite || {});
  /**
   * Empreinte de comparaison quand aucun code n'est actif : sel et valeur aléatoires au format scrypt, la vérification
   * coûte exactement autant qu'avec un vrai code (temps de réponse identique) et échoue toujours.
   */
  const empreinteFactice = `scrypt$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(64).toString('hex')}`;
  const factice = () => empreinteFactice;
  const nombreHistorique = () => Math.min(MAX_HISTORIQUE_MDP, Math.max(0, Math.floor(Number(sec().historiqueMdp) || 0)));
  const poleInformatique = () => ctx.usersAvecDroit('systeme', 'modifier');

  const mdp = {
    RAISONS: RAISONS_MDP,
    /** Horloge (millisecondes). */
    maintenant: () => Date.now(),
    /** Date et heure lisibles pour les messages (« 15/10/2026 à 14:32 »). */
    dateHeure: dateHeureFr,

    // ----- Changement imposé et expiration -----
    /** Raison du changement attendu (null si aucun) ; « initial » pour les comptes antérieurs sans raison. */
    raison(user) {
      if (!user || !user.doitChangerMdp) return null;
      return RAISONS_MDP.includes(user.raisonChangementMdp) ? user.raisonChangementMdp : 'initial';
    },
    /** Le changement est-il imposé (appliqué par le serveur) ? Le mot de passe initial l'est sauf si la configuration le permet. */
    changementImpose(user) {
      const r = mdp.raison(user);
      if (!r) return false;
      return RAISONS_IMPOSEES.includes(r) || sec().forcerChangementMdpInitial !== false;
    },
    /** Échéance du mot de passe (ms) ou null sans expiration ; date de référence : dateMdp, à défaut dateReferenceMdp. */
    echeance(user) {
      const jours = Math.floor(Number(sec().expirationMdpJours) || 0);
      if (!user || jours <= 0) return null;
      const base = Date.parse(user.dateMdp || user.dateReferenceMdp || '');
      return Number.isFinite(base) ? base + jours * JOUR_MS : null;
    },
    /**
     * Évalue l'expiration (connexion, amorçage) : un compte sans date de changement reçoit une date de
     * référence (l'activation de l'expiration ne fait pas expirer tous les comptes d'un coup) ; un mot de passe
     * expiré doit être changé (raison « expire »). Renvoie le compte à jour.
     */
    evaluerExpiration(user, req) {
      const jours = Math.floor(Number(sec().expirationMdpJours) || 0);
      if (!user || jours <= 0) return user;
      if (!user.dateMdp && !user.dateReferenceMdp) return db.update('users', user.id, { dateReferenceMdp: new Date(mdp.maintenant()).toISOString() }) || user;
      const fin = mdp.echeance(user);
      // Un changement déjà imposé garde sa raison ; un mot de passe initial non imposé devient imposé à l'échéance
      if (fin === null || mdp.maintenant() < fin || mdp.changementImpose(user)) return user;
      const u = db.update('users', user.id, { doitChangerMdp: true, raisonChangementMdp: 'expire' }) || user;
      ctx.audit(Object.assign({ socket: req && req.socket }, { user: u }), 'expiration_mdp', 'users', u.id, `Mot de passe de « ${u.login} » expiré (plus de ${jours} jours) : changement imposé`);
      return u;
    },
    /**
     * Le mot de passe actuel est-il exigé pour changer de mot de passe dans cette session ? Il ne l'est pas seulement
     * quand le changement est imposé et l'était déjà à l'ouverture de la session (mot de passe actuel saisi à la
     * connexion) ; un poste resté ouvert ne permet donc jamais de changer le mot de passe sans le connaître.
     */
    ancienRequis(user, session) {
      return !(mdp.changementImpose(user) && session && session.info && session.info.changementImposeALOuverture === true);
    },
    /** Informations transmises au poste (amorçage, réponse de connexion) : aucune empreinte. */
    infos(user, session) {
      if (!user) return null;
      const fin = mdp.echeance(user);
      const doitChanger = mdp.changementImpose(user);
      const joursRestants = fin === null ? null : Math.max(0, Math.ceil((fin - mdp.maintenant()) / JOUR_MS));
      const seuilRappel = Math.min(60, Math.max(1, Math.floor(Number(sec().rappelExpirationJours) || 14)));
      return {
        doitChanger,
        raison: mdp.raison(user),
        dateMdp: user.dateMdp || null,
        expireLe: fin === null ? null : new Date(fin).toISOString(),
        joursRestants,
        rappel: !doitChanger && joursRestants !== null && joursRestants <= seuilRappel,
        ancienRequis: mdp.ancienRequis(user, session),
      };
    },

    // ----- Nouveau mot de passe : politique, historique, enregistrement -----
    /**
     * Contrôle d'un nouveau mot de passe pour ce compte : politique, différent de l'actuel et des N précédents
     * (config.securite.historiqueMdp). Renvoie le message de refus ou null.
     */
    async refus(user, nouveau) {
      const err = auth.validerMotDePasse(nouveau, db.getConfig(), { login: user.login });
      if (err) return err;
      const n = nombreHistorique();
      const precedents = (Array.isArray(user.historiqueMdp) ? user.historiqueMdp : []).slice(0, n);
      const resultats = await Promise.all([user.passwordHash].concat(precedents).map((e) => auth.verifyPasswordAsync(nouveau, e)));
      if (resultats[0]) return 'Le nouveau mot de passe doit être différent de l\'ancien';
      if (resultats.slice(1).some(Boolean)) return `Ce mot de passe a déjà été utilisé : choisissez-en un autre (vos ${n} derniers mots de passe sont refusés)`;
      return null;
    },
    /**
     * Modifications à enregistrer pour un nouveau mot de passe : empreinte, historique (l'ancienne empreinte
     * rejoint les précédentes), date, changement imposé ou non, code de réinitialisation annulé.
     */
    champsNouveau(user, nouveau, options = {}) {
      const n = nombreHistorique();
      const historique = n > 0 ? [user.passwordHash].concat(Array.isArray(user.historiqueMdp) ? user.historiqueMdp : []).filter((e) => typeof e === 'string' && e).slice(0, n) : [];
      const imposer = !!options.doitChanger;
      return {
        passwordHash: auth.hashPassword(nouveau),
        historiqueMdp: historique,
        dateMdp: new Date(mdp.maintenant()).toISOString(),
        dateReferenceMdp: null,
        doitChangerMdp: imposer,
        raisonChangementMdp: imposer && RAISONS_MDP.includes(options.raison) ? options.raison : null,
        reinitialisation: null,
      };
    },

    // ----- Codes de réinitialisation -----
    /** Code actif (présent, non expiré, essais restants) ? */
    codeValide(user) {
      const r = user && user.reinitialisation;
      return !!(r && typeof r.empreinte === 'string' && Date.parse(r.expireLe) > mdp.maintenant() && (Number(r.essais) || 0) < ESSAIS_CODE_REINIT);
    },
    /** État du code pour la fiche utilisateur (jamais l'empreinte). */
    etatCode(user) {
      const actif = mdp.codeValide(user);
      return { codeActif: actif, codeExpireLe: actif ? user.reinitialisation.expireLe : null, codeOrigine: actif ? user.reinitialisation.origine || null : null };
    },
    /**
     * Nouveau code de réinitialisation (remplace le précédent) : seule son empreinte est conservée ;
     * le code en clair (« XXXX-XXXX ») est renvoyé une seule fois.
     */
    poserCode(user, { creePar = null, origine = 'pole_informatique' } = {}) {
      const minutes = Math.min(1440, Math.max(5, Math.floor(Number(sec().dureeCodeReinitialisationMinutes) || 60)));
      const code = auth.genererCodeReinitialisation();
      const maintenant = mdp.maintenant();
      const expireLe = new Date(maintenant + minutes * MINUTE_MS).toISOString();
      db.update('users', user.id, { reinitialisation: {
        empreinte: auth.hashPassword(code), expireLe, creeLe: new Date(maintenant).toISOString(),
        creePar: creePar == null ? null : Number(creePar), origine: origine === 'recuperation_urgence' ? 'recuperation_urgence' : 'pole_informatique', essais: 0,
      } });
      return { code: auth.formaterCodeReinitialisation(code), expireLe };
    },
    /** Annule le code du compte ; vrai s'il existait. */
    annulerCode(userId) {
      const u = db.get('users', userId);
      if (!u || !u.reinitialisation) return false;
      db.update('users', u.id, { reinitialisation: null });
      return true;
    },
    /**
     * Vérifie un code de réinitialisation en temps constant (empreinte factice si l'identifiant est inconnu,
     * le compte désactivé ou sans code). Un code bien formé mais incorrect consomme un essai ; au 5e, le code
     * est annulé et le pôle informatique prévenu.
     * @returns {Promise<{ok:boolean, empreinte?:string}>}
     */
    async verifierCode(user, code, req) {
      const r = user && user.actif !== false && mdp.codeValide(user) ? user.reinitialisation : null;
      const compte = !!(r && code);
      // Essai décompté avant la vérification (requêtes simultanées), rendu si le code est correct
      if (compte) db.update('users', user.id, { reinitialisation: Object.assign({}, r, { essais: (Number(r.essais) || 0) + 1 }) });
      const ok = await auth.verifyPasswordAsync(code || 'XXXXXXXX', r ? r.empreinte : factice());
      if (!compte) return { ok: false };
      const actuel = db.get('users', user.id);
      const meme = actuel && actuel.reinitialisation && actuel.reinitialisation.empreinte === r.empreinte ? actuel.reinitialisation : null;
      if (!meme) return { ok: false };
      if (ok) {
        db.update('users', user.id, { reinitialisation: Object.assign({}, meme, { essais: Math.max(0, (Number(meme.essais) || 1) - 1) }) });
        return { ok: true, empreinte: r.empreinte };
      }
      if ((Number(meme.essais) || 0) >= ESSAIS_CODE_REINIT) {
        db.update('users', user.id, { reinitialisation: null });
        ctx.audit({ socket: req && req.socket }, 'annulation_code_reinitialisation', 'users', user.id, `Code de réinitialisation de « ${user.login} » annulé après ${ESSAIS_CODE_REINIT} essais incorrects`);
        const dest = poleInformatique().map((u) => u.id).concat(meme.creePar != null ? [meme.creePar] : []).filter((id) => id !== user.id);
        ctx.notify(dest, { titre: 'Code de réinitialisation annulé', message: `Le code de réinitialisation du mot de passe de ${ctx.nomUser(user.id)} (${user.login}) a été annulé après ${ESSAIS_CODE_REINIT} essais incorrects${req && req.socket && req.socket.remoteAddress ? ' depuis ' + req.socket.remoteAddress : ''}. Créez-en un nouveau si l'utilisateur en a toujours besoin.`, lien: '#/audit?action=echec_reinitialisation_mdp', type: 'alerte' });
        ctx.notify(user.id, { titre: 'Code de réinitialisation annulé', message: `Le code de réinitialisation de votre mot de passe a été annulé après ${ESSAIS_CODE_REINIT} essais incorrects. Si vous n'êtes pas à l'origine de ces essais, prévenez le pôle informatique.`, lien: '', type: 'alerte' });
      }
      return { ok: false };
    },

    // ----- Demandes de réinitialisation -----
    /** Gestionnaires d'un compte : droit utilisateurs › modifier, niveau hiérarchique supérieur, compte visible (sites compris). */
    gestionnaires(cible) {
      const profil = db.get('profils', cible.profilId);
      return ctx.usersAvecDroit('utilisateurs', 'modifier', (u, p) => u.id !== cible.id && droits.canManageUser(p, profil) && ctx.utilisateurVisible(u, p, cible, true)
        && !droits.depassementsGestion(db, p, cible).length);
    },
    /** Demandes en attente d'un compte passées « traitées » (mode : code, temporaire ou utilisateur). */
    traiterDemandes(userId, { mode, par = null } = {}) {
      const maintenant = new Date(mdp.maintenant()).toISOString();
      let n = 0;
      for (const d of db.list('demandesMdp', (x) => x.userId === Number(userId) && x.statut === 'en_attente')) {
        db.update('demandesMdp', d.id, { statut: 'traitee', mode, traiteePar: par == null ? null : Number(par), traiteeLe: maintenant });
        n += 1;
      }
      return n;
    },
    /** Demandes en attente d'un compte désactivé ou supprimé : rejetées. */
    rejeterDemandes(userId, motif, par) {
      const maintenant = new Date(mdp.maintenant()).toISOString();
      for (const d of db.list('demandesMdp', (x) => x.userId === Number(userId) && x.statut === 'en_attente')) {
        db.update('demandesMdp', d.id, { statut: 'rejetee', mode: 'rejet', motifRejet: motif, traiteePar: par == null ? null : Number(par), traiteeLe: maintenant });
      }
    },
    /**
     * Demande « mot de passe oublié » (traitée après la réponse, identique pour tous) : compte actif → demande
     * enregistrée ou mise à jour, journal, notifications (au plus toutes les 30 minutes) ; identifiant inconnu
     * ou compte désactivé → journal uniquement.
     */
    enregistrerDemande({ login, message, ip, poste }) {
      // Demande anonyme : journalisée sans auteur (le compte concerné est l'élément du journal)
      const socket = { remoteAddress: ip };
      const user = RE_IDENTIFIANT.test(login) ? db.findOne('users', (u) => String(u.login).toLowerCase() === login.toLowerCase()) : null;
      if (!user || user.actif === false) {
        ctx.audit({ socket }, 'demande_reinitialisation_mdp', 'users', user ? user.id : null, `Demande de réinitialisation pour l'identifiant « ${identifiantAffiche(login)} » (${user ? 'compte désactivé' : 'identifiant inconnu'}) : ignorée`, { notifier: false });
        return null;
      }
      const t = mdp.maintenant();
      const maintenant = new Date(t).toISOString();
      const existante = db.findOne('demandesMdp', (d) => d.userId === user.id && d.statut === 'en_attente');
      let demande;
      let autrePoste = false;
      if (existante) {
        // La provenance d'origine (adresse, poste, message) est conservée ; les demandes suivantes sont ajoutées
        // à une liste bornée, et une demande venue d'un autre poste est signalée sans attendre
        const provenances = (Array.isArray(existante.provenances) ? existante.provenances : []).slice(-(MAX_PROVENANCES - 1));
        const connues = new Set([existante.ip].concat(provenances.map((p) => p.ip)));
        autrePoste = !connues.has(ip);
        provenances.push({ ip, poste, message, date: maintenant });
        demande = db.update('demandesMdp', existante.id, {
          repetitions: (Number(existante.repetitions) || 1) + 1, derniereDemande: maintenant, provenances,
          nbPostes: new Set([existante.ip].concat(provenances.map((p) => p.ip))).size,
        });
      } else {
        demande = db.insert('demandesMdp', { userId: user.id, login: user.login, message: message || '', ip, poste, statut: 'en_attente', repetitions: 1, derniereDemande: maintenant, provenances: [], nbPostes: 1, traiteePar: null, traiteeLe: null, mode: null, motifRejet: null, derniereNotification: null });
      }
      ctx.audit({ socket }, 'demande_reinitialisation_mdp', 'users', user.id, `Demande de réinitialisation du mot de passe de « ${user.login} » depuis ${ip || 'un poste inconnu'}${demande.repetitions > 1 ? ` (${demande.repetitions}e demande${demande.nbPostes > 1 ? `, ${demande.nbPostes} postes différents` : ''})` : ''}`);
      const derniere = Date.parse(existante && existante.derniereNotification || '');
      if (!autrePoste && Number.isFinite(derniere) && t - derniere < RELANCE_DEMANDE_MS) return demande;
      db.update('demandesMdp', demande.id, { derniereNotification: maintenant });
      const nom = ctx.nomUser(user.id);
      const plusieursPostes = demande.nbPostes > 1
        ? ` Attention : demandes reçues depuis ${demande.nbPostes} postes différents (première : ${demande.ip || 'poste inconnu'}, dernière : ${ip || 'poste inconnu'}) ; vérifiez l'identité du demandeur avant de lui remettre un code.`
        : '';
      ctx.notify(mdp.gestionnaires(user).map((u) => u.id), {
        titre: demande.nbPostes > 1 ? 'Demande de réinitialisation depuis plusieurs postes' : 'Demande de réinitialisation de mot de passe',
        message: `${nom} (${user.login}) demande la réinitialisation de son mot de passe depuis l'écran de connexion (poste ${demande.ip || 'inconnu'}${demande.repetitions > 1 ? `, ${demande.repetitions} demandes` : ''})${demande.message ? ` : « ${demande.message.slice(0, 160)} »` : '.'}${plusieursPostes}`,
        lien: '#/utilisateurs?demandesMdp=1', type: 'alerte',
      });
      ctx.notify(user.id, {
        titre: 'Demande de réinitialisation de votre mot de passe',
        message: `Une demande de réinitialisation de votre mot de passe a été faite le ${dateHeureFr(t)} depuis le poste ${ip || 'inconnu'}. Si vous n'en êtes pas à l'origine, prévenez le pôle informatique.`,
        lien: '', type: 'info',
      });
      return demande;
    },
    /** Purge : codes expirés, demandes traitées ou rejetées depuis plus de 90 jours, demandes de comptes supprimés. */
    purger() {
      const t = mdp.maintenant();
      for (const u of db.list('users', (x) => x.reinitialisation && !(Date.parse(x.reinitialisation.expireLe) > t))) db.update('users', u.id, { reinitialisation: null });
      const limite = new Date(t - CONSERVATION_DEMANDES_MS).toISOString();
      const col = db.data.collections.demandesMdp;
      if (!Array.isArray(col) || !col.length) return;
      const ids = new Set(db.list('users').map((u) => u.id));
      const garder = col.filter((d) => (d.statut === 'en_attente' ? ids.has(d.userId) : (d.traiteeLe || d.updatedAt || d.createdAt || '') >= limite));
      if (garder.length !== col.length) { db.data.collections.demandesMdp = garder; db.touch(); }
    },
  };
  return mdp;
}

/**
 * Routes d'authentification (connexion en une ou deux étapes, double authentification, mot de passe oublié,
 * réinitialisation), d'amorçage et de profil personnel.
 */
function registerCoreRoutes(ctx) {
  const { router, db, sessions, HttpError, log } = ctx;
  const sec = () => ((db.data.config || {}).securite || {});
  const deuxFacteurs = ctx.deuxFacteurs = installerDeuxFacteurs(ctx);
  const motsDePasse = ctx.motsDePasse = installerMotsDePasse(ctx);

  function bootstrap(req) {
    // Expiration du mot de passe évaluée à la connexion et à chaque amorçage
    if (req.user) req.user = motsDePasse.evaluerExpiration(req.user, req);
    const commun = {
      user: auth.cleanUser(req.user),
      permissions: req.perms,
      deuxFacteurs: deuxFacteurs.etat(req.user, req.perms),
      // État du mot de passe : { doitChanger (changement imposé), raison, dateMdp, expireLe, joursRestants, rappel, ancienRequis }
      motDePasse: motsDePasse.infos(req.user, req.session),
      catalogue: { modules: perms.MODULES, actions: perms.ACTIONS, portees: perms.PORTEES, modesSite: perms.MODES_SITE },
      // Libellés du journal d'activité (actions, éléments) repris par les vues qui affichent un historique
      libelles: { actions: ctx.libellesActions || {}, entites: ctx.libellesEntites || {} },
      version: ctx.version,
      serveur: { heure: new Date().toISOString() },
    };
    // Changement de mot de passe imposé ou double authentification à activer : seul l'écran imposé s'affiche. Aucune
    // donnée de l'application (comptes, secteurs, profils, listes…) avant ; l'amorçage complet suit (GMAO.refresh).
    if (req.user && (motsDePasse.changementImpose(req.user) || deuxFacteurs.enrolementRequis(req.user, req.perms))) {
      const c = ctx.config();
      return Object.assign(commun, {
        config: { societe: c.societe || {}, general: c.general || {}, securite: c.securite || {} },
        modules: [],
        references: { secteurs: [], profils: [], users: [] },
      });
    }
    const config = db.getConfig();
    // Les secrets de sauvegarde ne sont jamais envoyés au navigateur
    if (config.sauvegardes) { delete config.sauvegardes.cleReception; delete config.sauvegardes.destinations; delete config.sauvegardes.motDePasseChiffrement; }
    const modules = perms.modulesConfigures(config);
    const secteurs = db.list('secteurs').sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || a.nom.localeCompare(b.nom))
      .map((s) => Object.assign({}, s, { siteId: perms.siteDuSecteur(db, s.id) }));
    const profils = db.list('profils').map((p) => ({ id: p.id, nom: p.nom, niveau: p.niveau, couleur: p.couleur, secteurId: p.secteurId, estAdmin: !!p.estAdmin, portee: p.portee, actif: p.actif !== false,
      accesJournal: !!(p.estAdmin || (p.permissions && p.permissions.audit && p.permissions.audit.voir)) }));
    const users = db.list('users').map((u) => ({ id: u.id, login: u.login, nom: u.nom, prenom: u.prenom, profilId: u.profilId, secteurIds: u.secteurIds || [], siteAcces: u.siteAcces || [], managerId: u.managerId, actif: u.actif !== false, fonction: u.fonction || '' }));
    return Object.assign(commun, { config, modules, references: { secteurs, profils, users } });
  }

  /** Prévient le pôle informatique (droit Système › Modifier) d'un blocage de compte. */
  function notifierBlocage(login, ip, options = {}) {
    if ((ctx.config().securite || {}).notifierBlocages === false) return;
    const ids = ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id);
    const motif = options.motif || 'Trop de mots de passe incorrects';
    const titre = options.titre || 'Compte temporairement bloqué';
    const message = options.message || `${motif} pour l'identifiant « ${identifiantAffiche(login)} » depuis ${ip || 'un poste inconnu'}. Accès bloqué 10 minutes.`;
    // Blocages d'un même poste regroupés dans une notification non lue de moins de 30 minutes (pas d'inondation)
    const cle = 'blocage:' + (ip || 'inconnu');
    const limite = new Date(Date.now() - 30 * MINUTE_MS).toISOString();
    const col = db.data.collections.notifications;
    const nouveaux = [];
    for (const id of ids) {
      const existante = col.find((n) => n.userId === id && n.cle === cle && !n.lu && n.date >= limite);
      if (!existante) { nouveaux.push(id); continue; }
      existante.nombre = (existante.nombre || 1) + 1;
      existante.message = `${message} (${existante.nombre} blocages depuis ce poste en moins de 30 minutes)`;
      existante.date = new Date().toISOString();
      db.touch();
    }
    if (!nouveaux.length) return;
    ctx.notify(nouveaux, { titre, message, lien: '#/audit?action=' + (options.action || 'echec_connexion'), type: 'alerte' });
    for (const n of col.slice(-nouveaux.length)) { n.cle = cle; n.nombre = 1; }
  }

  /**
   * Échecs d'authentification par poste, tous identifiants confondus (connexion, codes de vérification, codes de
   * réinitialisation) : au-delà de ECHECS_PAR_POSTE en 15 minutes, le poste est refusé (429) avant tout calcul
   * d'empreinte, ce qui borne le volume du journal et des alertes qu'un poste peut produire.
   */
  const clePosteEchecs = (req) => {
    const ip = String((req.socket && req.socket.remoteAddress) || '');
    return ADRESSES_LOCALES.has(ip) ? null : 'auth-poste|' + ip;
  };
  function verifierPoste(req) {
    const cle = clePosteEchecs(req);
    const bloc = cle ? sessions.quotaAtteint(cle, ECHECS_PAR_POSTE, FENETRE_ECHECS_POSTE_MS) : 0;
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives depuis ce poste. Réessayez dans ${minutes(bloc)} min`);
  }
  function echecPoste(req) {
    const cle = clePosteEchecs(req);
    if (!cle) return;
    sessions.quota(cle, ECHECS_PAR_POSTE, FENETRE_ECHECS_POSTE_MS);
    if (!sessions.quotaAtteint(cle, ECHECS_PAR_POSTE, FENETRE_ECHECS_POSTE_MS)) return;
    const ip = String(req.socket.remoteAddress || '');
    ctx.audit({ socket: req.socket }, 'blocage', 'users', null, `Poste ${ip || 'inconnu'} bloqué 15 minutes : ${ECHECS_PAR_POSTE} échecs d'authentification (tous identifiants confondus)`);
    notifierBlocage('', ip, { titre: 'Poste temporairement bloqué', message: `${ECHECS_PAR_POSTE} échecs d'authentification en moins de 15 minutes depuis le poste ${ip || 'inconnu'}, sur un ou plusieurs identifiants : ce poste ne peut plus se connecter ni réinitialiser de mot de passe pendant 15 minutes.` });
  }

  /** Poste à l'origine de la requête : une connexion en attente du code reste liée à ce poste. */
  function posteDe(req) {
    return { ip: String(req.socket.remoteAddress || ''), ua: String(req.headers['user-agent'] || '').slice(0, 300) };
  }

  /** Ouvre la session (cookie), journalise la connexion et renvoie l'amorçage. */
  function ouvrirSession(req, res, user, details = {}) {
    const poste = posteDe(req);
    // Expiration évaluée avant l'ouverture : une session ouverte alors que le changement est déjà imposé (le mot de
    // passe actuel vient d'être saisi) peut le faire sans le ressaisir ; sinon le mot de passe actuel est exigé.
    user = motsDePasse.evaluerExpiration(user, req);
    const token = sessions.create(user.id, { ua: poste.ua, ip: poste.ip, deuxFacteurs: !!details.deuxFacteurs, changementImposeALOuverture: motsDePasse.changementImpose(user) });
    req.session = sessions.get(token);
    db.update('users', user.id, { derniereConnexion: new Date().toISOString() });
    const securise = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `gmao_session=${token}; Path=/; HttpOnly; SameSite=Strict${securise}; Max-Age=${Math.floor(sessions.dureeMaxMs() / 1000)}`);
    req.user = db.get('users', user.id);
    req.profil = db.get('profils', req.user.profilId);
    req.perms = perms.effectivePermissions(db, req.user, req.profil, ctx.config());
    perms.appliquerSiteCourant(db, req.perms, req.headers['x-gmao-site']);
    ctx.audit(req, 'connexion', 'users', user.id, details.texte || '');
    return bootstrap(req);
  }

  const cleCode = (userId) => 'deux-facteurs|' + userId;        // codes incorrects à la connexion
  const cleConfirmation = (userId) => 'confirmation|' + userId; // confirmations (mot de passe, code) en session
  const minutes = (s) => Math.ceil(s / 60);

  router.post('/api/auth/login', async (req, res) => {
    const b = req.body || {};
    const login = typeof b.login === 'string' ? b.login.trim().slice(0, 100) : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, 500) : '';
    const ip = String(req.socket.remoteAddress || '');
    verifierPoste(req);
    // Deux compteurs : par poste + identifiant, et par identifiant seul (attaque depuis plusieurs postes)
    const clePoste = ip + '|' + login.toLowerCase();
    const cleCompte = 'compte|' + login.toLowerCase();
    const bloc = Math.max(sessions.blocage(clePoste), sessions.blocage(cleCompte));
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${minutes(bloc)} min`);
    // Un identifiant hors du format des comptes est traité comme inconnu (même réponse)
    const user = RE_IDENTIFIANT.test(login) ? db.findOne('users', (u) => String(u.login).toLowerCase() === login.toLowerCase()) : null;
    // Vérification exécutée même si le compte n'existe pas (temps de réponse identique)
    const ok = auth.verifyPassword(password, user ? user.passwordHash : 'scrypt$00$00') && !!user;
    if (!ok) {
      const bloquePoste = sessions.echec(clePoste);
      const bloqueCompte = sessions.echec(cleCompte);
      ctx.audit({ socket: req.socket }, 'echec_connexion', 'users', user ? user.id : null, `Identifiant « ${identifiantAffiche(login)} »${user ? '' : ' (inconnu)'}`);
      if (bloquePoste || bloqueCompte) {
        ctx.audit({ socket: req.socket }, 'blocage', 'users', user ? user.id : null, `Blocage après échecs répétés : « ${identifiantAffiche(login)} »`);
        notifierBlocage(login, ip);
      }
      echecPoste(req);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
    }
    if (user.actif === false) throw new HttpError(403, 'Ce compte est désactivé');
    sessions.succes(clePoste);
    sessions.succes(cleCompte);
    if (deuxFacteurs.actif(user)) {
      // Mot de passe correct : la session ne sera ouverte qu'après la saisie du code de vérification
      const blocCode = sessions.blocage(cleCode(user.id));
      if (blocCode > 0) throw new HttpError(429, `Trop de codes de vérification incorrects. Réessayez dans ${minutes(blocCode)} min`);
      const jeton = deuxFacteurs.creerJeton(user, posteDe(req));
      return { deuxFacteurs: true, jeton, expireDans: JETON_DEUX_FACTEURS_MS / 1000 };
    }
    return ouvrirSession(req, res, user);
  }, { public: true, maxBody: 16 * 1024 });

  /** Deuxième étape de la connexion : code de l'application d'authentification ou code de secours. */
  router.post('/api/auth/login/code', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const poste = posteDe(req);
    const recommencer = (message, status = 401) => new HttpError(status, message || 'Délai dépassé ou demande invalide : saisissez de nouveau votre identifiant et votre mot de passe', { recommencer: true });
    verifierPoste(req);
    const lu = deuxFacteurs.lireJeton(b.jeton, poste);
    if (!lu) throw recommencer();
    const { attente, user } = lu;
    const cle = cleCode(user.id);
    const bloc = sessions.blocage(cle);
    if (bloc > 0) { deuxFacteurs.supprimerJeton(b.jeton); throw recommencer(`Trop de codes de vérification incorrects. Réessayez dans ${minutes(bloc)} min`, 429); }
    if (attente.essais >= ESSAIS_PAR_JETON) { deuxFacteurs.supprimerJeton(b.jeton); throw recommencer('Trop de codes incorrects : saisissez de nouveau votre mot de passe'); }
    attente.essais += 1; // essai décompté avant la vérification (requêtes simultanées)
    const resultat = await deuxFacteurs.verifierCode(user.id, b.code);
    if (!resultat) {
      const bloque = sessions.echec(cle);
      ctx.audit({ socket: req.socket }, 'echec_double_auth', 'users', user.id, `Code de vérification incorrect pour « ${user.login} »`);
      echecPoste(req);
      if (bloque) {
        deuxFacteurs.annulerAttentes(user.id);
        ctx.audit({ socket: req.socket }, 'blocage', 'users', user.id, `Blocage après des codes de vérification incorrects : « ${user.login} »`);
        notifierBlocage(user.login, poste.ip, { motif: 'Mot de passe correct mais trop de codes de vérification incorrects', action: 'echec_double_auth' });
        ctx.notify(user.id, { titre: 'Tentatives de connexion suspectes', message: 'Votre mot de passe a été saisi correctement, suivi de plusieurs codes de vérification incorrects. Si vous n\'êtes pas à l\'origine de ces tentatives, changez immédiatement votre mot de passe et prévenez le pôle informatique.', lien: '', type: 'alerte' });
        throw recommencer('Trop de codes de vérification incorrects : compte bloqué 10 minutes', 429);
      }
      const restants = ESSAIS_PAR_JETON - attente.essais;
      if (restants <= 0) { deuxFacteurs.supprimerJeton(b.jeton); throw recommencer('Trop de codes incorrects : saisissez de nouveau votre mot de passe'); }
      throw new HttpError(401, `Code incorrect ou déjà utilisé (${restants} essai${restants > 1 ? 's' : ''} restant${restants > 1 ? 's' : ''})`, { essaisRestants: restants });
    }
    deuxFacteurs.supprimerJeton(b.jeton);
    sessions.succes(cle);
    const secours = resultat.type === 'secours';
    const out = ouvrirSession(req, res, user, { deuxFacteurs: true, texte: secours ? `Double authentification par code de secours (${resultat.restants} restant(s))` : 'Double authentification par application' });
    if (secours) {
      out.connexion = { codeSecours: true, codesSecoursRestants: resultat.restants };
      ctx.notify(user.id, { titre: 'Code de secours utilisé', message: `Un code de secours a été utilisé pour vous connecter. Il vous en reste ${resultat.restants}.${resultat.restants <= 2 ? ' Générez de nouveaux codes depuis le menu de votre compte › Double authentification.' : ''}`, lien: '', type: resultat.restants <= 2 ? 'alerte' : 'info' });
    }
    return out;
  }, { public: true, maxBody: 16 * 1024 });

  router.post('/api/auth/logout', async (req, res) => {
    if (req.session) sessions.destroy(req.session.token);
    res.setHeader('Set-Cookie', 'gmao_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  }, { public: true, maxBody: 16 * 1024 });

  router.get('/api/auth/me', async (req) => bootstrap(req));

  router.get('/api/auth/infos', async () => {
    const c = db.getConfig();
    // L'aide « compte initial » n'est affichée que tant que l'administrateur n'a jamais été utilisé
    const admin = db.findOne('users', (u) => u.login === 'admin');
    const premierDemarrage = !!(admin && admin.doitChangerMdp && !admin.derniereConnexion && db.count('users') === 1);
    const soc = c.societe || {};
    const s = c.securite || {};
    return {
      societe: { nom: soc.nom, slogan: soc.slogan, logo: soc.logo }, general: { theme: (c.general || {}).theme, couleurPrincipale: (c.general || {}).couleurPrincipale, messageAccueil: (c.general || {}).messageAccueil }, version: ctx.version, premierDemarrage,
      // Écran de connexion : liens de réinitialisation et règles du mot de passe vérifiées en direct
      motDePasseOublie: s.motDePasseOublie !== false,
      reinitialisationAutonome: s.reinitialisationAutonome === true,
      politiqueMdp: { longueurMin: Math.max(4, Number(s.longueurMinMdp) || 10), complexite: s.complexite !== false, interdireIdentifiant: s.interdireIdentifiant !== false },
    };
  }, { public: true });

  // ----- Mot de passe oublié, codes de réinitialisation (routes publiques) ------------------------
  // Les routes de réinitialisation n'ouvrent jamais de session : le poste enchaîne une connexion normale
  // (mot de passe puis code de double authentification si elle est active).
  const ERREUR_REINIT = 'Identifiant ou code de réinitialisation incorrect, ou code expiré';
  const ERREUR_AUTONOME = 'Identifiant ou code de vérification incorrect, ou réinitialisation impossible pour ce compte';
  const secretFactice = totp.genererSecret();
  const corps = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? req.body : {});
  const lireLogin = (b) => (typeof b.login === 'string' ? b.login.trim().slice(0, 100) : '');
  const lireNouveau = (b) => (typeof b.nouveau === 'string' ? b.nouveau.slice(0, 500) : '');
  /** Compte de cet identifiant ; un identifiant hors du format des comptes est traité comme inconnu. */
  const trouverCompte = (login) => (login && RE_IDENTIFIANT.test(login) ? db.findOne('users', (u) => String(u.login).toLowerCase() === login.toLowerCase()) : null);
  /** Compteurs d'échecs : par poste + identifiant, et par identifiant seul (comme la connexion). */
  const clesReinit = (ip, login) => ['reinit|' + ip + '|' + login.toLowerCase(), 'reinit-compte|' + login.toLowerCase()];
  const verifierBlocages = (cles) => {
    const bloc = Math.max(0, ...cles.map((c) => sessions.blocage(c)));
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${minutes(bloc)} min`);
  };

  /** Échec d'une réinitialisation : compteurs, journal, blocage signalé au pôle informatique (et au titulaire). */
  function echecReinitialisation(req, login, user, cles, details, options = {}) {
    const ip = String(req.socket.remoteAddress || '');
    const bloque = cles.map((c) => sessions.echec(c)).some(Boolean);
    ctx.audit({ socket: req.socket }, 'echec_reinitialisation_mdp', 'users', user ? user.id : null, `${details} : identifiant « ${identifiantAffiche(login)} »${user ? '' : ' (inconnu)'}`);
    echecPoste(req);
    if (!bloque) return;
    ctx.audit({ socket: req.socket }, 'blocage', 'users', user ? user.id : null, `Blocage après des essais de réinitialisation incorrects : « ${identifiantAffiche(login)} »`);
    notifierBlocage(login, ip, { motif: options.motif || 'Trop de codes de réinitialisation incorrects', action: 'echec_reinitialisation_mdp' });
    if (options.autonome && user) {
      deuxFacteurs.annulerAttentes(user.id);
      ctx.notify(user.id, { titre: 'Tentatives de réinitialisation suspectes', message: 'Plusieurs codes de vérification incorrects ont été saisis pour réinitialiser votre mot de passe. Si vous n\'êtes pas à l\'origine de ces tentatives, prévenez le pôle informatique.', lien: '', type: 'alerte' });
    }
  }

  /** Effets d'une réinitialisation réussie : mot de passe enregistré, sessions fermées, demandes traitées, journal. */
  function appliquerReinitialisation(req, user, nouveau, { action, moyen }) {
    const u = db.update('users', user.id, motsDePasse.champsNouveau(user, nouveau, { doitChanger: false }));
    sessions.destroyUser(user.id);
    deuxFacteurs.annulerAttentes(user.id);
    motsDePasse.traiterDemandes(user.id, { mode: 'utilisateur', par: user.id });
    const ip = String(req.socket.remoteAddress || '');
    ctx.audit({ socket: req.socket, user: u }, action, 'users', user.id, `Mot de passe de « ${user.login} » réinitialisé ${moyen} depuis l'écran de connexion`);
    ctx.notify(user.id, { titre: 'Mot de passe réinitialisé', message: `Votre mot de passe a été réinitialisé ${moyen} le ${dateHeureFr(motsDePasse.maintenant())} depuis le poste ${ip || 'inconnu'} ; vos sessions ouvertes ont été fermées. Si vous n'êtes pas à l'origine de cette opération, prévenez immédiatement le pôle informatique.`, lien: '', type: 'alerte' });
    return u;
  }

  /**
   * Demande de réinitialisation depuis l'écran de connexion : même réponse que le compte existe ou non,
   * soit actif ou non (le traitement a lieu après la réponse) ; 5 demandes par poste en 15 minutes.
   */
  router.post('/api/auth/mot-de-passe-oublie', async (req) => {
    if (sec().motDePasseOublie === false) throw new HttpError(403, 'Les demandes de réinitialisation depuis l\'écran de connexion sont désactivées : contactez le pôle informatique.');
    const b = corps(req);
    const ip = String(req.socket.remoteAddress || '');
    const attente = sessions.quota('oubli|' + ip, DEMANDES_OUBLI_PAR_POSTE, FENETRE_DEMANDES_OUBLI_MS);
    if (attente > 0) throw new HttpError(429, `Trop de demandes depuis ce poste. Réessayez dans ${minutes(attente)} min`);
    const login = lireLogin(b);
    if (!login) throw new HttpError(400, 'Saisissez votre identifiant');
    const message = typeof b.message === 'string' ? texteBrut(b.message, 300) : '';
    const poste = String(req.headers['user-agent'] || '').slice(0, 200);
    setImmediate(() => {
      try { motsDePasse.enregistrerDemande({ login, message, ip, poste }); } catch (e) { log('Demande de réinitialisation non enregistrée', e && e.stack ? e.stack : e); }
    });
    return { ok: true };
  }, { public: true, maxBody: 16 * 1024 });

  /** Nouveau mot de passe avec un code de réinitialisation remis par le pôle informatique (usage unique). */
  router.post('/api/auth/reinitialiser', async (req) => {
    const b = corps(req);
    const login = lireLogin(b);
    const nouveau = lireNouveau(b);
    verifierPoste(req);
    const cles = clesReinit(String(req.socket.remoteAddress || ''), login);
    verifierBlocages(cles);
    const user = trouverCompte(login);
    const r = await motsDePasse.verifierCode(user, auth.normaliserCodeReinitialisation(b.code), req);
    if (!r.ok) {
      echecReinitialisation(req, login, user, cles, 'Code de réinitialisation incorrect ou expiré');
      throw new HttpError(400, ERREUR_REINIT);
    }
    // Code correct : la politique ne s'applique qu'ensuite (le code n'est pas consommé si le mot de passe est refusé)
    const refus = await motsDePasse.refus(db.get('users', user.id), nouveau);
    if (refus) throw new HttpError(400, refus);
    // Usage unique : le code doit être toujours le même au moment de l'enregistrement (requêtes simultanées)
    const actuel = db.get('users', user.id);
    if (!actuel || actuel.actif === false || !motsDePasse.codeValide(actuel) || actuel.reinitialisation.empreinte !== r.empreinte) throw new HttpError(400, ERREUR_REINIT);
    appliquerReinitialisation(req, actuel, nouveau, { action: 'reinitialisation_mdp_code', moyen: 'avec un code de réinitialisation' });
    for (const c of cles) sessions.succes(c);
    return { ok: true };
  }, { public: true, maxBody: 16 * 1024 });

  /**
   * Réinitialisation autonome (si la configuration l'autorise) : compte avec double authentification active,
   * code à 6 chiffres de l'application (jamais un code de secours), anti-rejeu.
   */
  router.post('/api/auth/reinitialiser-autonome', async (req) => {
    if (sec().reinitialisationAutonome !== true) throw new HttpError(403, 'La réinitialisation du mot de passe avec l\'application d\'authentification n\'est pas activée : contactez le pôle informatique.');
    const b = corps(req);
    const login = lireLogin(b);
    const nouveau = lireNouveau(b);
    verifierPoste(req);
    const user = trouverCompte(login);
    // Même blocage que les codes de vérification du compte, en plus des compteurs de réinitialisation
    const cles = clesReinit(String(req.socket.remoteAddress || ''), login).concat(user ? [cleCode(user.id)] : []);
    verifierBlocages(cles);
    const eligible = !!(user && user.actif !== false && deuxFacteurs.actif(user));
    // Compte inconnu ou sans double authentification : vérification factice (temps de réponse comparable)
    if (!eligible) totp.verifier(secretFactice, typeof b.code === 'string' ? b.code.slice(0, 40) : '', { instant: deuxFacteurs.maintenant() });
    const pas = eligible ? deuxFacteurs.verifierCodeApplication(user.id, b.code) : null;
    if (pas === null) {
      echecReinitialisation(req, login, user, cles, 'Code de l\'application incorrect (réinitialisation autonome)', { autonome: true, motif: 'Trop de codes de vérification incorrects (réinitialisation du mot de passe)' });
      throw new HttpError(400, ERREUR_AUTONOME);
    }
    const compte = db.get('users', user.id);
    const refus = await motsDePasse.refus(compte, nouveau);
    if (refus) throw new HttpError(400, refus);
    // Le code est consigné (anti-rejeu) au moment de l'enregistrement : il ne sert qu'une fois
    const actuel = db.get('users', user.id);
    const confirme = actuel && actuel.actif !== false && actuel.passwordHash === compte.passwordHash ? deuxFacteurs.verifierCodeApplication(actuel.id, b.code, { enregistrer: true }) : null;
    if (confirme === null) throw new HttpError(400, ERREUR_AUTONOME);
    const u = appliquerReinitialisation(req, db.get('users', user.id), nouveau, { action: 'reinitialisation_mdp_autonome', moyen: 'avec votre application d\'authentification' });
    for (const c of cles) sessions.succes(c);
    ctx.notify(ctx.usersAvecDroit('systeme', 'modifier').map((x) => x.id).filter((id) => id !== u.id), {
      titre: 'Mot de passe réinitialisé par l\'utilisateur',
      message: `${ctx.nomUser(u.id)} (${u.login}) a réinitialisé son mot de passe depuis l'écran de connexion avec son application d'authentification (poste ${req.socket.remoteAddress || 'inconnu'}).`,
      lien: '#/audit?action=reinitialisation_mdp_autonome', type: 'info',
    });
    return { ok: true };
  }, { public: true, maxBody: 16 * 1024 });


  // ----- Confirmations des opérations sensibles (mot de passe actuel, code de vérification) -----
  function echecConfirmation(req, details) {
    const bloque = sessions.echec(cleConfirmation(req.user.id));
    ctx.audit(req, 'echec_confirmation', 'users', req.user.id, details);
    if (bloque) ctx.audit(req, 'blocage', 'users', req.user.id, 'Blocage après des confirmations incorrectes');
  }
  function verifierBlocageConfirmation(req) {
    const bloc = sessions.blocage(cleConfirmation(req.user.id));
    if (bloc > 0) throw new HttpError(429, `Trop d'essais incorrects. Réessayez dans ${minutes(bloc)} min`);
  }
  function confirmerMotDePasse(req, motDePasse, message) {
    verifierBlocageConfirmation(req);
    const ok = typeof motDePasse === 'string' && motDePasse.length <= 500 && auth.verifyPassword(motDePasse, req.user.passwordHash);
    if (!ok) {
      echecConfirmation(req, 'Mot de passe actuel incorrect');
      throw new HttpError(400, message || 'Mot de passe incorrect');
    }
  }
  async function confirmerCode(req, code) {
    verifierBlocageConfirmation(req);
    const r = await deuxFacteurs.verifierCode(req.user.id, code);
    if (!r) {
      echecConfirmation(req, 'Code de vérification incorrect');
      throw new HttpError(400, 'Code de vérification incorrect ou déjà utilisé');
    }
    return r;
  }

  /**
   * Changement de son propre mot de passe (ancien mot de passe exigé sauf changement attendu) : politique,
   * historique, code de réinitialisation annulé, demandes en attente traitées, autres sessions fermées.
   */
  router.post('/api/auth/mot-de-passe', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { ancien } = b;
    const nouveau = typeof b.nouveau === 'string' ? b.nouveau.slice(0, 500) : b.nouveau;
    if (motsDePasse.ancienRequis(req.user, req.session)) {
      if (typeof ancien !== 'string' || !ancien) throw new HttpError(400, 'Saisissez votre mot de passe actuel');
      confirmerMotDePasse(req, ancien, 'Ancien mot de passe incorrect');
    }
    const refus = typeof nouveau === 'string' ? await motsDePasse.refus(req.user, nouveau) : auth.validerMotDePasse(nouveau, db.getConfig(), { login: req.user.login });
    if (refus) throw new HttpError(400, refus);
    const actuel = db.get('users', req.user.id);
    if (!actuel || actuel.passwordHash !== req.user.passwordHash) throw new HttpError(409, 'Le mot de passe a été modifié entre-temps : recommencez');
    const raison = motsDePasse.raison(actuel);
    db.update('users', req.user.id, motsDePasse.champsNouveau(actuel, nouveau, { doitChanger: false }));
    sessions.destroyUserSauf(req.user.id, req.session.token); // les autres postes connectés sont déconnectés
    deuxFacteurs.annulerAttentes(req.user.id);
    motsDePasse.traiterDemandes(req.user.id, { mode: 'utilisateur', par: req.user.id });
    ctx.audit(req, 'changement_mdp', 'users', req.user.id, raison ? `Changement attendu (${LIBELLES_RAISON[raison]})` : '');
    return { ok: true };
  }, { maxBody: 16 * 1024 });

  // ----- Double authentification : enrôlement par l'utilisateur lui-même -----

  /** Étape 1 : nouvelle clé en attente (après confirmation du mot de passe) ; renvoyée une seule fois pour le QR code. */
  router.post('/api/auth/2fa/preparer', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (deuxFacteurs.actif(req.user)) throw new HttpError(400, 'La double authentification est déjà active sur votre compte');
    confirmerMotDePasse(req, b.motDePasse);
    const secret = totp.genererSecret();
    const d = Object.assign({}, req.user.deuxFacteurs || {}, { actif: false, secretEnAttente: deuxFacteurs.chiffrer(secret), prepareLe: new Date(deuxFacteurs.maintenant()).toISOString() });
    db.update('users', req.user.id, { deuxFacteurs: d });
    return {
      secret, cleManuelle: totp.grouperSecret(secret), uri: totp.uriOtpauth(req.user.login, secret),
      emetteur: totp.EMETTEUR, compte: req.user.login, algorithme: 'SHA1', chiffres: totp.CHIFFRES, periode: totp.PAS_SECONDES,
    };
  }, { maxBody: 16 * 1024 });

  /** Étape 2 : confirmation par un premier code ; les 10 codes de secours sont renvoyés une seule fois. */
  router.post('/api/auth/2fa/activer', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (deuxFacteurs.actif(req.user)) throw new HttpError(400, 'La double authentification est déjà active sur votre compte');
    const d = req.user.deuxFacteurs || {};
    if (!d.secretEnAttente) throw new HttpError(400, 'Aucune activation en cours : recommencez la procédure');
    const prepare = Date.parse(d.prepareLe || '');
    if (!Number.isFinite(prepare) || deuxFacteurs.maintenant() - prepare > PREPARATION_DEUX_FACTEURS_MS) throw new HttpError(400, 'La procédure d\'activation a expiré : recommencez');
    verifierBlocageConfirmation(req);
    let secret;
    try { secret = deuxFacteurs.dechiffrer(d.secretEnAttente); } catch (e) { throw new HttpError(400, 'Activation impossible : recommencez la procédure'); }
    const pas = typeof b.code === 'string' || typeof b.code === 'number' ? totp.verifier(secret, String(b.code), { instant: deuxFacteurs.maintenant() }) : null;
    if (pas === null) {
      echecConfirmation(req, 'Code incorrect lors de l\'activation de la double authentification');
      throw new HttpError(400, 'Code incorrect : vérifiez que l\'heure de votre téléphone est exacte et saisissez le code affiché');
    }
    const secours = await deuxFacteurs.nouveauxCodesSecours();
    // Relecture après le calcul : la procédure ne doit pas avoir changé entre-temps
    const actuel = db.get('users', req.user.id);
    if (!actuel || deuxFacteurs.actif(actuel) || (actuel.deuxFacteurs || {}).secretEnAttente !== d.secretEnAttente) throw new HttpError(409, 'La procédure d\'activation a changé entre-temps : recommencez');
    db.update('users', req.user.id, {
      deuxFacteurs: { actif: true, secret: d.secretEnAttente, activeLe: new Date().toISOString(), dernierPas: pas },
      codesSecours: secours.empreintes,
    });
    sessions.succes(cleConfirmation(req.user.id));
    sessions.destroyUserSauf(req.user.id, req.session.token); // les autres postes devront se reconnecter avec un code
    deuxFacteurs.annulerAttentes(req.user.id);
    ctx.audit(req, 'activation_double_auth', 'users', req.user.id, 'Double authentification activée');
    return { ok: true, codesSecours: secours.codes };
  }, { maxBody: 16 * 1024 });

  /** Désactivation par l'utilisateur : mot de passe et code (application ou code de secours) exigés. */
  router.post('/api/auth/2fa/desactiver', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (!deuxFacteurs.actif(req.user)) throw new HttpError(400, 'La double authentification n\'est pas active sur votre compte');
    confirmerMotDePasse(req, b.motDePasse);
    await confirmerCode(req, b.code);
    db.update('users', req.user.id, { deuxFacteurs: { actif: false, desactiveLe: new Date().toISOString() }, codesSecours: [] });
    deuxFacteurs.annulerAttentes(req.user.id);
    ctx.audit(req, 'desactivation_double_auth', 'users', req.user.id, 'Double authentification désactivée par l\'utilisateur');
    const u = db.get('users', req.user.id);
    return { ok: true, exige: deuxFacteurs.exige(u, req.perms) };
  }, { maxBody: 16 * 1024 });

  /** Nouveaux codes de secours (les anciens deviennent invalides) : mot de passe et code exigés. */
  router.post('/api/auth/2fa/codes-secours', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (!deuxFacteurs.actif(req.user)) throw new HttpError(400, 'La double authentification n\'est pas active sur votre compte');
    confirmerMotDePasse(req, b.motDePasse);
    await confirmerCode(req, b.code);
    const secours = await deuxFacteurs.nouveauxCodesSecours();
    db.update('users', req.user.id, { codesSecours: secours.empreintes });
    ctx.audit(req, 'codes_secours', 'users', req.user.id, 'Nouveaux codes de secours générés');
    return { ok: true, codesSecours: secours.codes };
  }, { maxBody: 16 * 1024 });

  /** Préférences personnelles (thème, etc.) : clés simples, valeurs scalaires courtes uniquement. */
  router.put('/api/auth/preferences', async (req) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? req.body : {};
    const prefs = Object.assign({}, req.user.preferences || {});
    for (const [k, v] of Object.entries(b)) {
      if (!/^[a-zA-Z]\w{0,40}$/.test(k)) continue;
      if (k === 'theme') {
        if (!['clair', 'sombre', 'auto'].includes(v)) throw new HttpError(400, 'Thème inconnu');
        prefs.theme = v;
      } else if (v === null) delete prefs[k];
      else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) prefs[k] = v;
    }
    if (Object.keys(prefs).length > 50) throw new HttpError(400, 'Trop de préférences enregistrées');
    db.update('users', req.user.id, { preferences: prefs });
    return prefs;
  }, { maxBody: 64 * 1024 });

  /** Notifications de l'utilisateur courant. */
  router.get('/api/notifications', async (req) => {
    const rows = db.list('notifications', (n) => n.userId === req.user.id).sort((a, b) => (a.date < b.date ? 1 : -1));
    return { nonLues: rows.filter((n) => !n.lu).length, notifications: rows.slice(0, 50) };
  });
  router.post('/api/notifications/lues', async (req) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : null;
    for (const n of db.data.collections.notifications) {
      if (n.userId === req.user.id && (!ids || ids.includes(n.id))) n.lu = true;
    }
    db.touch();
    return { ok: true };
  });

  /**
   * Service de l'application de bureau (mode serveur) : récupération d'urgence d'un compte du pôle
   * informatique ou administrateur depuis le poste serveur, après le code du pôle informatique.
   */
  /** Comptes actifs récupérables : administrateurs et droit Système › Modifier. */
  const comptesRecuperables = () => {
    const config = db.getConfig();
    return db.list('users', (u) => u.actif !== false).filter((u) => {
      const p = perms.effectivePermissions(db, u, null, config);
      return p.estAdmin || perms.can(p, 'systeme', 'modifier');
    }).map((u) => ({ login: u.login, nom: ctx.nomUser(u.id) })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  };
  ctx.services.motsDePasse = {
    comptesRecuperables,
    /**
     * Code de réinitialisation à usage unique pour un compte récupérable (renvoyé une seule fois) ;
     * journalisé et signalé à tout le pôle informatique. La double authentification reste exigée à la connexion.
     * @returns {{login:string, nom:string, code:string, expireLe:string}}
     */
    recuperationUrgence({ login, origine } = {}) {
      const cible = typeof login === 'string' ? login.trim().toLowerCase() : '';
      if (!cible || !comptesRecuperables().some((c) => c.login.toLowerCase() === cible)) throw new HttpError(400, 'Compte introuvable ou non récupérable (administrateur ou pôle informatique actif uniquement)');
      const user = db.findOne('users', (u) => String(u.login).toLowerCase() === cible);
      const { code, expireLe } = motsDePasse.poserCode(user, { creePar: null, origine: 'recuperation_urgence' });
      motsDePasse.traiterDemandes(user.id, { mode: 'code', par: null });
      const depuis = texteBrut(origine || 'Poste serveur', 80) || 'Poste serveur';
      ctx.audit({ user: { id: null, login: depuis } }, 'recuperation_urgence', 'users', user.id, `Code de récupération d'urgence généré pour « ${user.login} » (${depuis}), valable jusqu'au ${dateHeureFr(expireLe)}`);
      ctx.notify(ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id), {
        titre: 'Récupération d\'urgence d\'un compte',
        message: `Un code de réinitialisation du mot de passe de ${ctx.nomUser(user.id)} (${user.login}) a été généré depuis le poste serveur (${depuis}) le ${dateHeureFr(motsDePasse.maintenant())}. Si cette opération n'était pas prévue, vérifiez immédiatement l'accès au poste serveur.`,
        lien: '#/audit?action=recuperation_urgence', type: 'alerte',
      });
      return { login: user.login, nom: ctx.nomUser(user.id), code, expireLe };
    },
  };

  /** Liste des vues client (fichiers client/js/views/*.js) pour chargement dynamique. */
  router.get('/api/views', async () => {
    const lister = (sous) => {
      const dir = path.join(ctx.clientDir, 'js', sous);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => `/js/${sous}/${f}`);
    };
    // Bibliothèques partagées (client/js/lib) chargées avant les vues (client/js/views)
    return { libs: lister('lib'), vues: lister('views') };
  }, { public: true });
}

module.exports = { createApp, HttpError };
