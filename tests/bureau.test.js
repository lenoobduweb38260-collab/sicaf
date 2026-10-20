'use strict';
/**
 * Application de bureau (Electron) : paramètres, mises à jour automatiques, démarrage de
 * electron/main.js et pont electron/preload.js avec un module « electron » simulé (Electron
 * n'est pas installé ici), récupération d'urgence d'un compte depuis le poste serveur.
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
const { hashPassword, verifyPassword } = require('../server/auth');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Charge un module de electron/ en remplaçant le module « electron » par un objet simulé. */
function chargerAvecElectron(fichier, electron) {
  const chemin = require.resolve(fichier);
  delete require.cache[chemin];
  const resoudre = Module._resolveFilename;
  Module._resolveFilename = function (req, ...r) { return req === 'electron' ? 'electron-simule' : resoudre.call(this, req, ...r); };
  require.cache['electron-simule'] = { id: 'electron-simule', filename: 'electron-simule', loaded: true, exports: electron };
  try { return require(chemin); } finally { Module._resolveFilename = resoudre; }
}

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
      constructor(opts) {
        this.opts = opts; this.handlers = {}; this.contenu = {}; this.chargements = []; journal.fenetres.push(this);
        const fen = this;
        this.webContents = { setWindowOpenHandler() {}, on(n, fn) { fen.contenu[n] = fn; }, session: { setPermissionRequestHandler() {} }, reload() {} };
      }
      loadURL(u) { journal.urls.push(u); this.url = u; }
      loadFile(f, o) { journal.fichiers.push(f); journal.requetes.push((o && o.query) || {}); this.chargements.push((o && o.query) || {}); }
      once(n, fn) { this.handlers[n] = fn; }
      on(n, fn) { this.handlers[n] = fn; }
      show() {} hide() {} focus() {} maximize() {} isMaximized() { return false; } isMinimized() { return false; } restore() {}
      getSize() { return [1400, 900]; } setProgressBar() {}
      // Comme Electron : « closed » est émis après destroy(), et après close() sauf si « close » l'empêche
      destroy() { if (this.detruite) return; this.detruite = true; setImmediate(() => { if (this.handlers.closed) this.handlers.closed(); }); }
      close() { let empeche = false; if (this.handlers.close) this.handlers.close({ preventDefault: () => { empeche = true; } }); if (!empeche) this.destroy(); }
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
      Tray: class { constructor() { journal.trays += 1; } on() {} setToolTip() {} setContextMenu(m) { journal.menuTray = m; } },
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

  const chargerMain = (faux) => chargerAvecElectron('../electron/main.js', faux.electron);
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
  const CANAUX_RECUPERATION = ['bureau:recuperation-etat', 'bureau:recuperation-deverrouiller', 'bureau:recuperation-comptes', 'bureau:recuperation-generer'];

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
      // Nouveau test : empreinte reconnue sans nouvelle confirmation (assistant fermé : code redemandé)
      await assert.rejects(() => faux.handlers['bureau:tester-serveur'](cadreAssistant, distant.url), /Code du pôle informatique requis/);
      assert.equal((await faux.handlers['bureau:deverrouiller'](cadreAssistant, CODE)).ok, true);
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
      // Récupération d'urgence : jamais en mode client (ni entrée de menu, ni canal utilisable)
      assert.ok(!f1.journal.menuTray.some((m) => /Récupérer un compte/.test(m.label || '')), 'aucune entrée « Récupérer un compte administrateur… »');
      await f1.handlers['bureau:ouvrir-parametres'](cadreApplication(url));
      const assistant = f1.journal.fenetres[f1.journal.fenetres.length - 1];
      assert.match(assistant.opts.title, /Paramètres de connexion/);
      for (const canal of CANAUX_RECUPERATION) {
        await assert.rejects(() => f1.handlers[canal]({ sender: assistant.webContents, senderFrame: cadreAssistant.senderFrame }, 'admin'), /non autorisé/, canal);
      }
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

  // ----- Récupération d'urgence d'un compte (poste serveur) ----------------------------------
  const FORMAT_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
  const entreeMenu = (faux, libelle) => (faux.journal.menuTray || []).find((m) => m && m.label === libelle);
  const derniereFenetre = (faux) => faux.journal.fenetres[faux.journal.fenetres.length - 1];
  /** Appel IPC depuis une fenêtre donnée (expéditeur) affichant la page locale de l'assistant. */
  const depuis = (fen) => ({ sender: fen.webContents, senderFrame: cadreAssistant.senderFrame });
  /** Ouvre la fenêtre de récupération par la zone de notification ; renvoie l'émetteur IPC de cette fenêtre. */
  function ouvrirRecuperation(faux) {
    const entree = entreeMenu(faux, 'Récupérer un compte administrateur…');
    assert.ok(entree, 'entrée du menu de la zone de notification');
    entree.click();
    const fen = derniereFenetre(faux);
    assert.match(fen.opts.title, /Récupération d'un compte administrateur/);
    return { fen, ev: depuis(fen) };
  }
  /** Requête vers le serveur intégré, comme l'application (marqueur de l'application de bureau). */
  async function requete(url, chemin, { corps, cookie } = {}) {
    const h = { 'user-agent': UA, 'x-requested-with': 'GMAO' };
    if (corps) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    const rep = await fetch(url + chemin.replace(/^\//, ''), { method: corps ? 'POST' : 'GET', headers: h, body: corps ? JSON.stringify(corps) : undefined });
    const texte = await rep.text();
    let body = texte;
    try { body = JSON.parse(texte); } catch (e) { /* texte brut */ }
    return { status: rep.status, body, cookie: String(rep.headers.get('set-cookie') || '').split(';')[0] };
  }
  const demarrerServeurBureau = async (userData) => {
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.urls.length === 1, 10000);
    return { faux, url: faux.journal.urls[0] };
  };

  test('mode serveur : récupération d\'urgence d\'un compte administrateur (zone de notification, code du pôle informatique, code à usage unique)', async () => {
    const userData = tmp('gmao-bureau-');
    const port = 49000 + Math.floor(Math.random() * 1000);
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port, partageReseau: false } });
    const sortie = [];
    const consoleLog = console.log;
    console.log = (...a) => { sortie.push(a.join(' ')); consoleLog(...a); };
    let faux;
    let codeGenere = '';
    try {
      const d = await demarrerServeurBureau(userData);
      faux = d.faux;
      const url = d.url;
      const h = faux.handlers;
      // Fenêtre principale de la GMAO (et toute page autre que l'assistant ouvert pour cet usage) : aucun accès
      const principale = faux.journal.fenetres[0];
      for (const canal of CANAUX_RECUPERATION) {
        await assert.rejects(() => h[canal]({ sender: principale.webContents, senderFrame: { url: url + '#/systeme' } }, CODE), /non autorisé/, canal);
        await assert.rejects(() => h[canal](cadreAssistant, CODE), /non autorisé/, `${canal} sans fenêtre de récupération`);
      }

      const { fen, ev } = ouvrirRecuperation(faux);
      assert.equal(faux.journal.requetes[faux.journal.requetes.length - 1].mode, 'recuperation');
      assert.equal(fen.opts.webPreferences.sandbox, true);
      assert.equal(fen.opts.webPreferences.contextIsolation, true);
      // Même page locale, mais une autre fenêtre (ex. ouverte depuis une page) : refusé
      const intruse = new faux.electron.BrowserWindow({ title: 'autre' });
      await assert.rejects(() => h['bureau:recuperation-etat'](depuis(intruse)), /non autorisé/);
      let etat = await h['bureau:recuperation-etat'](ev);
      assert.deepEqual([etat.disponible, etat.deverrouille, etat.bloque], [true, false, false]);
      // Sans le code du pôle informatique : ni liste des comptes, ni code
      assert.equal((await h['bureau:recuperation-comptes'](ev)).verrouille, true);
      assert.equal((await h['bureau:recuperation-generer'](ev, 'admin')).verrouille, true);
      // Le déverrouillage des paramètres ne vaut pas pour la récupération
      assert.equal((await h['bureau:deverrouiller'](ev, CODE)).ok, true);
      assert.equal((await h['bureau:recuperation-comptes'](ev)).verrouille, true);
      const mauvais = await h['bureau:recuperation-deverrouiller'](ev, 'pas-le-bon-code');
      assert.deepEqual([mauvais.ok, mauvais.message], [false, 'Code incorrect']);
      assert.equal((await h['bureau:recuperation-deverrouiller'](ev, CODE)).ok, true);
      etat = await h['bureau:recuperation-etat'](ev);
      assert.equal(etat.deverrouille, true);

      // Comptes récupérables : identifiant et nom seulement
      const c = await h['bureau:recuperation-comptes'](ev);
      assert.equal(c.ok, true);
      assert.ok(c.comptes.some((x) => x.login === 'admin'));
      assert.ok(c.comptes.every((x) => Object.keys(x).sort().join() === 'login,nom'));
      // Compte inconnu : refusé, sans consommer la saisie du code
      const inconnu = await h['bureau:recuperation-generer'](ev, 'inexistant');
      assert.equal(inconnu.ok, false);
      assert.match(inconnu.message, /non récupérable/);
      assert.equal((await h['bureau:recuperation-generer'](ev, { login: 'admin' })).ok, false, 'identifiant non textuel refusé');
      // Génération : code affiché une seule fois, valable 60 minutes par défaut
      const avant = Date.now();
      const r = await h['bureau:recuperation-generer'](ev, ' ADMIN ');
      assert.equal(r.ok, true);
      assert.deepEqual(Object.keys(r).sort(), ['code', 'expireLe', 'login', 'nom', 'ok']);
      assert.equal(r.login, 'admin');
      assert.match(r.code, FORMAT_CODE);
      codeGenere = r.code;
      const duree = Date.parse(r.expireLe) - avant;
      assert.ok(duree > 59 * 60000 && duree <= 61 * 60000, 'validité de 60 minutes');
      // Un code par saisie du code du pôle informatique
      assert.equal((await h['bureau:recuperation-generer'](ev, 'admin')).verrouille, true);
      assert.equal((await h['bureau:recuperation-etat'](ev)).deverrouille, false);
      // Saisie du code valable 5 minutes
      assert.equal((await h['bureau:recuperation-deverrouiller'](ev, CODE)).ok, true);
      const maintenant = Date.now;
      let tardif;
      Date.now = () => maintenant() + 6 * 60 * 1000;
      try { tardif = h['bureau:recuperation-comptes'](ev); } finally { Date.now = maintenant; }
      assert.equal((await tardif).verrouille, true);

      // Le code s'utilise depuis l'écran de connexion de la GMAO, une seule fois ; il ne contourne rien
      const nouveau = 'Recuperation-Urgence-2026!';
      assert.equal((await requete(url, '/api/auth/reinitialiser', { corps: { login: 'admin', code: r.code.toLowerCase().replace('-', ' '), nouveau } })).status, 200);
      assert.equal((await requete(url, '/api/auth/reinitialiser', { corps: { login: 'admin', code: r.code, nouveau: nouveau + 'x' } })).status, 400, 'usage unique');
      const login = await requete(url, '/api/auth/login', { corps: { login: 'admin', password: nouveau } });
      assert.equal(login.status, 200);
      const cookie = login.cookie;
      // Journal d'activité : génération attribuée au poste serveur (sans le code), code incorrect inscrit
      const audit = (await requete(url, '/api/audit?limite=2000', { cookie })).body;
      const ligne = audit.lignes.find((x) => x.action === 'recuperation_urgence');
      assert.ok(ligne, 'récupération journalisée');
      assert.match(ligne.userNom, /^Poste serveur /);
      assert.ok(ligne.userNom.includes(os.hostname()));
      assert.ok(!ligne.details.includes(r.code));
      assert.ok(audit.lignes.some((x) => x.action === 'echec_connexion' && /Code du pôle informatique incorrect.*récupération d'urgence/.test(x.details) && /^Poste serveur /.test(x.userNom)));
      const notifs = (await requete(url, '/api/notifications', { cookie })).body.notifications;
      assert.ok(notifs.some((n) => n.titre === 'Récupération d\'urgence d\'un compte' && n.type === 'alerte'), 'pôle informatique prévenu');

      // Changement de mode : la fenêtre est remplacée, l'ancienne n'a plus aucun accès
      assert.equal((await h['bureau:recuperation-deverrouiller'](ev, CODE)).ok, true);
      const nbFenetres = faux.journal.fenetres.length;
      await h['bureau:ouvrir-parametres'](cadreApplication(url));
      assert.equal(faux.journal.fenetres.length, nbFenetres, 'une page de la GMAO n\'interrompt pas une récupération en cours');
      entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
      const parametresFen = derniereFenetre(faux);
      assert.match(parametresFen.opts.title, /Paramètres de connexion/);
      await new Promise((ok) => setImmediate(ok));
      await assert.rejects(() => h['bureau:recuperation-comptes'](ev), /non autorisé/);
      await assert.rejects(() => h['bureau:recuperation-etat'](depuis(parametresFen)), /non autorisé/, 'fenêtre des paramètres');
      // Nouvelle ouverture : code redemandé ; fermeture : plus aucun accès
      const second = ouvrirRecuperation(faux);
      assert.equal((await h['bureau:recuperation-etat'](second.ev)).deverrouille, false);
      assert.equal((await h['bureau:recuperation-deverrouiller'](second.ev, CODE)).ok, true);
      await h['bureau:fermer-assistant'](second.ev);
      await new Promise((ok) => setImmediate(ok));
      await assert.rejects(() => h['bureau:recuperation-comptes'](second.ev), /non autorisé/);

      // Le code généré n'est écrit ni dans le journal du poste ni dans ses paramètres
      assert.ok(sortie.some((l) => /Récupération d'urgence : code de réinitialisation généré pour le compte admin/.test(l)));
      assert.ok(!sortie.some((l) => l.includes(r.code)));
      assert.ok(!fs.readFileSync(path.join(userData, 'parametres.json'), 'utf8').includes(r.code));
    } finally {
      console.log = consoleLog;
      if (faux) await arreter(faux);
    }
    // Base de données : le code n'y figure jamais en clair et a été supprimé à son utilisation
    const base = fs.readFileSync(path.join(userData, 'data', 'gmao.json'), 'utf8');
    assert.ok(codeGenere && !base.includes(codeGenere) && !base.includes(codeGenere.replace('-', '')), 'aucun code en clair');
    assert.ok(!JSON.parse(base).collections.users.find((u) => u.login === 'admin').reinitialisation, 'code consommé');
  });

  test('code du pôle informatique : blocage après 8 essais incorrects, conservé au redémarrage et signalé dans la GMAO', async () => {
    const userData = tmp('gmao-bureau-');
    const port = 46000 + Math.floor(Math.random() * 1000);
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port, partageReseau: false }, verrouCode: { echecs: 7 } });
    let { faux } = await demarrerServeurBureau(userData);
    let { ev } = ouvrirRecuperation(faux);
    // 8e essai incorrect : freiné, puis saisie bloquée 15 minutes
    const t0 = Date.now();
    const r = await faux.handlers['bureau:recuperation-deverrouiller'](ev, 'encore-faux');
    assert.ok(Date.now() - t0 >= 9000, 'essai freiné après plusieurs échecs');
    assert.equal(r.ok, false);
    assert.equal(r.bloque, true);
    assert.match(r.message, /bloquée jusqu'à \d{2}:\d{2}/);
    const fin = Date.parse(lireParametres(userData).verrouCode.bloqueJusqua);
    assert.ok(fin > Date.now() + 14 * 60000 && fin <= Date.now() + 15 * 60000);
    // Même le bon code est refusé pendant le blocage, pour la récupération comme pour les paramètres
    const t1 = Date.now();
    assert.equal((await faux.handlers['bureau:recuperation-deverrouiller'](ev, CODE)).bloque, true);
    assert.ok(Date.now() - t1 < 300, 'refus immédiat, sans vérification du code');
    assert.equal((await faux.handlers['bureau:recuperation-etat'](ev)).bloque, true);
    entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
    const p = await faux.handlers['bureau:deverrouiller'](depuis(derniereFenetre(faux)), CODE);
    assert.equal(p.ok, false);
    assert.match(p.message, /bloquée/);
    assert.equal((await faux.handlers['bureau:parametres'](cadreAssistant)).verrouille, true);
    assert.equal((await faux.handlers['bureau:parametres'](cadreAssistant)).verrouCode, undefined);
    await arreter(faux);
    // Journal d'activité et notification du pôle informatique
    const base = JSON.parse(fs.readFileSync(path.join(userData, 'data', 'gmao.json'), 'utf8')).collections;
    const blocage = base.audit.find((a) => a.action === 'blocage');
    assert.ok(blocage);
    assert.match(blocage.userNom, /^Poste serveur /);
    assert.match(blocage.details, /code du pôle informatique bloquée 15 minutes.*8 essais incorrects/);
    const admin = base.users.find((u) => u.login === 'admin');
    assert.ok(base.notifications.some((n) => n.userId === admin.id && n.titre === 'Code du pôle informatique bloqué sur le poste serveur' && n.type === 'alerte'));

    // Redémarrage : le blocage demeure (une date trop lointaine est ramenée à 15 minutes)
    new Parametres(userData).enregistrer({ verrouCode: { echecs: 0, bloqueJusqua: '2100-01-01T00:00:00.000Z' } });
    ({ faux } = await demarrerServeurBureau(userData));
    ({ ev } = ouvrirRecuperation(faux));
    const etat = await faux.handlers['bureau:recuperation-etat'](ev);
    assert.equal(etat.bloque, true);
    assert.ok(Date.parse(lireParametres(userData).verrouCode.bloqueJusqua) <= Date.now() + 15 * 60000, 'blocage borné à sa durée normale');
    assert.equal((await faux.handlers['bureau:recuperation-deverrouiller'](ev, CODE)).ok, false);
    await arreter(faux);

    // Fin du blocage : le bon code est accepté et le compteur remis à zéro
    new Parametres(userData).enregistrer({ verrouCode: { echecs: 3, bloqueJusqua: new Date(Date.now() - 1000).toISOString() } });
    ({ faux } = await demarrerServeurBureau(userData));
    ({ ev } = ouvrirRecuperation(faux));
    assert.equal((await faux.handlers['bureau:recuperation-etat'](ev)).bloque, false);
    assert.equal((await faux.handlers['bureau:recuperation-deverrouiller'](ev, CODE)).ok, true);
    assert.deepEqual(lireParametres(userData).verrouCode, { echecs: 0, bloqueJusqua: '' });
    await arreter(faux);
  });

  // ----- Cycle de vie du serveur intégré, assistant et messages ----------------------------------
  const portAleatoire = () => 41000 + Math.floor(Math.random() * 4000);
  const lireBase = (userData) => JSON.parse(fs.readFileSync(path.join(userData, 'data', 'gmao.json'), 'utf8'));
  const compteAdmin = (base) => base.collections.users.find((u) => u.login === 'admin');
  const NOUVEAU_MDP = 'Nouveau-Mdp-Bureau-2026!';
  /** Espion sur createApp (main.js charge server/server.js à la demande) : instances créées, appels de stop() comptés. */
  function espionnerServeurs(t) {
    const mod = require('../server/server');
    const original = mod.createApp;
    const instances = [];
    mod.createApp = (o) => {
      const s = original(o);
      s.arrets = 0;
      const stop = s.stop;
      s.stop = function () { s.arrets += 1; return stop.call(this); };
      instances.push(s);
      return s;
    };
    t.after(async () => {
      mod.createApp = original;
      for (const s of instances) if (!s.arrets) { try { await s.stop(); } catch (e) { /* déjà arrêtée */ } }
    });
    return instances;
  }

  test('échec d\'affichage de la fenêtre (poste seul) : « Rouvrir la GMAO » sans second serveur, aucune donnée écrasée, arrêt complet', async (t) => {
    const instances = espionnerServeurs(t);
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: false } });
    const { faux, url } = await demarrerServeurBureau(userData);
    const principale = faux.journal.fenetres[0];
    // Chromium signale un échec de chargement de la fenêtre principale alors que le serveur tourne
    principale.contenu['did-fail-load']({}, -21, 'ERR_NETWORK_CHANGED', url, true);
    await attendre(() => faux.journal.fichiers.length === 1);
    const q = faux.journal.requetes[0];
    assert.match(q.erreur, /^Impossible d'ouvrir la GMAO : .+ \(code -21\)\.$/);
    assert.doesNotMatch(q.erreur, /ERR_|Error/, 'aucun code Chromium brut');
    assert.equal(q.reprise, 'rouvrir', 'serveur en service : la fenêtre est seulement rouverte');
    assert.equal(principale.detruite, true);
    const assistant = derniereFenetre(faux);
    assert.equal(await faux.handlers['bureau:reessayer'](depuis(assistant)), true);
    assert.deepEqual(faux.journal.urls, [url, url], 'même serveur, nouvelle fenêtre');
    assert.equal(instances.length, 1, 'aucun second serveur sur la même base');
    assert.equal(instances[0].arrets, 0);
    await pause(10);
    assert.equal(assistant.detruite, true, 'assistant fermé une fois la GMAO rouverte');
    // Un changement de mot de passe reste écrit, même après une écriture périodique d'un module
    const login = await requete(url, '/api/auth/login', { corps: { login: 'admin', password: 'admin' } });
    assert.equal(login.status, 200);
    assert.equal((await requete(url, '/api/auth/mot-de-passe', { corps: { ancien: 'admin', nouveau: NOUVEAU_MDP }, cookie: login.cookie })).status, 200);
    instances[0].db.touch();
    await arreter(faux);
    assert.equal(instances[0].arrets, 1, 'serveur arrêté à la fermeture');
    assert.ok(verifyPassword(NOUVEAU_MDP, compteAdmin(lireBase(userData)).passwordHash), 'nouveau mot de passe conservé sur le disque');
  });

  test('échec d\'affichage (serveur partagé) : fenêtre rouverte, récupération et journal opérationnels, données écrites à l\'arrêt', async (t) => {
    const instances = espionnerServeurs(t);
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: true } });
    const { faux, url } = await demarrerServeurBureau(userData);
    const fp = tlsGmao.empreinte(fs.readFileSync(path.join(userData, 'data', 'tls', 'certificat.pem'), 'utf8'));
    faux.journal.fenetres[0].contenu['did-fail-load']({}, -324, 'ERR_EMPTY_RESPONSE', url, true);
    await attendre(() => faux.journal.fichiers.length === 1);
    assert.match(faux.journal.requetes[0].erreur, /réponse vide ou invalide \(code -324\)/);
    assert.equal(await faux.handlers['bureau:reessayer'](depuis(derniereFenetre(faux))), true);
    assert.equal(faux.journal.urls[1], url);
    assert.equal(instances.length, 1, 'le serveur qui sert le réseau n\'est ni dupliqué ni « perdu »');
    // Récupération d'urgence toujours disponible depuis la zone de notification
    const { ev } = ouvrirRecuperation(faux);
    assert.equal((await faux.handlers['bureau:recuperation-etat'](ev)).disponible, true);
    // Échec du code du pôle informatique : toujours inscrit au journal d'activité
    entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
    assert.equal((await faux.handlers['bureau:deverrouiller'](depuis(derniereFenetre(faux)), 'mauvais-code')).ok, false);
    assert.ok(instances[0].db.list('audit', (a) => a.action === 'echec_connexion' && /paramètres de connexion/.test(a.details)).length, 'échec journalisé');
    // Connexion d'un poste du réseau (écriture différée), puis arrêt : données écrites
    const login = await requeteEpinglee(url + 'api/auth/login', fp, { method: 'POST', corps: { login: 'admin', password: 'admin' } });
    assert.equal(login.status, 200);
    faux.ev['before-quit']();
    faux.ev['will-quit']();
    faux.ev['window-all-closed']();
    await attendre(() => faux.journal.quit > 0);
    await pause(150);
    assert.equal(instances[0].arrets, 1, 'serveur arrêté (minuteurs, écriture des données)');
    assert.ok(compteAdmin(lireBase(userData)).derniereConnexion, 'connexion écrite dans gmao.json');
  });

  test('écoute refusée (EACCES, port réservé par Windows) : instance arrêtée, message en français, une seule instance après correction du port', async (t) => {
    const instances = espionnerServeurs(t);
    const net = require('net');
    const listen = net.Server.prototype.listen;
    t.after(() => { net.Server.prototype.listen = listen; });
    const userData = tmp('gmao-bureau-');
    const port = portAleatoire();
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port, partageReseau: false } });
    net.Server.prototype.listen = function () {
      net.Server.prototype.listen = listen;
      process.nextTick(() => this.emit('error', Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), { code: 'EACCES', syscall: 'listen' })));
      return this;
    };
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1, 10000);
    const q = faux.journal.requetes[0];
    assert.match(q.erreur, new RegExp(`^Le port ${port} est réservé par Windows ou bloqué sur ce poste`));
    assert.doesNotMatch(q.erreur, /EACCES|listen|permission denied/);
    assert.equal(q.reprise, undefined, 'rien ne tourne : « Réessayer »');
    assert.equal(instances.length, 1);
    assert.equal(instances[0].arrets, 1, 'instance jamais à l\'écoute arrêtée (base, minuteurs)');
    const assistant = derniereFenetre(faux);
    assert.equal((await faux.handlers['bureau:deverrouiller'](depuis(assistant), 'mauvais-code')).ok, false);
    assert.equal(instances[0].db.list('audit', (a) => a.action === 'echec_connexion').length, 0, 'aucune écriture dans la base de l\'instance arrêtée');
    // Le pôle informatique choisit un autre port : une seule instance en service
    assert.equal((await faux.handlers['bureau:deverrouiller'](depuis(assistant), CODE)).ok, true);
    const r = await faux.handlers['bureau:enregistrer'](depuis(assistant), { mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: false } });
    assert.equal(r.ok, true);
    await attendre(() => faux.journal.urls.length === 1, 10000);
    assert.equal(instances.length, 2);
    assert.deepEqual(instances.map((s) => s.arrets), [1, 0]);
    await pause(10);
    assert.equal(assistant.detruite, true, 'assistant fermé une fois la GMAO ouverte');
    await arreter(faux);
    assert.deepEqual(instances.map((s) => s.arrets), [1, 1], 'toutes les instances arrêtées');
  });

  test('démarrage manqué (port occupé, partage réseau) : la relance montre l\'assistant, sa fermeture arrête l\'application', async (t) => {
    const instances = espionnerServeurs(t);
    const net = require('net');
    const port = portAleatoire();
    const occupant = net.createServer();
    await new Promise((r) => occupant.listen(port, '0.0.0.0', r));
    t.after(() => occupant.close());
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port, partageReseau: true }, demarrerAvecWindows: true });
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1, 10000);
    assert.match(faux.journal.requetes[0].erreur, new RegExp(`^Le port ${port} est déjà utilisé sur ce poste par un autre programme`));
    assert.deepEqual(instances.map((s) => s.arrets), [1]);
    // Relance de l'exécutable : l'assistant revient au premier plan (aucune fenêtre supplémentaire)
    const nb = faux.journal.fenetres.length;
    faux.ev['second-instance']();
    assert.equal(faux.journal.fenetres.length, nb);
    // Fermeture de l'assistant : rien ne tourne, l'application s'arrête (jamais de processus invisible)
    derniereFenetre(faux).close();
    await attendre(() => faux.journal.quit > 0);
    faux.ev['window-all-closed']();
    await pause(30);
    assert.ok(faux.journal.quit >= 1);
  });

  test('poste client démarré avec Windows, serveur injoignable : fermer l\'assistant arrête l\'application', async () => {
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'client', client: { url: 'http://127.0.0.1:1/' }, demarrerAvecWindows: true });
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1, 10000);
    assert.equal(faux.journal.trays, 0);
    assert.match(faux.journal.requetes[0].erreur, /Serveur GMAO injoignable/);
    derniereFenetre(faux).close();
    await attendre(() => faux.journal.quit > 0);
  });

  test('échec de chargement ou alerte de sécurité pendant que les paramètres sont ouverts : message affiché dans la même fenêtre', async (t) => {
    espionnerServeurs(t);
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: true } });
    const { faux, url } = await demarrerServeurBureau(userData);
    const principale = faux.journal.fenetres[0];
    entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
    const assistant = derniereFenetre(faux);
    assert.equal((await faux.handlers['bureau:deverrouiller'](depuis(assistant), CODE)).ok, true);
    const nb = faux.journal.fenetres.length;
    // Échec de chargement de la fenêtre principale : la page des paramètres est rechargée avec la cause
    principale.contenu['did-fail-load']({}, -100, 'ERR_CONNECTION_CLOSED', url, true);
    assert.equal(assistant.chargements.length, 2);
    assert.match(assistant.chargements[1].erreur, /connexion au serveur GMAO a été interrompue ou refusée \(code -100\)/);
    assert.equal(assistant.chargements[1].reprise, 'rouvrir');
    assert.equal(faux.journal.fenetres.length, nb, 'même fenêtre, aucune autre ouverte');
    assert.equal(principale.detruite, true);
    assert.equal((await faux.handlers['bureau:parametres'](depuis(assistant))).verrouille, undefined, 'saisie du code conservée');
    // « Rouvrir la GMAO », puis certificat refusé alors que les paramètres sont de nouveau ouverts : alerte affichée
    assert.equal(await faux.handlers['bureau:reessayer'](depuis(assistant)), true);
    await pause(10);
    entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
    const autre = derniereFenetre(faux);
    assert.notEqual(autre, assistant);
    const nb2 = faux.journal.fenetres.length;
    const pirate = tlsGmao.genererCertificat({ nomPoste: 'pirate' });
    assert.equal(await verifier(faux, '127.0.0.1', pirate.certificat), -2);
    await attendre(() => autre.chargements.length === 2);
    assert.equal(autre.chargements[1].alerte, 'securite');
    assert.match(autre.chargements[1].erreur, /certificat différent.*usurpation/);
    assert.equal(faux.journal.fenetres.length, nb2, 'même fenêtre, rechargée avec l\'alerte');
    await arreter(faux);
  });

  test('messages en français : dossier des données inaccessible, incident technique d\'un canal', async () => {
    const userData = tmp('gmao-bureau-');
    const fichier = path.join(userData, 'pas-un-dossier');
    fs.writeFileSync(fichier, 'x');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: false, dossierDonnees: path.join(fichier, 'data') } });
    const faux = fauxElectron(userData);
    chargerMain(faux);
    faux.demarrer();
    await attendre(() => faux.journal.fichiers.length === 1, 10000);
    const erreur = faux.journal.requetes[0].erreur;
    assert.match(erreur, /^Le dossier des données « .*pas-un-dossier.data » n'est pas accessible \(un élément du chemin n'est pas un dossier\)/);
    assert.doesNotMatch(erreur, /ENOTDIR|not a directory|mkdir/);
    // Incident technique pendant un appel de l'assistant : message générique, détail au journal du poste
    const assistant = derniereFenetre(faux);
    assert.equal((await faux.handlers['bureau:deverrouiller'](depuis(assistant), CODE)).ok, true);
    const pj = path.join(userData, 'parametres.json');
    fs.rmSync(pj);
    fs.mkdirSync(pj);
    fs.writeFileSync(path.join(pj, 'occupe'), '');
    await assert.rejects(() => faux.handlers['bureau:enregistrer'](depuis(assistant), { mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: false } }),
      (e) => /^Opération impossible sur ce poste/.test(e.message) && !/E[A-Z]{3,}|rename|Error/.test(e.message));
    await assert.rejects(() => faux.handlers['bureau:tester-serveur']({ senderFrame: { url: 'https://pirate.example/' } }, 'x'), (e) => e.message === 'Appel non autorisé');
  });

  test('code du pôle informatique vide : refusé sans essai compté, sans délai ni journal', async (t) => {
    espionnerServeurs(t);
    const userData = tmp('gmao-bureau-');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: false }, verrouCode: { echecs: 6 } });
    const { faux } = await demarrerServeurBureau(userData);
    entreeMenu(faux, 'Paramètres de connexion (pôle informatique)…').click();
    const ev = depuis(derniereFenetre(faux));
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = await faux.handlers['bureau:deverrouiller'](ev, '');
      assert.deepEqual([r.ok, r.message], [false, 'Saisissez le code du pôle informatique']);
      assert.ok(Date.now() - t0 < 300, 'aucun délai');
    }
    assert.equal(lireParametres(userData).verrouCode.echecs, 6, 'aucun essai compté');
    const rec = ouvrirRecuperation(faux);
    const r = await faux.handlers['bureau:recuperation-deverrouiller'](rec.ev, '');
    assert.deepEqual([r.ok, r.bloque, r.message], [false, false, 'Saisissez le code du pôle informatique']);
    assert.equal(lireParametres(userData).verrouCode.echecs, 6);
    await arreter(faux);
    const audit = lireBase(userData).collections.audit;
    assert.ok(!audit.some((a) => a.action === 'echec_connexion' || a.action === 'blocage'), 'rien au journal d\'activité');
    // Côté page : une saisie vide n'est pas envoyée, un seul essai à la fois
    const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'demarrage.html'), 'utf8');
    const fonction = html.slice(html.indexOf('async function deverrouiller()'), html.indexOf('B.deverrouiller(champ.value)'));
    assert.match(fonction, /if \(bouton\.disabled\) return;/);
    assert.match(fonction, /if \(!champ\.value\) \{[^}]*Saisissez le code du pôle informatique/);
  });

  test('certificat du serveur partagé : nouvelle clé signalée au pôle informatique, renouvellement à clé conservée seulement journalisé', async () => {
    const userData = tmp('gmao-bureau-');
    const tls = path.join(userData, 'data', 'tls');
    new Parametres(userData).enregistrer({ configure: true, codeInformatique: hashPassword(CODE), mode: 'serveur', serveur: { port: portAleatoire(), partageReseau: true } });
    const TITRE = 'Clé du certificat du serveur GMAO changée';
    const alertes = (base) => base.collections.notifications.filter((n) => n.titre === TITRE);
    const renouvellements = (base) => base.collections.audit.filter((a) => a.action === 'renouvellement');
    let { faux } = await demarrerServeurBureau(userData);
    const cle1 = lireParametres(userData).certificatServeur.empreinteCle;
    assert.equal(cle1, tlsGmao.empreinteCle(fs.readFileSync(path.join(tls, 'certificat.pem'), 'utf8')), 'clé mémorisée');
    await arreter(faux);
    let base = lireBase(userData);
    assert.match(renouvellements(base)[0].details, /^Certificat HTTPS du poste serveur créé \(première génération\)/);
    assert.equal(alertes(base).length, 0, 'premier partage : aucune alerte');

    // Clé privée corrompue (disque, antivirus, restauration partielle) : nouvelle clé, postes clients bloqués
    fs.writeFileSync(path.join(tls, 'cle.pem'), 'corrompu');
    ({ faux } = await demarrerServeurBureau(userData));
    const cle2 = lireParametres(userData).certificatServeur.empreinteCle;
    assert.notEqual(cle2, cle1);
    const empreinte2 = tlsGmao.empreinte(fs.readFileSync(path.join(tls, 'certificat.pem'), 'utf8'));
    await arreter(faux);
    base = lireBase(userData);
    const entree = renouvellements(base).find((a) => /^La clé du certificat HTTPS de ce poste serveur a changé \(fichier de la clé privée illisible ou corrompu\)/.test(a.details));
    assert.ok(entree, 'changement de clé journalisé');
    assert.equal(entree.entite, 'systeme');
    assert.match(entree.userNom, /^Poste serveur /);
    assert.ok(entree.details.includes(empreinte2), 'nouvelle empreinte citée');
    const adminId = compteAdmin(base).id;
    assert.ok(alertes(base).some((n) => n.userId === adminId && n.type === 'alerte' && n.message.includes(empreinte2)), 'pôle informatique prévenu');

    // Certificat seul recréé (clé conservée) : journalisé, sans alerte
    fs.rmSync(path.join(tls, 'certificat.pem'));
    ({ faux } = await demarrerServeurBureau(userData));
    await arreter(faux);
    base = lireBase(userData);
    assert.ok(renouvellements(base).some((a) => /^Certificat HTTPS du poste serveur renouvelé \(certificat absent\), clé conservée/.test(a.details)));
    assert.equal(alertes(base).length, 1, 'aucune nouvelle alerte');
    assert.equal(lireParametres(userData).certificatServeur.empreinteCle, cle2);

    // Clé supprimée et mémoire du poste effacée : changement détecté grâce au certificat encore en place
    new Parametres(userData).enregistrer({ certificatServeur: { empreinteCle: '' } });
    fs.rmSync(path.join(tls, 'cle.pem'));
    ({ faux } = await demarrerServeurBureau(userData));
    await arreter(faux);
    base = lireBase(userData);
    assert.ok(renouvellements(base).some((a) => /a changé \(fichier de la clé privée absent\)/.test(a.details)));
    assert.equal(alertes(base).length, 2);
  });
});

describe('Pont preload.js', () => {
  /** Charge preload.js pour une page d'adresse donnée ; renvoie l'objet exposé et les appels IPC. */
  function chargerPreload(protocole) {
    const expose = {};
    const appels = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (nom, valeur) => { expose[nom] = valeur; } },
      ipcRenderer: { invoke: (...a) => { appels.push(a); return Promise.resolve(null); } },
    };
    const avant = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value: { protocol: protocole }, configurable: true, writable: true });
    try {
      chargerAvecElectron('../electron/preload.js', electron);
    } finally {
      if (avant) Object.defineProperty(globalThis, 'location', avant); else delete globalThis.location;
    }
    return { pont: expose.gmaoBureau, appels };
  }
  const RECUPERATION = ['etatRecuperation', 'deverrouillerRecuperation', 'comptesRecuperables', 'genererCodeRecuperation'];

  test('récupération d\'urgence exposée à la page locale de l\'assistant uniquement, arguments bornés', () => {
    const local = chargerPreload('file:');
    assert.ok(Object.isFrozen(local.pont));
    for (const f of RECUPERATION) assert.equal(typeof local.pont[f], 'function', f);
    local.pont.etatRecuperation();
    local.pont.deverrouillerRecuperation('x'.repeat(500));
    local.pont.comptesRecuperables();
    local.pont.genererCodeRecuperation({ login: 'admin' });
    local.pont.genererCodeRecuperation('a'.repeat(300));
    assert.deepEqual(local.appels.map((a) => a[0]), ['bureau:recuperation-etat', 'bureau:recuperation-deverrouiller', 'bureau:recuperation-comptes', 'bureau:recuperation-generer', 'bureau:recuperation-generer']);
    assert.equal(local.appels[1][1].length, 200);
    assert.equal(local.appels[3][1], '', 'valeur non textuelle remplacée');
    assert.equal(local.appels[4][1].length, 100);
    // Pages de la GMAO (serveur local ou distant) : aucune fonction de récupération
    for (const protocole of ['https:', 'http:']) {
      const gmao = chargerPreload(protocole);
      for (const f of RECUPERATION) assert.equal(gmao.pont[f], undefined, `${f} (${protocole})`);
      assert.equal(typeof gmao.pont.infos, 'function');
    }
  });
});
