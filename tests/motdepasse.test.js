'use strict';
/**
 * Mots de passe : changer, oublier, recréer.
 *  - fonctions de base (codes de réinitialisation, quotas, empreintes, fiche sans secret) ;
 *  - configuration « sécurité » (valeurs par défaut, bases existantes, bornes, informations publiques) ;
 *  - demandes « mot de passe oublié » (aucune énumération, limites, répétitions, notifications limitées,
 *    hiérarchie et sites, rejet, traitement) ;
 *  - réinitialisation par un gestionnaire (code à usage unique ou mot de passe temporaire) ;
 *  - codes de réinitialisation (format, usage unique, expiration, 5 essais, annulations, blocage, requêtes
 *    simultanées) ; la double authentification n'est jamais contournée ;
 *  - réinitialisation autonome avec l'application d'authentification ;
 *  - historique, expiration, changement imposé par le serveur ;
 *  - données sensibles absentes de toutes les réponses ; récupération d'urgence (application de bureau) ; purge.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { demarrer } = require('./helpers');
const auth = require('../server/auth');
const totp = require('../server/totp');
const { Db } = require('../server/db');
const { seed, configParDefaut } = require('../server/seed');

const ERREUR_CODE = 'Identifiant ou code de réinitialisation incorrect, ou code expiré';
const ERREUR_AUTONOME = 'Identifiant ou code de vérification incorrect, ou réinitialisation impossible pour ce compte';
const FORMAT_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MINUTE = 60 * 1000;
const JOUR = 24 * 60 * MINUTE;
const mediane = (t) => t.slice().sort((a, b) => a - b)[Math.floor(t.length / 2)];

// =====================================================================================================
// Fonctions de base
// =====================================================================================================
describe('Mots de passe : fonctions de base', () => {
  test('codes de réinitialisation : 8 caractères sans ambiguïté, présentation XXXX-XXXX, saisie tolérante', () => {
    assert.equal(auth.ALPHABET_CODE_REINIT, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    const vus = new Set();
    for (let i = 0; i < 500; i++) {
      const c = auth.genererCodeReinitialisation();
      assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
      vus.add(c);
    }
    assert.ok(vus.size >= 499, 'codes aléatoires');
    assert.equal(auth.formaterCodeReinitialisation('ABCD2345'), 'ABCD-2345');
    assert.equal(auth.normaliserCodeReinitialisation('abcd-2345'), 'ABCD2345');
    assert.equal(auth.normaliserCodeReinitialisation('  ab cd 23-45 '), 'ABCD2345');
    assert.equal(auth.normaliserCodeReinitialisation('ABCD2345'), 'ABCD2345');
    for (const faux of ['ABCD-234', 'ABCD-23456', 'ABCD-23I5', 'ABCD-23O5', 'ABCD-2305', 'ABCD-2315', 'ABCD_2345', '', null, undefined, {}, ['ABCD2345'], 'x'.repeat(500)]) {
      assert.equal(auth.normaliserCodeReinitialisation(faux), null, JSON.stringify(faux));
    }
  });

  test('quota sur une fenêtre glissante (demandes par poste)', () => {
    const s = new auth.Sessions();
    for (let i = 0; i < 5; i++) assert.equal(s.quota('poste', 5, 15 * MINUTE), 0);
    const attente = s.quota('poste', 5, 15 * MINUTE);
    assert.ok(attente > 0 && attente <= 15 * 60, 'secondes avant la prochaine demande permise');
    assert.equal(s.quota('autre', 5, 15 * MINUTE), 0, 'clé indépendante');
    const q = s.quotas.get('poste');
    q.instants = q.instants.map((t) => t - 16 * MINUTE);
    assert.equal(s.quota('poste', 5, 15 * MINUTE), 0, 'fenêtre écoulée');
    s.sweep();
    assert.ok(s.quotas.has('poste'), 'demande récente conservée');
  });

  test('empreintes vérifiées sans bloquer le serveur ; fiche utilisateur sans aucun secret', async () => {
    const h = auth.hashPassword('Secret-123');
    assert.equal(await auth.verifyPasswordAsync('Secret-123', h), true);
    assert.equal(await auth.verifyPasswordAsync('Secret-124', h), false);
    assert.equal(await auth.verifyPasswordAsync('x', 'mal formée'), false);
    assert.equal(await auth.verifyPasswordAsync('x', null), false);
    const propre = auth.cleanUser({ id: 1, login: 'a', passwordHash: h, historiqueMdp: [h], reinitialisation: { empreinte: h, expireLe: 'x' }, codesSecours: [h], deuxFacteurs: { actif: true, secret: 'x' }, dateMdp: '2026-01-01T00:00:00.000Z', raisonChangementMdp: 'expire' });
    for (const k of ['passwordHash', 'historiqueMdp', 'reinitialisation', 'codesSecours']) assert.equal(propre[k], undefined, k);
    assert.deepEqual(Object.keys(propre.deuxFacteurs).sort(), ['actif', 'activeLe', 'codesSecoursRestants']);
    assert.equal(propre.dateMdp, '2026-01-01T00:00:00.000Z');
    assert.ok(!JSON.stringify(propre).includes(h.split('$')[2]));
  });
});

// =====================================================================================================
// Configuration
// =====================================================================================================
describe('Configuration « sécurité » et bases existantes', () => {
  test('valeurs par défaut des nouveaux réglages et actions notifiées du journal', () => {
    const c = configParDefaut();
    assert.equal(c.securite.motDePasseOublie, true);
    assert.equal(c.securite.dureeCodeReinitialisationMinutes, 60);
    assert.equal(c.securite.reinitialisationAutonome, false);
    assert.equal(c.securite.expirationMdpJours, 0);
    assert.equal(c.securite.rappelExpirationJours, 14);
    assert.equal(c.securite.historiqueMdp, 5);
    for (const a of ['reinitialisation_mdp', 'demande_reinitialisation_mdp', 'recuperation_urgence']) assert.ok(c.journal.actions.includes(a), a);
  });

  test('base existante : réglages complétés, personnalisations conservées, actions du journal ajoutées une seule fois', () => {
    const db = new Db(path.join(os.tmpdir(), 'gmao-en-memoire'), { inMemory: true }).load();
    db.setConfig({ securite: { longueurMinMdp: 12, complexite: true, forcerChangementMdpInitial: false }, journal: { notifications: true, profilsNotifies: [], actions: ['creation', 'reinitialisation_mdp'], entites: [] } });
    seed(db);
    const s = db.getConfig().securite;
    assert.equal(s.longueurMinMdp, 12, 'personnalisation conservée');
    assert.equal(s.forcerChangementMdpInitial, false);
    assert.equal(s.motDePasseOublie, true);
    assert.equal(s.dureeCodeReinitialisationMinutes, 60);
    assert.equal(s.reinitialisationAutonome, false);
    assert.equal(s.expirationMdpJours, 0);
    assert.equal(s.rappelExpirationJours, 14);
    assert.equal(s.historiqueMdp, 5);
    assert.deepEqual(db.getConfig().journal.actions, ['creation', 'reinitialisation_mdp', 'demande_reinitialisation_mdp', 'recuperation_urgence', 'reinitialisation_double_auth', 'desactivation_double_auth']);
    assert.ok(Array.isArray(db.data.collections.demandesMdp), 'collection des demandes créée');
    // Un retrait ultérieur par le pôle informatique est respecté
    const cfg = db.getConfig(); cfg.journal.actions = ['creation']; db.setConfig(cfg);
    seed(db);
    assert.deepEqual(db.getConfig().journal.actions, ['creation']);
    // Base où les réinitialisations ne sont pas notifiées : rien n'est ajouté
    const db2 = new Db(path.join(os.tmpdir(), 'gmao-en-memoire'), { inMemory: true }).load();
    db2.setConfig({ journal: { notifications: true, profilsNotifies: [], actions: ['creation'], entites: [] } });
    seed(db2);
    assert.deepEqual(db2.getConfig().journal.actions, ['creation']);
  });

  test('base existante, importée ou restaurée : réglages illisibles ou hors bornes ramenés comme s\'ils avaient été saisis', () => {
    const db = new Db(path.join(os.tmpdir(), 'gmao-en-memoire'), { inMemory: true }).load();
    db.setConfig({ securite: {
      expirationMdpJours: 3, historiqueMdp: 'abc', rappelExpirationJours: -5, dureeCodeReinitialisationMinutes: 1, longueurMinMdp: 200,
      inactiviteMinutes: '0', dureeSessionHeures: 7.6, complexite: 'non', motDePasseOublie: 0, reinitialisationAutonome: 'oui',
      deuxFacteurs: 'obligatoire', forcerChangementMdpInitial: false,
    } });
    seed(db);
    let s = db.getConfig().securite;
    assert.equal(s.expirationMdpJours, 0, 'expiration de moins de 30 jours désactivée (aucun compte n\'expire au bout de 3 jours)');
    assert.equal(s.historiqueMdp, 5, 'historique illisible : valeur par défaut, jamais désactivé');
    assert.equal(s.rappelExpirationJours, 1);
    assert.equal(s.dureeCodeReinitialisationMinutes, 5);
    assert.equal(s.longueurMinMdp, 64);
    assert.equal(s.inactiviteMinutes, 60, 'valeur nulle : valeur par défaut, comme à l\'usage');
    assert.equal(s.dureeSessionHeures, 7);
    assert.equal(s.complexite, true);
    assert.equal(s.motDePasseOublie, true);
    assert.equal(s.reinitialisationAutonome, false);
    assert.equal(s.deuxFacteurs, 'facultatif');
    assert.equal(s.forcerChangementMdpInitial, false, 'réglage valide conservé');
    // Expiration valide, rappel aussi long qu'elle : ramené juste en dessous ; valeurs valides (texte numérique compris) conservées
    db.setConfig(Object.assign(db.getConfig(), { securite: Object.assign({}, s, { expirationMdpJours: '45', rappelExpirationJours: 60, historiqueMdp: 0, longueurMinMdp: 12 }) }));
    seed(db);
    s = db.getConfig().securite;
    assert.equal(s.expirationMdpJours, 45);
    assert.equal(s.rappelExpirationJours, 44);
    assert.equal(s.historiqueMdp, 0);
    assert.equal(s.longueurMinMdp, 12);
  });

  test('import d\'une base aux réglages « sécurité » modifiés à la main : ramenés dans les bornes, aucun compte expiré d\'un coup', async () => {
    const srv = await demarrer();
    try {
      const admin = srv.client();
      await admin.login('admin', 'admin');
      const profils = await admin.ok('GET', '/api/profils');
      const tech = await admin.ok('POST', '/api/utilisateurs', { login: 'tech', nom: 'Tech', profilId: profils.find((p) => p.nom === 'Technicien').id, password: 'tech-mdp1', doitChangerMdp: false });
      const data = srv.db.exportAll();
      data.config.securite = Object.assign({}, data.config.securite, { expirationMdpJours: 3, historiqueMdp: 'abc', rappelExpirationJours: -5, dureeCodeReinitialisationMinutes: 1 });
      assert.equal((await admin.post('/api/import', data)).status, 200);
      await admin.login('admin', 'admin');
      const s = (await admin.ok('GET', '/api/configuration')).securite;
      assert.equal(s.expirationMdpJours, 0);
      assert.equal(s.historiqueMdp, 5);
      assert.equal(s.rappelExpirationJours, 1);
      assert.equal(s.dureeCodeReinitialisationMinutes, 5);
      srv.db.update('users', tech.id, { dateMdp: new Date(Date.now() - 4 * JOUR).toISOString() });
      const b = await srv.client().login('tech', 'tech-mdp1');
      assert.equal(b.motDePasse.doitChanger, false);
      assert.equal(b.motDePasse.expireLe, null);
    } finally { await srv.stop(); }
  });
});

// =====================================================================================================
// API
// =====================================================================================================
describe('Mots de passe (API)', () => {
  let srv, admin, info, profils, secteurs, horloge, secretDf, codesSecoursDf;
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  const secteur = (code) => secteurs.find((s) => s.code === code).id;
  const reinitialiserCompteurs = () => { srv.app.sessions.tentatives.clear(); srv.app.sessions.quotas.clear(); };
  const user = (login) => srv.db.findOne('users', (u) => u.login === login);
  const notifs = (login, filtre) => srv.db.list('notifications', (n) => n.userId === user(login).id && (!filtre || filtre(n)));
  const journal = (action) => srv.db.list('audit', (a) => a.action === action);
  const demandeDe = (login) => srv.db.findOne('demandesMdp', (d) => d.login === login && d.statut === 'en_attente');
  const avancer = (secondes) => { horloge += secondes * 1000; };
  const codeApp = (secret) => totp.totp(secret, { instant: horloge });

  /** Compte créé par l'administrateur (mot de passe « <login>-mdp1 », sans changement imposé). */
  async function compte(login, nomProfil, extra = {}) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login.toUpperCase(), prenom: 'P', profilId: profil(nomProfil), password: login + '-mdp1', doitChangerMdp: false }, extra));
    return user(login);
  }
  async function connecte(login, mdp) { const c = srv.client(); await c.login(login, mdp || login + '-mdp1'); return c; }
  /** Code de réinitialisation créé par le pôle informatique. */
  async function codePour(login, par) { return (await (par || info).ok('POST', `/api/utilisateurs/${user(login).id}/reinitialiser-mdp`, { mode: 'code' })).code; }
  const oubli = (login, message) => srv.client().post('/api/auth/mot-de-passe-oublie', message === undefined ? { login } : { login, message });
  const reinit = (login, code, nouveau) => srv.client().post('/api/auth/reinitialiser', { login, code, nouveau });
  const autonome = (login, code, nouveau) => srv.client().post('/api/auth/reinitialiser-autonome', { login, code, nouveau });
  /** Réglages « sécurité » enregistrés par l'API, puis politique assouplie des tests rétablie (longueur minimale 4). */
  async function securite(reglages) {
    const r = await admin.ok('PUT', '/api/configuration', { securite: reglages });
    const cfg = srv.db.getConfig(); cfg.securite.longueurMinMdp = 4; srv.db.setConfig(cfg);
    return r;
  }

  before(async () => {
    srv = await demarrer();
    horloge = Date.parse('2026-10-15T08:00:05Z');
    srv.ctx.deuxFacteurs.maintenant = () => horloge;
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    secteurs = await admin.ok('GET', '/api/secteurs');
    await compte('info', 'Pôle informatique');
    info = await connecte('info');
    await compte('resp', 'Responsable maintenance');
    await compte('tech', 'Technicien', { secteurIds: [secteur('PROD')] });
  });
  after(async () => { await srv.stop(); });

  // ----- Configuration et informations publiques -----
  test('PUT /api/configuration : nouveaux réglages validés avec leurs bornes', async () => {
    const put = (s) => admin.put('/api/configuration', { securite: s });
    for (const [s, motif] of [
      [{ dureeCodeReinitialisationMinutes: 4 }, /entre 5 et 1440/], [{ dureeCodeReinitialisationMinutes: 1441 }, /entre 5 et 1440/], [{ dureeCodeReinitialisationMinutes: 12.5 }, /entre 5 et 1440/],
      [{ expirationMdpJours: 10 }, /0 \(jamais\) ou entre 30 et 730/], [{ expirationMdpJours: 731 }, /30 et 730/], [{ expirationMdpJours: -1 }, /30 et 730/], [{ expirationMdpJours: 'abc' }, /30 et 730/],
      [{ rappelExpirationJours: 0 }, /entre 1 et 60/], [{ rappelExpirationJours: 61 }, /entre 1 et 60/],
      [{ historiqueMdp: 25 }, /entre 0 et 24/], [{ historiqueMdp: -1 }, /entre 0 et 24/],
    ]) {
      const r = await put(s);
      assert.equal(r.status, 400, JSON.stringify(s));
      assert.match(r.body.erreur, motif);
    }
    const c = await admin.ok('PUT', '/api/configuration', { securite: { dureeCodeReinitialisationMinutes: '30', expirationMdpJours: 30, rappelExpirationJours: 7, historiqueMdp: 0, motDePasseOublie: false, reinitialisationAutonome: true } });
    assert.equal(c.securite.dureeCodeReinitialisationMinutes, 30);
    assert.equal(c.securite.expirationMdpJours, 30);
    assert.equal(c.securite.rappelExpirationJours, 7);
    assert.equal(c.securite.historiqueMdp, 0);
    assert.equal(c.securite.motDePasseOublie, false);
    assert.equal(c.securite.reinitialisationAutonome, true);
    const c2 = await admin.ok('PUT', '/api/configuration', { securite: { longueurMinMdp: 10 } });
    assert.equal(c2.securite.expirationMdpJours, 30, 'réglage absent du corps conservé');
    await securite({ dureeCodeReinitialisationMinutes: 60, expirationMdpJours: 0, rappelExpirationJours: 14, historiqueMdp: 5, motDePasseOublie: true, reinitialisationAutonome: false });
  });

  test('PUT /api/configuration : rappel d\'expiration inférieur à la durée d\'expiration, sinon refusé (rappel permanent)', async () => {
    for (const corps of [{ expirationMdpJours: 30, rappelExpirationJours: 60 }, { expirationMdpJours: 30, rappelExpirationJours: 30 }]) {
      const r = await admin.put('/api/configuration', { securite: corps });
      assert.equal(r.status, 400, JSON.stringify(corps));
      assert.match(r.body.erreur, /inférieur à la durée d'expiration \(30 jours\)/);
    }
    assert.equal(srv.db.getConfig().securite.expirationMdpJours, 0, 'rien n\'est enregistré');
    await securite({ expirationMdpJours: 30, rappelExpirationJours: 14 });
    // Le contrôle porte sur le résultat : un rappel seul, trop long pour l'expiration enregistrée, est refusé
    assert.equal((await admin.put('/api/configuration', { securite: { rappelExpirationJours: 45 } })).status, 400);
    await compte('rappel1', 'Technicien');
    const c = await connecte('rappel1');
    await c.ok('POST', '/api/auth/mot-de-passe', { ancien: 'rappel1-mdp1', nouveau: 'rappel1-mdp2' });
    const etat = (await c.ok('GET', '/api/auth/me')).motDePasse;
    assert.equal(etat.joursRestants, 30);
    assert.equal(etat.rappel, false, 'aucun rappel le jour du changement');
    await securite({ expirationMdpJours: 0, rappelExpirationJours: 14 });
  });

  test('GET /api/auth/infos : liens de l\'écran de connexion et règles du mot de passe, rien de sensible', async () => {
    const r = await srv.client().get('/api/auth/infos');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['general', 'motDePasseOublie', 'politiqueMdp', 'premierDemarrage', 'reinitialisationAutonome', 'societe', 'version']);
    assert.equal(r.body.motDePasseOublie, true);
    assert.equal(r.body.reinitialisationAutonome, false);
    assert.deepEqual(r.body.politiqueMdp, { longueurMin: 4, complexite: false, interdireIdentifiant: false });
  });

  // ----- Demandes « mot de passe oublié » -----
  test('demande « mot de passe oublié » : même réponse pour un compte actif, inconnu ou désactivé', async () => {
    reinitialiserCompteurs();
    await compte('oubli1', 'Technicien', { secteurIds: [secteur('PROD')] });
    const inactif = await compte('inactif1', 'Technicien');
    await admin.ok('PUT', '/api/utilisateurs/' + inactif.id, { actif: false });
    const reponses = [];
    const durees = { oubli1: [], 'inconnu-xyz': [], inactif1: [] };
    for (let tour = 0; tour < 3; tour++) {
      srv.app.sessions.quotas.clear();
      for (const login of Object.keys(durees)) {
        const t0 = process.hrtime.bigint();
        const r = await oubli(login, tour === 0 ? 'Je ne retrouve plus mon mot de passe' : undefined);
        durees[login].push(Number(process.hrtime.bigint() - t0) / 1e6);
        reponses.push(r);
      }
    }
    for (const r of reponses) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true });
    }
    const entetes = new Set(reponses.map((r) => Array.from(r.headers.keys()).sort().join(',') + '|' + r.headers.get('content-length')));
    assert.equal(entetes.size, 1, 'mêmes en-têtes et même longueur');
    const medianes = Object.values(durees).map(mediane);
    assert.ok(Math.max(...medianes) - Math.min(...medianes) < 150, 'temps de réponse comparables : ' + medianes.map((x) => x.toFixed(1)).join(' / '));
    // Effets : une demande pour le compte actif uniquement, le journal dans tous les cas
    assert.deepEqual(srv.db.list('demandesMdp').map((d) => d.login), ['oubli1']);
    const j = journal('demande_reinitialisation_mdp');
    assert.ok(j.some((a) => a.details.includes('inconnu-xyz') && /identifiant inconnu/.test(a.details)));
    assert.ok(j.some((a) => a.details.includes('inactif1') && /compte désactivé/.test(a.details)));
    assert.equal(notifs('inactif1').length, 0, 'aucune notification pour un compte désactivé');
    reinitialiserCompteurs();
  });

  test('demande enregistrée et notifiée aux gestionnaires du compte et à son titulaire', async () => {
    const d = demandeDe('oubli1');
    assert.equal(d.userId, user('oubli1').id);
    assert.equal(d.statut, 'en_attente');
    assert.equal(d.repetitions, 3, 'trois demandes reçues (une seule en attente)');
    assert.equal(d.message, 'Je ne retrouve plus mon mot de passe');
    assert.equal(d.ip, '127.0.0.1');
    assert.ok(typeof d.poste === 'string' && d.poste.length <= 200);
    const titre = (n) => n.titre === 'Demande de réinitialisation de mot de passe';
    const nAdmin = notifs('admin', titre);
    assert.equal(nAdmin.length, 1, 'notifications limitées malgré trois demandes');
    assert.equal(nAdmin[0].lien, '#/utilisateurs?demandesMdp=1');
    assert.equal(nAdmin[0].type, 'alerte');
    assert.match(nAdmin[0].message, /\(oubli1\)/);
    assert.equal(notifs('info', titre).length, 1, 'pôle informatique');
    assert.equal(notifs('resp', titre).length, 0, 'sans droit de modification des comptes');
    assert.equal(notifs('tech', titre).length, 0);
    const titulaire = notifs('oubli1', (n) => n.titre === 'Demande de réinitialisation de votre mot de passe');
    assert.equal(titulaire.length, 1);
    assert.equal(titulaire[0].type, 'info');
    assert.match(titulaire[0].message, /a été faite le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2} depuis le poste 127\.0\.0\.1/);
    assert.match(titulaire[0].message, /Si vous n'en êtes pas à l'origine, prévenez le pôle informatique/);
    // Demande anonyme : le compte concerné est l'élément du journal, jamais l'auteur
    const entrees = journal('demande_reinitialisation_mdp').filter((a) => a.entiteId === user('oubli1').id);
    assert.ok(entrees.length >= 1, 'journal rattaché au compte concerné');
    assert.ok(entrees.every((a) => a.userId === null && a.userNom === 'Non connecté'), 'demande anonyme : pas attribuée au titulaire');
  });

  test('répétitions : la demande en attente est mise à jour, notifications au plus toutes les 30 minutes', async () => {
    reinitialiserCompteurs();
    const avant = demandeDe('oubli1');
    await oubli('oubli1', 'Toujours bloqué');
    let d = demandeDe('oubli1');
    assert.equal(d.id, avant.id);
    assert.equal(d.repetitions, 4);
    assert.equal(d.message, 'Je ne retrouve plus mon mot de passe', 'message d\'origine conservé');
    assert.equal(d.ip, avant.ip, 'adresse d\'origine conservée');
    assert.equal(d.provenances[d.provenances.length - 1].message, 'Toujours bloqué', 'nouvelle demande ajoutée aux provenances');
    assert.ok(d.derniereDemande >= avant.derniereDemande);
    assert.equal(srv.db.count('demandesMdp', (x) => x.login === 'oubli1'), 1, 'pas de doublon');
    const titre = (n) => n.titre === 'Demande de réinitialisation de mot de passe';
    assert.equal(notifs('admin', titre).length, 1);
    // 31 minutes plus tard : nouvelle notification
    srv.db.update('demandesMdp', d.id, { derniereNotification: new Date(Date.now() - 31 * MINUTE).toISOString() });
    await oubli('oubli1');
    d = demandeDe('oubli1');
    assert.equal(d.repetitions, 5);
    assert.equal(d.message, 'Je ne retrouve plus mon mot de passe', 'message d\'origine conservé');
    const n = notifs('admin', titre);
    assert.equal(n.length, 2);
    assert.match(n[n.length - 1].message, /5 demandes/);
    assert.equal(notifs('oubli1', (x) => x.titre === 'Demande de réinitialisation de votre mot de passe').length, 2);
    reinitialiserCompteurs();
  });

  test('demandes limitées à 5 par poste en 15 minutes ; identifiant obligatoire ; message en texte brut limité', async () => {
    reinitialiserCompteurs();
    for (let i = 0; i < 5; i++) assert.equal((await oubli('inconnu' + i)).status, 200);
    const r = await oubli('oubli1');
    assert.equal(r.status, 429);
    assert.match(r.body.erreur, /Trop de demandes depuis ce poste/);
    reinitialiserCompteurs();
    assert.equal((await oubli('')).status, 400);
    assert.equal((await srv.client().post('/api/auth/mot-de-passe-oublie', { login: { $ne: 1 } })).status, 400);
    await oubli('oubli1', '<b>Urgent</b>\u0007‮' + 'é'.repeat(400));
    const d = demandeDe('oubli1');
    const message = d.provenances[d.provenances.length - 1].message;
    assert.equal(message.length, 300);
    assert.ok(message.startsWith('<b>Urgent</b>'), 'conservé tel quel comme texte (jamais interprété)');
    assert.ok(!/[\u0007‮]/.test(message), 'caractères de contrôle retirés');
    reinitialiserCompteurs();
  });

  test('demandes désactivées par la configuration : 403 identique pour tous', async () => {
    reinitialiserCompteurs();
    await securite({ motDePasseOublie: false });
    assert.equal((await srv.client().get('/api/auth/infos')).body.motDePasseOublie, false);
    const r1 = await oubli('oubli1');
    const r2 = await oubli('inconnu-total');
    assert.equal(r1.status, 403);
    assert.deepEqual(r1.body, r2.body);
    await securite({ motDePasseOublie: true });
    reinitialiserCompteurs();
  });

  test('destinataires et liste des demandes : hiérarchie et sites', async () => {
    reinitialiserCompteurs();
    const valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    const prodV = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'PRODV', type: 'service', parentId: valreas.id });
    await compte('gest', 'Chef de secteur', { secteurIds: [secteur('PROD')], overrides: { utilisateurs: { voir: true, modifier: true } } });
    const gest = await connecte('gest');
    await compte('techc', 'Technicien', { secteurIds: [secteur('PROD')] });
    await compte('techv', 'Technicien', { secteurIds: [prodV.id] });
    await compte('chefc', 'Chef de secteur', { secteurIds: [secteur('PROD')] });
    for (const l of ['techc', 'techv', 'chefc', 'admin']) assert.equal((await oubli(l)).status, 200);
    reinitialiserCompteurs();
    const recu = (dest, cible) => notifs(dest, (n) => n.titre === 'Demande de réinitialisation de mot de passe' && n.message.includes(`(${cible})`)).length > 0;
    assert.ok(recu('gest', 'techc'), 'compte de son secteur, niveau inférieur');
    assert.ok(!recu('gest', 'techv'), 'compte d\'un autre site');
    assert.ok(!recu('gest', 'chefc'), 'compte de même niveau');
    assert.ok(recu('info', 'techv') && recu('info', 'chefc'));
    assert.ok(!recu('info', 'admin'), 'le pôle informatique ne gère pas l\'administrateur');
    assert.ok(!recu('admin', 'admin'), 'jamais pour sa propre demande');
    const logins = async (c) => (await c.ok('GET', '/api/utilisateurs-demandes-mdp')).map((d) => d.login);
    const lg = await logins(gest);
    assert.ok(lg.includes('techc') && !lg.includes('techv') && !lg.includes('chefc') && !lg.includes('admin'), lg.join(','));
    const li = await logins(info);
    assert.ok(li.includes('techc') && li.includes('techv') && li.includes('chefc') && li.includes('oubli1') && !li.includes('admin'), li.join(','));
    assert.ok(!(await logins(admin)).includes('admin'), 'sa propre demande n\'est pas proposée');
    assert.equal((await (await connecte('resp')).get('/api/utilisateurs-demandes-mdp')).status, 403, 'consultation seule des comptes');
    assert.equal((await (await connecte('tech')).get('/api/utilisateurs-demandes-mdp')).status, 403);
    const d = (await info.ok('GET', '/api/utilisateurs-demandes-mdp')).find((x) => x.login === 'techc');
    assert.deepEqual(Object.keys(d).sort(), ['createdAt', 'derniereDemande', 'id', 'ip', 'login', 'message', 'nbPostes', 'nom', 'poste', 'profilNom', 'provenances', 'repetitions', 'statut', 'userId']);
    assert.equal(d.profilNom, 'Technicien');
    assert.equal(d.nom, 'P TECHC');
    assert.equal(d.statut, 'en_attente');
  });

  test('rejet d\'une demande : motif communiqué, journal, historique', async () => {
    const gest = await connecte('gest');
    const dC = (await gest.ok('GET', '/api/utilisateurs-demandes-mdp')).find((d) => d.login === 'techc');
    const dV = (await info.ok('GET', '/api/utilisateurs-demandes-mdp')).find((d) => d.login === 'techv');
    assert.equal((await gest.post(`/api/utilisateurs-demandes-mdp/${dV.id}/rejeter`, {})).status, 404, 'compte hors de portée');
    assert.equal((await (await connecte('tech')).post(`/api/utilisateurs-demandes-mdp/${dC.id}/rejeter`, {})).status, 403);
    const r = await gest.ok('POST', `/api/utilisateurs-demandes-mdp/${dC.id}/rejeter`, { motif: 'Demande non confirmée par téléphone' });
    assert.equal(r.statut, 'rejetee');
    assert.equal(r.mode, 'rejet');
    assert.equal(r.motifRejet, 'Demande non confirmée par téléphone');
    assert.equal(r.traiteePar, user('gest').id);
    assert.equal(r.traiteeParNom, 'P GEST');
    assert.equal((await gest.post(`/api/utilisateurs-demandes-mdp/${dC.id}/rejeter`, {})).status, 400, 'déjà traitée');
    assert.equal((await gest.post('/api/utilisateurs-demandes-mdp/99999/rejeter', {})).status, 404);
    const n = notifs('techc', (x) => x.titre === 'Demande de réinitialisation refusée');
    assert.equal(n.length, 1);
    assert.match(n[0].message, /Demande non confirmée par téléphone/);
    assert.ok(journal('rejet_demande_reinitialisation_mdp').some((a) => a.entiteId === user('techc').id));
    assert.ok(!(await gest.ok('GET', '/api/utilisateurs-demandes-mdp')).some((d) => d.id === dC.id), 'plus en attente');
    const h = (await gest.ok('GET', '/api/utilisateurs-demandes-mdp?toutes=1')).find((d) => d.id === dC.id);
    assert.equal(h.statut, 'rejetee');
    assert.equal(h.traiteeParNom, 'P GEST');
    assert.ok(h.traiteeLe);
  });

  // ----- Réinitialisation par un gestionnaire -----
  test('mode « code » : code renvoyé une seule fois, mot de passe et sessions inchangés, demandes traitées', async () => {
    const session = await connecte('oubli1');
    const id = user('oubli1').id;
    const dem = demandeDe('oubli1');
    const t0 = Date.now();
    const r = await info.ok('POST', `/api/utilisateurs/${id}/reinitialiser-mdp`, { mode: 'code', demandeId: dem.id });
    assert.deepEqual(Object.keys(r).sort(), ['code', 'expireLe', 'login', 'mode', 'ok']);
    assert.equal(r.mode, 'code');
    assert.equal(r.login, 'oubli1');
    assert.match(r.code, FORMAT_CODE);
    const duree = Date.parse(r.expireLe) - t0;
    assert.ok(duree > 59 * MINUTE && duree <= 61 * MINUTE, 'valable 60 minutes par défaut');
    assert.equal((await session.get('/api/auth/me')).status, 200, 'sessions conservées');
    assert.ok((await srv.client().login('oubli1', 'oubli1-mdp1')).user, 'mot de passe actuel inchangé');
    const u = user('oubli1');
    assert.equal(u.reinitialisation.origine, 'pole_informatique');
    assert.equal(u.reinitialisation.creePar, user('info').id);
    assert.equal(u.reinitialisation.essais, 0);
    assert.match(u.reinitialisation.empreinte, /^scrypt\$/);
    assert.equal(u.doitChangerMdp, false);
    const traitee = srv.db.get('demandesMdp', dem.id);
    assert.equal(traitee.statut, 'traitee');
    assert.equal(traitee.mode, 'code');
    assert.equal(traitee.traiteePar, user('info').id);
    assert.ok(traitee.traiteeLe);
    assert.ok(journal('code_reinitialisation_mdp').some((a) => a.entiteId === id && !a.details.includes(r.code)), 'journalisé sans le code');
    assert.ok(notifs('oubli1', (n) => n.titre === 'Code de réinitialisation de votre mot de passe').length === 1);
    // Fiche : état du code, jamais le code ni son empreinte
    const fiche = await info.ok('GET', '/api/utilisateurs/' + id);
    assert.deepEqual(Object.keys(fiche.motDePasse).sort(), ['codeActif', 'codeExpireLe', 'codeOrigine', 'dateMdp', 'doitChanger', 'expireLe', 'raison']);
    assert.equal(fiche.motDePasse.codeActif, true);
    assert.equal(fiche.motDePasse.codeExpireLe, r.expireLe);
    assert.equal(fiche.motDePasse.codeOrigine, 'pole_informatique');
    const texte = JSON.stringify(fiche);
    assert.ok(!texte.includes(r.code) && !texte.includes(r.code.replace('-', '')) && !texte.includes('empreinte'));
    assert.equal((await (await connecte('resp')).ok('GET', '/api/utilisateurs/' + id)).motDePasse, undefined, 'réservé aux gestionnaires de comptes');
    // Un nouveau code remplace le précédent ; durée configurable
    await securite({ dureeCodeReinitialisationMinutes: 5 });
    const r2 = await info.ok('POST', `/api/utilisateurs/${id}/reinitialiser-mdp`, { mode: 'code' });
    assert.ok(Date.parse(r2.expireLe) - Date.now() <= 5 * MINUTE);
    assert.equal((await reinit('oubli1', r.code, 'oubli1-nouveau')).status, 400, 'ancien code remplacé');
    assert.equal((await reinit('oubli1', r2.code, 'oubli1-nouveau')).status, 200);
    await securite({ dureeCodeReinitialisationMinutes: 60 });
    reinitialiserCompteurs();
  });

  test('mode « temporaire » : changement imposé à la connexion, sessions fermées, code annulé, demandes traitées', async () => {
    reinitialiserCompteurs();
    await compte('temp1', 'Technicien');
    const s = await connecte('temp1');
    const k = await codePour('temp1');
    await oubli('temp1');
    const ancien = user('temp1').passwordHash;
    const r = await info.ok('POST', `/api/utilisateurs/${user('temp1').id}/reinitialiser-mdp`, {});
    assert.equal(r.mode, 'temporaire');
    assert.equal(typeof r.motDePasse, 'string');
    assert.equal(r.motDePasse.length, 14);
    const u = user('temp1');
    assert.equal(u.doitChangerMdp, true);
    assert.equal(u.raisonChangementMdp, 'reinitialise');
    assert.equal(u.reinitialisation, null);
    assert.equal(u.historiqueMdp[0], ancien, 'ancien mot de passe dans l\'historique');
    assert.equal((await s.get('/api/auth/me')).status, 401, 'sessions fermées');
    assert.equal((await reinit('temp1', k, 'temp1-nouveau')).status, 400, 'code annulé');
    assert.equal(srv.db.findOne('demandesMdp', (d) => d.login === 'temp1').mode, 'temporaire');
    assert.ok(notifs('temp1', (n) => n.titre === 'Mot de passe réinitialisé').length >= 1);
    // Connexion : changement imposé (toujours, quelle que soit la configuration du mot de passe initial)
    const c = srv.client();
    const b = await c.login('temp1', r.motDePasse);
    assert.equal(b.motDePasse.doitChanger, true);
    assert.equal(b.motDePasse.raison, 'reinitialise');
    const refus = await c.get('/api/equipements');
    assert.equal(refus.status, 403);
    assert.equal(refus.body.changementMdpRequis, true);
    assert.equal(refus.body.details.raison, 'reinitialise');
    await c.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'temp1-perso' });
    assert.equal((await c.get('/api/equipements')).status, 200);
    assert.equal(user('temp1').raisonChangementMdp, null);
    // Mot de passe temporaire saisi : politique appliquée
    assert.equal((await info.post(`/api/utilisateurs/${u.id}/reinitialiser-mdp`, { mode: 'temporaire', password: 'ab' })).status, 400);
    assert.equal((await info.ok('POST', `/api/utilisateurs/${u.id}/reinitialiser-mdp`, { mode: 'temporaire', password: 'temp-choisi' })).motDePasse, 'temp-choisi');
    reinitialiserCompteurs();
  });

  test('réinitialisation par un gestionnaire : refus pour soi-même, compte désactivé, mode invalide, droits, hiérarchie', async () => {
    const idInfo = user('info').id;
    const idTech = user('tech').id;
    const moi = await info.post(`/api/utilisateurs/${idInfo}/reinitialiser-mdp`, { mode: 'code' });
    assert.equal(moi.status, 400);
    assert.match(moi.body.erreur, /Changer mon mot de passe/);
    const fiche = await admin.put('/api/utilisateurs/1', { password: 'autre-mdp-9' });
    assert.equal(fiche.status, 400, 'ni par la modification de sa propre fiche');
    assert.match(fiche.body.erreur, /Changer mon mot de passe/);
    assert.equal((await info.post('/api/utilisateurs/1/reinitialiser-mdp', { mode: 'code' })).status, 403, 'administrateur : niveau supérieur');
    const inactif = user('inactif1');
    const r = await info.post(`/api/utilisateurs/${inactif.id}/reinitialiser-mdp`, { mode: 'code' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /désactivé/);
    assert.equal((await info.post(`/api/utilisateurs/${idTech}/reinitialiser-mdp`, { mode: 'magique' })).status, 400);
    const autre = srv.db.findOne('demandesMdp', (d) => d.login === 'techv');
    assert.equal((await info.post(`/api/utilisateurs/${idTech}/reinitialiser-mdp`, { mode: 'code', demandeId: autre.id })).status, 400, 'demande d\'un autre compte');
    assert.equal((await info.post('/api/utilisateurs/99999/reinitialiser-mdp', { mode: 'code' })).status, 404);
    assert.equal((await (await connecte('tech')).post(`/api/utilisateurs/${user('techc').id}/reinitialiser-mdp`, { mode: 'code' })).status, 403);
    assert.equal((await (await connecte('resp')).post(`/api/utilisateurs/${idTech}/reinitialiser-mdp`, { mode: 'code' })).status, 403);
    const gest = await connecte('gest');
    assert.equal((await gest.post(`/api/utilisateurs/${user('techv').id}/reinitialiser-mdp`, { mode: 'code' })).status, 404, 'compte d\'un autre site');
    assert.equal((await gest.post(`/api/utilisateurs/${user('chefc').id}/reinitialiser-mdp`, { mode: 'code' })).status, 403, 'même niveau');
    assert.equal(user('tech').reinitialisation == null, true, 'aucun code créé par les refus');
  });

  test('annulation d\'un code par un gestionnaire', async () => {
    await compte('del1', 'Technicien');
    const id = user('del1').id;
    const k = await codePour('del1');
    assert.equal((await (await connecte('tech')).del(`/api/utilisateurs/${id}/code-reinitialisation`)).status, 403);
    await info.ok('DELETE', `/api/utilisateurs/${id}/code-reinitialisation`);
    assert.equal(user('del1').reinitialisation, null);
    assert.equal((await info.del(`/api/utilisateurs/${id}/code-reinitialisation`)).status, 400, 'plus de code actif');
    assert.equal((await reinit('del1', k, 'del1-nouveau')).status, 400);
    assert.equal((await info.ok('GET', '/api/utilisateurs/' + id)).motDePasse.codeActif, false);
    assert.ok(journal('annulation_code_reinitialisation').some((a) => a.entiteId === id && a.userId === user('info').id));
    reinitialiserCompteurs();
  });

  // ----- Codes de réinitialisation -----
  test('parcours complet : code utilisé depuis l\'écran de connexion, sans ouverture de session', async () => {
    reinitialiserCompteurs();
    await compte('flux', 'Technicien', { secteurIds: [secteur('PROD')] });
    const session = await connecte('flux');
    const k = await codePour('flux');
    await oubli('flux', 'Nouvelle demande après la remise du code');
    const r = await reinit('flux', ' ' + k.toLowerCase().replace('-', ' ') + ' ', 'flux-nouveau');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true });
    assert.equal(r.headers.get('set-cookie'), null, 'aucune session ouverte');
    assert.equal((await session.get('/api/auth/me')).status, 401, 'sessions du compte fermées');
    assert.equal((await srv.client().post('/api/auth/login', { login: 'flux', password: 'flux-mdp1' })).status, 401, 'ancien mot de passe refusé');
    const b = await srv.client().login('flux', 'flux-nouveau');
    assert.equal(b.motDePasse.doitChanger, false);
    assert.equal((await reinit('flux', k, 'flux-encore')).status, 400, 'usage unique');
    const u = user('flux');
    assert.equal(u.reinitialisation, null);
    assert.equal(u.doitChangerMdp, false);
    assert.ok(Date.now() - Date.parse(u.dateMdp) < 60000);
    const d = srv.db.findOne('demandesMdp', (x) => x.login === 'flux');
    assert.equal(d.statut, 'traitee');
    assert.equal(d.mode, 'utilisateur');
    const a = journal('reinitialisation_mdp_code').find((x) => x.entiteId === u.id);
    assert.ok(a, 'journalisé');
    assert.equal(a.userId, u.id, 'attribué au titulaire du compte');
    assert.ok(notifs('flux', (n) => n.titre === 'Mot de passe réinitialisé' && /avec un code de réinitialisation/.test(n.message)).length === 1);
    reinitialiserCompteurs();
  });

  test('erreurs génériques : identifiant inconnu, code faux ou mal formé, expiré, compte désactivé ou sans code', async () => {
    reinitialiserCompteurs();
    await compte('gen1', 'Technicien'); const k1 = await codePour('gen1');
    await compte('gen2', 'Technicien');
    await compte('gen3', 'Technicien'); const k3 = await codePour('gen3');
    srv.db.update('users', user('gen3').id, { actif: false });
    await compte('gen4', 'Technicien'); const k4 = await codePour('gen4');
    srv.db.update('users', user('gen4').id, { reinitialisation: Object.assign({}, user('gen4').reinitialisation, { expireLe: new Date(Date.now() - 1000).toISOString() }) });
    const cas = [['inconnu-abc', k1], ['gen1', 'ABCD-EFGH'], ['gen1', 'pas un code'], ['gen1', ''], ['gen2', k1], ['gen3', k3], ['gen4', k4], ['', k1]];
    for (const [login, code] of cas) {
      const r = await reinit(login, code, 'nouveau-mdp9');
      assert.equal(r.status, 400, `${login} / ${code}`);
      assert.deepEqual(r.body, { erreur: ERREUR_CODE }, `${login} / ${code}`);
    }
    assert.equal((await srv.client().post('/api/auth/reinitialiser', { login: ['gen1'], code: { a: 1 }, nouveau: 5 })).status, 400);
    // Une empreinte est toujours calculée, même sans compte (temps de réponse comparable)
    const original = auth.verifyPasswordAsync;
    let appels = 0;
    auth.verifyPasswordAsync = (...a) => { appels += 1; return original(...a); };
    try {
      await reinit('fantome-zz', 'ABCD-EFGH', 'x-nouveau');
      await reinit('gen2', 'pas un code', 'x-nouveau');
    } finally { auth.verifyPasswordAsync = original; }
    assert.equal(appels, 2, 'vérification factice si l\'identifiant est inconnu ou le code mal formé');
    assert.ok(user('gen1').reinitialisation, 'le code de gen1 reste actif');
    assert.equal((await reinit('gen1', k1, 'gen1-nouveau')).status, 200);
    reinitialiserCompteurs();
  });

  test('politique appliquée seulement après un code valide, sans consommer le code', async () => {
    reinitialiserCompteurs();
    await compte('pol1', 'Technicien');
    const k = await codePour('pol1');
    const faux = await reinit('pol1', 'ZZZZ-ZZZZ', 'ab');
    assert.deepEqual(faux.body, { erreur: ERREUR_CODE }, 'code faux : aucune information sur le mot de passe');
    const court = await reinit('pol1', k, 'ab');
    assert.equal(court.status, 400);
    assert.match(court.body.erreur, /au moins 4 caractères/);
    const identique = await reinit('pol1', k, 'pol1-mdp1');
    assert.equal(identique.status, 400);
    assert.match(identique.body.erreur, /différent de l'ancien/);
    assert.ok(user('pol1').reinitialisation, 'code conservé');
    assert.equal(user('pol1').reinitialisation.essais, 1, 'seul le code faux a consommé un essai');
    assert.equal((await reinit('pol1', k, 'pol1-nouveau')).status, 200);
    reinitialiserCompteurs();
  });

  test('5 essais incorrects pour un même code : code annulé, pôle informatique et titulaire prévenus', async () => {
    reinitialiserCompteurs();
    await compte('ess1', 'Technicien');
    const k = await codePour('ess1');
    assert.equal((await reinit('ess1', 'ZZZZ-ZZZ', 'x-nouveau')).status, 400);
    assert.equal(user('ess1').reinitialisation.essais, 0, 'un code mal formé n\'est pas un essai');
    for (let i = 0; i < 4; i++) assert.equal((await reinit('ess1', 'ZZZZ-ZZZ' + 'ABCD'[i], 'x-nouveau')).status, 400);
    assert.equal(user('ess1').reinitialisation.essais, 4);
    assert.equal((await reinit('ess1', 'ZZZZ-ZZZE', 'x-nouveau')).status, 400);
    assert.equal(user('ess1').reinitialisation, null, 'annulé au 5e essai incorrect');
    assert.equal((await reinit('ess1', k, 'ess1-nouveau')).status, 400, 'le bon code ne fonctionne plus');
    assert.ok(journal('annulation_code_reinitialisation').some((a) => a.entiteId === user('ess1').id));
    assert.ok(notifs('info', (n) => n.titre === 'Code de réinitialisation annulé' && n.message.includes('(ess1)')).length === 1, 'pôle informatique prévenu');
    assert.ok(notifs('ess1', (n) => n.titre === 'Code de réinitialisation annulé').length === 1, 'titulaire prévenu');
    // Quatre essais incorrects puis le bon code : accepté
    reinitialiserCompteurs();
    const k2 = await codePour('ess1');
    for (let i = 0; i < 4; i++) await reinit('ess1', 'ZZZZ-ZZZ' + 'ABCD'[i], 'x-nouveau');
    assert.equal((await reinit('ess1', k2, 'ess1-nouveau')).status, 200);
    reinitialiserCompteurs();
  });

  test('blocage après des échecs répétés, par poste et par identifiant, y compris inconnu ; journalisé', async () => {
    reinitialiserCompteurs();
    let r;
    for (let i = 0; i < 9; i++) r = await reinit('tech', 'ZZZZ-ZZZZ', 'x-nouveau');
    assert.equal(r.status, 429);
    assert.match(r.body.erreur, /Trop de tentatives/);
    let r2;
    for (let i = 0; i < 9; i++) r2 = await reinit('fantome', 'ZZZZ-ZZZZ', 'x-nouveau');
    assert.equal(r2.status, 429, 'même comportement pour un identifiant inconnu');
    assert.ok(journal('echec_reinitialisation_mdp').filter((a) => /« (tech|fantome) »/.test(a.details)).length >= 16);
    assert.ok(journal('blocage').filter((a) => /réinitialisation/.test(a.details)).length >= 2);
    assert.ok(notifs('info', (n) => n.titre === 'Compte temporairement bloqué' && /réinitialisation/.test(n.message)).length >= 1);
    // Blocage par identifiant, même depuis un autre poste
    srv.app.sessions.tentatives.delete('reinit|127.0.0.1|tech');
    assert.equal((await reinit('tech', 'ZZZZ-ZZZZ', 'x-nouveau')).status, 429);
    assert.ok((await srv.client().login('tech', 'tech-mdp1')).user, 'la connexion normale n\'est pas bloquée');
    reinitialiserCompteurs();
  });

  test('code annulé par un changement de mot de passe, une nouvelle réinitialisation ou la désactivation', async () => {
    reinitialiserCompteurs();
    await compte('ann', 'Technicien');
    const id = user('ann').id;
    // Changement de son mot de passe
    let k = await codePour('ann');
    await (await connecte('ann')).ok('POST', '/api/auth/mot-de-passe', { ancien: 'ann-mdp1', nouveau: 'ann-mdp2' });
    assert.equal(user('ann').reinitialisation, null);
    assert.equal((await reinit('ann', k, 'ann-mdp3')).status, 400);
    // Mot de passe défini par un administrateur
    k = await codePour('ann');
    await admin.ok('PUT', '/api/utilisateurs/' + id, { password: 'ann-admin1' });
    assert.equal(user('ann').reinitialisation, null);
    assert.equal(user('ann').raisonChangementMdp, 'administrateur');
    // Mot de passe temporaire
    k = await codePour('ann');
    await info.ok('POST', `/api/utilisateurs/${id}/reinitialiser-mdp`, { mode: 'temporaire' });
    assert.equal(user('ann').reinitialisation, null);
    // Désactivation : code annulé, demandes en attente rejetées
    k = await codePour('ann');
    await oubli('ann');
    await admin.ok('PUT', '/api/utilisateurs/' + id, { actif: false });
    assert.equal(user('ann').reinitialisation, null);
    assert.equal((await reinit('ann', k, 'ann-mdp3')).status, 400);
    const d = srv.db.findOne('demandesMdp', (x) => x.login === 'ann');
    assert.equal(d.statut, 'rejetee');
    assert.equal(d.motifRejet, 'Compte désactivé');
    await admin.ok('PUT', '/api/utilisateurs/' + id, { actif: true });
    reinitialiserCompteurs();
  });

  test('usage unique, même pour des requêtes simultanées', async () => {
    reinitialiserCompteurs();
    await compte('sim1', 'Technicien');
    const k = await codePour('sim1');
    const rs = await Promise.all(['sim1-a1', 'sim1-b2', 'sim1-c3', 'sim1-d4'].map((p) => reinit('sim1', k, p)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    assert.equal(rs.filter((r) => r.status === 400).length, 3);
    const gagnant = ['sim1-a1', 'sim1-b2', 'sim1-c3', 'sim1-d4'][rs.findIndex((r) => r.status === 200)];
    assert.ok((await srv.client().login('sim1', gagnant)).user);
    reinitialiserCompteurs();
  });

  test('la double authentification n\'est jamais contournée par un code de réinitialisation', async () => {
    reinitialiserCompteurs();
    await compte('df1', 'Technicien');
    const c = await connecte('df1');
    const p = await c.ok('POST', '/api/auth/2fa/preparer', { motDePasse: 'df1-mdp1' });
    const act = await c.ok('POST', '/api/auth/2fa/activer', { code: codeApp(p.secret) });
    secretDf = p.secret;
    codesSecoursDf = act.codesSecours;
    const k = await codePour('df1');
    const r = await reinit('df1', k, 'df1-nouveau');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal((await c.get('/api/auth/me')).status, 401, 'sessions fermées');
    const n = srv.client();
    const r1 = await n.post('/api/auth/login', { login: 'df1', password: 'df1-nouveau' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.deuxFacteurs, true);
    assert.ok(r1.body.jeton);
    assert.equal(r1.body.user, undefined, 'aucun amorçage avant le code');
    assert.equal((await n.get('/api/auth/me')).status, 401, 'aucune session avant le code');
    avancer(30);
    const r2 = await n.post('/api/auth/login/code', { jeton: r1.body.jeton, code: codeApp(secretDf) });
    assert.equal(r2.status, 200);
    assert.equal(user('df1').deuxFacteurs.actif, true, 'double authentification conservée');
    reinitialiserCompteurs();
  });

  // ----- Réinitialisation autonome -----
  test('réinitialisation autonome désactivée par défaut : 403 identique pour tous', async () => {
    avancer(30);
    const r1 = await autonome('df1', codeApp(secretDf), 'df1-autre');
    const r2 = await autonome('inconnu', '123456', 'x-autre');
    assert.equal(r1.status, 403);
    assert.deepEqual(r1.body, r2.body);
    assert.equal((await srv.client().get('/api/auth/infos')).body.reinitialisationAutonome, false);
  });

  test('réinitialisation autonome : code de l\'application uniquement, anti-rejeu, politique, aucune session', async () => {
    reinitialiserCompteurs();
    await securite({ reinitialisationAutonome: true });
    assert.equal((await srv.client().get('/api/auth/infos')).body.reinitialisationAutonome, true);
    avancer(30);
    const code = codeApp(secretDf);
    // Politique refusée après un code valide : le code reste utilisable
    const court = await autonome('df1', code, 'ab');
    assert.equal(court.status, 400);
    assert.match(court.body.erreur, /au moins 4 caractères/);
    const r = await autonome('df1', code, 'df1-autonome');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get('set-cookie'), null);
    // Rejeu, code de secours, compte sans double authentification, identifiant inconnu : même erreur
    for (const [login, c] of [['df1', code], ['df1', codesSecoursDf[0]], ['df1', '000000'], ['tech', '123456'], ['inconnu', '123456'], ['df1', '']]) {
      const x = await autonome(login, c, 'df1-tentative');
      assert.equal(x.status, 400, `${login} / ${c}`);
      assert.deepEqual(x.body, { erreur: ERREUR_AUTONOME }, `${login} / ${c}`);
    }
    assert.equal(user('df1').codesSecours.length, 10, 'code de secours non consommé');
    const n = srv.client();
    const r1 = await n.post('/api/auth/login', { login: 'df1', password: 'df1-autonome' });
    assert.equal(r1.body.deuxFacteurs, true, 'double authentification toujours demandée');
    avancer(30);
    assert.equal((await n.post('/api/auth/login/code', { jeton: r1.body.jeton, code: codeApp(secretDf) })).status, 200);
    assert.ok(journal('reinitialisation_mdp_autonome').some((a) => a.entiteId === user('df1').id));
    assert.ok(notifs('info', (x) => x.titre === 'Mot de passe réinitialisé par l\'utilisateur' && x.message.includes('(df1)')).length === 1, 'pôle informatique prévenu');
    assert.ok(notifs('df1', (x) => x.titre === 'Mot de passe réinitialisé' && /application d'authentification/.test(x.message)).length === 1);
    reinitialiserCompteurs();
  });

  test('réinitialisation autonome : blocage partagé avec les codes de vérification du compte', async () => {
    reinitialiserCompteurs();
    let r;
    for (let i = 0; i < 9; i++) r = await autonome('df1', String(100000 + i), 'df1-x');
    assert.equal(r.status, 429);
    const c = srv.client();
    const l = await c.post('/api/auth/login', { login: 'df1', password: 'df1-autonome' });
    assert.equal(l.status, 429, 'connexion en deux étapes bloquée aussi');
    assert.match(l.body.erreur, /codes de vérification/);
    assert.ok(notifs('df1', (n) => n.titre === 'Tentatives de réinitialisation suspectes').length === 1);
    await securite({ reinitialisationAutonome: false });
    reinitialiserCompteurs();
  });

  // ----- Historique, changement de son mot de passe -----
  test('historique : les N derniers mots de passe sont refusés (changement et code)', async () => {
    reinitialiserCompteurs();
    await securite({ historiqueMdp: 2 });
    await compte('histo', 'Technicien');
    const c = await connecte('histo');
    const changer = (ancien, nouveau) => c.post('/api/auth/mot-de-passe', { ancien, nouveau });
    assert.equal((await changer('histo-mdp1', 'mdp-B')).status, 200);
    assert.equal((await changer('mdp-B', 'mdp-C')).status, 200);
    const memes = await changer('mdp-C', 'mdp-C');
    assert.equal(memes.status, 400);
    assert.match(memes.body.erreur, /différent de l'ancien/);
    for (const ancien of ['mdp-B', 'histo-mdp1']) {
      const x = await changer('mdp-C', ancien);
      assert.equal(x.status, 400, ancien);
      assert.match(x.body.erreur, /déjà été utilisé.*2 derniers/);
    }
    assert.equal(user('histo').historiqueMdp.length, 2);
    assert.ok(user('histo').historiqueMdp.every((h) => /^scrypt\$/.test(h)));
    // Le code de réinitialisation applique aussi l'historique, sans être consommé
    const k = await codePour('histo');
    const refus = await reinit('histo', k, 'mdp-B');
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /déjà été utilisé/);
    assert.equal((await reinit('histo', k, 'mdp-D')).status, 200);
    // Historique C, B (N = 2) : le premier mot de passe est de nouveau permis
    const c2 = await connecte('histo', 'mdp-D');
    assert.equal((await c2.post('/api/auth/mot-de-passe', { ancien: 'mdp-D', nouveau: 'histo-mdp1' })).status, 200);
    // N = 0 : seul le mot de passe actuel est refusé, aucune empreinte précédente n'est conservée
    await securite({ historiqueMdp: 0 });
    assert.equal((await c2.post('/api/auth/mot-de-passe', { ancien: 'histo-mdp1', nouveau: 'mdp-D' })).status, 200);
    assert.deepEqual(user('histo').historiqueMdp, []);
    await securite({ historiqueMdp: 5 });
    reinitialiserCompteurs();
  });

  test('changer son mot de passe : raison effacée, date enregistrée, demandes en attente traitées', async () => {
    reinitialiserCompteurs();
    await compte('chg', 'Technicien');
    await oubli('chg');
    const c = await connecte('chg');
    await c.ok('POST', '/api/auth/mot-de-passe', { ancien: 'chg-mdp1', nouveau: 'chg-mdp2' });
    const u = user('chg');
    assert.equal(u.raisonChangementMdp, null);
    assert.equal(u.doitChangerMdp, false);
    assert.ok(Date.now() - Date.parse(u.dateMdp) < 60000);
    const d = srv.db.findOne('demandesMdp', (x) => x.login === 'chg');
    assert.equal(d.statut, 'traitee');
    assert.equal(d.mode, 'utilisateur');
    assert.ok(journal('changement_mdp').some((a) => a.entiteId === u.id));
    reinitialiserCompteurs();
  });

  // ----- Expiration -----
  test('expiration activée : aucun compte n\'expire d\'un coup (date de référence posée à la première évaluation)', async () => {
    await compte('exp1', 'Technicien');
    srv.db.update('users', user('exp1').id, { dateMdp: null }); // compte antérieur, jamais changé
    await securite({ expirationMdpJours: 90, rappelExpirationJours: 14 });
    const c = srv.client();
    const b = await c.login('exp1', 'exp1-mdp1');
    const ref = user('exp1').dateReferenceMdp;
    assert.ok(ref && Date.now() - Date.parse(ref) < 60000, 'date de référence posée');
    assert.equal(b.motDePasse.doitChanger, false);
    assert.equal(b.motDePasse.raison, null);
    assert.equal(b.motDePasse.dateMdp, null);
    assert.equal(Date.parse(b.motDePasse.expireLe), Date.parse(ref) + 90 * JOUR);
    assert.equal(b.motDePasse.joursRestants, 90);
    assert.equal(b.motDePasse.rappel, false);
    assert.equal((await c.get('/api/equipements')).status, 200);
    // Compte avec une date de changement : échéance calculée depuis cette date
    const me = await (await connecte('tech')).ok('GET', '/api/auth/me');
    assert.equal(Date.parse(me.motDePasse.expireLe), Date.parse(user('tech').dateMdp) + 90 * JOUR);
  });

  test('mot de passe expiré : changement imposé à la connexion, levé après le changement ; rappel avant l\'échéance', async () => {
    srv.db.update('users', user('exp1').id, { dateMdp: new Date(Date.now() - 91 * JOUR).toISOString() });
    const c = srv.client();
    const b = await c.login('exp1', 'exp1-mdp1');
    assert.equal(b.motDePasse.doitChanger, true);
    assert.equal(b.motDePasse.raison, 'expire');
    assert.equal(b.motDePasse.joursRestants, 0);
    assert.equal(user('exp1').raisonChangementMdp, 'expire');
    const refus = await c.get('/api/equipements');
    assert.equal(refus.status, 403);
    assert.equal(refus.body.details.raison, 'expire');
    assert.ok(journal('expiration_mdp').some((a) => a.entiteId === user('exp1').id));
    await c.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'exp1-nouveau' });
    const me = await c.ok('GET', '/api/auth/me');
    assert.equal(me.motDePasse.doitChanger, false);
    assert.equal(me.motDePasse.joursRestants, 90);
    assert.equal((await c.get('/api/equipements')).status, 200);
    // Rappel : échéance dans 10 jours (≤ 14)
    srv.db.update('users', user('exp1').id, { dateMdp: new Date(Date.now() - 80 * JOUR).toISOString() });
    const rappel = (await c.ok('GET', '/api/auth/me')).motDePasse;
    assert.equal(rappel.joursRestants, 10);
    assert.equal(rappel.rappel, true);
    assert.equal(rappel.doitChanger, false);
    await securite({ expirationMdpJours: 0 });
    const sans = (await c.ok('GET', '/api/auth/me')).motDePasse;
    assert.equal(sans.expireLe, null);
    assert.equal(sans.joursRestants, null);
    assert.equal(sans.rappel, false);
  });

  // ----- Données sensibles -----
  test('empreintes, historique et codes ne figurent dans aucune réponse', async () => {
    reinitialiserCompteurs();
    await compte('secret1', 'Technicien', { secteurIds: [secteur('PROD')] });
    const c = await connecte('secret1');
    await c.ok('POST', '/api/auth/mot-de-passe', { ancien: 'secret1-mdp1', nouveau: 'secret1-mdp2' });
    await oubli('secret1', 'message');
    const k = await codePour('secret1');
    const u = user('secret1');
    const empreintes = [u.passwordHash, ...u.historiqueMdp, u.reinitialisation.empreinte];
    const interdits = empreintes.flatMap((e) => [e, e.split('$')[2]]).concat([k, k.replace('-', '')]);
    const cles = ['"passwordHash"', '"historiqueMdp":[', '"reinitialisation"', '"empreinte"'];
    const verifier = (texte, quoi) => {
      for (const x of interdits) assert.ok(!texte.includes(x), `${quoi} contient « ${x.slice(0, 12)}… »`);
      for (const x of cles) assert.ok(!texte.includes(x), `${quoi} contient ${x}`);
    };
    const connexion = await srv.client().post('/api/auth/login', { login: 'secret1', password: 'secret1-mdp2' });
    verifier(JSON.stringify(connexion.body), 'réponse de connexion');
    const urls = ['/api/auth/me', '/api/utilisateurs', '/api/utilisateurs/' + u.id, '/api/utilisateurs-organigramme', '/api/utilisateurs-demandes-mdp?toutes=1',
      '/api/audit?limite=2000', '/api/notifications', '/api/profils/' + u.profilId, '/api/secteurs', '/api/ot-techniciens'];
    for (const lecteur of [admin, info]) {
      for (const url of urls) {
        const r = await lecteur.get(url);
        assert.ok([200, 403, 404].includes(r.status), `${url} → ${r.status}`);
        verifier(JSON.stringify(r.body), url);
      }
    }
    verifier(JSON.stringify((await c.get('/api/auth/me')).body), 'amorçage du titulaire');
    verifier(JSON.stringify((await c.get('/api/notifications')).body), 'notifications du titulaire');
    // Export complet (sauvegarde) : aucun code de réinitialisation
    const exp = await admin.get('/api/export');
    assert.equal(exp.status, 200);
    const texte = typeof exp.body === 'string' ? exp.body : JSON.stringify(exp.body);
    assert.ok(!texte.includes('"reinitialisation"') && !texte.includes(u.reinitialisation.empreinte));
    // Filet de sécurité : une route qui renverrait des comptes complets ne divulgue rien
    srv.ctx.router.get('/api/test-comptes-bruts', async () => ({ comptes: srv.db.list('users') }));
    const brut = await admin.get('/api/test-comptes-bruts');
    assert.equal(brut.status, 200);
    assert.ok(brut.body.comptes.some((x) => x.login === 'secret1'));
    verifier(JSON.stringify(brut.body), 'route renvoyant des comptes complets');
  });

  // ----- Récupération d'urgence (application de bureau) -----
  test('récupération d\'urgence : comptes récupérables, code journalisé et signalé, utilisable une fois', async () => {
    reinitialiserCompteurs();
    const svc = srv.ctx.services.motsDePasse;
    assert.equal(typeof svc.comptesRecuperables, 'function');
    assert.equal(typeof svc.recuperationUrgence, 'function');
    await compte('info2', 'Pôle informatique');
    await admin.ok('PUT', '/api/utilisateurs/' + user('info2').id, { actif: false });
    // Fonctions utilisables détachées (appel depuis le processus principal de l'application de bureau)
    const { comptesRecuperables, recuperationUrgence } = svc;
    const comptes = comptesRecuperables();
    const logins = comptes.map((x) => x.login);
    assert.ok(logins.includes('admin') && logins.includes('info'));
    assert.ok(!logins.includes('tech') && !logins.includes('resp') && !logins.includes('info2'), 'ni compte sans droit système, ni compte désactivé');
    assert.ok(comptes.every((x) => Object.keys(x).sort().join() === 'login,nom'));
    assert.throws(() => svc.recuperationUrgence({ login: 'tech', origine: 'Poste serveur' }), /non récupérable/);
    assert.throws(() => svc.recuperationUrgence({ login: 'inexistant' }), /non récupérable/);
    assert.throws(() => svc.recuperationUrgence({}), /non récupérable/);
    const r = recuperationUrgence({ login: 'INFO', origine: 'Poste serveur' });
    assert.deepEqual(Object.keys(r).sort(), ['code', 'expireLe', 'login', 'nom']);
    assert.equal(r.login, 'info');
    assert.equal(r.nom, 'P INFO');
    assert.match(r.code, FORMAT_CODE);
    const u = user('info');
    assert.equal(u.reinitialisation.origine, 'recuperation_urgence');
    assert.equal(u.reinitialisation.creePar, null);
    const a = journal('recuperation_urgence').find((x) => x.entiteId === u.id);
    assert.ok(a);
    assert.equal(a.userId, null);
    assert.equal(a.userNom, 'Poste serveur');
    assert.ok(!a.details.includes(r.code));
    for (const login of ['admin', 'info']) assert.ok(notifs(login, (n) => n.titre === 'Récupération d\'urgence d\'un compte' && n.message.includes('(info)')).length === 1, login);
    assert.equal((await info.get('/api/utilisateurs/' + u.id)).body.motDePasse.codeOrigine, 'recuperation_urgence');
    assert.equal((await reinit('info', r.code, 'info-recupere')).status, 200);
    assert.equal((await reinit('info', r.code, 'info-encore')).status, 400);
    info = await connecte('info', 'info-recupere');
    reinitialiserCompteurs();
  });

  test('purge : demandes traitées depuis plus de 90 jours, demandes de comptes supprimés, codes expirés', async () => {
    const idTech = user('tech').id;
    const vieille = srv.db.insert('demandesMdp', { userId: idTech, login: 'tech', statut: 'traitee', mode: 'code', traiteeLe: new Date(Date.now() - 91 * JOUR).toISOString(), repetitions: 1 });
    const recente = srv.db.insert('demandesMdp', { userId: idTech, login: 'tech', statut: 'rejetee', mode: 'rejet', traiteeLe: new Date(Date.now() - 10 * JOUR).toISOString(), repetitions: 1 });
    const orpheline = srv.db.insert('demandesMdp', { userId: 99999, login: 'disparu', statut: 'en_attente', repetitions: 1 });
    await compte('purge1', 'Technicien');
    await codePour('purge1');
    srv.db.update('users', user('purge1').id, { reinitialisation: Object.assign({}, user('purge1').reinitialisation, { expireLe: new Date(Date.now() - 1000).toISOString() }) });
    srv.ctx.motsDePasse.purger();
    assert.equal(srv.db.get('demandesMdp', vieille.id), null);
    assert.ok(srv.db.get('demandesMdp', recente.id));
    assert.equal(srv.db.get('demandesMdp', orpheline.id), null);
    assert.equal(user('purge1').reinitialisation, null);
    assert.ok(srv.db.findOne('demandesMdp', (d) => d.login === 'techv' && d.statut === 'en_attente'), 'demandes en attente conservées');
  });
});

// =====================================================================================================
// Changement imposé avec la politique réelle
// =====================================================================================================
describe('Changement de mot de passe imposé par le serveur', () => {
  let srv;
  before(async () => { srv = await demarrer({ politiqueReelle: true }); });
  after(async () => { await srv.stop(); });

  test('mot de passe initial : seules les routes d\'authentification répondent avant le changement', async () => {
    const admin = srv.client();
    const b = await admin.login('admin', 'admin');
    // Changement imposé dès l'ouverture de la session : le mot de passe actuel vient d'être saisi, il n'est pas redemandé
    assert.deepEqual(b.motDePasse, { doitChanger: true, raison: 'initial', dateMdp: null, expireLe: null, joursRestants: null, rappel: false, ancienRequis: false });
    for (const url of ['/api/equipements', '/api/notifications', '/api/utilisateurs', '/api/configuration', '/api/utilisateurs-demandes-mdp']) {
      const r = await admin.get(url);
      assert.equal(r.status, 403, url);
      assert.equal(r.body.changementMdpRequis, true, url);
      assert.deepEqual(r.body.details, { changementMdpRequis: true, raison: 'initial' });
      assert.match(r.body.erreur, /changer votre mot de passe/);
    }
    assert.equal((await admin.post('/api/notifications/lues', {})).status, 403);
    assert.equal((await admin.get('/api/auth/me')).status, 200, 'amorçage');
    assert.equal((await admin.put('/api/auth/preferences', { theme: 'sombre' })).status, 200, 'préférences');
    assert.equal((await admin.get('/api/views')).status, 200);
    assert.equal((await admin.post('/api/auth/mot-de-passe', { nouveau: 'admin' })).status, 400, 'politique appliquée');
    await admin.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'Pompe-Centrale#2026' });
    assert.equal((await admin.get('/api/equipements')).status, 200);
    const me = await admin.ok('GET', '/api/auth/me');
    assert.equal(me.motDePasse.doitChanger, false);
    assert.equal(me.motDePasse.raison, null);
    assert.ok(me.motDePasse.dateMdp);
  });

  test('sans « forcer le changement du mot de passe initial » : l\'initial n\'est plus imposé, une réinitialisation ou un mot de passe défini par un administrateur le sont toujours', async () => {
    const admin = srv.client();
    await admin.login('admin', 'Pompe-Centrale#2026');
    await admin.ok('PUT', '/api/configuration', { securite: { forcerChangementMdpInitial: false } });
    const profils = await admin.ok('GET', '/api/profils');
    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'nouvel', nom: 'Nouvel', profilId: profils.find((p) => p.nom === 'Technicien').id, password: 'Vanne-Robinet#42' });
    assert.equal(srv.db.get('users', u.id).raisonChangementMdp, 'initial');
    const c = srv.client();
    const b = await c.login('nouvel', 'Vanne-Robinet#42');
    assert.equal(b.motDePasse.doitChanger, false);
    assert.equal(b.motDePasse.raison, 'initial');
    assert.equal((await c.get('/api/equipements')).status, 200);
    // Mot de passe défini par un administrateur
    await admin.ok('PUT', '/api/utilisateurs/' + u.id, { password: 'Courroie-Moteur#7' });
    const c2 = srv.client();
    const b2 = await c2.login('nouvel', 'Courroie-Moteur#7');
    assert.equal(b2.motDePasse.doitChanger, true);
    assert.equal(b2.motDePasse.raison, 'administrateur');
    assert.equal((await c2.get('/api/equipements')).status, 403);
    // Défini par un administrateur sans obligation de changement
    await admin.ok('PUT', '/api/utilisateurs/' + u.id, { password: 'Roulement-Axe#55', doitChangerMdp: false });
    const c3 = srv.client();
    assert.equal((await c3.login('nouvel', 'Roulement-Axe#55')).motDePasse.doitChanger, false);
    // Réinitialisation (mot de passe temporaire)
    const t = await admin.ok('POST', `/api/utilisateurs/${u.id}/reinitialiser-mdp`, { mode: 'temporaire' });
    const c4 = srv.client();
    const b4 = await c4.login('nouvel', t.motDePasse);
    assert.equal(b4.motDePasse.raison, 'reinitialise');
    assert.equal((await c4.get('/api/equipements')).status, 403);
    // Le nouveau mot de passe respecte la politique réelle
    assert.equal((await c4.post('/api/auth/mot-de-passe', { nouveau: 'nouvel12345' })).status, 400);
    await c4.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'Palier-Lisse#88' });
    assert.equal((await c4.get('/api/equipements')).status, 200);
  });

  test('réinitialisation par code avec la politique réelle : identifiant interdit dans le mot de passe', async () => {
    const admin = srv.client();
    await admin.login('admin', 'Pompe-Centrale#2026');
    const u = srv.db.findOne('users', (x) => x.login === 'nouvel');
    const { code } = await admin.ok('POST', `/api/utilisateurs/${u.id}/reinitialiser-mdp`, { mode: 'code' });
    const r = await srv.client().post('/api/auth/reinitialiser', { login: 'nouvel', code, nouveau: 'Nouvel-Mdp#2026' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /identifiant/);
    assert.equal((await srv.client().post('/api/auth/reinitialiser', { login: 'nouvel', code, nouveau: 'Engrenage-Vis#31' })).status, 200);
    const b = await srv.client().login('nouvel', 'Engrenage-Vis#31');
    assert.equal(b.motDePasse.doitChanger, false, 'le mot de passe choisi avec le code n\'est pas à changer');
  });

  test('amorçage pendant un changement imposé ou un enrôlement imposé : ni comptes, ni secteurs, ni configuration de l\'application', async () => {
    const admin = srv.client();
    await admin.login('admin', 'Pompe-Centrale#2026');
    const profils = await admin.ok('GET', '/api/profils');
    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'amorce', nom: 'Amorce', profilId: profils.find((p) => p.nom === 'Technicien').id, password: 'Soupape-Bride#12', doitChangerMdp: false });
    const reduit = (b, quoi) => {
      assert.deepEqual(b.references, { secteurs: [], profils: [], users: [] }, quoi);
      assert.deepEqual(b.modules, [], quoi);
      assert.deepEqual(Object.keys(b.config).sort(), ['general', 'securite', 'societe'], quoi);
      assert.equal(b.config.securite.longueurMinMdp, 10, 'règles du nouveau mot de passe transmises');
      assert.equal(b.user.login, 'amorce');
    };
    const t = await admin.ok('POST', `/api/utilisateurs/${u.id}/reinitialiser-mdp`, { mode: 'temporaire' });
    const c = srv.client();
    const b = await c.login('amorce', t.motDePasse);
    assert.equal(b.motDePasse.doitChanger, true);
    reduit(b, 'réponse de connexion');
    reduit(await c.ok('GET', '/api/auth/me'), 'amorçage');
    await c.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'Joint-Torique#64' });
    const complet = await c.ok('GET', '/api/auth/me');
    assert.ok(complet.references.users.length >= 2, 'amorçage complet après le changement');
    assert.ok(complet.references.secteurs.length && complet.modules.length && complet.config.listes);
    // Double authentification obligatoire et pas encore activée : même amorçage réduit jusqu'à l'activation
    const cfg = srv.db.getConfig(); cfg.securite.deuxFacteurs = 'obligatoire_tous'; srv.db.setConfig(cfg);
    try {
      const b2 = await srv.client().login('amorce', 'Joint-Torique#64');
      assert.equal(b2.deuxFacteurs.enrolementRequis, true);
      reduit(b2, 'enrôlement imposé');
    } finally {
      const cfg2 = srv.db.getConfig(); cfg2.securite.deuxFacteurs = 'facultatif'; srv.db.setConfig(cfg2);
    }
  });
});

// =====================================================================================================
// Constats de revue : inondation depuis un poste, mot de passe expiré en session, prise en main d'un
// compte plus privilégié, identifiants et messages reçus des routes publiques
// =====================================================================================================
describe('Routes publiques et prise en main : limites par poste, session ouverte, droits, nettoyage', () => {
  const http = require('http');
  let srv, admin, info, profils, secteurs;
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  const secteur = (code) => secteurs.find((s) => s.code === code).id;
  const user = (login) => srv.db.findOne('users', (u) => u.login === login);
  const notifs = (login, filtre) => srv.db.list('notifications', (n) => n.userId === user(login).id && (!filtre || filtre(n)));
  const journal = (filtre) => srv.db.list('audit', filtre);
  /** Appel HTTP depuis une adresse locale donnée (127.0.0.x) : le serveur voit un poste différent. */
  function appelDepuis(ip, method, url, body) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body || {}));
      const req = http.request({ host: '127.0.0.1', port: srv.app.server.address().port, method, path: url, localAddress: ip, headers: { 'x-requested-with': 'GMAO', host: '127.0.0.1', 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { b = null; } resolve({ status: res.statusCode, body: b }); });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  async function compte(login, nomProfil, extra = {}) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login.toUpperCase(), prenom: 'P', profilId: profil(nomProfil), password: login + '-mdp1', doitChangerMdp: false }, extra));
    return user(login);
  }
  async function connecte(login, mdp) { const c = srv.client(); await c.login(login, mdp || login + '-mdp1'); return c; }

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    secteurs = await admin.ok('GET', '/api/secteurs');
    await compte('info', 'Pôle informatique');
    info = await connecte('info');
  });
  after(async () => { await srv.stop(); });

  test('un poste qui change d\'identifiant à chaque essai est refusé après 20 échecs : journal et alertes bornés', async () => {
    const statuts = {};
    for (let i = 0; i < 40; i++) {
      const r = await appelDepuis('127.0.0.66', 'POST', '/api/auth/reinitialiser', { login: 'x' + i, code: 'AAAA-AAAA', nouveau: 'Abcdef-12345' });
      statuts[r.status] = (statuts[r.status] || 0) + 1;
    }
    assert.deepEqual(statuts, { 400: 20, 429: 20 }, 'refus par poste, avant tout calcul d\'empreinte');
    assert.equal(journal((a) => a.action === 'echec_reinitialisation_mdp' && a.ip === '127.0.0.66').length, 20, 'au plus 20 entrées par poste et par quart d\'heure');
    assert.equal(journal((a) => a.action === 'blocage' && a.ip === '127.0.0.66').length, 1);
    const alertes = notifs('info', (n) => n.titre === 'Poste temporairement bloqué');
    assert.equal(alertes.length, 1, 'une seule alerte, regroupée');
    assert.match(alertes[0].message, /127\.0\.0\.66/);
    // La connexion depuis ce poste est refusée aussi ; les autres postes ne sont pas concernés
    assert.equal((await appelDepuis('127.0.0.66', 'POST', '/api/auth/login', { login: 'admin', password: 'admin' })).status, 429);
    assert.equal((await appelDepuis('127.0.0.67', 'POST', '/api/auth/login', { login: 'admin', password: 'admin' })).status, 200);
    srv.app.sessions.quotas.clear();
  });

  test('identifiant saisi cité dans le journal et les alertes sans caractères de mise en forme ; message de demande nettoyé', async () => {
    srv.app.sessions.tentatives.clear(); srv.app.sessions.quotas.clear();
    for (let i = 0; i < 8; i++) await appelDepuis('127.0.0.77', 'POST', '/api/auth/reinitialiser', { login: '\u202eadmin\u2028x', code: 'AAAA-AAAA', nouveau: 'x' });
    const alerte = notifs('info', (n) => n.titre === 'Compte temporairement bloqué').pop();
    assert.ok(alerte, 'blocage signalé');
    assert.ok(!/[\u202e\u2028]/.test(alerte.message), 'aucun caractère de direction ou séparateur de ligne');
    assert.match(alerte.message, /« \?admin\?x »/);
    assert.ok(journal((a) => a.ip === '127.0.0.77').every((a) => !/[\u202e\u2028]/.test(a.details)), 'journal nettoyé');
    await compte('jdupont', 'Technicien');
    await srv.client().post('/api/auth/mot-de-passe-oublie', { login: 'jdupont', message: 'Urgent\u200f \u2028\u0085\u200b\ufeff fin\nligne 2' });
    await new Promise((r) => setTimeout(r, 50));
    const d = srv.db.findOne('demandesMdp', (x) => x.login === 'jdupont');
    assert.ok(!/[\u200f\u2028\u0085\u200b\ufeff]/.test(d.message), 'caractères invisibles retirés : ' + JSON.stringify(d.message));
    assert.match(d.message, /^Urgent +fin\nligne 2$/, 'retour à la ligne ordinaire conservé');
    srv.app.sessions.tentatives.clear(); srv.app.sessions.quotas.clear();
  });

  test('mot de passe expiré pendant une session ouverte : le mot de passe actuel reste exigé', async () => {
    await compte('exp1', 'Technicien');
    const c = await connecte('exp1');
    const autre = await connecte('exp1');
    const cfg = srv.db.getConfig(); cfg.securite.expirationMdpJours = 30; srv.db.setConfig(cfg);
    srv.db.update('users', user('exp1').id, { dateMdp: new Date(Date.now() - 31 * JOUR).toISOString() });
    const me = await c.ok('GET', '/api/auth/me');
    assert.equal(me.motDePasse.raison, 'expire');
    assert.equal(me.motDePasse.doitChanger, true);
    assert.equal(me.motDePasse.ancienRequis, true, 'session ouverte avant l\'échéance : mot de passe actuel exigé');
    assert.equal((await c.get('/api/equipements')).status, 403, 'changement imposé');
    let r = await c.post('/api/auth/mot-de-passe', { nouveau: 'exp1-nouveau' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /mot de passe actuel/);
    assert.equal((await c.post('/api/auth/mot-de-passe', { ancien: 'faux', nouveau: 'exp1-nouveau' })).status, 400);
    assert.equal((await autre.get('/api/auth/me')).status, 200, 'l\'autre session n\'a pas été fermée par ces essais');
    assert.equal((await c.post('/api/auth/mot-de-passe', { ancien: 'exp1-mdp1', nouveau: 'exp1-nouveau' })).status, 200);
    assert.equal((await autre.get('/api/auth/me')).status, 401, 'autres sessions fermées par le changement');
    // Changement imposé dès la connexion (mot de passe saisi à l'instant) : pas redemandé
    srv.db.update('users', user('exp1').id, { dateMdp: new Date(Date.now() - 31 * JOUR).toISOString() });
    const c2 = srv.client();
    const b = await c2.login('exp1', 'exp1-nouveau');
    assert.equal(b.motDePasse.raison, 'expire');
    assert.equal(b.motDePasse.ancienRequis, false);
    assert.equal((await c2.post('/api/auth/mot-de-passe', { nouveau: 'exp1-troisieme' })).status, 200);
    const cfg2 = srv.db.getConfig(); cfg2.securite.expirationMdpJours = 0; srv.db.setConfig(cfg2);
  });

  test('réinitialisation, mot de passe, double authentification ou code d\'un compte qui a des droits que le gestionnaire ne peut pas accorder : refusés', async () => {
    const valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Valréas', code: 'VAL', type: 'site' });
    const prodB = await admin.ok('POST', '/api/secteurs', { nom: 'Prod B', code: 'PRODB', type: 'service', parentId: valreas.id });
    await compte('gest2', 'Chef de secteur', { secteurIds: [secteur('PROD')], overrides: { utilisateurs: { voir: true, modifier: true } }, siteAcces: [{ siteId: valreas.id, mode: 'lecture' }] });
    const gest = await connecte('gest2');
    await compte('cible2', 'Technicien', { secteurIds: [secteur('PROD'), prodB.id], overrides: { audit: { voir: true } } });
    await compte('cible3', 'Technicien', { secteurIds: [secteur('PROD')] });
    const id2 = user('cible2').id;
    assert.equal((await gest.put('/api/utilisateurs/' + id2, { overrides: { audit: { voir: true } } })).status, 403, 'droit non possédé');
    let r = await gest.post(`/api/utilisateurs/${id2}/reinitialiser-mdp`, { mode: 'code' });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Journal d'activité › Voir/);
    assert.match(r.body.erreur, /Prod B/);
    assert.equal((await gest.post(`/api/utilisateurs/${id2}/reinitialiser-mdp`, { mode: 'temporaire' })).status, 403);
    assert.equal((await gest.put('/api/utilisateurs/' + id2, { password: 'Nouveau-Mdp#1' })).status, 403);
    assert.equal((await gest.post(`/api/utilisateurs/${id2}/2fa/reinitialiser`)).status, 403);
    await info.ok('POST', `/api/utilisateurs/${id2}/reinitialiser-mdp`, { mode: 'code' });
    assert.equal((await gest.del(`/api/utilisateurs/${id2}/code-reinitialisation`)).status, 403);
    assert.equal(user('cible2').reinitialisation != null, true, 'code conservé');
    // Compte sans dépassement : réinitialisation permise
    const ok = await gest.ok('POST', `/api/utilisateurs/${user('cible3').id}/reinitialiser-mdp`, { mode: 'code' });
    assert.match(ok.code, FORMAT_CODE);
    // Les gestionnaires notifiés d'une demande « mot de passe oublié » suivent la même règle
    assert.equal(srv.ctx.motsDePasse.gestionnaires(user('cible2')).some((u) => u.login === 'gest2'), false);
    assert.equal(srv.ctx.motsDePasse.gestionnaires(user('cible3')).some((u) => u.login === 'gest2'), true);
  });

  test('annuler son propre code de réinitialisation est refusé ; réglages oui / non en texte refusés', async () => {
    await compte('info2', 'Pôle informatique');
    const info2 = await connecte('info2');
    const id = user('info2').id;
    await admin.ok('POST', `/api/utilisateurs/${id}/reinitialiser-mdp`, { mode: 'code' });
    const r = await info2.del(`/api/utilisateurs/${id}/code-reinitialisation`);
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /propre compte/);
    assert.ok(user('info2').reinitialisation, 'code conservé');
    for (const corps of [{ reinitialisationAutonome: 'false' }, { motDePasseOublie: 'non' }, { forcerChangementMdpInitial: 0 }, { notifierBlocages: 'true' }]) {
      const rr = await admin.put('/api/configuration', { securite: corps });
      assert.equal(rr.status, 400, JSON.stringify(corps));
      assert.match(rr.body.erreur, /oui \/ non/);
    }
    const s = srv.db.getConfig().securite;
    assert.equal(s.reinitialisationAutonome, false);
    assert.equal(s.motDePasseOublie, true);
  });

  test('demande d\'un compte que le gestionnaire ne peut pas prendre en main : ni listée ni rejetable par lui', async () => {
    await compte('chef6', 'Chef de secteur', { secteurIds: [secteur('PROD')], overrides: { utilisateurs: { voir: true, modifier: true } } });
    await compte('tech6', 'Technicien', { secteurIds: [secteur('PROD')], overrides: { stock: { supprimer: true } } });
    await compte('tech7', 'Technicien', { secteurIds: [secteur('PROD')] });
    const chef = await connecte('chef6');
    for (const login of ['tech6', 'tech7']) assert.equal((await appelDepuis('127.0.0.90', 'POST', '/api/auth/mot-de-passe-oublie', { login })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const demande = (login) => srv.db.findOne('demandesMdp', (d) => d.login === login && d.statut === 'en_attente');
    const d6 = demande('tech6');
    const d7 = demande('tech7');
    assert.ok(d6 && d7);
    // Même règle que les destinataires de la demande et que la remise d'un code
    assert.equal(srv.ctx.motsDePasse.gestionnaires(user('tech6')).some((u) => u.login === 'chef6'), false);
    assert.equal((await chef.post(`/api/utilisateurs/${user('tech6').id}/reinitialiser-mdp`, { mode: 'code', demandeId: d6.id })).status, 403);
    for (const url of ['/api/utilisateurs-demandes-mdp', '/api/utilisateurs-demandes-mdp?toutes=1']) {
      const liste = await chef.ok('GET', url);
      assert.equal(liste.some((d) => d.id === d6.id), false, url);
      assert.equal(liste.some((d) => d.id === d7.id), true, `${url} : compte qu'il peut prendre en main`);
    }
    assert.equal((await chef.post(`/api/utilisateurs-demandes-mdp/${d6.id}/rejeter`, {})).status, 404);
    assert.equal(srv.db.get('demandesMdp', d6.id).statut, 'en_attente', 'demande laissée aux gestionnaires compétents');
    assert.equal(notifs('tech6', (n) => n.titre === 'Demande de réinitialisation refusée').length, 0);
    // L'administrateur, prévenu, la voit et peut la traiter ; le chef traite celle qu'il peut prendre en main
    assert.ok((await admin.ok('GET', '/api/utilisateurs-demandes-mdp')).some((d) => d.id === d6.id));
    await admin.ok('POST', `/api/utilisateurs-demandes-mdp/${d6.id}/rejeter`, {});
    await chef.ok('POST', `/api/utilisateurs-demandes-mdp/${d7.id}/rejeter`, {});
  });

  test('demande répétée depuis un autre poste signalée aussitôt ; depuis le même poste, au plus toutes les 30 minutes', async () => {
    await compte('tech8', 'Technicien');
    const titre = (n) => /^Demande de réinitialisation/.test(n.titre) && /\(tech8\)/.test(n.message);
    await appelDepuis('127.0.0.91', 'POST', '/api/auth/mot-de-passe-oublie', { login: 'tech8' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notifs('admin', titre).length, 1);
    await appelDepuis('127.0.0.92', 'POST', '/api/auth/mot-de-passe-oublie', { login: 'tech8' });
    await new Promise((r) => setTimeout(r, 50));
    const n = notifs('admin', titre);
    assert.equal(n.length, 2, 'autre poste : notification sans attendre 30 minutes');
    assert.equal(n[1].titre, 'Demande de réinitialisation depuis plusieurs postes');
    assert.match(n[1].message, /2 postes différents/);
    await appelDepuis('127.0.0.92', 'POST', '/api/auth/mot-de-passe-oublie', { login: 'tech8' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notifs('admin', titre).length, 2, 'poste déjà connu : pas de nouvelle notification avant 30 minutes');
  });

  test('le poste serveur lui-même (adresse locale) n\'est pas soumis à la limite de 20 échecs par poste', async () => {
    srv.app.sessions.quotas.clear();
    const statuts = new Set();
    for (let i = 0; i < 25; i++) statuts.add((await srv.client().post('/api/auth/login', { login: 'serveur' + i, password: 'x' })).status);
    assert.deepEqual(Array.from(statuts), [401]);
    assert.equal((await srv.client().post('/api/auth/login', { login: 'serveur99', password: 'x' })).status, 401);
    assert.equal(journal((a) => a.action === 'blocage' && a.ip === '127.0.0.1').length, 0);
    srv.app.sessions.tentatives.clear();
  });
});
