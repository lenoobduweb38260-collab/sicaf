'use strict';
/**
 * Module Configuration : paramètres généraux, modules (activation / libellés),
 * listes de valeurs, champs personnalisés, numérotation, sauvegardes,
 * export / import complet, données de démonstration.
 */
const { completer, configParDefaut } = require('../seed');
const { seedDemo: seedDemoTous } = require('./index');

const nom = 'Configuration';

const TYPES_CHAMPS = ['texte', 'texte_long', 'nombre', 'date', 'liste', 'booleen'];

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  function validerListe(items) {
    if (!Array.isArray(items)) throw new HttpError(400, 'Liste invalide');
    const codes = new Set();
    return items.map((it, i) => {
      const code = String(it.code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      if (!code) throw new HttpError(400, `Code manquant à la ligne ${i + 1}`);
      if (codes.has(code)) throw new HttpError(400, `Code en double : ${code}`);
      codes.add(code);
      const out = { code, label: String(it.label || code).trim(), ordre: Number(it.ordre) || i + 1 };
      if (it.couleur !== undefined) out.couleur = /^#[0-9a-fA-F]{6}$/.test(it.couleur || '') ? it.couleur : '#6b7280';
      if (it.final !== undefined) out.final = !!it.final;
      if (it.delaiHeures !== undefined) out.delaiHeures = Number(it.delaiHeures) || 0;
      if (it.description !== undefined) out.description = String(it.description || '');
      // Propriétés complémentaires propres à une liste (ex. dureeMois des habilitations) : valeurs simples uniquement
      for (const [k, v] of Object.entries(it || {})) {
        if (out[k] !== undefined || ['code', 'label', 'ordre'].includes(k) || !/^[a-zA-Z]\w{0,30}$/.test(k)) continue;
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
        else if (typeof v === 'string' && v.length <= 200) out[k] = v;
      }
      return out;
    });
  }

  function validerChamps(defs) {
    if (!Array.isArray(defs)) throw new HttpError(400, 'Définition de champs invalide');
    const cles = new Set();
    return defs.map((d, i) => {
      const label = String(d.label || '').trim();
      if (!label) throw new HttpError(400, `Libellé manquant pour le champ ${i + 1}`);
      let cle = String(d.cle || label).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
      if (!cle) cle = 'champ_' + (i + 1);
      if (cles.has(cle)) throw new HttpError(400, `Clé de champ en double : ${cle}`);
      cles.add(cle);
      const type = TYPES_CHAMPS.includes(d.type) ? d.type : 'texte';
      return {
        cle, label, type,
        obligatoire: !!d.obligatoire,
        options: type === 'liste' ? (Array.isArray(d.options) ? d.options.map(String).filter(Boolean) : String(d.options || '').split(/[\n;,]/).map((s) => s.trim()).filter(Boolean)) : [],
        aide: String(d.aide || ''),
        ordre: Number(d.ordre) || i + 1,
        afficherListe: !!d.afficherListe,
      };
    });
  }

  function validerConfig(body) {
    const cfg = completer(db.getConfig(), configParDefaut());
    const b = body || {};
    if (b.societe) {
      cfg.societe = Object.assign({}, cfg.societe, {
        nom: String(b.societe.nom == null ? cfg.societe.nom : b.societe.nom).trim() || 'GMAO',
        slogan: String(b.societe.slogan == null ? cfg.societe.slogan : b.societe.slogan),
        adresse: String(b.societe.adresse == null ? cfg.societe.adresse : b.societe.adresse),
        telephone: String(b.societe.telephone == null ? cfg.societe.telephone : b.societe.telephone),
        email: String(b.societe.email == null ? cfg.societe.email : b.societe.email),
        logo: b.societe.logo === undefined ? cfg.societe.logo : (typeof b.societe.logo === 'string' && (b.societe.logo === '' || /^data:image\/(png|jpe?g|gif|svg\+xml|webp);base64,/.test(b.societe.logo)) ? b.societe.logo : cfg.societe.logo),
      });
    }
    if (b.general) {
      const g = b.general;
      cfg.general = Object.assign({}, cfg.general, {
        formatDate: ['dd/MM/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'].includes(g.formatDate) ? g.formatDate : cfg.general.formatDate,
        devise: g.devise == null ? cfg.general.devise : String(g.devise).slice(0, 5),
        theme: ['clair', 'sombre', 'auto'].includes(g.theme) ? g.theme : cfg.general.theme,
        lignesParPage: Math.min(500, Math.max(5, Number(g.lignesParPage) || cfg.general.lignesParPage)),
        couleurPrincipale: /^#[0-9a-fA-F]{6}$/.test(g.couleurPrincipale || '') ? g.couleurPrincipale : cfg.general.couleurPrincipale,
        messageAccueil: g.messageAccueil == null ? cfg.general.messageAccueil : String(g.messageAccueil),
        heuresParJour: Math.max(1, Number(g.heuresParJour) || cfg.general.heuresParJour),
        tauxHoraire: g.tauxHoraire == null || g.tauxHoraire === '' ? cfg.general.tauxHoraire : Math.max(0, Number(g.tauxHoraire) || 0),
      });
    }
    if (b.securite) {
      const bs = b.securite;
      const bool = (k) => (bs[k] === undefined ? cfg.securite[k] : !!bs[k]);
      cfg.securite = Object.assign({}, cfg.securite, {
        longueurMinMdp: Math.min(64, Math.max(8, Number(bs.longueurMinMdp) || cfg.securite.longueurMinMdp)),
        complexite: bool('complexite'),
        refuserCourants: bool('refuserCourants'),
        interdireIdentifiant: bool('interdireIdentifiant'),
        forcerChangementMdpInitial: bool('forcerChangementMdpInitial'),
        notifierBlocages: bool('notifierBlocages'),
        inactiviteMinutes: Math.min(24 * 60, Math.max(5, Number(bs.inactiviteMinutes) || cfg.securite.inactiviteMinutes || 60)),
        dureeSessionHeures: Math.min(72, Math.max(1, Number(bs.dureeSessionHeures) || cfg.securite.dureeSessionHeures || 12)),
      });
    }
    if (b.numerotation) {
      for (const k of Object.keys(cfg.numerotation)) {
        if (typeof b.numerotation[k] === 'string' && b.numerotation[k].includes('{num')) cfg.numerotation[k] = b.numerotation[k].trim();
      }
    }
    if (b.modules) {
      for (const m of perms.MODULES) {
        const src = b.modules[m.key];
        if (!src) continue;
        cfg.modules[m.key] = {
          actif: src.actif === undefined ? cfg.modules[m.key].actif !== false : !!src.actif,
          label: String(src.label || '').trim().slice(0, 40),
          ordre: Number.isFinite(Number(src.ordre)) ? Number(src.ordre) : cfg.modules[m.key].ordre,
        };
      }
      // Les modules d'administration ne peuvent pas être désactivés (sinon plus de configuration possible)
      for (const k of ['configuration', 'profils', 'utilisateurs', 'systeme']) if (cfg.modules[k]) cfg.modules[k].actif = true;
    }
    if (b.profils) {
      cfg.profils = Object.assign({}, cfg.profils, {
        triParSecteur: b.profils.triParSecteur === undefined ? cfg.profils.triParSecteur : !!b.profils.triParSecteur,
        grouperParSecteur: b.profils.grouperParSecteur === undefined ? cfg.profils.grouperParSecteur : !!b.profils.grouperParSecteur,
        afficherNiveau: b.profils.afficherNiveau === undefined ? cfg.profils.afficherNiveau : !!b.profils.afficherNiveau,
      });
    }
    if (b.utilisateurs) {
      cfg.utilisateurs = Object.assign({}, cfg.utilisateurs, {
        triParSecteur: b.utilisateurs.triParSecteur === undefined ? cfg.utilisateurs.triParSecteur : !!b.utilisateurs.triParSecteur,
        grouperParSecteur: b.utilisateurs.grouperParSecteur === undefined ? cfg.utilisateurs.grouperParSecteur : !!b.utilisateurs.grouperParSecteur,
        afficherSuperieur: b.utilisateurs.afficherSuperieur === undefined ? cfg.utilisateurs.afficherSuperieur : !!b.utilisateurs.afficherSuperieur,
      });
    }
    if (b.workflow) {
      for (const k of Object.keys(cfg.workflow)) if (typeof b.workflow[k] === 'boolean') cfg.workflow[k] = b.workflow[k];
    }
    if (b.preventif) {
      cfg.preventif = Object.assign({}, cfg.preventif, {
        horizonJours: Math.max(1, Number(b.preventif.horizonJours) || cfg.preventif.horizonJours),
        genererAuto: b.preventif.genererAuto === undefined ? cfg.preventif.genererAuto : !!b.preventif.genererAuto,
      });
    }
    // Sections simples des modules (étiquettes, inventaire, achats, RH, plans, sauvegardes) :
    // seules les clés connues sont acceptées, avec le même type que la valeur par défaut.
    const defaut = configParDefaut();
    for (const section of ['etiquettes', 'inventaire', 'achats', 'rh', 'plans', 'visites', 'sauvegardes']) { // « reseau » : module systeme uniquement
      if (b[section] && typeof b[section] === 'object') cfg[section] = fusionTypee(cfg[section], b[section], defaut[section], section === 'sauvegardes' ? SECRETS_SAUVEGARDE : []);
    }
    if (b.journal && typeof b.journal === 'object') {
      const j = b.journal;
      const actuel = cfg.journal || {};
      const ids = new Set(db.list('profils').map((p) => p.id));
      cfg.journal = {
        notifications: j.notifications === undefined ? actuel.notifications !== false : !!j.notifications,
        profilsNotifies: Array.isArray(j.profilsNotifies) ? Array.from(new Set(j.profilsNotifies.map(Number).filter((x) => ids.has(x)))) : (actuel.profilsNotifies || []),
        actions: Array.isArray(j.actions) ? Array.from(new Set(j.actions.map(String).filter((x) => /^[a-z_]{2,40}$/.test(x)))) : (actuel.actions || []),
        entites: Array.isArray(j.entites) ? Array.from(new Set(j.entites.map(String).filter((x) => /^[a-zA-Z]{2,40}$/.test(x)))) : (actuel.entites || []),
      };
    }
    if (b.listes) {
      for (const k of Object.keys(b.listes)) {
        if (!/^[a-zA-Z][\w]{0,40}$/.test(k)) continue;
        cfg.listes[k] = validerListe(b.listes[k]);
      }
    }
    if (b.champsPersonnalises) {
      for (const k of Object.keys(b.champsPersonnalises)) {
        if (!/^[a-zA-Z][\w]{0,40}$/.test(k)) continue;
        cfg.champsPersonnalises[k] = validerChamps(b.champsPersonnalises[k]);
      }
    }
    return cfg;
  }

  router.get('/api/configuration', async () => masquerSecrets(completer(db.getConfig(), configParDefaut())), { perm: ['configuration', 'voir'] });

  router.put('/api/configuration', async (req) => {
    const cfg = validerConfig(req.body);
    db.setConfig(cfg);
    ctx.audit(req, 'modification', 'configuration', null, Object.keys(req.body || {}).join(', '));
    ctx.emit('configuration:modifiee', cfg);
    return masquerSecrets(cfg);
  }, { perm: ['configuration', 'modifier'] });

  /** Réinitialise une section à ses valeurs par défaut (ex. listes). */
  router.post('/api/configuration/reinitialiser/:section', async (req) => {
    const def = configParDefaut();
    const section = req.params.section;
    if (!def[section]) throw new HttpError(400, 'Section inconnue');
    const cfg = db.getConfig();
    cfg[section] = def[section];
    db.setConfig(cfg);
    ctx.audit(req, 'reinitialisation', 'configuration', null, section);
    return masquerSecrets(cfg);
  }, { perm: ['configuration', 'modifier'] });

  // ----- Sauvegardes ------------------------------------------------------
  router.get('/api/sauvegardes', async () => ({ dossier: db.backupDir, sauvegardes: db.listBackups() }), { perm: ['systeme', 'voir'] });
  router.post('/api/sauvegardes', async (req) => {
    const f = db.backupNow('manuel');
    ctx.audit(req, 'sauvegarde', 'configuration', null, f || 'mémoire');
    return { ok: true, fichier: f, sauvegardes: db.listBackups() };
  }, { perm: ['systeme', 'modifier'] });
  router.post('/api/sauvegardes/restaurer', async (req) => {
    const nomFichier = req.body && req.body.nom;
    if (!nomFichier) throw new HttpError(400, 'Nom de sauvegarde manquant');
    db.restoreBackup(nomFichier);
    ctx.audit(req, 'restauration', 'configuration', null, nomFichier);
    return { ok: true };
  }, { perm: ['systeme', 'modifier'] });

  router.get('/api/export', async (req, res) => {
    const data = db.exportAll();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="gmao-export-${new Date().toISOString().slice(0, 10)}.json"` });
    res.end(JSON.stringify(data, null, 1));
  }, { perm: ['systeme', 'modifier'] });

  router.post('/api/import', async (req) => {
    const data = req.body;
    if (!data || typeof data !== 'object' || !data.collections) throw new HttpError(400, 'Fichier invalide : export GMAO attendu');
    db.importAll(data);
    require('../seed').seed(db);
    ctx.audit(req, 'import', 'configuration', null, Object.keys(data.collections).join(', '));
    ctx.sessions.map.clear();
    return { ok: true };
  }, { perm: ['systeme', 'modifier'] });

  /** Données de démonstration (tous les modules). */
  router.post('/api/demo', async (req) => {
    const rapport = seedDemoTous(ctx);
    ctx.audit(req, 'demo', 'configuration', null, rapport.map((r) => `${r.module}: ${r.ok ? (r.details || 'ok') : 'ERREUR ' + r.erreur}`).join(' | '));
    return rapport;
  }, { perm: ['systeme', 'modifier'] });

  /** Informations système. */
  router.get('/api/systeme', async () => ({
    version: ctx.version,
    node: process.version,
    plateforme: process.platform,
    dossierDonnees: db.dataDir,
    fichierDonnees: db.file,
    taille: (() => { try { return require('fs').statSync(db.file).size; } catch (e) { return 0; } })(),
    collections: db.collections().map((c) => ({ nom: c, nombre: db.count(c) })),
    modulesServeur: (ctx.modules || []).map((m) => m.nom),
    demarrage: DEMARRAGE,
  }), { perm: ['systeme', 'voir'] });
}

const DEMARRAGE = new Date().toISOString();

/** Clés secrètes de la section sauvegardes : jamais renvoyées au client, jamais modifiées par PUT /api/configuration. */
const SECRETS_SAUVEGARDE = ['cleReception', 'destinations', 'motDePasseChiffrement'];

/**
 * Fusionne `src` dans `cible` en n'acceptant que les clés présentes dans `defaut`, avec le même type
 * (booléen, nombre fini, chaîne ≤ 500 caractères, objet → récursif). Les tableaux et les clés `interdites` sont ignorés.
 */
function fusionTypee(cible, src, defaut, interdites) {
  const out = Object.assign({}, defaut || {}, cible || {});
  for (const [k, v] of Object.entries(src || {})) {
    if ((interdites || []).includes(k) || !defaut || !(k in defaut)) continue;
    const d = defaut[k];
    if (Array.isArray(d)) continue;
    if (typeof d === 'boolean') out[k] = !!v;
    else if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (typeof d === 'string') { if (v != null) out[k] = String(v).slice(0, 500); }
    else if (d && typeof d === 'object' && v && typeof v === 'object') out[k] = fusionTypee(out[k], v, d, []);
  }
  return out;
}

/** Copie de la configuration sans les secrets (clé de réception, destinations de sauvegarde). */
function masquerSecrets(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  if (c.sauvegardes) {
    c.sauvegardes.cleReceptionDefinie = !!c.sauvegardes.cleReception;
    delete c.sauvegardes.cleReception;
    delete c.sauvegardes.motDePasseChiffrement;
    c.sauvegardes.nbDestinations = Array.isArray(c.sauvegardes.destinations) ? c.sauvegardes.destinations.length : 0;
    delete c.sauvegardes.destinations;
  }
  return c;
}

module.exports = { nom, register, TYPES_CHAMPS, fusionTypee, masquerSecrets };
