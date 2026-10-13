#!/usr/bin/env node
'use strict';
/**
 * Génère electron/icon.png (256×256) sans dépendance externe :
 * carré arrondi bleu + clé à molette stylisée en blanc.
 * Usage : node scripts/generer-icone.js [couleur]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TAILLE = 256;
const couleur = process.argv[2] || '#2563eb';
const [R, G, B] = [1, 3, 5].map((i) => parseInt(couleur.slice(i, i + 2), 16));

function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Dessin : rendu avec sur-échantillonnage 3×3 pour un anticrénelage simple
const SS = 3;
function dansCarreArrondi(x, y) {
  const r = 48, m = 8;
  const X = Math.max(m + r, Math.min(TAILLE - m - r, x)), Y = Math.max(m + r, Math.min(TAILLE - m - r, y));
  return (x - X) ** 2 + (y - Y) ** 2 <= r * r;
}
function dansCle(x, y) {
  // clé : tête = anneau avec encoche, manche = barre diagonale
  const cx = 168, cy = 88;
  const d = Math.hypot(x - cx, y - cy);
  const anneau = d <= 40 && d >= 18;
  const encoche = Math.abs((x - cx) - (y - cy)) < 14 && (x - cx) > 12 && (y - cy) > 12;
  if (anneau && !encoche) return true;
  // manche : segment de (cx-20, cy+20) vers (64, 192), largeur 30
  const ax = cx - 20, ay = cy + 20, bx = 64, by = 192;
  const vx = bx - ax, vy = by - ay; const l2 = vx * vx + vy * vy;
  let t = ((x - ax) * vx + (y - ay) * vy) / l2; t = Math.max(0, Math.min(1, t));
  const px = ax + t * vx, py = ay + t * vy;
  return Math.hypot(x - px, y - py) <= 15;
}

const rows = [];
for (let y = 0; y < TAILLE; y++) {
  const row = Buffer.alloc(1 + TAILLE * 4); row[0] = 0;
  for (let x = 0; x < TAILLE; x++) {
    let fond = 0, blanc = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      if (dansCarreArrondi(px, py)) { fond++; if (dansCle(px, py)) blanc++; }
    }
    const a = fond / (SS * SS), w = blanc / (SS * SS);
    const o = 1 + x * 4;
    row[o] = Math.round(R * (1 - w) + 255 * w);
    row[o + 1] = Math.round(G * (1 - w) + 255 * w);
    row[o + 2] = Math.round(B * (1 - w) + 255 * w);
    row[o + 3] = Math.round(255 * a);
  }
  rows.push(row);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(TAILLE, 0); ihdr.writeUInt32BE(TAILLE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'electron', 'icon.png');
fs.writeFileSync(out, png);
console.log('Icône générée :', out, png.length, 'octets');
