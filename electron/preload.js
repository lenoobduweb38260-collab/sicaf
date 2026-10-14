'use strict';
/**
 * Pont sécurisé entre les pages (assistant de connexion, GMAO) et l'application de bureau.
 * Expose window.gmaoBureau ; chaque appel est revérifié côté processus principal (origine autorisée).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gmaoBureau', {
  estBureau: true,
  infos: () => ipcRenderer.invoke('bureau:infos'),
  parametres: () => ipcRenderer.invoke('bureau:parametres'),
  enregistrer: (p) => ipcRenderer.invoke('bureau:enregistrer', p),
  testerServeur: (url) => ipcRenderer.invoke('bureau:tester-serveur', url),
  choisirDossier: () => ipcRenderer.invoke('bureau:choisir-dossier'),
  verifierMisesAJour: () => ipcRenderer.invoke('bureau:verifier-maj'),
  ouvrirParametres: () => ipcRenderer.invoke('bureau:ouvrir-parametres'),
  ouvrirDossierDonnees: () => ipcRenderer.invoke('bureau:ouvrir-dossier-donnees'),
  fermerAssistant: () => ipcRenderer.invoke('bureau:fermer-assistant'),
  quitter: () => ipcRenderer.invoke('bureau:quitter'),
  etatVerrou: () => ipcRenderer.invoke('bureau:etat-verrou'),
  deverrouiller: (code) => ipcRenderer.invoke('bureau:deverrouiller', code),
  reessayer: () => ipcRenderer.invoke('bureau:reessayer'),
});
