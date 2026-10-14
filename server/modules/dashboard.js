'use strict';
/**
 * Module Tableau de bord : synthèse calculée pour l'utilisateur connecté (page d'accueil).
 *
 * Route : GET /api/dashboard (droit dashboard.voir) → {
 *   genereLe, aujourdhui, mois, utilisateur, accueil, sections, filtres,
 *   kpis       { otOuverts, otEnRetard, otEnCours, otTerminesMois, heuresMois, coutMois,     (ot.voir)
 *                demandesAValider, demandesOuvertes,                                         (demandes.voir)
 *                preventifsEnRetard, preventifsAVenir7j,                                     (preventif.voir)
 *                articlesSousSeuil,                                                          (stock.voir)
 *                equipementsArret },                                                         (equipements.voir)
 *   graphiques { otParStatut, otParType30j, otParSecteur, topEquipements90j, evolution6Mois,
 *                repartitionPreventifCorrectif },                                            (ot.voir)
 *   listes     { mesOT, otEnRetard, demandesAValider, mesDemandes, prochainsPreventifs, alertesStock,
 *                equipementsArret, dernieresActivites },
 *   compteurs  { compléments chiffrés des listes tronquées (totaux, détails de coût…) },
 * }
 *
 * Chaque section (clé de kpis / graphiques / listes) n'est présente que si l'utilisateur possède le
 * droit « voir » du module correspondant. La portée est appliquée à chaque collection avec les mêmes
 * règles que les modules propriétaires :
 *   - OT : ctx.canSee, étendue aux OT dont l'utilisateur est créateur ou intervenant ;
 *   - demandes : ctx.canSee, étendue aux demandes des subordonnés directs (N+1) ;
 *   - équipements : ctx.services.equipements.visible (repli ctx.canSee) ;
 *   - plans préventifs, articles : ctx.scope (via les services du module quand ils existent).
 * Tout est robuste aux collections vides et à l'absence des autres modules (calculs de repli).
 *
 * Services consommés (appelés paresseusement) : ctx.services.ot.{ statuts },
 *   ctx.services.demandes.STATUTS (la règle de validation peutValider est réévaluée localement, à l'identique),
 *   ctx.services.preventif.echeances,
 *   ctx.services.stock.alertes, ctx.services.equipements.visible.
 * Services publiés : ctx.services.dashboard.calculer(req).
 * Événements : aucun émis ni écouté (calcul à la demande, sans état).
 */
const nom = 'Tableau de bord';
const MODULE = 'dashboard';
const TAILLE_LISTE = 8;
const TAILLE_ACTIVITES = 15;
const TOP_EQUIPEMENTS = 5;
const MOIS_EVOLUTION = 6;
const MAX_SECTEURS_GRAPHIQUE = 8;
const JOURS_TYPES = 30;
const JOURS_TOP = 90;
const JOURS_REPARTITION = 90;
const JOURS_ECHEANCES = 731;

/** Statuts d'OT de repli (utilisés uniquement si la liste `statutsOT` est vide et le module OT absent). */
const STATUTS_OT_DEFAUT = [
  { code: 'nouveau', label: 'Nouveau', couleur: '#6b7280', ordre: 1, final: false },
  { code: 'planifie', label: 'Planifié', couleur: '#2563eb', ordre: 2, final: false },
  { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 3, final: false },
  { code: 'en_attente', label: 'En attente', couleur: '#8b5cf6', ordre: 4, final: false },
  { code: 'termine', label: 'Terminé', couleur: '#16a34a', ordre: 5, final: true },
  { code: 'annule', label: 'Annulé', couleur: '#dc2626', ordre: 6, final: true },
];

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Libellés des actions du journal d'audit (activité récente). */
const LIBELLES_ACTION = {
  creation: 'Création', modification: 'Modification', suppression: 'Suppression', desactivation: 'Désactivation', duplication: 'Duplication',
  validation: 'Validation', refus: 'Refus', cloture: 'Clôture', annulation: 'Annulation', affectation: 'Affectation', statut: 'Changement de statut',
  reouverture: 'Réouverture', conversion: 'Conversion en OT', convertir: 'Conversion en OT', mouvement: 'Mouvement de stock', generation: 'Génération',
  compteur: 'Relevé de compteur', document: 'Document', commentaire: 'Commentaire', temps: 'Temps passé', pieces: 'Pièces', piece: 'Pièce',
  tache: 'Tâche', taches: 'Tâches', etat: 'Changement d\'état', export: 'Export', planification: 'Planification', replanification: 'Replanification',
};
const ENTITES_ACTIVITE = {
  ot: { module: 'ot', route: 'ot', label: 'Ordre de travail' },
  demandes: { module: 'demandes', route: 'demandes', label: 'Demande' },
  equipements: { module: 'equipements', route: 'equipements', label: 'Équipement' },
};

// ----- Utilitaires purs -------------------------------------------------------
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arrondi = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
/** Date locale AAAA-MM-JJ. */
function dateLocale(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Jour local (AAAA-MM-JJ) d'une date AAAA-MM-JJ ou d'un horodatage ISO ; '' si invalide. */
function jourDe(s) {
  if (!s) return '';
  const str = String(s);
  if (RE_DATE.test(str)) return str;
  const t = Date.parse(str);
  return Number.isNaN(t) ? '' : dateLocale(new Date(t));
}
/** Ajoute n jours à une date AAAA-MM-JJ. */
function ajouterJours(jour, n) {
  const [y, m, d] = String(jour).split('-').map(Number);
  return dateLocale(new Date(y, m - 1, d + n, 12));
}
/** Nombre de jours entre deux dates AAAA-MM-JJ (b − a). */
function joursEntre(a, b) {
  if (!a || !b) return null;
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
/** Les N derniers mois (AAAA-MM), du plus ancien au mois courant. */
function derniersMois(jour, n) {
  const [y, m] = jour.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1, 12);
    out.push({ mois: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, libelle: `${MOIS_COURTS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` });
  }
  return out;
}
const texte = (v) => (v == null ? '' : String(v));
const COLLATEUR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const parTexte = (a, b) => COLLATEUR.compare(texte(a), texte(b));

function register(ctx) {
  const { router, db, perms } = ctx;

  // ----- Configuration : lue une seule fois par calcul (le calcul est synchrone) ------------
  let configCalcul = null;
  const config = () => configCalcul || ctx.config();
  /** Liste de valeurs configurée, triée (équivalent de ctx.liste sans relire la configuration). */
  function liste(nomListe) {
    const l = (config().listes || {})[nomListe];
    return Array.isArray(l) ? l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
  }

  // ----- Statuts (services des modules, sinon repli sur les listes configurées) -----------
  function statutsOt() {
    const s = ctx.services.ot;
    if (s && typeof s.statuts === 'function') {
      try { const st = s.statuts(); if (st && Array.isArray(st.liste) && typeof st.estFinal === 'function') return st; } catch (e) { /* repli */ }
    }
    const configuree = liste('statutsOT');
    const lst = configuree.length ? configuree : STATUTS_OT_DEFAUT;
    const item = (code) => lst.find((x) => x.code === code) || null;
    const estFinal = (code) => { const x = item(code); return !!(x && x.final); };
    const estAnnulation = (code) => { const x = item(code); return !!(x && x.final && (x.code === 'annule' || /annul/i.test(x.label || ''))); };
    const nonFinal = (code, re) => { const x = item(code); if (x && !x.final) return x.code; const t = lst.find((y) => !y.final && re.test(`${y.code} ${y.label || ''}`)); return t ? t.code : null; };
    const finaux = lst.filter((x) => x.final);
    const termine = (finaux.find((x) => x.code === 'termine') || finaux.find((x) => !estAnnulation(x.code)) || finaux[0] || { code: 'termine' }).code;
    return {
      liste: lst, item, estFinal, estAnnulation, termine,
      initial: (lst.find((x) => !x.final) || { code: 'nouveau' }).code,
      enCours: nonFinal('en_cours', /cours/i), attente: nonFinal('en_attente', /attente/i), planifie: nonFinal('planifie', /planifi/i),
      libelle: (code) => { const x = item(code); return x ? x.label : texte(code); },
    };
  }
  function statutsDemande() {
    const lst = liste('statutsDemande');
    const finaux = new Set(lst.filter((x) => x.final).map((x) => x.code));
    let soumise = null;
    const s = ctx.services.demandes;
    if (s) { try { soumise = s.STATUTS && s.STATUTS.soumise; } catch (e) { soumise = null; } }
    if (!soumise) soumise = lst.some((x) => x.code === 'soumise') ? 'soumise' : ((lst.find((x) => !x.final) || {}).code || 'soumise');
    return { liste: lst, finaux, soumise };
  }
  /** Codes d'état d'équipement « à l'arrêt / hors service » (hors réformés). */
  function etatsArret() {
    const etats = liste('etatsEquipement');
    if (!etats.length) return ['arret', 'hors_service'];
    const reforme = (x) => /r[ée]form|rebut|c[ée]d[ée]|vendu/i.test(`${x.code} ${x.label || ''}`);
    return etats.filter((x) => !reforme(x) && (x.code === 'arret' || x.code === 'hors_service' || /arr[eê]t|hors.?service|en panne|\bhs\b/i.test(`${x.code} ${x.label || ''}`))).map((x) => x.code);
  }
  function etatsDegrades() {
    return liste('etatsEquipement').filter((x) => x.code === 'degrade' || /d[ée]grad/i.test(`${x.code} ${x.label || ''}`)).map((x) => x.code);
  }
  /**
   * Classement des types d'intervention (preventif | correctif | autre), calculé une fois par requête :
   * retourne une fonction (code, planPreventifId) → famille.
   */
  function classeurTypes(types) {
    const familles = new Map();
    const famille = (code) => {
      if (familles.has(code)) return familles.get(code);
      const it = types.find((x) => x.code === code);
      const t = `${texte(code)} ${it ? it.label || '' : ''}`;
      const f = code === 'preventif' || /pr[ée]venti/i.test(t) ? 'preventif' : (code === 'correctif' || /correcti|curati|d[ée]pann|panne/i.test(t) ? 'correctif' : 'autre');
      familles.set(code, f);
      return f;
    };
    return (code, planPreventifId) => { const f = famille(code); return f === 'autre' && planPreventifId != null ? 'preventif' : f; };
  }

  // ----- Portée (mêmes règles que les modules propriétaires) -------------------------------
  const estAffecte = (uid, o) => Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid));
  const otVisible = (req, o) => !!o && (ctx.canSee(req, o) || estAffecte(req.user.id, o) || Number(o.createdBy) === req.user.id);
  function subordonnes(req) {
    if (!req._subordonnesTdb) req._subordonnesTdb = new Set(db.list('users', (u) => u.managerId != null && Number(u.managerId) === req.user.id).map((u) => u.id));
    return req._subordonnesTdb;
  }
  const demandeVisible = (req, d) => !!d && (ctx.canSee(req, d) || (d.demandeurId != null && subordonnes(req).has(Number(d.demandeurId))));
  function equipementVisible(req, e) {
    if (!e) return false;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli */ } }
    return ctx.canSee(req, e);
  }
  /**
   * L'utilisateur peut-il valider cette demande ? Même règle que le module Demandes
   * (ctx.services.demandes.peutValider) : droit demandes.valider, demande dans sa portée ou demandeur
   * dont il est le N+1, et, si config.workflow.validerParSuperieurUniquement, N+1 uniquement (sauf
   * administrateur). Évaluée ici avec la configuration lue une seule fois : le service relit la
   * configuration complète à chaque appel, ce qui devient coûteux sur des milliers de demandes.
   */
  function peutValiderDemande(req, d, wf, refs) {
    if (!perms.can(req.perms, 'demandes', 'valider')) return false;
    const dem = d.demandeurId != null ? refs.users().get(Number(d.demandeurId)) : null;
    const estSuperieur = !!(dem && dem.managerId != null && Number(dem.managerId) === req.user.id);
    if (!estSuperieur && !perms.canSeeRecord(req.perms, req.user, d)) return false;
    if (wf.validerParSuperieurUniquement && !req.perms.estAdmin && !estSuperieur) return false;
    return true;
  }

  // ----- Références (chargées à la demande, une fois par calcul) ----------------------------
  function references() {
    const memo = {};
    const charger = (cle, fn) => () => (memo[cle] || (memo[cle] = fn()));
    return {
      equipements: charger('equipements', () => new Map(db.list('equipements').map((e) => [e.id, e]))),
      secteurs: charger('secteurs', () => new Map(db.list('secteurs').map((s) => [s.id, s]))),
      users: charger('users', () => new Map(db.list('users').map((u) => [u.id, u]))),
      fournisseurs: charger('fournisseurs', () => new Map(db.list('fournisseurs').map((f) => [f.id, f]))),
      priorites: charger('priorites', () => new Map(liste('priorites').map((p) => [p.code, p]))),
    };
  }
  function nomUser(refs, id) {
    const u = id == null ? null : refs.users().get(Number(id));
    return u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '';
  }
  const rangPriorite = (refs, code) => { const p = refs.priorites().get(code); return p ? num(p.ordre) : 0; };
  function nomSecteur(refs, id) { const s = id == null ? null : refs.secteurs().get(Number(id)); return s ? s.nom : ''; }

  // ----- Résumés ------------------------------------------------------------------------
  function heuresOt(o) { return (o.tempsPasse || []).reduce((s, t) => s + num(t.heures), 0); }
  function coutOt(o, taux) {
    const pieces = o.coutPieces != null ? num(o.coutPieces) : (o.pieces || []).reduce((s, x) => s + num(x.quantite) * num(x.prixUnitaire), 0);
    const mo = o.coutMainOeuvre != null ? num(o.coutMainOeuvre) : heuresOt(o) * taux;
    return { pieces, mainOeuvre: mo, externe: num(o.coutExterne), total: pieces + mo + num(o.coutExterne) };
  }
  function resumeOt(o, refs, st, auj) {
    const e = o.equipementId != null ? refs.equipements().get(Number(o.equipementId)) : null;
    const prevu = jourDe(o.datePrevue);
    const retard = !!prevu && !st.estFinal(o.statut) && prevu < auj;
    const taches = o.taches || [];
    return {
      id: o.id, numero: o.numero || '', titre: o.titre || '', statut: o.statut, typeCode: o.typeCode || null, prioriteCode: o.prioriteCode || null,
      datePrevue: prevu || null, dateDebut: o.dateDebut || null, dateFin: o.dateFin || null,
      equipementId: o.equipementId == null ? null : o.equipementId, equipementNom: e ? e.nom || '' : '', equipementNumero: e ? e.numero || '' : '',
      secteurId: o.secteurId == null ? null : o.secteurId, secteurNom: nomSecteur(refs, o.secteurId),
      technicienId: o.technicienId == null ? null : o.technicienId, technicienNom: nomUser(refs, o.technicienId), techniciens: (o.techniciens || []).map(Number),
      dureeEstimee: o.dureeEstimee == null ? null : num(o.dureeEstimee), tempsTotal: arrondi(heuresOt(o)),
      nbTaches: taches.length, nbTachesFaites: taches.filter((t) => t.fait).length,
      enRetard: retard, joursRetard: retard ? joursEntre(prevu, auj) : 0, aujourdhui: prevu === auj,
      demandeId: o.demandeId == null ? null : o.demandeId, planPreventifId: o.planPreventifId == null ? null : o.planPreventifId,
      createdAt: o.createdAt || null, updatedAt: o.updatedAt || null,
    };
  }
  function echeanceDemande(d, refs) {
    const p = refs.priorites().get(d.prioriteCode);
    const base = d.dateDemande || d.createdAt;
    if (!p || !p.delaiHeures || !base) return null;
    const t = Date.parse(base);
    return Number.isNaN(t) ? null : new Date(t + num(p.delaiHeures) * 3600000).toISOString();
  }
  function resumeDemande(d, refs, finaux) {
    const e = d.equipementId != null ? refs.equipements().get(Number(d.equipementId)) : null;
    const echeance = echeanceDemande(d, refs);
    return {
      id: d.id, numero: d.numero || '', titre: d.titre || '', statut: d.statut, prioriteCode: d.prioriteCode || null, typeCode: d.typeCode || null,
      dateDemande: d.dateDemande || d.createdAt || null, demandeurId: d.demandeurId == null ? null : d.demandeurId, demandeurNom: nomUser(refs, d.demandeurId),
      equipementId: d.equipementId == null ? null : d.equipementId, equipementNom: e ? e.nom || '' : '',
      secteurId: d.secteurId == null ? null : d.secteurId, secteurNom: nomSecteur(refs, d.secteurId),
      arretProduction: !!d.arretProduction, otId: d.otId == null ? null : d.otId,
      echeance, enRetard: !finaux.has(d.statut) && !!echeance && echeance < new Date().toISOString(),
    };
  }

  // ----- Sections -----------------------------------------------------------------------
  function sectionOt(req, out, refs, auj) {
    const st = statutsOt();
    const uid = req.user.id;
    const mois = auj.slice(0, 7);
    const taux = num((config().general || {}).tauxHoraire);
    const ots = db.list('ot').filter((o) => otVisible(req, o));
    const types = liste('typesIntervention');
    const familleType = classeurTypes(types);
    const estFinal = (o) => st.estFinal(o.statut);
    const estTermine = (o) => estFinal(o) && !st.estAnnulation(o.statut);
    const annule = (o) => estFinal(o) && st.estAnnulation(o.statut);
    const finDe = (o) => jourDe(o.dateFin || o.dateCloture);
    const enRetard = (o) => !estFinal(o) && !!o.datePrevue && jourDe(o.datePrevue) < auj;
    const ouverts = ots.filter((o) => !estFinal(o));
    const terminesMois = ots.filter((o) => estTermine(o) && finDe(o).slice(0, 7) === mois);
    let heuresMois = 0;
    for (const o of ots) for (const t of o.tempsPasse || []) if (jourDe(t.date).slice(0, 7) === mois) heuresMois += num(t.heures);
    const cout = { pieces: 0, mainOeuvre: 0, externe: 0, total: 0 };
    for (const o of terminesMois) { const c = coutOt(o, taux); cout.pieces += c.pieces; cout.mainOeuvre += c.mainOeuvre; cout.externe += c.externe; cout.total += c.total; }

    Object.assign(out.kpis, {
      otOuverts: ouverts.length,
      otEnRetard: ouverts.filter(enRetard).length,
      otEnCours: st.enCours ? ots.filter((o) => o.statut === st.enCours).length : 0,
      otTerminesMois: terminesMois.length,
      heuresMois: arrondi(heuresMois),
      coutMois: arrondi(cout.total),
    });
    const mesOuverts = ouverts.filter((o) => estAffecte(uid, o));
    Object.assign(out.compteurs, {
      mesOT: mesOuverts.length,
      mesOTEnRetard: mesOuverts.filter(enRetard).length,
      mesOTAujourdhui: mesOuverts.filter((o) => jourDe(o.datePrevue) === auj).length,
      otNonAffectes: ouverts.filter((o) => o.technicienId == null && !(o.techniciens || []).length).length,
      otEnAttente: st.attente ? ots.filter((o) => o.statut === st.attente).length : 0,
      otAujourdhui: ouverts.filter((o) => jourDe(o.datePrevue) === auj).length,
      coutMoisDetail: { pieces: arrondi(cout.pieces), mainOeuvre: arrondi(cout.mainOeuvre), externe: arrondi(cout.externe) },
    });
    out.filtres.statutEnCours = st.enCours || null;
    out.filtres.statutAttente = st.attente || null;
    out.filtres.statutTermine = st.termine || null;

    // Graphiques
    const parStatut = new Map();
    for (const o of ots) parStatut.set(o.statut, (parStatut.get(o.statut) || 0) + 1);
    const otParStatut = st.liste.map((s) => ({ code: s.code, label: s.label || s.code, couleur: s.couleur || '#6b7280', final: !!s.final, valeur: parStatut.get(s.code) || 0 }));
    for (const [code, n] of parStatut) if (!st.liste.some((s) => s.code === code)) otParStatut.push({ code, label: code == null ? 'Sans statut' : String(code), couleur: '#9ca3af', final: false, valeur: n });

    const depuis30 = ajouterJours(auj, -(JOURS_TYPES - 1));
    const recents30 = ots.filter((o) => !annule(o) && jourDe(o.createdAt) >= depuis30);
    const parType = new Map();
    for (const o of recents30) { const k = types.some((t) => t.code === o.typeCode) ? o.typeCode : null; parType.set(k, (parType.get(k) || 0) + 1); }
    const otParType30j = types.map((t) => ({ code: t.code, label: t.label || t.code, couleur: t.couleur || '#2563eb', valeur: parType.get(t.code) || 0 }));
    if (parType.get(null)) otParType30j.push({ code: null, label: 'Non renseigné', couleur: '#9ca3af', valeur: parType.get(null) });

    const parSecteur = new Map();
    for (const o of ouverts) { const k = o.secteurId == null ? null : Number(o.secteurId); parSecteur.set(k, (parSecteur.get(k) || 0) + 1); }
    let otParSecteur = Array.from(parSecteur.entries()).map(([id, n]) => {
      const s = id == null ? null : refs.secteurs().get(id);
      return { secteurId: id, label: s ? s.nom : (id == null ? 'Sans secteur' : `Secteur #${id}`), couleur: (s && s.couleur) || '#6b7280', valeur: n };
    }).sort((a, b) => b.valeur - a.valeur || parTexte(a.label, b.label));
    if (otParSecteur.length > MAX_SECTEURS_GRAPHIQUE) {
      const reste = otParSecteur.slice(MAX_SECTEURS_GRAPHIQUE - 1);
      otParSecteur = otParSecteur.slice(0, MAX_SECTEURS_GRAPHIQUE - 1).concat([{ secteurId: 'autres', label: 'Autres secteurs', couleur: '#9ca3af', valeur: reste.reduce((s, x) => s + x.valeur, 0) }]);
    }

    const depuis90 = ajouterJours(auj, -(JOURS_TOP - 1));
    const parEq = new Map();
    for (const o of ots) {
      if (o.equipementId == null || annule(o) || jourDe(o.createdAt) < depuis90) continue;
      const k = Number(o.equipementId);
      const cur = parEq.get(k) || { nbOt: 0, nbCorrectifs: 0, heures: 0, cout: 0, ouverts: 0 };
      cur.nbOt += 1;
      if (familleType(o.typeCode, o.planPreventifId) === 'correctif') cur.nbCorrectifs += 1;
      cur.heures += heuresOt(o);
      cur.cout += coutOt(o, taux).total;
      if (!estFinal(o)) cur.ouverts += 1;
      parEq.set(k, cur);
    }
    const topEquipements90j = Array.from(parEq.entries()).map(([id, v]) => {
      const e = refs.equipements().get(id);
      return {
        equipementId: id, numero: e ? e.numero || '' : '', nom: e ? e.nom : `Équipement #${id}`, secteurId: e && e.secteurId != null ? e.secteurId : null,
        etatCode: e ? e.etatCode || null : null, criticiteCode: e ? e.criticiteCode || null : null,
        nbOt: v.nbOt, nbCorrectifs: v.nbCorrectifs, ouverts: v.ouverts, heures: arrondi(v.heures), cout: arrondi(v.cout),
      };
    }).sort((a, b) => b.nbOt - a.nbOt || b.nbCorrectifs - a.nbCorrectifs || b.heures - a.heures || parTexte(a.nom, b.nom)).slice(0, TOP_EQUIPEMENTS);

    const evolution6Mois = derniersMois(auj, MOIS_EVOLUTION).map((m) => ({ mois: m.mois, libelle: m.libelle, crees: 0, termines: 0 }));
    const indexMois = new Map(evolution6Mois.map((m, i) => [m.mois, i]));
    for (const o of ots) {
      const ic = indexMois.get(jourDe(o.createdAt).slice(0, 7));
      if (ic !== undefined) evolution6Mois[ic].crees += 1;
      if (estTermine(o)) { const it = indexMois.get(finDe(o).slice(0, 7)); if (it !== undefined) evolution6Mois[it].termines += 1; }
    }

    const depuisRep = ajouterJours(auj, -(JOURS_REPARTITION - 1));
    const rep = { preventif: 0, correctif: 0, autre: 0 };
    for (const o of ots) { if (annule(o) || jourDe(o.createdAt) < depuisRep) continue; rep[familleType(o.typeCode, o.planPreventifId)] += 1; }
    const totalRep = rep.preventif + rep.correctif + rep.autre;
    const coulType = (code, defaut) => { const t = types.find((x) => x.code === code); return (t && t.couleur) || defaut; };
    const libType = (code, defaut) => { const t = types.find((x) => x.code === code); return (t && t.label) || defaut; };
    const repartitionPreventifCorrectif = {
      periodeJours: JOURS_REPARTITION, total: totalRep, preventif: rep.preventif, correctif: rep.correctif, autres: rep.autre,
      tauxPreventif: totalRep ? Math.round((rep.preventif / totalRep) * 100) : null,
      segments: [
        { cle: 'preventif', label: libType('preventif', 'Préventif'), couleur: coulType('preventif', '#2563eb'), valeur: rep.preventif },
        { cle: 'correctif', label: libType('correctif', 'Correctif'), couleur: coulType('correctif', '#dc2626'), valeur: rep.correctif },
        { cle: 'autres', label: 'Autres (amélioration, réglementaire…)', couleur: '#9ca3af', valeur: rep.autre },
      ],
    };
    Object.assign(out.graphiques, { otParStatut, otParType30j, otParSecteur, topEquipements90j, evolution6Mois, repartitionPreventifCorrectif });

    // Listes
    const prio = (o) => rangPriorite(refs, o.prioriteCode);
    const mesOT = mesOuverts.slice().sort((a, b) => {
      const ea = a.statut === st.enCours ? 0 : 1; const eb = b.statut === st.enCours ? 0 : 1;
      return ea - eb || texte(jourDe(a.datePrevue) || '9999-12-31').localeCompare(jourDe(b.datePrevue) || '9999-12-31') || prio(b) - prio(a) || a.id - b.id;
    }).slice(0, TAILLE_LISTE).map((o) => resumeOt(o, refs, st, auj));
    const otEnRetard = ouverts.filter(enRetard).sort((a, b) => jourDe(a.datePrevue).localeCompare(jourDe(b.datePrevue)) || prio(b) - prio(a) || a.id - b.id)
      .slice(0, TAILLE_LISTE).map((o) => resumeOt(o, refs, st, auj));
    Object.assign(out.listes, { mesOT, otEnRetard });
    return { ots, st };
  }

  function sectionDemandes(req, out, refs) {
    const sd = statutsDemande();
    const wf = config().workflow || {};
    const uid = req.user.id;
    const dems = db.list('demandes').filter((d) => demandeVisible(req, d));
    const ouvertes = dems.filter((d) => !sd.finaux.has(d.statut));
    const aValider = dems.filter((d) => d.statut === sd.soumise && peutValiderDemande(req, d, wf, refs));
    const estMienne = (d) => Number(d.demandeurId) === uid || Number(d.createdBy) === uid;
    const prio = (d) => rangPriorite(refs, d.prioriteCode);
    const dateD = (d) => texte(d.dateDemande || d.createdAt);
    Object.assign(out.kpis, { demandesAValider: aValider.length, demandesOuvertes: ouvertes.length });
    const nowIso = new Date().toISOString();
    Object.assign(out.compteurs, {
      mesDemandesOuvertes: ouvertes.filter(estMienne).length,
      demandesEnRetard: ouvertes.filter((d) => { const e = echeanceDemande(d, refs); return !!e && e < nowIso; }).length,
      demandesArretProduction: ouvertes.filter((d) => d.arretProduction).length,
    });
    out.filtres.statutSoumise = sd.soumise;
    out.listes.demandesAValider = aValider.slice()
      .sort((a, b) => (b.arretProduction ? 1 : 0) - (a.arretProduction ? 1 : 0) || prio(b) - prio(a) || dateD(a).localeCompare(dateD(b)) || a.id - b.id)
      .slice(0, TAILLE_LISTE).map((d) => resumeDemande(d, refs, sd.finaux));
    out.listes.mesDemandes = ouvertes.filter(estMienne).sort((a, b) => dateD(b).localeCompare(dateD(a)) || b.id - a.id)
      .slice(0, TAILLE_LISTE).map((d) => resumeDemande(d, refs, sd.finaux));
    return { dems };
  }

  /** Échéances préventives (première occurrence de chaque plan actif visible). */
  function echeancesPreventif(req, auj) {
    const s = ctx.services.preventif;
    if (s && typeof s.echeances === 'function') {
      try {
        const occ = s.echeances({ req, jours: JOURS_ECHEANCES, projection: false });
        if (Array.isArray(occ)) return occ.filter((o) => !o.occurrence);
      } catch (e) { ctx.log('Tableau de bord : échéances préventives indisponibles', e.message); }
    }
    // Repli : plans calendaires uniquement (prochaineEcheance au format date)
    const refsUsers = new Map(db.list('users').map((u) => [u.id, u]));
    const eqs = new Map(db.list('equipements').map((e) => [e.id, e]));
    return ctx.scope(req, db.list('plansPreventifs', (p) => p.actif !== false)).map((p) => {
      const per = p.periodicite || {};
      const date = per.type === 'compteur' ? '' : jourDe(p.prochaineEcheance);
      if (!date) return null;
      const e = p.equipementId != null ? eqs.get(Number(p.equipementId)) : null;
      const u = p.technicienId != null ? refsUsers.get(Number(p.technicienId)) : null;
      const jr = joursEntre(auj, date);
      return {
        planId: p.id, numero: p.numero || '', nom: p.nom || '', typeCode: p.typeCode || null, prioriteCode: p.prioriteCode || null,
        equipementId: p.equipementId == null ? null : p.equipementId, equipementNom: e ? e.nom : '', equipementNumero: e ? e.numero || '' : '',
        secteurId: p.secteurId == null ? null : p.secteurId, technicienId: p.technicienId == null ? null : p.technicienId,
        technicienNom: u ? (`${u.prenom || ''} ${u.nom || ''}`.trim() || u.login) : '', dureeEstimee: p.dureeEstimee == null ? null : p.dureeEstimee,
        periodicite: per, periodiciteLibelle: per.valeur ? `${per.valeur} ${per.type || ''}`.trim() : '', typePeriodicite: 'date',
        occurrence: 0, date, valeurCompteur: null, estimee: false, etat: jr < 0 ? 'en_retard' : 'a_jour', enRetard: jr < 0, joursRestants: jr,
        otOuvertId: null, otOuvertNumero: '', otOuvertStatut: null,
      };
    }).filter(Boolean);
  }

  function sectionPreventif(req, out, refs, auj) {
    const occ = echeancesPreventif(req, auj);
    const dans7 = ajouterJours(auj, 7);
    const enRetard = (o) => !!o.enRetard || o.etat === 'en_retard';
    out.kpis.preventifsEnRetard = occ.filter(enRetard).length;
    out.kpis.preventifsAVenir7j = occ.filter((o) => !enRetard(o) && o.date && o.date >= auj && o.date <= dans7).length;
    out.compteurs.preventifsProches = occ.filter((o) => o.etat === 'proche').length;
    out.compteurs.preventifsSansOtEnRetard = occ.filter((o) => enRetard(o) && o.otOuvertId == null).length;
    out.listes.prochainsPreventifs = occ.slice().sort((a, b) => (enRetard(b) ? 1 : 0) - (enRetard(a) ? 1 : 0)
      || (a.date ? 0 : 1) - (b.date ? 0 : 1) || texte(a.date).localeCompare(texte(b.date)) || rangPriorite(refs, b.prioriteCode) - rangPriorite(refs, a.prioriteCode) || num(a.planId) - num(b.planId))
      .slice(0, TAILLE_LISTE).map((o) => ({
        planId: o.planId, numero: o.numero || '', nom: o.nom || '', typeCode: o.typeCode || null, prioriteCode: o.prioriteCode || null,
        equipementId: o.equipementId == null ? null : o.equipementId, equipementNom: o.equipementNom || '', equipementNumero: o.equipementNumero || '',
        secteurId: o.secteurId == null ? null : o.secteurId, technicienId: o.technicienId == null ? null : o.technicienId, technicienNom: o.technicienNom || '',
        date: o.date || null, joursRestants: o.joursRestants == null ? null : o.joursRestants, etat: o.etat || null, enRetard: enRetard(o), estimee: !!o.estimee,
        typePeriodicite: o.typePeriodicite || null, periodiciteLibelle: o.periodiciteLibelle || '', valeurCompteur: o.valeurCompteur == null ? null : o.valeurCompteur,
        uniteCompteur: o.uniteCompteur || null, dureeEstimee: o.dureeEstimee == null ? null : o.dureeEstimee,
        otOuvertId: o.otOuvertId == null ? null : o.otOuvertId, otOuvertNumero: o.otOuvertNumero || '',
      }));
  }

  function sectionStock(req, out, refs) {
    let alertes = null;
    const s = ctx.services.stock;
    if (s && typeof s.alertes === 'function') { try { const r = s.alertes(req); if (Array.isArray(r)) alertes = r; } catch (e) { alertes = null; } }
    if (!alertes) alertes = ctx.scope(req, db.list('articles', (a) => a.actif !== false && num(a.quantite) <= num(a.seuilMin)));
    const ratio = (a) => (num(a.seuilMin) > 0 ? num(a.quantite) / num(a.seuilMin) : (num(a.quantite) <= 0 ? -1 : 1));
    out.kpis.articlesSousSeuil = alertes.length;
    out.compteurs.articlesRupture = alertes.filter((a) => num(a.quantite) <= 0).length;
    out.listes.alertesStock = alertes.slice().sort((a, b) => (num(a.quantite) <= 0 ? 0 : 1) - (num(b.quantite) <= 0 ? 0 : 1) || ratio(a) - ratio(b) || parTexte(a.code, b.code))
      .slice(0, TAILLE_LISTE).map((a) => {
        const f = a.fournisseurId != null ? refs.fournisseurs().get(Number(a.fournisseurId)) : null;
        const qac = a.quantiteACommander != null ? num(a.quantiteACommander) : Math.max(num(a.quantiteCommande), num(a.seuilMin) * 2 - num(a.quantite), 0);
        return {
          id: a.id, code: a.code || '', designation: a.designation || '', quantite: arrondi(num(a.quantite), 3), seuilMin: num(a.seuilMin), uniteCode: a.uniteCode || null,
          quantiteACommander: arrondi(qac, 3), emplacement: a.emplacement || '', fournisseurId: a.fournisseurId == null ? null : a.fournisseurId,
          fournisseurNom: a.fournisseurNom || (f ? f.nom || '' : ''), rupture: num(a.quantite) <= 0,
        };
      });
  }

  function sectionEquipements(req, out, refs) {
    const arret = new Set(etatsArret());
    const degrades = new Set(etatsDegrades());
    const visibles = db.list('equipements', (e) => e.actif !== false && (arret.has(e.etatCode) || degrades.has(e.etatCode))).filter((e) => equipementVisible(req, e));
    const enArret = visibles.filter((e) => arret.has(e.etatCode));
    const crit = new Map(liste('criticites').map((c) => [c.code, num(c.ordre)]));
    out.kpis.equipementsArret = enArret.length;
    out.compteurs.equipementsDegrades = visibles.filter((e) => degrades.has(e.etatCode)).length;
    out.filtres.etatsArret = Array.from(arret);
    out.listes.equipementsArret = enArret.slice().sort((a, b) => (crit.has(a.criticiteCode) ? crit.get(a.criticiteCode) : 99) - (crit.has(b.criticiteCode) ? crit.get(b.criticiteCode) : 99) || parTexte(a.nom, b.nom))
      .slice(0, TAILLE_LISTE).map((e) => {
        const h = (e.historiqueEtats || []).filter((x) => x && x.nouveau === e.etatCode).sort((x, y) => texte(y.date).localeCompare(texte(x.date)))[0];
        return {
          id: e.id, numero: e.numero || '', nom: e.nom || '', etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null,
          secteurId: e.secteurId == null ? null : e.secteurId, secteurNom: nomSecteur(refs, e.secteurId), localisation: e.localisation || '',
          depuis: h ? h.date || null : null, motif: h ? h.commentaire || '' : '',
        };
      });
  }

  /** Activité récente : journal d'audit (droit audit.voir) sinon derniers OT modifiés. */
  function sectionActivites(req, out, refs, contexte) {
    const voir = (m) => perms.can(req.perms, m, 'voir');
    let activites = [];
    let source = null;
    if (perms.can(req.perms, 'audit', 'voir')) {
      const entites = Object.keys(ENTITES_ACTIVITE).filter((k) => voir(ENTITES_ACTIVITE[k].module));
      if (entites.length) {
        const maps = {};
        const enregistrements = (ent) => maps[ent] || (maps[ent] = ent === 'equipements' ? refs.equipements() : new Map(db.list(ent).map((r) => [r.id, r])));
        const visibleSelon = { ot: otVisible, demandes: demandeVisible, equipements: equipementVisible };
        const toutVoir = req.perms.portee === 'tous' && !req.perms.siteFiltre;
        const lignes = db.list('audit', (a) => entites.includes(a.entite)).sort((a, b) => texte(b.date).localeCompare(texte(a.date)) || b.id - a.id);
        for (const a of lignes) {
          if (activites.length >= TAILLE_ACTIVITES) break;
          const rec = a.entiteId == null ? null : enregistrements(a.entite).get(Number(a.entiteId));
          if (rec ? !visibleSelon[a.entite](req, rec) : !toutVoir) continue;
          const def = ENTITES_ACTIVITE[a.entite];
          activites.push({
            id: a.id, date: a.date, userId: a.userId == null ? null : a.userId, userNom: a.userNom || nomUser(refs, a.userId) || 'Système',
            action: a.action, actionLibelle: LIBELLES_ACTION[a.action] || texte(a.action).replace(/_/g, ' '),
            entite: a.entite, entiteLibelle: def.label, entiteId: a.entiteId == null ? null : a.entiteId,
            libelle: rec ? [rec.numero, rec.titre || rec.nom].filter(Boolean).join(' — ') : '', details: texte(a.details).slice(0, 300),
            lien: rec ? `#/${def.route}/${rec.id}` : null, supprime: !rec,
          });
        }
        source = 'audit';
      }
    }
    if (!activites.length && voir('ot')) {
      const ots = contexte.ots || db.list('ot').filter((o) => otVisible(req, o));
      const st = contexte.st || statutsOt();
      // Dernière étape significative de chaque OT (chronologie de l'OT), sinon date de mise à jour
      const derniere = (o) => (o.historique || []).filter((x) => x && x.date).sort((x, y) => texte(y.date).localeCompare(texte(x.date)))[0] || null;
      activites = ots.map((o) => ({ o, h: derniere(o) })).map((x) => Object.assign(x, { date: (x.h && x.h.date) || x.o.updatedAt || x.o.createdAt || '' }))
        .sort((a, b) => texte(b.date).localeCompare(texte(a.date)) || b.o.id - a.o.id).slice(0, TAILLE_ACTIVITES).map(({ o, h, date }) => {
        const action = h && h.action ? h.action : 'modification';
        const auteur = h ? h.userId : o.createdBy;
        return {
          id: `ot-${o.id}`, date: date || null, userId: auteur == null ? null : auteur, userNom: nomUser(refs, auteur) || 'Système',
          action, actionLibelle: (h && h.libelle) || LIBELLES_ACTION[action] || 'Modification',
          entite: 'ot', entiteLibelle: ENTITES_ACTIVITE.ot.label, entiteId: o.id, libelle: [o.numero, o.titre].filter(Boolean).join(' — '),
          details: `Statut : ${st.libelle(o.statut)}${h && h.commentaire ? ' — ' + texte(h.commentaire).slice(0, 200) : ''}`,
          lien: `#/ot/${o.id}`, supprime: false, statut: o.statut,
        };
      });
      source = 'ot';
    }
    if (source) { out.listes.dernieresActivites = activites; out.sources.activites = source; }
  }

  /** Calcule le tableau de bord de l'utilisateur de la requête. */
  function calculer(req) {
    configCalcul = ctx.config();
    try { return calculerAvecConfig(req); } finally { configCalcul = null; }
  }
  function calculerAvecConfig(req) {
    const p = req.perms;
    const voir = (m) => perms.can(p, m, 'voir');
    const auj = dateLocale();
    const cfg = config();
    const u = req.user;
    const refs = references();
    const out = {
      genereLe: new Date().toISOString(), aujourdhui: auj, mois: auj.slice(0, 7),
      utilisateur: { id: u.id, prenom: u.prenom || '', nom: u.nom || '', login: u.login, fonction: u.fonction || '', profil: p.profilNom || '' },
      accueil: { message: texte((cfg.general || {}).messageAccueil) },
      devise: (cfg.general || {}).devise || '€',
      sections: { ot: voir('ot'), demandes: voir('demandes'), preventif: voir('preventif'), stock: voir('stock'), equipements: voir('equipements'), audit: voir('audit') },
      droits: {
        demandesValider: perms.can(p, 'demandes', 'valider'), demandesCreer: perms.can(p, 'demandes', 'creer'), otCreer: perms.can(p, 'ot', 'creer'),
        stockModifier: perms.can(p, 'stock', 'modifier'), stockCreer: perms.can(p, 'stock', 'creer'), preventifModifier: perms.can(p, 'preventif', 'modifier'),
      },
      filtres: {}, sources: {}, kpis: {}, graphiques: {}, listes: {}, compteurs: {},
    };
    const contexte = {};
    if (out.sections.ot) Object.assign(contexte, sectionOt(req, out, refs, auj));
    if (out.sections.demandes) sectionDemandes(req, out, refs);
    if (out.sections.preventif) sectionPreventif(req, out, refs, auj);
    if (out.sections.stock) sectionStock(req, out, refs);
    if (out.sections.equipements) sectionEquipements(req, out, refs);
    sectionActivites(req, out, refs, contexte);
    return out;
  }

  router.get('/api/dashboard', async (req) => calculer(req), { perm: [MODULE, 'voir'] });

  ctx.services.dashboard = {
    /** Tableau de bord calculé pour une requête authentifiée (req.user, req.perms). */
    calculer: (req) => calculer(req),
  };
}

// ----- Données de démonstration -------------------------------------------------------
const MESSAGE_DEMO = 'Bienvenue sur la GMAO SICAF. Rappel sécurité : toute intervention sur une machine nécessite une consignation préalable (cadenas personnel et étiquette). Signalez toute anomalie par une demande d\'intervention.';

/**
 * Le tableau de bord ne possède pas de collection : ses données de démonstration proviennent des
 * autres modules. On renseigne seulement un message d'accueil s'il est vide (idempotent).
 */
function seedDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  cfg.general = cfg.general || {};
  if (texte(cfg.general.messageAccueil).trim()) return 'message d\'accueil déjà défini';
  cfg.general.messageAccueil = MESSAGE_DEMO;
  db.setConfig(cfg);
  return 'message d\'accueil de démonstration';
}

module.exports = { nom, register, seedDemo };
