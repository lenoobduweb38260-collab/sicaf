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
const auth = require('./auth');
const totp = require('./totp');
const perms = require('./permissions');
const { seed } = require('./seed');
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data === undefined ? null : data);
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
  const db = new Db(dataDir, { inMemory: !!options.inMemory, saveDelay: options.saveDelay }).load();
  seed(db, { adminPassword: options.adminPassword });
  const sec = () => (db.getConfig().securite || {});
  const sessions = new auth.Sessions({
    inactiviteMs: () => Math.max(5, Number(sec().inactiviteMinutes) || 60) * 60 * 1000,
    dureeMaxMs: () => Math.max(1, Number(sec().dureeSessionHeures) || 12) * 60 * 60 * 1000,
  });
  const router = new Router();
  const log = options.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const hooks = {}; // événements inter-modules : ctx.on('ot:cree', fn) / ctx.emit('ot:cree', data)

  const ctx = {
    db, router, sessions, perms, auth, HttpError, log, dataDir,
    /** Vrai quand le serveur tourne dans l'application de bureau (accès navigateur contrôlé). */
    bureau: !!options.bureau,
    clientDir: CLIENT_DIR,
    version: require('../package.json').version,
    /** Services publiés par les modules (ex. ctx.services.stock.sortir), consultés au moment des requêtes. */
    services: {},

    /** Configuration courante (copie). */
    config() { return db.getConfig(); },

    /** Liste de valeurs configurée (ex. 'statutsOT'). */
    liste(nom) {
      const l = (db.getConfig().listes || {})[nom];
      return Array.isArray(l) ? l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
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

    /** Journal d'audit. */
    audit(req, action, entite, entiteId, details) {
      const col = db.data.collections.audit;
      col.push({
        id: db.nextId('audit'),
        date: new Date().toISOString(),
        userId: req && req.user ? req.user.id : null,
        userNom: req && req.user ? `${req.user.prenom || ''} ${req.user.nom || ''}`.trim() || req.user.login : 'système',
        action, entite, entiteId: entiteId == null ? null : entiteId,
        details: details == null ? '' : (typeof details === 'string' ? details : JSON.stringify(details)),
        ip: req && req.socket ? req.socket.remoteAddress : '',
      });
      if (col.length > AUDIT_MAX) col.splice(0, col.length - AUDIT_MAX);
      db.touch();
      try { notifierJournal(req, action, entite, entiteId, details); } catch (e) { log('Notification du journal impossible', e.message); }
    },

    /** Notification interne pour un ou plusieurs utilisateurs. */
    notify(userIds, { titre, message, lien, type }) {
      const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x) => x != null).map(Number)));
      const col = db.data.collections.notifications;
      for (const uid of ids) {
        col.push({ id: db.nextId('notifications'), userId: uid, titre: titre || '', message: message || '', lien: lien || '', type: type || 'info', lu: false, date: new Date().toISOString() });
      }
      if (col.length > NOTIF_MAX) col.splice(0, col.length - NOTIF_MAX);
      if (ids.length) db.touch();
    },

    /** Utilisateurs possédant une permission donnée (actifs). */
    usersAvecDroit(module, action, filtre) {
      const config = db.getConfig();
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
      const defs = ((db.getConfig().champsPersonnalises || {})[entite]) || [];
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
  const LIBELLES_ACTION = { creation: 'Création', suppression: 'Suppression', modification: 'Modification', desactivation: 'Désactivation', restauration: 'Restauration', import: 'Import de données', reinitialisation_mdp: 'Réinitialisation de mot de passe', validation: 'Validation', cloture: 'Clôture',
    activation_double_auth: 'Activation de la double authentification', desactivation_double_auth: 'Désactivation de la double authentification',
    reinitialisation_double_auth: 'Réinitialisation de la double authentification', codes_secours: 'Nouveaux codes de secours', echec_double_auth: 'Code de vérification incorrect' };
  const LIBELLES_ENTITE = { users: 'Utilisateurs', profils: 'Profils', secteurs: 'Secteurs', configuration: 'Configuration', equipements: 'Équipements', demandes: 'Demandes', ot: 'Ordres de travail', plansPreventifs: 'Préventif', articles: 'Stock', fournisseurs: 'Fournisseurs', plans: 'Plans 3D', inventaires: 'Inventaires', commandes: 'Commandes', factures: 'Factures', personnel: 'Personnel', visites: 'Audits & visites' };
  function notifierJournal(req, action, entite, entiteId, details) {
    const j = db.getConfig().journal || {};
    if (!j.notifications || !Array.isArray(j.actions) || !j.actions.includes(action)) return;
    if (Array.isArray(j.entites) && j.entites.length && !j.entites.includes(entite)) return;
    const profils = new Set((j.profilsNotifies || []).map(Number));
    if (!profils.size) return;
    const auteurId = req && req.user ? req.user.id : null;
    const auteur = req && req.user ? (`${req.user.prenom || ''} ${req.user.nom || ''}`.trim() || req.user.login) : 'système';
    const dest = db.list('users', (u) => u.actif !== false && profils.has(Number(u.profilId)) && u.id !== auteurId);
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

  // Nettoyage périodique des sessions et des connexions en deux étapes inachevées
  const sweeper = setInterval(() => { sessions.sweep(); ctx.deuxFacteurs.purger(); }, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  async function handleApi(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Route inconnue : ' + req.method + ' ' + url.pathname);
    if (match.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée');
    const { route, params } = match;
    req.params = params;
    req.query = Object.fromEntries(url.searchParams.entries());

    // Corps JSON
    if (req.method !== 'GET' && req.method !== 'HEAD') {
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
      req.perms = perms.effectivePermissions(db, req.user, req.profil, db.getConfig());
      perms.appliquerSiteCourant(db, req.perms, req.headers['x-gmao-site']);
    }

    if (!route.opts.public && !req.user) throw new HttpError(401, 'Authentification requise');
    // Double authentification obligatoire pour ce compte mais pas encore activée : seules les routes
    // d'authentification (profil, mot de passe, enrôlement) restent accessibles.
    if (req.user && !route.opts.public && !url.pathname.startsWith('/api/auth/') && ctx.deuxFacteurs.enrolementRequis(req.user, req.perms)) {
      throw new HttpError(403, 'La double authentification est obligatoire pour votre compte : activez-la pour continuer.', { deuxFacteursRequis: true });
    }
    if (route.opts.perm) ctx.requirePerm(req, route.opts.perm[0], route.opts.perm[1]);

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
    const reseau = db.getConfig().reseau || {};
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
    const noms = ((db.getConfig().reseau || {}).nomsAutorises || []).map((n) => String(n).toLowerCase().trim()).filter(Boolean);
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
          sendJson(res, err.status, { erreur: err.message, details: err.details });
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
      db.saveNow();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Modes de la double authentification (config.securite.deuxFacteurs). */
const MODES_DEUX_FACTEURS = ['facultatif', 'obligatoire_sensibles', 'obligatoire_tous'];
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
      const d = p || droits.effectivePermissions(db, user, null, db.getConfig());
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
      const d = user.deuxFacteurs;
      if (totp.normaliserCode(saisi)) {
        let secret = null;
        try { secret = d.secret ? coffre.dechiffrer(d.secret) : null; } catch (e) {
          log('Double authentification : clé du compte n°' + user.id + ' indéchiffrable (base provenant d\'un autre serveur ?)');
        }
        if (!secret) return null;
        const pas = totp.verifier(secret, saisi, { instant: df.maintenant(), dernierPas: d.dernierPas });
        if (pas === null) return null;
        db.update('users', user.id, { deuxFacteurs: Object.assign({}, d, { dernierPas: pas, derniereUtilisation: new Date().toISOString() }) });
        return { type: 'application' };
      }
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

    /** Nouveaux codes de secours : `codes` en clair (affichés une seule fois) et `empreintes` (stockées). */
    async nouveauxCodesSecours() {
      const codes = totp.genererCodesSecours();
      const empreintes = await Promise.all(codes.map((c) => totp.empreinteCodeSecours(c)));
      return { codes, empreintes };
    },
  };
  return df;
}

/** Routes d'authentification (connexion en une ou deux étapes, double authentification), d'amorçage et de profil personnel. */
function registerCoreRoutes(ctx) {
  const { router, db, sessions, HttpError } = ctx;
  const deuxFacteurs = ctx.deuxFacteurs = installerDeuxFacteurs(ctx);

  function bootstrap(req) {
    const config = db.getConfig();
    // Les secrets de sauvegarde ne sont jamais envoyés au navigateur
    if (config.sauvegardes) { delete config.sauvegardes.cleReception; delete config.sauvegardes.destinations; delete config.sauvegardes.motDePasseChiffrement; }
    const modules = perms.modulesConfigures(config);
    const secteurs = db.list('secteurs').sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || a.nom.localeCompare(b.nom))
      .map((s) => Object.assign({}, s, { siteId: perms.siteDuSecteur(db, s.id) }));
    const profils = db.list('profils').map((p) => ({ id: p.id, nom: p.nom, niveau: p.niveau, couleur: p.couleur, secteurId: p.secteurId, estAdmin: !!p.estAdmin, portee: p.portee, actif: p.actif !== false }));
    const users = db.list('users').map((u) => ({ id: u.id, login: u.login, nom: u.nom, prenom: u.prenom, profilId: u.profilId, secteurIds: u.secteurIds || [], siteAcces: u.siteAcces || [], managerId: u.managerId, actif: u.actif !== false, fonction: u.fonction || '' }));
    return {
      user: auth.cleanUser(req.user),
      permissions: req.perms,
      deuxFacteurs: deuxFacteurs.etat(req.user, req.perms),
      config,
      modules,
      catalogue: { modules: perms.MODULES, actions: perms.ACTIONS, portees: perms.PORTEES, modesSite: perms.MODES_SITE },
      references: { secteurs, profils, users },
      version: ctx.version,
      serveur: { heure: new Date().toISOString() },
    };
  }

  /** Prévient le pôle informatique (droit Système › Modifier) d'un blocage de compte. */
  function notifierBlocage(login, ip, options = {}) {
    if ((db.getConfig().securite || {}).notifierBlocages === false) return;
    const ids = ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id);
    const motif = options.motif || 'Trop de mots de passe incorrects';
    ctx.notify(ids, { titre: 'Compte temporairement bloqué', message: `${motif} pour l'identifiant « ${String(login).slice(0, 60)} » depuis ${ip || 'un poste inconnu'}. Accès bloqué 10 minutes.`, lien: '#/audit?action=' + (options.action || 'echec_connexion'), type: 'alerte' });
  }

  /** Poste à l'origine de la requête : une connexion en attente du code reste liée à ce poste. */
  function posteDe(req) {
    return { ip: String(req.socket.remoteAddress || ''), ua: String(req.headers['user-agent'] || '').slice(0, 300) };
  }

  /** Ouvre la session (cookie), journalise la connexion et renvoie l'amorçage. */
  function ouvrirSession(req, res, user, details = {}) {
    const poste = posteDe(req);
    const token = sessions.create(user.id, { ua: poste.ua, ip: poste.ip, deuxFacteurs: !!details.deuxFacteurs });
    db.update('users', user.id, { derniereConnexion: new Date().toISOString() });
    const securise = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `gmao_session=${token}; Path=/; HttpOnly; SameSite=Strict${securise}; Max-Age=${Math.floor(sessions.dureeMaxMs() / 1000)}`);
    req.user = db.get('users', user.id);
    req.profil = db.get('profils', req.user.profilId);
    req.perms = perms.effectivePermissions(db, req.user, req.profil, db.getConfig());
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
    // Deux compteurs : par poste + identifiant, et par identifiant seul (attaque depuis plusieurs postes)
    const clePoste = ip + '|' + login.toLowerCase();
    const cleCompte = 'compte|' + login.toLowerCase();
    const bloc = Math.max(sessions.blocage(clePoste), sessions.blocage(cleCompte));
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${minutes(bloc)} min`);
    const user = login ? db.findOne('users', (u) => String(u.login).toLowerCase() === login.toLowerCase()) : null;
    // Vérification exécutée même si le compte n'existe pas (temps de réponse identique)
    const ok = auth.verifyPassword(password, user ? user.passwordHash : 'scrypt$00$00') && !!user;
    if (!ok) {
      const bloquePoste = sessions.echec(clePoste);
      const bloqueCompte = sessions.echec(cleCompte);
      ctx.audit({ socket: req.socket }, 'echec_connexion', 'users', user ? user.id : null, `Identifiant « ${login.slice(0, 60)} »${user ? '' : ' (inconnu)'}`);
      if (bloquePoste || bloqueCompte) {
        ctx.audit({ socket: req.socket }, 'blocage', 'users', user ? user.id : null, `Blocage après échecs répétés : « ${login.slice(0, 60)} »`);
        notifierBlocage(login, ip);
      }
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
    return { societe: { nom: soc.nom, slogan: soc.slogan, logo: soc.logo }, general: { theme: (c.general || {}).theme, couleurPrincipale: (c.general || {}).couleurPrincipale, messageAccueil: (c.general || {}).messageAccueil }, version: ctx.version, premierDemarrage };
  }, { public: true });

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

  /** Changement de son propre mot de passe. */
  router.post('/api/auth/mot-de-passe', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { ancien, nouveau } = b;
    if (!req.user.doitChangerMdp) confirmerMotDePasse(req, ancien, 'Ancien mot de passe incorrect');
    const err = auth.validerMotDePasse(nouveau, db.getConfig(), { login: req.user.login });
    if (err) throw new HttpError(400, err);
    if (auth.verifyPassword(nouveau, req.user.passwordHash)) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien');
    db.update('users', req.user.id, { passwordHash: auth.hashPassword(nouveau), doitChangerMdp: false, dateMdp: new Date().toISOString() });
    sessions.destroyUserSauf(req.user.id, req.session.token); // les autres postes connectés sont déconnectés
    deuxFacteurs.annulerAttentes(req.user.id);
    ctx.audit(req, 'changement_mdp', 'users', req.user.id, '');
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
