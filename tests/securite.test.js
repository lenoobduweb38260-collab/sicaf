'use strict';
/**
 * Sécurité du serveur : en-têtes, nom d'hôte (DNS rebinding), traversée de chemin, adresses
 * malformées, pollution de prototype, erreurs sans détail technique, politique de mot de passe,
 * blocage des comptes, sessions (inactivité, révocation), mot de passe initial généré ; secrets de ce
 * serveur (sauvegardes, codes de réinitialisation) absents des copies, sauvegardes et exports.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demarrer } = require('./helpers');
const auth = require('../server/auth');
const { Db } = require('../server/db');
const { decoder } = require('../server/modules/sauvegardes');

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

describe('Secrets de ce serveur : jamais dans une copie, une sauvegarde ou un export', () => {
  const MDP_CHIFFREMENT = 'Secret-Chiffrement-2026';
  const CLE_DISTANTE = 'gmao_cle_de_reception_du_site_distant_XYZ';
  let srv, admin, dataDir, dossier, tech;
  const temporaire = (prefixe) => fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  /** Le texte ne contient aucun secret : mot de passe de chiffrement, clé d'un autre site, clé de réception, code. */
  function sansSecret(texte, empreintes, quoi) {
    for (const secret of [MDP_CHIFFREMENT, CLE_DISTANTE, '"cleReception"', '"motDePasseChiffrement"', '"reinitialisation"'].concat(empreintes)) {
      assert.equal(texte.includes(secret), false, `${quoi} : ${secret}`);
    }
  }
  const empreinteCode = () => srv.db.get('users', tech.id).reinitialisation.empreinte;
  const nouveauCode = async () => (await admin.ok('POST', `/api/utilisateurs/${tech.id}/reinitialiser-mdp`, { mode: 'code' })).code;

  before(async () => {
    dataDir = temporaire('gmao-secrets-');
    dossier = temporaire('gmao-secrets-dest-');
    srv = await demarrer({ inMemory: false, dataDir });
    admin = srv.client(); await admin.login('admin', 'admin');
    const profils = await admin.ok('GET', '/api/profils');
    tech = await admin.ok('POST', '/api/utilisateurs', { login: 'tech', nom: 'Tech', profilId: profils.find((p) => p.nom === 'Technicien').id, password: 'tech-mdp1', doitChangerMdp: false });
    await admin.ok('PUT', '/api/sauvegardes-avancees/parametres', { motDePasseChiffrement: MDP_CHIFFREMENT, compresser: false });
    await admin.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Autre site', type: 'serveur', url: 'http://srv-autre:8585', cle: CLE_DISTANTE });
    await admin.ok('POST', '/api/sauvegardes-avancees/cle-reception/generer');
  });
  after(async () => {
    await srv.stop();
    for (const d of [dataDir, dossier]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('copie « avant import » : listée, téléchargeable et restaurable sans secret ; paramètres de sauvegarde du serveur conservés', async () => {
    await nouveauCode();
    const empreinte = empreinteCode();
    const data = (await admin.get('/api/export')).body;
    await admin.ok('POST', '/api/import', data);
    await admin.login('admin', 'admin');
    const copie = (await admin.ok('GET', '/api/sauvegardes-avancees')).locales.find((f) => f.etatPrecedent === 'import');
    assert.ok(copie, 'copie de l\'état précédent listée');
    const dl = await admin.brut(`/api/sauvegardes-avancees/telecharger?source=locale&fichier=${encodeURIComponent(copie.nom)}`);
    assert.equal(dl.status, 200);
    const texte = dl.body.toString('utf8');
    sansSecret(texte, [empreinte], 'téléchargement de la copie');
    assert.ok(JSON.parse(texte).collections.users.some((u) => u.login === 'tech'), 'copie complète de la base');
    sansSecret(fs.readFileSync(path.join(dataDir, 'backups', copie.nom), 'utf8'), [empreinte], 'fichier de la copie');
    // Retour en arrière : restaurable, les secrets de sauvegarde restent ceux du serveur
    await admin.ok('POST', '/api/sauvegardes-avancees/restaurer', { source: 'locale', fichier: copie.nom });
    const s = srv.db.getConfig().sauvegardes;
    assert.equal(s.motDePasseChiffrement, MDP_CHIFFREMENT);
    assert.equal(s.destinations.length, 1);
    assert.equal(s.destinations[0].cle, CLE_DISTANTE);
    assert.ok(s.cleReception);
    // Copies manuelle et « avant restauration » (Système › Base de données) : mêmes règles
    const manuelle = (await admin.ok('POST', '/api/sauvegardes')).fichier;
    sansSecret(fs.readFileSync(manuelle, 'utf8'), [], 'copie manuelle');
    await admin.ok('POST', '/api/sauvegardes/restaurer', { nom: path.basename(manuelle) });
    const avantRestauration = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => /^gmao-avant-restauration-/.test(f));
    assert.ok(avantRestauration.length);
    for (const f of avantRestauration) sansSecret(fs.readFileSync(path.join(dataDir, 'backups', f), 'utf8'), [], f);
    assert.equal(srv.db.getConfig().sauvegardes.motDePasseChiffrement, MDP_CHIFFREMENT, 'secrets du serveur conservés');
  });

  test('sauvegardes (en clair et chiffrée) et export sans code de réinitialisation ; un code annulé ne revient pas par une restauration', async () => {
    const code = await nouveauCode();
    const empreinte = empreinteCode();
    const d = await admin.ok('POST', '/api/sauvegardes-avancees/destinations', { nom: 'Dossier', type: 'dossier', chemin: dossier });
    const clair = await admin.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id });
    sansSecret(fs.readFileSync(path.join(dossier, clair.fichier), 'utf8'), [empreinte], 'sauvegarde en clair');
    await admin.ok('PUT', '/api/sauvegardes-avancees/parametres', { chiffrer: true });
    const chiffree = await admin.ok('POST', '/api/sauvegardes-avancees/executer', { destinationId: d.id });
    assert.match(chiffree.fichier, /\.enc$/);
    const { data } = await decoder(fs.readFileSync(path.join(dossier, chiffree.fichier)), MDP_CHIFFREMENT);
    sansSecret(JSON.stringify(data), [empreinte], 'sauvegarde chiffrée');
    await admin.ok('PUT', '/api/sauvegardes-avancees/parametres', { chiffrer: false });
    sansSecret(JSON.stringify((await admin.get('/api/export')).body), [empreinte], 'export complet');
    // Code annulé après la sauvegarde : la restauration ne le réactive pas
    await admin.ok('DELETE', `/api/utilisateurs/${tech.id}/code-reinitialisation`);
    await admin.ok('POST', '/api/sauvegardes-avancees/restaurer', { source: 'destination', destinationId: d.id, fichier: clair.fichier });
    assert.equal(srv.db.get('users', tech.id).reinitialisation, undefined);
    assert.equal((await srv.client().post('/api/auth/reinitialiser', { login: 'tech', code, nouveau: 'Tech-Nouveau#2026' })).status, 400);
  });

  test('fichier d\'une version antérieure avec un code : import sans le code', async () => {
    const code = await nouveauCode();
    const ancien = srv.db.get('users', tech.id).reinitialisation;
    await admin.ok('DELETE', `/api/utilisateurs/${tech.id}/code-reinitialisation`);
    const data = (await admin.get('/api/export')).body;
    data.collections.users.find((u) => u.id === tech.id).reinitialisation = ancien;
    await admin.ok('POST', '/api/import', data);
    await admin.login('admin', 'admin');
    assert.equal(srv.db.get('users', tech.id).reinitialisation, undefined);
    assert.equal((await srv.client().post('/api/auth/reinitialiser', { login: 'tech', code, nouveau: 'Tech-Nouveau#2026' })).status, 400);
  });

  test('copies brutes d\'une version antérieure : secrets retirés au démarrage, références des pièces jointes et date conservées', () => {
    const dir = temporaire('gmao-secrets-anciennes-');
    try {
      const db = new Db(dir, { saveDelay: 0, log: () => {} }).load();
      const photo = 'data:image/png;base64,' + 'A'.repeat(70 * 1024);
      db.setConfig({ sauvegardes: { motDePasseChiffrement: MDP_CHIFFREMENT, cleReception: 'sha256:abc', cleReceptionDate: '2026-01-01', destinations: [{ id: 1, type: 'serveur', cle: CLE_DISTANTE }], conserverLocal: 30 } });
      db.insert('users', { login: 'tech', reinitialisation: { empreinte: 'scrypt$empreinte-du-code', expireLe: '2099-01-01T00:00:00.000Z' } });
      db.insert('equipements', { nom: 'Presse', documents: [{ contenu: photo }] });
      db.saveNow();
      const nom = 'gmao-avant-import-2026-01-01T00-00-00-000Z.json';
      const chemin = path.join(dir, 'backups', nom);
      fs.copyFileSync(path.join(dir, 'gmao.json'), chemin); // copie brute, comme les versions antérieures
      fs.copyFileSync(path.join(dir, 'gmao.json'), path.join(dir, 'backups', 'gmao-2026-01-01.json'));
      const date = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(chemin, date, date);
      new Db(dir, { log: () => {} }).load();
      const texte = fs.readFileSync(chemin, 'utf8');
      sansSecret(texte, ['scrypt$empreinte-du-code'], 'copie antérieure');
      assert.equal(fs.statSync(chemin).mtimeMs, date.getTime(), 'date de la copie conservée');
      const copie = JSON.parse(texte);
      assert.equal(copie.config.sauvegardes.conserverLocal, 30);
      assert.deepEqual(copie.config.sauvegardes.destinations, []);
      assert.ok(copie.collections.equipements[0].documents[0].contenu.$pieceGmao, 'pièce jointe en référence');
      const relue = new Db(dir, { log: () => {} });
      assert.equal(relue._lire(chemin).collections.equipements[0].documents[0].contenu, photo, 'copie toujours restaurable');
      assert.ok(fs.readFileSync(path.join(dir, 'backups', 'gmao-2026-01-01.json'), 'utf8').includes(MDP_CHIFFREMENT), 'copie quotidienne exacte (redémarrage sur un fichier endommagé)');
      assert.ok(fs.readFileSync(path.join(dir, 'gmao.json'), 'utf8').includes(MDP_CHIFFREMENT), 'base intacte');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
