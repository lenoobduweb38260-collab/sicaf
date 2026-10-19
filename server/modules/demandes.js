'use strict';
/**
 * Module Demandes d'intervention (DI) : signalement d'anomalies par les demandeurs, circuit de
 * validation (valideurs selon la portée ou le supérieur hiérarchique N+1), conversion en ordre
 * de travail, commentaires, pièces jointes, chronologie des étapes, compteurs et export CSV.
 *
 * Statuts            : liste configurable `statutsDemande` ; chaque étape du circuit (soumise, validee,
 *                      refusee, convertie, cloturee) est résolue dans la liste (voir resoudreStatuts),
 *                      les codes par défaut ne servant que de repli.
 * Portée             : règle commune (ctx.canSee) + le N+1 du demandeur voit les demandes de ses subordonnés.
 * Services publiés   : ctx.services.demandes.{ get(id), lieeA(ot), ouvertesPour({ equipementId, secteurId }),
 *                      peutValider(req, demande), STATUTS, resoudreStatuts(liste) }
 * Événements émis    : 'demande:soumise', 'demande:validee', 'demande:refusee', 'demande:convertie',
 *                      'demande:cloturee', 'demande:reouverte' (charge utile : la demande)
 * Événements écoutés : 'ot:termine' (clôture la DI liée si config.workflow.cloturerDemandeAvecOt),
 *                      'ot:cree' (synchronise otId / statut « convertie »), 'ot:annule' (la DI redevient validée,
 *                      y compris après une clôture automatique), 'ot:statut' (OT réouvert → la DI validée
 *                      redevient « convertie »)
 */
const nom = 'Demandes d\'intervention';
const ENTITE = 'demandes';
const TAILLE_MAX_PJ = 5 * 1024 * 1024; // 5 Mo par pièce jointe
const MAX_PJ = 20;
const MAX_COMMENTAIRE = 4000;

/** Codes de statut métier par défaut (repli lorsque la liste `statutsDemande` ne les contient pas). */
const S = { soumise: 'soumise', validee: 'validee', refusee: 'refusee', convertie: 'convertie', cloturee: 'cloturee' };
/** Étapes finales du circuit et motifs de reconnaissance d'un statut renommé dans la configuration. */
const ROLES_FINAUX = new Set(['refusee', 'cloturee']);
const MOTIFS_ROLES = {
  soumise: /soumi|nouve|attente|ouvert|signal/i,
  validee: /valid|accept|approuv/i,
  refusee: /refus|rejet|annul/i,
  convertie: /conver|ordre|cours|trait|charge/i,
  cloturee: /cl[oô]tur|termin|ferm|r[ée]solu|sold/i,
};

/**
 * Associe chaque étape du circuit (soumise → validee / refusee → convertie → cloturee) à un code de la
 * liste configurée `statutsDemande` : le code par défaut s'il existe ; sinon un statut reconnu par son
 * code ou son libellé, du même type (indicateur `final`) ; sinon le premier statut libre de ce type
 * (le dernier pour la clôture). Sans liste configurée, les codes par défaut sont utilisés.
 */
function resoudreStatuts(liste) {
  const l = Array.isArray(liste) ? liste.filter((s) => s && s.code).slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];
  const out = Object.assign({}, S);
  if (!l.length) return out;
  const pris = new Set();
  const restants = [];
  for (const role of Object.keys(S)) {
    if (l.some((s) => s.code === S[role])) pris.add(S[role]); else restants.push(role);
  }
  for (const role of restants) {
    const candidats = l.filter((s) => !!s.final === ROLES_FINAUX.has(role) && !pris.has(s.code));
    const it = candidats.find((s) => MOTIFS_ROLES[role].test(s.code) || MOTIFS_ROLES[role].test(s.label || ''))
      || (role === 'cloturee' ? candidats[candidats.length - 1] : candidats[0]);
    if (it) { out[role] = it.code; pris.add(it.code); }
  }
  return out;
}
const LIBELLES_ETAPES = {
  creation: 'Demande soumise', validation: 'Demande validée', refus: 'Demande refusée', conversion: 'Convertie en ordre de travail',
  cloture: 'Demande clôturée', reouverture: 'Demande réouverte', modification: 'Demande modifiée', ot_annule: 'Ordre de travail annulé',
  ot_reouvert: 'Ordre de travail réouvert', pj_supprimee: 'Pièce jointe supprimée',
};
const LIBELLES_CHAMPS = { titre: 'titre', description: 'description', equipementId: 'équipement', secteurId: 'secteur', prioriteCode: 'priorité', typeCode: 'type', arretProduction: 'arrêt de production', demandeurId: 'demandeur', dateDemande: 'date', champs: 'champs personnalisés' };

/** Jour calendaire local (AAAA-MM-JJ) d'une date ISO : les filtres « du / au » portent sur la date locale. */
function jourLocal(v) {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cellule CSV : guillemets si nécessaire et neutralisation des formules (=, +, -, @, tabulation) à l'ouverture dans un tableur. */
function csvEscape(v) {
  let s = v == null ? '' : String(v).replace(/\r\n|\r|\n/g, ' ');
  if (/^[=+\-@\t]/.test(s) && Number.isNaN(Number(s.replace(',', '.')))) s = '\'' + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  // ----- Statuts (liste configurable `statutsDemande`) -------------------------
  const listeStatuts = () => ctx.liste('statutsDemande');
  let memoStatuts = { cle: undefined, roles: null, finaux: null };
  /** Résolution mémorisée tant que la liste configurée ne change pas. */
  function memo() {
    const brute = ((db.data.config || {}).listes || {}).statutsDemande;
    const cle = JSON.stringify(brute == null ? null : brute);
    if (memoStatuts.cle !== cle) {
      const roles = Object.freeze(resoudreStatuts(brute));
      const f = (Array.isArray(brute) ? brute : []).filter((s) => s && s.final).map((s) => s.code);
      memoStatuts = { cle, roles, finaux: f.length ? f : [roles.refusee, roles.cloturee] };
    }
    return memoStatuts;
  }
  /** Codes effectifs des étapes du circuit : { soumise, validee, refusee, convertie, cloturee }. */
  const st = () => memo().roles;
  function libelleStatut(code) { const it = listeStatuts().find((s) => s.code === code); return it ? it.label : String(code || ''); }
  function codesFinaux() { return new Set(memo().finaux); }
  const estFinal = (d) => codesFinaux().has(d.statut);

  // ----- Portée ---------------------------------------------------------------
  /** Subordonnés directs (N-1) de l'utilisateur de la requête (mémorisés pour la requête). */
  function subordonnes(req) {
    if (!req._subordonnesDi) req._subordonnesDi = new Set(db.list('users', (u) => u.managerId != null && Number(u.managerId) === req.user.id).map((u) => u.id));
    return req._subordonnesDi;
  }
  /**
   * Portée d'une demande : règle commune (tous / secteurs / perso) et, en complément, le supérieur
   * hiérarchique (N+1) voit toujours les demandes de ses subordonnés directs, qu'il peut avoir à valider.
   */
  function visible(req, d) {
    if (!d) return false;
    if (ctx.canSee(req, d)) return true;
    return d.demandeurId != null && subordonnes(req).has(Number(d.demandeurId));
  }
  const scope = (req, rows) => (rows || []).filter((d) => visible(req, d));
  function getVisible(req, id) {
    const d = db.get(ENTITE, id);
    if (!d || !visible(req, d)) {
      // Demande d'un site accessible en lecture seule : message explicite plutôt qu'un « introuvable »
      if (d && req.ecriture && perms.canSeeRecord(req.perms, req.user, d)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
      throw new HttpError(404, 'Demande introuvable');
    }
    return d;
  }
  /** Visibilité d'un équipement (déléguée au module Équipements lorsqu'il est présent). */
  function equipementVisible(req, e) {
    if (!e) return false;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') return !!s.visible(req, e);
    if (!req.perms || req.perms.portee !== 'perso') return ctx.canSee(req, e);
    if (e.secteurId == null || !req.perms.secteurIds.length) return true;
    return req.perms.secteurIds.includes(Number(e.secteurId)) || Number(e.createdBy) === req.user.id;
  }
  /** Un utilisateur limité à ses secteurs ne crée des demandes que pour ceux-ci. */
  function verifierPorteeEcriture(req, secteurId) {
    if (!req.perms || req.perms.portee === 'tous' || secteurId == null) return;
    if (req.perms.portee === 'perso' && !req.perms.secteurIds.length) return;
    if (!req.perms.secteurIds.includes(Number(secteurId))) throw new HttpError(403, 'Vous ne pouvez créer des demandes que pour vos propres secteurs');
  }

  // ----- Valideurs ------------------------------------------------------------
  const demandeurDe = (d) => (d.demandeurId != null ? db.get('users', d.demandeurId) : null);
  /** L'utilisateur `user` (droits effectifs `p`) peut-il valider la demande `d` ? */
  function peutValiderAvec(user, p, d, wf) {
    if (!user || !p || !perms.can(p, ENTITE, 'valider')) return false;
    wf = wf || ctx.config().workflow || {};
    const dem = demandeurDe(d);
    const estSuperieur = !!(dem && dem.managerId != null && Number(dem.managerId) === user.id);
    // Valider est une écriture : une demande d'un site accessible en lecture seule n'est pas validable
    if (!estSuperieur && !perms.canSeeRecord(p, user, d, { ecriture: true })) return false;
    if (wf.validerParSuperieurUniquement && !p.estAdmin && !estSuperieur) return false;
    return true;
  }
  const peutValider = (req, d, wf) => peutValiderAvec(req.user, req.perms, d, wf);
  /** Utilisateurs actifs habilités à valider cette demande. */
  function valideursPour(d) {
    const wf = ctx.config().workflow || {};
    return ctx.usersAvecDroit(ENTITE, 'valider', (u, p) => peutValiderAvec(u, p, d, wf));
  }
  /**
   * Valideurs attendus (notifiés) : tous les habilités dans la portée de la demande ; si la validation
   * est réservée au supérieur hiérarchique, uniquement le N+1 du demandeur (repli sur les administrateurs
   * habilités lorsque le demandeur n'a pas de N+1 capable de valider).
   */
  function valideursAttendus(d) {
    const wf = ctx.config().workflow || {};
    const valideurs = valideursPour(d);
    if (!wf.validerParSuperieurUniquement) return valideurs;
    const dem = demandeurDe(d);
    const n1 = dem && dem.managerId != null ? valideurs.filter((u) => u.id === Number(dem.managerId)) : [];
    return n1.length ? n1 : valideurs;
  }

  // ----- Utilitaires ----------------------------------------------------------
  function entree(req, action, statut, commentaire) {
    return { date: new Date().toISOString(), userId: req && req.user ? req.user.id : null, action, libelle: LIBELLES_ETAPES[action] || action, statut: statut || null, commentaire: commentaire ? String(commentaire).slice(0, 1000) : '' };
  }
  function numeroUnique(cfg) {
    const gabarit = ((cfg || ctx.config()).numerotation || {}).di || 'DI-{annee}-{num:4}';
    for (let i = 0; i < 10000; i++) {
      const n = db.nextNumber('di', gabarit);
      if (!db.findOne(ENTITE, (x) => x.numero === n)) return n;
    }
    return 'DI-' + Date.now();
  }
  function miniUser(u) {
    if (!u) return null;
    return { id: u.id, login: u.login, nom: u.nom, prenom: u.prenom, fonction: u.fonction || '', managerId: u.managerId == null ? null : u.managerId, nomComplet: `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login };
  }
  function resumeOt(ot) {
    if (!ot) return null;
    return { id: ot.id, numero: ot.numero, titre: ot.titre, statut: ot.statut, technicienId: ot.technicienId == null ? null : ot.technicienId, datePrevue: ot.datePrevue || null, dateDebut: ot.dateDebut || null, dateFin: ot.dateFin || null, dateCloture: ot.dateCloture || null };
  }
  /** Une pièce jointe n'est retirée que par son auteur, un valideur habilité ou un administrateur (`actions` : actionsPossibles). */
  function peutSupprimerPj(req, doc, actions) {
    if (!actions || !actions.joindre) return false;
    return Number(doc.userId) === req.user.id || !!(req.perms && req.perms.estAdmin) || perms.can(req.perms, ENTITE, 'valider');
  }
  function resumeDoc(doc, index, req, actions) {
    const out = { index, nom: doc.nom, type: doc.type, taille: doc.taille, date: doc.date, userId: doc.userId, userNom: ctx.nomUser(doc.userId), description: doc.description || '' };
    if (req && actions) out.supprimable = peutSupprimerPj(req, doc, actions);
    return out;
  }
  function enrichCommentaire(c) { return Object.assign({}, c, { userNom: ctx.nomUser(c.userId) }); }
  function cheminSecteur(id) {
    const parts = []; let cur = id == null ? null : db.get('secteurs', id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? db.get('secteurs', cur.parentId) : null; }
    return parts.join(' › ');
  }
  /** Élément de la liste `statutsOT` d'un OT (liste mémorisée dans le cache d'une requête). */
  function statutOt(o, cache) {
    if (!o) return null;
    const l = cache && cache.statutsOT ? cache.statutsOT : ctx.liste('statutsOT');
    if (cache && !cache.statutsOT) cache.statutsOT = l;
    return l.find((x) => x.code === o.statut) || null;
  }
  /** Un OT est-il clôturé (statut final de la liste `statutsOT`) ? */
  function otFinal(o, cache) { const s = statutOt(o, cache); return !!(s && s.final); }
  /** Un OT est-il annulé (statut final de la liste `statutsOT` correspondant à une annulation) ? */
  function otAnnule(o, cache) {
    const s = statutOt(o, cache);
    return !!(s && s.final && (s.code === 'annule' || /annul/i.test(s.label || '')));
  }
  /**
   * Index des OT pour une requête : par identifiant et, pour les OT encore ouverts, par demande d'origine.
   * Construit une seule fois par liste ou export (au lieu d'un parcours de la collection par demande).
   */
  function indexOt(cache) {
    if (cache.ots) return cache.ots;
    const parId = new Map(); const ouvertsParDemande = new Map();
    for (const o of db.list('ot')) {
      parId.set(o.id, o);
      if (o.demandeId != null && !otFinal(o, cache)) { const k = Number(o.demandeId); if (!ouvertsParDemande.has(k)) ouvertsParDemande.set(k, o); }
    }
    cache.ots = { parId, ouvertsParDemande };
    return cache.ots;
  }
  /**
   * OT lié à la demande : par `otId`, sinon un OT encore ouvert qui la référence (`demandeId`). Un OT clôturé ou
   * annulé non référencé par `otId` est une intervention passée (demande réouverte) : il n'est pas rattaché ;
   * `inclureAnnules` retourne tout OT référençant la demande (ex. pour interdire sa suppression). Aucune
   * écriture ici : le lien `otId` est posé par les écouteurs d'événements et par la reprise au démarrage.
   */
  function otLie(d, { inclureAnnules = false, cache = null } = {}) {
    let ot = null;
    if (d.otId != null) ot = cache ? (indexOt(cache).parId.get(Number(d.otId)) || null) : db.get('ot', d.otId);
    if (!ot) {
      ot = cache ? (indexOt(cache).ouvertsParDemande.get(d.id) || null) : db.findOne('ot', (o) => Number(o.demandeId) === d.id && !otFinal(o));
      if (!ot && inclureAnnules) ot = db.findOne('ot', (o) => Number(o.demandeId) === d.id);
    }
    return ot;
  }
  /** Équipement d'une demande (table construite une fois par requête). */
  function equipementDe(id, cache) {
    if (id == null) return null;
    if (!cache) return db.get('equipements', id);
    if (!cache.equipements) cache.equipements = new Map(db.list('equipements').map((e) => [e.id, e]));
    return cache.equipements.get(Number(id)) || null;
  }
  function demandeLieeA(ot) {
    if (!ot || ot.id == null) return null;
    const parId = ot.demandeId != null ? db.get(ENTITE, ot.demandeId) : null;
    return parId || db.findOne(ENTITE, (d) => Number(d.otId) === Number(ot.id));
  }
  function echeanceDe(d, priorites) {
    const p = (priorites || ctx.liste('priorites')).find((x) => x.code === d.prioriteCode);
    const base = d.dateDemande || d.createdAt;
    if (!p || !p.delaiHeures || !base) return null;
    const t = new Date(base).getTime();
    return Number.isNaN(t) ? null : new Date(t + Number(p.delaiHeures) * 3600000).toISOString();
  }

  /** Actions possibles pour l'utilisateur courant sur une demande (le client s'en sert pour afficher les boutons). */
  function actionsPossibles(req, d) {
    const can = (a) => perms.can(req.perms, ENTITE, a);
    const estDemandeur = Number(d.demandeurId) === req.user.id || Number(d.createdBy) === req.user.id;
    const final = estFinal(d);
    const sOt = ctx.services.ot;
    const otDisponible = !!(sOt && typeof sOt.creerDepuisDemande === 'function');
    const validable = d.statut === st().soumise && peutValider(req, d);
    return {
      valider: validable,
      refuser: validable,
      convertir: d.statut === st().validee && d.otId == null && perms.can(req.perms, 'ot', 'creer'),
      cloturer: !final && (estDemandeur || can('valider') || can('modifier')),
      reouvrir: final && (can('valider') || (can('modifier') && !estDemandeur)),
      modifier: !final && ((estDemandeur && d.statut === st().soumise) || can('modifier')),
      supprimer: can('supprimer') && d.otId == null,
      commenter: true,
      joindre: (estDemandeur && !final) || can('modifier'),
      otDisponible,
    };
  }

  // ----- Enrichissement -------------------------------------------------------
  function resume(req, d, cache) {
    cache = cache || {};
    const priorites = cache.priorites || (cache.priorites = ctx.liste('priorites'));
    const finaux = cache.finaux || (cache.finaux = codesFinaux());
    const wf = cache.wf || (cache.wf = ctx.config().workflow || {});
    const { pieceJointes, commentaires, historique, ...reste } = d;
    const e = equipementDe(d.equipementId, cache);
    const ot = otLie(d, { cache });
    const echeance = echeanceDe(d, priorites);
    const final = finaux.has(d.statut);
    return Object.assign(reste, {
      otId: ot ? ot.id : (d.otId == null ? null : d.otId),
      equipementNom: e ? e.nom : '', equipementNumero: e ? e.numero : '', equipementVisible: e ? equipementVisible(req, e) : false,
      secteurNom: d.secteurId != null ? ((db.get('secteurs', d.secteurId) || {}).nom || '') : '',
      secteurChemin: cheminSecteur(d.secteurId),
      demandeurNom: ctx.nomUser(d.demandeurId), validateurNom: ctx.nomUser(d.validateurId),
      otNumero: ot ? ot.numero : '', otStatut: ot ? ot.statut : null,
      nbCommentaires: (commentaires || []).length, nbPieceJointes: (pieceJointes || []).length,
      final, echeance, enRetard: !final && !!echeance && echeance < new Date().toISOString(),
      peutValider: d.statut === st().soumise && peutValider(req, d, wf),
      champs: d.champs || {},
    });
  }
  function detail(req, d) {
    const cache = {};
    const e = equipementDe(d.equipementId, cache);
    const base = resume(req, d, cache);
    const ot = otLie(d, { cache });
    const actions = actionsPossibles(req, d);
    return Object.assign(base, {
      description: d.description || '',
      equipement: e ? { id: e.id, numero: e.numero, nom: e.nom, typeCode: e.typeCode, etatCode: e.etatCode, criticiteCode: e.criticiteCode, secteurId: e.secteurId == null ? null : e.secteurId, localisation: e.localisation || '', parentId: e.parentId == null ? null : e.parentId, actif: e.actif !== false } : null,
      ot: resumeOt(ot),
      demandeur: miniUser(demandeurDe(d)),
      validateur: miniUser(d.validateurId != null ? db.get('users', d.validateurId) : null),
      commentaires: (d.commentaires || []).map(enrichCommentaire),
      pieceJointes: (d.pieceJointes || []).map((p, i) => resumeDoc(p, i, req, actions)),
      historique: (d.historique || []).map((h) => Object.assign({}, h, { userNom: h.userId != null ? ctx.nomUser(h.userId) : 'Système' })),
      valideurs: d.statut === st().soumise ? valideursAttendus(d).map(miniUser) : [],
      actions,
    });
  }

  // ----- Validation des entrées -----------------------------------------------
  function codeValide(liste, code, courant, defaut, label) {
    const l = ctx.liste(liste);
    if (code === undefined) code = courant;
    if (code == null || code === '') {
      if (!l.length) return defaut;
      return l.some((x) => x.code === defaut) ? defaut : l[0].code;
    }
    code = String(code);
    if (l.length && !l.some((x) => x.code === code) && code !== courant) throw new HttpError(400, `${label} invalide`);
    return code;
  }
  function valider(req, body, existant) {
    const b = body && typeof body === 'object' && !Buffer.isBuffer(body) ? body : {};
    const out = {};
    const txt = (k, max) => { const v = b[k] === undefined ? (existant ? existant[k] : '') : b[k]; return String(v == null ? '' : v).trim().slice(0, max); };
    out.titre = txt('titre', 200);
    if (!out.titre) throw new HttpError(400, 'Le titre de la demande est obligatoire');
    if (out.titre.length < 3) throw new HttpError(400, 'Le titre doit comporter au moins 3 caractères');
    out.description = txt('description', 5000);

    // Équipement → secteur repris de l'équipement ; sinon secteur libre
    let equipementId = b.equipementId === undefined ? (existant ? existant.equipementId : null) : (b.equipementId === '' || b.equipementId === null ? null : Number(b.equipementId));
    let secteurId = null;
    if (equipementId != null) {
      if (!Number.isInteger(equipementId)) throw new HttpError(400, 'Équipement invalide');
      const e = db.get('equipements', equipementId);
      if (!e || !equipementVisible(req, e)) throw new HttpError(400, 'Équipement introuvable ou hors de votre portée');
      if (e.actif === false && (!existant || Number(existant.equipementId) !== equipementId)) throw new HttpError(400, `L'équipement ${e.numero || ''} ${e.nom} est réformé ou inactif`);
      secteurId = e.secteurId == null ? null : Number(e.secteurId);
    } else {
      const brut = b.secteurId === undefined ? (existant ? existant.secteurId : null) : b.secteurId;
      secteurId = brut == null || brut === '' ? null : Number(brut);
      if (secteurId != null && (!Number.isInteger(secteurId) || !db.get('secteurs', secteurId))) throw new HttpError(400, 'Secteur invalide');
    }
    out.equipementId = equipementId == null ? null : equipementId;
    out.secteurId = secteurId;
    verifierPorteeEcriture(req, secteurId);

    out.prioriteCode = codeValide('priorites', b.prioriteCode, existant ? existant.prioriteCode : undefined, 'normale', 'Priorité');
    out.typeCode = codeValide('typesIntervention', b.typeCode, existant ? existant.typeCode : undefined, 'correctif', 'Type d\'intervention');
    out.arretProduction = b.arretProduction === undefined ? (existant ? !!existant.arretProduction : false) : !!b.arretProduction;

    // Demandeur : l'utilisateur courant, sauf si l'auteur a le droit « modifier » (encadrant) et en désigne un autre
    const peutDesigner = perms.can(req.perms, ENTITE, 'modifier');
    if (b.demandeurId !== undefined && b.demandeurId !== null && b.demandeurId !== '') {
      const u = db.get('users', Number(b.demandeurId));
      if (!u) throw new HttpError(400, 'Demandeur invalide');
      const inchange = existant && Number(existant.demandeurId) === u.id;
      if (u.id !== req.user.id && !inchange) {
        if (!peutDesigner) throw new HttpError(403, existant ? 'Vous ne pouvez pas changer le demandeur de cette demande' : 'Vous ne pouvez pas créer une demande au nom d\'un autre utilisateur');
        verifierDemandeurDesigne(req, u, existant);
      }
      out.demandeurId = u.id;
    } else if (!existant) out.demandeurId = req.user.id;

    if (b.dateDemande !== undefined && b.dateDemande !== null && b.dateDemande !== '' && peutDesigner) {
      const dt = new Date(b.dateDemande);
      if (Number.isNaN(dt.getTime())) throw new HttpError(400, 'Date de demande invalide');
      if (dt.getTime() > Date.now() + 5 * 60000) throw new HttpError(400, 'La date de la demande ne peut pas être dans le futur');
      out.dateDemande = dt.toISOString();
    } else if (!existant) out.dateDemande = new Date().toISOString();

    if (b.champs !== undefined || !existant) out.champs = ctx.champsPerso(ENTITE, b.champs || (existant && existant.champs) || {});
    return out;
  }
  /**
   * Désignation d'un autre demandeur : compte actif, dans le périmètre de l'auteur (secteurs modifiables, site courant ;
   * un subordonné direct l'est toujours) et, quand la validation est réservée au supérieur hiérarchique, le demandeur
   * d'une demande soumise n'est changé que par son N+1 ou un administrateur : la réattribuer à son propre subordonné
   * ne permet pas de devenir son valideur.
   */
  function verifierDemandeurDesigne(req, u, existant) {
    const p = req.perms || {};
    if (u.actif === false) throw new HttpError(400, `Le compte de ${ctx.nomUser(u.id)} est désactivé : il ne peut pas être désigné comme demandeur`);
    const subordonne = u.managerId != null && Number(u.managerId) === req.user.id;
    if (!p.estAdmin && p.portee !== 'tous' && !subordonne && !ctx.utilisateurVisible(req.user, p, u, true)) throw new HttpError(403, `${ctx.nomUser(u.id)} n'est pas dans votre périmètre : vous ne pouvez pas le désigner comme demandeur`);
    if (!existant || existant.statut !== st().soumise || p.estAdmin) return;
    const wf = ctx.config().workflow || {};
    if (!wf.validerParSuperieurUniquement) return;
    const dem = demandeurDe(existant);
    if (!(dem && dem.managerId != null && Number(dem.managerId) === req.user.id)) throw new HttpError(403, 'La validation est réservée au supérieur hiérarchique : seul le supérieur du demandeur actuel (ou un administrateur) peut changer le demandeur d\'une demande soumise');
  }
  function validerPieceJointe(b, req) {
    if (!b || typeof b !== 'object') throw new HttpError(400, 'Pièce jointe invalide');
    const nomDoc = String(b.nom || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
    if (!nomDoc) throw new HttpError(400, 'Le nom de la pièce jointe est obligatoire');
    const contenu = typeof b.contenu === 'string' ? b.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu de la pièce jointe invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'La pièce jointe est vide');
    if (taille > TAILLE_MAX_PJ) throw new HttpError(400, `Pièce jointe trop volumineuse (${(taille / 1024 / 1024).toFixed(1)} Mo, maximum 5 Mo)`);
    const type = String(b.type || m[1] || 'application/octet-stream').slice(0, 100);
    return { nom: nomDoc, type, taille, contenu: `data:${m[1] || type};base64,${base64}`, date: new Date().toISOString(), userId: req.user.id, description: String(b.description || '').trim().slice(0, 500) };
  }
  function texteCommentaire(b, cle, obligatoire, label) {
    const t = String((b && typeof b === 'object' && b[cle]) || '').trim();
    if (obligatoire && !t) throw new HttpError(400, `${label} est obligatoire`);
    if (t.length > MAX_COMMENTAIRE) throw new HttpError(400, `${label} est trop long (${MAX_COMMENTAIRE} caractères maximum)`);
    return t;
  }

  // ----- Cœur du workflow -----------------------------------------------------
  function notifierDemandeur(req, d, titre, message) {
    if (d.demandeurId == null) return;
    if (req && req.user && Number(d.demandeurId) === req.user.id) return;
    ctx.notify([d.demandeurId], { titre, message, lien: `#/demandes/${d.id}`, type: 'info' });
  }
  function notifierValideurs(req, d, titre) {
    const wf = ctx.config().workflow || {};
    if (wf.notifierValidateurs === false) return [];
    const ids = valideursAttendus(d).map((u) => u.id).filter((id) => !req || !req.user || id !== req.user.id);
    if (!ids.length) return ids;
    const urg = ctx.liste('priorites').slice(-1)[0];
    ctx.notify(ids, {
      titre: titre || `Demande à valider : ${d.numero}`,
      message: `${ctx.nomUser(d.demandeurId)} — ${d.titre}${d.arretProduction ? ' (arrêt de production)' : ''}`,
      lien: `#/demandes/${d.id}`, type: urg && d.prioriteCode === urg.code ? 'alerte' : 'info',
    });
    return ids;
  }
  /** Validation (manuelle ou automatique) : passe en « validee » puis en « convertie » si un OT est créé. */
  function validerDemande(req, d, opts = {}) {
    const wf = ctx.config().workflow || {};
    const now = new Date().toISOString();
    let ot = null; let avertissement = null;
    const patch = { validateurId: opts.auto ? null : req.user.id, dateValidation: now, motifRefus: '', statut: st().validee };
    const hist = (d.historique || []).concat([opts.auto ? entree(null, 'validation', st().validee, 'Validation automatique (circuit de validation désactivé)') : entree(req, 'validation', st().validee, opts.commentaire || '')]);
    if (wf.otAutoDepuisDemande !== false) {
      const sOt = ctx.services.ot;
      if (sOt && typeof sOt.creerDepuisDemande === 'function') {
        try {
          ot = sOt.creerDepuisDemande(Object.assign({}, d, patch), req);
          if (ot && ot.id != null) { patch.statut = st().convertie; patch.otId = ot.id; hist.push(Object.assign(entree(opts.auto ? null : req, 'conversion', st().convertie, `Ordre de travail ${ot.numero || ot.id} créé automatiquement`), { otId: ot.id })); }
          else avertissement = 'La création automatique de l\'ordre de travail n\'a rien retourné : la demande est validée sans OT';
        } catch (e) {
          ot = null;
          avertissement = `Ordre de travail non créé (${e.message}) : la demande est validée, convertissez-la manuellement`;
          ctx.log('Demandes : échec de la création automatique d\'OT', e.message);
        }
      } else avertissement = 'Module Ordres de travail indisponible : la demande est validée sans création d\'OT';
    }
    patch.historique = hist;
    const maj = db.update(ENTITE, d.id, patch);
    ctx.audit(req, 'validation', ENTITE, d.id, `Demande ${d.numero} validée${opts.auto ? ' automatiquement' : ''}${ot ? ` → OT ${ot.numero || ot.id}` : ''}${opts.commentaire ? ' : ' + opts.commentaire : ''}`);
    notifierDemandeur(req, maj, `Demande ${maj.numero} validée`, ot ? `Votre demande « ${maj.titre} » a été validée : ordre de travail ${ot.numero || ot.id} créé` : `Votre demande « ${maj.titre} » a été validée`);
    ctx.emit('demande:validee', maj);
    if (ot) ctx.emit('demande:convertie', maj);
    return { demande: maj, ot, avertissement };
  }

  // ----- Filtres de liste -----------------------------------------------------
  function filtrer(req) {
    const q = req.query || {};
    let rows = scope(req, db.list(ENTITE));
    const wf = ctx.config().workflow || {};
    if (q.statut) { const codes = String(q.statut).split(',').map((s) => s.trim()).filter(Boolean); rows = rows.filter((d) => codes.includes(d.statut)); }
    if (q.ouvertes === '1' || q.ouvertes === 'true') { const f = codesFinaux(); rows = rows.filter((d) => !f.has(d.statut)); }
    if (q.cloturees === '1' || q.cloturees === 'true') { const f = codesFinaux(); rows = rows.filter((d) => f.has(d.statut)); }
    if (q.prioriteCode) rows = rows.filter((d) => d.prioriteCode === q.prioriteCode);
    if (q.typeCode) rows = rows.filter((d) => d.typeCode === q.typeCode);
    if (q.secteurId) { const ids = perms.secteursDescendants(db, [Number(q.secteurId)]); rows = rows.filter((d) => d.secteurId != null && ids.includes(Number(d.secteurId))); }
    if (q.equipementId) rows = rows.filter((d) => Number(d.equipementId) === Number(q.equipementId));
    if (q.demandeurId) rows = rows.filter((d) => Number(d.demandeurId) === Number(q.demandeurId));
    if (q.otId) rows = rows.filter((d) => Number(d.otId) === Number(q.otId));
    if (q.arretProduction === '1' || q.arretProduction === 'true') rows = rows.filter((d) => !!d.arretProduction);
    if (q.du) rows = rows.filter((d) => jourLocal(d.dateDemande || d.createdAt) >= String(q.du).slice(0, 10));
    if (q.au) rows = rows.filter((d) => jourLocal(d.dateDemande || d.createdAt) <= String(q.au).slice(0, 10));
    if (q.aValider === '1' || q.aValider === 'true') rows = rows.filter((d) => d.statut === st().soumise && peutValider(req, d, wf));
    if (q.mesDemandes === '1' || q.mesDemandes === 'true') rows = rows.filter((d) => Number(d.demandeurId) === req.user.id || Number(d.createdBy) === req.user.id);
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase();
      rows = rows.filter((d) => {
        const e = d.equipementId != null ? db.get('equipements', d.equipementId) : null;
        return [d.numero, d.titre, d.description, d.motifRefus, e && e.nom, e && e.numero, ctx.nomUser(d.demandeurId)].some((v) => String(v || '').toLowerCase().includes(s));
      });
    }
    return rows.sort((a, b) => String(b.dateDemande || b.createdAt || '').localeCompare(String(a.dateDemande || a.createdAt || '')));
  }

  // ----- Routes : lecture -----------------------------------------------------
  router.get('/api/demandes', async (req) => {
    const cache = {};
    return filtrer(req).map((d) => resume(req, d, cache));
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/demandes-compteurs', async (req) => {
    const rows = scope(req, db.list(ENTITE));
    const finaux = codesFinaux();
    const wf = ctx.config().workflow || {};
    const priorites = ctx.liste('priorites');
    const now = new Date().toISOString();
    const parStatut = {};
    for (const s of listeStatuts()) parStatut[s.code] = 0;
    for (const d of rows) parStatut[d.statut] = (parStatut[d.statut] || 0) + 1;
    const estMienne = (d) => Number(d.demandeurId) === req.user.id || Number(d.createdBy) === req.user.id;
    return {
      aValider: rows.filter((d) => d.statut === st().soumise && peutValider(req, d, wf)).length,
      mesOuvertes: rows.filter((d) => !finaux.has(d.statut) && estMienne(d)).length,
      mesDemandes: rows.filter(estMienne).length,
      ouvertes: rows.filter((d) => !finaux.has(d.statut)).length,
      cloturees: rows.filter((d) => finaux.has(d.statut)).length,
      enRetard: rows.filter((d) => { if (finaux.has(d.statut)) return false; const e = echeanceDe(d, priorites); return !!e && e < now; }).length,
      arretProduction: rows.filter((d) => !finaux.has(d.statut) && d.arretProduction).length,
      total: rows.length,
      parStatut,
      statuts: Object.assign({}, st()),
      finaux: Array.from(finaux),
    };
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/demandes-export', async (req, res) => {
    const rows = filtrer(req);
    const cache = {};
    const cols = [
      ['Numéro', (d) => d.numero], ['Titre', (d) => d.titre], ['Statut', (d) => libelleStatut(d.statut)],
      ['Priorité', (d) => { const p = ctx.liste('priorites').find((x) => x.code === d.prioriteCode); return p ? p.label : d.prioriteCode; }],
      ['Type', (d) => { const t = ctx.liste('typesIntervention').find((x) => x.code === d.typeCode); return t ? t.label : d.typeCode; }],
      ['Équipement', (d) => { const e = equipementDe(d.equipementId, cache); return e ? `${e.numero || ''} ${e.nom}`.trim() : ''; }],
      ['Secteur', (d) => cheminSecteur(d.secteurId)], ['Demandeur', (d) => ctx.nomUser(d.demandeurId)],
      ['Date de la demande', (d) => d.dateDemande || d.createdAt || ''], ['Arrêt de production', (d) => (d.arretProduction ? 'Oui' : 'Non')],
      ['Validateur', (d) => ctx.nomUser(d.validateurId)], ['Date de validation', (d) => d.dateValidation || ''], ['Motif de refus', (d) => d.motifRefus || ''],
      ['OT lié', (d) => { const ot = otLie(d, { cache }); return ot ? ot.numero : ''; }], ['Date de clôture', (d) => d.dateCloture || ''],
      ['Description', (d) => d.description || ''],
    ];
    for (const cp of ((ctx.config().champsPersonnalises || {})[ENTITE] || [])) cols.push([cp.label, (d) => ((d.champs || {})[cp.cle] == null ? '' : (d.champs || {})[cp.cle])]);
    const lignes = [cols.map((c) => csvEscape(c[0])).join(';')].concat(rows.map((d) => cols.map((c) => csvEscape(c[1](d))).join(';')));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="demandes-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end('\ufeff' + lignes.join('\r\n'));
    ctx.audit(req, 'export', ENTITE, null, `${rows.length} demande(s) exportée(s) en CSV`);
  }, { perm: [ENTITE, 'exporter'] });

  router.get('/api/demandes/:id', async (req) => detail(req, getVisible(req, req.params.id)), { perm: [ENTITE, 'voir'] });

  // ----- Routes : création / modification / suppression ---------------------
  router.post('/api/demandes', async (req) => {
    const data = valider(req, req.body, null);
    const cfg = ctx.config();
    const wf = cfg.workflow || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const brutes = Array.isArray(body.pieceJointes) ? body.pieceJointes : (body.pieceJointe && typeof body.pieceJointe === 'object' ? [body.pieceJointe] : []);
    if (brutes.length > MAX_PJ) throw new HttpError(400, `Nombre maximal de pièces jointes dépassé (${MAX_PJ})`);
    const pieceJointes = brutes.filter((p) => p && typeof p === 'object' && p.contenu).map((p) => validerPieceJointe(p, req));
    const d = db.insert(ENTITE, Object.assign(data, {
      numero: numeroUnique(cfg), statut: st().soumise, validateurId: null, dateValidation: null, motifRefus: '', otId: null, dateCloture: null,
      commentaires: [], pieceJointes, historique: [entree(req, 'creation', st().soumise, data.demandeurId !== req.user.id ? `Saisie par ${ctx.nomUser(req.user.id)} pour ${ctx.nomUser(data.demandeurId)}` : '')],
      createdBy: req.user.id,
    }));
    ctx.audit(req, 'creation', ENTITE, d.id, `Demande ${d.numero} : ${d.titre}${d.arretProduction ? ' (arrêt de production)' : ''}`);
    notifierDemandeur(req, d, `Demande ${d.numero} saisie en votre nom`, `${ctx.nomUser(req.user.id)} a saisi la demande « ${d.titre} » en votre nom`);
    ctx.emit('demande:soumise', d);
    let resultat = d; let ot = null; let avertissement = null;
    if (wf.validationDemandes === false) {
      ({ demande: resultat, ot, avertissement } = validerDemande(req, d, { auto: true }));
    } else {
      notifierValideurs(req, d);
    }
    return Object.assign(detail(req, resultat), { avertissement, otCree: resumeOt(ot) });
  }, { perm: [ENTITE, 'creer'] });

  router.put('/api/demandes/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    if (estFinal(existant)) throw new HttpError(400, `Une demande au statut « ${libelleStatut(existant.statut)} » ne peut plus être modifiée : réouvrez-la d'abord`);
    if (!actionsPossibles(req, existant).modifier) throw new HttpError(403, existant.statut === st().soumise ? 'Vous ne pouvez modifier que vos propres demandes tant qu\'elles sont soumises' : 'Droit insuffisant : seule une demande soumise peut être modifiée par son demandeur');
    const data = valider(req, req.body, existant);
    const norm = (v) => (v == null ? null : Number(v));
    if (existant.statut !== st().soumise && norm(data.equipementId) !== norm(existant.equipementId)) throw new HttpError(400, 'L\'équipement ne peut plus être modifié après validation de la demande (l\'ordre de travail l\'a repris)');
    const modifies = Object.keys(data).filter((k) => JSON.stringify(data[k] === undefined ? null : data[k]) !== JSON.stringify(existant[k] === undefined ? null : existant[k])).map((k) => LIBELLES_CHAMPS[k] || k);
    const hist = (existant.historique || []).concat(modifies.length ? [entree(req, 'modification', existant.statut, 'Champs modifiés : ' + modifies.join(', '))] : []);
    const d = db.update(ENTITE, existant.id, Object.assign(data, { historique: hist }));
    ctx.audit(req, 'modification', ENTITE, d.id, `Demande ${d.numero}${modifies.length ? ' : ' + modifies.join(', ') : ''}`);
    if (modifies.length) notifierDemandeur(req, d, `Demande ${d.numero} modifiée`, `${ctx.nomUser(req.user.id)} a modifié votre demande « ${d.titre} » (${modifies.join(', ')})`);
    return detail(req, d);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/demandes/:id', async (req) => {
    const existant = getVisible(req, req.params.id);
    const ot = otLie(existant, { inclureAnnules: true });
    if (ot) throw new HttpError(400, `Impossible de supprimer la demande ${existant.numero} : elle est liée à l'ordre de travail ${ot.numero || ot.id}`);
    db.remove(ENTITE, existant.id);
    ctx.audit(req, 'suppression', ENTITE, existant.id, `Demande ${existant.numero} : ${existant.titre}`);
    if (existant.demandeurId != null && Number(existant.demandeurId) !== req.user.id) ctx.notify([existant.demandeurId], { titre: `Demande ${existant.numero} supprimée`, message: `${ctx.nomUser(req.user.id)} a supprimé votre demande « ${existant.titre} »`, lien: '#/demandes', type: 'alerte' });
    return { ok: true };
  }, { perm: [ENTITE, 'supprimer'] });

  // ----- Routes : workflow ----------------------------------------------------
  function verifierSoumise(d, verbe) {
    if (d.statut !== st().soumise) throw new HttpError(400, `Seule une demande au statut « ${libelleStatut(st().soumise)} » peut être ${verbe} (statut actuel : ${libelleStatut(d.statut)})`);
  }
  function verifierValideur(req, d) {
    if (peutValider(req, d)) return;
    const wf = ctx.config().workflow || {};
    throw new HttpError(403, wf.validerParSuperieurUniquement ? 'Seul le supérieur hiérarchique du demandeur (ou un administrateur) peut valider cette demande' : 'Vous ne pouvez pas valider cette demande (hors de votre portée)');
  }

  router.post('/api/demandes/:id/valider', async (req) => {
    const d = getVisible(req, req.params.id);
    verifierSoumise(d, 'validée');
    verifierValideur(req, d);
    const commentaire = texteCommentaire(req.body, 'commentaire', false, 'Le commentaire');
    const r = validerDemande(req, d, { commentaire });
    return Object.assign(detail(req, r.demande), { avertissement: r.avertissement, otCree: resumeOt(r.ot) });
  }, { perm: [ENTITE, 'valider'] });

  router.post('/api/demandes/:id/refuser', async (req) => {
    const d = getVisible(req, req.params.id);
    verifierSoumise(d, 'refusée');
    verifierValideur(req, d);
    const motif = texteCommentaire(req.body, 'motif', true, 'Le motif du refus');
    const now = new Date().toISOString();
    const maj = db.update(ENTITE, d.id, { statut: st().refusee, validateurId: req.user.id, dateValidation: now, motifRefus: motif, historique: (d.historique || []).concat([entree(req, 'refus', st().refusee, motif)]) });
    ctx.audit(req, 'refus', ENTITE, d.id, `Demande ${d.numero} refusée : ${motif}`);
    notifierDemandeur(req, maj, `Demande ${maj.numero} refusée`, `Votre demande « ${maj.titre} » a été refusée : ${motif}`);
    ctx.emit('demande:refusee', maj);
    return detail(req, maj);
  }, { perm: [ENTITE, 'valider'] });

  router.post('/api/demandes/:id/convertir', async (req) => {
    const d = getVisible(req, req.params.id);
    if (d.statut !== st().validee) throw new HttpError(400, `Seule une demande au statut « ${libelleStatut(st().validee)} » peut être convertie en ordre de travail (statut actuel : ${libelleStatut(d.statut)})`);
    const existantOt = otLie(d);
    if (existantOt) throw new HttpError(400, `La demande ${d.numero} est déjà liée à l'ordre de travail ${existantOt.numero || existantOt.id}`);
    const sOt = ctx.services.ot;
    if (!sOt || typeof sOt.creerDepuisDemande !== 'function') throw new HttpError(503, 'Module Ordres de travail indisponible');
    const ot = sOt.creerDepuisDemande(d, req);
    if (!ot || ot.id == null) throw new HttpError(500, 'La création de l\'ordre de travail a échoué');
    const commentaire = texteCommentaire(req.body, 'commentaire', false, 'Le commentaire');
    const courant = db.get(ENTITE, d.id) || d; // l'événement ot:cree a pu déjà mettre à jour la demande
    const maj = db.update(ENTITE, d.id, { statut: st().convertie, otId: ot.id, historique: (courant.historique || d.historique || []).filter((h) => !(h.action === 'conversion' && h.otId === ot.id)).concat([Object.assign(entree(req, 'conversion', st().convertie, `Ordre de travail ${ot.numero || ot.id} créé${commentaire ? ' : ' + commentaire : ''}`), { otId: ot.id })]) });
    ctx.audit(req, 'conversion', ENTITE, d.id, `Demande ${d.numero} convertie en OT ${ot.numero || ot.id}`);
    notifierDemandeur(req, maj, `Demande ${maj.numero} prise en charge`, `Un ordre de travail ${ot.numero || ot.id} a été créé pour votre demande « ${maj.titre} »`);
    ctx.emit('demande:convertie', maj);
    return Object.assign(detail(req, maj), { otCree: resumeOt(ot) });
  }, { perm: ['ot', 'creer'] });

  router.post('/api/demandes/:id/cloturer', async (req) => {
    const d = getVisible(req, req.params.id);
    if (estFinal(d)) throw new HttpError(400, `La demande ${d.numero} est déjà au statut « ${libelleStatut(d.statut)} »`);
    if (!actionsPossibles(req, d).cloturer) throw new HttpError(403, 'Vous ne pouvez pas clôturer cette demande');
    const commentaire = texteCommentaire(req.body, 'commentaire', false, 'Le commentaire');
    const now = new Date().toISOString();
    const maj = db.update(ENTITE, d.id, { statut: st().cloturee, dateCloture: now, historique: (d.historique || []).concat([entree(req, 'cloture', st().cloturee, commentaire)]) });
    ctx.audit(req, 'cloture', ENTITE, d.id, `Demande ${d.numero} clôturée${commentaire ? ' : ' + commentaire : ''}`);
    notifierDemandeur(req, maj, `Demande ${maj.numero} clôturée`, `Votre demande « ${maj.titre} » a été clôturée par ${ctx.nomUser(req.user.id)}${commentaire ? ' : ' + commentaire : ''}`);
    ctx.emit('demande:cloturee', maj);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  router.post('/api/demandes/:id/reouvrir', async (req) => {
    const d = getVisible(req, req.params.id);
    if (!estFinal(d)) throw new HttpError(400, 'Seule une demande refusée ou clôturée peut être réouverte');
    if (!actionsPossibles(req, d).reouvrir) throw new HttpError(403, 'Droit insuffisant pour réouvrir une demande (un demandeur ne peut pas réouvrir lui-même sa demande : créez-en une nouvelle)');
    const commentaire = texteCommentaire(req.body, 'commentaire', false, 'Le commentaire');
    const patch = { dateCloture: null };
    if (d.statut === st().refusee) { patch.statut = st().soumise; patch.validateurId = null; patch.dateValidation = null; patch.motifRefus = ''; }
    else {
      // Un OT terminé ne peut pas « redevenir » l'intervention en cours : il est réouvert d'abord (la demande suit alors
      // le circuit normal), sinon une nouvelle demande est créée. Un OT annulé n'est plus rattaché.
      const ot = otLie(d);
      if (ot && otFinal(ot) && !otAnnule(ot)) throw new HttpError(400, `L'ordre de travail ${ot.numero || ot.id} lié à cette demande est terminé : réouvrez d'abord l'ordre de travail, puis la demande ; sinon créez une nouvelle demande`);
      if (ot && !otAnnule(ot)) patch.statut = st().convertie;
      else { patch.statut = d.dateValidation ? st().validee : st().soumise; patch.otId = null; }
    }
    patch.historique = (d.historique || []).concat([entree(req, 'reouverture', patch.statut, commentaire)]);
    const maj = db.update(ENTITE, d.id, patch);
    ctx.audit(req, 'reouverture', ENTITE, d.id, `Demande ${d.numero} réouverte (${libelleStatut(maj.statut)})${commentaire ? ' : ' + commentaire : ''}`);
    notifierDemandeur(req, maj, `Demande ${maj.numero} réouverte`, `Votre demande « ${maj.titre} » a été réouverte par ${ctx.nomUser(req.user.id)}${commentaire ? ' : ' + commentaire : ''}`);
    if (maj.statut === st().soumise) notifierValideurs(req, maj, `Demande réouverte à valider : ${maj.numero}`);
    ctx.emit('demande:reouverte', maj);
    return detail(req, maj);
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : commentaires ------------------------------------------------
  router.post('/api/demandes/:id/commentaires', async (req) => {
    const d = getVisible(req, req.params.id);
    const texte = texteCommentaire(req.body, 'texte', true, 'Le commentaire');
    const c = { userId: req.user.id, date: new Date().toISOString(), texte };
    const maj = db.update(ENTITE, d.id, { commentaires: (d.commentaires || []).concat([c]) });
    ctx.audit(req, 'commentaire', ENTITE, d.id, `Commentaire sur ${d.numero} : ${texte.slice(0, 120)}`);
    const destinataires = [d.demandeurId, d.validateurId].concat((d.commentaires || []).map((x) => x.userId)).filter((id) => id != null && Number(id) !== req.user.id);
    ctx.notify(destinataires, { titre: `Nouveau commentaire sur ${d.numero}`, message: `${ctx.nomUser(req.user.id)} : ${texte.slice(0, 160)}`, lien: `#/demandes/${d.id}`, type: 'info' });
    return { ok: true, commentaire: enrichCommentaire(c), commentaires: maj.commentaires.map(enrichCommentaire) };
  }, { perm: [ENTITE, 'voir'] });

  // ----- Routes : pièces jointes ---------------------------------------------
  function indexPj(req, d) {
    const idx = Number(req.params.index);
    const docs = d.pieceJointes || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= docs.length) throw new HttpError(404, 'Pièce jointe introuvable');
    return idx;
  }
  router.post('/api/demandes/:id/documents', async (req) => {
    const d = getVisible(req, req.params.id);
    if (!actionsPossibles(req, d).joindre) throw new HttpError(403, 'Vous ne pouvez pas ajouter de pièce jointe à cette demande');
    const docs = d.pieceJointes || [];
    if (docs.length >= MAX_PJ) throw new HttpError(400, `Nombre maximal de pièces jointes atteint (${MAX_PJ})`);
    const doc = validerPieceJointe(req.body, req);
    const maj = db.update(ENTITE, d.id, { pieceJointes: docs.concat([doc]) });
    ctx.audit(req, 'document', ENTITE, d.id, `Pièce jointe ajoutée à ${d.numero} : ${doc.nom} (${Math.round(doc.taille / 1024)} Ko)`);
    const actions = actionsPossibles(req, maj);
    return { ok: true, document: resumeDoc(doc, maj.pieceJointes.length - 1, req, actions), pieceJointes: maj.pieceJointes.map((p, i) => resumeDoc(p, i, req, actions)) };
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/demandes/:id/documents/:index', async (req, res) => {
    const d = getVisible(req, req.params.id);
    const doc = d.pieceJointes[indexPj(req, d)];
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Pièce jointe corrompue');
    const buf = Buffer.from(m[2], 'base64');
    const type = String(doc.type || m[1] || 'application/octet-stream').toLowerCase();
    const dangereux = /html|javascript|xml$|xhtml/.test(type) && !/svg/.test(type);
    const inline = (/^image\//.test(type) || type === 'application/pdf' || /^text\/plain/.test(type)) && req.query.telecharger !== '1' && !dangereux;
    const nomFichier = encodeURIComponent(doc.nom || 'piece-jointe').replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': dangereux ? 'application/octet-stream' : type, 'Content-Length': buf.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${nomFichier}`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:", 'Cache-Control': 'private, max-age=300',
    });
    res.end(buf);
  }, { perm: [ENTITE, 'voir'] });

  router.delete('/api/demandes/:id/documents/:index', async (req) => {
    const d = getVisible(req, req.params.id);
    const actions = actionsPossibles(req, d);
    if (!actions.joindre) throw new HttpError(403, 'Vous ne pouvez pas supprimer de pièce jointe sur cette demande');
    const idx = indexPj(req, d);
    const docs = d.pieceJointes.slice();
    const sup = docs[idx];
    if (!peutSupprimerPj(req, sup, actions)) throw new HttpError(403, 'Vous ne pouvez supprimer que les pièces jointes que vous avez ajoutées');
    docs.splice(idx, 1);
    const auteur = sup.userId != null && Number(sup.userId) !== req.user.id ? ` (ajoutée par ${ctx.nomUser(sup.userId)})` : '';
    const maj = db.update(ENTITE, d.id, { pieceJointes: docs, historique: (d.historique || []).concat([entree(req, 'pj_supprimee', null, `${sup.nom}${auteur}`)]) });
    ctx.audit(req, 'document', ENTITE, d.id, `Pièce jointe supprimée de ${d.numero} : ${sup.nom}${auteur}`);
    return { ok: true, pieceJointes: maj.pieceJointes.map((p, i) => resumeDoc(p, i, req, actions)) };
  }, { perm: [ENTITE, 'voir'] });

  // ----- Événements inter-modules -------------------------------------------
  const otDe = (data) => (data && data.ot && typeof data.ot === 'object' ? data.ot : data);

  /** OT terminé → clôture de la demande liée (si l'option de workflow est active). */
  ctx.on('ot:termine', (data) => {
    const ot = otDe(data);
    if (!ot || ot.id == null) return;
    const wf = ctx.config().workflow || {};
    if (wf.cloturerDemandeAvecOt === false) return;
    const d = demandeLieeA(ot);
    if (!d || estFinal(d)) return;
    const now = new Date().toISOString();
    const maj = db.update(ENTITE, d.id, { statut: st().cloturee, dateCloture: now, otId: d.otId == null ? ot.id : d.otId, historique: (d.historique || []).concat([Object.assign(entree(null, 'cloture', st().cloturee, `Clôture automatique : ordre de travail ${ot.numero || ot.id} terminé`), { otId: ot.id, auto: true })]) });
    ctx.audit(null, 'cloture', ENTITE, d.id, `Demande ${d.numero} clôturée automatiquement (OT ${ot.numero || ot.id} terminé)`);
    if (maj.demandeurId != null) ctx.notify([maj.demandeurId], { titre: `Demande ${maj.numero} clôturée`, message: `L'intervention ${ot.numero || ot.id} est terminée${ot.rapport ? ' — ' + String(ot.rapport).slice(0, 200) : ''}`, lien: `#/demandes/${maj.id}`, type: 'info' });
    ctx.emit('demande:cloturee', maj);
  });

  /** Rattache un OT (créé ou réouvert) à la demande : lien `otId`, statut « convertie » si elle était soumise ou validée. */
  function rattacherOt(d, ot, action, commentaire, userId) {
    const patch = {};
    if (d.otId == null || Number(d.otId) !== Number(ot.id)) patch.otId = ot.id;
    if (d.statut === st().soumise || d.statut === st().validee) {
      patch.statut = st().convertie;
      if (!d.dateValidation) { patch.dateValidation = new Date().toISOString(); patch.validateurId = userId == null ? null : userId; }
      patch.historique = (d.historique || []).concat([Object.assign(entree(null, action, st().convertie, commentaire), { otId: ot.id, userId: userId == null ? null : userId })]);
    }
    return Object.keys(patch).length ? db.update(ENTITE, d.id, patch) : null;
  }
  /** La demande a-t-elle été clôturée automatiquement par la clôture de cet OT (et non à la main) ? */
  function clotureeParOt(d, ot) {
    const h = (d.historique || []).slice().reverse().find((x) => x.action === 'cloture');
    if (!h || h.userId != null) return false;
    return h.otId == null ? /automatique/i.test(h.commentaire || '') : Number(h.otId) === Number(ot.id);
  }
  /** Statut d'OT final (liste `statutsOT`) ? */
  const codeOtFinal = (code) => { const s = ctx.liste('statutsOT').find((x) => x.code === code); return !!(s && s.final); };

  /** OT créé depuis une demande (par le module OT lui-même) → synchronisation du lien et du statut. */
  ctx.on('ot:cree', (data) => {
    const ot = otDe(data);
    if (!ot || ot.id == null || ot.demandeId == null) return;
    const d = db.get(ENTITE, ot.demandeId);
    if (!d || (d.otId != null && Number(d.otId) !== Number(ot.id))) return;
    rattacherOt(d, ot, 'conversion', `Ordre de travail ${ot.numero || ot.id} créé depuis la demande`, ot.createdBy);
  });

  /**
   * OT annulé → la demande convertie redevient validée (pour être reconvertie ou clôturée) ; une demande clôturée
   * automatiquement par cet OT (OT terminé puis réouvert et annulé) redevient validée elle aussi ; une clôture
   * manuelle (problème disparu) est conservée.
   */
  ctx.on('ot:annule', (data) => {
    const ot = otDe(data);
    const d = demandeLieeA(ot);
    if (!d || (d.otId != null && Number(d.otId) !== Number(ot.id))) return;
    const convertie = d.statut === st().convertie;
    if (!convertie && !(d.statut === st().cloturee && clotureeParOt(d, ot))) return;
    const commentaire = convertie ? `Ordre de travail ${ot.numero || ot.id} annulé : la demande redevient validée` : `Ordre de travail ${ot.numero || ot.id} annulé après la clôture automatique : la demande redevient validée`;
    const maj = db.update(ENTITE, d.id, { statut: st().validee, otId: null, dateCloture: null, historique: (d.historique || []).concat([entree(null, 'ot_annule', st().validee, commentaire)]) });
    ctx.audit(null, 'statut', ENTITE, d.id, `Demande ${d.numero} : OT ${ot.numero || ot.id} annulé, retour au statut validée`);
    if (maj.demandeurId != null) ctx.notify([maj.demandeurId], { titre: `Demande ${maj.numero} : intervention annulée`, message: `L'ordre de travail ${ot.numero || ot.id} a été annulé ; votre demande ${convertie ? 'reste' : 'redevient'} validée`, lien: `#/demandes/${maj.id}`, type: 'alerte' });
    if (!convertie) ctx.emit('demande:reouverte', maj);
  });

  /** OT réouvert (statut final → ouvert) → la demande validée (ou soumise) qu'il réalise redevient « convertie ». */
  ctx.on('ot:statut', (data) => {
    const ot = otDe(data);
    if (!ot || ot.id == null || !data || data.ancien == null || data.nouveau == null) return;
    if (!codeOtFinal(data.ancien) || codeOtFinal(data.nouveau)) return;
    const d = demandeLieeA(ot);
    if (!d || (d.otId != null && Number(d.otId) !== Number(ot.id))) return;
    if (d.statut !== st().validee && d.statut !== st().soumise) return;
    const maj = rattacherOt(d, ot, 'ot_reouvert', `Ordre de travail ${ot.numero || ot.id} réouvert : la demande est de nouveau en cours de traitement`, null);
    if (!maj) return;
    ctx.audit(null, 'statut', ENTITE, d.id, `Demande ${d.numero} : OT ${ot.numero || ot.id} réouvert, retour au statut convertie`);
    if (maj.demandeurId != null) ctx.notify([maj.demandeurId], { titre: `Demande ${maj.numero} : intervention reprise`, message: `L'ordre de travail ${ot.numero || ot.id} a été réouvert ; votre demande est de nouveau en cours de traitement`, lien: `#/demandes/${maj.id}`, type: 'info' });
    ctx.emit('demande:convertie', maj);
  });

  // ----- Reprise au démarrage ---------------------------------------------------
  /**
   * Bases antérieures : les demandes sans `otId` sont liées une fois à l'OT qui les référence (un OT clôturé n'est
   * rattaché qu'à une demande convertie ou clôturée : pour une demande validée, c'est une intervention passée).
   */
  function relierOtAuDemarrage() {
    const sans = db.list(ENTITE, (d) => d.otId == null);
    if (!sans.length) return 0;
    const cache = {};
    const parDemande = new Map();
    for (const o of db.list('ot')) {
      if (o.demandeId == null || otAnnule(o, cache)) continue;
      const k = Number(o.demandeId); const prec = parDemande.get(k);
      if (!prec || (otFinal(prec, cache) && !otFinal(o, cache))) parDemande.set(k, o);
    }
    let n = 0;
    for (const d of sans) {
      const o = parDemande.get(d.id);
      if (!o) continue;
      if (otFinal(o, cache) && d.statut !== st().convertie && d.statut !== st().cloturee) continue;
      db.update(ENTITE, d.id, { otId: o.id }); n++;
    }
    if (n) ctx.log(`Demandes : ${n} lien(s) vers un ordre de travail complété(s) au démarrage`);
    return n;
  }
  relierOtAuDemarrage();

  // ----- Services publiés -----------------------------------------------------
  ctx.services.demandes = {
    /** Demande brute (ou null). */
    get: (id) => db.get(ENTITE, id),
    /** Demande liée à un OT (par demandeId ou otId). */
    lieeA: (ot) => demandeLieeA(ot),
    /** Demandes non finales, éventuellement filtrées par équipement / secteur. */
    ouvertesPour: ({ equipementId, secteurId } = {}) => {
      const f = codesFinaux();
      return db.list(ENTITE, (d) => !f.has(d.statut) && (equipementId == null || Number(d.equipementId) === Number(equipementId)) && (secteurId == null || Number(d.secteurId) === Number(secteurId)));
    },
    /** L'utilisateur de la requête peut-il valider cette demande ? */
    peutValider: (req, d) => peutValider(req, typeof d === 'object' ? d : db.get(ENTITE, d)),
    /** Codes de statut métier utilisés par le module. */
    get STATUTS() { return Object.assign({}, st()); },
    /** Résolution des étapes du circuit pour une liste de statuts donnée. */
    resoudreStatuts,
  };
}

// ----- Données de démonstration -------------------------------------------------
function seedDemo(ctx) {
  const { db } = ctx;
  const TITRE_TEMOIN = 'Fuite d\'huile sur la presse hydraulique 250 t';
  /** Lie a posteriori les demandes « converties » aux OT créés par le module OT (seedDemo appelé dans l'ordre alphabétique). */
  const relier = () => {
    let n = 0;
    for (const d of db.list(ENTITE, (x) => x.otId == null)) {
      const ot = db.findOne('ot', (o) => Number(o.demandeId) === d.id);
      if (ot) { db.update(ENTITE, d.id, { otId: ot.id }); n++; }
    }
    return n;
  };
  if (db.findOne(ENTITE, (d) => d.titre === TITRE_TEMOIN)) { const n = relier(); return 'déjà présentes' + (n ? ` (${n} lien(s) OT complété(s))` : ''); }

  // Les seeds s'exécutent dans l'ordre alphabétique des fichiers (« demandes » passe avant « equipements »
  // et « utilisateurs ») : on déclenche d'abord, dans l'ordre de leurs propres dépendances, les seeds
  // (idempotents par contrat) dont nos données dépendent, lorsqu'ils existent. Leur second appel par le
  // chargeur ne fait alors plus rien (« déjà présents »).
  const DEPENDANCES = ['profils.js', 'secteurs.js', 'utilisateurs.js', 'fournisseurs.js', 'equipements.js'];
  for (const fichier of DEPENDANCES) {
    const m = (ctx.modules || []).find((x) => x.fichier === fichier);
    if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Demandes : seed dépendant en échec', fichier, e.message); } }
  }

  const cfg = db.getConfig();
  const gabarit = (cfg.numerotation || {}).di || 'DI-{annee}-{num:4}';
  const ST = resoudreStatuts((cfg.listes || {}).statutsDemande);
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };
  const equipement = (nomEq) => db.findOne('equipements', (e) => e.nom === nomEq);
  const secteur = (code) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : null; };
  const ilYa = (heures) => new Date(Date.now() - heures * 3600000).toISOString();
  const numeroUnique = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('di', gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; } return 'DI-' + Date.now(); };
  const etape = (heures, login, action, statut, commentaire, extra) => Object.assign({ date: ilYa(heures), userId: login ? userId(login) : null, action, libelle: LIBELLES_ETAPES[action] || action, statut, commentaire: commentaire || '' }, extra || {});
  const com = (heures, login, texte) => ({ userId: userId(login), date: ilYa(heures), texte });

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220"><rect width="360" height="220" fill="#f3f4f6"/><rect x="40" y="60" width="200" height="110" rx="8" fill="#374151"/><ellipse cx="150" cy="190" rx="90" ry="14" fill="#b45309" opacity="0.8"/><circle cx="290" cy="110" r="40" fill="#9ca3af"/><text x="180" y="40" font-family="Segoe UI, Arial" font-size="16" font-weight="600" text-anchor="middle" fill="#111827">Fuite sous le vérin principal</text></svg>';
  const photo = { nom: 'photo-fuite-presse.svg', type: 'image/svg+xml', taille: Buffer.byteLength(svg), contenu: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), date: ilYa(290), userId: userId('spetit'), description: 'Photo prise lors du constat' };
  const texteNote = 'RELEVÉ CONTRÔLE QUALITÉ — Étuve UF 110\r\nConsigne 105 °C — lecture sonde étalon 103,2 °C (écart -1,8 °C, tolérance ±1 °C).\r\nDernier étalonnage : il y a 14 mois.\r\n';
  const note = { nom: 'releve-etuve.txt', type: 'text/plain', taille: Buffer.byteLength(texteNote), contenu: 'data:text/plain;base64,' + Buffer.from(texteNote).toString('base64'), date: ilYa(2), userId: userId('mdupont'), description: 'Relevé de contrôle' };

  // Les demandes sont insérées dans l'ordre chronologique (numérotation croissante avec la date de demande)
  const aInserer = [];
  const mk = (o) => { aInserer.push(o); };
  const inserer = (o) => {
    const e = o.equipement ? equipement(o.equipement) : null;
    const secteurRepli = o.secteurCode ? secteur(o.secteurCode) : null;
    delete o.equipement; delete o.secteurCode;
    const d = db.insert(ENTITE, Object.assign({
      numero: numeroUnique(), description: '', equipementId: e ? e.id : null, secteurId: e ? (e.secteurId == null ? null : e.secteurId) : (o.secteurId == null ? secteurRepli : o.secteurId),
      prioriteCode: 'normale', typeCode: 'correctif', statut: ST.soumise, validateurId: null, dateValidation: null, motifRefus: '', otId: null, dateCloture: null,
      arretProduction: false, commentaires: [], pieceJointes: [], historique: [], champs: {}, createdBy: admin ? admin.id : null,
    }, o));
    // Horodatages cohérents avec l'historique (création à la date de la demande)
    const brut = (db.data.collections[ENTITE] || []).find((x) => x.id === d.id);
    if (brut && o.dateDemande) {
      const dates = [o.dateDemande].concat((o.historique || []).map((h) => h.date), (o.commentaires || []).map((c) => c.date)).filter(Boolean).sort();
      brut.createdAt = o.dateDemande;
      brut.updatedAt = dates[dates.length - 1];
    }
    return d;
  };

  // 1. Convertie en OT (validée par le chef de secteur) avec photo et échange
  mk({
    titre: TITRE_TEMOIN, equipement: 'Presse hydraulique 250 t', secteurCode: 'PROD', prioriteCode: 'haute', typeCode: 'correctif', statut: ST.convertie,
    description: 'Traces d\'huile au sol sous le vérin principal depuis ce matin. Le niveau du réservoir hydraulique a baissé d\'environ 2 cm en une équipe. Pas de perte de pression constatée pour l\'instant.',
    demandeurId: userId('spetit'), createdBy: userId('spetit'), dateDemande: ilYa(290), validateurId: userId('pmartin'), dateValidation: ilYa(280),
    pieceJointes: [photo],
    commentaires: [com(286, 'pmartin', 'Merci Sophie. Je passe voir la presse en fin de matinée, merci de baliser la zone.'), com(275, 'jbernard', 'Vu sur place : joint de tige du vérin à remplacer. Pièce disponible en magasin, intervention planifiée.')],
    historique: [etape(290, 'spetit', 'creation', ST.soumise), etape(280, 'pmartin', 'validation', ST.validee, 'Fuite confirmée, à traiter rapidement'), etape(280, 'pmartin', 'conversion', ST.convertie, 'Ordre de travail créé automatiquement')],
  });
  // 2. Validée, en attente de conversion manuelle
  mk({
    titre: 'Bruit anormal au démarrage du compresseur GA 37', equipement: 'Compresseur d\'air GA 37', secteurCode: 'SG', prioriteCode: 'normale', typeCode: 'correctif', statut: ST.validee,
    description: 'Sifflement aigu pendant 10 à 15 secondes à chaque démarrage après un arrêt prolongé. Disparaît ensuite. Pression réseau normale.',
    demandeurId: userId('kleroy'), createdBy: userId('kleroy'), dateDemande: ilYa(120), validateurId: userId('mdupont'), dateValidation: ilYa(96),
    commentaires: [com(100, 'mdupont', 'À vérifier lors de la prochaine visite du prestataire Atlas Copco ; contrôler la courroie et le clapet d\'aspiration.')],
    historique: [etape(120, 'kleroy', 'creation', ST.soumise), etape(96, 'mdupont', 'validation', ST.validee, 'Validée : à planifier avec le prestataire')],
  });
  // 3. Urgente avec arrêt de production, convertie
  mk({
    titre: 'Four de rétraction de la fardeleuse : résistance hors service', equipement: 'Fardeleuse', secteurCode: 'PROD', prioriteCode: 'urgente', typeCode: 'correctif', statut: ST.convertie, arretProduction: true,
    description: 'La résistance n°3 du four de rétraction est coupée (disjonction au réarmement). Les fardeaux ne sont plus conformes : cadence réduite de 20 % et rebuts. Ligne 1 à l\'arrêt depuis 14 h 10.',
    demandeurId: userId('spetit'), createdBy: userId('spetit'), dateDemande: ilYa(100), validateurId: userId('pmartin'), dateValidation: ilYa(99),
    commentaires: [com(99, 'pmartin', 'Priorité absolue : Karim est affecté à l\'intervention.')],
    historique: [etape(100, 'spetit', 'creation', ST.soumise), etape(99, 'pmartin', 'validation', ST.validee, 'Arrêt de production : intervention immédiate'), etape(99, 'pmartin', 'conversion', ST.convertie, 'Ordre de travail créé automatiquement')],
  });
  // 4. Soumise (préventif / amélioration)
  mk({
    titre: 'Remplacement trimestriel des filtres F7 de la CTA', equipement: 'CTA atelier conditionnement', secteurCode: 'SG', prioriteCode: 'basse', typeCode: 'preventif', statut: ST.soumise,
    description: 'Les filtres F7 de la centrale de traitement d\'air n\'ont pas été remplacés ce trimestre : perte de charge affichée à 280 Pa (seuil 250 Pa).',
    demandeurId: userId('kleroy'), createdBy: userId('kleroy'), dateDemande: ilYa(26),
    historique: [etape(26, 'kleroy', 'creation', ST.soumise)],
  });
  // 5. Clôturée après intervention
  mk({
    titre: 'Chariot thermique n°2 : fuite hydraulique sur le vérin d\'inclinaison', equipement: 'Chariot élévateur thermique n°2', secteurCode: 'LOG', prioriteCode: 'haute', typeCode: 'correctif', statut: ST.cloturee,
    description: 'Fuite d\'huile importante sur le vérin d\'inclinaison du mât, flaque sous le chariot au parking. Chariot immobilisé par sécurité.',
    demandeurId: userId('jbernard'), createdBy: userId('jbernard'), dateDemande: ilYa(480), validateurId: userId('mdupont'), dateValidation: ilYa(470), dateCloture: ilYa(360),
    commentaires: [com(380, 'kleroy', 'Joints du vérin remplacés, niveau refait, essai en charge OK.')],
    historique: [etape(480, 'jbernard', 'creation', ST.soumise), etape(470, 'mdupont', 'validation', ST.validee, ''), etape(470, 'mdupont', 'conversion', ST.convertie, 'Ordre de travail créé automatiquement'), etape(360, null, 'cloture', ST.cloturee, 'Clôture automatique : intervention terminée')],
  });
  // 6. Refusée avec motif (sans équipement, rattachée au secteur Production)
  mk({
    titre: 'Ajout d\'un éclairage LED au poste 4 de la ligne 2', secteurId: secteur('PROD'), prioriteCode: 'basse', typeCode: 'amelioration', statut: ST.refusee,
    description: 'Le poste de contrôle visuel n°4 manque de lumière en équipe de nuit (environ 250 lux mesurés). Demande d\'un éclairage LED complémentaire orientable.',
    demandeurId: userId('spetit'), createdBy: userId('spetit'), dateDemande: ilYa(200), validateurId: userId('pmartin'), dateValidation: ilYa(190),
    motifRefus: 'Hors périmètre maintenance : à intégrer au projet « éclairage 2027 » piloté par les services généraux. Demande à ressaisir avec le chiffrage.',
    historique: [etape(200, 'spetit', 'creation', ST.soumise), etape(190, 'pmartin', 'refus', ST.refusee, 'Hors périmètre maintenance : à intégrer au projet « éclairage 2027 » piloté par les services généraux. Demande à ressaisir avec le chiffrage.')],
  });
  // 7. Soumise récente (contrôle réglementaire) avec relevé joint
  mk({
    titre: 'Étalonnage de l\'étuve de laboratoire en retard', equipement: 'Étuve de laboratoire', secteurCode: 'QUAL', prioriteCode: 'normale', typeCode: 'reglementaire', statut: ST.soumise,
    description: 'L\'étalonnage annuel de la sonde de température est dépassé de deux mois (écart constaté de -1,8 °C). Prévoir l\'intervention de l\'organisme accrédité.',
    demandeurId: userId('mdupont'), createdBy: userId('mdupont'), dateDemande: ilYa(2), pieceJointes: [note],
    historique: [etape(2, 'mdupont', 'creation', ST.soumise)],
  });
  aInserer.sort((a, b) => String(a.dateDemande || '').localeCompare(String(b.dateDemande || ''))).forEach(inserer);
  db.touch();
  const n = relier();
  return `${aInserer.length} demandes d'intervention` + (n ? ` (${n} lien(s) OT)` : '');
}

module.exports = { nom, register, seedDemo };
