'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

/**
 * Tests du module Demandes d'intervention : CRUD, validation des entrées, droits (403),
 * portée par secteur / perso, circuit de validation (N+1, auto-OT), refus, conversion,
 * clôture par événement OT, commentaires, pièces jointes, export CSV, démo.
 */
describe('Demandes d\'intervention', () => {
  let srv, admin, chefProd, chefLog, demandeur, techMaint, resp;
  let PROD, LOG, MAINT, presse, chariot;
  let uDemandeur, uChefProd, uChefLog, uTech, uResp;
  const otCrees = [];
  const evenements = [];

  /** Service OT simulé (le module OT réel peut être absent ou en cours d'écriture). */
  function installerServiceOt() {
    srv.ctx.services.ot = {
      creerDepuisDemande(d, req) {
        const ot = srv.db.insert('ot', { numero: srv.db.nextNumber('ot', 'OT-{annee}-{num:4}'), titre: d.titre, description: d.description, statut: 'nouveau', typeCode: d.typeCode, prioriteCode: d.prioriteCode, equipementId: d.equipementId, secteurId: d.secteurId, demandeId: d.id, createdBy: req.user.id });
        otCrees.push(ot);
        srv.ctx.emit('ot:cree', { ot });
        return ot;
      },
    };
  }
  function config(patchWorkflow) {
    const cfg = srv.db.getConfig();
    cfg.workflow = Object.assign({}, cfg.workflow, patchWorkflow);
    srv.db.setConfig(cfg);
  }
  const notifsDe = (uid) => srv.db.list('notifications', (n) => n.userId === uid);

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    for (const evt of ['demande:soumise', 'demande:validee', 'demande:refusee', 'demande:convertie', 'demande:cloturee', 'demande:reouverte']) srv.ctx.on(evt, (d) => evenements.push({ evt, id: d.id, statut: d.statut }));

    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;
    MAINT = secteurs.find((s) => s.code === 'MAINT').id;

    uResp = await admin.ok('POST', '/api/utilisateurs', { login: 'resp', nom: 'Responsable', prenom: 'Rémi', profilId: p('Responsable maintenance'), password: 'resp1234', doitChangerMdp: false });
    uChefProd = await admin.ok('POST', '/api/utilisateurs', { login: 'chefprod', nom: 'Chef', prenom: 'Paul', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false, managerId: uResp.id });
    uChefLog = await admin.ok('POST', '/api/utilisateurs', { login: 'cheflog', nom: 'Chef', prenom: 'Laure', profilId: p('Chef de secteur'), secteurIds: [LOG], password: 'chef1234', doitChangerMdp: false, managerId: uResp.id });
    uDemandeur = await admin.ok('POST', '/api/utilisateurs', { login: 'operateur', nom: 'Opérateur', prenom: 'Omar', profilId: p('Demandeur'), secteurIds: [PROD], password: 'oper1234', doitChangerMdp: false, managerId: uChefProd.id });
    uTech = await admin.ok('POST', '/api/utilisateurs', { login: 'techmaint', nom: 'Technicien', prenom: 'Théo', profilId: p('Technicien'), secteurIds: [MAINT, PROD], password: 'tech1234', doitChangerMdp: false, managerId: uResp.id });

    // Équipements insérés directement (indépendance vis-à-vis du module Équipements)
    presse = srv.db.insert('equipements', { numero: 'EQ-T001', nom: 'Presse hydraulique test', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: PROD, actif: true, documents: [], champs: {}, createdBy: 1 });
    chariot = srv.db.insert('equipements', { numero: 'EQ-T002', nom: 'Chariot test', typeCode: 'vehicule', etatCode: 'en_service', criticiteCode: 'B', secteurId: LOG, actif: true, documents: [], champs: {}, createdBy: 1 });
    srv.db.insert('equipements', { numero: 'EQ-T003', nom: 'Machine réformée', typeCode: 'machine', etatCode: 'reforme', criticiteCode: 'C', secteurId: PROD, actif: false, documents: [], champs: {}, createdBy: 1 });

    chefProd = srv.client(); await chefProd.login('chefprod', 'chef1234');
    chefLog = srv.client(); await chefLog.login('cheflog', 'chef1234');
    demandeur = srv.client(); await demandeur.login('operateur', 'oper1234');
    techMaint = srv.client(); await techMaint.login('techmaint', 'tech1234');
    resp = srv.client(); await resp.login('resp', 'resp1234');
    installerServiceOt();
  });
  after(async () => { await srv.stop(); });

  test('refuse l\'accès sans session', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/demandes')).status, 401);
    assert.equal((await anonyme.post('/api/demandes', { titre: 'x' })).status, 401);
  });

  test('validation des entrées : titre, équipement, codes de listes, demandeur', async () => {
    assert.equal((await demandeur.post('/api/demandes', { titre: '' })).status, 400, 'titre obligatoire');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'ab' })).status, 400, 'titre trop court');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test équipement', equipementId: 99999 })).status, 400, 'équipement inexistant');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test équipement', equipementId: 'abc' })).status, 400, 'équipement invalide');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test priorité', prioriteCode: 'inexistante' })).status, 400, 'priorité inconnue');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test type', typeCode: 'inexistant' })).status, 400, 'type inconnu');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test secteur', secteurId: 99999 })).status, 400, 'secteur inconnu');
    const reforme = srv.db.findOne('equipements', (e) => e.numero === 'EQ-T003');
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Test réformé', equipementId: reforme.id })).status, 400, 'équipement inactif refusé');
    const r = await demandeur.post('/api/demandes', { titre: 'Pour un autre', demandeurId: uChefProd.id });
    assert.equal(r.status, 200, 'le demandeur (droit modifier) peut désigner un autre demandeur');
    assert.equal(r.body.demandeurId, uChefProd.id);
    await admin.ok('DELETE', '/api/demandes/' + r.body.id);
    const t = await techMaint.post('/api/demandes', { titre: 'Pour un autre (technicien)', demandeurId: uChefProd.id });
    assert.equal(t.status, 403, 'sans le droit modifier, impossible de créer au nom d\'un autre');
  });

  let di1;
  test('création par un demandeur : numéro, statut soumise, secteur de l\'équipement, notification des valideurs, événement', async () => {
    const avantChef = notifsDe(uChefProd.id).length;
    const avantLog = notifsDe(uChefLog.id).length;
    const r = await demandeur.post('/api/demandes', { titre: 'Fuite d\'huile sur la presse', description: 'Flaque sous le vérin', equipementId: presse.id, prioriteCode: 'haute', arretProduction: true, pieceJointes: [{ nom: 'photo.txt', type: 'text/plain', contenu: 'data:text/plain;base64,' + Buffer.from('bonjour').toString('base64') }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    di1 = r.body;
    assert.match(di1.numero, /^DI-\d{4}-\d{4}$/);
    assert.equal(di1.statut, 'soumise');
    assert.equal(di1.demandeurId, uDemandeur.id);
    assert.equal(di1.secteurId, PROD, 'secteur repris de l\'équipement');
    assert.equal(di1.equipementNom, 'Presse hydraulique test');
    assert.equal(di1.typeCode, 'correctif', 'type par défaut');
    assert.equal(di1.arretProduction, true);
    assert.equal(di1.pieceJointes.length, 1);
    assert.equal(di1.pieceJointes[0].contenu, undefined, 'le contenu n\'est pas renvoyé dans la fiche');
    assert.equal(di1.historique.length, 1);
    assert.ok(di1.echeance, 'échéance calculée à partir du délai de la priorité');
    assert.ok(di1.valideurs.some((u) => u.id === uChefProd.id), 'le chef de secteur PROD est valideur');
    assert.ok(!di1.valideurs.some((u) => u.id === uChefLog.id), 'le chef de secteur LOG n\'est pas valideur');
    assert.ok(di1.valideurs.some((u) => u.id === uResp.id), 'le responsable (portée tous) est valideur');
    assert.equal(notifsDe(uChefProd.id).length, avantChef + 1, 'valideur notifié');
    assert.equal(notifsDe(uChefLog.id).length, avantLog, 'chef hors portée non notifié');
    assert.ok(evenements.some((e) => e.evt === 'demande:soumise' && e.id === di1.id));
    const audit = srv.db.list('audit', (a) => a.entite === 'demandes' && a.entiteId === di1.id && a.action === 'creation');
    assert.equal(audit.length, 1);
  });

  test('portée : secteurs (chef LOG ne voit pas PROD) et perso (le demandeur ne voit que les siennes)', async () => {
    assert.equal((await chefLog.get('/api/demandes/' + di1.id)).status, 404);
    assert.ok(!(await chefLog.ok('GET', '/api/demandes')).some((d) => d.id === di1.id));
    assert.ok((await chefProd.ok('GET', '/api/demandes')).some((d) => d.id === di1.id));
    const autre = await chefLog.ok('POST', '/api/demandes', { titre: 'Chariot : pneu à plat', equipementId: chariot.id });
    assert.equal((await demandeur.get('/api/demandes/' + autre.id)).status, 404, 'portée perso');
    assert.ok(!(await demandeur.ok('GET', '/api/demandes')).some((d) => d.id === autre.id));
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Hors secteur', equipementId: chariot.id })).status, 400, 'équipement hors portée du demandeur');
    assert.equal((await chefLog.post('/api/demandes', { titre: 'Hors secteur', secteurId: PROD })).status, 403, 'secteur hors portée du chef LOG');
    await admin.ok('DELETE', '/api/demandes/' + autre.id);
  });

  test('droits : 403 pour un profil sans droit (valider, supprimer, exporter)', async () => {
    assert.equal((await techMaint.post('/api/demandes/' + di1.id + '/valider')).status, 403, 'technicien : pas de droit valider');
    assert.equal((await demandeur.post('/api/demandes/' + di1.id + '/valider')).status, 403, 'demandeur : pas de droit valider');
    assert.equal((await demandeur.post('/api/demandes/' + di1.id + '/refuser', { motif: 'x' })).status, 403);
    assert.equal((await demandeur.del('/api/demandes/' + di1.id)).status, 403, 'demandeur : pas de droit supprimer');
    assert.equal((await techMaint.get('/api/demandes-export')).status, 403, 'technicien : pas de droit exporter');
    assert.equal((await demandeur.post('/api/demandes/' + di1.id + '/convertir')).status, 403, 'demandeur : pas de droit ot.creer');
  });

  test('modification : par le demandeur tant que soumise ; un technicien ne modifie que les siennes', async () => {
    const r = await demandeur.put('/api/demandes/' + di1.id, { titre: 'Fuite d\'huile sur la presse 250 t', prioriteCode: 'urgente' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.titre, 'Fuite d\'huile sur la presse 250 t');
    assert.equal(r.body.prioriteCode, 'urgente');
    assert.ok(r.body.historique.some((h) => h.action === 'modification'));
    const mienne = await techMaint.ok('POST', '/api/demandes', { titre: 'Demande du technicien', secteurId: MAINT });
    assert.equal((await techMaint.put('/api/demandes/' + mienne.id, { titre: 'Demande du technicien (modifiée)' })).status, 200, 'le créateur modifie sa demande soumise');
    assert.equal((await techMaint.put('/api/demandes/' + di1.id, { titre: 'Pirate' })).status, 403, 'technicien sans droit modifier sur une demande d\'autrui');
    await admin.ok('DELETE', '/api/demandes/' + mienne.id);
  });

  test('listes et compteurs : aValider, mesDemandes, filtres, recherche', async () => {
    const aValider = await chefProd.ok('GET', '/api/demandes?aValider=1');
    assert.ok(aValider.some((d) => d.id === di1.id && d.peutValider === true));
    assert.ok(!(await demandeur.ok('GET', '/api/demandes?aValider=1')).length, 'un demandeur n\'a rien à valider');
    const mes = await demandeur.ok('GET', '/api/demandes?mesDemandes=1');
    assert.ok(mes.every((d) => d.demandeurId === uDemandeur.id));
    const c = await chefProd.ok('GET', '/api/demandes-compteurs');
    assert.ok(c.aValider >= 1);
    assert.equal(typeof c.mesOuvertes, 'number');
    assert.ok(c.parStatut.soumise >= 1);
    assert.ok((await admin.ok('GET', '/api/demandes?recherche=presse')).some((d) => d.id === di1.id));
    assert.ok(!(await admin.ok('GET', '/api/demandes?recherche=zzzz')).length);
    assert.ok((await admin.ok('GET', '/api/demandes?statut=soumise&prioriteCode=urgente&secteurId=' + PROD + '&equipementId=' + presse.id)).some((d) => d.id === di1.id));
    assert.ok(!(await admin.ok('GET', '/api/demandes?statut=cloturee')).some((d) => d.id === di1.id));
    const n = new Date(); const auj = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    assert.ok((await admin.ok('GET', `/api/demandes?du=${auj}&au=${auj}`)).some((d) => d.id === di1.id));
    assert.ok(!(await admin.ok('GET', '/api/demandes?au=2000-01-01')).length);
  });

  test('refus : motif obligatoire, statut refusée, notification du demandeur, puis réouverture', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Demande à refuser', equipementId: presse.id });
    assert.equal((await chefProd.post('/api/demandes/' + d.id + '/refuser', {})).status, 400, 'motif obligatoire');
    const avant = notifsDe(uDemandeur.id).length;
    const r = await chefProd.ok('POST', '/api/demandes/' + d.id + '/refuser', { motif: 'Doublon de la demande précédente' });
    assert.equal(r.statut, 'refusee');
    assert.equal(r.motifRefus, 'Doublon de la demande précédente');
    assert.equal(r.validateurId, uChefProd.id);
    assert.equal(r.final, true);
    assert.equal(notifsDe(uDemandeur.id).length, avant + 1);
    assert.ok(evenements.some((e) => e.evt === 'demande:refusee' && e.id === d.id));
    assert.equal((await demandeur.put('/api/demandes/' + d.id, { titre: 'Modif après refus' })).status, 400, 'une demande refusée ne se modifie plus');
    assert.equal((await chefProd.post('/api/demandes/' + d.id + '/valider')).status, 400, 'impossible de valider une demande refusée');
    assert.equal((await demandeur.post('/api/demandes/' + d.id + '/reouvrir')).status, 403, 'le demandeur ne réouvre pas lui-même sa demande refusée');
  });

  test('réouverture d\'une demande refusée → soumise', async () => {
    const d = (await admin.ok('GET', '/api/demandes?statut=refusee')).find((x) => x.titre === 'Demande à refuser');
    const r = await chefProd.ok('POST', '/api/demandes/' + d.id + '/reouvrir', { commentaire: 'Finalement différente' });
    assert.equal(r.statut, 'soumise');
    assert.equal(r.motifRefus, '');
    assert.equal(r.validateurId, null);
    assert.ok(evenements.some((e) => e.evt === 'demande:reouverte' && e.id === d.id));
    await admin.ok('DELETE', '/api/demandes/' + d.id);
  });

  test('validation avec OT automatique : statut convertie, otId, notification, événements', async () => {
    const avant = notifsDe(uDemandeur.id).length;
    const nbOt = otCrees.length;
    const r = await chefProd.ok('POST', '/api/demandes/' + di1.id + '/valider', { commentaire: 'OK pour intervention' });
    assert.equal(r.statut, 'convertie');
    assert.equal(otCrees.length, nbOt + 1, 'OT créé via ctx.services.ot.creerDepuisDemande');
    assert.equal(r.otId, otCrees[nbOt].id);
    assert.equal(r.ot.numero, otCrees[nbOt].numero);
    assert.equal(r.otCree.id, otCrees[nbOt].id);
    assert.equal(r.validateurId, uChefProd.id);
    assert.ok(r.dateValidation);
    assert.ok(r.historique.some((h) => h.action === 'validation') && r.historique.some((h) => h.action === 'conversion'));
    assert.equal(notifsDe(uDemandeur.id).length, avant + 1, 'demandeur notifié');
    assert.ok(evenements.some((e) => e.evt === 'demande:validee' && e.id === di1.id));
    assert.ok(evenements.some((e) => e.evt === 'demande:convertie' && e.id === di1.id));
    assert.equal((await chefProd.post('/api/demandes/' + di1.id + '/valider')).status, 400, 'déjà validée');
    assert.equal((await admin.del('/api/demandes/' + di1.id)).status, 400, 'suppression refusée : OT lié');
    assert.equal((await demandeur.put('/api/demandes/' + di1.id, { titre: 'Fuite d\'huile sur la presse 250 t (complément)' })).status, 200, 'le profil Demandeur possède le droit modifier : modification possible tant que la demande n\'est pas finale');
    assert.equal((await demandeur.put('/api/demandes/' + di1.id, { equipementId: null })).status, 400, 'mais l\'équipement ne change plus après validation');
    const tech = await techMaint.ok('POST', '/api/demandes', { titre: 'Demande technicien validée', equipementId: presse.id });
    await chefProd.ok('POST', '/api/demandes/' + tech.id + '/valider');
    assert.equal((await techMaint.put('/api/demandes/' + tech.id, { titre: 'Après validation' })).status, 403, 'sans droit modifier, le créateur ne modifie plus après validation');
  });

  test('validation sans OT automatique puis conversion manuelle ; 503 si le module OT est absent', async () => {
    config({ otAutoDepuisDemande: false });
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Courroie à remplacer', equipementId: presse.id });
    const v = await chefProd.ok('POST', '/api/demandes/' + d.id + '/valider');
    assert.equal(v.statut, 'validee');
    assert.equal(v.otId, null);
    assert.equal(v.actions.convertir, true, 'le chef (ot.creer) peut convertir');
    const sauvegarde = srv.ctx.services.ot;
    delete srv.ctx.services.ot;
    assert.equal((await chefProd.post('/api/demandes/' + d.id + '/convertir')).status, 503, 'module OT indisponible');
    srv.ctx.services.ot = sauvegarde;
    const c = await chefProd.ok('POST', '/api/demandes/' + d.id + '/convertir');
    assert.equal(c.statut, 'convertie');
    assert.ok(c.otId);
    assert.equal(c.historique.filter((h) => h.action === 'conversion').length, 1, 'une seule étape de conversion malgré l\'événement ot:cree');
    assert.equal((await chefProd.post('/api/demandes/' + d.id + '/convertir')).status, 400, 'déjà convertie');
    config({ otAutoDepuisDemande: true });
  });

  test('validerParSuperieurUniquement : seul le N+1 du demandeur (ou un administrateur) valide', async () => {
    config({ validerParSuperieurUniquement: true });
    const avantChef = notifsDe(uChefProd.id).length;
    const avantResp = notifsDe(uResp.id).length;
    const avantAdmin = notifsDe(1).length;
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Validation hiérarchique', equipementId: presse.id });
    assert.equal(notifsDe(uChefProd.id).length, avantChef + 1, 'le N+1 est notifié');
    assert.equal(notifsDe(uResp.id).length, avantResp, 'le responsable (non N+1) n\'est pas notifié');
    assert.equal(notifsDe(1).length, avantAdmin, 'l\'administrateur n\'est pas notifié lorsque le N+1 peut valider');
    assert.ok(d.valideurs.some((u) => u.id === uChefProd.id) && !d.valideurs.some((u) => u.id === uResp.id), 'seul le N+1 est valideur');
    assert.equal((await resp.post('/api/demandes/' + d.id + '/valider')).status, 403, 'responsable (portée tous) mais pas N+1');
    assert.ok(!(await resp.ok('GET', '/api/demandes?aValider=1')).some((x) => x.id === d.id));
    assert.ok((await chefProd.ok('GET', '/api/demandes?aValider=1')).some((x) => x.id === d.id));
    const d2 = await demandeur.ok('POST', '/api/demandes', { titre: 'Validation hiérarchique (admin)', equipementId: presse.id });
    assert.equal((await admin.post('/api/demandes/' + d2.id + '/valider')).status, 200, 'administrateur');
    const v = await chefProd.ok('POST', '/api/demandes/' + d.id + '/valider');
    assert.equal(v.statut, 'convertie');
    config({ validerParSuperieurUniquement: false });
  });

  test('workflow sans validation : la demande est validée et convertie dès sa création', async () => {
    config({ validationDemandes: false });
    const avantChef = notifsDe(uChefProd.id).length;
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Sans validation', equipementId: presse.id });
    assert.equal(d.statut, 'convertie');
    assert.ok(d.otId);
    assert.ok(d.otCree && d.otCree.id === d.otId);
    assert.equal(d.validateurId, null, 'validation automatique : aucun validateur nominatif');
    assert.ok(d.dateValidation);
    assert.ok(d.historique.some((h) => h.action === 'validation' && h.userId === null && h.userNom === 'Système'));
    assert.equal(notifsDe(uChefProd.id).length, avantChef, 'pas de notification de validation');
    config({ validationDemandes: true });
  });

  test('ot:termine → clôture automatique + notification ; ot:annule → retour à validée', async () => {
    const d = srv.db.get('demandes', di1.id);
    const ot = srv.db.get('ot', d.otId);
    const avant = notifsDe(uDemandeur.id).length;
    srv.ctx.emit('ot:termine', { ot: Object.assign({}, ot, { statut: 'termine', rapport: 'Joint remplacé' }), ancien: 'en_cours', nouveau: 'termine' });
    const apres = srv.db.get('demandes', di1.id);
    assert.equal(apres.statut, 'cloturee');
    assert.ok(apres.dateCloture);
    assert.equal(notifsDe(uDemandeur.id).length, avant + 1);
    assert.ok(evenements.some((e) => e.evt === 'demande:cloturee' && e.id === di1.id));
    // Option désactivée : pas de clôture
    config({ cloturerDemandeAvecOt: false });
    const d2 = await demandeur.ok('POST', '/api/demandes', { titre: 'Pas de clôture auto', equipementId: presse.id });
    const v2 = await chefProd.ok('POST', '/api/demandes/' + d2.id + '/valider');
    srv.ctx.emit('ot:termine', srv.db.get('ot', v2.otId));
    assert.equal(srv.db.get('demandes', d2.id).statut, 'convertie');
    config({ cloturerDemandeAvecOt: true });
    // Annulation de l'OT
    srv.ctx.emit('ot:annule', { ot: srv.db.get('ot', v2.otId) });
    const d2b = srv.db.get('demandes', d2.id);
    assert.equal(d2b.statut, 'validee');
    assert.equal(d2b.otId, null);
    // Réouverture d'une demande clôturée liée à un OT → convertie
    const r = await chefProd.ok('POST', '/api/demandes/' + di1.id + '/reouvrir');
    assert.equal(r.statut, 'convertie');
    const c = await chefProd.ok('POST', '/api/demandes/' + di1.id + '/cloturer', { commentaire: 'Terminé' });
    assert.equal(c.statut, 'cloturee');
    assert.equal((await chefProd.post('/api/demandes/' + di1.id + '/cloturer')).status, 400, 'déjà clôturée');
  });

  test('clôture manuelle par le demandeur de sa propre demande ; refus pour un tiers sans droit', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Résolu tout seul', equipementId: presse.id });
    const autre = await techMaint.ok('POST', '/api/demandes', { titre: 'Demande du technicien', secteurId: PROD });
    assert.equal((await techMaint.post('/api/demandes/' + d.id + '/cloturer')).status, 403, 'technicien : ni demandeur, ni valider, ni modifier');
    const r = await demandeur.ok('POST', '/api/demandes/' + d.id + '/cloturer', { commentaire: 'Problème disparu après redémarrage' });
    assert.equal(r.statut, 'cloturee');
    assert.ok(r.historique.some((h) => h.action === 'cloture' && h.commentaire.includes('redémarrage')));
    await admin.ok('DELETE', '/api/demandes/' + autre.id);
  });

  test('commentaires : texte obligatoire, ajout, notification des participants', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Avec commentaires', equipementId: presse.id });
    assert.equal((await chefProd.post('/api/demandes/' + d.id + '/commentaires', { texte: '   ' })).status, 400);
    const avant = notifsDe(uDemandeur.id).length;
    const r = await chefProd.ok('POST', '/api/demandes/' + d.id + '/commentaires', { texte: 'Pouvez-vous préciser la localisation ?' });
    assert.equal(r.commentaires.length, 1);
    assert.equal(r.commentaire.userNom, 'Paul Chef');
    assert.equal(notifsDe(uDemandeur.id).length, avant + 1, 'le demandeur est notifié');
    const r2 = await demandeur.ok('POST', '/api/demandes/' + d.id + '/commentaires', { texte: 'Côté opérateur, travée 2' });
    assert.equal(r2.commentaires.length, 2);
    assert.equal((await admin.ok('GET', '/api/demandes/' + d.id)).nbCommentaires, 2);
    assert.equal((await chefLog.post('/api/demandes/' + d.id + '/commentaires', { texte: 'hors portée' })).status, 404);
  });

  test('pièces jointes : validation (base64, taille ≤ 5 Mo), téléchargement, suppression, droits', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Avec pièce jointe', equipementId: presse.id });
    assert.equal((await demandeur.post('/api/demandes/' + d.id + '/documents', { nom: 'x.txt', contenu: 'pas du base64' })).status, 400);
    assert.equal((await demandeur.post('/api/demandes/' + d.id + '/documents', { nom: '', contenu: 'data:text/plain;base64,YQ==' })).status, 400, 'nom obligatoire');
    const gros = 'data:application/octet-stream;base64,' + Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString('base64');
    assert.equal((await demandeur.post('/api/demandes/' + d.id + '/documents', { nom: 'gros.bin', contenu: gros })).status, 400, '> 5 Mo refusé');
    const texte = 'Compte rendu de constat';
    const r = await demandeur.ok('POST', '/api/demandes/' + d.id + '/documents', { nom: 'constat.txt', type: 'text/plain', contenu: 'data:text/plain;base64,' + Buffer.from(texte).toString('base64'), description: 'Constat' });
    assert.equal(r.pieceJointes.length, 1);
    assert.equal(r.document.taille, Buffer.byteLength(texte));
    const dl = await fetch(srv.base + '/api/demandes/' + d.id + '/documents/0');
    assert.equal(dl.status, 401, 'téléchargement protégé par session');
    const dl2 = await demandeur.get('/api/demandes/' + d.id + '/documents/0');
    assert.equal(dl2.status, 200);
    assert.equal(dl2.body, texte);
    assert.equal((await demandeur.get('/api/demandes/' + d.id + '/documents/5')).status, 404);
    assert.equal((await techMaint.post('/api/demandes/' + d.id + '/documents', { nom: 'a.txt', contenu: 'data:text/plain;base64,YQ==' })).status, 403, 'un tiers sans droit modifier ne joint rien');
    const s = await demandeur.ok('DELETE', '/api/demandes/' + d.id + '/documents/0');
    assert.equal(s.pieceJointes.length, 0);
  });

  test('suppression : OK sans OT lié, 404 ensuite', async () => {
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'À supprimer', equipementId: presse.id });
    assert.equal((await admin.del('/api/demandes/' + d.id)).status, 200);
    assert.equal((await admin.get('/api/demandes/' + d.id)).status, 404);
    assert.ok(srv.db.list('audit', (a) => a.entite === 'demandes' && a.entiteId === d.id && a.action === 'suppression').length === 1);
  });

  test('champs personnalisés : obligatoire manquant → 400, puis enregistré', async () => {
    const cfg = srv.db.getConfig();
    cfg.champsPersonnalises.demandes = [{ cle: 'poste', label: 'Poste de travail', type: 'texte', obligatoire: true }, { cle: 'nb_pieces', label: 'Pièces rebutées', type: 'nombre' }];
    srv.db.setConfig(cfg);
    assert.equal((await demandeur.post('/api/demandes', { titre: 'Champs perso', equipementId: presse.id })).status, 400);
    const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Champs perso', equipementId: presse.id, champs: { poste: 'P4', nb_pieces: '12' } });
    assert.equal(d.champs.poste, 'P4');
    assert.equal(d.champs.nb_pieces, 12);
    const csv = await admin.get('/api/demandes-export?recherche=Champs%20perso');
    assert.ok(String(csv.body).includes('Poste de travail') && String(csv.body).includes('P4'));
    cfg.champsPersonnalises.demandes = [];
    srv.db.setConfig(cfg);
  });

  test('export CSV : en-tête, BOM, filtres, audit', async () => {
    const r = await admin.get('/api/demandes-export?statut=cloturee');
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').includes('text/csv'));
    const txt = String(r.body);
    assert.ok(txt.startsWith('Numéro;Titre;Statut'), txt.slice(0, 40));
    // BOM UTF-8 (fetch().text() le retire : on lit les octets bruts avec une session dédiée)
    const login = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'GMAO' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const brut = Buffer.from(await (await fetch(srv.base + '/api/demandes-export', { headers: { cookie } })).arrayBuffer());
    assert.deepEqual(Array.from(brut.subarray(0, 3)), [0xef, 0xbb, 0xbf], 'BOM UTF-8 présent pour Excel');
    assert.ok(txt.includes(di1.numero));
    assert.ok(!txt.includes('Sans validation'), 'filtre statut appliqué (la demande convertie est exclue)');
    const chef = await chefLog.get('/api/demandes-export');
    assert.equal(chef.status, 200);
    assert.ok(!String(chef.body).includes(di1.numero), 'export limité à la portée');
    assert.ok(srv.db.list('audit', (a) => a.entite === 'demandes' && a.action === 'export').length >= 1);
  });

  test('fiche détaillée : enrichissements et actions calculées', async () => {
    const d = await admin.ok('GET', '/api/demandes/' + di1.id);
    assert.equal(d.equipement.nom, 'Presse hydraulique test');
    assert.equal(d.demandeur.login, 'operateur');
    assert.equal(d.validateur.login, 'chefprod');
    assert.ok(d.ot && d.ot.numero);
    assert.equal(d.actions.reouvrir, true);
    assert.equal(d.actions.valider, false);
    assert.equal(d.actions.supprimer, false, 'liée à un OT');
    assert.ok(d.historique.every((h) => typeof h.userNom === 'string' && h.libelle));
    const liste = await admin.ok('GET', '/api/demandes');
    const row = liste.find((x) => x.id === di1.id);
    assert.equal(row.otNumero, d.ot.numero);
    assert.equal(row.historique, undefined, 'la liste est allégée');
    assert.equal(row.demandeurNom, 'Omar Opérateur');
  });

  test('services publiés', async () => {
    const s = srv.ctx.services.demandes;
    assert.ok(s && typeof s.get === 'function');
    const ouvertes = s.ouvertesPour({ equipementId: presse.id });
    assert.ok(ouvertes.every((d) => !['refusee', 'cloturee'].includes(d.statut) && d.equipementId === presse.id));
    const d = srv.db.get('demandes', di1.id);
    assert.equal(s.lieeA({ id: d.otId, demandeId: null }).id, di1.id);
    assert.equal(s.STATUTS.convertie, 'convertie');
  });

  test('création au nom d\'un autre : le demandeur désigné est notifié ; modification et suppression par un tiers aussi', async () => {
    const avant = notifsDe(uDemandeur.id).length;
    const d = await chefProd.ok('POST', '/api/demandes', { titre: 'Saisie pour l\'opérateur', equipementId: presse.id, demandeurId: uDemandeur.id });
    assert.equal(d.demandeurId, uDemandeur.id);
    assert.equal(d.createdBy, uChefProd.id);
    assert.ok(d.historique[0].commentaire.includes('Saisie par'));
    assert.equal(notifsDe(uDemandeur.id).length, avant + 1, 'notification « saisie en votre nom »');
    assert.ok((await demandeur.ok('GET', '/api/demandes?mesDemandes=1')).some((x) => x.id === d.id), 'visible dans « mes demandes » du demandeur désigné');
    await chefProd.ok('PUT', '/api/demandes/' + d.id, { prioriteCode: 'haute' });
    assert.equal(notifsDe(uDemandeur.id).length, avant + 2, 'notification de modification');
    await admin.ok('DELETE', '/api/demandes/' + d.id);
    assert.equal(notifsDe(uDemandeur.id).length, avant + 3, 'notification de suppression');
  });

  test('hiérarchie : le N+1 voit et valide la demande de son subordonné même hors de ses secteurs', async () => {
    const profils = await admin.ok('GET', '/api/profils');
    const u = await admin.ok('POST', '/api/utilisateurs', { login: 'operateur2', nom: 'Opérateur', prenom: 'Inès', profilId: profils.find((x) => x.nom === 'Demandeur').id, secteurIds: [PROD], password: 'oper1234', doitChangerMdp: false, managerId: uChefLog.id });
    const op2 = srv.client(); await op2.login('operateur2', 'oper1234');
    const avant = notifsDe(uChefLog.id).length;
    const d = await op2.ok('POST', '/api/demandes', { titre: 'Capteur de présence défaillant', equipementId: presse.id });
    assert.equal(d.secteurId, PROD);
    assert.ok(d.valideurs.some((x) => x.id === uChefLog.id), 'le N+1 (secteur LOG) figure parmi les valideurs');
    assert.equal(notifsDe(uChefLog.id).length, avant + 1, 'le N+1 est notifié');
    assert.equal((await chefLog.get('/api/demandes/' + d.id)).status, 200, 'le N+1 voit la demande de son subordonné');
    assert.ok((await chefLog.ok('GET', '/api/demandes?aValider=1')).some((x) => x.id === d.id));
    assert.equal((await chefLog.ok('GET', '/api/demandes-compteurs')).aValider >= 1, true);
    const v = await chefLog.ok('POST', '/api/demandes/' + d.id + '/valider');
    assert.equal(v.statut, 'convertie');
    assert.equal(v.validateurId, uChefLog.id);
    assert.equal((await chefLog.get('/api/demandes/' + di1.id)).status, 404, 'les autres demandes PROD restent hors portée');
  });

  test('statuts configurables : codes renommés résolus depuis la liste statutsDemande', async () => {
    const mod = require('../server/modules/demandes');
    const cfg = srv.db.getConfig();
    const origine = JSON.parse(JSON.stringify(cfg.listes.statutsDemande));
    const liste = [
      { code: 'nouvelle', label: 'Nouvelle', couleur: '#6b7280', ordre: 1, final: false },
      { code: 'acceptee', label: 'Acceptée', couleur: '#2563eb', ordre: 2, final: false },
      { code: 'rejetee', label: 'Rejetée', couleur: '#dc2626', ordre: 3, final: true },
      { code: 'en_traitement', label: 'En traitement', couleur: '#f59e0b', ordre: 4, final: false },
      { code: 'terminee', label: 'Terminée', couleur: '#16a34a', ordre: 5, final: true },
    ];
    assert.deepEqual(srv.ctx.services.demandes.resoudreStatuts(liste), { soumise: 'nouvelle', validee: 'acceptee', refusee: 'rejetee', convertie: 'en_traitement', cloturee: 'terminee' });
    assert.deepEqual(srv.ctx.services.demandes.resoudreStatuts([]), { soumise: 'soumise', validee: 'validee', refusee: 'refusee', convertie: 'convertie', cloturee: 'cloturee' }, 'liste absente : codes par défaut');
    // Libellés seuls modifiés : les codes par défaut restent utilisés
    assert.equal(srv.ctx.services.demandes.resoudreStatuts(origine.map((s) => Object.assign({}, s, { label: 'X ' + s.label }))).validee, 'validee');
    cfg.listes.statutsDemande = liste;
    srv.db.setConfig(cfg);
    try {
      const d = await demandeur.ok('POST', '/api/demandes', { titre: 'Circuit avec statuts renommés', equipementId: presse.id });
      assert.equal(d.statut, 'nouvelle', 'statut initial résolu dans la liste');
      assert.equal((await admin.ok('GET', '/api/demandes-compteurs')).statuts.convertie, 'en_traitement');
      assert.ok((await chefProd.ok('GET', '/api/demandes?aValider=1')).some((x) => x.id === d.id));
      const v = await chefProd.ok('POST', '/api/demandes/' + d.id + '/valider');
      assert.equal(v.statut, 'en_traitement', 'validation + OT automatique → étape « convertie » renommée');
      srv.ctx.emit('ot:termine', { ot: srv.db.get('ot', v.otId) });
      assert.equal(srv.db.get('demandes', d.id).statut, 'terminee', 'clôture automatique → étape « cloturee » renommée');
      const r = await demandeur.ok('POST', '/api/demandes', { titre: 'Refus avec statuts renommés', equipementId: presse.id });
      const refus = await chefProd.ok('POST', '/api/demandes/' + r.id + '/refuser', { motif: 'Hors périmètre' });
      assert.equal(refus.statut, 'rejetee');
      assert.equal(refus.final, true);
      const csv = await admin.get('/api/demandes-export?statut=rejetee');
      assert.ok(String(csv.body).includes('Rejetée'), 'libellé du statut dans l\'export');
      assert.equal(srv.ctx.services.demandes.STATUTS.soumise, 'nouvelle');
    } finally {
      const c2 = srv.db.getConfig();
      c2.listes.statutsDemande = origine;
      srv.db.setConfig(c2);
    }
    assert.equal(srv.ctx.services.demandes.STATUTS.soumise, 'soumise', 'retour aux codes par défaut');
    assert.ok(mod.seedDemo, 'module exporté');
  });

  test('seedDemo : 7 demandes réalistes, idempotent', async () => {
    const mod = require('../server/modules/demandes');
    const avant = srv.db.count('demandes');
    const r1 = mod.seedDemo(srv.ctx);
    assert.match(r1, /7 demandes/);
    assert.equal(srv.db.count('demandes'), avant + 7);
    const r2 = mod.seedDemo(srv.ctx);
    assert.match(r2, /déjà présentes/);
    assert.equal(srv.db.count('demandes'), avant + 7);
    const demo = srv.db.list('demandes', (d) => d.createdAt >= new Date(Date.now() - 60000).toISOString() && d.historique.length);
    const statuts = new Set(srv.db.list('demandes').map((d) => d.statut));
    for (const s of ['soumise', 'validee', 'refusee', 'convertie', 'cloturee']) assert.ok(statuts.has(s), 'statut présent : ' + s);
    assert.ok(srv.db.list('demandes', (d) => d.statut === 'refusee').every((d) => d.motifRefus));
    assert.ok(demo.every((d) => /^DI-\d{4}-\d{4}$/.test(d.numero)));
    const numeros = srv.db.list('demandes').map((d) => d.numero);
    assert.equal(new Set(numeros).size, numeros.length, 'numéros uniques');
    // Lien OT complété a posteriori (le module OT crée ses OT après le nôtre)
    const convertie = srv.db.findOne('demandes', (d) => d.statut === 'convertie' && d.otId == null);
    if (convertie) {
      const ot = srv.db.insert('ot', { numero: 'OT-DEMO-1', titre: convertie.titre, statut: 'en_cours', demandeId: convertie.id });
      assert.equal((await admin.ok('GET', '/api/demandes/' + convertie.id)).otId, ot.id, 'lien retrouvé par demandeId');
    }
    const liste = await admin.ok('GET', '/api/demandes');
    assert.ok(liste.length >= 7);
  });
});
