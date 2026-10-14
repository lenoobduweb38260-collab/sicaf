/**
 * Bibliothèque Code 128 (zéro dépendance) : encodage, rendu SVG vectoriel, décodage logiciel,
 * douchettes USB / Bluetooth (émulation clavier), caméra et bips sonores.
 *
 *   CodeBarre.svg('ART-0001', { hauteur: 12, largeurModule: 0.33, unite: 'mm' })  → chaîne SVG
 *   CodeBarre.modules('ART-0001')        → '0000000000110100100001…' (zones de silence incluses)
 *   CodeBarre.valeurs('ART-0001')        → [104, 33, 50, 52, 13, 99, 0, 1, 20, 106]
 *   CodeBarre.decoderLigne(luminances)   → 'ART-0001' | null
 *   CodeBarre.decoderImage(imageData)    → 'ART-0001' | null (plusieurs lignes, vote majoritaire)
 *   const stop = CodeBarre.ecouterDouchette((code) => …)  ;  stop()
 *   const cam = await CodeBarre.camera(videoEl, (code) => …) ;  cam.arreter()
 *   CodeBarre.bip(true) / CodeBarre.bip(false)
 *
 * Jeux utilisés à l'encodage : B (ASCII 32 à 126) et C (paires de chiffres) avec optimisation :
 * passage en C pour toute suite d'au moins 4 chiffres, retour en B ensuite. Le décodeur sait lire
 * les trois jeux (A, B, C), SHIFT et FNC1, dans les deux sens de lecture.
 */
(function (racine, fabrique) {
  'use strict';
  const CodeBarre = fabrique(racine);
  if (typeof module !== 'undefined' && module.exports) module.exports = CodeBarre;
  if (typeof window !== 'undefined') window.CodeBarre = CodeBarre;
})(typeof window !== 'undefined' ? window : null, function (racine) {
  'use strict';

  // ----- Table des motifs (largeurs barre / espace / barre / espace / barre / espace) ---------
  const MOTIFS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  const START_A = 103;
  const START_B = 104;
  const START_C = 105;
  const STOP = 106;
  const SHIFT = 98;
  const CODE_C = 99;
  const CODE_B = 100;
  const CODE_A = 101;
  const FNC1 = 102;
  const ZONE_SILENCE = 10;
  const LONGUEUR_MAX = 80;

  /** Motif → modules ('1' = barre, '0' = espace). */
  function motifEnModules(motif) {
    let s = '';
    for (let i = 0; i < motif.length; i++) s += (i % 2 === 0 ? '1' : '0').repeat(Number(motif[i]));
    return s;
  }
  const MODULES_PAR_VALEUR = MOTIFS.map(motifEnModules);
  // Motifs numériques pour la reconnaissance (le stop est comparé sur ses 6 premiers éléments + 1)
  const MOTIFS_NUM = MOTIFS.map((m) => m.slice(0, 6).split('').map(Number));

  // ----- Translittération ---------------------------------------------------------------
  /** Classe de caractères construite à partir de points de code (lisible, sans caractère invisible dans le source). */
  const classe = (...codes) => new RegExp('[' + codes.map((c) => String.fromCharCode(c)).join('') + ']', 'g');
  const DIACRITIQUES = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
  const REMPLACEMENTS = [
    [classe(0x2018, 0x2019, 0x201A, 0x201B, 0x2032, 0xB4), "'"], // apostrophes typographiques
    [classe(0x201C, 0x201D, 0x201E, 0x201F, 0xAB, 0xBB, 0x2033), '"'], // guillemets
    [classe(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212), '-'], // tirets
    [classe(0xA0, 0x2002, 0x2003, 0x2007, 0x2009, 0x202F), ' '], // espaces insécables / fines
    [classe(0x2026), '...'], [/œ/g, 'oe'], [/Œ/g, 'OE'], [/æ/g, 'ae'], [/Æ/g, 'AE'], [/ß/g, 'ss'], [/ø/g, 'o'], [/Ø/g, 'O'],
    [/đ/g, 'd'], [/Đ/g, 'D'], [/ł/g, 'l'], [/Ł/g, 'L'], [/°/g, 'o'], [/€/g, 'EUR'], [/²/g, '2'], [/³/g, '3'], [/×/g, 'x'], [/µ/g, 'u'],
  ];
  /** Translittère les caractères accentués (NFD) et quelques symboles courants vers l'ASCII. */
  function translitterer(texte) {
    let s = String(texte == null ? '' : texte);
    for (const [re, r] of REMPLACEMENTS) s = s.replace(re, r);
    return s.normalize('NFD').replace(DIACRITIQUES, '');
  }

  /** Texte prêt à encoder (translittéré, contrôlé) ; lève une erreur claire sinon. */
  function preparer(texte) {
    const s = translitterer(texte);
    if (!s.length) throw new Error('Code-barres : texte vide, rien à encoder');
    if (s.length > LONGUEUR_MAX) throw new Error(`Code-barres : texte trop long (${s.length} caractères, ${LONGUEUR_MAX} au maximum)`);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32 || c > 126) {
        const car = s[i];
        const affiche = c < 32 || c === 127 ? `U+${c.toString(16).toUpperCase().padStart(4, '0')}` : car;
        throw new Error(`Code-barres : caractère non encodable en Code 128 « ${affiche} » (position ${i + 1}). Seuls les caractères ASCII imprimables sont acceptés.`);
      }
    }
    return s;
  }

  function estChiffre(s, i) { const c = s.charCodeAt(i); return c >= 48 && c <= 57; }
  function longueurChiffres(s, i) { let j = i; while (j < s.length && estChiffre(s, j)) j++; return j - i; }

  /** Valeurs de données (sans start / contrôle / stop) et valeur de start. */
  function valeursDonnees(s) {
    const out = [];
    let jeu = null;
    let start = null;
    const passer = (cible) => {
      if (jeu === cible) return;
      if (jeu === null) start = cible === 'C' ? START_C : START_B;
      else out.push(cible === 'C' ? CODE_C : CODE_B);
      jeu = cible;
    };
    let i = 0;
    while (i < s.length) {
      const n = longueurChiffres(s, i);
      if (n >= 4) {
        if (n % 2 === 1) { passer('B'); out.push(s.charCodeAt(i) - 32); i++; }
        passer('C');
        const fin = i + n - (n % 2 === 1 ? 1 : 0);
        for (; i < fin; i += 2) out.push(Number(s.substr(i, 2)));
      } else {
        passer('B');
        out.push(s.charCodeAt(i) - 32);
        i++;
      }
    }
    return { start, donnees: out };
  }

  /** Caractère de contrôle modulo 103. */
  function controle(start, donnees) {
    let somme = start;
    for (let i = 0; i < donnees.length; i++) somme += (i + 1) * donnees[i];
    return somme % 103;
  }

  /** Encodage complet : { texte (translittéré), valeurs [start, …, contrôle, stop], controle }. */
  function encoder(texte) {
    const s = preparer(texte);
    const { start, donnees } = valeursDonnees(s);
    const c = controle(start, donnees);
    return { texte: s, valeurs: [start].concat(donnees, [c, STOP]), controle: c };
  }
  function valeurs(texte) { return encoder(texte).valeurs; }

  /** Chaîne de modules, zones de silence comprises (10 modules par défaut). */
  function modules(texte, options) {
    const zs = options && options.zoneSilence != null ? Math.max(0, Number(options.zoneSilence) || 0) : ZONE_SILENCE;
    const marge = '0'.repeat(zs);
    return marge + valeurs(texte).map((v) => MODULES_PAR_VALEUR[v]).join('') + marge;
  }

  function estEncodable(texte) { try { preparer(texte); return true; } catch (e) { return false; } }

  function escXml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
  const fmt = (n) => String(Math.round(Number(n) * 10000) / 10000);

  /**
   * Rendu SVG vectoriel (barres en <rect>, viewBox dans l'unité choisie).
   * options : hauteur (50), largeurModule (2), texteVisible (true), police ('monospace'), taillePolice,
   *           unite ('' = unités utilisateur, ou 'mm', 'px'…), couleur ('#000'), fond ('#fff' ou 'none'),
   *           zoneSilence (10), texteAffiche (texte sous le code, défaut : texte encodé), classe.
   */
  function svg(texte, options) {
    const o = Object.assign({ hauteur: 50, largeurModule: 2, texteVisible: true, police: 'monospace', unite: '', couleur: '#000', fond: '#fff', zoneSilence: ZONE_SILENCE }, options || {});
    const enc = encoder(texte);
    const mods = modules(texte, { zoneSilence: o.zoneSilence });
    const lm = Number(o.largeurModule) > 0 ? Number(o.largeurModule) : 2;
    const h = Number(o.hauteur) > 0 ? Number(o.hauteur) : 50;
    const tp = Number(o.taillePolice) > 0 ? Number(o.taillePolice) : Math.max(lm * 9, h * 0.22);
    const largeur = mods.length * lm;
    const hauteurTexte = o.texteVisible ? tp * 1.2 : 0;
    const hauteurTotale = h + hauteurTexte;
    const rects = [];
    let i = 0;
    while (i < mods.length) {
      if (mods[i] === '1') {
        let j = i; while (j < mods.length && mods[j] === '1') j++;
        rects.push(`<rect x="${fmt(i * lm)}" y="0" width="${fmt((j - i) * lm)}" height="${fmt(h)}"/>`);
        i = j;
      } else i++;
    }
    const u = o.unite || '';
    const affiche = o.texteAffiche != null ? String(o.texteAffiche) : enc.texte;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(largeur)} ${fmt(hauteurTotale)}" width="${fmt(largeur)}${u}" height="${fmt(hauteurTotale)}${u}" shape-rendering="crispEdges" role="img" aria-label="Code-barres ${escXml(enc.texte)}"${o.classe ? ` class="${escXml(o.classe)}"` : ''}>`
      + (o.fond && o.fond !== 'none' ? `<rect x="0" y="0" width="${fmt(largeur)}" height="${fmt(hauteurTotale)}" fill="${escXml(o.fond)}"/>` : '')
      + `<g fill="${escXml(o.couleur)}">${rects.join('')}</g>`
      + (o.texteVisible ? `<text x="${fmt(largeur / 2)}" y="${fmt(h + tp * 1.02)}" text-anchor="middle" font-family="${escXml(o.police)}" font-size="${fmt(tp)}" fill="${escXml(o.couleur)}">${escXml(affiche)}</text>` : '')
      + '</svg>';
  }

  // ----- Décodage ---------------------------------------------------------------------------
  /** Minimum et maximum glissants sur une fenêtre [i - w, i + w] (files monotones, O(n)). */
  function minMaxGlissants(L, w) {
    const n = L.length;
    const mins = new Float64Array(n);
    const maxs = new Float64Array(n);
    const fMin = new Int32Array(n); const fMax = new Int32Array(n);
    let t1 = 0, q1 = 0, t2 = 0, q2 = 0, r = 0;
    for (let i = 0; i < n; i++) {
      const fin = Math.min(n - 1, i + w);
      while (r <= fin) {
        while (q1 > t1 && L[fMin[q1 - 1]] >= L[r]) q1--;
        fMin[q1++] = r;
        while (q2 > t2 && L[fMax[q2 - 1]] <= L[r]) q2--;
        fMax[q2++] = r;
        r++;
      }
      const debut = i - w;
      while (fMin[t1] < debut) t1++;
      while (fMax[t2] < debut) t2++;
      mins[i] = L[fMin[t1]];
      maxs[i] = L[fMax[t2]];
    }
    return { mins, maxs };
  }

  /** Seuils par pixel : global (milieu de la dynamique) ou adaptatif (milieu local min / max). */
  function seuils(L, adaptatif) {
    const n = L.length;
    let gmin = Infinity, gmax = -Infinity;
    for (let i = 0; i < n; i++) { if (L[i] < gmin) gmin = L[i]; if (L[i] > gmax) gmax = L[i]; }
    const amplitude = gmax - gmin;
    if (!(amplitude > 0)) return null;
    const milieu = (gmin + gmax) / 2;
    const T = new Float64Array(n);
    if (!adaptatif) { T.fill(milieu); return { T, amplitude }; }
    const w = Math.max(6, Math.min(80, Math.round(n / 45)));
    const { mins, maxs } = minMaxGlissants(L, w);
    // Zones uniformes (zones de silence, larges barres) : seuil local valide le plus proche,
    // ce qui résiste aux éclairages non homogènes mieux que le seuil global.
    const valide = new Uint8Array(n);
    let nbValides = 0;
    for (let i = 0; i < n; i++) {
      if (maxs[i] - mins[i] >= amplitude * 0.3) { T[i] = (mins[i] + maxs[i]) / 2; valide[i] = 1; nbValides++; }
    }
    if (!nbValides) { T.fill(milieu); return { T, amplitude }; }
    const gauche = new Int32Array(n).fill(-1);
    let dernier = -1;
    for (let i = 0; i < n; i++) { if (valide[i]) dernier = i; gauche[i] = dernier; }
    dernier = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (valide[i]) { dernier = i; continue; }
      const g = gauche[i];
      const src = g < 0 ? dernier : (dernier < 0 ? g : (i - g <= dernier - i ? g : dernier));
      T[i] = src < 0 ? milieu : T[src];
    }
    return { T, amplitude };
  }

  /** Plages (sombre / claire) avec bords interpolés au sous-pixel. */
  function plages(L, T) {
    const n = L.length;
    const out = [];
    let sombre = L[0] < T[0];
    let debut = 0;
    for (let i = 1; i < n; i++) {
      const s = L[i] < T[i];
      if (s === sombre) continue;
      const t = (T[i - 1] + T[i]) / 2;
      const a = L[i - 1], c = L[i];
      let pos = i - 0.5;
      if (a !== c) pos = Math.min(i, Math.max(i - 1, (i - 1) + (t - a) / (c - a)));
      out.push({ sombre, largeur: Math.max(1e-6, pos - debut) });
      debut = pos;
      sombre = s;
    }
    out.push({ sombre, largeur: Math.max(1e-6, n - debut) });
    return out;
  }

  // Mesures « bord à bord de même sens » (barre + espace adjacents) des motifs : insensibles à
  // l'élargissement / l'amincissement uniforme des barres (encre, flou, seuil). Les 107 quadruplets sont distincts.
  const MESURES_T = MOTIFS_NUM.map((p) => [p[0] + p[1], p[1] + p[2], p[2] + p[3], p[3] + p[4]]);
  const TOLERANCE = 1.5;
  /** Identifie le symbole formé par 6 plages à partir de l'indice k (normalisation sur 11 modules). */
  function identifier(runs, k) {
    if (k + 6 > runs.length) return null;
    let S = 0;
    for (let j = 0; j < 6; j++) S += runs[k + j].largeur;
    if (!(S > 0)) return null;
    const e = [];
    for (let j = 0; j < 6; j++) e.push((runs[k + j].largeur * 11) / S);
    const t = [e[0] + e[1], e[1] + e[2], e[2] + e[3], e[3] + e[4]];
    let meilleur = -1, score = Infinity, dist = Infinity;
    for (let v = 0; v < MOTIFS_NUM.length; v++) {
      const pt = MESURES_T[v];
      const dT = Math.abs(t[0] - pt[0]) + Math.abs(t[1] - pt[1]) + Math.abs(t[2] - pt[2]) + Math.abs(t[3] - pt[3]);
      if (dT >= score) continue;
      const p = MOTIFS_NUM[v];
      let dE = 0;
      for (let j = 0; j < 6; j++) dE += Math.abs(e[j] - p[j]);
      const sc = dT + 0.25 * dE;
      if (sc < score) { score = sc; meilleur = v; dist = dT; }
    }
    return { valeur: meilleur, dist, module: S / 11 };
  }

  /** Interprète les valeurs de données selon les jeux A / B / C. */
  function interpreter(start, donnees) {
    let jeu = start === START_A ? 'A' : (start === START_B ? 'B' : 'C');
    let out = '';
    let decale = false;
    for (let i = 0; i < donnees.length; i++) {
      const v = donnees[i];
      const j = decale ? (jeu === 'A' ? 'B' : 'A') : jeu;
      decale = false;
      if (j === 'C') {
        if (v < 100) out += (v < 10 ? '0' : '') + v;
        else if (v === CODE_B) jeu = 'B';
        else if (v === CODE_A) jeu = 'A';
        else if (v === FNC1) { if (i > 0) out += '\x1d'; } else return null;
        continue;
      }
      if (v < 96) {
        if (j === 'A') out += String.fromCharCode(v < 64 ? v + 32 : v - 64);
        else out += String.fromCharCode(v + 32);
      } else if (v === SHIFT) decale = true;
      else if (v === CODE_C) jeu = 'C';
      else if (v === CODE_B) { if (j === 'A') jeu = 'B'; }
      else if (v === CODE_A) { if (j === 'B') jeu = 'A'; }
      else if (v === FNC1) { if (i > 0) out += '\x1d'; }
      // 96 (FNC3) et 97 (FNC2) : ignorés
    }
    return out;
  }

  /** Décode à partir d'un start trouvé à l'indice j. */
  function decoderDepuis(runs, j, start) {
    const vals = [start];
    let k = j + 6;
    let fini = false;
    while (k + 6 <= runs.length) {
      const id = identifier(runs, k);
      if (!id || id.dist > TOLERANCE) return null;
      if (id.valeur === STOP) {
        if (k + 6 >= runs.length) return null;
        const septieme = runs[k + 6].largeur / id.module;
        if (!runs[k + 6].sombre || Math.abs(septieme - 2) > 1.1) return null;
        if (k + 7 < runs.length && runs[k + 7].largeur < id.module * 3) return null; // zone de silence après le stop
        vals.push(STOP);
        fini = true;
        break;
      }
      if (id.valeur >= START_A) return null;
      vals.push(id.valeur);
      k += 6;
      if (vals.length > LONGUEUR_MAX * 2 + 4) return null;
    }
    if (!fini || vals.length < 4) return null;
    const ctrl = vals[vals.length - 2];
    const donnees = vals.slice(1, -2);
    if (controle(start, donnees) !== ctrl) return null;
    const texte = interpreter(start, donnees);
    if (texte == null || !texte.length) return null;
    return { texte, valeurs: vals };
  }

  /** Recherche d'un start (A, B ou C) précédé d'une zone claire, puis décodage. */
  function decoderPlages(runs) {
    for (let j = 1; j + 7 < runs.length; j++) {
      if (!runs[j].sombre) continue;
      const id = identifier(runs, j);
      if (!id || id.dist > TOLERANCE || id.valeur < START_A || id.valeur > START_C) continue;
      if (runs[j - 1].largeur < id.module * 4) continue; // zone de silence avant le start
      const r = decoderDepuis(runs, j, id.valeur);
      if (r) return r;
    }
    return null;
  }

  /**
   * Décode une ligne de luminances (tableau de nombres, sombre = faible).
   * Seuillage global puis adaptatif ; sens normal puis inversé.
   * @returns {string|null} (ou { texte, valeurs, sens } avec { detail: true })
   */
  function decoderLigne(luminances, options) {
    const L = luminances instanceof Float64Array ? luminances : Float64Array.from(luminances || [], (x) => Number(x) || 0);
    if (L.length < 30) return null;
    for (const adaptatif of [false, true]) {
      const s = seuils(L, adaptatif);
      if (!s) return null;
      const runs = plages(L, s.T);
      if (runs.length < 27) continue; // start + 1 caractère + contrôle + stop (25 plages) + 2 zones claires
      const normal = decoderPlages(runs);
      if (normal) return options && options.detail ? Object.assign(normal, { sens: 'normal' }) : normal.texte;
      const inverse = decoderPlages(runs.slice().reverse());
      if (inverse) return options && options.detail ? Object.assign(inverse, { sens: 'inverse' }) : inverse.texte;
    }
    return null;
  }

  function luminanceLigne(img, y, epaisseur) {
    const { data, width, height } = img;
    const out = new Float64Array(width);
    const y0 = Math.max(0, y - epaisseur), y1 = Math.min(height - 1, y + epaisseur);
    const nb = y1 - y0 + 1;
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let yy = y0; yy <= y1; yy++) { const p = (yy * width + x) * 4; s += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; }
      out[x] = s / nb;
    }
    return out;
  }
  function luminanceColonne(img, x, epaisseur) {
    const { data, width, height } = img;
    const out = new Float64Array(height);
    const x0 = Math.max(0, x - epaisseur), x1 = Math.min(width - 1, x + epaisseur);
    const nb = x1 - x0 + 1;
    for (let y = 0; y < height; y++) {
      let s = 0;
      for (let xx = x0; xx <= x1; xx++) { const p = (y * width + xx) * 4; s += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; }
      out[y] = s / nb;
    }
    return out;
  }

  /**
   * Décode une image ({ data RGBA, width, height }, ex. ImageData d'un canvas) : plusieurs lignes
   * horizontales (puis verticales si rien n'est trouvé), vote majoritaire.
   * options : { lignes: 15, vertical: true, detail: false }
   */
  function decoderImage(img, options) {
    const o = Object.assign({ lignes: 15, vertical: true }, options || {});
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return null;
    const votes = new Map();
    const voter = (t) => { if (t) votes.set(t, (votes.get(t) || 0) + 1); };
    const n = Math.max(1, o.lignes);
    for (let i = 0; i < n; i++) {
      const y = Math.round(img.height * (0.1 + (0.8 * (i + 0.5)) / n));
      voter(decoderLigne(luminanceLigne(img, y, 1)));
    }
    if (!votes.size && o.vertical) {
      const m = Math.max(1, Math.round(n / 2));
      for (let i = 0; i < m; i++) {
        const x = Math.round(img.width * (0.1 + (0.8 * (i + 0.5)) / m));
        voter(decoderLigne(luminanceColonne(img, x, 1)));
      }
    }
    if (!votes.size) return null;
    let meilleur = null, max = 0;
    for (const [t, nb] of votes) if (nb > max) { meilleur = t; max = nb; }
    return o.detail ? { texte: meilleur, votes: max, lectures: Array.from(votes.values()).reduce((a, b) => a + b, 0) } : meilleur;
  }

  // ----- Douchette (émulation clavier) ---------------------------------------------------------
  function estChampSaisie(t) {
    if (!t || !t.tagName) return false;
    const tag = String(t.tagName).toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = String(t.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
    }
    return !!t.isContentEditable;
  }

  /**
   * Écoute les saisies très rapides terminées par Entrée (douchette en émulation clavier) quand le
   * focus n'est PAS dans un champ de saisie. Retourne une fonction de désinscription.
   * options : { delaiMaxMs: 35, longueurMin: 3, delaiFinMs: 100, touchesFin: ['Enter'], cible: document }
   */
  function ecouterDouchette(callback, options) {
    const o = Object.assign({ delaiMaxMs: 35, longueurMin: 3, delaiFinMs: 100, touchesFin: ['Enter'] }, options || {});
    const cible = o.cible || (typeof document !== 'undefined' ? document : null);
    if (!cible || typeof callback !== 'function') return () => {};
    const maintenant = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    let tampon = '';
    let dernier = 0;
    function surTouche(ev) {
      if (estChampSaisie(ev.target) || (typeof document !== 'undefined' && estChampSaisie(document.activeElement))) { tampon = ''; return; }
      const altGr = typeof ev.getModifierState === 'function' && ev.getModifierState('AltGraph');
      if ((ev.ctrlKey || ev.metaKey || ev.altKey) && !altGr) { tampon = ''; return; }
      const t = maintenant();
      if (o.touchesFin.includes(ev.key)) {
        const code = tampon;
        const recent = t - dernier <= o.delaiFinMs;
        tampon = '';
        if (code.length >= o.longueurMin && recent) {
          ev.preventDefault();
          ev.stopPropagation();
          try { callback(code, ev); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
        }
        return;
      }
      if (!ev.key || ev.key.length !== 1) return; // Shift, CapsLock… : ignorés sans rompre la saisie
      if (tampon && t - dernier > o.delaiMaxMs) tampon = '';
      if (tampon) ev.preventDefault(); // saisie rapide en cours : pas de défilement par la barre d'espace, etc.
      tampon += ev.key;
      dernier = t;
    }
    cible.addEventListener('keydown', surTouche, true);
    return () => cible.removeEventListener('keydown', surTouche, true);
  }

  // ----- Caméra ---------------------------------------------------------------------------------
  function messageCamera(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return 'Accès à la caméra refusé : autorisez la caméra pour ce site dans les paramètres du navigateur, puis réessayez.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'Aucune caméra n\'a été détectée sur ce poste.';
    if (n === 'NotReadableError' || n === 'TrackStartError') return 'La caméra est déjà utilisée par une autre application.';
    return 'Caméra indisponible' + (e && e.message ? ' : ' + e.message : '.');
  }

  /**
   * Démarre la lecture par caméra (caméra arrière si disponible). BarcodeDetector natif ('code_128')
   * si le navigateur le propose, sinon décodeur intégré sur des images capturées (~8 / s).
   * @returns {Promise<{ arreter(): void, mode: 'natif'|'integre' }>} — rejet avec un message clair si indisponible.
   * options : { intervalleMs: 125, delaiRepetitionMs: 1500, largeurMax: 960 }
   */
  async function camera(videoEl, callback, options) {
    const o = Object.assign({ intervalleMs: 125, delaiRepetitionMs: 1500, largeurMax: 960 }, options || {});
    const w = racine || (typeof window !== 'undefined' ? window : null);
    const nav = w && w.navigator;
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      if (w && w.isSecureContext === false) throw new Error('La caméra n\'est accessible que sur une connexion sécurisée (https) ou depuis ce poste (http://localhost). Utilisez une douchette ou saisissez le code au clavier.');
      throw new Error('Ce navigateur ne permet pas d\'accéder à la caméra. Utilisez une douchette ou saisissez le code au clavier.');
    }
    let flux;
    try {
      flux = await nav.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      throw new Error(messageCamera(e));
    }
    let actif = true;
    let minuteur = null;
    let detecteur = null;
    let mode = 'integre';
    try {
      if (w.BarcodeDetector && typeof w.BarcodeDetector.getSupportedFormats === 'function') {
        const formats = await w.BarcodeDetector.getSupportedFormats();
        if (formats.includes('code_128')) { detecteur = new w.BarcodeDetector({ formats: ['code_128'] }); mode = 'natif'; }
      }
    } catch (e) { detecteur = null; mode = 'integre'; }
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    videoEl.srcObject = flux;
    try { await videoEl.play(); } catch (e) { /* lecture automatique : la vidéo démarre au premier rendu */ }
    const canvas = w.document.createElement('canvas');
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    let dernierCode = '';
    let dernierInstant = 0;
    const emettre = (code, source) => {
      const t = Date.now();
      if (code === dernierCode && t - dernierInstant < o.delaiRepetitionMs) return;
      dernierCode = code; dernierInstant = t;
      try { callback(code, { source }); } catch (e) { if (w.console) w.console.error(e); }
    };
    async function analyser() {
      if (!actif) return;
      try {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          let lu = null;
          if (detecteur) {
            try {
              const res = await detecteur.detect(videoEl);
              if (res && res.length) lu = res[0].rawValue;
            } catch (e) { detecteur = null; mode = 'integre'; }
          }
          if (!lu && !detecteur) {
            const echelle = Math.min(1, o.largeurMax / videoEl.videoWidth);
            canvas.width = Math.round(videoEl.videoWidth * echelle);
            canvas.height = Math.round(videoEl.videoHeight * echelle);
            c2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            lu = decoderImage(c2d.getImageData(0, 0, canvas.width, canvas.height), { lignes: 12 });
          }
          if (lu && actif) emettre(lu, detecteur ? 'natif' : 'integre');
        }
      } catch (e) { /* image suivante */ }
      if (actif) minuteur = setTimeout(analyser, o.intervalleMs);
    }
    minuteur = setTimeout(analyser, o.intervalleMs);
    return {
      get mode() { return mode; },
      arreter() {
        actif = false;
        if (minuteur) clearTimeout(minuteur);
        try { flux.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
        try { videoEl.pause(); videoEl.srcObject = null; } catch (e) { /* ignore */ }
      },
    };
  }

  // ----- Bips (WebAudio) ------------------------------------------------------------------------
  let contexteAudio = null;
  /** Bip court et aigu (succès) ou double bip grave (erreur). */
  function bip(ok) {
    try {
      const w = racine || (typeof window !== 'undefined' ? window : null);
      const AC = w && (w.AudioContext || w.webkitAudioContext);
      if (!AC) return false;
      if (!contexteAudio) contexteAudio = new AC();
      if (contexteAudio.state === 'suspended' && contexteAudio.resume) contexteAudio.resume();
      const t0 = contexteAudio.currentTime + 0.01;
      const notes = ok === false ? [[220, 0, 0.16], [165, 0.2, 0.24]] : [[1760, 0, 0.09]];
      for (const [freq, decalage, duree] of notes) {
        const osc = contexteAudio.createOscillator();
        const gain = contexteAudio.createGain();
        osc.type = ok === false ? 'square' : 'sine';
        osc.frequency.setValueAtTime(freq, t0 + decalage);
        gain.gain.setValueAtTime(0.0001, t0 + decalage);
        gain.gain.exponentialRampToValueAtTime(ok === false ? 0.12 : 0.25, t0 + decalage + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decalage + duree);
        osc.connect(gain); gain.connect(contexteAudio.destination);
        osc.start(t0 + decalage); osc.stop(t0 + decalage + duree + 0.02);
      }
      return true;
    } catch (e) { return false; }
  }

  return {
    MOTIFS: MOTIFS.slice(), MODULES: MODULES_PAR_VALEUR.slice(), ZONE_SILENCE,
    START_A, START_B, START_C, STOP, CODE_A, CODE_B, CODE_C, FNC1, SHIFT, LONGUEUR_MAX,
    translitterer, preparer, estEncodable, encoder, valeurs, modules, svg, controle,
    decoderLigne, decoderImage, interpreter,
    ecouterDouchette, estChampSaisie, camera, bip,
  };
});
