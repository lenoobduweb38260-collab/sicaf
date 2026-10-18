'use strict';
/**
 * Authentification : hachage des mots de passe (scrypt), sessions en mémoire,
 * limitation des tentatives de connexion, codes de réinitialisation du mot de passe.
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

/**
 * Comme verifyPassword, sans bloquer le serveur pendant le calcul (plusieurs empreintes à comparer :
 * historique des mots de passe, code de réinitialisation). Une empreinte mal formée est comparée
 * à une empreinte factice, pour un temps de réponse identique.
 */
function verifyPasswordAsync(password, stored) {
  const [algo, salt, hash] = typeof stored === 'string' ? stored.split('$') : [];
  const valide = algo === 'scrypt' && !!salt && !!hash;
  return new Promise((resolve) => {
    crypto.scrypt(String(password), valide ? salt : '00', 64, (err, test) => {
      if (err || !valide) return resolve(false);
      const ref = Buffer.from(hash, 'hex');
      resolve(test.length === ref.length && crypto.timingSafeEqual(test, ref));
    });
  });
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

/** Codes de réinitialisation : 8 caractères sans ambiguïté de lecture (ni I, ni O, ni 0, ni 1). */
const ALPHABET_CODE_REINIT = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LONGUEUR_CODE_REINIT = 8;

/** Nouveau code de réinitialisation (8 caractères, sans tiret). */
function genererCodeReinitialisation() {
  let code = '';
  for (let i = 0; i < LONGUEUR_CODE_REINIT; i++) code += ALPHABET_CODE_REINIT[crypto.randomInt(ALPHABET_CODE_REINIT.length)];
  return code;
}

/** Présentation « XXXX-XXXX ». */
function formaterCodeReinitialisation(code) {
  const c = String(code || '');
  return c.length === LONGUEUR_CODE_REINIT ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** Saisie tolérante (minuscules, espaces, tirets) : code normalisé ou null s'il est mal formé. */
function normaliserCodeReinitialisation(saisie) {
  if (typeof saisie !== 'string' && typeof saisie !== 'number') return null;
  const c = String(saisie).slice(0, 40).toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== LONGUEUR_CODE_REINIT) return null;
  for (const x of c) if (!ALPHABET_CODE_REINIT.includes(x)) return null;
  return c;
}

class Sessions {
  /**
   * @param {{ inactiviteMs?: Function, dureeMaxMs?: Function }} [options] fonctions renvoyant les délais
   *   courants (lus dans la configuration à chaque appel) : inactivité et durée absolue d'une session.
   */
  constructor(options = {}) {
    this.map = new Map();
    this.tentatives = new Map();
    this.quotas = new Map(); // clé → instants des demandes récentes (fenêtre glissante)
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
    for (const [k, q] of this.quotas) if (!q.instants.length || q.instants[q.instants.length - 1] <= now - q.fenetreMs) this.quotas.delete(k);
  }

  /**
   * Quota sur une fenêtre glissante (ex. 5 demandes par poste en 15 minutes) : enregistre la demande
   * si elle est permise et renvoie 0, sinon renvoie le nombre de secondes avant la prochaine demande permise.
   */
  quota(cle, max, fenetreMs) {
    const now = Date.now();
    const q = this.quotas.get(cle) || { instants: [], fenetreMs };
    q.fenetreMs = fenetreMs;
    q.instants = q.instants.filter((t) => t > now - fenetreMs);
    if (q.instants.length >= max) {
      this.quotas.set(cle, q);
      return Math.max(1, Math.ceil((q.instants[0] + fenetreMs - now) / 1000));
    }
    q.instants.push(now);
    this.quotas.set(cle, q);
    return 0;
  }

  /** Quota atteint (sans rien enregistrer) : secondes avant la prochaine demande permise, 0 si le quota n'est pas atteint. */
  quotaAtteint(cle, max, fenetreMs) {
    const q = this.quotas.get(cle);
    if (!q) return 0;
    const now = Date.now();
    const recents = q.instants.filter((t) => t > now - fenetreMs);
    if (recents.length < max) return 0;
    return Math.max(1, Math.ceil((recents[recents.length - max] + fenetreMs - now) / 1000));
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
 * Retire les informations sensibles avant envoi au client : empreinte du mot de passe et des mots de passe
 * précédents, code de réinitialisation, clé de double authentification (active ou en attente) et empreintes
 * des codes de secours. Seul un résumé de l'état de la double authentification est conservé.
 */
function cleanUser(u) {
  if (!u) return null;
  const { passwordHash, historiqueMdp, reinitialisation, deuxFacteurs, codesSecours, ...rest } = u;
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

module.exports = {
  hashPassword, verifyPassword, verifyPasswordAsync, validerMotDePasse, genererMotDePasse, Sessions, cleanUser, resumeDeuxFacteurs, parseCookies,
  genererCodeReinitialisation, formaterCodeReinitialisation, normaliserCodeReinitialisation, ALPHABET_CODE_REINIT,
  SESSION_DUREE_MS, MAX_TENTATIVES, BLOCAGE_MS,
};
