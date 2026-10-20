'use strict';
/**
 * Tests du module Stock & pièces détachées : CRUD des articles, validation, code automatique,
 * mouvements (entrée / sortie / inventaire / retour), stock insuffisant et stock négatif,
 * passage sous le seuil (événement + notifications), imputation à un OT, services publiés,
 * journal des mouvements, alertes, valorisation, exports CSV, droits (403), portée par secteur,
 * suppression / désactivation, données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Module Stock & pièces détachées', () => {
  let srv, admin, prod, maint, profils;
  let technicienProd, chefProd, demandeur, respProd;
  let skf, rexel, presse, convoyeur, autreSecteurEq;
  let roulement, courroie, huile;
  const evenements = [];

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    profils = await admin.ok('GET', '/api/profils');
    srv.ctx.on('stock:sousSeuil', (a) => evenements.push(a));

    skf = srv.db.insert('fournisseurs', { nom: 'SKF France', typeCode: 'fournisseur', actif: true, delaiLivraisonJours: 5 });
    rexel = srv.db.insert('fournisseurs', { nom: 'Rexel', typeCode: 'fournisseur', actif: true });
    presse = srv.db.insert('equipements', { numero: 'EQ-T01', nom: 'Presse hydraulique', secteurId: prod.id, actif: true, typeCode: 'machine' });
    convoyeur = srv.db.insert('equipements', { numero: 'EQ-T02', nom: 'Convoyeur', secteurId: prod.id, actif: true, typeCode: 'machine' });
    autreSecteurEq = srv.db.insert('equipements', { numero: 'EQ-T03', nom: 'Pont roulant', secteurId: maint.id, actif: true, typeCode: 'machine' });

    technicienProd = await creerUtilisateur('tech.prod', 'Technicien', [prod.id]);
    chefProd = await creerUtilisateur('chef.prod', 'Chef de secteur', [prod.id]);
    demandeur = await creerUtilisateur('demandeur', 'Demandeur', [prod.id]);
    respProd = await creerUtilisateur('resp.prod', 'Responsable maintenance', [prod.id], { porteeOverride: 'secteurs' });
  });
  after(async () => { await srv.stop(); });

  const profil = (nom) => profils.find((p) => p.nom === nom);
  async function creerUtilisateur(login, nomProfil, secteurIds, extra) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, profilId: profil(nomProfil).id, secteurIds, password: 'motdepasse1', doitChangerMdp: false }, extra || {}));
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return c;
  }
  const config = (fn) => { const c = srv.db.getConfig(); fn(c); srv.db.setConfig(c); };
  const userId = (login) => srv.db.findOne('users', (u) => u.login === login).id;

  test('création : validation stricte des entrées', async () => {
    const cas = [
      [{}, 'désignation obligatoire'],
      [{ designation: '   ' }, 'désignation vide'],
      [{ designation: 'X', categorieCode: 'inconnue' }, 'catégorie inconnue'],
      [{ designation: 'X', uniteCode: 'parsec' }, 'unité inconnue'],
      [{ designation: 'X', seuilMin: -1 }, 'seuil négatif'],
      [{ designation: 'X', seuilMin: 'beaucoup' }, 'seuil non numérique'],
      [{ designation: 'X', prixUnitaire: -0.5 }, 'prix négatif'],
      [{ designation: 'X', quantite: -3 }, 'quantité initiale négative'],
      [{ designation: 'X', fournisseurId: 99999 }, 'fournisseur inexistant'],
      [{ designation: 'X', equipementIds: [99999] }, 'équipement inexistant'],
      [{ designation: 'X', equipementIds: 'presse' }, 'équipements : liste attendue'],
      [{ designation: 'X', secteurId: 99999 }, 'secteur inexistant'],
      [{ designation: 'X'.repeat(201) }, 'désignation trop longue'],
      [{ designation: 'X', champs: 'texte' }, 'champs personnalisés invalides'],
    ];
    for (const [body, msg] of cas) {
      const r = await admin.post('/api/articles', body);
      assert.equal(r.status, 400, msg);
      assert.equal(typeof r.body.erreur, 'string', msg + ' : message d\'erreur');
    }
    assert.equal((await admin.post('/api/articles', [1, 2])).status, 400, 'corps non objet');
  });

  test('création : code automatique, unicité, valeurs par défaut, stock initial par inventaire', async () => {
    roulement = await admin.ok('POST', '/api/articles', {
      designation: 'Roulement à billes 6205-2RS', categorieCode: 'mecanique', uniteCode: 'u', quantite: 10, seuilMin: 4, quantiteCommande: 10,
      emplacement: 'Magasin A — Étagère 2', prixUnitaire: 8.9, fournisseurId: skf.id, referenceFournisseur: '6205-2RSH', equipementIds: [presse.id, convoyeur.id, presse.id],
      description: 'Roulement rigide',
    });
    assert.match(roulement.code, /^ART-\d{4}$/, 'code généré selon le gabarit numerotation.art');
    assert.equal(roulement.quantite, 10);
    assert.equal(roulement.actif, true);
    assert.equal(roulement.createdBy, 1);
    assert.deepEqual(roulement.equipementIds, [presse.id, convoyeur.id], 'doublons d\'équipements retirés');
    assert.equal(roulement.valeur, 89, 'valeur = quantité × prix unitaire');
    assert.equal(roulement.fournisseur.nom, 'SKF France');
    assert.equal(roulement.mouvements.length, 1, 'quantité initiale → mouvement d\'inventaire');
    const m0 = roulement.mouvements[0];
    assert.equal(m0.type, 'inventaire');
    assert.equal(m0.quantiteAvant, 0);
    assert.equal(m0.quantiteApres, 10);
    assert.equal(m0.userId, 1);

    const sansStock = await admin.ok('POST', '/api/articles', { designation: 'Courroie HTD 1400-8M-30', categorieCode: 'mecanique', seuilMin: 2, quantiteCommande: 3, prixUnitaire: 46.8, fournisseurId: rexel.id, equipementIds: [convoyeur.id] });
    assert.equal(sansStock.uniteCode, srv.ctx.liste('unites')[0].code, 'unité par défaut = première unité de la liste');
    assert.equal(sansStock.quantite, 0);
    assert.equal(sansStock.mouvements.length, 0, 'aucun mouvement sans quantité initiale');
    assert.notEqual(sansStock.code, roulement.code);
    courroie = sansStock;

    const doublon = await admin.post('/api/articles', { designation: 'Doublon', code: roulement.code.toLowerCase() });
    assert.equal(doublon.status, 400, 'code déjà utilisé (insensible à la casse)');
    assert.match(doublon.body.erreur, /déjà utilisé/);
    const libre = await admin.ok('POST', '/api/articles', { designation: 'Huile hydraulique HM 46', code: 'HUILE-HM46', categorieCode: 'lubrifiant', uniteCode: 'l', quantite: 60, seuilMin: 20, quantiteCommande: 208, prixUnitaire: 3.85 });
    assert.equal(libre.code, 'HUILE-HM46', 'code saisi conservé');
    huile = libre;

    const audit = srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === roulement.id).map((x) => x.action);
    assert.ok(audit.includes('creation'), 'création auditée');
    assert.ok(audit.includes('mouvement'), 'mouvement initial audité');
  });

  test('champs personnalisés des articles', async () => {
    config((c) => { c.champsPersonnalises.articles = [{ cle: 'marque', label: 'Marque', type: 'texte', obligatoire: true }, { cle: 'poids', label: 'Poids (kg)', type: 'nombre' }]; });
    try {
      assert.equal((await admin.post('/api/articles', { designation: 'Sans marque' })).status, 400, 'champ personnalisé obligatoire');
      assert.equal((await admin.post('/api/articles', { designation: 'Poids invalide', champs: { marque: 'SKF', poids: 'lourd' } })).status, 400, 'champ nombre invalide');
      const a = await admin.ok('POST', '/api/articles', { designation: 'Joint torique', champs: { marque: 'Parker', poids: '0.02', inconnu: 'x' } });
      assert.deepEqual(a.champs, { marque: 'Parker', poids: 0.02 }, 'champs validés et nettoyés');
      const maj = await admin.ok('PUT', '/api/articles/' + a.id, { emplacement: 'B2' });
      assert.deepEqual(maj.champs, { marque: 'Parker', poids: 0.02 }, 'champs conservés si non transmis');
      await admin.ok('DELETE', '/api/articles/' + a.id);
    } finally {
      config((c) => { c.champsPersonnalises.articles = []; });
    }
  });

  test('modification : la quantité ne se modifie que par un mouvement', async () => {
    const r = await admin.put('/api/articles/' + roulement.id, { quantite: 50 });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /mouvement/);
    const maj = await admin.ok('PUT', '/api/articles/' + roulement.id, Object.assign({}, roulement, { emplacement: 'Magasin A — Étagère 3', seuilMin: 3 }));
    assert.equal(maj.emplacement, 'Magasin A — Étagère 3');
    assert.equal(maj.seuilMin, 3);
    assert.equal(maj.quantite, 10, 'quantité identique transmise : tolérée et inchangée');
    assert.equal(maj.code, roulement.code);
    assert.equal((await admin.put('/api/articles/' + roulement.id, { code: courroie.code })).status, 400, 'code d\'un autre article');
    assert.equal((await admin.put('/api/articles/' + roulement.id, { code: '' })).status, 400, 'code vidé');
    assert.equal((await admin.put('/api/articles/' + roulement.id, { designation: '' })).status, 400, 'désignation vidée');
    assert.equal((await admin.put('/api/articles/' + roulement.id, { categorieCode: 'nope' })).status, 400);
    assert.equal((await admin.put('/api/articles/999999', { designation: 'X' })).status, 404);
    const remis = await admin.ok('PUT', '/api/articles/' + roulement.id, { seuilMin: 4 });
    assert.equal(remis.seuilMin, 4);
    assert.ok(srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === roulement.id && x.action === 'modification').length >= 2);
  });

  test('mouvements : entrée (CUMP), sortie, inventaire (écart), validations', async () => {
    // Entrée avec prix → coût unitaire moyen pondéré
    let r = await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'entree', quantite: 10, prixUnitaire: 10.9, fournisseurId: skf.id, motif: 'Réception CDE-001' });
    assert.equal(r.mouvement.type, 'entree');
    assert.equal(r.mouvement.quantiteAvant, 10);
    assert.equal(r.mouvement.quantiteApres, 20);
    assert.equal(r.mouvement.prixUnitaire, 10.9);
    assert.equal(r.mouvement.fournisseurNom, 'SKF France');
    assert.equal(r.article.quantite, 20);
    assert.equal(r.article.prixUnitaire, 9.9, 'CUMP = (10 × 8,9 + 10 × 10,9) / 20');

    // Sortie
    r = await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 3, motif: 'Dépannage convoyeur' });
    assert.equal(r.mouvement.quantiteAvant, 20);
    assert.equal(r.mouvement.quantiteApres, 17);
    assert.equal(r.mouvement.ecart, -3);
    assert.equal(r.mouvement.prixUnitaire, 9.9, 'sortie valorisée au prix courant');
    assert.equal(r.mouvement.motif, 'Dépannage convoyeur');
    assert.equal(r.mouvement.annulable, true);

    // Inventaire : quantité constatée → écart
    r = await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'inventaire', quantite: 16, motif: 'Inventaire tournant' });
    assert.equal(r.mouvement.quantite, 16);
    assert.equal(r.mouvement.quantiteAvant, 17);
    assert.equal(r.mouvement.quantiteApres, 16);
    assert.equal(r.mouvement.ecart, -1);
    assert.equal(r.article.quantite, 16);
    assert.ok(r.article.dateDernierInventaire);
    const inv0 = await admin.ok('POST', `/api/articles/${courroie.id}/mouvements`, { type: 'inventaire', quantite: 0 });
    assert.equal(inv0.mouvement.ecart, 0, 'inventaire à zéro accepté');

    // Validations
    const invalides = [
      [{ type: 'transfert', quantite: 1 }, 'type inconnu'],
      [{ type: 'retour', quantite: 1 }, 'retour direct interdit'],
      [{ type: 'entree' }, 'quantité obligatoire'],
      [{ type: 'entree', quantite: 0 }, 'quantité nulle'],
      [{ type: 'sortie', quantite: -2 }, 'quantité négative'],
      [{ type: 'entree', quantite: 'abc' }, 'quantité non numérique'],
      [{ type: 'inventaire', quantite: -1 }, 'quantité constatée négative'],
      [{ type: 'entree', quantite: 1, fournisseurId: 424242 }, 'fournisseur inexistant'],
      [{ type: 'entree', quantite: 1, prixUnitaire: -1 }, 'prix négatif'],
      [{ type: 'sortie', quantite: 1, otId: 424242 }, 'OT inexistant'],
      [{ type: 'sortie', quantite: 1, motif: 'x'.repeat(501) }, 'motif trop long'],
    ];
    for (const [body, msg] of invalides) assert.equal((await admin.post(`/api/articles/${roulement.id}/mouvements`, body)).status, 400, msg);
    assert.equal((await admin.post('/api/articles/999999/mouvements', { type: 'entree', quantite: 1 })).status, 404);
    assert.equal(srv.db.get('articles', roulement.id).quantite, 16, 'aucune modification après les refus');
  });

  test('sortie : stock insuffisant, puis autorisée avec config.workflow.stockNegatif', async () => {
    const r = await admin.post(`/api/articles/${courroie.id}/mouvements`, { type: 'sortie', quantite: 1 });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /^Stock insuffisant/);
    assert.throws(() => srv.ctx.services.stock.sortir({ articleId: courroie.id, quantite: 1, userId: 1 }), (e) => e.status === 400 && /^Stock insuffisant/.test(e.message), 'service : HttpError 400');
    config((c) => { c.workflow.stockNegatif = true; });
    try {
      const ok = await admin.ok('POST', `/api/articles/${courroie.id}/mouvements`, { type: 'sortie', quantite: 2, motif: 'Dépannage urgent' });
      assert.equal(ok.article.quantite, -2, 'stock négatif autorisé');
      assert.equal(ok.article.valeur, 0, 'un stock négatif n\'est pas valorisé');
      const e = await admin.ok('POST', `/api/articles/${courroie.id}/mouvements`, { type: 'entree', quantite: 5, prixUnitaire: 46.8 });
      assert.equal(e.article.quantite, 3);
    } finally {
      config((c) => { c.workflow.stockNegatif = false; });
    }
  });

  test('passage sous le seuil : événement stock:sousSeuil et notifications des gestionnaires du stock', async () => {
    evenements.length = 0;
    srv.db.data.collections.notifications.length = 0;
    // roulement : 16, seuil 4
    await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 10 });
    assert.equal(evenements.length, 0, 'pas d\'événement au-dessus du seuil (6 > 4)');
    const r = await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 2 });
    assert.equal(r.article.quantite, 4);
    assert.equal(r.article.sousSeuil, true, 'quantité = seuil → sous le seuil');
    assert.equal(evenements.length, 1, 'événement émis au franchissement');
    assert.equal(evenements[0].id, roulement.id);
    const notifs = srv.db.list('notifications');
    const destinataires = notifs.map((n) => n.userId).sort((a, b) => a - b);
    const attendus = [1, userId('tech.prod'), userId('resp.prod')].sort((a, b) => a - b);
    assert.deepEqual(destinataires, attendus, 'utilisateurs ayant stock.modifier (admin, technicien, responsable) ; pas le chef de secteur ni le demandeur');
    assert.ok(notifs.every((n) => n.lien === `#/stock/${roulement.id}` && /seuil/i.test(n.titre)));
    assert.match(notifs[0].message, /Quantité à commander : 10/);

    // Déjà sous le seuil : pas de nouvelle alerte
    await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 1 });
    assert.equal(evenements.length, 1, 'aucun nouvel événement tant que le stock reste sous le seuil');
    // Remontée puis nouvelle descente par inventaire
    await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'entree', quantite: 7 });
    await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'inventaire', quantite: 2 });
    assert.equal(evenements.length, 2, 'un inventaire peut aussi déclencher le passage sous le seuil');
    await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'entree', quantite: 18, prixUnitaire: 9.9 });
    assert.equal(srv.db.get('articles', roulement.id).quantite, 20);
  });

  test('services publiés : sortir, entrer, annulerSortie', async () => {
    const s = srv.ctx.services.stock;
    assert.equal(typeof s.sortir, 'function');
    assert.equal(typeof s.entrer, 'function');
    assert.equal(typeof s.annulerSortie, 'function');
    const sortie = s.sortir({ articleId: huile.id, quantite: 5, otId: null, userId: userId('tech.prod'), motif: 'Appoint presse' });
    assert.equal(sortie.mouvement.type, 'sortie');
    assert.equal(sortie.mouvement.userId, userId('tech.prod'));
    assert.equal(sortie.mouvement.quantiteAvant, 60);
    assert.equal(sortie.mouvement.quantiteApres, 55);
    assert.equal(sortie.article.quantite, 55);
    const entree = s.entrer({ articleId: huile.id, quantite: 2.5, userId: 1, motif: 'Retour bidon', prixUnitaire: 3.85, fournisseurId: null });
    assert.equal(entree.article.quantite, 57.5, 'quantités décimales');
    const retour = s.annulerSortie(sortie.mouvement.id, 1);
    assert.equal(retour.mouvement.type, 'retour');
    assert.equal(retour.mouvement.quantite, 5);
    assert.equal(retour.mouvement.quantiteAvant, 57.5);
    assert.equal(retour.mouvement.quantiteApres, 62.5);
    assert.equal(retour.mouvement.mouvementOrigineId, sortie.mouvement.id);
    assert.equal(retour.mouvement.prixUnitaire, sortie.mouvement.prixUnitaire, 'retour valorisé au prix de la sortie');
    assert.equal(srv.db.get('mouvementsStock', sortie.mouvement.id).annuleParId, retour.mouvement.id);
    assert.throws(() => s.annulerSortie(sortie.mouvement.id, 1), (e) => e.status === 400, 'double annulation refusée');
    assert.throws(() => s.annulerSortie(entree.mouvement.id, 1), (e) => e.status === 400, 'annulation d\'une entrée refusée');
    assert.throws(() => s.annulerSortie(987654, 1), (e) => e.status === 404);
    assert.throws(() => s.sortir({ articleId: 987654, quantite: 1, userId: 1 }), (e) => e.status === 404);
    assert.throws(() => s.entrer({ articleId: huile.id, quantite: 0, userId: 1 }), (e) => e.status === 400);
    const audits = srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === huile.id && x.action === 'mouvement');
    assert.ok(audits.some((x) => x.userId === userId('tech.prod')), 'mouvement de service audité au nom de l\'utilisateur');
  });

  test('annulation d\'une sortie par la route, imputation d\'une sortie à un OT', async () => {
    const sortie = await admin.ok('POST', `/api/articles/${huile.id}/mouvements`, { type: 'sortie', quantite: 2.5, motif: 'Erreur de saisie' });
    const annul = await admin.ok('POST', `/api/mouvements/${sortie.mouvement.id}/annuler`, {});
    assert.equal(annul.mouvement.type, 'retour');
    assert.equal(annul.article.quantite, 62.5);
    assert.equal((await admin.post(`/api/mouvements/${sortie.mouvement.id}/annuler`, {})).status, 400, 'déjà annulée');
    assert.equal((await admin.post('/api/mouvements/999999/annuler', {})).status, 404);

    const ot = srv.db.insert('ot', { numero: 'OT-TEST-0001', titre: 'Reprise joint presse', statut: 'en_cours', equipementId: presse.id, secteurId: prod.id, pieces: [], tempsPasse: [{ userId: 1, date: '2026-10-01', heures: 2 }], coutExterne: 100, createdBy: 1 });
    const imp = await admin.ok('POST', `/api/articles/${huile.id}/mouvements`, { type: 'sortie', quantite: 4, otId: ot.id });
    assert.equal(imp.mouvement.otId, ot.id);
    assert.equal(imp.mouvement.otNumero, 'OT-TEST-0001');
    assert.match(imp.mouvement.motif, /OT-TEST-0001/, 'motif par défaut = OT');
    assert.equal(imp.mouvement.annulable, false);
    const otMaj = srv.db.get('ot', ot.id);
    assert.equal(otMaj.pieces.length, 1, 'pièce ajoutée à l\'OT');
    assert.equal(otMaj.pieces[0].mouvementId, imp.mouvement.id);
    assert.equal(otMaj.pieces[0].quantite, 4);
    assert.equal(otMaj.coutPieces, Math.round(4 * imp.mouvement.prixUnitaire * 100) / 100, 'coût des pièces recalculé');
    const r = await admin.post(`/api/mouvements/${imp.mouvement.id}/annuler`, {});
    assert.equal(r.status, 400, 'une sortie imputée à un OT s\'annule depuis l\'OT');
    assert.match(r.body.erreur, /OT-TEST-0001/);

    const clos = srv.db.insert('ot', { numero: 'OT-TEST-0002', titre: 'Clos', statut: 'termine', secteurId: prod.id, pieces: [], createdBy: 1 });
    const refus = await admin.post(`/api/articles/${huile.id}/mouvements`, { type: 'sortie', quantite: 1, otId: clos.id });
    assert.equal(refus.status, 400, 'OT clôturé (statut final) : imputation refusée');
    const otMaint = srv.db.insert('ot', { numero: 'OT-TEST-0003', titre: 'Maintenance', statut: 'en_cours', secteurId: maint.id, pieces: [], createdBy: 1 });
    assert.equal((await technicienProd.post(`/api/articles/${huile.id}/mouvements`, { type: 'sortie', quantite: 1, otId: otMaint.id })).status, 400, 'OT hors portée');

    // Détail de l'article : consommation par OT
    const fiche = await admin.ok('GET', '/api/articles/' + huile.id);
    assert.equal(fiche.ots.length, 1);
    assert.equal(fiche.ots[0].otId, ot.id);
    assert.equal(fiche.ots[0].numero, 'OT-TEST-0001');
    assert.equal(fiche.ots[0].quantite, 4);
    assert.equal(fiche.ots[0].equipementNom, 'Presse hydraulique');
    assert.equal(fiche.stats.consommation90j, 4 + 5 - 5 + 2.5 - 2.5, 'consommation 90 j = sorties − retours');
  });

  test('détail d\'un article : fournisseur, mouvements (50 derniers), équipements, valeur, statistiques', async () => {
    for (let i = 0; i < 45; i++) await admin.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: i % 2 ? 'entree' : 'sortie', quantite: 1 });
    const a = await admin.ok('GET', '/api/articles/' + roulement.id);
    assert.equal(a.mouvements.length, 50, '50 derniers mouvements');
    assert.ok(a.nbMouvements > 50);
    assert.ok(a.mouvements[0].date >= a.mouvements[49].date, 'du plus récent au plus ancien');
    assert.equal(a.mouvements[0].articleCode, roulement.code);
    assert.ok(a.mouvements[0].userNom);
    assert.equal(a.fournisseur.id, skf.id);
    assert.equal(a.fournisseur.delaiLivraisonJours, 5);
    assert.deepEqual(a.equipements.map((e) => e.nom), ['Convoyeur', 'Presse hydraulique']);
    assert.equal(a.valeur, Math.round(a.quantite * a.prixUnitaire * 100) / 100);
    assert.equal(a.stats.consommationMensuelle.length, 12);
    assert.ok(a.stats.consommation90j > 0);
    assert.ok(a.stats.couvertureJours >= 0);
    assert.equal((await admin.get('/api/articles/999999')).status, 404);
    assert.equal((await admin.get('/api/articles/abc')).status, 404);
  });

  test('liste des articles : filtres et recherche', async () => {
    const ids = (rows) => rows.map((r) => r.id).sort((x, y) => x - y);
    const tous = await admin.ok('GET', '/api/articles');
    assert.ok(tous.length >= 3);
    assert.ok(tous.every((a) => 'valeur' in a && 'sousSeuil' in a && 'fournisseurNom' in a));
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?categorieCode=lubrifiant')), [huile.id]);
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?fournisseurId=' + skf.id)), [roulement.id]);
    assert.ok((await admin.ok('GET', '/api/articles?fournisseurId=aucun')).some((a) => a.id === huile.id));
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?equipementId=' + convoyeur.id)), ids([roulement, courroie]));
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?recherche=ROULEMENT')), [roulement.id], 'recherche sur la désignation, insensible à la casse');
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?recherche=2rsh')), [roulement.id], 'recherche sur la référence fournisseur');
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?recherche=huile-hm')), [huile.id], 'recherche sur le code');
    assert.deepEqual(ids(await admin.ok('GET', '/api/articles?recherche=etagere')), [roulement.id], 'recherche sans accents');
    assert.equal((await admin.get('/api/articles?fournisseurId=abc')).status, 400);

    await admin.ok('POST', `/api/articles/${courroie.id}/mouvements`, { type: 'inventaire', quantite: 1 });
    const sous = await admin.ok('GET', '/api/articles?sousSeuil=1');
    assert.ok(sous.some((a) => a.id === courroie.id), 'courroie : 1 ≤ 2');
    assert.ok(sous.every((a) => a.quantite <= a.seuilMin && a.actif));
    assert.ok(!sous.some((a) => a.id === roulement.id));

    const inactif = await admin.ok('POST', '/api/articles', { designation: 'Article obsolète', actif: false });
    assert.ok((await admin.ok('GET', '/api/articles?actif=0')).every((a) => a.actif === false));
    assert.ok((await admin.ok('GET', '/api/articles?actif=0')).some((a) => a.id === inactif.id));
    assert.ok(!(await admin.ok('GET', '/api/articles?actif=1')).some((a) => a.id === inactif.id));
    assert.ok((await admin.ok('GET', '/api/articles')).some((a) => a.id === inactif.id), 'sans filtre : tous les articles');
    // Un article désactivé n'accepte plus ni entrée ni sortie
    assert.equal((await admin.post(`/api/articles/${inactif.id}/mouvements`, { type: 'entree', quantite: 1 })).status, 400);
    assert.throws(() => srv.ctx.services.stock.sortir({ articleId: inactif.id, quantite: 1, userId: 1 }), (e) => e.status === 400);
  });

  test('journal des mouvements : filtres et validation', async () => {
    const tous = await admin.ok('GET', '/api/mouvements');
    assert.ok(tous.length > 40);
    assert.ok(tous[0].date >= tous[tous.length - 1].date, 'tri chronologique inverse');
    const parArticle = await admin.ok('GET', '/api/mouvements?articleId=' + huile.id);
    assert.ok(parArticle.length >= 5 && parArticle.every((m) => m.articleId === huile.id));
    const sorties = await admin.ok('GET', '/api/mouvements?type=sortie');
    assert.ok(sorties.length && sorties.every((m) => m.type === 'sortie'));
    const multi = await admin.ok('GET', '/api/mouvements?type=entree,retour');
    assert.ok(multi.every((m) => m.type === 'entree' || m.type === 'retour'));
    const parTech = await admin.ok('GET', '/api/mouvements?userId=' + userId('tech.prod'));
    assert.ok(parTech.length >= 1 && parTech.every((m) => m.userId === userId('tech.prod')));
    const ot = srv.db.findOne('ot', (o) => o.numero === 'OT-TEST-0001');
    const parOt = await admin.ok('GET', '/api/mouvements?otId=' + ot.id);
    assert.equal(parOt.length, 1);
    assert.ok((await admin.ok('GET', '/api/mouvements?otId=tous')).every((m) => m.otId != null));
    const auj = new Date();
    const iso = `${auj.getFullYear()}-${String(auj.getMonth() + 1).padStart(2, '0')}-${String(auj.getDate()).padStart(2, '0')}`;
    assert.equal((await admin.ok('GET', `/api/mouvements?du=${iso}&au=${iso}`)).length, tous.length, 'tous les mouvements datent d\'aujourd\'hui');
    assert.equal((await admin.ok('GET', '/api/mouvements?au=2000-01-01')).length, 0);
    assert.equal((await admin.get('/api/mouvements?du=14/10/2026')).status, 400, 'date invalide');
    assert.equal((await admin.get('/api/mouvements?du=2026-10-14&au=2026-10-01')).status, 400, 'période inversée');
    assert.equal((await admin.get('/api/mouvements?type=vol')).status, 400, 'type inconnu');
    assert.equal((await admin.ok('GET', '/api/mouvements?limite=3')).length, 3);
  });

  test('alertes de réapprovisionnement et valorisation', async () => {
    // courroie : quantité 1, seuil 2, qté commande 3 → max(3, 2×2−1) = 3
    await admin.ok('PUT', '/api/articles/' + courroie.id, { seuilMin: 5, quantiteCommande: 3 });
    const alertes = await admin.ok('GET', '/api/stock-alertes');
    const c = alertes.find((a) => a.id === courroie.id);
    assert.ok(c, 'article sous le seuil présent');
    assert.equal(c.quantiteACommander, 9, 'max(3, 5 × 2 − 1) = 9');
    assert.equal(c.valeurCommande, Math.round(9 * c.prixUnitaire * 100) / 100);
    assert.equal(c.fournisseurNom, 'Rexel');
    assert.ok(alertes.every((a) => a.actif && a.quantite <= a.seuilMin));
    assert.ok(!alertes.some((a) => a.actif === false));
    await admin.ok('PUT', '/api/articles/' + courroie.id, { seuilMin: 2, quantiteCommande: 3 });
    const c2 = (await admin.ok('GET', '/api/stock-alertes')).find((a) => a.id === courroie.id);
    assert.equal(c2.quantiteACommander, 3, 'max(3, 2 × 2 − 1) = 3');

    await admin.ok('POST', '/api/articles', { designation: 'Chiffons d\'essuyage', uniteCode: 'kg', quantite: 5, prixUnitaire: 2.4 });
    const v = await admin.ok('GET', '/api/stock-valorisation');
    const actifs = srv.db.list('articles', (a) => a.actif !== false);
    const attendu = Math.round(actifs.reduce((s, a) => s + Math.max(0, a.quantite) * a.prixUnitaire, 0) * 100) / 100;
    assert.equal(v.total, attendu, 'valeur totale du stock actif');
    assert.equal(v.nbArticles, actifs.length);
    const lub = v.parCategorie.find((x) => x.categorieCode === 'lubrifiant');
    assert.equal(lub.label, 'Lubrifiant');
    assert.equal(lub.valeur, Math.round(srv.db.get('articles', huile.id).quantite * srv.db.get('articles', huile.id).prixUnitaire * 100) / 100);
    assert.equal(Math.round(v.parCategorie.reduce((s, x) => s + x.valeur, 0) * 100) / 100, v.total, 'somme des catégories = total');
    assert.ok(v.parCategorie.some((x) => x.categorieCode === null && x.label === 'Sans catégorie'));
    assert.ok(v.topArticles.length >= 1 && v.topArticles[0].valeur >= v.topArticles[v.topArticles.length - 1].valeur);
  });

  test('références des formulaires (fournisseurs, équipements visibles, OT ouverts)', async () => {
    const r = await technicienProd.ok('GET', '/api/stock-references');
    assert.deepEqual(r.fournisseurs.map((f) => f.nom), ['Rexel', 'SKF France']);
    assert.ok(r.equipements.some((e) => e.id === presse.id));
    assert.ok(!r.equipements.some((e) => e.id === autreSecteurEq.id), 'équipement hors portée exclu');
    assert.ok(r.otOuverts.some((o) => o.numero === 'OT-TEST-0001'));
    assert.ok(!r.otOuverts.some((o) => o.numero === 'OT-TEST-0002'), 'OT clôturé exclu');
    assert.ok(!r.otOuverts.some((o) => o.numero === 'OT-TEST-0003'), 'OT hors portée exclu');
    assert.ok(r.emplacements.includes('Magasin A — Étagère 3'));
  });

  test('exports CSV : cellules commençant par = + - @ neutralisées (injection de formules), nombres intacts', async () => {
    const a = await admin.ok('POST', '/api/articles', { designation: '=HYPERLINK("http://exemple.invalid";"Cliquer")', description: '@cmd|calc', emplacement: '-A1', categorieCode: 'mecanique', quantite: 3, seuilMin: 1, prixUnitaire: 12.5 });
    await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: 2, motif: '+SUM(1;2)' });
    const r = await admin.brut('/api/articles-export');
    assert.equal(r.status, 200);
    assert.deepEqual([...r.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 (octets bruts)');
    const ligne = r.body.toString('utf8').split('\r\n').find((l) => l.startsWith(a.code + ';'));
    assert.ok(ligne, 'ligne exportée');
    assert.ok(ligne.includes(';"\'=HYPERLINK('), 'apostrophe devant = : ' + ligne);
    assert.ok(!/;"?=HYPERLINK/.test(ligne), 'aucune formule exécutable');
    assert.ok(ligne.includes(';\'-A1;'), 'emplacement neutralisé : ' + ligne);
    assert.ok(ligne.includes(';\'@cmd|calc'), 'description neutralisée : ' + ligne);
    assert.ok(ligne.includes(';12,5;'), 'les nombres restent des nombres : ' + ligne);
    const mv = String((await admin.get('/api/mouvements-export?articleId=' + a.id)).body).split('\r\n').find((l) => l.includes('SUM'));
    assert.ok(mv && mv.includes('"\'+SUM(1;2)"'), 'motif du mouvement neutralisé : ' + mv);
    assert.equal(srv.ctx.csvEscape('=x'), '\'=x', 'utilitaire commun du cœur');
  });

  test('exports CSV', async () => {
    const a = await admin.get('/api/articles-export?categorieCode=mecanique');
    assert.equal(a.status, 200);
    assert.match(a.headers.get('content-type'), /text\/csv/);
    assert.match(a.headers.get('content-disposition'), /articles-\d{4}-\d{2}-\d{2}\.csv/);
    const lignes = a.body.split('\r\n');
    assert.ok(lignes[0].replace(/^\ufeff/, '').startsWith('Code;Désignation;Catégorie'), 'en-têtes (BOM UTF-8 retiré par fetch)');
    assert.equal(lignes.length, 1 + (await admin.ok('GET', '/api/articles?categorieCode=mecanique')).length, 'filtres appliqués');
    assert.ok(lignes.some((l) => l.includes('Roulement à billes 6205-2RS') && l.includes('SKF France')));
    const m = await admin.get('/api/mouvements-export?type=sortie&articleId=' + huile.id);
    assert.equal(m.status, 200);
    const lm = m.body.split('\r\n');
    assert.ok(lm[0].includes('Stock avant;Stock après'));
    assert.ok(lm.slice(1).every((l) => l.split(';')[1] === 'Sortie'));
    assert.ok(srv.db.list('audit', (x) => x.action === 'export' && (x.entite === 'articles' || x.entite === 'mouvementsStock')).length >= 2, 'exports audités');
  });

  test('intégration avec le module OT réel : pièces sorties puis remises en stock depuis l\'OT', async () => {
    if (!srv.ctx.services.ot || typeof srv.ctx.services.ot.creer !== 'function') return; // module OT absent
    const art = await admin.ok('POST', '/api/articles', { designation: 'Joint de tige Ø 50', categorieCode: 'hydraulique', quantite: 5, seuilMin: 2, prixUnitaire: 10 });
    const ot = await admin.ok('POST', '/api/ot', { titre: 'Reprise du joint de la presse', equipementId: presse.id, typeCode: 'correctif' });
    const avecPiece = await admin.ok('POST', `/api/ot/${ot.id}/pieces`, { articleId: art.id, quantite: 2 });
    assert.equal(avecPiece.pieces.length, 1);
    assert.ok(avecPiece.pieces[0].mouvementId, 'mouvement de stock référencé par la pièce');
    assert.equal(srv.db.get('articles', art.id).quantite, 3);
    const mvt = srv.db.get('mouvementsStock', avecPiece.pieces[0].mouvementId);
    assert.equal(mvt.type, 'sortie');
    assert.equal(mvt.otId, ot.id);
    assert.equal(mvt.quantiteAvant, 5);
    assert.equal(mvt.quantiteApres, 3);
    const refus = await admin.post(`/api/ot/${ot.id}/pieces`, { articleId: art.id, quantite: 9 });
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /^Stock insuffisant/);
    assert.equal((await admin.post(`/api/mouvements/${mvt.id}/annuler`, {})).status, 400, 'annulation depuis le stock refusée : la pièce est sur l\'OT');
    await admin.ok('DELETE', `/api/ot/${ot.id}/pieces/0`);
    assert.equal(srv.db.get('articles', art.id).quantite, 5, 'retour en stock via annulerSortie');
    assert.ok(srv.db.get('mouvementsStock', mvt.id).annuleParId, 'sortie marquée comme annulée');
    const fiche = await admin.ok('GET', '/api/articles/' + art.id);
    assert.equal(fiche.ots.length, 1);
    assert.equal(fiche.ots[0].quantite, 0, 'consommation nette nulle après le retour');
  });

  test('liste de valeurs reconfigurée : un code devenu obsolète n\'empêche pas la modification', async () => {
    const art = await admin.ok('POST', '/api/articles', { designation: 'Courroie trapézoïdale SPZ 1250', categorieCode: 'pneumatique' });
    const sauvegarde = srv.db.getConfig().listes.categoriesArticles;
    config((c) => { c.listes.categoriesArticles = c.listes.categoriesArticles.filter((x) => x.code !== 'pneumatique'); });
    try {
      const maj = await admin.ok('PUT', '/api/articles/' + art.id, { emplacement: 'A3' });
      assert.equal(maj.categorieCode, 'pneumatique', 'code conservé tant qu\'il n\'est pas modifié');
      assert.equal((await admin.put('/api/articles/' + art.id, { categorieCode: 'pneumatique2' })).status, 400, 'nouveau code inconnu refusé');
      assert.equal((await admin.post('/api/articles', { designation: 'Nouvel article', categorieCode: 'pneumatique' })).status, 400, 'code retiré de la liste refusé à la création');
    } finally {
      config((c) => { c.listes.categoriesArticles = sauvegarde; });
    }
    await admin.ok('DELETE', '/api/articles/' + art.id);
  });

  test('droits : 403 pour les profils sans le droit requis', async () => {
    // Demandeur : aucun accès au stock
    for (const url of ['/api/articles', '/api/articles/' + roulement.id, '/api/mouvements', '/api/stock-alertes', '/api/stock-valorisation', '/api/stock-references']) {
      assert.equal((await demandeur.get(url)).status, 403, 'demandeur : ' + url);
    }
    // Chef de secteur : consultation seule
    assert.equal((await chefProd.get('/api/articles')).status, 200);
    assert.equal((await chefProd.post('/api/articles', { designation: 'X' })).status, 403);
    assert.equal((await chefProd.put('/api/articles/' + roulement.id, { emplacement: 'X' })).status, 403);
    assert.equal((await chefProd.del('/api/articles/' + roulement.id)).status, 403);
    assert.equal((await chefProd.post(`/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 1 })).status, 403);
    assert.equal((await chefProd.get('/api/articles-export')).status, 403, 'chef de secteur : pas de droit d\'export du stock');
    // Technicien : mouvements oui, création / suppression / export non
    assert.equal((await technicienProd.post('/api/articles', { designation: 'X' })).status, 403);
    assert.equal((await technicienProd.del('/api/articles/' + roulement.id)).status, 403);
    assert.equal((await technicienProd.get('/api/articles-export')).status, 403);
    assert.equal((await technicienProd.get('/api/mouvements-export')).status, 403);
    const sortie = await technicienProd.ok('POST', `/api/articles/${roulement.id}/mouvements`, { type: 'sortie', quantite: 1, motif: 'Dépannage' });
    assert.equal(sortie.mouvement.userId, userId('tech.prod'));
    assert.equal((await technicienProd.post(`/api/mouvements/${sortie.mouvement.id}/annuler`, {})).status, 200);
    // Non authentifié
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/articles')).status, 401);
  });

  test('portée site / perso : un article ne peut être rattaché qu\'à un secteur modifiable (sites en lecture seule exclus)', async () => {
    const site2 = srv.db.insert('secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site', parentId: null, actif: true, ordre: 90 });
    const prod2 = srv.db.insert('secteurs', { nom: 'Production Valréas', code: 'VPROD', type: 'atelier', parentId: site2.id, actif: true, ordre: 91 });
    const site = await creerUtilisateur('resp.site', 'Responsable maintenance', [prod.id], { porteeOverride: 'site', siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    const r1 = await site.post('/api/articles', { designation: 'Article Valréas', secteurId: prod2.id });
    assert.equal(r1.status, 403, 'portée site : site en lecture seule refusé'); assert.match(r1.body.erreur, /lecture seule/);
    const a = await site.ok('POST', '/api/articles', { designation: 'Article Carpentras', secteurId: prod.id });
    assert.equal((await site.put('/api/articles/' + a.id, { secteurId: prod2.id })).status, 403, 'changement de secteur vers un site en lecture seule refusé');
    const perso = await creerUtilisateur('magasinier.perso', 'Responsable maintenance', [], { porteeOverride: 'perso', siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    assert.equal((await perso.post('/api/articles', { designation: 'Article perso Valréas', secteurId: prod2.id })).status, 403, 'portée perso : site en lecture seule refusé');
    assert.equal((await perso.post('/api/articles', { designation: 'Article perso Carpentras', secteurId: maint.id })).status, 200, 'portée perso sans secteur : autres secteurs permis');
  });

  test('portée par secteur : articles d\'un magasin hors secteur invisibles', async () => {
    const magasinMaint = await admin.ok('POST', '/api/articles', { designation: 'Câble acier pont roulant', secteurId: maint.id, quantite: 3, seuilMin: 1, prixUnitaire: 120, equipementIds: [autreSecteurEq.id] });
    const magasinProd = await admin.ok('POST', '/api/articles', { designation: 'Ventouse étiqueteuse', secteurId: prod.id, quantite: 0, seuilMin: 2, prixUnitaire: 15 });
    const liste = await technicienProd.ok('GET', '/api/articles');
    assert.ok(!liste.some((a) => a.id === magasinMaint.id), 'article MAINT invisible pour un technicien PROD');
    assert.ok(liste.some((a) => a.id === magasinProd.id));
    assert.ok(liste.some((a) => a.id === roulement.id), 'article sans secteur (magasin central) visible');
    assert.equal((await technicienProd.get('/api/articles/' + magasinMaint.id)).status, 404);
    assert.equal((await technicienProd.post(`/api/articles/${magasinMaint.id}/mouvements`, { type: 'sortie', quantite: 1 })).status, 404);
    assert.ok(!(await technicienProd.ok('GET', '/api/mouvements')).some((m) => m.articleId === magasinMaint.id), 'mouvements filtrés par la portée');
    assert.ok(!(await technicienProd.ok('GET', '/api/stock-alertes')).some((a) => a.id === magasinMaint.id));
    assert.ok((await technicienProd.ok('GET', '/api/stock-alertes')).some((a) => a.id === magasinProd.id));
    assert.ok((await technicienProd.ok('GET', '/api/stock-valorisation')).total < (await admin.ok('GET', '/api/stock-valorisation')).total);
    const ficheProd = await technicienProd.ok('GET', '/api/articles/' + roulement.id);
    assert.ok(ficheProd.equipements.every((e) => e.id !== autreSecteurEq.id));

    // Responsable limité à PROD : ne peut rattacher un article qu'à ses secteurs
    assert.equal((await respProd.post('/api/articles', { designation: 'Hors secteur', secteurId: maint.id })).status, 403);
    const okProd = await respProd.ok('POST', '/api/articles', { designation: 'Dans le secteur', secteurId: prod.id });
    assert.equal(okProd.secteurId, prod.id);
    assert.equal((await respProd.put('/api/articles/' + okProd.id, { secteurId: maint.id })).status, 403);
    assert.equal((await respProd.post('/api/articles', { designation: 'Équipement hors portée', equipementIds: [autreSecteurEq.id] })).status, 400);
    // Les compatibilités hors portée sont conservées lors d'une modification
    await admin.ok('PUT', '/api/articles/' + roulement.id, { equipementIds: [presse.id, autreSecteurEq.id] });
    const maj = await respProd.ok('PUT', '/api/articles/' + roulement.id, { equipementIds: [convoyeur.id] });
    assert.deepEqual(maj.equipementIds.slice().sort((a, b) => a - b), [convoyeur.id, autreSecteurEq.id].sort((a, b) => a - b));
  });

  test('suppression : définitive sans historique, désactivation sinon', async () => {
    const vierge = await admin.ok('POST', '/api/articles', { designation: 'Article de test sans mouvement' });
    const r1 = await admin.ok('DELETE', '/api/articles/' + vierge.id);
    assert.equal(r1.desactive, undefined);
    assert.equal(srv.db.get('articles', vierge.id), null, 'supprimé');
    assert.ok(srv.db.list('audit', (x) => x.action === 'suppression' && x.entite === 'articles' && x.entiteId === vierge.id).length);

    const r2 = await admin.ok('DELETE', '/api/articles/' + huile.id);
    assert.equal(r2.desactive, true, 'article avec mouvements : désactivé');
    assert.equal(srv.db.get('articles', huile.id).actif, false);
    assert.ok(srv.db.list('audit', (x) => x.action === 'desactivation' && x.entiteId === huile.id).length);
    assert.equal((await admin.del('/api/articles/999999')).status, 404);
    const reactive = await admin.ok('PUT', '/api/articles/' + huile.id, { actif: true });
    assert.equal(reactive.actif, true);
    assert.ok(srv.db.list('audit', (x) => x.action === 'reactivation' && x.entiteId === huile.id).length, 'réactivation auditée');
  });

  test('retour en stock : le coût moyen pondéré est recalculé au prix de la sortie', async () => {
    const a = await admin.ok('POST', '/api/articles', { designation: 'Joint SPI 40 × 62 × 7', uniteCode: 'u', quantite: 10, prixUnitaire: 10 });
    const sortie = await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 5, motif: 'Dépannage' });
    assert.equal(sortie.mouvement.prixUnitaire, 10);
    const entree = await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: 5, prixUnitaire: 20 });
    assert.equal(entree.article.prixUnitaire, 15, 'CUMP après l\'entrée');
    const retour = await admin.ok('POST', `/api/mouvements/${sortie.mouvement.id}/annuler`, {});
    assert.equal(retour.mouvement.prixUnitaire, 10, 'retour valorisé au prix de la sortie');
    assert.equal(retour.article.quantite, 15);
    assert.equal(retour.article.prixUnitaire, 13.3333, 'CUMP = (10 × 15 + 5 × 10) / 15');
    assert.equal(retour.article.valeur, 200, 'valeur du stock = 5 × 10 + 5 × 20 + 5 × 10');
    assert.equal((await admin.ok('GET', '/api/articles/' + a.id)).valeur, 200);
    // Même règle par le service (retour d'une sortie imputée à un OT)
    const s = srv.ctx.services.stock;
    const b = await admin.ok('POST', '/api/articles', { designation: 'Joint plat 60 × 80', uniteCode: 'u', quantite: 20, prixUnitaire: 8 });
    const s2 = s.sortir({ articleId: b.id, quantite: 10, userId: 1, motif: 'Essai' });
    assert.equal(s.entrer({ articleId: b.id, quantite: 10, userId: 1, prixUnitaire: 12 }).article.prixUnitaire, 10);
    const r2 = s.annulerSortie(s2.mouvement.id, 1);
    assert.equal(r2.article.quantite, 30);
    assert.equal(r2.article.prixUnitaire, 9.3333, 'CUMP = (20 × 10 + 10 × 8) / 30');
    await admin.ok('DELETE', '/api/articles/' + a.id);
    await admin.ok('DELETE', '/api/articles/' + b.id);
  });

  test('article sans seuil (0) : jamais « sous le seuil », ni alerte, ni notification', async () => {
    const alertesAvant = (await admin.ok('GET', '/api/stock-alertes')).length;
    const valoAvant = await admin.ok('GET', '/api/stock-valorisation');
    const a = await admin.ok('POST', '/api/articles', { designation: 'Joint torique 20 × 2 (non stocké)' });
    assert.equal(a.seuilMin, 0);
    assert.equal(a.quantite, 0);
    assert.equal(a.sousSeuil, false, 'un article sans seuil n\'est pas en alerte');
    assert.equal(a.quantiteACommander, 0);
    assert.equal((await admin.ok('GET', '/api/stock-alertes')).length, alertesAvant, 'aucune alerte ajoutée');
    assert.equal((await admin.ok('GET', '/api/stock-valorisation')).nbSousSeuil, valoAvant.nbSousSeuil);
    assert.ok(!(await admin.ok('GET', '/api/articles?sousSeuil=1')).some((x) => x.id === a.id));
    assert.ok(!srv.ctx.services.stock.alertes().some((x) => x.id === a.id), 'service alertes (tableau de bord)');
    // Un article sans seuil qui s'épuise n'émet pas d'alerte de seuil
    evenements.length = 0;
    await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: 2, prixUnitaire: 1 });
    const fin = await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 2 });
    assert.equal(fin.article.sousSeuil, false);
    assert.equal(fin.article.rupture, true, 'la rupture (stock nul) reste signalée');
    assert.equal(evenements.length, 0, 'pas d\'événement stock:sousSeuil sans seuil');
    // Dès qu'un seuil est défini, la règle habituelle s'applique
    const maj = await admin.ok('PUT', '/api/articles/' + a.id, { seuilMin: 1 });
    assert.equal(maj.sousSeuil, true);
    assert.ok((await admin.ok('GET', '/api/stock-alertes')).some((x) => x.id === a.id));
    await admin.ok('DELETE', '/api/articles/' + a.id);
  });

  test('journal des mouvements : un OT hors de la portée du lecteur n\'est ni nommé ni cherchable', async () => {
    const a = await admin.ok('POST', '/api/articles', { designation: 'Joint de presse (magasin central)', quantite: 10 });
    const ot = srv.db.insert('ot', { numero: 'OT-CONF-0001', titre: 'Remplacement joint presse — incident sécurité', statut: 'en_cours', equipementId: autreSecteurEq.id, secteurId: maint.id, pieces: [], createdBy: 1 });
    await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 2, otId: ot.id });
    assert.equal((await technicienProd.get('/api/ot/' + ot.id)).status, 404, 'OT invisible pour le technicien PROD');
    const fiche = await technicienProd.ok('GET', '/api/articles/' + a.id);
    const m = fiche.mouvements.find((x) => x.otId === ot.id);
    assert.ok(m, 'le mouvement reste visible');
    assert.equal(m.otMasque, true);
    assert.equal(m.otNumero, '');
    assert.equal(m.otTitre, 'Ordre de travail hors de votre périmètre');
    assert.equal(m.motif, 'Ordre de travail hors de votre périmètre', 'motif par défaut « OT n° — titre » masqué');
    assert.ok(!/incident sécurité|OT-CONF-0001/.test(JSON.stringify(fiche)), 'ni le titre ni le numéro ne fuient dans la fiche');
    const liste = await technicienProd.ok('GET', '/api/mouvements?articleId=' + a.id);
    assert.ok(liste.some((x) => x.otId === ot.id) && !/incident sécurité|OT-CONF-0001/.test(JSON.stringify(liste)));
    assert.equal((await technicienProd.ok('GET', '/api/mouvements?recherche=OT-CONF-0001')).length, 0, 'la recherche ne permet pas de sonder un numéro d\'OT');
    await admin.ok('PUT', '/api/utilisateurs/' + userId('tech.prod'), { overrides: { stock: { exporter: true } } });
    const techExport = srv.client(); await techExport.login('tech.prod', 'motdepasse1');
    const csv = await techExport.get('/api/mouvements-export?articleId=' + a.id);
    assert.equal(csv.status, 200);
    assert.ok(String(csv.body).includes('Hors périmètre') && !/incident sécurité|OT-CONF-0001/.test(String(csv.body)), 'export CSV masqué aussi');
    // L'administrateur et l'intervenant affecté voient l'OT
    assert.equal((await admin.ok('GET', '/api/articles/' + a.id)).mouvements.find((x) => x.otId === ot.id).otNumero, 'OT-CONF-0001');
    srv.db.update('ot', ot.id, { technicienId: userId('tech.prod') });
    const affecte = (await technicienProd.ok('GET', '/api/articles/' + a.id)).mouvements.find((x) => x.otId === ot.id);
    assert.equal(affecte.otNumero, 'OT-CONF-0001', 'intervenant affecté : OT visible');
    assert.equal(affecte.otMasque, false);
    srv.db.remove('ot', ot.id);
  });

  test('numérotation : une création refusée ne consomme pas de code d\'article', async () => {
    const compteur = () => srv.db.data.meta.numeros.art || 0;
    const premier = await admin.ok('POST', '/api/articles', { designation: 'Article numéroté' });
    const n = compteur();
    assert.equal((await admin.post('/api/articles', { designation: '' })).status, 400);
    assert.equal((await admin.post('/api/articles', { designation: 'X', seuilMin: -1 })).status, 400);
    assert.equal((await admin.post('/api/articles', { designation: 'X', fournisseurId: 99999 })).status, 400);
    assert.equal((await admin.post('/api/articles', { designation: 'X', quantite: -3 })).status, 400, 'quantité initiale invalide');
    assert.equal(compteur(), n, 'aucun code consommé');
    const suivant = await admin.ok('POST', '/api/articles', { designation: 'Article numéroté suivant' });
    assert.equal(compteur(), n + 1);
    assert.equal(Number(suivant.code.replace(/\D/g, '')), Number(premier.code.replace(/\D/g, '')) + 1, 'codes consécutifs');
    await admin.ok('DELETE', '/api/articles/' + suivant.id);
    await admin.ok('DELETE', '/api/articles/' + premier.id);
  });

  test('services : option silencieux pour les traitements en masse (mouvement enregistré, sans entrée de journal unitaire)', async () => {
    const s = srv.ctx.services.stock;
    const a = await admin.ok('POST', '/api/articles', { designation: 'Vis CHC M8 × 30 (boîte de 100)', quantite: 5 });
    const nbAudit = () => srv.db.count('audit', (x) => x.action === 'mouvement' && x.entite === 'articles' && x.entiteId === a.id);
    const avant = nbAudit();
    const inv = s.inventorier({ articleId: a.id, quantite: 7, userId: 1, motif: 'Inventaire INV-0001', silencieux: true });
    assert.equal(inv.mouvement.type, 'inventaire');
    assert.equal(inv.article.quantite, 7);
    assert.equal(s.entrer({ articleId: a.id, quantite: 3, userId: 1, motif: 'Réception', prixUnitaire: 2, silencieux: true }).article.quantite, 10);
    assert.equal(s.sortir({ articleId: a.id, quantite: 1, userId: 1, motif: 'Lot', silencieux: true }).article.quantite, 9);
    assert.equal(nbAudit(), avant, 'aucune entrée de journal pour les mouvements silencieux');
    assert.equal(srv.db.count('mouvementsStock', (m) => m.articleId === a.id), 4, 'les mouvements sont bien enregistrés (stock initial + 3)');
    s.inventorier({ articleId: a.id, quantite: 9, userId: 1, motif: 'Contrôle' });
    assert.equal(nbAudit(), avant + 1, 'sans l\'option, le journal est alimenté');
  });

  test('nombres : seule l\'écriture décimale est acceptée pour une chaîne (ni hexadécimal, ni exposant)', async () => {
    const a = await admin.ok('POST', '/api/articles', { designation: 'Rondelle M8', quantite: '12,5', seuilMin: ' 2 ', prixUnitaire: '0.4' });
    assert.equal(a.quantite, 12.5, 'virgule décimale acceptée');
    assert.equal(a.seuilMin, 2);
    assert.equal(a.prixUnitaire, 0.4);
    for (const [body, msg] of [[{ designation: 'X', seuilMin: '0x10' }, 'seuil hexadécimal'], [{ designation: 'X', quantite: '1e3' }, 'quantité en notation scientifique'], [{ designation: 'X', prixUnitaire: 'Infinity' }, 'prix infini']]) {
      assert.equal((await admin.post('/api/articles', body)).status, 400, msg);
    }
    assert.equal((await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: '0x10' })).status, 400, 'quantité de mouvement hexadécimale');
    assert.equal((await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: 1, prixUnitaire: '1e2' })).status, 400, 'prix de mouvement en notation scientifique');
    assert.equal(srv.db.get('articles', a.id).quantite, 12.5, 'aucun mouvement enregistré après les refus');
    await admin.ok('DELETE', '/api/articles/' + a.id);
  });

  test('données de démonstration : idempotentes, 15 articles, 3 sous le seuil, journal cohérent', async () => {
    const s2 = await demarrer();
    try {
      const stock = require('../server/modules/stock');
      const msg = stock.seedDemo(s2.ctx);
      assert.match(msg, /15 articles/);
      assert.equal(stock.seedDemo(s2.ctx), 'déjà présents', 'idempotent');
      const articles = s2.db.list('articles');
      assert.equal(articles.length, 15);
      assert.equal(articles.filter((a) => a.actif !== false && a.quantite <= a.seuilMin).length, 3, '3 articles sous le seuil');
      assert.ok(articles.every((a) => a.code && a.designation && a.prixUnitaire > 0 && a.emplacement));
      const mvts = s2.db.list('mouvementsStock');
      assert.ok(mvts.length >= 25, '~25 mouvements');
      const il61j = new Date(Date.now() - 61 * 86400000).toISOString();
      assert.ok(mvts.filter((m) => m.type !== 'inventaire' || m.motif.includes('tournant')).every((m) => m.date >= new Date(Date.now() - 75 * 86400000).toISOString()));
      assert.ok(mvts.filter((m) => m.date >= il61j).length >= 10, 'mouvements répartis sur les 60 derniers jours');
      for (const a of articles) {
        const ms = mvts.filter((m) => m.articleId === a.id).sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
        let q = 0;
        for (const m of ms) { assert.equal(m.quantiteAvant, q, `${a.code} : continuité du journal`); q = m.quantiteApres; }
        assert.equal(q, a.quantite, `${a.code} : quantité = dernier mouvement`);
      }
      const c = s2.client();
      await c.login('admin', 'admin');
      assert.equal((await c.ok('GET', '/api/stock-alertes')).length, 3);
    } finally { await s2.stop(); }
  });
});

describe('Stock : pièces dédiées à une ou plusieurs machines', () => {
  let srv, admin, techProd, profils, prod, maint;
  let ligne, machineA, sousA, machineB, pontMaint, isolee;
  const s = () => srv.ctx.services.stock;
  const userId = (login) => srv.db.findOne('users', (u) => u.login === login).id;
  const eq = (numero, nom, secteurId, parentId = null, extra = {}) => srv.db.insert('equipements', Object.assign({ numero, nom, secteurId, parentId, actif: true, typeCode: 'machine', etatCode: 'en_service' }, extra));

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    prod = secteurs.find((x) => x.code === 'PROD');
    maint = secteurs.find((x) => x.code === 'MAINT');
    profils = await admin.ok('GET', '/api/profils');
    ligne = eq('EQ-D01', 'Ligne de conditionnement', prod.id);
    machineA = eq('EQ-D02', 'Remplisseuse', prod.id, ligne.id);
    sousA = eq('EQ-D03', 'Moteur de la remplisseuse', prod.id, machineA.id);
    machineB = eq('EQ-D04', 'Presse hydraulique', prod.id);
    pontMaint = eq('EQ-D05', 'Pont roulant atelier', maint.id);
    isolee = eq('EQ-D06', 'Banc d\'essai provisoire', prod.id);
    await admin.ok('POST', '/api/utilisateurs', { login: 'tech.dedie', nom: 'Technicien', prenom: 'Tom', profilId: profils.find((p) => p.nom === 'Technicien').id, secteurIds: [prod.id], password: 'motdepasse1', doitChangerMdp: false, overrides: { stock: { exporter: true } } });
    techProd = srv.client();
    await techProd.login('tech.dedie', 'motdepasse1');
  });
  after(async () => { await srv.stop(); });

  test('article : champ reservee (défaut faux), inclureSousEquipements (défaut vrai), au moins un équipement exigé', async () => {
    const libre = await admin.ok('POST', '/api/articles', { designation: 'Graisse universelle', quantite: 10 });
    assert.equal(libre.reservee, false, 'pièce libre par défaut');
    assert.equal(libre.inclureSousEquipements, true);
    const ancien = srv.db.insert('articles', { code: 'ART-ANCIEN', designation: 'Article existant sans le champ', quantite: 4, equipementIds: [machineB.id], actif: true });
    assert.equal((await admin.ok('GET', '/api/articles/' + ancien.id)).reservee, false, 'article existant : non dédié (aucune migration de comportement)');
    assert.equal(s().utilisablePour(srv.db.get('articles', ancien.id), machineA.id).ok, true, 'liste indicative : utilisable partout');

    const refus = await admin.post('/api/articles', { designation: 'Roulement dédié', reservee: true });
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /au moins un équipement/);
    assert.equal((await admin.post('/api/articles', { designation: 'Roulement dédié', reservee: true, equipementIds: [] })).status, 400);
    assert.equal((await admin.post('/api/articles', { designation: 'Roulement dédié', reservee: 'oui', equipementIds: [machineA.id] })).status, 400, 'booléen strict');
    assert.equal((await admin.post('/api/articles', { designation: 'Roulement dédié', reservee: true, inclureSousEquipements: 1, equipementIds: [machineA.id] })).status, 400, 'booléen strict');

    const dedie = await admin.ok('POST', '/api/articles', { designation: 'Roulement dédié 6312', reservee: true, equipementIds: [machineA.id], quantite: 5 });
    assert.equal(dedie.reservee, true);
    assert.equal(dedie.inclureSousEquipements, true);
    assert.deepEqual(dedie.reserveeA, ['Remplisseuse']);
    assert.deepEqual(dedie.equipementsAutorisesIds.slice().sort((x, y) => x - y), [machineA.id, sousA.id].sort((x, y) => x - y));
    // Retirer tous les équipements d'une pièce dédiée est refusé ; une modification sans rapport reste possible
    assert.equal((await admin.put('/api/articles/' + dedie.id, { equipementIds: [] })).status, 400);
    assert.equal((await admin.ok('PUT', '/api/articles/' + dedie.id, { emplacement: 'A4' })).reservee, true, 'caractère dédié conservé');
    const libere = await admin.ok('PUT', '/api/articles/' + dedie.id, { reservee: false });
    assert.equal(libere.reservee, false);
    assert.deepEqual(libere.equipementIds, [machineA.id], 'les équipements deviennent la liste indicative');
    await admin.ok('PUT', '/api/articles/' + dedie.id, { reservee: true });
  });

  test('règle unique : sous-équipements inclus ou non, équipements autorisés, raison explicite', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-LIGNE', designation: 'Capteur de la ligne', reservee: true, equipementIds: [ligne.id], quantite: 3 });
    const brut = () => srv.db.get('articles', a.id);
    assert.deepEqual(s().equipementsAutorises(brut()).sort((x, y) => x - y), [ligne.id, machineA.id, sousA.id].sort((x, y) => x - y), 'descendants par parentId, tous niveaux');
    assert.equal(s().equipementsAutorises(srv.db.findOne('articles', (x) => x.designation === 'Graisse universelle')), null, 'pièce libre : null');
    assert.equal(s().utilisablePour(brut(), sousA.id).ok, true, 'petit-enfant autorisé');
    const non = s().utilisablePour(brut(), machineB.id);
    assert.equal(non.ok, false);
    assert.match(non.raison, /DED-LIGNE — Capteur de la ligne/);
    assert.match(non.raison, /Ligne de conditionnement \(EQ-D01\), sous-équipements compris/);
    assert.match(non.raison, /Presse hydraulique \(EQ-D04\)/);
    assert.match(s().utilisablePour(brut(), null).raison, /précisez l'équipement/);

    await admin.ok('PUT', '/api/articles/' + a.id, { inclureSousEquipements: false });
    assert.deepEqual(s().equipementsAutorises(brut()), [ligne.id], 'sans les sous-équipements');
    assert.equal(s().utilisablePour(brut(), machineA.id).ok, false);
    assert.doesNotMatch(s().utilisablePour(brut(), machineA.id).raison, /sous-équipements compris/);
    await admin.ok('PUT', '/api/articles/' + a.id, { inclureSousEquipements: true });
    // Rattachement d'un équipement à la ligne : autorisé aussitôt (règle évaluée à chaque utilisation)
    srv.db.update('equipements', isolee.id, { parentId: machineA.id });
    assert.equal(s().utilisablePour(brut(), isolee.id).ok, true);
    srv.db.update('equipements', isolee.id, { parentId: null });
    assert.equal(s().utilisablePour(brut(), isolee.id).ok, false);
  });

  test('service sortir : équipement de l\'OT ou explicite, refus clair sinon ; entrées et inventaires non restreints', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-SVC', designation: 'Joint de vérin dédié', reservee: true, equipementIds: [machineA.id], quantite: 20 });
    const otB = srv.db.insert('ot', { numero: 'OT-DED-0001', titre: 'Intervention presse', statut: 'en_cours', equipementId: machineB.id, secteurId: prod.id, pieces: [], createdBy: 1 });
    const otA = srv.db.insert('ot', { numero: 'OT-DED-0002', titre: 'Intervention remplisseuse', statut: 'en_cours', equipementId: sousA.id, secteurId: prod.id, pieces: [], createdBy: 1 });
    const otSans = srv.db.insert('ot', { numero: 'OT-DED-0003', titre: 'Intervention de secteur', statut: 'en_cours', equipementId: null, secteurId: prod.id, pieces: [], createdBy: 1 });
    assert.throws(() => s().sortir({ articleId: a.id, quantite: 1, userId: 1 }), (e) => e.status === 400 && /précisez l'équipement/.test(e.message));
    assert.throws(() => s().sortir({ articleId: a.id, quantite: 1, otId: otB.id, userId: 1 }), (e) => e.status === 400 && /DED-SVC/.test(e.message) && /Remplisseuse \(EQ-D02\)/.test(e.message) && /Presse hydraulique/.test(e.message));
    assert.throws(() => s().sortir({ articleId: a.id, quantite: 1, otId: otA.id, equipementId: machineB.id, userId: 1 }), (e) => e.status === 400 && /ne correspond pas/.test(e.message), 'équipement explicite différent de celui de l\'OT');
    assert.throws(() => s().sortir({ articleId: a.id, quantite: 1, otId: otSans.id, userId: 1 }), (e) => e.status === 400, 'OT sans équipement : équipement à préciser');
    assert.equal(srv.db.get('articles', a.id).quantite, 20, 'aucune sortie après les refus');
    const r = s().sortir({ articleId: a.id, quantite: 2, otId: otA.id, userId: 1 });
    assert.equal(r.mouvement.equipementId, sousA.id, 'équipement de l\'OT enregistré sur le mouvement');
    assert.equal(s().sortir({ articleId: a.id, quantite: 1, otId: otSans.id, equipementId: machineA.id, userId: 1 }).mouvement.equipementId, machineA.id);
    assert.equal(s().sortir({ articleId: a.id, quantite: 1, equipementId: machineA.id, userId: 1 }).mouvement.equipementId, machineA.id);
    assert.equal(s().entrer({ articleId: a.id, quantite: 5, userId: 1, motif: 'Réception' }).article.quantite, 21, 'entrée non restreinte');
    assert.equal(s().inventorier({ articleId: a.id, quantite: 30, userId: 1 }).article.quantite, 30, 'inventaire non restreint');
    const retour = s().annulerSortie(r.mouvement.id, 1);
    assert.equal(retour.mouvement.type, 'retour');
    assert.equal(retour.mouvement.equipementId, sousA.id, 'retour : équipement de la sortie conservé (traçabilité), sans restriction');
    // Pièce libre : jamais restreinte, équipement de l'OT tout de même tracé
    const libre = srv.db.findOne('articles', (x) => x.designation === 'Graisse universelle');
    assert.equal(s().sortir({ articleId: libre.id, quantite: 1, otId: otB.id, userId: 1 }).mouvement.equipementId, machineB.id);
    assert.equal(s().sortir({ articleId: libre.id, quantite: 1, userId: 1 }).mouvement.equipementId, null);
  });

  test('sortie manuelle : equipementId obligatoire pour une pièce dédiée sans OT, enregistré, affiché et exporté', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-MAN', designation: 'Courroie dédiée', reservee: true, equipementIds: [machineA.id, machineB.id], quantite: 10 });
    const sans = await techProd.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1 });
    assert.equal(sans.status, 400);
    assert.match(sans.body.erreur, /DED-MAN — Courroie dédiée/);
    assert.match(sans.body.erreur, /Presse hydraulique \(EQ-D04\) et Remplisseuse \(EQ-D02\)/);
    const mauvais = await techProd.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: isolee.id });
    assert.equal(mauvais.status, 400);
    assert.match(mauvais.body.erreur, /ne peut pas être utilisée sur Banc d'essai provisoire/);
    assert.equal((await techProd.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: 999999 })).status, 400, 'équipement inexistant');
    assert.equal((await techProd.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: pontMaint.id })).status, 400, 'équipement hors périmètre');
    const ok = await techProd.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 2, equipementId: machineB.id, motif: 'Remplacement' });
    assert.equal(ok.mouvement.equipementId, machineB.id);
    assert.equal(ok.mouvement.equipementNom, 'Presse hydraulique');
    assert.equal(ok.article.quantite, 8);
    assert.equal((await techProd.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'entree', quantite: 1 })).article.quantite, 9, 'entrée sans équipement');
    assert.equal((await techProd.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'inventaire', quantite: 12 })).article.quantite, 12, 'inventaire sans équipement');
    // Pièce libre : l'équipement destinataire est facultatif mais enregistré
    const libre = srv.db.findOne('articles', (x) => x.designation === 'Graisse universelle');
    assert.equal((await techProd.ok('POST', `/api/articles/${libre.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: isolee.id })).mouvement.equipementNumero, 'EQ-D06');
    // Historique, journal et export
    const fiche = await techProd.ok('GET', '/api/articles/' + a.id);
    const m = fiche.mouvements.find((x) => x.id === ok.mouvement.id);
    assert.equal(m.equipementNom, 'Presse hydraulique');
    assert.equal(m.equipementNumero, 'EQ-D04');
    assert.ok((await techProd.ok('GET', `/api/mouvements?equipementId=${machineB.id}`)).some((x) => x.id === ok.mouvement.id), 'filtre du journal par équipement');
    assert.ok((await techProd.ok('GET', '/api/mouvements?recherche=EQ-D04')).some((x) => x.id === ok.mouvement.id), 'recherche par équipement');
    const csv = (await techProd.get('/api/mouvements-export?articleId=' + a.id)).body.split('\r\n');
    assert.ok(csv[0].includes(';OT;Équipement;Fournisseur;'), 'colonne Équipement : ' + csv[0]);
    assert.ok(csv.some((l) => l.includes(';EQ-D04 Presse hydraulique;')), 'équipement exporté');
    assert.ok(srv.db.list('audit', (x) => x.action === 'mouvement' && x.entiteId === a.id).some((x) => /pour EQ-D04 Presse hydraulique/.test(x.details)), 'journal : équipement destinataire');
    // Retour d'une sortie manuelle : équipement conservé
    const retour = await techProd.ok('POST', `/api/mouvements/${ok.mouvement.id}/annuler`, {});
    assert.equal(retour.mouvement.equipementNom, 'Presse hydraulique');
  });

  test('suppression du dernier équipement : pièce dédiée inutilisable, signalée « à réaffecter », Stock › Modifier notifiés ; équipement réformé conservé', async () => {
    const provisoire = eq('EQ-D07', 'Machine provisoire', prod.id);
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-ORPH', designation: 'Filtre spécifique', reservee: true, equipementIds: [provisoire.id], quantite: 4 });
    const multi = await admin.ok('POST', '/api/articles', { code: 'DED-MULTI', designation: 'Filtre partagé', reservee: true, equipementIds: [provisoire.id, machineB.id], quantite: 4 });
    const notifsAvant = srv.db.count('notifications', (n) => n.userId === userId('tech.dedie'));
    const r = await admin.ok('DELETE', '/api/equipements/' + provisoire.id);
    assert.equal(r.desactive, false);
    assert.equal(r.piecesAReaffecter, 1);
    const apres = await admin.ok('GET', '/api/articles/' + a.id);
    assert.equal(apres.reservee, true, 'reste dédiée');
    assert.deepEqual(apres.equipementIds, []);
    assert.equal(apres.sansEquipement, true);
    assert.match(apres.reserveeTexte, /à réaffecter/);
    assert.deepEqual(apres.equipementsAutorisesIds, []);
    const refus = await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: machineB.id });
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /n'est plus affectée à aucun équipement/);
    assert.equal((await admin.ok('GET', '/api/articles/' + multi.id)).sansEquipement, false, 'pièce encore affectée à un autre équipement');
    assert.deepEqual(srv.db.get('articles', multi.id).equipementIds, [machineB.id]);
    const notifs = srv.db.list('notifications', (n) => n.userId === userId('tech.dedie')).slice(notifsAvant);
    assert.equal(notifs.filter((n) => /Pièce dédiée sans équipement/.test(n.titre)).length, 1, 'technicien (Stock › Modifier, article visible) notifié une fois');
    assert.ok(notifs.some((n) => n.lien === `#/stock/${a.id}` && /Filtre spécifique/.test(n.message)));
    assert.ok(srv.db.list('notifications', (n) => n.userId === 1).some((n) => /Pièce dédiée sans équipement/.test(n.titre)), 'administrateur notifié');
    assert.ok(srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === a.id).some((x) => /suppression de l'équipement EQ-D07 Machine provisoire/.test(x.details) && /à réaffecter/.test(x.details)));
    // Réaffectation
    const reaffecte = await admin.ok('PUT', '/api/articles/' + a.id, { equipementIds: [machineB.id] });
    assert.equal(reaffecte.sansEquipement, false);
    // Équipement réformé ou désactivé : conservé dans la liste, signalé « réformé »
    srv.db.update('equipements', machineB.id, { etatCode: 'reforme' });
    const reforme = await admin.ok('GET', '/api/articles/' + a.id);
    assert.deepEqual(reforme.equipementIds, [machineB.id]);
    assert.equal(reforme.reserveeEquipements[0].reforme, true);
    assert.match(reforme.reserveeTexte, /Presse hydraulique \(EQ-D04, réformé\)/);
    srv.db.update('equipements', machineB.id, { etatCode: 'en_service' });
  });

  test('liste, filtre « pièces dédiées / pièces libres » et export CSV (colonnes Dédiée et Équipements)', async () => {
    const dediees = await admin.ok('GET', '/api/articles?reservee=1');
    const libres = await admin.ok('GET', '/api/articles?reservee=0');
    const tous = await admin.ok('GET', '/api/articles');
    assert.ok(dediees.length >= 4 && dediees.every((a) => a.reservee === true));
    assert.ok(libres.length >= 2 && libres.every((a) => a.reservee === false));
    assert.equal(dediees.length + libres.length, tous.length);
    assert.equal((await admin.get('/api/articles?reservee=peut-etre')).status, 400);
    const csv = (await admin.get('/api/articles-export')).body.split('\r\n');
    const entetes = csv[0].replace(/^﻿/, '').split(';');
    const iD = entetes.indexOf('Dédiée'); const iE = entetes.indexOf('Équipements');
    assert.ok(iD > 0 && iE === iD + 1, 'colonnes Dédiée puis Équipements : ' + csv[0]);
    const ligneDe = (code) => csv.find((l) => l.startsWith(code + ';')).split(';');
    assert.equal(ligneDe('DED-LIGNE')[iD], 'Oui');
    assert.equal(ligneDe('DED-LIGNE')[iE], 'Ligne de conditionnement (EQ-D01), sous-équipements compris');
    assert.equal(ligneDe('ART-ANCIEN')[iD], 'Non');
    assert.equal(ligneDe('ART-ANCIEN')[iE], 'Presse hydraulique (EQ-D04)', 'pièce libre : équipements compatibles');
    const filtre = (await admin.get('/api/articles-export?reservee=1')).body.split('\r\n').slice(1).filter(Boolean);
    assert.equal(filtre.length, dediees.length, 'filtre appliqué à l\'export');
  });

  test('visibilité : équipements hors périmètre comptés mais jamais nommés (liste, refus, export, journal des mouvements)', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-VIS', designation: 'Câble de levage', reservee: true, equipementIds: [machineB.id, pontMaint.id], quantite: 6 });
    const vu = (await techProd.ok('GET', '/api/articles')).find((x) => x.id === a.id);
    assert.deepEqual(vu.reserveeA, ['Presse hydraulique']);
    assert.equal(vu.reserveeHorsPerimetre, 1);
    assert.equal(vu.reserveeTexte, 'Presse hydraulique (EQ-D04) et 1 équipement(s) hors de votre périmètre');
    assert.deepEqual(vu.equipementsAutorisesIds, [machineB.id], 'identifiants hors périmètre non transmis');
    const refus = await techProd.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: machineA.id });
    assert.equal(refus.status, 400);
    assert.match(refus.body.erreur, /Presse hydraulique \(EQ-D04\) et 1 équipement\(s\) hors de votre périmètre/);
    assert.doesNotMatch(refus.body.erreur, /Pont roulant/);
    const pourAdmin = await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: machineA.id });
    assert.match(pourAdmin.body.erreur, /Pont roulant atelier \(EQ-D05\)/, 'l\'administrateur voit tous les équipements autorisés');
    const ligneCsv = (await techProd.get('/api/articles-export')).body.split('\r\n').find((l) => l.startsWith('DED-VIS;'));
    assert.ok(ligneCsv.includes(';Presse hydraulique (EQ-D04) et 1 équipement(s) hors de votre périmètre;') && !ligneCsv.includes('Pont roulant'), ligneCsv);
    // Sortie sur l'équipement hors périmètre (administrateur) : masquée pour le technicien
    const m = await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: pontMaint.id });
    const vus = await techProd.ok('GET', '/api/mouvements?articleId=' + a.id);
    const x = vus.find((y) => y.id === m.mouvement.id);
    assert.equal(x.equipementMasque, true);
    assert.equal(x.equipementNom, 'Équipement hors de votre périmètre');
    assert.equal(x.equipementId, null);
    assert.ok(!/Pont roulant|EQ-D05/.test(JSON.stringify(vus)), 'ni le nom ni le numéro ne fuient');
    assert.equal((await techProd.ok('GET', `/api/mouvements?equipementId=${pontMaint.id}`)).length, 0, 'pas de sondage par identifiant');
    const csv = (await techProd.get('/api/mouvements-export?articleId=' + a.id)).body;
    assert.ok(csv.includes(';Hors périmètre;') && !/Pont roulant|EQ-D05/.test(csv));
    // Fiche : sous-équipements autorisés par héritage
    const capteur = srv.db.findOne('articles', (y) => y.code === 'DED-LIGNE');
    const fiche = await techProd.ok('GET', '/api/articles/' + capteur.id);
    assert.deepEqual(fiche.sousEquipementsAutorises.map((e) => e.nom).sort(), ['Moteur de la remplisseuse', 'Remplisseuse']);
    assert.ok(fiche.sousEquipementsAutorises.every((e) => e.viaNom === 'Ligne de conditionnement'));
  });

  test('journal : création et modification du caractère dédié ou des équipements en clair', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'DED-JRN', designation: 'Bague d\'usure', reservee: true, equipementIds: [machineA.id] });
    const lignes = () => srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === a.id).map((x) => x.details);
    assert.ok(lignes().some((d) => /pièce dédiée à EQ-D02 Remplisseuse, sous-équipements compris/.test(d)), lignes().join('\n'));
    await admin.ok('PUT', '/api/articles/' + a.id, { equipementIds: [machineA.id, machineB.id], inclureSousEquipements: false });
    const d1 = lignes().pop();
    assert.match(d1, /équipements autorisés ajoutés : EQ-D04 Presse hydraulique/);
    assert.match(d1, /sous-équipements désormais exclus/);
    assert.match(d1, /\(équipements, sous-équipements\)/, 'champs modifiés en français');
    await admin.ok('PUT', '/api/articles/' + a.id, { reservee: false });
    assert.match(lignes().pop(), /n'est plus une pièce dédiée/);
    await admin.ok('PUT', '/api/articles/' + a.id, { reservee: true, equipementIds: [machineB.id] });
    const d3 = lignes().pop();
    assert.match(d3, /devient une pièce dédiée/);
    assert.match(d3, /équipements autorisés retirés : EQ-D02 Remplisseuse/);
  });

  test('références du stock et résolution d\'un code scanné : restriction indiquée', async () => {
    const refs = await techProd.ok('GET', '/api/stock-references');
    const e = refs.equipements.find((x) => x.id === sousA.id);
    assert.equal(e.parentId, machineA.id, 'arborescence transmise pour le choix du destinataire');
    const code = await techProd.ok('GET', '/api/codes?code=DED-LIGNE');
    assert.equal(code.type, 'article');
    assert.equal(code.details.reservee, true);
    assert.deepEqual(code.details.reserveeA, ['Ligne de conditionnement']);
    assert.match(code.details.reserveeTexte, /sous-équipements compris/);
    assert.equal((await techProd.ok('GET', '/api/codes?code=ART-ANCIEN')).details.reservee, false);
  });

  test('données de démonstration : pièces dédiées à des machines de la démonstration, idempotentes', async () => {
    const s2 = await demarrer();
    try {
      const { seedDemo } = require('../server/modules');
      seedDemo(s2.ctx);
      const dediees = s2.db.list('articles', (a) => a.reservee === true);
      assert.ok(dediees.length >= 2 && dediees.length <= 3, `${dediees.length} pièces dédiées`);
      for (const a of dediees) {
        assert.ok(a.equipementIds.length && a.equipementIds.every((id) => s2.db.get('equipements', id)), `${a.designation} : machines existantes`);
      }
      seedDemo(s2.ctx);
      assert.equal(s2.db.count('articles', (a) => a.reservee === true), dediees.length, 'idempotent');
      // Les sorties de démonstration respectent la règle (équipement autorisé enregistré)
      for (const a of dediees) {
        const autorises = s2.ctx.services.stock.equipementsAutorises(a);
        const sorties = s2.db.list('mouvementsStock', (m) => m.articleId === a.id && m.type === 'sortie');
        assert.ok(sorties.every((m) => m.equipementId != null && autorises.includes(m.equipementId)), `${a.designation} : sorties sur un équipement autorisé`);
      }
    } finally { await s2.stop(); }
  });
});

describe('Stock : pièces dédiées — visibilité, sites, droits et journal', () => {
  let srv, admin, prod, maint, site2, prod2, profils;
  let ligne, remplisseuse, moteur, presse, secret, valreas;
  const eq = (numero, nom, secteurId, parentId = null) => srv.db.insert('equipements', { numero, nom, secteurId, parentId, actif: true, typeCode: 'machine', etatCode: 'en_service' });
  const technicien = async (login, extra = {}) => {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: 'Contrôle', prenom: login, profilId: profils.find((p) => p.nom === 'Technicien').id, secteurIds: [prod.id], password: 'motdepasse1', doitChangerMdp: false }, extra));
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return c;
  };
  const userId = (login) => srv.db.findOne('users', (u) => u.login === login).id;
  const derniereLigne = (articleId) => srv.db.list('audit', (x) => x.entite === 'articles' && x.entiteId === articleId).map((x) => x.details).pop();

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    prod = secteurs.find((x) => x.code === 'PROD');
    maint = secteurs.find((x) => x.code === 'MAINT');
    site2 = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    prod2 = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: site2.id });
    profils = await admin.ok('GET', '/api/profils');
    ligne = eq('EQ-V01', 'Ligne de conditionnement', prod.id);
    remplisseuse = eq('EQ-V02', 'Remplisseuse', prod.id, ligne.id);
    moteur = eq('EQ-V03', 'Moteur de la remplisseuse', prod.id, remplisseuse.id);
    presse = eq('EQ-V04', 'Presse hydraulique', prod.id);
    secret = eq('EQ-V05', 'Machine confidentielle maintenance', maint.id);
    valreas = eq('EQ-V06', 'Presse de Valréas', prod2.id);
  });
  after(async () => { await srv.stop(); });

  test('mouvement vers un équipement hors périmètre supprimé : nom, numéro et identifiant restent masqués (journal, fiche, export, filtre)', async () => {
    const tech = await technicien('tech.vis', { overrides: { stock: { exporter: true } } });
    const techMaint = await technicien('tech.maint', { secteurIds: [maint.id] });
    const a = await admin.ok('POST', '/api/articles', { code: 'VIS-1', designation: 'Câble partagé', quantite: 20, reservee: true, equipementIds: [presse.id, secret.id] });
    const mv = (await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: secret.id })).mouvement;
    assert.equal(srv.db.get('mouvementsStock', mv.id).equipementSecteurId, maint.id, 'secteur de l\'équipement conservé sur le mouvement');
    assert.equal(mv.equipementSecteurId, undefined, 'information interne non renvoyée');
    // Équipement destinataire de sorties : désactivé (traçabilité), jamais supprimé par l'API
    const d = await admin.ok('DELETE', '/api/equipements/' + secret.id);
    assert.equal(d.desactive, true);
    assert.equal(d.references.mouvements, 1);
    assert.ok(srv.db.get('equipements', secret.id), 'équipement conservé');
    // Équipement supprimé malgré tout (base antérieure, suppression directe) : la visibilité reste évaluée sur son secteur
    srv.db.remove('equipements', secret.id);
    const fuite = (t) => /confidentielle|EQ-V05/.test(t);
    const ligneTech = (await tech.ok('GET', '/api/mouvements?articleId=' + a.id)).find((m) => m.id === mv.id);
    assert.equal(ligneTech.equipementMasque, true);
    assert.equal(ligneTech.equipementId, null);
    assert.equal(ligneTech.equipementNom, 'Équipement hors de votre périmètre');
    assert.ok(!fuite(JSON.stringify(ligneTech)), JSON.stringify(ligneTech));
    const fiche = await tech.ok('GET', '/api/articles/' + a.id);
    assert.ok(!fuite(JSON.stringify(fiche.mouvements)), 'fiche de l\'article');
    const csv = String((await tech.get('/api/mouvements-export?articleId=' + a.id)).body);
    assert.ok(!fuite(csv), 'export');
    assert.match(csv, /Hors périmètre/);
    assert.deepEqual(await tech.ok('GET', '/api/mouvements?equipementId=' + secret.id), [], 'pas de sondage par identifiant');
    assert.deepEqual(await tech.ok('GET', '/api/mouvements?recherche=confidentielle'), [], 'pas de sondage par la recherche');
    // Lecteur du secteur de l'équipement, et portée « tous » : libellé conservé, mention « supprimé »
    const vuMaint = (await techMaint.ok('GET', '/api/mouvements?equipementId=' + secret.id)).find((m) => m.id === mv.id);
    assert.equal(vuMaint && vuMaint.equipementNom, 'EQ-V05 — Machine confidentielle maintenance (supprimé)');
    const vuAdmin = (await admin.ok('GET', '/api/mouvements?articleId=' + a.id)).find((m) => m.id === mv.id);
    assert.equal(vuAdmin.equipementMasque, false);
    assert.equal(vuAdmin.equipementId, secret.id);
    // Mouvement antérieur (secteur de l'équipement inconnu) : masqué sauf en portée « tous »
    const ancien = srv.db.insert('mouvementsStock', { articleId: a.id, type: 'sortie', quantite: 1, quantiteAvant: 19, quantiteApres: 18, date: new Date().toISOString(), userId: 1, otId: null, motif: '', prixUnitaire: 0, equipementId: 99999, equipementLibelle: 'EQ-ANC — Ancienne machine secrète' });
    const ancTech = (await tech.ok('GET', '/api/mouvements?articleId=' + a.id)).find((m) => m.id === ancien.id);
    assert.equal(ancTech.equipementMasque, true);
    assert.ok(!/Ancienne machine/.test(JSON.stringify(ancTech)));
    assert.match((await admin.ok('GET', '/api/mouvements?articleId=' + a.id)).find((m) => m.id === ancien.id).equipementNom, /Ancienne machine secrète \(supprimé\)/);
    // Retour en stock de la sortie : secteur repris
    const retour = await admin.ok('POST', `/api/mouvements/${mv.id}/annuler`, {});
    assert.equal(srv.db.get('mouvementsStock', retour.mouvement.id).equipementSecteurId, maint.id);
    assert.ok(!fuite(JSON.stringify((await tech.ok('GET', '/api/mouvements?articleId=' + a.id)).find((m) => m.id === retour.mouvement.id))));
  });

  test('site en lecture seule : la liste affichée se renvoie telle quelle, un ajout ou un retrait de ses équipements est refusé explicitement', async () => {
    const lect = await technicien('tech.lect', { siteAcces: [{ siteId: site2.id, mode: 'lecture' }], overrides: { stock: { creer: true } } });
    const a = await admin.ok('POST', '/api/articles', { code: 'SITE-1', designation: 'Pièce multi-site', quantite: 5, reservee: true, equipementIds: [presse.id, valreas.id] });
    const vu = await lect.ok('GET', '/api/articles/' + a.id);
    assert.deepEqual(vu.reserveeA.slice().sort(), ['Presse de Valréas', 'Presse hydraulique']);
    // Formulaire renvoyé tel quel (seul l'emplacement change) : accepté, réponse calculée comme un GET
    const r = await lect.ok('PUT', '/api/articles/' + a.id, { equipementIds: vu.equipementIds, reservee: true, inclureSousEquipements: true, emplacement: 'B2' });
    assert.equal(r.emplacement, 'B2');
    assert.deepEqual(r.reserveeA.slice().sort(), ['Presse de Valréas', 'Presse hydraulique'], 'réponse du PUT identique à la lecture');
    // Retrait de l'équipement en lecture seule : refus explicite, rien n'est modifié
    const retrait = await lect.put('/api/articles/' + a.id, { equipementIds: [presse.id] });
    assert.equal(retrait.status, 403);
    assert.match(retrait.body.erreur, /Presse de Valréas.*lecture seule.*ne peut pas être retiré/);
    assert.deepEqual(srv.db.get('articles', a.id).equipementIds.slice().sort(), [presse.id, valreas.id].sort());
    // Ajout d'un équipement en lecture seule : refus explicite
    const libre = await admin.ok('POST', '/api/articles', { code: 'SITE-2', designation: 'Pièce libre', quantite: 1 });
    const ajout = await lect.put('/api/articles/' + libre.id, { equipementIds: [valreas.id] });
    assert.equal(ajout.status, 403);
    assert.match(ajout.body.erreur, /lecture seule.*ne peut pas être ajouté/);
    // Libellés : « autorisé » pour une pièce dédiée, « compatible » pour une pièce libre
    assert.match((await admin.put('/api/articles/' + a.id, { equipementIds: [presse.id, 99999] })).body.erreur, /Équipement autorisé introuvable \(#99999\)/);
    assert.match((await admin.put('/api/articles/' + libre.id, { equipementIds: [99999] })).body.erreur, /Équipement compatible introuvable \(#99999\)/);
  });

  test('réservation : droit Stock › Créer, refus tant que des équipements autorisés sont hors du périmètre, gestionnaires prévenus quand la pièce devient libre', async () => {
    const tech = await technicien('tech.resa');
    const magasinier = await technicien('mag.resa', { overrides: { stock: { creer: true } } });
    const secret2 = eq('EQ-V07', 'Compresseur de la maintenance', maint.id);
    const cachee = await admin.ok('POST', '/api/articles', { code: 'RESA-1', designation: 'Cartouche réservée maintenance', quantite: 5, reservee: true, equipementIds: [secret2.id] });
    const visible = await admin.ok('POST', '/api/articles', { code: 'RESA-2', designation: 'Joint de la presse', quantite: 5, reservee: true, equipementIds: [presse.id] });
    const libre = await admin.ok('POST', '/api/articles', { code: 'RESA-3', designation: 'Graisse', quantite: 5 });
    // Technicien (Stock › Modifier seulement) : ni levée de la réservation, ni changement de liste ou des sous-équipements
    for (const corps of [{ reservee: false }, { equipementIds: [presse.id, remplisseuse.id] }, { inclureSousEquipements: false }]) {
      const r = await tech.put('/api/articles/' + visible.id, corps);
      assert.equal(r.status, 403, JSON.stringify(corps));
      assert.match(r.body.erreur, /Stock › Créer/);
    }
    assert.equal((await tech.put('/api/articles/' + cachee.id, { reservee: false })).status, 403);
    assert.equal(srv.db.get('articles', cachee.id).reservee, true, 'réservation conservée');
    // … mais le formulaire renvoyé sans changement de réservation, et les équipements compatibles d'une pièce libre, restent modifiables
    assert.equal((await tech.ok('PUT', '/api/articles/' + visible.id, { emplacement: 'C1', reservee: true, inclureSousEquipements: true, equipementIds: [presse.id] })).emplacement, 'C1');
    assert.deepEqual((await tech.ok('PUT', '/api/articles/' + libre.id, { equipementIds: [presse.id] })).equipementIds, [presse.id]);
    assert.equal((await tech.post(`/api/articles/${cachee.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: presse.id })).status, 400, 'pièce toujours refusée sur une autre machine');
    // Stock › Créer, mais équipement autorisé hors de son périmètre : refus
    const hors = await magasinier.put('/api/articles/' + cachee.id, { reservee: false });
    assert.equal(hors.status, 403);
    assert.match(hors.body.erreur, /1 équipement\(s\) hors de votre périmètre/);
    assert.equal((await magasinier.put('/api/articles/' + cachee.id, { equipementIds: [secret2.id, presse.id] })).status, 403, 'ajout de son propre équipement refusé');
    // Stock › Créer, tous les équipements visibles : réservation levée, gestionnaires du stock prévenus (pas l'auteur)
    const n0 = srv.db.list('notifications').length;
    assert.equal((await magasinier.ok('PUT', '/api/articles/' + visible.id, { reservee: false })).reservee, false);
    const notes = srv.db.list('notifications').slice(n0).filter((n) => n.titre === 'Pièce dédiée devenue libre');
    assert.ok(notes.some((n) => n.userId === userId('admin') && /RESA-2/.test(n.message)), 'administrateur prévenu');
    assert.ok(!notes.some((n) => n.userId === userId('mag.resa')), 'auteur non prévenu');
    assert.ok(!notes.some((n) => n.userId === userId('tech.resa')), 'technicien sans Stock › Créer non prévenu');
  });

  test('journal : un article antérieur aux pièces dédiées ne cite que les champs réellement modifiés', async () => {
    const ancien = srv.db.insert('articles', { code: 'ANC-1', designation: 'Article ancien', quantite: 3, uniteCode: 'u', equipementIds: [], emplacement: 'A1', actif: true });
    // Corps envoyé par le formulaire : reservee et inclureSousEquipements toujours présents, textes vides
    await admin.ok('PUT', '/api/articles/' + ancien.id, { designation: 'Article ancien', description: '', emplacement: 'A2', referenceFournisseur: '', reservee: false, inclureSousEquipements: true, equipementIds: [], champs: {} });
    const d = derniereLigne(ancien.id);
    assert.match(d, /\(emplacement\)$/, d);
    assert.doesNotMatch(d, /pièce dédiée|sous-équipements|description|référence/);
  });

  test('identifiants : écriture décimale seulement (booléen, tableau, hexadécimal, exposant refusés)', async () => {
    const a = await admin.ok('POST', '/api/articles', { code: 'ID-1', designation: 'Pièce de ligne', quantite: 50, reservee: true, equipementIds: [ligne.id, presse.id], inclureSousEquipements: false });
    for (const v of [true, [presse.id], `0x${presse.id.toString(16)}`, `${presse.id}e0`, presse.id + 0.5, -presse.id, { id: presse.id }]) {
      const r = await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: v });
      assert.equal(r.status, 400, JSON.stringify(v));
      assert.match(r.body.erreur, /identifiant invalide/);
    }
    assert.equal((await admin.ok('POST', `/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, equipementId: ` ${presse.id} ` })).mouvement.equipementId, presse.id, 'chaîne décimale acceptée');
    assert.equal((await admin.post('/api/articles', { designation: 'Liste invalide', equipementIds: [true] })).status, 400);
    assert.equal((await admin.post(`/api/articles/${a.id}/mouvements`, { type: 'sortie', quantite: 1, otId: '0x1' })).status, 400);
    assert.throws(() => srv.ctx.services.stock.sortir({ articleId: a.id, quantite: 1, equipementId: true, userId: 1 }), /identifiant invalide/);
  });

  test('liste filtrée sur un équipement : pièces libres compatibles et pièces dédiées utilisables, sous-équipements compris', async () => {
    const tech = await technicien('tech.filtre');
    const deLigne = await admin.ok('POST', '/api/articles', { code: 'FIL-1', designation: 'Capteur de la ligne', reservee: true, equipementIds: [ligne.id] });
    const deRemp = await admin.ok('POST', '/api/articles', { code: 'FIL-2', designation: 'Roulement de la remplisseuse', reservee: true, equipementIds: [remplisseuse.id] });
    const compat = await admin.ok('POST', '/api/articles', { code: 'FIL-3', designation: 'Graisse compatible', equipementIds: [remplisseuse.id] });
    const dePresse = await admin.ok('POST', '/api/articles', { code: 'FIL-4', designation: 'Joint de presse', reservee: true, equipementIds: [presse.id] });
    const sansSous = await admin.ok('POST', '/api/articles', { code: 'FIL-5', designation: 'Carter de ligne', reservee: true, equipementIds: [ligne.id], inclureSousEquipements: false });
    const ids = (await admin.ok('GET', '/api/articles?equipementId=' + remplisseuse.id)).map((x) => x.id);
    for (const x of [deLigne, deRemp, compat]) assert.ok(ids.includes(x.id), x.code);
    for (const x of [dePresse, sansSous]) assert.ok(!ids.includes(x.id), x.code);
    assert.ok((await admin.ok('GET', '/api/articles?equipementId=' + moteur.id)).some((x) => x.id === deRemp.id), 'sous-équipement');
    const csv = String((await admin.get('/api/articles-export?equipementId=' + remplisseuse.id)).body);
    assert.match(csv, /FIL-1/);
    assert.doesNotMatch(csv, /FIL-4/);
    // Équipement hors de la portée du lecteur : aucun résultat (pas de sondage par identifiant)
    await admin.ok('POST', '/api/articles', { code: 'FIL-6', designation: 'Pièce maintenance', equipementIds: [valreas.id] });
    assert.deepEqual(await tech.ok('GET', '/api/articles?equipementId=' + valreas.id), []);
  });
});
