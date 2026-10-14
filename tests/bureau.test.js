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

const { Parametres, normaliser, normaliserUrl } = require('../electron/parametres');
const { creerGestionnaire, comparerVersions, validerManifeste, nomSur } = require('../electron/miseajour');
const { manifeste } = require('../scripts/manifeste-maj');

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
    const journal = { fenetres: [], urls: [], fichiers: [], trays: 0, menus: 0, loginItems: [], quit: 0 };
    let pret;
    const whenReady = new Promise((r) => { pret = r; });
    class BrowserWindow {
      constructor(opts) { this.opts = opts; this.handlers = {}; journal.fenetres.push(this); this.webContents = { setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {} }, reload() {} }; }
      loadURL(u) { journal.urls.push(u); }
      loadFile(f) { journal.fichiers.push(f); }
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
      clipboard: { writeText() {} },
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
});
