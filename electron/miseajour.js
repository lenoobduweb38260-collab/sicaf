'use strict';
/**
 * Mises à jour automatiques de l'application de bureau (sans dépendance externe).
 *
 * Sources possibles :
 *  - github  : dernière « Release » du dépôt (API publique) contenant `latest.json` + l'installateur ;
 *  - dossier : dossier local ou partage réseau (\\NAS\gmao\mises-a-jour) contenant `latest.json` + l'installateur ;
 *  - url     : adresse web contenant `latest.json` + l'installateur.
 *
 * Format de latest.json (produit par scripts/manifeste-maj.js lors de la construction) :
 *   { "version": "1.0.42", "fichier": "GMAO-SICAF-Setup-1.0.42.exe", "sha256": "…", "taille": 123, "date": "…", "notes": "…" }
 *
 * L'installateur téléchargé est vérifié (empreinte SHA-256) avant d'être lancé en mode silencieux.
 * `fetch` est injectable (net.fetch d'Electron en production — proxy système —, fetch de Node en test).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Compare deux versions « 1.2.3 » : -1, 0 ou 1. Les suffixes (-beta…) sont ignorés. */
function comparerVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** Nom de fichier sûr (aucun séparateur de chemin, aucune remontée). */
function nomSur(nom) {
  const n = String(nom || '');
  if (!n || n !== path.basename(n) || n.includes('..') || /[\\/:*?"<>|]/.test(n)) return null;
  return n;
}

function sha256Fichier(chemin) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(chemin).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function validerManifeste(m) {
  if (!m || typeof m !== 'object') throw new Error('Manifeste de mise à jour invalide');
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ''))) throw new Error('Version absente du manifeste de mise à jour');
  if (!nomSur(m.fichier)) throw new Error('Nom de fichier invalide dans le manifeste de mise à jour');
  if (m.sha256 && !/^[a-f0-9]{64}$/i.test(m.sha256)) throw new Error('Empreinte SHA-256 invalide dans le manifeste');
  return { version: String(m.version), fichier: m.fichier, sha256: m.sha256 ? m.sha256.toLowerCase() : '', taille: Number(m.taille) || 0, date: m.date || '', notes: String(m.notes || '').slice(0, 20000) };
}

/**
 * @param {object} o
 * @param {string} o.versionActuelle
 * @param {{source:string, depot?:string, chemin?:string, url?:string}} o.config
 * @param {Function} o.fetch       implémentation de fetch (suivi des redirections attendu)
 * @param {string} o.dossierTelechargement
 * @param {string} [o.agent]       User-Agent
 */
function creerGestionnaire(o) {
  const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) throw new Error('fetch indisponible');
  const ua = o.agent || 'GMAO-SICAF-Bureau';

  async function getJson(url) {
    const r = await fetchFn(url, { headers: { 'User-Agent': ua, Accept: 'application/vnd.github+json, application/json' } });
    if (!r.ok) throw new Error(`Réponse ${r.status} de ${new URL(url).host}`);
    return r.json();
  }

  /** Recherche d'une version plus récente. */
  async function verifier() {
    const c = o.config || {};
    let manifeste; let telechargement; let page = '';
    if (c.source === 'aucune') return { disponible: false, raison: 'Mises à jour désactivées' };
    if (c.source === 'dossier') {
      if (!c.chemin) throw new Error('Aucun dossier de mise à jour configuré');
      manifeste = validerManifeste(JSON.parse(fs.readFileSync(path.join(c.chemin, 'latest.json'), 'utf8')));
      telechargement = { type: 'fichier', chemin: path.join(c.chemin, manifeste.fichier) };
    } else if (c.source === 'url') {
      if (!c.url) throw new Error('Aucune adresse de mise à jour configurée');
      manifeste = validerManifeste(await getJson(new URL('latest.json', c.url).toString()));
      telechargement = { type: 'url', url: new URL(encodeURIComponent(manifeste.fichier), c.url).toString() };
    } else {
      if (!c.depot) throw new Error('Aucun dépôt de mise à jour configuré');
      const rel = await getJson(`https://api.github.com/repos/${c.depot}/releases/latest`);
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      page = rel.html_url || '';
      const mf = assets.find((a) => a.name === 'latest.json');
      if (mf) manifeste = validerManifeste(await getJson(mf.browser_download_url));
      else {
        const exe = assets.find((a) => /Setup.*\.exe$/i.test(a.name));
        if (!exe) return { disponible: false, raison: 'Aucun installateur dans la dernière version publiée' };
        manifeste = validerManifeste({ version: String(rel.tag_name || '').replace(/^v/i, ''), fichier: exe.name, taille: exe.size });
      }
      if (!manifeste.notes && rel.body) manifeste.notes = String(rel.body).slice(0, 20000);
      const asset = assets.find((a) => a.name === manifeste.fichier);
      if (!asset) throw new Error(`Installateur ${manifeste.fichier} absent de la version publiée`);
      if (!/^https:\/\//.test(asset.browser_download_url || '')) throw new Error('Adresse de téléchargement non sécurisée');
      telechargement = { type: 'url', url: asset.browser_download_url };
    }
    const disponible = comparerVersions(manifeste.version, o.versionActuelle) > 0;
    return { disponible, versionActuelle: o.versionActuelle, version: manifeste.version, notes: manifeste.notes, date: manifeste.date, manifeste, telechargement, page };
  }

  /** Télécharge (ou copie) l'installateur, vérifie son empreinte, retourne son chemin local. */
  async function telecharger(info, onProgression) {
    if (!info || !info.manifeste || !info.telechargement) throw new Error('Aucune mise à jour à télécharger');
    const nom = nomSur(info.manifeste.fichier);
    fs.mkdirSync(o.dossierTelechargement, { recursive: true });
    const cible = path.join(o.dossierTelechargement, nom);
    const tmp = cible + '.partiel';
    try { fs.unlinkSync(tmp); } catch (e) { /* absent */ }
    if (info.telechargement.type === 'fichier') {
      await fs.promises.copyFile(info.telechargement.chemin, tmp);
      if (onProgression) onProgression(1);
    } else {
      const r = await fetchFn(info.telechargement.url, { headers: { 'User-Agent': ua } });
      if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (réponse ${r.status})`);
      const total = Number(r.headers.get('content-length')) || info.manifeste.taille || 0;
      const sortie = fs.createWriteStream(tmp);
      let recu = 0;
      try {
        const lecteur = r.body.getReader();
        for (;;) {
          const { done, value } = await lecteur.read();
          if (done) break;
          recu += value.length;
          if (!sortie.write(Buffer.from(value))) await new Promise((res) => sortie.once('drain', res));
          if (onProgression && total) onProgression(Math.min(1, recu / total));
        }
      } finally {
        await new Promise((res) => sortie.end(res));
      }
    }
    if (info.manifeste.sha256) {
      const h = await sha256Fichier(tmp);
      if (h !== info.manifeste.sha256) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } throw new Error('Empreinte de l\'installateur incorrecte : téléchargement corrompu ou falsifié, mise à jour annulée'); }
    }
    fs.renameSync(tmp, cible);
    return cible;
  }

  return { verifier, telecharger };
}

module.exports = { creerGestionnaire, comparerVersions, validerManifeste, sha256Fichier, nomSur };
