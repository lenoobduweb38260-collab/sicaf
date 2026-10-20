'use strict';
/**
 * Tests du module Audits & visites : création et validation, droits (403), portée par secteur,
 * par site et lecture seule, personnes concernées, statuts (annulation, clôture, réouverture),
 * préparation, visiteurs et registre d'accueil (charte, badge, scan, présents), constats et plan
 * d'actions (vérification de l'efficacité, demande d'intervention liée), documents, exports CSV,
 * anonymisation des données personnelles, rappels et retards, suppression, données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

const heure = (h) => new Date(Date.now() + h * 3600000).toISOString();
const jourLocal = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const dansJours = (n) => jourLocal(Date.now() + n * 86400000);
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n').toString('base64');

describe('Module Audits & visites', () => {
  let srv, admin, secteurs, profils, site, prod, log, qual, maint;
  let qualite, respMaint, chef, chefLecteur, demandeur;
  let idQualite, idRespMaint, idChef, idChefLecteur;

  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  const notifs = (userId) => srv.db.list('notifications', (n) => n.userId === userId);
  async function creerUtilisateur(login, nomProfil, secteurIds, extra = {}) {
    const u = await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, prenom: 'Test', profilId: profil(nomProfil), secteurIds, password: 'motdepasse1', doitChangerMdp: false }, extra));
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return { c, id: u.id };
  }
  const base = (extra = {}) => Object.assign({ titre: 'Audit client Distrifrais', typeCode: 'audit_client', secteurId: site.id, organisme: 'Distrifrais SAS', dateDebut: heure(48), dateFin: heure(56) }, extra);

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    secteurs = await admin.ok('GET', '/api/secteurs');
    site = secteurs.find((s) => s.code === 'SITE');
    prod = secteurs.find((s) => s.code === 'PROD');
    log = secteurs.find((s) => s.code === 'LOG');
    qual = secteurs.find((s) => s.code === 'QUAL');
    maint = secteurs.find((s) => s.code === 'MAINT');
    profils = await admin.ok('GET', '/api/profils');
    ({ c: qualite, id: idQualite } = await creerUtilisateur('qualite', 'Responsable qualité', [site.id]));
    ({ c: respMaint, id: idRespMaint } = await creerUtilisateur('respmaint', 'Responsable maintenance', []));
    ({ c: chef, id: idChef } = await creerUtilisateur('chefprod', 'Chef de secteur', [prod.id]));
    ({ c: chefLecteur, id: idChefLecteur } = await creerUtilisateur('cheflecteur', 'Chef de secteur', [prod.id], { overrides: { visites: { modifier: false } } }));
    ({ c: demandeur } = await creerUtilisateur('demandeur', 'Demandeur', [prod.id]));
  });
  after(async () => { await srv.stop(); });

  test('création : validation stricte, numérotation, hôte par défaut, historique, audit et notifications', async () => {
    const refus = [
      [{ titre: '' }, 'titre obligatoire'],
      [{ titre: { $ne: 1 } }, 'titre non textuel'],
      [{ titre: 'x'.repeat(201) }, 'titre trop long'],
      [{ typeCode: 'inconnu' }, 'type invalide'],
      [{ dateDebut: '' }, 'date de début obligatoire'],
      [{ dateDebut: '14/10/2026' }, 'format de date invalide'],
      [{ dateFin: heure(40) }, 'fin avant le début'],
      [{ dateFin: heure(48 + 24 * 40) }, 'durée supérieure à 31 jours'],
      [{ secteurId: 999999 }, 'secteur inexistant'],
      [{ hoteUserId: 999999 }, 'hôte inexistant'],
      [{ contactOrganisme: { email: 'pas-une-adresse' } }, 'e-mail du contact invalide'],
      [{ contactOrganisme: { telephone: '<script>' } }, 'téléphone invalide'],
      [{ zonesVisitees: 'PROD' }, 'zones : liste attendue'],
      [{ resultat: 'favorable' }, 'résultat : objet attendu'],
      [{ statut: 'terminee' }, 'création au statut final interdite'],
      [{ planId: 4242 }, 'plan 3D inexistant'],
    ];
    for (const [corps, motif] of refus) assert.equal((await admin.post('/api/visites', base(corps))).status, 400, motif);

    const v = await qualite.ok('POST', '/api/visites', base({
      referentiel: 'Cahier des charges v4', contactOrganisme: { nom: 'Claire Morel', email: 'c.morel@client.example', telephone: '01 02 03 04 05' },
      participantsUserIds: [idRespMaint, idChef, idQualite], zonesVisitees: [prod.id, log.id, prod.id], programme: '08:30 Accueil\n09:00 Visite des ateliers',
      preparation: [{ libelle: 'Nettoyage 5S de la ligne', responsableUserId: idChef, echeance: dansJours(1) }],
    }));
    assert.match(v.numero, /^VIS-\d{4}-\d{3}$/);
    assert.equal(v.statut, 'planifiee', 'statut initial = premier statut non final');
    assert.equal(v.hoteUserId, idQualite, 'hôte = créateur par défaut');
    assert.deepEqual(v.participantsUserIds, [idRespMaint, idChef], 'l\'hôte est retiré des participants, doublons supprimés');
    assert.deepEqual(v.zonesVisitees, [prod.id, log.id]);
    assert.equal(v.programme, '08:30 Accueil\n09:00 Visite des ateliers', 'les retours à la ligne du programme sont conservés');
    assert.equal(v.siteId, site.id);
    assert.equal(v.preparation.length, 1);
    assert.equal(v.historique.length, 1);
    assert.equal(v.droits.modifier, true);
    assert.ok(srv.db.list('audit', (a) => a.entite === 'visites' && a.action === 'creation' && a.entiteId === v.id).length === 1, 'création journalisée');
    assert.ok(notifs(idRespMaint).some((n) => n.lien === `#/visites/${v.id}` && /participant/.test(n.titre)), 'participant notifié');
    assert.ok(notifs(idChef).some((n) => /préparation/.test(n.titre)), 'responsable de préparation notifié');
    assert.ok(!notifs(idQualite).some((n) => n.lien === `#/visites/${v.id}`), 'l\'auteur n\'est pas notifié de sa propre action');

    const v2 = await qualite.ok('POST', '/api/visites', base({ titre: 'Deuxième visite' }));
    assert.notEqual(v2.numero, v.numero);
    const liste = await qualite.ok('GET', '/api/visites');
    assert.ok(liste.some((x) => x.id === v.id) && !('visiteurs' in liste[0]) && !('documents' in liste[0]), 'la liste est un résumé sans données détaillées');
    const filtre = await qualite.ok('GET', `/api/visites?typeCode=audit_client&du=${dansJours(1)}&au=${dansJours(3)}&recherche=distrifrais`);
    assert.ok(filtre.length >= 2);
    assert.equal((await qualite.ok('GET', `/api/visites?du=${dansJours(10)}`)).filter((x) => x.id === v.id).length, 0, 'filtre de période');
  });

  test('droits : chaque route contrôle l\'action requise', async () => {
    const v = await admin.ok('POST', '/api/visites', base({ titre: 'Contrôle des droits', secteurId: prod.id }));
    assert.equal((await demandeur.get('/api/visites')).status, 403, 'module non accordé');
    assert.equal((await demandeur.get('/api/visites-registre')).status, 403);
    assert.equal((await chef.post('/api/visites', base({ secteurId: prod.id }))).status, 403, 'chef de secteur : pas de création');
    assert.equal((await chef.del('/api/visites/' + v.id)).status, 403, 'chef de secteur : pas de suppression');
    assert.equal((await respMaint.post('/api/visites/purger', {})).status, 403, 'purge réservée au droit valider');
    assert.equal((await chef.get('/api/visites-export/visites')).status, 403, 'export réservé au droit exporter');
    assert.equal((await chefLecteur.put('/api/visites/' + v.id, { titre: 'Modifiée' })).status, 403, 'consultation seule');
    assert.equal((await chef.put('/api/visites/' + v.id, { titre: 'Modifiée par le chef' })).status, 200, 'chef de secteur : modification dans son secteur');
    const h = await admin.ok('GET', '/api/visites/' + v.id);
    assert.equal(h.titre, 'Modifiée par le chef');
    assert.equal(h.historique[0].action, 'modification');
  });

  test('portée : secteurs, personnes concernées, site obligatoire hors portée « tous »', async () => {
    const surLog = await admin.ok('POST', '/api/visites', base({ titre: 'Visite logistique', secteurId: log.id }));
    assert.equal((await chef.get('/api/visites/' + surLog.id)).status, 404, 'hors secteur : introuvable');
    assert.ok(!(await chef.ok('GET', '/api/visites')).some((x) => x.id === surLog.id));
    assert.equal((await qualite.post('/api/visites', base({ secteurId: null }))).status, 400, 'site obligatoire hors portée « tous »');

    // Désigné hôte : la visite devient visible, l'accueil est possible, la modification complète non
    await admin.ok('PUT', '/api/visites/' + surLog.id, { hoteUserId: idChef, dateDebut: heure(-1), dateFin: heure(4) });
    const vue = await chef.ok('GET', '/api/visites/' + surLog.id);
    assert.equal(vue.droits.modifier, false);
    assert.equal(vue.droits.accueil, true);
    assert.ok(notifs(idChef).some((n) => /hôte/.test(n.titre) && n.lien === `#/visites/${surLog.id}`), 'nouvel hôte notifié');
    assert.equal((await chef.put('/api/visites/' + surLog.id, { titre: 'Hors portée' })).status, 403);
    const avecVisiteur = await admin.ok('POST', `/api/visites/${surLog.id}/visiteurs`, { nom: 'Durand', prenom: 'Paul', societe: 'Transports Durand' });
    const vid = avecVisiteur.visiteurs[0].id;
    const arrive = await chef.ok('POST', `/api/visites/${surLog.id}/visiteurs/${vid}/arrivee`, { charteAcceptee: true });
    assert.ok(arrive.visiteurs[0].arrivee, 'l\'hôte enregistre l\'arrivée de son visiteur');
    assert.equal((await chef.post(`/api/visites/${surLog.id}/constats`, { typeCode: 'observation', description: 'Hors portée' })).status, 403, 'pas de constat hors portée');
    await chef.ok('POST', `/api/visites/${surLog.id}/visiteurs/${vid}/depart`, {});
  });

  test('multi-site : site affiché, site en lecture seule', async () => {
    const valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    const valProd = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: valreas.id });
    const v = await admin.ok('POST', '/api/visites', base({ titre: 'Audit à Valréas', secteurId: valreas.id, zonesVisitees: [valProd.id] }));
    assert.equal((await admin.post('/api/visites', base({ secteurId: valreas.id, zonesVisitees: [prod.id] }))).status, 400, 'zone d\'un autre site refusée');
    assert.equal((await qualite.get('/api/visites/' + v.id)).status, 404, 'site non rattaché : invisible');
    assert.equal((await qualite.post('/api/visites', base({ secteurId: valreas.id }))).status, 403, 'création sur un autre site refusée');
    const { c: lecteur } = await creerUtilisateur('qualiteval', 'Responsable qualité', [site.id], { siteAcces: [{ siteId: valreas.id, mode: 'lecture' }] });
    assert.equal((await lecteur.get('/api/visites/' + v.id)).status, 200, 'lecture seule : consultation possible');
    const ro = await lecteur.put('/api/visites/' + v.id, { titre: 'Interdit' });
    assert.equal(ro.status, 403);
    assert.match(ro.body.erreur, /lecture seule/);
    // Filtre du site courant (en-tête X-GMAO-Site)
    const r = await fetch(srv.base + '/api/visites', { headers: { cookie: await (async () => { const res = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'GMAO' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) }); return res.headers.get('set-cookie').split(';')[0]; })(), 'x-gmao-site': String(valreas.id) } });
    const rows = await r.json();
    assert.ok(rows.length && rows.every((x) => x.siteId === valreas.id), 'seules les visites du site affiché');
  });

  test('statuts : annulation motivée, clôture avec présents, réouverture réservée au droit valider', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite du jour', dateDebut: heure(-1), dateFin: heure(5), participantsUserIds: [idRespMaint] }));
    assert.equal((await qualite.post(`/api/visites/${v.id}/statut`, { statut: 'inconnu' })).status, 400);
    assert.equal((await qualite.post(`/api/visites/${v.id}/statut`, { statut: 'planifiee' })).status, 400, 'statut identique');
    const conf = await qualite.ok('POST', `/api/visites/${v.id}/statut`, { statut: 'confirmee' });
    assert.equal(conf.statut, 'confirmee');
    const x = await qualite.ok('POST', `/api/visites/${v.id}/visiteurs`, { nom: 'Vidal', prenom: 'Bertrand' });
    await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${x.visiteurs[0].id}/arrivee`, { charteAcceptee: true });
    const cloture = await qualite.post(`/api/visites/${v.id}/statut`, { statut: 'terminee' });
    assert.equal(cloture.status, 409, 'visiteur encore présent');
    assert.deepEqual(cloture.body.details.presents, ['Bertrand Vidal']);
    const term = await qualite.ok('POST', `/api/visites/${v.id}/statut`, { statut: 'terminee', enregistrerDeparts: true });
    assert.equal(term.statut, 'terminee');
    assert.ok(term.visiteurs[0].depart, 'départ enregistré à la clôture');
    assert.ok(term.dateCloture);
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs/${x.visiteurs[0].id}/arrivee`, {})).status, 400, 'pas d\'arrivée sur une visite clôturée');
    assert.equal((await respMaint.post(`/api/visites/${v.id}/statut`, { statut: 'en_cours' })).status, 403, 'réouverture : droit valider');
    assert.equal((await qualite.ok('POST', `/api/visites/${v.id}/statut`, { statut: 'en_cours' })).statut, 'en_cours');

    const a = await qualite.ok('POST', '/api/visites', base({ titre: 'À annuler', participantsUserIds: [idRespMaint] }));
    assert.equal((await qualite.post(`/api/visites/${a.id}/statut`, { statut: 'annulee' })).status, 400, 'motif obligatoire');
    const ann = await qualite.ok('POST', `/api/visites/${a.id}/statut`, { statut: 'annulee', motif: 'Report demandé par le client' });
    assert.equal(ann.motifAnnulation, 'Report demandé par le client');
    assert.ok(notifs(idRespMaint).some((n) => n.lien === `#/visites/${a.id}` && n.type === 'alerte'), 'participants prévenus de l\'annulation');
    assert.equal((await qualite.put('/api/visites/' + a.id, { titre: 'Interdit' })).status, 400, 'visite annulée non modifiable');
    assert.equal((await qualite.post(`/api/visites/${a.id}/visiteurs`, { nom: 'X' })).status, 400);
  });

  test('changement de date : hôte et participants prévenus, rappel réarmé', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite déplacée', participantsUserIds: [idRespMaint] }));
    const avant = notifs(idRespMaint).length;
    const debut = heure(72);
    const maj = await qualite.ok('PUT', '/api/visites/' + v.id, { dateDebut: debut, dateFin: heure(76) });
    assert.equal(maj.dateDebut, debut, 'date enregistrée');
    assert.equal(srv.db.get('visites', v.id).rappelEnvoye, null, 'rappel réarmé');
    assert.ok(notifs(idRespMaint).length > avant && /changement de date/.test(notifs(idRespMaint).slice(-1)[0].titre));
  });

  test('préparation : ajout groupé, cochage par le responsable (consultation seule), restrictions', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Préparation', secteurId: prod.id }));
    assert.equal((await qualite.post(`/api/visites/${v.id}/preparation`, { libelle: '' })).status, 400);
    assert.equal((await qualite.post(`/api/visites/${v.id}/preparation`, { libelle: 'Salle', echeance: '2026-02-30' })).status, 400, 'date inexistante');
    const r = await qualite.ok('POST', `/api/visites/${v.id}/preparation`, { elements: [
      { libelle: 'Préparer les EPI visiteurs', responsableUserId: idChefLecteur, echeance: dansJours(1) },
      { libelle: 'Réserver la salle de réunion', responsableUserId: idQualite },
    ] });
    assert.equal(r.preparation.length, 2);
    const [epi, salle] = r.preparation;
    assert.ok(notifs(idChefLecteur).some((n) => /préparation/.test(n.titre)));
    // Responsable sans droit « modifier » : peut seulement cocher son point
    const coche = await chefLecteur.ok('PUT', `/api/visites/${v.id}/preparation/${epi.id}`, { fait: true });
    const p = coche.preparation.find((x) => x.id === epi.id);
    assert.equal(p.fait, true);
    assert.equal(p.faitPar, idChefLecteur);
    assert.equal((await chefLecteur.put(`/api/visites/${v.id}/preparation/${epi.id}`, { libelle: 'Autre' })).status, 403);
    assert.equal((await chefLecteur.put(`/api/visites/${v.id}/preparation/${salle.id}`, { fait: true })).status, 403, 'point d\'une autre personne');
    assert.equal((await chefLecteur.del(`/api/visites/${v.id}/preparation/${epi.id}`)).status, 403);
    const sup = await qualite.ok('DELETE', `/api/visites/${v.id}/preparation/${salle.id}`);
    assert.equal(sup.preparation.length, 1);
    assert.equal(sup.preparationFaits, 1);
    assert.equal((await qualite.put(`/api/visites/${v.id}/preparation/9999`, { fait: true })).status, 404);
  });

  test('registre d\'accueil : charte, accompagnement, badge unique, présents, scan de sortie', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite client du jour', dateDebut: heure(-2), dateFin: heure(3), hoteUserId: idRespMaint }));
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs`, { prenom: 'Sans nom' })).status, 400, 'nom obligatoire');
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs`, { nom: 'X', email: 'invalide' })).status, 400);
    const r1 = await qualite.ok('POST', `/api/visites/${v.id}/visiteurs`, { nom: 'Faure', prenom: 'Julien', societe: 'Maison Vernet', telephone: '06 01 02 03 04', email: 'j.faure@client.example', vehicule: 'GH-418-KT', pieceIdentite: 'CNI 123456789' });
    const r2 = await qualite.ok('POST', `/api/visites/${v.id}/visiteurs`, { nom: 'Roche', prenom: 'Amandine', societe: 'Maison Vernet', epiFournis: ['Blouse', 'Charlotte', 'Blouse'] });
    const [faure, roche] = r2.visiteurs;
    assert.match(faure.badgeNumero, /^VB\d{8}$/);
    assert.notEqual(faure.badgeNumero, roche.badgeNumero);
    assert.deepEqual(roche.epiFournis, ['Blouse', 'Charlotte']);
    assert.equal(faure.pieceIdentiteRenseignee, false, 'pièce d\'identité non conservée quand la configuration ne la demande pas');
    assert.equal(r1.visiteurs[0].telephone, '06 01 02 03 04', 'coordonnées visibles par un gestionnaire');

    // Coordonnées masquées pour une simple consultation
    const lecture = await respMaint.ok('GET', '/api/visites/' + v.id);
    assert.equal(lecture.visiteurs[0].telephone, '06 01 02 03 04', 'responsable maintenance : droit modifier');
    const chefVoit = await chefLecteur.get('/api/visites/' + v.id);
    assert.equal(chefVoit.status, 404, 'chef de secteur PROD : visite du site hors portée');

    const sansCharte = await qualite.post(`/api/visites/${v.id}/visiteurs/${faure.id}/arrivee`, {});
    assert.equal(sansCharte.status, 400);
    assert.match(sansCharte.body.erreur, /charte/);
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs/${faure.id}/arrivee`, { charteAcceptee: true, horodatage: heure(2) })).status, 400, 'heure future refusée');
    const arr = await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${faure.id}/arrivee`, { charteAcceptee: true, epiFournis: ['Casque'] });
    const f = arr.visiteurs.find((x) => x.id === faure.id);
    assert.ok(f.arrivee && f.charteAcceptee && f.charteAccepteeLe);
    assert.equal(f.accompagnateurUserId, idRespMaint, 'accompagnement obligatoire : l\'hôte par défaut');
    assert.equal(arr.statut, 'en_cours', 'première arrivée : visite en cours');
    assert.ok(notifs(idRespMaint).some((n) => /Visiteur arrivé/.test(n.titre)), 'hôte prévenu de l\'arrivée');
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs/${faure.id}/arrivee`, { charteAcceptee: true })).status, 409, 'déjà présent');
    assert.ok(srv.db.list('audit', (a) => a.action === 'arrivee' && a.entiteId === v.id).length === 1, 'arrivée journalisée');
    assert.ok(!srv.db.list('audit', (a) => a.entiteId === v.id).some((a) => /06 01|j\.faure/.test(a.details)), 'aucune coordonnée personnelle dans le journal');

    const reg = await chef.ok('GET', '/api/visites-registre?date=' + jourLocal(Date.now()));
    assert.equal((await qualite.get('/api/visites-registre?date=2026-13-01')).status, 400);
    const regQ = await qualite.ok('GET', '/api/visites-registre');
    assert.ok(regQ.presents.some((l) => l.visiteurId === faure.id && l.visiteId === v.id), 'présent sur le site');
    assert.ok(regQ.attendus.some((l) => l.visiteurId === roche.id && l.etat === 'attendu'));
    assert.ok(!('telephone' in regQ.presents[0]) && !('email' in regQ.presents[0]), 'registre sans coordonnées');
    assert.ok(!reg.presents.some((l) => l.visiteId === v.id), 'registre filtré selon la portée');

    // Scan du badge à la sortie
    assert.equal((await qualite.post('/api/visites-registre/scan', { code: 'VB00000000' })).status, 404);
    assert.equal((await qualite.post('/api/visites-registre/scan', { code: roche.badgeNumero })).status, 400, 'visiteur non arrivé');
    assert.equal((await chef.post('/api/visites-registre/scan', { code: faure.badgeNumero })).status, 404, 'badge d\'une visite hors portée : inconnu');
    const scan = await qualite.ok('POST', '/api/visites-registre/scan', { code: faure.badgeNumero.toLowerCase() });
    assert.equal(scan.action, 'depart');
    assert.ok(scan.visiteur.depart);
    assert.equal((await qualite.post('/api/visites-registre/scan', { code: faure.badgeNumero })).status, 409, 'départ déjà enregistré');
    assert.equal((await qualite.del(`/api/visites/${v.id}/visiteurs/${roche.id}`)).status, 200, 'visiteur jamais arrivé : retrait possible');
    assert.equal((await respMaint.del(`/api/visites/${v.id}/visiteurs/${faure.id}`)).status, 403, 'passage inscrit au registre : droit supprimer');
    assert.equal((await qualite.del('/api/visites/' + v.id)).status, 400, 'visite ayant accueilli des visiteurs : suppression refusée');

    // Arrivée hors des dates de la visite
    const future = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite future', visiteurs: [{ nom: 'Futur' }] }));
    assert.equal((await qualite.post(`/api/visites/${future.id}/visiteurs/${future.visiteurs[0].id}/arrivee`, { charteAcceptee: true })).status, 400);
  });

  test('pièce d\'identité exigée par la configuration et accessible sur la fiche du visiteur', async () => {
    const cfg = srv.db.getConfig();
    cfg.visites.demanderPieceIdentite = true;
    srv.db.setConfig(cfg);
    try {
      const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite avec identité', dateDebut: heure(-1), dateFin: heure(2), visiteurs: [{ nom: 'Martin', prenom: 'Léa' }] }));
      const x = v.visiteurs[0];
      const refus = await qualite.post(`/api/visites/${v.id}/visiteurs/${x.id}/arrivee`, { charteAcceptee: true });
      assert.equal(refus.status, 400);
      assert.match(refus.body.erreur, /pièce d'identité/);
      const ok = await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${x.id}/arrivee`, { charteAcceptee: true, pieceIdentite: 'Passeport 22AB12345' });
      assert.equal(ok.visiteurs[0].pieceIdentite, '•••• 2345', 'pièce d\'identité masquée sur la fiche de visite');
      const fiche = await qualite.ok('GET', `/api/visites/${v.id}/visiteurs/${x.id}`);
      assert.equal(fiche.pieceIdentite, 'Passeport 22AB12345');
      assert.equal((await chef.get(`/api/visites/${v.id}/visiteurs/${x.id}`)).status, 404, 'hors portée');
      await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${x.id}/depart`, {});
    } finally {
      cfg.visites.demanderPieceIdentite = false;
      srv.db.setConfig(cfg);
    }
  });

  test('constats et plan d\'actions : affectation, avancement par le responsable, vérification de l\'efficacité', async () => {
    const eq = srv.db.insert('equipements', { numero: 'EQ-T1', nom: 'Balance de précision', secteurId: qual.id, actif: true });
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit ISO 9001', typeCode: 'audit_certification', referentiel: 'ISO 9001:2015', dateDebut: heure(-30), dateFin: heure(-25) }));
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats`, { typeCode: 'inconnu', description: 'x' })).status, 400);
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats`, { typeCode: 'nc_mineure' })).status, 400, 'description obligatoire');
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats`, { typeCode: 'nc_mineure', description: 'x', equipementId: 99999 })).status, 400);
    const c1 = await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'nc_mineure', exigence: '§7.1.5.2', description: 'Vérification métrologique non réalisée', equipementId: eq.id, preuve: 'Fiche de vie' });
    const constat = c1.constats[0];
    assert.equal(constat.secteurId, qual.id, 'secteur repris de l\'équipement');
    assert.equal(constat.equipement.nom, 'Balance de précision');
    assert.equal(c1.ncOuvertes, 1);
    await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'point_fort', description: 'Gestion des compétences' });

    assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${constat.id}/actions`, { libelle: 'Sans responsable' })).status, 400);
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${constat.id}/actions`, { libelle: 'Statut vérifié direct', responsableUserId: idChefLecteur, statut: 'verifiee' })).status, 400);
    const a1 = await qualite.ok('POST', `/api/visites/${v.id}/constats/${constat.id}/actions`, { libelle: 'Faire vérifier la balance', responsableUserId: idChefLecteur, echeance: dansJours(-2) });
    const action = a1.constats[0].actions[0];
    assert.equal(action.statut, 'a_faire');
    assert.equal(action.enRetard, true);
    assert.ok(notifs(idChefLecteur).some((n) => /Action à mener/.test(n.titre)), 'responsable notifié à l\'affectation');
    assert.equal(a1.actionsEnRetard, 1);

    // Le responsable (consultation seule) voit la visite et fait avancer son action
    const vue = await chefLecteur.ok('GET', '/api/visites/' + v.id);
    assert.equal(vue.droits.modifier, false);
    const mesActions = await chefLecteur.ok('GET', '/api/visites-actions?responsableUserId=moi');
    assert.equal(mesActions.length, 1);
    assert.equal(mesActions[0].visiteNumero, v.numero);
    assert.equal((await chefLecteur.put(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`, { echeance: dansJours(30) })).status, 403, 'échéance : gestionnaire uniquement');
    assert.equal((await chefLecteur.put(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`, { statut: 'abandonnee' })).status, 403);
    assert.equal((await chefLecteur.put(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`, { statut: 'verifiee' })).status, 400);
    const real = await chefLecteur.ok('PUT', `/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`, { statut: 'realisee', commentaire: 'Constat MV-2026-014 conforme' });
    const ar = real.constats[0].actions[0];
    assert.equal(ar.statut, 'realisee');
    assert.equal(ar.dateRealisation, jourLocal(Date.now()));
    assert.equal(ar.enRetard, false, 'une action réalisée n\'est plus en retard');
    assert.ok(notifs(idQualite).some((n) => /à vérifier/.test(n.titre)), 'valideurs prévenus');

    // Vérification de l'efficacité : droit valider
    assert.equal((await respMaint.post(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}/valider`, { efficace: true })).status, 403);
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}/valider`, { efficace: false })).status, 400, 'motif obligatoire si non efficace');
    const ko = await qualite.ok('POST', `/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}/valider`, { efficace: false, commentaire: 'Constat non classé dans la fiche de vie' });
    assert.equal(ko.constats[0].actions[0].statut, 'en_cours');
    await chefLecteur.ok('PUT', `/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`, { statut: 'realisee' });
    const okv = await qualite.ok('POST', `/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}/valider`, { efficace: true, commentaire: 'Fiche de vie à jour' });
    const av = okv.constats[0].actions[0];
    assert.equal(av.statut, 'verifiee');
    assert.equal(av.verifiePar, idQualite);
    assert.ok(av.dateVerification);
    assert.equal(okv.ncOuvertes, 0, 'NC soldée');
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}/valider`, { efficace: true })).status, 400, 'déjà vérifiée');
    assert.ok(srv.db.list('audit', (a) => a.action === 'validation' && a.entiteId === v.id).length === 1);

    const toutes = await qualite.ok('GET', '/api/visites-actions?toutes=1&visiteId=' + v.id);
    assert.equal(toutes.length, 1);
    assert.equal((await qualite.ok('GET', '/api/visites-actions?visiteId=' + v.id)).length, 0, 'par défaut : actions ouvertes seulement');
    const tab = await qualite.ok('GET', '/api/visites-tableau');
    assert.ok(tab.kpi && typeof tab.kpi.presents === 'number' && Array.isArray(tab.constatsOuvertsParType));
    assert.equal((await respMaint.del(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`)).status, 403, 'action vérifiée : suppression réservée au droit supprimer');
    assert.equal((await qualite.del(`/api/visites/${v.id}/constats/${constat.id}/actions/${action.id}`)).status, 200);
  });

  test('demande d\'intervention créée depuis une action, lien retour, clôture de la demande', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit sécurité', dateDebut: heure(-10), dateFin: heure(-8) }));
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Zone de quarantaine non matérialisée', secteurId: log.id })).constats[0];
    const a = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Matérialiser la zone de quarantaine', responsableUserId: idRespMaint, echeance: dansJours(10) })).constats[0].actions[0];
    const url = `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}/creer-demande`;
    assert.equal((await chefLecteur.post(url, {})).status, 403, 'droit visites › modifier requis');
    const r = await qualite.ok('POST', url, { prioriteCode: 'haute' });
    assert.ok(r.demande.id && /^DI-/.test(r.demande.numero));
    const di = srv.db.get('demandes', r.demande.id);
    assert.equal(di.secteurId, log.id, 'secteur repris du constat');
    assert.equal(di.prioriteCode, 'haute');
    assert.equal(di.demandeurId, idQualite);
    assert.match(di.description, new RegExp(v.numero), 'description avec lien vers la visite');
    const act = r.visite.constats[0].actions[0];
    assert.equal(act.demandeId, di.id);
    assert.equal(act.statut, 'en_cours', 'action engagée');
    assert.equal(act.demande.numero, di.numero);
    assert.equal((await qualite.post(url, {})).status, 409, 'une seule demande par action');
    assert.equal((await qualite.del(`/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`)).status, 400, 'action liée : suppression refusée');
    assert.equal((await qualite.del('/api/visites/' + v.id)).status, 400, 'visite avec demande liée : suppression refusée');

    // Clôture de la demande : l'action passe « réalisée » (efficacité à vérifier)
    srv.ctx.emit('demande:cloturee', srv.db.get('demandes', di.id));
    const apres = await qualite.ok('GET', '/api/visites/' + v.id);
    assert.equal(apres.constats[0].actions[0].statut, 'realisee');

    // Module Demandes indisponible : 503
    const service = srv.ctx.services.demandes;
    const a2 = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Autre action', responsableUserId: idQualite })).constats[0].actions[1];
    delete srv.ctx.services.demandes;
    try {
      assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${c.id}/actions/${a2.id}/creer-demande`, {})).status, 503);
    } finally { srv.ctx.services.demandes = service; }
  });

  test('documents : types autorisés, signature, taille maximale, téléchargement', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Documents' }));
    assert.equal((await qualite.post(`/api/visites/${v.id}/documents`, { nom: 'page.html', type: 'text/html', contenu: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400, 'HTML refusé');
    assert.equal((await qualite.post(`/api/visites/${v.id}/documents`, { nom: 'image.svg', contenu: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') })).status, 400, 'SVG refusé');
    assert.equal((await qualite.post(`/api/visites/${v.id}/documents`, { nom: 'faux.pdf', type: 'application/pdf', contenu: 'data:application/pdf;base64,' + Buffer.from('MZ exécutable').toString('base64') })).status, 400, 'contenu non conforme au type');
    assert.equal((await qualite.post(`/api/visites/${v.id}/documents`, { nom: 'rapport.pdf', contenu: pdf, categorie: 'inconnue' })).status, 400);
    const gros = 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 + 10)]).toString('base64');
    assert.equal((await qualite.post(`/api/visites/${v.id}/documents`, { nom: 'gros.pdf', contenu: gros })).status, 400, 'plus de 10 Mo');
    const r = await qualite.ok('POST', `/api/visites/${v.id}/documents`, { nom: 'Rapport d\'audit.pdf', contenu: pdf, categorie: 'rapport', description: 'Rapport final' });
    const doc = r.documents[0];
    assert.equal(doc.categorie, 'rapport');
    assert.ok(!('contenu' in doc), 'le contenu n\'est pas renvoyé dans la fiche');
    const res = await fetch(`${srv.base}/api/visites/${v.id}/documents/${doc.id}`, { headers: { cookie: await (async () => { const x = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'GMAO' }, body: JSON.stringify({ login: 'qualite', password: 'motdepasse1' }) }); return x.headers.get('set-cookie').split(';')[0]; })() } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.equal((await res.text()).slice(0, 5), '%PDF-');
    assert.equal((await chef.get(`/api/visites/${v.id}/documents/${doc.id}`)).status, 404, 'hors portée');
    const sup = await qualite.ok('DELETE', `/api/visites/${v.id}/documents/${doc.id}`);
    assert.equal(sup.documents.length, 0);
  });

  test('exports CSV : visites, registre (sans coordonnées), plan d\'actions ; formules neutralisées', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: '=HYPERLINK("http://exemple.invalid")', visiteurs: [{ nom: 'Export', prenom: 'Test', telephone: '06 99 99 99 99', email: 'test@client.example' }] }));
    const csv = await qualite.get('/api/visites-export/visites');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.body.includes('\'=HYPERLINK'), 'formule neutralisée');
    assert.ok(!/;=HYPERLINK/.test(csv.body));
    const reg = await qualite.get('/api/visites-export/registre');
    assert.equal(reg.status, 200);
    assert.ok(reg.body.includes('Export') && !reg.body.includes('06 99 99 99 99') && !reg.body.includes('test@client.example'), 'registre sans coordonnées personnelles');
    const act = await qualite.get('/api/visites-export/actions');
    assert.equal(act.status, 200);
    assert.match(act.body.split('\r\n')[0], /Responsable;Échéance;Statut/);
    assert.equal((await qualite.get('/api/visites-export/autre')).status, 404);
    assert.ok(srv.db.list('audit', (a) => a.action === 'export' && a.entite === 'visites').length >= 3);
    await qualite.ok('DELETE', '/api/visites/' + v.id).catch(() => {});
  });

  test('anonymisation des visiteurs : à la demande (droit valider) et automatique', async () => {
    const v = srv.db.insert('visites', {
      numero: 'VIS-ANCIEN-1', titre: 'Visite ancienne', typeCode: 'visite_client', statut: 'terminee', secteurId: site.id, organisme: 'Ancien client',
      dateDebut: new Date(Date.now() - 400 * 86400000).toISOString(), dateFin: new Date(Date.now() - 400 * 86400000 + 3600000).toISOString(), hoteUserId: idQualite, participantsUserIds: [],
      visiteurs: [
        { id: 1, nom: 'Ancien', prenom: 'Visiteur', telephone: '06 11 11 11 11', email: 'ancien@client.example', pieceIdentite: 'CNI 999', vehicule: 'AA-000-AA', arrivee: new Date(Date.now() - 400 * 86400000).toISOString(), depart: new Date(Date.now() - 400 * 86400000 + 3000000).toISOString(), badgeNumero: 'VB99999991' },
        { id: 2, nom: 'Encore', prenom: 'Présent', telephone: '06 22 22 22 22', arrivee: new Date(Date.now() - 400 * 86400000).toISOString(), depart: null, badgeNumero: 'VB99999992' },
      ],
      constats: [], preparation: [], documents: [], historique: [], sequence: 2, createdBy: idQualite,
    });
    const recent = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite récente', visiteurs: [{ nom: 'Récent', telephone: '06 33 33 33 33' }] }));
    assert.equal((await qualite.post('/api/visites/purger', { jours: -1 })).status, 400);
    const r = await qualite.ok('POST', '/api/visites/purger', {});
    assert.equal(r.jours, 365);
    assert.equal(r.visiteurs, 1);
    const apres = srv.db.get('visites', v.id);
    assert.deepEqual([apres.visiteurs[0].telephone, apres.visiteurs[0].email, apres.visiteurs[0].pieceIdentite, apres.visiteurs[0].vehicule], ['', '', '', '']);
    assert.equal(apres.visiteurs[0].nom, 'Ancien', 'le nom reste au registre');
    assert.ok(apres.visiteurs[0].anonymiseLe);
    assert.equal(apres.visiteurs[1].telephone, '06 22 22 22 22', 'personne encore présente : non anonymisée');
    assert.equal(srv.db.get('visites', recent.id).visiteurs[0].telephone, '06 33 33 33 33', 'visite récente conservée');
    assert.equal((await qualite.put(`/api/visites/${v.id}/visiteurs/1`, { nom: 'Ancien', telephone: '06' })).status, 400, 'visiteur anonymisé non modifiable');
    assert.ok(srv.db.list('audit', (a) => a.action === 'purge').length >= 1);
    // Automatique : vérification quotidienne
    srv.db.update('visites', v.id, { visiteurs: apres.visiteurs.map((x) => (x.id === 1 ? Object.assign({}, x, { telephone: '06 44 44 44 44', anonymiseLe: null }) : x)) });
    const auto = srv.ctx.services.visites.verifierEcheances();
    assert.equal(auto.anonymisation.visiteurs, 1);
    assert.equal(srv.db.get('visites', v.id).visiteurs[0].telephone, '');
  });

  test('vérification quotidienne : rappel J-n unique, préparation et actions en retard', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite dans deux jours', dateDebut: new Date(Date.now() + 2 * 86400000).toISOString(), dateFin: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(), hoteUserId: idRespMaint, participantsUserIds: [idChef] }));
    await qualite.ok('POST', `/api/visites/${v.id}/preparation`, { libelle: 'Préparer le dossier', responsableUserId: idChefLecteur, echeance: dansJours(-1) });
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'piste_amelioration', description: 'Améliorer l\'accueil' })).constats[0];
    await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Créer un livret d\'accueil', responsableUserId: idChef, echeance: dansJours(-3) });
    const avantHote = notifs(idRespMaint).length;
    const r = srv.ctx.services.visites.verifierEcheances({ anonymiser: false });
    assert.ok(r.rappels >= 1);
    assert.ok(notifs(idRespMaint).slice(avantHote).some((n) => /Rappel : visite/.test(n.titre) && n.lien.includes(`/visites/${v.id}`)), 'hôte prévenu J-2');
    assert.ok(notifs(idChefLecteur).some((n) => /Préparation en retard/.test(n.titre)));
    assert.ok(notifs(idChef).some((n) => /Action en retard/.test(n.titre)));
    const total = srv.db.count('notifications');
    const r2 = srv.ctx.services.visites.verifierEcheances({ anonymiser: false });
    assert.equal(r2.rappels, 0, 'pas de second rappel');
    assert.equal(r2.actionsEnRetard, 0, 'une seule alerte par échéance');
    assert.equal(srv.db.count('notifications'), total);
  });

  test('suppression : droit supprimer, visite sans passage au registre', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'À supprimer', participantsUserIds: [idRespMaint] }));
    assert.equal((await respMaint.del('/api/visites/' + v.id)).status, 403);
    assert.equal((await qualite.del('/api/visites/' + v.id)).status, 200);
    assert.equal((await qualite.get('/api/visites/' + v.id)).status, 404);
    assert.ok(srv.db.list('audit', (a) => a.action === 'suppression' && a.entiteId === v.id).length === 1);
    assert.equal((await qualite.get('/api/visites/abc')).status, 404);
  });
});

describe('Audits & visites : données de démonstration', () => {
  let srv;
  before(async () => { srv = await demarrer(); });
  after(async () => { await srv.stop(); });

  test('seedDemo : 5 visites réalistes, compte qualité, idempotent', async () => {
    const { seedDemo } = require('../server/modules');
    const rapport = seedDemo(srv.ctx);
    const r = rapport.find((x) => x.module === 'Audits & visites');
    assert.ok(r && r.ok, JSON.stringify(r));
    const visites = srv.db.list('visites');
    assert.equal(visites.length, 5);
    assert.ok(srv.db.findOne('users', (u) => u.login === 'cqualite'));
    const iso = visites.find((v) => v.titre === 'Audit de renouvellement de certification ISO 9001');
    assert.equal(iso.statut, 'terminee');
    assert.equal(iso.constats.filter((c) => c.typeCode === 'nc_mineure').length, 1);
    assert.equal(iso.constats.filter((c) => c.typeCode === 'observation').length, 2);
    const svc = srv.ctx.services.visites;
    assert.equal(svc.presents().length, 1, 'un visiteur présent (visite du jour)');
    const c = srv.client();
    await c.login('cqualite', 'demo');
    const tab = await c.ok('GET', '/api/visites-tableau');
    assert.equal(tab.kpi.actionsEnRetard, 1);
    assert.equal(tab.kpi.presents, 1);
    assert.ok(tab.kpi.ncOuvertes >= 1);
    const second = seedDemo(srv.ctx).find((x) => x.module === 'Audits & visites');
    assert.equal(second.details, 'déjà présentes');
    assert.equal(srv.db.count('visites'), 5);
  });
});

describe('Audits & visites : non-régression de la revue (droits, périmètre, données personnelles, validation)', () => {
  let srv, admin, secteurs, profils, site, prod, maint, valreas, valProd, usineB;
  let qualite, respMaint, chef, chefLecteur, qualVal, lecteurVal;
  let idQualite, idChefLecteur, idQualVal;

  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  const notifs = (userId) => srv.db.list('notifications', (n) => n.userId === userId);
  async function creerUtilisateur(login, nomProfil, secteurIds, extra = {}) {
    const u = await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, prenom: 'Test', profilId: profil(nomProfil), secteurIds, password: 'motdepasse1', doitChangerMdp: false }, extra));
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return { c, id: u.id };
  }
  const base = (extra = {}) => Object.assign({ titre: 'Audit client', typeCode: 'audit_client', secteurId: site.id, organisme: 'Client SAS', dateDebut: heure(48), dateFin: heure(56) }, extra);
  async function actionVerifiee(v, libelle) {
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'nc_mineure', description: 'NC ' + libelle })).constats.slice(-1)[0];
    const a = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle, responsableUserId: idQualite })).constats.find((x) => x.id === c.id).actions[0];
    await qualite.ok('PUT', `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`, { statut: 'realisee' });
    await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}/valider`, { efficace: true, commentaire: 'Contrôle fait' });
    return { c, a };
  }

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
    valProd = await admin.ok('POST', '/api/secteurs', { nom: 'Production Valréas', code: 'VAL-PROD', type: 'service', parentId: valreas.id });
    usineB = await admin.ok('POST', '/api/secteurs', { nom: 'Usine B', code: 'USB', type: 'site' });
    secteurs = await admin.ok('GET', '/api/secteurs');
    site = secteurs.find((s) => s.code === 'SITE');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    ({ c: qualite, id: idQualite } = await creerUtilisateur('qualite', 'Responsable qualité', [site.id]));
    ({ c: respMaint } = await creerUtilisateur('respmaint', 'Responsable maintenance', []));
    ({ c: chef } = await creerUtilisateur('chefprod', 'Chef de secteur', [prod.id]));
    ({ c: chefLecteur, id: idChefLecteur } = await creerUtilisateur('cheflecteur', 'Chef de secteur', [prod.id], { overrides: { visites: { modifier: false } } }));
    ({ c: qualVal, id: idQualVal } = await creerUtilisateur('qualval', 'Responsable qualité', [valreas.id]));
    ({ c: lecteurVal } = await creerUtilisateur('lecteurval', 'Responsable qualité', [site.id], { siteAcces: [{ siteId: valreas.id, mode: 'lecture' }] }));
  });
  after(async () => { await srv.stop(); });

  test('constat avec une action vérifiée efficace : suppression réservée au droit supprimer', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit avec action vérifiée' }));
    const { c, a } = await actionVerifiee(v, 'Corriger');
    assert.equal((await respMaint.del(`/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`)).status, 403, 'action vérifiée : droit supprimer');
    const r = await respMaint.del(`/api/visites/${v.id}/constats/${c.id}`);
    assert.equal(r.status, 403, 'constat contenant une action vérifiée : droit supprimer');
    assert.match(r.body.erreur, /Supprimer/);
    const apres = srv.db.get('visites', v.id);
    assert.equal(apres.constats.length, 1);
    assert.equal(apres.constats[0].actions[0].verifiePar, idQualite, 'vérification conservée');
    // Sans action vérifiée, le droit modifier suffit
    const c2 = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Observation' })).constats[1];
    await qualite.ok('POST', `/api/visites/${v.id}/constats/${c2.id}/actions`, { libelle: 'Action ouverte', responsableUserId: idQualite });
    assert.equal((await respMaint.del(`/api/visites/${v.id}/constats/${c2.id}`)).status, 200);
    assert.equal((await qualite.del(`/api/visites/${v.id}/constats/${c.id}`)).status, 200, 'responsable qualité : droit supprimer');
  });

  test('statut final : passage d\'« annulée » à « terminée » réservé au droit valider, motif d\'annulation effacé', async () => {
    const v = await respMaint.ok('POST', '/api/visites', base({ titre: 'Audit annulé', dateDebut: heure(48), dateFin: heure(52) }));
    await respMaint.ok('POST', `/api/visites/${v.id}/statut`, { statut: 'annulee', motif: 'Client absent' });
    assert.equal((await respMaint.put('/api/visites/' + v.id, { titre: 'Modifiée' })).status, 400);
    assert.equal((await respMaint.post(`/api/visites/${v.id}/statut`, { statut: 'confirmee' })).status, 403);
    const t = await respMaint.post(`/api/visites/${v.id}/statut`, { statut: 'terminee' });
    assert.equal(t.status, 403, 'annulée → terminée : droit valider');
    assert.equal(srv.db.get('visites', v.id).statut, 'annulee');
    assert.equal((await respMaint.put('/api/visites/' + v.id, { titre: 'Modifiée après annulation' })).status, 400, 'toujours non modifiable');
    const ok = await qualite.ok('POST', `/api/visites/${v.id}/statut`, { statut: 'terminee' });
    assert.equal(ok.statut, 'terminee');
    assert.equal(ok.motifAnnulation, '', 'motif d\'annulation effacé en quittant « annulée »');
    assert.equal((await respMaint.post(`/api/visites/${v.id}/statut`, { statut: 'annulee', motif: 'Erreur' })).status, 403, 'terminée → annulée : droit valider');
  });

  test('action close : le responsable sans droit modifier ne peut pas la rouvrir', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit atelier', secteurId: prod.id, dateDebut: heure(-30), dateFin: heure(-25) }));
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs' })).constats[0];
    const a = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Action', responsableUserId: idChefLecteur })).constats[0].actions[0];
    const url = `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`;
    await qualite.ok('PUT', url, { statut: 'abandonnee', commentaire: 'Abandon décidé en revue' });
    const avant = notifs(idQualite).filter((n) => /à vérifier/.test(n.titre)).length;
    for (const statut of ['en_cours', 'realisee', 'a_faire']) {
      const r = await chefLecteur.put(url, { statut });
      assert.equal(r.status, 403, `abandonnée → ${statut}`);
      assert.match(r.body.erreur, /gestionnaire/);
    }
    assert.equal((await chefLecteur.put(url, { commentaire: 'Retouche' })).status, 403, 'action close : aucune retouche');
    assert.equal(srv.db.get('visites', v.id).constats[0].actions[0].statut, 'abandonnee');
    assert.equal(notifs(idQualite).filter((n) => /à vérifier/.test(n.titre)).length, avant, 'aucune notification « à vérifier »');
    assert.equal((await qualite.ok('PUT', url, { statut: 'en_cours' })).constats[0].actions[0].statut, 'en_cours', 'le gestionnaire rouvre l\'action');
  });

  test('désignations : hôte, participant, accompagnateur et responsables limités au périmètre de l\'auteur', async () => {
    assert.notEqual((await qualite.get('/api/utilisateurs/' + idQualVal)).status, 200, 'compte hors du périmètre de l\'organisateur');
    const r = await qualite.post('/api/visites', base({ titre: 'Audit D3', hoteUserId: idQualVal, visiteurs: [{ nom: 'Garcia', prenom: 'Inès', telephone: '06 12 34 56 78' }] }));
    assert.equal(r.status, 403, 'hôte hors périmètre');
    assert.match(r.body.erreur, /périmètre/);
    assert.equal((await qualite.post('/api/visites', base({ titre: 'Audit D4', participantsUserIds: [idQualVal] }))).status, 403, 'participant hors périmètre');
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit D5', dateDebut: heure(-1), dateFin: heure(4), visiteurs: [{ nom: 'Garcia', telephone: '06 12 34 56 78' }] }));
    assert.equal((await qualVal.get('/api/visites/' + v.id)).status, 404, 'non désigné : visite fermée');
    assert.equal((await qualite.put('/api/visites/' + v.id, { hoteUserId: idQualVal })).status, 403);
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs`, { nom: 'Autre', accompagnateurUserId: idQualVal })).status, 403, 'accompagnateur hors périmètre');
    assert.equal((await qualite.put(`/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}`, { accompagnateurUserId: idQualVal })).status, 403);
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}/arrivee`, { charteAcceptee: true, accompagnateurUserId: idQualVal })).status, 403, 'accompagnateur désigné à l\'arrivée');
    assert.equal((await qualite.post(`/api/visites/${v.id}/preparation`, { libelle: 'Salle', responsableUserId: idQualVal })).status, 403, 'responsable de préparation');
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs' })).constats[0];
    assert.equal((await qualite.post(`/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Action', responsableUserId: idQualVal })).status, 403, 'responsable d\'action');
    assert.equal((await qualVal.get('/api/visites/' + v.id)).status, 404, 'aucune désignation enregistrée');
    // Administrateur : désignation libre ; une désignation déjà enregistrée reste acceptée
    await admin.ok('PUT', '/api/visites/' + v.id, { hoteUserId: idQualVal });
    assert.equal((await qualite.ok('PUT', '/api/visites/' + v.id, { titre: 'Audit D5 modifié' })).hoteUserId, idQualVal, 'hôte déjà enregistré conservé');
    await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}/arrivee`, { charteAcceptee: true });
    await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}/depart`, {});
  });

  test('contact de l\'organisme : coordonnées réservées aux gestionnaires et anonymisées par la purge', async () => {
    const contact = { nom: 'Claire Morel', email: 'claire.morel@client.example', telephone: '06 00 00 41 12' };
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit atelier contact', secteurId: prod.id, contactOrganisme: contact }));
    assert.deepEqual((await qualite.ok('GET', '/api/visites/' + v.id)).contactOrganisme, Object.assign({ anonymiseLe: null }, contact), 'gestionnaire : coordonnées complètes');
    const lu = await chefLecteur.ok('GET', '/api/visites/' + v.id);
    assert.deepEqual(lu.contactOrganisme, { nom: 'Claire Morel' }, 'consultation seule : nom du contact uniquement');
    assert.ok(!JSON.stringify(lu).includes('claire.morel@client.example'));

    const fin = new Date(Date.now() - 500 * 86400000);
    const ancienne = srv.db.insert('visites', {
      numero: 'VIS-ANCIEN-9', titre: 'Visite ancienne', typeCode: 'visite_client', statut: 'terminee', secteurId: site.id, organisme: 'Ancien client',
      contactOrganisme: contact, dateDebut: new Date(fin.getTime() - 3600000).toISOString(), dateFin: fin.toISOString(), hoteUserId: idQualite, participantsUserIds: [],
      visiteurs: [{ id: 1, nom: 'Morel', prenom: 'Claire', email: contact.email, telephone: '06 00 00 41 13', arrivee: fin.toISOString(), depart: fin.toISOString(), badgeNumero: 'VB99999981' }],
      constats: [], preparation: [], documents: [], historique: [], sequence: 1, createdBy: idQualite,
    });
    const r = await qualite.ok('POST', '/api/visites/purger', {});
    assert.equal(r.contacts, 1);
    const apres = srv.db.get('visites', ancienne.id);
    assert.equal(apres.visiteurs[0].email, '');
    assert.deepEqual([apres.contactOrganisme.nom, apres.contactOrganisme.email, apres.contactOrganisme.telephone], ['Claire Morel', '', ''], 'contact anonymisé, nom conservé');
    assert.ok(apres.contactOrganisme.anonymiseLe);
    assert.equal(srv.db.get('visites', v.id).contactOrganisme.email, contact.email, 'visite récente conservée');
    const lecture = await qualite.ok('GET', '/api/visites/' + ancienne.id);
    assert.ok(lecture.contactOrganisme.anonymiseLe);
    assert.ok(/contact de l'organisme/.test(lecture.historique[0].details));
  });

  test('plan 3D et équipement hors de la portée du lecteur : masqués sur la fiche, plan illisible refusé à la saisie', async () => {
    const plan = srv.db.insert('plans', { numero: 'PL-900', nom: 'Plan confidentiel maintenance', secteurId: maint.id, objets: [{ id: 'o1', nom: 'Local transformateur HT', type: 'zone' }] });
    const eq = srv.db.insert('equipements', { numero: 'EQ-SECRET', nom: 'Transformateur HT poste 2', secteurId: maint.id, actif: true });
    assert.equal((await chef.get('/api/plans/' + plan.id)).status, 404);
    assert.equal((await chef.get('/api/equipements/' + eq.id)).status, 404);
    const v = await admin.ok('POST', '/api/visites', base({ titre: 'Visite atelier', secteurId: prod.id, planId: plan.id, objetIds: ['o1'] }));
    await admin.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs', equipementId: eq.id });
    const vu = await chef.ok('GET', '/api/visites/' + v.id);
    assert.equal(vu.plan.masque, true);
    assert.deepEqual(vu.plan.objets, []);
    assert.equal(vu.constats[0].equipement.masque, true);
    const texteFiche = JSON.stringify(vu);
    for (const secret of ['PL-900', 'Plan confidentiel', 'Local transformateur', 'EQ-SECRET', 'Transformateur HT']) assert.ok(!texteFiche.includes(secret), `« ${secret} » non divulgué`);
    const pourAdmin = await admin.ok('GET', '/api/visites/' + v.id);
    assert.equal(pourAdmin.plan.nom, 'Plan confidentiel maintenance');
    assert.equal(pourAdmin.constats[0].equipement.numero, 'EQ-SECRET');
    // Le chef ne peut pas rattacher un plan qu'il ne peut pas lire (même réponse qu'un plan inexistant)
    const sienne = await admin.ok('POST', '/api/visites', base({ titre: 'Visite du chef', secteurId: prod.id }));
    const refus = await chef.put('/api/visites/' + sienne.id, { planId: plan.id });
    assert.equal(refus.status, 400);
    assert.ok(!JSON.stringify(refus.body).includes('confidentiel'));
    // Plan et équipement déjà rattachés : conservés lors des modifications du chef
    const maj = await chef.ok('PUT', '/api/visites/' + v.id, { titre: 'Visite atelier modifiée' });
    assert.equal(srv.db.get('visites', v.id).planId, plan.id);
    assert.equal(maj.plan.masque, true);
    assert.equal((await chef.put('/api/visites/' + v.id, { objetIds: [] })).status, 403, 'objets d\'un plan illisible non modifiables');
    const c = (await chef.ok('PUT', `/api/visites/${v.id}/constats/${vu.constats[0].id}`, { description: 'Obs reformulée' })).constats[0];
    assert.equal(srv.db.get('visites', v.id).constats[0].equipementId, eq.id, 'équipement conservé');
    assert.equal(c.equipement.masque, true);
  });

  test('registre et plan d\'actions : droits calculés par ligne (site en lecture seule)', async () => {
    const v = await admin.ok('POST', '/api/visites', base({ titre: 'Visite à Valréas', secteurId: valreas.id, dateDebut: heure(-1), dateFin: heure(4), visiteurs: [{ nom: 'Bonnet' }] }));
    const c = (await admin.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs' })).constats[0];
    await admin.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Action Valréas', responsableUserId: idQualite });
    const ici = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite ici', dateDebut: heure(-1), dateFin: heure(4), visiteurs: [{ nom: 'Arnaud' }] }));
    const reg = await lecteurVal.ok('GET', '/api/visites-registre');
    const ligneVal = reg.attendus.find((l) => l.visiteId === v.id);
    assert.ok(ligneVal, 'visite du site en lecture seule listée');
    assert.equal(ligneVal.droits.accueil, false, 'site en lecture seule : pas d\'accueil');
    assert.equal(reg.attendus.find((l) => l.visiteId === ici.id).droits.accueil, true);
    assert.equal((await lecteurVal.post(`/api/visites/${v.id}/visiteurs/${ligneVal.visiteurId}/arrivee`, { charteAcceptee: true })).status, 403, 'le serveur confirme');
    const actions = await lecteurVal.ok('GET', '/api/visites-actions?visiteId=' + v.id);
    assert.deepEqual(actions[0].droits, { gestion: false, avancement: false, verifier: false, demande: false });
    const pourQualite = await qualVal.ok('GET', '/api/visites-actions?visiteId=' + v.id);
    assert.equal(pourQualite[0].droits.gestion, true);
    assert.equal(pourQualite[0].droits.demande, true);
    const pourResponsable = await qualite.ok('GET', '/api/visites-actions?responsableUserId=moi');
    assert.equal(pourResponsable.find((a) => a.visiteId === v.id).droits.avancement, true, 'responsable de l\'action : avancement possible');
  });

  test('registre : indicateur de pièce d\'identité déjà saisie (jamais sa valeur)', async () => {
    const cfg = srv.db.getConfig();
    cfg.visites.demanderPieceIdentite = true;
    srv.db.setConfig(cfg);
    try {
      const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite identité', dateDebut: heure(-1), dateFin: heure(3), visiteurs: [{ nom: 'Martin', pieceIdentite: 'CNI 1234567' }, { nom: 'Sans pièce' }] }));
      assert.equal(v.visiteurs[0].pieceIdentiteRenseignee, true);
      const reg = await qualite.ok('GET', '/api/visites-registre');
      const l = reg.attendus.find((x) => x.visiteId === v.id && x.nom === 'Martin');
      assert.equal(l.pieceIdentiteRenseignee, true);
      assert.equal(reg.attendus.find((x) => x.visiteId === v.id && x.nom === 'Sans pièce').pieceIdentiteRenseignee, false);
      assert.ok(!JSON.stringify(reg).includes('1234567'), 'valeur jamais transmise au registre');
      await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${l.visiteurId}/arrivee`, { charteAcceptee: true });
      assert.equal(srv.db.get('visites', v.id).visiteurs[0].pieceIdentite, 'CNI 1234567', 'pièce enregistrée conservée');
      await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${l.visiteurId}/depart`, {});
    } finally {
      cfg.visites.demanderPieceIdentite = false;
      srv.db.setConfig(cfg);
    }
  });

  test('registre : heure d\'arrivée bornée à la veille du début de la visite', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite bornée', dateDebut: heure(-1), dateFin: heure(4), visiteurs: [{ nom: 'Avant' }] }));
    const url = `/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}/arrivee`;
    const r = await qualite.post(url, { charteAcceptee: true, horodatage: heure(-24 * 6) });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /antérieure à la visite/);
    assert.equal(srv.db.get('visites', v.id).visiteurs[0].arrivee, null);
    const ok = await qualite.ok('POST', url, { charteAcceptee: true, horodatage: heure(-0.5) });
    assert.ok(ok.visiteurs[0].arrivee);
    const d = `/api/visites/${v.id}/visiteurs/${v.visiteurs[0].id}/depart`;
    assert.equal((await qualite.post(d, { horodatage: heure(-0.75) })).status, 400, 'départ avant l\'arrivée');
    await qualite.ok('POST', d, {});
  });

  test('validation : textes non textuels, identifiants hexadécimaux et nombres en exposant refusés', async () => {
    const r = await qualite.post('/api/visites', base({ titre: true }));
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /texte attendu/);
    assert.equal((await qualite.post('/api/visites', base({ titre: 'Organisme numérique', organisme: 12345 }))).status, 400);
    assert.equal((await qualite.post('/api/visites', base({ titre: 'Hexa', hoteUserId: '0x3' }))).status, 400);
    assert.equal((await qualite.post('/api/visites', base({ titre: 'Hexa', secteurId: '0x1' }))).status, 400);
    assert.equal((await qualite.post('/api/visites', base({ titre: 'Exposant', secteurId: '1e0' }))).status, 400);
    assert.equal((await qualite.post('/api/visites/purger', { jours: '1e3' })).status, 400);
    assert.equal((await qualite.post('/api/visites/purger', { jours: '0x10' })).status, 400);
    assert.equal((await qualite.ok('POST', '/api/visites/purger', { jours: '400' })).jours, 400, 'écriture décimale acceptée');
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Identifiants', secteurId: String(site.id), visiteurs: [{ nom: 'Test' }] }));
    assert.equal(v.secteurId, site.id, 'identifiant en chaîne décimale accepté');
    assert.equal((await qualite.get('/api/visites/0x' + v.id.toString(16))).status, 404, 'identifiant d\'URL hexadécimal');
    assert.equal((await qualite.get(`/api/visites/${v.id}/visiteurs/0x${v.visiteurs[0].id.toString(16)}`)).status, 404);
    assert.equal((await qualite.post(`/api/visites/${v.id}/visiteurs`, { nom: 'Faux', societe: 42 })).status, 400);
    assert.equal((await qualite.post('/api/visites-registre/scan', { code: 12345678 })).status, 400);
  });

  test('date de réalisation d\'une action : jamais dans le futur', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit réalisation', secteurId: prod.id }));
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs' })).constats[0];
    const a = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Action', responsableUserId: idChefLecteur })).constats[0].actions[0];
    const url = `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`;
    const r = await chefLecteur.put(url, { statut: 'realisee', dateRealisation: '2099-12-31' });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /futur/);
    assert.equal((await qualite.put(url, { statut: 'realisee', dateRealisation: dansJours(1) })).status, 400, 'gestionnaire : même règle');
    const ok = await chefLecteur.ok('PUT', url, { statut: 'realisee', dateRealisation: dansJours(-2) });
    assert.equal(ok.constats[0].actions[0].dateRealisation, dansJours(-2));
  });

  test('journal d\'activité : libellés français des arrivées, départs et liaisons', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Visite journal', dateDebut: heure(-1), dateFin: heure(3), visiteurs: [{ nom: 'Journal' }] }));
    const vid = v.visiteurs[0].id;
    await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${vid}/arrivee`, { charteAcceptee: true });
    await qualite.ok('POST', `/api/visites/${v.id}/visiteurs/${vid}/depart`, {});
    const j = await admin.ok('GET', '/api/audit?entite=visites');
    assert.ok(j.actions.includes('arrivee') && j.actions.includes('depart'));
    assert.equal(j.libellesActions.arrivee, 'Arrivée d\'un visiteur');
    assert.equal(j.libellesActions.depart, 'Départ d\'un visiteur');
    assert.equal(j.libellesActions.liaison, 'Liaison à une demande d\'intervention');
    const csv = await admin.get('/api/audit/export?entite=visites');
    assert.ok(csv.body.includes('Arrivée d\'un visiteur') && csv.body.includes('Départ d\'un visiteur'));
  });

  test('demande d\'intervention refusée : responsable prévenu, nouvelle demande possible, ancienne conservée', async () => {
    const v = await qualite.ok('POST', '/api/visites', base({ titre: 'Audit sécurité', dateDebut: heure(-10), dateFin: heure(-8) }));
    const c = (await qualite.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Zone non matérialisée', secteurId: prod.id })).constats[0];
    const a = (await qualite.ok('POST', `/api/visites/${v.id}/constats/${c.id}/actions`, { libelle: 'Matérialiser la zone', responsableUserId: idChefLecteur, echeance: dansJours(10) })).constats[0].actions[0];
    const url = `/api/visites/${v.id}/constats/${c.id}/actions/${a.id}/creer-demande`;
    const r = await qualite.ok('POST', url, {});
    assert.equal(srv.db.get('demandes', r.demande.id).statut, 'soumise');
    const avant = notifs(idChefLecteur).length;
    await admin.ok('POST', `/api/demandes/${r.demande.id}/refuser`, { motif: 'Hors budget' });
    const n = notifs(idChefLecteur).slice(avant);
    assert.ok(n.some((x) => /refusée/.test(x.titre) && /Hors budget/.test(x.message) && x.lien === `#/visites/${v.id}?onglet=constats`), 'responsable de l\'action prévenu du refus');
    const fiche = await qualite.ok('GET', '/api/visites/' + v.id);
    const act = fiche.constats[0].actions[0];
    assert.equal(act.statut, 'en_cours');
    assert.equal(act.demande.refusee, true);
    assert.ok(fiche.historique.some((h) => /refusée/.test(h.details) && /Hors budget/.test(h.details)), 'refus inscrit à l\'historique');
    const lignes = await qualite.ok('GET', '/api/visites-actions?visiteId=' + v.id);
    assert.equal(lignes[0].droits.demande, true, 'nouvelle demande proposée');
    const r2 = await qualite.ok('POST', url, { titre: 'Matérialiser la zone (devis réduit)' });
    assert.notEqual(r2.demande.id, r.demande.id);
    const act2 = r2.visite.constats[0].actions[0];
    assert.equal(act2.demandeId, r2.demande.id);
    assert.equal(act2.demande.refusee, false);
    assert.deepEqual(act2.demandesPrecedentes.map((x) => [x.id, x.statut]), [[r.demande.id, 'refusee']], 'demande refusée conservée');
    assert.equal((await qualite.post(url, {})).status, 409, 'demande en cours : une seule');
    assert.equal((await qualite.del(`/api/visites/${v.id}/constats/${c.id}/actions/${a.id}`)).status, 400, 'action liée : suppression toujours refusée');
  });

  test('changement de site d\'une visite refusé tant que ses constats portent sur l\'ancien site', async () => {
    const v = await admin.ok('POST', '/api/visites', base({ titre: 'Visite déplacée', secteurId: site.id }));
    const c = (await admin.ok('POST', `/api/visites/${v.id}/constats`, { typeCode: 'observation', description: 'Obs', secteurId: prod.id })).constats[0];
    const r = await admin.put('/api/visites/' + v.id, { secteurId: usineB.id });
    assert.equal(r.status, 400);
    assert.match(r.body.erreur, /1 constat\(s\).*Site principal/);
    assert.equal(srv.db.get('visites', v.id).secteurId, site.id);
    assert.equal((await admin.ok('PUT', '/api/visites/' + v.id, { secteurId: prod.id })).secteurId, prod.id, 'même site : changement de secteur libre');
    await admin.ok('PUT', `/api/visites/${v.id}/constats/${c.id}`, { secteurId: null });
    const ok = await admin.ok('PUT', '/api/visites/' + v.id, { secteurId: usineB.id });
    assert.equal(ok.siteId, usineB.id);
  });

  test('exports CSV : règle d\'échappement commune (server/csv.js)', async () => {
    const { csvEscape } = require('../server/csv');
    assert.equal(require('../server/modules/visites').csvCellule, undefined, 'aucune copie locale de la règle');
    await qualite.ok('POST', '/api/visites', base({ titre: 'Export échappement', organisme: '+12', referentiel: '+33 6 00 00 00 00' }));
    const csv = await qualite.get('/api/visites-export/visites');
    const ligne = csv.body.split('\r\n').find((l) => l.includes('Export échappement'));
    assert.ok(ligne.includes(';' + csvEscape('+12') + ';'), 'nombre signé conservé comme par csvEscape');
    assert.ok(ligne.includes(';' + csvEscape('+33 6 00 00 00 00') + ';'), 'texte commençant par + neutralisé');
    assert.ok(!ligne.includes('\'+12'));
  });
});
