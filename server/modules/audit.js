'use strict';
/**
 * Module Journal d'audit : consultation et export de la traçabilité.
 */
const nom = 'Audit';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function register(ctx) {
  const { router, db } = ctx;

  function filtrer(req) {
    let rows = db.list('audit');
    const q = req.query || {};
    if (q.entite) rows = rows.filter((r) => r.entite === q.entite);
    if (q.action) rows = rows.filter((r) => r.action === q.action);
    if (q.userId) rows = rows.filter((r) => String(r.userId) === String(q.userId));
    if (q.du) rows = rows.filter((r) => r.date >= q.du);
    if (q.au) rows = rows.filter((r) => r.date <= q.au + 'T23:59:59.999Z');
    if (q.recherche) {
      const s = String(q.recherche).toLowerCase();
      rows = rows.filter((r) => [r.userNom, r.action, r.entite, r.details, r.entiteId].some((v) => String(v == null ? '' : v).toLowerCase().includes(s)));
    }
    return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  router.get('/api/audit', async (req) => {
    const rows = filtrer(req);
    const limite = Math.min(2000, Number(req.query.limite) || 500);
    return {
      total: rows.length,
      lignes: rows.slice(0, limite),
      entites: Array.from(new Set(db.list('audit').map((r) => r.entite))).sort(),
      actions: Array.from(new Set(db.list('audit').map((r) => r.action))).sort(),
      // Libellés des actions du cœur (connexions, mots de passe, double authentification…)
      libellesActions: Object.assign({}, ctx.libellesActions || {}),
    };
  }, { perm: ['audit', 'voir'] });

  router.get('/api/audit/export', async (req, res) => {
    const rows = filtrer(req);
    const lignes = ['﻿Date;Utilisateur;Action;Entité;Identifiant;Détails;IP'];
    for (const r of rows) lignes.push([r.date, r.userNom, r.action, r.entite, r.entiteId, r.details, r.ip].map(csvEscape).join(';'));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="journal-audit.csv"' });
    res.end(lignes.join('\r\n'));
  }, { perm: ['audit', 'exporter'] });

  /** Historique d'un élément précis (ex. /api/audit/ot/12). */
  router.get('/api/audit/:entite/:id', async (req) => {
    return db.list('audit', (r) => r.entite === req.params.entite && String(r.entiteId) === String(req.params.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
  }, { perm: ['audit', 'voir'] });
}

module.exports = { nom, register, csvEscape };
