'use strict';
/**
 * Double authentification (TOTP) :
 *  - vecteurs officiels (RFC 4226, RFC 6238, RFC 4648), fenêtre, anti-rejeu, codes de secours, chiffrement des clés ;
 *  - QR code : Reed-Solomon et informations de format comparés à la littérature, décodage complet de la matrice
 *    par un lecteur indépendant du générateur ;
 *  - API : enrôlement, connexion en deux étapes, code faux, rejeu, codes de secours à usage unique, jeton expiré
 *    ou présenté par un autre poste, blocage, confidentialité de la clé, désactivation, réinitialisation par le
 *    pôle informatique, obligation pour les comptes sensibles ou pour tous.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demarrer } = require('./helpers');
const totp = require('../server/totp');
const QRCode = require('../client/js/lib/qrcode.js');

// =====================================================================================================
// TOTP, base32, codes de secours, coffre
// =====================================================================================================
describe('TOTP (RFC 4226 / RFC 6238)', () => {
  const CLE_RFC = Buffer.from('12345678901234567890');

  test('vecteurs officiels RFC 6238 (HMAC-SHA1, 8 chiffres)', () => {
    const vecteurs = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, attendu] of vecteurs) assert.equal(totp.totp(CLE_RFC, { instant: t * 1000, chiffres: 8 }), attendu, `instant ${t}`);
  });

  test('vecteurs officiels RFC 4226 (HOTP, 6 chiffres)', () => {
    const attendus = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    attendus.forEach((code, compteur) => assert.equal(totp.hotp(CLE_RFC, compteur), code, `compteur ${compteur}`));
  });

  test('base32 (RFC 4648) : vecteurs, casse, espaces, caractères invalides', () => {
    const vecteurs = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
    for (const [clair, code] of vecteurs) {
      assert.equal(totp.base32Encoder(Buffer.from(clair), { remplissage: true }), code);
      assert.equal(totp.base32Decoder(code).toString(), clair);
    }
    assert.equal(totp.base32Encoder(Buffer.from('foobar')), 'MZXW6YTBOI', 'sans remplissage par défaut');
    assert.equal(totp.base32Decoder('mzxw 6ytb oi').toString(), 'foobar');
    assert.throws(() => totp.base32Decoder('MZXW1'), /invalide/);
    const brut = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    assert.deepEqual(totp.base32Decoder(totp.base32Encoder(brut)), brut);
  });

  test('vérification : fenêtre de ±1 pas, anti-rejeu, format du code', () => {
    const secret = totp.genererSecret();
    const t = Date.parse('2026-10-14T10:00:10Z');
    const pas = totp.pasDe(t);
    const code = totp.totp(secret, { instant: t });
    assert.equal(totp.verifier(secret, code, { instant: t }), pas);
    assert.equal(totp.verifier(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, { instant: t }), pas, 'espaces tolérés');
    assert.equal(totp.verifier(secret, totp.totp(secret, { instant: t - 30000 }), { instant: t }), pas - 1, 'pas précédent accepté');
    assert.equal(totp.verifier(secret, totp.totp(secret, { instant: t + 30000 }), { instant: t }), pas + 1, 'pas suivant accepté');
    assert.equal(totp.verifier(secret, totp.totp(secret, { instant: t - 60000 }), { instant: t }), null, 'hors fenêtre');
    assert.equal(totp.verifier(secret, code, { instant: t, dernierPas: pas }), null, 'code déjà utilisé refusé');
    assert.equal(totp.verifier(secret, totp.totp(secret, { instant: t - 30000 }), { instant: t, dernierPas: pas }), null, 'code plus ancien refusé');
    for (const faux of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5x']) assert.equal(totp.verifier(secret, faux, { instant: t }), null);
    assert.equal(totp.egalTempsConstant('123456', '123456'), true);
    assert.equal(totp.egalTempsConstant('123456', '123457'), false);
    assert.equal(totp.egalTempsConstant('123456', '1234567'), false);
  });

  test('clé aléatoire de 20 octets, saisie manuelle groupée, URI otpauth', () => {
    const s = totp.genererSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
    assert.equal(totp.base32Decoder(s).length, 20);
    assert.notEqual(totp.genererSecret(), s);
    assert.match(totp.grouperSecret(s), /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    assert.equal(totp.uriOtpauth('jdupont', 'JBSWY3DPEHPK3PXP'), 'otpauth://totp/GMAO%20SICAF:jdupont?secret=JBSWY3DPEHPK3PXP&issuer=GMAO%20SICAF');
    assert.equal(totp.uriOtpauth('j.dupont@usine', 'ABC'), 'otpauth://totp/GMAO%20SICAF:j.dupont%40usine?secret=ABC&issuer=GMAO%20SICAF');
  });

  test('codes de secours : format, unicité, empreinte scrypt, normalisation de la saisie', async () => {
    const codes = totp.genererCodesSecours();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    const empreinte = await totp.empreinteCodeSecours(codes[0]);
    assert.match(empreinte, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.ok(!empreinte.includes(codes[0].replace('-', '')));
    const empreintes = [await totp.empreinteCodeSecours(codes[1]), empreinte];
    assert.equal(await totp.trouverCodeSecours(codes[0].toUpperCase().replace('-', ' '), empreintes), empreinte);
    assert.equal(await totp.trouverCodeSecours(codes[2], empreintes), null);
    assert.equal(await totp.trouverCodeSecours('123456', empreintes), null);
    assert.equal(totp.normaliserCodeSecours('abcde-fghij'), null, 'caractères ambigus refusés (i)');
  });

  test('coffre : chiffrement AES-256-GCM, clé conservée hors de la base, clé différente refusée', () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gmao-coffre-'));
    try {
      const c1 = new totp.Coffre({ dossier });
      const chiffre = c1.chiffrer('JBSWY3DPEHPK3PXP');
      assert.match(chiffre, /^v1:/);
      assert.ok(!chiffre.includes('JBSWY3DPEHPK3PXP'));
      assert.notEqual(c1.chiffrer('JBSWY3DPEHPK3PXP'), chiffre, 'vecteur d\'initialisation aléatoire');
      assert.ok(fs.existsSync(path.join(dossier, totp.FICHIER_CLE)));
      assert.equal(new totp.Coffre({ dossier }).dechiffrer(chiffre), 'JBSWY3DPEHPK3PXP', 'même clé relue depuis le fichier');
      assert.throws(() => new totp.Coffre({ enMemoire: true }).dechiffrer(chiffre), 'clé différente');
      const altere = chiffre.slice(0, -2) + (chiffre.endsWith('A') ? 'B' : 'A') + '=';
      assert.throws(() => c1.dechiffrer(altere), 'donnée altérée détectée');
    } finally { fs.rmSync(dossier, { recursive: true, force: true }); }
  });
});

// =====================================================================================================
// QR code : vecteurs de la littérature et lecteur indépendant
// =====================================================================================================

/** Corps de Galois GF(256) du lecteur (polynôme 0x11D), écrit indépendamment du générateur. */
const GF = (() => {
  const exp = [], log = [];
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); x &= 0xff; }
  const mul = (a, b) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  return { exp, mul };
})();

/** Reste de division polynomiale binaire (codes BCH). */
function resteBCH(valeur, generateur, degreGen) {
  let r = valeur;
  for (let b = 31; b >= degreGen; b--) if (r & (1 << b)) r ^= generateur << (b - degreGen);
  return r;
}
const FORMATS_VALIDES = Array.from({ length: 32 }, (_, d) => ((d << 10) | resteBCH(d << 10, 0x537, 10)) ^ 0x5412);
const NIVEAU_DEPUIS_BITS = { 0: 'M', 1: 'L', 2: 'H', 3: 'Q' };

/** Structure des blocs, niveau M, versions 1 à 10 (ISO/IEC 18004, tableau 9) : [nombre, codewords, données]. */
const BLOCS_M = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]], 4: [[2, 50, 32]], 5: [[2, 67, 43]],
  6: [[4, 43, 27]], 7: [[4, 49, 31]], 8: [[2, 60, 38], [2, 61, 39]], 9: [[3, 58, 36], [2, 59, 37]], 10: [[4, 69, 43], [1, 70, 44]],
};
/** Centres des motifs d'alignement (ISO/IEC 18004, annexe E). */
const ALIGNEMENTS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
/** Masques de la norme (i = ligne, j = colonne). */
const MASQUES_NORME = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

/**
 * Lecteur de QR code (niveau M, versions 1 à 10) travaillant sur la matrice : vérifie les motifs fixes,
 * décode et contrôle les informations de format / version, lit les modules en zigzag, retire le masque,
 * désentrelace, contrôle chaque bloc par ses syndromes de Reed-Solomon et décode le segment en mode octet.
 */
function lireQR(m) {
  const t = m.length;
  const version = (t - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, 'taille de matrice inattendue : ' + t);
  m.forEach((ligne) => assert.equal(ligne.length, t));
  const M = (l, c) => !!m[l][c];

  // Motifs de position, séparateurs, synchronisation, module sombre
  for (const [l0, c0] of [[0, 0], [0, t - 7], [t - 7, 0]]) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const l = l0 + i, c = c0 + j;
        if (l < 0 || c < 0 || l >= t || c >= t) continue;
        const anneau = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        assert.equal(M(l, c), anneau <= 1 || anneau === 3, `motif de position (${l}, ${c})`);
      }
    }
  }
  for (let k = 8; k < t - 8; k++) { assert.equal(M(6, k), k % 2 === 0, 'synchronisation horizontale'); assert.equal(M(k, 6), k % 2 === 0, 'synchronisation verticale'); }
  assert.equal(M(t - 8, 8), true, 'module sombre');

  // Informations de format (deux copies identiques et valides)
  let fa = 0, fb = 0;
  const posA = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  posA.forEach(([l, c], i) => { if (M(l, c)) fa |= 1 << i; });
  for (let i = 0; i < 8; i++) if (M(8, t - 1 - i)) fb |= 1 << i;
  for (let i = 8; i < 15; i++) if (M(t - 15 + i, 8)) fb |= 1 << i;
  assert.equal(fa, fb, 'les deux copies du format sont identiques');
  const indexFormat = FORMATS_VALIDES.indexOf(fa);
  assert.ok(indexFormat >= 0, 'format BCH valide');
  const niveau = NIVEAU_DEPUIS_BITS[indexFormat >> 3];
  const masque = indexFormat & 7;
  assert.equal(niveau, 'M');

  // Informations de version (versions 7 et plus)
  if (version >= 7) {
    let va = 0, vb = 0;
    for (let i = 0; i < 18; i++) {
      if (M(Math.floor(i / 3), t - 11 + (i % 3))) va |= 1 << i;
      if (M(t - 11 + (i % 3), Math.floor(i / 3))) vb |= 1 << i;
    }
    assert.equal(va, vb);
    assert.equal(va, (version << 12) | resteBCH(version << 12, 0x1f25, 12), 'version BCH(18,6)');
  }

  // Zones fonctionnelles
  const fonction = Array.from({ length: t }, () => new Array(t).fill(false));
  const zone = (l1, c1, l2, c2) => { for (let l = l1; l <= l2; l++) for (let c = c1; c <= c2; c++) fonction[l][c] = true; };
  zone(0, 0, 8, 8); zone(0, t - 8, 8, t - 1); zone(t - 8, 0, t - 1, 8);
  zone(6, 0, 6, t - 1); zone(0, 6, t - 1, 6);
  const al = ALIGNEMENTS[version];
  for (const a of al) for (const b of al) {
    if ((a === 6 && b === 6) || (a === 6 && b === al[al.length - 1]) || (a === al[al.length - 1] && b === 6)) continue;
    // Le motif d'alignement : bord sombre, anneau clair, centre sombre
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) assert.equal(M(a + i, b + j), Math.max(Math.abs(i), Math.abs(j)) !== 1, 'motif d\'alignement');
    zone(a - 2, b - 2, a + 2, b + 2);
  }
  if (version >= 7) { zone(0, t - 11, 5, t - 9); zone(t - 11, 0, t - 9, 5); }

  // Lecture en zigzag et retrait du masque
  const bits = [];
  let montee = true;
  for (let c = t - 1; c > 0; c -= 2) {
    if (c === 6) c = 5;
    for (let k = 0; k < t; k++) {
      const l = montee ? t - 1 - k : k;
      for (const cc of [c, c - 1]) if (!fonction[l][cc]) bits.push(M(l, cc) !== MASQUES_NORME[masque](l, cc));
    }
    montee = !montee;
  }
  const blocs = [];
  for (const [n, total, donnees] of BLOCS_M[version]) for (let i = 0; i < n; i++) blocs.push({ donnees, ec: total - donnees, d: [], e: [] });
  const totalCw = blocs.reduce((s, b) => s + b.donnees + b.ec, 0);
  const cw = [];
  for (let i = 0; i < totalCw; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] ? 1 : 0); cw.push(v); }
  assert.ok(bits.slice(totalCw * 8).every((b) => !b), 'bits de remplissage à 0');

  // Désentrelacement et contrôle de Reed-Solomon (syndromes nuls)
  let k = 0;
  const maxD = Math.max(...blocs.map((b) => b.donnees));
  for (let i = 0; i < maxD; i++) for (const b of blocs) if (i < b.donnees) b.d.push(cw[k++]);
  for (let i = 0; i < blocs[0].ec; i++) for (const b of blocs) b.e.push(cw[k++]);
  for (const b of blocs) {
    const poly = b.d.concat(b.e);
    for (let j = 0; j < b.ec; j++) {
      let s = 0;
      for (const coef of poly) s = GF.mul(s, GF.exp[j]) ^ coef;
      assert.equal(s, 0, `syndrome ${j} non nul`);
    }
  }

  // Segment en mode octet
  const flux = [];
  for (const b of blocs) for (const o of b.d) for (let i = 7; i >= 0; i--) flux.push((o >> i) & 1);
  let p = 0;
  const lire = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | flux[p++]; return v; };
  assert.equal(lire(4), 0b0100, 'mode octet');
  const longueur = lire(version <= 9 ? 8 : 16);
  const octets = [];
  for (let i = 0; i < longueur; i++) octets.push(lire(8));
  const restant = flux.length - p;
  if (restant > 0) assert.equal(lire(Math.min(4, restant)), 0, 'terminateur');
  while (p % 8) assert.equal(flux[p++], 0);
  for (let pad = 0xec; p < flux.length; pad ^= 0xec ^ 0x11) assert.equal(lire(8), pad, 'octets de bourrage');
  return { version, niveau, masque, texte: Buffer.from(octets).toString('utf8') };
}

describe('QR code (client/js/lib/qrcode.js)', () => {
  const I = QRCode._interne;

  test('Reed-Solomon : « HELLO WORLD » 1-M et 1-Q (exemples de la littérature)', () => {
    assert.deepEqual(I.reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    assert.deepEqual(I.reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236], 13), [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
  });

  test('informations de format (BCH 15,5) et de version (BCH 18,6) : valeurs de la norme', () => {
    const b = (n, l) => n.toString(2).padStart(l, '0');
    assert.equal(b(I.bitsFormat(I.NIVEAUX.M, 0), 15), '101010000010010');
    assert.equal(b(I.bitsFormat(I.NIVEAUX.L, 0), 15), '111011111000100');
    assert.equal(b(I.bitsFormat(I.NIVEAUX.Q, 0), 15), '011010101011111');
    assert.equal(b(I.bitsFormat(I.NIVEAUX.H, 0), 15), '001011010001001');
    assert.equal(b(I.bitsFormat(I.NIVEAUX.M, 5), 15), '100000011001110');
    assert.equal(b(I.bitsVersion(7), 18), '000111110010010100');
    assert.equal(b(I.bitsVersion(10), 18), '001010010011010011');
    for (let n = 0; n < 4; n++) for (let mk = 0; mk < 8; mk++) assert.ok(FORMATS_VALIDES.includes(I.bitsFormat(n, mk)));
  });

  test('capacités et motifs d\'alignement conformes à la norme (niveau M, versions 1 à 10)', () => {
    for (let v = 1; v <= 10; v++) {
      assert.equal(I.codewordsDonnees(v, I.NIVEAUX.M), BLOCS_M[v].reduce((s, [n, , d]) => s + n * d, 0), `données v${v}`);
      assert.equal(Math.floor(I.modulesDonnees(v) / 8), BLOCS_M[v].reduce((s, [n, t]) => s + n * t, 0), `codewords v${v}`);
      assert.deepEqual(I.positionsAlignement(v), ALIGNEMENTS[v]);
    }
    assert.deepEqual(I.positionsAlignement(32), [6, 34, 60, 86, 112, 138]);
  });

  test('décodage complet par un lecteur indépendant (versions 1 à 10, niveau M, UTF-8)', () => {
    const limites = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]; // capacité en octets, niveau M
    const cas = [];
    limites.forEach((max, i) => { cas.push(['x'.repeat(max), i + 1]); if (i < 9) cas.push(['y'.repeat(max + 1), i + 2]); });
    cas.push(['A', 1]);
    for (const [texte, versionAttendue] of cas) {
      const q = QRCode.matrice(texte);
      assert.equal(q.version, versionAttendue, `longueur ${texte.length}`);
      const r = lireQR(q.modules);
      assert.equal(r.texte, texte);
      assert.equal(r.masque, q.masque);
    }
    const uri = totp.uriOtpauth('jdupont', totp.genererSecret());
    assert.equal(lireQR(QRCode.matrice(uri).modules).texte, uri);
    const accents = 'Équipement n°12 — compresseur « été » 🔧';
    assert.equal(lireQR(QRCode.matrice(accents).modules).texte, accents);
    assert.throws(() => QRCode.matrice('z'.repeat(3000)), /trop long/);
  });

  test('les 8 masques sont conformes et le masque retenu minimise les pénalités', () => {
    const texte = totp.uriOtpauth('admin', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    const scores = [];
    for (let mk = 0; mk < 8; mk++) {
      const q = QRCode.matrice(texte, { masque: mk });
      const r = lireQR(q.modules);
      assert.equal(r.masque, mk);
      assert.equal(r.texte, texte);
      scores.push(I.penalite(q.modules));
    }
    const choisi = QRCode.matrice(texte);
    assert.equal(scores[choisi.masque], Math.min(...scores));
  });

  test('image SVG autonome, sans script ni gestionnaire d\'événement', () => {
    const q = QRCode.matrice('GMAO SICAF');
    const s = QRCode.svg('GMAO SICAF', { titre: '<b>"essai"</b>' });
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
    assert.ok(!/<script|\son\w+=|javascript:/i.test(s));
    assert.ok(s.includes('&lt;b&gt;&quot;essai&quot;&lt;/b&gt;'), 'titre échappé');
    const sombres = q.modules.reduce((n, l) => n + l.filter(Boolean).length, 0);
    assert.equal((s.match(/h1v1h-1z/g) || []).length, sombres);
  });
});

// =====================================================================================================
// API
// =====================================================================================================
describe('Double authentification (API)', () => {
  let srv, admin, horloge, profils;
  const avancer = (secondes) => { horloge += secondes * 1000; };
  const code = (secret) => totp.totp(secret, { instant: horloge });
  const profil = (nom) => profils.find((p) => p.nom === nom).id;

  before(async () => {
    srv = await demarrer();
    horloge = Date.parse('2026-10-14T08:00:05Z');
    srv.ctx.deuxFacteurs.maintenant = () => horloge;
    admin = srv.client();
    await admin.login('admin', 'admin');
    profils = await admin.ok('GET', '/api/profils');
    await admin.ok('POST', '/api/utilisateurs', { login: 'tech', nom: 'Technicien', prenom: 'Théo', profilId: profil('Technicien'), password: 'tech1234', doitChangerMdp: false });
    await admin.ok('POST', '/api/utilisateurs', { login: 'info', nom: 'Informatique', prenom: 'Inès', profilId: profil('Pôle informatique'), password: 'info1234', doitChangerMdp: false });
  });
  after(async () => { await srv.stop(); });

  /** Enrôle un compte (client déjà connecté) ; renvoie { secret, codes }. */
  async function enroler(c, motDePasse) {
    const p = await c.ok('POST', '/api/auth/2fa/preparer', { motDePasse });
    const r = await c.ok('POST', '/api/auth/2fa/activer', { code: code(p.secret) });
    return { secret: p.secret, codes: r.codesSecours };
  }
  /** Connexion complète en deux étapes. */
  async function connecter(login, motDePasse, saisie) {
    const c = srv.client();
    const r1 = await c.post('/api/auth/login', { login, password: motDePasse });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.deuxFacteurs, true);
    const r2 = await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: saisie });
    return { c, r1, r2 };
  }
  const reinitialiserCompteurs = () => srv.app.sessions.tentatives.clear();

  test('facultative par défaut : connexion de l\'administrateur en une seule étape', async () => {
    assert.equal(srv.db.getConfig().securite.deuxFacteurs, 'facultatif');
    const c = srv.client();
    const r = await c.login('admin', 'admin');
    assert.ok(r.user && r.permissions, 'amorçage complet');
    assert.deepEqual(r.deuxFacteurs, { actif: false, activeLe: null, codesSecoursRestants: 0, mode: 'facultatif', exige: false, enrolementRequis: false });
    assert.equal(r.user.deuxFacteurs.actif, false);
  });

  let secretTech, codesTech, secretInfo;
  test('enrôlement complet : mot de passe, clé en attente, premier code, codes de secours', async () => {
    const tech = srv.client();
    await tech.login('tech', 'tech1234');
    const autrePoste = srv.client();
    await autrePoste.login('tech', 'tech1234');
    assert.equal((await tech.post('/api/auth/2fa/preparer', {})).status, 400, 'mot de passe exigé');
    assert.equal((await tech.post('/api/auth/2fa/preparer', { motDePasse: 'faux' })).status, 400);
    const p = await tech.ok('POST', '/api/auth/2fa/preparer', { motDePasse: 'tech1234' });
    assert.match(p.secret, /^[A-Z2-7]{32}$/);
    assert.equal(p.uri, `otpauth://totp/GMAO%20SICAF:tech?secret=${p.secret}&issuer=GMAO%20SICAF`);
    assert.equal(p.cleManuelle.replace(/ /g, ''), p.secret);
    assert.equal(p.emetteur, 'GMAO SICAF');
    // La clé en attente n'est jamais renvoyée ensuite
    const me = await tech.get('/api/auth/me');
    assert.ok(!JSON.stringify(me.body).includes(p.secret));
    assert.equal(me.body.deuxFacteurs.actif, false);
    const stocke = srv.db.get('users', me.body.user.id).deuxFacteurs;
    assert.match(stocke.secretEnAttente, /^v1:/, 'clé chiffrée au repos');
    assert.ok(!JSON.stringify(stocke).includes(p.secret));

    const faux = String((Number(code(p.secret)) + 1) % 1000000).padStart(6, '0');
    assert.equal((await tech.post('/api/auth/2fa/activer', { code: faux })).status, 400, 'code faux refusé');
    assert.equal((await tech.post('/api/auth/2fa/activer', { code: { $ne: 1 } })).status, 400, 'type invalide refusé');
    const r = await tech.ok('POST', '/api/auth/2fa/activer', { code: code(p.secret) });
    assert.equal(r.codesSecours.length, 10);
    assert.equal(new Set(r.codesSecours).size, 10);
    assert.equal((await tech.post('/api/auth/2fa/activer', { code: code(p.secret) })).status, 400, 'déjà active');
    secretTech = p.secret; codesTech = r.codesSecours;

    const etat = (await tech.ok('GET', '/api/auth/me')).deuxFacteurs;
    assert.equal(etat.actif, true);
    assert.equal(etat.codesSecoursRestants, 10);
    assert.ok(etat.activeLe);
    const u = srv.db.get('users', me.body.user.id);
    assert.match(u.deuxFacteurs.secret, /^v1:/);
    assert.equal(u.deuxFacteurs.secretEnAttente, undefined);
    assert.ok(u.codesSecours.every((h) => /^scrypt\$/.test(h)));
    assert.equal((await autrePoste.get('/api/auth/me')).status, 401, 'les autres postes sont déconnectés');
    assert.equal((await tech.get('/api/auth/me')).status, 200, 'le poste courant reste connecté');
    const journal = await admin.ok('GET', '/api/audit?action=activation_double_auth');
    assert.ok(journal.total >= 1);
  });

  test('connexion en deux étapes : aucune session avant le code, code faux, puis code correct', async () => {
    const c = srv.client();
    const r1 = await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.deuxFacteurs, true);
    assert.match(r1.body.jeton, /^[0-9a-f]{64}$/);
    assert.equal(r1.body.user, undefined, 'aucune donnée du compte avant le code');
    assert.equal(r1.headers.get('set-cookie'), null, 'aucune session ouverte');
    assert.equal((await c.get('/api/auth/me')).status, 401);
    avancer(30);
    const faux = String((Number(code(secretTech)) + 7) % 1000000).padStart(6, '0');
    const r2 = await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: faux });
    assert.equal(r2.status, 401);
    assert.equal(r2.body.details.essaisRestants, 4);
    const r3 = await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: code(secretTech) });
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.equal(r3.body.user.login, 'tech');
    assert.equal((await c.get('/api/auth/me')).status, 200);
    assert.equal((await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: code(secretTech) })).status, 401, 'jeton à usage unique');
    const connexions = await admin.ok('GET', '/api/audit?action=connexion');
    assert.ok(connexions.lignes ? connexions.lignes.some((l) => /application/.test(l.details)) : JSON.stringify(connexions).includes('Double authentification par application'));
    assert.ok((await admin.ok('GET', '/api/audit?action=echec_double_auth')).total >= 1, 'échec journalisé');
  });

  test('rejeu refusé : un code déjà utilisé ne permet pas une seconde connexion', async () => {
    const valeur = code(secretTech); // déjà utilisé au test précédent (même pas de temps)
    const { r2 } = await connecter('tech', 'tech1234', valeur);
    assert.equal(r2.status, 401);
    avancer(30);
    const { r2: ok } = await connecter('tech', 'tech1234', code(secretTech));
    assert.equal(ok.status, 200);
    // Un code d'un pas antérieur (dans la fenêtre) n'est plus accepté non plus
    const ancien = totp.totp(secretTech, { instant: horloge - 30000 });
    assert.equal((await connecter('tech', 'tech1234', ancien)).r2.status, 401);
  });

  test('codes de secours à usage unique', async () => {
    reinitialiserCompteurs();
    const { r2, c } = await connecter('tech', 'tech1234', codesTech[0]);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(r2.body.connexion, { codeSecours: true, codesSecoursRestants: 9 });
    assert.equal(r2.body.deuxFacteurs.codesSecoursRestants, 9);
    const notifs = await c.ok('GET', '/api/notifications');
    assert.ok(notifs.notifications.some((n) => n.titre === 'Code de secours utilisé'));
    assert.equal((await connecter('tech', 'tech1234', codesTech[0])).r2.status, 401, 'code déjà consommé');
    const variante = codesTech[1].toUpperCase().replace('-', ' ');
    assert.equal((await connecter('tech', 'tech1234', variante)).r2.status, 200, 'saisie en majuscules et sans tiret acceptée');
    assert.equal(srv.db.findOne('users', (u) => u.login === 'tech').codesSecours.length, 8);
  });

  test('jeton expiré, présenté par un autre poste ou invalide : retour au mot de passe', async () => {
    reinitialiserCompteurs();
    const c = srv.client();
    let r1 = await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' });
    avancer(6 * 60);
    let r = await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: code(secretTech) });
    assert.equal(r.status, 401);
    assert.equal(r.body.details.recommencer, true);

    r1 = await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' });
    const autre = await fetch(srv.base + '/api/auth/login/code', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Poste inconnu' }, body: JSON.stringify({ jeton: r1.body.jeton, code: code(secretTech) }) });
    assert.equal(autre.status, 401, 'jeton lié au poste');
    assert.equal((await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: code(secretTech) })).status, 401, 'jeton annulé après une présentation suspecte');

    for (const jeton of [undefined, '', 'abc', 'f'.repeat(64), { $gt: '' }, ['x']]) {
      const x = await c.post('/api/auth/login/code', { jeton, code: '123456' });
      assert.equal(x.status, 401);
      assert.equal(x.body.details.recommencer, true);
    }
  });

  test('5 essais par jeton, puis blocage du compte après des codes incorrects répétés', async () => {
    reinitialiserCompteurs();
    avancer(60);
    const faux = String((Number(code(secretTech)) + 3) % 1000000).padStart(6, '0');
    const c = srv.client();
    const j1 = (await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' })).body.jeton;
    let r;
    for (let i = 0; i < 5; i++) r = await c.post('/api/auth/login/code', { jeton: j1, code: faux });
    assert.equal(r.status, 401);
    assert.equal(r.body.details.recommencer, true, 'mot de passe redemandé après 5 essais');
    assert.equal((await c.post('/api/auth/login/code', { jeton: j1, code: code(secretTech) })).status, 401, 'jeton épuisé, même avec le bon code');
    const j2 = (await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' })).body.jeton;
    for (let i = 0; i < 3; i++) r = await c.post('/api/auth/login/code', { jeton: j2, code: faux });
    assert.equal(r.status, 429, '8 codes incorrects : compte bloqué');
    assert.equal((await c.post('/api/auth/login', { login: 'tech', password: 'tech1234' })).status, 429, 'connexion refusée pendant le blocage');
    assert.ok((await admin.ok('GET', '/api/audit?action=echec_double_auth')).total >= 8);
    assert.ok((await admin.ok('GET', '/api/audit?action=blocage')).total >= 1);
    const notifsAdmin = await admin.ok('GET', '/api/notifications');
    assert.ok(notifsAdmin.notifications.some((n) => n.titre === 'Compte temporairement bloqué' && /codes de vérification/.test(n.message)), 'pôle informatique prévenu');
    const tech = srv.db.findOne('users', (u) => u.login === 'tech');
    assert.ok(srv.db.list('notifications', (n) => n.userId === tech.id && n.titre === 'Tentatives de connexion suspectes').length >= 1, 'utilisateur prévenu');
    reinitialiserCompteurs();
  });

  test('la clé et les codes de secours ne sont jamais renvoyés (amorçage, utilisateurs, organigramme, export)', async () => {
    avancer(30);
    const { c } = await connecter('tech', 'tech1234', code(secretTech));
    const tech = srv.db.findOne('users', (u) => u.login === 'tech');
    const interdits = [secretTech, tech.deuxFacteurs.secret, ...tech.codesSecours, ...codesTech, '"secret"', '"secretEnAttente"', '"codesSecours"', '"passwordHash"', '"dernierPas"'];
    const verifier = (texte, quoi, autorises = []) => { for (const x of interdits) if (!autorises.includes(x)) assert.ok(!texte.includes(x), `${quoi} contient « ${x.slice(0, 12)}… »`); };
    verifier(JSON.stringify((await c.get('/api/auth/me')).body), '/api/auth/me');
    const liste = await admin.ok('GET', '/api/utilisateurs');
    verifier(JSON.stringify(liste), '/api/utilisateurs');
    assert.deepEqual(Object.keys(liste.find((u) => u.login === 'tech').deuxFacteurs).sort(), ['actif', 'activeLe', 'codesSecoursRestants', 'exige']);
    verifier(JSON.stringify(await admin.ok('GET', '/api/utilisateurs/' + tech.id)), '/api/utilisateurs/:id');
    verifier(JSON.stringify(await admin.ok('GET', '/api/utilisateurs-organigramme')), 'organigramme');
    verifier(JSON.stringify((await admin.get('/api/auth/me')).body), 'amorçage administrateur');
    // L'export complet de la base (sauvegarde) ne contient que la clé chiffrée, jamais la clé elle-même
    const exp = await admin.get('/api/export');
    assert.equal(exp.status, 200);
    const texte = typeof exp.body === 'string' ? exp.body : JSON.stringify(exp.body);
    assert.ok(!texte.includes(secretTech), 'export sans la clé en clair');
    for (const cs of codesTech) assert.ok(!texte.includes(cs), 'export sans les codes de secours en clair');
  });

  test('portée : une fiche utilisateur hors des secteurs du lecteur est introuvable', async () => {
    const secteurs = await admin.ok('GET', '/api/secteurs');
    const prod = secteurs.find((s) => s.code === 'PROD').id;
    const log = secteurs.find((s) => s.code === 'LOG').id;
    await admin.ok('POST', '/api/utilisateurs', { login: 'chefprod', nom: 'Chef', profilId: profil('Chef de secteur'), secteurIds: [prod], password: 'chef1234', doitChangerMdp: false });
    const logisticien = await admin.ok('POST', '/api/utilisateurs', { login: 'logi', nom: 'Logisticien', profilId: profil('Technicien'), secteurIds: [log], password: 'logi1234', doitChangerMdp: false });
    const operateur = await admin.ok('POST', '/api/utilisateurs', { login: 'opprod', nom: 'Opérateur', profilId: profil('Demandeur'), secteurIds: [prod], password: 'oper1234', doitChangerMdp: false });
    const chef = srv.client();
    await chef.login('chefprod', 'chef1234');
    assert.equal((await chef.get('/api/utilisateurs/' + logisticien.id)).status, 404);
    assert.equal((await chef.get('/api/utilisateurs/' + operateur.id)).status, 200);
    assert.ok(!(await chef.ok('GET', '/api/utilisateurs')).some((u) => u.id === logisticien.id));
    assert.ok(!JSON.stringify(await chef.ok('GET', '/api/utilisateurs-organigramme')).includes('"logi"'));
  });

  test('désactivation par l\'utilisateur : mot de passe et code exigés', async () => {
    reinitialiserCompteurs();
    avancer(30);
    const { c } = await connecter('tech', 'tech1234', code(secretTech));
    avancer(30);
    assert.equal((await c.post('/api/auth/2fa/desactiver', { motDePasse: 'faux', code: code(secretTech) })).status, 400);
    assert.equal((await c.post('/api/auth/2fa/desactiver', { motDePasse: 'tech1234', code: '000000' })).status, 400);
    assert.equal((await c.post('/api/auth/2fa/desactiver', { motDePasse: 'tech1234' })).status, 400);
    const r = await c.ok('POST', '/api/auth/2fa/desactiver', { motDePasse: 'tech1234', code: code(secretTech) });
    assert.equal(r.exige, false);
    const tech = srv.db.findOne('users', (u) => u.login === 'tech');
    assert.equal(tech.deuxFacteurs.actif, false);
    assert.equal(tech.deuxFacteurs.secret, undefined, 'clé supprimée');
    assert.deepEqual(tech.codesSecours, []);
    const direct = srv.client();
    const r1 = await direct.login('tech', 'tech1234');
    assert.ok(r1.user, 'connexion de nouveau en une étape');
    assert.ok((await admin.ok('GET', '/api/audit?action=desactivation_double_auth')).total >= 1);
    reinitialiserCompteurs();
  });

  test('nouveaux codes de secours : les anciens deviennent invalides', async () => {
    reinitialiserCompteurs();
    const tech = srv.client();
    await tech.login('tech', 'tech1234');
    const e = await enroler(tech, 'tech1234');
    avancer(30);
    assert.equal((await tech.post('/api/auth/2fa/codes-secours', { motDePasse: 'tech1234', code: '111111' })).status, 400);
    const r = await tech.ok('POST', '/api/auth/2fa/codes-secours', { motDePasse: 'tech1234', code: code(e.secret) });
    assert.equal(r.codesSecours.length, 10);
    assert.equal((await connecter('tech', 'tech1234', e.codes[0])).r2.status, 401, 'ancien code de secours invalide');
    assert.equal((await connecter('tech', 'tech1234', r.codesSecours[0])).r2.status, 200);
    secretTech = e.secret;
    reinitialiserCompteurs();
  });

  test('réinitialisation par le pôle informatique (droit et règle hiérarchique), journalisée et notifiée', async () => {
    const info = srv.client();
    await info.login('info', 'info1234');
    avancer(30);
    const { c: tech } = await connecter('tech', 'tech1234', code(secretTech));
    const idTech = srv.db.findOne('users', (u) => u.login === 'tech').id;
    assert.equal((await tech.post(`/api/utilisateurs/${idTech}/2fa/reinitialiser`)).status, 403, 'technicien sans droit');
    assert.equal((await info.post('/api/utilisateurs/1/2fa/reinitialiser')).status, 403, 'le pôle informatique ne gère pas l\'administrateur');
    const idInfo = srv.db.findOne('users', (u) => u.login === 'info').id;
    assert.equal((await info.post(`/api/utilisateurs/${idInfo}/2fa/reinitialiser`)).status, 400, 'pas pour son propre compte');
    assert.equal((await info.post('/api/utilisateurs/99999/2fa/reinitialiser')).status, 404);
    const r = await info.ok('POST', `/api/utilisateurs/${idTech}/2fa/reinitialiser`);
    assert.equal(r.ok, true);
    assert.equal((await info.post(`/api/utilisateurs/${idTech}/2fa/reinitialiser`)).status, 400, 'déjà réinitialisée');
    const u = srv.db.get('users', idTech);
    assert.equal(u.deuxFacteurs.actif, false);
    assert.equal(u.deuxFacteurs.secret, undefined);
    assert.deepEqual(u.codesSecours, []);
    assert.equal(u.deuxFacteurs.reinitialisePar, idInfo);
    assert.equal((await tech.get('/api/auth/me')).status, 401, 'sessions de l\'utilisateur fermées');
    assert.ok((await admin.ok('GET', '/api/audit?action=reinitialisation_double_auth')).total >= 1);
    const nouvelle = srv.client();
    const b = await nouvelle.login('tech', 'tech1234');
    assert.ok(b.user, 'connexion en une étape');
    assert.ok((await nouvelle.ok('GET', '/api/notifications')).notifications.some((n) => n.titre === 'Double authentification réinitialisée'));
  });

  test('obligation pour les comptes sensibles puis pour tous : enrôlement imposé avant tout autre écran', async () => {
    reinitialiserCompteurs();
    assert.equal((await admin.put('/api/configuration', { securite: { deuxFacteurs: 'toujours' } })).status, 400, 'mode invalide refusé');
    // L'administrateur s'enrôle d'abord (sinon il serait lui-même bloqué après l'enregistrement)
    const eAdmin = await enroler(admin, 'admin');
    const cfg = await admin.ok('PUT', '/api/configuration', { securite: { deuxFacteurs: 'obligatoire_sensibles' } });
    assert.equal(cfg.securite.deuxFacteurs, 'obligatoire_sensibles');
    assert.equal((await admin.get('/api/equipements')).status, 200, 'administrateur enrôlé : accès normal');

    // Pôle informatique (droits de modification sensibles) non enrôlé : session ouverte mais accès restreint
    const info = srv.client();
    const b = await info.login('info', 'info1234');
    assert.equal(b.deuxFacteurs.exige, true);
    assert.equal(b.deuxFacteurs.enrolementRequis, true);
    for (const url of ['/api/utilisateurs', '/api/notifications', '/api/configuration']) {
      const r = await info.get(url);
      assert.equal(r.status, 403, url);
      assert.equal(r.body.details.deuxFacteursRequis, true);
    }
    assert.equal((await info.get('/api/auth/me')).status, 200, 'amorçage toujours accessible');
    const listeAdmin = await admin.ok('GET', '/api/utilisateurs');
    assert.equal(listeAdmin.find((u) => u.login === 'info').deuxFacteurs.exige, true);
    assert.equal(listeAdmin.find((u) => u.login === 'tech').deuxFacteurs.exige, false);

    // Technicien : non concerné
    const tech = srv.client();
    const bt = await tech.login('tech', 'tech1234');
    assert.equal(bt.deuxFacteurs.exige, false);
    assert.equal((await tech.get('/api/notifications')).status, 200);

    // Enrôlement du pôle informatique, puis accès normal
    secretInfo = (await enroler(info, 'info1234')).secret;
    assert.equal((await info.get('/api/utilisateurs')).status, 200);

    // Obligatoire pour tous : le technicien doit s'enrôler à son tour
    avancer(30);
    await admin.ok('PUT', '/api/configuration', { securite: { deuxFacteurs: 'obligatoire_tous' } });
    const r = await tech.get('/api/equipements');
    assert.equal(r.status, 403);
    assert.equal((await tech.ok('GET', '/api/auth/me')).deuxFacteurs.enrolementRequis, true);
    const eTech = await enroler(tech, 'tech1234');
    assert.equal((await tech.get('/api/equipements')).status, 200);
    // Désactiver lorsque c'est obligatoire impose un nouvel enrôlement immédiat
    avancer(30);
    const d = await tech.ok('POST', '/api/auth/2fa/desactiver', { motDePasse: 'tech1234', code: code(eTech.secret) });
    assert.equal(d.exige, true);
    assert.equal((await tech.get('/api/equipements')).status, 403);

    avancer(30);
    await admin.ok('PUT', '/api/configuration', { securite: { deuxFacteurs: 'facultatif' } });
    assert.equal((await tech.get('/api/equipements')).status, 200, 'retour au mode facultatif');
    // L'administrateur, toujours enrôlé, se connecte en deux étapes
    avancer(30);
    assert.equal((await connecter('admin', 'admin', code(eAdmin.secret))).r2.status, 200);
  });

  test('changement de mot de passe : connexions en attente annulées, essais limités', async () => {
    reinitialiserCompteurs();
    avancer(30);
    const { c: posteA, r2 } = await connecter('info', 'info1234', code(secretInfo));
    assert.equal(r2.status, 200);
    const posteB = srv.client();
    const r1 = await posteB.post('/api/auth/login', { login: 'info', password: 'info1234' });
    assert.equal(r1.body.deuxFacteurs, true);
    // Le poste A change le mot de passe : la connexion du poste B, en attente du code, est annulée
    await posteA.ok('POST', '/api/auth/mot-de-passe', { ancien: 'info1234', nouveau: 'info-5678' });
    avancer(30);
    const r = await posteB.post('/api/auth/login/code', { jeton: r1.body.jeton, code: code(secretInfo) });
    assert.equal(r.status, 401);
    assert.equal(r.body.details.recommencer, true);
    // Mot de passe modifié par un autre chemin (restauration, import de base…) : jeton invalidé aussi
    const r3 = await posteB.post('/api/auth/login', { login: 'info', password: 'info-5678' });
    const idInfo = srv.db.findOne('users', (u) => u.login === 'info').id;
    srv.db.update('users', idInfo, { passwordHash: require('../server/auth').hashPassword('autre-mdp-9') });
    avancer(30);
    const r4 = await posteB.post('/api/auth/login/code', { jeton: r3.body.jeton, code: code(secretInfo) });
    assert.equal(r4.status, 401);
    assert.equal(r4.body.details.recommencer, true);
    const tech = srv.client();
    await tech.login('tech', 'tech1234');
    let x;
    for (let i = 0; i < 8; i++) x = await tech.post('/api/auth/mot-de-passe', { ancien: 'mauvais' + i, nouveau: 'nouveau-mdp-1' });
    assert.equal(x.status, 400);
    assert.equal((await tech.post('/api/auth/mot-de-passe', { ancien: 'tech1234', nouveau: 'nouveau-mdp-1' })).status, 429, 'essais du mot de passe actuel limités');
    reinitialiserCompteurs();
  });

  test('préférences personnelles : valeurs validées', async () => {
    const c = srv.client();
    await c.login('tech', 'tech1234');
    assert.equal((await c.put('/api/auth/preferences', { theme: '<script>' })).status, 400);
    const p = await c.ok('PUT', '/api/auth/preferences', { theme: 'sombre', listeCompacte: true, 'mauvaise clé': 1, objet: { a: 1 }, long: 'x'.repeat(500) });
    assert.equal(p.theme, 'sombre');
    assert.equal(p.listeCompacte, true);
    assert.equal(p['mauvaise clé'], undefined);
    assert.equal(p.objet, undefined);
    assert.equal(p.long, undefined);
  });
});

describe('Double authentification avec la politique de mot de passe réelle', () => {
  let srv;
  before(async () => { srv = await demarrer({ politiqueReelle: true }); });
  after(async () => { await srv.stop(); });

  test('premier démarrage avec obligation : nouveau mot de passe puis enrôlement imposés', async () => {
    let t = Date.parse('2026-10-14T09:00:05Z');
    srv.ctx.deuxFacteurs.maintenant = () => t;
    const cfg = srv.db.getConfig(); cfg.securite.deuxFacteurs = 'obligatoire_sensibles'; srv.db.setConfig(cfg);
    const admin = srv.client();
    const b = await admin.login('admin', 'admin');
    assert.equal(b.user.doitChangerMdp, true);
    assert.equal(b.deuxFacteurs.enrolementRequis, true);
    assert.equal((await admin.get('/api/equipements')).status, 403);
    await admin.ok('POST', '/api/auth/mot-de-passe', { nouveau: 'Gmao-Essai#2026' });
    const p = await admin.ok('POST', '/api/auth/2fa/preparer', { motDePasse: 'Gmao-Essai#2026' });
    await admin.ok('POST', '/api/auth/2fa/activer', { code: totp.totp(p.secret, { instant: t }) });
    assert.equal((await admin.get('/api/equipements')).status, 200);
    t += 30000;
    const c = srv.client();
    const r1 = await c.post('/api/auth/login', { login: 'admin', password: 'Gmao-Essai#2026' });
    const r2 = await c.post('/api/auth/login/code', { jeton: r1.body.jeton, code: totp.totp(p.secret, { instant: t }) });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.deuxFacteurs.enrolementRequis, false);
  });
});
