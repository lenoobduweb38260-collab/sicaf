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
