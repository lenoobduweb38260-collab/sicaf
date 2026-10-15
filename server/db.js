'use strict';
/**
 * Base de données documentaire JSON (zéro dépendance).
 *
 * - Toutes les données sont conservées en mémoire et écrites de manière
 *   atomique dans <dataDir>/gmao.json (écriture dans un fichier temporaire
 *   puis renommage).
 * - Une sauvegarde quotidienne est conservée dans <dataDir>/backups.
 * - Chaque collection est un tableau d'objets avec un identifiant numérique
 *   auto-incrémenté (`id`), `createdAt` et `updatedAt` (ISO 8601).
 */
const fs = require('fs');
const path = require('path');

const COLLECTIONS = [
  'users', 'profils', 'secteurs',
  'equipements', 'demandes', 'ot', 'plansPreventifs',
  'articles', 'mouvementsStock', 'fournisseurs',
  'documents', 'audit', 'notifications',
  'demandesMdp', // demandes de réinitialisation du mot de passe (écran de connexion)
];

class Db {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'gmao.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.saveDelay = options.saveDelay === undefined ? 300 : options.saveDelay;
    this.maxBackups = options.maxBackups || 30;
    this.inMemory = !!options.inMemory; // pour les tests
    this._timer = null;
    this._dirty = false;
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
      const raw = fs.readFileSync(this.file, 'utf8');
      try {
        this.data = this._normalize(JSON.parse(raw));
      } catch (e) {
        // Fichier corrompu : on le met de côté et on tente la dernière sauvegarde
        const broken = this.file + '.corrompu-' + Date.now();
        fs.renameSync(this.file, broken);
        const last = this._lastBackup();
        if (last) {
          this.data = this._normalize(JSON.parse(fs.readFileSync(last, 'utf8')));
        } else {
          this.data = this._empty();
        }
      }
    }
    this._dailyBackup();
    return this;
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
      try { fs.copyFileSync(this.file, target); } catch (e) { /* ignore */ }
    }
    const files = fs.readdirSync(this.backupDir).filter((f) => /^gmao-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > this.maxBackups) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (e) { /* ignore */ }
    }
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

  restoreBackup(nom) {
    if (this.inMemory) throw new Error('Mode mémoire');
    if (!/^[\w.-]+\.json$/.test(nom)) throw new Error('Nom de sauvegarde invalide');
    const file = path.join(this.backupDir, nom);
    if (!fs.existsSync(file)) throw new Error('Sauvegarde introuvable');
    this.backupNow('avant-restauration');
    this.data = this._normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    this.saveNow();
  }

  /** Marque les données comme modifiées et programme une écriture. */
  touch() {
    this._dirty = true;
    if (this.inMemory) return;
    if (this.saveDelay <= 0) return this.saveNow();
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this.saveDelay);
    if (this._timer.unref) this._timer.unref();
  }

  saveNow() {
    if (this.inMemory) { this._dirty = false; return; }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty && fs.existsSync(this.file)) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
    this._dirty = false;
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

  exportAll() { return JSON.parse(JSON.stringify(this.data)); }

  importAll(data) {
    if (!data || typeof data !== 'object' || !data.collections) throw new Error('Fichier d\'import invalide');
    if (!this.inMemory) this.backupNow('avant-import');
    this.data = this._normalize(data);
    this._dirty = true;
    this.saveNow();
  }
}

module.exports = { Db, COLLECTIONS };
