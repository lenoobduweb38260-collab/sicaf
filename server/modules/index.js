'use strict';
/**
 * Chargeur de modules serveur.
 * Chaque fichier de ce dossier (sauf index.js) exporte :
 *   - register(ctx)  : déclare ses routes (obligatoire)
 *   - seedDemo(ctx)  : insère des données de démonstration (optionnel)
 *   - nom            : nom lisible (optionnel)
 */
const fs = require('fs');
const path = require('path');

function listModuleFiles() {
  return fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();
}

function loadModules(ctx) {
  ctx.modules = [];
  for (const f of listModuleFiles()) {
    const mod = require(path.join(__dirname, f));
    if (typeof mod.register === 'function') mod.register(ctx);
    ctx.modules.push({ fichier: f, nom: mod.nom || f.replace(/\.js$/, ''), seedDemo: mod.seedDemo });
  }
  return ctx.modules;
}

/** Charge les données de démonstration de tous les modules. */
function seedDemo(ctx) {
  const rapport = [];
  for (const m of ctx.modules || []) {
    if (typeof m.seedDemo === 'function') {
      try {
        const r = m.seedDemo(ctx);
        rapport.push({ module: m.nom, ok: true, details: r || null });
      } catch (e) {
        rapport.push({ module: m.nom, ok: false, erreur: e.message });
      }
    }
  }
  ctx.db.saveNow();
  return rapport;
}

module.exports = { loadModules, seedDemo, listModuleFiles };
