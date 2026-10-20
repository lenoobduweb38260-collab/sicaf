/**
 * Client HTTP minimal pour l'API JSON de la GMAO.
 *   const rows = await api.get('/api/ot', { statut: 'en_cours' });
 *   await api.post('/api/ot', { titre: '...' });
 * Les erreurs lèvent une exception { status, message, details }.
 */
(function () {
  'use strict';

  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  /** Site choisi dans l'en-tête (« tous » ou identifiant), mémorisé sur le poste. */
  function siteCourant() {
    try { return localStorage.getItem('gmao.site') || ''; } catch (e) { return ''; }
  }

  async function request(method, url, body, options = {}) {
    if (options.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    // Changement de mot de passe ou enrôlement de la double authentification imposé : aucune donnée n'est demandée au
    // serveur avant (badges et rafraîchissements périodiques des vues compris), hors authentification
    const G = window.GMAO;
    if (G && /^\/api\//.test(url) && !/^\/api\/(auth\/|views)/.test(url)) {
      if (typeof G.changementMdpRequis === 'function' && G.changementMdpRequis()) {
        throw new ApiError(403, 'Vous devez changer votre mot de passe avant de continuer.', { changementMdpRequis: true });
      }
      if (typeof G.deuxFacteursRequis === 'function' && G.deuxFacteursRequis()) {
        throw new ApiError(403, 'Vous devez activer la double authentification avant de continuer.', { deuxFacteursRequis: true });
      }
    }
    const headers = { 'X-Requested-With': 'GMAO' };
    const site = siteCourant();
    if (site) headers['X-GMAO-Site'] = site;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    } catch (e) {
      throw new ApiError(0, 'Serveur injoignable. Vérifiez que la GMAO est démarrée.');
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch (e) { data = null; }
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      if (res.status === 401 && !options.silent401 && window.GMAO && typeof window.GMAO.onNonAuthentifie === 'function') {
        window.GMAO.onNonAuthentifie();
      }
      // Changement de mot de passe imposé par le serveur : l'application affiche la fenêtre de changement
      if (res.status === 403 && data && data.changementMdpRequis && window.GMAO && typeof window.GMAO.onChangementMdpRequis === 'function') {
        window.GMAO.onChangementMdpRequis(data.details || {});
      }
      const msg = (data && data.erreur) || (typeof data === 'string' && data) || `Erreur ${res.status}`;
      throw new ApiError(res.status, msg, data && data.details);
    }
    return data;
  }

  window.api = {
    ApiError,
    siteCourant,
    setSiteCourant(v) { try { if (v) localStorage.setItem('gmao.site', String(v)); else localStorage.removeItem('gmao.site'); } catch (e) { /* ignore */ } },
    get: (url, query, options) => request('GET', url, undefined, Object.assign({ query }, options || {})),
    post: (url, body, options) => request('POST', url, body === undefined ? {} : body, options),
    put: (url, body, options) => request('PUT', url, body === undefined ? {} : body, options),
    patch: (url, body, options) => request('PATCH', url, body === undefined ? {} : body, options),
    del: (url, options) => request('DELETE', url, undefined, options),
    /** Télécharge un fichier produit par l'API (CSV, export JSON). */
    telecharger: async (url, nomFichier) => {
      const h = { 'X-Requested-With': 'GMAO' };
      if (siteCourant()) h['X-GMAO-Site'] = siteCourant();
      const res = await fetch(url, { credentials: 'same-origin', headers: h });
      if (!res.ok) {
        let msg = `Erreur ${res.status}`;
        try { msg = (await res.json()).erreur || msg; } catch (e) { /* ignore */ }
        throw new ApiError(res.status, msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = nomFichier || (m ? m[1] : 'export');
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };
})();
