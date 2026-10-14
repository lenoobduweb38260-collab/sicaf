'use strict';
/**
 * Tests du module Étiquettes code-barres & inventaire du magasin : résolution des codes scannés,
 * création d'inventaire (validation, instantané du périmètre), comptages (ajouter / remplacer,
 * hors périmètre, annulation), mode aveugle, mouvements depuis l'ouverture, validation (mouvements
 * d'inventaire du stock, notifications, audit), annulation, suppression, export CSV, données
 * d'étiquettes, droits (403), portée par secteur, multi-site (site en lecture seule, en-tête
 * X-GMAO-Site), services et événements, données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

describe('Module Étiquettes & inventaire', () => {
  let srv, admin, profils, secteurs;
  let site1, prod, maint, log;
  let site2, prod2;
  let resp, tech, chef, demandeur, respMaint;
  let skf, rexel;
  const art = {};
  const evenements = [];

  /** Client HTTP qui envoie éventuellement l'en-tête de site (X-GMAO-Site). */
  function clientSite(site) {
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'x-requested-with': 'GMAO', cookie };
      if (site != null) headers['x-gmao-site'] = String(site);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(srv.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = txt; }
      return { status: r.status, body: data, headers: r.headers };
    };
    return {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      async login(l, p) { const r = await call('POST', '/api/auth/login', { login: l, password: p }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body; },
      async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
      setSite(s) { site = s; },
    };
  }
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  async function utilisateur(login, nomProfil, secteurIds, extra) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, profilId: profil(nomProfil), secteurIds, password: 'motdepasse1', doitChangerMdp: false }, extra || {}));
    const c = clientSite(null);
    await c.login(login, 'motdepasse1');
    return c;
  }
  const userId = (login) => srv.db.findOne('users', (u) => u.login === login).id;
  const article = (code, champs) => srv.db.insert('articles', Object.assign({
    code, designation: 'Article ' + code, categorieCode: 'mecanique', uniteCode: 'u', quantite: 10, seuilMin: 2, quantiteCommande: 5,
    emplacement: 'Magasin central — A1', prixUnitaire: 10, fournisseurId: null, referenceFournisseur: '', equipementIds: [], secteurId: null, actif: true, champs: {},
  }, champs || {}));
  const config = (fn) => { const c = srv.db.getConfig(); fn(c); srv.db.setConfig(c); };

  before(async () => {
    srv = await demarrer();
    admin = clientSite(null);
    await admin.login('admin', 'admin');
    secteurs = await admin.ok('GET', '/api/secteurs');
    site1 = secteurs.find((s) => s.code === 'SITE');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    log = secteurs.find((s) => s.code === 'LOG');
    site2 = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    prod2 = await admin.ok('POST', '/api/secteurs', { nom: 'Magasin Valréas', code: 'VAL-LOG', type: 'magasin', parentId: site2.id });
    profils = await admin.ok('GET', '/api/profils');
    for (const e of ['inventaire:ouvert', 'inventaire:valide', 'inventaire:annule']) srv.ctx.on(e, (d) => evenements.push([e, d.inventaire.numero]));

    skf = srv.db.insert('fournisseurs', { nom: 'SKF France', typeCode: 'fournisseur', actif: true });
    rexel = srv.db.insert('fournisseurs', { nom: 'Rexel', typeCode: 'fournisseur', actif: true });
    art.roulement = article('ART-0001', { designation: 'Roulement à billes 6205-2RS', quantite: 12, prixUnitaire: 8.9, fournisseurId: skf.id, referenceFournisseur: '6205-2RSH', emplacement: 'Magasin central — A1 — Étagère 2' });
    art.courroie = article('ART-0002', { designation: 'Courroie HTD 1400', quantite: 4, prixUnitaire: 46.8, fournisseurId: skf.id, emplacement: 'Magasin central — A2 — Crochets' });
    art.contacteur = article('ART-0003', { designation: 'Contacteur TeSys D18', categorieCode: 'electrique', quantite: 3, prixUnitaire: 72.3, fournisseurId: rexel.id, emplacement: 'Magasin central — D1 — Bac 3', codeBarre: '3389110012345' });
    art.fusibles = article('ART-0004', { designation: 'Fusibles 10×38 gG 10 A', categorieCode: 'electrique', uniteCode: 'lot', quantite: 8, prixUnitaire: 9.8, fournisseurId: rexel.id, emplacement: 'Magasin central — D2 — Bac 1' });
    art.huile = article('ART-0005', { designation: 'Huile hydraulique ZS 46', categorieCode: 'lubrifiant', uniteCode: 'l', quantite: 120, prixUnitaire: 3.85, emplacement: 'Local lubrifiants — Fût n°2' });
    art.inactif = article('ART-0006', { designation: 'Ancienne courroie', actif: false, emplacement: 'Magasin central — A2' });
    art.prod = article('ART-0007', { designation: 'Pièce réservée à la production', secteurId: prod.id, emplacement: 'Magasin central — A3' });
    art.val = article('ART-0101', { designation: 'Roulement Valréas', secteurId: prod2.id, emplacement: 'Magasin Valréas — R1', prixUnitaire: 5 });
    art.val2 = article('ART-0102', { designation: 'Filtre Valréas', secteurId: prod2.id, emplacement: 'Magasin Valréas — R2', prixUnitaire: 20, quantite: 6 });
    art.accent = article('ÉLEC-01', { designation: 'Câble électrique', categorieCode: 'electrique', emplacement: 'Magasin logistique — Touret', secteurId: log.id });
    srv.db.insert('equipements', { numero: 'EQ-0042', nom: 'Compresseur GA 37', secteurId: maint.id, actif: true, typeCode: 'machine', etatCode: 'en_service', localisation: 'Local compresseurs' });
    srv.db.insert('equipements', { numero: 'EQ-0099', nom: 'Presse Valréas', secteurId: prod2.id, actif: true, typeCode: 'machine' });
    srv.db.insert('equipements', { numero: 'EQ-0050', nom: 'Remplisseuse rotative', secteurId: prod.id, actif: true, typeCode: 'machine' });
    srv.db.insert('ot', { numero: 'OT-2026-0001', titre: 'Remplacement courroie', statut: 'nouveau', secteurId: maint.id });
    srv.db.insert('demandes', { numero: 'DI-2026-0001', titre: 'Fuite d\'huile', statut: 'soumise', secteurId: prod.id, demandeurId: 1 });

    resp = await utilisateur('resp', 'Responsable maintenance', [maint.id]);
    tech = await utilisateur('tech', 'Technicien', [maint.id]);
    chef = await utilisateur('chef', 'Chef de secteur', [prod.id]);
    demandeur = await utilisateur('demandeur', 'Demandeur', [prod.id]);
    respMaint = await utilisateur('resp.maint', 'Responsable maintenance', [maint.id], { porteeOverride: 'secteurs' });
  });
  after(async () => { await srv.stop(); });

  // ----- Résolution des codes ------------------------------------------------------------------
  describe('résolution d\'un code scanné (GET /api/codes/:code)', () => {
    test('article par code (casse et accents ignorés), référence fournisseur, champ codeBarre', async () => {
      const r = await tech.ok('GET', '/api/codes/art-0001');
      assert.equal(r.type, 'article');
      assert.equal(r.id, art.roulement.id);
      assert.equal(r.lien, `#/stock/${art.roulement.id}`);
      assert.equal(r.libelle, 'Roulement à billes 6205-2RS');
      assert.equal(r.details.quantite, 12);
      assert.equal(r.details.emplacement, 'Magasin central — A1 — Étagère 2');
      assert.equal(r.details.prixUnitaire, 8.9);
      assert.equal(r.details.seuilMin, 2);
      assert.equal(r.details.unite, 'u');
      assert.equal((await tech.ok('GET', '/api/codes/6205-2RSH')).correspondance, 'referenceFournisseur');
      assert.equal((await tech.ok('GET', '/api/codes/3389110012345')).id, art.contacteur.id);
      // Code accentué : l'étiquette porte « ELEC-01 » (translittéré) ; admin voit le secteur LOG
      assert.equal((await admin.ok('GET', '/api/codes/ELEC-01')).id, art.accent.id);
      assert.equal((await admin.ok('GET', '/api/codes?code=' + encodeURIComponent('élec-01'))).id, art.accent.id);
    });

    test('équipement, OT, demande et inventaire par numéro', async () => {
      const e = await tech.ok('GET', '/api/codes/EQ-0042');
      assert.equal(e.type, 'equipement');
      assert.match(e.lien, /^#\/equipements\/\d+$/);
      assert.equal(e.details.etatCode, 'en_service');
      assert.equal((await tech.ok('GET', '/api/codes/ot-2026-0001')).type, 'ot');
      assert.equal((await admin.ok('GET', '/api/codes/DI-2026-0001')).type, 'demande');
    });

    test('404 si inconnu, hors portée ou sans le droit voir du module correspondant', async () => {
      assert.equal((await tech.get('/api/codes/INCONNU-999')).status, 404);
      assert.match((await tech.get('/api/codes/INCONNU-999')).body.erreur, /INCONNU-999/);
      // Article du secteur Production : invisible pour un technicien de Maintenance
      assert.equal((await tech.get('/api/codes/ART-0007')).status, 404);
      // Le demandeur n'a pas stock.voir : les articles ne sont pas résolus, les équipements oui (si visibles)
      assert.equal((await demandeur.get('/api/codes/ART-0001')).status, 404);
      assert.equal((await demandeur.get('/api/codes/EQ-0050')).status, 200, 'équipement de son secteur');
      assert.equal((await demandeur.get('/api/codes/EQ-0042')).status, 404, 'équipement d\'un autre secteur');
      // Demande d'un autre secteur invisible du technicien (il a demandes.voir)
      assert.equal((await tech.get('/api/codes/DI-2026-0001')).status, 404);
      // Authentification requise
      assert.equal((await clientSite(null).get('/api/codes/ART-0001')).status, 401);
    });
  });

  // ----- Création -------------------------------------------------------------------------------
  let invA; // inventaire « Magasin central » ouvert par resp
  describe('création d\'un inventaire', () => {
    test('validation stricte des entrées', async () => {
      const cas = [
        [{}, 'nom obligatoire'],
        [{ nom: '   ' }, 'nom vide'],
        [{ nom: 'X'.repeat(151) }, 'nom trop long'],
        [{ nom: 'Inv', filtres: { categorieCode: 'inconnue' } }, 'catégorie inconnue'],
        [{ nom: 'Inv', filtres: { fournisseurId: 99999 } }, 'fournisseur inexistant'],
        [{ nom: 'Inv', filtres: { secteurId: 99999 } }, 'magasin inexistant'],
        [{ nom: 'Inv', filtres: 'tout' }, 'filtres invalides'],
        [{ nom: 'Inv', secteurId: 99999 }, 'site inexistant'],
        [{ nom: 'Inv', secteurId: 'abc' }, 'site invalide'],
        [{ nom: 'Inv', aveugle: 'peut-être' }, 'booléen invalide'],
        [{ nom: 'Inv', filtres: { emplacement: 'Zone inexistante' } }, 'périmètre vide'],
      ];
      for (const [body, msg] of cas) {
        const r = await admin.post('/api/inventaires', body);
        assert.equal(r.status, 400, msg + ' : ' + JSON.stringify(r.body));
        assert.equal(typeof r.body.erreur, 'string');
      }
      assert.equal((await admin.post('/api/inventaires', [1])).status, 400, 'corps non objet');
    });

    test('droits : créer requis (403), voir requis pour la liste (403)', async () => {
      assert.equal((await chef.post('/api/inventaires', { nom: 'Chef', secteurId: prod.id })).status, 403);
      assert.equal((await tech.post('/api/inventaires', { nom: 'Tech', secteurId: maint.id })).status, 403);
      assert.equal((await demandeur.get('/api/inventaires')).status, 403);
      assert.equal((await chef.get('/api/inventaires')).status, 200);
    });

    test('portée limitée : site / magasin obligatoire et dans le périmètre', async () => {
      const r1 = await respMaint.post('/api/inventaires', { nom: 'Sans site' });
      assert.equal(r1.status, 400);
      assert.match(r1.body.erreur, /obligatoire/);
      assert.equal((await respMaint.post('/api/inventaires', { nom: 'Hors périmètre', secteurId: prod.id })).status, 403);
      const r = await respMaint.ok('POST', '/api/inventaires', { nom: 'Magasin maintenance', secteurId: maint.id, filtres: { emplacement: 'Magasin central' } });
      // Articles sans magasin et articles de ses secteurs : pas ceux de Production ni de Valréas
      const codes = r.lignes.map((l) => l.code);
      assert.ok(codes.includes('ART-0001') && !codes.includes('ART-0007') && !codes.includes('ART-0101'));
      await admin.ok('DELETE', '/api/inventaires/' + r.id);
    });

    test('instantané du périmètre : articles actifs visibles, préfixe d\'emplacement normalisé, filtres', async () => {
      invA = await resp.ok('POST', '/api/inventaires', { nom: 'Inventaire magasin central', secteurId: maint.id, filtres: { emplacement: 'magasin central - a' }, commentaire: 'Allées A' });
      assert.match(invA.numero, /^INV-\d{4}-\d{3}$/);
      assert.equal(invA.statut, 'en_cours');
      assert.equal(invA.secteurId, maint.id);
      assert.deepEqual(invA.lignes.map((l) => l.code).sort(), ['ART-0001', 'ART-0002', 'ART-0007'], 'actifs uniquement (pas l\'article inactif) — resp a la portée « tous »');
      const l = invA.lignes.find((x) => x.code === 'ART-0001');
      assert.equal(l.quantiteTheorique, 12);
      assert.equal(l.quantiteComptee, null);
      assert.equal(l.prixUnitaire, 8.9);
      assert.equal(l.designation, 'Roulement à billes 6205-2RS');
      assert.equal(invA.resume.nbLignes, 3);
      assert.equal(invA.resume.nbComptees, 0);
      assert.equal(invA.resume.valeurTheorique, Math.round((12 * 8.9 + 4 * 46.8 + 10 * 10) * 100) / 100);
      assert.equal(invA.aveugle, false, 'défaut : config.inventaire.aveugle');
      assert.deepEqual(invA.chevauchements, []);
      assert.ok(srv.db.list('audit', (a) => a.entite === 'inventaires' && a.action === 'creation' && a.entiteId === invA.id).length);
      assert.ok(evenements.some(([e, n]) => e === 'inventaire:ouvert' && n === invA.numero));
      // Filtres catégorie + fournisseur
      const b = await admin.ok('POST', '/api/inventaires', { nom: 'Électrique Rexel', secteurId: maint.id, filtres: { categorieCode: 'electrique', fournisseurId: rexel.id } });
      assert.deepEqual(b.lignes.map((x) => x.code).sort(), ['ART-0003', 'ART-0004']);
      // Chevauchement signalé quand un article est déjà dans un inventaire en cours
      const c = await admin.ok('POST', '/api/inventaires', { nom: 'Allée D', secteurId: maint.id, filtres: { emplacement: 'Magasin central — D1' } });
      assert.equal(c.chevauchements.length, 1);
      assert.equal(c.chevauchements[0].id, b.id);
      await admin.ok('DELETE', '/api/inventaires/' + b.id);
      await admin.ok('DELETE', '/api/inventaires/' + c.id);
      // Aperçu du périmètre
      const ap = await resp.ok('GET', '/api/inventaires-apercu?emplacement=' + encodeURIComponent('Magasin central — D'));
      assert.equal(ap.nbArticles, 2);
      assert.equal(ap.valeurTheorique, Math.round((3 * 72.3 + 8 * 9.8) * 100) / 100);
      assert.equal((await tech.get('/api/inventaires-apercu')).status, 403);
    });

    test('liste filtrée et fiche', async () => {
      const l = await tech.ok('GET', '/api/inventaires?statut=en_cours');
      assert.ok(l.some((x) => x.id === invA.id));
      assert.equal((await tech.get('/api/inventaires?statut=bidon')).status, 400);
      assert.ok((await tech.ok('GET', '/api/inventaires?recherche=central')).some((x) => x.id === invA.id));
      assert.equal((await tech.ok('GET', `/api/inventaires?secteurId=${prod.id}`)).length, 0);
      const d = await tech.ok('GET', '/api/inventaires/' + invA.id);
      assert.equal(d.lignes.length, 3);
      assert.equal(d.droits.compter, true);
      assert.equal(d.droits.valider, false);
      assert.equal(d.createdByNom, 'resp');
      assert.equal((await tech.get('/api/inventaires/99999')).status, 404);
    });
  });

  // ----- Comptages ------------------------------------------------------------------------------
  describe('comptages', () => {
    test('remplacer, ajouter (+1 par défaut), par code ou par article', async () => {
      const r1 = await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'art-0001', quantite: 10, mode: 'remplacer' });
      assert.equal(r1.ligne.articleId, art.roulement.id);
      assert.equal(r1.ligne.quantiteComptee, 10);
      assert.equal(r1.ligne.ecart, -2);
      assert.equal(r1.ligne.valeurEcart, -17.8);
      assert.equal(r1.resume.nbComptees, 1);
      assert.equal(r1.nouvelle, false);
      const r2 = await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'ART-0001', mode: 'ajouter' });
      assert.equal(r2.ligne.quantiteComptee, 11);
      assert.equal(r2.quantitePrecedente, 10);
      const r3 = await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { articleId: art.courroie.id, quantite: '4', mode: 'remplacer' });
      assert.equal(r3.ligne.ecart, 0);
      assert.equal(r3.ligne.comptages.length, 1);
      assert.equal(r3.ligne.comptages[0].userNom, 'tech');
      // Par référence fournisseur
      const r4 = await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: '6205-2RSH', quantite: 1, mode: 'ajouter' });
      assert.equal(r4.ligne.quantiteComptee, 12);
      assert.equal(r4.ligne.comptages.length, 3);
      assert.equal(r4.ligne.ecart, 0);
    });

    test('validation : quantité négative / non numérique, mode inconnu, code manquant', async () => {
      const url = `/api/inventaires/${invA.id}/comptage`;
      for (const body of [{ code: 'ART-0001', quantite: -1 }, { code: 'ART-0001', quantite: 'trois' }, { code: 'ART-0001', quantite: 2, mode: 'multiplier' }, { quantite: 2 }, { code: 'ART-0001' }, { code: 'ART-0001', quantite: 0, mode: 'ajouter' }, { code: 'ART-0001', quantite: true }]) {
        const r = await tech.post(url, body);
        assert.equal(r.status, 400, JSON.stringify(body));
      }
    });

    test('code inconnu, code d\'équipement, article hors portée → 404 explicite', async () => {
      const url = `/api/inventaires/${invA.id}/comptage`;
      const r1 = await tech.post(url, { code: 'XYZ-123', quantite: 1 });
      assert.equal(r1.status, 404);
      assert.match(r1.body.erreur, /XYZ-123.*inconnu/);
      const r2 = await tech.post(url, { code: 'EQ-0042', quantite: 1 });
      assert.equal(r2.status, 404);
      assert.match(r2.body.erreur, /équipement/);
      assert.equal((await tech.post(url, { code: 'ART-0101', quantite: 1 })).status, 404, 'article de Valréas');
    });

    test('article hors périmètre visible : ajouté (horsPerimetre), retiré par l\'annulation du comptage', async () => {
      const r = await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'ART-0005', quantite: 118, mode: 'remplacer' });
      assert.equal(r.nouvelle, true);
      assert.equal(r.ligne.horsPerimetre, true);
      assert.equal(r.ligne.quantiteTheorique, 120);
      assert.equal(r.resume.nbHorsPerimetre, 1);
      assert.equal(r.resume.nbLignes, 4);
      assert.ok(srv.db.list('audit', (a) => a.entiteId === invA.id && /hors périmètre/.test(a.details)).length, 'ajout audité');
      const res = await tech.ok('GET', `/api/inventaires/${invA.id}/resoudre?code=ART-0004`);
      assert.equal(res.horsPerimetre, true);
      assert.equal(res.nouvelle, true);
      assert.equal(res.ligne.code, 'ART-0004');
      const d = await tech.ok('DELETE', `/api/inventaires/${invA.id}/lignes/${art.huile.id}/comptage`);
      assert.equal(d.supprimee, true);
      assert.equal(d.resume.nbLignes, 3);
    });

    test('annulation d\'un comptage et correction (auditée)', async () => {
      await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'ART-0007', quantite: 9 });
      const d = await tech.ok('DELETE', `/api/inventaires/${invA.id}/lignes/${art.prod.id}/comptage`);
      assert.equal(d.supprimee, false);
      assert.equal(d.ligne.quantiteComptee, null);
      assert.equal(d.ligne.comptages.length, 0);
      assert.equal((await tech.del(`/api/inventaires/${invA.id}/lignes/99999/comptage`)).status, 404);
      await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'ART-0007', quantite: 9 });
      await tech.ok('POST', `/api/inventaires/${invA.id}/comptage`, { code: 'ART-0007', quantite: 10, mode: 'remplacer' });
      assert.ok(srv.db.list('audit', (a) => a.entiteId === invA.id && /corrigé.*9 → 10/.test(a.details)).length, 'correction auditée');
    });

    test('droits : modifier requis pour compter (403)', async () => {
      assert.equal((await chef.post(`/api/inventaires/${invA.id}/comptage`, { code: 'ART-0001', quantite: 1 })).status, 403);
      assert.equal((await chef.del(`/api/inventaires/${invA.id}/lignes/${art.roulement.id}/comptage`)).status, 403);
    });

    test('mouvements de stock depuis l\'ouverture signalés sur la ligne', async () => {
      srv.ctx.services.stock.sortir({ articleId: art.courroie.id, quantite: 1, userId: userId('tech'), motif: 'Sortie pendant l\'inventaire' });
      const d = await resp.ok('GET', '/api/inventaires/' + invA.id);
      const l = d.lignes.find((x) => x.code === 'ART-0002');
      assert.equal(l.nbMouvementsDepuis, 1);
      assert.equal(l.variationDepuis, -1);
      assert.equal(l.quantiteActuelle, 3);
      assert.equal(l.ecartActuel, 1, 'compté 4, stock actuel 3');
      assert.equal(d.nbArticlesAvecMouvements, 1);
    });
  });

  // ----- Mode aveugle --------------------------------------------------------------------------
  describe('mode aveugle', () => {
    let invB;
    test('les compteurs sans droit valider ne voient ni quantités théoriques ni écarts', async () => {
      invB = await resp.ok('POST', '/api/inventaires', { nom: 'Allée D à l\'aveugle', secteurId: maint.id, aveugle: true, filtres: { emplacement: 'Magasin central — D' } });
      assert.equal(invB.aveugle, true);
      assert.equal(invB.lignes[0].quantiteTheorique !== undefined, true, 'le valideur voit tout');
      const c = await tech.ok('POST', `/api/inventaires/${invB.id}/comptage`, { code: 'ART-0003', quantite: 2 });
      assert.equal(c.ligne.quantiteComptee, 2);
      for (const k of ['quantiteTheorique', 'ecart', 'valeurEcart', 'quantiteActuelle', 'ecartActuel']) assert.equal(c.ligne[k], undefined, k);
      assert.equal(c.ligne.masque, true);
      assert.equal(c.resume.nbEcarts, undefined);
      assert.equal(c.resume.nbComptees, 1);
      const d = await tech.ok('GET', '/api/inventaires/' + invB.id);
      assert.ok(d.masque);
      assert.ok(d.lignes.every((l) => l.quantiteTheorique === undefined && l.ecart === undefined));
      const liste = await tech.ok('GET', '/api/inventaires');
      assert.equal(liste.find((x) => x.id === invB.id).resume.valeurEcart, undefined);
      const res = await tech.ok('GET', `/api/inventaires/${invB.id}/resoudre?code=ART-0004`);
      assert.equal(res.ligne.quantiteTheorique, undefined);
      // Le valideur voit l'écart
      const dv = await resp.ok('GET', '/api/inventaires/' + invB.id);
      assert.equal(dv.lignes.find((l) => l.code === 'ART-0003').ecart, -1);
      assert.equal(dv.resume.nbEcarts, 1);
    });

    test('changer le mode aveugle exige le droit valider ; export masqué', async () => {
      assert.equal((await tech.put('/api/inventaires/' + invB.id, { aveugle: false })).status, 403);
      const m = await tech.ok('PUT', '/api/inventaires/' + invB.id, { nom: 'Allée D (électricité)', commentaire: 'Renommé' });
      assert.equal(m.nom, 'Allée D (électricité)');
      assert.equal((await tech.put('/api/inventaires/' + invB.id, { nom: '' })).status, 400);
      // Export autorisé par surcharge individuelle : colonnes théoriques et écarts absentes
      const u = srv.db.findOne('users', (x) => x.login === 'tech');
      srv.db.update('users', u.id, { overrides: { inventaire: { exporter: true } } });
      const csv = await tech.get(`/api/inventaires/${invB.id}/export`);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      assert.ok(!/Quantité théorique|Écart/.test(csv.body.split('\r\n')[0]));
      srv.db.update('users', u.id, { overrides: {} });
      assert.equal((await tech.get(`/api/inventaires/${invB.id}/export`)).status, 403);
      const complet = await resp.get(`/api/inventaires/${invB.id}/export`);
      assert.match(complet.body.split('\r\n')[0], /Quantité théorique;Quantité comptée;Écart;Prix unitaire;Valeur de l'écart/);
      assert.match(complet.headers.get('content-disposition'), /inventaire-INV-\d{4}-\d{3}\.csv/);
      assert.ok(srv.db.list('audit', (a) => a.action === 'export' && a.entiteId === invB.id).length);
    });

    test('annulation : valideur ou créateur uniquement, puis suppression possible', async () => {
      assert.equal((await tech.post(`/api/inventaires/${invB.id}/annuler`, {})).status, 403);
      const a = await resp.ok('POST', `/api/inventaires/${invB.id}/annuler`, { motif: 'Comptage à refaire' });
      assert.equal(a.statut, 'annule');
      assert.equal(a.motifAnnulation, 'Comptage à refaire');
      assert.ok(evenements.some(([e, n]) => e === 'inventaire:annule' && n === invB.numero));
      assert.equal((await tech.post(`/api/inventaires/${invB.id}/comptage`, { code: 'ART-0003', quantite: 1 })).status, 400, 'inventaire annulé : plus de comptage');
      assert.equal((await resp.post(`/api/inventaires/${invB.id}/annuler`, {})).status, 400);
      assert.equal((await tech.del('/api/inventaires/' + invB.id)).status, 403, 'supprimer requis');
      await resp.ok('DELETE', '/api/inventaires/' + invB.id);
      assert.equal(srv.db.get('inventaires', invB.id), null);
      assert.ok(srv.db.list('audit', (x) => x.action === 'suppression' && x.entiteId === invB.id).length);
    });
  });

  // ----- Validation ---------------------------------------------------------------------------
  describe('validation', () => {
    test('droit valider requis (403) ; validation sans comptage refusée', async () => {
      assert.equal((await tech.post(`/api/inventaires/${invA.id}/valider`, {})).status, 403);
      const vide = await resp.ok('POST', '/api/inventaires', { nom: 'Vide', secteurId: maint.id, filtres: { emplacement: 'Local lubrifiants' } });
      const r = await resp.post(`/api/inventaires/${vide.id}/valider`, { nonComptesAZero: false });
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /compt/);
      await resp.ok('DELETE', '/api/inventaires/' + vide.id);
    });

    test('mouvements d\'inventaire pour les lignes comptées, stock mis à jour, notification et audit', async () => {
      // Ligne courroie comptée 4, stock passé à 3 par la sortie : la validation fixe le stock à 4
      const avant = srv.db.count('mouvementsStock');
      const v = await admin.ok('POST', `/api/inventaires/${invA.id}/valider`, { nonComptesAZero: false });
      assert.equal(v.statut, 'valide');
      assert.equal(v.validePar, 1);
      assert.ok(v.dateValidation);
      const comptees = v.lignes.filter((l) => l.quantiteComptee != null);
      assert.equal(v.mouvementIds.length, comptees.length);
      assert.equal(srv.db.count('mouvementsStock') - avant, comptees.length);
      const m = srv.db.get('mouvementsStock', v.mouvementIds[0]);
      assert.equal(m.type, 'inventaire');
      assert.match(m.motif, /^Inventaire INV-\d{4}-\d{3}/);
      assert.equal(srv.db.get('articles', art.roulement.id).quantite, 12);
      assert.equal(srv.db.get('articles', art.courroie.id).quantite, 4);
      assert.equal(srv.db.get('articles', art.prod.id).quantite, 10);
      const lc = v.lignes.find((l) => l.code === 'ART-0002');
      assert.equal(lc.quantiteAvantValidation, 3);
      assert.equal(lc.ecartApplique, 1);
      assert.ok(srv.db.list('audit', (a) => a.action === 'validation' && a.entiteId === invA.id).length);
      const notif = srv.db.list('notifications', (n) => n.userId === userId('resp') && n.lien === `#/inventaire/${invA.id}`);
      assert.equal(notif.length, 1, 'le créateur est notifié');
      assert.ok(evenements.some(([e, n]) => e === 'inventaire:valide' && n === invA.numero));
    });

    test('un inventaire validé n\'est plus modifiable ni supprimable', async () => {
      assert.equal((await admin.post(`/api/inventaires/${invA.id}/valider`, {})).status, 400);
      assert.equal((await admin.post(`/api/inventaires/${invA.id}/comptage`, { code: 'ART-0001', quantite: 1 })).status, 400);
      assert.equal((await admin.post(`/api/inventaires/${invA.id}/annuler`, {})).status, 400);
      assert.equal((await admin.put(`/api/inventaires/${invA.id}`, { nom: 'X' })).status, 400);
      const r = await admin.del('/api/inventaires/' + invA.id);
      assert.equal(r.status, 400);
      assert.match(r.body.erreur, /validé/);
      const d = await admin.ok('GET', '/api/inventaires/' + invA.id);
      assert.equal(d.droits.compter, false);
      assert.equal(d.droits.supprimer, false);
    });

    test('option « mettre à zéro les non comptés »', async () => {
      const inv = await resp.ok('POST', '/api/inventaires', { nom: 'Allée D', secteurId: maint.id, filtres: { emplacement: 'Magasin central — D' } });
      await tech.ok('POST', `/api/inventaires/${inv.id}/comptage`, { code: 'ART-0003', quantite: 3 });
      const v = await resp.ok('POST', `/api/inventaires/${inv.id}/valider`, { nonComptesAZero: true });
      assert.equal(v.mouvementIds.length, 2);
      assert.equal(srv.db.get('articles', art.fusibles.id).quantite, 0);
      assert.equal(v.lignes.find((l) => l.code === 'ART-0004').misAZero, true);
      assert.equal(v.resume.nbEcarts, 1);
      assert.equal(v.resume.valeurEcart, -78.4);
      assert.equal(v.nonComptesAZero, true);
      // Remise en stock pour la suite
      srv.ctx.services.stock.inventorier({ articleId: art.fusibles.id, quantite: 8, userId: 1, motif: 'test' });
    });

    test('503 si le module stock est indisponible', async () => {
      const inv = await resp.ok('POST', '/api/inventaires', { nom: 'Sans stock', secteurId: maint.id, filtres: { emplacement: 'Magasin central — D1' } });
      await resp.ok('POST', `/api/inventaires/${inv.id}/comptage`, { code: 'ART-0003', quantite: 3 });
      const s = srv.ctx.services.stock;
      delete srv.ctx.services.stock;
      try { assert.equal((await resp.post(`/api/inventaires/${inv.id}/valider`, {})).status, 503); } finally { srv.ctx.services.stock = s; }
      assert.equal((await resp.ok('GET', '/api/inventaires/' + inv.id)).statut, 'en_cours');
      await resp.ok('POST', `/api/inventaires/${inv.id}/annuler`, {});
    });
  });

  // ----- Étiquettes --------------------------------------------------------------------------
  describe('données d\'étiquettes', () => {
    test('articles : filtres, sous le seuil, recherche, identifiants (ordre conservé), portée', async () => {
      const r = await tech.ok('GET', '/api/etiquettes/donnees?source=articles');
      const codes = r.lignes.map((l) => l.code);
      assert.ok(codes.includes('ART-0001') && !codes.includes('ART-0006') && !codes.includes('ART-0007') && !codes.includes('ART-0101'), 'actifs et visibles uniquement');
      const l = r.lignes.find((x) => x.code === 'ART-0001');
      assert.equal(l.designation, 'Roulement à billes 6205-2RS');
      assert.equal(l.referenceFournisseur, '6205-2RSH');
      assert.equal(l.fournisseurNom, 'SKF France');
      assert.equal(l.categorieLibelle, 'Mécanique');
      assert.equal(l.uniteLibelle, 'Unité');
      assert.equal(l.encodable, true);
      assert.equal(r.societe, 'SICAF');
      assert.deepEqual((await tech.ok('GET', '/api/etiquettes/donnees?source=articles&categorieCode=electrique&fournisseurId=' + rexel.id)).lignes.map((x) => x.code).sort(), ['ART-0003', 'ART-0004']);
      assert.deepEqual((await tech.ok('GET', '/api/etiquettes/donnees?emplacement=' + encodeURIComponent('magasin central - d'))).lignes.map((x) => x.code), ['ART-0003', 'ART-0004']);
      assert.ok((await tech.ok('GET', '/api/etiquettes/donnees?recherche=roulement')).lignes.every((x) => /roulement/i.test(x.designation)));
      const ids = await tech.ok('GET', `/api/etiquettes/donnees?source=articles&ids=${art.fusibles.id},${art.roulement.id},${art.prod.id}`);
      assert.deepEqual(ids.lignes.map((x) => x.code), ['ART-0004', 'ART-0001'], 'ordre demandé, article hors portée ignoré');
      assert.equal(ids.manquants, 1);
      srv.db.update('articles', art.huile.id, { quantite: 1, seuilMin: 40 });
      assert.deepEqual((await tech.ok('GET', '/api/etiquettes/donnees?sousSeuil=1')).lignes.map((x) => x.code), ['ART-0005']);
      srv.db.update('articles', art.huile.id, { quantite: 120, seuilMin: 2 });
      // Code accentué : encodable après translittération
      assert.equal((await admin.ok('GET', `/api/etiquettes/donnees?ids=${art.accent.id}`)).lignes[0].encodable, true);
    });

    test('équipements : numéro, filtres secteur et type ; validation et droits', async () => {
      const r = await tech.ok('GET', '/api/etiquettes/donnees?source=equipements');
      assert.ok(r.lignes.some((e) => e.code === 'EQ-0042' && e.designation === 'Compresseur GA 37' && e.emplacement === 'Local compresseurs'));
      assert.ok(!r.lignes.some((e) => e.code === 'EQ-0099'), 'équipement de Valréas invisible');
      assert.deepEqual((await admin.ok('GET', `/api/etiquettes/donnees?source=equipements&secteurId=${site2.id}`)).lignes.map((x) => x.code), ['EQ-0099']);
      assert.equal((await admin.ok('GET', '/api/etiquettes/donnees?source=equipements&typeCode=vehicule')).lignes.length, 0);
      assert.equal((await tech.get('/api/etiquettes/donnees?source=fournisseurs')).status, 400);
      assert.equal((await tech.get('/api/etiquettes/donnees?ids=1,abc')).status, 400);
      assert.equal((await tech.get('/api/etiquettes/donnees?ids=' + Array.from({ length: 2001 }, (_, i) => i + 1).join(','))).status, 400);
      // inventaire.voir requis, puis voir du module source
      assert.equal((await demandeur.get('/api/etiquettes/donnees?source=equipements')).status, 403);
      const u = srv.db.findOne('users', (x) => x.login === 'demandeur');
      srv.db.update('users', u.id, { overrides: { inventaire: { voir: true } } });
      assert.equal((await demandeur.get('/api/etiquettes/donnees?source=equipements')).status, 200);
      assert.equal((await demandeur.get('/api/etiquettes/donnees?source=articles')).status, 403, 'stock.voir requis');
      srv.db.update('users', u.id, { overrides: {} });
    });

    test('références des filtres : emplacements, zones, fournisseurs', async () => {
      const r = await tech.ok('GET', '/api/inventaire/references');
      assert.ok(r.emplacements.includes('Magasin central — A1 — Étagère 2'));
      assert.ok(r.zones.includes('Magasin central') && r.zones.includes('Magasin central — A1'));
      assert.ok(r.fournisseurs.some((f) => f.nom === 'SKF France'));
      assert.ok(!r.emplacements.some((e) => /Valréas/.test(e)));
      assert.deepEqual(r.statuts.map((s) => s.code), ['en_cours', 'valide', 'annule']);
    });
  });

  // ----- Multi-site ---------------------------------------------------------------------------
  describe('multi-site', () => {
    let invVal;
    test('un utilisateur du site 1 ne voit pas les inventaires ni les articles du site 2', async () => {
      invVal = await admin.ok('POST', '/api/inventaires', { nom: 'Inventaire Valréas', secteurId: site2.id });
      // Site 2 : ses articles et ceux sans magasin ; ni l'article inactif, ni ceux rattachés au site 1 (PROD, LOG)
      assert.deepEqual(invVal.lignes.map((l) => l.code).sort(), ['ART-0001', 'ART-0002', 'ART-0003', 'ART-0004', 'ART-0005', 'ART-0101', 'ART-0102']);
      const t1 = await utilisateur('tech.site1', 'Technicien', [maint.id], { porteeOverride: 'site' });
      assert.ok(!(await t1.ok('GET', '/api/inventaires')).some((i) => i.id === invVal.id));
      assert.equal((await t1.get('/api/inventaires/' + invVal.id)).status, 404);
      assert.equal((await t1.post(`/api/inventaires/${invVal.id}/comptage`, { code: 'ART-0101', quantite: 1 })).status, 404);
      assert.equal((await t1.get('/api/codes/ART-0101')).status, 404);
      assert.equal((await t1.get('/api/codes/EQ-0099')).status, 404);
    });

    test('accès en lecture seule au site 2 : lecture possible, comptage / validation refusés (403)', async () => {
      const l = await utilisateur('lecteur', 'Responsable maintenance', [maint.id], { porteeOverride: 'site', siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
      assert.ok((await l.ok('GET', '/api/inventaires')).some((i) => i.id === invVal.id));
      const d = await l.ok('GET', '/api/inventaires/' + invVal.id);
      assert.equal(d.droits.lectureSeule, true);
      assert.equal(d.droits.compter, false);
      assert.equal(d.droits.valider, false);
      assert.equal((await l.post(`/api/inventaires/${invVal.id}/comptage`, { code: 'ART-0101', quantite: 1 })).status, 403);
      assert.equal((await l.post(`/api/inventaires/${invVal.id}/valider`, {})).status, 403);
      assert.equal((await l.post(`/api/inventaires/${invVal.id}/annuler`, {})).status, 403);
      assert.equal((await l.del('/api/inventaires/' + invVal.id)).status, 403);
      assert.equal((await l.post('/api/inventaires', { nom: 'Chez Valréas', secteurId: site2.id })).status, 403, 'pas de création sur un site en lecture seule');
      assert.equal((await l.ok('GET', '/api/codes/ART-0101')).id, art.val.id, 'consultation par code autorisée');
      // Un inventaire du site 1 ne peut pas compter un article du site en lecture seule
      const inv1 = await l.ok('POST', '/api/inventaires', { nom: 'Site 1', secteurId: maint.id, filtres: { emplacement: 'Magasin central — D1' } });
      assert.equal((await l.post(`/api/inventaires/${inv1.id}/comptage`, { code: 'ART-0101', quantite: 1 })).status, 404);
      assert.equal((await l.post(`/api/inventaires/${inv1.id}/comptage`, { code: 'ART-0003', quantite: 3 })).status, 200);
      await l.ok('POST', `/api/inventaires/${inv1.id}/annuler`, {});
    });

    test('en-tête X-GMAO-Site : filtre des listes et site par défaut à la création', async () => {
      const a2 = clientSite(site2.id);
      await a2.login('admin', 'admin');
      const liste = await a2.ok('GET', '/api/inventaires');
      assert.ok(liste.length >= 1);
      assert.ok(liste.every((i) => i.secteurId == null || i.siteId === site2.id), 'uniquement le site 2');
      const a1 = clientSite(site1.id);
      await a1.login('admin', 'admin');
      assert.ok(!(await a1.ok('GET', '/api/inventaires')).some((i) => i.id === invVal.id));
      assert.equal((await a1.get('/api/inventaires/' + invVal.id)).status, 404);
      const cree = await a2.ok('POST', '/api/inventaires', { nom: 'Valréas R2', filtres: { emplacement: 'Magasin Valréas — R2' } });
      assert.equal(cree.secteurId, site2.id, 'site courant repris par défaut');
      assert.deepEqual(cree.lignes.map((x) => x.code), ['ART-0102']);
      assert.equal((await a1.get('/api/etiquettes/donnees?ids=' + art.val.id)).body.lignes.length, 0, 'étiquettes filtrées par site');
      await a2.ok('DELETE', '/api/inventaires/' + cree.id);
      await admin.ok('DELETE', '/api/inventaires/' + invVal.id);
    });
  });

  // ----- Services, démonstration ----------------------------------------------------------------
  test('services publiés : resoudreCode, enCoursPourArticle, calculerResume', async () => {
    const s = srv.ctx.services.inventaire;
    assert.equal(typeof s.resoudreCode, 'function');
    const inv = await resp.ok('POST', '/api/inventaires', { nom: 'Service', secteurId: maint.id, filtres: { emplacement: 'Magasin central — A1' } });
    assert.deepEqual(s.enCoursPourArticle(art.roulement.id).map((x) => x.id), [inv.id]);
    const c = await tech.ok('GET', '/api/codes/ART-0001');
    assert.deepEqual(c.details.inventairesEnCours.map((x) => x.id), [inv.id]);
    const r = s.calculerResume([{ quantiteTheorique: 5, quantiteComptee: 3, prixUnitaire: 2 }, { quantiteTheorique: 1, quantiteComptee: null, prixUnitaire: 10 }], { nonComptesAZero: true });
    assert.equal(r.nbEcarts, 2);
    assert.equal(r.valeurEcart, -14);
    assert.equal(r.nbComptees, 1);
    assert.equal(r.progression, 50);
    await resp.ok('POST', `/api/inventaires/${inv.id}/annuler`, {});
  });

  test('données de démonstration : idempotentes, journal de stock cohérent', async () => {
    const autre = await demarrer();
    try {
      const mod = require('../server/modules/inventaire');
      const msg = mod.seedDemo(autre.ctx);
      assert.match(msg, /2 inventaire/);
      assert.equal(mod.seedDemo(autre.ctx), 'déjà présents');
      const invs = autre.db.list('inventaires');
      assert.equal(invs.length, 2);
      const valide = invs.find((i) => i.statut === 'valide');
      const enCours = invs.find((i) => i.statut === 'en_cours');
      assert.ok(valide && enCours);
      assert.ok(valide.resume.nbEcarts >= 1, 'écarts sur l\'inventaire validé');
      assert.equal(valide.mouvementIds.length, valide.lignes.length);
      for (const id of valide.mouvementIds) assert.equal(autre.db.get('mouvementsStock', id).type, 'inventaire');
      const jours = (Date.now() - new Date(valide.dateValidation).getTime()) / 86400000;
      assert.ok(jours > 29 && jours < 31.5, 'validé il y a 30 jours');
      assert.ok(enCours.resume.nbComptees > 0 && enCours.resume.nbComptees < enCours.resume.nbLignes, 'partiellement compté');
      assert.ok(/^INV-\d{4}-\d{3}$/.test(valide.numero) && valide.numero !== enCours.numero);
      // Continuité du journal de stock (les écarts ont été intégrés sans changer le stock actuel)
      const mvts = autre.db.list('mouvementsStock');
      for (const a of autre.db.list('articles')) {
        const ms = mvts.filter((m) => m.articleId === a.id).sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
        let q = 0;
        for (const m of ms) { assert.equal(m.quantiteAvant, q, `${a.code} : continuité du journal (${m.motif})`); q = m.quantiteApres; }
        assert.equal(q, a.quantite, `${a.code} : quantité = dernier mouvement`);
      }
      const c = autre.client();
      await c.login('admin', 'admin');
      const d = await c.ok('GET', '/api/inventaires/' + enCours.id);
      assert.equal(d.aveugle, true);
      assert.ok(d.lignes.length >= 2);
    } finally { await autre.stop(); }
  });
});
