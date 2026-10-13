'use strict';
/**
 * Utilitaires de test : démarre une application en mémoire et fournit un client HTTP
 * conservant le cookie de session.
 */
const { createApp } = require('../server/server');

async function demarrer(options = {}) {
  const app = createApp(Object.assign({ inMemory: true, log: () => {} }, options));
  const addr = await app.start(0);
  const base = `http://127.0.0.1:${addr.port}`;

  function client() {
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'x-requested-with': 'GMAO', cookie };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch (e) { data = txt; }
      return { status: r.status, body: data, headers: r.headers };
    };
    const c = {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      async login(login, password) { const r = await call('POST', '/api/auth/login', { login, password }); if (r.status !== 200) throw new Error('Connexion échouée : ' + JSON.stringify(r.body)); return r.body; },
      /** Lève une erreur si le statut n'est pas 2xx, sinon retourne le corps. */
      async ok(method, u, b) { const r = await call(method, u, b); if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; },
    };
    return c;
  }

  return { app, base, client, db: app.db, ctx: app.ctx, stop: () => app.stop() };
}

module.exports = { demarrer };
