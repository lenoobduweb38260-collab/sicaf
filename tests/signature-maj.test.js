'use strict';
/**
 * Signature des mises à jour de l'application de bureau : manifeste signé en Ed25519, clé publique
 * intégrée, refus des manifestes altérés ou non signés, aucun retour à une version antérieure,
 * hôtes de téléchargement GitHub, scripts de génération de clés et de signature, workflow de construction.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const maj = require('../electron/miseajour');
const { creerGestionnaire, contenuSigne, verifierSignature, chargerClesPubliques, controlerAdresse, validerManifeste } = maj;
const { manifeste, lireClePrivee, nettoyerNotes } = require('../scripts/manifeste-maj');
const generateur = require('../scripts/generer-cle-maj');

const RACINE = path.resolve(__dirname, '..');
const SCRIPT_CLES = path.join(RACINE, 'scripts', 'generer-cle-maj.js');
const SCRIPT_MANIFESTE = path.join(RACINE, 'scripts', 'manifeste-maj.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const aleatoire = () => crypto.randomBytes(6).toString('hex');

function paire() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privee: privateKey,
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publique: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    publiquePem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}
const CLE = paire();
const AUTRE = paire();

/** Environnement sans variables d'intégration continue ni clé de signature héritées. */
function envPropre(ajouts = {}) {
  const e = Object.assign({}, process.env);
  delete e.MAJ_CLE_PRIVEE; delete e.GITHUB_ACTIONS; delete e.GITHUB_STEP_SUMMARY;
  return Object.assign(e, ajouts);
}

const falsifierSignature = (sig) => { const b = Buffer.from(sig, 'base64'); b[10] ^= 0x01; return b.toString('base64'); };

// ----- Publication simulée (API GitHub, pages de téléchargement, stockage, serveur interne) -----------------
const etat = {};
let srv; let base;
const requetes = [];

/**
 * Prépare une publication : installateur aléatoire, manifeste produit par scripts/manifeste-maj.js
 * (signé par `signer`, ou non signé si null), puis éventuellement altéré par `modifier`.
 */
function construire({ version = '1.0.42', signer = CLE.pem, notes = 'Plans 3D : cotations et calques', modifier = null } = {}) {
  const dossier = tmp('gmao-publication-');
  const exe = crypto.randomBytes(64 * 1024 + 123);
  fs.writeFileSync(path.join(dossier, `GMAO-SICAF-Setup-${version}.exe`), exe);
  const m = manifeste(dossier, version, notes, { clePrivee: signer, clesPubliques: [] });
  if (modifier) {
    const j = JSON.parse(fs.readFileSync(path.join(dossier, 'latest.json'), 'utf8'));
    modifier(j);
    fs.writeFileSync(path.join(dossier, 'latest.json'), JSON.stringify(j, null, 2));
  }
  Object.keys(etat).forEach((k) => delete etat[k]);
  Object.assign(etat, { version, exe, latest: fs.readFileSync(path.join(dossier, 'latest.json')) });
  return { dossier, m, exe };
}

/** fetch simulé : les hôtes GitHub sont servis localement, toute autre adresse distante est une erreur. */
async function fetchSimule(u, o) {
  const s = String(u);
  requetes.push(s);
  if (/^https:\/\/(api\.github\.com|github\.com|objects\.githubusercontent\.com)\//.test(s)) {
    return fetch(s.replace(/^https:\/\/[^/]+/, base), o);
  }
  if (s.startsWith(base)) return fetch(s, o);
  throw new Error(`Requête inattendue vers ${s}`);
}

/**
 * net.request d'Electron simulé selon son contrat : les hôtes GitHub sont servis par le serveur local ; pour
 * chaque réponse 3xx, l'événement « redirect » est émis et la redirection n'est suivie que si followRedirect()
 * est appelé pendant l'événement (sinon erreur « Redirect was cancelled »). `hotes` reçoit chaque hôte contacté.
 */
function fauxNetRequest(hotes, journalOptions = []) {
  return (options) => {
    journalOptions.push(options);
    const req = new EventEmitter();
    const entetes = {};
    let courante = null;
    let abandon = false;
    let attente = null;
    req.setHeader = (k, v) => { entetes[k] = v; };
    req.followRedirect = () => { if (!attente) throw new Error('followRedirect() hors de l\'événement « redirect »'); attente(); };
    req.abort = () => { abandon = true; if (courante) courante.destroy(); };
    const envoyer = (adresse) => {
      const u = new URL(adresse);
      hotes.push(u.hostname);
      if (!['api.github.com', 'github.com', 'objects.githubusercontent.com'].includes(u.hostname) || u.protocol !== 'https:') {
        process.nextTick(() => req.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED')));
        return;
      }
      courante = http.request(base + u.pathname + u.search, { method: options.method, headers: entetes }, (res) => {
        if (abandon) { res.destroy(); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const suivante = new URL(res.headers.location, adresse).toString();
          let suivre = false;
          attente = () => { suivre = true; };
          try { req.emit('redirect', res.statusCode, options.method, suivante, res.headers); } finally { attente = null; }
          if (abandon) return;
          if (suivre) envoyer(suivante); else req.emit('error', new Error('Redirect was cancelled'));
          return;
        }
        req.emit('response', res);
      });
      courante.on('error', (e) => { if (!abandon) req.emit('error', e); });
      courante.end();
    };
    req.end = () => envoyer(options.url);
    return req;
  };
}

function gestionnaire(options = {}) {
  return creerGestionnaire(Object.assign({
    versionActuelle: '1.0.5',
    config: { source: 'github', depot: 'sicaf/gmao' },
    fetch: fetchSimule,
    dossierTelechargement: tmp('gmao-telechargement-'),
    clePublique: CLE.publique,
  }, options));
}

before(async () => {
  srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (p === '/repos/sicaf/gmao/releases/latest') {
      const tag = `v${etat.version}`;
      const exe = `GMAO-SICAF-Setup-${etat.version}.exe`;
      const assets = [];
      if (!etat.sansManifeste) assets.push({ name: 'latest.json', browser_download_url: etat.urlManifeste || `https://github.com/sicaf/gmao/releases/download/${tag}/latest.json`, size: etat.latest.length });
      assets.push({ name: exe, browser_download_url: etat.urlInstallateur || `https://github.com/sicaf/gmao/releases/download/${tag}/${exe}`, size: etat.exe.length });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ tag_name: tag, html_url: etat.page || `https://github.com/sicaf/gmao/releases/tag/${tag}`, body: 'Notes de la page de publication', assets }));
    }
    const dl = /^\/sicaf\/gmao\/releases\/download\/v[^/]+\/(.+)$/.exec(p);
    if (dl && dl[1] === 'latest.json') { res.setHeader('content-type', 'application/json'); return res.end(etat.latest); }
    if (dl) { res.statusCode = 302; res.setHeader('location', `${etat.redirectionVers || ''}/stockage/${encodeURIComponent(dl[1])}`); return res.end(); }
    if (p === '/lent') return; // aucune réponse : délai dépassé côté poste
    if (p.startsWith('/stockage/') || (p.startsWith('/interne/') && p.endsWith('.exe'))) {
      const b = etat.exeServi || etat.exe;
      if (etat.sansLongueur) {
        // Transfert par blocs, sans longueur annoncée
        for (let i = 0; i < b.length; i += 16384) res.write(b.subarray(i, i + 16384));
        return res.end();
      }
      res.setHeader('content-length', b.length);
      return res.end(b);
    }
    if (p === '/interne/latest.json') { res.setHeader('content-type', 'application/json'); return res.end(etat.latest); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); });

// ---------------------------------------------------------------------------------------------------------------
describe('Contenu signé et clés', () => {
  test('contenu canonique : champs triés, notes comprises, valeurs normalisées', () => {
    const attendu = `{"date":"2026-10-14T08:00:00.000Z","fichier":"GMAO-SICAF-Setup-1.0.9.exe","notes":"Correctifs","sha256":"${'ab'.repeat(32)}","taille":2048,"version":"1.0.9"}`;
    const a = { version: '1.0.9', fichier: 'GMAO-SICAF-Setup-1.0.9.exe', sha256: 'AB'.repeat(32), taille: 2048, date: '2026-10-14T08:00:00.000Z', notes: 'Correctifs', inconnu: 'ignoré' };
    const b = { notes: 'Correctifs', taille: 2048, date: '2026-10-14T08:00:00.000Z', sha256: 'ab'.repeat(32), fichier: 'GMAO-SICAF-Setup-1.0.9.exe', version: '1.0.9' };
    assert.equal(contenuSigne(a), attendu);
    assert.equal(contenuSigne(b), attendu, 'l\'ordre des champs du fichier est sans effet');
    assert.deepEqual(maj.CHAMPS_SIGNES, [...maj.CHAMPS_SIGNES].sort());
  });

  test('clés publiques : base64, PEM, rotation ; refus des clés invalides, RSA ou privées', () => {
    assert.equal(chargerClesPubliques(CLE.publique).length, 1);
    assert.equal(chargerClesPubliques(CLE.publiquePem).length, 1);
    assert.equal(chargerClesPubliques(CLE.publiquePem.replace(/\n/g, '\\n')).length, 1, 'PEM saisi sur une ligne avec « \\n »');
    assert.equal(chargerClesPubliques([AUTRE.publique, CLE.publique]).length, 2);
    assert.deepEqual(chargerClesPubliques(''), []);
    assert.deepEqual(chargerClesPubliques(undefined), []);
    assert.throws(() => chargerClesPubliques('pas-une-cle'), /invalide/);
    assert.throws(() => chargerClesPubliques(CLE.pem), /PRIVÉE/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    assert.throws(() => chargerClesPubliques(rsa), /invalide/);
    assert.throws(() => chargerClesPubliques(Array(6).fill(CLE.publique)), /Trop de clés/);
    assert.throws(() => gestionnaire({ clePublique: 'pas-une-cle' }), /invalide/, 'clé illisible : mises à jour bloquées');
  });

  test('signature produite par scripts/manifeste-maj.js et vérifiée avec la clé publique', () => {
    const { m } = construire();
    assert.equal(m.algorithme, 'ed25519');
    assert.equal(Buffer.from(m.signature, 'base64').length, 64);
    assert.ok(crypto.verify(null, Buffer.from(contenuSigne(m)), crypto.createPublicKey(CLE.publiquePem), Buffer.from(m.signature, 'base64')));
    assert.equal(verifierSignature(m, chargerClesPubliques(CLE.publique)), true);
    assert.equal(verifierSignature(m, chargerClesPubliques(AUTRE.publique)), false);
    assert.equal(verifierSignature(m, chargerClesPubliques([AUTRE.publique, CLE.publique])), true, 'rotation : l\'une des clés suffit');
    const enregistre = JSON.parse(etat.latest);
    assert.deepEqual(Object.keys(enregistre), ['version', 'fichier', 'sha256', 'taille', 'date', 'notes', 'signature', 'algorithme']);
  });

  test('clé privée sans correspondance avec la clé publique intégrée : construction arrêtée', () => {
    const dossier = tmp('gmao-publication-');
    fs.writeFileSync(path.join(dossier, 'GMAO-SICAF-Setup-1.0.8.exe'), crypto.randomBytes(1024));
    assert.throws(() => manifeste(dossier, '1.0.8', '', { clePrivee: AUTRE.pem, clesPubliques: CLE.publique }), /ne correspond à aucune clé publique/);
    assert.equal(fs.existsSync(path.join(dossier, 'latest.json')), false, 'aucun manifeste écrit');
    const m = manifeste(dossier, '1.0.8', '', { clePrivee: CLE.pem, clesPubliques: [AUTRE.publique, CLE.publique] });
    assert.ok(m.signature);
  });

  test('lecture de la clé privée : PEM, PEM sur une ligne ; refus sans recopier la valeur', () => {
    assert.equal(lireClePrivee(CLE.pem).asymmetricKeyType, 'ed25519');
    assert.equal(lireClePrivee(CLE.pem.replace(/\n/g, '\\n')).asymmetricKeyType, 'ed25519');
    assert.equal(lireClePrivee(''), null);
    assert.equal(lireClePrivee(undefined), null);
    const secret = 'valeur-secrete-tres-confidentielle';
    assert.throws(() => lireClePrivee(secret), (e) => /illisible/.test(e.message) && !e.message.includes(secret));
    assert.throws(() => lireClePrivee(CLE.publiquePem), /illisible/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => lireClePrivee(rsa), /Ed25519/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Vérification par le poste (source GitHub, clé publique configurée)', () => {
  test('manifeste signé accepté : version détectée, installateur téléchargé et vérifié', async () => {
    const { exe } = construire();
    const g = gestionnaire();
    assert.equal(g.signatureExigee, true);
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.version, '1.0.42');
    assert.equal(info.signatureVerifiee, true);
    assert.equal(info.notes, 'Plans 3D : cotations et calques');
    assert.equal(info.page, 'https://github.com/sicaf/gmao/releases/tag/v1.0.42');
    const progression = [];
    const fichier = await g.telecharger(info, (x) => progression.push(x));
    assert.equal(path.basename(fichier), 'GMAO-SICAF-Setup-1.0.42.exe');
    assert.ok(fs.readFileSync(fichier).equals(exe));
    assert.equal(progression[progression.length - 1], 1);
  });

  test('signature falsifiée : mise à jour refusée', async () => {
    construire({ modifier: (j) => { j.signature = falsifierSignature(j.signature); } });
    await assert.rejects(() => gestionnaire().verifier(), /signature du manifeste est invalide/);
  });

  for (const [champ, modifier] of [
    ['version', (j) => { j.version = '1.0.99'; }],
    ['sha256', (j) => { j.sha256 = crypto.createHash('sha256').update('installateur piégé').digest('hex'); }],
    ['fichier', (j) => { j.fichier = 'GMAO-SICAF-Setup-1.0.43.exe'; }],
    ['taille', (j) => { j.taille += 1; }],
    ['date', (j) => { j.date = '2030-01-01T00:00:00.000Z'; }],
    ['notes', (j) => { j.notes = 'Version défectueuse : installez le correctif depuis https://pirate.example'; }],
  ]) {
    test(`champ « ${champ} » modifié après signature : mise à jour refusée`, async () => {
      construire({ modifier });
      await assert.rejects(() => gestionnaire().verifier(), /signature du manifeste est invalide/);
    });
  }

  test('manifeste non signé alors qu\'une clé publique est configurée : refusé', async () => {
    construire({ signer: null });
    await assert.rejects(() => gestionnaire().verifier(), /n'est pas signé/);
  });

  test('signature retirée ou algorithme remplacé : refusé', async () => {
    construire({ modifier: (j) => { delete j.signature; delete j.algorithme; } });
    await assert.rejects(() => gestionnaire().verifier(), /n'est pas signé/);
    construire({ modifier: (j) => { j.algorithme = 'rsa-sha256'; } });
    await assert.rejects(() => gestionnaire().verifier(), /algorithme/);
    construire({ modifier: (j) => { j.signature = 'AAAA'; } });
    await assert.rejects(() => gestionnaire().verifier(), /mal formée/);
  });

  test('signé avec une autre clé : refusé', async () => {
    construire({ signer: AUTRE.pem });
    await assert.rejects(() => gestionnaire().verifier(), /signature du manifeste est invalide/);
  });

  test('publication sans latest.json : refusée quand la signature est exigée', async () => {
    construire();
    etat.sansManifeste = true;
    await assert.rejects(() => gestionnaire().verifier(), /n'est pas signé/);
  });

  test('version égale ou inférieure, même correctement signée : refusée', async () => {
    construire({ version: '1.0.5' });
    const g = gestionnaire();
    const egale = await g.verifier();
    assert.equal(egale.disponible, false);
    assert.equal(egale.signatureVerifiee, true);
    await assert.rejects(() => g.telecharger(egale), /n'est pas supérieure/);

    construire({ version: '1.0.3' });
    const inferieure = await g.verifier();
    assert.equal(inferieure.disponible, false);
    assert.match(inferieure.raison, /antérieure/);
    await assert.rejects(() => g.telecharger(inferieure), /n'est pas supérieure/);

    construire({ version: '1.0.6' });
    assert.equal((await g.verifier()).disponible, true, 'version strictement supérieure acceptée');
  });

  test('manifeste modifié entre la vérification et le téléchargement : refusé, rien n\'est conservé', async () => {
    construire();
    const dl = tmp('gmao-telechargement-');
    const g = gestionnaire({ dossierTelechargement: dl });
    const info = await g.verifier();
    info.manifeste.sha256 = crypto.createHash('sha256').update('autre').digest('hex');
    await assert.rejects(() => g.telecharger(info), /signature du manifeste est invalide/);
    const info2 = await g.verifier();
    info2.manifeste.version = '9.0.0';
    await assert.rejects(() => g.telecharger(info2), /signature du manifeste est invalide/);
    assert.deepEqual(fs.readdirSync(dl), []);
  });

  test('installateur plus volumineux que la taille signée : téléchargement interrompu et supprimé', async () => {
    const { exe } = construire();
    etat.exeServi = Buffer.concat([exe, crypto.randomBytes(4096)]);
    const dl = tmp('gmao-telechargement-');
    const g = gestionnaire({ dossierTelechargement: dl });
    const info = await g.verifier();
    await assert.rejects(() => g.telecharger(info), /plus volumineux/);
    assert.deepEqual(fs.readdirSync(dl), []);
    // Même contrôle pendant la lecture quand le serveur n'annonce pas de longueur
    etat.sansLongueur = true;
    await assert.rejects(() => g.telecharger(info), /plus volumineux/);
    assert.deepEqual(fs.readdirSync(dl), []);
  });

  test('installateur substitué de même taille : empreinte refusée', async () => {
    const { exe } = construire();
    etat.exeServi = crypto.randomBytes(exe.length);
    const dl = tmp('gmao-telechargement-');
    const g = gestionnaire({ dossierTelechargement: dl });
    await assert.rejects(async () => g.telecharger(await g.verifier()), /Empreinte/);
    assert.deepEqual(fs.readdirSync(dl), []);
    // Téléchargement tronqué : taille refusée
    etat.exeServi = exe.subarray(0, exe.length - 100);
    await assert.rejects(async () => g.telecharger(await g.verifier()), /Taille de l'installateur incorrecte/);
    assert.deepEqual(fs.readdirSync(dl), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Hôtes de téléchargement GitHub', () => {
  const H = maj.HOTES_TELECHARGEMENT_GITHUB;

  test('adresses acceptées et refusées', () => {
    assert.ok(controlerAdresse('https://github.com/sicaf/gmao/releases/download/v1.0.1/latest.json', H));
    assert.ok(controlerAdresse('https://objects.githubusercontent.com/github-production-release-asset/1', H));
    assert.ok(controlerAdresse('https://release-assets.githubusercontent.com/github-production-release-asset/1', H));
    assert.ok(controlerAdresse('http://127.0.0.1:8585/latest.json', H), 'le poste lui-même');
    for (const a of [
      'http://github.com/sicaf/gmao/latest.json',
      'https://github.com.pirate.example/latest.json',
      'https://pirate.example/latest.json',
      'https://utilisateur:secret@github.com/latest.json',
      'https://github.com:8443/latest.json',
      'https://raw.githubusercontent.com/sicaf/gmao/main/latest.json',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      '',
    ]) {
      assert.throws(() => controlerAdresse(a, H), Error, a);
    }
  });

  test('installateur publié sur un autre hôte : refusé sans aucune requête vers cet hôte', async () => {
    construire();
    etat.urlInstallateur = 'https://pirate.example/GMAO-SICAF-Setup-1.0.42.exe';
    requetes.length = 0;
    await assert.rejects(() => gestionnaire().verifier(), /n'appartient pas à GitHub/);
    assert.ok(!requetes.some((r) => r.includes('pirate.example')));
  });

  test('manifeste publié sur un autre hôte ou en clair : refusé', async () => {
    construire();
    etat.urlManifeste = 'https://pirate.example/latest.json';
    await assert.rejects(() => gestionnaire().verifier(), /n'appartient pas à GitHub/);
    etat.urlManifeste = 'http://github.com/sicaf/gmao/releases/download/v1.0.42/latest.json';
    await assert.rejects(() => gestionnaire().verifier(), /HTTPS obligatoire/);
  });

  test('redirection du téléchargement vers un autre hôte : refusée, fichier partiel supprimé', async () => {
    construire();
    const dl = tmp('gmao-telechargement-');
    const redirige = async (u, o) => {
      const r = await fetchSimule(u, o);
      if (/\.exe$/.test(String(u))) Object.defineProperty(r, 'url', { value: 'https://pirate.example/GMAO-SICAF-Setup-1.0.42.exe' });
      return r;
    };
    const g = gestionnaire({ fetch: redirige, dossierTelechargement: dl });
    const info = await g.verifier();
    await assert.rejects(() => g.telecharger(info), /Redirection refusée/);
    assert.deepEqual(fs.readdirSync(dl), []);
  });

  test('réponse de l\'API GitHub servie par un autre hôte : refusée', async () => {
    construire();
    const redirige = async (u, o) => {
      const r = await fetchSimule(u, o);
      if (String(u).startsWith('https://api.github.com/')) Object.defineProperty(r, 'url', { value: 'https://api.pirate.example/repos/sicaf/gmao/releases/latest' });
      return r;
    };
    await assert.rejects(() => gestionnaire({ fetch: redirige }).verifier(), /Redirection refusée/);
  });

  test('réponse sans adresse finale (net.fetch d\'Electron) : refusée pour la source GitHub, jamais acceptée en silence', async () => {
    construire();
    // net.fetch d'Electron suit les redirections puis reconstruit la réponse : son adresse (url) est toujours vide
    const sansAdresse = async (u, o) => { const r = await fetchSimule(u, o); return new Response(r.body, { headers: r.headers, status: r.status, statusText: r.statusText }); };
    assert.equal(new Response('x').url, '');
    await assert.rejects(() => gestionnaire({ fetch: sansAdresse }).verifier(), /adresse finale de la réponse est inconnue/);
    const info = await gestionnaire().verifier();
    const dl = tmp('gmao-telechargement-');
    await assert.rejects(() => gestionnaire({ fetch: sansAdresse, dossierTelechargement: dl }).telecharger(info), /adresse finale de la réponse est inconnue/);
    assert.deepEqual(fs.readdirSync(dl), []);
    // Adresse web interne : aucun hôte imposé, la réponse est acceptée (signature exigée de la même façon)
    const interne = await gestionnaire({ fetch: sansAdresse, config: { source: 'url', url: `${base}/interne/` } }).verifier();
    assert.equal(interne.signatureVerifiee, true);
  });

  test('fetch à redirections contrôlées (net.request d\'Electron) : chaîne GitHub acceptée, autre hôte refusé avant toute requête', async () => {
    const { exe } = construire();
    etat.redirectionVers = 'https://objects.githubusercontent.com';
    const hotes = [];
    const options = [];
    const fetchControle = maj.creerFetchControle(fauxNetRequest(hotes, options));
    assert.equal(fetchControle.redirectionsControlees, true);
    const dl = tmp('gmao-telechargement-');
    const g = gestionnaire({ fetch: fetchControle, dossierTelechargement: dl });
    const info = await g.verifier();
    assert.equal(info.signatureVerifiee, true);
    const fichier = await g.telecharger(info);
    assert.ok(fs.readFileSync(fichier).equals(exe));
    assert.deepEqual([...new Set(hotes)].sort(), ['api.github.com', 'github.com', 'objects.githubusercontent.com']);
    assert.ok(options.every((o) => o.redirect === 'manual'), 'redirections jamais suivies sans contrôle');
    // Redirection vers un hôte tiers, ou en clair : refusée, aucune requête vers cette adresse
    for (const [vers, motif] of [['https://pirate.example', /Redirection refusée : Téléchargement refusé : l'hôte « pirate\.example »/], ['http://github.com', /Redirection refusée : .*HTTPS obligatoire/]]) {
      etat.redirectionVers = vers;
      hotes.length = 0;
      await assert.rejects(() => g.telecharger(info), motif);
      assert.deepEqual(hotes, ['github.com'], vers);
      assert.deepEqual(fs.readdirSync(dl).filter((f) => f.endsWith('.partiel')), []);
    }
    // Réponse : adresse finale renseignée ; délai dépassé : requête interrompue
    etat.redirectionVers = 'https://objects.githubusercontent.com';
    const r = await fetchControle(`https://github.com/sicaf/gmao/releases/download/v${etat.version}/x.exe`, {});
    assert.equal(r.url, 'https://objects.githubusercontent.com/stockage/x.exe');
    await r.arrayBuffer();
    await assert.rejects(() => fetchControle('https://api.github.com/lent', { signal: AbortSignal.timeout(80) }), (e) => e.name === 'TimeoutError');
  });

  test('page de publication hors de GitHub ignorée (jamais ouverte)', async () => {
    construire();
    etat.page = 'file:///C:/Windows/System32/calc.exe';
    const info = await gestionnaire().verifier();
    assert.equal(info.page, '');
  });

  test('dépôt de mise à jour mal formé : refusé', async () => {
    construire();
    await assert.rejects(() => gestionnaire({ config: { source: 'github', depot: '../../autre' } }).verifier(), /Dépôt de mise à jour invalide/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Sans clé publique configurée : comportement historique', () => {
  test('manifeste non signé accepté, empreinte contrôlée', async () => {
    const { exe } = construire({ signer: null });
    const g = gestionnaire({ clePublique: '' });
    assert.equal(g.signatureExigee, false);
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.signatureVerifiee, false);
    assert.ok(fs.readFileSync(await g.telecharger(info)).equals(exe));
  });

  test('manifeste signé également accepté (signature non exigée)', async () => {
    construire();
    const info = await gestionnaire({ clePublique: '' }).verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.signatureVerifiee, false);
  });

  test('empreinte incorrecte toujours refusée', async () => {
    const { exe } = construire({ signer: null });
    etat.exeServi = crypto.randomBytes(exe.length);
    const g = gestionnaire({ clePublique: '' });
    await assert.rejects(async () => g.telecharger(await g.verifier()), /Empreinte/);
  });

  test('publication sans latest.json : version de l\'étiquette, notes de la page', async () => {
    construire({ signer: null });
    etat.sansManifeste = true;
    const info = await gestionnaire({ clePublique: '' }).verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.notes, 'Notes de la page de publication');
  });

  test('aucune clé fournie hors de l\'application de bureau : aucune exigence', () => {
    const g = creerGestionnaire({ versionActuelle: '1.0.0', config: { source: 'aucune' }, fetch: fetchSimule, dossierTelechargement: tmp('gmao-telechargement-') });
    assert.equal(g.signatureExigee, process.versions.electron ? chargerClesPubliques(maj.clePubliqueIntegree()).length > 0 : false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Dossier réseau et adresse web internes', () => {
  test('dossier réseau : manifeste signé accepté, altéré ou non signé refusé', async () => {
    const { dossier, exe } = construire();
    const g = gestionnaire({ config: { source: 'dossier', chemin: dossier } });
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.signatureVerifiee, true);
    assert.ok(fs.readFileSync(await g.telecharger(info)).equals(exe));

    const altere = construire({ modifier: (j) => { j.sha256 = 'f'.repeat(64); } });
    await assert.rejects(() => gestionnaire({ config: { source: 'dossier', chemin: altere.dossier } }).verifier(), /signature du manifeste est invalide/);
    const nonSigne = construire({ signer: null });
    await assert.rejects(() => gestionnaire({ config: { source: 'dossier', chemin: nonSigne.dossier } }).verifier(), /n'est pas signé/);
  });

  test('dossier réseau : latest.json enregistré avec une marque d\'ordre d\'octets (Bloc-notes) accepté', async () => {
    const { dossier } = construire();
    const chemin = path.join(dossier, 'latest.json');
    fs.writeFileSync(chemin, '\uFEFF' + fs.readFileSync(chemin, 'utf8'));
    assert.equal((await gestionnaire({ config: { source: 'dossier', chemin: dossier } }).verifier()).disponible, true);
  });

  test('adresse web interne : signature exigée de la même façon', async () => {
    const { exe } = construire();
    const g = gestionnaire({ config: { source: 'url', url: `${base}/interne/` } });
    const info = await g.verifier();
    assert.equal(info.signatureVerifiee, true);
    assert.ok(fs.readFileSync(await g.telecharger(info)).equals(exe));
    construire({ modifier: (j) => { j.version = '2.0.0'; } });
    await assert.rejects(() => g.verifier(), /signature du manifeste est invalide/);
  });

  test('nom d\'installateur : uniquement un .exe sans chemin', () => {
    const m = { version: '1.0.1', sha256: 'a'.repeat(64), taille: 1 };
    assert.throws(() => validerManifeste(Object.assign({}, m, { fichier: 'installer.bat' })), /Nom de fichier/);
    assert.throws(() => validerManifeste(Object.assign({}, m, { fichier: '..\\GMAO.exe' })), /Nom de fichier/);
    assert.throws(() => validerManifeste(Object.assign({}, m, { fichier: 'GMAO\u0007.exe' })), /Nom de fichier/);
    assert.throws(() => validerManifeste(Object.assign({}, m, { fichier: 'GMAO.exe', version: '1.0.1; calc' })), /Version/);
    assert.throws(() => validerManifeste(Object.assign({}, m, { fichier: 'GMAO.exe', taille: -1 })), /Taille/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Script de génération de la paire de clés', () => {
  const executer = (args) => spawnSync(process.execPath, [SCRIPT_CLES, ...args], { encoding: 'utf8', env: envPropre() });

  test('clé privée écrite hors du dépôt, clé publique affichée et correspondante', (t) => {
    const dossierCles = tmp('gmao-cles-');
    t.after(() => fs.rmSync(dossierCles, { recursive: true, force: true }));
    const fichier = path.join(dossierCles, 'sous-dossier', 'signature-maj.pem');
    const r = executer([fichier]);
    assert.equal(r.status, 0, r.stderr);
    const pem = fs.readFileSync(fichier, 'utf8');
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(fichier).mode & 0o077, 0, 'lisible par le seul propriétaire');
    const corps = pem.split('\n')[1];
    assert.ok(!r.stdout.includes(corps) && !r.stderr.includes(corps), 'la clé privée n\'est jamais affichée');
    const publique = /"clePubliqueMaj": "([A-Za-z0-9+/=]+)"/.exec(r.stdout)[1];
    const [cle] = chargerClesPubliques(publique);
    const sig = crypto.sign(null, Buffer.from('essai'), crypto.createPrivateKey(pem));
    assert.ok(crypto.verify(null, Buffer.from('essai'), cle, sig));
    assert.match(r.stdout, /MAJ_CLE_PRIVEE/);
    assert.match(r.stdout, /gh secret set MAJ_CLE_PRIVEE/);
    const affiche = spawnSync(process.execPath, [SCRIPT_CLES, '--afficher', fichier], { encoding: 'utf8', env: envPropre() });
    assert.equal(affiche.status, 0);
    assert.ok(affiche.stdout.includes(publique));
    assert.ok(!affiche.stdout.includes(corps));
  });

  test('fichier existant jamais écrasé', () => {
    const fichier = path.join(tmp('gmao-cles-'), 'cle.pem');
    fs.writeFileSync(fichier, 'contenu existant');
    const r = executer([fichier]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /existe déjà/);
    assert.equal(fs.readFileSync(fichier, 'utf8'), 'contenu existant');
  });

  test('dans le dépôt : refusé si non ignoré par git ou embarqué dans l\'application', () => {
    // Les extensions de clés et certificats (*.pem, *.key, *.pfx, *.p12) sont ignorées par .gitignore : un autre nom sert au cas « non ignoré »
    const dansDepot = path.join(RACINE, `cle-essai-${aleatoire()}.txt`);
    const r = executer([dansDepot]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /dépôt/);
    assert.equal(fs.existsSync(dansDepot), false);
    const pemRacine = generateur.controlerEmplacement(path.join(RACINE, `cle-essai-${aleatoire()}.pem`));
    assert.equal(pemRacine.ok, true, '*.pem ignoré par .gitignore : accepté avec avertissement');
    assert.match(pemRacine.avertissement || '', /ignoré par \.gitignore/);
    const embarque = path.join(RACINE, 'server', `cle-${aleatoire()}.log`);
    assert.equal(executer([embarque]).status, 2);
    assert.equal(fs.existsSync(embarque), false);
    assert.equal(generateur.controlerEmplacement(path.join(RACINE, '.git', 'cle.pem')).ok, false);
  });

  test('dans le dépôt mais ignoré par .gitignore : accepté avec un avertissement', (t) => {
    const depotGit = spawnSync('git', ['-C', RACINE, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status === 0;
    if (!depotGit) { t.skip('dossier hors dépôt git'); return; }
    const c = generateur.controlerEmplacement(path.join(RACINE, 'data', `cle-${aleatoire()}.pem`));
    assert.equal(c.ok, true);
    assert.match(c.avertissement, /ignoré par \.gitignore/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Script du manifeste (ligne de commande)', () => {
  function preparer() {
    const dossier = tmp('gmao-dist-');
    fs.writeFileSync(path.join(dossier, 'GMAO-SICAF-Setup-1.0.77.exe'), crypto.randomBytes(4096));
    fs.writeFileSync(path.join(dossier, 'notes.txt'), 'Correctifs du planning');
    return dossier;
  }
  const lancer = (dossier, env) => spawnSync(process.execPath, [SCRIPT_MANIFESTE, dossier, '1.0.77', path.join(dossier, 'notes.txt')], { encoding: 'utf8', env: envPropre(env) });

  test('avec MAJ_CLE_PRIVEE : manifeste signé, clé jamais affichée', () => {
    const dossier = preparer();
    const resume = path.join(dossier, 'resume.md');
    const r = lancer(dossier, { MAJ_CLE_PRIVEE: CLE.pem, GITHUB_STEP_SUMMARY: resume });
    const corps = CLE.pem.split('\n')[1];
    assert.ok(!r.stdout.includes(corps) && !r.stderr.includes(corps));
    if (maj.clePubliqueIntegree()) {
      // Une clé publique est intégrée à package.json : une clé d'essai ne lui correspond pas
      assert.equal(r.status, 1);
      assert.match(r.stderr, /ne correspond à aucune clé publique/);
      return;
    }
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Manifeste signé \(ed25519\)/);
    const m = JSON.parse(fs.readFileSync(path.join(dossier, 'latest.json'), 'utf8'));
    assert.equal(m.notes, 'Correctifs du planning');
    assert.equal(verifierSignature(m, chargerClesPubliques(CLE.publique)), true);
    const texte = fs.readFileSync(resume, 'utf8');
    assert.match(texte, /Signature : ed25519/);
    assert.ok(!texte.includes(corps));
  });

  test('sans MAJ_CLE_PRIVEE : manifeste non signé, avertissement explicite', () => {
    const dossier = preparer();
    const r = lancer(dossier, { MAJ_CLE_PRIVEE: '', GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /NON signé/);
    assert.match(r.stdout, /::warning title=Manifeste non signé::/);
    const m = JSON.parse(fs.readFileSync(path.join(dossier, 'latest.json'), 'utf8'));
    assert.equal(m.signature, undefined);
    assert.match(m.sha256, /^[a-f0-9]{64}$/);
  });

  test('MAJ_CLE_PRIVEE illisible : échec sans recopier la valeur', () => {
    const dossier = preparer();
    const secret = 'secret-mal-copie-0123456789';
    const r = lancer(dossier, { MAJ_CLE_PRIVEE: secret, GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /illisible/);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
    assert.equal(fs.existsSync(path.join(dossier, 'latest.json')), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Workflow de construction Windows', () => {
  const yml = fs.readFileSync(path.join(RACINE, '.github', 'workflows', 'build-windows.yml'), 'utf8');
  const lignes = yml.split('\n');

  test('secrets transmis aux seules étapes qui en ont besoin, et seulement pour une version publiée', () => {
    assert.equal((yml.match(/secrets\.MAJ_CLE_PRIVEE/g) || []).length, 1);
    assert.match(yml, /MAJ_CLE_PRIVEE: \$\{\{ env\.PUBLICATION == 'oui' && secrets\.MAJ_CLE_PRIVEE \|\| '' \}\}/);
    assert.equal((yml.match(/secrets\.CSC_LINK/g) || []).length, 1);
    assert.equal((yml.match(/secrets\.CSC_KEY_PASSWORD/g) || []).length, 1);
    assert.ok(yml.indexOf('secrets.CSC_LINK') > yml.indexOf('npm ci'), 'certificat préparé après l\'installation des paquets npm');
    assert.ok(yml.indexOf('secrets.CSC_LINK') > yml.indexOf('npm install'));
    assert.match(yml, /echo "CSC_KEY_PASSWORD=" >> "\$GITHUB_ENV"/, 'mot de passe retiré après la construction');
    assert.match(yml, /^permissions:\n {2}contents: read/m);
    assert.equal((yml.match(/persist-credentials: false/g) || []).length, 2);
  });

  test('aucune expression GitHub insérée dans un script (injection de commandes)', () => {
    for (const l of lignes) {
      if (!l.includes('${{')) continue;
      assert.match(l, /^\s*(- )?[A-Za-z_][\w-]*: /, `expression hors d'une clé YAML : ${l.trim()}`);
      assert.doesNotMatch(l, /^\s*(- )?run: /, `expression dans une commande : ${l.trim()}`);
    }
  });

  test('publication non bloquante, avertissement dans le résumé du job', () => {
    const debut = yml.indexOf('id: publication');
    assert.ok(debut > 0);
    assert.match(yml.slice(debut, yml.indexOf('uses: softprops', debut)), /continue-on-error: true/);
    assert.match(yml, /if: steps\.publication\.outcome == 'failure'/);
    assert.match(yml, /GITHUB_STEP_SUMMARY/);
    assert.match(yml, /\n  publication:\n(?: {4}.*\n)*? {4}if: needs\.tests\.outputs\.publication == 'oui'\n/);
  });

  /** Jobs du workflow : nom → texte du job (indentation de deux espaces). */
  const jobs = (() => {
    const corps = yml.slice(yml.indexOf('\njobs:\n') + 7);
    const out = {};
    for (const bloc of corps.split(/\n(?=  [a-z][\w-]*:\n)/)) {
      const m = /^ {2}([a-z][\w-]*):\n/.exec(bloc.replace(/^\n/, ''));
      if (m) out[m[1]] = bloc;
    }
    return out;
  })();

  test('secrets de signature dans l\'environnement protégé « publication », jamais pour une étiquette ou une autre branche', () => {
    assert.deepEqual(Object.keys(jobs), ['tests', 'windows', 'publication']);
    // Aucune étiquette ne déclenche de construction ni de publication (une étiquette se pose sur n'importe quel commit)
    const declencheurs = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));
    assert.doesNotMatch(declencheurs, /tags/);
    assert.doesNotMatch(yml, /refs\/tags/);
    // Décision de publication : branche par défaut uniquement, hors [wip]
    assert.match(jobs.tests, /publication: \$\{\{ \(github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) && !contains\(github\.event\.head_commit\.message, '\[wip\]'\)\) && 'oui' \|\| 'non' \}\}/);
    // Tout job qui lit un secret utilise l'environnement protégé, et seulement pour une version publiée
    for (const [nom, texte] of Object.entries(jobs)) {
      if (!/secrets\./.test(texte)) continue;
      assert.match(texte, /\n {4}environment: \$\{\{ needs\.tests\.outputs\.publication == 'oui' && 'publication' \|\| '' \}\}\n/, nom);
      assert.match(texte, /\n {6}contents: read\n/, `${nom} : aucun droit d'écriture avec les secrets`);
    }
    assert.match(jobs.windows, /secrets\.MAJ_CLE_PRIVEE/);
    // Le seul job qui peut écrire (Release) ne reçoit aucun secret et n'exécute ni le code du dépôt ni npm
    assert.match(jobs.publication, /\n {6}contents: write\n/);
    const sansCommentaires = jobs.publication.replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(sansCommentaires, /secrets\.|actions\/checkout|\bnpm\b|\bnode\b|\bnpx\b/);
    assert.ok(Object.entries(jobs).every(([nom, texte]) => nom === 'publication' || !/contents: write/.test(texte)));
    const doc = fs.readFileSync(path.join(RACINE, 'docs', 'MISES-A-JOUR.md'), 'utf8');
    assert.match(doc, /Settings › Environments › New environment/);
    assert.match(doc, /Deployment branches and tags/);
    assert.match(doc, /gh secret set MAJ_CLE_PRIVEE --env publication/);
    assert.match(doc, /étiquettes `v\*`/);
  });

  test('chaîne de construction verrouillée : actions épinglées par empreinte, npm ci, publication refusée sans package-lock.json', () => {
    const uses = yml.match(/^\s*(?:- )?uses: .+$/gm);
    assert.ok(uses.length >= 6);
    for (const u of uses) assert.match(u, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, u.trim());
    // Étape d'installation exécutée avec un faux npm : npm ci si le fichier existe ; sinon échec pour une version publiée
    const etape = /- name: Installation d'Electron[^\n]*\n {8}shell: bash\n {8}run: \|\n((?: {10}.*\n)+)/.exec(yml);
    assert.ok(etape, 'étape d\'installation');
    const script = etape[1].replace(/^ {10}/gm, '');
    const essai = (avecVerrou, publication) => {
      const d = tmp('gmao-ci-');
      fs.mkdirSync(path.join(d, 'bin'));
      fs.writeFileSync(path.join(d, 'bin', 'npm'), '#!/bin/sh\necho "npm $*" >> appels.txt\n', { mode: 0o755 });
      if (avecVerrou) fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
      const r = spawnSync('bash', ['-c', script], { cwd: d, encoding: 'utf8', env: envPropre({ PUBLICATION: publication, PATH: `${path.join(d, 'bin')}:${process.env.PATH}` }) });
      const appels = fs.existsSync(path.join(d, 'appels.txt')) ? fs.readFileSync(path.join(d, 'appels.txt'), 'utf8').trim() : '';
      return { statut: r.status, appels, sortie: r.stdout };
    };
    if (spawnSync('bash', ['-c', 'true']).status !== 0) return;
    assert.deepEqual(essai(true, 'oui'), { statut: 0, appels: 'npm ci --no-audit --no-fund', sortie: '' });
    const refus = essai(false, 'oui');
    assert.equal(refus.statut, 1);
    assert.equal(refus.appels, '', 'aucune installation');
    assert.match(refus.sortie, /::error title=Dépendances non verrouillées::/);
    const branche = essai(false, 'non');
    assert.equal(branche.statut, 0);
    assert.equal(branche.appels, 'npm install --no-audit --no-fund');
    assert.match(branche.sortie, /::warning/);
  });

  test('notes de version nettoyées par scripts/manifeste-maj.js : en-têtes de fin et mentions d\'outils retirés', () => {
    const message = [
      'Planning : glisser-déposer des interventions', '', 'Détail : correction du calcul des charges.',
      'Co-Authored-By: Une Personne <personne@exemple.fr>', '  Signed-off-by: Autre Personne <autre@exemple.fr>',
      'Reviewed-by: Relecteur', 'Outil-Session: https://exemple.invalid/session_0123',
    ].join('\n');
    assert.equal(nettoyerNotes(message), 'Planning : glisser-déposer des interventions\n\nDétail : correction du calcul des charges.');
    // Fusion « squash » reprenant la description d'une demande de fusion
    const fusion = [
      'Planning : glisser-déposer (#42)', '', '- déplacement des interventions', '- contrôle des chevauchements', '',
      '🤖 Generated with [Outil](https://exemple.invalid/outil)', '', 'https://exemple.invalid/code/session_0123',
      'Session: https://exemple.invalid/session_42', 'Généré avec [Outil](https://exemple.invalid/outil)', '',
      'Co-Authored-By: Une Personne <p@exemple.fr>', 'Note: valeur',
    ].join('\r\n');
    assert.equal(nettoyerNotes(fusion), 'Planning : glisser-déposer (#42)\n\n- déplacement des interventions\n- contrôle des chevauchements');
    // Texte ordinaire conservé : deux-points à la française, adresse dans une phrase, sujet seul
    const ordinaire = 'Rapports : export mensuel\n\nVoir https://intranet.exemple.fr/gmao pour le détail.\nGénéré avec soin chaque mois.';
    assert.equal(nettoyerNotes(ordinaire), ordinaire);
    assert.equal(nettoyerNotes('Correctif: calcul des charges'), 'Correctif: calcul des charges', 'le sujet n\'est jamais un en-tête de fin');
    // Ligne de commande : notes nettoyées dans le manifeste signé et, à l'identique, dans le texte de la publication
    const dossier = tmp('gmao-dist-');
    fs.writeFileSync(path.join(dossier, 'GMAO-SICAF-Setup-1.0.78.exe'), crypto.randomBytes(2048));
    fs.writeFileSync(path.join(dossier, 'commit.txt'), fusion);
    const r = spawnSync(process.execPath, [SCRIPT_MANIFESTE, dossier, '1.0.78', path.join(dossier, 'commit.txt'), path.join(dossier, 'notes.txt')], { encoding: 'utf8', env: envPropre({ MAJ_CLE_PRIVEE: '' }) });
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(fs.readFileSync(path.join(dossier, 'latest.json'), 'utf8'));
    assert.equal(m.notes, nettoyerNotes(fusion));
    assert.equal(fs.readFileSync(path.join(dossier, 'notes.txt'), 'utf8'), `${m.notes}\n`);
    // Workflow : le texte de la publication est celui produit par le script, jamais le message brut
    assert.match(yml, /run: node scripts\/manifeste-maj\.js dist "\$VERSION" notes-commit\.txt dist\/notes\.txt/);
    assert.match(yml, /body_path: dist\/notes\.txt/);
    assert.doesNotMatch(yml, /grep -v/);
  });

  test('limite documentée : rejeu d\'une version signée antérieure à la dernière publiée', () => {
    const doc = fs.readFileSync(path.join(RACINE, 'docs', 'MISES-A-JOUR.md'), 'utf8');
    assert.match(doc, /rejeu d'une version signée/);
    assert.match(doc, /Version signée défectueuse ou vulnérable/);
  });
});
