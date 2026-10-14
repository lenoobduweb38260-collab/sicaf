'use strict';
/**
 * Module Système & informatique (réservé au pôle informatique, droits « systeme ») :
 * réseau (accès par navigateur), postes et sessions connectés, informations du serveur.
 * Les routes de base de données (sauvegardes, export, import, restauration) sont dans configuration.js
 * avec les droits « systeme » ; les sauvegardes multi-destinations dans sauvegardes.js.
 */
const os = require('os');
const crypto = require('crypto');

const nom = 'Système';

/** Identifiant public d'une session (jamais le jeton lui-même). */
function idSession(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16); }

function register(ctx) {
  const { router, db, HttpError, sessions } = ctx;

  function adresses() {
    const out = [];
    for (const [iface, liste] of Object.entries(os.networkInterfaces())) {
      for (const i of liste || []) if (i.family === 'IPv4' && !i.internal) out.push({ interface: iface, adresse: i.address });
    }
    return out;
  }

  function listeSessions(req) {
    const out = [];
    for (const [token, s] of sessions.map) {
      const u = db.get('users', s.userId);
      const ua = (s.info && s.info.ua) || '';
      out.push({
        id: idSession(token), userId: s.userId, login: u ? u.login : '?', nom: u ? `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login : '?',
        ip: (s.info && s.info.ip) || '', poste: /GMAO-SICAF-Bureau\//.test(ua) ? 'Application GMAO' : 'Navigateur web',
        connexion: new Date(s.createdAt).toISOString(), derniereActivite: new Date(s.lastSeen).toISOString(),
        courante: req.session && req.session.token === token,
      });
    }
    return out.sort((a, b) => (a.derniereActivite < b.derniereActivite ? 1 : -1));
  }

  router.get('/api/systeme/reseau', async (req) => {
    const cfg = db.getConfig();
    const adr = req.socket.address ? req.socket.address() : {};
    return {
      accesNavigateur: !!(cfg.reseau && cfg.reseau.accesNavigateur),
      applicationBureau: ctx.bureau,
      port: adr && adr.port ? adr.port : null,
      nomPoste: os.hostname(),
      adresses: adresses(),
      sessions: listeSessions(req),
    };
  }, { perm: ['systeme', 'voir'] });

  router.put('/api/systeme/reseau', async (req) => {
    const b = req.body || {};
    const cfg = db.getConfig();
    cfg.reseau = Object.assign({}, cfg.reseau || {}, { accesNavigateur: !!b.accesNavigateur });
    db.setConfig(cfg);
    ctx.audit(req, 'modification', 'configuration', null, `Accès par navigateur web : ${cfg.reseau.accesNavigateur ? 'autorisé' : 'désactivé'}`);
    return { accesNavigateur: cfg.reseau.accesNavigateur };
  }, { perm: ['systeme', 'modifier'] });

  /** Déconnecte une session (poste) à distance. */
  router.delete('/api/systeme/sessions/:id', async (req) => {
    for (const [token, s] of sessions.map) {
      if (idSession(token) === req.params.id) {
        if (req.session && req.session.token === token) throw new HttpError(400, 'Vous ne pouvez pas fermer votre propre session ici (utilisez « Se déconnecter »)');
        sessions.destroy(token);
        ctx.audit(req, 'deconnexion', 'users', s.userId, 'Session fermée par le pôle informatique');
        return { ok: true };
      }
    }
    throw new HttpError(404, 'Session introuvable');
  }, { perm: ['systeme', 'modifier'] });
}

module.exports = { nom, register, idSession };
