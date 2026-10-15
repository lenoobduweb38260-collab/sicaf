/**
 * Générateur de QR code (ISO/IEC 18004), sans dépendance.
 *
 *   QRCode.svg('otpauth://totp/...')        → chaîne SVG (image vectorielle autonome)
 *   QRCode.element('otpauth://totp/...')    → élément <svg> construit sans innerHTML
 *   QRCode.matrice('texte', { niveau })     → { version, taille, niveau, masque, modules: boolean[][] }
 *
 * Mode octet (UTF-8), niveau de correction d'erreur M par défaut (L, M, Q, H disponibles),
 * versions 1 à 40, choix du masque par calcul des pénalités, codes de Reed-Solomon sur GF(256).
 * Utilisable dans le navigateur (window.QRCode) et dans Node (require) pour les tests.
 */
(function (racine) {
  'use strict';

  const NIVEAUX = { L: 0, M: 1, Q: 2, H: 3 };
  /** Bits de niveau dans les informations de format (L=01, M=00, Q=11, H=10). */
  const BITS_NIVEAU = [1, 0, 3, 2];

  // Nombre de codewords de correction par bloc et nombre de blocs, par niveau puis par version (index 1 à 40).
  const EC_PAR_BLOC = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NB_BLOCS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // ----- Corps de Galois GF(256), polynôme primitif x^8 + x^4 + x^3 + x^2 + 1 (0x11D) -----------
  const EXP = new Array(512);
  const LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function mul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

  /** Polynôme générateur de degré n : (x - α^0)(x - α^1)…(x - α^(n-1)), coefficients du degré le plus haut au plus bas. */
  function generateur(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const suivant = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        suivant[j] ^= g[j];
        suivant[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = suivant;
    }
    return g;
  }

  /** Codewords de correction de Reed-Solomon (reste de la division de données·x^n par le générateur). */
  function reedSolomon(donnees, n) {
    const g = generateur(n);
    const reste = new Array(n).fill(0);
    for (const octet of donnees) {
      const facteur = octet ^ reste[0];
      reste.shift();
      reste.push(0);
      for (let i = 0; i < n; i++) reste[i] ^= mul(g[i + 1], facteur);
    }
    return reste;
  }

  // ----- Capacités ------------------------------------------------------------------------------
  /** Nombre de modules disponibles pour les données et la correction (hors motifs fixes). */
  function modulesDonnees(version) {
    let r = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const nbAlign = Math.floor(version / 7) + 2;
      r -= (25 * nbAlign - 10) * nbAlign - 55;
      if (version >= 7) r -= 36;
    }
    return r;
  }
  function codewordsDonnees(version, niveau) {
    return Math.floor(modulesDonnees(version) / 8) - EC_PAR_BLOC[niveau][version] * NB_BLOCS[niveau][version];
  }
  function bitsCompteur(version) { return version <= 9 ? 8 : 16; }

  /** Positions des centres des motifs d'alignement. */
  function positionsAlignement(version) {
    if (version === 1) return [];
    const nb = Math.floor(version / 7) + 2;
    const pas = Math.floor((version * 8 + nb * 3 + 5) / (nb * 4 - 4)) * 2;
    const out = [6];
    for (let pos = version * 4 + 10; out.length < nb; pos -= pas) out.splice(1, 0, pos);
    return out;
  }

  /** Informations de format (15 bits) : niveau + masque, code BCH(15,5), masquées par 101010000010010. */
  function bitsFormat(niveau, masque) {
    const donnees = (BITS_NIVEAU[niveau] << 3) | masque;
    let r = donnees;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    return ((donnees << 10) | r) ^ 0x5412;
  }
  /** Informations de version (18 bits) pour les versions 7 et plus : code BCH(18,6). */
  function bitsVersion(version) {
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    return (version << 12) | r;
  }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ----- Encodage des données ------------------------------------------------------------------------
  function utf8(texte) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(texte));
    return Array.from(Buffer.from(texte, 'utf8')); // eslint-disable-line no-undef
  }

  /** Données + bourrage (0xEC 0x11) pour une version et un niveau donnés. */
  function codewords(octets, version, niveau) {
    const bits = [];
    const ajouter = (valeur, longueur) => { for (let i = longueur - 1; i >= 0; i--) bits.push((valeur >>> i) & 1); };
    ajouter(0b0100, 4); // mode octet
    ajouter(octets.length, bitsCompteur(version));
    for (const o of octets) ajouter(o, 8);
    const capacite = codewordsDonnees(version, niveau) * 8;
    ajouter(0, Math.min(4, capacite - bits.length)); // terminateur
    while (bits.length % 8) bits.push(0);
    for (let p = 0xec; bits.length < capacite; p ^= 0xec ^ 0x11) ajouter(p, 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    return out;
  }

  /** Découpage en blocs, calcul de la correction et entrelacement. */
  function entrelacer(donnees, version, niveau) {
    const nbBlocs = NB_BLOCS[niveau][version];
    const ecLong = EC_PAR_BLOC[niveau][version];
    const total = Math.floor(modulesDonnees(version) / 8);
    const nbCourts = nbBlocs - (total % nbBlocs);
    const longueurCourt = Math.floor(total / nbBlocs) - ecLong; // données d'un bloc court
    const blocs = [];
    let k = 0;
    for (let i = 0; i < nbBlocs; i++) {
      const n = longueurCourt + (i < nbCourts ? 0 : 1);
      const d = donnees.slice(k, k + n);
      k += n;
      blocs.push({ d, ec: reedSolomon(d, ecLong) });
    }
    const out = [];
    for (let i = 0; i <= longueurCourt; i++) for (const b of blocs) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLong; i++) for (const b of blocs) out.push(b.ec[i]);
    return out;
  }

  // ----- Construction de la matrice ------------------------------------------------------------------
  function Matrice(version) {
    this.version = version;
    this.taille = version * 4 + 17;
    this.modules = [];
    this.fixe = [];
    for (let y = 0; y < this.taille; y++) { this.modules.push(new Array(this.taille).fill(false)); this.fixe.push(new Array(this.taille).fill(false)); }
  }
  Matrice.prototype.poser = function (x, y, sombre) { this.modules[y][x] = !!sombre; this.fixe[y][x] = true; };

  function motifsFixes(m) {
    const t = m.taille;
    // Motifs de synchronisation
    for (let i = 0; i < t; i++) { m.poser(6, i, i % 2 === 0); m.poser(i, 6, i % 2 === 0); }
    // Motifs de position (avec séparateurs)
    const position = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= t || y >= t) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          m.poser(x, y, d !== 2 && d !== 4);
        }
      }
    };
    position(3, 3); position(t - 4, 3); position(3, t - 4);
    // Motifs d'alignement (sauf ceux qui chevauchent les motifs de position)
    const pos = positionsAlignement(m.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.poser(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    // Zones réservées au format (remplies ensuite) et module sombre
    poserFormat(m, 0, 0);
    // Informations de version
    if (m.version >= 7) {
      const v = bitsVersion(m.version);
      for (let i = 0; i < 18; i++) {
        const a = t - 11 + (i % 3), b = Math.floor(i / 3);
        m.poser(a, b, bit(v, i));
        m.poser(b, a, bit(v, i));
      }
    }
  }

  function poserFormat(m, niveau, masque) {
    const t = m.taille;
    const f = bitsFormat(niveau, masque);
    // Première copie, autour du motif de position en haut à gauche
    for (let i = 0; i <= 5; i++) m.poser(8, i, bit(f, i));
    m.poser(8, 7, bit(f, 6));
    m.poser(8, 8, bit(f, 7));
    m.poser(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) m.poser(14 - i, 8, bit(f, i));
    // Seconde copie, répartie près des deux autres motifs de position
    for (let i = 0; i < 8; i++) m.poser(t - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) m.poser(8, t - 15 + i, bit(f, i));
    m.poser(8, t - 8, true); // module toujours sombre
  }

  /** Placement des bits en zigzag, par colonnes de 2 modules, de droite à gauche. */
  function placerDonnees(m, donnees) {
    const t = m.taille;
    let i = 0;
    const total = donnees.length * 8;
    for (let droite = t - 1; droite >= 1; droite -= 2) {
      if (droite === 6) droite = 5; // la colonne de synchronisation verticale est sautée
      for (let v = 0; v < t; v++) {
        for (let j = 0; j < 2; j++) {
          const x = droite - j;
          const montee = ((droite + 1) & 2) === 0;
          const y = montee ? t - 1 - v : v;
          if (m.fixe[y][x]) continue;
          m.modules[y][x] = i < total ? bit(donnees[i >>> 3], 7 - (i & 7)) : false; // bits de remplissage à 0
          i++;
        }
      }
    }
  }

  const MASQUES = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  function appliquerMasque(m, masque) {
    const f = MASQUES[masque];
    for (let y = 0; y < m.taille; y++) for (let x = 0; x < m.taille; x++) if (!m.fixe[y][x] && f(x, y)) m.modules[y][x] = !m.modules[y][x];
  }

  /** Pénalités de la norme (règles N1 à N4) ; le masque retenu est celui de plus faible score. */
  function penalite(modules) {
    const t = modules.length;
    let score = 0;
    const lire = (x, y, ligne) => (ligne ? modules[y][x] : modules[x][y]);
    for (const ligne of [true, false]) {
      for (let y = 0; y < t; y++) {
        // N1 : suites d'au moins 5 modules de même couleur
        let suite = 1;
        for (let x = 1; x < t; x++) {
          if (lire(x, y, ligne) === lire(x - 1, y, ligne)) suite++;
          else { if (suite >= 5) score += 3 + (suite - 5); suite = 1; }
        }
        if (suite >= 5) score += 3 + (suite - 5);
        // N3 : motif 1:1:3:1:1 bordé de 4 modules clairs (l'extérieur de la matrice compte comme clair)
        const clair = (x) => x < 0 || x >= t || !lire(x, y, ligne);
        for (let x = 0; x + 7 <= t; x++) {
          const motif = lire(x, y, ligne) && !lire(x + 1, y, ligne) && lire(x + 2, y, ligne) && lire(x + 3, y, ligne) && lire(x + 4, y, ligne) && !lire(x + 5, y, ligne) && lire(x + 6, y, ligne);
          if (!motif) continue;
          const avant = clair(x - 1) && clair(x - 2) && clair(x - 3) && clair(x - 4);
          const apres = clair(x + 7) && clair(x + 8) && clair(x + 9) && clair(x + 10);
          if (avant || apres) score += 40;
        }
      }
    }
    // N2 : blocs 2×2 de même couleur
    for (let y = 0; y < t - 1; y++) {
      for (let x = 0; x < t - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
    // N4 : proportion de modules sombres
    let sombres = 0;
    for (const l of modules) for (const c of l) if (c) sombres++;
    score += 10 * Math.floor(Math.abs((sombres * 100) / (t * t) - 50) / 5);
    return score;
  }

  /**
   * Calcule la matrice du QR code.
   * @param {string} texte
   * @param {{ niveau?: 'L'|'M'|'Q'|'H', versionMin?: number, versionMax?: number, masque?: number }} [options]
   */
  function matrice(texte, options = {}) {
    const niveau = NIVEAUX[options.niveau || 'M'];
    if (niveau === undefined) throw new Error('Niveau de correction inconnu');
    const octets = utf8(String(texte == null ? '' : texte));
    const vMin = Math.max(1, options.versionMin || 1);
    const vMax = Math.min(40, options.versionMax || 40);
    let version = 0;
    for (let v = vMin; v <= vMax; v++) {
      if (4 + bitsCompteur(v) + octets.length * 8 <= codewordsDonnees(v, niveau) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Texte trop long pour un QR code');
    const donnees = entrelacer(codewords(octets, version, niveau), version, niveau);

    const base = new Matrice(version);
    motifsFixes(base);
    placerDonnees(base, donnees);

    let meilleur = null;
    const masques = options.masque === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.masque];
    for (const masque of masques) {
      const m = new Matrice(version);
      m.modules = base.modules.map((l) => l.slice());
      m.fixe = base.fixe.map((l) => l.slice());
      appliquerMasque(m, masque);
      poserFormat(m, niveau, masque);
      const score = penalite(m.modules);
      if (!meilleur || score < meilleur.score) meilleur = { m, masque, score };
    }
    return { version, taille: meilleur.m.taille, niveau: options.niveau || 'M', masque: meilleur.masque, modules: meilleur.m.modules };
  }

  /** Tracé SVG (un seul chemin) avec une marge de 4 modules. */
  function trace(modules) {
    let d = '';
    for (let y = 0; y < modules.length; y++) {
      for (let x = 0; x < modules.length; x++) if (modules[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
    return d;
  }

  /**
   * Image SVG autonome.
   * @param {string} texte
   * @param {{ niveau?: string, taille?: number, couleur?: string, fond?: string, titre?: string }} [options] taille en pixels
   */
  function svg(texte, options = {}) {
    const q = matrice(texte, options);
    const cote = q.taille + 8;
    const px = Number(options.taille) || cote * 4;
    const couleur = /^#[0-9a-fA-F]{3,8}$/.test(options.couleur || '') ? options.couleur : '#000000';
    const fond = /^#[0-9a-fA-F]{3,8}$/.test(options.fond || '') ? options.fond : '#ffffff';
    const titre = String(options.titre || 'QR code').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cote} ${cote}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="${titre}">`
      + `<rect width="${cote}" height="${cote}" fill="${fond}"/><path fill="${couleur}" d="${trace(q.modules)}"/></svg>`;
  }

  /** Élément <svg> prêt à insérer dans la page (construit par l'API DOM, sans innerHTML). */
  function element(texte, options = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const q = matrice(texte, options);
    const cote = q.taille + 8;
    const px = Number(options.taille) || cote * 4;
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', `0 0 ${cote} ${cote}`);
    s.setAttribute('width', String(px));
    s.setAttribute('height', String(px));
    s.setAttribute('shape-rendering', 'crispEdges');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', options.titre || 'QR code');
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('width', String(cote)); r.setAttribute('height', String(cote)); r.setAttribute('fill', '#ffffff');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', '#000000'); p.setAttribute('d', trace(q.modules));
    s.appendChild(r); s.appendChild(p);
    return s;
  }

  const QRCode = {
    svg, element, matrice,
    /** Éléments internes, exposés pour les tests de conformité. */
    _interne: { reedSolomon, generateur, bitsFormat, bitsVersion, positionsAlignement, codewordsDonnees, modulesDonnees, codewords, entrelacer, penalite, EC_PAR_BLOC, NB_BLOCS, NIVEAUX },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QRCode;
  else racine.QRCode = QRCode;
})(typeof window !== 'undefined' ? window : this);
