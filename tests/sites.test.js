'use strict';
/**
 * Multi-site : rattachement à un site, accès supplémentaires (lecture seule / complet),
 * filtre de site courant (en-tête X-GMAO-Site), refus d'écriture sur un site en lecture seule.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Multi-site', () => {
  let srv, admin, carpentras, valreas, prodC, prodV, eqC, eqV, profils;

  /** Client qui envoie l'en-tête de site choisi. */
  function clientSite(site) {
    const c = srv.client();
    const base = srv.base;
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'x-requested-with': 'GMAO', cookie };
      if (site != null) headers['x-gmao-site'] = String(site);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = txt; }
      return { status: r.status, body: data };
    };
    return Object.assign(c, {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b),
      async login(l, p) { const r = await call('POST', '/api/auth/login', { login: l, password: p }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body; },
      setSite(s) { site = s; },
    });
  }

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    carpentras = secteurs.find((s) => s.code === 'SITE');
    prodC = secteurs.find((s) => s.code === 'PROD');
    await admin.ok('PUT', '/api/secteurs/' + carpentras.id, { nom: 'Usine de Carpentras' });
    valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    prodV = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: valreas.id });
    profils = await admin.ok('GET', '/api/profils');
    // Équipements bruts (le module équipements peut être absent : insertion directe selon le modèle)
    eqC = srv.db.insert('equipements', { numero: 'EQ-C1', nom: 'Presse Carpentras', secteurId: prodC.id, actif: true });
    eqV = srv.db.insert('equipements', { numero: 'EQ-V1', nom: 'Presse Valréas', secteurId: prodV.id, actif: true });
  });
  after(async () => { await srv.stop(); });

  const profil = (nom) => profils.find((p) => p.nom === nom).id;

  test('les secteurs connaissent leur site et /api/sites liste les sites', async () => {
    const sites = await admin.ok('GET', '/api/sites');
    assert.deepEqual(sites.sites.map((s) => s.nom).sort(), ['Usine de Carpentras', 'Usine de Valréas']);
    assert.equal(sites.accessibles.length, 2);
    const s = await admin.ok('GET', '/api/secteurs/' + prodV.id);
    assert.equal(s.siteId, valreas.id);
    assert.equal(s.type, 'service');
  });

  test('portée « site » : un technicien de Carpentras ne voit pas Valréas sans autorisation', async () => {
    await admin.ok('POST', '/api/utilisateurs', { login: 'techc', nom: 'Tech C', profilId: profil('Technicien'), porteeOverride: 'site', secteurIds: [prodC.id], password: 'pass1234', doitChangerMdp: false });
    const t = clientSite(null);
    const boot = await t.login('techc', 'pass1234');
    assert.deepEqual(boot.permissions.sites.map((s) => s.id), [carpentras.id]);
    const eff = await admin.ok('GET', '/api/profils-effectifs/' + boot.user.id);
    assert.ok(eff.secteurIds.includes(prodC.id) && !eff.secteurIds.includes(prodV.id));
    assert.ok(srv.ctx.perms.canSeeRecord(eff, boot.user, eqC));
    assert.ok(!srv.ctx.perms.canSeeRecord(eff, boot.user, eqV));
  });

  test('accès en lecture seule à un autre site : visible mais non modifiable', async () => {
    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'chefc', nom: 'Chef C', profilId: profil('Chef de secteur'), secteurIds: [prodC.id], siteAcces: [{ siteId: valreas.id, mode: 'lecture' }], password: 'pass1234', doitChangerMdp: false });
    assert.deepEqual(u.siteAcces, [{ siteId: valreas.id, mode: 'lecture' }]);
    const c = clientSite(null);
    const boot = await c.login('chefc', 'pass1234');
    const v = boot.permissions.sites.find((s) => s.id === valreas.id);
    assert.equal(v.mode, 'lecture');
    const eff = boot.permissions;
    assert.ok(srv.ctx.perms.canSeeRecord(eff, boot.user, eqV), 'lecture autorisée');
    assert.ok(!srv.ctx.perms.canSeeRecord(eff, boot.user, eqV, { ecriture: true }), 'écriture refusée');
    assert.ok(srv.ctx.perms.canSeeRecord(eff, boot.user, eqC, { ecriture: true }), 'son propre site reste modifiable');
    // getVisible lève 403 en écriture sur le site en lecture seule
    const req = { perms: eff, user: boot.user, ecriture: true };
    assert.throws(() => srv.ctx.getVisible(req, 'equipements', eqV.id), (e) => e.status === 403);
    assert.equal(srv.ctx.getVisible(Object.assign({}, req, { ecriture: false }), 'equipements', eqV.id).id, eqV.id);
  });

  test('accès complet à un autre site', async () => {
    await admin.ok('POST', '/api/utilisateurs', { login: 'respc', nom: 'Resp C', profilId: profil('Chef de secteur'), secteurIds: [prodC.id], siteAcces: [{ siteId: valreas.id, mode: 'complet' }], password: 'pass1234', doitChangerMdp: false });
    const c = clientSite(null);
    const boot = await c.login('respc', 'pass1234');
    assert.equal(boot.permissions.sites.find((s) => s.id === valreas.id).mode, 'complet');
    assert.ok(srv.ctx.perms.canSeeRecord(boot.permissions, boot.user, eqV, { ecriture: true }));
  });

  test('filtre de site courant (en-tête) : seuls les éléments du site choisi', async () => {
    const c = clientSite(valreas.id);
    const boot = await c.login('admin', 'admin');
    assert.equal(boot.permissions.siteCourantId, valreas.id);
    assert.ok(!srv.ctx.perms.canSeeRecord(boot.permissions, boot.user, eqC));
    assert.ok(srv.ctx.perms.canSeeRecord(boot.permissions, boot.user, eqV));
    assert.ok(srv.ctx.perms.canSeeRecord(boot.permissions, boot.user, { id: 99, secteurId: null }), 'élément sans secteur toujours visible');
    // Un site non accessible dans l'en-tête est ignoré
    const t = clientSite(valreas.id);
    const bt = await t.login('techc', 'pass1234');
    assert.equal(bt.permissions.siteCourantId, null);
  });

  test('on ne peut accorder que les accès aux sites que l\'on possède', async () => {
    // Chef de secteur avec droit de créer des utilisateurs, accès Valréas en lecture seulement
    await admin.ok('POST', '/api/utilisateurs', { login: 'gest', nom: 'Gest', profilId: profil('Chef de secteur'), secteurIds: [prodC.id], siteAcces: [{ siteId: valreas.id, mode: 'lecture' }], overrides: { utilisateurs: { creer: true, modifier: true } }, password: 'pass1234', doitChangerMdp: false });
    const g = srv.client();
    await g.login('gest', 'pass1234');
    const base = { nom: 'X', profilId: profil('Technicien'), secteurIds: [prodC.id] };
    assert.equal((await g.post('/api/utilisateurs', Object.assign({ login: 'x1', siteAcces: [{ siteId: valreas.id, mode: 'complet' }] }, base))).status, 403);
    assert.equal((await g.post('/api/utilisateurs', Object.assign({ login: 'x2', siteAcces: [{ siteId: valreas.id, mode: 'lecture' }] }, base))).status, 200);
    // Un utilisateur ne peut pas modifier ses propres accès aux sites
    await g.put('/api/utilisateurs/' + (await admin.ok('GET', '/api/utilisateurs')).find((u) => u.login === 'gest').id, { nom: 'Gest', siteAcces: [{ siteId: valreas.id, mode: 'complet' }] });
    const apres = (await admin.ok('GET', '/api/utilisateurs')).find((u) => u.login === 'gest');
    assert.deepEqual(apres.siteAcces, [{ siteId: valreas.id, mode: 'lecture' }]);
  });

  test('gestion des secteurs : le responsable maintenance (Plans 3D › Modifier) gère ceux de son site uniquement', async () => {
    await admin.ok('POST', '/api/utilisateurs', { login: 'rm', nom: 'RM', profilId: profil('Responsable maintenance'), porteeOverride: 'site', secteurIds: [prodC.id], password: 'pass1234', doitChangerMdp: false });
    const r = srv.client();
    await r.login('rm', 'pass1234');
    const ligne = await r.post('/api/secteurs', { nom: 'Ligne 3', type: 'ligne', parentId: prodC.id });
    assert.equal(ligne.status, 200, JSON.stringify(ligne.body));
    assert.equal((await r.post('/api/secteurs', { nom: 'Ligne V', type: 'ligne', parentId: prodV.id })).status, 403, 'hors de son site');
    assert.equal((await r.post('/api/secteurs', { nom: 'Nouveau site', type: 'site' })).status, 403, 'nouveau site racine réservé');
  });

  test('les secrets de sauvegarde ne sont jamais renvoyés au navigateur', async () => {
    const cfg = srv.db.getConfig();
    cfg.sauvegardes.cleReception = 'SECRET-123';
    cfg.sauvegardes.destinations = [{ type: 'dossier', chemin: 'D:\\\\sauvegardes', cle: 'xyz' }];
    srv.db.setConfig(cfg);
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(JSON.stringify(me).includes('SECRET-123'), false);
    const c = await admin.ok('GET', '/api/configuration');
    assert.equal(JSON.stringify(c).includes('SECRET-123'), false);
    assert.equal(c.sauvegardes.cleReceptionDefinie, true);
    await admin.ok('PUT', '/api/configuration', { sauvegardes: { frequenceHeures: 12, cleReception: 'pirate', destinations: [] } });
    const apres = srv.db.getConfig().sauvegardes;
    assert.equal(apres.frequenceHeures, 12);
    assert.equal(apres.cleReception, 'SECRET-123', 'clé non modifiable par la configuration générale');
    assert.equal(apres.destinations.length, 1);
  });
});
