'use strict';
/**
 * Pont sécurisé entre les pages (assistant de connexion, GMAO) et l'application de bureau.
 * Expose window.gmaoBureau (objet figé). Chaque appel est revérifié côté processus principal :
 * origine de la page appelante, code du pôle informatique, validité des données.
 * Les pages de la GMAO n'ont accès qu'à infos, verifierMisesAJour et ouvrirParametres ;
 * les autres fonctions sont réservées à l'assistant de connexion.
 */
const { contextBridge, ipcRenderer } = require('electron');

const texte = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

contextBridge.exposeInMainWorld('gmaoBureau', Object.freeze({
  estBureau: true,
  infos: () => ipcRenderer.invoke('bureau:infos'),
  parametres: () => ipcRenderer.invoke('bureau:parametres'),
  enregistrer: (p) => ipcRenderer.invoke('bureau:enregistrer', p && typeof p === 'object' ? p : {}),
  testerServeur: (url) => ipcRenderer.invoke('bureau:tester-serveur', texte(url, 500)),
  choisirDossier: () => ipcRenderer.invoke('bureau:choisir-dossier'),
  verifierMisesAJour: () => ipcRenderer.invoke('bureau:verifier-maj'),
  ouvrirParametres: () => ipcRenderer.invoke('bureau:ouvrir-parametres'),
  ouvrirDossierDonnees: () => ipcRenderer.invoke('bureau:ouvrir-dossier-donnees'),
  fermerAssistant: () => ipcRenderer.invoke('bureau:fermer-assistant'),
  quitter: () => ipcRenderer.invoke('bureau:quitter'),
  etatVerrou: () => ipcRenderer.invoke('bureau:etat-verrou'),
  deverrouiller: (code) => ipcRenderer.invoke('bureau:deverrouiller', texte(code, 200)),
  reessayer: () => ipcRenderer.invoke('bureau:reessayer'),
}));
