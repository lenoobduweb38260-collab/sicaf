'use strict';
/**
 * Module Achats & factures : commandes (CRUD, totaux, circuit de validation, réceptions avec entrée en stock,
 * annulation, solde, brouillons depuis les alertes de stock), factures (contrôles de montants, unicité,
 * rapprochement, bon à payer, paiement, litige), documents, tableau de bord, échéancier, coûts par OT,
 * exports CSV, droits, portée par secteur et multi-site, données de démonstration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { demarrer } = require('./helpers');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const jour = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

describe('Achats & factures', () => {
  let srv; let admin; let secteurs; let profils;
  let SITE; let PROD; let MAINT; let LOG;
  let four1; let four2; let fourInactif; let art1; let art2; let artInactif; let ot1;
  const users = {};
  const clients = {};
  const evenements = [];

  /** Client qui envoie (optionnellement) l'en-tête de site courant. */
  function clientSite(site) {
    const base = srv.base;
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'x-requested-with': 'GMAO', cookie };
      if (site != null) headers['x-gmao-site'] = String(site);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = txt; }
      return { status: r.status, body: data, headers: r.headers };
    };
    return {
      /** Corps brut (octets) d'une réponse GET. */
      async brut(u) { const r = await fetch(base + u, { headers: { 'x-requested-with': 'GMAO', cookie } }); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) }; },
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      async login(l, p) { const r = await call('POST', '/api/auth/login', { login: l, password: p }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body; },
      async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
      setSite(s) { site = s; },
    };
  }
  const profil = (nom) => profils.find((p) => p.nom === nom).id;
  async function creerUtilisateur(login, profilNom, extra = {}) {
    const u = await admin.ok('POST', '/api/utilisateurs', Object.assign({ login, nom: login, prenom: 'Test', profilId: profil(profilNom), secteurIds: [], password: 'pass1234', doitChangerMdp: false }, extra));
    users[login] = u;
    const c = clientSite(null);
    await c.login(login, 'pass1234');
    clients[login] = c;
    return u;
  }
  const corpsCommande = (extra = {}) => Object.assign({
    fournisseurId: four1.id, secteurId: MAINT.id, objet: 'Pièces de rechange', categorieCode: 'pieces',
    lignes: [{ articleId: art1.id, quantite: 5 }, { designation: 'Ligne libre — kit joints', referenceFournisseur: 'KJ-12', quantite: 2, prixUnitaireHT: 12.5, tauxTVA: 20 }],
  }, extra);

  before(async () => {
    srv = await demarrer();
    admin = clientSite(null);
    await admin.login('admin', 'admin');
    secteurs = await admin.ok('GET', '/api/secteurs');
    SITE = secteurs.find((s) => s.code === 'SITE'); PROD = secteurs.find((s) => s.code === 'PROD');
    MAINT = secteurs.find((s) => s.code === 'MAINT'); LOG = secteurs.find((s) => s.code === 'LOG');
    profils = await admin.ok('GET', '/api/profils');
    four1 = srv.db.insert('fournisseurs', { nom: 'Roulements du Midi', actif: true, delaiLivraisonJours: 5, email: 'adv@roulements.example' });
    four2 = srv.db.insert('fournisseurs', { nom: 'Électricité Provence', actif: true });
    fourInactif = srv.db.insert('fournisseurs', { nom: 'Ancien fournisseur', actif: false });
    art1 = srv.db.insert('articles', { code: 'ART-T1', designation: 'Roulement 6205', referenceFournisseur: '6205-2RS', quantite: 1, seuilMin: 4, quantiteCommande: 10, prixUnitaire: 8.5, uniteCode: 'u', fournisseurId: four1.id, actif: true, secteurId: null });
    art2 = srv.db.insert('articles', { code: 'ART-T2', designation: 'Contacteur 18 A', referenceFournisseur: 'LC1D18', quantite: 0, seuilMin: 2, quantiteCommande: 3, prixUnitaire: 70, uniteCode: 'u', fournisseurId: four2.id, actif: true, secteurId: null });
    artInactif = srv.db.insert('articles', { code: 'ART-T3', designation: 'Article retiré', quantite: 0, seuilMin: 0, prixUnitaire: 1, actif: false });
    ot1 = srv.db.insert('ot', { numero: 'OT-T-0001', titre: 'Remplacement roulement convoyeur', secteurId: MAINT.id, statut: 'en_cours' });
    srv.ctx.on('achats:commandeRecue', (d) => evenements.push(['commandeRecue', d.commande.id, d.complete]));
    srv.ctx.on('achats:facturePayee', (d) => evenements.push(['facturePayee', d.facture.id]));
    await creerUtilisateur('acheteur', 'Acheteur / comptabilité', { secteurIds: [SITE.id] });
    await creerUtilisateur('respmaint', 'Responsable maintenance', { secteurIds: [] });
    await creerUtilisateur('chefprod', 'Chef de secteur', { secteurIds: [PROD.id] });
    await creerUtilisateur('tech', 'Technicien', { secteurIds: [MAINT.id] });
  });
  after(async () => { await srv.stop(); });

  // ------------------------------------------------------------------------------------------------
  describe('Commandes : CRUD et validation des entrées', () => {
    test('création : numéro automatique, totaux calculés par le serveur, valeurs reprises de l\'article', async () => {
      const c = await admin.ok('POST', '/api/commandes', corpsCommande({ totaux: { ht: 1, tva: 0, ttc: 1 }, statut: 'recue' }));
      assert.match(c.numero, new RegExp(`^CMD-${new Date().getFullYear()}-\\d{4}$`));
      assert.equal(c.statut, 'brouillon', 'le statut n\'est jamais pris du client');
      assert.equal(c.lignes[0].designation, 'Roulement 6205');
      assert.equal(c.lignes[0].referenceFournisseur, '6205-2RS');
      assert.equal(c.lignes[0].prixUnitaireHT, 8.5);
      assert.equal(c.lignes[0].tauxTVA, 20, 'TVA par défaut : config.achats.tauxTVA');
      assert.deepEqual(c.totaux, { ht: 67.5, tva: 13.5, ttc: 81 });
      assert.equal(c.dateCommande, jour(0));
      assert.equal(c.dateLivraisonPrevue, jour(5), 'délai de livraison du fournisseur');
      assert.equal(c.demandeurUserId, 1);
      assert.equal(c.fournisseurNom, 'Roulements du Midi');
      assert.equal(c.siteId, SITE.id);
      assert.ok(c.actions.modifier && c.actions.soumettre && c.actions.supprimer);
      assert.ok(srv.db.list('audit').some((a) => a.entite === 'commandes' && a.action === 'creation' && a.entiteId === c.id));
    });

    test('modification d\'un brouillon puis suppression', async () => {
      const c = await admin.ok('POST', '/api/commandes', corpsCommande());
      const m = await admin.ok('PUT', '/api/commandes/' + c.id, { lignes: [{ articleId: art1.id, quantite: 10, prixUnitaireHT: 8 }], objet: 'Roulements' });
      assert.equal(m.objet, 'Roulements');
      assert.equal(m.lignes.length, 1);
      assert.deepEqual(m.totaux, { ht: 80, tva: 16, ttc: 96 });
      const liste = await admin.ok('GET', '/api/commandes?recherche=roulements');
      assert.ok(liste.some((x) => x.id === c.id));
      await admin.ok('DELETE', '/api/commandes/' + c.id);
      assert.equal((await admin.get('/api/commandes/' + c.id)).status, 404);
    });

    test('validation stricte des entrées', async () => {
      const cas = [
        [{ fournisseurId: null }, /fournisseur est obligatoire/i],
        [{ fournisseurId: 9999 }, /Fournisseur introuvable/],
        [{ fournisseurId: fourInactif.id }, /désactivé/],
        [{ secteurId: null }, /site \/ service de rattachement est obligatoire/i],
        [{ secteurId: 9999 }, /introuvable/],
        [{ lignes: [] }, /au moins une ligne/],
        [{ lignes: 'x' }, /liste attendue/],
        [{ lignes: [{ designation: 'A', quantite: 0, prixUnitaireHT: 1 }] }, /supérieure à 0/],
        [{ lignes: [{ designation: 'A', quantite: 1, prixUnitaireHT: -1 }] }, /prix unitaire HT/],
        [{ lignes: [{ designation: 'A', quantite: 1 }] }, /prix unitaire HT est obligatoire/],
        [{ lignes: [{ quantite: 1, prixUnitaireHT: 1 }] }, /désignation est obligatoire/],
        [{ lignes: [{ designation: 'A', quantite: 1, prixUnitaireHT: 1, tauxTVA: 150 }] }, /taux de TVA/],
        [{ lignes: [{ articleId: artInactif.id, quantite: 1 }] }, /désactivé/],
        [{ lignes: [{ articleId: 9999, quantite: 1 }] }, /article introuvable/],
        [{ lignes: [{ designation: 'A', quantite: 1, prixUnitaireHT: 1, otId: 9999 }] }, /ordre de travail introuvable/i],
        [{ categorieCode: 'inconnue' }, /Catégorie de dépense invalide/],
        [{ dateCommande: '2026-02-30' }, /date invalide/],
        [{ dateCommande: jour(0), dateLivraisonPrevue: jour(-3) }, /livraison prévue ne peut pas précéder/],
        [{ objet: 'x'.repeat(201) }, /200 caractères/],
      ];
      for (const [modif, attendu] of cas) {
        const r = await admin.post('/api/commandes', corpsCommande(modif));
        assert.equal(r.status, 400, `${JSON.stringify(modif)} → ${JSON.stringify(r.body)}`);
        assert.match(r.body.erreur, attendu);
      }
      const r = await admin.post('/api/commandes', 'pas un objet');
      assert.equal(r.status, 400);
    });

    test('ligne imputée à un OT et coûts d\'achats par OT', async () => {
      const c = await admin.ok('POST', '/api/commandes', corpsCommande({ lignes: [{ designation: 'Roulement spécial', quantite: 2, prixUnitaireHT: 40, otId: ot1.id }] }));
      assert.equal(c.lignes[0].otNumero, 'OT-T-0001');
      const couts = await admin.ok('GET', '/api/achats/couts-ot/' + ot1.id);
      assert.equal(couts.commandes.length, 1);
      assert.equal(couts.totalCommandeHT, 80);
      assert.deepEqual(srv.ctx.services.achats.commandesPourOt(ot1.id).map((x) => x.id), [c.id]);
      await admin.ok('DELETE', '/api/commandes/' + c.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Commandes : circuit de validation, envoi, réceptions', () => {
    test('sous le seuil : soumission = validation automatique ; envoi ; réception partielle puis complète avec entrée en stock', async () => {
      const c = await clients.acheteur.ok('POST', '/api/commandes', corpsCommande({ secteurId: MAINT.id }));
      const s = await clients.acheteur.ok('POST', `/api/commandes/${c.id}/soumettre`);
      assert.equal(s.statut, 'validee');
      assert.equal(s.validationAuto, true);
      const e = await clients.acheteur.ok('POST', `/api/commandes/${c.id}/envoyer`);
      assert.equal(e.statut, 'envoyee');
      assert.equal(e.dateEnvoi, jour(0));
      // Réception partielle : 3 roulements sur 5
      const stockAvant = srv.db.get('articles', art1.id).quantite;
      const r1 = await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 3 }], bonLivraison: 'BL-001' });
      assert.equal(r1.statut, 'partielle');
      assert.equal(r1.lignes[0].quantiteRecue, 3);
      assert.equal(r1.nbEntreesStock, 1);
      assert.equal(srv.db.get('articles', art1.id).quantite, stockAvant + 3);
      const mvt = srv.db.list('mouvementsStock').pop();
      assert.equal(srv.db.count('audit', (a) => a.action === 'mouvement' && /Réception/.test(String(a.details))), 0, 'entrée en stock sans entrée de journal unitaire');
      assert.ok(srv.db.list('audit', (a) => a.entite === 'commandes' && a.entiteId === c.id && /réception/i.test(String(a.details)) && /entrée\(s\) en stock/.test(String(a.details))).length, 'une entrée récapitulative par réception');
      assert.equal(mvt.type, 'entree');
      assert.equal(mvt.motif, `Réception ${c.numero} — BL BL-001`);
      assert.equal(mvt.fournisseurId, four1.id);
      assert.equal(mvt.prixUnitaire, 8.5);
      assert.equal(r1.receptions[0].lignes[0].mouvementId, mvt.id);
      assert.ok(srv.db.list('notifications', (n) => n.userId === users.acheteur.id && /reçue partiellement/.test(n.titre)).length, 'demandeur notifié');
      // Contrôles de la réception
      for (const [corps, attendu] of [
        [{ lignes: [{ index: 0, quantite: 3 }] }, /supérieure au reste à recevoir/],
        [{ lignes: [{ index: 7, quantite: 1 }] }, /inexistante/],
        [{ lignes: [{ index: 0, quantite: 1 }, { index: 0, quantite: 1 }] }, /deux fois/],
        [{ lignes: [{ index: 0, quantite: 0 }] }, /Aucune quantité reçue/],
        [{ lignes: [] }, /au moins une ligne/],
        [{ lignes: [{ index: 0, quantite: 1 }], date: jour(3) }, /futur/],
      ]) {
        const r = await admin.post(`/api/commandes/${c.id}/receptionner`, corps);
        assert.equal(r.status, 400, JSON.stringify(corps));
        assert.match(r.body.erreur, attendu);
      }
      // Solde de la réception
      const r2 = await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 2 }, { index: 1, quantite: 2 }], bonLivraison: 'BL-002' });
      assert.equal(r2.statut, 'recue');
      assert.equal(r2.tauxReception, 100);
      assert.equal(srv.db.get('articles', art1.id).quantite, stockAvant + 5, 'la ligne libre n\'entre pas en stock');
      assert.deepEqual(evenements.filter((x) => x[0] === 'commandeRecue' && x[1] === c.id).map((x) => x[2]), [false, true]);
      // Statut final : plus modifiable, plus annulable
      assert.equal((await admin.put('/api/commandes/' + c.id, { objet: 'x' })).status, 400);
      assert.equal((await admin.post(`/api/commandes/${c.id}/annuler`, { motif: 'test' })).status, 400);
      assert.equal((await admin.del('/api/commandes/' + c.id)).status, 400);
    });

    test('sans entrée en stock automatique (configuration)', async () => {
      await admin.ok('PUT', '/api/configuration', { achats: { entreeStockAReception: false } });
      try {
        const c = await admin.ok('POST', '/api/commandes', corpsCommande({ lignes: [{ articleId: art1.id, quantite: 2 }] }));
        await admin.ok('POST', `/api/commandes/${c.id}/soumettre`);
        const avant = srv.db.get('articles', art1.id).quantite;
        const r = await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 2 }] });
        assert.equal(r.statut, 'recue', 'réception possible dès la validation');
        assert.equal(srv.db.get('articles', art1.id).quantite, avant);
        assert.equal(r.nbEntreesStock, 0);
      } finally { await admin.ok('PUT', '/api/configuration', { achats: { entreeStockAReception: true } }); }
    });

    test('au-delà du seuil : à valider, valideurs notifiés, pas d\'auto-validation, refus puis validation', async () => {
      const c = await clients.respmaint.ok('POST', '/api/commandes', corpsCommande({ lignes: [{ designation: 'Motoréducteur 4 kW', quantite: 1, prixUnitaireHT: 1450 }] }));
      const s = await clients.respmaint.ok('POST', `/api/commandes/${c.id}/soumettre`);
      assert.equal(s.statut, 'a_valider');
      assert.equal(s.validationRequise, true);
      assert.equal(s.actions.validationPropreInterdite, true);
      const notifs = srv.db.list('notifications', (n) => /Commande à valider/.test(n.titre) && n.lien === '#/achats/commande/' + c.id);
      const cibles = notifs.map((n) => n.userId);
      assert.ok(cibles.includes(1) && cibles.includes(users.acheteur.id), 'administrateur et acheteur notifiés');
      assert.ok(!cibles.includes(users.respmaint.id), 'le demandeur ne se notifie pas lui-même');
      const propre = await clients.respmaint.post(`/api/commandes/${c.id}/valider`);
      assert.equal(propre.status, 403);
      assert.match(propre.body.erreur, /propre commande/);
      // Refus (motif obligatoire) → retour en brouillon
      assert.equal((await clients.acheteur.post(`/api/commandes/${c.id}/refuser`, {})).status, 400);
      const ref = await clients.acheteur.ok('POST', `/api/commandes/${c.id}/refuser`, { motif: 'Demander un second devis' });
      assert.equal(ref.statut, 'brouillon');
      assert.equal(ref.motifRefus, 'Demander un second devis');
      assert.ok(srv.db.list('notifications', (n) => n.userId === users.respmaint.id && /refusée/.test(n.titre)).length);
      // Nouvelle soumission puis validation par un autre valideur
      await clients.respmaint.ok('POST', `/api/commandes/${c.id}/soumettre`);
      const v = await clients.acheteur.ok('POST', `/api/commandes/${c.id}/valider`, { commentaire: 'OK après second devis' });
      assert.equal(v.statut, 'validee');
      assert.equal(v.valideurUserId, users.acheteur.id);
      assert.ok(v.dateValidation);
      assert.ok(v.historique.some((h) => h.action === 'refus') && v.historique.some((h) => h.action === 'validation'));
      assert.equal((await clients.acheteur.post(`/api/commandes/${c.id}/valider`)).status, 400, 'déjà validée');
      // Après validation : lignes verrouillées, mais livraison / commentaire modifiables
      const bloque = await admin.put('/api/commandes/' + c.id, { lignes: [{ designation: 'Autre', quantite: 1, prixUnitaireHT: 1 }] });
      assert.equal(bloque.status, 400);
      assert.match(bloque.body.erreur, /ne sont plus modifiables/);
      const m = await admin.ok('PUT', '/api/commandes/' + c.id, { dateLivraisonPrevue: jour(20), commentaire: 'Livraison quai 2' });
      assert.equal(m.dateLivraisonPrevue, jour(20));
      assert.equal(m.totaux.ht, 1450);
      // L'administrateur peut valider sa propre commande au-delà du seuil
      const a = await admin.ok('POST', '/api/commandes', corpsCommande({ lignes: [{ designation: 'Pompe', quantite: 1, prixUnitaireHT: 2000 }] }));
      await admin.ok('POST', `/api/commandes/${a.id}/soumettre`);
      assert.equal((await admin.ok('POST', `/api/commandes/${a.id}/valider`)).statut, 'validee');
    });

    test('annulation (motif obligatoire) et solde d\'un reliquat', async () => {
      const c = await admin.ok('POST', '/api/commandes', corpsCommande());
      assert.equal((await admin.post(`/api/commandes/${c.id}/annuler`, {})).status, 400);
      const a = await admin.ok('POST', `/api/commandes/${c.id}/annuler`, { motif: 'Doublon' });
      assert.equal(a.statut, 'annulee');
      assert.equal(a.motifAnnulation, 'Doublon');
      assert.equal((await admin.post(`/api/commandes/${c.id}/soumettre`)).status, 400);
      const p = await admin.ok('POST', '/api/commandes', corpsCommande());
      await admin.ok('POST', `/api/commandes/${p.id}/soumettre`);
      await admin.ok('POST', `/api/commandes/${p.id}/receptionner`, { lignes: [{ index: 1, quantite: 1 }] });
      const refus = await admin.post(`/api/commandes/${p.id}/annuler`, { motif: 'x' });
      assert.equal(refus.status, 400);
      assert.match(refus.body.erreur, /soldez/);
      assert.equal((await admin.post(`/api/commandes/${p.id}/solder`, {})).status, 400, 'motif obligatoire');
      const s = await admin.ok('POST', `/api/commandes/${p.id}/solder`, { motif: 'Reliquat abandonné' });
      assert.equal(s.statut, 'recue');
      assert.equal(s.solde, true);
    });

    test('brouillons depuis les alertes de stock, regroupés par fournisseur, sans doublon', async () => {
      srv.db.update('articles', art1.id, { quantite: 1 });
      const alertes = await clients.acheteur.ok('GET', '/api/achats/alertes-stock');
      const a2 = alertes.find((x) => x.id === art2.id);
      assert.ok(a2, 'article en rupture listé');
      assert.equal(a2.fournisseurNom, 'Électricité Provence');
      const sans = await clients.acheteur.post('/api/commandes/depuis-alertes', { articleIds: [art2.id] });
      assert.equal(sans.status, 400, 'site obligatoire si les articles n\'ont pas de magasin');
      const r = await clients.acheteur.ok('POST', '/api/commandes/depuis-alertes', { secteurId: MAINT.id, lignes: [{ articleId: art2.id }, { articleId: art1.id, quantite: 7 }] });
      assert.equal(r.commandes.length, 2, 'une commande par fournisseur');
      const c2 = r.commandes.find((c) => c.fournisseurId === four2.id);
      assert.equal(c2.statut, 'brouillon');
      assert.equal(c2.lignes[0].quantite, 4, 'quantité proposée par le stock (2 × seuil − stock)');
      assert.equal(c2.lignes[0].prixUnitaireHT, 70);
      assert.equal(c2.secteurId, MAINT.id);
      const c1 = r.commandes.find((c) => c.fournisseurId === four1.id);
      assert.equal(c1.lignes[0].quantite, 7, 'quantité forcée');
      const r2 = await clients.acheteur.ok('POST', '/api/commandes/depuis-alertes', { secteurId: MAINT.id, articleIds: [art2.id] });
      assert.equal(r2.commandes.length, 0);
      assert.match(r2.ignores[0].raison, /Déjà en commande/);
      const al2 = await clients.acheteur.ok('GET', '/api/achats/alertes-stock');
      assert.equal(al2.find((x) => x.id === art2.id).dejaEnCommande, 4);
      for (const c of r.commandes) await admin.ok('DELETE', '/api/commandes/' + c.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Factures', () => {
    let cmd;
    before(async () => {
      cmd = await admin.ok('POST', '/api/commandes', corpsCommande({ lignes: [{ designation: 'Courroie', quantite: 10, prixUnitaireHT: 20 }] }));
      await admin.ok('POST', `/api/commandes/${cmd.id}/soumettre`);
      await admin.ok('POST', `/api/commandes/${cmd.id}/receptionner`, { lignes: [{ index: 0, quantite: 6 }] });
    });

    test('saisie liée à une commande : fournisseur et site repris, TVA / TTC / échéance calculés, rapprochement', async () => {
      const f = await clients.acheteur.ok('POST', '/api/factures', { commandeId: cmd.id, numeroFournisseur: 'F-2026-001', dateFacture: jour(-2), montantHT: 120 });
      assert.match(f.numero, new RegExp(`^FAC-${new Date().getFullYear()}-\\d{4}$`));
      assert.equal(f.fournisseurId, four1.id);
      assert.equal(f.secteurId, MAINT.id);
      assert.equal(f.categorieCode, 'pieces');
      assert.equal(f.objet, 'Pièces de rechange');
      assert.equal(f.montantTVA, 24);
      assert.equal(f.montantTTC, 144);
      assert.equal(f.dateEcheance, jour(28), 'échéance = date + config.achats.delaiPaiementJours (30)');
      assert.equal(f.statut, 'recue');
      assert.equal(f.rapprochement.base, 'recu');
      assert.equal(f.rapprochement.recuHT, 120);
      assert.equal(f.rapprochement.ecartHT, 0);
      assert.equal(f.rapprochement.conforme, true);
      const detail = await admin.ok('GET', `/api/factures/${f.id}/rapprochement`);
      assert.equal(detail.lignes[0].quantiteRecue, 6);
      assert.equal(detail.commande.numero, cmd.numero);
      const c = await admin.ok('GET', '/api/commandes/' + cmd.id);
      assert.equal(c.montantFactureHT, 120);
      assert.equal(c.factures.length, 1);
    });

    test('contrôles : TTC = HT + TVA (à 0,01 près), unicité fournisseur + numéro, cohérence avec la commande', async () => {
      const base = { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'E-100', dateFacture: jour(-1) };
      let r = await admin.post('/api/factures', Object.assign({}, base, { montantHT: 100, montantTVA: 20, montantTTC: 121 }));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /TTC incohérent/);
      const ok = await admin.ok('POST', '/api/factures', Object.assign({}, base, { montantHT: 100, montantTVA: 20, montantTTC: 120.01, objet: 'Câbles' }));
      assert.equal(ok.montantTTC, 120.01);
      r = await admin.post('/api/factures', Object.assign({}, base, { numeroFournisseur: ' e-100 ', montantHT: 5 }));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /déjà enregistrée/);
      const autre = await admin.ok('POST', '/api/factures', Object.assign({}, base, { fournisseurId: four1.id, montantHT: 5 }));
      assert.equal(autre.numeroFournisseur, 'E-100', 'même numéro chez un autre fournisseur : accepté');
      for (const [modif, attendu] of [
        [{ numeroFournisseur: '' }, /N° de facture du fournisseur/],
        [{ numeroFournisseur: 'X1', montantHT: null }, /montant HT est obligatoire/],
        [{ numeroFournisseur: 'X2', montantHT: -5 }, /Montant HT/],
        [{ numeroFournisseur: 'X3', montantHT: 10, dateEcheance: jour(-10) }, /échéance ne peut pas précéder/],
        [{ numeroFournisseur: 'X4', montantHT: 10, commandeId: cmd.id }, /fournisseur de la facture doit être celui de la commande/],
        [{ numeroFournisseur: 'X5', montantHT: 10, personnelId: 9999 }, /personnel introuvable/i],
        [{ numeroFournisseur: 'X6', montantHT: 10, otId: 9999 }, /Ordre de travail introuvable/],
        [{ numeroFournisseur: 'X7', montantHT: 99, lignes: [{ designation: 'A', quantite: 2, prixUnitaireHT: 10 }] }, /ne correspond pas au total des lignes/],
        [{ numeroFournisseur: 'X8', secteurId: null, montantHT: 10 }, /rattachement est obligatoire/],
      ]) {
        const x = await admin.post('/api/factures', Object.assign({}, base, modif));
        assert.equal(x.status, 400, `${JSON.stringify(modif)} → ${JSON.stringify(x.body)}`);
        assert.match(x.body.erreur, attendu);
      }
      // Lignes facultatives : HT / TVA calculés depuis les lignes
      const l = await admin.ok('POST', '/api/factures', Object.assign({}, base, { numeroFournisseur: 'E-101', lignes: [{ designation: 'Main-d\'œuvre', quantite: 3, prixUnitaireHT: 50 }, { designation: 'Déplacement', quantite: 1, prixUnitaireHT: 45.5, tauxTVA: 10 }] }));
      assert.equal(l.montantHT, 195.5);
      assert.equal(l.montantTVA, 34.55);
      assert.equal(l.montantTTC, 230.05);
      // Une commande non validée ne peut pas être facturée
      const brouillon = await admin.ok('POST', '/api/commandes', corpsCommande());
      r = await admin.post('/api/factures', { commandeId: brouillon.id, numeroFournisseur: 'B-1', montantHT: 10 });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /n'est pas validée/);
      await admin.ok('DELETE', '/api/commandes/' + brouillon.id);
    });

    test('circuit : soumission, validation avec écart de rapprochement (409 puis forcée), paiement, statut final', async () => {
      const f = await admin.ok('POST', '/api/factures', { commandeId: cmd.id, numeroFournisseur: 'F-2026-002', montantHT: 95 });
      assert.equal(f.rapprochement.ecartHT, 95, 'déjà facturé 120 pour 120 reçus : tout dépassement est un écart');
      assert.equal(f.rapprochement.conforme, false);
      const s = await clients.acheteur.ok('POST', `/api/factures/${f.id}/soumettre`);
      assert.equal(s.statut, 'a_valider');
      assert.ok(srv.db.list('notifications', (n) => /Facture à valider/.test(n.titre) && n.userId === users.respmaint.id).length, 'valideurs notifiés');
      const refus = await clients.respmaint.post(`/api/factures/${f.id}/valider`, {});
      assert.equal(refus.status, 409);
      assert.equal(refus.body.details.rapprochement.ecartHT, 95);
      assert.equal((await clients.respmaint.post(`/api/factures/${f.id}/valider`, { forcer: true })).status, 400, 'justification obligatoire');
      const v = await clients.respmaint.ok('POST', `/api/factures/${f.id}/valider`, { forcer: true, commentaire: 'Port et emballage acceptés' });
      assert.equal(v.statut, 'validee');
      assert.equal(v.valideurUserId, users.respmaint.id);
      // Facture bon à payer : montants verrouillés, échéance modifiable
      const bloque = await admin.put('/api/factures/' + f.id, { montantHT: 10 });
      assert.equal(bloque.status, 400); assert.match(bloque.body.erreur, /litige/);
      const ech = await admin.ok('PUT', '/api/factures/' + f.id, { dateEcheance: jour(40) });
      assert.equal(ech.dateEcheance, jour(40));
      // Paiement
      for (const [corps, attendu] of [[{}, /mode de paiement est obligatoire/], [{ modePaiement: 'troc' }, /Mode de paiement invalide/], [{ modePaiement: 'virement', datePaiement: jour(10) }, /futur/], [{ modePaiement: 'virement', datePaiement: '2000-01-01' }, /précéder/]]) {
        const r = await clients.acheteur.post(`/api/factures/${f.id}/payer`, corps);
        assert.equal(r.status, 400, JSON.stringify(corps)); assert.match(r.body.erreur, attendu);
      }
      const p = await clients.acheteur.ok('POST', `/api/factures/${f.id}/payer`, { modePaiement: 'virement', reference: 'VIR-42', datePaiement: jour(0) });
      assert.equal(p.statut, 'payee');
      assert.equal(p.datePaiement, jour(0));
      assert.equal(p.referencePaiement, 'VIR-42');
      assert.equal(p.modePaiementLibelle, 'Virement bancaire');
      assert.ok(evenements.some((e) => e[0] === 'facturePayee' && e[1] === f.id));
      assert.equal((await admin.put('/api/factures/' + f.id, { objet: 'x' })).status, 400, 'facture payée non modifiable');
      assert.equal((await admin.del('/api/factures/' + f.id)).status, 400, 'facture payée non supprimable');
      assert.equal((await admin.post(`/api/factures/${f.id}/annuler`, { motif: 'x' })).status, 400);
    });

    test('litige, commentaires, annulation, suppression', async () => {
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'L-1', montantHT: 50, commentaire: 'Reçue par courrier' });
      assert.equal(f.commentaires.length, 1);
      assert.equal((await admin.post(`/api/factures/${f.id}/litige`, {})).status, 400);
      const l = await admin.ok('POST', `/api/factures/${f.id}/litige`, { motif: 'Quantité facturée erronée' });
      assert.equal(l.statut, 'litige');
      assert.equal(l.motifLitige, 'Quantité facturée erronée');
      const corr = await admin.ok('PUT', '/api/factures/' + f.id, { montantHT: 40 });
      assert.equal(corr.montantTTC, 48, 'correction des montants en litige (TVA et TTC recalculés)');
      const c = await admin.ok('POST', `/api/factures/${f.id}/commentaires`, { texte: 'Avoir demandé' });
      assert.equal(c.commentaires.length, 3);
      assert.equal((await admin.post(`/api/factures/${f.id}/commentaires`, { texte: '' })).status, 400);
      const v = await admin.ok('POST', `/api/factures/${f.id}/valider`, {});
      assert.equal(v.statut, 'validee', 'résolution du litige par validation');
      const a = await admin.ok('POST', `/api/factures/${f.id}/annuler`, { motif: 'Remplacée par un avoir' });
      assert.equal(a.statut, 'annulee');
      // Un numéro annulé peut être ressaisi
      const re = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'L-1', montantHT: 40 });
      await admin.ok('DELETE', '/api/factures/' + re.id);
      await admin.ok('DELETE', '/api/factures/' + f.id);
      assert.equal((await admin.get('/api/factures/' + f.id)).status, 404);
    });

    test('pièces jointes : identifiant stable (uid) ; une suppression rejouée ne retire pas la pièce suivante', async () => {
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'PJ-UID', montantHT: 10 });
      const r1 = await admin.ok('POST', `/api/factures/${f.id}/documents`, { nom: 'un.pdf', type: 'application/pdf', contenu: dataUrl('application/pdf', PDF) });
      const r2 = await admin.ok('POST', `/api/factures/${f.id}/documents`, { nom: 'deux.png', type: 'image/png', contenu: dataUrl('image/png', PNG) });
      const [d1, d2] = r2.documents;
      assert.equal(r1.documents.length, 1);
      assert.ok(/^u[0-9a-f]{10}$/.test(d1.uid) && d1.uid !== d2.uid, 'uid posé à l\'ajout');
      assert.match((await admin.get(`/api/factures/${f.id}/documents/${d2.uid}`)).headers.get('content-type'), /image\/png/, 'lecture par uid');
      const sup = await admin.ok('DELETE', `/api/factures/${f.id}/documents/${d1.uid}`);
      assert.deepEqual(sup.documents.map((d) => d.nom), ['deux.png']);
      assert.equal((await admin.del(`/api/factures/${f.id}/documents/${d1.uid}`)).status, 404, 'requête rejouée : 404, la pièce suivante est conservée');
      assert.equal(srv.db.get('factures', f.id).documents.length, 1);
      await admin.ok('DELETE', '/api/factures/' + f.id);
    });

    test('pièces jointes : PDF / image ≤ 10 Mo, signature contrôlée, aperçu et suppression', async () => {
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'PJ-1', montantHT: 10 });
      const d = await admin.ok('POST', `/api/factures/${f.id}/documents`, { nom: 'facture.pdf', type: 'application/pdf', contenu: dataUrl('application/pdf', PDF) });
      assert.equal(d.documents.length, 1);
      assert.equal(d.documents[0].estPdf, true);
      await admin.ok('POST', `/api/factures/${f.id}/documents`, { nom: 'scan.png', type: 'image/png', contenu: dataUrl('image/png', PNG) });
      for (const [corps, attendu] of [
        [{ nom: 'a.txt', type: 'text/plain', contenu: dataUrl('text/plain', Buffer.from('bonjour')) }, /PDF ou image/],
        [{ nom: 'faux.pdf', type: 'application/pdf', contenu: dataUrl('application/pdf', Buffer.from('<html>pas un pdf</html>')) }, /ne correspond pas/],
        [{ nom: 'vide.pdf', type: 'application/pdf', contenu: 'data:application/pdf;base64,' }, /vide/],
        [{ nom: 'x.pdf', contenu: 'pas une data url' }, /base64/],
        [{ nom: 'gros.pdf', type: 'application/pdf', contenu: dataUrl('application/pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])) }, /trop volumineux/],
      ]) {
        const r = await admin.post(`/api/factures/${f.id}/documents`, corps);
        assert.equal(r.status, 400, corps.nom); assert.match(r.body.erreur, attendu);
      }
      const brut = await fetch(`${srv.base}/api/factures/${f.id}/documents/0`, { headers: { cookie: await cookieAdmin() } });
      assert.equal(brut.status, 200);
      assert.equal(brut.headers.get('content-type'), 'application/pdf');
      assert.match(brut.headers.get('content-disposition'), /^inline/);
      assert.ok(Buffer.from(await brut.arrayBuffer()).subarray(0, 5).toString() === '%PDF-');
      const sup = await admin.ok('DELETE', `/api/factures/${f.id}/documents/0`);
      assert.equal(sup.documents.length, 1);
      assert.equal((await admin.get(`/api/factures/${f.id}/documents/5`)).status, 404);
      // Commande : formats bureautiques acceptés
      const c = await admin.ok('POST', '/api/commandes', corpsCommande());
      await admin.ok('POST', `/api/commandes/${c.id}/documents`, { nom: 'devis.txt', type: 'text/plain', contenu: dataUrl('text/plain', Buffer.from('Devis n° 12')) });
      const dc = await admin.ok('GET', '/api/commandes/' + c.id);
      assert.equal(dc.documents.length, 1);
      assert.equal(dc.documents[0].contenu, undefined, 'le contenu n\'est pas renvoyé dans la fiche');
      await admin.ok('DELETE', `/api/commandes/${c.id}/documents/0`);
      await admin.ok('DELETE', '/api/commandes/' + c.id);
    });

    async function cookieAdmin() {
      const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) });
      return r.headers.get('set-cookie').split(';')[0];
    }

    test('facture liée à un OT et à une fiche du personnel ; services ctx.services.achats', async () => {
      const pers = srv.db.insert('personnel', { nom: 'Durand', prenom: 'Léa', matricule: 'M-01', secteurId: MAINT.id, actif: true });
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, numeroFournisseur: 'FORM-1', personnelId: pers.id, montantHT: 900 });
      assert.equal(f.secteurId, MAINT.id, 'site repris de la fiche du personnel');
      assert.equal(f.categorieCode, 'formation');
      assert.equal(f.personnelNom, 'Léa Durand');
      const o = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, numeroFournisseur: 'ST-1', otId: ot1.id, montantHT: 300, montantTVA: 60 });
      assert.equal(o.categorieCode, 'sous_traitance');
      assert.equal(o.otNumero, 'OT-T-0001');
      assert.equal(srv.ctx.services.achats.totalFactureOt(ot1.id), 300);
      assert.deepEqual(srv.ctx.services.achats.totauxFacturesOt(ot1.id), { ht: 300, tva: 60, ttc: 360, nombre: 1, payeTTC: 0 });
      assert.equal(srv.ctx.services.achats.facturesPourOt(ot1.id).length, 1);
      const couts = await admin.ok('GET', '/api/achats/couts-ot/' + ot1.id);
      assert.equal(couts.totalFactureHT, 300);
      assert.equal(couts.totalFactureTTC, 360);
      const liste = await admin.ok('GET', '/api/factures?personnelId=' + pers.id);
      assert.deepEqual(liste.map((x) => x.id), [f.id]);
    });

    test('échéances : retard, échéancier par semaine, notification unique des valideurs', async () => {
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four2.id, secteurId: MAINT.id, numeroFournisseur: 'RET-1', dateFacture: jour(-40), dateEcheance: jour(-10), montantHT: 500 });
      assert.equal(f.enRetard, true);
      assert.equal(f.joursRetard, 10);
      const retards = await admin.ok('GET', '/api/factures?echeanceDepassee=1');
      assert.ok(retards.some((x) => x.id === f.id) && retards.every((x) => x.enRetard));
      const e = await admin.ok('GET', '/api/achats/echeancier');
      assert.ok(e.enRetard.factures.some((x) => x.id === f.id));
      assert.ok(e.semaines.length >= 1 && e.semaines.every((s) => /^\d{4}-S\d{2}$/.test(s.cle) && s.debut <= s.fin));
      const r1 = await clients.respmaint.ok('POST', '/api/achats/verifier-echeances');
      assert.ok(r1.nbRetard >= 1 && r1.nbNotifiees >= 1);
      const n1 = srv.db.count('notifications', (n) => n.lien === '#/achats/facture/' + f.id && /retard/.test(n.titre));
      assert.ok(n1 >= 2, 'valideurs notifiés (administrateur, acheteur, responsable maintenance)');
      await clients.respmaint.ok('POST', '/api/achats/verifier-echeances');
      assert.equal(srv.db.count('notifications', (n) => n.lien === '#/achats/facture/' + f.id && /retard/.test(n.titre)), n1, 'une seule notification par facture');
      assert.equal((await clients.chefprod.post('/api/achats/verifier-echeances')).status, 403);
    });

    test('tableau de bord : engagé, facturé, payé, à payer, en retard, ventilations', async () => {
      const t = await admin.ok('GET', '/api/achats/tableau');
      assert.ok(t.kpis.engageHT > 0 && t.kpis.factureHT > 0 && t.kpis.payeTTC > 0);
      assert.ok(t.kpis.nbEnRetard >= 1 && t.kpis.enRetardTTC >= 600);
      assert.equal(t.parMois.length, 12);
      assert.ok(t.parMois.every((m) => /^\d{4}-\d{2}$/.test(m.mois)));
      assert.ok(t.parCategorie.some((c) => c.code === 'pieces' && c.couleur));
      assert.ok(t.parFournisseur.some((x) => x.label === 'Roulements du Midi'));
      assert.ok(t.parSite.some((x) => x.siteId === SITE.id));
      assert.ok(Array.isArray(t.aPayer) && Array.isArray(t.enRetard) && Array.isArray(t.commandesAValider));
      assert.equal((await admin.get('/api/achats/tableau?du=2026-12-01&au=2026-01-01')).status, 400);
      assert.equal((await admin.get('/api/achats/tableau?du=xx')).status, 400);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Exports CSV', () => {
    test('commandes, lignes, factures, échéancier (droit exporter)', async () => {
      for (const quoi of ['commandes', 'lignes', 'factures', 'echeancier']) {
        const r = await admin.brut('/api/achats/export/' + quoi);
        assert.equal(r.status, 200, quoi);
        assert.match(r.headers.get('content-type'), /text\/csv/);
        assert.match(r.headers.get('content-disposition'), /attachment; filename=".+\.csv"/);
        assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 pour Excel');
        assert.ok(r.buf.toString('utf8').split('\r\n')[0].includes(';'));
      }
      const f = await admin.get('/api/achats/export/factures');
      assert.match(String(f.body), /N° interne;N° fournisseur/);
      assert.equal((await admin.get('/api/achats/export/inconnu')).status, 404);
      assert.equal((await clients.chefprod.get('/api/achats/export/commandes')).status, 403, 'chef de secteur sans droit exporter');
      assert.ok(srv.db.list('audit').some((a) => a.action === 'export' && a.entite === 'factures'));
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Droits et portée', () => {
    test('sans droit achats : 403 sur toutes les routes', async () => {
      for (const [m, u] of [['get', '/api/commandes'], ['get', '/api/factures'], ['get', '/api/achats/tableau'], ['get', '/api/achats/echeancier'], ['get', '/api/achats/references'], ['post', '/api/commandes'], ['post', '/api/factures']]) {
        const r = await clients.tech[m](u, m === 'post' ? {} : undefined);
        assert.equal(r.status, 403, `${m} ${u}`);
      }
    });

    test('chef de secteur (voir + créer, portée secteurs) : ses brouillons uniquement, pas de validation ni d\'envoi', async () => {
      const hors = await clients.chefprod.post('/api/commandes', corpsCommande({ secteurId: MAINT.id }));
      assert.equal(hors.status, 403);
      assert.match(hors.body.erreur, /hors de votre périmètre/);
      const c = await clients.chefprod.ok('POST', '/api/commandes', corpsCommande({ secteurId: PROD.id }));
      assert.equal(c.demandeurUserId, users.chefprod.id);
      const m = await clients.chefprod.ok('PUT', '/api/commandes/' + c.id, { objet: 'Modifié par son auteur' });
      assert.equal(m.objet, 'Modifié par son auteur');
      const liste = await clients.chefprod.ok('GET', '/api/commandes');
      assert.ok(liste.length >= 1 && liste.every((x) => [PROD.id].concat(secteurs.filter((s) => s.parentId === PROD.id).map((s) => s.id)).includes(x.secteurId)), 'uniquement ses secteurs');
      const autre = (await admin.ok('GET', '/api/commandes')).find((x) => x.secteurId === MAINT.id);
      assert.equal((await clients.chefprod.get('/api/commandes/' + autre.id)).status, 404);
      const s = await clients.chefprod.ok('POST', `/api/commandes/${c.id}/soumettre`);
      assert.equal(s.statut, 'validee');
      assert.equal((await clients.chefprod.post(`/api/commandes/${c.id}/envoyer`)).status, 403);
      assert.equal((await clients.chefprod.put('/api/commandes/' + c.id, { objet: 'x' })).status, 403, 'commande validée : modification réservée');
      assert.equal((await clients.chefprod.post(`/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 1 }] })).status, 403);
      // Brouillon d'un autre utilisateur du même secteur : non modifiable par le chef (pas de droit modifier)
      const b = await admin.ok('POST', '/api/commandes', corpsCommande({ secteurId: PROD.id }));
      assert.equal((await clients.chefprod.put('/api/commandes/' + b.id, { objet: 'x' })).status, 403);
      assert.equal((await clients.chefprod.post(`/api/commandes/${b.id}/soumettre`)).status, 403);
      const big = await admin.ok('POST', '/api/commandes', corpsCommande({ secteurId: PROD.id, lignes: [{ designation: 'Gros', quantite: 1, prixUnitaireHT: 5000 }] }));
      await admin.ok('POST', `/api/commandes/${big.id}/soumettre`);
      assert.equal((await clients.chefprod.post(`/api/commandes/${big.id}/valider`)).status, 403);
      assert.equal((await clients.chefprod.post('/api/factures', { fournisseurId: four1.id, secteurId: PROD.id, numeroFournisseur: 'CH-1', montantHT: 10 })).status, 200, 'saisie de facture (droit créer)');
      const fac = (await clients.chefprod.ok('GET', '/api/factures')).find((x) => x.numeroFournisseur === 'CH-1');
      assert.equal((await clients.chefprod.post(`/api/factures/${fac.id}/valider`)).status, 403);
      assert.equal((await clients.chefprod.post(`/api/factures/${fac.id}/litige`, { motif: 'x' })).status, 403);
    });

    test('responsable maintenance : pas de droit supprimer (hors ses propres brouillons)', async () => {
      const c = await admin.ok('POST', '/api/commandes', corpsCommande());
      assert.equal((await clients.respmaint.del('/api/commandes/' + c.id)).status, 403);
      const p = await clients.respmaint.ok('POST', '/api/commandes', corpsCommande());
      await clients.respmaint.ok('DELETE', '/api/commandes/' + p.id);
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: four1.id, secteurId: MAINT.id, numeroFournisseur: 'SUP-1', montantHT: 10 });
      assert.equal((await clients.respmaint.del('/api/factures/' + f.id)).status, 403);
      await admin.ok('DELETE', '/api/factures/' + f.id);
      await admin.ok('DELETE', '/api/commandes/' + c.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Multi-site', () => {
    let valreas; let valMaint; let cmdV; let facV; let cmdC;
    before(async () => {
      valreas = await admin.ok('POST', '/api/secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site' });
      valMaint = await admin.ok('POST', '/api/secteurs', { nom: 'Maintenance Valréas', code: 'VAL-MAINT', type: 'service', parentId: valreas.id });
      cmdV = await admin.ok('POST', '/api/commandes', corpsCommande({ secteurId: valMaint.id, objet: 'Commande Valréas' }));
      await admin.ok('POST', `/api/commandes/${cmdV.id}/soumettre`);
      facV = await admin.ok('POST', '/api/factures', { fournisseurId: four1.id, secteurId: valMaint.id, numeroFournisseur: 'VAL-F1', montantHT: 250 });
      cmdC = await admin.ok('POST', '/api/commandes', corpsCommande({ secteurId: MAINT.id, objet: 'Commande Carpentras' }));
    });

    test('un acheteur rattaché au site 1 (portée site) ne voit pas les achats du site 2', async () => {
      const cmds = await clients.acheteur.ok('GET', '/api/commandes');
      assert.ok(cmds.some((c) => c.id === cmdC.id));
      assert.ok(!cmds.some((c) => c.id === cmdV.id));
      assert.ok(!(await clients.acheteur.ok('GET', '/api/factures')).some((f) => f.id === facV.id));
      assert.equal((await clients.acheteur.get('/api/commandes/' + cmdV.id)).status, 404);
      assert.equal((await clients.acheteur.get('/api/factures/' + facV.id)).status, 404);
      assert.equal((await clients.acheteur.post(`/api/commandes/${cmdV.id}/envoyer`)).status, 404);
      const t = await clients.acheteur.ok('GET', '/api/achats/tableau');
      assert.ok(!t.parSite.some((s) => s.siteId === valreas.id));
      const e = await clients.acheteur.ok('GET', '/api/achats/echeancier');
      assert.ok(!e.semaines.concat([e.enRetard]).some((s) => s.factures.some((f) => f.id === facV.id)));
      const csv = await clients.acheteur.get('/api/achats/export/factures');
      assert.ok(!String(csv.body).includes('VAL-F1'));
      const r = await clients.acheteur.post('/api/commandes', corpsCommande({ secteurId: valMaint.id }));
      assert.equal(r.status, 403, 'création sur un site non autorisé');
    });

    test('accès en lecture seule au site 2 : consultation possible, modification refusée (403)', async () => {
      await admin.ok('PUT', '/api/utilisateurs/' + users.acheteur.id, { siteAcces: [{ siteId: valreas.id, mode: 'lecture' }] });
      const c = clientSite(null);
      await c.login('acheteur', 'pass1234');
      const cmds = await c.ok('GET', '/api/commandes');
      assert.ok(cmds.some((x) => x.id === cmdV.id), 'lecture des commandes du site 2');
      const d = await c.ok('GET', '/api/commandes/' + cmdV.id);
      assert.equal(d.lectureSeule, true);
      assert.ok(Object.entries(d.actions).filter(([k]) => k !== 'validationPropreInterdite').every(([, v]) => v === false), 'aucune action proposée');
      assert.ok((await c.ok('GET', '/api/factures/' + facV.id)).lectureSeule);
      for (const [m, u, b] of [
        ['post', `/api/commandes/${cmdV.id}/envoyer`, {}], ['put', '/api/commandes/' + cmdV.id, { objet: 'x' }], ['post', `/api/commandes/${cmdV.id}/annuler`, { motif: 'x' }],
        ['post', `/api/factures/${facV.id}/valider`, {}], ['post', `/api/factures/${facV.id}/litige`, { motif: 'x' }], ['post', `/api/factures/${facV.id}/commentaires`, { texte: 'x' }],
        ['post', `/api/factures/${facV.id}/documents`, { nom: 'a.pdf', type: 'application/pdf', contenu: dataUrl('application/pdf', PDF) }],
      ]) {
        const r = await c[m](u, b);
        assert.equal(r.status, 403, `${m} ${u} → ${JSON.stringify(r.body)}`);
        assert.match(r.body.erreur, /lecture seule/);
      }
      const cr = await c.post('/api/commandes', corpsCommande({ secteurId: valMaint.id }));
      assert.equal(cr.status, 403);
      assert.match(cr.body.erreur, /lecture seule/);
      await admin.ok('PUT', '/api/utilisateurs/' + users.acheteur.id, { siteAcces: [] });
    });

    test('l\'en-tête X-GMAO-Site filtre les listes, le tableau de bord et les exports', async () => {
      const a = clientSite(valreas.id);
      await a.login('admin', 'admin');
      const cmds = await a.ok('GET', '/api/commandes');
      assert.ok(cmds.length >= 1 && cmds.every((c) => c.siteId === valreas.id));
      const facs = await a.ok('GET', '/api/factures');
      assert.deepEqual(facs.map((f) => f.id), [facV.id]);
      const t = await a.ok('GET', '/api/achats/tableau');
      assert.deepEqual(t.parSite.map((s) => s.siteId), [valreas.id]);
      a.setSite(SITE.id);
      const cmdsC = await a.ok('GET', '/api/commandes');
      assert.ok(cmdsC.every((c) => c.siteId === SITE.id) && !cmdsC.some((c) => c.id === cmdV.id));
      assert.equal((await a.get('/api/commandes/' + cmdV.id)).status, 404, 'hors du site affiché');
      a.setSite('tous');
      assert.ok((await a.ok('GET', '/api/commandes')).some((c) => c.id === cmdV.id));
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Références et données de démonstration', () => {
    test('références des formulaires sans droits sur les autres modules', async () => {
      const r = await clients.acheteur.ok('GET', '/api/achats/references');
      assert.ok(r.fournisseurs.some((f) => f.id === four1.id));
      assert.ok(r.articles.some((a) => a.id === art1.id) && !r.articles.some((a) => a.id === artInactif.id));
      assert.ok(r.modesPaiement.some((m) => m.code === 'virement'));
      assert.equal(r.config.seuilValidationHT, 1000);
      assert.equal(r.stockDisponible, true);
      assert.ok(r.commandes.every((c) => ['validee', 'envoyee', 'partielle', 'recue'].includes(c.statut)));
    });

    test('seedDemo : idempotent, tous les statuts, liens fournisseurs / OT / personnel, site de Valréas', async () => {
      const autre = await demarrer();
      try {
        const sec = autre.db.list('secteurs');
        const site = sec.find((s) => s.code === 'SITE');
        const val = autre.db.insert('secteurs', { nom: 'Usine de Valréas', code: 'VAL', type: 'site', parentId: null, actif: true, ordre: 2 });
        autre.db.insert('secteurs', { nom: 'Maintenance', code: 'VAL-MAINT', type: 'service', parentId: val.id, actif: true });
        autre.db.insert('secteurs', { nom: 'Logistique', code: 'VAL-LOG', type: 'service', parentId: val.id, actif: true });
        const rapport = require('../server/modules').seedDemo(autre.ctx);
        assert.ok(rapport.every((x) => x.ok), JSON.stringify(rapport.filter((x) => !x.ok)));
        const mod = autre.ctx.modules.find((m) => m.fichier === 'achats.js');
        assert.match(mod.seedDemo(autre.ctx), /déjà présents/);
        const cmds = autre.db.list('commandes');
        const facs = autre.db.list('factures');
        const nbC = cmds.length; const nbF = facs.length;
        assert.ok(nbC >= 8 && nbF >= 10);
        for (const st of ['brouillon', 'a_valider', 'validee', 'envoyee', 'partielle', 'recue', 'annulee']) assert.ok(cmds.some((c) => c.statut === st), `commande ${st}`);
        for (const st of ['recue', 'a_valider', 'validee', 'payee', 'litige', 'annulee']) assert.ok(facs.some((f) => f.statut === st), `facture ${st}`);
        assert.ok(cmds.every((c) => autre.db.get('fournisseurs', c.fournisseurId) && autre.db.get('secteurs', c.secteurId)));
        assert.ok(facs.every((f) => autre.db.get('fournisseurs', f.fournisseurId) && autre.db.get('secteurs', f.secteurId)));
        assert.ok(cmds.every((c) => { const t = require('../server/modules/achats').calculerTotaux(c.lignes); return t.ht === c.totaux.ht && t.ttc === c.totaux.ttc; }), 'totaux cohérents');
        assert.ok(facs.every((f) => Math.abs(f.montantTTC - (f.montantHT + f.montantTVA)) <= 0.01), 'TTC = HT + TVA');
        const jourJ = jour(0);
        assert.equal(facs.filter((f) => ['recue', 'a_valider', 'validee', 'litige'].includes(f.statut) && f.dateEcheance < jourJ).length, 1, 'une facture en retard');
        assert.ok(facs.some((f) => f.otId != null && autre.db.get('ot', f.otId)), 'facture liée à un OT');
        assert.ok(facs.some((f) => f.personnelId != null && autre.db.get('personnel', f.personnelId)), 'formation liée au personnel');
        assert.ok(facs.some((f) => (f.documents || []).some((d) => d.type === 'application/pdf')), 'PDF joint');
        assert.ok(cmds.some((c) => autre.ctx.siteDuSecteur(c.secteurId) === val.id), 'commandes à Valréas');
        assert.ok(cmds.some((c) => autre.ctx.siteDuSecteur(c.secteurId) === site.id));
        // Second chargement global : rien n'est dupliqué
        require('../server/modules').seedDemo(autre.ctx);
        assert.equal(autre.db.count('commandes'), nbC);
        assert.equal(autre.db.count('factures'), nbF);
        // Les données de démonstration passent par l'API sans erreur
        const c = autre.client();
        await c.login('admin', 'admin');
        const t = await c.ok('GET', '/api/achats/tableau');
        assert.ok(t.kpis.nbEnRetard === 1 && t.kpis.nbLitiges === 1);
        for (const x of cmds) await c.ok('GET', '/api/commandes/' + x.id);
        for (const x of facs) await c.ok('GET', '/api/factures/' + x.id);
        const pdf = facs.find((f) => (f.documents || []).length);
        const cookie = (await fetch(autre.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) })).headers.get('set-cookie').split(';')[0];
        const doc = await fetch(`${autre.base}/api/factures/${pdf.id}/documents/0`, { headers: { cookie } });
        const buf = Buffer.from(await doc.arrayBuffer());
        assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
        assert.ok(buf.toString('latin1').includes('%%EOF'));
        // Utilisateurs de démonstration : mdupont ne valide pas sa propre commande à valider
        const md = autre.client();
        await md.login('mdupont', 'demo');
        const aValider = cmds.find((x) => x.statut === 'a_valider');
        assert.equal((await md.post(`/api/commandes/${aValider.id}/valider`)).status, 403);
      } finally { await autre.stop(); }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('Portée, cohérence de site et règles métier (non-régression)', () => {
    let S2; let S2M; let artS2; let artPartage; let artProd; let fourR;
    let modifMaint; // portée secteurs (Maintenance), droit modifier
    const cmdValidee = async (c, extra) => { const x = await c.ok('POST', '/api/commandes', corpsCommande(Object.assign({ fournisseurId: fourR.id, lignes: [{ designation: 'Pièce', quantite: 1, prixUnitaireHT: 100 }] }, extra))); return c.ok('POST', `/api/commandes/${x.id}/soumettre`); };
    before(async () => {
      S2 = await admin.ok('POST', '/api/secteurs', { nom: 'Usine 2', code: 'US2', type: 'site' });
      S2M = await admin.ok('POST', '/api/secteurs', { nom: 'Maintenance usine 2', code: 'US2-MAINT', type: 'service', parentId: S2.id });
      fourR = srv.db.insert('fournisseurs', { nom: 'Fournisseur revue', actif: true });
      artS2 = srv.db.insert('articles', { code: 'US2-001', designation: 'Article du magasin de l\'usine 2', quantite: 7, seuilMin: 1, prixUnitaire: 10, uniteCode: 'u', actif: true, secteurId: S2M.id, fournisseurId: fourR.id });
      artPartage = srv.db.insert('articles', { code: 'PART-001', designation: 'Article partagé', quantite: 0, seuilMin: 5, quantiteCommande: 10, prixUnitaire: 3, uniteCode: 'u', actif: true, secteurId: null, fournisseurId: fourR.id });
      artProd = srv.db.insert('articles', { code: 'PROD-001', designation: 'Article du magasin de production', quantite: 12, seuilMin: 1, prixUnitaire: 4, uniteCode: 'u', actif: true, secteurId: PROD.id, fournisseurId: fourR.id });
      await creerUtilisateur('a1', 'Acheteur / comptabilité', { secteurIds: [SITE.id] });
      await creerUtilisateur('a1lect', 'Acheteur / comptabilité', { secteurIds: [SITE.id], siteAcces: [{ siteId: S2.id, mode: 'lecture' }] });
      await creerUtilisateur('a2', 'Acheteur / comptabilité', { secteurIds: [S2.id] });
      await creerUtilisateur('perso', 'Demandeur', { secteurIds: [PROD.id], overrides: { achats: { voir: true, creer: true } }, siteAcces: [{ siteId: S2.id, mode: 'lecture' }] });
      await creerUtilisateur('perso2', 'Demandeur', { secteurIds: [PROD.id], overrides: { achats: { voir: true, creer: true } } });
      modifMaint = await creerUtilisateur('modifmaint', 'Chef de secteur', { secteurIds: [MAINT.id], overrides: { achats: { voir: true, creer: true, modifier: true } } });
      await creerUtilisateur('inactif', 'Acheteur / comptabilité', { secteurIds: [S2.id] });
      await admin.ok('PUT', '/api/utilisateurs/' + users.inactif.id, { actif: false });
    });

    test('ligne de commande : article d\'un autre site ou hors périmètre refusé, stock masqué, réception sans entrée hors site', async () => {
      assert.equal((await clients.a1.get('/api/articles/' + artS2.id)).status, 404);
      const r = await clients.a1.post('/api/commandes', corpsCommande({ fournisseurId: fourR.id, lignes: [{ articleId: artS2.id, quantite: 3 }] }));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /article introuvable/);
      const r2 = await admin.post('/api/commandes', corpsCommande({ fournisseurId: fourR.id, secteurId: MAINT.id, lignes: [{ articleId: artS2.id, quantite: 3 }] }));
      assert.equal(r2.status, 400); assert.match(r2.body.erreur, /magasin d'un autre site/);
      assert.equal(srv.db.get('articles', artS2.id).quantite, 7, 'stock du site 2 intact');
      // Article du même site mais hors du périmètre du lecteur : quantité en stock masquée dans la fiche
      const c = await admin.ok('POST', '/api/commandes', corpsCommande({ fournisseurId: fourR.id, secteurId: MAINT.id, lignes: [{ articleId: artProd.id, quantite: 2 }] }));
      assert.equal(c.lignes[0].articleStock, 12);
      const vu = await clients.modifmaint.ok('GET', '/api/commandes/' + c.id);
      assert.equal(vu.lignes[0].articleStock, null, 'stock d\'un article hors périmètre non renvoyé');
      assert.equal(vu.lignes[0].designation, 'Article du magasin de production');
      // Modification des autres champs par cet utilisateur : la ligne existante n'est pas recontrôlée
      assert.equal((await clients.modifmaint.put('/api/commandes/' + c.id, { objet: 'Objet modifié' })).status, 200);
      // Article déplacé vers un autre site après la commande : aucune entrée en stock possible
      await admin.ok('POST', `/api/commandes/${c.id}/soumettre`);
      srv.db.update('articles', artProd.id, { secteurId: S2M.id });
      const rec = await admin.post(`/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 2 }] });
      assert.equal(rec.status, 400); assert.match(rec.body.erreur, /magasin d'un autre site/);
      assert.equal(srv.db.get('articles', artProd.id).quantite, 12);
      srv.db.update('articles', artProd.id, { secteurId: PROD.id });
      // Brouillons depuis les alertes : la désignation d'un article hors périmètre n'est pas renvoyée
      srv.db.update('articles', artS2.id, { quantite: 0 });
      const al = await clients.a1.ok('POST', '/api/commandes/depuis-alertes', { secteurId: MAINT.id, articleIds: [artS2.id] });
      assert.equal(al.commandes.length, 0);
      assert.equal(al.ignores[0].designation, `Article #${artS2.id}`);
      srv.db.update('articles', artS2.id, { quantite: 7 });
    });

    test('portée « perso » : ni création ni modification sur un site en lecture seule ou hors de ses secteurs', async () => {
      const corps = (secteurId) => ({ fournisseurId: fourR.id, secteurId, lignes: [{ designation: 'x', quantite: 1, prixUnitaireHT: 5 }] });
      let r = await clients.perso.post('/api/commandes', corps(S2M.id));
      assert.equal(r.status, 403); assert.match(r.body.erreur, /lecture seule/);
      r = await clients.perso.post('/api/commandes', corps(MAINT.id));
      assert.equal(r.status, 403); assert.match(r.body.erreur, /hors de votre périmètre/);
      const ok = await clients.perso.ok('POST', '/api/commandes', corps(PROD.id));
      assert.equal(ok.lectureSeule, false);
      r = await clients.perso2.post('/api/commandes', Object.assign(corps(S2M.id), { soumettre: true }));
      assert.equal(r.status, 403);
      assert.ok(!srv.db.findOne('notifications', (n) => n.userId === users.a2.id && /Commande à valider/.test(n.titre) && n.createdAt > new Date(Date.now() - 2000).toISOString() && /x/.test(n.message)), 'aucun valideur du site 2 notifié');
      r = await clients.perso2.post('/api/factures', { fournisseurId: fourR.id, secteurId: S2M.id, numeroFournisseur: 'P2-1', montantHT: 10 });
      assert.equal(r.status, 403);
      // Élément déjà existant sur un site en lecture seule, créé par l'utilisateur : consultation seule
      const legacy = srv.db.insert('commandes', { numero: 'CMD-LEGACY-1', fournisseurId: fourR.id, secteurId: S2M.id, statut: 'brouillon', lignes: [{ designation: 'x', quantite: 1, quantiteRecue: 0, prixUnitaireHT: 5, tauxTVA: 20, montantHT: 5 }], totaux: { ht: 5, tva: 1, ttc: 6 }, dateCommande: jour(0), demandeurUserId: users.perso.id, createdBy: users.perso.id, receptions: [], documents: [], historique: [] });
      const d = await clients.perso.ok('GET', '/api/commandes/' + legacy.id);
      assert.equal(d.lectureSeule, true);
      assert.equal(d.actions.modifier, false);
      r = await clients.perso.put('/api/commandes/' + legacy.id, { objet: 'x' });
      assert.equal(r.status, 403); assert.match(r.body.erreur, /lecture seule/);
      assert.equal((await clients.perso.post(`/api/commandes/${legacy.id}/soumettre`)).status, 403);
      srv.db.remove('commandes', legacy.id);
    });

    test('facture : références en écriture et sur le même site ; factures d\'un autre site absentes de la fiche de commande', async () => {
      const cmdS2 = await cmdValidee(admin, { secteurId: S2M.id });
      const otS2 = srv.db.insert('ot', { numero: 'OT-US2-1', titre: 'OT usine 2', secteurId: S2M.id, statut: 'en_cours' });
      let r = await clients.a1lect.post('/api/factures', { commandeId: cmdS2.id, fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'LECT-1', montantHT: 100 });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /Commande introuvable/);
      r = await clients.a1lect.post('/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'LECT-2', montantHT: 100, otId: otS2.id });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /Ordre de travail introuvable/);
      // Même pour un utilisateur qui voit tout : la facture est rattachée aux éléments de son site
      r = await admin.post('/api/factures', { commandeId: cmdS2.id, fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'ADM-1', montantHT: 100 });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /appartient à un autre site/);
      r = await admin.post('/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'ADM-2', montantHT: 100, otId: otS2.id });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /appartient à un autre site/);
      const okS2 = await admin.ok('POST', '/api/factures', { commandeId: cmdS2.id, fournisseurId: fourR.id, numeroFournisseur: 'ADM-3', montantHT: 100, otId: otS2.id });
      assert.equal(okS2.secteurId, S2M.id, 'site repris de la commande');
      // Ligne de commande imputée à un OT d\'un autre site : refusée
      r = await admin.post('/api/commandes', corpsCommande({ fournisseurId: fourR.id, secteurId: MAINT.id, lignes: [{ designation: 'x', quantite: 1, prixUnitaireHT: 1, otId: otS2.id }] }));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /appartient à un autre site/);
      // Facture d\'un autre site rattachée (données anciennes) : absente de la fiche vue depuis le site 2, montant agrégé conservé
      const legacy = srv.db.insert('factures', { numero: 'FAC-LEGACY-1', numeroFournisseur: 'LEG-1', fournisseurId: fourR.id, secteurId: MAINT.id, commandeId: cmdS2.id, statut: 'recue', dateFacture: jour(0), dateEcheance: jour(30), montantHT: 50, montantTVA: 10, montantTTC: 60, tauxTVA: 20, lignes: [], documents: [], commentaires: [], historique: [], createdBy: 1 });
      const d = await clients.a2.ok('GET', '/api/commandes/' + cmdS2.id);
      assert.ok(!d.factures.some((x) => x.id === legacy.id), 'facture hors périmètre non listée');
      assert.ok(d.factures.some((x) => x.id === okS2.id));
      assert.equal(d.montantFactureHT, 150);
      assert.equal(d.nbFacturesActives, 2);
      srv.db.remove('factures', legacy.id);
    });

    test('rapprochement et fiche d\'une facture dont la commande est hors périmètre : agrégats seulement', async () => {
      const cmd1 = await cmdValidee(admin, { secteurId: MAINT.id, lignes: [{ designation: 'Pièce confidentielle site 1', quantite: 2, prixUnitaireHT: 321 }] });
      await admin.ok('POST', `/api/commandes/${cmd1.id}/receptionner`, { lignes: [{ index: 0, quantite: 1 }], bonLivraison: 'BL-CONF' });
      const fA = await admin.ok('POST', '/api/factures', { commandeId: cmd1.id, fournisseurId: fourR.id, numeroFournisseur: 'S1-A', montantHT: 321 });
      // Facture du site 2 rattachée à cette commande (données anciennes, antérieures au contrôle de site)
      const fB = srv.db.insert('factures', { numero: 'FAC-LEGACY-2', numeroFournisseur: 'S2-B', fournisseurId: fourR.id, secteurId: S2M.id, commandeId: cmd1.id, statut: 'recue', dateFacture: jour(0), dateEcheance: jour(30), montantHT: 10, montantTVA: 2, montantTTC: 12, tauxTVA: 20, lignes: [], documents: [], commentaires: [], historique: [], createdBy: 1 });
      assert.equal((await clients.a2.get('/api/commandes/' + cmd1.id)).status, 404);
      const rap = await clients.a2.ok('GET', `/api/factures/${fB.id}/rapprochement`);
      assert.equal(rap.commande.visible, false);
      assert.deepEqual(rap.lignes, []); assert.deepEqual(rap.receptions, []); assert.deepEqual(rap.autresFactures, []);
      assert.equal(rap.commande.totaux, null); assert.equal(rap.commande.objet, '');
      assert.equal(rap.rapprochement.commandeHT, 642, 'agrégats du rapprochement conservés');
      const fiche = await clients.a2.ok('GET', '/api/factures/' + fB.id);
      assert.equal(fiche.commande.visible, false); assert.equal(fiche.commande.totaux, null);
      const rapAdmin = await admin.ok('GET', `/api/factures/${fA.id}/rapprochement`);
      assert.equal(rapAdmin.lignes.length, 1); assert.equal(rapAdmin.receptions.length, 1); assert.equal(rapAdmin.autresFactures.length, 1);
      srv.db.remove('factures', fB.id);
    });

    test('références des formulaires : personnel réservé au droit RH et sans données RH ; commandes facturables modifiables', async () => {
      const pers = srv.db.insert('personnel', { nom: 'Revue', prenom: 'Paul', matricule: 'M-REV', secteurId: MAINT.id, typeContratCode: 'cdd', fonction: 'Technicien', actif: true });
      assert.equal((await clients.a1.get('/api/rh/personnel')).status, 403);
      const r1 = await clients.a1.ok('GET', '/api/achats/references');
      assert.deepEqual(r1.personnel, [], 'aucune fiche sans Ressources humaines › Voir');
      const r = await clients.a1.post('/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'RH-1', montantHT: 10, personnelId: pers.id });
      assert.equal(r.status, 403); assert.match(r.body.erreur, /Ressources humaines › Voir/);
      const r2 = await admin.ok('GET', '/api/achats/references');
      const p = r2.personnel.find((x) => x.id === pers.id);
      assert.ok(p && p.nom === 'Paul Revue' && p.fonction === 'Technicien');
      assert.equal(p.matricule, undefined); assert.equal(p.typeContratCode, undefined);
      // Commandes facturables : pas celles d\'un site en lecture seule
      const cmdS2 = await cmdValidee(admin, { secteurId: S2M.id });
      const r3 = await clients.a1lect.ok('GET', '/api/achats/references');
      assert.ok(!r3.commandes.some((c) => c.id === cmdS2.id), 'commande du site en lecture seule non proposée');
      assert.ok((await clients.a2.ok('GET', '/api/achats/references')).commandes.some((c) => c.id === cmdS2.id));
      srv.db.remove('personnel', pers.id);
    });

    test('une commande facturée ne peut pas être annulée', async () => {
      const c = await cmdValidee(admin, { secteurId: MAINT.id });
      const f = await admin.ok('POST', '/api/factures', { commandeId: c.id, fournisseurId: fourR.id, numeroFournisseur: 'ANN-1', montantHT: 100 });
      assert.equal((await admin.ok('GET', '/api/commandes/' + c.id)).actions.annuler, false);
      const r = await admin.post(`/api/commandes/${c.id}/annuler`, { motif: 'test' });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /facture est rattachée/);
      await admin.ok('POST', `/api/factures/${f.id}/annuler`, { motif: 'doublon' });
      assert.equal((await admin.ok('POST', `/api/commandes/${c.id}/annuler`, { motif: 'plus nécessaire' })).statut, 'annulee');
    });

    test('facture avec lignes : le montant peut être corrigé sans nouveau détail (lignes retirées, trace), pas avec des lignes incohérentes', async () => {
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'LIG-1', lignes: [{ designation: 'Câble (au mètre)', quantite: 150, prixUnitaireHT: 2.35 }] });
      assert.equal(f.montantHT, 352.5);
      await admin.ok('POST', `/api/factures/${f.id}/litige`, { motif: '150 m facturés pour 100 m livrés' });
      // Corps exact envoyé par le formulaire de modification (sans éditeur de lignes)
      const m = await admin.ok('PUT', '/api/factures/' + f.id, { fournisseurId: fourR.id, numeroFournisseur: 'LIG-1', secteurId: MAINT.id, objet: '', categorieCode: 'pieces', otId: null, personnelId: null, dateFacture: f.dateFacture, dateEcheance: f.dateEcheance, montantHT: 235, tauxTVA: 20, montantTVA: 47, montantTTC: 282, champs: {} });
      assert.equal(m.montantHT, 235); assert.equal(m.montantTTC, 282);
      assert.deepEqual(m.lignes, []);
      assert.ok(m.historique[0].details.includes('détail des 1 ligne(s) a été retiré'));
      // Montant inchangé : le détail est conservé
      const g = await admin.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'LIG-2', lignes: [{ designation: 'A', quantite: 2, prixUnitaireHT: 10 }] });
      assert.equal((await admin.ok('PUT', '/api/factures/' + g.id, { montantHT: 20, tauxTVA: 20, montantTVA: 4, montantTTC: 24, objet: 'Objet' })).lignes.length, 1);
      const r = await admin.put('/api/factures/' + g.id, { montantHT: 99, lignes: [{ designation: 'A', quantite: 2, prixUnitaireHT: 10 }] });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /ne correspond pas au total des lignes/);
    });

    test('référence inchangée non recontrôlée : OT hors du périmètre de l\'éditeur, fiche du personnel effacée', async () => {
      const otProd = srv.db.insert('ot', { numero: 'OT-PROD-9', titre: 'OT production', secteurId: PROD.id, statut: 'en_cours' });
      const f = await admin.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'REF-1', montantHT: 40, otId: otProd.id });
      assert.equal((await clients.modifmaint.get('/api/ot/' + otProd.id)).status, 404, 'OT hors du périmètre de l\'éditeur');
      const m = await clients.modifmaint.ok('PUT', '/api/factures/' + f.id, { objet: 'nouvel objet' });
      assert.equal(m.objet, 'nouvel objet'); assert.equal(m.otId, otProd.id);
      const r = await clients.modifmaint.put('/api/factures/' + f.id, { otId: otProd.id === ot1.id ? 9999 : srv.db.insert('ot', { numero: 'OT-PROD-10', titre: 'Autre', secteurId: PROD.id, statut: 'nouveau' }).id });
      assert.equal(r.status, 400, 'changer la référence vers un OT invisible reste refusé');
      const pers = srv.db.insert('personnel', { nom: 'Effacé', prenom: 'Jean', matricule: 'M-EFF', secteurId: MAINT.id, actif: true });
      const g = await admin.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'REF-2', montantHT: 40, personnelId: pers.id });
      srv.db.remove('personnel', pers.id);
      assert.equal((await admin.ok('PUT', '/api/factures/' + g.id, { objet: 'formation' })).objet, 'formation');
      assert.equal((await admin.put('/api/factures/' + g.id, { personnelId: 9999 })).status, 400);
    });

    test('tableau de bord : engagé d\'une commande soldée = montant reçu ; série limitée aux 36 derniers mois', async () => {
      const fourS = srv.db.insert('fournisseurs', { nom: 'Fournisseur solde', actif: true });
      const c = await cmdValidee(admin, { fournisseurId: fourS.id, secteurId: MAINT.id, lignes: [{ designation: 'A', quantite: 1, prixUnitaireHT: 300 }, { designation: 'B', quantite: 1, prixUnitaireHT: 600 }] });
      await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 1 }] });
      const s = await admin.ok('POST', `/api/commandes/${c.id}/solder`, { motif: 'Reliquat abandonné' });
      assert.equal(s.montantRecuHT, 300);
      const t = await admin.ok('GET', '/api/achats/tableau?fournisseurId=' + fourS.id);
      assert.equal(t.kpis.engageHT, 300);
      assert.equal(t.parFournisseur[0].engageHT, 300);
      assert.equal(t.parMois.reduce((x, m) => x + m.engageHT, 0), 300);
      assert.equal(t.serieMoisLimitee, false);
      await admin.ok('POST', '/api/factures', { fournisseurId: fourS.id, secteurId: MAINT.id, numeroFournisseur: 'TAB-1', montantHT: 1000 });
      const long = await admin.ok('GET', `/api/achats/tableau?du=2020-01-01&fournisseurId=${fourS.id}`);
      assert.equal(long.parMois.length, 36);
      assert.equal(long.parMois[long.parMois.length - 1].mois, jour(0).slice(0, 7), 'les mois les plus récents sont conservés');
      assert.equal(long.serieMoisLimitee, true);
      assert.equal(long.parMois.reduce((x, m) => x + m.factureHT, 0), 1000);
    });

    test('facture : l\'auteur de la saisie ne donne pas le bon à payer au-delà du seuil (sauf administrateur)', async () => {
      const f = await clients.a1.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'SOD-1', montantHT: 25000 });
      assert.equal(f.actions.valider, false); assert.equal(f.actions.validationPropreInterdite, true);
      const r = await clients.a1.post(`/api/factures/${f.id}/valider`, {});
      assert.equal(r.status, 403); assert.match(r.body.erreur, /autre valideur/);
      assert.equal((await clients.respmaint.ok('POST', `/api/factures/${f.id}/valider`, {})).statut, 'validee');
      const g = await clients.a1.ok('POST', '/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'SOD-2', montantHT: 500 });
      assert.equal(g.actions.valider, true);
      assert.equal((await clients.a1.ok('POST', `/api/factures/${g.id}/valider`, {})).statut, 'validee', 'sous le seuil : autorisé');
    });

    test('rapprochement mémorisé recalculé à la création, à la modification et à la suppression d\'une autre facture', async () => {
      const c = await cmdValidee(admin, { secteurId: MAINT.id });
      const f1 = await admin.ok('POST', '/api/factures', { commandeId: c.id, fournisseurId: fourR.id, numeroFournisseur: 'R-1', montantHT: 100 });
      assert.equal(f1.rapprochement.ecartHT, 0);
      const f2 = await admin.ok('POST', '/api/factures', { commandeId: c.id, fournisseurId: fourR.id, numeroFournisseur: 'R-2', montantHT: 100 });
      const liste = () => admin.ok('GET', '/api/factures?commandeId=' + c.id);
      assert.equal((await liste()).find((x) => x.id === f1.id).rapprochement.ecartHT, 100, 'liste alignée sur la fiche');
      assert.equal((await admin.ok('GET', '/api/factures/' + f1.id)).rapprochement.ecartHT, 100);
      const c2 = await cmdValidee(admin, { secteurId: MAINT.id });
      await admin.ok('PUT', '/api/factures/' + f2.id, { commandeId: c2.id });
      assert.equal((await liste()).find((x) => x.id === f1.id).rapprochement.ecartHT, 0, 'recalcul après changement de commande');
      await admin.ok('PUT', '/api/factures/' + f2.id, { commandeId: c.id });
      assert.equal((await liste()).find((x) => x.id === f1.id).rapprochement.ecartHT, 100);
      await admin.ok('DELETE', '/api/factures/' + f2.id);
      assert.equal((await liste()).find((x) => x.id === f1.id).rapprochement.ecartHT, 0, 'recalcul après suppression');
      const csv = await admin.get('/api/achats/export/factures?commandeId=' + c.id);
      assert.ok(String(csv.body).split('\r\n').some((l) => l.startsWith(f1.numero) && /;0;?$|;0;/.test(l)), 'export aligné');
    });

    test('alertes de stock : les commandes d\'un autre site ne sont pas identifiées (quantité globale conservée)', async () => {
      const c = await clients.a2.ok('POST', '/api/commandes', { fournisseurId: fourR.id, secteurId: S2M.id, lignes: [{ articleId: artPartage.id, quantite: 4 }] });
      await clients.a2.ok('POST', `/api/commandes/${c.id}/soumettre`);
      const a = (await clients.a1.ok('GET', '/api/achats/alertes-stock')).find((x) => x.id === artPartage.id);
      assert.ok(a, 'article partagé en alerte');
      assert.equal(a.dejaEnCommande, 4);
      assert.ok(!a.commandesEnCours.some((x) => x.id === c.id), 'commande du site 2 non identifiée');
      assert.ok((await clients.a2.ok('GET', '/api/achats/alertes-stock')).find((x) => x.id === artPartage.id).commandesEnCours.some((x) => x.id === c.id));
    });

    test('demandeur : compte actif ayant accès aux achats du site ; notifications réservées aux comptes qui voient la commande', async () => {
      const corps = (demandeurUserId) => ({ fournisseurId: fourR.id, secteurId: S2M.id, demandeurUserId, lignes: [{ designation: 'x', quantite: 1, prixUnitaireHT: 5 }] });
      let r = await clients.a2.post('/api/commandes', corps(users.a1.id));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /Demandeur invalide/);
      r = await clients.a2.post('/api/commandes', corps(users.inactif.id));
      assert.equal(r.status, 400); assert.match(r.body.erreur, /désactivé/);
      r = await clients.a2.post('/api/commandes', corps(users.tech.id));
      assert.equal(r.status, 400, 'sans droit Achats › Voir');
      const ok = await admin.ok('POST', '/api/commandes', corps(users.a2.id));
      assert.equal(ok.demandeurUserId, users.a2.id);
      assert.equal((await admin.ok('PUT', '/api/commandes/' + ok.id, { objet: 'inchangé' })).demandeurUserId, users.a2.id);
      // Commande existante désignant un demandeur sans accès (données anciennes) : aucune notification ne lui parvient
      const legacy = srv.db.insert('commandes', { numero: 'CMD-LEGACY-2', fournisseurId: fourR.id, secteurId: S2M.id, statut: 'brouillon', lignes: [{ designation: 'x', quantite: 1, quantiteRecue: 0, prixUnitaireHT: 5, tauxTVA: 20, montantHT: 5 }], totaux: { ht: 5, tva: 1, ttc: 6 }, dateCommande: jour(0), demandeurUserId: users.a1.id, createdBy: users.a2.id, receptions: [], documents: [], historique: [] });
      const avant = srv.db.count('notifications', (n) => n.userId === users.a1.id);
      await admin.ok('POST', `/api/commandes/${legacy.id}/annuler`, { motif: 'test' });
      assert.equal(srv.db.count('notifications', (n) => n.userId === users.a1.id), avant, 'utilisateur sans accès non notifié');
      assert.ok(srv.db.findOne('notifications', (n) => n.userId === users.a2.id && n.lien === '#/achats/commande/' + legacy.id));
    });

    test('dates bornées : envoi et réception après la commande, facture non datée dans le futur', async () => {
      const c = await cmdValidee(admin, { secteurId: MAINT.id, dateCommande: jour(-10) });
      let r = await admin.post(`/api/commandes/${c.id}/envoyer`, { dateEnvoi: jour(-20) });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /précéder la date de commande/);
      r = await admin.post(`/api/commandes/${c.id}/envoyer`, { dateEnvoi: jour(2) });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /futur/);
      assert.equal((await admin.ok('POST', `/api/commandes/${c.id}/envoyer`, { dateEnvoi: jour(-5) })).dateEnvoi, jour(-5));
      r = await admin.post(`/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 1 }], date: jour(-15) });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /précéder la date de commande/);
      r = await admin.post('/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'FUT-1', montantHT: 10, dateFacture: '2030-06-01' });
      assert.equal(r.status, 400); assert.match(r.body.erreur, /futur/);
      assert.equal((await admin.post('/api/factures', { fournisseurId: fourR.id, secteurId: MAINT.id, numeroFournisseur: 'FUT-2', montantHT: 10, dateFacture: jour(1) })).status, 200, 'tolérance d\'un jour');
      // Facture ancienne datée dans le futur : les autres champs restent modifiables
      const legacy = srv.db.insert('factures', { numero: 'FAC-LEGACY-3', numeroFournisseur: 'LEG-3', fournisseurId: fourR.id, secteurId: MAINT.id, commandeId: null, statut: 'recue', dateFacture: '2031-01-01', dateEcheance: '2031-01-31', montantHT: 10, montantTVA: 2, montantTTC: 12, tauxTVA: 20, lignes: [], documents: [], commentaires: [], historique: [], createdBy: 1 });
      assert.equal((await admin.put('/api/factures/' + legacy.id, { objet: 'x' })).status, 200);
      assert.equal((await admin.put('/api/factures/' + legacy.id, { dateFacture: '2031-01-02' })).status, 400);
    });

    test('taux de réception en valeur ; compteurs de la pastille du menu', async () => {
      const c = await cmdValidee(admin, { secteurId: MAINT.id, lignes: [{ designation: 'Câble (m)', quantite: 100, prixUnitaireHT: 0.9 }, { designation: 'Variateur', quantite: 1, prixUnitaireHT: 810 }] });
      const r = await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 0, quantite: 100 }] });
      assert.equal(r.tauxReception, 10, 'en valeur (90 € sur 900 €), pas en quantités (99 %)');
      assert.equal((await admin.ok('POST', `/api/commandes/${c.id}/receptionner`, { lignes: [{ index: 1, quantite: 1 }] })).tauxReception, 100);
      const k = await admin.ok('GET', '/api/achats/compteurs');
      const t = await admin.ok('GET', '/api/achats/tableau');
      assert.equal(k.commandesAValider, t.kpis.nbCommandesAValider);
      assert.equal(k.facturesAValider, t.kpis.nbFacturesAValider);
      assert.equal(k.facturesEnRetard, t.kpis.nbEnRetard);
      assert.equal(k.total, k.commandesAValider + k.facturesAValider + k.facturesEnRetard);
      const kc = await clients.chefprod.ok('GET', '/api/achats/compteurs');
      assert.equal(kc.commandesAValider + kc.facturesAValider, 0, 'sans droit valider');
      assert.equal((await clients.tech.get('/api/achats/compteurs')).status, 403);
    });
  });
});
