'use strict';
/**
 * Module Configuration : paramètres généraux, modules (activation / libellés),
 * listes de valeurs, champs personnalisés, numérotation, sauvegardes,
 * export / import complet, données de démonstration.
 */
const { completer, configParDefaut, seed } = require('../seed');
const { seedDemo: seedDemoTous } = require('./index');

const nom = 'Configuration';

const TYPES_CHAMPS = ['texte', 'texte_long', 'nombre', 'date', 'liste', 'booleen'];
/** Modes de la double authentification (securite.deuxFacteurs). */
const MODES_DEUX_FACTEURS = ['facultatif', 'obligatoire_sensibles', 'obligatoire_tous'];
/** Quota global des pièces jointes (config.general.quotaPiecesJointesMo) : bornes. */
const QUOTA_PIECES_MIN_MO = 50;
const QUOTA_PIECES_MAX_MO = 4000;

/**
 * Champs des enregistrements qui portent les codes de chaque liste (« a[].b » : tableau d'objets imbriqués).
 * Un code encore utilisé ne peut être ni supprimé, ni renommé, et son caractère final ne peut pas changer :
 * sinon des éléments clôturés redeviendraient ouverts, ou porteraient un code inconnu.
 */
const USAGES_LISTES = {
  statutsOT: [['ot', 'statut']],
  statutsDemande: [['demandes', 'statut']],
  typesIntervention: [['ot', 'typeCode'], ['demandes', 'typeCode'], ['plansPreventifs', 'typeCode']],
  priorites: [['ot', 'prioriteCode'], ['demandes', 'prioriteCode'], ['plansPreventifs', 'prioriteCode']],
  typesEquipement: [['equipements', 'typeCode']],
  etatsEquipement: [['equipements', 'etatCode']],
  criticites: [['equipements', 'criticiteCode']],
  unites: [['articles', 'uniteCode']],
  categoriesArticles: [['articles', 'categorieCode']],
  typesFournisseur: [['fournisseurs', 'typeCode']],
  causesPanne: [['ot', 'causeCode']],
  typesSecteur: [['secteurs', 'type']],
  typesHabilitation: [['habilitations', 'typeCode'], ['formations', 'habilitationTypeCode']],
  typesAbsence: [['absences', 'typeCode']],
  typesContrat: [['personnel', 'typeContratCode']],
  statutsCommande: [['commandes', 'statut']],
  statutsFacture: [['factures', 'statut']],
  categoriesDepense: [['commandes', 'categorieCode'], ['factures', 'categorieCode']],
  typesVisite: [['visites', 'typeCode']],
  statutsVisite: [['visites', 'statut']],
  typesConstat: [['visites', 'constats[].typeCode']],
  statutsAction: [['visites', 'constats[].actions[].statut']],
  statutsInventaire: [['inventaires', 'statut']],
  statutsAbsence: [['absences', 'statut']],
  statutsFormation: [['formations', 'statut']],
  typesVisiteMedicale: [['visitesMedicales', 'type']],
  aptitudesMedicales: [['visitesMedicales', 'aptitude']],
  modesPaiement: [['factures', 'modePaiement']],
};
const LIBELLES_COLLECTIONS = {
  ot: 'ordre(s) de travail', demandes: 'demande(s) d\'intervention', plansPreventifs: 'plan(s) préventif(s)', equipements: 'équipement(s)',
  articles: 'article(s)', fournisseurs: 'fournisseur(s)', secteurs: 'secteur(s)', habilitations: 'habilitation(s)', formations: 'formation(s)',
  absences: 'absence(s)', personnel: 'fiche(s) du personnel', commandes: 'commande(s)', factures: 'facture(s)', visites: 'visite(s)',
  inventaires: 'inventaire(s)', visitesMedicales: 'visite(s) médicale(s)',
};

/** Listes de statuts dont les codes sont fixés par le circuit d'un module (seuls libellés et couleurs se modifient). */
const LISTES_CODES_FIXES = new Set(['statutsAbsence', 'statutsFormation']);

/** Valeurs permises des réglages énumérés des sections de modules. */
const VALEURS_PERMISES = {
  'inventaire.modeScan': ['quantite', 'unitaire'],
  'etiquettes.format': ['a4-3x7', 'a4-3x8', 'a4-2x7', 'a4-4x10', 'a4-5x13', 'rouleau-50x25', 'rouleau-57x32', 'rouleau-100x50', 'personnalise'],
  'etiquettes.symbologie': ['code128'],
  'plans.uniteAffichage': ['m', 'cm', 'mm'],
  'plans.couleurParDefaut': ['etat', 'ot', 'criticite', 'secteur', 'origine'],
};
/** Bornes des réglages numériques des sections de modules (refus 400 au-delà). */
const BORNES = {
  'visites.rappelJoursAvant': [0, 60], 'visites.conserverVisiteursJours': [1, 3650],
  'plans.grilleM': [0.01, 100],
  'achats.tauxTVA': [0, 100], 'achats.seuilValidationHT': [0, 1e9], 'achats.delaiPaiementJours': [0, 365], 'achats.alerteEcheanceJours': [0, 365],
  'rh.alerteJoursAvantEcheance': [0, 730], 'rh.heuresHebdo': [1, 80],
  'etiquettes.hauteurCodeMm': [1, 200], 'etiquettes.decalage': [0, 1000],
};
/** Collections présentes dans tout export complet de la base (contrôle d'un fichier d'import). */
const COLLECTIONS_REQUISES = ['users', 'profils', 'secteurs', 'equipements', 'demandes', 'ot', 'plansPreventifs', 'articles', 'mouvementsStock', 'fournisseurs', 'audit', 'notifications'];

function register(ctx) {
  const { router, db, HttpError, perms } = ctx;

  /** Accès à tous les sites (administrateur ou portée « tous ») : exigé pour ce qui concerne toute la base. */
  const estGlobal = (req) => !!(req && req.perms && (req.perms.estAdmin || req.perms.portee === 'tous'));
  function exigerGlobal(req, quoi) {
    if (!estGlobal(req)) throw new HttpError(403, `${quoi} concerne tous les sites : réservé aux utilisateurs ayant accès à tous les sites`);
  }

  /** Nombre d'éléments portant chaque code d'une liste : Map(code → Map(collection → nombre)). */
  function usagesCodes(nomListe) {
    const comptes = new Map();
    for (const [col, chemin] of USAGES_LISTES[nomListe] || []) {
      const etapes = chemin.split('.');
      const visiter = (o, i) => {
        if (!o || typeof o !== 'object') return;
        const e = etapes[i];
        if (e.endsWith('[]')) { const t = o[e.slice(0, -2)]; if (Array.isArray(t)) for (const x of t) visiter(x, i + 1); return; }
        if (i < etapes.length - 1) { visiter(o[e], i + 1); return; }
        const v = o[e];
        if (v == null || v === '') return;
        const m = comptes.get(v) || new Map();
        m.set(col, (m.get(col) || 0) + 1);
        comptes.set(v, m);
      };
      for (const r of db.data.collections[col] || []) visiter(r, 0);
    }
    return comptes;
  }
  const decrireUsages = (m) => Array.from(m.entries()).map(([col, n]) => `${n} ${LIBELLES_COLLECTIONS[col] || col}`).join(', ');

  /**
   * Nettoie une liste reçue : un code existant est conservé tel quel (casse comprise) ; un nouveau code est
   * normalisé (minuscules, lettres, chiffres, - et _).
   */
  function validerListe(items, ancienne) {
    if (!Array.isArray(items)) throw new HttpError(400, 'Liste invalide');
    const existants = new Set((Array.isArray(ancienne) ? ancienne : []).map((x) => x && x.code).filter((c) => typeof c === 'string' && c));
    const codes = new Set();
    return items.map((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) throw new HttpError(400, `Valeur invalide à la ligne ${i + 1}`);
      const brut = String(it.code == null ? '' : it.code).trim();
      const code = existants.has(brut) ? brut : brut.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      if (!code) throw new HttpError(400, `Code manquant à la ligne ${i + 1}`);
      if (code.length > 40) throw new HttpError(400, `Code trop long à la ligne ${i + 1} (40 caractères au plus)`);
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

  /**
   * Cohérence d'une liste modifiée avec les données et les circuits de travail :
   *  - les statuts du circuit d'un module (liste par défaut avec « final ») restent présents, avec le même caractère final ;
   *  - un code encore porté par des éléments n'est ni supprimé, ni renommé, ni rendu final / non final ;
   *  - une liste de statuts garde au moins un statut final et un statut non final (et, pour les OT, un statut
   *    final qui ne soit pas une annulation : celui que prend un OT terminé).
   */
  function verifierListe(nomListe, nouvelle, ancienne) {
    const avant = new Map((Array.isArray(ancienne) ? ancienne : []).filter((x) => x && typeof x.code === 'string').map((x) => [x.code, x]));
    const apres = new Map(nouvelle.map((x) => [x.code, x]));
    const defaut = (configParDefaut().listes || {})[nomListe];
    const circuit = Array.isArray(defaut) && (defaut.some((x) => x.final !== undefined) || LISTES_CODES_FIXES.has(nomListe));
    const nomCode = (x) => `« ${x.label || x.code} » (${x.code})`;
    if (circuit) {
      for (const d of defaut) {
        const actuel = avant.get(d.code);
        if (!actuel) continue;
        const n = apres.get(d.code);
        if (!n) throw new HttpError(400, `Le statut ${nomCode(actuel)} fait partie du circuit de travail du module : il ne peut être ni supprimé ni renommé (vous pouvez changer son libellé et sa couleur).`);
        if (actuel.final !== undefined && !!n.final !== !!actuel.final) throw new HttpError(400, `Le statut ${nomCode(actuel)} fait partie du circuit de travail du module : son caractère final ne peut pas changer.`);
      }
    }
    const usages = USAGES_LISTES[nomListe] ? usagesCodes(nomListe) : new Map();
    for (const [code, x] of avant) {
      const u = usages.get(code);
      if (!u) continue;
      const n = apres.get(code);
      if (!n) throw new HttpError(400, `Le code ${nomCode(x)} est encore utilisé par ${decrireUsages(u)} : il ne peut être ni supprimé ni renommé. Remettez-le, ou modifiez d'abord ces éléments.`);
      if (x.final !== undefined && !!n.final !== !!x.final) throw new HttpError(400, `Le code ${nomCode(x)} est encore utilisé par ${decrireUsages(u)} : son caractère final ne peut pas changer.`);
    }
    if ((Array.isArray(defaut) && defaut.some((x) => x.final !== undefined)) || nouvelle.some((x) => x.final !== undefined)) {
      if (!nouvelle.some((x) => x.final)) throw new HttpError(400, 'La liste doit comporter au moins un statut final (élément clôturé).');
      if (!nouvelle.some((x) => !x.final)) throw new HttpError(400, 'La liste doit comporter au moins un statut non final (élément en cours).');
      if (nomListe === 'statutsOT' && !nouvelle.some((x) => x.final && x.code !== 'annule' && !/annul/i.test(x.label || ''))) {
        throw new HttpError(400, 'Les statuts des ordres de travail doivent comporter un statut final autre qu\'une annulation (statut d\'un OT terminé).');
      }
    }
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

  /** Entier saisi (nombre ou chaîne de chiffres) ; null si absent ou vide ; NaN si la valeur n'est pas un entier. */
  function lireEntier(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
    return NaN;
  }

  /**
   * Paramètres non secrets de la section sauvegardes : mêmes contrôles que le module (bornes, types, chiffrement
   * impossible sans mot de passe). Les secrets (destinations, clés, mot de passe) restent hors d'atteinte.
   */
  function validerSauvegardes(actuel, src) {
    const out = Object.assign({}, actuel || {});
    const bool = (k, label) => {
      if (src[k] === undefined) return;
      if (typeof src[k] !== 'boolean') throw new HttpError(400, `${label} : valeur oui / non attendue`);
      out[k] = src[k];
    };
    const entier = (k, min, max, label) => {
      if (src[k] === undefined) return;
      const n = lireEntier(src[k]);
      if (n === null || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} : nombre entier entre ${min} et ${max} attendu`);
      out[k] = n;
    };
    bool('automatique', 'Sauvegarde automatique');
    bool('compresser', 'Compression');
    bool('chiffrer', 'Chiffrement');
    bool('accepterReception', 'Réception des sauvegardes d\'autres sites');
    entier('frequenceHeures', 1, 720, 'Fréquence (heures)');
    entier('conserverLocal', 0, 365, 'Copies locales conservées');
    entier('conserverRecues', 1, 365, 'Sauvegardes reçues conservées par site');
    if (src.heure !== undefined) {
      if (typeof src.heure !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(src.heure)) throw new HttpError(400, 'Heure invalide (format HH:MM)');
      out.heure = src.heure;
    }
    if (src.nomServeur !== undefined) {
      if (src.nomServeur !== null && typeof src.nomServeur !== 'string') throw new HttpError(400, 'Nom du serveur invalide');
      const n = String(src.nomServeur || '').replace(/[\u0000-\u001f<>]/g, '').trim();
      if (n.length > 80) throw new HttpError(400, 'Nom du serveur trop long (80 caractères maximum)');
      out.nomServeur = n;
    }
    if (out.chiffrer && !out.motDePasseChiffrement) throw new HttpError(400, 'Définissez d\'abord un mot de passe de chiffrement (Système & informatique › Sauvegardes) pour activer le chiffrement');
    return out;
  }

  function validerConfig(body, req) {
    const cfg = completer(db.getConfig(), configParDefaut());
    const b = body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) ? body : {};
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
      const quota = lireEntier(g.quotaPiecesJointesMo);
      if (Number.isNaN(quota) || (quota !== null && (quota < QUOTA_PIECES_MIN_MO || quota > QUOTA_PIECES_MAX_MO))) {
        throw new HttpError(400, `Espace réservé aux pièces jointes : entre ${QUOTA_PIECES_MIN_MO} et ${QUOTA_PIECES_MAX_MO} Mo`);
      }
      cfg.general = Object.assign({}, cfg.general, {
        formatDate: ['dd/MM/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'].includes(g.formatDate) ? g.formatDate : cfg.general.formatDate,
        devise: g.devise == null ? cfg.general.devise : String(g.devise).slice(0, 5),
        theme: ['clair', 'sombre', 'auto'].includes(g.theme) ? g.theme : cfg.general.theme,
        lignesParPage: Math.min(500, Math.max(5, Number(g.lignesParPage) || cfg.general.lignesParPage)),
        couleurPrincipale: /^#[0-9a-fA-F]{6}$/.test(g.couleurPrincipale || '') ? g.couleurPrincipale : cfg.general.couleurPrincipale,
        messageAccueil: g.messageAccueil == null ? cfg.general.messageAccueil : String(g.messageAccueil),
        heuresParJour: Math.max(1, Number(g.heuresParJour) || cfg.general.heuresParJour),
        tauxHoraire: g.tauxHoraire == null || g.tauxHoraire === '' ? cfg.general.tauxHoraire : Math.max(0, Number(g.tauxHoraire) || 0),
        quotaPiecesJointesMo: quota === null ? cfg.general.quotaPiecesJointesMo : quota,
      });
    }
    if (b.securite) {
      const bs = b.securite;
      const LIBELLES_SECURITE = {
        complexite: 'Exiger 3 types de caractères', refuserCourants: 'Refuser les mots de passe courants', interdireIdentifiant: 'Refuser l\'identifiant dans le mot de passe',
        forcerChangementMdpInitial: 'Forcer le changement du mot de passe initial', notifierBlocages: 'Prévenir le pôle informatique des blocages',
        motDePasseOublie: 'Mot de passe oublié', reinitialisationAutonome: 'Réinitialisation autonome',
      };
      /** Réglage oui / non : un booléen uniquement (« false » en texte n'active jamais un réglage). */
      const bool = (k) => {
        if (bs[k] === undefined || bs[k] === null) return cfg.securite[k];
        if (typeof bs[k] !== 'boolean') throw new HttpError(400, `${LIBELLES_SECURITE[k] || k} : valeur oui / non attendue`);
        return bs[k];
      };
      if (bs.deuxFacteurs !== undefined && !MODES_DEUX_FACTEURS.includes(bs.deuxFacteurs)) throw new HttpError(400, 'Mode de double authentification invalide (facultatif, obligatoire_sensibles ou obligatoire_tous)');
      /** Entier dans les bornes (valeur actuelle si absent), sinon 400 avec un message explicite. */
      const entier = (k, min, max, message) => {
        const n = lireEntier(bs[k]);
        if (n === null) return cfg.securite[k];
        if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, message);
        return n;
      };
      /** Nombre ramené dans ses bornes (réglages historiques) ; une valeur qui n'est pas un nombre est refusée. */
      const borne = (k, min, max, defaut, message) => {
        const n = lireEntier(bs[k]);
        if (n === null) return cfg.securite[k] || defaut;
        if (!Number.isInteger(n)) throw new HttpError(400, message);
        return Math.min(max, Math.max(min, n || defaut));
      };
      const expiration = entier('expirationMdpJours', 0, 730, 'Expiration du mot de passe : 0 (jamais) ou entre 30 et 730 jours');
      if (expiration !== 0 && expiration < 30) throw new HttpError(400, 'Expiration du mot de passe : 0 (jamais) ou entre 30 et 730 jours');
      cfg.securite = Object.assign({}, cfg.securite, {
        longueurMinMdp: borne('longueurMinMdp', 8, 64, 10, 'Longueur minimale des mots de passe : nombre entier attendu'),
        complexite: bool('complexite'),
        refuserCourants: bool('refuserCourants'),
        interdireIdentifiant: bool('interdireIdentifiant'),
        forcerChangementMdpInitial: bool('forcerChangementMdpInitial'),
        notifierBlocages: bool('notifierBlocages'),
        inactiviteMinutes: borne('inactiviteMinutes', 5, 24 * 60, 60, 'Déconnexion après inactivité : nombre entier de minutes attendu'),
        dureeSessionHeures: borne('dureeSessionHeures', 1, 72, 12, 'Durée maximale d\'une session : nombre entier d\'heures attendu'),
        deuxFacteurs: bs.deuxFacteurs !== undefined ? bs.deuxFacteurs : (MODES_DEUX_FACTEURS.includes(cfg.securite.deuxFacteurs) ? cfg.securite.deuxFacteurs : 'facultatif'),
        // Mot de passe oublié, réinitialisation, expiration, historique
        motDePasseOublie: bool('motDePasseOublie'),
        dureeCodeReinitialisationMinutes: entier('dureeCodeReinitialisationMinutes', 5, 1440, 'Durée de validité d\'un code de réinitialisation : entre 5 et 1440 minutes'),
        reinitialisationAutonome: bool('reinitialisationAutonome'),
        expirationMdpJours: expiration,
        rappelExpirationJours: entier('rappelExpirationJours', 1, 60, 'Rappel avant l\'expiration du mot de passe : entre 1 et 60 jours'),
        historiqueMdp: entier('historiqueMdp', 0, 24, 'Historique des mots de passe : entre 0 et 24 mots de passe'),
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
    // Sections simples des modules (étiquettes, inventaire, achats, RH, plans, visites) : seules les clés connues
    // sont acceptées, avec le même type que la valeur par défaut, dans les valeurs permises et les bornes.
    const defaut = configParDefaut();
    for (const section of ['etiquettes', 'inventaire', 'achats', 'rh', 'plans', 'visites']) { // « reseau » : module systeme uniquement
      if (b[section] && typeof b[section] === 'object') cfg[section] = fusionTypee(cfg[section], b[section], defaut[section], [], { section, erreur: (m) => new HttpError(400, m) });
    }
    // Sauvegardes : paramètres non secrets seulement, avec les droits du module (Système › Modifier, tous les sites)
    if (b.sauvegardes !== undefined) {
      const src = b.sauvegardes;
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw new HttpError(400, 'Paramètres de sauvegarde invalides');
      const cles = Object.keys(src).filter((k) => !SECRETS_SAUVEGARDE.includes(k) && k !== 'cleReceptionDate' && k !== 'sequenceDestinations');
      if (cles.length) {
        if (!estGlobal(req) || !perms.can(req.perms, 'systeme', 'modifier')) {
          throw new HttpError(403, 'Les paramètres de sauvegarde se règlent dans Système & informatique : droit Système › Modifier et accès à tous les sites requis');
        }
        cfg.sauvegardes = validerSauvegardes(cfg.sauvegardes, src);
      }
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
      if (typeof b.listes !== 'object' || Array.isArray(b.listes)) throw new HttpError(400, 'Listes invalides');
      for (const k of Object.keys(b.listes)) {
        if (!/^[a-zA-Z][\w]{0,40}$/.test(k)) continue;
        const ancienne = cfg.listes[k];
        const nouvelle = validerListe(b.listes[k], ancienne);
        verifierListe(k, nouvelle, ancienne);
        cfg.listes[k] = nouvelle;
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

  /**
   * Codes d'une liste : nombre d'éléments qui portent chacun d'eux et codes du circuit de travail d'un module
   * (ni supprimables ni renommables). Sert à l'écran des listes de valeurs.
   */
  router.get('/api/configuration/listes/:nom/usages', async (req) => {
    const nomListe = req.params.nom;
    if (!/^[a-zA-Z][\w]{0,40}$/.test(nomListe)) throw new HttpError(400, 'Liste inconnue');
    const usages = {};
    for (const [code, m] of usagesCodes(nomListe)) usages[code] = { total: Array.from(m.values()).reduce((a, b) => a + b, 0), detail: decrireUsages(m) };
    const defaut = (configParDefaut().listes || {})[nomListe];
    const circuit = Array.isArray(defaut) && (defaut.some((x) => x.final !== undefined) || LISTES_CODES_FIXES.has(nomListe));
    return { usages, proteges: circuit ? defaut.map((x) => x.code) : [], finalFige: circuit && defaut.some((x) => x.final !== undefined) };
  }, { perm: ['configuration', 'voir'] });

  router.put('/api/configuration', async (req) => {
    const cfg = validerConfig(req.body, req);
    db.setConfig(cfg);
    ctx.audit(req, 'modification', 'configuration', null, Object.keys(req.body || {}).join(', '));
    ctx.emit('configuration:modifiee', cfg);
    return masquerSecrets(cfg);
  }, { perm: ['configuration', 'modifier'] });

  /**
   * Réinitialise une section à ses valeurs par défaut (ex. listes). Les sections propres au serveur (sauvegardes,
   * réseau) se gèrent dans Système & informatique. Pour les listes, les codes encore utilisés par des éléments
   * sont conservés à la suite des valeurs par défaut.
   */
  router.post('/api/configuration/reinitialiser/:section', async (req) => {
    const def = configParDefaut();
    const section = req.params.section;
    if (!Object.prototype.hasOwnProperty.call(def, section)) throw new HttpError(400, 'Section inconnue');
    if (['sauvegardes', 'reseau'].includes(section)) throw new HttpError(400, 'Cette section se règle dans Système & informatique et ne peut pas être réinitialisée ici');
    const cfg = db.getConfig();
    if (section === 'listes') {
      const listes = Object.assign({}, cfg.listes || {}, def.listes);
      for (const [k, actuelle] of Object.entries(cfg.listes || {})) {
        if (!Array.isArray(actuelle) || !Array.isArray(def.listes[k])) continue;
        const usages = USAGES_LISTES[k] ? usagesCodes(k) : new Map();
        const codes = new Set(def.listes[k].map((x) => x.code));
        const gardes = actuelle.filter((x) => x && usages.has(x.code) && !codes.has(x.code));
        if (gardes.length) listes[k] = def.listes[k].concat(gardes.map((x, i) => Object.assign({}, x, { ordre: def.listes[k].length + i + 1 })));
      }
      cfg.listes = listes;
    } else cfg[section] = def[section];
    db.setConfig(cfg);
    ctx.audit(req, 'retablissement', 'configuration', null, section);
    return masquerSecrets(cfg);
  }, { perm: ['configuration', 'modifier'] });

  // ----- Contrôle d'une base importée ou restaurée --------------------------
  /**
   * Refuse (400) un fichier qui n'est pas une base GMAO complète : collections attendues présentes, tableaux
   * d'objets à identifiant entier unique, au moins un administrateur actif (sinon l'application deviendrait inaccessible).
   */
  function validerBase(data) {
    const refus = (m) => new HttpError(400, 'Fichier refusé : ' + m);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.isBuffer(data)) throw refus('export GMAO attendu');
    const cols = data.collections;
    if (!cols || typeof cols !== 'object' || Array.isArray(cols)) throw refus('ce fichier n\'est pas un export complet de la GMAO (collections absentes)');
    for (const k of ['config', 'meta']) {
      if (data[k] !== undefined && (!data[k] || typeof data[k] !== 'object' || Array.isArray(data[k]))) throw refus(`partie « ${k} » invalide`);
    }
    for (const n of COLLECTIONS_REQUISES) {
      if (!Array.isArray(cols[n])) throw refus(`fichier incomplet ou d'un autre format : la collection « ${n} » est absente ou invalide`);
    }
    for (const [n, rows] of Object.entries(cols)) {
      if (!/^[a-zA-Z]\w{0,40}$/.test(n)) throw refus(`nom de collection invalide (« ${String(n).slice(0, 40)} »)`);
      if (!Array.isArray(rows)) throw refus(`la collection « ${n} » n'est pas une liste`);
      const ids = new Set();
      rows.forEach((r, i) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw refus(`élément ${i + 1} de « ${n} » invalide`);
        if (!Number.isInteger(r.id) || r.id < 1) throw refus(`élément ${i + 1} de « ${n} » sans identifiant valide`);
        if (ids.has(r.id)) throw refus(`identifiant ${r.id} en double dans « ${n} »`);
        ids.add(r.id);
      });
    }
    const admins = new Set(cols.profils.filter((p) => p.estAdmin).map((p) => p.id));
    if (!cols.users.some((u) => u.actif !== false && admins.has(u.profilId) && typeof u.passwordHash === 'string' && u.passwordHash)) {
      throw refus('aucun compte administrateur actif : l\'application deviendrait inaccessible');
    }
  }
  /** Volumes par collection (aperçu avant import). */
  const volumes = (data) => Object.fromEntries(Object.entries(data.collections).map(([n, rows]) => [n, rows.length]));

  /**
   * Après un import ou une restauration : paramètres de sauvegarde et historique de CE serveur conservés,
   * configuration complétée, sessions fermées (sauf celle de l'auteur si son compte est inchangé).
   */
  function apresRemplacement(req, sauvegardesActuelles, historique) {
    seed(db);
    const cfg = db.getConfig();
    if (sauvegardesActuelles) cfg.sauvegardes = sauvegardesActuelles;
    db.setConfig(cfg);
    db.replaceCollection('sauvegardesHistorique', historique || []);
    let garder = null;
    if (req && req.session && req.user) {
      const u = db.get('users', req.user.id);
      if (u && u.login === req.user.login && u.actif !== false) garder = req.session.token;
    }
    for (const token of Array.from(ctx.sessions.map.keys())) if (token !== garder) ctx.sessions.destroy(token);
    db.saveNow();
    return !!garder;
  }

  // ----- Sauvegardes ------------------------------------------------------
  router.get('/api/sauvegardes', async () => ({ dossier: db.backupDir, sauvegardes: db.listBackups() }), { perm: ['systeme', 'voir'] });
  router.post('/api/sauvegardes', async (req) => {
    const f = db.backupNow('manuel');
    ctx.audit(req, 'sauvegarde', 'configuration', null, f || 'mémoire');
    return { ok: true, fichier: f, sauvegardes: db.listBackups() };
  }, { perm: ['systeme', 'modifier'] });
  router.post('/api/sauvegardes/restaurer', async (req) => {
    exigerGlobal(req, 'La restauration de la base');
    const nomFichier = req.body && req.body.nom;
    if (typeof nomFichier !== 'string' || !nomFichier) throw new HttpError(400, 'Nom de sauvegarde manquant');
    if (!/^[\w.-]+\.json$/.test(nomFichier) || nomFichier.startsWith('.')) throw new HttpError(400, 'Nom de sauvegarde invalide');
    const sauvegardesActuelles = db.getConfig().sauvegardes;
    const historique = db.list('sauvegardesHistorique');
    try {
      db.restoreBackup(nomFichier, { valider: validerBase, conserver: (ancienne, nouvelle) => { delete nouvelle.exportGMAO; } });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e && e.code === 'INTROUVABLE') throw new HttpError(404, 'Sauvegarde introuvable');
      if (e && ['NOM_INVALIDE', 'ILLISIBLE', 'MEMOIRE'].includes(e.code)) throw new HttpError(400, e.message);
      throw e;
    }
    const sessionConservee = apresRemplacement(req, sauvegardesActuelles, historique);
    ctx.audit(req, 'restauration', 'configuration', null, nomFichier);
    return { ok: true, sessionConservee };
  }, { perm: ['systeme', 'modifier'] });

  /**
   * Export complet (pièces jointes comprises), écrit au fil de l'eau : sans les secrets des sauvegardes (mot de passe
   * de chiffrement, clés, destinations) ni les codes de réinitialisation en cours. Les empreintes des mots de passe
   * restent dans l'export, nécessaires à une restauration. Réservé aux utilisateurs ayant accès à tous les sites.
   */
  router.get('/api/export', async (req, res) => {
    exigerGlobal(req, 'L\'export complet de la base');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="gmao-export-${new Date().toISOString().slice(0, 10)}.json"` });
    const ecrire = (texte) => {
      if (res.destroyed) throw new Error('Connexion fermée pendant l\'export');
      if (res.write(texte)) return null;
      return new Promise((resolve, reject) => {
        const ok = () => { res.off('close', ferme); resolve(); };
        const ferme = () => { res.off('drain', ok); reject(new Error('Connexion fermée pendant l\'export')); };
        res.once('drain', ok);
        res.once('close', ferme);
      });
    };
    try {
      await db.exporterParMorceaux(ecrire, {
        entete: (e) => { if (e.config) retirerSecretsSauvegarde(e.config); },
        ligne: (col, r) => (col === 'users' && r && r.reinitialisation !== undefined ? Object.assign({}, r, { reinitialisation: undefined }) : r),
      });
      res.end();
    } catch (e) { res.destroy(); return; }
    ctx.audit(req, 'export', 'configuration', null, 'Export complet de la base');
  }, { perm: ['systeme', 'modifier'] });

  /**
   * Import d'un export complet : fichier contrôlé (400 sinon), copie de l'état actuel avant remplacement, paramètres
   * de sauvegarde de ce serveur conservés. `?apercu=1` : contrôle et volumes seulement, sans rien remplacer.
   */
  router.post('/api/import', async (req) => {
    exigerGlobal(req, 'L\'import d\'une base');
    const data = req.body;
    validerBase(data);
    const v = volumes(data);
    const meta = data.exportGMAO && typeof data.exportGMAO === 'object' ? data.exportGMAO : {};
    if (req.query.apercu === '1') return { apercu: true, volumes: v, source: typeof meta.source === 'string' ? meta.source.slice(0, 80) : null, date: typeof meta.date === 'string' ? meta.date : null };
    const sauvegardesActuelles = db.getConfig().sauvegardes;
    const historique = db.list('sauvegardesHistorique');
    delete data.exportGMAO;
    db.importAll(data);
    apresRemplacement(null, sauvegardesActuelles, historique);
    ctx.audit(req, 'import', 'configuration', null, Object.entries(v).filter(([, n]) => n).map(([n, k]) => `${n} : ${k}`).join(', '));
    return { ok: true, volumes: v };
  }, { perm: ['systeme', 'modifier'], sansQuotaPieces: true });

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
    piecesJointes: { taille: db.taillePieces(), quotaMo: Number((db.getConfig().general || {}).quotaPiecesJointesMo) || 400, dossier: db.inMemory ? null : db.piecesDir },
    collections: db.collections().map((c) => ({ nom: c, nombre: db.count(c) })),
    modulesServeur: (ctx.modules || []).map((m) => m.nom),
    demarrage: DEMARRAGE,
  }), { perm: ['systeme', 'voir'] });
}

const DEMARRAGE = new Date().toISOString();

/** Clés secrètes de la section sauvegardes : jamais renvoyées au client, jamais modifiées par PUT /api/configuration. */
const SECRETS_SAUVEGARDE = ['cleReception', 'destinations', 'motDePasseChiffrement'];

/** Retire d'une configuration (copie) les secrets des sauvegardes, comme les sauvegardes du module. */
function retirerSecretsSauvegarde(cfg) {
  const s = cfg && cfg.sauvegardes;
  if (!s || typeof s !== 'object') return cfg;
  delete s.cleReception; delete s.motDePasseChiffrement; delete s.cleReceptionDate;
  s.destinations = [];
  return cfg;
}

/**
 * Fusionne `src` dans `cible` en n'acceptant que les clés présentes dans `defaut`, avec le même type
 * (booléen, nombre fini, chaîne ≤ 500 caractères, objet → récursif). Les tableaux et les clés `interdites` sont ignorés.
 * Avec `options.erreur(message)` : une valeur du mauvais type, hors des valeurs permises (VALEURS_PERMISES) ou des
 * bornes (BORNES) est refusée (l'erreur renvoyée est levée).
 */
function fusionTypee(cible, src, defaut, interdites, options = {}) {
  const out = Object.assign({}, defaut || {}, cible || {});
  const refuser = (m) => { if (options.erreur) throw options.erreur(m); };
  for (const [k, v] of Object.entries(src || {})) {
    if ((interdites || []).includes(k) || !defaut || !(k in defaut)) continue;
    const d = defaut[k];
    const chemin = options.section ? `${options.section}.${k}` : k;
    if (Array.isArray(d)) continue;
    if (typeof d === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else if (options.erreur) refuser(`Réglage « ${chemin} » : valeur oui / non attendue`);
      else out[k] = !!v;
    } else if (typeof d === 'number') {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n)) continue; // valeur vide ou non numérique : réglage inchangé
      const b = BORNES[chemin];
      if (b && (n < b[0] || n > b[1])) { refuser(`Réglage « ${chemin} » : valeur entre ${b[0]} et ${b[1]} attendue`); continue; }
      out[k] = n;
    } else if (typeof d === 'string') {
      if (v == null) continue;
      const t = String(v).slice(0, 500);
      const permises = VALEURS_PERMISES[chemin];
      if (permises && !permises.includes(t)) { refuser(`Réglage « ${chemin} » : valeur inconnue (${permises.join(', ')})`); continue; }
      out[k] = t;
    } else if (d && typeof d === 'object' && v && typeof v === 'object') out[k] = fusionTypee(out[k], v, d, [], Object.assign({}, options, { section: chemin }));
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
    delete c.sauvegardes.cleReceptionDate;
    c.sauvegardes.nbDestinations = Array.isArray(c.sauvegardes.destinations) ? c.sauvegardes.destinations.length : 0;
    delete c.sauvegardes.destinations;
  }
  return c;
}

module.exports = { nom, register, TYPES_CHAMPS, fusionTypee, masquerSecrets, retirerSecretsSauvegarde, USAGES_LISTES };
