'use strict';
/**
 * Chiffrement des échanges entre les postes (HTTPS), sans dépendance externe.
 *
 *  - Certificat X.509 v3 auto-signé (ECDSA P-256 / SHA-256) généré sur le poste serveur : la
 *    structure ASN.1 du certificat est encodée ici en DER, la signature est confiée au module crypto.
 *  - Confiance par empreinte (épinglage) : chaque poste client enregistre l'empreinte SHA-256 du
 *    certificat confirmée par le pôle informatique, ainsi que celle de la clé publique. Le serveur
 *    renouvelle son certificat (échéance, nouvelle adresse IP) en conservant sa clé : les postes
 *    déjà appairés l'acceptent alors sans nouvelle confirmation.
 *  - Écoute « mixte » : un seul port accepte HTTPS et répond aux requêtes HTTP en clair par une
 *    redirection vers https:// (aucune page ni donnée n'est servie sans chiffrement).
 *  - Sonde d'un serveur GMAO (HTTP ou HTTPS) : l'empreinte présentée est vérifiée AVANT tout envoi.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const tls = require('tls');
const http = require('http');

const DUREE_VALIDITE_ANS = 10;
const MARGE_RENOUVELLEMENT_MS = 30 * 24 * 60 * 60 * 1000; // renouvellement 30 jours avant l'échéance
const TOLERANCE_HORLOGE_MS = 60 * 60 * 1000;               // début de validité une heure avant la génération
const MAX_ADRESSES = 64;
const FORMAT_EMPREINTE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const OID = {
  nomCommun: '2.5.4.3',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  rsaSha256: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

// ----- Encodage DER (ASN.1) ---------------------------------------------------------------

function longueurDer(n) {
  if (n < 0x80) return Buffer.from([n]);
  const octets = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) octets.unshift(v & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
}

function tlv(etiquette, contenu) {
  const c = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu);
  return Buffer.concat([Buffer.from([etiquette]), longueurDer(c.length), c]);
}

const sequence = (...elements) => tlv(0x30, Buffer.concat(elements));
const ensemble = (...elements) => tlv(0x31, Buffer.concat(elements));
const explicite = (numero, contenu) => tlv(0xa0 | numero, contenu);
const chaineOctets = (b) => tlv(0x04, b);
const booleenVrai = () => tlv(0x01, Buffer.from([0xff]));
const nul = () => tlv(0x05, Buffer.alloc(0));

/** Entier positif (Buffer gros-boutiste ou petit nombre) en encodage minimal. */
function entierDer(valeur) {
  let b = Buffer.isBuffer(valeur) ? Buffer.from(valeur) : Buffer.from([valeur]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oidDer(texte) {
  const arcs = texte.split('.').map(Number);
  const octets = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const pile = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) pile.unshift((v & 0x7f) | 0x80);
    octets.push(...pile);
  }
  return tlv(0x06, Buffer.from(octets));
}

/** UTCTime jusqu'en 2049, GeneralizedTime au-delà (RFC 5280 § 4.1.2.5). */
function dateDer(d) {
  const compact = d.toISOString().slice(0, 19).replace(/[-:T]/g, '') + 'Z'; // AAAAMMJJHHMMSSZ
  const annee = d.getUTCFullYear();
  return annee >= 1950 && annee < 2050 ? tlv(0x17, Buffer.from(compact.slice(2), 'ascii')) : tlv(0x18, Buffer.from(compact, 'ascii'));
}

function chaineBits(contenu, bitsInutilises = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([bitsInutilises]), contenu]));
}

/** keyUsage : chaîne de bits nommés (bit 0 = digitalSignature, bit 2 = keyEncipherment). */
function usagesCle(bits) {
  let octet = 0;
  for (const b of bits) octet |= 0x80 >> b;
  let inutilises = 0;
  while (inutilises < 7 && !(octet & (1 << inutilises))) inutilises++;
  return chaineBits(Buffer.from([octet]), inutilises);
}

function extension(oid, valeur, critique) {
  return sequence(oidDer(oid), critique ? booleenVrai() : Buffer.alloc(0), chaineOctets(valeur));
}

function versPem(type, der) {
  const lignes = der.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lignes.join('\n')}\n-----END ${type}-----\n`;
}

// ----- Empreintes ------------------------------------------------------------------------

function formaterEmpreinte(octets) {
  return octets.toString('hex').toUpperCase().match(/../g).join(':');
}

/** Empreinte saisie ou enregistrée → forme canonique « AB:CD:… » (64 chiffres hexadécimaux), ou ''. */
function normaliserEmpreinte(valeur) {
  if (typeof valeur !== 'string') return '';
  const hex = valeur.replace(/^sha256[/:]?/i, '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return '';
  return hex.match(/../g).join(':');
}

/** Comparaison en temps constant de deux empreintes (fausse si l'une est absente ou invalide). */
function empreintesEgales(a, b) {
  const x = normaliserEmpreinte(a);
  const y = normaliserEmpreinte(b);
  if (!x || !y) return false;
  return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y));
}

function versX509(certificat) {
  if (certificat instanceof crypto.X509Certificate) return certificat;
  return new crypto.X509Certificate(certificat);
}

/** Empreinte SHA-256 du certificat (DER), format « AB:CD:… ». */
function empreinte(certificat) {
  return versX509(certificat).fingerprint256;
}

/** Empreinte SHA-256 de la clé publique (SubjectPublicKeyInfo DER), format « AB:CD:… ». */
function empreinteCle(source) {
  let cle;
  if (source instanceof crypto.KeyObject) cle = source.type === 'private' ? crypto.createPublicKey(source) : source;
  else cle = versX509(source).publicKey;
  return formaterEmpreinte(crypto.createHash('sha256').update(cle.export({ type: 'spki', format: 'der' })).digest());
}

/**
 * Le certificat présenté correspond-il à l'épinglage enregistré ?
 * Accepté si l'empreinte du certificat est identique, ou si la clé publique est la même et que le
 * certificat est bien signé par cette clé (certificat renouvelé par le même poste serveur).
 * @param {string|Buffer|crypto.X509Certificate} certificat  PEM, DER ou objet X509Certificate
 * @param {{ empreinte?: string, empreinteCle?: string }} attendu
 * @returns {{ ok: boolean, parCle: boolean, empreinte: string, empreinteCle: string }}
 */
function verifierEpinglage(certificat, attendu) {
  let x509;
  try { x509 = versX509(certificat); } catch (e) { return { ok: false, parCle: false, empreinte: '', empreinteCle: '' }; }
  const fp = x509.fingerprint256;
  const fpCle = empreinteCle(x509);
  const a = attendu || {};
  if (empreintesEgales(fp, a.empreinte)) return { ok: true, parCle: false, empreinte: fp, empreinteCle: fpCle };
  let signeParSaCle = false;
  try { signeParSaCle = x509.verify(x509.publicKey); } catch (e) { signeParSaCle = false; }
  if (signeParSaCle && empreintesEgales(fpCle, a.empreinteCle)) return { ok: true, parCle: true, empreinte: fp, empreinteCle: fpCle };
  return { ok: false, parCle: false, empreinte: fp, empreinteCle: fpCle };
}

// ----- Génération du certificat ------------------------------------------------------------

/** Nom du poste utilisable dans un certificat (caractères autorisés dans un nom DNS). */
function nettoyerNomPoste(nom) {
  const n = String(nom || '').trim().toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 63);
  return n || 'serveur-gmao';
}

/** Adresses IPv4 de toutes les interfaces du poste (127.0.0.1 compris). */
function adressesIPv4() {
  const out = new Set(['127.0.0.1']);
  for (const liste of Object.values(os.networkInterfaces())) {
    for (const i of liste || []) if ((i.family === 'IPv4' || i.family === 4) && net.isIPv4(i.address)) out.add(i.address);
  }
  return Array.from(out).slice(0, MAX_ADRESSES);
}

function listeAdresses(adresses) {
  const out = new Set(['127.0.0.1']);
  for (const a of Array.isArray(adresses) ? adresses : []) {
    const ip = typeof a === 'string' ? a.trim() : (a && typeof a.adresse === 'string' ? a.adresse.trim() : '');
    if (net.isIPv4(ip)) out.add(ip);
  }
  return Array.from(out).slice(0, MAX_ADRESSES);
}

function typeCleAccepte(cle) {
  if (!(cle instanceof crypto.KeyObject) || cle.type !== 'private') return false;
  if (cle.asymmetricKeyType === 'ec') return (cle.asymmetricKeyDetails || {}).namedCurve === 'prime256v1';
  if (cle.asymmetricKeyType === 'rsa') return ((cle.asymmetricKeyDetails || {}).modulusLength || 0) >= 2048;
  return false;
}

/**
 * Génère un certificat X.509 v3 auto-signé pour le serveur GMAO de ce poste.
 * @param {{ nomPoste?: string, adresses?: Array<string|{adresse:string}>, cle?: string|crypto.KeyObject,
 *           type?: 'ec'|'rsa', maintenant?: Date, dureeAns?: number }} [options]
 *   `cle` : clé privée existante à conserver (renouvellement) ; sinon une nouvelle clé est créée.
 * @returns {{ cle: string, certificat: string, empreinte: string, empreinteCle: string }}
 */
function genererCertificat(options = {}) {
  const nomPoste = nettoyerNomPoste(options.nomPoste || os.hostname());
  const adresses = listeAdresses(options.adresses);
  const maintenant = options.maintenant instanceof Date ? options.maintenant : new Date();
  const dureeAns = Number.isInteger(options.dureeAns) && options.dureeAns > 0 ? options.dureeAns : DUREE_VALIDITE_ANS;

  let privee;
  if (options.cle) privee = options.cle instanceof crypto.KeyObject ? options.cle : crypto.createPrivateKey(options.cle);
  else if (options.type === 'rsa') privee = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  else privee = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  if (!typeCleAccepte(privee)) throw new Error('Type de clé non pris en charge (ECDSA P-256 ou RSA 2048 bits minimum)');
  const rsa = privee.asymmetricKeyType === 'rsa';

  const spki = crypto.createPublicKey(privee).export({ type: 'spki', format: 'der' });
  const algorithme = rsa ? sequence(oidDer(OID.rsaSha256), nul()) : sequence(oidDer(OID.ecdsaSha256));
  const serie = crypto.randomBytes(16);
  serie[0] = (serie[0] & 0x7f) || 0x01; // positif, sans octet nul de tête
  const debut = new Date(maintenant.getTime() - TOLERANCE_HORLOGE_MS);
  const fin = new Date(maintenant.getTime());
  fin.setUTCFullYear(fin.getUTCFullYear() + dureeAns);
  const nom = sequence(ensemble(sequence(oidDer(OID.nomCommun), tlv(0x0c, Buffer.from(`GMAO SICAF ${nomPoste}`.slice(0, 64), 'utf8')))));

  const nomsAlternatifs = Buffer.concat([
    ...Array.from(new Set([nomPoste, 'localhost'])).map((n) => tlv(0x82, Buffer.from(n, 'ascii'))),      // dNSName
    ...adresses.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),                           // iPAddress
  ]);
  const extensions = sequence(
    extension(OID.basicConstraints, sequence(), true),                                   // CA:FALSE
    extension(OID.keyUsage, usagesCle(rsa ? [0, 2] : [0]), true),                        // digitalSignature (+ keyEncipherment)
    extension(OID.extKeyUsage, sequence(oidDer(OID.serverAuth)), false),                 // serverAuth
    extension(OID.subjectAltName, tlv(0x30, nomsAlternatifs), false),
    extension(OID.subjectKeyIdentifier, chaineOctets(crypto.createHash('sha256').update(spki).digest().subarray(0, 20)), false),
  );

  const tbs = sequence(
    explicite(0, entierDer(2)),            // version v3
    entierDer(serie),
    algorithme,
    nom,                                   // émetteur
    sequence(dateDer(debut), dateDer(fin)),
    nom,                                   // sujet (auto-signé)
    spki,
    explicite(3, extensions),
  );
  const signature = crypto.sign('sha256', tbs, privee); // ECDSA : signature DER ; RSA : PKCS#1 v1.5
  const der = sequence(tbs, algorithme, chaineBits(signature));
  const certificat = versPem('CERTIFICATE', der);
  return {
    cle: privee.export({ type: 'pkcs8', format: 'pem' }),
    certificat,
    empreinte: formaterEmpreinte(crypto.createHash('sha256').update(der).digest()),
    empreinteCle: formaterEmpreinte(crypto.createHash('sha256').update(spki).digest()),
  };
}

/**
 * Motif de renouvellement d'un certificat existant, ou '' s'il reste valable.
 */
function motifRenouvellement(x509, cle, { nomPoste, adresses, maintenant }) {
  let signe = false;
  try { signe = x509.verify(x509.publicKey); } catch (e) { signe = false; }
  if (!signe) return 'signature du certificat invalide';
  if (!x509.checkPrivateKey(cle)) return 'la clé ne correspond pas au certificat';
  const t = maintenant.getTime();
  if (new Date(x509.validTo).getTime() - t < MARGE_RENOUVELLEMENT_MS) return 'certificat expiré ou proche de son échéance';
  if (new Date(x509.validFrom).getTime() > t + TOLERANCE_HORLOGE_MS) return 'date de début de validité dans le futur (horloge du poste modifiée)';
  if (!x509.checkHost(nomPoste)) return 'nom du poste modifié';
  const manquante = adresses.find((ip) => !x509.checkIP(ip));
  if (manquante) return `nouvelle adresse réseau (${manquante})`;
  return '';
}

function ecrireAtomique(fichier, contenu, mode) {
  const tmp = `${fichier}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenu, { encoding: 'utf8', mode });
  fs.renameSync(tmp, fichier);
  try { fs.chmodSync(fichier, mode); } catch (e) { /* système de fichiers sans droits POSIX */ }
}

/**
 * Charge le certificat du poste serveur (<dossier>/tls/cle.pem et certificat.pem) ou le crée.
 * Il est régénéré s'il est illisible, expiré (ou à moins de 30 jours de l'échéance), si le nom du
 * poste a changé ou si une adresse IPv4 actuelle n'y figure pas. La clé privée existante est
 * conservée lors d'un renouvellement (l'empreinte de clé épinglée par les postes clients reste valable).
 * @param {string} dossier  dossier des données de la GMAO
 * @param {{ nomPoste?: string, adresses?: string[], maintenant?: Date, log?: Function }} [options]
 * @returns {{ cle: string, certificat: string, empreinte: string, empreinteCle: string, regenere: boolean, raison: string, dossier: string }}
 */
function chargerOuCreer(dossier, options = {}) {
  if (!dossier || typeof dossier !== 'string') throw new Error('Dossier des données non précisé pour le certificat du serveur');
  const rep = path.join(dossier, 'tls');
  const fichierCle = path.join(rep, 'cle.pem');
  const fichierCert = path.join(rep, 'certificat.pem');
  const nomPoste = nettoyerNomPoste(options.nomPoste || os.hostname());
  const adresses = listeAdresses(options.adresses || adressesIPv4());
  const maintenant = options.maintenant instanceof Date ? options.maintenant : new Date();
  const log = typeof options.log === 'function' ? options.log : () => {};

  let cle = null;
  let x509 = null;
  let pemCle = '';
  let pemCert = '';
  let raison = '';
  try {
    pemCle = fs.readFileSync(fichierCle, 'utf8');
    cle = crypto.createPrivateKey(pemCle);
    if (!typeCleAccepte(cle)) { cle = null; raison = 'type de clé non pris en charge'; }
  } catch (e) { cle = null; raison = e.code === 'ENOENT' ? 'première génération' : 'clé privée illisible'; }
  if (cle) {
    try {
      pemCert = fs.readFileSync(fichierCert, 'utf8');
      x509 = new crypto.X509Certificate(pemCert);
    } catch (e) { x509 = null; raison = e.code === 'ENOENT' ? 'certificat absent' : 'certificat illisible'; }
  }
  if (x509) raison = motifRenouvellement(x509, cle, { nomPoste, adresses, maintenant });
  if (x509 && !raison) {
    return { cle: pemCle, certificat: pemCert, empreinte: x509.fingerprint256, empreinteCle: empreinteCle(x509), regenere: false, raison: '', dossier: rep };
  }

  const g = genererCertificat({ nomPoste, adresses, cle: cle || undefined, maintenant });
  try {
    fs.mkdirSync(rep, { recursive: true, mode: 0o700 });
    if (!cle) ecrireAtomique(fichierCle, g.cle, 0o600);
    ecrireAtomique(fichierCert, g.certificat, 0o644);
  } catch (e) {
    throw new Error(`Impossible d'enregistrer le certificat du serveur dans « ${rep} » (${e.code || e.message}). Vérifiez les droits d'écriture sur le dossier des données.`);
  }
  log(`Certificat HTTPS ${cle ? 'renouvelé (clé conservée)' : 'créé'} : ${raison}. Empreinte : ${g.empreinte}`);
  return Object.assign(g, { cle: cle ? pemCle : g.cle, regenere: true, raison, dossier: rep });
}

// ----- Écoute mixte : HTTPS et redirection des requêtes HTTP sur le même port --------------------

function hoteDeLaRequete(entete) {
  const brut = String(entete || '').trim();
  const sansPort = brut.startsWith('[') ? brut.slice(0, brut.indexOf(']') + 1) : brut.replace(/:\d+$/, '');
  if (/^\[[0-9a-fA-F:.]{2,45}\]$/.test(sansPort)) return sansPort;
  if (/^[A-Za-z0-9.-]{1,253}$/.test(sansPort)) return sansPort.toLowerCase();
  return '';
}

/** Réponse aux requêtes HTTP en clair : redirection permanente vers https://, rien d'autre. */
function repondreSansChiffrement(req, res) {
  const port = req.socket.localPort;
  const hote = hoteDeLaRequete(req.headers.host);
  const chemin = typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') && req.url.length <= 2048 ? req.url : '/';
  const entetes = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", Connection: 'close',
  };
  const cible = hote ? `https://${hote}:${port}` : '';
  if (cible && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(308, Object.assign(entetes, { Location: cible + chemin, 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(`Connexion chiffrée obligatoire : ${cible}/\n`);
    return;
  }
  res.writeHead(cible ? 403 : 400, Object.assign(entetes, { 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify({ erreur: cible ? `Connexion chiffrée obligatoire : ce serveur GMAO n'accepte que l'adresse ${cible}/` : 'Adresse de serveur invalide' }));
}

/**
 * Écoute sur un port en aiguillant chaque connexion selon son premier octet : poignée de main
 * TLS → serveur HTTPS de la GMAO ; requête HTTP en clair → redirection vers https://.
 * @param {import('https').Server} serveurTls  serveur créé par createApp({ tls }) (non démarré)
 * @returns {Promise<{ serveur: net.Server, adresse: net.AddressInfo, fermer: () => Promise<void> }>}
 */
function ecouterMixte(serveurTls, port, hote) {
  const connexions = new Set();
  const redirection = http.createServer(repondreSansChiffrement);
  redirection.headersTimeout = 10000;
  redirection.requestTimeout = 15000;
  redirection.keepAliveTimeout = 1000;
  const aiguilleur = net.createServer((socket) => {
    connexions.add(socket);
    socket.once('close', () => connexions.delete(socket));
    socket.on('error', () => { /* connexion interrompue par le poste distant */ });
    socket.setTimeout(10000, () => socket.destroy()); // premier octet attendu sous 10 s
    socket.once('data', (premier) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(premier);
      if (premier[0] === 0x16) {
        serveurTls.emit('connection', socket); // la couche TLS reprend les données en attente
      } else if (premier[0] > 0x20 && premier[0] < 0x7f) {
        redirection.emit('connection', socket);
        socket.resume();
      } else {
        socket.destroy();
      }
    });
  });
  aiguilleur.maxConnections = 2000;
  return new Promise((resolve, reject) => {
    aiguilleur.once('error', reject);
    aiguilleur.listen(port || 0, hote || '127.0.0.1', () => {
      aiguilleur.removeListener('error', reject);
      // Les serveurs HTTP(S) n'écoutent pas eux-mêmes : l'événement « listening » active leur suivi
      // des connexions, indispensable aux délais headersTimeout / requestTimeout (connexions lentes).
      serveurTls.emit('listening');
      redirection.emit('listening');
      resolve({
        serveur: aiguilleur,
        adresse: aiguilleur.address(),
        fermer() {
          return new Promise((ok) => {
            aiguilleur.close(() => ok());
            for (const s of connexions) s.destroy();
            redirection.close();
            if (typeof serveurTls.closeAllConnections === 'function') { try { serveurTls.closeAllConnections(); } catch (e) { /* déjà fermé */ } }
          });
        },
      });
    });
  });
}

// ----- Sonde d'un serveur GMAO ---------------------------------------------------------------

function erreurReseau(e, chiffre) {
  const code = (e && e.code) || '';
  if (code === 'ECONNREFUSED') return { erreur: 'refus', message: 'Aucun serveur GMAO ne répond à cette adresse (poste éteint, pare-feu, adresse ou port incorrect).' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { erreur: 'nom', message: 'Nom de serveur introuvable sur le réseau : vérifiez l\'orthographe ou utilisez l\'adresse IP du poste serveur.' };
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(code)) return { erreur: 'injoignable', message: 'Le poste serveur est injoignable (poste éteint, réseau ou pare-feu).' };
  if (chiffre && (code === 'EPROTO' || /^ERR_SSL_/.test(code) || /wrong version number|packet length too long/i.test(String(e && e.message)))) {
    return { erreur: 'protocole', message: 'Ce serveur ne propose pas de connexion chiffrée (HTTPS) sur ce port.' };
  }
  if (code === 'ECONNRESET' || /^HPE_/.test(code)) return { erreur: 'protocole', message: 'Le serveur a interrompu la connexion (protocole inattendu).' };
  return { erreur: 'reseau', message: 'Aucun serveur GMAO ne répond à cette adresse (poste éteint, pare-feu, adresse ou port incorrect).' };
}

/**
 * Interroge un serveur GMAO (GET <adresse>/api/auth/infos) en HTTP ou en HTTPS.
 * En HTTPS, le certificat présenté est lu à la fin de la poignée de main : si une empreinte est
 * attendue et ne correspond pas, la connexion est coupée AVANT l'envoi de la moindre requête.
 * Les redirections ne sont pas suivies (une redirection HTTP → HTTPS du même poste est signalée).
 * @param {string} adresse  adresse de base normalisée (ex. https://srv-gmao:8585/)
 * @param {{ empreinte?: string, empreinteCle?: string, userAgent?: string, delaiMs?: number }} [options]
 * @returns {Promise<object>} { ok, protocole, url, infos, empreinte, empreinteCle, parCle } ou
 *   { ok: false, erreur, message, redirectionHttps?, empreinte?, empreinteCle? }
 */
function sonder(adresse, options = {}) {
  return new Promise((resolve) => {
    let base;
    let cibleUrl;
    try { base = new URL(adresse); cibleUrl = new URL('api/auth/infos', base); } catch (e) { resolve({ ok: false, erreur: 'adresse', message: 'Adresse invalide' }); return; }
    if (!['http:', 'https:'].includes(base.protocol)) { resolve({ ok: false, erreur: 'adresse', message: 'Adresse invalide' }); return; }
    const chiffre = base.protocol === 'https:';
    const hote = base.hostname.replace(/^\[|\]$/g, '');
    const port = Number(base.port) || (chiffre ? 443 : 80);
    const attendu = { empreinte: normaliserEmpreinte(options.empreinte), empreinteCle: normaliserEmpreinte(options.empreinteCle) };
    const epingle = !!(attendu.empreinte || attendu.empreinteCle);
    const delai = Number(options.delaiMs) > 0 ? Number(options.delaiMs) : 6000;
    let fini = false;
    let socket = null;
    let requete = null;
    const finir = (r) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      if (requete) requete.destroy();
      if (socket) socket.destroy();
      resolve(r);
    };
    const minuteur = setTimeout(() => finir({ ok: false, erreur: 'delai', message: 'Le serveur ne répond pas (délai dépassé).' }), delai);

    const envoyer = (creerConnexion, certificat) => {
      const opts = {
        host: hote, port, method: 'GET', path: cibleUrl.pathname,
        headers: { Host: base.host, Accept: 'application/json', 'User-Agent': String(options.userAgent || 'GMAO-SICAF-Bureau').slice(0, 300) },
      };
      if (creerConnexion) opts.createConnection = creerConnexion; else opts.agent = false;
      requete = http.request(opts, (res) => {
        const statut = res.statusCode;
        if (statut >= 300 && statut < 400) {
          res.resume();
          let loc = null;
          try { loc = new URL(String(res.headers.location || ''), cibleUrl); } catch (e) { loc = null; }
          if (!chiffre && loc && loc.protocol === 'https:' && loc.hostname === base.hostname) {
            const s = new URL(base.toString());
            s.protocol = 'https:';
            s.port = loc.port;
            return finir({ ok: false, erreur: 'redirection-https', redirectionHttps: s.toString(), message: 'Le serveur exige une connexion chiffrée (HTTPS).' });
          }
          return finir({ ok: false, erreur: 'redirection', message: `Redirection refusée (HTTP ${statut}) : indiquez l'adresse exacte du serveur GMAO.` });
        }
        const morceaux = [];
        let taille = 0;
        res.on('data', (c) => {
          taille += c.length;
          if (taille > 256 * 1024) finir({ ok: false, erreur: 'reponse', message: 'Réponse du serveur trop volumineuse : ce n\'est pas un serveur GMAO SICAF.' });
          else morceaux.push(c);
        });
        res.on('error', () => finir({ ok: false, erreur: 'reseau', message: 'Connexion interrompue par le serveur.' }));
        res.on('end', () => {
          if (statut !== 200) return finir({ ok: false, erreur: 'statut', statut, message: `Le serveur a répondu ${statut}` });
          let infos = null;
          try { infos = JSON.parse(Buffer.concat(morceaux).toString('utf8')); } catch (e) { infos = null; }
          if (!infos || typeof infos !== 'object' || typeof infos.version !== 'string') return finir({ ok: false, erreur: 'pas-gmao', message: 'Le serveur répond, mais ce n\'est pas un serveur GMAO SICAF.' });
          finir(Object.assign({ ok: true, protocole: chiffre ? 'https' : 'http', url: base.toString(), infos }, certificat || {}));
        });
      });
      requete.on('error', (e) => finir(Object.assign({ ok: false }, erreurReseau(e, chiffre))));
      requete.end();
    };

    if (!chiffre) { envoyer(null, null); return; }
    socket = tls.connect({ host: hote, port, servername: net.isIP(hote) ? undefined : hote, rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
    socket.once('error', (e) => finir(Object.assign({ ok: false }, erreurReseau(e, true))));
    socket.once('secureConnect', () => {
      const pc = socket.getPeerCertificate(true);
      if (!pc || !pc.raw) return finir({ ok: false, erreur: 'certificat', message: 'Le serveur n\'a présenté aucun certificat.' });
      let x509;
      try { x509 = new crypto.X509Certificate(pc.raw); } catch (e) { return finir({ ok: false, erreur: 'certificat', message: 'Certificat du serveur illisible.' }); }
      const v = verifierEpinglage(x509, attendu);
      const certificat = { empreinte: v.empreinte, empreinteCle: v.empreinteCle, parCle: v.parCle, epingle, correspond: epingle ? v.ok : null };
      if (epingle && !v.ok) {
        return finir(Object.assign({ ok: false, erreur: 'empreinte', url: base.toString(), message: 'Le certificat présenté par le serveur ne correspond pas à l\'empreinte confirmée.' }, certificat));
      }
      const s = socket;
      socket = null; // la requête HTTP prend possession de la connexion vérifiée
      envoyer(() => s, certificat);
      requete.once('close', () => s.destroy());
    });
  });
}

module.exports = {
  genererCertificat, chargerOuCreer, empreinte, empreinteCle, normaliserEmpreinte, empreintesEgales,
  verifierEpinglage, ecouterMixte, sonder, adressesIPv4, nettoyerNomPoste, FORMAT_EMPREINTE, DUREE_VALIDITE_ANS,
};
