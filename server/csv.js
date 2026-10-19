'use strict';
/**
 * Export CSV (séparateur « ; », tableurs français) : échappement commun à tous les modules.
 *
 * - Les retours à la ligne d'une cellule deviennent des espaces ; une cellule contenant « ; », « " »
 *   ou un séparateur de ligne est mise entre guillemets (guillemets doublés).
 * - Protection contre l'injection de formules : une cellule qui commence par = + - @, une tabulation
 *   ou un retour chariot reçoit une apostrophe en tête pour qu'un tableur ne l'interprète jamais comme
 *   une formule. Un nombre (même négatif, virgule ou point décimal : « -12,5 ») reste un nombre ; un texte
 *   comme « +33 6 00 00 00 00 » est neutralisé.
 * Les modules l'utilisent via require('../csv') ou ctx.csvEscape.
 */
function csvEscape(v) {
  let s = v == null ? '' : String(v).replace(/\r\n|\r|\n/g, ' ');
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(?:[.,]\d+)?$/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Ligne CSV à partir d'une liste de cellules. */
function csvLigne(cellules) { return (cellules || []).map(csvEscape).join(';'); }

module.exports = { csvEscape, csvLigne };
