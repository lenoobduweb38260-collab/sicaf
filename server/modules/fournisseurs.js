'use strict';
/**
 * Module Fournisseurs & prestataires.
 *
 *  - Fiches fournisseurs (pièces détachées), prestataires de services (maintenance externe, contrôles
 *    réglementaires, étalonnage…) et constructeurs : type (liste configurable `typesFournisseur`),
 *    contact principal, coordonnées, adresse, site web, SIRET, délai de livraison, notes,
 *    contacts multiples [{ nom, fonction, telephone, email }], champs personnalisés.
 *  - Données transversales : pas de portée par secteur sur les fiches elles-mêmes, mais les éléments
 *    liés affichés dans le détail (articles, équipements, OT, réceptions) respectent les droits des
 *    modules concernés ET la portée de l'utilisateur.
 *  - Suppression : un fournisseur référencé (articles, équipements, OT, mouvements de stock) est
 *    désactivé au lieu d'être supprimé (traçabilité).
 *
 * Routes : GET/POST /api/fournisseurs, GET/PUT/DELETE /api/fournisseurs/:id,
 *          POST /api/fournisseurs/:id/dupliquer, GET /api/fournisseurs-export (CSV).
 * Services publiés : ctx.services.fournisseurs = { get, nom, actifs, references, estReference, totalAchats }.
 * Événements émis : fournisseur:cree, fournisseur:modifie, fournisseur:desactive, fournisseur:supprime.
 */
const nom = 'Fournisseurs & prestataires';
const ENTITE = 'fournisseurs';
const MODULE = 'fournisseurs';
const LISTE_TYPES = 'typesFournisseur';

const MAX_NOM = 150;
const MAX_CONTACTS = 50;
const MAX_DELAI = 365;
const MAX_RECEPTIONS = 100;

// ----- Utilitaires purs -------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arrondi = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
/** Minuscules, sans accents, espaces normalisés (comparaison « insensible à la casse »). */
const normaliser = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const vrai = (v) => v === true || v === 1 || ['1', 'true', 'oui', 'on'].includes(String(v == null ? '' : v).toLowerCase());
const faux = (v) => v === false || v === 0 || ['0', 'false', 'non', 'off'].includes(String(v == null ? '' : v).toLowerCase());

const RE_EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;
const RE_TELEPHONE = /^\+?[0-9\s().\/-]{4,30}$/;

const { csvEscape } = require('../csv');
/** SIRET lisible : « 123 456 789 00012 ». */
function formatSiret(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length === 14 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : String(s || '');
}
/** Clé de mois locale « AAAA-MM ». */
function moisDe(d) { const x = new Date(d); return Number.isNaN(x.getTime()) ? '' : `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; }
function douzeDerniersMois() {
  const out = []; const d = new Date(); d.setDate(1);
  for (let i = 11; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); }
  return out;
}
function dateLocale(d) { const x = d ? new Date(d) : new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }

/** Collections traitées explicitement (ou sans lien possible avec un fournisseur) lors du comptage des références. */
const COLLECTIONS_CONNUES = new Set([ENTITE, 'articles', 'equipements', 'ot', 'mouvementsStock', 'audit', 'notifications', 'users', 'profils', 'secteurs']);
/** Libellés des collections d'autres modules pouvant référencer un fournisseur. */
const LIBELLES_COLLECTIONS = {
  commandes: 'commande(s) fournisseur', commandesFournisseurs: 'commande(s) fournisseur', receptions: 'réception(s)', factures: 'facture(s)',
  contrats: 'contrat(s)', plansPreventifs: 'plan(s) préventif(s)', demandes: 'demande(s) d\'intervention', documents: 'document(s)',
};

/** Libellés des champs (journal d'audit des modifications). */
const LIBELLES = {
  nom: 'nom', typeCode: 'type', contact: 'contact principal', telephone: 'téléphone', email: 'e-mail', adresse: 'adresse', siteWeb: 'site web',
  siret: 'SIRET', delaiLivraisonJours: 'délai de livraison', notes: 'notes', actif: 'statut', contacts: 'contacts', champs: 'champs personnalisés',
};

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  // ----- Validation des entrées ---------------------------------------------------
  function objet(b) {
    if (b == null || b === '') return {};
    if (typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) throw new HttpError(400, 'Corps de requête invalide (objet JSON attendu)');
    return b;
  }
  function texte(v, label, { requis = false, max = 1000 } = {}) {
    if (v != null && typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${label} : valeur invalide (texte attendu)`);
    const s = v == null ? '' : String(v).trim();
    if (requis && !s) throw new HttpError(400, `${label} : champ obligatoire`);
    if (s.length > max) throw new HttpError(400, `${label} : ${max} caractères maximum`);
    return s;
  }
  function email(v, label) {
    const s = texte(v, label, { max: 200 });
    if (s && !RE_EMAIL.test(s)) throw new HttpError(400, `${label} : adresse e-mail invalide (ex. contact@exemple.fr)`);
    return s;
  }
  function telephone(v, label) {
    const s = texte(v, label, { max: 30 }).replace(/\s+/g, ' ');
    if (s && (!RE_TELEPHONE.test(s) || s.replace(/\D/g, '').length < 4)) throw new HttpError(400, `${label} : numéro invalide (chiffres, espaces, + . - ( ) / uniquement)`);
    return s;
  }
  function siteWeb(v) {
    let s = texte(v, 'Site web', { max: 300 });
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || !/^[^.\s]+(\.[^.\s]+)+$/.test(u.hostname) || /\s/.test(s)) {
      throw new HttpError(400, 'Site web : adresse invalide (ex. https://www.exemple.fr)');
    }
    return s;
  }
  function siret(v) {
    const s = texte(v, 'SIRET', { max: 30 });
    if (!s) return '';
    const d = s.replace(/[\s.-]/g, '');
    if (!/^\d{14}$/.test(d)) throw new HttpError(400, 'SIRET invalide : 14 chiffres attendus');
    return d;
  }
  function delai(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'number' && typeof v !== 'string') throw new HttpError(400, 'Délai de livraison : nombre de jours attendu');
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(400, 'Délai de livraison : nombre entier de jours attendu');
    if (n < 0) throw new HttpError(400, 'Délai de livraison : la valeur ne peut pas être négative');
    if (n > MAX_DELAI) throw new HttpError(400, `Délai de livraison : ${MAX_DELAI} jours maximum`);
    return n;
  }
  function booleen(v, label) {
    if (v === undefined || v === null || v === '') return true;
    if (vrai(v)) return true;
    if (faux(v)) return false;
    throw new HttpError(400, `${label} : valeur booléenne attendue`);
  }
  function codeType(v) {
    const l = ctx.liste(LISTE_TYPES);
    if (v === undefined || v === null || v === '') return l.length ? l[0].code : null;
    if (typeof v !== 'string') throw new HttpError(400, 'Type de fournisseur invalide');
    if (!l.some((x) => x.code === v)) throw new HttpError(400, `Type de fournisseur inconnu : « ${v} »`);
    return v;
  }
  function validerContacts(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'Contacts : liste attendue');
    const out = [];
    v.forEach((c, i) => {
      const n = i + 1;
      if (c == null) return;
      if (typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `Contact n°${n} : objet attendu`);
      const x = {
        nom: texte(c.nom, `Contact n°${n} — nom`, { max: 150 }),
        fonction: texte(c.fonction, `Contact n°${n} — fonction`, { max: 150 }),
        telephone: telephone(c.telephone, `Contact n°${n} — téléphone`),
        email: email(c.email, `Contact n°${n} — e-mail`),
      };
      if (!x.nom && !x.fonction && !x.telephone && !x.email) return; // ligne vide ignorée
      if (!x.nom) throw new HttpError(400, `Contact n°${n} : le nom est obligatoire`);
      out.push(x);
    });
    if (out.length > MAX_CONTACTS) throw new HttpError(400, `Contacts : ${MAX_CONTACTS} au maximum`);
    return out;
  }

  const nomExistant = (n, saufId) => { const k = normaliser(n); return db.findOne(ENTITE, (f) => f.id !== saufId && normaliser(f.nom) === k); };
  const siretExistant = (s, saufId) => (s ? db.findOne(ENTITE, (f) => f.id !== saufId && String(f.siret || '').replace(/\D/g, '') === s) : null);

  /** Valide le corps d'une création (existant = null) ou d'une modification partielle. */
  function valider(body, existant) {
    body = objet(body);
    const fourni = (k) => !existant || body[k] !== undefined;
    const out = {};
    const saufId = existant ? existant.id : null;
    if (fourni('nom')) {
      out.nom = texte(body.nom, 'Nom', { requis: true, max: MAX_NOM }).replace(/\s+/g, ' ');
      const doublon = nomExistant(out.nom, saufId);
      if (doublon) throw new HttpError(400, `Un fournisseur nommé « ${doublon.nom} » existe déjà${doublon.actif === false ? ' (désactivé)' : ''}`);
    }
    if (fourni('typeCode')) out.typeCode = codeType(body.typeCode);
    if (fourni('contact')) out.contact = texte(body.contact, 'Contact principal', { max: 150 });
    if (fourni('telephone')) out.telephone = telephone(body.telephone, 'Téléphone');
    if (fourni('email')) out.email = email(body.email, 'E-mail');
    if (fourni('adresse')) out.adresse = texte(body.adresse, 'Adresse', { max: 500 });
    if (fourni('siteWeb')) out.siteWeb = siteWeb(body.siteWeb);
    if (fourni('siret')) {
      out.siret = siret(body.siret);
      const doublon = siretExistant(out.siret, saufId);
      if (doublon) throw new HttpError(400, `Ce SIRET est déjà attribué au fournisseur « ${doublon.nom} »`);
    }
    if (fourni('delaiLivraisonJours')) out.delaiLivraisonJours = delai(body.delaiLivraisonJours);
    if (fourni('notes')) out.notes = texte(body.notes, 'Notes', { max: 5000 });
    if (fourni('actif')) out.actif = booleen(body.actif, 'Actif');
    if (fourni('contacts')) out.contacts = validerContacts(body.contacts);
    if (fourni('champs')) {
      if (body.champs != null && (typeof body.champs !== 'object' || Array.isArray(body.champs))) throw new HttpError(400, 'Champs personnalisés : objet attendu');
      out.champs = ctx.champsPerso(ENTITE, body.champs || (existant && existant.champs) || {});
    }
    return out;
  }

  // ----- Références et visibilité ----------------------------------------------------
  const peut = (req, module, action) => perms.can(req.perms, module, action || 'voir');
  function trouver(id) {
    const n = Number(id);
    const f = Number.isInteger(n) && n > 0 ? db.get(ENTITE, n) : null;
    if (!f) throw new HttpError(404, 'Fournisseur introuvable');
    return f;
  }
  const libelleType = (code) => { const it = ctx.liste(LISTE_TYPES).find((x) => x.code === code); return it ? it.label : (code || ''); };
  function otEstFinal(o) {
    const s = ctx.services.ot;
    if (s && typeof s.estFinal === 'function') { try { return !!s.estFinal(o.statut); } catch (e) { /* repli */ } }
    const it = ctx.liste('statutsOT').find((x) => x.code === o.statut);
    return !!(it && it.final);
  }
  function equipementVisible(req, e) {
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli */ } }
    return ctx.canSee(req, e);
  }
  const lie = (rec, id) => rec.fournisseurId != null && rec.fournisseurId !== '' && Number(rec.fournisseurId) === id;
  const coutsOt = (o) => {
    const externe = arrondi(num(o.coutExterne)); const pieces = arrondi(num(o.coutPieces)); const mo = arrondi(num(o.coutMainOeuvre));
    return { coutExterne: externe, coutPieces: pieces, coutMainOeuvre: mo, coutTotal: arrondi(externe + pieces + mo) };
  };
  const montantMouvement = (m) => arrondi(num(m.quantite) * num(m.prixUnitaire));

  /**
   * Nombre de références (toutes portées confondues) : décide entre suppression et désactivation.
   * Outre les collections connues, toute autre collection (ex. commandes ou factures d'un module
   * d'achats) dont les enregistrements portent `fournisseurId` ou `fournisseurIds` est prise en compte.
   */
  function nbReferences(id) {
    const r = {
      articles: db.count('articles', (a) => lie(a, id)),
      equipements: db.count('equipements', (e) => lie(e, id)),
      ot: db.count('ot', (o) => lie(o, id)),
      mouvements: db.count('mouvementsStock', (m) => lie(m, id)),
      autres: {},
    };
    for (const col of db.collections()) {
      if (COLLECTIONS_CONNUES.has(col)) continue;
      const n = db.count(col, (x) => !!x && typeof x === 'object' && (lie(x, id) || (Array.isArray(x.fournisseurIds) && x.fournisseurIds.map(Number).includes(id))));
      if (n) r.autres[col] = n;
    }
    r.total = r.articles + r.equipements + r.ot + r.mouvements + Object.values(r.autres).reduce((s, n) => s + n, 0);
    return r;
  }
  function libelleReferences(r) {
    return [r.articles ? `${r.articles} article(s)` : '', r.equipements ? `${r.equipements} équipement(s)` : '', r.ot ? `${r.ot} ordre(s) de travail` : '', r.mouvements ? `${r.mouvements} mouvement(s) de stock` : '']
      .concat(Object.entries(r.autres || {}).map(([col, n]) => `${n} ${LIBELLES_COLLECTIONS[col] || `enregistrement(s) « ${col} »`}`)).filter(Boolean).join(', ');
  }

  /**
   * Éléments liés visibles par l'utilisateur (droits des modules concernés + portée), indexés par fournisseur.
   * Les fiches fournisseurs sont transversales ; ce qui s'y rattache ne l'est pas forcément.
   */
  function contexte(req) {
    const acces = { articles: peut(req, 'stock'), equipements: peut(req, 'equipements'), ot: peut(req, 'ot') };
    acces.achats = acces.articles;
    const grouper = (rows) => { const m = new Map(); for (const r of rows) { const k = Number(r.fournisseurId); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const articlesVisibles = acces.articles ? ctx.scope(req, db.list('articles')) : [];
    const idsArticles = new Map(articlesVisibles.map((a) => [a.id, a]));
    const articles = grouper(articlesVisibles.filter((a) => a.fournisseurId != null && a.fournisseurId !== ''));
    const equipements = grouper(acces.equipements ? db.list('equipements', (e) => e.fournisseurId != null && e.fournisseurId !== '').filter((e) => equipementVisible(req, e)) : []);
    const ots = grouper(acces.ot ? ctx.scope(req, db.list('ot', (o) => o.fournisseurId != null && o.fournisseurId !== '')) : []);
    // Réceptions : mouvements d'entrée dont l'article est visible (article supprimé : visible en portée « tous »)
    const tous = req.perms && req.perms.portee === 'tous';
    const tousArticles = acces.achats ? new Set(db.list('articles').map((a) => a.id)) : new Set();
    const entrees = grouper(acces.achats ? db.list('mouvementsStock', (m) => m.type === 'entree' && m.fournisseurId != null && m.fournisseurId !== '')
      .filter((m) => idsArticles.has(Number(m.articleId)) || (tous && !tousArticles.has(Number(m.articleId)))) : []);
    return { acces, articles, equipements, ots, entrees, idsArticles };
  }

  /** Représentation enrichie pour les listes. */
  function resume(f, c) {
    const contacts = Array.isArray(f.contacts) ? f.contacts : [];
    const premier = contacts[0] || {};
    const articles = c ? c.articles.get(f.id) || [] : [];
    const entrees = c ? c.entrees.get(f.id) || [] : [];
    const ots = c ? c.ots.get(f.id) || [] : [];
    return Object.assign({}, f, {
      typeCode: f.typeCode || null,
      typeLibelle: libelleType(f.typeCode),
      contact: f.contact || '', telephone: f.telephone || '', email: f.email || '', adresse: f.adresse || '', siteWeb: f.siteWeb || '',
      siret: f.siret || '', notes: f.notes || '', delaiLivraisonJours: f.delaiLivraisonJours == null || f.delaiLivraisonJours === '' ? null : Number(f.delaiLivraisonJours),
      actif: f.actif !== false, contacts, champs: f.champs || {},
      contactPrincipal: f.contact || premier.nom || '',
      fonctionPrincipale: f.contact ? '' : (premier.fonction || ''),
      telephonePrincipal: f.telephone || premier.telephone || '',
      emailPrincipal: f.email || premier.email || '',
      nbContacts: contacts.length,
      nbArticles: articles.length,
      nbEquipements: c ? (c.equipements.get(f.id) || []).length : 0,
      nbOt: ots.length,
      nbOtOuverts: ots.filter((o) => !otEstFinal(o)).length,
      totalAchats: c && c.acces.achats ? arrondi(entrees.reduce((s, m) => s + montantMouvement(m), 0)) : null,
    });
  }

  /** Fiche détaillée : articles fournis, équipements, interventions externes, réceptions, statistiques. */
  function detail(req, f) {
    const c = contexte(req);
    const r = resume(f, c);
    r.acces = c.acces;
    r.references = nbReferences(f.id);
    r.createdByNom = f.createdBy != null ? ctx.nomUser(f.createdBy) : '';

    // Articles fournis (articles.fournisseurId) — règle du seuil du module Stock (un article sans seuil n'est pas suivi)
    const svcStock = ctx.services.stock;
    const sousSeuil = (a) => (svcStock && typeof svcStock.estSousSeuil === 'function' ? !!svcStock.estSousSeuil(a) : (num(a.seuilMin) > 0 && num(a.quantite) <= num(a.seuilMin)));
    r.articles = (c.articles.get(f.id) || []).map((a) => {
      const quantite = num(a.quantite); const seuilMin = num(a.seuilMin); const actif = a.actif !== false;
      return {
        id: a.id, code: a.code || '', designation: a.designation || '', categorieCode: a.categorieCode || null, uniteCode: a.uniteCode || '',
        referenceFournisseur: a.referenceFournisseur || '', emplacement: a.emplacement || '', quantite, seuilMin,
        quantiteCommande: num(a.quantiteCommande), prixUnitaire: num(a.prixUnitaire), valeur: arrondi(Math.max(0, quantite) * num(a.prixUnitaire)),
        sousSeuil: actif && sousSeuil(a), rupture: actif && quantite <= 0, actif, secteurId: a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId),
      };
    }).sort((p, q) => (p.actif === q.actif ? 0 : p.actif ? -1 : 1) || p.designation.localeCompare(q.designation, 'fr'));

    // Équipements fournis (equipements.fournisseurId)
    const aujourdhui = dateLocale();
    r.equipements = (c.equipements.get(f.id) || []).map((e) => ({
      id: e.id, numero: e.numero || '', nom: e.nom || '', typeCode: e.typeCode || null, etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null,
      secteurId: e.secteurId == null || e.secteurId === '' ? null : Number(e.secteurId), localisation: e.localisation || '', marque: e.marque || '', modele: e.modele || '',
      numeroSerie: e.numeroSerie || '', dateAchat: e.dateAchat || null, valeurAchat: e.valeurAchat == null || e.valeurAchat === '' ? null : num(e.valeurAchat),
      dateMiseEnService: e.dateMiseEnService || null, garantieFin: e.garantieFin || null, sousGarantie: !!(e.garantieFin && String(e.garantieFin).slice(0, 10) >= aujourdhui), actif: e.actif !== false,
    })).sort((p, q) => String(p.numero).localeCompare(String(q.numero), 'fr', { numeric: true }));

    // Interventions externes (ot.fournisseurId) avec coûts
    const equipements = new Map(db.list('equipements').map((e) => [e.id, e]));
    r.interventions = (c.ots.get(f.id) || []).map((o) => {
      const e = o.equipementId != null ? equipements.get(Number(o.equipementId)) : null;
      return Object.assign({
        id: o.id, numero: o.numero || '', titre: o.titre || '', typeCode: o.typeCode || null, prioriteCode: o.prioriteCode || null, statut: o.statut || null,
        final: otEstFinal(o), equipementId: e ? e.id : null, equipementNom: e ? e.nom || '' : '', equipementNumero: e ? e.numero || '' : '',
        secteurId: o.secteurId == null || o.secteurId === '' ? null : Number(o.secteurId), technicienId: o.technicienId == null ? null : o.technicienId,
        datePrevue: o.datePrevue || null, dateDebut: o.dateDebut || null, dateFin: o.dateFin || null, dateCloture: o.dateCloture || null,
        dateReference: o.dateFin || o.dateCloture || o.dateDebut || o.datePrevue || o.createdAt || null,
      }, coutsOt(o));
    }).sort((p, q) => String(q.dateReference || '').localeCompare(String(p.dateReference || '')) || q.id - p.id);

    // Réceptions (mouvements d'entrée) : total des achats = Σ quantité × prix unitaire
    const articlesParId = new Map(db.list('articles').map((a) => [a.id, a]));
    const entrees = (c.entrees.get(f.id) || []).slice().sort((p, q) => String(q.date || '').localeCompare(String(p.date || '')) || q.id - p.id);
    const mois = douzeDerniersMois();
    const parMois = new Map(mois.map((m) => [m, 0]));
    let total = 0; let total12 = 0;
    for (const m of entrees) {
      const montant = montantMouvement(m);
      total += montant;
      const k = moisDe(m.date);
      if (parMois.has(k)) { parMois.set(k, arrondi(parMois.get(k) + montant)); total12 += montant; }
    }
    r.achats = {
      total: c.acces.achats ? arrondi(total) : null,
      total12Mois: c.acces.achats ? arrondi(total12) : null,
      nbReceptions: entrees.length,
      derniereReception: entrees.length ? entrees[0].date : null,
      parMois: c.acces.achats ? mois.map((m) => ({ mois: m, montant: parMois.get(m) })) : [],
      receptions: entrees.slice(0, MAX_RECEPTIONS).map((m) => {
        const a = articlesParId.get(Number(m.articleId));
        return {
          id: m.id, date: m.date, articleId: m.articleId, articleExiste: !!a, articleCode: a ? a.code || '' : '', articleDesignation: a ? a.designation || '' : '(article supprimé)',
          uniteCode: a ? a.uniteCode || '' : '', quantite: num(m.quantite), prixUnitaire: num(m.prixUnitaire), montant: montantMouvement(m), motif: m.motif || '',
          userId: m.userId == null ? null : m.userId, userNom: m.userId != null ? ctx.nomUser(m.userId) : '',
        };
      }),
    };

    const anneeEnCours = String(new Date().getFullYear());
    r.stats = {
      nbArticles: r.articles.length,
      nbArticlesActifs: r.articles.filter((a) => a.actif).length,
      nbArticlesSousSeuil: r.articles.filter((a) => a.sousSeuil).length,
      valeurStock: arrondi(r.articles.filter((a) => a.actif).reduce((s, a) => s + a.valeur, 0)),
      nbEquipements: r.equipements.length,
      nbEquipementsSousGarantie: r.equipements.filter((e) => e.sousGarantie).length,
      nbInterventions: r.interventions.length,
      nbInterventionsOuvertes: r.interventions.filter((o) => !o.final).length,
      coutExterneTotal: arrondi(r.interventions.reduce((s, o) => s + o.coutExterne, 0)),
      coutExterneAnnee: arrondi(r.interventions.filter((o) => String(o.dateReference || '').slice(0, 4) === anneeEnCours).reduce((s, o) => s + o.coutExterne, 0)),
      coutTotalInterventions: arrondi(r.interventions.reduce((s, o) => s + o.coutTotal, 0)),
      totalAchats: r.achats.total,
      totalAchats12Mois: r.achats.total12Mois,
      nbReceptions: r.achats.nbReceptions,
    };
    return r;
  }

  // ----- Filtres de liste -------------------------------------------------------------
  function filtrer(req) {
    const q = req.query || {};
    let rows = db.list(ENTITE);
    if (q.typeCode) {
      if (!ctx.liste(LISTE_TYPES).some((x) => x.code === q.typeCode)) throw new HttpError(400, `Type de fournisseur inconnu : « ${q.typeCode} »`);
      rows = rows.filter((f) => f.typeCode === q.typeCode);
    }
    if (q.actif !== undefined && q.actif !== '' && q.actif !== 'tous') {
      if (vrai(q.actif)) rows = rows.filter((f) => f.actif !== false);
      else if (faux(q.actif)) rows = rows.filter((f) => f.actif === false);
      else throw new HttpError(400, 'Filtre « actif » invalide (1, 0 ou tous)');
    }
    const termes = normaliser(q.recherche || q.q || '').split(' ').filter(Boolean);
    if (termes.length) {
      rows = rows.filter((f) => {
        const t = normaliser([f.nom, f.contact, f.email, f.telephone, f.adresse, f.siteWeb, f.siret, f.notes, libelleType(f.typeCode)]
          .concat((f.contacts || []).flatMap((x) => [x.nom, x.fonction, x.email, x.telephone])).join(' '));
        return termes.every((x) => t.includes(x));
      });
    }
    return rows.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr', { sensitivity: 'base' }));
  }

  // ----- Notifications -----------------------------------------------------------------
  /** Prévient les personnes concernées lorsqu'un fournisseur encore utilisé est désactivé. */
  function notifierDesactivation(req, f) {
    const moi = req && req.user ? req.user.id : null;
    const articlesActifs = db.count('articles', (a) => lie(a, f.id) && a.actif !== false);
    if (articlesActifs) {
      const gestionnaires = ctx.usersAvecDroit('stock', 'modifier').map((u) => u.id).filter((id) => id !== moi);
      ctx.notify(gestionnaires, {
        titre: 'Fournisseur désactivé',
        message: `« ${f.nom} » a été désactivé alors qu'il reste le fournisseur habituel de ${articlesActifs} article(s) actif(s) : pensez à désigner un autre fournisseur.`,
        lien: `#/stock?fournisseurId=${f.id}`, type: 'alerte',
      });
    }
    const parTechnicien = new Map();
    for (const o of db.list('ot', (x) => lie(x, f.id) && !otEstFinal(x))) {
      if (o.technicienId == null || Number(o.technicienId) === moi) continue;
      const k = Number(o.technicienId);
      if (!parTechnicien.has(k)) parTechnicien.set(k, []);
      parTechnicien.get(k).push(o);
    }
    for (const [uid, ots] of parTechnicien) {
      ctx.notify(uid, {
        titre: 'Prestataire désactivé',
        message: ots.length === 1
          ? `Le prestataire « ${f.nom} » de l'ordre de travail ${ots[0].numero || '#' + ots[0].id} a été désactivé.`
          : `Le prestataire « ${f.nom} » de ${ots.length} ordres de travail ouverts (${ots.map((o) => o.numero || '#' + o.id).join(', ')}) a été désactivé.`,
        lien: `#/ot/${ots[0].id}`, type: 'alerte',
      });
    }
  }

  // ----- Routes --------------------------------------------------------------------------
  router.get('/api/fournisseurs', async (req) => {
    const c = contexte(req);
    return filtrer(req).map((f) => resume(f, c));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/fournisseurs-export', async (req, res) => {
    const c = contexte(req);
    const champs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
    const entetes = ['Nom', 'Type', 'Contact principal', 'Téléphone', 'E-mail', 'Adresse', 'Site web', 'SIRET', 'Délai de livraison (jours)',
      'Autres contacts', 'Articles fournis', 'Équipements', 'Interventions externes'].concat(c.acces.achats ? ['Total des achats'] : [], ['Actif', 'Notes'], champs.map((x) => x.label));
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    const rows = filtrer(req);
    for (const f of rows) {
      const r = resume(f, c);
      const autres = r.contacts.map((x) => [x.nom + (x.fonction ? ` (${x.fonction})` : ''), x.telephone, x.email].filter(Boolean).join(' — ')).join(' | ');
      lignes.push([
        r.nom, r.typeLibelle, r.contact, r.telephone, r.email, r.adresse, r.siteWeb, formatSiret(r.siret), r.delaiLivraisonJours == null ? '' : r.delaiLivraisonJours,
        autres, r.nbArticles, r.nbEquipements, r.nbOt,
      ].concat(c.acces.achats ? [String(arrondi(r.totalAchats || 0)).replace('.', ',')] : [], [r.actif ? 'Oui' : 'Non', r.notes],
        champs.map((x) => { const v = (r.champs || {})[x.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); })).map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, null, `${rows.length} fournisseur(s)`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fournisseurs-${dateLocale()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  router.get('/api/fournisseurs/:id', async (req) => detail(req, trouver(req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/fournisseurs', async (req) => {
    const data = valider(req.body, null);
    data.createdBy = req.user.id;
    const f = db.insert(ENTITE, data);
    ctx.audit(req, 'creation', ENTITE, f.id, `Fournisseur ${f.nom} (${libelleType(f.typeCode)})`);
    ctx.emit('fournisseur:cree', { fournisseur: f, userId: req.user.id });
    return detail(req, f);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/fournisseurs/:id', async (req) => {
    const existant = trouver(req.params.id);
    const patch = valider(req.body, existant);
    const comparable = (k, v) => {
      if (k === 'actif') return v !== false;
      if (k === 'contacts') return Array.isArray(v) ? v : [];
      if (k === 'champs') return Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, x]) => x !== null && x !== undefined && x !== ''));
      return v === undefined || v === null || v === '' ? null : v;
    };
    const changes = Object.keys(patch).filter((k) => JSON.stringify(comparable(k, patch[k])) !== JSON.stringify(comparable(k, existant[k])));
    if (!changes.length) return detail(req, existant);
    const f = db.update(ENTITE, existant.id, patch);
    const desactive = existant.actif !== false && f.actif === false;
    const reactive = existant.actif === false && f.actif !== false;
    const autres = changes.filter((k) => k !== 'actif').map((k) => LIBELLES[k] || k);
    if (desactive) {
      ctx.audit(req, 'desactivation', ENTITE, f.id, `Fournisseur ${f.nom}${autres.length ? ' (modifié : ' + autres.join(', ') + ')' : ''}`);
      notifierDesactivation(req, f);
      ctx.emit('fournisseur:desactive', { fournisseur: f, userId: req.user.id });
    } else {
      ctx.audit(req, 'modification', ENTITE, f.id, `Fournisseur ${f.nom}${reactive ? ' réactivé' : ''}${autres.length ? ' : ' + autres.join(', ') : ''}`);
    }
    ctx.emit('fournisseur:modifie', { fournisseur: f, ancien: existant, changes, userId: req.user.id });
    return detail(req, f);
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/fournisseurs/:id', async (req) => {
    const f = trouver(req.params.id);
    const refs = nbReferences(f.id);
    if (refs.total > 0) {
      // Traçabilité : un fournisseur référencé est désactivé, jamais supprimé
      const etaitActif = f.actif !== false;
      const maj = db.update(ENTITE, f.id, { actif: false });
      ctx.audit(req, 'desactivation', ENTITE, f.id, `Fournisseur ${f.nom} (référencé par ${libelleReferences(refs)} : désactivé au lieu d'être supprimé)`);
      if (etaitActif) {
        notifierDesactivation(req, maj);
        ctx.emit('fournisseur:desactive', { fournisseur: maj, userId: req.user.id });
      }
      return { ok: true, desactive: true, references: refs };
    }
    db.remove(ENTITE, f.id);
    ctx.audit(req, 'suppression', ENTITE, f.id, `Fournisseur ${f.nom}`);
    ctx.emit('fournisseur:supprime', { fournisseur: f, userId: req.user.id });
    return { ok: true, desactive: false };
  }, { perm: [MODULE, 'supprimer'] });

  /** Duplique une fiche (nouveau nom ; le SIRET, propre à un établissement, n'est pas recopié). */
  router.post('/api/fournisseurs/:id/dupliquer', async (req) => {
    const source = trouver(req.params.id);
    const body = objet(req.body);
    let nomCopie;
    if (body.nom != null && String(body.nom).trim() !== '') {
      nomCopie = texte(body.nom, 'Nom', { requis: true, max: MAX_NOM }).replace(/\s+/g, ' ');
      const doublon = nomExistant(nomCopie, null);
      if (doublon) throw new HttpError(400, `Un fournisseur nommé « ${doublon.nom} » existe déjà${doublon.actif === false ? ' (désactivé)' : ''}`);
    } else {
      const base = String(source.nom || 'Fournisseur').slice(0, MAX_NOM - 12);
      for (let i = 1; i < 1000 && !nomCopie; i++) { const n = `${base} (copie${i > 1 ? ' ' + i : ''})`; if (!nomExistant(n, null)) nomCopie = n; }
      if (!nomCopie) throw new HttpError(400, 'Impossible de générer un nom de copie : précisez un nom');
    }
    const data = {
      nom: nomCopie, typeCode: source.typeCode || codeType(null), contact: source.contact || '', telephone: source.telephone || '', email: source.email || '',
      adresse: source.adresse || '', siteWeb: source.siteWeb || '', siret: '', notes: source.notes || '',
      delaiLivraisonJours: source.delaiLivraisonJours == null || source.delaiLivraisonJours === '' ? null : Number(source.delaiLivraisonJours),
      actif: true, contacts: JSON.parse(JSON.stringify(Array.isArray(source.contacts) ? source.contacts : [])), champs: JSON.parse(JSON.stringify(source.champs || {})),
      createdBy: req.user.id, dupliqueDe: source.id,
    };
    const f = db.insert(ENTITE, data);
    ctx.audit(req, 'duplication', ENTITE, f.id, `Fournisseur ${f.nom} (copie de « ${source.nom} »)`);
    ctx.emit('fournisseur:cree', { fournisseur: f, source, userId: req.user.id });
    return detail(req, f);
  }, { perm: [MODULE, 'creer'] });

  // ----- Services publiés -----------------------------------------------------------------
  ctx.services.fournisseurs = {
    /** Fiche brute (ou null). */
    get: (id) => db.get(ENTITE, id),
    /** Nom affichable (chaîne vide si inconnu). */
    nom: (id) => { const f = id == null ? null : db.get(ENTITE, id); return f ? f.nom || '' : ''; },
    /** Fournisseurs actifs triés par nom, éventuellement filtrés par type. */
    actifs: (typeCode) => db.list(ENTITE, (f) => f.actif !== false && (!typeCode || f.typeCode === typeCode)).sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr')),
    /** Nombre de références { articles, equipements, ot, mouvements, total }. */
    references: (id) => nbReferences(Number(id)),
    estReference: (id) => nbReferences(Number(id)).total > 0,
    /** Total des achats (Σ entrées × prix unitaire), toutes portées confondues. */
    totalAchats: (id) => arrondi(db.list('mouvementsStock', (m) => m.type === 'entree' && lie(m, Number(id))).reduce((s, m) => s + montantMouvement(m), 0)),
  };
}

// ----- Données de démonstration ------------------------------------------------------------
function seedDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const types = ((cfg.listes || {})[LISTE_TYPES]) || [];
  const type = (voulu) => (!types.length || types.some((x) => x.code === voulu) ? voulu : types.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0))[0].code);
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const existe = (n) => db.findOne(ENTITE, (f) => normaliser(f.nom) === normaliser(n));

  const defs = [
    {
      nom: 'SKF France', typeCode: 'fournisseur', contact: 'Laurent Girard', telephone: '04 65 71 20 14', email: 'laurent.girard@skf-france.example',
      adresse: 'Agence Rhône-Alpes\nZI des Bruyères — 15 rue Denis Papin\n69200 Vénissieux', siteWeb: 'https://www.skf.com/fr', siret: '31258452500127', delaiLivraisonJours: 5,
      notes: 'Roulements, paliers, courroies, transmissions et kits de joints. Remise de 32 % sur le tarif public. Franco de port à partir de 300 € HT. Commandes avant 15 h livrées sous 48 h pour les références stockées en agence.',
      contacts: [
        { nom: 'Laurent Girard', fonction: 'Technico-commercial itinérant', telephone: '06 39 98 12 45', email: 'laurent.girard@skf-france.example' },
        { nom: 'Nadia Benali', fonction: 'Administration des ventes', telephone: '04 65 71 20 10', email: 'adv.lyon@skf-france.example' },
        { nom: 'Service fiabilité SKF', fonction: 'Analyse vibratoire et alignement laser', telephone: '04 65 71 20 30', email: 'fiabilite@skf-france.example' },
      ],
    },
    {
      nom: 'Rexel', typeCode: 'fournisseur', contact: 'Comptoir de Vénissieux', telephone: '04 65 71 33 00', email: 'venissieux@rexel.example',
      adresse: '42 boulevard Ambroise Croizat\n69200 Vénissieux', siteWeb: 'https://www.rexel.fr', siret: '30953617800245', delaiLivraisonJours: 2,
      notes: 'Matériel électrique basse tension : protection, contacteurs, câbles, fusibles, éclairage. Compte client n° 458 221. Retrait comptoir possible dès 7 h ; livraison J+1 pour toute commande passée avant 17 h.',
      contacts: [
        { nom: 'Julien Morel', fonction: 'Attaché commercial industrie', telephone: '06 39 98 44 17', email: 'julien.morel@rexel.example' },
        { nom: 'Comptoir de Vénissieux', fonction: 'Retrait et commandes urgentes', telephone: '04 65 71 33 00', email: 'venissieux@rexel.example' },
      ],
    },
    {
      nom: 'Total Lubrifiants', typeCode: 'fournisseur', contact: 'Sandrine Lefèvre', telephone: '01 99 00 27 40', email: 'sandrine.lefevre@total-lubrifiants.example',
      adresse: 'Service clients industrie\n562 avenue du Parc de l\'Île\n92000 Nanterre', siteWeb: 'https://lubrifiants.totalenergies.fr', siret: '54202856400315', delaiLivraisonJours: 7,
      notes: 'Huiles hydrauliques (Azolla), graisses (Multis), huiles de compresseur et de réducteur. Contrat d\'analyse d\'huiles en service : 12 kits de prélèvement par an. Livraison en fûts de 208 L ou en bidons de 20 L.',
      contacts: [
        { nom: 'Sandrine Lefèvre', fonction: 'Ingénieure lubrification', telephone: '06 39 98 61 02', email: 'sandrine.lefevre@total-lubrifiants.example' },
        { nom: 'Service clients industrie', fonction: 'Commandes et suivi de livraison', telephone: '01 99 00 27 40', email: 'commandes@total-lubrifiants.example' },
      ],
    },
    {
      nom: 'Schneider Electric', typeCode: 'constructeur', contact: 'Support technique industrie', telephone: '01 99 00 51 51', email: 'support.industrie@schneider-electric.example',
      adresse: '35 rue Joseph Monier\n92500 Rueil-Malmaison', siteWeb: 'https://www.se.com/fr', siret: '95450394200457', delaiLivraisonJours: 10,
      notes: 'Constructeur des variateurs Altivar, automates Modicon et appareillage TeSys installés sur les lignes. Les achats courants passent par Rexel ; commandes directes pour les pièces spécifiques et les échanges standard de variateurs.',
      contacts: [
        { nom: 'Thomas Rousseau', fonction: 'Ingénieur d\'affaires', telephone: '06 39 98 73 21', email: 'thomas.rousseau@schneider-electric.example' },
        { nom: 'Support technique industrie', fonction: 'Assistance téléphonique (8 h – 18 h)', telephone: '01 99 00 51 51', email: 'support.industrie@schneider-electric.example' },
      ],
    },
    {
      nom: 'Atlas Copco Service', typeCode: 'prestataire', contact: 'Marc Dubois', telephone: '04 65 71 48 80', email: 'service.lyon@atlascopco.example',
      adresse: 'Centre de service Rhône-Alpes\n7 rue du Progrès\n69800 Saint-Priest', siteWeb: 'https://www.atlascopco.com/fr-fr', siret: '57210084900187', delaiLivraisonJours: 3,
      notes: 'Contrat de maintenance du compresseur GA 37 VSD+ : 2 visites préventives par an (4 000 h / 8 000 h) et dépannage sous 24 h ouvrées. Fourniture des pièces d\'origine (filtres, séparateur, huile Roto-Inject).',
      contacts: [
        { nom: 'Marc Dubois', fonction: 'Responsable du contrat de service', telephone: '06 39 98 25 63', email: 'marc.dubois@atlascopco.example' },
        { nom: 'Kevin Faure', fonction: 'Technicien SAV compresseurs', telephone: '06 39 98 25 70', email: 'kevin.faure@atlascopco.example' },
        { nom: 'Plateforme dépannage', fonction: 'Urgences 24 h/24', telephone: '04 65 71 48 88', email: '' },
      ],
    },
    {
      nom: 'Bureau Veritas', typeCode: 'prestataire', contact: 'Isabelle Garnier', telephone: '04 65 71 62 40', email: 'isabelle.garnier@bureauveritas.example',
      adresse: 'Agence Inspection & Vérification\n17 avenue Jean Mermoz\n69008 Lyon', siteWeb: 'https://www.bureauveritas.fr', siret: '77569060901512', delaiLivraisonJours: 15,
      notes: 'Contrôles réglementaires : vérifications générales périodiques (VGP) des appareils de levage et des chariots, vérification annuelle des installations électriques, requalification des appareils à pression. Rapports transmis sous 15 jours ; les observations sont à lever avant la visite suivante.',
      contacts: [
        { nom: 'Isabelle Garnier', fonction: 'Chargée d\'affaires inspection', telephone: '06 39 98 90 12', email: 'isabelle.garnier@bureauveritas.example' },
        { nom: 'Philippe Chevalier', fonction: 'Inspecteur levage et appareils à pression', telephone: '06 39 98 90 27', email: 'philippe.chevalier@bureauveritas.example' },
        { nom: 'Planification des visites', fonction: 'Prise de rendez-vous', telephone: '04 65 71 62 41', email: 'planification.lyon@bureauveritas.example' },
      ],
    },
    {
      nom: 'Trane France', typeCode: 'constructeur', contact: 'Service après-vente', telephone: '01 99 00 64 20', email: 'sav@trane-france.example',
      adresse: '1 rue des Amériques\n69780 Mions', siteWeb: 'https://www.trane.com/fr', siret: '30681213700058', delaiLivraisonJours: 12,
      notes: 'Constructeur du groupe froid CGAM 120. Contrôle d\'étanchéité annuel du circuit frigorifique (R410A) réalisé par un technicien titulaire de l\'attestation de capacité.',
      contacts: [
        { nom: 'Élodie Marchand', fonction: 'Chargée de clientèle service', telephone: '06 39 98 37 44', email: 'elodie.marchand@trane-france.example' },
      ],
    },
    {
      nom: 'Mettler-Toledo', typeCode: 'prestataire', contact: 'Service métrologie', telephone: '01 99 00 83 10', email: 'metrologie@mettler-toledo.example',
      adresse: '18 avenue de la Pépinière\n78220 Viroflay', siteWeb: 'https://www.mt.com/fr', siret: '33872513500036', delaiLivraisonJours: 20,
      notes: 'Étalonnage annuel des balances du laboratoire qualité (certificat d\'étalonnage raccordé COFRAC) et vérification des poids étalons.',
      contacts: [
        { nom: 'Antoine Perrin', fonction: 'Technicien métrologue', telephone: '06 39 98 52 08', email: 'antoine.perrin@mettler-toledo.example' },
      ],
    },
  ];

  let n = 0;
  for (const d of defs) {
    if (existe(d.nom)) continue;
    db.insert(ENTITE, Object.assign({ actif: true, champs: {}, createdBy: admin ? admin.id : null }, d, { typeCode: type(d.typeCode) }));
    n++;
  }
  return n ? `${n} fournisseur(s) et prestataire(s)` : 'déjà présents';
}

module.exports = { nom, register, seedDemo };
