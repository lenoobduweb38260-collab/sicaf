'use strict';
/**
 * Sécurité du serveur : en-têtes, nom d'hôte (DNS rebinding), traversée de chemin, adresses
 * malformées, pollution de prototype, erreurs sans détail technique, politique de mot de passe,
 * blocage des comptes, sessions (inactivité, révocation), mot de passe initial généré.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { demarrer } = require('./helpers');
const auth = require('../server/auth');

/** Requête HTTP brute (en-tête Host et chemin libres). */
function brut(port, chemin, entetes = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: chemin, method: 'GET', headers: entetes }, (res) => {
      let corps = ''; res.on('data', (c) => { corps += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corps }));
    });
    req.on('error', reject); req.end();
  });
}

const MDP_ADMIN = 'Pompe-Centrale#2026';

describe('Sécurité', () => {
  let srv, admin, port;
  before(async () => {
    srv = await demarrer({ politiqueReelle: true });
    port = Number(new URL(srv.base).port);
    admin = srv.client();
    await admin.login('admin', 'admin');
    // Politique réelle : le mot de passe initial doit être changé avant toute autre opération
    assert.equal((await admin.get('/api/profils')).status, 403);
    await admin.ok('POST', '/api/auth/mot-de-passe', { nouveau: MDP_ADMIN });
  });
  after(async () => { await srv.stop(); });

  test('en-têtes de sécurité sur les pages et l\'API', async () => {
    for (const chemin of ['/', '/api/auth/infos']) {
      const r = await brut(port, chemin);
      assert.match(r.headers['content-security-policy'], /script-src 'self'/);
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
    }
    const infos = JSON.parse((await brut(port, '/api/auth/infos')).corps);
    assert.equal(infos.premierDemarrage, false, 'l\'aide « admin / admin » disparaît après la première connexion');
  });

  test('nom d\'hôte inconnu refusé (protection contre le DNS rebinding)', async () => {
    assert.equal((await brut(port, '/', { Host: 'attaquant.exemple.com' })).status, 421);
    assert.equal((await brut(port, '/api/auth/infos', { Host: 'localhost:' + port })).status, 200);
    assert.equal((await brut(port, '/api/auth/infos', { Host: '192.168.1.20:' + port })).status, 200);
    const cfg = srv.db.getConfig(); cfg.reseau.nomsAutorises = ['gmao.usine.local']; srv.db.setConfig(cfg);
    assert.equal((await brut(port, '/api/auth/infos', { Host: 'gmao.usine.local:' + port })).status, 200, 'nom déclaré par le pôle informatique');
  });

  test('traversée de chemin et adresses malformées sans plantage', async () => {
    for (const chemin of ['/../server/auth.js', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fdata%2fgmao.json', '/%E0%A4%A', '/%00', '/js/../../server/seed.js']) {
      const r = await brut(port, chemin);
      assert.ok([400, 403, 404].includes(r.status) || (r.status === 200 && r.corps.includes('<!DOCTYPE html>')), `${chemin} → ${r.status}`);
      assert.ok(!r.corps.includes('scrypt') && !r.corps.includes('require('), `${chemin} ne divulgue aucun fichier serveur`);
    }
    assert.equal((await brut(port, '/api/auth/infos')).status, 200, 'le serveur fonctionne toujours');
  });

  test('pollution de prototype impossible via le corps JSON', async () => {
    const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"login":"x","password":"y","__proto__":{"estAdmin":true},"constructor":{"prototype":{"pollue":1}}}' });
    assert.equal(r.status, 401);
    assert.equal({}.estAdmin, undefined);
    assert.equal({}.pollue, undefined);
  });

  test('erreurs internes sans détail technique', async () => {
    srv.ctx.router.get('/api/test-erreur', async () => { throw new Error('secret interne /chemin/serveur'); });
    const r = await admin.get('/api/test-erreur');
    assert.equal(r.status, 500);
    assert.match(r.body.erreur, /référence [0-9A-F]{8}/);
    assert.ok(!r.body.erreur.includes('secret'));
  });

  test('politique de mot de passe', () => {
    const cfg = srv.db.getConfig();
    assert.equal(cfg.securite.longueurMinMdp, 10);
    const v = (p, login) => auth.validerMotDePasse(p, cfg, { login });
    assert.match(v('Court1!'), /au moins 10/);
    assert.match(v('toutenminuscules'), /3 types/);
    assert.match(v('Azerty1234'), /courant/);
    assert.match(v('Jdupont-2026x', 'jdupont'), /identifiant/);
    assert.equal(v('Pompe-Hydraulique7'), null);
    for (let i = 0; i < 50; i++) assert.equal(v(auth.genererMotDePasse()), null, 'mot de passe généré conforme');
  });

  test('création de compte sans mot de passe : mot de passe aléatoire conforme renvoyé une seule fois', async () => {
    const profils = await admin.ok('GET', '/api/profils');
    const tech = profils.find((p) => p.nom === 'Technicien').id;
    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'nouveau', nom: 'Nouveau', profilId: tech });
    assert.equal(auth.validerMotDePasse(u.motDePasseInitial, srv.db.getConfig(), { login: 'nouveau' }), null);
    assert.equal((await admin.post('/api/utilisateurs', { login: 'faible', nom: 'F', profilId: tech, password: 'changeme' })).status, 400);
    const relu = await admin.ok('GET', '/api/utilisateurs/' + u.id);
    assert.equal(relu.motDePasseInitial, undefined);
    assert.equal(relu.passwordHash, undefined);
  });

  test('blocage du compte après des échecs répétés, journalisé et signalé au pôle informatique', async () => {
    const c = srv.client();
    let r;
    for (let i = 0; i < 9; i++) r = await c.post('/api/auth/login', { login: 'nouveau', password: 'mauvais' + i });
    assert.equal(r.status, 429);
    const journal = await admin.ok('GET', '/api/audit?action=echec_connexion');
    assert.ok(journal.total >= 8);
    assert.ok((await admin.ok('GET', '/api/audit?action=blocage')).total >= 1);
    const notifs = await admin.ok('GET', '/api/notifications');
    assert.ok(notifs.notifications.some((n) => /bloqué/.test(n.titre)), 'notification au pôle informatique');
    // Le blocage porte sur le compte, même depuis un autre poste (autre clé poste+identifiant)
    srv.app.sessions.tentatives.delete('127.0.0.1|nouveau');
    assert.equal((await srv.client().post('/api/auth/login', { login: 'nouveau', password: 'x' })).status, 429);
  });

  test('changer son mot de passe déconnecte les autres postes', async () => {
    const profils = await admin.ok('GET', '/api/profils');
    await admin.ok('POST', '/api/utilisateurs', { login: 'mobile', nom: 'M', profilId: profils.find((p) => p.nom === 'Technicien').id, password: 'Initial-Pass9', doitChangerMdp: false });
    const poste1 = srv.client(); const poste2 = srv.client();
    await poste1.login('mobile', 'Initial-Pass9'); await poste2.login('mobile', 'Initial-Pass9');
    assert.equal((await poste1.post('/api/auth/mot-de-passe', { ancien: 'Initial-Pass9', nouveau: 'Initial-Pass9' })).status, 400, 'nouveau = ancien refusé');
    await poste1.ok('POST', '/api/auth/mot-de-passe', { ancien: 'Initial-Pass9', nouveau: 'Nouveau-Pass42' });
    assert.equal((await poste1.get('/api/auth/me')).status, 200, 'le poste courant reste connecté');
    assert.equal((await poste2.get('/api/auth/me')).status, 401, 'les autres sessions sont fermées');
  });

  test('session expirée après inactivité', async () => {
    const c = srv.client();
    await c.login('admin', MDP_ADMIN);
    for (const s of srv.app.sessions.map.values()) s.lastSeen -= 2 * 60 * 60 * 1000; // 2 h sans activité (> 60 min)
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});
