'use strict';

/* Plain-Node test suite for the DinoNest core. Run: npm test */

const {
  parseDxf, writeDxf, transformEntity, sampleEntity, sampleEntities, bulgeArcPoints, arcSweep,
} = require('../src/core/dxf');
const {
  bboxOfPoints, convexHull, polygonArea, minAreaRect, rotatePoints,
} = require('../src/core/geometry');
const { MaxRectsBin, nestParts } = require('../src/core/nest');
const { analyzePart, generateSheet, buildSheetDxf } = require('../src/core/parts');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name + (detail ? ' -- ' + detail : ''));
    console.error('FAIL:', name, detail || '');
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------------------
// DXF fixtures (hand-written text, as exported by common CAD programs)
// ---------------------------------------------------------------------------

function dxfDoc(entityLines) {
  return [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...entityLines,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

{
  const doc = dxfDoc([
    '0', 'LINE', '8', 'CUT', '10', '0', '20', '0', '11', '100', '21', '50',
    '0', 'CIRCLE', '8', 'CUT', '10', '10', '20', '20', '40', '5',
    '0', 'ARC', '8', 'CUT', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90',
  ]);
  const { entities, warnings } = parseDxf(doc);
  check('parse basic entity count', entities.length === 3, 'got ' + entities.length);
  check('parse no warnings', warnings.length === 0, warnings.join(';'));
  check('parse line coords', entities[0].x2 === 100 && entities[0].y2 === 50);
  check('parse layer', entities[0].layer === 'CUT');
  check('parse circle', entities[1].r === 5 && entities[1].cx === 10);
  check('parse arc angles', entities[2].a1 === 0 && entities[2].a2 === 90);
}

{
  // LWPOLYLINE closed with a bulge
  const doc = dxfDoc([
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', '100', '20', '0', '42', '0.5',
    '10', '100', '20', '50',
    '10', '0', '20', '50',
  ]);
  const { entities } = parseDxf(doc);
  check('lwpolyline parsed', entities.length === 1 && entities[0].type === 'POLYLINE');
  check('lwpolyline closed', entities[0].closed === true);
  check('lwpolyline verts', entities[0].verts.length === 4);
  check('lwpolyline bulge', entities[0].verts[1].bulge === 0.5);
}

{
  // Legacy POLYLINE / VERTEX / SEQEND
  const doc = dxfDoc([
    '0', 'POLYLINE', '8', '0', '66', '1', '70', '1',
    '0', 'VERTEX', '8', '0', '10', '0', '20', '0',
    '0', 'VERTEX', '8', '0', '10', '80', '20', '0',
    '0', 'VERTEX', '8', '0', '10', '80', '20', '40',
    '0', 'SEQEND',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
  ]);
  const { entities } = parseDxf(doc);
  check('polyline+line parsed', entities.length === 2, 'got ' + entities.length);
  check('polyline verts', entities[0].verts.length === 3);
  check('polyline closed flag', entities[0].closed === true);
  check('entity after seqend parsed', entities[1].type === 'LINE');
}

{
  // INSERT expansion with rotation
  const doc = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '100', '50', '90',
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
  const { entities } = parseDxf(doc);
  check('insert expanded', entities.length === 1 && entities[0].type === 'LINE');
  const e = entities[0];
  check('insert rotate+translate', approx(e.x1, 100) && approx(e.y1, 100) && approx(e.x2, 100) && approx(e.y2, 110),
    JSON.stringify(e));
}

{
  // Mirrored INSERT must be skipped with a warning (mirror is forbidden)
  const doc = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'B1', '10', '0', '20', '0', '41', '-1', '42', '1',
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
  const { entities, warnings } = parseDxf(doc);
  check('mirrored insert skipped', entities.length === 0);
  check('mirrored insert warns', warnings.length === 1, warnings.join(';'));
}

// ---------------------------------------------------------------------------
// Bulge arcs
// ---------------------------------------------------------------------------

{
  // Quarter circle CCW: (0,0) -> (2,0), bulge tan(pi/8): center (1,1), r=sqrt2,
  // arc midpoint at (1, 1 - sqrt2).
  const b = Math.tan(Math.PI / 8);
  const pts = bulgeArcPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, b, 4);
  const mid = pts[Math.floor(pts.length / 2)];
  check('bulge arc endpoints', approx(pts[0][0], 0) && approx(pts[pts.length - 1][0], 2));
  check('bulge arc midpoint', approx(mid[0], 1, 0.01) && approx(mid[1], 1 - Math.SQRT2, 0.01),
    JSON.stringify(mid));
  // All points at distance sqrt2 from (1,1)
  let ok = true;
  for (const [x, y] of pts) if (!approx(Math.hypot(x - 1, y - 1), Math.SQRT2, 1e-9)) ok = false;
  check('bulge arc radius constant', ok);
}

{
  // Negative bulge: arc bulges the other way (midpoint above the chord)
  const b = -Math.tan(Math.PI / 8);
  const pts = bulgeArcPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, b, 4);
  const mid = pts[Math.floor(pts.length / 2)];
  check('negative bulge side', mid[1] > 0.3, JSON.stringify(mid));
}

{
  // Semicircle bulge=1: (0,0)->(2,0) center (1,0) r=1, top at (1,1)... CCW
  // from (0,0) means passing through (1,-1).
  const pts = bulgeArcPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, 1, 4);
  const mid = pts[Math.floor(pts.length / 2)];
  check('semicircle bulge', approx(mid[0], 1, 0.01) && approx(mid[1], -1, 0.01), JSON.stringify(mid));
}

{
  // Major arc (270 deg): bulge tan(3pi/8) - high quality => tight tolerance
  const b = Math.tan((3 * Math.PI) / 8);
  const pts = bulgeArcPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, b, 40);
  const bb = bboxOfPoints(pts);
  // Center (1,-1), r = sqrt2: bbox should span x in [1-s2, 1+s2]
  check('major arc bbox', approx(bb.minX, 1 - Math.SQRT2, 0.02) && approx(bb.maxX, 1 + Math.SQRT2, 0.02),
    JSON.stringify(bb));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

{
  const arc = { type: 'ARC', layer: '0', cx: 10, cy: 0, r: 5, a1: 0, a2: 90 };
  const rot = transformEntity(arc, { rotDeg: 90, dx: 0, dy: 0 });
  check('arc rotate center', approx(rot.cx, 0) && approx(rot.cy, 10));
  check('arc rotate angles', approx(rot.a1, 90) && approx(rot.a2, 180));

  // Sampled points of the rotated arc == rotated sampled points of the original
  const s1 = rotatePoints(sampleEntity(arc, 2)[0], 90);
  const s2 = sampleEntity(rot, 2)[0];
  let maxErr = 0;
  for (let i = 0; i < s1.length; i++) {
    maxErr = Math.max(maxErr, Math.hypot(s1[i][0] - s2[i][0], s1[i][1] - s2[i][1]));
  }
  check('arc rotation sampling consistent', maxErr < 1e-9, 'err=' + maxErr);
}

{
  // Mirror must be impossible
  let threw = false;
  try {
    transformEntity({ type: 'LINE', layer: '0', x1: 0, y1: 0, x2: 1, y2: 1 }, { scale: -1 });
  } catch { threw = true; }
  check('negative scale rejected (no mirror)', threw);
}

{
  // Polyline bulge invariant under rotation
  const p = { type: 'POLYLINE', layer: '0', closed: false, verts: [{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0, bulge: 0 }] };
  const r = transformEntity(p, { rotDeg: 45, dx: 3, dy: 4 });
  check('bulge preserved on rotate', r.verts[0].bulge === 0.5);
  const s1 = rotatePoints(sampleEntity(p, 2)[0], 45).map(([x, y]) => [x + 3, y + 4]);
  const s2 = sampleEntity(r, 2)[0];
  let maxErr = 0;
  for (let i = 0; i < s1.length; i++) {
    maxErr = Math.max(maxErr, Math.hypot(s1[i][0] - s2[i][0], s1[i][1] - s2[i][1]));
  }
  check('polyline rotation sampling consistent', maxErr < 1e-9, 'err=' + maxErr);
}

// ---------------------------------------------------------------------------
// Full-circle arcs and sweep preservation
// ---------------------------------------------------------------------------

{
  check('arcSweep basics', arcSweep(0, 90) === 90 && arcSweep(350, 20) === 30
    && arcSweep(0, 360) === 360 && arcSweep(30, 30) === 360 && arcSweep(90, 0) === 270);

  // Full-circle arc must survive placement transform + write as a CIRCLE.
  const full = { type: 'ARC', layer: '0', cx: 10, cy: 0, r: 5, a1: 0, a2: 360 };
  const moved = transformEntity(full, { rotDeg: 30, dx: 100, dy: 50 });
  check('full arc sweep preserved', approx(arcSweep(moved.a1, moved.a2), 360), JSON.stringify(moved));
  const { entities: back } = parseDxf(writeDxf([moved]));
  check('full arc written as circle', back.length === 1 && back[0].type === 'CIRCLE'
    && approx(back[0].r, 5, 1e-6), JSON.stringify(back));

  // Partial arc crossing zero keeps its sweep through transforms.
  const cross = { type: 'ARC', layer: '0', cx: 0, cy: 0, r: 10, a1: 350, a2: 20 };
  const c2 = transformEntity(transformEntity(cross, { rotDeg: 90 }), { rotDeg: 45 });
  check('crossing arc sweep preserved', approx(arcSweep(c2.a1, c2.a2), 30, 1e-9),
    JSON.stringify(c2));
  const { entities: backC } = parseDxf(writeDxf([c2]));
  check('crossing arc stays arc', backC.length === 1 && backC[0].type === 'ARC');
  const bbOrig = bboxOfPoints(rotatePoints(sampleEntity(cross, 4)[0], 135));
  const bbBack = bboxOfPoints(sampleEntity(backC[0], 4)[0]);
  check('crossing arc geometry preserved',
    approx(bbOrig.w, bbBack.w, 0.01) && approx(bbOrig.h, bbBack.h, 0.01),
    JSON.stringify([bbOrig, bbBack]));
}

// ---------------------------------------------------------------------------
// OCS / extrusion (mirror via 230 = -1)
// ---------------------------------------------------------------------------

{
  // Asymmetric LWPOLYLINE with extrusion -Z: WCS geometry is the X-mirror.
  const doc = dxfDoc([
    '0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '1',
    '10', '0', '20', '0', '42', '0.5',
    '10', '40', '20', '0',
    '10', '40', '20', '10',
    '210', '0', '220', '0', '230', '-1',
  ]);
  const { entities, warnings } = parseDxf(doc);
  check('ocs polyline parsed', entities.length === 1, JSON.stringify(warnings));
  const v = entities[0].verts;
  check('ocs polyline x negated', approx(v[0].x, 0) && approx(v[1].x, -40) && approx(v[2].x, -40),
    JSON.stringify(v));
  check('ocs polyline bulge negated', approx(v[0].bulge, -0.5), JSON.stringify(v[0]));
}

{
  // ARC with extrusion -Z: sampled WCS points must equal the X-mirrored
  // samples of the same arc without extrusion.
  const plain = dxfDoc(['0', 'ARC', '8', '0', '10', '50', '20', '0', '40', '10', '50', '0', '51', '90']);
  const flipped = dxfDoc(['0', 'ARC', '8', '0', '10', '50', '20', '0', '40', '10', '50', '0', '51', '90', '230', '-1']);
  const a = parseDxf(plain).entities[0];
  const b = parseDxf(flipped).entities[0];
  check('ocs arc center', approx(b.cx, -50) && approx(b.cy, 0), JSON.stringify(b));
  check('ocs arc angles', approx(b.a1, 90) && approx(b.a2, 180), JSON.stringify(b));
  const mirrored = sampleEntity(a, 2)[0].map(([x, y]) => [-x, y]);
  const sampled = sampleEntity(b, 2)[0];
  const setHas = (pt) => sampled.some(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) < 1e-6);
  check('ocs arc points match mirror', setHas(mirrored[0]) && setHas(mirrored[mirrored.length - 1]),
    JSON.stringify([mirrored[0], mirrored[mirrored.length - 1], sampled[0], sampled[sampled.length - 1]]));
}

{
  // Circle with extrusion -Z, tilted extrusion rejected, INSERT -Z rejected
  const doc = dxfDoc(['0', 'CIRCLE', '8', '0', '10', '30', '20', '5', '40', '2', '230', '-1']);
  const c = parseDxf(doc).entities[0];
  check('ocs circle x negated', approx(c.cx, -30) && approx(c.cy, 5));

  const tilted = dxfDoc(['0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '2',
    '210', '0.5', '220', '0', '230', '0.866']);
  const rt = parseDxf(tilted);
  check('tilted extrusion skipped', rt.entities.length === 0 && rt.warnings.length === 1,
    JSON.stringify(rt.warnings));

  const insDoc = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'B1', '10', '0', '20', '0', '230', '-1',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const ri = parseDxf(insDoc);
  check('mirrored-extrusion insert skipped', ri.entities.length === 0 && ri.warnings.length === 1,
    JSON.stringify(ri.warnings));
}

{
  // INSERT with sx=sy=-1 is a pure 180-degree rotation - must expand and
  // match the same block inserted with rot+180.
  const mk = (insertLines) => [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '1', '20', '2', '11', '10', '21', '3',
    '0', 'ARC', '8', '0', '10', '5', '20', '0', '40', '2', '50', '10', '51', '80',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...insertLines,
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const neg = parseDxf(mk(['0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '50',
    '41', '-1', '42', '-1', '50', '30']));
  const rot = parseDxf(mk(['0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '50',
    '50', '210']));
  check('neg-uniform insert expands', neg.entities.length === 2 && neg.warnings.length === 0,
    JSON.stringify(neg.warnings));
  const pn = sampleEntities(neg.entities, 2).flat();
  const pr = sampleEntities(rot.entities, 2).flat();
  let maxErr = 0;
  for (let i = 0; i < Math.min(pn.length, pr.length); i++) {
    maxErr = Math.max(maxErr, Math.hypot(pn[i][0] - pr[i][0], pn[i][1] - pr[i][1]));
  }
  check('neg-uniform insert equals rot+180', pn.length === pr.length && maxErr < 1e-6,
    'err=' + maxErr + ' n=' + pn.length + '/' + pr.length);
}

// ---------------------------------------------------------------------------
// Import robustness: units, blocks-only files, stray points, fit splines
// ---------------------------------------------------------------------------

{
  // $INSUNITS = 1 (inches) -> converted to mm
  const doc = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '0',
    '0', 'CIRCLE', '8', '0', '10', '2', '20', '0', '40', '0.5',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const { entities, warnings } = parseDxf(doc);
  check('inches: line converted', approx(entities[0].x2, 25.4), JSON.stringify(entities[0]));
  check('inches: circle converted', approx(entities[1].cx, 50.8) && approx(entities[1].r, 12.7));
  check('inches: warns', warnings.some((w) => w.indexOf('milimetre') !== -1), warnings.join(';'));
}

{
  // Geometry only inside blocks (empty ENTITIES) still imports
  const doc = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'PART', '10', '5', '20', '5',
    '0', 'CIRCLE', '8', '0', '10', '10', '20', '10', '40', '3',
    '0', 'ENDBLK',
    '0', 'BLOCK', '2', '*Paper_Space', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '500', '21', '0',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const { entities, warnings } = parseDxf(doc);
  check('blocks fallback: imported', entities.length === 1 && entities[0].type === 'CIRCLE',
    JSON.stringify(entities.map((e) => e.type)));
  check('blocks fallback: base point', approx(entities[0].cx, 5) && approx(entities[0].cy, 5));
  check('blocks fallback: warns', warnings.some((w) => w.indexOf('blokova') !== -1), warnings.join(';'));
}

{
  // Stray POINT entities are dropped (they would inflate the bounding box)
  const doc = dxfDoc([
    '0', 'POINT', '8', '0', '10', '1000', '20', '1000',
    '0', 'POINT', '8', '0', '10', '-500', '20', '0',
    '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '5',
  ]);
  const { entities, warnings } = parseDxf(doc);
  check('points dropped', entities.length === 1 && entities[0].type === 'CIRCLE');
  check('points warn', warnings.some((w) => w.indexOf('POINT') !== -1), warnings.join(';'));
  const info = analyzePart(doc);
  // Sampled bbox may sit up to the chord tolerance (0.05mm) inside the true
  // circle - the nesting gap absorbs this by design.
  check('points do not inflate bbox', approx(info.w, 10, 0.11) && approx(info.h, 10, 0.11),
    JSON.stringify([info.w, info.h]));
}

{
  // SPLINE with only fit points: smooth curve through the points
  const spl = {
    type: 'SPLINE', layer: '0', degree: 3, closed: false,
    knots: [], weights: [], ctrl: [],
    fit: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }],
  };
  const pts = sampleEntity(spl, 2)[0];
  check('fit spline endpoints', approx(pts[0][0], 0) && approx(pts[pts.length - 1][0], 20));
  check('fit spline through fit point', pts.some(([x, y]) => Math.hypot(x - 10, y - 10) < 0.01));
  check('fit spline is smooth', pts.length > 10, 'pts=' + pts.length);
}

// ---------------------------------------------------------------------------
// Splines and ellipses
// ---------------------------------------------------------------------------

{
  // Cubic Bezier as clamped B-spline
  const spline = {
    type: 'SPLINE', layer: '0', degree: 3, closed: false,
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    weights: [],
    ctrl: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }],
    fit: [],
  };
  const pts = sampleEntity(spline, 2)[0];
  check('spline start', approx(pts[0][0], 0) && approx(pts[0][1], 0));
  check('spline end', approx(pts[pts.length - 1][0], 10) && approx(pts[pts.length - 1][1], 0, 1e-6));
  // Bezier midpoint t=0.5: (5, 7.5)
  const mid = pts[Math.floor(pts.length / 2)];
  check('spline midpoint', approx(mid[0], 5, 0.05) && approx(mid[1], 7.5, 0.05), JSON.stringify(mid));
}

{
  const ell = { type: 'ELLIPSE', layer: '0', cx: 0, cy: 0, mx: 50, my: 0, ratio: 0.5, t1: 0, t2: Math.PI * 2 };
  const bb = bboxOfPoints(sampleEntity(ell, 4)[0]);
  check('ellipse bbox', approx(bb.w, 100, 0.1) && approx(bb.h, 50, 0.1), JSON.stringify(bb));
  const rot = transformEntity(ell, { rotDeg: 90, dx: 0, dy: 0 });
  const bb2 = bboxOfPoints(sampleEntity(rot, 4)[0]);
  check('rotated ellipse bbox', approx(bb2.w, 50, 0.1) && approx(bb2.h, 100, 0.1), JSON.stringify(bb2));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

{
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 3]]);
  check('hull size', hull.length === 4, 'got ' + hull.length);
  check('hull area', approx(Math.abs(polygonArea(hull)), 100));
}

{
  // 100 x 50 rectangle rotated by 30 deg: minAreaRect should recover it
  const rect = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const rotated = rotatePoints(rect, 30);
  const mar = minAreaRect(rotated);
  const area = mar.w * mar.h;
  check('minAreaRect area', approx(area, 5000, 0.5), 'area=' + area);
  const dims = [mar.w, mar.h].sort((a, b) => a - b);
  check('minAreaRect dims', approx(dims[0], 50, 0.01) && approx(dims[1], 100, 0.01), JSON.stringify(dims));
}

// ---------------------------------------------------------------------------
// MaxRects packing
// ---------------------------------------------------------------------------

function rectsOverlap(a, b) {
  return a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
}

{
  const bin = new MaxRectsBin(100, 100);
  const placed = [];
  for (let i = 0; i < 8; i++) {
    const n = bin.insert(30, 20, true);
    if (n) placed.push(n);
  }
  check('maxrects places several', placed.length >= 8, 'placed ' + placed.length);
  let overlaps = false;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (rectsOverlap(placed[i], placed[j])) overlaps = true;
    }
  }
  check('maxrects no overlap', !overlaps);
  let inBounds = true;
  for (const p of placed) {
    if (p.x < -1e-6 || p.y < -1e-6 || p.x + p.w > 100 + 1e-6 || p.y + p.h > 100 + 1e-6) inBounds = false;
  }
  check('maxrects in bounds', inBounds);
}

{
  // Rotation used when needed
  const bin = new MaxRectsBin(50, 200);
  const n = bin.insert(120, 40, true);
  check('maxrects rotates to fit', n !== null && n.rotated === true && n.w === 40 && n.h === 120);
  const bin2 = new MaxRectsBin(50, 200);
  check('maxrects no-rotate fails', bin2.insert(120, 40, false) === null);
}

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

{
  const res = nestParts({
    sheetW: 1000, sheetH: 500, margin: 10, gap: 5,
    parts: [
      { id: 'A', w: 300, h: 200, area: 60000, priority: 1, mode: 'fixed', count: 2 },
      { id: 'B', w: 400, h: 150, area: 60000, priority: 2, mode: 'fixed', count: 1 },
      { id: 'C', w: 90, h: 60, area: 5400, priority: 3, mode: 'filler', maxCount: 0 },
    ],
  });
  check('nest fixed all placed', res.unplaced.length === 0, JSON.stringify(res.unplaced));
  check('nest counts', res.placedCounts.A === 2 && res.placedCounts.B === 1);
  check('nest filler used', (res.placedCounts.C || 0) > 3, 'C=' + res.placedCounts.C);

  // Verify margins and pairwise gap on the placements
  let ok = true;
  for (const p of res.placements) {
    if (p.x < 10 - 1e-6 || p.y < 10 - 1e-6
      || p.x + p.w > 1000 - 10 + 1e-6 || p.y + p.h > 500 - 10 + 1e-6) ok = false;
  }
  check('nest margins respected', ok);

  let gapOk = true;
  for (let i = 0; i < res.placements.length; i++) {
    for (let j = i + 1; j < res.placements.length; j++) {
      const a = res.placements[i];
      const b = res.placements[j];
      const sepX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const sepY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      if (Math.max(sepX, sepY) < 5 - 1e-6) gapOk = false;
    }
  }
  check('nest gap respected', gapOk);
  check('nest utilization sane', res.utilization > 0 && res.utilization <= 1, res.utilization);
}

{
  // Priority wins when only one fits
  const res = nestParts({
    sheetW: 320, sheetH: 220, margin: 10, gap: 5,
    parts: [
      { id: 'LOW', w: 300, h: 200, priority: 9, mode: 'fixed', count: 1 },
      { id: 'HIGH', w: 300, h: 200, priority: 1, mode: 'fixed', count: 1 },
    ],
  });
  check('priority part placed', res.placedCounts.HIGH === 1, JSON.stringify(res.placedCounts));
  check('low priority unplaced', res.unplaced.length === 1 && res.unplaced[0].id === 'LOW',
    JSON.stringify(res.unplaced));
}

{
  // Too-big part reported unplaced, smaller ones still go on
  const res = nestParts({
    sheetW: 500, sheetH: 500, margin: 10, gap: 5,
    parts: [
      { id: 'BIG', w: 2000, h: 2000, priority: 1, mode: 'fixed', count: 1 },
      { id: 'S', w: 100, h: 100, priority: 2, mode: 'fixed', count: 4 },
    ],
  });
  check('too big unplaced', res.unplaced.some((u) => u.id === 'BIG' && u.count === 1));
  check('small still placed', res.placedCounts.S === 4);
}

{
  // Filler cap respected
  const res = nestParts({
    sheetW: 1000, sheetH: 1000, margin: 0, gap: 0,
    parts: [{ id: 'F', w: 50, h: 50, priority: 1, mode: 'filler', maxCount: 3 }],
  });
  check('filler cap', res.placedCounts.F === 3, 'F=' + res.placedCounts.F);
  check('filler cap not flagged as capped', res.capped === false);
}

{
  // Safety cap is reported via the capped flag
  const res = nestParts({
    sheetW: 1000, sheetH: 1000, margin: 0, gap: 0, maxTotal: 50,
    parts: [{ id: 'F', w: 50, h: 50, priority: 1, mode: 'filler', maxCount: 0 }],
  });
  check('maxTotal capped count', res.placedCounts.F === 50, 'F=' + res.placedCounts.F);
  check('maxTotal capped flag', res.capped === true && res.maxTotal === 50);

  const free = nestParts({
    sheetW: 1000, sheetH: 1000, margin: 0, gap: 0,
    parts: [{ id: 'F', w: 50, h: 50, priority: 1, mode: 'filler', maxCount: 0 }],
  });
  check('bin-full not capped', free.capped === false && free.placedCounts.F === 400,
    JSON.stringify({ capped: free.capped, F: free.placedCounts.F }));
}

{
  // Rotation-only fit
  const res = nestParts({
    sheetW: 200, sheetH: 900, margin: 10, gap: 5,
    parts: [{ id: 'R', w: 800, h: 100, priority: 1, mode: 'fixed', count: 1 }],
  });
  check('nest rotates to fit', res.placedCounts.R === 1 && res.placements[0].rotated === true,
    JSON.stringify(res.placements));
  const res2 = nestParts({
    sheetW: 200, sheetH: 900, margin: 10, gap: 5, allowRotate: false,
    parts: [{ id: 'R', w: 800, h: 100, priority: 1, mode: 'fixed', count: 1 }],
  });
  check('no-rotate reported unplaced', res2.unplaced.length === 1);
}

// ---------------------------------------------------------------------------
// Round trip: writeDxf -> parseDxf
// ---------------------------------------------------------------------------

{
  const entities = [
    { type: 'LINE', layer: 'CUT', x1: 0, y1: 0, x2: 100, y2: 50 },
    { type: 'CIRCLE', layer: 'CUT', cx: 20, cy: 20, r: 8 },
    { type: 'ARC', layer: 'CUT', cx: 50, cy: 50, r: 10, a1: 30, a2: 200 },
    {
      type: 'POLYLINE', layer: 'CUT', closed: true,
      verts: [{ x: 0, y: 0, bulge: 0 }, { x: 60, y: 0, bulge: 0.4 }, { x: 60, y: 40, bulge: 0 }, { x: 0, y: 40, bulge: 0 }],
    },
    {
      type: 'SPLINE', layer: 'CUT', degree: 3, closed: false,
      knots: [0, 0, 0, 0, 1, 1, 1, 1], weights: [],
      ctrl: [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 30, y: 30 }, { x: 40, y: 0 }], fit: [],
    },
    { type: 'ELLIPSE', layer: 'CUT', cx: 0, cy: 0, mx: 30, my: 0, ratio: 0.6, t1: 0, t2: Math.PI * 2 },
  ];
  const text = writeDxf(entities);
  check('writer no scientific notation', !/[0-9]e[+-]/i.test(text));
  const { entities: back, warnings } = parseDxf(text);
  check('roundtrip no warnings', warnings.length === 0, warnings.join(';'));
  // spline + ellipse flattened to polylines => same count
  check('roundtrip count', back.length === entities.length, 'got ' + back.length);
  const bbA = bboxOfPoints(sampleEntities(entities, 4).flat());
  const bbB = bboxOfPoints(sampleEntities(back, 4).flat());
  check('roundtrip bbox', approx(bbA.w, bbB.w, 0.05) && approx(bbA.h, bbB.h, 0.05),
    JSON.stringify([bbA, bbB]));
  const types = back.map((e) => e.type).sort().join(',');
  check('roundtrip types', types === 'ARC,CIRCLE,LINE,POLYLINE,POLYLINE,POLYLINE', types);
  check('roundtrip layer kept', back.every((e) => e.layer === 'CUT'));
  check('roundtrip bulge kept', back.some((e) => e.type === 'POLYLINE' && e.verts.some((v) => approx(v.bulge, 0.4, 1e-9))));
}

// ---------------------------------------------------------------------------
// analyzePart
// ---------------------------------------------------------------------------

{
  // A 120 x 80 plate rotated by 25 degrees in the file: analyzePart should
  // pre-rotate it back to ~120 x 80.
  const rect = [[0, 0], [120, 0], [120, 80], [0, 80]];
  const rotated = rotatePoints(rect, 25);
  const doc = dxfDoc([
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    ...rotated.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
  ]);
  const info = analyzePart(doc);
  const dims = [info.w, info.h].sort((a, b) => a - b);
  check('analyzePart tight dims', approx(dims[0], 80, 0.01) && approx(dims[1], 120, 0.01),
    JSON.stringify(dims));
  check('analyzePart area', approx(info.area, 9600, 1), 'area=' + info.area);
  check('analyzePart outline at origin', (() => {
    const all = info.outline.flat();
    const bb = bboxOfPoints(all);
    return approx(bb.minX, 0, 0.01) && approx(bb.minY, 0, 0.01);
  })());
}

{
  let threw = false;
  try { analyzePart(dxfDoc([])); } catch { threw = true; }
  check('analyzePart empty rejects', threw);
}

// ---------------------------------------------------------------------------
// generateSheet end-to-end
// ---------------------------------------------------------------------------

{
  // Build two parts via the writer, analyze them, nest them, and verify the
  // produced DXF geometry stays inside the sheet with margins respected.
  const partA = writeDxf([
    { type: 'POLYLINE', layer: '0', closed: true, verts: [{ x: 0, y: 0, bulge: 0 }, { x: 200, y: 0, bulge: 0 }, { x: 200, y: 60, bulge: 0 }, { x: 60, y: 60, bulge: 0 }, { x: 60, y: 150, bulge: 0 }, { x: 0, y: 150, bulge: 0 }] },
    { type: 'CIRCLE', layer: '0', cx: 30, cy: 30, r: 6 },
  ]);
  const partB = writeDxf([
    { type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 40 },
    { type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 15 },
  ]);

  const infoA = analyzePart(partA);
  const infoB = analyzePart(partB);
  const parts = [
    { id: 'A', name: 'nosac', content: partA, preRotDeg: infoA.preRotDeg, w: infoA.w, h: infoA.h, area: infoA.area, priority: 1, mode: 'fixed', count: 3 },
    { id: 'B', name: 'prsten', content: partB, preRotDeg: infoB.preRotDeg, w: infoB.w, h: infoB.h, area: infoB.area, priority: 5, mode: 'filler', maxCount: 0 },
  ];

  const sheetW = 600;
  const sheetH = 400;
  const margin = 10;
  const res = generateSheet({ sheetW, sheetH, margin, gap: 6, parts });

  check('e2e fixed placed', res.placedCounts.A === 3, JSON.stringify(res.placedCounts));
  check('e2e filler placed', (res.placedCounts.B || 0) > 0);
  check('e2e dxf produced', typeof res.dxf === 'string' && res.dxf.length > 100);
  check('e2e summary', res.summary.length === 2);

  const { entities, warnings } = parseDxf(res.dxf);
  check('e2e output parses clean', warnings.length === 0, warnings.join(';'));
  const allPts = sampleEntities(entities, 4).flat();
  const bb = bboxOfPoints(allPts);
  const tol = 0.05;
  check('e2e geometry within margins',
    bb.minX >= margin - tol && bb.minY >= margin - tol
    && bb.maxX <= sheetW - margin + tol && bb.maxY <= sheetH - margin + tol,
    JSON.stringify(bb));

  // Preview outlines also inside the sheet
  let outlineOk = true;
  for (const pl of res.placements) {
    for (const poly of pl.outline) {
      for (const [x, y] of poly) {
        if (x < margin - 0.1 || y < margin - 0.1 || x > sheetW - margin + 0.1 || y > sheetH - margin + 0.1) outlineOk = false;
      }
    }
  }
  check('e2e outlines within sheet', outlineOk);

  // The circle count in the output must match: A has 1 circle x3 = 3 circles,
  // B has 2 circles x count. Mirroring or entity loss would break this.
  const circles = entities.filter((e) => e.type === 'CIRCLE').length;
  check('e2e circle count', circles === 3 + 2 * res.placedCounts.B,
    'circles=' + circles + ' B=' + res.placedCounts.B);
}

{
  // buildSheetDxf re-creates the exact same DXF from stored placements
  const partA = writeDxf([
    { type: 'POLYLINE', layer: '0', closed: true, verts: [{ x: 0, y: 0, bulge: 0 }, { x: 120, y: 0, bulge: 0.3 }, { x: 120, y: 70, bulge: 0 }, { x: 0, y: 70, bulge: 0 }] },
    { type: 'CIRCLE', layer: '0', cx: 30, cy: 30, r: 8 },
  ]);
  const infoA = analyzePart(partA);
  const parts = [{
    id: 'A', name: 'test', content: partA, preRotDeg: infoA.preRotDeg,
    w: infoA.w, h: infoA.h, area: infoA.area, priority: 1, mode: 'fixed', count: 4,
  }];
  const res = generateSheet({ sheetW: 500, sheetH: 400, margin: 10, gap: 6, parts });
  check('rebuild: placements carry transform',
    res.placements.every((pl) => Number.isFinite(pl.rotDeg) && Number.isFinite(pl.dx) && Number.isFinite(pl.dy)));
  const rebuilt = buildSheetDxf({
    parts, placements: res.placements, sheetW: 500, sheetH: 400,
  });
  check('rebuild: identical dxf', rebuilt === res.dxf,
    'len ' + rebuilt.length + ' vs ' + res.dxf.length);

  let threw = false;
  try {
    buildSheetDxf({ parts: [], placements: res.placements, sheetW: 500, sheetH: 400 });
  } catch { threw = true; }
  check('rebuild: missing part rejects', threw);
}

{
  // Frame layer option
  const part = writeDxf([{ type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 20 }]);
  const info = analyzePart(part);
  const res = generateSheet({
    sheetW: 300, sheetH: 300, margin: 10, gap: 5, addFrame: true,
    parts: [{ id: 'X', name: 'x', content: part, preRotDeg: info.preRotDeg, w: info.w, h: info.h, area: info.area, priority: 1, mode: 'fixed', count: 1 }],
  });
  const { entities } = parseDxf(res.dxf);
  check('frame present', entities.some((e) => e.layer === 'PLOCA'));
}

{
  // Nothing fits: empty result, no dxf
  const part = writeDxf([{ type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 500 }]);
  const info = analyzePart(part);
  const res = generateSheet({
    sheetW: 300, sheetH: 300, margin: 10, gap: 5,
    parts: [{ id: 'X', name: 'x', content: part, preRotDeg: info.preRotDeg, w: info.w, h: info.h, area: info.area, priority: 1, mode: 'fixed', count: 1 }],
  });
  check('nothing fits: zero placed', res.totalPlaced === 0);
  check('nothing fits: unplaced reported', res.unplaced.length === 1);
  check('nothing fits: no dxf', res.dxf === null);
}

// ---------------------------------------------------------------------------
// Fidelity: engraving text, layer/entity colors, curve accuracy
// ---------------------------------------------------------------------------

{
  // TEXT on the part is kept (engraving); text far outside is annotation.
  const doc = dxfDoc([
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50',
    '0', 'TEXT', '8', '0', '10', '30', '20', '20', '40', '8', '50', '15', '1', 'BR-42',
    '0', 'TEXT', '8', 'KOTE', '10', '500', '20', '500', '40', '10', '1', 'NACRT',
  ]);
  const { entities, warnings } = parseDxf(doc);
  const texts = entities.filter((e) => e.type === 'TEXT');
  check('text on part kept', texts.length === 1 && texts[0].text === 'BR-42', JSON.stringify(texts));
  check('text outside dropped+warn', warnings.some((w) => w.indexOf('izvan konture') !== -1),
    warnings.join(';'));

  const info = analyzePart(doc);
  check('text does not affect dims', approx(info.w, 100, 0.01) && approx(info.h, 50, 0.01),
    JSON.stringify([info.w, info.h]));
  check('analyzePart exposes texts', info.texts.length === 1 && info.texts[0].s === 'BR-42',
    JSON.stringify(info.texts));

  // Round trip: text survives write + transform (rotation updates its angle)
  const rot = entities.map((e) => transformEntity(e, { rotDeg: 90, dx: 10, dy: 0 }));
  const back = parseDxf(writeDxf(rot));
  const t2 = back.entities.find((e) => e.type === 'TEXT');
  check('text roundtrip', !!t2 && t2.text === 'BR-42' && approx(t2.h, 8) && approx(t2.rot, 105),
    JSON.stringify(t2));
}

{
  // MTEXT reduced to plain text
  const doc = dxfDoc([
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '60', '20', '0', '10', '60', '20', '40', '10', '0', '20', '40',
    '0', 'MTEXT', '8', '0', '10', '20', '20', '20', '40', '6', '1', '{\\fArial|b0;POZ \\P 7}',
  ]);
  const { entities, warnings } = parseDxf(doc);
  const t = entities.find((e) => e.type === 'TEXT');
  check('mtext converted', !!t && t.text.indexOf('POZ') !== -1 && t.text.indexOf('\\f') === -1,
    JSON.stringify(t));
  check('mtext warns', warnings.some((w) => w.indexOf('MTEXT') !== -1));
}

{
  // Layer colors + entity colors survive the round trip
  const doc = [
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'REZ', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'GRAVURA', '70', '0', '62', '5', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'CIRCLE', '8', 'REZ', '10', '0', '20', '0', '40', '20',
    '0', 'LINE', '8', 'GRAVURA', '62', '3', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const parsed = parseDxf(doc);
  check('layer colors parsed', parsed.layers.REZ === 1 && parsed.layers.GRAVURA === 5,
    JSON.stringify(parsed.layers));
  check('entity color parsed', parsed.entities.find((e) => e.type === 'LINE').color === 3);

  const out = writeDxf(parsed.entities, { layerColors: parsed.layers });
  const back = parseDxf(out);
  check('layer colors roundtrip', back.layers.REZ === 1 && back.layers.GRAVURA === 5,
    JSON.stringify(back.layers));
  check('entity color roundtrip', back.entities.find((e) => e.type === 'LINE').color === 3);

  // ...and through the full generateSheet pipeline
  const info = analyzePart(doc);
  const res = generateSheet({
    sheetW: 200, sheetH: 200, margin: 5, gap: 5,
    parts: [{ id: 'C', name: 'c', content: doc, preRotDeg: info.preRotDeg, w: info.w, h: info.h, area: info.area, priority: 1, mode: 'fixed', count: 1 }],
  });
  const sheet = parseDxf(res.dxf);
  check('sheet keeps layer colors', sheet.layers.REZ === 1 && sheet.layers.GRAVURA === 5,
    JSON.stringify(sheet.layers));
}

{
  // A big circle keeps its size within the write tolerance (~0.025mm)
  const big = { type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 500 };
  const bb = bboxOfPoints(sampleEntity(big, 8)[0]);
  check('big circle accurate', approx(bb.w, 1000, 0.06) && approx(bb.h, 1000, 0.06),
    JSON.stringify([bb.w, bb.h]));
}

// ---------------------------------------------------------------------------
// Wild real-world DXF dialects (test/wild-fixtures.js)
// ---------------------------------------------------------------------------

{
  const { fixtures } = require('./wild-fixtures');
  for (const fx of fixtures) {
    try {
      const info = analyzePart(fx.content);
      const dims = [info.w, info.h].sort((a, b) => a - b);
      const want = [fx.expect.w, fx.expect.h].sort((a, b) => a - b);
      check('wild ' + fx.name + ': dims',
        approx(dims[0], want[0], fx.expect.tol) && approx(dims[1], want[1], fx.expect.tol),
        'got ' + dims.map((d) => d.toFixed(2)).join('x') + ' want ' + want.join('x'));
      check('wild ' + fx.name + ': outline present', info.outline.length > 0);
    } catch (e) {
      check('wild ' + fx.name + ': imports', false, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Adversarial fuzz regression fixtures (test/fuzz/*.dxf) - each of these
// once broke the importer; expectations were derived from the DXF spec.
// ---------------------------------------------------------------------------

{
  const fs = require('fs');
  const path = require('path');
  const FUZZ = [
    // [file, w, h, tol, mustWarnSubstring|null]
    ['r12_pface_mesh.dxf', 80, 60, 0.2, '2D konturu'],           // polyface face records
    ['icad_blocks_dim.dxf', 100, 60, 0.2, 'blokova'],            // $PAPER_SPACE + *D blocks
    ['icad_blocks_dim_nops.dxf', 100, 60, 0.2, 'blokova'],
    ['r12_splineframe_only.dxf', 300, 50, 0.2, 'kontrolnim okvirom'],
    ['f3_periodic_spline.dxf', 83.33, 82.99, 0.5, null],         // periodic closed spline
    ['f6_ellipse_neg_extrusion.dxf', 30, 15, 0.1, null],         // -Z ellipse arc
    ['f3_pdf2cad_degenerate.dxf', 100, 50, 0.2, 'degeneriranih'],
    ['f6_two_entities_sections.dxf', 100, 50, 0.2, null],
    ['ms_insert.dxf', 100, 60, 0.2, 'blokova'],                  // no phantom block copy
    ['minsert_as_insert.dxf', 70, 35, 0.1, null],                // 3x2 insert array
    ['minsert_true.dxf', 70, 35, 0.1, null],                     // MINSERT entity
    ['f8_spline_offbyone_knots.dxf', 100, 50, 0.2, 'knot'],
    ['f6_hatch_plus_point.dxf', 80, 60, 0.2, 'HATCH'],           // point must not block hatch
  ];
  for (const [file, ew, eh, tol, warnSub] of FUZZ) {
    try {
      const info = analyzePart(fs.readFileSync(path.join(__dirname, 'fuzz', file), 'utf8'));
      const dims = [info.w, info.h].sort((a, b) => a - b);
      const want = [ew, eh].sort((a, b) => a - b);
      check('fuzz ' + file + ': dims',
        approx(dims[0], want[0], tol) && approx(dims[1], want[1], tol),
        'got ' + dims.map((d) => d.toFixed(2)).join('x') + ' want ' + want.join('x'));
      if (warnSub) {
        check('fuzz ' + file + ': warns',
          info.warnings.some((w) => w.indexOf(warnSub) !== -1), info.warnings.join(';'));
      }
    } catch (e) {
      check('fuzz ' + file + ': imports', false, e.message);
    }
  }

  // The periodic spline must actually be closed and smooth, not a polygon.
  const per = parseDxf(fs.readFileSync(path.join(__dirname, 'fuzz', 'f3_periodic_spline.dxf'), 'utf8'));
  const pts = sampleEntities(per.entities, 2)[0];
  const first = pts[0];
  const last = pts[pts.length - 1];
  check('periodic spline closes', Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.1,
    JSON.stringify([first, last]));
  check('periodic spline is smooth', pts.length > 30, 'pts=' + pts.length);

  // The -Z ellipse arc must land BELOW the major axis (y in [-15, 0]).
  const ell = parseDxf(fs.readFileSync(path.join(__dirname, 'fuzz', 'f6_ellipse_neg_extrusion.dxf'), 'utf8'));
  const epts = sampleEntities(ell.entities.filter((e) => e.type === 'ELLIPSE'), 2)[0];
  const eb = bboxOfPoints(epts);
  check('-Z ellipse arc de-mirrored', eb.minY < -14.9 && eb.maxY < 0.01, JSON.stringify(eb));

  // MINSERT array: exactly 6 circle copies
  const mi = parseDxf(fs.readFileSync(path.join(__dirname, 'fuzz', 'minsert_true.dxf'), 'utf8'));
  check('minsert copies', mi.entities.filter((e) => e.type === 'CIRCLE').length === 6,
    'got ' + mi.entities.length);
}

// ---------------------------------------------------------------------------
// Performance smoke test - "instant" requirement
// ---------------------------------------------------------------------------

{
  const part = writeDxf([
    { type: 'POLYLINE', layer: '0', closed: true, verts: [{ x: 0, y: 0, bulge: 0 }, { x: 80, y: 0, bulge: 0.3 }, { x: 80, y: 50, bulge: 0 }, { x: 0, y: 50, bulge: 0 }] },
    { type: 'CIRCLE', layer: '0', cx: 40, cy: 25, r: 10 },
  ]);
  const info = analyzePart(part);
  const parts = [];
  for (let i = 0; i < 10; i++) {
    parts.push({
      id: 'p' + i, name: 'part' + i, content: part,
      preRotDeg: info.preRotDeg, w: info.w, h: info.h, area: info.area,
      priority: (i % 5) + 1, mode: i < 5 ? 'fixed' : 'filler',
      count: 10, maxCount: 0,
    });
  }
  const t0 = process.hrtime.bigint();
  const res = generateSheet({ sheetW: 3000, sheetH: 1500, margin: 10, gap: 5, parts });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('perf: hundreds of parts', res.totalPlaced > 300, 'placed ' + res.totalPlaced);
  check('perf: under 3s', ms < 3000, ms.toFixed(0) + ' ms');
  console.log('  perf: placed ' + res.totalPlaced + ' parts in ' + ms.toFixed(0) + ' ms, iskoristivost '
    + Math.round(res.utilization * 100) + '%');
}

// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.error('\nFailures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
