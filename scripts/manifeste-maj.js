#!/usr/bin/env node
'use strict';
/**
 * Produit dist/latest.json (manifeste de mise à jour) après la construction de l'installateur :
 *   node scripts/manifeste-maj.js <dossier dist> [version] [fichier notes]
 * Le manifeste est publié avec l'installateur ; l'application l'utilise pour détecter la
 * nouvelle version et vérifier l'empreinte SHA-256 du fichier téléchargé.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function manifeste(dossier, version, notes) {
  const v = version || require('../package.json').version;
  const fichier = `GMAO-SICAF-Setup-${v}.exe`;
  const chemin = path.join(dossier, fichier);
  if (!fs.existsSync(chemin)) throw new Error(`Installateur introuvable : ${chemin}`);
  const contenu = fs.readFileSync(chemin);
  const m = {
    version: v,
    fichier,
    sha256: crypto.createHash('sha256').update(contenu).digest('hex'),
    taille: contenu.length,
    date: new Date().toISOString(),
    notes: notes || '',
  };
  fs.writeFileSync(path.join(dossier, 'latest.json'), JSON.stringify(m, null, 2));
  return m;
}

if (require.main === module) {
  const [dossier = 'dist', version, fichierNotes] = process.argv.slice(2);
  const notes = fichierNotes && fs.existsSync(fichierNotes) ? fs.readFileSync(fichierNotes, 'utf8').slice(0, 20000) : '';
  const m = manifeste(dossier, version, notes);
  console.log(`latest.json : version ${m.version}, ${m.fichier}, ${m.taille} octets, sha256 ${m.sha256}`);
}

module.exports = { manifeste };
