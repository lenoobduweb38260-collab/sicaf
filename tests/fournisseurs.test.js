'use strict';
/**
 * Tests du module Fournisseurs & prestataires : CRUD, validation stricte des entrées, unicité du nom
 * (insensible à la casse) et du SIRET, contacts multiples, champs personnalisés, filtres de liste,
 * détail enrichi (articles, équipements, OT externes avec coûts, total des achats), portée des
 * éléments liés par secteur, droits (403), suppression / désactivation, duplication, export CSV,
 * notifications, événements, services publiés et données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Module Fournisseurs & prestataires', () => {
  let srv, admin, prod, maint, profils;
  let technicienProd, chefProd, demandeur, techSansStock;
  const evenements = [];

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    profils = await admin.ok('GET', '/api/profils');
    for (const e of ['fournisseur:cree', 'fournisseur:modifie', 'fournisseur:desactive', 'fournisseur:supprime']) srv.ctx.on(e, (d) => evenements.push({ e, d }));

    technicienProd = await creerUtilisateur('tech.prod', 'Technicien', [prod.id]);
    chefProd = await creerUtilisateur('chef.prod', 'Chef de secteur', [prod.id]);
    demandeur = await creerUtilisateur('demandeur', 'Demandeur', [prod.id]);
    techSansStock = await creerUtilisateur('tech.sansstock', 'Technicien', [prod.id], { overrides: { stock: { voir: false, modifier: false } } });
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
  const derniersAudits = (n) => srv.db.list('audit').slice(-n);

  test('authentification requise', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/fournisseurs')).status, 401);
    assert.equal((await anonyme.post('/api/fournisseurs', { nom: 'X' })).status, 401);
  });

  test('création : validation stricte des entrées', async () => {
    const cas = [
      [{}, 'nom obligatoire'],
      [{ nom: '   ' }, 'nom vide'],
      [{ nom: 'X'.repeat(151) }, 'nom trop long'],
      [{ nom: { a: 1 } }, 'nom non textuel'],
      [{ nom: 'X', typeCode: 'grossiste' }, 'type inconnu'],
      [{ nom: 'X', email: 'pas-un-email' }, 'e-mail invalide'],
      [{ nom: 'X', email: 'a@b' }, 'e-mail sans domaine'],
      [{ nom: 'X', telephone: 'appeler Paul' }, 'téléphone invalide'],
      [{ nom: 'X', siteWeb: 'pas un site' }, 'site web invalide'],
      [{ nom: 'X', siteWeb: 'ftp://exemple.fr' }, 'protocole non web'],
      [{ nom: 'X', siret: '123 456' }, 'SIRET trop court'],
      [{ nom: 'X', siret: '1234567890123A' }, 'SIRET non numérique'],
      [{ nom: 'X', delaiLivraisonJours: -1 }, 'délai négatif'],
      [{ nom: 'X', delaiLivraisonJours: 'demain' }, 'délai non numérique'],
      [{ nom: 'X', delaiLivraisonJours: 2.5 }, 'délai non entier'],
      [{ nom: 'X', delaiLivraisonJours: 1000 }, 'délai trop grand'],
      [{ nom: 'X', actif: 'peut-être' }, 'actif non booléen'],
      [{ nom: 'X', contacts: 'Paul' }, 'contacts non liste'],
      [{ nom: 'X', contacts: [{ fonction: 'Commercial' }] }, 'contact sans nom'],
      [{ nom: 'X', contacts: [{ nom: 'Paul', email: 'paul@' }] }, 'e-mail de contact invalide'],
      [{ nom: 'X', contacts: ['Paul'] }, 'contact non objet'],
      [{ nom: 'X', contacts: Array.from({ length: 51 }, (v, i) => ({ nom: 'Contact ' + i })) }, 'trop de contacts'],
      [{ nom: 'X', champs: 'texte' }, 'champs personnalisés non objet'],
    ];
    for (const [body, raison] of cas) {
      const r = await admin.post('/api/fournisseurs', body);
      assert.equal(r.status, 400, `${raison} : ${JSON.stringify(r.body)}`);
      assert.ok(r.body.erreur && typeof r.body.erreur === 'string', `${raison} : message d'erreur attendu`);
    }
    assert.equal((await admin.post('/api/fournisseurs', [1, 2])).status, 400, 'corps non objet');
    assert.match((await admin.post('/api/fournisseurs', {})).body.erreur, /Nom/);
    assert.match((await admin.post('/api/fournisseurs', { nom: 'X', contacts: [{ fonction: 'Commercial' }] })).body.erreur, /Contact n°1/);
    assert.equal(srv.db.count('fournisseurs'), 0, 'aucune fiche créée');
  });

  test('création complète : normalisation, valeurs par défaut, audit', async () => {
    const f = await admin.ok('POST', '/api/fournisseurs', {
      nom: '  SKF   France ', typeCode: 'fournisseur', contact: 'Laurent Girard', telephone: '04 65 71 20 14', email: 'laurent.girard@skf.example',
      adresse: '15 rue Denis Papin\n69200 Vénissieux', siteWeb: 'www.skf.com/fr', siret: '312 584 525 00127', delaiLivraisonJours: '5', notes: 'Remise 32 %',
      contacts: [{ nom: 'Nadia Benali', fonction: 'ADV', telephone: '+33 4 65 71 20 10', email: 'adv@skf.example' }, { nom: '', fonction: '', telephone: '', email: '' }, null],
      nbArticles: 999, inconnu: 'ignoré',
    });
    assert.equal(f.nom, 'SKF France');
    assert.equal(f.typeCode, 'fournisseur');
    assert.equal(f.typeLibelle, 'Fournisseur de pièces');
    assert.equal(f.siteWeb, 'https://www.skf.com/fr', 'schéma https ajouté');
    assert.equal(f.siret, '31258452500127', 'espaces retirés');
    assert.equal(f.delaiLivraisonJours, 5);
    assert.equal(f.actif, true);
    assert.equal(f.contacts.length, 1, 'lignes de contact vides ignorées');
    assert.deepEqual(f.contacts[0], { nom: 'Nadia Benali', fonction: 'ADV', telephone: '+33 4 65 71 20 10', email: 'adv@skf.example' });
    assert.equal(f.createdBy, userId('admin'));
    assert.equal(f.nbArticles, 0, 'champs calculés non modifiables');
    assert.equal(srv.db.get('fournisseurs', f.id).inconnu, undefined, 'champs inconnus ignorés');
    assert.equal(f.contactPrincipal, 'Laurent Girard');
    assert.ok(f.references && f.references.total === 0);
    const audit = derniersAudits(1)[0];
    assert.equal(audit.action, 'creation');
    assert.equal(audit.entite, 'fournisseurs');
    assert.equal(audit.entiteId, f.id);

    // Type par défaut : premier code de la liste configurée
    const g = await admin.ok('POST', '/api/fournisseurs', { nom: 'Rexel' });
    assert.equal(g.typeCode, srv.ctx.liste('typesFournisseur')[0].code);
    assert.equal(g.delaiLivraisonJours, null);
    assert.deepEqual(g.contacts, []);
    assert.equal(g.siteWeb, '');
    // Contact principal déduit du premier contact lorsque le champ est vide
    const h = await admin.ok('POST', '/api/fournisseurs', { nom: 'Atlas Copco Service', typeCode: 'prestataire', contacts: [{ nom: 'Marc Dubois', fonction: 'Responsable contrat', telephone: '06 39 98 25 63' }] });
    assert.equal(h.contactPrincipal, 'Marc Dubois');
    assert.equal(h.telephonePrincipal, '06 39 98 25 63');
  });

  test('nom unique insensible à la casse (et aux accents) ; SIRET unique', async () => {
    let r = await admin.post('/api/fournisseurs', { nom: 'skf FRANCE' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /existe déjà/);
    r = await admin.post('/api/fournisseurs', { nom: 'Électricité Générale' });
    assert.equal(r.status, 200);
    assert.equal((await admin.post('/api/fournisseurs', { nom: 'electricite generale' })).status, 400, 'accents ignorés');
    // Renommer vers un nom existant : refusé ; changer la casse de son propre nom : accepté
    const rexel = srv.db.findOne('fournisseurs', (f) => f.nom === 'Rexel');
    assert.equal((await admin.put('/api/fournisseurs/' + rexel.id, { nom: 'SKF france' })).status, 400);
    assert.equal((await admin.ok('PUT', '/api/fournisseurs/' + rexel.id, { nom: 'REXEL' })).nom, 'REXEL');
    await admin.ok('PUT', '/api/fournisseurs/' + rexel.id, { nom: 'Rexel' });
    // SIRET déjà attribué
    r = await admin.post('/api/fournisseurs', { nom: 'Autre agence SKF', siret: '31258452500127' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /SIRET/);
    await admin.ok('DELETE', '/api/fournisseurs/' + srv.db.findOne('fournisseurs', (f) => f.nom === 'Électricité Générale').id);
  });

  test('modification partielle : seuls les champs fournis changent', async () => {
    const skf = srv.db.findOne('fournisseurs', (f) => f.nom === 'SKF France');
    const f = await admin.ok('PUT', '/api/fournisseurs/' + skf.id, { telephone: '04 65 71 20 99' });
    assert.equal(f.telephone, '04 65 71 20 99');
    assert.equal(f.email, 'laurent.girard@skf.example');
    assert.equal(f.siret, '31258452500127');
    assert.equal(f.contacts.length, 1);
    assert.equal(f.delaiLivraisonJours, 5);
    const audit = derniersAudits(1)[0];
    assert.equal(audit.action, 'modification');
    assert.match(audit.details, /téléphone/);
    // Remplacement de la liste des contacts, effacement d'un champ
    const g = await admin.ok('PUT', '/api/fournisseurs/' + skf.id, { contacts: [{ nom: 'Laurent Girard', fonction: 'Technico-commercial' }, { nom: 'Nadia Benali' }], siteWeb: '', delaiLivraisonJours: null });
    assert.deepEqual(g.contacts.map((c) => c.nom), ['Laurent Girard', 'Nadia Benali']);
    assert.equal(g.siteWeb, '');
    assert.equal(g.delaiLivraisonJours, null);
    // Validation identique à la création
    assert.equal((await admin.put('/api/fournisseurs/' + skf.id, { email: 'faux' })).status, 400);
    assert.equal((await admin.put('/api/fournisseurs/' + skf.id, { nom: '' })).status, 400);
    assert.equal((await admin.put('/api/fournisseurs/999999', { nom: 'Fantôme' })).status, 404);
    // Aucune modification réelle : pas de nouvelle entrée d'audit
    const nbAudit = srv.db.count('audit');
    await admin.ok('PUT', '/api/fournisseurs/' + skf.id, { telephone: '04 65 71 20 99' });
    assert.equal(srv.db.count('audit'), nbAudit);
    await admin.ok('PUT', '/api/fournisseurs/' + skf.id, { delaiLivraisonJours: 5, siteWeb: 'https://www.skf.com/fr' });
  });

  test('liste : filtres type, actif, recherche (multi-termes, accents, contacts)', async () => {
    const tous = await admin.ok('GET', '/api/fournisseurs');
    assert.deepEqual(tous.map((f) => f.nom), ['Atlas Copco Service', 'Rexel', 'SKF France'], 'tri alphabétique');
    assert.ok(tous.every((f) => 'nbArticles' in f && 'nbEquipements' in f && 'nbOt' in f && 'contactPrincipal' in f && 'typeLibelle' in f));
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?typeCode=prestataire')).map((f) => f.nom), ['Atlas Copco Service']);
    assert.equal((await admin.get('/api/fournisseurs?typeCode=grossiste')).status, 400);
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?recherche=nadia')).map((f) => f.nom), ['SKF France'], 'recherche dans les contacts');
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?recherche=VENISSIEUX%20skf')).map((f) => f.nom), ['SKF France'], 'multi-termes sans accents');
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?recherche=31258452500127')).map((f) => f.nom), ['SKF France'], 'recherche par SIRET');
    assert.deepEqual(await admin.ok('GET', '/api/fournisseurs?recherche=introuvable'), []);
    const rexel = tous.find((f) => f.nom === 'Rexel');
    await admin.ok('PUT', '/api/fournisseurs/' + rexel.id, { actif: false });
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?actif=1')).map((f) => f.nom), ['Atlas Copco Service', 'SKF France']);
    assert.deepEqual((await admin.ok('GET', '/api/fournisseurs?actif=0')).map((f) => f.nom), ['Rexel']);
    assert.equal((await admin.ok('GET', '/api/fournisseurs?actif=tous')).length, 3);
    assert.equal((await admin.get('/api/fournisseurs?actif=bof')).status, 400);
    const r = await admin.ok('PUT', '/api/fournisseurs/' + rexel.id, { actif: true });
    assert.equal(r.actif, true);
    assert.match(derniersAudits(1)[0].details, /réactivé/);
  });

  describe('détail enrichi, portée et droits', () => {
    let atlas, compresseur, cta, filtre, filtreMaint, otProd, otMaint, otClos;

    before(() => {
      atlas = srv.db.findOne('fournisseurs', (f) => f.nom === 'Atlas Copco Service');
      compresseur = srv.db.insert('equipements', { numero: 'EQ-T01', nom: 'Compresseur GA 37', secteurId: prod.id, fournisseurId: atlas.id, actif: true, typeCode: 'machine', marque: 'Atlas Copco', garantieFin: '2099-12-31' });
      cta = srv.db.insert('equipements', { numero: 'EQ-T02', nom: 'Sécheur d\'air', secteurId: maint.id, fournisseurId: atlas.id, actif: true, typeCode: 'machine', garantieFin: '2020-01-01' });
      filtre = srv.db.insert('articles', { code: 'ART-T1', designation: 'Cartouche filtre à air', quantite: 1, seuilMin: 2, prixUnitaire: 89, fournisseurId: atlas.id, actif: true, secteurId: null, uniteCode: 'u' });
      filtreMaint = srv.db.insert('articles', { code: 'ART-T2', designation: 'Séparateur d\'huile', quantite: 4, seuilMin: 1, prixUnitaire: 150, fournisseurId: atlas.id, actif: true, secteurId: maint.id, uniteCode: 'u' });
      const mvt = (articleId, quantite, prixUnitaire, joursAvant, fournisseurId) => srv.db.insert('mouvementsStock', { articleId, type: 'entree', quantite, prixUnitaire, fournisseurId, date: new Date(Date.now() - joursAvant * 86400000).toISOString(), userId: 1, motif: 'Réception', quantiteAvant: 0, quantiteApres: quantite });
      mvt(filtre.id, 4, 91.5, 20, atlas.id); // 366
      mvt(filtreMaint.id, 2, 150, 40, atlas.id); // 300 (secteur Maintenance)
      mvt(filtre.id, 1, 89, 500, atlas.id); // 89 (hors 12 mois)
      srv.db.insert('mouvementsStock', { articleId: filtre.id, type: 'sortie', quantite: 2, prixUnitaire: 90, fournisseurId: atlas.id, date: new Date().toISOString(), userId: 1 }); // ignoré (sortie)
      otProd = srv.db.insert('ot', { numero: 'OT-T-0001', titre: 'Visite préventive 4 000 h', statut: 'planifie', typeCode: 'preventif', secteurId: prod.id, equipementId: compresseur.id, fournisseurId: atlas.id, technicienId: userId('tech.prod'), coutExterne: 850, coutPieces: 120, coutMainOeuvre: 45, datePrevue: '2026-11-02' });
      otClos = srv.db.insert('ot', { numero: 'OT-T-0002', titre: 'Dépannage variateur', statut: 'termine', typeCode: 'correctif', secteurId: prod.id, equipementId: compresseur.id, fournisseurId: atlas.id, coutExterne: 1200.5, coutPieces: 0, coutMainOeuvre: 90, dateFin: '2026-03-10T10:00:00.000Z' });
      otMaint = srv.db.insert('ot', { numero: 'OT-T-0003', titre: 'Contrôle sécheur', statut: 'nouveau', typeCode: 'preventif', secteurId: maint.id, equipementId: cta.id, fournisseurId: atlas.id, coutExterne: 300 });
    });

    test('administrateur : articles, équipements, OT externes avec coûts, total des achats', async () => {
      const d = await admin.ok('GET', '/api/fournisseurs/' + atlas.id);
      assert.deepEqual(d.acces, { articles: true, equipements: true, ot: true, achats: true });
      assert.deepEqual(d.articles.map((a) => a.code).sort(), ['ART-T1', 'ART-T2']);
      const a1 = d.articles.find((a) => a.code === 'ART-T1');
      assert.equal(a1.sousSeuil, true);
      assert.equal(a1.valeur, 89);
      assert.deepEqual(d.equipements.map((e) => e.numero), ['EQ-T01', 'EQ-T02']);
      assert.equal(d.equipements[0].sousGarantie, true);
      assert.equal(d.equipements[1].sousGarantie, false);
      assert.equal(d.interventions.length, 3);
      const o = d.interventions.find((x) => x.id === otProd.id);
      assert.equal(o.coutExterne, 850);
      assert.equal(o.coutTotal, 1015);
      assert.equal(o.equipementNom, 'Compresseur GA 37');
      assert.equal(o.final, false);
      assert.equal(d.interventions.find((x) => x.id === otClos.id).final, true);
      assert.equal(d.achats.total, 755, 'Σ entrées × prix (les sorties sont ignorées)');
      assert.equal(d.achats.total12Mois, 666);
      assert.equal(d.achats.nbReceptions, 3);
      assert.equal(d.achats.parMois.length, 12);
      assert.equal(d.achats.parMois.reduce((s, m) => s + m.montant, 0), 666);
      assert.equal(d.achats.receptions[0].articleCode, 'ART-T1', 'réceptions les plus récentes en premier');
      assert.equal(d.achats.receptions[0].montant, 366);
      assert.equal(d.stats.nbArticlesSousSeuil, 1);
      assert.equal(d.stats.nbInterventionsOuvertes, 2);
      assert.equal(d.stats.coutExterneTotal, 2350.5);
      assert.equal(d.stats.totalAchats, 755);
      assert.equal(d.stats.nbEquipementsSousGarantie, 1);
      assert.deepEqual(d.references, { articles: 2, equipements: 2, ot: 3, mouvements: 4, autres: {}, total: 11 });
      const liste = await admin.ok('GET', '/api/fournisseurs');
      const l = liste.find((f) => f.id === atlas.id);
      assert.equal(l.nbArticles, 2);
      assert.equal(l.nbEquipements, 2);
      assert.equal(l.nbOt, 3);
      assert.equal(l.nbOtOuverts, 2);
      assert.equal(l.totalAchats, 755);
      assert.equal((await admin.get('/api/fournisseurs/999999')).status, 404);
      assert.equal((await admin.get('/api/fournisseurs/abc')).status, 404);
    });

    test('portée : un technicien de la Production ne voit que les éléments liés de son secteur', async () => {
      const d = await technicienProd.ok('GET', '/api/fournisseurs/' + atlas.id);
      assert.deepEqual(d.articles.map((a) => a.code), ['ART-T1'], 'article du magasin Maintenance masqué');
      assert.deepEqual(d.equipements.map((e) => e.numero), ['EQ-T01']);
      assert.deepEqual(d.interventions.map((o) => o.numero).sort(), ['OT-T-0001', 'OT-T-0002']);
      assert.equal(d.achats.total, 455, 'réceptions limitées aux articles visibles');
      assert.equal(d.achats.receptions.length, 2);
      assert.equal(d.stats.coutExterneTotal, 2050.5);
      // Le nombre total de références (décision de suppression) reste global
      assert.equal(d.references.total, 11);
      const l = (await technicienProd.ok('GET', '/api/fournisseurs')).find((f) => f.id === atlas.id);
      assert.equal(l.nbArticles, 1);
      assert.equal(l.nbEquipements, 1);
      assert.equal(l.nbOt, 2);
      // Fiches fournisseurs transversales : toutes visibles
      assert.equal((await technicienProd.ok('GET', '/api/fournisseurs')).length, 3);
    });

    test('droits des modules liés : sans accès au stock, ni articles ni achats', async () => {
      const d = await techSansStock.ok('GET', '/api/fournisseurs/' + atlas.id);
      assert.equal(d.acces.articles, false);
      assert.equal(d.acces.achats, false);
      assert.deepEqual(d.articles, []);
      assert.equal(d.achats.total, null);
      assert.deepEqual(d.achats.receptions, []);
      assert.equal(d.stats.totalAchats, null);
      assert.equal(d.equipements.length, 1, 'équipements toujours visibles (droit équipements)');
      const l = (await techSansStock.ok('GET', '/api/fournisseurs')).find((f) => f.id === atlas.id);
      assert.equal(l.totalAchats, null);
      assert.equal(l.nbArticles, 0);
    });

    test('droits : 403 pour les profils sans droit', async () => {
      // Demandeur : aucun accès au module
      assert.equal((await demandeur.get('/api/fournisseurs')).status, 403);
      assert.equal((await demandeur.get('/api/fournisseurs/' + atlas.id)).status, 403);
      // Technicien / chef de secteur : consultation seule
      for (const c of [technicienProd, chefProd]) {
        assert.equal((await c.get('/api/fournisseurs')).status, 200);
        assert.equal((await c.post('/api/fournisseurs', { nom: 'Interdit' })).status, 403);
        assert.equal((await c.put('/api/fournisseurs/' + atlas.id, { notes: 'x' })).status, 403);
        assert.equal((await c.del('/api/fournisseurs/' + atlas.id)).status, 403);
        assert.equal((await c.post(`/api/fournisseurs/${atlas.id}/dupliquer`, {})).status, 403);
        assert.equal((await c.get('/api/fournisseurs-export')).status, 403);
      }
      assert.match((await technicienProd.post('/api/fournisseurs', { nom: 'Interdit' })).body.erreur, /Droit insuffisant/);
      assert.equal(srv.db.count('fournisseurs', (f) => f.nom === 'Interdit'), 0);
      // Surcharge individuelle : un technicien autorisé à créer
      await admin.ok('PUT', '/api/utilisateurs/' + userId('tech.prod'), { overrides: { fournisseurs: { creer: true } } });
      const f = await technicienProd.ok('POST', '/api/fournisseurs', { nom: 'Fournisseur du technicien' });
      assert.equal(f.createdBy, userId('tech.prod'));
      assert.equal((await technicienProd.del('/api/fournisseurs/' + f.id)).status, 403, 'toujours pas de droit de suppression');
      await admin.ok('PUT', '/api/utilisateurs/' + userId('tech.prod'), { overrides: {} });
      await admin.ok('DELETE', '/api/fournisseurs/' + f.id);
    });

    test('désactivation : notifications aux gestionnaires de stock et aux techniciens des OT ouverts', async () => {
      const avant = srv.db.count('notifications');
      const r = await admin.ok('PUT', '/api/fournisseurs/' + atlas.id, { actif: false });
      assert.equal(r.actif, false);
      const audit = derniersAudits(1)[0];
      assert.equal(audit.action, 'desactivation');
      const nouvelles = srv.db.list('notifications').slice(avant);
      const pourTech = nouvelles.filter((n) => n.userId === userId('tech.prod'));
      assert.ok(pourTech.some((n) => n.titre === 'Prestataire désactivé' && n.lien === '#/ot/' + otProd.id), 'technicien responsable de l\'OT ouvert prévenu');
      assert.ok(pourTech.some((n) => n.titre === 'Fournisseur désactivé'), 'gestionnaire de stock (droit stock.modifier) prévenu');
      assert.ok(!nouvelles.some((n) => n.userId === userId('admin')), 'l\'auteur n\'est pas notifié');
      assert.ok(!nouvelles.some((n) => n.userId === userId('tech.sansstock')), 'pas de notification sans droit stock.modifier');
      assert.ok(evenements.some((x) => x.e === 'fournisseur:desactive' && x.d.fournisseur.id === atlas.id));
      await admin.ok('PUT', '/api/fournisseurs/' + atlas.id, { actif: true });
    });

    test('suppression : fournisseur référencé désactivé, non référencé supprimé', async () => {
      let r = await admin.ok('DELETE', '/api/fournisseurs/' + atlas.id);
      assert.equal(r.desactive, true);
      assert.equal(r.references.total, 11);
      assert.equal(srv.db.get('fournisseurs', atlas.id).actif, false);
      assert.equal(derniersAudits(1)[0].action, 'desactivation');
      assert.match(derniersAudits(1)[0].details, /référencé/);
      await admin.ok('PUT', '/api/fournisseurs/' + atlas.id, { actif: true });

      const libre = await admin.ok('POST', '/api/fournisseurs', { nom: 'Fournisseur éphémère' });
      r = await admin.ok('DELETE', '/api/fournisseurs/' + libre.id);
      assert.equal(r.desactive, false);
      assert.equal(srv.db.get('fournisseurs', libre.id), null);
      assert.equal(derniersAudits(1)[0].action, 'suppression');
      assert.ok(evenements.some((x) => x.e === 'fournisseur:supprime' && x.d.fournisseur.id === libre.id));
      assert.equal((await admin.get('/api/fournisseurs/' + libre.id)).status, 404);
      assert.equal((await admin.del('/api/fournisseurs/' + libre.id)).status, 404);
    });

    test('duplication : nom de copie unique, SIRET non recopié, contacts copiés', async () => {
      const skf = srv.db.findOne('fournisseurs', (f) => f.nom === 'SKF France');
      const c1 = await admin.ok('POST', `/api/fournisseurs/${skf.id}/dupliquer`, {});
      assert.equal(c1.nom, 'SKF France (copie)');
      assert.equal(c1.siret, '');
      assert.equal(c1.actif, true);
      assert.deepEqual(c1.contacts, skf.contacts);
      assert.equal(c1.email, skf.email);
      assert.equal(c1.typeCode, skf.typeCode);
      assert.equal(c1.nbArticles, 0, 'les articles ne suivent pas la copie');
      assert.equal(derniersAudits(1)[0].action, 'duplication');
      const c2 = await admin.ok('POST', `/api/fournisseurs/${skf.id}/dupliquer`);
      assert.equal(c2.nom, 'SKF France (copie 2)');
      const c3 = await admin.ok('POST', `/api/fournisseurs/${skf.id}/dupliquer`, { nom: 'SKF France — agence Lyon' });
      assert.equal(c3.nom, 'SKF France — agence Lyon');
      assert.equal((await admin.post(`/api/fournisseurs/${skf.id}/dupliquer`, { nom: 'skf france' })).status, 400, 'nom déjà utilisé');
      assert.equal((await admin.post('/api/fournisseurs/999999/dupliquer', {})).status, 404);
      // La copie est indépendante de l'original
      await admin.ok('PUT', '/api/fournisseurs/' + c1.id, { contacts: [] });
      assert.equal(srv.db.get('fournisseurs', skf.id).contacts.length, 2);
      for (const c of [c1, c2, c3]) await admin.ok('DELETE', '/api/fournisseurs/' + c.id);
    });

    test('export CSV : en-têtes, filtres, séparateur « ; », audit', async () => {
      const r = await admin.get('/api/fournisseurs-export');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.match(r.headers.get('content-disposition'), /fournisseurs-\d{4}-\d{2}-\d{2}\.csv/);
      const lignes = r.body.replace(/^\ufeff/, '').split('\r\n'); // le BOM UTF-8 (pour Excel) est retiré par fetch().text()
      assert.ok(lignes[0].startsWith('Nom;Type;Contact principal;Téléphone;E-mail'), lignes[0]);
      assert.ok(lignes[0].includes('Total des achats'));
      assert.equal(lignes.length, 4, 'en-tête + 3 fournisseurs');
      const atlasLigne = lignes.find((l) => l.startsWith('Atlas Copco Service'));
      assert.ok(atlasLigne.includes('Prestataire de services'));
      assert.ok(atlasLigne.includes('755'), 'total des achats exporté');
      const skfLigne = lignes.find((l) => l.startsWith('SKF France'));
      assert.ok(skfLigne.includes('312 584 525 00127'), 'SIRET formaté');
      assert.ok(skfLigne.includes('"15 rue Denis Papin 69200 Vénissieux"') || skfLigne.includes('15 rue Denis Papin 69200 Vénissieux'), 'retours à la ligne aplatis');
      const filtre = await admin.get('/api/fournisseurs-export?typeCode=prestataire');
      assert.equal(filtre.body.split('\r\n').length, 2);
      assert.equal(derniersAudits(1)[0].action, 'export');
      // Sans droit stock : pas de colonne des achats
      await admin.ok('PUT', '/api/utilisateurs/' + userId('tech.sansstock'), { overrides: { stock: { voir: false, modifier: false }, fournisseurs: { exporter: true } } });
      const sans = await techSansStock.get('/api/fournisseurs-export');
      assert.equal(sans.status, 200);
      assert.ok(!sans.body.split('\r\n')[0].includes('Total des achats'));
    });
  });

  test('suppression : références d\'autres modules (ex. commandes d\'achat) prises en compte', async () => {
    const f = await admin.ok('POST', '/api/fournisseurs', { nom: 'Fournisseur commandé' });
    const cde = srv.db.insert('commandes', { numero: 'CDE-T-001', fournisseurId: f.id, lignes: [] });
    const contrat = srv.db.insert('contrats', { objet: 'Maintenance', fournisseurIds: [f.id] });
    let d = await admin.ok('GET', '/api/fournisseurs/' + f.id);
    assert.deepEqual(d.references.autres, { commandes: 1, contrats: 1 });
    assert.equal(d.references.total, 2);
    const r = await admin.ok('DELETE', '/api/fournisseurs/' + f.id);
    assert.equal(r.desactive, true, 'référencé par une commande : désactivé');
    assert.match(derniersAudits(1)[0].details, /1 commande\(s\) fournisseur, 1 contrat\(s\)/);
    srv.db.remove('commandes', cde.id);
    srv.db.remove('contrats', contrat.id);
    d = await admin.ok('GET', '/api/fournisseurs/' + f.id);
    assert.equal(d.references.total, 0);
    assert.equal((await admin.ok('DELETE', '/api/fournisseurs/' + f.id)).desactive, false);
  });

  test('champs personnalisés : validation et stockage', async () => {
    config((c) => { c.champsPersonnalises.fournisseurs = [{ cle: 'compteClient', label: 'N° de compte client', type: 'texte', obligatoire: true }, { cle: 'evaluation', label: 'Évaluation', type: 'liste', options: ['A', 'B', 'C'] }, { cle: 'certifieIso', label: 'Certifié ISO 9001', type: 'booleen' }]; });
    try {
      let r = await admin.post('/api/fournisseurs', { nom: 'Fournisseur ISO' });
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /N° de compte client/);
      r = await admin.post('/api/fournisseurs', { nom: 'Fournisseur ISO', champs: { compteClient: 'C-458', evaluation: 'Z' } });
      assert.equal(r.status, 400, 'valeur de liste invalide');
      const f = await admin.ok('POST', '/api/fournisseurs', { nom: 'Fournisseur ISO', champs: { compteClient: 'C-458', evaluation: 'A', certifieIso: 1, inconnu: 'x' } });
      assert.deepEqual(f.champs, { compteClient: 'C-458', evaluation: 'A', certifieIso: true });
      // Modification sans les champs : valeurs conservées
      const g = await admin.ok('PUT', '/api/fournisseurs/' + f.id, { notes: 'Audit fournisseur réalisé' });
      assert.equal(g.champs.compteClient, 'C-458');
      const h = await admin.ok('PUT', '/api/fournisseurs/' + f.id, { champs: { compteClient: 'C-999', evaluation: 'B' } });
      assert.deepEqual(h.champs, { compteClient: 'C-999', evaluation: 'B', certifieIso: null });
      const csv = await admin.get('/api/fournisseurs-export');
      assert.ok(csv.body.split('\r\n')[0].endsWith('N° de compte client;Évaluation;Certifié ISO 9001'));
      await admin.ok('DELETE', '/api/fournisseurs/' + f.id);
    } finally {
      config((c) => { c.champsPersonnalises.fournisseurs = []; });
    }
  });

  test('événements émis à la création et à la modification', async () => {
    const f = await admin.ok('POST', '/api/fournisseurs', { nom: 'Fournisseur événementiel' });
    assert.ok(evenements.some((x) => x.e === 'fournisseur:cree' && x.d.fournisseur.id === f.id));
    await admin.ok('PUT', '/api/fournisseurs/' + f.id, { notes: 'Nouveau' });
    const m = evenements.filter((x) => x.e === 'fournisseur:modifie' && x.d.fournisseur.id === f.id).pop();
    assert.deepEqual(m.d.changes, ['notes']);
    await admin.ok('DELETE', '/api/fournisseurs/' + f.id);
  });

  test('services publiés (ctx.services.fournisseurs)', async () => {
    const s = srv.ctx.services.fournisseurs;
    assert.ok(s, 'service publié');
    const atlas = srv.db.findOne('fournisseurs', (f) => f.nom === 'Atlas Copco Service');
    assert.equal(s.get(atlas.id).nom, 'Atlas Copco Service');
    assert.equal(s.nom(atlas.id), 'Atlas Copco Service');
    assert.equal(s.nom(424242), '');
    assert.deepEqual(s.actifs('prestataire').map((f) => f.nom), ['Atlas Copco Service']);
    assert.ok(s.actifs().length >= 3);
    assert.equal(s.references(atlas.id).total, 11);
    assert.equal(s.estReference(atlas.id), true);
    assert.equal(s.totalAchats(atlas.id), 755);
  });

  test('données de démonstration : idempotentes et réalistes', async () => {
    const autre = await demarrer();
    try {
      const mod = require('../server/modules/fournisseurs');
      const r1 = mod.seedDemo(autre.ctx);
      assert.match(r1, /8 fournisseur/);
      const noms = autre.db.list('fournisseurs').map((f) => f.nom);
      for (const n of ['SKF France', 'Rexel', 'Total Lubrifiants', 'Schneider Electric', 'Atlas Copco Service', 'Bureau Veritas']) assert.ok(noms.includes(n), n);
      assert.equal(mod.seedDemo(autre.ctx), 'déjà présents');
      assert.equal(autre.db.count('fournisseurs'), 8);
      const bv = autre.db.findOne('fournisseurs', (f) => f.nom === 'Bureau Veritas');
      assert.equal(bv.typeCode, 'prestataire');
      assert.equal(autre.db.findOne('fournisseurs', (f) => f.nom === 'Atlas Copco Service').typeCode, 'prestataire');
      assert.ok(autre.db.list('fournisseurs').every((f) => f.contacts.length >= 1 && f.actif && /^\d{14}$/.test(f.siret)));
      // Les fiches de démonstration respectent les règles de validation de l'API
      const c = autre.client();
      await c.login('admin', 'admin');
      for (const f of autre.db.list('fournisseurs')) {
        const { id, createdAt, updatedAt, createdBy, ...reste } = f;
        const r = await c.put('/api/fournisseurs/' + id, reste);
        assert.equal(r.status, 200, `${f.nom} : ${JSON.stringify(r.body)}`);
      }
      // Chargement global (tous les modules) : les liens inter-modules sont établis
      const rapport = require('../server/modules').seedDemo(autre.ctx);
      assert.ok(rapport.every((x) => x.ok), JSON.stringify(rapport));
      const detail = await c.ok('GET', '/api/fournisseurs/' + autre.db.findOne('fournisseurs', (f) => f.nom === 'SKF France').id);
      if (autre.db.count('articles')) assert.ok(detail.articles.length > 0, 'articles SKF liés');
    } finally { await autre.stop(); }
  });
});
