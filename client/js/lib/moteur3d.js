/**
 * Moteur3D — moteur de rendu WebGL 1 minimal, sans aucune dépendance, pour les plans 3D de la GMAO.
 *
 *   const m = Moteur3D.creer(conteneur, { onClic(info), onSurvol(id), intercepteur: { down, move, up } });
 *   m.definirScene({ largeur, profondeur, objets: [descripteurs] });
 *   m.selection(['o12']); m.allerVers('o12'); m.vueDessus(true); m.detruire();
 *
 * Repère : coordonnées du plan en mètres (x vers l'est, y vers le sud, origine au coin nord-ouest),
 * altitude z. En WebGL : X = x, Y = altitude, Z = y. Une rotation positive tourne dans le sens horaire
 * vue de dessus (comme en Canvas 2D / CSS).
 *
 * Descripteur d'objet :
 *   { id (chaîne, partagé par plusieurs descripteurs d'un même objet), forme: 'boite'|'cylindre'|'prisme'|'segment'|'quad'|'aucune',
 *     x, y (centre), y0 (altitude de base), largeur, profondeur, hauteur, rotation (°),
 *     points [[x, y], …] (prisme), faces { toit, cotes, sol } (prisme), x2, y2, epaisseur (segment),
 *     couleur '#rrggbb', opacite (0..1, < 1 ⇒ transparence triée), aretes (bool), couleurAretes, pickable (bool),
 *     etiquette { texte, classe, priorite, tailleM } }
 *
 * Fonctionnalités : éclairage Lambert directionnel + ambiant, arêtes, transparence triée, grille, sol,
 * texture de fond de plan (image 2D, échelle m/px), caméra orbitale (souris, tactile, clavier), vue de
 * dessus orthographique, animation vers un objet, picking par tampon d'identifiants, survol / sélection /
 * clignotement, conversion écran → sol, étiquettes HTML projetées (avec anti-chevauchement), rendu à la
 * demande, redimensionnement (devicePixelRatio), perte / restauration du contexte, capture PNG,
 * et repli automatique en Canvas 2D (vue de dessus) si WebGL est indisponible.
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const FOV = 45 * DEG;
  const F_TRI = 11; // x y z nx ny nz r g b a id
  const F_LIG = 8; // x y z r g b a id

  // =====================================================================================
  // Mathématiques : matrices 4×4 en colonnes (convention WebGL)
  // =====================================================================================
  const mat4 = {
    identite() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    multiplier(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return o;
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    orthographique(l, r, b, t, n, f) {
      const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
      return new Float32Array([-2 * lr, 0, 0, 0, 0, -2 * bt, 0, 0, 0, 0, 2 * nf, 0, (l + r) * lr, (t + b) * bt, (f + n) * nf, 1]);
    },
    lookAt(eye, cible, haut) {
      let zx = eye[0] - cible[0], zy = eye[1] - cible[1], zz = eye[2] - cible[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = haut[1] * zz - haut[2] * zy, xy = haut[2] * zx - haut[0] * zz, xz = haut[0] * zy - haut[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
      ]);
    },
    inverser(m) {
      const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1 / det;
      return new Float32Array([
        (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
      ]);
    },
    transformer(m, x, y, z, w) {
      return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
    },
    /** Déplacement (dx, dy en plan) + rotation (°, sens du plan) autour de (cx, cy). */
    deplacementPlan(dx, dy, drot, cx, cy) {
      const a = (drot || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
      const m = mat4.identite();
      m[0] = c; m[2] = s; m[8] = -s; m[10] = c;
      m[12] = cx - c * cx + s * cy + dx; m[14] = cy - s * cx - c * cy + dy;
      return m;
    },
  };

  /** Rayon écran → intersection avec le plan horizontal d'altitude `alt` (matrice inverse de vue-projection). */
  function rayonSol(inv, ndcX, ndcY, alt) {
    const p0 = mat4.transformer(inv, ndcX, ndcY, -1, 1), p1 = mat4.transformer(inv, ndcX, ndcY, 1, 1);
    if (!p0[3] || !p1[3]) return null;
    const a = [p0[0] / p0[3], p0[1] / p0[3], p0[2] / p0[3]], b = [p1[0] / p1[3], p1[1] / p1[3], p1[2] / p1[3]];
    const dy = b[1] - a[1];
    if (Math.abs(dy) < 1e-12) return null;
    const t = (alt - a[1]) / dy;
    if (t < 0) return null;
    return { x: a[0] + (b[0] - a[0]) * t, y: a[2] + (b[2] - a[2]) * t };
  }

  // =====================================================================================
  // Couleurs et géométrie
  // =====================================================================================
  function couleurRGB(c) {
    if (Array.isArray(c)) return c;
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
    if (!m) return [0.42, 0.45, 0.5];
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbCss(rgb, a) { return `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a == null ? 1 : a})`; }
  function eclaircir(rgb, f) { return rgb.map((v) => Math.min(1, v + (1 - v) * f)); }
  function assombrir(rgb, f) { return rgb.map((v) => v * f); }

  function aireSignee(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a / 2;
  }
  function pointDansPolygone(x, y, pts) {
    let dedans = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi)) dedans = !dedans;
    }
    return dedans;
  }
  /** Triangulation d'un polygone simple par « oreilles » ; retourne des triplets d'indices. */
  function triangulerPolygone(points) {
    const n = points.length;
    if (n < 3) return [];
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    const ccw = aireSignee(points) > 0;
    const croix = (a, b, c) => (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
    const dansTri = (p, a, b, c) => {
      const s1 = croix(a, b, p), s2 = croix(b, c, p), s3 = croix(c, a, p);
      return ccw ? (s1 >= 0 && s2 >= 0 && s3 >= 0) : (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    const tris = [];
    let garde = 0;
    while (idx.length > 3 && garde++ < n * n) {
      let coupe = false;
      for (let i = 0; i < idx.length; i++) {
        const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
        const cr = croix(a, b, c);
        if (ccw ? cr <= 1e-12 : cr >= -1e-12) continue; // sommet réflexe ou aligné
        let ok = true;
        for (const p of idx) { if (p !== a && p !== b && p !== c && dansTri(p, a, b, c)) { ok = false; break; } }
        if (!ok) continue;
        tris.push([a, b, c]); idx.splice(i, 1); coupe = true; break;
      }
      if (!coupe) break; // polygone dégénéré : on termine en éventail
    }
    if (idx.length >= 3) for (let i = 1; i < idx.length - 1; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
    return tris;
  }

  /** Tampon flottant extensible. */
  class Tampon {
    constructor(cap) { this.a = new Float32Array(cap || 256); this.n = 0; }
    reserver(k) { if (this.n + k <= this.a.length) return; let c = this.a.length * 2; while (c < this.n + k) c *= 2; const b = new Float32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b; }
    fin() { return this.a.slice(0, this.n); }
  }

  /**
   * Géométrie d'un descripteur : triangles (pos, normale, couleur, id), lignes d'arêtes, empreinte au sol
   * (polygone pour le rendu 2D et le test de sélection), centre, altitudes.
   */
  function construireGeometrie(d, num) {
    const tri = new Tampon(512), lig = new Tampon(128);
    const rgb = couleurRGB(d.couleur);
    const alpha = d.opacite == null ? 1 : Math.max(0, Math.min(1, d.opacite));
    const rgbA = d.couleurAretes ? couleurRGB(d.couleurAretes) : assombrir(rgb, 0.55);
    const aA = d.couleurAretes ? 0.95 : Math.min(1, 0.35 + alpha * 0.6);
    const y0 = d.y0 || 0;
    const h = Math.max(0, d.hauteur == null ? 1 : d.hauteur);
    const pickId = d.pickable === false ? 0 : num;
    const v = (x, y, z, nx, ny, nz) => { tri.reserver(F_TRI); const a = tri.a; let k = tri.n; a[k++] = x; a[k++] = y; a[k++] = z; a[k++] = nx; a[k++] = ny; a[k++] = nz; a[k++] = rgb[0]; a[k++] = rgb[1]; a[k++] = rgb[2]; a[k++] = alpha; a[k++] = pickId; tri.n = k; };
    const quad = (p0, p1, p2, p3, n) => { v(...p0, ...n); v(...p1, ...n); v(...p2, ...n); v(...p0, ...n); v(...p2, ...n); v(...p3, ...n); };
    const ligne = (p, q) => { lig.reserver(F_LIG * 2); const a = lig.a; let k = lig.n; for (const s of [p, q]) { a[k++] = s[0]; a[k++] = s[1]; a[k++] = s[2]; a[k++] = rgbA[0]; a[k++] = rgbA[1]; a[k++] = rgbA[2]; a[k++] = aA; a[k++] = pickId; } lig.n = k; };
    let empreinte = [];
    let forme = d.forme || 'boite';
    let cx = d.x || 0, cy = d.y || 0, w = Math.max(0.001, d.largeur || 1), p = Math.max(0.001, d.profondeur || 1), rot = (d.rotation || 0) * DEG;
    if (forme === 'segment') {
      const dx = (d.x2 || 0) - (d.x || 0), dy = (d.y2 || 0) - (d.y || 0);
      cx = ((d.x || 0) + (d.x2 || 0)) / 2; cy = ((d.y || 0) + (d.y2 || 0)) / 2;
      w = Math.max(0.001, Math.hypot(dx, dy)); p = Math.max(0.001, d.epaisseur || 0.2); rot = Math.atan2(dy, dx);
      forme = 'boite';
    }
    const c = Math.cos(rot), s = Math.sin(rot);
    const tr = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c];

    if (forme === 'boite' || forme === 'quad') {
      const coins = [tr(-w / 2, -p / 2), tr(w / 2, -p / 2), tr(w / 2, p / 2), tr(-w / 2, p / 2)];
      empreinte = coins;
      const B = coins.map(([x, y]) => [x, y0, y]), T = coins.map(([x, y]) => [x, y0 + (forme === 'quad' ? 0 : h), y]);
      if (forme === 'quad') {
        quad(T[0], T[1], T[2], T[3], [0, 1, 0]);
        if (d.aretes) for (let i = 0; i < 4; i++) ligne(T[i], T[(i + 1) % 4]);
      } else {
        const nx = [c, 0, s], ny = [-s, 0, c];
        quad(T[0], T[1], T[2], T[3], [0, 1, 0]);
        if (h > 0.0001) {
          quad(B[0], B[3], B[2], B[1], [0, -1, 0]);
          quad(B[0], B[1], T[1], T[0], [-ny[0], 0, -ny[2]]);
          quad(B[1], B[2], T[2], T[1], nx);
          quad(B[2], B[3], T[3], T[2], ny);
          quad(B[3], B[0], T[0], T[3], [-nx[0], 0, -nx[2]]);
        }
        if (d.aretes) {
          for (let i = 0; i < 4; i++) { ligne(T[i], T[(i + 1) % 4]); if (h > 0.05) { ligne(B[i], B[(i + 1) % 4]); ligne(B[i], T[i]); } }
        }
      }
    } else if (forme === 'cylindre') {
      const rx = w / 2, ry = p / 2;
      const nSeg = Math.max(12, Math.min(40, Math.round(Math.max(rx, ry) * 10) + 12));
      const pts = [], norms = [];
      for (let i = 0; i < nSeg; i++) {
        const t = (i / nSeg) * Math.PI * 2, lx = Math.cos(t) * rx, ly = Math.sin(t) * ry;
        pts.push(tr(lx, ly));
        const nlx = Math.cos(t) / rx, nly = Math.sin(t) / ry, l = Math.hypot(nlx, nly) || 1;
        norms.push([(nlx * c - nly * s) / l, 0, (nlx * s + nly * c) / l]);
      }
      empreinte = pts;
      const top = y0 + h;
      for (let i = 0; i < nSeg; i++) {
        const j = (i + 1) % nSeg;
        const a = pts[i], b = pts[j];
        // côté (normales lissées)
        v(a[0], y0, a[1], ...norms[i]); v(b[0], y0, b[1], ...norms[j]); v(b[0], top, b[1], ...norms[j]);
        v(a[0], y0, a[1], ...norms[i]); v(b[0], top, b[1], ...norms[j]); v(a[0], top, a[1], ...norms[i]);
        // couvercles
        v(cx, top, cy, 0, 1, 0); v(a[0], top, a[1], 0, 1, 0); v(b[0], top, b[1], 0, 1, 0);
        v(cx, y0, cy, 0, -1, 0); v(b[0], y0, b[1], 0, -1, 0); v(a[0], y0, a[1], 0, -1, 0);
        if (d.aretes) { ligne([a[0], top, a[1]], [b[0], top, b[1]]); if (h > 0.05) ligne([a[0], y0, a[1]], [b[0], y0, b[1]]); }
      }
    } else if (forme === 'prisme') {
      let pts = (d.points || []).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0]);
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
      if (pts.length < 3) {
        pts = [tr(-w / 2, -p / 2), tr(w / 2, -p / 2), tr(w / 2, p / 2), tr(-w / 2, p / 2)];
      }
      empreinte = pts;
      const faces = Object.assign({ toit: true, cotes: true, sol: false }, d.faces || {});
      const top = y0 + h;
      const tris = triangulerPolygone(pts);
      if (faces.toit) for (const [a, b, e] of tris) { v(pts[a][0], top, pts[a][1], 0, 1, 0); v(pts[b][0], top, pts[b][1], 0, 1, 0); v(pts[e][0], top, pts[e][1], 0, 1, 0); }
      if (faces.sol) for (const [a, b, e] of tris) { v(pts[a][0], y0, pts[a][1], 0, -1, 0); v(pts[e][0], y0, pts[e][1], 0, -1, 0); v(pts[b][0], y0, pts[b][1], 0, -1, 0); }
      const ccw = aireSignee(pts) > 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
        const n = ccw ? [ey / l, 0, -ex / l] : [-ey / l, 0, ex / l];
        if (faces.cotes && h > 0.0001) quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], top, b[1]], [a[0], top, a[1]], n);
        if (d.aretes) {
          ligne([a[0], top, a[1]], [b[0], top, b[1]]);
          if (h > 0.05 && faces.cotes) { ligne([a[0], y0, a[1]], [b[0], y0, b[1]]); if (pts.length <= 24) ligne([a[0], y0, a[1]], [a[0], top, a[1]]); }
        }
      }
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of empreinte) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (!empreinte.length) { minX = maxX = cx; minY = maxY = cy; }
    return {
      tri: tri.fin(), lig: lig.fin(), empreinte,
      centre: [(minX + maxX) / 2, y0 + h / 2, (minY + maxY) / 2],
      boite: { minX, maxX, minY, maxY, minZ: y0, maxZ: y0 + h },
      transparent: alpha < 0.999,
    };
  }

  // =====================================================================================
  // Shaders
  // =====================================================================================
  const VS_TRI = `
    precision highp float;
    attribute vec3 aPos; attribute vec3 aNorm; attribute vec4 aCoul; attribute float aId; attribute float aSel;
    uniform mat4 uVP; uniform mat4 uModele; uniform vec3 uLum; uniform float uAmb;
    uniform float uSurv; uniform float uClign; uniform float uFlash; uniform vec3 uCoulSel; uniform float uAlpha;
    varying vec4 vCoul;
    void main() {
      vec4 p = uModele * vec4(aPos, 1.0);
      gl_Position = uVP * p;
      vec3 n = normalize((uModele * vec4(aNorm, 0.0)).xyz);
      float d = max(dot(n, uLum), 0.0);
      float rem = max(dot(n, normalize(vec3(-uLum.x, 0.35, -uLum.z))), 0.0) * 0.16;
      vec3 c = aCoul.rgb * min(uAmb + (1.0 - uAmb) * d + rem, 1.12);
      float a = aCoul.a * uAlpha;
      if (aSel > 0.5) { c = mix(c, uCoulSel, 0.45) + vec3(0.05); a = max(a, 0.5); }
      if (aId > 0.5 && abs(aId - uSurv) < 0.5) { c = c * 1.12 + vec3(0.08); }
      if (aId > 0.5 && abs(aId - uClign) < 0.5) { c = mix(c, vec3(1.0, 0.78, 0.05), uFlash); a = max(a, uFlash); }
      vCoul = vec4(c, a);
    }`;
  const FS_COULEUR = `
    precision mediump float;
    varying vec4 vCoul;
    void main() { gl_FragColor = vCoul; }`;
  const VS_LIG = `
    precision highp float;
    attribute vec3 aPos; attribute vec4 aCoul; attribute float aId; attribute float aSel;
    uniform mat4 uVP; uniform mat4 uModele; uniform float uSurv; uniform vec3 uCoulSel; uniform float uAlpha;
    varying vec4 vCoul;
    void main() {
      gl_Position = uVP * uModele * vec4(aPos, 1.0);
      vec4 c = vec4(aCoul.rgb, aCoul.a * uAlpha);
      if (aSel > 0.5) c = vec4(uCoulSel, 1.0);
      else if (aId > 0.5 && abs(aId - uSurv) < 0.5) c = vec4(min(c.rgb * 1.4 + 0.15, vec3(1.0)), 1.0);
      vCoul = c;
    }`;
  const VS_PICK = `
    precision highp float;
    attribute vec3 aPos; attribute float aId;
    uniform mat4 uVP; uniform mat4 uModele;
    varying vec4 vId;
    void main() {
      gl_Position = uVP * uModele * vec4(aPos, 1.0);
      float id = floor(aId + 0.5);
      vId = vec4(mod(id, 256.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, mod(floor(id / 65536.0), 256.0) / 255.0, 1.0);
    }`;
  const FS_PICK = `
    precision highp float;
    varying vec4 vId;
    void main() { gl_FragColor = vId; }`;
  const VS_TEX = `
    precision highp float;
    attribute vec3 aPos; attribute vec2 aUV;
    uniform mat4 uVP;
    varying vec2 vUV;
    void main() { gl_Position = uVP * vec4(aPos, 1.0); vUV = aUV; }`;
  const FS_TEX = `
    precision mediump float;
    uniform sampler2D uTex; uniform float uOpacite;
    varying vec2 vUV;
    void main() { vec4 t = texture2D(uTex, vUV); gl_FragColor = vec4(t.rgb, t.a * uOpacite); }`;

  const ATTR = { aPos: 0, aNorm: 1, aCoul: 2, aId: 3, aSel: 4, aUV: 5 };

  // =====================================================================================
  // Styles des étiquettes (injectés une seule fois)
  // =====================================================================================
  function injecterStyles() {
    if (typeof document === 'undefined' || document.getElementById('moteur3d-styles')) return;
    const st = document.createElement('style');
    st.id = 'moteur3d-styles';
    st.textContent = `
      .m3d-racine { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
      .m3d-racine canvas { display: block; width: 100%; height: 100%; outline: none; touch-action: none; }
      .m3d-etiquettes { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
      .m3d-etiquette { position: absolute; left: 0; top: 0; white-space: nowrap; font: 600 11.5px/1.3 "Segoe UI", system-ui, sans-serif; padding: 2px 7px; border-radius: 10px;
        background: color-mix(in srgb, var(--surface, #fff) 88%, transparent); color: var(--texte, #111827); border: 1px solid var(--bordure-2, #d1d5db);
        box-shadow: 0 1px 3px rgba(0,0,0,0.18); will-change: transform; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
      .m3d-etiquette.zone { background: transparent; border: 0; box-shadow: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--texte, #111827); text-shadow: 0 0 3px var(--surface, #fff), 0 0 6px var(--surface, #fff); }
      .m3d-etiquette.batiment { background: transparent; border: 0; box-shadow: none; font-weight: 700; font-size: 13px; color: var(--texte-2, #4b5563); text-shadow: 0 0 3px var(--surface, #fff); }
      .m3d-etiquette.texte-sol { background: transparent; border: 0; box-shadow: none; font-weight: 700; color: var(--texte, #1f2937); text-shadow: 0 0 3px var(--surface, #fff), 0 0 8px var(--surface, #fff); padding: 0; }
      .m3d-etiquette.alerte-urgent { border-color: #dc2626; box-shadow: 0 0 0 1px #dc2626, 0 1px 3px rgba(0,0,0,0.2); }
      .m3d-etiquette.alerte-en_cours { border-color: #f59e0b; }
      .m3d-etiquette.selectionnee { background: var(--primaire, #2563eb); color: #fff; border-color: var(--primaire, #2563eb); z-index: 2; }
      .m3d-etiquette .pastille-et { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 0; }
      .m3d-repli { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); background: #fef3c7; color: #78350f; border: 1px solid #fcd34d; padding: 6px 12px; border-radius: 8px; font: 12.5px "Segoe UI", sans-serif; z-index: 3; pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
      [data-theme="sombre"] .m3d-repli { background: #78350f; color: #fef3c7; border-color: #b45309; }
    `;
    document.head.appendChild(st);
  }

  // =====================================================================================
  // Moteur
  // =====================================================================================
  class Moteur {
    constructor(conteneur, options) {
      injecterStyles();
      this.o = Object.assign({ couleurFond: '#e9eef4', couleurSol: '#f8fafc', couleurMarge: '#dfe5ec', couleurGrille: '#94a3b8', grille: true, pasGrille: 1, forcer2D: false }, options || {});
      this.conteneur = conteneur;
      this.racine = document.createElement('div');
      this.racine.className = 'm3d-racine';
      this.canvas = document.createElement('canvas');
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('aria-label', 'Vue 3D du plan (glisser pour tourner, clic droit ou Maj pour déplacer, molette pour zoomer)');
      this.calqueEtiquettes = document.createElement('div');
      this.calqueEtiquettes.className = 'm3d-etiquettes';
      this.racine.appendChild(this.canvas);
      this.racine.appendChild(this.calqueEtiquettes);
      conteneur.appendChild(this.racine);

      this.scene = { largeur: 50, profondeur: 50, objets: [] };
      this.cam = { x: 25, y: 25, z: 0, distance: 70, azimut: 20, elevation: 50, dessus: false };
      this.ids = new Map(); this.idsInv = new Map(); this.prochainId = 1;
      this.cache = new Map();
      this.geos = []; // { d, g, num }
      this.selectionNums = new Set(); this.selectionIds = [];
      this.survolNum = 0; this.clignNum = 0; this.flash = 0; this.clignFin = 0;
      this.decal = null; // { nums:Set, matrice }
      this.apercus = []; // descripteurs temporaires
      this.fond = null; // { image, x, y, rotation, echelle, opacite, y0 }
      this.etiquettesActives = true;
      this.etiquettesEl = new Map();
      this.tween = null;
      this.raf = 0; this.detruit = false;
      this.pickSale = true;
      this.curseurBase = 'default';
      this.stats = { objets: 0, sommets: 0, appels: 0 };
      this.compte = { opaque: 0, transp: 0, lignes: 0, grille: 0, decor: 0, apercu: 0, apercuLig: 0 };
      this.plagesOpaques = []; this.plagesTransp = []; this.plagesLignes = [];
      this.mode = 'webgl';
      this.raisonRepli = '';

      this._ecouteurs = [];
      let gl = null;
      if (!this.o.forcer2D) {
        try {
          const attrs = { antialias: true, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false, failIfMajorPerformanceCaveat: false };
          gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
        } catch (e) { gl = null; }
      }
      if (gl) {
        this.gl = gl;
        try { this._initGL(); } catch (e) { this.gl = null; this.raisonRepli = 'Initialisation WebGL impossible : ' + (e.message || e); }
      } else if (!this.o.forcer2D) {
        this.raisonRepli = 'WebGL n\'est pas disponible sur ce poste (navigateur ou pilote graphique).';
      } else this.raisonRepli = 'Mode 2D forcé.';
      if (!this.gl) this._initRepli2D();

      this._initInteractions();
      this.redimensionner();
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => this.redimensionner());
        this.ro.observe(conteneur);
      } else this._on(global, 'resize', () => this.redimensionner());
    }

    // ----- Initialisation WebGL ---------------------------------------------------------
    _initGL() {
      const gl = this.gl;
      const compiler = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('Shader : ' + gl.getShaderInfoLog(s));
        return s;
      };
      const programme = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compiler(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compiler(gl.FRAGMENT_SHADER, fs));
        for (const [n, i] of Object.entries(ATTR)) gl.bindAttribLocation(p, i, n);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('Programme : ' + gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
        for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
        return { p, u };
      };
      this.prog = {
        tri: programme(VS_TRI, FS_COULEUR),
        lig: programme(VS_LIG, FS_COULEUR),
        pick: programme(VS_PICK, FS_PICK),
        tex: programme(VS_TEX, FS_TEX),
      };
      this.buf = {};
      for (const k of ['opaque', 'opaqueSel', 'transp', 'transpSel', 'lignes', 'lignesSel', 'grille', 'decor', 'fond', 'apercu', 'apercuLig']) this.buf[k] = gl.createBuffer();
      this.compte = { opaque: 0, transp: 0, lignes: 0, grille: 0, decor: 0, apercu: 0, apercuLig: 0 };
      this.fbo = null; this.texFond = null;
      this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      this.sale = true; this.decorSale = true; this.selSale = true;
      if (!this._contexteEcoute) {
        this._contexteEcoute = true;
        this._on(this.canvas, 'webglcontextlost', (ev) => {
          ev.preventDefault();
          this.perdu = true;
          if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
          if (this.o.onPerteContexte) this.o.onPerteContexte();
        });
        this._on(this.canvas, 'webglcontextrestored', () => {
          this.perdu = false;
          try {
            this._initGL();
            this.cache.clear();
            if (this.fond && this.fond.image) this._chargerTextureFond(this.fond.image);
            this.redimensionner();
            if (this.o.onRestauration) this.o.onRestauration();
          } catch (e) { if (global.console) console.error(e); }
        });
      }
    }

    _initRepli2D() {
      this.mode = '2d';
      this.ctx2d = this.canvas.getContext('2d');
      this.cam.dessus = true;
      const msg = document.createElement('div');
      msg.className = 'm3d-repli';
      msg.textContent = (this.raisonRepli ? this.raisonRepli + ' ' : '') + 'Affichage en vue de dessus 2D.';
      this.racine.appendChild(msg);
      this.messageRepli = msg;
      setTimeout(() => { if (msg.parentNode) { msg.style.transition = 'opacity 0.6s'; msg.style.opacity = '0.75'; } }, 6000);
    }

    _on(cible, evt, fn, opts) { cible.addEventListener(evt, fn, opts); this._ecouteurs.push([cible, evt, fn, opts]); }

    // ----- Identifiants -------------------------------------------------------------------
    _num(id) {
      if (id == null) return 0;
      const k = String(id);
      let n = this.ids.get(k);
      if (!n) { n = this.prochainId++; this.ids.set(k, n); this.idsInv.set(n, k); }
      return n;
    }

    // ----- Scène --------------------------------------------------------------------------
    /** Remplace toute la scène : { largeur, profondeur, objets: [descripteurs] }. */
    definirScene(scene) {
      this.scene = Object.assign({ largeur: 50, profondeur: 50, objets: [] }, scene || {});
      this.sale = true; this.decorSale = true;
      this.demanderRendu();
    }
    /** Remplace les descripteurs des identifiants donnés (les autres sont conservés). */
    majObjets(descripteurs) {
      const ids = new Set(descripteurs.map((d) => String(d.id)));
      this.scene.objets = this.scene.objets.filter((d) => !ids.has(String(d.id))).concat(descripteurs);
      this.sale = true;
      this.demanderRendu();
    }
    supprimerObjets(ids) {
      const s = new Set(ids.map(String));
      this.scene.objets = this.scene.objets.filter((d) => !s.has(String(d.id)));
      this.sale = true;
      this.demanderRendu();
    }
    /** Descripteurs temporaires (aperçu de tracé, fantôme de placement), dessinés en transparence. */
    definirApercus(descripteurs) {
      this.apercus = (descripteurs || []).filter(Boolean);
      this.apercuSale = true;
      this.demanderRendu();
    }
    /** Décalage temporaire (glisser-déposer) : { ids, dx, dy, drot, cx, cy } ou null. */
    decalageTemporaire(dec) {
      if (!dec) { this.decal = null; this.demanderRendu(); return; }
      const nums = new Set((dec.ids || []).map((id) => this._num(id)));
      this.decal = { nums, matrice: mat4.deplacementPlan(dec.dx || 0, dec.dy || 0, dec.drot || 0, dec.cx || 0, dec.cy || 0), dec };
      this.pickSale = true;
      this.demanderRendu();
    }
    definirFond(fond) {
      if (!fond || (!fond.image && !fond.url)) { this.fond = null; this.demanderRendu(); return; }
      const ancien = this.fond;
      this.fond = Object.assign({ x: 0, y: 0, rotation: 0, echelle: 0.05, opacite: 0.6, y0: 0 }, fond);
      const src = fond.image || fond.url;
      if (ancien && ancien.source === src && ancien.image && ancien.image.complete) { this.fond.image = ancien.image; this.fond.source = src; this.demanderRendu(); return; }
      this.fond.source = src;
      if (ancien && ancien.image) this.fond.image = ancien.image; // l'ancienne image reste affichée pendant le chargement
      const img = typeof src === 'string' ? new Image() : src;
      const pret = () => {
        if (!this.fond || this.fond.source !== src) return;
        this.fond.image = img;
        if (this.gl) this._chargerTextureFond(img);
        this.demanderRendu();
        if (this.o.onFondCharge) this.o.onFondCharge(img);
      };
      if (typeof src === 'string') { img.onload = pret; img.onerror = () => { if (global.console) console.warn('Fond de plan non chargé'); }; img.src = src; } else if (img.complete) pret(); else img.onload = pret;
    }
    _chargerTextureFond(img) {
      const gl = this.gl;
      if (!gl) return;
      let source = img;
      const max = this.maxTexture || 4096;
      if (img.naturalWidth > max || img.naturalHeight > max) {
        const k = max / Math.max(img.naturalWidth, img.naturalHeight);
        const cv = document.createElement('canvas'); cv.width = Math.floor(img.naturalWidth * k); cv.height = Math.floor(img.naturalHeight * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        source = cv;
      }
      if (this.texFond) gl.deleteTexture(this.texFond);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      const w = source.width || source.naturalWidth, h = source.height || source.naturalHeight;
      const pot = (n) => (n & (n - 1)) === 0;
      if (pot(w) && pot(h)) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texFond = t;
    }
    /** Coins (plan) du fond de plan : [haut-gauche, haut-droit, bas-droit, bas-gauche]. */
    coinsFond() {
      const f = this.fond;
      if (!f || !f.image) return null;
      const w = (f.image.naturalWidth || f.image.width) * f.echelle, h = (f.image.naturalHeight || f.image.height) * f.echelle;
      const a = (f.rotation || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
      return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([lx, ly]) => [f.x + lx * c - ly * s, f.y + lx * s + ly * c]);
    }

    definirTheme(t) { Object.assign(this.o, t || {}); this.decorSale = true; this.demanderRendu(); }
    /** Grille au sol : actif, pas (m), opacité relative (0..1). */
    definirGrille(actif, pas, opacite) {
      const avant = [this.o.grille, this.o.pasGrille, this.o.opaciteGrille].join('|');
      this.o.grille = !!actif; if (pas) this.o.pasGrille = pas; if (opacite != null) this.o.opaciteGrille = opacite;
      if (avant !== [this.o.grille, this.o.pasGrille, this.o.opaciteGrille].join('|')) { this.decorSale = true; this.demanderRendu(); }
    }
    etiquettes(actif) { this.etiquettesActives = !!actif; this.demanderRendu(); }
    definirCurseur(c) { this.curseurBase = c || 'default'; this.canvas.style.cursor = this.curseurBase; }

    selection(ids) {
      this.selectionIds = (ids || []).filter((x) => x != null).map(String);
      this.selectionNums = new Set(this.selectionIds.map((id) => this._num(id)));
      this.selSale = true;
      this.demanderRendu();
    }
    survol(id) {
      const n = id == null ? 0 : this._num(id);
      if (n === this.survolNum) return;
      this.survolNum = n;
      this.demanderRendu();
    }
    clignoter(id, duree) {
      this.clignNum = id == null ? 0 : this._num(id);
      this.clignFin = performance.now() + (duree || 2600);
      this.demanderRendu();
    }

    // ----- Construction des tampons -------------------------------------------------------
    _reconstruire() {
      const nouveauCache = new Map();
      const opaques = [], transps = [];
      let nOp = 0, nTr = 0, nLi = 0;
      this.geos = [];
      for (const d of this.scene.objets) {
        if (!d || d.forme === 'aucune' && !d.etiquette) continue;
        const num = this._num(d.id);
        let cle;
        try { cle = num + '|' + JSON.stringify(d); } catch (e) { cle = null; }
        let g = cle ? this.cache.get(cle) : null;
        if (!g) g = d.forme === 'aucune' ? { tri: new Float32Array(0), lig: new Float32Array(0), empreinte: [[d.x || 0, d.y || 0]], centre: [d.x || 0, d.y0 || 0, d.y || 0], boite: { minX: d.x || 0, maxX: d.x || 0, minY: d.y || 0, maxY: d.y || 0, minZ: d.y0 || 0, maxZ: d.y0 || 0 }, transparent: false } : construireGeometrie(d, num);
        if (cle) nouveauCache.set(cle, g);
        const e = { d, g, num };
        this.geos.push(e);
        if (g.transparent) { transps.push(e); nTr += g.tri.length; } else { opaques.push(e); nOp += g.tri.length; }
        nLi += g.lig.length;
      }
      this.cache = nouveauCache;
      const op = new Float32Array(nOp), tr = new Float32Array(nTr), li = new Float32Array(nLi);
      let kO = 0, kT = 0, kL = 0;
      this.plagesOpaques = []; this.plagesTransp = []; this.plagesLignes = [];
      for (const e of opaques) { if (e.g.tri.length) { op.set(e.g.tri, kO); this.plagesOpaques.push({ num: e.num, first: kO / F_TRI, count: e.g.tri.length / F_TRI }); kO += e.g.tri.length; } }
      for (const e of transps) { if (e.g.tri.length) { tr.set(e.g.tri, kT); this.plagesTransp.push({ num: e.num, first: kT / F_TRI, count: e.g.tri.length / F_TRI, centre: e.g.centre, pick: e.d.pickable !== false }); kT += e.g.tri.length; } }
      for (const e of this.geos) { if (e.g.lig.length) { li.set(e.g.lig, kL); this.plagesLignes.push({ num: e.num, first: kL / F_LIG, count: e.g.lig.length / F_LIG, transparent: e.g.transparent }); kL += e.g.lig.length; } }
      this.compte.opaque = nOp / F_TRI; this.compte.transp = nTr / F_TRI; this.compte.lignes = nLi / F_LIG;
      const gl = this.gl;
      if (gl) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.opaque); gl.bufferData(gl.ARRAY_BUFFER, op, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.transp); gl.bufferData(gl.ARRAY_BUFFER, tr, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lignes); gl.bufferData(gl.ARRAY_BUFFER, li, gl.STATIC_DRAW);
      }
      this.stats.objets = this.geos.length;
      this.stats.sommets = this.compte.opaque + this.compte.transp;
      this.sale = false; this.selSale = true; this.pickSale = true;
      // étiquettes : suppression des éléments disparus
      const vivants = new Set(this.geos.filter((e) => e.d.etiquette && e.d.etiquette.texte).map((e) => this._cleEtiquette(e)));
      for (const [k, el] of this.etiquettesEl) if (!vivants.has(k)) { el.remove(); this.etiquettesEl.delete(k); }
    }
    _majSelection() {
      const gl = this.gl;
      const remplir = (plages, n, buf) => {
        const a = new Float32Array(n);
        if (this.selectionNums.size) for (const p of plages) if (this.selectionNums.has(p.num)) a.fill(1, p.first, p.first + p.count);
        if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW); }
      };
      if (gl) {
        remplir(this.plagesOpaques, this.compte.opaque, this.buf.opaqueSel);
        remplir(this.plagesTransp, this.compte.transp, this.buf.transpSel);
        remplir(this.plagesLignes, this.compte.lignes, this.buf.lignesSel);
      }
      this.selSale = false;
    }
    _reconstruireDecor() {
      const L = Math.max(1, this.scene.largeur || 50), P = Math.max(1, this.scene.profondeur || 50);
      const m = Math.max(L, P) * 0.35 + 10;
      const sol = couleurRGB(this.o.couleurSol), marge = couleurRGB(this.o.couleurMarge);
      const tri = new Tampon(256);
      const q = (x1, y1, x2, y2, alt, rgb) => {
        const pts = [[x1, alt, y1], [x2, alt, y1], [x2, alt, y2], [x1, alt, y1], [x2, alt, y2], [x1, alt, y2]];
        for (const pt of pts) { tri.reserver(F_TRI); tri.a.set([pt[0], pt[1], pt[2], 0, 1, 0, rgb[0], rgb[1], rgb[2], 1, 0], tri.n); tri.n += F_TRI; }
      };
      q(-m, -m, L + m, P + m, -0.16, marge);
      q(0, 0, L, P, -0.12, sol);
      const decor = tri.fin();
      this.compte.decor = decor.length / F_TRI;
      // grille adaptée (au plus ~240 lignes par axe), lignes majeures toutes les 5 / 10
      const lig = new Tampon(1024);
      if (this.o.grille) {
        let pas = Math.max(0.05, Number(this.o.pasGrille) || 1);
        while (Math.max(L, P) / pas > 240) pas *= 2;
        const g = couleurRGB(this.o.couleurGrille);
        const k = this.o.opaciteGrille == null ? 1 : this.o.opaciteGrille;
        const major = pas >= 5 ? 2 : (pas >= 1 ? 5 : Math.round(1 / pas));
        const ligne = (x1, y1, x2, y2, a) => { lig.reserver(F_LIG * 2); for (const [x, y] of [[x1, y1], [x2, y2]]) { lig.a.set([x, 0.004, y, g[0], g[1], g[2], a * k, 0], lig.n); lig.n += F_LIG; } };
        let i = 0;
        for (let x = 0; x <= L + 1e-6; x += pas, i++) ligne(x, 0, x, P, i % major === 0 ? 0.42 : 0.16);
        i = 0;
        for (let y = 0; y <= P + 1e-6; y += pas, i++) ligne(0, y, L, y, i % major === 0 ? 0.42 : 0.16);
        // contour du plan
        const c = couleurRGB(this.o.couleurGrille);
        for (const [x1, y1, x2, y2] of [[0, 0, L, 0], [L, 0, L, P], [L, P, 0, P], [0, P, 0, 0]]) { lig.reserver(F_LIG * 2); lig.a.set([x1, 0.006, y1, c[0], c[1], c[2], 0.85, 0, x2, 0.006, y2, c[0], c[1], c[2], 0.85, 0], lig.n); lig.n += F_LIG * 2; }
      }
      const grille = lig.fin();
      this.compte.grille = grille.length / F_LIG;
      const gl = this.gl;
      if (gl) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.decor); gl.bufferData(gl.ARRAY_BUFFER, decor, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.grille); gl.bufferData(gl.ARRAY_BUFFER, grille, gl.STATIC_DRAW);
      }
      this.grilleCpu = grille;
      this.decorSale = false;
    }
    _reconstruireApercus() {
      const tri = [], lig = [];
      this.apercusGeo = [];
      for (const d of this.apercus) {
        const g = construireGeometrie(Object.assign({ opacite: 0.55, aretes: true, pickable: false }, d), 0);
        this.apercusGeo.push({ d, g });
        tri.push(g.tri); lig.push(g.lig);
      }
      const concat = (arr) => { const n = arr.reduce((s, a) => s + a.length, 0); const o = new Float32Array(n); let k = 0; for (const a of arr) { o.set(a, k); k += a.length; } return o; };
      const t = concat(tri), l = concat(lig);
      this.compte.apercu = t.length / F_TRI; this.compte.apercuLig = l.length / F_LIG;
      const gl = this.gl;
      if (gl) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.apercu); gl.bufferData(gl.ARRAY_BUFFER, t, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.apercuLig); gl.bufferData(gl.ARRAY_BUFFER, l, gl.DYNAMIC_DRAW);
      }
      this.apercuSale = false;
    }

    // ----- Caméra ---------------------------------------------------------------------------
    _matrices() {
      const W = Math.max(1, this.cssW || 1), H = Math.max(1, this.cssH || 1), aspect = W / H;
      const c = this.cam;
      const az = c.azimut * DEG, el = c.elevation * DEG, d = c.distance;
      const cible = [c.x, c.z, c.y];
      const diag = Math.hypot(this.scene.largeur || 50, this.scene.profondeur || 50);
      let vue, proj, oeil;
      if (c.dessus) {
        oeil = [c.x, c.z + d, c.y];
        vue = mat4.lookAt(oeil, cible, [-Math.sin(az), 0, -Math.cos(az)]);
        const hh = d * Math.tan(FOV / 2), hw = hh * aspect;
        proj = mat4.orthographique(-hw, hw, -hh, hh, 0.05, d + 2000);
      } else {
        oeil = [c.x + d * Math.sin(az) * Math.cos(el), c.z + d * Math.sin(el), c.y + d * Math.cos(az) * Math.cos(el)];
        vue = mat4.lookAt(oeil, cible, [0, 1, 0]);
        proj = mat4.perspective(FOV, aspect, Math.max(0.05, Math.min(50, d * 0.01)), d * 20 + diag * 3 + 100);
      }
      this.oeil = oeil;
      this.vp = mat4.multiplier(proj, vue);
      this.vpInv = mat4.inverser(this.vp);
      return this.vp;
    }
    get camera() { return Object.assign({}, this.cam); }
    definirCamera(etat, animer) {
      const cible = this._normaliserCam(Object.assign({}, this.cam, etat || {}));
      if (this.mode === '2d') cible.dessus = true;
      if (animer) this._animerVers(cible, typeof animer === 'number' ? animer : 650);
      else { this.tween = null; this.cam = cible; this.pickSale = true; this.demanderRendu(); this._notifierCamera(); }
    }
    _normaliserCam(c) {
      c.distance = Math.max(0.8, Math.min(20000, Number(c.distance) || 50));
      c.elevation = Math.max(4, Math.min(89, Number(c.elevation) || 45));
      c.azimut = ((Number(c.azimut) || 0) % 360 + 360) % 360;
      return c;
    }
    vueDessus(actif, animer = true) {
      if (this.mode === '2d') actif = true;
      this.definirCamera({ dessus: !!actif, elevation: actif ? 89 : Math.min(this.cam.elevation, 55) }, false);
      if (animer) this.demanderRendu();
    }
    /** Cadre tout le plan (ou les identifiants donnés). */
    recentrer(animer = true) {
      const L = this.scene.largeur || 50, P = this.scene.profondeur || 50;
      this._cadrer({ minX: 0, maxX: L, minY: 0, maxY: P, minZ: 0, maxZ: 0 }, animer, { azimut: this.mode === '2d' || this.cam.dessus ? 0 : (this.o.azimutDefaut != null ? this.o.azimutDefaut : 25), elevation: this.cam.dessus ? 89 : 48 });
    }
    cadrer(ids, animer = true) {
      const b = this.boiteDe(ids);
      if (b) this._cadrer(b, animer, {});
    }
    boiteDe(ids) {
      const nums = new Set((Array.isArray(ids) ? ids : [ids]).map((i) => this._num(i)));
      let b = null;
      for (const e of this.geos) {
        if (!nums.has(e.num)) continue;
        const g = e.g.boite;
        if (!b) b = Object.assign({}, g);
        else { b.minX = Math.min(b.minX, g.minX); b.maxX = Math.max(b.maxX, g.maxX); b.minY = Math.min(b.minY, g.minY); b.maxY = Math.max(b.maxY, g.maxY); b.minZ = Math.min(b.minZ, g.minZ); b.maxZ = Math.max(b.maxZ, g.maxZ); }
      }
      return b;
    }
    _cadrer(b, animer, extra) {
      const W = Math.max(1, this.cssW || 1), H = Math.max(1, this.cssH || 1), aspect = W / H;
      const lx = Math.max(1, b.maxX - b.minX), ly = Math.max(1, b.maxY - b.minY);
      const dessus = this.cam.dessus || this.mode === '2d';
      const demi = Math.max(ly / 2, lx / 2 / aspect) * (dessus ? 1.12 : 1.05);
      let distance = demi / Math.tan(FOV / 2);
      const cible = Object.assign({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: b.minZ || 0, distance: Math.max(3, distance) }, extra || {});
      if (!dessus) {
        // ajustement exact : on recule jusqu'à ce que les coins (au sol et en hauteur) tiennent dans l'écran
        const sauve = this.cam;
        const coins = [];
        for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ || 0, b.maxZ || 0]) coins.push([x, y, z]);
        let d = Math.max(3, distance * 0.8);
        for (let i = 0; i < 40; i++) {
          this.cam = this._normaliserCam(Object.assign({}, sauve, cible, { distance: d, dessus: false }));
          this._matrices();
          const ok = coins.every(([x, y, z]) => { const c = mat4.transformer(this.vp, x, z, y, 1); if (c[3] <= 0) return false; return Math.abs(c[0] / c[3]) < 0.9 && Math.abs(c[1] / c[3]) < 0.86; });
          if (ok) break;
          d *= 1.1;
        }
        this.cam = sauve; this._matrices();
        cible.distance = d;
      }
      this.definirCamera(cible, animer ? 700 : false);
    }
    /** Anime la caméra vers un objet (et le fait clignoter si demandé). */
    allerVers(id, opts = {}) {
      const b = this.boiteDe([id]);
      if (!b) return false;
      const taille = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 1);
      const cible = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: b.minZ, distance: opts.distance || Math.max(9, taille * 3.2) };
      if (!this.cam.dessus) cible.elevation = Math.max(30, Math.min(60, this.cam.elevation));
      this.definirCamera(cible, opts.duree || 900);
      if (opts.clignoter !== false) this.clignoter(id, opts.dureeClignotement || 3200);
      return true;
    }
    _animerVers(cible, duree) {
      const de = Object.assign({}, this.cam);
      let dAz = cible.azimut - de.azimut;
      if (dAz > 180) dAz -= 360; if (dAz < -180) dAz += 360;
      this.tween = { de, vers: cible, dAz, debut: performance.now(), duree: Math.max(1, duree) };
      if (cible.dessus !== de.dessus) this.cam.dessus = cible.dessus;
      this.demanderRendu();
    }
    _avancerTween(t) {
      const tw = this.tween;
      if (!tw) return false;
      let k = Math.min(1, (t - tw.debut) / tw.duree);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const a = tw.de, b = tw.vers;
      this.cam = Object.assign({}, b, {
        x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z + (b.z - a.z) * e,
        distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * e),
        azimut: ((a.azimut + tw.dAz * e) % 360 + 360) % 360,
        elevation: a.elevation + (b.elevation - a.elevation) * e,
        dessus: b.dessus,
      });
      this.pickSale = true;
      if (k >= 1) { this.tween = null; this.cam = Object.assign({}, b); this._notifierCamera(); return false; }
      return true;
    }
    _notifierCamera() { if (this.o.onCamera) { try { this.o.onCamera(this.camera); } catch (e) { /* ignore */ } } }

    // ----- Conversions ---------------------------------------------------------------------
    _ndc(px, py) { return [(px / Math.max(1, this.cssW)) * 2 - 1, 1 - (py / Math.max(1, this.cssH)) * 2]; }
    /** Point du sol (coordonnées du plan) sous un point écran (px CSS relatifs au canevas). */
    ecranVersSol(px, py, altitude) {
      if (!this.vpInv) this._matrices();
      if (!this.vpInv) return null;
      const [nx, ny] = this._ndc(px, py);
      return rayonSol(this.vpInv, nx, ny, altitude || 0);
    }
    /** Projection d'un point du plan (x, y, altitude z) vers l'écran (px CSS). */
    projeter(x, y, z) {
      if (!this.vp) this._matrices();
      const c = mat4.transformer(this.vp, x, z || 0, y, 1);
      if (c[3] <= 1e-6) return { x: 0, y: 0, visible: false, profondeur: 1 };
      const nx = c[0] / c[3], ny = c[1] / c[3], nz = c[2] / c[3];
      return { x: (nx + 1) / 2 * this.cssW, y: (1 - ny) / 2 * this.cssH, visible: nz > -1 && nz < 1 && nx > -1.3 && nx < 1.3 && ny > -1.3 && ny < 1.3, profondeur: nz };
    }
    /** Mètres par pixel à une altitude donnée (approximation au centre de l'écran). */
    metresParPixel() {
      const a = this.ecranVersSol(this.cssW / 2, this.cssH / 2, this.cam.z), b = this.ecranVersSol(this.cssW / 2 + 50, this.cssH / 2, this.cam.z);
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 50 : 0.1;
    }

    // ----- Rendu ------------------------------------------------------------------------------
    demanderRendu() {
      if (this.detruit || this.raf) return;
      this.raf = requestAnimationFrame((t) => { this.raf = 0; this._image(t); });
    }
    /** Rendu immédiat (synchrone). */
    rendre() { this._image(performance.now()); }
    _image(t) {
      if (this.detruit || this.perdu) return;
      let encore = this._avancerTween(t);
      if (this.clignNum) {
        if (t < this.clignFin) { this.flash = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t / 110)); encore = true; } else { this.clignNum = 0; this.flash = 0; }
      }
      this._matrices();
      if (this.gl) this._rendreGL(); else this._rendre2D();
      this._majEtiquettes();
      if (encore) this.demanderRendu();
    }

    _lier(prog, buf, layout) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = layout.stride * 4;
      for (const [nom, taille, offset] of layout.attrs) { const loc = ATTR[nom]; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, taille, gl.FLOAT, false, stride, offset * 4); }
    }
    _lierSel(buf) {
      const gl = this.gl;
      if (buf) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(ATTR.aSel); gl.vertexAttribPointer(ATTR.aSel, 1, gl.FLOAT, false, 4, 0); } else { gl.disableVertexAttribArray(ATTR.aSel); gl.vertexAttrib1f(ATTR.aSel, 0); }
    }
    _desactiverAttributs() { const gl = this.gl; for (let i = 1; i <= 5; i++) gl.disableVertexAttribArray(i); }
    _uniformsCommuns(pr, alpha) {
      const gl = this.gl, u = pr.u;
      if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, this.vp);
      if (u.uModele) gl.uniformMatrix4fv(u.uModele, false, mat4.identite());
      if (u.uLum) { const l = [0.42, 0.82, 0.38], n = Math.hypot(...l); gl.uniform3f(u.uLum, l[0] / n, l[1] / n, l[2] / n); }
      if (u.uAmb) gl.uniform1f(u.uAmb, 0.46);
      if (u.uSurv) gl.uniform1f(u.uSurv, this.survolNum || -1);
      if (u.uClign) gl.uniform1f(u.uClign, this.clignNum || -1);
      if (u.uFlash) gl.uniform1f(u.uFlash, this.flash || 0);
      if (u.uCoulSel) { const s = couleurRGB(this.o.couleurSelection || '#2563eb'); gl.uniform3f(u.uCoulSel, s[0], s[1], s[2]); }
      if (u.uAlpha) gl.uniform1f(u.uAlpha, alpha == null ? 1 : alpha);
    }
    /** Dessine des plages en excluant celles décalées (dessinées ensuite avec la matrice de déplacement). */
    _dessinerPlages(mode, plages, total, uModele) {
      const gl = this.gl;
      let appels = 0;
      if (!this.decal || !this.decal.nums.size) { if (total) { gl.drawArrays(mode, 0, total); appels++; } return appels; }
      const exclues = plages.filter((p) => this.decal.nums.has(p.num)).sort((a, b) => a.first - b.first);
      let pos = 0;
      for (const p of exclues) { if (p.first > pos) { gl.drawArrays(mode, pos, p.first - pos); appels++; } pos = Math.max(pos, p.first + p.count); }
      if (pos < total) { gl.drawArrays(mode, pos, total - pos); appels++; }
      if (exclues.length && uModele) {
        gl.uniformMatrix4fv(uModele, false, this.decal.matrice);
        for (const p of exclues) { gl.drawArrays(mode, p.first, p.count); appels++; }
        gl.uniformMatrix4fv(uModele, false, mat4.identite());
      }
      return appels;
    }

    _rendreGL() {
      const gl = this.gl;
      if (gl.isContextLost()) return;
      if (this.sale) this._reconstruire();
      if (this.decorSale) this._reconstruireDecor();
      if (this.selSale) this._majSelection();
      if (this.apercuSale) this._reconstruireApercus();
      const fondC = couleurRGB(this.o.couleurFond);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(fondC[0], fondC[1], fondC[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
      let appels = 0;
      const LT = { stride: F_TRI, attrs: [['aPos', 3, 0], ['aNorm', 3, 3], ['aCoul', 4, 6], ['aId', 1, 10]] };
      const LL = { stride: F_LIG, attrs: [['aPos', 3, 0], ['aCoul', 4, 3], ['aId', 1, 7]] };
      const tri = this.prog.tri, lig = this.prog.lig;

      // 1. décor (sol) + objets opaques
      gl.useProgram(tri.p);
      this._uniformsCommuns(tri, 1);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
      if (this.compte.decor) { this._lier(tri, this.buf.decor, LT); this._lierSel(null); gl.drawArrays(gl.TRIANGLES, 0, this.compte.decor); appels++; }
      if (this.compte.opaque) { this._lier(tri, this.buf.opaque, LT); this._lierSel(this.buf.opaqueSel); appels += this._dessinerPlages(gl.TRIANGLES, this.plagesOpaques, this.compte.opaque, tri.u.uModele); }
      gl.disable(gl.POLYGON_OFFSET_FILL);

      // 2. fond de plan (texture)
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (this.fond && this.fond.image && this.texFond && this.fond.visible !== false) {
        const coins = this.coinsFond();
        const y = (this.fond.y0 || 0) - 0.008;
        const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const ordre = [0, 1, 2, 0, 2, 3];
        const data = new Float32Array(ordre.length * 5);
        ordre.forEach((i, k) => data.set([coins[i][0], y, coins[i][1], uv[i][0], uv[i][1]], k * 5));
        const pr = this.prog.tex;
        gl.useProgram(pr.p);
        gl.uniformMatrix4fv(pr.u.uVP, false, this.vp);
        gl.uniform1f(pr.u.uOpacite, Math.max(0, Math.min(1, this.fond.opacite)));
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texFond); gl.uniform1i(pr.u.uTex, 0);
        this._desactiverAttributs();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.fond); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(ATTR.aPos); gl.vertexAttribPointer(ATTR.aPos, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(ATTR.aUV); gl.vertexAttribPointer(ATTR.aUV, 2, gl.FLOAT, false, 20, 12);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, 6); appels++;
        gl.depthMask(true);
        gl.disableVertexAttribArray(ATTR.aUV);
      }

      // 3. grille + arêtes
      gl.useProgram(lig.p);
      this._uniformsCommuns(lig, 1);
      this._desactiverAttributs();
      if (this.compte.grille) { gl.depthMask(false); this._lier(lig, this.buf.grille, LL); this._lierSel(null); gl.drawArrays(gl.LINES, 0, this.compte.grille); appels++; gl.depthMask(true); }
      if (this.compte.lignes) { this._lier(lig, this.buf.lignes, LL); this._lierSel(this.buf.lignesSel); appels += this._dessinerPlages(gl.LINES, this.plagesLignes, this.compte.lignes, lig.u.uModele); }

      // 4. objets transparents triés (du plus loin au plus proche)
      if (this.compte.transp) {
        gl.useProgram(tri.p);
        this._uniformsCommuns(tri, 1);
        this._desactiverAttributs();
        this._lier(tri, this.buf.transp, LT); this._lierSel(this.buf.transpSel);
        gl.depthMask(false);
        const o = this.oeil;
        const d2 = (p) => { const c = p.centre; return (c[0] - o[0]) ** 2 + (c[1] - o[1]) ** 2 + (c[2] - o[2]) ** 2; };
        // au-delà de 160 objets transparents, un seul appel de dessin (ordre de construction) pour rester fluide
        const plages = this.plagesTransp.length > 160 && !(this.decal && this.decal.nums.size) ? [{ first: 0, count: this.compte.transp, num: -1 }] : this.plagesTransp.slice().sort((a, b) => d2(b) - d2(a));
        for (const p of plages) {
          const decale = this.decal && this.decal.nums.has(p.num);
          if (decale) gl.uniformMatrix4fv(tri.u.uModele, false, this.decal.matrice);
          gl.drawArrays(gl.TRIANGLES, p.first, p.count); appels++;
          if (decale) gl.uniformMatrix4fv(tri.u.uModele, false, mat4.identite());
        }
        gl.depthMask(true);
      }
      // 5. aperçus (tracé en cours)
      if (this.compte.apercu || this.compte.apercuLig) {
        gl.useProgram(tri.p); this._uniformsCommuns(tri, 1); this._desactiverAttributs();
        gl.depthMask(false);
        if (this.compte.apercu) { this._lier(tri, this.buf.apercu, LT); this._lierSel(null); gl.drawArrays(gl.TRIANGLES, 0, this.compte.apercu); appels++; }
        gl.depthMask(true);
        if (this.compte.apercuLig) { gl.useProgram(lig.p); this._uniformsCommuns(lig, 1); this._desactiverAttributs(); this._lier(lig, this.buf.apercuLig, LL); this._lierSel(null); gl.drawArrays(gl.LINES, 0, this.compte.apercuLig); appels++; }
      }
      gl.disable(gl.BLEND);
      this._desactiverAttributs();
      this.stats.appels = appels;
      this.pickSale = true;
    }

    _assurerFbo() {
      const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
      if (this.fbo && this.fbo.w === w && this.fbo.h === h) return this.fbo;
      if (this.fbo) { gl.deleteFramebuffer(this.fbo.f); gl.deleteTexture(this.fbo.t); gl.deleteRenderbuffer(this.fbo.r); }
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const r = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, r);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, r);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fbo = { f, t, r, w, h };
      this.pickSale = true;
      return this.fbo;
    }
    _rendrePick() {
      const gl = this.gl;
      if (this.sale) this._reconstruire();
      this._matrices();
      const fbo = this._assurerFbo();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.f);
      gl.viewport(0, 0, fbo.w, fbo.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
      const pr = this.prog.pick;
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, this.vp);
      gl.uniformMatrix4fv(pr.u.uModele, false, mat4.identite());
      this._desactiverAttributs();
      const LT = { stride: F_TRI, attrs: [['aPos', 3, 0], ['aId', 1, 10]] };
      if (this.compte.decor) { this._lier(pr, this.buf.decor, LT); gl.drawArrays(gl.TRIANGLES, 0, this.compte.decor); }
      if (this.compte.opaque) { this._lier(pr, this.buf.opaque, LT); this._dessinerPlages(gl.TRIANGLES, this.plagesOpaques, this.compte.opaque, pr.u.uModele); }
      if (this.compte.transp) {
        this._lier(pr, this.buf.transp, LT);
        for (const p of this.plagesTransp) {
          if (!p.pick) continue;
          const decale = this.decal && this.decal.nums.has(p.num);
          if (decale) gl.uniformMatrix4fv(pr.u.uModele, false, this.decal.matrice);
          gl.drawArrays(gl.TRIANGLES, p.first, p.count);
          if (decale) gl.uniformMatrix4fv(pr.u.uModele, false, mat4.identite());
        }
      }
      this._desactiverAttributs();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.pickSale = false;
    }
    /** Identifiant (chaîne) de l'objet sous le point écran (px CSS), ou null. */
    pick(px, py) {
      if (this.detruit) return null;
      if (!this.gl) return this._pick2D(px, py);
      if (this.gl.isContextLost()) return null;
      if (this.pickSale || this.sale) this._rendrePick();
      const dpr = this.canvas.width / Math.max(1, this.cssW);
      const x = Math.floor(px * dpr), y = this.canvas.height - Math.floor(py * dpr) - 1;
      if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;
      const gl = this.gl;
      const pixel = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.f);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const num = pixel[0] + pixel[1] * 256 + pixel[2] * 65536;
      return num ? (this.idsInv.get(num) || null) : null;
    }

    // ----- Repli Canvas 2D (vue de dessus) ------------------------------------------------------
    _versEcran2D(x, y, z) { const c = mat4.transformer(this.vp, x, z || 0, y, 1); return [((c[0] / c[3]) + 1) / 2 * this.canvas.width, (1 - c[1] / c[3]) / 2 * this.canvas.height]; }
    _rendre2D() {
      if (this.sale) this._reconstruire();
      if (this.decorSale) this._reconstruireDecor();
      if (this.apercuSale) this._reconstruireApercus();
      this.selSale = false;
      const g = this.ctx2d, W = this.canvas.width, H = this.canvas.height;
      const dpr = W / Math.max(1, this.cssW);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = rgbCss(couleurRGB(this.o.couleurFond)); g.fillRect(0, 0, W, H);
      const P = (x, y) => this._versEcran2D(x, y, 0);
      const poly = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => { const [sx, sy] = P(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); g.closePath(); };
      const L = this.scene.largeur || 50, Pr = this.scene.profondeur || 50;
      poly([[0, 0], [L, 0], [L, Pr], [0, Pr]]); g.fillStyle = rgbCss(couleurRGB(this.o.couleurSol)); g.fill();
      // fond de plan
      if (this.fond && this.fond.image && this.fond.image.complete && this.fond.visible !== false) {
        const coins = this.coinsFond(), img = this.fond.image;
        const [ax, ay] = P(...coins[0]), [bx, by] = P(...coins[1]), [dx, dy] = P(...coins[3]);
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        g.save(); g.globalAlpha = Math.max(0, Math.min(1, this.fond.opacite));
        g.setTransform((bx - ax) / iw, (by - ay) / iw, (dx - ax) / ih, (dy - ay) / ih, ax, ay);
        g.drawImage(img, 0, 0); g.restore(); g.setTransform(1, 0, 0, 1, 0, 0);
      }
      // grille
      if (this.grilleCpu && this.grilleCpu.length) {
        const gc = couleurRGB(this.o.couleurGrille);
        g.lineWidth = 1;
        for (let k = 0; k < this.grilleCpu.length; k += F_LIG * 2) {
          const a = this.grilleCpu;
          const [x1, y1] = P(a[k], a[k + 2]), [x2, y2] = P(a[k + F_LIG], a[k + F_LIG + 2]);
          g.strokeStyle = rgbCss(gc, a[k + 6]); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        }
      }
      // objets (du plus bas au plus haut)
      const liste = this.geos.filter((e) => e.d.forme !== 'aucune' && e.g.empreinte.length >= 2).slice().sort((a, b) => (a.g.boite.maxZ - b.g.boite.maxZ) || (a.g.boite.minZ - b.g.boite.minZ));
      const dessiner = (e, decale) => {
        const d = e.d;
        let pts = e.g.empreinte;
        if (decale) { const m = this.decal.matrice; pts = pts.map(([x, y]) => [m[0] * x + m[8] * y + m[12], m[2] * x + m[10] * y + m[14]]); }
        let rgb = couleurRGB(d.couleur);
        const sel = this.selectionNums.has(e.num), surv = e.num === this.survolNum && e.num, clign = e.num === this.clignNum && e.num;
        if (surv) rgb = eclaircir(rgb, 0.25);
        if (clign) rgb = rgb.map((v, i) => v + ([1, 0.78, 0.05][i] - v) * this.flash);
        const alpha = d.opacite == null ? 1 : d.opacite;
        if (d.faces && d.faces.toit === false && d.faces.sol !== true) { // façade seule : contour
          poly(pts); g.strokeStyle = rgbCss(assombrir(rgb, 0.7), Math.max(0.5, alpha * 3)); g.lineWidth = 2 * dpr; g.stroke();
        } else {
          poly(pts); g.fillStyle = rgbCss(rgb, alpha); g.fill();
          if (d.aretes || sel) { g.strokeStyle = sel ? rgbCss(couleurRGB(this.o.couleurSelection || '#2563eb')) : rgbCss(assombrir(rgb, 0.6), Math.min(1, 0.4 + alpha)); g.lineWidth = (sel ? 2.5 : 1) * dpr; g.stroke(); }
        }
        if (sel) { g.fillStyle = rgbCss(couleurRGB(this.o.couleurSelection || '#2563eb'), 0.22); poly(pts); g.fill(); }
      };
      for (const e of liste) dessiner(e, this.decal && this.decal.nums.has(e.num));
      for (const a of this.apercusGeo || []) dessiner({ d: Object.assign({ opacite: 0.55, aretes: true }, a.d), g: a.g, num: -1 }, false);
      this.stats.appels = liste.length;
    }
    _pick2D(px, py) {
      const p = this.ecranVersSol(px, py, 0);
      if (!p) return null;
      const liste = this.geos.filter((e) => e.d.pickable !== false && e.d.forme !== 'aucune' && e.g.empreinte.length >= 3).slice().sort((a, b) => (b.g.boite.maxZ - a.g.boite.maxZ) || (b.g.boite.minZ - a.g.boite.minZ));
      for (const e of liste) {
        let pts = e.g.empreinte;
        if (this.decal && this.decal.nums.has(e.num)) { const m = this.decal.matrice; pts = pts.map(([x, y]) => [m[0] * x + m[8] * y + m[12], m[2] * x + m[10] * y + m[14]]); }
        if (e.d.faces && e.d.faces.toit === false) continue;
        if (pointDansPolygone(p.x, p.y, pts)) return this.idsInv.get(e.num) || null;
      }
      return null;
    }

    // ----- Étiquettes HTML projetées ----------------------------------------------------------
    _cleEtiquette(e) { return e.num + ':' + (e.d.etiquette.cle || ''); }
    _majEtiquettes() {
      const calque = this.calqueEtiquettes;
      if (!this.etiquettesActives) { calque.style.display = 'none'; return; }
      calque.style.display = '';
      const candidats = [];
      const vus = new Set();
      for (const e of this.geos) {
        const et = e.d.etiquette;
        if (!et || !et.texte) continue;
        const cle = this._cleEtiquette(e);
        if (vus.has(cle)) continue;
        vus.add(cle);
        const b = e.g.boite;
        let x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2, z = et.z != null ? et.z : b.maxZ + 0.15;
        if (this.decal && this.decal.nums.has(e.num)) { const m = this.decal.matrice; const nx = m[0] * x + m[8] * y + m[12], ny = m[2] * x + m[10] * y + m[14]; x = nx; y = ny; }
        const pr = this.projeter(x, y, z);
        const sel = this.selectionNums.has(e.num);
        candidats.push({ e, et, cle, pr, sel, priorite: (sel ? 1000 : 0) + (e.num === this.survolNum ? 500 : 0) + (et.priorite || 0) });
      }
      candidats.sort((a, b) => b.priorite - a.priorite || a.pr.profondeur - b.pr.profondeur);
      const occupes = [];
      const cell = 80, grille = new Map();
      const chevauche = (r) => {
        const x0 = Math.floor(r.x / cell), x1 = Math.floor((r.x + r.w) / cell), y0 = Math.floor(r.y / cell), y1 = Math.floor((r.y + r.h) / cell);
        for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (const o of grille.get(i + ',' + j) || []) if (r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y) return true;
        return false;
      };
      const occuper = (r) => { occupes.push(r); const x0 = Math.floor(r.x / cell), x1 = Math.floor((r.x + r.w) / cell), y0 = Math.floor(r.y / cell), y1 = Math.floor((r.y + r.h) / cell); for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = i + ',' + j; if (!grille.has(k)) grille.set(k, []); grille.get(k).push(r); } };
      const mpp = this.metresParPixel();
      let affichees = 0;
      for (const c of candidats) {
        let el = this.etiquettesEl.get(c.cle);
        if (!el) { el = document.createElement('div'); el.className = 'm3d-etiquette'; calque.appendChild(el); this.etiquettesEl.set(c.cle, el); el._texte = null; el._visible = true; }
        const classe = 'm3d-etiquette ' + (c.et.classe || '') + (c.sel ? ' selectionnee' : '');
        if (el._classe !== classe) { el.className = classe; el._classe = classe; }
        if (el._texte !== c.et.texte || el._pastille !== c.et.pastille) {
          el.textContent = '';
          if (c.et.pastille) { const p = document.createElement('span'); p.className = 'pastille-et'; p.style.background = c.et.pastille; el.appendChild(p); }
          el.appendChild(document.createTextNode(c.et.texte));
          el._texte = c.et.texte; el._pastille = c.et.pastille; el._taille = null;
        }
        if (c.et.tailleM) {
          const px = Math.max(8, Math.min(46, c.et.tailleM / Math.max(0.0001, mpp)));
          const fs = Math.round(px) + 'px';
          if (el.style.fontSize !== fs) { el.style.fontSize = fs; el._taille = null; }
        }
        let visible = c.pr.visible && affichees < 160;
        if (visible && c.et.pixelsMin && !c.sel && c.e.num !== this.survolNum && !c.et.toujours) {
          // étiquette masquée si l'objet est trop petit à l'écran (vue éloignée d'un grand plan)
          const b = c.e.g.boite, t = Math.max(b.maxX - b.minX, b.maxY - b.minY, 0.3);
          const q = this.projeter((b.minX + b.maxX) / 2 + t, (b.minY + b.maxY) / 2, b.maxZ);
          if (Math.hypot(q.x - c.pr.x, q.y - c.pr.y) < c.et.pixelsMin) visible = false;
        }
        if (visible) {
          if (!el._taille) {
            // mesure fiable même si l'étiquette était masquée à l'image précédente
            const cachee = el._visible === false;
            if (cachee) { el.style.visibility = 'hidden'; el.style.display = ''; }
            el._taille = [el.offsetWidth || 60, el.offsetHeight || 18];
            if (cachee) { el.style.display = 'none'; el.style.visibility = ''; }
          }
          const [w, h] = el._taille;
          const centre = c.et.classe === 'zone' || c.et.classe === 'texte-sol' || c.et.classe === 'batiment';
          const r = { x: c.pr.x - w / 2, y: centre ? c.pr.y - h / 2 : c.pr.y - h - 4, w, h };
          if (!c.sel && chevauche(r)) visible = false;
          else {
            occuper(r); affichees++;
            const t = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
            if (el._t !== t) { el.style.transform = t; el._t = t; }
          }
        }
        if (visible !== el._visible) { el.style.display = visible ? '' : 'none'; el._visible = visible; }
      }
      for (const [k, el] of this.etiquettesEl) if (!vus.has(k) && el._visible) { el.style.display = 'none'; el._visible = false; }
    }
    /** Positions des étiquettes visibles (pour la capture). */
    _etiquettesVisibles() {
      const out = [];
      for (const [, el] of this.etiquettesEl) if (el._visible && el._t && this.etiquettesActives) { const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(el._t); if (m) out.push({ x: Number(m[1]), y: Number(m[2]), w: el._taille ? el._taille[0] : 60, h: el._taille ? el._taille[1] : 18, texte: el._texte, classe: el._classe || '', taille: parseFloat(el.style.fontSize) || 11.5 }); }
      return out;
    }

    // ----- Interactions -----------------------------------------------------------------------
    _initInteractions() {
      const cv = this.canvas;
      const pointeurs = new Map();
      let geste = null;
      let dernierSurvol = 0, survolEnAttente = null;
      const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      const info = (ev, p, avecPick) => {
        const alt = this.o.altitudeInteraction ? this.o.altitudeInteraction() : 0;
        return { x: p.x, y: p.y, sol: this.ecranVersSol(p.x, p.y, alt), id: avecPick ? this.pick(p.x, p.y) : undefined, bouton: ev.button, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey, ev };
      };
      this._on(cv, 'contextmenu', (ev) => ev.preventDefault());
      this._on(cv, 'pointerdown', (ev) => {
        if (this.detruit) return;
        cv.focus({ preventScroll: true });
        const p = pos(ev);
        pointeurs.set(ev.pointerId, p);
        try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        this.tween = null;
        if (pointeurs.size === 2) {
          const [a, b] = Array.from(pointeurs.values());
          geste = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: Object.assign({}, this.cam), bouge: true };
          return;
        }
        if (pointeurs.size > 2) return;
        const inf = info(ev, p, true);
        if (this.o.intercepteur && this.o.intercepteur.down && this.o.intercepteur.down(inf) === true) { geste = { type: 'externe', depart: p, bouge: false }; return; }
        const panGauche = this.cam.dessus || this.mode === '2d' || ev.shiftKey;
        const type = ev.button === 2 || ev.button === 1 || panGauche ? 'pan' : 'rotation';
        geste = { type, depart: p, dernier: p, bouge: false, cam0: Object.assign({}, this.cam), idDepart: inf.id, infoDepart: inf };
        if (type === 'pan') { this._matrices(); geste.sol0 = this.ecranVersSol(p.x, p.y, this.cam.z); geste.vpInv0 = this.vpInv; }
      });
      this._on(cv, 'pointermove', (ev) => {
        if (this.detruit) return;
        const p = pos(ev);
        if (pointeurs.has(ev.pointerId)) pointeurs.set(ev.pointerId, p);
        if (!geste) {
          if (ev.pointerType === 'mouse' && (this.o.onSurvol || this.o.survolActif !== false)) {
            survolEnAttente = p;
            const maintenant = performance.now();
            if (maintenant - dernierSurvol > 40) {
              dernierSurvol = maintenant;
              requestAnimationFrame(() => {
                if (!survolEnAttente || this.detruit) return;
                const q = survolEnAttente; survolEnAttente = null;
                const id = this.pick(q.x, q.y);
                const n = id == null ? 0 : this._num(id);
                if (n !== this.survolNum) { this.survolNum = n; this.demanderRendu(); if (this.o.onSurvol) this.o.onSurvol(id, q); }
                cv.style.cursor = id && this.curseurBase === 'default' ? 'pointer' : this.curseurBase;
              });
            }
            if (this.o.onDeplacement) this.o.onDeplacement(info(ev, p, false));
          }
          return;
        }
        if (geste.type === 'pinch') {
          const pts = Array.from(pointeurs.values());
          if (pts.length < 2) return;
          const [a, b] = pts;
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const c0 = geste.cam0;
          this.cam = this._normaliserCam(Object.assign({}, c0, { distance: c0.distance * geste.d0 / d }));
          this._matrices();
          const s0 = this.ecranVersSol(geste.m0.x, geste.m0.y, c0.z), s1 = this.ecranVersSol(m.x, m.y, c0.z);
          if (s0 && s1) { this.cam.x = c0.x + (s0.x - s1.x); this.cam.y = c0.y + (s0.y - s1.y); }
          this.pickSale = true; this.demanderRendu();
          return;
        }
        const dx = p.x - geste.depart.x, dy = p.y - geste.depart.y;
        if (!geste.bouge && Math.hypot(dx, dy) > 3) geste.bouge = true;
        if (geste.type === 'externe') { if (this.o.intercepteur.move) this.o.intercepteur.move(info(ev, p, false)); return; }
        if (!geste.bouge) return;
        if (geste.type === 'rotation') {
          const ddx = p.x - geste.dernier.x, ddy = p.y - geste.dernier.y;
          this.cam.azimut = ((this.cam.azimut - ddx * 0.35) % 360 + 360) % 360;
          this.cam.elevation = Math.max(4, Math.min(89, this.cam.elevation + ddy * 0.3));
          geste.dernier = p;
          cv.style.cursor = 'grabbing';
        } else if (geste.type === 'pan' && geste.sol0) {
          const [nx, ny] = this._ndc(p.x, p.y);
          const s = rayonSol(geste.vpInv0, nx, ny, geste.cam0.z);
          if (s) { this.cam.x = geste.cam0.x + (geste.sol0.x - s.x); this.cam.y = geste.cam0.y + (geste.sol0.y - s.y); }
          cv.style.cursor = 'grabbing';
        }
        this.pickSale = true; this.demanderRendu();
      });
      const fin = (ev) => {
        if (this.detruit) return;
        const p = pos(ev);
        pointeurs.delete(ev.pointerId);
        try { cv.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        if (!geste) return;
        const g = geste;
        if (g.type === 'pinch') { if (pointeurs.size === 0) geste = null; this._notifierCamera(); return; }
        geste = null;
        cv.style.cursor = this.curseurBase;
        if (g.type === 'externe') { if (this.o.intercepteur.up) this.o.intercepteur.up(Object.assign(info(ev, p, false), { bouge: g.bouge, annule: ev.type === 'pointercancel' })); return; }
        if (g.bouge) { this._notifierCamera(); return; }
        if (ev.type === 'pointercancel') return;
        if (this.o.onClic) this.o.onClic(Object.assign({}, g.infoDepart, { ev }));
      };
      this._on(cv, 'pointerup', fin);
      this._on(cv, 'pointercancel', fin);
      this._on(cv, 'pointerleave', () => { if (!geste && this.survolNum) { this.survolNum = 0; this.demanderRendu(); if (this.o.onSurvol) this.o.onSurvol(null); } });
      this._on(cv, 'dblclick', (ev) => { const p = pos(ev); if (this.o.onDoubleClic) this.o.onDoubleClic(info(ev, p, true)); });
      this._on(cv, 'wheel', (ev) => {
        ev.preventDefault();
        this.tween = null;
        const p = pos(ev);
        const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
        const f = Math.exp(Math.max(-0.6, Math.min(0.6, delta * 0.0016)));
        this._matrices();
        const avant = this.ecranVersSol(p.x, p.y, this.cam.z);
        this.cam.distance = Math.max(0.8, Math.min(20000, this.cam.distance * f));
        this._matrices();
        const apres = this.ecranVersSol(p.x, p.y, this.cam.z);
        if (avant && apres) { this.cam.x += avant.x - apres.x; this.cam.y += avant.y - apres.y; }
        this.pickSale = true; this.demanderRendu();
        clearTimeout(this._tRoue); this._tRoue = setTimeout(() => this._notifierCamera(), 200);
      }, { passive: false });
      this._on(cv, 'keydown', (ev) => {
        if (this.o.clavier === false || (typeof this.o.clavier === 'function' && !this.o.clavier(ev))) return;
        const c = this.cam, pas = c.distance * 0.06;
        const az = c.azimut * DEG;
        const fx = -Math.sin(az), fy = -Math.cos(az); // direction « vers l'avant » au sol
        let traite = true;
        switch (ev.key) {
          case 'ArrowLeft': if (ev.shiftKey || c.dessus) { c.x -= -fy * pas; c.y -= fx * pas; } else c.azimut = (c.azimut + 5) % 360; break;
          case 'ArrowRight': if (ev.shiftKey || c.dessus) { c.x += -fy * pas; c.y += fx * pas; } else c.azimut = (c.azimut + 355) % 360; break;
          case 'ArrowUp': if (ev.shiftKey || c.dessus) { c.x += fx * pas; c.y += fy * pas; } else c.elevation = Math.min(89, c.elevation + 3); break;
          case 'ArrowDown': if (ev.shiftKey || c.dessus) { c.x -= fx * pas; c.y -= fy * pas; } else c.elevation = Math.max(4, c.elevation - 3); break;
          case '+': case '=': c.distance = Math.max(0.8, c.distance * 0.85); break;
          case '-': case '_': c.distance = Math.min(20000, c.distance / 0.85); break;
          case 'Home': this.recentrer(true); break;
          default: traite = false;
        }
        if (traite) { ev.preventDefault(); ev.stopPropagation(); this.pickSale = true; this.demanderRendu(); this._notifierCamera(); }
      });
    }

    // ----- Taille, capture, destruction ----------------------------------------------------
    redimensionner() {
      if (this.detruit) return;
      const w = this.conteneur.clientWidth, h = this.conteneur.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      this.cssW = w; this.cssH = h;
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W; this.canvas.height = H;
        this.pickSale = true;
        for (const [, el] of this.etiquettesEl) el._taille = null;
      }
      this.rendre();
    }
    /** Capture : canevas (rendu + étiquettes) ; options.titre / options.sousTitre en bandeau. */
    capture(options = {}) {
      this.rendre();
      const src = this.canvas;
      const out = document.createElement('canvas');
      out.width = src.width; out.height = src.height;
      const g = out.getContext('2d');
      g.drawImage(src, 0, 0);
      const dpr = src.width / Math.max(1, this.cssW);
      g.save(); g.scale(dpr, dpr);
      g.lineJoin = 'round'; g.miterLimit = 2; g.textBaseline = 'middle';
      for (const e of this._etiquettesVisibles()) {
        const sel = /selectionnee/.test(e.classe);
        const sol = /zone|texte-sol|batiment/.test(e.classe) && !sel;
        const maj = /zone/.test(e.classe);
        const texte = maj ? String(e.texte || '').toUpperCase() : String(e.texte || '');
        g.font = `${sol ? 700 : 600} ${e.taille}px "Segoe UI", Arial, sans-serif`;
        if (!sol) {
          g.fillStyle = sel ? '#2563eb' : 'rgba(255,255,255,0.94)'; g.strokeStyle = sel ? '#2563eb' : 'rgba(0,0,0,0.22)'; g.lineWidth = 1;
          g.beginPath(); if (g.roundRect) g.roundRect(e.x + 0.5, e.y + 0.5, e.w, e.h, 9); else g.rect(e.x, e.y, e.w, e.h); g.fill(); g.stroke();
          g.fillStyle = sel ? '#ffffff' : '#111827';
          g.fillText(texte, e.x + 7, e.y + e.h / 2 + 0.5);
        } else {
          g.lineWidth = 3.5; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.fillStyle = '#111827';
          g.strokeText(texte, e.x, e.y + e.h / 2); g.fillText(texte, e.x, e.y + e.h / 2);
        }
      }
      if (options.titre) {
        g.fillStyle = 'rgba(17,24,39,0.78)'; g.fillRect(0, 0, this.cssW, options.sousTitre ? 44 : 30);
        g.fillStyle = '#fff'; g.font = '600 15px "Segoe UI", Arial, sans-serif'; g.fillText(options.titre, 12, 20);
        if (options.sousTitre) { g.font = '12px "Segoe UI", Arial, sans-serif'; g.fillStyle = '#d1d5db'; g.fillText(options.sousTitre, 12, 37); }
      }
      g.restore();
      return out;
    }
    /** Simule une perte de contexte WebGL (tests / diagnostic). */
    simulerPerteContexte(restaurerApresMs) {
      const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      if (restaurerApresMs != null) setTimeout(() => ext.restoreContext(), restaurerApresMs);
      return true;
    }
    detruire() {
      if (this.detruit) return;
      this.detruit = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      clearTimeout(this._tRoue);
      if (this.ro) this.ro.disconnect();
      for (const [c, e, f, o] of this._ecouteurs) c.removeEventListener(e, f, o);
      this._ecouteurs = [];
      if (this.gl) {
        const gl = this.gl;
        try {
          for (const b of Object.values(this.buf || {})) gl.deleteBuffer(b);
          for (const p of Object.values(this.prog || {})) gl.deleteProgram(p.p);
          if (this.texFond) gl.deleteTexture(this.texFond);
          if (this.fbo) { gl.deleteFramebuffer(this.fbo.f); gl.deleteTexture(this.fbo.t); gl.deleteRenderbuffer(this.fbo.r); }
          const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
        } catch (e) { /* ignore */ }
      }
      this.cache.clear(); this.geos = []; this.etiquettesEl.clear();
      if (this.racine.parentNode) this.racine.remove();
    }
  }

  function webglDisponible() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch (e) { return false; }
  }

  const Moteur3D = {
    version: '1.0',
    creer: (conteneur, options) => new Moteur(conteneur, options),
    webglDisponible,
    utils: { mat4, rayonSol, couleurRGB, rgbCss, eclaircir, assombrir, triangulerPolygone, aireSignee, pointDansPolygone, construireGeometrie, F_TRI, F_LIG },
  };
  global.Moteur3D = Moteur3D;
  if (typeof module !== 'undefined' && module.exports) module.exports = Moteur3D;
})(typeof window !== 'undefined' ? window : globalThis);
