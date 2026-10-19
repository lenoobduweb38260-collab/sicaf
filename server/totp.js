'use strict';
/**
 * Double authentification : mots de passe à usage unique basés sur le temps.
 *
 *  - Base32 (RFC 4648, alphabet A-Z 2-7) pour l'échange de la clé avec l'application du téléphone ;
 *  - HOTP (RFC 4226) et TOTP (RFC 6238) : HMAC-SHA1, 6 chiffres, pas de 30 secondes, fenêtre de ±1 pas
 *    (tolérance d'horloge), compatibles Microsoft Authenticator, Google Authenticator, FreeOTP… ;
 *  - vérification en temps constant (aucune sortie anticipée) et anti-rejeu : seul un pas strictement
 *    postérieur au dernier pas accepté est valide, un code déjà utilisé est donc refusé ;
 *  - codes de secours à usage unique (empreintes scrypt, comme les mots de passe) ;
 *  - chiffrement au repos des clés (AES-256-GCM) avec une clé propre au serveur, conservée hors de la base.
 *
 * Aucune dépendance externe (module `crypto` de Node uniquement).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PAS_SECONDES = 30;
const CHIFFRES = 6;
const FENETRE = 1;
const TAILLE_SECRET = 20; // 160 bits, taille recommandée par la RFC 4226 pour HMAC-SHA1
const EMETTEUR = 'GMAO SICAF';

/** Alphabet des codes de secours : sans caractères ambigus (i, l, o, 0, 1). */
const ALPHABET_SECOURS = 'abcdefghjkmnpqrstuvwxyz23456789';
const LONGUEUR_SECOURS = 10;
const NOMBRE_SECOURS = 10;

// ----- Base32 (RFC 4648) ------------------------------------------------------

/**
 * Encode des octets en base32.
 * @param {Buffer|Uint8Array} octets
 * @param {{ remplissage?: boolean }} [options] remplissage « = » jusqu'à un multiple de 8 caractères
 */
function base32Encoder(octets, options = {}) {
  const buf = Buffer.from(octets);
  let sortie = '';
  let valeur = 0;
  let bits = 0;
  for (const o of buf) {
    valeur = (valeur << 8) | o;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
    valeur &= 0xff; // seuls les bits non encore émis sont utiles
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31];
  if (options.remplissage) while (sortie.length % 8) sortie += '=';
  return sortie;
}

/**
 * Décode une chaîne base32 (majuscules ou minuscules, espaces, tirets et « = » final ignorés).
 * @throws {Error} si la chaîne contient un caractère invalide
 */
function base32Decoder(texte) {
  const propre = String(texte == null ? '' : texte).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const octets = [];
  let valeur = 0;
  let bits = 0;
  for (const c of propre) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('Caractère base32 invalide');
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    valeur &= 0xff;
  }
  return Buffer.from(octets);
}

// ----- HOTP / TOTP (RFC 4226, RFC 6238) ---------------------------------------

/**
 * Code HOTP pour un compteur donné.
 * @param {Buffer} cle clé brute
 * @param {number|bigint} compteur
 * @param {{ chiffres?: number, algorithme?: string }} [options]
 * @returns {string} code complété par des zéros à gauche
 */
function hotp(cle, compteur, options = {}) {
  const chiffres = options.chiffres || CHIFFRES;
  const algorithme = options.algorithme || 'sha1';
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(compteur));
  const hmac = crypto.createHmac(algorithme, cle).update(message).digest();
  const decalage = hmac[hmac.length - 1] & 0x0f;
  const binaire = ((hmac[decalage] & 0x7f) << 24) | (hmac[decalage + 1] << 16) | (hmac[decalage + 2] << 8) | hmac[decalage + 3];
  return String(binaire % 10 ** chiffres).padStart(chiffres, '0');
}

/** Numéro de pas (fenêtre de 30 s) correspondant à un instant en millisecondes. */
function pasDe(instantMs, pasSecondes = PAS_SECONDES) {
  return Math.floor(Math.floor(Number(instantMs) / 1000) / pasSecondes);
}

/**
 * Code TOTP à un instant donné.
 * @param {Buffer|string} cle clé brute, ou clé base32
 * @param {{ instant?: number, chiffres?: number, algorithme?: string, pas?: number }} [options] instant en ms
 */
function totp(cle, options = {}) {
  const brute = Buffer.isBuffer(cle) ? cle : base32Decoder(cle);
  const instant = options.instant === undefined ? Date.now() : options.instant;
  return hotp(brute, pasDe(instant, options.pas || PAS_SECONDES), options);
}

/** Comparaison de deux chaînes de même longueur attendue, en temps constant. */
function egalTempsConstant(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // même coût de calcul, résultat ignoré
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** Normalise un code saisi (espaces retirés) ; null s'il ne s'agit pas d'un code à 6 chiffres. */
function normaliserCode(code) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

/**
 * Vérifie un code TOTP dans la fenêtre ±1 pas.
 * Tous les pas de la fenêtre sont calculés et comparés (pas de sortie anticipée).
 * @param {Buffer|string} cle clé brute ou base32
 * @param {string} code code saisi
 * @param {{ instant?: number, dernierPas?: number|null, fenetre?: number }} [options]
 * @returns {number|null} pas accepté (à mémoriser comme `dernierPas`), ou null si le code est refusé
 */
function verifier(cle, code, options = {}) {
  const saisi = normaliserCode(code);
  const brute = Buffer.isBuffer(cle) ? cle : base32Decoder(cle);
  const instant = options.instant === undefined ? Date.now() : options.instant;
  const fenetre = options.fenetre === undefined ? FENETRE : options.fenetre;
  const dernier = Number.isInteger(options.dernierPas) ? options.dernierPas : -1;
  const courant = pasDe(instant);
  let accepte = null;
  for (let d = -fenetre; d <= fenetre; d++) {
    const pas = courant + d;
    const attendu = hotp(brute, Math.max(0, pas));
    const egal = egalTempsConstant(saisi || '------', attendu);
    if (egal && saisi && pas > dernier && accepte === null) accepte = pas;
  }
  return accepte;
}

/** Nouvelle clé aléatoire (20 octets), encodée en base32 sans remplissage. */
function genererSecret() {
  return base32Encoder(crypto.randomBytes(TAILLE_SECRET));
}

/** Clé base32 groupée par 4 caractères, pour la saisie manuelle dans l'application. */
function grouperSecret(secret) {
  return String(secret || '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** URI d'enrôlement (format « Key Uri » reconnu par les applications d'authentification). */
function uriOtpauth(login, secret, emetteur = EMETTEUR) {
  const e = encodeURIComponent(emetteur);
  return `otpauth://totp/${e}:${encodeURIComponent(String(login))}?secret=${secret}&issuer=${e}`;
}

// ----- Codes de secours ---------------------------------------------------------

/** Génère les codes de secours en clair (affichés une seule fois), au format « xxxxx-xxxxx ». */
function genererCodesSecours(nombre = NOMBRE_SECOURS) {
  const out = [];
  while (out.length < nombre) {
    let c = '';
    for (let i = 0; i < LONGUEUR_SECOURS; i++) c += ALPHABET_SECOURS[crypto.randomInt(ALPHABET_SECOURS.length)];
    const code = c.slice(0, 5) + '-' + c.slice(5);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** Normalise un code de secours saisi ; null s'il n'a pas le bon format. */
function normaliserCodeSecours(code) {
  const c = String(code == null ? '' : code).toLowerCase().replace(/[\s-]/g, '');
  if (c.length !== LONGUEUR_SECOURS) return null;
  for (const x of c) if (!ALPHABET_SECOURS.includes(x)) return null;
  return c;
}

function scryptAsync(texte, sel) {
  return new Promise((resolve, reject) => crypto.scrypt(texte, sel, 64, (err, cle) => (err ? reject(err) : resolve(cle))));
}

/** Empreinte scrypt d'un code de secours (même format que les mots de passe : scrypt$sel$empreinte). */
async function empreinteCodeSecours(code) {
  const propre = normaliserCodeSecours(code);
  if (!propre) throw new Error('Code de secours invalide');
  const sel = crypto.randomBytes(16).toString('hex');
  const h = await scryptAsync(propre, sel);
  return `scrypt$${sel}$${h.toString('hex')}`;
}

/** Compare un code de secours à une empreinte, en temps constant. */
async function verifierEmpreinte(code, empreinte) {
  if (typeof empreinte !== 'string') return false;
  const [algo, sel, hash] = empreinte.split('$');
  if (algo !== 'scrypt' || !sel || !hash) return false;
  const h = await scryptAsync(String(code), sel);
  const ref = Buffer.from(hash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}

/**
 * Recherche le code de secours saisi parmi les empreintes.
 * @returns {Promise<string|null>} l'empreinte correspondante (à retirer de la liste), ou null
 */
async function trouverCodeSecours(code, empreintes) {
  const propre = normaliserCodeSecours(code);
  if (!propre || !Array.isArray(empreintes) || !empreintes.length) return null;
  const resultats = await Promise.all(empreintes.map((e) => verifierEmpreinte(propre, e).catch(() => false)));
  const i = resultats.indexOf(true);
  return i < 0 ? null : empreintes[i];
}

// ----- Chiffrement des clés au repos ------------------------------------------

const FICHIER_CLE = 'cle-double-authentification.key';

/**
 * Coffre de chiffrement des clés TOTP (AES-256-GCM).
 * La clé maîtresse est conservée dans le dossier de données, hors de la base : un export de la base
 * ne contient donc que des clés chiffrées. En mémoire (tests), une clé éphémère est utilisée.
 */
class Coffre {
  /** @param {{ dossier?: string, enMemoire?: boolean }} options */
  constructor(options = {}) {
    this.dossier = options.dossier || null;
    this.enMemoire = !!options.enMemoire || !this.dossier;
    this._cle = null;
  }

  /** Oublie la clé lue : relue dans le fichier au prochain usage (fichier restauré avec une sauvegarde). */
  recharger() { this._cle = null; }

  cle() {
    if (this._cle) return this._cle;
    if (this.enMemoire) { this._cle = crypto.randomBytes(32); return this._cle; }
    const fichier = path.join(this.dossier, FICHIER_CLE);
    if (!fs.existsSync(fichier)) {
      fs.mkdirSync(this.dossier, { recursive: true });
      try {
        fs.writeFileSync(fichier, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e; // créé entre-temps par un autre processus
      }
    }
    const hex = fs.readFileSync(fichier, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`Clé de double authentification illisible (${FICHIER_CLE})`);
    this._cle = Buffer.from(hex, 'hex');
    return this._cle;
  }

  /** Chiffre un texte : « v1:<iv>:<étiquette>:<données> » (base64). */
  chiffrer(texte) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.cle(), iv);
    const donnees = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), donnees.toString('base64')].join(':');
  }

  /** Déchiffre un texte produit par chiffrer() ; lève une erreur si la clé ne correspond pas. */
  dechiffrer(chiffre) {
    const parties = String(chiffre || '').split(':');
    if (parties.length !== 4 || parties[0] !== 'v1') throw new Error('Format de clé chiffrée inconnu');
    const d = crypto.createDecipheriv('aes-256-gcm', this.cle(), Buffer.from(parties[1], 'base64'));
    d.setAuthTag(Buffer.from(parties[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parties[3], 'base64')), d.final()]).toString('utf8');
  }
}

module.exports = {
  ALPHABET, PAS_SECONDES, CHIFFRES, FENETRE, EMETTEUR, NOMBRE_SECOURS, FICHIER_CLE,
  base32Encoder, base32Decoder, hotp, totp, pasDe, verifier, normaliserCode, egalTempsConstant,
  genererSecret, grouperSecret, uriOtpauth,
  genererCodesSecours, normaliserCodeSecours, empreinteCodeSecours, verifierEmpreinte, trouverCodeSecours,
  Coffre,
};
