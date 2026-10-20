#!/usr/bin/env node
'use strict';
/**
 * Produit <dossier>/latest.json (manifeste de mise à jour) après la construction de l'installateur :
 *   node scripts/manifeste-maj.js <dossier dist> [version] [fichier notes] [notes nettoyées]
 *
 * Les notes (message du commit) sont nettoyées avant d'être signées (nettoyerNotes) : en-têtes de fin
 * (Co-Authored-By:, Signed-off-by:…), lignes de mention ajoutées par les outils de développement ou par
 * une fusion (identifiants de session, adresses seules, « Generated with … »). Le 4e argument reçoit les
 * notes nettoyées, reprises telles quelles comme texte de la publication GitHub.
 *
 * Le manifeste est publié avec l'installateur ; l'application l'utilise pour détecter la nouvelle
 * version et vérifier l'installateur téléchargé (taille et empreinte SHA-256).
 *
 * Signature : si la variable d'environnement MAJ_CLE_PRIVEE contient la clé privée Ed25519 (fichier PEM
 * produit par scripts/generer-cle-maj.js), le manifeste est signé et reçoit les champs « signature »
 * (base64) et « algorithme » (« ed25519 »). Le contenu signé est le JSON, clés triées, des champs
 * date, fichier, notes, sha256, taille et version (electron/miseajour.js › contenuSigne).
 * Les postes dont la clé publique est configurée (package.json › gmao.clePubliqueMaj) refusent tout
 * manifeste non signé ou mal signé. Sans MAJ_CLE_PRIVEE, le manifeste est produit sans signature et
 * un avertissement l'indique.
 *
 * La clé privée n'est jamais écrite sur disque ni affichée. Avant d'écrire le manifeste, le script
 * vérifie que la signature produite est acceptée par la ou les clés publiques de package.json :
 * une clé privée qui ne leur correspond pas arrête la construction.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const maj = require('../electron/miseajour');

/**
 * Lit une clé privée Ed25519 : PEM PKCS#8 (retours à la ligne réels ou « \n »), PKCS#8 DER en base64,
 * ou objet KeyObject. Valeur vide → null (pas de signature).
 */
function lireClePrivee(valeur) {
  if (valeur && typeof valeur === 'object' && valeur.type === 'private') {
    if (valeur.asymmetricKeyType !== maj.ALGORITHME) throw new Error('MAJ_CLE_PRIVEE : une clé Ed25519 est attendue');
    return valeur;
  }
  const texte = String(valeur == null ? '' : valeur).trim().replace(/\\n/g, '\n');
  if (!texte) return null;
  let cle = null;
  try {
    if (/^-----BEGIN PRIVATE KEY-----/.test(texte)) cle = crypto.createPrivateKey({ key: texte, format: 'pem' });
    else if (/^[A-Za-z0-9+/\s]+={0,2}$/.test(texte)) cle = crypto.createPrivateKey({ key: Buffer.from(texte.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'pkcs8' });
  } catch (e) {
    cle = null;
  }
  // Message volontairement générique : le contenu de la variable n'est jamais repris
  if (!cle) throw new Error('MAJ_CLE_PRIVEE illisible : clé privée Ed25519 au format PEM non chiffré « BEGIN PRIVATE KEY » attendue (scripts/generer-cle-maj.js)');
  if (cle.asymmetricKeyType !== maj.ALGORITHME) throw new Error('MAJ_CLE_PRIVEE : une clé Ed25519 est attendue');
  return cle;
}

/** En-tête de fin de message à la manière de git (« Clé: valeur », clé sans espace ni accent). */
const RE_EN_TETE = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+\S/;
/** Lignes de mention, où qu'elles se trouvent dans le message. */
const RES_MENTION = [
  /^\s*[a-z0-9]+(-[a-z0-9]+)*-(by|session)\s*:/i,        // Co-Authored-By:, Signed-off-by:, Outil-Session:…
  /^\s*session\s*:/i,                                    // Session: …
  /session_[A-Za-z0-9]/,                                 // identifiant ou adresse de session
  /^\s*<?https?:\/\/\S+>?\s*$/i,                            // adresse seule sur la ligne
  /^[^\p{L}\p{N}]*generated (with|by)\b/iu,                 // « Generated with … » en tête de ligne
  /^[^\p{L}\p{N}]*g[ée]n[ée]r[ée]e? (avec|par)\b.*(\]\(|https?:\/\/)/iu, // « Généré avec [outil](…) »
];

/**
 * Notes de version publiées à partir du message d'un commit : sujet et corps, sans le bloc d'en-têtes de
 * fin (dernier paragraphe composé uniquement de lignes « Clé: valeur », comme git interpret-trailers) ni
 * les lignes de mention ; lignes vides consécutives réduites à une.
 * @param {string} texte
 * @returns {string}
 */
function nettoyerNotes(texte) {
  const lignes = String(texte == null ? '' : texte).replace(/\r\n?/g, '\n').split('\n');
  // Dernier paragraphe : bloc d'en-têtes de fin (jamais le sujet seul)
  let fin = lignes.length;
  while (fin > 0 && !lignes[fin - 1].trim()) fin -= 1;
  let debut = fin;
  while (debut > 0 && lignes[debut - 1].trim()) debut -= 1;
  const paragraphe = lignes.slice(debut, fin);
  const conservees = debut > 0 && paragraphe.length && paragraphe.every((l) => RE_EN_TETE.test(l.trim())) ? lignes.slice(0, debut) : lignes;
  const sortie = [];
  for (const l of conservees) {
    if (RES_MENTION.some((re) => re.test(l))) continue;
    const ligne = l.replace(/\s+$/, '');
    if (!ligne && (!sortie.length || !sortie[sortie.length - 1])) continue;
    sortie.push(ligne);
  }
  while (sortie.length && !sortie[sortie.length - 1]) sortie.pop();
  return sortie.join('\n');
}

/** Clés publiques intégrées aux postes (package.json › gmao.clePubliqueMaj). */
function clesPubliquesConfigurees() {
  try {
    return maj.chargerClesPubliques(maj.clePubliqueIntegree());
  } catch (e) {
    throw new Error(`package.json › gmao.clePubliqueMaj : ${e.message}`);
  }
}

/**
 * Signe un manifeste normalisé. La signature est contrôlée avec la clé publique dérivée de la clé
 * privée puis, si elles sont fournies, avec les clés attendues par les postes.
 */
function signerManifeste(m, clePrivee, clesAttendues = []) {
  const donnees = Buffer.from(maj.contenuSigne(m), 'utf8');
  const signature = crypto.sign(null, donnees, clePrivee).toString('base64');
  const signe = Object.assign({}, m, { signature, algorithme: maj.ALGORITHME });
  if (!maj.verifierSignature(signe, [crypto.createPublicKey(clePrivee)])) throw new Error('Échec du contrôle de la signature produite');
  if (clesAttendues.length && !maj.verifierSignature(signe, clesAttendues)) {
    throw new Error('La clé privée MAJ_CLE_PRIVEE ne correspond à aucune clé publique de package.json (gmao.clePubliqueMaj) : '
      + 'les postes refuseraient cette mise à jour. Vérifiez le secret ou la clé publique (docs/MISES-A-JOUR.md).');
  }
  return signe;
}

/**
 * Calcule le manifeste de l'installateur <dossier>/GMAO-SICAF-Setup-<version>.exe et l'écrit dans
 * <dossier>/latest.json.
 * @param {string} dossier
 * @param {string} [version]  par défaut : version de package.json
 * @param {string} [notes]
 * @param {{ clePrivee?: string|crypto.KeyObject|null, clesPubliques?: string|string[] }} [options]
 *   clePrivee : clé de signature (par défaut : variable d'environnement MAJ_CLE_PRIVEE) ;
 *   clesPubliques : clés attendues par les postes (par défaut : package.json › gmao.clePubliqueMaj).
 */
function manifeste(dossier, version, notes, options = {}) {
  const v = version || require('../package.json').version;
  const fichier = `GMAO-SICAF-Setup-${v}.exe`;
  const chemin = path.join(dossier, fichier);
  if (!fs.existsSync(chemin)) throw new Error(`Installateur introuvable : ${chemin}`);
  const contenu = fs.readFileSync(chemin);
  const n = maj.validerManifeste({
    version: v,
    fichier,
    sha256: crypto.createHash('sha256').update(contenu).digest('hex'),
    taille: contenu.length,
    date: new Date().toISOString(),
    notes: String(notes || ''),
  });
  let m = { version: n.version, fichier: n.fichier, sha256: n.sha256, taille: n.taille, date: n.date, notes: n.notes };
  const cle = lireClePrivee(options.clePrivee !== undefined ? options.clePrivee : process.env.MAJ_CLE_PRIVEE);
  if (cle) {
    const attendues = options.clesPubliques !== undefined ? maj.chargerClesPubliques(options.clesPubliques) : clesPubliquesConfigurees();
    m = signerManifeste(m, cle, attendues);
  }
  const sortie = path.join(dossier, 'latest.json');
  const tmp = `${sortie}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, sortie);
  return m;
}

/** Message d'intégration continue (GitHub Actions), une ligne. */
function annotation(type, titre, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const echapper = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${type} title=${echapper(titre).replace(/[:,]/g, ' ')}::${echapper(message)}`);
}

function resume(lignes) {
  const fichier = process.env.GITHUB_STEP_SUMMARY;
  if (!fichier) return;
  try { fs.appendFileSync(fichier, `${lignes.join('\n')}\n\n`); } catch (e) { /* résumé facultatif */ }
}

function principal(args) {
  const [dossier = 'dist', version, fichierNotes, sortieNotes] = args;
  const notes = nettoyerNotes(fichierNotes && fs.existsSync(fichierNotes) ? fs.readFileSync(fichierNotes, 'utf8') : '');
  // La clé est retirée de l'environnement dès sa lecture
  const brute = process.env.MAJ_CLE_PRIVEE;
  delete process.env.MAJ_CLE_PRIVEE;
  const cle = lireClePrivee(brute);
  const m = manifeste(dossier, version, notes, { clePrivee: cle });
  // Texte de la publication : exactement les notes signées
  if (sortieNotes) fs.writeFileSync(sortieNotes, m.notes ? `${m.notes}\n` : '');
  console.log(`latest.json : version ${m.version}, ${m.fichier}, ${m.taille} octets, sha256 ${m.sha256}`);
  const lignes = ['### Manifeste de mise à jour (latest.json)', '', `- Version : ${m.version}`, `- Installateur : ${m.fichier} (${m.taille} octets)`, `- SHA-256 : \`${m.sha256}\``];
  if (m.signature) {
    const empreinte = maj.empreinteClePublique(crypto.createPublicKey(cle));
    console.log(`Manifeste signé (ed25519), clé publique d'empreinte SHA-256 ${empreinte}`);
    lignes.push(`- Signature : ed25519, clé publique d'empreinte \`${empreinte}\``);
  } else {
    let configurees = 0;
    try { configurees = clesPubliquesConfigurees().length; } catch (e) { configurees = 1; }
    const message = configurees
      ? 'Manifeste NON signé : MAJ_CLE_PRIVEE n\'est pas définie alors qu\'une clé publique est configurée dans package.json. Les postes REFUSERONT cette mise à jour.'
      : 'Manifeste NON signé : MAJ_CLE_PRIVEE n\'est pas définie. Les postes ne contrôleront que l\'empreinte SHA-256 (voir docs/MISES-A-JOUR.md).';
    console.warn(`Attention : ${message}`);
    annotation('warning', 'Manifeste non signé', message);
    lignes.push(`- Signature : **aucune** — ${message}`);
  }
  resume(lignes);
  return m;
}

if (require.main === module) {
  try {
    principal(process.argv.slice(2));
  } catch (e) {
    console.error(`Erreur : ${e.message}`);
    annotation('error', 'Manifeste de mise à jour', e.message);
    process.exitCode = 1;
  }
}

module.exports = { manifeste, signerManifeste, lireClePrivee, nettoyerNotes };
