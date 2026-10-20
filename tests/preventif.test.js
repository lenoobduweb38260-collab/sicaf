'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');
const { periodiciteLibelle, ajouterPeriode } = require('../server/modules/preventif');

/**
 * Tests du module Maintenance préventive : validation, CRUD, calcul des échéances et des états,
 * droits (403), portée par secteur, génération des OT (module OT, service creerDepuisPlan, mode
 * autonome), idempotence, réalisation (écoute de 'ot:termine'), échéancier, export CSV, démo.
 */
const pad = (n) => String(n).padStart(2, '0');
const jourLocal = (decalage = 0) => { const d = new Date(); d.setDate(d.getDate() + decalage); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const AUJ = jourLocal(0);

describe('Maintenance préventive', () => {
  let srv, admin, resp, chefProd, chefPrev, techProd, demandeur;
  let uResp, uChefPrev, uTechProd, uTechLog, uDemandeur;
  let PROD, LOG, presse, chariot, convoyeur, reforme, articleGraisse, articleFiltre;
  const evenements = [];
  const gammeType = [{ libelle: 'Consigner la machine', duree: 0.25 }, { libelle: 'Graisser les paliers', duree: 0.5 }, { libelle: 'Essai de fonctionnement', duree: 0.25 }];

  const notifsDe = (uid) => srv.db.list('notifications', (n) => n.userId === uid);
  const auditDe = (action, id) => srv.db.list('audit', (a) => a.entite === 'plansPreventifs' && a.action === action && (id == null || a.entiteId === id));
  function config(patch) {
    const cfg = srv.db.getConfig();
    for (const [k, v] of Object.entries(patch)) cfg[k] = Object.assign({}, cfg[k], v);
    srv.db.setConfig(cfg);
  }
  /** Création d'un plan par le responsable maintenance (valeurs par défaut raisonnables). */
  const creerPlan = (champs) => resp.ok('POST', '/api/preventif', Object.assign({ nom: 'Plan de test', equipementId: presse.id, periodicite: { type: 'mois', valeur: 1 }, technicienId: uTechProd.id, gamme: gammeType }, champs));

  before(async () => {
    srv = await demarrer();
    config({ preventif: { genererAuto: false, horizonJours: 30 } });
    admin = srv.client(); await admin.login('admin', 'admin');
    for (const evt of ['preventif:genere', 'preventif:cree', 'preventif:modifie', 'preventif:supprime', 'preventif:realise', 'ot:cree']) {
      srv.ctx.on(evt, (d) => evenements.push({ evt, data: d }));
    }
    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;

    uResp = await admin.ok('POST', '/api/utilisateurs', { login: 'resp', nom: 'Responsable', prenom: 'Rémi', profilId: p('Responsable maintenance'), password: 'resp1234', doitChangerMdp: false });
    await admin.ok('POST', '/api/utilisateurs', { login: 'chefprod', nom: 'Chef', prenom: 'Paul', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false });
    uChefPrev = await admin.ok('POST', '/api/utilisateurs', { login: 'chefprev', nom: 'Planificateur', prenom: 'Pia', profilId: p('Chef de secteur'), secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false, overrides: { preventif: { creer: true, modifier: true, supprimer: true, exporter: true } } });
    uTechProd = await admin.ok('POST', '/api/utilisateurs', { login: 'techprod', nom: 'Technicien', prenom: 'Théo', profilId: p('Technicien'), secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false });
    uTechLog = await admin.ok('POST', '/api/utilisateurs', { login: 'techlog', nom: 'Logisticien', prenom: 'Léa', profilId: p('Technicien'), secteurIds: [LOG], password: 'tech1234', doitChangerMdp: false });
    uDemandeur = await admin.ok('POST', '/api/utilisateurs', { login: 'operateur', nom: 'Opérateur', prenom: 'Omar', profilId: p('Demandeur'), secteurIds: [PROD], password: 'oper1234', doitChangerMdp: false });

    // Références insérées directement (indépendance vis-à-vis des autres modules)
    const il = (j) => new Date(Date.now() - j * 86400000).toISOString();
    presse = srv.db.insert('equipements', { numero: 'EQ-P001', nom: 'Presse de test', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: PROD, actif: true, documents: [], champs: {}, compteur: { valeur: 1200, unite: 'heures' }, compteurReleves: [{ date: il(100), valeur: 200 }, { date: il(0), valeur: 1200 }], createdBy: 1 });
    convoyeur = srv.db.insert('equipements', { numero: 'EQ-P002', nom: 'Convoyeur de test', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', secteurId: PROD, actif: true, documents: [], champs: {}, compteur: { valeur: 50000, unite: 'cycles' }, compteurReleves: [], createdBy: 1 });
    chariot = srv.db.insert('equipements', { numero: 'EQ-P003', nom: 'Chariot de test', typeCode: 'vehicule', etatCode: 'en_service', criticiteCode: 'B', secteurId: LOG, actif: true, documents: [], champs: {}, compteur: { valeur: 50, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
    reforme = srv.db.insert('equipements', { numero: 'EQ-P004', nom: 'Machine réformée de test', typeCode: 'machine', etatCode: 'reforme', criticiteCode: 'C', secteurId: PROD, actif: false, documents: [], champs: {}, compteur: { valeur: 0, unite: 'heures' }, createdBy: 1 });
    articleGraisse = srv.db.insert('articles', { code: 'ART-P01', designation: 'Graisse EP2 cartouche', quantite: 20, seuilMin: 4, prixUnitaire: 6.4, uniteCode: 'u', actif: true, equipementIds: [presse.id] });
    articleFiltre = srv.db.insert('articles', { code: 'ART-P02', designation: 'Filtre à huile', quantite: 3, seuilMin: 1, prixUnitaire: 25, uniteCode: 'u', actif: true, equipementIds: [] });

    resp = srv.client(); await resp.login('resp', 'resp1234');
    chefProd = srv.client(); await chefProd.login('chefprod', 'chef1234');
    chefPrev = srv.client(); await chefPrev.login('chefprev', 'chef1234');
    techProd = srv.client(); await techProd.login('techprod', 'tech1234');
    demandeur = srv.client(); await demandeur.login('operateur', 'oper1234');
  });
  after(async () => { await srv.stop(); });

  test('périodicité lisible', () => {
    assert.equal(periodiciteLibelle({ type: 'mois', valeur: 3 }), 'tous les 3 mois');
    assert.equal(periodiciteLibelle({ type: 'mois', valeur: 1 }), 'tous les mois');
    assert.equal(periodiciteLibelle({ type: 'mois', valeur: 12 }), 'tous les ans');
    assert.equal(periodiciteLibelle({ type: 'mois', valeur: 24 }), 'tous les 2 ans');
    assert.equal(periodiciteLibelle({ type: 'semaines', valeur: 1 }), 'toutes les semaines');
    assert.equal(periodiciteLibelle({ type: 'semaines', valeur: 2 }), 'toutes les 2 semaines');
    assert.equal(periodiciteLibelle({ type: 'jours', valeur: 1 }), 'tous les jours');
    assert.equal(periodiciteLibelle({ type: 'compteur', valeur: 500 }, 'heures'), 'toutes les 500 h');
    assert.equal(periodiciteLibelle({ type: 'compteur', valeur: 10000 }, 'cycles'), 'tous les 10 000 cycles');
    assert.equal(periodiciteLibelle({ type: 'compteur', valeur: 15000 }, 'km'), 'tous les 15 000 km');
    // Addition calendaire (fin de mois)
    assert.equal(ajouterPeriode('2026-01-31', { type: 'mois', valeur: 1 }), '2026-02-28');
    assert.equal(ajouterPeriode('2028-01-31', { type: 'mois', valeur: 1 }), '2028-02-29');
    assert.equal(ajouterPeriode('2026-12-15', { type: 'mois', valeur: 3 }), '2027-03-15');
    assert.equal(ajouterPeriode('2026-10-14', { type: 'semaines', valeur: 2 }), '2026-10-28');
    assert.equal(ajouterPeriode('2026-12-30', { type: 'jours', valeur: 5 }), '2027-01-04');
  });

  test('refuse l\'accès sans session', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/preventif')).status, 401);
    assert.equal((await anonyme.post('/api/preventif', { nom: 'Test' })).status, 401);
  });

  test('droits : 403 pour un profil sans accès ou sans le droit requis', async () => {
    assert.equal((await demandeur.get('/api/preventif')).status, 403);
    assert.equal((await demandeur.get('/api/preventif-echeances')).status, 403);
    assert.equal((await demandeur.post('/api/preventif', { nom: 'Interdit' })).status, 403);
    // Technicien : consultation seulement
    assert.equal((await techProd.get('/api/preventif')).status, 200);
    assert.equal((await techProd.post('/api/preventif', { nom: 'Plan interdit', equipementId: presse.id, periodicite: { type: 'mois', valeur: 1 } })).status, 403);
    assert.equal((await techProd.post('/api/preventif/generer', {})).status, 403);
    assert.equal((await techProd.get('/api/preventif-export')).status, 403);
    assert.equal((await chefProd.get('/api/preventif-export')).status, 403, 'pas de droit exporter pour un chef de secteur');
    const plan = await creerPlan({ nom: 'Plan droits' });
    assert.equal((await techProd.put(`/api/preventif/${plan.id}`, { nom: 'Renommé' })).status, 403);
    assert.equal((await techProd.del(`/api/preventif/${plan.id}`)).status, 403);
    assert.equal((await techProd.post(`/api/preventif/${plan.id}/generer`, {})).status, 403);
    assert.equal((await techProd.post(`/api/preventif/${plan.id}/dupliquer`, {})).status, 403);
    const vu = await techProd.ok('GET', `/api/preventif/${plan.id}`);
    assert.equal(vu.actions.modifier, false);
    assert.equal(vu.actions.generer, false);
  });

  test('validation des entrées', async () => {
    const base = { nom: 'Plan valide', equipementId: presse.id, periodicite: { type: 'mois', valeur: 1 } };
    const cas = [
      [{ nom: undefined }, 'nom obligatoire'], [{ nom: 'ab' }, 'nom trop court'], [{ nom: 'x'.repeat(201) }, 'nom trop long'],
      [{ periodicite: undefined }, 'périodicité obligatoire'], [{ periodicite: 'mensuel' }, 'périodicité non objet'],
      [{ periodicite: { type: 'annees', valeur: 1 } }, 'type de périodicité inconnu'], [{ periodicite: { type: 'mois', valeur: 0 } }, 'valeur nulle'],
      [{ periodicite: { type: 'mois', valeur: -2 } }, 'valeur négative'], [{ periodicite: { type: 'mois', valeur: 1.5 } }, 'mois non entier'],
      [{ periodicite: { type: 'jours', valeur: 'abc' } }, 'valeur non numérique'], [{ periodicite: { type: 'mois', valeur: 500 } }, 'périodicité trop grande'],
      [{ periodicite: { type: 'compteur', valeur: 500 }, equipementId: null }, 'compteur sans équipement'],
      [{ equipementId: 99999 }, 'équipement inexistant'], [{ equipementId: 'abc' }, 'équipement invalide'], [{ equipementId: reforme.id }, 'équipement inactif'],
      [{ typeCode: 'inexistant' }, 'type inconnu'], [{ prioriteCode: 'zzz' }, 'priorité inconnue'], [{ secteurId: 9999, equipementId: null }, 'secteur inexistant'],
      [{ technicienId: 99999 }, 'technicien inexistant'], [{ technicienId: uDemandeur.id }, 'technicien sans accès aux OT'],
      [{ gamme: 'graisser' }, 'gamme non tableau'], [{ gamme: [{ libelle: '' }] }, 'tâche sans libellé'], [{ gamme: [{ libelle: 'Graisser', duree: -1 }] }, 'durée de tâche négative'],
      [{ gamme: Array.from({ length: 201 }, (_, i) => ({ libelle: 'Tâche ' + i })) }, 'trop de tâches'],
      [{ pieces: [{ articleId: 99999, quantite: 1 }] }, 'article inexistant'], [{ pieces: [{ articleId: articleGraisse.id, quantite: 0 }] }, 'quantité nulle'],
      [{ pieces: [{ quantite: 2 }] }, 'article manquant'], [{ pieces: 'graisse' }, 'pièces non tableau'],
      [{ prochaineEcheance: '2026-02-30' }, 'date d\'échéance impossible'], [{ prochaineEcheance: 'demain' }, 'date d\'échéance invalide'],
      [{ dateDebut: '31/12/2026' }, 'date de départ au mauvais format'], [{ derniereExecution: jourLocal(10) }, 'dernière exécution future'],
      [{ periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 'beaucoup' }, 'échéance compteur non numérique'],
      [{ genererJoursAvant: -3 }, 'délai de génération négatif'], [{ genererJoursAvant: 2.5 }, 'délai non entier'], [{ actif: 'peut-être' }, 'actif non booléen'],
      [{ dureeEstimee: -1 }, 'durée estimée négative'],
    ];
    for (const [modif, libelle] of cas) {
      const r = await resp.post('/api/preventif', Object.assign({}, base, modif));
      assert.equal(r.status, 400, `${libelle} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(typeof r.body.erreur === 'string' && r.body.erreur.length > 5, `message d'erreur en clair (${libelle})`);
    }
    assert.match((await resp.post('/api/preventif', Object.assign({}, base, { periodicite: { type: 'compteur', valeur: 500 }, equipementId: null }))).body.erreur, /compteur/);
    assert.match((await resp.post('/api/preventif', Object.assign({}, base, { equipementId: reforme.id }))).body.erreur, /inactif/);
  });

  test('création : numérotation, secteur repris de l\'équipement, échéance calculée, gamme, pièces', async () => {
    const avant = notifsDe(uTechProd.id).length;
    const p = await creerPlan({
      nom: 'Graissage mensuel de la presse', description: 'Graissage des colonnes', dateDebut: '2026-01-31', prioriteCode: 'haute',
      gamme: [{ ordre: 3, libelle: 'Essai de fonctionnement', duree: 0.25 }, { ordre: 1, libelle: 'Consigner la presse', duree: 0.25 }, { ordre: 2, libelle: 'Graisser les colonnes', duree: 1 }],
      pieces: [{ articleId: articleGraisse.id, quantite: 1 }, { articleId: articleGraisse.id, quantite: 2 }, { articleId: articleFiltre.id, quantite: 1 }],
    });
    assert.match(p.numero, /^PP-\d{3}$/);
    assert.equal(p.secteurId, PROD, 'secteur repris de l\'équipement');
    assert.equal(p.typeCode, 'preventif', 'type par défaut');
    assert.equal(p.prioriteCode, 'haute');
    assert.deepEqual(p.periodicite, { type: 'mois', valeur: 1 });
    assert.equal(p.prochaineEcheance, '2026-02-28', 'date de départ + 1 mois (fin de mois)');
    assert.equal(p.periodiciteLibelle, 'tous les mois');
    assert.deepEqual(p.gamme.map((t) => [t.ordre, t.libelle]), [[1, 'Consigner la presse'], [2, 'Graisser les colonnes'], [3, 'Essai de fonctionnement']]);
    assert.equal(p.dureeEstimee, 1.5, 'durée = somme de la gamme');
    assert.deepEqual(p.pieces.map((x) => [x.articleId, x.quantite]), [[articleGraisse.id, 3], [articleFiltre.id, 1]], 'doublons fusionnés');
    assert.equal(p.pieces[0].designation, 'Graisse EP2 cartouche');
    assert.equal(p.actif, true);
    assert.equal(p.createdBy, uResp.id);
    assert.equal(p.equipement.nom, 'Presse de test');
    assert.equal(p.etat, 'en_retard', 'échéance de février 2026 dépassée');
    assert.equal(auditDe('creation', p.id).length, 1);
    assert.equal(notifsDe(uTechProd.id).length, avant + 1, 'technicien notifié');
    assert.equal(notifsDe(uTechProd.id).slice(-1)[0].lien, `#/preventif/${p.id}`);
    assert.ok(evenements.some((e) => e.evt === 'preventif:cree' && e.data.plan.id === p.id));
    // Sans date de départ : aujourd'hui + période
    const p2 = await creerPlan({ nom: 'Contrôle hebdomadaire', periodicite: { type: 'semaines', valeur: 2 } });
    assert.equal(p2.prochaineEcheance, jourLocal(14));
    const p3 = await creerPlan({ nom: 'Contrôle journalier', periodicite: { type: 'jours', valeur: 1 } });
    assert.equal(p3.prochaineEcheance, jourLocal(1));
    // Depuis la dernière exécution
    const p4 = await creerPlan({ nom: 'Révision trimestrielle', periodicite: { type: 'mois', valeur: 3 }, derniereExecution: '2026-03-15' });
    assert.equal(p4.prochaineEcheance, '2026-06-15');
    // Échéance saisie : conservée
    const p5 = await creerPlan({ nom: 'Échéance imposée', prochaineEcheance: jourLocal(45) });
    assert.equal(p5.prochaineEcheance, jourLocal(45));
    // Compteur : compteur courant + valeur
    const p6 = await creerPlan({ nom: 'Vidange 500 h', periodicite: { type: 'compteur', valeur: 500 } });
    assert.equal(p6.prochaineEcheance, 1700);
    assert.equal(p6.periodiciteLibelle, 'toutes les 500 h');
    const p7 = await creerPlan({ nom: 'Vidange depuis relevé', periodicite: { type: 'compteur', valeur: 500 }, derniereExecution: 1000 });
    assert.equal(p7.prochaineEcheance, 1500);
    // Plan sans équipement rattaché à un secteur
    const p8 = await resp.ok('POST', '/api/preventif', { nom: 'Contrôle des extincteurs du site', secteurId: LOG, periodicite: { type: 'mois', valeur: 12 }, typeCode: 'reglementaire' });
    assert.equal(p8.equipementId, null);
    assert.equal(p8.secteurId, LOG);
    assert.equal(p8.periodiciteLibelle, 'tous les ans');
    // Numéros uniques et croissants
    assert.notEqual(p.numero, p2.numero);
  });

  test('états calculés : à jour, proche, en retard, inactif (dates et compteurs)', async () => {
    const retard = await creerPlan({ nom: 'État retard', prochaineEcheance: jourLocal(-3) });
    const proche = await creerPlan({ nom: 'État proche', periodicite: { type: 'semaines', valeur: 2 }, prochaineEcheance: jourLocal(10) });
    const ajour = await creerPlan({ nom: 'État à jour', periodicite: { type: 'mois', valeur: 6 }, prochaineEcheance: jourLocal(90) });
    const horizonCourt = await creerPlan({ nom: 'État horizon court', prochaineEcheance: jourLocal(10), genererJoursAvant: 5 });
    const aujourdhui = await creerPlan({ nom: 'État échéance du jour', prochaineEcheance: AUJ });
    const inactif = await creerPlan({ nom: 'État inactif', prochaineEcheance: jourLocal(-30), actif: false });
    assert.equal(retard.etat, 'en_retard'); assert.equal(retard.joursRestants, -3);
    assert.equal(proche.etat, 'proche'); assert.equal(proche.joursRestants, 10);
    assert.equal(ajour.etat, 'a_jour');
    assert.equal(horizonCourt.etat, 'a_jour', 'délai propre au plan (5 j) prioritaire sur l\'horizon général');
    assert.equal(horizonCourt.horizonJours, 5);
    assert.equal(aujourdhui.etat, 'proche', 'échéance du jour : pas encore en retard');
    assert.equal(inactif.etat, 'inactif');
    // Compteur avec rythme d'utilisation (1 000 h en 100 jours = 10 h/j)
    const cProche = await creerPlan({ nom: 'Compteur proche', periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 1300 });
    assert.equal(cProche.etat, 'proche');
    assert.equal(cProche.resteCompteur, 100);
    assert.equal(cProche.echeanceEstimee, true);
    assert.equal(cProche.echeanceDate, jourLocal(10), 'date estimée d\'après le rythme');
    const cRetard = await creerPlan({ nom: 'Compteur dépassé', periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 1100 });
    assert.equal(cRetard.etat, 'en_retard');
    const cAJour = await creerPlan({ nom: 'Compteur lointain', periodicite: { type: 'compteur', valeur: 1000 }, prochaineEcheance: 2000 });
    assert.equal(cAJour.etat, 'a_jour');
    assert.equal(cAJour.joursRestants, 80);
    // Compteur sans relevés : proche si le reste est inférieur à 10 % de la période
    const sansRythme = await resp.ok('POST', '/api/preventif', { nom: 'Chariot proche', equipementId: chariot.id, periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 90 });
    assert.equal(sansRythme.etat, 'proche');
    assert.equal(sansRythme.echeanceEstimee, false);
    const sansRythme2 = await resp.ok('POST', '/api/preventif', { nom: 'Chariot lointain', equipementId: chariot.id, periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 400 });
    assert.equal(sansRythme2.etat, 'a_jour');
    // Filtres de liste
    const ids = (rows) => rows.map((x) => x.id);
    const enRetard = await resp.ok('GET', '/api/preventif?etat=en_retard');
    assert.ok(ids(enRetard).includes(retard.id) && ids(enRetard).includes(cRetard.id) && !ids(enRetard).includes(proche.id));
    assert.ok(enRetard.every((p) => p.etat === 'en_retard'));
    const plusieurs = await resp.ok('GET', '/api/preventif?etat=proche,inactif');
    assert.ok(ids(plusieurs).includes(proche.id) && ids(plusieurs).includes(inactif.id));
    assert.ok(ids(await resp.ok('GET', '/api/preventif?actif=0')).includes(inactif.id));
    assert.ok(!ids(await resp.ok('GET', '/api/preventif?actif=1')).includes(inactif.id));
    const parEq = await resp.ok('GET', `/api/preventif?equipementId=${chariot.id}`);
    assert.ok(parEq.length >= 2 && parEq.every((p) => p.equipementId === chariot.id));
    const parSecteur = await resp.ok('GET', `/api/preventif?secteurId=${LOG}`);
    assert.ok(parSecteur.length >= 2 && parSecteur.every((p) => p.secteurId === LOG));
    const recherche = await resp.ok('GET', '/api/preventif?recherche=' + encodeURIComponent('horizon court'));
    assert.deepEqual(ids(recherche), [horizonCourt.id]);
    const parGamme = await resp.ok('GET', '/api/preventif?recherche=paliers');
    assert.ok(parGamme.length >= 1, 'recherche dans les libellés de la gamme');
    // Compteurs synthétiques
    const k = await resp.ok('GET', '/api/preventif-compteurs');
    for (const cle of ['total', 'actifs', 'inactifs', 'enRetard', 'proches', 'aJour', 'aVenir30', 'otOuverts', 'chargeHeures30']) assert.equal(typeof k[cle], 'number', cle);
    assert.ok(k.enRetard >= 2 && k.inactifs >= 1 && k.aVenir30 >= 2);
  });

  test('modification : recalcul de l\'échéance quand la périodicité change, audit', async () => {
    const p = await creerPlan({ nom: 'Plan à modifier', derniereExecution: jourLocal(-10) });
    assert.equal(p.prochaineEcheance, ajouterPeriode(jourLocal(-10), { type: 'mois', valeur: 1 }));
    // Changement de périodicité (échéance renvoyée inchangée par le formulaire) → recalcul
    let r = await resp.ok('PUT', `/api/preventif/${p.id}`, { periodicite: { type: 'mois', valeur: 3 }, prochaineEcheance: p.prochaineEcheance });
    assert.equal(r.prochaineEcheance, ajouterPeriode(jourLocal(-10), { type: 'mois', valeur: 3 }));
    assert.equal(r.periodiciteLibelle, 'tous les 3 mois');
    // Échéance saisie explicitement : prioritaire
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { periodicite: { type: 'semaines', valeur: 1 }, prochaineEcheance: jourLocal(3) });
    assert.equal(r.prochaineEcheance, jourLocal(3));
    // Modification sans changement de périodicité : échéance conservée
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { nom: 'Plan modifié', description: 'Nouvelle description' });
    assert.equal(r.prochaineEcheance, jourLocal(3));
    assert.equal(r.nom, 'Plan modifié');
    // Passage sur compteur : dernière exécution (date) abandonnée, échéance = compteur courant + valeur
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { periodicite: { type: 'compteur', valeur: 250 } });
    assert.equal(r.prochaineEcheance, 1450);
    assert.equal(r.derniereExecution, null);
    // Gamme : la durée estimée automatique suit la gamme
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { gamme: [{ libelle: 'Tâche unique', duree: 2 }] });
    assert.equal(r.dureeEstimee, 2);
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { dureeEstimee: 3.5 });
    assert.equal(r.dureeEstimee, 3.5);
    // Désactivation / réactivation tracées
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { actif: false });
    assert.equal(r.actif, false); assert.equal(r.etat, 'inactif');
    assert.equal(auditDe('statut', p.id).length, 1);
    r = await resp.ok('PUT', `/api/preventif/${p.id}`, { actif: true });
    assert.equal(r.actif, true);
    assert.ok(auditDe('modification', p.id).length >= 5);
    assert.ok(evenements.some((e) => e.evt === 'preventif:modifie' && e.data.plan.id === p.id));
    // Validation en modification et 404
    assert.equal((await resp.put(`/api/preventif/${p.id}`, { periodicite: { type: 'mois', valeur: 0 } })).status, 400);
    assert.equal((await resp.put(`/api/preventif/${p.id}`, { nom: '' })).status, 400);
    assert.equal((await resp.put('/api/preventif/99999', { nom: 'Inconnu' })).status, 404);
    assert.equal((await resp.get('/api/preventif/99999')).status, 404);
    assert.equal((await resp.get('/api/preventif/abc')).status, 404);
  });

  test('génération : OT créés pour les plans à échéance, contenu de l\'OT, idempotence', async () => {
    const retard = await creerPlan({ nom: 'Génération retard', prochaineEcheance: jourLocal(-2), pieces: [{ articleId: articleGraisse.id, quantite: 2 }], prioriteCode: 'haute' });
    const proche = await creerPlan({ nom: 'Génération proche', prochaineEcheance: jourLocal(12), typeCode: 'reglementaire' });
    const loin = await creerPlan({ nom: 'Génération lointaine', prochaineEcheance: jourLocal(120) });
    const inactif = await creerPlan({ nom: 'Génération inactif', prochaineEcheance: jourLocal(-5), actif: false });
    const nbEvt = evenements.filter((e) => e.evt === 'preventif:genere').length;
    const avantNotifs = notifsDe(uTechProd.id).length;
    const r = await resp.ok('POST', '/api/preventif/generer', {});
    const parPlan = (id) => r.generes.find((g) => g.planId === id);
    assert.ok(parPlan(retard.id) && parPlan(proche.id), 'plans en retard et proches générés');
    assert.ok(!parPlan(loin.id), 'plan lointain non généré');
    assert.ok(!parPlan(inactif.id), 'plan inactif non généré');
    assert.equal(r.nb, r.ots.length);
    const ot = srv.db.get('ot', parPlan(retard.id).otId);
    assert.match(ot.numero, /^OT-\d{4}-\d{4}$/);
    assert.equal(ot.planPreventifId, retard.id);
    assert.equal(ot.statut, srv.ctx.liste('statutsOT').find((s) => !s.final).code, 'premier statut non final');
    assert.equal(ot.titre, 'Génération retard');
    assert.equal(ot.typeCode, 'preventif');
    assert.equal(ot.prioriteCode, 'haute');
    assert.equal(ot.equipementId, presse.id);
    assert.equal(ot.secteurId, PROD);
    assert.equal(ot.datePrevue, jourLocal(-2), 'date prévue = échéance');
    assert.equal(ot.technicienId, uTechProd.id);
    assert.deepEqual(ot.taches.map((t) => t.libelle), gammeType.map((t) => t.libelle));
    assert.ok(ot.taches.every((t) => t.fait === false));
    assert.equal(ot.echeancePreventif, jourLocal(-2));
    assert.equal(srv.db.get('ot', parPlan(proche.id).otId).typeCode, 'reglementaire');
    assert.equal(evenements.filter((e) => e.evt === 'preventif:genere').length - nbEvt, r.nb, 'événement preventif:genere par OT');
    const evt = evenements.find((e) => e.evt === 'preventif:genere' && e.data.ot.id === ot.id);
    assert.equal(evt.data.plan.id, retard.id);
    assert.equal(auditDe('generation', retard.id).length, 1);
    assert.ok(notifsDe(uTechProd.id).length > avantNotifs, 'technicien notifié de l\'OT');
    // Liste et fiche enrichies
    const liste = await resp.ok('GET', '/api/preventif');
    const l = liste.find((x) => x.id === retard.id);
    assert.equal(l.otOuvertId, ot.id);
    assert.equal(l.otOuvertNumero, ot.numero);
    assert.equal(l.nbOt, 1);
    const fiche = await resp.ok('GET', `/api/preventif/${retard.id}`);
    assert.equal(fiche.historique.length, 1);
    assert.equal(fiche.historique[0].numero, ot.numero);
    assert.equal(fiche.historique[0].final, false);
    assert.equal(fiche.actions.generer, false, 'OT déjà ouvert');
    assert.equal(fiche.stats.nbOuverts, 1);
    // Idempotence : pas de doublon tant qu'un OT est ouvert
    const nbOt = srv.db.count('ot');
    const r2 = await resp.ok('POST', '/api/preventif/generer', {});
    assert.ok(!r2.generes.some((g) => g.planId === retard.id || g.planId === proche.id));
    assert.ok(r2.ignores.some((g) => g.planId === retard.id && /déjà ouvert/.test(g.motif)));
    assert.equal(srv.db.count('ot'), nbOt + r2.nb);
    assert.equal(srv.ctx.services.preventif.generer().length, 0, 'service idempotent');
    // Horizon élargi ponctuellement
    const r3 = await resp.ok('POST', '/api/preventif/generer', { horizonJours: 150 });
    assert.ok(r3.generes.some((g) => g.planId === loin.id));
    assert.equal((await resp.post('/api/preventif/generer', { horizonJours: -1 })).status, 400);
    assert.equal((await resp.post('/api/preventif/generer', { horizonJours: 'abc' })).status, 400);
  });

  test('génération forcée, équipement inactif, OT annulé pour l\'échéance', async () => {
    const p = await creerPlan({ nom: 'Génération forcée', prochaineEcheance: jourLocal(200) });
    let r = await resp.ok('POST', `/api/preventif/${p.id}/generer`, {});
    assert.equal(r.ot.planPreventifId, p.id);
    assert.equal(r.ot.datePrevue, AUJ, 'OT prévu aujourd\'hui');
    assert.equal(r.plan.otOuvertId, r.ot.id);
    let e = await resp.post(`/api/preventif/${p.id}/generer`, {});
    assert.equal(e.status, 400, 'pas de second OT tant que le premier est ouvert');
    assert.match(e.body.erreur, /déjà ouvert/);
    // Annulation de l'OT : pas de régénération automatique pour la même échéance, mais forçage possible
    const p2 = await creerPlan({ nom: 'Plan avec OT annulé', prochaineEcheance: jourLocal(-1) });
    const g = await resp.ok('POST', '/api/preventif/generer', {});
    const otId = g.generes.find((x) => x.planId === p2.id).otId;
    srv.db.update('ot', otId, { statut: 'annule' });
    const g2 = await resp.ok('POST', '/api/preventif/generer', {});
    assert.ok(!g2.generes.some((x) => x.planId === p2.id));
    assert.ok(g2.ignores.some((x) => x.planId === p2.id && /annulé/.test(x.motif)));
    const fiche = await resp.ok('GET', `/api/preventif/${p2.id}`);
    assert.equal(fiche.otAnnule.id, otId);
    r = await resp.ok('POST', `/api/preventif/${p2.id}/generer`, { datePrevue: jourLocal(2) });
    assert.equal(r.ot.datePrevue, jourLocal(2));
    assert.equal((await resp.post(`/api/preventif/${p2.id}/generer`, { datePrevue: 'jamais' })).status, 400);
    // Plan inactif
    const p3 = await creerPlan({ nom: 'Plan inactif forcé', actif: false });
    e = await resp.post(`/api/preventif/${p3.id}/generer`, {});
    assert.equal(e.status, 400);
    assert.match(e.body.erreur, /inactif/);
    // Équipement devenu inactif
    const eq = srv.db.insert('equipements', { numero: 'EQ-P009', nom: 'Équipement bientôt réformé', secteurId: PROD, actif: true, compteur: { valeur: 0, unite: 'heures' }, documents: [], champs: {} });
    const p4 = await creerPlan({ nom: 'Plan sur équipement réformé', equipementId: eq.id, prochaineEcheance: jourLocal(-1) });
    srv.db.update('equipements', eq.id, { actif: false });
    const g3 = await resp.ok('POST', '/api/preventif/generer', {});
    assert.ok(g3.ignores.some((x) => x.planId === p4.id && /inactif/.test(x.motif)));
    assert.equal((await resp.post(`/api/preventif/${p4.id}/generer`, {})).status, 400);
  });

  test('réalisation : la clôture de l\'OT met à jour dernière exécution et prochaine échéance', async () => {
    const p = await creerPlan({ nom: 'Plan réalisé', prochaineEcheance: jourLocal(-4) });
    const { ot } = await resp.ok('POST', `/api/preventif/${p.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${ot.id}/cloturer`, { rapport: 'Gamme réalisée sans anomalie.' });
    let plan = srv.db.get('plansPreventifs', p.id);
    assert.equal(plan.derniereExecution, AUJ, 'date de fin de l\'OT');
    assert.equal(plan.prochaineEcheance, ajouterPeriode(AUJ, { type: 'mois', valeur: 1 }), 'recalculée depuis la date de réalisation');
    assert.equal(plan.dernierOtId, ot.id);
    assert.ok(evenements.some((e) => e.evt === 'preventif:realise' && e.data.plan.id === p.id));
    const fiche = await resp.ok('GET', `/api/preventif/${p.id}`);
    assert.ok(['a_jour', 'proche'].includes(fiche.etat), fiche.etat);
    assert.equal(fiche.otOuvertId, null);
    assert.equal(fiche.stats.nbTermines, 1);
    assert.equal(fiche.historique[0].final, true);
    assert.equal(fiche.actions.generer, true);
    // Compteur : relevé saisi à la clôture
    const pc = await creerPlan({ nom: 'Vidange réalisée', periodicite: { type: 'compteur', valeur: 500 }, prochaineEcheance: 1250 });
    const r = await resp.ok('POST', `/api/preventif/${pc.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${r.ot.id}/cloturer`, { rapport: 'Vidange effectuée, filtre remplacé.', compteurReleve: 1260 });
    plan = srv.db.get('plansPreventifs', pc.id);
    assert.equal(plan.derniereExecution, 1260);
    assert.equal(plan.prochaineEcheance, 1760);
    assert.equal(plan.derniereExecutionDate, AUJ);
    // Événement reçu sans relevé : compteur courant de l'équipement
    const pc2 = await resp.ok('POST', '/api/preventif', { nom: 'Graissage convoyeur', equipementId: convoyeur.id, periodicite: { type: 'compteur', valeur: 10000 }, prochaineEcheance: 49000 });
    srv.ctx.emit('ot:termine', { id: 999001, numero: 'OT-TEST', planPreventifId: pc2.id, dateFin: new Date().toISOString(), ot: { id: 999001, numero: 'OT-TEST', planPreventifId: pc2.id, dateFin: new Date().toISOString() } });
    plan = srv.db.get('plansPreventifs', pc2.id);
    assert.equal(plan.derniereExecution, 50000);
    assert.equal(plan.prochaineEcheance, 60000);
    // Réalisation plus ancienne que la dernière connue : ignorée
    const pa = await creerPlan({ nom: 'Plan réalisation ancienne', derniereExecution: jourLocal(-2) });
    srv.ctx.emit('ot:termine', { id: 999002, numero: 'OT-ANCIEN', planPreventifId: pa.id, dateFin: jourLocal(-20) });
    assert.equal(srv.db.get('plansPreventifs', pa.id).derniereExecution, jourLocal(-2));
    // OT sans plan : ignoré sans erreur
    srv.ctx.emit('ot:termine', { id: 999003, numero: 'OT-SANS-PLAN' });
  });

  test('génération via ctx.services.ot.creerDepuisPlan si le service existe', async () => {
    const sauve = srv.ctx.services.ot;
    const appels = [];
    srv.ctx.services.ot = Object.assign({}, sauve, {
      creerDepuisPlan(plan, req, options) {
        appels.push({ plan, req, options });
        return srv.db.insert('ot', { numero: 'OT-SVC-0001', titre: plan.nom, statut: 'nouveau', planPreventifId: plan.id, equipementId: plan.equipementId, secteurId: plan.secteurId, taches: [], datePrevue: options.datePrevue });
      },
    });
    try {
      const p = await creerPlan({ nom: 'Plan via service', prochaineEcheance: jourLocal(-1) });
      const { ot } = await resp.ok('POST', `/api/preventif/${p.id}/generer`, {});
      assert.equal(appels.length, 1);
      assert.equal(appels[0].plan.id, p.id);
      assert.equal(appels[0].req.user.id, uResp.id);
      assert.equal(ot.numero, 'OT-SVC-0001');
      assert.equal(srv.db.get('ot', ot.id).echeancePreventif, jourLocal(-1));
    } finally { srv.ctx.services.ot = sauve; }
  });

  test('génération autonome (module OT absent) : insertion conforme au modèle', async () => {
    const sauve = srv.ctx.services.ot;
    srv.ctx.services.ot = undefined;
    try {
      const p = await creerPlan({ nom: 'Plan sans module OT', prochaineEcheance: jourLocal(-7), pieces: [{ articleId: articleFiltre.id, quantite: 1 }], dureeEstimee: 2 });
      const nbCree = evenements.filter((e) => e.evt === 'ot:cree').length;
      const r = await resp.ok('POST', '/api/preventif/generer', {});
      const g = r.generes.find((x) => x.planId === p.id);
      assert.ok(g, JSON.stringify(r));
      const ot = srv.db.get('ot', g.otId);
      assert.match(ot.numero, /^OT-\d{4}-\d{4}$/);
      assert.equal(ot.statut, 'nouveau');
      assert.equal(ot.typeCode, 'preventif');
      assert.equal(ot.datePrevue, jourLocal(-7));
      assert.equal(ot.planPreventifId, p.id);
      assert.equal(ot.technicienId, uTechProd.id);
      assert.deepEqual(ot.techniciens, [uTechProd.id]);
      assert.deepEqual(ot.taches.map((t) => [t.ordre, t.libelle, t.fait]), gammeType.map((t, i) => [i + 1, t.libelle, false]));
      assert.deepEqual(ot.pieces, []);
      assert.equal(ot.piecesPrevues[0].articleId, articleFiltre.id);
      assert.equal(ot.dureeEstimee, 2);
      assert.equal(ot.createdBy, uResp.id);
      assert.equal(evenements.filter((e) => e.evt === 'ot:cree').length, nbCree + r.nb, 'ot:cree émis en mode autonome');
      const r2 = await resp.ok('POST', '/api/preventif/generer', {});
      assert.ok(!r2.generes.some((x) => x.planId === p.id), 'idempotent en mode autonome');
    } finally { srv.ctx.services.ot = sauve; }
  });

  test('génération automatique à la consultation (config.preventif.genererAuto)', async () => {
    const p = await creerPlan({ nom: 'Plan génération auto', prochaineEcheance: jourLocal(-1) });
    let l = (await resp.ok('GET', '/api/preventif')).find((x) => x.id === p.id);
    assert.equal(l.otOuvertId, null, 'genererAuto désactivé : pas de génération');
    config({ preventif: { genererAuto: true } });
    try {
      l = (await techProd.ok('GET', '/api/preventif')).find((x) => x.id === p.id);
      assert.ok(l.otOuvertId, 'OT généré automatiquement à la consultation');
      const ot = srv.db.get('ot', l.otOuvertId);
      assert.equal(ot.createdBy, null, 'création système');
      assert.ok(srv.db.list('audit', (a) => a.action === 'generation' && a.entiteId === p.id && a.userId === null).length === 1);
      const nb = srv.db.count('ot');
      await techProd.ok('GET', '/api/preventif');
      assert.equal(srv.db.count('ot'), nb, 'sans doublon');
      assert.ok(notifsDe(uResp.id).some((n) => /OT généré/.test(n.titre)), 'planificateurs informés de la génération automatique');
    } finally { config({ preventif: { genererAuto: false } }); }
  });

  test('portée : un utilisateur limité à ses secteurs ne voit ni ne gère les plans des autres secteurs', async () => {
    const pProd = await creerPlan({ nom: 'Plan production portée', prochaineEcheance: jourLocal(-1) });
    const pLog = await resp.ok('POST', '/api/preventif', { nom: 'Plan logistique portée', equipementId: chariot.id, periodicite: { type: 'mois', valeur: 1 }, prochaineEcheance: jourLocal(-1), technicienId: uTechLog.id });
    const pSansSecteur = await resp.ok('POST', '/api/preventif', { nom: 'Plan général sans secteur', periodicite: { type: 'mois', valeur: 1 }, prochaineEcheance: jourLocal(60) });
    const ids = (rows) => rows.map((x) => x.id);
    const vus = ids(await techProd.ok('GET', '/api/preventif'));
    assert.ok(vus.includes(pProd.id));
    assert.ok(!vus.includes(pLog.id), 'plan d\'un autre secteur invisible');
    assert.ok(vus.includes(pSansSecteur.id), 'plan sans secteur visible');
    assert.equal((await techProd.get(`/api/preventif/${pLog.id}`)).status, 404);
    const ech = await techProd.ok('GET', '/api/preventif-echeances?jours=60');
    assert.ok(!ech.some((x) => x.planId === pLog.id) && ech.some((x) => x.planId === pProd.id));
    // Planificateur limité à la production (droits préventif accordés individuellement)
    assert.equal((await chefPrev.post('/api/preventif', { nom: 'Plan hors périmètre', equipementId: chariot.id, periodicite: { type: 'mois', valeur: 1 } })).status, 400, 'équipement hors périmètre');
    assert.equal((await chefPrev.post('/api/preventif', { nom: 'Plan secteur interdit', secteurId: LOG, periodicite: { type: 'mois', valeur: 1 } })).status, 403);
    const pChef = await chefPrev.ok('POST', '/api/preventif', { nom: 'Plan du planificateur', equipementId: presse.id, periodicite: { type: 'mois', valeur: 2 } });
    assert.equal(pChef.secteurId, PROD);
    assert.equal((await chefPrev.put(`/api/preventif/${pChef.id}`, { equipementId: null, secteurId: LOG })).status, 403);
    assert.equal((await chefPrev.put(`/api/preventif/${pLog.id}`, { nom: 'Piratage' })).status, 404);
    assert.equal((await chefPrev.del(`/api/preventif/${pLog.id}`)).status, 404);
    assert.equal((await chefPrev.post(`/api/preventif/${pLog.id}/generer`, {})).status, 404);
    const g = await chefPrev.ok('POST', '/api/preventif/generer', {});
    assert.ok(g.generes.some((x) => x.planId === pProd.id), 'génère les plans de son secteur');
    assert.ok(!g.generes.some((x) => x.planId === pLog.id), 'ne génère pas les plans des autres secteurs');
    assert.equal(srv.ctx.services.preventif.analyser(srv.db.get('plansPreventifs', pLog.id)).etat, 'en_retard');
    assert.equal(srv.db.count('ot', (o) => o.planPreventifId === pLog.id), 0);
    const csv = await chefPrev.get('/api/preventif-export');
    assert.equal(csv.status, 200);
    assert.ok(!csv.body.includes('Plan logistique portée'));
  });

  test('suppression : définitive sans OT, désactivation si des OT référencent le plan', async () => {
    const libre = await creerPlan({ nom: 'Plan à supprimer' });
    let r = await resp.ok('DELETE', `/api/preventif/${libre.id}`);
    assert.deepEqual(r, { ok: true });
    assert.equal(srv.db.get('plansPreventifs', libre.id), null);
    assert.equal(auditDe('suppression', libre.id).length, 1);
    assert.ok(evenements.some((e) => e.evt === 'preventif:supprime' && e.data.plan.id === libre.id));
    const lie = await creerPlan({ nom: 'Plan référencé' });
    await resp.ok('POST', `/api/preventif/${lie.id}/generer`, {});
    r = await resp.ok('DELETE', `/api/preventif/${lie.id}`);
    assert.equal(r.desactive, true);
    assert.equal(r.nbOt, 1);
    assert.equal(srv.db.get('plansPreventifs', lie.id).actif, false);
    assert.equal(auditDe('desactivation', lie.id).length, 1);
    assert.equal((await resp.del('/api/preventif/99999')).status, 404);
  });

  test('duplication', async () => {
    const src = await creerPlan({ nom: 'Plan source', prochaineEcheance: jourLocal(-10), derniereExecution: jourLocal(-40), pieces: [{ articleId: articleGraisse.id, quantite: 1 }], genererJoursAvant: 10 });
    const copie = await resp.ok('POST', `/api/preventif/${src.id}/dupliquer`, {});
    assert.notEqual(copie.id, src.id);
    assert.notEqual(copie.numero, src.numero);
    assert.equal(copie.nom, 'Plan source (copie)');
    assert.equal(copie.derniereExecution, null);
    assert.equal(copie.prochaineEcheance, ajouterPeriode(AUJ, { type: 'mois', valeur: 1 }), 'échéance recalculée depuis aujourd\'hui');
    assert.deepEqual(copie.gamme.map((t) => t.libelle), src.gamme.map((t) => t.libelle));
    assert.deepEqual(copie.pieces.map((x) => x.articleId), [articleGraisse.id]);
    assert.equal(copie.genererJoursAvant, 10);
    assert.equal(copie.technicienId, uTechProd.id);
    assert.equal(auditDe('duplication', copie.id).length, 1);
    // Vers un autre équipement (le secteur suit)
    const autre = await resp.ok('POST', `/api/preventif/${src.id}/dupliquer`, { equipementId: chariot.id, nom: 'Plan dupliqué chariot' });
    assert.equal(autre.equipementId, chariot.id);
    assert.equal(autre.secteurId, LOG);
    assert.equal(autre.nom, 'Plan dupliqué chariot');
    assert.equal((await resp.post(`/api/preventif/${src.id}/dupliquer`, { equipementId: reforme.id })).status, 400);
  });

  test('échéancier : occurrences projetées, filtres, validation', async () => {
    const hebdo = await creerPlan({ nom: 'Contrôle hebdomadaire échéancier', periodicite: { type: 'semaines', valeur: 1 }, prochaineEcheance: jourLocal(2) });
    let occ = (await resp.ok('GET', '/api/preventif-echeances?jours=30')).filter((x) => x.planId === hebdo.id);
    assert.deepEqual(occ.map((x) => x.date), [2, 9, 16, 23, 30].map(jourLocal));
    assert.deepEqual(occ.map((x) => x.occurrence), [0, 1, 2, 3, 4]);
    assert.equal(occ[0].etat, 'proche');
    assert.equal(occ[0].periodiciteLibelle, 'toutes les semaines');
    occ = (await resp.ok('GET', '/api/preventif-echeances?jours=30&projection=0')).filter((x) => x.planId === hebdo.id);
    assert.equal(occ.length, 1);
    const tout = await resp.ok('GET', '/api/preventif-echeances?jours=365');
    for (let i = 1; i < tout.length; i++) if (tout[i].date && tout[i - 1].date) assert.ok(tout[i - 1].date <= tout[i].date, 'triées par date');
    assert.ok(tout.some((x) => x.enRetard), 'échéances dépassées incluses');
    assert.ok(tout.some((x) => x.typePeriodicite === 'compteur' && x.estimee), 'échéances sur compteur estimées');
    const parEq = await resp.ok('GET', `/api/preventif-echeances?jours=365&equipementId=${chariot.id}&nonDatees=1`);
    assert.ok(parEq.every((x) => x.equipementId === chariot.id));
    assert.ok(parEq.some((x) => x.date === null), 'compteurs sans rythme : échéances non datées');
    assert.equal((await resp.get('/api/preventif-echeances?jours=abc')).status, 400);
    assert.equal((await resp.get('/api/preventif-echeances?jours=-5')).status, 400);
    const svc = srv.ctx.services.preventif.echeances({ jours: 30 });
    assert.ok(svc.some((x) => x.planId === hebdo.id));
    // Fiche : prochaines échéances
    const fiche = await resp.ok('GET', `/api/preventif/${hebdo.id}`);
    assert.deepEqual(fiche.prochainesEcheances.slice(0, 3).map((x) => x.date), [2, 9, 16].map(jourLocal));
  });

  test('échéancier : les occurrences projetées d\'un plan en retard partent de la réalisation attendue, jamais du passé', async () => {
    const il = (j) => new Date(Date.now() - j * 86400000).toISOString();
    // Compteur de la presse : 200 h il y a 100 jours, 1 200 h aujourd'hui (10 h par jour), comme à l'installation
    srv.db.update('equipements', presse.id, { compteur: { valeur: 1200, unite: 'heures' }, compteurReleves: [{ date: il(100), valeur: 200 }, { date: il(0), valeur: 1200 }] });
    const hebdo = await creerPlan({ nom: 'Hebdomadaire en retard de dix semaines', periodicite: { type: 'semaines', valeur: 1 }, prochaineEcheance: jourLocal(-70) });
    const cpt = await creerPlan({ nom: 'Vidange en retard sur compteur', periodicite: { type: 'compteur', valeur: 300 }, prochaineEcheance: 700 });
    try {
      const occ = (await resp.ok('GET', '/api/preventif-echeances?jours=30')).filter((x) => x.planId === hebdo.id);
      assert.equal(occ[0].occurrence, 0);
      assert.equal(occ[0].date, jourLocal(-70));
      assert.equal(occ[0].etat, 'en_retard');
      assert.ok(occ[0].enRetard, 'seule l\'échéance dépassée est un retard');
      assert.deepEqual(occ.slice(1).map((x) => x.date), [7, 14, 21, 28].map(jourLocal), 'projections à partir d\'aujourd\'hui, réalisation attendue de l\'échéance dépassée');
      assert.ok(occ.slice(1).every((x) => x.date >= AUJ && !x.enRetard && x.etat === 'proche'), 'aucune projection dans le passé');
      // Plan sur compteur en retard (échéance 700 h, compteur à 1 200 h) : seuils suivants au-delà du compteur actuel
      const oc = (await resp.ok('GET', '/api/preventif-echeances?jours=100')).filter((x) => x.planId === cpt.id);
      assert.equal(oc[0].valeurCompteur, 700);
      assert.equal(oc[0].etat, 'en_retard');
      assert.ok(oc.length >= 3, `occurrences sur compteur : ${oc.length}`);
      assert.deepEqual(oc.slice(1, 3).map((x) => x.valeurCompteur), [1500, 1800]);
      assert.deepEqual(oc.slice(1, 3).map((x) => x.date), [jourLocal(30), jourLocal(60)], 'estimées à 10 h par jour depuis aujourd\'hui');
      assert.ok(oc.slice(1).every((x) => x.date >= AUJ), 'aucune projection sur compteur dans le passé');
      // Fiche du plan : prochaines échéances cohérentes
      const fiche = await resp.ok('GET', `/api/preventif/${hebdo.id}`);
      assert.equal(fiche.prochainesEcheances[0].date, jourLocal(-70));
      assert.ok(fiche.prochainesEcheances.slice(1).every((x) => x.date >= AUJ));
    } finally { srv.db.remove('plansPreventifs', hebdo.id); srv.db.remove('plansPreventifs', cpt.id); }
  });

  test('réalisation remise en cause : réouverture, annulation ou suppression de l\'OT rétablit l\'état du plan', async () => {
    const p = await creerPlan({ nom: 'Plan réalisé puis remis en cause', prochaineEcheance: jourLocal(2), derniereExecution: jourLocal(-28) });
    const { ot } = await resp.ok('POST', `/api/preventif/${p.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${ot.id}/cloturer`, { rapport: 'Gamme réalisée.' });
    let plan = srv.db.get('plansPreventifs', p.id);
    assert.equal(plan.derniereExecution, AUJ);
    assert.equal(plan.dernierOtId, ot.id);
    assert.deepEqual(plan.realisationPrecedente, { derniereExecution: jourLocal(-28), derniereExecutionDate: jourLocal(-28), prochaineEcheance: jourLocal(2), dernierOtId: null }, 'état antérieur mémorisé');
    // Réouverture de l'OT : la maintenance n'est plus considérée comme faite
    const nbEvt = evenements.length;
    await resp.ok('POST', `/api/ot/${ot.id}/reouvrir`, { motif: 'Clôturée par erreur' });
    plan = srv.db.get('plansPreventifs', p.id);
    assert.deepEqual({ d: plan.derniereExecution, dd: plan.derniereExecutionDate, e: plan.prochaineEcheance, o: plan.dernierOtId, m: plan.realisationPrecedente }, { d: jourLocal(-28), dd: jourLocal(-28), e: jourLocal(2), o: null, m: null });
    assert.ok(auditDe('modification', p.id).some((a) => /réalisation annulée/.test(a.details) && /réouvert/.test(a.details)), 'journal d\'activité');
    assert.ok(evenements.slice(nbEvt).some((x) => x.evt === 'preventif:modifie' && x.data.plan.id === p.id && x.data.champsModifies.includes('prochaineEcheance')));
    assert.equal((await resp.ok('GET', `/api/preventif/${p.id}`)).etat, 'proche');
    // Annulation de l'OT réouvert : l'état rétabli est conservé ; une nouvelle génération reste possible
    await resp.ok('POST', `/api/ot/${ot.id}/statut`, { statut: 'annule', commentaire: 'Sans objet' });
    plan = srv.db.get('plansPreventifs', p.id);
    assert.deepEqual({ d: plan.derniereExecution, e: plan.prochaineEcheance, o: plan.dernierOtId }, { d: jourLocal(-28), e: jourLocal(2), o: null });
    const { ot: ot2 } = await resp.ok('POST', `/api/preventif/${p.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${ot2.id}/cloturer`, { rapport: 'Gamme réalisée.' });
    plan = srv.db.get('plansPreventifs', p.id);
    assert.deepEqual({ d: plan.derniereExecution, e: plan.prochaineEcheance, o: plan.dernierOtId }, { d: AUJ, e: ajouterPeriode(AUJ, { type: 'mois', valeur: 1 }), o: ot2.id });
    // Sans état mémorisé (données plus anciennes) et sans autre OT terminé : retour à l'échéance de génération de l'OT
    srv.db.update('plansPreventifs', p.id, { realisationPrecedente: null });
    await resp.ok('POST', `/api/ot/${ot2.id}/reouvrir`, { motif: 'Reprise' });
    plan = srv.db.get('plansPreventifs', p.id);
    assert.deepEqual({ d: plan.derniereExecution, e: plan.prochaineEcheance, o: plan.dernierOtId }, { d: null, e: jourLocal(2), o: null });
    await resp.ok('POST', `/api/ot/${ot2.id}/cloturer`, { rapport: 'Gamme réalisée, pour de bon.' });
    assert.equal(srv.db.get('plansPreventifs', p.id).dernierOtId, ot2.id);
    // Sans état mémorisé mais avec un OT terminé précédent : recalcul depuis cette réalisation
    const q = await creerPlan({ nom: 'Plan à deux réalisations', prochaineEcheance: jourLocal(1) });
    const { ot: otA } = await resp.ok('POST', `/api/preventif/${q.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${otA.id}/cloturer`, { rapport: 'Première réalisation.' });
    const { ot: otB } = await resp.ok('POST', `/api/preventif/${q.id}/generer`, {});
    await resp.ok('POST', `/api/ot/${otB.id}/cloturer`, { rapport: 'Seconde réalisation.' });
    srv.db.update('plansPreventifs', q.id, { realisationPrecedente: null });
    await resp.ok('POST', `/api/ot/${otB.id}/reouvrir`, { motif: 'Reprise' });
    plan = srv.db.get('plansPreventifs', q.id);
    assert.deepEqual({ d: plan.derniereExecution, e: plan.prochaineEcheance, o: plan.dernierOtId }, { d: AUJ, e: ajouterPeriode(AUJ, { type: 'mois', valeur: 1 }), o: otA.id });
    // Un changement de statut d'un OT qui n'est pas celui de la dernière réalisation ne change rien
    srv.ctx.emit('ot:statut', { id: otB.id, numero: otB.numero, planPreventifId: q.id, statut: 'annule', ancien: 'en_cours', nouveau: 'annule' });
    assert.deepEqual({ d: srv.db.get('plansPreventifs', q.id).derniereExecution, o: srv.db.get('plansPreventifs', q.id).dernierOtId }, { d: AUJ, o: otA.id });
  });

  test('export CSV : cellules commençant par = + - @ neutralisées (injection de formules)', async () => {
    const p = await creerPlan({ nom: '=HYPERLINK("http://exemple.invalid";"Cliquer")' });
    const ligne = String((await resp.get('/api/preventif-export')).body).split('\r\n').find((l) => l.startsWith(p.numero + ';'));
    assert.ok(ligne, 'ligne exportée');
    assert.ok(ligne.includes(';"\'=HYPERLINK('), 'apostrophe devant = : ' + ligne);
    assert.ok(!/;"?=HYPERLINK/.test(ligne), 'aucune formule exécutable');
    await admin.ok('DELETE', '/api/preventif/' + p.id);
  });

  test('réalisation : seul un OT du plan portant sur l\'équipement du plan l\'enregistre ; relevé borné au compteur de l\'équipement', async () => {
    const plan = await creerPlan({ nom: 'Réalisation contrôlée', equipementId: presse.id, periodicite: { type: 'compteur', valeur: 500 }, derniereExecution: 1000 });
    const otAilleurs = srv.db.insert('ot', { numero: 'OT-REAL-1', titre: 'OT déplacé sur un autre équipement', statut: 'termine', planPreventifId: plan.id, equipementId: convoyeur.id, secteurId: PROD, dateFin: new Date().toISOString(), techniciens: [], compteurReleve: 1600, createdBy: 1 });
    srv.ctx.emit('ot:termine', { ot: otAilleurs });
    let p = srv.db.get('plansPreventifs', plan.id);
    assert.notEqual(p.dernierOtId, otAilleurs.id, 'OT sur un autre équipement : aucune réalisation enregistrée');
    assert.equal(p.derniereExecution, 1000);
    const otPlan = srv.db.insert('ot', { numero: 'OT-REAL-2', titre: 'OT du plan', statut: 'termine', planPreventifId: plan.id, equipementId: presse.id, secteurId: PROD, dateFin: new Date().toISOString(), techniciens: [], compteurReleve: 999999, createdBy: 1 });
    srv.ctx.emit('ot:termine', { ot: otPlan });
    p = srv.db.get('plansPreventifs', plan.id);
    const compteur = srv.db.get('equipements', presse.id).compteur.valeur;
    assert.equal(p.dernierOtId, otPlan.id);
    assert.equal(p.derniereExecution, compteur, 'relevé borné au compteur courant de l\'équipement');
    assert.equal(p.prochaineEcheance, compteur + 500);
    srv.db.remove('ot', otAilleurs.id); srv.db.remove('ot', otPlan.id);
    await admin.ok('DELETE', '/api/preventif/' + plan.id);
  });

  test('portée : un plan ne peut être rattaché qu\'à un secteur modifiable (site en lecture seule refusé, portées site et perso comprises)', async () => {
    const site2 = srv.db.insert('secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site', parentId: null, actif: true, ordre: 90 });
    const prod2 = srv.db.insert('secteurs', { nom: 'Production Valréas', code: 'VPROD', type: 'atelier', parentId: site2.id, actif: true, ordre: 91 });
    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const droits = { preventif: { voir: true, creer: true, modifier: true, supprimer: true } };
    await admin.ok('POST', '/api/utilisateurs', { login: 'planif.site', nom: 'Planificateur', prenom: 'Site', profilId: p('Chef de secteur'), secteurIds: [PROD], siteAcces: [{ siteId: site2.id, mode: 'lecture' }], password: 'chef1234', doitChangerMdp: false, overrides: droits, porteeOverride: 'site' });
    await admin.ok('POST', '/api/utilisateurs', { login: 'planif.perso', nom: 'Planificateur', prenom: 'Perso', profilId: p('Demandeur'), secteurIds: [], siteAcces: [{ siteId: site2.id, mode: 'lecture' }], password: 'chef1234', doitChangerMdp: false, overrides: droits });
    const cSite = srv.client(); await cSite.login('planif.site', 'chef1234');
    const cPerso = srv.client(); await cPerso.login('planif.perso', 'chef1234');
    const base = { periodicite: { type: 'mois', valeur: 1 } };
    const r1 = await cSite.post('/api/preventif', Object.assign({ nom: 'Plan site 2', secteurId: prod2.id }, base));
    assert.equal(r1.status, 403, 'portée site : site en lecture seule refusé'); assert.match(r1.body.erreur, /lecture seule/);
    const ok = await cSite.post('/api/preventif', Object.assign({ nom: 'Plan site 1', secteurId: PROD }, base));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await cSite.put('/api/preventif/' + ok.body.id, { secteurId: prod2.id })).status, 403, 'changement vers un secteur en lecture seule refusé');
    assert.equal((await cPerso.post('/api/preventif', Object.assign({ nom: 'Plan perso site 2', secteurId: prod2.id }, base))).status, 403, 'portée perso sans secteur : site en lecture seule refusé');
    const okPerso = await cPerso.post('/api/preventif', Object.assign({ nom: 'Plan perso site 1', secteurId: LOG }, base));
    assert.equal(okPerso.status, 200, JSON.stringify(okPerso.body));
    await admin.ok('DELETE', '/api/preventif/' + ok.body.id); await admin.ok('DELETE', '/api/preventif/' + okPerso.body.id);
  });

  test('export CSV', async () => {
    await creerPlan({ nom: 'Plan exporté ; avec "guillemets"' });
    const r = await resp.get('/api/preventif-export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /plans-preventifs-\d{4}-\d{2}-\d{2}\.csv/);
    const lignes = r.body.split('\r\n');
    assert.ok(lignes[0].replace(/^\ufeff/, '').startsWith('Numéro;Nom;Type;Priorité'), lignes[0]);
    assert.ok(r.body.includes('"Plan exporté ; avec ""guillemets"""'), 'échappement CSV');
    assert.ok(r.body.includes('tous les mois'));
    const filtre = await resp.get('/api/preventif-export?etat=inactif');
    assert.ok(filtre.body.split('\r\n').slice(1).every((l) => l.includes('Inactif')));
    assert.ok(srv.db.list('audit', (a) => a.action === 'export' && a.entite === 'plansPreventifs').length >= 2);
  });

  test('références du formulaire', async () => {
    const r = await chefPrev.ok('GET', '/api/preventif-references');
    assert.ok(r.equipements.some((e) => e.id === presse.id));
    assert.ok(!r.equipements.some((e) => e.id === chariot.id), 'équipements hors périmètre exclus');
    assert.ok(!r.equipements.some((e) => e.id === reforme.id), 'équipements inactifs exclus');
    assert.ok(r.techniciens.some((t) => t.id === uTechProd.id));
    assert.ok(!r.techniciens.some((t) => t.id === uDemandeur.id), 'utilisateurs sans accès aux OT exclus');
    assert.ok(r.articles.some((a) => a.id === articleGraisse.id));
    assert.equal(r.horizonJours, 30);
    assert.equal((await demandeur.get('/api/preventif-references')).status, 403);
  });

  test('données de démonstration : 6 plans réalistes (1 en retard, 2 proches), idempotentes', async () => {
    const autre = await demarrer();
    try {
      const { seedDemo } = require('../server/modules');
      seedDemo(autre.ctx);
      const plans = autre.db.list('plansPreventifs');
      assert.equal(plans.length, 6);
      assert.ok(plans.every((p) => /^PP-\d{3}$/.test(p.numero) && p.equipementId && p.gamme.length >= 4 && p.actif));
      const etats = plans.map((p) => autre.ctx.services.preventif.analyser(p).etat);
      assert.equal(etats.filter((e) => e === 'en_retard').length, 1);
      assert.equal(etats.filter((e) => e === 'proche').length, 2);
      assert.equal(etats.filter((e) => e === 'a_jour').length, 3);
      assert.ok(plans.some((p) => p.periodicite.type === 'compteur'));
      assert.ok(plans.some((p) => p.typeCode === 'reglementaire' && p.periodicite.valeur === 12));
      const mod = autre.ctx.modules.find((m) => m.fichier === 'preventif.js');
      assert.match(mod.seedDemo(autre.ctx), /déjà/);
      assert.equal(autre.db.count('plansPreventifs'), 6, 'idempotent');
      const c = autre.client(); await c.login('admin', 'admin');
      const liste = await c.ok('GET', '/api/preventif');
      assert.equal(liste.length, 6);
      const fiche = await c.ok('GET', `/api/preventif/${liste[0].id}`);
      assert.ok(fiche.gamme.length && fiche.prochainesEcheances.length);
    } finally { await autre.stop(); }
  });
});

describe('Maintenance préventive : pièces dédiées dans les pièces prévues', () => {
  let srv, admin, resp, PROD, MAINT;
  let ligne, remplisseuse, presse, pontMaint, dediee, dedieeMaint, libre;
  const eq = (numero, nom, secteurId, parentId = null) => srv.db.insert('equipements', { numero, nom, parentId, secteurId, actif: true, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', documents: [], champs: {}, compteur: { valeur: 0, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
  const plan = (champs) => Object.assign({ nom: 'Plan avec pièces', periodicite: { type: 'mois', valeur: 1 }, gamme: [{ libelle: 'Remplacer les pièces', duree: 1 }] }, champs);

  before(async () => {
    srv = await demarrer();
    const cfg = srv.db.getConfig(); cfg.preventif = Object.assign({}, cfg.preventif, { genererAuto: false }); srv.db.setConfig(cfg);
    admin = srv.client(); await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    MAINT = secteurs.find((s) => s.code === 'MAINT').id;
    const profils = await admin.ok('GET', '/api/profils');
    await admin.ok('POST', '/api/utilisateurs', { login: 'chef.ded', nom: 'Planificateur', prenom: 'Paul', profilId: profils.find((p) => p.nom === 'Chef de secteur').id, secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false, overrides: { preventif: { creer: true, modifier: true } } });
    resp = srv.client(); await resp.login('chef.ded', 'chef1234');
    ligne = eq('EQ-PL1', 'Ligne 1', PROD);
    remplisseuse = eq('EQ-PL2', 'Remplisseuse', PROD, ligne.id);
    presse = eq('EQ-PL3', 'Presse 250 t', PROD);
    pontMaint = eq('EQ-PL4', 'Pont roulant', MAINT);
    dediee = await admin.ok('POST', '/api/articles', { code: 'ART-PDED', designation: 'Kit joints remplisseuse', reservee: true, equipementIds: [ligne.id], quantite: 5 });
    dedieeMaint = await admin.ok('POST', '/api/articles', { code: 'ART-PMNT', designation: 'Câble de levage', reservee: true, equipementIds: [pontMaint.id], quantite: 2 });
    libre = await admin.ok('POST', '/api/articles', { code: 'ART-PLIB', designation: 'Graisse EP2', quantite: 20 });
  });
  after(async () => { await srv.stop(); });

  test('enregistrer un plan dont une pièce prévue est dédiée à une autre machine : refusé (400)', async () => {
    const refus = await resp.post('/api/preventif', plan({ equipementId: presse.id, pieces: [{ articleId: dediee.id, quantite: 1 }, { articleId: libre.id, quantite: 2 }] }));
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /ART-PDED — Kit joints remplisseuse/);
    assert.match(refus.body.erreur, /Presse 250 t \(EQ-PL3\)/);
    const sansEq = await resp.post('/api/preventif', plan({ equipementId: null, secteurId: PROD, pieces: [{ articleId: dediee.id, quantite: 1 }] }));
    assert.equal(sansEq.status, 400, 'plan sans équipement : pièce dédiée refusée');
    const horsPerimetre = await resp.post('/api/preventif', plan({ equipementId: presse.id, pieces: [{ articleId: dedieeMaint.id, quantite: 1 }] }));
    assert.equal(horsPerimetre.status, 400);
    assert.match(horsPerimetre.body.erreur, /1 équipement\(s\) hors de votre périmètre/);
    assert.doesNotMatch(horsPerimetre.body.erreur, /Pont roulant/);
    const ok = await resp.ok('POST', '/api/preventif', plan({ equipementId: remplisseuse.id, pieces: [{ articleId: dediee.id, quantite: 1 }, { articleId: libre.id, quantite: 2 }] }));
    assert.equal(ok.pieces.length, 2);
    const p = ok.pieces.find((x) => x.articleId === dediee.id);
    assert.equal(p.reservee, true);
    assert.equal(p.utilisable, true);
    assert.deepEqual(p.reserveeA, ['Ligne 1']);
  });

  test('changer l\'équipement d\'un plan : même règle ; modification sans rapport acceptée ; duplication contrôlée', async () => {
    const p = await resp.ok('POST', '/api/preventif', plan({ nom: 'Plan remplisseuse', equipementId: remplisseuse.id, pieces: [{ articleId: dediee.id, quantite: 1 }] }));
    const refus = await resp.put('/api/preventif/' + p.id, { equipementId: presse.id });
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /Kit joints remplisseuse/);
    assert.equal(srv.db.get('plansPreventifs', p.id).equipementId, remplisseuse.id);
    assert.equal((await resp.ok('PUT', '/api/preventif/' + p.id, { equipementId: ligne.id })).equipementId, ligne.id, 'équipement parent autorisé');
    assert.equal((await resp.ok('PUT', '/api/preventif/' + p.id, { nom: 'Plan de la ligne 1' })).nom, 'Plan de la ligne 1');
    assert.equal((await resp.ok('PUT', '/api/preventif/' + p.id, { equipementId: presse.id, pieces: [{ articleId: libre.id, quantite: 1 }] })).equipementId, presse.id, 'pièce dédiée retirée : changement accepté');
    const autre = await resp.ok('POST', '/api/preventif', plan({ nom: 'Plan à dupliquer', equipementId: remplisseuse.id, pieces: [{ articleId: dediee.id, quantite: 1 }] }));
    assert.equal((await resp.post(`/api/preventif/${autre.id}/dupliquer`, { equipementId: presse.id })).status, 400, 'copie vers une autre machine refusée');
    assert.equal((await resp.ok('POST', `/api/preventif/${autre.id}/dupliquer`, {})).equipementId, remplisseuse.id);
  });

  test('références du formulaire : indicateurs des pièces dédiées (équipements autorisés, utilisable pour ?equipementId)', async () => {
    const r = await resp.ok('GET', '/api/preventif-references');
    const d = r.articles.find((a) => a.id === dediee.id);
    assert.equal(d.reservee, true);
    assert.deepEqual(d.reserveeA, ['Ligne 1']);
    assert.deepEqual(d.equipementsAutorisesIds.slice().sort((x, y) => x - y), [ligne.id, remplisseuse.id].sort((x, y) => x - y));
    const m = r.articles.find((a) => a.id === dedieeMaint.id);
    assert.deepEqual(m.reserveeA, [], 'équipement hors périmètre non nommé');
    assert.equal(m.reserveeHorsPerimetre, 1);
    assert.deepEqual(m.equipementsAutorisesIds, []);
    assert.equal(r.articles.find((a) => a.id === libre.id).equipementsAutorisesIds, null, 'pièce libre');
    const pourPresse = await resp.ok('GET', `/api/preventif-references?equipementId=${presse.id}`);
    assert.equal(pourPresse.articles.find((a) => a.id === dediee.id).utilisable, false);
    assert.match(pourPresse.articles.find((a) => a.id === dediee.id).raison, /ne peut pas être utilisée sur Presse 250 t/);
    assert.equal(pourPresse.articles.find((a) => a.id === libre.id).utilisable, true);
    const pourRemp = await resp.ok('GET', `/api/preventif-references?equipementId=${remplisseuse.id}`);
    assert.equal(pourRemp.articles.find((a) => a.id === dediee.id).utilisable, true);
  });

  test('génération : les pièces prévues de l\'OT généré portent les indicateurs', async () => {
    const p = await resp.ok('POST', '/api/preventif', plan({ nom: 'Plan généré', equipementId: remplisseuse.id, pieces: [{ articleId: dediee.id, quantite: 1 }] }));
    const r = await admin.ok('POST', `/api/preventif/${p.id}/generer`, {});
    const ot = await admin.ok('GET', '/api/ot/' + r.ot.id);
    assert.equal(ot.piecesPrevues.length, 1);
    assert.equal(ot.piecesPrevues[0].reservee, true);
    assert.equal(ot.piecesPrevues[0].utilisable, true);
  });
});

describe('Maintenance préventive : plan devenu non conforme (pièce dédiée)', () => {
  let srv, admin, PROD, uResp;
  let ligne, remplisseuse, moteur, presse;
  const eq = (numero, nom, parentId = null) => srv.db.insert('equipements', { numero, nom, parentId, secteurId: PROD, actif: true, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', documents: [], champs: {}, compteur: { valeur: 0, unite: 'heures' }, compteurReleves: [], createdBy: 1 });
  const plan = (nom, equipementId, pieces) => admin.ok('POST', '/api/preventif', { nom, equipementId, periodicite: { type: 'mois', valeur: 1 }, gamme: [{ libelle: 'Contrôle', duree: 1 }], pieces, technicienId: uResp.id });

  before(async () => {
    srv = await demarrer();
    const cfg = srv.db.getConfig(); cfg.preventif = Object.assign({}, cfg.preventif, { genererAuto: false }); srv.db.setConfig(cfg);
    admin = srv.client(); await admin.login('admin', 'admin');
    PROD = (await admin.ok('GET', '/api/secteurs')).find((s) => s.code === 'PROD').id;
    const profils = await admin.ok('GET', '/api/profils');
    uResp = await admin.ok('POST', '/api/utilisateurs', { login: 'resp.nc', nom: 'Responsable', prenom: 'Nina', profilId: profils.find((p) => p.nom === 'Technicien').id, secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false });
    ligne = eq('EQ-NC1', 'Ligne de conditionnement');
    remplisseuse = eq('EQ-NC2', 'Remplisseuse', ligne.id);
    moteur = eq('EQ-NC3', 'Moteur de la remplisseuse', remplisseuse.id);
    presse = eq('EQ-NC4', 'Presse hydraulique');
  });
  after(async () => { await srv.stop(); });

  test('pièce devenue dédiée à une autre machine : plan signalé, OT généré sans la pièce, rapport et responsable prévenus', async () => {
    const piece = await admin.ok('POST', '/api/articles', { code: 'NC-1', designation: 'Joint devenu dédié', quantite: 10 });
    const libre = await admin.ok('POST', '/api/articles', { code: 'NC-2', designation: 'Graisse', quantite: 10 });
    const pl = await plan('Plan presse', presse.id, [{ articleId: piece.id, quantite: 2 }, { articleId: libre.id, quantite: 1 }]);
    assert.deepEqual((await admin.ok('GET', '/api/preventif/' + pl.id)).piecesNonAutorisees, [], 'plan conforme');
    await admin.ok('PUT', '/api/articles/' + piece.id, { reservee: true, equipementIds: [remplisseuse.id] });
    const fiche = await admin.ok('GET', '/api/preventif/' + pl.id);
    assert.deepEqual(fiche.piecesNonAutorisees.map((x) => x.articleId), [piece.id]);
    assert.match(fiche.piecesNonAutorisees[0].raison, /ne peut pas être utilisée sur Presse hydraulique \(EQ-NC4\)/);
    assert.deepEqual((await admin.ok('GET', '/api/preventif')).find((p) => p.id === pl.id).piecesNonAutorisees.map((x) => x.code), ['NC-1'], 'liste des plans');
    const n0 = srv.db.list('notifications').length;
    const g = await admin.ok('POST', `/api/preventif/${pl.id}/generer`, {});
    assert.match(g.avertissements[0], /pièce\(s\) prévue\(s\) non reprise\(s\).*NC-1 — Joint devenu dédié/);
    const ot = await admin.ok('GET', '/api/ot/' + g.ot.id);
    assert.deepEqual(ot.piecesPrevues.map((x) => x.articleId), [libre.id], 'pièce dédiée non autorisée non reprise');
    assert.ok(ot.historique.some((h) => h.action === 'piecesPrevues' && /NC-1/.test(h.commentaire)));
    assert.ok(srv.db.list('notifications').slice(n0).some((n) => n.userId === uResp.id && /pièces prévues non reprises/.test(n.titre)), 'responsable du plan prévenu');
    assert.match(srv.db.list('audit', (x) => x.entite === 'plansPreventifs' && x.entiteId === pl.id).pop().details, /pièce\(s\) prévue\(s\) non reprise\(s\)/);
  });

  test('équipement du plan déplacé sous une autre machine : génération groupée sans la pièce, avertissement dans le rapport', async () => {
    const piece = await admin.ok('POST', '/api/articles', { code: 'NC-3', designation: 'Capteur de la remplisseuse', quantite: 10, reservee: true, equipementIds: [remplisseuse.id] });
    const pl = await plan('Plan moteur', moteur.id, [{ articleId: piece.id, quantite: 1 }]);
    await admin.ok('PUT', '/api/equipements/' + moteur.id, { parentId: presse.id });
    try {
      assert.equal((await admin.ok('GET', '/api/preventif/' + pl.id)).piecesNonAutorisees.length, 1, 'plan signalé');
      const rapport = srv.ctx.services.preventif.genererRapport({ planIds: [pl.id], force: true });
      assert.equal(rapport.ots.length, 1);
      assert.equal(rapport.avertissements.length, 1);
      assert.deepEqual(rapport.avertissements[0].pieces.map((x) => x.code), ['NC-3']);
      assert.deepEqual(srv.db.get('ot', rapport.ots[0].id).piecesPrevues, [], 'pièce non reprise');
    } finally { await admin.ok('PUT', '/api/equipements/' + moteur.id, { parentId: remplisseuse.id }); }
  });

  test('identifiant de l\'équipement du plan : écriture décimale seulement', async () => {
    for (const v of [[presse.id], `0x${presse.id.toString(16)}`, true]) {
      const r = await admin.post('/api/preventif', { nom: 'Plan identifiant invalide', equipementId: v, periodicite: { type: 'mois', valeur: 1 } });
      assert.equal(r.status, 400, JSON.stringify(v));
      assert.match(r.body.erreur, /identifiant invalide/);
    }
  });

  test('génération depuis le planning : même règle', async () => {
    const piece = await admin.ok('POST', '/api/articles', { code: 'NC-4', designation: 'Filtre libre puis dédié', quantite: 10 });
    const pl = await plan('Plan presse planning', presse.id, [{ articleId: piece.id, quantite: 1 }]);
    await admin.ok('PUT', '/api/articles/' + piece.id, { reservee: true, equipementIds: [remplisseuse.id] });
    const r = await admin.post(`/api/planning/preventif/${pl.id}/generer`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ot = srv.db.list('ot', (o) => o.planPreventifId === pl.id).pop();
    assert.deepEqual(ot.piecesPrevues, [], 'pièce non reprise');
  });
});
