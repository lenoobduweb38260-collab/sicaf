'use strict';
/**
 * Module Ordres de travail (OT) — module central de la GMAO.
 *
 * Cycle de vie : création (manuelle, depuis une demande d'intervention, depuis un plan préventif,
 * par duplication) → affectation (responsable + intervenants, date prévue) → réalisation (statuts
 * non finaux, gamme de tâches, temps passés, pièces sorties du stock, compte rendu) → clôture
 * (statut final « terminé ») ou annulation ; réouverture possible.
 * Les statuts proviennent de la liste configurable `statutsOT` (`final: true` = clôturé) ; les
 * codes par défaut (nouveau, planifie, en_cours, en_attente, termine, annule) ne servent que de repli.
 *
 * Droits : ot.voir (consultation, commentaires), ot.creer (création, duplication), ot.modifier
 *   (modification complète, statuts, réouverture), ot.affecter (techniciens), ot.cloturer (statuts
 *   finaux), ot.supprimer, ot.exporter. Un technicien affecté (responsable ou intervenant) peut, sans
 *   le droit « modifier », renseigner la réalisation et faire avancer l'OT ; il peut le clôturer si
 *   config.workflow.autoriserTechnicienCloture est actif.
 * Portée : celle de l'utilisateur (ctx.canSee), étendue aux OT dont il est créateur ou intervenant.
 *
 * Services publiés   : ctx.services.ot.{ creerDepuisDemande(demande, req), ouvertsPour({ equipementId, planPreventifId }),
 *                      creer(donnees, req, options), get(id), estFinal(code), enRetard(ot), statuts() }
 * Événements émis    : 'ot:cree', 'ot:modifie', 'ot:statut' ({ ot, ancien, nouveau }), 'ot:termine', 'ot:annule',
 *                      'ot:supprime'. Charge utile : copie de l'OT complétée de { ot, ancien?, nouveau? }
 *                      (lisible indifféremment comme `data.ot` ou comme l'OT lui-même).
 * Services consommés : ctx.services.stock.{ sortir, annulerSortie }, ctx.services.equipements.{ releverCompteur, visible, chemin }.
 */
const nom = 'Ordres de travail';
const ENTITE = 'ot';
const TAILLE_MAX_DOC = 5 * 1024 * 1024; // 5 Mo par document
const MAX_DOCS = 30;
const MAX_COMMENTAIRE = 4000;
const MAX_RAPPORT = 20000;
const MAX_TACHES = 200;
const MAX_TEMPS = 1000;
const MAX_PIECES = 500;

/** Statuts de repli (utilisés uniquement si la liste `statutsOT` est vide). */
const STATUTS_DEFAUT = [
  { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
  { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
  { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
  { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
  { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
  { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
];

const LIBELLES_ETAPES = {
  creation: 'Ordre de travail créé', duplication: 'Créé par duplication', affectation: 'Affectation', statut: 'Changement de statut',
  cloture: 'Ordre de travail clôturé', annulation: 'Ordre de travail annulé', reouverture: 'Ordre de travail réouvert', modification: 'Modification',
};

/** Champs que le technicien affecté peut modifier sans le droit « modifier ». */
const CHAMPS_REALISATION = ['rapport', 'causeCode', 'compteurReleve', 'coutExterne', 'fournisseurId', 'dateDebut', 'dateFin'];
/** Champs de planification réservés au droit « modifier ». */
const CHAMPS_PLANIFICATION = ['titre', 'description', 'typeCode', 'prioriteCode', 'equipementId', 'secteurId', 'datePrevue', 'dureeEstimee', 'champs'];

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function pad(n) { return String(n).padStart(2, '0'); }
/** Date locale AAAA-MM-JJ. */
function dateLocale(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Jour local (AAAA-MM-JJ) d'une date ou d'un horodatage ISO. */
function jourDe(s) {
  if (!s) return '';
  if (RE_DATE.test(String(s))) return String(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : dateLocale(new Date(t));
}
/** Horodatage (ms) d'une date AAAA-MM-JJ (minuit local) ou ISO. */
function horodatage(s) {
  if (!s) return null;
  if (RE_DATE.test(String(s))) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
function arrondi(n, dec = 2) { const f = 10 ** dec; return Math.round((Number(n) || 0) * f) / f; }
function objet(b) { return b && typeof b === 'object' && !Buffer.isBuffer(b) && !Array.isArray(b) ? b : {}; }

/** Outils de lecture de la liste de statuts configurée (codes sémantiques résolus avec repli). */
function outilsStatuts(listeConfiguree) {
  const liste = Array.isArray(listeConfiguree) && listeConfiguree.length ? listeConfiguree.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : STATUTS_DEFAUT;
  const item = (code) => liste.find((s) => s.code === code) || null;
  const estFinal = (code) => { const s = item(code); return !!(s && s.final); };
  const estAnnulation = (code) => { const s = item(code); return !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || ''))); };
  const nonFinal = (code, re) => { const s = item(code); if (s && !s.final) return s.code; const t = liste.find((x) => !x.final && re.test(`${x.code} ${x.label || ''}`)); return t ? t.code : null; };
  const finaux = liste.filter((s) => s.final);
  const termine = (finaux.find((s) => s.code === 'termine') || finaux.find((s) => !estAnnulation(s.code)) || finaux[0] || { code: 'termine' }).code;
  const annuleItem = finaux.find((s) => s.code === 'annule') || finaux.find((s) => estAnnulation(s.code));
  return {
    liste, item, estFinal, estAnnulation, termine,
    annule: annuleItem && annuleItem.code !== termine ? annuleItem.code : null,
    initial: (liste.find((s) => !s.final) || { code: 'nouveau' }).code,
    enCours: nonFinal('en_cours', /cours/i),
    attente: nonFinal('en_attente', /attente/i),
    planifie: nonFinal('planifie', /planifi/i),
    finaux: new Set(finaux.map((s) => s.code)),
    libelle: (code) => { const s = item(code); return s ? s.label : String(code == null ? '' : code); },
  };
}

/** Calcul des coûts et du temps total d'un OT. */
function calculerCouts(o, tauxHoraire) {
  const taux = Number(tauxHoraire) || 0;
  const tempsTotal = arrondi((o.tempsPasse || []).reduce((s, t) => s + (Number(t.heures) || 0), 0));
  const coutMainOeuvre = arrondi(tempsTotal * taux);
  const coutPieces = arrondi((o.pieces || []).reduce((s, p) => s + (Number(p.quantite) || 0) * (Number(p.prixUnitaire) || 0), 0));
  const coutExterne = arrondi(Number(o.coutExterne) || 0);
  return { tempsTotal, coutMainOeuvre, coutPieces, coutExterne, coutTotal: arrondi(coutMainOeuvre + coutPieces + coutExterne) };
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const can = (req, action) => !!(req && req.perms && perms.can(req.perms, ENTITE, action));
  const wf = () => ctx.config().workflow || {};
  const ST = () => outilsStatuts(ctx.liste('statutsOT'));
  const taux = () => Number((ctx.config().general || {}).tauxHoraire) || 0;
  const maintenant = () => new Date().toISOString();

  // ----- Portée -------------------------------------------------------------
  function estAffecte(uid, o) {
    if (uid == null || !o) return false;
    uid = Number(uid);
    return Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid));
  }
  /** Portée standard, étendue aux OT dont l'utilisateur est créateur ou intervenant. */
  function peutVoir(req, o) {
    if (!o) return false;
    if (ctx.canSee(req, o)) return true;
    return estAffecte(req.user.id, o) || Number(o.createdBy) === req.user.id;
  }
  const portee = (req, rows) => rows.filter((o) => peutVoir(req, o));
  function getVisible(req, id) {
    const o = db.get(ENTITE, id);
    if (!o || !peutVoir(req, o)) throw new HttpError(404, 'Ordre de travail introuvable');
    return o;
  }
  function equipementVisible(req, e) {
    if (!req || !req.perms) return true;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { return ctx.canSee(req, e); } }
    return ctx.canSee(req, e);
  }
  /** Un utilisateur limité à ses secteurs ne rattache un OT qu'à ses propres secteurs. */
  function verifierPorteeSecteur(req, secteurId) {
    if (!req || !req.perms || req.perms.portee !== 'secteurs' || secteurId == null) return;
    if (!req.perms.secteurIds.includes(Number(secteurId))) throw new HttpError(403, 'Ce secteur est hors de votre périmètre : vous ne pouvez gérer que les ordres de travail de vos secteurs');
  }
  function peutRealiser(req, o) { return can(req, 'modifier') || estAffecte(req.user.id, o); }
  function peutCloturer(req, o) { return can(req, 'cloturer') || (wf().autoriserTechnicienCloture !== false && estAffecte(req.user.id, o)); }
  function exigerRealisation(req, o) {
    if (!peutRealiser(req, o)) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Modifier (ou être technicien affecté à cet ordre de travail)');
  }
  function exigerOuvert(o, st) {
    st = st || ST();
    if (st.estFinal(o.statut)) throw new HttpError(400, `L'ordre de travail ${o.numero} est clôturé (${st.libelle(o.statut)}) : réouvrez-le pour le modifier`);
  }

  // ----- Validation des entrées --------------------------------------------
  function texte(v, label, { requis = false, min = 0, max = 1000 } = {}) {
    if (v != null && typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${label} : valeur invalide`);
    const s = v == null ? '' : String(v).trim();
    if (requis && !s) throw new HttpError(400, `${label} est obligatoire`);
    if (s && s.length < min) throw new HttpError(400, `${label} doit contenir au moins ${min} caractères`);
    if (s.length > max) throw new HttpError(400, `${label} ne doit pas dépasser ${max} caractères`);
    return s;
  }
  function nombre(v, label, { requis = false, min = null, max = null, positif = false } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis) throw new HttpError(400, `${label} est obligatoire`);
      return null;
    }
    if (typeof v === 'boolean' || (typeof v !== 'number' && typeof v !== 'string')) throw new HttpError(400, `${label} doit être un nombre`);
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} doit être un nombre`);
    if (positif && n <= 0) throw new HttpError(400, `${label} doit être strictement positif`);
    if (min != null && n < min) throw new HttpError(400, `${label} doit être supérieur ou égal à ${min}`);
    if (max != null && n > max) throw new HttpError(400, `${label} ne doit pas dépasser ${max}`);
    return n;
  }
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function lireDate(v, label) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new HttpError(400, `${label} invalide`);
    const s = v.trim();
    let t;
    if (RE_DATE.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new HttpError(400, `${label} invalide`);
      t = dt.getTime();
    } else {
      t = Date.parse(s);
      if (Number.isNaN(t)) throw new HttpError(400, `${label} invalide`);
    }
    const annee = new Date(t).getFullYear();
    if (annee < 1990 || annee > 2100) throw new HttpError(400, `${label} hors limites`);
    return RE_DATE.test(s) ? s : new Date(t).toISOString();
  }
  /** Code d'une liste de valeurs : vide → défaut ; inconnu → 400. */
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
  function codeSouple(nomListe, code, voulu) {
    const l = ctx.liste(nomListe);
    if (code && (!l.length || l.some((x) => x.code === code))) return code;
    return codeParDefaut(nomListe, voulu);
  }
  /** Champs personnalisés sans contrôle « obligatoire » (créations automatiques). */
  function champsPersoSouples(input) {
    try { return ctx.champsPerso(ENTITE, input || {}); } catch (e) {
      const defs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
      const out = {};
      for (const d of defs) out[d.cle] = input && input[d.cle] !== undefined && input[d.cle] !== '' ? input[d.cle] : null;
      return out;
    }
  }
  function utilisateurActif(id, label) {
    const u = db.get('users', id);
    if (!u || u.actif === false) throw new HttpError(400, `${label} : utilisateur introuvable ou désactivé`);
    return u;
  }
  function aAccesOt(u) {
    const p = perms.effectivePermissions(db, u, null, db.getConfig());
    return perms.can(p, ENTITE, 'voir');
  }
  /** Lit technicienId / techniciens ; seuls les identifiants nouveaux sont contrôlés. */
  function lireAffectation(body, existant) {
    const anciens = new Set(existant ? [existant.technicienId].concat(existant.techniciens || []).filter((x) => x != null).map(Number) : []);
    let technicienId = body.technicienId !== undefined ? idRef(body.technicienId, 'Technicien responsable') : (existant && existant.technicienId != null ? Number(existant.technicienId) : null);
    let techniciens;
    if (body.techniciens !== undefined && body.techniciens !== null) {
      if (!Array.isArray(body.techniciens)) throw new HttpError(400, 'La liste des intervenants doit être un tableau');
      if (body.techniciens.length > 50) throw new HttpError(400, 'Trop d\'intervenants (50 au maximum)');
      techniciens = body.techniciens.map((x) => idRef(x, 'Intervenant')).filter((x) => x != null);
    } else techniciens = existant ? (existant.techniciens || []).map(Number) : [];
    const verifier = (id, label) => {
      if (anciens.has(id)) return;
      const u = utilisateurActif(id, label);
      if (!aAccesOt(u)) throw new HttpError(400, `${ctx.nomUser(u.id)} n'a pas accès au module Ordres de travail`);
    };
    if (technicienId != null) verifier(technicienId, 'Technicien responsable');
    for (const t of techniciens) verifier(t, 'Intervenant');
    if (technicienId != null && !techniciens.includes(technicienId)) techniciens.unshift(technicienId);
    techniciens = Array.from(new Set(techniciens));
    if (technicienId == null && techniciens.length && body.technicienId === undefined && !(existant && existant.technicienId != null)) technicienId = techniciens[0];
    return { technicienId, techniciens };
  }

  /**
   * Lecture des champs de planification (création ou modification complète).
   * `req` peut être nul pour une création système (pas de contrôle de portée).
   */
  function lireCorps(req, body, existant, opts = {}) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (!existant || has('titre')) out.titre = texte(body.titre, 'Le titre', { requis: true, min: 3, max: 200 });
    if (!existant || has('description')) out.description = texte(body.description, 'La description', { max: 10000 });
    if (!existant || has('typeCode')) out.typeCode = codeListe('typesIntervention', body.typeCode, 'Type d\'intervention', existant ? existant.typeCode : codeParDefaut('typesIntervention', 'correctif'));
    if (!existant || has('prioriteCode')) out.prioriteCode = codeListe('priorites', body.prioriteCode, 'Priorité', existant ? existant.prioriteCode : codeParDefaut('priorites', 'normale'));
    let secteurChange = !existant;
    if (!existant || has('equipementId')) {
      const id = idRef(body.equipementId, 'Équipement');
      if (id != null) {
        const e = db.get('equipements', id);
        if (!e || !equipementVisible(req, e)) throw new HttpError(400, 'Équipement introuvable ou hors de votre périmètre');
        if (e.actif === false && !opts.tolererInactif && (!existant || Number(existant.equipementId) !== id)) throw new HttpError(400, `L'équipement « ${e.nom} » est inactif : impossible d'y rattacher un ordre de travail`);
        out.equipementId = id;
        out.secteurId = e.secteurId == null || e.secteurId === '' ? null : Number(e.secteurId);
        secteurChange = !existant || Number(existant.secteurId) !== Number(out.secteurId);
      } else out.equipementId = null;
    }
    const equipementFinal = out.equipementId !== undefined ? out.equipementId : (existant ? existant.equipementId : null);
    if (equipementFinal == null && (!existant || has('secteurId') || has('equipementId'))) {
      let sid;
      if (has('secteurId')) sid = idRef(body.secteurId, 'Secteur');
      else sid = existant ? (existant.secteurId == null ? null : Number(existant.secteurId)) : null;
      if (sid != null && !db.get('secteurs', sid)) throw new HttpError(400, 'Secteur introuvable');
      out.secteurId = sid;
      secteurChange = secteurChange || !existant || Number(existant.secteurId) !== Number(sid);
    }
    if (out.secteurId !== undefined && secteurChange) verifierPorteeSecteur(req, out.secteurId);
    if (!existant || has('datePrevue')) out.datePrevue = lireDate(body.datePrevue, 'La date prévue');
    if (!existant || has('dureeEstimee')) out.dureeEstimee = nombre(body.dureeEstimee, 'La durée estimée', { min: 0, max: 10000 });
    if (!existant || has('fournisseurId')) {
      const fid = idRef(body.fournisseurId, 'Prestataire');
      if (fid != null && !db.get('fournisseurs', fid)) throw new HttpError(400, 'Prestataire (fournisseur) introuvable');
      out.fournisseurId = fid;
    }
    if (!existant || has('coutExterne')) out.coutExterne = nombre(body.coutExterne, 'Le coût externe', { min: 0, max: 1e9 }) || 0;
    if (opts.champsSouples) out.champs = champsPersoSouples(objet(body.champs));
    else if (!existant || has('champs')) {
      const src = Object.assign({}, existant ? existant.champs || {} : {}, objet(body.champs));
      out.champs = ctx.champsPerso(ENTITE, src);
    }
    return out;
  }

  /** Lecture des champs de réalisation (technicien affecté ou droit « modifier »). */
  function lireRealisation(body, existant) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (has('rapport')) out.rapport = texte(body.rapport, 'Le compte rendu', { max: MAX_RAPPORT });
    if (has('causeCode')) out.causeCode = codeListe('causesPanne', body.causeCode, 'Cause de panne', null);
    if (has('compteurReleve')) out.compteurReleve = nombre(body.compteurReleve, 'Le relevé de compteur', { min: 0, max: 1e12 });
    if (has('coutExterne')) out.coutExterne = nombre(body.coutExterne, 'Le coût externe', { min: 0, max: 1e9 }) || 0;
    if (has('fournisseurId')) {
      const fid = idRef(body.fournisseurId, 'Prestataire');
      if (fid != null && !db.get('fournisseurs', fid)) throw new HttpError(400, 'Prestataire (fournisseur) introuvable');
      out.fournisseurId = fid;
    }
    if (has('dateDebut')) out.dateDebut = lireDate(body.dateDebut, 'La date de début');
    if (has('dateFin')) out.dateFin = lireDate(body.dateFin, 'La date de fin');
    const debut = out.dateDebut !== undefined ? out.dateDebut : (existant ? existant.dateDebut : null);
    const fin = out.dateFin !== undefined ? out.dateFin : (existant ? existant.dateFin : null);
    verifierDebutFin(debut, fin);
    return out;
  }
  function verifierDebutFin(debut, fin) {
    if (!debut || !fin) return;
    const dateSeule = RE_DATE.test(String(debut)) || RE_DATE.test(String(fin));
    // Comparaison à la minute près : les champs date-heure de l'interface sont saisis à la minute,
    // alors que le démarrage est horodaté à la seconde (démarrage et clôture dans la même minute).
    const ko = dateSeule ? jourDe(fin) < jourDe(debut) : Math.floor(horodatage(fin) / 60000) < Math.floor(horodatage(debut) / 60000);
    if (ko) throw new HttpError(400, 'La date de fin doit être postérieure à la date de début');
  }

  // ----- Utilitaires --------------------------------------------------------
  function entree(req, action, statut, commentaire, extra) {
    return Object.assign({ date: maintenant(), userId: req && req.user ? req.user.id : null, action, libelle: LIBELLES_ETAPES[action] || action, statut: statut || null, commentaire: commentaire || '' }, extra || {});
  }
  function charge(o, extra) { return Object.assign({}, o, { ot: o }, extra || {}); }
  function numeroUnique() {
    const gabarit = (ctx.config().numerotation || {}).ot || 'OT-{annee}-{num:4}';
    for (let i = 0; i < 1000; i++) {
      const n = db.nextNumber(ENTITE, gabarit);
      if (!db.findOne(ENTITE, (x) => x.numero === n)) return n;
    }
    return 'OT-' + Date.now();
  }
  function avecCouts(o, patch) {
    const fusion = Object.assign({}, o, patch);
    const c = calculerCouts(fusion, taux());
    return Object.assign(patch, { coutPieces: c.coutPieces, coutMainOeuvre: c.coutMainOeuvre, coutExterne: c.coutExterne, coutTotal: c.coutTotal });
  }
  function enRetard(o, aujourdhui, st) {
    st = st || ST();
    if (!o || !o.datePrevue || st.estFinal(o.statut)) return false;
    return jourDe(o.datePrevue) < (aujourdhui || dateLocale());
  }
  function utilisateursActifs(ids) {
    return Array.from(new Set((ids || []).filter((x) => x != null).map(Number))).filter((id) => { const u = db.get('users', id); return u && u.actif !== false; });
  }
  function notifier(ids, exclureId, payload) {
    const cibles = utilisateursActifs(ids).filter((id) => exclureId == null || id !== Number(exclureId));
    if (cibles.length) ctx.notify(cibles, payload);
    return cibles;
  }
  function demandeurDe(o) {
    if (o.demandeId == null) return null;
    const d = db.get('demandes', o.demandeId);
    return d ? (d.demandeurId == null ? d.createdBy : d.demandeurId) : null;
  }
  /** Planificateurs (droit « affecter ») concernés par le secteur d'un OT. */
  function planificateurs(o) {
    return ctx.usersAvecDroit(ENTITE, 'affecter', (u, p) => p.portee === 'tous' || o.secteurId == null || p.secteurIds.includes(Number(o.secteurId))).map((u) => u.id);
  }
  function cheminSecteur(secteurs, id) {
    const parts = []; let cur = id == null ? null : secteurs.get(Number(id)); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? secteurs.get(Number(cur.parentId)) : null; }
    return parts.join(' › ');
  }
  function references() {
    return {
      equipements: new Map(db.list('equipements').map((e) => [e.id, e])),
      secteurs: new Map(db.list('secteurs').map((s) => [s.id, s])),
      demandes: new Map(db.list('demandes').map((d) => [d.id, d])),
      plans: new Map(db.list('plansPreventifs').map((p) => [p.id, p])),
      users: new Map(db.list('users').map((u) => [u.id, u])),
      fournisseurs: new Map(db.list('fournisseurs').map((f) => [f.id, f])),
      aujourdhui: dateLocale(),
      st: ST(),
      taux: taux(),
    };
  }
  function nomDe(refs, id) {
    const u = id == null ? null : refs.users.get(Number(id));
    return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '';
  }
  function estImage(type) { return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(type || ''); }
  function resumeDoc(d, i) { return { index: i, nom: d.nom, type: d.type, taille: d.taille, date: d.date, userId: d.userId, userNom: ctx.nomUser(d.userId), description: d.description || '', estImage: estImage(d.type) }; }

  /**
   * Fiches équipement ouvrables par l'utilisateur (droit equipements.voir et portée) : un intervenant peut
   * voir un OT sur un équipement hors de ses secteurs sans pouvoir ouvrir la fiche de l'équipement.
   */
  function equipementsAccessibles(req) {
    const cache = new Map();
    const voirEq = !!(req && req.perms && perms.can(req.perms, 'equipements', 'voir'));
    return (id) => {
      if (id == null || !voirEq) return false;
      const k = Number(id);
      if (!cache.has(k)) {
        const e = db.get('equipements', k);
        const sEq = ctx.services.equipements;
        let ok = false;
        if (e) { try { ok = sEq && typeof sEq.visible === 'function' ? !!sEq.visible(req, e) : ctx.canSee(req, e); } catch (err) { ok = false; } }
        cache.set(k, ok);
      }
      return cache.get(k);
    };
  }
  /** Vue allégée pour les listes (sans contenu des documents). */
  function resume(o, refs) {
    refs = refs || references();
    const { documents, ...reste } = o;
    const e = o.equipementId != null ? refs.equipements.get(Number(o.equipementId)) : null;
    const d = o.demandeId != null ? refs.demandes.get(Number(o.demandeId)) : null;
    const p = o.planPreventifId != null ? refs.plans.get(Number(o.planPreventifId)) : null;
    const f = o.fournisseurId != null ? refs.fournisseurs.get(Number(o.fournisseurId)) : null;
    const s = o.secteurId != null ? refs.secteurs.get(Number(o.secteurId)) : null;
    const taches = o.taches || [];
    const tempsTotal = arrondi((o.tempsPasse || []).reduce((acc, t) => acc + (Number(t.heures) || 0), 0));
    return Object.assign(reste, {
      equipementNom: e ? e.nom : '', equipementNumero: e ? e.numero || '' : '',
      secteurNom: s ? s.nom : '', secteurChemin: cheminSecteur(refs.secteurs, o.secteurId),
      technicienNom: nomDe(refs, o.technicienId),
      techniciensNoms: (o.techniciens || []).map((id) => nomDe(refs, id)).filter(Boolean),
      createdByNom: nomDe(refs, o.createdBy),
      demandeNumero: d ? d.numero || '' : '', planNumero: p ? p.numero || '' : '', planNom: p ? p.nom || '' : '',
      fournisseurNom: f ? f.nom || '' : '',
      statutLibelle: refs.st.libelle(o.statut),
      final: refs.st.estFinal(o.statut),
      enRetard: enRetard(o, refs.aujourdhui, refs.st),
      tempsTotal,
      coutPieces: arrondi(o.coutPieces || 0), coutMainOeuvre: arrondi(o.coutMainOeuvre || 0), coutExterne: arrondi(o.coutExterne || 0),
      coutTotal: arrondi((Number(o.coutPieces) || 0) + (Number(o.coutMainOeuvre) || 0) + (Number(o.coutExterne) || 0)),
      nbTaches: taches.length, nbTachesFaites: taches.filter((t) => t.fait).length,
      nbCommentaires: (o.commentaires || []).length, nbDocuments: (documents || []).length, nbPieces: (o.pieces || []).length,
    });
  }

  function actionsPour(req, o, st) {
    st = st || ST();
    const final = st.estFinal(o.statut);
    const modif = can(req, 'modifier');
    const realiser = peutRealiser(req, o);
    const cloturer = peutCloturer(req, o);
    return {
      modifier: modif && !final,
      realiser: realiser && !final,
      affecter: can(req, 'affecter') && !final,
      demarrer: realiser && !final && !!st.enCours && o.statut !== st.enCours && o.statut !== st.attente,
      reprendre: realiser && !final && !!st.enCours && !!st.attente && o.statut === st.attente,
      mettreEnAttente: realiser && !final && !!st.attente && o.statut === st.enCours,
      cloturer: cloturer && !final,
      annuler: cloturer && !final && !!st.annule,
      reouvrir: modif && final,
      supprimer: can(req, 'supprimer') && o.statut !== st.termine && !(o.pieces || []).length,
      dupliquer: can(req, 'creer'),
      commenter: true,
      joindre: realiser,
      supprimerDocuments: modif,
      saisirPourAutrui: modif || can(req, 'affecter'),
    };
  }

  /** Fiche complète (enrichie). */
  function detail(req, o) {
    const refs = references();
    const base = resume(o, refs);
    const e = o.equipementId != null ? refs.equipements.get(Number(o.equipementId)) : null;
    const d = o.demandeId != null ? refs.demandes.get(Number(o.demandeId)) : null;
    const p = o.planPreventifId != null ? refs.plans.get(Number(o.planPreventifId)) : null;
    const f = o.fournisseurId != null ? refs.fournisseurs.get(Number(o.fournisseurId)) : null;
    const sEq = ctx.services.equipements;
    let cheminEq = '';
    if (e && sEq && typeof sEq.chemin === 'function') { try { cheminEq = sEq.chemin(e.id); } catch (err) { cheminEq = ''; } }
    const articles = new Map(db.list('articles').map((a) => [a.id, a]));
    const mouvements = db.list('mouvementsStock', (m) => Number(m.otId) === o.id)
      .sort((a, b) => String(a.date || a.createdAt || '').localeCompare(String(b.date || b.createdAt || '')))
      .map((m) => { const a = articles.get(Number(m.articleId)); return Object.assign({}, m, { articleCode: a ? a.code || '' : '', articleDesignation: a ? a.designation || '' : '', userNom: nomDe(refs, m.userId) }); });
    const couts = calculerCouts(o, refs.taux);
    const stock = ctx.services.stock;
    return Object.assign(base, {
      equipement: e ? {
        id: e.id, numero: e.numero || '', nom: e.nom, secteurId: e.secteurId == null ? null : e.secteurId, localisation: e.localisation || '',
        etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null, typeCode: e.typeCode || null, marque: e.marque || '', modele: e.modele || '',
        compteur: e.compteur || null, parentId: e.parentId == null ? null : e.parentId, actif: e.actif !== false, chemin: cheminEq,
        accessible: equipementsAccessibles(req)(e.id),
      } : null,
      demande: d ? { id: d.id, numero: d.numero || '', titre: d.titre || '', statut: d.statut || null, demandeurId: d.demandeurId == null ? null : d.demandeurId, demandeurNom: nomDe(refs, d.demandeurId), dateDemande: d.dateDemande || d.createdAt || null, arretProduction: !!d.arretProduction, prioriteCode: d.prioriteCode || null } : null,
      plan: p ? { id: p.id, numero: p.numero || '', nom: p.nom || '', periodicite: p.periodicite || null, prochaineEcheance: p.prochaineEcheance == null ? null : p.prochaineEcheance, derniereExecution: p.derniereExecution == null ? null : p.derniereExecution } : null,
      fournisseur: f ? { id: f.id, nom: f.nom || '', telephone: f.telephone || '', email: f.email || '' } : null,
      mouvements,
      documents: (o.documents || []).map(resumeDoc),
      commentaires: (o.commentaires || []).map((c, i) => Object.assign({}, c, { index: i, userNom: nomDe(refs, c.userId) })),
      tempsPasse: (o.tempsPasse || []).map((t, i) => Object.assign({}, t, { index: i, userNom: nomDe(refs, t.userId) })),
      pieces: (o.pieces || []).map((pc, i) => Object.assign({}, pc, { index: i, montant: arrondi((Number(pc.quantite) || 0) * (Number(pc.prixUnitaire) || 0)) })),
      piecesPrevues: (o.piecesPrevues || []).map((pc) => { const a = articles.get(Number(pc.articleId)); return Object.assign({}, pc, { designation: pc.designation || (a ? a.designation : ''), code: pc.code || (a ? a.code || '' : ''), disponible: a ? Number(a.quantite) || 0 : null }); }),
      taches: (o.taches || []).map((t, i) => Object.assign({}, t, { index: i, faitParNom: nomDe(refs, t.faitPar) })),
      historique: (o.historique || []).map((h) => Object.assign({}, h, { userNom: h.userId == null ? 'Système' : nomDe(refs, h.userId) })),
      clotureParNom: nomDe(refs, o.cloturePar),
      tauxHoraire: refs.taux,
      coutTheorique: couts,
      actions: actionsPour(req, o, refs.st),
      stockDisponible: !!(stock && typeof stock.sortir === 'function'),
    });
  }

  // ----- Création ------------------------------------------------------------
  function tachesDepuis(liste) {
    if (liste === undefined || liste === null) return [];
    if (!Array.isArray(liste)) throw new HttpError(400, 'La gamme (liste des tâches) doit être un tableau');
    if (liste.length > MAX_TACHES) throw new HttpError(400, `Trop de tâches (${MAX_TACHES} au maximum)`);
    return liste.map((t, i) => {
      const libelle = texte(typeof t === 'string' ? t : (t && t.libelle), 'Le libellé de la tâche', { requis: true, max: 300 });
      const duree = t && typeof t === 'object' ? nombre(t.duree, 'La durée de la tâche', { min: 0, max: 1000 }) : null;
      return { ordre: i + 1, libelle, duree, fait: false, faitPar: null, dateFait: null };
    });
  }

  /**
   * Crée un OT. options : { systeme (pas de contrôle de droits/portée), createdBy, source, souple (champs perso non bloquants) }.
   */
  function creer(req, body, options = {}) {
    body = objet(body);
    const st = ST();
    const systeme = !!options.systeme;
    const reqCtl = systeme ? null : req;
    // Plan préventif : valeurs par défaut et gamme
    let plan = null;
    const planId = idRef(body.planPreventifId, 'Plan préventif');
    if (planId != null) { plan = db.get('plansPreventifs', planId); if (!plan) throw new HttpError(400, 'Plan préventif introuvable'); }
    // Demande d'origine
    let demande = null;
    const demandeId = idRef(body.demandeId, 'Demande d\'intervention');
    if (demandeId != null) {
      demande = db.get('demandes', demandeId);
      if (!demande) throw new HttpError(400, 'Demande d\'intervention introuvable');
      const existant = db.findOne(ENTITE, (o) => Number(o.demandeId) === demandeId && !st.estAnnulation(o.statut));
      if (existant) throw new HttpError(400, `Cette demande est déjà liée à l'ordre de travail ${existant.numero}`);
    }
    const defauts = {};
    if (plan) Object.assign(defauts, { titre: plan.nom, description: plan.description || '', typeCode: codeSouple('typesIntervention', plan.typeCode, 'preventif'), prioriteCode: codeSouple('priorites', plan.prioriteCode, 'normale'), equipementId: plan.equipementId == null ? undefined : plan.equipementId, secteurId: plan.secteurId == null ? undefined : plan.secteurId, dureeEstimee: plan.dureeEstimee == null ? undefined : plan.dureeEstimee, technicienId: plan.technicienId == null ? undefined : plan.technicienId });
    if (demande) Object.assign(defauts, { titre: demande.titre, description: demande.description || '', typeCode: codeSouple('typesIntervention', demande.typeCode, 'correctif'), prioriteCode: codeSouple('priorites', demande.prioriteCode, 'normale'), equipementId: demande.equipementId == null ? undefined : demande.equipementId, secteurId: demande.secteurId == null ? undefined : demande.secteurId });
    const src = Object.assign({}, defauts);
    for (const [k, v] of Object.entries(body)) if (v !== undefined) src[k] = v;
    const data = lireCorps(reqCtl, src, null, { champsSouples: !!options.souple, tolererInactif: !!options.souple });
    const aff = lireAffectation(src, null);
    if (!systeme && !can(req, 'affecter')) {
      // Sans le droit « affecter », seul l'utilisateur lui-même peut être désigné explicitement
      const demandes = [body.technicienId].concat(Array.isArray(body.techniciens) ? body.techniciens : []).filter((x) => x != null && x !== '');
      const autres = demandes.filter((x) => Number(x) !== req.user.id);
      if (autres.length) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Affecter (sans ce droit, vous ne pouvez affecter que vous-même)');
    }
    let taches = plan ? tachesDepuis((plan.gamme || []).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map((g) => ({ libelle: g.libelle, duree: g.duree }))) : [];
    if (!plan && body.taches !== undefined) taches = tachesDepuis(body.taches);
    const piecesPrevues = plan ? (plan.pieces || []).filter((x) => x && x.articleId != null).map((x) => { const a = db.get('articles', x.articleId); return { articleId: Number(x.articleId), code: a ? a.code || '' : '', designation: a ? a.designation || '' : '', quantite: Number(x.quantite) || 0 }; }) : [];
    const createdBy = options.createdBy !== undefined ? options.createdBy : (req && req.user ? req.user.id : null);
    const statut = st.initial;
    const record = Object.assign({
      numero: numeroUnique(), statut,
      demandeId: demande ? demande.id : null, planPreventifId: plan ? plan.id : null,
      technicienId: aff.technicienId, techniciens: aff.techniciens,
      dateDebut: null, dateFin: null, tempsPasse: [], pieces: [], piecesPrevues, causeCode: null, rapport: '',
      commentaires: [], documents: [], coutPieces: 0, coutMainOeuvre: 0, coutTotal: 0, compteurReleve: null, taches,
      cloturePar: null, dateCloture: null, createdBy,
      historique: [entree(req, options.source === 'duplication' ? 'duplication' : 'creation', statut, options.commentaire || (demande ? `Depuis la demande ${demande.numero || demande.id}` : plan ? `Depuis le plan préventif ${plan.numero || plan.nom}` : ''))],
    }, data);
    record.coutTotal = arrondi((record.coutExterne || 0));
    const o = db.insert(ENTITE, record);
    ctx.audit(req, options.source === 'duplication' ? 'duplication' : 'creation', ENTITE, o.id, `OT ${o.numero} : ${o.titre}${demande ? ` (demande ${demande.numero || demande.id})` : ''}${plan ? ` (plan ${plan.numero || plan.nom})` : ''}${options.commentaire ? ' — ' + options.commentaire : ''}`);
    const acteur = req && req.user ? req.user.id : null;
    if (o.techniciens.length) {
      notifier(o.techniciens, acteur, { titre: `Nouvel ordre de travail : ${o.numero}`, message: `${o.titre}${o.datePrevue ? ' — prévu le ' + jourDe(o.datePrevue).split('-').reverse().join('/') : ''}`, lien: `#/ot/${o.id}`, type: o.prioriteCode && o.prioriteCode === (ctx.liste('priorites').slice(-1)[0] || {}).code ? 'alerte' : 'info' });
    } else {
      notifier(planificateurs(o), acteur, { titre: `OT à affecter : ${o.numero}`, message: o.titre, lien: `#/ot/${o.id}`, type: 'info' });
    }
    ctx.emit('ot:cree', charge(o, { source: options.source || (demande ? 'demande' : plan ? 'plan' : 'manuel') }));
    return o;
  }

  // ----- Changement de statut ---------------------------------------------------
  function premiereDateTemps(o) {
    const dates = (o.tempsPasse || []).map((t) => t.date).filter(Boolean).sort();
    return dates[0] || null;
  }
  function changerStatut(req, o, nouveau, opts = {}) {
    const st = ST();
    const ancien = o.statut;
    const now = maintenant();
    const patch = Object.assign({}, opts.patch || {}, { statut: nouveau });
    const finalNouveau = st.estFinal(nouveau);
    const finalAncien = st.estFinal(ancien);
    if (nouveau === st.enCours && !o.dateDebut && !patch.dateDebut) patch.dateDebut = now;
    if (finalNouveau) {
      if (!patch.dateFin) patch.dateFin = now;
      if (!o.dateDebut && !patch.dateDebut && !st.estAnnulation(nouveau)) patch.dateDebut = premiereDateTemps(o) || patch.dateFin;
      patch.cloturePar = req && req.user ? req.user.id : null;
      patch.dateCloture = now;
    } else if (finalAncien) {
      Object.assign(patch, { cloturePar: null, dateCloture: null, dateFin: null });
    }
    const action = finalNouveau ? (st.estAnnulation(nouveau) ? 'annulation' : 'cloture') : (finalAncien ? 'reouverture' : 'statut');
    patch.historique = (o.historique || []).concat([entree(req, action, nouveau, opts.commentaire, { ancien })]);
    avecCouts(o, patch);
    const maj = db.update(ENTITE, o.id, patch);
    const actionAudit = action === 'cloture' ? 'cloture' : action === 'reouverture' ? 'reouverture' : 'statut';
    ctx.audit(req, actionAudit, ENTITE, o.id, `OT ${o.numero} : ${st.libelle(ancien)} → ${st.libelle(nouveau)}${opts.commentaire ? ' — ' + String(opts.commentaire).slice(0, 300) : ''}`);
    const acteur = req && req.user ? req.user.id : null;
    if (opts.silencieux) { /* notifications déjà envoyées par l'appelant */ } else if (finalNouveau) {
      const annule = st.estAnnulation(nouveau);
      notifier([maj.createdBy, demandeurDe(maj)].concat(maj.techniciens || []), acteur, {
        titre: `OT ${maj.numero} ${annule ? 'annulé' : 'terminé'}`,
        message: annule ? `${maj.titre}${opts.commentaire ? ' — motif : ' + String(opts.commentaire).slice(0, 200) : ''}` : `${maj.titre}${maj.rapport ? ' — ' + String(maj.rapport).slice(0, 200) : ''}`,
        lien: `#/ot/${maj.id}`, type: annule ? 'alerte' : 'info',
      });
    } else {
      const cibles = (maj.techniciens || []).concat(nouveau === st.attente || finalAncien ? [maj.createdBy] : []);
      notifier(cibles, acteur, { titre: `OT ${maj.numero} : ${st.libelle(nouveau)}`, message: `${maj.titre}${opts.commentaire ? ' — ' + String(opts.commentaire).slice(0, 200) : ''}`, lien: `#/ot/${maj.id}`, type: 'info' });
    }
    ctx.emit('ot:statut', charge(maj, { ancien, nouveau }));
    if (finalNouveau && !finalAncien) {
      if (st.estAnnulation(nouveau)) ctx.emit('ot:annule', charge(maj, { ancien, nouveau }));
      else ctx.emit('ot:termine', charge(maj, { ancien, nouveau }));
    }
    return maj;
  }
  /** Statut de reprise après réouverture : dernier statut non final connu, sinon « en cours » ou initial. */
  function statutReouverture(o, st) {
    const h = (o.historique || []).slice().reverse().find((x) => x.ancien && st.item(x.ancien) && !st.estFinal(x.ancien));
    if (h) return h.ancien;
    if (o.dateDebut && st.enCours) return st.enCours;
    return st.initial;
  }
  function reouvrir(req, o, motif, statutVoulu) {
    const st = ST();
    if (!st.estFinal(o.statut)) throw new HttpError(400, 'Cet ordre de travail n\'est pas clôturé');
    let cible = statutReouverture(o, st);
    if (statutVoulu) {
      if (!st.item(statutVoulu) || st.estFinal(statutVoulu)) throw new HttpError(400, 'Statut de réouverture invalide (un statut non final est attendu)');
      cible = statutVoulu;
    }
    return changerStatut(req, o, cible, { commentaire: motif || '' });
  }

  // ----- Filtres de liste ----------------------------------------------------
  function filtrer(req) {
    const q = req.query || {};
    const st = ST();
    const today = dateLocale();
    let rows = portee(req, db.list(ENTITE));
    if (q.statut) rows = rows.filter((o) => o.statut === q.statut);
    if (q.statuts) { const s = new Set(String(q.statuts).split(',').map((x) => x.trim()).filter(Boolean)); rows = rows.filter((o) => s.has(o.statut)); }
    if (q.typeCode) rows = rows.filter((o) => o.typeCode === q.typeCode);
    if (q.prioriteCode) rows = rows.filter((o) => o.prioriteCode === q.prioriteCode);
    if (q.secteurId) {
      if (q.secteurId === 'aucun') rows = rows.filter((o) => o.secteurId == null);
      else { const ids = perms.secteursDescendants(db, [Number(q.secteurId)]); rows = rows.filter((o) => o.secteurId != null && ids.includes(Number(o.secteurId))); }
    }
    if (q.equipementId) {
      let ids = [Number(q.equipementId)];
      const sEq = ctx.services.equipements;
      if ((q.inclureSousEquipements === '1' || q.inclureSousEquipements === 'true') && sEq && typeof sEq.descendants === 'function') ids = ids.concat(sEq.descendants(Number(q.equipementId)) || []);
      rows = rows.filter((o) => ids.includes(Number(o.equipementId)));
    }
    if (q.technicienId) rows = rows.filter((o) => (q.technicienId === 'aucun' ? o.technicienId == null && !(o.techniciens || []).length : estAffecte(Number(q.technicienId), o)));
    if (q.demandeId) rows = rows.filter((o) => Number(o.demandeId) === Number(q.demandeId));
    if (q.planPreventifId) rows = rows.filter((o) => Number(o.planPreventifId) === Number(q.planPreventifId));
    if (q.du) rows = rows.filter((o) => o.datePrevue && jourDe(o.datePrevue) >= String(q.du).slice(0, 10));
    if (q.au) rows = rows.filter((o) => o.datePrevue && jourDe(o.datePrevue) <= String(q.au).slice(0, 10));
    if (q.enRetard === '1' || q.enRetard === 'true') rows = rows.filter((o) => enRetard(o, today, st));
    if (q.mesOT === '1' || q.mesOT === 'true') rows = rows.filter((o) => estAffecte(req.user.id, o));
    if (q.ouverts === '1' || q.ouverts === 'true') rows = rows.filter((o) => !st.estFinal(o.statut));
    if (q.finaux === '1' || q.termines === '1') rows = rows.filter((o) => st.estFinal(o.statut));
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase().trim();
      const eqs = new Map(db.list('equipements').map((e) => [e.id, e]));
      rows = rows.filter((o) => {
        const e = o.equipementId != null ? eqs.get(Number(o.equipementId)) : null;
        return [o.numero, o.titre, o.description, o.rapport, e && e.nom, e && e.numero, ctx.nomUser(o.technicienId)].some((v) => String(v || '').toLowerCase().includes(s));
      });
    }
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id - a.id);
    const limite = Number(q.limite);
    if (Number.isInteger(limite) && limite > 0) rows = rows.slice(0, limite);
    return rows;
  }

  // ----- Routes : consultation -------------------------------------------------
  router.get('/api/ot', async (req) => {
    const refs = references();
    const accessible = equipementsAccessibles(req);
    return filtrer(req).map((o) => Object.assign(resume(o, refs), { equipementAccessible: accessible(o.equipementId) }));
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/ot-compteurs', async (req) => {
    const st = ST();
    const today = dateLocale();
    const rows = portee(req, db.list(ENTITE));
    const ouverts = rows.filter((o) => !st.estFinal(o.statut));
    const parStatut = {};
    for (const s of st.liste) parStatut[s.code] = 0;
    for (const o of rows) parStatut[o.statut] = (parStatut[o.statut] || 0) + 1;
    const mois = today.slice(0, 7);
    return {
      total: rows.length,
      ouverts: ouverts.length,
      enRetard: ouverts.filter((o) => enRetard(o, today, st)).length,
      mesOT: ouverts.filter((o) => estAffecte(req.user.id, o)).length,
      mesOTEnRetard: ouverts.filter((o) => estAffecte(req.user.id, o) && enRetard(o, today, st)).length,
      enCours: st.enCours ? rows.filter((o) => o.statut === st.enCours).length : 0,
      enAttente: st.attente ? rows.filter((o) => o.statut === st.attente).length : 0,
      nonAffectes: ouverts.filter((o) => o.technicienId == null && !(o.techniciens || []).length).length,
      aujourdhui: ouverts.filter((o) => o.datePrevue && jourDe(o.datePrevue) === today).length,
      terminesMois: rows.filter((o) => o.statut === st.termine && jourDe(o.dateFin || o.dateCloture).slice(0, 7) === mois).length,
      parStatut,
    };
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/ot-export', async (req, res) => {
    const refs = references();
    const rows = filtrer(req).map((o) => resume(o, refs));
    const lib = (nomListe, code) => { const it = ctx.liste(nomListe).find((x) => x.code === code); return it ? it.label : (code || ''); };
    const defs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
    const nombreFr = (n) => (n == null || n === '' ? '' : String(arrondi(n)).replace('.', ','));
    const entetes = ['Numéro', 'Titre', 'Type', 'Priorité', 'Statut', 'Équipement (n°)', 'Équipement', 'Secteur', 'Technicien responsable', 'Intervenants', 'Date prévue', 'Début', 'Fin', 'Durée estimée (h)', 'Temps passé (h)', 'Coût pièces', 'Coût main d\'œuvre', 'Coût externe', 'Coût total', 'Cause', 'Demande', 'Plan préventif', 'En retard', 'Créé le', 'Créé par', 'Clôturé par', 'Compte rendu'].concat(defs.map((d) => d.label));
    const lignes = ['﻿' + entetes.map(csvEscape).join(';')];
    for (const o of rows) {
      lignes.push([
        o.numero, o.titre, lib('typesIntervention', o.typeCode), lib('priorites', o.prioriteCode), o.statutLibelle, o.equipementNumero, o.equipementNom, o.secteurChemin,
        o.technicienNom, o.techniciensNoms.join(', '), jourDe(o.datePrevue), o.dateDebut ? String(o.dateDebut).slice(0, 16).replace('T', ' ') : '', o.dateFin ? String(o.dateFin).slice(0, 16).replace('T', ' ') : '',
        nombreFr(o.dureeEstimee), nombreFr(o.tempsTotal), nombreFr(o.coutPieces), nombreFr(o.coutMainOeuvre), nombreFr(o.coutExterne), nombreFr(o.coutTotal),
        lib('causesPanne', o.causeCode), o.demandeNumero, o.planNumero, o.enRetard ? 'Oui' : 'Non', jourDe(o.createdAt), o.createdByNom, nomDe(refs, o.cloturePar), o.rapport || '',
      ].concat(defs.map((d) => { const v = (o.champs || {})[d.cle]; return v === true ? 'Oui' : v === false ? 'Non' : v; })).map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, null, `Export CSV de ${rows.length} ordre(s) de travail`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ordres-de-travail-${dateLocale()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [ENTITE, 'exporter'] });

  /** Intervenants possibles (utilisateurs actifs ayant accès aux OT) avec leur charge. */
  router.get('/api/ot-techniciens', async () => {
    const st = ST();
    const ouverts = db.list(ENTITE, (o) => !st.estFinal(o.statut));
    const config = db.getConfig();
    return db.list('users', (u) => u.actif !== false).map((u) => {
      const p = perms.effectivePermissions(db, u, null, config);
      if (!perms.can(p, ENTITE, 'voir')) return null;
      return {
        id: u.id, login: u.login, nom: u.nom, prenom: u.prenom || '', nomComplet: `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login, fonction: u.fonction || '',
        secteurIds: u.secteurIds || [], profilNom: p.profilNom || '',
        peutModifier: perms.can(p, ENTITE, 'modifier'), peutCloturer: perms.can(p, ENTITE, 'cloturer'),
        charge: ouverts.filter((o) => estAffecte(u.id, o)).length,
        heuresPrevues: arrondi(ouverts.filter((o) => estAffecte(u.id, o)).reduce((s, o) => s + (Number(o.dureeEstimee) || 0), 0)),
      };
    }).filter(Boolean).sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, 'fr'));
  }, { perm: [ENTITE, 'voir'] });

  /** Articles consommables sur un OT (lecture directe du stock, selon la portée). */
  router.get('/api/ot-articles', async (req) => {
    const stock = ctx.services.stock;
    const disponible = !!(stock && typeof stock.sortir === 'function');
    let equipementId = null;
    if (req.query.otId) { const o = getVisible(req, req.query.otId); equipementId = o.equipementId == null ? null : Number(o.equipementId); }
    const articles = ctx.scope(req, db.list('articles', (a) => a.actif !== false)).map((a) => ({
      id: a.id, code: a.code || '', designation: a.designation || '', quantite: Number(a.quantite) || 0, uniteCode: a.uniteCode || null,
      prixUnitaire: Number(a.prixUnitaire) || 0, emplacement: a.emplacement || '', categorieCode: a.categorieCode || null, seuilMin: a.seuilMin == null ? null : Number(a.seuilMin),
      compatible: equipementId != null && (a.equipementIds || []).map(Number).includes(equipementId),
    })).sort((a, b) => (Number(b.compatible) - Number(a.compatible)) || a.designation.localeCompare(b.designation, 'fr'));
    return { disponible, stockNegatif: !!wf().stockNegatif, articles };
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/ot/:id', async (req) => detail(req, getVisible(req, req.params.id)), { perm: [ENTITE, 'voir'] });

  // ----- Routes : création / modification / suppression ---------------------------
  router.post('/api/ot', async (req) => {
    const o = creer(req, req.body, {});
    return detail(req, o);
  }, { perm: [ENTITE, 'creer'] });

  function egal(a, b) {
    const n = (v) => (v === undefined || v === '' ? null : v);
    a = n(a); b = n(b);
    if (a === null || b === null) return a === b;
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
  }

  router.put('/api/ot/:id', async (req) => {
    let o = getVisible(req, req.params.id);
    const body = objet(req.body);
    const st = ST();
    const modif = can(req, 'modifier');
    if (!modif && !estAffecte(req.user.id, o)) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Modifier (ou être technicien affecté à cet ordre de travail)');
    if (body.statut !== undefined && !egal(body.statut, o.statut)) throw new HttpError(400, 'Le statut se modifie par les actions de workflow (démarrer, mettre en attente, clôturer, annuler…)');
    if (st.estFinal(o.statut)) {
      if (!(modif && body.reouvrir === true)) throw new HttpError(400, `L'ordre de travail ${o.numero} est clôturé (${st.libelle(o.statut)}) : réouvrez-le avant de le modifier`);
      o = reouvrir(req, o, texte(body.motifReouverture, 'Le motif de réouverture', { max: 1000 }), null);
    }
    if (!modif) {
      const interdits = CHAMPS_PLANIFICATION.concat(['technicienId', 'techniciens']).filter((k) => body[k] !== undefined && !egal(body[k], o[k]));
      if (interdits.length) throw new HttpError(403, 'En tant que technicien affecté, vous ne pouvez modifier que les informations de réalisation (compte rendu, cause, relevé, coût externe, dates de réalisation)');
    }
    const patch = modif ? lireCorps(req, body, o) : {};
    Object.assign(patch, lireRealisation(body, o));
    // Affectation (comparée après normalisation : le responsable fait toujours partie des intervenants)
    let affChangee = false;
    let nouveauxIntervenants = [];
    if (body.technicienId !== undefined || body.techniciens !== undefined) {
      const aff = lireAffectation(body, o);
      affChangee = !egal(aff.technicienId, o.technicienId) || !egal(aff.techniciens.slice().sort(), (o.techniciens || []).map(Number).sort());
      if (affChangee) {
        if (!can(req, 'affecter')) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Affecter');
        const anciens = new Set((o.techniciens || []).map(Number).concat(o.technicienId != null ? [Number(o.technicienId)] : []));
        nouveauxIntervenants = aff.techniciens.filter((id) => !anciens.has(id));
        Object.assign(patch, aff);
        patch.historique = (o.historique || []).concat([entree(req, 'affectation', o.statut, `Responsable : ${ctx.nomUser(aff.technicienId) || '—'} ; intervenants : ${aff.techniciens.map((id) => ctx.nomUser(id)).join(', ') || '—'}`)]);
      }
    }
    if (patch.dateDebut !== undefined || patch.dateFin !== undefined) verifierDebutFin(patch.dateDebut !== undefined ? patch.dateDebut : o.dateDebut, patch.dateFin !== undefined ? patch.dateFin : o.dateFin);
    const changes = Object.keys(patch).filter((k) => k !== 'historique' && !egal(patch[k], o[k]));
    if (!changes.length) return detail(req, o);
    avecCouts(o, patch);
    const maj = db.update(ENTITE, o.id, patch);
    const LIBELLES = { titre: 'titre', description: 'description', typeCode: 'type', prioriteCode: 'priorité', equipementId: 'équipement', secteurId: 'secteur', datePrevue: 'date prévue', dureeEstimee: 'durée estimée', fournisseurId: 'prestataire', coutExterne: 'coût externe', champs: 'champs personnalisés', rapport: 'compte rendu', causeCode: 'cause', compteurReleve: 'relevé de compteur', dateDebut: 'date de début', dateFin: 'date de fin', technicienId: 'responsable', techniciens: 'intervenants' };
    ctx.audit(req, affChangee && changes.every((k) => k === 'technicienId' || k === 'techniciens') ? 'affectation' : 'modification', ENTITE, o.id, `OT ${maj.numero} : ${changes.map((k) => LIBELLES[k] || k).join(', ')}`);
    if (nouveauxIntervenants.length) notifier(nouveauxIntervenants, req.user.id, { titre: `Affectation : OT ${maj.numero}`, message: `${maj.titre}${maj.datePrevue ? ' — prévu le ' + jourDe(maj.datePrevue).split('-').reverse().join('/') : ''}`, lien: `#/ot/${maj.id}`, type: 'info' });
    if (patch.datePrevue !== undefined && !egal(patch.datePrevue, o.datePrevue)) notifier((maj.techniciens || []).filter((id) => !nouveauxIntervenants.includes(id)), req.user.id, { titre: `OT ${maj.numero} replanifié`, message: `${maj.titre} — nouvelle date prévue : ${maj.datePrevue ? jourDe(maj.datePrevue).split('-').reverse().join('/') : 'non planifiée'}`, lien: `#/ot/${maj.id}`, type: 'info' });
    ctx.emit('ot:modifie', charge(maj, { champsModifies: changes }));
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/ot/:id', async (req) => {
    const o = getVisible(req, req.params.id);
    const st = ST();
    if (o.statut === st.termine) throw new HttpError(400, `L'ordre de travail ${o.numero} est terminé : il ne peut pas être supprimé (traçabilité). Réouvrez-le puis annulez-le si nécessaire.`);
    if ((o.pieces || []).length) throw new HttpError(400, 'Des pièces ont été sorties du stock pour cet ordre de travail : retirez-les (retour en stock) ou annulez l\'OT plutôt que de le supprimer');
    verifierPorteeSecteur(req, o.secteurId);
    db.remove(ENTITE, o.id);
    ctx.audit(req, 'suppression', ENTITE, o.id, `OT ${o.numero} : ${o.titre}`);
    if (!st.estFinal(o.statut)) ctx.emit('ot:annule', charge(o, { ancien: o.statut, nouveau: null, suppression: true }));
    ctx.emit('ot:supprime', charge(o));
    return { ok: true };
  }, { perm: [ENTITE, 'supprimer'] });

  router.post('/api/ot/:id/dupliquer', async (req) => {
    const source = getVisible(req, req.params.id);
    const body = objet(req.body);
    const affecter = can(req, 'affecter');
    const garderAff = affecter || [source.technicienId].concat(source.techniciens || []).filter((x) => x != null).every((x) => Number(x) === req.user.id);
    const copie = {
      titre: body.titre !== undefined ? body.titre : source.titre, description: source.description, typeCode: codeSouple('typesIntervention', source.typeCode, 'correctif'), prioriteCode: codeSouple('priorites', source.prioriteCode, 'normale'),
      equipementId: source.equipementId, secteurId: source.secteurId, datePrevue: body.datePrevue !== undefined ? body.datePrevue : null, dureeEstimee: source.dureeEstimee,
      fournisseurId: source.fournisseurId && db.get('fournisseurs', source.fournisseurId) ? source.fournisseurId : null,
      technicienId: garderAff ? source.technicienId : null, techniciens: garderAff ? (source.techniciens || []) : [],
      taches: (source.taches || []).map((t) => ({ libelle: t.libelle, duree: t.duree == null ? null : t.duree })), champs: source.champs || {},
    };
    const o = creer(req, copie, { source: 'duplication', commentaire: `Copie de l'OT ${source.numero}` });
    return detail(req, o);
  }, { perm: [ENTITE, 'creer'] });

  // ----- Routes : workflow -------------------------------------------------------
  router.post('/api/ot/:id/statut', async (req) => {
    const o = getVisible(req, req.params.id);
    const b = objet(req.body);
    const st = ST();
    if (b.statut == null || b.statut === '') throw new HttpError(400, 'Le nouveau statut est obligatoire');
    if (typeof b.statut !== 'string' || !st.item(b.statut)) throw new HttpError(400, `Statut inconnu : « ${b.statut} »`);
    const nouveau = b.statut;
    if (nouveau === o.statut) throw new HttpError(400, `L'ordre de travail est déjà au statut « ${st.libelle(nouveau)} »`);
    const commentaire = texte(b.commentaire, 'Le commentaire', { max: 1000 });
    const finalAncien = st.estFinal(o.statut);
    const finalNouveau = st.estFinal(nouveau);
    if (finalAncien && finalNouveau) throw new HttpError(400, `L'ordre de travail est déjà clôturé (${st.libelle(o.statut)}) : réouvrez-le d'abord`);
    if (finalAncien) {
      if (!can(req, 'modifier')) throw new HttpError(403, 'Droit insuffisant : la réouverture d\'un ordre de travail clôturé nécessite le droit Ordres de travail › Modifier');
      return detail(req, reouvrir(req, o, commentaire, nouveau));
    }
    if (finalNouveau) {
      if (!peutCloturer(req, o)) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Clôturer');
      if (st.estAnnulation(nouveau) && (o.pieces || []).length && !commentaire) throw new HttpError(400, 'Des pièces ont été consommées : précisez le motif de l\'annulation');
    } else exigerRealisation(req, o);
    return detail(req, changerStatut(req, o, nouveau, { commentaire }));
  }, { perm: [ENTITE, 'voir'] });

  router.post('/api/ot/:id/affecter', async (req) => {
    const o = getVisible(req, req.params.id);
    const st = ST();
    exigerOuvert(o, st);
    const b = objet(req.body);
    if (b.technicienId === undefined && b.techniciens === undefined && b.datePrevue === undefined) throw new HttpError(400, 'Indiquez un technicien, des intervenants ou une date prévue');
    const aff = lireAffectation({ technicienId: b.technicienId, techniciens: b.techniciens }, o);
    const patch = Object.assign({}, aff);
    if (b.datePrevue !== undefined) patch.datePrevue = lireDate(b.datePrevue, 'La date prévue');
    if (b.dureeEstimee !== undefined) patch.dureeEstimee = nombre(b.dureeEstimee, 'La durée estimée', { min: 0, max: 10000 });
    const anciens = new Set((o.techniciens || []).map(Number).concat(o.technicienId != null ? [Number(o.technicienId)] : []));
    const nouveaux = aff.techniciens.filter((id) => !anciens.has(id));
    const commentaire = texte(b.commentaire, 'Le commentaire', { max: 1000 });
    const resumeAff = `Responsable : ${ctx.nomUser(aff.technicienId) || '—'} ; intervenants : ${aff.techniciens.map((id) => ctx.nomUser(id)).join(', ') || '—'}${patch.datePrevue ? ' ; prévu le ' + jourDe(patch.datePrevue).split('-').reverse().join('/') : ''}`;
    patch.historique = (o.historique || []).concat([entree(req, 'affectation', o.statut, resumeAff + (commentaire ? ' — ' + commentaire : ''))]);
    let maj = db.update(ENTITE, o.id, patch);
    ctx.audit(req, 'affectation', ENTITE, o.id, `OT ${o.numero} : ${resumeAff}`);
    const datePrevue = maj.datePrevue ? ' — prévu le ' + jourDe(maj.datePrevue).split('-').reverse().join('/') : '';
    notifier(nouveaux, req.user.id, { titre: `Affectation : OT ${maj.numero}`, message: `${maj.titre}${datePrevue}${commentaire ? ' — ' + commentaire : ''}`, lien: `#/ot/${maj.id}`, type: 'info' });
    if (patch.datePrevue !== undefined && !egal(patch.datePrevue, o.datePrevue)) notifier(aff.techniciens.filter((id) => !nouveaux.includes(id)), req.user.id, { titre: `OT ${maj.numero} replanifié`, message: `${maj.titre}${datePrevue || ' — date prévue retirée'}`, lien: `#/ot/${maj.id}`, type: 'info' });
    // Passage automatique au statut « planifié » lorsque l'OT initial est affecté et daté
    if (b.planifier !== false && st.planifie && maj.statut === st.initial && st.initial !== st.planifie && maj.datePrevue && (maj.technicienId != null || (maj.techniciens || []).length)) {
      maj = changerStatut(req, maj, st.planifie, { commentaire: 'Planification à l\'affectation', silencieux: true });
    }
    ctx.emit('ot:modifie', charge(maj, { champsModifies: Object.keys(patch).filter((k) => k !== 'historique') }));
    return detail(req, maj);
  }, { perm: [ENTITE, 'affecter'] });

  router.post('/api/ot/:id/cloturer', async (req) => {
    const o = getVisible(req, req.params.id);
    const st = ST();
    if (!peutCloturer(req, o)) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Clôturer');
    exigerOuvert(o, st);
    const b = objet(req.body);
    const rapport = texte(b.rapport, 'Le compte rendu', { requis: true, min: 3, max: MAX_RAPPORT });
    const causeCode = b.causeCode === undefined ? (o.causeCode == null ? null : o.causeCode) : codeListe('causesPanne', b.causeCode, 'Cause de panne', null);
    const compteurReleve = nombre(b.compteurReleve, 'Le relevé de compteur', { min: 0, max: 1e12 });
    const coutExterne = b.coutExterne === undefined ? (Number(o.coutExterne) || 0) : (nombre(b.coutExterne, 'Le coût externe', { min: 0, max: 1e9 }) || 0);
    let fournisseurId = o.fournisseurId == null ? null : o.fournisseurId;
    if (b.fournisseurId !== undefined) { fournisseurId = idRef(b.fournisseurId, 'Prestataire'); if (fournisseurId != null && !db.get('fournisseurs', fournisseurId)) throw new HttpError(400, 'Prestataire (fournisseur) introuvable'); }
    let dateFin = lireDate(b.dateFin, 'La date de fin') || maintenant();
    const tFin = horodatage(dateFin);
    if (tFin > Date.now() + 5 * 60000 && !(RE_DATE.test(dateFin) && dateFin <= dateLocale())) throw new HttpError(400, 'La date de fin ne peut pas être dans le futur');
    const dateDebut = b.dateDebut !== undefined ? lireDate(b.dateDebut, 'La date de début') : (o.dateDebut || null);
    verifierDebutFin(dateDebut, dateFin);
    // Fin saisie à la minute, dans la même minute que le démarrage : la fin ne précède jamais le début
    if (dateDebut && !RE_DATE.test(String(dateDebut)) && !RE_DATE.test(String(dateFin)) && horodatage(dateFin) < horodatage(dateDebut)) dateFin = dateDebut;
    const avertissements = [];
    // Relevé de compteur de l'équipement (avant la clôture : une valeur refusée n'altère pas l'OT)
    if (compteurReleve != null && o.equipementId != null) {
      // Cohérence avec l'historique de l'équipement (et le préventif sur compteur) : un relevé ne peut pas
      // être inférieur au dernier relevé connu à la date de fin de l'intervention.
      const eqC = db.get('equipements', o.equipementId);
      const tReleve = Math.min(tFin, Date.now());
      if (eqC && eqC.compteur && eqC.compteur.valeur != null) {
        const anterieurs = (eqC.compteurReleves || []).filter((r) => r && r.valeur != null && Number.isFinite(Date.parse(r.date)) && Date.parse(r.date) <= tReleve)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const reference = anterieurs.length ? Number(anterieurs[anterieurs.length - 1].valeur)
          : ((eqC.compteurReleves || []).length || tReleve < Date.now() - 86400000 ? null : Number(eqC.compteur.valeur));
        if (reference != null && Number.isFinite(reference) && compteurReleve < reference) {
          const unite = eqC.compteur.unite || '';
          throw new HttpError(400, `Le relevé de compteur (${compteurReleve} ${unite}) est inférieur au dernier relevé de l'équipement « ${eqC.nom} » (${reference} ${unite}) : vérifiez la saisie (un remplacement de compteur s'enregistre depuis la fiche de l'équipement)`.replace(/\s+\)/g, ')'));
        }
      }
      const sEq = ctx.services.equipements;
      if (sEq && typeof sEq.releverCompteur === 'function') {
        try {
          const optionsReleve = { otId: o.id, commentaire: `Relevé à la clôture de l'OT ${o.numero}` };
          if (tReleve < Date.now() - 3600000) optionsReleve.date = new Date(tReleve).toISOString(); // intervention antérieure : relevé historisé à sa date
          sEq.releverCompteur(o.equipementId, compteurReleve, { user: req.user, socket: req.socket }, optionsReleve);
        } catch (e) {
          if (e && e.status === 400) throw e;
          avertissements.push(`Relevé de compteur non reporté sur l'équipement : ${e.message}`);
        }
      } else avertissements.push('Module Équipements indisponible : le relevé est conservé sur l\'OT uniquement');
    }
    const nonFaites = (o.taches || []).filter((t) => !t.fait).length;
    if (nonFaites) avertissements.push(`${nonFaites} tâche(s) de la gamme non cochée(s)`);
    if (!(o.tempsPasse || []).length) avertissements.push('Aucun temps passé n\'a été saisi');
    const patch = { rapport, causeCode, compteurReleve, coutExterne, fournisseurId, dateFin, dateDebut: dateDebut || premiereDateTemps(o) || dateFin };
    const maj = changerStatut(req, o, st.termine, { patch, commentaire: rapport.length > 160 ? rapport.slice(0, 157) + '…' : rapport });
    return Object.assign(detail(req, maj), { avertissements });
  }, { perm: [ENTITE, 'voir'] });

  router.post('/api/ot/:id/reouvrir', async (req) => {
    const o = getVisible(req, req.params.id);
    const b = objet(req.body);
    const motif = texte(b.motif, 'Le motif', { max: 1000 });
    return detail(req, reouvrir(req, o, motif, b.statut || null));
  }, { perm: [ENTITE, 'modifier'] });

  // ----- Routes : temps passés ----------------------------------------------------
  router.post('/api/ot/:id/temps', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const b = objet(req.body);
    const brute = lireDate(b.date, 'La date') || dateLocale();
    const date = jourDe(brute);
    if (date > dateLocale()) throw new HttpError(400, 'La date du temps passé ne peut pas être dans le futur');
    const heures = arrondi(nombre(b.heures, 'Le nombre d\'heures', { requis: true, positif: true, max: 24 }));
    if (heures <= 0) throw new HttpError(400, 'Le nombre d\'heures doit être strictement positif');
    const userId = b.userId == null || b.userId === '' ? req.user.id : idRef(b.userId, 'Intervenant');
    if (userId !== req.user.id && !can(req, 'modifier') && !can(req, 'affecter')) throw new HttpError(403, 'Vous ne pouvez saisir que votre propre temps passé');
    if (userId !== req.user.id) utilisateurActif(userId, 'Intervenant');
    const commentaire = texte(b.commentaire, 'Le commentaire', { max: 500 });
    const temps = o.tempsPasse || [];
    if (temps.length >= MAX_TEMPS) throw new HttpError(400, 'Nombre maximal de saisies de temps atteint');
    const dejaJour = temps.filter((t) => Number(t.userId) === userId && t.date === date).reduce((s, t) => s + (Number(t.heures) || 0), 0);
    if (dejaJour + heures > 24) throw new HttpError(400, `Total journalier dépassé : ${ctx.nomUser(userId)} a déjà ${arrondi(dejaJour)} h saisies le ${date.split('-').reverse().join('/')}`);
    const patch = { tempsPasse: temps.concat([{ userId, date, heures, commentaire, saisiPar: req.user.id, dateSaisie: maintenant() }]) };
    if (!estAffecte(userId, o)) patch.techniciens = (o.techniciens || []).concat([userId]);
    avecCouts(o, patch);
    const maj = db.update(ENTITE, o.id, patch);
    ctx.audit(req, 'temps', ENTITE, o.id, `OT ${o.numero} : ${heures} h le ${date} pour ${ctx.nomUser(userId)}${commentaire ? ' — ' + commentaire : ''}`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  function indexDans(liste, valeur, message) {
    const idx = Number(valeur);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (liste || []).length) throw new HttpError(404, message);
    return idx;
  }

  router.delete('/api/ot/:id/temps/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const idx = indexDans(o.tempsPasse, req.params.index, 'Saisie de temps introuvable');
    const t = o.tempsPasse[idx];
    if (Number(t.userId) !== req.user.id && Number(t.saisiPar) !== req.user.id && !can(req, 'modifier')) throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres saisies de temps');
    const temps = o.tempsPasse.slice(); temps.splice(idx, 1);
    const maj = db.update(ENTITE, o.id, avecCouts(o, { tempsPasse: temps }));
    ctx.audit(req, 'temps', ENTITE, o.id, `OT ${o.numero} : suppression de ${t.heures} h du ${t.date} (${ctx.nomUser(t.userId)})`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : pièces consommées ---------------------------------------------------
  router.post('/api/ot/:id/pieces', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const b = objet(req.body);
    const stock = ctx.services.stock;
    if (!stock || typeof stock.sortir !== 'function') throw new HttpError(503, 'Module stock indisponible : la sortie de pièces est impossible');
    const articleId = idRef(b.articleId, 'Article');
    if (articleId == null) throw new HttpError(400, 'L\'article est obligatoire');
    const article = db.get('articles', articleId);
    if (!article || !ctx.canSee(req, article)) throw new HttpError(400, 'Article introuvable');
    if (article.actif === false) throw new HttpError(400, `L'article « ${article.designation} » est inactif`);
    const quantite = nombre(b.quantite, 'La quantité', { requis: true, positif: true, max: 1e6 });
    if ((o.pieces || []).length >= MAX_PIECES) throw new HttpError(400, 'Nombre maximal de lignes de pièces atteint');
    let r;
    try {
      r = await stock.sortir({ articleId, quantite, otId: o.id, userId: req.user.id, motif: `OT ${o.numero} — ${o.titre}` });
    } catch (e) {
      if (e && e.status) throw e;
      throw new HttpError(400, (e && e.message) || 'Sortie de stock refusée');
    }
    const mouvement = r && r.mouvement ? r.mouvement : (r && r.id != null && r.articleId != null ? r : null);
    const art = (r && r.article) || db.get('articles', articleId) || article;
    const pu = mouvement && mouvement.prixUnitaire != null && mouvement.prixUnitaire !== '' ? Number(mouvement.prixUnitaire) : Number(art.prixUnitaire);
    const courant = db.get(ENTITE, o.id) || o;
    const piece = { articleId, code: art.code || '', designation: art.designation || '', uniteCode: art.uniteCode || null, quantite, prixUnitaire: Number.isFinite(pu) ? pu : 0, mouvementId: mouvement && mouvement.id != null ? mouvement.id : null, date: maintenant(), userId: req.user.id };
    const maj = db.update(ENTITE, o.id, avecCouts(courant, { pieces: (courant.pieces || []).concat([piece]) }));
    ctx.audit(req, 'pieces', ENTITE, o.id, `OT ${o.numero} : sortie de ${quantite} × ${piece.code ? piece.code + ' ' : ''}${piece.designation}`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/ot/:id/pieces/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const idx = indexDans(o.pieces, req.params.index, 'Ligne de pièce introuvable');
    const piece = o.pieces[idx];
    if (piece.mouvementId != null) {
      const stock = ctx.services.stock;
      if (!stock || typeof stock.annulerSortie !== 'function') throw new HttpError(503, 'Module stock indisponible : le retour en stock est impossible');
      try { await stock.annulerSortie(piece.mouvementId, req.user.id); } catch (e) {
        if (e && e.status) throw e;
        throw new HttpError(400, (e && e.message) || 'Retour en stock refusé');
      }
    }
    const courant = db.get(ENTITE, o.id) || o;
    const pieces = (courant.pieces || []).slice();
    const i2 = pieces.findIndex((p) => p === piece || (p.mouvementId != null && p.mouvementId === piece.mouvementId && p.articleId === piece.articleId));
    pieces.splice(i2 >= 0 ? i2 : idx, 1);
    const maj = db.update(ENTITE, o.id, avecCouts(courant, { pieces }));
    ctx.audit(req, 'pieces', ENTITE, o.id, `OT ${o.numero} : retour en stock de ${piece.quantite} × ${piece.code ? piece.code + ' ' : ''}${piece.designation}`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : tâches (gamme) ------------------------------------------------------
  router.post('/api/ot/:id/taches', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const b = objet(req.body);
    const libelle = texte(b.libelle, 'Le libellé de la tâche', { requis: true, min: 2, max: 300 });
    const taches = o.taches || [];
    if (taches.length >= MAX_TACHES) throw new HttpError(400, `Nombre maximal de tâches atteint (${MAX_TACHES})`);
    const ordre = taches.reduce((m, t) => Math.max(m, Number(t.ordre) || 0), 0) + 1;
    const maj = db.update(ENTITE, o.id, { taches: taches.concat([{ ordre, libelle, duree: nombre(b.duree, 'La durée de la tâche', { min: 0, max: 1000 }), fait: false, faitPar: null, dateFait: null }]) });
    ctx.audit(req, 'modification', ENTITE, o.id, `OT ${o.numero} : tâche ajoutée « ${libelle} »`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.put('/api/ot/:id/taches/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const idx = indexDans(o.taches, req.params.index, 'Tâche introuvable');
    const b = objet(req.body);
    if (b.fait === undefined && b.libelle === undefined) throw new HttpError(400, 'Indiquez l\'état de la tâche (fait) ou son libellé');
    if (b.fait !== undefined && typeof b.fait !== 'boolean') throw new HttpError(400, 'L\'état de la tâche (fait) doit être vrai ou faux');
    const taches = o.taches.map((t) => Object.assign({}, t));
    const t = taches[idx];
    if (b.libelle !== undefined) {
      if (!can(req, 'modifier')) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Modifier');
      t.libelle = texte(b.libelle, 'Le libellé de la tâche', { requis: true, min: 2, max: 300 });
    }
    if (b.fait !== undefined && b.fait !== !!t.fait) {
      t.fait = b.fait;
      t.faitPar = b.fait ? req.user.id : null;
      t.dateFait = b.fait ? maintenant() : null;
    }
    const maj = db.update(ENTITE, o.id, { taches });
    ctx.audit(req, 'modification', ENTITE, o.id, `OT ${o.numero} : tâche « ${t.libelle} » ${b.fait === undefined ? 'renommée' : (t.fait ? 'réalisée' : 'à refaire')}`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/ot/:id/taches/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    exigerRealisation(req, o);
    exigerOuvert(o);
    const idx = indexDans(o.taches, req.params.index, 'Tâche introuvable');
    const sup = o.taches[idx];
    const taches = o.taches.filter((_, i) => i !== idx).map((t, i) => Object.assign({}, t, { ordre: i + 1 }));
    const maj = db.update(ENTITE, o.id, { taches });
    ctx.audit(req, 'modification', ENTITE, o.id, `OT ${o.numero} : tâche supprimée « ${sup.libelle} »`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : commentaires ---------------------------------------------------------
  router.post('/api/ot/:id/commentaires', async (req) => {
    const o = getVisible(req, req.params.id);
    const b = objet(req.body);
    const t = texte(b.texte, 'Le commentaire', { requis: true, max: MAX_COMMENTAIRE });
    const commentaires = (o.commentaires || []).concat([{ userId: req.user.id, date: maintenant(), texte: t }]);
    const maj = db.update(ENTITE, o.id, { commentaires });
    ctx.audit(req, 'commentaire', ENTITE, o.id, `OT ${o.numero} : ${t.slice(0, 200)}`);
    notifier([o.createdBy].concat(o.techniciens || []), req.user.id, { titre: `Commentaire sur l'OT ${o.numero}`, message: `${ctx.nomUser(req.user.id)} : ${t.slice(0, 200)}`, lien: `#/ot/${o.id}?onglet=commentaires`, type: 'info' });
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/ot/:id/commentaires/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    const idx = indexDans(o.commentaires, req.params.index, 'Commentaire introuvable');
    const c = o.commentaires[idx];
    if (Number(c.userId) !== req.user.id && !can(req, 'modifier')) throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres commentaires');
    const commentaires = o.commentaires.slice(); commentaires.splice(idx, 1);
    const maj = db.update(ENTITE, o.id, { commentaires });
    ctx.audit(req, 'commentaire', ENTITE, o.id, `OT ${o.numero} : commentaire supprimé`);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : documents --------------------------------------------------------------
  router.post('/api/ot/:id/documents', async (req) => {
    const o = getVisible(req, req.params.id);
    if (!peutRealiser(req, o)) throw new HttpError(403, 'Droit insuffisant : Ordres de travail › Modifier (ou être technicien affecté)');
    const b = objet(req.body);
    const nomDoc = String(b.nom || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
    if (!nomDoc) throw new HttpError(400, 'Le nom du document est obligatoire');
    const contenu = typeof b.contenu === 'string' ? b.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu du document invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'Le document est vide');
    if (taille > TAILLE_MAX_DOC) throw new HttpError(400, `Document trop volumineux (${(taille / 1024 / 1024).toFixed(1)} Mo, maximum 5 Mo)`);
    const docs = o.documents || [];
    if (docs.length >= MAX_DOCS) throw new HttpError(400, `Nombre maximal de documents atteint (${MAX_DOCS})`);
    const type = String(b.type || m[1] || 'application/octet-stream').slice(0, 100);
    const doc = { nom: nomDoc, type, taille, contenu: `data:${m[1] || type};base64,${base64}`, date: maintenant(), userId: req.user.id, description: String(b.description || '').trim().slice(0, 500) };
    const maj = db.update(ENTITE, o.id, { documents: docs.concat([doc]) });
    ctx.audit(req, 'document', ENTITE, o.id, `OT ${o.numero} : document ajouté ${nomDoc} (${Math.max(1, Math.round(taille / 1024))} Ko)`);
    return { ok: true, document: resumeDoc(doc, maj.documents.length - 1), documents: maj.documents.map(resumeDoc) };
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/ot/:id/documents/:index', async (req, res) => {
    const o = getVisible(req, req.params.id);
    const doc = o.documents[indexDans(o.documents, req.params.index, 'Document introuvable')];
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Document corrompu');
    const buf = Buffer.from(m[2], 'base64');
    const type = String(doc.type || m[1] || 'application/octet-stream').toLowerCase();
    const inline = (estImage(type) || type === 'application/pdf' || type === 'text/plain') && req.query.telecharger !== '1';
    const dangereux = /html|javascript|xml$|xhtml/.test(type) && !/svg/.test(type);
    const nomFichier = encodeURIComponent(doc.nom || 'document').replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': dangereux ? 'application/octet-stream' : (type === 'text/plain' ? 'text/plain; charset=utf-8' : type),
      'Content-Length': buf.length,
      'Content-Disposition': `${inline && !dangereux ? 'inline' : 'attachment'}; filename*=UTF-8''${nomFichier}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      'Cache-Control': 'private, max-age=300',
    });
    res.end(buf);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/ot/:id/documents/:index', async (req) => {
    const o = getVisible(req, req.params.id);
    const idx = indexDans(o.documents, req.params.index, 'Document introuvable');
    const doc = o.documents[idx];
    if (!can(req, 'modifier') && !(Number(doc.userId) === req.user.id && peutRealiser(req, o))) throw new HttpError(403, 'Vous ne pouvez supprimer que les documents que vous avez ajoutés');
    const docs = o.documents.slice(); docs.splice(idx, 1);
    const maj = db.update(ENTITE, o.id, { documents: docs });
    ctx.audit(req, 'document', ENTITE, o.id, `OT ${o.numero} : document supprimé ${doc.nom}`);
    return { ok: true, documents: maj.documents.map(resumeDoc) };
  }, { perm: [ENTITE, 'voir'] });

  // ----- Services publiés -----------------------------------------------------------------
  ctx.services.ot = {
    /**
     * Crée un OT depuis une demande d'intervention (titre, description, type, priorité, équipement,
     * secteur repris ; demandeId). Idempotent : retourne l'OT existant non annulé lié à la demande.
     */
    creerDepuisDemande(demande, req) {
      if (!demande || demande.id == null) throw new HttpError(400, 'Demande d\'intervention invalide');
      const st = ST();
      const existant = db.findOne(ENTITE, (o) => Number(o.demandeId) === Number(demande.id) && !st.estAnnulation(o.statut));
      if (existant) return existant;
      const d = db.get('demandes', demande.id) ? Object.assign({}, db.get('demandes', demande.id), demande) : demande;
      const e = d.equipementId != null ? db.get('equipements', d.equipementId) : null;
      const titre = String(d.titre || '').trim();
      const body = {
        titre: titre.length >= 3 ? titre.slice(0, 200) : `Intervention ${d.numero || ''}`.trim(),
        description: String(d.description || '').slice(0, 10000),
        typeCode: codeSouple('typesIntervention', d.typeCode, 'correctif'),
        prioriteCode: codeSouple('priorites', d.prioriteCode, 'normale'),
        equipementId: e ? e.id : null,
        secteurId: e ? (e.secteurId == null ? null : e.secteurId) : (d.secteurId != null && db.get('secteurs', d.secteurId) ? d.secteurId : null),
      };
      const createdBy = req && req.user ? req.user.id : (d.validateurId != null ? d.validateurId : (d.demandeurId != null ? d.demandeurId : null));
      const enBase = !!db.get('demandes', d.id);
      if (enBase) body.demandeId = Number(d.id);
      const o = creer(req || null, body, { systeme: true, souple: true, source: 'demande', createdBy, commentaire: `Depuis la demande ${d.numero || d.id}` });
      return enBase ? o : db.update(ENTITE, o.id, { demandeId: Number(d.id) });
    },
    /** OT non clôturés, éventuellement filtrés par équipement et/ou plan préventif. */
    ouvertsPour({ equipementId, planPreventifId } = {}) {
      const st = ST();
      return db.list(ENTITE, (o) => !st.estFinal(o.statut)
        && (equipementId == null || Number(o.equipementId) === Number(equipementId))
        && (planPreventifId == null || Number(o.planPreventifId) === Number(planPreventifId)));
    },
    /** Création générique (ex. génération préventive) : options { systeme, createdBy, source, souple }. */
    creer: (donnees, req, options) => creer(req || null, donnees, Object.assign({ systeme: !req }, options || {})),
    get: (id) => db.get(ENTITE, id),
    estFinal: (code) => ST().estFinal(code),
    enRetard: (o) => enRetard(o),
    statuts: () => ST(),
    calculerCouts: (o) => calculerCouts(o, taux()),
  };
}

// ----- Données de démonstration -------------------------------------------------------
let seedEnCours = false;
const TEMOIN = 'Vérification générale périodique (VGP) du pont roulant 5 t';

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  if (db.findOne(ENTITE, (o) => o.titre === TEMOIN)) return 'déjà présents';
  seedEnCours = true;
  try {
    // Historique repris de l'ancienne GMAO (module Rapports) d'abord, sur une base sans OT : les OT et
    // demandes courants sont ainsi numérotés après les archives (numérotation chronologique), quel que
    // soit le module qui déclenche le chargement en premier.
    const historique = (ctx.modules || []).find((m) => m.fichier === 'rapports.js');
    if (historique && typeof historique.seedDemo === 'function' && db.count(ENTITE) === 0) {
      try { historique.seedDemo(ctx); } catch (e) { ctx.log('OT : chargement de l\'historique en échec', e.message); }
    }
    // Dépendances (idempotentes) : utilisateurs, équipements, demandes, stock
    for (const m of ctx.modules || []) {
      if (/^(utilisateurs|equipements|demandes|stock)\.js$/.test(m.fichier || '') && typeof m.seedDemo === 'function') {
        try { m.seedDemo(ctx); } catch (e) { ctx.log('OT : seed dépendant en échec', m.fichier, e.message); }
      }
    }
    return insererDemo(ctx);
  } finally { seedEnCours = false; }
}

function insererDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const st = outilsStatuts((cfg.listes || {}).statutsOT);
  const tauxHoraire = Number((cfg.general || {}).tauxHoraire) || 0;
  const gabarit = (cfg.numerotation || {}).ot || 'OT-{annee}-{num:4}';
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = login ? db.findOne('users', (x) => x.login === login) : null; return u ? u.id : (admin ? admin.id : null); };
  const equipement = (n) => db.findOne('equipements', (e) => e.nom === n);
  const demande = (titre) => db.findOne('demandes', (d) => d.titre === titre);
  const liste = (n) => ((cfg.listes || {})[n]) || [];
  const code = (n, voulu) => { const l = liste(n); return !l.length || l.some((x) => x.code === voulu) ? voulu : l[0].code; };
  const causeOk = (c) => (c && liste('causesPanne').some((x) => x.code === c) ? c : null);
  const statut = (s) => ({ nouveau: st.initial, planifie: st.planifie || st.initial, en_cours: st.enCours || st.initial, en_attente: st.attente || st.enCours || st.initial, termine: st.termine, annule: st.annule || st.termine }[s]);
  /** Horodatage ISO à J+n (local) à l'heure donnée. */
  const jour = (n, heure = '08:00') => { const d = new Date(); d.setDate(d.getDate() + n); const [h, mi] = heure.split(':').map(Number); d.setHours(h, mi, 0, 0); return d.toISOString(); };
  const dateJ = (n) => dateLocale(new Date(jour(n, '12:00')));
  const numeroUnique = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber(ENTITE, gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; } return 'OT-' + Date.now(); };
  const etape = (n, heure, login, action, s, commentaire, extra) => Object.assign({ date: jour(n, heure), userId: login === null ? null : userId(login), action, libelle: LIBELLES_ETAPES[action] || action, statut: s, commentaire: commentaire || '' }, extra || {});
  const stock = ctx.services.stock;
  const article = (re) => db.findOne('articles', (a) => a.actif !== false && re.test(`${a.designation || ''} ${a.code || ''}`));
  const fournisseur = (re) => { const f = db.findOne('fournisseurs', (x) => re.test(x.nom || '')); return f ? f.id : null; };
  const plan = (eq) => (eq ? db.findOne('plansPreventifs', (p) => Number(p.equipementId) === eq.id) : null);

  const GAMME_GA37 = ['Relever les heures de marche et la pression de service', 'Contrôler le niveau d\'huile et l\'absence de fuite', 'Nettoyer le préfiltre d\'aspiration de l\'armoire', 'Purger les condensats et tester le purgeur automatique', 'Contrôler la température de refoulement (< 100 °C)', 'Vérifier le serrage des raccords et l\'état des flexibles'];
  const GAMME_VGP = ['Examen de l\'état de conservation (structure, chemin de roulement)', 'Essai de fonctionnement à vide de tous les mouvements', 'Contrôle des fins de course haut / bas et translation', 'Contrôle du câble de levage et du crochet (linguet)', 'Essai de freinage en charge nominale (5 t)', 'Contrôle de l\'arrêt d\'urgence de la télécommande'];
  const GAMME_CTA = ['Consigner la CTA (sectionneur cadenassé)', 'Déposer les filtres F7 et relever la perte de charge', 'Nettoyer les glissières et le caisson', 'Poser les filtres neufs et vérifier l\'étanchéité des joints', 'Remettre en service et relever la nouvelle perte de charge'];
  const GAMME_FROID = ['Relever les pressions HP / BP et les températures', 'Contrôle d\'étanchéité du circuit frigorifique (détecteur)', 'Nettoyer les batteries du condenseur', 'Contrôler les intensités des compresseurs', 'Vérifier le fonctionnement des ventilateurs et des sécurités'];

  // Définitions (n = décalage en jours par rapport à aujourd'hui)
  const defs = [
    { titre: 'Remplacement de la courroie du convoyeur de sortie ligne 1', eq: 'Convoyeur de sortie ligne 1', type: 'correctif', prio: 'haute', statut: 'termine', cree: [-76, '07:40'], createur: 'pmartin', tech: 'jbernard', prevu: -75, debut: [-75, '08:10'], fin: [-75, '11:30'], duree: 3,
      description: 'Courroie crantée effilochée sur 40 cm, patinage au démarrage. Risque de casse en production.',
      taches: ['Consigner le convoyeur', 'Déposer les carters de protection', 'Remplacer la courroie et régler la tension', 'Contrôler l\'alignement des poulies', 'Essai à vide puis en charge'], faites: 'toutes',
      temps: [[-75, 'jbernard', 3.25, 'Dépose, remplacement et essais']], pieces: [[/courroie/i, 1]], cause: 'usure',
      rapport: 'Courroie remplacée (usure normale après 18 mois). Tension réglée à 4 mm de flèche, alignement des poulies contrôlé. Essai en charge satisfaisant, convoyeur remis en production à 11 h 30.' },
    { titre: 'Visite préventive mensuelle du compresseur GA 37', eq: 'Compresseur d\'air GA 37', type: 'preventif', prio: 'normale', statut: 'termine', cree: [-64, '09:00'], createur: 'mdupont', tech: 'kleroy', prevu: -60, debut: [-60, '13:30'], fin: [-60, '15:45'], duree: 2,
      description: 'Gamme mensuelle constructeur Atlas Copco.', taches: GAMME_GA37, faites: 'toutes',
      temps: [[-60, 'kleroy', 2.25, 'Gamme complète']], pieces: [[/filtre.*(air|aspiration)|pr[ée]filtre/i, 1]],
      rapport: 'Gamme mensuelle réalisée sans anomalie. Pression de service 7,1 bar, température de refoulement 82 °C. Préfiltre nettoyé, purgeur fonctionnel.' },
    { titre: 'Ajout d\'un carter de protection sur le robot de palettisation', eq: 'Robot de palettisation', type: 'amelioration', prio: 'normale', statut: 'termine', cree: [-58, '10:15'], createur: 'mdupont', tech: 'jbernard', aussi: ['kleroy'], prevu: -50, debut: [-50, '07:30'], fin: [-49, '12:00'], duree: 8,
      description: 'Suite à l\'audit sécurité : installer un carter grillagé avec interrupteur de sécurité sur l\'accès latéral de la cellule robotisée.',
      taches: ['Fabrication du carter grillagé (atelier)', 'Pose et fixation du carter', 'Câblage de l\'interrupteur de sécurité sur la boucle d\'arrêt d\'urgence', 'Essais de sécurité et validation'], faites: 'toutes',
      temps: [[-50, 'jbernard', 4.5, 'Fabrication et pose du carter'], [-50, 'kleroy', 2, 'Câblage interrupteur de sécurité'], [-49, 'jbernard', 2.5, 'Finitions et essais']],
      rapport: 'Carter grillagé posé et interrupteur de sécurité câblé sur la boucle AU. Essais : arrêt du robot à l\'ouverture validé (temps d\'arrêt 0,4 s). Plan de prévention mis à jour.' },
    { titre: TEMOIN, eq: 'Pont roulant 5 t', type: 'reglementaire', prio: 'haute', statut: 'termine', cree: [-52, '08:30'], createur: 'mdupont', tech: 'kleroy', prevu: -45, debut: [-45, '08:00'], fin: [-45, '12:30'], duree: 4,
      description: 'Vérification générale périodique semestrielle (arrêté du 1er mars 2004) réalisée avec l\'organisme de contrôle.', taches: GAMME_VGP, faites: 'toutes',
      temps: [[-45, 'kleroy', 4, 'Accompagnement du vérificateur et essais en charge']], coutExterne: 450, fournisseur: /contr[ôo]le|veritas|apave|socotec|dekra/i,
      rapport: 'VGP réalisée par l\'organisme de contrôle : aucune non-conformité bloquante. Observation : usure légère du linguet de sécurité, remplacement conseillé sous 3 mois. Rapport de vérification joint.',
      document: { nom: 'rapport-vgp-pont-roulant.txt', texte: 'RAPPORT DE VÉRIFICATION GÉNÉRALE PÉRIODIQUE\r\nAppareil : Pont roulant 5 t — Demag EKKE\r\nRésultat : APTE — aucune non-conformité bloquante\r\nObservation : linguet de sécurité du crochet légèrement usé (remplacement conseillé sous 3 mois).\r\nEssai en charge : 5 000 kg — freinage conforme.\r\n' } },
    { titre: 'Remplacement de la batterie du transpalette électrique', eq: 'Transpalette électrique', type: 'correctif', prio: 'basse', statut: 'annule', cree: [-38, '14:00'], createur: 'pmartin', tech: 'jbernard', prevu: -35, fin: [-36, '09:00'],
      description: 'Autonomie insuffisante en fin de poste.', motifAnnulation: 'Batterie remplacée sous garantie par le fournisseur lors de sa visite ; intervention interne inutile.' },
    { titre: 'Visite préventive mensuelle du compresseur GA 37', eq: 'Compresseur d\'air GA 37', type: 'preventif', prio: 'normale', statut: 'termine', cree: [-33, '09:00'], createur: 'mdupont', tech: 'kleroy', prevu: -30, debut: [-30, '14:00'], fin: [-30, '16:30'], duree: 2,
      description: 'Gamme mensuelle constructeur Atlas Copco.', taches: GAMME_GA37, faites: 'toutes',
      temps: [[-30, 'kleroy', 2.5, 'Gamme complète + resserrage d\'un raccord']], cause: null,
      rapport: 'Gamme réalisée. Léger suintement au raccord de sortie du sécheur : resserré, à surveiller. Paramètres de fonctionnement nominaux.' },
    { titre: 'Défaut du capteur de niveau de la cuve de la remplisseuse rotative', eq: 'Remplisseuse rotative', type: 'correctif', prio: 'urgente', statut: 'termine', cree: [-20, '06:20'], createur: 'pmartin', tech: 'kleroy', prevu: -20, debut: [-20, '06:45'], fin: [-20, '09:15'], duree: 2,
      description: 'Alarme « niveau cuve bas » intempestive, arrêts répétés de la remplisseuse depuis le début de poste.',
      taches: ['Diagnostic : contrôle du signal 4-20 mA', 'Remplacement du capteur', 'Étalonnage et essais'], faites: 'toutes',
      temps: [[-20, 'kleroy', 2.5, 'Diagnostic et remplacement du capteur']], pieces: [[/capteur|d[ée]tecteur|sonde/i, 1]], cause: 'electrique',
      rapport: 'Capteur capacitif défectueux (signal instable entre 3 et 9 mA). Capteur remplacé et étalonné, alarme acquittée. 2 h 30 d\'arrêt de la ligne 1.' },
    { titre: 'Chariot thermique n°2 : remplacement des joints du vérin d\'inclinaison', eq: 'Chariot élévateur thermique n°2', type: 'correctif', prio: 'haute', statut: 'termine', demande: 'Chariot thermique n°2 : fuite hydraulique sur le vérin d\'inclinaison', cree: [-19, '15:00'], createur: 'mdupont', tech: 'kleroy', prevu: -16, debut: [-16, '08:00'], fin: [-15, '10:30'], duree: 4,
      description: 'Fuite d\'huile importante sur le vérin d\'inclinaison du mât, chariot immobilisé par sécurité.',
      taches: ['Dépose du vérin d\'inclinaison', 'Remplacement du jeu de joints', 'Repose, purge et appoint d\'huile', 'Essai en charge'], faites: 'toutes',
      temps: [[-16, 'kleroy', 3.5, 'Dépose et remplacement des joints'], [-15, 'kleroy', 1.5, 'Repose, purge, essais']], pieces: [[/joint/i, 1], [/huile.*hydraulique|hydraulique.*huile/i, 5]], cause: 'usure',
      rapport: 'Joints du vérin d\'inclinaison remplacés, niveau d\'huile hydraulique refait. Essai en charge à 2 t : aucune fuite. Chariot remis à disposition de la logistique.' },
    { titre: 'Étiqueteuse : décalage des étiquettes sur les bouteilles', eq: 'Étiqueteuse', type: 'correctif', prio: 'normale', statut: 'termine', cree: [-8, '10:40'], createur: 'pmartin', tech: 'jbernard', prevu: -8, debut: [-8, '11:00'], fin: [-8, '12:30'], duree: 1.5,
      description: 'Étiquettes posées avec un décalage de 3 à 5 mm, taux de rebut en hausse au contrôle visuel.',
      temps: [[-8, 'jbernard', 1.5, 'Réglage du groupe d\'encollage et de la cellule']], cause: 'reglage',
      rapport: 'Cellule de détection des étiquettes déréglée suite au nettoyage. Cellule repositionnée et synchronisation du groupe d\'étiquetage refaite. Décalage < 0,5 mm.' },
    { titre: 'Reprise du joint de tige du vérin principal de la presse 250 t', eq: 'Presse hydraulique 250 t', type: 'correctif', prio: 'haute', statut: 'en_cours', demande: 'Fuite d\'huile sur la presse hydraulique 250 t', cree: [-11, '16:00'], createur: 'pmartin', tech: 'jbernard', prevu: -1, debut: [-1, '13:30'], duree: 6,
      description: 'Traces d\'huile sous le vérin principal, baisse du niveau du réservoir hydraulique d\'environ 2 cm par équipe.',
      taches: ['Consignation hydraulique et électrique de la presse', 'Dépose du vérin principal', 'Remplacement du joint de tige et des racleurs', 'Repose, purge du circuit et appoint', 'Essais de pressage à vide puis en charge'], faites: 2,
      temps: [[-1, 'jbernard', 3.5, 'Consignation et dépose du vérin']], pieces: [[/joint/i, 1]],
      commentaires: [[-1, '15:30', 'jbernard', 'Vérin déposé. La tige est légèrement rayée : à contrôler avant remontage.'], [-1, '16:10', 'mdupont', 'OK, si la rayure dépasse 0,1 mm on fait reprendre la tige en sous-traitance.']] },
    { titre: 'Four de rétraction de la fardeleuse : remplacement de la résistance n°3', eq: 'Fardeleuse', type: 'correctif', prio: 'urgente', statut: 'en_attente', demande: 'Four de rétraction de la fardeleuse : résistance hors service', cree: [-4, '14:20'], createur: 'pmartin', tech: 'kleroy', prevu: -4, debut: [-4, '14:40'], duree: 3,
      description: 'Résistance n°3 du four de rétraction coupée (disjonction au réarmement). Cadence réduite de 20 % et rebuts.',
      taches: ['Contrôle d\'isolement des résistances', 'Remplacement de la résistance n°3', 'Contrôle des intensités et de la régulation'], faites: 1,
      temps: [[-4, 'kleroy', 2, 'Diagnostic : résistance n°3 coupée, isolement des autres OK']], attente: 'Résistance de remplacement en commande chez le constructeur (livraison annoncée sous 5 jours). Marche dégradée sur 5 résistances.' },
    { titre: 'Contrôle des freins du chariot élévateur électrique n°1', eq: 'Chariot élévateur électrique n°1', type: 'securite', prio: 'haute', statut: 'planifie', cree: [-9, '09:10'], createur: 'mdupont', tech: 'jbernard', prevu: -3, duree: 1.5,
      description: 'Le cariste signale un allongement de la distance de freinage. Contrôle des garnitures et du frein de parc.',
      taches: ['Essai de freinage sur 10 m', 'Contrôle de l\'usure des garnitures', 'Contrôle et réglage du frein de parc'] },
    { titre: 'Révision du groupe froid industriel avant l\'hiver', eq: 'Groupe froid industriel', type: 'preventif', prio: 'normale', statut: 'en_cours', cree: [-6, '11:00'], createur: 'mdupont', tech: 'kleroy', prevu: 1, debut: [0, '08:00'], duree: 5,
      description: 'Révision annuelle avant la période hivernale (passage en mode free-cooling).', taches: GAMME_FROID, faites: 2,
      temps: [[0, 'kleroy', 2, 'Relevés et contrôle d\'étanchéité']] },
    { titre: 'Visite préventive mensuelle du compresseur GA 37', eq: 'Compresseur d\'air GA 37', type: 'preventif', prio: 'normale', statut: 'planifie', cree: [-3, '09:00'], createur: 'mdupont', tech: 'kleroy', prevu: 2, duree: 2,
      description: 'Gamme mensuelle constructeur Atlas Copco.', taches: GAMME_GA37 },
    { titre: 'Remplacement des filtres F7 de la CTA atelier conditionnement', eq: 'CTA atelier conditionnement', type: 'preventif', prio: 'basse', statut: 'planifie', cree: [-2, '08:45'], createur: 'mdupont', tech: 'kleroy', prevu: 5, duree: 1.5,
      description: 'Remplacement trimestriel des filtres F7 (perte de charge relevée : 280 Pa, seuil 250 Pa).', taches: GAMME_CTA },
    { titre: 'Remplacement des roulements du moteur principal de la remplisseuse', eq: 'Remplisseuse rotative', type: 'preventif', prio: 'haute', statut: 'planifie', cree: [-1, '10:00'], createur: 'mdupont', tech: 'jbernard', aussi: ['kleroy'], prevu: 9, duree: 6,
      description: 'Analyse vibratoire : niveau d\'alerte atteint sur le roulement côté accouplement (4,8 mm/s). Remplacement programmé pendant l\'arrêt de ligne du week-end.',
      taches: ['Consignation de la remplisseuse', 'Désaccouplement et dépose du moteur', 'Remplacement des roulements 6312 et 6310', 'Repose, alignement laser de l\'accouplement', 'Mesure vibratoire de réception'] },
    { titre: 'Étalonnage annuel de la balance de précision', eq: 'Balance de précision', type: 'reglementaire', prio: 'normale', statut: 'planifie', cree: [-5, '15:30'], createur: 'mdupont', tech: 'kleroy', prevu: 12, duree: 1, coutExterne: 0, fournisseur: /m[ée]trolog|mettler|[ée]talonn/i,
      description: 'Étalonnage annuel par un laboratoire accrédité COFRAC avec émission du certificat.' },
    { titre: 'Fuite d\'air sur le réseau 7 bar de l\'atelier maintenance', eq: 'Compresseur d\'air GA 37', type: 'correctif', prio: 'normale', statut: 'nouveau', cree: [0, '07:50'], createur: 'kleroy', duree: 2,
      description: 'Sifflement audible au niveau de la descente n°3 de l\'atelier maintenance (raccord rapide probablement). Consommation d\'air à vide en hausse.' },
  ];

  defs.sort((a, b) => (a.cree[0] - b.cree[0]) || a.cree[1].localeCompare(b.cree[1]));
  const col = db.data.collections[ENTITE];
  let nbPieces = 0; let nbLiens = 0;
  for (const def of defs) {
    const eq = equipement(def.eq);
    const s = statut(def.statut);
    const createur = userId(def.createur);
    const tech = def.tech ? userId(def.tech) : null;
    const techniciens = tech != null ? [tech].concat((def.aussi || []).map(userId).filter((x) => x != null && x !== tech)) : [];
    const d = def.demande ? demande(def.demande) : null;
    const nbFaites = def.faites === 'toutes' ? (def.taches || []).length : (Number(def.faites) || 0);
    const taches = (def.taches || []).map((libelle, i) => ({ ordre: i + 1, libelle, duree: null, fait: i < nbFaites, faitPar: i < nbFaites ? tech : null, dateFait: i < nbFaites ? (def.fin ? jour(def.fin[0], def.fin[1]) : jour(def.debut ? def.debut[0] : 0, '15:00')) : null }));
    const tempsPasse = (def.temps || []).map(([n, login, heures, commentaire]) => ({ userId: userId(login), date: dateJ(n), heures, commentaire, saisiPar: userId(login), dateSaisie: jour(n, '17:00') }));
    const final = st.estFinal(s);
    const p = def.type === 'preventif' ? plan(eq) : null;
    const historique = [etape(def.cree[0], def.cree[1], def.createur, 'creation', st.initial, d ? `Depuis la demande ${d.numero || d.id}` : '')];
    if (tech != null) historique.push(etape(def.cree[0], def.cree[1], def.createur, 'affectation', st.initial, `Responsable : ${ctx.nomUser(tech)}${def.prevu != null ? ' ; prévu le ' + dateJ(def.prevu).split('-').reverse().join('/') : ''}`));
    if (tech != null && st.planifie && s !== st.initial) historique.push(etape(def.cree[0], def.cree[1], def.createur, 'statut', st.planifie, 'Planification à l\'affectation', { ancien: st.initial }));
    if (def.debut && st.enCours) historique.push(etape(def.debut[0], def.debut[1], def.tech, 'statut', st.enCours, '', { ancien: st.planifie || st.initial }));
    if (def.statut === 'en_attente' && st.attente) historique.push(etape(def.debut ? def.debut[0] : 0, '17:00', def.tech, 'statut', st.attente, def.attente || '', { ancien: st.enCours || st.initial }));
    if (def.statut === 'termine') historique.push(etape(def.fin[0], def.fin[1], def.tech, 'cloture', s, def.rapport ? def.rapport.slice(0, 157) + (def.rapport.length > 157 ? '…' : '') : '', { ancien: st.enCours || st.initial }));
    if (def.statut === 'annule') historique.push(etape(def.fin[0], def.fin[1], def.createur, 'annulation', s, def.motifAnnulation || '', { ancien: st.planifie || st.initial }));
    const record = {
      numero: numeroUnique(), titre: def.titre, description: def.description || '', typeCode: code('typesIntervention', def.type), prioriteCode: code('priorites', def.prio), statut: s,
      equipementId: eq ? eq.id : null, secteurId: eq ? (eq.secteurId == null ? null : eq.secteurId) : null, demandeId: d ? d.id : null, planPreventifId: p ? p.id : null,
      technicienId: tech, techniciens, datePrevue: def.prevu != null ? dateJ(def.prevu) : null,
      dateDebut: def.debut ? jour(def.debut[0], def.debut[1]) : null, dateFin: final && def.fin ? jour(def.fin[0], def.fin[1]) : null,
      dureeEstimee: def.duree == null ? null : def.duree, tempsPasse, pieces: [], piecesPrevues: [], causeCode: causeOk(def.cause), rapport: def.rapport || '',
      commentaires: (def.commentaires || []).map(([n, h, login, texte]) => ({ userId: userId(login), date: jour(n, h), texte })),
      documents: def.document ? [{ nom: def.document.nom, type: 'text/plain', taille: Buffer.byteLength(def.document.texte), contenu: 'data:text/plain;base64,' + Buffer.from(def.document.texte).toString('base64'), date: jour(def.fin[0], '14:00'), userId: tech, description: 'Rapport de l\'organisme de contrôle' }] : [],
      coutPieces: 0, coutMainOeuvre: 0, coutExterne: def.coutExterne || 0, coutTotal: 0, fournisseurId: def.fournisseur ? fournisseur(def.fournisseur) : null,
      compteurReleve: null, taches, cloturePar: final ? (def.statut === 'annule' ? createur : tech) : null, dateCloture: final && def.fin ? jour(def.fin[0], def.fin[1]) : null,
      champs: {}, historique, createdBy: createur,
    };
    if (def.statut === 'termine' && eq && eq.compteur && Array.isArray(eq.compteurReleves) && eq.compteurReleves.length) {
      const fin = record.dateFin;
      const avant = eq.compteurReleves.filter((r) => String(r.date) <= fin).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (avant.length) record.compteurReleve = avant[avant.length - 1].valeur;
    }
    const c = calculerCouts(record, tauxHoraire);
    Object.assign(record, { coutMainOeuvre: c.coutMainOeuvre, coutPieces: c.coutPieces, coutTotal: c.coutTotal });
    const o = db.insert(ENTITE, record);
    const brut = col.find((x) => x.id === o.id);
    if (brut) { brut.createdAt = jour(def.cree[0], def.cree[1]); brut.updatedAt = final && def.fin ? jour(def.fin[0], def.fin[1]) : (def.debut ? jour(def.debut[0], def.debut[1]) : brut.createdAt); }
    // Lien inverse avec la demande d'origine
    if (d && d.otId == null) { db.update('demandes', d.id, { otId: o.id }); nbLiens++; }
    // Pièces consommées : sorties réelles du stock si le module est disponible
    if ((def.pieces || []).length && stock && typeof stock.sortir === 'function' && (def.statut === 'termine' || def.statut === 'en_cours')) {
      const dateSortie = jour(def.debut ? def.debut[0] : def.cree[0], '10:00');
      for (const [re, quantite] of def.pieces) {
        const a = article(re);
        if (!a) continue;
        const appliquer = (r) => {
          const mvt = r && r.mouvement ? r.mouvement : (r && r.id != null && r.articleId != null ? r : null);
          const art = (r && r.article) || db.get('articles', a.id) || a;
          if (mvt && mvt.id != null) { try { db.update('mouvementsStock', mvt.id, { date: dateSortie }); } catch (e) { /* ignore */ } }
          const pu = mvt && mvt.prixUnitaire != null ? Number(mvt.prixUnitaire) : Number(art.prixUnitaire);
          const courant = db.get(ENTITE, o.id);
          const pieces = (courant.pieces || []).concat([{ articleId: a.id, code: art.code || '', designation: art.designation || '', uniteCode: art.uniteCode || null, quantite, prixUnitaire: Number.isFinite(pu) ? pu : 0, mouvementId: mvt && mvt.id != null ? mvt.id : null, date: dateSortie, userId: tech }]);
          const cc = calculerCouts(Object.assign({}, courant, { pieces }), tauxHoraire);
          db.update(ENTITE, o.id, { pieces, coutPieces: cc.coutPieces, coutTotal: cc.coutTotal });
          nbPieces++;
        };
        try {
          const r = stock.sortir({ articleId: a.id, quantite, otId: o.id, userId: tech, motif: `OT ${o.numero} — ${o.titre}` });
          if (r && typeof r.then === 'function') r.then(appliquer).catch(() => {}); else appliquer(r);
        } catch (e) { /* stock insuffisant : on ignore pour la démonstration */ }
      }
    }
  }
  db.touch();
  return `${defs.length} ordres de travail${nbPieces ? `, ${nbPieces} sortie(s) de pièces` : ''}${nbLiens ? `, ${nbLiens} lien(s) avec des demandes` : ''}`;
}

module.exports = { nom, register, seedDemo, outilsStatuts, calculerCouts };
