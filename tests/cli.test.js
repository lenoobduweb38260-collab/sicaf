'use strict';
/**
 * Serveur autonome en ligne de commande (server/index.js) : option --https (certificat du poste, écoute mixte,
 * empreinte affichée) et option de secours --reinitialiser-double-auth <identifiant>.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { createApp } = require('../server/server');

const INDEX = path.join(__dirname, '..', 'server', 'index.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Lance server/index.js ; résout à la fin du processus ou dès que la sortie standard contient `attendre`. */
function executer(args, { attendre } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [INDEX].concat(args), { env: Object.assign({}, process.env, { GMAO_DATA_DIR: '' }) });
    let sortie = ''; let erreurs = '';
    const fin = (code) => resolve({ proc, code, sortie, erreurs });
    proc.stdout.on('data', (c) => { sortie += c; if (attendre && attendre.test(sortie)) resolve({ proc, code: null, sortie, erreurs }); });
    proc.stderr.on('data', (c) => { erreurs += c; });
    proc.on('error', reject);
    proc.on('exit', fin);
    setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Délai dépassé : ' + sortie + erreurs)); }, 60000).unref();
  });
}
const requete = (module_, options) => new Promise((resolve, reject) => {
  module_.get(options, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
});

describe('Serveur autonome : options de la ligne de commande', () => {
  test('--reinitialiser-double-auth <identifiant> : secret et codes de secours effacés, journal, sans démarrer le serveur', async () => {
    const dir = tmp('gmao-cli-');
    const app = createApp({ dataDir: dir, log: () => {} });
    const admin = app.db.findOne('users', (u) => u.login === 'admin');
    app.db.update('users', admin.id, { deuxFacteurs: { actif: true, secret: 'v1:aa:bb:cc', activeLe: new Date().toISOString() }, codesSecours: ['empreinte-1', 'empreinte-2'] });
    await app.stop();
    const r = await executer(['--data', dir, '--reinitialiser-double-auth', 'admin']);
    assert.equal(r.code, 0, r.sortie + r.erreurs);
    assert.match(r.sortie, /double authentification réinitialisée/);
    const app2 = createApp({ dataDir: dir, log: () => {} });
    try {
      const u = app2.db.findOne('users', (x) => x.login === 'admin');
      assert.equal(u.deuxFacteurs.actif, false);
      assert.equal(u.deuxFacteurs.secret, undefined);
      assert.deepEqual(u.codesSecours, []);
      assert.ok(app2.db.list('audit', (a) => a.action === 'reinitialisation_double_auth' && a.entiteId === u.id && a.userNom === 'Poste serveur').length, 'opération journalisée');
      assert.ok(app2.db.list('notifications', (n) => n.userId === u.id && /réinitialisée/.test(n.titre)).length, 'titulaire prévenu');
    } finally { await app2.stop(); }
    const r2 = await executer(['--data', dir, '--reinitialiser-double-auth', 'admin']);
    assert.equal(r2.code, 0); assert.match(r2.sortie, /rien à réinitialiser/);
    const r3 = await executer(['--data', dir, '--reinitialiser-double-auth', 'inconnu']);
    assert.notEqual(r3.code, 0); assert.match(r3.sortie + r3.erreurs, /introuvable/);
    const r4 = await executer(['--data', dir, '--reinitialiser-double-auth']);
    assert.notEqual(r4.code, 0); assert.match(r4.sortie + r4.erreurs, /identifiant/);
  });

  test('--https : HTTPS avec le certificat du poste, empreinte affichée, HTTP en clair redirigé', async () => {
    const dir = tmp('gmao-cli-https-');
    const { proc, sortie } = await executer(['--data', dir, '--port', '0', '--https'], { attendre: /Ctrl\+C pour arrêter/ });
    try {
      const m = /Application disponible sur : https:\/\/127\.0\.0\.1:(\d+)\//.exec(sortie);
      assert.ok(m, sortie);
      assert.match(sortie, /Empreinte du certificat[^:]*: (?:[0-9A-F]{2}:){31}[0-9A-F]{2}/);
      assert.ok(fs.existsSync(path.join(dir, 'tls', 'certificat.pem')), 'certificat du poste créé dans <données>/tls');
      const port = Number(m[1]);
      const r = await requete(https, { host: '127.0.0.1', port, path: '/api/auth/infos', rejectUnauthorized: false });
      assert.equal(r.status, 200);
      assert.ok(JSON.parse(r.body).politiqueMdp, 'API servie en HTTPS');
      const clair = await requete(http, { host: '127.0.0.1', port, path: '/' });
      assert.ok(clair.status >= 300 && clair.status < 400, 'HTTP en clair redirigé : ' + clair.status);
      assert.match(String(clair.headers.location || ''), /^https:\/\//);
    } finally { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); }
  });
});
