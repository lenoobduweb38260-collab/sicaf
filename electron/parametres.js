'use strict';
/**
 * Paramètres de l'application de bureau (fichier parametres.json dans le dossier utilisateur
 * de l'application, ex. %APPDATA%\GMAO SICAF\parametres.json).
 *
 * Deux modes :
 *  - « serveur » : ce PC héberge la base de données et le serveur GMAO (intégré à l'application) ;
 *    avec le partage réseau, les autres postes s'y connectent.
 *  - « client »  : ce PC se connecte au serveur GMAO d'un autre poste (adresse https://serveur:8585).
 *    L'empreinte du certificat du serveur, confirmée par le pôle informatique à la première
 *    connexion chiffrée, est enregistrée ici : toute empreinte différente bloque ensuite la connexion.
 *
 * Le fichier contient l'empreinte (scrypt) du code du pôle informatique et le compteur de ses essais
 * incorrects (un redémarrage ne lève pas un blocage) : il est écrit avec des droits restreints à
 * l'utilisateur courant.
 *
 * Module sans dépendance à Electron : testable avec node:test.
 */
const fs = require('fs');
const path = require('path');
const { normaliserEmpreinte } = require('../server/tls');

const DEFAUTS = {
  configure: false,            // l'assistant de premier lancement a-t-il été validé ?
  codeInformatique: '',        // empreinte (scrypt) du code du pôle informatique protégeant ces paramètres
  mode: 'serveur',             // 'serveur' | 'client'
  serveur: {
    port: 8585,
    partageReseau: false,      // écoute sur toutes les interfaces (0.0.0.0) pour les autres postes
    dossierDonnees: '',        // vide = dossier par défaut (%APPDATA%\GMAO SICAF\data)
  },
  client: {
    url: '',                   // ex. https://srv-gmao:8585/
    empreinte: '',             // empreinte SHA-256 du certificat du serveur confirmée (« AB:CD:… »)
    empreinteCle: '',          // empreinte SHA-256 de sa clé publique (certificat renouvelé par le même serveur)
  },
  demarrerAvecWindows: false,
  reduireDansZoneNotification: true, // fermer la fenêtre garde l'application active (serveur partagé)
  misesAJour: {
    automatique: true,
    source: 'github',          // 'github' | 'dossier' | 'url' | 'aucune'
    depot: '',                 // ex. proprietaire/depot (défaut : package.json › gmao.depotMisesAJour)
    chemin: '',                // dossier réseau contenant latest.json + l'installateur
    url: '',                   // adresse web contenant latest.json + l'installateur
    ignorerVersion: '',        // version que l'utilisateur a choisi d'ignorer
  },
  fenetre: { largeur: 1400, hauteur: 900, maximisee: false },
  verrouCode: {
    echecs: 0,                 // essais incorrects consécutifs du code du pôle informatique
    bloqueJusqua: '',          // fin du blocage de la saisie du code (date ISO), vide sans blocage
  },
};

function cloner(o) { return JSON.parse(JSON.stringify(o)); }

function entier(v, min, max, defaut) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : defaut;
}

/** Normalise une adresse de serveur saisie par l'utilisateur (« srv-gmao:8585 » → « http://srv-gmao:8585/ »). */
function normaliserUrl(saisie) {
  let s = String(saisie || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return ''; // autre protocole (ftp://, file://…)
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return ''; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return '';
  u.hash = ''; u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

/** Valide et complète des paramètres (valeurs inconnues ignorées). */
function normaliser(p) {
  const d = cloner(DEFAUTS);
  const src = p && typeof p === 'object' ? p : {};
  const out = d;
  out.configure = !!src.configure;
  out.codeInformatique = /^scrypt\$[a-f0-9]+\$[a-f0-9]+$/.test(src.codeInformatique || '') ? src.codeInformatique : '';
  out.mode = src.mode === 'client' ? 'client' : 'serveur';
  const s = src.serveur || {};
  out.serveur.port = entier(s.port, 1, 65535, d.serveur.port);
  out.serveur.partageReseau = !!s.partageReseau;
  out.serveur.dossierDonnees = typeof s.dossierDonnees === 'string' ? s.dossierDonnees.trim().slice(0, 500) : '';
  const c = src.client || {};
  out.client.url = normaliserUrl(c.url);
  out.client.empreinte = normaliserEmpreinte(c.empreinte);
  out.client.empreinteCle = normaliserEmpreinte(c.empreinteCle);
  out.demarrerAvecWindows = !!src.demarrerAvecWindows;
  out.reduireDansZoneNotification = src.reduireDansZoneNotification === undefined ? d.reduireDansZoneNotification : !!src.reduireDansZoneNotification;
  const m = src.misesAJour || {};
  out.misesAJour.automatique = m.automatique === undefined ? true : !!m.automatique;
  out.misesAJour.source = ['github', 'dossier', 'url', 'aucune'].includes(m.source) ? m.source : 'github';
  out.misesAJour.depot = /^[\w.-]+\/[\w.-]+$/.test(m.depot || '') ? m.depot : '';
  out.misesAJour.chemin = typeof m.chemin === 'string' ? m.chemin.trim().slice(0, 500) : '';
  out.misesAJour.url = m.url ? normaliserUrl(m.url) : '';
  out.misesAJour.ignorerVersion = typeof m.ignorerVersion === 'string' ? m.ignorerVersion.slice(0, 40) : '';
  const f = src.fenetre || {};
  out.fenetre.largeur = entier(f.largeur, 800, 10000, d.fenetre.largeur);
  out.fenetre.hauteur = entier(f.hauteur, 600, 10000, d.fenetre.hauteur);
  out.fenetre.maximisee = !!f.maximisee;
  const v = src.verrouCode || {};
  out.verrouCode.echecs = entier(v.echecs, 0, 1000, 0);
  const fin = typeof v.bloqueJusqua === 'string' ? Date.parse(v.bloqueJusqua) : NaN;
  out.verrouCode.bloqueJusqua = Number.isFinite(fin) ? new Date(fin).toISOString() : '';
  // Un mode client sans adresse n'est pas utilisable : retour à l'assistant
  if (out.mode === 'client' && !out.client.url) out.configure = false;
  return out;
}

class Parametres {
  constructor(dossier) {
    this.fichier = path.join(dossier, 'parametres.json');
    this.valeurs = this.lire();
  }

  lire() {
    try {
      if (fs.existsSync(this.fichier)) return normaliser(JSON.parse(fs.readFileSync(this.fichier, 'utf8')));
    } catch (e) { /* fichier illisible : valeurs par défaut */ }
    return normaliser({});
  }

  enregistrer(nouvelles) {
    this.valeurs = normaliser(Object.assign({}, this.valeurs, nouvelles || {}, {
      serveur: Object.assign({}, this.valeurs.serveur, (nouvelles || {}).serveur || {}),
      client: Object.assign({}, this.valeurs.client, (nouvelles || {}).client || {}),
      misesAJour: Object.assign({}, this.valeurs.misesAJour, (nouvelles || {}).misesAJour || {}),
      fenetre: Object.assign({}, this.valeurs.fenetre, (nouvelles || {}).fenetre || {}),
    }));
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    const tmp = this.fichier + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.valeurs, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.fichier);
    try { fs.chmodSync(this.fichier, 0o600); } catch (e) { /* système de fichiers sans droits POSIX */ }
    return this.valeurs;
  }
}

module.exports = { Parametres, DEFAUTS, normaliser, normaliserUrl };
