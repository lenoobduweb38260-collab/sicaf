'use strict';
/**
 * Étape « afterPack » d'electron-builder : verrouille l'exécutable Windows avec les fusibles Electron.
 *  - exécution comme Node.js (ELECTRON_RUN_AS_NODE) désactivée ;
 *  - variable NODE_OPTIONS et options --inspect ignorées (pas d'injection de code au lancement) ;
 *  - application chargée uniquement depuis l'archive app.asar ;
 *  - cookies chiffrés sur le disque (DPAPI Windows).
 */
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

module.exports = async function fusibles(contexte) {
  if (contexte.electronPlatformName !== 'win32') return;
  const exe = path.join(contexte.appOutDir, `${contexte.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  console.log(`  • fusibles Electron appliqués  fichier=${exe}`);
};
