'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

/**
 * Tests du module Rapports & historique : robustesse sur base vide (aucun NaN), validation des paramètres,
 * exactitude des indicateurs sur un jeu de données maîtrisé (mars 2025), droits (403), portée par secteur,
 * filtres, historique, fiche de vie, exports CSV (audit, événement), service publié, données de démonstration.
 */
const pad = (n) => String(n).padStart(2, '0');
const jourLocal = (decalage = 0) => { const d = new Date(); d.setDate(d.getDate() + decalage); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const jourDe = (iso) => { if (!iso) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** Horodatage ISO d'une heure locale de 2025. */
const t = (mois, jour, h = 0, mi = 0) => new Date(2025, mois - 1, jour, h, mi).toISOString();
const MARS = 'du=2025-03-01&au=2025-03-31';
const proche = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.051, `${msg || ''} : ${a} ≠ ${b}`);

/** Vérifie récursivement qu'aucun nombre n'est NaN ou infini. */
function sansNaN(v, chemin = '') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `valeur non finie en ${chemin}`);
  else if (Array.isArray(v)) v.forEach((x, i) => sansNaN(x, `${chemin}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) sansNaN(x, `${chemin}.${k}`);
}
function lignesCsv(texte) { return String(texte).replace(/^\uFEFF/, '').split('\r\n'); }

describe('Rapports & historique', () => {
  let srv, admin, chefProd, chefSansExport, technicien, lecteur;
  let PROD, LOG, presse, chariot, tech1, tech2, chef;
  const ots = {};
  const evenements = [];
  let seq = 0;

  /** Insère un OT (coûts calculés avec le taux horaire par défaut de 45 €/h) avec sa date de création. */
  function ot(cle, champs) {
    seq++;
    const rec = Object.assign({
      numero: `OT-T${pad(seq)}`, titre: `OT de test ${cle}`, description: '', typeCode: 'correctif', prioriteCode: 'normale', statut: 'termine',
      equipementId: null, secteurId: null, demandeId: null, planPreventifId: null, technicienId: null, techniciens: [], datePrevue: null,
      dateDebut: null, dateFin: null, dureeEstimee: null, tempsPasse: [], pieces: [], causeCode: null, rapport: 'Intervention réalisée', commentaires: [],
      documents: [], coutExterne: 0, fournisseurId: null, taches: [], cloturePar: null, dateCloture: null, champs: {}, historique: [], createdBy: 1,
    }, champs);
    const heures = rec.tempsPasse.reduce((s, x) => s + x.heures, 0);
    rec.coutMainOeuvre = heures * 45;
    rec.coutPieces = rec.pieces.reduce((s, p) => s + p.quantite * p.prixUnitaire, 0);
    rec.coutTotal = rec.coutMainOeuvre + rec.coutPieces + rec.coutExterne;
    const { createdAt, ...reste } = rec;
    const o = srv.db.insert('ot', reste);
    const brut = srv.db.data.collections.ot.find((x) => x.id === o.id);
    brut.createdAt = createdAt;
    ots[cle] = brut;
    return brut;
  }
  function demande(champs) {
    const { createdAt, ...reste } = Object.assign({ numero: `DI-T${++seq}`, titre: 'Demande de test', description: '', prioriteCode: 'normale', typeCode: 'correctif', statut: 'soumise', demandeurId: 1, validateurId: null, dateValidation: null, motifRefus: '', otId: null, arretProduction: false, commentaires: [], pieceJointes: [], historique: [], champs: {}, createdBy: 1 }, champs);
    const d = srv.db.insert('demandes', reste);
    if (createdAt) srv.db.data.collections.demandes.find((x) => x.id === d.id).createdAt = createdAt;
    return d;
  }

  before(async () => {
    srv = await demarrer();
    srv.ctx.on('rapports:export', (d) => evenements.push(d));
    admin = srv.client(); await admin.login('admin', 'admin');
    const profils = await admin.ok('GET', '/api/profils');
    const p = (n) => profils.find((x) => x.nom === n).id;
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;
    const mk = (b) => admin.ok('POST', '/api/utilisateurs', Object.assign({ password: 'test1234', doitChangerMdp: false }, b));
    tech1 = await mk({ login: 'tech1', nom: 'Martin', prenom: 'Théo', profilId: p('Technicien'), secteurIds: [PROD] });
    tech2 = await mk({ login: 'tech2', nom: 'Durand', prenom: 'Léa', profilId: p('Technicien'), secteurIds: [LOG] });
    chef = await mk({ login: 'chefprod', nom: 'Chef', prenom: 'Paul', profilId: p('Chef de secteur'), secteurIds: [PROD] });
    await mk({ login: 'chefnoexp', nom: 'Chef', prenom: 'Sans export', profilId: p('Chef de secteur'), secteurIds: [PROD], overrides: { rapports: { exporter: false } } });
    await mk({ login: 'lecteur', nom: 'Lecteur', prenom: 'Lou', profilId: p('Demandeur'), secteurIds: [PROD], overrides: { rapports: { voir: true } } });

    presse = srv.db.insert('equipements', { numero: 'EQ-R01', nom: 'Presse de test', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: PROD, actif: true, documents: [], champs: {}, compteur: { valeur: 1500, unite: 'heures' }, compteurReleves: [{ date: t(3, 15, 8), valeur: 1500, userId: 1, commentaire: '' }], historiqueEtats: [{ date: t(3, 10, 7), ancien: 'en_service', nouveau: 'arret', commentaire: 'Panne hydraulique', userId: 1 }], valeurAchat: 10000, createdBy: 1 });
    chariot = srv.db.insert('equipements', { numero: 'EQ-R02', nom: 'Chariot de test', typeCode: 'vehicule', etatCode: 'en_service', criticiteCode: 'B', secteurId: LOG, actif: true, documents: [], champs: {}, dateMiseEnService: '2025-03-10', createdBy: 1 });

    const P = { equipementId: presse.id, secteurId: PROD };
    const C = { equipementId: chariot.id, secteurId: LOG };
    // OT de mars 2025 (voir les valeurs attendues dans les tests)
    ot('A', Object.assign({}, P, { prioriteCode: 'haute', createdAt: t(3, 3, 8), dateDebut: t(3, 3, 9), dateFin: t(3, 3, 12), technicienId: tech1.id, techniciens: [tech1.id], tempsPasse: [{ userId: tech1.id, date: '2025-03-03', heures: 3 }], pieces: [{ articleId: null, designation: 'Joint', quantite: 1, prixUnitaire: 50, date: t(3, 3, 10) }], causeCode: 'usure' }));
    ot('B', Object.assign({}, P, { prioriteCode: 'urgente', createdAt: t(3, 10, 6), dateDebut: t(3, 10, 7), dateFin: t(3, 10, 13), technicienId: tech1.id, techniciens: [tech1.id], tempsPasse: [{ userId: tech1.id, date: '2025-03-10', heures: 6 }], coutExterne: 300, causeCode: 'electrique' }));
    ot('C', Object.assign({}, P, { typeCode: 'preventif', createdAt: t(2, 20, 9), datePrevue: '2025-03-05', dateDebut: t(3, 5, 8), dateFin: t(3, 5, 10), technicienId: tech1.id, techniciens: [tech1.id], tempsPasse: [{ userId: tech1.id, date: '2025-03-05', heures: 2 }] }));
    ot('D', Object.assign({}, C, { createdAt: t(3, 12, 10), dateDebut: t(3, 12, 11), dateFin: t(3, 13, 11), technicienId: tech2.id, techniciens: [tech2.id], tempsPasse: [{ userId: tech2.id, date: '2025-03-12', heures: 4 }, { userId: tech2.id, date: '2025-03-13', heures: 2 }], pieces: [{ articleId: null, designation: 'Bandage', quantite: 2, prixUnitaire: 20, date: t(3, 12, 12) }], causeCode: 'casse' }));
    ot('E', Object.assign({}, P, { statut: 'en_cours', createdAt: t(3, 20, 9), dateDebut: t(3, 20, 10), technicienId: tech1.id, techniciens: [tech1.id], tempsPasse: [{ userId: tech1.id, date: '2025-03-20', heures: 1.5 }], rapport: '' }));
    ot('F', Object.assign({}, C, { prioriteCode: 'basse', statut: 'annule', createdAt: t(3, 25, 9), dateFin: t(3, 26, 9), technicienId: tech2.id, techniciens: [tech2.id], rapport: '' }));
    ot('G', Object.assign({}, P, { typeCode: 'preventif', statut: 'planifie', createdAt: t(3, 28, 9), datePrevue: '2025-04-02', technicienId: tech1.id, techniciens: [tech1.id], rapport: '' }));
    ot('H', Object.assign({}, P, { createdAt: t(4, 2, 8), dateDebut: t(4, 2, 9), dateFin: t(4, 2, 11), technicienId: tech1.id, techniciens: [tech1.id], tempsPasse: [{ userId: tech1.id, date: '2025-04-02', heures: 2 }] }));
    ot('I', Object.assign({}, C, { createdAt: t(2, 26, 15), dateDebut: t(2, 27, 8), dateFin: t(3, 2, 9), technicienId: tech2.id, techniciens: [tech2.id], tempsPasse: [{ userId: tech2.id, date: '2025-02-27', heures: 2 }, { userId: tech2.id, date: '2025-03-02', heures: 1 }], coutExterne: 100 }));

    // Demandes
    demande({ secteurId: PROD, equipementId: presse.id, statut: 'convertie', dateDemande: t(3, 3, 7), dateValidation: t(3, 3, 8), validateurId: 1, otId: ots.A.id, arretProduction: true });
    demande({ secteurId: PROD, equipementId: presse.id, statut: 'convertie', dateDemande: t(3, 10, 3), dateValidation: t(3, 10, 6), validateurId: 1, otId: ots.B.id });
    demande({ secteurId: LOG, equipementId: chariot.id, statut: 'refusee', dateDemande: t(3, 15, 10), dateValidation: t(3, 16, 10), validateurId: 1, motifRefus: 'Hors périmètre' });
    demande({ secteurId: LOG, statut: 'soumise', dateDemande: t(3, 20, 10) });
    demande({ secteurId: LOG, statut: 'soumise', dateDemande: t(4, 5, 10) });

    // Stock
    const art1 = srv.db.insert('articles', { code: 'ART-R1', designation: 'Joint torique', quantite: 10, seuilMin: 2, prixUnitaire: 5, uniteCode: 'u', actif: true, equipementIds: [] });
    const art2 = srv.db.insert('articles', { code: 'ART-R2', designation: 'Bandage plein', quantite: -2, seuilMin: 0, prixUnitaire: 10, uniteCode: 'u', actif: true, equipementIds: [] });
    srv.db.insert('articles', { code: 'ART-R3', designation: 'Article inactif', quantite: 100, seuilMin: 0, prixUnitaire: 1, uniteCode: 'u', actif: false, equipementIds: [] });
    const mv = (o) => srv.db.insert('mouvementsStock', Object.assign({ quantiteAvant: 0, quantiteApres: 0, userId: 1, motif: '' }, o));
    mv({ articleId: art1.id, type: 'sortie', quantite: 3, prixUnitaire: 5, otId: ots.A.id, date: t(3, 3, 10) });
    mv({ articleId: art1.id, type: 'retour', quantite: 1, prixUnitaire: 5, otId: ots.A.id, date: t(3, 4, 10) });
    mv({ articleId: art1.id, type: 'entree', quantite: 10, prixUnitaire: 5, otId: null, date: t(3, 5, 10) });
    mv({ articleId: art2.id, type: 'sortie', quantite: 2, prixUnitaire: 10, otId: ots.D.id, date: t(3, 12, 12) });
    mv({ articleId: art1.id, type: 'sortie', quantite: 1, prixUnitaire: 5, otId: null, date: t(2, 15, 10) });

    chefProd = srv.client(); await chefProd.login('chefprod', 'test1234');
    chefSansExport = srv.client(); await chefSansExport.login('chefnoexp', 'test1234');
    technicien = srv.client(); await technicien.login('tech1', 'test1234');
    lecteur = srv.client(); await lecteur.login('lecteur', 'test1234');
  });
  after(async () => { await srv.stop(); });

  // ----- Robustesse et validation ---------------------------------------------------------------
  test('base vide : synthèse, historique et exports sans NaN ni division par zéro', async () => {
    const vide = await demarrer();
    try {
      const c = vide.client(); await c.login('admin', 'admin');
      const s = await c.ok('GET', '/api/rapports/synthese');
      sansNaN(s);
      assert.ok(!JSON.stringify(s).includes('NaN'));
      const annee = jourLocal().slice(0, 4);
      assert.equal(s.periode.du, `${annee}-01-01`, 'période par défaut : année en cours');
      assert.equal(s.periode.au, jourLocal());
      assert.equal(s.ot.total, 0);
      assert.equal(s.ot.tauxPreventif, 0);
      assert.equal(s.ot.respectDelais, 0);
      assert.equal(s.ot.mttrHeures, 0);
      assert.equal(s.ot.dureeMoyenneHeures, 0);
      assert.deepEqual(s.ot.parTechnicien, []);
      assert.ok(s.ot.parStatut.length >= 6 && s.ot.parStatut.every((x) => x.nb === 0));
      assert.equal(s.demandes.total, 0);
      assert.equal(s.demandes.tauxRefus, 0);
      assert.equal(s.demandes.delaiMoyenValidationHeures, 0);
      assert.equal(s.couts.total, 0);
      assert.equal(s.couts.parMois.length, Number(jourLocal().slice(5, 7)), 'un mois par mois de la période');
      assert.ok(s.couts.parMois.every((m) => m.total === 0));
      assert.equal(s.stock.valeur, 0);
      assert.deepEqual(s.stock.consommationTop10, []);
      assert.deepEqual(s.equipements.nbPannes, []);
      assert.deepEqual(s.equipements.disponibilite, []);
      assert.deepEqual(s.acces, { ot: true, demandes: true, stock: true, preventif: true, equipements: true, exporter: true, exporterOt: true, exporterStock: true });
      sansNaN(await c.ok('GET', '/api/rapports/synthese?du=2024-01-01&au=2024-12-31&technicienId=1'));
      assert.deepEqual(await c.ok('GET', '/api/rapports/historique'), []);
      const refs = await c.ok('GET', '/api/rapports/references');
      assert.deepEqual(refs.equipements, []);
      assert.deepEqual(refs.techniciens, []);
      for (const type of ['historique', 'equipements', 'techniciens', 'couts', 'stock', 'synthese']) {
        const r = await c.get(`/api/rapports/export?type=${type}`);
        assert.equal(r.status, 200, type);
        assert.ok(!String(r.body).includes('NaN'), type);
      }
      // Équipement sans aucune intervention
      const e = vide.db.insert('equipements', { numero: 'EQ-V1', nom: 'Machine neuve', secteurId: null, actif: true, documents: [], champs: {} });
      const f = await c.ok('GET', `/api/rapports/equipement/${e.id}`);
      sansNaN(f);
      assert.equal(f.totaux.nbOt, 0);
      assert.equal(f.totaux.mtbfJours, 0);
      assert.equal(f.totaux.ratioCoutValeur, 0);
      assert.deepEqual(f.ot, []);
    } finally { await vide.stop(); }
  });

  test('validation des paramètres : dates, filtres, type d\'export, identifiants', async () => {
    const cas = [
      ['/api/rapports/synthese?du=2025-13-01', /date de début/i],
      ['/api/rapports/synthese?au=31/03/2025', /date de fin/i],
      ['/api/rapports/synthese?du=2025-02-30', /invalide/i],
      ['/api/rapports/synthese?du=2025-04-01&au=2025-03-01', /précéder/i],
      ['/api/rapports/synthese?du=2000-01-01&au=2025-01-01', /dix ans/i],
      ['/api/rapports/synthese?secteurId=99999', /secteur introuvable/i],
      ['/api/rapports/synthese?secteurId=abc', /identifiant invalide/i],
      ['/api/rapports/synthese?equipementId=99999', /équipement introuvable/i],
      ['/api/rapports/synthese?technicienId=99999', /technicien introuvable/i],
      ['/api/rapports/historique?du=hier', /date de début/i],
      ['/api/rapports/export?type=inconnu', /type d'export inconnu/i],
      ['/api/rapports/export', /type d'export inconnu/i],
      ['/api/rapports/export?type=fiche', /équipement est obligatoire/i],
      ['/api/rapports/equipement/abc', /identifiant invalide/i],
    ];
    for (const [url, motif] of cas) {
      const r = await admin.get(url);
      assert.equal(r.status, 400, url);
      assert.match(r.body.erreur, motif, url);
    }
    assert.equal((await admin.get('/api/rapports/equipement/99999')).status, 404);
    // Date de début seule : la fin est aujourd'hui
    const s = await admin.ok('GET', '/api/rapports/synthese?du=2025-03-01');
    assert.equal(s.periode.au, jourLocal());
  });

  // ----- Indicateurs sur un jeu de données maîtrisé ----------------------------------------------------
  test('synthèse : volumes, statuts, types, secteurs, période et heures ouvrées', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    sansNaN(s);
    assert.deepEqual({ du: s.periode.du, au: s.periode.au, jours: s.periode.jours, joursOuvres: s.periode.joursOuvres, heuresOuvrees: s.periode.heuresOuvrees }, { du: '2025-03-01', au: '2025-03-31', jours: 31, joursOuvres: 21, heuresOuvrees: 168 });
    // OT créés en mars : A, B, D, E, F, G
    assert.equal(s.ot.total, 6);
    const nb = (rep, code) => (rep.find((x) => x.code === code) || { nb: 0 }).nb;
    assert.equal(nb(s.ot.parStatut, 'termine'), 3);
    assert.equal(nb(s.ot.parStatut, 'en_cours'), 1);
    assert.equal(nb(s.ot.parStatut, 'annule'), 1);
    assert.equal(nb(s.ot.parStatut, 'planifie'), 1);
    assert.equal(s.ot.parStatut.reduce((x, y) => x + y.nb, 0), s.ot.total);
    assert.equal(nb(s.ot.parType, 'correctif'), 5);
    assert.equal(nb(s.ot.parType, 'preventif'), 1);
    assert.equal(s.ot.parType.reduce((x, y) => x + y.nb, 0), s.ot.total);
    assert.equal(nb(s.ot.parPriorite, 'normale'), 3);
    assert.equal(s.ot.parPriorite.find((x) => x.code === 'urgente').delaiHeures, 4);
    assert.deepEqual(s.ot.parSecteur.map((x) => [x.secteurId, x.nb]), [[PROD, 4], [LOG, 2]]);
    assert.equal(s.ot.ouverts, 2);
    assert.equal(s.ot.annules, 1);
    // OT terminés en mars : A, B, C (créé en février), D, I (créé en février)
    assert.equal(s.ot.termines, 5);
  });

  test('synthèse : taux préventif, respect des délais, MTTR, durée moyenne, techniciens', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    assert.equal(s.ot.tauxPreventif, 20, '1 préventif (C) sur 5 terminés');
    // A 4 h ≤ 24 h ; B 7 h > 4 h ; C : délai compté depuis la date prévue (10 h ≤ 72 h) ; D 25 h ≤ 72 h ; I 90 h > 72 h
    assert.equal(s.ot.respectDelais, 60);
    assert.equal(s.ot.nbEvaluesDelai, 5);
    assert.equal(s.ot.nbDansDelai, 3);
    // Correctifs terminés : A 3 h, B 6 h, D 24 h, I 73 h
    proche(s.ot.mttrHeures, 26.5, 'MTTR');
    assert.equal(s.ot.nbCorrectifsTermines, 4);
    proche(s.ot.dureeMoyenneHeures, 21.6, 'durée moyenne');
    proche(s.ot.heuresTotal, 19.5, 'heures saisies en mars');
    const t1 = s.ot.parTechnicien.find((x) => x.userId === tech1.id);
    const t2 = s.ot.parTechnicien.find((x) => x.userId === tech2.id);
    assert.deepEqual({ nb: t1.nb, nbAffectes: t1.nbAffectes, heures: t1.heures }, { nb: 3, nbAffectes: 4, heures: 12.5 });
    assert.deepEqual({ nb: t2.nb, nbAffectes: t2.nbAffectes, heures: t2.heures }, { nb: 2, nbAffectes: 2, heures: 7 });
    assert.equal(t1.nom, 'Théo Martin');
    proche(t1.tauxOccupation, 7.4, 'occupation tech1');
    proche(t2.tauxOccupation, 4.2, 'occupation tech2');
    assert.equal(t1.heuresOuvrees, 168);
  });

  test('synthèse : coûts engagés (au prorata des dates), par secteur, équipement et mois', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    // MO : A 135 + B 270 + C 90 + D 270 + E 67,5 + I 45 (1 h sur 3 en mars) ; pièces : A 50 + D 40 ; externe : B 300 + I 100
    proche(s.couts.mainOeuvre, 877.5, 'main d\'œuvre');
    proche(s.couts.pieces, 90, 'pièces');
    proche(s.couts.externe, 400, 'externe');
    proche(s.couts.total, 1367.5, 'total');
    assert.deepEqual(s.couts.parSecteur.map((x) => [x.secteurId, x.total]), [[PROD, 912.5], [LOG, 455]]);
    assert.deepEqual(s.couts.parEquipement.map((x) => [x.equipementId, x.total]), [[presse.id, 912.5], [chariot.id, 455]]);
    assert.equal(s.couts.parMois.length, 1);
    assert.deepEqual(s.couts.parMois[0], { mois: '2025-03', libelle: 'mars 2025', pieces: 90, mainOeuvre: 877.5, externe: 400, total: 1367.5 });
    proche(s.couts.parType.reduce((x, y) => x + y.total, 0), s.couts.total, 'ventilation par type');
    // Février : seule la part de I et la sortie de février
    const fev = await admin.ok('GET', '/api/rapports/synthese?du=2025-02-01&au=2025-02-28');
    proche(fev.couts.mainOeuvre, 90, 'MO de février (I : 2 h)');
    assert.equal(fev.ot.total, 2, 'C et I créés en février');
    assert.equal(fev.ot.termines, 0);
    // Trimestre : MO de I complète, H (avril) incluse
    const t1 = await admin.ok('GET', '/api/rapports/synthese?du=2025-01-01&au=2025-04-30');
    proche(t1.couts.mainOeuvre, 877.5 + 90 + 90, 'MO du 1er janvier au 30 avril');
    assert.equal(t1.couts.parMois.length, 4);
  });

  test('synthèse : pannes, heures d\'arrêt, MTBF, MTTR et disponibilité par équipement', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    const obsPresse = (new Date(2025, 3, 1) - new Date(2025, 2, 1)) / 3600000;
    const obsChariot = (new Date(2025, 3, 1) - new Date(2025, 2, 10)) / 3600000; // mis en service le 10 mars
    const p = s.equipements.disponibilite.find((x) => x.equipementId === presse.id);
    const c = s.equipements.disponibilite.find((x) => x.equipementId === chariot.id);
    // Presse : pannes A, B, E (G est préventif) ; réparations terminées A (3 h) et B (6 h)
    assert.deepEqual({ nbOt: p.nbOt, nbPannes: p.nbPannes, heuresArret: p.heuresArret, mttrHeures: p.mttrHeures }, { nbOt: 4, nbPannes: 3, heuresArret: 9, mttrHeures: 4.5 });
    proche(p.mtbfJours, (obsPresse - 9) / 3 / 24, 'MTBF presse');
    proche(p.tauxDisponibilite, ((obsPresse - 9) / obsPresse) * 100, 'disponibilité presse');
    proche(p.cout, 912.5, 'coût presse');
    // Chariot : panne D (F annulé) ; réparations D (24 h) et I (73 h, créé en février)
    assert.deepEqual({ nbOt: c.nbOt, nbPannes: c.nbPannes, heuresArret: c.heuresArret, mttrHeures: c.mttrHeures }, { nbOt: 2, nbPannes: 1, heuresArret: 97, mttrHeures: 48.5 });
    proche(c.mtbfJours, (obsChariot - 97) / 24, 'MTBF chariot');
    assert.equal(s.equipements.totalPannes, 4);
    assert.deepEqual(s.equipements.nbPannes.map((x) => [x.equipementId, x.nbPannes]), [[presse.id, 3], [chariot.id, 1]]);
  });

  test('synthèse : demandes (délai de validation, taux de refus) et stock (valeur, consommation)', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    assert.equal(s.demandes.total, 4);
    assert.equal(s.demandes.nbDecidees, 3);
    proche(s.demandes.delaiMoyenValidationHeures, (1 + 3 + 24) / 3, 'délai de validation');
    proche(s.demandes.tauxRefus, 33.3, 'taux de refus');
    assert.equal(s.demandes.nbConverties, 2);
    assert.equal(s.demandes.nbArretProduction, 1);
    assert.equal(s.demandes.parStatut.reduce((x, y) => x + y.nb, 0), 4);
    // Stock : valeur des articles actifs (quantité négative non valorisée), mouvements de mars
    assert.equal(s.stock.valeur, 50);
    assert.equal(s.stock.nbArticles, 2);
    assert.equal(s.stock.nbSousSeuil, 1);
    assert.equal(s.stock.nbMouvements, 4);
    assert.equal(s.stock.nbSorties, 2);
    assert.deepEqual(s.stock.consommationTop10.map((x) => [x.designation, x.quantite, x.montant]), [['Bandage plein', 2, 20], ['Joint torique', 2, 10]]);
    assert.equal(s.stock.montantConsomme, 30);
    // Filtre secteur : seules les sorties imputées aux OT du secteur
    const sp = await admin.ok('GET', `/api/rapports/synthese?${MARS}&secteurId=${PROD}`);
    assert.equal(sp.stock.nbMouvements, 2);
    assert.deepEqual(sp.stock.consommationTop10.map((x) => [x.designation, x.quantite]), [['Joint torique', 2]]);
  });

  test('filtres : secteur (sous-secteurs inclus), équipement, technicien', async () => {
    const parSecteur = await admin.ok('GET', `/api/rapports/synthese?${MARS}&secteurId=${LOG}`);
    assert.equal(parSecteur.ot.total, 2);
    assert.equal(parSecteur.filtres.secteurId, LOG);
    assert.match(parSecteur.filtres.secteurNom, /Logistique/);
    proche(parSecteur.couts.total, 455);
    assert.equal(parSecteur.demandes.total, 2);
    // Le site racine inclut ses sous-secteurs
    const site = srv.db.findOne('secteurs', (x) => x.code === 'SITE');
    assert.equal((await admin.ok('GET', `/api/rapports/synthese?${MARS}&secteurId=${site.id}`)).ot.total, 6);
    assert.equal((await admin.ok('GET', `/api/rapports/synthese?${MARS}&secteurId=aucun`)).ot.total, 0);
    const parEq = await admin.ok('GET', `/api/rapports/synthese?${MARS}&equipementId=${presse.id}`);
    assert.equal(parEq.ot.total, 4);
    assert.equal(parEq.filtres.equipementNom, 'Presse de test');
    const parTech = await admin.ok('GET', `/api/rapports/synthese?${MARS}&technicienId=${tech2.id}`);
    assert.equal(parTech.ot.total, 2, 'D et F');
    assert.equal(parTech.ot.termines, 2, 'D et I');
    assert.deepEqual(parTech.ot.parTechnicien.map((x) => x.userId), [tech2.id]);
    proche(parTech.ot.heuresTotal, 7);
    assert.equal(parTech.demandes.total, 0, 'aucune demande liée aux OT de ce technicien');
    const parTech1 = await admin.ok('GET', `/api/rapports/synthese?${MARS}&technicienId=${tech1.id}`);
    assert.equal(parTech1.demandes.total, 2, 'demandes converties en OT A et B');
  });

  // ----- Historique et fiche de vie ---------------------------------------------------------------------
  test('historique : OT clôturés de la période, du plus récent au plus ancien', async () => {
    const h = await admin.ok('GET', `/api/rapports/historique?${MARS}`);
    assert.deepEqual(h.map((x) => x.titre.slice(-1)), ['F', 'D', 'B', 'C', 'A', 'I']);
    const a = h.find((x) => x.id === ots.A.id);
    assert.equal(a.equipementNom, 'Presse de test');
    assert.equal(a.equipementNumero, 'EQ-R01');
    assert.equal(a.statutLibelle, 'Terminé');
    assert.equal(a.technicienNom, 'Théo Martin');
    assert.equal(a.heures, 3);
    assert.equal(a.dureeHeures, 3);
    assert.equal(a.coutTotal, 185);
    assert.equal(a.causeLibelle, 'Usure');
    assert.equal(a.dansDelai, true);
    assert.equal(h.find((x) => x.id === ots.B.id).dansDelai, false);
    assert.equal(h.find((x) => x.id === ots.F.id).annule, true);
    assert.ok(a.secteurChemin.includes('Production'));
    assert.equal((await admin.ok('GET', `/api/rapports/historique?${MARS}&annules=0`)).length, 5);
    assert.equal((await admin.ok('GET', `/api/rapports/historique?${MARS}&typeCode=preventif`)).length, 1);
    assert.equal((await admin.ok('GET', `/api/rapports/historique?${MARS}&secteurId=${LOG}`)).length, 3);
    // Recherche plein texte (accents et casse ignorés, tous les termes)
    assert.deepEqual((await admin.ok('GET', `/api/rapports/historique?${MARS}&recherche=${encodeURIComponent('THEO presse')}`)).map((x) => x.titre.slice(-1)).sort(), ['A', 'B', 'C']);
    assert.deepEqual((await admin.ok('GET', `/api/rapports/historique?${MARS}&recherche=${encodeURIComponent('usure')}`)).map((x) => x.titre.slice(-1)), ['A']);
    assert.equal(lignesCsv((await admin.get(`/api/rapports/export?type=historique&${MARS}&recherche=chariot`)).body).length - 1, 3, 'export filtré par la recherche');
    assert.equal((await admin.ok('GET', '/api/rapports/historique?du=2025-04-01&au=2025-04-30')).length, 1, 'H');
  });

  test('fiche de vie : OT chronologiques, totaux cumulés, compteur, états, période optionnelle', async () => {
    const f = await admin.ok('GET', `/api/rapports/equipement/${presse.id}`);
    sansNaN(f);
    assert.equal(f.equipement.nom, 'Presse de test');
    assert.equal(f.equipement.numero, 'EQ-R01');
    // A, B, C, E, G, H — ordre chronologique (date de fin, sinon début, date prévue)
    assert.deepEqual(f.ot.map((x) => x.titre.slice(-1)), ['A', 'C', 'B', 'E', 'G', 'H']);
    assert.equal(f.totaux.nbOt, 6);
    assert.equal(f.totaux.nbTermines, 4);
    assert.equal(f.totaux.nbOuverts, 2);
    assert.equal(f.totaux.nbPannes, 4, 'A, B, E, H');
    assert.equal(f.totaux.nbPreventifs, 2);
    proche(f.totaux.coutTotal, 185 + 570 + 90 + 67.5 + 90, 'coût cumulé');
    proche(f.totaux.heures, 3 + 6 + 2 + 1.5 + 2, 'heures cumulées');
    proche(f.totaux.mttrHeures, (3 + 6 + 2) / 3, 'MTTR');
    proche(f.totaux.ratioCoutValeur, pct(1002.5, 10000), 'ratio coût / valeur d\'achat');
    assert.ok(f.totaux.mtbfJours > 0);
    assert.equal(f.totaux.premiereIntervention, ots.A.dateFin);
    assert.equal(f.totaux.derniereIntervention, ots.H.dateFin);
    assert.deepEqual(f.parAnnee.map((x) => [x.annee, x.nbOt]), [['2025', 6]]);
    assert.ok(f.parCause.some((x) => x.code === 'usure' && x.nb === 1));
    assert.equal(f.compteur.valeur, 1500);
    assert.equal(f.compteur.releves.length, 1);
    assert.equal(f.etats.length, 1);
    assert.equal(f.ot.find((x) => x.id === ots.A.id).pieces[0].designation, 'Joint');
    assert.equal(f.ot.find((x) => x.id === ots.A.id).estPanne, true);
    assert.equal(f.periode, null);
    const mars = await admin.ok('GET', `/api/rapports/equipement/${presse.id}?${MARS}`);
    assert.deepEqual(mars.ot.map((x) => x.titre.slice(-1)), ['A', 'C', 'B', 'E']);
    assert.equal(mars.periode.du, '2025-03-01');
  });
  function pct(a, b) { return Math.round((a / b) * 1000) / 10; }

  test('fiche de vie : sous-équipements inclus sur demande', async () => {
    const moule = srv.db.insert('equipements', { numero: 'EQ-R03', nom: 'Moule de la presse', parentId: presse.id, secteurId: PROD, actif: true, documents: [], champs: {}, createdBy: 1 });
    ot('J', { equipementId: moule.id, secteurId: PROD, createdAt: t(3, 18, 8), dateDebut: t(3, 18, 9), dateFin: t(3, 18, 10), tempsPasse: [{ userId: tech1.id, date: '2025-03-18', heures: 1 }], technicienId: tech1.id });
    try {
      const sans = await admin.ok('GET', `/api/rapports/equipement/${presse.id}`);
      assert.equal(sans.ot.length, 6);
      assert.deepEqual(sans.equipement.sousEquipements.map((x) => x.nom), ['Moule de la presse']);
      const avec = await admin.ok('GET', `/api/rapports/equipement/${presse.id}?sousEquipements=1`);
      assert.equal(avec.ot.length, 7);
      assert.ok(avec.ot.some((x) => x.equipementNom === 'Moule de la presse'));
      // Synthèse filtrée sur la presse : sous-équipements inclus par défaut, exclus avec sousEquipements=0
      assert.equal((await admin.ok('GET', `/api/rapports/synthese?${MARS}&equipementId=${presse.id}`)).ot.total, 5);
      assert.equal((await admin.ok('GET', `/api/rapports/synthese?${MARS}&equipementId=${presse.id}&sousEquipements=0`)).ot.total, 4);
    } finally {
      srv.db.remove('ot', ots.J.id);
      srv.db.remove('equipements', moule.id);
    }
  });

  // ----- Droits et portée -----------------------------------------------------------------------------
  test('droits : 403 sans le droit rapports.voir, export réservé au droit exporter', async () => {
    for (const url of ['/api/rapports/synthese', '/api/rapports/historique', `/api/rapports/equipement/${presse.id}`, '/api/rapports/references', '/api/rapports/export?type=synthese']) {
      const r = await technicien.get(url);
      assert.equal(r.status, 403, url);
      assert.match(r.body.erreur, /Rapports/);
    }
    assert.equal((await chefSansExport.get(`/api/rapports/synthese?${MARS}`)).status, 200);
    const r = await chefSansExport.get(`/api/rapports/export?type=historique&${MARS}`);
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Exporter/);
    const s = await chefSansExport.ok('GET', `/api/rapports/synthese?${MARS}`);
    assert.equal(s.acces.exporter, false);
    // Non authentifié
    assert.equal((await srv.client().get('/api/rapports/synthese')).status, 401);
  });

  test('droits : les sections dont le module source n\'est pas consultable sont vides', async () => {
    const s = await lecteur.ok('GET', `/api/rapports/synthese?${MARS}`);
    sansNaN(s);
    assert.equal(s.acces.ot, false);
    assert.equal(s.acces.stock, false);
    assert.equal(s.acces.demandes, true);
    assert.equal(s.ot.total, 0);
    assert.equal(s.couts.total, 0);
    assert.equal(s.stock.valeur, 0);
    assert.deepEqual(s.equipements.disponibilite, []);
    assert.equal(s.demandes.total, 0, 'portée perso : aucune demande personnelle');
    const h = await lecteur.get(`/api/rapports/historique?${MARS}`);
    assert.equal(h.status, 403);
    assert.match(h.body.erreur, /Ordres de travail/);
    const f = await lecteur.ok('GET', `/api/rapports/equipement/${presse.id}`);
    assert.deepEqual(f.ot, []);
    assert.deepEqual(f.plans, []);
  });

  test('portée par secteur : un chef de secteur ne voit que les données de son secteur', async () => {
    const s = await chefProd.ok('GET', `/api/rapports/synthese?${MARS}`);
    sansNaN(s);
    assert.equal(s.ot.total, 4, 'A, B, E, G');
    assert.equal(s.ot.termines, 3, 'A, B, C');
    assert.deepEqual(s.ot.parSecteur.map((x) => x.secteurId), [PROD]);
    proche(s.couts.total, 912.5);
    assert.deepEqual(s.couts.parSecteur.map((x) => x.secteurId), [PROD]);
    assert.equal(s.demandes.total, 2);
    assert.ok(s.equipements.disponibilite.every((x) => x.equipementId === presse.id));
    assert.deepEqual(s.ot.parTechnicien.map((x) => x.userId), [tech1.id]);
    // Le filtre sur un secteur hors périmètre ne révèle rien
    const log = await chefProd.ok('GET', `/api/rapports/synthese?${MARS}&secteurId=${LOG}`);
    assert.equal(log.ot.total, 0);
    assert.equal(log.couts.total, 0);
    // Historique et fiche de vie
    const h = await chefProd.ok('GET', `/api/rapports/historique?${MARS}`);
    assert.deepEqual(h.map((x) => x.titre.slice(-1)).sort(), ['A', 'B', 'C']);
    assert.equal((await chefProd.get(`/api/rapports/equipement/${chariot.id}`)).status, 404);
    assert.equal((await chefProd.get(`/api/rapports/synthese?equipementId=${chariot.id}`)).status, 400);
    const refs = await chefProd.ok('GET', '/api/rapports/references');
    assert.deepEqual(refs.equipements.map((x) => x.id), [presse.id]);
    assert.deepEqual(refs.techniciens.map((x) => x.id), [tech1.id]);
    // Total cohérent avec la liste des OT visibles
    const liste = await chefProd.ok('GET', '/api/ot');
    assert.equal(s.ot.total, liste.filter((o) => jourDe(o.createdAt) >= '2025-03-01' && jourDe(o.createdAt) <= '2025-03-31').length);
  });

  // ----- Exports CSV ----------------------------------------------------------------------------------
  test('exports CSV : contenu, en-têtes, audit et événement', async () => {
    const attendus = { historique: ['Numéro', 6], equipements: ['MTBF (jours)', 2], techniciens: ['Taux d\'occupation (%)', 2], couts: ['Ventilation', 1 + 1 + 2 + 2 + 2], stock: ['Quantité consommée', 2], synthese: ['Indicateur', null] };
    for (const [type, [colonne, nbLignes]] of Object.entries(attendus)) {
      const r = await admin.get(`/api/rapports/export?type=${type}&${MARS}`);
      assert.equal(r.status, 200, type);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.match(r.headers.get('content-disposition'), new RegExp(`rapport-${type}-2025-03-01-au-2025-03-31\\.csv`));
      const lignes = lignesCsv(r.body);
      assert.ok(lignes[0].split(';').includes(colonne), `${type} : colonne ${colonne}`);
      if (nbLignes != null) assert.equal(lignes.length - 1, nbLignes, type);
      assert.ok(!String(r.body).includes('NaN'));
    }
    // BOM UTF-8 (Excel) : vérifié sur les octets bruts (fetch().text() le retire)
    const login = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'GMAO' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) });
    const octets = Buffer.from(await (await fetch(srv.base + `/api/rapports/export?type=couts&${MARS}`, { headers: { cookie: login.headers.get('set-cookie').split(';')[0], 'x-requested-with': 'GMAO' } })).arrayBuffer());
    assert.deepEqual([...octets.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8');
    const h = lignesCsv((await admin.get(`/api/rapports/export?type=historique&${MARS}`)).body);
    const ligneA = h.find((l) => l.startsWith(ots.A.numero + ';'));
    assert.ok(ligneA.includes(';185;') || ligneA.includes(';185,'), ligneA);
    assert.ok(ligneA.includes('03/03/2025'), 'dates au format configuré');
    const syn = lignesCsv((await admin.get(`/api/rapports/export?type=synthese&${MARS}`)).body);
    assert.ok(syn.includes('Ordres de travail;OT créés;6'));
    assert.ok(syn.includes('Coûts;Total;1367,5'));
    const fiche = await admin.get(`/api/rapports/export?type=fiche&equipementId=${presse.id}`);
    assert.equal(fiche.status, 200);
    assert.match(fiche.headers.get('content-disposition'), /rapport-fiche-EQ-R01\.csv/);
    assert.equal(lignesCsv(fiche.body).length - 1, 6);
    // Audit et événement
    const audits = srv.db.list('audit', (a) => a.entite === 'rapports' && a.action === 'export');
    assert.ok(audits.length >= 7);
    assert.ok(audits.some((a) => /Historique des interventions/.test(a.details) && /6 ligne/.test(a.details)));
    assert.ok(evenements.some((e) => e.type === 'historique' && e.lignes === 6 && e.du === '2025-03-01'));
    // Portée appliquée aux exports
    const chefH = lignesCsv((await chefProd.get(`/api/rapports/export?type=historique&${MARS}`)).body);
    assert.equal(chefH.length - 1, 3);
    // Lecteur sans accès aux OT
    assert.equal((await lecteur.get(`/api/rapports/export?type=equipements&${MARS}`)).status, 403);
  });

  // ----- Cohérence synthèse / fiche de vie, délais des demandes, droits d'export ------------------------------
  test('fiche de vie : sur une période, même fenêtre d\'observation que la synthèse (MTBF identique)', async () => {
    const s = await admin.ok('GET', `/api/rapports/synthese?${MARS}`);
    // Presse : mêmes pannes (A, B, E) et mêmes arrêts dans les deux écrans → même MTBF, fenêtre = la période entière
    const presseMars = await admin.ok('GET', `/api/rapports/equipement/${presse.id}?${MARS}`);
    const dp = s.equipements.disponibilite.find((x) => x.equipementId === presse.id);
    assert.deepEqual({ pannes: presseMars.totaux.nbPannes, arret: presseMars.totaux.heuresArret }, { pannes: dp.nbPannes, arret: dp.heuresArret });
    assert.equal(presseMars.totaux.mtbfJours, dp.mtbfJours, `MTBF presse : fiche ${presseMars.totaux.mtbfJours} / synthèse ${dp.mtbfJours}`);
    proche(presseMars.totaux.joursObserves, 31, 'période entière observée, même si le premier OT de la période est du 3 mars');
    // Chariot : fenêtre bornée par la mise en service du 10 mars (la fiche retient en plus l'OT I, terminé en mars)
    const chariotMars = await admin.ok('GET', `/api/rapports/equipement/${chariot.id}?${MARS}`);
    const obsChariot = (new Date(2025, 3, 1) - new Date(2025, 2, 10)) / 3600000;
    proche(chariotMars.totaux.joursObserves, 22, 'fenêtre bornée par la mise en service du 10 mars');
    proche(chariotMars.totaux.mtbfJours, (obsChariot - chariotMars.totaux.heuresArret) / chariotMars.totaux.nbPannes / 24, 'MTBF chariot sur la fenêtre de la synthèse');
    // Sans période (toute la durée de vie) : du premier OT connu (C, créé le 20 février) à maintenant
    const vie = await admin.ok('GET', `/api/rapports/equipement/${presse.id}`);
    assert.ok(Math.abs(vie.totaux.joursObserves - (Date.now() - new Date(2025, 1, 20, 9).getTime()) / 86400000) < 0.06, `durée de vie observée : ${vie.totaux.joursObserves}`);
    assert.ok(vie.totaux.mtbfJours > 0);
  });

  test('respect des délais : pour un OT issu d\'une demande, le délai court depuis le dépôt de la demande', async () => {
    const depot = new Date(Date.now() - 6 * 3600000).toISOString();
    const creation = new Date(Date.now() - 3600000).toISOString();
    const fin = new Date().toISOString();
    const base = { equipementId: presse.id, secteurId: PROD, prioriteCode: 'urgente', createdAt: creation, dateDebut: creation, dateFin: fin, technicienId: tech1.id, techniciens: [tech1.id] };
    const di = demande({ secteurId: PROD, equipementId: presse.id, statut: 'convertie', prioriteCode: 'urgente', dateDemande: depot, dateValidation: creation, validateurId: 1 });
    const lie = ot('K', Object.assign({}, base, { demandeId: di.id }));
    const seul = ot('L', Object.assign({}, base));
    const parOtId = ot('M', Object.assign({}, base));
    const di2 = demande({ secteurId: PROD, equipementId: presse.id, statut: 'convertie', prioriteCode: 'urgente', dateDemande: depot, dateValidation: creation, validateurId: 1, otId: parOtId.id });
    try {
      const q = `du=${jourLocal(-1)}&au=${jourLocal(1)}`;
      const h = await admin.ok('GET', `/api/rapports/historique?${q}`);
      assert.equal(h.find((x) => x.id === lie.id).dansDelai, false, '6 h depuis le dépôt de la demande > 4 h (urgente)');
      assert.equal(h.find((x) => x.id === seul.id).dansDelai, true, '1 h depuis la création ≤ 4 h');
      assert.equal(h.find((x) => x.id === parOtId.id).dansDelai, false, 'demande liée par son otId');
      // La demande elle-même est jugée depuis son dépôt par le module Demandes : même verdict
      const d = await admin.ok('GET', `/api/demandes/${di.id}`);
      assert.ok(d.echeance < creation, 'échéance de la demande dépassée avant même la création de l\'OT');
      const s = await admin.ok('GET', `/api/rapports/synthese?${q}`);
      assert.equal(s.ot.nbEvaluesDelai, 3);
      assert.equal(s.ot.nbDansDelai, 1);
    } finally {
      for (const o of [lie, seul, parOtId]) srv.db.remove('ot', o.id);
      srv.db.remove('demandes', di.id); srv.db.remove('demandes', di2.id);
    }
  });

  test('exports : le détail des OT exige ot.exporter, le stock stock.exporter ; la synthèse agrégée rapports.exporter seul', async () => {
    const profils = await admin.ok('GET', '/api/profils');
    const achId = profils.find((x) => x.nom === 'Acheteur / comptabilité').id;
    // Profil par défaut Acheteur / comptabilité : ot.voir, rapports.exporter et stock.exporter, sans ot.exporter
    await admin.ok('POST', '/api/utilisateurs', { login: 'acheteur', nom: 'Achats', prenom: 'Anne', profilId: achId, secteurIds: [PROD], password: 'test1234', doitChangerMdp: false });
    await admin.ok('POST', '/api/utilisateurs', { login: 'acheteur2', nom: 'Achats', prenom: 'Sans stock', profilId: achId, secteurIds: [PROD], password: 'test1234', doitChangerMdp: false, overrides: { stock: { exporter: false } } });
    const ach = srv.client(); await ach.login('acheteur', 'test1234');
    const ach2 = srv.client(); await ach2.login('acheteur2', 'test1234');
    assert.equal((await ach.get('/api/ot-export')).status, 403, 'le module OT refuse déjà l\'export à ce profil');
    const nbEvenements = evenements.length;
    for (const type of ['historique', 'equipements', 'techniciens', 'couts']) {
      const r = await ach.get(`/api/rapports/export?type=${type}&${MARS}`);
      assert.equal(r.status, 403, type);
      assert.match(r.body.erreur, /Ordres de travail › Exporter/);
    }
    const fiche = await ach.get(`/api/rapports/export?type=fiche&equipementId=${presse.id}`);
    assert.equal(fiche.status, 403);
    assert.match(fiche.body.erreur, /Ordres de travail › Exporter/);
    assert.equal(evenements.length, nbEvenements, 'aucun export réalisé');
    assert.equal((await ach.get(`/api/rapports/export?type=synthese&${MARS}`)).status, 200, 'synthèse agrégée : rapports.exporter suffit');
    assert.equal((await ach.get(`/api/rapports/export?type=stock&${MARS}`)).status, 200, 'consommation de pièces : stock.exporter');
    const st2 = await ach2.get(`/api/rapports/export?type=stock&${MARS}`);
    assert.equal(st2.status, 403);
    assert.match(st2.body.erreur, /Exporter/);
    const s = await ach.ok('GET', `/api/rapports/synthese?${MARS}`);
    assert.deepEqual({ exporter: s.acces.exporter, exporterOt: s.acces.exporterOt, exporterStock: s.acces.exporterStock }, { exporter: true, exporterOt: false, exporterStock: true });
    // Avec ot.exporter (chef de secteur), l'export détaillé reste possible dans sa portée
    assert.equal((await chefProd.get(`/api/rapports/export?type=historique&${MARS}`)).status, 200);
    assert.equal((await chefProd.ok('GET', `/api/rapports/synthese?${MARS}`)).acces.exporterOt, true);
  });

  // ----- Service publié et données de démonstration -------------------------------------------------------
  test('service ctx.services.rapports utilisable par les autres modules', async () => {
    const s = srv.ctx.services.rapports;
    assert.ok(s && typeof s.synthese === 'function');
    const syn = s.synthese(null, { du: '2025-03-01', au: '2025-03-31' });
    assert.equal(syn.ot.total, 6);
    assert.equal(s.historique(null, { du: '2025-03-01', au: '2025-03-31' }).length, 6);
    assert.equal(s.ficheVie(null, presse.id).totaux.nbOt, 6);
    assert.equal(s.periode({ du: '2025-03-01', au: '2025-03-31' }).joursOuvres, 21);
    assert.throws(() => s.periode({ du: 'x' }), /date de début/i);
  });

  test('données de démonstration : 12 mois d\'historique, indicateurs cohérents, idempotentes', async () => {
    const demo = await demarrer();
    try {
      const rapport = require('../server/modules').seedDemo(demo.ctx);
      assert.ok(rapport.every((x) => x.ok), JSON.stringify(rapport));
      const mod = demo.ctx.modules.find((m) => m.fichier === 'rapports.js');
      const nbOt = demo.db.count('ot');
      assert.equal(mod.seedDemo(demo.ctx), 'déjà présents');
      assert.equal(demo.db.count('ot'), nbOt, 'idempotent');
      const archives = demo.db.list('ot', (o) => o.origine === 'reprise');
      assert.ok(archives.length >= 50, `${archives.length} OT archivés`);
      assert.ok(archives.filter((o) => o.statut === 'termine').every((o) => o.rapport && o.tempsPasse.length && o.dateFin && o.cloturePar));
      assert.equal(new Set(demo.db.list('ot').map((o) => o.numero)).size, nbOt, 'numéros uniques');

      const c = demo.client(); await c.login('admin', 'admin');
      const du = jourLocal(-365), au = jourLocal(0);
      const s = await c.ok('GET', `/api/rapports/synthese?du=${du}&au=${au}`);
      sansNaN(s);
      const liste = await c.ok('GET', '/api/ot');
      const dansPeriode = (j) => j >= du && j <= au;
      assert.equal(s.ot.total, liste.filter((o) => dansPeriode(jourDe(o.createdAt))).length, 'total OT = OT visibles créés dans la période');
      assert.equal(s.ot.parStatut.reduce((x, y) => x + y.nb, 0), s.ot.total);
      assert.equal(s.ot.parSecteur.reduce((x, y) => x + y.nb, 0), s.ot.total);
      assert.ok(s.ot.tauxPreventif > 0 && s.ot.tauxPreventif < 100);
      assert.ok(s.ot.respectDelais > 0 && s.ot.respectDelais <= 100);
      assert.ok(s.ot.mttrHeures > 0);
      assert.ok(s.couts.total > 0);
      proche(s.couts.parMois.reduce((x, y) => x + y.total, 0), s.couts.total, 'Σ mois = total');
      proche(s.couts.parSecteur.reduce((x, y) => x + y.total, 0), s.couts.total, 'Σ secteurs = total');
      assert.ok(s.couts.parMois.filter((m) => m.total > 0).length >= 10, 'coûts répartis sur l\'année');
      assert.equal(s.couts.parEquipement.length, 10);
      assert.ok(s.equipements.nbPannes.length >= 5);
      assert.ok(s.equipements.disponibilite.every((x) => x.tauxDisponibilite >= 0 && x.tauxDisponibilite <= 100));
      assert.ok(s.demandes.total >= 10 && s.demandes.tauxRefus > 0);
      assert.ok(s.stock.valeur > 0 && s.stock.consommationTop10.length > 0);
      assert.ok(s.ot.parTechnicien.length >= 2 && s.ot.parTechnicien.every((x) => x.heures > 0));
      const termines = liste.filter((o) => o.final && dansPeriode(jourDe(o.dateFin || o.dateCloture)));
      assert.equal((await c.ok('GET', `/api/rapports/historique?du=${du}&au=${au}`)).length, termines.length);

      // Portée : un chef de secteur Production voit exactement ses OT
      const profils = await c.ok('GET', '/api/profils');
      const prod = demo.db.findOne('secteurs', (x) => x.code === 'PROD');
      await c.ok('POST', '/api/utilisateurs', { login: 'chefdemo', nom: 'Chef', prenom: 'Démo', profilId: profils.find((x) => x.nom === 'Chef de secteur').id, secteurIds: [prod.id], password: 'demo1234', doitChangerMdp: false });
      const chefDemo = demo.client(); await chefDemo.login('chefdemo', 'demo1234');
      const sc = await chefDemo.ok('GET', `/api/rapports/synthese?du=${du}&au=${au}`);
      const listeChef = await chefDemo.ok('GET', '/api/ot');
      assert.equal(sc.ot.total, listeChef.filter((o) => dansPeriode(jourDe(o.createdAt))).length);
      assert.ok(sc.ot.total > 0 && sc.ot.total < s.ot.total);

      // Fiche de vie de la remplisseuse : cohérente avec la liste des OT de l'équipement
      const eq = demo.db.findOne('equipements', (e) => e.nom === 'Remplisseuse rotative');
      const f = await c.ok('GET', `/api/rapports/equipement/${eq.id}`);
      sansNaN(f);
      assert.equal(f.totaux.nbOt, (await c.ok('GET', `/api/ot?equipementId=${eq.id}`)).length);
      assert.ok(f.totaux.nbPannes >= 4 && f.totaux.mtbfJours > 0 && f.totaux.mttrHeures > 0);
      assert.ok(f.plans.length >= 1, 'plan préventif de graissage');
      assert.ok(f.parAnnee.length >= 1);
    } finally { await demo.stop(); }
  });
});
