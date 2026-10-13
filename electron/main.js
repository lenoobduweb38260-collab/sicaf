'use strict';
/**
 * Enveloppe Electron : démarre le serveur GMAO dans le processus principal
 * et ouvre l'interface dans une fenêtre native Windows.
 * Les données sont stockées dans %APPDATA%\GMAO SICAF\data.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const { createApp } = require('../server/server');

let serveur = null;
let fenetre = null;

async function demarrerServeur() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  serveur = createApp({ dataDir, log: (...a) => console.log(...a) });
  const addr = await serveur.start(0, '127.0.0.1');
  return `http://127.0.0.1:${addr.port}/`;
}

function creerFenetre(url) {
  fenetre = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    title: 'GMAO SICAF',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Fichier', submenu: [
      { label: 'Recharger', accelerator: 'F5', click: () => fenetre.reload() },
      { label: 'Ouvrir le dossier des données', click: () => shell.openPath(serveur.db.dataDir) },
      { type: 'separator' },
      { label: 'Quitter', accelerator: 'Alt+F4', role: 'quit' },
    ] },
    { label: 'Affichage', submenu: [{ role: 'zoomIn', label: 'Zoom +' }, { role: 'zoomOut', label: 'Zoom -' }, { role: 'resetZoom', label: 'Zoom normal' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Plein écran' }, { role: 'toggleDevTools', label: 'Outils de développement' }] },
    { label: 'Aide', submenu: [{ label: 'À propos', click: () => dialog.showMessageBox(fenetre, { type: 'info', title: 'À propos', message: 'GMAO SICAF', detail: `Version ${app.getVersion()}\nDonnées : ${serveur.db.dataDir}` }) }] },
  ]);
  Menu.setApplicationMenu(menu);
  fenetre.loadURL(url);
  fenetre.webContents.setWindowOpenHandler(({ url: u }) => {
    // Les impressions ouvrent une fenêtre secondaire ; les liens externes vont dans le navigateur.
    if (u === 'about:blank' || u.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(u);
    return { action: 'deny' };
  });
  fenetre.on('closed', () => { fenetre = null; });
}

app.whenReady().then(async () => {
  try {
    const url = await demarrerServeur();
    creerFenetre(url);
  } catch (e) {
    dialog.showErrorBox('GMAO SICAF', 'Impossible de démarrer le serveur : ' + e.message);
    app.quit();
  }
});

app.on('window-all-closed', async () => {
  if (serveur) { try { await serveur.stop(); } catch (e) { /* ignore */ } }
  app.quit();
});
