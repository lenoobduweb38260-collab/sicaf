'use strict';
/**
 * Serveur HTTP de la GMAO : fichiers statiques du client + API JSON.
 * Aucune dépendance externe (modules Node intégrés uniquement).
 */
const http = require('http');
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Requête trop volumineuse')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Crée l'application.
 * @param {{dataDir?:string, inMemory?:boolean, adminPassword?:string, log?:Function}} options
 */
function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.GMAO_DATA_DIR || path.join(__dirname, '..', 'data');
  const db = new Db(dataDir, { inMemory: !!options.inMemory, saveDelay: options.saveDelay }).load();
  seed(db, { adminPassword: options.adminPassword });
  const sessions = new auth.Sessions();
  const router = new Router();
  const log = options.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const hooks = {}; // événements inter-modules : ctx.on('ot:cree', fn) / ctx.emit('ot:cree', data)

  const ctx = {
    db, router, sessions, perms, auth, HttpError, log, dataDir,
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
      const raw = await readBody(req);
      const ct = String(req.headers['content-type'] || '');
      if (raw.length && ct.includes('application/json')) {
        try { req.body = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON invalide'); }
      } else if (raw.length && ct.includes('text/')) {
        req.body = raw.toString('utf8');
      } else {
        req.body = raw.length ? raw : {};
      }
      // Protection CSRF simple : en-tête personnalisé obligatoire pour les mutations
      if (!route.opts.public && req.headers['x-requested-with'] !== 'GMAO') {
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
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(CLIENT_DIR, p));
    if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end('Accès refusé'); }
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

  function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        if (res.writableEnded) return;
        if (err instanceof HttpError) {
          sendJson(res, err.status, { erreur: err.message, details: err.details });
        } else {
          log('Erreur serveur', req.method, url.pathname, err && err.stack ? err.stack : err);
          sendJson(res, 500, { erreur: 'Erreur interne : ' + (err && err.message ? err.message : String(err)) });
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

  router.post('/api/auth/login', async (req, res) => {
    const { login, password } = req.body || {};
    const cle = String(req.socket.remoteAddress || '') + '|' + String(login || '').toLowerCase();
    const bloc = sessions.blocage(cle);
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${bloc} s`);
    const user = db.findOne('users', (u) => String(u.login).toLowerCase() === String(login || '').toLowerCase());
    if (!user || !auth.verifyPassword(password, user.passwordHash)) {
      sessions.echec(cle);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
    }
    if (user.actif === false) throw new HttpError(403, 'Ce compte est désactivé');
    sessions.succes(cle);
    const token = sessions.create(user.id, { ua: req.headers['user-agent'] });
    db.update('users', user.id, { derniereConnexion: new Date().toISOString() });
    res.setHeader('Set-Cookie', `gmao_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(auth.SESSION_DUREE_MS / 1000)}`);
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
    return { societe: c.societe || {}, general: { theme: (c.general || {}).theme, couleurPrincipale: (c.general || {}).couleurPrincipale, messageAccueil: (c.general || {}).messageAccueil }, version: ctx.version };
  }, { public: true });

  /** Changement de son propre mot de passe. */
  router.post('/api/auth/mot-de-passe', async (req) => {
    const { ancien, nouveau } = req.body || {};
    if (!req.user.doitChangerMdp && !auth.verifyPassword(ancien, req.user.passwordHash)) throw new HttpError(400, 'Ancien mot de passe incorrect');
    const err = auth.validerMotDePasse(nouveau, db.getConfig());
    if (err) throw new HttpError(400, err);
    db.update('users', req.user.id, { passwordHash: auth.hashPassword(nouveau), doitChangerMdp: false });
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
