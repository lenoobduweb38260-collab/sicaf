#!/usr/bin/env node
'use strict';
/**
 * Point d'entrée : `node server/index.js [--port 8585] [--host 127.0.0.1] [--data ./data] [--open]`
 *
 *   --open      ouvre l'application dans Microsoft Edge en mode « application »
 *               (fenêtre sans barre d'adresse) ou, à défaut, dans le navigateur par défaut.
 *   --host 0.0.0.0  autorise l'accès depuis les autres postes du réseau local.
 */
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('./server');

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

  const app = createApp({ dataDir });
  const addr = await app.start(port, host);
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}/`;
  console.log('='.repeat(60));
  console.log('  GMAO SICAF v' + app.ctx.version);
  console.log('  Application disponible sur : ' + url);
  console.log('  Données : ' + app.db.dataDir);
  if (host === '0.0.0.0') console.log('  Accès réseau local activé (http://<ip-du-poste>:' + addr.port + '/)');
  console.log('  Compte initial : admin / admin (à changer à la première connexion)');
  console.log('  Ctrl+C pour arrêter.');
  console.log('='.repeat(60));
  if (args.open) ouvrirNavigateur(url);

  const arret = async () => {
    console.log('\nArrêt du serveur, sauvegarde des données…');
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

module.exports = { main, parseArgs, ouvrirNavigateur };
