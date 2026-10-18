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
    assert.equal(me.modules.length, 19);
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
    const avant = (await admin.ok('GET', '/api/notifications')).nonLues;
    srv.ctx.notify([1], { titre: 'Test', message: 'Bonjour', lien: '#/ot' });
    const n = await admin.ok('GET', '/api/notifications');
    assert.equal(n.nonLues, avant + 1);
    assert.ok(n.notifications.some((x) => x.titre === 'Test' && x.lien === '#/ot'));
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

describe('Listes de valeurs : codes conservés et cohérence avec les données', () => {
  let srv, admin;
  before(async () => { srv = await demarrer(); admin = srv.client(); await admin.login('admin', 'admin'); });
  after(async () => { await srv.stop(); });
  const liste = (nom) => srv.db.getConfig().listes[nom];

  test('enregistrer une liste conserve la casse des codes existants (criticités A, B, C)', async () => {
    const eq = srv.db.insert('equipements', { numero: 'EQ-L1', nom: 'Presse', criticiteCode: 'A', actif: true });
    const items = liste('criticites').map((x) => (x.code === 'C' ? Object.assign({}, x, { couleur: '#000000' }) : x));
    const cfg = await admin.ok('PUT', '/api/configuration', { listes: { criticites: items } });
    assert.deepEqual(cfg.listes.criticites.map((x) => x.code), ['A', 'B', 'C'], 'codes existants inchangés');
    assert.equal(cfg.listes.criticites.find((x) => x.code === 'C').couleur, '#000000');
    // Un nouveau code est normalisé (minuscules)
    const cfg2 = await admin.ok('PUT', '/api/configuration', { listes: { criticites: items.concat([{ code: 'D Nouveau', label: 'D' }]) } });
    assert.equal(cfg2.listes.criticites[3].code, 'd_nouveau');
    assert.equal(srv.db.get('equipements', eq.id).criticiteCode, 'A');
  });

  test('un code utilisé par des éléments ne peut être ni supprimé, ni renommé, ni changer de caractère final', async () => {
    srv.db.insert('ot', { numero: 'OT-L1', titre: 'Graissage', statut: 'termine' });
    srv.db.insert('equipements', { numero: 'EQ-L2', nom: 'Compresseur', typeCode: 'machine', actif: true });
    const statuts = liste('statutsOT');
    // « termine » renommé « cloture » : refusé (les OT clôturés redeviendraient ouverts)
    let r = await admin.put('/api/configuration', { listes: { statutsOT: statuts.map((x) => (x.code === 'termine' ? Object.assign({}, x, { code: 'cloture' }) : x)) } });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /termine/);
    // Libellé et couleur modifiables
    const ok = await admin.ok('PUT', '/api/configuration', { listes: { statutsOT: statuts.map((x) => (x.code === 'termine' ? Object.assign({}, x, { label: 'Réalisé', couleur: '#15803d' }) : x)) } });
    assert.equal(ok.listes.statutsOT.find((x) => x.code === 'termine').label, 'Réalisé');
    // Type d'équipement utilisé : suppression refusée, avec le nombre d'éléments
    r = await admin.put('/api/configuration', { listes: { typesEquipement: liste('typesEquipement').filter((x) => x.code !== 'machine') } });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /1 équipement/);
    // Code personnalisé utilisé : son caractère final ne change pas
    await admin.ok('PUT', '/api/configuration', { listes: { statutsOT: liste('statutsOT').concat([{ code: 'archive', label: 'Archivé', final: true }]) } });
    srv.db.insert('ot', { numero: 'OT-L2', titre: 'Ancien', statut: 'archive' });
    r = await admin.put('/api/configuration', { listes: { statutsOT: liste('statutsOT').map((x) => (x.code === 'archive' ? Object.assign({}, x, { final: false }) : x)) } });
    assert.equal(r.status, 400);
    // Valeur non utilisée : suppression permise
    await admin.ok('PUT', '/api/configuration', { listes: { typesEquipement: liste('typesEquipement').filter((x) => x.code !== 'vehicule') } });
    assert.equal(liste('typesEquipement').some((x) => x.code === 'vehicule'), false);
    // Les usages sont consultables pour l'écran des listes
    const u = await admin.ok('GET', '/api/configuration/listes/statutsOT/usages');
    assert.equal(u.usages.termine.total, 1);
    assert.ok(u.proteges.includes('termine') && u.proteges.includes('annule'));
  });

  test('statuts du circuit protégés ; au moins un statut final (et, pour les OT, autre qu\'une annulation)', async () => {
    const statuts = liste('statutsDemande');
    let r = await admin.put('/api/configuration', { listes: { statutsDemande: statuts.filter((x) => x.code !== 'convertie') } });
    assert.equal(r.status, 400, 'statut du circuit non supprimable même inutilisé');
    r = await admin.put('/api/configuration', { listes: { statutsDemande: statuts.map((x) => (x.code === 'cloturee' ? Object.assign({}, x, { final: false }) : x)) } });
    assert.equal(r.status, 400, 'caractère final du circuit figé');
    r = await admin.put('/api/configuration', { listes: { priorites: [{ code: 'x', label: 'X', final: false }] } });
    assert.equal(r.status, 400, 'aucun statut final');
    assert.match(r.body.erreur, /au moins un statut final/);
    // Rétablir les listes par défaut conserve les codes personnalisés encore utilisés
    await admin.ok('POST', '/api/configuration/reinitialiser/listes');
    assert.ok(liste('statutsOT').some((x) => x.code === 'archive'), 'code utilisé conservé');
    assert.ok(liste('typesEquipement').some((x) => x.code === 'vehicule'), 'valeurs par défaut rétablies');
    assert.equal(liste('criticites').some((x) => x.code === 'd_nouveau'), false, 'code inutilisé retiré');
  });
});

describe('Profils fournis : le Demandeur n\'a pas les droits d\'un encadrant', () => {
  test('profil Demandeur sans Demandes › Modifier, base existante corrigée une seule fois', async () => {
    const { profilsParDefaut, seed } = require('../server/seed');
    const dem = profilsParDefaut().find((p) => p.nom === 'Demandeur');
    assert.equal(dem.permissions.demandes.modifier, false);
    assert.equal(dem.permissions.demandes.creer, true);
    const { Db } = require('../server/db');
    const db = new Db(require('os').tmpdir(), { inMemory: true }).load();
    seed(db);
    const p = db.findOne('profils', (x) => x.nom === 'Demandeur');
    // Base antérieure : droit présent, migration pas encore passée
    db.update('profils', p.id, { permissions: Object.assign({}, p.permissions, { demandes: Object.assign({}, p.permissions.demandes, { modifier: true }) }) });
    delete db.data.meta.migrations.demandeurSansModifier;
    seed(db);
    assert.equal(db.get('profils', p.id).permissions.demandes.modifier, false, 'droit retiré du profil fourni');
    // Un choix ultérieur du pôle informatique est respecté
    db.update('profils', p.id, { permissions: Object.assign({}, p.permissions, { demandes: Object.assign({}, p.permissions.demandes, { modifier: true }) }) });
    seed(db);
    assert.equal(db.get('profils', p.id).permissions.demandes.modifier, true);
  });
});

describe('Import, export et restauration de la base', () => {
  let srv, admin, info, dir, profils;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmao-import-'));
    srv = await demarrer({ inMemory: false, dataDir: dir, saveDelay: 0 });
    admin = srv.client(); await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    await admin.ok('POST', '/api/utilisateurs', { login: 'infosite', nom: 'Info site', profilId: profils.find((p) => p.nom === 'Pôle informatique').id, porteeOverride: 'site', secteurIds: [secteurs.find((s) => s.code === 'PROD').id], password: 'info1234', doitChangerMdp: false });
    info = srv.client(); await info.login('infosite', 'info1234');
    const cfg = srv.db.getConfig();
    cfg.sauvegardes = Object.assign({}, cfg.sauvegardes, { motDePasseChiffrement: 'Secret-Chiffrement-42', cleReception: 'sha256:cle-reception', cleReceptionDate: '2026-01-01', destinations: [{ id: 1, nom: 'Valréas', type: 'serveur', cle: 'CLE-DE-VALREAS', secteurId: null }] });
    srv.db.setConfig(cfg);
    srv.db.insert('equipements', { numero: 'EQ-I1', nom: 'Presse à importer', actif: true });
  });
  after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('export : complet, sans les secrets des sauvegardes ni les codes de réinitialisation, réservé à l\'accès tous sites', async () => {
    const r = await admin.get('/api/export');
    assert.equal(r.status, 200);
    for (const secret of ['Secret-Chiffrement-42', 'CLE-DE-VALREAS', 'cle-reception']) assert.equal(JSON.stringify(r.body).includes(secret), false, secret);
    assert.ok(r.body.collections.equipements.some((e) => e.numero === 'EQ-I1'));
    assert.deepEqual(r.body.config.sauvegardes.destinations, []);
    assert.equal((await info.get('/api/export')).status, 403, 'utilisateur limité à son site');
  });

  test('import : fichier mal formé ou partiel refusé sans rien remplacer ; aperçu ; réservé à l\'accès tous sites', async () => {
    const base = (await admin.get('/api/export')).body;
    for (const [corps, motif] of [
      [{ collections: 'x' }, /collections absentes/],
      [{ collections: { ot: [] } }, /« users » est absente/],
      [Object.assign({}, base, { collections: Object.assign({}, base.collections, { equipements: [{ nom: 'sans id' }] }) }), /sans identifiant valide/],
      [Object.assign({}, base, { collections: Object.assign({}, base.collections, { users: base.collections.users.map((u) => Object.assign({}, u, { actif: false })) }) }), /administrateur actif/],
    ]) {
      const r = await admin.post('/api/import', corps);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.erreur, motif);
    }
    assert.equal(srv.db.count('equipements', (e) => e.numero === 'EQ-I1'), 1, 'base intacte');
    assert.equal((await admin.get('/api/auth/me')).status, 200, 'session conservée');
    const apercu = await admin.ok('POST', '/api/import?apercu=1', base);
    assert.equal(apercu.apercu, true);
    assert.equal(apercu.volumes.equipements, 1);
    assert.equal((await info.post('/api/import', base)).status, 403, 'utilisateur limité à son site');
  });

  test('import valide : base remplacée, copie préalable, paramètres de sauvegarde de ce serveur conservés', async () => {
    const base = (await admin.get('/api/export')).body;
    base.collections.equipements.push({ id: 999, numero: 'EQ-I2', nom: 'Importé', actif: true });
    const r = await admin.ok('POST', '/api/import', base);
    assert.equal(r.volumes.equipements, 2);
    assert.equal(srv.db.count('equipements'), 2);
    const s = srv.db.getConfig().sauvegardes;
    assert.equal(s.motDePasseChiffrement, 'Secret-Chiffrement-42', 'mot de passe de chiffrement conservé');
    assert.equal(s.destinations.length, 1, 'destinations conservées');
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => /avant-import/.test(f)));
    admin = srv.client(); await admin.login('admin', 'admin');
    info = srv.client(); await info.login('infosite', 'info1234');
  });

  test('restauration (sauvegardes du dossier) : nom invalide ou inconnu → 400 / 404, accès tous sites, secrets conservés', async () => {
    assert.equal((await admin.post('/api/sauvegardes/restaurer', { nom: '../../../etc/passwd' })).status, 400);
    assert.equal((await admin.post('/api/sauvegardes/restaurer', { nom: { a: 1 } })).status, 400);
    assert.equal((await admin.post('/api/sauvegardes/restaurer', { nom: 'inexistant.json' })).status, 404);
    // Copie sans secrets (comme celles du module sauvegardes) dans le dossier des sauvegardes
    const exp = (await admin.get('/api/export')).body;
    fs.writeFileSync(path.join(dir, 'backups', 'gmao-copie-sans-secrets.json'), JSON.stringify(exp));
    fs.writeFileSync(path.join(dir, 'backups', 'gmao-illisible.json'), '{ pas du json');
    assert.equal((await admin.post('/api/sauvegardes/restaurer', { nom: 'gmao-illisible.json' })).status, 400);
    assert.equal((await info.post('/api/sauvegardes/restaurer', { nom: 'gmao-copie-sans-secrets.json' })).status, 403, 'utilisateur limité à son site');
    const r = await admin.ok('POST', '/api/sauvegardes/restaurer', { nom: 'gmao-copie-sans-secrets.json' });
    assert.equal(r.sessionConservee, true);
    const s = srv.db.getConfig().sauvegardes;
    assert.equal(s.motDePasseChiffrement, 'Secret-Chiffrement-42');
    assert.equal(s.destinations.length, 1);
    assert.equal((await info.get('/api/auth/me')).status, 401, 'autres sessions fermées');
  });
});

describe('Pièces jointes volumineuses : hors du fichier principal, quota global', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { Db, SEUIL_PIECE } = require('../server/db');

  test('écrites à part une seule fois, relues au redémarrage, comprises dans l\'export ; écriture en échec sans arrêt du serveur', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmao-pieces-'));
    try {
      const db = new Db(dir, { saveDelay: 0, log: () => {} }).load();
      const photo = 'data:image/jpeg;base64,' + 'Q'.repeat(SEUIL_PIECE + 10);
      const e = db.insert('equipements', { nom: 'Presse', documents: [{ nom: 'photo.jpg', contenu: photo }, { nom: 'note.txt', contenu: 'data:text/plain;base64,QQ==' }] });
      db.insert('demandes', { titre: 'Même photo', pieceJointes: [{ nom: 'photo.jpg', contenu: photo }] });
      db.saveNow();
      const brut = fs.readFileSync(path.join(dir, 'gmao.json'), 'utf8');
      assert.ok(brut.length < 20000, 'fichier principal sans le contenu des photos');
      assert.ok(brut.includes('data:text/plain;base64,QQ=='), 'petites pièces conservées dans le fichier');
      assert.equal(fs.readdirSync(path.join(dir, 'pieces')).length, 1, 'contenu identique écrit une seule fois');
      assert.equal(db.taillePieces(), photo.length);
      assert.equal(db.taillePiecesNouvelles({ a: photo }), 0, 'pièce déjà présente');
      assert.equal(db.taillePiecesNouvelles({ a: photo + 'x' }), photo.length + 1);
      const db2 = new Db(dir).load();
      assert.equal(db2.get('equipements', e.id).documents[0].contenu, photo, 'relue au redémarrage');
      const morceaux = [];
      await db2.exporterParMorceaux((t) => { morceaux.push(t); });
      assert.equal(JSON.parse(morceaux.join('')).collections.equipements[0].documents[0].contenu, photo, 'export autonome');
      assert.equal(db2.exportAll().collections.demandes[0].pieceJointes[0].contenu, photo);
      // Référence forgée vers un fichier hors du dossier des pièces : jamais lue
      db2.importAll({ collections: { users: [], equipements: [{ id: 1, documents: [{ contenu: { $pieceGmao: '../gmao.json', octets: 1 } }] }] } });
      assert.equal(db2.get('equipements', 1).documents[0].contenu, '');
      // Écriture impossible (dossier remplacé par un fichier) : erreur signalée, données conservées, aucune exception
      const db3 = new Db(path.join(dir, 'gmao.json'), { saveDelay: 1, log: () => {} });
      let signalee = null;
      db3.onErreurEcriture = (err) => { signalee = err; };
      db3.insert('ot', { titre: 'En mémoire' });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(signalee, 'erreur d\'écriture signalée');
      assert.equal(db3.count('ot'), 1);
      clearTimeout(db3._timer);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('quota global : au-delà, les nouvelles pièces jointes sont refusées (413) avec un message', async () => {
    const srv = await demarrer();
    try {
      const admin = srv.client(); await admin.login('admin', 'admin');
      const cfg = srv.db.getConfig(); cfg.general.quotaPiecesJointesMo = 50; srv.db.setConfig(cfg);
      // 50 Mo déjà occupés par des pièces jointes
      const gros = 'data:application/pdf;base64,' + 'A'.repeat(50 * 1024 * 1024);
      srv.db.insert('equipements', { nom: 'Archives', documents: [{ nom: 'plans.pdf', contenu: gros }] });
      const photo = 'data:image/png;base64,' + 'B'.repeat(SEUIL_PIECE);
      const r = await admin.put('/api/configuration', { societe: { logo: photo } });
      assert.equal(r.status, 413);
      assert.match(r.body.erreur, /Espace réservé aux pièces jointes plein/);
      assert.equal((await admin.put('/api/configuration', { societe: { slogan: 'Sans pièce jointe' } })).status, 200, 'requêtes sans pièce jointe acceptées');
      const sys = await admin.ok('GET', '/api/systeme');
      assert.equal(sys.piecesJointes.quotaMo, 50);
      assert.equal((await admin.put('/api/configuration', { general: { quotaPiecesJointesMo: 10 } })).status, 400, 'borne minimale');
    } finally { await srv.stop(); }
  });
});

describe('Options des modules : valeurs permises et bornes', () => {
  let srv, admin;
  before(async () => { srv = await demarrer(); admin = srv.client(); await admin.login('admin', 'admin'); });
  after(async () => { await srv.stop(); });

  test('codes inconnus, valeurs hors bornes et oui / non mal typés refusés ; valeurs correctes enregistrées', async () => {
    for (const [corps, motif] of [
      [{ plans: { uniteAffichage: 'km' } }, /plans\.uniteAffichage/],
      [{ plans: { couleurParDefaut: '#ff0000' } }, /plans\.couleurParDefaut/],
      [{ inventaire: { modeScan: 'rafale' } }, /inventaire\.modeScan/],
      [{ etiquettes: { format: 'a3-inconnu' } }, /etiquettes\.format/],
      [{ visites: { rappelJoursAvant: 90 } }, /entre 0 et 60/],
      [{ visites: { conserverVisiteursJours: 0 } }, /entre 1 et 3650/],
      [{ achats: { entreeStockAReception: 'false' } }, /oui \/ non/],
    ]) {
      const r = await admin.put('/api/configuration', corps);
      assert.equal(r.status, 400, JSON.stringify(corps));
      assert.match(r.body.erreur, motif);
    }
    const c = await admin.ok('PUT', '/api/configuration', { plans: { uniteAffichage: 'cm', couleurParDefaut: 'criticite', grilleM: 0.25 }, visites: { rappelJoursAvant: 5 }, achats: { entreeStockAReception: false } });
    assert.equal(c.plans.uniteAffichage, 'cm');
    assert.equal(c.plans.grilleM, 0.25);
    assert.equal(c.visites.rappelJoursAvant, 5);
    assert.equal(c.achats.entreeStockAReception, false);
  });

  test('nouvelles listes et entités par défaut (statuts RH et d\'inventaire, modes de paiement, plans préventifs)', async () => {
    const c = await admin.ok('GET', '/api/configuration');
    for (const l of ['statutsAbsence', 'statutsFormation', 'typesVisiteMedicale', 'aptitudesMedicales', 'statutsInventaire', 'modesPaiement']) assert.ok(c.listes[l].length > 0, l);
    assert.ok(Array.isArray(c.champsPersonnalises.plansPreventifs));
    assert.equal((await admin.put('/api/configuration', { listes: { statutsAbsence: c.listes.statutsAbsence.filter((x) => x.code !== 'refusee') } })).status, 400, 'codes du circuit RH figés');
    const lib = await admin.ok('PUT', '/api/configuration', { listes: { statutsAbsence: c.listes.statutsAbsence.map((x) => Object.assign({}, x, { label: x.label + ' (RH)' })) } });
    assert.match(lib.listes.statutsAbsence[0].label, /\(RH\)$/);
  });
});

describe('Secteurs, portée et crochets du cœur (constats de revue)', () => {
  let srv, admin, profils, secteurs;
  const profil = (n) => profils.find((p) => p.nom === n).id;
  const secteur = (c) => secteurs.find((s) => s.code === c);
  async function compte(login, nomProfil, extra = {}) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, profilId: profil(nomProfil), password: login + '-mdp', doitChangerMdp: false }, extra));
    const c = srv.client(); await c.login(login, login + '-mdp'); return c;
  }
  before(async () => {
    srv = await demarrer(); admin = srv.client(); await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    secteurs = await admin.ok('GET', '/api/secteurs');
  });
  after(async () => { await srv.stop(); });

  test('un secteur ne peut pas être détaché de son site par un utilisateur limité à son périmètre (Plans 3D ou Configuration › Modifier)', async () => {
    const prod = secteur('PROD');
    const chef = await compte('chef_plans', 'Chef de secteur', { secteurIds: [prod.id], overrides: { plans: { modifier: true } } });
    let r = await chef.put('/api/secteurs/' + prod.id, { parentId: null, type: 'site' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await chef.put('/api/secteurs/' + prod.id, { parentId: null });
    assert.equal(r.status, 403);
    // Même avec Configuration › Modifier, sans accès à tous les sites
    await admin.ok('POST', '/api/profils', { nom: 'Paramétreur de secteur', niveau: 3, portee: 'secteurs', permissions: { configuration: { voir: true, modifier: true } } });
    profils = await admin.ok('GET', '/api/profils');
    const param = await compte('param_secteur', 'Paramétreur de secteur', { secteurIds: [prod.id] });
    r = await param.put('/api/secteurs/' + prod.id, { parentId: null, type: 'site' });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /tous les sites/);
    const apres = srv.db.get('secteurs', prod.id);
    assert.equal(apres.parentId, prod.parentId, 'parent inchangé');
    assert.equal(apres.type, 'service');
    assert.equal(srv.ctx.siteDuSecteur(prod.id), secteur('SITE').id);
    // Le chef renomme toujours son secteur (Plans 3D › Modifier)
    assert.equal((await chef.put('/api/secteurs/' + prod.id, { nom: 'Production (atelier)' })).status, 200);
    await admin.ok('PUT', '/api/secteurs/' + prod.id, { nom: 'Production' });
  });

  test('supprimer un secteur référencé par des articles, plans préventifs ou commandes est refusé sans ?forcer=1, qui rattache au parent', async () => {
    const log = secteur('LOG');
    const mag = await admin.ok('POST', '/api/secteurs', { nom: 'Magasin B', code: 'MAGB', type: 'magasin', parentId: log.id });
    const art = srv.db.insert('articles', { code: 'ART-MB', designation: 'Roulement', secteurId: mag.id, actif: true, quantite: 1 });
    const pp = srv.db.insert('plansPreventifs', { numero: 'PP-MB', nom: 'Graissage', secteurId: mag.id, actif: true });
    const cmd = srv.db.insert('commandes', { numero: 'CMD-MB', secteurId: mag.id, statut: 'brouillon' });
    const r = await admin.del('/api/secteurs/' + mag.id);
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /1 article\(s\) de stock/);
    assert.match(r.body.erreur, /1 plan\(s\) préventif\(s\)/);
    assert.match(r.body.erreur, /1 commande\(s\)/);
    assert.ok(srv.db.get('secteurs', mag.id), 'secteur conservé');
    const ok = await admin.ok('DELETE', `/api/secteurs/${mag.id}?forcer=1`);
    assert.equal(ok.rattachesA, log.id);
    assert.equal(srv.db.get('articles', art.id).secteurId, log.id);
    assert.equal(srv.db.get('plansPreventifs', pp.id).secteurId, log.id);
    assert.equal(srv.db.get('commandes', cmd.id).secteurId, log.id);
    // Visible avec le site choisi dans l'en-tête (plus aucun secteur orphelin)
    const perms = require('../server/permissions');
    const u = srv.db.findOne('users', (x) => x.login === 'admin');
    const p = perms.effectivePermissions(srv.db, u, null, srv.db.getConfig());
    perms.appliquerSiteCourant(srv.db, p, String(secteur('SITE').id));
    assert.equal(perms.canSeeRecord(p, u, srv.db.get('articles', art.id)), true);
  });

  test('portée « secteurs » : l\'intervenant désigné voit l\'OT ou le plan qui lui est affecté hors de ses secteurs', async () => {
    const perms = require('../server/permissions');
    await compte('tech_maint', 'Technicien', { secteurIds: [secteur('MAINT').id] });
    const u = srv.db.findOne('users', (x) => x.login === 'tech_maint');
    const p = perms.effectivePermissions(srv.db, u, null, srv.db.getConfig());
    const prod = secteur('PROD').id;
    const affecte = srv.db.insert('ot', { numero: 'OT-A', titre: 'Affecté', secteurId: prod, statut: 'nouveau', technicienId: u.id });
    const equipe = srv.db.insert('ot', { numero: 'OT-E', titre: 'En équipe', secteurId: prod, statut: 'nouveau', techniciens: [99, u.id] });
    const autre = srv.db.insert('ot', { numero: 'OT-X', titre: 'Autre', secteurId: prod, statut: 'nouveau', technicienId: 99 });
    const req = { user: u, perms: p, ecriture: false };
    assert.deepEqual(srv.ctx.scope(req, [affecte, equipe, autre]).map((o) => o.numero), ['OT-A', 'OT-E']);
    assert.equal(perms.canSeeRecord(p, u, affecte, { ecriture: true }), true, 'il peut aussi y intervenir');
    assert.equal(perms.canSeeRecord(p, u, autre), false);
    // Le site choisi dans l'en-tête filtre toujours
    const filtre = perms.effectivePermissions(srv.db, u, null, srv.db.getConfig());
    filtre.siteFiltre = [];
    assert.equal(perms.canSeeRecord(filtre, u, affecte), false);
  });

  test('section sauvegardes : non réinitialisable depuis Configuration ; paramètres réservés à Système › Modifier, bornes et chiffrement contrôlés', async () => {
    const cfg = srv.db.getConfig();
    cfg.sauvegardes = Object.assign({}, cfg.sauvegardes, { motDePasseChiffrement: '', cleReception: 'sha256:cle', destinations: [{ id: 1, type: 'serveur', nom: 'Valréas', cle: 'CLE-VAL' }], automatique: true, frequenceHeures: 24 });
    srv.db.setConfig(cfg);
    await admin.ok('POST', '/api/profils', { nom: 'Paramétreur', niveau: 3, portee: 'tous', permissions: { configuration: { voir: true, modifier: true } } });
    profils = await admin.ok('GET', '/api/profils');
    const param = await compte('param', 'Paramétreur');
    for (const c of [param, admin]) {
      const r = await c.post('/api/configuration/reinitialiser/sauvegardes');
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /Système & informatique/);
      assert.equal((await c.post('/api/configuration/reinitialiser/reseau')).status, 400);
    }
    let s = srv.db.getConfig().sauvegardes;
    assert.equal(s.destinations.length, 1, 'destinations conservées');
    assert.equal(s.cleReception, 'sha256:cle', 'clé de réception conservée');
    // Configuration › Modifier seul : aucun paramètre de sauvegarde modifiable
    const r = await param.put('/api/configuration', { sauvegardes: { automatique: false, accepterReception: true, chiffrer: true, frequenceHeures: -5, conserverLocal: -1 } });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Système › Modifier/);
    s = srv.db.getConfig().sauvegardes;
    assert.equal(s.automatique, true); assert.equal(!!s.accepterReception, false); assert.equal(s.chiffrer, false); assert.equal(s.frequenceHeures, 24);
    // Système › Modifier : bornes et invariant « chiffrement ⇒ mot de passe »
    assert.equal((await admin.put('/api/configuration', { sauvegardes: { frequenceHeures: -5 } })).status, 400);
    assert.equal((await admin.put('/api/configuration', { sauvegardes: { conserverLocal: -1 } })).status, 400);
    assert.equal((await admin.put('/api/configuration', { sauvegardes: { automatique: 'false' } })).status, 400);
    const chiffre = await admin.put('/api/configuration', { sauvegardes: { chiffrer: true } });
    assert.equal(chiffre.status, 400);
    assert.match(chiffre.body.erreur, /mot de passe de chiffrement/);
    const ok = await admin.ok('PUT', '/api/configuration', { sauvegardes: { automatique: false, frequenceHeures: 12, cleReception: 'pirate', motDePasseChiffrement: 'pirate' } });
    assert.equal(ok.sauvegardes.frequenceHeures, 12);
    assert.equal(ok.sauvegardes.cleReception, undefined, 'secret jamais renvoyé');
    s = srv.db.getConfig().sauvegardes;
    assert.equal(s.cleReception, 'sha256:cle', 'secret jamais modifié par cette route');
    assert.equal(s.motDePasseChiffrement, '');
    const vue = await param.ok('GET', '/api/configuration');
    assert.equal(vue.sauvegardes.cleReceptionDefinie, true);
    assert.equal(vue.sauvegardes.nbDestinations, 1);
    assert.ok(!JSON.stringify(vue).includes('CLE-VAL'));
  });

  test('amorçage : libellés du journal transmis aux vues ; crochets onArret et avantCorps', async () => {
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.libelles.actions.echec_connexion, 'Échec de connexion');
    assert.equal(me.libelles.entites.commandes, 'Commandes fournisseurs');
    // avantCorps : contrôle avant la lecture du corps d'une route brute publique
    let corpsVu = 'non appelé';
    srv.ctx.router.post('/api/test-avant-corps', async (req) => ({ taille: req.body.length }), {
      public: true, brut: true, maxBody: 1024 * 1024,
      avantCorps: (req) => { corpsVu = req.body; if (req.headers['x-cle'] !== 'bonne') throw new srv.ctx.HttpError(403, 'Clé invalide'); },
    });
    const envoyer = (cle) => fetch(srv.base + '/api/test-avant-corps', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-cle': cle }, body: Buffer.alloc(300 * 1024, 65) });
    let r = await envoyer('mauvaise');
    assert.equal(r.status, 403);
    assert.equal(corpsVu, undefined, 'corps non lu avant le contrôle');
    r = await envoyer('bonne');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).taille, 300 * 1024);
    // onArret : appelé par app.stop()
    const autre = await demarrer();
    let arrete = false;
    autre.ctx.onArret(() => { arrete = true; });
    await autre.stop();
    assert.equal(arrete, true);
  });
});
