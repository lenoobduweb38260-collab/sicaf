'use strict';
/**
 * Module Étiquettes code-barres & inventaire du magasin.
 *
 *  - Résolution d'un code scanné (GET /api/codes/:code) : article (code, référence fournisseur,
 *    champ codeBarre), équipement, OT, demande d'intervention, inventaire — selon les droits et la portée.
 *  - Inventaires (collection « inventaires ») : ouverture avec instantané des quantités théoriques des
 *    articles actifs visibles du périmètre (catégorie, préfixe d'emplacement, fournisseur, magasin),
 *    comptages au scanner (ajouter / remplacer), articles hors périmètre, mode aveugle, validation
 *    (mouvements d'inventaire via ctx.services.stock.inventorier), annulation, suppression, export CSV.
 *  - Données d'étiquettes (GET /api/etiquettes/donnees) pour l'impression des étiquettes d'articles
 *    et des étiquettes d'immobilisation des équipements.
 *
 * Services publiés : ctx.services.inventaire = { resoudreCode, enCoursPourArticle, calculerResume, STATUTS }.
 * Événements émis  : 'inventaire:ouvert' ({ inventaire }), 'inventaire:valide' ({ inventaire, mouvementIds }),
 *                    'inventaire:annule' ({ inventaire }).
 * Services consommés : ctx.services.stock.inventorier, ctx.services.equipements.visible (si présents).
 */
let CodeBarre = null;
try { CodeBarre = require('../../client/js/lib/codebarre.js'); } catch (e) { CodeBarre = null; }

const nom = 'Étiquettes & inventaire';
const ENTITE = 'inventaires';
const MODULE = 'inventaire';
/** Statuts (codes fixes du contrat) ; libellés et couleurs repris de la liste « statutsInventaire » si elle est configurée. */
const STATUTS_DEFAUT = [
  { code: 'en_cours', label: 'En cours', couleur: '#f59e0b', ordre: 1, final: false },
  { code: 'valide', label: 'Validé', couleur: '#16a34a', ordre: 2, final: true },
  { code: 'annule', label: 'Annulé', couleur: '#6b7280', ordre: 3, final: true },
];
const STATUTS = STATUTS_DEFAUT.map((s) => s.code);
const MODES_COMPTAGE = ['ajouter', 'remplacer'];
const MAX_QUANTITE = 1e9;
const MAX_COMPTAGES_LIGNE = 200;
const MAX_IDS = 2000;

// ----- Utilitaires purs ---------------------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arrondi = (n, d = 3) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
const DIACRITIQUES = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const translit = (s) => (CodeBarre ? CodeBarre.translitterer(s) : String(s == null ? '' : s).normalize('NFD').replace(DIACRITIQUES, ''));
/** Clé de comparaison d'un code scanné (accents et symboles translittérés comme à l'impression, casse ignorée). */
const cleCode = (s) => translit(s == null ? '' : String(s)).trim().replace(/\s+/g, ' ').toLowerCase();
/** Clé de comparaison d'un emplacement (tirets typographiques, espaces multiples, accents et casse ignorés). */
const cleEmplacement = (s) => translit(s == null ? '' : String(s)).toLowerCase().replace(/\s+/g, ' ').trim();
const vrai = (v) => v === true || v === 1 || ['1', 'true', 'oui', 'on'].includes(String(v == null ? '' : v).toLowerCase());
const frNombre = (n) => String(arrondi(n, 3)).replace('.', ',');
const BOM = String.fromCharCode(0xfeff);

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvNombre = (n) => (n == null || n === '' ? '' : String(arrondi(n, 4)).replace('.', ','));

/** Code encodable en Code 128 ? (sinon message d'erreur) */
function controleCode(code) {
  if (!CodeBarre) return { encodable: true, erreur: null };
  try { CodeBarre.preparer(code); return { encodable: true, erreur: null }; } catch (e) { return { encodable: false, erreur: e.message }; }
}

/**
 * Résumé d'un inventaire : lignes, comptées, écarts et valeurs.
 * @param {Array} lignes
 * @param {{ nonComptesAZero?: boolean }} options  non comptés considérés à zéro (simulation / validation)
 */
function calculerResume(lignes, options) {
  const zero = !!(options && options.nonComptesAZero);
  const r = { nbLignes: 0, nbComptees: 0, nbNonComptees: 0, nbHorsPerimetre: 0, nbEcarts: 0, nbEcartsPositifs: 0, nbEcartsNegatifs: 0, valeurEcart: 0, valeurEcartAbsolue: 0, valeurTheorique: 0, valeurComptee: 0, progression: 0 };
  for (const l of lignes || []) {
    r.nbLignes++;
    if (l.horsPerimetre) r.nbHorsPerimetre++;
    const pu = num(l.prixUnitaire);
    const theo = num(l.quantiteTheorique);
    r.valeurTheorique += Math.max(0, theo) * pu;
    if (l.quantiteComptee != null) r.nbComptees++;
    const compte = l.quantiteComptee != null ? num(l.quantiteComptee) : (zero ? 0 : null);
    if (compte == null) continue;
    r.valeurComptee += compte * pu;
    const e = arrondi(compte - theo);
    if (e !== 0) {
      r.nbEcarts++;
      if (e > 0) r.nbEcartsPositifs++; else r.nbEcartsNegatifs++;
      r.valeurEcart += e * pu;
      r.valeurEcartAbsolue += Math.abs(e * pu);
    }
  }
  r.nbNonComptees = r.nbLignes - r.nbComptees;
  for (const k of ['valeurEcart', 'valeurEcartAbsolue', 'valeurTheorique', 'valeurComptee']) r[k] = arrondi(r[k], 2);
  r.progression = r.nbLignes ? arrondi((r.nbComptees / r.nbLignes) * 100, 1) : 0;
  return r;
}

/** Résumé sans les informations interdites en mode aveugle. */
function resumeMasque(r) {
  const { nbLignes, nbComptees, nbNonComptees, nbHorsPerimetre, progression } = r || {};
  return { nbLignes, nbComptees, nbNonComptees, nbHorsPerimetre, progression, masque: true };
}

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;
  const cfgInv = () => Object.assign({ aveugle: false, modeScan: 'quantite', sons: true, nonComptesAZero: false, scanGlobal: true }, ctx.config().inventaire || {});
  const can = (req, action, module) => perms.can(req.perms, module || MODULE, action);

  // ----- Validation des entrées -------------------------------------------------------------
  function objet(b) {
    if (b == null || b === '') return {};
    if (typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) throw new HttpError(400, 'Corps de requête invalide (objet JSON attendu)');
    return b;
  }
  function texte(v, label, { requis = false, max = 1000 } = {}) {
    if (v != null && typeof v === 'object') throw new HttpError(400, `${label} invalide`);
    const s = String(v == null ? '' : v).trim();
    if (requis && !s) throw new HttpError(400, `${label} : champ obligatoire`);
    if (s.length > max) throw new HttpError(400, `${label} : ${max} caractères au maximum`);
    return s;
  }
  function idRef(v, label) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} : identifiant invalide`);
    return n;
  }
  function quantite(v, label, { requis = true } = {}) {
    if (v == null || v === '') { if (requis) throw new HttpError(400, `${label} : valeur obligatoire`); return null; }
    if (typeof v === 'boolean' || typeof v === 'object') throw new HttpError(400, `${label} : nombre attendu`);
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} : nombre attendu`);
    if (n < 0) throw new HttpError(400, `${label} : la valeur doit être positive ou nulle`);
    if (n > MAX_QUANTITE) throw new HttpError(400, `${label} : valeur trop grande`);
    return arrondi(n);
  }
  function booleen(v, label) {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    if (vrai(v)) return true;
    if (v === 0 || ['0', 'false', 'non', 'off', ''].includes(String(v).toLowerCase())) return false;
    throw new HttpError(400, `${label} : valeur booléenne attendue`);
  }

  // ----- Références ----------------------------------------------------------------------
  function statutsInventaire() {
    const l = ctx.liste('statutsInventaire');
    return STATUTS_DEFAUT.map((d) => Object.assign({}, d, l.find((x) => x.code === d.code) || {}));
  }
  const libelleStatut = (code) => (statutsInventaire().find((s) => s.code === code) || {}).label || code;
  const libelleListe = (liste, code) => { if (code == null || code === '') return ''; const it = ctx.liste(liste).find((x) => x.code === code); return it ? it.label : String(code); };
  function cheminSecteur(id) {
    const parts = []; let cur = id == null ? null : db.get('secteurs', id); const vus = new Set();
    while (cur && !vus.has(cur.id)) { parts.unshift(cur.nom); vus.add(cur.id); cur = cur.parentId != null ? db.get('secteurs', cur.parentId) : null; }
    return parts.join(' › ');
  }
  const nomSecteur = (id) => { const s = id == null ? null : db.get('secteurs', id); return s ? s.nom : ''; };
  const nomFournisseur = (id) => { const f = id == null || id === '' ? null : db.get('fournisseurs', id); return f ? f.nom || '' : ''; };

  // ----- Portée des éléments référencés -----------------------------------------------------
  function equipementVisible(req, e) {
    if (!e) return false;
    const s = ctx.services.equipements;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, e); } catch (err) { /* repli */ } }
    return ctx.canSee(req, e);
  }
  function otVisible(req, o) {
    if (!o) return false;
    const s = ctx.services.ot;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, o); } catch (err) { /* repli */ } }
    if (ctx.canSee(req, o)) return true;
    const uid = req.user.id;
    return Number(o.technicienId) === uid || (Array.isArray(o.techniciens) && o.techniciens.map(Number).includes(uid)) || Number(o.createdBy) === uid;
  }
  function demandeVisible(req, d) {
    if (!d) return false;
    const s = ctx.services.demandes;
    if (s && typeof s.visible === 'function') { try { return !!s.visible(req, d); } catch (err) { /* repli */ } }
    if (ctx.canSee(req, d)) return true;
    const dem = d.demandeurId != null ? db.get('users', d.demandeurId) : null;
    return !!(dem && Number(dem.managerId) === req.user.id);
  }
  /** Article visible en écriture (comptage / inventaire) : les sites en lecture seule sont exclus. */
  const articleModifiable = (req, a) => !!a && perms.canSeeRecord(req.perms, req.user, a, { ecriture: true });

  // ----- Résolution d'un code scanné -------------------------------------------------------
  const CHAMPS_CODE = [['code', 'code'], ['referenceFournisseur', 'referenceFournisseur'], ['codeBarre', 'codeBarre']];
  /** Article par code exact (casse et accents ignorés), sinon référence fournisseur, sinon champ codeBarre. */
  function trouverArticle(articles, k) {
    for (const [champ, par] of CHAMPS_CODE) {
      const a = articles.find((x) => x[champ] && cleCode(x[champ]) === k);
      if (a) return { article: a, par };
    }
    return null;
  }
  /** Articles triés : actifs d'abord, puis par identifiant (résultat déterministe en cas de doublon de référence). */
  const triArticles = (rows) => rows.sort((a, b) => (a.actif === false ? 1 : 0) - (b.actif === false ? 1 : 0) || a.id - b.id);

  function inventairesEnCours(req, articleId) {
    if (!can(req, 'voir')) return [];
    return ctx.scope(req, db.list(ENTITE, (i) => i.statut === 'en_cours' && (i.lignes || []).some((l) => Number(l.articleId) === Number(articleId))))
      .map((i) => ({ id: i.id, numero: i.numero, nom: i.nom }));
  }

  /** Résolution d'un code (null si rien de visible ne correspond). */
  function resoudreCode(req, brut) {
    const k = cleCode(brut);
    if (!k) return null;
    if (can(req, 'voir', 'stock')) {
      const t = trouverArticle(triArticles(ctx.scope(req, db.list('articles'))), k);
      if (t) {
        const a = t.article;
        return {
          type: 'article', id: a.id, code: a.code || '', correspondance: t.par,
          libelle: a.designation || '', sousTitre: [a.code, a.emplacement].filter(Boolean).join(' · '),
          lien: `#/stock/${a.id}`,
          details: {
            quantite: arrondi(num(a.quantite)), unite: a.uniteCode || '', uniteLibelle: libelleListe('unites', a.uniteCode), emplacement: a.emplacement || '',
            seuilMin: num(a.seuilMin), prixUnitaire: num(a.prixUnitaire), sousSeuil: a.actif !== false && num(a.quantite) <= num(a.seuilMin),
            actif: a.actif !== false, categorieCode: a.categorieCode || null, referenceFournisseur: a.referenceFournisseur || '',
            fournisseurNom: nomFournisseur(a.fournisseurId), secteurId: a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId),
            inventairesEnCours: inventairesEnCours(req, a.id),
          },
        };
      }
    }
    if (can(req, 'voir', 'equipements')) {
      const e = db.list('equipements').sort((x, y) => x.id - y.id).find((x) => cleCode(x.numero) === k && equipementVisible(req, x));
      if (e) {
        return {
          type: 'equipement', id: e.id, code: e.numero || '', correspondance: 'numero',
          libelle: e.nom || '', sousTitre: [e.numero, e.localisation || cheminSecteur(e.secteurId)].filter(Boolean).join(' · '),
          lien: `#/equipements/${e.id}`,
          details: {
            etatCode: e.etatCode || null, criticiteCode: e.criticiteCode || null, typeCode: e.typeCode || null,
            secteurId: e.secteurId == null ? null : Number(e.secteurId), secteurChemin: cheminSecteur(e.secteurId), localisation: e.localisation || '',
            marque: e.marque || '', modele: e.modele || '', numeroSerie: e.numeroSerie || '', actif: e.actif !== false,
          },
        };
      }
    }
    if (can(req, 'voir', 'ot')) {
      const o = db.list('ot').find((x) => cleCode(x.numero) === k && otVisible(req, x));
      if (o) {
        return {
          type: 'ot', id: o.id, code: o.numero || '', correspondance: 'numero', libelle: o.titre || '', sousTitre: o.numero || '', lien: `#/ot/${o.id}`,
          details: { statut: o.statut || null, prioriteCode: o.prioriteCode || null, typeCode: o.typeCode || null, equipementId: o.equipementId == null ? null : Number(o.equipementId), technicienId: o.technicienId == null ? null : Number(o.technicienId), datePrevue: o.datePrevue || null, secteurId: o.secteurId == null ? null : Number(o.secteurId) },
        };
      }
    }
    if (can(req, 'voir', 'demandes')) {
      const d = db.list('demandes').find((x) => cleCode(x.numero) === k && demandeVisible(req, x));
      if (d) {
        return {
          type: 'demande', id: d.id, code: d.numero || '', correspondance: 'numero', libelle: d.titre || '', sousTitre: d.numero || '', lien: `#/demandes/${d.id}`,
          details: { statut: d.statut || null, prioriteCode: d.prioriteCode || null, equipementId: d.equipementId == null ? null : Number(d.equipementId), demandeurId: d.demandeurId == null ? null : Number(d.demandeurId), secteurId: d.secteurId == null ? null : Number(d.secteurId) },
        };
      }
    }
    if (can(req, 'voir')) {
      const i = ctx.scope(req, db.list(ENTITE)).find((x) => cleCode(x.numero) === k);
      if (i) {
        return {
          type: 'inventaire', id: i.id, code: i.numero, correspondance: 'numero', libelle: i.nom || '', sousTitre: `${i.numero} · ${libelleStatut(i.statut)}`, lien: `#/inventaire/${i.id}`,
          details: { statut: i.statut, secteurId: i.secteurId == null ? null : Number(i.secteurId), progression: (i.resume || {}).progression || 0 },
        };
      }
    }
    return null;
  }

  async function routeCode(req, code) {
    const c = texte(code, 'Code', { requis: true, max: 200 });
    const r = resoudreCode(req, c);
    if (!r) throw new HttpError(404, `Aucun élément accessible ne correspond au code « ${c} »`);
    return r;
  }
  router.get('/api/codes/:code', async (req) => routeCode(req, req.params.code));
  router.get('/api/codes', async (req) => routeCode(req, req.query.code));

  // ----- Inventaires : périmètre et lignes ------------------------------------------------------
  function validerFiltres(req, f) {
    if (f == null || f === '') f = {};
    if (typeof f !== 'object' || Array.isArray(f)) throw new HttpError(400, 'Filtres du périmètre invalides');
    const out = { categorieCode: null, emplacement: '', fournisseurId: null, secteurId: null };
    if (f.categorieCode != null && f.categorieCode !== '') {
      if (typeof f.categorieCode !== 'string' || !ctx.liste('categoriesArticles').some((x) => x.code === f.categorieCode)) throw new HttpError(400, `Catégorie d'articles inconnue : « ${f.categorieCode} »`);
      out.categorieCode = f.categorieCode;
    }
    out.emplacement = texte(f.emplacement, 'Emplacement', { max: 200 });
    out.fournisseurId = idRef(f.fournisseurId, 'Fournisseur');
    if (out.fournisseurId != null && !db.get('fournisseurs', out.fournisseurId)) throw new HttpError(400, 'Fournisseur introuvable');
    out.secteurId = idRef(f.secteurId, 'Magasin des articles');
    if (out.secteurId != null) {
      const s = db.get('secteurs', out.secteurId);
      if (!s || !perms.canSeeRecord(req.perms, req.user, { secteurId: s.id, createdBy: req.user.id }, { ecriture: true })) throw new HttpError(400, 'Magasin des articles introuvable ou hors de votre périmètre');
    }
    return out;
  }

  /** Articles actifs, modifiables par l'utilisateur, correspondant au périmètre (triés par emplacement puis code). */
  function articlesPerimetre(req, secteurId, filtres) {
    let rows = db.list('articles', (a) => a.actif !== false).filter((a) => articleModifiable(req, a));
    if (filtres.categorieCode) rows = rows.filter((a) => a.categorieCode === filtres.categorieCode);
    if (filtres.fournisseurId != null) rows = rows.filter((a) => Number(a.fournisseurId) === filtres.fournisseurId);
    if (filtres.emplacement) { const p = cleEmplacement(filtres.emplacement); rows = rows.filter((a) => cleEmplacement(a.emplacement).startsWith(p)); }
    if (filtres.secteurId != null) {
      const ids = new Set(perms.secteursDescendants(db, [filtres.secteurId]));
      rows = rows.filter((a) => a.secteurId != null && a.secteurId !== '' && ids.has(Number(a.secteurId)));
    } else if (secteurId != null) {
      // Inventaire d'un site : articles de ce site ou non rattachés à un magasin
      const site = ctx.siteDuSecteur(secteurId);
      if (site != null) rows = rows.filter((a) => a.secteurId == null || a.secteurId === '' || ctx.siteDuSecteur(a.secteurId) === site);
    }
    return rows.sort((a, b) => cleEmplacement(a.emplacement).localeCompare(cleEmplacement(b.emplacement), 'fr', { numeric: true }) || String(a.code || '').localeCompare(String(b.code || ''), 'fr', { numeric: true }) || a.id - b.id);
  }

  function ligneDepuisArticle(a, horsPerimetre) {
    return {
      articleId: a.id, code: a.code || '', designation: a.designation || '', emplacement: a.emplacement || '', uniteCode: a.uniteCode || null,
      categorieCode: a.categorieCode || null, referenceFournisseur: a.referenceFournisseur || '', codeBarre: a.codeBarre || '',
      prixUnitaire: arrondi(num(a.prixUnitaire), 4), quantiteTheorique: arrondi(num(a.quantite)), quantiteComptee: null, comptages: [],
      horsPerimetre: !!horsPerimetre,
    };
  }

  // ----- Inventaires : droits et présentation ------------------------------------------------
  const masquer = (req, inv) => !!inv.aveugle && !can(req, 'valider');
  const ecritureSite = (req, inv) => perms.canSeeRecord(req.perms, req.user, inv, { ecriture: true });
  function droits(req, inv) {
    const ecr = ecritureSite(req, inv);
    const enCours = inv.statut === 'en_cours';
    return {
      compter: enCours && ecr && can(req, 'modifier'),
      modifier: enCours && ecr && can(req, 'modifier'),
      valider: enCours && ecr && can(req, 'valider'),
      annuler: enCours && ecr && (can(req, 'valider') || (can(req, 'creer') && Number(inv.createdBy) === req.user.id)),
      supprimer: inv.statut !== 'valide' && ecr && can(req, 'supprimer'),
      exporter: can(req, 'exporter'),
      modifierAveugle: enCours && ecr && can(req, 'valider'),
      lectureSeule: !ecr,
    };
  }
  function exigerEnCours(inv) {
    if (inv.statut !== 'en_cours') throw new HttpError(400, `L'inventaire ${inv.numero} est ${inv.statut === 'valide' ? 'validé' : 'annulé'} : aucune modification n'est possible`);
  }

  function resumeListe(req, inv) {
    const masque = masquer(req, inv);
    const r = inv.resume || calculerResume(inv.lignes);
    return {
      id: inv.id, numero: inv.numero, nom: inv.nom, statut: inv.statut, statutLibelle: libelleStatut(inv.statut),
      secteurId: inv.secteurId == null ? null : inv.secteurId, secteurNom: nomSecteur(inv.secteurId), secteurChemin: cheminSecteur(inv.secteurId), siteId: ctx.siteDuSecteur(inv.secteurId),
      filtres: inv.filtres || {}, aveugle: !!inv.aveugle, commentaire: inv.commentaire || '',
      dateOuverture: inv.dateOuverture, dateValidation: inv.dateValidation || null, dateAnnulation: inv.dateAnnulation || null,
      createdBy: inv.createdBy, createdByNom: ctx.nomUser(inv.createdBy), validePar: inv.validePar || null, valideParNom: ctx.nomUser(inv.validePar),
      resume: masque ? resumeMasque(r) : r, masque,
      createdAt: inv.createdAt, updatedAt: inv.updatedAt,
    };
  }

  /** Mouvements de stock par article depuis l'ouverture (hors mouvements produits par la validation). */
  function mouvementsDepuis(inv) {
    const exclus = new Set((inv.mouvementIds || []).map(Number));
    const depuis = String(inv.dateOuverture || '');
    const fin = inv.statut === 'valide' && inv.dateValidation ? String(inv.dateValidation) : null;
    const ids = new Set((inv.lignes || []).map((l) => Number(l.articleId)));
    const parArticle = new Map();
    for (const m of db.list('mouvementsStock', (x) => ids.has(Number(x.articleId)) && String(x.date) > depuis && !exclus.has(x.id) && (!fin || String(x.date) <= fin))) {
      const k = Number(m.articleId);
      const x = parArticle.get(k) || { nb: 0, variation: 0, dernier: null };
      x.nb++;
      x.variation = arrondi(x.variation + num(m.quantiteApres) - num(m.quantiteAvant));
      if (!x.dernier || String(m.date) > x.dernier) x.dernier = String(m.date);
      parArticle.set(k, x);
    }
    return parArticle;
  }

  function enrichirLigne(l, inv, masque, refs) {
    const a = refs.articles.get(Number(l.articleId)) || null;
    const mv = refs.mouvements.get(Number(l.articleId)) || { nb: 0, variation: 0, dernier: null };
    const comptages = (l.comptages || []).map((c) => Object.assign({}, c, { userNom: refs.nom(c.userId) }));
    const dernier = comptages.length ? comptages[comptages.length - 1] : null;
    const compte = l.quantiteComptee != null;
    const ecart = compte ? arrondi(num(l.quantiteComptee) - num(l.quantiteTheorique)) : null;
    const out = Object.assign({}, l, {
      comptages, compte, existe: !!a, actif: a ? a.actif !== false : false,
      designation: l.designation || (a ? a.designation : ''), uniteLibelle: libelleListe('unites', l.uniteCode),
      quantiteActuelle: a ? arrondi(num(a.quantite)) : null,
      nbMouvementsDepuis: mv.nb, variationDepuis: mv.variation, dernierMouvement: mv.dernier,
      ecart, valeurEcart: compte ? arrondi(ecart * num(l.prixUnitaire), 2) : null,
      ecartActuel: compte && a && inv.statut === 'en_cours' ? arrondi(num(l.quantiteComptee) - num(a.quantite)) : null,
      dernierComptage: dernier ? dernier.date : null, dernierCompteurNom: dernier ? dernier.userNom : '',
    });
    if (masque) {
      for (const k of ['quantiteTheorique', 'quantiteActuelle', 'variationDepuis', 'ecart', 'valeurEcart', 'ecartActuel', 'quantiteAvantValidation', 'ecartApplique']) delete out[k];
      out.masque = true;
    }
    return out;
  }
  function references(inv) {
    const ids = new Set((inv.lignes || []).map((l) => Number(l.articleId)));
    const noms = new Map();
    return {
      articles: new Map(db.list('articles', (a) => ids.has(a.id)).map((a) => [a.id, a])),
      mouvements: mouvementsDepuis(inv),
      nom: (id) => { if (id == null) return ''; if (!noms.has(id)) noms.set(id, ctx.nomUser(id)); return noms.get(id); },
    };
  }

  function detail(req, inv) {
    const masque = masquer(req, inv);
    const refs = references(inv);
    const lignes = (inv.lignes || []).map((l) => enrichirLigne(l, inv, masque, refs));
    const base = resumeListe(req, inv);
    return Object.assign(base, {
      lignes,
      nbArticlesAvecMouvements: lignes.filter((l) => l.nbMouvementsDepuis > 0).length,
      nbArticlesSupprimes: lignes.filter((l) => !l.existe).length,
      mouvementIds: inv.mouvementIds || [],
      nonComptesAZero: !!inv.nonComptesAZero,
      annulePar: inv.annulePar || null, annuleParNom: ctx.nomUser(inv.annulePar), motifAnnulation: inv.motifAnnulation || '',
      filtresLibelles: libellesFiltres(inv.filtres || {}),
      droits: droits(req, inv),
      config: { modeScan: cfgInv().modeScan === 'unitaire' ? 'unitaire' : 'quantite', sons: cfgInv().sons !== false, nonComptesAZero: !!cfgInv().nonComptesAZero },
    });
  }
  function libellesFiltres(f) {
    const out = [];
    if (f.emplacement) out.push(`Emplacement « ${f.emplacement}… »`);
    if (f.categorieCode) out.push(`Catégorie ${libelleListe('categoriesArticles', f.categorieCode)}`);
    if (f.fournisseurId != null) out.push(`Fournisseur ${nomFournisseur(f.fournisseurId) || '#' + f.fournisseurId}`);
    if (f.secteurId != null) out.push(`Magasin ${cheminSecteur(f.secteurId) || '#' + f.secteurId}`);
    return out;
  }

  function numeroUnique() {
    const gabarit = (ctx.config().numerotation || {}).inv || 'INV-{annee}-{num:3}';
    for (let i = 0; i < 10000; i++) { const n = db.nextNumber('inv', gabarit); if (!db.findOne(ENTITE, (x) => cleCode(x.numero) === cleCode(n))) return n; }
    throw new HttpError(500, 'Impossible de générer un numéro d\'inventaire unique : vérifiez le gabarit de numérotation');
  }

  /** Secteur (site / magasin) de l'inventaire : obligatoire hors portée « tous », dans le périmètre modifiable. */
  function validerSecteur(req, v) {
    let id = idRef(v, 'Site / magasin');
    if (id == null && req.perms.portee === 'tous' && req.perms.siteCourantId != null) id = req.perms.siteCourantId;
    if (id == null) {
      if (req.perms.portee !== 'tous') throw new HttpError(400, 'Site / magasin : champ obligatoire (votre accès est limité à certains secteurs)');
      return null;
    }
    const s = db.get('secteurs', id);
    if (!s) throw new HttpError(400, 'Site / magasin introuvable');
    if (req.perms.portee !== 'tous' && !req.perms.secteurIds.includes(id)) throw new HttpError(403, 'Ce site / magasin est hors de votre périmètre (ou accessible en lecture seule) : inventaire impossible');
    if (!perms.canSeeRecord(req.perms, req.user, { secteurId: id, createdBy: req.user.id }, { ecriture: true })) throw new HttpError(403, 'Ce site / magasin n\'est pas modifiable dans le site affiché');
    return id;
  }

  // ----- Routes : inventaires ------------------------------------------------------------------
  router.get('/api/inventaires', async (req) => {
    const q = req.query || {};
    let rows = ctx.scope(req, db.list(ENTITE));
    if (q.statut) {
      const sts = String(q.statut).split(',').filter(Boolean);
      for (const s of sts) if (!STATUTS.includes(s)) throw new HttpError(400, `Statut d'inventaire inconnu : ${s}`);
      rows = rows.filter((i) => sts.includes(i.statut));
    }
    if (q.secteurId) {
      const ids = new Set(perms.secteursDescendants(db, [idRef(q.secteurId, 'Secteur')]));
      rows = rows.filter((i) => i.secteurId != null && ids.has(Number(i.secteurId)));
    }
    const termes = cleCode(q.recherche).split(/\s+/).filter(Boolean);
    if (termes.length) rows = rows.filter((i) => { const t = cleCode([i.numero, i.nom, i.commentaire, nomSecteur(i.secteurId)].join(' ')); return termes.every((x) => t.includes(x)); });
    return rows.sort((a, b) => String(b.dateOuverture || '').localeCompare(String(a.dateOuverture || '')) || b.id - a.id).map((i) => resumeListe(req, i));
  }, { perm: [MODULE, 'voir'] });

  /** Aperçu du périmètre avant ouverture : nombre d'articles et valeur théorique. */
  router.get('/api/inventaires-apercu', async (req) => {
    const q = req.query || {};
    const secteurId = q.secteurId ? idRef(q.secteurId, 'Site / magasin') : null;
    const filtres = validerFiltres(req, { categorieCode: q.categorieCode, emplacement: q.emplacement, fournisseurId: q.fournisseurId, secteurId: q.magasinId });
    const rows = articlesPerimetre(req, secteurId, filtres);
    return {
      nbArticles: rows.length,
      valeurTheorique: arrondi(rows.reduce((s, a) => s + Math.max(0, num(a.quantite)) * num(a.prixUnitaire), 0), 2),
      exemples: rows.slice(0, 5).map((a) => ({ id: a.id, code: a.code, designation: a.designation, emplacement: a.emplacement || '' })),
    };
  }, { perm: [MODULE, 'creer'] });

  router.get('/api/inventaires/:id', async (req) => detail(req, ctx.getVisible(req, ENTITE, req.params.id)), { perm: [MODULE, 'voir'] });

  router.post('/api/inventaires', async (req) => {
    const b = objet(req.body);
    const nomInv = texte(b.nom, 'Nom de l\'inventaire', { requis: true, max: 150 });
    const secteurId = validerSecteur(req, b.secteurId);
    const filtres = validerFiltres(req, b.filtres);
    const aveugle = b.aveugle === undefined ? !!cfgInv().aveugle : booleen(b.aveugle, 'Mode aveugle');
    if (aveugle === false && cfgInv().aveugle && !can(req, 'valider')) throw new HttpError(403, 'Le comptage à l\'aveugle est imposé par la configuration : seul un valideur peut ouvrir un inventaire non aveugle');
    const commentaire = texte(b.commentaire, 'Commentaire', { max: 2000 });
    const articles = articlesPerimetre(req, secteurId, filtres);
    if (!articles.length) throw new HttpError(400, 'Aucun article actif de votre périmètre ne correspond à ces critères : élargissez le périmètre de l\'inventaire');
    const lignes = articles.map((a) => ligneDepuisArticle(a, false));
    const maintenant = new Date().toISOString();
    const inv = db.insert(ENTITE, {
      numero: numeroUnique(), nom: nomInv, statut: 'en_cours', secteurId, filtres, aveugle, commentaire,
      lignes, createdBy: req.user.id, dateOuverture: maintenant, dateValidation: null, validePar: null,
      mouvementIds: [], resume: calculerResume(lignes),
    });
    // Chevauchements avec d'autres inventaires en cours (même article compté deux fois)
    const ids = new Set(lignes.map((l) => l.articleId));
    const chevauchements = db.list(ENTITE, (i) => i.id !== inv.id && i.statut === 'en_cours')
      .map((i) => ({ id: i.id, numero: i.numero, nom: i.nom, nbArticles: (i.lignes || []).filter((l) => ids.has(Number(l.articleId))).length }))
      .filter((x) => x.nbArticles > 0);
    ctx.audit(req, 'creation', ENTITE, inv.id, `Inventaire ${inv.numero} — ${inv.nom} : ${lignes.length} article(s)${aveugle ? ', comptage à l\'aveugle' : ''}${libellesFiltres(filtres).length ? ' (' + libellesFiltres(filtres).join(', ') + ')' : ''}`);
    ctx.emit('inventaire:ouvert', { inventaire: inv });
    return Object.assign(detail(req, inv), { chevauchements });
  }, { perm: [MODULE, 'creer'] });

  router.put('/api/inventaires/:id', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    exigerEnCours(inv);
    const b = objet(req.body);
    const patch = {};
    if (b.nom !== undefined) patch.nom = texte(b.nom, 'Nom de l\'inventaire', { requis: true, max: 150 });
    if (b.commentaire !== undefined) patch.commentaire = texte(b.commentaire, 'Commentaire', { max: 2000 });
    if (b.aveugle !== undefined) {
      const v = booleen(b.aveugle, 'Mode aveugle');
      if (v !== !!inv.aveugle) {
        if (!can(req, 'valider')) throw new HttpError(403, 'Droit insuffisant : seul un valideur d\'inventaire peut changer le mode aveugle');
        patch.aveugle = v;
      }
    }
    const changes = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(inv[k]));
    if (!changes.length) return detail(req, inv);
    const maj = db.update(ENTITE, inv.id, patch);
    ctx.audit(req, 'modification', ENTITE, inv.id, `Inventaire ${inv.numero} (${changes.join(', ')})`);
    return detail(req, maj);
  }, { perm: [MODULE, 'modifier'] });

  /** Résout un code dans le contexte d'un inventaire (ligne existante ou article hors périmètre). */
  function resoudreDansInventaire(req, inv, { code, articleId }) {
    const lignes = inv.lignes || [];
    if (articleId != null && articleId !== '') {
      const id = idRef(articleId, 'Article');
      const l = lignes.find((x) => Number(x.articleId) === id);
      if (l) return { ligne: l };
      const a = db.get('articles', id);
      if (!a || !articleModifiable(req, a)) throw new HttpError(404, 'Article introuvable ou hors de votre périmètre');
      return { article: a };
    }
    const c = texte(code, 'Code scanné', { requis: true, max: 200 });
    const k = cleCode(c);
    const modifiables = triArticles(db.list('articles').filter((a) => articleModifiable(req, a)));
    // À chaque niveau (code, référence fournisseur, code-barres), les lignes de l'inventaire sont prioritaires
    for (const [champ] of CHAMPS_CODE) {
      const l = lignes.find((x) => x[champ] && cleCode(x[champ]) === k);
      if (l) return { ligne: l };
      const a = modifiables.find((x) => x[champ] && cleCode(x[champ]) === k);
      if (a) { const ligne = lignes.find((x) => Number(x.articleId) === a.id); return ligne ? { ligne } : { article: a }; }
    }
    // Message utile : le code correspond peut-être à autre chose qu'un article
    const autre = db.findOne('equipements', (e) => cleCode(e.numero) === k) ? 'un équipement' : (db.findOne('ot', (o) => cleCode(o.numero) === k) ? 'un ordre de travail' : (db.findOne('demandes', (d) => cleCode(d.numero) === k) ? 'une demande d\'intervention' : null));
    throw new HttpError(404, autre ? `Le code « ${c} » correspond à ${autre}, pas à un article du magasin` : `Code « ${c} » inconnu : aucun article de votre périmètre ne correspond`);
  }

  router.get('/api/inventaires/:id/resoudre', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    const r = resoudreDansInventaire(req, inv, { code: req.query.code, articleId: req.query.articleId });
    const masque = masquer(req, inv);
    if (r.ligne) return { ligne: enrichirLigne(r.ligne, inv, masque, references(inv)), horsPerimetre: !!r.ligne.horsPerimetre, nouvelle: false };
    const a = r.article;
    const l = ligneDepuisArticle(a, true);
    const apercu = enrichirLigne(l, Object.assign({}, inv, { lignes: [l] }), masque, references(Object.assign({}, inv, { lignes: [l] })));
    return { ligne: apercu, horsPerimetre: true, nouvelle: true };
  }, { perm: [MODULE, 'voir'] });

  router.post('/api/inventaires/:id/comptage', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    exigerEnCours(inv);
    const b = objet(req.body);
    const mode = b.mode == null || b.mode === '' ? 'remplacer' : String(b.mode);
    if (!MODES_COMPTAGE.includes(mode)) throw new HttpError(400, 'Mode de comptage invalide : « ajouter » ou « remplacer » attendu');
    const q = mode === 'ajouter' && (b.quantite == null || b.quantite === '') ? 1 : quantite(b.quantite, 'Quantité comptée');
    if (mode === 'ajouter' && !(q > 0)) throw new HttpError(400, 'Quantité à ajouter : la valeur doit être supérieure à 0');
    const r = resoudreDansInventaire(req, inv, { code: b.code, articleId: b.articleId });
    const lignes = (inv.lignes || []).map((l) => Object.assign({}, l));
    let ligne;
    let nouvelle = false;
    if (r.ligne) ligne = lignes.find((l) => Number(l.articleId) === Number(r.ligne.articleId));
    else { ligne = ligneDepuisArticle(r.article, true); lignes.push(ligne); nouvelle = true; }
    const avant = ligne.quantiteComptee;
    const resultat = mode === 'ajouter' ? arrondi(num(avant) + q) : q;
    if (resultat > MAX_QUANTITE) throw new HttpError(400, 'Quantité comptée trop grande');
    ligne.quantiteComptee = resultat;
    ligne.comptages = (ligne.comptages || []).concat([{ userId: req.user.id, date: new Date().toISOString(), quantite: q, mode, resultat }]).slice(-MAX_COMPTAGES_LIGNE);
    const resume = calculerResume(lignes);
    const maj = db.update(ENTITE, inv.id, { lignes, resume });
    if (nouvelle) ctx.audit(req, 'modification', ENTITE, inv.id, `Inventaire ${inv.numero} : article hors périmètre ajouté ${ligne.code} — ${ligne.designation} (compté ${frNombre(resultat)})`);
    else if (mode === 'remplacer' && avant != null && arrondi(avant) !== resultat) ctx.audit(req, 'modification', ENTITE, inv.id, `Inventaire ${inv.numero} : comptage corrigé ${ligne.code} — ${ligne.designation} : ${frNombre(avant)} → ${frNombre(resultat)}`);
    const masque = masquer(req, maj);
    return { ligne: enrichirLigne(ligne, maj, masque, references(maj)), resume: masque ? resumeMasque(resume) : resume, nouvelle, quantitePrecedente: avant == null ? null : avant };
  }, { perm: [MODULE, 'modifier'] });

  router.delete('/api/inventaires/:id/lignes/:articleId/comptage', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    exigerEnCours(inv);
    const id = idRef(req.params.articleId, 'Article');
    const lignes = (inv.lignes || []).map((l) => Object.assign({}, l));
    const idx = lignes.findIndex((l) => Number(l.articleId) === id);
    if (idx < 0) throw new HttpError(404, 'Cet article ne fait pas partie de l\'inventaire');
    const l = lignes[idx];
    const avant = l.quantiteComptee;
    let supprimee = false;
    if (l.horsPerimetre) { lignes.splice(idx, 1); supprimee = true; } else { l.quantiteComptee = null; l.comptages = []; }
    const resume = calculerResume(lignes);
    const maj = db.update(ENTITE, inv.id, { lignes, resume });
    ctx.audit(req, 'modification', ENTITE, inv.id, `Inventaire ${inv.numero} : comptage annulé ${l.code} — ${l.designation}${avant != null ? ' (' + frNombre(avant) + ')' : ''}${supprimee ? ', ligne hors périmètre retirée' : ''}`);
    const masque = masquer(req, maj);
    return { ligne: supprimee ? null : enrichirLigne(l, maj, masque, references(maj)), supprimee, resume: masque ? resumeMasque(resume) : resume };
  }, { perm: [MODULE, 'modifier'] });

  router.post('/api/inventaires/:id/valider', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    exigerEnCours(inv);
    const stock = ctx.services.stock;
    if (!stock || typeof stock.inventorier !== 'function') throw new HttpError(503, 'Module stock indisponible : validation impossible');
    const b = objet(req.body);
    const zero = b.nonComptesAZero === undefined ? !!cfgInv().nonComptesAZero : booleen(b.nonComptesAZero, 'Mettre à zéro les non comptés');
    const lignes = (inv.lignes || []).map((l) => Object.assign({}, l));
    const aTraiter = lignes.filter((l) => l.quantiteComptee != null || zero);
    if (!aTraiter.length) throw new HttpError(400, 'Aucun article compté : comptez au moins un article (ou choisissez de mettre les non comptés à zéro) avant de valider');
    const motif = `Inventaire ${inv.numero} — ${inv.nom}`.slice(0, 500);
    const mouvementIds = [];
    let nbIgnorees = 0;
    try {
      for (const l of aTraiter) {
        if (!db.get('articles', l.articleId)) { l.ignoree = 'Article supprimé depuis l\'ouverture'; nbIgnorees++; continue; }
        const qte = l.quantiteComptee != null ? num(l.quantiteComptee) : 0;
        const r = stock.inventorier({ articleId: Number(l.articleId), quantite: qte, userId: req.user.id, motif });
        const m = r && r.mouvement ? r.mouvement : null;
        if (l.quantiteComptee == null) l.misAZero = true;
        if (m) {
          l.mouvementId = m.id;
          l.quantiteAvantValidation = arrondi(num(m.quantiteAvant));
          l.ecartApplique = arrondi(num(m.quantiteApres) - num(m.quantiteAvant));
          mouvementIds.push(m.id);
        }
      }
    } catch (e) {
      // Validation partielle (cas exceptionnel) : on conserve la trace des mouvements déjà enregistrés
      db.update(ENTITE, inv.id, { lignes, mouvementIds: (inv.mouvementIds || []).concat(mouvementIds) });
      ctx.audit(req, 'validation', ENTITE, inv.id, `Inventaire ${inv.numero} : validation interrompue après ${mouvementIds.length} mouvement(s) — ${e.message}`);
      throw e;
    }
    const resume = calculerResume(lignes, { nonComptesAZero: zero });
    const maintenant = new Date().toISOString();
    const maj = db.update(ENTITE, inv.id, { statut: 'valide', lignes, resume, dateValidation: maintenant, validePar: req.user.id, mouvementIds, nonComptesAZero: zero });
    const valeur = `${resume.valeurEcart >= 0 ? '+' : ''}${String(resume.valeurEcart.toFixed(2)).replace('.', ',')} ${(ctx.config().general || {}).devise || '€'}`;
    const texteResume = `${mouvementIds.length} mouvement(s) de stock, ${resume.nbEcarts} écart(s) (valeur ${valeur})${nbIgnorees ? `, ${nbIgnorees} article(s) supprimé(s) ignoré(s)` : ''}`;
    ctx.audit(req, 'validation', ENTITE, inv.id, `Inventaire ${inv.numero} — ${inv.nom} validé : ${texteResume}${zero ? ' — non comptés mis à zéro' : ''}`);
    if (inv.createdBy != null && Number(inv.createdBy) !== req.user.id) {
      ctx.notify([inv.createdBy], { titre: 'Inventaire validé', message: `${inv.numero} — ${inv.nom} : validé par ${ctx.nomUser(req.user.id)} (${texteResume}).`, lien: `#/inventaire/${inv.id}`, type: 'info' });
    }
    ctx.emit('inventaire:valide', { inventaire: maj, mouvementIds });
    return detail(req, maj);
  }, { perm: [MODULE, 'valider'] });

  router.post('/api/inventaires/:id/annuler', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    exigerEnCours(inv);
    if (!(can(req, 'valider') || (can(req, 'creer') && Number(inv.createdBy) === req.user.id))) {
      throw new HttpError(403, 'Droit insuffisant : seul un valideur d\'inventaire ou le créateur de l\'inventaire peut l\'annuler');
    }
    const b = objet(req.body);
    const motif = texte(b.motif, 'Motif d\'annulation', { max: 500 });
    const maj = db.update(ENTITE, inv.id, { statut: 'annule', dateAnnulation: new Date().toISOString(), annulePar: req.user.id, motifAnnulation: motif });
    ctx.audit(req, 'statut', ENTITE, inv.id, `Inventaire ${inv.numero} — ${inv.nom} annulé${motif ? ' : ' + motif : ''} (aucun mouvement de stock)`);
    if (inv.createdBy != null && Number(inv.createdBy) !== req.user.id) {
      ctx.notify([inv.createdBy], { titre: 'Inventaire annulé', message: `${inv.numero} — ${inv.nom} : annulé par ${ctx.nomUser(req.user.id)}${motif ? ' (' + motif + ')' : ''}.`, lien: `#/inventaire/${inv.id}`, type: 'alerte' });
    }
    ctx.emit('inventaire:annule', { inventaire: maj });
    return detail(req, maj);
  }, { perm: [MODULE, 'voir'] });

  router.delete('/api/inventaires/:id', async (req) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    if (inv.statut === 'valide') throw new HttpError(400, `L'inventaire ${inv.numero} est validé : il justifie des mouvements de stock et ne peut pas être supprimé`);
    db.remove(ENTITE, inv.id);
    ctx.audit(req, 'suppression', ENTITE, inv.id, `Inventaire ${inv.numero} — ${inv.nom} (${libelleStatut(inv.statut)}, ${(inv.lignes || []).length} ligne(s))`);
    return { ok: true };
  }, { perm: [MODULE, 'supprimer'] });

  router.get('/api/inventaires/:id/export', async (req, res) => {
    const inv = ctx.getVisible(req, ENTITE, req.params.id);
    const d = detail(req, inv);
    const masque = d.masque;
    const valide = inv.statut === 'valide';
    const entetes = ['Code', 'Désignation', 'Emplacement', 'Catégorie', 'Unité']
      .concat(masque ? [] : ['Quantité théorique'])
      .concat(['Quantité comptée'])
      .concat(masque ? [] : ['Écart', 'Prix unitaire', 'Valeur de l\'écart'])
      .concat(valide && !masque ? ['Stock avant validation', 'Écart appliqué'] : [])
      .concat(['Hors périmètre', 'Nombre de comptages', 'Dernier comptage par', 'Date du dernier comptage', 'Mouvements depuis l\'ouverture']);
    const lignes = [BOM + entetes.map(csvEscape).join(';')];
    for (const l of d.lignes) {
      lignes.push([l.code, l.designation, l.emplacement, libelleListe('categoriesArticles', l.categorieCode), l.uniteLibelle || l.uniteCode || '']
        .concat(masque ? [] : [csvNombre(l.quantiteTheorique)])
        .concat([l.compte ? csvNombre(l.quantiteComptee) : (l.misAZero ? '0 (non compté)' : '')])
        .concat(masque ? [] : [l.compte ? csvNombre(l.ecart) : '', csvNombre(l.prixUnitaire), l.compte ? csvNombre(l.valeurEcart) : ''])
        .concat(valide && !masque ? [csvNombre(l.quantiteAvantValidation), csvNombre(l.ecartApplique)] : [])
        .concat([l.horsPerimetre ? 'Oui' : 'Non', String((l.comptages || []).length), l.dernierCompteurNom || '', l.dernierComptage ? new Date(l.dernierComptage).toLocaleString('fr-FR') : '', String(l.nbMouvementsDepuis || 0)])
        .map(csvEscape).join(';'));
    }
    ctx.audit(req, 'export', ENTITE, inv.id, `Inventaire ${inv.numero} : ${d.lignes.length} ligne(s)`);
    const fichier = `inventaire-${String(inv.numero || inv.id).replace(/[^\w.-]+/g, '_')}.csv`;
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fichier}"`, 'Cache-Control': 'no-store' });
    res.end(lignes.join('\r\n'));
  }, { perm: [MODULE, 'exporter'] });

  // ----- Étiquettes --------------------------------------------------------------------------
  function parseIds(v) {
    if (v == null || v === '') return null;
    const parts = String(v).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > MAX_IDS) throw new HttpError(400, `Trop d'éléments demandés (${MAX_IDS} au maximum)`);
    return parts.map((x) => { const n = Number(x); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Identifiant invalide : « ${x} »`); return n; });
  }
  function donneesArticle(a) {
    const c = controleCode(a.code || '');
    return {
      id: a.id, type: 'article', code: a.code || '', designation: a.designation || '', emplacement: a.emplacement || '', referenceFournisseur: a.referenceFournisseur || '',
      uniteCode: a.uniteCode || '', uniteLibelle: libelleListe('unites', a.uniteCode), categorieCode: a.categorieCode || '', categorieLibelle: libelleListe('categoriesArticles', a.categorieCode),
      prixUnitaire: num(a.prixUnitaire), quantite: arrondi(num(a.quantite)), seuilMin: num(a.seuilMin), sousSeuil: a.actif !== false && num(a.quantite) <= num(a.seuilMin),
      fournisseurId: a.fournisseurId == null || a.fournisseurId === '' ? null : Number(a.fournisseurId), fournisseurNom: nomFournisseur(a.fournisseurId),
      secteurId: a.secteurId == null || a.secteurId === '' ? null : Number(a.secteurId), secteurNom: nomSecteur(a.secteurId), actif: a.actif !== false,
      encodable: c.encodable, erreurCode: c.erreur,
    };
  }
  function donneesEquipement(e) {
    const c = controleCode(e.numero || '');
    return {
      id: e.id, type: 'equipement', code: e.numero || '', designation: e.nom || '', emplacement: e.localisation || '', referenceFournisseur: e.numeroSerie || '',
      typeCode: e.typeCode || '', typeLibelle: libelleListe('typesEquipement', e.typeCode), etatCode: e.etatCode || '', criticiteCode: e.criticiteCode || '',
      marque: e.marque || '', modele: e.modele || '', numeroSerie: e.numeroSerie || '',
      secteurId: e.secteurId == null || e.secteurId === '' ? null : Number(e.secteurId), secteurNom: nomSecteur(e.secteurId), secteurChemin: cheminSecteur(e.secteurId), actif: e.actif !== false,
      encodable: c.encodable, erreurCode: c.erreur,
    };
  }

  router.get('/api/etiquettes/donnees', async (req) => {
    const q = req.query || {};
    const source = q.source == null || q.source === '' ? 'articles' : String(q.source);
    if (!['articles', 'equipements'].includes(source)) throw new HttpError(400, 'Source d\'étiquettes inconnue : « articles » ou « equipements » attendu');
    ctx.requirePerm(req, source === 'articles' ? 'stock' : 'equipements', 'voir');
    const ids = parseIds(q.ids);
    const inactifs = vrai(q.inclureInactifs);
    let rows;
    if (source === 'articles') {
      rows = ctx.scope(req, db.list('articles'));
      if (!ids) {
        if (!inactifs) rows = rows.filter((a) => a.actif !== false);
        if (q.categorieCode) rows = rows.filter((a) => a.categorieCode === q.categorieCode);
        if (q.fournisseurId) { const f = idRef(q.fournisseurId, 'Fournisseur'); rows = rows.filter((a) => Number(a.fournisseurId) === f); }
        if (q.emplacement) { const p = cleEmplacement(q.emplacement); rows = rows.filter((a) => cleEmplacement(a.emplacement).startsWith(p)); }
        if (q.secteurId) { const s = new Set(perms.secteursDescendants(db, [idRef(q.secteurId, 'Secteur')])); rows = rows.filter((a) => a.secteurId != null && s.has(Number(a.secteurId))); }
        if (vrai(q.sousSeuil)) rows = rows.filter((a) => num(a.quantite) <= num(a.seuilMin));
      }
    } else {
      rows = db.list('equipements').filter((e) => equipementVisible(req, e));
      if (!ids) {
        if (!inactifs) rows = rows.filter((e) => e.actif !== false);
        if (q.typeCode) rows = rows.filter((e) => e.typeCode === q.typeCode);
        if (q.secteurId) { const s = new Set(perms.secteursDescendants(db, [idRef(q.secteurId, 'Secteur')])); rows = rows.filter((e) => e.secteurId != null && s.has(Number(e.secteurId))); }
      }
    }
    if (ids) {
      const parId = new Map(rows.map((r) => [r.id, r]));
      rows = ids.map((id) => parId.get(id)).filter(Boolean);
    } else {
      const termes = cleCode(q.recherche).split(/\s+/).filter(Boolean);
      if (termes.length) rows = rows.filter((r) => { const t = cleCode([r.code, r.numero, r.designation, r.nom, r.referenceFournisseur, r.emplacement, r.localisation].filter(Boolean).join(' ')); return termes.every((x) => t.includes(x)); });
      rows.sort(source === 'articles'
        ? (a, b) => cleEmplacement(a.emplacement).localeCompare(cleEmplacement(b.emplacement), 'fr', { numeric: true }) || String(a.code || '').localeCompare(String(b.code || ''), 'fr', { numeric: true })
        : (a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true }));
    }
    const lignes = rows.map(source === 'articles' ? donneesArticle : donneesEquipement);
    return { source, lignes, total: lignes.length, manquants: ids ? ids.length - lignes.length : 0, societe: (ctx.config().societe || {}).nom || '' };
  }, { perm: [MODULE, 'voir'] });

  /** Listes de choix des filtres (emplacements, fournisseurs référencés par les articles visibles). */
  router.get('/api/inventaire/references', async (req) => {
    const articles = can(req, 'voir', 'stock') ? ctx.scope(req, db.list('articles', (a) => a.actif !== false)) : [];
    const emplacements = Array.from(new Set(articles.map((a) => String(a.emplacement || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
    // Zones : premiers niveaux d'emplacement (« Magasin central », « Magasin central — A1 »…)
    const zones = new Set();
    for (const e of emplacements) {
      const parts = e.split(/\s+[—–-]\s+/);
      for (let i = 1; i < parts.length; i++) zones.add(parts.slice(0, i).join(' — '));
    }
    const fIds = new Set(articles.map((a) => Number(a.fournisseurId)).filter((x) => x > 0));
    const fournisseurs = db.list('fournisseurs', (f) => fIds.has(f.id) || (can(req, 'voir', 'fournisseurs') && f.actif !== false))
      .map((f) => ({ id: f.id, nom: f.nom || `#${f.id}` })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    return { emplacements, zones: Array.from(zones).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })), fournisseurs, stockDisponible: !!ctx.services.stock, statuts: statutsInventaire() };
  }, { perm: [MODULE, 'voir'] });

  // ----- Services publiés ------------------------------------------------------------------
  ctx.services.inventaire = {
    /** Résolution d'un code scanné selon les droits et la portée de la requête (null si rien). */
    resoudreCode: (req, code) => resoudreCode(req, code),
    /** Inventaires en cours contenant un article (sans contrôle de portée). */
    enCoursPourArticle: (articleId) => db.list(ENTITE, (i) => i.statut === 'en_cours' && (i.lignes || []).some((l) => Number(l.articleId) === Number(articleId))).map((i) => ({ id: i.id, numero: i.numero, nom: i.nom })),
    calculerResume,
    STATUTS: STATUTS.slice(),
  };
}

// ----- Données de démonstration -------------------------------------------------------------
let seedEnCours = false;
const NOM_VALIDE = 'Inventaire tournant — Magasin central';
const NOM_EN_COURS = 'Inventaire tournant — Allée D (électricité)';

function seedDemo(ctx) {
  const { db } = ctx;
  if (seedEnCours) return 'en cours';
  if (db.findOne(ENTITE, (i) => i.nom === NOM_VALIDE || i.nom === NOM_EN_COURS)) return 'déjà présents';
  seedEnCours = true;
  try {
    // Dépendances idempotentes : le module OT (chargé après celui-ci) antidate des sorties de stock ;
    // il est appelé avant pour que l'historique des articles soit complet avant la reconstitution.
    for (const fichier of ['profils.js', 'secteurs.js', 'utilisateurs.js', 'fournisseurs.js', 'equipements.js', 'stock.js', 'demandes.js', 'ot.js']) {
      const m = (ctx.modules || []).find((x) => x.fichier === fichier);
      if (m && typeof m.seedDemo === 'function') { try { m.seedDemo(ctx); } catch (e) { ctx.log('Inventaire : seed dépendant en échec', fichier, e.message); } }
    }
    return insererDemo(ctx);
  } finally { seedEnCours = false; }
}

function insererDemo(ctx) {
  const { db } = ctx;
  const cfg = db.getConfig();
  const gabarit = (cfg.numerotation || {}).inv || 'INV-{annee}-{num:3}';
  const admin = db.findOne('users', (u) => u.login === 'admin') || db.findOne('users', () => true);
  const userId = (login) => { const u = db.findOne('users', (x) => x.login === login); return u ? u.id : (admin ? admin.id : null); };
  const secteur = (code) => { const s = db.findOne('secteurs', (x) => x.code === code); return s ? s.id : null; };
  const instant = (jours, heure) => { const d = new Date(); d.setDate(d.getDate() - jours); const [h, mi] = heure.split(':').map(Number); d.setHours(h, mi, 0, 0); return d.toISOString(); };
  const numero = () => { for (let i = 0; i < 1000; i++) { const n = db.nextNumber('inv', gabarit); if (!db.findOne(ENTITE, (x) => x.numero === n)) return n; } return 'INV-' + Date.now(); };

  const articles = db.list('articles', (a) => a.actif !== false);
  if (!articles.some((a) => a.designation === 'Roulement à billes 6205-2RS')) return 'aucun article de démonstration : aucun inventaire créé';
  const prefixe = (p) => articles.filter((a) => cleEmplacement(a.emplacement).startsWith(cleEmplacement(p)))
    .sort((a, b) => cleEmplacement(a.emplacement).localeCompare(cleEmplacement(b.emplacement), 'fr', { numeric: true }) || String(a.code).localeCompare(String(b.code), 'fr', { numeric: true }));
  const MAINT = secteur('MAINT') || secteur('SITE');
  const resp = userId('mdupont');
  const colMvt = db.data.collections.mouvementsStock || (db.data.collections.mouvementsStock = []);
  const colArt = db.data.collections.articles;
  const colInv = () => db.data.collections[ENTITE];
  const historique = (articleId) => colMvt.filter((m) => Number(m.articleId) === articleId).sort((x, y) => String(x.date).localeCompare(String(y.date)) || x.id - y.id);
  const quantiteA = (articleId, date) => { let q = 0; for (const m of historique(articleId)) { if (String(m.date) > date) break; q = num(m.quantiteApres); } return arrondi(q); };
  const out = [];

  // 1) Inventaire tournant validé il y a 30 jours (quelques écarts)
  const central = prefixe('Magasin central');
  if (central.length) {
    const ouverture = instant(30, '07:30');
    const validation = instant(30, '16:45');
    // Écarts constatés : l'historique antérieur est décalé pour que la chaîne des mouvements reste
    // cohérente et que le stock actuel des articles ne change pas.
    const ECARTS = { 'Roulement à billes 6205-2RS': -2, 'Contacteur TeSys D 18 A — bobine 24 V CC': -1, 'Capteur inductif M18 PNP 8 mm': 1 };
    const num1 = numero();
    const nomComplet = NOM_VALIDE;
    const motif = `Inventaire ${num1} — ${nomComplet}`;
    const lignes = [];
    const mouvementIds = [];
    const compteurs = [userId('kleroy'), userId('jbernard')];
    let i = 0;
    for (const a of central) {
      const hist = historique(a.id);
      const avantInv = hist.filter((m) => String(m.date) <= validation);
      if (!avantInv.length) continue; // article créé après l'inventaire
      const T = quantiteA(a.id, validation);
      let e = ECARTS[a.designation] || 0;
      if (e !== 0) {
        const premier = avantInv[0];
        const minimum = Math.min(...avantInv.map((m) => num(m.quantiteApres)));
        if (premier.type !== 'inventaire' || minimum - e < 0 || T - e < 0) e = 0;
      }
      if (e !== 0) {
        for (const m of avantInv) {
          m.quantiteApres = arrondi(num(m.quantiteApres) - e);
          if (m === avantInv[0]) { m.quantite = m.quantiteApres; m.ecart = arrondi(m.quantiteApres - num(m.quantiteAvant)); } else {
            m.quantiteAvant = arrondi(num(m.quantiteAvant) - e);
            if (m.type === 'inventaire') m.quantite = m.quantiteApres;
          }
        }
      }
      const theorique = arrondi(T - e);
      const mvt = db.insert('mouvementsStock', {
        articleId: a.id, type: 'inventaire', quantite: T, quantiteAvant: theorique, quantiteApres: T, ecart: e, date: validation,
        userId: resp, otId: null, motif, prixUnitaire: num(a.prixUnitaire), fournisseurId: null, mouvementOrigineId: null, annuleParId: null, createdBy: resp,
      });
      const brut = colMvt.find((x) => x.id === mvt.id);
      if (brut) { brut.createdAt = validation; brut.updatedAt = validation; }
      const brutA = colArt.find((x) => x.id === a.id);
      if (brutA && (!brutA.dateDernierInventaire || String(brutA.dateDernierInventaire) < validation)) brutA.dateDernierInventaire = validation;
      mouvementIds.push(mvt.id);
      const compteur = compteurs[i % compteurs.length];
      i++;
      lignes.push({
        articleId: a.id, code: a.code || '', designation: a.designation || '', emplacement: a.emplacement || '', uniteCode: a.uniteCode || null,
        categorieCode: a.categorieCode || null, referenceFournisseur: a.referenceFournisseur || '', codeBarre: a.codeBarre || '',
        prixUnitaire: arrondi(num(a.prixUnitaire), 4), quantiteTheorique: theorique, quantiteComptee: T,
        comptages: [{ userId: compteur, date: instant(30, `${String(8 + (i % 6)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`), quantite: T, mode: 'remplacer', resultat: T }],
        horsPerimetre: false, mouvementId: mvt.id, quantiteAvantValidation: theorique, ecartApplique: e,
      });
    }
    if (lignes.length) {
      const resume = calculerResume(lignes);
      const inv = db.insert(ENTITE, {
        numero: num1, nom: nomComplet, statut: 'valide', secteurId: MAINT, filtres: { categorieCode: null, emplacement: 'Magasin central', fournisseurId: null, secteurId: null },
        aveugle: false, commentaire: 'Inventaire tournant trimestriel du magasin de maintenance (allées A à D). Écarts expliqués : deux roulements sortis sans bon, un contacteur utilisé sur la fardeleuse, un capteur retrouvé dans une caisse de retour.',
        lignes, createdBy: resp, dateOuverture: ouverture, dateValidation: validation, validePar: resp, mouvementIds, nonComptesAZero: false, resume,
      });
      const brut = colInv().find((x) => x.id === inv.id);
      if (brut) { brut.createdAt = ouverture; brut.updatedAt = validation; }
      out.push(`${num1} validé il y a 30 jours (${lignes.length} articles, ${resume.nbEcarts} écarts)`);
    }
  }

  // 2) Inventaire en cours sur l'allée D (partiellement compté, à l'aveugle)
  const allee = prefixe('Magasin central — D');
  if (allee.length) {
    const ouverture = instant(2, '07:45');
    const lignes = allee.map((a) => ({
      articleId: a.id, code: a.code || '', designation: a.designation || '', emplacement: a.emplacement || '', uniteCode: a.uniteCode || null,
      categorieCode: a.categorieCode || null, referenceFournisseur: a.referenceFournisseur || '', codeBarre: a.codeBarre || '',
      prixUnitaire: arrondi(num(a.prixUnitaire), 4), quantiteTheorique: quantiteA(a.id, ouverture), quantiteComptee: null, comptages: [], horsPerimetre: false,
    }));
    const tech = userId('kleroy');
    lignes.forEach((l, idx) => {
      if (idx > 1) return; // les deux premiers emplacements sont comptés, le reste reste à faire
      const q = idx === 1 ? Math.max(0, arrondi(l.quantiteTheorique - 1)) : l.quantiteTheorique;
      l.quantiteComptee = q;
      l.comptages = [{ userId: tech, date: instant(1, idx ? '14:20' : '14:05'), quantite: q, mode: 'remplacer', resultat: q }];
    });
    const num2 = numero();
    const inv = db.insert(ENTITE, {
      numero: num2, nom: NOM_EN_COURS, statut: 'en_cours', secteurId: MAINT, filtres: { categorieCode: null, emplacement: 'Magasin central — D', fournisseurId: null, secteurId: null },
      aveugle: true, commentaire: 'Comptage à l\'aveugle de l\'allée D (matériel électrique) avant la commande trimestrielle Rexel / Schneider.',
      lignes, createdBy: resp, dateOuverture: ouverture, dateValidation: null, validePar: null, mouvementIds: [], resume: calculerResume(lignes),
    });
    const brut = colInv().find((x) => x.id === inv.id);
    if (brut) { brut.createdAt = ouverture; brut.updatedAt = instant(1, '14:20'); }
    out.push(`${num2} en cours sur l'allée D (${lignes.length} articles, ${lignes.filter((l) => l.quantiteComptee != null).length} comptés)`);
  }
  db.touch();
  return out.length ? `${out.length} inventaire(s) : ${out.join(' ; ')}` : 'aucun article de démonstration dans le magasin central : aucun inventaire créé';
}

module.exports = { nom, register, seedDemo, calculerResume, cleCode, cleEmplacement, STATUTS };
