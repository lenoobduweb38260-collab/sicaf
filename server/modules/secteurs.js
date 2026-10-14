'use strict';
/**
 * Module Secteurs : arborescence des secteurs (site > secteur > sous-secteur),
 * responsable, couleur, ordre. Sert au tri/regroupement des profils et utilisateurs
 * et à la portée des données.
 */
const nom = 'Secteurs';

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  function valider(body, existant) {
    const out = {};
    out.nom = String(body.nom == null ? (existant ? existant.nom : '') : body.nom).trim();
    if (!out.nom) throw new HttpError(400, 'Le nom du secteur est obligatoire');
    out.code = String(body.code == null ? (existant ? existant.code || '' : '') : body.code).trim().toUpperCase();
    if (out.code) {
      const doublon = db.findOne('secteurs', (s) => (s.code || '').toUpperCase() === out.code && (!existant || s.id !== existant.id));
      if (doublon) throw new HttpError(400, 'Ce code de secteur est déjà utilisé');
    }
    out.description = String(body.description == null ? (existant ? existant.description || '' : '') : body.description).trim();
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

  /** Gestion des secteurs : Configuration › Modifier, ou Plans 3D › Modifier (le responsable maintenance modélise ses sites). */
  function exigerGestion(req, cible) {
    if (!perms.can(req.perms, 'configuration', 'modifier') && !perms.can(req.perms, 'plans', 'modifier')) {
      throw new HttpError(403, 'Droit insuffisant : Configuration › Modifier ou Plans 3D › Modifier');
    }
    if (req.perms.estAdmin || req.perms.portee === 'tous') return;
    // Périmètre : on ne gère que les secteurs (et sous-secteurs) de ses propres sites / secteurs
    const ids = (cible || []).filter((x) => x != null).map(Number);
    if (!ids.length) throw new HttpError(403, 'Seul un utilisateur ayant accès à tous les sites peut créer un nouveau site racine');
    for (const id of ids) if (!req.perms.secteurIds.includes(id)) throw new HttpError(403, 'Ce secteur est hors de votre périmètre');
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
    exigerGestion(req, [body.parentId == null || body.parentId === '' ? null : Number(body.parentId)]);
    const s = db.insert('secteurs', valider(body, null));
    ctx.audit(req, 'creation', 'secteurs', s.id, `Secteur ${s.nom}`);
    return enrichir(s);
  });

  router.put('/api/secteurs/:id', async (req) => {
    const existant = db.get('secteurs', req.params.id);
    if (!existant) throw new HttpError(404, 'Secteur introuvable');
    const body = req.body || {};
    exigerGestion(req, [existant.id, body.parentId === undefined ? existant.parentId : (body.parentId === '' ? null : body.parentId)]);
    const s = db.update('secteurs', existant.id, valider(req.body || {}, existant));
    ctx.audit(req, 'modification', 'secteurs', s.id, `Secteur ${s.nom}`);
    return enrichir(s);
  });

  router.delete('/api/secteurs/:id', async (req) => {
    const existant = db.get('secteurs', req.params.id);
    if (!existant) throw new HttpError(404, 'Secteur introuvable');
    if (db.count('secteurs', (s) => s.parentId === existant.id)) throw new HttpError(400, 'Supprimez ou déplacez d\'abord les sous-secteurs');
    const refs = [];
    const nbEq = db.count('equipements', (e) => e.secteurId === existant.id); if (nbEq) refs.push(`${nbEq} équipement(s)`);
    const nbU = db.count('users', (u) => (u.secteurIds || []).includes(existant.id)); if (nbU) refs.push(`${nbU} utilisateur(s)`);
    const nbP = db.count('profils', (p) => p.secteurId === existant.id); if (nbP) refs.push(`${nbP} profil(s)`);
    const nbOt = db.count('ot', (o) => o.secteurId === existant.id); if (nbOt) refs.push(`${nbOt} ordre(s) de travail`);
    if (refs.length && !(req.query.forcer === '1')) throw new HttpError(400, `Ce secteur est utilisé par : ${refs.join(', ')}. Ajoutez ?forcer=1 pour détacher ces éléments.`);
    if (refs.length) {
      for (const e of db.list('equipements', (e) => e.secteurId === existant.id)) db.update('equipements', e.id, { secteurId: null });
      for (const u of db.list('users', (u) => (u.secteurIds || []).includes(existant.id))) db.update('users', u.id, { secteurIds: u.secteurIds.filter((x) => x !== existant.id) });
      for (const p of db.list('profils', (p) => p.secteurId === existant.id)) db.update('profils', p.id, { secteurId: null });
      for (const o of db.list('ot', (o) => o.secteurId === existant.id)) db.update('ot', o.id, { secteurId: null });
      for (const d of db.list('demandes', (d) => d.secteurId === existant.id)) db.update('demandes', d.id, { secteurId: null });
    }
    db.remove('secteurs', existant.id);
    ctx.audit(req, 'suppression', 'secteurs', existant.id, `Secteur ${existant.nom}`);
    return { ok: true };
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
