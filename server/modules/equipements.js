'use strict';
/**
 * Module Équipements : arborescence (secteurs → équipements → sous-équipements), fiches
 * détaillées (interventions, préventif, pièces compatibles), documents joints, compteurs
 * (relevés historisés), changements d'état, duplication, export CSV.
 *
 * Services publiés : ctx.services.equipements.releverCompteur(equipementId, valeur, req)
 * Événements émis  : 'equipement:etat' ({ equipement, ancien, nouveau }),
 *                    'equipement:compteur' ({ equipement, ancien, nouveau })
 */
const nom = 'Équipements';
const ENTITE = 'equipements';
const TAILLE_MAX_DOC = 5 * 1024 * 1024; // 5 Mo par document
const MAX_DOCS = 50;
const UNITES_COMPTEUR = ['heures', 'cycles', 'km', 'pièces', 'tonnes', 'm³', 'litres'];

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  // ----- Portée -----------------------------------------------------------
  /**
   * Les équipements sont des données de référence partagées : pour la portée « perso »
   * (ex. profil Demandeur), on les rend visibles par secteur de rattachement (et non par créateur),
   * sinon un demandeur ne pourrait sélectionner aucun équipement dans sa demande.
   */
  function peutVoir(req, e) {
    if (!e) return false;
    if (!req.perms || req.perms.portee !== 'perso') return ctx.canSee(req, e);
    if (e.secteurId == null || !req.perms.secteurIds.length) return true;
    return req.perms.secteurIds.includes(Number(e.secteurId)) || Number(e.createdBy) === req.user.id;
  }
  const portee = (req, rows) => rows.filter((e) => peutVoir(req, e));
  function getVisible(req, id) {
    const e = db.get(ENTITE, id);
    if (!e || !peutVoir(req, e)) throw new HttpError(404, 'Équipement introuvable');
    return e;
  }
  /** Un utilisateur limité à ses secteurs ne gère que les équipements de ces secteurs. */
  function verifierPorteeEcriture(req, secteurId) {
    if (req.perms.portee === 'tous' || secteurId == null) return;
    if (!req.perms.secteurIds.length && req.perms.portee === 'perso') return;
    if (!req.perms.secteurIds.includes(Number(secteurId))) throw new HttpError(403, 'Vous ne pouvez gérer que les équipements de vos propres secteurs');
  }

  // ----- Utilitaires ------------------------------------------------------
  function statutsOtFinaux() {
    const l = ctx.liste('statutsOT');
    return new Set(l.length ? l.filter((s) => s.final).map((s) => s.code) : ['termine', 'annule']);
  }
  function statutsDemandeFinaux() {
    const l = ctx.liste('statutsDemande');
    return new Set(l.length ? l.filter((s) => s.final).map((s) => s.code) : ['refusee', 'cloturee']);
  }
  function otOuvertsParEquipement() {
    const finaux = statutsOtFinaux();
    const m = new Map();
    for (const o of db.list('ot', (o) => o.equipementId != null && !finaux.has(o.statut))) m.set(Number(o.equipementId), (m.get(Number(o.equipementId)) || 0) + 1);
    return m;
  }
  function cheminSecteur(id) {
    const parts = []; let cur = id == null ? null : db.get('secteurs', id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? db.get('secteurs', cur.parentId) : null; }
    return parts.join(' › ');
  }
  /** Ancêtres (du plus haut au parent direct). */
  function ancetres(e) {
    const out = []; const vus = new Set([e.id]);
    let cur = e.parentId != null ? db.get(ENTITE, e.parentId) : null;
    while (cur && !vus.has(cur.id)) { out.unshift(cur); vus.add(cur.id); cur = cur.parentId != null ? db.get(ENTITE, cur.parentId) : null; }
    return out;
  }
  /** Identifiants de tous les descendants d'un équipement. */
  function descendants(id) {
    const out = []; const pile = [Number(id)]; const vus = new Set();
    while (pile.length) {
      const cur = pile.pop();
      for (const c of db.list(ENTITE, (x) => Number(x.parentId) === cur)) { if (!vus.has(c.id)) { vus.add(c.id); out.push(c.id); pile.push(c.id); } }
    }
    return out;
  }
  function estImage(type) { return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(type || ''); }
  const triNom = (a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr');
  const triNumero = (a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true });

  function resumeDoc(d, i) {
    return { index: i, nom: d.nom, type: d.type, taille: d.taille, date: d.date, userId: d.userId, userNom: ctx.nomUser(d.userId), estImage: estImage(d.type) };
  }
  function nbReferences(id) {
    return {
      ot: db.count('ot', (o) => Number(o.equipementId) === id),
      demandes: db.count('demandes', (d) => Number(d.equipementId) === id),
      plans: db.count('plansPreventifs', (p) => Number(p.equipementId) === id),
      articles: db.count('articles', (a) => (a.equipementIds || []).map(Number).includes(id)),
    };
  }

  /** Vue allégée pour les listes (sans contenu de documents ni historique). */
  function resume(e, ouverts) {
    const { documents, compteurReleves, historiqueEtats, ...reste } = e;
    const parent = e.parentId != null ? db.get(ENTITE, e.parentId) : null;
    return Object.assign(reste, {
      secteurNom: e.secteurId != null ? ((db.get('secteurs', e.secteurId) || {}).nom || '') : '',
      secteurChemin: cheminSecteur(e.secteurId),
      parentNumero: parent ? parent.numero : '', parentNom: parent ? parent.nom : '',
      fournisseurNom: e.fournisseurId != null ? ((db.get('fournisseurs', e.fournisseurId) || {}).nom || '') : '',
      nbEnfants: db.count(ENTITE, (x) => Number(x.parentId) === e.id),
      nbDocuments: (documents || []).length,
      nbOtOuverts: ouverts ? (ouverts.get(e.id) || 0) : 0,
      dernierReleve: (compteurReleves || []).length ? compteurReleves[compteurReleves.length - 1].date : null,
      photoIndex: (documents || []).findIndex((d) => estImage(d.type)),
    });
  }

  /** Fiche complète. */
  function detail(req, e) {
    const finauxOt = statutsOtFinaux();
    const finauxDi = statutsDemandeFinaux();
    const parDate = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    const ot = db.list('ot', (o) => Number(o.equipementId) === e.id).sort(parDate);
    const demandes = db.list('demandes', (d) => Number(d.equipementId) === e.id).sort(parDate);
    const base = resume(e, new Map([[e.id, ot.filter((o) => !finauxOt.has(o.statut)).length]]));
    const parent = e.parentId != null ? db.get(ENTITE, e.parentId) : null;
    const fournisseur = e.fournisseurId != null ? db.get('fournisseurs', e.fournisseurId) : null;
    const garantie = e.garantieFin ? (e.garantieFin < new Date().toISOString().slice(0, 10) ? 'expiree' : 'valide') : null;
    return Object.assign(base, {
      parent: parent ? { id: parent.id, numero: parent.numero, nom: parent.nom } : null,
      chemin: ancetres(e).map((a) => ({ id: a.id, numero: a.numero, nom: a.nom })),
      enfants: portee(req, db.list(ENTITE, (x) => Number(x.parentId) === e.id)).sort(triNom).map((x) => ({ id: x.id, numero: x.numero, nom: x.nom, typeCode: x.typeCode, etatCode: x.etatCode, criticiteCode: x.criticiteCode, actif: x.actif !== false, nbEnfants: db.count(ENTITE, (y) => Number(y.parentId) === x.id) })),
      fournisseur: fournisseur ? { id: fournisseur.id, nom: fournisseur.nom, telephone: fournisseur.telephone || '', email: fournisseur.email || '' } : null,
      garantie,
      derniersOt: ot.slice(0, 10).map((o) => ({ id: o.id, numero: o.numero, titre: o.titre, statut: o.statut, typeCode: o.typeCode, prioriteCode: o.prioriteCode, technicienId: o.technicienId, datePrevue: o.datePrevue, dateDebut: o.dateDebut, dateFin: o.dateFin, createdAt: o.createdAt })),
      nbOtTotal: ot.length,
      nbOtOuverts: ot.filter((o) => !finauxOt.has(o.statut)).length,
      demandes: demandes.slice(0, 10).map((d) => ({ id: d.id, numero: d.numero, titre: d.titre, statut: d.statut, prioriteCode: d.prioriteCode, typeCode: d.typeCode, demandeurId: d.demandeurId, dateDemande: d.dateDemande || d.createdAt, otId: d.otId, arretProduction: !!d.arretProduction })),
      nbDemandesTotal: demandes.length,
      nbDemandesOuvertes: demandes.filter((d) => !finauxDi.has(d.statut)).length,
      plansPreventifs: db.list('plansPreventifs', (p) => Number(p.equipementId) === e.id).sort(triNom).map((p) => ({ id: p.id, numero: p.numero, nom: p.nom, typeCode: p.typeCode, periodicite: p.periodicite, prochaineEcheance: p.prochaineEcheance, derniereExecution: p.derniereExecution, technicienId: p.technicienId, dureeEstimee: p.dureeEstimee, actif: p.actif !== false })),
      articlesCompatibles: db.list('articles', (a) => (a.equipementIds || []).map(Number).includes(e.id)).sort((a, b) => String(a.designation || '').localeCompare(String(b.designation || ''), 'fr')).map((a) => ({ id: a.id, code: a.code, designation: a.designation, categorieCode: a.categorieCode, uniteCode: a.uniteCode, quantite: a.quantite, seuilMin: a.seuilMin, emplacement: a.emplacement, prixUnitaire: a.prixUnitaire, actif: a.actif !== false })),
      documents: (e.documents || []).map(resumeDoc),
      compteurReleves: (e.compteurReleves || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map((r) => Object.assign({}, r, { userNom: ctx.nomUser(r.userId) })),
      historiqueEtats: (e.historiqueEtats || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map((h) => Object.assign({}, h, { userNom: ctx.nomUser(h.userId) })),
      references: nbReferences(e.id),
      createdByNom: ctx.nomUser(e.createdBy),
    });
  }

  // ----- Validation -------------------------------------------------------
  function codeListe(nomListe, valeur, libelle) {
    const l = ctx.liste(nomListe);
    if (valeur == null || valeur === '') return l.length ? l[0].code : null;
    if (!l.some((x) => x.code === valeur)) throw new HttpError(400, `${libelle} invalide : « ${valeur} »`);
    return valeur;
  }
  function dateValide(v, libelle) {
    if (v == null || v === '') return null;
    const s = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s).getTime())) throw new HttpError(400, `${libelle} : date invalide (format attendu AAAA-MM-JJ)`);
    return s;
  }
  function numeroUnique(numero, existant) {
    const n = String(numero).trim().toLowerCase();
    return !db.findOne(ENTITE, (x) => String(x.numero || '').trim().toLowerCase() === n && (!existant || x.id !== existant.id));
  }
  function genererNumero() {
    const gabarit = (ctx.config().numerotation || {}).eq || 'EQ-{num:4}';
    for (let i = 0; i < 1000; i++) { const n = db.nextNumber('eq', gabarit); if (numeroUnique(n, null)) return n; }
    throw new HttpError(500, 'Impossible de générer un numéro d\'équipement unique');
  }

  function valider(req, body, existant) {
    body = body && typeof body === 'object' ? body : {};
    const out = {};
    const texte = (cle, max, libelle) => {
      const v = body[cle] === undefined ? (existant ? existant[cle] : '') : body[cle];
      if (v != null && typeof v === 'object') throw new HttpError(400, `${libelle || cle} invalide`);
      const s = String(v == null ? '' : v).trim();
      if (s.length > max) throw new HttpError(400, `${libelle || cle} : ${max} caractères maximum`);
      return s;
    };
    out.nom = texte('nom', 150, 'La désignation');
    if (!out.nom) throw new HttpError(400, 'La désignation de l\'équipement est obligatoire');

    // Numéro : saisi (unique) ou généré
    if (body.numero !== undefined && String(body.numero || '').trim() !== '') {
      const n = String(body.numero).trim();
      if (n.length > 30) throw new HttpError(400, 'Le numéro ne doit pas dépasser 30 caractères');
      if (!numeroUnique(n, existant)) throw new HttpError(400, `Le numéro « ${n} » est déjà utilisé par un autre équipement`);
      out.numero = n;
    } else if (!existant) out.numero = genererNumero();

    out.description = texte('description', 5000, 'La description');
    out.localisation = texte('localisation', 200, 'La localisation');
    out.marque = texte('marque', 100, 'La marque');
    out.modele = texte('modele', 100, 'Le modèle');
    out.numeroSerie = texte('numeroSerie', 100, 'Le numéro de série');
    out.notes = texte('notes', 5000, 'Les notes');

    out.typeCode = codeListe('typesEquipement', body.typeCode === undefined ? (existant ? existant.typeCode : null) : body.typeCode, 'Type d\'équipement');
    out.etatCode = codeListe('etatsEquipement', body.etatCode === undefined ? (existant ? existant.etatCode : null) : body.etatCode, 'État');
    out.criticiteCode = codeListe('criticites', body.criticiteCode === undefined ? (existant ? existant.criticiteCode : null) : body.criticiteCode, 'Criticité');

    // Parent (arborescence, sans cycle)
    const parentId = body.parentId === undefined ? (existant ? existant.parentId : null) : (body.parentId == null || body.parentId === '' ? null : Number(body.parentId));
    let parent = null;
    if (parentId != null) {
      if (!Number.isInteger(parentId)) throw new HttpError(400, 'Équipement parent invalide');
      parent = db.get(ENTITE, parentId);
      if (!parent) throw new HttpError(400, 'Équipement parent invalide');
      if (!peutVoir(req, parent)) throw new HttpError(403, 'L\'équipement parent est hors de votre portée');
      if (existant) {
        if (parentId === existant.id) throw new HttpError(400, 'Un équipement ne peut pas être son propre parent');
        if (descendants(existant.id).includes(parentId)) throw new HttpError(400, 'Cycle détecté : le parent choisi est un sous-équipement de cet équipement');
      }
    }
    out.parentId = parentId;

    // Secteur : obligatoire, hérité du parent si absent
    let secteurId = body.secteurId === undefined ? (existant ? existant.secteurId : null) : (body.secteurId == null || body.secteurId === '' ? null : Number(body.secteurId));
    if (secteurId == null && parent) secteurId = parent.secteurId == null ? null : Number(parent.secteurId);
    if (secteurId == null) throw new HttpError(400, 'Le secteur est obligatoire (ou choisissez un équipement parent pour l\'hériter)');
    if (!Number.isInteger(secteurId) || !db.get('secteurs', secteurId)) throw new HttpError(400, 'Secteur invalide');
    verifierPorteeEcriture(req, secteurId);
    out.secteurId = secteurId;

    // Fournisseur
    const fournisseurId = body.fournisseurId === undefined ? (existant ? existant.fournisseurId : null) : (body.fournisseurId == null || body.fournisseurId === '' ? null : Number(body.fournisseurId));
    if (fournisseurId != null && (!Number.isInteger(fournisseurId) || !db.get('fournisseurs', fournisseurId))) throw new HttpError(400, 'Fournisseur invalide');
    out.fournisseurId = fournisseurId == null ? null : fournisseurId;

    // Dates et valeurs
    for (const [cle, libelle] of [['dateMiseEnService', 'Date de mise en service'], ['dateAchat', 'Date d\'achat'], ['garantieFin', 'Fin de garantie']]) {
      out[cle] = dateValide(body[cle] === undefined ? (existant ? existant[cle] : null) : body[cle], libelle);
    }
    const va = body.valeurAchat === undefined ? (existant ? existant.valeurAchat : null) : body.valeurAchat;
    if (va == null || va === '') out.valeurAchat = null;
    else { const n = Number(va); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'La valeur d\'achat doit être un nombre positif'); out.valeurAchat = n; }

    // Compteur { valeur, unite }
    const cpt = body.compteur === undefined ? (existant ? existant.compteur : null) : body.compteur;
    if (cpt == null || cpt === '') out.compteur = existant && existant.compteur ? existant.compteur : { valeur: 0, unite: 'heures' };
    else {
      if (typeof cpt !== 'object') throw new HttpError(400, 'Compteur invalide');
      const val = cpt.valeur == null || cpt.valeur === '' ? 0 : Number(cpt.valeur);
      if (!Number.isFinite(val) || val < 0) throw new HttpError(400, 'La valeur du compteur doit être un nombre positif');
      const unite = String(cpt.unite == null ? '' : cpt.unite).trim().slice(0, 20) || 'heures';
      out.compteur = { valeur: val, unite };
    }

    out.actif = body.actif === undefined ? (existant ? existant.actif !== false : true) : !!body.actif;
    if (body.champs !== undefined || !existant) out.champs = ctx.champsPerso(ENTITE, body.champs || (existant && existant.champs) || {});
    return out;
  }

  // ----- Filtres de liste -------------------------------------------------
  function filtrer(req) {
    const q = req.query || {};
    let rows = portee(req, db.list(ENTITE));
    if (q.secteurId) {
      const ids = perms.secteursDescendants(db, [Number(q.secteurId)]);
      rows = rows.filter((e) => ids.includes(Number(e.secteurId)));
    }
    if (q.typeCode) rows = rows.filter((e) => e.typeCode === q.typeCode);
    if (q.etatCode) rows = rows.filter((e) => e.etatCode === q.etatCode);
    if (q.criticiteCode) rows = rows.filter((e) => e.criticiteCode === q.criticiteCode);
    if (q.parentId !== undefined && q.parentId !== '') rows = rows.filter((e) => (q.parentId === 'aucun' || q.parentId === 'null' ? e.parentId == null : Number(e.parentId) === Number(q.parentId)));
    if (q.fournisseurId) rows = rows.filter((e) => Number(e.fournisseurId) === Number(q.fournisseurId));
    if (q.actif === '1' || q.actif === 'true') rows = rows.filter((e) => e.actif !== false);
    else if (q.actif === '0' || q.actif === 'false') rows = rows.filter((e) => e.actif === false);
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase();
      rows = rows.filter((e) => [e.numero, e.nom, e.marque, e.modele, e.numeroSerie, e.localisation, e.description].some((v) => String(v || '').toLowerCase().includes(s)));
    }
    return rows.sort(triNumero);
  }

  // ----- Routes -----------------------------------------------------------
  router.get('/api/equipements', async (req) => {
    const ouverts = otOuvertsParEquipement();
    return filtrer(req).map((e) => resume(e, ouverts));
  }, { perm: [ENTITE, 'voir'] });

  /** Arbre : secteurs (hiérarchiques) → équipements → sous-équipements, avec compteurs. */
  router.get('/api/equipements-arbre', async (req) => {
    const q = req.query || {};
    let eqs = portee(req, db.list(ENTITE));
    if (q.actif === '1' || q.actif === 'true') eqs = eqs.filter((e) => e.actif !== false);
    const visibles = new Set(eqs.map((e) => e.id));
    const noeudEq = (e) => ({ type: 'equipement', id: e.id, numero: e.numero, nom: e.nom, typeCode: e.typeCode, etatCode: e.etatCode, criticiteCode: e.criticiteCode, secteurId: e.secteurId, parentId: e.parentId, actif: e.actif !== false, enfants: [], nbEquipements: 0 });
    const noeudsEq = new Map(eqs.map((e) => [e.id, noeudEq(e)]));
    const racinesParSecteur = new Map();
    for (const e of eqs) {
      const n = noeudsEq.get(e.id);
      if (e.parentId != null && visibles.has(Number(e.parentId))) noeudsEq.get(Number(e.parentId)).enfants.push(n);
      else { const k = e.secteurId == null ? 0 : Number(e.secteurId); if (!racinesParSecteur.has(k)) racinesParSecteur.set(k, []); racinesParSecteur.get(k).push(n); }
    }
    const compterEq = (n) => { n.enfants.sort(triNom); n.nbEquipements = n.enfants.reduce((s, c) => s + 1 + compterEq(c), 0); return n.nbEquipements; };
    noeudsEq.forEach((n) => { if (n.parentId == null || !visibles.has(Number(n.parentId))) compterEq(n); });

    const secteurs = db.list('secteurs').sort((a, b) => (a.ordre || 0) - (b.ordre || 0) || a.nom.localeCompare(b.nom, 'fr'));
    const noeudsSect = new Map(secteurs.map((s) => [s.id, { type: 'secteur', id: s.id, nom: s.nom, code: s.code, couleur: s.couleur, parentId: s.parentId, actif: s.actif !== false, enfants: [], nbEquipements: 0 }]));
    const racines = [];
    for (const s of secteurs) {
      const n = noeudsSect.get(s.id);
      if (s.parentId != null && noeudsSect.has(Number(s.parentId))) noeudsSect.get(Number(s.parentId)).enfants.push(n); else racines.push(n);
    }
    const compterSect = (n) => {
      const eqsIci = racinesParSecteur.get(n.id) || [];
      let total = eqsIci.reduce((s, e) => s + 1 + e.nbEquipements, 0);
      for (const c of n.enfants) total += compterSect(c);
      n.enfants = n.enfants.concat(eqsIci);
      n.nbEquipements = total;
      return total;
    };
    racines.forEach(compterSect);
    const sans = racinesParSecteur.get(0) || [];
    if (sans.length) racines.push({ type: 'secteur', id: 0, nom: 'Sans secteur', code: '', couleur: '#9ca3af', parentId: null, actif: true, enfants: sans, nbEquipements: sans.reduce((s, e) => s + 1 + e.nbEquipements, 0) });
    // Secteurs rattachés à un parent inexistant → racine
    noeudsSect.forEach((n) => { if (n.parentId != null && !noeudsSect.has(Number(n.parentId)) && !racines.includes(n)) { compterSect(n); racines.push(n); } });
    return racines;
  }, { perm: [ENTITE, 'voir'] });

  /** Export CSV (mêmes filtres que la liste). */
  router.get('/api/equipements-export', async (req, res) => {
    const champs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
    const lib = (l, c) => { const it = ctx.liste(l).find((x) => x.code === c); return it ? it.label : (c || ''); };
    const entetes = ['Numéro', 'Désignation', 'Type', 'État', 'Criticité', 'Secteur', 'Équipement parent', 'Localisation', 'Marque', 'Modèle', 'N° de série', 'Fournisseur', 'Mise en service', 'Date d\'achat', 'Valeur d\'achat', 'Fin de garantie', 'Compteur', 'Unité', 'OT ouverts', 'Actif', 'Description', 'Notes'].concat(champs.map((c) => c.label));
    const ouverts = otOuvertsParEquipement();
    const lignes = ['﻿' + entetes.map(csvEscape).join(';')];
    for (const e of filtrer(req)) {
      const r = resume(e, ouverts);
      lignes.push([
        r.numero, r.nom, lib('typesEquipement', r.typeCode), lib('etatsEquipement', r.etatCode), lib('criticites', r.criticiteCode), r.secteurChemin,
        r.parentNumero ? `${r.parentNumero} ${r.parentNom}` : '', r.localisation, r.marque, r.modele, r.numeroSerie, r.fournisseurNom,
        r.dateMiseEnService || '', r.dateAchat || '', r.valeurAchat == null ? '' : String(r.valeurAchat).replace('.', ','), r.garantieFin || '',
        r.compteur ? String(r.compteur.valeur).replace('.', ',') : '', r.compteur ? r.compteur.unite : '', r.nbOtOuverts, r.actif === false ? 'Non' : 'Oui', r.description, r.notes,
      ].concat(champs.map((c) => { const v = (r.champs || {})[c.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); })).map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, null, `${lignes.length - 1} équipement(s)`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="equipements-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.end(lignes.join('\r\n'));
  }, { perm: [ENTITE, 'exporter'] });

  router.get('/api/equipements/:id', async (req) => detail(req, getVisible(req, req.params.id)), { perm: [ENTITE, 'voir'] });

  router.post('/api/equipements', async (req) => {
    const data = valider(req, req.body, null);
    data.documents = []; data.compteurReleves = []; data.historiqueEtats = [];
    if (data.compteur.valeur > 0) data.compteurReleves.push({ date: new Date().toISOString(), valeur: data.compteur.valeur, userId: req.user.id, commentaire: 'Valeur initiale' });
    data.createdBy = req.user.id;
    const e = db.insert(ENTITE, data);
    ctx.audit(req, 'creation', ENTITE, e.id, `Équipement ${e.numero} ${e.nom}`);
    ctx.emit('equipement:cree', { equipement: e });
    return detail(req, e);
  }, { perm: [ENTITE, 'creer'] });

  router.put('/api/equipements/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const data = valider(req, req.body, existant);
    const e = db.update(ENTITE, existant.id, data);
    // Changement de secteur : les sous-équipements qui suivaient le parent sont déplacés avec lui
    if (existant.secteurId !== e.secteurId) {
      for (const id of descendants(e.id)) { const c = db.get(ENTITE, id); if (c && Number(c.secteurId) === Number(existant.secteurId)) db.update(ENTITE, id, { secteurId: e.secteurId }); }
    }
    ctx.audit(req, 'modification', ENTITE, e.id, `Équipement ${e.numero} ${e.nom}`);
    if (existant.etatCode !== e.etatCode) changerEtat(req, existant, e.etatCode, '', true);
    return detail(req, db.get(ENTITE, e.id));
  }, { perm: [ENTITE, 'modifier'] });

  router.delete('/api/equipements/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const nbEnfants = db.count(ENTITE, (x) => Number(x.parentId) === existant.id);
    if (nbEnfants) throw new HttpError(400, `Cet équipement possède ${nbEnfants} sous-équipement(s) : supprimez-les ou rattachez-les ailleurs d'abord`);
    const refs = nbReferences(existant.id);
    const detailsRefs = [refs.ot ? `${refs.ot} OT` : '', refs.demandes ? `${refs.demandes} demande(s)` : '', refs.plans ? `${refs.plans} plan(s) préventif(s)` : ''].filter(Boolean);
    if (detailsRefs.length) {
      // Traçabilité : un équipement référencé est désactivé, jamais supprimé
      db.update(ENTITE, existant.id, { actif: false });
      ctx.audit(req, 'desactivation', ENTITE, existant.id, `Équipement ${existant.numero} ${existant.nom} (référencé par ${detailsRefs.join(', ')}, désactivé)`);
      return { ok: true, desactive: true, references: refs };
    }
    // Retrait des compatibilités d'articles
    for (const a of db.list('articles', (a) => (a.equipementIds || []).map(Number).includes(existant.id))) db.update('articles', a.id, { equipementIds: a.equipementIds.filter((x) => Number(x) !== existant.id) });
    db.remove(ENTITE, existant.id);
    ctx.audit(req, 'suppression', ENTITE, existant.id, `Équipement ${existant.numero} ${existant.nom}`);
    ctx.emit('equipement:supprime', { equipement: existant });
    return { ok: true, desactive: false };
  }, { perm: [ENTITE, 'supprimer'] });

  router.post('/api/equipements/:id/dupliquer', async (req) => {
    const source = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, source.secteurId);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const { id, createdAt, updatedAt, documents, compteurReleves, historiqueEtats, ...reste } = source;
    const copie = Object.assign(reste, {
      numero: genererNumero(),
      nom: String(b.nom || '').trim() || `${source.nom} (copie)`,
      numeroSerie: '',
      compteur: { valeur: 0, unite: (source.compteur || {}).unite || 'heures' },
      compteurReleves: [], historiqueEtats: [], documents: [],
      createdBy: req.user.id,
    });
    if (b.parentId !== undefined) copie.parentId = b.parentId == null || b.parentId === '' ? null : Number(b.parentId);
    if (b.secteurId !== undefined && b.secteurId !== '' && b.secteurId != null) copie.secteurId = Number(b.secteurId);
    const data = valider(req, copie, null);
    Object.assign(data, { documents: [], compteurReleves: [], historiqueEtats: [], createdBy: req.user.id });
    const e = db.insert(ENTITE, data);
    ctx.audit(req, 'duplication', ENTITE, e.id, `Équipement ${e.numero} ${e.nom} (copie de ${source.numero})`);
    ctx.emit('equipement:cree', { equipement: e, source });
    return detail(req, e);
  }, { perm: [ENTITE, 'creer'] });

  // ----- Changement d'état -----------------------------------------------
  function changerEtat(req, equipement, etatCode, commentaire, dejaEnregistre) {
    const ancien = equipement.etatCode;
    const historique = (db.get(ENTITE, equipement.id).historiqueEtats || []).concat([{ date: new Date().toISOString(), ancien, nouveau: etatCode, commentaire: commentaire || '', userId: req.user.id }]);
    const e = db.update(ENTITE, equipement.id, Object.assign({ historiqueEtats: historique.slice(-200) }, dejaEnregistre ? {} : { etatCode }));
    const lib = (c) => { const it = ctx.liste('etatsEquipement').find((x) => x.code === c); return it ? it.label : c; };
    ctx.audit(req, 'statut', ENTITE, e.id, `Équipement ${e.numero} : ${lib(ancien)} → ${lib(etatCode)}${commentaire ? ' — ' + commentaire : ''}`);
    // Notification des personnes concernées : responsable du secteur et planificateurs (droit ot › affecter) du secteur
    const cibles = new Set();
    const secteur = e.secteurId != null ? db.get('secteurs', e.secteurId) : null;
    if (secteur && secteur.responsableId != null) cibles.add(Number(secteur.responsableId));
    for (const u of ctx.usersAvecDroit('ot', 'affecter', (u, p) => p.portee === 'tous' || e.secteurId == null || p.secteurIds.includes(Number(e.secteurId)))) cibles.add(u.id);
    cibles.delete(req.user.id);
    if (cibles.size) ctx.notify(Array.from(cibles), { titre: `Équipement ${e.numero} : ${lib(etatCode)}`, message: `${e.nom} est passé de « ${lib(ancien)} » à « ${lib(etatCode)} »${commentaire ? ' : ' + commentaire : ''} (${ctx.nomUser(req.user.id)})`, lien: '#/equipements/' + e.id, type: 'alerte' });
    ctx.emit('equipement:etat', { equipement: e, ancien, nouveau: etatCode, commentaire: commentaire || '', userId: req.user.id });
    return e;
  }

  router.put('/api/equipements/:id/etat', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const b = req.body || {};
    if (b.etatCode == null || b.etatCode === '') throw new HttpError(400, 'Le nouvel état est obligatoire');
    const etatCode = codeListe('etatsEquipement', b.etatCode, 'État');
    const commentaire = String(b.commentaire == null ? '' : b.commentaire).trim().slice(0, 1000);
    if (etatCode === existant.etatCode) throw new HttpError(400, 'L\'équipement est déjà dans cet état');
    const e = changerEtat(req, existant, etatCode, commentaire, false);
    return detail(req, e);
  }, { perm: [ENTITE, 'modifier'] });

  // ----- Compteur ---------------------------------------------------------
  function releverCompteur(equipementId, valeur, req, options = {}) {
    const e = db.get(ENTITE, equipementId);
    if (!e) throw new HttpError(404, 'Équipement introuvable');
    if (req && req.perms && !peutVoir(req, e)) throw new HttpError(404, 'Équipement introuvable');
    const v = Number(valeur);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, 'La valeur du compteur doit être un nombre positif');
    let date = new Date().toISOString();
    if (options.date) { const d = new Date(options.date); if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Date de relevé invalide'); if (d.getTime() > Date.now() + 60000) throw new HttpError(400, 'La date du relevé ne peut pas être dans le futur'); date = d.toISOString(); }
    const ancien = (e.compteur || {}).valeur || 0;
    const userId = req && req.user ? req.user.id : null;
    const releve = { date, valeur: v, userId, commentaire: String(options.commentaire || '').trim().slice(0, 500), otId: options.otId == null ? null : Number(options.otId) };
    const releves = (e.compteurReleves || []).concat([releve]).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-1000);
    const dernier = releves[releves.length - 1];
    const maj = db.update(ENTITE, e.id, { compteur: { valeur: dernier.valeur, unite: (e.compteur || {}).unite || 'heures' }, compteurReleves: releves });
    ctx.audit(req, 'compteur', ENTITE, e.id, `Relevé compteur ${e.numero} : ${ancien} → ${v} ${maj.compteur.unite}${releve.commentaire ? ' — ' + releve.commentaire : ''}`);
    ctx.emit('equipement:compteur', { equipement: maj, ancien, nouveau: maj.compteur.valeur, releve });
    return maj;
  }

  router.post('/api/equipements/:id/compteur', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const b = req.body || {};
    if (b.valeur == null || b.valeur === '') throw new HttpError(400, 'La valeur du relevé est obligatoire');
    const e = releverCompteur(existant.id, b.valeur, req, { date: b.date, commentaire: b.commentaire });
    return detail(req, e);
  }, { perm: [ENTITE, 'modifier'] });

  // ----- Documents --------------------------------------------------------
  router.post('/api/equipements/:id/documents', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const nomDoc = String(b.nom || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
    if (!nomDoc) throw new HttpError(400, 'Le nom du document est obligatoire');
    const contenu = typeof b.contenu === 'string' ? b.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu du document invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'Le document est vide');
    if (taille > TAILLE_MAX_DOC) throw new HttpError(400, `Document trop volumineux (${(taille / 1024 / 1024).toFixed(1)} Mo, maximum 5 Mo)`);
    const docs = existant.documents || [];
    if (docs.length >= MAX_DOCS) throw new HttpError(400, `Nombre maximal de documents atteint (${MAX_DOCS})`);
    const type = String(b.type || m[1] || 'application/octet-stream').slice(0, 100);
    const doc = { nom: nomDoc, type, taille, contenu: `data:${m[1] || type};base64,${base64}`, date: new Date().toISOString(), userId: req.user.id, description: String(b.description || '').trim().slice(0, 500) };
    const e = db.update(ENTITE, existant.id, { documents: docs.concat([doc]) });
    ctx.audit(req, 'document', ENTITE, e.id, `Document ajouté à ${e.numero} : ${nomDoc} (${Math.round(taille / 1024)} Ko)`);
    return { ok: true, document: resumeDoc(doc, e.documents.length - 1), documents: e.documents.map(resumeDoc) };
  }, { perm: [ENTITE, 'modifier'] });

  function indexDoc(req, existant) {
    const idx = Number(req.params.index);
    const docs = existant.documents || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= docs.length) throw new HttpError(404, 'Document introuvable');
    return idx;
  }

  /** Téléchargement / aperçu d'un document (GET, cookie de session suffisant). */
  router.get('/api/equipements/:id/documents/:index', async (req, res) => {
    const existant = getVisible(req, req.params.id);
    const doc = existant.documents[indexDoc(req, existant)];
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Document corrompu');
    const buf = Buffer.from(m[2], 'base64');
    const type = String(doc.type || m[1] || 'application/octet-stream').toLowerCase();
    const inline = (estImage(type) || type === 'application/pdf') && req.query.telecharger !== '1';
    const dangereux = /html|javascript|xml$|xhtml/.test(type) && !/svg/.test(type);
    const nomFichier = encodeURIComponent(doc.nom || 'document').replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': dangereux ? 'application/octet-stream' : type,
      'Content-Length': buf.length,
      'Content-Disposition': `${inline && !dangereux ? 'inline' : 'attachment'}; filename*=UTF-8''${nomFichier}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      'Cache-Control': 'private, max-age=300',
    });
    res.end(buf);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/equipements/:id/documents/:index', async (req) => {
    const existant = getVisible(req, req.params.id);
    verifierPorteeEcriture(req, existant.secteurId);
    const idx = indexDoc(req, existant);
    const docs = existant.documents.slice();
    const [sup] = docs.splice(idx, 1);
    const e = db.update(ENTITE, existant.id, { documents: docs });
    ctx.audit(req, 'document', ENTITE, e.id, `Document supprimé de ${e.numero} : ${sup.nom}`);
    return { ok: true, documents: e.documents.map(resumeDoc) };
  }, { perm: [ENTITE, 'modifier'] });

  // ----- Services publiés ---------------------------------------------------
  ctx.services.equipements = {
    /** Met à jour compteur.valeur et historise le relevé ; retourne l'équipement. */
    releverCompteur: (equipementId, valeur, req, options) => releverCompteur(equipementId, valeur, req, options),
    /** Équipement brut (ou null). */
    get: (id) => db.get(ENTITE, id),
    /** Secteur d'un équipement (pour reprise dans OT / demandes). */
    secteurDe: (id) => { const e = db.get(ENTITE, id); return e ? (e.secteurId == null ? null : Number(e.secteurId)) : null; },
    /** Chemin hiérarchique lisible « Secteur › Parent › Équipement ». */
    chemin: (id) => { const e = db.get(ENTITE, id); if (!e) return ''; return [cheminSecteur(e.secteurId)].concat(ancetres(e).map((a) => a.nom), [e.nom]).filter(Boolean).join(' › '); },
    /** Identifiants des sous-équipements (tous niveaux). */
    descendants: (id) => descendants(id),
    /** Un équipement est-il visible pour la requête ? */
    visible: (req, equipementOuId) => peutVoir(req, typeof equipementOuId === 'object' ? equipementOuId : db.get(ENTITE, equipementOuId)),
    UNITES_COMPTEUR,
  };
}

// ----- Données de démonstration ---------------------------------------------
function seedDemo(ctx) {
  const { db } = ctx;
  if (db.findOne('equipements', (e) => e.nom === 'Compresseur d\'air GA 37')) return 'déjà présents';
  const cfg = db.getConfig();
  const gabarit = (cfg.numerotation || {}).eq || 'EQ-{num:4}';
  const secteur = (code, repli) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : (repli ? secteur(repli) : null); };
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };
  const fournisseur = (re) => { const f = db.findOne('fournisseurs', (x) => re.test(x.nom || '')); return f ? f.id : null; };
  const ilYa = (jours) => new Date(Date.now() - jours * 86400000).toISOString();
  const dateIlYa = (jours) => ilYa(jours).slice(0, 10);
  const dansJours = (jours) => new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10);
  let numero = null;
  const numeroUnique = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('eq', gabarit); if (!db.findOne('equipements', (x) => x.numero === n)) return n; } return 'EQ-' + Date.now(); };
  const mk = (o, releves) => {
    const compteur = o.compteur || { valeur: 0, unite: 'heures' };
    const compteurReleves = (releves || []).map(([jours, valeur, login]) => ({ date: ilYa(jours), valeur, userId: userId(login || 'admin'), commentaire: '', otId: null }));
    numero = numeroUnique();
    return db.insert('equipements', Object.assign({
      numero, description: '', localisation: '', marque: '', modele: '', numeroSerie: '', fournisseurId: null,
      dateMiseEnService: null, dateAchat: null, valeurAchat: null, garantieFin: null, documents: [], notes: '', actif: true, champs: {}, parentId: null,
      typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', createdBy: admin ? admin.id : null, historiqueEtats: [],
    }, o, { compteur, compteurReleves }));
  };
  const PROD = secteur('PROD'), L1 = secteur('PROD-L1', 'PROD'), L2 = secteur('PROD-L2', 'PROD'), MAINT = secteur('MAINT', 'PROD'), LOG = secteur('LOG', 'PROD'), QUAL = secteur('QUAL', 'PROD'), SG = secteur('SG', 'PROD');
  if (PROD == null) return 'secteurs absents';

  const svgPhoto = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220"><rect width="360" height="220" fill="#e5e7eb"/><rect x="36" y="78" width="180" height="96" rx="10" fill="#2563eb"/><rect x="52" y="94" width="148" height="20" rx="4" fill="#dbeafe"/><circle cx="268" cy="126" r="46" fill="#1e3a8a"/><circle cx="268" cy="126" r="22" fill="#60a5fa"/><rect x="60" y="176" width="220" height="12" rx="3" fill="#6b7280"/><text x="180" y="48" font-family="Segoe UI, Arial" font-size="18" font-weight="600" text-anchor="middle" fill="#111827">Compresseur GA 37</text></svg>';
  const photo = { nom: 'photo-compresseur.svg', type: 'image/svg+xml', taille: Buffer.byteLength(svgPhoto), contenu: 'data:image/svg+xml;base64,' + Buffer.from(svgPhoto).toString('base64'), date: ilYa(120), userId: admin ? admin.id : null, description: 'Photo de la salle des compresseurs' };
  const fiche = { nom: 'consignes-arret-urgence.txt', type: 'text/plain', taille: 0, contenu: '', date: ilYa(90), userId: admin ? admin.id : null, description: 'Consignes d\'arrêt d\'urgence' };
  const texteFiche = 'CONSIGNES D\'ARRÊT D\'URGENCE — Compresseur GA 37\r\n1. Appuyer sur le bouton coup de poing rouge.\r\n2. Fermer la vanne d\'isolement réseau 7 bar.\r\n3. Consigner l\'armoire électrique (cadenas).\r\n4. Prévenir le responsable maintenance.\r\n';
  fiche.taille = Buffer.byteLength(texteFiche); fiche.contenu = 'data:text/plain;base64,' + Buffer.from(texteFiche).toString('base64');

  // Services généraux : utilités
  mk({ nom: 'Compresseur d\'air GA 37', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: SG, localisation: 'Bâtiment utilités, salle des compresseurs', marque: 'Atlas Copco', modele: 'GA 37 VSD+', numeroSerie: 'AIF 254 118', fournisseurId: fournisseur(/atlas/i), dateMiseEnService: '2019-03-12', dateAchat: '2019-02-01', valeurAchat: 28500, garantieFin: '2022-03-12', compteur: { valeur: 18420, unite: 'heures' }, description: 'Compresseur à vis lubrifié à vitesse variable, 37 kW, 7,5 bar. Alimente le réseau d\'air comprimé de l\'usine.', notes: 'Vidange huile tous les 4 000 h. Filtres à air et séparateur à remplacer à 8 000 h.', documents: [photo, fiche] }, [[180, 16950], [90, 17640], [30, 18120], [7, 18420]]);
  mk({ nom: 'Groupe froid industriel', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: SG, localisation: 'Toiture bâtiment B', marque: 'Trane', modele: 'CGAM 120', numeroSerie: 'TR-CGAM-00871', fournisseurId: fournisseur(/trane/i), dateMiseEnService: '2017-06-20', dateAchat: '2017-05-10', valeurAchat: 64000, garantieFin: '2019-06-20', compteur: { valeur: 41200, unite: 'heures' }, description: 'Groupe de production d\'eau glacée 120 kW (R410A) pour les lignes de conditionnement et le laboratoire.', notes: 'Contrôle d\'étanchéité fluide frigorigène obligatoire tous les 12 mois.' }, [[365, 37100], [180, 39300], [30, 40900], [3, 41200]]);
  mk({ nom: 'CTA atelier conditionnement', typeCode: 'batiment', etatCode: 'en_service', criticiteCode: 'B', secteurId: SG, localisation: 'Local technique mezzanine', marque: 'Carrier', modele: '39CQ 12', numeroSerie: 'CQ-12-4471', dateMiseEnService: '2017-06-20', valeurAchat: 18900, compteur: { valeur: 0, unite: 'heures' }, description: 'Centrale de traitement d\'air double flux avec récupération de chaleur (12 000 m³/h).', notes: 'Remplacement des filtres F7 chaque trimestre.' });

  // Production : ligne 1 (conditionnement) et ses sous-équipements
  const ligne1 = mk({ nom: 'Ligne de conditionnement L1', typeCode: 'ligne', etatCode: 'en_service', criticiteCode: 'A', secteurId: L1, localisation: 'Hall A, travées 1 à 4', marque: 'Krones', modele: 'Ligne 24 000 b/h', dateMiseEnService: '2016-09-05', dateAchat: '2016-04-15', valeurAchat: 1250000, compteur: { valeur: 9840, unite: 'heures' }, description: 'Ligne complète de conditionnement bouteilles 1 L (remplissage, étiquetage, fardelage, convoyage).', notes: 'Cadence nominale 24 000 bouteilles/heure. Arrêt planifié chaque dimanche pour nettoyage.' }, [[60, 9410], [14, 9720], [2, 9840]]);
  mk({ nom: 'Remplisseuse rotative', parentId: ligne1.id, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: L1, localisation: 'Hall A, travée 1', marque: 'Krones', modele: 'Modulfill VFS 60', numeroSerie: 'K-MF-2016-0412', dateMiseEnService: '2016-09-05', valeurAchat: 420000, compteur: { valeur: 184500000, unite: 'cycles' }, description: 'Remplisseuse volumétrique 60 becs avec bouchonneuse intégrée.', notes: 'Joints de becs à remplacer tous les 50 millions de cycles.' }, [[60, 176000000], [14, 182100000], [2, 184500000]]);
  mk({ nom: 'Étiqueteuse', parentId: ligne1.id, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', secteurId: L1, localisation: 'Hall A, travée 2', marque: 'Sidel', modele: 'Rollquattro Evo', numeroSerie: 'SD-RQ-7781', dateMiseEnService: '2016-09-05', valeurAchat: 185000, compteur: { valeur: 9700, unite: 'heures' } }, [[30, 9480], [2, 9700]]);
  mk({ nom: 'Fardeleuse', parentId: ligne1.id, typeCode: 'machine', etatCode: 'degrade', criticiteCode: 'B', secteurId: L1, localisation: 'Hall A, travée 3', marque: 'Krones', modele: 'Variopac Pro', numeroSerie: 'K-VP-2016-0098', dateMiseEnService: '2016-09-05', valeurAchat: 160000, compteur: { valeur: 9650, unite: 'heures' }, notes: 'Four de rétraction : résistance n°3 HS, fonctionne à cadence réduite (-20 %).', historiqueEtats: [{ date: ilYa(5), ancien: 'en_service', nouveau: 'degrade', commentaire: 'Résistance n°3 du four de rétraction hors service', userId: admin ? admin.id : null }] }, [[30, 9420], [2, 9650]]);
  mk({ nom: 'Convoyeur de sortie ligne 1', parentId: ligne1.id, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'C', secteurId: L1, localisation: 'Hall A, travée 4', marque: 'Interroll', modele: 'Convoyeur à bande 12 m', compteur: { valeur: 9840, unite: 'heures' } });

  // Production : ligne 2 (assemblage)
  const ligne2 = mk({ nom: 'Ligne d\'assemblage L2', typeCode: 'ligne', etatCode: 'en_service', criticiteCode: 'B', secteurId: L2, localisation: 'Hall B', dateMiseEnService: '2020-01-15', valeurAchat: 480000, compteur: { valeur: 6120, unite: 'heures' }, description: 'Ligne d\'assemblage semi-automatique : presse, robot de palettisation, postes manuels.' }, [[45, 5890], [3, 6120]]);
  mk({ nom: 'Presse hydraulique 250 t', parentId: ligne2.id, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: L2, localisation: 'Hall B, poste 1', marque: 'Schuler', modele: 'PH 250', numeroSerie: 'SCH-PH250-1187', dateMiseEnService: '2020-01-15', dateAchat: '2019-11-02', valeurAchat: 215000, garantieFin: '2022-01-15', compteur: { valeur: 1265000, unite: 'cycles' }, description: 'Presse hydraulique d\'emboutissage 250 tonnes, table 1 600 × 1 200 mm.', notes: 'Contrôle réglementaire annuel (vérification périodique presse). Niveau d\'huile hydraulique à vérifier chaque semaine.' }, [[90, 1198000], [30, 1241000], [3, 1265000]]);
  mk({ nom: 'Robot de palettisation', parentId: ligne2.id, typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'B', secteurId: L2, localisation: 'Hall B, poste 4', marque: 'ABB', modele: 'IRB 660-180/3.15', numeroSerie: 'ABB-660-30417', dateMiseEnService: '2020-01-15', valeurAchat: 98000, garantieFin: '2023-01-15', compteur: { valeur: 6050, unite: 'heures' }, notes: 'Graissage des axes 1 à 4 toutes les 2 000 h (graisse Kyodo Yushi).' }, [[45, 5820], [3, 6050]]);

  // Maintenance
  mk({ nom: 'Pont roulant 5 t', typeCode: 'machine', etatCode: 'en_service', criticiteCode: 'A', secteurId: MAINT, localisation: 'Atelier maintenance', marque: 'Demag', modele: 'EKKE 5 t', numeroSerie: 'DM-EKKE-5-0932', dateMiseEnService: '2012-04-10', valeurAchat: 46000, compteur: { valeur: 3420, unite: 'heures' }, description: 'Pont roulant monopoutre 5 t, portée 18 m, commande par boîte à boutons.', notes: 'Vérification générale périodique (VGP) tous les 12 mois — organisme agréé.' }, [[200, 3310], [10, 3420]]);
  mk({ nom: 'Poste à souder TIG', typeCode: 'outillage', etatCode: 'en_service', criticiteCode: 'C', secteurId: MAINT, localisation: 'Atelier maintenance, zone soudure', marque: 'Fronius', modele: 'MagicWave 230i', numeroSerie: 'FR-MW-230-55102', dateAchat: '2021-10-05', valeurAchat: 3900, garantieFin: dansJours(120) });

  // Logistique
  mk({ nom: 'Chariot élévateur électrique n°1', typeCode: 'vehicule', etatCode: 'en_service', criticiteCode: 'B', secteurId: LOG, localisation: 'Entrepôt expéditions', marque: 'Toyota', modele: '8FBE20', numeroSerie: '8FBE20-E-40221', dateMiseEnService: '2021-02-01', dateAchat: '2021-01-20', valeurAchat: 32000, garantieFin: '2024-02-01', compteur: { valeur: 4860, unite: 'heures' }, description: 'Chariot frontal électrique 2 t, mât triplex 4,7 m, batterie 48 V.', notes: 'VGP semestrielle. Contrôle batterie et niveau d\'eau toutes les semaines.' }, [[120, 4310], [45, 4620], [5, 4860]]);
  mk({ nom: 'Chariot élévateur thermique n°2', typeCode: 'vehicule', etatCode: 'arret', criticiteCode: 'C', secteurId: LOG, localisation: 'Cour de réception', marque: 'Linde', modele: 'H25 D', numeroSerie: 'H2X392W04521', dateMiseEnService: '2014-05-15', valeurAchat: 29000, compteur: { valeur: 11230, unite: 'heures' }, notes: 'À l\'arrêt : fuite hydraulique sur vérin d\'inclinaison, pièce en commande.', historiqueEtats: [{ date: ilYa(3), ancien: 'en_service', nouveau: 'arret', commentaire: 'Fuite hydraulique vérin d\'inclinaison', userId: admin ? admin.id : null }] }, [[300, 10650], [30, 11190], [4, 11230]]);
  mk({ nom: 'Transpalette électrique', typeCode: 'outillage', etatCode: 'en_service', criticiteCode: 'C', secteurId: LOG, localisation: 'Quai 2', marque: 'Jungheinrich', modele: 'EJE 120', numeroSerie: 'JH-EJE-120-7730', dateAchat: '2022-03-01', valeurAchat: 4200, compteur: { valeur: 1120, unite: 'heures' } }, [[60, 980], [6, 1120]]);

  // Qualité / laboratoire
  mk({ nom: 'Étuve de laboratoire', typeCode: 'instrument', etatCode: 'en_service', criticiteCode: 'C', secteurId: QUAL, localisation: 'Laboratoire contrôle qualité', marque: 'Memmert', modele: 'UF 110', numeroSerie: 'MM-UF110-21-889', dateMiseEnService: '2021-04-12', valeurAchat: 3100, notes: 'Étalonnage sonde de température annuel (COFRAC).' });
  mk({ nom: 'Balance de précision', typeCode: 'instrument', etatCode: 'en_service', criticiteCode: 'B', secteurId: QUAL, localisation: 'Laboratoire contrôle qualité, paillasse 2', marque: 'Mettler Toledo', modele: 'MS 6002 TS', numeroSerie: 'MT-B-6002-1194', dateMiseEnService: '2022-09-01', valeurAchat: 2450, garantieFin: dansJours(45), notes: 'Vérification métrologique semestrielle avec masses étalon classe F1.' });

  // Équipement réformé (historique)
  mk({ nom: 'Compresseur d\'air GA 22 (ancien)', typeCode: 'machine', etatCode: 'reforme', criticiteCode: 'C', secteurId: SG, localisation: 'Zone de stockage extérieure', marque: 'Atlas Copco', modele: 'GA 22', numeroSerie: 'AIF 118 002', dateMiseEnService: '2005-01-10', valeurAchat: 14000, compteur: { valeur: 61200, unite: 'heures' }, actif: false, notes: 'Réformé en 2019, remplacé par le GA 37. Conservé pour pièces.', historiqueEtats: [{ date: ilYa(400), ancien: 'en_service', nouveau: 'reforme', commentaire: 'Remplacé par le compresseur GA 37', userId: admin ? admin.id : null }] });

  const total = db.count('equipements');
  return `${total} équipements (dont 6 sous-équipements, 2 lignes avec arborescence, 1 réformé) — dernier numéro ${numero}`;
}

module.exports = { nom, register, seedDemo, csvEscape };
