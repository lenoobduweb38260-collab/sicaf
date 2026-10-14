'use strict';
/**
 * Module Planning : calendrier des interventions (ordres de travail datés, échéances des plans
 * préventifs), charge des techniciens, replanification par glisser-déposer et génération des OT
 * préventifs depuis le calendrier.
 *
 * Le module ne possède pas de collection propre : il lit les collections `ot` et `plansPreventifs`
 * (voir docs/ARCHITECTURE.md) et ne modifie que la date prévue et le technicien responsable d'un OT.
 *
 * Routes :
 *   GET  /api/planning?du=AAAA-MM-JJ&au=AAAA-MM-JJ&secteurId&technicienId&typeCode&finaux=0&projection=1
 *        → { du, au, aujourdhui, heuresParJour, joursOuvres, ot, echeances, nonPlanifies, charge,
 *            enRetard: { ot, echeances }, totaux, droits, legende }
 *   GET  /api/planning-techniciens              utilisateurs actifs ayant le droit ot.voir, dans la portée
 *   PUT  /api/planning/ot/:id                   { datePrevue, technicienId?, planifier? } (droit planning.modifier)
 *   POST /api/planning/preventif/:id/generer    { datePrevue? } (planning.modifier + ot.creer + preventif.voir)
 *
 * Droits : planning.voir (consultation ; les OT exigent en plus ot.voir et les échéances preventif.voir),
 *   planning.modifier (déplacement d'un OT, changement de technicien, génération d'un OT préventif).
 * Portée : OT selon la portée de l'utilisateur, étendue aux OT dont il est créateur ou intervenant
 *   (même règle que le module Ordres de travail) ; plans préventifs via ctx.scope ; techniciens
 *   limités aux secteurs de l'utilisateur (portée « secteurs ») ou à lui-même (portée « perso »).
 *
 * Services publiés   : ctx.services.planning.{ periode(req, options), charge({ du, au, req? }), techniciens(req) }
 * Événements émis    : 'ot:modifie' ({ ot, champsModifies, source: 'planning' }), 'ot:statut' ({ ot, ancien, nouveau })
 *                      lors de la planification automatique, 'planning:replanifie' ({ ot, ancien, nouveau, userId }) ;
 *                      en l'absence du module Préventif : 'preventif:genere' ({ plan, ot }) et, sans module OT, 'ot:cree'.
 * Services consommés : ctx.services.preventif.{ genererRapport | generer, analyser, periodiciteLibelle },
 *                      ctx.services.ot.creer (repli de génération).
 */
const nom = 'Planning';
const MODULE = 'planning';
const MAX_JOURS_PERIODE = 400;
const MAX_OCCURRENCES = 400;

/** Statuts d'OT de repli (utilisés uniquement si la liste `statutsOT` est vide). */
const STATUTS_DEFAUT = [
  { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
  { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
  { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
  { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
  { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
  { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
];
const COULEUR_DEFAUT = '#6b7280';
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ----- Utilitaires de dates (jours calendaires locaux « AAAA-MM-JJ ») ---------------------------
function pad(n) { return String(n).padStart(2, '0'); }
function dateLocale(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Jour local d'une date « AAAA-MM-JJ » ou d'un horodatage ISO ; null si invalide. */
function jourDe(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (RE_DATE.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : dateLocale(new Date(t));
}
/** Heure locale « HH:MM » d'un horodatage ISO (null pour une date seule). */
function heureDe(v) {
  if (v == null || v === '' || RE_DATE.test(String(v))) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function decomposer(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return { y, m, d }; }
function versChaine(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
function ajouterJours(s, n) { const { y, m, d } = decomposer(s); return versChaine(y, m, d + n); }
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
/** Date + k périodes d'une périodicité calendaire (jours, semaines, mois). */
function ajouterPeriode(s, periodicite, k = 1) {
  const v = Number(periodicite && periodicite.valeur) || 0;
  switch (periodicite && periodicite.type) {
    case 'jours': return ajouterJours(s, v * k);
    case 'semaines': return ajouterJours(s, 7 * v * k);
    case 'mois': return ajouterMois(s, v * k);
    default: return null;
  }
}
function estDateValide(s) {
  if (typeof s !== 'string' || !RE_DATE.test(s)) return false;
  const { y, m, d } = decomposer(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2100;
}
/** Jour de la semaine : 0 = lundi … 6 = dimanche. */
function jourSemaine(s) { const { y, m, d } = decomposer(s); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }
/** Nombre de jours ouvrés (lundi → vendredi) entre deux dates incluses. */
function joursOuvres(du, au) {
  let n = 0;
  for (let j = du, i = 0; j <= au && i <= MAX_JOURS_PERIODE + 7; j = ajouterJours(j, 1), i++) if (jourSemaine(j) < 5) n++;
  return n;
}
function formatDateFr(v) { const j = jourDe(v); return j ? j.split('-').reverse().join('/') : ''; }
function arrondi(n, dec = 2) { const f = 10 ** dec; return Math.round((Number(n) || 0) * f) / f; }
function objet(b) { return b && typeof b === 'object' && !Buffer.isBuffer(b) && !Array.isArray(b) ? b : {}; }
function nombreOuNull(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Outils de lecture de la liste de statuts d'OT configurée (codes sémantiques résolus avec repli). */
function outilsStatuts(listeConfiguree) {
  const liste = Array.isArray(listeConfiguree) && listeConfiguree.length ? listeConfiguree.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : STATUTS_DEFAUT;
  const item = (code) => liste.find((s) => s.code === code) || null;
  const estFinal = (code) => { const s = item(code); return !!(s && s.final); };
  const estAnnulation = (code) => { const s = item(code); return !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || ''))); };
  const nonFinal = (code, re) => { const s = item(code); if (s && !s.final) return s.code; const t = liste.find((x) => !x.final && re.test(`${x.code} ${x.label || ''}`)); return t ? t.code : null; };
  return {
    liste, item, estFinal, estAnnulation,
    initial: (liste.find((s) => !s.final) || { code: 'nouveau' }).code,
    planifie: nonFinal('planifie', /planifi/i),
    enCours: nonFinal('en_cours', /cours/i),
    libelle: (code) => { const s = item(code); return s ? s.label : String(code == null ? '' : code); },
    couleur: (code) => { const s = item(code); return (s && s.couleur) || COULEUR_DEFAUT; },
  };
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const can = (req, module, action) => !!(req && req.perms && perms.can(req.perms, module, action));
  const ST = () => outilsStatuts(ctx.liste('statutsOT'));
  const heuresParJour = () => { const h = Number((ctx.config().general || {}).heuresParJour); return Number.isFinite(h) && h > 0 ? h : 8; };
  const maintenant = () => new Date().toISOString();

  // ----- Portée ------------------------------------------------------------------------------
  function estAffecte(uid, o) {
    if (uid == null || !o) return false;
    uid = Number(uid);
    return Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid));
  }
  /** Même règle que le module OT : portée standard, étendue au créateur et aux intervenants. */
  function peutVoirOt(req, o) {
    if (!o) return false;
    if (ctx.canSee(req, o)) return true;
    return estAffecte(req.user.id, o) || Number(o.createdBy) === req.user.id;
  }
  /** Modifiable : portée en écriture (les sites accessibles en lecture seule sont exclus), créateur ou intervenant. */
  function ecrivable(req, rec) {
    if (!req || !req.perms) return true;
    if (perms.canSeeRecord(req.perms, req.user, rec, { ecriture: true })) return true;
    return estAffecte(req.user.id, rec) || (rec.createdBy != null && Number(rec.createdBy) === req.user.id);
  }
  /** OT modifiable par l'utilisateur, 403 si son site n'est accessible qu'en lecture, 404 sinon. */
  function otModifiable(req, id) {
    const o = db.get('ot', id);
    if (!o) throw new HttpError(404, 'Ordre de travail introuvable');
    if (ecrivable(req, o)) return o;
    if (perms.canSeeRecord(req.perms, req.user, o)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : replanification impossible');
    throw new HttpError(404, 'Ordre de travail introuvable');
  }
  function droits(req) {
    const voirOt = can(req, 'ot', 'voir');
    const voirPreventif = can(req, 'preventif', 'voir');
    const modifier = can(req, MODULE, 'modifier') && voirOt;
    return { voirOt, voirPreventif, modifier, generer: modifier && voirPreventif && can(req, 'ot', 'creer'), creerOt: can(req, 'ot', 'creer') };
  }

  /** Techniciens possibles : utilisateurs actifs ayant le droit ot.voir, dans la portée de l'utilisateur. */
  function techniciensVisibles(req) {
    const config = db.getConfig();
    const portee = req && req.perms ? req.perms.portee : 'tous';
    const mesSecteurs = new Set(req && req.perms ? (req.perms.secteurIds || []).map(Number) : []);
    // Site choisi dans l'en-tête (multi-site) : seuls les techniciens de ce site (ou sans secteur) sont proposés
    const filtreSite = req && req.perms && Array.isArray(req.perms.siteFiltre) ? new Set(req.perms.siteFiltre.map(Number)) : null;
    const out = [];
    for (const u of db.list('users', (x) => x.actif !== false)) {
      const p = perms.effectivePermissions(db, u, null, config);
      if (!perms.can(p, 'ot', 'voir')) continue;
      const moi = !!(req && req.user && u.id === req.user.id);
      const ids = u.secteurIds || [];
      const desc = ids.length ? perms.secteursDescendants(db, ids).map(Number) : [];
      if (req && req.user && portee !== 'tous' && !moi) {
        if (portee === 'perso') continue;
        if (ids.length && !desc.some((s) => mesSecteurs.has(s))) continue;
      }
      if (filtreSite && !moi && ids.length && !desc.some((s) => filtreSite.has(s)) && !(u.siteAcces || []).some((a) => a && filtreSite.has(Number(a.siteId)))) continue;
      out.push({
        id: u.id, login: u.login, nom: u.nom || '', prenom: u.prenom || '', nomComplet: `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login,
        fonction: u.fonction || '', secteurIds: (u.secteurIds || []).map(Number), profilNom: p.profilNom || '',
        peutModifierPlanning: perms.can(p, MODULE, 'modifier'),
      });
    }
    return out.sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, 'fr'));
  }

  // ----- Validation des entrées -------------------------------------------------------------------
  function lireJour(v, label) {
    if (typeof v !== 'string' || !estDateValide(v.trim())) throw new HttpError(400, `${label} invalide (format attendu AAAA-MM-JJ)`);
    return v.trim();
  }
  /** Date prévue : « AAAA-MM-JJ » ou horodatage ISO ; null pour retirer la date. */
  function lireDatePrevue(v) {
    if (v === null || v === '') return null;
    if (typeof v !== 'string') throw new HttpError(400, 'La date prévue est invalide (format attendu AAAA-MM-JJ)');
    const s = v.trim();
    if (RE_DATE.test(s)) {
      if (!estDateValide(s)) throw new HttpError(400, 'La date prévue est invalide (format attendu AAAA-MM-JJ)');
      return s;
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) throw new HttpError(400, 'La date prévue est invalide (format attendu AAAA-MM-JJ)');
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new HttpError(400, 'La date prévue est invalide');
    const a = new Date(t).getFullYear();
    if (a < 1990 || a > 2100) throw new HttpError(400, 'La date prévue est hors limites');
    return new Date(t).toISOString();
  }
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  /** Filtres communs de la requête GET /api/planning. */
  function lireFiltres(q) {
    const f = { secteurIds: null, sansSecteur: false, technicienId: null, sansTechnicien: false, typeCode: null };
    if (q.secteurId != null && q.secteurId !== '') {
      if (q.secteurId === 'aucun') f.sansSecteur = true;
      else {
        const id = idRef(q.secteurId, 'Secteur');
        if (!db.get('secteurs', id)) throw new HttpError(400, 'Secteur introuvable');
        f.secteurIds = new Set(perms.secteursDescendants(db, [id]).map(Number));
      }
    }
    if (q.technicienId != null && q.technicienId !== '') {
      if (q.technicienId === 'aucun') f.sansTechnicien = true;
      else {
        f.technicienId = idRef(q.technicienId, 'Technicien');
        if (!db.get('users', f.technicienId)) throw new HttpError(400, 'Technicien introuvable');
      }
    }
    if (q.typeCode != null && q.typeCode !== '') {
      const l = ctx.liste('typesIntervention');
      if (l.length && !l.some((x) => x.code === q.typeCode)) throw new HttpError(400, `Type d'intervention inconnu : « ${q.typeCode} »`);
      f.typeCode = String(q.typeCode);
    }
    return f;
  }
  function filtreSecteur(f, secteurId) {
    if (f.sansSecteur) return secteurId == null || secteurId === '';
    if (f.secteurIds) return secteurId != null && secteurId !== '' && f.secteurIds.has(Number(secteurId));
    return true;
  }

  // ----- Références et mise en forme --------------------------------------------------------------
  function references() {
    const types = new Map(ctx.liste('typesIntervention').map((t) => [t.code, t]));
    return {
      equipements: new Map(db.list('equipements').map((e) => [e.id, e])),
      secteurs: new Map(db.list('secteurs').map((s) => [s.id, s])),
      users: new Map(db.list('users').map((u) => [u.id, u])),
      types, st: ST(), aujourdhui: dateLocale(),
    };
  }
  function nomDe(refs, id) {
    const u = id == null ? null : refs.users.get(Number(id));
    return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '';
  }
  function couleurType(refs, code) { const t = refs.types.get(code); return (t && t.couleur) || COULEUR_DEFAUT; }
  function libelleType(refs, code) { const t = refs.types.get(code); return t ? t.label : (code || ''); }

  /** Élément de planning pour un OT. */
  /** Fiche équipement ouvrable par l'utilisateur (droit et portée) ; un intervenant peut voir l'OT sans voir l'équipement. */
  function equipementAccessible(req, e) {
    if (!e || !req || !req.perms || !perms.can(req.perms, 'equipements', 'voir')) return false;
    const sEq = ctx.services.equipements;
    try { return sEq && typeof sEq.visible === 'function' ? !!sEq.visible(req, e) : ctx.canSee(req, e); } catch (err) { return false; }
  }
  function itemOt(o, refs, d, jour, req) {
    const e = o.equipementId != null ? refs.equipements.get(Number(o.equipementId)) : null;
    const s = o.secteurId != null ? refs.secteurs.get(Number(o.secteurId)) : null;
    const final = refs.st.estFinal(o.statut);
    const jourPrevu = jourDe(o.datePrevue);
    return {
      id: o.id, numero: o.numero || '', titre: o.titre || '', description: o.description ? String(o.description).slice(0, 300) : '',
      statut: o.statut, statutLibelle: refs.st.libelle(o.statut), couleurStatut: refs.st.couleur(o.statut), final, annule: refs.st.estAnnulation(o.statut),
      typeCode: o.typeCode || null, typeLibelle: libelleType(refs, o.typeCode), couleur: couleurType(refs, o.typeCode),
      prioriteCode: o.prioriteCode || null,
      equipementId: o.equipementId == null ? null : o.equipementId, equipementNom: e ? e.nom : '', equipementNumero: e ? e.numero || '' : '',
      equipementAccessible: equipementAccessible(req, e),
      secteurId: o.secteurId == null ? null : o.secteurId, secteurNom: s ? s.nom : '',
      technicienId: o.technicienId == null ? null : Number(o.technicienId), technicienNom: nomDe(refs, o.technicienId),
      techniciens: (o.techniciens || []).map(Number), techniciensNoms: (o.techniciens || []).map((id) => nomDe(refs, id)).filter(Boolean),
      datePrevue: o.datePrevue || null, jour: jour === undefined ? jourPrevu : jour, heure: heureDe(o.datePrevue), sansDate: !o.datePrevue,
      dureeEstimee: nombreOuNull(o.dureeEstimee),
      dateDebut: o.dateDebut || null, dateFin: o.dateFin || null,
      enRetard: !final && !!jourPrevu && jourPrevu < refs.aujourdhui,
      planPreventifId: o.planPreventifId == null ? null : o.planPreventifId, demandeId: o.demandeId == null ? null : o.demandeId,
      nbTaches: (o.taches || []).length, nbTachesFaites: (o.taches || []).filter((t) => t.fait).length,
      deplacable: !!(d && d.modifier) && !final && ecrivable(req, o),
    };
  }

  // ----- Échéances préventives ---------------------------------------------------------------------
  /** OT ouverts par plan préventif (tous, sans portée : contrôle d'existence). */
  function otOuvertsParPlan(st) {
    const m = new Map();
    for (const o of db.list('ot', (x) => x.planPreventifId != null && !st.estFinal(x.statut))) {
      const pid = Number(o.planPreventifId);
      const cur = m.get(pid);
      if (!cur || String(o.createdAt || '') > String(cur.createdAt || '')) m.set(pid, o);
    }
    return m;
  }
  /**
   * Échéances des plans actifs visibles. Retourne { periode, enRetard } :
   * periode = occurrences dans [du, au] (occurrence 0 sans OT ouvert, puis projections si demandé),
   * enRetard = échéances dépassées non générées antérieures à la période affichée.
   */
  function echeancesPlans(req, { du, au, filtres, projection, generer }, refs) {
    const sPrev = ctx.services.preventif;
    const ouverts = otOuvertsParPlan(refs.st);
    let plans = db.list('plansPreventifs', (p) => p.actif !== false);
    if (req && req.perms) plans = ctx.scope(req, plans);
    const periode = []; const enRetard = [];
    for (const plan of plans) {
      if (!filtreSecteur(filtres, plan.secteurId)) continue;
      if (filtres.sansTechnicien && plan.technicienId != null) continue;
      if (filtres.technicienId != null && Number(plan.technicienId) !== filtres.technicienId) continue;
      if (filtres.typeCode && plan.typeCode !== filtres.typeCode) continue;
      const p = plan.periodicite || {};
      let date = null; let estimee = false; let valeurCompteur = null; let unite = null; let rythme = null;
      if (p.type === 'compteur') {
        // Échéance sur compteur : date estimée par le module Préventif (rythme d'utilisation)
        if (!sPrev || typeof sPrev.analyser !== 'function') continue;
        let a = null;
        try { a = sPrev.analyser(plan); } catch (e) { a = null; }
        if (!a || !a.echeanceDate) continue;
        date = jourDe(a.echeanceDate); estimee = !!a.estimee; valeurCompteur = a.echeance; unite = a.unite; rythme = Number(a.rythmeJour) || null;
      } else date = jourDe(plan.prochaineEcheance);
      if (!date) continue;
      const e = plan.equipementId != null ? refs.equipements.get(Number(plan.equipementId)) : null;
      let periodiciteLibelle = '';
      if (sPrev && typeof sPrev.periodiciteLibelle === 'function') { try { periodiciteLibelle = sPrev.periodiciteLibelle(p, unite) || ''; } catch (err) { periodiciteLibelle = ''; } }
      const ouvert = ouverts.get(plan.id) || null;
      const base = {
        planId: plan.id, numero: plan.numero || '', nom: plan.nom || '', description: plan.description ? String(plan.description).slice(0, 300) : '',
        typeCode: plan.typeCode || null, typeLibelle: libelleType(refs, plan.typeCode), couleur: couleurType(refs, plan.typeCode), prioriteCode: plan.prioriteCode || null,
        equipementId: plan.equipementId == null ? null : plan.equipementId, equipementNom: e ? e.nom : '', equipementNumero: e ? e.numero || '' : '',
        equipementActif: e ? e.actif !== false : null,
        secteurId: plan.secteurId == null ? null : plan.secteurId, technicienId: plan.technicienId == null ? null : Number(plan.technicienId), technicienNom: nomDe(refs, plan.technicienId),
        dureeEstimee: nombreOuNull(plan.dureeEstimee), periodicite: p.type ? { type: p.type, valeur: p.valeur } : null, periodiciteLibelle,
        typePeriodicite: p.type === 'compteur' ? 'compteur' : 'date', uniteCompteur: unite, nbTaches: (plan.gamme || []).length,
        generable: !!generer && !ouvert && !(e && e.actif === false) && !(plan.equipementId != null && !e) && (!req || !req.perms || perms.canSeeRecord(req.perms, req.user, plan, { ecriture: true })),
      };
      const pousser = (k, jour, valeur) => {
        periode.push(Object.assign({}, base, {
          id: `pp-${plan.id}-${k}`, occurrence: k, date: jour, projection: k > 0, estimee: estimee || (k > 0 && p.type === 'compteur'),
          valeurCompteur: valeur, enRetard: k === 0 && jour < refs.aujourdhui, joursRestants: joursEntre(refs.aujourdhui, jour),
        }));
      };
      if (!ouvert) {
        if (date >= du && date <= au) pousser(0, date, valeurCompteur);
        else if (date < du && date < refs.aujourdhui) {
          enRetard.push(Object.assign({}, base, { id: `pp-${plan.id}-0`, occurrence: 0, date, projection: false, estimee, valeurCompteur, enRetard: true, joursRestants: joursEntre(refs.aujourdhui, date) }));
        }
      }
      if (!projection) continue;
      for (let k = 1; k <= MAX_OCCURRENCES; k++) {
        let jour = null; let valeur = null;
        if (p.type === 'compteur') {
          if (!rythme || !(Number(p.valeur) > 0)) break;
          valeur = arrondi(Number(valeurCompteur) + k * Number(p.valeur), 3);
          jour = ajouterJours(date, Math.max(1, Math.round((k * Number(p.valeur)) / rythme)));
        } else jour = ajouterPeriode(date, p, k);
        if (!jour || jour > au || !(Number(p.valeur) > 0)) break;
        if (jour >= du) pousser(k, jour, valeur);
      }
    }
    const tri = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.numero).localeCompare(String(b.numero), 'fr', { numeric: true }) || a.occurrence - b.occurrence;
    return { periode: periode.sort(tri), enRetard: enRetard.sort(tri) };
  }

  // ----- Calcul de la période -----------------------------------------------------------------------
  function periode(req, q) {
    q = q || {};
    const aujourdhui = dateLocale();
    const du = q.du == null || q.du === '' ? aujourdhui.slice(0, 8) + '01' : lireJour(q.du, 'La date de début (du)');
    const au = q.au == null || q.au === '' ? ajouterJours(ajouterMois(du.slice(0, 8) + '01', 1), -1) : lireJour(q.au, 'La date de fin (au)');
    if (au < du) throw new HttpError(400, 'La date de fin (au) doit être postérieure ou égale à la date de début (du)');
    if (joursEntre(du, au) > MAX_JOURS_PERIODE) throw new HttpError(400, `Période trop longue : ${MAX_JOURS_PERIODE} jours au maximum`);
    const filtres = lireFiltres(q);
    const projection = q.projection === '1' || q.projection === 'true';
    const finaux = !(q.finaux === '0' || q.finaux === 'false');
    const d = droits(req);
    const refs = references();
    const st = refs.st;

    const ot = []; const nonPlanifies = []; const otEnRetard = [];
    if (d.voirOt) {
      const correspond = (o) => filtreSecteur(filtres, o.secteurId)
        && (!filtres.sansTechnicien || (o.technicienId == null && !(o.techniciens || []).length))
        && (filtres.technicienId == null || estAffecte(filtres.technicienId, o))
        && (!filtres.typeCode || o.typeCode === filtres.typeCode);
      const debutAujourdhui = aujourdhui >= du && aujourdhui <= au;
      for (const o of db.list('ot')) {
        if (!peutVoirOt(req, o) || !correspond(o)) continue;
        const final = st.estFinal(o.statut);
        const jour = jourDe(o.datePrevue);
        if (jour) {
          if (jour >= du && jour <= au) { if (finaux || !final) ot.push(itemOt(o, refs, d, jour, req)); } else if (!final && jour < du && jour < aujourdhui) otEnRetard.push(itemOt(o, refs, d, jour, req));
          continue;
        }
        if (final) continue;
        nonPlanifies.push(itemOt(o, refs, d, null, req));
        // OT en cours sans date prévue : affiché aujourd'hui (ou à sa date de début) s'il tombe dans la période
        if (st.enCours && o.statut === st.enCours) {
          const debut = jourDe(o.dateDebut);
          const jourAffiche = debutAujourdhui ? aujourdhui : (debut && debut >= du && debut <= au ? debut : null);
          if (jourAffiche) ot.push(itemOt(o, refs, d, jourAffiche, req));
        }
      }
    }
    const ordrePrio = new Map(ctx.liste('priorites').map((p) => [p.code, p.ordre || 0]));
    ot.sort((a, b) => String(a.jour).localeCompare(String(b.jour)) || String(a.heure || '99').localeCompare(String(b.heure || '99')) || (ordrePrio.get(b.prioriteCode) || 0) - (ordrePrio.get(a.prioriteCode) || 0) || String(a.numero).localeCompare(String(b.numero), 'fr', { numeric: true }));
    nonPlanifies.sort((a, b) => (ordrePrio.get(b.prioriteCode) || 0) - (ordrePrio.get(a.prioriteCode) || 0) || a.id - b.id);
    otEnRetard.sort((a, b) => String(a.jour).localeCompare(String(b.jour)) || a.id - b.id);

    const ech = d.voirPreventif ? echeancesPlans(req, { du, au, filtres, projection, generer: d.generer }, refs) : { periode: [], enRetard: [] };

    // Charge : Σ durées estimées des OT de la période (hors annulés) par intervenant
    const hpj = heuresParJour();
    const nbOuvres = joursOuvres(du, au);
    const parUser = new Map();
    const ligne = (uid) => {
      const k = uid == null ? 'aucun' : Number(uid);
      if (!parUser.has(k)) parUser.set(k, { userId: uid == null ? null : Number(uid), nom: uid == null ? 'Non affecté' : nomDe(refs, uid), heures: 0, nbOt: 0, heuresPreventif: 0, nbEcheances: 0, parJour: {} });
      return parUser.get(k);
    };
    const visibles = techniciensVisibles(req);
    for (const t of visibles) if (filtres.technicienId == null || t.id === filtres.technicienId) { if (!filtres.sansTechnicien) ligne(t.id); }
    const accepte = (uid) => (filtres.technicienId == null || uid === filtres.technicienId) && (!filtres.sansTechnicien || uid == null);
    for (const o of ot) {
      if (o.annule || !o.jour) continue;
      const h = Number(o.dureeEstimee) || 0;
      const ids = Array.from(new Set([o.technicienId].concat(o.techniciens || []).filter((x) => x != null)));
      for (const uid of ids.length ? ids : [null]) {
        if (!accepte(uid)) continue;
        const l = ligne(uid);
        l.heures += h; l.nbOt += 1; l.parJour[o.jour] = arrondi((l.parJour[o.jour] || 0) + h);
      }
    }
    for (const e of ech.periode) {
      const uid = e.technicienId == null ? null : e.technicienId;
      if (!accepte(uid)) continue;
      const l = ligne(uid);
      l.heuresPreventif += Number(e.dureeEstimee) || 0; l.nbEcheances += 1;
    }
    const capacite = arrondi(hpj * nbOuvres);
    const charge = Array.from(parUser.values())
      .filter((l) => l.userId != null || l.nbOt || l.nbEcheances)
      .map((l) => Object.assign(l, { heures: arrondi(l.heures), heuresPreventif: arrondi(l.heuresPreventif), capacite, taux: capacite > 0 ? Math.round((l.heures / capacite) * 100) : null }))
      .sort((a, b) => (a.userId == null ? 1 : 0) - (b.userId == null ? 1 : 0) || a.nom.localeCompare(b.nom, 'fr'));

    const actifs = ot.filter((o) => !o.annule);
    return {
      du, au, aujourdhui, heuresParJour: hpj, joursOuvres: nbOuvres, projection,
      ot, echeances: ech.periode, nonPlanifies, charge,
      enRetard: { ot: otEnRetard, echeances: ech.enRetard },
      totaux: {
        nbOt: ot.length, heures: arrondi(actifs.reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0)),
        nbOuverts: ot.filter((o) => !o.final).length, nbEnRetard: ot.filter((o) => o.enRetard).length + otEnRetard.length,
        nbEcheances: ech.periode.length, heuresEcheances: arrondi(ech.periode.reduce((s, e) => s + (Number(e.dureeEstimee) || 0), 0)),
        nbEcheancesEnRetard: ech.enRetard.length + ech.periode.filter((e) => e.enRetard).length,
        nbNonPlanifies: nonPlanifies.length,
      },
      droits: d,
      legende: ctx.liste('typesIntervention').map((t) => ({ code: t.code, label: t.label, couleur: t.couleur || COULEUR_DEFAUT })),
    };
  }

  // ----- Routes : consultation ------------------------------------------------------------------------
  router.get('/api/planning', async (req) => periode(req, req.query), { perm: [MODULE, 'voir'] });

  router.get('/api/planning-techniciens', async (req) => techniciensVisibles(req), { perm: [MODULE, 'voir'] });

  // ----- Routes : replanification -----------------------------------------------------------------------
  function utilisateursActifs(ids) {
    return Array.from(new Set((ids || []).filter((x) => x != null).map(Number))).filter((id) => { const u = db.get('users', id); return u && u.actif !== false; });
  }
  function notifier(ids, exclureId, payload) {
    const cibles = utilisateursActifs(ids).filter((id) => exclureId == null || id !== Number(exclureId));
    if (cibles.length) ctx.notify(cibles, payload);
    return cibles;
  }
  function entreeHistorique(req, action, libelle, statut, commentaire, extra) {
    return Object.assign({ date: maintenant(), userId: req && req.user ? req.user.id : null, action, libelle, statut: statut || null, commentaire: commentaire || '' }, extra || {});
  }
  /** Conserve l'heure locale d'une date prévue horodatée lorsque seul le jour change. */
  function avecHeureConservee(nouvelle, ancienne) {
    if (!nouvelle || !RE_DATE.test(nouvelle) || !ancienne || RE_DATE.test(String(ancienne))) return nouvelle;
    const t = Date.parse(ancienne);
    if (Number.isNaN(t)) return nouvelle;
    const h = new Date(t);
    const { y, m, d } = decomposer(nouvelle);
    return new Date(y, m - 1, d, h.getHours(), h.getMinutes(), 0, 0).toISOString();
  }
  const libelleDate = (v) => (v ? formatDateFr(v) + (heureDe(v) ? ' ' + heureDe(v) : '') : 'non planifié');

  router.put('/api/planning/ot/:id', async (req) => {
    ctx.requirePerm(req, 'ot', 'voir');
    const o = otModifiable(req, req.params.id);
    const st = ST();
    if (st.estFinal(o.statut)) throw new HttpError(400, `L'ordre de travail ${o.numero} est clôturé (${st.libelle(o.statut)}) : il ne peut plus être replanifié`);
    const body = objet(req.body);
    if (body.datePrevue === undefined && body.technicienId === undefined) throw new HttpError(400, 'Indiquez la nouvelle date prévue et/ou le technicien');
    if (body.planifier !== undefined && typeof body.planifier !== 'boolean') throw new HttpError(400, 'Le champ « planifier » doit valoir vrai ou faux');

    const patch = {};
    const ancienneDate = o.datePrevue || null;
    const ancienTech = o.technicienId == null ? null : Number(o.technicienId);
    if (body.datePrevue !== undefined) {
      let d = lireDatePrevue(body.datePrevue);
      if (body.conserverHeure !== false) d = avecHeureConservee(d, ancienneDate);
      if (String(d || '') !== String(ancienneDate || '')) patch.datePrevue = d;
    }
    let techChange = false;
    if (body.technicienId !== undefined) {
      const tid = idRef(body.technicienId, 'Technicien');
      if (tid !== ancienTech) {
        if (tid != null) {
          const u = db.get('users', tid);
          if (!u || u.actif === false) throw new HttpError(400, 'Technicien introuvable ou désactivé');
          const p = perms.effectivePermissions(db, u, null, db.getConfig());
          if (!perms.can(p, 'ot', 'voir')) throw new HttpError(400, `${ctx.nomUser(u.id)} n'a pas accès au module Ordres de travail`);
          if (!techniciensVisibles(req).some((t) => t.id === tid)) throw new HttpError(400, `${ctx.nomUser(u.id)} est hors de votre périmètre (secteurs) : affectation impossible`);
        }
        techChange = true;
        let techniciens = (o.techniciens || []).map(Number).filter((x) => x !== ancienTech && x !== tid);
        if (tid != null) techniciens = [tid].concat(techniciens);
        patch.technicienId = tid;
        patch.techniciens = Array.from(new Set(techniciens));
      }
    }
    const dateChange = patch.datePrevue !== undefined;
    if (!dateChange && !techChange) return itemOt(o, references(), droits(req), undefined, req);

    // Planification automatique : un OT au statut initial daté passe « planifié » (et inversement)
    const nouvelleDate = dateChange ? patch.datePrevue : ancienneDate;
    let nouveauStatut = null;
    if (body.planifier !== false && st.planifie && st.planifie !== st.initial) {
      if (nouvelleDate && o.statut === st.initial) nouveauStatut = st.planifie;
      else if (!nouvelleDate && o.statut === st.planifie) nouveauStatut = st.initial;
    }

    const morceaux = [];
    if (dateChange) morceaux.push(`date prévue : ${libelleDate(ancienneDate)} → ${libelleDate(patch.datePrevue)}`);
    if (techChange) morceaux.push(`responsable : ${ctx.nomUser(ancienTech) || '—'} → ${ctx.nomUser(patch.technicienId) || '—'}`);
    const resumeModif = morceaux.join(' ; ');
    const historique = (o.historique || []).concat([entreeHistorique(req, techChange ? 'affectation' : 'modification', 'Replanification depuis le planning', o.statut, resumeModif)]);
    if (nouveauStatut) {
      patch.statut = nouveauStatut;
      historique.push(entreeHistorique(req, 'statut', 'Changement de statut', nouveauStatut, nouveauStatut === st.planifie ? 'Planification depuis le planning' : 'Retrait du planning', { ancien: o.statut }));
    }
    patch.historique = historique;
    const maj = db.update('ot', o.id, patch);

    ctx.audit(req, techChange ? 'affectation' : 'modification', 'ot', o.id, `OT ${o.numero} replanifié depuis le planning — ${resumeModif}`);
    if (nouveauStatut) ctx.audit(req, 'statut', 'ot', o.id, `OT ${o.numero} : ${st.libelle(o.statut)} → ${st.libelle(nouveauStatut)} (planning)`);

    // Notifications
    const quand = maj.datePrevue ? ` — prévu le ${libelleDate(maj.datePrevue)}` : ' — non planifié';
    const notifies = new Set();
    if (techChange && maj.technicienId != null) {
      notifier([maj.technicienId], req.user.id, { titre: `Affectation : OT ${maj.numero}`, message: `${maj.titre}${quand}`, lien: `#/ot/${maj.id}`, type: 'info' }).forEach((id) => notifies.add(id));
    }
    if (techChange && ancienTech != null) {
      notifier([ancienTech], req.user.id, { titre: `OT ${maj.numero} réaffecté`, message: `${maj.titre} — ${maj.technicienId != null ? 'confié à ' + ctx.nomUser(maj.technicienId) : 'vous n\'en êtes plus responsable'}`, lien: `#/ot/${maj.id}`, type: 'info' }).forEach((id) => notifies.add(id));
    }
    if (dateChange) {
      const autres = [maj.technicienId].concat(maj.techniciens || []).filter((id) => id != null && !notifies.has(Number(id)));
      notifier(autres, req.user.id, { titre: `OT ${maj.numero} replanifié`, message: `${maj.titre} — ${maj.datePrevue ? 'nouvelle date prévue : ' + libelleDate(maj.datePrevue) : 'retiré du planning (non planifié)'}`, lien: `#/ot/${maj.id}`, type: 'info' });
    }

    const champsModifies = Object.keys(patch).filter((k) => k !== 'historique');
    if (nouveauStatut) ctx.emit('ot:statut', Object.assign({}, maj, { ot: maj, ancien: o.statut, nouveau: nouveauStatut }));
    ctx.emit('ot:modifie', Object.assign({}, maj, { ot: maj, champsModifies, source: 'planning' }));
    ctx.emit('planning:replanifie', { ot: maj, ancien: { datePrevue: ancienneDate, technicienId: ancienTech, statut: o.statut }, nouveau: { datePrevue: maj.datePrevue || null, technicienId: maj.technicienId == null ? null : maj.technicienId, statut: maj.statut }, userId: req.user.id });
    return itemOt(maj, references(), droits(req), undefined, req);
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : génération d'un OT préventif ---------------------------------------------------------
  /** Création de l'OT d'un plan lorsque le module Préventif est absent (via le module OT, sinon en direct). */
  function creerOtDepuisPlan(req, plan, datePrevue, echeance) {
    const st = ST();
    const commentaire = `Généré depuis le planning (plan préventif ${plan.numero || plan.nom}, échéance du ${formatDateFr(echeance) || '—'})`;
    const sOt = ctx.services.ot;
    let ot = null;
    if (sOt && typeof sOt.creer === 'function') {
      const opts = { systeme: true, souple: true, source: 'plan', createdBy: req.user.id, commentaire };
      const corps = { planPreventifId: plan.id, datePrevue };
      try { ot = sOt.creer(corps, req, opts); } catch (e) {
        // Technicien du plan sans accès aux OT ou désactivé : création sans affectation plutôt qu'un échec
        if (plan.technicienId != null && e && e.status === 400) ot = sOt.creer(Object.assign({}, corps, { technicienId: null }), req, opts);
        else throw e;
      }
    } else {
      const tech = plan.technicienId != null ? db.get('users', plan.technicienId) : null;
      const technicienId = tech && tech.actif !== false ? tech.id : null;
      const gabarit = (ctx.config().numerotation || {}).ot || 'OT-{annee}-{num:4}';
      let numero = null;
      for (let i = 0; i < 1000 && !numero; i++) { const n = db.nextNumber('ot', gabarit); if (!db.findOne('ot', (x) => x.numero === n)) numero = n; }
      const codeOk = (nomListe, code, voulu) => { const l = ctx.liste(nomListe); if (code && (!l.length || l.some((x) => x.code === code))) return code; return l.some((x) => x.code === voulu) ? voulu : (l[0] ? l[0].code : voulu); };
      const record = {
        numero: numero || 'OT-' + Date.now(), titre: plan.nom, description: plan.description || '',
        typeCode: codeOk('typesIntervention', plan.typeCode, 'preventif'), prioriteCode: codeOk('priorites', plan.prioriteCode, 'normale'), statut: st.initial,
        equipementId: plan.equipementId == null ? null : plan.equipementId, secteurId: plan.secteurId == null ? null : plan.secteurId,
        demandeId: null, planPreventifId: plan.id, technicienId, techniciens: technicienId != null ? [technicienId] : [],
        datePrevue, dateDebut: null, dateFin: null, dureeEstimee: plan.dureeEstimee == null ? null : plan.dureeEstimee,
        tempsPasse: [], pieces: [], piecesPrevues: (plan.pieces || []).map((x) => { const a = db.get('articles', x.articleId); return { articleId: Number(x.articleId), code: a ? a.code || '' : '', designation: a ? a.designation || '' : '', quantite: Number(x.quantite) || 0 }; }),
        causeCode: null, rapport: '', commentaires: [], documents: [], coutPieces: 0, coutMainOeuvre: 0, coutExterne: 0, coutTotal: 0,
        fournisseurId: null, compteurReleve: null,
        taches: (plan.gamme || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map((g, i) => ({ ordre: i + 1, libelle: g.libelle, duree: g.duree == null ? null : g.duree, fait: false, faitPar: null, dateFait: null })),
        cloturePar: null, dateCloture: null, champs: {}, createdBy: req.user.id,
        historique: [entreeHistorique(req, 'creation', 'Ordre de travail créé', st.initial, commentaire)],
      };
      ot = db.insert('ot', record);
      ctx.audit(req, 'creation', 'ot', ot.id, `OT ${ot.numero} : ${ot.titre} (plan ${plan.numero || plan.id}, depuis le planning)`);
      if (technicienId != null) notifier([technicienId], req.user.id, { titre: `Nouvel ordre de travail : ${ot.numero}`, message: `${ot.titre} — prévu le ${formatDateFr(datePrevue)}`, lien: `#/ot/${ot.id}`, type: 'info' });
      ctx.emit('ot:cree', Object.assign({}, ot, { ot, source: 'plan' }));
    }
    if (!ot || ot.id == null) throw new HttpError(500, 'La création de l\'ordre de travail a échoué');
    const patchOt = { echeancePreventif: echeance };
    if (ot.planPreventifId == null) patchOt.planPreventifId = plan.id;
    if (!ot.datePrevue && datePrevue) patchOt.datePrevue = datePrevue;
    ot = db.update('ot', ot.id, patchOt) || ot;
    const majPlan = db.update('plansPreventifs', plan.id, { derniereGeneration: maintenant(), dernierOtGenereId: ot.id });
    ctx.audit(req, 'generation', 'plansPreventifs', plan.id, `Plan ${plan.numero || plan.id} : OT ${ot.numero} généré depuis le planning (échéance du ${formatDateFr(echeance) || '—'})`);
    ctx.emit('preventif:genere', { plan: majPlan || plan, ot });
    return ot;
  }

  router.post('/api/planning/preventif/:id/generer', async (req) => {
    ctx.requirePerm(req, 'preventif', 'voir');
    ctx.requirePerm(req, 'ot', 'creer');
    const plan = db.get('plansPreventifs', req.params.id);
    if (!plan) throw new HttpError(404, 'Plan préventif introuvable');
    if (!perms.canSeeRecord(req.perms, req.user, plan, { ecriture: true })) {
      if (perms.canSeeRecord(req.perms, req.user, plan)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : génération impossible');
      throw new HttpError(404, 'Plan préventif introuvable');
    }
    if (plan.actif === false) throw new HttpError(400, `Le plan « ${plan.numero || plan.nom} » est inactif : réactivez-le avant de générer un ordre de travail`);
    const st = ST();
    const ouvert = db.findOne('ot', (o) => Number(o.planPreventifId) === plan.id && !st.estFinal(o.statut));
    if (ouvert) throw new HttpError(400, `Un ordre de travail est déjà ouvert pour ce plan : ${ouvert.numero}`, { otId: ouvert.id });
    if (plan.equipementId != null) {
      const e = db.get('equipements', plan.equipementId);
      if (!e) throw new HttpError(400, 'L\'équipement du plan n\'existe plus');
      if (e.actif === false) throw new HttpError(400, `L'équipement « ${e.nom} » est inactif : génération impossible`);
    }
    const body = objet(req.body);
    const aujourdhui = dateLocale();
    let echeance = (plan.periodicite || {}).type === 'compteur' ? null : jourDe(plan.prochaineEcheance);
    const sPrev = ctx.services.preventif;
    if (!echeance && sPrev && typeof sPrev.analyser === 'function') { try { echeance = jourDe(sPrev.analyser(plan).echeanceDate); } catch (e) { echeance = null; } }
    let datePrevue = null;
    if (body.datePrevue !== undefined && body.datePrevue !== null && body.datePrevue !== '') {
      if (typeof body.datePrevue !== 'string' || !estDateValide(body.datePrevue.trim())) throw new HttpError(400, 'La date prévue est invalide (format attendu AAAA-MM-JJ)');
      datePrevue = body.datePrevue.trim();
    } else datePrevue = echeance && echeance >= aujourdhui ? echeance : aujourdhui;

    let ot = null;
    if (sPrev && (typeof sPrev.genererRapport === 'function' || typeof sPrev.generer === 'function')) {
      const options = { req, planId: plan.id, planIds: [plan.id], force: true, datePrevue };
      let ots = []; let motif = '';
      if (typeof sPrev.genererRapport === 'function') {
        const r = sPrev.genererRapport(options) || {};
        ots = r.ots || [];
        motif = (r.erreurs && r.erreurs[0] && r.erreurs[0].message) || (r.ignores && r.ignores[0] && r.ignores[0].motif) || '';
      } else ots = sPrev.generer(options) || [];
      if (!ots.length) throw new HttpError(400, motif ? `Génération impossible : ${motif}` : 'Aucun ordre de travail n\'a été généré pour ce plan');
      ot = db.get('ot', ots[0].id) || ots[0];
    } else ot = creerOtDepuisPlan(req, plan, datePrevue, echeance);
    return { ot: itemOt(ot, references(), droits(req), undefined, req), planId: plan.id };
  }, { perm: [MODULE, 'modifier'] });

  // ----- Services publiés --------------------------------------------------------------------------------
  ctx.services.planning = {
    /** Données de planning d'une période (mêmes options que GET /api/planning) pour une requête authentifiée. */
    periode: (req, options) => periode(req, options || {}),
    /** Charge par technicien sur une période (sans portée si req est absent). */
    charge({ du, au, req } = {}) {
      const r = req || { user: { id: 0 }, perms: { portee: 'tous', secteurIds: [], modules: { ot: { voir: true }, preventif: { voir: true } } } };
      return periode(r, { du, au }).charge;
    },
    techniciens: (req) => techniciensVisibles(req || null),
  };
}

/** Le planning n'a pas de données propres : il exploite les OT et les plans préventifs existants. */
function seedDemo() {
  return 'utilise les OT et les plans préventifs existants';
}

module.exports = { nom, register, seedDemo };
