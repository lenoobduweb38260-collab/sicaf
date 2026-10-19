'use strict';
/**
 * Tests du module Équipements : CRUD, validation, arborescence, documents, compteur,
 * changement d'état (événement, audit, notification), suppression / désactivation,
 * export CSV, droits (403), portée par secteur, service publié, données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

/** Recherche récursive d'un nœud de secteur dans l'arbre (les services sont sous un site). */
function noeudSecteur(noeuds, id) {
  for (const n of noeuds || []) {
    if (n.type === 'secteur' && n.id === id) return n;
    const r = noeudSecteur((n.enfants || []).filter((e) => e.type === 'secteur'), id);
    if (r) return r;
  }
  return null;
}
function tousLesSecteurs(noeuds) { return (noeuds || []).filter((n) => n.type === 'secteur').flatMap((n) => [n, ...tousLesSecteurs(n.enfants)]); }

describe('Module Équipements', () => {
  let srv, admin, prod, maint, log, profils;
  let compresseur, moteur;

  before(async () => {
    srv = await demarrer();
    admin = srv.client();
    await admin.login('admin', 'admin');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    prod = secteurs.find((s) => s.code === 'PROD');
    maint = secteurs.find((s) => s.code === 'MAINT');
    log = secteurs.find((s) => s.code === 'LOG');
    profils = await admin.ok('GET', '/api/profils');
  });
  after(async () => { await srv.stop(); });

  const profil = (nom) => profils.find((p) => p.nom === nom);
  async function creerUtilisateur(login, nomProfil, secteurIds) {
    await admin.ok('POST', '/api/utilisateurs', { login, nom: login, profilId: profil(nomProfil).id, secteurIds, password: 'motdepasse1', doitChangerMdp: false });
    const c = srv.client();
    await c.login(login, 'motdepasse1');
    return c;
  }

  test('création : validation, numéro automatique, valeurs par défaut', async () => {
    assert.equal((await admin.post('/api/equipements', {})).status, 400, 'désignation obligatoire');
    assert.equal((await admin.post('/api/equipements', { nom: 'Sans secteur' })).status, 400, 'secteur obligatoire sans parent');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: 99999 })).status, 400, 'secteur inexistant');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, typeCode: 'inexistant' })).status, 400, 'code de type invalide');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, etatCode: 'inexistant' })).status, 400, 'code d\'état invalide');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, criticiteCode: 'Z' })).status, 400, 'code de criticité invalide');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, dateMiseEnService: '12/03/2020' })).status, 400, 'date invalide');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, valeurAchat: -5 })).status, 400, 'valeur d\'achat négative');
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, fournisseurId: 12345 })).status, 400, 'fournisseur inexistant');

    compresseur = await admin.ok('POST', '/api/equipements', {
      nom: 'Compresseur d\'air', secteurId: prod.id, typeCode: 'machine', criticiteCode: 'A', marque: 'Atlas Copco', modele: 'GA 37', numeroSerie: 'AIF-1', localisation: 'Salle des compresseurs',
      compteur: { valeur: 100, unite: 'heures' }, dateMiseEnService: '2019-03-12', valeurAchat: 28500, description: 'Compresseur à vis',
    });
    assert.match(compresseur.numero, /^EQ-\d{4}$/, 'numéro généré selon le gabarit');
    assert.equal(compresseur.etatCode, srv.ctx.liste('etatsEquipement')[0].code, 'état par défaut = premier code de la liste');
    assert.equal(compresseur.criticiteCode, 'A');
    assert.equal(compresseur.actif, true);
    assert.equal(compresseur.createdBy, 1);
    assert.ok(compresseur.secteurChemin.endsWith('Production'), compresseur.secteurChemin);
    assert.deepEqual(compresseur.compteur, { valeur: 100, unite: 'heures' });
    assert.equal(compresseur.compteurReleves.length, 1, 'un relevé initial est historisé quand la valeur est non nulle');
    assert.equal(compresseur.nbOtOuverts, 0);

    const dbl = await admin.post('/api/equipements', { nom: 'Doublon', secteurId: prod.id, numero: compresseur.numero.toLowerCase() });
    assert.equal(dbl.status, 400, 'numéro déjà utilisé (insensible à la casse)');
    const perso = await admin.ok('POST', '/api/equipements', { nom: 'Numéro libre', secteurId: maint.id, numero: 'PERSO-001', criticiteCode: 'C' });
    assert.equal(perso.numero, 'PERSO-001');
    const suivant = await admin.ok('POST', '/api/equipements', { nom: 'Numéro suivant', secteurId: maint.id, criticiteCode: 'C' });
    assert.match(suivant.numero, /^EQ-\d{4}$/);
    assert.notEqual(suivant.numero, compresseur.numero);
  });

  test('sous-équipement : héritage du secteur, chemin, enfants, cycles interdits', async () => {
    moteur = await admin.ok('POST', '/api/equipements', { nom: 'Moteur principal', parentId: compresseur.id, typeCode: 'machine', criticiteCode: 'B' });
    assert.equal(moteur.secteurId, prod.id, 'secteur hérité du parent');
    assert.deepEqual(moteur.chemin.map((a) => a.id), [compresseur.id]);
    assert.equal(moteur.parent.numero, compresseur.numero);

    const fiche = await admin.ok('GET', '/api/equipements/' + compresseur.id);
    assert.equal(fiche.enfants.length, 1);
    assert.equal(fiche.enfants[0].id, moteur.id);
    assert.equal(fiche.nbEnfants, 1);

    assert.equal((await admin.put('/api/equipements/' + compresseur.id, { parentId: compresseur.id })).status, 400, 'auto-référence refusée');
    assert.equal((await admin.put('/api/equipements/' + compresseur.id, { parentId: moteur.id })).status, 400, 'cycle refusé');
    assert.equal((await admin.put('/api/equipements/' + moteur.id, { parentId: 99999 })).status, 400, 'parent inexistant');

    // Changement de secteur du parent : les sous-équipements qui le suivaient sont déplacés avec lui
    await admin.ok('PUT', '/api/equipements/' + compresseur.id, { secteurId: log.id });
    assert.equal((await admin.ok('GET', '/api/equipements/' + moteur.id)).secteurId, log.id);
    await admin.ok('PUT', '/api/equipements/' + compresseur.id, { secteurId: prod.id });
    assert.equal((await admin.ok('GET', '/api/equipements/' + moteur.id)).secteurId, prod.id);
  });

  test('liste : filtres, recherche, allègement des lignes', async () => {
    const tous = await admin.ok('GET', '/api/equipements');
    assert.ok(tous.length >= 4);
    assert.equal(tous[0].documents, undefined, 'les documents ne sont pas renvoyés dans la liste');
    assert.ok(tous.every((e) => typeof e.secteurChemin === 'string' && typeof e.nbEnfants === 'number'));
    const parSecteur = await admin.ok('GET', '/api/equipements?secteurId=' + prod.id);
    assert.ok(parSecteur.length >= 2 && parSecteur.every((e) => e.secteurId === prod.id));
    const parType = await admin.ok('GET', '/api/equipements?typeCode=machine');
    assert.ok(parType.length >= 2 && parType.every((e) => e.typeCode === 'machine'));
    const parCrit = await admin.ok('GET', '/api/equipements?criticiteCode=A');
    assert.deepEqual(parCrit.map((e) => e.id), [compresseur.id]);
    const racines = await admin.ok('GET', '/api/equipements?parentId=aucun');
    assert.ok(racines.every((e) => e.parentId == null) && !racines.some((e) => e.id === moteur.id));
    const enfants = await admin.ok('GET', '/api/equipements?parentId=' + compresseur.id);
    assert.deepEqual(enfants.map((e) => e.id), [moteur.id]);
    const recherche = await admin.ok('GET', '/api/equipements?recherche=atlas');
    assert.deepEqual(recherche.map((e) => e.id), [compresseur.id], 'recherche sur la marque');
    const parEtat = await admin.ok('GET', '/api/equipements?etatCode=' + compresseur.etatCode);
    assert.ok(parEtat.some((e) => e.id === compresseur.id));
    assert.equal((await admin.ok('GET', '/api/equipements?actif=0')).length, 0);
  });

  test('arbre : secteurs → équipements → sous-équipements avec compteurs', async () => {
    const arbre = await admin.ok('GET', '/api/equipements-arbre');
    assert.ok(arbre.length >= 1 && arbre.every((n) => n.type === 'secteur'));
    assert.ok(tousLesSecteurs(arbre).length >= 5, 'site et services présents dans l\'arbre');
    const nProd = noeudSecteur(arbre, prod.id);
    assert.ok(nProd, 'secteur Production présent');
    const nComp = nProd.enfants.find((n) => n.type === 'equipement' && n.id === compresseur.id);
    assert.ok(nComp, 'le compresseur est sous Production');
    assert.equal(nComp.enfants.length, 1);
    assert.equal(nComp.enfants[0].id, moteur.id);
    assert.equal(nComp.nbEquipements, 1, 'compteur de sous-équipements');
    assert.ok(nProd.nbEquipements >= 2, 'compteur du secteur = équipements + sous-équipements');
    assert.ok(!nProd.enfants.some((n) => n.type === 'equipement' && n.id === moteur.id), 'le sous-équipement n\'apparaît pas à la racine du secteur');
  });

  test('modification et champs personnalisés', async () => {
    const cfg = await admin.ok('PUT', '/api/configuration', { champsPersonnalises: { equipements: [{ label: 'Puissance (kW)', type: 'nombre' }, { label: 'Classe énergie', type: 'liste', options: 'A;B;C' }] } });
    const cle = cfg.champsPersonnalises.equipements[0].cle;
    assert.equal((await admin.put('/api/equipements/' + compresseur.id, { champs: { [cle]: 'abc' } })).status, 400, 'nombre attendu');
    const maj = await admin.ok('PUT', '/api/equipements/' + compresseur.id, { localisation: 'Bâtiment utilités', champs: { [cle]: 37, classe_energie: 'B' }, notes: 'Vidange tous les 4000 h' });
    assert.equal(maj.localisation, 'Bâtiment utilités');
    assert.equal(maj.champs[cle], 37);
    assert.equal(maj.champs.classe_energie, 'B');
    assert.equal(maj.nom, compresseur.nom, 'les champs non fournis sont conservés');
    assert.equal(maj.numero, compresseur.numero);
    assert.equal((await admin.put('/api/equipements/' + compresseur.id, { nom: '' })).status, 400);
    assert.equal((await admin.put('/api/equipements/99999', { nom: 'x' })).status, 404);
    await admin.ok('PUT', '/api/configuration', { champsPersonnalises: { equipements: [] } });
  });

  test('changement d\'état rapide : événement, historique, audit, notification', async () => {
    const recus = [];
    srv.ctx.on('equipement:etat', (d) => recus.push(d));
    // Un responsable (droit ot › affecter, portée globale) est notifié
    await admin.ok('POST', '/api/utilisateurs', { login: 'resp', nom: 'Responsable', profilId: profil('Responsable maintenance').id, secteurIds: [], password: 'motdepasse1', doitChangerMdp: false });
    const resp = srv.db.findOne('users', (u) => u.login === 'resp');

    assert.equal((await admin.put(`/api/equipements/${compresseur.id}/etat`, {})).status, 400, 'état obligatoire');
    assert.equal((await admin.put(`/api/equipements/${compresseur.id}/etat`, { etatCode: 'inconnu' })).status, 400, 'code invalide');
    assert.equal((await admin.put(`/api/equipements/${compresseur.id}/etat`, { etatCode: compresseur.etatCode })).status, 400, 'déjà dans cet état');

    const e = await admin.ok('PUT', `/api/equipements/${compresseur.id}/etat`, { etatCode: 'arret', commentaire: 'Fuite d\'huile' });
    assert.equal(e.etatCode, 'arret');
    assert.equal(e.historiqueEtats.length, 1);
    assert.equal(e.historiqueEtats[0].ancien, compresseur.etatCode);
    assert.equal(e.historiqueEtats[0].nouveau, 'arret');
    assert.equal(e.historiqueEtats[0].commentaire, 'Fuite d\'huile');
    assert.equal(recus.length, 1, 'événement equipement:etat émis');
    assert.equal(recus[0].ancien, compresseur.etatCode);
    assert.equal(recus[0].nouveau, 'arret');
    assert.equal(recus[0].equipement.id, compresseur.id);
    const audit = await admin.ok('GET', '/api/audit?entite=equipements&action=statut');
    assert.ok(audit.lignes.some((l) => l.entiteId === compresseur.id && /Fuite/.test(l.details)), 'ligne d\'audit « statut »');
    const notifs = srv.db.list('notifications', (n) => n.userId === resp.id);
    assert.ok(notifs.some((n) => n.lien === '#/equipements/' + compresseur.id && n.type !== 'journal'), 'notification du responsable avec lien vers la fiche');

    // La modification classique d'un état est aussi historisée
    const e2 = await admin.ok('PUT', '/api/equipements/' + compresseur.id, { etatCode: 'en_service' });
    assert.equal(e2.etatCode, 'en_service');
    assert.equal(e2.historiqueEtats.length, 2);
    assert.equal(recus.length, 2);
  });

  test('compteur : relevés historisés, validation, service ctx.services.equipements.releverCompteur', async () => {
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/compteur`, {})).status, 400, 'valeur obligatoire');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/compteur`, { valeur: -1 })).status, 400, 'valeur négative');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/compteur`, { valeur: 'abc' })).status, 400, 'valeur non numérique');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/compteur`, { valeur: 10, date: '2999-01-01' })).status, 400, 'date future refusée');

    const e = await admin.ok('POST', `/api/equipements/${compresseur.id}/compteur`, { valeur: 250, commentaire: 'Ronde hebdomadaire' });
    assert.equal(e.compteur.valeur, 250);
    assert.equal(e.compteur.unite, 'heures');
    assert.equal(e.compteurReleves.length, 2, 'relevé initial + nouveau relevé');
    assert.equal(e.compteurReleves[0].valeur, 250, 'le relevé le plus récent est en tête');
    assert.equal(e.compteurReleves[0].userId, 1);
    assert.equal(e.compteurReleves[0].commentaire, 'Ronde hebdomadaire');
    assert.equal(e.dernierReleve, e.compteurReleves[0].date);

    const svc = srv.ctx.services.equipements;
    assert.equal(typeof svc.releverCompteur, 'function', 'service publié');
    const maj = svc.releverCompteur(compresseur.id, 300, null, { otId: 42, commentaire: 'Clôture OT' });
    assert.equal(maj.compteur.valeur, 300);
    assert.equal(maj.compteurReleves.length, 3);
    assert.equal(maj.compteurReleves[2].otId, 42);
    assert.throws(() => svc.releverCompteur(99999, 10, null), /introuvable/);
    assert.throws(() => svc.releverCompteur(compresseur.id, -3, null), /positif/);
    assert.equal(svc.secteurDe(compresseur.id), prod.id);
    assert.match(svc.chemin(moteur.id), /Production › Compresseur d'air › Moteur principal/);
    assert.deepEqual(svc.descendants(compresseur.id), [moteur.id]);

    const fiche = await admin.ok('GET', '/api/equipements/' + compresseur.id);
    assert.equal(fiche.compteur.valeur, 300);
    assert.equal(fiche.compteurReleves.length, 3);
  });

  test('documents : ajout (dataURL ≤ 5 Mo), consultation, suppression', async () => {
    const texte = Buffer.from('Notice du compresseur').toString('base64');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/documents`, { nom: 'x.txt', contenu: 'pas une dataURL' })).status, 400, 'contenu invalide');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/documents`, { nom: '', contenu: 'data:text/plain;base64,' + texte })).status, 400, 'nom obligatoire');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/documents`, { nom: 'vide.txt', contenu: 'data:text/plain;base64,' })).status, 400, 'document vide');
    const trop = Buffer.alloc(5 * 1024 * 1024 + 100, 1).toString('base64');
    assert.equal((await admin.post(`/api/equipements/${compresseur.id}/documents`, { nom: 'gros.bin', type: 'application/octet-stream', contenu: 'data:application/octet-stream;base64,' + trop })).status, 400, 'plus de 5 Mo refusé');

    const r = await admin.ok('POST', `/api/equipements/${compresseur.id}/documents`, { nom: 'notice.txt', type: 'text/plain', taille: 21, contenu: 'data:text/plain;base64,' + texte, description: 'Notice constructeur' });
    assert.equal(r.document.index, 0);
    assert.equal(r.document.taille, 21);
    assert.equal(r.document.estImage, false);
    assert.equal(r.documents.length, 1);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r2 = await admin.ok('POST', `/api/equipements/${compresseur.id}/documents`, { nom: 'photo.png', type: 'image/png', contenu: 'data:image/png;base64,' + png });
    assert.equal(r2.document.estImage, true);

    const fiche = await admin.ok('GET', '/api/equipements/' + compresseur.id);
    assert.equal(fiche.documents.length, 2);
    assert.equal(fiche.documents[0].contenu, undefined, 'le contenu n\'est pas renvoyé dans la fiche');
    assert.equal(fiche.documents[0].userNom, 'Administrateur');
    assert.equal(fiche.photoIndex, 1, 'la première image sert de photo');
    assert.equal(fiche.nbDocuments, 2);

    const dl = await admin.get(`/api/equipements/${compresseur.id}/documents/0`);
    assert.equal(dl.status, 200);
    assert.equal(dl.body, 'Notice du compresseur');
    assert.match(dl.headers.get('content-type'), /text\/plain/);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const img = await admin.get(`/api/equipements/${compresseur.id}/documents/1`);
    assert.match(img.headers.get('content-type'), /image\/png/);
    assert.match(img.headers.get('content-disposition'), /inline/);
    assert.equal((await admin.get(`/api/equipements/${compresseur.id}/documents/7`)).status, 404);

    assert.equal((await admin.del(`/api/equipements/${compresseur.id}/documents/9`)).status, 404);
    const sup = await admin.ok('DELETE', `/api/equipements/${compresseur.id}/documents/0`);
    assert.equal(sup.documents.length, 1);
    assert.equal(sup.documents[0].nom, 'photo.png');
    assert.equal((await admin.ok('GET', '/api/equipements/' + compresseur.id)).photoIndex, 0);
  });

  test('duplication', async () => {
    const copie = await admin.ok('POST', `/api/equipements/${compresseur.id}/dupliquer`, { nom: 'Compresseur n°2' });
    assert.notEqual(copie.id, compresseur.id);
    assert.notEqual(copie.numero, compresseur.numero);
    assert.equal(copie.nom, 'Compresseur n°2');
    assert.equal(copie.marque, 'Atlas Copco');
    assert.equal(copie.secteurId, prod.id);
    assert.equal(copie.numeroSerie, '', 'numéro de série non repris');
    assert.equal(copie.compteur.valeur, 0, 'compteur remis à zéro');
    assert.equal(copie.documents.length, 0, 'documents non repris');
    assert.equal(copie.compteurReleves.length, 0);
    const sansNom = await admin.ok('POST', `/api/equipements/${moteur.id}/dupliquer`, {});
    assert.equal(sansNom.nom, 'Moteur principal (copie)');
    assert.equal(sansNom.parentId, compresseur.id, 'le parent est conservé');
    await admin.ok('DELETE', '/api/equipements/' + sansNom.id);
    await admin.ok('DELETE', '/api/equipements/' + copie.id);
  });

  test('export CSV (droit exporter, filtres, champs)', async () => {
    const r = await admin.get('/api/equipements-export?secteurId=' + prod.id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /equipements-.*\.csv/);
    const lignes = String(r.body).split('\r\n');
    assert.match(lignes[0], /^\uFEFF?Numéro;Désignation;Type;État;Criticité;Secteur/);
    assert.ok(lignes.some((l) => l.includes(compresseur.numero) && l.includes('Atlas Copco') && l.includes('Production')));
    assert.ok(lignes.some((l) => l.includes('Moteur principal') && l.includes(compresseur.numero)), 'le parent figure dans la ligne du sous-équipement');
    assert.ok(!lignes.some((l) => l.includes('PERSO-001')), 'filtre secteur appliqué à l\'export');
    const audit = await admin.ok('GET', '/api/audit?entite=equipements&action=export');
    assert.ok(audit.total >= 1, 'export tracé dans l\'audit');
  });

  test('suppression : refus avec sous-équipements, désactivation si référencé, suppression sinon', async () => {
    assert.equal((await admin.del('/api/equipements/' + compresseur.id)).status, 400, 'possède un sous-équipement');
    const ot = srv.db.insert('ot', { titre: 'Remplacement roulement', equipementId: moteur.id, secteurId: prod.id, statut: 'nouveau', createdBy: 1 });
    const fiche = await admin.ok('GET', '/api/equipements/' + moteur.id);
    assert.equal(fiche.nbOtOuverts, 1);
    assert.equal(fiche.derniersOt.length, 1);
    assert.equal(fiche.derniersOt[0].titre, 'Remplacement roulement');
    assert.equal(fiche.references.ot, 1);
    const liste = await admin.ok('GET', '/api/equipements');
    assert.equal(liste.find((e) => e.id === moteur.id).nbOtOuverts, 1, 'nombre d\'OT ouverts dans la liste');

    const r = await admin.ok('DELETE', '/api/equipements/' + moteur.id);
    assert.equal(r.desactive, true, 'référencé par un OT → désactivé');
    assert.equal((await admin.ok('GET', '/api/equipements/' + moteur.id)).actif, false);
    assert.ok(!(await admin.ok('GET', '/api/equipements?actif=1')).some((e) => e.id === moteur.id));
    assert.ok((await admin.ok('GET', '/api/equipements?actif=0')).some((e) => e.id === moteur.id));
    const audit = await admin.ok('GET', '/api/audit?entite=equipements&action=desactivation');
    assert.ok(audit.lignes.some((l) => l.entiteId === moteur.id));

    srv.db.remove('ot', ot.id);
    const r2 = await admin.ok('DELETE', '/api/equipements/' + moteur.id);
    assert.equal(r2.desactive, false, 'plus référencé → supprimé');
    assert.equal((await admin.get('/api/equipements/' + moteur.id)).status, 404);
    assert.equal((await admin.del('/api/equipements/' + moteur.id)).status, 404);
  });

  test('droits : 403 pour un profil sans droit, lecture seule respectée', async () => {
    const dem = await creerUtilisateur('demandeur', 'Demandeur', []);
    assert.equal((await dem.get('/api/equipements')).status, 200, 'voir autorisé');
    assert.equal((await dem.get('/api/equipements-arbre')).status, 200);
    assert.equal((await dem.get('/api/equipements/' + compresseur.id)).status, 200);
    assert.equal((await dem.post('/api/equipements', { nom: 'Pirate', secteurId: prod.id })).status, 403, 'créer refusé');
    assert.equal((await dem.put('/api/equipements/' + compresseur.id, { nom: 'Pirate' })).status, 403, 'modifier refusé');
    assert.equal((await dem.put(`/api/equipements/${compresseur.id}/etat`, { etatCode: 'arret' })).status, 403);
    assert.equal((await dem.post(`/api/equipements/${compresseur.id}/compteur`, { valeur: 1 })).status, 403);
    assert.equal((await dem.post(`/api/equipements/${compresseur.id}/documents`, { nom: 'x.txt', contenu: 'data:text/plain;base64,YQ==' })).status, 403);
    assert.equal((await dem.del('/api/equipements/' + compresseur.id)).status, 403, 'supprimer refusé');
    assert.equal((await dem.post(`/api/equipements/${compresseur.id}/dupliquer`, {})).status, 403);
    assert.equal((await dem.get('/api/equipements-export')).status, 403, 'exporter refusé');

    const tech = await creerUtilisateur('techno', 'Technicien', [prod.id]);
    assert.equal((await tech.post('/api/equipements', { nom: 'Pirate', secteurId: prod.id })).status, 403, 'technicien : pas de création');
    assert.equal((await tech.get('/api/equipements-export')).status, 403, 'technicien : pas d\'export');
    assert.equal((await tech.get('/api/equipements')).status, 200);
  });

  test('portée par secteur : lecture, écriture et arbre limités aux secteurs de l\'utilisateur', async () => {
    const eqMaint = await admin.ok('POST', '/api/equipements', { nom: 'Pont roulant', secteurId: maint.id });
    const eqLog = await admin.ok('POST', '/api/equipements', { nom: 'Chariot élévateur', secteurId: log.id });
    const chef = await creerUtilisateur('chefprod', 'Chef de secteur', [prod.id]);

    const liste = await chef.ok('GET', '/api/equipements');
    assert.ok(liste.length >= 1 && liste.every((e) => e.secteurId === prod.id), 'uniquement les équipements de son secteur');
    assert.ok(liste.some((e) => e.id === compresseur.id));
    assert.equal((await chef.get('/api/equipements/' + eqMaint.id)).status, 404, 'hors portée → 404');
    assert.equal((await chef.get('/api/equipements/' + compresseur.id)).status, 200);
    assert.equal((await chef.put('/api/equipements/' + eqMaint.id, { nom: 'Pirate' })).status, 404);
    const majChef = await chef.put('/api/equipements/' + compresseur.id, { localisation: 'Hall A' });
    assert.equal(majChef.status, 200, 'modification dans son secteur : ' + JSON.stringify(majChef.body));
    assert.equal((await chef.put('/api/equipements/' + compresseur.id, { secteurId: maint.id })).status, 403, 'ne peut pas déplacer vers un secteur hors portée');
    assert.equal((await chef.put(`/api/equipements/${eqMaint.id}/etat`, { etatCode: 'arret' })).status, 404);
    assert.equal((await chef.post(`/api/equipements/${eqMaint.id}/compteur`, { valeur: 5 })).status, 404);
    assert.equal((await chef.get(`/api/equipements/${compresseur.id}/documents/0`)).status, 200);
    assert.equal((await chef.get(`/api/equipements/${eqMaint.id}/documents/0`)).status, 404);
    assert.equal((await chef.get('/api/equipements-export')).status, 403, 'chef de secteur : pas de droit exporter');

    const arbre = await chef.ok('GET', '/api/equipements-arbre');
    const nMaint = noeudSecteur(arbre, maint.id);
    assert.equal(nMaint.nbEquipements, 0, 'secteur hors portée vide dans l\'arbre');
    assert.ok(noeudSecteur(arbre, prod.id).nbEquipements >= 1);

    // Portée « perso » (demandeur) : équipements visibles par secteur de rattachement
    const demLog = await creerUtilisateur('demlog', 'Demandeur', [log.id]);
    const vus = await demLog.ok('GET', '/api/equipements');
    assert.ok(vus.some((e) => e.id === eqLog.id), 'voit les équipements de son secteur');
    assert.ok(!vus.some((e) => e.id === compresseur.id), 'ne voit pas les autres secteurs');
    assert.equal((await demLog.get('/api/equipements/' + compresseur.id)).status, 404);
    assert.equal((await demLog.get('/api/equipements/' + eqLog.id)).status, 200);

    // Droits « créer » / « exporter » accordés en surcharge : toujours limités à ses secteurs
    await admin.ok('PUT', '/api/utilisateurs/' + srv.db.findOne('users', (u) => u.login === 'chefprod').id, { overrides: { equipements: { creer: true, exporter: true } } });
    const chef2 = srv.client(); await chef2.login('chefprod', 'motdepasse1');
    const expChef = await chef2.get('/api/equipements-export');
    assert.equal(expChef.status, 200);
    assert.ok(String(expChef.body).includes(compresseur.numero) && !String(expChef.body).includes('Pont roulant'), 'export limité à la portée');
    assert.equal((await chef2.post('/api/equipements', { nom: 'Hors secteur', secteurId: maint.id })).status, 403);
    assert.equal((await chef2.post('/api/equipements', { nom: 'Hors secteur (parent)', parentId: eqMaint.id })).status, 403, 'parent hors portée');
    const ok = await chef2.post('/api/equipements', { nom: 'Dans mon secteur', secteurId: prod.id });
    assert.equal(ok.status, 200);
    await admin.ok('DELETE', '/api/equipements/' + ok.body.id);
    await admin.ok('DELETE', '/api/equipements/' + eqMaint.id);
    await admin.ok('DELETE', '/api/equipements/' + eqLog.id);
  });

  test('fiche enrichie : plans préventifs, demandes et articles compatibles liés', async () => {
    const plan = srv.db.insert('plansPreventifs', { numero: 'PP-001', nom: 'Vidange compresseur', equipementId: compresseur.id, secteurId: prod.id, periodicite: { type: 'compteur', valeur: 4000 }, prochaineEcheance: 4300, actif: true });
    const demande = srv.db.insert('demandes', { numero: 'DI-1', titre: 'Bruit anormal', equipementId: compresseur.id, secteurId: prod.id, statut: 'soumise', demandeurId: 1, prioriteCode: 'haute' });
    const article = srv.db.insert('articles', { code: 'ART-0001', designation: 'Filtre à huile', quantite: 2, seuilMin: 3, equipementIds: [compresseur.id], actif: true });
    const fiche = await admin.ok('GET', '/api/equipements/' + compresseur.id);
    assert.equal(fiche.plansPreventifs.length, 1);
    assert.equal(fiche.plansPreventifs[0].nom, 'Vidange compresseur');
    assert.equal(fiche.demandes.length, 1);
    assert.equal(fiche.nbDemandesOuvertes, 1);
    assert.equal(fiche.articlesCompatibles.length, 1);
    assert.equal(fiche.articlesCompatibles[0].designation, 'Filtre à huile');
    assert.deepEqual(fiche.references, { ot: 0, demandes: 1, plans: 1, articles: 1 });
    // Référencé par une demande et un plan → désactivation plutôt que suppression
    const r = await admin.ok('DELETE', '/api/equipements/' + compresseur.id);
    assert.equal(r.desactive, true);
    srv.db.remove('plansPreventifs', plan.id); srv.db.remove('demandes', demande.id); srv.db.remove('articles', article.id);
  });

  test('changement de secteur : les OT ouverts, plans préventifs et demandes ouvertes de l\'équipement suivent le nouveau secteur', async () => {
    const presse = await admin.ok('POST', '/api/equipements', { nom: 'Presse hydraulique 250 t', secteurId: prod.id });
    const verin = await admin.ok('POST', '/api/equipements', { nom: 'Vérin principal', parentId: presse.id });
    const otOuvert = srv.db.insert('ot', { numero: 'OT-SECT-1', titre: 'Reprise du joint de tige', statut: 'en_cours', equipementId: presse.id, secteurId: prod.id, pieces: [], createdBy: 1 });
    const otVerin = srv.db.insert('ot', { numero: 'OT-SECT-2', titre: 'Contrôle du vérin', statut: 'nouveau', equipementId: verin.id, secteurId: prod.id, pieces: [], createdBy: 1 });
    const otClos = srv.db.insert('ot', { numero: 'OT-SECT-3', titre: 'Ancienne intervention', statut: 'termine', equipementId: presse.id, secteurId: prod.id, pieces: [], createdBy: 1 });
    const plan = srv.db.insert('plansPreventifs', { numero: 'PP-SECT-1', nom: 'Contrôle réglementaire presse', equipementId: presse.id, secteurId: prod.id, periodicite: { type: 'mois', valeur: 12 }, actif: true });
    const diOuverte = srv.db.insert('demandes', { numero: 'DI-SECT-1', titre: 'Fuite d\'huile', equipementId: presse.id, secteurId: prod.id, statut: 'soumise', demandeurId: 1, prioriteCode: 'haute' });
    const diClose = srv.db.insert('demandes', { numero: 'DI-SECT-2', titre: 'Bruit (résolu)', equipementId: presse.id, secteurId: prod.id, statut: 'cloturee', demandeurId: 1, prioriteCode: 'basse' });
    const techLog = await creerUtilisateur('tech.log', 'Technicien', [log.id]);
    assert.equal((await techLog.get('/api/ot/' + otOuvert.id)).status, 404, 'avant : OT hors portée');
    assert.equal((await techLog.get('/api/preventif/' + plan.id)).status, 404, 'avant : plan hors portée');
    assert.equal((await techLog.get('/api/demandes/' + diOuverte.id)).status, 404, 'avant : demande hors portée');
    const evenements = [];
    srv.ctx.on('equipement:modifie', (d) => evenements.push(d));

    const maj = await admin.ok('PUT', '/api/equipements/' + presse.id, { secteurId: log.id });
    assert.equal(maj.secteurId, log.id);
    assert.equal(srv.db.get('equipements', verin.id).secteurId, log.id, 'sous-équipement déplacé avec le parent');
    assert.equal(srv.db.get('ot', otOuvert.id).secteurId, log.id, 'OT en cours rattaché au nouveau secteur');
    assert.equal(srv.db.get('ot', otVerin.id).secteurId, log.id, 'OT du sous-équipement déplacé aussi');
    assert.equal(srv.db.get('ot', otClos.id).secteurId, prod.id, 'OT clôturé : secteur de l\'époque conservé');
    assert.equal(srv.db.get('plansPreventifs', plan.id).secteurId, log.id, 'plan préventif rattaché au nouveau secteur');
    assert.equal(srv.db.get('demandes', diOuverte.id).secteurId, log.id, 'demande ouverte rattachée au nouveau secteur');
    assert.equal(srv.db.get('demandes', diClose.id).secteurId, prod.id, 'demande close conservée');
    assert.equal((await techLog.get('/api/ot/' + otOuvert.id)).status, 200, 'après : les techniciens du nouveau secteur voient l\'OT');
    assert.equal((await techLog.get('/api/preventif/' + plan.id)).status, 200, 'après : le plan est visible');
    assert.equal((await techLog.get('/api/demandes/' + diOuverte.id)).status, 200, 'après : la demande est visible');
    assert.equal((await techLog.ok('GET', '/api/equipements/' + presse.id)).nbOtOuverts, 1, 'fiche : OT en cours compté');
    assert.equal(evenements.length, 1, 'événement equipement:modifie émis');
    assert.deepEqual([evenements[0].secteur.ancien, evenements[0].secteur.nouveau, evenements[0].secteur.ot, evenements[0].secteur.plans, evenements[0].secteur.demandes], [prod.id, log.id, 2, 1, 1]);
    assert.deepEqual(evenements[0].secteur.equipementIds, [presse.id, verin.id]);
    const journal = srv.db.list('audit', (x) => x.action === 'modification' && /déplacement de l'équipement/.test(x.details));
    assert.equal(journal.length, 4, 'une entrée de journal par élément rattaché (2 OT, 1 plan, 1 demande)');
    assert.ok(srv.db.list('audit', (x) => x.entite === 'equipements' && x.entiteId === presse.id).some((x) => /2 OT, 1 plan\(s\) préventif\(s\), 1 demande\(s\)/.test(x.details)), 'bilan dans le journal de l\'équipement');
    // Sans changement de secteur : rien n'est touché
    await admin.ok('PUT', '/api/equipements/' + presse.id, { localisation: 'Hall B' });
    assert.equal(evenements.length, 2);
    assert.equal(evenements[1].secteur, null);
    assert.equal(srv.db.list('audit', (x) => /déplacement de l'équipement/.test(x.details)).length, 4);
    for (const [col, id] of [['ot', otOuvert.id], ['ot', otVerin.id], ['ot', otClos.id], ['plansPreventifs', plan.id], ['demandes', diOuverte.id], ['demandes', diClose.id]]) srv.db.remove(col, id);
    await admin.ok('DELETE', '/api/equipements/' + verin.id);
    await admin.ok('DELETE', '/api/equipements/' + presse.id);
  });

  test('numérotation : une création ou une duplication refusée ne consomme pas de numéro', async () => {
    const compteur = () => srv.db.data.meta.numeros.eq || 0;
    const premier = await admin.ok('POST', '/api/equipements', { nom: 'Numéroté', secteurId: prod.id });
    const n = compteur();
    assert.equal((await admin.post('/api/equipements', { nom: 'Sans secteur' })).status, 400);
    assert.equal((await admin.post('/api/equipements', { nom: 'Secteur inconnu', secteurId: 99999 })).status, 400);
    assert.equal((await admin.post('/api/equipements', { nom: 'Date invalide', secteurId: prod.id, garantieFin: 'demain' })).status, 400);
    assert.equal((await admin.post(`/api/equipements/${premier.id}/dupliquer`, { secteurId: 99999 })).status, 400, 'duplication refusée');
    assert.equal(compteur(), n, 'aucun numéro consommé par les créations refusées');
    const suivant = await admin.ok('POST', '/api/equipements', { nom: 'Numéroté suivant', secteurId: prod.id });
    assert.equal(compteur(), n + 1);
    const numeroDe = (s) => Number(String(s).replace(/\D/g, ''));
    assert.equal(numeroDe(suivant.numero), numeroDe(premier.numero) + 1, 'numéros consécutifs');
    await admin.ok('DELETE', '/api/equipements/' + suivant.id);
    await admin.ok('DELETE', '/api/equipements/' + premier.id);
  });

  test('relevé de compteur : seuls un nombre (ou une chaîne décimale) et une date AAAA-MM-JJ ou ISO sont acceptés', async () => {
    const eq = await admin.ok('POST', '/api/equipements', { nom: 'Compresseur relevés', secteurId: prod.id, compteur: { valeur: 18420, unite: 'heures' } });
    const refus = [
      [{ valeur: true }, 'booléen'], [{ valeur: [4321] }, 'tableau'], [{ valeur: '0x1F4' }, 'hexadécimal'], [{ valeur: '1e3' }, 'notation scientifique'], [{ valeur: { v: 1 } }, 'objet'],
      [{ valeur: 5000, date: true }, 'date booléenne'], [{ valeur: 5000, date: 12345 }, 'date numérique'], [{ valeur: 5000, date: '12/10/2026' }, 'date au format français'],
    ];
    for (const [body, msg] of refus) {
      const r = await admin.post(`/api/equipements/${eq.id}/compteur`, body);
      assert.equal(r.status, 400, `${msg} : ${JSON.stringify(r.body)}`);
    }
    const brut = srv.db.get('equipements', eq.id);
    assert.equal(brut.compteur.valeur, 18420, 'compteur intact après les refus');
    assert.equal(brut.compteurReleves.length, 1, 'aucun relevé fantôme');
    const r1 = await admin.ok('POST', `/api/equipements/${eq.id}/compteur`, { valeur: '18500,5' });
    assert.equal(r1.compteur.valeur, 18500.5, 'chaîne décimale avec virgule acceptée');
    const r2 = await admin.ok('POST', `/api/equipements/${eq.id}/compteur`, { valeur: 18450, date: '2025-01-15' });
    const releve = r2.compteurReleves.find((x) => x.valeur === 18450);
    assert.equal(new Date(releve.date).getFullYear(), 2025, 'relevé daté du jour demandé');
    assert.equal(r2.compteur.valeur, 18500.5, 'un relevé antérieur ne remplace pas la valeur courante');
    const r3 = await admin.ok('POST', `/api/equipements/${eq.id}/compteur`, { valeur: 18600, date: new Date().toISOString() });
    assert.equal(r3.compteur.valeur, 18600, 'horodatage ISO accepté (relevé le plus récent)');
    // Formulaire de création : mêmes règles pour le compteur et la valeur d'achat
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, compteur: { valeur: true } })).status, 400);
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, compteur: { valeur: '0x10' } })).status, 400);
    assert.equal((await admin.post('/api/equipements', { nom: 'X', secteurId: prod.id, valeurAchat: [12] })).status, 400);
    await admin.ok('DELETE', '/api/equipements/' + eq.id);
  });

  test('champs texte : booléens, tableaux et objets refusés (désignation, localisation, numéro, commentaires, documents)', async () => {
    const eq = await admin.ok('POST', '/api/equipements', { nom: 'Presse essai', secteurId: prod.id });
    const contenu = 'data:text/plain;base64,' + Buffer.from('x').toString('base64');
    const cas = [
      ['post', '/api/equipements', { nom: true, secteurId: prod.id }],
      ['post', '/api/equipements', { nom: 12, secteurId: prod.id }],
      ['post', '/api/equipements', { nom: 'X', secteurId: prod.id, localisation: true }],
      ['post', '/api/equipements', { nom: 'X', secteurId: prod.id, marque: ['Atlas'] }],
      ['post', '/api/equipements', { nom: 'X', secteurId: prod.id, numero: false }],
      ['post', '/api/equipements', { nom: 'X', secteurId: prod.id, compteur: { valeur: 1, unite: true } }],
      ['put', '/api/equipements/' + eq.id, { nom: 12 }],
      ['put', '/api/equipements/' + eq.id, { notes: { texte: 'x' } }],
      ['post', `/api/equipements/${eq.id}/dupliquer`, { nom: true }],
      ['put', `/api/equipements/${eq.id}/etat`, { etatCode: 'arret', commentaire: true }],
      ['post', `/api/equipements/${eq.id}/compteur`, { valeur: 10, commentaire: 123 }],
      ['post', `/api/equipements/${eq.id}/documents`, { nom: true, contenu }],
      ['post', `/api/equipements/${eq.id}/documents`, { nom: 'notice.txt', description: 42, contenu }],
    ];
    for (const [methode, url, body] of cas) {
      const r = await admin[methode](url, body);
      assert.equal(r.status, 400, `${methode.toUpperCase()} ${url} ${JSON.stringify(body)} : ${JSON.stringify(r.body)}`);
      assert.match(r.body.erreur, /texte attendu/, 'message explicite');
    }
    assert.equal(srv.db.count('equipements', (x) => ['true', '12', 'false'].includes(String(x.nom))), 0);
    assert.equal(srv.db.get('equipements', eq.id).nom, 'Presse essai');
    const num = await admin.ok('POST', '/api/equipements', { nom: 'Numéro de série numérique', secteurId: prod.id, numeroSerie: 20260042, numero: 778899 });
    assert.equal(num.numeroSerie, '20260042', 'un numéro de série numérique reste accepté');
    assert.equal(num.numero, '778899');
    await admin.ok('DELETE', '/api/equipements/' + num.id);
    await admin.ok('DELETE', '/api/equipements/' + eq.id);
  });

  test('garantie : évaluée sur le jour du calendrier local, pas sur le jour UTC', async () => {
    const { spawnSync } = require('node:child_process');
    // Fuseau choisi pour que le jour local diffère du jour UTC au moment du test (UTC+14 l'après-midi UTC, UTC−12 le matin)
    const tz = new Date().getUTCHours() >= 10 ? 'Etc/GMT-14' : 'Etc/GMT+12';
    const script = `
      const assert = require('node:assert/strict');
      const { demarrer } = require(${JSON.stringify(require.resolve('./helpers'))});
      const pad = (n) => String(n).padStart(2, '0');
      const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      (async () => {
        const srv = await demarrer();
        try {
          const c = srv.client(); await c.login('admin', 'admin');
          const prod = (await c.ok('GET', '/api/secteurs')).find((s) => s.code === 'PROD');
          const now = new Date();
          assert.notEqual(local(now), now.toISOString().slice(0, 10), 'le jour local doit différer du jour UTC');
          const hier = await c.ok('POST', '/api/equipements', { nom: 'Garantie finie hier', secteurId: prod.id, garantieFin: local(new Date(now.getTime() - 86400000)) });
          const auj = await c.ok('POST', '/api/equipements', { nom: 'Garantie valable ce jour', secteurId: prod.id, garantieFin: local(now) });
          assert.equal(hier.garantie, 'expiree', 'échue la veille (jour local)');
          assert.equal(auj.garantie, 'valide', 'échéance du jour (jour local)');
        } finally { await srv.stop(); }
      })().catch((e) => { console.error(e && e.message); process.exit(1); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `TZ=${tz} : ${r.stderr || r.stdout}`);
  });

  test('données de démonstration idempotentes', async () => {
    const mod = require('../server/modules/equipements');
    const avant = srv.db.count('equipements');
    const r1 = mod.seedDemo(srv.ctx);
    assert.match(r1, /équipements/);
    const apres = srv.db.count('equipements');
    assert.ok(apres - avant >= 12, 'au moins 12 équipements de démonstration');
    assert.equal(mod.seedDemo(srv.ctx), 'déjà présents');
    assert.equal(srv.db.count('equipements'), apres, 'second appel sans doublon');
    const liste = await admin.ok('GET', '/api/equipements?inactifs=1');
    const types = new Set(srv.ctx.liste('typesEquipement').map((t) => t.code));
    const etats = new Set(srv.ctx.liste('etatsEquipement').map((t) => t.code));
    const crit = new Set(srv.ctx.liste('criticites').map((t) => t.code));
    for (const e of liste) {
      assert.ok(e.numero && e.nom && types.has(e.typeCode) && etats.has(e.etatCode) && crit.has(e.criticiteCode), 'codes de listes valides : ' + e.nom);
      assert.ok(e.secteurId != null, 'secteur renseigné : ' + e.nom);
    }
    const numeros = liste.map((e) => e.numero);
    assert.equal(new Set(numeros).size, numeros.length, 'numéros uniques');
    const ligne = liste.find((e) => /Ligne de conditionnement/.test(e.nom));
    assert.ok(ligne && ligne.nbEnfants >= 3, 'ligne avec sous-équipements');
    const arbre = await admin.ok('GET', '/api/equipements-arbre');
    assert.ok(arbre.reduce((s, n) => s + n.nbEquipements, 0) >= 12);
    const compDemo = liste.find((e) => e.nom === 'Compresseur d\'air GA 37');
    const fiche = await admin.ok('GET', '/api/equipements/' + compDemo.id);
    assert.ok(fiche.photoIndex >= 0 && fiche.documents.length === 2, 'photo et consigne jointes');
    assert.ok(fiche.compteurReleves.length >= 3, 'historique de compteur');
  });
});
