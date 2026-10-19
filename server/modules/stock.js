'use strict';
/**
 * Module Stock & pièces détachées.
 *
 *  - Articles (pièces de rechange, consommables, lubrifiants…) : code automatique, catégorie, unité,
 *    seuil minimum, quantité de réapprovisionnement, emplacement, prix (coût unitaire moyen pondéré),
 *    fournisseur, équipements compatibles, magasin (secteur), champs personnalisés.
 *  - Mouvements de stock : entrée, sortie (éventuellement imputée à un OT), inventaire (quantité
 *    constatée → écart), retour (annulation d'une sortie). Chaque mouvement enregistre
 *    quantiteAvant / quantiteApres. La quantité d'un article ne se modifie QUE par un mouvement.
 *  - Alertes de réapprovisionnement, valorisation, exports CSV.
 *
 * Routes : /api/articles (CRUD + mouvements), /api/mouvements, /api/mouvements/:id/annuler,
 *          /api/stock-alertes, /api/stock-valorisation, /api/stock-references,
 *          /api/articles-export, /api/mouvements-export.
 * Services publiés : ctx.services.stock = { sortir, entrer, annulerSortie, inventorier, … }. Un traitement en
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

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
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
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
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
  const libelleListe = (liste, code) => { const it = ctx.liste(liste).find((x) => x.code === code); return it ? it.label : (code || ''); };
  const statutsOt = () => ctx.liste('statutsOT');
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
  function references() {
    return {
      fournisseurs: new Map(db.list('fournisseurs').map((f) => [f.id, f])),
      users: new Map(db.list('users').map((u) => [u.id, `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login])),
      ot: new Map(db.list('ot').map((o) => [o.id, o])),
      articles: new Map(db.list(ENTITE).map((a) => [a.id, a])),
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
    return Object.assign({}, a, {
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

  function enrichirMouvement(m, refs, req) {
    const a = refs.articles.get(Number(m.articleId));
    const o = m.otId != null ? refs.ot.get(Number(m.otId)) : null;
    const otMasque = !!(o && !otVisible(req, o));
    const f = m.fournisseurId != null ? refs.fournisseurs.get(Number(m.fournisseurId)) : null;
    return Object.assign({}, m, {
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
    if (q.equipementId) { const e = idRef(q.equipementId, 'Équipement'); rows = rows.filter((a) => (a.equipementIds || []).map(Number).includes(e)); }
    if (q.secteurId) {
      if (q.secteurId === 'aucun') rows = rows.filter((a) => a.secteurId == null || a.secteurId === '');
      else { const ids = perms.secteursDescendants(db, [idRef(q.secteurId, 'Secteur')]); rows = rows.filter((a) => a.secteurId != null && ids.includes(Number(a.secteurId))); }
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
    const refs = references();
    const termes = normaliser(q.recherche).split(/\s+/).filter(Boolean);
    let out = rows.sort(parDateDesc).map((m) => enrichirMouvement(m, refs, req));
    if (termes.length) out = out.filter((m) => { const t = normaliser([m.articleCode, m.articleDesignation, m.motif, m.otNumero, m.userNom, m.fournisseurNom].join(' ')); return termes.every((x) => t.includes(x)); });
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

    // Équipements compatibles (les compatibilités hors de la portée de l'utilisateur sont conservées)
    if (b.equipementIds !== undefined || !existant) {
      const src = b.equipementIds == null ? [] : b.equipementIds;
      if (!Array.isArray(src)) throw new HttpError(400, 'Équipements compatibles : liste attendue');
      if (src.length > 500) throw new HttpError(400, 'Équipements compatibles : 500 au maximum');
      const ids = [];
      for (const v of src) {
        const id = idRef(v, 'Équipement compatible');
        if (id == null) continue;
        const e = db.get('equipements', id);
        if (!e || !equipementVisible(req, e)) throw new HttpError(400, `Équipement compatible introuvable (#${id})`);
        if (!ids.includes(id)) ids.push(id);
      }
      if (existant) {
        for (const id of (existant.equipementIds || []).map(Number)) {
          const e = db.get('equipements', id);
          if (e && !equipementVisible(req, e) && !ids.includes(id)) ids.push(id);
        }
      }
      out.equipementIds = ids;
    }

    // Magasin / secteur
    let secteurId = idRef(pris('secteurId'), 'Secteur');
    if (secteurId != null && !db.get('secteurs', secteurId) && existant && Number(existant.secteurId) === secteurId) secteurId = null; // secteur supprimé
    if (secteurId != null) {
      if (!db.get('secteurs', secteurId)) throw new HttpError(400, 'Secteur introuvable');
      const change = !existant || Number(existant.secteurId) !== secteurId;
      if (change && req && req.perms && req.perms.portee === 'secteurs' && !req.perms.estAdmin && !req.perms.secteurIds.includes(secteurId)) {
        throw new HttpError(403, 'Vous ne pouvez rattacher un article qu\'à l\'un de vos secteurs');
      }
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
  function enregistrer({ articleId, type, quantite, motif, prixUnitaire, prixMouvement, fournisseurId, otId, userId, req, origineId, refuserInactif, silencieux }) {
    if (!TYPES_MOUVEMENT[type]) throw new HttpError(400, 'Type de mouvement invalide');
    const article = db.get(ENTITE, articleId);
    if (!article) throw new HttpError(404, 'Article introuvable');
    if (refuserInactif && article.actif === false) throw new HttpError(400, `L'article « ${article.designation} » est désactivé : réactivez-le avant d'enregistrer une ${type === 'entree' ? 'entrée' : 'sortie'}`);
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
      mouvementOrigineId: origineId == null ? null : origineId, annuleParId: null,
      createdBy: userId == null ? null : Number(userId),
    });

    const ecartTxt = `${apres - avant >= 0 ? '+' : ''}${frNombre(apres - avant)}`;
    const quoi = {
      entree: `entrée de ${frNombre(q)} ${unite}`, sortie: `sortie de ${frNombre(q)} ${unite}`, retour: `retour en stock de ${frNombre(q)} ${unite}`,
      inventaire: `inventaire, quantité constatée ${frNombre(q)} ${unite} (écart ${ecartTxt})`,
    }[type].replace(/\s+/g, ' ').trim();
    if (!silencieux) ctx.audit(req || pseudoReq(userId), 'mouvement', ENTITE, article.id, `${article.code || '#' + article.id} ${article.designation} : ${quoi} — stock ${frNombre(avant)} → ${frNombre(apres)}${motifTexte ? ' — ' + motifTexte : ''}`);

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
      articleId: Number(m.articleId), type: 'retour', quantite: m.quantite, userId, req, otId: m.otId, origineId: m.id, prixMouvement: num(m.prixUnitaire),
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
    const refs = references();
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
    const equipements = new Map(db.list('equipements').map((e) => [e.id, e]));
    r.ots = Array.from(parOt.values()).map((x) => {
      const o = refs.ot.get(x.otId);
      if (o && !ctx.canSee(req, o)) return null;
      const e = o && o.equipementId != null ? equipements.get(Number(o.equipementId)) : null;
      return Object.assign(x, {
        existe: !!o, numero: o ? o.numero || '' : '', titre: o ? o.titre || '' : '(ordre de travail supprimé)', statut: o ? o.statut : null,
        typeCode: o ? o.typeCode || null : null, equipementId: e ? e.id : null, equipementNom: e ? e.nom || '' : '', technicienId: o ? o.technicienId || null : null,
      });
    }).filter(Boolean).sort((p, q) => String(q.derniereDate).localeCompare(String(p.derniereDate)));

    // Équipements compatibles (selon la portée)
    r.equipements = (a.equipementIds || []).map((id) => equipements.get(Number(id))).filter((e) => e && equipementVisible(req, e))
      .map((e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || '', secteurId: e.secteurId == null ? null : e.secteurId, typeCode: e.typeCode || null, etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null, localisation: e.localisation || '', actif: e.actif !== false }))
      .sort((p, q) => p.nom.localeCompare(q.nom, 'fr'));
    r.stats = statistiques(tous, a);
    r.stockNegatifAutorise = !!wf().stockNegatif;
    return r;
  }

  // ----- Routes : articles ---------------------------------------------------------------
  router.get('/api/articles', async (req) => {
    const refs = references();
    const derniers = derniersMouvements();
    return filtrerArticles(req, req.query).map((a) => resume(a, refs, derniers));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/articles-export', async (req, res) => {
    const refs = references();
    const champs = ((ctx.config().champsPersonnalises || {})[ENTITE]) || [];
    const equipements = new Map(db.list('equipements').map((e) => [e.id, e]));
    const entetes = ['Code', 'Désignation', 'Catégorie', 'Unité', 'Quantité', 'Seuil minimum', 'Sous le seuil', 'Quantité à commander', 'Emplacement', 'Prix unitaire', 'Valeur', 'Fournisseur', 'Référence fournisseur', 'Magasin / secteur', 'Équipements compatibles', 'Actif', 'Description'].concat(champs.map((c) => c.label));
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    const rows = filtrerArticles(req, req.query);
    for (const a of rows) {
      const r = resume(a, refs);
      const s = r.secteurId != null ? db.get('secteurs', r.secteurId) : null;
      lignes.push([
        r.code, r.designation, libelleListe('categoriesArticles', r.categorieCode), libelleListe('unites', r.uniteCode), csvNombre(r.quantite), csvNombre(r.seuilMin),
        r.actif && r.sousSeuil ? 'Oui' : 'Non', csvNombre(r.sousSeuil ? r.quantiteACommander : 0), r.emplacement, csvNombre(r.prixUnitaire), csvNombre(r.valeur), r.fournisseurNom, r.referenceFournisseur,
        s ? s.nom : '', r.equipementIds.map((id) => equipements.get(id)).filter(Boolean).map((e) => `${e.numero ? e.numero + ' ' : ''}${e.nom}`).join(', '), r.actif ? 'Oui' : 'Non', r.description,
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
    ctx.audit(req, 'creation', ENTITE, a.id, `Article ${a.code} — ${a.designation}`);
    if (quantiteInitiale > 0) {
      const r = enregistrer({ articleId: a.id, type: 'inventaire', quantite: quantiteInitiale, userId: req.user.id, req, motif: 'Stock initial à la création de l\'article' });
      a = r.article;
    }
    return detail(req, a);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/articles/:id', async (req) => {
    const existant = articleVisible(req, req.params.id);
    const b = objet(req.body);
    if (b.quantite !== undefined && b.quantite !== null && b.quantite !== '' && arrondi(num(b.quantite)) !== arrondi(num(existant.quantite))) {
      throw new HttpError(400, 'La quantité en stock ne se modifie pas directement : enregistrez un mouvement (entrée, sortie ou inventaire)');
    }
    const data = validerArticle(req, b, existant);
    const changes = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(existant[k] === undefined ? null : existant[k]));
    const a = db.update(ENTITE, existant.id, data);
    let action = 'modification';
    if (changes.length === 1 && changes[0] === 'actif') action = a.actif === false ? 'desactivation' : 'reactivation';
    ctx.audit(req, action, ENTITE, a.id, `Article ${a.code} — ${a.designation}${changes.length ? ' (' + changes.join(', ') + ')' : ''}`);
    return detail(req, a);
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
    const r = enregistrer({ articleId: a.id, type, quantite: b.quantite, motif: b.motif || (ot ? `${/^OT/i.test(String(ot.numero || '')) ? '' : 'OT '}${ot.numero || '#' + ot.id} — ${ot.titre || ''}` : ''), prixUnitaire, fournisseurId, otId, userId: req.user.id, req, refuserInactif: type !== 'inventaire' });
    if (ot) imputerOt(ot, r.mouvement, r.article, req);
    const refs = references();
    return { mouvement: enrichirMouvement(r.mouvement, refs, req), article: resume(r.article, refs) };
  }, { perm: [MODULE, 'modifier'] });

  router.get('/api/mouvements', async (req) => {
    const rows = filtrerMouvements(req, req.query);
    const limite = Math.min(Math.max(Number(req.query.limite) || 5000, 1), 50000);
    return rows.slice(0, limite);
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/mouvements-export', async (req, res) => {
    const rows = filtrerMouvements(req, req.query);
    const entetes = ['Date', 'Type', 'Code article', 'Désignation', 'Quantité', 'Unité', 'Écart', 'Stock avant', 'Stock après', 'Prix unitaire', 'Valeur', 'OT', 'Fournisseur', 'Motif', 'Utilisateur'];
    const lignes = ['\ufeff' + entetes.map(csvEscape).join(';')];
    for (const m of rows) {
      const d = new Date(m.date);
      const date = Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('fr-FR')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      lignes.push([date, TYPES_MOUVEMENT[m.type] || m.type, m.articleCode, m.articleDesignation, csvNombre(m.quantite), m.uniteCode, csvNombre(m.ecart), csvNombre(m.quantiteAvant), csvNombre(m.quantiteApres), csvNombre(m.prixUnitaire), csvNombre(m.valeur), m.otMasque ? 'Hors périmètre' : m.otNumero, m.fournisseurNom, m.motif, m.userNom].map(csvEscape).join(';'));
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
    const refs = references();
    return { mouvement: enrichirMouvement(r.mouvement, refs, req), article: resume(r.article, refs) };
  }, { perm: [MODULE, 'modifier'] });

  // ----- Routes : alertes, valorisation, références ---------------------------------------
  function alertes(req) {
    const refs = references();
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
      .map((e) => ({ id: e.id, numero: e.numero || '', nom: e.nom || '', secteurId: e.secteurId == null ? null : e.secteurId, actif: e.actif !== false }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const otOuverts = ctx.scope(req, db.list('ot')).filter((o) => !otEstFinal(o))
      .map((o) => ({ id: o.id, numero: o.numero || '', titre: o.titre || '', statut: o.statut, equipementId: o.equipementId == null ? null : o.equipementId }))
      .sort((a, b) => String(b.numero).localeCompare(String(a.numero), 'fr', { numeric: true }));
    const emplacements = Array.from(new Set(ctx.scope(req, db.list(ENTITE)).map((a) => a.emplacement).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr'));
    return { fournisseurs, equipements, otOuverts, emplacements, stockNegatif: !!wf().stockNegatif };
  }, { perm: [MODULE, 'voir'] });

  // ----- Services publiés -----------------------------------------------------------------
  // `silencieux: true` (traitement en masse) : mouvement enregistré sans entrée de journal unitaire ; l'appelant
  // écrit une entrée récapitulative, le détail restant dans mouvementsStock.
  ctx.services.stock = {
    /** Sortie de stock (ex. pièce consommée sur un OT). Lève HttpError 400 « Stock insuffisant… » si nécessaire. */
    sortir({ articleId, quantite, otId, userId, motif, silencieux } = {}) {
      return enregistrer({ articleId: idRef(articleId, 'Article'), type: 'sortie', quantite, otId: otId == null || otId === '' ? null : idRef(otId, 'Ordre de travail'), userId, motif, refuserInactif: true, silencieux: !!silencieux });
    },
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
      hist: [[9, 'sortie', 4, 'Révision des galets de l\'étiqueteuse', 'jbernard']] },
    { designation: 'Roulement à billes 6312-2Z/C3', cat: 'mecanique', u: 'u', q: 2, seuil: 2, qc: 4, empl: 'Magasin central — A1 — Étagère 4', pu: 64.5, f: SKF, ref: '6312-2Z/C3', eqs: equipements('Remplisseuse rotative'),
      description: 'Roulement moteur principal de la remplisseuse, côté accouplement (60 × 130 × 31 mm, jeu C3).',
      hist: [[33, 'sortie', 2, 'Remplacement du palier côté accouplement (analyse vibratoire)', 'kleroy']] },
    { designation: 'Roulement à billes 6310-2Z/C3', cat: 'mecanique', u: 'u', q: 3, seuil: 2, qc: 4, empl: 'Magasin central — A1 — Étagère 4', pu: 48.2, f: SKF, ref: '6310-2Z/C3', eqs: equipements('Remplisseuse rotative'),
      description: 'Roulement moteur principal de la remplisseuse, côté ventilateur (50 × 110 × 27 mm, jeu C3).', hist: [] },
    { designation: 'Courroie crantée HTD 1400-8M-30', cat: 'mecanique', u: 'u', q: 4, seuil: 2, qc: 3, empl: 'Magasin central — A2 — Crochets', pu: 46.8, f: SKF, ref: 'PHG 1400-8M-30', eqs: equipements('Convoyeur de sortie ligne 1'),
      description: 'Courroie synchrone profil HTD, pas 8 mm, longueur primitive 1 400 mm, largeur 30 mm.', hist: [] },
    { designation: 'Cartouche filtre à air compresseur GA 37', cat: 'pneumatique', u: 'u', q: 5, seuil: 2, qc: 4, empl: 'Magasin central — B1 — Étagère 1', pu: 89, f: fournisseur('Atlas Copco', /atlas/i), ref: '1613 9001 00', eqs: equipements('Compresseur d\'air GA 37'),
      description: 'Élément filtrant d\'aspiration d\'origine constructeur (remplacement toutes les 4 000 h).',
      hist: [[70, 'entree', 4, 'Réception de la commande CDE-2026-0142', 'mdupont', 91.5]] },
    { designation: 'Filtre plissé F7 592 × 592 × 534 mm', cat: 'consommable', u: 'u', q: 8, seuil: 4, qc: 8, empl: 'Magasin central — C3 — Palette', pu: 42.5, f: null, ref: 'F7-592-592-534-8P', eqs: equipements('CTA atelier conditionnement'),
      description: 'Filtre à poches F7 (ePM1 60 %), 8 poches, cadre galvanisé.',
      hist: [[56, 'sortie', 8, 'Remplacement trimestriel des filtres de la CTA', 'kleroy'], [40, 'entree', 8, 'Réception de la commande CDE-2026-0171', 'mdupont', 42.5]] },
    { designation: 'Huile hydraulique Azolla ZS 46', cat: 'lubrifiant', u: 'l', q: 120, seuil: 40, qc: 208, empl: 'Local lubrifiants — Fût n°2', pu: 3.85, f: TOTAL, ref: 'AZOLLA ZS 46 — fût 208 L', eqs: equipements('Presse hydraulique 250 t', 'Chariot élévateur thermique n°2'),
      description: 'Huile hydraulique anti-usure HM, grade ISO VG 46.',
      hist: [[44, 'sortie', 25, 'Appoint du réservoir de la presse 250 t (fuite à surveiller)', 'jbernard'], [24, 'entree', 104, 'Réception de la commande CDE-2026-0198 (demi-fût)', 'mdupont', 3.79]] },
    { designation: 'Graisse lithium Multis EP 2 (cartouche 400 g)', cat: 'lubrifiant', u: 'u', q: 2, seuil: 6, qc: 12, empl: 'Local lubrifiants — Armoire 1', pu: 6.4, f: TOTAL, ref: 'MULTIS EP 2 — 400 g', eqs: equipements('Robot de palettisation', 'Convoyeur de sortie ligne 1', 'Pont roulant 5 t'),
      description: 'Graisse multi-usages au lithium, extrême pression, NLGI 2.',
      hist: [[27, 'sortie', 6, 'Graissage des axes 1 à 4 du robot et des paliers des convoyeurs', 'jbernard']] },
    { designation: 'Kit joints de vérin hydraulique (tige Ø 40 à 80)', cat: 'hydraulique', u: 'lot', q: 6, seuil: 2, qc: 4, empl: 'Magasin central — B2 — Tiroir 5', pu: 38, f: SKF, ref: 'SKF-KIT-VH-4080', eqs: equipements('Presse hydraulique 250 t', 'Chariot élévateur thermique n°2'),
      description: 'Jeu de joints de tige, racleurs et bagues de guidage pour vérins hydrauliques.', hist: [] },
    { designation: 'Contacteur TeSys D 18 A — bobine 24 V CC', cat: 'electrique', u: 'u', q: 1, seuil: 2, qc: 3, empl: 'Magasin central — D1 — Bac 3', pu: 72.3, f: SCHNEIDER, ref: 'LC1D18BD', eqs: equipements('Fardeleuse', 'Remplisseuse rotative'),
      description: 'Contacteur tripolaire 18 A AC-3, 1 NO + 1 NF, bobine 24 V CC.',
      hist: [[12, 'sortie', 2, 'Remplacement des contacteurs du four de rétraction (fardeleuse)', 'kleroy']] },
    { designation: 'Disjoncteur moteur GV2ME10 (4 à 6,3 A)', cat: 'electrique', u: 'u', q: 3, seuil: 1, qc: 2, empl: 'Magasin central — D1 — Bac 4', pu: 61, f: SCHNEIDER, ref: 'GV2ME10', eqs: equipements('Convoyeur de sortie ligne 1', 'Étiqueteuse'),
      description: 'Disjoncteur magnéto-thermique de protection moteur, réglage 4 à 6,3 A.', hist: [] },
    { designation: 'Fusibles cylindriques 10 × 38 gG 10 A (boîte de 10)', cat: 'electrique', u: 'lot', q: 8, initial: 9, seuil: 3, qc: 5, empl: 'Magasin central — D2 — Bac 1', pu: 9.8, f: REXEL, ref: 'DF2CA10', eqs: [],
      description: 'Cartouches fusibles gG 500 V, pouvoir de coupure 120 kA.',
      hist: [[7, 'inventaire', 8, 'Inventaire tournant zone D (une boîte manquante)', 'mdupont']] },
    { designation: 'Capteur inductif M18 PNP 8 mm', cat: 'electrique', u: 'u', q: 4, seuil: 1, qc: 2, empl: 'Magasin central — D3 — Bac 2', pu: 58.9, f: SCHNEIDER, ref: 'XS618B1PAL2', eqs: equipements('Remplisseuse rotative', 'Étiqueteuse'),
      description: 'Détecteur de proximité inductif M18, portée 8 mm, sortie PNP NO, connecteur M12.',
      hist: [[25, 'sortie', 1, 'Remplacement du détecteur de présence bouteille (étiqueteuse)', 'jbernard'], [25, 'retour', 1, 'Pièce non utilisée : défaut de câblage, capteur d\'origine conservé', 'jbernard']] },
    { designation: 'Électrovanne 5/2 G1/4 — 24 V CC', cat: 'pneumatique', u: 'u', q: 2, seuil: 1, qc: 2, empl: 'Magasin central — B1 — Étagère 3', pu: 112, f: null, ref: 'SY5120-5LZ-01', eqs: equipements('Robot de palettisation', 'Fardeleuse'),
      description: 'Distributeur pneumatique monostable 5/2, raccordement G1/4, bobine 24 V CC.', hist: [] },
    { designation: 'Câble souple H07RN-F 3G2,5 mm²', cat: 'electrique', u: 'm', q: 85, seuil: 25, qc: 100, empl: 'Magasin logistique — Touret n°1', pu: 2.35, f: REXEL, ref: 'H07RNF3G2,5', eqs: equipements('Transpalette électrique'), secteur: LOG,
      description: 'Câble souple caoutchouc pour alimentation d\'engins mobiles et prolongateurs.',
      hist: [[28, 'sortie', 15, 'Remplacement du câble du chargeur de batterie du transpalette', 'kleroy']] },
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
      equipementIds: d.eqs, secteurId: d.secteur == null ? null : d.secteur, actif: true, champs: {}, createdBy: admin ? admin.id : null,
    });
    const brutA = colArticles.find((x) => x.id === a.id);
    if (brutA) brutA.createdAt = jour(INITIAL, '07:00');

    // Inventaire initial puis historique, dans l'ordre chronologique
    const mvts = [[INITIAL, 'inventaire', initial, 'Inventaire initial (reprise du stock à la mise en service de la GMAO)', 'mdupont', d.pu]].concat(d.hist);
    let stock = 0; let derniereSortie = null; let derniereDate = null;
    for (const [n, type, qte, motif, login, prix] of mvts) {
      const avant = stock;
      stock = arrondi(type === 'inventaire' ? qte : stock + (type === 'entree' || type === 'retour' ? qte : -qte));
      const date = jour(n, type === 'retour' ? '15:30' : (type === 'entree' ? '10:30' : (n === INITIAL ? '07:30' : '08:45')));
      const m = db.insert(MVT, {
        articleId: a.id, type, quantite: qte, quantiteAvant: arrondi(avant), quantiteApres: stock, ecart: arrondi(stock - avant), date,
        userId: userId(login), otId: null, motif, prixUnitaire: prix != null ? prix : d.pu, fournisseurId: type === 'entree' ? (d.f == null ? null : d.f) : null,
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
  return `${defs.length} articles (${sousSeuil} sous le seuil), ${nbMvt} mouvements de stock (dont ${nbMvt - defs.length} sur les 60 derniers jours)`;
}

module.exports = { nom, register, seedDemo, estSousSeuil, quantiteACommander, valeurArticle, csvEscape };
