'use strict';
/**
 * Module Plans 3D des sites : implantation des bâtiments, zones (liées aux secteurs), murs,
 * allées, machines (liées aux équipements), installations (armoires électriques, réseaux,
 * racks, extincteurs, issues de secours…), portes et textes, sur un ou plusieurs niveaux,
 * avec fond de plan 2D importé (image à décalquer).
 *
 * Collection « plans » :
 *   { numero, nom, description, secteurId (site ou bâtiment), dimensions { largeur, profondeur } (m),
 *     niveaux [{ id, nom, altitude, hauteur }], fond { image, type, taille, echelle (m/px), x, y (centre, m),
 *     rotation (°), opacite, niveauId } | null, objets [...], vue { x, y, z, distance, azimut, elevation, dessus },
 *     createdBy, updatedBy, version }
 *
 * Objets (coordonnées en mètres, origine au coin nord-ouest du plan, x vers l'est, y vers le sud) :
 *   commun        : id (chaîne unique), type, niveauId, x, y, z (élévation au-dessus du niveau), rotation (°),
 *                   largeur, profondeur, hauteur, couleur, nom, verrouille
 *   zone/batiment : points [[x, y], …] (polygone, facultatif : rectangle centré sinon), secteurId (secteur lié)
 *   mur/allee     : (x, y) → (x2, y2), epaisseur ; réseaux (installation reseau_air / reseau_eau) idem
 *   machine/installation : forme ('boite' | 'cylindre'), equipementId, categorie (installation)
 *   texte         : texte
 *
 * Contrôle de concurrence optimiste : PUT avec `version` obsolète → 409.
 *
 * Portée : un plan est visible en consultation par toute personne ayant accès à au moins un secteur
 * de sa zone (ex. un chef de secteur Production voit le plan de son site) ; il n'est modifiable que
 * par un utilisateur dont la portée d'écriture couvre le secteur du plan (site / bâtiment) ; un plan
 * sans secteur (plan général) n'est créé, modifié ou supprimé qu'avec la portée « tous ».
 * Les équipements liés non visibles par l'utilisateur sont masqués (lien, désignation reprise dans le
 * nom de l'objet) et le nombre d'équipements liés ne compte que les équipements visibles.
 *
 * Services publiés : ctx.services.plans.{ localiser(equipementId, req?), get(id), objetsLies(planId) }
 * Événements émis  : 'plan:cree' ({ plan }), 'plan:modifie' ({ plan, ancien }), 'plan:supprime' ({ plan })
 * Événements écoutés : 'equipement:supprime' (retire les liens vers l'équipement supprimé)
 */
const crypto = require('crypto');

const nom = 'Plans 3D';
const ENTITE = 'plans';

const TYPES = ['zone', 'batiment', 'mur', 'machine', 'installation', 'porte', 'texte', 'allee'];
const CATEGORIES = ['armoire_electrique', 'convoyeur', 'rack', 'compresseur', 'chaudiere', 'cuve', 'reseau_air', 'reseau_eau', 'extincteur', 'issue_secours', 'poste_travail', 'bureau', 'quai', 'autre'];
const CATEGORIES_RESEAU = ['reseau_air', 'reseau_eau'];
const FORMES = ['boite', 'cylindre'];
const TYPES_LIES_EQUIPEMENT = ['machine', 'installation'];
const TYPES_LIES_SECTEUR = ['zone', 'batiment'];
const TYPES_POLYGONE = ['zone', 'batiment'];

const MAX_OBJETS = 5000;
const MAX_NIVEAUX = 20;
const MAX_POINTS = 500;
const MAX_IMAGE = 8 * 1024 * 1024; // 8 Mo (image décodée)
const MAX_CORPS = 40 * 1024 * 1024; // corps JSON (image en base64 + objets)
const BORNE = 5000; // bornes des coordonnées (m)
const DIM_MIN = 1, DIM_MAX = 2000;
const DELAI_NOTIF_MS = 60 * 60 * 1000; // au plus une notification « plan modifié » par heure et par plan

/** Valeurs par défaut par type d'objet (dimensions en mètres). */
const DEFAUTS = {
  zone: { largeur: 10, profondeur: 8, hauteur: 0.05, couleur: '#3b82f6' },
  batiment: { largeur: 40, profondeur: 30, hauteur: 8, couleur: '#cbd5e1' },
  mur: { largeur: 1, profondeur: 0.2, hauteur: 3, epaisseur: 0.2, couleur: '#94a3b8' },
  machine: { largeur: 2, profondeur: 1.5, hauteur: 1.8, couleur: '#2563eb' },
  installation: { largeur: 1, profondeur: 1, hauteur: 1, couleur: '#6b7280' },
  porte: { largeur: 1.2, profondeur: 0.3, hauteur: 2.1, couleur: '#92400e' },
  texte: { largeur: 4, profondeur: 1, hauteur: 0, couleur: '#1f2937' },
  allee: { largeur: 1, profondeur: 3, hauteur: 0.02, epaisseur: 3, couleur: '#facc15' },
};

const arrondi = (n, d = 3) => { const f = 10 ** d; return Math.round(n * f) / f; };
const estSegment = (o) => o.type === 'mur' || o.type === 'allee' || (o.type === 'installation' && CATEGORIES_RESEAU.includes(o.categorie));

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const notifiesRecemment = new Map(); // planId → horodatage de la dernière notification de modification

  // ----- Utilitaires de référence -----------------------------------------------
  const secteur = (id) => (id == null ? null : db.get('secteurs', id));
  function cheminSecteur(id) {
    const parts = []; let cur = secteur(id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? secteur(cur.parentId) : null; }
    return parts.join(' › ');
  }
  const siteDe = (secteurId) => (secteurId == null ? null : ctx.siteDuSecteur(secteurId));
  function statutsFinaux(nomListe, repli) {
    const l = ctx.liste(nomListe);
    return new Set(l.length ? l.filter((s) => s.final).map((s) => s.code) : repli);
  }

  // ----- Portée ---------------------------------------------------------------------
  /** Le secteur peut-il recevoir un plan / un lien en écriture (portée d'écriture et site courant) ? */
  function secteurEcrivable(req, sid) {
    const p = req.perms;
    if (!p) return false;
    if (sid == null) return p.portee === 'tous';
    const n = Number(sid);
    if (Array.isArray(p.siteFiltre) && !p.siteFiltre.includes(n)) return false;
    if (p.portee === 'tous') return true;
    return Array.isArray(p.secteurIds) && p.secteurIds.includes(n);
  }

  /**
   * Visibilité d'un plan en consultation : règle standard (ctx.canSee) OU l'utilisateur a accès
   * à au moins un secteur situé dans la zone couverte par le plan (le plan d'un site est consultable
   * par les personnes de ses services). Le filtre de site courant s'applique toujours.
   */
  function peutLire(req, plan) {
    if (!plan) return false;
    const lecture = Object.assign({}, req, { ecriture: false });
    if (ctx.canSee(lecture, plan)) return true;
    const p = req.perms;
    if (!p || plan.secteurId == null) return plan.secteurId == null;
    const sid = Number(plan.secteurId);
    if (Array.isArray(p.siteFiltre) && !p.siteFiltre.includes(sid)) return false;
    if (p.portee === 'tous') return false; // seul le filtre de site l'a exclu
    const accessibles = new Set([].concat(p.secteurIds || [], p.secteurIdsLecture || []).map(Number));
    if (!accessibles.size) return false;
    return perms.secteursDescendants(db, [sid]).some((id) => accessibles.has(Number(id)));
  }
  /**
   * Plan modifiable : portée d'écriture couvrant le secteur du plan (site / bâtiment), hors sites en lecture seule
   * et hors du filtre de site courant. Un plan sans secteur (plan général) n'est modifiable, comme à sa création,
   * qu'avec la portée « tous » ; en portée « perso », l'auteur garde la main sur son plan tant que son secteur
   * reste dans sa portée d'écriture (un site passé en lecture seule la lui retire).
   */
  function peutEcrire(req, plan) {
    return !!plan && ctx.canSee(Object.assign({}, req, { ecriture: true }), plan) && secteurEcrivable(req, plan.secteurId);
  }
  function lectureSeule(req, plan) {
    const p = req.perms || {};
    return plan.secteurId != null && Array.isArray(p.secteurIdsLecture) && p.secteurIdsLecture.includes(Number(plan.secteurId));
  }
  function getLisible(req, id) {
    const plan = db.get(ENTITE, id);
    if (!plan || !peutLire(req, plan)) throw new HttpError(404, 'Plan introuvable');
    return plan;
  }
  function getEcrivable(req, id) {
    const plan = getLisible(req, id);
    if (!peutEcrire(req, plan)) {
      if (lectureSeule(req, plan)) throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
      throw new HttpError(403, 'Ce plan est hors de votre périmètre de modification (portée de vos secteurs)');
    }
    return plan;
  }

  /** Visibilité d'un équipement (règle du module équipements si disponible, sinon portée standard). */
  function voirEquipement(req, eq, ecriture) {
    if (!eq) return false;
    const r = Object.assign({}, req, { ecriture: !!ecriture });
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') return !!s.visible(r, eq);
    return ctx.canSee(r, eq);
  }

  // ----- Indicateurs vivants des équipements -------------------------------------------
  function indexInterventions() {
    const finauxOt = statutsFinaux('statutsOT', ['termine', 'annule']);
    const finauxDi = statutsFinaux('statutsDemande', ['refusee', 'cloturee']);
    const priorites = ctx.liste('priorites');
    const ordrePrio = new Map(priorites.map((p) => [p.code, Number(p.ordre) || 0]));
    const ordreMax = priorites.length ? Math.max(...priorites.map((p) => Number(p.ordre) || 0)) : 0;
    const urgentes = new Set(priorites.filter((p) => (p.delaiHeures != null && Number(p.delaiHeures) <= 8) || (Number(p.ordre) || 0) === ordreMax).map((p) => p.code));
    const ot = new Map();
    for (const o of db.list('ot', (x) => x.equipementId != null && !finauxOt.has(x.statut))) {
      const k = Number(o.equipementId);
      const cur = ot.get(k) || { nb: 0, prioriteMax: null, ordreMax: -1, urgent: false, enCours: 0 };
      cur.nb += 1;
      const ord = ordrePrio.has(o.prioriteCode) ? ordrePrio.get(o.prioriteCode) : -1;
      if (ord > cur.ordreMax) { cur.ordreMax = ord; cur.prioriteMax = o.prioriteCode || null; }
      if (urgentes.has(o.prioriteCode)) cur.urgent = true;
      ot.set(k, cur);
    }
    const di = new Map();
    for (const d of db.list('demandes', (x) => x.equipementId != null && !finauxDi.has(x.statut))) {
      const k = Number(d.equipementId);
      const cur = di.get(k) || { nb: 0, arret: false };
      cur.nb += 1; if (d.arretProduction) cur.arret = true;
      di.set(k, cur);
    }
    return { ot, di };
  }
  function infoEquipement(eq, idx) {
    const o = idx.ot.get(eq.id) || { nb: 0, prioriteMax: null, urgent: false };
    const d = idx.di.get(eq.id) || { nb: 0, arret: false };
    const alerte = o.urgent || d.arret ? 'urgent' : (o.nb || d.nb ? 'en_cours' : 'aucun');
    return {
      id: eq.id, numero: eq.numero || '', nom: eq.nom || '', etatCode: eq.etatCode || null, criticiteCode: eq.criticiteCode || null,
      typeCode: eq.typeCode || null, secteurId: eq.secteurId == null ? null : Number(eq.secteurId), actif: eq.actif !== false,
      nbOtOuverts: o.nb, prioriteMax: o.prioriteMax, nbDemandesOuvertes: d.nb, arretProduction: d.arret, alerte,
    };
  }
  /** Informations des équipements liés et visibles d'un plan : Map(equipementId → info). */
  function etatEquipements(req, plan) {
    const ids = new Set();
    for (const o of plan.objets || []) if (o.equipementId != null) ids.add(Number(o.equipementId));
    const out = new Map();
    if (!ids.size) return out;
    const idx = indexInterventions();
    for (const id of ids) {
      const eq = db.get('equipements', id);
      if (eq && voirEquipement(req, eq, false)) out.set(id, infoEquipement(eq, idx));
    }
    return out;
  }

  // ----- Représentations ------------------------------------------------------------------
  function urlFond(plan) { return plan.fond && plan.fond.image ? `/api/plans/${plan.id}/fond?v=${plan.fond.hash || plan.version || 1}` : null; }
  function fondPublic(plan) {
    if (!plan.fond) return null;
    const { image, ...reste } = plan.fond;
    return Object.assign(reste, { imageUrl: urlFond(plan) });
  }
  function statistiques(objets, nbLies) {
    const parType = {};
    for (const o of objets || []) parType[o.type] = (parType[o.type] || 0) + 1;
    return { nbObjets: (objets || []).length, parType, nbLies };
  }
  /** Nombre de liens vers des équipements visibles par la requête (les équipements masqués ne sont pas comptés, ni révélés). */
  function nbLiesVisibles(req, plan) {
    let n = 0;
    for (const o of plan.objets || []) {
      if (o.equipementId == null) continue;
      const eq = db.get('equipements', o.equipementId);
      if (eq && voirEquipement(req, eq, false)) n += 1;
    }
    return n;
  }
  /**
   * Le nom d'un objet lié à un équipement masqué reprend-il la désignation ou le numéro de cet équipement ?
   * (la vue recopie la désignation au moment du lien : elle ne doit pas être révélée avec l'objet)
   */
  function nomReveleEquipement(o) {
    const eq = o.equipementId == null ? null : db.get('equipements', o.equipementId);
    const nomObjet = String(o.nom || '').trim().toLowerCase();
    if (!eq || !nomObjet) return false;
    const nomEq = String(eq.nom || '').trim().toLowerCase(), numero = String(eq.numero || '').trim().toLowerCase();
    return (nomEq && nomObjet === nomEq) || (numero.length >= 3 && nomObjet.includes(numero));
  }
  /** Aperçu géométrique allégé (miniature de la liste) : 800 objets au plus, triés par emprise. */
  function apercu(plan) {
    const objs = (plan.objets || []).filter((o) => o.type !== 'texte' && (o.niveauId == null || !plan.niveaux || o.niveauId === plan.niveaux[0].id));
    const emprise = (o) => (estSegment(o) ? Math.hypot((o.x2 || 0) - o.x, (o.y2 || 0) - o.y) * (o.epaisseur || 0.2) : (o.largeur || 0) * (o.profondeur || 0));
    const ordreType = { batiment: 0, zone: 1, allee: 2, mur: 3, installation: 4, machine: 5, porte: 6 };
    return objs.slice().sort((a, b) => emprise(b) - emprise(a)).slice(0, 800)
      .sort((a, b) => (ordreType[a.type] || 0) - (ordreType[b.type] || 0))
      .map((o) => {
        const r = { t: o.type, c: o.couleur || (DEFAUTS[o.type] || {}).couleur || '#6b7280' };
        if (estSegment(o)) Object.assign(r, { x: arrondi(o.x, 1), y: arrondi(o.y, 1), x2: arrondi(o.x2, 1), y2: arrondi(o.y2, 1), e: arrondi(o.epaisseur || 0.2, 2) });
        else if (o.points && o.points.length >= 3) r.p = o.points.map(([x, y]) => [arrondi(x, 1), arrondi(y, 1)]);
        else Object.assign(r, { x: arrondi(o.x, 1), y: arrondi(o.y, 1), l: arrondi(o.largeur, 2), d: arrondi(o.profondeur, 2), r: o.rotation || 0, f: o.forme === 'cylindre' ? 1 : 0 });
        return r;
      });
  }
  function droits(req, plan) {
    const ecrivable = peutEcrire(req, plan);
    return {
      modifier: ecrivable && perms.can(req.perms, 'plans', 'modifier'),
      supprimer: ecrivable && perms.can(req.perms, 'plans', 'supprimer'),
      creer: perms.can(req.perms, 'plans', 'creer'),
      lectureSeule: lectureSeule(req, plan),
    };
  }
  function entete(req, plan) {
    const s = secteur(plan.secteurId);
    const siteId = siteDe(plan.secteurId);
    const site = siteId != null ? secteur(siteId) : null;
    return {
      id: plan.id, numero: plan.numero, nom: plan.nom, description: plan.description || '',
      secteurId: plan.secteurId == null ? null : Number(plan.secteurId), secteurNom: s ? s.nom : '', secteurChemin: cheminSecteur(plan.secteurId),
      siteId, siteNom: site ? site.nom : '',
      dimensions: plan.dimensions, niveaux: plan.niveaux || [],
      vue: plan.vue || null,
      createdBy: plan.createdBy, createdByNom: ctx.nomUser(plan.createdBy), updatedBy: plan.updatedBy || plan.createdBy, updatedByNom: ctx.nomUser(plan.updatedBy || plan.createdBy),
      createdAt: plan.createdAt, updatedAt: plan.updatedAt, version: plan.version || 1,
      droits: droits(req, plan),
    };
  }
  function resume(req, plan) {
    return Object.assign(entete(req, plan), statistiques(plan.objets, nbLiesVisibles(req, plan)), { fond: !!plan.fond, apercu: apercu(plan) });
  }
  /** Fiche complète : objets enrichis (équipements visibles) ; équipements non visibles masqués. */
  function detail(req, plan) {
    const infos = etatEquipements(req, plan);
    const objets = (plan.objets || []).map((o) => {
      const r = Object.assign({}, o);
      if (o.equipementId != null) {
        const info = infos.get(Number(o.equipementId));
        if (info) r.equipement = info;
        else {
          r.equipementId = null; r.equipementMasque = true;
          // le nom de l'objet ne doit pas révéler l'équipement masqué (il est rétabli à l'enregistrement, voir validerObjets)
          if (nomReveleEquipement(o)) { r.nom = ''; r.nomMasque = true; }
        }
      }
      if (o.secteurId != null) {
        const s = secteur(o.secteurId);
        r.secteur = s ? { id: s.id, nom: s.nom, code: s.code || '', couleur: s.couleur || '#6b7280', type: s.type || '' } : null;
      }
      return r;
    });
    return Object.assign(entete(req, plan), statistiques(plan.objets, objets.filter((o) => o.equipement).length), { fond: fondPublic(plan), objets });
  }

  // ----- Validation -------------------------------------------------------------------------
  function erreur(prefixe, msg) { return new HttpError(400, prefixe ? `${prefixe} : ${msg}` : msg); }
  function nombre(v, min, max, libelle, defaut, prefixe, decimales) {
    if (v === undefined || v === null || v === '') {
      if (defaut === undefined) throw erreur(prefixe, `${libelle} est obligatoire`);
      return defaut;
    }
    if (typeof v === 'boolean' || (typeof v === 'object')) throw erreur(prefixe, `${libelle} doit être un nombre`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw erreur(prefixe, `${libelle} doit être un nombre`);
    if (n < min || n > max) throw erreur(prefixe, `${libelle} hors limites (${min} à ${max})`);
    return arrondi(n, decimales == null ? 3 : decimales);
  }
  function texte(v, max, libelle, prefixe, obligatoire) {
    if (v != null && typeof v === 'object') throw erreur(prefixe, `${libelle} invalide`);
    const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (obligatoire && !s) throw erreur(prefixe, `${libelle} est obligatoire`);
    if (s.length > max) throw erreur(prefixe, `${libelle} : ${max} caractères maximum`);
    return s;
  }
  const normRotation = (r) => { let x = r % 360; if (x < 0) x += 360; return arrondi(x, 2); };
  const couleurValide = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  const idValide = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);

  function validerDimensions(v, existant) {
    const src = v === undefined ? (existant || { largeur: 60, profondeur: 40 }) : v;
    if (!src || typeof src !== 'object') throw new HttpError(400, 'Dimensions du plan invalides');
    return { largeur: nombre(src.largeur, DIM_MIN, DIM_MAX, 'La largeur du plan (m)'), profondeur: nombre(src.profondeur, DIM_MIN, DIM_MAX, 'La profondeur du plan (m)') };
  }
  function validerNiveaux(v, existant) {
    const src = v === undefined ? (existant || null) : v;
    if (src == null) return [{ id: 'rdc', nom: 'Rez-de-chaussée', altitude: 0, hauteur: 4 }];
    if (!Array.isArray(src) || !src.length) throw new HttpError(400, 'Le plan doit comporter au moins un niveau');
    if (src.length > MAX_NIVEAUX) throw new HttpError(400, `${MAX_NIVEAUX} niveaux au maximum`);
    const ids = new Set();
    let altitude = 0;
    return src.map((n, i) => {
      if (!n || typeof n !== 'object') throw new HttpError(400, `Niveau n°${i + 1} invalide`);
      const pre = `Niveau n°${i + 1}`;
      const id = n.id == null || n.id === '' ? `n${i + 1}` : n.id;
      if (!idValide(String(id))) throw erreur(pre, 'identifiant invalide');
      if (ids.has(String(id))) throw erreur(pre, `identifiant « ${id} » en double`);
      ids.add(String(id));
      const hauteur = nombre(n.hauteur, 0.5, 100, 'La hauteur sous plafond (m)', 4, pre);
      const alt = nombre(n.altitude, -100, 1000, 'L\'altitude (m)', altitude, pre);
      altitude = alt + hauteur;
      return { id: String(id), nom: texte(n.nom, 60, 'Le nom du niveau', pre, true), altitude: alt, hauteur };
    });
  }
  /** Décode et contrôle une image dataURL PNG / JPEG (signature, taille). */
  function validerImage(dataUrl) {
    if (typeof dataUrl !== 'string') throw new HttpError(400, 'Fond de plan : image invalide');
    const m = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw new HttpError(400, 'Fond de plan : seules les images PNG ou JPEG sont acceptées');
    const b64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'Fond de plan : image vide');
    if (taille > MAX_IMAGE) throw new HttpError(400, `Fond de plan trop volumineux (${(taille / 1024 / 1024).toFixed(1)} Mo, maximum 8 Mo)`);
    const debut = Buffer.from(b64.slice(0, 16), 'base64');
    const png = debut[0] === 0x89 && debut[1] === 0x50 && debut[2] === 0x4e && debut[3] === 0x47;
    const jpeg = debut[0] === 0xff && debut[1] === 0xd8 && debut[2] === 0xff;
    const type = m[1] === 'png' ? 'image/png' : 'image/jpeg';
    if ((type === 'image/png' && !png) || (type === 'image/jpeg' && !jpeg)) throw new HttpError(400, 'Fond de plan : le contenu ne correspond pas à une image PNG ou JPEG');
    return { image: `data:${type};base64,${b64}`, type, taille, hash: crypto.createHash('sha1').update(b64).digest('hex').slice(0, 16) };
  }
  function validerFond(v, existant, niveaux) {
    if (v === undefined) {
      if (!existant) return null;
      // niveau supprimé : le fond est rattaché au premier niveau
      return Object.assign({}, existant, { niveauId: niveaux.some((n) => n.id === existant.niveauId) ? existant.niveauId : niveaux[0].id });
    }
    if (v === null) return null;
    if (typeof v !== 'object') throw new HttpError(400, 'Fond de plan invalide');
    let img;
    if (v.image != null && v.image !== '') img = validerImage(v.image);
    else if (existant && existant.image) img = { image: existant.image, type: existant.type, taille: existant.taille, hash: existant.hash || crypto.createHash('sha1').update(existant.image).digest('hex').slice(0, 16) };
    else throw new HttpError(400, 'Fond de plan : image manquante');
    const pre = 'Fond de plan';
    const niveauId = v.niveauId == null || v.niveauId === '' ? niveaux[0].id : String(v.niveauId);
    if (!niveaux.some((n) => n.id === niveauId)) throw erreur(pre, 'niveau inconnu');
    return Object.assign(img, {
      echelle: nombre(v.echelle, 0.00001, 1000, 'L\'échelle (m/pixel)', undefined, pre, 8),
      x: nombre(v.x, -BORNE, BORNE, 'La position x', 0, pre),
      y: nombre(v.y, -BORNE, BORNE, 'La position y', 0, pre),
      rotation: normRotation(nombre(v.rotation, -3600, 3600, 'La rotation', 0, pre)),
      opacite: nombre(v.opacite, 0, 1, 'L\'opacité', 0.6, pre),
      niveauId,
      nomFichier: texte(v.nomFichier || (existant && existant.nomFichier) || '', 150, 'Le nom du fichier', pre),
    });
  }
  function validerVue(v, existant) {
    const src = v === undefined ? existant : v;
    if (src == null) return null;
    if (typeof src !== 'object') throw new HttpError(400, 'Vue par défaut invalide');
    const pre = 'Vue par défaut';
    return {
      x: nombre(src.x, -BORNE, BORNE, 'La cible x', 0, pre), y: nombre(src.y, -BORNE, BORNE, 'La cible y', 0, pre), z: nombre(src.z, -1000, 1000, 'La cible z', 0, pre),
      distance: nombre(src.distance, 0.5, 20000, 'La distance', 50, pre), azimut: normRotation(nombre(src.azimut, -3600, 3600, 'L\'azimut', 0, pre)),
      elevation: nombre(src.elevation, -10, 90, 'L\'élévation', 45, pre), dessus: !!src.dessus,
    };
  }

  /**
   * Valide la liste d'objets.
   * opts : { req, niveaux, siteId, anciens (Map id → objet stocké), recontroler (liens inchangés revérifiés : changement
   *          de site), tolerant (import : liens invalides retirés), rapport }
   * Une erreur de validation porte l'identifiant de l'objet fautif dans `details.objetId` (sélection dans l'éditeur).
   */
  function validerObjets(liste, opts) {
    if (!Array.isArray(liste)) throw new HttpError(400, 'La liste des objets est invalide');
    if (liste.length > MAX_OBJETS) throw new HttpError(400, `Un plan comporte au plus ${MAX_OBJETS} objets (${liste.length} reçus)`);
    const ids = new Set();
    const equipementsLies = new Map();
    const niveauxIds = new Set(opts.niveaux.map((n) => n.id));
    const cacheEq = new Map();
    const cacheSect = new Map();
    const rapport = opts.rapport || { liensRetires: 0, liensConserves: 0 };

    const equipementAutorise = (id, ancien) => {
      if (!opts.recontroler && ancien && Number(ancien.equipementId) === id) return true; // lien inchangé (établi par une personne habilitée)
      if (cacheEq.has(id)) return cacheEq.get(id);
      const eq = db.get('equipements', id);
      let r = true;
      // même message qu'un équipement inexistant ou hors de portée : la validation ne révèle pas l'existence d'un équipement invisible
      if (!eq || !voirEquipement(opts.req, eq, true)) r = 'introuvable ou hors de votre portée (ou site en lecture seule)';
      else if (opts.siteId != null && eq.secteurId != null && siteDe(eq.secteurId) != null && siteDe(eq.secteurId) !== opts.siteId) r = 'appartient à un autre site';
      cacheEq.set(id, r);
      return r;
    };
    const secteurAutorise = (id, ancien) => {
      if (!opts.recontroler && ancien && Number(ancien.secteurId) === id) return true;
      if (cacheSect.has(id)) return cacheSect.get(id);
      const s = db.get('secteurs', id);
      let r = true;
      if (!s) r = 'introuvable';
      else if (!secteurEcrivable(opts.req, id)) r = 'hors de votre portée (ou site en lecture seule)';
      else if (opts.siteId != null && siteDe(id) !== opts.siteId) r = 'appartient à un autre site';
      cacheSect.set(id, r);
      return r;
    };

    const validerUn = (o, i) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, `Objet n°${i + 1} invalide`);
      const pre = `Objet n°${i + 1}${o.nom ? ` (« ${String(o.nom).slice(0, 40)} »)` : ''}`;
      if (!TYPES.includes(o.type)) throw erreur(pre, `type inconnu « ${o.type} »`);
      const id = o.id == null ? `o${i + 1}` : String(o.id);
      if (!idValide(id)) throw erreur(pre, 'identifiant invalide (lettres, chiffres, - et _ ; 40 caractères au plus)');
      if (ids.has(id)) throw erreur(pre, `identifiant « ${id} » en double`);
      ids.add(id);
      const ancien = opts.anciens ? opts.anciens.get(id) : null;
      const def = DEFAUTS[o.type];
      const out = { id, type: o.type };
      if (o.type === 'installation') {
        out.categorie = o.categorie == null || o.categorie === '' ? 'autre' : o.categorie;
        if (!CATEGORIES.includes(out.categorie)) throw erreur(pre, `catégorie d'installation inconnue « ${o.categorie} »`);
      }
      const niveauId = o.niveauId == null || o.niveauId === '' ? opts.niveaux[0].id : String(o.niveauId);
      if (!niveauxIds.has(niveauId)) throw erreur(pre, `niveau inconnu « ${niveauId} »`);
      out.niveauId = niveauId;
      out.nom = texte(o.nom, 120, 'Le nom', pre);
      if (!out.nom && o.nomMasque && ancien && ancien.equipementId != null && !opts.recontroler) out.nom = String(ancien.nom || ''); // nom masqué (équipement hors de portée) conservé
      out.x = nombre(o.x, -BORNE, BORNE, 'La position x (m)', undefined, pre);
      out.y = nombre(o.y, -BORNE, BORNE, 'La position y (m)', undefined, pre);
      out.z = nombre(o.z, -100, 500, 'L\'élévation (m)', 0, pre);
      out.rotation = normRotation(nombre(o.rotation, -3600, 3600, 'La rotation (°)', 0, pre));
      out.hauteur = nombre(o.hauteur, 0, 300, 'La hauteur (m)', def.hauteur, pre);
      out.couleur = o.couleur == null || o.couleur === '' ? def.couleur : String(o.couleur);
      if (!couleurValide(out.couleur)) throw erreur(pre, 'couleur invalide (format #rrggbb attendu)');
      out.couleur = out.couleur.toLowerCase();
      out.verrouille = !!o.verrouille;

      if (estSegment(out)) {
        out.x2 = nombre(o.x2, -BORNE, BORNE, 'La position x2 (m)', undefined, pre);
        out.y2 = nombre(o.y2, -BORNE, BORNE, 'La position y2 (m)', undefined, pre);
        if (Math.hypot(out.x2 - out.x, out.y2 - out.y) < 0.01) throw erreur(pre, 'la longueur du segment est nulle');
        out.epaisseur = nombre(o.epaisseur, 0.01, 100, 'L\'épaisseur (m)', def.epaisseur || 0.2, pre);
        out.largeur = arrondi(Math.hypot(out.x2 - out.x, out.y2 - out.y));
        out.profondeur = out.epaisseur;
      } else {
        out.largeur = nombre(o.largeur, 0.01, DIM_MAX * 2, 'La largeur (m)', def.largeur, pre);
        out.profondeur = nombre(o.profondeur, 0.01, DIM_MAX * 2, 'La profondeur (m)', def.profondeur, pre);
      }
      if (TYPES_POLYGONE.includes(o.type) && o.points != null) {
        if (!Array.isArray(o.points) || o.points.length < 3) throw erreur(pre, 'un polygone comporte au moins 3 sommets');
        if (o.points.length > MAX_POINTS) throw erreur(pre, `${MAX_POINTS} sommets au maximum`);
        out.points = o.points.map((p, j) => {
          if (!Array.isArray(p) || p.length !== 2) throw erreur(pre, `sommet n°${j + 1} invalide`);
          return [nombre(p[0], -BORNE, BORNE, `Le sommet n°${j + 1} (x)`, undefined, pre), nombre(p[1], -BORNE, BORNE, `Le sommet n°${j + 1} (y)`, undefined, pre)];
        });
        // centre et emprise recalculés depuis le polygone
        const xs = out.points.map((p) => p[0]), ys = out.points.map((p) => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        if (maxX - minX < 0.01 || maxY - minY < 0.01) throw erreur(pre, 'le polygone est dégénéré (surface nulle)');
        Object.assign(out, { x: arrondi((minX + maxX) / 2), y: arrondi((minY + maxY) / 2), largeur: arrondi(maxX - minX), profondeur: arrondi(maxY - minY), rotation: 0 });
      }
      if (o.type === 'machine' || o.type === 'installation') {
        out.forme = o.forme == null || o.forme === '' ? 'boite' : o.forme;
        if (!FORMES.includes(out.forme)) throw erreur(pre, `forme inconnue « ${o.forme} »`);
      }
      if (o.type === 'texte') {
        out.texte = texte(o.texte == null ? o.nom : o.texte, 200, 'Le texte', pre, true);
        out.taille = nombre(o.taille, 0.1, 50, 'La taille du texte (m)', 1, pre);
      }

      // Lien vers un équipement
      if (TYPES_LIES_EQUIPEMENT.includes(o.type)) {
        let eqId = o.equipementId == null || o.equipementId === '' ? null : Number(o.equipementId);
        if (eqId == null && o.equipementMasque && ancien && ancien.equipementId != null && !opts.recontroler) eqId = Number(ancien.equipementId); // lien masqué conservé
        if (eqId != null) {
          if (!Number.isInteger(eqId) || eqId <= 0) throw erreur(pre, 'équipement lié invalide');
          const ok = equipementAutorise(eqId, ancien);
          if (ok !== true) {
            if (!opts.tolerant) throw erreur(pre, `l'équipement lié (n°${eqId}) ${ok}`);
            rapport.liensRetires += 1; eqId = null;
          } else if (equipementsLies.has(eqId)) {
            if (!opts.tolerant) throw erreur(pre, `cet équipement est déjà placé sur le plan (objet « ${equipementsLies.get(eqId)} »)`);
            rapport.liensRetires += 1; eqId = null;
          }
          if (eqId != null) { equipementsLies.set(eqId, out.nom || id); rapport.liensConserves += 1; }
        }
        out.equipementId = eqId;
      }
      // Lien vers un secteur (zone / bâtiment)
      if (TYPES_LIES_SECTEUR.includes(o.type)) {
        let sid = o.secteurId == null || o.secteurId === '' ? null : Number(o.secteurId);
        if (sid != null) {
          if (!Number.isInteger(sid) || sid <= 0) throw erreur(pre, 'secteur lié invalide');
          const ok = secteurAutorise(sid, ancien);
          if (ok !== true) {
            if (!opts.tolerant) throw erreur(pre, `le secteur lié (n°${sid}) ${ok}`);
            rapport.liensRetires += 1; sid = null;
          } else rapport.liensConserves += 1;
        }
        out.secteurId = sid;
      }
      return out;
    };
    return liste.map((o, i) => {
      try { return validerUn(o, i); } catch (e) {
        if (e instanceof HttpError && e.status === 400 && e.details === undefined) e.details = { objetId: o && typeof o === 'object' && o.id != null ? String(o.id) : null, index: i };
        throw e;
      }
    });
  }

  function genererNumero() {
    const gabarit = (ctx.config().numerotation || {}).pl || 'PL-{num:3}';
    for (let i = 0; i < 1000; i++) {
      const n = db.nextNumber('pl', gabarit);
      if (!db.findOne(ENTITE, (p) => p.numero === n)) return n;
    }
    throw new HttpError(500, 'Impossible de générer un numéro de plan unique');
  }

  /** Valide un plan complet (création) ou partiel (modification : champs absents conservés). */
  function validerPlan(req, body, existant, options = {}) {
    body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const out = {};
    out.nom = texte(body.nom === undefined ? (existant ? existant.nom : '') : body.nom, 150, 'Le nom du plan', '', true);
    out.description = texte(body.description === undefined ? (existant ? existant.description : '') : body.description, 5000, 'La description');

    let secteurId = body.secteurId === undefined ? (existant ? existant.secteurId : null) : (body.secteurId == null || body.secteurId === '' ? null : Number(body.secteurId));
    if (secteurId != null) {
      if (!Number.isInteger(secteurId)) throw new HttpError(400, 'Site ou bâtiment invalide');
      // le secteur n'est contrôlé que s'il change : un plan dont le secteur a disparu reste modifiable (et peut être déplacé)
      const change = !existant || Number(existant.secteurId) !== secteurId;
      if (change && !db.get('secteurs', secteurId)) throw new HttpError(400, 'Site ou bâtiment invalide');
      if (change && !secteurEcrivable(req, secteurId)) throw new HttpError(403, 'Vous ne pouvez créer ou déplacer un plan que dans vos propres sites / secteurs (hors sites en lecture seule)');
    } else if (req.perms.portee !== 'tous') {
      throw new HttpError(400, 'Le site ou bâtiment du plan est obligatoire');
    }
    out.secteurId = secteurId;
    const siteId = siteDe(secteurId);

    out.dimensions = validerDimensions(body.dimensions, existant ? existant.dimensions : null);
    out.niveaux = validerNiveaux(body.niveaux, existant ? existant.niveaux : null);
    out.fond = validerFond(body.fond, existant ? existant.fond : null, out.niveaux);
    out.vue = validerVue(body.vue, existant ? existant.vue : null);
    const anciens = new Map(((existant && existant.objets) || []).map((o) => [o.id, o]));
    const siteChange = existant && siteDe(existant.secteurId) !== siteId;
    if (body.objets !== undefined || siteChange || (existant && body.niveaux !== undefined)) {
      // objets fournis, ou revalidation nécessaire (changement de site : liens à recontrôler ; niveaux modifiés)
      const src = body.objets !== undefined ? body.objets : (existant ? existant.objets : []);
      out.objets = validerObjets(src, { req, niveaux: out.niveaux, siteId, anciens, recontroler: !!siteChange, tolerant: !!options.tolerant, rapport: options.rapport });
    } else {
      out.objets = existant ? existant.objets : [];
    }
    return out;
  }

  // ----- Notifications ------------------------------------------------------------------------
  function notifierModification(req, plan, verbe) {
    const cible = plan.createdBy;
    if (cible == null || Number(cible) === req.user.id) return;
    const u = db.get('users', cible);
    if (!u || u.actif === false) return;
    if (verbe === 'modifié') {
      const dernier = notifiesRecemment.get(plan.id) || 0;
      if (Date.now() - dernier < DELAI_NOTIF_MS) return;
      notifiesRecemment.set(plan.id, Date.now());
    }
    ctx.notify([cible], { titre: `Plan 3D ${verbe} : ${plan.nom}`, message: `Le plan ${plan.numero} « ${plan.nom} » a été ${verbe} par ${ctx.nomUser(req.user.id)}.`, lien: verbe === 'supprimé' ? '#/plans' : '#/plans/' + plan.id, type: 'info' });
  }
  function notifierCreation(req, plan) {
    const s = secteur(plan.secteurId);
    const cibles = new Set();
    if (s && s.responsableId != null) cibles.add(Number(s.responsableId));
    const site = secteur(siteDe(plan.secteurId));
    if (site && site.responsableId != null) cibles.add(Number(site.responsableId));
    cibles.delete(req.user.id);
    if (cibles.size) ctx.notify(Array.from(cibles), { titre: `Nouveau plan 3D : ${plan.nom}`, message: `${ctx.nomUser(req.user.id)} a créé le plan ${plan.numero} « ${plan.nom} »${s ? ` (${s.nom})` : ''}.`, lien: '#/plans/' + plan.id, type: 'info' });
  }

  // ----- Routes ------------------------------------------------------------------------------
  router.get('/api/plans', async (req) => {
    const q = req.query || {};
    let rows = db.list(ENTITE).filter((p) => peutLire(req, p));
    if (q.secteurId) {
      const ids = new Set(perms.secteursDescendants(db, [Number(q.secteurId)]).map(Number));
      rows = rows.filter((p) => p.secteurId != null && ids.has(Number(p.secteurId)));
    }
    if (q.siteId) rows = rows.filter((p) => siteDe(p.secteurId) === Number(q.siteId));
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase();
      rows = rows.filter((p) => [p.numero, p.nom, p.description, cheminSecteur(p.secteurId)].some((v) => String(v || '').toLowerCase().includes(s)));
    }
    return rows.sort((a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true })).map((p) => resume(req, p));
  }, { perm: [ENTITE, 'voir'] });

  router.get('/api/plans/:id', async (req) => detail(req, getLisible(req, req.params.id)), { perm: [ENTITE, 'voir'] });

  /** Image du fond de plan (binaire, mise en cache par le navigateur grâce au paramètre de version). */
  router.get('/api/plans/:id/fond', async (req, res) => {
    const plan = getLisible(req, req.params.id);
    if (!plan.fond || !plan.fond.image) throw new HttpError(404, 'Ce plan n\'a pas de fond de plan');
    const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/s.exec(plan.fond.image);
    if (!m) throw new HttpError(500, 'Fond de plan corrompu');
    const buf = Buffer.from(m[2], 'base64');
    res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }, { perm: [ENTITE, 'voir'] });

  /** État vivant des équipements liés (rafraîchi périodiquement par la vue). */
  router.get('/api/plans/:id/etat', async (req) => {
    const plan = getLisible(req, req.params.id);
    const infos = etatEquipements(req, plan);
    return { id: plan.id, version: plan.version || 1, updatedAt: plan.updatedAt, updatedByNom: ctx.nomUser(plan.updatedBy || plan.createdBy), date: new Date().toISOString(), equipements: Object.fromEntries(infos) };
  }, { perm: [ENTITE, 'voir'] });

  router.post('/api/plans', async (req) => {
    const data = validerPlan(req, req.body, null);
    Object.assign(data, { numero: genererNumero(), createdBy: req.user.id, updatedBy: req.user.id, version: 1 });
    const plan = db.insert(ENTITE, data);
    ctx.audit(req, 'creation', ENTITE, plan.id, `Plan ${plan.numero} ${plan.nom} (${plan.objets.length} objet(s))`);
    notifierCreation(req, plan);
    ctx.emit('plan:cree', { plan });
    return detail(req, plan);
  }, { perm: [ENTITE, 'creer'], maxBody: MAX_CORPS });

  router.put('/api/plans/:id', async (req) => {
    const existant = getEcrivable(req, req.params.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.version === undefined || body.version === null || body.version === '') throw new HttpError(400, 'Version du plan manquante (contrôle de concurrence)');
    if (Number(body.version) !== Number(existant.version || 1)) {
      throw new HttpError(409, 'Le plan a été modifié par quelqu\'un d\'autre', { version: existant.version || 1, updatedAt: existant.updatedAt, updatedByNom: ctx.nomUser(existant.updatedBy || existant.createdBy) });
    }
    const data = validerPlan(req, body, existant);
    data.version = (existant.version || 1) + 1;
    data.updatedBy = req.user.id;
    const plan = db.update(ENTITE, existant.id, data);
    const changes = [];
    if (existant.nom !== plan.nom) changes.push(`nom « ${existant.nom} » → « ${plan.nom} »`);
    if (Number(existant.secteurId) !== Number(plan.secteurId)) changes.push(`secteur ${cheminSecteur(existant.secteurId) || '—'} → ${cheminSecteur(plan.secteurId) || '—'}`);
    if (body.objets !== undefined) changes.push(`${(existant.objets || []).length} → ${plan.objets.length} objet(s)`);
    if (body.niveaux !== undefined) changes.push(`${plan.niveaux.length} niveau(x)`);
    if (body.fond !== undefined) changes.push(plan.fond ? 'fond de plan mis à jour' : 'fond de plan retiré');
    ctx.audit(req, 'modification', ENTITE, plan.id, `Plan ${plan.numero} ${plan.nom} (version ${plan.version})${changes.length ? ' : ' + changes.join(', ') : ''}`);
    notifierModification(req, plan, 'modifié');
    ctx.emit('plan:modifie', { plan, ancien: existant });
    return detail(req, plan);
  }, { perm: [ENTITE, 'modifier'], maxBody: MAX_CORPS });

  router.delete('/api/plans/:id', async (req) => {
    const existant = getEcrivable(req, req.params.id);
    db.remove(ENTITE, existant.id);
    notifiesRecemment.delete(existant.id);
    ctx.audit(req, 'suppression', ENTITE, existant.id, `Plan ${existant.numero} ${existant.nom} (${(existant.objets || []).length} objet(s))`);
    notifierModification(req, existant, 'supprimé');
    ctx.emit('plan:supprime', { plan: existant });
    return { ok: true };
  }, { perm: [ENTITE, 'supprimer'] });

  router.post('/api/plans/:id/dupliquer', async (req) => {
    const source = getLisible(req, req.params.id);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const secteurId = b.secteurId === undefined || b.secteurId === '' ? source.secteurId : (b.secteurId == null ? null : Number(b.secteurId));
    if (secteurId != null && !secteurEcrivable(req, secteurId)) throw new HttpError(403, 'Vous ne pouvez dupliquer ce plan que vers vos propres sites / secteurs (hors sites en lecture seule)');
    const memeSite = siteDe(secteurId) === siteDe(source.secteurId);
    const lisibles = new Set(etatEquipements(req, source).keys());
    const objets = (source.objets || []).map((o) => {
      const c = Object.assign({}, o);
      if (c.equipementId != null && (!memeSite || !lisibles.has(Number(c.equipementId)) || b.sansLiens)) c.equipementId = null;
      if (c.secteurId != null && (!memeSite || b.sansLiens)) c.secteurId = null;
      return c;
    });
    const rapport = { liensRetires: 0, liensConserves: 0 };
    const data = validerPlan(req, {
      nom: String(b.nom || '').trim() || `${source.nom} (copie)`, description: source.description, secteurId,
      dimensions: source.dimensions, niveaux: source.niveaux, vue: source.vue, objets,
      fond: source.fond ? Object.assign({}, source.fond) : null,
    }, null, { tolerant: true, rapport });
    Object.assign(data, { numero: genererNumero(), createdBy: req.user.id, updatedBy: req.user.id, version: 1 });
    const plan = db.insert(ENTITE, data);
    ctx.audit(req, 'duplication', ENTITE, plan.id, `Plan ${plan.numero} ${plan.nom} (copie de ${source.numero})`);
    notifierCreation(req, plan);
    ctx.emit('plan:cree', { plan, source });
    return Object.assign(detail(req, plan), { rapport });
  }, { perm: [ENTITE, 'creer'] });

  /** Localisation d'un équipement sur les plans visibles. */
  router.get('/api/plans-localiser/:equipementId', async (req) => {
    const eq = db.get('equipements', req.params.equipementId);
    if (!eq || !voirEquipement(req, eq, false)) throw new HttpError(404, 'Équipement introuvable');
    return localiser(eq.id, req);
  }, { perm: [ENTITE, 'voir'] });

  /** Export JSON autonome (image du fond comprise ; liens exprimés aussi par numéro d'équipement / code de secteur). */
  router.get('/api/plans/:id/export', async (req, res) => {
    const plan = getLisible(req, req.params.id);
    const infos = etatEquipements(req, plan);
    const objets = (plan.objets || []).map((o) => {
      const c = Object.assign({}, o);
      if (c.equipementId != null) {
        const info = infos.get(Number(c.equipementId));
        if (info) c.equipementRef = { numero: info.numero, nom: info.nom };
        else { if (nomReveleEquipement(c)) c.nom = ''; c.equipementId = null; }
      }
      if (c.secteurId != null) { const s = secteur(c.secteurId); c.secteurRef = s ? { code: s.code || '', nom: s.nom } : null; }
      return c;
    });
    const s = secteur(plan.secteurId);
    const contenu = {
      format: 'sicaf-plan-3d', versionFormat: 1, application: 'GMAO SICAF', exporteLe: new Date().toISOString(), exportePar: ctx.nomUser(req.user.id),
      plan: { numero: plan.numero, nom: plan.nom, description: plan.description || '', secteur: s ? { code: s.code || '', nom: s.nom } : null, dimensions: plan.dimensions, niveaux: plan.niveaux, fond: plan.fond || null, vue: plan.vue || null, objets },
    };
    ctx.audit(req, 'export', ENTITE, plan.id, `Plan ${plan.numero} ${plan.nom}`);
    const nomFichier = `plan-${String(plan.numero || plan.id).replace(/[^\w-]/g, '_')}.json`;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${nomFichier}"`, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(contenu));
  }, { perm: [ENTITE, 'voir'] });

  /** Import d'un plan exporté : crée un nouveau plan ; liens rétablis par numéro d'équipement / code de secteur du site cible. */
  router.post('/api/plans/import', async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const fichier = b.fichier && typeof b.fichier === 'object' ? b.fichier : b;
    if (fichier.format !== 'sicaf-plan-3d' || !fichier.plan || typeof fichier.plan !== 'object') throw new HttpError(400, 'Fichier invalide : export de plan 3D de la GMAO attendu');
    const src = fichier.plan;
    let secteurId = b.secteurId === undefined || b.secteurId === '' ? null : (b.secteurId == null ? null : Number(b.secteurId));
    if (secteurId == null && src.secteur && src.secteur.code) {
      const s = db.findOne('secteurs', (x) => String(x.code || '').toUpperCase() === String(src.secteur.code).toUpperCase());
      if (s && secteurEcrivable(req, s.id)) secteurId = s.id;
    }
    if (secteurId != null && !Number.isInteger(secteurId)) throw new HttpError(400, 'Site ou bâtiment invalide');
    const siteId = siteDe(secteurId);
    const candidatsEq = db.list('equipements', (e) => (siteId == null || e.secteurId == null || siteDe(e.secteurId) === siteId));
    const parNumero = new Map(candidatsEq.map((e) => [String(e.numero || '').toLowerCase(), e]));
    const rapport = { liensRetires: 0, liensConserves: 0 };
    if (!Array.isArray(src.objets)) throw new HttpError(400, 'Fichier invalide : liste des objets absente');
    const objets = src.objets.map((o) => {
      if (!o || typeof o !== 'object') return o;
      const c = Object.assign({}, o);
      delete c.equipement; delete c.secteur; delete c.equipementMasque;
      if (c.equipementRef && c.equipementRef.numero) {
        const e = parNumero.get(String(c.equipementRef.numero).toLowerCase());
        c.equipementId = e ? e.id : null;
        if (!e) rapport.liensRetires += 1;
      } else if (c.equipementId != null) { c.equipementId = null; rapport.liensRetires += 1; }
      if (c.secteurRef && c.secteurRef.code) {
        const s = db.findOne('secteurs', (x) => String(x.code || '').toUpperCase() === String(c.secteurRef.code).toUpperCase());
        c.secteurId = s ? s.id : null;
        if (!s) rapport.liensRetires += 1;
      } else if (c.secteurId != null) { c.secteurId = null; rapport.liensRetires += 1; }
      delete c.equipementRef; delete c.secteurRef;
      return c;
    });
    const data = validerPlan(req, {
      nom: String(b.nom || '').trim() || src.nom || 'Plan importé', description: src.description || '', secteurId,
      dimensions: src.dimensions, niveaux: src.niveaux, vue: src.vue || null, objets,
      fond: src.fond && src.fond.image ? src.fond : null,
    }, null, { tolerant: true, rapport });
    Object.assign(data, { numero: genererNumero(), createdBy: req.user.id, updatedBy: req.user.id, version: 1 });
    const plan = db.insert(ENTITE, data);
    ctx.audit(req, 'import', ENTITE, plan.id, `Plan ${plan.numero} ${plan.nom} importé (${plan.objets.length} objet(s), ${rapport.liensConserves} lien(s) rétabli(s), ${rapport.liensRetires} retiré(s))`);
    notifierCreation(req, plan);
    ctx.emit('plan:cree', { plan, import: true });
    return Object.assign(detail(req, plan), { rapport });
  }, { perm: [ENTITE, 'creer'], maxBody: MAX_CORPS });

  // ----- Services et événements -------------------------------------------------------------
  function localiser(equipementId, req) {
    const id = Number(equipementId);
    const out = [];
    for (const p of db.list(ENTITE)) {
      if (req && req.perms && !peutLire(req, p)) continue;
      const o = (p.objets || []).find((x) => Number(x.equipementId) === id);
      if (o) out.push({ planId: p.id, planNumero: p.numero, planNom: p.nom, objetId: o.id, niveauId: o.niveauId, siteId: siteDe(p.secteurId) });
    }
    return out;
  }

  ctx.on('equipement:supprime', (data) => {
    const eq = data && (data.equipement || data);
    if (!eq || eq.id == null) return;
    for (const p of db.list(ENTITE, (x) => (x.objets || []).some((o) => Number(o.equipementId) === Number(eq.id)))) {
      db.update(ENTITE, p.id, { objets: p.objets.map((o) => (Number(o.equipementId) === Number(eq.id) ? Object.assign({}, o, { equipementId: null }) : o)), version: (p.version || 1) + 1 });
      ctx.audit(null, 'modification', ENTITE, p.id, `Plan ${p.numero} : lien vers l'équipement supprimé ${eq.numero || eq.id} retiré`);
    }
  });

  ctx.services.plans = {
    /** Plans (visibles par la requête si fournie) sur lesquels figure l'équipement : [{ planId, planNom, objetId, … }]. */
    localiser,
    /** Plan brut (ou null). */
    get: (id) => db.get(ENTITE, id),
    /** Objets liés à un équipement d'un plan : [{ objetId, equipementId }]. */
    objetsLies: (planId) => { const p = db.get(ENTITE, planId); return p ? (p.objets || []).filter((o) => o.equipementId != null).map((o) => ({ objetId: o.id, equipementId: o.equipementId })) : []; },
    TYPES, CATEGORIES,
  };
}

// ----- Données de démonstration ------------------------------------------------------------------
function seedDemo(ctx) {
  const { db } = ctx;
  const site = db.findOne('secteurs', (s) => s.code === 'SITE') || db.findOne('secteurs', (s) => s.type === 'site');
  if (!site) return 'aucun site';
  const rapports = [];
  const auteur = db.findOne('users', (u) => u.login === 'mdupont') || db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const auteurId = auteur ? auteur.id : null;
  const gabarit = ((db.getConfig().numerotation || {}).pl) || 'PL-{num:3}';
  const numero = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('pl', gabarit); if (!db.findOne(ENTITE, (p) => p.numero === n)) return n; } return 'PL-' + Date.now(); };
  const code = (c) => { const s = db.findOne('secteurs', (x) => x.code === c); return s ? s.id : null; };
  const siteDe = (sid) => (sid == null ? null : ctx.siteDuSecteur(sid));

  function fabrique(siteId) {
    let n = 0;
    const objets = [];
    const lie = (nomEq) => {
      const e = db.findOne('equipements', (x) => x.nom === nomEq);
      if (!e || (e.secteurId != null && siteDe(e.secteurId) !== siteId)) return null;
      if (objets.some((o) => o.equipementId === e.id)) return null;
      return e.id;
    };
    const add = (o) => { n += 1; const obj = Object.assign({ id: 'o' + n, niveauId: 'rdc', z: 0, rotation: 0, verrouille: false, nom: '' }, o); objets.push(obj); return obj; };
    const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    const zone = (nomZ, x1, y1, x2, y2, couleur, secteurId, extra) => add(Object.assign({ type: 'zone', nom: nomZ, points: rect(x1, y1, x2, y2), x: (x1 + x2) / 2, y: (y1 + y2) / 2, largeur: x2 - x1, profondeur: y2 - y1, hauteur: 0.05, couleur, secteurId: secteurId || null }, extra || {}));
    const batiment = (nomB, x1, y1, x2, y2, hauteur, extra) => add(Object.assign({ type: 'batiment', nom: nomB, points: rect(x1, y1, x2, y2), x: (x1 + x2) / 2, y: (y1 + y2) / 2, largeur: x2 - x1, profondeur: y2 - y1, hauteur, couleur: '#cbd5e1', secteurId: null }, extra || {}));
    const mur = (x, y, x2, y2, extra) => add(Object.assign({ type: 'mur', nom: 'Cloison', x, y, x2, y2, epaisseur: 0.2, hauteur: 4, couleur: '#cbd5e1', largeur: Math.hypot(x2 - x, y2 - y), profondeur: 0.2 }, extra || {}));
    const allee = (nomA, x, y, x2, y2, epaisseur, extra) => add(Object.assign({ type: 'allee', nom: nomA, x, y, x2, y2, epaisseur, hauteur: 0.02, couleur: '#facc15', largeur: Math.hypot(x2 - x, y2 - y), profondeur: epaisseur }, extra || {}));
    const machine = (nomM, nomEq, x, y, largeur, profondeur, hauteur, extra) => add(Object.assign({ type: 'machine', nom: nomM, x, y, largeur, profondeur, hauteur, forme: 'boite', couleur: '#2563eb', equipementId: nomEq ? lie(nomEq) : null }, extra || {}));
    const inst = (categorie, nomI, x, y, largeur, profondeur, hauteur, couleur, extra) => add(Object.assign({ type: 'installation', categorie, nom: nomI, x, y, largeur, profondeur, hauteur, forme: 'boite', couleur, equipementId: null }, extra || {}));
    const reseau = (categorie, nomR, x, y, x2, y2, z, extra) => add(Object.assign({ type: 'installation', categorie, nom: nomR, x, y, x2, y2, z, epaisseur: 0.15, hauteur: 0.15, couleur: categorie === 'reseau_air' ? '#0284c7' : '#059669', largeur: Math.hypot(x2 - x, y2 - y), profondeur: 0.15, forme: 'boite', equipementId: null }, extra || {}));
    const extincteur = (x, y, extra) => inst('extincteur', 'Extincteur', x, y, 0.3, 0.3, 0.7, '#dc2626', Object.assign({ forme: 'cylindre' }, extra || {}));
    const issue = (x, y, rotation, extra) => inst('issue_secours', 'Issue de secours', x, y, 1.4, 0.3, 2.2, '#16a34a', Object.assign({ rotation }, extra || {}));
    const porte = (nomP, x, y, largeur, hauteur, rotation, extra) => add(Object.assign({ type: 'porte', nom: nomP, x, y, largeur, profondeur: 0.35, hauteur, rotation, couleur: '#92400e' }, extra || {}));
    const texteObj = (t, x, y, taille, extra) => add(Object.assign({ type: 'texte', nom: t, texte: t, x, y, largeur: t.length * taille * 0.6, profondeur: taille, hauteur: 0, taille, couleur: '#1f2937' }, extra || {}));
    return { objets, add, zone, batiment, mur, allee, machine, inst, reseau, extincteur, issue, porte, texteObj, lie };
  }

  // ----- Plan 1 : atelier de production du site principal -----
  const dejaSite = db.findOne(ENTITE, (p) => Number(p.secteurId) === site.id && String(p.nom || '').startsWith('Atelier de production'));
  if (dejaSite) rapports.push('plan du site principal déjà présent');
  else {
    const f = fabrique(site.id);
    const PROD = code('PROD'), MAINT = code('MAINT'), LOG = code('LOG'), QUAL = code('QUAL'), SG = code('SG');
    // Bâtiments
    f.batiment('Bâtiment A – Production', 10, 8, 70, 48, 9);
    f.batiment('Bâtiment utilités', 74, 8, 86, 24, 5, { couleur: '#d6d3d1' });
    // Zones liées aux secteurs
    f.zone('Production', 10, 8, 48, 36, '#2563eb', PROD);
    f.zone('Maintenance', 48, 8, 70, 24, '#f59e0b', MAINT);
    f.zone('Logistique – magasin', 48, 24, 70, 48, '#16a34a', LOG);
    f.zone('Qualité – laboratoire', 10, 36, 24, 48, '#8b5cf6', QUAL);
    f.zone('Bureaux et vestiaires', 24, 36, 48, 48, '#64748b', null);
    f.zone('Utilités', 74, 8, 86, 24, '#6b7280', SG);
    f.zone('Parking personnel', 74, 30, 88, 56, '#94a3b8', null, { hauteur: 0.02 });
    f.zone('Stockage palettes', 32.5, 22, 36.5, 26, '#a8a29e', null, { hauteur: 0.03 });
    // Cloisons intérieures (avec ouvertures)
    f.mur(48, 8, 48, 14); f.mur(48, 17, 48, 24);
    f.mur(48, 24, 56, 24); f.mur(59, 24, 70, 24);
    f.mur(48, 24, 48, 28); f.mur(48, 32, 48, 36);
    f.mur(10, 36, 20, 36); f.mur(22, 36, 34, 36); f.mur(36, 36, 48, 36);
    f.mur(24, 36, 24, 48);
    f.mur(48, 36, 48, 40); f.mur(48, 42, 48, 48);
    // Portes
    f.porte('Porte sectionnelle atelier', 48, 15.5, 3, 3.5, 90);
    f.porte('Porte maintenance / magasin', 57.5, 24, 3, 3.5, 0);
    f.porte('Porte laboratoire', 21, 36, 1.2, 2.1, 0);
    f.porte('Porte bureaux', 35, 36, 1.2, 2.1, 0);
    f.porte('Porte bureaux / magasin', 48, 41, 1.2, 2.1, 90);
    f.porte('Entrée du personnel', 36, 48, 1.8, 2.4, 0);
    f.porte('Porte utilités', 74, 16, 2, 3, 90);
    f.porte('Porte de quai 1', 54, 48, 3, 4, 0); f.porte('Porte de quai 2', 60, 48, 3, 4, 0); f.porte('Porte de quai 3', 66, 48, 3, 4, 0);
    // Allées de circulation
    f.allee('Allée principale', 11, 19, 46, 19, 2.5);
    f.allee('Allée arrière ligne 2', 11, 30.5, 46, 30.5, 3);
    f.allee('Allée de liaison', 46.5, 9, 46.5, 35, 2);
    f.allee('Allée magasin 1', 49.5, 29.5, 69, 29.5, 3);
    f.allee('Allée magasin 2', 49.5, 35.5, 69, 35.5, 3);
    f.allee('Allée expéditions', 49.5, 42, 69, 42, 3.5);
    // Ligne de conditionnement L1
    f.machine('Remplisseuse rotative', 'Remplisseuse rotative', 16, 14, 4, 4, 2.6, { forme: 'cylindre', couleur: '#1d4ed8' });
    f.inst('convoyeur', 'Convoyeurs ligne L1', 19.5, 14, 3, 0.7, 0.9, '#475569', { equipementId: f.lie('Ligne de conditionnement L1') });
    f.machine('Étiqueteuse', 'Étiqueteuse', 23, 14, 3, 2.2, 2, { couleur: '#2563eb' });
    f.machine('Fardeleuse', 'Fardeleuse', 29.5, 14, 4.5, 2.6, 2.6, { couleur: '#2563eb' });
    f.inst('convoyeur', 'Convoyeur de sortie ligne 1', 38.5, 14, 11, 0.8, 0.9, '#475569', { equipementId: f.lie('Convoyeur de sortie ligne 1') });
    f.inst('armoire_electrique', 'Armoire électrique ligne L1', 34, 10.6, 1.6, 0.6, 2.1, '#9ca3af');
    // Ligne d'assemblage L2
    f.machine('Presse hydraulique 250 t', 'Presse hydraulique 250 t', 16, 24.5, 3.2, 2.6, 4.6, { couleur: '#1e40af' });
    f.inst('convoyeur', 'Convoyeur ligne L2', 23.25, 24.5, 9.5, 0.8, 0.9, '#475569', { equipementId: f.lie('Ligne d\'assemblage L2') });
    f.inst('poste_travail', 'Poste d\'assemblage 1', 21, 26.6, 1.6, 0.9, 0.95, '#a16207');
    f.inst('poste_travail', 'Poste d\'assemblage 2', 24.5, 26.6, 1.6, 0.9, 0.95, '#a16207');
    f.machine('Robot de palettisation', 'Robot de palettisation', 30, 24.5, 2.2, 2.2, 2.4, { forme: 'cylindre', couleur: '#ea580c' });
    f.inst('armoire_electrique', 'Armoire électrique ligne L2', 34, 28.4, 1.6, 0.6, 2.1, '#9ca3af');
    // Maintenance
    f.machine('Pont roulant 5 t', 'Pont roulant 5 t', 59, 16, 21, 0.8, 0.7, { z: 6.8, couleur: '#eab308' });
    f.machine('Poste à souder TIG', 'Poste à souder TIG', 66, 11, 0.8, 0.6, 1, { couleur: '#0891b2' });
    f.inst('poste_travail', 'Établi mécanique', 52, 9.5, 2, 0.8, 0.9, '#a16207');
    f.inst('poste_travail', 'Établi électrique', 56, 9.5, 2, 0.8, 0.9, '#a16207');
    f.inst('rack', 'Rack pièces détachées', 53, 22.6, 4, 1, 2.5, '#f97316');
    f.inst('armoire_electrique', 'TGBT – Tableau général basse tension', 69.3, 20, 3, 0.8, 2.2, '#6b7280', { rotation: 90 });
    // Logistique – magasin
    f.inst('rack', 'Rack A', 59, 26.6, 18, 1.1, 6, '#f97316');
    f.inst('rack', 'Rack B (double)', 59, 32.5, 18, 2.2, 6, '#f97316');
    f.inst('rack', 'Rack C', 59, 38.5, 18, 1.1, 6, '#f97316');
    f.machine('Chariot élévateur électrique n°1', 'Chariot élévateur électrique n°1', 52, 45, 1.2, 2.3, 2.2, { couleur: '#ea580c' });
    f.machine('Transpalette électrique', 'Transpalette électrique', 57, 45, 0.8, 1.8, 1.3, { couleur: '#ea580c' });
    f.machine('Chariot élévateur thermique n°2', 'Chariot élévateur thermique n°2', 64, 45, 1.2, 2.5, 2.2, { couleur: '#ea580c' });
    f.inst('quai', 'Quai de chargement 1', 54, 50, 3.5, 3.6, 1.2, '#64748b');
    f.inst('quai', 'Quai de chargement 2', 60, 50, 3.5, 3.6, 1.2, '#64748b');
    f.inst('quai', 'Quai de chargement 3', 66, 50, 3.5, 3.6, 1.2, '#64748b');
    // Qualité – laboratoire
    f.inst('poste_travail', 'Paillasse de laboratoire', 16, 44, 5, 0.9, 0.9, '#a8a29e');
    f.machine('Étuve de laboratoire', 'Étuve de laboratoire', 12.5, 46.6, 0.8, 0.8, 1.6, { couleur: '#7c3aed' });
    f.machine('Balance de précision', 'Balance de précision', 17, 44, 0.5, 0.5, 1.2, { couleur: '#7c3aed' });
    // Bureaux
    for (let i = 0; i < 4; i++) f.inst('bureau', `Bureau ${i + 1}`, 28 + i * 4, 40, 1.6, 0.8, 0.75, '#78716c');
    f.inst('bureau', 'Salle de réunion', 42, 44.5, 4, 1.6, 0.75, '#78716c');
    // Utilités
    f.machine('Compresseur d\'air GA 37', 'Compresseur d\'air GA 37', 77.5, 12, 1.9, 1.1, 1.6, { couleur: '#0284c7' });
    f.machine('Compresseur d\'air GA 22 (ancien)', 'Compresseur d\'air GA 22 (ancien)', 77.5, 15.5, 1.6, 1, 1.5, { couleur: '#0284c7' });
    f.inst('cuve', 'Ballon d\'air comprimé 3 000 L', 80.5, 10.5, 1.3, 1.3, 2.8, '#94a3b8', { forme: 'cylindre' });
    f.inst('chaudiere', 'Chaudière gaz 350 kW', 83.5, 12.5, 2, 1.5, 2, '#ef4444');
    f.inst('compresseur', 'Sécheur d\'air frigorifique', 80.5, 14, 0.9, 0.8, 1.2, '#38bdf8');
    f.inst('armoire_electrique', 'Armoire utilités', 85.5, 21, 2, 0.6, 2.1, '#9ca3af', { rotation: 90 });
    // Réseaux
    f.reseau('reseau_air', 'Réseau d\'air comprimé – sortie compresseurs', 78.5, 9.5, 72, 9.5, 4.5);
    f.reseau('reseau_air', 'Réseau d\'air comprimé – collecteur nord', 72, 9.5, 11, 9.5, 5.5);
    f.reseau('reseau_air', 'Réseau d\'air comprimé – antenne ouest', 11, 9.5, 11, 34.5, 5.5);
    f.reseau('reseau_air', 'Réseau d\'air comprimé – antenne maintenance', 60, 9.5, 60, 23, 5.5);
    f.reseau('reseau_eau', 'Réseau d\'eau glacée – lignes', 11.5, 34.5, 46, 34.5, 5);
    // Sécurité incendie et évacuation
    [[11, 10], [11, 35], [47, 20], [49.2, 9.2], [69, 46.5], [25, 47], [47, 47], [73.6, 9.5], [10.8, 47]].forEach(([x, y]) => f.extincteur(x, y));
    f.issue(10, 22, 90); f.issue(30, 8, 0); f.issue(70, 40, 90); f.issue(10, 42, 90); f.issue(62, 8, 0);
    // Toiture : groupe froid et centrale de traitement d'air
    f.machine('Groupe froid industriel', 'Groupe froid industriel', 40, 41, 4, 2.2, 2.4, { niveauId: 'toiture', couleur: '#0e7490' });
    f.machine('CTA atelier conditionnement', 'CTA atelier conditionnement', 22, 11, 4.5, 2, 2, { niveauId: 'toiture', couleur: '#0e7490' });
    // Textes
    f.texteObj('Entrée du personnel', 36, 50.5, 1);
    f.texteObj('Quais d\'expédition', 60, 53.5, 1.2);
    f.texteObj('Cour de service', 80, 27, 1);
    f.texteObj('Parking', 81, 43, 1.5);

    const plan = db.insert(ENTITE, {
      numero: numero(), nom: site.nom === 'Site principal' ? 'Atelier de production – Site principal' : `Atelier de production – ${site.nom}`,
      description: 'Implantation de l\'atelier de production : lignes de conditionnement et d\'assemblage, atelier de maintenance, magasin et quais, laboratoire qualité, bureaux et bâtiment des utilités (air comprimé, chaufferie). Réseaux d\'air comprimé et d\'eau glacée, moyens de lutte contre l\'incendie et issues de secours.',
      secteurId: site.id, dimensions: { largeur: 92, profondeur: 60 },
      niveaux: [{ id: 'rdc', nom: 'Rez-de-chaussée', altitude: 0, hauteur: 9 }, { id: 'toiture', nom: 'Toiture technique', altitude: 9, hauteur: 3 }],
      fond: null, vue: { x: 48, y: 30, z: 0, distance: 95, azimut: 25, elevation: 48, dessus: false },
      objets: f.objets, createdBy: auteurId, updatedBy: auteurId, version: 1,
    });
    rapports.push(`plan ${plan.numero} (${plan.objets.length} objets, ${plan.objets.filter((o) => o.equipementId != null).length} équipements liés)`);
  }

  // ----- Plan 2 : usine de Valréas (si le site existe) -----
  const val = db.findOne('secteurs', (s) => s.code === 'VAL');
  if (val) {
    if (db.findOne(ENTITE, (p) => Number(p.secteurId) === val.id)) rapports.push('plan de Valréas déjà présent');
    else {
      const f = fabrique(val.id);
      f.batiment('Atelier de Valréas', 5, 5, 45, 30, 7);
      f.zone('Production', 5, 5, 30, 30, '#2563eb', code('VAL-PROD'));
      f.zone('Maintenance', 30, 5, 45, 15, '#f59e0b', code('VAL-MAINT'));
      f.zone('Logistique', 30, 15, 45, 30, '#16a34a', code('VAL-LOG'));
      f.mur(30, 5, 30, 12); f.mur(30, 15, 30, 30); f.mur(30, 15, 36, 15); f.mur(39, 15, 45, 15);
      f.porte('Porte atelier', 30, 13.5, 3, 3.5, 90);
      f.allee('Allée centrale', 6, 17.5, 29, 17.5, 2.5);
      const eqVal = db.list('equipements', (e) => e.secteurId != null && siteDe(e.secteurId) === val.id).slice(0, 6);
      const positions = [[10, 11], [17, 11], [24, 11], [10, 24], [17, 24], [24, 24]];
      positions.forEach(([x, y], i) => {
        const e = eqVal[i];
        f.machine(e ? e.nom : `Machine ${i + 1}`, null, x, y, 3, 2, 2, { equipementId: e ? e.id : null });
      });
      f.inst('rack', 'Rack magasin', 38, 22, 10, 1.1, 5, '#f97316');
      f.inst('armoire_electrique', 'Armoire générale', 44.4, 8, 2, 0.6, 2.1, '#9ca3af', { rotation: 90 });
      f.inst('compresseur', 'Compresseur', 36, 8, 1.8, 1.1, 1.6, '#0284c7');
      [[6, 6], [29, 29], [44, 29], [31, 6]].forEach(([x, y]) => f.extincteur(x, y));
      f.issue(5, 17.5, 90); f.issue(45, 25, 90);
      f.texteObj('Usine de Valréas', 25, 2.5, 1.5);
      const plan = db.insert(ENTITE, {
        numero: numero(), nom: `Atelier – ${val.nom}`, description: 'Implantation simplifiée de l\'atelier de Valréas.', secteurId: val.id,
        dimensions: { largeur: 50, profondeur: 35 }, niveaux: [{ id: 'rdc', nom: 'Rez-de-chaussée', altitude: 0, hauteur: 7 }], fond: null,
        vue: { x: 25, y: 17.5, z: 0, distance: 60, azimut: 20, elevation: 50, dessus: false }, objets: f.objets, createdBy: auteurId, updatedBy: auteurId, version: 1,
      });
      rapports.push(`plan ${plan.numero} (Valréas, ${plan.objets.length} objets)`);
    }
  }
  return rapports.join(' ; ');
}

module.exports = { nom, register, seedDemo, TYPES, CATEGORIES };
