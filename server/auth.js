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

/** Mots de passe trop courants, refusés quelle que soit la politique. */
const MDP_COURANTS = new Set(['motdepasse', 'password', 'azerty', 'azertyuiop', 'qwerty', '123456', '1234567', '12345678', '123456789', '1234567890',
  'admin', 'administrateur', 'changeme', 'bonjour', 'soleil', 'sicaf', 'gmao', 'maintenance', 'demo', 'test', 'test1234', 'password1', 'motdepasse1',
  'azerty123', 'azerty1234', 'admin123', 'admin1234', 'abc123', '000000', '111111', 'p@ssw0rd', 'passw0rd']);

/**
 * Politique de mot de passe (config.securite) : longueur minimale, complexité (au moins 3 familles
 * parmi minuscules, majuscules, chiffres, caractères spéciaux), refus des mots de passe courants
 * et de ceux qui contiennent l'identifiant.
 * @returns {string|null} message d'erreur ou null si le mot de passe est accepté
 */
function validerMotDePasse(pwd, config, contexte) {
  const sec = (config && config.securite) || {};
  const min = Math.max(4, Number(sec.longueurMinMdp) || 10);
  if (typeof pwd !== 'string' || pwd.length < min) return `Le mot de passe doit contenir au moins ${min} caractères`;
  if (pwd.length > 200) return 'Le mot de passe est trop long (200 caractères maximum)';
  const bas = pwd.toLowerCase();
  if (sec.refuserCourants !== false && (MDP_COURANTS.has(bas) || MDP_COURANTS.has(bas.replace(/[^a-z0-9@]/g, '')))) return 'Ce mot de passe est trop courant : choisissez-en un autre';
  const login = contexte && contexte.login ? String(contexte.login).toLowerCase() : '';
  if (sec.interdireIdentifiant !== false && login && login.length >= 3 && bas.includes(login)) return 'Le mot de passe ne doit pas contenir l\'identifiant';
  if (sec.complexite !== false) {
    const familles = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pwd)).length;
    if (familles < 3) return 'Le mot de passe doit mélanger au moins 3 types de caractères parmi : minuscules, majuscules, chiffres, caractères spéciaux';
  }
  return null;
}

/** Mot de passe aléatoire conforme à la politique (création de compte, réinitialisation). */
function genererMotDePasse(longueur = 14) {
  const familles = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!#%+-=?@_'];
  const tous = familles.join('');
  const car = (jeu) => jeu[crypto.randomInt(jeu.length)];
  const out = familles.map(car);
  while (out.length < longueur) out.push(car(tous));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

class Sessions {
  /**
   * @param {{ inactiviteMs?: Function, dureeMaxMs?: Function }} [options] fonctions renvoyant les délais
   *   courants (lus dans la configuration à chaque appel) : inactivité et durée absolue d'une session.
   */
  constructor(options = {}) {
    this.map = new Map();
    this.tentatives = new Map();
    this.inactiviteMs = options.inactiviteMs || (() => SESSION_DUREE_MS);
    this.dureeMaxMs = options.dureeMaxMs || (() => SESSION_DUREE_MS);
  }

  create(userId, info = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.map.set(token, { token, userId, createdAt: now, lastSeen: now, info });
    return token;
  }

  expiree(s, now) {
    return now - s.lastSeen > this.inactiviteMs() || now - s.createdAt > this.dureeMaxMs();
  }

  get(token) {
    if (!token || typeof token !== 'string' || token.length !== 64) return null;
    const s = this.map.get(token);
    if (!s) return null;
    const now = Date.now();
    if (this.expiree(s, now)) {
      this.map.delete(token);
      return null;
    }
    s.lastSeen = now;
    return s;
  }

  /** Ferme toutes les sessions d'un utilisateur sauf, éventuellement, celle indiquée. */
  destroyUserSauf(userId, tokenConserve) {
    for (const [t, s] of this.map) if (s.userId === userId && t !== tokenConserve) this.map.delete(t);
  }

  destroy(token) { this.map.delete(token); }

  destroyUser(userId) {
    for (const [t, s] of this.map) if (s.userId === userId) this.map.delete(t);
  }

  sweep() {
    const now = Date.now();
    for (const [t, s] of this.map) if (this.expiree(s, now)) this.map.delete(t);
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

  /** Enregistre un échec ; renvoie true si cet échec déclenche un blocage. */
  echec(cle) {
    const t = this.tentatives.get(cle) || { count: 0, until: 0 };
    t.count += 1;
    let bloque = false;
    if (t.count >= MAX_TENTATIVES) { t.until = Date.now() + BLOCAGE_MS; t.count = 0; bloque = true; }
    this.tentatives.set(cle, t);
    return bloque;
  }

  succes(cle) { this.tentatives.delete(cle); }
}

/**
 * Retire les informations sensibles avant envoi au client : empreinte du mot de passe, clé de double
 * authentification (active ou en attente) et empreintes des codes de secours. Seul un résumé de l'état
 * de la double authentification est conservé.
 */
function cleanUser(u) {
  if (!u) return null;
  const { passwordHash, deuxFacteurs, codesSecours, ...rest } = u;
  rest.deuxFacteurs = resumeDeuxFacteurs(u);
  return rest;
}

/** État de la double authentification, sans aucun secret. */
function resumeDeuxFacteurs(u) {
  const d = (u && u.deuxFacteurs) || {};
  const actif = !!d.actif;
  return {
    actif,
    activeLe: actif ? d.activeLe || null : null,
    codesSecoursRestants: actif && Array.isArray(u.codesSecours) ? u.codesSecours.length : 0,
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, validerMotDePasse, genererMotDePasse, Sessions, cleanUser, resumeDeuxFacteurs, parseCookies, SESSION_DUREE_MS, MAX_TENTATIVES, BLOCAGE_MS };
