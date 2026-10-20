'use strict';
/**
 * Application de bureau Windows « GMAO SICAF » (Electron).
 *
 * - Aucun prérequis : le moteur Node.js est intégré à l'exécutable, aucune fenêtre CMD.
 * - Mode « serveur » : le serveur GMAO tourne DANS l'application (données dans
 *   %APPDATA%\GMAO SICAF\data ou un dossier choisi). Avec le partage réseau, il fonctionne en
 *   HTTPS avec un certificat généré sur ce poste (dossier des données › tls) ; la fenêtre locale
 *   n'accepte que ce certificat et les autres postes s'y connectent par empreinte confirmée.
 * - Mode « client » : l'application ouvre la GMAO hébergée sur un autre poste. À la première
 *   connexion chiffrée, le pôle informatique confirme l'empreinte du certificat du serveur ;
 *   ensuite, tout autre certificat bloque la connexion (protection contre l'usurpation du serveur).
 * - Icône dans la zone de notification, démarrage avec Windows, instance unique.
 * - Récupération d'urgence (mode serveur uniquement) : après le code du pôle informatique, un code
 *   de réinitialisation est généré pour un compte administrateur ou du pôle informatique
 *   (journalisé et signalé dans la GMAO).
 * - Mises à jour automatiques (GitHub Releases, dossier réseau ou adresse web) : l'installateur
 *   est téléchargé, vérifié (SHA-256) puis installé en silence, et l'application redémarre.
 */
const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, nativeImage, Notification, net, session, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Parametres, normaliserUrl } = require('./parametres');
const { creerGestionnaire, creerFetchControle } = require('./miseajour');
const { hashPassword, verifyPassword } = require('../server/auth');
const tlsGmao = require('../server/tls');

const NOM = 'GMAO SICAF';
const ICONE = path.join(__dirname, 'icon.png');
const PAGE_DEMARRAGE = path.join(__dirname, 'demarrage.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const PKG = (() => { try { return require('../package.json'); } catch (e) { return {}; } })();
const DEPOT_DEFAUT = (PKG.gmao && PKG.gmao.depotMisesAJour) || '';
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const DEMARRAGE_CACHE = process.argv.includes('--cache');
const LONGUEUR_MIN_CODE = 8;
const ESSAIS_CODE_MAX = 8;                        // codes du pôle informatique incorrects consécutifs avant blocage
const BLOCAGE_CODE_MS = 15 * 60 * 1000;           // durée du blocage de la saisie du code
const RECUPERATION_DEVERROUILLAGE_MS = 5 * 60 * 1000; // validité du code saisi pour une récupération d'urgence
const MESSAGE_RECUPERATION_INDISPONIBLE = 'La récupération d\'urgence n\'est possible que sur le poste qui héberge la GMAO, lorsque celle-ci est démarrée.';
const MESSAGE_RECUPERATION_SANS_CODE = 'Aucun code du pôle informatique n\'est défini sur ce poste : définissez-le d\'abord dans les paramètres de connexion (pôle informatique).';
const MESSAGE_USURPATION = 'Le serveur GMAO présente un certificat différent de celui confirmé par le pôle informatique. '
  + 'La connexion est bloquée car il peut s\'agir d\'une usurpation du serveur. Ne saisissez aucun mot de passe et prévenez le pôle informatique.';
const MESSAGE_DECLASSEMENT = 'Ce serveur répond sans chiffrement alors qu\'une connexion chiffrée a été confirmée pour ce poste. '
  + 'La connexion est bloquée (possible usurpation du serveur). Prévenez le pôle informatique.';
const MESSAGE_NON_CHIFFRE = 'Les mots de passe et les données circulent en clair sur le réseau. '
  + 'Mettez à jour l\'application sur le poste serveur et activez le partage réseau pour bénéficier du chiffrement.';

let parametres = null;
let serveur = null;        // application GMAO intégrée en service (mode serveur)
const serveursVivants = new Set(); // instances créées et pas encore arrêtées : toutes sont arrêtées avant une relance
let fileArret = Promise.resolve(); // arrêts du serveur intégré, traités un par un
let fileLancement = Promise.resolve(false); // démarrages (lancer), traités un par un
let lancementsEnCours = 0;
let ecoute = null;         // écoute réseau du serveur partagé (HTTPS + redirection des requêtes HTTP)
let certificatLocal = null; // certificat du serveur intégré partagé { empreinte, empreinteCle, … }
let epinglage = null;      // { hote, empreinte, empreinteCle } : seul certificat accepté pour ce nom d'hôte
let dernierRefus = 0;      // horodatage du dernier certificat refusé (alerte affichée une seule fois)
let urlApplication = '';   // adresse chargée dans la fenêtre principale
let fenetre = null;        // fenêtre principale
let fenetreAssistant = null;
let tray = null;
let quitter = false;
let infoBulleMontree = false;
let majEnCours = false;
let minuterieMaj = null;
let premiereVerificationMaj = null;
let modeAssistant = 'parametres'; // 'parametres' | 'recuperation' (récupération d'urgence d'un compte)
let assistantDeverrouille = false; // code du pôle informatique saisi pour la fenêtre de paramètres ouverte
let recuperationDeverrouillee = null; // { fenetre, jusqua } : code saisi dans la fenêtre de récupération ouverte
let fileCode = Promise.resolve();

// ----- Instance unique -----------------------------------------------------------------
const VERROU = app.requestSingleInstanceLock();
if (!VERROU) app.quit();
else app.on('second-instance', () => afficher());
app.setAppUserModelId('fr.sicaf.gmao');
// Chromium en français quelle que soit la langue de Windows : calendriers et format des champs de date, messages de
// validation des formulaires, menus contextuels (avant « ready »)
app.commandLine.appendSwitch('lang', 'fr-FR');
// Marqueur « application de bureau » : le serveur GMAO refuse les navigateurs web (sauf autorisation du pôle informatique)
app.userAgentFallback = `${app.userAgentFallback || 'Mozilla/5.0'} GMAO-SICAF-Bureau/${app.getVersion()}`;

function journal(...a) { try { console.log(new Date().toISOString(), ...a); } catch (e) { /* ignore */ } }
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function dossierDonnees() {
  const d = parametres.valeurs.serveur.dossierDonnees;
  return d ? path.resolve(d) : path.join(app.getPath('userData'), 'data');
}

/** Adresses IPv4 du poste (pour indiquer aux autres postes comment se connecter). */
function adressesReseau() {
  const out = [];
  for (const [nom, liste] of Object.entries(os.networkInterfaces())) {
    for (const i of liste || []) if (i.family === 'IPv4' && !i.internal) out.push({ interface: nom, adresse: i.address });
  }
  return out;
}

function hoteDe(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (e) { return ''; }
}

/** Même poste serveur (nom, port et chemin) pour deux adresses, quel que soit le protocole. */
function memeServeur(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const port = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && port(x) === port(y) && x.pathname === y.pathname;
  } catch (e) { return false; }
}

function portEcoute() {
  if (ecoute) return ecoute.adresse.port;
  return serveur && serveur.server.address() ? serveur.server.address().port : parametres.valeurs.serveur.port;
}

function partageActif() {
  return parametres.valeurs.mode === 'serveur' && parametres.valeurs.serveur.partageReseau;
}

/** Empreinte à afficher : certificat du serveur intégré, ou empreinte confirmée du serveur distant. */
function empreinteAffichee() {
  if (parametres.valeurs.mode === 'serveur') return certificatLocal ? certificatLocal.empreinte : '';
  return epinglage ? epinglage.empreinte : '';
}

// ----- Messages d'erreur affichés au pôle informatique ---------------------------------------

/** Erreur dont le message, rédigé pour le pôle informatique, peut être affiché tel quel. */
function erreurPoste(message, cause) {
  const e = new Error(message);
  e.messagePoste = message;
  if (cause) e.cause = cause;
  return e;
}

const RAISONS_SYSTEME = {
  EACCES: 'accès refusé', EPERM: 'opération refusée par Windows', ENOENT: 'chemin introuvable',
  ENOTDIR: 'un élément du chemin n\'est pas un dossier', EISDIR: 'un dossier porte le nom d\'un fichier attendu',
  EROFS: 'support en lecture seule', EBUSY: 'fichier utilisé par un autre programme', ENOSPC: 'disque plein',
  EIO: 'erreur de lecture ou d\'écriture du disque', EEXIST: 'un fichier du même nom existe déjà',
};

/** Échec de l'écoute réseau du serveur intégré (code Node.js) → message français. */
function erreurEcoute(e, port) {
  const code = e && e.code;
  if (code === 'EADDRINUSE') return erreurPoste(`Le port ${port} est déjà utilisé sur ce poste par un autre programme. Choisissez un autre port dans les paramètres de connexion.`, e);
  if (code === 'EACCES' || code === 'EPERM') return erreurPoste(`Le port ${port} est réservé par Windows ou bloqué sur ce poste. Choisissez un autre port dans les paramètres de connexion.`, e);
  if (code === 'EADDRNOTAVAIL') return erreurPoste('L\'adresse réseau de ce poste n\'est pas disponible : vérifiez sa connexion au réseau, puis réessayez.', e);
  return erreurPoste(`Le serveur GMAO n'a pas pu écouter sur le port ${port}${/^[A-Z0-9_]{2,40}$/.test(code || '') ? ` (code ${code})` : ''}. Choisissez un autre port dans les paramètres de connexion.`, e);
}

/** Échec d'accès au dossier des données (création, lecture, écriture) → message français. */
function erreurDonnees(e, dossier) {
  if (e && e.messagePoste) return e;
  const code = e && typeof e.code === 'string' ? e.code : '';
  if (!/^E[A-Z]+$/.test(code)) return e; // erreur de la GMAO (texte français) ou erreur inattendue : voir messageDemarrage
  return erreurPoste(`Le dossier des données « ${dossier} » n'est pas accessible (${RAISONS_SYSTEME[code] || `code ${code}`}). `
    + 'Vérifiez que le lecteur ou le partage réseau est disponible et que la session Windows peut y écrire, ou choisissez un autre dossier dans les paramètres de connexion.', e);
}

/** Message affiché dans l'assistant pour un démarrage manqué : jamais de texte technique brut. */
function messageDemarrage(e) {
  if (e && e.messagePoste) return e.messagePoste;
  // Erreur levée par la GMAO elle-même (message rédigé en français, sans code système)
  if (e && Object.getPrototypeOf(e) === Error.prototype && !e.code && typeof e.message === 'string' && e.message) return e.message.slice(0, 500);
  const code = e && typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code) ? ` (code ${e.code})` : '';
  return `La GMAO n'a pas pu démarrer${code}. Réessayez ; si le problème persiste, prévenez le pôle informatique.`;
}

/** Échec de chargement d'une page par Chromium (code d'erreur réseau négatif) → message français. */
function messageEchecChargement(code) {
  const n = Number(code);
  let cause = 'la page n\'a pas pu être chargée';
  if (n <= -1 && n > -100) cause = 'le chargement a été interrompu (réseau du poste modifié, délai dépassé ou incident local)';
  else if (n <= -100 && n > -200) cause = 'la connexion au serveur GMAO a été interrompue ou refusée';
  else if (n <= -300 && n > -400) cause = 'le serveur GMAO a renvoyé une réponse vide ou invalide';
  else if (n <= -800 && n > -900) cause = 'le nom du serveur GMAO est introuvable sur le réseau';
  return `Impossible d'ouvrir la GMAO : ${cause}${Number.isInteger(n) ? ` (code ${n})` : ''}.`;
}

// ----- Serveur intégré -------------------------------------------------------------------

/** Crée une instance du serveur GMAO ; elle reste suivie jusqu'à son arrêt (jamais deux instances sur la même base). */
function creerInstance(options) {
  const { createApp } = require('../server/server');
  let s;
  try {
    s = createApp(options);
  } catch (e) {
    throw erreurDonnees(e, options.dataDir);
  }
  serveursVivants.add(s);
  return s;
}

/** Arrête une instance : minuteurs des modules, écriture des données en attente, fermeture de l'écoute. */
async function arreterInstance(s) {
  serveursVivants.delete(s);
  if (serveur === s) serveur = null;
  try { await s.stop(); } catch (e) { journal('Arrêt du serveur GMAO :', e && e.message ? e.message : e); }
}

async function demarrerServeur() {
  const p = parametres.valeurs.serveur;
  const dossier = dossierDonnees();
  // Les variables globales (serveur, écoute, certificat, adresse) ne sont affectées qu'après une écoute réussie
  if (p.partageReseau) {
    // Partage réseau : HTTPS obligatoire, certificat du poste créé ou renouvelé automatiquement
    const clePrecedente = parametres.valeurs.certificatServeur.empreinteCle || empreinteCleEnPlace(dossier);
    let certificat;
    try {
      certificat = tlsGmao.chargerOuCreer(dossier, { log: journal });
    } catch (e) {
      throw erreurDonnees(e, dossier);
    }
    const s = creerInstance({ dataDir: dossier, log: journal, bureau: true, tls: { key: certificat.cle, cert: certificat.certificat } });
    let e2;
    try {
      e2 = await tlsGmao.ecouterMixte(s.server, p.port, '0.0.0.0');
    } catch (e) {
      await arreterInstance(s);
      throw erreurEcoute(e, p.port);
    }
    serveur = s;
    ecoute = e2;
    certificatLocal = certificat;
    epinglage = { hote: '127.0.0.1', empreinte: certificat.empreinte, empreinteCle: certificat.empreinteCle };
    urlApplication = `https://127.0.0.1:${e2.adresse.port}/`;
    journal('Serveur GMAO démarré en HTTPS (partage réseau)', urlApplication, 'empreinte du certificat :', certificat.empreinte, 'données :', dossier);
    suivreCertificat(certificat, clePrecedente);
    return urlApplication;
  }
  // Poste seul : écoute sur 127.0.0.1 uniquement, aucun trafic réseau à protéger
  const s = creerInstance({ dataDir: dossier, log: journal, bureau: true });
  let addr;
  try {
    try {
      addr = await s.start(p.port, '127.0.0.1');
    } catch (e) {
      if (!(e && e.code === 'EADDRINUSE')) throw e;
      addr = await s.start(0, '127.0.0.1'); // n'importe quel port libre convient
    }
  } catch (e) {
    // Instance jamais à l'écoute : arrêtée (minuteurs, base) avant de signaler l'échec
    await arreterInstance(s);
    throw erreurEcoute(e, p.port);
  }
  serveur = s;
  urlApplication = `http://127.0.0.1:${addr.port}/`;
  journal('Serveur GMAO démarré', urlApplication, 'données :', dossier);
  return urlApplication;
}

/** Arrête l'écoute réseau et toutes les instances du serveur intégré encore en service. */
function arreterServeur() {
  const arret = fileArret.then(async () => {
    const e = ecoute;
    ecoute = null;
    serveur = null;
    certificatLocal = null;
    if (parametres && parametres.valeurs.mode === 'serveur') epinglage = null;
    urlApplication = '';
    if (e) { try { await e.fermer(); } catch (x) { /* ignore */ } }
    for (const s of [...serveursVivants]) await arreterInstance(s);
  });
  fileArret = arret.catch(() => {});
  return arret;
}

/** Serveur intégré démarré et à l'écoute (mode serveur). */
function serveurEnService() {
  return !!parametres && parametres.valeurs.mode === 'serveur' && !!serveur && !!urlApplication;
}

// ----- Certificat du serveur partagé : renouvellement et changement de clé ------------------------

/** Empreinte de clé du certificat présent dans le dossier des données, avant tout renouvellement ('' si aucun). */
function empreinteCleEnPlace(dossier) {
  try { return tlsGmao.empreinteCle(fs.readFileSync(path.join(dossier, 'tls', 'certificat.pem'), 'utf8')); } catch (e) { return ''; }
}

const CAUSES_NOUVELLE_CLE = {
  'première génération': 'fichier de la clé privée absent',
  'clé privée illisible': 'fichier de la clé privée illisible ou corrompu',
  'type de clé non pris en charge': 'type de clé privée non pris en charge',
};

/**
 * Signale au pôle informatique un certificat recréé. Un renouvellement qui conserve la clé est seulement
 * inscrit au journal d'activité (les postes clients le reconnaissent par l'empreinte de sa clé) ; une
 * nouvelle clé bloque tous les postes clients épinglés jusqu'à la confirmation de la nouvelle empreinte :
 * elle est journalisée, notifiée (droit Système › Modifier) et annoncée sur ce poste.
 * @param {{ empreinte: string, empreinteCle: string, regenere: boolean, raison: string }} c
 * @param {string} precedente  empreinte de clé connue avant ce démarrage ('' au premier partage)
 */
function suivreCertificat(c, precedente) {
  const cleChangee = !!precedente && !tlsGmao.empreintesEgales(precedente, c.empreinteCle);
  if (cleChangee) {
    const cause = c.regenere ? (CAUSES_NOUVELLE_CLE[c.raison] || c.raison) : 'fichiers du certificat remplacés ou dossier des données changé';
    const message = `La clé du certificat HTTPS de ce poste serveur a changé (${cause}). Chaque poste client bloque la connexion `
      + `(alerte d'usurpation) tant que le pôle informatique n'a pas confirmé la nouvelle empreinte : ${c.empreinte}. `
      + 'Si personne n\'a réinstallé le poste serveur ni changé le dossier des données, vérifiez le dossier « tls » des données.';
    journal('Attention : nouvelle clé pour le certificat du serveur partagé', cause, c.empreinte);
    journaliserPoste('renouvellement', message, { titre: 'Clé du certificat du serveur GMAO changée', message, lien: '#/audit?action=renouvellement' }, { entite: 'systeme', toujours: true });
    try {
      if (Notification.isSupported()) new Notification({ title: NOM, body: 'La clé du certificat du serveur a changé : les postes clients doivent confirmer la nouvelle empreinte (Empreinte du certificat…).', icon: ICONE }).show();
    } catch (e) { /* notification facultative */ }
  } else if (c.regenere) {
    journaliserPoste('renouvellement', precedente
      ? `Certificat HTTPS du poste serveur renouvelé (${c.raison}), clé conservée : les postes clients le reconnaissent sans nouvelle confirmation. Empreinte : ${c.empreinte}`
      : `Certificat HTTPS du poste serveur créé (${c.raison}). Empreinte à confirmer sur chaque poste client : ${c.empreinte}`, null, { entite: 'systeme' });
  }
  if (!tlsGmao.empreintesEgales(parametres.valeurs.certificatServeur.empreinteCle, c.empreinteCle)) {
    try { parametres.enregistrer({ certificatServeur: { empreinteCle: c.empreinteCle } }); } catch (e) { journal('Paramètres du poste non enregistrés :', e.message); }
  }
}

// ----- Connexion à un serveur distant (mode client) -------------------------------------------

/** Épinglage enregistré pour cette adresse (empreintes vides si le serveur est différent). */
function epinglageEnregistre(url) {
  const c = parametres.valeurs.client;
  return c.url && memeServeur(url, c.url) ? { empreinte: c.empreinte, empreinteCle: c.empreinteCle } : {};
}

/**
 * Vérifie qu'un serveur GMAO répond à l'adresse donnée.
 * - HTTPS : le certificat présenté doit correspondre à l'épinglage fourni ; sans épinglage, son
 *   empreinte est renvoyée pour confirmation par le pôle informatique (confirmationRequise).
 * - HTTP : accepté avec un avertissement (poste serveur d'une ancienne version), sauf si une
 *   connexion chiffrée a déjà été confirmée pour ce serveur (déclassement refusé).
 * - Un serveur qui redirige HTTP vers HTTPS (même poste) est automatiquement joint en HTTPS.
 * @param {string} url
 * @param {{ empreinte?: string, empreinteCle?: string }} [epingle]
 */
async function testerServeur(url, epingle) {
  const u = normaliserUrl(url);
  if (!u) return { ok: false, message: 'Adresse invalide (exemple : srv-gmao:8585 ou https://192.168.1.20:8585)' };
  const attendu = {
    empreinte: tlsGmao.normaliserEmpreinte(epingle && epingle.empreinte),
    empreinteCle: tlsGmao.normaliserEmpreinte(epingle && epingle.empreinteCle),
  };
  const epinglee = !!(attendu.empreinte || attendu.empreinteCle);
  const options = Object.assign({ userAgent: app.userAgentFallback }, attendu);
  let r = await tlsGmao.sonder(u, options);
  if (!r.ok && u.startsWith('http:') && (r.erreur === 'redirection-https' || r.erreur === 'protocole')) {
    r = await tlsGmao.sonder(r.redirectionHttps || u.replace(/^http:/, 'https:'), options);
  }
  if (!r.ok) {
    if (r.erreur === 'empreinte') {
      return { ok: false, usurpation: true, chiffre: true, url: r.url || u.replace(/^http:/, 'https:'), empreinte: r.empreinte, empreinteCle: r.empreinteCle, attendue: attendu.empreinte, message: MESSAGE_USURPATION };
    }
    return { ok: false, message: r.message };
  }
  const base = { url: r.url, societe: String((r.infos.societe && r.infos.societe.nom) || '').slice(0, 120), version: String(r.infos.version || '').slice(0, 40) };
  if (r.protocole === 'http') {
    if (epinglee) return Object.assign({ ok: false, declassement: true, message: MESSAGE_DECLASSEMENT }, base);
    return Object.assign({ ok: true, chiffre: false, avertissement: MESSAGE_NON_CHIFFRE }, base);
  }
  const certificat = { empreinte: r.empreinte, empreinteCle: r.empreinteCle };
  if (!epinglee) {
    return Object.assign({ ok: false, confirmationRequise: true, chiffre: true, message: 'Première connexion chiffrée à ce serveur : comparez l\'empreinte de son certificat avec celle affichée sur le poste serveur, puis confirmez-la.' }, base, certificat);
  }
  return Object.assign({ ok: true, chiffre: true, confirme: true, renouvele: !!r.parCle }, base, certificat);
}

/**
 * Contrôle avant enregistrement du mode client : l'empreinte proposée par l'assistant n'est
 * retenue que si le serveur la présente effectivement à cet instant.
 */
async function verifierConnexionClient(url, demande) {
  const u = normaliserUrl(url);
  if (!u) return { ok: false, message: 'Saisissez l\'adresse du serveur GMAO' };
  let t = await testerServeur(u, epinglageEnregistre(u));
  if (t.ok) return t;
  if (t.usurpation && demande.remplacer) t = await testerServeur(u, {}); // certificat renouvelé : nouvelle confirmation
  if (!t.confirmationRequise) return t;
  const proposee = tlsGmao.normaliserEmpreinte(demande.empreinte);
  if (!proposee) return Object.assign({}, t, { message: 'Confirmez l\'empreinte du certificat du serveur (comparez-la avec celle affichée sur le poste serveur) avant d\'enregistrer.' });
  if (!tlsGmao.empreintesEgales(proposee, t.empreinte)) {
    return { ok: false, message: 'L\'empreinte confirmée ne correspond pas à celle que présente maintenant le serveur : recommencez le test puis la vérification.' };
  }
  return Object.assign({}, t, { ok: true, confirme: true, nouvelleEmpreinte: true });
}

// ----- Vérification des certificats par Chromium (fenêtres de l'application) ---------------------

/** Empreinte « sha256/base64 » fournie par Chromium → « AB:CD:… ». */
function empreinteChromium(fp) {
  const m = /^sha256\/([A-Za-z0-9+/=]+)$/.exec(String(fp || ''));
  if (!m) return '';
  const octets = Buffer.from(m[1], 'base64');
  return octets.length === 32 ? octets.toString('hex').toUpperCase().match(/../g).join(':') : '';
}

/**
 * Pour le nom d'hôte du serveur GMAO, seul le certificat épinglé est accepté (0 = accepté,
 * -2 = refusé) ; pour les autres sites (mises à jour), la vérification standard s'applique (-3).
 */
function verifierCertificat(requete, rappel) {
  const cible = epinglage;
  const hote = String((requete && requete.hostname) || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!cible || !hote || hote !== cible.hote) { rappel(-3); return; }
  const certificat = (requete && requete.certificate) || {};
  let v = tlsGmao.verifierEpinglage(certificat.data || '', cible);
  if (!v.empreinte) {
    const fp = empreinteChromium(certificat.fingerprint);
    v = { ok: !!fp && tlsGmao.empreintesEgales(fp, cible.empreinte), empreinte: fp };
  }
  if (v.ok) { rappel(0); return; }
  rappel(-2);
  signalerCertificatRefuse(hote, v.empreinte);
}

function signalerCertificatRefuse(hote, empreintePresentee) {
  const maintenant = Date.now();
  if (maintenant - dernierRefus < 30000) return;
  dernierRefus = maintenant;
  journal('Certificat refusé pour', hote, '— empreinte présentée :', empreintePresentee || 'inconnue');
  setImmediate(() => afficherErreur(MESSAGE_USURPATION, 'securite'));
}

function installerVerificationCertificats() {
  const ses = session && session.defaultSession;
  if (ses && typeof ses.setCertificateVerifyProc === 'function') ses.setCertificateVerifyProc(verifierCertificat);
  else journal('Vérification des certificats par empreinte indisponible');
}

// ----- Fenêtres --------------------------------------------------------------------------
function estPageAssistant(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) === path.normalize(PAGE_DEMARRAGE);
  } catch (e) { return false; }
}

function origineAutorisee(url) {
  if (estPageAssistant(url)) return true;
  try { return !!urlApplication && new URL(url).origin === new URL(urlApplication).origin; } catch (e) { return false; }
}

/**
 * @param {string} url
 * @param {{ cachee?: boolean }} [options]  cachee : démarrage avec Windows (--cache), fenêtre gardée masquée
 */
function creerFenetrePrincipale(url, { cachee = false } = {}) {
  const f = parametres.valeurs.fenetre;
  const fen = new BrowserWindow({
    width: f.largeur, height: f.hauteur, minWidth: 1000, minHeight: 650, show: false,
    title: NOM, icon: ICONE, autoHideMenuBar: true, backgroundColor: '#f3f4f6',
    // plugins : lecteur PDF intégré (aperçu des factures et documents dans la GMAO)
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, plugins: true },
  });
  fenetre = fen;
  if (f.maximisee) fen.maximize();
  fen.once('ready-to-show', () => { if (!cachee) fen.show(); });
  fen.loadURL(url);

  // Fenêtres secondaires : impressions (about:blank) et pages de l'application ; liens externes → navigateur
  fen.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u === 'about:blank' || origineAutorisee(u)) {
      return { action: 'allow', overrideBrowserWindowOptions: { icon: ICONE, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, plugins: true } } };
    }
    if (/^(https?|mailto):/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  fen.webContents.on('will-navigate', (ev, u) => { if (!origineAutorisee(u)) { ev.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); } });
  fen.webContents.on('did-fail-load', (ev, code, description, u, principal) => {
    if (!principal || code === -3 || fenetre !== fen) return;
    if (Date.now() - dernierRefus < 30000) return; // alerte de sécurité déjà affichée
    if (code <= -200 && code > -300) { afficherErreur(MESSAGE_USURPATION, 'securite'); return; } // erreurs de certificat
    journal('Échec du chargement de la GMAO :', code, description, u);
    afficherErreur(messageEchecChargement(code));
  });
  // La caméra (scan des codes-barres) est autorisée pour l'application elle-même uniquement
  fen.webContents.session.setPermissionRequestHandler((wc, permission, rappel, details) => {
    const ok = ['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission) && origineAutorisee(details.requestingUrl || wc.getURL());
    rappel(ok);
  });

  fen.on('close', (ev) => {
    if (!fen.isMaximized()) {
      const [largeur, hauteur] = fen.getSize();
      parametres.enregistrer({ fenetre: { largeur, hauteur, maximisee: false } });
    } else parametres.enregistrer({ fenetre: { maximisee: true } });
    if (!quitter && garderEnArrierePlan()) {
      ev.preventDefault();
      fen.hide();
      if (!infoBulleMontree && Notification.isSupported()) {
        infoBulleMontree = true;
        new Notification({ title: NOM, body: 'La GMAO reste active dans la zone de notification (les autres postes peuvent continuer à travailler). Clic droit sur l\'icône › Quitter pour l\'arrêter.', icon: ICONE }).show();
      }
    }
  });
  // Une fenêtre remplacée (fermée après l'ouverture de la suivante) ne touche pas à sa remplaçante
  fen.on('closed', () => { if (fenetre === fen) fenetre = null; });
  construireMenu();
}

/**
 * En mode serveur partagé (ou démarrage avec Windows), fermer la fenêtre ne doit pas couper la GMAO des
 * autres postes. Rien n'est gardé en arrière-plan quand rien ne tourne (serveur non démarré, connexion au
 * serveur distant non établie) : l'application ne reste jamais sans fenêtre ni icône.
 */
function garderEnArrierePlan() {
  return !!urlApplication && parametres.valeurs.reduireDansZoneNotification && (partageActif() || DEMARRAGE_CACHE || parametres.valeurs.demarrerAvecWindows);
}

/** Arrêt complet quand plus aucune fenêtre n'est ouverte et que rien ne tourne. */
function quitterSansFenetre() {
  if (quitter) return;
  quitter = true;
  arreterServeur().finally(() => app.quit());
}

/**
 * @param {string} [erreur]  message affiché en tête de l'assistant
 * @param {'securite'} [type] alerte de sécurité (certificat refusé)
 * @param {'parametres'|'recuperation'} [mode] récupération d'urgence d'un compte (mode serveur uniquement)
 */
function ouvrirAssistant(erreur, type, mode = 'parametres') {
  const recuperation = mode === 'recuperation';
  if (recuperation && !serviceRecuperation()) return;
  const query = {};
  if (recuperation) query.mode = 'recuperation';
  if (erreur) {
    query.erreur = String(erreur).slice(0, 1000);
    if (type === 'securite') query.alerte = 'securite';
    // Serveur intégré toujours en service (seule la fenêtre a échoué) : il suffit de la rouvrir
    if (serveurEnService()) query.reprise = 'rouvrir';
  }
  if (fenetreAssistant && modeAssistant === mode) {
    // Un nouveau message (erreur, alerte de sécurité) est toujours affiché : la page est rechargée avec
    // lui, la saisie du code du pôle informatique reste valable pour cette fenêtre
    if (erreur) fenetreAssistant.loadFile(PAGE_DEMARRAGE, { query });
    fenetreAssistant.show();
    fenetreAssistant.focus();
    return;
  }
  // Autre mode : la fenêtre est remplacée (fermée après l'ouverture de la nouvelle) et le code du pôle
  // informatique sera redemandé
  const ancienne = fenetreAssistant;
  modeAssistant = recuperation ? 'recuperation' : 'parametres';
  recuperationDeverrouillee = null;
  // Premier lancement : pas encore de code pour les paramètres ; la récupération l'exige toujours
  assistantDeverrouille = !recuperation && !parametres.valeurs.codeInformatique;
  const f = new BrowserWindow({
    width: 860, height: 780, minWidth: 700, minHeight: 600, title: recuperation ? `${NOM} — Récupération d'un compte administrateur` : `${NOM} — Paramètres de connexion`, icon: ICONE, autoHideMenuBar: true, backgroundColor: '#0f172a',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  fenetreAssistant = f;
  f.loadFile(PAGE_DEMARRAGE, { query });
  f.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  f.on('closed', () => {
    if (fenetreAssistant === f) fenetreAssistant = null;
    // Une fenêtre remplacée ne touche pas à l'état de sa remplaçante
    if (!fenetreAssistant) { assistantDeverrouille = false; recuperationDeverrouillee = null; }
    // Plus aucune fenêtre et rien en service (premier lancement, démarrage manqué) : l'application s'arrête
    if (!fenetre && !fenetreAssistant && !lancementsEnCours && (!parametres.valeurs.configure || !urlApplication)) quitterSansFenetre();
  });
  if (ancienne) ancienne.destroy();
}

/** Ferme la fenêtre de l'assistant donnée si elle est toujours celle affichée. */
function fermerFenetreAssistant(f) {
  if (!f || fenetreAssistant !== f) return;
  fenetreAssistant = null;
  f.destroy();
}

function afficherErreur(message, type) {
  // L'assistant s'ouvre avant la fermeture de la fenêtre principale : l'application n'est jamais sans fenêtre
  const principale = fenetre;
  fenetre = null;
  ouvrirAssistant(message, type);
  if (principale) principale.destroy();
}

/** Affiche la fenêtre principale, créée au besoin ; faux si rien n'est en service. */
function afficherPrincipale() {
  if (fenetre) { if (fenetre.isMinimized()) fenetre.restore(); fenetre.show(); fenetre.focus(); return true; }
  if (!urlApplication) return false;
  creerFenetrePrincipale(urlApplication);
  return true;
}

function afficher() {
  if (fenetre) { afficherPrincipale(); return; }
  if (fenetreAssistant) { fenetreAssistant.show(); fenetreAssistant.focus(); return; }
  // Rien d'affiché ni en service (démarrage manqué) : nouvelle tentative, qui rouvre l'assistant en cas d'échec
  if (!afficherPrincipale() && !lancementsEnCours && !quitter) lancer();
}

// ----- Démarrage selon le mode -------------------------------------------------------------
async function connecterClient() {
  const c = parametres.valeurs.client;
  const t = await testerServeur(c.url, c);
  if (!t.ok) {
    if (t.usurpation || t.declassement) {
      journal('Connexion au serveur bloquée :', c.url, t.usurpation ? `(empreinte présentée : ${t.empreinte})` : '(réponse non chiffrée)');
      afficherErreur(t.message, 'securite');
      return false;
    }
    if (t.confirmationRequise) {
      afficherErreur(`Le serveur GMAO (${t.url}) utilise désormais une connexion chiffrée : le pôle informatique doit confirmer l'empreinte de son certificat (bouton « Tester » ci-dessous, puis « Enregistrer »).`);
      return false;
    }
    afficherErreur(`Serveur GMAO injoignable à l'adresse ${c.url} : ${t.message}`);
    return false;
  }
  if (t.chiffre) {
    epinglage = { hote: hoteDe(t.url), empreinte: t.empreinte, empreinteCle: t.empreinteCle };
    if (t.renouvele || t.url !== c.url || t.empreinte !== c.empreinte) {
      // Certificat renouvelé par le même serveur (même clé) ou adresse passée en HTTPS
      parametres.enregistrer({ client: { url: t.url, empreinte: t.empreinte, empreinteCle: t.empreinteCle } });
      journal('Épinglage du serveur mis à jour', t.url, t.empreinte);
    }
  } else {
    epinglage = null;
    journal('Avertissement : connexion non chiffrée au serveur', t.url);
  }
  urlApplication = t.url;
  return true;
}

/**
 * Démarre la GMAO selon le mode du poste (serveur intégré ou connexion au serveur distant) et ouvre la
 * fenêtre principale ; en cas d'échec, l'assistant affiche la cause. Les démarrages sont traités un par
 * un et commencent toujours par l'arrêt du serveur intégré précédent : jamais deux serveurs sur la même base.
 * @param {{ cachee?: boolean }} [options]  cachee : fenêtre principale gardée masquée (démarrage avec Windows)
 * @returns {Promise<boolean>} vrai si la fenêtre principale a été ouverte
 */
function lancer(options) {
  lancementsEnCours += 1;
  const p = fileLancement.then(() => lancerMaintenant(options || {})).finally(() => { lancementsEnCours -= 1; });
  fileLancement = p.catch(() => false);
  return p;
}

async function lancerMaintenant({ cachee = false }) {
  const p = parametres.valeurs;
  if (!p.configure) { ouvrirAssistant(); return false; }
  try {
    await arreterServeur();
    epinglage = null;
    if (p.mode === 'client') {
      if (!(await connecterClient())) return false;
    } else {
      await demarrerServeur();
    }
    const ancienne = fenetre;
    creerFenetrePrincipale(urlApplication, { cachee });
    if (ancienne) ancienne.destroy(); // fenêtre d'un démarrage précédent, remplacée
    construireTray();
    appliquerDemarrageWindows();
    programmerMisesAJour();
    return true;
  } catch (e) {
    // Détail technique au journal du poste ; l'assistant affiche un message en français
    journal('Erreur au démarrage', e && e.cause ? e.cause : '', e && e.stack ? e.stack : e);
    afficherErreur(messageDemarrage(e));
    return false;
  }
}

async function redemarrer() {
  quitter = true;
  await arreterServeur();
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--cache') });
  app.exit(0);
}

async function quitterApplication() {
  if (partageActif()) {
    const r = await dialog.showMessageBox(fenetre || undefined, { type: 'question', title: NOM, message: 'Arrêter la GMAO ?', detail: 'Ce poste héberge la GMAO pour le réseau : les autres postes ne pourront plus y accéder tant qu\'elle ne sera pas relancée.', buttons: ['Arrêter', 'Annuler'], defaultId: 1, cancelId: 1 });
    if (r.response !== 0) return;
  }
  quitter = true;
  await arreterServeur();
  app.quit();
}

function appliquerDemarrageWindows() {
  if (process.platform !== 'win32') return;
  try {
    const opts = { openAtLogin: parametres.valeurs.demarrerAvecWindows, args: ['--cache'] };
    if (PORTABLE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
    app.setLoginItemSettings(opts);
  } catch (e) { journal('Démarrage avec Windows indisponible', e.message); }
}

// ----- Zone de notification et menu ----------------------------------------------------------
function adresseReseau() {
  const a = adressesReseau()[0];
  return a ? `https://${a.adresse}:${portEcoute()}/` : '';
}

function texteAcces() {
  const p = parametres.valeurs;
  if (p.mode === 'client') return `Connecté à ${p.client.url}${/^https:/.test(p.client.url) ? ' (connexion chiffrée)' : ' (connexion non chiffrée)'}`;
  if (!p.serveur.partageReseau) return 'Serveur local (ce poste uniquement)';
  const a = adresseReseau();
  return a ? `Accès réseau : ${a} (connexion chiffrée)` : `Accès réseau sur le port ${portEcoute()} (connexion chiffrée)`;
}

async function afficherEmpreinte() {
  const fp = empreinteAffichee();
  if (!fp) return;
  const local = parametres.valeurs.mode === 'serveur';
  const r = await dialog.showMessageBox(fenetre || undefined, {
    type: 'info', title: `${NOM} — certificat du serveur`, message: 'Empreinte du certificat du serveur GMAO',
    detail: `${fp}\n\n${local
      ? 'Elle est demandée au pôle informatique lors de la première connexion de chaque poste client : les deux empreintes doivent être identiques caractère par caractère.'
      : 'Empreinte confirmée pour ce poste : elle doit être identique à celle affichée sur le poste serveur.'}`,
    buttons: ['Copier', 'Fermer'], defaultId: 1, cancelId: 1,
  });
  if (r.response === 0 && clipboard) clipboard.writeText(fp);
}

function menuModele() {
  return [
    { label: 'Ouvrir la GMAO', click: () => afficher() },
    { label: texteAcces(), enabled: false },
    partageActif() ? { label: 'Copier l\'adresse réseau', click: () => { const a = adresseReseau(); if (a && clipboard) clipboard.writeText(a); } } : null,
    empreinteAffichee() ? { label: 'Empreinte du certificat…', click: () => afficherEmpreinte() } : null,
    { type: 'separator' },
    { label: 'Paramètres de connexion (pôle informatique)…', click: () => ouvrirAssistant() },
    serviceRecuperation() ? { label: 'Récupérer un compte administrateur…', click: () => ouvrirAssistant(undefined, undefined, 'recuperation') } : null,
    { label: 'Rechercher les mises à jour', click: () => verifierMisesAJour(true) },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quitter', click: () => quitterApplication() },
  ].filter(Boolean);
}

function construireTray() {
  const image = nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 });
  if (!tray) {
    tray = new Tray(image);
    tray.on('click', () => afficher());
    tray.on('double-click', () => afficher());
  }
  tray.setToolTip(`${NOM} — ${texteAcces()}`);
  tray.setContextMenu(Menu.buildFromTemplate(menuModele()));
}

function construireMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fichier', submenu: [
      { label: 'Actualiser', accelerator: 'F5', click: () => fenetre && fenetre.reload() },
      { label: 'Imprimer…', accelerator: 'Ctrl+P', click: () => fenetre && fenetre.webContents.print() },
      { type: 'separator' },
      { label: 'Paramètres de connexion (pôle informatique)…', click: () => ouvrirAssistant() },
      { type: 'separator' },
      { label: 'Fermer la fenêtre', accelerator: 'Ctrl+W', click: () => fenetre && fenetre.close() },
      { label: 'Quitter', accelerator: 'Ctrl+Q', click: () => quitterApplication() },
    ] },
    { label: 'Affichage', submenu: [
      { role: 'zoomIn', label: 'Zoom +' }, { role: 'zoomOut', label: 'Zoom -' }, { role: 'resetZoom', label: 'Zoom normal' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Plein écran' },
      app.isPackaged ? null : { role: 'toggleDevTools', label: 'Outils de développement' },
    ].filter(Boolean) },
    { label: 'Aide', submenu: [
      { label: 'Rechercher les mises à jour', click: () => verifierMisesAJour(true) },
      empreinteAffichee() ? { label: 'Empreinte du certificat du serveur…', click: () => afficherEmpreinte() } : null,
      { label: 'À propos', click: () => dialog.showMessageBox(fenetre || undefined, { type: 'info', title: 'À propos', message: NOM, detail: `Version ${app.getVersion()}\n${texteAcces()}${parametres.valeurs.mode === 'serveur' ? `\nDonnées : ${dossierDonnees()}` : ''}${empreinteAffichee() ? `\nEmpreinte du certificat : ${empreinteAffichee()}` : ''}` }) },
    ].filter(Boolean) },
  ]));
}

// ----- Mises à jour ----------------------------------------------------------------------------
function gestionnaireMaj() {
  const m = parametres.valeurs.misesAJour;
  return creerGestionnaire({
    versionActuelle: app.getVersion(),
    config: { source: m.source, depot: m.depot || DEPOT_DEFAUT, chemin: m.chemin, url: m.url },
    // Clé publique de signature des manifestes (package.json › gmao.clePubliqueMaj) : dès qu'elle est définie, un
    // manifeste non signé ou mal signé est refusé
    clePublique: (PKG.gmao && PKG.gmao.clePubliqueMaj) || undefined,
    // net.request (proxy système) avec contrôle de chaque redirection : net.fetch suit les redirections
    // sans exposer l'adresse finale, ce qui empêcherait de vérifier les hôtes de téléchargement
    fetch: creerFetchControle((o) => net.request(o)),
    dossierTelechargement: path.join(app.getPath('temp'), 'gmao-sicaf-maj'),
    agent: `GMAO-SICAF/${app.getVersion()}`,
  });
}

function programmerMisesAJour() {
  if (minuterieMaj) clearInterval(minuterieMaj);
  if (premiereVerificationMaj) clearTimeout(premiereVerificationMaj);
  minuterieMaj = null;
  premiereVerificationMaj = null;
  if (!app.isPackaged || !parametres.valeurs.misesAJour.automatique || parametres.valeurs.misesAJour.source === 'aucune') return;
  premiereVerificationMaj = setTimeout(() => verifierMisesAJour(false), 30 * 1000);
  minuterieMaj = setInterval(() => verifierMisesAJour(false), 6 * 60 * 60 * 1000);
}

/** @param {boolean} manuel  true : l'utilisateur a demandé la vérification (messages même sans mise à jour). */
async function verifierMisesAJour(manuel) {
  if (majEnCours) return { enCours: true };
  majEnCours = true;
  const parent = fenetre || fenetreAssistant || undefined;
  try {
    if (!app.isPackaged && !manuel) return { disponible: false };
    const g = gestionnaireMaj();
    const info = await g.verifier();
    if (!info.disponible) {
      if (manuel) await dialog.showMessageBox(parent, { type: 'info', title: NOM, message: 'Votre application est à jour.', detail: `Version installée : ${app.getVersion()}${info.version ? `\nDernière version publiée : ${info.version}` : ''}${info.raison ? `\n${info.raison}` : ''}` });
      return info;
    }
    if (!manuel && parametres.valeurs.misesAJour.ignorerVersion === info.version) return info;
    const r = await dialog.showMessageBox(parent, {
      type: 'info', title: `${NOM} — mise à jour`, message: `Une nouvelle version est disponible : ${info.version}`,
      detail: `Version installée : ${app.getVersion()}${info.signatureVerifiee ? '\nSignature de l\'éditeur vérifiée.' : ''}${info.notes ? `\n\nNouveautés :\n${info.notes.slice(0, 1500)}` : ''}${partageActif() ? '\n\nCe poste héberge la GMAO pour le réseau : l\'accès sera interrompu une minute pendant l\'installation.' : ''}`,
      buttons: PORTABLE ? ['Télécharger', 'Plus tard', 'Ignorer cette version'] : ['Installer maintenant', 'Plus tard', 'Ignorer cette version'], defaultId: 0, cancelId: 1,
    });
    if (r.response === 2) { parametres.enregistrer({ misesAJour: { ignorerVersion: info.version } }); return info; }
    if (r.response !== 0) return info;
    if (PORTABLE) {
      // Version portable : pas d'installation silencieuse ; la source « dossier » s'ouvre dans l'explorateur (fichier
      // de l'installateur sélectionné), les autres sources dans le navigateur
      const t = info.telechargement || {};
      if (t.type === 'fichier' && t.chemin) shell.showItemInFolder(t.chemin);
      else if (/^https?:/i.test(String(info.page || t.url || ''))) shell.openExternal(info.page || t.url);
      return info;
    }
    const fichier = await g.telecharger(info, (x) => { if (fenetre) fenetre.setProgressBar(x); });
    if (fenetre) fenetre.setProgressBar(-1);
    // Installation silencieuse dans le même dossier, puis relance automatique de l'application
    quitter = true;
    await arreterServeur();
    spawn(fichier, ['/S', '--force-run', '--updated'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    return info;
  } catch (e) {
    if (fenetre) fenetre.setProgressBar(-1);
    journal('Mise à jour : ', e.message);
    if (manuel) await dialog.showMessageBox(parent, { type: 'warning', title: NOM, message: 'Impossible de vérifier ou d\'installer la mise à jour.', detail: e.message });
    return { erreur: e.message };
  } finally {
    majEnCours = false;
  }
}

// ----- Pont avec les pages (preload.js) -----------------------------------------------------

/**
 * Déclare un canal IPC. Par défaut, seul l'assistant de connexion (page locale) peut l'appeler ;
 * `{ application: true }` l'ouvre aussi aux pages de la GMAO (serveur local ou distant) ;
 * `{ recuperation: true }` le réserve à la fenêtre de l'assistant ouverte en mode récupération.
 */
function gerer(canal, fn, { application = false, recuperation = false } = {}) {
  ipcMain.handle(canal, async (ev, ...args) => {
    const url = (ev && ev.senderFrame && ev.senderFrame.url) || '';
    let autorise = application ? origineAutorisee(url) : estPageAssistant(url);
    // Récupération d'urgence : l'appel doit venir de la fenêtre créée par l'application pour cet usage
    if (recuperation) autorise = autorise && modeAssistant === 'recuperation' && estFenetreAssistant(ev && ev.sender);
    if (!autorise) throw new Error('Appel non autorisé');
    try {
      return await fn(ev, ...args);
    } catch (e) {
      // Message destiné au pôle informatique, ou incident technique (détail au journal du poste seulement)
      if (e && e.messagePoste) throw new Error(e.messagePoste);
      journal(`Erreur du canal ${canal} :`, e && e.stack ? e.stack : e);
      throw new Error('Opération impossible sur ce poste. Réessayez ; si le problème persiste, prévenez le pôle informatique.');
    }
  });
}

/** Vrai si le contenu web expéditeur est celui de la fenêtre de l'assistant actuellement ouverte. */
function estFenetreAssistant(expediteur) {
  const wc = fenetreAssistant && fenetreAssistant.webContents;
  if (!wc || !expediteur) return false;
  return expediteur === wc || (typeof wc.id === 'number' && expediteur.id === wc.id);
}

/** Les paramètres de connexion ne se modifient qu'après saisie du code du pôle informatique. */
function exigerDeverrouillage() {
  if (parametres.valeurs.codeInformatique && !assistantDeverrouille) throw erreurPoste('Code du pôle informatique requis');
}

/**
 * Fin du blocage de la saisie du code du pôle informatique (date ISO), ou '' si la saisie est permise.
 * Un blocage plus long que sa durée normale (horloge du poste reculée) est ramené à cette durée.
 */
function blocageCode() {
  const v = parametres.valeurs.verrouCode;
  const fin = Date.parse(v.bloqueJusqua || '');
  if (!(fin > Date.now())) return '';
  if (fin > Date.now() + BLOCAGE_CODE_MS) {
    const borne = new Date(Date.now() + BLOCAGE_CODE_MS).toISOString();
    parametres.enregistrer({ verrouCode: { echecs: v.echecs, bloqueJusqua: borne } });
    return borne;
  }
  return v.bloqueJusqua;
}

function messageBlocage(fin) {
  const d = new Date(fin);
  const heure = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Trop de codes incorrects : la saisie du code du pôle informatique est bloquée jusqu'à ${heure}.`;
}

/** Auteur des opérations faites sur ce poste, pour le journal d'activité de la GMAO. */
function originePoste() {
  let session = '';
  try { session = os.userInfo().username || ''; } catch (e) { /* compte sans nom */ }
  return `Poste serveur ${os.hostname()}${session ? `, session ${session}` : ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
}

/**
 * Inscrit un événement de ce poste au journal d'activité de la GMAO (mode serveur, serveur démarré).
 * `alerte` : notification au pôle informatique (droit Système › Modifier), sauf si la configuration
 * désactive la notification des blocages (`toujours` : notification émise dans tous les cas).
 * @param {{ entite?: string, toujours?: boolean }} [options]
 */
function journaliserPoste(action, details, alerte, { entite = 'users', toujours = false } = {}) {
  if (parametres.valeurs.mode !== 'serveur' || !serveur || !serveur.ctx) return;
  try {
    const ctx = serveur.ctx;
    ctx.audit({ user: { id: null, login: originePoste() } }, action, entite, null, details);
    if (alerte && (toujours || (ctx.config().securite || {}).notifierBlocages !== false)) {
      ctx.notify(ctx.usersAvecDroit('systeme', 'modifier').map((u) => u.id), Object.assign({ type: 'alerte' }, alerte));
    }
  } catch (e) { journal('Journal d\'activité de la GMAO indisponible :', e.message); }
}

/**
 * Vérifie le code du pôle informatique. Les essais sont traités un par un, avec un délai croissant
 * après plusieurs échecs (essais automatisés) ; après ESSAIS_CODE_MAX échecs consécutifs, la saisie
 * est bloquée BLOCAGE_CODE_MS. Le compteur est conservé dans les paramètres : redémarrer
 * l'application ne lève pas un blocage. Les échecs sont inscrits au journal d'activité de la GMAO.
 * @param {*} code  saisie de la page
 * @param {string} usage  ce que le code protège (« paramètres de connexion », « récupération d'urgence »)
 * @returns {Promise<{ok:boolean, message?:string, bloque?:boolean}>}
 */
function verifierCodeInformatique(code, usage) {
  const essai = fileCode.then(async () => {
    const bloque = blocageCode();
    if (bloque) return { ok: false, bloque: true, message: messageBlocage(bloque) };
    const echecs = parametres.valeurs.verrouCode.echecs;
    await attendre(400 + Math.min(30000, Math.max(0, echecs - 4) * 3000));
    const ok = typeof code === 'string' && code.length > 0 && code.length <= 200 && !!parametres.valeurs.codeInformatique && verifyPassword(code, parametres.valeurs.codeInformatique);
    if (ok) {
      if (echecs) parametres.enregistrer({ verrouCode: { echecs: 0, bloqueJusqua: '' } });
      return { ok: true };
    }
    const n = echecs + 1;
    const fin = n >= ESSAIS_CODE_MAX ? new Date(Date.now() + BLOCAGE_CODE_MS).toISOString() : '';
    parametres.enregistrer({ verrouCode: { echecs: fin ? 0 : n, bloqueJusqua: fin } });
    journal(`Code du pôle informatique incorrect (${usage}, ${n} échec(s) consécutif(s))${fin ? ' : saisie bloquée' : ''}`);
    journaliserPoste('echec_connexion', `Code du pôle informatique incorrect sur le poste serveur (${usage}), ${n} essai(s) incorrect(s) consécutif(s)`);
    if (!fin) return { ok: false, message: 'Code incorrect' };
    const minutes = BLOCAGE_CODE_MS / 60000;
    journaliserPoste('blocage', `Saisie du code du pôle informatique bloquée ${minutes} minutes sur le poste serveur après ${n} essais incorrects (${usage})`, {
      titre: 'Code du pôle informatique bloqué sur le poste serveur',
      message: `${n} codes du pôle informatique incorrects ont été saisis sur le poste serveur (${usage}) : saisie bloquée ${minutes} minutes. Si personne du pôle informatique n'est intervenu, vérifiez l'accès au poste serveur.`,
      lien: '#/audit?action=blocage',
    });
    return { ok: false, bloque: true, message: messageBlocage(fin) };
  });
  fileCode = essai.catch(() => {});
  return essai;
}

// ----- Récupération d'urgence d'un compte (mode serveur) -------------------------------------

/** Service de récupération du serveur intégré, ou null (mode client, serveur arrêté). */
function serviceRecuperation() {
  if (!parametres || parametres.valeurs.mode !== 'serveur' || !serveur || !serveur.ctx) return null;
  const s = serveur.ctx.services && serveur.ctx.services.motsDePasse;
  return s && typeof s.comptesRecuperables === 'function' && typeof s.recuperationUrgence === 'function' ? s : null;
}

/** Code du pôle informatique saisi dans la fenêtre de récupération ouverte, depuis moins de 5 minutes. */
function recuperationAutorisee() {
  const r = recuperationDeverrouillee;
  return !!r && !!fenetreAssistant && r.fenetre === fenetreAssistant && modeAssistant === 'recuperation' && Date.now() < r.jusqua;
}

function etatRecuperation() {
  const disponible = !!serviceRecuperation();
  const codeDefini = !!parametres.valeurs.codeInformatique;
  const bloque = blocageCode();
  return {
    disponible: disponible && codeDefini,
    message: !disponible ? MESSAGE_RECUPERATION_INDISPONIBLE : (!codeDefini ? MESSAGE_RECUPERATION_SANS_CODE : ''),
    deverrouille: recuperationAutorisee(),
    bloque: !!bloque,
    messageBlocage: bloque ? messageBlocage(bloque) : '',
  };
}

/**
 * Saisie vide du code du pôle informatique : refusée sans compter d'essai incorrect (aucun délai, aucune
 * entrée de journal) ; un blocage en cours reste signalé. Renvoie null pour une saisie à vérifier.
 */
function saisieCodeVide(code) {
  if (typeof code === 'string' && code !== '') return null;
  const bloque = blocageCode();
  return { ok: false, bloque: !!bloque, message: bloque ? messageBlocage(bloque) : 'Saisissez le code du pôle informatique' };
}

const recuperationVerrouillee = () => ({ ok: false, verrouille: true, message: 'Saisissez de nouveau le code du pôle informatique (délai de 5 minutes dépassé ou code déjà utilisé pour une récupération).' });

/** Copie des données reçues d'une page, sans clés pouvant altérer les prototypes. */
function donneesPage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  try {
    return JSON.parse(JSON.stringify(v), (k, x) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : x));
  } catch (e) { return {}; }
}

function enregistrerIpc() {
  gerer('bureau:etat-verrou', () => ({ codeDefini: !!parametres.valeurs.codeInformatique, deverrouille: assistantDeverrouille }));
  gerer('bureau:deverrouiller', async (ev, code) => {
    if (!parametres.valeurs.codeInformatique) { assistantDeverrouille = true; return { ok: true }; }
    const vide = saisieCodeVide(code);
    if (vide) return { ok: false, message: vide.message };
    const r = await verifierCodeInformatique(code, 'paramètres de connexion');
    assistantDeverrouille = r.ok;
    return { ok: r.ok, message: r.ok ? '' : r.message };
  });
  gerer('bureau:reessayer', async () => {
    const f = fenetreAssistant;
    // Serveur intégré en service (seule la fenêtre a échoué) : la fenêtre est rouverte, sans relancer le serveur ;
    // sinon nouveau démarrage (le serveur précédent éventuel est d'abord arrêté). L'assistant reste ouvert tant
    // que la fenêtre principale n'est pas ouverte ; en cas d'échec, il affiche la nouvelle cause.
    const ok = serveurEnService() ? afficherPrincipale() : await lancer();
    if (ok) fermerFenetreAssistant(f);
    return ok;
  });
  gerer('bureau:infos', () => ({
    version: app.getVersion(), mode: parametres.valeurs.mode, url: urlApplication, portable: PORTABLE,
    dossierDonnees: parametres.valeurs.mode === 'serveur' ? dossierDonnees() : '', dossierDonneesDefaut: path.join(app.getPath('userData'), 'data'),
    adresses: adressesReseau(), port: portEcoute(),
    nomPoste: os.hostname(), acces: texteAcces(),
    chiffrement: urlApplication ? (urlApplication.startsWith('https:') ? 'https' : 'http') : '',
    empreinte: empreinteAffichee(),
  }), { application: true });
  gerer('bureau:parametres', () => {
    const v = JSON.parse(JSON.stringify(parametres.valeurs));
    v.codeInformatiqueDefini = !!v.codeInformatique;
    delete v.codeInformatique;
    delete v.verrouCode;
    if (v.codeInformatiqueDefini && !assistantDeverrouille) return { verrouille: true, configure: v.configure, mode: v.mode, codeInformatiqueDefini: true };
    return v;
  });
  gerer('bureau:enregistrer', async (ev, nouvelles) => {
    exigerDeverrouillage();
    const src = donneesPage(nouvelles);
    const avant = JSON.stringify([parametres.valeurs.mode, parametres.valeurs.serveur, parametres.valeurs.client]);
    const n = { configure: true };
    for (const cle of ['mode', 'serveur', 'demarrerAvecWindows', 'reduireDansZoneNotification', 'misesAJour']) if (src[cle] !== undefined) n[cle] = src[cle];
    // Code du pôle informatique : obligatoire à la première configuration, modifiable ensuite
    const nouveauCode = typeof src.nouveauCodeInformatique === 'string' ? src.nouveauCodeInformatique : '';
    if (nouveauCode) {
      if (nouveauCode.length < LONGUEUR_MIN_CODE) return { ok: false, message: `Le code du pôle informatique doit contenir au moins ${LONGUEUR_MIN_CODE} caractères` };
      if (nouveauCode.length > 200) return { ok: false, message: 'Le code du pôle informatique est trop long (200 caractères maximum)' };
      n.codeInformatique = hashPassword(nouveauCode);
    } else if (!parametres.valeurs.codeInformatique) {
      return { ok: false, message: 'Définissez le code du pôle informatique (il protège ces paramètres)' };
    }
    if (n.mode === 'client') {
      // L'adresse et l'empreinte ne sont retenues qu'après une connexion réussie au serveur
      const c = src.client && typeof src.client === 'object' ? src.client : {};
      const t = await verifierConnexionClient(c.url, { empreinte: c.empreinte, remplacer: c.remplacerEmpreinte === true });
      if (!t.ok) return { ok: false, message: t.message, usurpation: !!t.usurpation, confirmationRequise: !!t.confirmationRequise, declassement: !!t.declassement, empreinte: t.empreinte || '' };
      n.client = { url: t.url, empreinte: t.chiffre ? t.empreinte : '', empreinteCle: t.chiffre ? t.empreinteCle : '' };
      if (t.nouvelleEmpreinte) journal('Empreinte du certificat du serveur confirmée par le pôle informatique :', t.url, t.empreinte);
    }
    const etaitConfigure = parametres.valeurs.configure;
    parametres.enregistrer(n);
    appliquerDemarrageWindows();
    const apres = JSON.stringify([parametres.valeurs.mode, parametres.valeurs.serveur, parametres.valeurs.client]);
    const f = fenetreAssistant;
    if (!etaitConfigure || !urlApplication) {
      // Démarrage (le serveur précédent éventuel est arrêté d'abord) ; l'assistant se ferme une fois la GMAO ouverte
      lancer().then((ok) => { if (ok) fermerFenetreAssistant(f); });
    } else if (avant !== apres) {
      setTimeout(() => redemarrer(), 300);
    } else {
      programmerMisesAJour();
      if (tray) construireTray();
      if (afficherPrincipale()) fermerFenetreAssistant(f);
    }
    return { ok: true, redemarrage: etaitConfigure && avant !== apres };
  });
  gerer('bureau:tester-serveur', (ev, url) => {
    exigerDeverrouillage();
    const u = normaliserUrl(typeof url === 'string' ? url.slice(0, 500) : '');
    return testerServeur(u, epinglageEnregistre(u));
  });
  gerer('bureau:choisir-dossier', async () => {
    exigerDeverrouillage();
    const r = await dialog.showOpenDialog(fenetreAssistant || fenetre || undefined, { title: 'Dossier des données de la GMAO', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });
  gerer('bureau:verifier-maj', () => verifierMisesAJour(true), { application: true });
  gerer('bureau:ouvrir-parametres', () => {
    // Une récupération d'urgence en cours (code affiché) n'est pas interrompue par une page de la GMAO
    if (fenetreAssistant && modeAssistant === 'recuperation') { fenetreAssistant.show(); fenetreAssistant.focus(); return true; }
    ouvrirAssistant();
    return true;
  }, { application: true });
  gerer('bureau:ouvrir-dossier-donnees', () => { exigerDeverrouillage(); return parametres.valeurs.mode === 'serveur' ? shell.openPath(dossierDonnees()) : ''; });
  gerer('bureau:fermer-assistant', () => { if (fenetreAssistant) fenetreAssistant.close(); return true; });
  gerer('bureau:quitter', () => quitterApplication());

  // Récupération d'urgence : fenêtre de l'assistant ouverte depuis la zone de notification du poste serveur
  gerer('bureau:recuperation-etat', () => etatRecuperation(), { recuperation: true });
  gerer('bureau:recuperation-deverrouiller', async (ev, code) => {
    const etat = etatRecuperation();
    if (!etat.disponible) return { ok: false, message: etat.message };
    const vide = saisieCodeVide(code);
    if (vide) return vide;
    const appelante = fenetreAssistant;
    const r = await verifierCodeInformatique(code, 'récupération d\'urgence');
    if (!r.ok) return { ok: false, bloque: !!r.bloque, message: r.message };
    // Fenêtre fermée ou remplacée pendant la vérification : rien n'est déverrouillé
    if (fenetreAssistant !== appelante || modeAssistant !== 'recuperation') return { ok: false, message: 'Fenêtre de récupération fermée' };
    recuperationDeverrouillee = { fenetre: appelante, jusqua: Date.now() + RECUPERATION_DEVERROUILLAGE_MS };
    return { ok: true };
  }, { recuperation: true });
  gerer('bureau:recuperation-comptes', () => {
    const s = serviceRecuperation();
    if (!s) return { ok: false, message: MESSAGE_RECUPERATION_INDISPONIBLE };
    if (!recuperationAutorisee()) return recuperationVerrouillee();
    return { ok: true, comptes: s.comptesRecuperables().map((c) => ({ login: String(c.login), nom: String(c.nom || c.login) })) };
  }, { recuperation: true });
  gerer('bureau:recuperation-generer', (ev, login) => {
    const s = serviceRecuperation();
    if (!s) return { ok: false, message: MESSAGE_RECUPERATION_INDISPONIBLE };
    if (!recuperationAutorisee()) return recuperationVerrouillee();
    const cible = typeof login === 'string' ? login.trim().slice(0, 100) : '';
    if (!cible) return { ok: false, message: 'Choisissez le compte à récupérer' };
    let r;
    try {
      r = s.recuperationUrgence({ login: cible, origine: originePoste() });
    } catch (e) {
      if (!(e && e.status)) journal('Récupération d\'urgence impossible :', e && e.message ? e.message : e);
      return { ok: false, message: e && e.status && e.message ? e.message : 'Génération du code impossible' };
    }
    // Un code par saisie du code du pôle informatique ; le code généré n'est conservé nulle part ici
    recuperationDeverrouillee = null;
    journal('Récupération d\'urgence : code de réinitialisation généré pour le compte', r.login);
    return { ok: true, login: r.login, nom: r.nom, code: r.code, expireLe: r.expireLe };
  }, { recuperation: true });
}

// ----- Durcissement : aucune vue intégrée (webview) ni navigation hors de l'application -------
app.on('web-contents-created', (ev, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e, u) => { if (!origineAutorisee(u) && u !== 'about:blank') e.preventDefault(); });
});

// Certificat refusé par Chromium : jamais d'exception manuelle
app.on('certificate-error', (ev, contents, url, erreur, certificat, rappel) => {
  journal('Certificat refusé', hoteDe(url), erreur);
  rappel(false);
});

// ----- Cycle de vie ---------------------------------------------------------------------------
app.whenReady().then(() => {
  if (!VERROU) return; // une autre instance est déjà ouverte : elle a été mise au premier plan
  parametres = new Parametres(app.getPath('userData'));
  installerVerificationCertificats();
  enregistrerIpc();
  lancer({ cachee: DEMARRAGE_CACHE });
});

app.on('window-all-closed', () => {
  // L'application reste dans la zone de notification si elle sert le réseau ; sinon elle s'arrête.
  // Un démarrage en cours ouvrira la fenêtre principale ou l'assistant
  if (lancementsEnCours && !quitter) return;
  if (quitter || !garderEnArrierePlan()) { quitter = true; arreterServeur().finally(() => app.quit()); }
});

app.on('before-quit', () => { quitter = true; });
// Dernier recours (arrêt de Windows…) : les données en attente de toutes les instances encore en service sont écrites
app.on('will-quit', () => { for (const s of serveursVivants) { try { s.db.saveNow(); } catch (e) { /* ignore */ } } });

module.exports = { garderEnArrierePlan, adressesReseau, testerServeur, verifierCertificat };
