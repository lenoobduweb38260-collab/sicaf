'use strict';
/**
 * Module Achats & factures (clé de droits « achats »), multi-site.
 *
 *  - Commandes fournisseurs (`commandes`) : numérotation automatique, lignes (article du stock ou ligne
 *    libre, imputation éventuelle à un OT), totaux HT / TVA / TTC calculés par le serveur, circuit
 *    brouillon → à valider (au-delà du seuil config.achats.seuilValidationHT) → validée → envoyée →
 *    reçue partiellement / reçue, annulation, solde d'un reliquat ; réceptions partielles avec entrée
 *    en stock automatique (config.achats.entreeStockAReception) ; documents joints ; brouillons créés
 *    depuis les alertes de stock (regroupés par fournisseur).
 *  - Factures fournisseurs (`factures`) : numéro interne + numéro fournisseur (unique par fournisseur),
 *    échéance (config.achats.delaiPaiementJours), contrôle TTC = HT + TVA, rapprochement avec la commande
 *    (commandé / reçu / déjà facturé), circuit reçue → à valider → bon à payer → payée, litige,
 *    annulation ; pièce jointe PDF / image (≤ 10 Mo) ; commentaires ; échéancier et retards.
 *  - Tableau de bord (engagé, facturé, payé, à payer, en retard, par mois / fournisseur / catégorie / site),
 *    coûts d'achats par OT, exports CSV (commandes, lignes, factures, échéancier), notifications.
 *
 * Services publiés : ctx.services.achats = { facturesPourOt(otId), totalFactureOt(otId), totauxFacturesOt(otId),
 *   commandesPourOt(otId), verifierEcheances(options) }
 * Événements émis : 'achats:commandeRecue' ({ commande, reception, complete }), 'achats:facturePayee' ({ facture }),
 *   'achats:commandeValidee' ({ commande }), 'achats:factureValidee' ({ facture }).
 */
const nom = 'Achats & factures';
const MODULE = 'achats';
const CMD = 'commandes';
const FAC = 'factures';
const TAILLE_MAX_DOC = 10 * 1024 * 1024; // 10 Mo par pièce jointe
const MAX_DOCS = 20;
const MAX_LIGNES = 200;
const MAX_COMMENTAIRES = 500;
const TOLERANCE = 0.01; // € : tolérance d'arrondi (TTC = HT + TVA, rapprochement)
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTERVALLE_VERIFICATION_MS = 60 * 60 * 1000;

/** Codes de workflow (fixes). Libellés, couleurs et caractère « final » : listes statutsCommande / statutsFacture. */
const SC = { brouillon: 'brouillon', aValider: 'a_valider', validee: 'validee', envoyee: 'envoyee', partielle: 'partielle', recue: 'recue', annulee: 'annulee' };
const SF = { recue: 'recue', aValider: 'a_valider', validee: 'validee', payee: 'payee', litige: 'litige', annulee: 'annulee' };
const FINAUX_CMD_DEFAUT = ['recue', 'annulee'];
const FINAUX_FAC_DEFAUT = ['payee', 'annulee'];
/** Modes de paiement (repli si aucune liste « modesPaiement » n'est configurée). */
const MODES_PAIEMENT_DEFAUT = [
  { code: 'virement', label: 'Virement bancaire', ordre: 1 },
  { code: 'prelevement', label: 'Prélèvement', ordre: 2 },
  { code: 'cheque', label: 'Chèque', ordre: 3 },
  { code: 'lcr', label: 'Effet de commerce (LCR)', ordre: 4 },
  { code: 'carte', label: 'Carte bancaire', ordre: 5 },
  { code: 'compensation', label: 'Compensation avec un avoir', ordre: 6 },
  { code: 'autre', label: 'Autre', ordre: 7 },
];
/** Types de pièces jointes acceptés. */
const TYPES_FACTURE = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TYPES_COMMANDE = TYPES_FACTURE.concat([
  'text/plain', 'text/csv', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
]);

// ----- Utilitaires purs -----------------------------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** Arrondi décimal exact (1,005 → 1,01). */
function arrondi(n, d = 2) {
  const x = Number(n);
  if (!Number.isFinite(x) || Math.abs(x) < 1e-12) return 0;
  const signe = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const s = String(a);
  const r = /e/i.test(s) ? Math.round(a * 10 ** d) / 10 ** d : Number(Math.round(Number(s + 'e' + d)) + 'e-' + d);
  return signe * r;
}
const pad = (n) => String(n).padStart(2, '0');
function jourLocal(d) { const x = d || new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function ajouterJours(jour, n) { const d = new Date(`${jour}T12:00:00`); d.setDate(d.getDate() + Number(n || 0)); return jourLocal(d); }
function joursEntre(a, b) { return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000); }
function moisDe(jour) { return String(jour || '').slice(0, 7); }
/** Semaine ISO d'une date AAAA-MM-JJ : { cle, annee, numero, debut (lundi), fin (dimanche) }. */
function semaineISO(jour) {
  const d = new Date(`${jour}T12:00:00`);
  const jourSem = (d.getDay() + 6) % 7; // lundi = 0
  const lundi = new Date(d); lundi.setDate(d.getDate() - jourSem);
  const jeudi = new Date(lundi); jeudi.setDate(lundi.getDate() + 3);
  const annee = jeudi.getFullYear();
  const premierJeudi = new Date(annee, 0, 4, 12);
  const lundiS1 = new Date(premierJeudi); lundiS1.setDate(premierJeudi.getDate() - ((premierJeudi.getDay() + 6) % 7));
  const numero = 1 + Math.round((lundi - lundiS1) / (7 * 86400000));
  const dimanche = new Date(lundi); dimanche.setDate(lundi.getDate() + 6);
  return { cle: `${annee}-S${pad(numero)}`, annee, numero, debut: jourLocal(lundi), fin: jourLocal(dimanche) };
}
const normaliser = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function csvEscape(v) {
  let s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  // Protection contre l'injection de formules dans les tableurs
  if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s.replace(',', '.')))) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvNombre = (n, d = 2) => (n == null || n === '' ? '' : String(arrondi(n, d)).replace('.', ','));
const csvDate = (j) => (j && RE_DATE.test(String(j).slice(0, 10)) ? String(j).slice(0, 10).split('-').reverse().join('/') : '');

/** Totaux d'une liste de lignes { quantite, prixUnitaireHT, tauxTVA } (TVA arrondie par ligne). */
function calculerTotaux(lignes) {
  let ht = 0; let tva = 0;
  for (const l of lignes || []) {
    const lht = arrondi(num(l.quantite) * num(l.prixUnitaireHT));
    ht += lht;
    tva += arrondi((lht * num(l.tauxTVA)) / 100);
  }
  ht = arrondi(ht); tva = arrondi(tva);
  return { ht, tva, ttc: arrondi(ht + tva) };
}

/** Signature binaire (« nombres magiques ») cohérente avec le type annoncé. */
function signatureValide(type, buf) {
  const h = buf.subarray(0, 12);
  const commence = (...octets) => octets.every((o, i) => h[i] === o);
  switch (type) {
    case 'application/pdf': return buf.subarray(0, 1024).toString('latin1').includes('%PDF-');
    case 'image/png': return commence(0x89, 0x50, 0x4e, 0x47);
    case 'image/jpeg': return commence(0xff, 0xd8, 0xff);
    case 'image/gif': return commence(0x47, 0x49, 0x46, 0x38);
    case 'image/webp': return commence(0x52, 0x49, 0x46, 0x46) && h.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/msword': case 'application/vnd.ms-excel': return commence(0xd0, 0xcf, 0x11, 0xe0);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.oasis.opendocument.text':
    case 'application/vnd.oasis.opendocument.spreadsheet': return commence(0x50, 0x4b);
    case 'text/plain': case 'text/csv': return !buf.subarray(0, 4096).includes(0);
    default: return false;
  }
}
const estImage = (type) => /^image\/(png|jpeg|gif|webp)$/.test(String(type || ''));

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  // ----- Configuration & listes ----------------------------------------------------------------
  const DEFAUTS_CFG = { tauxTVA: 20, seuilValidationHT: 1000, delaiPaiementJours: 30, entreeStockAReception: true, alerteEcheanceJours: 7 };
  const cfgAchats = () => Object.assign({}, DEFAUTS_CFG, ctx.config().achats || {});
  const can = (req, action) => perms.can(req.perms, MODULE, action);
  const libelle = (liste, code) => { const it = ctx.liste(liste).find((x) => x.code === code); return it ? it.label : (code == null ? '' : String(code)); };
  function finaux(liste, defaut) { const f = ctx.liste(liste).filter((x) => x.final).map((x) => x.code); return new Set(f.length ? f : defaut); }
  const finauxCmd = () => finaux('statutsCommande', FINAUX_CMD_DEFAUT);
  const finauxFac = () => finaux('statutsFacture', FINAUX_FAC_DEFAUT);
  function modesPaiement() { const l = ctx.liste('modesPaiement'); return l.length ? l : MODES_PAIEMENT_DEFAUT.slice(); }
  const libModePaiement = (code) => { const m = modesPaiement().find((x) => x.code === code); return m ? m.label : (code || ''); };

  // ----- Validation des entrées -----------------------------------------------------------------
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
  function nombre(v, label, { requis = false, min = 0, max = 1e9, strictPositif = false, defaut = null } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis) throw new HttpError(400, `${label} : champ obligatoire`);
      return defaut;
    }
    if (typeof v !== 'number' && typeof v !== 'string') throw new HttpError(400, `${label} : nombre attendu`);
    const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} : nombre attendu`);
    if (strictPositif && !(n > 0)) throw new HttpError(400, `${label} : la valeur doit être supérieure à 0`);
    if (min != null && n < min) throw new HttpError(400, `${label} : la valeur doit être supérieure ou égale à ${String(min).replace('.', ',')}`);
    if (n > max) throw new HttpError(400, `${label} : valeur trop grande`);
    return n;
  }
  function idRef(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function dateJour(v, label, { requis = false, defaut = null } = {}) {
    if (v === undefined || v === null || v === '') {
      if (requis && defaut == null) throw new HttpError(400, `${label} : champ obligatoire`);
      return defaut;
    }
    const s = String(v).slice(0, 10);
    if (!RE_DATE.test(s) || Number.isNaN(new Date(`${s}T12:00:00`).getTime()) || jourLocal(new Date(`${s}T12:00:00`)) !== s) {
      throw new HttpError(400, `${label} : date invalide (format AAAA-MM-JJ attendu)`);
    }
    return s;
  }
  function dateFiltre(v, label) {
    if (v == null || v === '') return null;
    if (!RE_DATE.test(String(v))) throw new HttpError(400, `${label} : date invalide (format AAAA-MM-JJ attendu)`);
    return String(v);
  }
  function codeListe(liste, valeur, label, defaut) {
    const l = ctx.liste(liste);
    if (valeur == null || valeur === '') {
      if (defaut && l.some((x) => x.code === defaut)) return defaut;
      return l.length ? l[0].code : null;
    }
    if (typeof valeur !== 'string' || (l.length && !l.some((x) => x.code === valeur))) throw new HttpError(400, `${label} invalide : « ${valeur} »`);
    return valeur;
  }

  // ----- Références -------------------------------------------------------------------------------
  function fournisseurValide(id, { creation = false } = {}) {
    if (id == null) throw new HttpError(400, 'Le fournisseur est obligatoire');
    const f = db.get('fournisseurs', id);
    if (!f) throw new HttpError(400, 'Fournisseur introuvable');
    if (creation && f.actif === false) throw new HttpError(400, `Le fournisseur « ${f.nom} » est désactivé`);
    return f;
  }
  const MSG_LECTURE_SEULE = 'Ce site est accessible en lecture seule pour vous : création ou modification impossible';
  const MSG_HORS_PERIMETRE = 'Ce site / service est hors de votre périmètre';
  /**
   * Un secteur est-il interdit en écriture pour l'utilisateur ? 'lecture' (site accessible en lecture seule),
   * 'hors' (hors des secteurs modifiables) ou null. En portée « perso », l'appartenance d'un enregistrement ne
   * suffit pas : un site en lecture seule n'est jamais modifiable et les secteurs de rattachement s'appliquent
   * (comme dans les modules équipements et demandes).
   */
  function secteurHorsEcriture(req, secteurId) {
    const p = req.perms || {};
    if (p.portee === 'tous' || secteurId == null || secteurId === '') return null;
    const sid = Number(secteurId);
    if (Array.isArray(p.secteurIdsLecture) && p.secteurIdsLecture.includes(sid)) return 'lecture';
    const modifiables = (p.secteurIds || []).map(Number);
    if (p.portee === 'perso' && !modifiables.length) return null;
    return modifiables.includes(sid) ? null : 'hors';
  }
  /** Contrôle d'un secteur cible en écriture : existence, portée de l'utilisateur, site en lecture seule, site affiché. */
  function secteurEcriture(req, secteurId) {
    const id = idRef(secteurId, 'Le site / service');
    if (id == null) throw new HttpError(400, 'Le site / service de rattachement est obligatoire');
    if (!db.get('secteurs', id)) throw new HttpError(400, 'Site / service introuvable');
    const refus = secteurHorsEcriture(req, id);
    if (refus === 'lecture') throw new HttpError(403, MSG_LECTURE_SEULE);
    if (refus === 'hors') throw new HttpError(403, MSG_HORS_PERIMETRE);
    const candidat = { secteurId: id, createdBy: req.user.id };
    if (!perms.canSeeRecord(req.perms, req.user, candidat, { ecriture: true })) {
      if (perms.canSeeRecord(req.perms, req.user, candidat)) throw new HttpError(403, MSG_LECTURE_SEULE);
      throw new HttpError(403, MSG_HORS_PERIMETRE);
    }
    return id;
  }
  /** L'utilisateur peut-il modifier cet enregistrement (portée en écriture, site en lecture seule exclu) ? */
  function ecritureSite(req, r) { return perms.canSeeRecord(req.perms, req.user, r, { ecriture: true }) && secteurHorsEcriture(req, r.secteurId) == null; }
  /** Enregistrement visible, et modifiable pendant une requête de modification (403 lecture seule / hors périmètre). */
  function getEcriture(req, col, id) {
    const r = ctx.getVisible(req, col, id);
    if (!req.ecriture) return r;
    const refus = secteurHorsEcriture(req, r.secteurId);
    if (refus === 'lecture') throw new HttpError(403, 'Ce site est accessible en lecture seule pour vous : modification impossible');
    if (refus === 'hors') throw new HttpError(403, MSG_HORS_PERIMETRE);
    return r;
  }
  /** Une référence (OT, article, fiche du personnel, commande) est-elle utilisable en écriture par l'utilisateur ? */
  const referenceEcriture = (req, r) => !!r && perms.canSeeRecord(req.perms, req.user, r, { ecriture: true });
  /** Deux secteurs appartiennent-ils au même site (une référence sans secteur convient à tout site) ? */
  function memeSite(secteurRef, secteurCible) {
    if (secteurRef == null || secteurRef === '' || secteurCible == null) return true;
    return ctx.siteDuSecteur(secteurRef) === ctx.siteDuSecteur(secteurCible);
  }
  function otLisible(req, id, label, secteurCible) {
    if (id == null) return null;
    const o = db.get('ot', id);
    if (!referenceEcriture(req, o)) throw new HttpError(400, `${label || 'Ordre de travail'} introuvable`);
    if (secteurCible !== undefined && !memeSite(o.secteurId, secteurCible)) throw new HttpError(400, `${label || 'Ordre de travail'} : ${o.numero || '#' + o.id} appartient à un autre site`);
    return o;
  }
  function personnelLisible(req, id, secteurCible) {
    if (id == null) return null;
    if (!perms.can(req.perms, 'rh', 'voir')) throw new HttpError(403, 'Le rattachement à une fiche du personnel nécessite le droit Ressources humaines › Voir');
    const p = db.get('personnel', id);
    if (!referenceEcriture(req, p)) throw new HttpError(400, 'Fiche du personnel introuvable (module Ressources humaines)');
    if (secteurCible !== undefined && !memeSite(p.secteurId, secteurCible)) throw new HttpError(400, `La fiche du personnel ${nomPersonnel(p)} appartient à un autre site`);
    return p;
  }
  /** Demandeur d'une commande : compte actif, droit Achats › Voir et accès au site / service de la commande. */
  function demandeurValide(req, id, secteurId) {
    const u = db.get('users', id);
    if (!u) throw new HttpError(400, 'Demandeur introuvable');
    if (id === req.user.id) return u;
    if (u.actif === false) throw new HttpError(400, `Demandeur invalide : le compte « ${ctx.nomUser(id)} » est désactivé`);
    const p = perms.effectivePermissions(db, u, null, db.getConfig());
    if (!perms.can(p, MODULE, 'voir') || !perms.canSeeRecord(p, u, { secteurId })) throw new HttpError(400, `Demandeur invalide : « ${ctx.nomUser(id)} » n'a pas accès aux achats de ce site / service`);
    return u;
  }
  /** Destinataires d'une notification : comptes actifs, distincts, hors émetteur, ayant Achats › Voir et accès à l'élément. */
  function destinataires(req, record, ids) {
    const config = db.getConfig();
    const vus = new Set();
    const out = [];
    for (const x of ids || []) {
      if (x == null) continue;
      const id = Number(x);
      if (vus.has(id) || (req && id === req.user.id)) continue;
      vus.add(id);
      const u = db.get('users', id);
      if (!u || u.actif === false) continue;
      const p = perms.effectivePermissions(db, u, null, config);
      if (perms.can(p, MODULE, 'voir') && perms.canSeeRecord(p, u, record)) out.push(id);
    }
    return out;
  }
  const nomPersonnel = (p) => (p ? `${p.prenom || ''} ${p.nom || ''}`.trim() || p.matricule || `#${p.id}` : '');
  /** Index de références pour enrichir les listes en une passe. */
  function references() {
    const secteurs = new Map(db.list('secteurs').map((s) => [s.id, s]));
    return {
      fournisseurs: new Map(db.list('fournisseurs').map((f) => [f.id, f])),
      secteurs,
      users: new Map(db.list('users').map((u) => [u.id, `${u.prenom || ''} ${u.nom || ''}`.trim() || u.login])),
      siteDe: (id) => perms.siteDuSecteur(db, id, secteurs),
      ot: new Map(db.list('ot').map((o) => [o.id, o])),
      articles: new Map(db.list('articles').map((a) => [a.id, a])),
      commandes: new Map(db.list(CMD).map((c) => [c.id, c])),
      personnel: new Map(db.list('personnel').map((p) => [p.id, p])),
      facturesParCommande: (() => {
        const m = new Map();
        for (const f of db.list(FAC, (x) => x.commandeId != null && x.statut !== SF.annulee)) {
          const k = Number(f.commandeId);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(f);
        }
        return m;
      })(),
    };
  }
  function nomSecteur(refs, id) { const s = id == null ? null : refs.secteurs.get(Number(id)); return s ? s.nom : ''; }
  function cheminSecteur(refs, id) {
    const parts = []; let cur = id == null ? null : refs.secteurs.get(Number(id)); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? refs.secteurs.get(Number(cur.parentId)) : null; }
    return parts.join(' › ');
  }

  // ----- Numérotation ---------------------------------------------------------------------------
  function numeroUnique(col, cle, defaut) {
    const gabarit = (ctx.config().numerotation || {})[cle] || defaut;
    for (let i = 0; i < 10000; i++) {
      const n = db.nextNumber(cle, gabarit);
      if (!db.findOne(col, (x) => x.numero === n)) return n;
    }
    throw new HttpError(500, 'Impossible de générer un numéro unique');
  }

  // ----- Historique ------------------------------------------------------------------------------
  function trace(record, req, action, details) {
    return (record.historique || []).concat([{ date: new Date().toISOString(), userId: req && req.user ? req.user.id : null, action, statut: record.statut, details: details || '' }]).slice(-300);
  }

  // =================================================================================================
  // COMMANDES
  // =================================================================================================
  /**
   * Lignes d'une commande rattachée à `secteurId`. Un article ou un OT doit être dans le périmètre modifiable de
   * l'utilisateur et sur le site de la commande (la réception entre en stock dans le magasin de l'article) ;
   * les références déjà présentes dans `existantes` ne sont pas recontrôlées (modification par un autre utilisateur).
   */
  function normaliserLignesCommande(req, lignes, secteurId, existantes) {
    if (!Array.isArray(lignes)) throw new HttpError(400, 'Lignes de commande invalides (liste attendue)');
    if (!lignes.length) throw new HttpError(400, 'La commande doit comporter au moins une ligne');
    if (lignes.length > MAX_LIGNES) throw new HttpError(400, `Une commande comporte au maximum ${MAX_LIGNES} lignes`);
    const tvaDefaut = num(cfgAchats().tauxTVA);
    const deja = (cle) => new Set((existantes || []).map((l) => (l[cle] == null ? null : Number(l[cle]))).filter((x) => x != null));
    const articlesDeja = deja('articleId'); const otsDeja = deja('otId');
    return lignes.map((l, i) => {
      const n = `Ligne ${i + 1}`;
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw new HttpError(400, `${n} : ligne invalide`);
      const articleId = idRef(l.articleId, `${n} : article`);
      let article = null;
      if (articleId != null) {
        article = db.get('articles', articleId);
        if (!article || (!articlesDeja.has(articleId) && !referenceEcriture(req, article))) throw new HttpError(400, `${n} : article introuvable`);
        if (article.actif === false) throw new HttpError(400, `${n} : l'article « ${article.designation} » est désactivé`);
        if (!memeSite(article.secteurId, secteurId)) throw new HttpError(400, `${n} : l'article « ${article.designation} » appartient au magasin d'un autre site`);
      }
      const designation = texte(l.designation, `${n} : désignation`, { max: 300 }) || (article ? String(article.designation || '') : '');
      if (!designation) throw new HttpError(400, `${n} : la désignation est obligatoire`);
      const referenceFournisseur = l.referenceFournisseur === undefined && article ? String(article.referenceFournisseur || '') : texte(l.referenceFournisseur, `${n} : référence fournisseur`, { max: 100 });
      const quantite = nombre(l.quantite, `${n} : quantité`, { requis: true, strictPositif: true, max: 1e7 });
      let prix = nombre(l.prixUnitaireHT, `${n} : prix unitaire HT`, { min: 0, max: 1e8 });
      if (prix == null && article) prix = num(article.prixUnitaire);
      if (prix == null) throw new HttpError(400, `${n} : le prix unitaire HT est obligatoire`);
      const tauxTVA = nombre(l.tauxTVA, `${n} : taux de TVA`, { min: 0, max: 100, defaut: tvaDefaut });
      const otId = idRef(l.otId, `${n} : ordre de travail`);
      if (otId != null && !otsDeja.has(otId)) otLisible(req, otId, `${n} : ordre de travail`, secteurId);
      const uniteCode = article ? String(article.uniteCode || '') : texte(l.uniteCode, `${n} : unité`, { max: 20 });
      const q = arrondi(quantite, 3);
      if (!(q > 0)) throw new HttpError(400, `${n} : quantité : la valeur doit être supérieure à 0`);
      const pu = arrondi(prix, 4);
      return { articleId, designation, referenceFournisseur, quantite: q, quantiteRecue: 0, prixUnitaireHT: pu, tauxTVA: arrondi(tauxTVA, 2), otId, uniteCode, montantHT: arrondi(q * pu) };
    });
  }
  /** Comparaison des lignes « métier » (pour refuser une modification après validation). */
  function lignesIdentiques(a, b) {
    const cle = (l) => [l.articleId == null ? '' : Number(l.articleId), String(l.designation || ''), num(l.quantite), num(l.prixUnitaireHT), num(l.tauxTVA), l.otId == null ? '' : Number(l.otId)].join('|');
    return (a || []).length === (b || []).length && (a || []).every((l, i) => cle(l) === cle(b[i]));
  }

  const CHAMPS_APRES_VALIDATION = ['objet', 'categorieCode', 'dateLivraisonPrevue', 'commentaire', 'champs', 'adresseLivraison', 'conditions'];

  function validerCommande(req, body, existant) {
    const b = objet(body);
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const out = {};
    const verrouillee = existant && [SC.validee, SC.envoyee, SC.partielle].includes(existant.statut);
    if (verrouillee) {
      const change = (k) => b[k] !== undefined && String(b[k] == null ? '' : b[k]) !== String(existant[k] == null ? '' : existant[k]);
      if (change('fournisseurId') || change('secteurId') || change('dateCommande') || (b.lignes !== undefined && !lignesIdentiques(normaliserLignesCommande(req, b.lignes, Number(existant.secteurId), existant.lignes), existant.lignes))) {
        throw new HttpError(400, `La commande ${existant.numero} est validée : les lignes, le fournisseur, le site et la date ne sont plus modifiables (annulez-la et créez-en une nouvelle si nécessaire)`);
      }
    }
    const fournisseurId = idRef(val('fournisseurId'), 'Fournisseur');
    const fournisseur = fournisseurValide(fournisseurId, { creation: !existant || fournisseurId !== Number(existant.fournisseurId) });
    out.fournisseurId = fournisseurId;
    out.secteurId = verrouillee ? Number(existant.secteurId) : secteurEcriture(req, val('secteurId'));
    out.categorieCode = codeListe('categoriesDepense', val('categorieCode'), 'Catégorie de dépense', 'pieces');
    out.objet = texte(val('objet'), 'Objet', { max: 200 });
    out.commentaire = texte(val('commentaire'), 'Commentaire', { max: 5000 });
    out.adresseLivraison = texte(val('adresseLivraison'), 'Lieu de livraison', { max: 500 });
    out.conditions = texte(val('conditions'), 'Conditions particulières', { max: 2000 });
    if (!verrouillee && (b.lignes !== undefined || !existant)) out.lignes = normaliserLignesCommande(req, b.lignes === undefined ? [] : b.lignes, out.secteurId, existant ? existant.lignes : null);
    else out.lignes = existant.lignes;
    out.totaux = calculerTotaux(out.lignes);
    out.dateCommande = dateJour(val('dateCommande'), 'Date de commande', { defaut: jourLocal() });
    let livraison = dateJour(val('dateLivraisonPrevue'), 'Date de livraison prévue');
    if (!existant && livraison == null && fournisseur.delaiLivraisonJours != null && Number.isFinite(Number(fournisseur.delaiLivraisonJours))) livraison = ajouterJours(out.dateCommande, Number(fournisseur.delaiLivraisonJours));
    if (livraison != null && livraison < out.dateCommande) throw new HttpError(400, 'La date de livraison prévue ne peut pas précéder la date de commande');
    out.dateLivraisonPrevue = livraison;
    const demandeur = idRef(val('demandeurUserId'), 'Demandeur');
    if (demandeur != null) {
      // Contrôlé à la désignation et au changement de site / service (pas pour un demandeur inchangé)
      if (!existant || demandeur !== idRef(existant.demandeurUserId) || Number(existant.secteurId) !== out.secteurId) demandeurValide(req, demandeur, out.secteurId);
      out.demandeurUserId = demandeur;
    } else out.demandeurUserId = existant ? existant.demandeurUserId : req.user.id;
    if (b.champs !== undefined || !existant) out.champs = ctx.champsPerso(CMD, b.champs || (existant && existant.champs) || {});
    if (verrouillee) {
      // Seuls les champs autorisés après validation sont repris
      const filtre = {};
      for (const k of CHAMPS_APRES_VALIDATION) if (out[k] !== undefined) filtre[k] = out[k];
      return filtre;
    }
    return out;
  }

  function estProprio(req, r) { return Number(r.createdBy) === req.user.id || Number(r.demandeurUserId) === req.user.id; }
  /** Factures non annulées rattachées à une commande. */
  const nbFacturesActives = (commandeId) => db.count(FAC, (f) => Number(f.commandeId) === Number(commandeId) && f.statut !== SF.annulee);
  function livraisonEnRetard(c, jour) { return [SC.validee, SC.envoyee, SC.partielle].includes(c.statut) && !!c.dateLivraisonPrevue && c.dateLivraisonPrevue < (jour || jourLocal()); }

  /** Actions possibles sur une commande pour l'utilisateur courant. */
  function actionsCommande(req, c) {
    const ecr = ecritureSite(req, c);
    const st = c.statut;
    const final = finauxCmd().has(st);
    const mod = can(req, 'modifier');
    const cre = can(req, 'creer');
    const proprio = estProprio(req, c);
    const auDela = num((c.totaux || {}).ht) >= num(cfgAchats().seuilValidationHT);
    const aReceptions = (c.receptions || []).length > 0;
    const facturee = nbFacturesActives(c.id) > 0;
    return {
      modifier: ecr && !final && (mod || (cre && proprio && st === SC.brouillon)),
      soumettre: ecr && st === SC.brouillon && (mod || (cre && proprio)),
      valider: ecr && st === SC.aValider && can(req, 'valider') && !(auDela && proprio && !req.perms.estAdmin),
      refuser: ecr && st === SC.aValider && can(req, 'valider'),
      envoyer: ecr && st === SC.validee && mod,
      receptionner: ecr && [SC.validee, SC.envoyee, SC.partielle].includes(st) && mod,
      solder: ecr && st === SC.partielle && mod,
      annuler: ecr && !final && !aReceptions && !facturee && (mod || (cre && proprio && [SC.brouillon, SC.aValider].includes(st))),
      supprimer: ecr && st === SC.brouillon && !aReceptions && (can(req, 'supprimer') || (cre && proprio)),
      facturer: ecr && cre && [SC.validee, SC.envoyee, SC.partielle, SC.recue].includes(st),
      documents: ecr && !final ? (mod || (cre && proprio)) : (ecr && mod),
      validationPropreInterdite: st === SC.aValider && auDela && proprio && !req.perms.estAdmin,
    };
  }

  function montantRecuHT(c) { return arrondi((c.lignes || []).reduce((s, l) => s + arrondi(num(l.quantiteRecue) * num(l.prixUnitaireHT)), 0)); }

  function resumeDoc(d, i) { return { index: i, nom: d.nom, type: d.type, taille: d.taille, date: d.date, userId: d.userId, description: d.description || '', estImage: estImage(d.type), estPdf: d.type === 'application/pdf' }; }

  function resumeCommande(c, refs, jour) {
    const { documents, historique, ...reste } = c;
    const f = refs.fournisseurs.get(Number(c.fournisseurId));
    const siteId = refs.siteDe(c.secteurId);
    const factures = refs.facturesParCommande.get(c.id) || [];
    const qte = (c.lignes || []).reduce((s, l) => s + num(l.quantite), 0);
    const recu = (c.lignes || []).reduce((s, l) => s + Math.min(num(l.quantiteRecue), num(l.quantite)), 0);
    const totaux = c.totaux || calculerTotaux(c.lignes);
    const recuHT = montantRecuHT(c);
    // Taux de réception en valeur (les lignes ont des unités différentes) ; en quantité pour une commande sans montant
    const tauxReception = num(totaux.ht) > 0 ? Math.min(100, Math.round((recuHT / num(totaux.ht)) * 100)) : (qte > 0 ? Math.round((recu / qte) * 100) : 0);
    return Object.assign(reste, {
      totaux,
      fournisseurNom: f ? f.nom || '' : '',
      secteurNom: nomSecteur(refs, c.secteurId), secteurChemin: cheminSecteur(refs, c.secteurId),
      siteId, siteNom: siteId != null ? nomSecteur(refs, siteId) : '',
      nbLignes: (c.lignes || []).length,
      tauxReception,
      montantRecuHT: recuHT,
      resteARecevoirHT: [SC.recue, SC.annulee].includes(c.statut) ? 0 : arrondi(Math.max(0, num(totaux.ht) - recuHT)),
      montantFactureHT: arrondi(factures.reduce((s, x) => s + num(x.montantHT), 0)),
      nbFactures: factures.length,
      nbDocuments: (documents || []).length,
      nbReceptions: (c.receptions || []).length,
      enRetardLivraison: livraisonEnRetard(c, jour),
      joursRetardLivraison: livraisonEnRetard(c, jour) ? joursEntre(c.dateLivraisonPrevue, jour || jourLocal()) : 0,
      demandeurNom: refs.users.get(Number(c.demandeurUserId)) || '',
      valideurNom: c.valideurUserId != null ? refs.users.get(Number(c.valideurUserId)) || '' : '',
      statutLibelle: libelle('statutsCommande', c.statut),
      categorieLibelle: libelle('categoriesDepense', c.categorieCode),
    });
  }

  function detailCommande(req, c) {
    const refs = references();
    const jour = jourLocal();
    const r = resumeCommande(c, refs, jour);
    const f = refs.fournisseurs.get(Number(c.fournisseurId));
    const seuil = num(cfgAchats().seuilValidationHT);
    r.lignes = (c.lignes || []).map((l, index) => {
      const a = l.articleId != null ? refs.articles.get(Number(l.articleId)) : null;
      const aVisible = !!a && perms.canSeeRecord(req.perms, req.user, a);
      const o = l.otId != null ? refs.ot.get(Number(l.otId)) : null;
      return Object.assign({}, l, {
        index, montantHT: arrondi(num(l.quantite) * num(l.prixUnitaireHT)),
        resteARecevoir: arrondi(Math.max(0, num(l.quantite) - num(l.quantiteRecue)), 3),
        montantRecuHT: arrondi(num(l.quantiteRecue) * num(l.prixUnitaireHT)),
        articleCode: a ? a.code || '' : '', articleStock: aVisible ? num(a.quantite) : null, articleSeuil: aVisible ? num(a.seuilMin) : null, articleActif: a ? a.actif !== false : null,
        otNumero: o ? o.numero || `#${o.id}` : '', otTitre: o ? o.titre || '' : '',
      });
    });
    r.receptions = (c.receptions || []).map((x, i) => Object.assign({}, x, {
      index: i, userNom: refs.users.get(Number(x.userId)) || '',
      lignes: (x.lignes || []).map((lr) => Object.assign({}, lr, { designation: ((c.lignes || [])[lr.index] || {}).designation || '', uniteCode: ((c.lignes || [])[lr.index] || {}).uniteCode || '' })),
    })).reverse();
    r.factures = db.list(FAC, (x) => Number(x.commandeId) === c.id && perms.canSeeRecord(req.perms, req.user, x)).sort((a, b) => String(b.dateFacture).localeCompare(String(a.dateFacture)))
      .map((x) => ({ id: x.id, numero: x.numero, numeroFournisseur: x.numeroFournisseur, dateFacture: x.dateFacture, dateEcheance: x.dateEcheance, montantHT: x.montantHT, montantTVA: x.montantTVA, montantTTC: x.montantTTC, statut: x.statut, secteurId: x.secteurId }));
    r.historique = (c.historique || []).slice().reverse().map((h) => Object.assign({}, h, { userNom: refs.users.get(Number(h.userId)) || (h.userId == null ? 'Système' : '') }));
    r.documents = (c.documents || []).map(resumeDoc);
    r.fournisseur = f ? { id: f.id, nom: f.nom || '', adresse: f.adresse || '', contact: f.contact || '', telephone: f.telephone || '', email: f.email || '', siret: f.siret || '', delaiLivraisonJours: f.delaiLivraisonJours == null ? null : f.delaiLivraisonJours, actif: f.actif !== false } : null;
    r.seuilValidationHT = seuil;
    r.validationRequise = num(r.totaux.ht) >= seuil;
    r.createdByNom = refs.users.get(Number(c.createdBy)) || '';
    r.actions = actionsCommande(req, c);
    r.lectureSeule = !ecritureSite(req, c);
    r.nbFacturesActives = nbFacturesActives(c.id);
    r.entreeStockAReception = !!cfgAchats().entreeStockAReception;
    return r;
  }

  function filtrerCommandes(req) {
    const q = req.query || {};
    const jour = jourLocal();
    let rows = ctx.scope(req, db.list(CMD));
    if (q.statut) { const s = new Set(String(q.statut).split(',').filter(Boolean)); rows = rows.filter((c) => s.has(c.statut)); }
    if (q.ouvertes === '1') { const f = finauxCmd(); rows = rows.filter((c) => !f.has(c.statut)); }
    if (q.fournisseurId) rows = rows.filter((c) => Number(c.fournisseurId) === Number(q.fournisseurId));
    if (q.secteurId) { const ids = new Set(perms.secteursDescendants(db, [Number(q.secteurId)])); rows = rows.filter((c) => ids.has(Number(c.secteurId))); }
    if (q.categorieCode) rows = rows.filter((c) => c.categorieCode === q.categorieCode);
    const du = dateFiltre(q.du, 'Du'); const au = dateFiltre(q.au, 'Au');
    if (du) rows = rows.filter((c) => String(c.dateCommande || '') >= du);
    if (au) rows = rows.filter((c) => String(c.dateCommande || '') <= au);
    if (q.enRetard === '1') rows = rows.filter((c) => livraisonEnRetard(c, jour));
    if (q.otId) rows = rows.filter((c) => (c.lignes || []).some((l) => Number(l.otId) === Number(q.otId)));
    if (q.articleId) rows = rows.filter((c) => (c.lignes || []).some((l) => Number(l.articleId) === Number(q.articleId)));
    if (q.demandeurUserId) rows = rows.filter((c) => Number(c.demandeurUserId) === Number(q.demandeurUserId));
    if (q.recherche) {
      const s = normaliser(q.recherche);
      const fours = new Map(db.list('fournisseurs').map((f) => [f.id, f.nom || '']));
      rows = rows.filter((c) => [c.numero, c.objet, c.commentaire, fours.get(Number(c.fournisseurId))].concat((c.lignes || []).flatMap((l) => [l.designation, l.referenceFournisseur])).some((v) => normaliser(v).includes(s)));
    }
    return rows.sort((a, b) => String(b.dateCommande || '').localeCompare(String(a.dateCommande || '')) || String(b.numero || '').localeCompare(String(a.numero || ''), 'fr', { numeric: true }));
  }

  /** Valideurs d'une commande : droit achats › valider et accès en écriture à son site. */
  function valideursCommande(c, exclure) {
    const exclus = new Set((exclure || []).filter((x) => x != null).map(Number));
    return ctx.usersAvecDroit(MODULE, 'valider', (u, p) => perms.canSeeRecord(p, u, c, { ecriture: true })).map((u) => u.id).filter((id) => !exclus.has(id));
  }
  function montantTxt(n) { return `${arrondi(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`; }
  function nomFournisseur(id) { const f = id == null ? null : db.get('fournisseurs', id); return f ? f.nom || '' : ''; }

  function getCommande(req, id) { return getEcriture(req, CMD, id); }

  // ----- Routes : commandes (routes spécifiques d'abord) -----------------------------------------
  router.get('/api/commandes', async (req) => {
    const refs = references(); const jour = jourLocal();
    return filtrerCommandes(req).map((c) => resumeCommande(c, refs, jour));
  }, { perm: [MODULE, 'voir'] });

  /** Articles sous le seuil (stock) avec les quantités déjà en commande — sans exiger le droit stock › voir. */
  router.get('/api/achats/alertes-stock', async (req) => {
    const s = ctx.services.stock;
    if (!s || typeof s.alertes !== 'function') throw new HttpError(503, 'Module stock indisponible');
    const enCommande = quantitesEnCommande();
    const fours = new Map(db.list('fournisseurs').map((f) => [f.id, f]));
    const commandes = new Map(db.list(CMD).map((c) => [c.id, c]));
    return s.alertes(req).map((a) => {
      const f = a.fournisseurId != null ? fours.get(Number(a.fournisseurId)) : null;
      const deja = enCommande.get(Number(a.id)) || { quantite: 0, commandes: [] };
      return {
        id: a.id, code: a.code || '', designation: a.designation || '', quantite: num(a.quantite), seuilMin: num(a.seuilMin), uniteCode: a.uniteCode || '',
        quantiteACommander: num(a.quantiteACommander), prixUnitaire: num(a.prixUnitaire), referenceFournisseur: a.referenceFournisseur || '',
        fournisseurId: a.fournisseurId == null ? null : Number(a.fournisseurId), fournisseurNom: f ? f.nom || '' : '', fournisseurActif: f ? f.actif !== false : null,
        delaiLivraisonJours: f && f.delaiLivraisonJours != null ? f.delaiLivraisonJours : null,
        secteurId: a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId), emplacement: a.emplacement || '',
        // La quantité déjà en commande est globale (stock commun) ; seules les commandes du périmètre sont identifiées
        dejaEnCommande: arrondi(deja.quantite, 3), commandesEnCours: deja.commandes.filter((x) => perms.canSeeRecord(req.perms, req.user, commandes.get(x.id))),
        resteACommander: arrondi(Math.max(0, num(a.quantiteACommander) - deja.quantite), 3),
      };
    });
  }, { perm: [MODULE, 'voir'] });

  /** Quantités restant à recevoir par article sur les commandes en cours (hors brouillons refusés/annulées). */
  function quantitesEnCommande() {
    const finauxC = finauxCmd();
    const m = new Map();
    for (const c of db.list(CMD, (x) => !finauxC.has(x.statut))) {
      for (const l of c.lignes || []) {
        if (l.articleId == null) continue;
        const reste = Math.max(0, num(l.quantite) - num(l.quantiteRecue));
        if (!(reste > 0)) continue;
        const k = Number(l.articleId);
        const x = m.get(k) || { quantite: 0, commandes: [] };
        x.quantite += reste;
        if (!x.commandes.some((y) => y.id === c.id)) x.commandes.push({ id: c.id, numero: c.numero, statut: c.statut });
        m.set(k, x);
      }
    }
    return m;
  }

  /** Brouillons de commande regroupés par fournisseur depuis les alertes de stock. */
  router.post('/api/commandes/depuis-alertes', async (req) => {
    const s = ctx.services.stock;
    if (!s || typeof s.alertes !== 'function') throw new HttpError(503, 'Module stock indisponible');
    const b = objet(req.body);
    const secteurDefaut = b.secteurId == null || b.secteurId === '' ? null : secteurEcriture(req, b.secteurId);
    let choix = null; // Map articleId → quantité forcée (ou null = quantité proposée)
    if (b.lignes !== undefined) {
      if (!Array.isArray(b.lignes)) throw new HttpError(400, 'Lignes invalides (liste attendue)');
      choix = new Map();
      for (const [i, l] of b.lignes.entries()) {
        const id = idRef(l && l.articleId, `Ligne ${i + 1} : article`);
        if (id == null) throw new HttpError(400, `Ligne ${i + 1} : article obligatoire`);
        choix.set(id, nombre(l.quantite, `Ligne ${i + 1} : quantité`, { strictPositif: true, max: 1e7 }));
      }
    } else if (b.articleIds !== undefined) {
      if (!Array.isArray(b.articleIds)) throw new HttpError(400, 'Sélection d\'articles invalide');
      choix = new Map(b.articleIds.map((x, i) => [idRef(x, `Article ${i + 1}`), null]));
    }
    const alertes = s.alertes(req);
    const enCommande = quantitesEnCommande();
    const ignores = [];
    const groupes = new Map();
    const config = cfgAchats();
    for (const a of alertes) {
      if (choix && !choix.has(Number(a.id))) continue;
      const base = { articleId: a.id, code: a.code || '', designation: a.designation || '' };
      const f = a.fournisseurId != null ? db.get('fournisseurs', a.fournisseurId) : null;
      if (!f) { ignores.push(Object.assign(base, { raison: 'Aucun fournisseur habituel renseigné sur l\'article' })); continue; }
      if (f.actif === false) { ignores.push(Object.assign(base, { raison: `Fournisseur « ${f.nom} » désactivé` })); continue; }
      const deja = (enCommande.get(Number(a.id)) || { quantite: 0 }).quantite;
      let quantite = choix && choix.get(Number(a.id)) != null ? choix.get(Number(a.id)) : arrondi(num(a.quantiteACommander) - deja, 3);
      if (!(quantite > 0)) { ignores.push(Object.assign(base, { raison: `Déjà en commande (${arrondi(deja, 3)} en attente de réception)` })); continue; }
      const secteurArticle = a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId);
      let secteurId = secteurArticle != null && perms.canSeeRecord(req.perms, req.user, { secteurId: secteurArticle, createdBy: req.user.id }, { ecriture: true }) ? secteurArticle : secteurDefaut;
      if (secteurId == null) { ignores.push(Object.assign(base, { raison: 'Site / service de rattachement à préciser' })); continue; }
      quantite = arrondi(quantite, 3);
      const cle = `${f.id}|${secteurId}`;
      if (!groupes.has(cle)) groupes.set(cle, { fournisseur: f, secteurId, lignes: [] });
      groupes.get(cle).lignes.push({ articleId: a.id, designation: a.designation || a.code || `Article #${a.id}`, referenceFournisseur: a.referenceFournisseur || '', quantite, quantiteRecue: 0, prixUnitaireHT: arrondi(num(a.prixUnitaire), 4), tauxTVA: arrondi(num(config.tauxTVA), 2), otId: null, uniteCode: a.uniteCode || '', montantHT: arrondi(quantite * num(a.prixUnitaire)) });
    }
    if (choix) for (const id of choix.keys()) if (!alertes.some((a) => Number(a.id) === id)) { const art = db.get('articles', id); ignores.push({ articleId: id, code: '', designation: art && perms.canSeeRecord(req.perms, req.user, art) ? art.designation || `Article #${id}` : `Article #${id}`, raison: 'Article hors alerte ou hors de votre périmètre' }); }
    if (!groupes.size) {
      if (secteurDefaut == null && ignores.some((x) => /rattachement/.test(x.raison))) throw new HttpError(400, 'Indiquez le site / service de rattachement des commandes (secteurId)');
      return { commandes: [], ignores };
    }
    const creees = [];
    const jour = jourLocal();
    for (const g of groupes.values()) {
      const c = {
        numero: numeroUnique(CMD, 'cmd', 'CMD-{annee}-{num:4}'), fournisseurId: g.fournisseur.id, secteurId: g.secteurId, statut: SC.brouillon,
        categorieCode: codeListe('categoriesDepense', null, 'Catégorie', 'pieces'), objet: 'Réapprovisionnement du stock (articles sous le seuil)',
        lignes: g.lignes, totaux: calculerTotaux(g.lignes), dateCommande: jour,
        dateLivraisonPrevue: g.fournisseur.delaiLivraisonJours != null && Number.isFinite(Number(g.fournisseur.delaiLivraisonJours)) ? ajouterJours(jour, Number(g.fournisseur.delaiLivraisonJours)) : null,
        demandeurUserId: req.user.id, valideurUserId: null, dateValidation: null, commentaire: '', adresseLivraison: '', conditions: '',
        documents: [], receptions: [], champs: ctx.champsPerso(CMD, {}), createdBy: req.user.id, origine: 'alertes-stock',
      };
      c.historique = trace(c, req, 'creation', `Créée depuis les alertes de stock (${g.lignes.length} ligne(s))`);
      const cree = db.insert(CMD, c);
      ctx.audit(req, 'creation', CMD, cree.id, `Commande ${cree.numero} (${g.fournisseur.nom}) créée depuis les alertes de stock — ${montantTxt(cree.totaux.ht)} HT`);
      creees.push(cree);
    }
    const refs = references();
    return { commandes: creees.map((c) => resumeCommande(c, refs, jour)), ignores };
  }, { perm: [MODULE, 'creer'] });

  router.get('/api/commandes/:id', async (req) => detailCommande(req, getCommande(req, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/commandes', async (req) => {
    const b = objet(req.body);
    const data = validerCommande(req, b, null);
    Object.assign(data, {
      numero: numeroUnique(CMD, 'cmd', 'CMD-{annee}-{num:4}'), statut: SC.brouillon, valideurUserId: null, dateValidation: null,
      documents: [], receptions: [], createdBy: req.user.id,
    });
    data.historique = trace(data, req, 'creation', '');
    let c = db.insert(CMD, data);
    ctx.audit(req, 'creation', CMD, c.id, `Commande ${c.numero} — ${nomFournisseur(c.fournisseurId)} — ${montantTxt(c.totaux.ht)} HT`);
    if (b.soumettre === true) c = soumettreCommande(req, c);
    return detailCommande(req, c);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/commandes/:id', async (req) => {
    const c = getCommande(req, req.params.id);
    if (finauxCmd().has(c.statut)) throw new HttpError(400, `La commande ${c.numero} est ${libelle('statutsCommande', c.statut).toLowerCase()} : elle n'est plus modifiable`);
    if (!actionsCommande(req, c).modifier) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier (un brouillon ne peut être modifié que par son auteur)');
    const data = validerCommande(req, req.body, c);
    data.historique = trace(Object.assign({}, c, data), req, 'modification', data.totaux && c.totaux && data.totaux.ht !== c.totaux.ht ? `Montant HT ${montantTxt(c.totaux.ht)} → ${montantTxt(data.totaux.ht)}` : '');
    const maj = db.update(CMD, c.id, data);
    ctx.audit(req, 'modification', CMD, maj.id, `Commande ${maj.numero} — ${montantTxt(maj.totaux.ht)} HT`);
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'voir'] });

  router.delete('/api/commandes/:id', async (req) => {
    const c = getCommande(req, req.params.id);
    const a = actionsCommande(req, c);
    if (c.statut !== SC.brouillon) throw new HttpError(400, `Seul un brouillon peut être supprimé : annulez la commande ${c.numero} pour conserver sa traçabilité`);
    if (!a.supprimer) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Supprimer');
    if (db.count(FAC, (f) => Number(f.commandeId) === c.id)) throw new HttpError(400, 'Des factures sont rattachées à cette commande : suppression impossible');
    db.remove(CMD, c.id);
    ctx.audit(req, 'suppression', CMD, c.id, `Commande ${c.numero} — ${nomFournisseur(c.fournisseurId)} — ${montantTxt((c.totaux || {}).ht)} HT`);
    return { ok: true };
  }, { perm: [MODULE, 'voir'] });

  // ----- Workflow commande -----------------------------------------------------------------------
  function soumettreCommande(req, c) {
    const seuil = num(cfgAchats().seuilValidationHT);
    const ht = num((c.totaux || {}).ht);
    if (!(c.lignes || []).length) throw new HttpError(400, 'La commande doit comporter au moins une ligne');
    if (ht >= seuil) {
      const patch = { statut: SC.aValider, dateSoumission: new Date().toISOString(), motifRefus: '' };
      patch.historique = trace(Object.assign({}, c, patch), req, 'soumission', `Montant ${montantTxt(ht)} HT ≥ seuil de validation ${montantTxt(seuil)} HT`);
      const maj = db.update(CMD, c.id, patch);
      ctx.audit(req, 'statut', CMD, maj.id, `Commande ${maj.numero} soumise à validation (${montantTxt(ht)} HT)`);
      const cibles = valideursCommande(maj, [req.user.id].concat(req.perms.estAdmin ? [] : [maj.createdBy, maj.demandeurUserId]));
      if (cibles.length) ctx.notify(cibles, { titre: `Commande à valider : ${maj.numero}`, message: `${nomFournisseur(maj.fournisseurId)} — ${montantTxt(ht)} HT${maj.objet ? ' — ' + maj.objet : ''} (demandée par ${ctx.nomUser(maj.demandeurUserId) || ctx.nomUser(req.user.id)})`, lien: '#/achats/commande/' + maj.id, type: 'alerte' });
      return maj;
    }
    const patch = { statut: SC.validee, dateSoumission: new Date().toISOString(), dateValidation: new Date().toISOString(), valideurUserId: null, validationAuto: true, motifRefus: '' };
    patch.historique = trace(Object.assign({}, c, patch), req, 'validation', `Validation automatique : montant ${montantTxt(ht)} HT inférieur au seuil de ${montantTxt(seuil)} HT`);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'validation', CMD, maj.id, `Commande ${maj.numero} validée automatiquement (${montantTxt(ht)} HT < seuil ${montantTxt(seuil)} HT)`);
    ctx.emit('achats:commandeValidee', { commande: maj, automatique: true });
    return maj;
  }

  router.post('/api/commandes/:id/soumettre', async (req) => {
    const c = getCommande(req, req.params.id);
    if (c.statut !== SC.brouillon) throw new HttpError(400, `La commande ${c.numero} n'est pas un brouillon (${libelle('statutsCommande', c.statut)})`);
    if (!actionsCommande(req, c).soumettre) throw new HttpError(403, 'Droit insuffisant : seul l\'auteur de la commande ou un utilisateur autorisé (Achats › Modifier) peut la soumettre');
    return detailCommande(req, soumettreCommande(req, c));
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/commandes/:id/valider', async (req) => {
    const c = getCommande(req, req.params.id);
    if (c.statut !== SC.aValider) throw new HttpError(400, `La commande ${c.numero} n'est pas en attente de validation (${libelle('statutsCommande', c.statut)})`);
    const seuil = num(cfgAchats().seuilValidationHT);
    if (num((c.totaux || {}).ht) >= seuil && estProprio(req, c) && !req.perms.estAdmin) {
      throw new HttpError(403, `Vous ne pouvez pas valider votre propre commande au-delà du seuil de ${montantTxt(seuil)} HT : un autre valideur doit l'approuver`);
    }
    const b = objet(req.body);
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 1000 });
    const patch = { statut: SC.validee, valideurUserId: req.user.id, dateValidation: new Date().toISOString(), validationAuto: false, motifRefus: '' };
    patch.historique = trace(Object.assign({}, c, patch), req, 'validation', commentaire);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'validation', CMD, maj.id, `Commande ${maj.numero} validée (${montantTxt(maj.totaux.ht)} HT)${commentaire ? ' — ' + commentaire : ''}`);
    const cibles = destinataires(req, maj, [maj.demandeurUserId, maj.createdBy]);
    if (cibles.length) ctx.notify(cibles, { titre: `Commande validée : ${maj.numero}`, message: `${nomFournisseur(maj.fournisseurId)} — ${montantTxt(maj.totaux.ht)} HT, validée par ${ctx.nomUser(req.user.id)}${commentaire ? ' : ' + commentaire : ''}`, lien: '#/achats/commande/' + maj.id, type: 'succes' });
    ctx.emit('achats:commandeValidee', { commande: maj, automatique: false });
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'valider'] });

  router.post('/api/commandes/:id/refuser', async (req) => {
    const c = getCommande(req, req.params.id);
    if (c.statut !== SC.aValider) throw new HttpError(400, `La commande ${c.numero} n'est pas en attente de validation`);
    const motif = texte(objet(req.body).motif, 'Motif du refus', { requis: true, max: 1000 });
    const patch = { statut: SC.brouillon, motifRefus: motif, dateRefus: new Date().toISOString(), refuseParUserId: req.user.id };
    patch.historique = trace(Object.assign({}, c, patch), req, 'refus', motif);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'refus', CMD, maj.id, `Commande ${maj.numero} refusée (retour en brouillon) — ${motif}`);
    const cibles = destinataires(req, maj, [maj.demandeurUserId, maj.createdBy]);
    if (cibles.length) ctx.notify(cibles, { titre: `Commande refusée : ${maj.numero}`, message: `${ctx.nomUser(req.user.id)} a refusé la commande (${montantTxt(maj.totaux.ht)} HT) : ${motif}. Elle est repassée en brouillon.`, lien: '#/achats/commande/' + maj.id, type: 'alerte' });
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'valider'] });

  router.post('/api/commandes/:id/envoyer', async (req) => {
    const c = getCommande(req, req.params.id);
    if (c.statut !== SC.validee) throw new HttpError(400, `Seule une commande validée peut être envoyée au fournisseur (statut actuel : ${libelle('statutsCommande', c.statut)})`);
    const b = objet(req.body);
    const dateEnvoi = dateJour(b.dateEnvoi, 'Date d\'envoi', { defaut: jourLocal() });
    if (dateEnvoi > jourLocal()) throw new HttpError(400, 'La date d\'envoi ne peut pas être dans le futur');
    if (c.dateCommande && dateEnvoi < c.dateCommande) throw new HttpError(400, `La date d'envoi ne peut pas précéder la date de commande (${csvDate(c.dateCommande)})`);
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 1000 });
    const patch = { statut: SC.envoyee, dateEnvoi, envoyeParUserId: req.user.id };
    patch.historique = trace(Object.assign({}, c, patch), req, 'envoi', commentaire || `Envoyée le ${csvDate(dateEnvoi)}`);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'statut', CMD, maj.id, `Commande ${maj.numero} envoyée à ${nomFournisseur(maj.fournisseurId)}`);
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/commandes/:id/receptionner', async (req) => {
    const c = getCommande(req, req.params.id);
    if (![SC.validee, SC.envoyee, SC.partielle].includes(c.statut)) throw new HttpError(400, `La commande ${c.numero} ne peut pas être réceptionnée (statut : ${libelle('statutsCommande', c.statut)})`);
    const b = objet(req.body);
    if (!Array.isArray(b.lignes) || !b.lignes.length) throw new HttpError(400, 'Indiquez au moins une ligne reçue (lignes : [{ index, quantite }])');
    const date = dateJour(b.date, 'Date de réception', { defaut: jourLocal() });
    if (date > jourLocal()) throw new HttpError(400, 'La date de réception ne peut pas être dans le futur');
    if (c.dateCommande && date < c.dateCommande) throw new HttpError(400, `La date de réception ne peut pas précéder la date de commande (${csvDate(c.dateCommande)})`);
    const bonLivraison = texte(b.bonLivraison, 'N° de bon de livraison', { max: 100 });
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 1000 });
    const lignes = (c.lignes || []).map((l) => Object.assign({}, l));
    const vus = new Set();
    const recues = [];
    for (const [i, lr] of b.lignes.entries()) {
      if (!lr || typeof lr !== 'object') throw new HttpError(400, `Réception, ligne ${i + 1} : invalide`);
      const index = Number(lr.index);
      if (!Number.isInteger(index) || index < 0 || index >= lignes.length) throw new HttpError(400, `Réception, ligne ${i + 1} : ligne de commande inexistante`);
      if (vus.has(index)) throw new HttpError(400, `La ligne ${index + 1} de la commande figure deux fois dans la réception`);
      vus.add(index);
      const quantite = arrondi(nombre(lr.quantite, `Ligne ${index + 1} (${lignes[index].designation}) : quantité reçue`, { requis: true, min: 0, max: 1e7 }), 3);
      if (!(quantite > 0)) continue; // ligne non livrée dans cette réception
      const reste = arrondi(num(lignes[index].quantite) - num(lignes[index].quantiteRecue), 3);
      if (quantite > reste + 1e-9) throw new HttpError(400, `Ligne ${index + 1} (${lignes[index].designation}) : quantité reçue (${String(quantite).replace('.', ',')}) supérieure au reste à recevoir (${String(Math.max(0, reste)).replace('.', ',')})`);
      recues.push({ index, quantite });
    }
    if (!recues.length) throw new HttpError(400, 'Aucune quantité reçue : saisissez au moins une quantité supérieure à 0');
    // Entrées en stock : contrôles AVANT toute écriture
    const avecStock = !!cfgAchats().entreeStockAReception;
    const aEntrer = avecStock ? recues.filter((r) => lignes[r.index].articleId != null) : [];
    const s = ctx.services.stock;
    if (aEntrer.length) {
      if (!s || typeof s.entrer !== 'function') throw new HttpError(503, 'Module stock indisponible : la réception avec entrée en stock automatique est impossible');
      for (const r of aEntrer) {
        const a = db.get('articles', lignes[r.index].articleId);
        if (a && a.actif === false) throw new HttpError(400, `Ligne ${r.index + 1} : l'article « ${a.designation} » est désactivé — réactivez-le dans le stock avant de réceptionner`);
        // L'entrée en stock modifie le magasin de l'article : il doit être modifiable par l'utilisateur et sur le site de la commande
        if (a && (!referenceEcriture(req, a) || !memeSite(a.secteurId, c.secteurId))) throw new HttpError(400, `Ligne ${r.index + 1} : l'article « ${a.designation} » appartient au magasin d'un autre site ou est hors de votre périmètre — aucune entrée en stock possible`);
      }
    }
    const mouvements = new Map();
    const avertissements = [];
    for (const r of aEntrer) {
      const l = lignes[r.index];
      if (!db.get('articles', l.articleId)) { avertissements.push(`Ligne ${r.index + 1} : article supprimé du stock, aucune entrée enregistrée`); continue; }
      const res = s.entrer({ articleId: l.articleId, quantite: r.quantite, userId: req.user.id, motif: `Réception ${c.numero}${bonLivraison ? ' — BL ' + bonLivraison : ''}`, prixUnitaire: l.prixUnitaireHT, fournisseurId: c.fournisseurId });
      if (res && res.mouvement) mouvements.set(r.index, res.mouvement.id);
    }
    for (const r of recues) lignes[r.index].quantiteRecue = arrondi(num(lignes[r.index].quantiteRecue) + r.quantite, 3);
    const complete = lignes.every((l) => num(l.quantiteRecue) + 1e-9 >= num(l.quantite));
    const reception = {
      date, userId: req.user.id, bonLivraison, commentaire, createdAt: new Date().toISOString(),
      lignes: recues.map((r) => ({ index: r.index, quantite: r.quantite, mouvementId: mouvements.has(r.index) ? mouvements.get(r.index) : null })),
      montantHT: arrondi(recues.reduce((x, r) => x + arrondi(r.quantite * num(lignes[r.index].prixUnitaireHT)), 0)),
    };
    const patch = { lignes, receptions: (c.receptions || []).concat([reception]), statut: complete ? SC.recue : SC.partielle };
    if (complete) patch.dateReceptionComplete = date;
    patch.historique = trace(Object.assign({}, c, patch), req, 'reception', `${complete ? 'Réception complète' : 'Réception partielle'}${bonLivraison ? ' — BL ' + bonLivraison : ''} (${recues.length} ligne(s), ${montantTxt(reception.montantHT)} HT)`);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'statut', CMD, maj.id, `Commande ${maj.numero} : ${complete ? 'réception complète' : 'réception partielle'}${bonLivraison ? ' (BL ' + bonLivraison + ')' : ''} — ${recues.length} ligne(s), ${mouvements.size} entrée(s) en stock`);
    recalculerRapprochements(maj.id);
    const cibles = destinataires(req, maj, [maj.demandeurUserId, maj.createdBy]);
    if (cibles.length) ctx.notify(cibles, { titre: `Commande ${complete ? 'reçue' : 'reçue partiellement'} : ${maj.numero}`, message: `${nomFournisseur(maj.fournisseurId)} — ${recues.length} ligne(s) réceptionnée(s) par ${ctx.nomUser(req.user.id)}${bonLivraison ? ' (BL ' + bonLivraison + ')' : ''}${complete ? '' : ' ; reliquat en attente'}.`, lien: '#/achats/commande/' + maj.id, type: 'info' });
    ctx.emit('achats:commandeRecue', { commande: maj, reception, complete });
    const d = detailCommande(req, maj);
    d.avertissements = avertissements;
    d.nbEntreesStock = mouvements.size;
    return d;
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/commandes/:id/solder', async (req) => {
    const c = getCommande(req, req.params.id);
    if (c.statut !== SC.partielle) throw new HttpError(400, 'Seule une commande reçue partiellement peut être soldée');
    const motif = texte(objet(req.body).motif, 'Motif', { requis: true, max: 1000 });
    const patch = { statut: SC.recue, solde: true, motifSolde: motif, dateReceptionComplete: jourLocal() };
    patch.historique = trace(Object.assign({}, c, patch), req, 'solde', `Reliquat abandonné : ${motif}`);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'statut', CMD, maj.id, `Commande ${maj.numero} soldée (reliquat abandonné) — ${motif}`);
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/commandes/:id/annuler', async (req) => {
    const c = getCommande(req, req.params.id);
    if (finauxCmd().has(c.statut)) throw new HttpError(400, `La commande ${c.numero} est déjà ${libelle('statutsCommande', c.statut).toLowerCase()}`);
    if ((c.receptions || []).length) throw new HttpError(400, 'Cette commande a déjà fait l\'objet d\'une réception : soldez-la au lieu de l\'annuler');
    const nbFac = nbFacturesActives(c.id);
    if (nbFac) throw new HttpError(400, `${nbFac > 1 ? nbFac + ' factures sont rattachées' : 'Une facture est rattachée'} à la commande ${c.numero} : annulez-les d'abord (ou soldez la commande)`);
    if (!actionsCommande(req, c).annuler) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    const motif = texte(objet(req.body).motif, 'Motif de l\'annulation', { requis: true, max: 1000 });
    const patch = { statut: SC.annulee, motifAnnulation: motif, dateAnnulation: new Date().toISOString(), annuleParUserId: req.user.id };
    patch.historique = trace(Object.assign({}, c, patch), req, 'annulation', motif);
    const maj = db.update(CMD, c.id, patch);
    ctx.audit(req, 'statut', CMD, maj.id, `Commande ${maj.numero} annulée — ${motif}`);
    const cibles = destinataires(req, maj, [maj.demandeurUserId, maj.createdBy]);
    if (cibles.length) ctx.notify(cibles, { titre: `Commande annulée : ${maj.numero}`, message: `${ctx.nomUser(req.user.id)} a annulé la commande : ${motif}`, lien: '#/achats/commande/' + maj.id, type: 'alerte' });
    return detailCommande(req, maj);
  }, { perm: [MODULE, 'voir'] });

  // =================================================================================================
  // FACTURES
  // =================================================================================================
  function numeroFournisseurLibre(fournisseurId, numero, existant) {
    const n = normaliser(numero).replace(/\s+/g, '');
    return !db.findOne(FAC, (f) => Number(f.fournisseurId) === Number(fournisseurId) && f.statut !== SF.annulee && normaliser(f.numeroFournisseur).replace(/\s+/g, '') === n && (!existant || f.id !== existant.id));
  }

  /** Rapprochement facture ↔ commande (commandé, reçu, déjà facturé par d'autres factures). */
  function calculerRapprochement(f, commande) {
    if (!commande) return null;
    const commandeHT = num((commande.totaux || calculerTotaux(commande.lignes)).ht);
    const recuHT = montantRecuHT(commande);
    const autres = db.list(FAC, (x) => Number(x.commandeId) === commande.id && x.statut !== SF.annulee && x.id !== f.id);
    const dejaFactureHT = arrondi(autres.reduce((s, x) => s + num(x.montantHT), 0));
    const base = recuHT > 0 ? 'recu' : 'commande';
    const reference = base === 'recu' ? recuHT : commandeHT;
    const ecartHT = arrondi(num(f.montantHT) + dejaFactureHT - reference);
    return { commandeId: commande.id, commandeNumero: commande.numero, commandeHT, recuHT, dejaFactureHT, factureHT: arrondi(num(f.montantHT)), base, referenceHT: reference, ecartHT, conforme: Math.abs(ecartHT) <= TOLERANCE + 1e-9, date: new Date().toISOString() };
  }
  function recalculerRapprochements(commandeId) {
    const commande = db.get(CMD, commandeId);
    if (!commande) return;
    for (const f of db.list(FAC, (x) => Number(x.commandeId) === Number(commandeId) && !finauxFac().has(x.statut))) {
      db.update(FAC, f.id, { rapprochement: calculerRapprochement(f, commande) });
    }
  }

  function normaliserLignesFacture(lignes) {
    if (!Array.isArray(lignes)) throw new HttpError(400, 'Lignes de facture invalides (liste attendue)');
    if (lignes.length > MAX_LIGNES) throw new HttpError(400, `Une facture comporte au maximum ${MAX_LIGNES} lignes`);
    const tvaDefaut = num(cfgAchats().tauxTVA);
    return lignes.map((l, i) => {
      const n = `Ligne ${i + 1}`;
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw new HttpError(400, `${n} : ligne invalide`);
      const designation = texte(l.designation, `${n} : désignation`, { requis: true, max: 300 });
      const quantite = arrondi(nombre(l.quantite, `${n} : quantité`, { requis: true, strictPositif: true, max: 1e7 }), 3);
      const pu = arrondi(nombre(l.prixUnitaireHT, `${n} : prix unitaire HT`, { requis: true, min: 0, max: 1e8 }), 4);
      const tauxTVA = arrondi(nombre(l.tauxTVA, `${n} : taux de TVA`, { min: 0, max: 100, defaut: tvaDefaut }), 2);
      return { designation, quantite, prixUnitaireHT: pu, tauxTVA, montantHT: arrondi(quantite * pu) };
    });
  }

  const CHAMPS_FACTURE_VALIDEE = ['objet', 'categorieCode', 'dateEcheance', 'champs'];

  function validerFacture(req, body, existant) {
    const b = objet(body);
    const val = (k) => (b[k] === undefined ? (existant ? existant[k] : undefined) : b[k]);
    const verrouillee = existant && existant.statut === SF.validee;
    if (verrouillee) {
      const interdits = ['fournisseurId', 'numeroFournisseur', 'secteurId', 'commandeId', 'otId', 'personnelId', 'dateFacture', 'montantHT', 'montantTVA', 'montantTTC', 'lignes', 'tauxTVA'];
      const change = interdits.filter((k) => b[k] !== undefined && JSON.stringify(b[k] == null ? '' : b[k]) !== JSON.stringify(existant[k] == null ? '' : existant[k]) && !(typeof existant[k] === 'number' && Number(b[k]) === existant[k]));
      if (change.length) throw new HttpError(400, `La facture ${existant.numero} est validée (bon à payer) : ses montants et références ne sont plus modifiables — mettez-la en litige pour la corriger`);
    }
    const out = {};
    // Les références (commande, OT, fiche du personnel) sont contrôlées — périmètre en écriture, même site que la
    // facture — lorsqu'elles sont désignées ou changent, pas à chaque modification d'un autre champ : une référence
    // devenue invisible pour l'utilisateur ou supprimée depuis ne bloque pas la mise à jour de la facture.
    const change = (k) => !existant || idRef(val(k), k) !== idRef(existant[k], k);
    // Commande liée
    const commandeId = idRef(val('commandeId'), 'Commande');
    const commande = commandeId != null ? db.get(CMD, commandeId) : null;
    if (commandeId != null && change('commandeId')) {
      if (!referenceEcriture(req, commande)) throw new HttpError(400, 'Commande introuvable');
      if ([SC.brouillon, SC.aValider, SC.annulee].includes(commande.statut)) {
        throw new HttpError(400, `La commande ${commande.numero} n'est pas validée (${libelle('statutsCommande', commande.statut)}) : elle ne peut pas être facturée`);
      }
    }
    out.commandeId = commandeId;
    // Fournisseur
    let fournisseurId = idRef(val('fournisseurId'), 'Fournisseur');
    if (fournisseurId == null && commande) fournisseurId = Number(commande.fournisseurId);
    const fournisseur = fournisseurValide(fournisseurId, { creation: !existant || fournisseurId !== Number(existant.fournisseurId) });
    if (commande && Number(commande.fournisseurId) !== fournisseurId) throw new HttpError(400, `Le fournisseur de la facture doit être celui de la commande ${commande.numero} (${nomFournisseur(commande.fournisseurId)})`);
    out.fournisseurId = fournisseurId;
    // Références OT / personnel
    out.otId = idRef(val('otId'), 'Ordre de travail');
    out.personnelId = idRef(val('personnelId'), 'Personnel');
    const otBrut = out.otId != null ? db.get('ot', out.otId) : null;
    const personnelBrut = out.personnelId != null ? db.get('personnel', out.personnelId) : null;
    // Site / service : saisi, ou repris de la commande, de l'OT ou de la fiche du personnel
    let secteurId = val('secteurId');
    if (secteurId == null || secteurId === '') secteurId = commande ? commande.secteurId : (otBrut ? otBrut.secteurId : (personnelBrut ? personnelBrut.secteurId : null));
    out.secteurId = verrouillee ? Number(existant.secteurId) : secteurEcriture(req, secteurId);
    // Cohérence de site : une facture est rattachée aux éléments de son propre site
    if (commande && (change('commandeId') || change('secteurId')) && !memeSite(commande.secteurId, out.secteurId)) throw new HttpError(400, `La commande ${commande.numero} appartient à un autre site que celui de la facture`);
    const ot = out.otId != null && (change('otId') || change('secteurId')) ? otLisible(req, out.otId, 'Ordre de travail', out.secteurId) : otBrut;
    const personnel = out.personnelId != null && (change('personnelId') || change('secteurId')) ? personnelLisible(req, out.personnelId, out.secteurId) : personnelBrut;
    // Numéros
    out.numeroFournisseur = texte(val('numeroFournisseur'), 'N° de facture du fournisseur', { requis: true, max: 60 });
    if (!numeroFournisseurLibre(fournisseurId, out.numeroFournisseur, existant)) throw new HttpError(400, `La facture n° « ${out.numeroFournisseur} » de ${fournisseur.nom} est déjà enregistrée`);
    out.objet = texte(val('objet'), 'Objet', { max: 200 }) || (commande && !existant ? String(commande.objet || '') : '');
    let catDefaut = commande ? commande.categorieCode : null;
    if (!catDefaut && personnel) catDefaut = 'formation';
    if (!catDefaut && ot) catDefaut = 'sous_traitance';
    out.categorieCode = codeListe('categoriesDepense', val('categorieCode'), 'Catégorie de dépense', catDefaut);
    // Dates
    out.dateFacture = dateJour(val('dateFacture'), 'Date de facture', { defaut: jourLocal() });
    if ((!existant || b.dateFacture !== undefined) && out.dateFacture > ajouterJours(jourLocal(), 1)) throw new HttpError(400, 'La date de facture ne peut pas être dans le futur');
    const delai = Number(cfgAchats().delaiPaiementJours);
    const echeanceSaisie = b.dateEcheance !== undefined ? b.dateEcheance : (existant && b.dateFacture === undefined ? existant.dateEcheance : null);
    out.dateEcheance = dateJour(echeanceSaisie, 'Date d\'échéance', { defaut: ajouterJours(out.dateFacture, Number.isFinite(delai) ? delai : 30) });
    if (out.dateEcheance < out.dateFacture) throw new HttpError(400, 'La date d\'échéance ne peut pas précéder la date de facture');
    // Lignes (facultatives) et montants
    const montantsFournis = ['montantHT', 'montantTVA', 'montantTTC', 'tauxTVA', 'lignes'].some((k) => b[k] !== undefined);
    if (existant && !montantsFournis) {
      Object.assign(out, { lignes: existant.lignes || [], tauxTVA: existant.tauxTVA, montantHT: existant.montantHT, montantTVA: existant.montantTVA, montantTTC: existant.montantTTC });
    } else {
      const anciennes = existant ? existant.lignes || [] : [];
      out.lignes = b.lignes !== undefined ? normaliserLignesFacture(b.lignes) : anciennes;
      let tl = out.lignes.length ? calculerTotaux(out.lignes) : null;
      out.tauxTVA = arrondi(nombre(val('tauxTVA'), 'Taux de TVA', { min: 0, max: 100, defaut: num(cfgAchats().tauxTVA) }), 2);
      let ht = nombre(b.montantHT !== undefined ? b.montantHT : (existant && b.lignes === undefined ? existant.montantHT : undefined), 'Montant HT', { min: 0, max: 1e9 });
      if (ht == null && tl) ht = tl.ht;
      if (ht == null) throw new HttpError(400, 'Le montant HT est obligatoire');
      ht = arrondi(ht);
      if (tl && Math.abs(ht - tl.ht) > TOLERANCE + 1e-9) {
        if (b.lignes !== undefined) throw new HttpError(400, `Le montant HT (${montantTxt(ht)}) ne correspond pas au total des lignes (${montantTxt(tl.ht)})`);
        // Montant corrigé sans nouveau détail (litige, formulaire sans éditeur de lignes) : le détail des lignes est retiré
        out.lignes = []; tl = null; out.detailLignesRetire = anciennes.length;
      }
      let tva = nombre(b.montantTVA, 'Montant de TVA', { min: 0, max: 1e9 });
      if (tva == null) tva = tl ? tl.tva : arrondi((ht * out.tauxTVA) / 100);
      tva = arrondi(tva);
      let ttc = nombre(b.montantTTC, 'Montant TTC', { min: 0, max: 2e9 });
      if (ttc == null) ttc = arrondi(ht + tva);
      ttc = arrondi(ttc);
      if (Math.abs(ttc - arrondi(ht + tva)) > TOLERANCE + 1e-9) throw new HttpError(400, `Montant TTC incohérent : ${montantTxt(ttc)} saisi pour ${montantTxt(ht)} HT + ${montantTxt(tva)} de TVA (le TTC doit être égal au HT + TVA, à 0,01 € près)`);
      Object.assign(out, { montantHT: ht, montantTVA: tva, montantTTC: ttc });
    }
    if (b.champs !== undefined || !existant) out.champs = ctx.champsPerso(FAC, b.champs || (existant && existant.champs) || {});
    out.rapprochement = calculerRapprochement(Object.assign({ id: existant ? existant.id : null }, out), commande);
    if (verrouillee) {
      const filtre = { rapprochement: out.rapprochement };
      for (const k of CHAMPS_FACTURE_VALIDEE) if (out[k] !== undefined) filtre[k] = out[k];
      return filtre;
    }
    return out;
  }

  function factureEnRetard(f, jour) { return [SF.recue, SF.aValider, SF.validee, SF.litige].includes(f.statut) && !!f.dateEcheance && f.dateEcheance < (jour || jourLocal()); }

  function actionsFacture(req, f) {
    const ecr = ecritureSite(req, f);
    const st = f.statut;
    const final = finauxFac().has(st);
    const mod = can(req, 'modifier');
    const cre = can(req, 'creer');
    const proprio = Number(f.createdBy) === req.user.id;
    // Comme pour les commandes : au-delà du seuil de validation, l'auteur de la saisie ne donne pas lui-même le bon à payer
    const propreInterdite = proprio && !req.perms.estAdmin && num(f.montantHT) >= num(cfgAchats().seuilValidationHT);
    const validable = [SF.recue, SF.aValider, SF.litige].includes(st);
    return {
      modifier: ecr && (mod ? [SF.recue, SF.aValider, SF.litige, SF.validee].includes(st) : (cre && proprio && st === SF.recue)),
      soumettre: ecr && st === SF.recue && (mod || (cre && proprio)),
      valider: ecr && can(req, 'valider') && validable && !propreInterdite,
      validationPropreInterdite: validable && propreInterdite,
      payer: ecr && can(req, 'valider') && st === SF.validee,
      litige: ecr && mod && [SF.recue, SF.aValider, SF.validee].includes(st),
      annuler: ecr && mod && !final,
      supprimer: ecr && can(req, 'supprimer') && [SF.recue, SF.aValider, SF.annulee].includes(st) && !f.datePaiement,
      documents: ecr && !final && (mod || (cre && proprio && st === SF.recue)),
      commenter: ecr,
    };
  }

  function resumeFacture(f, refs, jour) {
    const { documents, historique, commentaires, ...reste } = f;
    const four = refs.fournisseurs.get(Number(f.fournisseurId));
    const siteId = refs.siteDe(f.secteurId);
    const c = f.commandeId != null ? refs.commandes.get(Number(f.commandeId)) : null;
    const o = f.otId != null ? refs.ot.get(Number(f.otId)) : null;
    const p = f.personnelId != null ? refs.personnel.get(Number(f.personnelId)) : null;
    const retard = factureEnRetard(f, jour);
    const docs = documents || [];
    return Object.assign(reste, {
      fournisseurNom: four ? four.nom || '' : '',
      secteurNom: nomSecteur(refs, f.secteurId), secteurChemin: cheminSecteur(refs, f.secteurId),
      siteId, siteNom: siteId != null ? nomSecteur(refs, siteId) : '',
      commandeNumero: c ? c.numero : '', otNumero: o ? o.numero || `#${o.id}` : '', otTitre: o ? o.titre || '' : '',
      personnelNom: p ? nomPersonnel(p) : '',
      enRetard: retard, joursRetard: retard ? joursEntre(f.dateEcheance, jour || jourLocal()) : 0,
      joursAvantEcheance: f.dateEcheance && !finauxFac().has(f.statut) ? joursEntre(jour || jourLocal(), f.dateEcheance) : null,
      nbDocuments: docs.length, nbCommentaires: (commentaires || []).length,
      aPdf: docs.some((d) => d.type === 'application/pdf'),
      statutLibelle: libelle('statutsFacture', f.statut),
      categorieLibelle: libelle('categoriesDepense', f.categorieCode),
      modePaiementLibelle: f.modePaiement ? libModePaiement(f.modePaiement) : '',
    });
  }

  function detailFacture(req, f) {
    const refs = references();
    const jour = jourLocal();
    const r = resumeFacture(f, refs, jour);
    const four = refs.fournisseurs.get(Number(f.fournisseurId));
    const c = f.commandeId != null ? db.get(CMD, f.commandeId) : null;
    r.fournisseur = four ? { id: four.id, nom: four.nom || '', adresse: four.adresse || '', telephone: four.telephone || '', email: four.email || '', siret: four.siret || '' } : null;
    const cVisible = !!c && perms.canSeeRecord(req.perms, req.user, c);
    r.commande = c ? { id: c.id, numero: c.numero, statut: c.statut, visible: cVisible, objet: cVisible ? c.objet || '' : '', totaux: cVisible ? c.totaux : null, dateCommande: cVisible ? c.dateCommande : null } : null;
    r.rapprochement = !finauxFac().has(f.statut) ? calculerRapprochement(f, c) : (f.rapprochement || calculerRapprochement(f, c));
    r.documents = (f.documents || []).map(resumeDoc);
    r.commentaires = (f.commentaires || []).map((x) => Object.assign({}, x, { userNom: refs.users.get(Number(x.userId)) || '' }));
    r.historique = (f.historique || []).slice().reverse().map((h) => Object.assign({}, h, { userNom: refs.users.get(Number(h.userId)) || (h.userId == null ? 'Système' : '') }));
    r.createdByNom = refs.users.get(Number(f.createdBy)) || '';
    r.valideurNom = f.valideurUserId != null ? refs.users.get(Number(f.valideurUserId)) || '' : '';
    r.payeParNom = f.payeParUserId != null ? refs.users.get(Number(f.payeParUserId)) || '' : '';
    r.actions = actionsFacture(req, f);
    r.lectureSeule = !ecritureSite(req, f);
    return r;
  }

  function filtrerFactures(req) {
    const q = req.query || {};
    const jour = jourLocal();
    let rows = ctx.scope(req, db.list(FAC));
    if (q.statut) { const s = new Set(String(q.statut).split(',').filter(Boolean)); rows = rows.filter((f) => s.has(f.statut)); }
    if (q.fournisseurId) rows = rows.filter((f) => Number(f.fournisseurId) === Number(q.fournisseurId));
    if (q.secteurId) { const ids = new Set(perms.secteursDescendants(db, [Number(q.secteurId)])); rows = rows.filter((f) => ids.has(Number(f.secteurId))); }
    if (q.categorieCode) rows = rows.filter((f) => f.categorieCode === q.categorieCode);
    const du = dateFiltre(q.du, 'Du'); const au = dateFiltre(q.au, 'Au');
    if (du) rows = rows.filter((f) => String(f.dateFacture || '') >= du);
    if (au) rows = rows.filter((f) => String(f.dateFacture || '') <= au);
    const echDu = dateFiltre(q.echeanceDu, 'Échéance du'); const echAu = dateFiltre(q.echeanceAu, 'Échéance au');
    if (echDu) rows = rows.filter((f) => String(f.dateEcheance || '') >= echDu);
    if (echAu) rows = rows.filter((f) => String(f.dateEcheance || '') <= echAu);
    if (q.echeanceDepassee === '1' || q.enRetard === '1') rows = rows.filter((f) => factureEnRetard(f, jour));
    if (q.aPayer === '1') rows = rows.filter((f) => [SF.recue, SF.aValider, SF.validee].includes(f.statut));
    if (q.commandeId) rows = rows.filter((f) => Number(f.commandeId) === Number(q.commandeId));
    if (q.otId) rows = rows.filter((f) => Number(f.otId) === Number(q.otId));
    if (q.personnelId) rows = rows.filter((f) => Number(f.personnelId) === Number(q.personnelId));
    if (q.recherche) {
      const s = normaliser(q.recherche);
      const fours = new Map(db.list('fournisseurs').map((x) => [x.id, x.nom || '']));
      const cmds = new Map(db.list(CMD).map((x) => [x.id, x.numero]));
      rows = rows.filter((f) => [f.numero, f.numeroFournisseur, f.objet, fours.get(Number(f.fournisseurId)), cmds.get(Number(f.commandeId)), f.referencePaiement].some((v) => normaliser(v).includes(s)));
    }
    return rows.sort((a, b) => String(b.dateFacture || '').localeCompare(String(a.dateFacture || '')) || String(b.numero || '').localeCompare(String(a.numero || ''), 'fr', { numeric: true }));
  }

  function getFacture(req, id) { return getEcriture(req, FAC, id); }
  function valideursFacture(f, exclure) {
    const exclus = new Set((exclure || []).filter((x) => x != null).map(Number));
    return ctx.usersAvecDroit(MODULE, 'valider', (u, p) => perms.canSeeRecord(p, u, f, { ecriture: true })).map((u) => u.id).filter((id) => !exclus.has(id));
  }

  // ----- Routes : factures --------------------------------------------------------------------------
  router.get('/api/factures', async (req) => {
    const refs = references(); const jour = jourLocal();
    return filtrerFactures(req).map((f) => resumeFacture(f, refs, jour));
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/factures/:id', async (req) => detailFacture(req, getFacture(req, req.params.id)), { perm: [MODULE, 'voir'] });

  router.get('/api/factures/:id/rapprochement', async (req) => {
    const f = getFacture(req, req.params.id);
    if (f.commandeId == null) return { facture: { id: f.id, numero: f.numero, montantHT: f.montantHT }, commande: null, rapprochement: null, lignes: [], autresFactures: [], receptions: [] };
    const c = db.get(CMD, f.commandeId);
    if (!c) return { facture: { id: f.id, numero: f.numero, montantHT: f.montantHT }, commande: null, rapprochement: null, lignes: [], autresFactures: [], receptions: [] };
    // Commande hors du périmètre de l'utilisateur : agrégats du rapprochement seulement (ni lignes, ni réceptions)
    const visible = perms.canSeeRecord(req.perms, req.user, c);
    const autres = ctx.scope(req, db.list(FAC, (x) => Number(x.commandeId) === c.id && x.id !== f.id)).sort((a, b) => String(a.dateFacture).localeCompare(String(b.dateFacture)));
    return {
      facture: { id: f.id, numero: f.numero, numeroFournisseur: f.numeroFournisseur, montantHT: f.montantHT, montantTTC: f.montantTTC, dateFacture: f.dateFacture },
      commande: { id: c.id, numero: c.numero, statut: c.statut, visible, objet: visible ? c.objet || '' : '', dateCommande: visible ? c.dateCommande : null, totaux: visible ? c.totaux : null },
      rapprochement: calculerRapprochement(f, c),
      lignes: visible ? (c.lignes || []).map((l, index) => ({ index, designation: l.designation, referenceFournisseur: l.referenceFournisseur || '', uniteCode: l.uniteCode || '', quantite: l.quantite, quantiteRecue: num(l.quantiteRecue), prixUnitaireHT: l.prixUnitaireHT, montantHT: arrondi(num(l.quantite) * num(l.prixUnitaireHT)), montantRecuHT: arrondi(num(l.quantiteRecue) * num(l.prixUnitaireHT)) })) : [],
      autresFactures: autres.map((x) => ({ id: x.id, numero: x.numero, numeroFournisseur: x.numeroFournisseur, dateFacture: x.dateFacture, montantHT: x.montantHT, statut: x.statut, compte: x.statut !== SF.annulee })),
      receptions: visible ? (c.receptions || []).map((x) => ({ date: x.date, bonLivraison: x.bonLivraison || '', montantHT: x.montantHT, userNom: ctx.nomUser(x.userId) })) : [],
      tolerance: TOLERANCE,
    };
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/factures', async (req) => {
    const b = objet(req.body);
    const data = validerFacture(req, b, null);
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 2000 });
    Object.assign(data, {
      numero: numeroUnique(FAC, 'fac', 'FAC-{annee}-{num:4}'), statut: SF.recue,
      valideurUserId: null, dateValidation: null, datePaiement: null, modePaiement: null, referencePaiement: '', payeParUserId: null,
      documents: [], commentaires: commentaire ? [{ userId: req.user.id, date: new Date().toISOString(), texte: commentaire }] : [], createdBy: req.user.id,
    });
    data.historique = trace(data, req, 'creation', data.rapprochement ? `Rapprochement avec ${data.rapprochement.commandeNumero} : ${data.rapprochement.conforme ? 'conforme' : 'écart de ' + montantTxt(data.rapprochement.ecartHT) + ' HT'}` : '');
    delete data.detailLignesRetire;
    let f = db.insert(FAC, data);
    ctx.audit(req, 'creation', FAC, f.id, `Facture ${f.numero} (n° ${f.numeroFournisseur}, ${nomFournisseur(f.fournisseurId)}) — ${montantTxt(f.montantTTC)} TTC`);
    if (f.commandeId != null) recalculerRapprochements(f.commandeId);
    if (b.soumettre === true) f = soumettreFacture(req, f);
    return detailFacture(req, db.get(FAC, f.id) || f);
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/factures/:id', async (req) => {
    const f = getFacture(req, req.params.id);
    if (finauxFac().has(f.statut)) throw new HttpError(400, `La facture ${f.numero} est ${libelle('statutsFacture', f.statut).toLowerCase()} : elle n'est plus modifiable`);
    if (!actionsFacture(req, f).modifier) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    const data = validerFacture(req, req.body, f);
    const lignesRetirees = data.detailLignesRetire; delete data.detailLignesRetire;
    if (data.dateEcheance && data.dateEcheance !== f.dateEcheance) data.retardNotifie = false;
    data.historique = trace(Object.assign({}, f, data), req, 'modification', [
      data.montantTTC != null && data.montantTTC !== f.montantTTC ? `Montant TTC ${montantTxt(f.montantTTC)} → ${montantTxt(data.montantTTC)}` : '',
      lignesRetirees ? `montant corrigé : le détail des ${lignesRetirees} ligne(s) a été retiré` : '',
    ].filter(Boolean).join(' — '));
    const maj = db.update(FAC, f.id, data);
    ctx.audit(req, 'modification', FAC, maj.id, `Facture ${maj.numero} (n° ${maj.numeroFournisseur}) — ${montantTxt(maj.montantTTC)} TTC${lignesRetirees ? ' — détail des lignes retiré' : ''}`);
    for (const id of new Set([f.commandeId, maj.commandeId].filter((x) => x != null).map(Number))) recalculerRapprochements(id);
    return detailFacture(req, db.get(FAC, maj.id) || maj);
  }, { perm: [MODULE, 'voir'] });

  router.delete('/api/factures/:id', async (req) => {
    const f = getFacture(req, req.params.id);
    if (f.statut === SF.payee || f.datePaiement) throw new HttpError(400, 'Une facture payée ne peut pas être supprimée');
    if (![SF.recue, SF.aValider, SF.annulee].includes(f.statut)) throw new HttpError(400, `La facture ${f.numero} est ${libelle('statutsFacture', f.statut).toLowerCase()} : annulez-la au lieu de la supprimer`);
    db.remove(FAC, f.id);
    ctx.audit(req, 'suppression', FAC, f.id, `Facture ${f.numero} (n° ${f.numeroFournisseur}, ${nomFournisseur(f.fournisseurId)}) — ${montantTxt(f.montantTTC)} TTC`);
    if (f.commandeId != null) recalculerRapprochements(f.commandeId);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  function soumettreFacture(req, f) {
    const patch = { statut: SF.aValider, dateSoumission: new Date().toISOString() };
    patch.historique = trace(Object.assign({}, f, patch), req, 'soumission', '');
    const maj = db.update(FAC, f.id, patch);
    ctx.audit(req, 'statut', FAC, maj.id, `Facture ${maj.numero} soumise à validation (bon à payer)`);
    const cibles = valideursFacture(maj, [req.user.id]);
    if (cibles.length) ctx.notify(cibles, { titre: `Facture à valider : ${maj.numero}`, message: `${nomFournisseur(maj.fournisseurId)} — n° ${maj.numeroFournisseur} — ${montantTxt(maj.montantTTC)} TTC, échéance le ${csvDate(maj.dateEcheance)}`, lien: '#/achats/facture/' + maj.id, type: 'alerte' });
    return maj;
  }

  router.post('/api/factures/:id/soumettre', async (req) => {
    const f = getFacture(req, req.params.id);
    if (f.statut !== SF.recue) throw new HttpError(400, `La facture ${f.numero} n'est pas au statut « ${libelle('statutsFacture', SF.recue)} »`);
    if (!actionsFacture(req, f).soumettre) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    return detailFacture(req, soumettreFacture(req, f));
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/factures/:id/valider', async (req) => {
    const f = getFacture(req, req.params.id);
    if (![SF.recue, SF.aValider, SF.litige].includes(f.statut)) throw new HttpError(400, `La facture ${f.numero} ne peut pas être validée (statut : ${libelle('statutsFacture', f.statut)})`);
    const seuil = num(cfgAchats().seuilValidationHT);
    if (num(f.montantHT) >= seuil && Number(f.createdBy) === req.user.id && !req.perms.estAdmin) {
      throw new HttpError(403, `Vous ne pouvez pas donner le bon à payer d'une facture que vous avez saisie au-delà du seuil de ${montantTxt(seuil)} HT : un autre valideur doit l'approuver`);
    }
    const b = objet(req.body);
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 1000 });
    const c = f.commandeId != null ? db.get(CMD, f.commandeId) : null;
    const rap = calculerRapprochement(f, c);
    if (rap && !rap.conforme && b.forcer !== true) {
      throw new HttpError(409, `Écart de rapprochement de ${montantTxt(rap.ecartHT)} HT avec la commande ${rap.commandeNumero} : confirmez la validation malgré l'écart`, { rapprochement: rap });
    }
    if (rap && !rap.conforme && !commentaire) throw new HttpError(400, 'Justifiez la validation malgré l\'écart de rapprochement (commentaire obligatoire)');
    const patch = { statut: SF.validee, valideurUserId: req.user.id, dateValidation: new Date().toISOString(), rapprochement: rap };
    if (f.statut === SF.litige) patch.litigeResolu = new Date().toISOString();
    patch.historique = trace(Object.assign({}, f, patch), req, 'validation', [rap && !rap.conforme ? `Validée malgré un écart de ${montantTxt(rap.ecartHT)} HT` : '', commentaire].filter(Boolean).join(' — '));
    const maj = db.update(FAC, f.id, patch);
    ctx.audit(req, 'validation', FAC, maj.id, `Facture ${maj.numero} validée (bon à payer) — ${montantTxt(maj.montantTTC)} TTC${rap && !rap.conforme ? ` — écart de rapprochement ${montantTxt(rap.ecartHT)} HT accepté` : ''}${commentaire ? ' — ' + commentaire : ''}`);
    ctx.emit('achats:factureValidee', { facture: maj });
    return detailFacture(req, maj);
  }, { perm: [MODULE, 'valider'] });

  router.post('/api/factures/:id/payer', async (req) => {
    const f = getFacture(req, req.params.id);
    if (f.statut !== SF.validee) throw new HttpError(400, `Seule une facture validée (bon à payer) peut être payée (statut actuel : ${libelle('statutsFacture', f.statut)})`);
    const b = objet(req.body);
    const datePaiement = dateJour(b.datePaiement, 'Date de paiement', { defaut: jourLocal() });
    if (datePaiement < f.dateFacture) throw new HttpError(400, 'La date de paiement ne peut pas précéder la date de facture');
    if (datePaiement > ajouterJours(jourLocal(), 1)) throw new HttpError(400, 'La date de paiement ne peut pas être dans le futur');
    const modePaiement = String(b.modePaiement == null ? '' : b.modePaiement);
    if (!modePaiement) throw new HttpError(400, 'Le mode de paiement est obligatoire');
    if (!modesPaiement().some((m) => m.code === modePaiement)) throw new HttpError(400, `Mode de paiement invalide : « ${modePaiement} »`);
    const referencePaiement = texte(b.reference !== undefined ? b.reference : b.referencePaiement, 'Référence du paiement', { max: 100 });
    const patch = { statut: SF.payee, datePaiement, modePaiement, referencePaiement, payeParUserId: req.user.id };
    patch.historique = trace(Object.assign({}, f, patch), req, 'paiement', `${libModePaiement(modePaiement)} du ${csvDate(datePaiement)}${referencePaiement ? ' — réf. ' + referencePaiement : ''}`);
    const maj = db.update(FAC, f.id, patch);
    ctx.audit(req, 'statut', FAC, maj.id, `Facture ${maj.numero} payée le ${csvDate(datePaiement)} (${libModePaiement(modePaiement)}${referencePaiement ? ', réf. ' + referencePaiement : ''}) — ${montantTxt(maj.montantTTC)} TTC`);
    ctx.emit('achats:facturePayee', { facture: maj });
    return detailFacture(req, maj);
  }, { perm: [MODULE, 'valider'] });

  router.post('/api/factures/:id/litige', async (req) => {
    const f = getFacture(req, req.params.id);
    if (![SF.recue, SF.aValider, SF.validee].includes(f.statut)) throw new HttpError(400, `La facture ${f.numero} ne peut pas être mise en litige (statut : ${libelle('statutsFacture', f.statut)})`);
    const motif = texte(objet(req.body).motif, 'Motif du litige', { requis: true, max: 1000 });
    const patch = { statut: SF.litige, motifLitige: motif, dateLitige: new Date().toISOString() };
    patch.historique = trace(Object.assign({}, f, patch), req, 'litige', motif);
    patch.commentaires = (f.commentaires || []).concat([{ userId: req.user.id, date: new Date().toISOString(), texte: `Litige : ${motif}` }]).slice(-MAX_COMMENTAIRES);
    const maj = db.update(FAC, f.id, patch);
    ctx.audit(req, 'statut', FAC, maj.id, `Facture ${maj.numero} en litige — ${motif}`);
    const c = maj.commandeId != null ? db.get(CMD, maj.commandeId) : null;
    const cibles = destinataires(req, maj, [maj.createdBy, c ? c.demandeurUserId : null]);
    if (cibles.length) ctx.notify(cibles, { titre: `Facture en litige : ${maj.numero}`, message: `${nomFournisseur(maj.fournisseurId)} — n° ${maj.numeroFournisseur} (${montantTxt(maj.montantTTC)} TTC) : ${motif}`, lien: '#/achats/facture/' + maj.id, type: 'alerte' });
    return detailFacture(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/factures/:id/annuler', async (req) => {
    const f = getFacture(req, req.params.id);
    if (finauxFac().has(f.statut)) throw new HttpError(400, `La facture ${f.numero} est déjà ${libelle('statutsFacture', f.statut).toLowerCase()}`);
    const motif = texte(objet(req.body).motif, 'Motif de l\'annulation', { requis: true, max: 1000 });
    const patch = { statut: SF.annulee, motifAnnulation: motif, dateAnnulation: new Date().toISOString(), annuleParUserId: req.user.id };
    patch.historique = trace(Object.assign({}, f, patch), req, 'annulation', motif);
    const maj = db.update(FAC, f.id, patch);
    ctx.audit(req, 'statut', FAC, maj.id, `Facture ${maj.numero} annulée — ${motif}`);
    if (maj.commandeId != null) recalculerRapprochements(maj.commandeId);
    return detailFacture(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/factures/:id/commentaires', async (req) => {
    const f = getFacture(req, req.params.id);
    const t = texte(objet(req.body).texte, 'Commentaire', { requis: true, max: 2000 });
    const commentaires = (f.commentaires || []).concat([{ userId: req.user.id, date: new Date().toISOString(), texte: t }]).slice(-MAX_COMMENTAIRES);
    const maj = db.update(FAC, f.id, { commentaires });
    ctx.audit(req, 'commentaire', FAC, maj.id, `Facture ${maj.numero} : ${t.slice(0, 200)}`);
    return detailFacture(req, maj);
  }, { perm: [MODULE, 'voir'] });

  // =================================================================================================
  // DOCUMENTS (commandes et factures)
  // =================================================================================================
  function ajouterDocument(req, col, record, b, typesAutorises) {
    const nomDoc = texte(b.nom, 'Nom du document', { requis: true, max: 150 }).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    const contenu = typeof b.contenu === 'string' ? b.contenu : '';
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w.-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(contenu);
    if (!m) throw new HttpError(400, 'Contenu du document invalide (données base64 attendues)');
    const base64 = m[2].replace(/\s/g, '');
    const taille = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (taille <= 0) throw new HttpError(400, 'Le document est vide');
    if (taille > TAILLE_MAX_DOC) throw new HttpError(400, `Document trop volumineux (${(taille / 1024 / 1024).toFixed(1).replace('.', ',')} Mo, maximum 10 Mo)`);
    const type = String(b.type || m[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!typesAutorises.includes(type)) throw new HttpError(400, col === FAC ? 'Format non accepté : joignez la facture au format PDF ou image (PNG, JPEG, GIF, WebP)' : 'Format non accepté (PDF, image, texte, Word, Excel ou OpenDocument)');
    const buf = Buffer.from(base64, 'base64');
    if (!signatureValide(type, buf)) throw new HttpError(400, 'Le contenu du fichier ne correspond pas à son format déclaré');
    const docs = record.documents || [];
    if (docs.length >= MAX_DOCS) throw new HttpError(400, `Nombre maximal de documents atteint (${MAX_DOCS})`);
    const doc = { nom: nomDoc, type, taille, contenu: `data:${type};base64,${base64}`, date: new Date().toISOString(), userId: req.user.id, description: texte(b.description, 'Description', { max: 300 }) };
    const maj = db.update(col, record.id, { documents: docs.concat([doc]) });
    ctx.audit(req, 'document', col, maj.id, `${col === FAC ? 'Facture' : 'Commande'} ${maj.numero} : document ajouté — ${nomDoc} (${Math.max(1, Math.round(taille / 1024))} Ko)`);
    return maj;
  }
  function indexDoc(req, record) {
    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (record.documents || []).length) throw new HttpError(404, 'Document introuvable');
    return idx;
  }
  function servirDocument(req, res, doc) {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(doc.contenu || '');
    if (!m) throw new HttpError(500, 'Document corrompu');
    const buf = Buffer.from(m[2], 'base64');
    const type = TYPES_COMMANDE.includes(doc.type) ? doc.type : 'application/octet-stream';
    const inline = (estImage(type) || type === 'application/pdf') && req.query.telecharger !== '1';
    const nomFichier = encodeURIComponent(doc.nom || 'document').replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${nomFichier}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': type === 'application/pdf' ? "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:" : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      'Cache-Control': 'private, max-age=300',
    });
    res.end(buf);
  }

  router.post('/api/commandes/:id/documents', async (req) => {
    const c = getCommande(req, req.params.id);
    if (!actionsCommande(req, c).documents) throw new HttpError(403, finauxCmd().has(c.statut) && !can(req, 'modifier') ? 'Commande clôturée : ajout de document réservé aux utilisateurs autorisés' : 'Droit insuffisant : Achats & factures › Modifier');
    const maj = ajouterDocument(req, CMD, c, objet(req.body), TYPES_COMMANDE);
    return { ok: true, documents: (maj.documents || []).map(resumeDoc) };
  }, { perm: [MODULE, 'voir'] });
  router.get('/api/commandes/:id/documents/:index', async (req, res) => {
    const c = getCommande(req, req.params.id);
    servirDocument(req, res, c.documents[indexDoc(req, c)]);
  }, { perm: [MODULE, 'voir'] });
  router.delete('/api/commandes/:id/documents/:index', async (req) => {
    const c = getCommande(req, req.params.id);
    if (!actionsCommande(req, c).documents) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    const idx = indexDoc(req, c);
    const docs = c.documents.slice(); const [sup] = docs.splice(idx, 1);
    const maj = db.update(CMD, c.id, { documents: docs });
    ctx.audit(req, 'document', CMD, maj.id, `Commande ${maj.numero} : document supprimé — ${sup.nom}`);
    return { ok: true, documents: docs.map(resumeDoc) };
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/factures/:id/documents', async (req) => {
    const f = getFacture(req, req.params.id);
    if (finauxFac().has(f.statut)) throw new HttpError(400, `La facture ${f.numero} est ${libelle('statutsFacture', f.statut).toLowerCase()} : ajout de document impossible`);
    if (!actionsFacture(req, f).documents) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    const maj = ajouterDocument(req, FAC, f, objet(req.body), TYPES_FACTURE);
    return { ok: true, documents: (maj.documents || []).map(resumeDoc) };
  }, { perm: [MODULE, 'voir'] });
  router.get('/api/factures/:id/documents/:index', async (req, res) => {
    const f = getFacture(req, req.params.id);
    servirDocument(req, res, f.documents[indexDoc(req, f)]);
  }, { perm: [MODULE, 'voir'] });
  router.delete('/api/factures/:id/documents/:index', async (req) => {
    const f = getFacture(req, req.params.id);
    if (finauxFac().has(f.statut)) throw new HttpError(400, `La facture ${f.numero} est ${libelle('statutsFacture', f.statut).toLowerCase()} : ses pièces jointes sont conservées`);
    if (!actionsFacture(req, f).documents) throw new HttpError(403, 'Droit insuffisant : Achats & factures › Modifier');
    const idx = indexDoc(req, f);
    const docs = f.documents.slice(); const [sup] = docs.splice(idx, 1);
    const maj = db.update(FAC, f.id, { documents: docs });
    ctx.audit(req, 'document', FAC, maj.id, `Facture ${maj.numero} : document supprimé — ${sup.nom}`);
    return { ok: true, documents: docs.map(resumeDoc) };
  }, { perm: [MODULE, 'voir'] });

  // =================================================================================================
  // TABLEAU DE BORD, ÉCHÉANCIER, COÛTS PAR OT, RÉFÉRENCES
  // =================================================================================================
  const STATUTS_ENGAGES = [SC.validee, SC.envoyee, SC.partielle, SC.recue];
  const STATUTS_A_PAYER = [SF.recue, SF.aValider, SF.validee];
  const STATUTS_IMPAYES = [SF.recue, SF.aValider, SF.validee, SF.litige];

  const MAX_MOIS_SERIE = 36;
  /** Mois AAAA-MM d'une période ; au-delà de 36 mois, les plus récents sont conservés. */
  function listeMois(du, au) {
    const out = [];
    let [y, m] = du.slice(0, 7).split('-').map(Number);
    const [y2, m2] = au.slice(0, 7).split('-').map(Number);
    while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 2400) break; }
    return out.slice(-MAX_MOIS_SERIE);
  }
  /** Montant engagé d'une commande : le montant reçu pour une commande soldée (reliquat abandonné), sinon le total commandé. */
  function montantEngageHT(c) { return c.solde ? montantRecuHT(c) : num((c.totaux || {}).ht); }

  router.get('/api/achats/tableau', async (req) => {
    controleQuotidien();
    const q = req.query || {};
    const jour = jourLocal();
    const config = cfgAchats();
    const debutDefaut = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 11); return jourLocal(d); })();
    const du = dateFiltre(q.du, 'Du') || debutDefaut;
    const au = dateFiltre(q.au, 'Au') || jour;
    if (du > au) throw new HttpError(400, 'Période invalide : la date de début est postérieure à la date de fin');
    const refs = references();
    let commandes = ctx.scope(req, db.list(CMD));
    let factures = ctx.scope(req, db.list(FAC));
    if (q.secteurId) { const ids = new Set(perms.secteursDescendants(db, [Number(q.secteurId)])); commandes = commandes.filter((c) => ids.has(Number(c.secteurId))); factures = factures.filter((f) => ids.has(Number(f.secteurId))); }
    if (q.fournisseurId) { commandes = commandes.filter((c) => Number(c.fournisseurId) === Number(q.fournisseurId)); factures = factures.filter((f) => Number(f.fournisseurId) === Number(q.fournisseurId)); }
    const dansPeriode = (d) => !!d && d >= du && d <= au;
    const engagees = commandes.filter((c) => STATUTS_ENGAGES.includes(c.statut) && dansPeriode(c.dateCommande));
    const factPeriode = factures.filter((f) => f.statut !== SF.annulee && dansPeriode(f.dateFacture));
    const payees = factures.filter((f) => f.statut === SF.payee && dansPeriode(f.datePaiement));
    const aPayer = factures.filter((f) => STATUTS_A_PAYER.includes(f.statut));
    const enRetard = factures.filter((f) => factureEnRetard(f, jour));
    const limiteProche = ajouterJours(jour, Number(config.alerteEcheanceJours) || 0);
    const proches = factures.filter((f) => STATUTS_A_PAYER.includes(f.statut) && f.dateEcheance && f.dateEcheance >= jour && f.dateEcheance <= limiteProche);
    const litiges = factures.filter((f) => f.statut === SF.litige);
    const aValider = commandes.filter((c) => c.statut === SC.aValider);
    const facturesAValider = factures.filter((f) => f.statut === SF.aValider);
    const ouvertes = commandes.filter((c) => [SC.validee, SC.envoyee, SC.partielle].includes(c.statut));
    const livraisonsRetard = commandes.filter((c) => livraisonEnRetard(c, jour));
    const somme = (rows, k) => arrondi(rows.reduce((s, x) => s + num(typeof k === 'function' ? k(x) : x[k]), 0));
    const ht = montantEngageHT;

    const kpis = {
      engageHT: somme(engagees, ht), nbCommandes: engagees.length,
      enCoursHT: somme(ouvertes, (c) => Math.max(0, num(ht(c)) - montantRecuHT(c))), nbCommandesEnCours: ouvertes.length,
      factureHT: somme(factPeriode, 'montantHT'), factureTTC: somme(factPeriode, 'montantTTC'), nbFactures: factPeriode.length,
      payeTTC: somme(payees, 'montantTTC'), nbPayees: payees.length,
      aPayerTTC: somme(aPayer, 'montantTTC'), nbAPayer: aPayer.length,
      bonAPayerTTC: somme(aPayer.filter((f) => f.statut === SF.validee), 'montantTTC'), nbBonAPayer: aPayer.filter((f) => f.statut === SF.validee).length,
      enRetardTTC: somme(enRetard, 'montantTTC'), nbEnRetard: enRetard.length,
      echeancesProchesTTC: somme(proches, 'montantTTC'), nbEcheancesProches: proches.length,
      litigesTTC: somme(litiges, 'montantTTC'), nbLitiges: litiges.length,
      commandesAValiderHT: somme(aValider, ht), nbCommandesAValider: aValider.length,
      nbFacturesAValider: facturesAValider.length,
      nbLivraisonsEnRetard: livraisonsRetard.length,
    };
    const mois = listeMois(du, au);
    const nbMoisPeriode = (Number(au.slice(0, 4)) - Number(du.slice(0, 4))) * 12 + Number(au.slice(5, 7)) - Number(du.slice(5, 7)) + 1;
    const parMoisMap = new Map(mois.map((m) => [m, { mois: m, engageHT: 0, factureHT: 0, payeTTC: 0 }]));
    for (const c of engagees) { const x = parMoisMap.get(moisDe(c.dateCommande)); if (x) x.engageHT += num(ht(c)); }
    for (const f of factPeriode) { const x = parMoisMap.get(moisDe(f.dateFacture)); if (x) x.factureHT += num(f.montantHT); }
    for (const f of payees) { const x = parMoisMap.get(moisDe(f.datePaiement)); if (x) x.payeTTC += num(f.montantTTC); }
    const parMois = Array.from(parMoisMap.values()).map((x) => ({ mois: x.mois, engageHT: arrondi(x.engageHT), factureHT: arrondi(x.factureHT), payeTTC: arrondi(x.payeTTC) }));

    const grouper = (cle, libelleDe, extra) => {
      const m = new Map();
      const add = (k, champ, v) => { if (!m.has(k)) m.set(k, Object.assign({ cle: k, label: libelleDe(k), factureHT: 0, engageHT: 0, nbFactures: 0 }, extra ? extra(k) : {})); const x = m.get(k); x[champ] += num(v); if (champ === 'factureHT') x.nbFactures++; };
      for (const f of factPeriode) add(cle(f), 'factureHT', f.montantHT);
      for (const c of engagees) add(cle(c), 'engageHT', ht(c));
      return Array.from(m.values()).map((x) => Object.assign(x, { factureHT: arrondi(x.factureHT), engageHT: arrondi(x.engageHT) }));
    };
    const cats = ctx.liste('categoriesDepense');
    const parCategorie = grouper((r) => r.categorieCode || '', (k) => (k ? libelle('categoriesDepense', k) : 'Non catégorisé'), (k) => ({ code: k || null, couleur: (cats.find((x) => x.code === k) || {}).couleur || null, ordre: (cats.find((x) => x.code === k) || {}).ordre || 999 }))
      .sort((a, b) => b.factureHT - a.factureHT || b.engageHT - a.engageHT);
    const parFournisseur = grouper((r) => Number(r.fournisseurId) || 0, (k) => (refs.fournisseurs.get(k) || {}).nom || 'Fournisseur inconnu', (k) => ({ fournisseurId: k || null }))
      .sort((a, b) => (b.factureHT + b.engageHT) - (a.factureHT + a.engageHT)).slice(0, 10);
    const parSite = grouper((r) => refs.siteDe(r.secteurId) || 0, (k) => (k ? nomSecteur(refs, k) : 'Sans site'), (k) => ({ siteId: k || null }))
      .sort((a, b) => (b.factureHT + b.engageHT) - (a.factureHT + a.engageHT));
    const ligneF = (f) => { const r = resumeFacture(f, refs, jour); return { id: r.id, numero: r.numero, numeroFournisseur: r.numeroFournisseur, fournisseurNom: r.fournisseurNom, objet: r.objet, dateFacture: r.dateFacture, dateEcheance: r.dateEcheance, montantTTC: r.montantTTC, montantHT: r.montantHT, statut: r.statut, enRetard: r.enRetard, joursRetard: r.joursRetard, joursAvantEcheance: r.joursAvantEcheance, secteurId: r.secteurId, siteNom: r.siteNom }; };
    const ligneC = (c) => { const r = resumeCommande(c, refs, jour); return { id: r.id, numero: r.numero, fournisseurNom: r.fournisseurNom, objet: r.objet, dateCommande: r.dateCommande, dateLivraisonPrevue: r.dateLivraisonPrevue, totaux: r.totaux, statut: r.statut, demandeurNom: r.demandeurNom, joursRetardLivraison: r.joursRetardLivraison, secteurId: r.secteurId, siteNom: r.siteNom, tauxReception: r.tauxReception, validationPropreInterdite: actionsCommande(req, c).validationPropreInterdite }; };
    const parEcheance = (a, b) => String(a.dateEcheance || '').localeCompare(String(b.dateEcheance || ''));
    return {
      periode: { du, au }, aujourdhui: jour,
      config: { seuilValidationHT: num(config.seuilValidationHT), alerteEcheanceJours: num(config.alerteEcheanceJours), delaiPaiementJours: num(config.delaiPaiementJours), tauxTVA: num(config.tauxTVA) },
      kpis, parMois, serieMoisLimitee: nbMoisPeriode > MAX_MOIS_SERIE, parCategorie, parFournisseur, parSite,
      aPayer: aPayer.filter((f) => !factureEnRetard(f, jour)).sort(parEcheance).slice(0, 12).map(ligneF),
      enRetard: enRetard.sort(parEcheance).map(ligneF),
      echeancesProches: proches.sort(parEcheance).map(ligneF),
      litiges: litiges.sort(parEcheance).map(ligneF),
      commandesAValider: aValider.sort((a, b) => String(a.dateSoumission || a.dateCommande || '').localeCompare(String(b.dateSoumission || b.dateCommande || ''))).map(ligneC),
      livraisonsEnRetard: livraisonsRetard.sort((a, b) => String(a.dateLivraisonPrevue).localeCompare(String(b.dateLivraisonPrevue))).map(ligneC),
    };
  }, { perm: [MODULE, 'voir'] });

  function echeancier(req) {
    const q = req.query || {};
    const jour = jourLocal();
    const refs = references();
    let rows = ctx.scope(req, db.list(FAC, (f) => STATUTS_IMPAYES.includes(f.statut)));
    if (q.statut) { const s = new Set(String(q.statut).split(',')); rows = rows.filter((f) => s.has(f.statut)); }
    if (q.fournisseurId) rows = rows.filter((f) => Number(f.fournisseurId) === Number(q.fournisseurId));
    if (q.secteurId) { const ids = new Set(perms.secteursDescendants(db, [Number(q.secteurId)])); rows = rows.filter((f) => ids.has(Number(f.secteurId))); }
    rows.sort((a, b) => String(a.dateEcheance || '').localeCompare(String(b.dateEcheance || '')) || String(a.numero).localeCompare(String(b.numero), 'fr', { numeric: true }));
    const enRetard = { total: 0, factures: [] };
    const semaines = new Map();
    for (const f of rows) {
      const r = resumeFacture(f, refs, jour);
      if (r.enRetard) { enRetard.factures.push(r); enRetard.total += num(r.montantTTC); continue; }
      const s = semaineISO(f.dateEcheance || jour);
      if (!semaines.has(s.cle)) semaines.set(s.cle, Object.assign({}, s, { total: 0, totalBonAPayer: 0, factures: [], courante: s.debut <= jour && jour <= s.fin }));
      const x = semaines.get(s.cle);
      x.factures.push(r); x.total += num(r.montantTTC);
      if (r.statut === SF.validee) x.totalBonAPayer += num(r.montantTTC);
    }
    enRetard.total = arrondi(enRetard.total);
    const liste = Array.from(semaines.values()).map((x) => Object.assign(x, { total: arrondi(x.total), totalBonAPayer: arrondi(x.totalBonAPayer) }));
    return { aujourdhui: jour, total: arrondi(rows.reduce((s, f) => s + num(f.montantTTC), 0)), nbFactures: rows.length, enRetard, semaines: liste, modesPaiement: modesPaiement() };
  }
  router.get('/api/achats/echeancier', async (req) => echeancier(req), { perm: [MODULE, 'voir'] });

  /** Compteurs de la pastille du menu : à valider (droit valider) et factures en retard, dans le périmètre. */
  router.get('/api/achats/compteurs', async (req) => {
    const jour = jourLocal();
    const peutValider = can(req, 'valider');
    const commandesAValider = peutValider ? ctx.scope(req, db.list(CMD, (c) => c.statut === SC.aValider)).length : 0;
    const factures = ctx.scope(req, db.list(FAC, (f) => f.statut === SF.aValider || factureEnRetard(f, jour)));
    const facturesAValider = peutValider ? factures.filter((f) => f.statut === SF.aValider).length : 0;
    const facturesEnRetard = factures.filter((f) => factureEnRetard(f, jour)).length;
    return { commandesAValider, facturesAValider, facturesEnRetard, total: commandesAValider + facturesAValider + facturesEnRetard };
  }, { perm: [MODULE, 'voir'] });

  router.get('/api/achats/couts-ot/:otId', async (req) => {
    const ot = ctx.getVisible(req, 'ot', req.params.otId);
    const refs = references(); const jour = jourLocal();
    const commandes = ctx.scope(req, db.list(CMD, (c) => c.statut !== SC.annulee && (c.lignes || []).some((l) => Number(l.otId) === ot.id))).map((c) => {
      const lignes = (c.lignes || []).map((l, index) => Object.assign({ index }, l)).filter((l) => Number(l.otId) === ot.id);
      return { id: c.id, numero: c.numero, statut: c.statut, dateCommande: c.dateCommande, fournisseurNom: (refs.fournisseurs.get(Number(c.fournisseurId)) || {}).nom || '', lignes, montantHT: arrondi(lignes.reduce((s, l) => s + arrondi(num(l.quantite) * num(l.prixUnitaireHT)), 0)) };
    });
    const factures = ctx.scope(req, db.list(FAC, (f) => Number(f.otId) === ot.id && f.statut !== SF.annulee)).map((f) => resumeFacture(f, refs, jour))
      .map((f) => ({ id: f.id, numero: f.numero, numeroFournisseur: f.numeroFournisseur, fournisseurNom: f.fournisseurNom, objet: f.objet, dateFacture: f.dateFacture, montantHT: f.montantHT, montantTVA: f.montantTVA, montantTTC: f.montantTTC, statut: f.statut, categorieCode: f.categorieCode }));
    return {
      otId: ot.id, otNumero: ot.numero || '', otTitre: ot.titre || '',
      commandes, factures,
      totalCommandeHT: arrondi(commandes.reduce((s, c) => s + c.montantHT, 0)),
      totalFactureHT: arrondi(factures.reduce((s, f) => s + num(f.montantHT), 0)),
      totalFactureTTC: arrondi(factures.reduce((s, f) => s + num(f.montantTTC), 0)),
      totalPayeTTC: arrondi(factures.filter((f) => f.statut === SF.payee).reduce((s, f) => s + num(f.montantTTC), 0)),
    };
  }, { perm: [MODULE, 'voir'] });

  /** Listes de choix des formulaires (indépendantes des droits sur les modules stock, OT, RH, fournisseurs). */
  router.get('/api/achats/references', async (req) => {
    const finauxOt = new Set(ctx.liste('statutsOT').filter((s) => s.final).map((s) => s.code));
    const fournisseurs = db.list('fournisseurs').map((f) => ({ id: f.id, nom: f.nom || `#${f.id}`, actif: f.actif !== false, typeCode: f.typeCode || '', delaiLivraisonJours: f.delaiLivraisonJours == null ? null : f.delaiLivraisonJours, adresse: f.adresse || '', contact: f.contact || '', telephone: f.telephone || '', email: f.email || '' }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const articles = ctx.scope(req, db.list('articles', (a) => a.actif !== false)).map((a) => ({ id: a.id, code: a.code || '', designation: a.designation || '', referenceFournisseur: a.referenceFournisseur || '', prixUnitaire: num(a.prixUnitaire), uniteCode: a.uniteCode || '', fournisseurId: a.fournisseurId == null ? null : Number(a.fournisseurId), quantite: num(a.quantite), seuilMin: num(a.seuilMin), categorieCode: a.categorieCode || '' }))
      .sort((a, b) => a.designation.localeCompare(b.designation, 'fr'));
    const ot = ctx.scope(req, db.list('ot')).map((o) => ({ id: o.id, numero: o.numero || `#${o.id}`, titre: o.titre || '', statut: o.statut, final: finauxOt.has(o.statut), secteurId: o.secteurId == null ? null : Number(o.secteurId), createdAt: o.createdAt }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 500);
    const rhDisponible = !!ctx.services.rh || db.count('personnel') > 0;
    // Fiches du personnel : seulement avec le droit Ressources humaines › Voir, sans donnée RH (matricule, contrat)
    const personnel = rhDisponible && perms.can(req.perms, 'rh', 'voir') ? ctx.scope(req, db.list('personnel', (p) => p.actif !== false)).map((p) => ({ id: p.id, nom: nomPersonnel(p), fonction: p.fonction || '', secteurId: p.secteurId == null ? null : Number(p.secteurId) })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')) : [];
    // Commandes facturables : celles que l'utilisateur peut modifier (un site en lecture seule n'est pas proposé)
    const commandesFacturables = db.list(CMD, (c) => [SC.validee, SC.envoyee, SC.partielle, SC.recue].includes(c.statut) && ecritureSite(req, c));
    const refs = references();
    return {
      fournisseurs, articles, ot, personnel,
      commandes: commandesFacturables.map((c) => { const r = resumeCommande(c, refs); return { id: r.id, numero: r.numero, fournisseurId: r.fournisseurId, secteurId: r.secteurId, objet: r.objet || '', statut: r.statut, categorieCode: r.categorieCode, totaux: r.totaux, montantRecuHT: r.montantRecuHT, montantFactureHT: r.montantFactureHT, dateCommande: r.dateCommande }; })
        .sort((a, b) => String(b.dateCommande || '').localeCompare(String(a.dateCommande || ''))),
      modesPaiement: modesPaiement(),
      config: cfgAchats(),
      stockDisponible: !!ctx.services.stock, rhDisponible,
    };
  }, { perm: [MODULE, 'voir'] });

  // =================================================================================================
  // EXPORTS CSV
  // =================================================================================================
  function envoyerCsv(req, res, nomFichier, entetes, lignes, entite, libelleAudit) {
    const contenu = ['\ufeff' + entetes.map(csvEscape).join(';')].concat(lignes.map((l) => l.map(csvEscape).join(';'))).join('\r\n');
    ctx.audit(req, 'export', entite, null, `${lignes.length} ${libelleAudit}`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nomFichier}-${jourLocal()}.csv"`, 'Cache-Control': 'no-store' });
    res.end(contenu);
  }
  router.get('/api/achats/export/:quoi', async (req, res) => {
    const quoi = req.params.quoi;
    const refs = references(); const jour = jourLocal();
    if (quoi === 'commandes') {
      const champs = ((ctx.config().champsPersonnalises || {})[CMD]) || [];
      const rows = filtrerCommandes(req).map((c) => resumeCommande(c, refs, jour));
      return envoyerCsv(req, res, 'commandes', ['Numéro', 'Date', 'Fournisseur', 'Objet', 'Site', 'Service / secteur', 'Catégorie', 'Statut', 'Montant HT', 'TVA', 'Montant TTC', 'Livraison prévue', 'Réception (%)', 'Reçu HT', 'Facturé HT', 'Demandeur', 'Valideur', 'Date de validation', 'Commentaire'].concat(champs.map((x) => x.label)),
        rows.map((c) => [c.numero, csvDate(c.dateCommande), c.fournisseurNom, c.objet, c.siteNom, c.secteurNom, c.categorieLibelle, c.statutLibelle, csvNombre(c.totaux.ht), csvNombre(c.totaux.tva), csvNombre(c.totaux.ttc), csvDate(c.dateLivraisonPrevue), c.tauxReception, csvNombre(c.montantRecuHT), csvNombre(c.montantFactureHT), c.demandeurNom, c.validationAuto ? 'Validation automatique' : c.valideurNom, csvDate(c.dateValidation), c.commentaire]
          .concat(champs.map((x) => { const v = (c.champs || {})[x.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); }))), CMD, 'commande(s)');
    }
    if (quoi === 'lignes') {
      const lignes = [];
      for (const c of filtrerCommandes(req)) {
        const r = resumeCommande(c, refs, jour);
        for (const l of c.lignes || []) {
          const a = l.articleId != null ? refs.articles.get(Number(l.articleId)) : null;
          const o = l.otId != null ? refs.ot.get(Number(l.otId)) : null;
          lignes.push([c.numero, csvDate(c.dateCommande), r.fournisseurNom, r.statutLibelle, r.siteNom, a ? a.code || '' : '', l.designation, l.referenceFournisseur, csvNombre(l.quantite, 3), l.uniteCode || '', csvNombre(l.quantiteRecue, 3), csvNombre(l.prixUnitaireHT, 4), csvNombre(l.tauxTVA), csvNombre(num(l.quantite) * num(l.prixUnitaireHT)), o ? o.numero || '' : '']);
        }
      }
      return envoyerCsv(req, res, 'lignes-commandes', ['Commande', 'Date', 'Fournisseur', 'Statut', 'Site', 'Code article', 'Désignation', 'Réf. fournisseur', 'Quantité', 'Unité', 'Quantité reçue', 'Prix unitaire HT', 'TVA (%)', 'Montant HT', 'OT'], lignes, CMD, 'ligne(s) de commande');
    }
    if (quoi === 'factures') {
      const champs = ((ctx.config().champsPersonnalises || {})[FAC]) || [];
      const rows = filtrerFactures(req).map((f) => resumeFacture(f, refs, jour));
      return envoyerCsv(req, res, 'factures', ['N° interne', 'N° fournisseur', 'Date', 'Échéance', 'Fournisseur', 'Objet', 'Site', 'Service / secteur', 'Catégorie', 'Commande', 'OT', 'Personnel', 'Montant HT', 'TVA', 'Montant TTC', 'Statut', 'Date de paiement', 'Mode de paiement', 'Référence du paiement', 'Écart rapprochement HT', 'Jours de retard'].concat(champs.map((x) => x.label)),
        rows.map((f) => [f.numero, f.numeroFournisseur, csvDate(f.dateFacture), csvDate(f.dateEcheance), f.fournisseurNom, f.objet, f.siteNom, f.secteurNom, f.categorieLibelle, f.commandeNumero, f.otNumero, f.personnelNom, csvNombre(f.montantHT), csvNombre(f.montantTVA), csvNombre(f.montantTTC), f.statutLibelle, csvDate(f.datePaiement), f.modePaiementLibelle, f.referencePaiement || '', f.rapprochement ? csvNombre(f.rapprochement.ecartHT) : '', f.enRetard ? f.joursRetard : '']
          .concat(champs.map((x) => { const v = (f.champs || {})[x.cle]; return v == null ? '' : (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : v); }))), FAC, 'facture(s)');
    }
    if (quoi === 'echeancier') {
      const e = echeancier(req);
      const lignes = [];
      for (const f of e.enRetard.factures) lignes.push(['En retard', csvDate(f.dateEcheance), f.fournisseurNom, f.numeroFournisseur, f.numero, f.statutLibelle, csvNombre(f.montantTTC), f.joursRetard]);
      for (const s of e.semaines) for (const f of s.factures) lignes.push([`Semaine ${s.numero} (${csvDate(s.debut)} au ${csvDate(s.fin)})`, csvDate(f.dateEcheance), f.fournisseurNom, f.numeroFournisseur, f.numero, f.statutLibelle, csvNombre(f.montantTTC), '']);
      return envoyerCsv(req, res, 'echeancier-factures', ['Période', 'Échéance', 'Fournisseur', 'N° fournisseur', 'N° interne', 'Statut', 'Montant TTC', 'Jours de retard'], lignes, FAC, 'échéance(s) de factures');
    }
    throw new HttpError(404, 'Export inconnu (commandes, lignes, factures ou echeancier)');
  }, { perm: [MODULE, 'exporter'] });

  // =================================================================================================
  // ÉCHÉANCES : notification des factures en retard (une fois par facture)
  // =================================================================================================
  function verifierEcheances(options = {}) {
    const jour = options.jour || jourLocal();
    const retards = db.list(FAC, (f) => factureEnRetard(f, jour));
    let nbNotifiees = 0;
    for (const f of retards) {
      if (f.retardNotifie && !options.forcer) continue;
      const cibles = valideursFacture(f, []);
      if (cibles.length) {
        ctx.notify(cibles, { titre: `Facture en retard de paiement : ${f.numero}`, message: `${nomFournisseur(f.fournisseurId)} — n° ${f.numeroFournisseur} — ${montantTxt(f.montantTTC)} TTC — échéance du ${csvDate(f.dateEcheance)} dépassée de ${joursEntre(f.dateEcheance, jour)} j`, lien: '#/achats/facture/' + f.id, type: 'alerte' });
        nbNotifiees++;
      }
      db.update(FAC, f.id, { retardNotifie: true });
    }
    return { nbRetard: retards.length, nbNotifiees };
  }
  router.post('/api/achats/verifier-echeances', async (req) => {
    const r = verifierEcheances({ forcer: objet(req.body).forcer === true });
    ctx.audit(req, 'generation', FAC, null, `Contrôle des échéances : ${r.nbRetard} facture(s) en retard, ${r.nbNotifiees} notification(s)`);
    return r;
  }, { perm: [MODULE, 'valider'] });
  let dernierControle = null;
  const controleQuotidien = () => {
    const jour = jourLocal();
    if (dernierControle === jour) return;
    dernierControle = jour;
    try { verifierEcheances({ jour }); } catch (e) { ctx.log('Achats : contrôle des échéances en échec', e.message); }
  };
  // Les minuteurs ne sont pas armés en mode mémoire (tests des autres modules) ; la consultation du
  // tableau de bord des achats déclenche alors le contrôle quotidien.
  if (!db.inMemory || process.env.GMAO_ACHATS_AUTO === '1') {
    const t1 = setTimeout(controleQuotidien, 30 * 1000); if (t1.unref) t1.unref();
    const t2 = setInterval(controleQuotidien, INTERVALLE_VERIFICATION_MS); if (t2.unref) t2.unref();
  }

  // =================================================================================================
  // SERVICES PUBLIÉS
  // =================================================================================================
  ctx.services.achats = {
    /** Factures (non annulées) imputées à un OT. */
    facturesPourOt: (otId) => db.list(FAC, (f) => Number(f.otId) === Number(otId) && f.statut !== SF.annulee).sort((a, b) => String(a.dateFacture).localeCompare(String(b.dateFacture))),
    /** Total HT (nombre) des factures non annulées imputées à un OT. */
    totalFactureOt: (otId) => arrondi(db.list(FAC, (f) => Number(f.otId) === Number(otId) && f.statut !== SF.annulee).reduce((s, f) => s + num(f.montantHT), 0)),
    /** Totaux { ht, tva, ttc, nombre, payeTTC } des factures non annulées imputées à un OT. */
    totauxFacturesOt(otId) {
      const rows = db.list(FAC, (f) => Number(f.otId) === Number(otId) && f.statut !== SF.annulee);
      return { ht: arrondi(rows.reduce((s, f) => s + num(f.montantHT), 0)), tva: arrondi(rows.reduce((s, f) => s + num(f.montantTVA), 0)), ttc: arrondi(rows.reduce((s, f) => s + num(f.montantTTC), 0)), nombre: rows.length, payeTTC: arrondi(rows.filter((f) => f.statut === SF.payee).reduce((s, f) => s + num(f.montantTTC), 0)) };
    },
    /** Commandes (non annulées) dont au moins une ligne est imputée à l'OT. */
    commandesPourOt: (otId) => db.list(CMD, (c) => c.statut !== SC.annulee && (c.lignes || []).some((l) => Number(l.otId) === Number(otId))),
    /** Contrôle des factures en retard (notifie les valideurs, une fois par facture). */
    verifierEcheances,
    calculerTotaux,
  };
}

// =====================================================================================================
// DONNÉES DE DÉMONSTRATION
// =====================================================================================================
const TEMOIN = 'Cartouches filtre à air — compresseur GA 37 (entretien 4 000 h)';
const TEMOIN_VAL = 'Roulements et paliers — atelier de Valréas';
let seedEnCours = false;

/** PDF minimal (une page, texte Helvetica) pour illustrer les pièces jointes de démonstration. */
function pdfDemo(lignes) {
  const echap = (s) => String(s).replace(/°/g, 'o').replace(/[—–]/g, '-').replace(/×/g, 'x').replace(/[’‘]/g, '\'').replace(/[«»“”]/g, '"').replace(/€/g, 'EUR')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/([()\\])/g, '\\$1');
  let flux = 'BT\n';
  let y = 790;
  for (const l of lignes) {
    const taille = l.taille || 10;
    flux += `/F${l.mono ? 3 : (l.gras ? 2 : 1)} ${taille} Tf 1 0 0 1 ${l.x || 50} ${y} Tm (${echap(l.texte)}) Tj\n`;
    y -= l.saut || Math.round(taille * 1.6);
  }
  flux += 'ET\n0.6 w 50 ' + (y + 4) + ' m 545 ' + (y + 4) + ' l S\n';
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 7 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(flux, 'latin1')} >>\nstream\n${flux}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n` + positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  seedEnCours = true;
  try {
    // Dépendances idempotentes (l'ordre alphabétique des fichiers ne garantit pas leur présence)
    for (const fichier of ['profils.js', 'secteurs.js', 'utilisateurs.js', 'fournisseurs.js', 'equipements.js', 'stock.js', 'ot.js', 'rh.js']) {
      const m = (ctx.modules || []).find((x) => x.fichier === fichier);
      if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Achats : seed dépendant en échec', fichier, e.message); } }
    }
    const rapport = [];
    if (!db.findOne(CMD, (c) => c.objet === TEMOIN)) rapport.push(insererDemo(ctx));
    else rapport.push('site principal : déjà présents');
    const val = db.findOne('secteurs', (s) => s.code === 'VAL');
    if (val) {
      if (!db.findOne(CMD, (c) => c.objet === TEMOIN_VAL)) rapport.push(insererDemoValreas(ctx, val));
      else rapport.push('Valréas : déjà présents');
    }
    return rapport.join(' ; ');
  } finally { seedEnCours = false; }
}

function outilsDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const achats = Object.assign({ tauxTVA: 20, seuilValidationHT: 1000, delaiPaiementJours: 30 }, cfg.achats || {});
  const tva = Number(achats.tauxTVA) || 20;
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const uid = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };
  const fournisseur = (nomExact, re) => db.findOne('fournisseurs', (f) => f.nom === nomExact) || (re ? db.findOne('fournisseurs', (f) => re.test(f.nom || '')) : null);
  const article = (designation) => db.findOne('articles', (a) => a.designation === designation);
  const secteur = (code) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : null; };
  const ot = (titre) => db.findOne('ot', (o) => o.titre === titre);
  const jour = (n) => ajouterJours(jourLocal(), n);
  const horo = (n, heure = '10:00') => { const d = new Date(`${jour(n)}T${heure}:00`); return d.toISOString(); };
  const listes = cfg.listes || {};
  const code = (liste, voulu) => { const l = listes[liste] || []; return !l.length || l.some((x) => x.code === voulu) ? voulu : l.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0))[0].code; };
  const numero = (col, cle, defaut) => { const g = (cfg.numerotation || {})[cle] || defaut; for (let i = 0; i < 10000; i++) { const n = db.nextNumber(cle, g); if (!db.findOne(col, (x) => x.numero === n)) return n; } return `${cle.toUpperCase()}-${Date.now()}`; };
  /** Ligne de commande depuis un article (désignation, référence, prix, unité repris) ou ligne libre. */
  const ligne = (src, quantite, prix, extra = {}) => {
    const a = typeof src === 'string' ? article(src) : null;
    const designation = a ? a.designation : (typeof src === 'string' ? src : src.designation);
    const pu = prix != null ? prix : (a ? Number(a.prixUnitaire) || 0 : 0);
    return { articleId: a ? a.id : null, designation, referenceFournisseur: a ? a.referenceFournisseur || '' : (extra.ref || ''), quantite, quantiteRecue: 0, prixUnitaireHT: pu, tauxTVA: extra.tauxTVA != null ? extra.tauxTVA : tva, otId: extra.otId || null, uniteCode: a ? a.uniteCode || '' : (extra.unite || 'u'), montantHT: arrondi(quantite * pu) };
  };
  const brut = (col, id, patch) => { const r = db.data.collections[col].find((x) => x.id === id); if (r) Object.assign(r, patch); };
  return { db, cfg, achats, tva, admin, uid, fournisseur, article, secteur, ot, jour, horo, code, numero, ligne, brut };
}

/** Insère une commande de démonstration : `etapes` décrit le circuit (dates relatives en jours). */
function commandeDemo(o, d) {
  const { db, uid, jour, horo, numero, brut, code } = o;
  const lignes = d.lignes.map((l) => Object.assign({}, l));
  const totaux = calculerTotaux(lignes);
  const demandeur = uid(d.demandeur || 'mdupont');
  const hist = [];
  const h = (n, login, action, statut, details, heure) => hist.push({ date: horo(n, heure || '10:00'), userId: login ? uid(login) : null, action, statut, details: details || '' });
  h(d.creee, d.demandeur || 'mdupont', 'creation', 'brouillon', '', '08:30');
  const c = {
    numero: numero(CMD, 'cmd', 'CMD-{annee}-{num:4}'), fournisseurId: d.fournisseur.id, secteurId: d.secteurId, statut: d.statut,
    categorieCode: code('categoriesDepense', d.categorie || 'pieces'), objet: d.objet, lignes, totaux,
    dateCommande: jour(d.creee), dateLivraisonPrevue: d.livraison != null ? jour(d.livraison) : null,
    demandeurUserId: demandeur, valideurUserId: null, dateValidation: null, validationAuto: false, commentaire: d.commentaire || '', adresseLivraison: d.adresseLivraison || '', conditions: d.conditions || '',
    documents: d.documents || [], receptions: [], champs: {}, createdBy: demandeur, motifRefus: '',
  };
  const seuil = Number(o.achats.seuilValidationHT) || 0;
  if (d.soumise != null) {
    if (totaux.ht >= seuil) {
      h(d.soumise, d.demandeur || 'mdupont', 'soumission', 'a_valider', `Montant ${totaux.ht.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} € HT ≥ seuil de validation`, '09:00');
      c.dateSoumission = horo(d.soumise, '09:00');
      // Au-delà du seuil, la validation est faite par un autre valideur que le demandeur
      const jValidation = d.validee != null ? d.validee : (['a_valider', 'brouillon'].includes(d.statut) ? null : d.soumise);
      const valideur = d.valideur || ((d.demandeur || 'mdupont') === 'mdupont' ? 'admin' : 'mdupont');
      if (jValidation != null) { c.valideurUserId = uid(valideur); c.dateValidation = horo(jValidation, '11:15'); h(jValidation, valideur, 'validation', 'validee', d.commentaireValidation || '', '11:15'); }
    } else if (d.validee != null || d.statut !== 'brouillon') {
      c.dateSoumission = horo(d.soumise, '09:00'); c.dateValidation = horo(d.soumise, '09:00'); c.validationAuto = true;
      h(d.soumise, d.demandeur || 'mdupont', 'validation', 'validee', 'Validation automatique : montant inférieur au seuil de validation', '09:00');
    }
  }
  if (d.envoyee != null) { c.dateEnvoi = jour(d.envoyee); c.envoyeParUserId = uid('mdupont'); h(d.envoyee, 'mdupont', 'envoi', 'envoyee', `Envoyée par e-mail à ${d.fournisseur.email || d.fournisseur.nom}`, '14:00'); }
  for (const r of d.receptions || []) {
    const rl = r.lignes.map(([index, quantite]) => {
      lignes[index].quantiteRecue = arrondi(lignes[index].quantiteRecue + quantite, 3);
      // Entrée de stock correspondante dans l'historique du magasin (même article, même jour)
      const mvt = lignes[index].articleId != null ? db.findOne('mouvementsStock', (m) => m.type === 'entree' && Number(m.articleId) === Number(lignes[index].articleId) && jourLocal(new Date(m.date)) === jour(r.jour)) : null;
      return { index, quantite, mouvementId: mvt ? mvt.id : null };
    });
    const complete = lignes.every((l) => l.quantiteRecue >= l.quantite);
    const montantHT = arrondi(rl.reduce((s, x) => s + x.quantite * lignes[x.index].prixUnitaireHT, 0));
    c.receptions.push({ date: jour(r.jour), userId: uid(r.par || 'jbernard'), bonLivraison: r.bl, commentaire: r.commentaire || '', createdAt: horo(r.jour, '09:40'), lignes: rl, montantHT });
    h(r.jour, r.par || 'jbernard', 'reception', complete ? 'recue' : 'partielle', `${complete ? 'Réception complète' : 'Réception partielle'} — BL ${r.bl}`, '09:40');
    if (complete) c.dateReceptionComplete = jour(r.jour);
  }
  if (d.annulee != null) { c.motifAnnulation = d.motifAnnulation; c.dateAnnulation = horo(d.annulee, '16:00'); c.annuleParUserId = uid('mdupont'); h(d.annulee, 'mdupont', 'annulation', 'annulee', d.motifAnnulation, '16:00'); }
  c.historique = hist;
  const cree = db.insert(CMD, c);
  brut(CMD, cree.id, { createdAt: horo(d.creee, '08:30'), updatedAt: hist[hist.length - 1].date });
  return db.get(CMD, cree.id);
}

/** Insère une facture de démonstration. */
function factureDemo(o, d) {
  const { db, uid, jour, horo, numero, brut, code, tva } = o;
  const ht = arrondi(d.ht);
  const taux = d.tauxTVA != null ? d.tauxTVA : tva;
  const montantTVA = arrondi((ht * taux) / 100);
  const createur = uid(d.par || 'mdupont');
  const hist = [{ date: horo(d.saisie != null ? d.saisie : d.date, '09:15'), userId: createur, action: 'creation', statut: 'recue', details: '' }];
  const f = {
    numero: numero(FAC, 'fac', 'FAC-{annee}-{num:4}'), numeroFournisseur: d.numeroFournisseur, fournisseurId: d.fournisseur.id, secteurId: d.secteurId,
    commandeId: d.commande ? d.commande.id : null, otId: d.otId || null, personnelId: d.personnelId || null,
    categorieCode: code('categoriesDepense', d.categorie || (d.commande ? d.commande.categorieCode : 'pieces')), objet: d.objet || (d.commande ? d.commande.objet : ''),
    dateFacture: jour(d.date), dateEcheance: jour(d.echeance != null ? d.echeance : d.date + (Number(o.achats.delaiPaiementJours) || 30)),
    montantHT: ht, montantTVA, montantTTC: arrondi(ht + montantTVA), tauxTVA: taux, lignes: d.lignes || [],
    statut: d.statut, valideurUserId: null, dateValidation: null, datePaiement: null, modePaiement: null, referencePaiement: '', payeParUserId: null,
    documents: d.documents || [], commentaires: (d.commentaires || []).map(([n, login, texte]) => ({ userId: uid(login), date: horo(n, '11:00'), texte })), champs: {}, createdBy: createur,
    retardNotifie: false, motifLitige: '',
  };
  if (d.soumise != null) { f.dateSoumission = horo(d.soumise, '10:00'); hist.push({ date: horo(d.soumise, '10:00'), userId: createur, action: 'soumission', statut: 'a_valider', details: '' }); }
  if (d.validee != null) { f.valideurUserId = uid(d.valideur || 'mdupont'); f.dateValidation = horo(d.validee, '15:00'); hist.push({ date: f.dateValidation, userId: f.valideurUserId, action: 'validation', statut: 'validee', details: d.commentaireValidation || '' }); }
  if (d.payee != null) { f.datePaiement = jour(d.payee); f.modePaiement = d.mode || 'virement'; f.referencePaiement = d.reference || ''; f.payeParUserId = uid('admin'); hist.push({ date: horo(d.payee, '16:30'), userId: f.payeParUserId, action: 'paiement', statut: 'payee', details: `${d.mode === 'prelevement' ? 'Prélèvement' : 'Virement bancaire'} du ${jour(d.payee).split('-').reverse().join('/')}${d.reference ? ' — réf. ' + d.reference : ''}` }); }
  if (d.litige) { f.motifLitige = d.litige.motif; f.dateLitige = horo(d.litige.jour, '14:20'); hist.push({ date: f.dateLitige, userId: uid(d.litige.par || 'mdupont'), action: 'litige', statut: 'litige', details: d.litige.motif }); f.commentaires.push({ userId: uid(d.litige.par || 'mdupont'), date: f.dateLitige, texte: `Litige : ${d.litige.motif}` }); }
  if (d.annulee) { f.motifAnnulation = d.annulee.motif; f.dateAnnulation = horo(d.annulee.jour, '10:30'); f.annuleParUserId = uid('mdupont'); hist.push({ date: f.dateAnnulation, userId: f.annuleParUserId, action: 'annulation', statut: 'annulee', details: d.annulee.motif }); }
  f.historique = hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // Rapprochement (commande liée)
  if (d.commande) {
    const c = db.get(CMD, d.commande.id);
    const recuHT = arrondi((c.lignes || []).reduce((s, l) => s + arrondi(l.quantiteRecue * l.prixUnitaireHT), 0));
    const dejaFactureHT = arrondi(db.list(FAC, (x) => Number(x.commandeId) === c.id && x.statut !== 'annulee').reduce((s, x) => s + Number(x.montantHT || 0), 0));
    const reference = recuHT > 0 ? recuHT : c.totaux.ht;
    const ecartHT = arrondi(ht + dejaFactureHT - reference);
    f.rapprochement = { commandeId: c.id, commandeNumero: c.numero, commandeHT: c.totaux.ht, recuHT, dejaFactureHT, factureHT: ht, base: recuHT > 0 ? 'recu' : 'commande', referenceHT: reference, ecartHT, conforme: Math.abs(ecartHT) <= TOLERANCE + 1e-9, date: horo(d.date, '09:15') };
  } else f.rapprochement = null;
  const cree = db.insert(FAC, f);
  brut(FAC, cree.id, { createdAt: horo(d.saisie != null ? d.saisie : d.date, '09:15'), updatedAt: f.historique[f.historique.length - 1].date });
  return db.get(FAC, cree.id);
}

function docPdf(nomFichier, lignes, jourIso, userId, description) {
  const buf = pdfDemo(lignes);
  return { nom: nomFichier, type: 'application/pdf', taille: buf.length, contenu: 'data:application/pdf;base64,' + buf.toString('base64'), date: jourIso, userId, description: description || '' };
}

/** Facture fournisseur au format PDF (démonstration). */
function pdfFacture(o, { fournisseur, numero, date, echeance, client, lignes, ht, tauxTVA }) {
  const fr = (n) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, ' ');
  const tva = arrondi((ht * tauxTVA) / 100);
  const out = [
    { texte: fournisseur.nom.toUpperCase(), taille: 16, gras: true, saut: 20 },
    ...String(fournisseur.adresse || '').split(/\r?\n/).filter(Boolean).map((t) => ({ texte: t, taille: 9, saut: 12 })),
    { texte: `SIRET ${fournisseur.siret || ''}  -  ${fournisseur.telephone || ''}`, taille: 9, saut: 28 },
    { texte: `FACTURE N° ${numero}`, taille: 14, gras: true, saut: 18 },
    { texte: `Date : ${date.split('-').reverse().join('/')}    Échéance : ${echeance.split('-').reverse().join('/')}`, taille: 10, saut: 14 },
    { texte: `Client : ${client}`, taille: 10, saut: 26 },
    { texte: `${'Désignation'.padEnd(46, ' ')} ${'Qté'.padStart(6, ' ')} ${'PU HT'.padStart(10, ' ')} ${'Montant HT'.padStart(12, ' ')}`, taille: 8.5, mono: true, saut: 6 },
    { texte: '-'.repeat(78), taille: 8.5, mono: true, saut: 12 },
    ...lignes.map((l) => ({ texte: `${String(l[0]).slice(0, 46).padEnd(46, ' ')} ${String(l[1]).replace('.', ',').padStart(6, ' ')} ${fr(l[2]).padStart(10, ' ')} ${fr(l[1] * l[2]).padStart(12, ' ')}`, taille: 8.5, mono: true, saut: 13 })),
    { texte: ' ', taille: 9, saut: 16 },
    { texte: `Total HT : ${fr(ht)} EUR`, taille: 10, gras: true, x: 360, saut: 14 },
    { texte: `TVA ${String(tauxTVA).replace('.', ',')} % : ${fr(tva)} EUR`, taille: 10, x: 360, saut: 14 },
    { texte: `Total TTC : ${fr(ht + tva)} EUR`, taille: 11, gras: true, x: 360, saut: 30 },
    { texte: 'Règlement par virement à réception. Pénalités de retard : 3 fois le taux d\'intérêt légal.', taille: 8, saut: 11 },
    { texte: 'Indemnité forfaitaire pour frais de recouvrement : 40 EUR (art. L441-10 du Code de commerce).', taille: 8, saut: 11 },
  ];
  return out;
}

function insererDemo(ctx) {
  const o = outilsDemo(ctx);
  const { db, uid, fournisseur, secteur, ot, jour, ligne, horo } = o;
  const SKF = fournisseur('SKF France', /\bskf\b/i);
  const REXEL = fournisseur('Rexel', /rexel/i);
  const TOTAL = fournisseur('Total Lubrifiants', /total/i);
  const SCHNEIDER = fournisseur('Schneider Electric', /schneider/i);
  const ATLAS = fournisseur('Atlas Copco Service', /atlas/i);
  const VERITAS = fournisseur('Bureau Veritas', /veritas/i);
  const TRANE = fournisseur('Trane France', /trane/i);
  const METTLER = fournisseur('Mettler-Toledo', /mettler/i);
  if (!SKF || !REXEL || !TOTAL || !SCHNEIDER) return 'fournisseurs de démonstration absents';
  const SITE = secteur('SITE');
  const MAINT = secteur('MAINT') || SITE;
  const PROD = secteur('PROD') || SITE;
  const L1 = secteur('PROD-L1') || PROD;
  const L2 = secteur('PROD-L2') || PROD;
  const SG = secteur('SG') || SITE;
  const LOG = secteur('LOG') || SITE;
  const QUAL = secteur('QUAL') || SITE;
  if (MAINT == null) return 'secteurs absents';
  const societe = (o.cfg.societe || {}).nom || 'SICAF';
  const otFardeleuse = ot('Four de rétraction de la fardeleuse : remplacement de la résistance n°3');
  const otCompresseur = db.list('ot', (x) => x.titre === 'Visite préventive mensuelle du compresseur GA 37').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
  const otBalance = ot('Étalonnage annuel de la balance de précision');
  const otGroupeFroid = ot('Révision du groupe froid industriel avant l\'hiver');
  const nbCmdAvant = db.count(CMD); const nbFacAvant = db.count(FAC);
  const valideurDemo = uid('admin');

  // ----- Commandes ---------------------------------------------------------------------------------
  const FA = ATLAS || SKF;
  const cA = commandeDemo(o, {
    fournisseur: FA, secteurId: MAINT, statut: 'recue', categorie: 'pieces', objet: TEMOIN, demandeur: 'mdupont', creee: -76, soumise: -76, envoyee: -75, livraison: -71,
    lignes: [ligne('Cartouche filtre à air compresseur GA 37', 4, 91.5)],
    receptions: [{ jour: -70, bl: 'BL-ACS-26-01877', par: 'mdupont', lignes: [[0, 4]] }],
    commentaire: 'Stock de sécurité pour les deux prochaines visites 4 000 h.',
  });
  const cB = commandeDemo(o, {
    fournisseur: TOTAL, secteurId: MAINT, statut: 'recue', categorie: 'pieces', objet: 'Huile hydraulique Azolla ZS 46 (demi-fût) — presse 250 t', demandeur: 'mdupont', creee: -30, soumise: -30, envoyee: -30, livraison: -25,
    lignes: [ligne('Huile hydraulique Azolla ZS 46', 104, 3.79)],
    receptions: [{ jour: -24, bl: 'BL-TL-2026-55103', par: 'mdupont', lignes: [[0, 104]] }],
  });
  const cC = commandeDemo(o, {
    fournisseur: SCHNEIDER, secteurId: L1, statut: 'partielle', categorie: 'pieces', objet: 'Appareillage électrique — armoire du four de rétraction', demandeur: 'mdupont', creee: -14, soumise: -14, envoyee: -13, livraison: -6,
    lignes: [ligne('Contacteur TeSys D 18 A — bobine 24 V CC', 4), ligne('Disjoncteur moteur GV2ME10 (4 à 6,3 A)', 2), ligne({ designation: 'Variateur de vitesse Altivar ATV320 — 2,2 kW' }, 1, 612, { ref: 'ATV320U22N4B' })],
    receptions: [{ jour: -7, bl: 'BL-SE-90412776', par: 'kleroy', lignes: [[0, 2], [2, 1]], commentaire: 'Contacteurs : 2 en reliquat (rupture chez le fournisseur)' }],
  });
  const cD = commandeDemo(o, {
    fournisseur: REXEL, secteurId: L1, statut: 'envoyee', categorie: 'pieces', objet: 'Dépannage urgent fardeleuse : résistances chauffantes', demandeur: 'pmartin', creee: -4, soumise: -4, envoyee: -4, livraison: 1,
    lignes: [ligne({ designation: 'Résistance chauffante 2 400 W — four de rétraction Variopac' }, 2, 186.5, { ref: 'RC-2400-VP', otId: otFardeleuse ? otFardeleuse.id : null }), ligne('Fusibles cylindriques 10 × 38 gG 10 A (boîte de 10)', 5)],
    commentaire: 'Urgent : fardeleuse en mode dégradé (-20 % de cadence). Livraison express demandée.', conditions: 'Livraison express J+1 avant 10 h — frais de port offerts (contrat cadre).',
  });
  const cE = commandeDemo(o, {
    fournisseur: ATLAS || SKF, secteurId: SG, statut: 'validee', categorie: 'pieces', objet: 'Kit d\'entretien 8 000 h — compresseur GA 37', demandeur: 'mdupont', creee: -2, soumise: -2, livraison: 8,
    lignes: [ligne('Cartouche filtre à air compresseur GA 37', 2), ligne({ designation: 'Kit séparateur d\'huile GA 37 VSD+' }, 1, 412, { ref: '2901 0776 00' }), ligne({ designation: 'Huile Roto-Inject Fluid NDURANCE — bidon 20 L' }, 1, 245, { ref: '2901 1700 00' })],
  });
  const cF = commandeDemo(o, {
    fournisseur: VERITAS || SKF, secteurId: MAINT, statut: 'a_valider', categorie: 'controle', objet: 'Vérifications générales périodiques 2027 (levage, appareils à pression, électricité)', demandeur: 'mdupont', creee: -1, soumise: -1,
    lignes: [ligne({ designation: 'VGP pont roulant 5 t (annuelle)' }, 1, 420, { ref: 'VGP-LEV-01' }), ligne({ designation: 'VGP chariots élévateurs (semestrielle)' }, 4, 185, { ref: 'VGP-CHA-02' }), ligne({ designation: 'Inspection périodique réservoirs d\'air comprimé' }, 2, 340, { ref: 'IP-ESP-01' }), ligne({ designation: 'Vérification des installations électriques (rapport Q18)' }, 1, 1150, { ref: 'VIE-Q18' })],
    commentaire: 'Contrat annuel : tarifs 2027 identiques à 2026 (+0 %).',
  });
  const cG = commandeDemo(o, {
    fournisseur: SKF, secteurId: L2, statut: 'brouillon', categorie: 'outillage', objet: 'Outillage ligne 2 : clé dynamométrique et extracteur', demandeur: 'pmartin', creee: 0,
    lignes: [ligne({ designation: 'Clé dynamométrique 20–100 N·m' }, 1, 189, { ref: 'TMFT 36' }), ligne({ designation: 'Extracteur hydraulique 6 t' }, 1, 298, { ref: 'TMHP 10E' }), ligne('Kit joints de vérin hydraulique (tige Ø 40 à 80)', 2)],
  });
  const cH = commandeDemo(o, {
    fournisseur: TRANE || SKF, secteurId: SG, statut: 'annulee', categorie: 'pieces', objet: 'Compresseur scroll de rechange — groupe froid', demandeur: 'mdupont', creee: -40, soumise: -40, validee: -39, valideur: 'admin',
    lignes: [ligne({ designation: 'Compresseur scroll ZP 120 KCE — R410A' }, 1, 3480, { ref: 'ZP120KCE-TFD' })], annulee: -36, motifAnnulation: 'Pièce reprise sous garantie par le constructeur (intervention SAV Trane du 08/09)',
  });

  // ----- Factures ----------------------------------------------------------------------------------
  const client = `${societe} — Service maintenance`;
  const fA = { numero: 'ACS-2026-02233', date: -68 };
  factureDemo(o, {
    fournisseur: FA, secteurId: MAINT, commande: cA, numeroFournisseur: fA.numero, date: fA.date, saisie: -66, statut: 'payee', soumise: -66, validee: -65, payee: -38, reference: 'VIR-2026-0912', ht: cA.totaux.ht,
    documents: [docPdf(`Facture ${FA.nom} ${fA.numero}.pdf`, pdfFacture(o, { fournisseur: FA, numero: fA.numero, date: jour(fA.date), echeance: jour(fA.date + 30), client, lignes: cA.lignes.map((l) => [l.designation, l.quantite, l.prixUnitaireHT]), ht: cA.totaux.ht, tauxTVA: o.tva }), horo(-64, '09:20'), uid('mdupont'), 'Facture originale reçue par e-mail')],
  });
  const fB = { numero: 'TL-F-2026-18834', date: -22 };
  factureDemo(o, {
    fournisseur: TOTAL, secteurId: MAINT, commande: cB, numeroFournisseur: fB.numero, date: fB.date, echeance: 8, saisie: -21, statut: 'validee', soumise: -21, validee: -20, ht: cB.totaux.ht,
    documents: [docPdf(`Facture Total ${fB.numero}.pdf`, pdfFacture(o, { fournisseur: TOTAL, numero: fB.numero, date: jour(fB.date), echeance: jour(8), client, lignes: cB.lignes.map((l) => [l.designation, l.quantite, l.prixUnitaireHT]), ht: cB.totaux.ht, tauxTVA: o.tva }), horo(-21, '09:20'), uid('mdupont'), '')],
  });
  const recuC = arrondi(cC.lignes.reduce((s, l) => s + l.quantiteRecue * l.prixUnitaireHT, 0));
  factureDemo(o, {
    fournisseur: SCHNEIDER, secteurId: L1, commande: cC, numeroFournisseur: 'SE-FR-7712094', date: -5, saisie: -3, statut: 'recue', ht: arrondi(recuC + 18),
    commentaires: [[-3, 'mdupont', 'Facture de la première livraison (2 contacteurs + variateur). 18,00 € HT de frais de port facturés alors que la commande prévoit le franco : à vérifier avec l\'ADV avant validation.']],
  });
  if (ATLAS) {
    factureDemo(o, {
      fournisseur: ATLAS, secteurId: SG, otId: otCompresseur ? otCompresseur.id : null, categorie: 'sous_traitance', objet: 'Contrat de service AIRPlan — visite préventive du compresseur GA 37', numeroFournisseur: 'ACS-2026-03318', date: -58, saisie: -57, statut: 'payee', soumise: -57, validee: -56, payee: -28, reference: 'VIR-2026-0941', ht: 680,
      lignes: [{ designation: 'Visite préventive trimestrielle (main-d\'œuvre et déplacement)', quantite: 1, prixUnitaireHT: 520, tauxTVA: o.tva, montantHT: 520 }, { designation: 'Analyse d\'huile en laboratoire', quantite: 1, prixUnitaireHT: 160, tauxTVA: o.tva, montantHT: 160 }],
    });
  }
  if (VERITAS) {
    factureDemo(o, {
      fournisseur: VERITAS, secteurId: MAINT, categorie: 'controle', objet: 'VGP 2026 : pont roulant 5 t et chariots élévateurs', numeroFournisseur: 'BV-26-0045871', date: -48, echeance: -18, saisie: -46, statut: 'validee', soumise: -46, validee: -44, ht: 790,
      commentaires: [[-12, 'admin', 'Relance du fournisseur reçue : règlement à programmer en priorité.']],
      documents: [docPdf('Facture Bureau Veritas BV-26-0045871.pdf', pdfFacture(o, { fournisseur: VERITAS, numero: 'BV-26-0045871', date: jour(-48), echeance: jour(-18), client, lignes: [['VGP pont roulant 5 t', 1, 420], ['VGP chariots élévateurs (2 unités)', 2, 185]], ht: 790, tauxTVA: o.tva }), horo(-46, '09:20'), uid('mdupont'), '')],
    });
    const pers = ctx.services.rh && typeof ctx.services.rh.personnelDeUser === 'function' ? ctx.services.rh.personnelDeUser(uid('jbernard')) : db.findOne('personnel', (p) => Number(p.userId) === uid('jbernard'));
    factureDemo(o, {
      fournisseur: VERITAS, secteurId: pers && pers.secteurId != null ? Number(pers.secteurId) : MAINT, personnelId: pers ? pers.id : null, categorie: 'formation', objet: 'Formation CACES R486 nacelles (PEMP catégories A et B) — Julie Bernard', numeroFournisseur: 'BVF-2026-11207', date: -9, saisie: -8, statut: 'a_valider', soumise: -8, ht: 1150, par: 'mdupont',
      lignes: [{ designation: 'Formation CACES R486 catégories A et B (3 jours)', quantite: 1, prixUnitaireHT: 1050, tauxTVA: o.tva, montantHT: 1050 }, { designation: 'Frais de test et délivrance du certificat', quantite: 1, prixUnitaireHT: 100, tauxTVA: o.tva, montantHT: 100 }],
    });
  }
  factureDemo(o, {
    fournisseur: REXEL, secteurId: LOG, categorie: 'pieces', objet: 'Câble souple H07RN-F 3G2,5 mm² — touret', numeroFournisseur: 'RX-4471203', date: -27, saisie: -25, statut: 'litige', ht: 352.5,
    litige: { jour: -24, par: 'mdupont', motif: '150 m facturés pour 100 m livrés (BL 4471203) : avoir de 117,50 € HT demandé au comptoir de Vénissieux' },
    lignes: [{ designation: 'Câble H07RN-F 3G2,5 mm² (au mètre)', quantite: 150, prixUnitaireHT: 2.35, tauxTVA: o.tva, montantHT: 352.5 }],
  });
  if (METTLER) {
    factureDemo(o, {
      fournisseur: METTLER, secteurId: QUAL, otId: otBalance ? otBalance.id : null, categorie: 'controle', objet: 'Contrat de vérification métrologique — balance de précision', numeroFournisseur: 'MT-FR-26-30021', date: -44, saisie: -43, statut: 'payee', soumise: -43, validee: -42, payee: -14, mode: 'prelevement', reference: 'PRLV SEPA MT 2026-09', ht: 365,
    });
  }
  if (TRANE) {
    factureDemo(o, {
      fournisseur: TRANE, secteurId: SG, otId: otGroupeFroid ? otGroupeFroid.id : null, categorie: 'sous_traitance', objet: 'Assistance technique groupe froid CGAM 120 — diagnostic et recharge R410A', numeroFournisseur: 'TRF-0926-5512', date: -26, echeance: 4, saisie: -25, statut: 'validee', soumise: -25, validee: -23, ht: 1240,
      lignes: [{ designation: 'Déplacement technicien frigoriste', quantite: 1, prixUnitaireHT: 180, tauxTVA: o.tva, montantHT: 180 }, { designation: 'Main-d\'œuvre (heures)', quantite: 6, prixUnitaireHT: 95, tauxTVA: o.tva, montantHT: 570 }, { designation: 'Fluide R410A (kg)', quantite: 7, prixUnitaireHT: 70, tauxTVA: o.tva, montantHT: 490 }],
    });
  }
  factureDemo(o, {
    fournisseur: FA, secteurId: MAINT, categorie: 'pieces', objet: 'Facture reçue en double (envoi postal)', numeroFournisseur: 'ACS-2026-02233-DUP', date: -68, saisie: -60, statut: 'annulee', ht: cA.totaux.ht,
    annulee: { jour: -60, motif: 'Doublon de la facture ACS-2026-02233 (même livraison, déjà enregistrée et réglée)' },
  });
  factureDemo(o, { fournisseur: SKF, secteurId: MAINT, categorie: 'pieces', objet: 'Roulements et courroies — révision des convoyeurs', numeroFournisseur: 'FA-26-101942', date: -146, saisie: -144, statut: 'payee', soumise: -144, validee: -143, payee: -115, reference: 'VIR-2026-0640', ht: 612.4, valideur: 'admin' });
  // Historique des mois précédents (pour les graphiques mensuels)
  factureDemo(o, { fournisseur: SCHNEIDER, secteurId: L2, categorie: 'investissement', objet: 'Variateur Altivar Process ATV630 — presse 250 t', numeroFournisseur: 'SE-FR-7698120', date: -132, saisie: -130, statut: 'payee', soumise: -130, validee: -129, payee: -101, reference: 'VIR-2026-0688', ht: 2150, valideur: 'admin' });
  factureDemo(o, { fournisseur: TOTAL, secteurId: MAINT, categorie: 'pieces', objet: 'Lubrifiants : fût Azolla ZS 46 et graisses', numeroFournisseur: 'TL-F-2026-12011', date: -104, saisie: -103, statut: 'payee', soumise: -103, validee: -102, payee: -74, reference: 'VIR-2026-0745', ht: 1046.4, valideur: 'admin' });
  factureDemo(o, { fournisseur: REXEL, secteurId: SG, categorie: 'outillage', objet: 'EPI et petit outillage électrique', numeroFournisseur: 'RX-4402981', date: -90, saisie: -88, statut: 'payee', soumise: -88, validee: -87, payee: -60, reference: 'VIR-2026-0802', ht: 486.9 });
  if (ATLAS) factureDemo(o, { fournisseur: ATLAS, secteurId: SG, categorie: 'sous_traitance', objet: 'Contrat de service AIRPlan — visite trimestrielle de juin', numeroFournisseur: 'ACS-2026-02104', date: -118, saisie: -117, statut: 'payee', soumise: -117, validee: -116, payee: -88, reference: 'VIR-2026-0711', ht: 680 });

  // Notifications de démonstration (à valider, retard)
  if (valideurDemo != null) ctx.notify([valideurDemo], { titre: `Commande à valider : ${cF.numero}`, message: `${(VERITAS || SKF).nom} — ${cF.totaux.ht.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} € HT — ${cF.objet} (demandée par Marie Dupont)`, lien: '#/achats/commande/' + cF.id, type: 'alerte' });
  const nbC = db.count(CMD) - nbCmdAvant; const nbF = db.count(FAC) - nbFacAvant;
  return `${nbC} commandes (brouillon, à valider, validée, envoyée, partielle, reçues, annulée) et ${nbF} factures (payées, bon à payer, 1 en retard, 1 en litige, 1 formation, liées à des OT)`;
}

function insererDemoValreas(ctx, val) {
  const o = outilsDemo(ctx);
  const { db, fournisseur, secteur, ligne } = o;
  const SKF = fournisseur('SKF France', /\bskf\b/i);
  const TOTAL = fournisseur('Total Lubrifiants', /total/i);
  if (!SKF || !TOTAL) return 'Valréas : fournisseurs absents';
  const VM = secteur('VAL-MAINT') || val.id; const VL = secteur('VAL-LOG') || val.id;
  const c1 = commandeDemo(o, {
    fournisseur: SKF, secteurId: VM, statut: 'envoyee', categorie: 'pieces', objet: TEMOIN_VAL, demandeur: 'mdupont', creee: -6, soumise: -6, envoyee: -5, livraison: 0,
    lignes: [ligne({ designation: 'Palier à semelle SNL 513-611 complet' }, 2, 164, { ref: 'SNL 513-611' }), ligne({ designation: 'Roulement à rotule sur rouleaux 22213 EK' }, 2, 98.4, { ref: '22213 EK' })],
  });
  const c2 = commandeDemo(o, {
    fournisseur: TOTAL, secteurId: VL, statut: 'recue', categorie: 'pieces', objet: 'Huile moteur et graisse — chariots de Valréas', demandeur: 'mdupont', creee: -35, soumise: -35, envoyee: -35, livraison: -30,
    lignes: [ligne({ designation: 'Huile moteur Rubia TIR 8900 10W-40 — bidon 20 L' }, 2, 96, { ref: 'RUBIA-TIR-8900-20L' }), ligne({ designation: 'Graisse Multis EP 2 — seau 5 kg' }, 1, 58, { ref: 'MULTIS-EP2-5KG' })],
    receptions: [{ jour: -31, bl: 'BL-TL-2026-54790', par: 'mdupont', lignes: [[0, 2], [1, 1]] }],
  });
  factureDemo(o, { fournisseur: TOTAL, secteurId: VL, commande: c2, numeroFournisseur: 'TL-F-2026-18102', date: -30, saisie: -29, statut: 'payee', soumise: -29, validee: -28, payee: -2, reference: 'VIR-2026-0990', ht: c2.totaux.ht });
  return 'Valréas : 2 commandes, 1 facture';
}

module.exports = { nom, register, seedDemo, calculerTotaux, arrondi, semaineISO, pdfDemo };
