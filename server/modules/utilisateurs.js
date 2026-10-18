'use strict';
/**
 * Module Utilisateurs : comptes internes, hiérarchie (supérieur, niveau de profil),
 * rattachement aux secteurs, surcharges individuelles de droits, état et réinitialisation
 * de la double authentification, réinitialisation du mot de passe (code à usage unique ou
 * mot de passe temporaire) et traitement des demandes faites depuis l'écran de connexion.
 */
const nom = 'Utilisateurs';

function register(ctx) {
  const { router, db, HttpError, auth, perms } = ctx;

  /**
   * Fiche sans secret (empreintes du mot de passe et des précédents, code de réinitialisation, clé et codes de
   * double authentification), avec l'état de la double authentification.
   */
  const clean = (u) => {
    const c = auth.cleanUser(u);
    if (c && ctx.deuxFacteurs) c.deuxFacteurs = Object.assign(c.deuxFacteurs, { exige: ctx.deuxFacteurs.exige(u) });
    return c;
  };

  /**
   * Portée : un utilisateur est visible s'il s'agit de soi, s'il n'est rattaché à aucun secteur ou s'il partage
   * un secteur accessible (en modification, les sites en lecture seule sont exclus) ; le site choisi dans
   * l'en-tête filtre en plus. Même règle pour les destinataires des demandes de réinitialisation (ctx.utilisateurVisible).
   */
  function visible(req, u, ecriture) {
    return ctx.utilisateurVisible(req.user, req.perms, u, ecriture);
  }
  const mdp = () => ctx.motsDePasse;
  const gerable = (req, u) => !!u && perms.canManageUser(req.perms, db.get('profils', u.profilId));
  /**
   * Prise en main d'un compte (mot de passe, code de réinitialisation, double authentification) : niveau hiérarchique
   * inférieur, et aucun droit individuel, portée, secteur ou accès à un site que le gestionnaire ne pourrait pas accorder.
   */
  function exigerPriseEnMain(req, cible, quoi) {
    if (!gerable(req, cible)) throw new HttpError(403, 'Niveau hiérarchique insuffisant');
    const d = perms.depassementsGestion(db, req.perms, cible);
    if (d.length) throw new HttpError(403, `Ce compte dispose de droits que vous ne pouvez pas accorder (${d.join(' ; ')}) : seul un gestionnaire qui les possède, ou un administrateur, peut ${quoi}.`);
  }

  /** Utilisateur visible ou 404. */
  function getVisible(req, id, ecriture) {
    const u = db.get('users', id);
    if (!u || !visible(req, u, ecriture)) throw new HttpError(404, 'Utilisateur introuvable');
    return u;
  }

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
  router.get('/api/utilisateurs', async (req) => db.list('users').filter((u) => visible(req, u, false)).map(clean), { perm: ['utilisateurs', 'voir'] });

  router.get('/api/utilisateurs/:id', async (req) => {
    const u = getVisible(req, req.params.id, false);
    const profil = db.get('profils', u.profilId);
    const fiche = Object.assign(clean(u), {
      permissionsEffectives: perms.effectivePermissions(db, u, profil, db.getConfig()),
      subordonnes: db.list('users', (x) => x.managerId === u.id).map((x) => ({ id: x.id, nom: x.nom, prenom: x.prenom, login: x.login })),
    });
    // État du mot de passe pour les gestionnaires de comptes (jamais l'empreinte ni le code)
    if (perms.can(req.perms, 'utilisateurs', 'modifier')) {
      const i = mdp().infos(u);
      fiche.motDePasse = Object.assign({ dateMdp: i.dateMdp, expireLe: i.expireLe, doitChanger: !!u.doitChangerMdp, raison: i.raison }, mdp().etatCode(u));
    }
    return fiche;
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
    data.raisonChangementMdp = data.doitChangerMdp ? 'initial' : null;
    data.dateMdp = new Date().toISOString();
    data.preferences = { theme: 'clair' };
    data.derniereConnexion = null;
    data.createdBy = req.user.id;
    const u = db.insert('users', data);
    ctx.audit(req, 'creation', 'users', u.id, `Utilisateur ${u.login}`);
    return Object.assign(clean(u), genere ? { motDePasseInitial: pwd } : {});
  }, { perm: ['utilisateurs', 'creer'] });

  router.put('/api/utilisateurs/:id', async (req) => {
    const existant = getVisible(req, req.params.id, true);
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
      // Son propre mot de passe se change avec l'ancien (et l'historique) : « Changer mon mot de passe »
      if (existant.id === req.user.id) throw new HttpError(400, 'Pour votre propre compte, utilisez « Changer mon mot de passe » dans le menu de votre compte');
      exigerPriseEnMain(req, existant, 'définir son mot de passe');
      const pwd = String(body.password);
      const err = auth.validerMotDePasse(pwd, db.getConfig(), { login: data.login });
      if (err) throw new HttpError(400, err);
      // Mot de passe défini par un administrateur : à changer à la prochaine connexion (sauf indication contraire)
      const imposer = body.doitChangerMdp === undefined ? true : !!body.doitChangerMdp;
      Object.assign(data, mdp().champsNouveau(existant, pwd, { doitChanger: imposer, raison: 'administrateur' }));
      if (existant.id !== req.user.id) ctx.sessions.destroyUser(existant.id);
      if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(existant.id);
    }
    const u = db.update('users', existant.id, data);
    if (u.actif === false) {
      ctx.sessions.destroyUser(u.id);
      if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(u.id);
      // Compte désactivé : code de réinitialisation annulé, demandes en attente rejetées
      mdp().annulerCode(u.id);
      if (existant.actif !== false) mdp().rejeterDemandes(u.id, 'Compte désactivé', req.user.id);
    }
    ctx.audit(req, 'modification', 'users', u.id, `Utilisateur ${u.login}`);
    return clean(u);
  }, { perm: ['utilisateurs', 'modifier'] });

  router.delete('/api/utilisateurs/:id', async (req) => {
    const existant = getVisible(req, req.params.id, true);
    if (existant.id === req.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte');
    if (!perms.canManageUser(req.perms, db.get('profils', existant.profilId))) throw new HttpError(403, 'Niveau hiérarchique insuffisant');
    verifierDernierAdmin(existant, { actif: false });
    // On conserve la traçabilité : désactivation plutôt que suppression si l'utilisateur est référencé
    const reference = ['ot', 'demandes'].some((c) => db.count(c, (r) => r.createdBy === existant.id || r.demandeurId === existant.id || r.technicienId === existant.id || (r.techniciens || []).includes(existant.id)) > 0);
    if (reference) {
      db.update('users', existant.id, { actif: false, supprime: true, reinitialisation: null });
      ctx.sessions.destroyUser(existant.id);
      if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(existant.id);
      mdp().rejeterDemandes(existant.id, 'Compte désactivé', req.user.id);
      ctx.audit(req, 'desactivation', 'users', existant.id, `Utilisateur ${existant.login} (référencé, désactivé)`);
      return { ok: true, desactive: true };
    }
    db.remove('users', existant.id);
    for (const u of db.list('users', (x) => x.managerId === existant.id)) db.update('users', u.id, { managerId: null });
    ctx.sessions.destroyUser(existant.id);
    if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(existant.id);
    mdp().rejeterDemandes(existant.id, 'Compte supprimé', req.user.id);
    ctx.audit(req, 'suppression', 'users', existant.id, `Utilisateur ${existant.login}`);
    return { ok: true };
  }, { perm: ['utilisateurs', 'supprimer'] });

  /**
   * Réinitialisation du mot de passe par un gestionnaire :
   *  - mode « code » (recommandé) : code à usage unique et durée limitée, renvoyé une seule fois ; l'utilisateur
   *    choisit lui-même son nouveau mot de passe depuis l'écran de connexion (mot de passe actuel et sessions inchangés) ;
   *  - mode « temporaire » : mot de passe saisi ou généré, à changer à la première connexion, sessions fermées.
   * Les demandes en attente du compte sont traitées et l'utilisateur est prévenu.
   */
  router.post('/api/utilisateurs/:id/reinitialiser-mdp', async (req) => {
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const existant = getVisible(req, req.params.id, true);
    if (existant.id === req.user.id) throw new HttpError(400, 'Pour votre propre compte, utilisez « Changer mon mot de passe » dans le menu de votre compte');
    exigerPriseEnMain(req, existant, 'réinitialiser son mot de passe');
    if (existant.actif === false) throw new HttpError(400, 'Ce compte est désactivé : réactivez-le avant de réinitialiser son mot de passe');
    const mode = b.mode == null || b.mode === '' ? 'temporaire' : b.mode;
    if (!['code', 'temporaire'].includes(mode)) throw new HttpError(400, 'Mode de réinitialisation invalide (code ou temporaire)');
    if (b.demandeId != null && b.demandeId !== '') {
      const d = db.get('demandesMdp', b.demandeId);
      if (!d || d.userId !== existant.id) throw new HttpError(400, 'Demande de réinitialisation introuvable pour cet utilisateur');
    }
    const auteur = ctx.nomUser(req.user.id);
    if (mode === 'code') {
      const { code, expireLe } = mdp().poserCode(existant, { creePar: req.user.id, origine: 'pole_informatique' });
      mdp().traiterDemandes(existant.id, { mode: 'code', par: req.user.id });
      ctx.audit(req, 'code_reinitialisation_mdp', 'users', existant.id, `Code de réinitialisation créé pour ${existant.login}, valable jusqu'au ${mdp().dateHeure(expireLe)}`);
      ctx.notify(existant.id, { titre: 'Code de réinitialisation de votre mot de passe', message: `${auteur} a créé un code de réinitialisation de votre mot de passe, valable jusqu'au ${mdp().dateHeure(expireLe)}. Utilisez-le depuis l'écran de connexion (« J'ai un code de réinitialisation »). Si vous n'avez rien demandé, prévenez le pôle informatique.`, lien: '', type: 'alerte' });
      return { ok: true, mode: 'code', code, expireLe, login: existant.login };
    }
    const pwd = b.password ? String(b.password) : auth.genererMotDePasse();
    const err = auth.validerMotDePasse(pwd, db.getConfig(), { login: existant.login });
    if (err) throw new HttpError(400, err);
    db.update('users', existant.id, mdp().champsNouveau(existant, pwd, { doitChanger: true, raison: 'reinitialise' }));
    ctx.sessions.destroyUser(existant.id);
    if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(existant.id);
    mdp().traiterDemandes(existant.id, { mode: 'temporaire', par: req.user.id });
    ctx.audit(req, 'reinitialisation_mdp', 'users', existant.id, `Utilisateur ${existant.login} (mot de passe temporaire)`);
    ctx.notify(existant.id, { titre: 'Mot de passe réinitialisé', message: `${auteur} a réinitialisé votre mot de passe le ${mdp().dateHeure(Date.now())} : un mot de passe temporaire vous a été remis, vous le changerez à votre prochaine connexion. Si vous n'avez rien demandé, prévenez le pôle informatique.`, lien: '', type: 'alerte' });
    return { ok: true, mode: 'temporaire', motDePasse: pwd };
  }, { perm: ['utilisateurs', 'modifier'] });

  /** Annulation du code de réinitialisation d'un compte (avant qu'il ne soit utilisé). */
  router.delete('/api/utilisateurs/:id/code-reinitialisation', async (req) => {
    const existant = getVisible(req, req.params.id, true);
    if (existant.id === req.user.id) throw new HttpError(400, 'Un code de réinitialisation de votre propre compte ne peut être annulé que par le pôle informatique (ou il s\'annule en changeant votre mot de passe)');
    exigerPriseEnMain(req, existant, 'annuler son code de réinitialisation');
    if (!mdp().annulerCode(existant.id)) throw new HttpError(400, 'Aucun code de réinitialisation actif pour ce compte');
    ctx.audit(req, 'annulation_code_reinitialisation', 'users', existant.id, `Code de réinitialisation de ${existant.login} annulé`);
    return { ok: true };
  }, { perm: ['utilisateurs', 'modifier'] });

  // ----- Demandes de réinitialisation faites depuis l'écran de connexion -----
  /** Demande avec le compte concerné, si l'appelant peut le voir et le gérer (jamais sa propre demande). */
  function demandeTraitable(req, d) {
    const u = d ? db.get('users', d.userId) : null;
    if (!u || u.id === req.user.id || !visible(req, u, true) || !gerable(req, u)) return null;
    return u;
  }
  const presenterDemande = (d, u) => {
    const profil = u ? db.get('profils', u.profilId) : null;
    const out = {
      id: d.id, userId: d.userId, login: u ? u.login : d.login, nom: u ? ctx.nomUser(u.id) : d.login, profilNom: profil ? profil.nom : '',
      message: d.message || '', ip: d.ip || '', poste: d.poste || '', repetitions: Number(d.repetitions) || 1, createdAt: d.createdAt, derniereDemande: d.derniereDemande || d.createdAt,
      statut: d.statut,
      // Demandes suivantes (adresse, poste, message, date) ; plusieurs postes différents : vérifier l'identité du demandeur
      provenances: (Array.isArray(d.provenances) ? d.provenances : []).map((p) => ({ ip: p.ip || '', poste: p.poste || '', message: p.message || '', date: p.date || null })),
      nbPostes: Number(d.nbPostes) || 1,
    };
    if (d.statut !== 'en_attente') Object.assign(out, { mode: d.mode || null, traiteePar: d.traiteePar == null ? null : d.traiteePar, traiteeParNom: d.traiteePar == null ? '' : ctx.nomUser(d.traiteePar), traiteeLe: d.traiteeLe || null, motifRejet: d.motifRejet || '' });
    return out;
  };

  /** Demandes en attente des comptes que l'appelant peut voir et gérer ; ?toutes=1 ajoute les 50 dernières traitées ou rejetées. */
  router.get('/api/utilisateurs-demandes-mdp', async (req) => {
    mdp().purger();
    const rows = [];
    for (const d of db.list('demandesMdp', (x) => x.statut === 'en_attente')) {
      const u = demandeTraitable(req, d);
      if (u && u.actif !== false) rows.push(presenterDemande(d, u));
    }
    rows.sort((a, b) => (a.derniereDemande < b.derniereDemande ? 1 : -1));
    if (req.query.toutes === '1' || req.query.toutes === 'true') {
      const histo = [];
      for (const d of db.list('demandesMdp', (x) => x.statut !== 'en_attente').sort((a, b) => ((a.traiteeLe || a.updatedAt) < (b.traiteeLe || b.updatedAt) ? 1 : -1))) {
        const u = demandeTraitable(req, d);
        if (u) histo.push(presenterDemande(d, u));
        if (histo.length >= 50) break;
      }
      rows.push(...histo);
    }
    return rows;
  }, { perm: ['utilisateurs', 'modifier'] });

  /** Rejet d'une demande (motif facultatif communiqué à l'utilisateur). */
  router.post('/api/utilisateurs-demandes-mdp/:id/rejeter', async (req) => {
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const d = db.get('demandesMdp', req.params.id);
    const u = demandeTraitable(req, d);
    if (!u) throw new HttpError(404, 'Demande introuvable');
    if (d.statut !== 'en_attente') throw new HttpError(400, 'Cette demande a déjà été traitée');
    const motif = typeof b.motif === 'string' ? b.motif.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, 300) : '';
    const maj = db.update('demandesMdp', d.id, { statut: 'rejetee', mode: 'rejet', motifRejet: motif, traiteePar: req.user.id, traiteeLe: new Date().toISOString() });
    ctx.audit(req, 'rejet_demande_reinitialisation_mdp', 'users', u.id, `Demande de réinitialisation de ${u.login} refusée${motif ? ' : ' + motif : ''}`);
    ctx.notify(u.id, { titre: 'Demande de réinitialisation refusée', message: `Votre demande de réinitialisation du mot de passe du ${mdp().dateHeure(d.createdAt)} a été refusée par ${ctx.nomUser(req.user.id)}.${motif ? ' Motif : ' + motif : ''} Pour toute question, contactez le pôle informatique.`, lien: '', type: 'info' });
    return presenterDemande(maj, u);
  }, { perm: ['utilisateurs', 'modifier'] });

  /**
   * Réinitialisation de la double authentification d'un utilisateur (téléphone perdu ou remplacé) par le
   * pôle informatique : clé et codes de secours supprimés, sessions fermées ; l'utilisateur la configurera
   * de nouveau (immédiatement à sa prochaine connexion si elle lui est imposée).
   */
  router.post('/api/utilisateurs/:id/2fa/reinitialiser', async (req) => {
    const existant = getVisible(req, req.params.id, true);
    if (existant.id === req.user.id) throw new HttpError(400, 'Pour votre propre compte, utilisez « Double authentification » dans le menu de votre compte');
    exigerPriseEnMain(req, existant, 'réinitialiser sa double authentification');
    const avant = existant.deuxFacteurs || {};
    if (!avant.actif && !avant.secretEnAttente) throw new HttpError(400, 'La double authentification n\'est pas configurée pour cet utilisateur');
    db.update('users', existant.id, { deuxFacteurs: { actif: false, reinitialiseLe: new Date().toISOString(), reinitialisePar: req.user.id }, codesSecours: [] });
    ctx.sessions.destroyUser(existant.id);
    if (ctx.deuxFacteurs) ctx.deuxFacteurs.annulerAttentes(existant.id);
    const exige = !!(ctx.deuxFacteurs && ctx.deuxFacteurs.exige(db.get('users', existant.id)));
    ctx.audit(req, 'reinitialisation_double_auth', 'users', existant.id, `Utilisateur ${existant.login}${avant.actif ? '' : ' (activation en cours annulée)'}`);
    ctx.notify(existant.id, {
      titre: 'Double authentification réinitialisée',
      message: `${ctx.nomUser(req.user.id)} a réinitialisé votre double authentification. ${exige ? 'Elle est obligatoire pour votre compte : vous la configurerez de nouveau à votre prochaine connexion.' : 'Vous pouvez la configurer de nouveau depuis le menu de votre compte › Double authentification.'}`,
      lien: '', type: 'alerte',
    });
    return { ok: true, exige };
  }, { perm: ['utilisateurs', 'modifier'] });

  /** Organigramme hiérarchique (arbre supérieur → subordonnés). */
  router.get('/api/utilisateurs-organigramme', async (req) => {
    const users = db.list('users', (u) => u.actif !== false && visible(req, u, false)).map(clean);
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
