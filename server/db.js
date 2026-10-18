'use strict';
/**
 * Base de données documentaire JSON (zéro dépendance).
 *
 * - Toutes les données sont conservées en mémoire et écrites de manière
 *   atomique dans <dataDir>/gmao.json (écriture dans un fichier temporaire
 *   puis renommage).
 * - Les pièces jointes volumineuses (chaînes « data:… » de 64 Ko et plus : photos,
 *   documents) sont écrites une seule fois dans <dataDir>/pieces/<empreinte>.txt ;
 *   gmao.json n'en garde qu'une référence. Le fichier principal reste petit, son
 *   écriture rapide, et sa taille ne dépend plus du volume des pièces jointes.
 *   En mémoire, rien ne change pour les modules : le contenu reste dans l'enregistrement.
 * - Une sauvegarde quotidienne est conservée dans <dataDir>/backups.
 * - Chaque collection est un tableau d'objets avec un identifiant numérique
 *   auto-incrémenté (`id`), `createdAt` et `updatedAt` (ISO 8601).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLLECTIONS = [
  'users', 'profils', 'secteurs',
  'equipements', 'demandes', 'ot', 'plansPreventifs',
  'articles', 'mouvementsStock', 'fournisseurs',
  'documents', 'audit', 'notifications',
  'demandesMdp', // demandes de réinitialisation du mot de passe (écran de connexion)
  // Collections des modules (présentes dès une base vide)
  'plans', 'inventaires', 'commandes', 'factures', 'visites',
  'personnel', 'habilitations', 'formations', 'visitesMedicales', 'absences',
  'sauvegardesHistorique',
];

/** Pièces jointes conservées hors de gmao.json : chaînes « data:… » d'au moins SEUIL_PIECE caractères. */
const SEUIL_PIECE = 64 * 1024;
const MARQUEUR_PIECE = '$pieceGmao';
const RE_NOM_PIECE = /^[0-9a-f]{64}\.txt$/;
const RE_REF_PIECE = /"\$pieceGmao":\s*"([0-9a-f]{64}\.txt)"/g;
const estPiece = (v) => typeof v === 'string' && v.length >= SEUIL_PIECE && v.startsWith('data:');
const JOUR_MS = 24 * 60 * 60 * 1000;

class Db {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'gmao.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.piecesDir = path.join(dataDir, 'pieces');
    this.saveDelay = options.saveDelay === undefined ? 300 : options.saveDelay;
    this.maxBackups = options.maxBackups || 30;
    this.inMemory = !!options.inMemory; // pour les tests
    this.log = options.log || ((...a) => console.error(new Date().toISOString(), ...a));
    /** Appelé (erreur) quand l'écriture programmée échoue ; les données restent en mémoire et l'écriture est retentée. */
    this.onErreurEcriture = null;
    this._timer = null;
    this._dirty = false;
    this._echecs = 0;
    this._pieces = new Map();     // contenu → nom du fichier de la pièce (dernière écriture)
    this._inventaire = null;      // { valeurs:Set, total } : pièces présentes en mémoire (recalculé après modification)
    this._jourEntretien = null;   // dernier jour de sauvegarde quotidienne et de nettoyage des pièces
    this.data = this._empty();
  }

  _empty() {
    const collections = {};
    for (const c of COLLECTIONS) collections[c] = [];
    return { meta: { version: 1, counters: {}, numeros: {} }, config: {}, collections };
  }

  load() {
    if (this.inMemory) return this;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = this._normalize(this._lire(this.file));
      } catch (e) {
        // Fichier corrompu : on le met de côté et on tente la dernière sauvegarde
        const broken = this.file + '.corrompu-' + Date.now();
        fs.renameSync(this.file, broken);
        const last = this._lastBackup();
        this.data = last ? this._normalize(this._lire(last)) : this._empty();
      }
    }
    this._entretienQuotidien();
    return this;
  }

  /** Lit un fichier de base (gmao.json ou copie) et réintègre les pièces jointes conservées à part. */
  _lire(fichier) {
    return this._reintegrerPieces(JSON.parse(fs.readFileSync(fichier, 'utf8')));
  }

  /**
   * Remplace les références { $pieceGmao, octets } par le contenu des fichiers de pièces (dossier pieces
   * uniquement, noms contrôlés). Une pièce absente devient une chaîne vide (signalée au journal du serveur).
   */
  _reintegrerPieces(racine) {
    let manquantes = 0;
    const lirePiece = (o) => {
      const nom = o[MARQUEUR_PIECE];
      if (this.inMemory || typeof nom !== 'string' || !RE_NOM_PIECE.test(nom)) { manquantes += 1; return ''; }
      try { return fs.readFileSync(path.join(this.piecesDir, nom), 'utf8'); } catch (e) { manquantes += 1; return ''; }
    };
    const estRef = (o) => o && typeof o === 'object' && !Array.isArray(o) && typeof o[MARQUEUR_PIECE] === 'string'
      && Object.keys(o).every((k) => k === MARQUEUR_PIECE || k === 'octets');
    const parcourir = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') {
          if (estRef(v)) o[k] = lirePiece(v); else parcourir(v);
        }
      }
    };
    parcourir(racine);
    if (manquantes) this.log(`Base de données : ${manquantes} pièce(s) jointe(s) introuvable(s) dans ${this.piecesDir}`);
    return racine;
  }

  _normalize(d) {
    const base = this._empty();
    d = d || {};
    base.meta = Object.assign(base.meta, d.meta || {});
    base.meta.counters = base.meta.counters || {};
    base.meta.numeros = base.meta.numeros || {};
    base.config = d.config || {};
    const cols = d.collections || {};
    for (const c of COLLECTIONS) base.collections[c] = Array.isArray(cols[c]) ? cols[c] : [];
    // collections supplémentaires éventuelles (extensions)
    for (const k of Object.keys(cols)) if (!base.collections[k]) base.collections[k] = cols[k];
    return base;
  }

  _lastBackup() {
    if (!fs.existsSync(this.backupDir)) return null;
    const files = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort();
    return files.length ? path.join(this.backupDir, files[files.length - 1]) : null;
  }

  _dailyBackup() {
    if (this.inMemory || !fs.existsSync(this.file)) return;
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `gmao-${today}.json`);
    if (!fs.existsSync(target)) {
      try { fs.mkdirSync(this.backupDir, { recursive: true }); fs.copyFileSync(this.file, target); } catch (e) { /* ignore */ }
    }
    let files = [];
    try { files = fs.readdirSync(this.backupDir).filter((f) => /^gmao-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (e) { /* ignore */ }
    while (files.length > this.maxBackups) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (e) { /* ignore */ }
    }
  }

  /** Une fois par jour (démarrage, puis première écriture de la journée) : copie quotidienne et nettoyage des pièces. */
  _entretienQuotidien() {
    if (this.inMemory) return;
    const jour = new Date().toISOString().slice(0, 10);
    if (this._jourEntretien === jour) return;
    this._jourEntretien = jour;
    this._dailyBackup();
    try { this._nettoyerPieces(); } catch (e) { this.log('Nettoyage des pièces jointes impossible :', e.message); }
  }

  /**
   * Supprime les fichiers de pièces qui ne sont plus référencés ni par la base, ni par une copie du dossier
   * backups (restaurable), et qui datent de plus d'un jour.
   */
  _nettoyerPieces() {
    if (this.inMemory || !fs.existsSync(this.piecesDir)) return 0;
    const utiles = new Set();
    const lireRefs = (fichier) => {
      let fd;
      try {
        fd = fs.openSync(fichier, 'r');
        const tampon = Buffer.alloc(4 * 1024 * 1024);
        let reste = '';
        let lus;
        while ((lus = fs.readSync(fd, tampon, 0, tampon.length, null)) > 0) {
          const texte = reste + tampon.toString('latin1', 0, lus);
          for (const m of texte.matchAll(RE_REF_PIECE)) utiles.add(m[1]);
          reste = texte.slice(-120);
        }
      } catch (e) { /* fichier illisible : ignoré */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    if (fs.existsSync(this.file)) lireRefs(this.file);
    if (fs.existsSync(this.backupDir)) {
      for (const f of fs.readdirSync(this.backupDir)) if (f.endsWith('.json')) lireRefs(path.join(this.backupDir, f));
    }
    for (const nom of this._pieces.values()) utiles.add(nom);
    let supprimees = 0;
    const limite = Date.now() - JOUR_MS;
    for (const f of fs.readdirSync(this.piecesDir)) {
      if (!RE_NOM_PIECE.test(f) || utiles.has(f)) continue;
      const chemin = path.join(this.piecesDir, f);
      try { if (fs.statSync(chemin).mtimeMs < limite) { fs.unlinkSync(chemin); supprimees += 1; } } catch (e) { /* ignore */ }
    }
    return supprimees;
  }

  /** Crée une sauvegarde manuelle et retourne son chemin. */
  backupNow(label = 'manuel') {
    if (this.inMemory) return null;
    this.saveNow();
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.backupDir, `gmao-${label}-${stamp}.json`);
    fs.copyFileSync(this.file, target);
    return target;
  }

  listBackups() {
    if (this.inMemory || !fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(this.backupDir, f));
        return { nom: f, taille: st.size, date: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  /**
   * Remplace la base par une sauvegarde du dossier backups. `options.conserver(ancienne, nouvelle)` peut
   * reprendre des éléments de la base actuelle (ex. paramètres propres à ce serveur) avant l'écriture.
   * Erreurs : `code` = 'NOM_INVALIDE' | 'INTROUVABLE' | 'ILLISIBLE'.
   */
  restoreBackup(nom, options = {}) {
    const erreur = (message, code) => Object.assign(new Error(message), { code });
    if (this.inMemory) throw erreur('Restauration impossible : serveur sans stockage sur disque', 'MEMOIRE');
    if (typeof nom !== 'string' || !/^[\w.-]+\.json$/.test(nom) || nom.startsWith('.')) throw erreur('Nom de sauvegarde invalide', 'NOM_INVALIDE');
    const file = path.join(this.backupDir, nom);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw erreur('Sauvegarde introuvable', 'INTROUVABLE');
    let donnees;
    try { donnees = this._lire(file); } catch (e) { throw erreur('Sauvegarde illisible : fichier endommagé ou d\'un autre format', 'ILLISIBLE'); }
    if (!donnees || typeof donnees !== 'object' || !donnees.collections || typeof donnees.collections !== 'object') throw erreur('Sauvegarde illisible : fichier endommagé ou d\'un autre format', 'ILLISIBLE');
    if (typeof options.valider === 'function') options.valider(donnees);
    this.backupNow('avant-restauration');
    const ancienne = this.data;
    this.data = this._normalize(donnees);
    if (typeof options.conserver === 'function') options.conserver(ancienne, this.data);
    this._dirty = true;
    this.saveNow();
  }

  /** Marque les données comme modifiées et programme une écriture. */
  touch() {
    this._dirty = true;
    this._inventaire = null;
    if (this.inMemory) return;
    if (this.saveDelay <= 0) return this.saveNow();
    if (this._timer) return;
    this._programmer(this.saveDelay);
  }

  /**
   * Écriture différée : une erreur (disque plein, droits…) n'arrête jamais le serveur. Les données restent
   * en mémoire, l'écriture est retentée (30 s, puis jusqu'à 5 min) et `onErreurEcriture` est appelé.
   */
  _programmer(delai) {
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.saveNow();
        this._echecs = 0;
      } catch (e) {
        this._echecs += 1;
        this._dirty = true;
        this.log('Écriture de la base impossible :', e && e.stack ? e.stack : e);
        if (!this._timer) this._programmer(Math.min(5 * 60 * 1000, 30 * 1000 * this._echecs));
        if (typeof this.onErreurEcriture === 'function') { try { this.onErreurEcriture(e); } catch (x) { /* ignore */ } }
      }
    }, delai);
    if (this._timer.unref) this._timer.unref();
  }

  saveNow() {
    if (this.inMemory) { this._dirty = false; return; }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty && fs.existsSync(this.file)) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    const pieces = new Map();
    let total = 0;
    const json = JSON.stringify(this.data, (k, v) => {
      if (!estPiece(v)) return v;
      let nom = pieces.get(v) || this._pieces.get(v);
      if (!nom) nom = this._ecrirePiece(v);
      if (!pieces.has(v)) { pieces.set(v, nom); total += v.length; }
      return { [MARQUEUR_PIECE]: nom, octets: v.length };
    }, 1);
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.file);
    this._pieces = pieces;
    this._inventaire = { valeurs: new Set(pieces.keys()), total };
    this._dirty = false;
    this._entretienQuotidien();
  }

  /** Écrit une pièce jointe (une seule fois : le nom est l'empreinte SHA-256 du contenu) et renvoie son nom. */
  _ecrirePiece(contenu) {
    const nom = crypto.createHash('sha256').update(contenu, 'utf8').digest('hex') + '.txt';
    const chemin = path.join(this.piecesDir, nom);
    if (!fs.existsSync(chemin)) {
      fs.mkdirSync(this.piecesDir, { recursive: true });
      const tmp = chemin + '.tmp';
      fs.writeFileSync(tmp, contenu, 'utf8');
      fs.renameSync(tmp, chemin);
    }
    return nom;
  }

  /** Pièces jointes présentes en mémoire : { valeurs:Set<string>, total (caractères) }. */
  _inventairePieces() {
    if (this._inventaire) return this._inventaire;
    const valeurs = new Set();
    let total = 0;
    const parcourir = (o) => {
      if (estPiece(o)) { if (!valeurs.has(o)) { valeurs.add(o); total += o.length; } return; }
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) parcourir(x); return; }
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) parcourir(o[k]);
    };
    parcourir(this.data);
    this._inventaire = { valeurs, total };
    return this._inventaire;
  }

  /** Volume des pièces jointes de la base (octets, base64 compris). */
  taillePieces() { return this._inventairePieces().total; }

  /**
   * Volume des nouvelles pièces jointes d'un contenu reçu (pièces déjà présentes dans la base exclues) :
   * sert à appliquer le quota global des pièces jointes avant d'enregistrer.
   */
  taillePiecesNouvelles(contenu) {
    const recues = new Set();
    const parcourir = (o, profondeur) => {
      if (profondeur > 64) return;
      if (estPiece(o)) { recues.add(o); return; }
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) parcourir(o[k], profondeur + 1);
    };
    parcourir(contenu, 0);
    if (!recues.size) return 0;
    const connues = this._inventairePieces().valeurs;
    let total = 0;
    for (const v of recues) if (!connues.has(v)) total += v.length;
    return total;
  }

  // ----- Collections -----------------------------------------------------

  _col(name) {
    if (!this.data.collections[name]) this.data.collections[name] = [];
    return this.data.collections[name];
  }

  collections() { return Object.keys(this.data.collections); }

  /** Liste (copie superficielle) des documents, éventuellement filtrée. */
  list(name, predicate) {
    const col = this._col(name);
    const out = predicate ? col.filter(predicate) : col.slice();
    return out.map((o) => Object.assign({}, o));
  }

  count(name, predicate) {
    const col = this._col(name);
    return predicate ? col.filter(predicate).length : col.length;
  }

  get(name, id) {
    id = Number(id);
    const o = this._col(name).find((x) => x.id === id);
    return o ? Object.assign({}, o) : null;
  }

  findOne(name, predicate) {
    const o = this._col(name).find(predicate);
    return o ? Object.assign({}, o) : null;
  }

  nextId(name) {
    const counters = this.data.meta.counters;
    const col = this._col(name);
    let next = (counters[name] || 0) + 1;
    for (const o of col) if (o.id >= next) next = o.id + 1;
    counters[name] = next;
    return next;
  }

  insert(name, doc) {
    const now = new Date().toISOString();
    const obj = Object.assign({}, doc, { id: this.nextId(name), createdAt: now, updatedAt: now });
    this._col(name).push(obj);
    this.touch();
    return Object.assign({}, obj);
  }

  update(name, id, patch) {
    id = Number(id);
    const col = this._col(name);
    const idx = col.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const obj = Object.assign({}, col[idx], patch, { id, createdAt: col[idx].createdAt, updatedAt: new Date().toISOString() });
    col[idx] = obj;
    this.touch();
    return Object.assign({}, obj);
  }

  remove(name, id) {
    id = Number(id);
    const col = this._col(name);
    const idx = col.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    col.splice(idx, 1);
    this.touch();
    return true;
  }

  /** Remplace entièrement une collection (import). */
  replaceCollection(name, rows) {
    this.data.collections[name] = Array.isArray(rows) ? rows.map((r) => Object.assign({}, r)) : [];
    this.touch();
  }

  // ----- Configuration ---------------------------------------------------

  getConfig() { return JSON.parse(JSON.stringify(this.data.config || {})); }

  setConfig(cfg) {
    this.data.config = JSON.parse(JSON.stringify(cfg || {}));
    this.touch();
    return this.getConfig();
  }

  // ----- Numérotation ----------------------------------------------------

  /**
   * Génère un numéro selon un gabarit, ex. "OT-{annee}-{num:4}".
   * Le compteur est propre à chaque clé et à chaque année si {annee} est présent.
   */
  nextNumber(key, template) {
    template = template || (key.toUpperCase() + '-{num:4}');
    const now = new Date();
    const annee = String(now.getFullYear());
    const mois = String(now.getMonth() + 1).padStart(2, '0');
    const counterKey = template.includes('{annee}') ? `${key}:${annee}` : key;
    const numeros = this.data.meta.numeros;
    numeros[counterKey] = (numeros[counterKey] || 0) + 1;
    const n = numeros[counterKey];
    this.touch();
    return template
      .replace(/\{annee\}/g, annee)
      .replace(/\{aa\}/g, annee.slice(2))
      .replace(/\{mois\}/g, mois)
      .replace(/\{num(?::(\d+))?\}/g, (m, w) => String(n).padStart(Number(w || 1), '0'));
  }

  // ----- Export / import -------------------------------------------------

  /** Copie complète (pièces jointes comprises) ; sans passer par une chaîne JSON unique (aucune limite de taille). */
  exportAll() { return structuredClone(this.data); }

  /**
   * Écrit la base complète en JSON (pièces jointes comprises) morceau par morceau : `ecrire(chaine)` est appelé
   * pour chaque enregistrement, sans construire une chaîne unique (export de bases volumineuses) ; s'il renvoie une
   * promesse (flux saturé), l'écriture reprend après sa résolution.
   * Options : `entete({ meta, config })` modifie la copie des métadonnées et de la configuration (ex. secrets retirés) ;
   * `ligne(collection, enregistrement)` renvoie l'enregistrement à écrire (copie modifiée, jamais l'original modifié),
   * ou undefined pour l'omettre.
   */
  async exporterParMorceaux(ecrire, options = {}) {
    const entete = { meta: structuredClone(this.data.meta), config: structuredClone(this.data.config || {}) };
    const collections = Object.entries(this.data.collections).map(([nom, rows]) => [nom, Array.isArray(rows) ? rows.slice() : []]);
    if (typeof options.entete === 'function') options.entete(entete);
    const envoyer = async (texte) => { const r = ecrire(texte); if (r && typeof r.then === 'function') await r; };
    await envoyer('{"meta":' + JSON.stringify(entete.meta) + ',\n"config":' + JSON.stringify(entete.config) + ',\n"collections":{');
    let premiere = true;
    for (const [nom, rows] of collections) {
      await envoyer((premiere ? '\n' : ',\n') + JSON.stringify(nom) + ':[');
      premiere = false;
      let n = 0;
      for (const r of rows) {
        const sortie = typeof options.ligne === 'function' ? options.ligne(nom, r) : r;
        if (sortie === undefined) continue;
        await envoyer((n ? ',\n' : '\n') + JSON.stringify(sortie));
        n += 1;
      }
      await envoyer(']');
    }
    await envoyer('\n}}\n');
  }

  importAll(data) {
    if (!data || typeof data !== 'object' || !data.collections) throw new Error('Fichier d\'import invalide');
    if (!this.inMemory) this.backupNow('avant-import');
    this.data = this._normalize(this._reintegrerPieces(data));
    this._dirty = true;
    this._inventaire = null;
    this.saveNow();
  }
}

module.exports = { Db, COLLECTIONS, SEUIL_PIECE };
