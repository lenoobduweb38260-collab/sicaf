'use strict';
/**
 * Module Maintenance préventive : plans de maintenance périodiques (calendrier ou compteur),
 * gammes opératoires, pièces nécessaires, calcul des échéances, génération des ordres de travail
 * (manuelle, forcée ou automatique), échéancier prévisionnel et export CSV.
 *
 * Modèle (collection `plansPreventifs`, voir docs/ARCHITECTURE.md) :
 *   numero, nom, description, equipementId, secteurId (repris de l'équipement), typeCode, prioriteCode,
 *   periodicite { type: jours|semaines|mois|compteur, valeur }, dateDebut, derniereExecution (date ou
 *   valeur compteur), derniereExecutionDate, prochaineEcheance (date ISO ou valeur compteur),
 *   gamme [{ ordre, libelle, duree }], dureeEstimee, technicienId, pieces [{ articleId, quantite }],
 *   actif, genererJoursAvant (vide = config.preventif.horizonJours), champs, dernierOtId, derniereGeneration,
 *   realisationPrecedente (état du plan avant la dernière réalisation, rétabli si son OT est réouvert ou annulé).
 *
 * État calculé : 'a_jour' | 'proche' (échéance ≤ aujourd'hui + horizon) | 'en_retard' (échéance dépassée,
 * ou compteur atteint) | 'inactif'. Pour un plan sur compteur, la date d'échéance est estimée à partir
 * du rythme d'utilisation de l'équipement (relevés de compteur de l'année écoulée).
 *
 * Droits : preventif.voir (consultation, échéancier), creer (création, duplication), modifier
 *   (modification, génération des OT), supprimer (suppression ou désactivation si des OT référencent le plan),
 *   exporter (CSV). Portée : celle de l'utilisateur (ctx.scope / secteur repris de l'équipement).
 *
 * Services publiés   : ctx.services.preventif.{ generer(options), echeances(options), analyser(plan),
 *                      etat(plan), calculerProchaineEcheance(plan, base), periodiciteLibelle(periodicite, unite) }
 * Événements émis    : 'preventif:genere' ({ plan, ot }), 'preventif:cree', 'preventif:modifie',
 *                      'preventif:supprime', 'preventif:realise' ({ plan, ot }) ; 'ot:cree' en mode autonome.
 * Événements écoutés : 'ot:termine' (derniereExecution / prochaineEcheance recalculées depuis la réalisation),
 *                      'ot:statut' et 'ot:supprime' (l'OT de la dernière réalisation réouvert, annulé ou supprimé :
 *                      le plan retrouve l'état antérieur à cette réalisation).
 * Services consommés : ctx.services.ot.{ creerDepuisPlan | creer }, ctx.services.equipements.visible.
 */
const nom = 'Maintenance préventive';
const ENTITE = 'plansPreventifs';
const MODULE = 'preventif';
const MAX_GAMME = 200;
const MAX_PIECES = 100;
const MAX_OCCURRENCES = 400;
const JOURS_MAX_ECHEANCIER = 731;
const INTERVALLE_AUTO_MS = 60 * 60 * 1000; // une heure
const DELAI_DEMARRAGE_MS = 5000;

const TYPES_PERIODICITE = { jours: 'Jours', semaines: 'Semaines', mois: 'Mois', compteur: 'Compteur de l\'équipement' };
const MAX_PERIODICITE = { jours: 3650, semaines: 520, mois: 120, compteur: 1e9 };
const ETATS = { a_jour: 'À jour', proche: 'Échéance proche', en_retard: 'En retard', inactif: 'Inactif' };

/** Statuts d'OT de repli (utilisés uniquement si la liste `statutsOT` est vide). */
const STATUTS_OT_DEFAUT = [
  { code: 'nouveau', label: 'Nouveau', ordre: 1, final: false },
  { code: 'planifie', label: 'Planifié', ordre: 2, final: false },
  { code: 'en_cours', label: 'En cours', ordre: 3, final: false },
  { code: 'en_attente', label: 'En attente', ordre: 4, final: false },
  { code: 'termine', label: 'Terminé', ordre: 5, final: true },
  { code: 'annule', label: 'Annulé', ordre: 6, final: true },
];

/** Unités de compteur : abréviation et genre (pour « tous les » / « toutes les »). */
const UNITES = {
  heures: { abrege: 'h', feminin: true }, heure: { abrege: 'h', feminin: true }, h: { abrege: 'h', feminin: true },
  cycles: { feminin: false }, km: { feminin: false }, kilometres: { feminin: false }, 'kilomètres': { feminin: false },
  'pièces': { feminin: true }, pieces: { feminin: true }, tonnes: { feminin: true }, 'm³': { feminin: false }, m3: { feminin: false },
  litres: { feminin: false }, coups: { feminin: false }, manoeuvres: { feminin: true }, 'manœuvres': { feminin: true },
};

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ----- Utilitaires purs (dates calendaires, formats) ------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }
/** Date locale « AAAA-MM-JJ ». */
function dateLocale(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Jour (AAAA-MM-JJ, heure locale) d'une date ou d'un horodatage ISO ; null si invalide. */
function jourDe(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (RE_DATE.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : dateLocale(new Date(t));
}
function decomposer(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return { y, m, d }; }
function versChaine(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
function ajouterJours(s, n) { const { y, m, d } = decomposer(s); return versChaine(y, m, d + n); }
/** Addition calendaire de mois (31 janvier + 1 mois = 28/29 février). */
function ajouterMois(s, n) {
  const { y, m, d } = decomposer(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12); const nm = total - ny * 12 + 1;
  const dernier = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return versChaine(ny, nm, Math.min(d, dernier));
}
function joursEntre(a, b) {
  const A = decomposer(a); const B = decomposer(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}
/** Date + k périodes (k = 1 par défaut), calculée depuis la base pour éviter la dérive des fins de mois. */
function ajouterPeriode(s, periodicite, k = 1) {
  const v = Number(periodicite && periodicite.valeur) || 0;
  switch (periodicite && periodicite.type) {
    case 'jours': return ajouterJours(s, v * k);
    case 'semaines': return ajouterJours(s, 7 * v * k);
    case 'mois': return ajouterMois(s, v * k);
    default: return s;
  }
}
function estDateValide(s) {
  if (typeof s !== 'string' || !RE_DATE.test(s)) return false;
  const { y, m, d } = decomposer(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2100;
}
function arrondi(n, dec = 2) { const f = 10 ** dec; return Math.round((Number(n) || 0) * f) / f; }
function nombreOuNull(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function objet(b) { return b && typeof b === 'object' && !Buffer.isBuffer(b) && !Array.isArray(b) ? b : {}; }
function formatNombre(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const [ent, dec] = String(Math.abs(arrondi(v, 2))).split('.');
  return (v < 0 ? '-' : '') + ent.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (dec ? ',' + dec : '');
}
function formatDateFr(s) { const j = jourDe(s); return j ? j.split('-').reverse().join('/') : ''; }
/** Référence lisible d'un OT : le préfixe « OT » n'est ajouté que si le numéro ne commence pas déjà par lui. */
function refOt(numero) { const n = String(numero == null ? '' : numero); return /^ot(?![a-zà-ÿ])/i.test(n) ? n : `OT ${n}`; }
function infoUnite(unite) { const u = String(unite || 'heures').trim(); return Object.assign({ libelle: u }, UNITES[u.toLowerCase()] || { feminin: false }); }
function abregeUnite(unite) { const i = infoUnite(unite); return i.abrege || i.libelle; }
/** Périodicité lisible : « tous les 3 mois », « toutes les semaines », « toutes les 500 h ». */
function periodiciteLibelle(p, unite) {
  if (!p || !p.type) return '';
  const v = Number(p.valeur);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (p.type === 'jours') return v === 1 ? 'tous les jours' : `tous les ${formatNombre(v)} jours`;
  if (p.type === 'semaines') return v === 1 ? 'toutes les semaines' : `toutes les ${formatNombre(v)} semaines`;
  if (p.type === 'mois') {
    if (v % 12 === 0) return v === 12 ? 'tous les ans' : `tous les ${formatNombre(v / 12)} ans`;
    return v === 1 ? 'tous les mois' : `tous les ${formatNombre(v)} mois`;
  }
  if (p.type === 'compteur') { const i = infoUnite(unite); return `${i.feminin ? 'toutes' : 'tous'} les ${formatNombre(v)} ${i.abrege || i.libelle}`; }
  return '';
}
function libelleEcheance(p, echeance, unite) {
  if (echeance == null || echeance === '') return 'échéance non définie';
  if (p && p.type === 'compteur') return `échéance à ${formatNombre(echeance)} ${abregeUnite(unite)}`;
  return `échéance du ${formatDateFr(echeance)}`;
}
const { csvEscape } = require('../csv');
const triNumero = (a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true }) || a.id - b.id;

/** Rythme d'utilisation d'un équipement (unités de compteur par jour) d'après ses relevés. */
function rythmeCompteur(eq) {
  if (!eq) return null;
  const pts = (Array.isArray(eq.compteurReleves) ? eq.compteurReleves : [])
    .map((r) => ({ t: Date.parse(r && r.date), v: Number(r && r.valeur) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);
  const courant = eq.compteur ? nombreOuNull(eq.compteur.valeur) : null;
  if (courant != null && (!pts.length || courant > pts[pts.length - 1].v)) pts.push({ t: Date.now(), v: courant });
  if (pts.length < 2) return null;
  const limite = Date.now() - 365 * 86400000;
  let fenetre = pts.filter((x) => x.t >= limite);
  if (fenetre.length < 2) fenetre = pts.slice(-2);
  const a = fenetre[0]; const b = fenetre[fenetre.length - 1];
  const jours = (b.t - a.t) / 86400000;
  if (jours < 1 || b.v <= a.v) return null;
  return { parJour: (b.v - a.v) / jours, ref: b };
}
function estimerDate(rythme, valeurCible) {
  const j = (Number(valeurCible) - rythme.ref.v) / rythme.parJour;
  return dateLocale(new Date(rythme.ref.t + j * 86400000));
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const can = (req, action) => !!(req && req.perms && perms.can(req.perms, MODULE, action));
  const cfgPrev = () => Object.assign({ horizonJours: 30, genererAuto: true }, ctx.config().preventif || {});
  const horizonDefaut = () => { const h = Number(cfgPrev().horizonJours); return Number.isFinite(h) && h >= 0 ? Math.round(h) : 30; };
  const statutsOt = () => { const l = ctx.liste('statutsOT'); return l.length ? l : STATUTS_OT_DEFAUT; };
  const estAnnulationOt = (s) => !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || '')));

  // ----- Portée ------------------------------------------------------------------------------
  function getVisible(req, id) {
    const p = db.get(ENTITE, id);
    if (!p || !ctx.canSee(req, p)) throw new HttpError(404, 'Plan préventif introuvable');
    return p;
  }
  function equipementVisible(req, e) {
    if (!req || !req.perms) return true;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli sur la portée standard */ } }
    return ctx.canSee(req, e);
  }
  /**
   * Un utilisateur limité à ses sites / secteurs ne rattache un plan qu'à un secteur qu'il peut modifier (même règle
   * que les équipements : toute portée autre que « tous » ; en portée « perso » sans secteur, seuls les sites
   * accessibles en lecture seule sont refusés). Appliquée à la création et au changement de secteur d'un plan.
   */
  function verifierPorteeSecteur(req, secteurId) {
    if (!req || !req.perms || req.perms.portee === 'tous' || secteurId == null) return;
    const sid = Number(secteurId);
    const lectureSeule = (req.perms.secteurIdsLecture || []).includes(sid);
    const modifiables = req.perms.secteurIds || [];
    if (req.perms.portee === 'perso' && !modifiables.length) {
      if (lectureSeule) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : impossible d\'y gérer un plan préventif');
      return;
    }
    if (!modifiables.includes(sid)) {
      throw new HttpError(403, lectureSeule ? 'Ce site est accessible en lecture seule pour vous : impossible d\'y gérer un plan préventif' : 'Ce secteur est hors de votre périmètre : vous ne pouvez gérer que les plans préventifs de vos secteurs');
    }
  }

  // ----- Validation des entrées --------------------------------------------------------------
  function texte(v, label, { requis = false, min = 0, max = 1000 } = {}) {
    if (v != null && typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${label} : valeur invalide`);
    const s = v == null ? '' : String(v).trim();
    if (requis && !s) throw new HttpError(400, `${label} est obligatoire`);
    if (s && s.length < min) throw new HttpError(400, `${label} doit contenir au moins ${min} caractères`);
    if (s.length > max) throw new HttpError(400, `${label} ne doit pas dépasser ${max} caractères`);
    return s;
  }
  function nombre(v, label, { requis = false, min = null, max = null } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis) throw new HttpError(400, `${label} est obligatoire`);
      return null;
    }
    if (typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) throw new HttpError(400, `${label} doit être un nombre`);
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} doit être un nombre`);
    if (min != null && n < min) throw new HttpError(400, `${label} doit être supérieur ou égal à ${min}`);
    if (max != null && n > max) throw new HttpError(400, `${label} ne doit pas dépasser ${formatNombre(max)}`);
    return n;
  }
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function lireDate(v, label) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new HttpError(400, `${label} invalide (format attendu AAAA-MM-JJ)`);
    const s = v.trim();
    const j = RE_DATE.test(s) ? s : (/^\d{4}-\d{2}-\d{2}T/.test(s) ? jourDe(s) : null);
    if (!j || !estDateValide(j)) throw new HttpError(400, `${label} invalide (format attendu AAAA-MM-JJ)`);
    return j;
  }
  function codeListe(nomListe, code, label, defaut) {
    if (code === undefined || code === null || code === '') return defaut === undefined ? null : defaut;
    if (typeof code !== 'string') throw new HttpError(400, `${label} invalide`);
    const l = ctx.liste(nomListe);
    if (!l.length) return code;
    if (!l.some((x) => x.code === code)) throw new HttpError(400, `${label} inconnu(e) : « ${code} »`);
    return code;
  }
  function codeParDefaut(nomListe, voulu) {
    const l = ctx.liste(nomListe);
    if (!l.length) return voulu;
    return l.some((x) => x.code === voulu) ? voulu : l[0].code;
  }
  function booleen(v, label) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    throw new HttpError(400, `${label} doit valoir vrai ou faux`);
  }
  function lirePeriodicite(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'La périodicité est obligatoire (type et valeur)');
    const type = typeof p.type === 'string' ? p.type.trim() : '';
    if (!TYPES_PERIODICITE[type]) throw new HttpError(400, 'Type de périodicité invalide : jours, semaines, mois ou compteur');
    const v = nombre(p.valeur, 'La valeur de la périodicité', { requis: true });
    if (!(v > 0)) throw new HttpError(400, 'La valeur de la périodicité doit être strictement positive');
    if (type !== 'compteur' && !Number.isInteger(v)) throw new HttpError(400, 'La périodicité doit être un nombre entier de jours, de semaines ou de mois');
    if (v > MAX_PERIODICITE[type]) throw new HttpError(400, `La périodicité ne doit pas dépasser ${formatNombre(MAX_PERIODICITE[type])} ${type === 'compteur' ? 'unités' : TYPES_PERIODICITE[type].toLowerCase()}`);
    return { type, valeur: type === 'compteur' ? arrondi(v, 3) : v };
  }
  function lireGamme(liste) {
    if (liste === undefined || liste === null) return [];
    if (!Array.isArray(liste)) throw new HttpError(400, 'La gamme doit être une liste de tâches');
    if (liste.length > MAX_GAMME) throw new HttpError(400, `Trop de tâches dans la gamme (${MAX_GAMME} au maximum)`);
    const items = liste.map((t, i) => {
      const src = typeof t === 'string' ? { libelle: t } : objet(t);
      const libelle = texte(src.libelle, `Le libellé de la tâche n°${i + 1}`, { requis: true, max: 300 });
      const duree = nombre(src.duree, `La durée de la tâche n°${i + 1}`, { min: 0, max: 1000 });
      const ordre = nombreOuNull(src.ordre);
      return { ordre: ordre == null ? i + 1 : ordre, libelle, duree: duree == null ? null : arrondi(duree, 2), i };
    });
    items.sort((a, b) => (a.ordre - b.ordre) || (a.i - b.i));
    return items.map((t, i) => ({ ordre: i + 1, libelle: t.libelle, duree: t.duree }));
  }
  function lirePieces(liste, existant) {
    if (liste === undefined || liste === null) return [];
    if (!Array.isArray(liste)) throw new HttpError(400, 'Les pièces nécessaires doivent être une liste');
    if (liste.length > MAX_PIECES) throw new HttpError(400, `Trop de pièces (${MAX_PIECES} au maximum)`);
    const connues = new Set(((existant && existant.pieces) || []).map((p) => Number(p.articleId)));
    const parArticle = new Map();
    liste.forEach((p, i) => {
      const src = objet(p);
      const id = idRef(src.articleId, `Pièce n°${i + 1} : article`);
      if (id == null) throw new HttpError(400, `Pièce n°${i + 1} : l'article est obligatoire`);
      if (!db.get('articles', id) && !connues.has(id)) throw new HttpError(400, `Pièce n°${i + 1} : article introuvable`);
      const q = nombre(src.quantite, `Pièce n°${i + 1} : la quantité`, { requis: true, max: 1e6 });
      if (!(q > 0)) throw new HttpError(400, `Pièce n°${i + 1} : la quantité doit être strictement positive`);
      parArticle.set(id, arrondi((parArticle.get(id) || 0) + q, 3));
    });
    return Array.from(parArticle, ([articleId, quantite]) => ({ articleId, quantite }));
  }
  function verifierTechnicien(id) {
    const u = db.get('users', id);
    if (!u || u.actif === false) throw new HttpError(400, 'Technicien responsable : utilisateur introuvable ou désactivé');
    const p = perms.effectivePermissions(db, u, null, db.getConfig());
    if (!perms.can(p, 'ot', 'voir')) throw new HttpError(400, `${ctx.nomUser(u.id)} n'a pas accès au module Ordres de travail : il ne peut pas être responsable d'un plan préventif`);
    return u;
  }
  const sommeGamme = (g) => arrondi((g || []).reduce((s, t) => s + (Number(t.duree) || 0), 0));
  const estValeurDeType = (type, v) => (type === 'compteur' ? nombreOuNull(v) != null : !!jourDe(v));

  /**
   * Lecture et validation complète d'un plan (création : existant = null ; modification : champs
   * absents repris de l'existant). Retourne { data, eq }.
   */
  function lirePlan(req, body, existant) {
    body = objet(body);
    const has = (k) => body[k] !== undefined;
    const val = (k, def) => (has(k) ? body[k] : (existant ? existant[k] : def));
    const out = {};
    out.nom = texte(val('nom', ''), 'Le nom du plan', { requis: true, min: 3, max: 200 });
    out.description = texte(val('description', ''), 'La description', { max: 5000 });
    out.typeCode = codeListe('typesIntervention', val('typeCode', null), 'Type d\'intervention', existant && existant.typeCode ? existant.typeCode : codeParDefaut('typesIntervention', 'preventif'));
    out.prioriteCode = codeListe('priorites', val('prioriteCode', null), 'Priorité', existant && existant.prioriteCode ? existant.prioriteCode : codeParDefaut('priorites', 'normale'));

    // Équipement (le secteur en est repris) ou, à défaut, secteur
    const eqId = idRef(val('equipementId', null), 'Équipement');
    let eq = null;
    if (eqId != null) {
      eq = db.get('equipements', eqId);
      if (!eq || !equipementVisible(req, eq)) throw new HttpError(400, 'Équipement introuvable ou hors de votre périmètre');
      const change = !existant || Number(existant.equipementId) !== eqId;
      if (change && eq.actif === false) throw new HttpError(400, `L'équipement « ${eq.nom} » est inactif : impossible d'y rattacher un plan préventif`);
      out.equipementId = eqId;
      out.secteurId = eq.secteurId == null || eq.secteurId === '' ? null : Number(eq.secteurId);
    } else {
      out.equipementId = null;
      const sid = idRef(val('secteurId', null), 'Secteur');
      if (sid != null && !db.get('secteurs', sid)) throw new HttpError(400, 'Secteur introuvable');
      out.secteurId = sid;
    }
    if (!existant || Number(existant.secteurId) !== Number(out.secteurId) || (existant.secteurId == null) !== (out.secteurId == null)) verifierPorteeSecteur(req, out.secteurId);

    // Périodicité
    out.periodicite = lirePeriodicite(val('periodicite', null));
    const type = out.periodicite.type;
    if (type === 'compteur' && !eq) throw new HttpError(400, 'Une périodicité sur compteur nécessite un équipement (son compteur sert de référence)');
    const lireEch = (v, label) => (type === 'compteur' ? nombre(v, label, { min: 0, max: 1e12 }) : lireDate(v, label));
    out.dateDebut = has('dateDebut') ? lireDate(body.dateDebut, 'La date de départ') : (existant ? existant.dateDebut || null : null);
    if (has('derniereExecution')) out.derniereExecution = lireEch(body.derniereExecution, type === 'compteur' ? 'La valeur de compteur de la dernière exécution' : 'La date de dernière exécution');
    else out.derniereExecution = existant && estValeurDeType(type, existant.derniereExecution) ? existant.derniereExecution : null;
    if (out.derniereExecution != null && type !== 'compteur' && out.derniereExecution > dateLocale()) throw new HttpError(400, 'La date de dernière exécution ne peut pas être dans le futur');
    if (has('prochaineEcheance')) out.prochaineEcheance = lireEch(body.prochaineEcheance, type === 'compteur' ? 'La valeur de compteur de la prochaine échéance' : 'La date de prochaine échéance');
    else out.prochaineEcheance = existant && estValeurDeType(type, existant.prochaineEcheance) ? existant.prochaineEcheance : null;

    // Gamme, durée, pièces
    out.gamme = has('gamme') ? lireGamme(body.gamme) : (existant ? existant.gamme || [] : []);
    const somme = sommeGamme(out.gamme);
    if (has('dureeEstimee')) {
      const d = nombre(body.dureeEstimee, 'La durée estimée', { min: 0, max: 10000 });
      out.dureeEstimee = d == null ? (somme > 0 ? somme : null) : arrondi(d);
    } else if (!existant) out.dureeEstimee = somme > 0 ? somme : null;
    else if (has('gamme') && (existant.dureeEstimee == null || Number(existant.dureeEstimee) === sommeGamme(existant.gamme))) out.dureeEstimee = somme > 0 ? somme : null;
    else out.dureeEstimee = existant.dureeEstimee == null ? null : existant.dureeEstimee;
    out.pieces = has('pieces') ? lirePieces(body.pieces, existant) : (existant ? existant.pieces || [] : []);

    // Technicien responsable (contrôlé seulement s'il change)
    const tid = idRef(val('technicienId', null), 'Technicien responsable');
    if (tid != null && !(existant && Number(existant.technicienId) === tid)) verifierTechnicien(tid);
    out.technicienId = tid;

    // Génération
    out.actif = has('actif') ? booleen(body.actif, 'Le champ « actif »') : (existant ? existant.actif !== false : true);
    if (has('genererJoursAvant')) {
      const g = nombre(body.genererJoursAvant, 'Le délai de génération (jours avant l\'échéance)', { min: 0, max: 365 });
      if (g != null && !Number.isInteger(g)) throw new HttpError(400, 'Le délai de génération doit être un nombre entier de jours');
      out.genererJoursAvant = g;
    } else out.genererJoursAvant = existant && existant.genererJoursAvant != null ? existant.genererJoursAvant : null;

    if (has('champs') || !existant) out.champs = ctx.champsPerso(ENTITE, Object.assign({}, existant ? existant.champs || {} : {}, objet(body.champs)));
    return { data: out, eq };
  }

  // ----- Calcul des échéances ----------------------------------------------------------------
  function compteurCourant(eq) { return eq && eq.compteur ? (nombreOuNull(eq.compteur.valeur) || 0) : 0; }
  /** Prochaine échéance = base + période (base : dernière exécution, date de départ / aujourd'hui, ou compteur courant). */
  function calculerProchaineEcheance(plan, base) {
    const p = plan.periodicite || {};
    if (p.type === 'compteur') {
      let b = nombreOuNull(base);
      if (b == null) b = nombreOuNull(plan.derniereExecution);
      if (b == null) b = compteurCourant(plan.equipementId != null ? db.get('equipements', plan.equipementId) : null);
      return arrondi(b + Number(p.valeur || 0), 3);
    }
    const b = jourDe(base) || jourDe(plan.derniereExecution) || jourDe(plan.dateDebut) || dateLocale();
    return ajouterPeriode(b, p);
  }

  /** Contexte de calcul partagé (évite de relire les collections pour chaque plan). */
  function contexte() {
    const liste = statutsOt();
    const finaux = new Set(liste.filter((s) => s.final).map((s) => s.code));
    const ouverts = new Map(); const nbOt = new Map();
    for (const o of db.list('ot', (x) => x.planPreventifId != null)) {
      const pid = Number(o.planPreventifId);
      nbOt.set(pid, (nbOt.get(pid) || 0) + 1);
      if (!finaux.has(o.statut)) {
        const cur = ouverts.get(pid);
        if (!cur || String(o.createdAt || '') > String(cur.createdAt || '')) ouverts.set(pid, o);
      }
    }
    return {
      aujourdhui: dateLocale(), horizon: horizonDefaut(), liste, finaux, ouverts, nbOt,
      equipements: new Map(db.list('equipements').map((e) => [e.id, e])),
      secteurs: new Map(db.list('secteurs').map((s) => [s.id, s])),
    };
  }
  function cheminSecteur(c, id) {
    const parts = []; let cur = id == null ? null : c.secteurs.get(Number(id)); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? c.secteurs.get(Number(cur.parentId)) : null; }
    return parts.join(' › ');
  }
  function horizonPlan(plan, c, force) {
    if (force != null) return force;
    const g = nombreOuNull(plan.genererJoursAvant);
    return g != null && g >= 0 ? g : c.horizon;
  }

  /** Analyse d'un plan : échéance effective, état, jours restants, reste compteur, date prévisionnelle. */
  function analyser(plan, eq, c, horizonForce) {
    c = c || contexte();
    if (eq === undefined) eq = plan.equipementId != null ? c.equipements.get(Number(plan.equipementId)) || null : null;
    const p = plan.periodicite || {};
    const horizon = horizonPlan(plan, c, horizonForce);
    const r = { etat: 'a_jour', echeance: null, echeanceDate: null, estimee: false, joursRestants: null, resteCompteur: null, compteurActuel: null, unite: null, rythmeJour: null, horizon, datePrevue: c.aujourdhui };
    if (p.type === 'compteur') {
      const cpt = eq && eq.compteur ? eq.compteur : null;
      r.unite = cpt ? (cpt.unite || 'heures') : null;
      r.compteurActuel = cpt ? (nombreOuNull(cpt.valeur) || 0) : null;
      let ech = nombreOuNull(plan.prochaineEcheance);
      if (ech == null) ech = calculerProchaineEcheance(plan, null);
      r.echeance = ech;
      if (r.compteurActuel != null) {
        r.resteCompteur = arrondi(ech - r.compteurActuel, 3);
        const rythme = rythmeCompteur(eq);
        if (rythme) {
          r.rythmeJour = arrondi(rythme.parJour, 3);
          r.echeanceDate = estimerDate(rythme, ech);
          r.estimee = true;
          if (r.resteCompteur > 0 && r.echeanceDate < c.aujourdhui) r.echeanceDate = c.aujourdhui;
          r.joursRestants = joursEntre(c.aujourdhui, r.echeanceDate);
        }
        if (r.resteCompteur <= 0) r.etat = 'en_retard';
        else if ((r.joursRestants != null && r.joursRestants <= horizon) || r.resteCompteur <= 0.1 * Number(p.valeur || 0)) r.etat = 'proche';
        r.datePrevue = r.echeanceDate && r.echeanceDate > c.aujourdhui ? r.echeanceDate : c.aujourdhui;
      }
    } else {
      let ech = jourDe(plan.prochaineEcheance);
      if (!ech) ech = calculerProchaineEcheance(plan, null);
      r.echeance = ech; r.echeanceDate = ech;
      r.joursRestants = joursEntre(c.aujourdhui, ech);
      r.etat = r.joursRestants < 0 ? 'en_retard' : (r.joursRestants <= horizon ? 'proche' : 'a_jour');
      r.datePrevue = ech;
    }
    if (plan.actif === false) r.etat = 'inactif';
    return r;
  }

  /** Vue enrichie d'un plan pour les listes. */
  function resume(plan, c) {
    c = c || contexte();
    const eq = plan.equipementId != null ? c.equipements.get(Number(plan.equipementId)) || null : null;
    const a = analyser(plan, eq, c);
    const ouvert = c.ouverts.get(plan.id) || null;
    const st = ouvert ? c.liste.find((s) => s.code === ouvert.statut) : null;
    const secteur = plan.secteurId != null ? c.secteurs.get(Number(plan.secteurId)) : null;
    return Object.assign({}, plan, {
      equipement: eq ? { id: eq.id, numero: eq.numero || '', nom: eq.nom, secteurId: eq.secteurId == null ? null : eq.secteurId, localisation: eq.localisation || '', compteur: eq.compteur || null, actif: eq.actif !== false } : null,
      equipementNom: eq ? eq.nom : '', equipementNumero: eq ? eq.numero || '' : '',
      secteurNom: secteur ? secteur.nom : '', secteurChemin: cheminSecteur(c, plan.secteurId),
      technicienNom: ctx.nomUser(plan.technicienId), createdByNom: ctx.nomUser(plan.createdBy),
      periodiciteLibelle: periodiciteLibelle(plan.periodicite, a.unite),
      etat: a.etat, etatLibelle: ETATS[a.etat],
      echeance: a.echeance, echeanceDate: a.echeanceDate, echeanceEstimee: a.estimee, joursRestants: a.joursRestants,
      resteCompteur: a.resteCompteur, compteurActuel: a.compteurActuel, uniteCompteur: a.unite, rythmeJour: a.rythmeJour, horizonJours: a.horizon,
      otOuvertId: ouvert ? ouvert.id : null, otOuvertNumero: ouvert ? ouvert.numero || '' : '', otOuvertStatut: ouvert ? ouvert.statut : null,
      otOuvertStatutLibelle: st ? st.label : (ouvert ? String(ouvert.statut || '') : ''), otOuvertDatePrevue: ouvert ? ouvert.datePrevue || null : null,
      nbOt: c.nbOt.get(plan.id) || 0, nbTaches: (plan.gamme || []).length, dureeGamme: sommeGamme(plan.gamme),
    });
  }

  /** OT annulé pour l'échéance courante (empêche la régénération automatique en boucle). */
  function otAnnulePourEcheance(plan, echeance, c) {
    if (echeance == null) return null;
    const annulations = new Set(c.liste.filter(estAnnulationOt).map((s) => s.code));
    if (!annulations.size) return null;
    return db.findOne('ot', (o) => Number(o.planPreventifId) === plan.id && annulations.has(o.statut) && o.echeancePreventif != null && String(o.echeancePreventif) === String(echeance)) || null;
  }

  /** Échéances (occurrences) à venir, avec projection des périodes suivantes. */
  function occurrences(plans, { jours = 30, projection = true, nonDatees = false, c } = {}) {
    c = c || contexte();
    const fin = ajouterJours(c.aujourdhui, jours);
    const out = [];
    for (const plan of plans) {
      if (plan.actif === false) continue;
      const eq = plan.equipementId != null ? c.equipements.get(Number(plan.equipementId)) || null : null;
      const a = analyser(plan, eq, c);
      const p = plan.periodicite || {};
      const ouvert = c.ouverts.get(plan.id) || null;
      const base = {
        planId: plan.id, numero: plan.numero, nom: plan.nom, typeCode: plan.typeCode, prioriteCode: plan.prioriteCode,
        equipementId: plan.equipementId, equipementNom: eq ? eq.nom : '', equipementNumero: eq ? eq.numero || '' : '',
        secteurId: plan.secteurId, technicienId: plan.technicienId, technicienNom: ctx.nomUser(plan.technicienId),
        dureeEstimee: plan.dureeEstimee == null ? null : plan.dureeEstimee, periodicite: p, periodiciteLibelle: periodiciteLibelle(p, a.unite),
        typePeriodicite: p.type === 'compteur' ? 'compteur' : 'date', uniteCompteur: a.unite,
      };
      const pousser = (k, date, valeur, estimee) => {
        const etat = k === 0 ? a.etat : (date && joursEntre(c.aujourdhui, date) <= a.horizon ? 'proche' : 'a_jour');
        out.push(Object.assign({}, base, {
          occurrence: k, date: date || null, valeurCompteur: valeur, estimee: !!estimee, etat, etatLibelle: ETATS[etat],
          enRetard: k === 0 && a.etat === 'en_retard', joursRestants: date ? joursEntre(c.aujourdhui, date) : null,
          otOuvertId: k === 0 && ouvert ? ouvert.id : null, otOuvertNumero: k === 0 && ouvert ? ouvert.numero || '' : '',
          otOuvertStatut: k === 0 && ouvert ? ouvert.statut : null,
        }));
      };
      // Les occurrences suivantes (k ≥ 1) partent de la réalisation attendue : une échéance dépassée sera faite au
      // plus tôt aujourd'hui (ou au compteur actuel), jamais à sa date passée. Aucune projection n'est donc datée
      // dans le passé, ni comptée parmi les retards ou dans la charge.
      if (p.type === 'compteur') {
        const rythme = rythmeCompteur(eq);
        if (!rythme) {
          if (a.etat === 'en_retard') pousser(0, c.aujourdhui, a.echeance, false);
          else if (nonDatees || a.etat === 'proche') pousser(0, null, a.echeance, false);
          continue;
        }
        const baseValeur = a.compteurActuel != null && Number(a.echeance) < a.compteurActuel ? a.compteurActuel : Number(a.echeance);
        for (let k = 0; k < MAX_OCCURRENCES; k++) {
          const valeur = arrondi(k === 0 ? Number(a.echeance) : baseValeur + k * Number(p.valeur || 0), 3);
          let date = k === 0 ? a.echeanceDate : estimerDate(rythme, valeur);
          if (k === 0 && a.etat === 'en_retard' && (!date || date > c.aujourdhui)) date = c.aujourdhui;
          if (k > 0 && date < c.aujourdhui) date = c.aujourdhui;
          if (date > fin) break;
          pousser(k, date, valeur, true);
          if (!projection) break;
        }
      } else {
        const baseDate = a.echeance < c.aujourdhui ? c.aujourdhui : a.echeance;
        for (let k = 0; k < MAX_OCCURRENCES; k++) {
          const date = k === 0 ? a.echeance : ajouterPeriode(baseDate, p, k);
          if (date > fin) break;
          pousser(k, date, null, false);
          if (!projection) break;
        }
      }
    }
    return out.sort((x, y) => (x.date == null ? 1 : 0) - (y.date == null ? 1 : 0) || String(x.date || '').localeCompare(String(y.date || '')) || String(x.numero || '').localeCompare(String(y.numero || ''), 'fr', { numeric: true }) || x.occurrence - y.occurrence);
  }

  // ----- Filtres ----------------------------------------------------------------------------
  function filtrer(rows, q) {
    q = q || {};
    if (q.secteurId) {
      if (q.secteurId === 'aucun') rows = rows.filter((p) => p.secteurId == null);
      else { const ids = perms.secteursDescendants(db, [Number(q.secteurId)]); rows = rows.filter((p) => p.secteurId != null && ids.includes(Number(p.secteurId))); }
    }
    if (q.equipementId) {
      let ids = [Number(q.equipementId)];
      const sEq = ctx.services.equipements;
      if ((q.inclureSousEquipements === '1' || q.inclureSousEquipements === 'true') && sEq && typeof sEq.descendants === 'function') ids = ids.concat(sEq.descendants(Number(q.equipementId)) || []);
      rows = rows.filter((p) => ids.includes(Number(p.equipementId)));
    }
    if (q.technicienId) rows = rows.filter((p) => (q.technicienId === 'aucun' ? p.technicienId == null : Number(p.technicienId) === Number(q.technicienId)));
    if (q.typeCode) rows = rows.filter((p) => p.typeCode === q.typeCode);
    if (q.typePeriodicite) rows = rows.filter((p) => (q.typePeriodicite === 'date' ? (p.periodicite || {}).type !== 'compteur' : (p.periodicite || {}).type === q.typePeriodicite));
    if (q.actif === '1' || q.actif === 'true') rows = rows.filter((p) => p.actif !== false);
    else if (q.actif === '0' || q.actif === 'false') rows = rows.filter((p) => p.actif === false);
    if (q.etat) { const etats = new Set(String(q.etat).split(',').map((x) => x.trim()).filter(Boolean)); rows = rows.filter((p) => etats.has(p.etat)); }
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase().trim();
      rows = rows.filter((p) => [p.numero, p.nom, p.description, p.equipementNom, p.equipementNumero, p.technicienNom, p.secteurChemin, p.periodiciteLibelle, (p.gamme || []).map((t) => t.libelle).join(' ')].some((v) => String(v || '').toLowerCase().includes(s)));
    }
    return rows;
  }

  // ----- Génération des ordres de travail ------------------------------------------------------
  function numeroUnique(cle, gabarit, collection, repli) {
    for (let i = 0; i < 1000; i++) {
      const n = db.nextNumber(cle, gabarit);
      if (!db.findOne(collection, (x) => x.numero === n)) return n;
    }
    return `${repli}-${Date.now()}`;
  }
  function userActif(id) { const u = id == null ? null : db.get('users', id); return u && u.actif !== false ? u : null; }

  /** Création autonome d'un OT (module Ordres de travail absent), conforme au modèle d'ARCHITECTURE.md. */
  function insererOt(plan, eq, { datePrevue, createdBy, req, commentaire }) {
    const liste = statutsOt();
    const statut = (liste.find((s) => !s.final) || { code: 'nouveau' }).code;
    const gabarit = (ctx.config().numerotation || {}).ot || 'OT-{annee}-{num:4}';
    const technicienId = userActif(plan.technicienId) ? Number(plan.technicienId) : null;
    const taches = (plan.gamme || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0))
      .map((g, i) => ({ ordre: i + 1, libelle: g.libelle, duree: g.duree == null ? null : g.duree, fait: false, faitPar: null, dateFait: null }));
    const piecesPrevues = (plan.pieces || []).map((x) => { const a = db.get('articles', x.articleId); return { articleId: Number(x.articleId), code: a ? a.code || '' : '', designation: a ? a.designation || '' : '', quantite: Number(x.quantite) || 0 }; });
    const record = {
      numero: numeroUnique('ot', gabarit, 'ot', 'OT'), titre: plan.nom, description: plan.description || '',
      typeCode: plan.typeCode || codeParDefaut('typesIntervention', 'preventif'), prioriteCode: plan.prioriteCode || codeParDefaut('priorites', 'normale'), statut,
      equipementId: eq ? eq.id : (plan.equipementId == null ? null : plan.equipementId), secteurId: plan.secteurId == null ? null : plan.secteurId,
      demandeId: null, planPreventifId: plan.id, technicienId, techniciens: technicienId != null ? [technicienId] : [],
      datePrevue: datePrevue || null, dateDebut: null, dateFin: null, dureeEstimee: plan.dureeEstimee == null ? null : plan.dureeEstimee,
      tempsPasse: [], pieces: [], piecesPrevues, causeCode: null, rapport: '', commentaires: [], documents: [],
      coutPieces: 0, coutMainOeuvre: 0, coutExterne: 0, coutTotal: 0, fournisseurId: null, compteurReleve: null, taches,
      cloturePar: null, dateCloture: null, champs: {}, createdBy: createdBy == null ? null : createdBy,
      historique: [{ date: new Date().toISOString(), userId: req && req.user ? req.user.id : null, action: 'creation', libelle: 'Ordre de travail créé', statut, commentaire: commentaire || '' }],
    };
    const o = db.insert('ot', record);
    ctx.audit(req, 'creation', 'ot', o.id, `${refOt(o.numero)} : ${o.titre} (plan ${plan.numero})`);
    const acteur = req && req.user ? req.user.id : null;
    const cibles = technicienId != null ? [technicienId] : ctx.usersAvecDroit(MODULE, 'modifier', (u, p) => p.portee === 'tous' || o.secteurId == null || p.secteurIds.includes(Number(o.secteurId))).map((u) => u.id);
    const notifies = cibles.filter((id) => id !== acteur);
    if (notifies.length) ctx.notify(notifies, { titre: `${technicienId != null ? 'Nouvel ordre de travail' : 'OT préventif à affecter'} : ${o.numero}`, message: `${o.titre}${o.datePrevue ? ' — prévu le ' + formatDateFr(o.datePrevue) : ''}`, lien: `#/ot/${o.id}`, type: 'info' });
    ctx.emit('ot:cree', Object.assign({}, o, { ot: o, source: 'plan' }));
    return o;
  }

  /** Crée l'OT d'un plan (via le module OT s'il est présent, sinon en autonome) et trace la génération. */
  function creerOt(plan, eq, a, { req, datePrevue, auto }) {
    const sOt = ctx.services.ot;
    const echeance = a.echeance;
    const lib = libelleEcheance(plan.periodicite, echeance, a.unite);
    const commentaire = `Généré ${auto ? 'automatiquement ' : ''}depuis le plan préventif ${plan.numero} (${lib})`;
    const createdBy = req && req.user ? req.user.id : null;
    let ot = null;
    if (sOt && typeof sOt.creerDepuisPlan === 'function') {
      ot = sOt.creerDepuisPlan(plan, req || null, { datePrevue, echeance, commentaire, createdBy, source: 'plan' });
    } else if (sOt && typeof sOt.creer === 'function') {
      const body = { planPreventifId: plan.id, datePrevue };
      const opts = { systeme: true, souple: true, source: 'plan', createdBy, commentaire };
      if (plan.technicienId != null && !userActif(plan.technicienId)) body.technicienId = null;
      try { ot = sOt.creer(body, req || null, opts); } catch (e) {
        // Technicien du plan sans accès aux OT : création sans affectation plutôt qu'un échec
        if (plan.technicienId != null && body.technicienId !== null && e && e.status === 400) ot = sOt.creer(Object.assign({}, body, { technicienId: null }), req || null, opts);
        else throw e;
      }
    } else {
      ot = insererOt(plan, eq, { datePrevue, createdBy, req, commentaire });
    }
    if (!ot || ot.id == null) throw new HttpError(500, 'La création de l\'ordre de travail a échoué');
    const patch = { echeancePreventif: echeance };
    if (ot.planPreventifId == null) patch.planPreventifId = plan.id;
    if (!ot.datePrevue && datePrevue) patch.datePrevue = datePrevue;
    ot = db.update('ot', ot.id, patch) || ot;
    const maj = db.update(ENTITE, plan.id, { derniereGeneration: new Date().toISOString(), dernierOtGenereId: ot.id });
    ctx.audit(req, 'generation', ENTITE, plan.id, `Plan ${plan.numero} : ${refOt(ot.numero)} généré${auto ? ' automatiquement' : ''} (${lib})`);
    ctx.emit('preventif:genere', { plan: maj || plan, ot });
    return ot;
  }

  /**
   * Génération des OT. options : { req (portée + attribution), planIds, horizonJours (remplace l'horizon
   * des plans), force (ignore l'échéance : génération immédiate), datePrevue (avec force), auto }.
   * Idempotent : aucun OT n'est créé pour un plan qui a déjà un OT ouvert.
   */
  function genererInterne(options = {}) {
    const { req = null, planIds = null, horizonJours = null, force = false, datePrevue = null, auto = false } = options;
    const c = contexte();
    let plans = db.list(ENTITE, (p) => p.actif !== false);
    if (req && req.perms) plans = ctx.scope(req, plans);
    if (Array.isArray(planIds)) { const ids = new Set(planIds.map(Number)); plans = plans.filter((p) => ids.has(p.id)); }
    plans.sort(triNumero);
    const rapport = { generes: [], ignores: [], erreurs: [], ots: [] };
    for (const plan of plans) {
      const eq = plan.equipementId != null ? c.equipements.get(Number(plan.equipementId)) || null : null;
      const a = analyser(plan, eq, c, horizonJours);
      const ref = { planId: plan.id, planNumero: plan.numero, planNom: plan.nom };
      if (!force && a.etat !== 'en_retard' && a.etat !== 'proche') continue;
      const ouvert = c.ouverts.get(plan.id);
      if (ouvert) { rapport.ignores.push(Object.assign(ref, { otId: ouvert.id, motif: `Un ordre de travail est déjà ouvert pour ce plan : ${ouvert.numero}` })); continue; }
      if (plan.equipementId != null && !eq) { rapport.ignores.push(Object.assign(ref, { motif: 'L\'équipement du plan n\'existe plus' })); continue; }
      if (eq && eq.actif === false) { rapport.ignores.push(Object.assign(ref, { motif: `L'équipement « ${eq.nom} » est inactif` })); continue; }
      if (!force) {
        const annule = otAnnulePourEcheance(plan, a.echeance, c);
        if (annule) { rapport.ignores.push(Object.assign(ref, { otId: annule.id, motif: `L'ordre de travail ${annule.numero} généré pour cette échéance a été annulé : générez-le manuellement ou reportez l'échéance` })); continue; }
      }
      try {
        const ot = creerOt(plan, eq, a, { req, datePrevue: force ? (datePrevue || c.aujourdhui) : a.datePrevue, auto });
        c.ouverts.set(plan.id, ot);
        rapport.ots.push(ot);
        rapport.generes.push(Object.assign(ref, { otId: ot.id, otNumero: ot.numero, datePrevue: ot.datePrevue || null, echeance: a.echeance }));
      } catch (e) {
        rapport.erreurs.push(Object.assign(ref, { message: (e && e.message) || String(e) }));
        ctx.log('Préventif : génération impossible pour le plan', plan.numero, e && e.message);
      }
    }
    if (auto && rapport.ots.length) {
      const cibles = ctx.usersAvecDroit(MODULE, 'modifier').map((u) => u.id);
      if (cibles.length) ctx.notify(cibles, { titre: `Maintenance préventive : ${rapport.ots.length} OT généré${rapport.ots.length > 1 ? 's' : ''}`, message: rapport.generes.map((g) => `${g.otNumero} (${g.planNom})`).join(', ').slice(0, 400), lien: '#/preventif', type: 'info' });
    }
    return rapport;
  }

  let generationEnCours = false;
  /** Génération automatique (minuteur, consultation) : silencieuse, sans réentrance. */
  function genererAuto() {
    if (generationEnCours || !cfgPrev().genererAuto) return null;
    generationEnCours = true;
    try { return genererInterne({ auto: true }); } catch (e) { ctx.log('Préventif : erreur de génération automatique', e && e.message); return null; } finally { generationEnCours = false; }
  }

  // ----- Réalisation (écoute de 'ot:termine', 'ot:statut' et 'ot:supprime') -------------------------
  /** Dernière exécution et prochaine échéance induites par un OT terminé ; null si cette réalisation est antérieure à la dernière connue. */
  function calculRealisation(plan, o) {
    const p = plan.periodicite || {};
    const dateReal = jourDe(o.dateFin) || jourDe(o.dateCloture) || dateLocale();
    const patch = { derniereExecutionDate: dateReal };
    if (p.type === 'compteur') {
      const eq = plan.equipementId != null ? db.get('equipements', plan.equipementId) : null;
      let valeur = nombreOuNull(o.compteurReleve);
      const courant = eq && eq.compteur ? nombreOuNull(eq.compteur.valeur) : null;
      if (valeur == null) valeur = courant;
      else if (courant != null && valeur > courant) valeur = courant; // relevé borné au compteur courant de l'équipement
      const ancienne = nombreOuNull(plan.derniereExecution);
      if (valeur != null && ancienne != null && valeur < ancienne) return null; // réalisation antérieure à la dernière connue
      if (valeur != null) { patch.derniereExecution = valeur; patch.prochaineEcheance = arrondi(valeur + Number(p.valeur || 0), 3); } else {
        const ech = nombreOuNull(plan.prochaineEcheance);
        if (ech != null) patch.prochaineEcheance = arrondi(ech + Number(p.valeur || 0), 3);
      }
    } else {
      const ancienne = jourDe(plan.derniereExecution);
      if (ancienne && dateReal < ancienne) return null;
      patch.derniereExecution = dateReal;
      patch.prochaineEcheance = ajouterPeriode(dateReal, p);
    }
    return patch;
  }
  /** État du plan susceptible d'être rétabli si la réalisation est remise en cause. */
  const etatRealisation = (src) => ({
    derniereExecution: src.derniereExecution == null ? null : src.derniereExecution, derniereExecutionDate: src.derniereExecutionDate || null,
    prochaineEcheance: src.prochaineEcheance == null ? null : src.prochaineEcheance, dernierOtId: src.dernierOtId == null ? null : src.dernierOtId,
  });
  function uniteDe(plan) {
    if ((plan.periodicite || {}).type !== 'compteur') return null;
    const eq = plan.equipementId != null ? db.get('equipements', plan.equipementId) : null;
    return eq && eq.compteur ? eq.compteur.unite : null;
  }

  function enregistrerRealisation(plan, o) {
    const p = plan.periodicite || {};
    const patch = calculRealisation(plan, o);
    if (!patch) return null;
    Object.assign(patch, { dernierOtId: o.id, realisationPrecedente: etatRealisation(plan) });
    const maj = db.update(ENTITE, plan.id, patch);
    const acteur = o.cloturePar != null ? db.get('users', o.cloturePar) : null;
    ctx.audit(acteur ? { user: acteur } : null, 'modification', ENTITE, plan.id, `Plan ${plan.numero} : réalisation enregistrée (${refOt(o.numero || o.id)}) — prochaine ${libelleEcheance(p, maj.prochaineEcheance, uniteDe(plan))}`);
    ctx.emit('preventif:realise', { plan: maj, ot: o });
    return maj;
  }

  /**
   * L'OT de la dernière réalisation n'est plus terminé (réouvert, annulé ou supprimé) : la maintenance n'est plus
   * considérée comme faite. Le plan retrouve l'état mémorisé avant cette réalisation ; à défaut (données plus
   * anciennes), il est recalculé depuis l'OT terminé précédent, sinon depuis l'échéance pour laquelle l'OT avait
   * été généré.
   */
  function annulerRealisation(plan, o, motif) {
    const p = plan.periodicite || {};
    const memo = plan.realisationPrecedente;
    let patch;
    if (memo && typeof memo === 'object' && !Array.isArray(memo)) {
      patch = Object.assign(etatRealisation(memo), { realisationPrecedente: null });
    } else {
      const termines = new Set(statutsOt().filter((s) => s.final && !estAnnulationOt(s)).map((s) => s.code));
      const finDe = (x) => jourDe(x.dateFin) || jourDe(x.dateCloture) || '';
      const precedent = db.list('ot', (x) => Number(x.planPreventifId) === plan.id && Number(x.id) !== Number(o.id) && termines.has(x.statut) && !!finDe(x))
        .sort((x, y) => finDe(y).localeCompare(finDe(x)) || y.id - x.id)[0] || null;
      if (precedent) {
        patch = Object.assign({ derniereExecution: null }, calculRealisation(Object.assign({}, plan, { derniereExecution: null }), precedent), { dernierOtId: precedent.id, realisationPrecedente: null });
      } else {
        const ech = p.type === 'compteur' ? nombreOuNull(o.echeancePreventif) : jourDe(o.echeancePreventif);
        const sansExecution = Object.assign({}, plan, { derniereExecution: null });
        patch = { derniereExecution: null, derniereExecutionDate: null, prochaineEcheance: ech != null ? ech : calculerProchaineEcheance(sansExecution, p.type === 'compteur' ? null : (jourDe(plan.dateDebut) || dateLocale())), dernierOtId: null, realisationPrecedente: null };
      }
    }
    const maj = db.update(ENTITE, plan.id, patch);
    ctx.audit(null, 'modification', ENTITE, plan.id, `Plan ${plan.numero} : réalisation annulée (${refOt(o.numero || o.id)} ${motif}) — prochaine ${libelleEcheance(p, maj.prochaineEcheance, uniteDe(plan))}`);
    ctx.emit('preventif:modifie', { plan: maj, ancien: plan, champsModifies: Object.keys(patch).filter((k) => k !== 'realisationPrecedente') });
    return maj;
  }

  const otDe = (data) => (data && data.ot && typeof data.ot === 'object' ? data.ot : data);
  /**
   * L'OT réalise-t-il bien le plan : même équipement que le plan (un OT déplacé sur un autre équipement n'enregistre
   * rien). Un événement sans champ equipementId (émetteur interne partiel) est accepté.
   */
  function otDuPlan(plan, o) {
    if (o.equipementId === undefined) return true;
    const eqPlan = plan.equipementId == null || plan.equipementId === '' ? null : Number(plan.equipementId);
    const eqOt = o.equipementId == null || o.equipementId === '' ? null : Number(o.equipementId);
    return eqPlan === eqOt;
  }
  ctx.on('ot:termine', (data) => {
    const o = otDe(data);
    if (!o || o.planPreventifId == null) return;
    const plan = db.get(ENTITE, o.planPreventifId);
    if (!plan || !otDuPlan(plan, o)) return;
    enregistrerRealisation(plan, o);
  });
  /** La réalisation est remise en cause si l'OT qui l'a enregistrée quitte un statut « terminé » ou disparaît. */
  function remettreEnCause(data, motif) {
    const o = otDe(data);
    if (!o || o.id == null || o.planPreventifId == null) return;
    const plan = db.get(ENTITE, o.planPreventifId);
    if (!plan || plan.dernierOtId == null || Number(plan.dernierOtId) !== Number(o.id)) return;
    annulerRealisation(plan, o, motif);
  }
  ctx.on('ot:statut', (data) => {
    const o = otDe(data);
    if (!o) return;
    const st = statutsOt().find((s) => s.code === o.statut);
    if (st && st.final && !estAnnulationOt(st)) return; // toujours terminé
    remettreEnCause(data, st && estAnnulationOt(st) ? 'annulé' : 'réouvert');
  });
  ctx.on('ot:supprime', (data) => remettreEnCause(data, 'supprimé'));

  // ----- Détail ------------------------------------------------------------------------------
  function resumeOt(o, c) {
    const st = c.liste.find((s) => s.code === o.statut);
    const tempsTotal = arrondi((o.tempsPasse || []).reduce((s, t) => s + (Number(t.heures) || 0), 0));
    const final = c.finaux.has(o.statut);
    return {
      id: o.id, numero: o.numero || '', titre: o.titre || '', statut: o.statut, statutLibelle: st ? st.label : String(o.statut || ''), final, annule: estAnnulationOt(st),
      datePrevue: o.datePrevue || null, dateDebut: o.dateDebut || null, dateFin: o.dateFin || null, dateCloture: o.dateCloture || null,
      technicienId: o.technicienId == null ? null : o.technicienId, technicienNom: ctx.nomUser(o.technicienId),
      tempsTotal, dureeEstimee: o.dureeEstimee == null ? null : o.dureeEstimee, echeancePreventif: o.echeancePreventif == null ? null : o.echeancePreventif,
      compteurReleve: o.compteurReleve == null ? null : o.compteurReleve, createdAt: o.createdAt, planPreventifId: o.planPreventifId,
      nbTaches: (o.taches || []).length, nbTachesFaites: (o.taches || []).filter((t) => t.fait).length,
      enRetard: !final && !!o.datePrevue && jourDe(o.datePrevue) < c.aujourdhui,
      ecartJours: final && !estAnnulationOt(st) && o.datePrevue && o.dateFin ? joursEntre(jourDe(o.datePrevue), jourDe(o.dateFin)) : null,
    };
  }
  function detail(req, plan) {
    const c = contexte();
    const base = resume(plan, c);
    const voirOt = perms.can(req.perms, 'ot', 'voir');
    const ots = db.list('ot', (o) => Number(o.planPreventifId) === plan.id).map((o) => resumeOt(o, c))
      .sort((a, b) => String(b.datePrevue || b.createdAt || '').localeCompare(String(a.datePrevue || a.createdAt || '')) || b.id - a.id);
    const termines = ots.filter((o) => o.final && !o.annule);
    const avecEcart = termines.filter((o) => o.ecartJours != null);
    const stats = {
      nbOt: ots.length, nbTermines: termines.length, nbAnnules: ots.filter((o) => o.annule).length, nbOuverts: ots.filter((o) => !o.final).length,
      tauxRespect: avecEcart.length ? Math.round((avecEcart.filter((o) => o.ecartJours <= 0).length / avecEcart.length) * 100) : null,
      ecartMoyenJours: avecEcart.length ? arrondi(avecEcart.reduce((s, o) => s + o.ecartJours, 0) / avecEcart.length, 1) : null,
      tempsMoyen: termines.length ? arrondi(termines.reduce((s, o) => s + o.tempsTotal, 0) / termines.length) : null,
    };
    const articles = new Map(db.list('articles').map((a) => [a.id, a]));
    const pieces = (plan.pieces || []).map((p) => {
      const a = articles.get(Number(p.articleId));
      return { articleId: Number(p.articleId), quantite: p.quantite, code: a ? a.code || '' : '', designation: a ? a.designation || '' : `Article #${p.articleId} (introuvable)`, uniteCode: a ? a.uniteCode || null : null, disponible: a ? Number(a.quantite) || 0 : null, prixUnitaire: a ? Number(a.prixUnitaire) || 0 : null, introuvable: !a };
    });
    const annule = base.otOuvertId == null ? otAnnulePourEcheance(plan, base.echeance, c) : null;
    const eq = base.equipement;
    const prochaines = occurrences([plan], { jours: JOURS_MAX_ECHEANCIER, projection: true, nonDatees: true, c }).slice(0, 6)
      .map((x) => ({ occurrence: x.occurrence, date: x.date, valeurCompteur: x.valeurCompteur, estimee: x.estimee, etat: x.etat }));
    return Object.assign(base, {
      gamme: (plan.gamme || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)),
      pieces,
      historique: voirOt ? ots : [], historiqueVisible: voirOt, stats,
      prochainesEcheances: prochaines,
      otAnnule: annule ? { id: annule.id, numero: annule.numero || '' } : null,
      actions: {
        modifier: can(req, 'modifier'), supprimer: can(req, 'supprimer'), dupliquer: can(req, 'creer'), exporter: can(req, 'exporter'),
        generer: can(req, 'modifier') && plan.actif !== false && base.otOuvertId == null && !(eq && eq.actif === false) && !(plan.equipementId != null && !eq),
      },
    });
  }

  // ----- Routes : consultation -------------------------------------------------------------------
  router.get('/api/preventif', async (req) => {
    genererAuto();
    const c = contexte();
    const rows = ctx.scope(req, db.list(ENTITE)).map((p) => resume(p, c));
    return filtrer(rows, req.query).sort(triNumero);
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/preventif-compteurs', async (req) => {
    const c = contexte();
    const plans = ctx.scope(req, db.list(ENTITE));
    const rows = plans.map((p) => resume(p, c));
    const actifs = rows.filter((p) => p.actif !== false);
    const dans30 = ajouterJours(c.aujourdhui, 30);
    const occ30 = occurrences(plans, { jours: 30, projection: true, c });
    return {
      total: rows.length, actifs: actifs.length, inactifs: rows.length - actifs.length,
      enRetard: actifs.filter((p) => p.etat === 'en_retard').length, proches: actifs.filter((p) => p.etat === 'proche').length, aJour: actifs.filter((p) => p.etat === 'a_jour').length,
      aVenir30: actifs.filter((p) => p.etat !== 'en_retard' && p.echeanceDate && p.echeanceDate >= c.aujourdhui && p.echeanceDate <= dans30).length,
      otOuverts: actifs.filter((p) => p.otOuvertId != null).length,
      sansOtEnRetard: actifs.filter((p) => p.etat === 'en_retard' && p.otOuvertId == null).length,
      chargeHeures30: arrondi(occ30.reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0)),
      horizonJours: c.horizon, genererAuto: !!cfgPrev().genererAuto,
    };
  }, { perm: [MODULE, 'voir'] });

  /** Échéances à venir (planning, tableau de bord, échéancier). ?jours=30&projection=0|1&nonDatees=1 */
  router.get('/api/preventif-echeances', async (req) => {
    const q = req.query || {};
    let jours = q.jours === undefined || q.jours === '' ? 30 : Number(q.jours);
    if (!Number.isInteger(jours) || jours < 0) throw new HttpError(400, 'Le nombre de jours doit être un entier positif');
    jours = Math.min(jours, JOURS_MAX_ECHEANCIER);
    const c = contexte();
    const plans = filtrer(ctx.scope(req, db.list(ENTITE, (p) => p.actif !== false)).map((p) => resume(p, c)), { secteurId: q.secteurId, equipementId: q.equipementId, technicienId: q.technicienId, typeCode: q.typeCode, recherche: q.recherche });
    const occ = occurrences(plans, { jours, projection: q.projection !== '0' && q.projection !== 'false', nonDatees: q.nonDatees === '1' || q.nonDatees === 'true', c });
    if (q.etat) { const etats = new Set(String(q.etat).split(',').map((x) => x.trim())); return occ.filter((o) => etats.has(o.etat)); }
    return occ;
  }, { perm: [MODULE, 'voir'] });

  /** Références pour le formulaire : équipements visibles, techniciens, articles, paramètres. */
  router.get('/api/preventif-references', async (req) => {
    const secteurs = new Map(db.list('secteurs').map((s) => [s.id, s]));
    const c = { secteurs };
    const equipements = db.list('equipements', (e) => e.actif !== false).filter((e) => equipementVisible(req, e)).map((e) => {
      const parent = e.parentId != null ? db.get('equipements', e.parentId) : null;
      return { id: e.id, numero: e.numero || '', nom: e.nom, secteurId: e.secteurId == null ? null : e.secteurId, secteurChemin: cheminSecteur(c, e.secteurId), parentNom: parent ? parent.nom : '', compteur: e.compteur || null, typeCode: e.typeCode || null };
    }).sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'));
    const config = db.getConfig();
    const liste = statutsOt();
    const finaux = new Set(liste.filter((s) => s.final).map((s) => s.code));
    const ouverts = db.list('ot', (o) => !finaux.has(o.statut));
    const techniciens = db.list('users', (u) => u.actif !== false).map((u) => {
      const p = perms.effectivePermissions(db, u, null, config);
      if (!perms.can(p, 'ot', 'voir')) return null;
      return { id: u.id, nomComplet: `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login, fonction: u.fonction || '', secteurIds: u.secteurIds || [], charge: ouverts.filter((o) => Number(o.technicienId) === u.id || (o.techniciens || []).map(Number).includes(u.id)).length, nbPlans: db.count(ENTITE, (x) => Number(x.technicienId) === u.id && x.actif !== false) };
    }).filter(Boolean).sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, 'fr'));
    const articles = ctx.scope(req, db.list('articles', (a) => a.actif !== false)).map((a) => ({ id: a.id, code: a.code || '', designation: a.designation || '', quantite: Number(a.quantite) || 0, uniteCode: a.uniteCode || null, equipementIds: (a.equipementIds || []).map(Number) }))
      .sort((a, b) => a.designation.localeCompare(b.designation, 'fr'));
    return { equipements, techniciens, articles, stockDisponible: !!ctx.services.stock, horizonJours: horizonDefaut(), genererAuto: !!cfgPrev().genererAuto, typesPeriodicite: TYPES_PERIODICITE };
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/preventif-export', async (req, res) => {
    const c = contexte();
    const rows = filtrer(ctx.scope(req, db.list(ENTITE)).map((p) => resume(p, c)), req.query).sort(triNumero);
    const lib = (nomListe, code) => { const it = ctx.liste(nomListe).find((x) => x.code === code); return it ? it.label : (code || ''); };
    const articles = new Map(db.list('articles').map((a) => [a.id, a]));
    const valeurEch = (p, v) => (v == null || v === '' ? '' : ((p.periodicite || {}).type === 'compteur' ? `${formatNombre(v)} ${abregeUnite(p.uniteCompteur)}` : formatDateFr(v)));
    const nombreFr = (n) => (n == null || n === '' ? '' : String(arrondi(n)).replace('.', ','));
    const entetes = ['Numéro', 'Nom', 'Type', 'Priorité', 'Équipement (n°)', 'Équipement', 'Secteur', 'Périodicité', 'Dernière exécution', 'Prochaine échéance', 'Date estimée', 'État', 'Jours restants', 'Reste compteur', 'Technicien', 'Durée estimée (h)', 'Nb tâches', 'Gamme', 'Pièces nécessaires', 'OT ouvert', 'Nb OT', 'Délai de génération (j)', 'Actif', 'Créé le'];
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    for (const p of rows) {
      lignes.push([
        p.numero, p.nom, lib('typesIntervention', p.typeCode), lib('priorites', p.prioriteCode), p.equipementNumero, p.equipementNom, p.secteurChemin,
        p.periodiciteLibelle, valeurEch(p, p.derniereExecution), valeurEch(p, p.echeance), p.echeanceEstimee ? formatDateFr(p.echeanceDate) : '', p.etatLibelle,
        p.joursRestants == null ? '' : p.joursRestants, p.resteCompteur == null ? '' : nombreFr(p.resteCompteur), p.technicienNom, nombreFr(p.dureeEstimee), p.nbTaches,
        (p.gamme || []).map((t) => `${t.ordre}. ${t.libelle}${t.duree ? ` (${nombreFr(t.duree)} h)` : ''}`).join(' | '),
        (p.pieces || []).map((x) => { const a = articles.get(Number(x.articleId)); return `${a ? a.designation : '#' + x.articleId} × ${nombreFr(x.quantite)}`; }).join(' | '),
        p.otOuvertNumero, p.nbOt, p.genererJoursAvant == null ? '' : p.genererJoursAvant, p.actif === false ? 'Non' : 'Oui', formatDateFr(p.createdAt),
      ].map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, null, `Export CSV de ${rows.length} plan(s) préventif(s)`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="plans-preventifs-${dateLocale()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  router.get('/api/preventif/:id', async (req) => detail(req, getVisible(req, req.params.id)), { perm: [MODULE, 'voir'] });

  // ----- Routes : création / modification / suppression ---------------------------------------
  function notifierTechnicien(req, plan, ancienTechnicienId) {
    if (plan.technicienId == null || Number(plan.technicienId) === Number(ancienTechnicienId) || Number(plan.technicienId) === req.user.id || plan.actif === false) return;
    const a = analyser(plan);
    ctx.notify([plan.technicienId], { titre: `Plan préventif ${plan.numero} : vous en êtes responsable`, message: `${plan.nom} — ${periodiciteLibelle(plan.periodicite, a.unite)} ; prochaine ${libelleEcheance(plan.periodicite, a.echeance, a.unite)}`, lien: `#/preventif/${plan.id}`, type: 'info' });
  }

  router.post('/api/preventif', async (req) => {
    const body = objet(req.body);
    const { data } = lirePlan(req, body, null);
    if (data.prochaineEcheance == null) data.prochaineEcheance = calculerProchaineEcheance(data, data.derniereExecution != null ? data.derniereExecution : (data.periodicite.type === 'compteur' ? null : (data.dateDebut || dateLocale())));
    const gabarit = (ctx.config().numerotation || {}).pp || 'PP-{num:3}';
    const plan = db.insert(ENTITE, Object.assign({ numero: numeroUnique('pp', gabarit, ENTITE, 'PP') }, data, { derniereExecutionDate: data.periodicite.type === 'compteur' ? null : data.derniereExecution, dernierOtId: null, derniereGeneration: null, createdBy: req.user.id }));
    ctx.audit(req, 'creation', ENTITE, plan.id, `Plan ${plan.numero} : ${plan.nom} (${periodiciteLibelle(plan.periodicite, analyser(plan).unite)})`);
    notifierTechnicien(req, plan, null);
    ctx.emit('preventif:cree', { plan });
    return detail(req, plan);
  }, { perm: [MODULE, 'creer'] });

  const egalPeriodicite = (a, b) => !!a && !!b && a.type === b.type && Number(a.valeur) === Number(b.valeur);

  router.put('/api/preventif/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    const body = objet(req.body);
    const { data } = lirePlan(req, body, existant);
    const periodiciteChangee = !egalPeriodicite(existant.periodicite, data.periodicite);
    const equipementChange = Number(existant.equipementId) !== Number(data.equipementId);
    const echeanceSaisie = body.prochaineEcheance !== undefined && body.prochaineEcheance !== null && body.prochaineEcheance !== ''
      && String(data.prochaineEcheance) !== String(existant.prochaineEcheance);
    if (!echeanceSaisie && (periodiciteChangee || data.prochaineEcheance == null || (equipementChange && data.periodicite.type === 'compteur'))) {
      const base = data.derniereExecution != null ? data.derniereExecution : (data.periodicite.type === 'compteur' ? null : (data.dateDebut || jourDe(existant.createdAt) || dateLocale()));
      data.prochaineEcheance = calculerProchaineEcheance(data, base);
    }
    if (body.derniereExecution !== undefined) data.derniereExecutionDate = data.periodicite.type === 'compteur' ? (existant.derniereExecutionDate || null) : data.derniereExecution;
    const changes = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(existant[k] === undefined ? null : existant[k]));
    const maj = db.update(ENTITE, existant.id, data);
    if (changes.length) {
      ctx.audit(req, 'modification', ENTITE, maj.id, `Plan ${maj.numero} : ${maj.nom} — champs modifiés : ${changes.join(', ')}${periodiciteChangee ? ` ; nouvelle périodicité ${periodiciteLibelle(maj.periodicite, analyser(maj).unite)}, prochaine ${libelleEcheance(maj.periodicite, maj.prochaineEcheance, analyser(maj).unite)}` : ''}`);
      if ((existant.actif !== false) !== (maj.actif !== false)) ctx.audit(req, 'statut', ENTITE, maj.id, `Plan ${maj.numero} ${maj.actif === false ? 'désactivé' : 'réactivé'}`);
      notifierTechnicien(req, maj, existant.technicienId);
      ctx.emit('preventif:modifie', { plan: maj, ancien: existant, champsModifies: changes });
    }
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/preventif/:id', async (req) => {
    const p = getVisible(req, req.params.id);
    verifierPorteeSecteur(req, p.secteurId);
    const nb = db.count('ot', (o) => Number(o.planPreventifId) === p.id);
    if (nb) {
      const maj = db.update(ENTITE, p.id, { actif: false });
      ctx.audit(req, 'desactivation', ENTITE, p.id, `Plan ${p.numero} : ${p.nom} (référencé par ${nb} ordre(s) de travail : désactivé au lieu d'être supprimé)`);
      ctx.emit('preventif:modifie', { plan: maj, ancien: p, champsModifies: ['actif'] });
      return { ok: true, desactive: true, nbOt: nb };
    }
    db.remove(ENTITE, p.id);
    ctx.audit(req, 'suppression', ENTITE, p.id, `Plan ${p.numero} : ${p.nom}`);
    ctx.emit('preventif:supprime', { plan: p });
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  router.post('/api/preventif/:id/dupliquer', async (req) => {
    const source = getVisible(req, req.params.id);
    const b = objet(req.body);
    const eqSource = source.equipementId != null ? db.get('equipements', source.equipementId) : null;
    const copie = {
      nom: b.nom !== undefined ? b.nom : `${source.nom} (copie)`.slice(0, 200), description: source.description || '',
      typeCode: source.typeCode, prioriteCode: source.prioriteCode,
      equipementId: b.equipementId !== undefined ? b.equipementId : (eqSource && eqSource.actif !== false ? source.equipementId : null),
      secteurId: source.secteurId, periodicite: source.periodicite,
      gamme: (source.gamme || []).map((t) => ({ ordre: t.ordre, libelle: t.libelle, duree: t.duree })), dureeEstimee: source.dureeEstimee,
      technicienId: userActif(source.technicienId) ? source.technicienId : null,
      pieces: (source.pieces || []).filter((x) => db.get('articles', x.articleId)), actif: true,
      genererJoursAvant: source.genererJoursAvant == null ? null : source.genererJoursAvant, champs: source.champs || {},
    };
    if (b.equipementId !== undefined && (b.equipementId === null || b.equipementId === '')) copie.secteurId = b.secteurId !== undefined ? b.secteurId : source.secteurId;
    if (copie.technicienId != null) { try { verifierTechnicien(copie.technicienId); } catch (e) { copie.technicienId = null; } }
    const { data } = lirePlan(req, copie, null);
    data.derniereExecution = null;
    data.prochaineEcheance = calculerProchaineEcheance(data, data.periodicite.type === 'compteur' ? null : dateLocale());
    data.dateDebut = dateLocale();
    const gabarit = (ctx.config().numerotation || {}).pp || 'PP-{num:3}';
    const plan = db.insert(ENTITE, Object.assign({ numero: numeroUnique('pp', gabarit, ENTITE, 'PP') }, data, { derniereExecutionDate: null, dernierOtId: null, derniereGeneration: null, createdBy: req.user.id }));
    ctx.audit(req, 'duplication', ENTITE, plan.id, `Plan ${plan.numero} : copie du plan ${source.numero}`);
    notifierTechnicien(req, plan, null);
    ctx.emit('preventif:cree', { plan, source: 'duplication' });
    return detail(req, plan);
  }, { perm: [MODULE, 'creer'] });

  // ----- Routes : génération ---------------------------------------------------------------------
  /** Force la création d'un OT maintenant pour un plan (indépendamment de l'échéance). */
  router.post('/api/preventif/:id/generer', async (req) => {
    const p = getVisible(req, req.params.id);
    if (p.actif === false) throw new HttpError(400, 'Ce plan est inactif : réactivez-le avant de générer un ordre de travail');
    const b = objet(req.body);
    const datePrevue = lireDate(b.datePrevue, 'La date prévue');
    const r = genererInterne({ req, planIds: [p.id], force: true, datePrevue });
    if (r.erreurs.length) throw new HttpError(400, `Génération impossible : ${r.erreurs[0].message}`);
    if (!r.ots.length) throw new HttpError(400, r.ignores.length ? r.ignores[0].motif : 'Aucun ordre de travail n\'a été généré');
    const c = contexte();
    return { ot: resumeOt(db.get('ot', r.ots[0].id) || r.ots[0], c), plan: detail(req, db.get(ENTITE, p.id)) };
  }, { perm: [MODULE, 'modifier'] });

  /** Génère les OT de tous les plans actifs (visibles) arrivés à échéance (≤ aujourd'hui + horizon). */
  router.post('/api/preventif/generer', async (req) => {
    const b = objet(req.body);
    let horizon = null;
    if (b.horizonJours !== undefined && b.horizonJours !== null && b.horizonJours !== '') {
      horizon = nombre(b.horizonJours, 'L\'horizon de génération', { min: 0, max: 365 });
      if (!Number.isInteger(horizon)) throw new HttpError(400, 'L\'horizon de génération doit être un nombre entier de jours');
    }
    const r = genererInterne({ req, horizonJours: horizon });
    const c = contexte();
    return { nb: r.ots.length, generes: r.generes, ignores: r.ignores, erreurs: r.erreurs, ots: r.ots.map((o) => resumeOt(db.get('ot', o.id) || o, c)) };
  }, { perm: [MODULE, 'modifier'] });

  // ----- Services publiés --------------------------------------------------------------------------
  ctx.services.preventif = {
    /** Génère les OT à échéance (idempotent) ; retourne la liste des OT créés. Options : voir genererInterne. */
    generer(options) { return genererInterne(Object.assign({}, options || {})).ots; },
    /** Rapport détaillé de génération ({ generes, ignores, erreurs, ots }). */
    genererRapport(options) { return genererInterne(Object.assign({}, options || {})); },
    /** Occurrences d'échéance à venir : { jours, projection, nonDatees, req, secteurId, equipementId, technicienId }. */
    echeances(options = {}) {
      const plans = db.list(ENTITE, (p) => p.actif !== false);
      const visibles = options.req && options.req.perms ? ctx.scope(options.req, plans) : plans;
      const c = contexte();
      const filtres = filtrer(visibles.map((p) => resume(p, c)), { secteurId: options.secteurId, equipementId: options.equipementId, technicienId: options.technicienId });
      return occurrences(filtres, { jours: Math.min(Number(options.jours) || 30, JOURS_MAX_ECHEANCIER), projection: options.projection !== false, nonDatees: !!options.nonDatees, c });
    },
    analyser: (plan) => analyser(plan),
    etat: (plan) => analyser(plan).etat,
    resume: (plan) => resume(plan),
    calculerProchaineEcheance,
    periodiciteLibelle,
    plansPour: (equipementId) => db.list(ENTITE, (p) => Number(p.equipementId) === Number(equipementId)),
  };

  // ----- Génération automatique ---------------------------------------------------------------------
  // Les minuteurs ne sont pas armés en mode mémoire (tests) pour ne pas créer d'OT pendant l'exécution
  // des tests des autres modules ; la consultation de GET /api/preventif déclenche alors la génération.
  // L'option config.preventif.genererAuto est relue à chaque déclenchement (modifiable sans redémarrage).
  if (!db.inMemory || process.env.GMAO_PREVENTIF_AUTO === '1') {
    const demarrage = setTimeout(genererAuto, DELAI_DEMARRAGE_MS);
    if (demarrage.unref) demarrage.unref();
    const periodique = setInterval(genererAuto, INTERVALLE_AUTO_MS);
    if (periodique.unref) periodique.unref();
  }
}

// ----- Données de démonstration -----------------------------------------------------------------------
let seedEnCours = false;
const TEMOIN = 'Graissage mensuel de la remplisseuse rotative';

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  if (db.findOne(ENTITE, (p) => p.nom === TEMOIN)) return 'déjà présents';
  seedEnCours = true;
  try {
    // Dépendances (idempotentes) : utilisateurs, équipements, stock, puis OT (historique à rattacher)
    for (const m of ctx.modules || []) {
      if (/^(utilisateurs|equipements|stock|ot)\.js$/.test(m.fichier || '') && typeof m.seedDemo === 'function') {
        try { m.seedDemo(ctx); } catch (e) { ctx.log('Préventif : seed dépendant en échec', m.fichier, e.message); }
      }
    }
    return insererDemo(ctx);
  } finally { seedEnCours = false; }
}

function insererDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const listes = cfg.listes || {};
  const code = (n, voulu) => { const l = listes[n] || []; return !l.length || l.some((x) => x.code === voulu) ? voulu : l[0].code; };
  const statuts = Array.isArray(listes.statutsOT) && listes.statutsOT.length ? listes.statutsOT : STATUTS_OT_DEFAUT;
  const finaux = new Set(statuts.filter((s) => s.final).map((s) => s.code));
  const annulations = new Set(statuts.filter((s) => s.final && (s.code === 'annule' || /annul/i.test(s.label || ''))).map((s) => s.code));
  const gabarit = (cfg.numerotation || {}).pp || 'PP-{num:3}';
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = db.findOne('users', (x) => x.login === login && x.actif !== false); return u ? u.id : null; };
  const equipement = (n) => db.findOne('equipements', (e) => e.nom === n);
  const article = (re) => db.findOne('articles', (a) => a.actif !== false && re.test(`${a.designation || ''} ${a.code || ''}`));
  const aujourdhui = dateLocale();
  const numeroUniqueDemo = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('pp', gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; } return 'PP-' + Date.now(); };
  const gamme = (taches) => taches.map(([libelle, duree], i) => ({ ordre: i + 1, libelle, duree }));

  const defs = [
    {
      nom: 'Visite préventive mensuelle du compresseur GA 37', eq: 'Compresseur d\'air GA 37', type: 'preventif', prio: 'normale', periodicite: { type: 'mois', valeur: 1 }, echeance: 2, tech: 'kleroy', genererJoursAvant: 7,
      description: 'Gamme mensuelle constructeur Atlas Copco GA 37 VSD+ : contrôles de fonctionnement, purge, nettoyage du préfiltre.',
      lierOt: 'Visite préventive mensuelle du compresseur GA 37',
      gamme: gamme([['Relever les heures de marche et la pression de service', 0.25], ['Contrôler le niveau d\'huile et l\'absence de fuite', 0.25], ['Nettoyer le préfiltre d\'aspiration de l\'armoire', 0.5], ['Purger les condensats et tester le purgeur automatique', 0.25], ['Contrôler la température de refoulement (< 100 °C)', 0.25], ['Vérifier le serrage des raccords et l\'état des flexibles', 0.5]]),
      pieces: [[/pr[ée]filtre|filtre.*(air|aspiration)/i, 1]],
    },
    {
      nom: 'Remplacement trimestriel des filtres F7 — CTA atelier conditionnement', eq: 'CTA atelier conditionnement', type: 'preventif', prio: 'basse', periodicite: { type: 'mois', valeur: 3 }, echeance: 5, tech: 'kleroy', genererJoursAvant: 14,
      description: 'Remplacement des filtres F7 de la centrale de traitement d\'air (seuil de perte de charge : 250 Pa).',
      lierOt: 'Remplacement des filtres F7 de la CTA atelier conditionnement',
      gamme: gamme([['Consigner la CTA (sectionneur cadenassé)', 0.25], ['Déposer les filtres F7 et relever la perte de charge', 0.25], ['Nettoyer les glissières et le caisson', 0.25], ['Poser les filtres neufs et vérifier l\'étanchéité des joints', 0.5], ['Remettre en service et relever la nouvelle perte de charge', 0.25]]),
      pieces: [[/F7|filtre.*(poche|CTA)/i, 4]],
    },
    {
      nom: 'Contrôle réglementaire annuel de la presse hydraulique 250 t', eq: 'Presse hydraulique 250 t', type: 'reglementaire', prio: 'haute', periodicite: { type: 'mois', valeur: 12 }, echeance: 152, tech: 'jbernard', genererJoursAvant: 30,
      description: 'Vérification générale périodique de la presse (Code du travail, art. R. 4323-23) réalisée avec l\'organisme agréé ; rapport à classer au registre de sécurité.',
      gamme: gamme([['Préparer le registre de sécurité et le rapport précédent', 0.5], ['Contrôler les protecteurs et le barrage immatériel', 0.75], ['Essayer les arrêts d\'urgence et la commande bimanuelle', 0.5], ['Contrôler le circuit hydraulique (fuites, flexibles, tarage du limiteur)', 1], ['Mesurer le temps d\'arrêt du coulisseau', 0.5], ['Lever les observations et signer le rapport', 0.75]]),
    },
    {
      nom: TEMOIN, eq: 'Remplisseuse rotative', type: 'preventif', prio: 'normale', periodicite: { type: 'mois', valeur: 1 }, echeance: -6, tech: 'jbernard', genererJoursAvant: 7,
      description: 'Graissage des points de lubrification du carrousel, de la came de levage et de la vis d\'alimentation (graisse lithium EP 2).',
      gamme: gamme([['Consigner la remplisseuse (arrêt de ligne)', 0.25], ['Graisser les paliers du carrousel (6 graisseurs)', 0.5], ['Graisser la came de levage des becs', 0.5], ['Lubrifier la chaîne d\'entraînement de la vis d\'alimentation', 0.25], ['Contrôler l\'absence de jeu sur les galets de came', 0.25], ['Nettoyer l\'excédent de graisse et remettre en service', 0.25]]),
      pieces: [[/graisse/i, 2]],
    },
    {
      nom: 'Vidange et remplacement du filtre à huile — compresseur GA 37', eq: 'Compresseur d\'air GA 37', type: 'preventif', prio: 'normale', periodicite: { type: 'compteur', valeur: 500 }, compteurDepuis: 120, tech: 'kleroy', genererJoursAvant: 14,
      description: 'Préconisation renforcée (ambiance poussiéreuse) : vidange partielle de l\'huile de vis et remplacement du filtre à huile toutes les 500 heures de marche.',
      gamme: gamme([['Arrêter et consigner le compresseur, laisser refroidir', 0.25], ['Vidanger l\'huile par le bouchon de purge', 0.5], ['Remplacer le filtre à huile', 0.25], ['Faire l\'appoint d\'huile Roto-Inject Fluid jusqu\'au niveau', 0.25], ['Redémarrer et contrôler l\'absence de fuite', 0.25]]),
      pieces: [[/filtre.*huile/i, 1], [/huile.*(compresseur|roto|vis)/i, 5]],
    },
    {
      nom: 'Inspection trimestrielle du chariot élévateur électrique n°1', eq: 'Chariot élévateur électrique n°1', type: 'preventif', prio: 'normale', periodicite: { type: 'mois', valeur: 3 }, echeance: 41, tech: 'jbernard', genererJoursAvant: 14,
      description: 'Inspection de sécurité et d\'entretien trimestrielle (en complément de la VGP semestrielle).',
      gamme: gamme([['Contrôle visuel du mât, des chaînes et des fourches', 0.25], ['Contrôle du frein de service et du frein de parc', 0.25], ['Contrôle de la batterie : densité, niveau d\'électrolyte, connectique', 0.5], ['Contrôle des avertisseurs sonores et lumineux', 0.25], ['Contrôle des pneumatiques et des galets', 0.25], ['Graissage du mât et des chaînes', 0.25]]),
      pieces: [[/graisse/i, 1]],
    },
  ];

  let nb = 0; let nbLiens = 0; const absents = [];
  const createur = userId('mdupont') || (admin ? admin.id : null);
  for (const def of defs) {
    const eq = equipement(def.eq);
    if (!eq) { absents.push(def.eq); continue; }
    const technicienId = userId(def.tech);
    const pieces = [];
    for (const [re, quantite] of def.pieces || []) { const a = article(re); if (a && !pieces.some((x) => x.articleId === a.id)) pieces.push({ articleId: a.id, quantite }); }
    const p = def.periodicite;
    let prochaineEcheance; let derniereExecution; let derniereExecutionDate = null;
    if (p.type === 'compteur') {
      const courant = eq.compteur ? Number(eq.compteur.valeur) || 0 : 0;
      derniereExecution = Math.max(0, Math.round((courant - def.compteurDepuis) / 10) * 10);
      prochaineEcheance = derniereExecution + p.valeur;
      derniereExecutionDate = ajouterJours(aujourdhui, -Math.round(def.compteurDepuis / 8));
    } else {
      prochaineEcheance = ajouterJours(aujourdhui, def.echeance);
      derniereExecution = ajouterPeriode(prochaineEcheance, p, -1);
      if (derniereExecution > aujourdhui) derniereExecution = aujourdhui;
      derniereExecutionDate = derniereExecution;
    }
    // Historique : OT de démonstration du module OT portant le même intitulé (non encore rattachés)
    const lies = def.lierOt ? db.list('ot', (o) => o.titre === def.lierOt && Number(o.equipementId) === eq.id && o.planPreventifId == null) : [];
    const termines = lies.filter((o) => finaux.has(o.statut) && !annulations.has(o.statut) && o.dateFin).sort((a, b) => String(a.dateFin).localeCompare(String(b.dateFin)));
    const ouvert = lies.find((o) => !finaux.has(o.statut));
    if (termines.length && p.type !== 'compteur') { derniereExecution = jourDe(termines[termines.length - 1].dateFin); derniereExecutionDate = derniereExecution; }
    if (ouvert && ouvert.datePrevue && p.type !== 'compteur') prochaineEcheance = jourDe(ouvert.datePrevue);
    const record = {
      numero: numeroUniqueDemo(), nom: def.nom, description: def.description, equipementId: eq.id, secteurId: eq.secteurId == null ? null : eq.secteurId,
      typeCode: code('typesIntervention', def.type), prioriteCode: code('priorites', def.prio), periodicite: Object.assign({}, p),
      dateDebut: '2024-01-08', derniereExecution, derniereExecutionDate, prochaineEcheance,
      gamme: def.gamme, dureeEstimee: arrondi(def.gamme.reduce((s, t) => s + (t.duree || 0), 0)), technicienId, pieces,
      actif: true, genererJoursAvant: def.genererJoursAvant, champs: {}, createdBy: createur,
      dernierOtId: termines.length ? termines[termines.length - 1].id : null, derniereGeneration: null,
    };
    const plan = db.insert(ENTITE, record);
    nb++;
    for (const o of lies) {
      const patch = { planPreventifId: plan.id };
      if (!finaux.has(o.statut)) patch.echeancePreventif = plan.prochaineEcheance;
      else if (o.datePrevue) patch.echeancePreventif = jourDe(o.datePrevue);
      db.update('ot', o.id, patch);
      nbLiens++;
    }
  }
  db.touch();
  return `${nb} plans préventifs (1 en retard, 2 à échéance proche, 3 à jour)${nbLiens ? `, ${nbLiens} OT d'historique rattachés` : ''}${absents.length ? ` — équipements absents : ${absents.join(', ')}` : ''}`;
}

module.exports = { nom, register, seedDemo, periodiciteLibelle, ajouterPeriode, ajouterMois };
