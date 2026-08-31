'use strict';

/*
 * Generates a few realistic sample DXF parts into samples/ so the app can be
 * tried immediately. Run: npm run samples
 */

const fs = require('fs');
const path = require('path');
const { writeDxf } = require('../src/core/dxf');

const OUT = path.join(__dirname, '..', 'samples');

function poly(verts, closed = true, layer = '0') {
  return { type: 'POLYLINE', layer, closed, verts: verts.map(([x, y, b]) => ({ x, y, bulge: b || 0 })) };
}
function circle(cx, cy, r, layer = '0') {
  return { type: 'CIRCLE', layer, cx, cy, r };
}

const parts = {
  // L-bracket 200 x 150, leg width 60, two mounting holes
  'nosac_L.dxf': [
    poly([[0, 0], [200, 0], [200, 60], [60, 60], [60, 150], [0, 150]]),
    circle(30, 30, 6),
    circle(30, 120, 6),
  ],

  // Small plate 120 x 80 with 4 corner holes
  'plocica_rupe.dxf': [
    poly([[0, 0], [120, 0], [120, 80], [0, 80]]),
    circle(15, 15, 4),
    circle(105, 15, 4),
    circle(105, 65, 4),
    circle(15, 65, 4),
  ],

  // Flange: outer d160, bore d60, 6 bolt holes d12 on a d110 circle
  'prirubnica.dxf': (() => {
    const es = [circle(0, 0, 80), circle(0, 0, 30)];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      es.push(circle(55 * Math.cos(a), 55 * Math.sin(a), 6));
    }
    return es;
  })(),

  // Triangular gusset 100 x 100 with a lightening hole
  'kutnik_trokut.dxf': [
    poly([[0, 0], [100, 0], [0, 100]]),
    circle(28, 28, 12),
  ],

  // Strip 300 x 40 with a rounded slot (bulge = 1 gives semicircle caps)
  'traka_utor.dxf': [
    poly([[0, 0], [300, 0], [300, 40], [0, 40]]),
    poly([[60, 15], [240, 15, 1], [240, 25], [60, 25, 1]], true),
  ],

  // Rounded-corner plate 140 x 90, radius 15 (bulge = tan(90deg/4))
  'zaobljena_plocica.dxf': (() => {
    const b = Math.tan(Math.PI / 8);
    return [
      poly([
        [15, 0], [125, 0, b], [140, 15], [140, 75, b], [125, 90],
        [15, 90, b], [0, 75], [0, 15, b],
      ]),
      circle(70, 45, 20),
    ];
  })(),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, entities] of Object.entries(parts)) {
  fs.writeFileSync(path.join(OUT, name), writeDxf(entities), 'utf8');
  console.log('written', path.join('samples', name));
}
