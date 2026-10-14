'use strict';
/**
 * Test d'intégration de bout en bout (API) : vérifie que les modules métier dialoguent
 * correctement entre eux (contrats de services et d'événements de docs/ARCHITECTURE.md §6),
 * sur les données de démonstration.
 *
 * Scénario principal (DI → OT → stock → clôture) :
 *   spetit (demandeur) signale une panne → pmartin (chef de secteur, N+1) valide → un OT est créé
 *   automatiquement → mdupont (responsable maintenance) l'affecte à jbernard (notification) →
 *   jbernard démarre, saisit son temps, consomme une pièce (stock décrémenté, mouvement créé) et
 *   clôture avec un compte rendu → la DI est clôturée, les coûts sont calculés, le tableau de bord
 *   et les rapports reflètent l'OT.
 * Scénario préventif : plan → génération (sans doublon) → réalisation → échéance recalculée.
 * Portée « perso » : un technicien limité à ses propres OT ne voit pas ceux des autres.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');
const { seedDemo } = require('../server/modules');

/** Date locale AAAA-MM-JJ (décalage de n jours). */
function jour(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const arrondi = (x) => Math.round(x * 100) / 100;

test.describe('Intégration des modules métier', () => {
  let srv; let db; let ctx;
  const c = {};
  const u = {};
  const etat = {};

  test.before(async () => {
    srv = await demarrer();
    db = srv.db; ctx = srv.ctx;
    const rapport = seedDemo(ctx);
    const echecs = rapport.filter((r) => !r.ok);
    assert.deepEqual(echecs, [], 'tous les seeds de démonstration doivent réussir');
    for (const login of ['spetit', 'pmartin', 'mdupont', 'jbernard', 'kleroy']) {
      u[login] = db.findOne('users', (x) => x.login === login);
      assert.ok(u[login], `utilisateur de démonstration ${login} présent`);
      c[login] = srv.client();
      await c[login].login(login, 'demo');
    }
    c.admin = srv.client();
    await c.admin.login('admin', 'admin');
  });
  test.after(async () => { await srv.stop(); });

  test('données de démonstration : idempotentes et liées entre elles', () => {
    const avant = Object.fromEntries(Object.entries(db.data.collections).map(([k, v]) => [k, v.length]));
    const r = seedDemo(ctx);
    assert.ok(r.every((x) => x.ok), 'second chargement sans erreur');
    for (const [col, n] of Object.entries(db.data.collections)) {
      if (col === 'audit' || col === 'notifications') continue;
      assert.equal(n.length, avant[col], `collection ${col} inchangée au second chargement`);
    }
    // OT liés à des équipements existants (secteur repris de l'équipement)
    const ots = db.list('ot');
    assert.ok(ots.length >= 10);
    for (const o of ots) {
      const e = db.get('equipements', o.equipementId);
      assert.ok(e, `OT ${o.numero} lié à un équipement`);
      assert.equal(o.secteurId, e.secteurId, `OT ${o.numero} : secteur de l'équipement`);
    }
    // Demandes converties / clôturées liées à des OT, lien réciproque
    const liees = db.list('demandes', (d) => d.otId != null);
    assert.ok(liees.length >= 3);
    for (const d of liees) {
      const o = db.get('ot', d.otId);
      assert.ok(o, `DI ${d.numero} → OT existant`);
      assert.equal(o.demandeId, d.id, `OT ${o.numero} → DI ${d.numero}`);
    }
    for (const d of db.list('demandes', (x) => ['convertie', 'cloturee'].includes(x.statut))) assert.ok(d.otId != null, `DI ${d.numero} (${d.statut}) liée à un OT`);
    // Pièces consommées par les OT gérés dans la GMAO liées à des sorties de stock (hors historique repris)
    let nbPieces = 0;
    for (const o of ots.filter((x) => x.origine !== 'reprise')) {
      for (const p of o.pieces || []) {
        nbPieces++;
        const m = db.get('mouvementsStock', p.mouvementId);
        assert.ok(m, `OT ${o.numero} : pièce ${p.designation} liée à un mouvement`);
        assert.equal(m.type, 'sortie');
        assert.equal(m.otId, o.id);
        assert.equal(m.articleId, p.articleId);
      }
    }
    assert.ok(nbPieces >= 3, 'des pièces ont été consommées');
    for (const m of db.list('mouvementsStock', (x) => x.otId != null)) assert.ok(db.get('ot', m.otId), `mouvement ${m.id} → OT existant`);
    // Plans préventifs liés à des équipements, OT préventifs liés à leur plan
    const plans = db.list('plansPreventifs');
    assert.ok(plans.length >= 3);
    for (const p of plans) assert.ok(db.get('equipements', p.equipementId), `plan ${p.numero} lié à un équipement`);
    assert.ok(ots.some((o) => o.planPreventifId != null && db.get('plansPreventifs', o.planPreventifId)), 'au moins un OT issu d\'un plan');
  });

  test('scénario complet : demande → validation N+1 → OT → affectation → réalisation → clôture', async () => {
    // Équipement de la production (secteur de spetit, pmartin et jbernard) et pièce compatible en stock
    const prod = db.findOne('secteurs', (s) => s.code === 'PROD');
    const sousProd = new Set(db.list('secteurs').filter((s) => s.id === prod.id || s.parentId === prod.id).map((s) => s.id));
    const eq = db.findOne('equipements', (e) => e.actif !== false && sousProd.has(e.secteurId) && e.nom === 'Convoyeur de sortie ligne 1')
      || db.findOne('equipements', (e) => e.actif !== false && sousProd.has(e.secteurId));
    assert.ok(eq, 'équipement de production disponible');
    const art = db.findOne('articles', (a) => a.actif !== false && a.secteurId == null && Number(a.quantite) >= 3);
    assert.ok(art, 'article en stock');
    etat.eq = eq; etat.art = art;
    const qteAvant = Number(art.quantite);

    // Validation réservée au supérieur hiérarchique (N+1)
    await c.admin.ok('PUT', '/api/configuration', { workflow: { validerParSuperieurUniquement: true, otAutoDepuisDemande: true, cloturerDemandeAvecOt: true } });
    assert.equal(u.spetit.managerId, u.pmartin.id, 'pmartin est le N+1 de spetit');

    // 1. spetit crée la demande
    const nbNotifPmartin = db.count('notifications', (n) => n.userId === u.pmartin.id);
    const di = await c.spetit.ok('POST', '/api/demandes', {
      titre: 'Bruit de roulement sur le convoyeur (test d\'intégration)', description: 'Bruit métallique côté moteur depuis ce matin.',
      equipementId: eq.id, prioriteCode: 'haute', typeCode: 'correctif', arretProduction: false,
    });
    assert.equal(di.statut, 'soumise');
    assert.equal(di.demandeurId, u.spetit.id);
    assert.equal(di.secteurId, eq.secteurId, 'secteur repris de l\'équipement');
    assert.ok(db.count('notifications', (n) => n.userId === u.pmartin.id) > nbNotifPmartin, 'le valideur (N+1) est notifié');
    etat.diId = di.id;

    // Un demandeur ne voit pas les OT ; un autre valideur que le N+1 est refusé
    assert.equal((await c.spetit.get('/api/ot')).status, 403);
    assert.equal((await c.mdupont.post(`/api/demandes/${di.id}/valider`, {})).status, 403, 'seul le N+1 valide');
    assert.equal((await c.spetit.post(`/api/demandes/${di.id}/valider`, {})).status, 403, 'le demandeur ne valide pas');

    // 2. pmartin valide → OT créé automatiquement
    const val = await c.pmartin.ok('POST', `/api/demandes/${di.id}/valider`, { commentaire: 'OK, intervention à prévoir aujourd\'hui' });
    assert.equal(val.statut, 'convertie');
    assert.ok(val.otId != null, 'OT créé automatiquement');
    const ot0 = db.get('ot', val.otId);
    assert.equal(ot0.demandeId, di.id);
    assert.equal(ot0.equipementId, eq.id);
    assert.equal(ot0.secteurId, eq.secteurId);
    assert.equal(ot0.typeCode, 'correctif');
    assert.equal(ot0.prioriteCode, 'haute');
    assert.equal(ot0.statut, ctx.liste('statutsOT')[0].code, 'statut initial de la liste');
    etat.otId = ot0.id;
    assert.ok(db.findOne('notifications', (n) => n.userId === u.spetit.id && /valid/i.test(n.titre)), 'le demandeur est informé de la validation');
    assert.ok(db.findOne('audit', (a) => a.entite === 'demandes' && a.entiteId === di.id && a.action === 'validation'));

    // 3. mdupont affecte à jbernard (notification) ; jbernard ne peut pas s'auto-affecter un autre technicien
    assert.equal((await c.jbernard.post(`/api/ot/${ot0.id}/affecter`, { technicienId: u.kleroy.id })).status, 403);
    const aff = await c.mdupont.ok('POST', `/api/ot/${ot0.id}/affecter`, { technicienId: u.jbernard.id, datePrevue: jour(0), dureeEstimee: 2 });
    assert.equal(aff.technicienId, u.jbernard.id);
    assert.equal(aff.statut, 'planifie', 'OT affecté et daté → planifié');
    const notif = db.findOne('notifications', (n) => n.userId === u.jbernard.id && n.lien === `#/ot/${ot0.id}`);
    assert.ok(notif, 'jbernard est notifié de l\'affectation');
    const nb = await c.jbernard.ok('GET', '/api/notifications');
    assert.ok(nb.notifications.some((n) => n.lien === `#/ot/${ot0.id}`));
    const dashTech = await c.jbernard.ok('GET', '/api/dashboard');
    assert.ok(dashTech.listes.mesOT.some((o) => o.id === ot0.id), 'l\'OT apparaît dans « mes OT » du technicien');

    // 4. jbernard démarre, saisit son temps, consomme une pièce
    const dem = await c.jbernard.ok('POST', `/api/ot/${ot0.id}/statut`, { statut: 'en_cours' });
    assert.equal(dem.statut, 'en_cours');
    assert.ok(dem.dateDebut);
    await c.jbernard.ok('POST', `/api/ot/${ot0.id}/temps`, { date: jour(0), heures: 2.5, commentaire: 'Diagnostic et remplacement du roulement' });
    const avecPiece = await c.jbernard.ok('POST', `/api/ot/${ot0.id}/pieces`, { articleId: art.id, quantite: 2 });
    assert.equal(avecPiece.pieces.length, 1);
    const piece = avecPiece.pieces[0];
    assert.equal(db.get('articles', art.id).quantite, qteAvant - 2, 'le stock diminue');
    const mvt = db.get('mouvementsStock', piece.mouvementId);
    assert.ok(mvt, 'un mouvement de stock est créé');
    assert.equal(mvt.type, 'sortie');
    assert.equal(mvt.otId, ot0.id);
    assert.equal(mvt.quantite, 2);
    assert.equal(mvt.quantiteAvant, qteAvant);
    assert.equal(mvt.quantiteApres, qteAvant - 2);
    const mvts = await c.jbernard.ok('GET', `/api/mouvements?otId=${ot0.id}`);
    const lignesMvt = Array.isArray(mvts) ? mvts : (mvts.mouvements || mvts.lignes || []);
    assert.ok(lignesMvt.some((m) => m.id === mvt.id), 'le mouvement est consultable dans le stock');
    // Une quantité supérieure au stock est refusée (stock négatif interdit par défaut)
    assert.equal((await c.jbernard.post(`/api/ot/${ot0.id}/pieces`, { articleId: art.id, quantite: 100000 })).status, 400);

    // 5. jbernard clôture avec un compte rendu
    assert.equal((await c.jbernard.post(`/api/ot/${ot0.id}/cloturer`, {})).status, 400, 'compte rendu obligatoire');
    const clos = await c.jbernard.ok('POST', `/api/ot/${ot0.id}/cloturer`, { rapport: 'Roulement côté moteur remplacé, alignement contrôlé, essai en charge OK.', causeCode: 'usure' });
    assert.equal(clos.statut, 'termine');
    assert.equal(clos.cloturePar, u.jbernard.id);
    assert.ok(clos.dateFin && clos.dateCloture);
    const taux = Number(ctx.config().general.tauxHoraire);
    const o = db.get('ot', ot0.id);
    assert.equal(o.coutMainOeuvre, arrondi(2.5 * taux), 'main-d\'œuvre = heures × taux horaire');
    assert.equal(o.coutPieces, arrondi(2 * Number(piece.prixUnitaire)), 'coût des pièces');
    assert.equal(o.coutTotal, arrondi(o.coutMainOeuvre + o.coutPieces + (Number(o.coutExterne) || 0)));
    etat.coutTotal = o.coutTotal;
    assert.ok(db.findOne('audit', (a) => a.entite === 'ot' && a.entiteId === ot0.id && a.action === 'cloture'));
    // Plus de pièce ni de temps sur un OT clôturé
    assert.equal((await c.jbernard.post(`/api/ot/${ot0.id}/temps`, { heures: 1 })).status, 400);

    // 6. La demande est clôturée automatiquement et le demandeur informé
    const diFin = await c.spetit.ok('GET', `/api/demandes/${di.id}`);
    assert.equal(diFin.statut, 'cloturee');
    assert.equal(diFin.otId, ot0.id);
    assert.ok(db.findOne('notifications', (n) => n.userId === u.spetit.id && n.lien === `#/demandes/${di.id}` && /cl[ôo]tur/i.test(n.titre)));
  });

  test('tableau de bord et rapports reflètent l\'OT clôturé', async () => {
    assert.ok(etat.otId, 'scénario précédent exécuté');
    const o = db.get('ot', etat.otId);
    // Tableau de bord (responsable maintenance, portée « tous »)
    const dash = await c.mdupont.ok('GET', '/api/dashboard');
    assert.ok(dash.kpis.otTerminesMois >= 1);
    assert.ok(dash.kpis.heuresMois >= 2.5);
    assert.ok(dash.kpis.coutMois >= etat.coutTotal);
    assert.ok(dash.listes.dernieresActivites.some((a) => a.entite === 'ot' && a.entiteId === o.id), 'activité récente de l\'OT');
    // Le tableau de bord n'expose au demandeur que son périmètre
    const dashDem = await c.spetit.ok('GET', '/api/dashboard');
    assert.equal(dashDem.sections.ot, false, 'pas de section OT pour un demandeur');

    // Rapports : synthèse filtrée sur l'équipement et la période du jour
    const q = `du=${jour(0)}&au=${jour(0)}&equipementId=${etat.eq.id}`;
    const syn = await c.mdupont.ok('GET', `/api/rapports/synthese?${q}`);
    assert.ok(syn.ot.termines >= 1, 'OT terminé compté');
    assert.ok(syn.couts.total >= etat.coutTotal - 0.01, 'coûts agrégés');
    assert.ok(syn.couts.pieces >= o.coutPieces - 0.01);
    assert.ok(syn.couts.mainOeuvre >= o.coutMainOeuvre - 0.01);
    assert.ok(syn.stock.nbSorties >= 1, 'sortie de stock comptée');
    assert.ok(syn.demandes.total >= 1, 'demande comptée');
    // Historique et fiche de vie de l'équipement
    const hist = await c.mdupont.ok('GET', `/api/rapports/historique?${q}`);
    const lignes = Array.isArray(hist) ? hist : (hist.lignes || hist.ot || hist.interventions || []);
    assert.ok(lignes.some((l) => l.id === o.id || l.otId === o.id || l.numero === o.numero), 'OT présent dans l\'historique');
    const vie = await c.mdupont.ok('GET', `/api/rapports/equipement/${etat.eq.id}`);
    assert.ok(JSON.stringify(vie).includes(o.numero), 'OT présent dans la fiche de vie de l\'équipement');
    // Droits : un technicien n'a pas accès aux rapports
    assert.equal((await c.jbernard.get('/api/rapports/synthese')).status, 403);
  });

  test('fiche équipement : les données des autres modules respectent les droits et la portée', async () => {
    const id = etat.eq.id;
    const pourDemandeur = await c.spetit.ok('GET', `/api/equipements/${id}`);
    assert.deepEqual(pourDemandeur.derniersOt, [], 'pas d\'OT sans le droit ot.voir');
    assert.equal(pourDemandeur.nbOtTotal, 0);
    assert.deepEqual(pourDemandeur.articlesCompatibles, [], 'pas de pièces (prix) sans le droit stock.voir');
    assert.deepEqual(pourDemandeur.plansPreventifs, [], 'pas de plans sans le droit preventif.voir');
    assert.ok(pourDemandeur.demandes.length >= 1, 'le demandeur voit ses demandes sur l\'équipement');
    assert.ok(pourDemandeur.demandes.every((d) => d.demandeurId === u.spetit.id), 'uniquement les siennes (portée « perso »)');
    const pourTech = await c.jbernard.ok('GET', `/api/equipements/${id}`);
    assert.ok(pourTech.derniersOt.some((o) => o.id === etat.otId), 'le technicien voit l\'historique des OT');
    assert.ok(pourTech.articlesCompatibles.length >= 0);
    // Les demandes listées pour le demandeur ne pointent pas vers des fiches inaccessibles
    const liste = await c.spetit.ok('GET', '/api/demandes');
    assert.ok(liste.every((d) => d.equipementId == null || typeof d.equipementVisible === 'boolean'));
  });

  test('préventif : plan → génération sans doublon → réalisation → échéance recalculée', async () => {
    const eq = db.findOne('equipements', (e) => e.nom === 'Étiqueteuse') || etat.eq;
    const plan = await c.mdupont.ok('POST', '/api/preventif', {
      nom: 'Contrôle mensuel de l\'étiqueteuse (test d\'intégration)', equipementId: eq.id,
      periodicite: { type: 'jours', valeur: 30 }, prochaineEcheance: jour(0), technicienId: u.jbernard.id,
      gamme: [{ libelle: 'Nettoyer les rouleaux encolleurs', duree: 0.5 }, { libelle: 'Contrôler la cellule de détection', duree: 0.5 }],
    });
    assert.equal(plan.equipementId, eq.id);
    assert.equal(plan.secteurId, eq.secteurId);
    // Un technicien ne peut pas créer de plan
    assert.equal((await c.jbernard.post('/api/preventif', { nom: 'Plan interdit', equipementId: eq.id, periodicite: { type: 'jours', valeur: 7 } })).status, 403);

    const gen = await c.mdupont.ok('POST', `/api/preventif/${plan.id}/generer`, {});
    const otId = gen.ot.id;
    const ot = db.get('ot', otId);
    assert.equal(ot.planPreventifId, plan.id);
    assert.equal(ot.equipementId, eq.id);
    assert.equal(ot.technicienId, u.jbernard.id);
    assert.equal(ot.taches.length, 2, 'gamme copiée dans les tâches');
    // Pas de doublon : ni par le service, ni par une nouvelle génération du plan
    const s = ctx.services.preventif;
    s.generer();
    assert.equal(db.count('ot', (x) => x.planPreventifId === plan.id), 1, 'aucun doublon généré par le service');
    assert.equal((await c.mdupont.post(`/api/preventif/${plan.id}/generer`, {})).status, 400, 'génération refusée tant qu\'un OT est ouvert');
    assert.ok(ctx.services.ot.ouvertsPour({ planPreventifId: plan.id }).some((x) => x.id === otId));

    // Réalisation par jbernard
    await c.jbernard.ok('POST', `/api/ot/${otId}/statut`, { statut: 'en_cours' });
    await c.jbernard.ok('PUT', `/api/ot/${otId}/taches/0`, { fait: true });
    await c.jbernard.ok('PUT', `/api/ot/${otId}/taches/1`, { fait: true });
    await c.jbernard.ok('POST', `/api/ot/${otId}/temps`, { heures: 1, commentaire: 'Gamme réalisée' });
    const clos = await c.jbernard.ok('POST', `/api/ot/${otId}/cloturer`, { rapport: 'Gamme mensuelle réalisée sans anomalie.' });
    assert.equal(clos.statut, 'termine');

    const maj = db.get('plansPreventifs', plan.id);
    assert.equal(maj.derniereExecution, jour(0), 'dernière exécution = date de réalisation');
    assert.equal(maj.prochaineEcheance, jour(30), 'prochaine échéance = réalisation + 30 jours');
    assert.equal(maj.dernierOtId, otId);
    const fiche = await c.mdupont.ok('GET', `/api/preventif/${plan.id}`);
    assert.equal(fiche.prochaineEcheance, jour(30));
    // Le planning voit le plan (échéance future) et l'OT réalisé
    const planning = await c.mdupont.ok('GET', `/api/planning?du=${jour(-1)}&au=${jour(35)}`);
    const txt = JSON.stringify(planning);
    assert.ok(txt.includes(ot.numero), 'OT préventif présent dans le planning');
    assert.ok(txt.includes(`"planId":${plan.id}`) || txt.includes(`"planPreventifId":${plan.id}`) || txt.includes(plan.numero), 'échéance du plan présente dans le planning');
  });

  test('OT ↔ stock ↔ équipements : retour en stock, alerte de seuil, relevé de compteur et préventif sur compteur', async () => {
    // Plan préventif sur compteur (heures de marche) de la démonstration
    const plan = db.findOne('plansPreventifs', (p) => p.periodicite && p.periodicite.type === 'compteur' && p.actif !== false);
    assert.ok(plan, 'plan sur compteur présent dans la démonstration');
    const eq = db.get('equipements', plan.equipementId);
    let ot = ctx.services.ot.ouvertsPour({ planPreventifId: plan.id })[0];
    if (!ot) ot = db.get('ot', (await c.mdupont.ok('POST', `/api/preventif/${plan.id}/generer`, {})).ot.id);
    assert.equal(ot.planPreventifId, plan.id);
    if (ot.statut !== 'en_cours') await c.mdupont.ok('POST', `/api/ot/${ot.id}/statut`, { statut: 'en_cours' });

    // Sortie puis retour en stock (annulation de la ligne de pièce)
    const a1 = db.findOne('articles', (a) => a.actif !== false && Number(a.quantite) >= Number(a.seuilMin) + 2);
    const q1 = Number(a1.quantite);
    const avec = await c.mdupont.ok('POST', `/api/ot/${ot.id}/pieces`, { articleId: a1.id, quantite: 1 });
    const ligne = avec.pieces.find((p) => p.articleId === a1.id);
    assert.equal(db.get('articles', a1.id).quantite, q1 - 1);
    await c.mdupont.ok('DELETE', `/api/ot/${ot.id}/pieces/${ligne.index}`);
    assert.equal(db.get('articles', a1.id).quantite, q1, 'quantité restaurée');
    const retour = db.findOne('mouvementsStock', (m) => m.type === 'retour' && m.articleId === a1.id && m.otId === ot.id);
    assert.ok(retour, 'mouvement de retour créé');
    assert.equal(db.get('mouvementsStock', ligne.mouvementId).annuleParId, retour.id, 'sortie marquée annulée');
    assert.equal(db.get('ot', ot.id).pieces.filter((p) => p.articleId === a1.id).length, 0);

    // Passage sous le seuil → notification des gestionnaires de stock (droit stock.modifier)
    const a2 = db.findOne('articles', (a) => a.actif !== false && Number(a.seuilMin) >= 1 && Number(a.quantite) > Number(a.seuilMin));
    const qte = Number(a2.quantite) - Number(a2.seuilMin) + 1;
    const nbAvant = db.count('notifications', (n) => n.userId === u.jbernard.id);
    await c.mdupont.ok('POST', `/api/ot/${ot.id}/pieces`, { articleId: a2.id, quantite: qte });
    assert.ok(Number(db.get('articles', a2.id).quantite) < Number(a2.seuilMin));
    assert.ok(db.count('notifications', (n) => n.userId === u.jbernard.id) > nbAvant, 'technicien (stock.modifier) alerté');
    const alertes = await c.mdupont.ok('GET', '/api/stock-alertes');
    assert.ok(JSON.stringify(alertes).includes(a2.designation.slice(0, 20)), 'article en alerte de stock');

    // Clôture avec relevé de compteur → compteur de l'équipement et échéance du plan mis à jour
    const releve = Number(plan.prochaineEcheance) + 10;
    assert.equal((await c.mdupont.post(`/api/ot/${ot.id}/cloturer`, { rapport: 'Vidange réalisée', compteurReleve: Number(eq.compteur.valeur) - 1000 })).status, 400, 'relevé inférieur au compteur refusé');
    await c.mdupont.ok('POST', `/api/ot/${ot.id}/cloturer`, { rapport: 'Vidange et filtre à huile remplacés.', compteurReleve: releve });
    assert.equal(db.get('equipements', eq.id).compteur.valeur, releve, 'compteur de l\'équipement relevé');
    const maj = db.get('plansPreventifs', plan.id);
    assert.equal(Number(maj.derniereExecution), releve);
    assert.equal(Number(maj.prochaineEcheance), releve + Number(plan.periodicite.valeur), 'prochaine échéance = relevé + périodicité');
  });

  test('OT annulé → la demande redevient validée et peut être reconvertie', async () => {
    const di = await c.spetit.ok('POST', '/api/demandes', { titre: 'Capot de protection desserré (test d\'intégration)', equipementId: etat.eq.id, prioriteCode: 'normale', typeCode: 'securite' });
    const val = await c.pmartin.ok('POST', `/api/demandes/${di.id}/valider`, {});
    assert.equal(val.statut, 'convertie');
    await c.mdupont.ok('POST', `/api/ot/${val.otId}/statut`, { statut: 'annule', commentaire: 'Doublon avec une intervention planifiée' });
    const apres = db.get('demandes', di.id);
    assert.equal(apres.statut, 'validee', 'retour au statut validée');
    assert.equal(apres.otId, null);
    const conv = await c.pmartin.ok('POST', `/api/demandes/${di.id}/convertir`, {});
    assert.equal(conv.statut, 'convertie');
    assert.ok(conv.otId != null && conv.otId !== val.otId, 'nouvel OT');
    assert.equal(db.get('ot', conv.otId).demandeId, di.id);
  });

  test('options de workflow : sans validation, sans OT automatique, sans clôture liée', async () => {
    const wf = (o) => c.admin.ok('PUT', '/api/configuration', { workflow: o });
    const eqId = etat.eq.id;
    try {
      // Circuit de validation désactivé : la demande est validée et convertie dès sa soumission
      await wf({ validationDemandes: false, otAutoDepuisDemande: true });
      const d1 = await c.spetit.ok('POST', '/api/demandes', { titre: 'Éclairage du poste défaillant (sans validation)', equipementId: eqId, prioriteCode: 'basse', typeCode: 'correctif' });
      assert.equal(d1.statut, 'convertie', 'demande convertie immédiatement');
      assert.ok(d1.otId != null && db.get('ot', d1.otId).demandeId === d1.id);

      // Validation sans création automatique d'OT, puis conversion manuelle
      await wf({ validationDemandes: true, otAutoDepuisDemande: false, cloturerDemandeAvecOt: false });
      const d2 = await c.spetit.ok('POST', '/api/demandes', { titre: 'Carter de chaîne qui vibre (conversion manuelle)', equipementId: eqId, prioriteCode: 'normale', typeCode: 'correctif' });
      const v2 = await c.pmartin.ok('POST', `/api/demandes/${d2.id}/valider`, {});
      assert.equal(v2.statut, 'validee');
      assert.equal(v2.otId, null, 'pas d\'OT automatique');
      assert.equal((await c.spetit.post(`/api/demandes/${d2.id}/convertir`, {})).status, 403, 'la conversion exige le droit ot.creer');
      const conv = await c.pmartin.ok('POST', `/api/demandes/${d2.id}/convertir`, {});
      assert.equal(conv.statut, 'convertie');
      // Clôture de l'OT sans clôture automatique de la demande
      await c.mdupont.ok('POST', `/api/ot/${conv.otId}/statut`, { statut: 'en_cours' });
      await c.mdupont.ok('POST', `/api/ot/${conv.otId}/cloturer`, { rapport: 'Carter resserré, vibration supprimée.' });
      assert.equal(db.get('demandes', d2.id).statut, 'convertie', 'la demande reste ouverte (option désactivée)');
      const fin = await c.spetit.ok('POST', `/api/demandes/${d2.id}/cloturer`, { commentaire: 'Réparation constatée' });
      assert.equal(fin.statut, 'cloturee', 'le demandeur clôture lui-même sa demande');
    } finally {
      await wf({ validationDemandes: true, otAutoDepuisDemande: true, cloturerDemandeAvecOt: true });
    }
  });

  test('portée « perso » : un technicien limité à ses propres OT ne voit pas ceux des autres', async () => {
    const tech = db.findOne('profils', (p) => p.nom === 'Technicien');
    const cree = await c.admin.ok('POST', '/api/utilisateurs', {
      login: 'tperso', nom: 'Perso', prenom: 'Thomas', profilId: tech.id, secteurIds: [db.findOne('secteurs', (s) => s.code === 'PROD').id],
      porteeOverride: 'perso', password: 'perso1234', doitChangerMdp: false,
    });
    const cp = srv.client();
    await cp.login('tperso', 'perso1234');
    const eq = etat.eq;
    // Un OT qui lui est affecté, un autre qui ne l'est pas (même secteur)
    const a = await c.mdupont.ok('POST', '/api/ot', { titre: 'OT affecté à Thomas', equipementId: eq.id, technicienId: cree.id, typeCode: 'correctif' });
    const b = await c.mdupont.ok('POST', '/api/ot', { titre: 'OT d\'un autre technicien', equipementId: eq.id, technicienId: u.kleroy.id, typeCode: 'correctif' });
    etat.otPerso = a; etat.tperso = cree;
    const liste = await cp.ok('GET', '/api/ot');
    const lignes = Array.isArray(liste) ? liste : (liste.lignes || liste.ot || []);
    const ids = lignes.map((x) => x.id);
    assert.ok(ids.includes(a.id), 'son OT est visible');
    assert.ok(!ids.includes(b.id), 'l\'OT d\'un autre est invisible');
    assert.ok(lignes.every((x) => x.technicienId === cree.id || (x.techniciens || []).includes(cree.id) || x.createdBy === cree.id), 'seulement ses OT');
    assert.equal((await cp.get(`/api/ot/${b.id}`)).status, 404, 'fiche d\'un autre OT : introuvable');
    assert.equal((await cp.post(`/api/ot/${b.id}/temps`, { heures: 1 })).status, 404, 'pas de saisie sur l\'OT d\'un autre');
    // Le planning et le tableau de bord respectent aussi la portée
    const pl = JSON.stringify(await cp.ok('GET', `/api/planning?du=${jour(-60)}&au=${jour(60)}`));
    assert.ok(!pl.includes(b.numero), 'planning limité à ses OT');
    const dash = await cp.ok('GET', '/api/dashboard');
    assert.ok(dash.kpis.otOuverts <= ids.length, 'tableau de bord limité à ses OT');
    // Un technicien en portée « secteurs » ne voit pas un OT d'un secteur hors de son périmètre
    const qual = db.findOne('secteurs', (s) => s.code === 'QUAL');
    const eqQual = db.findOne('equipements', (e) => e.secteurId === qual.id);
    if (eqQual) {
      const oq = await c.mdupont.ok('POST', '/api/ot', { titre: 'OT du laboratoire qualité', equipementId: eqQual.id, typeCode: 'correctif' });
      assert.equal((await c.jbernard.get(`/api/ot/${oq.id}`)).status, 404, 'hors des secteurs de jbernard');
      assert.equal((await c.kleroy.get(`/api/ot/${oq.id}`)).status, 404, 'hors des secteurs de kleroy');
    }
  });

  test('planning ↔ OT : replanification (droit planning.modifier), statut planifié, notification', async () => {
    const o = etat.otPerso;
    assert.ok(o, 'OT du test précédent');
    assert.equal((await c.jbernard.put(`/api/planning/ot/${o.id}`, { datePrevue: jour(1) })).status, 403, 'un technicien ne replanifie pas');
    const nb = db.count('notifications', (n) => n.userId === etat.tperso.id);
    await c.mdupont.ok('PUT', `/api/planning/ot/${o.id}`, { datePrevue: jour(1) });
    const maj = db.get('ot', o.id);
    assert.equal(String(maj.datePrevue).slice(0, 10), jour(1));
    assert.equal(maj.statut, 'planifie', 'OT daté et affecté → planifié');
    assert.ok(db.count('notifications', (n) => n.userId === etat.tperso.id) > nb, 'technicien informé de la replanification');
    assert.ok(db.findOne('audit', (x) => x.entite === 'ot' && x.entiteId === o.id && /planning/i.test(x.details)));
    const pl = await c.mdupont.ok('GET', `/api/planning?du=${jour(0)}&au=${jour(7)}`);
    assert.ok(JSON.stringify(pl).includes(maj.numero), 'OT visible dans le planning à sa nouvelle date');
  });
});
