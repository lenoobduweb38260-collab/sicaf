'use strict';
/**
 * Mises à jour automatiques de l'application de bureau (sans dépendance externe).
 *
 * Sources possibles :
 *  - github  : dernière « Release » du dépôt (API publique) contenant `latest.json` + l'installateur ;
 *  - dossier : dossier local ou partage réseau (\\NAS\gmao\mises-a-jour) contenant `latest.json` + l'installateur ;
 *  - url     : adresse web contenant `latest.json` + l'installateur.
 *
 * Format de latest.json (produit par scripts/manifeste-maj.js lors de la construction) :
 *   { "version": "1.0.42", "fichier": "GMAO-SICAF-Setup-1.0.42.exe", "sha256": "…", "taille": 123,
 *     "date": "…", "notes": "…", "signature": "<base64>", "algorithme": "ed25519" }
 *
 * Contrôles effectués avant d'installer une mise à jour :
 *  1. Signature Ed25519 du manifeste, vérifiée avec la clé publique intégrée à l'application
 *     (package.json › gmao.clePubliqueMaj). Dès qu'une clé publique est configurée, la signature est
 *     OBLIGATOIRE quelle que soit la source : un manifeste non signé ou mal signé est refusé.
 *     Champs couverts : date, fichier, notes, sha256, taille, version (voir contenuSigne).
 *  2. Version publiée strictement supérieure à la version installée : aucun retour à une version
 *     antérieure, même signée.
 *  3. Source GitHub : manifeste et installateur téléchargés en HTTPS depuis les seuls hôtes de GitHub,
 *     y compris après redirection (lorsque l'implémentation de fetch expose l'adresse finale).
 *  4. Taille et empreinte SHA-256 de l'installateur conformes au manifeste.
 * Sans clé publique configurée, seuls la version, la taille et l'empreinte SHA-256 publiées dans le
 * manifeste sont contrôlées (comportement historique).
 *
 * `fetch` est injectable (net.fetch d'Electron en production — proxy système —, fetch de Node en test).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGORITHME = 'ed25519';
/** Champs du manifeste couverts par la signature, dans l'ordre canonique (tri alphabétique). */
const CHAMPS_SIGNES = ['date', 'fichier', 'notes', 'sha256', 'taille', 'version'];
const API_GITHUB = 'https://api.github.com';
const HOTES_API_GITHUB = ['api.github.com'];
/** Hôtes autorisés pour les fichiers publiés sur GitHub (page de téléchargement puis stockage des fichiers). */
const HOTES_TELECHARGEMENT_GITHUB = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const HOTES_PAGE_GITHUB = ['github.com'];
const MOTIF_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/;
const MOTIF_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/; // 64 octets en base64
const TAILLE_MAX_JSON = 2 * 1024 * 1024;
const TAILLE_MAX_INSTALLATEUR = 2 * 1024 * 1024 * 1024;
const LONGUEUR_MAX_NOTES = 20000;
const NB_MAX_CLES = 5;
const DELAI_REQUETE_MS = 60 * 1000;
const DELAI_INACTIVITE_MS = 2 * 60 * 1000;

const MSG_CLE_INVALIDE = 'Clé publique de mise à jour invalide (package.json › gmao.clePubliqueMaj) : clé Ed25519 attendue, '
  + 'au format SPKI encodé en base64 ou PEM « PUBLIC KEY ». Les mises à jour sont bloquées tant qu\'elle n\'est pas corrigée.';
const MSG_NON_SIGNE = 'Mise à jour refusée : le manifeste de la version publiée n\'est pas signé, alors que cette application '
  + 'n\'accepte que des mises à jour signées. Prévenez le pôle informatique.';
const MSG_SIGNATURE_INVALIDE = 'Mise à jour refusée : la signature du manifeste est invalide (publication altérée ou signée avec '
  + 'une autre clé). Ne l\'installez pas manuellement et prévenez le pôle informatique.';

/** Compare deux versions « 1.2.3 » : -1, 0 ou 1. Les suffixes (-beta…) sont ignorés. */
function comparerVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** Nom de fichier sûr (aucun séparateur de chemin, aucune remontée). */
function nomSur(nom) {
  const n = String(nom || '');
  if (!n || n !== path.basename(n) || n.includes('..') || /[\\/:*?"<>|]/.test(n)) return null;
  return n;
}

/** Nom d'installateur accepté : nom sûr, caractères imprimables, extension .exe. */
function nomInstallateur(nom) {
  if (typeof nom !== 'string' || nom.length > 200 || /[\u0000-\u001f\u007f]/.test(nom) || !/\.exe$/i.test(nom)) return null;
  return nomSur(nom);
}

function sha256Fichier(chemin) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(chemin).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Valide et normalise un manifeste. Fonction idempotente : la signature porte sur sa sortie,
 * si bien que le signataire et les postes calculent exactement le même contenu.
 */
function validerManifeste(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Manifeste de mise à jour invalide');
  const version = typeof m.version === 'string' ? m.version : '';
  if (!MOTIF_VERSION.test(version)) throw new Error('Version absente ou invalide dans le manifeste de mise à jour');
  if (!nomInstallateur(m.fichier)) throw new Error('Nom de fichier invalide dans le manifeste de mise à jour');
  if (m.sha256 != null && m.sha256 !== '' && !(typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(m.sha256))) {
    throw new Error('Empreinte SHA-256 invalide dans le manifeste');
  }
  let taille = 0;
  if (m.taille != null && m.taille !== '') {
    taille = Number(m.taille);
    if (!Number.isSafeInteger(taille) || taille < 0 || taille > TAILLE_MAX_INSTALLATEUR) throw new Error('Taille invalide dans le manifeste de mise à jour');
  }
  const r = {
    version,
    fichier: m.fichier,
    sha256: m.sha256 ? m.sha256.toLowerCase() : '',
    taille,
    date: typeof m.date === 'string' ? m.date.slice(0, 40) : '',
    notes: typeof m.notes === 'string' ? m.notes.slice(0, LONGUEUR_MAX_NOTES) : '',
  };
  if (m.signature != null || m.algorithme != null) {
    if (m.algorithme !== ALGORITHME) throw new Error('Mise à jour refusée : algorithme de signature absent ou non pris en charge (seul « ed25519 » est accepté)');
    if (typeof m.signature !== 'string' || !MOTIF_SIGNATURE.test(m.signature)) throw new Error('Mise à jour refusée : signature du manifeste mal formée');
    r.signature = m.signature;
    r.algorithme = ALGORITHME;
  }
  return r;
}

/** Contenu signé : JSON des champs signés, clés triées, valeurs normalisées par validerManifeste. */
function contenuSigne(m) {
  const n = validerManifeste(m);
  const o = {};
  for (const k of CHAMPS_SIGNES) o[k] = n[k];
  return JSON.stringify(o);
}

/**
 * Charge la ou les clés publiques Ed25519 (chaîne ou tableau de chaînes, pour une rotation de clés) :
 * SPKI encodé en base64 (une ligne) ou PEM « PUBLIC KEY ». Valeur vide → aucune clé.
 * @returns {crypto.KeyObject[]}
 */
function chargerClesPubliques(valeur) {
  if (valeur == null || valeur === '') return [];
  const liste = Array.isArray(valeur) ? valeur.filter((x) => x != null && x !== '') : [valeur];
  if (liste.length > NB_MAX_CLES) throw new Error(`Trop de clés publiques de mise à jour (${NB_MAX_CLES} au plus)`);
  return liste.map((v) => {
    if (typeof v !== 'string' || v.length > 4096) throw new Error(MSG_CLE_INVALIDE);
    const t = v.trim().replace(/\\n/g, '\n');
    if (/PRIVATE KEY/i.test(t)) {
      throw new Error('Une clé PRIVÉE a été configurée à la place de la clé publique de mise à jour : retirez-la de package.json, '
        + 'considérez-la comme compromise et générez une nouvelle paire de clés (docs/MISES-A-JOUR.md).');
    }
    let cle = null;
    try {
      if (/^-----BEGIN PUBLIC KEY-----/.test(t)) cle = crypto.createPublicKey({ key: t, format: 'pem' });
      else if (/^[A-Za-z0-9+/]+={0,2}$/.test(t)) cle = crypto.createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' });
    } catch (e) { cle = null; }
    if (!cle || cle.asymmetricKeyType !== ALGORITHME) throw new Error(MSG_CLE_INVALIDE);
    return cle;
  });
}

/** Empreinte SHA-256 (hexadécimal) d'une clé publique, pour l'identifier sans l'afficher en entier. */
function empreinteClePublique(cle) {
  const publique = cle && cle.type === 'public' ? cle : crypto.createPublicKey(cle);
  const der = publique.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').match(/.{2}/g).join(':');
}

/** Clé publique intégrée à l'application (package.json › gmao.clePubliqueMaj). */
function clePubliqueIntegree() {
  try {
    const pkg = require('../package.json');
    return (pkg && pkg.gmao && pkg.gmao.clePubliqueMaj) || '';
  } catch (e) {
    return '';
  }
}

/**
 * Clé appliquée quand l'appelant n'en fournit pas : la clé intégrée, dans l'application de bureau
 * uniquement. Hors d'Electron (tests unitaires, outils), seule une clé fournie explicitement compte.
 */
function clePubliqueParDefaut() {
  return process.versions && process.versions.electron ? clePubliqueIntegree() : '';
}

/** Vrai si le manifeste porte une signature valide pour l'une des clés. */
function verifierSignature(m, cles) {
  const n = validerManifeste(m);
  if (!n.signature || !Array.isArray(cles) || !cles.length) return false;
  const donnees = Buffer.from(contenuSigne(n), 'utf8');
  const signature = Buffer.from(n.signature, 'base64');
  if (signature.length !== 64) return false;
  return cles.some((cle) => {
    try { return crypto.verify(null, donnees, cle, signature); } catch (e) { return false; }
  });
}

/**
 * Valide le manifeste et, si des clés publiques sont configurées, exige une signature valide,
 * une empreinte et une taille.
 */
function controlerManifeste(brut, cles) {
  const m = validerManifeste(brut);
  if (!cles || !cles.length) {
    m.signatureVerifiee = false;
    return m;
  }
  if (!m.signature) throw new Error(MSG_NON_SIGNE);
  if (!m.sha256 || !m.taille) throw new Error('Mise à jour refusée : empreinte SHA-256 ou taille absente du manifeste signé');
  if (!verifierSignature(m, cles)) throw new Error(MSG_SIGNATURE_INVALIDE);
  m.signatureVerifiee = true;
  return m;
}

/** Adresse de bouclage : le poste lui-même (miroir local, essais), jamais un serveur tiers. */
function estBouclage(hote) {
  return hote === 'localhost' || hote === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hote);
}

/**
 * Contrôle une adresse de téléchargement : HTTPS, port standard, aucun identifiant intégré,
 * hôte appartenant à la liste (les adresses de bouclage du poste sont admises).
 * @returns {string} adresse normalisée
 */
function controlerAdresse(adresse, hotes) {
  let u;
  try { u = new URL(String(adresse || '')); } catch (e) { throw new Error('Adresse de téléchargement invalide'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Adresse de téléchargement non sécurisée : HTTPS obligatoire');
  if (u.username || u.password) throw new Error('Adresse de téléchargement refusée (identifiants intégrés à l\'adresse)');
  const hote = u.hostname.toLowerCase();
  if (estBouclage(hote)) return u.toString();
  if (u.protocol !== 'https:') throw new Error('Adresse de téléchargement non sécurisée : HTTPS obligatoire');
  if (u.port) throw new Error('Adresse de téléchargement refusée (port non standard)');
  if (!hotes.includes(hote)) throw new Error(`Téléchargement refusé : l'hôte « ${hote.slice(0, 100)} » n'appartient pas à GitHub`);
  return u.toString();
}

/** Contrôle l'adresse finale d'une réponse (après redirections), si fetch l'expose. */
function controlerAdresseFinale(r, hotes) {
  const finale = r && typeof r.url === 'string' ? r.url : '';
  if (!finale) return;
  try {
    controlerAdresse(finale, hotes);
  } catch (e) {
    try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel().catch(() => {}); } catch (x) { /* ignore */ }
    throw new Error(`Redirection refusée : ${e.message}`);
  }
}

/** Lit le corps d'une réponse en texte, sans dépasser `max` octets. */
async function lireTexte(r, max) {
  const annonce = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : 0) || 0;
  if (annonce > max) throw new Error('Réponse trop volumineuse');
  if (r.body && typeof r.body.getReader === 'function') {
    const lecteur = r.body.getReader();
    const morceaux = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        try { await lecteur.cancel(); } catch (e) { /* ignore */ }
        throw new Error('Réponse trop volumineuse');
      }
      morceaux.push(Buffer.from(value));
    }
    return Buffer.concat(morceaux).toString('utf8');
  }
  const texte = await r.text();
  if (Buffer.byteLength(texte) > max) throw new Error('Réponse trop volumineuse');
  return texte;
}

function analyserJson(texte, origine) {
  try {
    return JSON.parse(String(texte).replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`Manifeste de mise à jour illisible (${origine})`);
  }
}

function lireJsonFichier(chemin) {
  const st = fs.statSync(chemin);
  if (!st.isFile() || st.size > TAILLE_MAX_JSON) throw new Error('Manifeste de mise à jour invalide (taille)');
  return analyserJson(fs.readFileSync(chemin, 'utf8'), path.basename(chemin));
}

function hoteDe(url) {
  try { return new URL(url).host; } catch (e) { return 'adresse invalide'; }
}

function delai(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/**
 * @param {object} o
 * @param {string} o.versionActuelle
 * @param {{source:string, depot?:string, chemin?:string, url?:string}} o.config
 * @param {Function} o.fetch       implémentation de fetch (suivi des redirections attendu)
 * @param {string} o.dossierTelechargement
 * @param {string} [o.agent]       User-Agent
 * @param {string|string[]} [o.clePublique]  clé(s) publique(s) Ed25519 ; non fournie : clé intégrée
 *   (package.json › gmao.clePubliqueMaj) dans l'application de bureau. Dès qu'une clé est présente,
 *   les manifestes non signés ou mal signés sont refusés.
 */
function creerGestionnaire(o) {
  const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) throw new Error('fetch indisponible');
  const ua = o.agent || 'GMAO-SICAF-Bureau';
  const cles = chargerClesPubliques(o.clePublique !== undefined ? o.clePublique : clePubliqueParDefaut());
  const signatureExigee = cles.length > 0;
  const source = (o.config || {}).source;
  const sourceGithub = !['dossier', 'url', 'aucune'].includes(source);

  async function requete(url, options) {
    try {
      return await fetchFn(url, options);
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`Délai dépassé pour ${hoteDe(url)}`);
      throw new Error(`Connexion impossible à ${hoteDe(url)}${e && e.message ? ` (${e.message})` : ''}`);
    }
  }

  async function getJson(url, hotes) {
    const r = await requete(url, {
      headers: { 'User-Agent': ua, Accept: 'application/vnd.github+json, application/json' },
      signal: delai(DELAI_REQUETE_MS),
    });
    if (hotes) controlerAdresseFinale(r, hotes);
    if (!r.ok) throw new Error(`Réponse ${r.status} de ${hoteDe(url)}`);
    return analyserJson(await lireTexte(r, TAILLE_MAX_JSON), hoteDe(url));
  }

  /** Recherche d'une version plus récente. */
  async function verifier() {
    const c = o.config || {};
    let brut; let telechargement; let page = ''; let notesPublication = ''; let assets = [];
    if (c.source === 'aucune') return { disponible: false, raison: 'Mises à jour désactivées' };
    if (c.source === 'dossier') {
      if (!c.chemin) throw new Error('Aucun dossier de mise à jour configuré');
      brut = lireJsonFichier(path.join(c.chemin, 'latest.json'));
    } else if (c.source === 'url') {
      if (!c.url) throw new Error('Aucune adresse de mise à jour configurée');
      brut = await getJson(new URL('latest.json', c.url).toString());
    } else {
      const depot = String(c.depot || '');
      if (!depot) throw new Error('Aucun dépôt de mise à jour configuré');
      if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(depot) || depot.includes('..')) throw new Error('Dépôt de mise à jour invalide');
      const rel = await getJson(`${API_GITHUB}/repos/${depot}/releases/latest`, HOTES_API_GITHUB);
      if (!rel || typeof rel !== 'object') throw new Error('Réponse invalide de GitHub');
      assets = Array.isArray(rel.assets) ? rel.assets.filter((a) => a && typeof a === 'object' && typeof a.name === 'string') : [];
      try { page = controlerAdresse(rel.html_url, HOTES_PAGE_GITHUB); } catch (e) { page = ''; }
      notesPublication = typeof rel.body === 'string' ? rel.body : '';
      const mf = assets.find((a) => a.name === 'latest.json');
      if (mf) {
        brut = await getJson(controlerAdresse(mf.browser_download_url, HOTES_TELECHARGEMENT_GITHUB), HOTES_TELECHARGEMENT_GITHUB);
      } else {
        if (signatureExigee) throw new Error(MSG_NON_SIGNE);
        const exe = assets.find((a) => /Setup.*\.exe$/i.test(a.name));
        if (!exe) return { disponible: false, raison: 'Aucun installateur dans la dernière version publiée' };
        brut = { version: String(rel.tag_name || '').replace(/^v/i, ''), fichier: exe.name, taille: exe.size };
      }
    }
    const manifeste = controlerManifeste(brut, cles);
    if (c.source === 'dossier') {
      telechargement = { type: 'fichier', chemin: path.join(c.chemin, manifeste.fichier) };
    } else if (c.source === 'url') {
      telechargement = { type: 'url', url: new URL(encodeURIComponent(manifeste.fichier), c.url).toString() };
    } else {
      const asset = assets.find((a) => a.name === manifeste.fichier);
      if (!asset) throw new Error(`Installateur ${manifeste.fichier} absent de la version publiée`);
      telechargement = { type: 'url', url: controlerAdresse(asset.browser_download_url, HOTES_TELECHARGEMENT_GITHUB) };
      // Notes de la page de publication : uniquement sans signature (elles ne sont pas couvertes par celle-ci)
      if (!signatureExigee && !manifeste.notes && notesPublication) manifeste.notes = notesPublication.slice(0, LONGUEUR_MAX_NOTES);
    }
    const comparaison = comparerVersions(manifeste.version, o.versionActuelle);
    const info = {
      disponible: comparaison > 0, versionActuelle: o.versionActuelle, version: manifeste.version, notes: manifeste.notes,
      date: manifeste.date, signatureVerifiee: manifeste.signatureVerifiee, manifeste, telechargement, page,
    };
    if (comparaison < 0) info.raison = `La version publiée (${manifeste.version}) est antérieure à la version installée : elle est ignorée.`;
    return info;
  }

  /** Télécharge l'installateur dans `tmp` sans dépasser `limite` octets ; délai d'inactivité de 2 minutes. */
  async function telechargerUrl(adresse, tmp, limite, tailleAttendue, onProgression) {
    const ctrl = new AbortController();
    let minuterie = null;
    const rearmer = () => {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => ctrl.abort(), DELAI_INACTIVITE_MS);
      if (minuterie.unref) minuterie.unref();
    };
    rearmer();
    let sortie = null;
    try {
      const r = await requete(adresse, { headers: { 'User-Agent': ua }, signal: ctrl.signal });
      if (sourceGithub) controlerAdresseFinale(r, HOTES_TELECHARGEMENT_GITHUB);
      if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (réponse ${r.status})`);
      const annonce = Number(r.headers.get('content-length')) || 0;
      if (annonce > limite) throw new Error('Mise à jour refusée : installateur plus volumineux qu\'annoncé dans le manifeste');
      const total = annonce || tailleAttendue || 0;
      sortie = fs.createWriteStream(tmp, { mode: 0o600 });
      let recu = 0;
      const lecteur = r.body.getReader();
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        rearmer();
        recu += value.length;
        if (recu > limite) {
          try { await lecteur.cancel(); } catch (e) { /* ignore */ }
          throw new Error('Mise à jour refusée : installateur plus volumineux qu\'annoncé dans le manifeste');
        }
        if (!sortie.write(Buffer.from(value))) await new Promise((res) => sortie.once('drain', res));
        if (onProgression && total) onProgression(Math.min(1, recu / total));
      }
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error('Téléchargement interrompu : aucune donnée reçue depuis 2 minutes');
      throw e;
    } finally {
      clearTimeout(minuterie);
      if (sortie) await new Promise((res) => sortie.end(res));
    }
  }

  /** Télécharge (ou copie) l'installateur, vérifie sa taille et son empreinte, retourne son chemin local. */
  async function telecharger(info, onProgression) {
    if (!info || !info.manifeste || !info.telechargement) throw new Error('Aucune mise à jour à télécharger');
    // Nouveau contrôle complet : signature (si exigée) et version, sur le manifeste effectivement utilisé
    const manifeste = controlerManifeste(info.manifeste, cles);
    if (comparerVersions(manifeste.version, o.versionActuelle) <= 0) {
      throw new Error(`Mise à jour refusée : la version ${manifeste.version} n'est pas supérieure à la version installée (${o.versionActuelle})`);
    }
    fs.mkdirSync(o.dossierTelechargement, { recursive: true });
    const cible = path.join(o.dossierTelechargement, manifeste.fichier);
    const tmp = cible + '.partiel';
    try { fs.unlinkSync(tmp); } catch (e) { /* absent */ }
    const limite = manifeste.taille || TAILLE_MAX_INSTALLATEUR;
    try {
      if (info.telechargement.type === 'fichier') {
        const st = await fs.promises.stat(info.telechargement.chemin);
        if (!st.isFile()) throw new Error('Installateur introuvable dans le dossier de mise à jour');
        if (st.size > limite) throw new Error('Mise à jour refusée : installateur plus volumineux qu\'annoncé dans le manifeste');
        await fs.promises.copyFile(info.telechargement.chemin, tmp);
        if (onProgression) onProgression(1);
      } else {
        const adresse = sourceGithub ? controlerAdresse(info.telechargement.url, HOTES_TELECHARGEMENT_GITHUB) : info.telechargement.url;
        await telechargerUrl(adresse, tmp, limite, manifeste.taille, onProgression);
      }
      const taille = (await fs.promises.stat(tmp)).size;
      if (manifeste.taille && taille !== manifeste.taille) {
        throw new Error('Taille de l\'installateur incorrecte : téléchargement incomplet ou falsifié, mise à jour annulée');
      }
      if (manifeste.sha256) {
        const h = await sha256Fichier(tmp);
        if (h !== manifeste.sha256) throw new Error('Empreinte de l\'installateur incorrecte : téléchargement corrompu ou falsifié, mise à jour annulée');
      }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
      throw e;
    }
    fs.renameSync(tmp, cible);
    return cible;
  }

  return { verifier, telecharger, signatureExigee };
}

module.exports = {
  creerGestionnaire, comparerVersions, validerManifeste, sha256Fichier, nomSur,
  contenuSigne, verifierSignature, controlerManifeste, chargerClesPubliques, empreinteClePublique,
  clePubliqueIntegree, controlerAdresse,
  ALGORITHME, CHAMPS_SIGNES, HOTES_TELECHARGEMENT_GITHUB,
};
