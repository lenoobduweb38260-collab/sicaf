'use strict';
/**
 * Module Plans 3D : CRUD, validation stricte des objets, contrôle de concurrence (409), fond de plan,
 * liens équipements / secteurs (enrichissement, masquage, même site), droits (403), portée par secteur,
 * multi-site (site 2, accès en lecture seule, en-tête X-GMAO-Site), duplication, localisation,
 * état vivant, export / import, événements, données de démonstration, et mathématiques du moteur 3D.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

// Image PNG 2×2 valide (signature correcte)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2NkYGD4z8DAwMDIwMDAAAAhBAQBpB2xOQAAAABJRU5ErkJggg==';

describe('Plans 3D', () => {
  let srv, admin, profils, secteurs, site1, prod, maint, sg, site2, prod2, eqProd, eqMaint, eqSg, eqSite2;

  /** Client conservant le cookie et pouvant envoyer l'en-tête de site. */
  function clientSite(site) {
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'x-requested-with': 'GMAO', cookie };
      if (site != null) headers['x-gmao-site'] = String(site);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(srv.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = txt; }
      return { status: r.status, body: data, headers: r.headers, brut: txt };
    };
    return {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      async login(l, p) { const r = await call('POST', '/api/auth/login', { login: l, password: p }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body; },
      async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
    };
  }
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  async function utilisateur(login, options) {
    await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, password: 'pass1234', doitChangerMdp: false }, options));
    const c = clientSite(null);
    await c.login(login, 'pass1234');
    return c;
  }
  const planSimple = (extra) => Object.assign({ nom: 'Atelier test', secteurId: site1.id, dimensions: { largeur: 60, profondeur: 40 } }, extra || {});
  const machine = (id, extra) => Object.assign({ id, type: 'machine', nom: 'Machine ' + id, x: 10, y: 10, largeur: 2, profondeur: 1.5, hauteur: 1.8 }, extra || {});

  before(async () => {
    srv = await demarrer();
    admin = clientSite(null);
    await admin.login('admin', 'admin');
    secteurs = await admin.ok('GET', '/api/secteurs');
    site1 = secteurs.find((s) => s.code === 'SITE');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    sg = secteurs.find((s) => s.code === 'SG');
    site2 = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    prod2 = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: site2.id });
    profils = await admin.ok('GET', '/api/profils');
    eqProd = srv.db.insert('equipements', { numero: 'EQ-T1', nom: 'Presse de test', secteurId: prod.id, etatCode: 'en_service', criticiteCode: 'A', actif: true });
    eqMaint = srv.db.insert('equipements', { numero: 'EQ-T2', nom: 'Tour de maintenance', secteurId: maint.id, etatCode: 'degrade', criticiteCode: 'B', actif: true });
    eqSg = srv.db.insert('equipements', { numero: 'EQ-SECRET-SG', nom: 'Compresseur confidentiel', secteurId: sg.id, etatCode: 'en_service', criticiteCode: 'A', actif: true });
    eqSite2 = srv.db.insert('equipements', { numero: 'EQ-V1', nom: 'Presse Valréas', secteurId: prod2.id, etatCode: 'arret', criticiteCode: 'A', actif: true });
  });
  after(async () => { await srv.stop(); });

  // ----- CRUD ------------------------------------------------------------------------
  test('création : numéro automatique, niveau RDC par défaut, version 1, audit', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple());
    assert.match(p.numero, /^PL-\d{3}$/);
    assert.equal(p.version, 1);
    assert.equal(p.niveaux.length, 1);
    assert.equal(p.niveaux[0].id, 'rdc');
    assert.deepEqual(p.dimensions, { largeur: 60, profondeur: 40 });
    assert.equal(p.siteId, site1.id);
    assert.equal(p.droits.modifier, true);
    assert.ok(srv.db.findOne('audit', (a) => a.entite === 'plans' && a.action === 'creation' && a.entiteId === p.id));
  });

  test('liste, fiche, modification avec version, conflit 409, suppression', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan CRUD', objets: [machine('m1'), { id: 'z1', type: 'zone', nom: 'Zone A', x: 20, y: 20, largeur: 10, profondeur: 8, secteurId: prod.id }] }));
    const liste = await admin.ok('GET', '/api/plans');
    const l = liste.find((x) => x.id === p.id);
    assert.equal(l.nbObjets, 2);
    assert.equal(l.parType.machine, 1);
    assert.ok(Array.isArray(l.apercu) && l.apercu.length === 2, 'aperçu de miniature');
    assert.equal(l.objets, undefined, 'la liste ne transporte pas les objets');
    const fiche = await admin.ok('GET', '/api/plans/' + p.id);
    assert.equal(fiche.objets.length, 2);
    assert.equal(fiche.objets.find((o) => o.id === 'z1').secteur.nom, prod.nom);
    // modification
    const m = await admin.ok('PUT', '/api/plans/' + p.id, { version: 1, nom: 'Plan CRUD modifié', objets: fiche.objets.concat([machine('m2', { x: 30 })]) });
    assert.equal(m.version, 2);
    assert.equal(m.nom, 'Plan CRUD modifié');
    assert.equal(m.objets.length, 3);
    // version obsolète
    const conflit = await admin.put('/api/plans/' + p.id, { version: 1, nom: 'Écrasement' });
    assert.equal(conflit.status, 409);
    assert.match(conflit.body.erreur, /modifié par quelqu'un d'autre/);
    assert.equal(conflit.body.details.version, 2);
    // version absente
    assert.equal((await admin.put('/api/plans/' + p.id, { nom: 'Sans version' })).status, 400);
    // modification partielle : les objets sont conservés
    const partiel = await admin.ok('PUT', '/api/plans/' + p.id, { version: 2, description: 'Nouvelle description' });
    assert.equal(partiel.objets.length, 3);
    assert.equal(partiel.version, 3);
    // suppression
    await admin.ok('DELETE', '/api/plans/' + p.id);
    assert.equal((await admin.get('/api/plans/' + p.id)).status, 404);
    assert.ok(srv.db.findOne('audit', (a) => a.entite === 'plans' && a.action === 'suppression' && a.entiteId === p.id));
  });

  // ----- Validation --------------------------------------------------------------------
  test('validation du plan : nom, dimensions, niveaux', async () => {
    const cas = [
      [{ nom: '' }, /nom du plan/i],
      [{ dimensions: { largeur: 0, profondeur: 40 } }, /largeur/i],
      [{ dimensions: { largeur: 60, profondeur: 2001 } }, /profondeur/i],
      [{ dimensions: { largeur: 'abc', profondeur: 40 } }, /nombre/i],
      [{ niveaux: [] }, /au moins un niveau/i],
      [{ niveaux: [{ id: 'a', nom: 'RDC' }, { id: 'a', nom: 'R+1' }] }, /double/i],
      [{ niveaux: [{ id: 'a', nom: '' }] }, /nom du niveau/i],
      [{ secteurId: 99999 }, /invalide/i],
    ];
    for (const [extra, re] of cas) {
      const r = await admin.post('/api/plans', planSimple(extra));
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(r.body.erreur, re, JSON.stringify(extra));
    }
  });

  test('validation stricte des objets', async () => {
    const cas = [
      [[{ id: 'a', type: 'fusee', x: 1, y: 1 }], /type inconnu/],
      [[machine('a'), machine('a')], /double/],
      [[machine('a', { x: 'NaN' })], /nombre/],
      [[machine('a', { x: 1e9 })], /hors limites/],
      [[machine('a', { y: null })], /obligatoire/],
      [[machine('a', { largeur: -2 })], /hors limites/],
      [[machine('a', { couleur: 'rouge' })], /couleur/],
      [[machine('a', { niveauId: 'r+9' })], /niveau inconnu/],
      [[machine('a', { forme: 'pyramide' })], /forme/],
      [[machine('a', { id: 'avec espace' })], /identifiant/],
      [[{ id: 'w', type: 'mur', x: 1, y: 1 }], /x2/],
      [[{ id: 'w', type: 'mur', x: 1, y: 1, x2: 1, y2: 1 }], /longueur/],
      [[{ id: 'z', type: 'zone', x: 1, y: 1, points: [[0, 0], [1, 1]] }], /3 sommets/],
      [[{ id: 'z', type: 'zone', x: 1, y: 1, points: [[0, 0], [1, 0], [2, 0]] }], /dégénéré/],
      [[{ id: 'i', type: 'installation', categorie: 'soucoupe', x: 1, y: 1 }], /catégorie/],
      [[{ id: 't', type: 'texte', x: 1, y: 1, texte: '' }], /texte est obligatoire/],
      [[machine('a', { equipementId: 999999 })], /introuvable/],
      [[machine('a', { equipementId: eqSite2.id })], /autre site/],
      [[machine('a', { equipementId: eqProd.id }), machine('b', { equipementId: eqProd.id })], /déjà placé/],
      [[{ id: 'z', type: 'zone', x: 5, y: 5, largeur: 4, profondeur: 4, secteurId: prod2.id }], /autre site/],
      [[{ id: 'z', type: 'zone', x: 5, y: 5, largeur: 4, profondeur: 4, secteurId: 88888 }], /introuvable/],
      ['pas une liste', /invalide/],
    ];
    for (const [objets, re] of cas) {
      const r = await admin.post('/api/plans', planSimple({ objets }));
      assert.equal(r.status, 400, JSON.stringify(objets).slice(0, 120));
      assert.match(r.body.erreur, re, JSON.stringify(objets).slice(0, 120) + ' → ' + r.body.erreur);
    }
    // 5 000 objets au plus
    const trop = Array.from({ length: 5001 }, (_, i) => ({ id: 'o' + i, type: 'machine', x: 1, y: 1 }));
    const r = await admin.post('/api/plans', planSimple({ objets: trop }));
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /5000 objets/);
  });

  test('normalisation : segments, polygones, rotation, valeurs par défaut', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({
      niveaux: [{ id: 'rdc', nom: 'RDC', altitude: 0, hauteur: 6 }, { id: 'r1', nom: 'Mezzanine', hauteur: 3 }],
      objets: [
        { id: 'w1', type: 'mur', x: 0, y: 0, x2: 3, y2: 4, epaisseur: 0.25 },
        { id: 'z1', type: 'zone', x: 0, y: 0, points: [[10, 10], [20, 10], [20, 16], [10, 16]], rotation: 30 },
        machine('m1', { rotation: -90, niveauId: 'r1', couleur: '#ABCDEF' }),
        { id: 'r1', type: 'installation', categorie: 'reseau_air', x: 0, y: 5, x2: 10, y2: 5, z: 4 },
        { id: 't1', type: 'texte', x: 30, y: 30, texte: 'Quai' },
      ],
    }));
    const o = Object.fromEntries(p.objets.map((x) => [x.id, x]));
    assert.equal(o.w1.largeur, 5, 'longueur du mur calculée');
    assert.equal(o.w1.epaisseur, 0.25);
    assert.deepEqual([o.z1.x, o.z1.y, o.z1.largeur, o.z1.profondeur, o.z1.rotation], [15, 13, 10, 6, 0], 'emprise du polygone');
    assert.equal(o.m1.rotation, 270);
    assert.equal(o.m1.couleur, '#abcdef');
    assert.equal(o.m1.niveauId, 'r1');
    assert.equal(o.m1.forme, 'boite');
    assert.equal(o.r1.largeur, 10);
    assert.equal(o.r1.z, 4);
    assert.equal(o.t1.texte, 'Quai');
    assert.equal(p.niveaux[1].altitude, 6, 'altitude du niveau supérieur déduite');
  });

  // ----- Fond de plan -----------------------------------------------------------------------
  test('fond de plan : PNG accepté, servi en binaire, conservé, retiré ; formats refusés', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ fond: { image: PNG, echelle: 0.05, x: 30, y: 20, opacite: 0.5, nomFichier: 'plan.png' } }));
    assert.ok(p.fond.imageUrl);
    assert.equal(p.fond.image, undefined, 'image non incluse dans le JSON de la fiche');
    assert.equal(p.fond.type, 'image/png');
    const r = await fetch(srv.base + p.fond.imageUrl, { headers: { cookie: '' } });
    assert.equal(r.status, 401, 'image protégée par la session');
    const img = await admin.get(p.fond.imageUrl);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    // fond sans image renvoyée : image conservée, paramètres modifiés
    const m = await admin.ok('PUT', '/api/plans/' + p.id, { version: 1, fond: { echelle: 0.00012345, x: 10, y: 10, opacite: 0.8 } });
    assert.equal(m.fond.echelle, 0.00012345, 'précision de l\'échelle conservée');
    assert.equal(m.fond.taille, p.fond.taille);
    const sans = await admin.ok('PUT', '/api/plans/' + p.id, { version: 2, fond: null });
    assert.equal(sans.fond, null);
    const gif = await admin.post('/api/plans', planSimple({ fond: { image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', echelle: 1 } }));
    assert.equal(gif.status, 400);
    const faux = await admin.post('/api/plans', planSimple({ fond: { image: 'data:image/png;base64,' + Buffer.from('<html>pas une image</html>').toString('base64'), echelle: 1 } }));
    assert.equal(faux.status, 400);
    assert.match(faux.body.erreur, /ne correspond pas/);
    const grosse = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8.5 * 1024 * 1024)]).toString('base64');
    const tropGros = await admin.post('/api/plans', planSimple({ fond: { image: grosse, echelle: 1 } }));
    assert.equal(tropGros.status, 400);
    assert.match(tropGros.body.erreur, /8 Mo/);
  });

  // ----- Enrichissement, état vivant, localisation ------------------------------------------
  test('équipements liés : nom, numéro, état, criticité, OT et demandes ouverts, alerte', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan enrichi', objets: [machine('m1', { equipementId: eqProd.id }), machine('m2', { equipementId: eqMaint.id, x: 20 })] }));
    let fiche = await admin.ok('GET', '/api/plans/' + p.id);
    const o1 = fiche.objets.find((o) => o.id === 'm1');
    assert.equal(o1.equipement.numero, 'EQ-T1');
    assert.equal(o1.equipement.nom, 'Presse de test');
    assert.equal(o1.equipement.etatCode, 'en_service');
    assert.equal(o1.equipement.criticiteCode, 'A');
    assert.equal(o1.equipement.nbOtOuverts, 0);
    assert.equal(o1.equipement.alerte, 'aucun');
    srv.db.insert('ot', { numero: 'OT-T1', titre: 'Fuite', equipementId: eqProd.id, secteurId: prod.id, statut: 'en_cours', prioriteCode: 'normale' });
    srv.db.insert('ot', { numero: 'OT-T2', titre: 'Terminé', equipementId: eqProd.id, secteurId: prod.id, statut: 'termine', prioriteCode: 'urgente' });
    srv.db.insert('demandes', { numero: 'DI-T1', titre: 'Bruit', equipementId: eqMaint.id, secteurId: maint.id, statut: 'soumise', prioriteCode: 'normale' });
    let etat = await admin.ok('GET', `/api/plans/${p.id}/etat`);
    assert.equal(etat.version, 1);
    assert.equal(etat.equipements[eqProd.id].nbOtOuverts, 1, 'OT terminés exclus');
    assert.equal(etat.equipements[eqProd.id].prioriteMax, 'normale');
    assert.equal(etat.equipements[eqProd.id].alerte, 'en_cours');
    assert.equal(etat.equipements[eqMaint.id].nbDemandesOuvertes, 1);
    assert.equal(etat.equipements[eqMaint.id].alerte, 'en_cours');
    srv.db.insert('ot', { numero: 'OT-T3', titre: 'Arrêt', equipementId: eqProd.id, secteurId: prod.id, statut: 'nouveau', prioriteCode: 'urgente' });
    etat = await admin.ok('GET', `/api/plans/${p.id}/etat`);
    assert.equal(etat.equipements[eqProd.id].alerte, 'urgent');
    assert.equal(etat.equipements[eqProd.id].prioriteMax, 'urgente');
    fiche = await admin.ok('GET', '/api/plans/' + p.id);
    assert.equal(fiche.objets.find((o) => o.id === 'm1').equipement.nbOtOuverts, 2);
    // localisation
    const loc = await admin.ok('GET', '/api/plans-localiser/' + eqProd.id);
    assert.ok(loc.some((l) => l.planId === p.id && l.objetId === 'm1' && l.planNom === 'Plan enrichi'));
    assert.equal((await admin.get('/api/plans-localiser/987654')).status, 404);
  });

  test('duplication : nouveau numéro, version 1, objets et liens conservés sur le même site', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Source', objets: [machine('m1', { equipementId: eqMaint.id }), { id: 'z', type: 'zone', x: 5, y: 5, largeur: 4, profondeur: 4, secteurId: maint.id }] }));
    const c = await admin.ok('POST', `/api/plans/${p.id}/dupliquer`, {});
    assert.notEqual(c.id, p.id);
    assert.notEqual(c.numero, p.numero);
    assert.equal(c.nom, 'Source (copie)');
    assert.equal(c.version, 1);
    assert.equal(c.objets.length, 2);
    assert.equal(c.objets.find((o) => o.id === 'm1').equipementId, eqMaint.id);
    // vers un autre site : liens retirés
    const c2 = await admin.ok('POST', `/api/plans/${p.id}/dupliquer`, { nom: 'Copie Valréas', secteurId: site2.id });
    assert.equal(c2.siteId, site2.id);
    assert.equal(c2.objets.find((o) => o.id === 'm1').equipementId, null);
    assert.equal(c2.objets.find((o) => o.id === 'z').secteurId, null);
  });

  test('export JSON puis import : liens rétablis par numéro d\'équipement et code de secteur', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'À exporter', fond: { image: PNG, echelle: 0.02 }, objets: [machine('m1', { equipementId: eqProd.id }), { id: 'z', type: 'zone', x: 5, y: 5, largeur: 4, profondeur: 4, secteurId: prod.id }] }));
    const ex = await admin.get(`/api/plans/${p.id}/export`);
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get('content-disposition'), /attachment; filename="plan-PL-\d+\.json"/);
    assert.equal(ex.body.format, 'sicaf-plan-3d');
    assert.equal(ex.body.plan.objets[0].equipementRef.numero, 'EQ-T1');
    assert.ok(ex.body.plan.fond.image.startsWith('data:image/png'));
    const imp = await admin.ok('POST', '/api/plans/import', { fichier: ex.body, nom: 'Plan importé' });
    assert.equal(imp.nom, 'Plan importé');
    assert.notEqual(imp.id, p.id);
    assert.equal(imp.objets.find((o) => o.id === 'm1').equipementId, eqProd.id);
    assert.equal(imp.objets.find((o) => o.id === 'z').secteurId, prod.id);
    assert.ok(imp.fond && imp.fond.imageUrl);
    assert.equal(imp.rapport.liensConserves, 1);
    // import vers le site 2 : le lien d'équipement du site 1 est retiré (aucun EQ-T1 à Valréas)
    const imp2 = await admin.ok('POST', '/api/plans/import', { fichier: ex.body, secteurId: site2.id });
    assert.equal(imp2.objets.find((o) => o.id === 'm1').equipementId, null);
    assert.ok(imp2.rapport.liensRetires >= 1);
    assert.equal((await admin.post('/api/plans/import', { fichier: { format: 'autre' } })).status, 400);
  });

  // ----- Droits ------------------------------------------------------------------------------
  test('droits : un technicien consulte mais ne peut ni créer, ni modifier, ni supprimer (403)', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan protégé' }));
    const t = await utilisateur('tech_plans', { profilId: profil('Technicien'), secteurIds: [prod.id] });
    const fiche = await t.ok('GET', '/api/plans/' + p.id);
    assert.equal(fiche.droits.modifier, false);
    assert.equal((await t.post('/api/plans', planSimple({ secteurId: prod.id }))).status, 403);
    assert.equal((await t.put('/api/plans/' + p.id, { version: 1, nom: 'X' })).status, 403);
    assert.equal((await t.del('/api/plans/' + p.id)).status, 403);
    assert.equal((await t.post(`/api/plans/${p.id}/dupliquer`, {})).status, 403);
    assert.equal((await t.post('/api/plans/import', { format: 'sicaf-plan-3d', plan: {} })).status, 403);
    // un utilisateur sans droit « voir » est refusé
    const rh = await utilisateur('rh_plans', { profilId: profil('Gestionnaire RH'), secteurIds: [prod.id] });
    assert.equal((await rh.get('/api/plans')).status, 403);
  });

  test('portée : le plan du site est consultable par les secteurs du site (demandeur compris), modifiable seulement avec une portée d\'écriture suffisante', async () => {
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan du site 1' }));
    const d = await utilisateur('dem_plans', { profilId: profil('Demandeur'), secteurIds: [prod.id] });
    assert.ok((await d.ok('GET', '/api/plans')).some((x) => x.id === p.id), 'le demandeur voit le plan de son site');
    // chef de secteur PROD avec droit plans.modifier : le plan du site est hors de son périmètre d'écriture
    const chef = await utilisateur('chef_plans', { profilId: profil('Chef de secteur'), secteurIds: [prod.id], overrides: { plans: { creer: true, modifier: true } } });
    assert.equal((await chef.ok('GET', '/api/plans/' + p.id)).droits.modifier, false);
    const r = await chef.put('/api/plans/' + p.id, { version: 1, nom: 'Interdit' });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /périmètre/);
    // il peut créer un plan pour son propre secteur, mais pas pour le site
    assert.equal((await chef.post('/api/plans', planSimple({ nom: 'Plan atelier PROD', secteurId: prod.id }))).status, 200);
    assert.equal((await chef.post('/api/plans', planSimple({ nom: 'Plan site', secteurId: site1.id }))).status, 403);
    assert.equal((await chef.post('/api/plans', planSimple({ nom: 'Sans secteur', secteurId: null }))).status, 400, 'secteur obligatoire hors portée « tous »');
  });

  test('équipements non visibles masqués (aucune fuite) et liens masqués conservés à l\'enregistrement', async () => {
    // plan d'un bâtiment rattaché à MAINT, avec un équipement SG (même site) lié par l'administrateur
    const bat = await admin.ok('POST', '/api/secteurs', { nom: 'Bâtiment maintenance', code: 'BAT-M', type: 'batiment', parentId: maint.id });
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan bâtiment', secteurId: bat.id, objets: [machine('vis', { equipementId: eqMaint.id }), machine('cache', { equipementId: eqSg.id, x: 30, nom: 'Machine locale' })] }));
    // responsable de maintenance limité au secteur MAINT (écriture sur le bâtiment), ne voit pas SG
    const rm = await utilisateur('rm_maint', { profilId: profil('Responsable maintenance'), porteeOverride: 'secteurs', secteurIds: [maint.id] });
    const vu = await rm.get('/api/plans/' + p.id);
    assert.equal(vu.status, 200);
    const cache = vu.body.objets.find((o) => o.id === 'cache');
    assert.equal(cache.equipementId, null);
    assert.equal(cache.equipementMasque, true);
    assert.equal(cache.equipement, undefined);
    assert.equal(vu.brut.includes('EQ-SECRET-SG'), false, 'numéro de l\'équipement masqué absent');
    assert.equal(vu.brut.includes('Compresseur confidentiel'), false);
    assert.equal(vu.body.objets.find((o) => o.id === 'vis').equipement.numero, 'EQ-T2');
    const etat = await rm.ok('GET', `/api/plans/${p.id}/etat`);
    assert.equal(etat.equipements[eqSg.id], undefined);
    assert.equal((await rm.get('/api/plans-localiser/' + eqSg.id)).status, 404);
    // enregistrement par cet utilisateur : le lien masqué est conservé
    const objets = vu.body.objets.map((o) => (o.id === 'vis' ? Object.assign({}, o, { x: 12 }) : o));
    const m = await rm.ok('PUT', '/api/plans/' + p.id, { version: 1, objets });
    assert.equal(m.objets.find((o) => o.id === 'vis').x, 12);
    assert.equal(srv.db.get('plans', p.id).objets.find((o) => o.id === 'cache').equipementId, eqSg.id, 'lien masqué conservé');
    // mais il ne peut pas lier lui-même un équipement qu'il ne voit pas
    const r = await rm.put('/api/plans/' + p.id, { version: 2, objets: objets.concat([machine('nouveau', { equipementId: eqProd.id, x: 40 })]) });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /hors de votre portée/);
  });

  // ----- Multi-site ---------------------------------------------------------------------------
  test('multi-site : isolation entre sites, accès en lecture seule, filtre par en-tête X-GMAO-Site', async () => {
    const p1 = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan Carpentras MS' }));
    const p2 = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan Valréas MS', secteurId: site2.id, objets: [machine('v1', { equipementId: eqSite2.id })] }));
    // utilisateur rattaché au site 1 uniquement
    const t = await utilisateur('tech_site1', { profilId: profil('Technicien'), porteeOverride: 'site', secteurIds: [prod.id] });
    const liste = await t.ok('GET', '/api/plans');
    assert.ok(liste.some((x) => x.id === p1.id));
    assert.ok(!liste.some((x) => x.id === p2.id), 'le plan du site 2 est invisible');
    assert.equal((await t.get('/api/plans/' + p2.id)).status, 404);
    assert.equal((await t.get(`/api/plans/${p2.id}/etat`)).status, 404);
    assert.equal((await t.get(`/api/plans/${p2.id}/export`)).status, 404);
    // responsable maintenance du site 1 avec accès en lecture seule au site 2
    const rm = await utilisateur('rm_lecture', { profilId: profil('Responsable maintenance'), porteeOverride: 'site', secteurIds: [prod.id], siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    const f2 = await rm.ok('GET', '/api/plans/' + p2.id);
    assert.equal(f2.droits.modifier, false);
    assert.equal(f2.droits.lectureSeule, true);
    assert.equal(f2.objets[0].equipement.numero, 'EQ-V1', 'les équipements du site en lecture sont visibles');
    const r = await rm.put('/api/plans/' + p2.id, { version: 1, nom: 'Interdit' });
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /lecture seule/);
    assert.equal((await rm.del('/api/plans/' + p2.id)).status, 403);
    assert.equal((await rm.post('/api/plans', planSimple({ nom: 'Nouveau à Valréas', secteurId: site2.id }))).status, 403);
    assert.equal((await rm.post(`/api/plans/${p2.id}/dupliquer`, {})).status, 403, 'duplication vers le même site (lecture seule) refusée');
    // il modifie son propre site
    assert.equal((await rm.put('/api/plans/' + p1.id, { version: 1, nom: 'Plan Carpentras MS (modifié)' })).status, 200);
    // il ne peut pas lier un équipement du site en lecture seule
    // filtre de site courant par en-tête
    const a2 = clientSite(site2.id);
    await a2.login('admin', 'admin');
    const l2 = await a2.ok('GET', '/api/plans');
    assert.ok(l2.length > 0 && l2.every((x) => x.siteId === site2.id), 'seuls les plans du site 2');
    assert.equal((await a2.get('/api/plans/' + p1.id)).status, 404);
    const a1 = clientSite(site1.id);
    await a1.login('admin', 'admin');
    assert.ok((await a1.ok('GET', '/api/plans')).every((x) => x.siteId === site1.id));
    assert.equal((await a1.post('/api/plans', planSimple({ nom: 'Hors site courant', secteurId: prod2.id }))).status, 403, 'création hors du site courant refusée');
  });

  // ----- Événements, notifications ------------------------------------------------------------
  test('suppression d\'un équipement : lien retiré des plans et version incrémentée', async () => {
    const eq = srv.db.insert('equipements', { numero: 'EQ-TMP', nom: 'Équipement temporaire', secteurId: prod.id, actif: true });
    const p = await admin.ok('POST', '/api/plans', planSimple({ nom: 'Plan lien temporaire', objets: [machine('m', { equipementId: eq.id })] }));
    await admin.ok('DELETE', '/api/equipements/' + eq.id);
    const apres = srv.db.get('plans', p.id);
    assert.equal(apres.objets[0].equipementId, null);
    assert.equal(apres.version, 2);
  });

  test('notification du créateur quand un autre utilisateur modifie son plan', async () => {
    const rm = await utilisateur('rm_notif', { profilId: profil('Responsable maintenance') });
    const p = await rm.ok('POST', '/api/plans', planSimple({ nom: 'Plan de RM' }));
    await admin.ok('PUT', '/api/plans/' + p.id, { version: 1, description: 'Retouche' });
    const uid = srv.db.findOne('users', (u) => u.login === 'rm_notif').id;
    const n = srv.db.findOne('notifications', (x) => x.userId === uid && /Plan 3D modifié/.test(x.titre));
    assert.ok(n);
    assert.equal(n.lien, '#/plans/' + p.id);
  });

  // ----- Démonstration ------------------------------------------------------------------------
  test('données de démonstration réalistes, valides et idempotentes', async () => {
    const equipements = require('../server/modules/equipements');
    const plans = require('../server/modules/plans');
    equipements.seedDemo(srv.ctx);
    const r1 = plans.seedDemo(srv.ctx);
    assert.match(r1, /objets/);
    const demo = srv.db.findOne('plans', (p) => p.nom === 'Atelier de production – Site principal');
    assert.ok(demo, 'plan du site principal créé');
    assert.ok(demo.objets.length > 80);
    assert.ok(demo.objets.filter((o) => o.equipementId != null).length >= 10, 'machines liées aux équipements de démonstration');
    for (const cat of ['armoire_electrique', 'compresseur', 'reseau_air', 'rack', 'quai', 'extincteur', 'issue_secours']) assert.ok(demo.objets.some((o) => o.categorie === cat), cat);
    for (const type of ['batiment', 'zone', 'mur', 'allee', 'machine', 'porte', 'texte']) assert.ok(demo.objets.some((o) => o.type === type), type);
    assert.ok(demo.objets.some((o) => o.type === 'zone' && o.secteurId === prod.id));
    // le site VAL existe : second plan
    assert.ok(srv.db.findOne('plans', (p) => p.secteurId === site2.id && /Valréas/.test(p.nom)));
    // les objets de démonstration passent la validation stricte
    const fiche = await admin.ok('GET', '/api/plans/' + demo.id);
    const m = await admin.ok('PUT', '/api/plans/' + demo.id, { version: fiche.version, objets: fiche.objets, niveaux: fiche.niveaux });
    assert.equal(m.objets.length, demo.objets.length);
    // idempotence
    const avant = srv.db.count('plans');
    plans.seedDemo(srv.ctx);
    assert.equal(srv.db.count('plans'), avant);
  });
});

// ----- Moteur 3D : mathématiques et géométrie (exécutables sous Node) --------------------------
describe('Moteur3D (mathématiques)', () => {
  const M = require('../client/js/lib/moteur3d.js');
  const { mat4, rayonSol, triangulerPolygone, aireSignee, construireGeometrie, pointDansPolygone, F_TRI } = M.utils;
  const proche = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

  test('inverse × matrice = identité ; lookAt place la cible au centre', () => {
    const v = mat4.lookAt([10, 20, 30], [1, 0, 2], [0, 1, 0]);
    const p = mat4.perspective(Math.PI / 4, 1.5, 0.1, 500);
    const vp = mat4.multiplier(p, v);
    const id = mat4.multiplier(vp, mat4.inverser(vp));
    for (let i = 0; i < 16; i++) assert.ok(proche(id[i], i % 5 === 0 ? 1 : 0, 1e-3), `élément ${i} = ${id[i]}`);
    const c = mat4.transformer(vp, 1, 0, 2, 1);
    assert.ok(proche(c[0] / c[3], 0) && proche(c[1] / c[3], 0), 'la cible se projette au centre');
  });

  test('rayon écran → sol : le centre de l\'écran vise la cible au sol', () => {
    const vp = mat4.multiplier(mat4.perspective(Math.PI / 4, 1, 0.1, 1000), mat4.lookAt([25, 40, 60], [25, 0, 20], [0, 1, 0]));
    const s = rayonSol(mat4.inverser(vp), 0, 0, 0);
    assert.ok(proche(s.x, 25, 1e-2) && proche(s.y, 20, 1e-2), JSON.stringify(s));
    const ortho = mat4.multiplier(mat4.orthographique(-10, 10, -10, 10, 0.1, 200), mat4.lookAt([5, 50, 5], [5, 0, 5], [0, 0, -1]));
    const so = rayonSol(mat4.inverser(ortho), 1, 1, 0); // coin haut-droit : x + 10, nord (y − 10)
    assert.ok(proche(so.x, 15, 1e-2) && proche(so.y, -5, 1e-2), JSON.stringify(so));
  });

  test('déplacement / rotation dans le sens du plan', () => {
    const m = mat4.deplacementPlan(2, 3, 90, 0, 0);
    const p = mat4.transformer(m, 1, 0, 0, 1); // (x=1, y=0) tourné de 90° (horaire vue de dessus) → (0, 1) puis + (2, 3)
    assert.ok(proche(p[0], 2) && proche(p[2], 4), JSON.stringify(p));
  });

  test('triangulation d\'un polygone concave (aire conservée)', () => {
    const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    const tris = triangulerPolygone(L);
    assert.equal(tris.length, L.length - 2);
    const aire = tris.reduce((s, [a, b, c]) => s + Math.abs(aireSignee([L[a], L[b], L[c]])), 0);
    assert.ok(proche(aire, Math.abs(aireSignee(L))), `aire ${aire}`);
    assert.ok(pointDansPolygone(2, 8, L) && !pointDansPolygone(8, 8, L));
  });

  test('géométrie : boîte, cylindre, prisme, segment', () => {
    const boite = construireGeometrie({ id: 'a', forme: 'boite', x: 5, y: 5, largeur: 2, profondeur: 1, hauteur: 3, rotation: 30, couleur: '#ff0000', aretes: true }, 7);
    assert.equal(boite.tri.length / F_TRI, 36);
    assert.equal(boite.tri[10], 7, 'identifiant de sélection dans chaque sommet');
    assert.ok(boite.lig.length > 0);
    assert.equal(boite.empreinte.length, 4);
    const cyl = construireGeometrie({ id: 'c', forme: 'cylindre', x: 0, y: 0, largeur: 2, profondeur: 2, hauteur: 1 }, 1);
    assert.ok(cyl.tri.length / F_TRI >= 12 * 12);
    const pr = construireGeometrie({ id: 'p', forme: 'prisme', points: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]], hauteur: 3, opacite: 0.4 }, 2);
    assert.equal(pr.transparent, true);
    assert.equal(pr.tri.length / F_TRI, 4 * 3 + 6 * 6, 'toit triangulé + 6 côtés');
    const seg = construireGeometrie({ id: 's', forme: 'segment', x: 0, y: 0, x2: 3, y2: 4, epaisseur: 0.2, hauteur: 2 }, 3);
    assert.ok(proche(seg.boite.maxX - seg.boite.minX, 3 + 0.2 * 0.8, 0.2));
    assert.ok(proche(seg.centre[0], 1.5) && proche(seg.centre[2], 2));
    const nonPick = construireGeometrie({ id: 'n', forme: 'boite', pickable: false }, 9);
    assert.equal(nonPick.tri[10], 0, 'objet non sélectionnable : identifiant 0');
  });
});
