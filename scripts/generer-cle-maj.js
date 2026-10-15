#!/usr/bin/env node
'use strict';
/**
 * Génère la paire de clés Ed25519 qui signe les manifestes de mise à jour (latest.json).
 *
 *   node scripts/generer-cle-maj.js <fichier de clé privée à créer>
 *   node scripts/generer-cle-maj.js --afficher <fichier de clé privée existant>
 *
 * - La clé privée (PEM PKCS#8) est écrite dans le fichier indiqué. Ce fichier doit se trouver HORS du
 *   dossier du dépôt, ou dans un chemin ignoré par .gitignore et non embarqué dans l'application ;
 *   un fichier existant n'est jamais écrasé.
 * - La clé publique est affichée : elle se place dans package.json › gmao.clePubliqueMaj.
 * - La clé privée devient le secret GitHub « MAJ_CLE_PRIVEE » (procédure complète : docs/MISES-A-JOUR.md).
 * La clé privée n'est jamais affichée.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { empreinteClePublique } = require('../electron/miseajour');

const RACINE = path.resolve(__dirname, '..');

/** Chemin absolu, liens symboliques résolus jusqu'au dossier existant le plus proche. */
function cheminReel(p) {
  let courant = path.resolve(p);
  const reste = [];
  while (!fs.existsSync(courant)) {
    const parent = path.dirname(courant);
    if (parent === courant) break;
    reste.unshift(path.basename(courant));
    courant = parent;
  }
  return path.join(fs.realpathSync(courant), ...reste);
}

/** Chemin relatif de `cible` dans `racine`, ou null s'il est en dehors. */
function relatifDans(racine, cible) {
  const rel = path.relative(racine, cible);
  if (path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
  return rel;
}

/** Premiers dossiers embarqués dans l'application (package.json › build.files). */
function dossiersEmbarques(racine) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(racine, 'package.json'), 'utf8'));
    const fichiers = (pkg.build && Array.isArray(pkg.build.files)) ? pkg.build.files : [];
    return fichiers.filter((f) => typeof f === 'string' && !f.startsWith('!')).map((f) => f.split('/')[0]).filter(Boolean);
  } catch (e) {
    return ['electron', 'server', 'client', 'package.json'];
  }
}

/**
 * Vérifie que la clé privée ne pourra être ni versionnée ni embarquée dans l'application.
 * @returns {{ ok: boolean, chemin: string, raison?: string, avertissement?: string }}
 */
function controlerEmplacement(fichier, racine = RACINE) {
  if (!fichier || typeof fichier !== 'string') return { ok: false, chemin: '', raison: 'Indiquez le fichier de clé privée à créer.' };
  const cible = cheminReel(fichier);
  const depot = fs.realpathSync(racine);
  if (fs.existsSync(cible)) return { ok: false, chemin: cible, raison: `Le fichier ${cible} existe déjà : une clé existante n'est jamais écrasée.` };
  const rel = relatifDans(depot, cible);
  if (rel === null) return { ok: true, chemin: cible };
  const hors = `Choisissez un emplacement hors du dossier du dépôt (${depot}).`;
  const premier = rel.split(path.sep)[0];
  if (premier === '' || premier === '.git' || dossiersEmbarques(depot).includes(premier)) {
    return { ok: false, chemin: cible, raison: `${cible} serait embarqué dans l'application ou dans l'historique du dépôt. ${hors}` };
  }
  const git = spawnSync('git', ['-C', depot, 'check-ignore', '-q', '--', rel], { stdio: 'ignore', windowsHide: true });
  if (git.status === 0) {
    return { ok: true, chemin: cible, avertissement: 'La clé privée est enregistrée dans le dossier du dépôt (chemin ignoré par .gitignore). Déplacez-la de préférence hors du dépôt.' };
  }
  if (git.status === 1) return { ok: false, chemin: cible, raison: `${cible} se trouve dans le dépôt et n'est pas ignoré par .gitignore : la clé privée risquerait d'être publiée. ${hors}` };
  return { ok: false, chemin: cible, raison: `Impossible de vérifier avec git que ${cible} est ignoré. ${hors}` };
}

/** Nouvelle paire de clés Ed25519. */
function genererPaire() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { clePrivee: privateKey, clePublique: publicKey };
}

/** Formats de la clé publique : base64 (SPKI DER, une ligne, pour package.json), PEM et empreinte. */
function formatsClePublique(clePublique) {
  return {
    base64: clePublique.export({ type: 'spki', format: 'der' }).toString('base64'),
    pem: clePublique.export({ type: 'spki', format: 'pem' }),
    empreinte: empreinteClePublique(clePublique),
  };
}

/** Écrit la clé privée (création exclusive, droits restreints au propriétaire hors Windows). */
function ecrireClePrivee(chemin, clePrivee) {
  fs.mkdirSync(path.dirname(chemin), { recursive: true, mode: 0o700 });
  fs.writeFileSync(chemin, clePrivee.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
}

function lireClePriveeFichier(chemin) {
  let cle;
  try {
    cle = crypto.createPrivateKey({ key: fs.readFileSync(chemin, 'utf8'), format: 'pem' });
  } catch (e) {
    throw new Error(`${chemin} ne contient pas une clé privée PEM lisible`);
  }
  if (cle.asymmetricKeyType !== 'ed25519') throw new Error(`${chemin} ne contient pas une clé Ed25519`);
  return cle;
}

function texteClePublique(f) {
  return [
    'Clé publique (à placer dans package.json, rubrique « gmao ») :',
    '',
    `  "clePubliqueMaj": "${f.base64}"`,
    '',
    `Empreinte SHA-256 de la clé publique : ${f.empreinte}`,
    '',
    'Même clé publique au format PEM :',
    f.pem.trim(),
  ];
}

function principal(args, sortie = console) {
  if (!args.length || args.includes('--aide') || args.includes('-h')) {
    sortie.log('Utilisation :');
    sortie.log('  node scripts/generer-cle-maj.js <fichier de clé privée à créer, hors du dépôt>');
    sortie.log('  node scripts/generer-cle-maj.js --afficher <fichier de clé privée existant>');
    return args.length ? 0 : 1;
  }
  if (args[0] === '--afficher') {
    if (!args[1]) { sortie.error('Indiquez le fichier de clé privée.'); return 1; }
    const cle = lireClePriveeFichier(path.resolve(args[1]));
    texteClePublique(formatsClePublique(crypto.createPublicKey(cle))).forEach((l) => sortie.log(l));
    return 0;
  }
  const controle = controlerEmplacement(args[0]);
  if (!controle.ok) { sortie.error(`Refusé : ${controle.raison}`); return 2; }
  const { clePrivee, clePublique } = genererPaire();
  ecrireClePrivee(controle.chemin, clePrivee);
  const f = formatsClePublique(clePublique);
  const lignes = [
    'Paire de clés Ed25519 générée pour la signature des mises à jour.',
    '',
    `Clé privée : ${controle.chemin}`,
    '  Elle ne doit jamais être placée dans le dépôt, envoyée par messagerie ni copiée sur un poste utilisateur.',
  ];
  if (controle.avertissement) lignes.push(`  Attention : ${controle.avertissement}`);
  lignes.push(
    '',
    ...texteClePublique(f),
    '',
    'Étapes suivantes :',
    '  1. Secret GitHub : sur la page du dépôt, Settings › Secrets and variables › Actions › New repository secret.',
    '     Nom : MAJ_CLE_PRIVEE ; valeur : tout le contenu du fichier de clé privée, lignes',
    '     « -----BEGIN PRIVATE KEY----- » et « -----END PRIVATE KEY----- » comprises.',
    `     Avec l'outil en ligne de commande GitHub : gh secret set MAJ_CLE_PRIVEE < "${controle.chemin}"`,
    '  2. Clé publique : ajoutez la ligne « clePubliqueMaj » ci-dessus dans la rubrique « gmao » de package.json,',
    '     puis publiez une version : les versions suivantes devront obligatoirement être signées.',
    '  3. Conservez une copie de la clé privée hors ligne (coffre-fort de mots de passe de l\'entreprise ou support',
    '     chiffré rangé en lieu sûr), puis supprimez ce fichier du poste : sans cette clé, aucune mise à jour ne',
    '     pourrait plus être installée automatiquement par les postes.',
    '',
    'Procédure complète : docs/MISES-A-JOUR.md',
  );
  if (process.platform === 'win32') {
    lignes.push('', 'Windows : restreignez l\'accès au fichier à votre seul compte (Propriétés › Sécurité) tant qu\'il est sur ce poste.');
  }
  lignes.forEach((l) => sortie.log(l));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (e) {
    console.error(`Erreur : ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { controlerEmplacement, genererPaire, formatsClePublique, ecrireClePrivee, lireClePriveeFichier, principal };
