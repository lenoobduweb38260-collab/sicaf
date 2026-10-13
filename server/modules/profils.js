'use strict';
/**
 * Module Profils & droits : matrice module × action, niveau hiérarchique,
 * portée des données, rattachement à un secteur (tri/regroupement par secteur).
 */
const nom = 'Profils';

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  function valider(req, body, existant) {
    const out = {};
    out.nom = String(body.nom == null ? (existant ? existant.nom : '') : body.nom).trim();
    if (!out.nom) throw new HttpError(400, 'Le nom du profil est obligatoire');
    const doublon = db.findOne('profils', (p) => p.nom.toLowerCase() === out.nom.toLowerCase() && (!existant || p.id !== existant.id));
    if (doublon) throw new HttpError(400, 'Un profil porte déjà ce nom');
    out.description = String(body.description == null ? (existant ? existant.description || '' : '') : body.description).trim();
    const niveau = body.niveau == null ? (existant ? existant.niveau : 5) : Number(body.niveau);
    if (!Number.isInteger(niveau) || niveau < 1 || niveau > 99) throw new HttpError(400, 'Le niveau hiérarchique doit être un entier entre 1 et 99 (1 = le plus élevé)');
    if (!req.perms.estAdmin && niveau <= req.perms.niveau) throw new HttpError(403, 'Vous ne pouvez créer que des profils de niveau inférieur au vôtre');
    out.niveau = niveau;
    out.couleur = /^#[0-9a-fA-F]{6}$/.test(body.couleur || '') ? body.couleur : (existant ? existant.couleur || '#6b7280' : '#6b7280');
    const portee = body.portee == null ? (existant ? existant.portee : 'tous') : body.portee;
    if (!perms.PORTEES[portee]) throw new HttpError(400, 'Portée invalide');
    if (!req.perms.estAdmin && portee === 'tous' && req.perms.portee !== 'tous') throw new HttpError(403, 'Vous ne pouvez pas accorder une portée supérieure à la vôtre');
    out.portee = portee;
    const secteurId = body.secteurId === undefined ? (existant ? existant.secteurId : null) : (body.secteurId == null || body.secteurId === '' ? null : Number(body.secteurId));
    if (secteurId != null && !db.get('secteurs', secteurId)) throw new HttpError(400, 'Secteur invalide');
    out.secteurId = secteurId;
    out.actif = body.actif === undefined ? (existant ? existant.actif !== false : true) : !!body.actif;
    // Seul un administrateur peut créer/modifier un profil administrateur
    const estAdmin = body.estAdmin === undefined ? (existant ? !!existant.estAdmin : false) : !!body.estAdmin;
    if (estAdmin && !req.perms.estAdmin) throw new HttpError(403, 'Seul un administrateur peut gérer un profil administrateur');
    out.estAdmin = estAdmin;
    if (body.permissions !== undefined) {
      const m = perms.normaliserMatrice(body.permissions);
      const manquants = perms.droitsNonPossedes(req.perms, m);
      if (manquants.length) throw new HttpError(403, 'Vous ne pouvez pas accorder des droits que vous ne possédez pas : ' + manquants.join(', '));
      out.permissions = m;
    } else if (!existant) out.permissions = perms.matriceVide();
    return out;
  }

  function enrichir(p) {
    return Object.assign({}, p, {
      nbUtilisateurs: db.count('users', (u) => u.profilId === p.id),
      secteurNom: p.secteurId != null ? ((db.get('secteurs', p.secteurId) || {}).nom || '') : '',
    });
  }

  /** Catalogue des modules/actions/portées (pour construire la matrice côté client). */
  router.get('/api/profils-catalogue', async () => ({ modules: perms.modulesConfigures(db.getConfig()), actions: perms.ACTIONS, portees: perms.PORTEES }));

  router.get('/api/profils', async (req) => {
    const cfg = db.getConfig().profils || {};
    let rows = db.list('profils').map(enrichir);
    const tri = req.query.tri || (cfg.triParSecteur ? 'secteur' : 'niveau');
    const secteurs = new Map(db.list('secteurs').map((s) => [s.id, s]));
    const ordreSecteur = (p) => (p.secteurId == null ? -1 : ((secteurs.get(p.secteurId) || {}).ordre || 0));
    if (tri === 'secteur') rows.sort((a, b) => ordreSecteur(a) - ordreSecteur(b) || (a.secteurNom || '').localeCompare(b.secteurNom || '') || a.niveau - b.niveau || a.nom.localeCompare(b.nom));
    else if (tri === 'nom') rows.sort((a, b) => a.nom.localeCompare(b.nom));
    else rows.sort((a, b) => a.niveau - b.niveau || a.nom.localeCompare(b.nom));
    if (req.query.secteurId) {
      const sid = req.query.secteurId === 'aucun' ? null : Number(req.query.secteurId);
      rows = rows.filter((p) => (sid == null ? p.secteurId == null : p.secteurId === sid));
    }
    return rows;
  }, { perm: ['profils', 'voir'] });

  router.get('/api/profils/:id', async (req) => {
    const p = db.get('profils', req.params.id);
    if (!p) throw new HttpError(404, 'Profil introuvable');
    return Object.assign(enrichir(p), { utilisateurs: db.list('users', (u) => u.profilId === p.id).map((u) => ({ id: u.id, login: u.login, nom: u.nom, prenom: u.prenom, actif: u.actif !== false })) });
  }, { perm: ['profils', 'voir'] });

  router.post('/api/profils', async (req) => {
    const data = valider(req, req.body || {}, null);
    const p = db.insert('profils', data);
    ctx.audit(req, 'creation', 'profils', p.id, `Profil ${p.nom}`);
    return enrichir(p);
  }, { perm: ['profils', 'creer'] });

  router.put('/api/profils/:id', async (req) => {
    const existant = db.get('profils', req.params.id);
    if (!existant) throw new HttpError(404, 'Profil introuvable');
    if (!req.perms.estAdmin && (existant.estAdmin || existant.niveau <= req.perms.niveau)) throw new HttpError(403, 'Vous ne pouvez modifier que des profils de niveau inférieur au vôtre');
    const data = valider(req, req.body || {}, existant);
    if (existant.estAdmin && (!data.estAdmin || !data.actif)) {
      const autres = db.count('profils', (p) => p.estAdmin && p.actif !== false && p.id !== existant.id);
      if (!autres) throw new HttpError(400, 'Il doit rester au moins un profil administrateur actif');
    }
    const p = db.update('profils', existant.id, data);
    ctx.audit(req, 'modification', 'profils', p.id, `Profil ${p.nom}`);
    return enrichir(p);
  }, { perm: ['profils', 'modifier'] });

  router.post('/api/profils/:id/dupliquer', async (req) => {
    const src = db.get('profils', req.params.id);
    if (!src) throw new HttpError(404, 'Profil introuvable');
    const { id, createdAt, updatedAt, ...rest } = src;
    let nomCopie = `${src.nom} (copie)`; let i = 2;
    while (db.findOne('profils', (p) => p.nom === nomCopie)) nomCopie = `${src.nom} (copie ${i++})`;
    const data = valider(req, Object.assign({}, rest, { nom: nomCopie, estAdmin: false, systeme: false }), null);
    data.systeme = false;
    const p = db.insert('profils', data);
    ctx.audit(req, 'duplication', 'profils', p.id, `Profil ${p.nom} (depuis ${src.nom})`);
    return enrichir(p);
  }, { perm: ['profils', 'creer'] });

  router.delete('/api/profils/:id', async (req) => {
    const existant = db.get('profils', req.params.id);
    if (!existant) throw new HttpError(404, 'Profil introuvable');
    if (existant.estAdmin) throw new HttpError(400, 'Le profil administrateur ne peut pas être supprimé');
    if (!req.perms.estAdmin && existant.niveau <= req.perms.niveau) throw new HttpError(403, 'Niveau hiérarchique insuffisant');
    const nb = db.count('users', (u) => u.profilId === existant.id);
    if (nb > 0) throw new HttpError(400, `Ce profil est utilisé par ${nb} utilisateur(s). Réaffectez-les d'abord.`);
    db.remove('profils', existant.id);
    ctx.audit(req, 'suppression', 'profils', existant.id, `Profil ${existant.nom}`);
    return { ok: true };
  }, { perm: ['profils', 'supprimer'] });

  /** Aperçu des droits effectifs d'un utilisateur (profil + surcharges). */
  router.get('/api/profils-effectifs/:userId', async (req) => {
    const u = db.get('users', req.params.userId);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    return perms.effectivePermissions(db, u, null, db.getConfig());
  }, { perm: ['profils', 'voir'] });
}

function seedDemo(ctx) {
  const { db, perms } = ctx;
  if (db.findOne('profils', (p) => p.nom === 'Magasinier')) return 'déjà présents';
  const m = perms.matriceVide();
  for (const a of ['voir', 'creer', 'modifier', 'supprimer', 'exporter']) m.stock[a] = true;
  for (const a of ['voir', 'creer', 'modifier']) m.fournisseurs[a] = true;
  m.dashboard.voir = true; m.ot.voir = true; m.equipements.voir = true;
  const log = db.findOne('secteurs', (s) => s.code === 'LOG');
  db.insert('profils', { nom: 'Magasinier', description: 'Gère le stock de pièces et les fournisseurs', niveau: 4, estAdmin: false, portee: 'tous', couleur: '#0891b2', secteurId: log ? log.id : null, actif: true, permissions: m, systeme: false });
  return '1 profil';
}

module.exports = { nom, register, seedDemo };
