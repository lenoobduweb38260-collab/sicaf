'use strict';
/**
 * Application de bureau (Electron) : paramètres, mises à jour automatiques et démarrage
 * de electron/main.js avec un module « electron » simulé (Electron n'est pas installé ici).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');

const https = require('https');
const { Parametres, normaliser, normaliserUrl } = require('../electron/parametres');
const { creerGestionnaire, comparerVersions, validerManifeste, nomSur } = require('../electron/miseajour');
const { manifeste } = require('../scripts/manifeste-maj');
const tlsGmao = require('../server/tls');
const { createApp } = require('../server/server');
const { hashPassword } = require('../server/auth');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('Paramètres du poste', () => {
  test('valeurs par défaut et normalisation', () => {
    const p = normaliser({});
    assert.equal(p.mode, 'serveur');
    assert.equal(p.serveur.port, 8585);
    assert.equal(p.configure, false);
    const q = normaliser({ mode: 'client', client: { url: '' }, configure: true });
    assert.equal(q.configure, false, 'un mode client sans adresse renvoie à l\'assistant');
    assert.equal(normaliser({ serveur: { port: 99999 } }).serveur.port, 8585);
    assert.equal(normaliser({ misesAJour: { source: 'pirate' } }).misesAJour.source, 'github');
  });

  test('adresses de serveur', () => {
    assert.equal(normaliserUrl('srv-gmao:8585'), 'http://srv-gmao:8585/');
    assert.equal(normaliserUrl('http://192.168.1.20:8585/gmao'), 'http://192.168.1.20:8585/gmao/');
    assert.equal(normaliserUrl('https://gmao.exemple.fr/?x=1#a'), 'https://gmao.exemple.fr/');
    assert.equal(normaliserUrl('ftp://x'), '');
    assert.equal(normaliserUrl(''), '');
  });

  test('enregistrement atomique et relecture', () => {
    const d = tmp('gmao-param-');
    const p = new Parametres(d);
    p.enregistrer({ configure: true, serveur: { partageReseau: true } });
    p.enregistrer({ demarrerAvecWindows: true });
    const relu = new Parametres(d).valeurs;
    assert.equal(relu.configure, true);
    assert.equal(relu.serveur.partageReseau, true, 'fusion des sous-objets');
    assert.equal(relu.serveur.port, 8585);
    assert.equal(relu.demarrerAvecWindows, true);
    fs.writeFileSync(path.join(d, 'parametres.json'), '{ corrompu');
    assert.equal(new Parametres(d).valeurs.configure, false, 'fichier corrompu → valeurs par défaut');
  });

  test('empreinte du serveur épinglée : format validé, fichier à droits restreints', () => {
    const fp = tlsGmao.genererCertificat({ nomPoste: 'srv' }).empreinte;
    const p = normaliser({ mode: 'client', client: { url: 'https://srv:8585', empreinte: fp.toLowerCase(), empreinteCle: 'n\'importe quoi' } });
    assert.equal(p.client.empreinte, fp, 'forme canonique');
    assert.equal(p.client.empreinteCle, '', 'valeur invalide ignorée');
    const d = tmp('gmao-param-');
    new Parametres(d).enregistrer({ configure: true, codeInformatique: hashPassword('code-info-2026') });
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(d, 'parametres.json')).mode & 0o777, 0o600);
  });
});

describe('Assistant de connexion (demarrage.html)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'demarrage.html'), 'utf8');

  test('politique de contenu : script autorisé par son empreinte uniquement', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    const scriptSrc = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('script-src'));
    const attendu = `'sha256-${crypto.createHash('sha256').update(scripts[0][1], 'utf8').digest('base64')}'`;
    assert.equal(scriptSrc, `script-src ${attendu}`, 'empreinte CSP à recalculer après toute modification du script');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.ok(!/unsafe-eval/.test(csp));
  });

  test('aucune insertion de HTML ni gestionnaire en ligne', () => {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
    assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script\b[\s\S]*?<\/script>/g, '')), 'aucun attribut onclick=…');
    assert.ok(!/javascript:/i.test(html));
    assert.ok(!/\beval\(|new Function/.test(html));
  });
});

describe('Mises à jour automatiques', () => {
  let srv, base, dossierRelease, installateur, sha;
  const telechargements = [];

  before(async () => {
    dossierRelease = tmp('gmao-release-');
    installateur = path.join(dossierRelease, 'GMAO-SICAF-Setup-1.0.42.exe');
    fs.writeFileSync(installateur, crypto.randomBytes(300 * 1024));
    const m = manifeste(dossierRelease, '1.0.42', 'Nouveaux plans 3D');
    sha = m.sha256;
    // Serveur simulant l'API GitHub et le stockage des fichiers (avec redirection, comme GitHub)
    srv = http.createServer((req, res) => {
      if (req.url === '/repos/sicaf/gmao/releases/latest') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ tag_name: 'v1.0.42', html_url: base + '/page', body: 'Notes de version', assets: [
          { name: 'latest.json', browser_download_url: base + '/dl/latest.json', size: 200 },
          { name: 'GMAO-SICAF-Setup-1.0.42.exe', browser_download_url: base.replace('http://', 'https://') + '/dl/setup.exe', size: 300 * 1024 },
        ] }));
      }
      if (req.url === '/dl/latest.json') { res.setHeader('content-type', 'application/json'); return res.end(fs.readFileSync(path.join(dossierRelease, 'latest.json'))); }
      if (req.url === '/dl/setup.exe') { res.statusCode = 302; res.setHeader('location', '/stockage/setup.exe'); return res.end(); }
      if (req.url === '/stockage/setup.exe') { telechargements.push(1); const b = fs.readFileSync(installateur); res.setHeader('content-length', b.length); return res.end(b); }
      res.statusCode = 404; res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  // fetch qui redirige api.github.com et https://127.0.0.1 vers le serveur simulé
  const fetchSimule = (u, o) => fetch(String(u).replace('https://api.github.com', base).replace(/^https:\/\/127\.0\.0\.1/, 'http://127.0.0.1'), o);

  test('comparaison de versions', () => {
    assert.equal(comparerVersions('1.0.10', '1.0.9'), 1);
    assert.equal(comparerVersions('v1.2.0', '1.2.0'), 0);
    assert.equal(comparerVersions('1.0.0', '1.0.1'), -1);
    assert.equal(comparerVersions('2.0.0-beta', '1.9.9'), 1);
  });

  test('manifeste et noms de fichiers sûrs', () => {
    assert.throws(() => validerManifeste({ version: '1.0.1', fichier: '../evil.exe' }));
    assert.throws(() => validerManifeste({ version: 'x', fichier: 'a.exe' }));
    assert.equal(nomSur('C:\\Windows\\a.exe'), null);
    assert.equal(nomSur('GMAO-SICAF-Setup-1.0.1.exe'), 'GMAO-SICAF-Setup-1.0.1.exe');
    const m = JSON.parse(fs.readFileSync(path.join(dossierRelease, 'latest.json'), 'utf8'));
    assert.equal(m.version, '1.0.42');
    assert.match(m.sha256, /^[a-f0-9]{64}$/);
  });

  test('GitHub : nouvelle version détectée, téléchargée et vérifiée', async () => {
    const dl = tmp('gmao-dl-');
    const g = creerGestionnaire({ versionActuelle: '1.0.5', config: { source: 'github', depot: 'sicaf/gmao' }, fetch: fetchSimule, dossierTelechargement: dl });
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    assert.equal(info.version, '1.0.42');
    assert.equal(info.notes, 'Nouveaux plans 3D');
    const progression = [];
    const fichier = await g.telecharger(info, (x) => progression.push(x));
    assert.equal(path.basename(fichier), 'GMAO-SICAF-Setup-1.0.42.exe');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fichier)).digest('hex'), sha);
    assert.ok(progression.length && progression[progression.length - 1] === 1);
  });

  test('GitHub : déjà à jour', async () => {
    const g = creerGestionnaire({ versionActuelle: '1.0.42', config: { source: 'github', depot: 'sicaf/gmao' }, fetch: fetchSimule, dossierTelechargement: tmp('gmao-dl-') });
    assert.equal((await g.verifier()).disponible, false);
  });

  test('empreinte incorrecte : installateur refusé et supprimé', async () => {
    const dl = tmp('gmao-dl-');
    const g = creerGestionnaire({ versionActuelle: '1.0.5', config: { source: 'github', depot: 'sicaf/gmao' }, fetch: fetchSimule, dossierTelechargement: dl });
    const info = await g.verifier();
    info.manifeste.sha256 = 'a'.repeat(64);
    await assert.rejects(() => g.telecharger(info), /Empreinte/);
    assert.deepEqual(fs.readdirSync(dl), []);
  });

  test('dossier réseau : latest.json + installateur', async () => {
    const g = creerGestionnaire({ versionActuelle: '1.0.0', config: { source: 'dossier', chemin: dossierRelease }, fetch: fetchSimule, dossierTelechargement: tmp('gmao-dl-') });
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    const f = await g.telecharger(info);
    assert.ok(fs.existsSync(f));
  });

  test('adresse web : latest.json + installateur', async () => {
    const g = creerGestionnaire({ versionActuelle: '1.0.0', config: { source: 'url', url: base + '/dl/' }, fetch: (u, o) => fetch(String(u).replace('/dl/GMAO-SICAF-Setup-1.0.42.exe', '/stockage/setup.exe'), o), dossierTelechargement: tmp('gmao-dl-') });
    const info = await g.verifier();
    assert.equal(info.disponible, true);
    assert.ok(fs.existsSync(await g.telecharger(info)));
  });

  test('source désactivée', async () => {
    const g = creerGestionnaire({ versionActuelle: '1.0.0', config: { source: 'aucune' }, fetch: fetchSimule, dossierTelechargement: tmp('gmao-dl-') });
    assert.equal((await g.verifier()).disponible, false);
  });
});

describe('electron/main.js avec un Electron simulé', () => {
  /** Construit un faux module « electron » qui enregistre les appels. */
  function fauxElectron(userData) {
    const ev = {};
    const journal = { fenetres: [], urls: [], fichiers: [], requetes: [], trays: 0, menus: 0, loginItems: [], quit: 0, verification: null, presse: [] };
    let pret;
    const whenReady = new Promise((r) => { pret = r; });
    class BrowserWindow {
      constructor(opts) { this.opts = opts; this.handlers = {}; journal.fenetres.push(this); this.webContents = { setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {} }, reload() {} }; }
      loadURL(u) { journal.urls.push(u); }
      loadFile(f, o) { journal.fichiers.push(f); journal.requetes.push((o && o.query) || {}); }
      once(n, fn) { this.handlers[n] = fn; }
      on(n, fn) { this.handlers[n] = fn; }
      show() {} hide() {} focus() {} maximize() {} isMaximized() { return false; } isMinimized() { return false; } restore() {}
      getSize() { return [1400, 900]; } setProgressBar() {} destroy() {} close() {}
    }
    const app = {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      on: (n, fn) => { ev[n] = fn; }, setAppUserModelId() {}, getPath: (n) => (n === 'userData' ? userData : os.tmpdir()), getVersion: () => '1.0.7',
      whenReady: () => whenReady, quit: () => { journal.quit += 1; }, exit() {}, relaunch() {},
      setLoginItemSettings: (o) => journal.loginItems.push(o),
    };
    const handlers = {};
    const electron = {
      app, BrowserWindow,
      Menu: { buildFromTemplate: (t) => { journal.menus += 1; return t; }, setApplicationMenu() {} },
      Tray: class { constructor() { journal.trays += 1; } on() {} setToolTip() {} setContextMenu() {} },
      shell: { openExternal() {}, openPath() {} },
      dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true }), showErrorBox() {} },
      ipcMain: { handle: (c, fn) => { handlers[c] = fn; } },
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      Notification: class { static isSupported() { return false; } show() {} },
      net: { fetch: (u, o) => fetch(u, o) },
      clipboard: { writeText: (t) => journal.presse.push(t) },
      session: { defaultSession: { setCertificateVerifyProc: (fn) => { journal.verification = fn; } } },
    };
    return { electron, journal, handlers, ev, demarrer: () => pret() };
  }

  function chargerMain(faux) {
    const chemin = require.resolve('../electron/main.js');
    delete require.cache[chemin];
    const resoudre = Module._resolveFilename;
    Module._resolveFilename = function (req, ...r) { return req === 'electron' ? 'electron-simule' : resoudre.call(this, req, ...r); };
    require.cache['electron-simule'] = { id: 'electron-simule', filename: 'electron-simule', loaded: true, exports: faux.electron };
    try { return require(chemin); } finally { Module._resolveFilename = resoudre; }
  }
  const attendre = (cond, ms = 5000) => new Promise((ok, ko) => { const t0 = Date.now(); const i = setInterval(() => { if (cond()) { clearInterval(i); ok(); } else if (Date.now() - t0 > ms) { clearInterval(i); ko(new Error('délai dépassé')); } }, 20); });

  test('premier lancement : assistant de connexion, puis démarrage du serveur intégré', async () => {
    const userData = tmp('gmao-bureau-');
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1);
    assert.match(faux.journal.fichiers[0], /demarrage\.html$/);
    // L'assistant enregistre le mode serveur (port libre aléatoire pour le test)
    const appelAssistant = { senderFrame: { url: 'file:///' + path.join(__dirname, '..', 'electron', 'demarrage.html').replace(/\\/g, '/').replace(/^\//, '') } };
    const infos = await faux.handlers['bureau:infos'](appelAssistant);
    assert.equal(infos.version, '1.0.7');
    const choix = { mode: 'serveur', serveur: { port: 47000 + Math.floor(Math.random() * 1000), partageReseau: false }, demarrerAvecWindows: true };
    const sansCode = await faux.handlers['bureau:enregistrer'](appelAssistant, choix);
    assert.equal(sansCode.ok, false, 'le code du pôle informatique est obligatoire à la première configuration');
    const r = await faux.handlers['bureau:enregistrer'](appelAssistant, Object.assign({ nouveauCodeInformatique: 'info2026' }, choix));
    assert.equal(r.ok, true);
    assert.match(JSON.parse(fs.readFileSync(path.join(userData, 'parametres.json'), 'utf8')).codeInformatique, /^scrypt\$/, 'code stocké sous forme d\'empreinte');
    await attendre(() => faux.journal.urls.length === 1);
    const url = faux.journal.urls[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const rep = await fetch(url + 'api/auth/infos', { headers: { 'user-agent': 'GMAO-SICAF-Bureau/1.0.7' } });
    assert.equal(rep.status, 200, 'le serveur GMAO intégré répond');
    assert.ok(fs.existsSync(path.join(userData, 'data', 'gmao.json')), 'données dans le dossier de l\'application');
    assert.equal(faux.journal.trays, 1, 'icône dans la zone de notification');
    assert.equal(faux.journal.loginItems.length > 0, process.platform === 'win32', 'démarrage avec Windows (sous Windows uniquement)');
    // Paramètres protégés : une nouvelle ouverture de l'assistant exige le code du pôle informatique
    await faux.handlers['bureau:ouvrir-parametres'](appelAssistant).catch(() => {});
    const verrouille = await faux.handlers['bureau:parametres'](appelAssistant);
    assert.equal(verrouille.verrouille, true);
    assert.equal(verrouille.codeInformatique, undefined, 'l\'empreinte du code n\'est jamais envoyée à la page');
    await assert.rejects(() => faux.handlers['bureau:enregistrer'](appelAssistant, choix), /Code du pôle informatique requis/);
    assert.equal((await faux.handlers['bureau:deverrouiller'](appelAssistant, 'mauvais')).ok, false);
    assert.equal((await faux.handlers['bureau:deverrouiller'](appelAssistant, 'info2026')).ok, true);
    assert.equal((await faux.handlers['bureau:parametres'](appelAssistant)).mode, 'serveur');
    // Marqueur « application de bureau » et blocage des navigateurs web
    assert.match(faux.electron.app.userAgentFallback, /GMAO-SICAF-Bureau\/1\.0\.7/);
    assert.equal((await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } })).status, 403, 'navigateur web refusé');
    assert.equal((await fetch(url + 'api/auth/infos', { headers: { 'user-agent': faux.electron.app.userAgentFallback } })).status, 200, 'application acceptée');
    // Un appel IPC depuis une origine étrangère est refusé
    await assert.rejects(() => faux.handlers['bureau:parametres']({ senderFrame: { url: 'https://pirate.example/' } }), /non autorisé/);
    // Arrêt propre : « Quitter » arrête le serveur intégré
    faux.ev['before-quit']();
    faux.ev['window-all-closed']();
    await attendre(() => faux.journal.quit > 0);
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(() => fetch(url + 'api/auth/infos', { headers: { 'user-agent': 'GMAO-SICAF-Bureau/1' } }), 'serveur arrêté');
  });

  test('mode client : serveur injoignable → retour à l\'assistant avec un message', async () => {
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, mode: 'client', client: { url: 'http://127.0.0.1:1/' } });
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1, 10000);
    assert.equal(faux.journal.urls.length, 0);
  });

  // ----- Chiffrement réseau (HTTPS) et épinglage du certificat ---------------------------------
  const UA = 'Mozilla/5.0 GMAO-SICAF-Bureau/1.0.7';
  const CODE = 'code-info-2026';
  const cadreAssistant = { senderFrame: { url: 'file:///' + path.join(__dirname, '..', 'electron', 'demarrage.html').replace(/\\/g, '/').replace(/^\//, '') } };
  const cadreApplication = (url) => ({ senderFrame: { url: url + '#/systeme' } });
  /** Appelle la vérification de certificat installée par main.js, comme le ferait Chromium. */
  const verifier = (faux, hostname, pem) => new Promise((r) => faux.journal.verification({ hostname, certificate: { data: pem }, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', errorCode: -202 }, r));
  const arreter = async (faux) => {
    faux.ev['before-quit']();
    faux.ev['window-all-closed']();
    await attendre(() => faux.journal.quit > 0);
    await new Promise((r) => setTimeout(r, 150));
  };
  /** Requête HTTPS envoyée seulement si le certificat présenté a l'empreinte attendue. */
  function requeteEpinglee(url, empreinte, { method = 'GET', corps } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const donnees = corps === undefined ? null : Buffer.from(JSON.stringify(corps));
      const h = { 'user-agent': UA, 'x-requested-with': 'GMAO' };
      if (donnees) { h['content-type'] = 'application/json'; h['content-length'] = donnees.length; }
      const req = https.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: h, agent: false, rejectUnauthorized: false }, (res) => {
        const m = [];
        res.on('data', (c) => m.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texte: Buffer.concat(m).toString('utf8') }));
      });
      req.on('socket', (sock) => sock.once('secureConnect', () => {
        if (sock.getPeerCertificate().fingerprint256 !== empreinte) { req.destroy(new Error('Empreinte inattendue')); return; }
        if (donnees) req.write(donnees);
        req.end();
      }));
      req.on('error', reject);
    });
  }
  /** Serveur GMAO distant en HTTPS (écoute mixte, comme l'application en mode serveur partagé). */
  async function serveurDistant(cert) {
    const srv = createApp({ inMemory: true, log: () => {}, tls: { key: cert.cle, cert: cert.certificat } });
    const ecoute = await tlsGmao.ecouterMixte(srv.server, 0, '127.0.0.1');
    return { port: ecoute.adresse.port, url: `https://127.0.0.1:${ecoute.adresse.port}/`, arreter: async () => { await ecoute.fermer(); await srv.stop(); } };
  }
  const lireParametres = (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'parametres.json'), 'utf8'));

  test('mode serveur partagé : HTTPS avec le certificat du poste, fenêtre limitée à ce certificat', async () => {
    const userData = tmp('gmao-bureau-');
    const port = 48000 + Math.floor(Math.random() * 1000);
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port, partageReseau: true } });
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.urls.length === 1, 10000);
    const url = faux.journal.urls[0];
    assert.equal(url, `https://127.0.0.1:${port}/`, 'fenêtre locale en HTTPS');
    const certPem = fs.readFileSync(path.join(userData, 'data', 'tls', 'certificat.pem'), 'utf8');
    assert.ok(fs.existsSync(path.join(userData, 'data', 'tls', 'cle.pem')));
    const fp = tlsGmao.empreinte(certPem);
    const x509 = new crypto.X509Certificate(certPem);
    assert.equal(x509.checkHost(os.hostname()) !== undefined, true, 'nom du poste dans le certificat');
    assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');

    // Vérification Chromium : seul ce certificat est accepté pour 127.0.0.1, les autres sites gardent la vérification standard
    assert.equal(typeof faux.journal.verification, 'function', 'vérification des certificats installée');
    assert.equal(await verifier(faux, '127.0.0.1', certPem), 0);
    const autre = tlsGmao.genererCertificat({ nomPoste: 'pirate' });
    assert.equal(await verifier(faux, 'api.github.com', autre.certificat), -3);

    // Connexion réelle : HTTPS, HSTS, cookie de session Secure
    const infos = await requeteEpinglee(url + 'api/auth/infos', fp);
    assert.equal(infos.status, 200);
    assert.match(infos.headers['strict-transport-security'] || '', /max-age=/);
    const login = await requeteEpinglee(url + 'api/auth/login', fp, { method: 'POST', corps: { login: 'admin', password: 'admin' } });
    assert.equal(login.status, 200);
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict; Secure/);
    // Requête en clair sur le même port : redirection vers HTTPS, aucune donnée servie
    const clair = await fetch(`http://127.0.0.1:${port}/api/auth/infos`, { redirect: 'manual', headers: { 'user-agent': UA } });
    assert.equal(clair.status, 308);
    assert.equal(clair.headers.get('location'), `https://127.0.0.1:${port}/api/auth/infos`);

    // Informations pour l'assistant et la vue Système : empreinte à communiquer aux autres postes
    const i = await faux.handlers['bureau:infos'](cadreApplication(url));
    assert.equal(i.chiffrement, 'https');
    assert.equal(i.empreinte, fp);
    assert.equal(i.port, port);
    assert.match(i.acces, /connexion chiffrée/);
    // Canaux sensibles réservés à l'assistant de connexion (jamais aux pages de la GMAO)
    for (const canal of ['bureau:enregistrer', 'bureau:tester-serveur', 'bureau:deverrouiller', 'bureau:parametres', 'bureau:quitter']) {
      await assert.rejects(() => faux.handlers[canal](cadreApplication(url), {}), /non autorisé/, canal);
    }
    // Code du pôle informatique : essais simultanés traités un par un
    const t0 = Date.now();
    const essais = await Promise.all([faux.handlers['bureau:deverrouiller'](cadreAssistant, 'faux-1'), faux.handlers['bureau:deverrouiller'](cadreAssistant, 'faux-2')]);
    assert.ok(essais.every((e) => !e.ok));
    assert.ok(Date.now() - t0 >= 780, 'essais successifs freinés');

    // Un autre certificat présenté pour 127.0.0.1 : refusé, alerte de sécurité dans l'assistant
    assert.equal(await verifier(faux, '127.0.0.1', autre.certificat), -2);
    await attendre(() => faux.journal.requetes.some((q) => q.alerte === 'securite'));
    await arreter(faux);
    await assert.rejects(() => requeteEpinglee(url + 'api/auth/infos', fp), 'serveur arrêté');
  });

  test('mode client : première connexion chiffrée confirmée par empreinte, puis certificat épinglé', async () => {
    const cert = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao' });
    const pirate = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao' });
    const distant = await serveurDistant(cert);
    try {
      const userData = tmp('gmao-bureau-');
      const faux = fauxElectron(userData);
      chargerMain(faux);
      faux.demarrer();
      await attendre(() => faux.journal.fichiers.length === 1);
      const enregistrer = (d) => faux.handlers['bureau:enregistrer'](cadreAssistant, Object.assign({ mode: 'client', nouveauCodeInformatique: CODE }, d));
      // Adresse saisie sans protocole : le serveur redirige vers HTTPS, l'empreinte est à confirmer
      const t = await faux.handlers['bureau:tester-serveur'](cadreAssistant, `127.0.0.1:${distant.port}`);
      assert.equal(t.ok, false);
      assert.equal(t.confirmationRequise, true);
      assert.equal(t.url, distant.url);
      assert.equal(t.empreinte, cert.empreinte);
      assert.equal(typeof t.version, 'string');
      // Enregistrement impossible sans confirmation, ou avec une autre empreinte
      let r = await enregistrer({ client: { url: t.url } });
      assert.equal(r.ok, false);
      assert.equal(r.confirmationRequise, true);
      r = await enregistrer({ client: { url: t.url, empreinte: pirate.empreinte } });
      assert.equal(r.ok, false);
      assert.match(r.message, /ne correspond pas/);
      assert.ok(!fs.existsSync(path.join(userData, 'parametres.json')), 'rien n\'est enregistré');
      // Empreinte confirmée par le pôle informatique : enregistrée, puis connexion
      r = await enregistrer({ client: { url: t.url, empreinte: t.empreinte.toLowerCase() } });
      assert.equal(r.ok, true);
      const p = lireParametres(userData);
      assert.equal(p.client.url, distant.url);
      assert.equal(p.client.empreinte, cert.empreinte);
      assert.equal(p.client.empreinteCle, cert.empreinteCle);
      await attendre(() => faux.journal.urls.length === 1, 10000);
      assert.equal(faux.journal.urls[0], distant.url);
      assert.equal(await verifier(faux, '127.0.0.1', cert.certificat), 0, 'certificat confirmé accepté par la fenêtre');
      assert.equal(await verifier(faux, 'github.com', pirate.certificat), -3);
      // Nouveau test : empreinte reconnue sans nouvelle confirmation
      const t2 = await faux.handlers['bureau:tester-serveur'](cadreAssistant, distant.url);
      assert.equal(t2.ok, true);
      assert.equal(t2.chiffre, true);
      assert.equal(t2.confirme, true);
      const i = await faux.handlers['bureau:infos'](cadreApplication(distant.url));
      assert.equal(i.chiffrement, 'https');
      assert.equal(i.empreinte, cert.empreinte);
      assert.match(i.acces, /connexion chiffrée/);
      // Certificat différent présenté en cours de session : refusé, alerte de sécurité
      assert.equal(await verifier(faux, '127.0.0.1', pirate.certificat), -2);
      await attendre(() => faux.journal.requetes.some((q) => q.alerte === 'securite'));
      await arreter(faux);
    } finally { await distant.arreter(); }
  });

  test('mode client : empreinte différente → connexion bloquée (possible usurpation), remplacement par le pôle informatique', async () => {
    const cert = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao' });
    const ancien = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao' });
    const distant = await serveurDistant(cert);
    try {
      const userData = tmp('gmao-bureau-');
      new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'client', client: { url: distant.url, empreinte: ancien.empreinte, empreinteCle: ancien.empreinteCle } });
      const faux = fauxElectron(userData);
      chargerMain(faux);
      faux.demarrer();
      await attendre(() => faux.journal.fichiers.length === 1, 10000);
      assert.equal(faux.journal.urls.length, 0, 'aucune page chargée depuis ce serveur');
      assert.equal(faux.journal.requetes[0].alerte, 'securite');
      assert.match(faux.journal.requetes[0].erreur, /certificat différent.*usurpation/);
      // Le pôle informatique constate l'écart puis, après vérification sur le poste serveur, remplace l'empreinte
      await assert.rejects(() => faux.handlers['bureau:tester-serveur'](cadreAssistant, distant.url), /Code du pôle informatique requis/);
      assert.equal((await faux.handlers['bureau:deverrouiller'](cadreAssistant, CODE)).ok, true);
      const t = await faux.handlers['bureau:tester-serveur'](cadreAssistant, distant.url);
      assert.equal(t.usurpation, true);
      assert.equal(t.empreinte, cert.empreinte);
      assert.equal(t.attendue, ancien.empreinte);
      let r = await faux.handlers['bureau:enregistrer'](cadreAssistant, { mode: 'client', client: { url: distant.url, empreinte: t.empreinte } });
      assert.equal(r.ok, false, 'remplacement explicite exigé');
      assert.equal(r.usurpation, true);
      assert.equal(lireParametres(userData).client.empreinte, ancien.empreinte);
      r = await faux.handlers['bureau:enregistrer'](cadreAssistant, { mode: 'client', client: { url: distant.url, empreinte: t.empreinte, remplacerEmpreinte: true } });
      assert.equal(r.ok, true);
      assert.equal(lireParametres(userData).client.empreinte, cert.empreinte);
      await attendre(() => faux.journal.urls.length === 1, 10000);
      await arreter(faux);
    } finally { await distant.arreter(); }
  });

  test('mode client : certificat renouvelé par le même serveur (même clé) → accepté, épinglage mis à jour', async () => {
    const initial = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao' });
    const renouvele = tlsGmao.genererCertificat({ nomPoste: 'srv-gmao', cle: initial.cle, adresses: ['10.20.30.40'] });
    const distant = await serveurDistant(renouvele);
    try {
      const userData = tmp('gmao-bureau-');
      new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'client', client: { url: distant.url, empreinte: initial.empreinte, empreinteCle: initial.empreinteCle } });
      const faux = fauxElectron(userData);
      chargerMain(faux);
      faux.demarrer();
      await attendre(() => faux.journal.urls.length === 1, 10000);
      assert.equal(lireParametres(userData).client.empreinte, renouvele.empreinte);
      assert.equal(lireParametres(userData).client.empreinteCle, initial.empreinteCle);
      assert.equal(await verifier(faux, '127.0.0.1', renouvele.certificat), 0);
      await arreter(faux);
    } finally { await distant.arreter(); }
  });

  test('mode client : serveur en clair accepté avec avertissement, refusé si une connexion chiffrée a été confirmée', async () => {
    const ancienServeur = createApp({ inMemory: true, log: () => {} });
    const port = (await ancienServeur.start(0)).port;
    const url = `http://127.0.0.1:${port}/`;
    try {
      // Poste serveur d'une ancienne version : connexion possible, signalée comme non chiffrée
      const u1 = tmp('gmao-bureau-');
      new Parametres(u1).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'client', client: { url } });
      const f1 = fauxElectron(u1);
      chargerMain(f1);
      f1.demarrer();
      await attendre(() => f1.journal.urls.length === 1, 10000);
      assert.equal(f1.journal.urls[0], url);
      assert.equal((await f1.handlers['bureau:infos'](cadreApplication(url))).chiffrement, 'http');
      assert.match((await f1.handlers['bureau:infos'](cadreApplication(url))).acces, /non chiffrée/);
      assert.equal((await f1.handlers['bureau:deverrouiller'](cadreAssistant, CODE)).ok, true);
      const t = await f1.handlers['bureau:tester-serveur'](cadreAssistant, url);
      assert.equal(t.ok, true);
      assert.equal(t.chiffre, false);
      assert.match(t.avertissement, /circulent en clair/);
      await arreter(f1);
      // Même serveur alors qu'une empreinte avait été confirmée : déclassement refusé
      const u2 = tmp('gmao-bureau-');
      new Parametres(u2).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'client', client: { url, empreinte: tlsGmao.genererCertificat({ nomPoste: 'x' }).empreinte } });
      const f2 = fauxElectron(u2);
      chargerMain(f2);
      f2.demarrer();
      await attendre(() => f2.journal.fichiers.length === 1, 10000);
      assert.equal(f2.journal.urls.length, 0);
      assert.equal(f2.journal.requetes[0].alerte, 'securite');
      assert.match(f2.journal.requetes[0].erreur, /sans chiffrement/);
    } finally { await ancienServeur.stop(); }
  });
});
