'use strict';
/**
 * Module Stock & pièces détachées.
 *
 *  - Articles (pièces de rechange, consommables, lubrifiants…) : code automatique, catégorie, unité,
 *    seuil minimum, quantité de réapprovisionnement, emplacement, prix (coût unitaire moyen pondéré),
 *    fournisseur, équipements compatibles, magasin (secteur), champs personnalisés.
 *  - Pièces dédiées (reservee) : utilisables uniquement sur les équipements choisis (equipementIds) et, si
 *    inclureSousEquipements (défaut), sur leurs sous-équipements. La règle est celle de ce module seul
 *    (utilisablePour, equipementsAutorises) : sorties, OT et plans préventifs la reprennent par les services.
 *  - Mouvements de stock : entrée, sortie (éventuellement imputée à un OT, équipement destinataire
 *    enregistré), inventaire (quantité constatée → écart), retour (annulation d'une sortie). Chaque
 *    mouvement enregistre quantiteAvant / quantiteApres. La quantité d'un article ne se modifie QUE par un mouvement.
 *  - Alertes de réapprovisionnement, valorisation, exports CSV.
 *
 * Routes : /api/articles (CRUD + mouvements), /api/mouvements, /api/mouvements/:id/annuler,
 *          /api/stock-alertes, /api/stock-valorisation, /api/stock-references,
 *          /api/articles-export, /api/mouvements-export.
 * Services publiés : ctx.services.stock = { sortir, entrer, annulerSortie, inventorier, utilisablePour,
 *          equipementsAutorises, infosDediee, dediesA, retirerEquipement, … }. Un traitement en
 *          masse (validation d'inventaire, réception de commande) passe { silencieux: true } : le mouvement est
 *          enregistré sans entrée de journal unitaire, l'appelant écrivant sa propre entrée récapitulative.
 * Événement émis : 'stock:sousSeuil' (article) lors du passage sous le seuil minimum ; un article sans seuil
 *          (0) n'est pas suivi. Dans le journal des mouvements, un OT hors de la portée du lecteur est masqué.
 */
const nom = 'Stock & pièces détachées';
const ENTITE = 'articles';
const MVT = 'mouvementsStock';
const MODULE = 'stock';

const TYPES_MOUVEMENT = { entree: 'Entrée', sortie: 'Sortie', inventaire: 'Inventaire', retour: 'Retour' };
const MAX_QUANTITE = 1e9;

// ----- Utilitaires purs -------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arrondi = (n, d = 3) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
const normaliser = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const frNombre = (n) => String(arrondi(n, 3)).replace('.', ',');
const vrai = (v) => v === true || v === 1 || ['1', 'true', 'oui', 'on'].includes(String(v == null ? '' : v).toLowerCase());
const faux = (v) => v === false || v === 0 || ['0', 'false', 'non', 'off'].includes(String(v == null ? '' : v).toLowerCase());
const parDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id);

const { csvEscape } = require('../csv');
const csvNombre = (n) => (n == null || n === '' ? '' : String(arrondi(n, 4)).replace('.', ','));

/** Quantité en dessous (ou au niveau) du seuil minimum. Un article sans seuil (0) n'est pas suivi : jamais en alerte. */
function estSousSeuil(a) { return num(a.seuilMin) > 0 && num(a.quantite) <= num(a.seuilMin); }
/** Quantité à commander = max(quantiteCommande, seuilMin × 2 − quantite). */
function quantiteACommander(a) { return arrondi(Math.max(num(a.quantiteCommande), num(a.seuilMin) * 2 - num(a.quantite), 0)); }
/** Valeur du stock (une quantité négative n'est pas valorisée). */
function valeurArticle(a) { return arrondi(Math.max(0, num(a.quantite)) * num(a.prixUnitaire), 2); }

/** Clé de mois locale « AAAA-MM ». */
function moisDe(d) { const x = new Date(d); return Number.isNaN(x.getTime()) ? '' : `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; }

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const wf = () => ctx.config().workflow || {};

  // ----- Validation des entrées ---------------------------------------------------
  function objet(b) {
    if (b == null || b === '') return {};
    if (typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) throw new HttpError(400, 'Corps de requête invalide (objet JSON attendu)');
    return b;
  }
  function texte(v, label, { requis = false, max = 1000 } = {}) {
    if (v != null && typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${label} : valeur invalide`);
    const s = v == null ? '' : String(v).trim();
    if (requis && !s) throw new HttpError(400, `${label} : champ obligatoire`);
    if (s.length > max) throw new HttpError(400, `${label} : ${max} caractères maximum`);
    return s;
  }
  function nombre(v, label, { requis = false, min = 0, strictPositif = false, max = MAX_QUANTITE, defaut = null } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis) throw new HttpError(400, `${label} : champ obligatoire`);
      return defaut;
    }
    if (typeof v !== 'number' && typeof v !== 'string') throw new HttpError(400, `${label} : nombre attendu`);
    // Chaîne : écriture décimale seulement (virgule acceptée) ; Number() accepterait l'hexadécimal ou l'exposant
    if (typeof v === 'string' && !/^\s*-?\d+(?:[.,]\d+)?\s*$/.test(v)) throw new HttpError(400, `${label} : nombre attendu`);
    const n = typeof v === 'number' ? v : Number(v.replace(',', '.').trim());
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} : nombre attendu`);
    if (strictPositif && !(n > 0)) throw new HttpError(400, `${label} : la valeur doit être supérieure à 0`);
    if (min != null && n < min) throw new HttpError(400, `${label} : la valeur ne peut pas être négative`);
    if (n > max) throw new HttpError(400, `${label} : valeur trop grande`);
    return n;
  }
  /** Identifiant : entier positif, ou chaîne en écriture décimale (booléens, tableaux, hexadécimal et exposant refusés). */
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : NaN);
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function dateFiltre(v, label, finDeJour) {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, `${label} : date invalide (format AAAA-MM-JJ attendu)`);
    const d = new Date(`${v}T${finDeJour ? '23:59:59.999' : '00:00:00'}`);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${label} : date invalide`);
    return d.toISOString();
  }

  // ----- Références -----------------------------------------------------------------
  const uniteCode = (a) => a.uniteCode || '';
  // Libellés des listes de valeurs : cartes code → libellé mémorisées tant que la configuration (copie figée du cœur) ne change pas
  const cacheListes = { config: null, cartes: new Map() };
  function carteListe(liste) {
    const cfg = ctx.config();
    if (cacheListes.config !== cfg) { cacheListes.config = cfg; cacheListes.cartes.clear(); }
    let m = cacheListes.cartes.get(liste);
    if (!m) { m = new Map(ctx.liste(liste).map((x) => [x.code, x.label])); cacheListes.cartes.set(liste, m); }
    return m;
  }
  const libelleListe = (liste, code) => { const m = carteListe(liste); return m.has(code) ? m.get(code) : (code || ''); };
  const statutsOt = () => ctx.liste('statutsOT');
  /** Codes des statuts d'OT finaux (une lecture de la liste par appel, pour filtrer une liste d'OT). */
  function statutsOtFinaux() {
    const s = ctx.services.ot;
    if (s && typeof s.estFinal === 'function') { try { return { has: (code) => !!s.estFinal(code) }; } catch (e) { /* repli */ } }
    return new Set(statutsOt().filter((x) => x.final).map((x) => x.code));
  }
  function otEstFinal(o) {
    const s = ctx.services.ot;
    if (s && typeof s.estFinal === 'function') { try { return !!s.estFinal(o.statut); } catch (e) { /* repli */ } }
    const it = statutsOt().find((x) => x.code === o.statut);
    return !!(it && it.final);
  }
  function equipementVisible(req, e) {
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli */ } }
    return ctx.canSee(req, e);
  }
  /** Visibilité d'un équipement pour un lecteur ; sans lecteur (appel interne), tout est visible. */
  const voitEquipement = (req, e) => !!e && (!req || !req.perms || equipementVisible(req, e));
  /**
   * Lecteur en consultation : pendant une requête d'écriture, les sites accessibles en lecture seule sont exclus de la
   * portée ; la réponse d'un POST / PUT est pourtant calculée comme celle d'un GET (mêmes équipements affichés).
   */
  const enLecture = (req) => (req && req.perms && req.ecriture ? { user: req.user, perms: req.perms, profil: req.profil, query: req.query || {}, params: req.params || {}, ecriture: false } : req);
  /** Droit de gérer la réservation d'une pièce (caractère dédié, équipements autorisés) : Stock › Créer. */
  const peutGererReservation = (req) => !req || !req.perms || !!req.perms.estAdmin || perms.can(req.perms, MODULE, 'creer');

  // ----- Pièces dédiées ---------------------------------------------------------------------
  // Une pièce dédiée (reservee: true) n'est utilisable que sur les équipements choisis (equipementIds) et, si
  // inclureSousEquipements n'est pas faux, sur leurs sous-équipements (descendants par parentId). Cette règle
  // n'existe qu'ici : les autres modules passent par ctx.services.stock.{ utilisablePour, equipementsAutorises }.
  const estDediee = (a) => !!(a && a.reservee === true);
  const avecSousEquipements = (a) => !a || a.inclureSousEquipements !== false;
  /** Équipements lus une seule fois pour un traitement : fiches par identifiant et enfants par parent. */
  function contexteEquipements() {
    const parId = new Map();
    const enfants = new Map();
    for (const e of db.list('equipements')) {
      parId.set(e.id, e);
      if (e.parentId != null && e.parentId !== '') {
        const p = Number(e.parentId);
        if (!enfants.has(p)) enfants.set(p, []);
        enfants.get(p).push(e.id);
      }
    }
    return { parId, enfants };
  }
  function descendantsDe(id, c) {
    const out = []; const vus = new Set([id]); const pile = [id];
    while (pile.length) {
      for (const x of c.enfants.get(pile.pop()) || []) if (!vus.has(x)) { vus.add(x); out.push(x); pile.push(x); }
    }
    return out;
  }
  /** Équipements choisis sur l'article et toujours présents en base. */
  const equipementsChoisis = (a, c) => Array.from(new Set((a.equipementIds || []).map(Number))).filter((id) => c.parId.has(id));
  /**
   * Identifiants des équipements sur lesquels une pièce dédiée est utilisable : équipements choisis, plus leurs
   * sous-équipements si inclureSousEquipements ; null pour une pièce libre (utilisable sur tout équipement).
   */
  function equipementsAutorises(a, c) {
    if (!estDediee(a)) return null;
    c = c || contexteEquipements();
    const ids = new Set(equipementsChoisis(a, c));
    if (avecSousEquipements(a)) for (const id of Array.from(ids)) for (const d of descendantsDe(id, c)) ids.add(d);
    return Array.from(ids);
  }
  /** Un équipement réformé ou désactivé reste autorisé : il est seulement signalé « réformé ». */
  const estReforme = (e) => e.actif === false || /r[ée]form/i.test(`${e.etatCode || ''} ${e.etatCode ? libelleListe('etatsEquipement', e.etatCode) : ''}`);
  const resumeEquipement = (e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || `#${e.id}`, actif: e.actif !== false, etatCode: e.etatCode || null, reforme: estReforme(e) });
  const libelleEquipement = (e) => `${e.nom}${e.numero || e.reforme ? ` (${[e.numero, e.reforme ? 'réformé' : ''].filter(Boolean).join(', ')})` : ''}`;
  const enumeration = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} et ${parts[parts.length - 1]}` : (parts[0] || ''));
  /** « Presse 250 t (EQ-0010), Robot (EQ-0011) et 2 équipement(s) hors de votre périmètre, sous-équipements compris » */
  function texteAutorises(d, sousEquipements) {
    const parts = d.reserveeEquipements.map(libelleEquipement);
    if (d.reserveeHorsPerimetre) parts.push(`${d.reserveeHorsPerimetre} équipement(s) hors de votre périmètre`);
    return `${enumeration(parts) || 'aucun équipement'}${sousEquipements && parts.length ? ', sous-équipements compris' : ''}`;
  }
  /**
   * Caractère dédié d'un article pour un lecteur : équipements choisis visibles (reserveeA : noms ; reserveeEquipements :
   * fiches résumées), nombre d'équipements choisis hors de son périmètre, pièce sans équipement (à réaffecter) et
   * identifiants des équipements visibles sur lesquels elle est utilisable (null pour une pièce libre).
   */
  function infosDediee(a, req, c) {
    if (!estDediee(a)) {
      return { reservee: false, inclureSousEquipements: avecSousEquipements(a), reserveeA: [], reserveeEquipements: [], reserveeHorsPerimetre: 0, reserveeTexte: '', sansEquipement: false, equipementsAutorisesIds: null };
    }
    c = c || contexteEquipements();
    const choisis = equipementsChoisis(a, c);
    const visibles = choisis.map((id) => c.parId.get(id)).filter((e) => voitEquipement(req, e)).map(resumeEquipement)
      .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
    const autorises = equipementsAutorises(a, c);
    const d = {
      reservee: true, inclureSousEquipements: avecSousEquipements(a),
      reserveeA: visibles.map((e) => e.nom), reserveeEquipements: visibles, reserveeHorsPerimetre: choisis.length - visibles.length,
      sansEquipement: !choisis.length,
      equipementsAutorisesIds: autorises.filter((id) => voitEquipement(req, c.parId.get(id))),
    };
    // « sous-équipements compris » n'est mentionné que si des sous-équipements existent réellement
    d.reserveeTexte = d.sansEquipement ? 'aucun équipement : à réaffecter' : texteAutorises(d, autorises.length > choisis.length);
    return d;
  }
  const nomPiece = (a) => `« ${a.code ? a.code + ' — ' : ''}${a.designation || ''} »`;
  /**
   * Règle d'utilisation : { ok, raison }. Une pièce libre est utilisable partout ; une pièce dédiée seulement sur un
   * équipement autorisé (raison citant la pièce et les équipements autorisés visibles par le lecteur `req`).
   */
  function utilisablePour(a, equipementId, req, c) {
    if (!a) return { ok: false, raison: 'Article introuvable' };
    if (!estDediee(a)) return { ok: true, raison: '' };
    c = c || contexteEquipements();
    const d = infosDediee(a, req, c);
    if (d.sansEquipement) return { ok: false, raison: `La pièce ${nomPiece(a)} est dédiée mais n'est plus affectée à aucun équipement : réaffectez-la (fiche de l'article) avant de l'utiliser` };
    const id = equipementId == null || equipementId === '' ? null : Number(equipementId);
    if (id == null) return { ok: false, raison: `La pièce ${nomPiece(a)} est dédiée à ${d.reserveeTexte} : précisez l'équipement sur lequel elle est utilisée` };
    if (equipementsAutorises(a, c).includes(id)) return { ok: true, raison: '' };
    const e = c.parId.get(id);
    const cible = e && voitEquipement(req, e) ? libelleEquipement(resumeEquipement(e)) : 'cet équipement';
    return { ok: false, raison: `La pièce ${nomPiece(a)} est dédiée à ${d.reserveeTexte} : elle ne peut pas être utilisée sur ${cible}` };
  }
  /** Lecteur reconstitué (droits et portée) pour un appel de service qui ne transmet que l'identifiant de l'utilisateur. */
  function lecteurDe(userId) {
    const u = userId != null ? db.get('users', userId) : null;
    if (!u) return null;
    try { return { user: u, perms: perms.effectivePermissions(db, u, null, ctx.config()) }; } catch (e) { return null; }
  }
  /**
   * Équipement destinataire d'une sortie : celui de l'OT s'il en a un, sinon l'équipement indiqué (existant et visible).
   * Un équipement indiqué différent de celui de l'OT est refusé.
   */
  function equipementSortie(ot, equipementId, req) {
    const explicite = idRef(equipementId, 'Équipement destinataire');
    if (explicite != null) {
      const e = db.get('equipements', explicite);
      if (!e || !voitEquipement(req, e)) throw new HttpError(400, 'Équipement destinataire introuvable ou hors de votre périmètre');
    }
    const deLOt = ot && ot.equipementId != null && ot.equipementId !== '' ? Number(ot.equipementId) : null;
    if (deLOt != null && explicite != null && explicite !== deLOt) {
      throw new HttpError(400, `L'équipement indiqué ne correspond pas à celui de l'ordre de travail ${ot.numero || ot.id} : une pièce imputée à un OT est sortie pour l'équipement de l'OT`);
    }
    return deLOt != null ? deLOt : explicite;
  }

  function references(req) {
    return {
      fournisseurs: new Map(db.list('fournisseurs').map((f) => [f.id, f])),
      users: new Map(db.list('users').map((u) => [u.id, `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login])),
      ot: new Map(db.list('ot').map((o) => [o.id, o])),
      articles: new Map(db.list(ENTITE).map((a) => [a.id, a])),
      eq: contexteEquipements(),
      req: req || null,
    };
  }
  function derniersMouvements() {
    const m = new Map();
    for (const x of db.list(MVT)) { const k = Number(x.articleId); if (!m.has(k) || String(x.date) > m.get(k)) m.set(k, String(x.date)); }
    return m;
  }

  /** Représentation enrichie d'un article (liste, détail, alertes). */
  function resume(a, refs, derniers) {
    const f = a.fournisseurId != null ? refs.fournisseurs.get(Number(a.fournisseurId)) : null;
    const sousSeuil = estSousSeuil(a);
    return Object.assign({}, a, infosDediee(a, refs.req, refs.eq), {
      quantite: arrondi(num(a.quantite)), seuilMin: num(a.seuilMin), quantiteCommande: num(a.quantiteCommande), prixUnitaire: num(a.prixUnitaire),
      equipementIds: (a.equipementIds || []).map(Number), secteurId: a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId),
      actif: a.actif !== false, champs: a.champs || {},
      valeur: valeurArticle(a), sousSeuil, rupture: num(a.quantite) <= 0,
      quantiteACommander: sousSeuil ? quantiteACommander(a) : 0,
      fournisseurNom: f ? f.nom || '' : '',
      dernierMouvement: derniers ? derniers.get(a.id) || null : null,
    });
  }

  /** Même règle que le module OT : droit de consultation, portée, ou OT dont le lecteur est créateur ou intervenant. */
  function otVisible(req, o) {
    if (!req || !req.perms) return true; // appel interne (service)
    if (!perms.can(req.perms, 'ot', 'voir')) return false;
    if (ctx.canSee(req, o)) return true;
    const uid = Number(req.user.id);
    return Number(o.createdBy) === uid || Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid));
  }
  const OT_HORS_PORTEE = 'Ordre de travail hors de votre périmètre';
  /** Retire d'un motif le numéro et le titre d'un OT que le lecteur ne peut pas consulter (motif « OT n° — titre » des sorties). */
  function masquerMotif(motif, o) {
    let s = String(motif == null ? '' : motif);
    const re = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numero = String(o.numero == null ? '' : o.numero).trim();
    const titre = String(o.titre == null ? '' : o.titre).trim();
    if (numero) s = s.replace(new RegExp(`(?:OT\\s+)?${re(numero)}(?:\\s+—\\s+${titre ? re(titre) : ''})?`, 'gi'), OT_HORS_PORTEE);
    if (titre.length >= 2) s = s.replace(new RegExp(re(titre), 'gi'), '…');
    return s;
  }

  const EQUIPEMENT_HORS_PORTEE = 'Équipement hors de votre périmètre';
  /**
   * Visibilité de l'équipement destinataire d'un mouvement. Équipement existant : règle du module Équipements.
   * Équipement supprimé : même règle appliquée au secteur qu'il avait à la date du mouvement (equipementSecteurId) ;
   * sans cette information (mouvement antérieur), il n'est montré qu'en portée « tous ».
   */
  function voitEquipementMouvement(req, m, e) {
    if (e) return voitEquipement(req, e);
    if (!req || !req.perms) return true;
    if (m.equipementSecteurId === undefined) return req.perms.portee === 'tous' && !Array.isArray(req.perms.siteFiltre);
    return equipementVisible(req, { id: Number(m.equipementId), secteurId: m.equipementSecteurId });
  }
  function enrichirMouvement(m, refs, req) {
    const a = refs.articles.get(Number(m.articleId));
    const o = m.otId != null ? refs.ot.get(Number(m.otId)) : null;
    const otMasque = !!(o && !otVisible(req, o));
    const f = m.fournisseurId != null ? refs.fournisseurs.get(Number(m.fournisseurId)) : null;
    // Équipement destinataire (traçabilité) : fiche actuelle, libellé conservé si l'équipement a été supprimé
    const e = m.equipementId != null ? refs.eq.parId.get(Number(m.equipementId)) || null : null;
    const eqMasque = m.equipementId != null && !voitEquipementMouvement(req, m, e);
    let equipementNom = '';
    if (m.equipementId != null) equipementNom = eqMasque ? EQUIPEMENT_HORS_PORTEE : (e ? e.nom || '' : `${m.equipementLibelle || 'Équipement'} (supprimé)`);
    return Object.assign({}, m, {
      equipementSecteurId: undefined,
      equipementId: m.equipementId == null || eqMasque ? null : Number(m.equipementId), equipementExiste: !!(e && !eqMasque),
      equipementNumero: e && !eqMasque ? e.numero || '' : '', equipementNom, equipementMasque: eqMasque,
      equipementLibelle: eqMasque ? '' : m.equipementLibelle || '',
      articleCode: a ? a.code || '' : '', articleDesignation: a ? a.designation || '' : '(article supprimé)', uniteCode: a ? uniteCode(a) : '',
      userNom: m.userId != null ? refs.users.get(Number(m.userId)) || '' : '',
      otNumero: o && !otMasque ? o.numero || '' : '', otTitre: otMasque ? OT_HORS_PORTEE : (o ? o.titre || '' : ''), otMasque,
      motif: otMasque ? masquerMotif(m.motif, o) : m.motif,
      fournisseurNom: f ? f.nom || '' : '',
      ecart: m.ecart != null ? m.ecart : arrondi(num(m.quantiteApres) - num(m.quantiteAvant)),
      valeur: arrondi(num(m.quantite) * num(m.prixUnitaire), 2),
      annulable: m.type === 'sortie' && m.annuleParId == null && m.otId == null,
    });
  }

  // ----- Portée -------------------------------------------------------------------------
  /**
   * Un utilisateur limité à ses sites / secteurs ne rattache un article qu'à un secteur qu'il peut modifier (même
   * règle que les équipements : toute portée autre que « tous » ; en portée « perso » sans secteur, seuls les sites
   * accessibles en lecture seule sont refusés). Appliquée à la création et au changement de secteur d'un article.
   */
  function verifierPorteeEcriture(req, secteurId) {
    if (!req || !req.perms || req.perms.estAdmin || req.perms.portee === 'tous' || secteurId == null) return;
    const sid = Number(secteurId);
    const lectureSeule = (req.perms.secteurIdsLecture || []).includes(sid);
    const modifiables = req.perms.secteurIds || [];
    if (req.perms.portee === 'perso' && !modifiables.length) {
      if (lectureSeule) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : impossible d\'y rattacher un article');
      return;
    }
    if (!modifiables.includes(sid)) {
      throw new HttpError(403, lectureSeule ? 'Ce site est accessible en lecture seule pour vous : impossible d\'y rattacher un article' : 'Vous ne pouvez rattacher un article qu\'à l\'un de vos secteurs');
    }
  }
  function articleVisible(req, id) {
    const a = db.get(ENTITE, id);
    if (!a || !ctx.canSee(req, a)) throw new HttpError(404, 'Article introuvable');
    return a;
  }

  function filtrerArticles(req, q) {
    q = q || {};
    let rows = ctx.scope(req, db.list(ENTITE));
    if (q.categorieCode) rows = rows.filter((a) => (q.categorieCode === 'aucune' ? !a.categorieCode : a.categorieCode === q.categorieCode));
    if (q.fournisseurId) {
      if (q.fournisseurId === 'aucun') rows = rows.filter((a) => a.fournisseurId == null || a.fournisseurId === '');
      else { const f = idRef(q.fournisseurId, 'Fournisseur'); rows = rows.filter((a) => Number(a.fournisseurId) === f); }
    }
    // Pièces d'un équipement : pièces libres compatibles et pièces dédiées utilisables sur lui (sous-équipements compris) ;
    // un équipement hors de la portée du lecteur ne permet pas de filtrer (pas de sondage par identifiant)
    if (q.equipementId) {
      const e = idRef(q.equipementId, 'Équipement');
      const c = contexteEquipements();
      if (!voitEquipement(req, c.parId.get(e))) rows = [];
      else rows = rows.filter((a) => (estDediee(a) ? equipementsAutorises(a, c).includes(e) : (a.equipementIds || []).map(Number).includes(e)));
    }
    if (q.secteurId) {
      if (q.secteurId === 'aucun') rows = rows.filter((a) => a.secteurId == null || a.secteurId === '');
      else { const ids = perms.secteursDescendants(db, [idRef(q.secteurId, 'Secteur')]); rows = rows.filter((a) => a.secteurId != null && ids.includes(Number(a.secteurId))); }
    }
    // Pièces dédiées (reservee=1) ou libres (reservee=0)
    if (q.reservee !== undefined && q.reservee !== '' && q.reservee !== 'tous') {
      if (vrai(q.reservee)) rows = rows.filter(estDediee);
      else if (faux(q.reservee)) rows = rows.filter((a) => !estDediee(a));
      else throw new HttpError(400, 'Filtre « pièces dédiées » invalide : 1 (dédiées) ou 0 (libres) attendu');
    }
    if (vrai(q.sousSeuil)) rows = rows.filter((a) => a.actif !== false && estSousSeuil(a));
    if (q.actif !== undefined && q.actif !== '' && q.actif !== 'tous') {
      if (vrai(q.actif)) rows = rows.filter((a) => a.actif !== false);
      else if (faux(q.actif)) rows = rows.filter((a) => a.actif === false);
    }
    const termes = normaliser(q.recherche).split(/\s+/).filter(Boolean);
    if (termes.length) {
      rows = rows.filter((a) => {
        const t = normaliser([a.code, a.designation, a.referenceFournisseur, a.emplacement].join(' '));
        return termes.every((x) => t.includes(x));
      });
    }
    return rows.sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'fr', { numeric: true }) || a.id - b.id);
  }

  function filtrerMouvements(req, q) {
    q = q || {};
    const visibles = new Set(ctx.scope(req, db.list(ENTITE)).map((a) => a.id));
    let rows = db.list(MVT, (m) => visibles.has(Number(m.articleId)));
    if (q.articleId) { const id = idRef(q.articleId, 'Article'); rows = rows.filter((m) => Number(m.articleId) === id); }
    if (q.type) {
      const types = String(q.type).split(',').filter(Boolean);
      for (const t of types) if (!TYPES_MOUVEMENT[t]) throw new HttpError(400, `Type de mouvement inconnu : ${t}`);
      rows = rows.filter((m) => types.includes(m.type));
    }
    if (q.userId) { const id = idRef(q.userId, 'Utilisateur'); rows = rows.filter((m) => Number(m.userId) === id); }
    if (q.equipementId) { const id = idRef(q.equipementId, 'Équipement'); rows = rows.filter((m) => Number(m.equipementId) === id); }
    if (q.otId) {
      if (q.otId === 'aucun') rows = rows.filter((m) => m.otId == null);
      else if (q.otId === 'tous') rows = rows.filter((m) => m.otId != null);
      else { const id = idRef(q.otId, 'Ordre de travail'); rows = rows.filter((m) => Number(m.otId) === id); }
    }
    const du = dateFiltre(q.du, 'Date de début', false);
    const au = dateFiltre(q.au, 'Date de fin', true);
    if (du && au && du > au) throw new HttpError(400, 'La date de début doit précéder la date de fin');
    if (du) rows = rows.filter((m) => String(m.date) >= du);
    if (au) rows = rows.filter((m) => String(m.date) <= au);
    const refs = references(req);
    const termes = normaliser(q.recherche).split(/\s+/).filter(Boolean);
    let out = rows.sort(parDateDesc).map((m) => enrichirMouvement(m, refs, req));
    // Un équipement hors de la portée du lecteur ne permet pas de filtrer (pas de sondage par identifiant)
    if (q.equipementId) out = out.filter((m) => !m.equipementMasque);
    if (termes.length) out = out.filter((m) => { const t = normaliser([m.articleCode, m.articleDesignation, m.motif, m.otNumero, m.userNom, m.fournisseurNom, m.equipementMasque ? '' : m.equipementNom, m.equipementNumero].join(' ')); return termes.every((x) => t.includes(x)); });
    return out;
  }

  // ----- Validation d'un article ------------------------------------------------------
  function codeExiste(code, saufId) {
    const c = normaliser(code);
    return !!db.findOne(ENTITE, (a) => normaliser(a.code) === c && a.id !== saufId);
  }
  function nouveauCode() {
    const gabarit = (ctx.config().numerotation || {}).art || 'ART-{num:4}';
    for (let i = 0; i < 10000; i++) { const c = db.nextNumber('art', gabarit); if (!codeExiste(c)) return c; }
    throw new HttpError(500, 'Impossible de générer un code d\'article unique : vérifiez le gabarit de numérotation');
  }
  function codeListeStrict(liste, code, label, repliPremier) {
    if (code == null || code === '') {
      if (!repliPremier) return null;
      const l = ctx.liste(liste);
      return l.length ? l[0].code : null;
    }
    if (typeof code !== 'string') throw new HttpError(400, `${label} invalide`);
    if (!ctx.liste(liste).some((x) => x.code === code)) throw new HttpError(400, `${label} inconnue : « ${code} »`);
    return code;
  }

  function validerArticle(req, body, existant) {
    const b = objet(body);
    const pris = (k) => (b[k] === undefined && existant ? existant[k] : b[k]);
    const out = {};

    // Code saisi, ou généré à la fin des contrôles (une création refusée ne consomme pas de numéro)
    let codeAGenerer = false;
    if (b.code !== undefined || !existant) {
      const code = texte(b.code, 'Code', { max: 50 });
      if (!code) {
        if (existant) throw new HttpError(400, 'Code : champ obligatoire');
        codeAGenerer = true;
      } else {
        if (/[\u0000-\u001f]/.test(code)) throw new HttpError(400, 'Code : caractères invalides');
        if (codeExiste(code, existant ? existant.id : null)) throw new HttpError(400, `Le code « ${code} » est déjà utilisé par un autre article`);
        out.code = code;
      }
    }
    out.designation = texte(pris('designation'), 'Désignation', { requis: true, max: 200 });
    out.description = texte(pris('description'), 'Description', { max: 5000 });
    const inchange = (k) => existant && (b[k] === undefined || b[k] === existant[k]) && existant[k] != null && existant[k] !== '';
    out.categorieCode = inchange('categorieCode') ? existant.categorieCode : codeListeStrict('categoriesArticles', pris('categorieCode'), 'Catégorie', false);
    out.uniteCode = inchange('uniteCode') ? existant.uniteCode : codeListeStrict('unites', pris('uniteCode'), 'Unité', true);
    out.seuilMin = arrondi(nombre(pris('seuilMin'), 'Seuil minimum', { defaut: 0 }));
    out.quantiteCommande = arrondi(nombre(pris('quantiteCommande'), 'Quantité à commander', { defaut: 0 }));
    out.emplacement = texte(pris('emplacement'), 'Emplacement', { max: 120 });
    out.prixUnitaire = arrondi(nombre(pris('prixUnitaire'), 'Prix unitaire', { defaut: 0, max: 1e8 }), 4);
    out.referenceFournisseur = texte(pris('referenceFournisseur'), 'Référence fournisseur', { max: 120 });

    // Fournisseur
    let fournisseurId = idRef(pris('fournisseurId'), 'Fournisseur');
    if (fournisseurId != null && !db.get('fournisseurs', fournisseurId)) {
      if (existant && Number(existant.fournisseurId) === fournisseurId) fournisseurId = null; // fournisseur supprimé entre-temps
      else throw new HttpError(400, 'Fournisseur introuvable');
    }
    out.fournisseurId = fournisseurId;

    // Pièce dédiée : utilisable uniquement sur les équipements choisis (et leurs sous-équipements si demandé)
    const booleen = (v, label) => {
      if (typeof v !== 'boolean') throw new HttpError(400, `${label} : valeur invalide (vrai ou faux attendu)`);
      return v;
    };
    let reserveeLue; let sousLu;
    if (b.reservee !== undefined && b.reservee !== null) reserveeLue = booleen(b.reservee, 'Pièce dédiée');
    else if (!existant) reserveeLue = false;
    if (b.inclureSousEquipements !== undefined && b.inclureSousEquipements !== null) sousLu = booleen(b.inclureSousEquipements, 'Inclure les sous-équipements');
    else if (!existant) sousLu = true;
    const reservee = reserveeLue !== undefined ? reserveeLue : !!(existant && existant.reservee === true);

    // Équipements compatibles, ou autorisés pour une pièce dédiée. Seuls les ajouts sont contrôlés (équipement existant
    // et modifiable par l'utilisateur) ; un équipement hors de sa portée est conservé ; un équipement d'un site accessible
    // en lecture seule, affiché mais non modifiable, ne peut être ni ajouté ni retiré (refus explicite).
    if (b.equipementIds !== undefined || !existant) {
      const quoi = reservee ? 'Équipements autorisés' : 'Équipements compatibles';
      const unEq = reservee ? 'Équipement autorisé' : 'Équipement compatible';
      const src = b.equipementIds == null ? [] : b.equipementIds;
      if (!Array.isArray(src)) throw new HttpError(400, `${quoi} : liste attendue`);
      if (src.length > 500) throw new HttpError(400, `${quoi} : 500 au maximum`);
      const anciens = existant ? (existant.equipementIds || []).map(Number) : [];
      const lecteur = enLecture(req);
      const nomEq = (e) => `« ${e.nom || '#' + e.id} »${e.numero ? ` (${e.numero})` : ''}`;
      const ids = [];
      for (const v of src) {
        const id = idRef(v, unEq);
        if (id == null || ids.includes(id)) continue;
        const e = db.get('equipements', id);
        if (anciens.includes(id)) { if (e) ids.push(id); continue; } // déjà dans la liste : pas un ajout
        if (!e || !equipementVisible(req, e)) {
          if (e && equipementVisible(lecteur, e)) throw new HttpError(403, `L'équipement ${nomEq(e)} est sur un site accessible en lecture seule pour vous : il ne peut pas être ajouté`);
          throw new HttpError(400, `${unEq} introuvable (#${id})`);
        }
        ids.push(id);
      }
      for (const id of anciens) {
        if (ids.includes(id)) continue;
        const e = db.get('equipements', id);
        if (!e || equipementVisible(req, e)) continue; // supprimé entre-temps, ou retrait demandé par l'utilisateur
        if (equipementVisible(lecteur, e)) throw new HttpError(403, `L'équipement ${nomEq(e)} est sur un site accessible en lecture seule pour vous : il ne peut pas être retiré`);
        ids.push(id); // hors de la portée de l'utilisateur : conservé
      }
      out.equipementIds = ids;
    }
    if (reserveeLue !== undefined) out.reservee = reserveeLue;
    if (sousLu !== undefined) out.inclureSousEquipements = sousLu;
    if (reservee && (!existant || b.reservee !== undefined || b.equipementIds !== undefined)) {
      const liste = out.equipementIds !== undefined ? out.equipementIds : ((existant && existant.equipementIds) || []).map(Number);
      if (!liste.some((id) => db.get('equipements', id))) throw new HttpError(400, 'Pièce dédiée : choisissez au moins un équipement autorisé');
    }
    // Réservation d'une pièce (caractère dédié, équipements autorisés, sous-équipements) : droit Stock › Créer, le droit
    // Stock › Modifier servant aussi aux sorties ; refusée tant que des équipements autorisés échappent à l'utilisateur,
    // qui ne peut pas juger de l'effet du changement sur des machines qu'il ne voit pas
    if (existant && req && req.perms) {
      const avant = estDediee(existant);
      // Équipements encore présents en base (un identifiant d'équipement supprimé n'est pas un changement de réservation)
      const presents = (l) => l.filter((id) => db.get('equipements', id));
      const listeAvant = presents((existant.equipementIds || []).map(Number));
      const listeApres = out.equipementIds !== undefined ? presents(out.equipementIds) : listeAvant;
      const sousApres = out.inclureSousEquipements !== undefined ? out.inclureSousEquipements : avecSousEquipements(existant);
      const memeListe = listeAvant.length === listeApres.length && listeAvant.every((id) => listeApres.includes(id));
      const change = avant !== reservee || ((avant || reservee) && (!memeListe || sousApres !== avecSousEquipements(existant)));
      if (change) {
        if (!peutGererReservation(req)) throw new HttpError(403, 'Droit insuffisant : le caractère dédié d\'une pièce et ses équipements autorisés se modifient avec le droit Stock › Créer');
        const hors = avant ? infosDediee(existant, enLecture(req)).reserveeHorsPerimetre : 0;
        if (hors) throw new HttpError(403, `Cette pièce est aussi dédiée à ${hors} équipement(s) hors de votre périmètre (ou du site affiché) : sa réservation ne peut être modifiée que par un utilisateur qui voit tous ses équipements autorisés`);
      }
    }

    // Magasin / secteur
    let secteurId = idRef(pris('secteurId'), 'Secteur');
    if (secteurId != null && !db.get('secteurs', secteurId) && existant && Number(existant.secteurId) === secteurId) secteurId = null; // secteur supprimé
    if (secteurId != null) {
      if (!db.get('secteurs', secteurId)) throw new HttpError(400, 'Secteur introuvable');
      const change = !existant || Number(existant.secteurId) !== secteurId;
      if (change) verifierPorteeEcriture(req, secteurId);
    }
    out.secteurId = secteurId;

    // Statut
    if (b.actif !== undefined) out.actif = !!b.actif;
    else if (!existant) out.actif = true;

    // Champs personnalisés
    if (b.champs !== undefined || !existant) {
      if (b.champs != null && (typeof b.champs !== 'object' || Array.isArray(b.champs))) throw new HttpError(400, 'Champs personnalisés invalides');
      out.champs = ctx.champsPerso(ENTITE, b.champs || (existant && existant.champs) || {});
    }
    if (codeAGenerer) out.code = nouveauCode();
    return out;
  }

  // ----- Mouvements : cœur métier (synchrone, donc atomique) --------------------------
  function pseudoReq(userId) {
    const u = userId != null ? db.get('users', userId) : null;
    return u ? { user: u } : null;
  }

  function notifierSousSeuil(article) {
    ctx.emit('stock:sousSeuil', article);
    try {
      const destinataires = ctx.usersAvecDroit(MODULE, 'modifier', (u, p) => perms.canSeeRecord(p, u, article)).map((u) => u.id);
      if (destinataires.length) {
        const u = uniteCode(article);
        ctx.notify(destinataires, {
          titre: 'Stock sous le seuil minimum',
          message: `${article.code ? article.code + ' — ' : ''}${article.designation} : ${frNombre(article.quantite)} ${u} en stock (seuil ${frNombre(article.seuilMin)}). Quantité à commander : ${frNombre(quantiteACommander(article))} ${u}.`.replace(/\s+\./g, '.'),
          lien: `#/stock/${article.id}`,
          type: 'alerte',
        });
      }
    } catch (e) { ctx.log('Stock : notification de seuil impossible', e.message); }
  }

  /**
   * Enregistre un mouvement et met à jour la quantité de l'article.
   * @returns {{ mouvement, article }}
   */
  function enregistrer({ articleId, type, quantite, motif, prixUnitaire, prixMouvement, fournisseurId, otId, userId, req, origineId, refuserInactif, silencieux, equipementId, controleDedie, libelleEquipementOrigine, secteurEquipementOrigine }) {
    if (!TYPES_MOUVEMENT[type]) throw new HttpError(400, 'Type de mouvement invalide');
    const article = db.get(ENTITE, articleId);
    if (!article) throw new HttpError(404, 'Article introuvable');
    if (refuserInactif && article.actif === false) throw new HttpError(400, `L'article « ${article.designation} » est désactivé : réactivez-le avant d'enregistrer une ${type === 'entree' ? 'entrée' : 'sortie'}`);
    // Équipement destinataire (sortie, et retour d'une sortie) ; une sortie d'une pièce dédiée suit la règle d'utilisation.
    // Les entrées, inventaires et retours ne sont jamais restreints.
    const eqMvt = (type === 'sortie' || type === 'retour') && equipementId != null && equipementId !== '' ? Number(equipementId) : null;
    let eqFiche = null;
    if (eqMvt != null) eqFiche = db.get('equipements', eqMvt);
    if (type === 'sortie' && controleDedie && estDediee(article)) {
      const u = utilisablePour(article, eqMvt, req && req.perms ? req : lecteurDe(userId));
      if (!u.ok) throw new HttpError(400, u.raison);
    }
    const q = arrondi(nombre(quantite, type === 'inventaire' ? 'Quantité constatée' : 'Quantité', { requis: true, strictPositif: type !== 'inventaire' }));
    if (type !== 'inventaire' && !(q > 0)) throw new HttpError(400, 'Quantité : la valeur doit être supérieure à 0 (après arrondi à 0,001)');
    // Toutes les validations AVANT la moindre écriture
    const motifTexte = texte(motif, 'Motif', { max: 500 });
    const prixEntree = type === 'entree' && prixUnitaire != null && prixUnitaire !== '' ? nombre(prixUnitaire, 'Prix unitaire', { max: 1e8 }) : null;
    // Un retour en stock revient à la valeur de sa sortie : il pèse dans le coût moyen comme une entrée à ce prix
    const prixValorise = prixEntree != null ? prixEntree : (type === 'retour' && prixMouvement != null ? num(prixMouvement) : null);
    const avant = arrondi(num(article.quantite));
    const unite = uniteCode(article);
    let apres;
    if (type === 'entree' || type === 'retour') apres = arrondi(avant + q);
    else if (type === 'sortie') {
      if (q > avant && !wf().stockNegatif) {
        throw new HttpError(400, `Stock insuffisant pour « ${article.designation} » : ${frNombre(Math.max(avant, 0))} ${unite} disponible(s), ${frNombre(q)} ${unite} demandé(s)`.replace(/\s+/g, ' '));
      }
      apres = arrondi(avant - q);
    } else apres = q;

    const maintenant = new Date().toISOString();
    const patch = { quantite: apres };
    let pu = prixMouvement != null ? num(prixMouvement) : num(article.prixUnitaire);
    if (prixValorise != null) {
      // Coût unitaire moyen pondéré (CUMP)
      const base = Math.max(0, avant);
      patch.prixUnitaire = base + q > 0 ? arrondi((base * num(article.prixUnitaire) + q * prixValorise) / (base + q), 4) : prixValorise;
      pu = prixValorise;
    }
    if (type === 'inventaire') patch.dateDernierInventaire = maintenant;
    const maj = db.update(ENTITE, article.id, patch);
    const mouvement = db.insert(MVT, {
      articleId: article.id, type, quantite: q, quantiteAvant: avant, quantiteApres: apres, ecart: arrondi(apres - avant),
      date: maintenant, userId: userId == null ? null : Number(userId), otId: otId == null ? null : Number(otId),
      motif: motifTexte, prixUnitaire: arrondi(pu, 4), fournisseurId: fournisseurId == null ? null : Number(fournisseurId),
      equipementId: eqMvt, equipementLibelle: eqFiche ? `${eqFiche.numero ? eqFiche.numero + ' — ' : ''}${eqFiche.nom || ''}` : (eqMvt != null ? libelleEquipementOrigine || '' : ''),
      // Secteur de l'équipement à la date du mouvement : sa visibilité reste évaluable s'il est supprimé ensuite
      ...(eqMvt != null ? { equipementSecteurId: eqFiche ? (eqFiche.secteurId == null || eqFiche.secteurId === '' ? null : Number(eqFiche.secteurId)) : (secteurEquipementOrigine === undefined ? undefined : secteurEquipementOrigine) } : {}),
      mouvementOrigineId: origineId == null ? null : origineId, annuleParId: null,
      createdBy: userId == null ? null : Number(userId),
    });

    const ecartTxt = `${apres - avant >= 0 ? '+' : ''}${frNombre(apres - avant)}`;
    const quoi = {
      entree: `entrée de ${frNombre(q)} ${unite}`, sortie: `sortie de ${frNombre(q)} ${unite}`, retour: `retour en stock de ${frNombre(q)} ${unite}`,
      inventaire: `inventaire, quantité constatée ${frNombre(q)} ${unite} (écart ${ecartTxt})`,
    }[type].replace(/\s+/g, ' ').trim();
    const pour = type === 'sortie' && eqFiche ? ` pour ${eqFiche.numero ? eqFiche.numero + ' ' : ''}${eqFiche.nom || ''}` : '';
    if (!silencieux) ctx.audit(req || pseudoReq(userId), 'mouvement', ENTITE, article.id, `${article.code || '#' + article.id} ${article.designation} : ${quoi}${pour} — stock ${frNombre(avant)} → ${frNombre(apres)}${motifTexte ? ' — ' + motifTexte : ''}`);

    // Passage sous le seuil (article suivi, seuil > 0) : quantiteAvant > seuil ≥ quantiteApres
    const seuil = num(maj.seuilMin);
    if (maj.actif !== false && seuil > 0 && avant > seuil && seuil >= apres) notifierSousSeuil(maj);
    return { mouvement, article: maj };
  }

  function annulerSortie(mouvementId, userId, req) {
    const m = db.get(MVT, mouvementId);
    if (!m) throw new HttpError(404, 'Mouvement de stock introuvable');
    if (m.type !== 'sortie') throw new HttpError(400, 'Seule une sortie de stock peut être annulée');
    if (m.annuleParId != null) throw new HttpError(400, 'Cette sortie a déjà été annulée (retour en stock déjà enregistré)');
    if (!db.get(ENTITE, m.articleId)) throw new HttpError(404, 'Article introuvable');
    const dateSortie = new Date(m.date);
    // Le retour se fait au prix de la sortie
    const r = enregistrer({
      articleId: Number(m.articleId), type: 'retour', quantite: m.quantite, userId, req, otId: m.otId, origineId: m.id, prixMouvement: num(m.prixUnitaire), equipementId: m.equipementId, libelleEquipementOrigine: m.equipementLibelle, secteurEquipementOrigine: m.equipementSecteurId,
      motif: `Annulation de la sortie du ${Number.isNaN(dateSortie.getTime()) ? '?' : dateSortie.toLocaleDateString('fr-FR')}${m.motif ? ' (' + String(m.motif).slice(0, 300) + ')' : ''}`,
    });
    db.update(MVT, m.id, { annuleParId: r.mouvement.id });
    return { mouvement: r.mouvement, article: r.article };
  }

  /** Ajoute la pièce à l'OT (même structure que le module OT) et recalcule ses coûts. */
  function imputerOt(o, mouvement, article, req) {
    const courant = db.get('ot', o.id);
    if (!courant) return;
    const piece = { articleId: article.id, code: article.code || '', designation: article.designation || '', uniteCode: article.uniteCode || null, quantite: mouvement.quantite, prixUnitaire: num(mouvement.prixUnitaire), mouvementId: mouvement.id, date: mouvement.date, userId: req.user.id };
    const pieces = (courant.pieces || []).concat([piece]);
    const patch = { pieces };
    const s = ctx.services.ot;
    if (s && typeof s.calculerCouts === 'function') {
      const c = s.calculerCouts(Object.assign({}, courant, { pieces }));
      Object.assign(patch, { coutPieces: c.coutPieces, coutMainOeuvre: c.coutMainOeuvre, coutTotal: c.coutTotal });
    } else {
      const coutPieces = arrondi(pieces.reduce((t, p) => t + num(p.quantite) * num(p.prixUnitaire), 0), 2);
      Object.assign(patch, { coutPieces, coutTotal: arrondi(coutPieces + num(courant.coutMainOeuvre) + num(courant.coutExterne), 2) });
    }
    db.update('ot', o.id, patch);
    ctx.audit(req, 'pieces', 'ot', o.id, `OT ${o.numero || o.id} : sortie de ${frNombre(mouvement.quantite)} × ${article.code ? article.code + ' ' : ''}${article.designation} (depuis le stock)`);
  }

  // ----- Détail d'un article --------------------------------------------------------------
  function statistiques(mouvements, article) {
    const maintenant = new Date();
    const il90 = new Date(maintenant.getTime() - 90 * 86400000).toISOString();
    const mois = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(maintenant.getFullYear(), maintenant.getMonth() - i, 1); mois.push(moisDe(d)); }
    const conso = new Map(mois.map((m) => [m, 0]));
    let conso90 = 0; let entrees90 = 0; let dernierInventaire = null;
    for (const m of mouvements) {
      const signe = m.type === 'sortie' ? 1 : (m.type === 'retour' ? -1 : 0);
      if (signe) {
        const k = moisDe(m.date);
        if (conso.has(k)) conso.set(k, arrondi(conso.get(k) + signe * num(m.quantite)));
        if (String(m.date) >= il90) conso90 = arrondi(conso90 + signe * num(m.quantite));
      }
      if (m.type === 'entree' && String(m.date) >= il90) entrees90 = arrondi(entrees90 + num(m.quantite));
      if (m.type === 'inventaire' && (!dernierInventaire || String(m.date) > dernierInventaire)) dernierInventaire = m.date;
    }
    const parJour = conso90 > 0 ? conso90 / 90 : 0;
    return {
      consommation90j: Math.max(0, conso90), entrees90j: entrees90,
      consommationMensuelle: mois.map((m) => ({ mois: m, quantite: Math.max(0, conso.get(m)) })),
      couvertureJours: parJour > 0 ? Math.max(0, Math.floor(num(article.quantite) / parJour)) : null,
      dernierInventaire,
    };
  }

  function detail(req, a) {
    const refs = references(req);
    const tous = db.list(MVT, (m) => Number(m.articleId) === a.id).sort(parDateDesc);
    const r = resume(a, refs, new Map([[a.id, tous.length ? tous[0].date : null]]));
    r.nbMouvements = tous.length;
    r.mouvements = tous.slice(0, 50).map((m) => enrichirMouvement(m, refs, req));
    const f = a.fournisseurId != null ? db.get('fournisseurs', a.fournisseurId) : null;
    r.fournisseur = f ? { id: f.id, nom: f.nom || '', contact: f.contact || '', telephone: f.telephone || '', email: f.email || '', siteWeb: f.siteWeb || '', delaiLivraisonJours: f.delaiLivraisonJours == null ? null : f.delaiLivraisonJours, actif: f.actif !== false } : null;

    // Ordres de travail ayant consommé l'article (sorties − retours)
    const parOt = new Map();
    for (const m of tous.slice().reverse()) {
      if (m.otId == null || (m.type !== 'sortie' && m.type !== 'retour')) continue;
      const k = Number(m.otId);
      const x = parOt.get(k) || { otId: k, quantite: 0, valeur: 0, nbMouvements: 0, premiereDate: m.date, derniereDate: m.date };
      const s = m.type === 'sortie' ? 1 : -1;
      x.quantite = arrondi(x.quantite + s * num(m.quantite));
      x.valeur = arrondi(x.valeur + s * num(m.quantite) * num(m.prixUnitaire), 2);
      x.nbMouvements++; x.derniereDate = m.date;
      parOt.set(k, x);
    }
    const equipements = refs.eq.parId;
    r.ots = Array.from(parOt.values()).map((x) => {
      const o = refs.ot.get(x.otId);
      if (o && !ctx.canSee(req, o)) return null;
      const e = o && o.equipementId != null ? equipements.get(Number(o.equipementId)) : null;
      return Object.assign(x, {
        existe: !!o, numero: o ? o.numero || '' : '', titre: o ? o.titre || '' : '(ordre de travail supprimé)', statut: o ? o.statut : null,
        typeCode: o ? o.typeCode || null : null, equipementId: e ? e.id : null, equipementNom: e ? e.nom || '' : '', technicienId: o ? o.technicienId || null : null,
      });
    }).filter(Boolean).sort((p, q) => String(q.derniereDate).localeCompare(String(p.derniereDate)));

    // Équipements compatibles, ou autorisés pour une pièce dédiée (selon la portée)
    const ficheEq = (e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || '', secteurId: e.secteurId == null ? null : e.secteurId, typeCode: e.typeCode || null, etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null, localisation: e.localisation || '', actif: e.actif !== false, reforme: estReforme(e), parentId: e.parentId == null ? null : Number(e.parentId) });
    r.equipements = (a.equipementIds || []).map((id) => equipements.get(Number(id))).filter((e) => e && equipementVisible(req, e))
      .map(ficheEq)
      .sort((p, q) => p.nom.localeCompare(q.nom, 'fr'));
    // Sous-équipements autorisés par héritage (pièce dédiée, sous-équipements inclus), avec l'équipement choisi d'origine
    r.sousEquipementsAutorises = [];
    if (estDediee(a) && avecSousEquipements(a)) {
      const choisis = new Set(equipementsChoisis(a, refs.eq));
      const vus = new Set();
      for (const id of choisis) {
        for (const d of descendantsDe(id, refs.eq)) {
          const e = equipements.get(d);
          if (choisis.has(d) || vus.has(d) || !equipementVisible(req, e)) continue;
          vus.add(d);
          const origine = equipements.get(id);
          const origineVisible = !!(origine && equipementVisible(req, origine));
          r.sousEquipementsAutorises.push(Object.assign(ficheEq(e), { viaId: origineVisible ? id : null, viaNom: origineVisible ? origine.nom || '' : '' }));
        }
      }
      r.sousEquipementsAutorises.sort((p, q) => p.nom.localeCompare(q.nom, 'fr'));
    }
    r.stats = statistiques(tous, a);
    r.stockNegatifAutorise = !!wf().stockNegatif;
    return r;
  }

  // ----- Journal : caractère dédié et équipements -----------------------------------------------
  const LIBELLES_CHAMPS = {
    code: 'code', designation: 'désignation', description: 'description', categorieCode: 'catégorie', uniteCode: 'unité', seuilMin: 'seuil minimum',
    quantiteCommande: 'quantité de réapprovisionnement', emplacement: 'emplacement', prixUnitaire: 'prix unitaire', referenceFournisseur: 'référence fournisseur',
    fournisseurId: 'fournisseur', equipementIds: 'équipements', reservee: 'pièce dédiée', inclureSousEquipements: 'sous-équipements', secteurId: 'magasin / secteur',
    actif: 'statut', champs: 'champs personnalisés',
  };
  /** Libellé d'un équipement pour le journal d'activité (numéro et nom). */
  const equipementJournal = (id, c) => { const e = c.parId.get(Number(id)); return e ? `${e.numero ? e.numero + ' ' : ''}${e.nom || ''}`.trim() : `équipement #${id}`; };
  /** « pièce dédiée à EQ-0005 Remplisseuse rotative, sous-équipements compris » (vide pour une pièce libre). */
  function journalDedie(a, c) {
    if (!estDediee(a)) return '';
    const ids = equipementsChoisis(a, c);
    return `pièce dédiée à ${ids.length ? ids.map((id) => equipementJournal(id, c)).join(', ') : 'aucun équipement'}${avecSousEquipements(a) ? ', sous-équipements compris' : ', sans les sous-équipements'}`;
  }
  /** Changements du caractère dédié et de la liste d'équipements, en clair (vide si rien ne change). */
  function journalChangementsDedie(avant, apres, c) {
    const parts = [];
    const dAvant = estDediee(avant); const dApres = estDediee(apres);
    if (dAvant !== dApres) parts.push(dApres ? 'devient une pièce dédiée' : 'n\'est plus une pièce dédiée (pièce libre)');
    const ancienne = (avant.equipementIds || []).map(Number); const nouvelle = (apres.equipementIds || []).map(Number);
    const ajoutes = nouvelle.filter((id) => !ancienne.includes(id)); const retires = ancienne.filter((id) => !nouvelle.includes(id));
    const quoi = dApres ? 'équipements autorisés' : 'équipements compatibles';
    if (ajoutes.length) parts.push(`${quoi} ajoutés : ${ajoutes.map((id) => equipementJournal(id, c)).join(', ')}`);
    if (retires.length) parts.push(`${quoi} retirés : ${retires.map((id) => equipementJournal(id, c)).join(', ')}`);
    const sousChange = dApres && avecSousEquipements(avant) !== avecSousEquipements(apres);
    if (sousChange) parts.push(avecSousEquipements(apres) ? 'sous-équipements désormais inclus' : 'sous-équipements désormais exclus');
    if (dApres && (dAvant !== dApres || ajoutes.length || retires.length || sousChange)) parts.push(journalDedie(apres, c));
    return parts.join(' ; ');
  }

  /**
   * Plans préventifs actifs qui prévoient l'article alors qu'il n'est pas utilisable sur leur équipement (règle des
   * pièces dédiées). Leurs OT ne reprennent pas la pièce ; ils sont signalés pour être corrigés.
   */
  function plansNonConformes(a, c) {
    c = c || contexteEquipements();
    return db.list('plansPreventifs', (p) => p.actif !== false && (p.pieces || []).some((x) => x && Number(x.articleId) === a.id))
      .filter((p) => !utilisablePour(a, p.equipementId, null, c).ok)
      .sort((x, y) => String(x.numero || '').localeCompare(String(y.numero || ''), 'fr', { numeric: true }));
  }
  /** Pièce qui cesse d'être dédiée : les gestionnaires du stock (Stock › Créer) qui la voient sont prévenus. */
  function notifierReservationLevee(a, req) {
    try {
      const auteur = req && req.user ? req.user.id : null;
      const destinataires = ctx.usersAvecDroit(MODULE, 'creer', (u, p) => u.id !== auteur && perms.canSeeRecord(p, u, a)).map((u) => u.id);
      if (!destinataires.length) return;
      ctx.notify(destinataires, {
        titre: 'Pièce dédiée devenue libre',
        message: `${a.code ? a.code + ' — ' : ''}${a.designation} n'est plus une pièce dédiée${auteur != null ? ` (modification par ${ctx.nomUser(auteur)})` : ''} : elle peut désormais être sortie pour tout équipement.`,
        lien: `#/stock/${a.id}`, type: 'alerte',
      });
    } catch (e) { ctx.log('Stock : notification de réservation levée impossible', e.message); }
  }

  // ----- Routes : articles ---------------------------------------------------------------
  router.get('/api/articles', async (req) => {
    const refs = references(req);
    const derniers = derniersMouvements();
    return filtrerArticles(req, req.query).map((a) => resume(a, refs, derniers));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/articles-export', async (req, res) => {
    const refs = references(req);
    const champs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
    const entetes = ['Code', 'Désignation', 'Catégorie', 'Unité', 'Quantité', 'Seuil minimum', 'Sous le seuil', 'Quantité à commander', 'Emplacement', 'Prix unitaire', 'Valeur', 'Fournisseur', 'Référence fournisseur', 'Magasin / secteur', 'Dédiée', 'Équipements', 'Actif', 'Description'].concat(champs.map((c) => c.label));
    // Équipements autorisés (pièce dédiée) ou compatibles, limités à ceux que le lecteur peut voir
    const equipementsCsv = (r) => {
      if (r.reservee) return r.sansEquipement ? 'Aucun : à réaffecter' : r.reserveeTexte;
      const ids = equipementsChoisis(r, refs.eq);
      const visibles = ids.map((id) => refs.eq.parId.get(id)).filter((e) => voitEquipement(req, e)).map(resumeEquipement).sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
      const parts = visibles.map(libelleEquipement);
      if (ids.length > visibles.length) parts.push(`${ids.length - visibles.length} équipement(s) hors de votre périmètre`);
      return enumeration(parts);
    };
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    const rows = filtrerArticles(req, req.query);
    for (const a of rows) {
      const r = resume(a, refs);
      const s = r.secteurId != null ? db.get('secteurs', r.secteurId) : null;
      lignes.push([
        r.code, r.designation, libelleListe('categoriesArticles', r.categorieCode), libelleListe('unites', r.uniteCode), csvNombre(r.quantite), csvNombre(r.seuilMin),
        r.actif && r.sousSeuil ? 'Oui' : 'Non', csvNombre(r.sousSeuil ? r.quantiteACommander : 0), r.emplacement, csvNombre(r.prixUnitaire), csvNombre(r.valeur), r.fournisseurNom, r.referenceFournisseur,
        s ? s.nom : '', r.reservee ? 'Oui' : 'Non', equipementsCsv(r), r.actif ? 'Oui' : 'Non', r.description,
      ].concat(champs.map((c) => { const v = (r.champs || {})[c.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); })).map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, null, `${rows.length} article(s)`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="articles-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  router.get('/api/articles/:id', async (req) => detail(req, articleVisible(req, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/articles', async (req) => {
    const b = objet(req.body);
    const quantiteInitiale = arrondi(nombre(b.quantite, 'Quantité initiale', { defaut: 0 }));
    const data = validerArticle(req, b, null);
    data.quantite = 0;
    data.createdBy = req.user.id;
    let a = db.insert(ENTITE, data);
    const dediee = journalDedie(a, contexteEquipements());
    ctx.audit(req, 'creation', ENTITE, a.id, `Article ${a.code} — ${a.designation}${dediee ? ' — ' + dediee : ''}`);
    if (quantiteInitiale > 0) {
      const r = enregistrer({ articleId: a.id, type: 'inventaire', quantite: quantiteInitiale, userId: req.user.id, req, motif: 'Stock initial à la création de l\'article' });
      a = r.article;
    }
    return detail(enLecture(req), a);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/articles/:id', async (req) => {
    const existant = articleVisible(req, req.params.id);
    const b = objet(req.body);
    if (b.quantite !== undefined && b.quantite !== null && b.quantite !== '' && arrondi(num(b.quantite)) !== arrondi(num(existant.quantite))) {
      throw new HttpError(400, 'La quantité en stock ne se modifie pas directement : enregistrez un mouvement (entrée, sortie ou inventaire)');
    }
    const data = validerArticle(req, b, existant);
    // Comparaison avec les valeurs effectives : un article antérieur aux pièces dédiées n'a ni reservee (faux) ni
    // inclureSousEquipements (vrai) ; un nombre absent vaut 0, un statut absent « actif », un champ vide un champ absent
    const NUMERIQUES = ['seuilMin', 'quantiteCommande', 'prixUnitaire'];
    const effectif = (k, v) => {
      if (k === 'reservee') return v === true;
      if (k === 'inclureSousEquipements' || k === 'actif') return v !== false;
      if (NUMERIQUES.includes(k)) return num(v);
      return v === undefined ? null : v;
    };
    const vide = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    const changes = Object.keys(data).filter((k) => {
      const x = effectif(k, data[k]); const y = effectif(k, existant[k]);
      return !(vide(x) && vide(y)) && JSON.stringify(x) !== JSON.stringify(y);
    });
    const a = db.update(ENTITE, existant.id, data);
    let action = 'modification';
    if (changes.length === 1 && changes[0] === 'actif') action = a.actif === false ? 'desactivation' : 'reactivation';
    const c = contexteEquipements();
    const dediee = journalChangementsDedie(existant, a, c);
    // Réservation modifiée : plans préventifs actifs qui prévoient désormais la pièce sur un équipement non autorisé
    const reservationModifiee = ['reservee', 'inclureSousEquipements', 'equipementIds'].some((k) => changes.includes(k));
    const nonConformes = reservationModifiee ? plansNonConformes(a, c) : [];
    const plansTxt = nonConformes.length ? ` ; ${nonConformes.length} plan(s) préventif(s) actif(s) prévoient désormais cette pièce sur un équipement non autorisé (${nonConformes.map((p) => p.numero || '#' + p.id).join(', ')}) : elle ne sera pas reprise sur leurs prochains OT` : '';
    ctx.audit(req, action, ENTITE, a.id, `Article ${a.code} — ${a.designation}${changes.length ? ' (' + changes.map((k) => LIBELLES_CHAMPS[k] || k).join(', ') + ')' : ''}${dediee ? ' — ' + dediee : ''}${plansTxt}`);
    if (estDediee(existant) && !estDediee(a)) notifierReservationLevee(a, req);
    const lecteur = enLecture(req);
    const voitPlans = perms.can(req.perms, 'preventif', 'voir');
    const plansVisibles = voitPlans ? nonConformes.filter((p) => ctx.canSee(lecteur, p)) : [];
    return Object.assign(detail(lecteur, a), {
      plansNonConformes: plansVisibles.map((p) => ({ id: p.id, numero: p.numero || '', nom: p.nom || '' })),
      plansNonConformesHorsPerimetre: nonConformes.length - plansVisibles.length,
    });
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/articles/:id', async (req) => {
    const a = articleVisible(req, req.params.id);
    const nbMvt = db.count(MVT, (m) => Number(m.articleId) === a.id);
    const dansOt = db.count('ot', (o) => (o.pieces || []).concat(o.piecesPrevues || []).some((p) => p && Number(p.articleId) === a.id));
    const dansPlans = db.count('plansPreventifs', (p) => (p.pieces || []).some((x) => x && Number(x.articleId) === a.id));
    if (nbMvt || dansOt || dansPlans) {
      db.update(ENTITE, a.id, { actif: false });
      const raisons = [nbMvt ? `${nbMvt} mouvement(s)` : null, dansOt ? `${dansOt} OT` : null, dansPlans ? `${dansPlans} plan(s) préventif(s)` : null].filter(Boolean).join(', ');
      ctx.audit(req, 'desactivation', ENTITE, a.id, `Article ${a.code} — ${a.designation} (référencé : ${raisons}, désactivé au lieu d'être supprimé)`);
      return { ok: true, desactive: true, raisons };
    }
    db.remove(ENTITE, a.id);
    ctx.audit(req, 'suppression', ENTITE, a.id, `Article ${a.code} — ${a.designation}`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  // ----- Routes : mouvements --------------------------------------------------------------
  router.post('/api/articles/:id/mouvements', async (req) => {
    const a = articleVisible(req, req.params.id);
    const b = objet(req.body);
    const type = String(b.type == null ? '' : b.type);
    if (type === 'retour') throw new HttpError(400, 'Un retour en stock s\'enregistre en annulant la sortie correspondante');
    if (!['entree', 'sortie', 'inventaire'].includes(type)) throw new HttpError(400, 'Type de mouvement invalide : entrée, sortie ou inventaire attendu');
    let fournisseurId = null; let otId = null; let ot = null; let prixUnitaire = null;
    if (type === 'entree') {
      fournisseurId = idRef(b.fournisseurId, 'Fournisseur');
      if (fournisseurId != null && !db.get('fournisseurs', fournisseurId)) throw new HttpError(400, 'Fournisseur introuvable');
      prixUnitaire = nombre(b.prixUnitaire, 'Prix unitaire', { max: 1e8 });
    }
    if (type === 'sortie' && b.otId != null && b.otId !== '') {
      otId = idRef(b.otId, 'Ordre de travail');
      ot = db.get('ot', otId);
      if (!ot || !ctx.canSee(req, ot)) throw new HttpError(400, 'Ordre de travail introuvable');
      if (otEstFinal(ot)) throw new HttpError(400, `L'ordre de travail ${ot.numero || ot.id} est clôturé : imputation impossible`);
    }
    // Sortie : équipement destinataire (celui de l'OT, sinon celui indiqué), obligatoire pour une pièce dédiée
    const equipementId = type === 'sortie' ? equipementSortie(ot, b.equipementId, req) : null;
    const r = enregistrer({ articleId: a.id, type, quantite: b.quantite, motif: b.motif || (ot ? `${/^OT/i.test(String(ot.numero || '')) ? '' : 'OT '}${ot.numero || '#' + ot.id} — ${ot.titre || ''}` : ''), prixUnitaire, fournisseurId, otId, userId: req.user.id, req, refuserInactif: type !== 'inventaire', equipementId, controleDedie: true });
    if (ot) imputerOt(ot, r.mouvement, r.article, req);
    const lecteur = enLecture(req);
    const refs = references(lecteur);
    return { mouvement: enrichirMouvement(r.mouvement, refs, lecteur), article: resume(r.article, refs) };
  }, { perm: [MODULE, 'modifier'] });

  router.get('/api/mouvements', async (req) => {
    const rows = filtrerMouvements(req, req.query);
    const limite = Math.min(Math.max(Number(req.query.limite) || 5000, 1), 50000);
    return rows.slice(0, limite);
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/mouvements-export', async (req, res) => {
    const rows = filtrerMouvements(req, req.query);
    const entetes = ['Date', 'Type', 'Code article', 'Désignation', 'Quantité', 'Unité', 'Écart', 'Stock avant', 'Stock après', 'Prix unitaire', 'Valeur', 'OT', 'Équipement', 'Fournisseur', 'Motif', 'Utilisateur'];
    const equipementCsv = (m) => (m.equipementMasque ? 'Hors périmètre' : (m.equipementNom ? `${m.equipementNumero ? m.equipementNumero + ' ' : ''}${m.equipementNom}` : ''));
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    for (const m of rows) {
      const d = new Date(m.date);
      const date = Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('fr-FR')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      lignes.push([date, TYPES_MOUVEMENT[m.type] || m.type, m.articleCode, m.articleDesignation, csvNombre(m.quantite), m.uniteCode, csvNombre(m.ecart), csvNombre(m.quantiteAvant), csvNombre(m.quantiteApres), csvNombre(m.prixUnitaire), csvNombre(m.valeur), m.otMasque ? 'Hors périmètre' : m.otNumero, equipementCsv(m), m.fournisseurNom, m.motif, m.userNom].map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', MVT, null, `${rows.length} mouvement(s) de stock`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mouvements-stock-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  /** Annulation d'une sortie non imputée à un OT (les sorties d'OT s'annulent depuis l'OT). */
  router.post('/api/mouvements/:id/annuler', async (req) => {
    const m = db.get(MVT, req.params.id);
    if (!m) throw new HttpError(404, 'Mouvement de stock introuvable');
    articleVisible(req, m.articleId);
    if (m.otId != null) {
      const o = db.get('ot', m.otId);
      if (o && (o.pieces || []).some((p) => p && Number(p.mouvementId) === m.id)) {
        throw new HttpError(400, `Cette sortie est imputée à l'ordre de travail ${o.numero || o.id} : effectuez le retour en stock depuis l'OT`);
      }
    }
    const r = annulerSortie(m.id, req.user.id, req);
    const lecteur = enLecture(req);
    const refs = references(lecteur);
    return { mouvement: enrichirMouvement(r.mouvement, refs, lecteur), article: resume(r.article, refs) };
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : alertes, valorisation, références ---------------------------------------
  function alertes(req) {
    const refs = references(req);
    const derniers = derniersMouvements();
    return ctx.scope(req, db.list(ENTITE, (a) => a.actif !== false && estSousSeuil(a)))
      .map((a) => {
        const r = resume(a, refs, derniers);
        const f = a.fournisseurId != null ? refs.fournisseurs.get(Number(a.fournisseurId)) : null;
        r.quantiteACommander = quantiteACommander(a);
        r.valeurCommande = arrondi(r.quantiteACommander * num(a.prixUnitaire), 2);
        r.delaiLivraisonJours = f && f.delaiLivraisonJours != null ? f.delaiLivraisonJours : null;
        return r;
      })
      .sort((a, b) => (a.fournisseurNom ? 0 : 1) - (b.fournisseurNom ? 0 : 1) || a.fournisseurNom.localeCompare(b.fournisseurNom, 'fr') || String(a.code).localeCompare(String(b.code), 'fr', { numeric: true }));
  }
  router.get('/api/stock-alertes', async (req) => alertes(req), { perm: [MODULE, 'voir'] });

  router.get('/api/stock-valorisation', async (req) => {
    const rows = ctx.scope(req, db.list(ENTITE, (a) => a.actif !== false));
    const cats = ctx.liste('categoriesArticles');
    const parCat = new Map();
    let total = 0;
    for (const a of rows) {
      const k = a.categorieCode && cats.some((c) => c.code === a.categorieCode) ? a.categorieCode : null;
      const x = parCat.get(k) || { categorieCode: k, label: k ? libelleListe('categoriesArticles', k) : 'Sans catégorie', couleur: k ? (cats.find((c) => c.code === k) || {}).couleur || null : null, nbArticles: 0, nbSousSeuil: 0, valeur: 0 };
      x.nbArticles++;
      if (estSousSeuil(a)) x.nbSousSeuil++;
      x.valeur = arrondi(x.valeur + valeurArticle(a), 2);
      total = arrondi(total + valeurArticle(a), 2);
      parCat.set(k, x);
    }
    const ordre = (k) => { const i = cats.findIndex((c) => c.code === k); return i < 0 ? 999 : i; };
    const parCategorie = Array.from(parCat.values()).sort((a, b) => ordre(a.categorieCode) - ordre(b.categorieCode))
      .map((x) => Object.assign(x, { part: total > 0 ? arrondi((x.valeur / total) * 100, 1) : 0 }));
    const topArticles = rows.map((a) => ({ id: a.id, code: a.code, designation: a.designation, categorieCode: a.categorieCode || null, quantite: arrondi(num(a.quantite)), uniteCode: a.uniteCode || '', prixUnitaire: num(a.prixUnitaire), valeur: valeurArticle(a) }))
      .filter((a) => a.valeur > 0).sort((a, b) => b.valeur - a.valeur).slice(0, 10);
    return {
      date: new Date().toISOString(), total, nbArticles: rows.length,
      nbValorises: rows.filter((a) => valeurArticle(a) > 0).length,
      nbSansPrix: rows.filter((a) => !(num(a.prixUnitaire) > 0)).length,
      nbSousSeuil: rows.filter((a) => estSousSeuil(a)).length,
      nbRuptures: rows.filter((a) => num(a.quantite) <= 0).length,
      parCategorie, topArticles,
    };
  }, { perm: [MODULE, 'voir'] });

  /** Listes de choix pour les formulaires du stock (indépendantes des droits sur les autres modules). */
  router.get('/api/stock-references', async (req) => {
    const fournisseurs = db.list('fournisseurs').map((f) => ({ id: f.id, nom: f.nom || `#${f.id}`, actif: f.actif !== false, delaiLivraisonJours: f.delaiLivraisonJours == null ? null : f.delaiLivraisonJours }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const equipements = db.list('equipements').filter((e) => equipementVisible(req, e))
      .map((e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || '', secteurId: e.secteurId == null ? null : e.secteurId, actif: e.actif !== false, parentId: e.parentId == null ? null : Number(e.parentId), etatCode: e.etatCode || null, reforme: estReforme(e) }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const finaux = statutsOtFinaux();
    const otOuverts = ctx.scope(req, db.list('ot')).filter((o) => !finaux.has(o.statut))
      .map((o) => ({ id: o.id, numero: o.numero || '', titre: o.titre || '', statut: o.statut, equipementId: o.equipementId == null ? null : o.equipementId }))
      .sort((a, b) => String(b.numero).localeCompare(String(a.numero), 'fr', { numeric: true }));
    const emplacements = Array.from(new Set(ctx.scope(req, db.list(ENTITE)).map((a) => a.emplacement).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr'));
    return { fournisseurs, equipements, otOuverts, emplacements, stockNegatif: !!wf().stockNegatif };
  }, { perm: [MODULE, 'voir'] });

  // ----- Pièces dédiées : retrait d'un équipement supprimé ------------------------------------
  /**
   * Retire un équipement (supprimé) des listes d'équipements des articles. Une pièce dédiée qui n'a plus aucun
   * équipement reste dédiée mais inutilisable : elle est signalée « à réaffecter » et les utilisateurs Stock › Modifier
   * qui la voient sont prévenus. Retourne { articles, aReaffecter } (identifiants).
   */
  function retirerEquipement(equipementOuId, req) {
    const e = equipementOuId && typeof equipementOuId === 'object' ? equipementOuId : db.get('equipements', equipementOuId);
    const id = Number(e ? e.id : equipementOuId);
    const libelle = e ? `${e.numero ? e.numero + ' ' : ''}${e.nom || ''}`.trim() : `équipement #${id}`;
    const c = contexteEquipements();
    const modifies = []; const aReaffecter = [];
    for (const a of db.list(ENTITE, (x) => (x.equipementIds || []).map(Number).includes(id))) {
      const restants = (a.equipementIds || []).filter((x) => Number(x) !== id);
      const maj = db.update(ENTITE, a.id, { equipementIds: restants });
      modifies.push(a.id);
      if (!estDediee(a)) continue;
      const orpheline = !restants.map(Number).some((x) => x !== id && c.parId.has(x));
      ctx.audit(req || null, 'modification', ENTITE, a.id, `Article ${a.code} — ${a.designation} : équipement autorisé retiré (suppression de l'équipement ${libelle})${orpheline ? ' ; pièce dédiée sans équipement : à réaffecter' : ''}`, { notifier: false });
      if (orpheline) aReaffecter.push(maj);
    }
    for (const a of aReaffecter) {
      try {
        const destinataires = [];
        ctx.usersAvecDroit(MODULE, 'modifier', (u, p) => { if (!perms.canSeeRecord(p, u, a)) return false; destinataires.push({ u, p }); return true; });
        for (const { u, p } of destinataires) {
          // L'équipement supprimé n'est nommé qu'aux utilisateurs qui pouvaient le voir
          const nomEq = e && perms.canSeeRecord(p, u, e) ? ` (${libelle})` : '';
          ctx.notify([u.id], {
            titre: 'Pièce dédiée sans équipement : à réaffecter',
            message: `${a.code ? a.code + ' — ' : ''}${a.designation} : l'équipement auquel elle était dédiée${nomEq} a été supprimé. La pièce n'est plus utilisable sur aucun équipement tant qu'elle n'est pas réaffectée.`,
            lien: `#/stock/${a.id}`, type: 'alerte',
          });
        }
      } catch (err) { ctx.log('Stock : notification de pièce dédiée impossible', err.message); }
    }
    return { articles: modifies, aReaffecter: aReaffecter.map((a) => a.id) };
  }

  /**
   * Pièces dédiées utilisables sur un équipement (choisi directement ou, sous-équipements inclus, par un ancêtre),
   * avec `direct` et `viaId` (équipement choisi dont il hérite). Le lecteur `req` restreint la liste à sa portée.
   */
  function dediesA(equipementId, req) {
    const id = Number(equipementId);
    const c = contexteEquipements();
    const ancetres = []; const vus = new Set([id]);
    let cur = c.parId.get(id);
    while (cur && cur.parentId != null && cur.parentId !== '' && !vus.has(Number(cur.parentId))) { const p = Number(cur.parentId); vus.add(p); ancetres.push(p); cur = c.parId.get(p); }
    const rows = db.list(ENTITE, (a) => estDediee(a) && (a.equipementIds || []).map(Number).some((x) => x === id || ancetres.includes(x)));
    return (req && req.perms ? ctx.scope(req, rows) : rows).map((a) => {
      const choisis = (a.equipementIds || []).map(Number);
      const direct = choisis.includes(id);
      const via = direct ? null : ancetres.find((x) => choisis.includes(x));
      if (!direct && !avecSousEquipements(a)) return null;
      return Object.assign({}, a, { direct, viaId: via == null ? null : via });
    }).filter(Boolean);
  }

  // ----- Services publiés -----------------------------------------------------------------
  // `silencieux: true` (traitement en masse) : mouvement enregistré sans entrée de journal unitaire ; l'appelant
  // écrit une entrée récapitulative, le détail restant dans mouvementsStock.
  ctx.services.stock = {
    /**
     * Sortie de stock (ex. pièce consommée sur un OT). Lève HttpError 400 « Stock insuffisant… » si nécessaire.
     * Équipement destinataire : celui de l'OT (otId), sinon `equipementId` ; une pièce dédiée n'est sortie que pour un
     * équipement autorisé (message selon la portée de `req`, ou de l'utilisateur `userId` à défaut).
     */
    sortir({ articleId, quantite, otId, userId, motif, silencieux, equipementId, req } = {}) {
      const ot = otId == null || otId === '' ? null : db.get('ot', idRef(otId, 'Ordre de travail'));
      const eq = equipementSortie(ot, equipementId, req && req.perms ? req : null);
      return enregistrer({ articleId: idRef(articleId, 'Article'), type: 'sortie', quantite, otId: otId == null || otId === '' ? null : idRef(otId, 'Ordre de travail'), userId, motif, refuserInactif: true, silencieux: !!silencieux, equipementId: eq, controleDedie: true, req: req && req.perms ? req : null });
    },
    /** Règle d'utilisation d'une pièce : { ok, raison } ; `req` (facultatif) limite les équipements cités à sa portée. */
    utilisablePour: (article, equipementId, req) => utilisablePour(article, equipementId, req || null),
    /** Identifiants des équipements autorisés d'une pièce dédiée (sous-équipements compris si demandé) ; null pour une pièce libre. */
    equipementsAutorises: (article) => equipementsAutorises(article),
    /** Indicateurs d'affichage d'une pièce pour un lecteur : reservee, reserveeA (noms visibles), reserveeEquipements, reserveeHorsPerimetre, reserveeTexte, sansEquipement, equipementsAutorisesIds. */
    infosDediee: (article, req) => infosDediee(article, req || null),
    /**
     * Indicateurs d'une liste d'articles pour un équipement (une seule lecture des équipements) :
     * chaque article est complété de infosDediee et de { utilisable, raison } pour cet équipement.
     */
    indicateurs(articles, equipementId, req) {
      const c = contexteEquipements();
      return (articles || []).map((a) => {
        const d = infosDediee(a, req || null, c);
        const u = utilisablePour(a, equipementId, req || null, c);
        return Object.assign(d, { utilisable: u.ok, raison: u.ok ? '' : u.raison });
      });
    },
    /**
     * Pièces prévues d'un plan préventif reprises sur un OT de l'équipement : les lignes utilisables (règle des pièces
     * dédiées) sont retenues, les autres écartées avec la raison (citant les équipements visibles par `req`).
     * → { retenues: [lignes du plan], ecartees: [{ articleId, code, designation, quantite, raison }] }
     */
    piecesPrevuesPour(pieces, equipementId, req) {
      const c = contexteEquipements();
      const retenues = []; const ecartees = [];
      for (const x of pieces || []) {
        if (!x || x.articleId == null) continue;
        const a = db.get(ENTITE, x.articleId);
        const u = a ? utilisablePour(a, equipementId, req || null, c) : { ok: true };
        if (u.ok) retenues.push(x);
        else ecartees.push({ articleId: Number(x.articleId), code: a.code || '', designation: a.designation || '', quantite: Number(x.quantite) || 0, raison: u.raison });
      }
      return { retenues, ecartees };
    },
    /** Plans préventifs actifs qui prévoient l'article sur un équipement non autorisé (règle des pièces dédiées). */
    plansNonConformes: (article) => plansNonConformes(article),
    /** Pièces dédiées utilisables sur un équipement ({ direct, viaId }), selon la portée de `req`. */
    dediesA: (equipementId, req) => dediesA(equipementId, req || null),
    /** Retrait d'un équipement supprimé des articles (pièces dédiées signalées et notifiées si elles n'ont plus d'équipement). */
    retirerEquipement: (equipementOuId, req) => retirerEquipement(equipementOuId, req || null),
    /** Entrée en stock (réception) ; le prix unitaire éventuel met à jour le CUMP de l'article. */
    entrer({ articleId, quantite, userId, motif, prixUnitaire, fournisseurId, silencieux } = {}) {
      const f = fournisseurId == null || fournisseurId === '' ? null : idRef(fournisseurId, 'Fournisseur');
      if (f != null && !db.get('fournisseurs', f)) throw new HttpError(400, 'Fournisseur introuvable');
      return enregistrer({ articleId: idRef(articleId, 'Article'), type: 'entree', quantite, userId, motif, prixUnitaire, fournisseurId: f, refuserInactif: true, silencieux: !!silencieux });
    },
    /** Annule une sortie : mouvement « retour » qui ré-incrémente le stock (et recalcule le coût moyen pondéré). */
    annulerSortie(mouvementId, userId) { return annulerSortie(idRef(mouvementId, 'Mouvement'), userId); },
    /** Inventaire : quantité constatée (l'écart est calculé). */
    inventorier({ articleId, quantite, userId, motif, silencieux } = {}) { return enregistrer({ articleId: idRef(articleId, 'Article'), type: 'inventaire', quantite, userId, motif, silencieux: !!silencieux }); },
    /** Articles actifs sous le seuil (portée appliquée si req fourni). */
    alertes: (req) => (req ? alertes(req) : db.list(ENTITE, (a) => a.actif !== false && estSousSeuil(a)).map((a) => Object.assign({}, a, { quantiteACommander: quantiteACommander(a) }))),
    estSousSeuil, quantiteACommander, valeur: valeurArticle,
    TYPES_MOUVEMENT: Object.assign({}, TYPES_MOUVEMENT),
  };
}

// ----- Données de démonstration -----------------------------------------------------
let seedEnCours = false;
const TEMOIN = 'Roulement à billes 6205-2RS';

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  if (db.findOne(ENTITE, (a) => a.designation === TEMOIN)) return 'déjà présents';
  seedEnCours = true;
  try {
    // Dépendances idempotentes (l'ordre alphabétique des fichiers ne garantit pas leur présence)
    for (const fichier of ['profils.js', 'secteurs.js', 'utilisateurs.js', 'fournisseurs.js', 'equipements.js']) {
      const m = (ctx.modules || []).find((x) => x.fichier === fichier);
      if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Stock : seed dépendant en échec', fichier, e.message); } }
    }
    return insererDemo(ctx);
  } finally { seedEnCours = false; }
}

function insererDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const gabarit = (cfg.numerotation || {}).art || 'ART-{num:4}';
  const listes = cfg.listes || {};
  const code = (liste, voulu) => { const l = listes[liste] || []; return !l.length || l.some((x) => x.code === voulu) ? voulu : l[0].code; };
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };
  const fournisseur = (nomExact, re) => { const f = db.findOne('fournisseurs', (x) => x.nom === nomExact) || (re ? db.findOne('fournisseurs', (x) => re.test(x.nom || '')) : null); return f ? f.id : null; };
  const equipements = (...noms) => noms.map((n) => db.findOne('equipements', (e) => e.nom === n)).filter(Boolean).map((e) => e.id);
  const secteur = (c) => { const s = db.findOne('secteurs', (x) => x.code === c); return s ? s.id : null; };
  const jour = (n, heure = '09:00') => { const d = new Date(); d.setDate(d.getDate() - n); const [h, mi] = heure.split(':').map(Number); d.setHours(h, mi, 0, 0); return d.toISOString(); };
  const codeUnique = () => { for (let i = 0; i < 10000; i++) { const c = db.nextNumber('art', gabarit); if (!db.findOne(ENTITE, (a) => normaliser(a.code) === normaliser(c))) return c; } return 'ART-' + Date.now(); };

  const SKF = fournisseur('SKF France', /\bskf\b/i);
  const REXEL = fournisseur('Rexel', /rexel/i);
  const TOTAL = fournisseur('Total Lubrifiants', /total/i);
  const SCHNEIDER = fournisseur('Schneider Electric', /schneider/i);
  const LOG = secteur('LOG');

  // Historique : [jours avant aujourd'hui, type, quantité, motif, login, prix?] — le stock initial (inventaire
  // de reprise à J-90) est reconstitué pour que l'historique aboutisse à la quantité finale `q`
  // (ou fixé par `initial` lorsqu'un inventaire tournant intervient ensuite). Les articles consommés par les
  // OT de démonstration (courroie, filtre à air, capteur, joints, huile) n'ont pas de mouvement postérieur
  // aux dates de ces OT, afin que le journal reste chronologiquement cohérent (quantité avant / après).
  const defs = [
    { designation: TEMOIN, cat: 'mecanique', u: 'u', q: 12, seuil: 4, qc: 10, empl: 'Magasin central — A1 — Étagère 2', pu: 8.9, f: SKF, ref: '6205-2RSH', eqs: equipements('Convoyeur de sortie ligne 1', 'Étiqueteuse'),
      description: 'Roulement rigide à une rangée de billes, 25 × 52 × 15 mm, deux joints d\'étanchéité.',
      hist: [[9, 'sortie', 4, 'Révision des galets de l\'étiqueteuse', 'jbernard', null, 'Étiqueteuse']] },
    { designation: 'Roulement à billes 6312-2Z/C3', cat: 'mecanique', u: 'u', q: 2, seuil: 2, qc: 4, empl: 'Magasin central — A1 — Étagère 4', pu: 64.5, f: SKF, ref: '6312-2Z/C3', eqs: equipements('Remplisseuse rotative'), reservee: true,
      description: 'Roulement moteur principal de la remplisseuse, côté accouplement (60 × 130 × 31 mm, jeu C3). Pièce appairée au moteur Krones : réservée à la remplisseuse.',
      hist: [[33, 'sortie', 2, 'Remplacement du palier côté accouplement (analyse vibratoire)', 'kleroy', null, 'Remplisseuse rotative']] },
    { designation: 'Roulement à billes 6310-2Z/C3', cat: 'mecanique', u: 'u', q: 3, seuil: 2, qc: 4, empl: 'Magasin central — A1 — Étagère 4', pu: 48.2, f: SKF, ref: '6310-2Z/C3', eqs: equipements('Remplisseuse rotative'),
      description: 'Roulement moteur principal de la remplisseuse, côté ventilateur (50 × 110 × 27 mm, jeu C3).', hist: [] },
    { designation: 'Courroie crantée HTD 1400-8M-30', cat: 'mecanique', u: 'u', q: 4, seuil: 2, qc: 3, empl: 'Magasin central — A2 — Crochets', pu: 46.8, f: SKF, ref: 'PHG 1400-8M-30', eqs: equipements('Convoyeur de sortie ligne 1'),
      description: 'Courroie synchrone profil HTD, pas 8 mm, longueur primitive 1 400 mm, largeur 30 mm.', hist: [] },
    { designation: 'Cartouche filtre à air compresseur GA 37', cat: 'pneumatique', u: 'u', q: 5, seuil: 2, qc: 4, empl: 'Magasin central — B1 — Étagère 1', pu: 89, f: fournisseur('Atlas Copco', /atlas/i), ref: '1613 9001 00', eqs: equipements('Compresseur d\'air GA 37'), reservee: true,
      description: 'Élément filtrant d\'aspiration d\'origine constructeur (remplacement toutes les 4 000 h). Réservé au compresseur GA 37 (garantie constructeur).',
      hist: [[70, 'entree', 4, 'Réception de la commande CDE-2026-0142', 'mdupont', 91.5]] },
    { designation: 'Filtre plissé F7 592 × 592 × 534 mm', cat: 'consommable', u: 'u', q: 8, seuil: 4, qc: 8, empl: 'Magasin central — C3 — Palette', pu: 42.5, f: null, ref: 'F7-592-592-534-8P', eqs: equipements('CTA atelier conditionnement'),
      description: 'Filtre à poches F7 (ePM1 60 %), 8 poches, cadre galvanisé.',
      hist: [[56, 'sortie', 8, 'Remplacement trimestriel des filtres de la CTA', 'kleroy', null, 'CTA atelier conditionnement'], [40, 'entree', 8, 'Réception de la commande CDE-2026-0171', 'mdupont', 42.5]] },
    { designation: 'Huile hydraulique Azolla ZS 46', cat: 'lubrifiant', u: 'l', q: 120, seuil: 40, qc: 208, empl: 'Local lubrifiants — Fût n°2', pu: 3.85, f: TOTAL, ref: 'AZOLLA ZS 46 — fût 208 L', eqs: equipements('Presse hydraulique 250 t', 'Chariot élévateur thermique n°2'),
      description: 'Huile hydraulique anti-usure HM, grade ISO VG 46.',
      hist: [[44, 'sortie', 25, 'Appoint du réservoir de la presse 250 t (fuite à surveiller)', 'jbernard', null, 'Presse hydraulique 250 t'], [24, 'entree', 104, 'Réception de la commande CDE-2026-0198 (demi-fût)', 'mdupont', 3.79]] },
    { designation: 'Graisse lithium Multis EP 2 (cartouche 400 g)', cat: 'lubrifiant', u: 'u', q: 2, seuil: 6, qc: 12, empl: 'Local lubrifiants — Armoire 1', pu: 6.4, f: TOTAL, ref: 'MULTIS EP 2 — 400 g', eqs: equipements('Robot de palettisation', 'Convoyeur de sortie ligne 1', 'Pont roulant 5 t'),
      description: 'Graisse multi-usages au lithium, extrême pression, NLGI 2.',
      hist: [[27, 'sortie', 6, 'Graissage des axes 1 à 4 du robot et des paliers des convoyeurs', 'jbernard', null, 'Robot de palettisation']] },
    { designation: 'Kit joints de vérin hydraulique (tige Ø 40 à 80)', cat: 'hydraulique', u: 'lot', q: 6, seuil: 2, qc: 4, empl: 'Magasin central — B2 — Tiroir 5', pu: 38, f: SKF, ref: 'SKF-KIT-VH-4080', eqs: equipements('Presse hydraulique 250 t', 'Chariot élévateur thermique n°2'),
      description: 'Jeu de joints de tige, racleurs et bagues de guidage pour vérins hydrauliques.', hist: [] },
    { designation: 'Contacteur TeSys D 18 A — bobine 24 V CC', cat: 'electrique', u: 'u', q: 1, seuil: 2, qc: 3, empl: 'Magasin central — D1 — Bac 3', pu: 72.3, f: SCHNEIDER, ref: 'LC1D18BD', eqs: equipements('Fardeleuse', 'Remplisseuse rotative'),
      description: 'Contacteur tripolaire 18 A AC-3, 1 NO + 1 NF, bobine 24 V CC.',
      hist: [[12, 'sortie', 2, 'Remplacement des contacteurs du four de rétraction (fardeleuse)', 'kleroy', null, 'Fardeleuse']] },
    { designation: 'Disjoncteur moteur GV2ME10 (4 à 6,3 A)', cat: 'electrique', u: 'u', q: 3, seuil: 1, qc: 2, empl: 'Magasin central — D1 — Bac 4', pu: 61, f: SCHNEIDER, ref: 'GV2ME10', eqs: equipements('Convoyeur de sortie ligne 1', 'Étiqueteuse'),
      description: 'Disjoncteur magnéto-thermique de protection moteur, réglage 4 à 6,3 A.', hist: [] },
    { designation: 'Fusibles cylindriques 10 × 38 gG 10 A (boîte de 10)', cat: 'electrique', u: 'lot', q: 8, initial: 9, seuil: 3, qc: 5, empl: 'Magasin central — D2 — Bac 1', pu: 9.8, f: REXEL, ref: 'DF2CA10', eqs: [],
      description: 'Cartouches fusibles gG 500 V, pouvoir de coupure 120 kA.',
      hist: [[7, 'inventaire', 8, 'Inventaire tournant zone D (une boîte manquante)', 'mdupont']] },
    { designation: 'Capteur inductif M18 PNP 8 mm', cat: 'electrique', u: 'u', q: 4, seuil: 1, qc: 2, empl: 'Magasin central — D3 — Bac 2', pu: 58.9, f: SCHNEIDER, ref: 'XS618B1PAL2', eqs: equipements('Ligne de conditionnement L1'), reservee: true, sous: true,
      description: 'Détecteur de proximité inductif M18, portée 8 mm, sortie PNP NO, connecteur M12. Modèle paramétré pour la ligne 1 : réservé à ses machines.',
      hist: [[25, 'sortie', 1, 'Remplacement du détecteur de présence bouteille (étiqueteuse)', 'jbernard', null, 'Étiqueteuse'], [25, 'retour', 1, 'Pièce non utilisée : défaut de câblage, capteur d\'origine conservé', 'jbernard', null, 'Étiqueteuse']] },
    { designation: 'Électrovanne 5/2 G1/4 — 24 V CC', cat: 'pneumatique', u: 'u', q: 2, seuil: 1, qc: 2, empl: 'Magasin central — B1 — Étagère 3', pu: 112, f: null, ref: 'SY5120-5LZ-01', eqs: equipements('Robot de palettisation', 'Fardeleuse'),
      description: 'Distributeur pneumatique monostable 5/2, raccordement G1/4, bobine 24 V CC.', hist: [] },
    { designation: 'Câble souple H07RN-F 3G2,5 mm²', cat: 'electrique', u: 'm', q: 85, seuil: 25, qc: 100, empl: 'Magasin logistique — Touret n°1', pu: 2.35, f: REXEL, ref: 'H07RNF3G2,5', eqs: equipements('Transpalette électrique'), secteur: LOG,
      description: 'Câble souple caoutchouc pour alimentation d\'engins mobiles et prolongateurs.',
      hist: [[28, 'sortie', 15, 'Remplacement du câble du chargeur de batterie du transpalette', 'kleroy', null, 'Transpalette électrique']] },
  ];

  const INITIAL = 90; // inventaire de reprise : il y a 90 jours
  const colArticles = db.data.collections[ENTITE];
  const colMvt = db.data.collections[MVT];
  let nbMvt = 0;
  for (const d of defs) {
    const net = d.hist.reduce((s, [, type, x]) => s + (type === 'entree' || type === 'retour' ? x : (type === 'sortie' ? -x : 0)), 0);
    const initial = d.initial != null ? d.initial : d.q - net;
    const a = db.insert(ENTITE, {
      code: codeUnique(), designation: d.designation, description: d.description || '', categorieCode: code('categoriesArticles', d.cat), uniteCode: code('unites', d.u),
      quantite: d.q, seuilMin: d.seuil, quantiteCommande: d.qc, emplacement: d.empl, prixUnitaire: d.pu, fournisseurId: d.f == null ? null : d.f, referenceFournisseur: d.ref,
      equipementIds: d.eqs, reservee: !!d.reservee && d.eqs.length > 0, inclureSousEquipements: d.sous !== false, secteurId: d.secteur == null ? null : d.secteur, actif: true, champs: {}, createdBy: admin ? admin.id : null,
    });
    const brutA = colArticles.find((x) => x.id === a.id);
    if (brutA) brutA.createdAt = jour(INITIAL, '07:00');

    // Inventaire initial puis historique, dans l'ordre chronologique
    const mvts = [[INITIAL, 'inventaire', initial, 'Inventaire initial (reprise du stock à la mise en service de la GMAO)', 'mdupont', d.pu]].concat(d.hist);
    let stock = 0; let derniereSortie = null; let derniereDate = null;
    for (const [n, type, qte, motif, login, prix, nomEq] of mvts) {
      const eq = nomEq ? db.findOne('equipements', (e) => e.nom === nomEq) : null;
      const avant = stock;
      stock = arrondi(type === 'inventaire' ? qte : stock + (type === 'entree' || type === 'retour' ? qte : -qte));
      const date = jour(n, type === 'retour' ? '15:30' : (type === 'entree' ? '10:30' : (n === INITIAL ? '07:30' : '08:45')));
      const m = db.insert(MVT, {
        articleId: a.id, type, quantite: qte, quantiteAvant: arrondi(avant), quantiteApres: stock, ecart: arrondi(stock - avant), date,
        userId: userId(login), otId: null, motif, prixUnitaire: prix != null ? prix : d.pu, fournisseurId: type === 'entree' ? (d.f == null ? null : d.f) : null,
        equipementId: eq && (type === 'sortie' || type === 'retour') ? eq.id : null, equipementLibelle: eq && (type === 'sortie' || type === 'retour') ? `${eq.numero ? eq.numero + ' — ' : ''}${eq.nom}` : '',
        ...(eq && (type === 'sortie' || type === 'retour') ? { equipementSecteurId: eq.secteurId == null || eq.secteurId === '' ? null : Number(eq.secteurId) } : {}),
        mouvementOrigineId: type === 'retour' && derniereSortie ? derniereSortie.id : null, annuleParId: null, createdBy: userId(login),
      });
      const brut = colMvt.find((x) => x.id === m.id);
      if (brut) { brut.createdAt = date; brut.updatedAt = date; }
      if (type === 'retour' && derniereSortie) { const s = colMvt.find((x) => x.id === derniereSortie.id); if (s) s.annuleParId = m.id; }
      if (type === 'sortie') derniereSortie = m;
      if (type === 'inventaire' && brutA) brutA.dateDernierInventaire = date;
      derniereDate = date;
      nbMvt++;
    }
    if (brutA) { brutA.quantite = stock; brutA.updatedAt = derniereDate || brutA.createdAt; }
  }
  db.touch();
  const sousSeuil = db.count(ENTITE, (a) => a.actif !== false && estSousSeuil(a));
  const dediees = defs.filter((d) => d.reservee && d.eqs.length).length;
  return `${defs.length} articles (${sousSeuil} sous le seuil, ${dediees} pièces dédiées), ${nbMvt} mouvements de stock (dont ${nbMvt - defs.length} sur les 60 derniers jours)`;
}

module.exports = { nom, register, seedDemo, estSousSeuil, quantiteACommander, valeurArticle, csvEscape };
