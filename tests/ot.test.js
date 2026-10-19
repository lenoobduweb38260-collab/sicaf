'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

/**
 * Tests du module Ordres de travail : validation des entrées, CRUD, droits (403), portée par
 * secteur (et extension aux intervenants), workflow de statuts, affectation, temps passés,
 * pièces (service stock simulé), tâches, clôture (relevé de compteur), réouverture, annulation,
 * duplication, commentaires, documents, export CSV, services inter-modules, données de démo.
 */
const pad = (n) => String(n).padStart(2, '0');
const jourLocal = (decalage = 0) => { const d = new Date(); d.setDate(d.getDate() + decalage); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

describe('Ordres de travail', () => {
  let srv, admin, resp, chefProd, techProd, techLog, techLimite, demandeur;
  let uResp, uChefProd, uTechProd, uTechLog, uTechLimite, uDemandeur;
  let PROD, LOG, presse, chariot, reforme, articleJoint, articleRare;
  const evenements = [];
  const appelsStock = { sortir: [], annuler: [] };

  const notifsDe = (uid) => srv.db.list('notifications', (n) => n.userId === uid);
  const evts = (nomEvt, id) => evenements.filter((e) => e.evt === nomEvt && (id == null || e.id === id));
  function config(patch) {
    const cfg = srv.db.getConfig();
    for (const [k, v] of Object.entries(patch)) cfg[k] = Object.assign({}, cfg[k], v);
    srv.db.setConfig(cfg);
  }

  /** Service stock simulé (le module Stock réel peut être absent ou en cours d'écriture). */
  function installerStock() {
    srv.ctx.services.stock = {
      sortir({ articleId, quantite, otId, userId, motif }) {
        appelsStock.sortir.push({ articleId, quantite, otId, userId, motif });
        const a = srv.db.get('articles', articleId);
        if (a.quantite < quantite) throw new srv.ctx.HttpError(400, `Stock insuffisant pour « ${a.designation} »`);
        const article = srv.db.update('articles', articleId, { quantite: a.quantite - quantite });
        const mouvement = srv.db.insert('mouvementsStock', { articleId, type: 'sortie', quantite, quantiteAvant: a.quantite, quantiteApres: article.quantite, date: new Date().toISOString(), userId, otId, motif, prixUnitaire: a.prixUnitaire });
        return { mouvement, article };
      },
      annulerSortie(mouvementId, userId) {
        appelsStock.annuler.push({ mouvementId, userId });
        const m = srv.db.get('mouvementsStock', mouvementId);
        const a = srv.db.get('articles', m.articleId);
        const article = srv.db.update('articles', a.id, { quantite: a.quantite + m.quantite });
        const mouvement = srv.db.insert('mouvementsStock', { articleId: a.id, type: 'retour', quantite: m.quantite, quantiteAvant: a.quantite, quantiteApres: article.quantite, date: new Date().toISOString(), userId, otId: m.otId, motif: 'Annulation de sortie' });
        return { mouvement, article };
      },
    };
  }

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    for (const evt of ['ot:cree', 'ot:statut', 'ot:termine', 'ot:annule', 'ot:supprime', 'ot:modifie']) {
      srv.ctx.on(evt, (d) => evenements.push({ evt, id: d.ot ? d.ot.id : d.id, ancien: d.ancien, nouveau: d.nouveau, data: d }));
    }
    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;

    uResp = await admin.ok('POST', '/api/utilisateurs', { login: 'resp', nom: 'Responsable', prenom: 'Rémi', profilId: p('Responsable maintenance'), password: 'resp1234', doitChangerMdp: false });
    uChefProd = await admin.ok('POST', '/api/utilisateurs', { login: 'chefprod', nom: 'Chef', prenom: 'Paul', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false, managerId: uResp.id });
    uTechProd = await admin.ok('POST', '/api/utilisateurs', { login: 'techprod', nom: 'Technicien', prenom: 'Théo', profilId: p('Technicien'), secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false, managerId: uResp.id });
    uTechLog = await admin.ok('POST', '/api/utilisateurs', { login: 'techlog', nom: 'Logisticien', prenom: 'Léa', profilId: p('Technicien'), secteurIds: [LOG], password: 'tech1234', doitChangerMdp: false, managerId: uResp.id });
    uTechLimite = await admin.ok('POST', '/api/utilisateurs', { login: 'techlimite', nom: 'Limité', prenom: 'Luc', profilId: p('Technicien'), secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false, overrides: { ot: { modifier: false, cloturer: false } } });
    uDemandeur = await admin.ok('POST', '/api/utilisateurs', { login: 'operateur', nom: 'Opérateur', prenom: 'Omar', profilId: p('Demandeur'), secteurIds: [PROD], password: 'oper1234', doitChangerMdp: false, managerId: uChefProd.id });

    // Références insérées directement (indépendance vis-à-vis des autres modules)
    presse = srv.db.insert('equipements', { numero: 'EQ-T001', nom: 'Presse hydraulique test', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: PROD, actif: true, documents: [], champs: {}, compteur: { valeur: 1200, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
    chariot = srv.db.insert('equipements', { numero: 'EQ-T002', nom: 'Chariot test', typeCode: 'vehicule', etatCode: 'en_service', criticiteCode: 'B', secteurId: LOG, actif: true, documents: [], champs: {}, compteur: { valeur: 50, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
    reforme = srv.db.insert('equipements', { numero: 'EQ-T003', nom: 'Machine réformée', typeCode: 'machine', etatCode: 'reforme', criticiteCode: 'C', secteurId: PROD, actif: false, documents: [], champs: {}, createdBy: 1 });
    articleJoint = srv.db.insert('articles', { code: 'ART-T01', designation: 'Joint de tige Ø50', quantite: 10, seuilMin: 2, prixUnitaire: 12.5, uniteCode: 'u', actif: true, equipementIds: [presse.id] });
    articleRare = srv.db.insert('articles', { code: 'ART-T02', designation: 'Vérin complet', quantite: 1, seuilMin: 0, prixUnitaire: 850, uniteCode: 'u', actif: true, equipementIds: [] });

    resp = srv.client(); await resp.login('resp', 'resp1234');
    chefProd = srv.client(); await chefProd.login('chefprod', 'chef1234');
    techProd = srv.client(); await techProd.login('techprod', 'tech1234');
    techLog = srv.client(); await techLog.login('techlog', 'tech1234');
    techLimite = srv.client(); await techLimite.login('techlimite', 'tech1234');
    demandeur = srv.client(); await demandeur.login('operateur', 'oper1234');
  });
  after(async () => { await srv.stop(); });

  test('refuse l\'accès sans session', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/ot')).status, 401);
    assert.equal((await anonyme.post('/api/ot', { titre: 'Test' })).status, 401);
  });

  test('droits : un profil sans accès aux OT reçoit 403', async () => {
    assert.equal((await demandeur.get('/api/ot')).status, 403);
    assert.equal((await demandeur.get('/api/ot-compteurs')).status, 403);
    assert.equal((await demandeur.post('/api/ot', { titre: 'Interdit' })).status, 403);
    assert.equal((await techProd.get('/api/ot-export')).status, 403, 'pas de droit exporter pour un technicien');
  });

  test('validation des entrées', async () => {
    const cas = [
      [{}, 'titre obligatoire'], [{ titre: 'ab' }, 'titre trop court'], [{ titre: 'x'.repeat(201) }, 'titre trop long'],
      [{ titre: 'Test type', typeCode: 'inexistant' }, 'type inconnu'], [{ titre: 'Test priorité', prioriteCode: 'zzz' }, 'priorité inconnue'],
      [{ titre: 'Test équipement', equipementId: 99999 }, 'équipement inexistant'], [{ titre: 'Test équipement', equipementId: 'abc' }, 'équipement invalide'],
      [{ titre: 'Test équipement', equipementId: reforme.id }, 'équipement inactif'],
      [{ titre: 'Test date', datePrevue: '2026-02-30' }, 'date impossible'], [{ titre: 'Test date', datePrevue: 'demain' }, 'date invalide'],
      [{ titre: 'Test durée', dureeEstimee: -2 }, 'durée négative'], [{ titre: 'Test durée', dureeEstimee: 'beaucoup' }, 'durée non numérique'],
      [{ titre: 'Test technicien', technicienId: 99999 }, 'technicien inexistant'], [{ titre: 'Test technicien', technicienId: uDemandeur.id }, 'technicien sans accès OT'],
      [{ titre: 'Test intervenants', techniciens: 'abc' }, 'intervenants non tableau'], [{ titre: 'Test secteur', secteurId: 9999 }, 'secteur inexistant'],
      [{ titre: 'Test plan', planPreventifId: 9999 }, 'plan inexistant'], [{ titre: 'Test demande', demandeId: 9999 }, 'demande inexistante'],
      [{ titre: 'Test coût', coutExterne: -5 }, 'coût externe négatif'], [{ titre: 'Test fournisseur', fournisseurId: 9999 }, 'prestataire inexistant'],
      [{ titre: 'Test gamme', taches: 'abc' }, 'gamme non tableau'],
    ];
    for (const [corps, motif] of cas) {
      const r = await resp.post('/api/ot', corps);
      assert.equal(r.status, 400, `${motif} : ${JSON.stringify(r.body)}`);
      assert.ok(typeof r.body.erreur === 'string' && r.body.erreur.length > 5, 'message d\'erreur en clair');
    }
    assert.match((await resp.post('/api/ot', {})).body.erreur, /titre est obligatoire/);
  });

  test('création : numéro, statut initial, secteur de l\'équipement, techniciens, notification, événement, audit', async () => {
    const avant = notifsDe(uTechProd.id).length;
    const o = await resp.ok('POST', '/api/ot', { titre: 'Fuite d\'huile vérin principal', description: 'Traces au sol', typeCode: 'correctif', prioriteCode: 'haute', equipementId: presse.id, technicienId: uTechProd.id, datePrevue: jourLocal(2), dureeEstimee: 3 });
    assert.match(o.numero, new RegExp(`^OT-${new Date().getFullYear()}-\\d{4}$`));
    assert.equal(o.statut, 'nouveau', 'premier statut non final de la liste');
    assert.equal(o.secteurId, PROD, 'secteur repris de l\'équipement');
    assert.equal(o.createdBy, uResp.id);
    assert.deepEqual(o.techniciens, [uTechProd.id], 'le responsable fait partie des intervenants');
    assert.equal(o.equipement.nom, 'Presse hydraulique test');
    assert.equal(o.equipementNom, 'Presse hydraulique test');
    assert.equal(o.coutTotal, 0);
    assert.equal(o.actions.modifier, true);
    assert.equal(notifsDe(uTechProd.id).length, avant + 1, 'technicien notifié');
    assert.equal(notifsDe(uTechProd.id).slice(-1)[0].lien, `#/ot/${o.id}`);
    assert.equal(evts('ot:cree', o.id).length, 1);
    assert.ok(srv.db.findOne('audit', (a) => a.entite === 'ot' && a.entiteId === o.id && a.action === 'creation'));
    const lu = await resp.ok('GET', `/api/ot/${o.id}`);
    assert.equal(lu.numero, o.numero);
    assert.ok(Array.isArray(lu.historique) && lu.historique.length >= 1);
    // Valeurs par défaut des listes
    const d = await resp.ok('POST', '/api/ot', { titre: 'OT sans type ni priorité' });
    assert.equal(d.typeCode, 'correctif');
    assert.equal(d.prioriteCode, 'normale');
    assert.equal(d.secteurId, null);
  });

  test('le statut initial suit la liste configurable statutsOT', async () => {
    const cfg = srv.db.getConfig();
    const sauvegarde = JSON.parse(JSON.stringify(cfg.listes.statutsOT));
    cfg.listes.statutsOT = [{ code: 'a_qualifier', label: 'À qualifier', couleur: '#999999', ordre: 0, final: false }].concat(sauvegarde);
    srv.db.setConfig(cfg);
    try {
      const o = await resp.ok('POST', '/api/ot', { titre: 'OT avec statut personnalisé' });
      assert.equal(o.statut, 'a_qualifier');
      await resp.ok('DELETE', `/api/ot/${o.id}`);
    } finally {
      const c2 = srv.db.getConfig(); c2.listes.statutsOT = sauvegarde; srv.db.setConfig(c2);
    }
  });

  test('affectation à la création : sans le droit « affecter », seulement soi-même', async () => {
    const r = await techProd.post('/api/ot', { titre: 'Remplacement capteur', equipementId: presse.id, technicienId: uChefProd.id });
    assert.equal(r.status, 403);
    const o = await techProd.ok('POST', '/api/ot', { titre: 'Remplacement capteur', equipementId: presse.id, technicienId: uTechProd.id });
    assert.equal(o.technicienId, uTechProd.id);
    const o2 = await chefProd.ok('POST', '/api/ot', { titre: 'Contrôle presse', equipementId: presse.id, technicienId: uTechProd.id, techniciens: [uTechLimite.id] });
    assert.deepEqual(o2.techniciens.slice().sort(), [uTechProd.id, uTechLimite.id].sort());
  });

  test('portée par secteur (et extension aux intervenants affectés)', async () => {
    const otLog = await resp.ok('POST', '/api/ot', { titre: 'Chariot : contrôle des freins', equipementId: chariot.id, prioriteCode: 'basse' });
    assert.equal(otLog.secteurId, LOG);
    const listeChef = await chefProd.ok('GET', '/api/ot');
    assert.ok(!listeChef.some((o) => o.id === otLog.id), 'OT LOG invisible pour le chef PROD');
    assert.ok(listeChef.every((o) => o.secteurId == null || o.secteurId === PROD));
    assert.equal((await chefProd.get(`/api/ot/${otLog.id}`)).status, 404);
    assert.equal((await chefProd.post(`/api/ot/${otLog.id}/statut`, { statut: 'en_cours' })).status, 404);
    // Création hors périmètre
    assert.equal((await chefProd.post('/api/ot', { titre: 'Hors périmètre', equipementId: chariot.id })).status, 400, 'équipement hors périmètre');
    assert.equal((await chefProd.post('/api/ot', { titre: 'Hors périmètre', secteurId: LOG })).status, 403, 'secteur hors périmètre');
    // Un intervenant affecté voit l'OT même hors de ses secteurs
    const otProd = await resp.ok('POST', '/api/ot', { titre: 'Presse : renfort logistique', equipementId: presse.id, techniciens: [uTechLog.id] });
    assert.equal(otProd.technicienId, uTechLog.id, 'premier intervenant promu responsable');
    const listeLog = await techLog.ok('GET', '/api/ot');
    assert.ok(listeLog.some((o) => o.id === otProd.id));
    assert.ok(listeLog.some((o) => o.id === otLog.id));
    assert.equal((await techLog.get(`/api/ot/${otProd.id}`)).status, 200);
    const compteursLog = await techLog.ok('GET', '/api/ot-compteurs');
    assert.ok(compteursLog.mesOT >= 1);
  });

  test('filtres de liste et compteurs', async () => {
    const a = await resp.ok('POST', '/api/ot', { titre: 'Filtre retard unique', equipementId: presse.id, prioriteCode: 'urgente', typeCode: 'securite', datePrevue: jourLocal(-3), technicienId: uTechProd.id });
    const b = await resp.ok('POST', '/api/ot', { titre: 'Filtre futur unique', equipementId: chariot.id, prioriteCode: 'basse', typeCode: 'preventif', datePrevue: jourLocal(10) });
    const ids = (rows) => rows.map((o) => o.id);
    assert.ok(ids(await resp.ok('GET', '/api/ot?enRetard=1')).includes(a.id));
    assert.ok(!ids(await resp.ok('GET', '/api/ot?enRetard=1')).includes(b.id));
    assert.ok((await resp.ok('GET', `/api/ot/${a.id}`)).enRetard);
    assert.deepEqual(ids(await resp.ok('GET', '/api/ot?recherche=filtre%20retard')), [a.id]);
    assert.ok(ids(await resp.ok('GET', '/api/ot?prioriteCode=urgente')).includes(a.id));
    assert.ok(!ids(await resp.ok('GET', '/api/ot?prioriteCode=urgente')).includes(b.id));
    assert.ok(ids(await resp.ok('GET', '/api/ot?typeCode=preventif')).includes(b.id));
    assert.ok(ids(await resp.ok('GET', `/api/ot?secteurId=${LOG}`)).every((id) => srv.db.get('ot', id).secteurId === LOG));
    assert.ok(ids(await resp.ok('GET', `/api/ot?equipementId=${chariot.id}`)).includes(b.id));
    assert.ok(ids(await resp.ok('GET', `/api/ot?technicienId=${uTechProd.id}`)).includes(a.id));
    const periode = ids(await resp.ok('GET', `/api/ot?du=${jourLocal(5)}&au=${jourLocal(15)}`));
    assert.ok(periode.includes(b.id) && !periode.includes(a.id));
    assert.ok(ids(await resp.ok('GET', '/api/ot?statuts=nouveau,planifie')).includes(a.id));
    assert.equal((await resp.ok('GET', '/api/ot?statut=termine')).length, (await resp.ok('GET', '/api/ot')).filter((o) => o.statut === 'termine').length);
    assert.ok(ids(await techProd.ok('GET', '/api/ot?mesOT=1')).includes(a.id));
    assert.ok((await techProd.ok('GET', '/api/ot?mesOT=1')).every((o) => o.technicienId === uTechProd.id || o.techniciens.includes(uTechProd.id)));
    assert.ok((await resp.ok('GET', '/api/ot?ouverts=1')).every((o) => !o.final));
    const c = await resp.ok('GET', '/api/ot-compteurs');
    for (const k of ['ouverts', 'enRetard', 'mesOT', 'enCours']) assert.equal(typeof c[k], 'number', k);
    assert.ok(c.enRetard >= 1);
    assert.equal(c.ouverts, (await resp.ok('GET', '/api/ot?ouverts=1')).length);
  });

  test('workflow : démarrage, mise en attente, droits du technicien affecté', async () => {
    const o = await chefProd.ok('POST', '/api/ot', { titre: 'Workflow statuts', equipementId: presse.id, technicienId: uTechLimite.id });
    // Statut inconnu / identique / vide
    assert.equal((await chefProd.post(`/api/ot/${o.id}/statut`, { statut: 'inexistant' })).status, 400);
    assert.equal((await chefProd.post(`/api/ot/${o.id}/statut`, { statut: 'nouveau' })).status, 400);
    assert.equal((await chefProd.post(`/api/ot/${o.id}/statut`, {})).status, 400);
    // Technicien affecté sans droit « modifier » : statut non final autorisé
    const enCours = await techLimite.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'en_cours' });
    assert.equal(enCours.statut, 'en_cours');
    assert.ok(enCours.dateDebut, 'date de début posée au premier passage en cours');
    const ev = evts('ot:statut', o.id).slice(-1)[0];
    assert.equal(ev.ancien, 'nouveau'); assert.equal(ev.nouveau, 'en_cours');
    const attente = await techLimite.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'en_attente', commentaire: 'Attente pièce' });
    assert.equal(attente.statut, 'en_attente');
    const repris = await techLimite.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'en_cours' });
    assert.equal(repris.dateDebut, enCours.dateDebut, 'la date de début n\'est pas écrasée');
    // Technicien non affecté et sans droit « modifier » : 403
    const autre = await chefProd.ok('POST', '/api/ot', { titre: 'Workflow non affecté', equipementId: presse.id });
    assert.equal((await techLimite.post(`/api/ot/${autre.id}/statut`, { statut: 'en_cours' })).status, 403);
    // Clôture par le technicien affecté : selon config.workflow.autoriserTechnicienCloture
    config({ workflow: { autoriserTechnicienCloture: false } });
    assert.equal((await techLimite.post(`/api/ot/${o.id}/statut`, { statut: 'termine' })).status, 403);
    assert.equal((await techLimite.post(`/api/ot/${o.id}/cloturer`, { rapport: 'Fini' })).status, 403);
    assert.equal((await techLimite.get(`/api/ot/${o.id}`)).body.actions.cloturer, false);
    config({ workflow: { autoriserTechnicienCloture: true } });
    assert.equal((await techLimite.get(`/api/ot/${o.id}`)).body.actions.cloturer, true);
    // Un statut final de réalisation obéit aux mêmes règles que la clôture : compte rendu obligatoire
    const sansRapport = await techLimite.post(`/api/ot/${o.id}/statut`, { statut: 'termine' });
    assert.equal(sansRapport.status, 400);
    assert.match(sansRapport.body.erreur, /compte rendu est obligatoire/);
    assert.equal(srv.db.get('ot', o.id).statut, 'en_cours', 'statut inchangé');
    const fini = await techLimite.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'termine', rapport: 'Intervention terminée sans anomalie.' });
    assert.equal(fini.statut, 'termine');
    assert.equal(fini.rapport, 'Intervention terminée sans anomalie.');
    assert.ok(fini.dateFin && fini.dateCloture);
    assert.equal(fini.cloturePar, uTechLimite.id);
    assert.equal(evts('ot:termine', o.id).length, 1);
    // Final → final interdit ; réouverture via statut réservée au droit modifier
    assert.equal((await chefProd.post(`/api/ot/${o.id}/statut`, { statut: 'annule' })).status, 400);
    assert.equal((await techLimite.post(`/api/ot/${o.id}/statut`, { statut: 'en_cours' })).status, 403);
    const rouvert = await chefProd.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'en_cours', commentaire: 'Défaut réapparu' });
    assert.equal(rouvert.statut, 'en_cours');
    assert.equal(rouvert.dateFin, null);
    assert.equal(rouvert.cloturePar, null);
  });

  test('affectation : droit affecter, notifications, passage automatique en planifié', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'À affecter', equipementId: presse.id });
    assert.equal((await techProd.post(`/api/ot/${o.id}/affecter`, { technicienId: uTechProd.id })).status, 403, 'technicien sans droit affecter');
    assert.equal((await chefProd.post(`/api/ot/${o.id}/affecter`, {})).status, 400);
    assert.equal((await chefProd.post(`/api/ot/${o.id}/affecter`, { technicienId: uDemandeur.id })).status, 400, 'utilisateur sans accès OT');
    const avant = notifsDe(uTechLimite.id).length;
    const a = await chefProd.ok('POST', `/api/ot/${o.id}/affecter`, { technicienId: uTechProd.id, techniciens: [uTechProd.id, uTechLimite.id], datePrevue: jourLocal(1) });
    assert.equal(a.technicienId, uTechProd.id);
    assert.deepEqual(a.techniciens.slice().sort(), [uTechProd.id, uTechLimite.id].sort());
    assert.equal(a.datePrevue, jourLocal(1));
    assert.equal(a.statut, 'planifie', 'OT nouveau affecté et daté → planifié');
    assert.equal(notifsDe(uTechLimite.id).length, avant + 1);
    assert.ok(srv.db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === o.id && x.action === 'affectation'));
    const sans = await resp.ok('POST', '/api/ot', { titre: 'Affecté sans planifier', equipementId: presse.id });
    const b = await resp.ok('POST', `/api/ot/${sans.id}/affecter`, { technicienId: uTechProd.id, datePrevue: jourLocal(3), planifier: false });
    assert.equal(b.statut, 'nouveau');
  });

  test('modification : droit modifier complet, technicien affecté limité à la réalisation', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Modification test', equipementId: presse.id, technicienId: uTechLimite.id });
    const m = await chefProd.ok('PUT', `/api/ot/${o.id}`, { titre: 'Modification test (renommé)', prioriteCode: 'urgente', dureeEstimee: 2.5 });
    assert.equal(m.titre, 'Modification test (renommé)');
    assert.equal(m.prioriteCode, 'urgente');
    assert.equal(m.dureeEstimee, 2.5);
    assert.equal((await chefProd.put(`/api/ot/${o.id}`, { prioriteCode: 'zzz' })).status, 400);
    assert.equal((await chefProd.put(`/api/ot/${o.id}`, { statut: 'termine' })).status, 400, 'statut via workflow uniquement');
    assert.equal((await techLimite.put(`/api/ot/${o.id}`, { titre: 'Interdit' })).status, 403, 'technicien sans modifier : planification interdite');
    const r = await techLimite.ok('PUT', `/api/ot/${o.id}`, { rapport: 'Diagnostic en cours', causeCode: 'usure' });
    assert.equal(r.rapport, 'Diagnostic en cours');
    assert.equal(r.causeCode, 'usure');
    assert.equal((await techLimite.put(`/api/ot/${o.id}`, { causeCode: 'zzz' })).status, 400);
    assert.equal((await techLog.put(`/api/ot/${o.id}`, { rapport: 'x' })).status, 404, 'hors portée');
    // Changement d'équipement → secteur repris
    const autreEq = srv.db.insert('equipements', { numero: 'EQ-T004', nom: 'Équipement sans secteur', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'C', secteurId: null, actif: true, documents: [], champs: {}, createdBy: 1 });
    const m2 = await resp.ok('PUT', `/api/ot/${o.id}`, { equipementId: autreEq.id });
    assert.equal(m2.secteurId, null);
    // Affectation via PUT : réservée au droit affecter
    assert.equal((await techProd.put(`/api/ot/${o.id}`, { technicienId: uTechProd.id })).status, 403);
    const m3 = await resp.ok('PUT', `/api/ot/${o.id}`, { technicienId: uTechProd.id });
    assert.equal(m3.technicienId, uTechProd.id);
    assert.ok(evts('ot:modifie', o.id).length >= 1);
  });

  test('temps passés : coût de main d\'œuvre, validations, droits', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Temps passés', equipementId: presse.id, technicienId: uTechLimite.id });
    const taux = srv.db.getConfig().general.tauxHoraire;
    let r = await techLimite.ok('POST', `/api/ot/${o.id}/temps`, { date: jourLocal(0), heures: 2.5, commentaire: 'Diagnostic' });
    assert.equal(r.tempsPasse.length, 1);
    assert.equal(r.tempsPasse[0].userId, uTechLimite.id);
    assert.equal(r.coutMainOeuvre, 2.5 * taux);
    assert.equal(r.tempsTotal, 2.5);
    r = await resp.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1, userId: uTechProd.id });
    assert.equal(r.coutMainOeuvre, 3.5 * taux);
    assert.ok(r.techniciens.includes(uTechProd.id), 'l\'intervenant saisi rejoint les intervenants');
    for (const corps of [{ heures: 0 }, { heures: -1 }, { heures: 25 }, { heures: 'x' }, {}, { heures: 1, date: jourLocal(2) }, { heures: 1, date: '2026-13-01' }]) {
      assert.equal((await techLimite.post(`/api/ot/${o.id}/temps`, corps)).status, 400, JSON.stringify(corps));
    }
    assert.equal((await techLimite.post(`/api/ot/${o.id}/temps`, { heures: 22, date: jourLocal(0) })).status, 400, 'plus de 24 h dans la journée');
    assert.equal((await techLimite.post(`/api/ot/${o.id}/temps`, { heures: 1, userId: uTechProd.id })).status, 403, 'saisie pour autrui');
    const autre = await resp.ok('POST', '/api/ot', { titre: 'Temps non affecté', equipementId: presse.id });
    assert.equal((await techLimite.post(`/api/ot/${autre.id}/temps`, { heures: 1 })).status, 403);
    assert.equal((await techLimite.del(`/api/ot/${o.id}/temps/1`)).status, 403, 'suppression de la saisie d\'un autre');
    assert.equal((await techLimite.del(`/api/ot/${o.id}/temps/9`)).status, 404);
    r = await techLimite.ok('DELETE', `/api/ot/${o.id}/temps/0`);
    assert.equal(r.tempsPasse.length, 1);
    assert.equal(r.coutMainOeuvre, 1 * taux);
  });

  test('pièces : sortie de stock via le service, coût, retour en stock, erreurs', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Pièces consommées', equipementId: presse.id, technicienId: uTechProd.id });
    const reel = srv.ctx.services.stock;
    delete srv.ctx.services.stock;
    try {
      assert.equal((await techProd.post(`/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 1 })).status, 503, 'module stock indisponible');
      assert.equal((await techProd.get(`/api/ot/${o.id}`)).body.stockDisponible, false);
    } finally { if (reel) srv.ctx.services.stock = reel; }
    installerStock();
    const art = await techProd.ok('GET', `/api/ot-articles?otId=${o.id}`);
    assert.equal(art.disponible, true);
    assert.ok(art.articles.find((a) => a.id === articleJoint.id).compatible, 'article compatible avec l\'équipement');
    let r = await techProd.ok('POST', `/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 2 });
    const appel = appelsStock.sortir.slice(-1)[0];
    assert.deepEqual({ articleId: appel.articleId, quantite: appel.quantite, otId: appel.otId, userId: appel.userId }, { articleId: articleJoint.id, quantite: 2, otId: o.id, userId: uTechProd.id });
    assert.match(appel.motif, new RegExp(o.numero));
    assert.equal(r.pieces.length, 1);
    assert.equal(r.pieces[0].designation, 'Joint de tige Ø50');
    assert.equal(r.pieces[0].prixUnitaire, 12.5);
    assert.ok(r.pieces[0].mouvementId);
    assert.equal(r.coutPieces, 25);
    assert.equal(r.coutTotal, 25);
    assert.equal(srv.db.get('articles', articleJoint.id).quantite, 8);
    assert.equal(r.mouvements.length, 1, 'mouvements de stock liés à l\'OT');
    // Erreurs
    assert.equal((await techProd.post(`/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 0 })).status, 400);
    assert.equal((await techProd.post(`/api/ot/${o.id}/pieces`, { articleId: 9999, quantite: 1 })).status, 400);
    assert.equal((await techProd.post(`/api/ot/${o.id}/pieces`, {})).status, 400);
    const insuffisant = await techProd.post(`/api/ot/${o.id}/pieces`, { articleId: articleRare.id, quantite: 3 });
    assert.equal(insuffisant.status, 400);
    assert.match(insuffisant.body.erreur, /Stock insuffisant/);
    assert.equal((await techLog.post(`/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 1 })).status, 404, 'hors portée');
    // Suppression impossible tant que des pièces sont sorties
    assert.equal((await resp.del(`/api/ot/${o.id}`)).status, 400);
    // Retour en stock
    r = await techProd.ok('DELETE', `/api/ot/${o.id}/pieces/0`);
    assert.equal(r.pieces.length, 0);
    assert.equal(r.coutPieces, 0);
    assert.equal(appelsStock.annuler.slice(-1)[0].userId, uTechProd.id);
    assert.equal(srv.db.get('articles', articleJoint.id).quantite, 10);
    assert.equal((await techProd.del(`/api/ot/${o.id}/pieces/0`)).status, 404);
  });

  test('tâches : gamme copiée depuis un plan préventif, ajout, coche, suppression', async () => {
    const plan = srv.db.insert('plansPreventifs', { numero: 'PP-T01', nom: 'Graissage mensuel presse', equipementId: presse.id, secteurId: PROD, typeCode: 'preventif', prioriteCode: 'normale', periodicite: { type: 'mois', valeur: 1 }, dureeEstimee: 1.5, gamme: [{ ordre: 2, libelle: 'Graisser les colonnes', duree: 0.5 }, { ordre: 1, libelle: 'Consigner la presse', duree: 0.25 }], pieces: [{ articleId: articleJoint.id, quantite: 1 }], actif: true });
    const o = await resp.ok('POST', '/api/ot', { planPreventifId: plan.id, technicienId: uTechLimite.id });
    assert.equal(o.titre, 'Graissage mensuel presse', 'titre repris du plan');
    assert.equal(o.typeCode, 'preventif');
    assert.equal(o.equipementId, presse.id);
    assert.equal(o.dureeEstimee, 1.5);
    assert.equal(o.planPreventifId, plan.id);
    assert.deepEqual(o.taches.map((t) => t.libelle), ['Consigner la presse', 'Graisser les colonnes']);
    assert.ok(o.taches.every((t) => t.fait === false));
    assert.equal(o.piecesPrevues.length, 1);
    assert.equal(o.plan.nom, 'Graissage mensuel presse');
    let r = await techLimite.ok('POST', `/api/ot/${o.id}/taches`, { libelle: 'Contrôler le niveau d\'huile' });
    assert.equal(r.taches.length, 3);
    assert.equal(r.taches[2].ordre, 3);
    assert.equal((await techLimite.post(`/api/ot/${o.id}/taches`, { libelle: '' })).status, 400);
    r = await techLimite.ok('PUT', `/api/ot/${o.id}/taches/0`, { fait: true });
    assert.equal(r.taches[0].fait, true);
    assert.equal(r.taches[0].faitPar, uTechLimite.id);
    assert.equal(r.nbTachesFaites, 1);
    assert.equal((await techLimite.put(`/api/ot/${o.id}/taches/0`, { fait: 'oui' })).status, 400);
    assert.equal((await techLimite.put(`/api/ot/${o.id}/taches/0`, { libelle: 'Renommage' })).status, 403, 'renommage réservé au droit modifier');
    assert.equal((await techLimite.put(`/api/ot/${o.id}/taches/7`, { fait: true })).status, 404);
    // Retirer une étape de la gamme (copiée d'un plan) est réservé au droit « modifier », comme la renommer
    assert.equal((await techLimite.del(`/api/ot/${o.id}/taches/1`)).status, 403, 'suppression réservée au droit modifier');
    assert.equal(srv.db.get('ot', o.id).taches.length, 3);
    assert.equal((await techLimite.get(`/api/ot/${o.id}`)).body.actions.modifier, false);
    r = await resp.ok('DELETE', `/api/ot/${o.id}/taches/1`);
    assert.deepEqual(r.taches.map((t) => t.ordre), [1, 2]);
    assert.ok(r.historique.some((h) => h.action === 'modification' && /Tâche supprimée.*Graisser les colonnes/.test(h.commentaire)), 'suppression tracée dans l\'historique');
    // Service ouvertsPour
    const ouverts = srv.ctx.services.ot.ouvertsPour({ planPreventifId: plan.id });
    assert.deepEqual(ouverts.map((x) => x.id), [o.id]);
  });

  test('clôture : rapport obligatoire, relevé de compteur, notifications, verrouillage, réouverture', async () => {
    const o = await techProd.ok('POST', '/api/ot', { titre: 'Clôture complète', equipementId: presse.id, technicienId: uTechProd.id });
    await techProd.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'en_cours' });
    await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1.5 });
    assert.equal((await techProd.post(`/api/ot/${o.id}/cloturer`, {})).status, 400, 'rapport obligatoire');
    assert.equal((await techProd.post(`/api/ot/${o.id}/cloturer`, { rapport: 'OK', causeCode: 'zzz' })).status, 400, 'cause inconnue');
    assert.equal((await techProd.post(`/api/ot/${o.id}/cloturer`, { rapport: 'Remplacement', compteurReleve: -3 })).status, 400, 'compteur négatif');
    assert.equal((await techProd.post(`/api/ot/${o.id}/cloturer`, { rapport: 'Remplacement', dateFin: jourLocal(3) })).status, 400, 'date de fin future');
    assert.equal(srv.db.get('ot', o.id).statut, 'en_cours', 'aucune modification en cas d\'erreur');
    const avantResp = notifsDe(uChefProd.id).length;
    const c = await techProd.ok('POST', `/api/ot/${o.id}/cloturer`, { rapport: 'Joint remplacé, essais concluants.', causeCode: 'usure', compteurReleve: 1250, coutExterne: 80 });
    assert.equal(c.statut, 'termine');
    assert.equal(c.rapport, 'Joint remplacé, essais concluants.');
    assert.equal(c.causeCode, 'usure');
    assert.equal(c.cloturePar, uTechProd.id);
    assert.ok(c.dateCloture && c.dateFin);
    assert.equal(c.compteurReleve, 1250);
    assert.equal(c.coutExterne, 80);
    assert.equal(c.coutTotal, 80 + 1.5 * srv.db.getConfig().general.tauxHoraire);
    assert.ok(Array.isArray(c.avertissements));
    if (srv.ctx.services.equipements) assert.equal(srv.db.get('equipements', presse.id).compteur.valeur, 1250, 'compteur de l\'équipement relevé');
    assert.equal(evts('ot:termine', o.id).length, 1);
    assert.equal(evts('ot:statut', o.id).slice(-1)[0].nouveau, 'termine');
    assert.equal(notifsDe(uChefProd.id).length, avantResp, 'le créateur n\'est pas notifié de sa propre clôture');
    assert.ok(srv.db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === o.id && x.action === 'cloture'));
    // OT clôturé : verrouillé
    assert.equal((await techProd.post(`/api/ot/${o.id}/cloturer`, { rapport: 'Encore' })).status, 400);
    assert.equal((await techProd.put(`/api/ot/${o.id}`, { rapport: 'Modifié' })).status, 400);
    assert.equal((await techProd.post(`/api/ot/${o.id}/temps`, { heures: 1 })).status, 400);
    assert.equal((await techProd.post(`/api/ot/${o.id}/taches`, { libelle: 'Tâche tardive' })).status, 400);
    assert.equal((await resp.del(`/api/ot/${o.id}`)).status, 400, 'un OT terminé ne se supprime pas');
    // Commentaires toujours possibles
    await techProd.ok('POST', `/api/ot/${o.id}/commentaires`, { texte: 'Penser à commander un joint de rechange.' });
    // Réouverture : droit modifier
    assert.equal((await techLimite.post(`/api/ot/${o.id}/reouvrir`, {})).status, 403);
    const rouvert = await chefProd.ok('POST', `/api/ot/${o.id}/reouvrir`, { motif: 'Fuite persistante' });
    assert.equal(rouvert.statut, 'en_cours', 'retour au dernier statut non final');
    assert.equal(rouvert.dateCloture, null);
    assert.equal((await chefProd.post(`/api/ot/${o.id}/reouvrir`, {})).status, 400, 'pas clôturé');
    // Modification d'un OT clôturé avec réouverture explicite
    await techProd.ok('POST', `/api/ot/${o.id}/cloturer`, { rapport: 'Fuite traitée définitivement.' });
    const m = await chefProd.ok('PUT', `/api/ot/${o.id}`, { reouvrir: true, motifReouverture: 'Compléter la description', description: 'Description complétée' });
    assert.equal(m.statut, 'en_cours');
    assert.equal(m.description, 'Description complétée');
  });

  test('annulation : événement ot:annule, motif obligatoire si pièces consommées', async () => {
    installerStock();
    const o = await resp.ok('POST', '/api/ot', { titre: 'Annulation test', equipementId: presse.id, technicienId: uTechProd.id });
    await techProd.ok('POST', `/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 1 });
    assert.equal((await chefProd.post(`/api/ot/${o.id}/statut`, { statut: 'annule' })).status, 400, 'motif requis');
    const a = await chefProd.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'annule', commentaire: 'Doublon' });
    assert.equal(a.statut, 'annule');
    assert.equal(evts('ot:annule', o.id).length, 1);
    assert.equal(evts('ot:termine', o.id).length, 0);
  });

  test('suppression : droit supprimer, événement', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'À supprimer', equipementId: presse.id });
    assert.equal((await chefProd.del(`/api/ot/${o.id}`)).status, 403, 'chef de secteur sans droit supprimer');
    await resp.ok('DELETE', `/api/ot/${o.id}`);
    assert.equal(srv.db.get('ot', o.id), null);
    assert.equal((await resp.get(`/api/ot/${o.id}`)).status, 404);
    assert.equal(evts('ot:supprime', o.id).length, 1);
    assert.ok(srv.db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === o.id && x.action === 'suppression'));
  });

  test('duplication : nouveau numéro, statut initial, gamme remise à zéro', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Source à dupliquer', equipementId: presse.id, technicienId: uTechProd.id, taches: ['Étape 1', { libelle: 'Étape 2', duree: 1 }] });
    await techProd.ok('PUT', `/api/ot/${o.id}/taches/0`, { fait: true });
    await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1 });
    assert.equal((await demandeur.post(`/api/ot/${o.id}/dupliquer`, {})).status, 403);
    const copie = await resp.ok('POST', `/api/ot/${o.id}/dupliquer`, { datePrevue: jourLocal(7) });
    assert.notEqual(copie.id, o.id);
    assert.notEqual(copie.numero, o.numero);
    assert.equal(copie.titre, o.titre);
    assert.equal(copie.statut, 'nouveau');
    assert.equal(copie.datePrevue, jourLocal(7));
    assert.deepEqual(copie.taches.map((t) => [t.libelle, t.fait]), [['Étape 1', false], ['Étape 2', false]]);
    assert.equal(copie.tempsPasse.length, 0);
    assert.equal(copie.technicienId, uTechProd.id);
    assert.ok(srv.db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === copie.id && x.action === 'duplication'));
  });

  test('commentaires et documents', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Échanges et documents', equipementId: presse.id, technicienId: uTechProd.id });
    const avant = notifsDe(uTechProd.id).length;
    let r = await chefProd.ok('POST', `/api/ot/${o.id}/commentaires`, { texte: 'Merci de prévoir la nacelle.' });
    assert.equal(r.commentaires.length, 1);
    assert.equal(r.commentaires[0].userId, uChefProd.id);
    assert.equal(notifsDe(uTechProd.id).length, avant + 1, 'intervenant notifié');
    assert.equal((await chefProd.post(`/api/ot/${o.id}/commentaires`, { texte: '  ' })).status, 400);
    assert.equal((await techLimite.del(`/api/ot/${o.id}/commentaires/0`)).status, 403, 'commentaire d\'un autre (sans droit modifier)');
    const contenu = 'data:text/plain;base64,' + Buffer.from('Schéma de câblage').toString('base64');
    assert.equal((await techProd.post(`/api/ot/${o.id}/documents`, { nom: 'x.txt', contenu: 'pas du base64' })).status, 400);
    assert.equal((await techProd.post(`/api/ot/${o.id}/documents`, { contenu })).status, 400, 'nom obligatoire');
    const doc = await techProd.ok('POST', `/api/ot/${o.id}/documents`, { nom: 'schema.txt', type: 'text/plain', contenu, description: 'Schéma' });
    assert.equal(doc.documents.length, 1);
    const telecharge = await techProd.get(`/api/ot/${o.id}/documents/0`);
    assert.equal(telecharge.status, 200);
    assert.equal(telecharge.body, 'Schéma de câblage');
    const detail = await techProd.ok('GET', `/api/ot/${o.id}`);
    assert.equal(detail.documents[0].nom, 'schema.txt');
    assert.equal(detail.documents[0].contenu, undefined, 'contenu non renvoyé dans la fiche');
    const liste = await techProd.ok('GET', '/api/ot');
    assert.equal(liste.find((x) => x.id === o.id).nbDocuments, 1);
    assert.equal((await techLimite.del(`/api/ot/${o.id}/documents/0`)).status, 403, 'ni auteur, ni droit modifier');
    assert.equal((await techLog.del(`/api/ot/${o.id}/documents/0`)).status, 404, 'hors portée');
    await techProd.ok('DELETE', `/api/ot/${o.id}/documents/0`);
    assert.equal((await techProd.get(`/api/ot/${o.id}/documents/0`)).status, 404);
    r = await chefProd.ok('DELETE', `/api/ot/${o.id}/commentaires/0`);
    assert.equal(r.commentaires.length, 0);
  });

  test('export CSV : cellules commençant par = + - @ neutralisées (injection de formules)', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: '=HYPERLINK("http://exemple.invalid";"Cliquer")', description: '@cmd|calc', equipementId: presse.id, typeCode: 'correctif' });
    const ligne = String((await resp.get('/api/ot-export')).body).split('\r\n').find((l) => l.startsWith(o.numero + ';'));
    assert.ok(ligne, 'ligne exportée');
    assert.ok(ligne.includes(';"\'=HYPERLINK('), 'apostrophe devant = : ' + ligne);
    assert.ok(!/;"?=HYPERLINK/.test(ligne), 'aucune formule exécutable');
    await admin.ok('DELETE', '/api/ot/' + o.id);
  });

  test('intervenants : absence validée à la date prévue signalée (module RH), libellé détaillé réservé au droit rh › voir', async () => {
    const rh = srv.ctx.services.rh;
    if (!rh || typeof rh.absenceDe !== 'function') return;
    const jour = '2030-06-10';
    const pers = srv.db.insert('personnel', { nom: 'Technicien', prenom: 'Théo', userId: uTechProd.id, secteurId: PROD, actif: true });
    const abs = srv.db.insert('absences', { personnelId: pers.id, typeCode: 'conges', statut: 'validee', dateDebut: '2030-06-09', dateFin: '2030-06-11', secteurId: PROD });
    try {
      const sans = (await resp.ok('GET', '/api/ot-techniciens')).find((t) => t.id === uTechProd.id);
      assert.equal(sans.absent, false); assert.equal(sans.absenceLibelle, '');
      const avec = (await resp.ok('GET', `/api/ot-techniciens?datePrevue=${jour}`)).find((t) => t.id === uTechProd.id);
      assert.equal(avec.absent, true); assert.equal(avec.absenceDate, jour);
      const u = srv.db.get('users', uResp.id);
      const voitRh = srv.ctx.perms.can(srv.ctx.perms.effectivePermissions(srv.db, u, null, srv.ctx.config()), 'rh', 'voir');
      assert.equal(avec.absenceLibelle, voitRh ? 'Congés payés' : 'Absent');
      const t = srv.db.get('users', uTechProd.id);
      const techVoitRh = srv.ctx.perms.can(srv.ctx.perms.effectivePermissions(srv.db, t, null, srv.ctx.config()), 'rh', 'voir');
      const vu = (await techProd.ok('GET', `/api/ot-techniciens?datePrevue=${jour}`)).find((x) => x.id === uTechProd.id);
      assert.equal(vu.absenceLibelle, techVoitRh ? 'Congés payés' : 'Absent');
      const autre = (await resp.ok('GET', `/api/ot-techniciens?datePrevue=2030-06-12`)).find((x) => x.id === uTechProd.id);
      assert.equal(autre.absent, false, 'hors de la période d\'absence');
      const o = await resp.ok('POST', '/api/ot', { titre: 'OT planifié pendant une absence', equipementId: presse.id, typeCode: 'correctif', datePrevue: jour });
      const parOt = (await resp.ok('GET', `/api/ot-techniciens?otId=${o.id}`)).find((x) => x.id === uTechProd.id);
      assert.equal(parOt.absent, true, 'date prévue de l\'OT');
      assert.equal((await resp.get('/api/ot-techniciens?datePrevue=pas-une-date')).status, 400);
      await admin.ok('DELETE', '/api/ot/' + o.id);
    } finally { srv.db.remove('absences', abs.id); srv.db.remove('personnel', pers.id); }
  });

  test('export CSV et liste des intervenants', async () => {
    const r = await resp.get('/api/ot-export?ouverts=1');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.body, /Numéro;Titre;Type;Priorité;Statut/);
    assert.match(r.body, /OT-\d{4}-\d{4}/);
    assert.ok(!/;Terminé;/.test(r.body), 'filtre ouverts appliqué');
    const chef = await chefProd.get('/api/ot-export');
    assert.equal(chef.status, 200);
    assert.ok(!chef.body.includes('Chariot : contrôle des freins'), 'portée appliquée à l\'export');
    const techs = await techProd.ok('GET', '/api/ot-techniciens');
    assert.ok(techs.some((t) => t.id === uTechProd.id && typeof t.charge === 'number'));
    assert.ok(!techs.some((t) => t.id === uDemandeur.id), 'utilisateur sans accès OT exclu');
  });

  test('intégration demandes : création automatique à la validation, clôture liée, service idempotent', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Bruit anormal presse test', description: 'Claquement à chaque cycle', equipementId: presse.id, prioriteCode: 'haute', typeCode: 'correctif' });
    const v = await chefProd.ok('POST', `/api/demandes/${d.id}/valider`, {});
    const otId = (v.demande && v.demande.otId) || v.otId || (v.otCree && v.otCree.id) || (srv.db.get('demandes', d.id) || {}).otId;
    assert.ok(otId, 'OT créé automatiquement : ' + JSON.stringify(v).slice(0, 300));
    const o = await chefProd.ok('GET', `/api/ot/${otId}`);
    assert.equal(o.demandeId, d.id);
    assert.equal(o.titre, 'Bruit anormal presse test');
    assert.equal(o.description, 'Claquement à chaque cycle');
    assert.equal(o.prioriteCode, 'haute');
    assert.equal(o.equipementId, presse.id);
    assert.equal(o.secteurId, PROD);
    assert.equal(o.statut, 'nouveau');
    assert.equal(o.createdBy, uChefProd.id);
    assert.equal(o.demande.numero, d.numero);
    assert.equal(srv.db.get('demandes', d.id).statut, 'convertie');
    // Idempotence du service
    const encore = srv.ctx.services.ot.creerDepuisDemande(srv.db.get('demandes', d.id), null);
    assert.equal(encore.id, otId);
    // Une seconde création manuelle liée à la même demande est refusée
    assert.equal((await resp.post('/api/ot', { titre: 'Doublon', demandeId: d.id })).status, 400);
    // Clôture de l'OT → clôture de la demande (option cloturerDemandeAvecOt) ; le demandeur est prévenu une seule fois
    const avantCloture = notifsDe(uDemandeur.id).length;
    await chefProd.ok('POST', `/api/ot/${otId}/cloturer`, { rapport: 'Palier resserré, bruit disparu.' });
    assert.equal(srv.db.get('demandes', d.id).statut, 'cloturee');
    const nouvelles = notifsDe(uDemandeur.id).slice(avantCloture);
    assert.equal(nouvelles.length, 1, `une seule notification de fin d'intervention : ${nouvelles.map((n) => n.titre).join(' | ')}`);
    assert.match(nouvelles[0].titre, /Demande .* clôturée|OT\S* terminé/);
    assert.ok(!/^OT OT-/.test(nouvelles[0].titre), 'préfixe « OT » non doublé : ' + nouvelles[0].titre);
    // Sans clôture automatique de la demande, c'est l'OT qui prévient le demandeur
    const d2 = await demandeur.ok('POST', '/api/demandes', { titre: 'Vibration anormale presse test', equipementId: presse.id, prioriteCode: 'normale', typeCode: 'correctif' });
    const v2 = await chefProd.ok('POST', `/api/demandes/${d2.id}/valider`, {});
    const otId2 = (v2.demande && v2.demande.otId) || v2.otId || (srv.db.get('demandes', d2.id) || {}).otId;
    config({ workflow: { cloturerDemandeAvecOt: false } });
    try {
      const avant2 = notifsDe(uDemandeur.id).length;
      await chefProd.ok('POST', `/api/ot/${otId2}/cloturer`, { rapport: 'Fixations resserrées.' });
      const n2 = notifsDe(uDemandeur.id).slice(avant2);
      assert.equal(n2.length, 1);
      assert.match(n2[0].titre, /OT\S* terminé/);
      assert.ok(!/^OT OT-/.test(n2[0].titre), 'préfixe « OT » non doublé : ' + n2[0].titre);
      assert.equal(srv.db.get('demandes', d2.id).statut, 'convertie', 'demande non clôturée (option désactivée)');
    } finally { config({ workflow: { cloturerDemandeAvecOt: true } }); }
  });

  test('création depuis une demande : demande visible et validée uniquement (la validation reste au module Demandes)', async () => {
    // Demande d'un autre secteur (LOG), encore soumise : invisible pour le technicien PROD
    const diLog = await admin.ok('POST', '/api/demandes', { titre: 'Fuite hydraulique mât (confidentiel LOG)', description: 'Détail réservé à la logistique', equipementId: chariot.id, prioriteCode: 'haute', typeCode: 'correctif' });
    assert.equal(diLog.statut, 'soumise');
    assert.equal((await techProd.get(`/api/demandes/${diLog.id}`)).status, 404);
    const horsPortee = await techProd.post('/api/ot', { titre: 'OT pirate', demandeId: diLog.id, equipementId: null, secteurId: PROD, technicienId: uTechProd.id });
    assert.equal(horsPortee.status, 400, 'demande hors périmètre refusée même en remplaçant équipement et secteur');
    assert.match(horsPortee.body.erreur, /hors de votre périmètre/);
    assert.ok(!JSON.stringify(horsPortee.body).includes('confidentiel'), 'aucune information de la demande ne fuit');
    let d = srv.db.get('demandes', diLog.id);
    assert.equal(d.statut, 'soumise');
    assert.ok(d.otId == null && d.validateurId == null, 'demande intacte');
    // Demande visible mais seulement soumise : un OT ne vaut pas validation
    const diProd = await demandeur.ok('POST', '/api/demandes', { titre: 'Grincement presse (à valider)', equipementId: presse.id, prioriteCode: 'normale', typeCode: 'correctif' });
    const soumise = await techProd.post('/api/ot', { titre: 'Intervention presse', demandeId: diProd.id });
    assert.equal(soumise.status, 400);
    assert.match(soumise.body.erreur, /Validée.*statut actuel : Soumise/);
    assert.equal(srv.db.get('demandes', diProd.id).statut, 'soumise');
    // Demande validée (sans OT automatique) : création manuelle acceptée, valideur conservé
    config({ workflow: { otAutoDepuisDemande: false } });
    try {
      const v = await chefProd.ok('POST', `/api/demandes/${diProd.id}/valider`, {});
      assert.equal(v.statut, 'validee');
      const o = await techProd.ok('POST', '/api/ot', { titre: 'Intervention presse', demandeId: diProd.id });
      assert.equal(o.demandeId, diProd.id);
      assert.equal(o.equipementId, presse.id);
      assert.equal(o.demande.numero, diProd.numero);
      d = srv.db.get('demandes', diProd.id);
      assert.equal(d.statut, 'convertie');
      assert.equal(d.validateurId, uChefProd.id, 'le valideur reste celui de la validation');
      assert.equal(d.otId, o.id);
      // Demande refusée : aucun OT
      const diRef = await demandeur.ok('POST', '/api/demandes', { titre: 'Demande refusée test', equipementId: presse.id, prioriteCode: 'basse', typeCode: 'correctif' });
      await chefProd.ok('POST', `/api/demandes/${diRef.id}/refuser`, { motif: 'Hors maintenance' });
      assert.equal((await chefProd.post('/api/ot', { titre: 'OT sur refus', demandeId: diRef.id })).status, 400);
      assert.equal(srv.db.get('demandes', diRef.id).otId, null);
      // Le service système (conversion par le module Demandes) reste inchangé
      const diSys = await demandeur.ok('POST', '/api/demandes', { titre: 'Demande convertie par le service', equipementId: presse.id, prioriteCode: 'basse', typeCode: 'correctif' });
      await chefProd.ok('POST', `/api/demandes/${diSys.id}/valider`, {});
      const conv = await chefProd.ok('POST', `/api/demandes/${diSys.id}/convertir`, {});
      assert.equal(conv.statut, 'convertie');
      assert.ok(conv.otId != null);
    } finally { config({ workflow: { otAutoDepuisDemande: true } }); }
  });

  test('création depuis un plan préventif : plan visible et actif, un seul OT ouvert, équipement du plan imposé', async () => {
    const planLog = srv.db.insert('plansPreventifs', { numero: 'PP-T02', nom: 'VGP chariot LOG', description: 'Secret LOG', equipementId: chariot.id, secteurId: LOG, typeCode: 'reglementaire', prioriteCode: 'haute', periodicite: { type: 'mois', valeur: 12 }, prochaineEcheance: jourLocal(-30), derniereExecution: jourLocal(-395), gamme: [{ ordre: 1, libelle: 'Contrôle organisme agréé', duree: 2 }], pieces: [], actif: true });
    assert.equal((await techProd.get(`/api/preventif/${planLog.id}`)).status, 404, 'plan hors périmètre');
    const r = await techProd.post('/api/ot', { titre: 'OT bidon', planPreventifId: planLog.id, equipementId: null, secteurId: PROD, technicienId: uTechProd.id });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /hors de votre périmètre/);
    assert.ok(!JSON.stringify(r.body).includes('organisme agréé') && !JSON.stringify(r.body).includes('Secret LOG'), 'la gamme et la description du plan ne fuient pas');
    assert.equal(srv.db.count('ot', (o) => o.planPreventifId === planLog.id), 0);
    const avant = srv.db.get('plansPreventifs', planLog.id);
    assert.equal(avant.prochaineEcheance, jourLocal(-30), 'échéance du plan intacte');
    // Plan du secteur : l'équipement du plan est imposé (le corps ne peut ni l'effacer ni le remplacer)
    const planProd = srv.db.insert('plansPreventifs', { numero: 'PP-T03', nom: 'Contrôle presse trimestriel', equipementId: presse.id, secteurId: PROD, typeCode: 'preventif', prioriteCode: 'normale', periodicite: { type: 'mois', valeur: 3 }, prochaineEcheance: jourLocal(5), gamme: [{ ordre: 1, libelle: 'Contrôle des sécurités', duree: 1 }], pieces: [], actif: true });
    assert.equal((await techProd.post('/api/ot', { titre: 'Autre équipement', planPreventifId: planProd.id, equipementId: chariot.id })).status, 400);
    const o = await techProd.ok('POST', '/api/ot', { titre: 'Contrôle presse', planPreventifId: planProd.id, equipementId: null, secteurId: null, technicienId: uTechProd.id });
    assert.equal(o.equipementId, presse.id, 'équipement du plan repris');
    assert.equal(o.secteurId, PROD);
    assert.equal(o.taches.length, 1);
    // Un seul OT ouvert par plan (comme la génération préventive)
    const doublon = await techProd.post('/api/ot', { titre: 'Doublon', planPreventifId: planProd.id });
    assert.equal(doublon.status, 400);
    assert.match(doublon.body.erreur, /déjà ouvert/);
    // Plan désactivé
    srv.db.update('plansPreventifs', planProd.id, { actif: false });
    await chefProd.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'annule', commentaire: 'Test' });
    const inactif = await techProd.post('/api/ot', { titre: 'Plan inactif', planPreventifId: planProd.id });
    assert.equal(inactif.status, 400);
    assert.match(inactif.body.erreur, /désactivé/);
    // La génération système (service) n'est pas concernée par ces contrôles
    const genere = srv.ctx.services.ot.creer({ planPreventifId: planProd.id }, null, { systeme: true, souple: true, source: 'plan' });
    assert.equal(genere.planPreventifId, planProd.id);
    srv.db.update('plansPreventifs', planProd.id, { actif: true });
  });

  test('portée « site » et « perso » en écriture : secteurs hors périmètre et sites en lecture seule refusés', async () => {
    const siteB = await admin.ok('POST', '/api/secteurs', { nom: 'Usine B', code: 'USB', type: 'site' });
    const atelierB = await admin.ok('POST', '/api/secteurs', { nom: 'Atelier B1', code: 'B1', type: 'atelier', parentId: siteB.id });
    const siteC = await admin.ok('POST', '/api/secteurs', { nom: 'Usine C', code: 'USC', type: 'site' });
    const atelierC = await admin.ok('POST', '/api/secteurs', { nom: 'Atelier C1', code: 'C1', type: 'atelier', parentId: siteC.id });
    const profils = await admin.ok('GET', '/api/profils');
    const chef = profils.find((x) => x.nom === 'Chef de secteur').id;
    await admin.ok('POST', '/api/utilisateurs', { login: 'chefsite', nom: 'Site', prenom: 'Sam', profilId: chef, porteeOverride: 'site', secteurIds: [PROD], siteAcces: [{ siteId: siteB.id, mode: 'lecture' }], password: 'site1234', doitChangerMdp: false });
    const cs = srv.client(); await cs.login('chefsite', 'site1234');
    assert.equal((await cs.post('/api/ot', { titre: 'OT site lecture seule', secteurId: atelierB.id })).status, 403, 'site en lecture seule');
    assert.equal((await cs.post('/api/ot', { titre: 'OT site inconnu', secteurId: atelierC.id })).status, 403, 'site sans accès');
    const ok = await cs.ok('POST', '/api/ot', { titre: 'OT de mon site', secteurId: PROD });
    assert.equal((await cs.put(`/api/ot/${ok.id}`, { secteurId: atelierB.id })).status, 403, 'déplacement vers un site en lecture seule');
    assert.equal(srv.db.get('ot', ok.id).secteurId, PROD);
    const eqB = srv.db.insert('equipements', { numero: 'EQ-B1', nom: 'Presse usine B', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', secteurId: atelierB.id, actif: true, documents: [], champs: {}, createdBy: 1 });
    assert.equal((await cs.post('/api/ot', { titre: 'OT équipement lecture seule', equipementId: eqB.id })).status, 400, 'équipement d\'un site en lecture seule');
    // Portée « perso » limitée à ses secteurs
    const tech = profils.find((x) => x.nom === 'Technicien').id;
    await admin.ok('POST', '/api/utilisateurs', { login: 'tperso2', nom: 'Perso', prenom: 'Paul', profilId: tech, porteeOverride: 'perso', secteurIds: [PROD], password: 'perso1234', doitChangerMdp: false });
    const cp = srv.client(); await cp.login('tperso2', 'perso1234');
    assert.equal((await cp.post('/api/ot', { titre: 'OT perso hors secteur', secteurId: LOG })).status, 403);
    assert.equal((await cp.ok('POST', '/api/ot', { titre: 'OT perso dans son secteur', secteurId: PROD })).secteurId, PROD);
  });

  test('clôture sans démarrage : aucune date de début inventée (indicateurs de durée non faussés)', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Clôturé sans démarrer', equipementId: presse.id, technicienId: uTechProd.id, typeCode: 'correctif' });
    const c = await techProd.ok('POST', `/api/ot/${o.id}/cloturer`, { rapport: 'Réparation faite dans la foulée.' });
    assert.equal(c.statut, 'termine');
    assert.equal(c.dateDebut, null, 'pas de date de début = date de fin');
    assert.ok(c.avertissements.some((a) => /pas été démarré/.test(a)), 'l\'utilisateur est averti');
    // Avec du temps saisi : la date (jour seul) du temps ne devient pas un horodatage de début à minuit
    const o2 = await resp.ok('POST', '/api/ot', { titre: 'Clôturé avec temps sans démarrer', equipementId: presse.id, technicienId: uTechProd.id, typeCode: 'correctif' });
    await techProd.ok('POST', `/api/ot/${o2.id}/temps`, { heures: 1.5 });
    const c2 = await techProd.ok('POST', `/api/ot/${o2.id}/cloturer`, { rapport: 'Réglage effectué.' });
    assert.equal(c2.dateDebut, null);
    const c3 = await resp.ok('POST', `/api/ot/${(await resp.ok('POST', '/api/ot', { titre: 'Terminé par statut sans démarrer', equipementId: presse.id })).id}/statut`, { statut: 'termine', rapport: 'Fait.' });
    assert.equal(c3.dateDebut, null);
    // Un OT démarré garde son horodatage de début réel ; une date de début saisie explicitement est conservée
    const o4 = await resp.ok('POST', '/api/ot', { titre: 'Démarré puis clôturé', equipementId: presse.id, technicienId: uTechProd.id });
    const dem = await techProd.ok('POST', `/api/ot/${o4.id}/statut`, { statut: 'en_cours' });
    const c4 = await techProd.ok('POST', `/api/ot/${o4.id}/cloturer`, { rapport: 'Terminé.' });
    assert.equal(c4.dateDebut, dem.dateDebut);
    const o5 = await resp.ok('POST', '/api/ot', { titre: 'Début saisi à la clôture', equipementId: presse.id });
    const debut = new Date(Date.now() - 3600000).toISOString();
    assert.equal((await resp.ok('POST', `/api/ot/${o5.id}/cloturer`, { rapport: 'Terminé.', dateDebut: debut })).dateDebut, debut);
  });

  test('temps passé pour autrui : une personne non affectée n\'est ajoutée qu\'avec le droit « affecter », de façon tracée', async () => {
    const o = await resp.ok('POST', '/api/ot', { titre: 'Temps pour autrui', equipementId: presse.id, technicienId: uTechProd.id });
    // Technicien (modifier, sans affecter) : pas d'affectation déguisée
    const r = await techProd.post(`/api/ot/${o.id}/temps`, { heures: 2, userId: uTechLimite.id });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Affecter/);
    assert.equal((await techProd.post(`/api/ot/${o.id}/temps`, { heures: 2, userId: uDemandeur.id })).status, 403);
    assert.deepEqual(srv.db.get('ot', o.id).techniciens, [uTechProd.id]);
    // Chef de secteur (affecter) : l'intervenant est contrôlé (accès aux OT, périmètre), ajouté, tracé et notifié
    assert.equal((await chefProd.post(`/api/ot/${o.id}/temps`, { heures: 1, userId: uDemandeur.id })).status, 400, 'sans accès aux OT');
    assert.equal((await chefProd.post(`/api/ot/${o.id}/temps`, { heures: 1, userId: uTechLog.id })).status, 400, 'hors du périmètre du chef');
    const avant = notifsDe(uTechLimite.id).length;
    const ok = await chefProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1, userId: uTechLimite.id });
    assert.ok(ok.techniciens.includes(uTechLimite.id));
    assert.equal(ok.technicienId, uTechProd.id, 'le responsable ne change pas');
    assert.ok(ok.historique.some((h) => h.action === 'affectation' && /Intervenant ajouté/.test(h.commentaire)));
    assert.ok(srv.db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === o.id && x.action === 'affectation' && /saisie de temps/.test(x.details)));
    assert.equal(notifsDe(uTechLimite.id).length, avant + 1, 'intervenant ajouté notifié');
    // Déjà affecté : la saisie par un titulaire de « modifier » reste possible sans nouvelle affectation
    const encore = await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1, userId: uTechLimite.id });
    assert.equal(encore.tempsPasse.length, 2);
    assert.equal(encore.historique.filter((h) => h.action === 'affectation').length, 1);
  });

  test('statut final personnalisé : clôture complète, non supprimable, compté dans les terminés du mois', async () => {
    const cfg = srv.db.getConfig();
    const sauvegarde = JSON.parse(JSON.stringify(cfg.listes.statutsOT));
    cfg.listes.statutsOT = sauvegarde.concat([{ code: 'receptionne', label: 'Réceptionné', couleur: '#0891b2', ordre: 7, final: true }]);
    srv.db.setConfig(cfg);
    try {
      const o = await resp.ok('POST', '/api/ot', { titre: 'Réception personnalisée', equipementId: presse.id, technicienId: uTechProd.id });
      await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 2 });
      assert.equal((await resp.post(`/api/ot/${o.id}/statut`, { statut: 'receptionne' })).status, 400, 'compte rendu obligatoire');
      const avantMois = (await resp.ok('GET', '/api/ot-compteurs')).terminesMois;
      const r = await resp.ok('POST', `/api/ot/${o.id}/statut`, { statut: 'receptionne', rapport: 'Travaux réceptionnés.' });
      assert.equal(r.statut, 'receptionne');
      assert.equal(r.rapport, 'Travaux réceptionnés.');
      assert.ok(r.dateFin && r.cloturePar);
      assert.equal(evts('ot:termine', o.id).length, 1);
      assert.equal(r.actions.supprimer, false);
      assert.equal((await resp.del(`/api/ot/${o.id}`)).status, 400, 'OT terminé non supprimable');
      assert.ok(srv.db.get('ot', o.id), 'toujours présent');
      assert.equal((await resp.ok('GET', '/api/ot-compteurs')).terminesMois, avantMois + 1);
    } finally {
      const c2 = srv.db.getConfig(); c2.listes.statutsOT = sauvegarde; srv.db.setConfig(c2);
    }
  });

  test('affectation : un intervenant hors du périmètre du planificateur est refusé, liste des intervenants filtrée', async () => {
    const o = await chefProd.ok('POST', '/api/ot', { titre: 'Affectation périmètre', equipementId: presse.id });
    const r = await chefProd.post(`/api/ot/${o.id}/affecter`, { technicienId: uTechLog.id });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /hors de votre périmètre/);
    assert.equal((await chefProd.put(`/api/ot/${o.id}`, { techniciens: [uTechLog.id] })).status, 400);
    assert.equal((await chefProd.post('/api/ot', { titre: 'Création avec intervenant LOG', equipementId: presse.id, technicienId: uTechLog.id })).status, 400);
    await chefProd.ok('POST', `/api/ot/${o.id}/affecter`, { technicienId: uTechProd.id });
    // Le responsable maintenance (portée « tous ») peut affecter un technicien d'un autre secteur ; le chef le conserve ensuite
    const a = await resp.ok('POST', `/api/ot/${o.id}/affecter`, { techniciens: [uTechProd.id, uTechLog.id] });
    assert.ok(a.techniciens.includes(uTechLog.id));
    const b = await chefProd.ok('POST', `/api/ot/${o.id}/affecter`, { techniciens: [uTechProd.id, uTechLog.id, uTechLimite.id] });
    assert.ok(b.techniciens.includes(uTechLog.id), 'intervenant déjà affecté conservé');
    const pourChef = (await chefProd.ok('GET', '/api/ot-techniciens')).map((t) => t.id);
    assert.ok(pourChef.includes(uTechProd.id) && pourChef.includes(uChefProd.id));
    assert.ok(!pourChef.includes(uTechLog.id), 'technicien d\'un autre secteur absent de la liste du chef');
    const pourResp = (await resp.ok('GET', '/api/ot-techniciens')).map((t) => t.id);
    assert.ok(pourResp.includes(uTechLog.id) && pourResp.includes(uTechProd.id));
  });

  test('export CSV : les listes de valeurs ne sont lues qu\'une fois par export', async () => {
    const original = srv.ctx.liste;
    let appels = 0;
    srv.ctx.liste = function (...args) { appels++; return original.apply(this, args); };
    try {
      const r = await resp.get('/api/ot-export');
      assert.equal(r.status, 200);
      const lignes = r.body.split('\r\n').length - 1;
      assert.ok(lignes >= 10, `${lignes} lignes exportées`);
      assert.ok(appels <= 8, `${appels} lectures de listes pour ${lignes} lignes (lecture par ligne proscrite)`);
    } finally { srv.ctx.liste = original; }
  });

  test('suppression : refusée tant que des factures ou commandes du module Achats sont imputées à l\'OT', async () => {
    assert.ok(srv.ctx.services.achats && typeof srv.ctx.services.achats.facturesPourOt === 'function', 'service Achats présent');
    const o = await resp.ok('POST', '/api/ot', { titre: 'OT avec facture', equipementId: presse.id });
    const fournisseur = srv.db.insert('fournisseurs', { nom: 'Prestataire test', typeCode: 'prestataire', actif: true });
    const facture = srv.db.insert('factures', { numero: 'FAC-T-0001', fournisseurId: fournisseur.id, secteurId: PROD, numeroFournisseur: 'PT-1', dateFacture: jourLocal(0), montantHT: 100, montantTVA: 20, montantTTC: 120, statut: 'recue', otId: o.id, lignes: [], createdBy: 1 });
    assert.equal((await resp.ok('GET', `/api/ot/${o.id}`)).actions.supprimer, false);
    const r = await resp.del(`/api/ot/${o.id}`);
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /1 facture/);
    assert.ok(srv.db.get('ot', o.id));
    assert.equal(srv.db.get('factures', facture.id).otId, o.id, 'imputation conservée');
    srv.db.update('factures', facture.id, { statut: 'annulee' });
    assert.equal((await resp.ok('GET', `/api/ot/${o.id}`)).actions.supprimer, true);
    await resp.ok('DELETE', `/api/ot/${o.id}`);
  });

  test('duplication : un champ personnalisé rendu obligatoire après la création ne bloque pas la copie', async () => {
    const source = await resp.ok('POST', '/api/ot', { titre: 'Source avant champ obligatoire', equipementId: presse.id });
    const cfg = srv.db.getConfig();
    const sauvegarde = JSON.parse(JSON.stringify(cfg.champsPersonnalises));
    cfg.champsPersonnalises = Object.assign({}, cfg.champsPersonnalises, { ot: [{ cle: 'bon', label: 'N° de bon de travail', type: 'texte', obligatoire: true }] });
    srv.db.setConfig(cfg);
    try {
      assert.equal((await resp.post('/api/ot', { titre: 'Création sans le champ', equipementId: presse.id })).status, 400, 'la création reste stricte');
      const copie = await resp.ok('POST', `/api/ot/${source.id}/dupliquer`, { titre: 'Copie après champ obligatoire' });
      assert.equal(copie.titre, 'Copie après champ obligatoire');
      assert.equal(copie.champs.bon, null);
      const m = await resp.ok('PUT', `/api/ot/${copie.id}`, { champs: { bon: 'BT-12' } });
      assert.equal(m.champs.bon, 'BT-12');
    } finally {
      const c2 = srv.db.getConfig(); c2.champsPersonnalises = sauvegarde; srv.db.setConfig(c2);
    }
  });

  test('lignes de temps, pièces, tâches, commentaires et documents : identifiant stable, suppression rejouée sans effet', async () => {
    installerStock();
    const o = await resp.ok('POST', '/api/ot', { titre: 'Lignes identifiées', equipementId: presse.id, technicienId: uTechProd.id, taches: ['Étape A', 'Étape B'] });
    assert.ok(o.taches.every((t) => typeof t.uid === 'string' && !/^\d+$/.test(t.uid)));
    let r = await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 1, commentaire: 'première' });
    r = await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 2, commentaire: 'deuxième' });
    r = await techProd.ok('POST', `/api/ot/${o.id}/temps`, { heures: 3, commentaire: 'troisième' });
    const [t1, t2] = r.tempsPasse;
    assert.ok(t1.uid && t2.uid && t1.uid !== t2.uid);
    const d1 = await techProd.del(`/api/ot/${o.id}/temps/${t2.uid}`);
    assert.equal(d1.status, 200);
    assert.deepEqual(d1.body.tempsPasse.map((t) => t.commentaire), ['première', 'troisième']);
    const rejouee = await techProd.del(`/api/ot/${o.id}/temps/${t2.uid}`);
    assert.equal(rejouee.status, 404, 'la requête rejouée ne supprime pas la ligne suivante');
    assert.deepEqual(srv.db.get('ot', o.id).tempsPasse.map((t) => t.commentaire), ['première', 'troisième']);
    // Pièces : deux suppressions de la même ligne → un seul retour en stock
    await techProd.ok('POST', `/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 1 });
    const avecPieces = await techProd.ok('POST', `/api/ot/${o.id}/pieces`, { articleId: articleJoint.id, quantite: 2 });
    const p1 = avecPieces.pieces[0];
    const nbRetours = appelsStock.annuler.length;
    const [s1, s2] = await Promise.all([techProd.del(`/api/ot/${o.id}/pieces/${p1.uid}`), techProd.del(`/api/ot/${o.id}/pieces/${p1.uid}`)]);
    assert.deepEqual([s1.status, s2.status].sort(), [200, 404]);
    assert.equal(appelsStock.annuler.length, nbRetours + 1, 'un seul retour en stock');
    assert.equal(srv.db.get('ot', o.id).pieces.length, 1);
    // Tâches et commentaires par identifiant ; l'index reste accepté
    const coche = await techProd.ok('PUT', `/api/ot/${o.id}/taches/${o.taches[1].uid}`, { fait: true });
    assert.equal(coche.taches[1].fait, true);
    const com = await techProd.ok('POST', `/api/ot/${o.id}/commentaires`, { texte: 'Commentaire identifié' });
    assert.ok(com.commentaires[0].uid);
    assert.equal((await techProd.ok('DELETE', `/api/ot/${o.id}/commentaires/${com.commentaires[0].uid}`)).commentaires.length, 0);
    assert.equal((await techProd.del(`/api/ot/${o.id}/taches/inconnu`)).status, 404);
    const doc = await techProd.ok('POST', `/api/ot/${o.id}/documents`, { nom: 'photo.txt', type: 'text/plain', contenu: 'data:text/plain;base64,' + Buffer.from('Photo').toString('base64') });
    assert.ok(doc.document.uid);
    assert.equal((await techProd.get(`/api/ot/${o.id}/documents/${doc.document.uid}`)).body, 'Photo');
    assert.equal((await techProd.get(`/api/ot/${o.id}/documents/0`)).body, 'Photo');
  });

  test('liste : lignes allégées (sans historique, temps, pièces, tâches, commentaires) ; fiche complète', async () => {
    const liste = await resp.ok('GET', '/api/ot');
    assert.ok(liste.length >= 10);
    for (const o of liste) {
      for (const k of ['historique', 'tempsPasse', 'pieces', 'taches', 'commentaires', 'documents', 'piecesPrevues']) assert.equal(o[k], undefined, `${k} absent des lignes de liste`);
      for (const k of ['nbTaches', 'nbTachesFaites', 'nbPieces', 'nbCommentaires', 'nbDocuments', 'tempsTotal', 'coutTotal']) assert.equal(typeof o[k], 'number', k);
      assert.ok(Array.isArray(o.techniciens));
    }
    const avecTemps = liste.find((o) => o.tempsTotal > 0);
    assert.ok(avecTemps, 'un OT avec du temps saisi');
    const fiche = await resp.ok('GET', `/api/ot/${avecTemps.id}`);
    assert.ok(Array.isArray(fiche.tempsPasse) && fiche.tempsPasse.length >= 1);
    assert.ok(Array.isArray(fiche.historique) && Array.isArray(fiche.taches) && Array.isArray(fiche.commentaires));
  });

  test('données de démonstration : réalistes et idempotentes', async () => {
    const autre = await demarrer();
    try {
      const { seedDemo } = require('../server/modules');
      seedDemo(autre.ctx);
      const n = autre.db.count('ot');
      assert.ok(n >= 15, `${n} OT de démonstration`);
      const ots = autre.db.list('ot');
      const statuts = new Set(ots.map((o) => o.statut));
      for (const s of ['nouveau', 'planifie', 'en_cours', 'en_attente', 'termine', 'annule']) assert.ok(statuts.has(s), 'statut ' + s);
      assert.ok(ots.filter((o) => o.statut === 'termine').every((o) => o.rapport && o.tempsPasse.length && o.dateFin && o.cloturePar));
      assert.ok(ots.some((o) => o.demandeId != null), 'OT liés à des demandes');
      assert.ok(ots.every((o) => /^OT-\d{4}-\d{4}$/.test(o.numero)));
      assert.equal(new Set(ots.map((o) => o.numero)).size, n, 'numéros uniques');
      const r = autre.ctx.modules.find((m) => m.fichier === 'ot.js').seedDemo(autre.ctx);
      assert.match(r, /déjà/);
      assert.equal(autre.db.count('ot'), n, 'idempotent');
      const c = autre.client(); await c.login('admin', 'admin');
      const comp = await c.ok('GET', '/api/ot-compteurs');
      assert.ok(comp.enRetard >= 1 && comp.ouverts >= 5);
      const liste = await c.ok('GET', '/api/ot');
      assert.equal(liste.length, n);
      const detail = await c.ok('GET', `/api/ot/${liste[0].id}`);
      assert.ok(detail.actions && detail.historique.length);
    } finally { await autre.stop(); }
  });
});
