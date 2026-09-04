'use strict';

/*
 * Part analysis (on import) and sheet generation (on "GENERIRAJ").
 * Pure functions - no filesystem access - so they are testable in plain Node
 * and reusable in a browser build later.
 */

const { parseDxf, writeDxf, transformEntity, sampleEntities } = require('./dxf');
const {
  minAreaRect, bboxOfPoints, rotatePoint, rotatePoints, convexHull, polygonArea, simplifyPolyline,
} = require('./geometry');
const { nestParts } = require('./nest');
const { bestDuoLayout, separateArea } = require('./pair');

const SAMPLE_QUALITY = 4; // matches writeDxf flattening quality

/**
 * Analyze an imported DXF part.
 * @param {string} content ASCII DXF text
 * @returns {{preRotDeg:number, w:number, h:number, area:number,
 *            outline:Array<Array<[number,number]>>, warnings:string[],
 *            entityCount:number}}
 * `outline` is the part sampled at its pre-rotated orientation, translated so
 * the bounding box corner sits at (0,0) - ready for thumbnails.
 */
function analyzePart(content) {
  const { entities, warnings } = parseDxf(content);
  if (entities.length === 0) {
    throw new Error('U DXF datoteci nema podržane geometrije za rez.');
  }
  const polys = sampleEntities(entities, SAMPLE_QUALITY);
  const allPts = [];
  for (const poly of polys) for (const p of poly) allPts.push(p);
  if (allPts.length === 0) {
    throw new Error('U DXF datoteci nema geometrije za rez.');
  }

  const mar = minAreaRect(allPts);
  const preRotDeg = mar.angleDeg;

  const rotatedPolys = polys.map((poly) => rotatePoints(poly, preRotDeg));
  const rotatedAll = [];
  for (const poly of rotatedPolys) for (const p of poly) rotatedAll.push(p);
  const bb = bboxOfPoints(rotatedAll);

  if (!(bb.w > 1e-6) || !(bb.h > 1e-6)) {
    throw new Error('Part nema površinu (geometrija je točka ili linija duljine 0).');
  }

  // Shape-preserving simplification (Douglas-Peucker, 0.05mm): corners and
  // detail survive exactly; only redundant points on smooth runs are dropped.
  const outline = rotatedPolys.map((poly) => simplifyPolyline(
    poly.map(([x, y]) => [round3(x - bb.minX), round3(y - bb.minY)]),
    0.05,
  ));

  // Engraving text, normalized like the outline (for previews).
  const texts = entities
    .filter((e) => e.type === 'TEXT')
    .slice(0, 50)
    .map((t) => {
      const [tx, ty] = rotatePoint(t.x, t.y, preRotDeg);
      return {
        x: round3(tx - bb.minX),
        y: round3(ty - bb.minY),
        h: round3(t.h || 5),
        rot: round3(((t.rot || 0) + preRotDeg) % 360),
        s: String(t.text || '').slice(0, 60),
      };
    });

  // Real-ish area: largest closed sampled loop, else convex hull area.
  let area = 0;
  for (const poly of rotatedPolys) {
    if (poly.length >= 4) {
      const [fx, fy] = poly[0];
      const [lx, ly] = poly[poly.length - 1];
      if (Math.hypot(fx - lx, fy - ly) < 1e-6) {
        area = Math.max(area, Math.abs(polygonArea(poly.slice(0, -1))));
      }
    }
  }
  if (area === 0) {
    const hull = convexHull(rotatedAll);
    if (hull.length >= 3) area = Math.abs(polygonArea(hull));
  }
  if (area === 0) area = bb.w * bb.h;

  return {
    preRotDeg,
    w: bb.w,
    h: bb.h,
    area,
    outline,
    texts,
    warnings,
    entityCount: entities.length,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}


/**
 * Resolve the effective part list for nesting from the library and the
 * active set. A null set means "all enabled parts with their own settings";
 * a set contributes only its member parts, with the set's per-part settings.
 */
function applySet(parts, set) {
  if (!set) return parts.filter((p) => p.enabled);
  const items = (set && set.items) || {};
  const out = [];
  for (const p of parts) {
    const it = items[p.id];
    if (!it) continue;
    out.push({
      ...p,
      enabled: true,
      priority: Number.isFinite(it.priority) ? it.priority : p.priority,
      mode: it.mode === 'fixed' ? 'fixed' : 'filler',
      count: Number.isFinite(it.count) ? it.count : p.count,
      maxCount: Number.isFinite(it.maxCount) ? it.maxCount : p.maxCount,
    });
  }
  return out;
}

const prioOf = (p) => (Number.isFinite(p.priority) ? p.priority : 999);

/**
 * Build the rectangle "units" the packer works with:
 *  - paired parts (pairId) always form a duo block, so both land on the same
 *    sheet in equal counts, laid out via bestDuoLayout (second part may be
 *    turned 180 degrees - never mirrored);
 *  - a single part whose outline interlocks with itself (saving >= 8%) is
 *    packed two-at-a-time head-to-toe, with a single unit for the remainder.
 */
function buildUnits(parts, gap) {
  const notes = [];
  const units = [];
  const used = new Set();
  const partById = {};
  for (const p of parts) partById[p.id] = p;

  const duoCache = {};
  // Parts without a stored outline (or degenerate ones) profile as plain
  // rectangles - the duo then degenerates to a safe side-by-side layout.
  const shellOf = (p) => ({
    w: p.w,
    h: p.h,
    outline: (Array.isArray(p.outline) && p.outline.length > 0)
      ? p.outline
      : [[[0, 0], [p.w, 0], [p.w, p.h], [0, p.h], [0, 0]]],
  });
  const duoFor = (a, b) => {
    const key = a.id + '|' + b.id;
    if (!duoCache[key]) duoCache[key] = bestDuoLayout(shellOf(a), shellOf(b), gap);
    return duoCache[key];
  };
  const memberOf = (part, slot) => ({ part, rot180: !!slot.rot180, ox: slot.ox, oy: slot.oy });

  for (const p of parts) {
    if (used.has(p.id)) continue;
    const partner = p.pairId && p.pairId !== p.id ? partById[p.pairId] : null;
    if (p.pairId && p.pairId !== p.id && !partner) {
      notes.push('Par "' + p.name + '": partner nije u aktivnom setu - slaže se pojedinačno.');
    }

    if (partner && !used.has(partner.id)) {
      used.add(p.id);
      used.add(partner.id);
      const lay = duoFor(p, partner);
      const isFiller = p.mode === 'filler' && partner.mode === 'filler';
      const maxA = p.maxCount || 0;
      const maxB = partner.maxCount || 0;
      let maxCount = 0;
      if (maxA > 0 && maxB > 0) maxCount = Math.min(maxA, maxB);
      else maxCount = Math.max(maxA, maxB);
      units.push({
        uid: 'd:' + p.id + ':' + partner.id,
        w: lay.w,
        h: lay.h,
        area: p.area + partner.area,
        priority: Math.min(prioOf(p), prioOf(partner)),
        mode: isFiller ? 'filler' : 'fixed',
        count: Math.min(Math.max(0, Math.floor(p.count || 0)), Math.max(0, Math.floor(partner.count || 0))),
        maxCount,
        members: [memberOf(p, lay.a), memberOf(partner, lay.b)],
      });
      continue;
    }

    used.add(p.id);
    const singleUnit = {
      uid: 's:' + p.id,
      w: p.w,
      h: p.h,
      area: p.area,
      priority: prioOf(p),
      mode: p.mode,
      count: p.count,
      maxCount: p.maxCount,
      members: [{ part: p, rot180: false, ox: 0, oy: 0 }],
    };

    const lay = duoFor(p, p);
    const selfDuoGood = lay
      && (lay.w + gap) * (lay.h + gap) <= 0.92 * separateArea(p, p, gap);
    if (!selfDuoGood) {
      units.push(singleUnit);
      continue;
    }

    const duoUnit = {
      uid: 'd:' + p.id + ':' + p.id,
      w: lay.w,
      h: lay.h,
      area: 2 * p.area,
      priority: prioOf(p),
      mode: p.mode,
      count: 0,
      maxCount: 0,
      members: [memberOf(p, lay.a), memberOf(p, lay.b)],
    };
    if (p.mode !== 'filler') {
      const want = Math.max(0, Math.floor(p.count || 0));
      duoUnit.count = Math.floor(want / 2);
      singleUnit.count = want % 2;
      if (duoUnit.count > 0) units.push(duoUnit);
      if (singleUnit.count > 0) units.push(singleUnit);
    } else if (p.maxCount && p.maxCount > 0) {
      // An exact cap across two unit types cannot be guaranteed - keep the
      // cap exact with singles only.
      units.push(singleUnit);
    } else {
      units.push(duoUnit);
      units.push(singleUnit);
    }
  }
  return { units, notes };
}

/**
 * Run the nesting and produce the sheet DXF plus preview data.
 *
 * @param {object} opts
 * @param {number} opts.sheetW, opts.sheetH  sheet size in mm
 * @param {number} opts.margin, opts.gap     clearances in mm
 * @param {boolean} [opts.allowRotate=true]
 * @param {boolean} [opts.addFrame=false]    add sheet outline on layer PLOCA
 * @param {Array} opts.parts library entries:
 *   [{id, name, content, preRotDeg, w, h, area, priority, mode, count, maxCount}]
 *
 * @returns {{dxf:string, placements:Array, unplaced:Array, placedCounts:Object,
 *            utilization:number, totalPlaced:number, summary:Array}}
 * placements carry preview outlines in sheet coordinates (Y up).
 */
function generateSheet(opts) {
  const {
    sheetW, sheetH, margin = 10, gap = 8,
    allowRotate = true, addFrame = false, parts = [], maxTotal,
    order = 'priority',
  } = opts;

  const { units, notes } = buildUnits(parts, gap);
  const unitsById = {};
  for (const u of units) unitsById[u.uid] = u;

  const nest = nestParts({
    sheetW,
    sheetH,
    margin,
    gap,
    allowRotate,
    maxTotal,
    order,
    parts: units.map((u) => ({
      id: u.uid,
      w: u.w,
      h: u.h,
      area: u.area,
      priority: u.priority,
      mode: u.mode,
      count: u.count,
      maxCount: u.maxCount,
    })),
  });

  // Cache per part: parsed entities + high-quality samples + per-orientation
  // data (rotated bbox min and transformed entities are per placement).
  const cache = {};
  const layerColors = {};
  const getPart = (id) => {
    if (!cache[id]) {
      const p = parts.find((q) => q.id === id);
      if (!p) throw new Error('Nepoznat part id: ' + id);
      const { entities, layers } = parseDxf(p.content);
      for (const [k, v] of Object.entries(layers || {})) {
        if (!(k in layerColors)) layerColors[k] = v;
      }
      const samples = sampleEntities(entities, SAMPLE_QUALITY);
      cache[id] = { part: p, entities, samples, orientations: {} };
    }
    return cache[id];
  };
  const getOrientation = (id, rotDeg) => {
    const c = getPart(id);
    const key = String(Math.round(rotDeg * 1000));
    if (!c.orientations[key]) {
      const rotated = c.samples.map((poly) => rotatePoints(poly, rotDeg));
      const all = [];
      for (const poly of rotated) for (const p of poly) all.push(p);
      const bb = bboxOfPoints(all);
      c.orientations[key] = { bb, rotated };
    }
    return c.orientations[key];
  };

  const outEntities = [];
  const placements = [];
  const placedByPart = {};

  for (const pl of nest.placements) {
    const u = unitsById[pl.id];
    for (const m of u.members) {
      const part = m.part;
      const mw = part.w;
      const mh = part.h;
      // Member bbox position inside the (possibly 90-degree-rotated) unit.
      let gx;
      let gy;
      if (!pl.rotated) {
        gx = pl.x + m.ox;
        gy = pl.y + m.oy;
      } else {
        // Unit box (w x h) turned 90 CCW: local (x,y) -> (h - y, x).
        gx = pl.x + (u.h - m.oy - mh);
        gy = pl.y + m.ox;
      }
      const turn = (m.rot180 ? 180 : 0) + (pl.rotated ? 90 : 0);
      const rotDeg = (part.preRotDeg || 0) + turn;
      const or = getOrientation(part.id, rotDeg);
      const dx = gx - or.bb.minX;
      const dy = gy - or.bb.minY;

      const c = getPart(part.id);
      for (const e of c.entities) {
        outEntities.push(transformEntity(e, { rotDeg, dx, dy }));
      }
      placedByPart[part.id] = (placedByPart[part.id] || 0) + 1;

      placements.push({
        id: part.id,
        name: part.name,
        x: gx,
        y: gy,
        w: pl.rotated ? mh : mw,
        h: pl.rotated ? mw : mh,
        rotated: turn === 90 || turn === 270,
        turn,
        // Exact rigid transform (entity' = R(rotDeg)*entity + (dx,dy)) -
        // enough to re-create the identical sheet DXF later without storing
        // the file.
        rotDeg,
        dx,
        dy,
        outline: or.rotated.map((poly) => simplifyPolyline(
          poly.map(([x, y]) => [round3(x + dx), round3(y + dy)]),
          0.1,
        )),
      });
    }
  }

  if (addFrame) {
    outEntities.push({
      type: 'POLYLINE',
      layer: 'PLOCA',
      closed: true,
      verts: [
        { x: 0, y: 0, bulge: 0 },
        { x: sheetW, y: 0, bulge: 0 },
        { x: sheetW, y: sheetH, bulge: 0 },
        { x: 0, y: sheetH, bulge: 0 },
      ],
    });
  }

  const summary = [];
  for (const id of Object.keys(placedByPart)) {
    const p = parts.find((q) => q.id === id);
    summary.push({ id, name: p ? p.name : id, count: placedByPart[id] });
  }
  summary.sort((a, b) => b.count - a.count);

  // Unit-level shortfalls map back to their member parts (a missed duo
  // means one missing copy of EACH member).
  const unplacedByPart = {};
  for (const u of nest.unplaced) {
    const unit = unitsById[u.id];
    if (!unit) continue;
    for (const m of unit.members) {
      unplacedByPart[m.part.id] = (unplacedByPart[m.part.id] || 0) + u.count;
    }
  }
  const unplaced = Object.keys(unplacedByPart).map((id) => {
    const p = parts.find((q) => q.id === id);
    return { id, name: p ? p.name : id, count: unplacedByPart[id] };
  });

  return {
    dxf: outEntities.length > 0 ? writeDxf(outEntities, { layerColors }) : null,
    placements,
    unplaced,
    placedCounts: placedByPart,
    utilization: nest.utilization,
    totalPlaced: placements.length,
    summary,
    notes,
    capped: nest.capped,
    maxTotal: nest.maxTotal,
  };
}

/**
 * Generate up to three different sheets for the same input:
 *  1. by priorities (the standard order),
 *  2. biggest parts first (priorities ignored),
 *  3. small parts flood the sheet first.
 * Identical results are deduplicated.
 */
function generateVariants(opts) {
  const defs = [
    { variant: 'prioriteti', variantLabel: 'Po prioritetima', order: 'priority' },
    { variant: 'krupno', variantLabel: 'Krupni komadi', order: 'big' },
    { variant: 'sitno', variantLabel: 'Sitni komadi', order: 'small' },
  ];
  const out = [];
  const seen = new Set();
  for (const d of defs) {
    const res = generateSheet({ ...opts, order: d.order });
    if (res.totalPlaced === 0) continue;
    const sig = JSON.stringify(res.placements.map((p) => [
      p.id, Math.round(p.x * 10), Math.round(p.y * 10), p.turn,
    ]).sort());
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ ...res, variant: d.variant, variantLabel: d.variantLabel });
  }
  return out;
}

/**
 * Re-create a sheet DXF from stored placements (the compact history record)
 * without re-running the nesting. Produces byte-identical output to the
 * original generateSheet call for the same parts.
 *
 * @param {object} opts
 * @param {Array} opts.parts       library entries with `content` for every
 *                                 part id used by the placements
 * @param {Array} opts.placements  [{id, rotDeg, dx, dy}]
 * @param {number} opts.sheetW, opts.sheetH
 * @param {boolean} [opts.addFrame=false]
 * @returns {string} DXF text
 */
function buildSheetDxf(opts) {
  const { parts = [], placements = [], sheetW, sheetH, addFrame = false } = opts;
  const cache = {};
  const layerColors = {};
  const getEntities = (id) => {
    if (!cache[id]) {
      const p = parts.find((q) => q.id === id);
      if (!p || typeof p.content !== 'string') {
        throw new Error('Part iz ove ploče više ne postoji u biblioteci.');
      }
      const parsed = parseDxf(p.content);
      for (const [k, v] of Object.entries(parsed.layers || {})) {
        if (!(k in layerColors)) layerColors[k] = v;
      }
      cache[id] = parsed.entities;
    }
    return cache[id];
  };

  const outEntities = [];
  for (const pl of placements) {
    for (const e of getEntities(pl.id)) {
      outEntities.push(transformEntity(e, { rotDeg: pl.rotDeg || 0, dx: pl.dx || 0, dy: pl.dy || 0 }));
    }
  }
  if (addFrame) {
    outEntities.push({
      type: 'POLYLINE',
      layer: 'PLOCA',
      closed: true,
      verts: [
        { x: 0, y: 0, bulge: 0 },
        { x: sheetW, y: 0, bulge: 0 },
        { x: sheetW, y: sheetH, bulge: 0 },
        { x: 0, y: sheetH, bulge: 0 },
      ],
    });
  }
  if (outEntities.length === 0) {
    throw new Error('Ploča je prazna - nema ničega za zapisati.');
  }
  return writeDxf(outEntities, { layerColors });
}

module.exports = {
  analyzePart, generateSheet, generateVariants, buildSheetDxf, buildUnits, applySet,
};
