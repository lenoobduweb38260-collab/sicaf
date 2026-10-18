'use strict';
/**
 * Tests de la bibliothèque Code 128 (client/js/lib/codebarre.js) : intégrité de la table des motifs,
 * encodages de référence (jeux B et C, caractère de contrôle), translittération et refus des
 * caractères non encodables, rendu SVG, aller-retour encodage → modules → luminances simulées
 * (échelles 1 à 4, bruit, flou, sens inversé) → décodage, rejet d'un contrôle faux, décodage d'image.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CB = require('../client/js/lib/codebarre.js');

// Générateur pseudo-aléatoire déterministe (reproductible)
function generateur(graine) {
  let g = graine >>> 0;
  return () => { g = (g * 1664525 + 1013904223) >>> 0; return g / 4294967296; };
}

/** Luminances simulées : couverture des modules par pixel (échelle quelconque), flou gaussien, bruit, inversion. */
function signal(mods, echelle, { bruit = 0, flou = 0, inverse = false, phase = 0, rnd = Math.random, noir = 25, blanc = 225 } = {}) {
  const n = Math.ceil(mods.length * echelle);
  const brut = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    const a = x / echelle + phase, b = (x + 1) / echelle + phase;
    let couvert = 0;
    for (let m = Math.floor(a); m < Math.ceil(b); m++) {
      const c = Math.max(0, Math.min(b, m + 1) - Math.max(a, m));
      if (mods[m] === '1') couvert += c;
    }
    brut[x] = blanc - (couvert / (b - a)) * (blanc - noir);
  }
  let L = brut;
  if (flou > 0) {
    const r = Math.ceil(flou * 3);
    const k = [];
    let somme = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * flou * flou)); k.push(v); somme += v; }
    L = new Float64Array(n);
    for (let x = 0; x < n; x++) { let v = 0; for (let i = -r; i <= r; i++) v += brut[Math.min(n - 1, Math.max(0, x + i))] * k[i + r]; L[x] = v / somme; }
  }
  if (bruit) for (let x = 0; x < n; x++) L[x] += (rnd() * 2 - 1) * bruit;
  const out = Array.from(L);
  if (inverse) out.reverse();
  return out;
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

describe('Code 128 — table des motifs', () => {
  test('107 motifs : 0–105 sur 11 modules avec 3 barres, stop sur 13 modules, tous distincts', () => {
    assert.equal(CB.MOTIFS.length, 107);
    for (let v = 0; v <= 105; v++) {
      const m = CB.MOTIFS[v];
      assert.equal(m.length, 6, `motif ${v} : 6 éléments`);
      assert.equal(m.split('').reduce((s, c) => s + Number(c), 0), 11, `motif ${v} : 11 modules`);
      assert.equal(CB.MODULES[v].length, 11);
      assert.equal((CB.MODULES[v].match(/1+/g) || []).length, 3, `motif ${v} : 3 barres`);
      assert.ok(/^1/.test(CB.MODULES[v]) && /0$/.test(CB.MODULES[v]), `motif ${v} : commence par une barre, finit par un espace`);
      assert.equal(m.split('').filter((c, i) => i % 2 === 0).reduce((s, c) => s + Number(c), 0) % 2, 0, `motif ${v} : parité paire des barres`);
    }
    assert.equal(CB.MOTIFS[106], '2331112');
    assert.equal(CB.MODULES[106].length, 13);
    assert.equal((CB.MODULES[106].match(/1+/g) || []).length, 4);
    assert.equal(new Set(CB.MOTIFS).size, 107, 'motifs distincts');
    assert.equal(new Set(CB.MOTIFS.map((m) => m.slice(0, 6))).size, 107, 'le début du stop ne se confond avec aucun caractère');
  });

  test('valeurs de référence du cahier des charges', () => {
    const attendus = { 0: '212222', 1: '222122', 12: '112232', 33: '111323', 50: '231131', 63: '111224', 77: '413111', 99: '113141', 100: '114131', 101: '311141', 102: '411131', 103: '211412', 104: '211214', 105: '211232', 106: '2331112' };
    for (const [v, m] of Object.entries(attendus)) assert.equal(CB.MOTIFS[v], m, `valeur ${v}`);
    assert.equal(CB.MODULES[104], '11010010000', 'Start B');
    assert.equal(CB.MODULES[105], '11010011100', 'Start C');
    assert.equal(CB.MODULES[103], '11010000100', 'Start A');
    assert.equal(CB.MODULES[106], '1100011101011', 'Stop');
  });
});

describe('Code 128 — encodage', () => {
  test('« ART-0001 » : jeu B puis passage en C pour 0001, contrôle 20', () => {
    const v = CB.valeurs('ART-0001');
    assert.deepEqual(v, [104, 33, 50, 52, 13, 99, 0, 1, 20, 106]);
    // contrôle recalculé à la main : (104 + 1×33 + 2×50 + 3×52 + 4×13 + 5×99 + 6×0 + 7×1) mod 103 = 947 mod 103 = 20
    assert.equal((104 + 33 + 2 * 50 + 3 * 52 + 4 * 13 + 5 * 99 + 6 * 0 + 7 * 1) % 103, 20);
    assert.equal(CB.encoder('ART-0001').controle, 20);
  });

  test('« 12345678 » entièrement en jeu C, contrôle 47', () => {
    assert.deepEqual(CB.valeurs('12345678'), [105, 12, 34, 56, 78, 47, 106]);
    assert.equal((105 + 12 + 2 * 34 + 3 * 56 + 4 * 78) % 103, 47);
  });

  test('chaînes mixtes : suites de chiffres ≥ 4 en jeu C (impair : premier chiffre en B), retour en B', () => {
    // « EQ-12345-A » : E Q - (B) 1 (B) | C 23 45 | B - A
    assert.deepEqual(CB.valeurs('EQ-12345-A').slice(0, -2), [104, 37, 49, 13, 17, 99, 23, 45, 100, 13, 33]);
    // Moins de 4 chiffres : reste en B
    assert.deepEqual(CB.valeurs('A123').slice(0, -2), [104, 33, 17, 18, 19]);
    // Commence par 4 chiffres : start C
    assert.deepEqual(CB.valeurs('2026AB').slice(0, -2), [105, 20, 26, 100, 33, 34]);
    // Commence par 5 chiffres : start B, premier chiffre en B
    assert.deepEqual(CB.valeurs('20261').slice(0, -2), [104, 18, 99, 2, 61]);
    for (const s of ['EQ-12345-A', 'A123', '2026AB', '20261', 'INV-2026-001', 'Réf. 6205-2RS']) {
      const v = CB.valeurs(s);
      assert.equal(v[v.length - 1], 106, 'stop final');
      assert.equal(CB.controle(v[0], v.slice(1, -2)), v[v.length - 2], `contrôle de « ${s} »`);
    }
  });

  test('modules : zone de silence de 10 modules, longueur = 11 × (n + 2) + 13 + 20', () => {
    const m = CB.modules('ART-0001');
    assert.match(m, /^0{10}1/);
    assert.match(m, /10{10}$/);
    const n = CB.valeurs('ART-0001').length - 1; // symboles hors stop
    assert.equal(m.length, n * 11 + 13 + 20);
    assert.equal(CB.modules('ART-0001', { zoneSilence: 0 }).length, n * 11 + 13);
    assert.equal(CB.modules('A', { zoneSilence: 0 }).slice(0, 11), '11010010000');
  });

  test('translittération des accents (NFD) et refus clair des caractères non encodables', () => {
    assert.equal(CB.translitterer('Électrovanne Œuf — n°2 «test» ’a’'), 'Electrovanne OEuf - no2 "test" \'a\'');
    assert.deepEqual(CB.valeurs('Pièce-é'), CB.valeurs('Piece-e'));
    assert.equal(CB.encoder('Réf. Çà').texte, 'Ref. Ca');
    assert.throws(() => CB.valeurs('Pièce ✓'), /caractère non encodable.*✓/);
    assert.throws(() => CB.valeurs('ligne\nsuivante'), /non encodable.*U\+000A/);
    assert.throws(() => CB.valeurs(''), /vide/);
    assert.throws(() => CB.valeurs('X'.repeat(81)), /trop long/);
    assert.equal(CB.estEncodable('ART-0001'), true);
    assert.equal(CB.estEncodable('日本'), false);
    // Tous les caractères ASCII imprimables sont encodables (y compris l'accent grave ASCII)
    assert.equal(CB.encoder(ASCII.slice(0, 80)).texte, ASCII.slice(0, 80));
    assert.equal(CB.encoder('`~').texte, '`~');
  });

  test('SVG vectoriel : viewBox, barres en <rect>, texte lisible, unité et échappement', () => {
    const s = CB.svg('ART-0001', { hauteur: 12, largeurModule: 0.33, unite: 'mm', texteVisible: true, police: 'Consolas' });
    assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+" width="[\d.]+mm" height="[\d.]+mm"/);
    const m = CB.modules('ART-0001');
    assert.equal((s.match(/<rect /g) || []).length - 1, (m.match(/1+/g) || []).length, 'une <rect> par barre (+ fond)');
    assert.match(s, /<text [^>]*font-family="Consolas"[^>]*>ART-0001<\/text>/);
    const largeur = Number(/viewBox="0 0 ([\d.]+)/.exec(s)[1]);
    assert.ok(Math.abs(largeur - m.length * 0.33) < 1e-6);
    const sansTexte = CB.svg('A&B<1>', { texteVisible: false, fond: 'none' });
    assert.ok(!/<text/.test(sansTexte));
    assert.ok(!/<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill/.test(sansTexte), 'pas de fond');
    assert.match(CB.svg('A&B<1>'), />A&amp;B&lt;1&gt;<\/text>/);
  });
});

describe('Code 128 — décodage', () => {
  test('aller-retour sans dégradation, échelles 1 à 4, sens normal et inversé', () => {
    for (const s of ['ART-0001', '12345678', 'EQ-0042', 'INV-2026-001', 'a', '9', 'Hello World!', ASCII.slice(0, 40)]) {
      for (const e of [1, 2, 3, 4]) {
        assert.equal(CB.decoderLigne(signal(CB.modules(s), e)), s, `« ${s} » à l'échelle ${e}`);
        assert.equal(CB.decoderLigne(signal(CB.modules(s), e, { inverse: true })), s, `« ${s} » inversé à l'échelle ${e}`);
      }
    }
    const d = CB.decoderLigne(signal(CB.modules('ART-0001'), 2, { inverse: true }), { detail: true });
    assert.equal(d.sens, 'inverse');
    assert.deepEqual(d.valeurs, CB.valeurs('ART-0001'));
  });

  test('≥ 300 chaînes aléatoires : échelle 1 à 4, bruit, flou léger, sens inversé, marges et contraste variables', () => {
    const rnd = generateur(20261014);
    let ok = 0;
    const echecs = [];
    const N = 400;
    for (let n = 0; n < N; n++) {
      const longueur = 1 + Math.floor(rnd() * 24);
      let s = '';
      for (let i = 0; i < longueur; i++) s += rnd() < 0.45 ? String(Math.floor(rnd() * 10)) : ASCII[Math.floor(rnd() * ASCII.length)];
      const entier = n % 2 === 0;
      const echelle = entier ? 1 + (n >> 1) % 4 : 1.5 + rnd() * 2.5; // 1, 2, 3, 4 puis échelles non entières
      const opts = { rnd, bruit: rnd() * 14, flou: 0.15 + rnd() * 0.25 * echelle, inverse: rnd() < 0.5, phase: entier ? 0 : rnd(), noir: 10 + rnd() * 40, blanc: 190 + rnd() * 60 };
      const marge = '0'.repeat(Math.floor(rnd() * 30));
      const lu = CB.decoderLigne(signal(marge + CB.modules(s) + marge, echelle, opts));
      if (lu === s) ok++; else echecs.push({ s, echelle, lu });
    }
    assert.equal(ok, N, `échecs : ${JSON.stringify(echecs.slice(0, 5))}`);
  });

  test('éclairage non uniforme (dégradé) et zones claires bruitées', () => {
    const rnd = generateur(42);
    for (const s of ['ART-0007', 'EQ-0013', 'Roulement 6205-2RS']) {
      const L = signal(CB.modules(s), 3, { rnd, bruit: 8, flou: 0.8 });
      const degrade = L.map((v, i) => v * (0.6 + (0.4 * i) / L.length));
      assert.equal(CB.decoderLigne(degrade), s);
    }
  });

  test('rejet d\'un caractère de contrôle faux, d\'un code tronqué et d\'un signal sans code', () => {
    const v = CB.valeurs('ART-0001');
    v[v.length - 2] = (v[v.length - 2] + 1) % 103;
    const faux = '0'.repeat(10) + v.map((x) => CB.MODULES[x]).join('') + '0'.repeat(10);
    assert.equal(CB.decoderLigne(signal(faux, 2)), null, 'contrôle faux rejeté');
    const correct = CB.modules('ART-0001');
    assert.equal(CB.decoderLigne(signal(correct.slice(0, correct.length - 25), 2)), null, 'stop absent');
    assert.equal(CB.decoderLigne(signal('0'.repeat(200), 2)), null, 'signal uniforme');
    assert.equal(CB.decoderLigne([]), null);
    const rnd = generateur(7);
    assert.equal(CB.decoderLigne(Array.from({ length: 600 }, () => rnd() * 255)), null, 'bruit pur');
  });

  test('decoderImage : plusieurs lignes, vote majoritaire malgré des lignes corrompues', () => {
    const rnd = generateur(99);
    const texte = 'EQ-0042';
    const m = CB.modules(texte);
    const ech = 3, marge = 25;
    const W = m.length * ech + 2 * marge, H = 80;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const mx = Math.floor((x - marge) / ech);
        let v = mx >= 0 && mx < m.length && m[mx] === '1' ? 30 : 220;
        if (y % 5 === 0) v = rnd() * 255; // lignes parasites
        const p = (y * W + x) * 4;
        data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
      }
    }
    assert.equal(CB.decoderImage({ data, width: W, height: H }), texte);
    const d = CB.decoderImage({ data, width: W, height: H }, { detail: true });
    assert.ok(d.votes >= 8, `${d.votes} votes`);
    // Image tournée de 90° : lecture verticale
    const R = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (y * W + x) * 4, t = (x * H + y) * 4; for (let c = 0; c < 4; c++) R[t + c] = data[s + c]; }
    assert.equal(CB.decoderImage({ data: R, width: H, height: W }), texte);
    assert.equal(CB.decoderImage({ data: new Uint8ClampedArray(40 * 40 * 4).fill(255), width: 40, height: 40 }), null);
    assert.equal(CB.decoderImage(null), null);
  });

  test('interprétation des jeux A et C, SHIFT et FNC1 (codes produits par d\'autres logiciels)', () => {
    // Jeu A : « AB » puis CODE C « 1234 »
    const donnees = [33, 34, 99, 12, 34];
    const vals = [103].concat(donnees, [CB.controle(103, donnees), 106]);
    const mods = '0'.repeat(10) + vals.map((x) => CB.MODULES[x]).join('') + '0'.repeat(10);
    assert.equal(CB.decoderLigne(signal(mods, 2)), 'AB1234');
    assert.equal(CB.interpreter(104, [33, 98, 65, 34]), 'A\x01B', 'SHIFT vers le jeu A pour un caractère');
    assert.equal(CB.interpreter(105, [102, 1, 23]), '0123', 'FNC1 initial (GS1-128) ignoré');
  });
});

describe('Douchette (émulation clavier)', () => {
  /** Simulation minimale d'un document et d'événements clavier. */
  function simulation() {
    const ecouteurs = [];
    const doc = { activeElement: null, addEventListener: (t, f) => ecouteurs.push(f), removeEventListener: (t, f) => { const i = ecouteurs.indexOf(f); if (i >= 0) ecouteurs.splice(i, 1); } };
    let horloge = 1000;
    const avancer = (ms) => { horloge += ms; };
    const touche = (key, cible) => { const ev = { key, target: cible || { tagName: 'BODY' }, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }; ecouteurs.slice().forEach((f) => f(ev)); return ev; };
    return { doc, ecouteurs, avancer, touche, now: () => horloge };
  }

  test('saisie rapide terminée par Entrée hors champ de saisie → code ; saisie lente ou dans un champ ignorée', () => {
    const sim = simulation();
    const origNow = global.performance.now;
    global.performance.now = () => sim.now();
    try {
      const lus = [];
      const stop = CB.ecouterDouchette((c) => lus.push(c), { cible: sim.doc });
      const scanner = (txt, delai, cible) => { for (const ch of txt) { sim.touche(ch, cible); sim.avancer(delai); } return sim.touche('Enter', cible); };
      const ev = scanner('ART-0001', 8);
      assert.deepEqual(lus, ['ART-0001']);
      assert.equal(ev.defaultPrevented, true, 'Entrée consommée');
      scanner('ART-0002', 120); // frappe humaine
      assert.deepEqual(lus, ['ART-0001']);
      scanner('ART-0003', 5, { tagName: 'INPUT', type: 'text' }); // dans un champ : ignoré
      scanner('AB', 5); // trop court
      assert.deepEqual(lus, ['ART-0001']);
      // Shift (majuscules) ne rompt pas la saisie
      for (const k of ['Shift', 'E', 'Shift', 'Q', '-', '1']) { sim.touche(k); sim.avancer(6); }
      sim.touche('Enter');
      assert.deepEqual(lus, ['ART-0001', 'EQ-1']);
      stop();
      assert.equal(sim.ecouteurs.length, 0, 'désinscription');
      scanner('ART-0004', 5);
      assert.equal(lus.length, 2);
    } finally { global.performance.now = origNow; }
  });

  test('option actif : aucune touche interceptée quand l\'écoute est inactive (module désactivé)', () => {
    const sim = simulation();
    const origNow = global.performance.now;
    global.performance.now = () => sim.now();
    try {
      const lus = [];
      let actif = false;
      const stop = CB.ecouterDouchette((c) => lus.push(c), { cible: sim.doc, actif: () => actif });
      const scanner = (txt) => { const evs = []; for (const ch of txt) { evs.push(sim.touche(ch)); sim.avancer(5); } evs.push(sim.touche('Enter')); return evs; };
      const evs = scanner('ART-0001');
      assert.deepEqual(lus, []);
      assert.ok(evs.every((e) => !e.defaultPrevented), 'aucune touche consommée');
      actif = true;
      scanner('ART-0002');
      assert.deepEqual(lus, ['ART-0002']);
      stop();
    } finally { global.performance.now = origNow; }
  });

  test('suivreFrappe : saisie complète à la vitesse d\'une douchette, frappe humaine, correction, collage', () => {
    let horloge = 5000;
    const origNow = global.performance.now;
    global.performance.now = () => horloge;
    try {
      const ecouteurs = [];
      const champ = { value: '', addEventListener: (t, f) => ecouteurs.push(f), removeEventListener: (t, f) => { const i = ecouteurs.indexOf(f); if (i >= 0) ecouteurs.splice(i, 1); } };
      const touche = (key) => { ecouteurs.forEach((f) => f({ key, ctrlKey: false, metaKey: false })); if (key.length === 1) champ.value += key; else if (key === 'Backspace') champ.value = champ.value.slice(0, -1); };
      const taper = (txt, delai) => { for (const ch of txt) { touche(ch); horloge += delai; } };
      const f = CB.suivreFrappe(champ);
      taper('104523', 6);
      assert.equal(f.rapide(), true, 'douchette');
      champ.value = ''; f.reinitialiser();
      taper('12', 6);
      assert.equal(f.rapide(), false, 'trop court');
      champ.value = '';
      taper('125', 140);
      assert.equal(f.rapide(), false, 'frappe humaine');
      champ.value = '';
      taper('1045', 6); touche('Backspace'); taper('9', 6);
      assert.equal(f.rapide(), false, 'correction au clavier');
      champ.value = '104523';
      assert.equal(f.rapide(), false, 'valeur collée');
      champ.value = '';
      taper('5', 400); taper('104523', 6);
      assert.equal(f.rapide(), false, 'début de saisie humaine');
      f.arreter();
      assert.equal(ecouteurs.length, 0);
    } finally { global.performance.now = origNow; }
  });

  test('estChampSaisie : champs texte, zones de texte, listes et contenus éditables', () => {
    assert.equal(CB.estChampSaisie({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(CB.estChampSaisie({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(CB.estChampSaisie({ tagName: 'TEXTAREA' }), true);
    assert.equal(CB.estChampSaisie({ tagName: 'SELECT' }), true);
    assert.equal(CB.estChampSaisie({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(CB.estChampSaisie({ tagName: 'BUTTON' }), false);
    assert.equal(CB.estChampSaisie(null), false);
  });

  test('caméra : message clair hors navigateur / contexte non sécurisé ; bip sans WebAudio sans erreur', async () => {
    await assert.rejects(() => CB.camera({}, () => {}), /caméra|navigateur/i);
    assert.equal(CB.bip(true), false);
  });
});
