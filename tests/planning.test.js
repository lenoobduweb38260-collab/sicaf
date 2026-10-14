'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

/**
 * Tests du module Planning : période et filtres (validation), contenu (OT datés, OT en cours sans
 * date, non planifiés, échéances préventives et projections, retards), charge par technicien,
 * droits (401/403), portée par secteur, replanification (date, technicien, planification
 * automatique, audit, notifications, événements), génération d'un OT préventif (délégation au
 * module Préventif et créations de repli), services publiés et données de démonstration.
 */
const pad = (n) => String(n).padStart(2, '0');
const jourLocal = (decalage = 0) => { const d = new Date(); d.setDate(d.getDate() + decalage); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const AUJ = jourLocal(0);
const DU = jourLocal(-10);
const AU = jourLocal(20);
const periode = (extra = '') => `/api/planning?du=${DU}&au=${AU}${extra}`;

describe('Planning', () => {
  let srv, admin, resp, chefProd, techProd, demandeur, sansOt;
  let uResp, uChefProd, uTechProd, uTechLog, uDemandeur, uSansOt;
  let PROD, LOG, presse, chariot, eqInactif;
  let otPresse, otChariot, otLibre, otNonPlanifie, otEnCours, otTermine, otAnnule, otAncien, otHeure, otMulti;
  let planPresse, planChariot, planAvecOt, planInactif, planRetard, planCompteur;
  const evenements = [];
  let seq = 0;

  const notifsDe = (uid) => srv.db.list('notifications', (n) => n.userId === uid);
  const auditDe = (entite, id) => srv.db.list('audit', (a) => a.entite === entite && a.entiteId === id);
  function insererOt(champs) {
    seq += 1;
    return srv.db.insert('ot', Object.assign({
      numero: `OT-TEST-${String(seq).padStart(3, '0')}`, titre: `Intervention de test ${seq}`, description: '', statut: 'nouveau', typeCode: 'correctif', prioriteCode: 'normale',
      equipementId: null, secteurId: null, technicienId: null, techniciens: [], datePrevue: null, dureeEstimee: null, dateDebut: null, dateFin: null,
      tempsPasse: [], pieces: [], taches: [], commentaires: [], documents: [], historique: [], champs: {}, createdBy: 1,
    }, champs));
  }
  function insererPlan(champs) {
    seq += 1;
    return srv.db.insert('plansPreventifs', Object.assign({
      numero: `PP-T${String(seq).padStart(3, '0')}`, nom: `Plan de test ${seq}`, description: '', typeCode: 'preventif', prioriteCode: 'normale',
      equipementId: null, secteurId: null, periodicite: { type: 'mois', valeur: 1 }, derniereExecution: null, prochaineEcheance: null,
      gamme: [{ ordre: 1, libelle: 'Contrôle visuel', duree: 0.5 }, { ordre: 2, libelle: 'Graissage', duree: 1 }], dureeEstimee: 1.5,
      technicienId: null, pieces: [], actif: true, genererJoursAvant: null, champs: {}, createdBy: 1,
    }, champs));
  }

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    for (const evt of ['ot:modifie', 'ot:statut', 'ot:cree', 'planning:replanifie', 'preventif:genere']) {
      srv.ctx.on(evt, (d) => evenements.push({ evt, id: d && d.ot ? d.ot.id : (d && d.id), data: d }));
    }
    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;

    uResp = await admin.ok('POST', '/api/utilisateurs', { login: 'resp', nom: 'Responsable', prenom: 'Rémi', profilId: p('Responsable maintenance'), password: 'resp1234', doitChangerMdp: false });
    uChefProd = await admin.ok('POST', '/api/utilisateurs', { login: 'chefprod', nom: 'Chef', prenom: 'Paul', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false });
    uTechProd = await admin.ok('POST', '/api/utilisateurs', { login: 'techprod', nom: 'Technicien', prenom: 'Théo', profilId: p('Technicien'), secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false });
    uTechLog = await admin.ok('POST', '/api/utilisateurs', { login: 'techlog', nom: 'Logisticien', prenom: 'Léa', profilId: p('Technicien'), secteurIds: [LOG], password: 'tech1234', doitChangerMdp: false });
    uDemandeur = await admin.ok('POST', '/api/utilisateurs', { login: 'operateur', nom: 'Opérateur', prenom: 'Omar', profilId: p('Demandeur'), secteurIds: [PROD], password: 'oper1234', doitChangerMdp: false });
    uSansOt = await admin.ok('POST', '/api/utilisateurs', { login: 'planif', nom: 'Planificateur', prenom: 'Pia', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'plan1234', doitChangerMdp: false, overrides: { ot: { voir: false, creer: false, modifier: false, affecter: false, cloturer: false, exporter: false } } });

    presse = srv.db.insert('equipements', { numero: 'EQ-P001', nom: 'Presse planning', typeCode: 'machine', secteurId: PROD, actif: true, documents: [], champs: {}, compteur: { valeur: 1000, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
    chariot = srv.db.insert('equipements', { numero: 'EQ-P002', nom: 'Chariot planning', typeCode: 'vehicule', secteurId: LOG, actif: true, documents: [], champs: {}, createdBy: 1 });
    eqInactif = srv.db.insert('equipements', { numero: 'EQ-P003', nom: 'Machine réformée planning', typeCode: 'machine', secteurId: PROD, actif: false, documents: [], champs: {}, createdBy: 1 });

    otPresse = insererOt({ titre: 'Remplacement du joint de vérin', equipementId: presse.id, secteurId: PROD, technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: jourLocal(2), dureeEstimee: 3, typeCode: 'correctif', prioriteCode: 'haute' });
    otChariot = insererOt({ titre: 'Contrôle des freins du chariot', equipementId: chariot.id, secteurId: LOG, technicienId: uTechLog.id, techniciens: [uTechLog.id], datePrevue: jourLocal(3), dureeEstimee: 2, statut: 'planifie' });
    otLibre = insererOt({ titre: 'Nettoyage de la zone atelier', datePrevue: jourLocal(5), dureeEstimee: 1, typeCode: 'amelioration' });
    otNonPlanifie = insererOt({ titre: 'Fuite d\'air sur la presse', equipementId: presse.id, secteurId: PROD, prioriteCode: 'urgente' });
    otEnCours = insererOt({ titre: 'Dépannage en cours sans date', equipementId: presse.id, secteurId: PROD, statut: 'en_cours', technicienId: uTechProd.id, techniciens: [uTechProd.id], dateDebut: new Date().toISOString(), dureeEstimee: 2 });
    otTermine = insererOt({ titre: 'Intervention terminée', equipementId: presse.id, secteurId: PROD, statut: 'termine', technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: jourLocal(-2), dureeEstimee: 4 });
    otAnnule = insererOt({ titre: 'Intervention annulée', equipementId: presse.id, secteurId: PROD, statut: 'annule', technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: jourLocal(-1), dureeEstimee: 6 });
    otAncien = insererOt({ titre: 'OT en retard ancien', equipementId: presse.id, secteurId: PROD, statut: 'planifie', technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: jourLocal(-30), dureeEstimee: 1 });
    const h = new Date(); h.setDate(h.getDate() + 4); h.setHours(14, 30, 0, 0);
    otHeure = insererOt({ titre: 'Intervention horodatée', equipementId: presse.id, secteurId: PROD, technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: h.toISOString(), dureeEstimee: 1.5, statut: 'planifie' });
    otMulti = insererOt({ titre: 'Intervention à deux', equipementId: presse.id, secteurId: PROD, technicienId: uTechProd.id, techniciens: [uTechProd.id, uResp.id], datePrevue: jourLocal(6), dureeEstimee: 2.5, statut: 'planifie' });

    planPresse = insererPlan({ nom: 'Graissage presse', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(7), technicienId: uTechProd.id, dureeEstimee: 1.5 });
    planChariot = insererPlan({ nom: 'Visite chariot', equipementId: chariot.id, secteurId: LOG, prochaineEcheance: jourLocal(8), technicienId: uTechLog.id, dureeEstimee: 2 });
    planAvecOt = insererPlan({ nom: 'Plan avec OT ouvert', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(1), periodicite: { type: 'semaines', valeur: 1 } });
    insererOt({ titre: 'OT du plan avec OT ouvert', equipementId: presse.id, secteurId: PROD, planPreventifId: planAvecOt.id, datePrevue: jourLocal(1), typeCode: 'preventif' });
    planInactif = insererPlan({ nom: 'Plan inactif', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(4), actif: false });
    planRetard = insererPlan({ nom: 'Plan en retard', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(-40), periodicite: { type: 'mois', valeur: 6 } });
    planCompteur = insererPlan({ nom: 'Vidange compteur', equipementId: presse.id, secteurId: PROD, periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 1500 });

    resp = srv.client(); await resp.login('resp', 'resp1234');
    chefProd = srv.client(); await chefProd.login('chefprod', 'chef1234');
    techProd = srv.client(); await techProd.login('techprod', 'tech1234');
    demandeur = srv.client(); await demandeur.login('operateur', 'oper1234');
    sansOt = srv.client(); await sansOt.login('planif', 'plan1234');
  });
  after(async () => { await srv.stop(); });

  // ----- Accès --------------------------------------------------------------------------------
  test('refuse l\'accès sans session', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get(periode())).status, 401);
    assert.equal((await anonyme.get('/api/planning-techniciens')).status, 401);
    assert.equal((await anonyme.put(`/api/planning/ot/${otPresse.id}`, { datePrevue: AUJ })).status, 401);
  });

  test('droits : 403 pour un profil sans accès au planning, lecture seule pour un technicien', async () => {
    assert.equal((await demandeur.get(periode())).status, 403);
    assert.equal((await demandeur.get('/api/planning-techniciens')).status, 403);
    assert.equal((await demandeur.put(`/api/planning/ot/${otPresse.id}`, { datePrevue: AUJ })).status, 403);
    assert.equal((await demandeur.post(`/api/planning/preventif/${planPresse.id}/generer`, {})).status, 403);
    // Technicien : planning.voir sans planning.modifier
    const r = await techProd.get(periode());
    assert.equal(r.status, 200);
    assert.equal(r.body.droits.modifier, false);
    assert.ok(r.body.ot.every((o) => o.deplacable === false), 'aucun OT déplaçable sans le droit');
    const put = await techProd.put(`/api/planning/ot/${otPresse.id}`, { datePrevue: jourLocal(3) });
    assert.equal(put.status, 403);
    assert.match(put.body.erreur, /Droit insuffisant/);
    assert.equal((await techProd.post(`/api/planning/preventif/${planPresse.id}/generer`, {})).status, 403);
    assert.equal(srv.db.get('ot', otPresse.id).datePrevue, jourLocal(2), 'aucune modification');
  });

  test('sans le droit ot.voir, le planning ne divulgue aucun OT', async () => {
    const r = await sansOt.ok('GET', periode());
    assert.equal(r.droits.voirOt, false);
    assert.equal(r.ot.length, 0);
    assert.equal(r.nonPlanifies.length, 0);
    assert.ok(r.echeances.length > 0, 'les échéances restent visibles (droit preventif.voir)');
    assert.equal((await sansOt.put(`/api/planning/ot/${otPresse.id}`, { datePrevue: AUJ })).status, 403);
  });

  // ----- Période et validation -------------------------------------------------------------------
  test('validation de la période et des filtres', async () => {
    const cas = [
      ['/api/planning?du=2026-13-01&au=2026-12-31', /date de début/], ['/api/planning?du=hier&au=2026-12-31', /date de début/],
      ['/api/planning?du=2026-10-01&au=2026-02-30', /date de fin/], ['/api/planning?du=2026-10-10&au=2026-10-01', /postérieure/],
      ['/api/planning?du=2025-01-01&au=2026-12-31', /trop longue/], [periode('&secteurId=99999'), /Secteur introuvable/],
      [periode('&secteurId=abc'), /identifiant invalide/], [periode('&technicienId=99999'), /Technicien introuvable/],
      [periode('&typeCode=inconnu'), /Type d'intervention inconnu/],
    ];
    for (const [url, motif] of cas) {
      const r = await resp.get(url);
      assert.equal(r.status, 400, `${url} : ${JSON.stringify(r.body)}`);
      assert.match(r.body.erreur, motif);
    }
  });

  test('période par défaut : le mois en cours', async () => {
    const r = await resp.ok('GET', '/api/planning');
    assert.equal(r.du, AUJ.slice(0, 8) + '01');
    assert.ok(r.au.startsWith(AUJ.slice(0, 7)));
    assert.ok(Number(r.au.slice(8)) >= 28);
    assert.equal(r.aujourdhui, AUJ);
    assert.equal(r.heuresParJour, 8);
  });

  // ----- Contenu --------------------------------------------------------------------------------------
  test('OT de la période enrichis (équipement, technicien, couleur du type, statut)', async () => {
    const r = await resp.ok('GET', periode());
    const ids = r.ot.map((o) => o.id);
    for (const o of [otPresse, otChariot, otLibre, otTermine, otAnnule, otHeure, otMulti]) assert.ok(ids.includes(o.id), `${o.titre} attendu`);
    assert.ok(!ids.includes(otAncien.id), 'OT hors période exclu');
    assert.ok(!ids.includes(otNonPlanifie.id), 'OT non planifié absent du calendrier');
    const p = r.ot.find((o) => o.id === otPresse.id);
    assert.equal(p.equipementNom, 'Presse planning');
    assert.equal(p.technicienNom, 'Théo Technicien');
    assert.equal(p.jour, jourLocal(2));
    const couleurCorrectif = srv.ctx.liste('typesIntervention').find((t) => t.code === 'correctif').couleur;
    assert.equal(p.couleur, couleurCorrectif);
    assert.equal(p.statutLibelle, 'Nouveau');
    assert.equal(p.deplacable, true);
    const termine = r.ot.find((o) => o.id === otTermine.id);
    assert.equal(termine.final, true);
    assert.equal(termine.deplacable, false);
    const horo = r.ot.find((o) => o.id === otHeure.id);
    assert.equal(horo.jour, jourLocal(4));
    assert.equal(horo.heure, '14:30');
    assert.deepEqual(r.legende.map((t) => t.code), srv.ctx.liste('typesIntervention').map((t) => t.code));
    // Tri chronologique
    const jours = r.ot.map((o) => o.jour);
    assert.deepEqual(jours, jours.slice().sort());
  });

  test('OT en cours sans date affiché aujourd\'hui et non planifiés', async () => {
    const r = await resp.ok('GET', periode());
    const enCours = r.ot.find((o) => o.id === otEnCours.id);
    assert.ok(enCours, 'OT en cours sans date dans la période');
    assert.equal(enCours.jour, AUJ);
    assert.equal(enCours.sansDate, true);
    const np = r.nonPlanifies.map((o) => o.id);
    assert.ok(np.includes(otNonPlanifie.id));
    assert.ok(np.includes(otEnCours.id), 'un OT en cours sans date reste « non planifié »');
    assert.ok(r.nonPlanifies.every((o) => !o.final && !o.datePrevue));
    assert.equal(r.nonPlanifies[0].id, otNonPlanifie.id, 'tri par priorité décroissante');
    // OT en retard antérieurs à la période
    assert.ok(r.enRetard.ot.some((o) => o.id === otAncien.id));
    // Période sans « aujourd'hui » : l'OT en cours sans date n'apparaît pas dans le calendrier
    const futur = await resp.ok('GET', `/api/planning?du=${jourLocal(40)}&au=${jourLocal(50)}`);
    assert.ok(!futur.ot.some((o) => o.id === otEnCours.id));
    assert.ok(futur.nonPlanifies.some((o) => o.id === otEnCours.id));
  });

  test('option finaux=0 : OT clôturés masqués', async () => {
    const r = await resp.ok('GET', periode('&finaux=0'));
    assert.ok(r.ot.every((o) => !o.final));
    assert.ok(!r.ot.some((o) => o.id === otTermine.id || o.id === otAnnule.id));
  });

  test('échéances préventives : actives, dans la période, sans OT ouvert', async () => {
    const r = await resp.ok('GET', periode());
    const plans = r.echeances.map((e) => e.planId);
    assert.ok(plans.includes(planPresse.id));
    assert.ok(plans.includes(planChariot.id));
    assert.ok(!plans.includes(planAvecOt.id), 'plan avec OT ouvert exclu');
    assert.ok(!plans.includes(planInactif.id), 'plan inactif exclu');
    assert.ok(!plans.includes(planRetard.id), 'échéance hors période exclue');
    const e = r.echeances.find((x) => x.planId === planPresse.id);
    assert.equal(e.date, jourLocal(7));
    assert.equal(e.equipementNom, 'Presse planning');
    assert.equal(e.technicienNom, 'Théo Technicien');
    assert.equal(e.couleur, srv.ctx.liste('typesIntervention').find((t) => t.code === 'preventif').couleur);
    assert.equal(e.projection, false);
    assert.equal(e.periodiciteLibelle, 'tous les mois');
    // Échéance dépassée antérieure à la période
    assert.ok(r.enRetard.echeances.some((x) => x.planId === planRetard.id && x.enRetard));
    assert.equal(r.totaux.nbEcheances, r.echeances.length);
  });

  test('projection des échéances suivantes (prévisionnel)', async () => {
    const r = await resp.ok('GET', periode('&projection=1'));
    const hebdo = r.echeances.filter((e) => e.planId === planAvecOt.id);
    assert.ok(hebdo.length >= 2, 'occurrences hebdomadaires projetées malgré l\'OT ouvert');
    assert.ok(hebdo.every((e) => e.projection && e.occurrence > 0));
    assert.equal(hebdo[0].date, jourLocal(8));
    assert.ok(r.echeances.every((e) => e.date >= DU && e.date <= AU));
    const sans = await resp.ok('GET', periode());
    assert.ok(sans.echeances.every((e) => !e.projection));
  });

  test('charge par technicien : Σ durées estimées (hors annulés), intervenants inclus', async () => {
    const r = await resp.ok('GET', periode());
    const theo = r.charge.find((c) => c.userId === uTechProd.id);
    // otPresse 3 + otEnCours 2 + otTermine 4 + otHeure 1.5 + otMulti 2.5 (otAnnule exclu)
    assert.equal(theo.heures, 13);
    assert.equal(theo.nbOt, 5);
    assert.equal(theo.parJour[jourLocal(2)], 3);
    assert.equal(theo.nbEcheances, 1);
    assert.equal(theo.heuresPreventif, 1.5);
    assert.equal(theo.capacite, 8 * r.joursOuvres);
    assert.equal(theo.taux, Math.round((13 / theo.capacite) * 100));
    const remi = r.charge.find((c) => c.userId === uResp.id);
    assert.equal(remi.heures, 2.5, 'un intervenant porte la durée de l\'OT');
    const libre = r.charge.find((c) => c.userId == null);
    assert.ok(libre && libre.nom === 'Non affecté' && libre.heures === 1);
    assert.equal(r.charge[r.charge.length - 1].userId, null, '« Non affecté » en dernier');
    assert.ok(r.charge.some((c) => c.userId === uChefProd.id && c.heures === 0), 'techniciens sans OT présents');
    // Jours ouvrés
    let n = 0; for (let i = -10; i <= 20; i++) { const d = new Date(); d.setDate(d.getDate() + i); if (d.getDay() !== 0 && d.getDay() !== 6) n++; }
    assert.equal(r.joursOuvres, n);
  });

  test('filtres : secteur, technicien, « aucun », type', async () => {
    const prod = await resp.ok('GET', periode(`&secteurId=${PROD}`));
    assert.ok(prod.ot.length && prod.ot.every((o) => o.secteurId === PROD));
    assert.ok(prod.echeances.every((e) => e.secteurId === PROD));
    const sansSecteur = await resp.ok('GET', periode('&secteurId=aucun'));
    assert.deepEqual(sansSecteur.ot.map((o) => o.id), [otLibre.id]);
    const theo = await resp.ok('GET', periode(`&technicienId=${uTechProd.id}`));
    assert.ok(theo.ot.every((o) => o.technicienId === uTechProd.id || o.techniciens.includes(uTechProd.id)));
    assert.deepEqual(theo.charge.map((c) => c.userId), [uTechProd.id]);
    assert.ok(theo.echeances.every((e) => e.technicienId === uTechProd.id));
    const remi = await resp.ok('GET', periode(`&technicienId=${uResp.id}`));
    assert.deepEqual(remi.ot.map((o) => o.id), [otMulti.id], 'filtre sur les intervenants');
    const aucun = await resp.ok('GET', periode('&technicienId=aucun'));
    assert.ok(aucun.ot.every((o) => o.technicienId == null && !o.techniciens.length));
    assert.ok(aucun.ot.some((o) => o.id === otLibre.id));
    const amelio = await resp.ok('GET', periode('&typeCode=amelioration'));
    assert.deepEqual(amelio.ot.map((o) => o.id), [otLibre.id]);
  });

  // ----- Portée -----------------------------------------------------------------------------------------
  test('portée par secteur : OT, échéances et techniciens', async () => {
    const r = await chefProd.ok('GET', periode());
    const ids = r.ot.map((o) => o.id);
    assert.ok(ids.includes(otPresse.id));
    assert.ok(ids.includes(otLibre.id), 'OT sans secteur visible');
    assert.ok(!ids.includes(otChariot.id), 'OT d\'un autre secteur invisible');
    assert.ok(!r.echeances.some((e) => e.planId === planChariot.id), 'échéance d\'un autre secteur invisible');
    assert.ok(r.echeances.some((e) => e.planId === planPresse.id));
    assert.ok(!r.charge.some((c) => c.userId === uTechLog.id));
    // L'intervenant voit aussi les OT où il est affecté hors de ses secteurs
    srv.db.update('ot', otChariot.id, { techniciens: [uTechLog.id, uTechProd.id] });
    const t = await techProd.ok('GET', periode());
    assert.ok(t.ot.some((o) => o.id === otChariot.id));
    srv.db.update('ot', otChariot.id, { techniciens: [uTechLog.id] });

    const techs = await chefProd.ok('GET', '/api/planning-techniciens');
    const tids = techs.map((x) => x.id);
    assert.ok(tids.includes(uTechProd.id));
    assert.ok(tids.includes(uChefProd.id));
    assert.ok(tids.includes(1), 'utilisateur sans secteur (administrateur) visible');
    assert.ok(!tids.includes(uTechLog.id), 'technicien d\'un autre secteur exclu');
    assert.ok(!tids.includes(uDemandeur.id), 'utilisateur sans droit ot.voir exclu');
    assert.ok(!tids.includes(uSansOt.id), 'droit ot.voir retiré par surcharge');
    const tous = await resp.ok('GET', '/api/planning-techniciens');
    assert.ok(tous.some((x) => x.id === uTechLog.id));
    const th = tous.find((x) => x.id === uTechProd.id);
    assert.equal(th.nomComplet, 'Théo Technicien');
    assert.equal(th.peutModifierPlanning, false);
  });

  // ----- Replanification ------------------------------------------------------------------------------
  test('PUT : validation des entrées', async () => {
    const url = `/api/planning/ot/${otPresse.id}`;
    const cas = [
      [{}, /date prévue et\/ou le technicien/], [{ datePrevue: '2026-02-30' }, /date prévue est invalide/], [{ datePrevue: 'demain' }, /date prévue est invalide/],
      [{ datePrevue: 20261015 }, /date prévue est invalide/], [{ datePrevue: '1980-01-01' }, /invalide/], [{ technicienId: 'abc' }, /identifiant invalide/],
      [{ technicienId: 99999 }, /Technicien introuvable/], [{ technicienId: uDemandeur.id }, /n'a pas accès au module Ordres de travail/],
      [{ datePrevue: AUJ, planifier: 'oui' }, /planifier/],
    ];
    for (const [corps, motif] of cas) {
      const r = await resp.put(url, corps);
      assert.equal(r.status, 400, `${JSON.stringify(corps)} : ${JSON.stringify(r.body)}`);
      assert.match(r.body.erreur, motif);
    }
    assert.equal((await resp.put('/api/planning/ot/99999', { datePrevue: AUJ })).status, 404);
    assert.equal(srv.db.get('ot', otPresse.id).datePrevue, jourLocal(2));
  });

  test('PUT : déplacement d\'un OT (audit, historique, planification automatique, notification, événements)', async () => {
    const avantNotifs = notifsDe(uTechProd.id).length;
    const avantEvts = evenements.length;
    const r = await resp.ok('PUT', `/api/planning/ot/${otPresse.id}`, { datePrevue: jourLocal(9) });
    assert.equal(r.id, otPresse.id);
    assert.equal(r.jour, jourLocal(9));
    const o = srv.db.get('ot', otPresse.id);
    assert.equal(o.datePrevue, jourLocal(9));
    assert.equal(o.statut, 'planifie', 'nouveau → planifié');
    assert.equal(o.technicienId, uTechProd.id);
    const h = o.historique.slice(-2);
    assert.equal(h[0].libelle, 'Replanification depuis le planning');
    assert.match(h[0].commentaire, /date prévue/);
    assert.equal(h[1].action, 'statut');
    assert.equal(h[1].ancien, 'nouveau');
    const audits = auditDe('ot', otPresse.id);
    assert.ok(audits.some((a) => a.action === 'modification' && /replanifié depuis le planning/.test(a.details)));
    assert.ok(audits.some((a) => a.action === 'statut'));
    const notifs = notifsDe(uTechProd.id).slice(avantNotifs);
    assert.equal(notifs.length, 1);
    assert.match(notifs[0].titre, /replanifié/);
    assert.equal(notifs[0].lien, `#/ot/${otPresse.id}`);
    const evts = evenements.slice(avantEvts).map((e) => e.evt);
    assert.deepEqual(evts.sort(), ['ot:modifie', 'ot:statut', 'planning:replanifie'].sort());
    const rep = evenements.slice(avantEvts).find((e) => e.evt === 'planning:replanifie').data;
    assert.equal(rep.ancien.datePrevue, jourLocal(2));
    assert.equal(rep.nouveau.datePrevue, jourLocal(9));
    // Même date : aucune modification ni audit supplémentaire
    const nbAudit = auditDe('ot', otPresse.id).length;
    await resp.ok('PUT', `/api/planning/ot/${otPresse.id}`, { datePrevue: jourLocal(9) });
    assert.equal(auditDe('ot', otPresse.id).length, nbAudit);
  });

  test('PUT : l\'heure d\'une date prévue horodatée est conservée', async () => {
    await resp.ok('PUT', `/api/planning/ot/${otHeure.id}`, { datePrevue: jourLocal(10) });
    const o = srv.db.get('ot', otHeure.id);
    const d = new Date(o.datePrevue);
    assert.equal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, jourLocal(10));
    assert.equal(`${pad(d.getHours())}:${pad(d.getMinutes())}`, '14:30');
    // Date horodatée explicite
    const iso = new Date(new Date(o.datePrevue).getTime() + 3600000).toISOString();
    await resp.ok('PUT', `/api/planning/ot/${otHeure.id}`, { datePrevue: iso });
    assert.equal(srv.db.get('ot', otHeure.id).datePrevue, iso);
    // conserverHeure: false → date seule
    await resp.ok('PUT', `/api/planning/ot/${otHeure.id}`, { datePrevue: jourLocal(11), conserverHeure: false });
    assert.equal(srv.db.get('ot', otHeure.id).datePrevue, jourLocal(11));
  });

  test('PUT : changement de technicien (vue par technicien)', async () => {
    srv.db.update('ot', otMulti.id, { techniciens: [uTechProd.id, uResp.id] });
    const avantNouveau = notifsDe(uChefProd.id).length;
    const avantAncien = notifsDe(uTechProd.id).length;
    const r = await admin.ok('PUT', `/api/planning/ot/${otMulti.id}`, { datePrevue: jourLocal(12), technicienId: uChefProd.id });
    assert.equal(r.technicienId, uChefProd.id);
    const o = srv.db.get('ot', otMulti.id);
    assert.equal(o.technicienId, uChefProd.id);
    assert.deepEqual(o.techniciens, [uChefProd.id, uResp.id], 'ancien responsable remplacé, intervenants conservés');
    assert.equal(o.datePrevue, jourLocal(12));
    assert.ok(auditDe('ot', otMulti.id).some((a) => a.action === 'affectation' && /responsable/.test(a.details)));
    const nouv = notifsDe(uChefProd.id).slice(avantNouveau);
    assert.equal(nouv.length, 1);
    assert.match(nouv[0].titre, /Affectation/);
    const anc = notifsDe(uTechProd.id).slice(avantAncien);
    assert.equal(anc.length, 1);
    assert.match(anc[0].titre, /réaffecté/);
    const remi = notifsDe(uResp.id).filter((n) => /replanifié/.test(n.titre) && n.lien === `#/ot/${otMulti.id}`);
    assert.equal(remi.length, 1, 'les autres intervenants sont prévenus de la nouvelle date');
    // Retrait du responsable (ligne « Non affecté »)
    await admin.ok('PUT', `/api/planning/ot/${otMulti.id}`, { technicienId: null });
    const o2 = srv.db.get('ot', otMulti.id);
    assert.equal(o2.technicienId, null);
    assert.deepEqual(o2.techniciens, [uResp.id]);
  });

  test('PUT : retrait du planning (non planifié) et option planifier=false', async () => {
    let o = srv.db.get('ot', otPresse.id);
    assert.equal(o.statut, 'planifie');
    await resp.ok('PUT', `/api/planning/ot/${otPresse.id}`, { datePrevue: null });
    o = srv.db.get('ot', otPresse.id);
    assert.equal(o.datePrevue, null);
    assert.equal(o.statut, 'nouveau', 'planifié → nouveau quand la date est retirée');
    const r = await resp.ok('GET', periode());
    assert.ok(r.nonPlanifies.some((x) => x.id === otPresse.id));
    await resp.ok('PUT', `/api/planning/ot/${otPresse.id}`, { datePrevue: jourLocal(2), planifier: false });
    o = srv.db.get('ot', otPresse.id);
    assert.equal(o.statut, 'nouveau', 'statut inchangé avec planifier=false');
    assert.equal(o.datePrevue, jourLocal(2));
  });

  test('PUT : OT clôturé non replanifiable', async () => {
    for (const o of [otTermine, otAnnule]) {
      const r = await resp.put(`/api/planning/ot/${o.id}`, { datePrevue: AUJ });
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /clôturé/);
    }
  });

  test('PUT : portée (OT hors périmètre, technicien hors secteur)', async () => {
    const r = await chefProd.put(`/api/planning/ot/${otChariot.id}`, { datePrevue: AUJ });
    assert.equal(r.status, 404, 'OT d\'un autre secteur introuvable');
    const t = await chefProd.put(`/api/planning/ot/${otPresse.id}`, { technicienId: uTechLog.id });
    assert.equal(t.status, 400);
    assert.match(t.body.erreur, /hors de votre périmètre/);
    const ok = await chefProd.ok('PUT', `/api/planning/ot/${otPresse.id}`, { datePrevue: jourLocal(3), technicienId: uTechProd.id });
    assert.equal(ok.jour, jourLocal(3));
  });

  // ----- Génération d'un OT préventif --------------------------------------------------------------------
  test('génération : validation, droits et portée', async () => {
    assert.equal((await resp.post('/api/planning/preventif/99999/generer', {})).status, 404);
    assert.equal((await chefProd.post(`/api/planning/preventif/${planChariot.id}/generer`, {})).status, 404, 'plan hors périmètre');
    const inactif = await resp.post(`/api/planning/preventif/${planInactif.id}/generer`, {});
    assert.equal(inactif.status, 400);
    assert.match(inactif.body.erreur, /inactif/);
    const ouvert = await resp.post(`/api/planning/preventif/${planAvecOt.id}/generer`, {});
    assert.equal(ouvert.status, 400);
    assert.match(ouvert.body.erreur, /déjà ouvert/);
    const date = await resp.post(`/api/planning/preventif/${planPresse.id}/generer`, { datePrevue: '2026-02-31' });
    assert.equal(date.status, 400);
    assert.match(date.body.erreur, /date prévue est invalide/);
    const planEqInactif = insererPlan({ nom: 'Plan sur équipement inactif', equipementId: eqInactif.id, secteurId: PROD, prochaineEcheance: jourLocal(3) });
    const eq = await resp.post(`/api/planning/preventif/${planEqInactif.id}/generer`, {});
    assert.equal(eq.status, 400);
    assert.match(eq.body.erreur, /inactif/);
    assert.equal((await sansOt.post(`/api/planning/preventif/${planPresse.id}/generer`, {})).status, 403, 'droit ot.creer requis');
  });

  test('génération déléguée au module Préventif (date de l\'échéance, idempotence)', async () => {
    assert.ok(srv.ctx.services.preventif, 'module Préventif présent');
    const avantEvts = evenements.length;
    const r = await chefProd.ok('POST', `/api/planning/preventif/${planPresse.id}/generer`, {});
    assert.equal(r.planId, planPresse.id);
    const ot = srv.db.get('ot', r.ot.id);
    assert.equal(ot.planPreventifId, planPresse.id);
    assert.equal(ot.datePrevue, jourLocal(7), 'date prévue = échéance du plan');
    assert.equal(ot.taches.length, 2, 'gamme copiée');
    assert.ok(evenements.slice(avantEvts).some((e) => e.evt === 'preventif:genere'));
    assert.ok(auditDe('plansPreventifs', planPresse.id).some((a) => a.action === 'generation'));
    const apres = await resp.ok('GET', periode());
    assert.ok(!apres.echeances.some((e) => e.planId === planPresse.id), 'échéance remplacée par l\'OT');
    assert.ok(apres.ot.some((o) => o.id === ot.id));
    const deux = await resp.post(`/api/planning/preventif/${planPresse.id}/generer`, {});
    assert.equal(deux.status, 400);
    assert.match(deux.body.erreur, /déjà ouvert/);
    // Échéance dépassée : l'OT est prévu aujourd'hui
    const r2 = await resp.ok('POST', `/api/planning/preventif/${planRetard.id}/generer`, {});
    assert.equal(srv.db.get('ot', r2.ot.id).datePrevue, AUJ);
  });

  test('génération de repli sans module Préventif (via le module OT, puis en direct)', async () => {
    const sPrev = srv.ctx.services.preventif;
    const sOt = srv.ctx.services.ot;
    try {
      delete srv.ctx.services.preventif;
      const p1 = insererPlan({ nom: 'Plan repli OT', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(5), technicienId: uTechProd.id });
      const avant = evenements.length;
      const r = await resp.ok('POST', `/api/planning/preventif/${p1.id}/generer`, { datePrevue: jourLocal(6) });
      const o = srv.db.get('ot', r.ot.id);
      assert.equal(o.planPreventifId, p1.id);
      assert.equal(o.datePrevue, jourLocal(6));
      assert.equal(o.echeancePreventif, jourLocal(5));
      assert.equal(o.technicienId, uTechProd.id);
      assert.ok(evenements.slice(avant).some((e) => e.evt === 'preventif:genere' && e.data.plan.id === p1.id));
      assert.ok(auditDe('plansPreventifs', p1.id).some((a) => a.action === 'generation'));
      assert.equal(srv.db.get('plansPreventifs', p1.id).dernierOtGenereId, o.id);

      if (sOt) delete srv.ctx.services.ot;
      const p2 = insererPlan({ nom: 'Plan repli direct', equipementId: presse.id, secteurId: PROD, prochaineEcheance: jourLocal(4), technicienId: uTechProd.id, typeCode: 'reglementaire' });
      const avant2 = evenements.length;
      const avantNotifs = notifsDe(uTechProd.id).length;
      const r2 = await resp.ok('POST', `/api/planning/preventif/${p2.id}/generer`, {});
      const o2 = srv.db.get('ot', r2.ot.id);
      assert.equal(o2.planPreventifId, p2.id);
      assert.equal(o2.statut, srv.ctx.liste('statutsOT')[0].code);
      assert.equal(o2.typeCode, 'reglementaire');
      assert.equal(o2.datePrevue, jourLocal(4));
      assert.equal(o2.taches.length, 2);
      assert.ok(o2.numero && o2.numero.startsWith('OT-'));
      assert.ok(auditDe('ot', o2.id).some((a) => a.action === 'creation'));
      const evts = evenements.slice(avant2).map((e) => e.evt);
      assert.ok(evts.includes('ot:cree') && evts.includes('preventif:genere'));
      assert.equal(notifsDe(uTechProd.id).length, avantNotifs + 1, 'technicien du plan notifié');
    } finally {
      srv.ctx.services.preventif = sPrev;
      if (sOt) srv.ctx.services.ot = sOt;
    }
  });

  // ----- Services et démonstration ----------------------------------------------------------------------------
  test('services publiés : charge et techniciens', async () => {
    const s = srv.ctx.services.planning;
    assert.ok(s && typeof s.charge === 'function' && typeof s.techniciens === 'function' && typeof s.periode === 'function');
    const charge = s.charge({ du: DU, au: AU });
    assert.ok(Array.isArray(charge) && charge.some((c) => c.userId === uTechLog.id && c.heures === 2));
    const techs = s.techniciens();
    assert.ok(techs.some((t) => t.id === uTechLog.id) && !techs.some((t) => t.id === uDemandeur.id));
  });

  test('multi-site : site accessible en lecture seule (403) et filtre du site courant', async () => {
    const P = srv.ctx.perms;
    if (typeof P.appliquerSiteCourant !== 'function' || typeof P.normaliserSiteAcces !== 'function') return; // cœur sans gestion multi-site
    const site2 = srv.db.insert('secteurs', { nom: 'Site secondaire', code: 'S2', type: 'site', parentId: null, actif: true, ordre: 90, couleur: '#0f766e', description: '' });
    const atelier2 = srv.db.insert('secteurs', { nom: 'Atelier du site secondaire', code: 'AT2', type: 'atelier', parentId: site2.id, actif: true, ordre: 1, couleur: '#f59e0b', description: '' });
    const ot2 = insererOt({ titre: 'OT du site secondaire', secteurId: atelier2.id, datePrevue: jourLocal(4), dureeEstimee: 1 });
    const plan2 = insererPlan({ nom: 'Plan du site secondaire', secteurId: atelier2.id, prochaineEcheance: jourLocal(6) });
    const uTech2 = await admin.ok('POST', '/api/utilisateurs', { login: 'techsite2', nom: 'Deuxième', prenom: 'Denis', profilId: srv.db.get('users', uTechProd.id).profilId, secteurIds: [atelier2.id], password: 'tech1234', doitChangerMdp: false });
    try {
      srv.db.update('users', uChefProd.id, { siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
      const r = await chefProd.ok('GET', periode());
      const o = r.ot.find((x) => x.id === ot2.id);
      assert.ok(o, 'OT du site en lecture seule visible');
      assert.equal(o.deplacable, false);
      const e = r.echeances.find((x) => x.planId === plan2.id);
      assert.ok(e, 'échéance du site en lecture seule visible');
      assert.equal(e.generable, false);
      const put = await chefProd.put(`/api/planning/ot/${ot2.id}`, { datePrevue: jourLocal(5) });
      assert.equal(put.status, 403);
      assert.match(put.body.erreur, /lecture seule/);
      const gen = await chefProd.post(`/api/planning/preventif/${plan2.id}/generer`, {});
      assert.equal(gen.status, 403);
      assert.match(gen.body.erreur, /lecture seule/);
      assert.equal(srv.db.get('ot', ot2.id).datePrevue, jourLocal(4), 'aucune modification');
      // Filtre du site courant (sélecteur de l'en-tête) appliqué à la liste des techniciens
      const resp2 = srv.db.get('users', uResp.id);
      const p = P.effectivePermissions(srv.db, resp2, null, srv.db.getConfig());
      P.appliquerSiteCourant(srv.db, p, site2.id);
      const techs = srv.ctx.services.planning.techniciens({ user: resp2, perms: p });
      const ids = techs.map((t) => t.id);
      assert.ok(ids.includes(uTech2.id), 'technicien du site sélectionné');
      assert.ok(!ids.includes(uTechProd.id), 'technicien d\'un autre site exclu');
      assert.ok(ids.includes(1), 'utilisateur sans secteur conservé');
      assert.ok(ids.includes(uResp.id), 'l\'utilisateur lui-même est toujours proposé');
    } finally {
      srv.db.update('users', uChefProd.id, { siteAcces: [] });
      srv.db.remove('ot', ot2.id);
      srv.db.remove('plansPreventifs', plan2.id);
      srv.db.update('users', uTech2.id, { actif: false });
    }
  });

  test('données de démonstration : aucune donnée propre, planning alimenté par les OT et plans', async () => {
    const demo = await demarrer();
    try {
      const mod = demo.ctx.modules.find((m) => m.fichier === 'planning.js');
      assert.equal(typeof mod.seedDemo(demo.ctx), 'string');
      assert.equal(typeof mod.seedDemo(demo.ctx), 'string', 'idempotent');
      require('../server/modules').seedDemo(demo.ctx);
      const c = demo.client(); await c.login('admin', 'admin');
      const r = await c.ok('GET', `/api/planning?du=${jourLocal(-31)}&au=${jourLocal(31)}&projection=1`);
      assert.ok(r.ot.length > 0, 'des OT de démonstration sont planifiés');
      assert.ok(r.charge.some((x) => x.heures > 0));
    } finally { await demo.stop(); }
  });
});
