'use strict';
/**
 * Module Rapports & historique : indicateurs de maintenance (synthèse), historique des interventions
 * clôturées, fiche de vie d'un équipement et exports CSV.
 *
 * Règles de calcul (toutes les routes : droit rapports.voir et portée de l'utilisateur) :
 *  - Volumes (total, par statut / type / priorité / secteur) : OT CRÉÉS dans la période.
 *  - Réalisation (taux préventif, respect des délais, MTTR, durée moyenne) : OT TERMINÉS dans la période
 *    (date de fin dans la période, statut final hors annulation).
 *      · taux préventif = OT préventifs terminés / OT terminés (en %) ; un OT issu d'un plan préventif est préventif ;
 *      · respect des délais = part des OT terminés dont la durée création → fin ne dépasse pas le
 *        `delaiHeures` de leur priorité (OT dont la priorité n'a pas de délai exclus) ; pour un OT issu d'une
 *        demande d'intervention, le délai court depuis le dépôt de la demande (même règle que le module Demandes) ;
 *        pour un OT planifié à l'avance sans demande (date prévue postérieure à la création), à partir de la date prévue ;
 *      · MTTR = moyenne début → fin des OT correctifs terminés ; durée moyenne = idem tous types.
 *  - Coûts ENGAGÉS dans la période : main d'œuvre à la date des temps passés (au prorata du coût de l'OT),
 *    pièces à la date de sortie, prestations externes à la date de fin (à défaut début, date prévue, création).
 *  - Pannes : OT correctifs (type « correctif » de la liste typesIntervention, repli sur le libellé) créés dans la
 *    période, hors annulés. Heures d'arrêt et MTTR par équipement : durées début → fin des correctifs terminés ;
 *    MTBF = (durée observée − heures d'arrêt) / nombre de pannes (durée observée = période, bornée par la mise en
 *    service et par l'instant présent ; même fenêtre dans la synthèse et dans la fiche de vie d'une période ; sans
 *    période, la fiche de vie observe du premier OT connu à maintenant).
 *  - Techniciens : OT réalisés (terminés dans la période : responsable, intervenant ou temps saisi), heures = temps
 *    saisis datés dans la période, taux d'occupation = heures / (jours ouvrés × config.general.heuresParJour).
 *  - Demandes : déposées dans la période ; délai de validation = dépôt → décision ; taux de refus = refusées / décidées.
 *  - Stock : valeur actuelle des articles visibles ; mouvements et consommation (sorties − retours) de la période
 *    (limités aux sorties imputées aux OT filtrés lorsqu'un filtre secteur / équipement / technicien est actif).
 *  Les sections dont l'utilisateur n'a pas la consultation du module source (ot, demandes, stock, preventif) sont
 *  vides (objet `acces`). Tous les ratios valent 0 lorsque leur dénominateur est nul (jamais NaN).
 *
 * Routes : GET /api/rapports/synthese, /api/rapports/historique, /api/rapports/equipement/:id,
 *          /api/rapports/references, /api/rapports/export?type=historique|equipements|techniciens|couts|stock|synthese|fiche
 *          (rapports.exporter ; les exports qui reprennent le détail des OT — historique, fiche, equipements, techniciens,
 *          couts — exigent en plus ot.exporter, comme /api/ot-export, et le type stock exige stock.exporter)
 * Paramètres : du, au (AAAA-MM-JJ ; défaut : année en cours), secteurId (sous-secteurs inclus ; « aucun » = sans secteur),
 *          equipementId (sous-équipements inclus, sauf sousEquipements=0), technicienId.
 * Services publiés : ctx.services.rapports.{ synthese(req, query), historique(req, query), ficheVie(req, id, query),
 *          periode(query), references(req) } — req peut être null (appel système : aucune restriction).
 * Événements émis : 'rapports:export' ({ type, userId, lignes, du, au }).
 */
const nom = 'Rapports & historique';
const MODULE = 'rapports';
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_JOURS = 3660; // dix ans
const MAX_MOIS = 132;
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Statuts d'OT de repli (utilisés uniquement si la liste `statutsOT` est vide). */
const STATUTS_OT_DEFAUT = [
  { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
  { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
  { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
  { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
  { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
  { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
];
/** Rôles des types d'intervention : code par défaut, puis reconnaissance par code / libellé. */
const ROLES_TYPES = {
  correctif: { code: 'correctif', motif: /correct|curati|d[ée]pann|panne/i },
  preventif: { code: 'preventif', motif: /pr[ée]vent|syst[ée]mati|p[ée]riodi/i },
};

const TYPES_EXPORT = {
  historique: 'Historique des interventions',
  equipements: 'Fiabilité des équipements',
  techniciens: 'Activité des techniciens',
  couts: 'Coûts de maintenance',
  stock: 'Consommation de pièces',
  synthese: 'Synthèse des indicateurs',
  fiche: 'Fiche de vie d\'équipement',
};

// ----- Utilitaires purs ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function arrondi(n, dec = 2) { const f = 10 ** dec; const r = Math.round((Number(n) || 0) * f) / f; return Number.isFinite(r) ? r : 0; }
/** Pourcentage a / b arrondi à 0,1 (0 si b est nul). */
function pct(a, b) { return b > 0 ? arrondi((a / b) * 100, 1) : 0; }
function moyenne(valeurs) { return valeurs.length ? arrondi(valeurs.reduce((s, x) => s + x, 0) / valeurs.length, 2) : 0; }
const faux = (v) => v === false || v === 0 || ['0', 'false', 'non', 'off'].includes(String(v == null ? '' : v).toLowerCase());
const normaliser = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** Date locale AAAA-MM-JJ. */
function dateLocale(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Jour local (AAAA-MM-JJ) d'une date ou d'un horodatage ISO ('' si invalide). */
function jourDe(s) {
  if (!s) return '';
  if (RE_DATE.test(String(s))) return String(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : dateLocale(new Date(t));
}
/** Horodatage (ms) d'une date AAAA-MM-JJ (minuit local) ou ISO ; null si invalide. */
function horodatage(s) {
  if (!s) return null;
  if (RE_DATE.test(String(s))) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
function debutJour(j) { const [y, m, d] = j.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function finJour(j) { const [y, m, d] = j.split('-').map(Number); return new Date(y, m - 1, d + 1).getTime(); }
function ajouterJours(j, n) { const [y, m, d] = j.split('-').map(Number); return dateLocale(new Date(y, m - 1, d + n)); }
/** Nombre de jours calendaires entre deux dates incluses. */
function nbJours(du, au) { return Math.round((debutJour(au) - debutJour(du)) / 86400000) + 1; }
/** Jours ouvrés (lundi → vendredi) entre deux dates incluses. */
function joursOuvres(du, au) {
  let n = 0;
  for (let j = du, i = 0; j <= au && i <= MAX_JOURS + 7; j = ajouterJours(j, 1), i++) {
    const [y, m, d] = j.split('-').map(Number);
    const js = new Date(y, m - 1, d).getDay();
    if (js !== 0 && js !== 6) n++;
  }
  return n;
}
/** Mois « AAAA-MM » couverts par la période. */
function moisEntre(du, au) {
  const out = [];
  let [y, m] = du.slice(0, 7).split('-').map(Number);
  const fin = au.slice(0, 7);
  for (let i = 0; i < MAX_MOIS; i++) {
    const k = `${y}-${pad(m)}`;
    out.push(k);
    if (k >= fin) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function libelleMois(k) { const [y, m] = k.split('-').map(Number); return `${MOIS_COURTS[m - 1] || k} ${y}`; }
/** Durée (h) entre deux dates, null si l'une manque ou si la fin précède le début. */
function heuresEntre(a, b) {
  const ta = horodatage(a), tb = horodatage(b);
  if (ta == null || tb == null || tb < ta) return null;
  return (tb - ta) / 3600000;
}
function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvNombre = (n, dec = 2) => (n == null || n === '' ? '' : String(arrondi(n, dec)).replace('.', ','));

/** Outils de lecture de la liste de statuts d'OT configurée (repli sur les codes par défaut). */
function outilsStatutsOt(listeConfiguree) {
  const liste = Array.isArray(listeConfiguree) && listeConfiguree.length ? listeConfiguree.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : STATUTS_OT_DEFAUT;
  const item = (code) => liste.find((s) => s.code === code) || null;
  const estFinal = (code) => { const s = item(code); return !!(s && s.final); };
  const estAnnulation = (code) => { const s = item(code); return !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || ''))); };
  const finaux = liste.filter((s) => s.final);
  const termine = (finaux.find((s) => s.code === 'termine') || finaux.find((s) => !estAnnulation(s.code)) || finaux[0] || { code: 'termine' }).code;
  const annuleItem = finaux.find((s) => s.code === 'annule') || finaux.find((s) => estAnnulation(s.code));
  const nonFinal = (code, re) => { const s = item(code); if (s && !s.final) return s.code; const t = liste.find((x) => !x.final && re.test(`${x.code} ${x.label || ''}`)); return t ? t.code : null; };
  return {
    liste, item, estFinal, estAnnulation, termine,
    annule: annuleItem && annuleItem.code !== termine ? annuleItem.code : null,
    initial: (liste.find((s) => !s.final) || { code: 'nouveau' }).code,
    planifie: nonFinal('planifie', /planifi/i),
    enCours: nonFinal('en_cours', /cours/i),
    estTermine: (code) => estFinal(code) && !estAnnulation(code),
    libelle: (code) => { const s = item(code); return s ? s.label : String(code == null ? '' : code); },
    couleur: (code) => { const s = item(code); return (s && s.couleur) || '#6b7280'; },
  };
}
function listeTriee(cfg, nomListe) {
  const l = ((cfg && cfg.listes) || {})[nomListe];
  return Array.isArray(l) ? l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
}
/** Code de la liste typesIntervention jouant un rôle (correctif / préventif), ou null. */
function codeType(cfg, role) {
  const r = ROLES_TYPES[role];
  const l = listeTriee(cfg, 'typesIntervention');
  if (!l.length) return r.code;
  if (l.some((t) => t.code === r.code)) return r.code;
  const t = l.find((x) => r.motif.test(`${x.code} ${x.label || ''}`));
  return t ? t.code : null;
}
/** Calcul des coûts d'un OT (même règle que le module OT). */
function calculerCouts(o, tauxHoraire) {
  const taux = Number(tauxHoraire) || 0;
  const tempsTotal = arrondi((o.tempsPasse || []).reduce((s, t) => s + num(t.heures), 0));
  const coutMainOeuvre = arrondi(tempsTotal * taux);
  const coutPieces = arrondi((o.pieces || []).reduce((s, p) => s + num(p.quantite) * num(p.prixUnitaire), 0));
  const coutExterne = arrondi(num(o.coutExterne));
  return { tempsTotal, coutMainOeuvre, coutPieces, coutExterne, coutTotal: arrondi(coutMainOeuvre + coutPieces + coutExterne) };
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  /** Droit d'un module (un appel système, sans requête, a tous les droits). */
  const peut = (req, module, action) => (!req || !req.perms ? true : perms.can(req.perms, module, action || 'voir'));

  // ----- Portée ----------------------------------------------------------------------------------
  function estAffecte(uid, o) {
    if (uid == null || !o) return false;
    uid = Number(uid);
    return Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid));
  }
  function participe(uid, o) {
    return estAffecte(uid, o) || (o.tempsPasse || []).some((t) => Number(t.userId) === Number(uid));
  }
  /** Même règle que le module OT : portée standard étendue aux OT dont l'utilisateur est créateur ou intervenant. */
  function otVisible(req, o) {
    if (!req || !req.perms) return true;
    if (ctx.canSee(req, o)) return true;
    return estAffecte(req.user.id, o) || Number(o.createdBy) === req.user.id;
  }
  function equipementVisible(req, e) {
    if (!e) return false;
    if (!req || !req.perms) return true;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli */ } }
    return ctx.canSee(req, e);
  }
  /** Même règle que le module Demandes : portée standard + le N+1 voit les demandes de ses subordonnés. */
  function demandeVisible(req, d, subordonnes) {
    if (!req || !req.perms) return true;
    if (ctx.canSee(req, d)) return true;
    return d.demandeurId != null && subordonnes.has(Number(d.demandeurId));
  }
  function descendantsEquipement(id) {
    const s = ctx.services.equipements;
    if (s && typeof s.descendants === 'function') { try { return (s.descendants(id) || []).map(Number); } catch (e) { /* repli */ } }
    const tous = db.list('equipements');
    const out = new Set(); let frontiere = [Number(id)];
    while (frontiere.length) {
      const suivants = [];
      for (const e of tous) if (e.parentId != null && frontiere.includes(Number(e.parentId)) && !out.has(e.id) && e.id !== Number(id)) { out.add(e.id); suivants.push(e.id); }
      frontiere = suivants;
    }
    return Array.from(out);
  }

  // ----- Lecture des paramètres --------------------------------------------------------------------
  function lireJour(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (!RE_DATE.test(s)) throw new HttpError(400, `${label} est invalide (format attendu : AAAA-MM-JJ)`);
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d || y < 1990 || y > 2100) throw new HttpError(400, `${label} est invalide`);
    return s;
  }
  function lireEntier(v, label) {
    const s = String(v).trim();
    if (!/^\d{1,12}$/.test(s) || Number(s) <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return Number(s);
  }
  /** Période { du, au, jours, joursOuvres, heuresParJour, heuresOuvrees, tauxHoraire, aujourdhui }. */
  function lirePeriode(q, cfg) {
    q = q || {};
    cfg = cfg || ctx.config();
    const aujourdhui = dateLocale();
    const duSaisi = lireJour(q.du, 'La date de début');
    let au = lireJour(q.au, 'La date de fin');
    if (!au) au = duSaisi && duSaisi > aujourdhui ? duSaisi : aujourdhui;
    const du = duSaisi || `${au.slice(0, 4)}-01-01`;
    if (du > au) throw new HttpError(400, 'La date de début doit précéder la date de fin');
    const jours = nbJours(du, au);
    if (jours > MAX_JOURS) throw new HttpError(400, 'Période trop longue : dix ans maximum');
    const general = cfg.general || {};
    const hpj = Number(general.heuresParJour);
    const heuresParJour = Number.isFinite(hpj) && hpj > 0 ? hpj : 8;
    const ouvres = joursOuvres(du, au);
    return { du, au, jours, joursOuvres: ouvres, heuresParJour, heuresOuvrees: arrondi(ouvres * heuresParJour), tauxHoraire: num(general.tauxHoraire), aujourdhui };
  }
  /** Filtres secteur / équipement / technicien validés. */
  function lireFiltres(req, q) {
    q = q || {};
    const f = { secteurId: null, secteurs: null, sansSecteur: false, equipementId: null, equipements: null, sousEquipements: !faux(q.sousEquipements), technicienId: null };
    if (q.secteurId != null && q.secteurId !== '' && q.secteurId !== 'tous') {
      if (q.secteurId === 'aucun') f.sansSecteur = true;
      else {
        const id = lireEntier(q.secteurId, 'Secteur');
        if (!db.get('secteurs', id)) throw new HttpError(400, 'Secteur introuvable');
        f.secteurId = id;
        f.secteurs = new Set(perms.secteursDescendants(db, [id]).map(Number));
      }
    }
    if (q.equipementId != null && q.equipementId !== '') {
      const id = lireEntier(q.equipementId, 'Équipement');
      const e = db.get('equipements', id);
      if (!e || !equipementVisible(req, e)) throw new HttpError(400, 'Équipement introuvable');
      f.equipementId = id;
      f.equipements = new Set([id].concat(f.sousEquipements ? descendantsEquipement(id) : []));
    }
    if (q.technicienId != null && q.technicienId !== '') {
      const id = lireEntier(q.technicienId, 'Technicien');
      if (!db.get('users', id)) throw new HttpError(400, 'Technicien introuvable');
      f.technicienId = id;
    }
    return f;
  }
  function correspond(o, f) {
    if (f.secteurs && !(o.secteurId != null && f.secteurs.has(Number(o.secteurId)))) return false;
    if (f.sansSecteur && o.secteurId != null && o.secteurId !== '') return false;
    if (f.equipements && !(o.equipementId != null && f.equipements.has(Number(o.equipementId)))) return false;
    if (f.technicienId != null && !participe(f.technicienId, o)) return false;
    return true;
  }

  // ----- Contexte de calcul -------------------------------------------------------------------------
  function references() {
    return {
      equipements: new Map(db.list('equipements').map((e) => [e.id, e])),
      secteurs: new Map(db.list('secteurs').map((s) => [s.id, s])),
      users: new Map(db.list('users').map((u) => [u.id, u])),
      fournisseurs: new Map(db.list('fournisseurs').map((x) => [x.id, x])),
      demandes: new Map(db.list('demandes').map((d) => [d.id, d])),
      demandeParOt: new Map(db.list('demandes', (d) => d.otId != null).map((d) => [Number(d.otId), d])),
      plans: new Map(db.list('plansPreventifs').map((p) => [p.id, p])),
    };
  }
  /** Demande d'intervention à l'origine d'un OT (liée par ot.demandeId ou par demande.otId), ou null. */
  function demandeDe(refs, o) {
    const parId = o.demandeId != null ? refs.demandes.get(Number(o.demandeId)) : null;
    return parId || refs.demandeParOt.get(Number(o.id)) || null;
  }
  function nomDe(refs, id) {
    if (id == null) return '';
    const u = refs.users.get(Number(id));
    return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : `#${id}`;
  }
  function cheminSecteur(refs, id) {
    const parts = []; let cur = id == null ? null : refs.secteurs.get(Number(id)); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? refs.secteurs.get(Number(cur.parentId)) : null; }
    return parts.join(' › ');
  }
  function acces(req) {
    const exporter = peut(req, MODULE, 'exporter');
    return {
      ot: peut(req, 'ot'), demandes: peut(req, 'demandes'), stock: peut(req, 'stock'), preventif: peut(req, 'preventif'),
      equipements: peut(req, 'equipements'), exporter,
      // Exports reprenant le détail des OT (historique, fiche, équipements, techniciens, coûts) ou du stock
      exporterOt: exporter && peut(req, 'ot') && peut(req, 'ot', 'exporter'), exporterStock: exporter && peut(req, 'stock') && peut(req, 'stock', 'exporter'),
    };
  }
  /** Prépare le contexte commun : période, filtres, référentiels, OT visibles et filtrés (toutes dates). */
  function preparer(req, q, opts = {}) {
    q = q || {};
    const cfg = ctx.config();
    const periode = opts.periode === false ? null : lirePeriode(q, cfg);
    const filtres = lireFiltres(req, q);
    const droits = acces(req);
    const refs = references();
    const ots = droits.ot ? db.list('ot').filter((o) => otVisible(req, o) && correspond(o, filtres)) : [];
    const b = {
      req, q, cfg, periode, filtres, acces: droits, refs, ots,
      st: outilsStatutsOt((cfg.listes || {}).statutsOT),
      types: { correctif: codeType(cfg, 'correctif'), preventif: codeType(cfg, 'preventif') },
      priorites: new Map(listeTriee(cfg, 'priorites').map((p) => [p.code, p])),
      enPeriode: (j) => !!j && (!periode || (j >= periode.du && j <= periode.au)),
    };
    return b;
  }
  const finDe = (o) => o.dateFin || o.dateCloture || null;
  /** Date de référence d'un OT : fin, sinon début, date prévue, création. */
  const dateRef = (o) => o.dateFin || o.dateCloture || o.dateDebut || o.datePrevue || o.createdAt || null;
  const dureeOt = (o) => heuresEntre(o.dateDebut, finDe(o));
  const tempsOt = (o) => (o.tempsPasse || []).reduce((s, t) => s + num(t.heures), 0);
  const estPreventif = (b, o) => (!!b.types.preventif && o.typeCode === b.types.preventif) || o.planPreventifId != null;
  const estCorrectif = (b, o) => !!b.types.correctif && o.typeCode === b.types.correctif && o.planPreventifId == null;
  /**
   * L'OT terminé a-t-il respecté le délai de sa priorité ? (null si non évaluable)
   * Le délai court de la création de l'OT. Pour un OT issu d'une demande d'intervention, il court depuis le dépôt de
   * la demande (comme l'échéance calculée par le module Demandes : une panne urgente validée tardivement n'est pas
   * « dans les délais » pour autant). Pour un OT planifié à l'avance sans demande (date prévue postérieure à la
   * création, ex. préventif généré 30 jours avant l'échéance), il court à partir du début de la date prévue.
   */
  function dansDelai(b, o) {
    const p = b.priorites.get(o.prioriteCode);
    const delai = p ? Number(p.delaiHeures) : NaN;
    if (!(delai > 0) || !b.st.estTermine(o.statut)) return null;
    const creation = horodatage(o.createdAt);
    const fin = horodatage(finDe(o));
    if (creation == null || fin == null) return null;
    let depart = creation;
    const d = demandeDe(b.refs, o);
    const depot = d ? horodatage(d.dateDemande || d.createdAt) : null;
    if (depot != null) depart = Math.min(depot, creation);
    else {
      const prevue = horodatage(jourDe(o.datePrevue));
      if (prevue != null && prevue > creation) depart = prevue;
    }
    return (fin - depart) / 3600000 <= delai;
  }
  function participants(o) {
    const ids = new Set();
    if (o.technicienId != null) ids.add(Number(o.technicienId));
    for (const t of o.techniciens || []) if (t != null) ids.add(Number(t));
    for (const t of o.tempsPasse || []) if (t.userId != null) ids.add(Number(t.userId));
    return ids;
  }
  function libelleListe(cfg, nomListe, code) {
    if (code == null || code === '') return '';
    const it = listeTriee(cfg, nomListe).find((x) => x.code === code);
    return it ? it.label : String(code);
  }
  /** Répartition d'enregistrements selon une liste de valeurs (codes inconnus et non renseignés ajoutés à la fin). */
  function repartition(liste, rows, cle, extra) {
    const compte = new Map();
    for (const r of rows) { const k = r[cle] == null || r[cle] === '' ? null : r[cle]; compte.set(k, (compte.get(k) || 0) + 1); }
    const out = liste.map((it) => Object.assign({ code: it.code, label: it.label, couleur: it.couleur || null, nb: compte.get(it.code) || 0 }, extra ? extra(it) : {}));
    for (const [k, nb] of compte) {
      if (!liste.some((it) => it.code === k)) out.push(Object.assign({ code: k, label: k == null ? 'Non renseigné' : String(k), couleur: '#9ca3af', nb }, extra ? extra({}) : {}));
    }
    return out;
  }

  // ----- Section OT --------------------------------------------------------------------------------
  function selection(b) {
    if (b._sel) return b._sel;
    const crees = b.ots.filter((o) => b.enPeriode(jourDe(o.createdAt)));
    const termines = b.ots.filter((o) => b.st.estTermine(o.statut) && b.enPeriode(jourDe(finDe(o))));
    const annules = b.ots.filter((o) => b.st.estAnnulation(o.statut) && b.enPeriode(jourDe(finDe(o) || o.updatedAt)));
    b._sel = { crees, termines, annules };
    return b._sel;
  }
  function sectionOt(b) {
    const { crees, termines, annules } = selection(b);
    const st = b.st;
    const cfg = b.cfg;
    const aujourdhui = b.periode ? b.periode.aujourdhui : dateLocale();

    const parSecteurMap = new Map();
    for (const o of crees) { const k = o.secteurId == null || o.secteurId === '' ? null : Number(o.secteurId); parSecteurMap.set(k, (parSecteurMap.get(k) || 0) + 1); }
    const parSecteur = Array.from(parSecteurMap.entries()).map(([id, nb]) => {
      const s = id == null ? null : b.refs.secteurs.get(id);
      return { secteurId: id, nom: s ? s.nom : (id == null ? 'Sans secteur' : `#${id}`), chemin: id == null ? 'Sans secteur' : cheminSecteur(b.refs, id), couleur: s ? s.couleur || null : null, nb };
    }).sort((x, y) => y.nb - x.nb || x.nom.localeCompare(y.nom, 'fr'));

    // Techniciens : OT réalisés (terminés), OT affectés (créés dans la période), heures saisies dans la période
    const garder = (uid) => uid != null && (b.filtres.technicienId == null || Number(uid) === b.filtres.technicienId);
    const techs = new Map();
    const ligne = (uid) => { uid = Number(uid); if (!techs.has(uid)) techs.set(uid, { userId: uid, nom: nomDe(b.refs, uid), nb: 0, nbAffectes: 0, heures: 0 }); return techs.get(uid); };
    for (const o of termines) for (const uid of participants(o)) if (garder(uid)) ligne(uid).nb++;
    for (const o of crees) {
      const ids = new Set([o.technicienId].concat(o.techniciens || []).filter((x) => x != null).map(Number));
      for (const uid of ids) if (garder(uid)) ligne(uid).nbAffectes++;
    }
    let heuresTotal = 0;
    for (const o of b.ots) {
      for (const t of o.tempsPasse || []) {
        if (!b.enPeriode(jourDe(t.date))) continue;
        if (b.filtres.technicienId != null && Number(t.userId) !== b.filtres.technicienId) continue;
        heuresTotal += num(t.heures);
        if (garder(t.userId)) ligne(t.userId).heures += num(t.heures);
      }
    }
    const heuresOuvrees = b.periode ? b.periode.heuresOuvrees : 0;
    const parTechnicien = Array.from(techs.values()).map((t) => Object.assign(t, { heures: arrondi(t.heures), heuresOuvrees, tauxOccupation: pct(t.heures, heuresOuvrees) }))
      .sort((x, y) => y.heures - x.heures || y.nb - x.nb || x.nom.localeCompare(y.nom, 'fr'));

    const preventifs = termines.filter((o) => estPreventif(b, o));
    const evalues = termines.map((o) => dansDelai(b, o)).filter((x) => x !== null);
    const correctifsTermines = termines.filter((o) => estCorrectif(b, o));
    const dureesCorrectifs = correctifsTermines.map(dureeOt).filter((x) => x != null);
    const durees = termines.map(dureeOt).filter((x) => x != null);
    const ouverts = crees.filter((o) => !st.estFinal(o.statut));

    return {
      total: crees.length,
      ouverts: ouverts.length,
      enRetard: ouverts.filter((o) => o.datePrevue && jourDe(o.datePrevue) < aujourdhui).length,
      termines: termines.length,
      annules: annules.length,
      backlog: b.ots.filter((o) => !st.estFinal(o.statut)).length,
      correctifs: crees.filter((o) => estCorrectif(b, o)).length,
      preventifs: crees.filter((o) => estPreventif(b, o)).length,
      parStatut: repartition(st.liste, crees, 'statut', (it) => ({ final: !!it.final })),
      parType: repartition(listeTriee(cfg, 'typesIntervention'), crees, 'typeCode'),
      parPriorite: repartition(listeTriee(cfg, 'priorites'), crees, 'prioriteCode', (it) => ({ delaiHeures: it.delaiHeures == null ? null : num(it.delaiHeures) })),
      parSecteur,
      parTechnicien,
      tauxPreventif: pct(preventifs.length, termines.length),
      nbPreventifsTermines: preventifs.length,
      respectDelais: pct(evalues.filter(Boolean).length, evalues.length),
      nbDansDelai: evalues.filter(Boolean).length,
      nbEvaluesDelai: evalues.length,
      mttrHeures: moyenne(dureesCorrectifs),
      nbCorrectifsTermines: correctifsTermines.length,
      dureeMoyenneHeures: moyenne(durees),
      heuresTotal: arrondi(heuresTotal),
    };
  }

  // ----- Coûts engagés -------------------------------------------------------------------------------
  function imputations(b) {
    if (b._imput) return b._imput;
    const vide = () => ({ pieces: 0, mainOeuvre: 0, externe: 0, ots: new Set() });
    const r = { totaux: vide(), parSecteur: new Map(), parEquipement: new Map(), parMois: new Map(), parType: new Map(), parOt: new Map() };
    const ajouter = (map, k, champ, montant, otId) => { if (!map.has(k)) map.set(k, vide()); const x = map.get(k); x[champ] += montant; x.ots.add(otId); };
    const imputer = (o, jour, champ, montant) => {
      if (!(montant > 0) || !b.enPeriode(jour)) return;
      r.totaux[champ] += montant; r.totaux.ots.add(o.id);
      ajouter(r.parSecteur, o.secteurId == null || o.secteurId === '' ? null : Number(o.secteurId), champ, montant, o.id);
      if (o.equipementId != null) ajouter(r.parEquipement, Number(o.equipementId), champ, montant, o.id);
      ajouter(r.parMois, jour.slice(0, 7), champ, montant, o.id);
      ajouter(r.parType, o.typeCode || null, champ, montant, o.id);
      ajouter(r.parOt, o.id, champ, montant, o.id);
    };
    for (const o of b.ots) {
      const jourRef = jourDe(dateRef(o));
      // Main d'œuvre : coût de l'OT réparti au prorata des heures saisies (à leur date)
      const heures = tempsOt(o);
      const mo = num(o.coutMainOeuvre);
      if (heures > 0 && mo > 0) for (const t of o.tempsPasse || []) imputer(o, jourDe(t.date) || jourRef, 'mainOeuvre', (mo * num(t.heures)) / heures);
      else if (mo > 0) imputer(o, jourRef, 'mainOeuvre', mo);
      // Pièces : à la date de sortie de chaque ligne
      const lignes = o.pieces || [];
      if (lignes.length) for (const p of lignes) imputer(o, jourDe(p.date) || jourDe(o.dateDebut) || jourRef, 'pieces', num(p.quantite) * num(p.prixUnitaire));
      else if (num(o.coutPieces) > 0) imputer(o, jourRef, 'pieces', num(o.coutPieces));
      // Prestations externes : à la date de fin (à défaut début, date prévue, création)
      if (num(o.coutExterne) > 0) imputer(o, jourRef, 'externe', num(o.coutExterne));
    }
    b._imput = r;
    return r;
  }
  const montants = (x) => {
    const pieces = arrondi(x ? x.pieces : 0), mainOeuvre = arrondi(x ? x.mainOeuvre : 0), externe = arrondi(x ? x.externe : 0);
    return { pieces, mainOeuvre, externe, total: arrondi(pieces + mainOeuvre + externe) };
  };
  function sectionCouts(b) {
    const r = imputations(b);
    const parSecteur = Array.from(r.parSecteur.entries()).map(([id, x]) => {
      const s = id == null ? null : b.refs.secteurs.get(id);
      return Object.assign({ secteurId: id, nom: s ? s.nom : (id == null ? 'Sans secteur' : `#${id}`), chemin: id == null ? 'Sans secteur' : cheminSecteur(b.refs, id), couleur: s ? s.couleur || null : null, nbOt: x.ots.size }, montants(x));
    }).sort((x, y) => y.total - x.total || x.nom.localeCompare(y.nom, 'fr'));
    const parEquipementTous = Array.from(r.parEquipement.entries()).map(([id, x]) => {
      const e = b.refs.equipements.get(id);
      return Object.assign({ equipementId: id, numero: e ? e.numero || '' : '', nom: e ? e.nom : '(équipement supprimé)', secteurId: e && e.secteurId != null ? Number(e.secteurId) : null, nbOt: x.ots.size }, montants(x));
    }).sort((x, y) => y.total - x.total || x.nom.localeCompare(y.nom, 'fr'));
    const parMois = b.periode ? moisEntre(b.periode.du, b.periode.au).map((k) => Object.assign({ mois: k, libelle: libelleMois(k) }, montants(r.parMois.get(k)))) : [];
    const typesListe = listeTriee(b.cfg, 'typesIntervention');
    const parType = Array.from(r.parType.entries()).map(([code, x]) => {
      const it = typesListe.find((t) => t.code === code);
      return Object.assign({ code, label: it ? it.label : (code == null ? 'Non renseigné' : String(code)), couleur: it ? it.couleur || null : '#9ca3af', nbOt: x.ots.size }, montants(x));
    }).sort((x, y) => y.total - x.total);
    return Object.assign(montants(r.totaux), {
      nbOt: r.totaux.ots.size,
      tauxHoraire: b.periode ? b.periode.tauxHoraire : num((b.cfg.general || {}).tauxHoraire),
      parSecteur,
      parEquipement: parEquipementTous.slice(0, 10),
      parMois,
      parType,
    });
  }

  // ----- Fiabilité des équipements --------------------------------------------------------------------
  /**
   * Fenêtre d'observation d'un équipement (bornes en ms et durée en heures), commune à la synthèse et à la fiche de
   * vie : la période demandée, bornée par la mise en service et par l'instant présent ; sans période (fiche « toute
   * la durée de vie »), du premier OT connu (au plus tôt la mise en service, à défaut la création de la fiche) à
   * maintenant.
   */
  function fenetreObservation(b, e, premierOt) {
    const maintenant = Date.now();
    const ms = e ? horodatage(e.dateMiseEnService) : null;
    let debut; let fin = maintenant;
    if (b.periode) {
      debut = debutJour(b.periode.du);
      if (ms != null && ms > debut) debut = ms;
      fin = Math.min(finJour(b.periode.au), maintenant);
    } else debut = premierOt != null ? Math.max(premierOt, ms || 0) : (ms != null ? ms : (e ? horodatage(e.createdAt) : null));
    return { debut, fin, heures: debut != null && fin > debut ? (fin - debut) / 3600000 : 0 };
  }
  /** Fenêtre d'observation (h) d'un équipement sur la période de la synthèse. */
  function heuresObservees(b, e) { return b.periode ? fenetreObservation(b, e).heures : 0; }
  function sectionEquipements(b) {
    const { crees, termines } = selection(b);
    const r = imputations(b);
    const stats = new Map();
    const ligne = (id) => {
      id = Number(id);
      if (!stats.has(id)) stats.set(id, { equipementId: id, nbOt: 0, nbPannes: 0, nbReparations: 0, heuresArret: 0, durees: [] });
      return stats.get(id);
    };
    for (const o of crees) {
      if (o.equipementId == null) continue;
      const l = ligne(o.equipementId);
      l.nbOt++;
      if (estCorrectif(b, o) && !b.st.estAnnulation(o.statut)) l.nbPannes++;
    }
    for (const o of termines) {
      if (o.equipementId == null || !estCorrectif(b, o)) continue;
      const d = dureeOt(o);
      const l = ligne(o.equipementId);
      l.nbReparations++;
      if (d != null) { l.heuresArret += d; l.durees.push(d); }
    }
    for (const id of r.parEquipement.keys()) ligne(id);
    const disponibilite = Array.from(stats.values()).map((l) => {
      const e = b.refs.equipements.get(l.equipementId);
      const obs = heuresObservees(b, e);
      const fonctionnement = Math.max(0, obs - l.heuresArret);
      const c = montants(r.parEquipement.get(l.equipementId));
      return {
        equipementId: l.equipementId, numero: e ? e.numero || '' : '', nom: e ? e.nom : '(équipement supprimé)',
        secteurId: e && e.secteurId != null ? Number(e.secteurId) : null, secteurNom: e && e.secteurId != null ? cheminSecteur(b.refs, e.secteurId) : '',
        criticiteCode: e ? e.criticiteCode || null : null, etatCode: e ? e.etatCode || null : null,
        nbOt: l.nbOt, nbPannes: l.nbPannes, nbReparations: l.nbReparations,
        heuresArret: arrondi(l.heuresArret),
        mtbfJours: l.nbPannes > 0 ? arrondi(fonctionnement / l.nbPannes / 24, 1) : 0,
        mttrHeures: moyenne(l.durees),
        tauxDisponibilite: obs > 0 ? Math.min(100, arrondi((fonctionnement / obs) * 100, 1)) : (l.heuresArret > 0 ? 0 : 100),
        coutPieces: c.pieces, coutMainOeuvre: c.mainOeuvre, coutExterne: c.externe, cout: c.total,
      };
    }).sort((x, y) => y.nbPannes - x.nbPannes || y.heuresArret - x.heuresArret || y.cout - x.cout || x.nom.localeCompare(y.nom, 'fr'));
    const nbPannes = disponibilite.filter((x) => x.nbPannes > 0).slice(0, 10)
      .map((x) => ({ equipementId: x.equipementId, numero: x.numero, nom: x.nom, nbPannes: x.nbPannes, heuresArret: x.heuresArret }));
    return { totalPannes: disponibilite.reduce((s, x) => s + x.nbPannes, 0), nbPannes, disponibilite };
  }

  // ----- Demandes d'intervention -----------------------------------------------------------------------
  function codesDemande(cfg) {
    const s = ctx.services.demandes;
    let roles = null;
    if (s) { try { roles = s.STATUTS || null; } catch (e) { roles = null; } }
    if (roles && roles.refusee) return roles;
    const l = listeTriee(cfg, 'statutsDemande');
    const trouver = (code, re, final) => (l.some((x) => x.code === code) ? code : ((l.find((x) => !!x.final === final && re.test(`${x.code} ${x.label || ''}`)) || {}).code || code));
    return { soumise: trouver('soumise', /soumi|nouve/i, false), validee: trouver('validee', /valid|accept/i, false), refusee: trouver('refusee', /refus|rejet/i, true), convertie: trouver('convertie', /conver/i, false), cloturee: trouver('cloturee', /cl[oô]tur|termin/i, true) };
  }
  function sectionDemandes(b) {
    const listeStatuts = listeTriee(b.cfg, 'statutsDemande');
    const vide = { total: 0, parStatut: repartition(listeStatuts, [], 'statut'), delaiMoyenValidationHeures: 0, tauxRefus: 0, nbDecidees: 0, nbRefusees: 0, nbConverties: 0, nbArretProduction: 0 };
    if (!b.acces.demandes) return vide;
    const req = b.req;
    const subordonnes = req && req.user ? new Set(db.list('users', (u) => u.managerId != null && Number(u.managerId) === req.user.id).map((u) => u.id)) : new Set();
    const f = b.filtres;
    // Filtre technicien : demandes dont l'OT (lié par otId ou par demandeId) fait partie des OT filtrés
    const otIds = f.technicienId != null ? new Set(b.ots.map((o) => o.id)) : null;
    const otParDemande = f.technicienId != null ? new Map(b.ots.filter((o) => o.demandeId != null).map((o) => [Number(o.demandeId), o.id])) : null;
    const rows = Array.from(b.refs.demandes.values()).filter((d) => {
      if (!demandeVisible(req, d, subordonnes)) return false;
      if (f.secteurs && !(d.secteurId != null && f.secteurs.has(Number(d.secteurId)))) return false;
      if (f.sansSecteur && d.secteurId != null && d.secteurId !== '') return false;
      if (f.equipements && !(d.equipementId != null && f.equipements.has(Number(d.equipementId)))) return false;
      if (otIds && !(otIds.has(Number(d.otId)) || otParDemande.has(d.id))) return false;
      return b.enPeriode(jourDe(d.dateDemande || d.createdAt));
    });
    const codes = codesDemande(b.cfg);
    const decidees = rows.filter((d) => d.dateValidation);
    const delais = decidees.map((d) => heuresEntre(d.dateDemande || d.createdAt, d.dateValidation)).filter((x) => x != null);
    const refusees = rows.filter((d) => d.statut === codes.refusee);
    return {
      total: rows.length,
      parStatut: repartition(listeStatuts, rows, 'statut'),
      delaiMoyenValidationHeures: moyenne(delais),
      tauxRefus: pct(refusees.length, Math.max(decidees.length, refusees.length)),
      nbDecidees: decidees.length,
      nbRefusees: refusees.length,
      nbConverties: rows.filter((d) => d.otId != null).length,
      nbArretProduction: rows.filter((d) => !!d.arretProduction).length,
    };
  }

  // ----- Stock -------------------------------------------------------------------------------------------
  function sectionStock(b) {
    const vide = { valeur: 0, nbArticles: 0, nbSousSeuil: 0, nbMouvements: 0, nbSorties: 0, montantConsomme: 0, consommationTop10: [] };
    if (!b.acces.stock) return vide;
    const f = b.filtres;
    let articles = db.list('articles');
    if (b.req && b.req.perms) articles = ctx.scope(b.req, articles);
    const visibles = new Map(articles.map((a) => [a.id, a]));
    const duSecteur = f.secteurs ? articles.filter((a) => a.secteurId == null || a.secteurId === '' || f.secteurs.has(Number(a.secteurId))) : articles;
    const actifs = duSecteur.filter((a) => a.actif !== false);
    const filtreOt = !!(f.secteurs || f.sansSecteur || f.equipements || f.technicienId != null);
    const otIds = filtreOt ? new Set(b.ots.map((o) => o.id)) : null;
    const mouvements = db.list('mouvementsStock').filter((m) => visibles.has(Number(m.articleId)) && b.enPeriode(jourDe(m.date))
      && (!otIds || (m.otId != null && otIds.has(Number(m.otId)))));
    const conso = new Map();
    for (const m of mouvements) {
      const signe = m.type === 'sortie' ? 1 : (m.type === 'retour' ? -1 : 0);
      if (!signe) continue;
      const a = visibles.get(Number(m.articleId));
      const pu = m.prixUnitaire != null && m.prixUnitaire !== '' ? num(m.prixUnitaire) : num(a && a.prixUnitaire);
      const k = Number(m.articleId);
      if (!conso.has(k)) conso.set(k, { articleId: k, code: a ? a.code || '' : '', designation: a ? a.designation || '' : '(article supprimé)', uniteCode: a ? a.uniteCode || null : null, quantite: 0, montant: 0, nbSorties: 0 });
      const x = conso.get(k);
      x.quantite += signe * num(m.quantite);
      x.montant += signe * num(m.quantite) * pu;
      if (signe > 0) x.nbSorties++;
    }
    const lignes = Array.from(conso.values()).map((x) => Object.assign(x, { quantite: arrondi(x.quantite, 3), montant: arrondi(x.montant) })).filter((x) => x.quantite > 0 || x.montant > 0);
    return {
      valeur: arrondi(actifs.reduce((s, a) => s + Math.max(0, num(a.quantite)) * num(a.prixUnitaire), 0)),
      nbArticles: actifs.length,
      nbSousSeuil: actifs.filter((a) => num(a.quantite) <= num(a.seuilMin)).length,
      nbMouvements: mouvements.length,
      nbSorties: mouvements.filter((m) => m.type === 'sortie').length,
      montantConsomme: arrondi(lignes.reduce((s, x) => s + x.montant, 0)),
      consommationTop10: lignes.sort((x, y) => y.montant - x.montant || y.quantite - x.quantite).slice(0, 10),
    };
  }

  function descriptionFiltres(b) {
    const f = b.filtres;
    const e = f.equipementId != null ? b.refs.equipements.get(f.equipementId) : null;
    return {
      secteurId: f.secteurId, secteurNom: f.sansSecteur ? 'Sans secteur' : (f.secteurId != null ? cheminSecteur(b.refs, f.secteurId) : ''),
      equipementId: f.equipementId, equipementNom: e ? e.nom : '', sousEquipements: f.sousEquipements,
      technicienId: f.technicienId, technicienNom: f.technicienId != null ? nomDe(b.refs, f.technicienId) : '',
    };
  }

  /** Synthèse complète des indicateurs. */
  function synthese(req, q) {
    const b = preparer(req, q);
    return {
      periode: b.periode,
      filtres: descriptionFiltres(b),
      acces: b.acces,
      ot: sectionOt(b),
      demandes: sectionDemandes(b),
      couts: sectionCouts(b),
      stock: sectionStock(b),
      equipements: sectionEquipements(b),
      genereLe: new Date().toISOString(),
    };
  }

  // ----- Historique ------------------------------------------------------------------------------------
  function ligneHistorique(b, o) {
    const e = o.equipementId != null ? b.refs.equipements.get(Number(o.equipementId)) : null;
    const d = o.demandeId != null ? b.refs.demandes.get(Number(o.demandeId)) : null;
    const p = o.planPreventifId != null ? b.refs.plans.get(Number(o.planPreventifId)) : null;
    const f = o.fournisseurId != null ? b.refs.fournisseurs.get(Number(o.fournisseurId)) : null;
    const s = o.secteurId != null ? b.refs.secteurs.get(Number(o.secteurId)) : null;
    const coutPieces = arrondi(o.coutPieces), coutMainOeuvre = arrondi(o.coutMainOeuvre), coutExterne = arrondi(o.coutExterne);
    const duree = dureeOt(o);
    return {
      id: o.id, numero: o.numero || '', titre: o.titre || '',
      typeCode: o.typeCode || null, prioriteCode: o.prioriteCode || null, statut: o.statut, statutLibelle: b.st.libelle(o.statut),
      final: b.st.estFinal(o.statut), annule: b.st.estAnnulation(o.statut),
      equipementId: e ? e.id : (o.equipementId == null ? null : Number(o.equipementId)), equipementNumero: e ? e.numero || '' : '', equipementNom: e ? e.nom : '',
      secteurId: o.secteurId == null ? null : Number(o.secteurId), secteurNom: s ? s.nom : '', secteurChemin: cheminSecteur(b.refs, o.secteurId),
      technicienId: o.technicienId == null ? null : Number(o.technicienId), technicienNom: nomDe(b.refs, o.technicienId),
      intervenants: Array.from(participants(o)).map((id) => nomDe(b.refs, id)).filter(Boolean),
      dateCreation: o.createdAt || null, datePrevue: o.datePrevue || null, dateDebut: o.dateDebut || null, dateFin: finDe(o),
      dureeHeures: duree == null ? null : arrondi(duree), heures: arrondi(tempsOt(o)),
      coutPieces, coutMainOeuvre, coutExterne, coutTotal: arrondi(coutPieces + coutMainOeuvre + coutExterne),
      causeCode: o.causeCode || null, causeLibelle: libelleListe(b.cfg, 'causesPanne', o.causeCode),
      rapport: o.rapport || '',
      demandeId: d ? d.id : null, demandeNumero: d ? d.numero || '' : '',
      planPreventifId: p ? p.id : null, planNumero: p ? p.numero || '' : '',
      fournisseurNom: f ? f.nom || '' : '',
      preventif: estPreventif(b, o), correctif: estCorrectif(b, o),
      dansDelai: dansDelai(b, o),
    };
  }
  function exigerOt(b) {
    if (!b.acces.ot) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Voir (nécessaire pour l\'historique des interventions)');
  }
  /** OT clôturés (terminés ou annulés) dont la date de fin est dans la période, du plus récent au plus ancien. */
  function historique(req, q) {
    q = q || {};
    const b = preparer(req, q);
    exigerOt(b);
    let rows = b.ots.filter((o) => b.st.estFinal(o.statut) && b.enPeriode(jourDe(finDe(o) || o.updatedAt)));
    if (q.statut) rows = rows.filter((o) => o.statut === q.statut);
    if (q.typeCode) rows = rows.filter((o) => o.typeCode === q.typeCode);
    if (faux(q.annules)) rows = rows.filter((o) => !b.st.estAnnulation(o.statut));
    let lignes = rows.map((o) => ligneHistorique(b, o));
    // Recherche plein texte (tous les termes, sans tenir compte des accents ni de la casse)
    const termes = normaliser(String(q.recherche || '').slice(0, 200)).split(/\s+/).filter(Boolean);
    if (termes.length) {
      lignes = lignes.filter((l) => {
        const texte = normaliser([l.numero, l.titre, l.equipementNumero, l.equipementNom, l.secteurChemin, l.technicienNom, l.intervenants.join(' '), l.causeLibelle, l.rapport, l.demandeNumero, l.fournisseurNom, l.statutLibelle].join(' '));
        return termes.every((x) => texte.includes(x));
      });
    }
    return lignes.sort((x, y) => String(y.dateFin || '').localeCompare(String(x.dateFin || '')) || y.id - x.id);
  }

  // ----- Fiche de vie d'un équipement --------------------------------------------------------------------
  function ficheVie(req, id, q) {
    q = q || {};
    const equipementId = lireEntier(id, 'Équipement');
    const e = db.get('equipements', equipementId);
    if (!e || !equipementVisible(req, e)) throw new HttpError(404, 'Équipement introuvable');
    const avecPeriode = !!(q.du || q.au);
    const b = preparer(req, { du: q.du, au: q.au }, { periode: avecPeriode ? undefined : false });
    const inclure = q.sousEquipements === '1' || q.sousEquipements === 'true' || q.sousEquipements === true;
    const sous = descendantsEquipement(e.id);
    const ids = new Set([e.id].concat(inclure ? sous : []));
    const ots = b.ots.filter((o) => o.equipementId != null && ids.has(Number(o.equipementId)) && b.enPeriode(jourDe(dateRef(o))));
    const lignes = ots.map((o) => Object.assign(ligneHistorique(b, o), {
      date: dateRef(o),
      estPanne: estCorrectif(b, o) && !b.st.estAnnulation(o.statut),
      pieces: (o.pieces || []).map((p) => ({ designation: p.designation || '', code: p.code || '', quantite: num(p.quantite), uniteCode: p.uniteCode || null, montant: arrondi(num(p.quantite) * num(p.prixUnitaire)) })),
    })).sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || x.id - y.id);

    // Totaux cumulés
    const termines = ots.filter((o) => b.st.estTermine(o.statut));
    const pannes = ots.filter((o) => estCorrectif(b, o) && !b.st.estAnnulation(o.statut));
    const dureesCorr = termines.filter((o) => estCorrectif(b, o)).map(dureeOt).filter((x) => x != null);
    const heuresArret = dureesCorr.reduce((s, x) => s + x, 0);
    const somme = (k) => arrondi(lignes.reduce((s, l) => s + num(l[k]), 0));
    const maintenant = Date.now();
    // Fenêtre d'observation : la période demandée (même fenêtre que la synthèse) ; sans période, l'historique
    // réellement suivi, du premier OT enregistré (au plus tôt la mise en service) à maintenant
    const datesPassees = lignes.map((l) => l.dateCreation || l.date).filter((x) => x && horodatage(x) != null && horodatage(x) <= maintenant).sort();
    const realisations = termines.map((o) => finDe(o)).filter(Boolean).sort();
    const obs = fenetreObservation(b, e, horodatage(datesPassees[0])).heures;
    const coutTotal = somme('coutTotal');
    const valeurAchat = e.valeurAchat == null || e.valeurAchat === '' ? null : num(e.valeurAchat);
    const totaux = {
      nbOt: lignes.length,
      nbTermines: termines.length,
      nbOuverts: ots.filter((o) => !b.st.estFinal(o.statut)).length,
      nbAnnules: ots.filter((o) => b.st.estAnnulation(o.statut)).length,
      nbPannes: pannes.length,
      nbPreventifs: ots.filter((o) => estPreventif(b, o)).length,
      heures: somme('heures'),
      heuresArret: arrondi(heuresArret),
      coutPieces: somme('coutPieces'), coutMainOeuvre: somme('coutMainOeuvre'), coutExterne: somme('coutExterne'), coutTotal,
      mttrHeures: moyenne(dureesCorr),
      mtbfJours: pannes.length > 0 ? arrondi(Math.max(0, obs - heuresArret) / pannes.length / 24, 1) : 0,
      joursObserves: arrondi(obs / 24, 1),
      premiereIntervention: realisations[0] || null, derniereIntervention: realisations[realisations.length - 1] || null,
      valeurAchat, ratioCoutValeur: valeurAchat > 0 ? pct(coutTotal, valeurAchat) : 0,
    };
    const parAnneeMap = new Map();
    for (const l of lignes) {
      const a = jourDe(l.date).slice(0, 4) || '—';
      if (!parAnneeMap.has(a)) parAnneeMap.set(a, { annee: a, nbOt: 0, nbPannes: 0, heures: 0, coutTotal: 0 });
      const x = parAnneeMap.get(a);
      x.nbOt++; if (l.estPanne) x.nbPannes++; x.heures += num(l.heures); x.coutTotal += num(l.coutTotal);
    }
    const parAnnee = Array.from(parAnneeMap.values()).map((x) => Object.assign(x, { heures: arrondi(x.heures), coutTotal: arrondi(x.coutTotal) })).sort((x, y) => x.annee.localeCompare(y.annee));
    const causes = listeTriee(b.cfg, 'causesPanne');
    const parCause = repartition(causes, pannes, 'causeCode').filter((x) => x.nb > 0).sort((x, y) => y.nb - x.nb);

    const sEq = ctx.services.equipements;
    let chemin = '';
    if (sEq && typeof sEq.chemin === 'function') { try { chemin = sEq.chemin(e.id) || ''; } catch (err) { chemin = ''; } }
    const parent = e.parentId != null ? b.refs.equipements.get(Number(e.parentId)) : null;
    const fournisseur = e.fournisseurId != null ? b.refs.fournisseurs.get(Number(e.fournisseurId)) : null;
    const sPrev = ctx.services.preventif;
    const unite = e.compteur && e.compteur.unite ? e.compteur.unite : '';
    const plans = b.acces.preventif ? db.list('plansPreventifs', (p) => p.equipementId != null && ids.has(Number(p.equipementId))).map((p) => {
      let etat = null; let periodicite = '';
      if (sPrev) {
        try { if (typeof sPrev.etat === 'function') etat = sPrev.etat(p); } catch (err) { etat = null; }
        try { if (typeof sPrev.periodiciteLibelle === 'function') periodicite = sPrev.periodiciteLibelle(p.periodicite, unite) || ''; } catch (err) { periodicite = ''; }
      }
      if (!periodicite && p.periodicite) periodicite = `${p.periodicite.valeur || ''} ${p.periodicite.type === 'compteur' ? unite : p.periodicite.type || ''}`.trim();
      return { id: p.id, numero: p.numero || '', nom: p.nom || '', typeCode: p.typeCode || null, periodicite: p.periodicite || null, periodiciteLibelle: periodicite, derniereExecution: p.derniereExecution == null ? null : p.derniereExecution, prochaineEcheance: p.prochaineEcheance == null ? null : p.prochaineEcheance, actif: p.actif !== false, etat, technicienNom: nomDe(b.refs, p.technicienId) };
    }).sort((x, y) => String(x.numero).localeCompare(String(y.numero), 'fr', { numeric: true })) : [];

    return {
      equipement: {
        id: e.id, numero: e.numero || '', nom: e.nom || '', description: e.description || '',
        typeCode: e.typeCode || null, etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null,
        secteurId: e.secteurId == null ? null : Number(e.secteurId), secteurChemin: cheminSecteur(b.refs, e.secteurId), chemin,
        localisation: e.localisation || '', marque: e.marque || '', modele: e.modele || '', numeroSerie: e.numeroSerie || '',
        dateMiseEnService: e.dateMiseEnService || null, dateAchat: e.dateAchat || null, valeurAchat, garantieFin: e.garantieFin || null,
        compteur: e.compteur || null, actif: e.actif !== false, fournisseurNom: fournisseur ? fournisseur.nom || '' : '',
        parent: parent ? { id: parent.id, numero: parent.numero || '', nom: parent.nom } : null,
        sousEquipements: sous.map((x) => b.refs.equipements.get(x)).filter(Boolean).map((x) => ({ id: x.id, numero: x.numero || '', nom: x.nom })),
      },
      periode: b.periode,
      sousEquipementsInclus: inclure,
      acces: b.acces,
      ot: lignes,
      totaux,
      parAnnee,
      parCause,
      compteur: {
        valeur: e.compteur ? num(e.compteur.valeur) : null, unite,
        releves: (e.compteurReleves || []).slice().sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 20).map((r) => ({ date: r.date, valeur: num(r.valeur), userNom: nomDe(b.refs, r.userId), commentaire: r.commentaire || '' })),
      },
      etats: (e.historiqueEtats || []).slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).map((h) => ({ date: h.date, ancien: h.ancien || null, nouveau: h.nouveau || null, commentaire: h.commentaire || '', userNom: nomDe(b.refs, h.userId) })),
      plans,
    };
  }

  /** Listes de choix de la vue (équipements visibles, techniciens présents dans les OT visibles). */
  function referencesVue(req) {
    const refs = references();
    const droits = acces(req);
    const equipements = Array.from(refs.equipements.values()).filter((e) => equipementVisible(req, e))
      .map((e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || '', secteurId: e.secteurId == null ? null : Number(e.secteurId), parentId: e.parentId == null ? null : Number(e.parentId), actif: e.actif !== false }))
      .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
    const ids = new Set();
    if (droits.ot) for (const o of db.list('ot')) if (otVisible(req, o)) for (const uid of participants(o)) ids.add(uid);
    const techniciens = Array.from(ids).map((id) => ({ id, nom: nomDe(refs, id), actif: (refs.users.get(id) || {}).actif !== false }))
      .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
    return { equipements, techniciens, acces: droits };
  }

  // ----- Exports CSV ---------------------------------------------------------------------------------------
  function formatDate(cfg, v, avecHeure) {
    if (!v) return '';
    const fmt = ((cfg.general || {}).formatDate) || 'dd/MM/yyyy';
    let d;
    if (RE_DATE.test(String(v))) { const [y, m, j] = String(v).split('-').map(Number); d = new Date(y, m - 1, j); avecHeure = false; } else d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const date = fmt.replace('dd', pad(d.getDate())).replace('MM', pad(d.getMonth() + 1)).replace('yyyy', d.getFullYear());
    return avecHeure ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
  }
  function contenuExport(req, type, q) {
    const cfg = ctx.config();
    const lib = (l, c) => libelleListe(cfg, l, c);
    const oui = (v) => (v === true ? 'Oui' : v === false ? 'Non' : '');
    // Les exports qui reprennent le détail des modules sources (numéros, techniciens, coûts, comptes rendus des OT ;
    // articles consommés) exigent leur droit « exporter », comme /api/ot-export ; seule la synthèse agrégée n'en a pas besoin
    if (['historique', 'fiche', 'equipements', 'techniciens', 'couts'].includes(type)) ctx.requirePerm(req, 'ot', 'exporter');
    if (type === 'stock') ctx.requirePerm(req, 'stock', 'exporter');
    if (type === 'historique') {
      const rows = historique(req, q);
      return {
        entetes: ['Numéro', 'Titre', 'Type', 'Priorité', 'Statut', 'Équipement (n°)', 'Équipement', 'Secteur', 'Technicien responsable', 'Intervenants', 'Créé le', 'Début', 'Fin', 'Durée (h)', 'Temps passé (h)', 'Coût pièces', 'Coût main d\'œuvre', 'Coût externe', 'Coût total', 'Cause', 'Dans le délai', 'Demande', 'Plan préventif', 'Prestataire', 'Compte rendu'],
        lignes: rows.map((o) => [o.numero, o.titre, lib('typesIntervention', o.typeCode), lib('priorites', o.prioriteCode), o.statutLibelle, o.equipementNumero, o.equipementNom, o.secteurChemin, o.technicienNom, o.intervenants.join(', '),
          formatDate(cfg, o.dateCreation, true), formatDate(cfg, o.dateDebut, true), formatDate(cfg, o.dateFin, true), csvNombre(o.dureeHeures), csvNombre(o.heures), csvNombre(o.coutPieces), csvNombre(o.coutMainOeuvre), csvNombre(o.coutExterne), csvNombre(o.coutTotal),
          o.causeLibelle, oui(o.dansDelai), o.demandeNumero, o.planNumero, o.fournisseurNom, o.rapport]),
      };
    }
    if (type === 'fiche') {
      if (!q.equipementId) throw new HttpError(400, 'L\'équipement est obligatoire pour exporter une fiche de vie');
      const f = ficheVie(req, q.equipementId, { du: q.du, au: q.au, sousEquipements: q.sousEquipements });
      if (!f.acces.ot) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Voir');
      return {
        suffixe: f.equipement.numero || String(f.equipement.id),
        entetes: ['Date', 'Numéro', 'Titre', 'Équipement', 'Type', 'Statut', 'Panne', 'Cause', 'Technicien', 'Durée (h)', 'Temps passé (h)', 'Coût pièces', 'Coût main d\'œuvre', 'Coût externe', 'Coût total', 'Pièces', 'Compte rendu'],
        lignes: f.ot.map((o) => [formatDate(cfg, o.date, true), o.numero, o.titre, o.equipementNom, lib('typesIntervention', o.typeCode), o.statutLibelle, o.estPanne ? 'Oui' : 'Non', o.causeLibelle, o.technicienNom, csvNombre(o.dureeHeures), csvNombre(o.heures),
          csvNombre(o.coutPieces), csvNombre(o.coutMainOeuvre), csvNombre(o.coutExterne), csvNombre(o.coutTotal), o.pieces.map((p) => `${csvNombre(p.quantite, 3)} × ${p.designation}`).join(' ; '), o.rapport]),
      };
    }
    const s = synthese(req, q);
    if (type === 'equipements') {
      if (!s.acces.ot) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Voir');
      return {
        entetes: ['Numéro', 'Équipement', 'Secteur', 'Criticité', 'OT (créés)', 'Pannes', 'Réparations terminées', 'Heures d\'arrêt', 'MTBF (jours)', 'MTTR (h)', 'Disponibilité (%)', 'Coût pièces', 'Coût main d\'œuvre', 'Coût externe', 'Coût total'],
        lignes: s.equipements.disponibilite.map((x) => [x.numero, x.nom, x.secteurNom, lib('criticites', x.criticiteCode), x.nbOt, x.nbPannes, x.nbReparations, csvNombre(x.heuresArret), x.nbPannes ? csvNombre(x.mtbfJours, 1) : '', x.nbReparations ? csvNombre(x.mttrHeures) : '', csvNombre(x.tauxDisponibilite, 1), csvNombre(x.coutPieces), csvNombre(x.coutMainOeuvre), csvNombre(x.coutExterne), csvNombre(x.cout)]),
      };
    }
    if (type === 'techniciens') {
      if (!s.acces.ot) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Voir');
      return {
        entetes: ['Technicien', 'OT réalisés', 'OT affectés (créés dans la période)', 'Heures saisies', 'Heures ouvrées', 'Taux d\'occupation (%)'],
        lignes: s.ot.parTechnicien.map((t) => [t.nom, t.nb, t.nbAffectes, csvNombre(t.heures), csvNombre(t.heuresOuvrees), csvNombre(t.tauxOccupation, 1)]),
      };
    }
    if (type === 'couts') {
      if (!s.acces.ot) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Voir');
      const l = (axe, libelle, x) => [axe, libelle, x.nbOt == null ? '' : x.nbOt, csvNombre(x.pieces), csvNombre(x.mainOeuvre), csvNombre(x.externe), csvNombre(x.total)];
      return {
        entetes: ['Ventilation', 'Libellé', 'Nombre d\'OT', 'Pièces', 'Main d\'œuvre', 'Externe', 'Total'],
        lignes: [l('Total', 'Période', s.couts)]
          .concat(s.couts.parMois.map((m) => l('Mois', m.libelle, Object.assign({ nbOt: '' }, m))))
          .concat(s.couts.parSecteur.map((x) => l('Secteur', x.chemin, x)))
          .concat(s.couts.parEquipement.map((x) => l('Équipement (top 10)', [x.numero, x.nom].filter(Boolean).join(' — '), x)))
          .concat(s.couts.parType.map((x) => l('Type d\'intervention', x.label, x))),
      };
    }
    if (type === 'stock') {
      if (!s.acces.stock) throw new HttpError(403, 'Droit insuffisant : Stock & pièces › Voir');
      return {
        entetes: ['Code', 'Désignation', 'Unité', 'Quantité consommée', 'Nombre de sorties', 'Montant'],
        lignes: s.stock.consommationTop10.map((x) => [x.code, x.designation, lib('unites', x.uniteCode), csvNombre(x.quantite, 3), x.nbSorties, csvNombre(x.montant)]),
      };
    }
    // Synthèse : un indicateur par ligne
    const L = [];
    const add = (rubrique, indicateur, valeur) => L.push([rubrique, indicateur, valeur]);
    add('Période', 'Du', formatDate(cfg, s.periode.du)); add('Période', 'Au', formatDate(cfg, s.periode.au));
    add('Période', 'Jours ouvrés', s.periode.joursOuvres); add('Période', 'Heures ouvrées par technicien', csvNombre(s.periode.heuresOuvrees));
    if (s.filtres.secteurNom) add('Filtres', 'Secteur', s.filtres.secteurNom);
    if (s.filtres.equipementNom) add('Filtres', 'Équipement', s.filtres.equipementNom);
    if (s.filtres.technicienNom) add('Filtres', 'Technicien', s.filtres.technicienNom);
    if (s.acces.ot) {
      add('Ordres de travail', 'OT créés', s.ot.total); add('Ordres de travail', 'OT terminés', s.ot.termines); add('Ordres de travail', 'OT annulés', s.ot.annules);
      add('Ordres de travail', 'OT ouverts (créés dans la période)', s.ot.ouverts); add('Ordres de travail', 'OT non clôturés (toutes dates)', s.ot.backlog);
      add('Ordres de travail', 'Taux de préventif (%)', csvNombre(s.ot.tauxPreventif, 1)); add('Ordres de travail', 'Respect des délais (%)', csvNombre(s.ot.respectDelais, 1));
      add('Ordres de travail', 'MTTR (h)', csvNombre(s.ot.mttrHeures)); add('Ordres de travail', 'Durée moyenne (h)', csvNombre(s.ot.dureeMoyenneHeures)); add('Ordres de travail', 'Heures saisies', csvNombre(s.ot.heuresTotal));
      for (const x of s.ot.parStatut) add('OT par statut', x.label, x.nb);
      for (const x of s.ot.parType) add('OT par type', x.label, x.nb);
      for (const x of s.ot.parPriorite) add('OT par priorité', x.label, x.nb);
      for (const x of s.ot.parSecteur) add('OT par secteur', x.chemin, x.nb);
      add('Coûts', 'Pièces', csvNombre(s.couts.pieces)); add('Coûts', 'Main d\'œuvre', csvNombre(s.couts.mainOeuvre)); add('Coûts', 'Externe', csvNombre(s.couts.externe)); add('Coûts', 'Total', csvNombre(s.couts.total));
      add('Équipements', 'Pannes', s.equipements.totalPannes);
    }
    if (s.acces.demandes) {
      add('Demandes', 'Demandes déposées', s.demandes.total); add('Demandes', 'Délai moyen de validation (h)', csvNombre(s.demandes.delaiMoyenValidationHeures));
      add('Demandes', 'Taux de refus (%)', csvNombre(s.demandes.tauxRefus, 1)); add('Demandes', 'Converties en OT', s.demandes.nbConverties);
    }
    if (s.acces.stock) {
      add('Stock', 'Valeur du stock', csvNombre(s.stock.valeur)); add('Stock', 'Mouvements', s.stock.nbMouvements); add('Stock', 'Montant consommé', csvNombre(s.stock.montantConsomme));
    }
    return { entetes: ['Rubrique', 'Indicateur', 'Valeur'], lignes: L };
  }

  // ----- Routes -------------------------------------------------------------------------------------------
  router.get('/api/rapports/synthese', async (req) => synthese(req, req.query), { perm: [MODULE, 'voir'] });
  router.get('/api/rapports/historique', async (req) => historique(req, req.query), { perm: [MODULE, 'voir'] });
  router.get('/api/rapports/equipement/:id', async (req) => ficheVie(req, req.params.id, req.query), { perm: [MODULE, 'voir'] });
  router.get('/api/rapports/references', async (req) => referencesVue(req), { perm: [MODULE, 'voir'] });
  router.get('/api/rapports/export', async (req, res) => {
    const q = req.query || {};
    const type = String(q.type || '');
    if (!TYPES_EXPORT[type]) throw new HttpError(400, `Type d'export inconnu : « ${type || '(vide)'} » (attendu : ${Object.keys(TYPES_EXPORT).join(', ')})`);
    const { entetes, lignes, suffixe } = contenuExport(req, type, q);
    const cfg = ctx.config();
    const p = (type === 'fiche' && !(q.du || q.au)) ? null : lirePeriode(q, cfg);
    const out = ['\uFEFF' + entetes.map(csvEscape).join(';')];
    for (const l of lignes) out.push(l.map(csvEscape).join(';'));
    const nomFichier = `rapport-${type}${suffixe ? '-' + String(suffixe).replace(/[^\w.-]+/g, '_') : ''}${p ? `-${p.du}-au-${p.au}` : ''}.csv`;
    ctx.audit(req, 'export', MODULE, null, `Export CSV « ${TYPES_EXPORT[type]} » : ${lignes.length} ligne(s)${p ? ` — période du ${formatDate(cfg, p.du)} au ${formatDate(cfg, p.au)}` : ''}`);
    ctx.emit('rapports:export', { type, userId: req.user.id, lignes: lignes.length, du: p ? p.du : null, au: p ? p.au : null });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nomFichier}"`, 'Cache-Control': 'no-store' });
    res.end(out.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  // ----- Services publiés ----------------------------------------------------------------------------------
  ctx.services.rapports = {
    /** Synthèse des indicateurs ({ du, au, secteurId, equipementId, technicienId }) ; req null = sans restriction. */
    synthese: (req, query) => synthese(req || null, query || {}),
    /** Historique des OT clôturés de la période. */
    historique: (req, query) => historique(req || null, query || {}),
    /** Fiche de vie d'un équipement. */
    ficheVie: (req, equipementId, query) => ficheVie(req || null, equipementId, query || {}),
    /** Période normalisée (du / au validés, jours ouvrés, heures ouvrées). */
    periode: (query) => lirePeriode(query || {}),
    /** Listes de choix (équipements, techniciens) selon la portée. */
    references: (req) => referencesVue(req || null),
    calculerCouts: (o) => calculerCouts(o, num((ctx.config().general || {}).tauxHoraire)),
  };
}

// ----- Données de démonstration : reprise de 12 mois d'historique ------------------------------------------
let seedEnCours = false;
const TEMOIN = 'Déclenchement du compresseur GA 37 sur température de refoulement élevée';

/**
 * Interventions archivées (reprise de l'historique de l'ancienne GMAO) sur les 12 derniers mois, antérieures aux
 * OT de démonstration du module OT. j = début de l'intervention (jours avant aujourd'hui), hd = heure de début,
 * av = anticipation de la création (jours, interventions planifiées), dem = délai création → début (h, correctifs),
 * dur = durée début → fin (h), temps = [[login, heures, décalage en jours]], pieces = [[motif article, désignation, quantité, prix]].
 */
function definitionsArchives() {
  const GA = 'Compresseur d\'air GA 37';
  const RAPPORTS_GA = [
    'Gamme mensuelle réalisée sans anomalie. Pression de service 7,1 bar, température de refoulement 81 °C, purgeur fonctionnel.',
    'Gamme réalisée. Préfiltre d\'aspiration nettoyé, appoint d\'huile de 0,5 L. Paramètres nominaux.',
    'Gamme réalisée et cartouche filtre à air remplacée (perte de charge élevée). Température de refoulement 83 °C.',
    'Gamme réalisée. Léger bruit au démarrage du ventilateur : roulements à surveiller lors de la prochaine visite.',
    'Gamme réalisée sans anomalie. Relevé : 7,0 bar, 79 °C. Raccords et flexibles en bon état.',
  ];
  const defs = [];
  [355, 325, 295, 265, 235, 205, 175, 145, 115, 88].forEach((j, i) => defs.push({
    eq: GA, j, hd: '13:30', av: 3, type: 'preventif', prio: 'normale', titre: 'Visite préventive mensuelle du compresseur GA 37', desc: 'Gamme mensuelle constructeur Atlas Copco.',
    dur: 2.25, tech: 'kleroy', crea: 'mdupont', pieces: i % 3 === 2 ? [[/filtre.*air.*GA ?37|cartouche filtre/i, 'Cartouche filtre à air compresseur GA 37', 1, 89]] : [], rapport: RAPPORTS_GA[i % RAPPORTS_GA.length],
  }));
  [320, 290, 260, 230, 200, 140, 110].forEach((j, i) => defs.push({
    eq: 'Remplisseuse rotative', j, hd: '06:00', av: 4, type: 'preventif', prio: 'normale', titre: 'Graissage mensuel de la remplisseuse rotative', desc: 'Graissage des paliers de la tourelle, des cames de levage et de la couronne d\'entraînement.',
    dur: 1, tech: 'jbernard', crea: 'mdupont', pieces: [[/graisse/i, 'Graisse lithium Multis EP 2 (cartouche 400 g)', 2, 6.4]],
    rapport: i === 4 ? 'Graissage réalisé. Jeu anormal constaté sur la came de levage n°7 : OT correctif à prévoir lors du prochain arrêt.' : 'Graissage réalisé selon la gamme, aucune anomalie constatée.',
  }));
  [350, 260, 170].forEach((j) => defs.push({
    eq: 'CTA atelier conditionnement', j, hd: '10:00', av: 5, type: 'preventif', prio: 'basse', titre: 'Remplacement des filtres F7 de la CTA atelier conditionnement', desc: 'Remplacement trimestriel des filtres F7.',
    dur: 1.5, tech: 'kleroy', crea: 'mdupont', pieces: [[/filtre.*F7/i, 'Filtre plissé F7 592 × 592 × 534 mm', 4, 42.5]],
    rapport: 'Filtres F7 remplacés (perte de charge avant : 265 Pa, après : 95 Pa). Caisson et glissières nettoyés.',
  }));
  defs.push(
    // Services généraux
    { eq: GA, j: 272, hd: '06:40', dem: 0.5, dur: 3.5, type: 'correctif', prio: 'urgente', titre: TEMOIN, cause: 'usure', tech: 'kleroy', crea: 'kleroy', di: { par: 'kleroy', valid: 0.2 },
      desc: 'Arrêt du compresseur en défaut « température de refoulement > 110 °C », réseau d\'air en chute de pression.',
      rapport: 'Radiateur huile / air fortement encrassé (poussières de carton). Nettoyage à l\'air comprimé et au dégraissant, contrôle du ventilateur. Température de refoulement revenue à 84 °C en charge.' },
    { eq: GA, j: 168, hd: '10:15', dem: 2, dur: 4, type: 'correctif', prio: 'haute', titre: 'Fuite d\'huile au joint du couvercle du séparateur du GA 37', cause: 'usure', tech: 'kleroy', crea: 'kleroy',
      desc: 'Suintement d\'huile important sous le réservoir séparateur, flaque au sol.', pieces: [[null, 'Joint de couvercle de réservoir séparateur', 1, 34]],
      rapport: 'Joint de couvercle du séparateur durci et fissuré : remplacé. Serrage au couple, essai en charge sans fuite. Absorbant au sol évacué en DIB.' },
    { eq: 'Groupe froid industriel', j: 330, hd: '09:00', av: 7, dur: 3, type: 'reglementaire', prio: 'normale', titre: 'Contrôle d\'étanchéité annuel du groupe froid (fluide R410A)', tech: 'kleroy', crea: 'mdupont', temps: [['kleroy', 2]], ext: 380, four: /trane/i,
      desc: 'Contrôle périodique obligatoire des équipements contenant des fluides frigorigènes.', rapport: 'Contrôle réalisé avec le frigoriste Trane : aucune fuite détectée (détecteur électronique). Charge 18,5 kg de R410A. Registre des fluides mis à jour.' },
    { eq: 'Groupe froid industriel', j: 246, hd: '14:20', dem: 0.75, dur: 2.5, type: 'correctif', prio: 'urgente', titre: 'Défaut haute pression sur le circuit 2 du groupe froid', cause: 'reglage', tech: 'kleroy', crea: 'kleroy',
      desc: 'Circuit 2 en sécurité HP, température d\'eau glacée en hausse sur la ligne de conditionnement.', rapport: 'Pressostat HP du circuit 2 déréglé (déclenchement à 38 bar au lieu de 41,5 bar). Recalage et essais de déclenchement. Batterie du condenseur nettoyée par précaution.' },
    { eq: 'Groupe froid industriel', j: 128, hd: '08:10', dem: 3, dur: 5.5, type: 'correctif', prio: 'haute', titre: 'Remplacement du moteur du ventilateur n°3 du condenseur', cause: 'casse', tech: 'kleroy', crea: 'kleroy', temps: [['kleroy', 5.5]],
      desc: 'Ventilateur n°3 bloqué, bruit de frottement puis disjonction.', pieces: [[null, 'Moteur de ventilateur EC Ø 800 mm', 1, 640]],
      rapport: 'Roulements du moteur grippés, bobinage brûlé. Moteur EC remplacé, câblage et sens de rotation contrôlés. Intensité nominale 2,1 A.' },
    { eq: 'CTA atelier conditionnement', j: 214, hd: '07:30', dem: 1.5, dur: 2, type: 'correctif', prio: 'haute', titre: 'Courroie du ventilateur de soufflage cassée sur la CTA', cause: 'casse', tech: 'kleroy', crea: 'mdupont', di: { par: 'kleroy', valid: 0.8 },
      desc: 'Plus de soufflage dans l\'atelier conditionnement, température en hausse.', pieces: [[null, 'Courroie trapézoïdale SPA 1250', 2, 18.6]],
      rapport: 'Courroies SPA du ventilateur de soufflage remplacées (jeu de 2), tension réglée, alignement des poulies contrôlé. Débit d\'air nominal rétabli.' },
    // Ligne 1 — conditionnement
    { eq: 'Remplisseuse rotative', j: 341, hd: '05:50', dem: 0.5, dur: 3, type: 'correctif', prio: 'haute', titre: 'Fuite de produit sur les becs de remplissage 12 à 15', cause: 'usure', tech: 'jbernard', crea: 'pmartin', di: { par: 'spetit', valid: 0.4 },
      desc: 'Égouttures sur les bouteilles et niveaux de remplissage irréguliers sur 4 becs.', pieces: [[null, 'Jeu de joints de bec de remplissage', 4, 27]],
      rapport: 'Joints de becs 12 à 15 usés (45 millions de cycles). Remplacement, contrôle des niveaux de remplissage sur 60 bouteilles : conforme.' },
    { eq: 'Remplisseuse rotative', j: 236, hd: '09:40', dem: 0.3, dur: 6.5, type: 'correctif', prio: 'urgente', titre: 'Défaut du variateur du moteur principal de la remplisseuse', cause: 'electrique', tech: 'kleroy', aussi: ['jbernard'], crea: 'pmartin', temps: [['kleroy', 6.5], ['jbernard', 2]], ext: 1250, four: /schneider/i, di: { par: 'pmartin', valid: 0.1 },
      desc: 'Remplisseuse à l\'arrêt, variateur en défaut OCF au redémarrage.', rapport: 'Variateur ATV 630 en défaut OCF (surintensité) : carte de puissance HS, échange standard par le technicien Schneider Electric. Paramètres rechargés, essais satisfaisants. 6 h 30 d\'arrêt de la ligne 1.' },
    { eq: 'Remplisseuse rotative', j: 181, hd: '13:05', dem: 2, dur: 1.5, type: 'correctif', prio: 'normale', titre: 'Bourrages récurrents sur l\'étoile d\'entrée de la remplisseuse', cause: 'reglage', tech: 'jbernard', crea: 'pmartin',
      desc: 'Une dizaine de bourrages par poste sur l\'étoile d\'entrée depuis le changement de format.', rapport: 'Guide d\'entrée décalé de 4 mm après le changement de format. Réglage du guide et de la vis sans fin, repères de format refaits. Aucun bourrage sur le poste suivant.' },
    { eq: 'Remplisseuse rotative', j: 103, hd: '22:15', dem: 0.5, dur: 1, type: 'correctif', prio: 'haute', titre: 'Capteur de présence bouteille cassé sur l\'étoile de sortie', cause: 'casse', tech: 'jbernard', crea: 'pmartin', di: { par: 'spetit', valid: 0.3 },
      desc: 'Arrêts intempestifs « absence bouteille » en sortie de remplisseuse.', pieces: [[/capteur inductif/i, 'Capteur inductif M18 PNP 8 mm', 1, 58.9]],
      rapport: 'Capteur inductif cassé par un éclat de verre. Remplacement et réglage de la distance de détection, ajout d\'une tôle de protection.' },
    { eq: 'Étiqueteuse', j: 305, hd: '11:20', dem: 1, dur: 2, type: 'correctif', prio: 'normale', titre: 'Décollement des étiquettes : défaut d\'encollage', cause: 'reglage', tech: 'jbernard', crea: 'pmartin', di: { par: 'spetit', valid: 1.5 },
      desc: 'Étiquettes qui se décollent au fardelage, réclamation du contrôle qualité.', rapport: 'Rouleau encolleur encrassé et température de colle trop basse (128 °C au lieu de 145 °C). Nettoyage du groupe d\'encollage et correction de la consigne.' },
    { eq: 'Étiqueteuse', j: 198, hd: '08:00', av: 4, dur: 3, type: 'correctif', prio: 'normale', titre: 'Remplacement du rouleau presseur de l\'étiqueteuse', cause: 'usure', tech: 'jbernard', crea: 'mdupont',
      desc: 'Rouleau presseur fendu, plis sur les étiquettes.', pieces: [[null, 'Rouleau presseur caoutchouc Ø 60 mm', 1, 185]],
      rapport: 'Rouleau presseur remplacé lors de l\'arrêt hebdomadaire, pression d\'application réglée à 2,5 bar. Qualité de pose conforme.' },
    { eq: 'Étiqueteuse', j: 92, hd: '15:40', dem: 0.5, dur: 1.25, type: 'correctif', prio: 'haute', titre: 'Défaut de la cellule de détection des étiquettes', cause: 'electrique', tech: 'jbernard', crea: 'pmartin',
      desc: 'Étiquettes doublées ou manquantes de façon aléatoire.', rapport: 'Connecteur M12 de la cellule oxydé (projections lors du lavage). Connecteur remplacé et protégé, cellule réapprise sur le nouveau support d\'étiquettes.' },
    { eq: 'Fardeleuse', j: 282, hd: '04:30', dem: 1.5, dur: 2, type: 'correctif', prio: 'haute', titre: 'Soudure du film rétractable défectueuse sur la fardeleuse', cause: 'reglage', tech: 'jbernard', crea: 'pmartin', di: { par: 'spetit', valid: 0.5 },
      desc: 'Fardeaux qui s\'ouvrent en bout de ligne, film mal soudé.', rapport: 'Temporisation de soudure et température de la barre de soudure déréglées. Réglages restaurés (185 °C / 0,6 s), téflon de la barre remplacé.' },
    { eq: 'Fardeleuse', j: 158, hd: '10:00', dem: 3, dur: 1.5, type: 'correctif', prio: 'normale', titre: 'Remplacement du couteau de coupe du film de la fardeleuse', cause: 'usure', tech: 'jbernard', crea: 'pmartin',
      desc: 'Coupe du film irrégulière, effilochage.', pieces: [[null, 'Couteau de coupe film dentelé 620 mm', 1, 96]], rapport: 'Couteau émoussé remplacé, contre-lame contrôlée. Coupe franche sur 50 cycles d\'essai.' },
    { eq: 'Fardeleuse', j: 95, hd: '14:00', dem: 0.5, dur: 1.5, type: 'correctif', prio: 'urgente', titre: 'Contacteur du four de rétraction collé', cause: 'electrique', tech: 'kleroy', crea: 'pmartin',
      desc: 'Four de rétraction qui ne coupe plus en fin de cycle, surchauffe du film.', pieces: [[/contacteur tesys/i, 'Contacteur TeSys D 18 A — bobine 24 V CC', 1, 72.3]],
      rapport: 'Contacteur de puissance du four collé (contacts soudés). Remplacement, contrôle des intensités des résistances et du thermostat de sécurité.' },
    { eq: 'Convoyeur de sortie ligne 1', j: 228, hd: '09:00', dem: 4, dur: 4, type: 'correctif', prio: 'normale', titre: 'Motoréducteur du convoyeur de sortie bruyant', cause: 'usure', tech: 'jbernard', crea: 'pmartin',
      desc: 'Bruit de roulement en hausse sur le motoréducteur de tête.', pieces: [[/6205/i, 'Roulement à billes 6205-2RS', 2, 8.9]], rapport: 'Roulements de l\'arbre de sortie remplacés, vidange du réducteur. Niveau vibratoire revenu à 1,8 mm/s.' },
    { eq: 'Convoyeur de sortie ligne 1', j: 133, hd: '16:30', dem: 0.5, dur: 1, type: 'correctif', prio: 'haute', titre: 'Déraillement de la bande du convoyeur de sortie', cause: 'reglage', tech: 'jbernard', crea: 'pmartin',
      desc: 'Bande décentrée qui frotte sur le châssis côté opérateur.', rapport: 'Rouleau de renvoi désaligné : réglage du centrage de la bande et serrage des paliers. Bande recentrée sur toute la longueur.' },
    { eq: 'Convoyeur de sortie ligne 1', j: 206, hd: '10:10', dem: 1, type: 'correctif', prio: 'basse', titre: 'Bruit anormal sur le convoyeur de sortie', tech: 'jbernard', crea: 'pmartin',
      desc: 'Claquement régulier signalé par l\'opérateur.', annule: 'Bruit provenant d\'une palette mal positionnée en bout de convoyeur : aucun défaut constaté, intervention sans objet.' },
    { eq: 'Ligne de conditionnement L1', j: 243, hd: '07:30', av: 20, dur: 7, type: 'amelioration', prio: 'normale', titre: 'Ajout d\'un capteur d\'accumulation en sortie de la remplisseuse', tech: 'kleroy', aussi: ['jbernard'], crea: 'mdupont', temps: [['kleroy', 7], ['jbernard', 3]],
      desc: 'Réduire les micro-arrêts par saturation du convoyeur entre la remplisseuse et l\'étiqueteuse.', pieces: [[/capteur inductif/i, 'Capteur inductif M18 PNP 8 mm', 2, 58.9], [/c[âa]ble souple/i, 'Câble souple H07RN-F 3G2,5 mm²', 15, 2.35]],
      rapport: 'Capteur d\'accumulation installé et câblé sur l\'automate : la remplisseuse ralentit automatiquement en cas de saturation. Gain constaté : −60 % de micro-arrêts sur bourrage.' },
    // Ligne 2 — assemblage
    { eq: 'Presse hydraulique 250 t', j: 312, hd: '07:10', dem: 0.5, dur: 7, type: 'correctif', prio: 'urgente', titre: 'Perte de pression sur le circuit hydraulique de la presse 250 t', cause: 'usure', tech: 'jbernard', aussi: ['kleroy'], crea: 'pmartin', temps: [['jbernard', 7], ['kleroy', 3]], di: { par: 'pmartin', valid: 0.2 },
      desc: 'La presse ne monte plus en pression (180 bar au lieu de 250 bar), production de la ligne 2 arrêtée.', pieces: [[/kit joints/i, 'Kit joints de vérin hydraulique (tige Ø 40 à 80)', 1, 38], [/huile hydraulique/i, 'Huile hydraulique Azolla ZS 46', 20, 3.85]],
      rapport: 'Joints du piston du vérin principal détériorés (by-pass interne). Remplacement du jeu de joints, appoint de 20 L d\'huile, purge et essais à 250 bar. 7 h d\'arrêt de la ligne 2.' },
    { eq: 'Presse hydraulique 250 t', j: 251, hd: '08:00', av: 10, dur: 4, type: 'reglementaire', prio: 'normale', titre: 'Vérification périodique réglementaire de la presse 250 t', tech: 'kleroy', crea: 'mdupont', ext: 650, four: /veritas/i,
      desc: 'Vérification générale périodique annuelle par l\'organisme de contrôle.', rapport: 'Vérification réalisée par Bureau Veritas : appareil conforme. Observation : remplacer la commande bimanuelle dont le marquage est effacé (fait le jour même).' },
    { eq: 'Presse hydraulique 250 t', j: 189, hd: '07:30', av: 6, dur: 5, type: 'preventif', prio: 'normale', titre: 'Vidange et remplacement du filtre hydraulique de la presse 250 t', tech: 'jbernard', crea: 'mdupont',
      desc: 'Vidange annuelle du circuit hydraulique (180 L) et remplacement du filtre retour.', pieces: [[/huile hydraulique/i, 'Huile hydraulique Azolla ZS 46', 180, 3.85], [null, 'Cartouche filtre hydraulique retour 10 µm', 1, 74]],
      rapport: 'Vidange complète, nettoyage du réservoir, filtre retour remplacé. Analyse d\'huile prélevée avant vidange : pollution classe 18/16/13 (acceptable).' },
    { eq: 'Presse hydraulique 250 t', j: 137, hd: '10:50', dem: 1, dur: 2, type: 'correctif', prio: 'haute', titre: 'Défaut de la barrière immatérielle de la presse 250 t', cause: 'electrique', tech: 'kleroy', crea: 'pmartin',
      desc: 'Presse bloquée en sécurité, barrière immatérielle en défaut permanent.', rapport: 'Émetteur de la barrière immatérielle désaligné suite à un choc de chariot. Réalignement et test de la fonction de sécurité (temps d\'arrêt mesuré : 180 ms).' },
    { eq: 'Robot de palettisation', j: 269, hd: '13:30', dem: 0.5, dur: 2.5, type: 'correctif', prio: 'haute', titre: 'Arrêt du robot de palettisation sur erreur de collision axe 3', cause: 'erreur_humaine', tech: 'jbernard', crea: 'pmartin',
      desc: 'Robot en défaut collision, préhenseur en appui sur la palette.', rapport: 'Collision suite à une modification manuelle du programme de palettisation (format 80 × 120). Recalage de l\'axe 3, contrôle du réducteur, restauration du programme validé et verrouillage des droits de modification.' },
    { eq: 'Robot de palettisation', j: 212, hd: '14:00', av: 7, dur: 2, type: 'preventif', prio: 'normale', titre: 'Graissage des axes 1 à 4 du robot de palettisation', tech: 'jbernard', crea: 'mdupont',
      desc: 'Graissage périodique des réducteurs des axes 1 à 4 (2 000 h).', pieces: [[/graisse/i, 'Graisse lithium Multis EP 2 (cartouche 400 g)', 3, 6.4]], rapport: 'Graissage des axes 1 à 4 réalisé, compteur de maintenance du contrôleur remis à zéro.' },
    { eq: 'Robot de palettisation', j: 98, hd: '14:00', av: 7, dur: 2, type: 'preventif', prio: 'normale', titre: 'Graissage des axes 1 à 4 du robot de palettisation', tech: 'jbernard', crea: 'mdupont',
      desc: 'Graissage périodique des réducteurs des axes 1 à 4 (2 000 h).', pieces: [[/graisse/i, 'Graisse lithium Multis EP 2 (cartouche 400 g)', 3, 6.4]], rapport: 'Graissage réalisé. Légère fuite de graisse au joint de l\'axe 2 : à surveiller.' },
    { eq: 'Robot de palettisation', j: 172, hd: '09:20', dem: 6, dur: 1.5, type: 'correctif', prio: 'normale', titre: 'Remplacement des ventouses du préhenseur du robot', cause: 'usure', tech: 'jbernard', crea: 'pmartin',
      desc: 'Pertes de cartons pendant la dépose, ventouses craquelées.', pieces: [[null, 'Ventouse à soufflet Ø 80 mm NBR', 6, 14.5]], rapport: 'Six ventouses remplacées, contrôle du vide (−0,7 bar) et du générateur de vide. Aucune perte de carton sur 3 palettes d\'essai.' },
    { eq: 'Ligne d\'assemblage L2', j: 154, hd: '09:00', dem: 2, type: 'amelioration', prio: 'basse', titre: 'Remplacement de l\'éclairage du poste 3 de la ligne 2', tech: 'kleroy', crea: 'pmartin',
      desc: 'Éclairage insuffisant au poste de contrôle visuel n°3.', annule: 'Intégré au projet de relamping LED de l\'atelier piloté par les services généraux.' },
    // Maintenance
    { eq: 'Pont roulant 5 t', j: 226, hd: '08:00', av: 14, dur: 4, type: 'reglementaire', prio: 'haute', titre: 'Vérification générale périodique (VGP) semestrielle du pont roulant 5 t', tech: 'kleroy', crea: 'mdupont', ext: 450, four: /veritas/i,
      desc: 'VGP semestrielle avec l\'organisme de contrôle.', rapport: 'VGP réalisée : appareil apte. Câble de levage en bon état, essais de freinage conformes.' },
    { eq: 'Pont roulant 5 t', j: 149, hd: '11:00', dem: 0.5, dur: 2, type: 'correctif', prio: 'urgente', titre: 'Fin de course de levage haut défaillant sur le pont roulant', cause: 'electrique', tech: 'kleroy', crea: 'kleroy',
      desc: 'Le crochet monte en butée sans arrêt automatique : pont consigné.', pieces: [[null, 'Interrupteur de fin de course à levier', 1, 145]], rapport: 'Interrupteur de fin de course haut HS (levier cassé). Remplacé et réglé, essais de fin de course haut / bas validés avant remise en service.' },
    { eq: 'Poste à souder TIG', j: 147, hd: '14:10', dem: 24, dur: 1, type: 'correctif', prio: 'normale', titre: 'Torche du poste à souder TIG défectueuse', cause: 'casse', tech: 'kleroy', crea: 'kleroy',
      desc: 'Fuite d\'eau de refroidissement au niveau de la torche.', pieces: [[null, 'Torche TIG refroidie eau 4 m', 1, 238]], rapport: 'Gaine de la torche percée : torche complète remplacée, circuit de refroidissement purgé.' },
    // Logistique
    { eq: 'Chariot élévateur électrique n°1', j: 262, hd: '06:30', dem: 2, dur: 3, type: 'correctif', prio: 'haute', titre: 'Chariot électrique n°1 : élément de batterie défectueux', cause: 'usure', tech: 'jbernard', crea: 'jbernard',
      desc: 'Autonomie divisée par deux, alarme de décharge en milieu de poste.', pieces: [[null, 'Élément de batterie 2 V 620 Ah', 1, 310]], rapport: 'Mesure des densités : élément n°14 en court-circuit. Élément remplacé, charge d\'égalisation réalisée. Autonomie retrouvée.' },
    { eq: 'Chariot élévateur électrique n°1', j: 201, hd: '09:00', av: 10, dur: 1.5, type: 'reglementaire', prio: 'normale', titre: 'VGP semestrielle du chariot élévateur électrique n°1', tech: 'jbernard', crea: 'mdupont', ext: 180, four: /veritas/i,
      desc: 'Vérification générale périodique semestrielle.', rapport: 'VGP réalisée : chariot apte. Observation : remplacer les patins de fourche à la prochaine révision.' },
    { eq: 'Chariot élévateur électrique n°1', j: 118, hd: '15:15', dem: 1, dur: 2, type: 'correctif', prio: 'haute', titre: 'Crevaison du bandage de la roue avant gauche du chariot n°1', cause: 'casse', tech: 'jbernard', crea: 'jbernard',
      desc: 'Bandage arraché suite au passage sur un feuillard.', pieces: [[null, 'Bandage plein 18 × 7-8 (roue avant)', 1, 165]], rapport: 'Bandage remplacé sur presse, serrage des écrous de roue au couple. Allée de circulation nettoyée.' },
    { eq: 'Chariot élévateur thermique n°2', j: 289, hd: '07:00', dem: 1, dur: 3.5, type: 'correctif', prio: 'haute', titre: 'Chariot thermique n°2 : démarreur hors service', cause: 'electrique', tech: 'kleroy', crea: 'jbernard',
      desc: 'Le chariot ne démarre plus, cliquetis au démarreur.', pieces: [[null, 'Démarreur 12 V 2,2 kW', 1, 285]], rapport: 'Démarreur HS (charbons usés, induit marqué). Démarreur remplacé, contrôle de la charge de l\'alternateur (14,2 V).' },
    { eq: 'Chariot élévateur thermique n°2', j: 240, hd: '13:00', av: 5, dur: 3, type: 'preventif', prio: 'normale', titre: 'Entretien 500 h du chariot élévateur thermique n°2', tech: 'jbernard', crea: 'mdupont',
      desc: 'Vidange moteur, remplacement des filtres huile, air et gasoil.', pieces: [[null, 'Kit entretien 500 h (filtres huile, air, gasoil)', 1, 96], [null, 'Huile moteur 15W40', 8, 4.2]], rapport: 'Entretien 500 h réalisé selon la gamme constructeur. Niveaux faits, graissage du mât.' },
    { eq: 'Chariot élévateur thermique n°2', j: 105, hd: '13:00', av: 5, dur: 3, type: 'preventif', prio: 'normale', titre: 'Entretien 500 h du chariot élévateur thermique n°2', tech: 'jbernard', crea: 'mdupont',
      desc: 'Vidange moteur, remplacement des filtres huile, air et gasoil.', pieces: [[null, 'Kit entretien 500 h (filtres huile, air, gasoil)', 1, 96], [null, 'Huile moteur 15W40', 8, 4.2]], rapport: 'Entretien 500 h réalisé. Suintement constaté au vérin d\'inclinaison : à surveiller.' },
    { eq: 'Chariot élévateur thermique n°2', j: 176, hd: '10:30', dem: 20, dur: 2, type: 'correctif', prio: 'normale', titre: 'Fuite de liquide de refroidissement sur le chariot thermique n°2', cause: 'usure', tech: 'jbernard', crea: 'jbernard',
      desc: 'Traces de liquide de refroidissement sous le chariot, voyant de température allumé.', pieces: [[null, 'Durite de radiateur inférieure', 1, 38], [null, 'Liquide de refroidissement −35 °C', 5, 3.9]],
      rapport: 'Durite inférieure du radiateur poreuse : remplacée, circuit purgé et complété. Essai de 30 minutes sans fuite.' },
    { eq: 'Transpalette électrique', j: 211, hd: '08:40', dem: 3, dur: 1, type: 'correctif', prio: 'normale', titre: 'Transpalette : bouton d\'avance du timon défectueux', cause: 'casse', tech: 'jbernard', crea: 'jbernard',
      desc: 'Le transpalette n\'avance plus qu\'en marche arrière.', pieces: [[null, 'Bouton papillon de timon', 1, 54]], rapport: 'Bouton papillon cassé (chute du transpalette). Remplacé, essais des deux sens de marche et de l\'anti-écrasement.' },
    // Qualité / laboratoire
    { eq: 'Étuve de laboratoire', j: 332, hd: '10:00', av: 10, dur: 1, type: 'reglementaire', prio: 'normale', titre: 'Étalonnage annuel de la sonde de température de l\'étuve', tech: 'kleroy', crea: 'mdupont', ext: 280, four: /mettler|m[ée]trolog/i,
      desc: 'Étalonnage annuel par un laboratoire accrédité.', rapport: 'Étalonnage réalisé à 50, 105 et 150 °C : écarts inférieurs à 0,6 °C. Certificat d\'étalonnage archivé.' },
    { eq: 'Balance de précision', j: 258, hd: '09:30', dem: 2, dur: 1, type: 'correctif', prio: 'haute', titre: 'Dérive de la mesure sur la balance de précision', cause: 'reglage', tech: 'kleroy', crea: 'kleroy',
      desc: 'Écart constaté lors de la vérification quotidienne avec la masse étalon.', rapport: 'Écart de +0,04 g sur masse étalon de 200 g. Mise à niveau du plateau et calibrage interne : écart résiduel inférieur à 0,005 g.' },
    { eq: 'Balance de précision', j: 190, hd: '14:00', av: 7, dur: 1, type: 'reglementaire', prio: 'normale', titre: 'Vérification métrologique semestrielle de la balance de précision', tech: 'kleroy', crea: 'mdupont',
      desc: 'Vérification avec les masses étalon de classe F1.', rapport: 'Vérification réalisée sur 5 points (10 g à 6 kg) : conforme à la classe de précision. Fiche de vie métrologique complétée.' },
  );
  return defs;
}

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  if (db.findOne('ot', (o) => o.titre === TEMOIN && o.origine === 'reprise')) return 'déjà présents';
  seedEnCours = true;
  try {
    // Référentiels nécessaires (seeds idempotents) : utilisateurs, secteurs, fournisseurs, équipements, stock
    const avant = ['utilisateurs.js', 'secteurs.js', 'fournisseurs.js', 'equipements.js', 'stock.js'];
    for (const fichier of avant) {
      const m = (ctx.modules || []).find((x) => x.fichier === fichier);
      if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Rapports : seed dépendant en échec', fichier, e.message); } }
    }
    const resultat = insererArchives(ctx);
    // Données courantes (demandes et OT récents) : numérotées après l'historique si elles n'existent pas encore
    for (const fichier of ['demandes.js', 'ot.js']) {
      const m = (ctx.modules || []).find((x) => x.fichier === fichier);
      if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Rapports : seed dépendant en échec', fichier, e.message); } }
    }
    return resultat;
  } finally { seedEnCours = false; }
}

function insererArchives(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const listes = cfg.listes || {};
  const st = outilsStatutsOt(listes.statutsOT);
  const tauxHoraire = num((cfg.general || {}).tauxHoraire);
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = login ? db.findOne('users', (x) => x.login === login) : null; return u ? u.id : (admin ? admin.id : null); };
  const nomUser = (id) => { const u = id == null ? null : db.get('users', id); return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : ''; };
  const liste = (n) => listes[n] || [];
  const code = (n, voulu) => { const l = liste(n); return !l.length || l.some((x) => x.code === voulu) ? voulu : l[0].code; };
  const causeOk = (c) => (c && liste('causesPanne').some((x) => x.code === c) ? c : null);
  const equipements = new Map(db.list('equipements').map((e) => [e.nom, e]));
  if (!equipements.size) return 'aucun équipement : historique non repris';
  const article = (re) => (re ? db.findOne('articles', (a) => re.test(`${a.designation || ''} ${a.code || ''}`)) : null);
  const fournisseur = (re) => { const f = re ? db.findOne('fournisseurs', (x) => re.test(x.nom || '')) : null; return f ? f.id : null; };
  const st0 = { cree: st.initial, planifie: st.planifie || st.initial, enCours: st.enCours || st.initial };
  /** Horodatage ISO : n jours avant aujourd'hui à l'heure donnée, décalé de h heures. */
  const instant = (jours, heure, h = 0) => { const d = new Date(); d.setDate(d.getDate() - jours); const [hh, mm] = String(heure || '08:00').split(':').map(Number); d.setHours(hh, mm, 0, 0); return new Date(d.getTime() + h * 3600000).toISOString(); };

  // Numérotation : compteur propre à l'année de l'intervention (gabarit avec {annee}), sinon numérotation courante
  const numeros = (db.data.meta.numeros = db.data.meta.numeros || {});
  const anneeCourante = String(new Date().getFullYear());
  function numero(cle, collection, gabarit, iso) {
    const d = new Date(iso);
    const annee = String(d.getFullYear());
    for (let i = 0; i < 1000; i++) {
      let n;
      if (gabarit.includes('{annee}') && annee !== anneeCourante) {
        const k = `${cle}:${annee}`;
        numeros[k] = (numeros[k] || 0) + 1;
        n = gabarit.replace(/\{annee\}/g, annee).replace(/\{aa\}/g, annee.slice(2)).replace(/\{mois\}/g, pad(d.getMonth() + 1))
          .replace(/\{num(?::(\d+))?\}/g, (m, w) => String(numeros[k]).padStart(Number(w || 1), '0'));
      } else n = db.nextNumber(cle, gabarit);
      if (!db.findOne(collection, (x) => x.numero === n)) return n;
    }
    return `${cle.toUpperCase()}-${Date.now()}`;
  }
  const gabaritOt = (cfg.numerotation || {}).ot || 'OT-{annee}-{num:4}';
  const gabaritDi = (cfg.numerotation || {}).di || 'DI-{annee}-{num:4}';

  // Statuts des demandes (rôles du circuit résolus par le module Demandes, sinon codes par défaut présents dans la liste)
  let roles = null;
  const sDem = ctx.services.demandes;
  if (sDem) { try { roles = sDem.STATUTS || null; } catch (e) { roles = null; } }
  const sd = (role) => (roles && roles[role]) || code('statutsDemande', role);
  const etapeDi = (date, uid, action, libelle, statut, commentaire) => ({ date, userId: uid, action, libelle, statut, commentaire: commentaire || '' });
  const etape = (date, uid, action, libelle, statut, commentaire, ancien) => Object.assign({ date, userId: uid, action, libelle, statut, commentaire: commentaire || '' }, ancien ? { ancien } : {});

  const defs = definitionsArchives().map((d) => {
    const debut = instant(d.j, d.hd);
    const creation = d.av ? instant(d.j + d.av, '09:00') : instant(d.j, d.hd, -(d.dem == null ? 1 : d.dem));
    return Object.assign({}, d, { debut, creation });
  }).sort((a, b) => a.creation.localeCompare(b.creation));

  const colOt = db.data.collections.ot || (db.data.collections.ot = []);
  const colDi = db.data.collections.demandes || (db.data.collections.demandes = []);
  let nbOt = 0; let nbDi = 0;

  // Demandes refusées (hors périmètre de la maintenance), insérées à leur place chronologique
  const refus = [
    { jours: 300, eq: 'Ligne de conditionnement L1', par: 'spetit', titre: 'Peindre le garde-corps de la passerelle de la ligne 1', prio: 'basse', type: 'amelioration', motif: 'Travaux de peinture hors périmètre maintenance : à demander aux services généraux (contrat de prestation peinture).' },
    { jours: 185, eq: 'Transpalette électrique', par: 'jbernard', titre: 'Ajouter une prise 230 V au quai 3 pour charger le transpalette', prio: 'normale', type: 'amelioration', motif: 'Prise de charge déjà disponible au quai 2 ; une installation au quai 3 nécessite une étude électrique (projet travaux neufs).' },
  ];
  function insererRefus(r) {
    const eq = equipements.get(r.eq);
    if (!eq) return;
    const demandeur = userId(r.par);
    const uDem = demandeur != null ? db.get('users', demandeur) : null;
    const valideur = uDem && uDem.managerId != null && db.get('users', uDem.managerId) ? Number(uDem.managerId) : userId('pmartin');
    const dateDemande = instant(r.jours, '10:00');
    const dateValidation = instant(r.jours, '10:00', 26);
    const di = db.insert('demandes', {
      numero: numero('di', 'demandes', gabaritDi, dateDemande), titre: r.titre, description: '', equipementId: eq.id, secteurId: eq.secteurId == null ? null : eq.secteurId,
      prioriteCode: code('priorites', r.prio), typeCode: code('typesIntervention', r.type), statut: sd('refusee'), demandeurId: demandeur, dateDemande,
      validateurId: valideur, dateValidation, motifRefus: r.motif, otId: null, dateCloture: null, arretProduction: false,
      commentaires: [], pieceJointes: [], champs: {}, createdBy: demandeur, origine: 'reprise',
      historique: [etapeDi(dateDemande, demandeur, 'creation', 'Demande soumise', sd('soumise'), 'Historique repris de l\'ancienne GMAO'), etapeDi(dateValidation, valideur, 'refus', 'Demande refusée', sd('refusee'), r.motif)],
    });
    const brutDi = colDi.find((x) => x.id === di.id);
    if (brutDi) { brutDi.createdAt = dateDemande; brutDi.updatedAt = dateValidation; }
    nbDi++;
  }
  const refusRestants = refus.map((r) => Object.assign({ date: instant(r.jours, '10:00') }, r)).sort((a, b) => a.date.localeCompare(b.date));

  for (const d of defs) {
    while (refusRestants.length && refusRestants[0].date < d.creation) insererRefus(refusRestants.shift());
    const eq = equipements.get(d.eq);
    if (!eq) continue;
    const annule = !!d.annule;
    const statut = annule ? (st.annule || st.termine) : st.termine;
    const tech = userId(d.tech);
    const createur = userId(d.crea);
    const techniciens = [tech].concat((d.aussi || []).map(userId)).filter((x, i, a) => x != null && a.indexOf(x) === i);
    const fin = annule ? instant(d.j, d.hd, 20) : new Date(Date.parse(d.debut) + d.dur * 3600000).toISOString();
    const jourDebut = jourDe(d.debut);
    const tempsPasse = annule ? [] : (d.temps || [[d.tech, d.dur]]).map(([login, heures, decalage]) => ({ userId: userId(login), date: decalage ? ajouterJours(jourDebut, decalage) : jourDebut, heures, commentaire: '', saisiPar: userId(login), dateSaisie: fin }));
    const pieces = annule ? [] : (d.pieces || []).map(([re, designation, quantite, prix]) => {
      const a = article(re);
      return { articleId: a ? a.id : null, code: a ? a.code || '' : '', designation: a ? a.designation : designation, uniteCode: a ? a.uniteCode || null : null, quantite, prixUnitaire: a && num(a.prixUnitaire) > 0 ? num(a.prixUnitaire) : prix, mouvementId: null, date: new Date(Date.parse(d.debut) + 30 * 60000).toISOString(), userId: tech };
    });
    const historique = [etape(d.creation, createur, 'creation', 'Ordre de travail créé', st0.cree, 'Historique repris de l\'ancienne GMAO')];
    historique.push(etape(d.creation, createur, 'affectation', 'Affectation', st0.cree, `Responsable : ${nomUser(tech)}`));
    if (st0.planifie !== st0.cree) historique.push(etape(d.creation, createur, 'statut', 'Changement de statut', st0.planifie, '', st0.cree));
    if (annule) historique.push(etape(fin, createur, 'annulation', 'Ordre de travail annulé', statut, d.annule, st0.planifie));
    else {
      if (st0.enCours !== st0.planifie) historique.push(etape(d.debut, tech, 'statut', 'Changement de statut', st0.enCours, '', st0.planifie));
      historique.push(etape(fin, tech, 'cloture', 'Ordre de travail clôturé', statut, d.rapport.length > 160 ? d.rapport.slice(0, 157) + '…' : d.rapport, st0.enCours));
    }
    const record = {
      numero: numero('ot', 'ot', gabaritOt, d.creation), titre: d.titre, description: d.desc || '', typeCode: code('typesIntervention', d.type), prioriteCode: code('priorites', d.prio), statut,
      equipementId: eq.id, secteurId: eq.secteurId == null ? null : eq.secteurId, demandeId: null, planPreventifId: null,
      technicienId: tech, techniciens, datePrevue: jourDebut, dateDebut: annule ? null : d.debut, dateFin: fin,
      dureeEstimee: d.dur == null ? null : d.dur, tempsPasse, pieces, piecesPrevues: [], causeCode: causeOk(d.cause), rapport: annule ? '' : d.rapport,
      commentaires: [], documents: [], coutPieces: 0, coutMainOeuvre: 0, coutExterne: annule ? 0 : (d.ext || 0), coutTotal: 0, fournisseurId: d.four ? fournisseur(d.four) : null,
      compteurReleve: null, taches: [], cloturePar: annule ? createur : tech, dateCloture: fin, champs: {}, historique, createdBy: createur, origine: 'reprise',
    };
    const c = calculerCouts(record, tauxHoraire);
    Object.assign(record, { coutPieces: c.coutPieces, coutMainOeuvre: c.coutMainOeuvre, coutExterne: c.coutExterne, coutTotal: c.coutTotal });
    const o = db.insert('ot', record);
    const brut = colOt.find((x) => x.id === o.id);
    if (brut) { brut.createdAt = d.creation; brut.updatedAt = fin; }
    nbOt++;

    // Demande d'intervention à l'origine de la panne (circuit complet : soumise → validée → convertie → clôturée)
    if (d.di && !annule) {
      const demandeur = userId(d.di.par);
      // Valideur : le supérieur hiérarchique (N+1) du demandeur, à défaut le chef de secteur
      const uDem = demandeur != null ? db.get('users', demandeur) : null;
      const valideur = uDem && uDem.managerId != null && db.get('users', uDem.managerId) ? Number(uDem.managerId) : userId(d.di.par === 'pmartin' ? 'mdupont' : 'pmartin');
      const dateDemande = new Date(Date.parse(d.creation) - Math.round(d.di.valid * 3600000)).toISOString();
      const di = db.insert('demandes', {
        numero: numero('di', 'demandes', gabaritDi, dateDemande), titre: d.titre, description: d.desc || '', equipementId: eq.id, secteurId: eq.secteurId == null ? null : eq.secteurId,
        prioriteCode: record.prioriteCode, typeCode: record.typeCode, statut: sd('cloturee'), demandeurId: demandeur, dateDemande,
        validateurId: valideur, dateValidation: d.creation, motifRefus: '', otId: o.id, dateCloture: fin, arretProduction: d.prio === 'urgente',
        commentaires: [], pieceJointes: [], champs: {}, createdBy: demandeur, origine: 'reprise',
        historique: [
          etapeDi(dateDemande, demandeur, 'creation', 'Demande soumise', sd('soumise'), 'Historique repris de l\'ancienne GMAO'),
          etapeDi(d.creation, valideur, 'validation', 'Demande validée', sd('validee')),
          etapeDi(d.creation, valideur, 'conversion', 'Convertie en ordre de travail', sd('convertie'), `Ordre de travail ${o.numero}`),
          etapeDi(fin, null, 'cloture', 'Demande clôturée', sd('cloturee'), `Ordre de travail ${o.numero} terminé`),
        ],
      });
      const brutDi = colDi.find((x) => x.id === di.id);
      if (brutDi) { brutDi.createdAt = dateDemande; brutDi.updatedAt = fin; }
      db.update('ot', o.id, { demandeId: di.id });
      const brutOt = colOt.find((x) => x.id === o.id);
      if (brutOt) brutOt.updatedAt = fin;
      nbDi++;
    }
  }

  while (refusRestants.length) insererRefus(refusRestants.shift());
  db.touch();
  return `${nbOt} ordres de travail archivés (12 mois d'historique repris de l'ancienne GMAO), ${nbDi} demandes archivées`;
}

module.exports = { nom, register, seedDemo, outilsStatutsOt, calculerCouts };
