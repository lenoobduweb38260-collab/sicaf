'use strict';
/**
 * Module Utilisateurs : comptes internes, hiérarchie (supérieur, niveau de profil),
 * rattachement aux secteurs, surcharges individuelles de droits.
 */
const nom = 'Utilisateurs';

function register(ctx) {
  const { router, db, HttpError, auth, perms } = ctx;

  const clean = (u) => auth.cleanUser(u);

  function validerUser(req, body, existant) {
    const out = {};
    const login = String(body.login == null ? (existant ? existant.login : '') : body.login).trim();
    if (!login) throw new HttpError(400, 'L\'identifiant est obligatoire');
    if (!/^[\w.@-]{2,50}$/.test(login)) throw new HttpError(400, 'Identifiant invalide (2 à 50 caractères : lettres, chiffres, . _ @ -)');
    const doublon = db.findOne('users', (u) => u.login.toLowerCase() === login.toLowerCase() && (!existant || u.id !== existant.id));
    if (doublon) throw new HttpError(400, 'Cet identifiant est déjà utilisé');
    out.login = login;
    out.nom = String(body.nom == null ? (existant ? existant.nom : '') : body.nom).trim();
    if (!out.nom) throw new HttpError(400, 'Le nom est obligatoire');
    out.prenom = String(body.prenom == null ? (existant ? existant.prenom || '' : '') : body.prenom).trim();
    out.email = String(body.email == null ? (existant ? existant.email || '' : '') : body.email).trim();
    out.telephone = String(body.telephone == null ? (existant ? existant.telephone || '' : '') : body.telephone).trim();
    out.fonction = String(body.fonction == null ? (existant ? existant.fonction || '' : '') : body.fonction).trim();
    out.matricule = String(body.matricule == null ? (existant ? existant.matricule || '' : '') : body.matricule).trim();

    // Profil
    const profilId = body.profilId == null ? (existant ? existant.profilId : null) : Number(body.profilId);
    const profil = db.get('profils', profilId);
    if (!profil) throw new HttpError(400, 'Profil invalide');
    if (!perms.canManageUser(req.perms, profil)) throw new HttpError(403, `Vous ne pouvez pas attribuer le profil « ${profil.nom} » (niveau hiérarchique supérieur ou égal au vôtre)`);
    out.profilId = profil.id;

    // Secteurs
    const secteurIds = Array.isArray(body.secteurIds) ? body.secteurIds.map(Number).filter((n) => db.get('secteurs', n)) : (existant ? existant.secteurIds || [] : []);
    if (req.perms.portee === 'secteurs' && !req.perms.estAdmin) {
      const interdits = secteurIds.filter((s) => !req.perms.secteurIds.includes(s));
      if (interdits.length) throw new HttpError(403, 'Vous ne pouvez rattacher un utilisateur qu\'à vos propres secteurs');
    }
    out.secteurIds = Array.from(new Set(secteurIds));

    // Supérieur hiérarchique
    const managerId = body.managerId === undefined ? (existant ? existant.managerId : null) : (body.managerId == null || body.managerId === '' ? null : Number(body.managerId));
    if (managerId != null) {
      if (!db.get('users', managerId)) throw new HttpError(400, 'Supérieur hiérarchique invalide');
      if (existant && managerId === existant.id) throw new HttpError(400, 'Un utilisateur ne peut pas être son propre supérieur');
      // Pas de cycle
      if (existant) {
        let cur = db.get('users', managerId); const vus = new Set();
        while (cur && cur.managerId != null && !vus.has(cur.id)) {
          if (cur.managerId === existant.id) throw new HttpError(400, 'Cycle hiérarchique détecté');
          vus.add(cur.id); cur = db.get('users', cur.managerId);
        }
      }
    }
    out.managerId = managerId;

    out.actif = body.actif === undefined ? (existant ? existant.actif !== false : true) : !!body.actif;

    // Surcharges individuelles de droits (plus ou moins que le profil)
    if (body.overrides !== undefined) {
      const ov = perms.normaliserOverrides(body.overrides);
      const manquants = perms.droitsNonPossedes(req.perms, ov);
      if (manquants.length) throw new HttpError(403, 'Vous ne pouvez pas accorder des droits que vous ne possédez pas : ' + manquants.join(', '));
      out.overrides = ov;
    } else if (!existant) out.overrides = {};

    if (body.porteeOverride !== undefined) {
      const p = body.porteeOverride;
      out.porteeOverride = p && perms.PORTEES[p] ? p : null;
      if (out.porteeOverride === 'tous' && req.perms.portee !== 'tous') throw new HttpError(403, 'Vous ne pouvez pas accorder une portée supérieure à la vôtre');
    } else if (!existant) out.porteeOverride = null;

    // Accès aux autres sites (lecture seule ou complet) : on ne peut accorder que ce qu'on possède soi-même
    if (body.siteAcces !== undefined) {
      const acces = perms.normaliserSiteAcces(db, body.siteAcces);
      if (!req.perms.estAdmin && req.perms.portee !== 'tous') {
        for (const a of acces) {
          const mien = (req.perms.sites || []).find((x) => x.id === a.siteId);
          const nomSite = (db.get('secteurs', a.siteId) || {}).nom || a.siteId;
          if (!mien) throw new HttpError(403, `Vous ne pouvez pas accorder l'accès au site « ${nomSite} » : vous n'y avez pas accès`);
          if (a.mode === 'complet' && mien.mode !== 'complet') throw new HttpError(403, `Vous n'avez qu'un accès en lecture au site « ${nomSite} »`);
        }
      }
      out.siteAcces = acces;
    } else if (!existant) out.siteAcces = [];

    if (body.champs !== undefined || !existant) out.champs = ctx.champsPerso('utilisateurs', body.champs || (existant && existant.champs) || {});
    if (body.commentaire !== undefined) out.commentaire = String(body.commentaire || '');
    return out;
  }

  function verifierDernierAdmin(cible, patch) {
    const adminProfils = db.list('profils', (p) => p.estAdmin).map((p) => p.id);
    const estAdminCible = adminProfils.includes(cible.profilId) && cible.actif !== false;
    if (!estAdminCible) return;
    const resteAdmin = adminProfils.includes(patch.profilId === undefined ? cible.profilId : patch.profilId) && (patch.actif === undefined ? cible.actif !== false : patch.actif);
    if (resteAdmin) return;
    const autres = db.count('users', (u) => u.id !== cible.id && adminProfils.includes(u.profilId) && u.actif !== false);
    if (autres === 0) throw new HttpError(400, 'Impossible : il doit rester au moins un administrateur actif');
  }

  // Liste (triable par secteur côté client ; on fournit tout ce qu'il faut)
  router.get('/api/utilisateurs', async (req) => {
    let rows = db.list('users');
    if (req.perms.portee !== 'tous') {
      const visibles = new Set(req.perms.secteurIds.concat(req.perms.secteurIdsLecture || []));
      rows = rows.filter((u) => u.id === req.user.id || (u.secteurIds || []).length === 0 || (u.secteurIds || []).some((s) => visibles.has(Number(s))));
    }
    if (req.perms.siteFiltre) {
      const site = new Set(req.perms.siteFiltre);
      rows = rows.filter((u) => u.id === req.user.id || !(u.secteurIds || []).length || u.secteurIds.some((x) => site.has(Number(x))) || (u.siteAcces || []).some((a) => site.has(Number(a.siteId))));
    }
    return rows.map(clean);
  }, { perm: ['utilisateurs', 'voir'] });

  router.get('/api/utilisateurs/:id', async (req) => {
    const u = db.get('users', req.params.id);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    const profil = db.get('profils', u.profilId);
    return Object.assign(clean(u), {
      permissionsEffectives: perms.effectivePermissions(db, u, profil, db.getConfig()),
      subordonnes: db.list('users', (x) => x.managerId === u.id).map((x) => ({ id: x.id, nom: x.nom, prenom: x.prenom, login: x.login })),
    });
  }, { perm: ['utilisateurs', 'voir'] });

  router.post('/api/utilisateurs', async (req) => {
    const data = validerUser(req, req.body || {}, null);
    // Sans mot de passe fourni : mot de passe aléatoire conforme, renvoyé une seule fois pour être communiqué
    const genere = req.body.password == null || req.body.password === '';
    const pwd = genere ? auth.genererMotDePasse() : String(req.body.password);
    const err = auth.validerMotDePasse(pwd, db.getConfig(), { login: data.login });
    if (err) throw new HttpError(400, err);
    data.passwordHash = auth.hashPassword(pwd);
    data.doitChangerMdp = req.body.doitChangerMdp === undefined ? true : !!req.body.doitChangerMdp;
    data.preferences = { theme: 'clair' };
    data.derniereConnexion = null;
    data.createdBy = req.user.id;
    const u = db.insert('users', data);
    ctx.audit(req, 'creation', 'users', u.id, `Utilisateur ${u.login}`);
    return Object.assign(clean(u), genere ? { motDePasseInitial: pwd } : {});
  }, { perm: ['utilisateurs', 'creer'] });

  router.put('/api/utilisateurs/:id', async (req) => {
    const existant = db.get('users', req.params.id);
    if (!existant) throw new HttpError(404, 'Utilisateur introuvable');
    const profilExistant = db.get('profils', existant.profilId);
    if (existant.id !== req.user.id && !perms.canManageUser(req.perms, profilExistant)) throw new HttpError(403, 'Vous ne pouvez pas modifier un utilisateur de niveau hiérarchique supérieur ou égal au vôtre');
    const body = req.body || {};
    // Un utilisateur qui se modifie lui-même ne peut pas changer son profil / ses droits
    if (existant.id === req.user.id && !req.perms.estAdmin) {
      for (const k of ['profilId', 'overrides', 'porteeOverride', 'secteurIds', 'siteAcces', 'actif']) delete body[k];
    }
    const data = validerUser(req, body, existant);
    verifierDernierAdmin(existant, data);
    if (body.password) {
      const err = auth.validerMotDePasse(body.password, db.getConfig(), { login: data.login });
      if (err) throw new HttpError(400, err);
      data.passwordHash = auth.hashPassword(body.password);
      data.doitChangerMdp = body.doitChangerMdp === undefined ? true : !!body.doitChangerMdp;
      if (existant.id !== req.user.id) ctx.sessions.destroyUser(existant.id);
    }
    const u = db.update('users', existant.id, data);
    if (u.actif === false) ctx.sessions.destroyUser(u.id);
    ctx.audit(req, 'modification', 'users', u.id, `Utilisateur ${u.login}`);
    return clean(u);
  }, { perm: ['utilisateurs', 'modifier'] });

  router.delete('/api/utilisateurs/:id', async (req) => {
    const existant = db.get('users', req.params.id);
    if (!existant) throw new HttpError(404, 'Utilisateur introuvable');
    if (existant.id === req.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte');
    if (!perms.canManageUser(req.perms, db.get('profils', existant.profilId))) throw new HttpError(403, 'Niveau hiérarchique insuffisant');
    verifierDernierAdmin(existant, { actif: false });
    // On conserve la traçabilité : désactivation plutôt que suppression si l'utilisateur est référencé
    const reference = ['ot', 'demandes'].some((c) => db.count(c, (r) => r.createdBy === existant.id || r.demandeurId === existant.id || r.technicienId === existant.id || (r.techniciens || []).includes(existant.id)) > 0);
    if (reference) {
      db.update('users', existant.id, { actif: false, supprime: true });
      ctx.sessions.destroyUser(existant.id);
      ctx.audit(req, 'desactivation', 'users', existant.id, `Utilisateur ${existant.login} (référencé, désactivé)`);
      return { ok: true, desactive: true };
    }
    db.remove('users', existant.id);
    for (const u of db.list('users', (x) => x.managerId === existant.id)) db.update('users', u.id, { managerId: null });
    ctx.sessions.destroyUser(existant.id);
    ctx.audit(req, 'suppression', 'users', existant.id, `Utilisateur ${existant.login}`);
    return { ok: true };
  }, { perm: ['utilisateurs', 'supprimer'] });

  /** Réinitialisation du mot de passe par un gestionnaire. */
  router.post('/api/utilisateurs/:id/reinitialiser-mdp', async (req) => {
    const existant = db.get('users', req.params.id);
    if (!existant) throw new HttpError(404, 'Utilisateur introuvable');
    if (!perms.canManageUser(req.perms, db.get('profils', existant.profilId))) throw new HttpError(403, 'Niveau hiérarchique insuffisant');
    const pwd = req.body && req.body.password ? String(req.body.password) : auth.genererMotDePasse();
    const err = auth.validerMotDePasse(pwd, db.getConfig(), { login: existant.login });
    if (err) throw new HttpError(400, err);
    db.update('users', existant.id, { passwordHash: auth.hashPassword(pwd), doitChangerMdp: true });
    ctx.sessions.destroyUser(existant.id);
    ctx.audit(req, 'reinitialisation_mdp', 'users', existant.id, `Utilisateur ${existant.login}`);
    return { ok: true, motDePasse: pwd };
  }, { perm: ['utilisateurs', 'modifier'] });

  /** Organigramme hiérarchique (arbre supérieur → subordonnés). */
  router.get('/api/utilisateurs-organigramme', async (req) => {
    const users = db.list('users', (u) => u.actif !== false).map(clean);
    const byId = new Map(users.map((u) => [u.id, Object.assign(u, { enfants: [] })]));
    const racines = [];
    for (const u of users) {
      if (u.managerId != null && byId.has(u.managerId)) byId.get(u.managerId).enfants.push(u); else racines.push(u);
    }
    const profils = new Map(db.list('profils').map((p) => [p.id, p]));
    const tri = (arr) => { arr.sort((a, b) => ((profils.get(a.profilId) || {}).niveau || 99) - ((profils.get(b.profilId) || {}).niveau || 99) || a.nom.localeCompare(b.nom)); arr.forEach((x) => tri(x.enfants)); };
    tri(racines);
    return racines;
  }, { perm: ['utilisateurs', 'voir'] });
}

function seedDemo(ctx) {
  const { db, auth } = ctx;
  if (db.count('users') > 1) return 'déjà présents';
  const profil = (n) => (db.findOne('profils', (p) => p.nom === n) || {}).id;
  const secteur = (c) => (db.findOne('secteurs', (s) => s.code === c) || {}).id;
  const mk = (o) => db.insert('users', Object.assign({ passwordHash: auth.hashPassword('demo'), actif: true, overrides: {}, porteeOverride: null, doitChangerMdp: false, preferences: { theme: 'clair' }, email: '', telephone: '', derniereConnexion: null, champs: {} }, o));
  const resp = mk({ login: 'mdupont', nom: 'Dupont', prenom: 'Marie', fonction: 'Responsable maintenance', profilId: profil('Responsable maintenance'), secteurIds: [], managerId: 1 });
  const chef = mk({ login: 'pmartin', nom: 'Martin', prenom: 'Pierre', fonction: 'Chef de secteur Production', profilId: profil('Chef de secteur'), secteurIds: [secteur('PROD')], managerId: resp.id });
  mk({ login: 'jbernard', nom: 'Bernard', prenom: 'Julie', fonction: 'Technicienne de maintenance', profilId: profil('Technicien'), secteurIds: [secteur('PROD'), secteur('LOG')], managerId: resp.id });
  mk({ login: 'kleroy', nom: 'Leroy', prenom: 'Karim', fonction: 'Technicien électricien', profilId: profil('Technicien'), secteurIds: [secteur('MAINT'), secteur('SG')], managerId: resp.id });
  mk({ login: 'spetit', nom: 'Petit', prenom: 'Sophie', fonction: 'Opératrice ligne 1', profilId: profil('Demandeur'), secteurIds: [secteur('PROD')], managerId: chef.id });
  return '5 utilisateurs (mot de passe : demo)';
}

module.exports = { nom, register, seedDemo };
