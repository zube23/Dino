'use strict';

/*
 * Generates build/icon.png (256x256) without any dependencies - a simple
 * "nested sheets" motif on a dark background. electron-builder converts the
 * PNG to .ico for the Windows build. Run: npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function fillRect(x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b, a);
}

function strokeRect(x0, y0, w, h, t, r, g, b) {
  fillRect(x0, y0, w, t, r, g, b);
  fillRect(x0, y0 + h - t, w, t, r, g, b);
  fillRect(x0, y0, t, h, r, g, b);
  fillRect(x0 + w - t, y0, t, h, r, g, b);
}

// Background: dark rounded square
const RAD = 44;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = Math.max(RAD - x, x - (S - 1 - RAD), 0);
    const cy = Math.max(RAD - y, y - (S - 1 - RAD), 0);
    if (cx * cx + cy * cy <= RAD * RAD) set(x, y, 18, 22, 28);
  }
}

// Sheet border (orange)
strokeRect(30, 40, 196, 176, 10, 255, 122, 26);

// Nested "parts"
fillRect(56, 66, 88, 60, 255, 165, 82);   // big part
fillRect(156, 66, 44, 124, 255, 122, 26); // tall part
fillRect(56, 140, 40, 50, 255, 200, 140); // small part
fillRect(104, 140, 40, 50, 255, 200, 140); // small part

// --- PNG encoding ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written', out, png.length + ' bytes');
