'use strict';
/** Journal d'activité : notifications regroupées aux rôles responsables (config.journal). */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Journal d\'activité et notifications des responsables', () => {
  let srv, admin, profils, resp, info;
  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    const id = (n) => profils.find((p) => p.nom === n).id;
    for (const [login, profil] of [['resp', 'Responsable maintenance'], ['info', 'Pôle informatique'], ['tech', 'Technicien']]) {
      await admin.ok('POST', '/api/utilisateurs', { login, nom: login, profilId: id(profil), password: 'pass1234', doitChangerMdp: false });
    }
    resp = srv.client(); await resp.login('resp', 'pass1234');
    info = srv.client(); await info.login('info', 'pass1234');
  });
  after(async () => { await srv.stop(); });

  test('le module est renommé « Journal d\'activité » et les responsables sont les destinataires par défaut', async () => {
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.modules.find((m) => m.key === 'audit').label, 'Journal d\'activité');
    const ids = me.config.journal.profilsNotifies;
    assert.deepEqual(ids.slice().sort(), profils.filter((p) => ['Responsable maintenance', 'Pôle informatique'].includes(p.nom)).map((p) => p.id).sort());
  });

  test('une création notifie les responsables (pas l\'auteur), les créations suivantes sont regroupées', async () => {
    const tech = profils.find((p) => p.nom === 'Technicien').id;
    await admin.ok('POST', '/api/utilisateurs', { login: 'n1', nom: 'N1', profilId: tech, password: 'pass1234' });
    await admin.ok('POST', '/api/utilisateurs', { login: 'n2', nom: 'N2', profilId: tech, password: 'pass1234' });
    for (const c of [resp, info]) {
      const n = (await c.ok('GET', '/api/notifications')).notifications.filter((x) => x.type === 'journal' && /Création — Utilisateurs/.test(x.titre));
      assert.equal(n.length, 1, 'une seule notification regroupée');
      assert.match(n[0].titre, /\(\d+\)$/, 'compteur de regroupement');
      assert.match(n[0].lien, /^#\/audit\?entite=users&action=creation$/);
    }
    const adminNotifs = (await admin.ok('GET', '/api/notifications')).notifications.filter((x) => x.type === 'journal');
    assert.equal(adminNotifs.length, 0, 'l\'auteur (admin, non destinataire) n\'est pas notifié');
  });

  test('actions et entités filtrées, désactivation', async () => {
    await admin.ok('PUT', '/api/configuration', { journal: { actions: ['suppression'], entites: ['users'] } });
    const avant = (await resp.ok('GET', '/api/notifications')).notifications.length;
    await admin.ok('POST', '/api/secteurs', { nom: 'Zone test', type: 'zone', parentId: (await admin.ok('GET', '/api/secteurs')).find((s) => s.code === 'PROD').id });
    assert.equal((await resp.ok('GET', '/api/notifications')).notifications.length, avant, 'création de secteur non notifiée');
    await admin.ok('PUT', '/api/configuration', { journal: { notifications: false } });
    const u = (await admin.ok('GET', '/api/utilisateurs')).find((x) => x.login === 'n2');
    await admin.ok('DELETE', '/api/utilisateurs/' + u.id);
    assert.equal((await resp.ok('GET', '/api/notifications')).notifications.length, avant, 'notifications désactivées');
  });
});
