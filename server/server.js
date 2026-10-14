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
  const LIBELLES_ACTION = { creation: 'Création', suppression: 'Suppression', modification: 'Modification', desactivation: 'Désactivation', restauration: 'Restauration', import: 'Import de données', reinitialisation_mdp: 'Réinitialisation de mot de passe', validation: 'Validation', cloture: 'Clôture' };
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

  // Nettoyage périodique des sessions
  const sweeper = setInterval(() => sessions.sweep(), 10 * 60 * 1000);
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

  const server = http.createServer(handler);

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

/** Routes d'authentification, d'amorçage et de profil personnel. */
function registerCoreRoutes(ctx) {
  const { router, db, sessions, HttpError } = ctx;

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
      config,
      modules,
      catalogue: { modules: perms.MODULES, actions: perms.ACTIONS, portees: perms.PORTEES, modesSite: perms.MODES_SITE },
      references: { secteurs, profils, users },
      version: ctx.version,
      serveur: { heure: new Date().toISOString() },
    };
  }

  /** Prévient le pôle informatique (droit Système › Modifier) d'un blocage de compte. */
  function notifierBlocage(login, ip) {
    if ((db.getConfig().securite || {}).notifierBlocages === false) return;
    const ids = ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id);
    ctx.notify(ids, { titre: 'Compte temporairement bloqué', message: `Trop de mots de passe incorrects pour l'identifiant « ${String(login).slice(0, 60)} » depuis ${ip || 'un poste inconnu'}. Accès bloqué 10 minutes.`, lien: '#/audit?action=echec_connexion', type: 'alerte' });
  }

  router.post('/api/auth/login', async (req, res) => {
    const b = req.body || {};
    const login = typeof b.login === 'string' ? b.login.trim().slice(0, 100) : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, 500) : '';
    const ip = String(req.socket.remoteAddress || '');
    // Deux compteurs : par poste + identifiant, et par identifiant seul (attaque depuis plusieurs postes)
    const clePoste = ip + '|' + login.toLowerCase();
    const cleCompte = 'compte|' + login.toLowerCase();
    const bloc = Math.max(sessions.blocage(clePoste), sessions.blocage(cleCompte));
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil(bloc / 60)} min`);
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
    const token = sessions.create(user.id, { ua: String(req.headers['user-agent'] || '').slice(0, 300), ip });
    db.update('users', user.id, { derniereConnexion: new Date().toISOString() });
    const securise = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `gmao_session=${token}; Path=/; HttpOnly; SameSite=Strict${securise}; Max-Age=${Math.floor(sessions.dureeMaxMs() / 1000)}`);
    req.user = db.get('users', user.id);
    req.profil = db.get('profils', req.user.profilId);
    req.perms = perms.effectivePermissions(db, req.user, req.profil, db.getConfig());
    perms.appliquerSiteCourant(db, req.perms, req.headers['x-gmao-site']);
    ctx.audit(req, 'connexion', 'users', user.id, '');
    return bootstrap(req);
  }, { public: true });

  router.post('/api/auth/logout', async (req, res) => {
    if (req.session) sessions.destroy(req.session.token);
    res.setHeader('Set-Cookie', 'gmao_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  }, { public: true });

  router.get('/api/auth/me', async (req) => bootstrap(req));

  router.get('/api/auth/infos', async () => {
    const c = db.getConfig();
    // L'aide « compte initial » n'est affichée que tant que l'administrateur n'a jamais été utilisé
    const admin = db.findOne('users', (u) => u.login === 'admin');
    const premierDemarrage = !!(admin && admin.doitChangerMdp && !admin.derniereConnexion && db.count('users') === 1);
    const soc = c.societe || {};
    return { societe: { nom: soc.nom, slogan: soc.slogan, logo: soc.logo }, general: { theme: (c.general || {}).theme, couleurPrincipale: (c.general || {}).couleurPrincipale, messageAccueil: (c.general || {}).messageAccueil }, version: ctx.version, premierDemarrage };
  }, { public: true });

  /** Changement de son propre mot de passe. */
  router.post('/api/auth/mot-de-passe', async (req) => {
    const { ancien, nouveau } = req.body || {};
    if (!req.user.doitChangerMdp && !auth.verifyPassword(ancien, req.user.passwordHash)) throw new HttpError(400, 'Ancien mot de passe incorrect');
    const err = auth.validerMotDePasse(nouveau, db.getConfig(), { login: req.user.login });
    if (err) throw new HttpError(400, err);
    if (auth.verifyPassword(nouveau, req.user.passwordHash)) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien');
    db.update('users', req.user.id, { passwordHash: auth.hashPassword(nouveau), doitChangerMdp: false, dateMdp: new Date().toISOString() });
    sessions.destroyUserSauf(req.user.id, req.session.token); // les autres postes connectés sont déconnectés
    ctx.audit(req, 'changement_mdp', 'users', req.user.id, '');
    return { ok: true };
  });

  /** Préférences personnelles (thème, etc.). */
  router.put('/api/auth/preferences', async (req) => {
    const prefs = Object.assign({}, req.user.preferences || {}, req.body || {});
    db.update('users', req.user.id, { preferences: prefs });
    return prefs;
  });

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
