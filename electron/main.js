'use strict';
/**
 * Application de bureau Windows « GMAO SICAF » (Electron).
 *
 * - Aucun prérequis : le moteur Node.js est intégré à l'exécutable, aucune fenêtre CMD.
 * - Mode « serveur » : le serveur GMAO tourne DANS l'application (données dans
 *   %APPDATA%\GMAO SICAF\data ou un dossier choisi) ; avec le partage réseau, les autres
 *   postes s'y connectent (application en mode client ou navigateur).
 * - Mode « client » : l'application ouvre la GMAO hébergée sur un autre poste.
 * - Icône dans la zone de notification, démarrage avec Windows, instance unique.
 * - Mises à jour automatiques (GitHub Releases, dossier réseau ou adresse web) : l'installateur
 *   est téléchargé, vérifié (SHA-256) puis installé en silence, et l'application redémarre.
 */
const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, nativeImage, Notification, net } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Parametres } = require('./parametres');
const { creerGestionnaire } = require('./miseajour');
const { hashPassword, verifyPassword } = require('../server/auth');

const NOM = 'GMAO SICAF';
const ICONE = path.join(__dirname, 'icon.png');
const PAGE_DEMARRAGE = path.join(__dirname, 'demarrage.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const PKG = (() => { try { return require('../package.json'); } catch (e) { return {}; } })();
const DEPOT_DEFAUT = (PKG.gmao && PKG.gmao.depotMisesAJour) || '';
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const DEMARRAGE_CACHE = process.argv.includes('--cache');

let parametres = null;
let serveur = null;        // application GMAO intégrée (mode serveur)
let urlApplication = '';   // adresse chargée dans la fenêtre principale
let fenetre = null;        // fenêtre principale
let fenetreAssistant = null;
let tray = null;
let quitter = false;
let infoBulleMontree = false;
let majEnCours = false;
let minuterieMaj = null;
let assistantDeverrouille = false; // code du pôle informatique saisi pour la fenêtre de paramètres ouverte

// ----- Instance unique -----------------------------------------------------------------
const VERROU = app.requestSingleInstanceLock();
if (!VERROU) app.quit();
else app.on('second-instance', () => afficher());
app.setAppUserModelId('fr.sicaf.gmao');
// Marqueur « application de bureau » : le serveur GMAO refuse les navigateurs web (sauf autorisation du pôle informatique)
app.userAgentFallback = `${app.userAgentFallback || 'Mozilla/5.0'} GMAO-SICAF-Bureau/${app.getVersion()}`;

function journal(...a) { try { console.log(new Date().toISOString(), ...a); } catch (e) { /* ignore */ } }

function dossierDonnees() {
  const d = parametres.valeurs.serveur.dossierDonnees;
  return d ? path.resolve(d) : path.join(app.getPath('userData'), 'data');
}

/** Adresses IPv4 du poste (pour indiquer aux autres postes comment se connecter). */
function adressesReseau() {
  const out = [];
  for (const [nom, liste] of Object.entries(os.networkInterfaces())) {
    for (const i of liste || []) if (i.family === 'IPv4' && !i.internal) out.push({ interface: nom, adresse: i.address });
  }
  return out;
}

// ----- Serveur intégré -------------------------------------------------------------------
async function demarrerServeur() {
  const { createApp } = require('../server/server');
  const p = parametres.valeurs.serveur;
  const hote = p.partageReseau ? '0.0.0.0' : '127.0.0.1';
  serveur = createApp({ dataDir: dossierDonnees(), log: journal, bureau: true });
  let addr;
  try {
    addr = await serveur.start(p.port, hote);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE' && !p.partageReseau) {
      addr = await serveur.start(0, hote); // poste seul : n'importe quel port libre convient
    } else if (e && e.code === 'EADDRINUSE') {
      throw new Error(`Le port ${p.port} est déjà utilisé sur ce poste. Choisissez un autre port dans les paramètres de connexion.`);
    } else throw e;
  }
  urlApplication = `http://127.0.0.1:${addr.port}/`;
  journal('Serveur GMAO démarré', urlApplication, 'données :', dossierDonnees());
  return urlApplication;
}

async function arreterServeur() {
  if (!serveur) return;
  try { await serveur.stop(); } catch (e) { /* ignore */ }
  serveur = null;
}

/** Vérifie qu'un serveur GMAO répond à l'adresse donnée. */
async function testerServeur(url) {
  const { normaliserUrl } = require('./parametres');
  const u = normaliserUrl(url);
  if (!u) return { ok: false, message: 'Adresse invalide (exemple : http://srv-gmao:8585)' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await net.fetch(new URL('api/auth/infos', u).toString(), { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, message: `Le serveur a répondu ${r.status}` };
    const infos = await r.json();
    return { ok: true, url: u, societe: (infos.societe && infos.societe.nom) || '', version: infos.version || '' };
  } catch (e) {
    return { ok: false, message: 'Aucun serveur GMAO ne répond à cette adresse (poste éteint, pare-feu, adresse ou port incorrect).' };
  }
}

// ----- Fenêtres --------------------------------------------------------------------------
function origineAutorisee(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return path.normalize(decodeURIComponent(u.pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) === path.normalize(PAGE_DEMARRAGE);
    return !!urlApplication && u.origin === new URL(urlApplication).origin;
  } catch (e) { return false; }
}

function creerFenetrePrincipale(url) {
  const f = parametres.valeurs.fenetre;
  fenetre = new BrowserWindow({
    width: f.largeur, height: f.hauteur, minWidth: 1000, minHeight: 650, show: false,
    title: NOM, icon: ICONE, autoHideMenuBar: true, backgroundColor: '#f3f4f6',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (f.maximisee) fenetre.maximize();
  fenetre.once('ready-to-show', () => { if (!DEMARRAGE_CACHE) fenetre.show(); });
  fenetre.loadURL(url);

  // Fenêtres secondaires : impressions (about:blank) et pages de l'application ; liens externes → navigateur
  fenetre.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u === 'about:blank' || origineAutorisee(u)) {
      return { action: 'allow', overrideBrowserWindowOptions: { icon: ICONE, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } } };
    }
    if (/^(https?|mailto):/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  fenetre.webContents.on('will-navigate', (ev, u) => { if (!origineAutorisee(u)) { ev.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); } });
  fenetre.webContents.on('did-fail-load', (ev, code, description, u, principal) => {
    if (principal && code !== -3) afficherErreur(`Impossible d'ouvrir la GMAO (${description}).`);
  });
  // La caméra (scan des codes-barres) est autorisée pour l'application elle-même uniquement
  fenetre.webContents.session.setPermissionRequestHandler((wc, permission, rappel, details) => {
    const ok = ['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission) && origineAutorisee(details.requestingUrl || wc.getURL());
    rappel(ok);
  });

  fenetre.on('close', (ev) => {
    if (!fenetre.isMaximized()) {
      const [largeur, hauteur] = fenetre.getSize();
      parametres.enregistrer({ fenetre: { largeur, hauteur, maximisee: false } });
    } else parametres.enregistrer({ fenetre: { maximisee: true } });
    if (!quitter && garderEnArrierePlan()) {
      ev.preventDefault();
      fenetre.hide();
      if (!infoBulleMontree && Notification.isSupported()) {
        infoBulleMontree = true;
        new Notification({ title: NOM, body: 'La GMAO reste active dans la zone de notification (les autres postes peuvent continuer à travailler). Clic droit sur l\'icône › Quitter pour l\'arrêter.', icon: ICONE }).show();
      }
    }
  });
  fenetre.on('closed', () => { fenetre = null; });
  construireMenu();
}

/** En mode serveur partagé, fermer la fenêtre ne doit pas couper la GMAO des autres postes. */
function garderEnArrierePlan() {
  return parametres.valeurs.reduireDansZoneNotification && (parametres.valeurs.mode === 'serveur' && parametres.valeurs.serveur.partageReseau || DEMARRAGE_CACHE || parametres.valeurs.demarrerAvecWindows);
}

function ouvrirAssistant(erreur) {
  if (fenetreAssistant) { fenetreAssistant.show(); fenetreAssistant.focus(); return; }
  assistantDeverrouille = !parametres.valeurs.codeInformatique; // premier lancement : pas encore de code
  fenetreAssistant = new BrowserWindow({
    width: 860, height: 760, minWidth: 700, minHeight: 600, title: `${NOM} — Paramètres de connexion`, icon: ICONE, autoHideMenuBar: true, backgroundColor: '#0f172a',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  fenetreAssistant.loadFile(PAGE_DEMARRAGE, { query: erreur ? { erreur } : {} });
  fenetreAssistant.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  fenetreAssistant.on('closed', () => {
    fenetreAssistant = null;
    assistantDeverrouille = false;
    if (!fenetre && !quitter && !parametres.valeurs.configure) { quitter = true; app.quit(); }
  });
}

function afficherErreur(message) {
  if (fenetre) { fenetre.destroy(); fenetre = null; }
  ouvrirAssistant(message);
}

function afficher() {
  if (fenetre) { if (fenetre.isMinimized()) fenetre.restore(); fenetre.show(); fenetre.focus(); return; }
  if (fenetreAssistant) { fenetreAssistant.show(); fenetreAssistant.focus(); return; }
  if (urlApplication) creerFenetrePrincipale(urlApplication);
}

// ----- Démarrage selon le mode -------------------------------------------------------------
async function lancer() {
  const p = parametres.valeurs;
  if (!p.configure) return ouvrirAssistant();
  try {
    if (p.mode === 'client') {
      const t = await testerServeur(p.client.url);
      if (!t.ok) return afficherErreur(`Serveur GMAO injoignable à l'adresse ${p.client.url} : ${t.message}`);
      urlApplication = t.url;
    } else {
      await demarrerServeur();
    }
    creerFenetrePrincipale(urlApplication);
    construireTray();
    appliquerDemarrageWindows();
    programmerMisesAJour();
  } catch (e) {
    journal('Erreur au démarrage', e);
    afficherErreur(e.message || String(e));
  }
}

async function redemarrer() {
  quitter = true;
  await arreterServeur();
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--cache') });
  app.exit(0);
}

async function quitterApplication() {
  if (parametres.valeurs.mode === 'serveur' && parametres.valeurs.serveur.partageReseau) {
    const r = await dialog.showMessageBox(fenetre || undefined, { type: 'question', title: NOM, message: 'Arrêter la GMAO ?', detail: 'Ce poste héberge la GMAO pour le réseau : les autres postes ne pourront plus y accéder tant qu\'elle ne sera pas relancée.', buttons: ['Arrêter', 'Annuler'], defaultId: 1, cancelId: 1 });
    if (r.response !== 0) return;
  }
  quitter = true;
  await arreterServeur();
  app.quit();
}

function appliquerDemarrageWindows() {
  if (process.platform !== 'win32') return;
  try {
    const opts = { openAtLogin: parametres.valeurs.demarrerAvecWindows, args: ['--cache'] };
    if (PORTABLE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
    app.setLoginItemSettings(opts);
  } catch (e) { journal('Démarrage avec Windows indisponible', e.message); }
}

// ----- Zone de notification et menu ----------------------------------------------------------
function texteAcces() {
  const p = parametres.valeurs;
  if (p.mode === 'client') return `Connecté à ${p.client.url}`;
  if (!p.serveur.partageReseau) return 'Serveur local (ce poste uniquement)';
  const port = serveur && serveur.server.address() ? serveur.server.address().port : p.serveur.port;
  const a = adressesReseau()[0];
  return a ? `Accès réseau : http://${a.adresse}:${port}/` : `Accès réseau sur le port ${port}`;
}

function menuModele() {
  const p = parametres.valeurs;
  const port = serveur && serveur.server.address() ? serveur.server.address().port : p.serveur.port;
  return [
    { label: 'Ouvrir la GMAO', click: () => afficher() },
    { label: texteAcces(), enabled: false },
    p.mode === 'serveur' && p.serveur.partageReseau ? { label: 'Copier l\'adresse réseau', click: () => { const a = adressesReseau()[0]; if (a) require('electron').clipboard.writeText(`http://${a.adresse}:${port}/`); } } : null,
    { type: 'separator' },
    { label: 'Paramètres de connexion (pôle informatique)…', click: () => ouvrirAssistant() },
    { label: 'Rechercher les mises à jour', click: () => verifierMisesAJour(true) },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quitter', click: () => quitterApplication() },
  ].filter(Boolean);
}

function construireTray() {
  const image = nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 });
  if (!tray) {
    tray = new Tray(image);
    tray.on('click', () => afficher());
    tray.on('double-click', () => afficher());
  }
  tray.setToolTip(`${NOM} — ${texteAcces()}`);
  tray.setContextMenu(Menu.buildFromTemplate(menuModele()));
}

function construireMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fichier', submenu: [
      { label: 'Actualiser', accelerator: 'F5', click: () => fenetre && fenetre.reload() },
      { label: 'Imprimer…', accelerator: 'Ctrl+P', click: () => fenetre && fenetre.webContents.print() },
      { type: 'separator' },
      { label: 'Paramètres de connexion (pôle informatique)…', click: () => ouvrirAssistant() },
      { type: 'separator' },
      { label: 'Fermer la fenêtre', accelerator: 'Ctrl+W', click: () => fenetre && fenetre.close() },
      { label: 'Quitter', accelerator: 'Ctrl+Q', click: () => quitterApplication() },
    ].filter(Boolean) },
    { label: 'Affichage', submenu: [
      { role: 'zoomIn', label: 'Zoom +' }, { role: 'zoomOut', label: 'Zoom -' }, { role: 'resetZoom', label: 'Zoom normal' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Plein écran' },
      app.isPackaged ? null : { role: 'toggleDevTools', label: 'Outils de développement' },
    ].filter(Boolean) },
    { label: 'Aide', submenu: [
      { label: 'Rechercher les mises à jour', click: () => verifierMisesAJour(true) },
      { label: 'À propos', click: () => dialog.showMessageBox(fenetre || undefined, { type: 'info', title: 'À propos', message: NOM, detail: `Version ${app.getVersion()}\n${texteAcces()}${parametres.valeurs.mode === 'serveur' ? `\nDonnées : ${dossierDonnees()}` : ''}` }) },
    ] },
  ]));
}

// ----- Mises à jour ----------------------------------------------------------------------------
function gestionnaireMaj() {
  const m = parametres.valeurs.misesAJour;
  return creerGestionnaire({
    versionActuelle: app.getVersion(),
    config: { source: m.source, depot: m.depot || DEPOT_DEFAUT, chemin: m.chemin, url: m.url },
    fetch: (u, o) => net.fetch(u, o),
    dossierTelechargement: path.join(app.getPath('temp'), 'gmao-sicaf-maj'),
    agent: `GMAO-SICAF/${app.getVersion()}`,
  });
}

function programmerMisesAJour() {
  if (minuterieMaj) clearInterval(minuterieMaj);
  if (!app.isPackaged || !parametres.valeurs.misesAJour.automatique || parametres.valeurs.misesAJour.source === 'aucune') return;
  setTimeout(() => verifierMisesAJour(false), 30 * 1000);
  minuterieMaj = setInterval(() => verifierMisesAJour(false), 6 * 60 * 60 * 1000);
}

/** @param {boolean} manuel  true : l'utilisateur a demandé la vérification (messages même sans mise à jour). */
async function verifierMisesAJour(manuel) {
  if (majEnCours) return { enCours: true };
  majEnCours = true;
  const parent = fenetre || fenetreAssistant || undefined;
  try {
    if (!app.isPackaged && !manuel) return { disponible: false };
    const g = gestionnaireMaj();
    const info = await g.verifier();
    if (!info.disponible) {
      if (manuel) await dialog.showMessageBox(parent, { type: 'info', title: NOM, message: 'Votre application est à jour.', detail: `Version installée : ${app.getVersion()}${info.version ? `\nDernière version publiée : ${info.version}` : ''}${info.raison ? `\n${info.raison}` : ''}` });
      return info;
    }
    if (!manuel && parametres.valeurs.misesAJour.ignorerVersion === info.version) return info;
    const partage = parametres.valeurs.mode === 'serveur' && parametres.valeurs.serveur.partageReseau;
    const r = await dialog.showMessageBox(parent, {
      type: 'info', title: `${NOM} — mise à jour`, message: `Une nouvelle version est disponible : ${info.version}`,
      detail: `Version installée : ${app.getVersion()}${info.notes ? `\n\nNouveautés :\n${info.notes.slice(0, 1500)}` : ''}${partage ? '\n\nCe poste héberge la GMAO pour le réseau : l\'accès sera interrompu une minute pendant l\'installation.' : ''}`,
      buttons: PORTABLE ? ['Télécharger', 'Plus tard', 'Ignorer cette version'] : ['Installer maintenant', 'Plus tard', 'Ignorer cette version'], defaultId: 0, cancelId: 1,
    });
    if (r.response === 2) { parametres.enregistrer({ misesAJour: { ignorerVersion: info.version } }); return info; }
    if (r.response !== 0) return info;
    if (PORTABLE) { shell.openExternal(info.page || info.telechargement.url || ''); return info; }
    const fichier = await g.telecharger(info, (x) => { if (fenetre) fenetre.setProgressBar(x); });
    if (fenetre) fenetre.setProgressBar(-1);
    // Installation silencieuse dans le même dossier, puis relance automatique de l'application
    quitter = true;
    await arreterServeur();
    spawn(fichier, ['/S', '--force-run', '--updated'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    return info;
  } catch (e) {
    if (fenetre) fenetre.setProgressBar(-1);
    journal('Mise à jour : ', e.message);
    if (manuel) await dialog.showMessageBox(parent, { type: 'warning', title: NOM, message: 'Impossible de vérifier ou d\'installer la mise à jour.', detail: e.message });
    return { erreur: e.message };
  } finally {
    majEnCours = false;
  }
}

// ----- Pont avec les pages (preload.js) -----------------------------------------------------
function expediteurAutorise(ev) {
  const url = (ev.senderFrame && ev.senderFrame.url) || '';
  return origineAutorisee(url);
}
function gerer(canal, fn) {
  ipcMain.handle(canal, async (ev, ...args) => {
    if (!expediteurAutorise(ev)) throw new Error('Appel non autorisé');
    return fn(ev, ...args);
  });
}

/** Les paramètres de connexion ne se modifient qu'après saisie du code du pôle informatique. */
function exigerDeverrouillage() {
  if (parametres.valeurs.codeInformatique && !assistantDeverrouille) throw new Error('Code du pôle informatique requis');
}

function enregistrerIpc() {
  gerer('bureau:etat-verrou', () => ({ codeDefini: !!parametres.valeurs.codeInformatique, deverrouille: assistantDeverrouille }));
  gerer('bureau:deverrouiller', async (ev, code) => {
    if (!parametres.valeurs.codeInformatique) { assistantDeverrouille = true; return { ok: true }; }
    await new Promise((r) => setTimeout(r, 400)); // freine les essais successifs
    assistantDeverrouille = verifyPassword(String(code || ''), parametres.valeurs.codeInformatique);
    return { ok: assistantDeverrouille, message: assistantDeverrouille ? '' : 'Code incorrect' };
  });
  gerer('bureau:reessayer', () => { if (fenetreAssistant) { const f = fenetreAssistant; fenetreAssistant = null; f.destroy(); } lancer(); return true; });
  gerer('bureau:infos', () => ({
    version: app.getVersion(), mode: parametres.valeurs.mode, url: urlApplication, portable: PORTABLE,
    dossierDonnees: parametres.valeurs.mode === 'serveur' ? dossierDonnees() : '', dossierDonneesDefaut: path.join(app.getPath('userData'), 'data'),
    adresses: adressesReseau(), port: serveur && serveur.server.address() ? serveur.server.address().port : parametres.valeurs.serveur.port,
    nomPoste: os.hostname(), acces: texteAcces(),
  }));
  gerer('bureau:parametres', () => {
    const v = JSON.parse(JSON.stringify(parametres.valeurs));
    v.codeInformatiqueDefini = !!v.codeInformatique;
    delete v.codeInformatique;
    if (v.codeInformatiqueDefini && !assistantDeverrouille) return { verrouille: true, configure: v.configure, mode: v.mode, codeInformatiqueDefini: true };
    return v;
  });
  gerer('bureau:enregistrer', async (ev, nouvelles) => {
    exigerDeverrouillage();
    const avant = JSON.stringify([parametres.valeurs.mode, parametres.valeurs.serveur, parametres.valeurs.client]);
    const n = Object.assign({}, nouvelles || {}, { configure: true });
    // Code du pôle informatique : obligatoire à la première configuration, modifiable ensuite
    delete n.codeInformatique;
    const nouveauCode = nouvelles && typeof nouvelles.nouveauCodeInformatique === 'string' ? nouvelles.nouveauCodeInformatique : '';
    if (nouveauCode) {
      if (nouveauCode.length < 6) return { ok: false, message: 'Le code du pôle informatique doit contenir au moins 6 caractères' };
      n.codeInformatique = hashPassword(nouveauCode);
    } else if (!parametres.valeurs.codeInformatique) {
      return { ok: false, message: 'Définissez le code du pôle informatique (il protège ces paramètres)' };
    }
    if (n.mode === 'client') {
      const t = await testerServeur(n.client && n.client.url);
      if (!t.ok) return { ok: false, message: t.message };
      n.client = { url: t.url };
    }
    const etaitConfigure = parametres.valeurs.configure;
    parametres.enregistrer(n);
    appliquerDemarrageWindows();
    const apres = JSON.stringify([parametres.valeurs.mode, parametres.valeurs.serveur, parametres.valeurs.client]);
    if (!etaitConfigure || !urlApplication) {
      if (fenetreAssistant) { const f = fenetreAssistant; fenetreAssistant = null; f.destroy(); }
      lancer();
    } else if (avant !== apres) {
      setTimeout(() => redemarrer(), 300);
    } else {
      programmerMisesAJour();
      if (tray) construireTray();
      if (fenetreAssistant) { const f = fenetreAssistant; fenetreAssistant = null; f.destroy(); }
      afficher();
    }
    return { ok: true, redemarrage: etaitConfigure && avant !== apres };
  });
  gerer('bureau:tester-serveur', (ev, url) => testerServeur(url));
  gerer('bureau:choisir-dossier', async () => {
    exigerDeverrouillage();
    const r = await dialog.showOpenDialog(fenetreAssistant || fenetre || undefined, { title: 'Dossier des données de la GMAO', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });
  gerer('bureau:verifier-maj', () => verifierMisesAJour(true));
  gerer('bureau:ouvrir-parametres', () => { ouvrirAssistant(); return true; });
  gerer('bureau:ouvrir-dossier-donnees', () => { exigerDeverrouillage(); return parametres.valeurs.mode === 'serveur' ? shell.openPath(dossierDonnees()) : ''; });
  gerer('bureau:fermer-assistant', () => { if (fenetreAssistant) fenetreAssistant.close(); return true; });
  gerer('bureau:quitter', () => quitterApplication());
}

// ----- Durcissement : aucune vue intégrée (webview) ni navigation hors de l'application -------
app.on('web-contents-created', (ev, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e, u) => { if (!origineAutorisee(u) && u !== 'about:blank') e.preventDefault(); });
});

// ----- Cycle de vie ---------------------------------------------------------------------------
app.whenReady().then(() => {
  if (!VERROU) return; // une autre instance est déjà ouverte : elle a été mise au premier plan
  parametres = new Parametres(app.getPath('userData'));
  enregistrerIpc();
  lancer();
});

app.on('window-all-closed', () => {
  // L'application reste dans la zone de notification si elle sert le réseau ; sinon elle s'arrête.
  if (quitter || !garderEnArrierePlan()) { quitter = true; arreterServeur().finally(() => app.quit()); }
});

app.on('before-quit', () => { quitter = true; });
app.on('will-quit', () => { if (serveur) { try { serveur.db.saveNow(); } catch (e) { /* ignore */ } } });

module.exports = { garderEnArrierePlan, adressesReseau };
