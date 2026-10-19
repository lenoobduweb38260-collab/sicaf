'use strict';
/**
 * Sauvegardes multi-destinations / multi-sites : VRAIS dossiers temporaires et DEUX serveurs GMAO
 * (deux dossiers de données, deux ports) — Carpentras sauvegarde chez Valréas.
 * Couvre : dossiers (.gz / .enc + .sha256, rétention, restauration chiffrée), réception d'un autre site
 * (clé, empreinte, refus, traversée de chemin, anti-force-brute), secrets jamais exposés, droits (403),
 * portée par site, lecture seule, en-tête X-GMAO-Site, planification, historique, gestion des destinations réservée
 * aux accès globaux, réplication HTTPS avec épinglage du certificat, notifications filtrées, relecture après copie,
 * copies de l'état précédent restaurables.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { createApp } = require('../server/server');
const { seedDemo } = require('../server/modules/sauvegardes');
const tlsGmao = require('../server/tls');

const RE_NOM = /^gmao-([A-Za-z0-9_-]+)-(\d{8})-(\d{6})(?:-\d+)?\.json(\.gz)?(\.enc)?$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MDP = 'Chiffrement-Carpentras-2026!';

const temporaires = [];
function dossierTemp(prefixe = 'gmao-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixe)); temporaires.push(d); return d; }

function assouplirPolitique(app) {
  // Politique de mot de passe assouplie pour les comptes de test (voir tests/helpers.js)
  const cfg = app.db.getConfig();
  cfg.securite = Object.assign({}, cfg.securite, { longueurMinMdp: 4, complexite: false, refuserCourants: false, interdireIdentifiant: false, forcerChangementMdpInitial: false });
  app.db.setConfig(cfg);
}

async function lancer({ memoire = false } = {}) {
  const dataDir = memoire ? null : dossierTemp();
  const app = createApp(memoire ? { inMemory: true, log: () => {} } : { dataDir, log: () => {} });
  assouplirPolitique(app);
  const addr = await app.start(0);
  return { app, dataDir, base: `http://127.0.0.1:${addr.port}`, db: app.db, ctx: app.ctx };
}

/** Serveur GMAO en HTTPS avec écoute mixte, comme le poste serveur de l'application de bureau. */
async function lancerHttps(cert, dataDir = dossierTemp('gmao-tls-')) {
  const app = createApp({ dataDir, log: () => {}, tls: { key: cert.cle, cert: cert.certificat } });
  assouplirPolitique(app);
  const ecoute = await tlsGmao.ecouterMixte(app.server, 0, '127.0.0.1');
  return { app, dataDir, port: ecoute.adresse.port, db: app.db, ctx: app.ctx, async stop() { await ecoute.fermer(); await app.stop(); } };
}

/** Client HTTPS acceptant le certificat auto-signé du serveur (poste client après confirmation de l'empreinte). */
function clientHttps(port) {
  const https = require('https');
  let cookie = '';
  function call(method, url, body) {
    return new Promise((resolve, reject) => {
      const headers = { 'x-requested-with': 'GMAO', cookie, host: `127.0.0.1:${port}` };
      const payload = body === undefined ? null : JSON.stringify(body);
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
      const req = https.request({ host: '127.0.0.1', port, method, path: url, headers, rejectUnauthorized: false }, (res) => {
        const sc = res.headers['set-cookie'];
        if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0];
        const m = [];
        res.on('data', (c) => m.push(c));
        res.on('end', () => { const t = Buffer.concat(m).toString('utf8'); let b; try { b = JSON.parse(t); } catch (e) { b = t; } resolve({ status: res.statusCode, body: b }); });
      });
      req.on('error', reject);
      if (payload) req.end(payload); else req.end();
    });
  }
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b),
    async login(login, password) { const r = await call('POST', '/api/auth/login', { login, password }); if (r.status !== 200) throw new Error('Connexion échouée : ' + JSON.stringify(r.body)); return r.body; },
    async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
  };
}

/** Faux « serveur GMAO » qui accepte tout et conserve ce qu'il reçoit (exfiltration). */
async function serveurLeurre() {
  const recus = [];
  const srv = http.createServer((req, res) => {
    const m = [];
    req.on('data', (c) => m.push(c));
    req.on('end', () => { const corps = Buffer.concat(m); recus.push({ url: req.url, corps }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, site: 'Leurre', version: '1', sha256: sha256(corps), fichiers: [] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, recus, fermer: () => new Promise((r) => srv.close(r)) };
}

/** Client HTTP conservant le cookie de session, avec en-tête de site optionnel et envoi brut. */
function client(srv) {
  let cookie = '';
  let site = null;
  async function call(method, url, body, extra = {}) {
    const headers = Object.assign({ cookie }, extra.sansCsrf ? {} : { 'x-requested-with': 'GMAO' }, extra.headers || {});
    if (site != null) headers['x-gmao-site'] = String(site);
    let payload;
    if (extra.brut !== undefined) { payload = extra.brut; headers['content-type'] = 'application/octet-stream'; } else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(srv.base + url, { method, headers, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data; try { data = JSON.parse(buf.toString('utf8')); } catch (e) { data = buf.toString('utf8'); }
    return { status: r.status, body: data, brut: buf, headers: r.headers };
  }
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
    call, setSite(s) { site = s; },
    async login(login, password) { const r = await call('POST', '/api/auth/login', { login, password }); if (r.status !== 200) throw new Error('Connexion échouée : ' + JSON.stringify(r.body)); return r.body; },
    async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
  };
}

/** Envoi direct à /api/replication/recevoir (comme le ferait un autre site). */
async function envoyerBrut(srv, { cle, fichier, contenu, sha, source = 'Site test' }) {
  const headers = { 'content-type': 'application/octet-stream', 'x-gmao-source': encodeURIComponent(source) };
  if (cle !== undefined) headers['x-gmao-cle'] = cle;
  if (fichier !== undefined) headers['x-gmao-fichier'] = fichier;
  headers['x-gmao-sha256'] = sha === undefined ? sha256(contenu) : sha;
  const r = await fetch(srv.base + '/api/replication/recevoir', { method: 'POST', headers, body: contenu });
  let body; try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, body };
}

describe('Sauvegardes multi-destinations et multi-sites', () => {
  let A, B, adminA, adminB, dossierD, siteA, siteB, prodA;
  let destD, destServeur, cleB, fichierChiffre;
  let uC, uL, destV, destC, dossierV, dossierC;

  before(async () => {
    A = await lancer();
    B = await lancer();
    adminA = client(A); await adminA.login('admin', 'admin');
    adminB = client(B); await adminB.login('admin', 'admin');
    const secA = await adminA.ok('GET', '/api/secteurs');
    siteA = secA.find((s) => s.code === 'SITE');
    prodA = secA.find((s) => s.code === 'PROD');
    await adminA.ok('PUT', '/api/secteurs/' + siteA.id, { nom: 'Usine de Carpentras', code: 'CARP' });
    const secB = await adminB.ok('GET', '/api/secteurs');
    await adminB.ok('PUT', '/api/secteurs/' + secB.find((s) => s.code === 'SITE').id, { nom: 'Usine de Valréas', code: 'VAL' });
    dossierD = dossierTemp('gmao-dest-');
  });

  after(async () => {
    await A.app.stop();
    await B.app.stop();
    for (const d of temporaires) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  test('état initial : paramètres par défaut, identité du serveur, aucune destination', async () => {
    const r = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.equal(r.parametres.automatique, true);
    assert.equal(r.parametres.frequenceHeures, 24);
    assert.equal(r.parametres.heure, '22:00');
    assert.equal(r.parametres.compresser, true);
    assert.equal(r.parametres.chiffrer, false);
    assert.equal(r.parametres.accepterReception, false);
    assert.equal(r.parametres.motDePasseDefini, false);
    assert.equal(r.parametres.cleReceptionDefinie, false);
    assert.deepEqual(r.destinations, []);
    assert.equal(r.serveur.nom, 'Usine de Carpentras');
    assert.equal(r.serveur.identifiant, 'CARP');
    assert.equal(r.serveur.memoire, false);
    assert.ok(r.serveur.adresses.length >= 1 && r.serveur.adresses.every((a) => /^http:\/\/.+:\d+$/.test(a)));
    assert.equal(r.droits.modifier, true);
    assert.equal(r.droits.restaurer, true);
  });

  test('validation stricte des destinations', async () => {
    const essais = [
      [{ type: 'dossier', chemin: dossierD }, /nom/i],
      [{ nom: 'X', type: 'ftp', chemin: dossierD }, /Type/],
      [{ nom: 'X', type: 'dossier', chemin: 'Sauvegardes\\GMAO' }, /chemin complet/],
      [{ nom: 'X', type: 'dossier', chemin: '' }, /obligatoire/],
      [{ nom: 'X', type: 'dossier', chemin: dossierD + '/../autre' }, /\.\./],
      [{ nom: 'X', type: 'dossier', chemin: path.join(A.ctx.clientDir, 'js') }, /publié/],
      [{ nom: 'X', type: 'dossier', chemin: path.join(A.dataDir, 'backups', 'recus', 'x') }, /reçues/],
      [{ nom: 'X', type: 'dossier', chemin: dossierD + '/a?b' }, /interdits/],
      [{ nom: 'X', type: 'dossier', chemin: dossierD, conserver: 0 }, /entre 1 et 365/],
      [{ nom: 'X', type: 'serveur', url: 'srv-valreas:8585', cle: 'x'.repeat(20) }, /http/],
      [{ nom: 'X', type: 'serveur', url: 'ftp://srv', cle: 'x'.repeat(20) }, /http/],
      [{ nom: 'X', type: 'serveur', url: 'http://u:p@srv:8585', cle: 'x'.repeat(20) }, /identifiant/],
      [{ nom: 'X', type: 'serveur', url: 'http://srv:8585' }, /clé/i],
      [{ nom: 'X', type: 'serveur', url: 'http://srv:8585', cle: 'court' }, /Clé de réception invalide/],
      [{ nom: 'X', type: 'dossier', chemin: dossierD, secteurId: 99999 }, /inconnu/],
      [{ nom: 'X', type: 'dossier', chemin: dossierD, actif: 'oui' }, /oui \/ non/],
    ];
    for (const [corps, motif] of essais) {
      const r = await adminA.post('/api/sauvegardes-avancees/destinations', corps);
      assert.equal(r.status, 400, JSON.stringify(corps) + ' → ' + JSON.stringify(r.body));
      assert.match(r.body.erreur, motif, JSON.stringify(corps));
    }
    assert.equal((await adminA.ok('GET', '/api/sauvegardes-avancees')).destinations.length, 0);
  });

  test('destination dossier : test d\'écriture, exécution, fichier .json.gz + .sha256, copie locale', async () => {
    destD = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Disque D (sauvegardes)', type: 'dossier', chemin: dossierD, conserver: 5, secteurId: siteA.id });
    assert.equal(destD.type, 'dossier');
    assert.equal(destD.actif, true);
    assert.equal(destD.chemin, dossierD);
    const doublon = await adminA.post('/api/sauvegardes-avancees/destinations', { nom: 'disque d (SAUVEGARDES)', type: 'dossier', chemin: dossierD });
    assert.equal(doublon.status, 400);

    const t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${destD.id}/tester`);
    assert.equal(t.ok, true, t.message);
    assert.match(t.message, /accessible en écriture/);
    assert.equal(fs.readdirSync(dossierD).length, 0, 'le fichier de test est supprimé');

    const r = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.fichier, RE_NOM);
    assert.equal(RE_NOM.exec(r.fichier)[1], 'CARP');
    assert.ok(r.fichier.endsWith('.json.gz'));
    assert.equal(r.resultats.length, 1);
    assert.equal(r.resultats[0].ok, true, r.resultats[0].message);
    assert.equal(r.local.ok, true);

    const contenu = fs.readFileSync(path.join(dossierD, r.fichier));
    assert.equal(sha256(contenu), r.sha256);
    const ligne = fs.readFileSync(path.join(dossierD, r.fichier + '.sha256'), 'utf8');
    assert.equal(ligne, `${r.sha256}  ${r.fichier}\n`);
    const data = JSON.parse(zlib.gunzipSync(contenu).toString('utf8'));
    assert.ok(data.collections && Array.isArray(data.collections.users) && data.collections.users.length >= 1);
    assert.equal(data.exportGMAO.source, 'Usine de Carpentras');
    assert.deepEqual(data.config.sauvegardes.destinations, [], 'les destinations (et leurs clés) ne sont pas copiées dans la sauvegarde');
    // Copie locale dans le dossier des sauvegardes du serveur
    assert.ok(fs.existsSync(path.join(A.dataDir, 'backups', r.fichier)));
    assert.ok(fs.existsSync(path.join(A.dataDir, 'backups', r.fichier + '.sha256')));

    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    const d = g.destinations.find((x) => x.id === destD.id);
    assert.equal(d.derniere.ok, true);
    assert.equal(d.derniere.fichier, r.fichier);
    assert.equal(d.derniereVerification.ok, true);
    assert.equal(g.historique[0].type, 'sauvegarde');
    assert.equal(g.historique[0].ok, true);
    assert.equal(g.historique[0].declencheur, 'manuel');
    assert.equal(g.parametres.derniereExecution.ok, true);
    assert.ok(g.locales.some((f) => f.nom === r.fichier && f.sha256 === r.sha256));

    const liste = await adminA.ok('GET', `/api/sauvegardes-avancees/destinations/${destD.id}/fichiers`);
    assert.equal(liste.fichiers.length, 1);
    assert.equal(liste.fichiers[0].nom, r.fichier);
    assert.equal(liste.fichiers[0].sha256, r.sha256);
    assert.equal(liste.fichiers[0].compresse, true);
    assert.equal(liste.fichiers[0].ceServeur, true);
    // Audit
    assert.ok(A.db.list('audit').some((a) => a.entite === 'sauvegardes' && a.action === 'creation'));
    assert.ok(A.db.list('audit').some((a) => a.entite === 'sauvegardes' && a.action === 'sauvegarde'));
  });

  test('chiffrement AES-256-GCM : mot de passe obligatoire, en-tête versionné, écriture seule', async () => {
    let r = await adminA.put('/api/sauvegardes-avancees/parametres', { chiffrer: true });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /mot de passe/);
    r = await adminA.put('/api/sauvegardes-avancees/parametres', { chiffrer: true, motDePasseChiffrement: 'court' });
    assert.equal(r.status, 400);
    r = await adminA.put('/api/sauvegardes-avancees/parametres', { frequenceHeures: 0 });
    assert.equal(r.status, 400);
    r = await adminA.put('/api/sauvegardes-avancees/parametres', { heure: '25:00' });
    assert.equal(r.status, 400);
    const p = await adminA.ok('PUT', '/api/sauvegardes-avancees/parametres', { chiffrer: true, motDePasseChiffrement: MDP, frequenceHeures: 12, heure: '21:30', conserverLocal: 10 });
    assert.equal(p.chiffrer, true);
    assert.equal(p.motDePasseDefini, true);
    assert.equal(p.frequenceHeures, 12);
    assert.equal(p.heure, '21:30');
    assert.equal(JSON.stringify(p).includes(MDP), false);
    // Laisser le mot de passe vide = inchangé
    await adminA.ok('PUT', '/api/sauvegardes-avancees/parametres', { motDePasseChiffrement: '', frequenceHeures: 24 });
    assert.equal(A.db.getConfig().sauvegardes.motDePasseChiffrement, MDP);

    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destD.id });
    assert.equal(ex.ok, true, JSON.stringify(ex));
    assert.ok(ex.fichier.endsWith('.json.gz.enc'));
    assert.equal(ex.chiffre, true);
    assert.equal(ex.local, null, 'pas de copie locale pour une destination unique');
    fichierChiffre = ex.fichier;
    const buf = fs.readFileSync(path.join(dossierD, ex.fichier));
    assert.equal(buf.subarray(0, 7).toString('ascii'), 'GMAOSAV');
    assert.equal(buf[7], 1, 'version du format chiffré');
    assert.equal(sha256(buf), ex.sha256);
    const { decoder } = require('../server/modules/sauvegardes');
    await assert.rejects(decoder(buf, 'mauvais-mot-de-passe'), /incorrect/);
    await assert.rejects(decoder(buf, ''), /chiffrée/);
    const dec = await decoder(buf, MDP);
    assert.equal(dec.chiffre, true);
    assert.equal(dec.compresse, true);
    assert.ok(dec.data.collections.users.length >= 1);
    assert.equal(JSON.stringify(dec.data).includes(MDP), false, 'le mot de passe n\'est pas dans la sauvegarde');
  });

  test('rétention par destination : seules les sauvegardes de ce serveur sont élaguées', async () => {
    const etranger = 'gmao-VAL-20250101-120000.json.gz';
    fs.writeFileSync(path.join(dossierD, etranger), zlib.gzipSync('{}'));
    fs.writeFileSync(path.join(dossierD, 'notes-informatique.txt'), 'à conserver');
    await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${destD.id}`, { conserver: 2 });
    const noms = [];
    for (let i = 0; i < 3; i++) noms.push((await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destD.id })).fichier);
    assert.equal(new Set(noms).size, 3, 'noms uniques même dans la même seconde');
    const presents = fs.readdirSync(dossierD);
    const nos = presents.filter((n) => RE_NOM.test(n) && RE_NOM.exec(n)[1] === 'CARP');
    assert.deepEqual(nos.sort(), noms.slice(1).sort(), 'les deux plus récentes sont conservées');
    assert.ok(presents.includes(etranger), 'la sauvegarde d\'un autre site est conservée');
    assert.ok(presents.includes('notes-informatique.txt'));
    const sha = presents.filter((n) => n.endsWith('.sha256'));
    assert.deepEqual(sha.sort(), noms.slice(1).map((n) => n + '.sha256').sort(), 'les .sha256 des fichiers supprimés sont supprimés');
    fichierChiffre = noms[2];
    await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${destD.id}`, { conserver: 10 });
  });

  test('restauration depuis un dossier : sauvegarde chiffrée, bon / mauvais mot de passe, empreinte, état précédent sauvegardé', async () => {
    const avant = A.db.insert('fournisseurs', { nom: 'Fournisseur témoin avant sauvegarde', actif: true });
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destD.id });
    const apres = A.db.insert('fournisseurs', { nom: 'Fournisseur ajouté après sauvegarde', actif: true });
    let r = await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: ex.fichier, motDePasse: 'mauvais-mot-de-passe' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /incorrect/);
    assert.ok(A.db.get('fournisseurs', apres.id), 'données inchangées après un échec');

    r = await adminA.ok('POST', '/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: ex.fichier });
    assert.equal(r.ok, true);
    assert.equal(r.chiffre, true);
    assert.equal(r.empreinteVerifiee, true);
    assert.equal(r.sessionConservee, true);
    assert.match(r.copieAvant, /^gmao-avant-import-/);
    assert.ok(fs.existsSync(path.join(A.dataDir, 'backups', r.copieAvant)), 'copie de l\'état actuel avant restauration');
    assert.ok(A.db.get('fournisseurs', avant.id));
    assert.equal(A.db.findOne('fournisseurs', (f) => f.nom === apres.nom), null, 'les données postérieures à la sauvegarde ont disparu');
    // Les paramètres de sauvegarde de CE serveur sont conservés (destinations, mot de passe)
    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.ok(g.destinations.some((d) => d.id === destD.id));
    assert.equal(g.parametres.motDePasseDefini, true);
    assert.equal(g.historique[0].type, 'restauration');
    assert.ok(A.db.list('audit').some((a) => a.action === 'restauration' && a.entite === 'sauvegardes'));

    // Empreinte altérée → refus
    const f = path.join(dossierD, ex.fichier + '.sha256');
    const ligne = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, '0'.repeat(64) + '  ' + ex.fichier + '\n');
    r = await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: ex.fichier });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /Empreinte/);
    fs.writeFileSync(f, ligne);

    // Traversée de chemin et noms invalides
    for (const corps of [
      { source: 'destination', destinationId: destD.id, fichier: '../gmao.json' },
      { source: 'destination', destinationId: destD.id, fichier: '..%2F..%2Fgmao-CARP-20260101-000000.json' },
      { source: 'destination', destinationId: destD.id, fichier: 'C:\\Windows\\gmao-CARP-20260101-000000.json' },
      { source: 'locale', fichier: '../gmao.json' },
      { source: 'recue', site: '../..', fichier: 'gmao-CARP-20260101-000000.json' },
      { source: 'recue', fichier: '../../gmao-CARP-20260101-000000.json' },
      { source: 'autre', fichier: 'x' },
    ]) {
      const x = await adminA.post('/api/sauvegardes-avancees/restaurer', corps);
      assert.equal(x.status, 400, JSON.stringify(corps) + ' → ' + JSON.stringify(x.body));
    }
    const absent = await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'locale', fichier: 'gmao-CARP-20200101-000000.json.gz' });
    assert.equal(absent.status, 404);
  });

  test('destination serveur : clé de réception générée sur l\'autre site, envoi, fichier reçu et empreinte vérifiés', async () => {
    // Sur Valréas : génération de la clé (affichée une seule fois) et activation de la réception
    const gen = await adminB.ok('POST', '/api/sauvegardes-avancees/cle-reception/generer');
    cleB = gen.cle;
    assert.match(cleB, /^gmao_[A-Za-z0-9_-]{40,}$/);
    const stockee = B.db.getConfig().sauvegardes.cleReception;
    assert.notEqual(stockee, cleB, 'la clé n\'est pas stockée en clair');
    assert.match(stockee, /^sha256:[a-f0-9]{64}$/);
    let gB = await adminB.ok('GET', '/api/sauvegardes-avancees');
    assert.equal(gB.parametres.cleReceptionDefinie, true);
    assert.equal(JSON.stringify(gB).includes(cleB), false);
    assert.equal(JSON.stringify(gB).includes(stockee.slice(7)), false);
    await adminB.ok('PUT', '/api/sauvegardes-avancees/parametres', { accepterReception: true, conserverRecues: 3 });

    // Sur Carpentras : destination « serveur »
    destServeur = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Serveur GMAO de Valréas', type: 'serveur', url: B.base + '/', cle: cleB, conserver: 5 });
    assert.equal(destServeur.url, B.base, 'adresse normalisée');
    assert.equal(destServeur.cleDefinie, true);
    assert.equal(destServeur.cle, undefined);
    const t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${destServeur.id}/tester`);
    assert.equal(t.ok, true, t.message);
    assert.equal(t.site, 'Usine de Valréas');
    assert.ok(t.version);

    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destServeur.id });
    assert.equal(ex.ok, true, JSON.stringify(ex.resultats));
    assert.match(ex.resultats[0].message, /Valréas/);
    const dossierRecu = path.join(B.dataDir, 'backups', 'recus', 'Usine-de-Carpentras');
    const contenu = fs.readFileSync(path.join(dossierRecu, ex.fichier));
    assert.equal(sha256(contenu), ex.sha256);
    assert.equal(fs.readFileSync(path.join(dossierRecu, ex.fichier + '.sha256'), 'utf8').slice(0, 64), ex.sha256);
    assert.equal(contenu.subarray(0, 7).toString('ascii'), 'GMAOSAV', 'reçue chiffrée : jamais importée automatiquement');

    gB = await adminB.ok('GET', '/api/sauvegardes-avancees');
    const recu = gB.recues.find((x) => x.site === 'Usine-de-Carpentras');
    assert.ok(recu, JSON.stringify(gB.recues));
    assert.equal(recu.nom, 'Usine de Carpentras');
    assert.equal(recu.fichiers[0].nom, ex.fichier);
    assert.equal(recu.fichiers[0].sha256, ex.sha256);
    assert.equal(recu.fichiers[0].chiffre, true);
    assert.equal(gB.historique[0].type, 'reception');
    assert.ok(B.db.list('audit').some((a) => a.action === 'reception'));
    assert.equal(B.db.findOne('fournisseurs', (f) => f.nom === 'Fournisseur témoin avant sauvegarde'), null, 'aucun import automatique');

    // Liste des fichiers déposés chez l'autre site, vue depuis Carpentras
    const liste = await adminA.ok('GET', `/api/sauvegardes-avancees/destinations/${destServeur.id}/fichiers`);
    assert.equal(liste.site, 'Usine de Valréas');
    assert.ok(liste.fichiers.some((f) => f.nom === ex.fichier && f.sha256 === ex.sha256 && f.ceServeur));
    assert.equal(liste.restaurable, false);

    // Rétention côté réception (min(conserver de l'émetteur, conserverRecues du récepteur) = 3)
    for (let i = 0; i < 3; i++) await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destServeur.id });
    assert.equal(fs.readdirSync(dossierRecu).filter((n) => RE_NOM.test(n)).length, 3);

    // Téléchargement d'une sauvegarde reçue (avec son empreinte)
    const nom = fs.readdirSync(dossierRecu).filter((n) => RE_NOM.test(n)).sort().pop();
    const dl = await adminB.call('GET', `/api/sauvegardes-avancees/telecharger?source=recue&site=Usine-de-Carpentras&fichier=${encodeURIComponent(nom)}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('x-gmao-sha256'), sha256(dl.brut));
    assert.deepEqual(dl.brut, fs.readFileSync(path.join(dossierRecu, nom)));
  });

  test('réception refusée : mauvaise clé (403), réception désactivée (403), empreinte, contenu, traversée de chemin', async () => {
    const contenu = zlib.gzipSync(JSON.stringify({ collections: { users: [{ id: 1 }] } }));
    const fichier = 'gmao-TEST-20261014-101010.json.gz';
    let r = await envoyerBrut(B, { cle: 'gmao_cle-totalement-fausse-0123456789', fichier, contenu });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Clé de réception invalide/);
    r = await envoyerBrut(B, { fichier, contenu });
    assert.equal(r.status, 403, 'clé absente');
    r = await envoyerBrut(B, { cle: cleB, fichier, contenu, sha: 'a'.repeat(64) });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /Empreinte/);
    r = await envoyerBrut(B, { cle: cleB, fichier, contenu, sha: 'pas-une-empreinte' });
    assert.equal(r.status, 400);
    r = await envoyerBrut(B, { cle: cleB, fichier, contenu: Buffer.from('MZ exécutable déguisé') });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /pas une sauvegarde GMAO/);
    for (const nom of ['../../../evil.json', '..%2F..%2Fevil.json', 'gmao-TEST-20261014-101010.json.gz/../../x.json', 'C:\\Windows\\gmao-TEST-20261014-101010.json', 'evil.exe', '']) {
      r = await envoyerBrut(B, { cle: cleB, fichier: nom, contenu, source: '../../..' });
      assert.equal(r.status, 400, nom + ' → ' + JSON.stringify(r.body));
    }
    assert.equal(fs.existsSync(path.join(B.dataDir, 'evil.json')), false);
    assert.equal(fs.existsSync(path.join(B.dataDir, 'backups', 'evil.json')), false);
    // Source assainie : jamais de remontée d'arborescence
    r = await envoyerBrut(B, { cle: cleB, fichier, contenu, source: '../../Usine\\de/Test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dossiers = fs.readdirSync(path.join(B.dataDir, 'backups', 'recus'));
    assert.ok(dossiers.every((d) => /^[A-Za-z0-9_-]+$/.test(d)), dossiers.join(', '));
    assert.ok(dossiers.includes('Usine-de-Test'));

    // Mauvaise clé sur la destination : l'échec est signalé et notifié aux administrateurs
    await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${destServeur.id}`, { cle: 'gmao_mauvaise-cle-de-reception-xyz' });
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.equal(ex.ok, false);
    const res = ex.resultats.find((x) => x.destinationId === destServeur.id);
    assert.equal(res.ok, false);
    assert.match(res.message, /Refusé par le serveur distant/);
    assert.ok(ex.resultats.find((x) => x.destinationId === destD.id).ok, 'un échec n\'empêche pas les autres destinations');
    assert.equal(ex.local.ok, true);
    const notifs = await adminA.ok('GET', '/api/notifications');
    assert.ok(notifs.notifications.some((n) => /Échec/.test(n.titre) && /Valréas/.test(n.message)), JSON.stringify(notifs.notifications.slice(0, 2)));
    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.equal(g.destinations.find((d) => d.id === destServeur.id).derniere.ok, false);
    assert.equal(g.parametres.echecsConsecutifs, 1);

    // Clé vide = inchangée ; puis bonne clé
    await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${destServeur.id}`, { cle: '', nom: 'Serveur GMAO de Valréas' });
    assert.equal(A.db.getConfig().sauvegardes.destinations.find((d) => d.id === destServeur.id).cle, 'gmao_mauvaise-cle-de-reception-xyz');
    await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${destServeur.id}`, { cle: cleB });

    // Réception désactivée sur Valréas
    await adminB.ok('PUT', '/api/sauvegardes-avancees/parametres', { accepterReception: false });
    r = await envoyerBrut(B, { cle: cleB, fichier, contenu });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /désactivée/);
    const t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${destServeur.id}/tester`);
    assert.equal(t.ok, false);
    assert.match(t.message, /désactivée/);
    await adminB.ok('PUT', '/api/sauvegardes-avancees/parametres', { accepterReception: true });
    assert.equal((await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${destServeur.id}/tester`)).ok, true);
  });

  test('envoi : redirection refusée, serveur injoignable', async () => {
    const leurre = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); });
    await new Promise((r) => leurre.listen(0, '127.0.0.1', r));
    const port = leurre.address().port;
    try {
      const d = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Serveur redirigé', type: 'serveur', url: `http://127.0.0.1:${port}`, cle: 'gmao_cle-quelconque-0123456789' });
      const t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.ok, false);
      assert.match(t.message, /Redirection refusée/);
      await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${d.id}`, { url: 'http://127.0.0.1:1' });
      const t2 = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t2.ok, false);
      assert.match(t2.message, /Connexion refusée/);
      await adminA.ok('DELETE', `/api/sauvegardes-avancees/destinations/${d.id}`);
      assert.equal((await adminA.get(`/api/sauvegardes-avancees/destinations/${d.id}/fichiers`)).status, 404);
    } finally { await new Promise((r) => leurre.close(r)); }
  });

  test('restauration d\'une sauvegarde reçue d\'un autre site (avec le mot de passe de cet autre site)', async () => {
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destServeur.id });
    assert.equal(ex.ok, true);
    let r = await adminB.post('/api/sauvegardes-avancees/restaurer', { source: 'recue', site: 'Usine-de-Carpentras', fichier: ex.fichier });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /chiffrée/);
    r = await adminB.post('/api/sauvegardes-avancees/restaurer', { source: 'recue', fichier: 'Usine-de-Carpentras/' + ex.fichier, motDePasse: MDP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'Usine de Carpentras');
    assert.ok(B.db.findOne('fournisseurs', (f) => f.nom === 'Fournisseur témoin avant sauvegarde'), 'données de Carpentras restaurées sur ce serveur');
    // Les paramètres de réception de Valréas sont conservés : Carpentras peut toujours y envoyer
    assert.equal(B.db.getConfig().sauvegardes.accepterReception, true);
    assert.equal((await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${destServeur.id}/tester`)).ok, true);
    // Suppression d'une sauvegarde reçue
    await adminB.ok('DELETE', `/api/sauvegardes-avancees/recues/Usine-de-Carpentras/${encodeURIComponent(ex.fichier)}`);
    assert.equal(fs.existsSync(path.join(B.dataDir, 'backups', 'recus', 'Usine-de-Carpentras', ex.fichier)), false);
    assert.equal((await adminB.del('/api/sauvegardes-avancees/recues/..%2F..%2F/gmao.json')).status, 400, 'traversée de chemin refusée');
    assert.equal((await adminB.del('/api/sauvegardes-avancees/recues/Usine-de-Carpentras/gmao.json')).status, 400);
  });

  test('restauration depuis un fichier téléversé (clé USB, copie récupérée chez un autre site)', async () => {
    const buf = fs.readFileSync(path.join(dossierD, fichierChiffre));
    let r = await adminA.call('POST', '/api/sauvegardes-avancees/restaurer-fichier', undefined, { brut: buf, sansCsrf: true });
    assert.equal(r.status, 403, 'en-tête anti-CSRF obligatoire');
    r = await adminA.call('POST', '/api/sauvegardes-avancees/restaurer-fichier', undefined, { brut: buf, headers: { 'x-gmao-fichier': encodeURIComponent(fichierChiffre), 'x-gmao-mot-de-passe': encodeURIComponent('faux mot de passe') } });
    assert.equal(r.status, 400);
    r = await adminA.call('POST', '/api/sauvegardes-avancees/restaurer-fichier', undefined, { brut: Buffer.from('ceci n\'est pas une sauvegarde') });
    assert.equal(r.status, 400);
    r = await adminA.call('POST', '/api/sauvegardes-avancees/restaurer-fichier', undefined, { brut: buf, headers: { 'x-gmao-fichier': encodeURIComponent(fichierChiffre), 'x-gmao-mot-de-passe': encodeURIComponent(MDP), 'x-gmao-sha256': sha256(buf) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.empreinteVerifiee, true);
    assert.equal(r.body.origine, 'fichier téléversé');
    assert.equal((await adminA.get('/api/sauvegardes-avancees')).status, 200, 'session conservée');
  });

  test('les secrets ne sont jamais renvoyés (configuration, amorçage, sauvegardes avancées) ni modifiables par la configuration générale', async () => {
    const secrets = [MDP, cleB, B.db.getConfig().sauvegardes.cleReception.slice(7), 'gmao_mauvaise-cle-de-reception-xyz'];
    for (const [c, url] of [[adminA, '/api/configuration'], [adminA, '/api/auth/me'], [adminA, '/api/sauvegardes-avancees'], [adminB, '/api/configuration'], [adminB, '/api/auth/me'], [adminB, '/api/sauvegardes-avancees']]) {
      const txt = JSON.stringify(await c.ok('GET', url));
      for (const s of secrets) assert.equal(txt.includes(s), false, `${url} expose un secret`);
    }
    const conf = await adminA.ok('GET', '/api/configuration');
    assert.equal(conf.sauvegardes.destinations, undefined);
    assert.equal(conf.sauvegardes.motDePasseChiffrement, undefined);
    await adminA.ok('PUT', '/api/configuration', { sauvegardes: { destinations: [], motDePasseChiffrement: 'pirate', cleReception: 'pirate' } });
    const s = A.db.getConfig().sauvegardes;
    assert.equal(s.motDePasseChiffrement, MDP);
    assert.ok(s.destinations.length >= 2);
    // Aucun secret dans les fichiers de sauvegarde produits
    const { decoder } = require('../server/modules/sauvegardes');
    const dec = await decoder(fs.readFileSync(path.join(dossierD, fichierChiffre)), MDP);
    const txt = JSON.stringify(dec.data);
    for (const x of [MDP, cleB]) assert.equal(txt.includes(x), false);
  });

  test('droits : Configuration › Modifier et Système › Modifier requis pour agir, Voir pour consulter', async () => {
    const profils = await adminA.ok('GET', '/api/profils');
    const lecteur = await adminA.ok('POST', '/api/profils', { nom: 'Auditeur informatique', niveau: 2, portee: 'tous', permissions: { configuration: { voir: true }, systeme: { voir: true } } });
    const configSeule = await adminA.ok('POST', '/api/profils', { nom: 'Paramétreur', niveau: 2, portee: 'tous', permissions: { configuration: { voir: true, modifier: true } } });
    const mk = async (login, profilId, extra = {}) => {
      await adminA.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, profilId, password: 'pass1234', doitChangerMdp: false }, extra));
      const c = client(A); await c.login(login, 'pass1234'); return c;
    };
    const lec = await mk('auditeur', lecteur.id);
    const cfg = await mk('parametreur', configSeule.id);
    const rm = await mk('respmaint', profils.find((p) => p.nom === 'Responsable maintenance').id);
    const info = await mk('pole-info', profils.find((p) => p.nom === 'Pôle informatique').id);

    const g = await lec.ok('GET', '/api/sauvegardes-avancees');
    assert.equal(g.droits.modifier, false);
    assert.equal((await lec.get(`/api/sauvegardes-avancees/destinations/${destD.id}/fichiers`)).status, 200);
    const actions = [
      ['POST', '/api/sauvegardes-avancees/destinations', { nom: 'Y', type: 'dossier', chemin: dossierD }],
      ['PUT', `/api/sauvegardes-avancees/destinations/${destD.id}`, { nom: 'Z' }],
      ['DELETE', `/api/sauvegardes-avancees/destinations/${destD.id}`],
      ['POST', `/api/sauvegardes-avancees/destinations/${destD.id}/tester`, {}],
      ['POST', '/api/sauvegardes-avancees/executer', {}],
      ['PUT', '/api/sauvegardes-avancees/parametres', { automatique: false }],
      ['POST', '/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: fichierChiffre }],
      ['POST', '/api/sauvegardes-avancees/cle-reception/generer', {}],
      ['DELETE', '/api/sauvegardes-avancees/cle-reception'],
      ['GET', `/api/sauvegardes-avancees/telecharger?source=destination&destinationId=${destD.id}&fichier=${fichierChiffre}`],
    ];
    for (const [m, u, b] of actions) {
      assert.equal((await lec.call(m, u, b)).status, 403, `${m} ${u} sans Configuration › Modifier`);
      assert.equal((await cfg.call(m, u, b)).status, 403, `${m} ${u} sans Système › Modifier`);
    }
    assert.equal((await rm.get('/api/sauvegardes-avancees')).status, 403, 'responsable maintenance : pas d\'accès au système');
    assert.equal((await cfg.get('/api/sauvegardes-avancees')).status, 403, 'Système › Voir requis');
    const sansSession = await fetch(A.base + '/api/sauvegardes-avancees');
    assert.equal(sansSession.status, 401);
    // Le pôle informatique gère les sauvegardes
    const d = await info.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS informatique', type: 'dossier', chemin: dossierTemp('gmao-nas-') });
    await info.ok('DELETE', `/api/sauvegardes-avancees/destinations/${d.id}`);
    assert.equal(A.db.getConfig().sauvegardes.destinations.some((x) => x.id === destD.id), true, 'aucune action refusée n\'a été appliquée');
  });

  test('multi-site : portée par site, lecture seule (403), en-tête X-GMAO-Site', async () => {
    siteB = await adminA.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    const prodB = await adminA.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: siteB.id });
    dossierV = dossierTemp('gmao-val-');
    dossierC = dossierTemp('gmao-carp-');
    destV = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS de Valréas', type: 'dossier', chemin: dossierV, secteurId: siteB.id });
    destC = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS de Carpentras', type: 'dossier', chemin: dossierC, secteurId: prodA.id });
    const profil = await adminA.ok('POST', '/api/profils', { nom: 'Informatique de site', niveau: 2, portee: 'site', permissions: { configuration: { voir: true, modifier: true }, systeme: { voir: true, modifier: true } } });
    await adminA.ok('POST', '/api/utilisateurs', { login: 'infocarp', nom: 'Info Carpentras', profilId: profil.id, secteurIds: [prodA.id], password: 'pass1234', doitChangerMdp: false });
    await adminA.ok('POST', '/api/utilisateurs', { login: 'infolect', nom: 'Info lecture', profilId: profil.id, secteurIds: [prodA.id], siteAcces: [{ siteId: siteB.id, mode: 'lecture' }], password: 'pass1234', doitChangerMdp: false });
    uC = client(A); await uC.login('infocarp', 'pass1234');
    uL = client(A); await uL.login('infolect', 'pass1234');

    // Site 1 uniquement : la destination de Valréas est invisible
    let g = await uC.ok('GET', '/api/sauvegardes-avancees');
    const ids = g.destinations.map((d) => d.id);
    assert.ok(ids.includes(destC.id) && ids.includes(destD.id));
    assert.ok(!ids.includes(destV.id), 'destination du site 2 invisible');
    assert.ok(ids.includes(destServeur.id), 'destination commune visible');
    assert.equal(g.droits.global, false);
    assert.equal(g.droits.restaurer, false);
    assert.equal((await uC.get(`/api/sauvegardes-avancees/destinations/${destV.id}/fichiers`)).status, 404);
    assert.equal((await uC.post(`/api/sauvegardes-avancees/destinations/${destV.id}/tester`)).status, 404);
    // La gestion des destinations (création, modification, suppression) est réservée aux accès globaux :
    // chaque sauvegarde contient la base complète de tous les sites
    assert.equal(g.droits.destinations, false);
    for (const [m, u, b] of [
      ['PUT', `/api/sauvegardes-avancees/destinations/${destV.id}`, { nom: 'Piratée' }],
      ['POST', '/api/sauvegardes-avancees/destinations', { nom: 'Chez Valréas', type: 'dossier', chemin: dossierV, secteurId: siteB.id }],
      ['POST', '/api/sauvegardes-avancees/destinations', { nom: 'Commune', type: 'dossier', chemin: dossierC }],
      ['POST', '/api/sauvegardes-avancees/destinations', { nom: 'Sur mon site', type: 'dossier', chemin: dossierC, secteurId: prodA.id }],
      ['PUT', `/api/sauvegardes-avancees/destinations/${destServeur.id}`, { conserver: 3 }],
      ['PUT', `/api/sauvegardes-avancees/destinations/${destC.id}`, { conserver: 4 }],
      ['DELETE', `/api/sauvegardes-avancees/destinations/${destC.id}`],
    ]) {
      const r = await uC.call(m, u, b);
      assert.equal(r.status, 403, `${m} ${u} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.erreur, /base complète/);
    }
    assert.ok((await adminA.ok('GET', '/api/sauvegardes-avancees')).destinations.some((d) => d.id === destC.id && d.conserver === 10), 'rien n\'a été modifié');
    // Opérations globales refusées
    assert.equal((await uC.put('/api/sauvegardes-avancees/parametres', { automatique: false })).status, 403);
    assert.equal((await uC.post('/api/sauvegardes-avancees/cle-reception/generer')).status, 403);
    assert.equal((await uC.post('/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destC.id, fichier: 'gmao-CARP-20260101-000000.json.gz' })).status, 403);
    // Sauvegarde : uniquement vers ses destinations (ni Valréas, ni destination commune, ni copie locale)
    const ex = await uC.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.deepEqual(ex.resultats.map((r) => r.destinationId).sort(), [destC.id, destD.id].sort());
    assert.equal(ex.local, null);
    assert.equal(fs.readdirSync(dossierV).length, 0);
    assert.equal((await uC.post('/api/sauvegardes-avancees/executer', { destinationId: destV.id })).status, 404);
    // L'historique ne montre pas les résultats des destinations de Valréas
    await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destV.id });
    g = await uC.ok('GET', '/api/sauvegardes-avancees');
    assert.ok(g.historique.every((h) => !(h.resultats || []).some((r) => r.destinationId === destV.id)));
    const gAdmin = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.ok(gAdmin.historique.some((h) => (h.resultats || []).some((r) => r.destinationId === destV.id)));

    // Accès en lecture seule au site 2 : visible, non modifiable
    g = await uL.ok('GET', '/api/sauvegardes-avancees');
    assert.ok(g.destinations.some((d) => d.id === destV.id));
    assert.equal((await uL.get(`/api/sauvegardes-avancees/destinations/${destV.id}/fichiers`)).status, 200);
    assert.equal((await uL.put(`/api/sauvegardes-avancees/destinations/${destV.id}`, { nom: 'Modifiée' })).status, 403);
    assert.equal((await uL.del(`/api/sauvegardes-avancees/destinations/${destV.id}`)).status, 403);
    const refus = await uL.post(`/api/sauvegardes-avancees/destinations/${destV.id}/tester`);
    assert.equal(refus.status, 403);
    assert.match(refus.body.erreur, /lecture seule/);
    assert.equal((await uL.post('/api/sauvegardes-avancees/executer', { destinationId: destV.id })).status, 403);
    assert.equal(A.db.getConfig().sauvegardes.destinations.find((d) => d.id === destV.id).nom, 'NAS de Valréas');

    // En-tête X-GMAO-Site : l'administrateur ne voit que le site choisi (et les destinations communes)
    const adminSite = client(A); await adminSite.login('admin', 'admin');
    adminSite.setSite(siteB.id);
    g = await adminSite.ok('GET', '/api/sauvegardes-avancees');
    const vus = g.destinations.map((d) => d.id);
    assert.ok(vus.includes(destV.id) && vus.includes(destServeur.id));
    assert.ok(!vus.includes(destC.id) && !vus.includes(destD.id), 'destinations de Carpentras filtrées');
    assert.equal((await adminSite.put(`/api/sauvegardes-avancees/destinations/${destC.id}`, { conserver: 6 })).status, 404);
    adminSite.setSite(siteA.id);
    assert.ok((await adminSite.ok('GET', '/api/sauvegardes-avancees')).destinations.some((d) => d.id === destC.id));
    void prodB;
  });

  test('sécurité multi-site : un accès limité à son site ne peut ni créer ni rediriger une destination (la base complète ne sort pas du périmètre)', async () => {
    const leurre = await serveurLeurre();
    try {
      const r = await uC.post('/api/sauvegardes-avancees/destinations', { nom: 'Mon serveur', type: 'serveur', url: leurre.url, cle: 'gmao_cle-quelconque-0123456789', secteurId: prodA.id });
      assert.equal(r.status, 403);
      assert.match(r.body.erreur, /base complète/);
      assert.equal((await uC.put(`/api/sauvegardes-avancees/destinations/${destC.id}`, { chemin: dossierTemp('gmao-exfil-') })).status, 403, 'ni rediriger une destination existante de son site');
      assert.equal((await uC.put(`/api/sauvegardes-avancees/destinations/${destC.id}`, { type: 'serveur', url: leurre.url, cle: 'gmao_cle-quelconque-0123456789' })).status, 403);
      assert.equal(leurre.recus.length, 0, 'rien n\'a été envoyé au serveur choisi par l\'utilisateur');
      assert.equal(A.db.getConfig().sauvegardes.destinations.find((d) => d.id === destC.id).chemin, dossierC);
      // Il peut toujours tester et utiliser les destinations de son site mises en place par le pôle informatique
      assert.equal((await uC.ok('POST', `/api/sauvegardes-avancees/destinations/${destC.id}/tester`)).ok, true);
      const ex = await uC.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destC.id });
      assert.equal(ex.ok, true);
      assert.equal(ex.complete, false);
    } finally { await leurre.fermer(); }
  });

  test('sélecteur de site : une sauvegarde limitée à un site n\'est pas une exécution complète (planification et compteur d\'échecs inchangés)', async () => {
    const fichierKo = path.join(dossierTemp('gmao-ko-'), 'pas-un-dossier');
    fs.writeFileSync(fichierKo, 'x');
    const ko = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS Carpentras en panne', type: 'dossier', chemin: fichierKo + '/x', secteurId: prodA.id });
    const svc = A.ctx.services.sauvegardes;
    const auto = await svc.executer({ declencheur: 'automatique' });
    assert.equal(auto.ok, false);
    assert.equal(auto.complete, true);
    let s = A.db.getConfig().sauvegardes;
    const echecs = s.echecsConsecutifs;
    assert.ok(echecs >= 1);
    assert.equal(svc.estDue(s, new Date(Date.now() + 61 * 60000)), true, 'nouvel essai prévu une heure plus tard');
    // L'administrateur, sélecteur de site sur Valréas, lance « Sauvegarder maintenant vers toutes les destinations »
    const adminSite = client(A); await adminSite.login('admin', 'admin');
    adminSite.setSite(siteB.id);
    const ex = await adminSite.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.equal(ex.ok, true);
    assert.equal(ex.complete, false);
    assert.ok(!ex.resultats.some((r) => r.destinationId === ko.id), 'la destination de Carpentras n\'est pas tentée');
    s = A.db.getConfig().sauvegardes;
    assert.equal(s.echecsConsecutifs, echecs, 'compteur d\'échecs inchangé');
    assert.equal(s.derniereExecution.ok, false, 'la dernière exécution complète reste en échec');
    assert.equal(svc.estDue(s, new Date(Date.now() + 61 * 60000)), true, 'le nouvel essai automatique reste prévu');
    const h = (await adminA.ok('GET', '/api/sauvegardes-avancees')).historique.find((x) => x.id === ex.historiqueId);
    assert.equal(h.complete, false);
    assert.equal(h.siteCourantId, siteB.id);
    assert.ok(A.db.list('audit').some((a) => a.entite === 'sauvegardes' && /site sélectionné uniquement/.test(a.details)));
    await adminA.ok('DELETE', `/api/sauvegardes-avancees/destinations/${ko.id}`);
  });

  test('« rien à sauvegarder » : messages adaptés au périmètre (accès limité, site sélectionné)', async () => {
    const S = await lancer({ memoire: true });
    try {
      const adm = client(S); await adm.login('admin', 'admin');
      const sec = await adm.ok('GET', '/api/secteurs');
      const site1 = sec.find((s) => s.code === 'SITE');
      const val = await adm.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
      const profil = await adm.ok('POST', '/api/profils', { nom: 'Informatique de site', niveau: 2, portee: 'site', permissions: { systeme: { voir: true, modifier: true } } });
      await adm.ok('POST', '/api/utilisateurs', { login: 'infoval', nom: 'Info Valréas', profilId: profil.id, secteurIds: [val.id], password: 'pass1234', doitChangerMdp: false });
      const u = client(S); await u.login('infoval', 'pass1234');
      let r = await u.post('/api/sauvegardes-avancees/executer', {});
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /demandez l'ajout/);
      await adm.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS Carpentras', type: 'dossier', chemin: dossierTemp('gmao-msg-'), secteurId: site1.id });
      r = await u.post('/api/sauvegardes-avancees/executer', {});
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /votre périmètre/);
      adm.setSite(val.id);
      r = await adm.post('/api/sauvegardes-avancees/executer', {});
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /site sélectionné/);
      adm.setSite(null);
      assert.equal((await adm.ok('POST', '/api/sauvegardes-avancees/executer', {})).ok, true);
    } finally { await S.app.stop(); }
  });

  test('notifications d\'échec : chaque destinataire ne voit que les destinations de son périmètre ; origine d\'une restauration masquée', async () => {
    const fichierKo = path.join(dossierTemp('gmao-ko2-'), 'pas-un-dossier');
    fs.writeFileSync(fichierKo, 'x');
    const d = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS confidentiel de Valréas', type: 'dossier', chemin: fichierKo + '/x', secteurId: siteB.id });
    assert.equal((await uC.get(`/api/sauvegardes-avancees/destinations/${d.id}/fichiers`)).status, 404, 'destination invisible pour l\'informaticien de Carpentras');
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.equal(ex.ok, false);
    const nC = (await uC.ok('GET', '/api/notifications')).notifications;
    assert.ok(!nC.some((n) => /NAS confidentiel/.test(n.message)), 'le nom de la destination d\'un autre site n\'apparaît pas');
    assert.ok(nC.some((n) => /destination d'un autre site en échec/.test(n.message)), JSON.stringify(nC.slice(0, 2)));
    const nA = (await adminA.ok('GET', '/api/notifications')).notifications;
    assert.ok(nA.some((n) => /NAS confidentiel de Valréas : /.test(n.message)), 'l\'administrateur reçoit le détail');
    // Origine d'une restauration : masquée pour un accès non global
    const resto = (await uC.ok('GET', '/api/sauvegardes-avancees')).historique.filter((h) => h.type === 'restauration');
    assert.ok(resto.length);
    assert.ok(resto.every((h) => ['destination de sauvegarde', 'sauvegarde reçue d\'un autre site', 'fichier téléversé', 'copie locale'].includes(h.origine)), JSON.stringify(resto.map((h) => h.origine)));
    assert.ok((await adminA.ok('GET', '/api/sauvegardes-avancees')).historique.some((h) => h.type === 'restauration' && /Disque D/.test(h.origine)));
    await adminA.ok('DELETE', `/api/sauvegardes-avancees/destinations/${d.id}`);
  });

  test('planification : essais limités par cycle (compteur repris à chaque échéance), fréquences de plusieurs jours en jours entiers', async () => {
    const svc = A.ctx.services.sauvegardes;
    const le = (j, h, m, s = 0) => new Date(2026, 9, j, h, m, s);
    const base = { automatique: true, frequenceHeures: 24, heure: '22:00' };
    // Quatre échecs consécutifs (créneau du 15 en échec) mais un seul essai dans le cycle : nouvel essai une heure plus tard
    const jour15 = Object.assign({}, base, { derniereExecution: { date: le(15, 22, 0).toISOString(), ok: false }, echecsConsecutifs: 4, essaisCycle: 1 });
    assert.equal(svc.estDue(jour15, le(15, 23, 5)), true);
    assert.equal(svc.prochaineExecution(jour15).getTime(), le(15, 23, 0).getTime());
    assert.equal(svc.estDue(Object.assign({}, jour15, { essaisCycle: 3 }), le(15, 23, 5)), false, 'trois essais dans le cycle : on attend le créneau suivant');
    assert.equal(svc.prochaineExecution(Object.assign({}, jour15, { essaisCycle: 3 })).getTime(), le(16, 22, 0).getTime());
    assert.equal(svc.estDue(Object.assign({}, jour15, { essaisCycle: 3 }), le(16, 22, 1)), true, 'le créneau suivant relance un cycle');
    // Fréquence intermédiaire refusée (jours entiers) ; une ancienne valeur est arrondie au jour supérieur
    const r = await adminA.put('/api/sauvegardes-avancees/parametres', { frequenceHeures: 36 });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /jours/);
    const f36 = Object.assign({}, base, { frequenceHeures: 36, derniereExecution: { date: le(14, 22, 0).toISOString(), ok: true } });
    assert.equal(svc.estDue(f36, le(15, 22, 1)), false);
    assert.equal(svc.estDue(f36, le(16, 22, 1)), true);
    assert.equal(svc.prochaineExecution(f36).getTime(), le(16, 22, 0).getTime());
    assert.equal((await adminA.ok('PUT', '/api/sauvegardes-avancees/parametres', { frequenceHeures: 72 })).frequenceHeures, 72);
    await adminA.ok('PUT', '/api/sauvegardes-avancees/parametres', { frequenceHeures: 24 });
    // Cycle réel : échéance planifiée en échec, trois essais horaires au plus, puis reprise au créneau suivant
    const S = await lancer();
    try {
      const adm = client(S); await adm.login('admin', 'admin');
      const fichierKo = path.join(dossierTemp('gmao-ko3-'), 'pas-un-dossier');
      fs.writeFileSync(fichierKo, 'x');
      await adm.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'NAS en panne', type: 'dossier', chemin: fichierKo + '/x' });
      await adm.ok('PUT', '/api/sauvegardes-avancees/parametres', { conserverLocal: 0 });
      const svc2 = S.ctx.services.sauvegardes;
      const reculer = (ms) => { const cfg = S.db.getConfig(); cfg.sauvegardes.derniereExecution.date = new Date(new Date(cfg.sauvegardes.derniereExecution.date).getTime() - ms).toISOString(); S.db.setConfig(cfg); };
      const etat = () => { const s = S.db.getConfig().sauvegardes; return [s.echecsConsecutifs, s.essaisCycle]; };
      assert.equal(await svc2.verifierPlanification(new Date()), true, 'première échéance');
      assert.deepEqual(etat(), [1, 1]);
      for (let i = 2; i <= 3; i++) { reculer(61 * 60000); assert.equal(await svc2.verifierPlanification(new Date()), true, `essai ${i}`); assert.deepEqual(etat(), [i, i]); }
      reculer(61 * 60000);
      assert.equal(await svc2.verifierPlanification(new Date()), false, 'plus d\'essai avant le créneau suivant');
      assert.deepEqual(etat(), [3, 3]);
      reculer(25 * 3600000);
      assert.equal(await svc2.verifierPlanification(new Date()), true, 'créneau suivant : nouveau cycle');
      assert.deepEqual(etat(), [4, 1], 'échecs consécutifs cumulés, essais du cycle repris à 1');
      reculer(61 * 60000);
      assert.equal(await svc2.verifierPlanification(new Date()), true, 'nouvel essai possible malgré quatre échecs consécutifs');
    } finally { await S.app.stop(); }
  });

  test('copie dans un dossier : le fichier écrit est relu et son empreinte vérifiée (écriture incomplète signalée, fichier supprimé)', async () => {
    const dir = dossierTemp('gmao-usb-');
    const d = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Clé USB défaillante', type: 'dossier', chemin: dir });
    const original = fs.writeFileSync;
    // Support défaillant simulé : le fichier temporaire est tronqué à 10 octets
    fs.writeFileSync = function (f, contenu, ...reste) {
      if (typeof f === 'string' && f.startsWith(dir) && /\.tmp$/.test(f) && Buffer.isBuffer(contenu)) return original.call(fs, f, contenu.subarray(0, 10), ...reste);
      return original.call(fs, f, contenu, ...reste);
    };
    let ex;
    try { ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id }); } finally { fs.writeFileSync = original; }
    assert.equal(ex.ok, false);
    assert.match(ex.resultats[0].message, /relecture/);
    assert.equal(fs.readdirSync(dir).filter((n) => RE_NOM.test(n) || n.endsWith('.sha256')).length, 0, 'fichier tronqué et empreinte supprimés');
    const ok = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id });
    assert.equal(ok.ok, true);
    assert.match(ok.resultats[0].message, /empreinte vérifiée après relecture/);
    assert.equal(sha256(fs.readFileSync(path.join(dir, ok.fichier))), ok.sha256);
    await adminA.ok('DELETE', `/api/sauvegardes-avancees/destinations/${d.id}`);
  });

  test('copies locales : l\'état précédent copié avant une restauration est listé et restaurable (retour en arrière)', async () => {
    const temoin = A.db.insert('fournisseurs', { nom: 'Fournisseur avant retour en arrière', actif: true });
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destD.id });
    A.db.remove('fournisseurs', temoin.id);
    const r1 = await adminA.ok('POST', '/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: ex.fichier });
    assert.ok(A.db.get('fournisseurs', temoin.id), 'restauration : le fournisseur est revenu');
    assert.match(r1.copieAvant, /^gmao-avant-import-/);
    const copie = (await adminA.ok('GET', '/api/sauvegardes-avancees')).locales.find((f) => f.nom === r1.copieAvant);
    assert.ok(copie, 'copie de l\'état précédent listée dans les copies locales');
    assert.equal(copie.etatPrecedent, 'import');
    assert.equal(copie.chiffre, false);
    assert.ok(copie.taille > 0 && copie.date);
    const dl = await adminA.call('GET', `/api/sauvegardes-avancees/telecharger?source=locale&fichier=${encodeURIComponent(r1.copieAvant)}`);
    assert.equal(dl.status, 200);
    const r2 = await adminA.ok('POST', '/api/sauvegardes-avancees/restaurer', { source: 'locale', fichier: r1.copieAvant });
    assert.match(r2.origine, /état précédent/);
    assert.ok(!A.db.get('fournisseurs', temoin.id), 'retour à l\'état qui précédait la restauration');
    assert.equal((await adminA.ok('GET', '/api/sauvegardes-avancees')).historique[0].origine, r2.origine);
    // Ce nom n'est accepté que pour le dossier local du serveur
    assert.equal((await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: destD.id, fichier: r1.copieAvant })).status, 400);
    assert.equal((await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'recue', site: 'Usine-de-Carpentras', fichier: r1.copieAvant })).status, 400);
    assert.equal((await adminA.post('/api/sauvegardes-avancees/restaurer', { source: 'locale', fichier: 'gmao-avant-import-2026-01-01T00-00-00-000Z.json' })).status, 404);
  });

  test('réplication HTTPS (application de bureau) : adresses https://, empreinte du certificat confirmée puis vérifiée avant tout envoi, bascule http → https proposée', async () => {
    const certB = tlsGmao.genererCertificat({ nomPoste: 'srv-valreas' });
    const H = await lancerHttps(certB);
    let H2 = null;
    let hFerme = false;
    try {
      const b = clientHttps(H.port); await b.login('admin', 'admin');
      const gB = await b.ok('GET', '/api/sauvegardes-avancees');
      assert.equal(gB.serveur.protocole, 'https');
      assert.equal(gB.serveur.empreinte, certB.empreinte);
      assert.ok(gB.serveur.adresses.length && gB.serveur.adresses.every((a) => /^https:\/\//.test(a)), gB.serveur.adresses.join(', '));
      const cle = (await b.ok('POST', '/api/sauvegardes-avancees/cle-reception/generer')).cle;
      await b.ok('PUT', '/api/sauvegardes-avancees/parametres', { accepterReception: true });
      // Adresse http:// : la redirection vers https:// est signalée avec l'adresse à utiliser
      const d = await adminA.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Valréas (HTTPS)', type: 'serveur', url: `http://127.0.0.1:${H.port}`, cle });
      let t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.ok, false);
      assert.equal(t.code, 'REDIRECTION_HTTPS');
      assert.equal(t.adresseHttps, `https://127.0.0.1:${H.port}`);
      // Adresse https:// sans empreinte confirmée : rien n'est envoyé, l'empreinte présentée est renvoyée
      await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${d.id}`, { url: t.adresseHttps });
      t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.ok, false);
      assert.equal(t.code, 'EMPREINTE_NON_CONFIRMEE');
      assert.equal(t.empreintePresentee, certB.empreinte);
      assert.match(t.message, /non confirmé/);
      const ex0 = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id });
      assert.equal(ex0.ok, false);
      assert.match(ex0.resultats[0].message, /non confirmé/);
      // Empreinte invalide refusée ; empreinte d'un autre certificat : différence détectée, rien n'est envoyé
      assert.equal((await adminA.put(`/api/sauvegardes-avancees/destinations/${d.id}`, { empreinte: 'pas-une-empreinte' })).status, 400);
      const autre = tlsGmao.genererCertificat({ nomPoste: 'usurpateur' });
      await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${d.id}`, { empreinte: autre.empreinte });
      t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.code, 'EMPREINTE_DIFFERENTE');
      assert.equal(t.empreintePresentee, certB.empreinte);
      assert.equal(H.db.count('sauvegardesHistorique'), 0, 'aucune requête reçue par le serveur distant : la clé n\'a jamais été envoyée');
      assert.ok(H.db.list('audit').every((a) => a.action !== 'refus' && a.action !== 'reception'));
      // Empreinte confirmée (saisie en minuscules sans séparateurs : normalisée), puis test, envoi et liste des fichiers
      const pub = await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${d.id}`, { empreinte: certB.empreinte.replace(/:/g, '').toLowerCase() });
      assert.equal(pub.empreinte, certB.empreinte);
      t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.ok, true, t.message);
      assert.match(t.message, /certificat HTTPS vérifié/);
      assert.equal(A.db.getConfig().sauvegardes.destinations.find((x) => x.id === d.id).empreinteCle, certB.empreinteCle, 'empreinte de la clé mémorisée');
      const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id });
      assert.equal(ex.ok, true, JSON.stringify(ex.resultats));
      assert.match(ex.resultats[0].message, /connexion chiffrée/);
      assert.ok(fs.existsSync(path.join(H.dataDir, 'backups', 'recus', 'Usine-de-Carpentras', ex.fichier)));
      assert.ok((await adminA.ok('GET', `/api/sauvegardes-avancees/destinations/${d.id}/fichiers`)).fichiers.some((f) => f.nom === ex.fichier));
      // Certificat renouvelé avec la même clé (poste serveur redémarré) : reconnu, nouvelle empreinte suivie ; autre clé : refusée
      const renouvele = tlsGmao.genererCertificat({ nomPoste: 'srv-valreas', cle: certB.cle });
      await H.stop(); hFerme = true;
      H2 = await lancerHttps(renouvele, H.dataDir);
      await adminA.ok('PUT', `/api/sauvegardes-avancees/destinations/${d.id}`, { url: `https://127.0.0.1:${H2.port}` });
      t = await adminA.ok('POST', `/api/sauvegardes-avancees/destinations/${d.id}/tester`);
      assert.equal(t.ok, true, t.message);
      assert.equal(A.db.getConfig().sauvegardes.destinations.find((x) => x.id === d.id).empreinte, renouvele.empreinte, 'empreinte du certificat renouvelé mémorisée');
      await adminA.ok('DELETE', `/api/sauvegardes-avancees/destinations/${d.id}`);
    } finally {
      if (!hFerme) await H.stop();
      if (H2) await H2.stop();
    }
  });

  test('planification : échéance quotidienne, fréquence en heures, nouvel essai après échec', async () => {
    const svc = A.ctx.services.sauvegardes;
    const le = (j, h, m, s = 0) => new Date(2026, 9, j, h, m, s);
    const base = { automatique: true, frequenceHeures: 24, heure: '22:00' };
    assert.equal(svc.estDue(Object.assign({}, base, { automatique: false }), le(14, 23, 0)), false);
    assert.equal(svc.estDue(base, le(14, 10, 0)), true, 'jamais exécutée');
    const quotidien = Object.assign({}, base, { derniereExecution: { date: le(14, 22, 0, 5).toISOString(), ok: true } });
    assert.equal(svc.estDue(quotidien, le(15, 21, 59)), false);
    assert.equal(svc.estDue(quotidien, le(15, 22, 1)), true);
    assert.equal(svc.prochaineExecution(quotidien).getTime(), le(15, 22, 0).getTime());
    const rattrapage = Object.assign({}, base, { derniereExecution: { date: le(13, 22, 0, 5).toISOString(), ok: true } });
    assert.equal(svc.estDue(rattrapage, le(15, 8, 0)), true, 'serveur arrêté au créneau : rattrapage au démarrage');
    const deuxJours = Object.assign({}, base, { frequenceHeures: 48, derniereExecution: { date: le(14, 22, 0, 5).toISOString(), ok: true } });
    assert.equal(svc.estDue(deuxJours, le(15, 22, 10)), false);
    assert.equal(svc.estDue(deuxJours, le(16, 22, 10)), true);
    assert.equal(svc.prochaineExecution(deuxJours).getTime(), le(16, 22, 0).getTime());
    const sixHeures = Object.assign({}, base, { frequenceHeures: 6, derniereExecution: { date: le(14, 6, 0).toISOString(), ok: true } });
    assert.equal(svc.estDue(sixHeures, le(14, 11, 0)), false);
    assert.equal(svc.estDue(sixHeures, le(14, 12, 0)), true);
    const echec = Object.assign({}, base, { derniereExecution: { date: le(14, 22, 0, 5).toISOString(), ok: false }, echecsConsecutifs: 1 });
    assert.equal(svc.estDue(echec, le(14, 22, 30)), false);
    assert.equal(svc.estDue(echec, le(14, 23, 1)), true, 'nouvel essai une heure plus tard');
    assert.equal(svc.estDue(Object.assign({}, echec, { echecsConsecutifs: 3 }), le(14, 23, 1)), false, 'au plus 3 essais');

    // Déclenchement réel par la planification
    const cfg = A.db.getConfig();
    cfg.sauvegardes.automatique = true;
    cfg.sauvegardes.derniereExecution = { date: new Date(Date.now() - 3 * 86400000).toISOString(), ok: true };
    cfg.sauvegardes.echecsConsecutifs = 0;
    A.db.setConfig(cfg);
    assert.equal(await svc.verifierPlanification(new Date()), true);
    const h = A.db.list('sauvegardesHistorique').sort((a, b) => b.id - a.id)[0];
    assert.equal(h.declencheur, 'automatique');
    assert.equal(h.userId, null);
    assert.equal(await svc.verifierPlanification(new Date()), false, 'rien de plus avant la prochaine échéance');
    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.ok(g.parametres.prochaineExecution && new Date(g.parametres.prochaineExecution) > new Date());
  });

  test('historique : 500 entrées au plus, 50 dernières renvoyées', async () => {
    for (let i = 0; i < 520; i++) A.db.insert('sauvegardesHistorique', { type: 'sauvegarde', ok: true, message: 'ancienne ' + i, date: new Date(Date.now() - (600 - i) * 3600000).toISOString(), resultats: [], local: null });
    await adminA.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: destD.id });
    assert.ok(A.db.count('sauvegardesHistorique') <= 500);
    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    assert.equal(g.historique.length, 50);
    assert.ok(g.historique[0].id > g.historique[1].id, 'plus récentes d\'abord');
  });

  test('données de démonstration idempotentes (destinations d\'exemple désactivées, clés masquées)', async () => {
    const r1 = seedDemo(A.ctx);
    assert.match(r1, /3 destinations/);
    assert.equal(seedDemo(A.ctx), 'déjà présentes');
    const g = await adminA.ok('GET', '/api/sauvegardes-avancees');
    const demo = g.destinations.filter((d) => d.demo);
    assert.equal(demo.length, 3);
    assert.ok(demo.every((d) => d.actif === false));
    const val = demo.find((d) => d.type === 'serveur');
    assert.equal(val.cleDefinie, true);
    assert.equal(val.secteurId, siteB.id, 'rattachée au site de Valréas lorsqu\'il existe');
    assert.equal(JSON.stringify(g).includes(A.db.getConfig().sauvegardes.destinations.find((d) => d.id === val.id).cle), false);
    // Les destinations désactivées ne sont pas utilisées par une sauvegarde complète
    const ex = await adminA.ok('POST', '/api/sauvegardes-avancees/executer', {});
    assert.ok(ex.resultats.every((x) => !demo.some((d) => d.id === x.destinationId)));
  });

  test('anti-force-brute : blocage après plusieurs clés invalides', async () => {
    const contenu = zlib.gzipSync('{}');
    let statut = 0;
    for (let i = 0; i < 12 && statut !== 429; i++) statut = (await envoyerBrut(B, { cle: 'gmao_cle-invalide-numero-' + i, fichier: 'gmao-X-20261014-101010.json.gz', contenu })).status;
    assert.equal(statut, 429);
    const r = await fetch(B.base + '/api/replication/ping', { headers: { 'x-gmao-cle': cleB } });
    assert.equal(r.status, 429, 'même la bonne clé est bloquée temporairement');
  });
});
