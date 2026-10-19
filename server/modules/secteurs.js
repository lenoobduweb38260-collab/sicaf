'use strict';
/**
 * Module Secteurs : arborescence des secteurs (site > secteur > sous-secteur),
 * responsable, couleur, ordre. Sert au tri/regroupement des profils et utilisateurs
 * et à la portée des données.
 */
const nom = 'Secteurs';

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  /** Texte libre : seule une chaîne est acceptée (booléens, nombres, tableaux et objets refusés). */
  function chaine(v, libelle) {
    if (v == null) return '';
    if (typeof v !== 'string') throw new HttpError(400, `${libelle} : valeur invalide (texte attendu)`);
    return v.trim();
  }
  /** Valeur texte saisie, ou valeur existante quand le champ n'est pas fourni. */
  const texteOuExistant = (body, existant, cle, libelle) => (body[cle] == null ? String((existant && existant[cle]) || '').trim() : chaine(body[cle], libelle));

  function valider(body, existant) {
    const out = {};
    out.nom = texteOuExistant(body, existant, 'nom', 'Le nom du secteur');
    if (!out.nom) throw new HttpError(400, 'Le nom du secteur est obligatoire');
    out.code = texteOuExistant(body, existant, 'code', 'Le code du secteur').toUpperCase();
    if (out.code) {
      const doublon = db.findOne('secteurs', (s) => (s.code || '').toUpperCase() === out.code && (!existant || s.id !== existant.id));
      if (doublon) throw new HttpError(400, 'Ce code de secteur est déjà utilisé');
    }
    out.description = texteOuExistant(body, existant, 'description', 'La description');
    out.couleur = /^#[0-9a-fA-F]{6}$/.test(body.couleur || '') ? body.couleur : (existant ? existant.couleur || '#6b7280' : '#6b7280');
    out.ordre = body.ordre == null ? (existant ? existant.ordre || 0 : db.count('secteurs') + 1) : Number(body.ordre) || 0;
    const parentId = body.parentId === undefined ? (existant ? existant.parentId : null) : (body.parentId == null || body.parentId === '' ? null : Number(body.parentId));
    if (parentId != null) {
      if (!db.get('secteurs', parentId)) throw new HttpError(400, 'Secteur parent invalide');
      if (existant) {
        if (parentId === existant.id) throw new HttpError(400, 'Un secteur ne peut pas être son propre parent');
        let cur = db.get('secteurs', parentId); const vus = new Set();
        while (cur && cur.parentId != null && !vus.has(cur.id)) {
          if (cur.parentId === existant.id) throw new HttpError(400, 'Cycle détecté dans l\'arborescence des secteurs');
          vus.add(cur.id); cur = db.get('secteurs', cur.parentId);
        }
      }
    }
    out.parentId = parentId;
    const responsableId = body.responsableId === undefined ? (existant ? existant.responsableId : null) : (body.responsableId == null || body.responsableId === '' ? null : Number(body.responsableId));
    if (responsableId != null && !db.get('users', responsableId)) throw new HttpError(400, 'Responsable invalide');
    out.responsableId = responsableId;
    out.actif = body.actif === undefined ? (existant ? existant.actif !== false : true) : !!body.actif;
    out.type = ctx.codeListe('typesSecteur', body.type === undefined ? (existant ? existant.type : (parentId == null ? 'site' : 'service')) : body.type);
    // Informations propres à un site (adresse, téléphone…)
    if (out.type === 'site') {
      const src = body.infosSite || (existant && existant.infosSite) || {};
      out.infosSite = { adresse: String(src.adresse || '').slice(0, 300), ville: String(src.ville || '').slice(0, 120), telephone: String(src.telephone || '').slice(0, 40), email: String(src.email || '').slice(0, 120) };
    }
    return out;
  }

  /**
   * Gestion des secteurs : Configuration › Modifier, ou Plans 3D › Modifier (le responsable maintenance modélise ses
   * sites : il crée et renomme des secteurs, sans déplacer un secteur, changer son type ni son responsable).
   * Sans accès à tous les sites : uniquement dans son périmètre, sans créer de site ni détacher un secteur de son site.
   * @param {{ existant?: object, parentId?: number|null, type?: string, structure?: boolean }} cible
   */
  function exigerDroitGestion(req) {
    if (!perms.can(req.perms, 'configuration', 'modifier') && !perms.can(req.perms, 'plans', 'modifier')) {
      throw new HttpError(403, 'Droit insuffisant : Configuration › Modifier ou Plans 3D › Modifier');
    }
  }
  function exigerGestion(req, cible) {
    exigerDroitGestion(req);
    const config = perms.can(req.perms, 'configuration', 'modifier');
    const { existant, parentId, type } = cible;
    if (existant && !config && cible.structure) {
      throw new HttpError(403, 'Droit insuffisant : Configuration › Modifier est requis pour déplacer un secteur, changer son type ou son responsable');
    }
    if (req.perms.estAdmin || req.perms.portee === 'tous') return;
    const RESERVE = 'Seul un utilisateur ayant accès à tous les sites peut créer un nouveau site racine, créer ou modifier un site, ou détacher un secteur de son site';
    // Périmètre : on ne gère que les secteurs (et sous-secteurs) de ses propres sites / secteurs
    if (parentId == null && (!existant || existant.parentId != null)) throw new HttpError(403, RESERVE);
    const typeAvant = existant ? existant.type : null;
    if ((type === 'site' || typeAvant === 'site') && type !== typeAvant) throw new HttpError(403, RESERVE);
    // Le secteur lui-même, et le parent (à la création, ou quand il change : renommer son secteur ne demande pas son parent)
    const parentControle = !existant || (parentId == null ? null : Number(parentId)) !== (existant.parentId == null ? null : Number(existant.parentId));
    for (const id of [existant ? existant.id : null, parentControle ? parentId : null]) {
      if (id != null && !req.perms.secteurIds.includes(Number(id))) throw new HttpError(403, 'Ce secteur est hors de votre périmètre');
    }
  }

  function enrichir(s) {
    return Object.assign({}, s, {
      parentNom: s.parentId != null ? ((db.get('secteurs', s.parentId) || {}).nom || '') : '',
      responsableNom: ctx.nomUser(s.responsableId),
      nbUtilisateurs: db.count('users', (u) => (u.secteurIds || []).includes(s.id)),
      nbProfils: db.count('profils', (p) => p.secteurId === s.id),
      nbEquipements: db.count('equipements', (e) => e.secteurId === s.id),
      siteId: perms.siteDuSecteur(db, s.id),
      typeLabel: (ctx.liste('typesSecteur').find((t) => t.code === s.type) || {}).label || s.type || '',
    });
  }

  const tri = (a, b) => (a.ordre || 0) - (b.ordre || 0) || a.nom.localeCompare(b.nom);

  router.get('/api/secteurs', async () => db.list('secteurs').sort(tri).map(enrichir));

  /** Arbre des secteurs. */
  router.get('/api/secteurs-arbre', async () => {
    const all = db.list('secteurs').sort(tri).map((s) => Object.assign(enrichir(s), { enfants: [] }));
    const byId = new Map(all.map((s) => [s.id, s]));
    const racines = [];
    for (const s of all) { if (s.parentId != null && byId.has(s.parentId)) byId.get(s.parentId).enfants.push(s); else racines.push(s); }
    return racines;
  });

  /** Sites (secteurs de type « site ») ; `accessibles` = ceux de l'utilisateur courant avec leur mode d'accès. */
  router.get('/api/sites', async (req) => ({
    sites: perms.sites(db).map(enrichir),
    accessibles: req.perms.sites,
    siteCourantId: req.perms.siteCourantId,
  }));

  router.get('/api/secteurs/:id', async (req) => {
    const s = db.get('secteurs', req.params.id);
    if (!s) throw new HttpError(404, 'Secteur introuvable');
    return enrichir(s);
  });

  router.post('/api/secteurs', async (req) => {
    const body = req.body || {};
    exigerDroitGestion(req);
    const data = valider(body, null);
    exigerGestion(req, { parentId: data.parentId, type: data.type });
    const s = db.insert('secteurs', data);
    ctx.audit(req, 'creation', 'secteurs', s.id, `Secteur ${s.nom}`);
    return enrichir(s);
  });

  router.put('/api/secteurs/:id', async (req) => {
    const existant = db.get('secteurs', req.params.id);
    if (!existant) throw new HttpError(404, 'Secteur introuvable');
    const body = req.body || {};
    exigerDroitGestion(req);
    const data = valider(body, existant);
    const structure = data.parentId !== (existant.parentId == null ? null : existant.parentId) || data.type !== existant.type
      || (data.responsableId == null ? null : data.responsableId) !== (existant.responsableId == null ? null : existant.responsableId);
    exigerGestion(req, { existant, parentId: data.parentId, type: data.type, structure });
    const s = db.update('secteurs', existant.id, data);
    ctx.audit(req, 'modification', 'secteurs', s.id, `Secteur ${s.nom}`);
    return enrichir(s);
  });

  /** Libellés des collections pour le message des références. */
  const LIBELLES_REFERENCES = {
    equipements: 'équipement(s)', users: 'utilisateur(s)', profils: 'profil(s)', ot: 'ordre(s) de travail', demandes: 'demande(s) d\'intervention',
    plansPreventifs: 'plan(s) préventif(s)', articles: 'article(s) de stock', inventaires: 'inventaire(s)', plans: 'plan(s) 3D', commandes: 'commande(s)',
    factures: 'facture(s)', personnel: 'fiche(s) du personnel', absences: 'absence(s)', formations: 'formation(s)', habilitations: 'habilitation(s)',
    visitesMedicales: 'visite(s) médicale(s)', visites: 'visite(s)', fournisseurs: 'fournisseur(s)', destinations: 'destination(s) de sauvegarde',
    zones: 'zone(s) de plan 3D', siteAcces: 'accès à un site',
  };
  /** Collections sans rattachement à un secteur (traçabilité, comptes en attente…). */
  const SANS_SECTEUR = new Set(['audit', 'notifications', 'demandesMdp', 'sauvegardesHistorique', 'secteurs']);

  /**
   * Références d'un secteur dans toute la base : `secteurId` de chaque collection, secteurs des utilisateurs et
   * accès à un site, zones des plans 3D, destinations de sauvegarde. Renvoie { compte: Map(type → nombre) }.
   */
  function references(id) {
    const compte = new Map();
    const ajouter = (k, n) => { if (n) compte.set(k, (compte.get(k) || 0) + n); };
    for (const col of db.collections()) {
      if (SANS_SECTEUR.has(col)) continue;
      ajouter(col, db.count(col, (r) => r && r.secteurId != null && Number(r.secteurId) === id));
    }
    ajouter('users', db.count('users', (u) => (u.secteurIds || []).map(Number).includes(id)));
    ajouter('siteAcces', db.count('users', (u) => (u.siteAcces || []).some((a) => Number(a.siteId) === id)));
    ajouter('zones', db.list('plans').reduce((n, p) => n + (p.objets || []).filter((o) => o && o.secteurId != null && Number(o.secteurId) === id).length, 0));
    const dest = ((db.data.config || {}).sauvegardes || {}).destinations;
    ajouter('destinations', (Array.isArray(dest) ? dest : []).filter((d) => d && d.secteurId != null && Number(d.secteurId) === id).length);
    return compte;
  }

  /**
   * Suppression d'un secteur sans sous-secteur. S'il est référencé, ?forcer=1 rattache les éléments à son secteur
   * parent (ils restent sur le même site, donc visibles des mêmes personnes), ou à aucun secteur pour un site ;
   * les utilisateurs perdent ce secteur (jamais un périmètre plus large).
   */
  router.delete('/api/secteurs/:id', async (req) => {
    const existant = db.get('secteurs', req.params.id);
    if (!existant) throw new HttpError(404, 'Secteur introuvable');
    if (!req.perms.estAdmin && req.perms.portee !== 'tous') {
      if (existant.type === 'site' || existant.parentId == null) throw new HttpError(403, 'Seul un utilisateur ayant accès à tous les sites peut supprimer un site');
      if (!req.perms.secteurIds.includes(existant.id)) throw new HttpError(403, 'Ce secteur est hors de votre périmètre');
    }
    if (db.count('secteurs', (s) => s.parentId === existant.id)) throw new HttpError(400, 'Supprimez ou déplacez d\'abord les sous-secteurs');
    const id = existant.id;
    const compte = references(id);
    const refs = Array.from(compte.entries()).map(([k, n]) => `${n} ${LIBELLES_REFERENCES[k] || k}`);
    if (refs.length && !(req.query.forcer === '1')) throw new HttpError(400, `Ce secteur est utilisé par : ${refs.join(', ')}. Ajoutez ?forcer=1 pour rattacher ces éléments au secteur parent.`);
    const parent = existant.parentId != null && db.get('secteurs', existant.parentId) ? Number(existant.parentId) : null;
    if (refs.length) {
      for (const col of db.collections()) {
        if (SANS_SECTEUR.has(col)) continue;
        for (const r of db.list(col, (x) => x && x.secteurId != null && Number(x.secteurId) === id)) db.update(col, r.id, { secteurId: parent });
      }
      for (const u of db.list('users', (x) => (x.secteurIds || []).map(Number).includes(id) || (x.siteAcces || []).some((a) => Number(a.siteId) === id))) {
        db.update('users', u.id, { secteurIds: (u.secteurIds || []).filter((x) => Number(x) !== id), siteAcces: (u.siteAcces || []).filter((a) => Number(a.siteId) !== id) });
      }
      for (const p of db.list('plans', (x) => (x.objets || []).some((o) => o && o.secteurId != null && Number(o.secteurId) === id))) {
        db.update('plans', p.id, { objets: p.objets.map((o) => (o && o.secteurId != null && Number(o.secteurId) === id ? Object.assign({}, o, { secteurId: parent }) : o)) });
      }
      const cfg = db.getConfig();
      if (cfg.sauvegardes && Array.isArray(cfg.sauvegardes.destinations) && cfg.sauvegardes.destinations.some((d) => d && d.secteurId != null && Number(d.secteurId) === id)) {
        cfg.sauvegardes.destinations = cfg.sauvegardes.destinations.map((d) => (d && d.secteurId != null && Number(d.secteurId) === id ? Object.assign({}, d, { secteurId: parent }) : d));
        db.setConfig(cfg);
      }
    }
    db.remove('secteurs', id);
    const vers = parent != null ? `rattachés à « ${(db.get('secteurs', parent) || {}).nom || parent} »` : 'détachés';
    ctx.audit(req, 'suppression', 'secteurs', id, `Secteur ${existant.nom}${refs.length ? ` (éléments ${vers} : ${refs.join(', ')})` : ''}`);
    return { ok: true, references: Object.fromEntries(compte), rattachesA: parent };
  }, { perm: ['configuration', 'modifier'] });
}

function seedDemo(ctx) {
  const { db } = ctx;
  if (db.findOne('secteurs', (s) => s.code === 'PROD-L1')) return 'déjà présents';
  const prod = db.findOne('secteurs', (s) => s.code === 'PROD');
  if (!prod) return 'secteur PROD absent';
  db.insert('secteurs', { nom: 'Ligne 1 - Conditionnement', code: 'PROD-L1', couleur: '#3b82f6', ordre: 1, parentId: prod.id, responsableId: null, actif: true, description: '' });
  db.insert('secteurs', { nom: 'Ligne 2 - Assemblage', code: 'PROD-L2', couleur: '#60a5fa', ordre: 2, parentId: prod.id, responsableId: null, actif: true, description: '' });
  return '2 sous-secteurs';
}

module.exports = { nom, register, seedDemo };
