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

  async function request(method, url, body, options = {}) {
    if (options.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const headers = { 'X-Requested-With': 'GMAO' };
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
      const msg = (data && data.erreur) || (typeof data === 'string' && data) || `Erreur ${res.status}`;
      throw new ApiError(res.status, msg, data && data.details);
    }
    return data;
  }

  window.api = {
    ApiError,
    get: (url, query, options) => request('GET', url, undefined, Object.assign({ query }, options || {})),
    post: (url, body, options) => request('POST', url, body === undefined ? {} : body, options),
    put: (url, body, options) => request('PUT', url, body === undefined ? {} : body, options),
    patch: (url, body, options) => request('PATCH', url, body === undefined ? {} : body, options),
    del: (url, options) => request('DELETE', url, undefined, options),
    /** Télécharge un fichier produit par l'API (CSV, export JSON). */
    telecharger: async (url, nomFichier) => {
      const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'GMAO' } });
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
