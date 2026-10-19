#!/usr/bin/env node
'use strict';
/**
 * Point d'entrée : `node server/index.js [--port 8585] [--host 127.0.0.1] [--data ./data] [--open] [--https]`
 *
 *   --open      ouvre l'application dans Microsoft Edge en mode « application »
 *               (fenêtre sans barre d'adresse) ou, à défaut, dans le navigateur par défaut.
 *   --host 0.0.0.0  autorise l'accès depuis les autres postes du réseau local.
 *   --https     sert l'application en HTTPS avec le certificat du poste (<données>/tls, créé ou renouvelé
 *               automatiquement) ; le HTTP en clair sur le même port est redirigé ; l'empreinte du certificat,
 *               à confirmer sur les postes clients, est affichée au démarrage.
 *   --reinitialiser-double-auth <identifiant>  (secours, serveur arrêté) vide la double authentification et les
 *               codes de secours du compte indiqué, journalise l'opération, puis quitte sans démarrer le serveur.
 */
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('./server');

/** Dossier des données, comme le résout createApp() sans option. */
function dossierDonnees(args) {
  return args.data ? path.resolve(args.data) : (process.env.GMAO_DATA_DIR || path.join(__dirname, '..', 'data'));
}

/**
 * Secours en ligne de commande : vide la double authentification (secret, activation en cours) et les codes de
 * secours d'un compte, sans démarrer le serveur. Opération journalisée (auteur « Poste serveur »).
 */
async function reinitialiserDoubleAuth(dataDir, login) {
  const identifiant = String(login || '').trim();
  if (!identifiant) throw new Error('Indiquez l\'identifiant du compte : --reinitialiser-double-auth <identifiant>');
  const app = createApp({ dataDir, log: () => {} });
  try {
    const u = app.db.findOne('users', (x) => String(x.login || '').toLowerCase() === identifiant.toLowerCase());
    if (!u) throw new Error(`Compte « ${identifiant} » introuvable`);
    const avant = u.deuxFacteurs || {};
    if (!avant.actif && !avant.secretEnAttente) return { login: u.login, deja: true };
    app.db.update('users', u.id, { deuxFacteurs: { actif: false, reinitialiseLe: new Date().toISOString(), reinitialisePar: null }, codesSecours: [] });
    if (app.ctx.deuxFacteurs) app.ctx.deuxFacteurs.annulerAttentes(u.id);
    app.ctx.audit({ user: { id: null, login: 'serveur', nom: 'Poste serveur', prenom: '' } }, 'reinitialisation_double_auth', 'users', u.id, `Utilisateur ${u.login} — réinitialisation de secours depuis la ligne de commande du poste serveur${avant.actif ? '' : ' (activation en cours annulée)'}`, { notifier: false });
    app.ctx.notify(u.id, { titre: 'Double authentification réinitialisée', message: 'Le pôle informatique a réinitialisé votre double authentification depuis le poste serveur. Vous pouvez la configurer de nouveau depuis le menu de votre compte › Double authentification.', lien: '', type: 'alerte' });
    return { login: u.login, deja: false };
  } finally { await app.stop(); }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
    }
  }
  return out;
}

function ouvrirNavigateur(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // Edge en mode application (fenêtre dédiée, sans onglets). Repli : navigateur par défaut.
      const edge = [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].find((p) => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
      if (edge) {
        spawn(edge, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log('Impossible d\'ouvrir le navigateur automatiquement :', e.message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.GMAO_PORT || 8585);
  const host = args.host || process.env.GMAO_HOST || '127.0.0.1';
  const dataDir = args.data ? path.resolve(args.data) : undefined;

  if (args['reinitialiser-double-auth'] !== undefined) {
    const r = await reinitialiserDoubleAuth(dossierDonnees(args), args['reinitialiser-double-auth'] === true ? '' : args['reinitialiser-double-auth']);
    console.log(r.deja ? `Compte ${r.login} : aucune double authentification configurée, rien à réinitialiser.` : `Compte ${r.login} : double authentification réinitialisée (codes de secours effacés, opération journalisée).`);
    return;
  }

  const https = !!args.https;
  let certificat = null;
  if (https) certificat = require('./tls').chargerOuCreer(dossierDonnees(args), { log: (...a) => console.log(...a) });
  const app = createApp(https ? { dataDir, tls: { key: certificat.cle, cert: certificat.certificat } } : { dataDir });
  let ecoute = null;
  let addr;
  if (https) { ecoute = await require('./tls').ecouterMixte(app.server, port, host); addr = ecoute.adresse; } else addr = await app.start(port, host);
  const proto = https ? 'https' : 'http';
  const url = `${proto}://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}/`;
  console.log('='.repeat(60));
  console.log('  GMAO SICAF v' + app.ctx.version);
  console.log('  Application disponible sur : ' + url);
  console.log('  Données : ' + app.db.dataDir);
  if (host === '0.0.0.0') console.log(`  Accès réseau local activé (${proto}://<ip-du-poste>:${addr.port}/)`);
  if (https) {
    console.log('  Connexion chiffrée (HTTPS) ; le HTTP en clair sur ce port est redirigé.');
    console.log('  Empreinte du certificat (à confirmer sur chaque poste client) : ' + certificat.empreinte);
    if (certificat.regenere) console.log('  Certificat ' + (certificat.raison || 'créé') + ' dans ' + certificat.dossier);
  }
  console.log('  Compte initial : admin / admin (à changer à la première connexion)');
  console.log('  Ctrl+C pour arrêter.');
  console.log('='.repeat(60));
  if (args.open) ouvrirNavigateur(url);

  const arret = async () => {
    console.log('\nArrêt du serveur, sauvegarde des données…');
    if (ecoute) await ecoute.fermer();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', arret);
  process.on('SIGTERM', arret);
}

if (require.main === module) {
  main().catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`Le port est déjà utilisé. L'application est peut-être déjà lancée. Utilisez --port <autre port>.`);
    } else {
      console.error('Erreur au démarrage :', e);
    }
    process.exit(1);
  });
}

module.exports = { main, parseArgs, ouvrirNavigateur, reinitialiserDoubleAuth, dossierDonnees };
