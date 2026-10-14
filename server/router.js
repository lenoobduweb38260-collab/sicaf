'use strict';
/**
 * Mini routeur HTTP (zéro dépendance).
 *
 *   router.get('/api/ot/:id', async (req, res, ctx) => ({ ... }), { perm: ['ot', 'voir'] });
 *
 * - Les segments ":nom" sont capturés dans req.params.
 * - Une route marquée { public: true } ne nécessite pas d'authentification.
 * - { perm: [module, action] } vérifie automatiquement la permission.
 * - { maxBody: octets } relève la taille maximale du corps (25 Mo par défaut).
 * - { brut: true } fournit le corps binaire brut (Buffer) dans req.body (à combiner avec public + authentification propre).
 * - La valeur retournée par le gestionnaire est sérialisée en JSON.
 */

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regexSrc = pattern
      .replace(/\/+$/, '')
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        if (seg === '*') { keys.push('rest'); return '(.*)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method: method.toUpperCase(), pattern, regex: new RegExp('^' + regexSrc + '/?$'), keys, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    method = method.toUpperCase();
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router, HttpError };
