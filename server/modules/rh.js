'use strict';
/**
 * Module Ressources humaines : suivi du personnel (maintenance en priorité, mais tout le personnel
 * des sites), multi-site par `secteurId`.
 *
 *  - Dossier individuel (`personnel`) : identité, rattachement (site / service), N+1, contrat,
 *    contact d'urgence, compétences, coût horaire (visible uniquement avec rh › modifier), compte GMAO lié.
 *  - Habilitations / certifications (`habilitations`) : échéance calculée selon la durée de validité du
 *    type (liste `typesHabilitation`, `dureeMois`), état valide / bientôt expirée / expirée, matrice
 *    personnel × types, pièces justificatives (≤ 5 Mo).
 *  - Plan de formation (`formations`) : une formation réalisée crée ou renouvelle l'habilitation visée
 *    pour chaque participant présent.
 *  - Visites médicales (`visitesMedicales`) : AUCUNE donnée médicale, uniquement dates, type et aptitude.
 *  - Absences (`absences`) : demande (par la personne elle-même via « Mon dossier RH » ou par les RH),
 *    validation par le N+1 ou un valideur RH (rh › valider), calendrier, absentéisme.
 *
 * Services publiés : ctx.services.rh = {
 *   absencesEntre(du, au, { secteurIds, userIds, statuts }), habilitationsValides(userId, date),
 *   estAbsent(userId, date), absenceDe(userId, date), habilitationValide(userId, typeCode, date),
 *   personnelDeUser(userId), verifierEcheances(options) }
 * Événements émis : 'rh:absenceDemandee', 'rh:absenceValidee', 'rh:absenceRefusee', 'rh:absenceAnnulee',
 *   'rh:habilitationExpiree', 'rh:habilitationBientotExpiree', 'rh:formationRealisee'.
 */
const nom = 'Ressources humaines';
const MODULE = 'rh';
const PERS = 'personnel';
const HAB = 'habilitations';
const FOR = 'formations';
const VIS = 'visitesMedicales';
const ABS = 'absences';
const TAILLE_MAX_DOC = 5 * 1024 * 1024; // 5 Mo par pièce justificative
const MAX_DOCS = 10;
const MAX_PARTICIPANTS = 200;
const MAX_COMPETENCES = 50;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERVALLE_VERIFICATION_MS = 60 * 60 * 1000; // contrôle horaire, traitement une fois par jour

/**
 * Listes propres au module. Les CODES des statuts sont fixes (workflow) ; les libellés et couleurs
 * peuvent être surchargés par une liste de configuration du même nom (`config.listes.statutsAbsence`…).
 */
const LISTES_DEFAUT = {
  statutsAbsence: [
    { code: 'demandee', label: 'En attente de validation', couleur: '#f59e0b', ordre: 1 },
    { code: 'validee', label: 'Validée', couleur: '#16a34a', ordre: 2 },
    { code: 'refusee', label: 'Refusée', couleur: '#dc2626', ordre: 3 },
    { code: 'annulee', label: 'Annulée', couleur: '#9ca3af', ordre: 4 },
  ],
  statutsFormation: [
    { code: 'planifiee', label: 'Planifiée', couleur: '#2563eb', ordre: 1 },
    { code: 'realisee', label: 'Réalisée', couleur: '#16a34a', ordre: 2 },
    { code: 'annulee', label: 'Annulée', couleur: '#9ca3af', ordre: 3 },
  ],
  typesVisiteMedicale: [
    { code: 'embauche', label: 'Visite d\'embauche (VIP)', couleur: '#2563eb', ordre: 1 },
    { code: 'periodique', label: 'Visite périodique', couleur: '#0891b2', ordre: 2 },
    { code: 'reprise', label: 'Visite de reprise', couleur: '#8b5cf6', ordre: 3 },
    { code: 'autre', label: 'Autre visite', couleur: '#6b7280', ordre: 4 },
  ],
  aptitudesMedicales: [
    { code: 'apte', label: 'Apte', couleur: '#16a34a', ordre: 1 },
    { code: 'apte_restrictions', label: 'Apte avec restrictions', couleur: '#f59e0b', ordre: 2 },
    { code: 'inapte', label: 'Inapte', couleur: '#dc2626', ordre: 3 },
    { code: 'en_attente', label: 'En attente', couleur: '#6b7280', ordre: 4 },
  ],
};
/** Listes dont les codes sont imposés par le workflow (seuls libellés / couleurs sont configurables). */
const LISTES_FIGEES = new Set(['statutsAbsence', 'statutsFormation']);
const ETATS_ECHEANCE = { valide: 'Valide', bientot: 'À renouveler', expiree: 'Expirée', remplacee: 'Renouvelée (historique)' };
const DEMI_JOURNEES = { matin: 'Matin', apres_midi: 'Après-midi' };
const NIVEAUX_COMPETENCE = { 1: 'Notions', 2: 'Application', 3: 'Maîtrise', 4: 'Expert' };
/** Types d'absence comptés dans l'absentéisme si la liste ne précise pas `absenteisme: true|false`. */
const ABSENTEISME_DEFAUT = ['maladie', 'accident', 'autre'];

// ----- Dates (ISO AAAA-MM-JJ, calculs en UTC pour éviter les décalages d'heure d'été) ----------------
const pad = (n) => String(n).padStart(2, '0');
function isoLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function aujourdhui() { return isoLocal(new Date()); }
function versUTC(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); }
function depuisUTC(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function ajouterJours(iso, n) { return depuisUTC(versUTC(iso) + n * 86400000); }
function ajouterMois(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + Number(n);
  const ny = Math.floor(total / 12); const nm = total - ny * 12;
  const dernier = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, dernier))}`;
}
function joursEntre(a, b) { return Math.round((versUTC(b) - versUTC(a)) / 86400000); }
function jourSemaine(iso) { return new Date(versUTC(iso)).getUTCDay(); }
function dateValide(s) { if (!RE_DATE.test(String(s || ''))) return false; const t = versUTC(s); return Number.isFinite(t) && depuisUTC(t) === String(s); }
/** Dimanche de Pâques (algorithme de Meeus / Jones / Butcher). */
function paques(annee) {
  const a = annee % 19; const b = Math.floor(annee / 100); const c = annee % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31); const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return `${annee}-${pad(mois)}-${pad(jour)}`;
}
const cacheFeries = new Map();
/** Jours fériés en France métropolitaine (fixes + lundi de Pâques, Ascension, lundi de Pentecôte). */
function joursFeries(annee) {
  if (cacheFeries.has(annee)) return cacheFeries.get(annee);
  const p = paques(annee);
  const s = new Set(['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map((x) => `${annee}-${x}`).concat([ajouterJours(p, 1), ajouterJours(p, 39), ajouterJours(p, 50)]));
  cacheFeries.set(annee, s);
  return s;
}
function estOuvre(iso) { const j = jourSemaine(iso); return j !== 0 && j !== 6 && !joursFeries(Number(String(iso).slice(0, 4))).has(iso); }
/** Nombre de jours ouvrés (lundi → vendredi hors fériés) entre deux dates incluses. */
function joursOuvres(du, au) {
  if (!du || !au || au < du) return 0;
  let n = 0;
  for (let d = du; d <= au; d = ajouterJours(d, 1)) if (estOuvre(d)) n++;
  return n;
}
function prochainOuvre(iso) { let d = iso; while (!estOuvre(d)) d = ajouterJours(d, 1); return d; }
const arrondi = (n, dec = 2) => { const f = 10 ** dec; return Math.round((Number(n) || 0) * f) / f; };

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const nombreCsv = (n) => (n == null || n === '' ? '' : String(n).replace('.', ','));

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  // ----- Configuration et listes ---------------------------------------------------------------
  function cfgRh() {
    const c = Object.assign({ alerteJoursAvantEcheance: 60, afficherAbsencesPlanning: true, heuresHebdo: 35 }, ctx.config().rh || {});
    c.alerteJoursAvantEcheance = Math.max(0, Number(c.alerteJoursAvantEcheance) || 0);
    return c;
  }
  /** Liste du module : configuration si elle existe, sinon valeurs par défaut (codes figés pour les statuts). */
  function listeRh(nomListe) {
    const conf = ctx.liste(nomListe);
    const defaut = LISTES_DEFAUT[nomListe];
    if (!defaut) return conf;
    if (!conf.length) return defaut.slice();
    if (!LISTES_FIGEES.has(nomListe)) return conf;
    return defaut.map((d) => Object.assign({}, d, conf.find((x) => x.code === d.code) || {}, { code: d.code }));
  }
  function itemListe(nomListe, code) { return listeRh(nomListe).find((x) => x.code === code) || null; }
  function libelle(nomListe, code) { const it = itemListe(nomListe, code); return it ? it.label : (code == null ? '' : String(code)); }
  function couleurListe(nomListe, code) { const it = itemListe(nomListe, code); return (it && it.couleur) || '#6b7280'; }
  const can = (req, module, action) => !!(req.perms && perms.can(req.perms, module, action));
  const nomPersonne = (p) => (p ? `${p.prenom || ''} ${p.nom || ''}`.trim() : '');
  /** Une absence de ce type rend-elle la personne indisponible ? (une astreinte, non) */
  function typeRendAbsent(code) {
    const it = ctx.liste('typesAbsence').find((x) => x.code === code);
    if (it && typeof it.absent === 'boolean') return it.absent;
    return code !== 'astreinte';
  }
  function typesAbsenteisme() {
    const l = ctx.liste('typesAbsence');
    if (l.some((x) => typeof x.absenteisme === 'boolean')) return new Set(l.filter((x) => x.absenteisme).map((x) => x.code));
    return new Set(ABSENTEISME_DEFAUT);
  }
  function statutsOtFinaux() {
    const l = ctx.liste('statutsOT');
    return new Set(l.length ? l.filter((s) => s.final).map((s) => s.code) : ['termine', 'annule']);
  }

  // ----- Validation des entrées ------------------------------------------------------------------
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
  function nombre(v, label, { min = 0, max = 1e9, entier = false } = {}) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'number' && typeof v !== 'string') throw new HttpError(400, `${label} : nombre attendu`);
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} : nombre attendu`);
    if (entier && !Number.isInteger(n)) throw new HttpError(400, `${label} : nombre entier attendu`);
    if (n < min) throw new HttpError(400, `${label} : la valeur doit être supérieure ou égale à ${min}`);
    if (n > max) throw new HttpError(400, `${label} : valeur trop grande (maximum ${max})`);
    return n;
  }
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function dateISO(v, label, { requis = false } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis) throw new HttpError(400, `${label} : date obligatoire`);
      return null;
    }
    const s = String(v).slice(0, 10);
    if (!dateValide(s)) throw new HttpError(400, `${label} : date invalide (format attendu AAAA-MM-JJ)`);
    return s;
  }
  function codeListeObligatoire(nomListe, v, label, defaut) {
    const l = ctx.liste(nomListe);
    if (v == null || v === '') { if (defaut !== undefined) return defaut; return l.length ? l[0].code : null; }
    if (!l.some((x) => x.code === v)) throw new HttpError(400, `${label} invalide : « ${v} »`);
    return v;
  }
  function codeRh(nomListe, v, label, defaut) {
    if (v == null || v === '') return defaut;
    if (!listeRh(nomListe).some((x) => x.code === v)) throw new HttpError(400, `${label} invalide : « ${v} »`);
    return v;
  }
  /** Le secteur (site / service) existe et est modifiable par l'utilisateur (portée, site en lecture seule). */
  function verifierSecteur(req, secteurId, label) {
    if (secteurId == null) throw new HttpError(400, `${label || 'Le site / service'} : champ obligatoire`);
    if (!db.get('secteurs', secteurId)) throw new HttpError(400, `${label || 'Le site / service'} : secteur introuvable`);
    const fictif = { secteurId, createdBy: req.user.id };
    if (!perms.canSeeRecord(req.perms, req.user, fictif, { ecriture: true })) {
      if (perms.canSeeRecord(req.perms, req.user, fictif)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
      throw new HttpError(403, 'Ce site / service est hors de votre portée');
    }
    return secteurId;
  }
  const modifiable = (req, rec) => !!(req.perms && perms.canSeeRecord(req.perms, req.user, rec, { ecriture: true }));

  // ----- Références et index ---------------------------------------------------------------------
  function cheminSecteur(id, secteurs) {
    const parts = []; let cur = id == null ? null : secteurs.get(Number(id)); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? secteurs.get(Number(cur.parentId)) : null; }
    return parts.join(' › ');
  }
  function managerDe(p, users) {
    if (!p) return null;
    if (p.managerUserId != null && p.managerUserId !== '') return Number(p.managerUserId);
    if (p.userId != null) { const u = users ? users.get(Number(p.userId)) : db.get('users', p.userId); if (u && u.managerId != null) return Number(u.managerId); }
    return null;
  }
  function personnelDeUser(userId) {
    if (userId == null) return null;
    return db.findOne(PERS, (p) => p.userId != null && Number(p.userId) === Number(userId)) || null;
  }
  const rangExpiration = (h) => `${h.dateExpiration || '9999-12-31'}|${h.dateObtention || ''}|${String(h.id).padStart(9, '0')}`;
  const cleHab = (h) => `${Number(h.personnelId)}|${h.typeCode}`;
  /** Habilitation « courante » (la plus récente) par personne et par type : clé → id. */
  function habilitationsCourantes(habs) {
    const m = new Map(); const rangs = new Map();
    for (const h of habs) { const k = cleHab(h); const r = rangExpiration(h); if (!m.has(k) || r > rangs.get(k)) { m.set(k, h.id); rangs.set(k, r); } }
    return m;
  }
  function etatEcheance(dateEcheance, ref, jours) {
    if (!dateEcheance) return 'valide';
    if (dateEcheance < ref) return 'expiree';
    if (joursEntre(ref, dateEcheance) <= jours) return 'bientot';
    return 'valide';
  }
  /** Index partagé des listes (évite les recherches répétées). */
  function index(ref) {
    ref = ref || aujourdhui();
    const habs = db.list(HAB);
    const courantes = habilitationsCourantes(habs);
    const habParPers = new Map();
    for (const h of habs) { const k = Number(h.personnelId); if (!habParPers.has(k)) habParPers.set(k, []); habParPers.get(k).push(h); }
    const absJour = new Map();
    for (const a of db.list(ABS, (x) => x.statut === 'validee' && x.dateDebut <= ref && x.dateFin >= ref && typeRendAbsent(x.typeCode))) absJour.set(Number(a.personnelId), a);
    const visites = new Map();
    for (const v of db.list(VIS)) { const k = Number(v.personnelId); if (!visites.has(k)) visites.set(k, []); visites.get(k).push(v); }
    for (const l of visites.values()) l.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
    return {
      ref, jours: cfgRh().alerteJoursAvantEcheance, courantes, habParPers, absJour, visites,
      users: new Map(db.list('users').map((u) => [u.id, u])),
      secteurs: new Map(db.list('secteurs').map((s) => [s.id, s])),
    };
  }
  function nomUser(id, users) {
    if (id == null) return '';
    const u = users ? users.get(Number(id)) : db.get('users', id);
    return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '';
  }
  function etatHabilitation(h, idx) {
    if (idx.courantes.get(cleHab(h)) !== h.id) return 'remplacee';
    return etatEcheance(h.dateExpiration, idx.ref, idx.jours);
  }
  /** Visite de référence pour l'échéance : la plus récente qui a eu lieu (sinon la plus récente). */
  function visiteReference(liste, ref) {
    if (!liste || !liste.length) return null;
    return liste.find((v) => v.date <= ref) || liste[0];
  }
  function etatVisite(v, idx) {
    if (!v || !v.prochaineVisite) return null;
    const aVenir = (idx.visites.get(Number(v.personnelId)) || []).find((x) => x.date > idx.ref && x.date >= (v.date || ''));
    if (aVenir && v.date <= idx.ref) return 'programmee';
    return etatEcheance(v.prochaineVisite, idx.ref, idx.jours);
  }

  // ----- Représentations ---------------------------------------------------------------------------
  function sortiePersonnel(req, p) {
    const o = Object.assign({}, p);
    if (!can(req, MODULE, 'modifier')) delete o.coutHoraire;
    return o;
  }
  function resumeDoc(d, i) { return { index: i, nom: d.nom, type: d.type, taille: d.taille, date: d.date, userId: d.userId, userNom: ctx.nomUser(d.userId), description: d.description || '' }; }

  function resumePersonnel(req, p, idx) {
    const habs = (idx.habParPers.get(p.id) || []).filter((h) => idx.courantes.get(cleHab(h)) === h.id);
    const resumeHab = { total: habs.length, valides: 0, bientot: 0, expirees: 0 };
    for (const h of habs) { const e = etatEcheance(h.dateExpiration, idx.ref, idx.jours); if (e === 'expiree') resumeHab.expirees++; else if (e === 'bientot') resumeHab.bientot++; else resumeHab.valides++; }
    const u = p.userId != null ? idx.users.get(Number(p.userId)) : null;
    const managerId = managerDe(p, idx.users);
    const siteId = perms.siteDuSecteur(db, p.secteurId, idx.secteurs);
    const abs = idx.absJour.get(p.id);
    const v = visiteReference(idx.visites.get(p.id), idx.ref);
    const secteur = p.secteurId != null ? idx.secteurs.get(Number(p.secteurId)) : null;
    return Object.assign(sortiePersonnel(req, p), {
      nomComplet: nomPersonne(p),
      secteurNom: secteur ? secteur.nom : '',
      secteurChemin: cheminSecteur(p.secteurId, idx.secteurs),
      siteId, siteNom: siteId != null && idx.secteurs.get(siteId) ? idx.secteurs.get(siteId).nom : '',
      userLogin: u ? u.login : '', userActif: u ? u.actif !== false : null,
      managerId, managerNom: nomUser(managerId, idx.users),
      habilitationsResume: resumeHab,
      absentAujourdhui: abs ? { id: abs.id, typeCode: abs.typeCode, dateDebut: abs.dateDebut, dateFin: abs.dateFin, demiJournee: abs.demiJournee || null } : null,
      derniereVisite: v ? { id: v.id, date: v.date, type: v.type, aptitude: v.aptitude, prochaineVisite: v.prochaineVisite || null, etat: etatVisite(v, idx) } : null,
      ancienneteMois: p.dateEntree && p.dateEntree <= idx.ref ? Math.max(0, Math.floor(joursEntre(p.dateEntree, (p.dateSortie && p.dateSortie < idx.ref) ? p.dateSortie : idx.ref) / 30.4375)) : null,
      modifiable: modifiable(req, p),
    });
  }

  function enrichirHabilitation(req, h, idx, persMap) {
    const { documents, ...reste } = h;
    const p = persMap ? persMap.get(Number(h.personnelId)) : db.get(PERS, h.personnelId);
    const type = ctx.liste('typesHabilitation').find((t) => t.code === h.typeCode);
    const etat = etatHabilitation(h, idx);
    return Object.assign(reste, {
      etat, etatLibelle: ETATS_ECHEANCE[etat],
      joursRestants: h.dateExpiration ? joursEntre(idx.ref, h.dateExpiration) : null,
      typeLibelle: type ? type.label : h.typeCode, typeCouleur: (type && type.couleur) || '#6b7280', dureeMois: type && type.dureeMois != null ? Number(type.dureeMois) : null,
      personnelNom: nomPersonne(p), matricule: p ? p.matricule : '', personnelActif: p ? p.actif !== false : false,
      documents: (documents || []).map(resumeDoc), nbDocuments: (documents || []).length,
      modifiable: modifiable(req, h),
    });
  }
  function enrichirVisite(req, v, idx, persMap) {
    const p = persMap ? persMap.get(Number(v.personnelId)) : db.get(PERS, v.personnelId);
    const liste = idx.visites.get(Number(v.personnelId)) || [];
    const reference = visiteReference(liste, idx.ref);
    const etat = reference && reference.id === v.id ? etatVisite(v, idx) : (v.prochaineVisite ? 'remplacee' : null);
    return Object.assign({}, v, {
      typeLibelle: libelle('typesVisiteMedicale', v.type), aptitudeLibelle: libelle('aptitudesMedicales', v.aptitude),
      etat, joursRestants: v.prochaineVisite ? joursEntre(idx.ref, v.prochaineVisite) : null,
      personnelNom: nomPersonne(p), matricule: p ? p.matricule : '',
      modifiable: modifiable(req, v),
    });
  }
  function dureeAbsence(a, du, au) {
    const d = du && du > a.dateDebut ? du : a.dateDebut;
    const f = au && au < a.dateFin ? au : a.dateFin;
    if (f < d) return 0;
    if (a.demiJournee) return estOuvre(d) ? 0.5 : 0;
    return joursOuvres(d, f);
  }
  function peutDecider(req, a, p, users) {
    if (!a || a.statut !== 'demandee' || !p) return false;
    if (Number(p.userId) === req.user.id && !(req.perms && req.perms.estAdmin)) return false;
    if (managerDe(p, users) === req.user.id) return true;
    if (!can(req, MODULE, 'valider') || !modifiable(req, a)) return false;
    const wf = ctx.config().workflow || {};
    if (wf.validerParSuperieurUniquement && !(req.perms && req.perms.estAdmin) && managerDe(p, users) != null) return false;
    return true;
  }
  function enrichirAbsence(req, a, idx, persMap) {
    const p = persMap ? persMap.get(Number(a.personnelId)) : db.get(PERS, a.personnelId);
    const users = idx ? idx.users : null;
    const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
    return Object.assign({}, a, {
      personnelNom: nomPersonne(p), matricule: p ? p.matricule : '', userId: p && p.userId != null ? Number(p.userId) : null,
      typeLibelle: type ? type.label : a.typeCode, typeCouleur: (type && type.couleur) || '#6b7280', rendAbsent: typeRendAbsent(a.typeCode),
      statutLibelle: libelle('statutsAbsence', a.statut), statutCouleur: couleurListe('statutsAbsence', a.statut),
      nbJours: dureeAbsence(a), demiJourneeLibelle: a.demiJournee ? DEMI_JOURNEES[a.demiJournee] || '' : '',
      demandeurNom: nomUser(a.demandeurUserId, users), valideurNom: nomUser(a.valideurUserId, users),
      managerId: managerDe(p, users), managerNom: nomUser(managerDe(p, users), users),
      peutDecider: peutDecider(req, a, p, users),
      modifiable: modifiable(req, a),
    });
  }
  function enrichirFormation(req, f, persMap) {
    const participants = (f.personnelIds || []).map((id) => {
      const p = persMap ? persMap.get(Number(id)) : db.get(PERS, id);
      return p ? { id: p.id, nomComplet: nomPersonne(p), matricule: p.matricule || '', secteurId: p.secteurId, actif: p.actif !== false, present: f.statut === 'realisee' ? (f.presents || f.personnelIds || []).map(Number).includes(p.id) : null } : { id: Number(id), nomComplet: '(fiche supprimée)', matricule: '', secteurId: null, actif: false, present: null };
    });
    const type = f.habilitationTypeCode ? ctx.liste('typesHabilitation').find((t) => t.code === f.habilitationTypeCode) : null;
    const fournisseur = f.fournisseurId != null ? db.get('fournisseurs', f.fournisseurId) : null;
    const facture = f.factureId != null ? db.get('factures', f.factureId) : null;
    return Object.assign({}, f, {
      participants, nbParticipants: participants.length,
      statutLibelle: libelle('statutsFormation', f.statut), statutCouleur: couleurListe('statutsFormation', f.statut),
      habilitationLibelle: type ? type.label : (f.habilitationTypeCode || ''),
      fournisseurNom: fournisseur ? fournisseur.nom || '' : '',
      factureNumero: facture ? (facture.numero || facture.reference || `#${facture.id}`) : '',
      secteurNom: f.secteurId != null ? ((db.get('secteurs', f.secteurId) || {}).nom || '') : '',
      coutParParticipant: participants.length && f.cout != null ? arrondi(Number(f.cout) / participants.length) : null,
      modifiable: modifiable(req, f),
    });
  }

  // ----- Filtres de listes ------------------------------------------------------------------------
  function idsSecteurs(id) { return new Set(perms.secteursDescendants(db, [id])); }
  function filtrerPersonnel(req, q, idx) {
    q = q || {};
    let rows = ctx.scope(req, db.list(PERS));
    const secteurId = idRef(q.secteurId, 'Service');
    if (secteurId) { const ids = idsSecteurs(secteurId); rows = rows.filter((p) => ids.has(Number(p.secteurId))); }
    const siteId = idRef(q.siteId, 'Site');
    if (siteId) { const ids = idsSecteurs(siteId); rows = rows.filter((p) => ids.has(Number(p.secteurId))); }
    if (q.typeContratCode) rows = rows.filter((p) => p.typeContratCode === q.typeContratCode);
    if (q.actif === '1' || q.actif === 'true') rows = rows.filter((p) => p.actif !== false);
    else if (q.actif === '0' || q.actif === 'false') rows = rows.filter((p) => p.actif === false);
    const managerId = idRef(q.managerUserId, 'Responsable');
    if (managerId) { const users = idx ? idx.users : null; rows = rows.filter((p) => managerDe(p, users) === managerId); }
    if (q.compte === '1') rows = rows.filter((p) => p.userId != null);
    if (q.habilitationTypeCode) {
      const ix = idx || index();
      rows = rows.filter((p) => (ix.habParPers.get(p.id) || []).some((h) => h.typeCode === q.habilitationTypeCode && ix.courantes.get(cleHab(h)) === h.id && etatEcheance(h.dateExpiration, ix.ref, ix.jours) !== 'expiree'));
    }
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase();
      rows = rows.filter((p) => [p.matricule, p.nom, p.prenom, nomPersonne(p), p.fonction, p.email, p.telephone].some((v) => String(v || '').toLowerCase().includes(s)));
    }
    return rows.sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr') || String(a.prenom || '').localeCompare(String(b.prenom || ''), 'fr'));
  }
  function filtreCommun(req, rows, q) {
    const personnelId = idRef(q.personnelId, 'Personne');
    if (personnelId) rows = rows.filter((x) => Number(x.personnelId) === personnelId);
    const secteurId = idRef(q.secteurId, 'Service');
    if (secteurId) { const ids = idsSecteurs(secteurId); rows = rows.filter((x) => ids.has(Number(x.secteurId))); }
    const siteId = idRef(q.siteId, 'Site');
    if (siteId) { const ids = idsSecteurs(siteId); rows = rows.filter((x) => ids.has(Number(x.secteurId))); }
    return rows;
  }
  function filtrerHabilitations(req, q, idx) {
    q = q || {};
    let rows = filtreCommun(req, ctx.scope(req, db.list(HAB)), q);
    if (q.typeCode) rows = rows.filter((h) => h.typeCode === q.typeCode);
    if (q.etat) { const etats = String(q.etat).split(','); rows = rows.filter((h) => etats.includes(etatHabilitation(h, idx))); } else if (q.historique !== '1') rows = rows.filter((h) => etatHabilitation(h, idx) !== 'remplacee');
    if (q.actif === '1') { const actifs = new Set(db.list(PERS, (p) => p.actif !== false).map((p) => p.id)); rows = rows.filter((h) => actifs.has(Number(h.personnelId))); }
    return rows.sort((a, b) => String(a.dateExpiration || '9999').localeCompare(String(b.dateExpiration || '9999')));
  }
  function filtrerFormations(req, q) {
    q = q || {};
    let rows = ctx.scope(req, db.list(FOR));
    if (q.statut) rows = rows.filter((f) => f.statut === q.statut);
    if (q.annee) { const an = String(q.annee).slice(0, 4); rows = rows.filter((f) => String(f.dateDebut || '').startsWith(an) || String(f.dateFin || '').startsWith(an)); }
    const personnelId = idRef(q.personnelId, 'Personne');
    if (personnelId) rows = rows.filter((f) => (f.personnelIds || []).map(Number).includes(personnelId));
    if (q.habilitationTypeCode) rows = rows.filter((f) => f.habilitationTypeCode === q.habilitationTypeCode);
    const siteId = idRef(q.siteId, 'Site');
    if (siteId) { const ids = idsSecteurs(siteId); rows = rows.filter((f) => ids.has(Number(f.secteurId))); }
    if (q.recherche) { const s = String(q.recherche).toLowerCase(); rows = rows.filter((f) => [f.intitule, f.organisme, f.lieu].some((v) => String(v || '').toLowerCase().includes(s))); }
    return rows.sort((a, b) => String(b.dateDebut || '').localeCompare(String(a.dateDebut || '')));
  }
  function filtrerVisites(req, q, idx) {
    q = q || {};
    let rows = filtreCommun(req, ctx.scope(req, db.list(VIS)), q);
    if (q.type) rows = rows.filter((v) => v.type === q.type);
    if (q.aptitude) rows = rows.filter((v) => v.aptitude === q.aptitude);
    if (q.etat) { const etats = String(q.etat).split(','); rows = rows.filter((v) => etats.includes(enrichirVisite(req, v, idx).etat)); }
    return rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  function filtrerAbsences(req, q) {
    q = q || {};
    let rows = filtreCommun(req, ctx.scope(req, db.list(ABS)), q);
    if (q.statut) { const st = String(q.statut).split(','); rows = rows.filter((a) => st.includes(a.statut)); }
    if (q.typeCode) rows = rows.filter((a) => a.typeCode === q.typeCode);
    const du = dateISO(q.du, 'Date de début'); const au = dateISO(q.au, 'Date de fin');
    if (du) rows = rows.filter((a) => a.dateFin >= du);
    if (au) rows = rows.filter((a) => a.dateDebut <= au);
    if (q.aValider === '1') { const users = new Map(db.list('users').map((u) => [u.id, u])); rows = rows.filter((a) => peutDecider(req, a, db.get(PERS, a.personnelId), users)); }
    return rows.sort((a, b) => String(b.dateDebut || '').localeCompare(String(a.dateDebut || '')) || b.id - a.id);
  }
  const mapPersonnel = () => new Map(db.list(PERS).map((p) => [p.id, p]));

  // ----- Notifications ------------------------------------------------------------------------
  /** Notifie en adaptant le lien : la vue RH pour ceux qui y ont accès, sinon « Mon dossier RH ». */
  function notifier(userIds, { titre, message, type }, lienRh, exclure) {
    const config = db.getConfig();
    const avec = []; const sans = [];
    for (const id of new Set((userIds || []).filter((x) => x != null).map(Number))) {
      if (exclure != null && id === Number(exclure)) continue;
      const u = db.get('users', id);
      if (!u || u.actif === false) continue;
      const p = perms.effectivePermissions(db, u, null, config);
      (perms.can(p, MODULE, 'voir') ? avec : sans).push(id);
    }
    if (avec.length) ctx.notify(avec, { titre, message, type: type || 'info', lien: lienRh || '#/rh' });
    if (sans.length) ctx.notify(sans, { titre, message: `${message} (menu utilisateur › Mon dossier RH)`, type: type || 'info', lien: '' });
    return avec.length + sans.length;
  }
  const couvre = (p, secteurId) => p.portee === 'tous' || secteurId == null || (p.secteurIds || []).includes(Number(secteurId));
  function valideurs(p) {
    const ids = new Set();
    const m = managerDe(p);
    if (m != null) ids.add(m);
    const wf = ctx.config().workflow || {};
    if (!(wf.validerParSuperieurUniquement && m != null)) for (const u of ctx.usersAvecDroit(MODULE, 'valider', (u, pe) => couvre(pe, p.secteurId))) ids.add(u.id);
    if (p.userId != null) ids.delete(Number(p.userId));
    return Array.from(ids);
  }
  function gestionnairesRh(secteurId) { return ctx.usersAvecDroit(MODULE, 'modifier', (u, pe) => couvre(pe, secteurId)).map((u) => u.id); }

  // ----- Personnel : validation --------------------------------------------------------------------
  function matriculeLibre(m, existant) {
    const n = String(m).trim().toLowerCase();
    return !db.findOne(PERS, (x) => String(x.matricule || '').trim().toLowerCase() === n && (!existant || x.id !== existant.id));
  }
  function genererMatricule() {
    const gabarit = (ctx.config().numerotation || {}).mat || 'MAT-{num:4}';
    for (let i = 0; i < 1000; i++) { const n = db.nextNumber('mat', gabarit); if (matriculeLibre(n, null)) return n; }
    throw new HttpError(500, 'Impossible de générer un matricule unique');
  }
  function validerCompetences(v) {
    if (v == null || v === '') return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'Compétences : liste attendue');
    if (v.length > MAX_COMPETENCES) throw new HttpError(400, `Compétences : ${MAX_COMPETENCES} au maximum`);
    const vus = new Set();
    const out = [];
    for (const c of v) {
      if (!c || typeof c !== 'object') throw new HttpError(400, 'Compétence invalide');
      const lib = texte(c.libelle, 'Libellé de la compétence', { requis: true, max: 100 });
      const niveau = nombre(c.niveau == null || c.niveau === '' ? 1 : c.niveau, `Niveau de « ${lib} »`, { min: 1, max: 4, entier: true });
      const k = lib.toLowerCase();
      if (vus.has(k)) throw new HttpError(400, `Compétence en double : « ${lib} »`);
      vus.add(k);
      out.push({ libelle: lib, niveau });
    }
    return out;
  }
  function validerPersonnel(req, body, existant) {
    const b = objet(body);
    const val = (cle) => (b[cle] === undefined ? (existant ? existant[cle] : undefined) : b[cle]);
    const out = {};
    // Compte GMAO lié (unique)
    const userId = idRef(val('userId'), 'Compte GMAO');
    let user = null;
    if (userId != null) {
      user = db.get('users', userId);
      if (!user) throw new HttpError(400, 'Compte GMAO introuvable');
      if (db.findOne(PERS, (x) => x.userId != null && Number(x.userId) === userId && (!existant || x.id !== existant.id))) throw new HttpError(400, 'Ce compte GMAO est déjà lié à une autre fiche du personnel');
    }
    out.userId = userId;
    const depuisCompte = (cle, v) => ((v == null || v === '') && user && !existant ? user[cle] : v);
    out.nom = texte(depuisCompte('nom', val('nom')), 'Le nom', { requis: true, max: 100 });
    out.prenom = texte(depuisCompte('prenom', val('prenom')), 'Le prénom', { max: 100 });
    out.fonction = texte(depuisCompte('fonction', val('fonction')), 'La fonction', { max: 150 });
    out.telephone = texte(depuisCompte('telephone', val('telephone')), 'Le téléphone', { max: 30 });
    out.email = texte(depuisCompte('email', val('email')), 'L\'adresse e-mail', { max: 150 });
    if (out.email && !RE_EMAIL.test(out.email)) throw new HttpError(400, 'Adresse e-mail invalide');

    // Matricule : saisi (unique), repris du compte ou généré
    const mat = texte(b.matricule, 'Le matricule', { max: 30 });
    if (mat) {
      if (!matriculeLibre(mat, existant)) throw new HttpError(400, `Le matricule « ${mat} » est déjà utilisé`);
      out.matricule = mat;
    } else if (!existant) {
      const duCompte = user && user.matricule ? String(user.matricule).trim() : '';
      out.matricule = duCompte && duCompte.length <= 30 && matriculeLibre(duCompte, null) ? duCompte : genererMatricule();
    }

    // Rattachement
    const secteurId = idRef(val('secteurId'), 'Le site / service');
    out.secteurId = verifierSecteur(req, secteurId, 'Le site / service');
    const managerUserId = idRef(val('managerUserId'), 'Le responsable (N+1)');
    if (managerUserId != null) {
      if (!db.get('users', managerUserId)) throw new HttpError(400, 'Responsable (N+1) introuvable');
      if (userId != null && managerUserId === userId) throw new HttpError(400, 'Une personne ne peut pas être son propre responsable');
    }
    out.managerUserId = managerUserId;

    // Contrat
    out.typeContratCode = codeListeObligatoire('typesContrat', val('typeContratCode'), 'Type de contrat');
    out.dateEntree = dateISO(val('dateEntree'), 'Date d\'entrée');
    out.dateSortie = dateISO(val('dateSortie'), 'Date de sortie');
    if (out.dateEntree && out.dateSortie && out.dateSortie < out.dateEntree) throw new HttpError(400, 'La date de sortie ne peut pas précéder la date d\'entrée');

    // Contact d'urgence
    const cu = val('contactUrgence');
    if (cu != null && cu !== '' && (typeof cu !== 'object' || Array.isArray(cu))) throw new HttpError(400, 'Contact d\'urgence invalide');
    out.contactUrgence = { nom: texte(cu && cu.nom, 'Nom du contact d\'urgence', { max: 100 }), telephone: texte(cu && cu.telephone, 'Téléphone du contact d\'urgence', { max: 30 }) };

    // Coût horaire : réservé aux personnes pouvant modifier le RH
    if (can(req, MODULE, 'modifier')) out.coutHoraire = nombre(val('coutHoraire'), 'Le coût horaire', { min: 0, max: 10000 });
    else out.coutHoraire = existant ? (existant.coutHoraire == null ? null : existant.coutHoraire) : null;

    out.competences = validerCompetences(val('competences'));
    out.notes = texte(val('notes'), 'Les notes', { max: 5000 });
    out.actif = b.actif === undefined ? (existant ? existant.actif !== false : true) : !!b.actif;
    if (b.champs !== undefined || !existant) out.champs = ctx.champsPerso(PERS, b.champs || (existant && existant.champs) || {});
    return out;
  }

  // ----- Dossier complet -------------------------------------------------------------------------
  function activiteMaintenance(req, p) {
    if (p.userId == null) return { compteLie: false };
    const uid = Number(p.userId);
    const finaux = statutsOtFinaux();
    const concerne = (o) => Number(o.technicienId) === uid || (o.techniciens || []).map(Number).includes(uid) || (o.tempsPasse || []).some((t) => Number(t.userId) === uid);
    const ots = db.list('ot', concerne);
    const limite = ajouterMois(aujourdhui(), -12);
    let heures = 0; let heures12 = 0;
    const parType = new Map();
    const heuresOt = new Map();
    for (const o of ots) {
      parType.set(o.typeCode || '', (parType.get(o.typeCode || '') || 0) + 1);
      for (const t of o.tempsPasse || []) {
        if (Number(t.userId) !== uid) continue;
        const h = Number(t.heures) || 0;
        heures += h; heuresOt.set(o.id, (heuresOt.get(o.id) || 0) + h);
        if (String(t.date || '').slice(0, 10) >= limite) heures12 += h;
      }
    }
    const date = (o) => String(o.dateFin || o.dateDebut || o.datePrevue || o.createdAt || '');
    const voirOt = can(req, 'ot', 'voir');
    const visibles = voirOt ? ctx.scope(req, ots) : [];
    return {
      compteLie: true, userId: uid, voirOt,
      nbOt: ots.length, nbOtOuverts: ots.filter((o) => !finaux.has(o.statut)).length, nbOtTermines: ots.filter((o) => finaux.has(o.statut)).length,
      heures: arrondi(heures), heures12Mois: arrondi(heures12),
      parType: Array.from(parType.entries()).map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n),
      derniersOt: visibles.sort((a, b) => date(b).localeCompare(date(a))).slice(0, 20).map((o) => ({
        id: o.id, numero: o.numero, titre: o.titre, statut: o.statut, typeCode: o.typeCode, prioriteCode: o.prioriteCode,
        datePrevue: o.datePrevue || null, dateDebut: o.dateDebut || null, dateFin: o.dateFin || null,
        responsable: Number(o.technicienId) === uid, heures: arrondi(heuresOt.get(o.id) || 0),
      })),
    };
  }
  function renouvellementsPrevus() {
    const m = new Map();
    for (const f of db.list(FOR, (x) => x.statut === 'planifiee' && x.habilitationTypeCode)) {
      for (const pid of f.personnelIds || []) {
        const k = `${Number(pid)}|${f.habilitationTypeCode}`;
        if (!m.has(k) || String(f.dateDebut) < String(m.get(k).dateDebut)) m.set(k, { formationId: f.id, intitule: f.intitule, dateDebut: f.dateDebut, dateFin: f.dateFin });
      }
    }
    return m;
  }
  function dossier(req, p) {
    const idx = index();
    const persMap = new Map([[p.id, p]]);
    const prevus = renouvellementsPrevus();
    const ordreType = new Map(ctx.liste('typesHabilitation').map((t, i) => [t.code, i]));
    const habilitations = (idx.habParPers.get(p.id) || []).map((h) => Object.assign(enrichirHabilitation(req, h, idx, persMap), { renouvellementPrevu: prevus.get(cleHab(h)) || null }))
      .sort((a, b) => (a.etat === 'remplacee') - (b.etat === 'remplacee') || (ordreType.get(a.typeCode) ?? 99) - (ordreType.get(b.typeCode) ?? 99) || String(b.dateExpiration || '9999').localeCompare(String(a.dateExpiration || '9999')));
    const formations = db.list(FOR, (f) => (f.personnelIds || []).map(Number).includes(p.id)).sort((a, b) => String(b.dateDebut || '').localeCompare(String(a.dateDebut || ''))).map((f) => {
      const e = enrichirFormation(req, f);
      return { id: e.id, intitule: e.intitule, organisme: e.organisme, lieu: e.lieu || '', dateDebut: e.dateDebut, dateFin: e.dateFin, dureeHeures: e.dureeHeures, statut: e.statut, statutLibelle: e.statutLibelle, habilitationTypeCode: e.habilitationTypeCode || null, habilitationLibelle: e.habilitationLibelle, nbParticipants: e.nbParticipants, present: e.statut === 'realisee' ? (e.presents || e.personnelIds || []).map(Number).includes(p.id) : null, cout: e.cout, coutParParticipant: e.coutParParticipant, visible: ctx.canSee(req, f) };
    });
    const visites = (idx.visites.get(p.id) || []).map((v) => enrichirVisite(req, v, idx, persMap));
    const absences = db.list(ABS, (a) => Number(a.personnelId) === p.id).sort((a, b) => String(b.dateDebut).localeCompare(String(a.dateDebut))).map((a) => enrichirAbsence(req, a, idx, persMap));
    const annee = idx.ref.slice(0, 4);
    const parType = {};
    let joursAnnee = 0;
    for (const a of absences) {
      if (a.statut !== 'validee') continue;
      const j = dureeAbsence(a, `${annee}-01-01`, `${annee}-12-31`);
      if (!j) continue;
      parType[a.typeCode] = arrondi((parType[a.typeCode] || 0) + j, 1);
      if (a.rendAbsent) joursAnnee += j;
    }
    const u = p.userId != null ? idx.users.get(Number(p.userId)) : null;
    return Object.assign(resumePersonnel(req, p, idx), {
      compte: u ? { id: u.id, login: u.login, nom: nomUser(u.id, idx.users), actif: u.actif !== false, fonction: u.fonction || '' } : null,
      habilitations, formations, visites, absences,
      activite: activiteMaintenance(req, p),
      statistiques: { annee, joursAbsenceAnnee: arrondi(joursAnnee, 1), joursParType: parType, nbFormations: formations.filter((f) => f.statut === 'realisee').length, heuresFormation: arrondi(formations.filter((f) => f.statut === 'realisee' && f.present !== false).reduce((s, f) => s + (Number(f.dureeHeures) || 0), 0), 1) },
      createdByNom: ctx.nomUser(p.createdBy),
      references: nbReferences(p.id),
    });
  }
  function nbReferences(id) {
    return {
      habilitations: db.count(HAB, (h) => Number(h.personnelId) === id),
      formations: db.count(FOR, (f) => (f.personnelIds || []).map(Number).includes(id)),
      visites: db.count(VIS, (v) => Number(v.personnelId) === id),
      absences: db.count(ABS, (a) => Number(a.personnelId) === id),
    };
  }
  /** Les enregistrements rattachés à une personne suivent son site / service. */
  function propagerSecteur(personnelId, secteurId) {
    for (const col of [HAB, VIS, ABS]) for (const x of db.list(col, (r) => Number(r.personnelId) === personnelId && Number(r.secteurId) !== Number(secteurId))) db.update(col, x.id, { secteurId });
  }

  // ----- Routes : personnel -----------------------------------------------------------------------
  router.get('/api/rh/personnel', async (req) => {
    const idx = index();
    return filtrerPersonnel(req, req.query, idx).map((p) => resumePersonnel(req, p, idx));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/rh/personnel/:id', async (req) => dossier(req, ctx.getVisible(req, PERS, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/rh/personnel', async (req) => {
    const data = validerPersonnel(req, req.body, null);
    data.createdBy = req.user.id;
    const p = db.insert(PERS, data);
    ctx.audit(req, 'creation', PERS, p.id, `Fiche du personnel ${p.matricule} ${nomPersonne(p)}`);
    return dossier(req, p);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/rh/personnel/:id', async (req) => {
    const existant = ctx.getVisible(req, PERS, req.params.id);
    const data = validerPersonnel(req, req.body, existant);
    const p = db.update(PERS, existant.id, data);
    if (Number(existant.secteurId) !== Number(p.secteurId)) propagerSecteur(p.id, p.secteurId);
    const changements = [];
    if (existant.actif !== false && p.actif === false) changements.push('désactivation');
    if (existant.actif === false && p.actif !== false) changements.push('réactivation');
    if (Number(existant.secteurId) !== Number(p.secteurId)) changements.push(`mutation vers ${(db.get('secteurs', p.secteurId) || {}).nom || ''}`);
    if ((existant.coutHoraire ?? null) !== (p.coutHoraire ?? null)) changements.push('coût horaire');
    ctx.audit(req, 'modification', PERS, p.id, `Fiche du personnel ${p.matricule} ${nomPersonne(p)}${changements.length ? ' (' + changements.join(', ') + ')' : ''}`);
    return dossier(req, p);
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/rh/personnel/:id', async (req) => {
    const existant = ctx.getVisible(req, PERS, req.params.id);
    const refs = nbReferences(existant.id);
    const total = refs.habilitations + refs.formations + refs.visites + refs.absences;
    if (req.query.definitif === '1') {
      // Effacement complet (droit à l'effacement) : réservé à l'administrateur
      if (!req.perms.estAdmin) throw new HttpError(403, 'L\'effacement définitif d\'un dossier est réservé à l\'administrateur');
      for (const col of [HAB, VIS, ABS]) for (const x of db.list(col, (r) => Number(r.personnelId) === existant.id)) db.remove(col, x.id);
      for (const f of db.list(FOR, (x) => (x.personnelIds || []).map(Number).includes(existant.id))) db.update(FOR, f.id, { personnelIds: f.personnelIds.filter((x) => Number(x) !== existant.id), presents: (f.presents || []).filter((x) => Number(x) !== existant.id) });
      db.remove(PERS, existant.id);
      ctx.audit(req, 'suppression', PERS, existant.id, `Effacement définitif du dossier ${existant.matricule} ${nomPersonne(existant)} (${total} élément(s) rattaché(s))`);
      return { ok: true, desactive: false, efface: true };
    }
    if (total) {
      db.update(PERS, existant.id, { actif: false });
      ctx.audit(req, 'desactivation', PERS, existant.id, `Fiche du personnel ${existant.matricule} ${nomPersonne(existant)} désactivée (historique : ${refs.habilitations} habilitation(s), ${refs.formations} formation(s), ${refs.visites} visite(s), ${refs.absences} absence(s))`);
      return { ok: true, desactive: true, references: refs };
    }
    db.remove(PERS, existant.id);
    ctx.audit(req, 'suppression', PERS, existant.id, `Fiche du personnel ${existant.matricule} ${nomPersonne(existant)}`);
    return { ok: true, desactive: false };
  }, { perm: [MODULE, 'supprimer'] });

  // ----- Habilitations ------------------------------------------------------------------------------
  function typeHabilitation(code) { return ctx.liste('typesHabilitation').find((t) => t.code === code) || null; }
  function expirationParDefaut(typeCode, dateObtention) {
    const t = typeHabilitation(typeCode);
    const mois = t && Number(t.dureeMois) > 0 ? Number(t.dureeMois) : 0;
    return mois && dateObtention ? ajouterMois(dateObtention, mois) : null;
  }
  function validerDocument(d) {
    if (!d || typeof d !== 'object') throw new HttpError(400, 'Document invalide');
    const nomDoc = String(d.nom || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
    if (!nomDoc) throw new HttpError(400, 'Le nom du document est obligatoire');
    const contenu = typeof d.contenu === 'string' ? d.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu du document invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'Le document est vide');
    if (taille > TAILLE_MAX_DOC) throw new HttpError(400, `Document trop volumineux (${(taille / 1024 / 1024).toFixed(1)} Mo, maximum 5 Mo)`);
    const type = String(d.type || m[1] || 'application/octet-stream').slice(0, 100);
    return { nom: nomDoc, type, taille, contenu: `data:${m[1] || type};base64,${base64}`, description: String(d.description || '').trim().slice(0, 300) };
  }
  function validerHabilitation(req, body, existant) {
    const b = objet(body);
    const val = (cle) => (b[cle] === undefined ? (existant ? existant[cle] : undefined) : b[cle]);
    const out = {};
    let personne;
    if (existant) {
      personne = db.get(PERS, existant.personnelId);
      if (b.personnelId !== undefined && b.personnelId !== null && b.personnelId !== '' && Number(b.personnelId) !== Number(existant.personnelId)) throw new HttpError(400, 'Une habilitation ne peut pas être transférée à une autre personne');
    } else {
      const pid = idRef(b.personnelId, 'La personne');
      if (!pid) throw new HttpError(400, 'La personne est obligatoire');
      const p = db.get(PERS, pid);
      if (!p) throw new HttpError(400, 'Personne introuvable');
      personne = ctx.getVisible(req, PERS, pid);
    }
    out.personnelId = personne ? personne.id : existant.personnelId;
    out.secteurId = personne ? personne.secteurId : existant.secteurId;
    const typeCode = val('typeCode');
    if (typeCode == null || typeCode === '') throw new HttpError(400, 'Le type d\'habilitation est obligatoire');
    out.typeCode = codeListeObligatoire('typesHabilitation', typeCode, 'Type d\'habilitation');
    const type = typeHabilitation(out.typeCode);
    out.intitule = texte(val('intitule'), 'L\'intitulé', { max: 200 }) || (type ? type.label : out.typeCode);
    out.organisme = texte(val('organisme'), 'L\'organisme', { max: 150 });
    out.numero = texte(val('numero'), 'Le numéro', { max: 60 });
    out.commentaire = texte(val('commentaire'), 'Le commentaire', { max: 1000 });
    out.dateObtention = dateISO(val('dateObtention'), 'Date d\'obtention', { requis: true });
    if (out.dateObtention > ajouterJours(aujourdhui(), 1)) throw new HttpError(400, 'La date d\'obtention ne peut pas être dans le futur');
    const recalcul = b.dateExpiration === '' || b.dateExpiration === null
      || (b.dateExpiration === undefined && (!existant || existant.dateObtention !== out.dateObtention || existant.typeCode !== out.typeCode));
    out.dateExpiration = recalcul ? expirationParDefaut(out.typeCode, out.dateObtention) : dateISO(val('dateExpiration'), 'Date d\'expiration');
    if (out.dateExpiration && out.dateExpiration < out.dateObtention) throw new HttpError(400, 'La date d\'expiration ne peut pas précéder la date d\'obtention');
    out.expirationCalculee = !!recalcul && !!out.dateExpiration;
    if (existant && (existant.dateExpiration !== out.dateExpiration)) out.alertes = {};
    return out;
  }

  router.get('/api/rh/habilitations', async (req) => {
    const idx = index(); const persMap = mapPersonnel();
    const prevus = renouvellementsPrevus();
    return filtrerHabilitations(req, req.query, idx).map((h) => Object.assign(enrichirHabilitation(req, h, idx, persMap), { renouvellementPrevu: prevus.get(cleHab(h)) || null }));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/rh/habilitations/:id', async (req) => {
    const h = ctx.getVisible(req, HAB, req.params.id);
    return enrichirHabilitation(req, h, index());
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/rh/habilitations', async (req) => {
    const b = objet(req.body);
    const data = validerHabilitation(req, b, null);
    const docs = Array.isArray(b.documents) ? b.documents : [];
    if (docs.length > MAX_DOCS) throw new HttpError(400, `${MAX_DOCS} documents au maximum`);
    data.documents = docs.map((d) => Object.assign(validerDocument(d), { date: new Date().toISOString(), userId: req.user.id }));
    data.historique = []; data.alertes = {}; data.formationId = null; data.createdBy = req.user.id;
    const h = db.insert(HAB, data);
    const p = db.get(PERS, h.personnelId);
    ctx.audit(req, 'creation', HAB, h.id, `${h.intitule} — ${nomPersonne(p)} (${p ? p.matricule : ''}), valable ${h.dateExpiration ? 'jusqu\'au ' + h.dateExpiration : 'sans limite'}`);
    return enrichirHabilitation(req, h, index());
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/rh/habilitations/:id', async (req) => {
    const existant = ctx.getVisible(req, HAB, req.params.id);
    const data = validerHabilitation(req, req.body, existant);
    const h = db.update(HAB, existant.id, data);
    const p = db.get(PERS, h.personnelId);
    ctx.audit(req, 'modification', HAB, h.id, `${h.intitule} — ${nomPersonne(p)}${existant.dateExpiration !== h.dateExpiration ? ` (échéance ${existant.dateExpiration || 'aucune'} → ${h.dateExpiration || 'aucune'})` : ''}`);
    return enrichirHabilitation(req, h, index());
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/rh/habilitations/:id', async (req) => {
    const existant = ctx.getVisible(req, HAB, req.params.id);
    db.remove(HAB, existant.id);
    const p = db.get(PERS, existant.personnelId);
    ctx.audit(req, 'suppression', HAB, existant.id, `${existant.intitule} — ${nomPersonne(p)}`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  // Pièces justificatives (attestations, titres d'habilitation, CACES…)
  router.post('/api/rh/habilitations/:id/documents', async (req) => {
    const existant = ctx.getVisible(req, HAB, req.params.id);
    const docs = existant.documents || [];
    if (docs.length >= MAX_DOCS) throw new HttpError(400, `Nombre maximal de documents atteint (${MAX_DOCS})`);
    const doc = Object.assign(validerDocument(objet(req.body)), { date: new Date().toISOString(), userId: req.user.id });
    const h = db.update(HAB, existant.id, { documents: docs.concat([doc]) });
    ctx.audit(req, 'document', HAB, h.id, `Pièce jointe ajoutée à « ${h.intitule} » : ${doc.nom} (${Math.round(doc.taille / 1024)} Ko)`);
    return { ok: true, documents: h.documents.map(resumeDoc) };
  }, { perm: [MODULE, 'modifier'] });

  function indexDoc(req, h) {
    const i = Number(req.params.index);
    if (!Number.isInteger(i) || i < 0 || i >= (h.documents || []).length) throw new HttpError(404, 'Document introuvable');
    return i;
  }
  router.get('/api/rh/habilitations/:id/documents/:index', async (req, res) => {
    const h = ctx.getVisible(req, HAB, req.params.id);
    const doc = h.documents[indexDoc(req, h)];
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Document corrompu');
    const buf = Buffer.from(m[2], 'base64');
    const type = String(doc.type || m[1] || 'application/octet-stream').toLowerCase();
    const inline = (/^image\/(png|jpe?g|gif|webp|bmp)$/.test(type) || type === 'application/pdf') && req.query.telecharger !== '1';
    const dangereux = /html|javascript|xml|svg/.test(type);
    res.writeHead(200, {
      'Content-Type': dangereux ? 'application/octet-stream' : type,
      'Content-Length': buf.length,
      'Content-Disposition': `${inline && !dangereux ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.nom || 'document').replace(/'/g, '%27')}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:",
      'Cache-Control': 'private, no-store',
    });
    res.end(buf);
  }, { perm: [MODULE, 'voir'] });

  router.delete('/api/rh/habilitations/:id/documents/:index', async (req) => {
    const existant = ctx.getVisible(req, HAB, req.params.id);
    const i = indexDoc(req, existant);
    const docs = existant.documents.slice();
    const [sup] = docs.splice(i, 1);
    const h = db.update(HAB, existant.id, { documents: docs });
    ctx.audit(req, 'document', HAB, h.id, `Pièce jointe supprimée de « ${h.intitule} » : ${sup.nom}`);
    return { ok: true, documents: h.documents.map(resumeDoc) };
  }, { perm: [MODULE, 'modifier'] });

  /** Matrice personnel × types d'habilitation : qui peut intervenir sur quoi. */
  router.get('/api/rh/matrice', async (req) => {
    const q = Object.assign({ actif: '1' }, req.query);
    if (q.actif === 'tous') delete q.actif;
    const idx = index();
    const filtreTypes = q.types ? new Set(String(q.types).split(',')) : null;
    const types = ctx.liste('typesHabilitation').filter((t) => !filtreTypes || filtreTypes.has(t.code));
    const totaux = new Map(types.map((t) => [t.code, { valides: 0, bientot: 0, expirees: 0 }]));
    const personnel = filtrerPersonnel(req, q, idx).map((p) => {
      const cellules = {};
      for (const h of idx.habParPers.get(p.id) || []) {
        if (idx.courantes.get(cleHab(h)) !== h.id || !totaux.has(h.typeCode)) continue;
        const etat = etatEcheance(h.dateExpiration, idx.ref, idx.jours);
        cellules[h.typeCode] = { id: h.id, etat, dateObtention: h.dateObtention, dateExpiration: h.dateExpiration || null, intitule: h.intitule, joursRestants: h.dateExpiration ? joursEntre(idx.ref, h.dateExpiration) : null };
        const t = totaux.get(h.typeCode);
        if (etat === 'expiree') t.expirees++; else if (etat === 'bientot') t.bientot++; else t.valides++;
      }
      const siteId = perms.siteDuSecteur(db, p.secteurId, idx.secteurs);
      return { id: p.id, nomComplet: nomPersonne(p), nom: p.nom, prenom: p.prenom, matricule: p.matricule, fonction: p.fonction || '', secteurId: p.secteurId, secteurNom: (idx.secteurs.get(Number(p.secteurId)) || {}).nom || '', siteId, actif: p.actif !== false, userId: p.userId, modifiable: modifiable(req, p), cellules };
    });
    return {
      date: idx.ref, joursAlerte: idx.jours,
      types: types.map((t) => Object.assign({ code: t.code, label: t.label, couleur: t.couleur || '#6b7280', dureeMois: t.dureeMois != null ? Number(t.dureeMois) : null }, totaux.get(t.code))),
      personnel,
    };
  }, { perm: [MODULE, 'voir'] });

  /** Habilitations valides (ou à renouveler) d'un technicien, pour les autres modules (OT, planning…). */
  router.get('/api/rh/habilitations-technicien/:userId', async (req) => {
    const uid = idRef(req.params.userId, 'Utilisateur');
    const soi = uid === req.user.id;
    const metier = ['ot', 'planning', 'preventif', 'demandes'].some((m) => can(req, m, 'voir'));
    if (!soi && !metier && !can(req, MODULE, 'voir')) throw new HttpError(403, 'Droit insuffisant : consultation des habilitations');
    const date = dateISO(req.query.date, 'Date') || aujourdhui();
    const p = personnelDeUser(uid);
    if (p && !soi && !metier && !ctx.canSee(req, p)) throw new HttpError(404, 'Personne introuvable');
    const habilitations = p ? habilitationsValides(uid, date) : [];
    return { userId: uid, personnelId: p ? p.id : null, nom: p ? nomPersonne(p) : ctx.nomUser(uid), date, habilitations, typeCodes: Array.from(new Set(habilitations.map((h) => h.typeCode))) };
  });

  // ----- Formations ----------------------------------------------------------------------------------
  function validerFormation(req, body, existant) {
    const b = objet(body);
    const val = (cle) => (b[cle] === undefined ? (existant ? existant[cle] : undefined) : b[cle]);
    const out = {};
    out.intitule = texte(val('intitule'), 'L\'intitulé', { requis: true, max: 200 });
    out.organisme = texte(val('organisme'), 'L\'organisme', { max: 150 });
    out.lieu = texte(val('lieu'), 'Le lieu', { max: 150 });
    out.description = texte(val('description'), 'Le programme', { max: 3000 });
    const fournisseurId = idRef(val('fournisseurId'), 'Le prestataire');
    if (fournisseurId != null && !db.get('fournisseurs', fournisseurId)) throw new HttpError(400, 'Prestataire (fournisseur) introuvable');
    out.fournisseurId = fournisseurId;
    const factureId = idRef(val('factureId'), 'La facture');
    if (factureId != null && !db.get('factures', factureId)) throw new HttpError(400, 'Facture introuvable (module Achats & factures)');
    out.factureId = factureId;
    out.dateDebut = dateISO(val('dateDebut'), 'Date de début', { requis: true });
    out.dateFin = dateISO(val('dateFin'), 'Date de fin') || out.dateDebut;
    if (out.dateFin < out.dateDebut) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début');
    if (joursEntre(out.dateDebut, out.dateFin) > 366) throw new HttpError(400, 'Une session de formation ne peut pas dépasser un an');
    out.dureeHeures = nombre(val('dureeHeures'), 'La durée', { min: 0, max: 2000 });
    out.cout = nombre(val('cout'), 'Le coût', { min: 0, max: 1e7 });
    const hab = val('habilitationTypeCode');
    out.habilitationTypeCode = hab == null || hab === '' ? null : codeListeObligatoire('typesHabilitation', hab, 'Habilitation visée');
    out.statut = codeRh('statutsFormation', val('statut'), 'Statut', 'planifiee');

    // Participants : chaque nouveau participant doit être modifiable par l'utilisateur
    const brut = val('personnelIds');
    if (brut != null && !Array.isArray(brut)) throw new HttpError(400, 'Participants : liste attendue');
    const ids = Array.from(new Set((brut || []).map((x) => idRef(x, 'Participant'))));
    if (ids.length > MAX_PARTICIPANTS) throw new HttpError(400, `${MAX_PARTICIPANTS} participants au maximum`);
    const anciens = new Set(((existant && existant.personnelIds) || []).map(Number));
    for (const id of ids) {
      if (!db.get(PERS, id)) throw new HttpError(400, `Participant introuvable (#${id})`);
      if (!anciens.has(id)) ctx.getVisible(req, PERS, id);
    }
    out.personnelIds = ids;
    if (existant && existant.presents) out.presents = existant.presents.map(Number).filter((x) => ids.includes(x));

    // Site / service organisateur : saisi, sinon celui du premier participant
    let secteurId = idRef(val('secteurId'), 'Le site / service organisateur');
    if (secteurId == null && ids.length) secteurId = db.get(PERS, ids[0]).secteurId;
    if (secteurId == null) throw new HttpError(400, 'Le site / service organisateur est obligatoire (ou ajoutez au moins un participant)');
    out.secteurId = existant && Number(existant.secteurId) === Number(secteurId) ? Number(secteurId) : verifierSecteur(req, Number(secteurId), 'Le site / service organisateur');
    return out;
  }

  /** Crée ou renouvelle l'habilitation d'une personne suite à une formation réalisée. */
  function renouvelerHabilitation(req, personne, typeCode, { dateObtention, organisme, formation }) {
    const type = typeHabilitation(typeCode);
    const existantes = db.list(HAB, (h) => Number(h.personnelId) === personne.id && h.typeCode === typeCode);
    const courante = existantes.sort((a, b) => rangExpiration(b).localeCompare(rangExpiration(a)))[0];
    const dateExpiration = expirationParDefaut(typeCode, dateObtention);
    if (courante) {
      if (courante.dateObtention && courante.dateObtention >= dateObtention) return { habilitation: courante, action: 'inchangee' };
      const historique = (courante.historique || []).concat([{ dateObtention: courante.dateObtention, dateExpiration: courante.dateExpiration || null, organisme: courante.organisme || '', numero: courante.numero || '', formationId: courante.formationId || null, remplaceeLe: new Date().toISOString() }]).slice(-50);
      const h = db.update(HAB, courante.id, { dateObtention, dateExpiration, expirationCalculee: !!dateExpiration, organisme: organisme || courante.organisme || '', numero: '', formationId: formation.id, historique, alertes: {}, secteurId: personne.secteurId });
      ctx.audit(req, 'renouvellement', HAB, h.id, `${h.intitule} — ${nomPersonne(personne)} renouvelée par la formation « ${formation.intitule} » (${courante.dateExpiration || 'sans échéance'} → ${dateExpiration || 'sans échéance'})`);
      return { habilitation: h, action: 'renouvelee' };
    }
    const h = db.insert(HAB, {
      personnelId: personne.id, secteurId: personne.secteurId, typeCode, intitule: type ? type.label : typeCode, organisme: organisme || '', numero: '', commentaire: `Obtenue lors de la formation « ${formation.intitule} »`,
      dateObtention, dateExpiration, expirationCalculee: !!dateExpiration, documents: [], historique: [], alertes: {}, formationId: formation.id, createdBy: req && req.user ? req.user.id : null,
    });
    ctx.audit(req, 'creation', HAB, h.id, `${h.intitule} — ${nomPersonne(personne)} obtenue par la formation « ${formation.intitule} »`);
    return { habilitation: h, action: 'creee' };
  }

  function realiserFormation(req, f, options = {}) {
    const ref = aujourdhui();
    const dateFin = options.dateFin || f.dateFin || f.dateDebut || ref;
    if (dateFin > ref) throw new HttpError(400, 'Une formation ne peut être déclarée réalisée qu\'à partir de sa date de fin');
    if (dateFin < f.dateDebut) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début');
    const participants = (f.personnelIds || []).map(Number);
    let presents = participants;
    if (options.presents !== undefined) {
      if (!Array.isArray(options.presents)) throw new HttpError(400, 'Présents : liste attendue');
      presents = Array.from(new Set(options.presents.map((x) => idRef(x, 'Présent'))));
      const horsListe = presents.filter((x) => !participants.includes(x));
      if (horsListe.length) throw new HttpError(400, 'Un présent ne figure pas parmi les participants inscrits');
    }
    const generees = [];
    if (f.habilitationTypeCode) {
      for (const pid of presents) {
        const p = db.get(PERS, pid);
        if (!p) continue;
        const r = renouvelerHabilitation(req, p, f.habilitationTypeCode, { dateObtention: dateFin, organisme: f.organisme, formation: f });
        generees.push({ personnelId: pid, habilitationId: r.habilitation.id, action: r.action, dateExpiration: r.habilitation.dateExpiration || null });
      }
    }
    const maj = db.update(FOR, f.id, { statut: 'realisee', dateFin, presents, habilitationsGenerees: generees, dateRealisation: new Date().toISOString(), realiseePar: req && req.user ? req.user.id : null });
    const nbHab = generees.filter((g) => g.action !== 'inchangee').length;
    ctx.audit(req, 'statut', FOR, f.id, `Formation « ${f.intitule} » réalisée (${presents.length}/${participants.length} présent(s)${f.habilitationTypeCode ? `, ${nbHab} habilitation(s) créée(s) ou renouvelée(s)` : ''})`);
    // Information des participants
    const type = f.habilitationTypeCode ? typeHabilitation(f.habilitationTypeCode) : null;
    for (const g of generees.filter((x) => x.action !== 'inchangee')) {
      const p = db.get(PERS, g.personnelId);
      if (p && p.userId != null) notifier([p.userId], { titre: `Habilitation ${g.action === 'creee' ? 'obtenue' : 'renouvelée'}`, message: `${type ? type.label : f.habilitationTypeCode} : valable ${g.dateExpiration ? 'jusqu\'au ' + g.dateExpiration.split('-').reverse().join('/') : 'sans limite'} (formation « ${f.intitule} »)`, type: 'succes' }, `#/rh/${p.id}?onglet=habilitations`, req && req.user ? req.user.id : null);
    }
    ctx.emit('rh:formationRealisee', { formation: maj, habilitations: generees });
    return maj;
  }

  router.get('/api/rh/formations', async (req) => {
    const persMap = mapPersonnel();
    return filtrerFormations(req, req.query).map((f) => enrichirFormation(req, f, persMap));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/rh/formations/:id', async (req) => enrichirFormation(req, ctx.getVisible(req, FOR, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/rh/formations', async (req) => {
    const data = validerFormation(req, req.body, null);
    const realiser = data.statut === 'realisee';
    if (realiser && data.dateFin > aujourdhui()) throw new HttpError(400, 'Une formation ne peut être déclarée réalisée qu\'à partir de sa date de fin');
    if (realiser) data.statut = 'planifiee';
    data.createdBy = req.user.id; data.presents = null; data.habilitationsGenerees = [];
    let f = db.insert(FOR, data);
    ctx.audit(req, 'creation', FOR, f.id, `Formation « ${f.intitule} » du ${f.dateDebut} (${f.personnelIds.length} participant(s))`);
    if (realiser) f = realiserFormation(req, f, { presents: (objet(req.body)).presents });
    else {
      // Les participants disposant d'un compte sont informés de leur inscription
      const users = f.personnelIds.map((id) => (db.get(PERS, id) || {}).userId).filter((x) => x != null);
      if (users.length && f.statut === 'planifiee') notifier(users, { titre: 'Inscription à une formation', message: `« ${f.intitule} » du ${f.dateDebut.split('-').reverse().join('/')}${f.organisme ? ' — ' + f.organisme : ''}`, type: 'info' }, '#/rh?onglet=formations', req.user.id);
    }
    return enrichirFormation(req, f);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/rh/formations/:id', async (req) => {
    const existant = ctx.getVisible(req, FOR, req.params.id);
    const data = validerFormation(req, req.body, existant);
    if (existant.statut === 'realisee' && data.statut !== 'realisee') throw new HttpError(400, 'Une formation réalisée ne peut plus être replanifiée ni annulée');
    if (existant.statut === 'annulee' && data.statut === 'realisee') throw new HttpError(400, 'Une formation annulée ne peut pas être déclarée réalisée : replanifiez-la d\'abord');
    const realiser = existant.statut !== 'realisee' && data.statut === 'realisee';
    if (realiser && data.dateFin > aujourdhui()) throw new HttpError(400, 'Une formation ne peut être déclarée réalisée qu\'à partir de sa date de fin');
    if (realiser) data.statut = existant.statut;
    let f = db.update(FOR, existant.id, data);
    ctx.audit(req, existant.statut !== data.statut ? 'statut' : 'modification', FOR, f.id, `Formation « ${f.intitule} »${existant.statut !== f.statut ? ` : ${libelle('statutsFormation', existant.statut)} → ${libelle('statutsFormation', f.statut)}` : ''}`);
    if (realiser) f = realiserFormation(req, f, { presents: (objet(req.body)).presents });
    return enrichirFormation(req, f);
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/rh/formations/:id/realiser', async (req) => {
    const f = ctx.getVisible(req, FOR, req.params.id);
    if (f.statut !== 'planifiee') throw new HttpError(400, `Cette formation est déjà ${libelle('statutsFormation', f.statut).toLowerCase()}`);
    const b = objet(req.body);
    const dateFin = dateISO(b.dateFin, 'Date de fin');
    const maj = realiserFormation(req, f, { dateFin, presents: b.presents });
    return enrichirFormation(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/rh/formations/:id', async (req) => {
    const existant = ctx.getVisible(req, FOR, req.params.id);
    if (existant.statut === 'realisee' && (existant.habilitationsGenerees || []).some((g) => g.action !== 'inchangee')) throw new HttpError(400, 'Cette formation a généré des habilitations : elle est conservée pour la traçabilité');
    db.remove(FOR, existant.id);
    ctx.audit(req, 'suppression', FOR, existant.id, `Formation « ${existant.intitule} » du ${existant.dateDebut}`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  // ----- Visites médicales (dates et aptitude uniquement) ---------------------------------------------
  function validerVisite(req, body, existant) {
    const b = objet(body);
    const val = (cle) => (b[cle] === undefined ? (existant ? existant[cle] : undefined) : b[cle]);
    const out = {};
    let personne;
    if (existant) personne = db.get(PERS, existant.personnelId);
    else {
      const pid = idRef(b.personnelId, 'La personne');
      if (!pid) throw new HttpError(400, 'La personne est obligatoire');
      if (!db.get(PERS, pid)) throw new HttpError(400, 'Personne introuvable');
      personne = ctx.getVisible(req, PERS, pid);
    }
    out.personnelId = personne ? personne.id : existant.personnelId;
    out.secteurId = personne ? personne.secteurId : existant.secteurId;
    out.type = codeRh('typesVisiteMedicale', val('type'), 'Type de visite', 'periodique');
    out.date = dateISO(val('date'), 'Date de la visite', { requis: true });
    if (out.date > ajouterJours(aujourdhui(), 366)) throw new HttpError(400, 'La date de la visite est trop éloignée');
    out.aptitude = codeRh('aptitudesMedicales', val('aptitude'), 'Aptitude', 'en_attente');
    out.restrictions = texte(val('restrictions'), 'Les restrictions (aménagement de poste, sans donnée médicale)', { max: 200 });
    out.prochaineVisite = dateISO(val('prochaineVisite'), 'Prochaine visite');
    if (out.prochaineVisite && out.prochaineVisite < out.date) throw new HttpError(400, 'La prochaine visite ne peut pas précéder la visite');
    out.alertes = existant && existant.prochaineVisite === out.prochaineVisite ? (existant.alertes || {}) : {};
    return out;
  }
  router.get('/api/rh/visites', async (req) => {
    const idx = index(); const persMap = mapPersonnel();
    return filtrerVisites(req, req.query, idx).map((v) => enrichirVisite(req, v, idx, persMap));
  }, { perm: [MODULE, 'voir'] });
  router.get('/api/rh/visites/:id', async (req) => enrichirVisite(req, ctx.getVisible(req, VIS, req.params.id), index()), { perm: [MODULE, 'voir'] });
  router.post('/api/rh/visites', async (req) => {
    const data = validerVisite(req, req.body, null);
    data.createdBy = req.user.id;
    const v = db.insert(VIS, data);
    const p = db.get(PERS, v.personnelId);
    ctx.audit(req, 'creation', VIS, v.id, `Visite médicale (${libelle('typesVisiteMedicale', v.type)}) du ${v.date} — ${nomPersonne(p)}`);
    return enrichirVisite(req, v, index());
  }, { perm: [MODULE, 'creer'] });
  router.put('/api/rh/visites/:id', async (req) => {
    const existant = ctx.getVisible(req, VIS, req.params.id);
    const v = db.update(VIS, existant.id, validerVisite(req, req.body, existant));
    const p = db.get(PERS, v.personnelId);
    ctx.audit(req, 'modification', VIS, v.id, `Visite médicale du ${v.date} — ${nomPersonne(p)}${existant.aptitude !== v.aptitude ? ` (aptitude : ${libelle('aptitudesMedicales', existant.aptitude)} → ${libelle('aptitudesMedicales', v.aptitude)})` : ''}`);
    return enrichirVisite(req, v, index());
  }, { perm: [MODULE, 'modifier'] });
  router.delete('/api/rh/visites/:id', async (req) => {
    const existant = ctx.getVisible(req, VIS, req.params.id);
    db.remove(VIS, existant.id);
    ctx.audit(req, 'suppression', VIS, existant.id, `Visite médicale du ${existant.date} — ${nomPersonne(db.get(PERS, existant.personnelId))}`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  // ----- Absences -----------------------------------------------------------------------------------
  function validerAbsence(body, existant, personne) {
    const b = objet(body);
    const val = (cle) => (b[cle] === undefined ? (existant ? existant[cle] : undefined) : b[cle]);
    const out = { personnelId: personne.id, secteurId: personne.secteurId };
    const type = val('typeCode');
    if (type == null || type === '') throw new HttpError(400, 'Le type d\'absence est obligatoire');
    out.typeCode = codeListeObligatoire('typesAbsence', type, 'Type d\'absence');
    out.dateDebut = dateISO(val('dateDebut'), 'Date de début', { requis: true });
    out.dateFin = dateISO(val('dateFin'), 'Date de fin') || out.dateDebut;
    if (out.dateFin < out.dateDebut) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début');
    if (joursEntre(out.dateDebut, out.dateFin) > 366) throw new HttpError(400, 'Une absence ne peut pas dépasser un an : scindez-la');
    let dj = val('demiJournee');
    if (dj === true) dj = 'matin';
    if (dj === false || dj === '' || dj == null) dj = null;
    if (dj != null && !DEMI_JOURNEES[dj]) throw new HttpError(400, 'Demi-journée invalide (matin ou après-midi)');
    if (dj && out.dateFin !== out.dateDebut) throw new HttpError(400, 'Une demi-journée ne concerne qu\'un seul jour');
    out.demiJournee = dj;
    out.commentaire = texte(val('commentaire'), 'Le commentaire', { max: 500 });
    return out;
  }
  /** Refuse un chevauchement avec une autre absence demandée ou validée de la même personne. */
  function verifierChevauchement(data, idExclu) {
    const autre = db.findOne(ABS, (a) => Number(a.personnelId) === data.personnelId && a.id !== idExclu && (a.statut === 'demandee' || a.statut === 'validee')
      && a.dateDebut <= data.dateFin && a.dateFin >= data.dateDebut
      && !(a.demiJournee && data.demiJournee && a.demiJournee !== data.demiJournee && a.dateDebut === data.dateDebut));
    if (autre) throw new HttpError(400, `Chevauchement avec une autre absence (${libelle('statutsAbsence', autre.statut).toLowerCase()}) du ${autre.dateDebut.split('-').reverse().join('/')} au ${autre.dateFin.split('-').reverse().join('/')}`);
  }
  const periode = (a) => (a.dateDebut === a.dateFin ? `le ${a.dateDebut.split('-').reverse().join('/')}${a.demiJournee ? ' (' + DEMI_JOURNEES[a.demiJournee].toLowerCase() + ')' : ''}` : `du ${a.dateDebut.split('-').reverse().join('/')} au ${a.dateFin.split('-').reverse().join('/')}`);

  function informerValideurs(req, a, p) {
    const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
    return notifier(valideurs(p), { titre: `Demande d'absence : ${nomPersonne(p)}`, message: `${type ? type.label : a.typeCode} ${periode(a)} (${dureeAbsence(a)} j ouvré(s))${a.commentaire ? ' — ' + a.commentaire : ''}`, type: 'alerte' }, '#/rh?onglet=absences', req.user.id);
  }
  function creerAbsence(req, p, body, { statut }) {
    const data = validerAbsence(body, null, p);
    verifierChevauchement(data, null);
    Object.assign(data, { statut, demandeurUserId: req.user.id, valideurUserId: null, dateValidation: null, motifDecision: '', createdBy: req.user.id });
    if (statut === 'validee') Object.assign(data, { valideurUserId: req.user.id, dateValidation: new Date().toISOString() });
    const a = db.insert(ABS, data);
    ctx.audit(req, 'creation', ABS, a.id, `Absence (${a.typeCode}) ${periode(a)} — ${nomPersonne(p)} : ${libelle('statutsAbsence', a.statut)}`);
    if (statut === 'demandee') { informerValideurs(req, a, p); ctx.emit('rh:absenceDemandee', { absence: a, personnel: p }); }
    else {
      if (p.userId != null) notifier([p.userId], { titre: 'Absence enregistrée', message: `${libelle('typesAbsence', a.typeCode)} ${periode(a)} — saisie par ${ctx.nomUser(req.user.id)}`, type: 'info' }, `#/rh/${p.id}?onglet=absences`, req.user.id);
      ctx.emit('rh:absenceValidee', { absence: a, personnel: p, userId: p.userId != null ? Number(p.userId) : null, valideurUserId: req.user.id });
    }
    return a;
  }
  function decider(req, id, decision) {
    const b = objet(req.body);
    const a = db.get(ABS, idRef(id, 'Absence') || 0);
    if (!a) throw new HttpError(404, 'Demande d\'absence introuvable');
    const p = db.get(PERS, a.personnelId);
    const uid = req.user.id;
    const estAdmin = !!req.perms.estAdmin;
    const estManager = !!p && managerDe(p) === uid;
    if (!estManager) {
      if (!can(req, MODULE, 'valider')) throw new HttpError(403, 'Seul le responsable hiérarchique (N+1) de la personne ou un valideur RH peut décider de cette demande');
      ctx.getVisible(req, ABS, a.id); // portée et site en lecture seule
      const wf = ctx.config().workflow || {};
      if (wf.validerParSuperieurUniquement && !estAdmin && p && managerDe(p) != null) throw new HttpError(403, 'Seul le responsable hiérarchique (N+1) de la personne peut décider de cette demande');
    }
    if (p && p.userId != null && Number(p.userId) === uid && !estAdmin) throw new HttpError(403, 'Vous ne pouvez pas décider de votre propre demande d\'absence');
    if (a.statut !== 'demandee') throw new HttpError(400, `Cette demande a déjà été traitée (${libelle('statutsAbsence', a.statut).toLowerCase()})`);
    const motif = texte(b.motif !== undefined ? b.motif : b.commentaire, 'Le motif', { max: 500 });
    if (decision === 'refusee' && !motif) throw new HttpError(400, 'Le motif du refus est obligatoire');
    if (decision === 'validee') verifierChevauchement(a, a.id);
    const maj = db.update(ABS, a.id, { statut: decision, valideurUserId: uid, dateValidation: new Date().toISOString(), motifDecision: motif });
    const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
    const lib = type ? type.label : a.typeCode;
    ctx.audit(req, decision === 'validee' ? 'validation' : 'refus', ABS, a.id, `Absence ${lib} ${periode(a)} — ${nomPersonne(p)}${motif ? ' : ' + motif : ''}`);
    const cibles = [p && p.userId, a.demandeurUserId];
    notifier(cibles, {
      titre: decision === 'validee' ? 'Absence validée' : 'Absence refusée',
      message: `${lib} ${periode(a)}${p && a.demandeurUserId !== p.userId ? ' (' + nomPersonne(p) + ')' : ''} — ${decision === 'validee' ? 'validée' : 'refusée'} par ${ctx.nomUser(uid)}${motif ? ' : ' + motif : ''}`,
      type: decision === 'validee' ? 'succes' : 'alerte',
    }, p ? `#/rh/${p.id}?onglet=absences` : '#/rh?onglet=absences', uid);
    ctx.emit(decision === 'validee' ? 'rh:absenceValidee' : 'rh:absenceRefusee', { absence: maj, personnel: p, userId: p && p.userId != null ? Number(p.userId) : null, valideurUserId: uid });
    return maj;
  }
  function annulerAbsence(req, a, p, parRh) {
    if (a.statut === 'annulee' || a.statut === 'refusee') throw new HttpError(400, `Cette absence est déjà ${libelle('statutsAbsence', a.statut).toLowerCase()}`);
    if (!parRh && a.statut === 'validee' && a.dateDebut <= aujourdhui()) throw new HttpError(400, 'Une absence validée déjà commencée ne peut être annulée que par le service RH');
    const ancien = a.statut;
    const maj = db.update(ABS, a.id, { statut: 'annulee', annuleePar: req.user.id, dateAnnulation: new Date().toISOString() });
    ctx.audit(req, 'statut', ABS, a.id, `Absence ${periode(a)} — ${nomPersonne(p)} : ${libelle('statutsAbsence', ancien)} → ${libelle('statutsAbsence', 'annulee')}`);
    const cibles = ancien === 'validee' ? [a.valideurUserId, managerDe(p)] : valideurs(p);
    if (p && p.userId != null) cibles.push(p.userId);
    notifier(cibles, { titre: `Absence annulée : ${nomPersonne(p)}`, message: `${libelle('typesAbsence', a.typeCode) || a.typeCode} ${periode(a)} — annulée par ${ctx.nomUser(req.user.id)}`, type: 'info' }, p ? `#/rh/${p.id}?onglet=absences` : '#/rh?onglet=absences', req.user.id);
    ctx.emit('rh:absenceAnnulee', { absence: maj, personnel: p, ancienStatut: ancien });
    return maj;
  }

  router.get('/api/rh/absences', async (req) => {
    const idx = index(); const persMap = mapPersonnel();
    return filtrerAbsences(req, req.query).map((a) => enrichirAbsence(req, a, idx, persMap));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/rh/absences/:id', async (req) => enrichirAbsence(req, ctx.getVisible(req, ABS, req.params.id), index()), { perm: [MODULE, 'voir'] });

  router.post('/api/rh/absences', async (req) => {
    const b = objet(req.body);
    const pid = idRef(b.personnelId, 'La personne');
    if (!pid) throw new HttpError(400, 'La personne est obligatoire');
    if (!db.get(PERS, pid)) throw new HttpError(400, 'Personne introuvable');
    const p = ctx.getVisible(req, PERS, pid);
    const statut = codeRh('statutsAbsence', b.statut, 'Statut', 'demandee');
    if (!['demandee', 'validee'].includes(statut)) throw new HttpError(400, 'Une absence est créée « demandée » ou « validée »');
    if (statut === 'validee') {
      if (!can(req, MODULE, 'valider') && managerDe(p) !== req.user.id) throw new HttpError(403, 'Droit insuffisant : Ressources humaines › Valider');
      if (p.userId != null && Number(p.userId) === req.user.id && !req.perms.estAdmin) throw new HttpError(403, 'Vous ne pouvez pas valider votre propre absence');
    }
    const a = creerAbsence(req, p, b, { statut });
    return enrichirAbsence(req, a, index());
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/rh/absences/:id', async (req) => {
    const existant = ctx.getVisible(req, ABS, req.params.id);
    if (existant.statut === 'annulee' || existant.statut === 'refusee') throw new HttpError(400, 'Une absence annulée ou refusée ne peut plus être modifiée');
    const p = db.get(PERS, existant.personnelId);
    const data = validerAbsence(req.body, existant, p);
    verifierChevauchement(data, existant.id);
    const a = db.update(ABS, existant.id, data);
    ctx.audit(req, 'modification', ABS, a.id, `Absence ${periode(a)} — ${nomPersonne(p)}${existant.dateDebut !== a.dateDebut || existant.dateFin !== a.dateFin ? ` (était ${periode(existant)})` : ''}`);
    return enrichirAbsence(req, a, index());
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/rh/absences/:id', async (req) => {
    const existant = ctx.getVisible(req, ABS, req.params.id);
    db.remove(ABS, existant.id);
    ctx.audit(req, 'suppression', ABS, existant.id, `Absence ${periode(existant)} — ${nomPersonne(db.get(PERS, existant.personnelId))}`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  // Décision : droit rh › valider (dans sa portée) OU responsable hiérarchique (N+1) de la personne
  router.post('/api/rh/absences/:id/valider', async (req) => enrichirAbsence(req, decider(req, req.params.id, 'validee'), index()));
  router.post('/api/rh/absences/:id/refuser', async (req) => enrichirAbsence(req, decider(req, req.params.id, 'refusee'), index()));
  router.post('/api/rh/absences/:id/annuler', async (req) => {
    const a = db.get(ABS, idRef(req.params.id, 'Absence') || 0);
    if (!a) throw new HttpError(404, 'Absence introuvable');
    const p = db.get(PERS, a.personnelId);
    const soi = p && p.userId != null && Number(p.userId) === req.user.id;
    const demandeur = Number(a.demandeurUserId) === req.user.id;
    let parRh = false;
    if (can(req, MODULE, 'modifier') && ctx.canSee(req, a)) { ctx.getVisible(req, ABS, a.id); parRh = true; } else if (!soi && !demandeur) throw new HttpError(403, 'Seul le service RH ou la personne concernée peut annuler cette absence');
    return enrichirAbsence(req, annulerAbsence(req, a, p, parRh), index());
  });

  /** Calendrier des absences (planning) : absences validées sur une période. */
  router.get('/api/rh/calendrier', async (req) => {
    const voirRh = can(req, MODULE, 'voir');
    if (!voirRh && !can(req, 'planning', 'voir')) throw new HttpError(403, 'Droit insuffisant : Ressources humaines › Voir ou Planning › Voir');
    if (!voirRh && !cfgRh().afficherAbsencesPlanning) return [];
    const ref = aujourdhui();
    const du = dateISO(req.query.du, 'Date de début') || `${ref.slice(0, 7)}-01`;
    const au = dateISO(req.query.au, 'Date de fin') || ajouterJours(ajouterMois(`${du.slice(0, 7)}-01`, 1), -1);
    if (au < du) throw new HttpError(400, 'La date de fin ne peut pas précéder la date de début');
    if (joursEntre(du, au) > 400) throw new HttpError(400, 'Période trop longue (400 jours maximum)');
    const statuts = voirRh && req.query.demandes === '1' ? ['validee', 'demandee'] : ['validee'];
    let rows = ctx.scope(req, db.list(ABS, (a) => statuts.includes(a.statut) && a.dateDebut <= au && a.dateFin >= du));
    const secteurId = idRef(req.query.secteurId, 'Service');
    if (secteurId) { const ids = idsSecteurs(secteurId); rows = rows.filter((a) => ids.has(Number(a.secteurId))); }
    const persMap = mapPersonnel();
    const userId = idRef(req.query.userId, 'Utilisateur');
    if (userId) rows = rows.filter((a) => Number((persMap.get(Number(a.personnelId)) || {}).userId) === userId);
    return rows.sort((a, b) => a.dateDebut.localeCompare(b.dateDebut)).map((a) => {
      const p = persMap.get(Number(a.personnelId));
      const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
      const absent = typeRendAbsent(a.typeCode);
      // Sans droit RH, la nature de l'absence (ex. arrêt maladie) n'est pas communiquée
      const masquer = !voirRh && absent;
      return {
        id: a.id, personnelId: a.personnelId, userId: p && p.userId != null ? Number(p.userId) : null, nom: nomPersonne(p), secteurId: a.secteurId,
        dateDebut: a.dateDebut, dateFin: a.dateFin, demiJournee: a.demiJournee || null, statut: a.statut, absent,
        typeCode: masquer ? null : a.typeCode, libelle: masquer ? 'Absent' : (type ? type.label : a.typeCode), couleur: masquer ? '#6b7280' : ((type && type.couleur) || '#6b7280'),
        nbJours: dureeAbsence(a, du, au),
      };
    });
  });

  // ----- Mon dossier RH (tout utilisateur authentifié) -------------------------------------------------
  function monDossier(req) {
    const idx = index();
    const p = personnelDeUser(req.user.id);
    const aValider = db.list(ABS, (a) => a.statut === 'demandee').filter((a) => { const pp = db.get(PERS, a.personnelId); return pp && managerDe(pp, idx.users) === req.user.id && Number(pp.userId) !== req.user.id; })
      .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut)).map((a) => enrichirAbsence(req, a, idx));
    const base = { aValider, typesAbsence: ctx.liste('typesAbsence').map((t) => ({ code: t.code, label: t.label, couleur: t.couleur || '#6b7280' })), date: idx.ref, joursAlerte: idx.jours };
    if (!p) return Object.assign(base, { personnel: null });
    const persMap = new Map([[p.id, p]]);
    const r = resumePersonnel(req, p, idx);
    delete r.coutHoraire; delete r.notes; delete r.modifiable;
    return Object.assign(base, {
      personnel: r,
      habilitations: (idx.habParPers.get(p.id) || []).map((h) => { const e = enrichirHabilitation(req, h, idx, persMap); delete e.modifiable; e.documents = e.documents.map((d) => ({ nom: d.nom, taille: d.taille, date: d.date })); return e; })
        .filter((h) => h.etat !== 'remplacee').sort((a, b) => String(a.dateExpiration || '9999').localeCompare(String(b.dateExpiration || '9999'))),
      formations: db.list(FOR, (f) => (f.personnelIds || []).map(Number).includes(p.id) && f.statut !== 'annulee').sort((a, b) => String(b.dateDebut).localeCompare(String(a.dateDebut)))
        .map((f) => ({ id: f.id, intitule: f.intitule, organisme: f.organisme, lieu: f.lieu || '', dateDebut: f.dateDebut, dateFin: f.dateFin, dureeHeures: f.dureeHeures, statut: f.statut, statutLibelle: libelle('statutsFormation', f.statut), habilitationTypeCode: f.habilitationTypeCode || null })),
      visites: (idx.visites.get(p.id) || []).map((v) => { const e = enrichirVisite(req, v, idx, persMap); return { id: e.id, type: e.type, typeLibelle: e.typeLibelle, date: e.date, aptitude: e.aptitude, aptitudeLibelle: e.aptitudeLibelle, restrictions: e.restrictions, prochaineVisite: e.prochaineVisite, etat: e.etat }; }),
      absences: db.list(ABS, (a) => Number(a.personnelId) === p.id).sort((a, b) => String(b.dateDebut).localeCompare(String(a.dateDebut))).map((a) => {
        const e = enrichirAbsence(req, a, idx, persMap);
        e.annulable = (a.statut === 'demandee') || (a.statut === 'validee' && a.dateDebut > idx.ref);
        delete e.modifiable; delete e.peutDecider;
        return e;
      }),
    });
  }
  router.get('/api/rh/moi', async (req) => monDossier(req));

  router.post('/api/rh/moi/absences', async (req) => {
    const p = personnelDeUser(req.user.id);
    if (!p) throw new HttpError(400, 'Aucune fiche du personnel n\'est associée à votre compte : contactez le service RH');
    if (p.actif === false) throw new HttpError(400, 'Votre fiche du personnel est désactivée : contactez le service RH');
    const b = Object.assign({}, objet(req.body));
    if (b.dateDebut && b.dateDebut < ajouterJours(aujourdhui(), -31)) throw new HttpError(400, 'Une demande ne peut pas porter sur une période passée de plus d\'un mois : contactez le service RH');
    const a = creerAbsence(req, p, b, { statut: 'demandee' });
    return enrichirAbsence(req, a, index());
  });

  router.post('/api/rh/moi/absences/:id/annuler', async (req) => {
    const p = personnelDeUser(req.user.id);
    const a = db.get(ABS, idRef(req.params.id, 'Absence') || 0);
    if (!a || !p || Number(a.personnelId) !== p.id) throw new HttpError(404, 'Absence introuvable');
    return enrichirAbsence(req, annulerAbsence(req, a, p, false), index());
  });

  // ----- Alertes et tableau de bord -----------------------------------------------------------------------
  function calculerAlertes(req) {
    const idx = index();
    const visibles = new Map(ctx.scope(req, db.list(PERS)).filter((p) => p.actif !== false).map((p) => [p.id, p]));
    const prevus = renouvellementsPrevus();
    const infoPers = (p) => { const siteId = perms.siteDuSecteur(db, p.secteurId, idx.secteurs); return { personnelId: p.id, personnelNom: nomPersonne(p), matricule: p.matricule, fonction: p.fonction || '', secteurId: p.secteurId, secteurNom: (idx.secteurs.get(Number(p.secteurId)) || {}).nom || '', siteId, siteNom: siteId != null ? (idx.secteurs.get(siteId) || {}).nom || '' : '' }; };
    const habilitations = [];
    for (const [pid, liste] of idx.habParPers) {
      const p = visibles.get(pid);
      if (!p) continue;
      for (const h of liste) {
        if (idx.courantes.get(cleHab(h)) !== h.id) continue;
        const etat = etatEcheance(h.dateExpiration, idx.ref, idx.jours);
        if (etat === 'valide') continue;
        const type = typeHabilitation(h.typeCode);
        habilitations.push(Object.assign(infoPers(p), { categorie: 'habilitation', id: h.id, typeCode: h.typeCode, libelle: type ? type.label : h.typeCode, couleur: (type && type.couleur) || '#6b7280', intitule: h.intitule, dateEcheance: h.dateExpiration, joursRestants: joursEntre(idx.ref, h.dateExpiration), etat, renouvellementPrevu: prevus.get(cleHab(h)) || null }));
      }
    }
    const visites = [];
    for (const [pid, liste] of idx.visites) {
      const p = visibles.get(pid);
      if (!p) continue;
      const v = visiteReference(liste, idx.ref);
      const etat = etatVisite(v, idx);
      if (etat !== 'expiree' && etat !== 'bientot') continue;
      visites.push(Object.assign(infoPers(p), { categorie: 'visite', id: v.id, type: v.type, libelle: libelle('typesVisiteMedicale', v.type), dateDerniere: v.date, dateEcheance: v.prochaineVisite, joursRestants: joursEntre(idx.ref, v.prochaineVisite), etat }));
    }
    const contrats = [];
    for (const p of visibles.values()) {
      if (!p.dateSortie) continue;
      const etat = etatEcheance(p.dateSortie, idx.ref, idx.jours);
      if (etat === 'valide') continue;
      contrats.push(Object.assign(infoPers(p), { categorie: 'contrat', id: p.id, typeContratCode: p.typeContratCode, libelle: (ctx.liste('typesContrat').find((t) => t.code === p.typeContratCode) || {}).label || p.typeContratCode || '', dateEcheance: p.dateSortie, joursRestants: joursEntre(idx.ref, p.dateSortie), etat }));
    }
    const tri = (a, b) => String(a.dateEcheance).localeCompare(String(b.dateEcheance));
    habilitations.sort(tri); visites.sort(tri); contrats.sort(tri);
    const parSite = new Map();
    for (const x of habilitations.concat(visites, contrats)) {
      const k = x.siteId == null ? 0 : x.siteId;
      if (!parSite.has(k)) parSite.set(k, { siteId: x.siteId, siteNom: x.siteNom || 'Sans site', habilitations: 0, visites: 0, contrats: 0, expirees: 0, total: 0 });
      const s = parSite.get(k);
      s[x.categorie === 'habilitation' ? 'habilitations' : x.categorie === 'visite' ? 'visites' : 'contrats']++;
      if (x.etat === 'expiree') s.expirees++;
      s.total++;
    }
    const tout = habilitations.concat(visites, contrats);
    return {
      date: idx.ref, joursAlerte: idx.jours, habilitations, visites, contrats,
      parSite: Array.from(parSite.values()).sort((a, b) => b.total - a.total),
      total: tout.length,
      compteurs: { expirees: tout.filter((x) => x.etat === 'expiree').length, bientot: tout.filter((x) => x.etat === 'bientot').length, habilitationsExpirees: habilitations.filter((x) => x.etat === 'expiree').length, habilitationsBientot: habilitations.filter((x) => x.etat === 'bientot').length },
    };
  }
  router.get('/api/rh/alertes', async (req) => calculerAlertes(req), { perm: [MODULE, 'voir'] });

  router.get('/api/rh/tableau', async (req) => {
    const idx = index();
    const ref = idx.ref;
    const q = req.query || {};
    const tous = filtrerPersonnel(req, { siteId: q.siteId, secteurId: q.secteurId }, idx);
    const actifs = tous.filter((p) => p.actif !== false);
    const ids = new Set(actifs.map((p) => p.id));
    // Effectifs
    const parSite = new Map(); const parService = new Map(); const parContrat = new Map();
    for (const p of actifs) {
      const siteId = perms.siteDuSecteur(db, p.secteurId, idx.secteurs);
      const s = siteId != null ? idx.secteurs.get(siteId) : null;
      const ks = siteId == null ? 0 : siteId;
      if (!parSite.has(ks)) parSite.set(ks, { id: siteId, nom: s ? s.nom : 'Sans site', couleur: s ? s.couleur || '#0f766e' : '#6b7280', n: 0 });
      parSite.get(ks).n++;
      const sv = idx.secteurs.get(Number(p.secteurId));
      if (!parService.has(p.secteurId)) parService.set(p.secteurId, { id: p.secteurId, nom: sv ? sv.nom : '—', chemin: cheminSecteur(p.secteurId, idx.secteurs), couleur: sv ? sv.couleur || '#2563eb' : '#6b7280', siteId, n: 0 });
      parService.get(p.secteurId).n++;
      parContrat.set(p.typeContratCode || '', (parContrat.get(p.typeContratCode || '') || 0) + 1);
    }
    const contrats = ctx.liste('typesContrat');
    // Absents du jour
    const absents = [];
    for (const p of actifs) {
      const a = idx.absJour.get(p.id);
      if (a) absents.push({ absenceId: a.id, personnelId: p.id, nom: nomPersonne(p), fonction: p.fonction || '', secteurId: p.secteurId, typeCode: a.typeCode, dateDebut: a.dateDebut, dateFin: a.dateFin, demiJournee: a.demiJournee || null });
    }
    // Absentéisme du mois (jours ouvrés)
    const mois = ref.slice(0, 7);
    const debutMois = `${mois}-01`; const finMois = ajouterJours(ajouterMois(debutMois, 1), -1);
    const ouvresMois = joursOuvres(debutMois, finMois);
    const typesAbs = typesAbsenteisme();
    const parType = new Map();
    let joursAbsence = 0; let joursAbsenteisme = 0;
    for (const a of db.list(ABS, (x) => x.statut === 'validee' && ids.has(Number(x.personnelId)) && x.dateDebut <= finMois && x.dateFin >= debutMois)) {
      if (!typeRendAbsent(a.typeCode)) continue;
      const j = dureeAbsence(a, debutMois, finMois);
      joursAbsence += j;
      if (typesAbs.has(a.typeCode)) joursAbsenteisme += j;
      parType.set(a.typeCode, (parType.get(a.typeCode) || 0) + j);
    }
    const theoriques = ouvresMois * actifs.length;
    // Formations de l'année
    const annee = ref.slice(0, 4);
    const formations = ctx.scope(req, db.list(FOR, (f) => String(f.dateDebut || '').startsWith(annee) && f.statut !== 'annulee'));
    const coutRealise = formations.filter((f) => f.statut === 'realisee').reduce((s, f) => s + (Number(f.cout) || 0), 0);
    const coutPlanifie = formations.filter((f) => f.statut === 'planifiee').reduce((s, f) => s + (Number(f.cout) || 0), 0);
    // Habilitations
    const hab = { total: 0, valides: 0, bientot: 0, expirees: 0 };
    for (const p of actifs) for (const h of idx.habParPers.get(p.id) || []) {
      if (idx.courantes.get(cleHab(h)) !== h.id) continue;
      const e = etatEcheance(h.dateExpiration, ref, idx.jours);
      hab.total++; if (e === 'expiree') hab.expirees++; else if (e === 'bientot') hab.bientot++; else hab.valides++;
    }
    const alertes = calculerAlertes(req);
    const users = idx.users;
    const aValider = ctx.scope(req, db.list(ABS, (a) => a.statut === 'demandee')).filter((a) => peutDecider(req, a, db.get(PERS, a.personnelId), users));
    const demandesEnAttente = ctx.scope(req, db.list(ABS, (a) => a.statut === 'demandee' && ids.has(Number(a.personnelId)))).length;
    return {
      date: ref, mois, annee,
      effectifs: {
        total: actifs.length, inactifs: tous.length - actifs.length,
        avecCompte: actifs.filter((p) => p.userId != null).length,
        parSite: Array.from(parSite.values()).sort((a, b) => b.n - a.n),
        parService: Array.from(parService.values()).sort((a, b) => b.n - a.n),
        parContrat: Array.from(parContrat.entries()).map(([code, n]) => { const c = contrats.find((x) => x.code === code); return { code, label: c ? c.label : (code || 'Non renseigné'), couleur: (c && c.couleur) || null, n }; }).sort((a, b) => b.n - a.n),
      },
      absentsAujourdhui: absents.sort((a, b) => a.nom.localeCompare(b.nom, 'fr')),
      absenteisme: {
        mois, joursOuvres: ouvresMois, effectif: actifs.length, joursTheoriques: theoriques,
        joursAbsence: arrondi(joursAbsence, 1), joursAbsenteisme: arrondi(joursAbsenteisme, 1),
        taux: theoriques ? arrondi((joursAbsenteisme / theoriques) * 100, 2) : 0,
        tauxGlobal: theoriques ? arrondi((joursAbsence / theoriques) * 100, 2) : 0,
        typesComptes: Array.from(typesAbs),
        parType: Array.from(parType.entries()).map(([code, jours]) => ({ code, jours: arrondi(jours, 1) })).sort((a, b) => b.jours - a.jours),
      },
      formations: {
        annee, nb: formations.length,
        nbRealisees: formations.filter((f) => f.statut === 'realisee').length,
        nbPlanifiees: formations.filter((f) => f.statut === 'planifiee').length,
        heures: arrondi(formations.filter((f) => f.statut === 'realisee').reduce((s, f) => s + (Number(f.dureeHeures) || 0) * ((f.presents || f.personnelIds || []).length || 1), 0), 1),
        cout: arrondi(coutRealise + coutPlanifie), coutRealise: arrondi(coutRealise), coutPlanifie: arrondi(coutPlanifie),
      },
      habilitations: hab,
      alertes: { total: alertes.total, habilitations: alertes.habilitations.length, visites: alertes.visites.length, contrats: alertes.contrats.length, expirees: alertes.compteurs.expirees, bientot: alertes.compteurs.bientot },
      demandesAValider: aValider.length,
      demandesEnAttente,
    };
  }, { perm: [MODULE, 'voir'] });

  /** Références utiles aux formulaires (prestataires, factures) sans exiger les droits des autres modules. */
  router.get('/api/rh/references', async (req) => {
    const fournisseurs = db.list('fournisseurs', (f) => f.actif !== false).map((f) => ({ id: f.id, nom: f.nom || '', typeCode: f.typeCode || '' })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    let factures = null;
    if (can(req, 'achats', 'voir')) {
      factures = ctx.scope(req, db.list('factures')).map((f) => {
        const four = f.fournisseurId != null ? db.get('fournisseurs', f.fournisseurId) : null;
        const montant = [f.totalTTC, f.montantTTC, f.totalHT, f.montantHT].find((x) => x != null && Number.isFinite(Number(x)));
        return { id: f.id, numero: f.numero || f.reference || `#${f.id}`, fournisseurNom: four ? four.nom : '', date: f.date || f.dateFacture || f.createdAt || null, montant: montant == null ? null : Number(montant) };
      }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 500);
    }
    return { fournisseurs, factures };
  }, { perm: [MODULE, 'voir'] });

  // ----- Exports CSV ----------------------------------------------------------------------------------------
  router.get('/api/rh/export/:quoi', async (req, res) => {
    const quoi = req.params.quoi;
    const idx = index(); const persMap = mapPersonnel();
    const lib = (l, c) => { const it = ctx.liste(l).find((x) => x.code === c); return it ? it.label : (c || ''); };
    const fr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
    const service = (id) => cheminSecteur(id, idx.secteurs);
    let entetes; let lignes;
    if (quoi === 'personnel') {
      const champs = ((ctx.config().champsPersonnalises || {})[PERS]) || [];
      const cout = can(req, MODULE, 'modifier');
      entetes = ['Matricule', 'Nom', 'Prénom', 'Fonction', 'Site / service', 'Type de contrat', 'Date d\'entrée', 'Date de sortie', 'Téléphone', 'E-mail', 'Responsable (N+1)', 'Compte GMAO', 'Contact d\'urgence', 'Téléphone d\'urgence'].concat(cout ? ['Coût horaire'] : [], ['Habilitations valides', 'À renouveler', 'Expirées', 'Compétences', 'Actif'], champs.map((c) => c.label));
      lignes = filtrerPersonnel(req, req.query, idx).map((p) => {
        const r = resumePersonnel(req, p, idx);
        return [r.matricule, r.nom, r.prenom, r.fonction, r.secteurChemin, lib('typesContrat', r.typeContratCode), fr(r.dateEntree), fr(r.dateSortie), r.telephone, r.email, r.managerNom, r.userLogin, (r.contactUrgence || {}).nom, (r.contactUrgence || {}).telephone]
          .concat(cout ? [nombreCsv(r.coutHoraire)] : [], [r.habilitationsResume.valides, r.habilitationsResume.bientot, r.habilitationsResume.expirees, (r.competences || []).map((c) => `${c.libelle} (${c.niveau}/4)`).join(', '), r.actif === false ? 'Non' : 'Oui'],
            champs.map((c) => { const v = (r.champs || {})[c.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); }));
      });
    } else if (quoi === 'habilitations') {
      entetes = ['Matricule', 'Nom', 'Site / service', 'Type', 'Intitulé', 'Organisme', 'Numéro', 'Date d\'obtention', 'Date d\'expiration', 'Jours restants', 'État'];
      lignes = filtrerHabilitations(req, req.query, idx).map((h) => { const e = enrichirHabilitation(req, h, idx, persMap); return [e.matricule, e.personnelNom, service(h.secteurId), e.typeLibelle, e.intitule, e.organisme, e.numero, fr(e.dateObtention), fr(e.dateExpiration), e.joursRestants == null ? '' : e.joursRestants, e.etatLibelle]; });
    } else if (quoi === 'formations') {
      entetes = ['Intitulé', 'Organisme', 'Lieu', 'Date de début', 'Date de fin', 'Durée (h)', 'Coût', 'Statut', 'Habilitation visée', 'Nb participants', 'Participants', 'Site / service'];
      lignes = filtrerFormations(req, req.query).map((f) => { const e = enrichirFormation(req, f, persMap); return [e.intitule, e.organisme, e.lieu, fr(e.dateDebut), fr(e.dateFin), nombreCsv(e.dureeHeures), nombreCsv(e.cout), e.statutLibelle, e.habilitationLibelle, e.nbParticipants, e.participants.map((p) => p.nomComplet).join(', '), service(f.secteurId)]; });
    } else if (quoi === 'visites') {
      entetes = ['Matricule', 'Nom', 'Site / service', 'Type de visite', 'Date', 'Aptitude', 'Restrictions (aménagement de poste)', 'Prochaine visite'];
      lignes = filtrerVisites(req, req.query, idx).map((v) => { const e = enrichirVisite(req, v, idx, persMap); return [e.matricule, e.personnelNom, service(v.secteurId), e.typeLibelle, fr(e.date), e.aptitudeLibelle, e.restrictions, fr(e.prochaineVisite)]; });
    } else if (quoi === 'absences') {
      entetes = ['Matricule', 'Nom', 'Site / service', 'Type', 'Début', 'Fin', 'Demi-journée', 'Jours ouvrés', 'Statut', 'Demandée par', 'Décision par', 'Date de décision', 'Motif', 'Commentaire'];
      lignes = filtrerAbsences(req, req.query).map((a) => { const e = enrichirAbsence(req, a, idx, persMap); return [e.matricule, e.personnelNom, service(a.secteurId), e.typeLibelle, fr(e.dateDebut), fr(e.dateFin), e.demiJourneeLibelle, nombreCsv(e.nbJours), e.statutLibelle, e.demandeurNom, e.valideurNom, fr(e.dateValidation), e.motifDecision || '', e.commentaire]; });
    } else throw new HttpError(404, 'Export inconnu (personnel, habilitations, formations, visites ou absences)');
    const contenu = ['﻿' + entetes.map(csvEscape).join(';')].concat(lignes.map((l) => l.map(csvEscape).join(';'))).join('\r\n');
    ctx.audit(req, 'export', quoi === 'visites' ? VIS : quoi, null, `Export CSV RH : ${lignes.length} ligne(s)`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rh-${quoi}-${aujourdhui()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(contenu);
  }, { perm: [MODULE, 'exporter'] });

  // ----- Vérification quotidienne des échéances -------------------------------------------------------------
  function verifierEcheances(options = {}) {
    const ref = options.date && dateValide(options.date) ? options.date : aujourdhui();
    const jours = cfgRh().alerteJoursAvantEcheance;
    const resultat = { date: ref, expirees: 0, bientot: 0, visites: 0, notifications: 0 };
    const persMap = mapPersonnel();
    const habs = db.list(HAB);
    const courantes = habilitationsCourantes(habs);
    const fr = (d) => String(d).split('-').reverse().join('/');
    for (const h of habs) {
      const p = persMap.get(Number(h.personnelId));
      if (!p || p.actif === false || courantes.get(cleHab(h)) !== h.id || !h.dateExpiration) continue;
      const etat = etatEcheance(h.dateExpiration, ref, jours);
      const deja = h.alertes || {};
      if (etat === 'valide' || deja[etat] === h.dateExpiration) continue;
      if (etat === 'bientot' && deja.expiree === h.dateExpiration) continue;
      db.update(HAB, h.id, { alertes: Object.assign({}, deja, { [etat]: h.dateExpiration }) });
      const type = typeHabilitation(h.typeCode);
      const cibles = gestionnairesRh(p.secteurId).concat([managerDe(p), p.userId]);
      const message = etat === 'expiree'
        ? `${type ? type.label : h.intitule} de ${nomPersonne(p)} a expiré le ${fr(h.dateExpiration)} : la personne ne doit plus intervenir sous cette habilitation`
        : `${type ? type.label : h.intitule} de ${nomPersonne(p)} expire le ${fr(h.dateExpiration)} (dans ${joursEntre(ref, h.dateExpiration)} j) : prévoir le recyclage`;
      resultat.notifications += notifier(cibles, { titre: etat === 'expiree' ? 'Habilitation expirée' : 'Habilitation à renouveler', message, type: etat === 'expiree' ? 'erreur' : 'alerte' }, `#/rh/${p.id}?onglet=habilitations`);
      if (etat === 'expiree') { resultat.expirees++; ctx.emit('rh:habilitationExpiree', { habilitation: db.get(HAB, h.id), personnel: p, userId: p.userId != null ? Number(p.userId) : null }); } else { resultat.bientot++; ctx.emit('rh:habilitationBientotExpiree', { habilitation: db.get(HAB, h.id), personnel: p }); }
    }
    // Visites médicales échues (la plus récente visite de chaque personne)
    const idx = index(ref);
    for (const [pid, liste] of idx.visites) {
      const p = persMap.get(pid);
      if (!p || p.actif === false) continue;
      const v = visiteReference(liste, ref);
      if (!v || !v.prochaineVisite || etatVisite(v, idx) !== 'expiree' || (v.alertes || {}).expiree === v.prochaineVisite) continue;
      db.update(VIS, v.id, { alertes: Object.assign({}, v.alertes || {}, { expiree: v.prochaineVisite }) });
      resultat.notifications += notifier(gestionnairesRh(p.secteurId), { titre: 'Visite médicale à programmer', message: `La visite médicale de ${nomPersonne(p)} était prévue le ${fr(v.prochaineVisite)}`, type: 'alerte' }, `#/rh/${p.id}?onglet=visites`);
      resultat.visites++;
    }
    return resultat;
  }
  router.post('/api/rh/verifier-echeances', async (req) => {
    const r = verifierEcheances();
    ctx.audit(req, 'generation', HAB, null, `Vérification des échéances RH : ${r.expirees} expirée(s), ${r.bientot} à renouveler, ${r.visites} visite(s) échue(s)`);
    return r;
  }, { perm: [MODULE, 'modifier'] });

  if (!db.inMemory || process.env.GMAO_RH_AUTO === '1') {
    let dernierJour = null;
    const tache = () => {
      const j = aujourdhui();
      if (j === dernierJour) return;
      dernierJour = j;
      try { verifierEcheances(); } catch (e) { ctx.log('RH : vérification des échéances en échec', e.message); }
    };
    const demarrage = setTimeout(tache, 45 * 1000);
    if (demarrage.unref) demarrage.unref();
    const periodique = setInterval(tache, INTERVALLE_VERIFICATION_MS);
    if (periodique.unref) periodique.unref();
  }

  // ----- Services publiés -----------------------------------------------------------------------------------
  function habilitationsValides(userId, date) {
    const p = personnelDeUser(userId);
    if (!p || p.actif === false) return [];
    const ref = date && dateValide(String(date).slice(0, 10)) ? String(date).slice(0, 10) : aujourdhui();
    const jours = cfgRh().alerteJoursAvantEcheance;
    const habs = db.list(HAB, (h) => Number(h.personnelId) === p.id);
    const courantes = habilitationsCourantes(habs);
    return habs.filter((h) => courantes.get(cleHab(h)) === h.id && (!h.dateObtention || h.dateObtention <= ref) && (!h.dateExpiration || h.dateExpiration >= ref)).map((h) => {
      const type = typeHabilitation(h.typeCode);
      const etat = etatEcheance(h.dateExpiration, ref, jours);
      return { id: h.id, typeCode: h.typeCode, libelle: type ? type.label : h.typeCode, couleur: (type && type.couleur) || '#6b7280', intitule: h.intitule, numero: h.numero || '', organisme: h.organisme || '', dateObtention: h.dateObtention, dateExpiration: h.dateExpiration || null, etat, joursRestants: h.dateExpiration ? joursEntre(ref, h.dateExpiration) : null };
    }).sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
  }
  function absencesEntre(du, au, options = {}) {
    const d = du ? String(du).slice(0, 10) : aujourdhui();
    const f = au ? String(au).slice(0, 10) : d;
    const statuts = Array.isArray(options.statuts) && options.statuts.length ? options.statuts : ['validee'];
    const secteurIds = Array.isArray(options.secteurIds) ? new Set(options.secteurIds.map(Number)) : null;
    const persMap = mapPersonnel();
    const userIds = Array.isArray(options.userIds) ? new Set(options.userIds.map(Number)) : null;
    return db.list(ABS, (a) => statuts.includes(a.statut) && a.dateDebut <= f && a.dateFin >= d && (!secteurIds || secteurIds.has(Number(a.secteurId))))
      .filter((a) => { const p = persMap.get(Number(a.personnelId)); return !userIds || (p && p.userId != null && userIds.has(Number(p.userId))); })
      .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut))
      .map((a) => {
        const p = persMap.get(Number(a.personnelId));
        const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
        return { id: a.id, personnelId: a.personnelId, userId: p && p.userId != null ? Number(p.userId) : null, nom: nomPersonne(p), secteurId: a.secteurId, typeCode: a.typeCode, libelle: type ? type.label : a.typeCode, couleur: (type && type.couleur) || '#6b7280', dateDebut: a.dateDebut, dateFin: a.dateFin, demiJournee: a.demiJournee || null, statut: a.statut, absent: typeRendAbsent(a.typeCode), nbJours: dureeAbsence(a, d, f) };
      });
  }
  function absenceDe(userId, date) {
    const p = personnelDeUser(userId);
    if (!p) return null;
    const j = date ? (date instanceof Date ? isoLocal(date) : String(date).slice(0, 10)) : aujourdhui();
    const a = db.findOne(ABS, (x) => Number(x.personnelId) === p.id && x.statut === 'validee' && x.dateDebut <= j && x.dateFin >= j && typeRendAbsent(x.typeCode));
    if (!a) return null;
    const type = ctx.liste('typesAbsence').find((t) => t.code === a.typeCode);
    return { id: a.id, personnelId: p.id, userId: Number(userId), typeCode: a.typeCode, libelle: type ? type.label : a.typeCode, dateDebut: a.dateDebut, dateFin: a.dateFin, demiJournee: a.demiJournee || null };
  }

  ctx.services.rh = {
    /** Absences (validées par défaut) qui chevauchent [du, au] ; options { secteurIds, userIds, statuts }. `absent: false` pour une astreinte. */
    absencesEntre,
    /** Habilitations valides d'un utilisateur (via sa fiche du personnel) à une date (défaut : aujourd'hui). */
    habilitationsValides,
    /** L'utilisateur est-il absent (absence validée, au moins une demi-journée) à cette date ? */
    estAbsent: (userId, date) => !!absenceDe(userId, date),
    /** Absence validée d'un utilisateur à une date (ou null) — détail de estAbsent (demi-journée…). */
    absenceDe,
    /** L'utilisateur possède-t-il une habilitation valide de ce type à cette date ? */
    habilitationValide: (userId, typeCode, date) => habilitationsValides(userId, date).some((h) => h.typeCode === typeCode),
    /** Fiche du personnel liée à un compte (ou null). */
    personnelDeUser,
    /** Vérification des échéances (notifications + événements) ; appelée chaque jour hors mode mémoire. */
    verifierEcheances,
    /** Jours ouvrés entre deux dates incluses (hors week-ends et jours fériés français). */
    joursOuvres,
  };
}

// ----- Données de démonstration ------------------------------------------------------------------------------
function seedDemo(ctx) {
  const { db } = ctx;
  // Dépendances : comptes de démonstration et lignes de production (modules chargés après celui-ci)
  for (const m of ctx.modules || []) {
    if (/^(utilisateurs|secteurs)\.js$/.test(m.fichier || '') && typeof m.seedDemo === 'function') {
      try { m.seedDemo(ctx); } catch (e) { ctx.log('RH : données de démonstration dépendantes en échec', m.fichier, e.message); }
    }
  }
  const rapport = [];
  if (!db.findOne(PERS, (p) => p.nom === 'Garcia' && p.prenom === 'Thomas')) rapport.push(seedSitePrincipal(ctx));
  else rapport.push('site principal : déjà présent');
  const val = db.findOne('secteurs', (s) => s.code === 'VAL');
  if (val) {
    if (!db.findOne(PERS, (p) => p.nom === 'Fabre' && p.prenom === 'Antoine')) rapport.push(seedValreas(ctx, val));
    else rapport.push('Valréas : déjà présent');
  }
  return rapport.join(' ; ');
}

function outilsSeed(ctx) {
  const { db } = ctx;
  const J = aujourdhui();
  const dans = (n) => ajouterJours(J, n);
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const uid = (login) => { if (!login) return null; const u = db.findOne('users', (x) => x.login === login); return u ? u.id : null; };
  const sid = (code, repli) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : (repli ? sid(repli) : null); };
  const gabarit = (db.getConfig().numerotation || {}).mat || 'MAT-{num:4}';
  const matricule = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('mat', gabarit); if (!db.findOne(PERS, (x) => x.matricule === n)) return n; } return 'MAT-' + Date.now(); };
  const types = new Map((db.getConfig().listes.typesHabilitation || []).map((t) => [t.code, t]));
  const createur = admin ? admin.id : null;
  const personne = (o) => db.insert(PERS, Object.assign({
    matricule: matricule(), userId: null, managerUserId: null, fonction: '', typeContratCode: 'cdi', dateEntree: null, dateSortie: null, telephone: '', email: '',
    contactUrgence: { nom: '', telephone: '' }, coutHoraire: null, competences: [], notes: '', actif: true, champs: {}, createdBy: createur,
  }, o));
  const habilitation = (p, typeCode, exp, o = {}) => {
    const t = types.get(typeCode);
    const mois = t && Number(t.dureeMois) > 0 ? Number(t.dureeMois) : 36;
    return db.insert(HAB, Object.assign({
      personnelId: p.id, secteurId: p.secteurId, typeCode, intitule: t ? t.label : typeCode, organisme: '', numero: '', commentaire: '',
      dateObtention: ajouterMois(exp, -mois), dateExpiration: exp, expirationCalculee: true, documents: [], historique: [], alertes: {}, formationId: null, createdBy: createur,
    }, o));
  };
  const visite = (p, type, date, aptitude, prochaine, restrictions) => db.insert(VIS, { personnelId: p.id, secteurId: p.secteurId, type, date, aptitude, restrictions: restrictions || '', prochaineVisite: prochaine || null, alertes: {}, createdBy: createur });
  const absence = (p, typeCode, debut, fin, statut, o = {}) => db.insert(ABS, Object.assign({
    personnelId: p.id, secteurId: p.secteurId, typeCode, dateDebut: debut, dateFin: fin, demiJournee: null, commentaire: '', statut,
    demandeurUserId: p.userId || createur, valideurUserId: null, dateValidation: null, motifDecision: '', createdBy: p.userId || createur,
  }, o));
  const fournisseur = (re) => { const f = db.findOne('fournisseurs', (x) => re.test(x.nom || '')); return f ? f.id : null; };
  return { J, dans, uid, sid, personne, habilitation, visite, absence, fournisseur, createur, types };
}

function seedSitePrincipal(ctx) {
  const { db } = ctx;
  const o = outilsSeed(ctx);
  const { dans, uid, sid, personne, habilitation, visite, absence } = o;
  const MAINT = sid('MAINT', 'SITE'); const PROD = sid('PROD', 'SITE'); const L1 = sid('PROD-L1', 'PROD') || PROD; const L2 = sid('PROD-L2', 'PROD') || PROD;
  const LOG = sid('LOG', 'SITE'); const QUAL = sid('QUAL', 'SITE'); const SITE = sid('SITE') || MAINT;
  if (MAINT == null) return 'secteurs absents';
  const comp = (l) => l.map(([libelle, niveau]) => ({ libelle, niveau }));
  const ilYa = (n) => dans(-n);

  // Personnel lié aux comptes de démonstration
  const dupont = personne({ userId: uid('mdupont'), nom: 'Dupont', prenom: 'Marie', fonction: 'Responsable maintenance', secteurId: MAINT, managerUserId: uid('admin'), typeContratCode: 'cdi', dateEntree: '2012-09-03', telephone: '04 90 63 12 40', email: 'marie.dupont@sicaf.fr', contactUrgence: { nom: 'Laurent Dupont (conjoint)', telephone: '06 12 45 78 90' }, coutHoraire: 52, competences: comp([['Management d\'équipe', 4], ['Méthodes et GMAO', 4], ['Hydraulique industrielle', 3], ['Automatismes Siemens S7', 3]]), notes: 'Référente sécurité du service maintenance. Suit le plan de formation et les habilitations de l\'équipe.' });
  const martin = personne({ userId: uid('pmartin'), nom: 'Martin', prenom: 'Pierre', fonction: 'Chef de secteur Production', secteurId: PROD, managerUserId: uid('mdupont'), typeContratCode: 'cdi', dateEntree: '2015-02-16', telephone: '04 90 63 12 55', email: 'pierre.martin@sicaf.fr', contactUrgence: { nom: 'Claire Martin', telephone: '06 33 21 09 87' }, coutHoraire: 44, competences: comp([['Animation d\'équipe', 3], ['Lean manufacturing / 5S', 3], ['Conduite de ligne de conditionnement', 4]]) });
  const bernard = personne({ userId: uid('jbernard'), nom: 'Bernard', prenom: 'Julie', fonction: 'Technicienne de maintenance', secteurId: MAINT, managerUserId: uid('mdupont'), typeContratCode: 'cdi', dateEntree: '2019-04-01', telephone: '06 71 22 48 13', email: 'julie.bernard@sicaf.fr', contactUrgence: { nom: 'Hélène Bernard (mère)', telephone: '06 08 54 22 71' }, coutHoraire: 37, competences: comp([['Mécanique industrielle', 4], ['Pneumatique', 3], ['Lecture de plans', 3], ['Soudure TIG', 2]]) });
  const leroy = personne({ userId: uid('kleroy'), nom: 'Leroy', prenom: 'Karim', fonction: 'Technicien électricien', secteurId: MAINT, managerUserId: uid('mdupont'), typeContratCode: 'cdi', dateEntree: '2017-10-09', telephone: '06 45 90 12 66', email: 'karim.leroy@sicaf.fr', contactUrgence: { nom: 'Samira Leroy', telephone: '06 98 76 54 32' }, coutHoraire: 39, competences: comp([['Électricité industrielle', 4], ['Automatismes', 3], ['Variateurs de vitesse', 3], ['Froid industriel', 2]]) });
  const petit = personne({ userId: uid('spetit'), nom: 'Petit', prenom: 'Sophie', fonction: 'Opératrice ligne 1', secteurId: L1, managerUserId: uid('pmartin'), typeContratCode: 'cdi', dateEntree: '2021-06-07', telephone: '06 12 87 45 09', email: 'sophie.petit@sicaf.fr', contactUrgence: { nom: 'Marc Petit', telephone: '06 77 41 52 30' }, coutHoraire: 28, competences: comp([['Conduite remplisseuse', 3], ['Changement de format', 2], ['Autocontrôle qualité', 3]]) });
  // Personnel sans compte GMAO
  const garcia = personne({ nom: 'Garcia', prenom: 'Thomas', fonction: 'Technicien de maintenance mécanique', secteurId: MAINT, managerUserId: uid('mdupont'), typeContratCode: 'cdd', dateEntree: ilYa(183), dateSortie: dans(48), telephone: '06 58 14 72 90', coutHoraire: 34, competences: comp([['Mécanique industrielle', 3], ['Hydraulique', 2]]), notes: 'CDD de remplacement (congé parental). Renouvellement ou embauche à étudier avant l\'échéance du contrat.' });
  const benali = personne({ nom: 'Benali', prenom: 'Nadia', fonction: 'Cariste – préparatrice de commandes', secteurId: LOG, typeContratCode: 'cdi', dateEntree: '2016-03-14', telephone: '06 21 34 56 78', contactUrgence: { nom: 'Youssef Benali', telephone: '06 87 65 43 21' }, coutHoraire: 29, competences: comp([['Conduite de chariots élévateurs', 4], ['Gestion de stock (WMS)', 3]]) });
  const moreau = personne({ nom: 'Moreau', prenom: 'Lucas', fonction: 'Agent de production (intérim)', secteurId: L2, managerUserId: uid('pmartin'), typeContratCode: 'interim', dateEntree: ilYa(43), dateSortie: dans(47), telephone: '07 61 23 45 98', coutHoraire: 31, competences: comp([['Assemblage', 2]]), notes: 'Mission d\'intérim (agence de Carpentras) : renfort de la ligne 2 jusqu\'à la fin du pic d\'activité.' });
  const rousseau = personne({ nom: 'Rousseau', prenom: 'Émilie', fonction: 'Technicienne de laboratoire', secteurId: QUAL, typeContratCode: 'cdi', dateEntree: '2020-01-06', telephone: '06 44 19 83 27', coutHoraire: 32, competences: comp([['Métrologie', 3], ['Analyses physico-chimiques', 4]]) });

  // Habilitations (2 à renouveler sous 60 jours, 1 expirée)
  habilitation(dupont, 'elec_b2v', dans(150), { intitule: 'Habilitation électrique B2V / BR / BC', organisme: 'APAVE Sud Europe', numero: 'HE-2023-0412' });
  habilitation(dupont, 'sst', dans(240), { organisme: 'Croix-Rouge française' });
  habilitation(martin, 'sst', dans(320), { organisme: 'Croix-Rouge française' });
  habilitation(martin, 'elec_b0', dans(400), { intitule: 'Habilitation électrique B0 / H0V (non électricien)', organisme: 'APAVE Sud Europe' });
  habilitation(bernard, 'elec_b1v', dans(37), { intitule: 'Habilitation électrique B1V', organisme: 'APAVE Sud Europe', numero: 'HE-2023-1187' });
  habilitation(bernard, 'travail_hauteur', dans(480), { intitule: 'Travail en hauteur – port du harnais', organisme: 'Bureau Veritas Formation' });
  habilitation(bernard, 'caces_r486', dans(560), { intitule: 'CACES R486 catégorie B (nacelle)', organisme: 'AFTRAL Avignon', numero: 'R486-B-22-0577' });
  habilitation(leroy, 'elec_b2v', dans(51), { intitule: 'Habilitation électrique B2V / BR / BC', organisme: 'APAVE Sud Europe', numero: 'HE-2023-1188' });
  habilitation(leroy, 'elec_h1', dans(700), { intitule: 'Habilitation haute tension H1V / H2V', organisme: 'APAVE Sud Europe' });
  habilitation(leroy, 'atex', dans(820), { intitule: 'ATEX niveau 1', organisme: 'INERIS Formation' });
  habilitation(leroy, 'travail_hauteur', dans(345), { intitule: 'Travail en hauteur – port du harnais', organisme: 'Bureau Veritas Formation' });
  habilitation(petit, 'elec_b0', dans(540), { intitule: 'Habilitation électrique B0 / H0V (non électricien)', organisme: 'APAVE Sud Europe' });
  habilitation(garcia, 'elec_b1v', dans(980), { intitule: 'Habilitation électrique B1V', organisme: 'Formapelec' });
  habilitation(benali, 'caces_r489', dans(-24), { intitule: 'CACES R489 catégories 1A, 3 et 5', organisme: 'AFTRAL Avignon', numero: 'R489-21-1043' });
  habilitation(moreau, 'caces_r489', dans(1200), { intitule: 'CACES R489 catégorie 1A', organisme: 'Agence d\'intérim' });

  // Formations : 1 réalisée (renouvellement SST automatique), 2 planifiées
  const fDebut = prochainOuvre(dans(-118));
  const sst = db.insert(FOR, {
    intitule: 'Maintien et actualisation des compétences SST (MAC SST)', organisme: 'Croix-Rouge française – Formation', lieu: 'Salle de réunion, bâtiment administratif', description: 'Recyclage obligatoire tous les 24 mois : conduite à tenir face à un accident, prévention des risques professionnels.',
    fournisseurId: o.fournisseur(/croix|secour|formation/i), factureId: null, dateDebut: fDebut, dateFin: fDebut, dureeHeures: 7, cout: 540, statut: 'realisee', habilitationTypeCode: 'sst',
    personnelIds: [garcia.id, benali.id, rousseau.id], presents: [garcia.id, benali.id, rousseau.id], habilitationsGenerees: [], secteurId: SITE, dateRealisation: `${fDebut}T16:30:00.000Z`, realiseePar: uid('mdupont') || o.createur, createdBy: uid('mdupont') || o.createur,
  });
  const generees = [garcia, benali, rousseau].map((p) => {
    const h = habilitation(p, 'sst', ajouterMois(fDebut, Number((o.types.get('sst') || {}).dureeMois) || 24), { organisme: 'Croix-Rouge française – Formation', formationId: sst.id, dateObtention: fDebut, commentaire: 'Obtenue lors de la formation « Maintien et actualisation des compétences SST (MAC SST) »' });
    return { personnelId: p.id, habilitationId: h.id, action: 'creee', dateExpiration: h.dateExpiration };
  });
  db.update(FOR, sst.id, { habilitationsGenerees: generees });
  const elecDebut = prochainOuvre(dans(22));
  db.insert(FOR, {
    intitule: 'Recyclage habilitation électrique B1V / B2V / BR (NF C 18-510)', organisme: 'APAVE Sud Europe', lieu: 'Centre APAVE d\'Avignon', description: 'Recyclage triennal : prévention du risque électrique, consignation, travaux au voisinage. Évaluation théorique et pratique.',
    fournisseurId: o.fournisseur(/apave/i), factureId: null, dateDebut: elecDebut, dateFin: prochainOuvre(ajouterJours(elecDebut, 1)), dureeHeures: 14, cout: 1180, statut: 'planifiee', habilitationTypeCode: 'elec_b2v',
    personnelIds: [bernard.id, leroy.id], presents: null, habilitationsGenerees: [], secteurId: MAINT, createdBy: uid('mdupont') || o.createur,
  });
  const cacesDebut = prochainOuvre(dans(13));
  db.insert(FOR, {
    intitule: 'CACES R489 catégories 1A, 3 et 5 – recyclage', organisme: 'AFTRAL Avignon', lieu: 'Plateforme AFTRAL, Le Pontet', description: 'Recyclage quinquennal des chariots automoteurs à conducteur porté : tests théoriques et pratiques.',
    fournisseurId: o.fournisseur(/aftral/i), factureId: null, dateDebut: cacesDebut, dateFin: prochainOuvre(ajouterJours(cacesDebut, 2)), dureeHeures: 21, cout: 890, statut: 'planifiee', habilitationTypeCode: 'caces_r489',
    personnelIds: [benali.id], presents: null, habilitationsGenerees: [], secteurId: LOG, createdBy: uid('mdupont') || o.createur,
  });

  // Visites médicales (dates et aptitude uniquement)
  visite(dupont, 'periodique', ilYa(420), 'apte', dans(1040));
  visite(martin, 'periodique', ilYa(300), 'apte', dans(1160));
  visite(bernard, 'periodique', ilYa(700), 'apte', dans(395));
  visite(leroy, 'periodique', ilYa(1835), 'apte', dans(-9));
  visite(petit, 'embauche', '2021-06-01', 'apte', '2023-06-01');
  visite(petit, 'periodique', ilYa(200), 'apte', dans(1260));
  visite(garcia, 'embauche', ilYa(181), 'apte', dans(1280));
  visite(benali, 'periodique', ilYa(714), 'apte_restrictions', dans(16), 'Port de charges limité à 15 kg ; pas de travail de nuit');
  visite(moreau, 'embauche', ilYa(45), 'apte', null);
  visite(rousseau, 'periodique', ilYa(500), 'apte', dans(960));
  visite(rousseau, 'reprise', prochainOuvre(dans(3)), 'en_attente', null);

  // Absences : congés validés, une demande en attente, un refus, absents du jour
  const valide = (login) => ({ valideurUserId: uid(login) || o.createur, dateValidation: new Date(Date.now() - 5 * 86400000).toISOString() });
  const conges1 = prochainOuvre(dans(12));
  absence(bernard, 'conges', conges1, ajouterJours(conges1, 4), 'validee', Object.assign(valide('mdupont'), { commentaire: 'Vacances de la Toussaint' }));
  absence(martin, 'rtt', o.J, o.J, 'validee', Object.assign(valide('mdupont'), { demiJournee: 'apres_midi' }));
  absence(rousseau, 'maladie', ilYa(2), dans(2), 'validee', Object.assign(valide('admin'), { demandeurUserId: o.createur, createdBy: o.createur, commentaire: 'Arrêt de travail transmis au service RH' }));
  absence(dupont, 'conges', dans(68), dans(78), 'validee', Object.assign(valide('admin'), { commentaire: 'Congés de fin d\'année' }));
  absence(petit, 'conges', ilYa(70), ilYa(52), 'validee', valide('pmartin'));
  absence(benali, 'maladie', ilYa(13), ilYa(12), 'validee', Object.assign(valide('admin'), { demandeurUserId: o.createur, createdBy: o.createur }));
  absence(leroy, 'astreinte', ilYa(7), ilYa(1), 'validee', Object.assign(valide('mdupont'), { commentaire: 'Astreinte maintenance semaine' }));
  const congesLeroy = prochainOuvre(dans(19));
  const demande = absence(leroy, 'conges', congesLeroy, ajouterJours(congesLeroy, 4), 'demandee', { commentaire: 'Mariage d\'un proche' });
  const refus = prochainOuvre(dans(5));
  absence(garcia, 'conges', refus, ajouterJours(refus, 4), 'refusee', Object.assign(valide('mdupont'), { demandeurUserId: uid('mdupont') || o.createur, motifDecision: 'Arrêt technique de la ligne 2 programmé cette semaine : présence requise. Merci de proposer une autre période.' }));
  if (uid('mdupont')) ctx.notify([uid('mdupont')], { titre: 'Demande d\'absence : Karim Leroy', message: `Congés payés du ${demande.dateDebut.split('-').reverse().join('/')} au ${demande.dateFin.split('-').reverse().join('/')} — Mariage d'un proche`, lien: '#/rh?onglet=absences', type: 'alerte' });
  return `9 fiches du personnel (5 liées aux comptes de démonstration, 1 intérimaire), ${db.count(HAB)} habilitations, 3 formations, ${db.count(VIS)} visites médicales, ${db.count(ABS)} absences`;
}

function seedValreas(ctx, val) {
  const o = outilsSeed(ctx);
  const { dans, sid, personne, habilitation, visite, absence } = o;
  const VM = sid('VAL-MAINT') || val.id; const VL = sid('VAL-LOG') || val.id; const VP = sid('VAL-PROD') || val.id;
  const fabre = personne({ nom: 'Fabre', prenom: 'Antoine', fonction: 'Technicien de maintenance polyvalent', secteurId: VM, typeContratCode: 'cdi', dateEntree: '2018-05-22', telephone: '06 32 11 47 85', coutHoraire: 36, competences: [{ libelle: 'Mécanique industrielle', niveau: 3 }, { libelle: 'Électricité industrielle', niveau: 3 }] });
  const roux = personne({ nom: 'Roux', prenom: 'Camille', fonction: 'Cariste', secteurId: VL, typeContratCode: 'cdi', dateEntree: '2022-02-01', telephone: '06 41 58 29 63', coutHoraire: 28, competences: [{ libelle: 'Conduite de chariots élévateurs', niveau: 3 }] });
  const lambert = personne({ nom: 'Lambert', prenom: 'Hugo', fonction: 'Conducteur de ligne', secteurId: VP, typeContratCode: 'cdd', dateEntree: dans(-90), dateSortie: dans(275), telephone: '07 82 14 36 59', coutHoraire: 30 });
  habilitation(fabre, 'elec_b2v', dans(400), { intitule: 'Habilitation électrique B2V / BR', organisme: 'APAVE Sud Europe' });
  habilitation(fabre, 'travail_hauteur', dans(610), { organisme: 'Bureau Veritas Formation' });
  habilitation(roux, 'caces_r489', dans(900), { intitule: 'CACES R489 catégories 1A et 3', organisme: 'AFTRAL Avignon' });
  habilitation(lambert, 'sst', dans(500), { organisme: 'Croix-Rouge française' });
  visite(fabre, 'periodique', dans(-380), 'apte', dans(1080));
  visite(roux, 'periodique', dans(-250), 'apte', dans(1210));
  visite(lambert, 'embauche', dans(-92), 'apte', null);
  const debut = prochainOuvre(dans(30));
  absence(fabre, 'conges', debut, ajouterJours(debut, 4), 'validee', { valideurUserId: o.createur, dateValidation: new Date().toISOString() });
  return 'Valréas : 3 fiches du personnel, 4 habilitations, 3 visites, 1 absence';
}

module.exports = { nom, register, seedDemo, LISTES_DEFAUT, outils: { ajouterMois, ajouterJours, joursOuvres, estOuvre, joursFeries, paques } };
