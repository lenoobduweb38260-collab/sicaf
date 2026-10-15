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
