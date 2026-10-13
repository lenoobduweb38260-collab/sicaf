'use strict';
/**
 * Authentification : hachage des mots de passe (scrypt), sessions en mémoire,
 * limitation des tentatives de connexion.
 */
const crypto = require('crypto');

const SESSION_DUREE_MS = 12 * 60 * 60 * 1000; // 12 h glissantes
const MAX_TENTATIVES = 8;
const BLOCAGE_MS = 10 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

function validerMotDePasse(pwd, config) {
  const min = (config && config.securite && config.securite.longueurMinMdp) || 4;
  if (typeof pwd !== 'string' || pwd.length < min) {
    return `Le mot de passe doit contenir au moins ${min} caractères`;
  }
  return null;
}

class Sessions {
  constructor() {
    this.map = new Map();
    this.tentatives = new Map();
  }

  create(userId, info = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.map.set(token, { token, userId, createdAt: now, lastSeen: now, info });
    return token;
  }

  get(token) {
    if (!token) return null;
    const s = this.map.get(token);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_DUREE_MS) {
      this.map.delete(token);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(token) { this.map.delete(token); }

  destroyUser(userId) {
    for (const [t, s] of this.map) if (s.userId === userId) this.map.delete(t);
  }

  sweep() {
    const now = Date.now();
    for (const [t, s] of this.map) if (now - s.lastSeen > SESSION_DUREE_MS) this.map.delete(t);
    for (const [k, v] of this.tentatives) if (v.until && v.until < now && v.count === 0) this.tentatives.delete(k);
  }

  /** Limitation des tentatives : retourne le nombre de secondes de blocage restantes (0 si libre). */
  blocage(cle) {
    const t = this.tentatives.get(cle);
    if (!t) return 0;
    if (t.until && t.until > Date.now()) return Math.ceil((t.until - Date.now()) / 1000);
    if (t.until && t.until <= Date.now()) this.tentatives.delete(cle);
    return 0;
  }

  echec(cle) {
    const t = this.tentatives.get(cle) || { count: 0, until: 0 };
    t.count += 1;
    if (t.count >= MAX_TENTATIVES) { t.until = Date.now() + BLOCAGE_MS; t.count = 0; }
    this.tentatives.set(cle, t);
  }

  succes(cle) { this.tentatives.delete(cle); }
}

/** Retire les informations sensibles avant envoi au client. */
function cleanUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, validerMotDePasse, Sessions, cleanUser, parseCookies, SESSION_DUREE_MS };
