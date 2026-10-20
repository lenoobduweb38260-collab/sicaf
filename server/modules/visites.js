'use strict';
/**
 * Module Audits & visites : clients et organismes qui viennent sur le site — audits clients,
 * audits de certification (ISO 9001 / 14001 / 45001, IFS, BRC…), inspections (autorités,
 * assureurs), visites de clients, de fournisseurs ou de groupes.
 *
 * - Planification : type (liste « typesVisite »), statut (liste « statutsVisite »), site visité,
 *   organisme, référentiel, contact, dates, hôte, participants internes, programme, zones visitées
 *   (secteurs du site ; plan 3D et objets du module Plans en option, en lecture seule).
 * - Préparation : check-list (propreté des zones, documents, EPI visiteurs, salle…).
 * - Registre d'accueil : visiteurs attendus, arrivée / départ horodatés, acceptation de la charte
 *   de sécurité, badge (numéro unique lisible en Code 128 ; le scan du badge à la sortie enregistre
 *   le départ), liste des personnes présentes sur le site (évacuation).
 * - Constats (liste « typesConstat ») et plan d'actions (liste « statutsAction ») : affectation,
 *   échéances, vérification de l'efficacité (droit « valider »), demande d'intervention liée.
 * - Résultat (conclusion, note, certificat), documents (programme, rapport d'audit, certificats ;
 *   10 Mo maximum), historique, exports CSV (visites, registre des visiteurs, plan d'actions).
 *
 * Données personnelles : le téléphone, l'e-mail, la pièce d'identité et le véhicule des visiteurs, ainsi
 * que l'e-mail et le téléphone du contact de l'organisme, ne sont transmis qu'aux gestionnaires de la
 * visite (droit « modifier ») — la pièce d'identité n'est communiquée en clair que sur la fiche
 * individuelle du visiteur — et sont anonymisés au-delà de config.visites.conserverVisiteursJours
 * (tâche quotidienne et purge à la demande, droit « valider »). Un compte désigné dans une visite
 * (hôte, participant, accompagnateur, responsable) doit être dans le périmètre de l'auteur.
 *
 * Portée : règle commune (ctx.canSee sur le secteur visité). L'hôte, les participants, les
 * accompagnateurs et les responsables d'actions ou de préparation voient en plus la visite qui les
 * concerne (dans le site affiché) et peuvent y réaliser les opérations qui les concernent
 * (accueil des visiteurs, mise à jour de leurs actions ou de leurs points de préparation), jamais
 * sur un site accessible en lecture seule.
 *
 * Services publiés : ctx.services.visites.{ get(id), presents(), verifierEcheances(options),
 *                    purger(options), statuts(), statutsActions() }
 * Événements émis  : 'visite:creee' ({ visite }), 'visite:statut' ({ visite, ancien, nouveau }),
 *                    'visite:arrivee' ({ visite, visiteur }), 'visite:depart' ({ visite, visiteur })
 * Événements écoutés : 'ot:cree' (lien OT des actions dont la demande est convertie),
 *                    'demande:cloturee' (l'action liée passe « réalisée », à vérifier),
 *                    'demande:refusee' (responsable prévenu ; une nouvelle demande peut être créée)
 */
const crypto = require('crypto');
const { csvLigne } = require('../csv');

const nom = 'Audits & visites';
const MODULE = 'visites';
const ENTITE = 'visites';

const TAILLE_MAX_DOC = 10 * 1024 * 1024; // 10 Mo par document
const MAX_DOCS = 30;
const MAX_VISITEURS = 300;
const MAX_CONSTATS = 300;
const MAX_ACTIONS = 50;
const MAX_PREPARATION = 100;
const MAX_PARTICIPANTS = 50;
const MAX_ZONES = 100;
const MAX_OBJETS_PLAN = 200;
const MAX_EPI = 15;
const MAX_HISTORIQUE = 300;
const CORPS_MAX = 1024 * 1024; // requêtes JSON ordinaires
const CORPS_MAX_DOC = 15 * 1024 * 1024; // document de 10 Mo encodé en base64
const DUREE_MAX_JOURS = 31;
const INTERVALLE_VERIFICATION_MS = 60 * 60 * 1000;

const CATEGORIES_DOC = { programme: 'Programme', rapport: 'Rapport d\'audit', certificat: 'Certificat', autre: 'Autre document' };
/** Types de fichiers acceptés (aucun format exécutable ni HTML / SVG). */
const TYPES_DOC = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};
const TYPES_DOC_AUTORISES = new Set(Object.values(TYPES_DOC));

/** Rôles des statuts (les codes par défaut servent de repli si la liste configurée a été renommée). */
const ROLES_VISITE = { planifiee: /planifi|pr[ée]vu|brouillon|attente/i, confirmee: /confirm|valid/i, en_cours: /cours|sur site|accueil/i, terminee: /termin|clos|cl[oô]tur|r[ée]alis|effectu/i, annulee: /annul|report|abandon/i };
const FINAUX_VISITE = new Set(['terminee', 'annulee']);
const ROLES_ACTION = { a_faire: /faire|ouvert|nouve|attente/i, en_cours: /cours/i, realisee: /r[ée]alis|termin|fait/i, verifiee: /v[ée]rifi|efficace|sold|clos/i, abandonnee: /abandon|annul/i };
const FINAUX_ACTION = new Set(['verifiee', 'abandonnee']);

// ----- Utilitaires sans contexte ---------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function jourLocal(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function aujourdhui() { return jourLocal(new Date()); }
function ajouterJours(jour, n) { const d = new Date(jour + 'T12:00:00'); d.setDate(d.getDate() + n); return jourLocal(d); }
function joursEntre(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); }
function frJour(j) { return /^\d{4}-\d{2}-\d{2}$/.test(String(j || '')) ? String(j).split('-').reverse().join('/') : ''; }
function frDateHeure(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function frHeure(iso) { const d = new Date(iso); return !iso || Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/**
 * Nombre entier strictement positif ou null : un nombre entier, ou une chaîne en écriture décimale
 * (jamais l'hexadécimal, l'exposant ni un booléen).
 */
function entierPositif(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d{1,12}\s*$/.test(v)) n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e12 ? n : null;
}

function nomVisiteur(x) { return `${x.prenom || ''} ${x.nom || ''}`.trim() || 'Visiteur'; }

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  // Libellés français des actions propres au module dans le journal d'activité (et son export)
  if (ctx.libellesActions) Object.assign(ctx.libellesActions, { arrivee: 'Arrivée d\'un visiteur', depart: 'Départ d\'un visiteur', liaison: 'Liaison à une demande d\'intervention' });

  // ----- Configuration et listes ----------------------------------------------------------------
  /** Paramètres du module, bornés (la configuration peut contenir des valeurs hors limites). */
  function cfgVisites() {
    const c = (ctx.config().visites) || {};
    const rappel = Number(c.rappelJoursAvant);
    const conserver = Number(c.conserverVisiteursJours);
    return {
      charteSecurite: typeof c.charteSecurite === 'string' ? c.charteSecurite.trim() : '',
      accompagnementObligatoire: c.accompagnementObligatoire !== false,
      rappelJoursAvant: Number.isInteger(rappel) && rappel >= 0 ? Math.min(rappel, 60) : 2,
      badgeAvecCodeBarre: c.badgeAvecCodeBarre !== false,
      demanderPieceIdentite: c.demanderPieceIdentite === true,
      conserverVisiteursJours: Number.isInteger(conserver) && conserver >= 1 ? Math.min(conserver, 3650) : 365,
    };
  }

  /** Associe chaque rôle de statut à un code de la liste configurée (code identique, sinon libellé reconnu du même type). */
  function resoudre(liste, roles, finaux) {
    const out = {};
    const pris = new Set();
    for (const role of Object.keys(roles)) {
      const exact = liste.find((x) => x.code === role);
      if (exact) { out[role] = exact.code; pris.add(exact.code); }
    }
    for (const role of Object.keys(roles)) {
      if (out[role]) continue;
      const final = finaux.has(role);
      const cand = liste.find((x) => !pris.has(x.code) && !!x.final === final && (roles[role].test(x.code) || roles[role].test(x.label || '')));
      const libres = liste.filter((x) => !pris.has(x.code) && !!x.final === final);
      const choix = cand || (final ? libres[libres.length - 1] : libres[0]);
      out[role] = choix ? choix.code : role;
      if (choix) pris.add(choix.code);
    }
    return out;
  }
  /** Contexte de calcul commun à une requête : statuts, codes finaux, types de constat, date du jour. */
  function contexte() {
    const lv = ctx.liste('statutsVisite');
    const la = ctx.liste('statutsAction');
    const lt = ctx.liste('typesConstat');
    const nc = new Set();
    const positifs = new Set();
    for (const t of lt) {
      if (/^nc/i.test(t.code) || /non[\s-]?conformit/i.test(t.label || '')) nc.add(t.code);
      else if (/point_fort|positif/i.test(t.code) || /point fort|positif|bonne pratique/i.test(t.label || '')) positifs.add(t.code);
    }
    if (!lt.length) { nc.add('nc_majeure'); nc.add('nc_mineure'); positifs.add('point_fort'); }
    return {
      SV: resoudre(lv, ROLES_VISITE, FINAUX_VISITE),
      SA: resoudre(la, ROLES_ACTION, FINAUX_ACTION),
      finauxVisite: new Set(lv.length ? lv.filter((x) => x.final).map((x) => x.code) : Array.from(FINAUX_VISITE)),
      finauxAction: new Set(la.length ? la.filter((x) => x.final).map((x) => x.code) : Array.from(FINAUX_ACTION)),
      nc, positifs,
      jour: aujourdhui(),
      maintenant: new Date().toISOString(),
    };
  }
  function libelle(nomListe, code) { const it = ctx.liste(nomListe).find((x) => x.code === code); return it ? it.label : (code == null ? '' : String(code)); }

  // ----- Secteurs -------------------------------------------------------------------------------
  function secteur(id) { return id == null ? null : db.get('secteurs', id); }
  function cheminSecteur(id) {
    const parts = []; let cur = secteur(id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? secteur(cur.parentId) : null; }
    return parts.join(' › ');
  }
  function siteDe(secteurId) { return secteurId == null ? null : ctx.siteDuSecteur(secteurId); }
  function nomSite(secteurId) { const s = secteur(siteDe(secteurId)); return s ? s.nom : ''; }

  // ----- Portée -----------------------------------------------------------------------------------
  /** Rôles de l'utilisateur dans une visite. */
  function rolesDans(uid, v) {
    const ids = (arr) => (Array.isArray(arr) ? arr.map(Number) : []);
    return {
      hote: Number(v.hoteUserId) === uid,
      participant: ids(v.participantsUserIds).includes(uid),
      accompagnateur: (v.visiteurs || []).some((x) => Number(x.accompagnateurUserId) === uid),
      responsableAction: (v.constats || []).some((c) => (c.actions || []).some((a) => Number(a.responsableUserId) === uid)),
      responsablePreparation: (v.preparation || []).some((p) => Number(p.responsableUserId) === uid),
    };
  }
  function concerne(uid, v) { const r = rolesDans(uid, v); return r.hote || r.participant || r.accompagnateur || r.responsableAction || r.responsablePreparation; }
  function secteurLectureSeule(req, v) {
    const sid = v.secteurId == null ? null : Number(v.secteurId);
    return sid != null && !!req.perms && Array.isArray(req.perms.secteurIdsLecture) && req.perms.secteurIdsLecture.includes(sid);
  }
  function horsSiteAffiche(req, v) {
    const sid = v.secteurId == null ? null : Number(v.secteurId);
    return sid != null && !!req.perms && Array.isArray(req.perms.siteFiltre) && !req.perms.siteFiltre.includes(sid);
  }
  /** Consultation : portée commune, ou personne concernée par la visite (dans le site affiché). */
  function visibleLecture(req, v) {
    if (!v || !req.user) return false;
    if (perms.canSeeRecord(req.perms, req.user, v, { ecriture: false })) return true;
    return concerne(req.user.id, v) && !horsSiteAffiche(req, v);
  }
  /** Modification complète : portée commune en écriture (sites en lecture seule exclus). */
  function ecritureComplete(req, v) { return perms.canSeeRecord(req.perms, req.user, v, { ecriture: true }); }
  /** Intervention ciblée d'une personne concernée (hors portée) : jamais sur un site en lecture seule. */
  function interventionPossible(req, v, estIntervenant) {
    if (ecritureComplete(req, v)) return true;
    return !!estIntervenant && !secteurLectureSeule(req, v) && !horsSiteAffiche(req, v) && estIntervenant(rolesDans(req.user.id, v), v);
  }
  const portee = (req, rows) => rows.filter((v) => visibleLecture(req, v));
  /**
   * Visite visible (404 sinon). Pendant une modification : 403 si le site est en lecture seule ou si
   * l'utilisateur n'est concerné que par d'autres opérations que celle demandée.
   * @param {Function} [estIntervenant] (roles, visite) → vrai si une personne concernée peut faire l'opération
   */
  function getVisible(req, id, estIntervenant) {
    const n = entierPositif(String(id == null ? '' : id));
    const v = n ? db.get(ENTITE, n) : null;
    if (!v || !visibleLecture(req, v)) throw new HttpError(404, 'Visite introuvable');
    if (!req.ecriture || interventionPossible(req, v, estIntervenant)) return v;
    if (secteurLectureSeule(req, v)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
    throw new HttpError(403, 'Cette visite est hors de votre portée : seules les opérations qui vous concernent sont possibles');
  }
  const gestionnaire = (req) => perms.can(req.perms, MODULE, 'modifier');
  const ACCUEIL = (r) => r.hote || r.participant || r.accompagnateur;

  /** Création / déplacement : le secteur doit être dans la portée d'écriture (et dans le site affiché). */
  function verifierSecteurEcriture(req, secteurId) {
    const p = req.perms || {};
    if (secteurId != null && Array.isArray(p.siteFiltre) && !p.siteFiltre.includes(secteurId)) throw new HttpError(400, 'Ce secteur n\'appartient pas au site sélectionné dans l\'en-tête');
    if (p.estAdmin || p.portee === 'tous') return;
    if (secteurId == null) throw new HttpError(400, 'Le site (ou secteur) visité est obligatoire');
    if (Array.isArray(p.secteurIdsLecture) && p.secteurIdsLecture.includes(secteurId) && !(p.secteurIds || []).includes(secteurId)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
    if (p.portee === 'perso' && !(p.secteurIds || []).length) return;
    if (!(p.secteurIds || []).includes(secteurId)) throw new HttpError(403, 'Vous ne pouvez organiser des visites que sur vos propres sites ou secteurs');
  }

  // ----- Validation des entrées -------------------------------------------------------------------
  function objet(b) { return b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? b : {}; }
  /** Champ texte : une chaîne (absent ou null : vide) ; booléens, nombres, tableaux et objets refusés. */
  function texte(v, max, libelleChamp, options = {}) {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') throw new HttpError(400, `${libelleChamp} : valeur invalide (texte attendu)`);
    let s = options.multiligne
      ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      : v.replace(/[\u0000-\u001F\u007F]/g, ' ');
    s = s.trim();
    if (s.length > max) throw new HttpError(400, `${libelleChamp} : ${max} caractères maximum`);
    if (options.requis && !s) throw new HttpError(400, `${libelleChamp} : champ obligatoire`);
    return s;
  }
  function booleen(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
  function email(v, libelleChamp) {
    const s = texte(v, 150, libelleChamp);
    if (s && !/^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]{2,}$/.test(s)) throw new HttpError(400, `${libelleChamp} : adresse e-mail invalide`);
    return s;
  }
  function telephone(v, libelleChamp) {
    const s = texte(v, 30, libelleChamp);
    if (s && !/^[0-9+().\s/-]{4,30}$/.test(s)) throw new HttpError(400, `${libelleChamp} : numéro invalide (chiffres, espaces, +, -, . et parenthèses)`);
    return s;
  }
  /** Date et heure (AAAA-MM-JJ ou AAAA-MM-JJTHH:MM[:SS][fuseau]) → ISO 8601. */
  function dateHeure(v, libelleChamp, requis) {
    if (v === undefined || v === null || v === '') { if (requis) throw new HttpError(400, `${libelleChamp} : champ obligatoire`); return null; }
    if (typeof v !== 'string') throw new HttpError(400, `${libelleChamp} : date invalide`);
    const s = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) throw new HttpError(400, `${libelleChamp} : date invalide (format attendu AAAA-MM-JJ ou AAAA-MM-JJTHH:MM)`);
    const d = new Date(s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${libelleChamp} : date invalide`);
    if (d.getFullYear() < 2000 || d.getFullYear() > 2100) throw new HttpError(400, `${libelleChamp} : année hors limites (2000 à 2100)`);
    return d.toISOString();
  }
  /** Date seule (AAAA-MM-JJ, date réelle du calendrier). */
  function dateJour(v, libelleChamp) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new HttpError(400, `${libelleChamp} : date invalide`);
    const s = v.trim().slice(0, 10);
    const d = new Date(s + 'T12:00:00');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || jourLocal(d) !== s) throw new HttpError(400, `${libelleChamp} : date invalide (format attendu AAAA-MM-JJ)`);
    if (d.getFullYear() < 2000 || d.getFullYear() > 2100) throw new HttpError(400, `${libelleChamp} : année hors limites (2000 à 2100)`);
    return s;
  }
  /** Horodatage d'accueil saisi a posteriori : jamais dans le futur, 7 jours au plus dans le passé. */
  function horodatage(v, libelleChamp) {
    if (v === undefined || v === null || v === '') return new Date().toISOString();
    const iso = dateHeure(v, libelleChamp, true);
    const t = Date.parse(iso);
    if (t > Date.now() + 60 * 1000) throw new HttpError(400, `${libelleChamp} : l'heure ne peut pas être dans le futur`);
    if (t < Date.now() - 7 * 86400000) throw new HttpError(400, `${libelleChamp} : correction limitée aux 7 derniers jours`);
    return iso;
  }
  /** Code d'une liste de valeurs : obligatoirement connu s'il est fourni ; premier code par défaut si demandé. */
  function codeListe(nomListe, code, libelleChamp, parDefaut) {
    const l = ctx.liste(nomListe);
    if (code === undefined || code === null || code === '') {
      if (parDefaut) return l.length ? l[0].code : null;
      throw new HttpError(400, `${libelleChamp} : champ obligatoire`);
    }
    if (typeof code !== 'string' || !l.some((x) => x.code === code)) throw new HttpError(400, `${libelleChamp} invalide : « ${String(code).slice(0, 40)} »`);
    return code;
  }
  /**
   * Utilisateur actif désigné dans une visite (hôte, participant, accompagnateur, responsable). Un compte déjà
   * enregistré reste accepté tel quel (même désactivé) ; un compte nouvellement désigné doit être dans le
   * périmètre de l'auteur (options.req) : la désignation lui ouvre la visite, ses visiteurs et leurs coordonnées.
   */
  function utilisateur(v, libelleChamp, options = {}) {
    if (v === undefined || v === null || v === '') { if (options.requis) throw new HttpError(400, `${libelleChamp} : champ obligatoire`); return null; }
    const id = entierPositif(v);
    const u = id ? db.get('users', id) : null;
    if (!u) throw new HttpError(400, `${libelleChamp} : utilisateur introuvable`);
    if (options.actuel != null && Number(options.actuel) === u.id) return u.id;
    if (u.actif === false) throw new HttpError(400, `${libelleChamp} : le compte de ${ctx.nomUser(u.id)} est désactivé`);
    if (options.req) verifierPerimetreUtilisateur(options.req, u);
    return u.id;
  }
  /** Compte visible par l'auteur (règle commune ctx.utilisateurVisible, en écriture) ; administrateur et portée « tous » exceptés. */
  function verifierPerimetreUtilisateur(req, u) {
    const p = req.perms || {};
    if (p.estAdmin || p.portee === 'tous') return;
    if (!ctx.utilisateurVisible(req.user, p, u, true)) throw new HttpError(403, `${ctx.nomUser(u.id)} n'est pas dans votre périmètre : vous ne pouvez pas le désigner pour cette visite`);
  }
  function listeUtilisateurs(v, libelleChamp, actuels, req) {
    if (v === undefined || v === null || v === '') return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${libelleChamp} : liste attendue`);
    if (v.length > MAX_PARTICIPANTS) throw new HttpError(400, `${libelleChamp} : ${MAX_PARTICIPANTS} personnes au maximum`);
    const deja = new Set((actuels || []).map(Number));
    const out = [];
    for (const x of v) {
      const id = utilisateur(x, libelleChamp, { actuel: deja.has(Number(x)) ? Number(x) : null, req });
      if (id != null && !out.includes(id)) out.push(id);
    }
    return out;
  }
  function secteurExistant(v, libelleChamp) {
    const id = entierPositif(v);
    if (!id || !db.get('secteurs', id)) throw new HttpError(400, `${libelleChamp} : secteur introuvable`);
    return id;
  }
  function listeEpi(v) {
    if (v === undefined || v === null || v === '') return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'EPI fournis : liste attendue');
    if (v.length > MAX_EPI) throw new HttpError(400, `EPI fournis : ${MAX_EPI} éléments au maximum`);
    const out = [];
    for (const x of v) { const s = texte(x, 60, 'EPI fourni'); if (s && !out.includes(s)) out.push(s); }
    return out;
  }
  /** Équipement existant et visible (règle du module Équipements s'il est installé). */
  function equipementVisible(req, id) {
    const e = db.get('equipements', id);
    if (!e) return null;
    const s = ctx.services.equipements;
    const ok = s && typeof s.visible === 'function' ? s.visible(req, e) : ctx.canSee(req, e);
    return ok ? e : null;
  }

  // ----- Numérotation, badges, identifiants --------------------------------------------------------
  function numeroUnique() {
    const gabarit = (ctx.config().numerotation || {}).vis || 'VIS-{annee}-{num:3}';
    for (let i = 0; i < 1000; i++) { const n = db.nextNumber('vis', gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; }
    throw new HttpError(500, 'Impossible de générer un numéro de visite unique');
  }
  function badgesUtilises() {
    const s = new Set();
    for (const v of db.list(ENTITE)) for (const x of v.visiteurs || []) if (x.badgeNumero) s.add(String(x.badgeNumero).toUpperCase());
    return s;
  }
  /** Numéro de badge aléatoire unique (« VB » + 8 chiffres : code-barres Code 128 compact). */
  function nouveauBadge(dejaPris) {
    const pris = dejaPris || badgesUtilises();
    for (let i = 0; i < 1000; i++) {
      const n = 'VB' + String(crypto.randomInt(0, 100000000)).padStart(8, '0');
      if (!pris.has(n)) { pris.add(n); return n; }
    }
    throw new HttpError(500, 'Impossible de générer un numéro de badge unique');
  }
  /** Identifiant d'un sous-élément (visiteur, constat, action, point de préparation, document). */
  function nouvelId(etat) { etat.sequence = (Number(etat.sequence) || 0) + 1; return etat.sequence; }
  const cloner = (arr) => (Array.isArray(arr) ? arr.map((x) => Object.assign({}, x)) : []);

  // ----- Historique, audit, notifications ------------------------------------------------------------
  /** Enregistre une modification : historique de la visite + journal d'audit. */
  function enregistrer(req, v, patch, action, details, actionAudit) {
    const uid = req && req.user ? req.user.id : null;
    patch.historique = (v.historique || []).concat([{ date: new Date().toISOString(), userId: uid, action, details: String(details || '').slice(0, 500) }]).slice(-MAX_HISTORIQUE);
    const maj = db.update(ENTITE, v.id, patch);
    ctx.audit(req, actionAudit || 'modification', ENTITE, v.id, `Visite ${v.numero} : ${String(details || '').slice(0, 300)}`);
    return maj;
  }
  /** Notifie des utilisateurs actifs (sans l'auteur de l'action). */
  function notifier(req, ids, contenu) {
    const auteur = req && req.user ? req.user.id : null;
    const cibles = Array.from(new Set((ids || []).filter((x) => x != null).map(Number)))
      .filter((id) => id !== auteur && (db.get('users', id) || {}).actif !== false && db.get('users', id));
    if (cibles.length) ctx.notify(cibles, contenu);
    return cibles.length;
  }
  const equipeVisite = (v) => [v.hoteUserId].concat(v.participantsUserIds || []);
  const lienVisite = (v, onglet) => `#/visites/${v.id}${onglet ? '?onglet=' + onglet : ''}`;
  function periodeTexte(v) {
    const d = jourLocal(v.dateDebut); const f = jourLocal(v.dateFin || v.dateDebut);
    return d === f ? `le ${frJour(d)} de ${frHeure(v.dateDebut)} à ${frHeure(v.dateFin || v.dateDebut)}` : `du ${frDateHeure(v.dateDebut)} au ${frDateHeure(v.dateFin)}`;
  }

  // ----- Sérialisation ----------------------------------------------------------------------------------
  function estEnRetard(a, cx) { return !!a.echeance && !cx.finauxAction.has(a.statut) && a.statut !== cx.SA.realisee && a.echeance < cx.jour; }
  function constatOuvert(c, cx) {
    if (cx.positifs.has(c.typeCode)) return false;
    const actions = c.actions || [];
    return !actions.length || actions.some((a) => !cx.finauxAction.has(a.statut));
  }
  function statistiques(v, cx) {
    const visiteurs = v.visiteurs || [];
    let actionsOuvertes = 0; let actionsEnRetard = 0; let ncOuvertes = 0; let constatsOuverts = 0;
    for (const c of v.constats || []) {
      if (constatOuvert(c, cx)) { constatsOuverts++; if (cx.nc.has(c.typeCode)) ncOuvertes++; }
      for (const a of c.actions || []) { if (!cx.finauxAction.has(a.statut)) actionsOuvertes++; if (estEnRetard(a, cx)) actionsEnRetard++; }
    }
    const prep = v.preparation || [];
    return {
      nbVisiteurs: visiteurs.length,
      nbArrives: visiteurs.filter((x) => x.arrivee).length,
      nbPresents: visiteurs.filter((x) => x.arrivee && !x.depart).length,
      nbConstats: (v.constats || []).length,
      nbNc: (v.constats || []).filter((c) => cx.nc.has(c.typeCode)).length,
      constatsOuverts, ncOuvertes, actionsOuvertes, actionsEnRetard,
      preparationTotal: prep.length, preparationFaits: prep.filter((p) => p.fait).length,
      nbDocuments: (v.documents || []).length,
    };
  }
  function resume(v, cx) {
    const s = secteur(v.secteurId);
    return Object.assign({
      id: v.id, numero: v.numero, titre: v.titre, typeCode: v.typeCode, statut: v.statut, final: cx.finauxVisite.has(v.statut),
      secteurId: v.secteurId == null ? null : Number(v.secteurId), secteurNom: s ? s.nom : '', secteurChemin: cheminSecteur(v.secteurId),
      siteId: siteDe(v.secteurId), siteNom: nomSite(v.secteurId),
      organisme: v.organisme || '', referentiel: v.referentiel || '', dateDebut: v.dateDebut, dateFin: v.dateFin,
      hoteUserId: v.hoteUserId, hoteNom: ctx.nomUser(v.hoteUserId), participantsUserIds: v.participantsUserIds || [],
      zonesVisitees: v.zonesVisitees || [], certificatObtenu: v.resultat ? v.resultat.certificatObtenu : null,
      createdBy: v.createdBy, createdAt: v.createdAt, updatedAt: v.updatedAt, champs: v.champs || {},
    }, statistiques(v, cx));
  }
  /** Visiteur tel que transmis : coordonnées réservées aux gestionnaires, pièce d'identité masquée. */
  function visiteurPublic(x, coordonnees) {
    const r = {
      id: x.id, nom: x.nom, prenom: x.prenom || '', societe: x.societe || '', fonction: x.fonction || '',
      accompagnateurUserId: x.accompagnateurUserId == null ? null : x.accompagnateurUserId, accompagnateurNom: ctx.nomUser(x.accompagnateurUserId),
      epiFournis: x.epiFournis || [], charteAcceptee: !!x.charteAcceptee, charteAccepteeLe: x.charteAccepteeLe || null,
      arrivee: x.arrivee || null, depart: x.depart || null, badgeNumero: x.badgeNumero || '',
      etat: x.depart ? 'parti' : (x.arrivee ? 'present' : 'attendu'),
      arriveePar: x.arriveePar || null, departPar: x.departPar || null,
      pieceIdentiteRenseignee: !!x.pieceIdentite, anonymiseLe: x.anonymiseLe || null,
    };
    if (coordonnees) {
      r.email = x.email || ''; r.telephone = x.telephone || ''; r.vehicule = x.vehicule || '';
      r.pieceIdentite = x.pieceIdentite ? '•••• ' + String(x.pieceIdentite).slice(-4) : '';
    }
    return r;
  }
  /** Code du statut « refusée » des demandes (liste configurée, résolue par le module Demandes). */
  function statutDemandeRefusee() {
    const sd = ctx.services.demandes;
    let code = null;
    try { code = sd && sd.STATUTS ? sd.STATUTS.refusee : null; } catch (e) { code = null; }
    return code || 'refusee';
  }
  function demandeEstRefusee(demandeId) { const d = db.get('demandes', demandeId); return !!d && d.statut === statutDemandeRefusee(); }
  function infoDemande(req, a) {
    if (a.demandeId == null) return null;
    const d = db.get('demandes', a.demandeId);
    // refusee : une nouvelle demande peut être créée pour l'action (indicateur transmis sans le détail de la demande)
    const base = { id: a.demandeId, numero: a.demandeNumero || (d ? d.numero : ''), existe: !!d, refusee: !!d && d.statut === statutDemandeRefusee() };
    if (!d || !perms.can(req.perms, 'demandes', 'voir') || !ctx.canSee(req, d)) return base;
    const out = Object.assign(base, { statut: d.statut, titre: d.titre, visible: true });
    const otId = a.otId != null ? a.otId : d.otId;
    if (otId != null && perms.can(req.perms, 'ot', 'voir')) { const o = db.get('ot', otId); if (o && ctx.canSee(req, o)) out.ot = { id: o.id, numero: o.numero, statut: o.statut }; }
    return out;
  }
  function actionPublique(req, a, cx) {
    return Object.assign({}, a, {
      responsableNom: ctx.nomUser(a.responsableUserId), verifieParNom: ctx.nomUser(a.verifiePar),
      final: cx.finauxAction.has(a.statut), enRetard: estEnRetard(a, cx), demande: infoDemande(req, a),
    });
  }
  /** Équipement d'un constat tel que transmis : numéro et nom seulement s'il est visible du lecteur. */
  function equipementConstat(req, c) {
    if (c.equipementId == null || !db.get('equipements', c.equipementId)) return null;
    const e = equipementVisible(req, c.equipementId);
    return e ? { id: e.id, numero: e.numero, nom: e.nom } : { masque: true, numero: '', nom: 'Équipement hors de votre périmètre' };
  }
  function constatPublic(req, c, cx) {
    return Object.assign({}, c, {
      secteurNom: c.secteurId != null ? cheminSecteur(c.secteurId) : '',
      equipement: equipementConstat(req, c),
      createdByNom: ctx.nomUser(c.createdBy), ouvert: constatOuvert(c, cx), estNc: cx.nc.has(c.typeCode),
      actions: (c.actions || []).map((a) => actionPublique(req, a, cx)),
    });
  }
  function documentMeta(d) { return { id: d.id, nom: d.nom, type: d.type, taille: d.taille, categorie: d.categorie, description: d.description || '', date: d.date, userId: d.userId, userNom: ctx.nomUser(d.userId) }; }
  /**
   * Plan 3D lisible par la requête (droit plans › voir et règle de lecture du module Plans : service
   * ctx.services.plans.visible s'il est publié, sinon la même règle — portée commune en consultation, ou accès
   * à un secteur couvert par le plan, dans le site affiché).
   */
  function planLisible(req, plan) {
    if (!plan || !req.perms || !perms.can(req.perms, 'plans', 'voir')) return false;
    const sp = ctx.services.plans;
    if (sp && typeof sp.visible === 'function') return !!sp.visible(req, plan);
    if (ctx.canSee(Object.assign({}, req, { ecriture: false }), plan)) return true;
    const p = req.perms;
    if (plan.secteurId == null) return true;
    const sid = Number(plan.secteurId);
    if (Array.isArray(p.siteFiltre) && !p.siteFiltre.includes(sid)) return false;
    if (p.portee === 'tous') return false;
    const accessibles = new Set([].concat(p.secteurIds || [], p.secteurIdsLecture || []).map(Number));
    return accessibles.size > 0 && perms.secteursDescendants(db, [sid]).some((id) => accessibles.has(Number(id)));
  }
  function planInfo(req, v) {
    if (v.planId == null || !perms.can(req.perms, 'plans', 'voir')) return null;
    const p = db.get('plans', v.planId);
    if (!p) return null;
    if (!planLisible(req, p)) return { id: p.id, masque: true, numero: '', nom: 'Plan 3D hors de votre périmètre', objets: [] };
    const ids = new Set((v.objetIds || []).map(String));
    return { id: p.id, numero: p.numero, nom: p.nom, objets: (p.objets || []).filter((o) => ids.has(String(o.id))).map((o) => ({ id: o.id, nom: o.nom || '', type: o.type })) };
  }
  function droits(req, v) {
    const complet = ecritureComplete(req, v);
    const r = rolesDans(req.user.id, v);
    const ro = secteurLectureSeule(req, v);
    return {
      modifier: complet && perms.can(req.perms, MODULE, 'modifier'),
      supprimer: complet && perms.can(req.perms, MODULE, 'supprimer'),
      valider: complet && perms.can(req.perms, MODULE, 'valider'),
      exporter: perms.can(req.perms, MODULE, 'exporter'),
      accueil: perms.can(req.perms, MODULE, 'modifier') && !ro && (complet || ACCUEIL(r)),
      lectureSeule: ro,
      roles: r,
    };
  }
  function detail(req, v) {
    const cx = contexte();
    const d = droits(req, v);
    const coordonnees = d.modifier || d.accueil;
    const zones = (v.zonesVisitees || []).map((id) => { const s = secteur(id); return { id: Number(id), nom: s ? s.nom : '#' + id, chemin: cheminSecteur(id), couleur: s ? s.couleur || '' : '' }; });
    // Contact de l'organisme (personne physique) : e-mail et téléphone réservés, comme ceux des visiteurs, aux gestionnaires
    const contact = v.contactOrganisme || {};
    return Object.assign(resume(v, cx), {
      contactOrganisme: coordonnees
        ? { nom: contact.nom || '', email: contact.email || '', telephone: contact.telephone || '', anonymiseLe: contact.anonymiseLe || null }
        : { nom: contact.nom || '' },
      programme: v.programme || '',
      participants: (v.participantsUserIds || []).map((id) => ({ id, nom: ctx.nomUser(id) })),
      zones, planId: v.planId == null ? null : v.planId, objetIds: v.objetIds || [], plan: planInfo(req, v),
      preparation: (v.preparation || []).map((p) => Object.assign({}, p, { responsableNom: ctx.nomUser(p.responsableUserId), faitParNom: ctx.nomUser(p.faitPar), enRetard: !p.fait && !!p.echeance && p.echeance < cx.jour })),
      visiteurs: (v.visiteurs || []).map((x) => visiteurPublic(x, coordonnees)),
      constats: (v.constats || []).map((c) => constatPublic(req, c, cx)),
      resultat: Object.assign({ conclusion: '', note: '', certificatObtenu: null, dateRapport: null }, v.resultat || {}),
      documents: (v.documents || []).map(documentMeta),
      historique: (v.historique || []).slice().reverse().map((h) => Object.assign({}, h, { userNom: h.userId == null ? 'Système' : ctx.nomUser(h.userId) })),
      motifAnnulation: v.motifAnnulation || '', dateCloture: v.dateCloture || null,
      createdByNom: ctx.nomUser(v.createdBy),
      droits: d,
    });
  }
  function ligneRegistre(v, x) {
    return {
      visiteId: v.id, visiteNumero: v.numero, visiteTitre: v.titre, typeCode: v.typeCode, statut: v.statut,
      secteurId: v.secteurId == null ? null : Number(v.secteurId), siteNom: nomSite(v.secteurId) || cheminSecteur(v.secteurId), organisme: v.organisme || '',
      hoteUserId: v.hoteUserId, hoteNom: ctx.nomUser(v.hoteUserId), dateDebut: v.dateDebut, dateFin: v.dateFin,
      zones: (v.zonesVisitees || []).map((id) => (secteur(id) || {}).nom || '').filter(Boolean),
      visiteurId: x.id, nom: x.nom, prenom: x.prenom || '', societe: x.societe || '', fonction: x.fonction || '',
      accompagnateurUserId: x.accompagnateurUserId == null ? null : x.accompagnateurUserId, accompagnateurNom: ctx.nomUser(x.accompagnateurUserId),
      badgeNumero: x.badgeNumero || '', charteAcceptee: !!x.charteAcceptee, epiFournis: x.epiFournis || [],
      pieceIdentiteRenseignee: !!x.pieceIdentite, // indicateur seul : la pièce n'est lue que sur la fiche du visiteur
      arrivee: x.arrivee || null, depart: x.depart || null, etat: x.depart ? 'parti' : (x.arrivee ? 'present' : 'attendu'),
    };
  }
  /**
   * Opérations possibles sur une ligne du plan d'actions, calculées comme les routes : avancement (gestionnaire,
   * ou responsable de l'action hors site en lecture seule), vérification (droit valider), demande d'intervention.
   */
  function droitsAction(req, v, a, d, cx) {
    const ouverte = v.statut !== cx.SV.annulee;
    const gestion = d.modifier;
    const responsable = Number(a.responsableUserId) === req.user.id && !d.lectureSeule && !horsSiteAffiche(req, v);
    const final = cx.finauxAction.has(a.statut);
    const demandeRefusee = a.demandeId != null && demandeEstRefusee(a.demandeId);
    return {
      gestion: ouverte && gestion,
      avancement: ouverte && (gestion || (responsable && !final)),
      verifier: ouverte && d.valider && a.statut === cx.SA.realisee,
      demande: ouverte && gestion && !final && (a.demandeId == null || !db.get('demandes', a.demandeId) || demandeRefusee) && perms.can(req.perms, 'demandes', 'creer'),
    };
  }
  function ligneAction(req, v, c, a, cx, d) {
    return Object.assign(actionPublique(req, a, cx), {
      visiteId: v.id, visiteNumero: v.numero, visiteTitre: v.titre, visiteTypeCode: v.typeCode, visiteStatut: v.statut, organisme: v.organisme || '',
      secteurId: c.secteurId != null ? Number(c.secteurId) : (v.secteurId == null ? null : Number(v.secteurId)),
      siteNom: nomSite(c.secteurId != null ? c.secteurId : v.secteurId),
      constatId: c.id, constatTypeCode: c.typeCode, exigence: c.exigence || '', constatDescription: String(c.description || '').slice(0, 300),
      actionId: a.id, hoteUserId: v.hoteUserId,
      droits: droitsAction(req, v, a, d || droits(req, v), cx),
    });
  }

  // ----- Validation des enregistrements ---------------------------------------------------------------
  function validerVisite(req, body, existant) {
    const b = objet(body);
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const out = {};
    out.titre = texte(val('titre'), 200, 'Le titre', { requis: true });
    if (out.titre.length < 3) throw new HttpError(400, 'Le titre doit comporter au moins 3 caractères');
    out.typeCode = codeListe('typesVisite', val('typeCode'), 'Type de visite', true);

    const brut = val('secteurId');
    const secteurId = brut === undefined || brut === null || brut === '' ? null : secteurExistant(brut, 'Site visité');
    const actuel = existant && existant.secteurId != null ? Number(existant.secteurId) : null;
    if (!existant || secteurId !== actuel) verifierSecteurEcriture(req, secteurId);
    out.secteurId = secteurId;

    out.organisme = texte(val('organisme'), 200, 'L\'organisme');
    out.referentiel = texte(val('referentiel'), 200, 'Le référentiel');
    const contact = objet(b.contactOrganisme === undefined ? (existant ? existant.contactOrganisme : {}) : b.contactOrganisme);
    if (b.contactOrganisme !== undefined && b.contactOrganisme !== null && typeof b.contactOrganisme !== 'object') throw new HttpError(400, 'Contact de l\'organisme invalide');
    out.contactOrganisme = { nom: texte(contact.nom, 120, 'Le nom du contact'), email: email(contact.email, 'L\'e-mail du contact'), telephone: telephone(contact.telephone, 'Le téléphone du contact') };
    const anonymise = existant && existant.contactOrganisme ? existant.contactOrganisme.anonymiseLe : null;
    if (anonymise && !out.contactOrganisme.email && !out.contactOrganisme.telephone) out.contactOrganisme.anonymiseLe = anonymise;

    out.dateDebut = dateHeure(val('dateDebut'), 'La date de début', true);
    const fin = val('dateFin');
    out.dateFin = fin === undefined || fin === null || fin === '' ? new Date(Date.parse(out.dateDebut) + 4 * 3600000).toISOString() : dateHeure(fin, 'La date de fin', true);
    if (Date.parse(out.dateFin) < Date.parse(out.dateDebut)) throw new HttpError(400, 'La date de fin doit être postérieure à la date de début');
    if (Date.parse(out.dateFin) - Date.parse(out.dateDebut) > DUREE_MAX_JOURS * 86400000) throw new HttpError(400, `Une visite ne peut pas durer plus de ${DUREE_MAX_JOURS} jours`);

    const hote = val('hoteUserId');
    out.hoteUserId = hote === undefined ? req.user.id : utilisateur(hote, 'L\'hôte (responsable de l\'accueil)', { actuel: existant ? existant.hoteUserId : null, req });
    out.participantsUserIds = listeUtilisateurs(val('participantsUserIds'), 'Participants', existant ? existant.participantsUserIds : [], req).filter((id) => id !== out.hoteUserId);
    out.programme = texte(val('programme'), 20000, 'Le programme', { multiligne: true });

    // Zones visitées : secteurs du même site que le secteur visité
    const zonesBrutes = val('zonesVisitees');
    if (zonesBrutes !== undefined && zonesBrutes !== null && !Array.isArray(zonesBrutes)) throw new HttpError(400, 'Zones visitées : liste attendue');
    if ((zonesBrutes || []).length > MAX_ZONES) throw new HttpError(400, `Zones visitées : ${MAX_ZONES} au maximum`);
    const siteVisite = siteDe(secteurId);
    // Changement de site : les constats doivent porter sur des secteurs et équipements du nouveau site
    if (existant && siteVisite != null && siteVisite !== siteDe(actuel)) {
      const sites = new Set();
      const horsSite = (existant.constats || []).filter((c) => {
        const e = c.equipementId != null ? db.get('equipements', c.equipementId) : null;
        const autres = [c.secteurId, e ? e.secteurId : null].filter((s) => s != null && siteDe(Number(s)) !== siteVisite);
        for (const s of autres) sites.add(nomSite(Number(s)) || cheminSecteur(Number(s)));
        return autres.length > 0;
      });
      if (horsSite.length) throw new HttpError(400, `Le site visité ne peut pas être changé : ${horsSite.length} constat(s) portent sur un secteur ou un équipement d'un autre site (${Array.from(sites).filter(Boolean).join(', ') || 'site inconnu'}) ; retirez d'abord leur secteur et leur équipement, puis réaffectez-les sur le nouveau site`);
    }
    out.zonesVisitees = [];
    for (const z of zonesBrutes || []) {
      const id = secteurExistant(z, 'Zone visitée');
      if (siteVisite != null && siteDe(id) !== siteVisite) throw new HttpError(400, `La zone « ${(secteur(id) || {}).nom} » n'appartient pas au site visité`);
      if (!out.zonesVisitees.includes(id)) out.zonesVisitees.push(id);
    }

    // Plan 3D (module Plans) : référence en lecture seule, objets du plan uniquement ; un nouveau plan doit être
    // lisible par l'auteur (même réponse qu'un plan inexistant : aucune énumération des plans)
    const planBrut = val('planId');
    out.planId = null; out.objetIds = [];
    if (planBrut !== undefined && planBrut !== null && planBrut !== '') {
      const pid = entierPositif(planBrut);
      const plan = pid ? db.get('plans', pid) : null;
      const inchange = !!plan && !!existant && existant.planId != null && Number(existant.planId) === plan.id;
      const lisible = !!plan && planLisible(req, plan);
      if (!plan || (!inchange && !lisible)) throw new HttpError(400, 'Plan 3D introuvable');
      if (siteVisite != null && plan.secteurId != null && siteDe(plan.secteurId) !== siteVisite) throw new HttpError(400, 'Le plan 3D choisi ne concerne pas le site visité');
      out.planId = plan.id;
      const objets = val('objetIds');
      if (objets !== undefined && objets !== null && !Array.isArray(objets)) throw new HttpError(400, 'Objets du plan : liste attendue');
      if ((objets || []).length > MAX_OBJETS_PLAN) throw new HttpError(400, `Objets du plan : ${MAX_OBJETS_PLAN} au maximum`);
      const existants = new Set((plan.objets || []).map((o) => String(o.id)));
      for (const o of objets || []) {
        const s = String(o == null ? '' : o);
        if (!/^[\w-]{1,60}$/.test(s) || !existants.has(s)) throw new HttpError(400, 'Objet du plan 3D introuvable');
        if (!out.objetIds.includes(s)) out.objetIds.push(s);
      }
      const avant = (existant && existant.objetIds || []).map(String);
      if (!lisible && (out.objetIds.length !== avant.length || out.objetIds.some((o) => !avant.includes(o)))) throw new HttpError(403, 'Le plan 3D de cette visite est hors de votre périmètre : ses objets ne peuvent pas être modifiés');
    }

    // Résultat de l'audit
    if (b.resultat !== undefined && b.resultat !== null && (typeof b.resultat !== 'object' || Array.isArray(b.resultat))) throw new HttpError(400, 'Résultat invalide');
    const r = objet(b.resultat === undefined ? (existant ? existant.resultat : {}) : b.resultat);
    const certif = r.certificatObtenu;
    out.resultat = {
      conclusion: texte(r.conclusion, 5000, 'La conclusion', { multiligne: true }),
      note: texte(r.note, 60, 'La note / le score'),
      certificatObtenu: certif === undefined || certif === null || certif === '' ? null : booleen(certif),
      dateRapport: dateJour(r.dateRapport, 'La date du rapport'),
    };
    if (b.champs !== undefined || !existant) out.champs = ctx.champsPerso(ENTITE, b.champs || (existant && existant.champs) || {});
    return out;
  }

  function validerPreparation(req, b, existant) {
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    return {
      libelle: texte(val('libelle'), 200, 'Le point de préparation', { requis: true }),
      responsableUserId: utilisateur(val('responsableUserId'), 'Le responsable', { actuel: existant ? existant.responsableUserId : null, req }),
      echeance: dateJour(val('echeance'), 'L\'échéance'),
    };
  }

  function validerVisiteur(req, b, existant, cfg) {
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const out = {
      nom: texte(val('nom'), 80, 'Le nom du visiteur', { requis: true }),
      prenom: texte(val('prenom'), 80, 'Le prénom'),
      societe: texte(val('societe'), 150, 'La société'),
      fonction: texte(val('fonction'), 100, 'La fonction'),
      email: email(val('email'), 'L\'e-mail du visiteur'),
      telephone: telephone(val('telephone'), 'Le téléphone du visiteur'),
      // Minimisation des données : la pièce d'identité n'est conservée que si la configuration la demande
      pieceIdentite: cfg.demanderPieceIdentite ? texte(val('pieceIdentite'), 60, 'La pièce d\'identité') : '',
      vehicule: texte(val('vehicule'), 40, 'Le véhicule (immatriculation)'),
      accompagnateurUserId: utilisateur(val('accompagnateurUserId'), 'L\'accompagnateur', { actuel: existant ? existant.accompagnateurUserId : null, req }),
      epiFournis: listeEpi(val('epiFournis')),
    };
    if (b.charteAcceptee !== undefined) {
      if (booleen(b.charteAcceptee)) { if (!existant || !existant.charteAcceptee) { out.charteAcceptee = true; out.charteAccepteeLe = new Date().toISOString(); } }
      else if (!existant || !existant.arrivee) { out.charteAcceptee = false; out.charteAccepteeLe = null; }
    }
    return out;
  }

  function validerConstat(req, b, existant, v) {
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const out = {
      typeCode: codeListe('typesConstat', val('typeCode'), 'Type de constat', false),
      exigence: texte(val('exigence'), 200, 'L\'exigence (clause du référentiel)'),
      description: texte(val('description'), 5000, 'La description du constat', { requis: true, multiligne: true }),
      preuve: texte(val('preuve'), 2000, 'La preuve / l\'élément observé', { multiligne: true }),
    };
    const eqBrut = val('equipementId');
    out.equipementId = null;
    let secteurId = null;
    if (eqBrut !== undefined && eqBrut !== null && eqBrut !== '') {
      const id = entierPositif(eqBrut);
      // Équipement déjà rattaché : conservé tel quel, même hors de la portée de l'auteur ou supprimé depuis
      const inchange = id != null && !!existant && existant.equipementId != null && Number(existant.equipementId) === id;
      const e = id ? (inchange ? db.get('equipements', id) : equipementVisible(req, id)) : null;
      if (!e && !inchange) throw new HttpError(400, 'Équipement introuvable ou hors de votre portée');
      out.equipementId = id;
      secteurId = e ? (e.secteurId == null ? null : Number(e.secteurId)) : (existant.secteurId == null ? null : Number(existant.secteurId));
    } else {
      const s = val('secteurId');
      secteurId = s === undefined || s === null || s === '' ? null : secteurExistant(s, 'Secteur du constat');
    }
    const siteVisite = siteDe(v.secteurId);
    if (secteurId != null && siteVisite != null && siteDe(secteurId) !== siteVisite) throw new HttpError(400, 'Le secteur (ou l\'équipement) du constat n\'appartient pas au site visité');
    out.secteurId = secteurId;
    return out;
  }

  function validerAction(req, b, existant, cx, gestion) {
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const out = {};
    if (gestion) {
      out.libelle = texte(val('libelle'), 300, 'L\'action', { requis: true });
      out.responsableUserId = utilisateur(val('responsableUserId'), 'Le responsable de l\'action', { requis: true, actuel: existant ? existant.responsableUserId : null, req });
      out.echeance = dateJour(val('echeance'), 'L\'échéance');
    }
    out.commentaire = texte(val('commentaire'), 2000, 'Le commentaire', { multiligne: true });
    const statut = b.statut === undefined ? (existant ? existant.statut : cx.SA.a_faire) : codeListe('statutsAction', b.statut, 'Statut de l\'action', false);
    if (statut === cx.SA.verifiee && (!existant || existant.statut !== statut)) throw new HttpError(400, 'La vérification de l\'efficacité se fait par l\'action « Vérifier l\'efficacité » (droit Valider)');
    if (existant && existant.statut === cx.SA.verifiee && statut !== existant.statut) throw new HttpError(400, 'Cette action a été vérifiée : sa vérification ne peut être annulée que par une nouvelle vérification');
    // Action close (vérifiée ou abandonnée) : décision du gestionnaire, que le responsable ne peut ni annuler ni retoucher
    if (!gestion && existant && cx.finauxAction.has(existant.statut)) throw new HttpError(403, 'Seul un gestionnaire de la visite peut rouvrir ou modifier une action close');
    if (!gestion && cx.finauxAction.has(statut) && (!existant || existant.statut !== statut)) throw new HttpError(403, 'Seul un gestionnaire de la visite peut abandonner une action');
    out.statut = statut;
    const realisation = b.dateRealisation === undefined ? null : dateJour(b.dateRealisation, 'La date de réalisation');
    if (realisation && realisation > aujourdhui()) throw new HttpError(400, 'La date de réalisation ne peut pas être dans le futur');
    if (statut === cx.SA.realisee) out.dateRealisation = realisation || (existant && existant.dateRealisation) || aujourdhui();
    else if (b.dateRealisation !== undefined) out.dateRealisation = realisation;
    else if (!existant) out.dateRealisation = null;
    return out;
  }

  /** Une visite annulée n'est plus modifiable (sauf changement de statut). */
  function verifierModifiable(v, cx) {
    if (v.statut === cx.SV.annulee) throw new HttpError(400, 'Cette visite est annulée : réouvrez-la pour la modifier');
  }
  function trouver(arr, id, message) {
    const n = entierPositif(typeof id === 'number' ? id : String(id == null ? '' : id));
    const i = (arr || []).findIndex((x) => Number(x.id) === n);
    if (i < 0) throw new HttpError(404, message);
    return i;
  }

  // ----- Filtres de liste ------------------------------------------------------------------------------
  function filtrer(req, requete) {
    const q = requete || req.query || {};
    let rows = portee(req, db.list(ENTITE));
    if (q.typeCode) rows = rows.filter((v) => v.typeCode === q.typeCode);
    if (q.statut) { const st = String(q.statut).split(','); rows = rows.filter((v) => st.includes(v.statut)); }
    if (q.secteurId) {
      const id = entierPositif(q.secteurId);
      const ids = new Set(id ? perms.secteursDescendants(db, [id]) : []);
      rows = rows.filter((v) => v.secteurId != null && ids.has(Number(v.secteurId)));
    }
    if (q.hoteUserId) rows = rows.filter((v) => Number(v.hoteUserId) === Number(q.hoteUserId));
    const du = /^\d{4}-\d{2}-\d{2}$/.test(q.du || '') ? q.du : null;
    const au = /^\d{4}-\d{2}-\d{2}$/.test(q.au || '') ? q.au : null;
    if (du) rows = rows.filter((v) => jourLocal(v.dateFin || v.dateDebut) >= du);
    if (au) rows = rows.filter((v) => jourLocal(v.dateDebut) <= au);
    if (q.aVenir === '1') { const maintenant = Date.now(); rows = rows.filter((v) => Date.parse(v.dateFin || v.dateDebut) >= maintenant); }
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase().slice(0, 100);
      rows = rows.filter((v) => [v.numero, v.titre, v.organisme, v.referentiel, (v.contactOrganisme || {}).nom].some((x) => String(x || '').toLowerCase().includes(s))
        || (v.visiteurs || []).some((x) => `${x.prenom || ''} ${x.nom || ''} ${x.societe || ''}`.toLowerCase().includes(s)));
    }
    return rows.sort((a, b) => String(a.dateDebut || '').localeCompare(String(b.dateDebut || '')));
  }

  /** Actions des visites visibles (ouvertes seulement, sauf « toutes »), avec filtres. */
  function actionsVisibles(req, q, cx) {
    const out = [];
    const resp = q.responsableUserId === 'moi' ? req.user.id : entierPositif(q.responsableUserId);
    const site = entierPositif(q.secteurId);
    const ids = site ? new Set(perms.secteursDescendants(db, [site])) : null;
    const limite = /^\d{4}-\d{2}-\d{2}$/.test(q.echeanceAvant || '') ? q.echeanceAvant : null;
    for (const v of portee(req, db.list(ENTITE))) {
      if (q.visiteId && Number(q.visiteId) !== v.id) continue;
      let d = null;
      for (const c of v.constats || []) {
        if (q.typeCode && c.typeCode !== q.typeCode) continue;
        for (const a of c.actions || []) {
          if (q.toutes !== '1' && cx.finauxAction.has(a.statut)) continue;
          if (q.statut && a.statut !== q.statut) continue;
          if (resp && Number(a.responsableUserId) !== resp) continue;
          if (q.echeance === 'retard' && !estEnRetard(a, cx)) continue;
          if (limite && (!a.echeance || a.echeance > limite)) continue;
          d = d || droits(req, v);
          const ligne = ligneAction(req, v, c, a, cx, d);
          if (ids && !(ligne.secteurId != null && ids.has(ligne.secteurId))) continue;
          out.push(ligne);
        }
      }
    }
    return out.sort((a, b) => String(a.echeance || '9999').localeCompare(String(b.echeance || '9999')) || a.visiteId - b.visiteId);
  }

  /** Registre d'accueil d'une journée et personnes présentes sur le site (toutes dates confondues). */
  function registre(req, jour) {
    const attendus = []; const presents = [];
    const annulee = contexte().SV.annulee;
    for (const v of portee(req, db.list(ENTITE))) {
      const debut = jourLocal(v.dateDebut); const fin = jourLocal(v.dateFin || v.dateDebut);
      const duJour = debut <= jour && jour <= fin && v.statut !== annulee;
      // Accueil possible (arrivée, départ) : mêmes conditions que les routes (site en lecture seule exclu)
      const accueil = (v.visiteurs || []).length ? droits(req, v).accueil : false;
      for (const x of v.visiteurs || []) {
        const l = Object.assign(ligneRegistre(v, x), { droits: { accueil } });
        if (duJour || (x.arrivee && jourLocal(x.arrivee) === jour)) attendus.push(l);
        if (x.arrivee && !x.depart) presents.push(l);
      }
    }
    const tri = (a, b) => String(a.dateDebut).localeCompare(String(b.dateDebut)) || `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr');
    attendus.sort(tri); presents.sort(tri);
    return {
      date: jour, attendus, presents,
      nbAttendus: attendus.length, nbPresents: presents.length,
      nbArrives: attendus.filter((l) => l.arrivee).length, nbPartis: attendus.filter((l) => l.depart).length,
    };
  }

  // ----- Routes : consultation ----------------------------------------------------------------------
  router.get('/api/visites', async (req) => { const cx = contexte(); return filtrer(req).map((v) => resume(v, cx)); }, { perm: [MODULE, 'voir'] });

  router.get('/api/visites-tableau', async (req) => {
    const cx = contexte();
    const rows = portee(req, db.list(ENTITE));
    const maintenant = Date.now();
    const dans30 = ajouterJours(cx.jour, 30);
    const actives = rows.filter((v) => !cx.finauxVisite.has(v.statut));
    const aVenir = actives.filter((v) => Date.parse(v.dateFin || v.dateDebut) >= maintenant).sort((a, b) => String(a.dateDebut).localeCompare(String(b.dateDebut)));
    const parType = new Map();
    let ncOuvertes = 0;
    for (const v of rows) for (const c of v.constats || []) if (constatOuvert(c, cx)) { parType.set(c.typeCode, (parType.get(c.typeCode) || 0) + 1); if (cx.nc.has(c.typeCode)) ncOuvertes++; }
    const actions = actionsVisibles(req, {}, cx);
    const retard = actions.filter((a) => a.enRetard);
    const presents = registre(req, cx.jour).presents;
    const prepIncompletes = aVenir.filter((v) => jourLocal(v.dateDebut) <= ajouterJours(cx.jour, 14)).map((v) => resume(v, cx)).filter((r) => r.preparationTotal > r.preparationFaits);
    return {
      date: cx.jour,
      kpi: {
        aVenir: aVenir.length, aVenir30: aVenir.filter((v) => jourLocal(v.dateDebut) <= dans30).length,
        aujourdhui: rows.filter((v) => v.statut !== cx.SV.annulee && jourLocal(v.dateDebut) <= cx.jour && cx.jour <= jourLocal(v.dateFin || v.dateDebut)).length,
        presents: presents.length, ncOuvertes, actionsOuvertes: actions.length, actionsEnRetard: retard.length,
      },
      prochaines: aVenir.slice(0, 10).map((v) => resume(v, cx)),
      presents,
      constatsOuvertsParType: ctx.liste('typesConstat').map((t) => ({ typeCode: t.code, label: t.label, couleur: t.couleur || '', nombre: parType.get(t.code) || 0 })),
      actionsEnRetard: retard.slice(0, 25),
      preparationsIncompletes: prepIncompletes.slice(0, 10),
    };
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/visites-registre', async (req) => {
    const q = req.query || {};
    const jour = q.date ? dateJour(String(q.date), 'Date du registre') : aujourdhui();
    return registre(req, jour);
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/visites-actions', async (req) => actionsVisibles(req, req.query || {}, contexte()), { perm: [MODULE, 'voir'] });

  // ----- Exports CSV ---------------------------------------------------------------------------------
  function envoyerCsv(res, nomFichier, entetes, lignes) {
    const contenu = '﻿' + [entetes].concat(lignes).map(csvLigne).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nomFichier}-${aujourdhui()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(contenu);
  }
  router.get('/api/visites-export/:quoi', async (req, res) => {
    const quoi = req.params.quoi;
    const cx = contexte();
    const q = req.query || {};
    if (quoi === 'visites') {
      const champs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
      const lignes = filtrer(req).map((v) => {
        const r = resume(v, cx);
        return [r.numero, r.titre, libelle('typesVisite', r.typeCode), libelle('statutsVisite', r.statut), r.secteurChemin, r.organisme, r.referentiel, frDateHeure(r.dateDebut), frDateHeure(r.dateFin), r.hoteNom,
          (v.participantsUserIds || []).map((id) => ctx.nomUser(id)).join(', '), r.nbVisiteurs, r.nbPresents, r.nbConstats, r.nbNc, r.actionsOuvertes, r.actionsEnRetard,
          (v.resultat || {}).conclusion || '', r.certificatObtenu == null ? '' : (r.certificatObtenu ? 'Oui' : 'Non')]
          .concat(champs.map((c) => { const x = (v.champs || {})[c.cle]; return x == null ? '' : (typeof x === 'boolean' ? (x ? 'Oui' : 'Non') : x); }));
      });
      ctx.audit(req, 'export', ENTITE, null, `Export CSV des visites : ${lignes.length} ligne(s)`);
      return envoyerCsv(res, 'visites', ['Numéro', 'Titre', 'Type', 'Statut', 'Site / secteur', 'Organisme', 'Référentiel', 'Début', 'Fin', 'Hôte', 'Participants', 'Visiteurs', 'Présents', 'Constats', 'Non-conformités', 'Actions ouvertes', 'Actions en retard', 'Conclusion', 'Certificat obtenu'].concat(champs.map((c) => c.label)), lignes);
    }
    if (quoi === 'registre') {
      // Registre des visiteurs : sans coordonnées personnelles (minimisation des données)
      const du = q.du ? dateJour(String(q.du), 'Date de début') : null;
      const au = q.au ? dateJour(String(q.au), 'Date de fin') : null;
      const lignes = [];
      for (const v of filtrer(req, { du: du || '', au: au || '', secteurId: q.secteurId || '', typeCode: q.typeCode || '' })) {
        for (const x of v.visiteurs || []) {
          if (du && x.arrivee && jourLocal(x.arrivee) < du) continue;
          lignes.push([frJour(jourLocal(v.dateDebut)), v.numero, v.titre, v.organisme || '', nomSite(v.secteurId) || cheminSecteur(v.secteurId), x.nom, x.prenom || '', x.societe || '', x.fonction || '', ctx.nomUser(v.hoteUserId), ctx.nomUser(x.accompagnateurUserId), x.badgeNumero || '', x.charteAcceptee ? 'Oui' : 'Non', frDateHeure(x.arrivee), frDateHeure(x.depart), (x.epiFournis || []).join(', ')]);
        }
      }
      ctx.audit(req, 'export', ENTITE, null, `Export CSV du registre des visiteurs : ${lignes.length} ligne(s)`);
      return envoyerCsv(res, 'registre-visiteurs', ['Date', 'Visite', 'Titre', 'Organisme', 'Site', 'Nom', 'Prénom', 'Société', 'Fonction', 'Hôte', 'Accompagnateur', 'Badge', 'Charte acceptée', 'Arrivée', 'Départ', 'EPI fournis'], lignes);
    }
    if (quoi === 'actions') {
      const lignes = actionsVisibles(req, q, cx).map((a) => [a.visiteNumero, a.visiteTitre, a.organisme, libelle('typesConstat', a.constatTypeCode), a.exigence, a.constatDescription, a.libelle, a.responsableNom, frJour(a.echeance), libelle('statutsAction', a.statut), a.enRetard ? 'Oui' : 'Non', frJour(a.dateRealisation), a.verifieParNom, frDateHeure(a.dateVerification), a.demande ? a.demande.numero : '', a.commentaire || '']);
      ctx.audit(req, 'export', ENTITE, null, `Export CSV du plan d'actions : ${lignes.length} ligne(s)`);
      return envoyerCsv(res, 'plan-actions-visites', ['Visite', 'Titre de la visite', 'Organisme', 'Type de constat', 'Exigence', 'Constat', 'Action', 'Responsable', 'Échéance', 'Statut', 'En retard', 'Réalisée le', 'Vérifiée par', 'Vérifiée le', 'Demande liée', 'Commentaire'], lignes);
    }
    throw new HttpError(404, 'Export inconnu (visites, registre ou actions)');
  }, { perm: [MODULE, 'exporter'] });

  // ----- Routes : visites ------------------------------------------------------------------------------
  router.get('/api/visites/:id', async (req) => detail(req, getVisible(req, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/visites', async (req) => {
    const b = objet(req.body);
    const cx = contexte();
    const cfg = cfgVisites();
    const data = validerVisite(req, b, null);
    const etat = { sequence: 0 };
    let statut = cx.SV.planifiee;
    if (b.statut !== undefined && b.statut !== null && b.statut !== '') {
      statut = codeListe('statutsVisite', b.statut, 'Statut', false);
      if (cx.finauxVisite.has(statut)) throw new HttpError(400, 'Une visite ne peut pas être créée directement au statut final');
    }
    // Check-list et visiteurs fournis à la création
    const prepBrute = b.preparation === undefined || b.preparation === null ? [] : b.preparation;
    if (!Array.isArray(prepBrute)) throw new HttpError(400, 'Préparation : liste attendue');
    if (prepBrute.length > MAX_PREPARATION) throw new HttpError(400, `Préparation : ${MAX_PREPARATION} points au maximum`);
    const preparation = prepBrute.map((p) => Object.assign({ id: nouvelId(etat) }, validerPreparation(req, objet(p), null), { fait: booleen(objet(p).fait), faitLe: booleen(objet(p).fait) ? new Date().toISOString() : null, faitPar: booleen(objet(p).fait) ? req.user.id : null }));
    const visBruts = b.visiteurs === undefined || b.visiteurs === null ? [] : b.visiteurs;
    if (!Array.isArray(visBruts)) throw new HttpError(400, 'Visiteurs : liste attendue');
    if (visBruts.length > MAX_VISITEURS) throw new HttpError(400, `Visiteurs : ${MAX_VISITEURS} au maximum`);
    const pris = badgesUtilises();
    const visiteurs = visBruts.map((x) => Object.assign({ id: nouvelId(etat), charteAcceptee: false, charteAccepteeLe: null }, validerVisiteur(req, objet(x), null, cfg), { arrivee: null, depart: null, badgeNumero: nouveauBadge(pris) }));
    const v = db.insert(ENTITE, Object.assign(data, {
      numero: numeroUnique(), statut, preparation, visiteurs, constats: [], documents: [], sequence: etat.sequence,
      motifAnnulation: '', dateCloture: null, rappelEnvoye: null, createdBy: req.user.id,
      historique: [{ date: new Date().toISOString(), userId: req.user.id, action: 'creation', details: `Visite créée (${libelle('typesVisite', data.typeCode)})` }],
    }));
    ctx.audit(req, 'creation', ENTITE, v.id, `Visite ${v.numero} : ${v.titre} (${periodeTexte(v)})`);
    notifier(req, [v.hoteUserId], { titre: `Visite ${v.numero} : vous êtes l'hôte`, message: `${ctx.nomUser(req.user.id)} vous a désigné(e) responsable de l'accueil de « ${v.titre} »${v.organisme ? ' (' + v.organisme + ')' : ''} ${periodeTexte(v)}`, lien: lienVisite(v), type: 'info' });
    notifier(req, (v.participantsUserIds || []).filter((id) => id !== v.hoteUserId), { titre: `Visite ${v.numero} : vous êtes participant(e)`, message: `« ${v.titre} »${v.organisme ? ' (' + v.organisme + ')' : ''} ${periodeTexte(v)} — hôte : ${ctx.nomUser(v.hoteUserId)}`, lien: lienVisite(v), type: 'info' });
    notifier(req, preparation.map((p) => p.responsableUserId), { titre: `Visite ${v.numero} : préparation`, message: `Un ou plusieurs points de préparation de « ${v.titre} » vous sont confiés`, lien: lienVisite(v, 'preparation'), type: 'info' });
    ctx.emit('visite:creee', { visite: v });
    return detail(req, v);
  }, { perm: [MODULE, 'creer'], maxBody: CORPS_MAX });

  router.put('/api/visites/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    const cx = contexte();
    verifierModifiable(existant, cx);
    const data = validerVisite(req, req.body, existant);
    const changes = [];
    const LIB = { titre: 'titre', typeCode: 'type', secteurId: 'site', organisme: 'organisme', referentiel: 'référentiel', contactOrganisme: 'contact', dateDebut: 'date de début', dateFin: 'date de fin', hoteUserId: 'hôte', participantsUserIds: 'participants', programme: 'programme', zonesVisitees: 'zones', planId: 'plan 3D', objetIds: 'objets du plan', resultat: 'résultat', champs: 'champs complémentaires' };
    for (const k of Object.keys(data)) if (JSON.stringify(data[k] == null ? null : data[k]) !== JSON.stringify(existant[k] == null ? null : existant[k])) changes.push(LIB[k] || k);
    if (!changes.length) return detail(req, existant);
    const datesChangees = data.dateDebut !== existant.dateDebut || data.dateFin !== existant.dateFin;
    if (data.dateDebut !== existant.dateDebut) data.rappelEnvoye = null;
    const v = enregistrer(req, existant, data, 'modification', 'Modifié : ' + changes.join(', '));
    if (datesChangees) notifier(req, equipeVisite(v), { titre: `Visite ${v.numero} : changement de date`, message: `« ${v.titre} » a lieu désormais ${periodeTexte(v)}`, lien: lienVisite(v), type: 'alerte' });
    if (Number(v.hoteUserId) !== Number(existant.hoteUserId)) notifier(req, [v.hoteUserId], { titre: `Visite ${v.numero} : vous êtes l'hôte`, message: `${ctx.nomUser(req.user.id)} vous a désigné(e) responsable de l'accueil de « ${v.titre} » ${periodeTexte(v)}`, lien: lienVisite(v), type: 'info' });
    const nouveaux = (v.participantsUserIds || []).filter((id) => !(existant.participantsUserIds || []).map(Number).includes(Number(id)));
    if (nouveaux.length && !datesChangees) notifier(req, nouveaux, { titre: `Visite ${v.numero} : vous êtes participant(e)`, message: `« ${v.titre} » ${periodeTexte(v)} — hôte : ${ctx.nomUser(v.hoteUserId)}`, lien: lienVisite(v), type: 'info' });
    return detail(req, v);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.delete('/api/visites/:id', async (req) => {
    const v = getVisible(req, req.params.id);
    const accueillis = (v.visiteurs || []).filter((x) => x.arrivee).length;
    if (accueillis) throw new HttpError(400, `La visite ${v.numero} a déjà accueilli ${accueillis} visiteur(s) (registre de sécurité) : annulez-la ou clôturez-la plutôt que de la supprimer`);
    const liees = (v.constats || []).reduce((n, c) => n + (c.actions || []).filter((a) => a.demandeId != null).length, 0);
    if (liees) throw new HttpError(400, `La visite ${v.numero} a des actions liées à ${liees} demande(s) d'intervention : annulez-la plutôt que de la supprimer`);
    db.remove(ENTITE, v.id);
    ctx.audit(req, 'suppression', ENTITE, v.id, `Visite ${v.numero} : ${v.titre}`);
    if (Date.parse(v.dateFin || v.dateDebut) > Date.now()) notifier(req, equipeVisite(v), { titre: `Visite ${v.numero} supprimée`, message: `${ctx.nomUser(req.user.id)} a supprimé la visite « ${v.titre} » prévue ${periodeTexte(v)}`, lien: '#/visites', type: 'alerte' });
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  router.post('/api/visites/:id/statut', async (req) => {
    const v = getVisible(req, req.params.id);
    const cx = contexte();
    const b = objet(req.body);
    const statut = codeListe('statutsVisite', b.statut, 'Statut', false);
    if (statut === v.statut) throw new HttpError(400, `La visite est déjà au statut « ${libelle('statutsVisite', statut)} »`);
    const finalAvant = cx.finauxVisite.has(v.statut);
    const finalApres = cx.finauxVisite.has(statut);
    // Toute sortie d'un statut final (réouverture, ou passage d'« annulée » à « terminée » qui rendrait la
    // visite de nouveau modifiable) est réservée au droit valider
    if (finalAvant) ctx.requirePerm(req, MODULE, 'valider');
    const motif = texte(b.motif, 1000, 'Le motif', { multiligne: true });
    if (statut === cx.SV.annulee && !motif) throw new HttpError(400, 'Le motif d\'annulation est obligatoire');
    let visiteurs = v.visiteurs || [];
    const presents = visiteurs.filter((x) => x.arrivee && !x.depart);
    let departs = 0;
    if (finalApres && presents.length) {
      // Sécurité : la liste des présents doit rester exacte (évacuation)
      if (!booleen(b.enregistrerDeparts)) throw new HttpError(409, `${presents.length} visiteur(s) encore présent(s) sur le site : enregistrez leur départ avant de clôturer la visite`, { presents: presents.map((x) => nomVisiteur(x)) });
      const maintenant = new Date().toISOString();
      visiteurs = visiteurs.map((x) => (x.arrivee && !x.depart ? Object.assign({}, x, { depart: maintenant, departPar: req.user.id, departAutomatique: true }) : x));
      departs = presents.length;
    }
    const patch = { statut, visiteurs, dateCloture: finalApres ? new Date().toISOString() : null };
    patch.motifAnnulation = statut === cx.SV.annulee ? motif : '';
    const maj = enregistrer(req, v, patch, 'statut', `${libelle('statutsVisite', v.statut)} → ${libelle('statutsVisite', statut)}${motif ? ' — ' + motif : ''}${departs ? ` (départ enregistré pour ${departs} visiteur(s) présent(s))` : ''}`, 'statut');
    const message = statut === cx.SV.annulee ? `« ${maj.titre} » prévue ${periodeTexte(maj)} est annulée${motif ? ' : ' + motif : ''}` : `« ${maj.titre} » (${periodeTexte(maj)}) : ${libelle('statutsVisite', v.statut)} → ${libelle('statutsVisite', statut)}`;
    notifier(req, equipeVisite(maj), { titre: `Visite ${maj.numero} : ${libelle('statutsVisite', statut)}`, message, lien: lienVisite(maj), type: statut === cx.SV.annulee ? 'alerte' : 'info' });
    ctx.emit('visite:statut', { visite: maj, ancien: v.statut, nouveau: statut });
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  // ----- Routes : préparation ----------------------------------------------------------------------------
  router.post('/api/visites/:id/preparation', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const b = objet(req.body);
    const elements = Array.isArray(b.elements) ? b.elements : [b];
    if (!elements.length || elements.length > 30) throw new HttpError(400, 'De 1 à 30 points de préparation par envoi');
    const preparation = cloner(v.preparation);
    if (preparation.length + elements.length > MAX_PREPARATION) throw new HttpError(400, `Préparation : ${MAX_PREPARATION} points au maximum`);
    const etat = { sequence: v.sequence };
    const ajoutes = elements.map((e) => Object.assign({ id: nouvelId(etat) }, validerPreparation(req, objet(e), null), { fait: false, faitLe: null, faitPar: null, alerteRetard: null }));
    const maj = enregistrer(req, v, { preparation: preparation.concat(ajoutes), sequence: etat.sequence }, 'preparation', `Préparation : ${ajoutes.map((p) => p.libelle).join(' ; ').slice(0, 300)}`);
    for (const p of ajoutes) if (p.responsableUserId != null) notifier(req, [p.responsableUserId], { titre: `Visite ${maj.numero} : préparation`, message: `« ${p.libelle} » vous est confié${p.echeance ? ' pour le ' + frJour(p.echeance) : ''} (visite « ${maj.titre} » ${periodeTexte(maj)})`, lien: lienVisite(maj, 'preparation'), type: 'info' });
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.put('/api/visites/:id/preparation/:pid', async (req) => {
    const responsableDuPoint = (r, vv) => r.responsablePreparation && (vv.preparation || []).some((p) => Number(p.id) === Number(req.params.pid) && Number(p.responsableUserId) === req.user.id);
    const v = getVisible(req, req.params.id, responsableDuPoint);
    verifierModifiable(v, contexte());
    const b = objet(req.body);
    const preparation = cloner(v.preparation);
    const i = trouver(preparation, req.params.pid, 'Point de préparation introuvable');
    const p = preparation[i];
    const gestion = gestionnaire(req) && ecritureComplete(req, v);
    if (!gestion) {
      // Le responsable du point peut seulement le cocher / décocher
      if (Number(p.responsableUserId) !== req.user.id) throw new HttpError(403, 'Droit insuffisant : Audits & visites › Modifier');
      for (const k of Object.keys(b)) if (k !== 'fait') throw new HttpError(403, 'Seul l\'état « fait » de vos points de préparation peut être mis à jour');
    }
    const avant = Object.assign({}, p);
    if (gestion && (b.libelle !== undefined || b.responsableUserId !== undefined || b.echeance !== undefined)) Object.assign(p, validerPreparation(req, b, p));
    if (b.fait !== undefined) { const f = booleen(b.fait); if (f !== !!p.fait) { p.fait = f; p.faitLe = f ? new Date().toISOString() : null; p.faitPar = f ? req.user.id : null; } }
    if (JSON.stringify(avant) === JSON.stringify(p)) return detail(req, v);
    const maj = enregistrer(req, v, { preparation }, 'preparation', `Préparation « ${p.libelle} »${avant.fait !== p.fait ? (p.fait ? ' : fait' : ' : à refaire') : ' modifiée'}`);
    if (p.responsableUserId != null && Number(p.responsableUserId) !== Number(avant.responsableUserId)) notifier(req, [p.responsableUserId], { titre: `Visite ${maj.numero} : préparation`, message: `« ${p.libelle} » vous est confié${p.echeance ? ' pour le ' + frJour(p.echeance) : ''}`, lien: lienVisite(maj, 'preparation'), type: 'info' });
    return detail(req, maj);
  }, { perm: [MODULE, 'voir'], maxBody: CORPS_MAX });

  router.delete('/api/visites/:id/preparation/:pid', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const preparation = cloner(v.preparation);
    const i = trouver(preparation, req.params.pid, 'Point de préparation introuvable');
    const [sup] = preparation.splice(i, 1);
    return detail(req, enregistrer(req, v, { preparation }, 'preparation', `Point de préparation supprimé : « ${sup.libelle} »`));
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : visiteurs -------------------------------------------------------------------------------
  router.get('/api/visites/:id/visiteurs/:vid', async (req) => {
    const v = getVisible(req, req.params.id);
    const d = droits(req, v);
    if (!d.modifier && !d.accueil) throw new HttpError(403, 'Droit insuffisant : Audits & visites › Modifier');
    const x = (v.visiteurs || [])[trouver(v.visiteurs, req.params.vid, 'Visiteur introuvable')];
    return Object.assign(visiteurPublic(x, true), { pieceIdentite: x.pieceIdentite || '' });
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/visites/:id/visiteurs', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const visiteurs = cloner(v.visiteurs);
    if (visiteurs.length >= MAX_VISITEURS) throw new HttpError(400, `Visiteurs : ${MAX_VISITEURS} au maximum`);
    const etat = { sequence: v.sequence };
    const x = Object.assign({ id: nouvelId(etat), charteAcceptee: false, charteAccepteeLe: null }, validerVisiteur(req, objet(req.body), null, cfgVisites()), { arrivee: null, depart: null, badgeNumero: nouveauBadge() });
    const maj = enregistrer(req, v, { visiteurs: visiteurs.concat([x]), sequence: etat.sequence }, 'visiteur', `Visiteur ajouté : ${nomVisiteur(x)}${x.societe ? ' (' + x.societe + ')' : ''}`);
    if (x.accompagnateurUserId != null) notifier(req, [x.accompagnateurUserId], { titre: `Visite ${maj.numero} : accompagnement`, message: `Vous accompagnerez ${nomVisiteur(x)}${x.societe ? ' (' + x.societe + ')' : ''} lors de « ${maj.titre} » ${periodeTexte(maj)}`, lien: lienVisite(maj, 'visiteurs'), type: 'info' });
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.put('/api/visites/:id/visiteurs/:vid', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const visiteurs = cloner(v.visiteurs);
    const i = trouver(visiteurs, req.params.vid, 'Visiteur introuvable');
    const avant = visiteurs[i];
    if (avant.anonymiseLe) throw new HttpError(400, 'Les données de ce visiteur ont été anonymisées (conservation limitée) : modification impossible');
    const x = Object.assign({}, avant, validerVisiteur(req, objet(req.body), avant, cfgVisites()));
    visiteurs[i] = x;
    const maj = enregistrer(req, v, { visiteurs }, 'visiteur', `Visiteur modifié : ${nomVisiteur(x)}`);
    if (x.accompagnateurUserId != null && Number(x.accompagnateurUserId) !== Number(avant.accompagnateurUserId)) notifier(req, [x.accompagnateurUserId], { titre: `Visite ${maj.numero} : accompagnement`, message: `Vous accompagnerez ${nomVisiteur(x)}${x.societe ? ' (' + x.societe + ')' : ''} lors de « ${maj.titre} » ${periodeTexte(maj)}`, lien: lienVisite(maj, 'visiteurs'), type: 'info' });
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.delete('/api/visites/:id/visiteurs/:vid', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const visiteurs = cloner(v.visiteurs);
    const i = trouver(visiteurs, req.params.vid, 'Visiteur introuvable');
    if (visiteurs[i].arrivee) {
      if (!visiteurs[i].depart) throw new HttpError(400, 'Ce visiteur est présent sur le site : enregistrez son départ avant de le retirer');
      ctx.requirePerm(req, MODULE, 'supprimer'); // passage inscrit au registre : suppression réservée
    }
    const [sup] = visiteurs.splice(i, 1);
    return detail(req, enregistrer(req, v, { visiteurs }, 'visiteur', `Visiteur retiré : ${nomVisiteur(sup)}${sup.arrivee ? ' (passage du ' + frDateHeure(sup.arrivee) + ' effacé du registre)' : ''}`));
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : registre d'accueil -------------------------------------------------------------------------
  function enregistrerArrivee(req, v, vid, b) {
    const cx = contexte();
    const cfg = cfgVisites();
    if (v.statut === cx.SV.annulee) throw new HttpError(400, 'Cette visite est annulée : arrivée impossible');
    if (cx.finauxVisite.has(v.statut)) throw new HttpError(400, 'Cette visite est clôturée : arrivée impossible');
    const jour = aujourdhui();
    const debut = ajouterJours(jourLocal(v.dateDebut), -1); const fin = ajouterJours(jourLocal(v.dateFin || v.dateDebut), 1);
    if (jour < debut || jour > fin) throw new HttpError(400, `Cette visite est prévue ${periodeTexte(v)} : l'arrivée ne peut être enregistrée que pendant la visite`);
    const visiteurs = cloner(v.visiteurs);
    const i = trouver(visiteurs, vid, 'Visiteur introuvable');
    const x = visiteurs[i];
    if (x.arrivee && !x.depart) throw new HttpError(409, `${nomVisiteur(x)} est déjà enregistré(e) sur le site depuis ${frHeure(x.arrivee)}`);
    if (x.depart) throw new HttpError(409, `${nomVisiteur(x)} a déjà quitté le site à ${frHeure(x.depart)}`);
    if (x.anonymiseLe) throw new HttpError(400, 'Les données de ce visiteur ont été anonymisées : arrivée impossible');
    // Charte de sécurité, pièce d'identité, accompagnement : selon la configuration
    if (cfg.charteSecurite && !x.charteAcceptee && !booleen(b.charteAcceptee)) throw new HttpError(400, 'Le visiteur doit prendre connaissance de la charte de sécurité et l\'accepter avant d\'entrer sur le site');
    if (booleen(b.charteAcceptee) && !x.charteAcceptee) { x.charteAcceptee = true; x.charteAccepteeLe = new Date().toISOString(); }
    if (cfg.demanderPieceIdentite) {
      if (b.pieceIdentite !== undefined) x.pieceIdentite = texte(b.pieceIdentite, 60, 'La pièce d\'identité');
      if (!x.pieceIdentite) throw new HttpError(400, 'La pièce d\'identité du visiteur est obligatoire (type et numéro)');
    }
    if (b.vehicule !== undefined) x.vehicule = texte(b.vehicule, 40, 'Le véhicule (immatriculation)');
    if (b.epiFournis !== undefined) x.epiFournis = listeEpi(b.epiFournis);
    if (b.accompagnateurUserId !== undefined && b.accompagnateurUserId !== null && b.accompagnateurUserId !== '') x.accompagnateurUserId = utilisateur(b.accompagnateurUserId, 'L\'accompagnateur', { actuel: x.accompagnateurUserId, req });
    if (x.accompagnateurUserId == null && cfg.accompagnementObligatoire) {
      if (v.hoteUserId == null) throw new HttpError(400, 'L\'accompagnement des visiteurs est obligatoire : désignez un accompagnateur');
      x.accompagnateurUserId = Number(v.hoteUserId);
    }
    x.arrivee = horodatage(b.horodatage, 'Heure d\'arrivée');
    // Même fenêtre que le contrôle du jour : au plus tôt la veille du premier jour de la visite (registre de sécurité)
    const auPlusTot = new Date(debut + 'T00:00:00');
    if (Date.parse(x.arrivee) < auPlusTot.getTime()) throw new HttpError(400, `Heure d'arrivée : antérieure à la visite (prévue ${periodeTexte(v)}) ; au plus tôt le ${frJour(debut)}`);
    x.arriveePar = req.user.id;
    if (!x.badgeNumero) x.badgeNumero = nouveauBadge();
    const patch = { visiteurs };
    let suffixe = '';
    if (v.statut === cx.SV.planifiee || v.statut === cx.SV.confirmee) { patch.statut = cx.SV.en_cours; suffixe = ` ; visite passée « ${libelle('statutsVisite', cx.SV.en_cours)} »`; }
    const maj = enregistrer(req, v, patch, 'arrivee', `Arrivée de ${nomVisiteur(x)}${x.societe ? ' (' + x.societe + ')' : ''} à ${frHeure(x.arrivee)} — badge ${x.badgeNumero}${suffixe}`, 'arrivee');
    notifier(req, [maj.hoteUserId, x.accompagnateurUserId], { titre: `Visiteur arrivé : ${nomVisiteur(x)}`, message: `${nomVisiteur(x)}${x.societe ? ' (' + x.societe + ')' : ''} est arrivé(e) à l'accueil à ${frHeure(x.arrivee)} pour « ${maj.titre} »`, lien: lienVisite(maj, 'visiteurs'), type: 'info' });
    ctx.emit('visite:arrivee', { visite: maj, visiteur: x });
    if (patch.statut) ctx.emit('visite:statut', { visite: maj, ancien: v.statut, nouveau: patch.statut });
    return { visite: maj, visiteur: x };
  }
  function enregistrerDepart(req, v, vid, b) {
    const visiteurs = cloner(v.visiteurs);
    const i = trouver(visiteurs, vid, 'Visiteur introuvable');
    const x = visiteurs[i];
    if (!x.arrivee) throw new HttpError(400, `L'arrivée de ${nomVisiteur(x)} n'a pas été enregistrée`);
    if (x.depart) throw new HttpError(409, `Le départ de ${nomVisiteur(x)} est déjà enregistré (${frHeure(x.depart)})`);
    x.depart = horodatage(b.horodatage, 'Heure de départ');
    if (Date.parse(x.depart) < Date.parse(x.arrivee)) throw new HttpError(400, 'L\'heure de départ doit être postérieure à l\'arrivée');
    x.departPar = req.user.id;
    const maj = enregistrer(req, v, { visiteurs }, 'depart', `Départ de ${nomVisiteur(x)} à ${frHeure(x.depart)}${b.parBadge ? ' (scan du badge)' : ''}`, 'depart');
    ctx.emit('visite:depart', { visite: maj, visiteur: x });
    return { visite: maj, visiteur: x };
  }

  router.post('/api/visites/:id/visiteurs/:vid/arrivee', async (req) => {
    const v = getVisible(req, req.params.id, ACCUEIL);
    const r = enregistrerArrivee(req, v, req.params.vid, objet(req.body));
    return detail(req, r.visite);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.post('/api/visites/:id/visiteurs/:vid/depart', async (req) => {
    const v = getVisible(req, req.params.id, ACCUEIL);
    const r = enregistrerDepart(req, v, req.params.vid, objet(req.body));
    return detail(req, r.visite);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  /** Scan du badge à la sortie : enregistre le départ du visiteur. */
  router.post('/api/visites-registre/scan', async (req) => {
    const code = texte(objet(req.body).code, 40, 'Code du badge', { requis: true }).toUpperCase();
    for (const v of db.list(ENTITE)) {
      const x = (v.visiteurs || []).find((y) => String(y.badgeNumero || '').toUpperCase() === code);
      if (!x) continue;
      if (!visibleLecture(req, v)) break;
      if (!interventionPossible(req, v, ACCUEIL)) throw new HttpError(403, secteurLectureSeule(req, v) ? 'Ce site est accessible en lecture seule pour vous : modification impossible' : 'Cette visite est hors de votre portée');
      const r = enregistrerDepart(req, v, x.id, { parBadge: true });
      return { action: 'depart', visite: { id: r.visite.id, numero: r.visite.numero, titre: r.visite.titre }, visiteur: ligneRegistre(r.visite, r.visiteur) };
    }
    throw new HttpError(404, `Badge « ${code} » inconnu`);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  // ----- Routes : constats ------------------------------------------------------------------------------------
  router.post('/api/visites/:id/constats', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const constats = cloner(v.constats);
    if (constats.length >= MAX_CONSTATS) throw new HttpError(400, `Constats : ${MAX_CONSTATS} au maximum`);
    const etat = { sequence: v.sequence };
    const c = Object.assign({ id: nouvelId(etat) }, validerConstat(req, objet(req.body), null, v), { actions: [], createdBy: req.user.id, createdAt: new Date().toISOString() });
    const maj = enregistrer(req, v, { constats: constats.concat([c]), sequence: etat.sequence }, 'constat', `Constat ajouté (${libelle('typesConstat', c.typeCode)}${c.exigence ? ', ' + c.exigence : ''})`);
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.put('/api/visites/:id/constats/:cid', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const constats = cloner(v.constats);
    const i = trouver(constats, req.params.cid, 'Constat introuvable');
    constats[i] = Object.assign({}, constats[i], validerConstat(req, objet(req.body), constats[i], v));
    return detail(req, enregistrer(req, v, { constats }, 'constat', `Constat modifié (${libelle('typesConstat', constats[i].typeCode)}${constats[i].exigence ? ', ' + constats[i].exigence : ''})`));
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.delete('/api/visites/:id/constats/:cid', async (req) => {
    const v = getVisible(req, req.params.id);
    const cx = contexte();
    verifierModifiable(v, cx);
    const constats = cloner(v.constats);
    const i = trouver(constats, req.params.cid, 'Constat introuvable');
    if ((constats[i].actions || []).some((a) => a.demandeId != null)) throw new HttpError(400, 'Ce constat a une action liée à une demande d\'intervention : il ne peut pas être supprimé (traçabilité)');
    // Même règle que la suppression d'une action : une efficacité vérifiée ne s'efface qu'avec le droit supprimer
    if ((constats[i].actions || []).some((a) => a.statut === cx.SA.verifiee)) ctx.requirePerm(req, MODULE, 'supprimer');
    const [sup] = constats.splice(i, 1);
    return detail(req, enregistrer(req, v, { constats }, 'constat', `Constat supprimé (${libelle('typesConstat', sup.typeCode)}${sup.exigence ? ', ' + sup.exigence : ''}, ${(sup.actions || []).length} action(s))`));
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : actions -------------------------------------------------------------------------------------
  function trouverAction(v, cid, aid) {
    const constats = cloner(v.constats).map((c) => Object.assign(c, { actions: cloner(c.actions) }));
    const ci = trouver(constats, cid, 'Constat introuvable');
    const ai = trouver(constats[ci].actions, aid, 'Action introuvable');
    return { constats, c: constats[ci], a: constats[ci].actions[ai], ai };
  }
  const estResponsable = (req) => (r, v) => (v.constats || []).some((c) => Number(c.id) === Number(req.params.cid) && (c.actions || []).some((a) => Number(a.id) === Number(req.params.aid) && Number(a.responsableUserId) === req.user.id));

  router.post('/api/visites/:id/constats/:cid/actions', async (req) => {
    const v = getVisible(req, req.params.id);
    const cx = contexte();
    verifierModifiable(v, cx);
    const constats = cloner(v.constats).map((c) => Object.assign(c, { actions: cloner(c.actions) }));
    const c = constats[trouver(constats, req.params.cid, 'Constat introuvable')];
    if (c.actions.length >= MAX_ACTIONS) throw new HttpError(400, `Actions : ${MAX_ACTIONS} au maximum par constat`);
    const etat = { sequence: v.sequence };
    const a = Object.assign({ id: nouvelId(etat) }, validerAction(req, objet(req.body), null, cx, true), { demandeId: null, demandeNumero: '', otId: null, verifiePar: null, dateVerification: null, commentaireVerification: '', alerteRetard: null, createdBy: req.user.id, createdAt: new Date().toISOString() });
    c.actions.push(a);
    const maj = enregistrer(req, v, { constats, sequence: etat.sequence }, 'action', `Action ajoutée : « ${a.libelle} » (responsable : ${ctx.nomUser(a.responsableUserId)}${a.echeance ? ', échéance ' + frJour(a.echeance) : ''})`, 'affectation');
    notifier(req, [a.responsableUserId], { titre: `Action à mener — visite ${maj.numero}`, message: `« ${a.libelle} »${a.echeance ? ' pour le ' + frJour(a.echeance) : ''} (constat : ${libelle('typesConstat', c.typeCode)}${c.exigence ? ', ' + c.exigence : ''})`, lien: lienVisite(maj, 'constats'), type: 'info' });
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  router.put('/api/visites/:id/constats/:cid/actions/:aid', async (req) => {
    const v = getVisible(req, req.params.id, estResponsable(req));
    const cx = contexte();
    verifierModifiable(v, cx);
    const b = objet(req.body);
    const { constats, c, a, ai } = trouverAction(v, req.params.cid, req.params.aid);
    const gestion = gestionnaire(req) && ecritureComplete(req, v);
    if (!gestion) {
      // Le responsable de l'action met à jour son avancement (statut, commentaire, date de réalisation)
      if (Number(a.responsableUserId) !== req.user.id) throw new HttpError(403, 'Droit insuffisant : Audits & visites › Modifier');
      for (const k of Object.keys(b)) if (!['statut', 'commentaire', 'dateRealisation'].includes(k)) throw new HttpError(403, 'Seuls le statut, le commentaire et la date de réalisation de vos actions peuvent être mis à jour');
    }
    const avant = Object.assign({}, a);
    const nouvelle = Object.assign({}, a, validerAction(req, b, a, cx, gestion));
    if (nouvelle.echeance !== avant.echeance) nouvelle.alerteRetard = null;
    c.actions[ai] = nouvelle;
    const changes = [];
    if (nouvelle.statut !== avant.statut) changes.push(`statut ${libelle('statutsAction', avant.statut)} → ${libelle('statutsAction', nouvelle.statut)}`);
    if (Number(nouvelle.responsableUserId) !== Number(avant.responsableUserId)) changes.push(`responsable : ${ctx.nomUser(nouvelle.responsableUserId)}`);
    if (nouvelle.echeance !== avant.echeance) changes.push(`échéance : ${frJour(nouvelle.echeance) || 'aucune'}`);
    if (nouvelle.libelle !== avant.libelle) changes.push('libellé');
    if (nouvelle.commentaire !== avant.commentaire) changes.push('commentaire');
    if (!changes.length && nouvelle.dateRealisation === avant.dateRealisation) return detail(req, v);
    const maj = enregistrer(req, v, { constats }, 'action', `Action « ${nouvelle.libelle} » : ${changes.join(', ') || 'date de réalisation'}`, Number(nouvelle.responsableUserId) !== Number(avant.responsableUserId) ? 'affectation' : 'modification');
    if (Number(nouvelle.responsableUserId) !== Number(avant.responsableUserId)) notifier(req, [nouvelle.responsableUserId], { titre: `Action à mener — visite ${maj.numero}`, message: `« ${nouvelle.libelle} »${nouvelle.echeance ? ' pour le ' + frJour(nouvelle.echeance) : ''}`, lien: lienVisite(maj, 'constats'), type: 'info' });
    if (nouvelle.statut === cx.SA.realisee && avant.statut !== cx.SA.realisee) {
      const valideurs = ctx.usersAvecDroit(MODULE, 'valider', (u, p) => perms.canSeeRecord(p, u, maj, { ecriture: true })).map((u) => u.id);
      notifier(req, valideurs.concat([maj.hoteUserId]), { titre: `Action réalisée à vérifier — visite ${maj.numero}`, message: `${ctx.nomUser(req.user.id)} a réalisé « ${nouvelle.libelle} » : vérifiez son efficacité`, lien: lienVisite(maj, 'constats'), type: 'info' });
    }
    return detail(req, maj);
  }, { perm: [MODULE, 'voir'], maxBody: CORPS_MAX });

  router.delete('/api/visites/:id/constats/:cid/actions/:aid', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const { constats, c, a, ai } = trouverAction(v, req.params.cid, req.params.aid);
    if (a.demandeId != null) throw new HttpError(400, `Cette action est liée à la demande ${a.demandeNumero || a.demandeId} : abandonnez-la plutôt que de la supprimer`);
    if (a.statut === contexte().SA.verifiee) ctx.requirePerm(req, MODULE, 'supprimer'); // efficacité vérifiée : traçabilité
    c.actions.splice(ai, 1);
    return detail(req, enregistrer(req, v, { constats }, 'action', `Action supprimée : « ${a.libelle} »`, 'suppression'));
  }, { perm: [MODULE, 'modifier'] });

  /** Vérification de l'efficacité d'une action réalisée. */
  router.post('/api/visites/:id/constats/:cid/actions/:aid/valider', async (req) => {
    const v = getVisible(req, req.params.id);
    const cx = contexte();
    verifierModifiable(v, cx);
    const b = objet(req.body);
    const { constats, c, a, ai } = trouverAction(v, req.params.cid, req.params.aid);
    if (a.statut !== cx.SA.realisee) throw new HttpError(400, `Seule une action « ${libelle('statutsAction', cx.SA.realisee)} » peut être vérifiée (statut actuel : ${libelle('statutsAction', a.statut)})`);
    if (b.efficace === undefined || b.efficace === null || b.efficace === '') throw new HttpError(400, 'Indiquez si l\'action est efficace');
    const efficace = booleen(b.efficace);
    const commentaire = texte(b.commentaire, 2000, 'Le commentaire de vérification', { multiligne: true });
    if (!efficace && !commentaire) throw new HttpError(400, 'Expliquez pourquoi l\'action n\'est pas efficace');
    const maintenant = new Date().toISOString();
    c.actions[ai] = Object.assign({}, a, efficace
      ? { statut: cx.SA.verifiee, verifiePar: req.user.id, dateVerification: maintenant, commentaireVerification: commentaire }
      : { statut: cx.SA.en_cours, verifiePar: req.user.id, dateVerification: maintenant, commentaireVerification: commentaire, dateRealisation: null });
    const maj = enregistrer(req, v, { constats }, 'verification', `Action « ${a.libelle} » ${efficace ? 'vérifiée efficace' : 'jugée non efficace, à reprendre'}${commentaire ? ' — ' + commentaire : ''}`, efficace ? 'validation' : 'refus');
    notifier(req, [a.responsableUserId], { titre: efficace ? `Action vérifiée — visite ${maj.numero}` : `Action à reprendre — visite ${maj.numero}`, message: efficace ? `« ${a.libelle} » a été vérifiée efficace par ${ctx.nomUser(req.user.id)}` : `« ${a.libelle} » n'est pas jugée efficace : ${commentaire}`, lien: lienVisite(maj, 'constats'), type: efficace ? 'succes' : 'alerte' });
    return detail(req, maj);
  }, { perm: [MODULE, 'valider'], maxBody: CORPS_MAX });

  /**
   * Création d'une demande d'intervention depuis une action (module Demandes). Le service publié
   * ctx.services.demandes.creer(donnees, req) est utilisé s'il existe ; sinon la route de création du
   * module est appelée avec les droits de l'utilisateur (mêmes contrôles, numérotation et notifications).
   */
  router.post('/api/visites/:id/constats/:cid/actions/:aid/creer-demande', async (req) => {
    const sd = ctx.services.demandes;
    const routeDemandes = router.match('POST', '/api/demandes');
    if (!sd || (typeof sd.creer !== 'function' && (!routeDemandes || !routeDemandes.route))) throw new HttpError(503, 'Le module « Demandes d\'intervention » n\'est pas disponible sur ce serveur');
    ctx.requirePerm(req, 'demandes', 'creer');
    const v = getVisible(req, req.params.id);
    const cx = contexte();
    verifierModifiable(v, cx);
    const { constats, c, a, ai } = trouverAction(v, req.params.cid, req.params.aid);
    if (cx.finauxAction.has(a.statut)) throw new HttpError(400, 'Cette action est clôturée : aucune demande ne peut plus en être créée');
    // Une demande refusée ne bloque pas l'action : une nouvelle demande peut être créée (l'ancienne reste à l'historique)
    if (a.demandeId != null && db.get('demandes', a.demandeId) && !demandeEstRefusee(a.demandeId)) throw new HttpError(409, `Une demande d'intervention est déjà liée à cette action : ${a.demandeNumero || a.demandeId}`);
    const b = objet(req.body);
    const description = texte(b.description, 5000, 'La description', { multiligne: true })
      || [`Action issue de la visite ${v.numero} « ${v.titre} »${v.organisme ? ' (' + v.organisme + ')' : ''}.`,
        `Constat (${libelle('typesConstat', c.typeCode)}${c.exigence ? ', ' + c.exigence : ''}) : ${c.description}`,
        `Action : ${a.libelle}${a.echeance ? ' — échéance ' + frJour(a.echeance) : ''}`].join('\n').slice(0, 5000);
    const corps = {
      titre: texte(b.titre, 200, 'Le titre') || a.libelle.slice(0, 200),
      description,
      equipementId: b.equipementId !== undefined ? b.equipementId : (c.equipementId == null ? null : c.equipementId),
      secteurId: b.secteurId !== undefined ? b.secteurId : (c.secteurId != null ? c.secteurId : v.secteurId),
    };
    if (b.prioriteCode !== undefined) corps.prioriteCode = b.prioriteCode;
    if (b.typeCode !== undefined) corps.typeCode = b.typeCode;
    if (b.champs !== undefined) corps.champs = b.champs;
    let demande;
    if (typeof sd.creer === 'function') demande = await sd.creer(corps, req);
    else {
      const sousRequete = { method: 'POST', headers: req.headers, socket: req.socket, user: req.user, profil: req.profil, perms: req.perms, session: req.session, cookies: req.cookies, ecriture: true, query: {}, params: routeDemandes.params || {}, body: corps };
      if (routeDemandes.route.opts && routeDemandes.route.opts.perm) ctx.requirePerm(sousRequete, routeDemandes.route.opts.perm[0], routeDemandes.route.opts.perm[1]);
      const reponseInterne = { setHeader() {}, writeHead() {}, end() {}, writableEnded: false };
      demande = await routeDemandes.route.handler(sousRequete, reponseInterne, ctx);
    }
    if (!demande || demande.id == null) throw new HttpError(500, 'La demande d\'intervention n\'a pas pu être créée');
    const brute = db.get('demandes', demande.id) || demande;
    const precedente = a.demandeId != null ? { id: a.demandeId, numero: a.demandeNumero || '', statut: (db.get('demandes', a.demandeId) || {}).statut || '', remplaceeLe: new Date().toISOString() } : null;
    c.actions[ai] = Object.assign({}, a, {
      demandeId: brute.id, demandeNumero: brute.numero || '', otId: brute.otId == null ? null : brute.otId, statut: a.statut === cx.SA.a_faire ? cx.SA.en_cours : a.statut,
      demandesPrecedentes: precedente ? (a.demandesPrecedentes || []).concat([precedente]).slice(-20) : (a.demandesPrecedentes || []),
    });
    const maj = enregistrer(req, v, { constats }, 'demande', `Demande d'intervention ${brute.numero || brute.id} créée pour l'action « ${a.libelle} »${precedente ? ` (remplace la demande refusée ${precedente.numero || precedente.id})` : ''}`, 'liaison');
    notifier(req, [a.responsableUserId], { titre: `Demande ${brute.numero || ''} créée — visite ${maj.numero}`, message: `Une demande d'intervention a été créée pour votre action « ${a.libelle} »`, lien: lienVisite(maj, 'constats'), type: 'info' });
    return { demande: { id: brute.id, numero: brute.numero, statut: brute.statut, otId: brute.otId == null ? null : brute.otId }, visite: detail(req, maj) };
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX });

  // ----- Routes : documents --------------------------------------------------------------------------------------
  function typeDocument(nomDoc, declare, octets) {
    const ext = (String(nomDoc).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1];
    let type = String(declare || '').toLowerCase().split(';')[0].trim();
    if ((!type || type === 'application/octet-stream') && ext && TYPES_DOC[ext]) type = TYPES_DOC[ext];
    if (type === 'image/jpg') type = 'image/jpeg';
    if (type === 'application/csv' || (type === 'application/vnd.ms-excel' && ext === 'csv')) type = 'text/csv';
    if (!TYPES_DOC_AUTORISES.has(type)) throw new HttpError(400, 'Type de fichier non autorisé (PDF, images, documents bureautiques, texte ou CSV)');
    // Contrôle de la signature du fichier (le contenu doit correspondre au type déclaré)
    const debut = octets.subarray(0, 12);
    const commence = (sig) => sig.every((o, i) => debut[i] === o);
    const signatures = {
      'application/pdf': () => debut.toString('latin1', 0, 5) === '%PDF-',
      'image/png': () => commence([0x89, 0x50, 0x4e, 0x47]),
      'image/jpeg': () => commence([0xff, 0xd8, 0xff]),
      'image/gif': () => debut.toString('latin1', 0, 4) === 'GIF8',
      'image/webp': () => debut.toString('latin1', 0, 4) === 'RIFF' && debut.toString('latin1', 8, 12) === 'WEBP',
    };
    const zip = () => commence([0x50, 0x4b]);
    const ole = () => commence([0xd0, 0xcf, 0x11, 0xe0]);
    let ok = true;
    if (signatures[type]) ok = signatures[type]();
    else if (/openxmlformats|opendocument/.test(type)) ok = zip();
    else if (/msword|ms-excel|ms-powerpoint/.test(type)) ok = ole();
    else if (type.startsWith('text/')) ok = !octets.subarray(0, 4096).includes(0);
    if (!ok) throw new HttpError(400, 'Le contenu du fichier ne correspond pas à son type');
    return type;
  }

  router.post('/api/visites/:id/documents', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const b = objet(req.body);
    const nomDoc = texte(b.nom, 150, 'Le nom du document', { requis: true }).replace(/[\\/:*?"<>|]/g, '_');
    const contenu = typeof b.contenu === 'string' ? b.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w.-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu du document invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const octets = Buffer.from(base64, 'base64');
    if (!octets.length) throw new HttpError(400, 'Le document est vide');
    if (octets.length > TAILLE_MAX_DOC) throw new HttpError(400, `Document trop volumineux (${(octets.length / 1024 / 1024).toFixed(1)} Mo, maximum 10 Mo)`);
    const docs = cloner(v.documents);
    if (docs.length >= MAX_DOCS) throw new HttpError(400, `Nombre maximal de documents atteint (${MAX_DOCS})`);
    const type = typeDocument(nomDoc, b.type || m[1], octets);
    const categorie = b.categorie === undefined || b.categorie === null || b.categorie === '' ? 'autre' : String(b.categorie);
    if (!CATEGORIES_DOC[categorie]) throw new HttpError(400, 'Catégorie de document invalide (programme, rapport, certificat ou autre)');
    const etat = { sequence: v.sequence };
    const doc = { id: nouvelId(etat), nom: nomDoc, type, taille: octets.length, categorie, description: texte(b.description, 500, 'La description'), contenu: `data:${type};base64,${octets.toString('base64')}`, date: new Date().toISOString(), userId: req.user.id };
    const maj = enregistrer(req, v, { documents: docs.concat([doc]), sequence: etat.sequence }, 'document', `Document ajouté (${CATEGORIES_DOC[categorie]}) : ${nomDoc} (${Math.max(1, Math.round(octets.length / 1024))} Ko)`, 'document');
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'], maxBody: CORPS_MAX_DOC });

  router.get('/api/visites/:id/documents/:docId', async (req, res) => {
    const v = getVisible(req, req.params.id);
    const doc = (v.documents || [])[trouver(v.documents, req.params.docId, 'Document introuvable')];
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Document illisible');
    const buf = Buffer.from(m[2], 'base64');
    const type = TYPES_DOC_AUTORISES.has(doc.type) ? doc.type : 'application/octet-stream';
    const inline = (type === 'application/pdf' || type.startsWith('image/')) && req.query.telecharger !== '1';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.nom || 'document').replace(/'/g, '%27')}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      'Cache-Control': 'private, no-store',
    });
    res.end(buf);
  }, { perm: [MODULE, 'voir'] });

  router.delete('/api/visites/:id/documents/:docId', async (req) => {
    const v = getVisible(req, req.params.id);
    verifierModifiable(v, contexte());
    const docs = cloner(v.documents);
    const i = trouver(docs, req.params.docId, 'Document introuvable');
    const [sup] = docs.splice(i, 1);
    return detail(req, enregistrer(req, v, { documents: docs }, 'document', `Document supprimé : ${sup.nom}`, 'document'));
  }, { perm: [MODULE, 'modifier'] });

  // ----- Protection des données personnelles (anonymisation) ------------------------------------------------------
  /**
   * Anonymise le téléphone, l'e-mail, la pièce d'identité et le véhicule des visiteurs des visites terminées
   * depuis plus de `jours` jours (personnes encore présentes exclues), ainsi que l'e-mail et le téléphone du
   * contact de l'organisme. Les noms restent au registre.
   */
  function purger(options = {}, req) {
    const jours = options.jours === undefined || options.jours === null ? cfgVisites().conserverVisiteursJours : Number(options.jours);
    const reference = options.maintenant ? Date.parse(options.maintenant) : Date.now();
    const limite = reference - jours * 86400000;
    const maintenant = new Date().toISOString();
    let nbVisites = 0; let nbVisiteurs = 0; let nbContacts = 0;
    const candidates = req ? db.list(ENTITE).filter((v) => ecritureComplete(req, v)) : db.list(ENTITE);
    for (const v of candidates) {
      const fin = Date.parse(v.dateFin || v.dateDebut);
      if (!Number.isFinite(fin) || fin >= limite) continue;
      let n = 0;
      const visiteurs = (v.visiteurs || []).map((x) => {
        if (x.arrivee && !x.depart) return x;
        if (x.depart && Date.parse(x.depart) >= limite) return x;
        if (!x.telephone && !x.email && !x.pieceIdentite && !x.vehicule) return x;
        n++;
        return Object.assign({}, x, { telephone: '', email: '', pieceIdentite: '', vehicule: '', anonymiseLe: maintenant });
      });
      const contact = v.contactOrganisme || {};
      const contactAPurger = !!(contact.email || contact.telephone);
      if (!n && !contactAPurger) continue;
      const patch = { visiteurs };
      if (contactAPurger) { patch.contactOrganisme = Object.assign({}, contact, { email: '', telephone: '', anonymiseLe: maintenant }); nbContacts++; }
      nbVisites++; nbVisiteurs += n;
      const quoi = [n ? `de ${n} visiteur(s)` : '', contactAPurger ? 'du contact de l\'organisme' : ''].filter(Boolean).join(' et ');
      enregistrer(req || null, v, patch, 'anonymisation', `Coordonnées ${quoi} anonymisées (conservation ${jours} jour(s))`, 'purge');
    }
    return { jours, visites: nbVisites, visiteurs: nbVisiteurs, contacts: nbContacts };
  }
  router.post('/api/visites/purger', async (req) => {
    const b = objet(req.body);
    let jours;
    if (b.jours !== undefined && b.jours !== null && b.jours !== '') {
      // Nombre entier, ou chaîne en écriture décimale (ni exposant, ni hexadécimal)
      jours = typeof b.jours === 'number' ? b.jours : (typeof b.jours === 'string' && /^\s*\d{1,4}\s*$/.test(b.jours) ? Number(b.jours) : NaN);
      if (!Number.isInteger(jours) || jours < 0 || jours > 3650) throw new HttpError(400, 'Durée de conservation invalide (0 à 3650 jours)');
    }
    const r = purger({ jours }, req);
    ctx.audit(req, 'purge', ENTITE, null, `Anonymisation des visiteurs : ${r.visiteurs} visiteur(s)${r.contacts ? ` et ${r.contacts} contact(s) d'organisme` : ''} dans ${r.visites} visite(s) (conservation ${r.jours} jour(s))`);
    return r;
  }, { perm: [MODULE, 'valider'], maxBody: CORPS_MAX });

  // ----- Vérification quotidienne : rappels, retards, anonymisation ----------------------------------------------
  function verifierEcheances(options = {}) {
    const cx = contexte();
    const ref = options.maintenant ? new Date(options.maintenant) : new Date();
    const jour = jourLocal(ref);
    cx.jour = jour;
    const cfg = cfgVisites();
    const resultat = { date: jour, rappels: 0, actionsEnRetard: 0, preparationsEnRetard: 0, notifications: 0, anonymisation: null };
    for (const v of db.list(ENTITE)) {
      if (cx.finauxVisite.has(v.statut)) {
        // Visite clôturée : seules les actions restent à suivre
      } else {
        const n = joursEntre(jour, jourLocal(v.dateDebut));
        if (n >= 0 && n <= cfg.rappelJoursAvant && v.rappelEnvoye !== v.dateDebut) {
          const restants = (v.preparation || []).filter((p) => !p.fait);
          resultat.notifications += notifier(null, equipeVisite(v), { titre: `Rappel : visite ${v.numero} ${n === 0 ? 'aujourd\'hui' : n === 1 ? 'demain' : 'dans ' + n + ' jours'}`, message: `« ${v.titre} »${v.organisme ? ' (' + v.organisme + ')' : ''} ${periodeTexte(v)}${restants.length ? ` — ${restants.length} point(s) de préparation restant(s)` : ' — préparation terminée'}`, lien: lienVisite(v, 'preparation'), type: 'alerte' });
          resultat.notifications += notifier(null, restants.map((p) => p.responsableUserId), { titre: `Rappel : préparation de la visite ${v.numero}`, message: `Points de préparation à terminer avant le ${frJour(jourLocal(v.dateDebut))} : ${restants.map((p) => p.libelle).join(' ; ').slice(0, 300)}`, lien: lienVisite(v, 'preparation'), type: 'alerte' });
          db.update(ENTITE, v.id, { rappelEnvoye: v.dateDebut });
          resultat.rappels++;
        }
      }
      // Points de préparation et actions dont l'échéance est dépassée (une alerte par échéance)
      const courante = db.get(ENTITE, v.id);
      let change = false;
      const preparation = cloner(courante.preparation).map((p) => {
        if (cx.finauxVisite.has(courante.statut) || p.fait || !p.echeance || p.echeance >= jour || p.alerteRetard === p.echeance || p.responsableUserId == null) return p;
        change = true; resultat.preparationsEnRetard++;
        resultat.notifications += notifier(null, [p.responsableUserId], { titre: `Préparation en retard — visite ${courante.numero}`, message: `« ${p.libelle} » était attendu pour le ${frJour(p.echeance)} (visite « ${courante.titre} » ${periodeTexte(courante)})`, lien: lienVisite(courante, 'preparation'), type: 'alerte' });
        return Object.assign(p, { alerteRetard: p.echeance });
      });
      const constats = cloner(courante.constats).map((c) => Object.assign(c, { actions: cloner(c.actions).map((a) => {
        if (courante.statut === cx.SV.annulee || !estEnRetard(a, cx) || a.alerteRetard === a.echeance) return a;
        change = true; resultat.actionsEnRetard++;
        resultat.notifications += notifier(null, [a.responsableUserId, courante.hoteUserId], { titre: `Action en retard — visite ${courante.numero}`, message: `« ${a.libelle} » (responsable : ${ctx.nomUser(a.responsableUserId)}) devait être réalisée le ${frJour(a.echeance)}`, lien: lienVisite(courante, 'constats'), type: 'alerte' });
        return Object.assign(a, { alerteRetard: a.echeance });
      }) }));
      if (change) db.update(ENTITE, courante.id, { preparation, constats });
    }
    if (options.anonymiser !== false) {
      resultat.anonymisation = purger({ maintenant: ref.toISOString() });
      const an = resultat.anonymisation;
      if (an.visites) ctx.audit(null, 'purge', ENTITE, null, `Anonymisation automatique : ${an.visiteurs} visiteur(s)${an.contacts ? ` et ${an.contacts} contact(s) d'organisme` : ''} dans ${an.visites} visite(s)`);
    }
    return resultat;
  }

  if (!db.inMemory) {
    let dernierJour = null;
    const tache = () => {
      const j = aujourdhui();
      if (j === dernierJour) return;
      dernierJour = j;
      try { verifierEcheances(); } catch (e) { ctx.log('Audits & visites : vérification quotidienne en échec', e.message); }
    };
    const demarrage = setTimeout(tache, 50 * 1000);
    if (demarrage.unref) demarrage.unref();
    const periodique = setInterval(tache, INTERVALLE_VERIFICATION_MS);
    if (periodique.unref) periodique.unref();
  }

  // ----- Événements inter-modules ----------------------------------------------------------------------------------
  /** Met à jour les actions liées à une demande ; `fn(action)` retourne le correctif ou null. */
  function majActionsLiees(demandeId, fn, details) {
    for (const v of db.list(ENTITE, (x) => (x.constats || []).some((c) => (c.actions || []).some((a) => Number(a.demandeId) === Number(demandeId))))) {
      let change = false;
      const constats = cloner(v.constats).map((c) => Object.assign(c, { actions: cloner(c.actions).map((a) => {
        if (Number(a.demandeId) !== Number(demandeId)) return a;
        const p = fn(a);
        if (!p) return a;
        change = true;
        return Object.assign(a, p);
      }) }));
      if (change) enregistrer(null, v, { constats }, 'demande', details);
    }
  }
  ctx.on('ot:cree', (data) => {
    const ot = data && (data.ot || data);
    if (!ot || ot.demandeId == null) return;
    majActionsLiees(ot.demandeId, (a) => (a.otId == null ? { otId: ot.id } : null), `Ordre de travail ${ot.numero || ot.id} créé depuis la demande liée`);
  });
  /** Demande liée refusée : l'action reste ouverte, son responsable est prévenu et peut faire créer une nouvelle demande. */
  ctx.on('demande:refusee', (d) => {
    if (!d || d.id == null) return;
    const cx = contexte();
    const motif = String(d.motifRefus || '').slice(0, 200);
    for (const v of db.list(ENTITE, (x) => (x.constats || []).some((c) => (c.actions || []).some((a) => Number(a.demandeId) === Number(d.id))))) {
      const concernees = [];
      for (const c of v.constats || []) for (const a of c.actions || []) if (Number(a.demandeId) === Number(d.id) && !cx.finauxAction.has(a.statut)) concernees.push(a);
      if (!concernees.length) continue;
      const maj = enregistrer(null, v, {}, 'demande', `Demande ${d.numero || d.id} refusée${motif ? ' : ' + motif : ''} — action « ${concernees.map((a) => a.libelle).join(' », « ').slice(0, 200)} » à reprendre (nouvelle demande possible)`);
      for (const a of concernees) {
        notifier(null, [a.responsableUserId, maj.hoteUserId], { titre: `Demande ${d.numero || ''} refusée — visite ${maj.numero}`, message: `La demande d'intervention liée à l'action « ${a.libelle} » a été refusée${motif ? ' : ' + motif : ''}. L'action reste ouverte : une nouvelle demande peut être créée.`, lien: lienVisite(maj, 'constats'), type: 'alerte' });
      }
    }
  });
  ctx.on('demande:cloturee', (d) => {
    if (!d || d.id == null) return;
    const cx = contexte();
    majActionsLiees(d.id, (a) => (a.statut === cx.SA.a_faire || a.statut === cx.SA.en_cours ? { statut: cx.SA.realisee, dateRealisation: aujourdhui() } : null), `Demande ${d.numero || d.id} clôturée : action liée réalisée, efficacité à vérifier`);
  });

  // ----- Services publiés ---------------------------------------------------------------------------------------------
  ctx.services.visites = {
    /** Visite brute (ou null). */
    get: (id) => db.get(ENTITE, id),
    /** Personnes présentes sur le site (tous sites) : [{ visiteId, visiteNumero, nom, prenom, societe, arrivee, … }]. */
    presents: () => db.list(ENTITE).flatMap((v) => (v.visiteurs || []).filter((x) => x.arrivee && !x.depart).map((x) => ligneRegistre(v, x))),
    /** Rappels J-n, retards de préparation et d'actions, anonymisation ; options { maintenant, anonymiser }. */
    verifierEcheances,
    /** Anonymisation des coordonnées des visiteurs ; options { jours, maintenant }. */
    purger: (options) => purger(options || {}),
    statuts: () => contexte().SV,
    statutsActions: () => contexte().SA,
  };
}

// ----- Données de démonstration -----------------------------------------------------------------------------------------
/** Petit PDF valide d'une page (texte en Helvetica, encodage WinAnsi). */
function pdfSimple(titre, lignes) {
  const latin = (s) => String(s).replace(/[—–]/g, '-').replace(/[’‘]/g, '\'').replace(/[«»]/g, '"').replace(/œ/g, 'oe').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  const echapper = (s) => latin(s).replace(/([\\()])/g, '\\$1');
  const flux = ['BT', '/F1 15 Tf', '50 790 Td', `(${echapper(titre)}) Tj`, '/F1 10.5 Tf', '15 TL', 'T*']
    .concat(lignes.map((l) => `(${echapper(l)}) '`)).concat(['ET']).join('\n');
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(flux, 'latin1')} >>\nstream\n${flux}\nendstream`,
  ];
  let corps = '%PDF-1.4\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(Buffer.byteLength(corps, 'latin1')); corps += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(corps, 'latin1');
  corps += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n` + positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('');
  corps += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(corps, 'latin1');
}

function seedDemo(ctx) {
  const { db } = ctx;
  const TEMOIN = 'Audit de renouvellement de certification ISO 9001';
  if (db.findOne(ENTITE, (v) => v.titre === TEMOIN)) return 'déjà présentes';
  const secteur = (code) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : null; };
  const SITE = secteur('SITE') || ((db.findOne('secteurs', (s) => s.type === 'site') || {}).id) || null;
  if (SITE == null) return 'aucun site';
  const PROD = secteur('PROD'); const L1 = secteur('PROD-L1') || PROD; const MAINT = secteur('MAINT'); const LOG = secteur('LOG'); const QUAL = secteur('QUAL'); const SG = secteur('SG');
  const VAL = secteur('VAL');
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const uid = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };

  // Responsable qualité de démonstration (créé seulement s'il n'existe pas)
  let comptes = '';
  const profilQualite = db.findOne('profils', (p) => p.nom === 'Responsable qualité');
  if (profilQualite && !db.findOne('users', (u) => u.login === 'cqualite') && db.findOne('users', (u) => u.login === 'mdupont')) {
    db.insert('users', {
      login: 'cqualite', nom: 'Garnier', prenom: 'Hélène', fonction: 'Responsable qualité – sécurité – environnement', email: '', telephone: '',
      passwordHash: ctx.auth.hashPassword('demo'), profilId: profilQualite.id, secteurIds: [SITE], siteAcces: VAL ? [{ siteId: VAL, mode: 'complet' }] : [], managerId: admin ? admin.id : null,
      actif: true, overrides: {}, porteeOverride: null, doitChangerMdp: false, preferences: { theme: 'clair' }, derniereConnexion: null, champs: {},
    });
    comptes = ' ; compte « cqualite » (Responsable qualité, mot de passe demo)';
  }
  const QUALITE = uid('cqualite'); const RESP = uid('mdupont'); const CHEF = uid('pmartin'); const TECH = uid('kleroy');

  const cfg = db.getConfig();
  const gabarit = (cfg.numerotation || {}).vis || 'VIS-{annee}-{num:3}';
  const numero = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('vis', gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; } return 'VIS-' + Date.now(); };
  const listes = cfg.listes || {};
  const code = (liste, voulu) => { const l = listes[liste] || []; return !l.length || l.some((x) => x.code === voulu) ? voulu : l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0))[0].code; };
  const jour = (n) => ajouterJours(aujourdhui(), n);
  const horo = (n, heure) => new Date(`${jour(n)}T${heure}:00`).toISOString();
  const pris = new Set();
  for (const v of db.list(ENTITE)) for (const x of v.visiteurs || []) if (x.badgeNumero) pris.add(x.badgeNumero);
  const badge = () => { for (;;) { const n = 'VB' + String(crypto.randomInt(0, 100000000)).padStart(8, '0'); if (!pris.has(n)) { pris.add(n); return n; } } };
  const balance = db.findOne('equipements', (e) => e.nom === 'Balance de précision');
  const fournisseurCompresseurs = db.findOne('fournisseurs', (f) => /atlas/i.test(f.nom || ''));

  function creer(o) {
    let seq = 0;
    const id = () => { seq += 1; return seq; };
    const preparation = (o.preparation || []).map(([libelleP, resp, echeance, fait]) => ({ id: id(), libelle: libelleP, responsableUserId: resp, echeance: echeance == null ? null : jour(echeance), fait: !!fait, faitLe: fait ? horo(Math.min(-1, echeance || -1), '16:00') : null, faitPar: fait ? resp : null, alerteRetard: null }));
    const visiteurs = (o.visiteurs || []).map((x) => Object.assign({ id: id(), prenom: '', societe: o.organisme, fonction: '', email: '', telephone: '', pieceIdentite: '', vehicule: '', accompagnateurUserId: null, epiFournis: [], charteAcceptee: false, charteAccepteeLe: null, arrivee: null, depart: null, arriveePar: null, departPar: null, badgeNumero: badge() }, x));
    const constats = (o.constats || []).map((c) => Object.assign({ id: id(), exigence: '', preuve: '', secteurId: null, equipementId: null, createdBy: QUALITE, createdAt: o.dateFin }, c, {
      actions: (c.actions || []).map((a) => Object.assign({ id: id(), commentaire: '', echeance: null, dateRealisation: null, demandeId: null, demandeNumero: '', otId: null, verifiePar: null, dateVerification: null, commentaireVerification: '', alerteRetard: null, createdBy: QUALITE, createdAt: o.dateFin }, a)),
    }));
    const documents = (o.documents || []).map((d) => Object.assign({ id: id() }, d));
    const auteur = o.createdBy || QUALITE || RESP;
    return db.insert(ENTITE, {
      numero: numero(), titre: o.titre, typeCode: code('typesVisite', o.typeCode), statut: code('statutsVisite', o.statut), secteurId: o.secteurId,
      organisme: o.organisme, referentiel: o.referentiel || '', contactOrganisme: Object.assign({ nom: '', email: '', telephone: '' }, o.contact || {}),
      dateDebut: o.dateDebut, dateFin: o.dateFin, hoteUserId: o.hote, participantsUserIds: (o.participants || []).filter((x) => x != null && x !== o.hote),
      programme: o.programme || '', zonesVisitees: (o.zones || []).filter((z) => z != null), planId: null, objetIds: [],
      preparation, visiteurs, constats, documents,
      resultat: Object.assign({ conclusion: '', note: '', certificatObtenu: null, dateRapport: null }, o.resultat || {}),
      motifAnnulation: '', dateCloture: o.dateCloture || null, rappelEnvoye: null, sequence: seq, createdBy: auteur, champs: {},
      historique: [{ date: o.creeLe || new Date().toISOString(), userId: auteur, action: 'creation', details: 'Visite créée' }].concat(o.historique || []),
    });
  }

  // 1. Audit client d'un grand compte, à venir, en cours de préparation
  creer({
    titre: 'Audit fournisseur annuel — Distrifrais (grand compte)', typeCode: 'audit_client', statut: 'confirmee', secteurId: SITE,
    organisme: 'Distrifrais SAS — direction qualité achats', referentiel: 'Cahier des charges fournisseurs Distrifrais v4.2 (base IFS Food v8)',
    contact: { nom: 'Claire Morel', email: 'claire.morel@distrifrais.example', telephone: '01 70 00 41 12' },
    dateDebut: horo(9, '08:30'), dateFin: horo(9, '17:00'), hote: QUALITE, participants: [RESP, CHEF], creeLe: horo(-20, '10:15'),
    programme: '08:30  Accueil, présentation des participants et rappel des consignes de sécurité\n09:00  Revue documentaire : plan HACCP, traçabilité, gestion des réclamations clients\n10:30  Visite des ateliers : ligne de conditionnement L1, laboratoire, zone d\'expédition\n12:30  Déjeuner\n13:30  Test de traçabilité ascendante et descendante sur un lot\n15:00  Entretien maintenance : plan préventif, maîtrise des corps étrangers, lubrifiants de qualité alimentaire\n16:30  Réunion de clôture et restitution des constats',
    zones: [L1 || PROD, QUAL, LOG],
    preparation: [
      ['Préparer le dossier d\'audit : plan HACCP, indicateurs qualité, réclamations des 12 derniers mois', QUALITE, 5, true],
      ['Nettoyage et rangement 5S de la ligne L1 et de l\'entrepôt', CHEF, 7, false],
      ['Vérifier l\'affichage des modes opératoires (indices en vigueur) et des consignes de sécurité', CHEF, 6, false],
      ['Préparer les EPI visiteurs : blouses, charlottes, sur-chaussures, bouchons d\'oreilles', QUALITE, 8, false],
      ['Extraire l\'historique des interventions de maintenance et le plan préventif de la ligne L1', RESP, 6, true],
      ['Réserver la salle de réunion et organiser le déjeuner', QUALITE, 7, false],
    ],
    visiteurs: [
      { nom: 'Morel', prenom: 'Claire', fonction: 'Responsable qualité fournisseurs', email: 'claire.morel@distrifrais.example', telephone: '06 00 00 41 12', accompagnateurUserId: QUALITE },
      { nom: 'Lambert', prenom: 'Hugo', fonction: 'Auditeur qualité', email: 'hugo.lambert@distrifrais.example', accompagnateurUserId: CHEF },
    ],
  });

  // 2. Audit de certification ISO 9001 terminé : 1 NC mineure, 2 observations, 1 point fort et leurs actions
  const rapportPdf = pdfSimple('Rapport d\'audit de renouvellement - ISO 9001:2015', [
    `Organisme certificateur : Certi-Sud - Date de l'audit : ${frJour(jour(-42))}`,
    'Périmètre : fabrication et conditionnement de produits alimentaires, maintenance, logistique.',
    '',
    'Synthèse : système de management efficace et bien approprié par les équipes.',
    'Non-conformité mineure (§7.1.5.2) : vérification métrologique de la balance du laboratoire non réalisée.',
    'Observation (§7.5.3) : modes opératoires en version obsolète sur la ligne 1.',
    'Observation (§8.7) : zone de quarantaine non matérialisée dans l\'entrepôt.',
    'Point fort (§7.2) : gestion des compétences et des habilitations du personnel de maintenance.',
    '',
    'Conclusion : avis favorable au renouvellement de la certification, sous réserve de la',
    'transmission du plan d\'actions de la non-conformité mineure sous 30 jours.',
  ]);
  creer({
    titre: TEMOIN, typeCode: 'audit_certification', statut: 'terminee', secteurId: SITE,
    organisme: 'Certi-Sud — organisme certificateur accrédité', referentiel: 'ISO 9001:2015',
    contact: { nom: 'Bertrand Vidal', email: 'planification@certi-sud.example', telephone: '04 90 00 12 34' },
    dateDebut: horo(-42, '08:30'), dateFin: horo(-42, '17:30'), hote: QUALITE, participants: [RESP, CHEF], creeLe: horo(-90, '09:00'), dateCloture: horo(-41, '09:00'),
    programme: '08:30  Réunion d\'ouverture\n09:00  Direction : politique qualité, revue de direction, objectifs\n10:30  Production et maintenance (ligne L1, atelier)\n13:30  Laboratoire, métrologie, maîtrise des non-conformités\n15:30  Logistique et expéditions\n16:45  Réunion de clôture',
    zones: [PROD, MAINT, LOG, QUAL],
    visiteurs: [
      { nom: 'Vidal', prenom: 'Bertrand', fonction: 'Auditeur responsable', email: 'b.vidal@certi-sud.example', accompagnateurUserId: QUALITE, charteAcceptee: true, charteAccepteeLe: horo(-42, '08:20'), arrivee: horo(-42, '08:20'), depart: horo(-42, '17:40'), arriveePar: QUALITE, departPar: QUALITE, epiFournis: ['Blouse', 'Charlotte', 'Chaussures de sécurité'] },
      { nom: 'Pons', prenom: 'Sandrine', fonction: 'Auditrice', email: 's.pons@certi-sud.example', accompagnateurUserId: CHEF, charteAcceptee: true, charteAccepteeLe: horo(-42, '08:22'), arrivee: horo(-42, '08:22'), depart: horo(-42, '17:40'), arriveePar: QUALITE, departPar: QUALITE, epiFournis: ['Blouse', 'Charlotte', 'Chaussures de sécurité'] },
    ],
    constats: [
      { typeCode: code('typesConstat', 'nc_mineure'), exigence: '§7.1.5.2 Traçabilité de la mesure', secteurId: QUAL, equipementId: balance ? balance.id : null,
        description: 'La balance de précision du laboratoire ne dispose d\'aucun enregistrement de vérification métrologique depuis 8 mois, alors que la procédure PQ-07 impose une vérification semestrielle.',
        preuve: 'Fiche de vie de la balance consultée au laboratoire : dernier constat de vérification daté de février.',
        actions: [
          { libelle: 'Faire réaliser la vérification métrologique de la balance avec les masses étalon F1 et enregistrer le constat', responsableUserId: QUALITE, echeance: jour(-20), statut: code('statutsAction', 'realisee'), dateRealisation: jour(-25), commentaire: 'Constat de vérification MV-2026-014 conforme, classé dans la fiche de vie.' },
          { libelle: 'Intégrer la vérification semestrielle des instruments de mesure au plan de maintenance préventive', responsableUserId: RESP, echeance: jour(18), statut: code('statutsAction', 'en_cours'), commentaire: 'Plans préventifs en cours de création pour la balance et l\'étuve du laboratoire.' },
        ] },
      { typeCode: code('typesConstat', 'observation'), exigence: '§7.5.3 Maîtrise de l\'information documentée', secteurId: L1 || PROD,
        description: 'Deux modes opératoires affichés sur la ligne 1 (postes remplisseuse et étiqueteuse) sont en version obsolète (indice B au lieu de D).',
        preuve: 'Constat visuel aux postes 1 et 2 de la ligne L1.',
        actions: [
          { libelle: 'Retirer les versions obsolètes et contrôler l\'affichage de l\'ensemble des postes de la ligne 1', responsableUserId: CHEF, echeance: jour(-30), statut: code('statutsAction', 'verifiee'), dateRealisation: jour(-36), verifiePar: QUALITE, dateVerification: horo(-33, '11:00'), commentaireVerification: 'Contrôle de l\'affichage lors de la tournée qualité : tous les postes sont à l\'indice en vigueur.' },
        ] },
      { typeCode: code('typesConstat', 'observation'), exigence: '§8.7 Maîtrise des éléments de sortie non conformes', secteurId: LOG,
        description: 'La zone de quarantaine des produits non conformes de l\'entrepôt n\'est pas matérialisée au sol ; des palettes bloquées sont stockées à proximité des palettes libérées.',
        actions: [
          { libelle: 'Matérialiser la zone de quarantaine (marquage au sol jaune et noir, panneau « Produits bloqués »)', responsableUserId: RESP, echeance: jour(-5), statut: code('statutsAction', 'a_faire'), commentaire: 'Peinture de marquage commandée.' },
        ] },
      { typeCode: code('typesConstat', 'point_fort'), exigence: '§7.2 Compétences', secteurId: MAINT,
        description: 'Matrice de polyvalence et suivi des habilitations du personnel de maintenance tenus à jour et réellement exploités pour la planification.' },
    ],
    resultat: { conclusion: 'Avis favorable au renouvellement de la certification. La non-conformité mineure doit faire l\'objet d\'un plan d\'actions transmis sous 30 jours ; son efficacité sera vérifiée lors du prochain audit de surveillance.', note: '1 NC mineure, 2 observations', certificatObtenu: true, dateRapport: jour(-35) },
    documents: [{ nom: 'Rapport d\'audit ISO 9001 - Certi-Sud.pdf', type: 'application/pdf', taille: rapportPdf.length, categorie: 'rapport', description: 'Rapport de l\'organisme certificateur', contenu: 'data:application/pdf;base64,' + rapportPdf.toString('base64'), date: horo(-35, '14:00'), userId: QUALITE }],
    historique: [{ date: horo(-41, '09:00'), userId: QUALITE, action: 'statut', details: 'En cours → Terminée' }],
  });

  // 3. Inspection de la DREAL planifiée (site de Valréas s'il existe)
  const siteInspection = VAL || SITE;
  creer({
    titre: 'Inspection des installations classées (ICPE)', typeCode: 'inspection', statut: 'planifiee', secteurId: siteInspection,
    organisme: 'DREAL — unité départementale de Vaucluse', referentiel: 'Arrêté préfectoral d\'autorisation d\'exploiter et prescriptions ICPE',
    contact: { nom: 'Inspection des installations classées', email: 'ud84.dreal@inspection.example', telephone: '04 90 00 55 00' },
    dateDebut: horo(21, '09:30'), dateFin: horo(21, '12:30'), hote: RESP, participants: [QUALITE], createdBy: RESP, creeLe: horo(-6, '14:30'),
    programme: '09:30  Réunion d\'ouverture : suites de la précédente inspection\n10:00  Visite des installations : stockages de produits chimiques, groupe froid, aire de déchets\n11:30  Contrôle documentaire : registres, rapports de contrôles périodiques\n12:15  Synthèse',
    zones: siteInspection === SITE ? [SG, LOG] : [secteur('VAL-MAINT'), secteur('VAL-LOG')],
    preparation: [
      ['Rassembler les rapports de contrôle des rejets atmosphériques et aqueux des 12 derniers mois', QUALITE, 14, false],
      ['Mettre à jour le registre des déchets dangereux et les bordereaux de suivi', RESP, 14, false],
      ['Vérifier les rétentions et l\'étiquetage des stockages de produits chimiques', TECH, 10, false],
      ['Contrôle d\'étanchéité des circuits de fluides frigorigènes : rapport à jour', RESP, 12, true],
    ],
    visiteurs: [{ nom: 'Chabert', prenom: 'Laurent', fonction: 'Inspecteur des installations classées', accompagnateurUserId: RESP }],
  });

  // 4. Visite client du jour : 2 visiteurs dont 1 arrivé
  const maintenant = Date.now();
  const huitHeures = new Date(`${aujourdhui()}T08:30:00`).getTime();
  const debutJour = maintenant >= huitHeures + 3600000 ? huitHeures : maintenant - 45 * 60000;
  const finJour = Math.max(new Date(`${aujourdhui()}T17:30:00`).getTime(), maintenant + 2 * 3600000);
  const arrivee = new Date(Math.min(maintenant - 10 * 60000, debutJour + 25 * 60000)).toISOString();
  creer({
    titre: 'Visite de l\'usine — délégation Maison Vernet', typeCode: 'visite_client', statut: 'en_cours', secteurId: SITE,
    organisme: 'Maison Vernet — centrale d\'achats', referentiel: '',
    contact: { nom: 'Julien Faure', email: 'j.faure@maison-vernet.example', telephone: '04 72 00 18 90' },
    dateDebut: new Date(debutJour).toISOString(), dateFin: new Date(finJour).toISOString(), hote: RESP, participants: [CHEF], createdBy: RESP, creeLe: horo(-12, '11:00'),
    programme: 'Accueil et présentation de l\'entreprise\nVisite de la ligne de conditionnement L1 et de l\'entrepôt d\'expédition\nÉchanges sur les capacités de production et les délais',
    zones: [PROD, LOG],
    preparation: [
      ['Préparer la présentation de l\'entreprise et les échantillons', CHEF, -1, true],
      ['Prévoir 2 jeux d\'EPI visiteurs', RESP, -1, true],
    ],
    visiteurs: [
      { nom: 'Faure', prenom: 'Julien', fonction: 'Acheteur catégorie épicerie', email: 'j.faure@maison-vernet.example', telephone: '06 00 00 18 90', vehicule: 'GH-418-KT', accompagnateurUserId: CHEF, charteAcceptee: true, charteAccepteeLe: arrivee, arrivee, arriveePar: RESP, epiFournis: ['Blouse', 'Charlotte', 'Sur-chaussures'] },
      { nom: 'Roche', prenom: 'Amandine', fonction: 'Cheffe de produit', email: 'a.roche@maison-vernet.example', accompagnateurUserId: CHEF },
    ],
    historique: [{ date: arrivee, userId: RESP, action: 'arrivee', details: 'Arrivée de Julien Faure (Maison Vernet — centrale d\'achats)' }],
  });

  // 5. Visite d'un fournisseur, passée
  creer({
    titre: 'Visite technique du prestataire compresseurs — bilan annuel du contrat', typeCode: 'visite_fournisseur', statut: 'terminee', secteurId: SITE,
    organisme: fournisseurCompresseurs ? fournisseurCompresseurs.nom : 'Atlas Copco Compresseurs', referentiel: 'Contrat de maintenance AIRPlan',
    contact: { nom: 'Romain Giraud', email: 'romain.giraud@prestataire.example', telephone: '04 78 00 26 61' },
    dateDebut: horo(-15, '14:00'), dateFin: horo(-15, '16:30'), hote: RESP, participants: [TECH], createdBy: RESP, creeLe: horo(-30, '08:45'), dateCloture: horo(-15, '17:00'),
    programme: 'Bilan de disponibilité du compresseur GA 37 et des interventions de l\'année\nVisite de la salle des compresseurs\nPropositions d\'amélioration et budget 2027',
    zones: [SG],
    visiteurs: [{ nom: 'Giraud', prenom: 'Romain', fonction: 'Technicien commercial', accompagnateurUserId: TECH, charteAcceptee: true, charteAccepteeLe: horo(-15, '13:55'), arrivee: horo(-15, '13:55'), depart: horo(-15, '16:40'), arriveePar: RESP, departPar: RESP, epiFournis: ['Casque', 'Chaussures de sécurité', 'Bouchons d\'oreilles'] }],
    resultat: { conclusion: 'Disponibilité du compresseur : 99,2 % sur douze mois. Remplacement du sécheur frigorifique proposé, à étudier pour le budget 2027.', note: '', certificatObtenu: null, dateRapport: jour(-14) },
  });

  return `5 visites (audit client à venir, certification ISO 9001 terminée avec plan d'actions, inspection ICPE${VAL ? ' à Valréas' : ''}, visite client du jour, visite fournisseur)${comptes}`;
}

module.exports = { nom, register, seedDemo, pdfSimple };
