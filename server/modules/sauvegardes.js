'use strict';
/**
 * Module Sauvegardes multi-destinations / multi-sites.
 *
 * Le serveur GMAO d'un site (ex. Carpentras) sauvegarde sa base :
 *   - en copie locale (dossier <données>/backups, rétention « conserverLocal ») ;
 *   - vers des DOSSIERS : disque (D:\Sauvegardes), clé USB (E:\GMAO), partage réseau (\\NAS\GMAO) ;
 *   - vers des SERVEURS GMAO d'autres sites (ex. http://srv-valreas:8585), qui stockent la copie
 *     reçue dans <données>/backups/recus/<site émetteur>/ (jamais importée automatiquement).
 * Et inversement : chaque serveur peut recevoir les sauvegardes des autres sites.
 *
 * Format d'un fichier : export complet de la base (JSON, secrets de sauvegarde retirés)
 *   → gzip (si « compresser ») → AES-256-GCM (si « chiffrer » ; clé dérivée par scrypt du mot de passe
 *   de chiffrement avec un sel aléatoire ; en-tête binaire versionné : « GMAOSAV », version, paramètres
 *   scrypt, sel, IV, étiquette d'authentification)
 *   → « gmao-<site>-AAAAMMJJ-HHMMSS.json[.gz][.enc] » + empreinte SHA-256 (fichier .sha256 à côté pour un
 *   dossier ; en-tête X-GMAO-Sha256 pour un serveur, vérifiée à la réception).
 *
 * Droits (pôle informatique) : Système › Voir pour consulter ; Système › Modifier pour le reste :
 * le module manipule la base complète (équivalent export / import).
 * Les opérations globales (paramètres, clé de réception, restauration, et la gestion des destinations :
 * chaque fichier contient la base entière, quel que soit le site) exigent l'accès à tous les sites.
 * Multi-site : une destination peut être rattachée à un site (`secteurId`) ; elle n'est alors visible,
 * testable et utilisable (sauvegarde manuelle) que selon la portée et le site courant de l'utilisateur.
 * Une sauvegarde lancée avec le sélecteur de site positionné sur un site n'est pas « complète » :
 * elle ne met pas à jour la planification.
 * Serveur distant en HTTPS (application de bureau) : le certificat auto-signé est épinglé par son
 * empreinte (champ `empreinte` de la destination, confirmée par le pôle informatique) et vérifié avant
 * tout envoi, clé de réception comprise ; un certificat renouvelé avec la même clé est reconnu.
 *
 * Secrets (config.sauvegardes) gérés UNIQUEMENT ici, jamais renvoyés au client :
 *   destinations[].cle, cleReception (empreinte SHA-256 de la clé), motDePasseChiffrement.
 *
 * Services : ctx.services.sauvegardes.{ executer, estDue, prochaineExecution, verifierPlanification, encoder, decoder, enCours }
 * Événements émis : 'sauvegarde:terminee', 'sauvegarde:echec', 'sauvegarde:recue', 'sauvegarde:restauree'
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const { promisify } = require('util');
const tls = require('tls');
const net = require('net');
const tlsGmao = require('../tls');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const scrypt = promisify(crypto.scrypt);

const nom = 'Sauvegardes multi-sites';

const COL_HISTO = 'sauvegardesHistorique';
const HISTO_MAX = 500;
const HISTO_API = 50;
const MAX_DESTINATIONS = 20;
const TYPES = ['dossier', 'serveur'];
const MAX_RECU = 512 * 1024 * 1024; // taille maximale d'une sauvegarde reçue / téléversée
const MAX_LECTURE = 1024 * 1024 * 1024; // taille maximale d'un fichier lu pour restauration
const MAX_DECOMPRESSE = 512 * 1024 * 1024; // garde-fou contre les « bombes » gzip
const INTERVALLE_PLANIF_MS = 5 * 60 * 1000;
const NOUVEL_ESSAI_MS = 60 * 60 * 1000; // après un échec, nouvel essai automatique 1 h plus tard
const ESSAIS_MAX = 3;
const DELAI_INACTIVITE_MS = 60 * 1000;
const DELAI_TOTAL_MS = 30 * 60 * 1000;
const DELAI_PING_MS = 15 * 1000;
const FORMAT = 1;
const MAGIC = Buffer.from('GMAOSAV', 'ascii');
const VERSION_CHIFFREMENT = 1;
const SCRYPT_PARAMS = { logN: 15, r: 8, p: 1 };
const TAILLE_ENTETE = MAGIC.length + 4 + 16 + 12; // magic, version, logN, r, p, sel, IV
const TAILLE_TAG = 16;
const LIEN_UI = '#/systeme?onglet=donnees';
/** gmao-<identifiant>-AAAAMMJJ-HHMMSS[-n].json[.gz][.enc] */
const RE_FICHIER = /^gmao-([A-Za-z0-9_-]{1,60})-(\d{8})-(\d{6})(?:-(\d{1,3}))?\.json(\.gz)?(\.enc)?$/;
const RE_SITE = /^[A-Za-z0-9_-]{1,60}$/;
/** Copie de l'état précédent faite par la base avant un import ou une restauration : gmao-avant-import-<horodatage ISO>.json */
const RE_COPIE_AVANT = /^gmao-avant-(import|restauration)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

const PARAMS_DEFAUT = {
  automatique: true, frequenceHeures: 24, heure: '22:00', conserverLocal: 30, compresser: true, chiffrer: false,
  accepterReception: false, conserverRecues: 10, nomServeur: '',
};

// ----- Utilitaires purs -------------------------------------------------------

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function empreinteCle(k) { return crypto.createHash('sha256').update(String(k), 'utf8').digest(); }

/** Comparaison en temps constant de deux chaînes (sur leurs empreintes, longueurs égales). */
function egalTempsConstant(a, b) { return crypto.timingSafeEqual(empreinteCle(a), empreinteCle(b)); }

/** La clé fournie correspond-elle à la clé de réception stockée (« sha256:<hex> » ou ancienne valeur en clair) ? */
function cleValide(fournie, stockee) {
  if (!fournie || !stockee) return false;
  const s = String(stockee);
  const ref = /^sha256:[a-f0-9]{64}$/.test(s) ? Buffer.from(s.slice(7), 'hex') : empreinteCle(s);
  const test = empreinteCle(fournie);
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

/** Segment de nom de fichier / dossier sûr (lettres, chiffres, _ et -), sans accents. */
function assainirSegment(v, max = 60) {
  let s = String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, max).replace(/[-_]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s; // noms réservés Windows
  return s;
}

function formatTaille(n) {
  const v = Number(n) || 0;
  const f = (x, d) => x.toFixed(d).replace('.', ',');
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${f(v / 1024, 0)} Ko`;
  if (v < 1024 * 1024 * 1024) return `${f(v / 1024 / 1024, 1)} Mo`;
  return `${f(v / 1024 / 1024 / 1024, 2)} Go`;
}

function dateDepuisNom(ymd, hms) {
  const d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)), Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `cible` est-il `base` ou un de ses sous-dossiers ? (insensible à la casse sous Windows) */
function dans(cible, base) {
  const p = process.platform === 'win32' ? path.win32 : path;
  const rel = p.relative(p.resolve(base), p.resolve(cible));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** Chemin absolu valide pour la plateforme du serveur (lecteur, partage UNC, ou chemin POSIX). */
function cheminAbsoluValide(s) {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(s);
  return path.posix.isAbsolute(s);
}

function messageFs(e) {
  if (e && e.status) return e.message; // HttpError de validation
  const c = e && e.code;
  if (c === 'ENOENT') return 'Chemin introuvable : le lecteur, la clé USB ou le partage réseau est-il disponible ?';
  if (c === 'EACCES' || c === 'EPERM') return 'Accès refusé : le compte Windows qui exécute la GMAO n\'a pas le droit d\'écrire dans ce dossier';
  if (c === 'ENOSPC') return 'Espace disque insuffisant sur la destination';
  if (c === 'EROFS') return 'Support en lecture seule';
  if (c === 'ENOTDIR' || c === 'EISDIR') return 'Le chemin indiqué n\'est pas un dossier valide';
  if (c === 'EBUSY') return 'Support ou fichier occupé, réessayez';
  if (c === 'ENAMETOOLONG') return 'Chemin trop long';
  if (c === 'EIO') return 'Erreur de lecture / écriture sur le support';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EHOSTDOWN') return 'Partage réseau injoignable';
  return (e && e.message) || String(e);
}

function messageReseau(e, url) {
  let hote = url;
  try { hote = new URL(url).host; } catch (x) { /* ignore */ }
  const c = e && e.code;
  if (c === 'ECONNREFUSED') return `Connexion refusée par ${hote} : la GMAO est-elle démarrée sur ce serveur, accessible depuis le réseau et le port ouvert dans le pare-feu ?`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return `Serveur « ${hote} » introuvable : vérifiez le nom ou l'adresse IP`;
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') return `Délai de connexion dépassé vers ${hote}`;
  if (c === 'ECONNRESET' || c === 'EPIPE') return `Connexion interrompue par ${hote}`;
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return `Serveur ${hote} injoignable (liaison réseau ou VPN entre les sites ?)`;
  if (c === 'EPROTO' || /wrong version number|packet length too long/i.test(String(e && e.message))) return `${hote} ne propose pas de connexion chiffrée (HTTPS) sur ce port : utilisez une adresse http://`;
  if (/CERT|SSL|TLS/i.test(String(c || '')) || /certificate/i.test(String(e && e.message))) return `Certificat HTTPS de ${hote} refusé`;
  return (e && e.message) || String(e);
}

/** Message lisible pour une réponse HTTP d'erreur d'un serveur distant. */
function messageDistant(r) {
  const e = r.json && typeof r.json.erreur === 'string' ? r.json.erreur.slice(0, 200) : '';
  if (r.status === 403) return 'Refusé par le serveur distant' + (e ? ' : ' + e : '');
  if (r.status === 404) return 'Ce serveur ne propose pas la réception de sauvegardes GMAO (adresse incorrecte ou version trop ancienne)';
  if (r.status === 413) return 'Sauvegarde trop volumineuse pour le serveur distant';
  if (r.status === 429) return 'Serveur distant temporairement bloqué après plusieurs clés invalides' + (e ? ' : ' + e : '');
  if (r.status === 503) return 'Réception indisponible sur le serveur distant' + (e ? ' : ' + e : '');
  if (r.status >= 200 && r.status < 300) return 'Réponse inattendue : ce serveur n\'est pas une GMAO SICAF';
  return `Réponse inattendue du serveur distant (HTTP ${r.status})` + (e ? ' : ' + e : '');
}

// ----- Chiffrement / compression ------------------------------------------------

async function chiffrerTampon(buf, motDePasse) {
  const { logN, r, p } = SCRYPT_PARAMS;
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cle = await scrypt(String(motDePasse), sel, 32, { N: 2 ** logN, r, p, maxmem: 128 * 1024 * 1024 });
  const entete = Buffer.concat([MAGIC, Buffer.from([VERSION_CHIFFREMENT, logN, r, p]), sel, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', cle, iv);
  c.setAAD(entete); // l'en-tête (version, paramètres, sel, IV) est authentifié
  const corps = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([entete, c.getAuthTag(), corps]);
}

function HttpErreur(status, message) { const e = new Error(message); e.status = status; return e; }

async function dechiffrerTampon(buf, motDePasse) {
  if (buf.length < TAILLE_ENTETE + TAILLE_TAG) throw HttpErreur(400, 'Fichier chiffré tronqué');
  const version = buf[MAGIC.length];
  if (version !== VERSION_CHIFFREMENT) throw HttpErreur(400, `Version de chiffrement non prise en charge (${version})`);
  const logN = buf[MAGIC.length + 1], r = buf[MAGIC.length + 2], p = buf[MAGIC.length + 3];
  if (logN < 10 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4 || 128 * (2 ** logN) * r > 256 * 1024 * 1024) throw HttpErreur(400, 'Paramètres de chiffrement invalides');
  const o = MAGIC.length + 4;
  const sel = buf.subarray(o, o + 16);
  const iv = buf.subarray(o + 16, o + 28);
  const tag = buf.subarray(TAILLE_ENTETE, TAILLE_ENTETE + TAILLE_TAG);
  const corps = buf.subarray(TAILLE_ENTETE + TAILLE_TAG);
  const cle = await scrypt(String(motDePasse), sel, 32, { N: 2 ** logN, r, p, maxmem: 300 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', cle, iv);
  d.setAAD(buf.subarray(0, TAILLE_ENTETE));
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(corps), d.final()]); } catch (e) { throw HttpErreur(400, 'Mot de passe de chiffrement incorrect ou fichier altéré'); }
}

/** Données → tampon (JSON → gzip → AES-256-GCM selon les options). */
async function encoder(donnees, { compresser = true, chiffrer = false, motDePasse = '' } = {}) {
  let buf = Buffer.from(JSON.stringify(donnees), 'utf8');
  if (compresser) buf = await gzip(buf, { level: 6 });
  if (chiffrer) {
    if (!motDePasse) throw HttpErreur(400, 'Chiffrement activé mais aucun mot de passe de chiffrement n\'est défini');
    buf = await chiffrerTampon(buf, motDePasse);
  }
  return buf;
}

/** Tampon → { data, chiffre, compresse } ; vérifie qu'il s'agit d'une sauvegarde GMAO. */
async function decoder(buf, motDePasse) {
  const info = { chiffre: false, compresse: false };
  let b = buf;
  if (b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (!motDePasse) throw HttpErreur(400, 'Cette sauvegarde est chiffrée : indiquez son mot de passe de chiffrement');
    b = await dechiffrerTampon(b, motDePasse);
    info.chiffre = true;
  }
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try { b = await gunzip(b, { maxOutputLength: MAX_DECOMPRESSE }); } catch (e) { throw HttpErreur(400, 'Décompression impossible : fichier altéré, incomplet ou trop volumineux'); }
    info.compresse = true;
  }
  let data;
  try { data = JSON.parse(b.toString('utf8')); } catch (e) { throw HttpErreur(400, 'Contenu illisible : ce fichier n\'est pas une sauvegarde GMAO valide'); }
  if (!data || typeof data !== 'object' || !data.collections || typeof data.collections !== 'object' || Array.isArray(data.collections)) {
    throw HttpErreur(400, 'Ce fichier n\'est pas une sauvegarde GMAO (collections absentes)');
  }
  if (!Array.isArray(data.collections.users) || !data.collections.users.length) throw HttpErreur(400, 'Sauvegarde sans comptes utilisateurs : restauration refusée');
  info.data = data;
  return info;
}

/** Le contenu correspond-il à l'extension (.enc → chiffré, .gz → gzip, sinon JSON) ? */
function formatCoherent(buf, nomFichier) {
  if (!buf || !buf.length) return false;
  if (/\.enc$/.test(nomFichier)) return buf.length > TAILLE_ENTETE + TAILLE_TAG && buf.subarray(0, MAGIC.length).equals(MAGIC);
  if (/\.gz$/.test(nomFichier)) return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const t = buf.subarray(0, 64).toString('utf8').trimStart();
  return t.startsWith('{');
}

// ----- Fichiers -----------------------------------------------------------------

function ecrireAtomique(fichier, contenu) {
  const tmp = path.join(path.dirname(fichier), '.' + path.basename(fichier) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(tmp, contenu);
    fs.renameSync(tmp, fichier);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
    throw e;
  }
}

function ecrireDansDossier(dossier, fichier, tampon, sha) {
  fs.mkdirSync(dossier, { recursive: true });
  ecrireAtomique(path.join(dossier, fichier), tampon);
  fs.writeFileSync(path.join(dossier, fichier + '.sha256'), `${sha}  ${fichier}\n`);
}

function lireSha(fichier) {
  try {
    const m = /^([a-f0-9]{64})\b/i.exec(fs.readFileSync(fichier + '.sha256', 'utf8').trim());
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}

/** Sauvegardes GMAO présentes dans un dossier (plus récentes d'abord). */
function listerFichiersGmao(dossier) {
  let noms;
  try { noms = fs.readdirSync(dossier); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []; throw e; }
  return noms.map((n) => {
    const m = RE_FICHIER.exec(n);
    if (!m) return null;
    let st;
    try { st = fs.statSync(path.join(dossier, n)); } catch (e) { return null; }
    if (!st.isFile()) return null;
    return {
      nom: n, identifiant: m[1], horodatage: `${m[2]}-${m[3]}-${String(m[4] || '1').padStart(3, '0')}`,
      date: dateDepuisNom(m[2], m[3]) || st.mtime.toISOString(), modifie: st.mtime.toISOString(),
      taille: st.size, compresse: !!m[5], chiffre: !!m[6], sha256: lireSha(path.join(dossier, n)),
    };
  }).filter(Boolean).sort((a, b) => (a.date === b.date ? (a.horodatage < b.horodatage ? 1 : -1) : (a.date < b.date ? 1 : -1)));
}

/** Supprime les plus anciennes sauvegardes au-delà de `conserver` (filtre optionnel par identifiant de site). */
function appliquerRetention(dossier, conserver, identifiantSite) {
  const fichiers = listerFichiersGmao(dossier).filter((f) => identifiantSite == null || f.identifiant === identifiantSite)
    .sort((a, b) => (a.horodatage < b.horodatage ? 1 : -1));
  const supprimes = [];
  for (const f of fichiers.slice(Math.max(0, conserver))) {
    try { fs.unlinkSync(path.join(dossier, f.nom)); supprimes.push(f.nom); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(path.join(dossier, f.nom + '.sha256')); } catch (e) { /* ignore */ }
  }
  return supprimes;
}

function lireFichierSauvegarde(fichier) {
  let st;
  try { st = fs.statSync(fichier); } catch (e) { throw HttpErreur(e.code === 'ENOENT' ? 404 : 400, e.code === 'ENOENT' ? 'Fichier de sauvegarde introuvable' : messageFs(e)); }
  if (!st.isFile()) throw HttpErreur(404, 'Fichier de sauvegarde introuvable');
  if (st.size > MAX_LECTURE) throw HttpErreur(400, 'Fichier trop volumineux pour être restauré');
  try { return fs.readFileSync(fichier); } catch (e) { throw HttpErreur(400, messageFs(e)); }
}

// ----- Client HTTP (envoi vers un autre site) ------------------------------------

/**
 * Requête HTTP(S) avec délai d'inactivité, délai total et taille de réponse limitée.
 * Les redirections ne sont jamais suivies ; une redirection d'une adresse http:// vers https:// sur le même
 * hôte est signalée (code REDIRECTION_HTTPS, `adresseHttps`) pour proposer la bascule d'adresse.
 * En HTTPS, le certificat présenté est vérifié par épinglage (`epinglage` : { empreinte, empreinteCle }) à la
 * fin de la poignée de main, avant l'envoi du moindre en-tête : sans empreinte confirmée (code
 * EMPREINTE_NON_CONFIRMEE) ou avec une empreinte différente (code EMPREINTE_DIFFERENTE), rien n'est envoyé et
 * l'empreinte présentée est jointe à l'erreur. La réponse porte `certificat` { empreinte, empreinteCle, parCle }.
 */
function requete(urlTexte, { methode = 'GET', entetes = {}, corps = null, delaiMs = DELAI_INACTIVITE_MS, delaiTotalMs = DELAI_TOTAL_MS, maxReponse = 5 * 1024 * 1024, userAgent = 'GMAO-SICAF-Replication', epinglage = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlTexte); } catch (e) { reject(new Error('Adresse du serveur invalide')); return; }
    const chiffre = u.protocol === 'https:';
    const hote = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port) || (chiffre ? 443 : 80);
    const h = Object.assign({ Host: u.host, 'User-Agent': userAgent, Accept: 'application/json' }, entetes);
    if (corps) h['Content-Length'] = String(corps.length);
    let fini = false;
    let req = null;
    let socket = null;
    const terminer = (fn, v) => { if (fini) return; fini = true; clearTimeout(minuteur); if (req) req.destroy(); if (socket) socket.destroy(); fn(v); };
    const minuteur = setTimeout(() => terminer(reject, new Error(`Délai total dépassé (${Math.round(delaiTotalMs / 1000)} s)`)), delaiTotalMs);
    if (minuteur.unref) minuteur.unref();
    const echec = (e) => terminer(reject, Object.assign(new Error(messageReseau(e, urlTexte)), { code: (e && e.code) || undefined }));
    const inactif = () => terminer(reject, new Error(`Délai dépassé (${Math.round(delaiMs / 1000)} s) : le serveur distant ne répond pas`));
    const envoyer = (creerConnexion, certificat) => {
      const opts = { host: hote, port, path: u.pathname + u.search, method: methode, headers: h, timeout: delaiMs };
      if (creerConnexion) opts.createConnection = creerConnexion; // sans agent : la connexion vérifiée est utilisée telle quelle
      req = http.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          let loc = null;
          try { loc = new URL(String(res.headers.location || ''), u); } catch (e) { loc = null; }
          if (!chiffre && loc && loc.protocol === 'https:' && loc.hostname === u.hostname) {
            const s = new URL(u.toString());
            s.protocol = 'https:';
            s.port = loc.port;
            // Adresse de la destination (sans le chemin de l'API de réplication ajouté par l'appelant)
            const adresseHttps = (s.origin + s.pathname.replace(/\/api\/replication\/[^/]*$/, '')).replace(/\/+$/, '');
            terminer(reject, Object.assign(new Error(`Ce serveur exige une connexion chiffrée : utilisez l'adresse ${adresseHttps}`), { code: 'REDIRECTION_HTTPS', adresseHttps }));
            return;
          }
          terminer(reject, new Error(`Redirection refusée (HTTP ${res.statusCode}) : indiquez l'adresse exacte du serveur GMAO`));
          return;
        }
        const morceaux = [];
        let taille = 0;
        res.on('data', (c) => {
          taille += c.length;
          if (taille > maxReponse) { terminer(reject, new Error('Réponse du serveur distant trop volumineuse')); return; }
          morceaux.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(morceaux);
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; }
          terminer(resolve, { status: res.statusCode, json, certificat: certificat || null });
        });
        res.on('error', echec);
      });
      req.on('timeout', inactif);
      req.on('error', echec);
      if (corps) req.end(corps); else req.end();
    };
    if (!chiffre) { envoyer(null, null); return; }
    // HTTPS : connexion TLS d'abord, certificat vérifié, puis seulement la requête sur cette connexion
    socket = tls.connect({ host: hote, port, servername: net.isIP(hote) ? undefined : hote, rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
    socket.setTimeout(delaiMs, inactif);
    socket.once('error', echec);
    socket.once('secureConnect', () => {
      const pc = socket.getPeerCertificate(true);
      if (!pc || !pc.raw) { terminer(reject, Object.assign(new Error(`Certificat HTTPS de ${u.host} absent`), { code: 'CERTIFICAT' })); return; }
      const attendu = epinglage && (epinglage.empreinte || epinglage.empreinteCle) ? epinglage : null;
      const v = tlsGmao.verifierEpinglage(pc.raw, attendu || {});
      if (!v.empreinte) { terminer(reject, Object.assign(new Error(`Certificat HTTPS de ${u.host} illisible`), { code: 'CERTIFICAT' })); return; }
      const presente = { empreinte: v.empreinte, empreinteCle: v.empreinteCle, parCle: v.parCle };
      if (!attendu) {
        terminer(reject, Object.assign(new Error(`Certificat HTTPS de ${u.host} non confirmé (empreinte ${v.empreinte}) : comparez-la avec celle affichée sur le poste serveur de l'autre site, puis enregistrez-la dans la destination. Rien n'a été envoyé.`), { code: 'EMPREINTE_NON_CONFIRMEE' }, presente));
        return;
      }
      if (!v.ok) {
        terminer(reject, Object.assign(new Error(`Certificat HTTPS de ${u.host} différent de l'empreinte confirmée (présentée : ${v.empreinte}) : usurpation possible ou serveur réinstallé. Rien n'a été envoyé.`), { code: 'EMPREINTE_DIFFERENTE' }, presente));
        return;
      }
      const s = socket;
      socket = null; // la requête prend possession de la connexion vérifiée
      s.setTimeout(0);
      envoyer(() => s, presente);
      req.once('close', () => s.destroy());
    });
  });
}

// ----- Module --------------------------------------------------------------------

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  let verrou = null; // { type: 'sauvegarde' | 'restauration', debut }
  let dernierHorodatage = '';
  let compteurHorodatage = 1;

  const erreurHttp = (e) => (e instanceof HttpError ? e : (e && e.status ? new HttpError(e.status, e.message) : e));

  // ----- Configuration (section config.sauvegardes) -----
  function lireSauvegardes() {
    const cfg = db.getConfig();
    const s = Object.assign({}, PARAMS_DEFAUT, { cleReception: '', motDePasseChiffrement: '' }, cfg.sauvegardes || {});
    s.destinations = Array.isArray(s.destinations) ? s.destinations.filter((d) => d && typeof d === 'object') : [];
    return s;
  }
  /** Modifie la section (toujours en repartant de la configuration courante, sans attente entre lecture et écriture). */
  function majSauvegardes(fn) {
    const cfg = db.getConfig();
    const s = Object.assign({}, PARAMS_DEFAUT, cfg.sauvegardes || {});
    s.destinations = Array.isArray(s.destinations) ? s.destinations.filter((d) => d && typeof d === 'object') : [];
    fn(s);
    cfg.sauvegardes = s;
    db.setConfig(cfg);
    return s;
  }
  /** Destinations normalisées (identifiants attribués aux anciennes entrées). */
  function destinations() {
    let s = lireSauvegardes();
    if (s.destinations.some((d) => !Number.isInteger(d.id) || !TYPES.includes(d.type))) {
      s = majSauvegardes((x) => {
        let seq = Number(x.sequenceDestinations) || 0;
        for (const d of x.destinations) if (Number.isInteger(d.id)) seq = Math.max(seq, d.id);
        for (const d of x.destinations) {
          if (!Number.isInteger(d.id)) d.id = ++seq;
          if (!TYPES.includes(d.type)) d.type = d.url ? 'serveur' : 'dossier';
          if (!d.nom) d.nom = 'Destination ' + d.id;
          if (d.actif === undefined) d.actif = true;
          if (!Number.isInteger(d.conserver)) d.conserver = 10;
          if (d.secteurId === undefined) d.secteurId = null;
        }
        x.sequenceDestinations = seq;
      });
    }
    return s.destinations;
  }

  // ----- Identité de ce serveur -----
  function sitePrincipal() { const l = perms.sites(db); return l.length ? l[0] : null; }
  /** Nom de ce serveur communiqué aux autres sites : paramètre « nomServeur », sinon site principal, sinon société. */
  function nomServeur() {
    const perso = String(lireSauvegardes().nomServeur || '').trim();
    if (perso) return perso.slice(0, 80);
    const s = sitePrincipal();
    const soc = (db.getConfig().societe || {}).nom;
    return String((s && s.nom) || soc || 'GMAO').replace(/[\u0000-\u001f]/g, '').slice(0, 80);
  }
  function identifiant() {
    const s = sitePrincipal();
    const soc = (db.getConfig().societe || {}).nom;
    return assainirSegment((s && s.code) || soc || 'gmao', 40) || 'gmao';
  }
  function nomFichier(compresse, chiffre, date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    let base = `gmao-${identifiant()}-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
    if (base === dernierHorodatage) { compteurHorodatage += 1; } else { dernierHorodatage = base; compteurHorodatage = 1; }
    if (compteurHorodatage > 1) base += '-' + compteurHorodatage;
    return base + '.json' + (compresse ? '.gz' : '') + (chiffre ? '.enc' : '');
  }
  function dossierRecus() { return path.join(db.backupDir, 'recus'); }

  /** Export de la base sans les secrets de sauvegarde (clés, mot de passe, destinations). */
  function donneesASauvegarder() {
    const d = db.exportAll();
    if (d.config && d.config.sauvegardes) {
      const s = d.config.sauvegardes;
      delete s.cleReception; delete s.motDePasseChiffrement; delete s.cleReceptionDate;
      s.destinations = [];
    }
    d.exportGMAO = { format: FORMAT, date: new Date().toISOString(), source: nomServeur(), identifiant: identifiant(), version: ctx.version };
    return d;
  }

  // ----- Droits, portée, multi-site -----
  const exigerVoir = (req) => ctx.requirePerm(req, 'systeme', 'voir');
  const exigerModif = (req) => ctx.requirePerm(req, 'systeme', 'modifier');
  const estGlobal = (req) => !!(req && req.perms && (req.perms.estAdmin || req.perms.portee === 'tous'));
  const peutModifier = (req) => !!(req && req.perms && perms.can(req.perms, 'systeme', 'modifier'));
  function exigerGlobal(req, quoi, pourquoi) {
    if (!estGlobal(req)) throw new HttpError(403, `${quoi} concerne tout le serveur${pourquoi ? ' (' + pourquoi + ')' : ''} : réservé aux utilisateurs ayant accès à tous les sites`);
  }
  const exigerGestionDestinations = (req) => exigerGlobal(req, 'La gestion des destinations de sauvegarde', 'chaque sauvegarde contient la base complète de tous les sites');
  /** Destination visible (une destination commune, sans site, est visible de tous ceux qui ont le droit). */
  function voitDest(req, d) { return d.secteurId == null || ctx.canSee(req, d); }
  function trouverDestination(req, id, ecriture) {
    const n = Number(id);
    const d = Number.isInteger(n) ? destinations().find((x) => x.id === n) : null;
    if (!d) throw new HttpError(404, 'Destination introuvable');
    if (!voitDest(req, d)) {
      if (ecriture && perms.canSeeRecord(req.perms, req.user, d)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
      throw new HttpError(404, 'Destination introuvable');
    }
    if (ecriture && d.secteurId == null && !estGlobal(req)) throw new HttpError(403, 'Une destination commune à tous les sites ne peut être gérée que par un utilisateur ayant accès à tous les sites');
    return d;
  }
  function validerSecteur(req, v) {
    if (v === null || v === '' || v === undefined) return null;
    const id = Number(v);
    if (!Number.isInteger(id) || !db.get('secteurs', id)) throw new HttpError(400, 'Site ou secteur inconnu');
    if (!ctx.canSee(req, { secteurId: id })) throw new HttpError(403, 'Ce site ne fait pas partie de votre périmètre (ou n\'est accessible qu\'en lecture)');
    return id;
  }

  // ----- Validation -----
  function validerChemin(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) throw new HttpError(400, 'Le chemin du dossier est obligatoire');
    if (s.length > 240) throw new HttpError(400, 'Chemin trop long (240 caractères maximum)');
    if (/[\u0000-\u001f<>"|?*]/.test(s)) throw new HttpError(400, 'Le chemin contient des caractères interdits (< > " | ? *)');
    if (!cheminAbsoluValide(s)) throw new HttpError(400, 'Indiquez un chemin complet, par exemple D:\\Sauvegardes\\GMAO, E:\\GMAO (clé USB) ou \\\\NAS\\GMAO (partage réseau)');
    if (s.split(/[\\/]+/).includes('..')) throw new HttpError(400, 'Le chemin ne doit pas contenir « .. »');
    if (dans(s, ctx.clientDir)) throw new HttpError(400, 'Dossier interdit : il est publié par le serveur web de la GMAO');
    if (dans(s, dossierRecus())) throw new HttpError(400, 'Dossier interdit : il contient les sauvegardes reçues des autres sites');
    return s;
  }
  function validerUrl(v) {
    let u;
    try { u = new URL(String(v == null ? '' : v).trim()); } catch (e) { throw new HttpError(400, 'Adresse du serveur invalide (exemple : http://srv-valreas:8585)'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'L\'adresse doit commencer par http:// ou https://');
    if (u.username || u.password) throw new HttpError(400, 'L\'adresse ne doit pas contenir d\'identifiant ni de mot de passe');
    if (u.search || u.hash) throw new HttpError(400, 'L\'adresse ne doit contenir ni paramètres (?) ni ancre (#)');
    if (!u.hostname) throw new HttpError(400, 'Adresse du serveur invalide');
    return (u.origin + u.pathname).replace(/\/+$/, '');
  }
  function validerCle(v) {
    const s = String(v).trim();
    if (s.length < 16 || s.length > 200 || !/^[\x21-\x7e]+$/.test(s)) throw new HttpError(400, 'Clé de réception invalide : copiez la clé générée sur le serveur de l\'autre site (au moins 16 caractères, sans espace)');
    return s;
  }
  /** Nom d'un fichier de sauvegarde ; `copieAvant` accepte aussi les copies de l'état précédent (dossier local seulement). */
  function validerNomFichier(v, { copieAvant = false } = {}) {
    let n = String(v == null ? '' : v);
    try { n = decodeURIComponent(n); } catch (e) { throw new HttpError(400, 'Nom de fichier de sauvegarde invalide'); }
    if (!n || n.length > 160 || /[\\/\u0000]/.test(n) || n.includes('..') || !(RE_FICHIER.test(n) || (copieAvant && RE_COPIE_AVANT.test(n)))) throw new HttpError(400, 'Nom de fichier de sauvegarde invalide');
    return n;
  }
  function validerEmpreinte(v) {
    if (v === null || v === undefined || v === '') return '';
    const e = typeof v === 'string' ? tlsGmao.normaliserEmpreinte(v) : '';
    if (!e) throw new HttpError(400, 'Empreinte du certificat invalide : 64 caractères hexadécimaux (ex. AB:CD:…), telle qu\'affichée sur le poste serveur de l\'autre site');
    return e;
  }
  function validerSite(v) {
    const s = String(v == null ? '' : v);
    if (!RE_SITE.test(s)) throw new HttpError(400, 'Site source invalide');
    return s;
  }
  function entier(v, min, max, libelle) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${libelle} : nombre entier entre ${min} et ${max}`);
    return n;
  }
  function booleen(v, libelle) {
    if (typeof v !== 'boolean') throw new HttpError(400, `${libelle} : valeur oui / non attendue`);
    return v;
  }

  function validerDestination(req, b, existant) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Données de destination invalides');
    const now = new Date().toISOString();
    const out = existant ? Object.assign({}, existant) : { actif: true, conserver: 10, secteurId: null, notes: '', derniere: null, derniereVerification: null, createdAt: now, createdBy: req.user.id };
    if (!existant || b.nom !== undefined) {
      const n = String(b.nom == null ? '' : b.nom).replace(/[\u0000-\u001f]/g, ' ').trim();
      if (!n) throw new HttpError(400, 'Le nom de la destination est obligatoire');
      if (n.length > 80) throw new HttpError(400, 'Nom trop long (80 caractères maximum)');
      out.nom = n;
    }
    if (!existant || b.type !== undefined) {
      if (!TYPES.includes(b.type)) throw new HttpError(400, 'Type de destination invalide (« dossier » ou « serveur »)');
      out.type = b.type;
    }
    if (b.actif !== undefined) out.actif = booleen(b.actif, 'Destination active');
    if (b.conserver !== undefined) out.conserver = entier(b.conserver, 1, 365, 'Nombre de sauvegardes conservées');
    if (b.notes !== undefined) out.notes = String(b.notes == null ? '' : b.notes).slice(0, 500);
    if (b.secteurId !== undefined) out.secteurId = validerSecteur(req, b.secteurId);
    if (out.type === 'dossier') {
      if (b.chemin !== undefined || !existant || existant.type !== 'dossier') out.chemin = validerChemin(b.chemin === undefined ? out.chemin : b.chemin);
      delete out.url; delete out.cle;
    } else {
      if (b.url !== undefined || !existant || existant.type !== 'serveur') out.url = validerUrl(b.url === undefined ? out.url : b.url);
      if (typeof b.cle === 'string' && b.cle.trim()) out.cle = validerCle(b.cle);
      else if (b.cle !== undefined && b.cle !== null && b.cle !== '') throw new HttpError(400, 'Clé de réception invalide');
      if (!out.cle) throw new HttpError(400, 'La clé de réception du serveur distant est obligatoire (elle est générée sur l\'autre site)');
      if (b.empreinte !== undefined) {
        const e = validerEmpreinte(b.empreinte);
        if (e !== (out.empreinte || '')) out.empreinteCle = ''; // nouvelle empreinte confirmée : la clé associée sera réapprise
        out.empreinte = e;
      }
      if (!out.empreinte) { out.empreinte = ''; out.empreinteCle = ''; }
      delete out.chemin;
    }
    if (out.type === 'dossier') { delete out.empreinte; delete out.empreinteCle; }
    if (out.secteurId == null && !estGlobal(req)) throw new HttpError(403, 'Rattachez la destination à l\'un de vos sites : une destination commune à tous les sites est réservée aux utilisateurs ayant accès à tous les sites');
    const doublon = destinations().find((d) => d.id !== out.id && String(d.nom).toLowerCase() === out.nom.toLowerCase());
    if (doublon) throw new HttpError(400, `Une destination nommée « ${out.nom} » existe déjà`);
    out.updatedAt = now;
    return out;
  }

  // ----- Présentation (sans secrets) -----
  function publierDestination(d) {
    return {
      id: d.id, nom: d.nom, type: d.type, actif: d.actif !== false, conserver: d.conserver || 10,
      chemin: d.type === 'dossier' ? (d.chemin || '') : '', url: d.type === 'serveur' ? (d.url || '') : '',
      cleDefinie: !!d.cle, secteurId: d.secteurId == null ? null : d.secteurId, notes: d.notes || '',
      empreinte: d.type === 'serveur' ? (d.empreinte || '') : '', empreinteCle: d.type === 'serveur' ? (d.empreinteCle || '') : '',
      derniere: d.derniere || null, derniereVerification: d.derniereVerification || null,
      demo: !!d.demo, createdAt: d.createdAt || null, updatedAt: d.updatedAt || null, createdBy: d.createdBy == null ? null : d.createdBy,
    };
  }
  function publierParametres(s, now = new Date()) {
    const p = prochaineExecution(s, now);
    return {
      automatique: !!s.automatique, frequenceHeures: Number(s.frequenceHeures) || 24, heure: s.heure || '22:00',
      conserverLocal: Number.isFinite(Number(s.conserverLocal)) ? Number(s.conserverLocal) : 30,
      compresser: s.compresser !== false, chiffrer: !!s.chiffrer, accepterReception: !!s.accepterReception,
      conserverRecues: Number(s.conserverRecues) || 10,
      nomServeur: String(s.nomServeur || ''), nomServeurEffectif: nomServeur(),
      motDePasseDefini: !!s.motDePasseChiffrement, cleReceptionDefinie: !!s.cleReception, cleReceptionDate: s.cleReceptionDate || null,
      derniereExecution: s.derniereExecution || null, derniereReussite: s.derniereReussite || null,
      echecsConsecutifs: Number(s.echecsConsecutifs) || 0,
      prochaineExecution: p ? p.toISOString() : null,
    };
  }
  /** Origine d'une restauration sans nom de destination ni de site (accès non globaux). */
  function origineGenerique(h) {
    const o = String(h.origine || '');
    const t = h.origineType || (/^destination/.test(o) ? 'destination' : /^sauvegarde reçue/.test(o) ? 'recue' : /^fichier/.test(o) ? 'fichier' : 'locale');
    return { destination: 'destination de sauvegarde', recue: 'sauvegarde reçue d\'un autre site', fichier: 'fichier téléversé', locale: 'copie locale' }[t] || 'copie locale';
  }
  function histoPublic(req, h) {
    const e = Object.assign({}, h);
    if (Array.isArray(h.resultats)) {
      e.resultats = h.resultats.filter((r) => r.secteurId == null || ctx.canSee(req, { secteurId: r.secteurId }));
      if (h.resultats.length && !e.resultats.length && !h.local) return null;
    }
    if (h.type === 'restauration' && !estGlobal(req)) e.origine = origineGenerique(h);
    e.userNom = h.userId != null ? ctx.nomUser(h.userId) : (h.declencheur === 'automatique' ? 'Planification automatique' : '');
    return e;
  }
  /** Ce serveur répond-il en HTTPS (certificat du poste, écoute mixte de l'application de bureau) ? */
  function serveurChiffre(req) { return !!((req && req.socket && req.socket.encrypted) || ctx.empreinteCertificat); }
  /** Adresses à communiquer aux autres sites, avec le protocole réellement servi. */
  function adressesServeur(req) {
    const port = req && req.socket && req.socket.localPort;
    const proto = serveurChiffre(req) ? 'https' : 'http';
    const out = [];
    for (const liste of Object.values(os.networkInterfaces())) {
      for (const i of liste || []) if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(`${proto}://${i.address}:${port}`);
    }
    out.push(`${proto}://${os.hostname()}:${port}`);
    return Array.from(new Set(out));
  }
  function listerRecues() {
    if (db.inMemory) return [];
    const base = dossierRecus();
    let entrees;
    try { entrees = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return []; }
    return entrees.filter((d) => d.isDirectory() && RE_SITE.test(d.name)).map((d) => {
      const dossier = path.join(base, d.name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dossier, '.gmao-source.json'), 'utf8')) || {}; } catch (e) { meta = {}; }
      const fichiers = listerFichiersGmao(dossier);
      return {
        site: d.name, nom: typeof meta.nom === 'string' && meta.nom ? meta.nom.slice(0, 80) : d.name,
        derniereReception: typeof meta.derniereReception === 'string' ? meta.derniereReception : (fichiers[0] ? fichiers[0].modifie : null),
        ip: typeof meta.ip === 'string' ? meta.ip.slice(0, 60) : '',
        nombre: fichiers.length, tailleTotale: fichiers.reduce((t, f) => t + f.taille, 0), fichiers: fichiers.slice(0, 100),
      };
    }).sort((a, b) => String(a.nom).localeCompare(String(b.nom)));
  }
  /** Copies de l'état précédent faites par la base avant un import ou une restauration (restaurables : retour en arrière). */
  function listerCopiesAvant(dossier) {
    let noms;
    try { noms = fs.readdirSync(dossier); } catch (e) { return []; }
    return noms.map((n) => {
      const m = RE_COPIE_AVANT.exec(n);
      if (!m) return null;
      let st;
      try { st = fs.statSync(path.join(dossier, n)); } catch (e) { return null; }
      if (!st.isFile()) return null;
      const d = new Date(Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8])));
      return {
        nom: n, identifiant: identifiant(), horodatage: `${m[2]}${m[3]}${m[4]}-${m[5]}${m[6]}${m[7]}-000`,
        date: Number.isNaN(d.getTime()) ? st.mtime.toISOString() : d.toISOString(), modifie: st.mtime.toISOString(),
        taille: st.size, compresse: false, chiffre: false, sha256: null, etatPrecedent: m[1],
      };
    }).filter(Boolean);
  }
  function listerLocales() {
    if (db.inMemory) return [];
    return listerFichiersGmao(db.backupDir).concat(listerCopiesAvant(db.backupDir)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 200);
  }

  // ----- Historique -----
  function ajouterHistorique(entree) {
    const e = db.insert(COL_HISTO, Object.assign({ date: new Date().toISOString(), secteurId: null }, entree));
    const col = db.data.collections[COL_HISTO];
    if (col && col.length > HISTO_MAX) { col.splice(0, col.length - HISTO_MAX); db.touch(); }
    return e;
  }
  /**
   * Alerte le pôle informatique (Système › Modifier) d'un échec. Chaque destinataire ne reçoit que le détail des
   * destinations qu'il peut voir (portée, sites) ; les autres sont seulement comptées.
   */
  function notifierEchec(titre, { generique = '', local = null, resultats = [] } = {}) {
    const config = db.getConfig();
    const echecs = resultats.filter((r) => !r.ok);
    const groupes = new Map(); // message → destinataires
    for (const u of ctx.usersAvecDroit('systeme', 'modifier')) {
      const p = perms.effectivePermissions(db, u, null, config);
      const voit = (r) => r.secteurId == null || perms.canSeeRecord(p, u, { secteurId: r.secteurId });
      const lignes = [local && !local.ok ? local.message : null].concat(echecs.filter(voit).map((r) => `${r.nom} : ${r.message}`)).filter(Boolean);
      const caches = echecs.filter((r) => !voit(r)).length;
      if (caches) lignes.push(`${caches} destination${caches > 1 ? 's' : ''} d'un autre site en échec`);
      const message = (lignes.length ? lignes.join(' · ') : String(generique)).slice(0, 500);
      if (!groupes.has(message)) groupes.set(message, []);
      groupes.get(message).push(u.id);
    }
    for (const [message, ids] of groupes) ctx.notify(ids, { titre, message, lien: LIEN_UI, type: 'alerte' });
  }

  // ----- Planification -----
  function dernierCreneau(now, heure) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(heure || '22:00')) || [null, '22', '00'];
    const d = new Date(now.getTime());
    d.setHours(Math.min(23, Number(m[1])), Math.min(59, Number(m[2])), 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    return d;
  }
  function frequence(s) { return Math.min(720, Math.max(1, Math.round(Number(s.frequenceHeures) || 24))); }
  /** Fréquence d'au moins un jour, en jours entiers (24 h → 1, 48 h → 2 ; une valeur intermédiaire est arrondie au jour supérieur). */
  function joursFrequence(freq) { return Math.max(1, Math.ceil(freq / 24)); }
  function dateDerniere(s) {
    const d = s && s.derniereExecution && s.derniereExecution.date ? new Date(s.derniereExecution.date) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  }
  /** Essais déjà faits dans le cycle courant (depuis la dernière échéance planifiée) ; anciennes données : échecs consécutifs. */
  function essaisDuCycle(s) { return s && s.essaisCycle != null ? (Number(s.essaisCycle) || 0) : (Number(s && s.echecsConsecutifs) || 0); }
  /** Créneaux quotidiens écoulés entre la dernière exécution et maintenant (insensible aux changements d'heure). */
  function creneauxEcoules(der, now, heure) { return Math.round((dernierCreneau(now, heure).getTime() - dernierCreneau(der, heure).getTime()) / 86400000); }
  /**
   * Pourquoi une sauvegarde automatique est due : 'planifiee', 'nouvel_essai', ou null.
   *  - fréquence < 24 h : dès que la dernière exécution date de plus de `frequenceHeures` ;
   *  - fréquence ≥ 24 h : au créneau quotidien `heure`, une fois écoulé le nombre de jours de la fréquence depuis
   *    le créneau de la dernière exécution (serveur arrêté au créneau : rattrapage au démarrage) ;
   *  - après un échec : nouvel essai 1 h plus tard, 3 essais au plus par cycle (le compteur d'essais repart à
   *    chaque échéance planifiée, quel que soit le nombre total d'échecs consécutifs).
   */
  function raisonDue(s, now = new Date()) {
    if (!s || !s.automatique) return null;
    const freq = frequence(s);
    const der = dateDerniere(s);
    if (!der) return 'planifiee';
    const planifiee = freq < 24 ? now - der >= freq * 3600 * 1000 - 2 * 60 * 1000 : creneauxEcoules(der, now, s.heure) >= joursFrequence(freq);
    if (planifiee) return 'planifiee';
    if (s.derniereExecution.ok === false && essaisDuCycle(s) < ESSAIS_MAX && now - der >= NOUVEL_ESSAI_MS) return 'nouvel_essai';
    return null;
  }
  function estDue(s, now = new Date()) { return raisonDue(s, now) != null; }
  function prochaineExecution(s, now = new Date()) {
    if (!s || !s.automatique) return null;
    const freq = frequence(s);
    const der = dateDerniere(s);
    if (!der) return new Date(now.getTime());
    let planifiee;
    if (freq < 24) planifiee = new Date(der.getTime() + freq * 3600 * 1000);
    else { planifiee = dernierCreneau(der, s.heure); planifiee.setDate(planifiee.getDate() + joursFrequence(freq)); }
    if (s.derniereExecution.ok === false && essaisDuCycle(s) < ESSAIS_MAX) {
      const essai = new Date(der.getTime() + NOUVEL_ESSAI_MS);
      if (essai.getTime() < planifiee.getTime()) return essai;
    }
    return planifiee;
  }
  async function verifierPlanification(now = new Date()) {
    if (verrou) return false;
    const s = lireSauvegardes();
    const raison = raisonDue(s, now);
    if (!raison) return false;
    const actives = destinations().filter((d) => d.actif !== false);
    if (!actives.length && (db.inMemory || !(Number(s.conserverLocal) > 0))) return false;
    try { await executer({ declencheur: 'automatique', nouvelEssai: raison === 'nouvel_essai' }); } catch (e) { ctx.log('Sauvegarde automatique impossible :', e.message); }
    return true;
  }

  // ----- Envoi vers les destinations -----
  function testerDossier(chemin) {
    validerChemin(chemin);
    fs.mkdirSync(chemin, { recursive: true });
    const f = path.join(chemin, `.gmao-test-${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(f, 'Test d\'écriture GMAO SICAF');
    const lu = fs.readFileSync(f, 'utf8');
    fs.unlinkSync(f);
    if (!lu.startsWith('Test')) throw new Error('Relecture du fichier de test incorrecte');
    let libre = null;
    try { if (fs.statfsSync) { const st = fs.statfsSync(chemin); libre = Number(st.bavail) * Number(st.bsize); } } catch (e) { libre = null; }
    const nb = listerFichiersGmao(chemin).length;
    return { ok: true, message: 'Dossier accessible en écriture' + (libre != null ? ` — ${formatTaille(libre)} libres` : '') + ` — ${nb} sauvegarde${nb > 1 ? 's' : ''} présente${nb > 1 ? 's' : ''}`, espaceLibre: libre, fichiers: nb };
  }
  function entetesReplication(d) {
    return { 'X-GMAO-Cle': d.cle || '', 'X-GMAO-Source': encodeURIComponent(nomServeur()), 'X-GMAO-Format': String(FORMAT) };
  }
  /** Épinglage attendu pour une destination « serveur » en HTTPS (null tant qu'aucune empreinte n'est confirmée). */
  function epinglageDe(d) { return d.empreinte || d.empreinteCle ? { empreinte: d.empreinte || '', empreinteCle: d.empreinteCle || '' } : null; }
  /** Après une connexion HTTPS vérifiée : mémorise l'empreinte de la clé (renouvellement reconnu) et suit un certificat renouvelé. */
  function memoriserCertificat(d, certificat) {
    if (!d || !certificat || !d.empreinte) return;
    if (certificat.parCle && certificat.empreinte) d.empreinte = certificat.empreinte;
    if (certificat.empreinteCle && (!d.empreinteCle || certificat.parCle)) d.empreinteCle = certificat.empreinteCle;
  }
  const CODES_TEST = ['EMPREINTE_NON_CONFIRMEE', 'EMPREINTE_DIFFERENTE', 'REDIRECTION_HTTPS'];
  async function pingServeur(d) {
    const r = await requete(d.url + '/api/replication/ping', { entetes: entetesReplication(d), delaiMs: DELAI_PING_MS, delaiTotalMs: DELAI_PING_MS * 2, userAgent: `GMAO-SICAF-Replication/${ctx.version}`, epinglage: epinglageDe(d) });
    if (r.status !== 200 || !r.json || r.json.ok !== true) throw new Error(messageDistant(r));
    const site = String(r.json.site || '').slice(0, 80);
    const version = String(r.json.version || '').slice(0, 20);
    return { ok: true, site, version, certificat: r.certificat, message: `Connexion réussie au serveur GMAO « ${site || d.url} »${version ? ` (version ${version})` : ''} — réception des sauvegardes active${r.certificat ? ', certificat HTTPS vérifié' : ''}` };
  }
  /** Empreinte SHA-256 d'un fichier relu en flux (vérification après écriture sur le support). */
  function empreinteFichier(chemin) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const flux = fs.createReadStream(chemin);
      flux.on('error', reject);
      flux.on('data', (c) => h.update(c));
      flux.on('end', () => resolve(h.digest('hex')));
    });
  }
  /**
   * Écrit la sauvegarde et son .sha256 dans un dossier, puis relit le fichier écrit : une empreinte différente
   * (écriture incomplète, support défaillant) supprime le fichier et lève une erreur.
   */
  async function copierVerifiee(dossier, fichier, tampon, sha) {
    ecrireDansDossier(dossier, fichier, tampon, sha);
    const chemin = path.join(dossier, fichier);
    let relu = null;
    try { relu = await empreinteFichier(chemin); } catch (e) { relu = null; }
    if (relu !== sha) {
      try { fs.unlinkSync(chemin); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(chemin + '.sha256'); } catch (e) { /* ignore */ }
      throw new Error('Empreinte différente après relecture du fichier écrit : écriture incomplète ou support défaillant (fichier supprimé)');
    }
  }
  async function envoyerVers(d, tampon, fichier, sha) {
    if (d.type === 'dossier') {
      validerChemin(d.chemin);
      try {
        await copierVerifiee(d.chemin, fichier, tampon, sha);
        const supprimes = appliquerRetention(d.chemin, d.conserver || 10, identifiant());
        return { message: `Copiée dans ${d.chemin} (empreinte vérifiée après relecture)` + (supprimes.length ? ` (${supprimes.length} ancienne${supprimes.length > 1 ? 's' : ''} supprimée${supprimes.length > 1 ? 's' : ''})` : '') };
      } catch (e) { throw new Error(messageFs(e)); }
    }
    const entetes = Object.assign(entetesReplication(d), {
      'Content-Type': 'application/octet-stream', 'X-GMAO-Fichier': fichier, 'X-GMAO-Sha256': sha, 'X-GMAO-Conserver': String(d.conserver || 10),
    });
    const r = await requete(d.url + '/api/replication/recevoir', { methode: 'POST', entetes, corps: tampon, userAgent: `GMAO-SICAF-Replication/${ctx.version}`, epinglage: epinglageDe(d) });
    if (r.status !== 200 || !r.json || r.json.ok !== true) throw new Error(messageDistant(r));
    if (r.json.sha256 && r.json.sha256 !== sha) throw new Error('Empreinte SHA-256 différente côté serveur distant : transfert corrompu');
    return { message: `Envoyée au serveur « ${String(r.json.site || d.url).slice(0, 80)} » (empreinte vérifiée${r.certificat ? ', connexion chiffrée' : ''})`, certificat: r.certificat };
  }
  /** Message d'erreur quand aucune cible n'est disponible pour une sauvegarde. */
  function messageRienASauvegarder({ global, filtreSite, s }) {
    const actives = destinations().filter((d) => d.actif !== false).length;
    if (!global) return actives ? 'Aucune destination active dans votre périmètre (site sélectionné compris) : les destinations communes à tous les sites et la copie locale sont réservées aux utilisateurs ayant accès à tous les sites' : 'Aucune destination active : demandez l\'ajout d\'une destination à un utilisateur ayant accès à tous les sites';
    if (filtreSite && actives) return 'Aucune destination active pour le site sélectionné : choisissez « Tous les sites » dans l\'en-tête, ou rattachez une destination active à ce site';
    if (db.inMemory) return 'Aucune destination active : ajoutez une destination (dossier ou serveur d\'un autre site)';
    return Number(s.conserverLocal) > 0 ? 'Aucune destination active : ajoutez une destination (dossier ou serveur d\'un autre site)' : 'Aucune destination active et copie locale désactivée : rien à sauvegarder';
  }

  // ----- Exécution d'une sauvegarde -----
  async function executer({ req = null, destinationId = null, declencheur = 'manuel', nouvelEssai = false } = {}) {
    if (verrou) throw new HttpError(409, 'Une sauvegarde ou une restauration est déjà en cours, réessayez dans quelques instants');
    verrou = { type: 'sauvegarde', debut: Date.now() };
    try { return await executerInterne({ req, destinationId, declencheur, nouvelEssai }); } finally { verrou = null; }
  }

  async function executerInterne({ req, destinationId, declencheur, nouvelEssai }) {
    const debut = Date.now();
    const dateDebut = new Date().toISOString();
    const s = lireSauvegardes();
    const global = !req || estGlobal(req);
    const filtreSite = !!(req && req.perms && Array.isArray(req.perms.siteFiltre)); // sélecteur de site positionné sur un site
    let cibles;
    if (destinationId != null) cibles = [req ? trouverDestination(req, destinationId, true) : destinations().find((d) => d.id === Number(destinationId))].filter(Boolean);
    else cibles = destinations().filter((d) => d.actif !== false && (!req || (voitDest(req, d) && (d.secteurId != null || global))));
    const faireLocal = destinationId == null && global && !db.inMemory && Number(s.conserverLocal) > 0;
    // Exécution « complète » (toutes les destinations actives, prise en compte par la planification) : accès à tous les
    // sites sans filtre de site ; avec le sélecteur sur un site, les destinations des autres sites ne sont pas tentées.
    const complete = destinationId == null && global && !filtreSite;
    if (!cibles.length && !faireLocal) throw new HttpError(400, messageRienASauvegarder({ global, filtreSite, s }));
    const userId = req && req.user ? req.user.id : null;
    const compresse = s.compresser !== false;
    const chiffre = !!s.chiffrer;

    // Encodage (une seule fois pour toutes les destinations)
    let tampon, sha, fichier;
    try {
      tampon = await encoder(donneesASauvegarder(), { compresser: compresse, chiffrer: chiffre, motDePasse: s.motDePasseChiffrement });
      sha = sha256(tampon);
      fichier = nomFichier(compresse, chiffre);
    } catch (e) {
      const message = 'Préparation de la sauvegarde impossible : ' + e.message;
      const entree = ajouterHistorique({ type: 'sauvegarde', declencheur, userId, ok: false, message, dureeMs: Date.now() - debut, resultats: [], local: null, destinationId: destinationId == null ? null : Number(destinationId) });
      if (complete) majSauvegardes((x) => { x.derniereExecution = { date: dateDebut, ok: false, message }; x.echecsConsecutifs = (Number(x.echecsConsecutifs) || 0) + 1; x.essaisCycle = nouvelEssai ? (Number(x.essaisCycle) || 0) + 1 : 1; });
      ctx.audit(req, 'sauvegarde', 'sauvegardes', entree.id, message);
      notifierEchec('Échec de la sauvegarde de la base', { generique: message });
      ctx.emit('sauvegarde:echec', entree);
      throw erreurHttp(e);
    }

    let local = null;
    if (faireLocal) {
      try {
        await copierVerifiee(db.backupDir, fichier, tampon, sha);
        const supprimes = appliquerRetention(db.backupDir, Number(s.conserverLocal), identifiant());
        local = { ok: true, message: 'Copie locale enregistrée' + (supprimes.length ? ` (${supprimes.length} ancienne${supprimes.length > 1 ? 's' : ''} supprimée${supprimes.length > 1 ? 's' : ''})` : ''), dossier: db.backupDir };
      } catch (e) { local = { ok: false, message: 'Copie locale impossible : ' + messageFs(e), dossier: db.backupDir }; }
    }

    // Envoi : un échec n'empêche pas les autres destinations
    const certificats = new Map(); // destination → certificat HTTPS vérifié
    const resultats = await Promise.all(cibles.map(async (d) => {
      const t0 = Date.now();
      const base = { destinationId: d.id, nom: d.nom, type: d.type, secteurId: d.secteurId == null ? null : d.secteurId, emplacement: d.type === 'dossier' ? d.chemin : d.url };
      try {
        const r = await envoyerVers(d, tampon, fichier, sha);
        if (r.certificat) certificats.set(d.id, r.certificat);
        return Object.assign(base, { ok: true, message: r.message, taille: tampon.length, dureeMs: Date.now() - t0 });
      } catch (e) {
        return Object.assign(base, { ok: false, message: (e && e.message) || String(e), taille: 0, dureeMs: Date.now() - t0 });
      }
    }));

    const ok = (!local || local.ok) && resultats.every((r) => r.ok);
    const nbOk = resultats.filter((r) => r.ok).length;
    const dureeMs = Date.now() - debut;
    const message = ok
      ? `Sauvegarde réussie (${formatTaille(tampon.length)}) : ${[local ? 'copie locale' : null, resultats.length ? `${nbOk}/${resultats.length} destination${resultats.length > 1 ? 's' : ''}` : null].filter(Boolean).join(', ')}`
      : `Sauvegarde incomplète : ${[local && !local.ok ? 'copie locale en échec' : null, resultats.length ? `${resultats.length - nbOk} destination${resultats.length - nbOk > 1 ? 's' : ''} en échec sur ${resultats.length}` : null].filter(Boolean).join(', ')}`;

    majSauvegardes((x) => {
      for (const r of resultats) {
        const d = x.destinations.find((y) => y.id === r.destinationId);
        if (!d) continue;
        d.derniere = { date: dateDebut, ok: r.ok, message: r.message, taille: r.taille, dureeMs: r.dureeMs, fichier: r.ok ? fichier : null };
        memoriserCertificat(d, certificats.get(d.id));
      }
      if (complete) {
        x.derniereExecution = { date: dateDebut, ok, message };
        if (ok) { x.derniereReussite = dateDebut; x.echecsConsecutifs = 0; x.essaisCycle = 0; } else { x.echecsConsecutifs = (Number(x.echecsConsecutifs) || 0) + 1; x.essaisCycle = nouvelEssai ? (Number(x.essaisCycle) || 0) + 1 : 1; }
      }
    });
    const entree = ajouterHistorique({
      type: 'sauvegarde', date: dateDebut, declencheur, userId, ok, message, fichier, taille: tampon.length, sha256: sha, compresse, chiffre, dureeMs,
      local, resultats, destinationId: destinationId == null ? null : Number(destinationId), complete, siteCourantId: filtreSite ? req.perms.siteCourantId : null,
    });
    ctx.audit(req, 'sauvegarde', 'sauvegardes', entree.id, `${declencheur === 'automatique' ? 'Sauvegarde automatique' : 'Sauvegarde'} ${fichier} : ${message}` + (filtreSite ? ' (site sélectionné uniquement)' : '') + (resultats.length ? ' — ' + resultats.map((r) => `${r.nom} ${r.ok ? 'OK' : 'ÉCHEC'}`).join(', ') : ''));
    if (!ok) {
      notifierEchec(declencheur === 'automatique' ? 'Échec de la sauvegarde automatique' : 'Échec de sauvegarde', { generique: message, local, resultats });
      ctx.emit('sauvegarde:echec', entree);
    } else ctx.emit('sauvegarde:terminee', entree);
    return { ok, message, fichier, taille: tampon.length, sha256: sha, compresse, chiffre, dureeMs, local, resultats, complete, historiqueId: entree.id };
  }

  // ----- Restauration -----
  async function restaurer(req, buf, { shaAttendu, motDePasse, origine, origineType, fichier }) {
    if (verrou) throw new HttpError(409, 'Une sauvegarde ou une restauration est déjà en cours, réessayez dans quelques instants');
    verrou = { type: 'restauration', debut: Date.now() };
    try {
      const empreinte = sha256(buf);
      if (shaAttendu && empreinte !== shaAttendu) throw new HttpError(400, 'Empreinte SHA-256 différente de celle enregistrée : fichier corrompu, restauration annulée');
      const s = lireSauvegardes();
      let decode;
      try { decode = await decoder(buf, (typeof motDePasse === 'string' && motDePasse) || s.motDePasseChiffrement); } catch (e) { throw erreurHttp(e); }
      const { data, chiffre, compresse } = decode;
      const meta = data.exportGMAO && typeof data.exportGMAO === 'object' ? data.exportGMAO : {};
      // Les paramètres de sauvegarde (destinations, clés) et l'historique de CE serveur sont conservés.
      const sauvegardesActuelles = db.getConfig().sauvegardes;
      const historique = db.list(COL_HISTO);
      const avant = new Set(db.listBackups().map((b) => b.nom));
      delete data.exportGMAO;
      db.importAll(data); // la base fait une copie de l'état actuel avant l'import (gmao-avant-import-…)
      require('../seed').seed(db);
      const cfg = db.getConfig();
      cfg.sauvegardes = sauvegardesActuelles;
      db.setConfig(cfg);
      db.replaceCollection(COL_HISTO, historique);
      const copieAvant = (db.listBackups().find((b) => !avant.has(b.nom) && /avant-import/.test(b.nom)) || {}).nom || null;
      // Sessions : les comptes ont pu changer ; seule la session courante est conservée si le compte est identique.
      let garder = false;
      if (req && req.session && req.user) {
        const u = db.get('users', req.user.id);
        garder = !!(u && u.login === req.user.login && u.actif !== false);
      }
      for (const token of Array.from(ctx.sessions.map.keys())) if (!(garder && token === req.session.token)) ctx.sessions.destroy(token);
      const message = `Base restaurée depuis ${fichier}` + (meta.source ? ` (sauvegarde de « ${String(meta.source).slice(0, 80)} »${meta.date ? ' du ' + new Date(meta.date).toLocaleString('fr-FR') : ''})` : '');
      const entree = ajouterHistorique({
        type: 'restauration', userId: req && req.user ? req.user.id : null, ok: true, message, origine, origineType: origineType || null, fichier,
        source: meta.source ? String(meta.source).slice(0, 80) : null, dateSauvegarde: typeof meta.date === 'string' ? meta.date : null,
        sha256: empreinte, empreinteVerifiee: !!shaAttendu, chiffre, compresse, taille: buf.length, copieAvant,
      });
      ctx.audit(req, 'restauration', 'sauvegardes', entree.id, message + (copieAvant ? ` — état précédent copié dans ${copieAvant}` : ''));
      db.saveNow();
      ctx.emit('sauvegarde:restauree', { origine, fichier, source: meta.source || null });
      return { ok: true, message, fichier, origine, chiffre, compresse, empreinteVerifiee: !!shaAttendu, copieAvant, sessionConservee: garder, source: meta.source || null, dateSauvegarde: meta.date || null };
    } finally { verrou = null; }
  }

  // ----- Réception (autre site → ce serveur) -----
  function authentifierReplication(req) {
    const ip = String((req.socket && req.socket.remoteAddress) || '');
    const cleBlocage = 'replication|' + ip;
    const bloc = ctx.sessions.blocage(cleBlocage);
    if (bloc > 0) throw new HttpError(429, `Trop de tentatives avec une clé invalide. Réessayez dans ${bloc} s`);
    const s = lireSauvegardes();
    if (!s.accepterReception) throw new HttpError(403, 'La réception des sauvegardes d\'autres sites est désactivée sur ce serveur');
    const fournie = String(req.headers['x-gmao-cle'] || '');
    if (!s.cleReception || !cleValide(fournie, s.cleReception)) {
      ctx.sessions.echec(cleBlocage);
      ctx.audit(req, 'refus', 'sauvegardes', null, `Réplication refusée : clé de réception invalide (adresse ${ip || 'inconnue'})`);
      throw new HttpError(403, 'Clé de réception invalide');
    }
    ctx.sessions.succes(cleBlocage);
    return s;
  }
  function sourceDepuisEntete(v) {
    let n = String(v == null ? '' : v);
    try { n = decodeURIComponent(n); } catch (e) { /* valeur brute */ }
    n = n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) || 'Site inconnu';
    return { nom: n, dossier: assainirSegment(n) || 'inconnu' };
  }

  router.get('/api/replication/ping', async (req) => {
    authentifierReplication(req);
    return { ok: true, site: nomServeur(), version: ctx.version, format: FORMAT, reception: !db.inMemory };
  }, { public: true });

  router.post('/api/replication/recevoir', async (req) => {
    const s = authentifierReplication(req);
    if (db.inMemory) throw new HttpError(503, 'Réception impossible : ce serveur fonctionne sans stockage sur disque');
    const source = sourceDepuisEntete(req.headers['x-gmao-source']);
    const ip = String((req.socket && req.socket.remoteAddress) || '');
    const fichier = validerNomFichier(req.headers['x-gmao-fichier']);
    const shaAttendu = String(req.headers['x-gmao-sha256'] || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(shaAttendu)) throw new HttpError(400, 'Empreinte SHA-256 (en-tête X-GMAO-Sha256) manquante ou invalide');
    const corps = Buffer.isBuffer(req.body) ? req.body : null;
    if (!corps || !corps.length) throw new HttpError(400, 'Fichier de sauvegarde vide');
    const sha = sha256(corps);
    const refus = (message) => {
      ajouterHistorique({ type: 'reception', ok: false, message, source: source.nom, site: source.dossier, fichier, taille: corps.length, ip });
      ctx.audit(req, 'refus', 'sauvegardes', null, `Sauvegarde de « ${source.nom} » refusée : ${message}`);
      return new HttpError(400, message);
    };
    if (!egalTempsConstant(sha, shaAttendu)) throw refus('Empreinte SHA-256 différente : le fichier a été altéré pendant le transfert');
    if (!formatCoherent(corps, fichier)) throw refus('Le fichier reçu n\'est pas une sauvegarde GMAO');
    const dossier = path.join(dossierRecus(), source.dossier);
    if (!dans(dossier, dossierRecus()) || path.resolve(dossier) === path.resolve(dossierRecus())) throw new HttpError(400, 'Site source invalide');
    try {
      ecrireDansDossier(dossier, fichier, corps, sha);
      fs.writeFileSync(path.join(dossier, '.gmao-source.json'), JSON.stringify({ nom: source.nom, derniereReception: new Date().toISOString(), ip }));
    } catch (e) { throw new HttpError(500, 'Enregistrement de la sauvegarde reçue impossible : ' + messageFs(e)); }
    const demande = parseInt(req.headers['x-gmao-conserver'], 10);
    const max = Math.max(1, Number(s.conserverRecues) || 10);
    const conserver = Number.isInteger(demande) && demande > 0 ? Math.min(demande, max) : max;
    const supprimes = appliquerRetention(dossier, conserver);
    const entree = ajouterHistorique({ type: 'reception', ok: true, message: `Sauvegarde reçue de « ${source.nom} » (${formatTaille(corps.length)})`, source: source.nom, site: source.dossier, fichier, taille: corps.length, sha256: sha, ip, chiffre: /\.enc$/.test(fichier), compresse: /\.gz(\.enc)?$/.test(fichier), supprimes: supprimes.length });
    ctx.audit(req, 'reception', 'sauvegardes', entree.id, `Sauvegarde reçue de « ${source.nom} » (${ip}) : ${fichier}, ${formatTaille(corps.length)}`);
    ctx.emit('sauvegarde:recue', { source: source.nom, site: source.dossier, fichier, taille: corps.length });
    return { ok: true, fichier, taille: corps.length, sha256: sha, site: nomServeur(), recuLe: entree.date, conservees: Math.min(conserver, listerFichiersGmao(dossier).length) };
  }, { public: true, brut: true, maxBody: MAX_RECU });

  /** Liste, pour le site émetteur, des sauvegardes qu'il a déposées sur ce serveur. */
  router.get('/api/replication/fichiers', async (req) => {
    authentifierReplication(req);
    if (db.inMemory) return { site: nomServeur(), fichiers: [] };
    const source = sourceDepuisEntete(req.headers['x-gmao-source']);
    const fichiers = listerFichiersGmao(path.join(dossierRecus(), source.dossier)).slice(0, 100)
      .map((f) => ({ nom: f.nom, date: f.date, taille: f.taille, sha256: f.sha256, chiffre: f.chiffre, compresse: f.compresse, identifiant: f.identifiant }));
    return { site: nomServeur(), fichiers };
  }, { public: true });

  // ----- Routes d'administration -----
  router.get('/api/sauvegardes-avancees', async (req) => {
    exigerVoir(req);
    const s = lireSauvegardes();
    const historique = db.list(COL_HISTO).sort((a, b) => b.id - a.id).map((h) => histoPublic(req, h)).filter(Boolean).slice(0, HISTO_API);
    return {
      parametres: publierParametres(s),
      destinations: destinations().filter((d) => voitDest(req, d)).map(publierDestination),
      historique,
      recues: listerRecues(),
      locales: listerLocales(),
      serveur: {
        nom: nomServeur(), identifiant: identifiant(), version: ctx.version, memoire: !!db.inMemory, plateforme: process.platform,
        dossierLocal: db.inMemory ? null : db.backupDir, dossierRecus: db.inMemory ? null : dossierRecus(),
        adresses: adressesServeur(req), protocole: serveurChiffre(req) ? 'https' : 'http', empreinte: ctx.empreinteCertificat || '',
        enCours: verrou ? verrou.type : null, planification: !db.inMemory,
      },
      droits: { modifier: peutModifier(req), global: estGlobal(req), restaurer: peutModifier(req) && estGlobal(req), destinations: peutModifier(req) && estGlobal(req) },
    };
  }, { perm: ['systeme', 'voir'] });

  router.put('/api/sauvegardes-avancees/parametres', async (req) => {
    exigerModif(req);
    exigerGlobal(req, 'La planification des sauvegardes');
    const b = req.body || {};
    if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Paramètres invalides');
    const actuel = lireSauvegardes();
    const maj = {};
    if (b.automatique !== undefined) maj.automatique = booleen(b.automatique, 'Sauvegarde automatique');
    if (b.frequenceHeures !== undefined) {
      maj.frequenceHeures = entier(b.frequenceHeures, 1, 720, 'Fréquence (heures)');
      if (maj.frequenceHeures > 24 && maj.frequenceHeures % 24 !== 0) throw new HttpError(400, 'Fréquence (heures) : au-delà d\'un jour, indiquez un nombre entier de jours (48, 72, 168…), la sauvegarde ayant lieu au créneau quotidien');
    }
    if (b.heure !== undefined) {
      if (typeof b.heure !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.heure)) throw new HttpError(400, 'Heure invalide (format HH:MM)');
      maj.heure = b.heure;
    }
    if (b.conserverLocal !== undefined) maj.conserverLocal = entier(b.conserverLocal, 0, 365, 'Copies locales conservées');
    if (b.conserverRecues !== undefined) maj.conserverRecues = entier(b.conserverRecues, 1, 365, 'Sauvegardes reçues conservées par site');
    if (b.compresser !== undefined) maj.compresser = booleen(b.compresser, 'Compression');
    if (b.chiffrer !== undefined) maj.chiffrer = booleen(b.chiffrer, 'Chiffrement');
    if (b.accepterReception !== undefined) maj.accepterReception = booleen(b.accepterReception, 'Réception des sauvegardes');
    if (b.nomServeur !== undefined) {
      if (b.nomServeur !== null && typeof b.nomServeur !== 'string') throw new HttpError(400, 'Nom du serveur invalide');
      const n = String(b.nomServeur || '').replace(/[\u0000-\u001f<>]/g, '').trim();
      if (n.length > 80) throw new HttpError(400, 'Nom du serveur trop long (80 caractères maximum)');
      maj.nomServeur = n;
    }
    let mdpModifie = false;
    if (b.supprimerMotDePasse === true) { maj.motDePasseChiffrement = ''; mdpModifie = true; }
    if (b.motDePasseChiffrement !== undefined && b.motDePasseChiffrement !== null && b.motDePasseChiffrement !== '') {
      if (typeof b.motDePasseChiffrement !== 'string' || b.motDePasseChiffrement.length < 8 || b.motDePasseChiffrement.length > 200) throw new HttpError(400, 'Le mot de passe de chiffrement doit contenir entre 8 et 200 caractères');
      maj.motDePasseChiffrement = b.motDePasseChiffrement;
      mdpModifie = true;
    }
    const chiffrerFinal = maj.chiffrer !== undefined ? maj.chiffrer : !!actuel.chiffrer;
    const mdpFinal = maj.motDePasseChiffrement !== undefined ? maj.motDePasseChiffrement : actuel.motDePasseChiffrement;
    if (chiffrerFinal && !mdpFinal) throw new HttpError(400, 'Définissez un mot de passe de chiffrement pour activer le chiffrement');
    const s = majSauvegardes((x) => Object.assign(x, maj));
    const changes = Object.keys(maj).filter((k) => k !== 'motDePasseChiffrement' && actuel[k] !== maj[k]).map((k) => `${k} : ${actuel[k]} → ${maj[k]}`);
    if (mdpModifie) changes.push(maj.motDePasseChiffrement ? 'mot de passe de chiffrement modifié' : 'mot de passe de chiffrement supprimé');
    ctx.audit(req, 'modification', 'sauvegardes', null, 'Paramètres de sauvegarde' + (changes.length ? ' : ' + changes.join(', ') : ' (inchangés)'));
    return publierParametres(s);
  }, { perm: ['systeme', 'modifier'] });

  router.post('/api/sauvegardes-avancees/destinations', async (req) => {
    exigerModif(req);
    exigerGestionDestinations(req);
    const d = validerDestination(req, req.body, null);
    if (destinations().length >= MAX_DESTINATIONS) throw new HttpError(400, `${MAX_DESTINATIONS} destinations au maximum`);
    let cree;
    majSauvegardes((s) => {
      let seq = Number(s.sequenceDestinations) || 0;
      for (const x of s.destinations) if (Number.isInteger(x.id)) seq = Math.max(seq, x.id);
      d.id = seq + 1;
      s.sequenceDestinations = d.id;
      s.destinations.push(d);
      cree = d;
    });
    ctx.audit(req, 'creation', 'sauvegardes', cree.id, `Destination de sauvegarde « ${cree.nom} » (${cree.type === 'dossier' ? 'dossier ' + cree.chemin : 'serveur ' + cree.url})`);
    return publierDestination(cree);
  }, { perm: ['systeme', 'modifier'] });

  router.put('/api/sauvegardes-avancees/destinations/:id', async (req) => {
    exigerModif(req);
    exigerGestionDestinations(req);
    const avant = trouverDestination(req, req.params.id, true);
    const apres = validerDestination(req, req.body, avant);
    majSauvegardes((s) => { const i = s.destinations.findIndex((x) => x.id === avant.id); if (i >= 0) s.destinations[i] = apres; });
    const champs = ['nom', 'type', 'actif', 'conserver', 'chemin', 'url', 'secteurId', 'notes', 'empreinte'].filter((k) => JSON.stringify(avant[k]) !== JSON.stringify(apres[k]));
    if (apres.cle !== avant.cle) champs.push('clé');
    ctx.audit(req, 'modification', 'sauvegardes', avant.id, `Destination « ${apres.nom} »` + (champs.length ? ' : ' + champs.join(', ') : ' (inchangée)'));
    return publierDestination(apres);
  }, { perm: ['systeme', 'modifier'] });

  router.delete('/api/sauvegardes-avancees/destinations/:id', async (req) => {
    exigerModif(req);
    exigerGestionDestinations(req);
    const d = trouverDestination(req, req.params.id, true);
    majSauvegardes((s) => { s.destinations = s.destinations.filter((x) => x.id !== d.id); });
    ctx.audit(req, 'suppression', 'sauvegardes', d.id, `Destination de sauvegarde « ${d.nom} » supprimée (les fichiers déjà copiés sont conservés)`);
    return { ok: true };
  }, { perm: ['systeme', 'modifier'] });

  router.post('/api/sauvegardes-avancees/destinations/:id/tester', async (req) => {
    exigerModif(req);
    const d = trouverDestination(req, req.params.id, true);
    const t0 = Date.now();
    let r;
    try { r = d.type === 'dossier' ? testerDossier(d.chemin) : await pingServeur(d); } catch (e) {
      r = { ok: false, message: d.type === 'dossier' ? messageFs(e) : ((e && e.message) || String(e)) };
      // Certificat non confirmé ou différent, redirection vers https:// : l'interface propose l'action adaptée
      if (e && CODES_TEST.includes(e.code)) Object.assign(r, { code: e.code, empreintePresentee: e.empreinte || '', empreinteClePresentee: e.empreinteCle || '', adresseHttps: e.adresseHttps || '' });
    }
    r.dureeMs = Date.now() - t0;
    majSauvegardes((s) => {
      const x = s.destinations.find((y) => y.id === d.id);
      if (!x) return;
      x.derniereVerification = { date: new Date().toISOString(), ok: r.ok, message: r.message };
      if (r.ok) memoriserCertificat(x, r.certificat);
    });
    delete r.certificat;
    return r;
  }, { perm: ['systeme', 'modifier'] });

  router.get('/api/sauvegardes-avancees/destinations/:id/fichiers', async (req) => {
    exigerVoir(req);
    const d = trouverDestination(req, req.params.id, false);
    const ident = identifiant();
    if (d.type === 'dossier') {
      try { validerChemin(d.chemin); } catch (e) { throw new HttpError(400, e.message); }
      let fichiers;
      try { fichiers = listerFichiersGmao(d.chemin); } catch (e) { throw new HttpError(400, 'Lecture du dossier impossible : ' + messageFs(e)); }
      return { destination: publierDestination(d), emplacement: d.chemin, fichiers: fichiers.slice(0, 200).map((f) => Object.assign(f, { ceServeur: f.identifiant === ident })), restaurable: true };
    }
    let r;
    try { r = await requete(d.url + '/api/replication/fichiers', { entetes: entetesReplication(d), delaiMs: DELAI_PING_MS, delaiTotalMs: DELAI_PING_MS * 2, userAgent: `GMAO-SICAF-Replication/${ctx.version}`, epinglage: epinglageDe(d) }); } catch (e) { throw new HttpError(502, e.message); }
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.fichiers)) throw new HttpError(502, messageDistant(r));
    const fichiers = r.json.fichiers.slice(0, 200).map((f) => ({
      nom: String(f.nom || '').slice(0, 160), date: typeof f.date === 'string' ? f.date : null, taille: Number(f.taille) || 0,
      sha256: /^[a-f0-9]{64}$/.test(String(f.sha256 || '')) ? f.sha256 : null, chiffre: !!f.chiffre, compresse: !!f.compresse, ceServeur: f.identifiant === ident,
    }));
    return { destination: publierDestination(d), emplacement: d.url, site: String(r.json.site || '').slice(0, 80), fichiers, restaurable: false };
  }, { perm: ['systeme', 'voir'] });

  router.post('/api/sauvegardes-avancees/executer', async (req) => {
    exigerModif(req);
    const b = req.body || {};
    const destinationId = b.destinationId === undefined || b.destinationId === null || b.destinationId === '' ? null : Number(b.destinationId);
    if (destinationId != null && !Number.isInteger(destinationId)) throw new HttpError(400, 'Destination invalide');
    return executer({ req, destinationId, declencheur: 'manuel' });
  }, { perm: ['systeme', 'modifier'] });

  /** Chemin d'un fichier de sauvegarde désigné par { source, destinationId?, site?, fichier }. */
  function cheminSource(req, b) {
    const source = b.source;
    if (source === 'destination') {
      const d = trouverDestination(req, b.destinationId, true);
      if (d.type !== 'dossier') throw new HttpError(400, 'La restauration directe n\'est possible que depuis un dossier. Pour un serveur d\'un autre site, utilisez les sauvegardes reçues sur ce serveur ou téléchargez le fichier.');
      validerChemin(d.chemin);
      const n = validerNomFichier(b.fichier);
      return { chemin: path.join(d.chemin, n), fichier: n, origine: `destination « ${d.nom} »`, origineType: 'destination' };
    }
    if (source === 'recue') {
      let site = b.site;
      let n = b.fichier;
      if ((site === undefined || site === null || site === '') && typeof n === 'string' && n.includes('/')) { const i = n.indexOf('/'); site = n.slice(0, i); n = n.slice(i + 1); }
      site = validerSite(site);
      n = validerNomFichier(n);
      if (db.inMemory) throw new HttpError(404, 'Fichier de sauvegarde introuvable');
      const chemin = path.join(dossierRecus(), site, n);
      if (!dans(chemin, dossierRecus())) throw new HttpError(400, 'Nom de fichier de sauvegarde invalide');
      return { chemin, fichier: n, origine: `sauvegarde reçue (${site})`, origineType: 'recue' };
    }
    if (source === 'locale') {
      const n = validerNomFichier(b.fichier, { copieAvant: true });
      if (db.inMemory) throw new HttpError(404, 'Fichier de sauvegarde introuvable');
      const avant = RE_COPIE_AVANT.test(n);
      return { chemin: path.join(db.backupDir, n), fichier: n, origine: avant ? 'copie locale de l\'état précédent (faite avant une restauration ou un import)' : 'copie locale', origineType: 'locale' };
    }
    throw new HttpError(400, 'Source de restauration invalide (destination, recue ou locale)');
  }

  router.post('/api/sauvegardes-avancees/restaurer', async (req) => {
    exigerModif(req);
    exigerGlobal(req, 'La restauration de la base');
    const b = req.body || {};
    const src = cheminSource(req, b);
    const buf = (() => { try { return lireFichierSauvegarde(src.chemin); } catch (e) { throw erreurHttp(e); } })();
    return restaurer(req, buf, { shaAttendu: lireSha(src.chemin), motDePasse: typeof b.motDePasse === 'string' ? b.motDePasse : '', origine: src.origine, origineType: src.origineType, fichier: src.fichier });
  }, { perm: ['systeme', 'modifier'] });

  /** Restauration depuis un fichier téléversé (ex. sauvegarde récupérée sur une clé USB ou chez un autre site). */
  router.post('/api/sauvegardes-avancees/restaurer-fichier', async (req) => {
    if (req.headers['x-requested-with'] !== 'GMAO') throw new HttpError(403, 'En-tête X-Requested-With manquant');
    exigerModif(req);
    exigerGlobal(req, 'La restauration de la base');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) throw new HttpError(400, 'Aucun fichier reçu');
    let mdp = '';
    let n = '';
    try { mdp = decodeURIComponent(String(req.headers['x-gmao-mot-de-passe'] || '')); n = decodeURIComponent(String(req.headers['x-gmao-fichier'] || '')); } catch (e) { throw new HttpError(400, 'En-têtes invalides'); }
    n = n.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 160) || 'fichier téléversé';
    const sha = String(req.headers['x-gmao-sha256'] || '').trim().toLowerCase();
    return restaurer(req, buf, { shaAttendu: /^[a-f0-9]{64}$/.test(sha) ? sha : null, motDePasse: mdp, origine: 'fichier téléversé', origineType: 'fichier', fichier: n });
  }, { perm: ['systeme', 'modifier'], brut: true, maxBody: MAX_RECU });

  /** Téléchargement d'un fichier de sauvegarde (équivalent d'un export : Système › Modifier). */
  router.get('/api/sauvegardes-avancees/telecharger', async (req, res) => {
    exigerModif(req);
    exigerGlobal(req, 'Le téléchargement d\'une sauvegarde complète');
    const src = cheminSource(req, Object.assign({}, req.query, { destinationId: req.query.destinationId }));
    let st;
    try { st = fs.statSync(src.chemin); } catch (e) { throw new HttpError(404, 'Fichier de sauvegarde introuvable'); }
    if (!st.isFile()) throw new HttpError(404, 'Fichier de sauvegarde introuvable');
    ctx.audit(req, 'export', 'sauvegardes', null, `Téléchargement de la sauvegarde ${src.fichier} (${src.origine})`);
    const sha = lireSha(src.chemin);
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${src.fichier}"`, 'X-Content-Type-Options': 'nosniff',
    }, sha ? { 'X-GMAO-Sha256': sha } : {}));
    await new Promise((resolve) => {
      const flux = fs.createReadStream(src.chemin);
      flux.on('error', () => { res.destroy(); resolve(); });
      res.on('close', resolve);
      flux.pipe(res);
    });
    if (!res.writableEnded) res.end();
  }, { perm: ['systeme', 'modifier'] });

  router.delete('/api/sauvegardes-avancees/recues/:site/:fichier', async (req) => {
    exigerModif(req);
    exigerGlobal(req, 'La suppression d\'une sauvegarde reçue');
    const src = cheminSource(req, { source: 'recue', site: req.params.site, fichier: req.params.fichier });
    try { fs.unlinkSync(src.chemin); } catch (e) { throw new HttpError(e.code === 'ENOENT' ? 404 : 400, e.code === 'ENOENT' ? 'Fichier de sauvegarde introuvable' : messageFs(e)); }
    try { fs.unlinkSync(src.chemin + '.sha256'); } catch (e) { /* ignore */ }
    ctx.audit(req, 'suppression', 'sauvegardes', null, `Sauvegarde reçue supprimée : ${req.params.site}/${src.fichier}`);
    return { ok: true };
  }, { perm: ['systeme', 'modifier'] });

  router.post('/api/sauvegardes-avancees/cle-reception/generer', async (req) => {
    exigerModif(req);
    exigerGlobal(req, 'La clé de réception');
    const cle = 'gmao_' + crypto.randomBytes(32).toString('base64url');
    const date = new Date().toISOString();
    const deja = !!lireSauvegardes().cleReception;
    majSauvegardes((s) => { s.cleReception = 'sha256:' + empreinteCle(cle).toString('hex'); s.cleReceptionDate = date; });
    ctx.audit(req, 'generation', 'sauvegardes', null, deja ? 'Nouvelle clé de réception des sauvegardes (l\'ancienne clé est révoquée)' : 'Clé de réception des sauvegardes générée');
    return { cle, date, remplace: deja, avertissement: 'Copiez cette clé maintenant : elle ne sera plus jamais affichée. Saisissez-la sur le serveur GMAO de l\'autre site (destination de type « serveur »).' };
  }, { perm: ['systeme', 'modifier'] });

  router.delete('/api/sauvegardes-avancees/cle-reception', async (req) => {
    exigerModif(req);
    exigerGlobal(req, 'La clé de réception');
    majSauvegardes((s) => { s.cleReception = ''; s.cleReceptionDate = null; });
    ctx.audit(req, 'suppression', 'sauvegardes', null, 'Clé de réception des sauvegardes révoquée');
    return { ok: true };
  }, { perm: ['systeme', 'modifier'] });

  // ----- Services et planification -----
  ctx.services.sauvegardes = {
    executer: (options) => executer(options || {}),
    estDue: (s, now) => estDue(s, now),
    prochaineExecution: (s, now) => prochaineExecution(s, now),
    verifierPlanification: (now) => verifierPlanification(now),
    encoder, decoder,
    enCours: () => (verrou ? verrou.type : null),
  };
  if (!db.inMemory) {
    const minuterie = setInterval(() => { verifierPlanification(new Date()).catch((e) => ctx.log('Planification des sauvegardes :', e.message)); }, INTERVALLE_PLANIF_MS);
    if (minuterie.unref) minuterie.unref();
  }
}

/** Destinations d'exemple (désactivées) : NAS, clé USB et serveur du site de Valréas. */
function seedDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const s = Object.assign({}, PARAMS_DEFAUT, cfg.sauvegardes || {});
  s.destinations = Array.isArray(s.destinations) ? s.destinations.filter((d) => d && typeof d === 'object') : [];
  if (s.destinations.some((d) => d.demo)) return 'déjà présentes';
  const secteur = (code) => { const x = db.findOne('secteurs', (y) => y.code === code); return x ? x.id : null; };
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const now = new Date().toISOString();
  let seq = Number(s.sequenceDestinations) || 0;
  for (const d of s.destinations) if (Number.isInteger(d.id)) seq = Math.max(seq, d.id);
  const base = { actif: false, demo: true, derniere: null, derniereVerification: null, createdAt: now, updatedAt: now, createdBy: admin ? admin.id : null };
  const exemples = [
    { nom: 'NAS du service informatique', type: 'dossier', chemin: '\\\\NAS-SICAF\\GMAO\\Sauvegardes', conserver: 30, secteurId: secteur('SITE'), notes: 'Partage réseau du local serveur de Carpentras. Exemple : vérifiez le chemin et les droits d\'écriture du compte Windows, testez puis activez la destination.' },
    { nom: 'Clé USB de secours (coffre-fort)', type: 'dossier', chemin: 'E:\\GMAO', conserver: 7, secteurId: null, notes: 'Clé USB chiffrée BitLocker, échangée chaque vendredi et rangée dans le coffre de l\'accueil.' },
    { nom: 'Serveur GMAO de Valréas', type: 'serveur', url: 'http://srv-valreas:8585', cle: 'demo_' + crypto.randomBytes(24).toString('base64url'), conserver: 14, secteurId: secteur('VAL'), notes: 'Réplication croisée entre usines : Valréas conserve une copie des sauvegardes de Carpentras (et inversement). Remplacez la clé par celle générée sur le serveur de Valréas.' },
  ];
  for (const e of exemples) s.destinations.push(Object.assign({}, base, e, { id: ++seq }));
  s.sequenceDestinations = seq;
  cfg.sauvegardes = s;
  db.setConfig(cfg);
  return `${exemples.length} destinations d'exemple (désactivées)`;
}

module.exports = { nom, register, seedDemo, encoder, decoder, assainirSegment, cleValide, RE_FICHIER, RE_COPIE_AVANT };
