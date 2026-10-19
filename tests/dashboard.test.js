'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');
const modules = require('../server/modules');

/**
 * Tests du module Tableau de bord : base vide, droits (401/403, sections absentes sans le droit
 * « voir » du module), indicateurs calculés (OT, demandes, préventif, stock, équipements), workflow
 * (création → temps passé → clôture), demandes à valider (portée, N+1), portée par secteur
 * (technicien du secteur Production), cohérence avec les compteurs des autres modules après le
 * chargement complet des données de démonstration, robustesse (données incomplètes, services absents).
 */
const pad = (n) => String(n).padStart(2, '0');
const jourLocal = (decalage = 0) => { const d = new Date(); d.setDate(d.getDate() + decalage); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const jourDe = (s) => { if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return String(s); const t = Date.parse(s); if (Number.isNaN(t)) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const AUJ = jourLocal(0);
const MOIS = AUJ.slice(0, 7);

const KPIS_OT = ['otOuverts', 'otEnRetard', 'otEnCours', 'otTerminesMois', 'heuresMois', 'coutMois'];
const KPIS_DEMANDES = ['demandesAValider', 'demandesOuvertes'];
const KPIS_PREVENTIF = ['preventifsEnRetard', 'preventifsAVenir7j'];
const GRAPHIQUES = ['otParStatut', 'otParType30j', 'otParSecteur', 'topEquipements90j', 'evolution6Mois', 'repartitionPreventifCorrectif'];
const LISTES = ['mesOT', 'otEnRetard', 'demandesAValider', 'prochainsPreventifs', 'alertesStock', 'dernieresActivites'];

describe('Tableau de bord — base vide, droits et workflow', () => {
  let srv, admin, PROD, LOG, profils;
  let seq = 0;
  const p = (n) => profils.find((x) => x.nom === n).id;
  async function utilisateur(login, profil, extra = {}) {
    const u = await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, prenom: 'Test', profilId: p(profil), password: 'test1234', doitChangerMdp: false }, extra));
    const c = srv.client(); await c.login(login, 'test1234');
    return { u, c };
  }
  function insererOt(champs) {
    seq += 1;
    return srv.db.insert('ot', Object.assign({
      numero: `OT-TDB-${pad(seq)}`, titre: `Intervention de test ${seq}`, description: '', statut: 'nouveau', typeCode: 'correctif', prioriteCode: 'normale',
      equipementId: null, secteurId: null, technicienId: null, techniciens: [], datePrevue: null, dureeEstimee: null, dateDebut: null, dateFin: null,
      tempsPasse: [], pieces: [], taches: [], commentaires: [], documents: [], historique: [], champs: {}, createdBy: 1,
    }, champs));
  }

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    LOG = secteurs.find((s) => s.code === 'LOG').id;
  });
  after(() => srv.stop());

  test('base vide : tous les indicateurs à zéro, graphiques et listes vides, sans erreur', async () => {
    const d = await admin.ok('GET', '/api/dashboard');
    for (const k of KPIS_OT.concat(KPIS_DEMANDES, KPIS_PREVENTIF, ['articlesSousSeuil', 'equipementsArret'])) assert.equal(d.kpis[k], 0, `kpis.${k}`);
    for (const k of GRAPHIQUES) assert.ok(k in d.graphiques, `graphiques.${k}`);
    for (const k of LISTES) assert.ok(Array.isArray(d.listes[k]) && d.listes[k].length === 0, `listes.${k}`);
    assert.equal(d.aujourdhui, AUJ);
    assert.equal(d.utilisateur.login, 'admin');
    assert.deepEqual(d.sections, { ot: true, demandes: true, preventif: true, stock: true, equipements: true, audit: true });
    // Graphiques : structure complète même sans données
    assert.equal(d.graphiques.evolution6Mois.length, 6);
    assert.equal(d.graphiques.evolution6Mois[5].mois, MOIS);
    assert.ok(d.graphiques.evolution6Mois.every((m) => m.crees === 0 && m.termines === 0 && m.libelle));
    const statuts = srv.ctx.liste('statutsOT');
    assert.deepEqual(d.graphiques.otParStatut.map((s) => s.code), statuts.map((s) => s.code));
    assert.ok(d.graphiques.otParStatut.every((s) => s.valeur === 0 && s.label && s.couleur));
    assert.equal(d.graphiques.otParType30j.length, srv.ctx.liste('typesIntervention').length);
    assert.deepEqual(d.graphiques.otParSecteur, []);
    assert.deepEqual(d.graphiques.topEquipements90j, []);
    assert.equal(d.graphiques.repartitionPreventifCorrectif.total, 0);
    assert.equal(d.graphiques.repartitionPreventifCorrectif.tauxPreventif, null);
    assert.equal(d.compteurs.mesOT, 0);
  });

  test('authentification requise (401) et droit dashboard.voir requis (403)', async () => {
    const anonyme = srv.client();
    assert.equal((await anonyme.get('/api/dashboard')).status, 401);
    const { c } = await utilisateur('sansdashboard', 'Technicien', { secteurIds: [PROD], overrides: { dashboard: { voir: false } } });
    const r = await c.get('/api/dashboard');
    assert.equal(r.status, 403);
    assert.match(r.body.erreur, /Tableau de bord/);
  });

  test('sections absentes sans le droit « voir » du module correspondant', async () => {
    // Demandeur : tableau de bord, demandes, équipements (pas d'OT, de préventif ni de stock)
    const { c: dem } = await utilisateur('demandeur1', 'Demandeur', { secteurIds: [PROD] });
    const d = await dem.ok('GET', '/api/dashboard');
    assert.deepEqual(Object.keys(d.kpis).sort(), ['demandesAValider', 'demandesOuvertes', 'equipementsArret'].sort());
    assert.deepEqual(d.graphiques, {});
    for (const k of ['mesOT', 'otEnRetard', 'prochainsPreventifs', 'alertesStock', 'dernieresActivites']) assert.equal(k in d.listes, false, `listes.${k} absente`);
    assert.ok(Array.isArray(d.listes.demandesAValider));
    assert.ok(Array.isArray(d.listes.mesDemandes));
    assert.equal(d.sections.ot, false);
    assert.equal(d.sections.stock, false);
    assert.equal('coutMoisDetail' in d.compteurs, false);

    // Profil limité au seul tableau de bord : aucune section
    const sansRien = { equipements: { voir: false }, demandes: { voir: false, creer: false }, ot: { voir: false, creer: false, modifier: false, cloturer: false }, preventif: { voir: false }, stock: { voir: false, modifier: false } };
    const { c: vide } = await utilisateur('tdbseul', 'Technicien', { secteurIds: [PROD], overrides: sansRien });
    const v = await vide.ok('GET', '/api/dashboard');
    assert.deepEqual(v.kpis, {});
    assert.deepEqual(v.graphiques, {});
    assert.deepEqual(v.listes, {});

    // Retrait d'un seul module : seul ce module disparaît
    const { c: sansStock } = await utilisateur('sansstock', 'Technicien', { secteurIds: [PROD], overrides: { stock: { voir: false, modifier: false } } });
    const s = await sansStock.ok('GET', '/api/dashboard');
    assert.equal('articlesSousSeuil' in s.kpis, false);
    assert.equal('alertesStock' in s.listes, false);
    for (const k of KPIS_OT.concat(KPIS_PREVENTIF, KPIS_DEMANDES, ['equipementsArret'])) assert.ok(k in s.kpis, `kpis.${k}`);
    // Technicien sans audit.voir : activité = derniers OT modifiés
    assert.equal(s.sources.activites, 'ot');

    // Module désactivé dans la configuration : section absente pour tous, même l'administrateur
    const cfg = srv.db.getConfig();
    cfg.modules.preventif.actif = false;
    srv.db.setConfig(cfg);
    try {
      const a = await admin.ok('GET', '/api/dashboard');
      for (const k of KPIS_PREVENTIF) assert.equal(k in a.kpis, false);
      assert.equal('prochainsPreventifs' in a.listes, false);
    } finally {
      const c2 = srv.db.getConfig(); c2.modules.preventif.actif = true; srv.db.setConfig(c2);
    }
  });

  test('workflow OT : création, temps passé, clôture → KPI du mois, coûts et activité (audit)', async () => {
    const eq = srv.db.insert('equipements', { numero: 'EQ-TDB1', nom: 'Presse de test tableau de bord', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: PROD, actif: true, documents: [], champs: {}, createdBy: 1 });
    const ot = await admin.ok('POST', '/api/ot', { titre: 'Remplacement du joint de vérin', typeCode: 'correctif', prioriteCode: 'haute', equipementId: eq.id, datePrevue: jourLocal(-2), technicienId: 1 });
    let d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.otOuverts, 1);
    assert.equal(d.kpis.otEnRetard, 1);
    assert.equal(d.listes.otEnRetard[0].id, ot.id);
    assert.equal(d.listes.otEnRetard[0].joursRetard, 2);
    assert.equal(d.listes.otEnRetard[0].equipementNom, 'Presse de test tableau de bord');
    assert.equal(d.listes.mesOT[0].id, ot.id, 'l\'administrateur est responsable de l\'OT');
    assert.equal(d.compteurs.mesOT, 1);
    assert.equal(d.compteurs.mesOTEnRetard, 1);
    assert.equal(d.graphiques.otParSecteur[0].secteurId, PROD);
    assert.equal(d.graphiques.otParStatut.find((s) => s.code === ot.statut).valeur, 1);
    assert.equal(d.graphiques.otParType30j.find((t) => t.code === 'correctif').valeur, 1);
    assert.equal(d.graphiques.evolution6Mois[5].crees, 1);
    // Activité : journal d'audit (droit audit.voir)
    assert.equal(d.sources.activites, 'audit');
    assert.equal(d.listes.dernieresActivites[0].entite, 'ot');
    assert.equal(d.listes.dernieresActivites[0].lien, `#/ot/${ot.id}`);
    assert.match(d.listes.dernieresActivites[0].libelle, /Remplacement du joint/);

    await admin.ok('POST', `/api/ot/${ot.id}/temps`, { heures: 2.5, commentaire: 'Dépose du vérin' });
    await admin.ok('POST', `/api/ot/${ot.id}/statut`, { statut: 'en_cours' });
    d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.otEnCours, 1);
    assert.equal(d.kpis.heuresMois, 2.5);
    assert.equal(d.listes.mesOT[0].tempsTotal, 2.5);

    await admin.ok('POST', `/api/ot/${ot.id}/cloturer`, { rapport: 'Joint de tige remplacé, essais conformes.', coutExterne: 120 });
    d = await admin.ok('GET', '/api/dashboard');
    const taux = Number(srv.ctx.config().general.tauxHoraire) || 0;
    assert.equal(d.kpis.otOuverts, 0);
    assert.equal(d.kpis.otEnRetard, 0);
    assert.equal(d.kpis.otEnCours, 0);
    assert.equal(d.kpis.otTerminesMois, 1);
    assert.equal(d.kpis.coutMois, Math.round((2.5 * taux + 120) * 100) / 100);
    assert.deepEqual(d.compteurs.coutMoisDetail, { pieces: 0, mainOeuvre: 2.5 * taux, externe: 120 });
    assert.equal(d.graphiques.evolution6Mois[5].termines, 1);
    assert.equal(d.graphiques.topEquipements90j[0].equipementId, eq.id);
    assert.equal(d.graphiques.topEquipements90j[0].nbCorrectifs, 1);
    assert.equal(d.listes.mesOT.length, 0);
    assert.equal(d.graphiques.repartitionPreventifCorrectif.correctif, 1);
    assert.equal(d.graphiques.repartitionPreventifCorrectif.tauxPreventif, 0);
    assert.ok(['cloture', 'statut'].includes(d.listes.dernieresActivites[0].action));
  });

  test('OT : en retard, terminés hors du mois, annulés et types préventif / correctif', async () => {
    const avant = await admin.ok('GET', '/api/dashboard');
    insererOt({ titre: 'OT futur', datePrevue: jourLocal(3), statut: 'planifie', typeCode: 'preventif' });
    insererOt({ titre: 'OT en retard sans secteur', datePrevue: jourLocal(-10), statut: 'en_attente' });
    insererOt({ titre: 'OT annulé en retard', datePrevue: jourLocal(-10), statut: 'annule', dateFin: new Date().toISOString(), dateCloture: new Date().toISOString() });
    insererOt({ titre: 'OT terminé il y a 70 jours', statut: 'termine', dateFin: new Date(Date.now() - 70 * 86400000).toISOString(), coutMainOeuvre: 999 });
    insererOt({ titre: 'OT issu d\'un plan', statut: 'nouveau', typeCode: 'reglementaire', planPreventifId: 999 });
    const d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.otOuverts, avant.kpis.otOuverts + 3);
    assert.equal(d.kpis.otEnRetard, avant.kpis.otEnRetard + 1, 'un OT annulé n\'est jamais en retard');
    assert.equal(d.kpis.otTerminesMois, avant.kpis.otTerminesMois, 'un OT terminé un autre mois ne compte pas');
    assert.equal(d.kpis.coutMois, avant.kpis.coutMois);
    assert.equal(d.listes.otEnRetard[0].titre, 'OT en retard sans secteur');
    const sansSecteur = d.graphiques.otParSecteur.find((s) => s.secteurId === null);
    assert.equal(sansSecteur.label, 'Sans secteur');
    assert.equal(sansSecteur.valeur, 3);
    const rep = d.graphiques.repartitionPreventifCorrectif;
    assert.equal(rep.preventif, avant.graphiques.repartitionPreventifCorrectif.preventif + 2, 'type préventif et OT rattaché à un plan');
    assert.equal(rep.total, rep.preventif + rep.correctif + rep.autres);
    assert.equal(rep.tauxPreventif, Math.round((rep.preventif / rep.total) * 100));
  });

  test('équipements à l\'arrêt (hors réformés et inactifs), états configurables', async () => {
    srv.db.insert('equipements', { numero: 'EQ-TDB2', nom: 'Chariot à l\'arrêt', etatCode: 'arret', criticiteCode: 'B', secteurId: LOG, actif: true, historiqueEtats: [{ date: new Date().toISOString(), ancien: 'en_service', nouveau: 'arret', commentaire: 'Fuite hydraulique' }] });
    srv.db.insert('equipements', { numero: 'EQ-TDB3', nom: 'Ancienne machine réformée', etatCode: 'reforme', secteurId: PROD, actif: false });
    srv.db.insert('equipements', { numero: 'EQ-TDB4', nom: 'Machine inactive à l\'arrêt', etatCode: 'arret', secteurId: PROD, actif: false });
    srv.db.insert('equipements', { numero: 'EQ-TDB5', nom: 'Machine en mode dégradé', etatCode: 'degrade', secteurId: PROD, actif: true });
    let d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.equipementsArret, 1);
    assert.equal(d.compteurs.equipementsDegrades, 1);
    assert.equal(d.listes.equipementsArret[0].nom, 'Chariot à l\'arrêt');
    assert.equal(d.listes.equipementsArret[0].motif, 'Fuite hydraulique');
    assert.deepEqual(d.filtres.etatsArret, ['arret']);
    // Nouvel état « Hors service » ajouté dans la configuration : reconnu
    const cfg = srv.db.getConfig();
    cfg.listes.etatsEquipement.push({ code: 'hs', label: 'Hors service', couleur: '#7f1d1d', ordre: 9 });
    srv.db.setConfig(cfg);
    srv.db.insert('equipements', { numero: 'EQ-TDB6', nom: 'Groupe hors service', etatCode: 'hs', secteurId: PROD, actif: true });
    d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.equipementsArret, 2);
    assert.deepEqual(d.filtres.etatsArret.sort(), ['arret', 'hs']);
    // Portée : un technicien de Production ne voit pas le chariot de la Logistique
    const { c } = await utilisateur('techprod1', 'Technicien', { secteurIds: [PROD] });
    const t = await c.ok('GET', '/api/dashboard');
    assert.equal(t.kpis.equipementsArret, 1);
    assert.equal(t.listes.equipementsArret[0].nom, 'Groupe hors service');
  });

  test('demandes à valider : les demandes d\'un site accessible en lecture seule sont exclues (comme le module Demandes)', async () => {
    const site2 = srv.db.insert('secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site', parentId: null, actif: true, ordre: 90 });
    const prod2 = srv.db.insert('secteurs', { nom: 'Production Valréas', code: 'VPROD', type: 'atelier', parentId: site2.id, actif: true, ordre: 91 });
    const d = srv.db.insert('demandes', { numero: 'DI-LECT-1', titre: 'Demande du site 2', statut: 'soumise', prioriteCode: 'normale', typeCode: 'correctif', secteurId: prod2.id, demandeurId: 1, createdBy: 1, historique: [], commentaires: [], pieceJointes: [] });
    const { c: lecture } = await utilisateur('cheflect', 'Chef de secteur', { secteurIds: [PROD], siteAcces: [{ siteId: site2.id, mode: 'lecture' }] });
    const { c: complet } = await utilisateur('chefcomplet', 'Chef de secteur', { secteurIds: [PROD], siteAcces: [{ siteId: site2.id, mode: 'complet' }] });
    const dl = await lecture.ok('GET', '/api/dashboard');
    assert.equal(dl.listes.demandesAValider.some((x) => x.id === d.id), false, 'site en lecture seule : non validable');
    assert.equal(dl.kpis.demandesAValider, (await lecture.ok('GET', '/api/demandes-compteurs')).aValider, 'cohérent avec le module Demandes');
    const dc = await complet.ok('GET', '/api/dashboard');
    assert.equal(dc.listes.demandesAValider.some((x) => x.id === d.id), true, 'accès complet : validable');
    assert.equal(dc.kpis.demandesAValider, (await complet.ok('GET', '/api/demandes-compteurs')).aValider);
    srv.db.remove('demandes', d.id);
  });

  test('demandes à valider : uniquement celles que l\'utilisateur peut valider (portée, N+1)', async () => {
    const { u: uChef, c: chef } = await utilisateur('chefprod1', 'Chef de secteur', { secteurIds: [PROD] });
    const { c: chefLog } = await utilisateur('cheflog1', 'Chef de secteur', { secteurIds: [LOG] });
    const { c: oper } = await utilisateur('operateur1', 'Demandeur', { secteurIds: [PROD], managerId: uChef.id });
    const { c: tech } = await utilisateur('techprod2', 'Technicien', { secteurIds: [PROD] });
    const avantChef = await chef.ok('GET', '/api/dashboard');
    const dem1 = await oper.ok('POST', '/api/demandes', { titre: 'Bruit anormal sur le convoyeur', secteurId: PROD, prioriteCode: 'urgente', arretProduction: true });
    await oper.ok('POST', '/api/demandes', { titre: 'Éclairage défaillant zone emballage', secteurId: PROD, prioriteCode: 'basse' });

    let d = await chef.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.demandesAValider, avantChef.kpis.demandesAValider + 2);
    assert.equal(d.kpis.demandesOuvertes, avantChef.kpis.demandesOuvertes + 2);
    assert.equal(d.listes.demandesAValider[0].id, dem1.id, 'arrêt de production et priorité urgente en tête');
    assert.equal(d.listes.demandesAValider[0].arretProduction, true);
    assert.ok(d.listes.demandesAValider[0].demandeurNom);
    assert.equal(d.filtres.statutSoumise, 'soumise');
    const compteurs = await chef.ok('GET', '/api/demandes-compteurs');
    assert.equal(d.kpis.demandesAValider, compteurs.aValider, 'cohérent avec le module Demandes');
    assert.equal(d.kpis.demandesOuvertes, compteurs.ouvertes);

    // Chef d'un autre secteur : ne voit ni ne valide les demandes de Production
    const l = await chefLog.ok('GET', '/api/dashboard');
    assert.equal(l.listes.demandesAValider.some((x) => x.id === dem1.id), false);
    // Technicien : voit les demandes de son secteur mais sans droit de validation
    const t = await tech.ok('GET', '/api/dashboard');
    assert.equal(t.kpis.demandesAValider, 0);
    assert.ok(t.kpis.demandesOuvertes >= 2);
    // Demandeur : ses demandes ouvertes
    const o = await oper.ok('GET', '/api/dashboard');
    assert.equal(o.listes.mesDemandes.length, 2);
    assert.equal(o.compteurs.mesDemandesOuvertes, 2);

    // Validation réservée au supérieur hiérarchique : l'administrateur (N+1 non) garde la main, un autre chef non
    const cfg = srv.db.getConfig(); cfg.workflow.validerParSuperieurUniquement = true; srv.db.setConfig(cfg);
    try {
      const { c: autreChef } = await utilisateur('chefprod2', 'Chef de secteur', { secteurIds: [PROD] });
      const a = await autreChef.ok('GET', '/api/dashboard');
      assert.equal(a.listes.demandesAValider.some((x) => x.id === dem1.id), false);
      d = await chef.ok('GET', '/api/dashboard');
      assert.equal(d.listes.demandesAValider.some((x) => x.id === dem1.id), true, 'le N+1 du demandeur peut valider');
    } finally {
      const c2 = srv.db.getConfig(); c2.workflow.validerParSuperieurUniquement = false; srv.db.setConfig(c2);
    }
    // Après validation, la demande sort de la liste
    await chef.ok('POST', `/api/demandes/${dem1.id}/valider`, {});
    d = await chef.ok('GET', '/api/dashboard');
    assert.equal(d.listes.demandesAValider.some((x) => x.id === dem1.id), false);
  });

  test('stock : articles sous le seuil (ruptures en tête), portée et articles inactifs', async () => {
    const avant = await admin.ok('GET', '/api/dashboard');
    srv.db.insert('articles', { code: 'ART-T1', designation: 'Roulement 6205', quantite: 3, seuilMin: 4, quantiteCommande: 10, uniteCode: 'u', actif: true, secteurId: null });
    srv.db.insert('articles', { code: 'ART-T2', designation: 'Courroie SPZ 1250', quantite: 0, seuilMin: 2, quantiteCommande: 4, uniteCode: 'u', actif: true, secteurId: null });
    srv.db.insert('articles', { code: 'ART-T3', designation: 'Joint torique (inactif)', quantite: 0, seuilMin: 5, actif: false });
    srv.db.insert('articles', { code: 'ART-T4', designation: 'Filtre (magasin logistique)', quantite: 1, seuilMin: 5, actif: true, secteurId: LOG });
    srv.db.insert('articles', { code: 'ART-T5', designation: 'Graisse (stock suffisant)', quantite: 50, seuilMin: 5, actif: true });
    const d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.articlesSousSeuil, avant.kpis.articlesSousSeuil + 3);
    assert.equal(d.compteurs.articlesRupture, avant.compteurs.articlesRupture + 1);
    assert.equal(d.listes.alertesStock[0].code, 'ART-T2', 'rupture en tête');
    assert.equal(d.listes.alertesStock[0].rupture, true);
    assert.ok(d.listes.alertesStock[0].quantiteACommander > 0);
    const { c } = await utilisateur('techprod3', 'Technicien', { secteurIds: [PROD] });
    const t = await c.ok('GET', '/api/dashboard');
    assert.equal(t.listes.alertesStock.some((a) => a.code === 'ART-T4'), false, 'magasin hors portée');
    assert.equal(t.kpis.articlesSousSeuil, d.kpis.articlesSousSeuil - 1);
  });

  test('préventif : plans en retard, à venir sous 7 jours, inactifs exclus', async () => {
    const avant = await admin.ok('GET', '/api/dashboard');
    const plan = (champs) => srv.db.insert('plansPreventifs', Object.assign({ numero: `PP-T${++seq}`, nom: `Plan ${seq}`, typeCode: 'preventif', prioriteCode: 'normale', periodicite: { type: 'mois', valeur: 1 }, gamme: [], pieces: [], actif: true, secteurId: PROD, createdBy: 1 }, champs));
    plan({ nom: 'Graissage en retard', prochaineEcheance: jourLocal(-5) });
    plan({ nom: 'Contrôle sous 3 jours', prochaineEcheance: jourLocal(3) });
    plan({ nom: 'Révision dans 40 jours', prochaineEcheance: jourLocal(40) });
    plan({ nom: 'Plan inactif en retard', prochaineEcheance: jourLocal(-20), actif: false });
    plan({ nom: 'Plan de la logistique en retard', prochaineEcheance: jourLocal(-2), secteurId: LOG });
    const d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.kpis.preventifsEnRetard, avant.kpis.preventifsEnRetard + 2);
    assert.equal(d.kpis.preventifsAVenir7j, avant.kpis.preventifsAVenir7j + 1);
    const noms = d.listes.prochainsPreventifs.map((x) => x.nom);
    assert.equal(noms.includes('Plan inactif en retard'), false);
    assert.ok(noms.indexOf('Graissage en retard') < noms.indexOf('Contrôle sous 3 jours'), 'les retards d\'abord');
    assert.ok(d.listes.prochainsPreventifs.filter((x) => x.enRetard).every((x) => x.joursRestants < 0));
    const { c } = await utilisateur('techprod4', 'Technicien', { secteurIds: [PROD] });
    const t = await c.ok('GET', '/api/dashboard');
    assert.equal(t.listes.prochainsPreventifs.some((x) => x.nom === 'Plan de la logistique en retard'), false);
    assert.equal(t.kpis.preventifsEnRetard, d.kpis.preventifsEnRetard - 1);
  });

  test('robustesse : données incomplètes ou incohérentes, services des autres modules absents', async () => {
    insererOt({ titre: 'OT au statut inconnu', statut: 'statut_inexistant', typeCode: 'type_inconnu', datePrevue: 'pas-une-date', tempsPasse: [{ date: AUJ, heures: 'abc' }, { heures: 3 }] });
    insererOt({ titre: 'OT minimal', statut: null, techniciens: null, tempsPasse: null, pieces: null, taches: null, historique: null, equipementId: 99999 });
    srv.db.insert('demandes', { numero: 'DI-T1', titre: 'Demande sans statut', statut: null, prioriteCode: 'inconnue' });
    srv.db.insert('articles', { code: 'ART-T9', designation: 'Article sans quantité', actif: true });
    const d = await admin.ok('GET', '/api/dashboard');
    assert.ok(d.graphiques.otParStatut.some((s) => s.code === 'statut_inexistant' && s.valeur === 1));
    assert.ok(d.graphiques.otParType30j.some((t) => t.code === null && t.label === 'Non renseigné'));
    assert.ok(Number.isFinite(d.kpis.heuresMois));

    // Sans les services des autres modules : calculs de repli, résultats identiques
    const sauvegarde = Object.assign({}, srv.ctx.services);
    try {
      for (const k of ['ot', 'demandes', 'preventif', 'stock', 'equipements']) delete srv.ctx.services[k];
      const r = await admin.ok('GET', '/api/dashboard');
      for (const k of KPIS_OT.concat(KPIS_DEMANDES, ['articlesSousSeuil', 'equipementsArret', 'preventifsEnRetard', 'preventifsAVenir7j'])) assert.equal(r.kpis[k], d.kpis[k], `kpis.${k} (repli)`);
      assert.deepEqual(r.graphiques.otParStatut, d.graphiques.otParStatut);
      assert.equal(r.listes.alertesStock.length, d.listes.alertesStock.length);
    } finally {
      Object.assign(srv.ctx.services, sauvegarde);
    }
    // Un service qui lève une erreur n'empêche pas l'affichage
    const echeances = srv.ctx.services.preventif.echeances;
    srv.ctx.services.preventif.echeances = () => { throw new Error('panne simulée'); };
    srv.ctx.log = () => {};
    try {
      const r = await admin.ok('GET', '/api/dashboard');
      assert.equal(typeof r.kpis.preventifsEnRetard, 'number');
    } finally { srv.ctx.services.preventif.echeances = echeances; }
  });

  test('seedDemo du module : message d\'accueil idempotent, sans écraser un message existant', async () => {
    const mod = require('../server/modules/dashboard');
    const cfg = srv.db.getConfig(); cfg.general.messageAccueil = ''; srv.db.setConfig(cfg);
    assert.match(mod.seedDemo(srv.ctx), /accueil/);
    const message = srv.db.getConfig().general.messageAccueil;
    assert.ok(message.length > 20);
    assert.match(mod.seedDemo(srv.ctx), /déjà/);
    assert.equal(srv.db.getConfig().general.messageAccueil, message);
    const d = await admin.ok('GET', '/api/dashboard');
    assert.equal(d.accueil.message, message);
    const c2 = srv.db.getConfig(); c2.general.messageAccueil = 'Message du site'; srv.db.setConfig(c2);
    mod.seedDemo(srv.ctx);
    assert.equal(srv.db.getConfig().general.messageAccueil, 'Message du site');
  });
});

describe('Tableau de bord — données de démonstration complètes et portée par secteur', () => {
  let srv, admin, techProd, uTechProd, jbernard, spetit;
  let PROD, prodIds;
  const st = () => srv.ctx.services.ot.statuts();

  before(async () => {
    srv = await demarrer();
    admin = srv.client(); await admin.login('admin', 'admin');
    const rapport = modules.seedDemo(srv.ctx);
    const echecs = rapport.filter((r) => !r.ok);
    assert.deepEqual(echecs, [], 'tous les modules chargent leurs données de démonstration');
    const profils = await admin.ok('GET', '/api/profils');
    const secteurs = await admin.ok('GET', '/api/secteurs');
    PROD = secteurs.find((s) => s.code === 'PROD').id;
    prodIds = new Set(srv.ctx.perms.secteursDescendants(srv.db, [PROD]));
    uTechProd = await admin.ok('POST', '/api/utilisateurs', { login: 'techprod', nom: 'Technicien', prenom: 'Théo', profilId: profils.find((x) => x.nom === 'Technicien').id, secteurIds: [PROD], password: 'tech1234', doitChangerMdp: false });
    techProd = srv.client(); await techProd.login('techprod', 'tech1234');
    jbernard = srv.client(); await jbernard.login('jbernard', 'demo');
    spetit = srv.client(); await spetit.login('spetit', 'demo');
  });
  after(() => srv.stop());

  test('KPI après chargement des données de démonstration : cohérents avec les modules', async () => {
    const d = await admin.ok('GET', '/api/dashboard');
    assert.ok(d.kpis.otOuverts > 0);
    const ot = await admin.ok('GET', '/api/ot-compteurs');
    assert.equal(d.kpis.otOuverts, ot.ouverts);
    assert.equal(d.kpis.otEnRetard, ot.enRetard);
    assert.equal(d.kpis.otEnCours, ot.enCours);
    const dem = await admin.ok('GET', '/api/demandes-compteurs');
    assert.equal(d.kpis.demandesAValider, dem.aValider);
    assert.equal(d.kpis.demandesOuvertes, dem.ouvertes);
    const prev = await admin.ok('GET', '/api/preventif-compteurs');
    assert.equal(d.kpis.preventifsEnRetard, prev.enRetard);
    const alertes = await admin.ok('GET', '/api/stock-alertes');
    assert.equal(d.kpis.articlesSousSeuil, alertes.length);
    assert.equal(d.kpis.equipementsArret, srv.db.count('equipements', (e) => e.actif !== false && e.etatCode === 'arret'));

    // Indicateurs du mois recalculés indépendamment
    const s = st();
    const ots = srv.db.list('ot');
    const termines = ots.filter((o) => s.estFinal(o.statut) && !s.estAnnulation(o.statut) && jourDe(o.dateFin || o.dateCloture).slice(0, 7) === MOIS);
    assert.equal(d.kpis.otTerminesMois, termines.length);
    const cout = termines.reduce((acc, o) => acc + (Number(o.coutPieces) || 0) + (Number(o.coutMainOeuvre) || 0) + (Number(o.coutExterne) || 0), 0);
    assert.equal(d.kpis.coutMois, Math.round(cout * 100) / 100);
    const heures = ots.reduce((acc, o) => acc + (o.tempsPasse || []).filter((t) => jourDe(t.date).slice(0, 7) === MOIS).reduce((a, t) => a + (Number(t.heures) || 0), 0), 0);
    assert.equal(d.kpis.heuresMois, Math.round(heures * 100) / 100);

    // Graphiques
    assert.equal(d.graphiques.otParStatut.reduce((a, x) => a + x.valeur, 0), ots.length);
    assert.equal(d.graphiques.otParSecteur.reduce((a, x) => a + x.valeur, 0), d.kpis.otOuverts);
    assert.ok(d.graphiques.topEquipements90j.length > 0 && d.graphiques.topEquipements90j.length <= 5);
    const top = d.graphiques.topEquipements90j;
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].nbOt >= top[i].nbOt, 'top équipements trié');
    assert.ok(d.graphiques.evolution6Mois.reduce((a, m) => a + m.crees, 0) > 0);
    assert.ok(d.graphiques.repartitionPreventifCorrectif.total > 0);

    // Listes : tronquées et triées
    for (const k of ['mesOT', 'otEnRetard', 'demandesAValider', 'prochainsPreventifs', 'alertesStock']) assert.ok(d.listes[k].length <= 8, `listes.${k} ≤ 8`);
    assert.ok(d.listes.dernieresActivites.length > 0 && d.listes.dernieresActivites.length <= 15);
    const retards = d.listes.otEnRetard;
    assert.equal(retards.length, Math.min(8, d.kpis.otEnRetard));
    for (let i = 1; i < retards.length; i++) assert.ok(retards[i - 1].datePrevue <= retards[i].datePrevue, 'OT en retard triés par date prévue');
    assert.ok(retards.every((o) => o.enRetard && o.datePrevue < AUJ && o.joursRetard > 0));
    assert.ok(d.listes.prochainsPreventifs.length > 0);
    assert.ok(d.listes.alertesStock.every((a) => a.quantite <= a.seuilMin));
    assert.ok(d.accueil.message, 'message d\'accueil de démonstration');
  });

  test('« Mes OT » : uniquement les OT ouverts affectés à l\'utilisateur', async () => {
    const d = await jbernard.ok('GET', '/api/dashboard');
    const u = srv.db.findOne('users', (x) => x.login === 'jbernard');
    const s = st();
    const attendus = srv.db.list('ot', (o) => !s.estFinal(o.statut) && (Number(o.technicienId) === u.id || (o.techniciens || []).map(Number).includes(u.id)));
    assert.ok(attendus.length > 0, 'la démonstration affecte des OT à Julie Bernard');
    assert.equal(d.compteurs.mesOT, attendus.length);
    assert.equal(d.listes.mesOT.length, Math.min(8, attendus.length));
    assert.ok(d.listes.mesOT.every((o) => o.technicienId === u.id || o.techniciens.includes(u.id)));
    assert.ok(d.listes.mesOT.every((o) => o.titre && o.numero && o.statut));
    const ot = await jbernard.ok('GET', '/api/ot-compteurs');
    assert.equal(d.compteurs.mesOT, ot.mesOT);
    assert.equal(d.compteurs.mesOTEnRetard, ot.mesOTEnRetard);
    // Technicien sans audit.voir : activité = derniers OT modifiés de sa portée
    assert.equal(d.sources.activites, 'ot');
    assert.ok(d.listes.dernieresActivites.every((a) => a.entite === 'ot' && a.lien === `#/ot/${a.entiteId}`));
  });

  test('portée : un technicien du secteur Production ne voit que les données de son secteur', async () => {
    const d = await techProd.ok('GET', '/api/dashboard');
    const s = st();
    const visible = (o) => o.secteurId == null || prodIds.has(Number(o.secteurId)) || Number(o.createdBy) === uTechProd.id || Number(o.technicienId) === uTechProd.id;
    const ots = srv.db.list('ot');
    const ouverts = ots.filter((o) => !s.estFinal(o.statut) && visible(o));
    assert.ok(ouverts.length < ots.filter((o) => !s.estFinal(o.statut)).length, 'la démonstration contient des OT hors Production');
    assert.equal(d.kpis.otOuverts, ouverts.length);
    assert.equal(d.kpis.otEnRetard, ouverts.filter((o) => o.datePrevue && jourDe(o.datePrevue) < AUJ).length);
    const ot = await techProd.ok('GET', '/api/ot-compteurs');
    assert.equal(d.kpis.otOuverts, ot.ouverts);
    assert.ok(d.listes.otEnRetard.every((o) => o.secteurId == null || prodIds.has(o.secteurId)));
    assert.ok(d.graphiques.otParSecteur.every((x) => x.secteurId === null || prodIds.has(x.secteurId)));
    assert.ok(d.graphiques.topEquipements90j.every((x) => x.secteurId === null || prodIds.has(x.secteurId)));
    assert.equal(d.graphiques.otParStatut.reduce((a, x) => a + x.valeur, 0), ots.filter(visible).length);
    // Équipements : le chariot thermique (Logistique) à l'arrêt n'est pas visible
    assert.equal(d.kpis.equipementsArret, 0);
    // Demandes : portée du secteur, pas de droit de validation
    const dem = await techProd.ok('GET', '/api/demandes-compteurs');
    assert.equal(d.kpis.demandesOuvertes, dem.ouvertes);
    assert.equal(d.kpis.demandesAValider, 0);
    // Préventif : uniquement les plans de Production
    assert.ok(d.listes.prochainsPreventifs.every((x) => x.secteurId == null || prodIds.has(Number(x.secteurId))));
    const prev = await techProd.ok('GET', '/api/preventif-compteurs');
    assert.equal(d.kpis.preventifsEnRetard, prev.enRetard);
    // Le responsable (portée « tous ») voit davantage
    const a = await admin.ok('GET', '/api/dashboard');
    assert.ok(a.kpis.otOuverts > d.kpis.otOuverts);
    // Aucune fuite d'informations hors portée dans l'activité récente
    assert.ok(d.listes.dernieresActivites.every((x) => { const o = srv.db.get('ot', x.entiteId); return o && visible(o); }));
  });

  test('portée « perso » (demandeur) : ses demandes uniquement, aucune section OT', async () => {
    const d = await spetit.ok('GET', '/api/dashboard');
    const u = srv.db.findOne('users', (x) => x.login === 'spetit');
    assert.equal('otOuverts' in d.kpis, false);
    assert.equal('mesOT' in d.listes, false);
    const dem = await spetit.ok('GET', '/api/demandes-compteurs');
    assert.equal(d.kpis.demandesOuvertes, dem.ouvertes);
    assert.equal(d.compteurs.mesDemandesOuvertes, dem.mesOuvertes);
    assert.ok(d.listes.mesDemandes.every((x) => x.demandeurId === u.id));
  });

  test('activité récente : journal d\'audit filtré par portée et par droit sur l\'entité', async () => {
    // Une action réelle produit des entrées d'audit
    const s = st();
    const otId = srv.db.list('ot', (o) => !s.estFinal(o.statut) && o.secteurId != null && !prodIds.has(Number(o.secteurId)))[0].id;
    await admin.ok('POST', `/api/ot/${otId}/commentaires`, { texte: 'Point fait avec le chef d\'équipe.' });
    const a = await admin.ok('GET', '/api/dashboard');
    assert.equal(a.sources.activites, 'audit');
    assert.ok(a.listes.dernieresActivites.some((x) => x.entite === 'ot' && x.entiteId === otId));
    assert.ok(a.listes.dernieresActivites.every((x) => ['ot', 'demandes', 'equipements'].includes(x.entite)));
    // Un chef de secteur Production avec audit.voir ne voit pas l'activité d'un OT hors de son secteur
    const profils = await admin.ok('GET', '/api/profils');
    await admin.ok('POST', '/api/utilisateurs', { login: 'chefaudit', nom: 'Chef', prenom: 'Audit', profilId: profils.find((x) => x.nom === 'Chef de secteur').id, secteurIds: [PROD], password: 'chef1234', doitChangerMdp: false, overrides: { audit: { voir: true } } });
    const chef = srv.client(); await chef.login('chefaudit', 'chef1234');
    const c = await chef.ok('GET', '/api/dashboard');
    assert.equal(c.listes.dernieresActivites.some((x) => x.entite === 'ot' && x.entiteId === otId), false);
  });

  test('lecture seule : le calcul ne crée ni OT, ni audit, ni notification', async () => {
    const avant = ['ot', 'demandes', 'audit', 'notifications', 'plansPreventifs', 'articles'].map((c) => [c, srv.db.count(c)]);
    const majOt = srv.db.list('ot').map((o) => o.updatedAt).join();
    for (const c of [admin, techProd, jbernard, spetit]) await c.ok('GET', '/api/dashboard');
    for (const [c, n] of avant) assert.equal(srv.db.count(c), n, `collection ${c} inchangée`);
    assert.equal(srv.db.list('ot').map((o) => o.updatedAt).join(), majOt, 'aucun OT modifié');
  });

  test('performance : calcul rapide sur la base de démonstration et sur une base volumineuse', async () => {
    let t0 = Date.now();
    for (let i = 0; i < 5; i++) await admin.ok('GET', '/api/dashboard');
    assert.ok((Date.now() - t0) / 5 < 500, 'moins de 500 ms par calcul');
    // Base volumineuse : 4 000 OT, 1 500 demandes soumises, 1 000 articles, logo de 200 Ko dans la configuration
    const cfg = srv.db.getConfig(); cfg.societe.logo = 'data:image/png;base64,' + 'A'.repeat(200000); srv.db.setConfig(cfg);
    const eqs = srv.db.list('equipements').map((e) => e.id);
    const statuts = ['nouveau', 'planifie', 'en_cours', 'termine', 'termine', 'annule'];
    const col = srv.db.data.collections;
    for (let i = 0; i < 4000; i++) {
      const d = new Date(Date.now() - (i % 360) * 86400000).toISOString();
      col.ot.push({ id: 100000 + i, numero: `OT-V${i}`, titre: `OT volumineux ${i}`, statut: statuts[i % 6], typeCode: i % 2 ? 'correctif' : 'preventif', prioriteCode: 'normale', equipementId: eqs[i % eqs.length], secteurId: PROD, technicienId: uTechProd.id, techniciens: [uTechProd.id], datePrevue: d.slice(0, 10), dateFin: d, tempsPasse: [{ date: d.slice(0, 10), heures: 1.5, userId: uTechProd.id }], pieces: [], taches: [], historique: [], createdAt: d, updatedAt: d, createdBy: 1, coutPieces: 12, coutMainOeuvre: 67.5, coutExterne: 0 });
    }
    for (let i = 0; i < 1500; i++) col.demandes.push({ id: 100000 + i, numero: `DI-V${i}`, titre: `Demande ${i}`, statut: 'soumise', prioriteCode: 'haute', secteurId: PROD, demandeurId: uTechProd.id, dateDemande: new Date().toISOString(), createdAt: new Date().toISOString(), createdBy: uTechProd.id });
    for (let i = 0; i < 1000; i++) col.articles.push({ id: 100000 + i, code: `ART-V${i}`, designation: `Article ${i}`, quantite: i % 5, seuilMin: 2, actif: true });
    srv.db.touch();
    t0 = Date.now();
    const d = await admin.ok('GET', '/api/dashboard');
    const duree = Date.now() - t0;
    assert.ok(d.kpis.otOuverts >= 2000 && d.kpis.demandesAValider >= 1500 && d.listes.mesOT !== undefined);
    assert.ok(duree < 1500, `calcul en ${duree} ms sur une base volumineuse (< 1,5 s attendu)`);
    const t = await techProd.ok('GET', '/api/dashboard');
    const s = st();
    assert.equal(t.compteurs.mesOT, srv.db.count('ot', (o) => Number(o.technicienId) === uTechProd.id && !s.estFinal(o.statut)));
    assert.equal(t.listes.mesOT.length, 8);
  });
});
