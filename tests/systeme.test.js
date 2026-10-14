'use strict';
/**
 * Pôle informatique : comptes, base de données, sauvegardes, réseau et sessions réservés
 * au profil « Pôle informatique » (droits « systeme ») ; accès navigateur en mode bureau.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');
const { createApp } = require('../server/server');

describe('Pôle informatique et système', () => {
  let srv, admin, profils;
  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
  });
  after(async () => { await srv.stop(); });
  const profil = (nom) => profils.find((p) => p.nom === nom);

  async function compte(login, nomProfil) {
    await admin.ok('POST', '/api/utilisateurs', { login, nom: login, profilId: profil(nomProfil).id, password: 'pass1234', doitChangerMdp: false });
    const c = srv.client();
    await c.login(login, 'pass1234');
    return c;
  }

  test('le profil « Pôle informatique » existe avec les droits système', () => {
    const it = profil('Pôle informatique');
    assert.ok(it, 'profil créé par défaut');
    assert.equal(it.niveau, 1);
    assert.equal(it.permissions.systeme.modifier, true);
    assert.equal(it.permissions.utilisateurs.creer, true);
    const rm = profil('Responsable maintenance');
    assert.equal(rm.permissions.utilisateurs.creer, false, 'le responsable maintenance ne crée plus de comptes');
    assert.equal(rm.permissions.systeme.voir, false);
  });

  test('seul le pôle informatique crée les comptes et gère la base de données', async () => {
    const rm = await compte('resp', 'Responsable maintenance');
    const info = await compte('info', 'Pôle informatique');
    const tech = profil('Technicien').id;
    assert.equal((await rm.post('/api/utilisateurs', { login: 'x1', nom: 'X', profilId: tech })).status, 403);
    assert.equal((await info.post('/api/utilisateurs', { login: 'x2', nom: 'X', profilId: tech })).status, 200);
    for (const [m, u] of [['GET', '/api/sauvegardes'], ['POST', '/api/sauvegardes'], ['GET', '/api/export'], ['POST', '/api/demo'], ['GET', '/api/systeme'], ['GET', '/api/systeme/reseau']]) {
      const r = m === 'GET' ? await rm.get(u) : await rm.post(u, {});
      assert.equal(r.status, 403, `${m} ${u} interdit au responsable maintenance`);
    }
    assert.equal((await info.get('/api/sauvegardes')).status, 200);
    assert.equal((await info.get('/api/systeme')).status, 200);
    // Le module système ne peut pas être désactivé
    const cfg = await admin.ok('PUT', '/api/configuration', { modules: { systeme: { actif: false } } });
    assert.equal(cfg.modules.systeme.actif, true);
  });

  test('réseau : accès navigateur et postes connectés', async () => {
    const info = srv.client();
    await info.login('info', 'pass1234');
    const r = await info.ok('GET', '/api/systeme/reseau');
    assert.equal(r.accesNavigateur, false);
    assert.ok(r.sessions.length >= 2);
    assert.ok(r.sessions.every((s) => /^[a-f0-9]{16}$/.test(s.id)), 'les jetons de session ne sont jamais exposés');
    assert.ok(!JSON.stringify(r).includes(Array.from(srv.app.sessions.map.keys())[0]));
    const autre = r.sessions.find((s) => !s.courante && s.login === 'resp');
    await info.ok('DELETE', '/api/systeme/sessions/' + autre.id);
    const rm = srv.client();
    await rm.login('resp', 'pass1234');
    assert.equal((await rm.put('/api/systeme/reseau', { accesNavigateur: true })).status, 403);
    assert.equal((await info.ok('PUT', '/api/systeme/reseau', { accesNavigateur: true })).accesNavigateur, true);
    await info.ok('PUT', '/api/systeme/reseau', { accesNavigateur: false });
  });

  test('mode bureau : les navigateurs web sont refusés sauf autorisation', async () => {
    const app = createApp({ inMemory: true, log: () => {}, bureau: true });
    const addr = await app.start(0);
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const nav = await fetch(base + '/', { headers: { 'user-agent': 'Mozilla/5.0 Edge' } });
      assert.equal(nav.status, 403);
      assert.match(await nav.text(), /application GMAO SICAF/);
      assert.equal((await fetch(base + '/api/auth/infos', { headers: { 'user-agent': 'Mozilla/5.0' } })).status, 403);
      assert.equal((await fetch(base + '/api/auth/infos', { headers: { 'user-agent': 'Mozilla/5.0 GMAO-SICAF-Bureau/1.0.3' } })).status, 200);
      const cfg = app.db.getConfig(); cfg.reseau.accesNavigateur = true; app.db.setConfig(cfg);
      assert.equal((await fetch(base + '/', { headers: { 'user-agent': 'Mozilla/5.0 Edge' } })).status, 200, 'autorisé par le pôle informatique');
    } finally { await app.stop(); }
    // Hors mode bureau (serveur de développement) : navigateur toujours autorisé
    assert.equal((await fetch(srv.base + '/', { headers: { 'user-agent': 'Mozilla/5.0' } })).status, 200);
  });
});
