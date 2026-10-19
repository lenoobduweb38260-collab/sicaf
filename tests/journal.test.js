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

  test('export CSV du journal : cellules commençant par = + - @ neutralisées (injection de formules)', async () => {
    srv.ctx.audit(null, 'modification', 'ot', 1, '=HYPERLINK("http://exemple.invalid";"Cliquer")');
    srv.ctx.audit(null, 'modification', 'ot', 1, '-12,5');
    const lignes = String((await admin.get('/api/audit/export?entite=ot')).body).split('\r\n');
    const ligne = lignes.find((l) => l.includes('HYPERLINK'));
    assert.ok(ligne, 'ligne exportée');
    assert.ok(ligne.includes(';"\'=HYPERLINK('), 'apostrophe devant = : ' + ligne);
    assert.ok(!/;"?=HYPERLINK/.test(ligne), 'aucune formule exécutable');
    assert.ok(lignes.some((l) => l.includes(';-12,5;')), 'un nombre négatif reste un nombre');
  });
});

describe('Notifications du journal : destinataires limités à ceux qui peuvent lire l\'élément', () => {
  let srv, admin, profils, secteurs;
  const profil = (n) => profils.find((p) => p.nom === n).id;
  const secteur = (c) => secteurs.find((s) => s.code === c).id;
  const notifs = (login, entite) => { const u = srv.db.findOne('users', (x) => x.login === login); return srv.db.list('notifications', (n) => n.userId === u.id && n.type === 'journal' && n.lien.includes('entite=' + entite)); };
  before(async () => {
    srv = await demarrer(); admin = srv.client(); await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    secteurs = await admin.ok('GET', '/api/secteurs');
    for (const [login, p, extra] of [['dem', 'Demandeur', {}], ['chefp', 'Chef de secteur', { secteurIds: [secteur('PROD')], overrides: { audit: { voir: true } } }], ['resp', 'Responsable maintenance', {}]]) {
      await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, profilId: profil(p), password: 'pass1234', doitChangerMdp: false }, extra));
    }
    await admin.ok('PUT', '/api/configuration', { journal: { notifications: true, actions: ['creation'], entites: [], profilsNotifies: [profil('Demandeur'), profil('Chef de secteur'), profil('Responsable maintenance')] } });
  });
  after(async () => { await srv.stop(); });

  test('un profil coché sans accès au journal ne reçoit rien ; la portée et le site de l\'élément s\'appliquent', async () => {
    const adminUser = srv.db.findOne('users', (u) => u.login === 'admin');
    const req = { user: adminUser, socket: { remoteAddress: '127.0.0.1' } };
    const cmd = srv.db.insert('commandes', { numero: 'CMD-2026-0013', secteurId: secteur('LOG'), statut: 'brouillon' });
    srv.ctx.audit(req, 'creation', 'commandes', cmd.id, 'Commande CMD-2026-0013 — Atlas Copco Service — 8 642,00 € HT');
    assert.equal(notifs('dem', 'commandes').length, 0, 'le Demandeur (sans accès au journal) n\'est pas notifié');
    assert.equal(notifs('chefp', 'commandes').length, 0, 'le chef de secteur PROD ne voit pas une commande de LOG');
    assert.equal(notifs('resp', 'commandes').length, 1, 'le responsable (journal, portée tous) est notifié');
    assert.match(notifs('resp', 'commandes')[0].message, /Atlas Copco/);
    const eq = srv.db.insert('equipements', { numero: 'EQ-N1', nom: 'Presse', secteurId: secteur('PROD'), actif: true });
    srv.ctx.audit(req, 'creation', 'equipements', eq.id, 'Équipement EQ-N1');
    assert.equal(notifs('chefp', 'equipements').length, 1, 'élément de son secteur : notifié');
    assert.equal(notifs('dem', 'equipements').length, 0);
    // La liste des profils de l'écran de configuration signale ceux qui n'ont pas accès au journal
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.references.profils.find((p) => p.nom === 'Demandeur').accesJournal, false);
    assert.equal(me.references.profils.find((p) => p.nom === 'Responsable maintenance').accesJournal, true);
  });

  test('journal : libellés de toutes les actions et de tous les éléments ; échec de connexion sans auteur', async () => {
    await srv.client().post('/api/auth/login', { login: 'admin', password: 'mauvais' });
    const j = await admin.ok('GET', '/api/audit?action=echec_connexion');
    assert.ok(j.lignes.length >= 1);
    assert.equal(j.lignes[0].userNom, 'Non connecté');
    assert.equal(j.lignes[0].userId, null);
    for (const a of ['echec_connexion', 'conversion', 'deconnexion', 'reception', 'renouvellement', 'compteur', 'document', 'export', 'desactivation', 'activation_double_auth', 'codes_secours']) assert.ok(j.libellesActions[a], a);
    for (const e of ['commandes', 'factures', 'inventaires', 'personnel', 'habilitations', 'absences', 'formations', 'visitesMedicales', 'sauvegardes', 'rapports', 'plans']) assert.ok(j.libellesEntites[e], e);
    assert.equal(j.libellesActions.conversion, 'Conversion en OT');
    assert.ok(Object.values(j.libellesActions).every((l) => /^[A-ZÉÈ]/.test(l)), 'libellés lisibles, avec majuscule');
  });
});
