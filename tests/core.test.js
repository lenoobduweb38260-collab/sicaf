'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Noyau : authentification, profils, utilisateurs, hiérarchie, configuration', () => {
  let srv, admin;
  before(async () => { srv = await demarrer(); admin = srv.client(); await admin.login('admin', 'admin'); });
  after(async () => { await srv.stop(); });

  test('refuse l\'accès sans session et sans en-tête anti-CSRF', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/auth/me')).status, 401);
    const r = await fetch(srv.base + '/api/auth/mot-de-passe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });

  test('connexion incorrecte puis blocage après trop de tentatives', async () => {
    const c = srv.client();
    let r;
    for (let i = 0; i < 9; i++) r = await c.post('/api/auth/login', { login: 'bloque', password: 'x' });
    assert.equal(r.status, 429);
  });

  test('amorçage : modules, catalogue, références', async () => {
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.user.login, 'admin');
    assert.equal(me.permissions.estAdmin, true);
    assert.equal(me.modules.length, 17);
    assert.ok(me.references.secteurs.length >= 5);
    assert.ok(me.references.profils.length >= 5);
    assert.ok(me.config.listes.statutsOT.length > 0);
  });

  test('profils : création avec matrice, tri par secteur, duplication, suppression', async () => {
    const secteurs = await admin.ok('GET', '/api/secteurs');
    const prod = secteurs.find((s) => s.code === 'PROD');
    const p = await admin.ok('POST', '/api/profils', { nom: 'Opérateur ligne', niveau: 6, portee: 'secteurs', secteurId: prod.id, permissions: { demandes: { creer: true }, equipements: { voir: true } } });
    assert.equal(p.permissions.demandes.voir, true, '« voir » est implicite dès qu\'une action est accordée');
    assert.equal(p.permissions.ot.voir, false);
    assert.equal(p.secteurNom, 'Production');
    const parSecteur = await admin.ok('GET', '/api/profils?tri=secteur');
    const idx = parSecteur.findIndex((x) => x.id === p.id);
    assert.ok(idx > 0 && parSecteur[0].secteurId == null, 'les profils transversaux viennent avant ceux rattachés à un secteur');
    const filtres = await admin.ok('GET', '/api/profils?secteurId=' + prod.id);
    assert.deepEqual(filtres.map((x) => x.id), [p.id]);
    const copie = await admin.ok('POST', `/api/profils/${p.id}/dupliquer`);
    assert.equal(copie.nom, 'Opérateur ligne (copie)');
    await admin.ok('DELETE', '/api/profils/' + copie.id);
    assert.equal((await admin.get('/api/profils/' + copie.id)).status, 404);
    assert.equal((await admin.del('/api/profils/1')).status, 400, 'le profil administrateur est protégé');
  });

  test('utilisateurs : création, surcharges (plus / moins), portée, hiérarchie', async () => {
    const profils = await admin.ok('GET', '/api/profils');
    const tech = profils.find((x) => x.nom === 'Technicien');
    const chef = profils.find((x) => x.nom === 'Chef de secteur');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    const prod = secteurs.find((s) => s.code === 'PROD');
    const maint = secteurs.find((s) => s.code === 'MAINT');

    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'jtech', nom: 'Tech', prenom: 'Jean', profilId: tech.id, secteurIds: [prod.id], password: 'tech1234', doitChangerMdp: false, overrides: { stock: { supprimer: true }, ot: { cloturer: false } } });
    assert.equal(u.passwordHash, undefined, 'le hachage n\'est jamais renvoyé');
    const eff = await admin.ok('GET', '/api/profils-effectifs/' + u.id);
    assert.equal(eff.modules.stock.supprimer, true, 'droit accordé en plus du profil');
    assert.equal(eff.modules.ot.cloturer, false, 'droit retiré par rapport au profil');
    assert.equal(eff.modules.ot.voir, true);
    assert.equal(eff.portee, 'secteurs');
    assert.deepEqual(eff.secteurIds, [prod.id]);

    // Le technicien ne voit pas les modules d'administration et ne peut pas créer d'utilisateur
    const t = srv.client();
    const boot = await t.login('jtech', 'tech1234');
    assert.equal(boot.permissions.modules.utilisateurs.voir, false);
    assert.equal((await t.get('/api/profils')).status, 403);
    assert.equal((await t.post('/api/utilisateurs', { login: 'x', nom: 'x', profilId: tech.id })).status, 403);
    // Il peut changer son propre mot de passe
    assert.equal((await t.post('/api/auth/mot-de-passe', { ancien: 'tech1234', nouveau: 'nouveau1' })).status, 200);

    // Chef de secteur : peut créer des utilisateurs de niveau inférieur uniquement, dans ses secteurs
    const c = await admin.ok('POST', '/api/utilisateurs', { login: 'chef', nom: 'Chef', profilId: chef.id, secteurIds: [prod.id], password: 'chef1234', doitChangerMdp: false, overrides: { utilisateurs: { creer: true, modifier: true } } });
    const cc = srv.client();
    await cc.login('chef', 'chef1234');
    assert.equal((await cc.post('/api/utilisateurs', { login: 'sup', nom: 'Sup', profilId: chef.id })).status, 403, 'niveau égal : refusé');
    assert.equal((await cc.post('/api/utilisateurs', { login: 'sup2', nom: 'Sup', profilId: tech.id, secteurIds: [maint.id] })).status, 403, 'secteur hors portée : refusé');
    const ok = await cc.post('/api/utilisateurs', { login: 'sup3', nom: 'Sup', profilId: tech.id, secteurIds: [prod.id], overrides: { configuration: { modifier: true } } });
    assert.equal(ok.status, 403, 'ne peut pas accorder un droit qu\'il n\'a pas');
    const ok2 = await cc.post('/api/utilisateurs', { login: 'sup3', nom: 'Sup', profilId: tech.id, secteurIds: [prod.id] });
    assert.equal(ok2.status, 200);
    assert.equal((await cc.put('/api/utilisateurs/1', { nom: 'Pirate' })).status, 403, 'ne peut pas modifier l\'administrateur');
    // Un utilisateur ne peut pas changer son propre profil
    await cc.put('/api/utilisateurs/' + c.id, { profilId: 1, nom: 'Chef' });
    assert.equal((await admin.ok('GET', '/api/utilisateurs/' + c.id)).profilId, chef.id);
    // Dernier administrateur protégé
    assert.equal((await admin.put('/api/utilisateurs/1', { profilId: tech.id })).status, 400);
    assert.equal((await admin.del('/api/utilisateurs/1')).status, 400);
  });

  test('secteurs : hiérarchie et portée incluant les sous-secteurs', async () => {
    const secteurs = await admin.ok('GET', '/api/secteurs');
    const prod = secteurs.find((s) => s.code === 'PROD');
    const ligne = await admin.ok('POST', '/api/secteurs', { nom: 'Ligne 9', code: 'L9', parentId: prod.id });
    assert.equal((await admin.put('/api/secteurs/' + prod.id, { parentId: ligne.id })).status, 400, 'cycle refusé');
    const u = (await admin.ok('GET', '/api/utilisateurs')).find((x) => x.login === 'jtech');
    const eff = await admin.ok('GET', '/api/profils-effectifs/' + u.id);
    assert.ok(eff.secteurIds.includes(ligne.id), 'le sous-secteur est inclus dans la portée');
    const arbre = await admin.ok('GET', '/api/secteurs-arbre');
    const trouver = (noeuds, id) => { for (const n of noeuds) { if (n.id === id) return n; const r = trouver(n.enfants || [], id); if (r) return r; } return null; };
    assert.ok(trouver(arbre, prod.id).enfants.some((e) => e.id === ligne.id));
    assert.equal((await admin.del('/api/secteurs/' + prod.id)).status, 400, 'suppression bloquée tant qu\'il y a des sous-secteurs');
  });

  test('configuration : modules désactivés / renommés, tri des profils par secteur, listes, champs perso', async () => {
    const cfg = await admin.ok('PUT', '/api/configuration', { modules: { planning: { actif: false, label: 'Agenda' }, configuration: { actif: false } }, profils: { triParSecteur: false, grouperParSecteur: false } });
    assert.equal(cfg.modules.planning.actif, false);
    assert.equal(cfg.modules.configuration.actif, true, 'la configuration ne peut pas être désactivée');
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.permissions.modules.planning.voir, false, 'un module désactivé est invisible même pour l\'administrateur');
    assert.equal(me.modules.find((m) => m.key === 'planning').label, 'Agenda');
    assert.equal(me.config.profils.triParSecteur, false);
    await admin.ok('PUT', '/api/configuration', { modules: { planning: { actif: true, label: '' } } });

    const r = await admin.put('/api/configuration', { listes: { priorites: [{ code: 'a', label: 'A' }, { code: 'a', label: 'B' }] } });
    assert.equal(r.status, 400, 'codes en double refusés');
    const cfg2 = await admin.ok('PUT', '/api/configuration', { listes: { priorites: [{ code: 'Faible !', label: 'Faible', couleur: '#000000', delaiHeures: 10 }, { code: 'forte', label: 'Forte' }] } });
    assert.equal(cfg2.listes.priorites[0].code, 'faible__');
    await admin.ok('POST', '/api/configuration/reinitialiser/listes');

    const cfg3 = await admin.ok('PUT', '/api/configuration', { champsPersonnalises: { utilisateurs: [{ label: 'Centre de coût', type: 'texte', obligatoire: true }, { label: 'Habilitation élec.', type: 'liste', options: 'B0;B1V;B2V' }] } });
    assert.equal(cfg3.champsPersonnalises.utilisateurs[0].cle, 'centre_de_cout');
    const profils = await admin.ok('GET', '/api/profils');
    const tech = profils.find((x) => x.nom === 'Technicien');
    const refus = await admin.post('/api/utilisateurs', { login: 'cc', nom: 'CC', profilId: tech.id });
    assert.equal(refus.status, 400, 'champ personnalisé obligatoire manquant');
    const okU = await admin.ok('POST', '/api/utilisateurs', { login: 'cc', nom: 'CC', profilId: tech.id, champs: { centre_de_cout: 'CC-12', habilitation_elec: 'B1V' } });
    assert.equal(okU.champs.centre_de_cout, 'CC-12');
    await admin.ok('PUT', '/api/configuration', { champsPersonnalises: { utilisateurs: [] } });
  });

  test('audit, notifications, sauvegardes (mode mémoire) et export', async () => {
    const audit = await admin.ok('GET', '/api/audit?entite=users');
    assert.ok(audit.total > 0);
    assert.ok(audit.lignes.every((l) => l.entite === 'users'));
    srv.ctx.notify([1], { titre: 'Test', message: 'Bonjour', lien: '#/ot' });
    const n = await admin.ok('GET', '/api/notifications');
    assert.equal(n.nonLues, 1);
    await admin.ok('POST', '/api/notifications/lues', {});
    assert.equal((await admin.ok('GET', '/api/notifications')).nonLues, 0);
    const exp = await admin.get('/api/export');
    assert.equal(exp.status, 200);
    assert.ok(exp.body.collections.users.length >= 1);
    const sys = await admin.ok('GET', '/api/systeme');
    assert.ok(sys.collections.some((c) => c.nom === 'users'));
  });

  test('numérotation configurable', async () => {
    const n1 = srv.db.nextNumber('ot', 'OT-{annee}-{num:4}');
    const n2 = srv.db.nextNumber('ot', 'OT-{annee}-{num:4}');
    assert.match(n1, /^OT-\d{4}-0001$/);
    assert.match(n2, /^OT-\d{4}-0002$/);
  });

  test('déconnexion invalide la session', async () => {
    const c = srv.client();
    await c.login('admin', 'admin');
    await c.ok('POST', '/api/auth/logout');
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});
