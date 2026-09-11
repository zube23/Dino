'use strict';

/*
 * Part analysis (on import) and sheet generation (on "GENERIRAJ").
 * Pure functions - no filesystem access - so they are testable in plain Node
 * and reusable in a browser build later.
 */

const {
  parseDxf, writeDxf, transformEntity, sampleEntities, sampleEntity,
} = require('./dxf');
const {
  minAreaRect, bboxOfPoints, rotatePoint, rotatePoints, convexHull, polygonArea, simplifyPolyline,
  pointInPolygon, maxInscribedRect,
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
function analyzePart(content, opts) {
  // lockRotation: keep the drawing exactly as drawn (grain direction on
  // brushed/foiled sheet) - no tightest-box pre-rotation.
  const lockRotation = !!(opts && opts.lockRotation);
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
  const preRotDeg = lockRotation ? 0 : mar.angleDeg;

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

  // Big cut-outs become free nesting space - but only loops that are cut,
  // never engraving/marking geometry (a closed engraved logo is solid metal).
  const cutPolys = sampleEntities(entities.filter((e) => !ENGRAVE_LAYER.test(String(e.layer || ''))), SAMPLE_QUALITY)
    .map((poly) => rotatePoints(poly, preRotDeg).map(([x, y]) => [round3(x - bb.minX), round3(y - bb.minY)]));
  const holes = findHoles(cutPolys);

  return {
    preRotDeg,
    w: bb.w,
    h: bb.h,
    area,
    outline,
    texts,
    holes,
    warnings,
    entityCount: entities.length,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const ENGRAVE_LAYER = /grav|mark|engrav|text|napis|natpis/i;
const HOLE_MIN = 30; // mm - a smaller window never hosts a part worth the trouble

/**
 * Big cut-outs inside the outer contour, each reduced to the largest
 * axis-aligned rectangle that fits in it (part-local coords, bbox corner =
 * origin). Only genuinely empty windows count: a loop outside the outer
 * contour is another body, a loop with a further loop inside it (ring in a
 * ring) is not empty.
 */
function findHoles(polys) {
  const closed = polys.filter((p) => p.length >= 4
    && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6);
  if (closed.length < 2) return [];
  let outer = null;
  let outerArea = 0;
  for (const p of closed) {
    const a = Math.abs(polygonArea(p.slice(0, -1)));
    if (a > outerArea) {
      outerArea = a;
      outer = p;
    }
  }
  const holes = [];
  for (const p of closed) {
    if (p === outer) continue;
    if (Math.abs(polygonArea(p.slice(0, -1))) < HOLE_MIN * HOLE_MIN) continue;
    if (!pointInPolygon(p[0][0], p[0][1], outer)) continue;
    const occupied = closed.some((q) => q !== p && q !== outer && pointInPolygon(q[0][0], q[0][1], p));
    if (occupied) continue;
    const r = maxInscribedRect(p, HOLE_MIN);
    if (r) holes.push(r);
  }
  holes.sort((a, b) => b.w * b.h - a.w * a.h);
  return holes.slice(0, 6);
}


/**
 * Resolve the effective part list for nesting from the library and the
 * active set. A null set means "all enabled parts with their own settings";
 * a set contributes only its member parts, with the set's per-part settings.
 */
function applySet(parts, set, fillSet) {
  let out;
  if (!set) {
    out = parts.filter((p) => p.enabled);
  } else {
    const items = (set && set.items) || {};
    out = [];
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
  }
  // "Dopuni iz drugog seta": the fill set's parts join as fillers only,
  // ranked strictly after everything from the active selection, so they can
  // only ever take space that would otherwise stay empty.
  if (fillSet && fillSet !== set && fillSet.items) {
    const have = new Set(out.map((p) => p.id));
    const maxPrio = out.reduce((m, p) => Math.max(m, prioOf(p)), 0);
    for (const p of parts) {
      const it = fillSet.items[p.id];
      if (!it || have.has(p.id)) continue;
      // A pair whose partner is already in the selection is governed by it.
      if (p.pairId && have.has(p.pairId)) continue;
      out.push({
        ...p,
        enabled: true,
        mode: 'filler',
        count: 0,
        priority: maxPrio + (Number.isFinite(it.priority) ? it.priority : prioOf(p)),
        maxCount: Number.isFinite(it.maxCount) ? it.maxCount : p.maxCount,
        fromFillSet: true,
      });
    }
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
  // Cut-out rects of a member in unit-local coords (member turned 180 when
  // the duo layout says so, then shifted by the member's offset).
  const memberHoles = (m) => (Array.isArray(m.part.holes) ? m.part.holes : []).map((hh) => (m.rot180
    ? { x: m.ox + (m.part.w - hh.x - hh.w), y: m.oy + (m.part.h - hh.y - hh.h), w: hh.w, h: hh.h }
    : { x: m.ox + hh.x, y: m.oy + hh.y, w: hh.w, h: hh.h }));
  const unitExtras = (members) => ({
    noRotate: members.some((m) => !!m.part.noRotate),
    holes: members.flatMap(memberHoles),
  });

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
      const members = [memberOf(p, lay.a), memberOf(partner, lay.b)];
      units.push({
        uid: 'd:' + p.id + ':' + partner.id,
        w: lay.w,
        h: lay.h,
        area: p.area + partner.area,
        priority: Math.min(prioOf(p), prioOf(partner)),
        mode: isFiller ? 'filler' : 'fixed',
        count: Math.min(Math.max(0, Math.floor(p.count || 0)), Math.max(0, Math.floor(partner.count || 0))),
        maxCount,
        members,
        ...unitExtras(members),
      });
      continue;
    }

    used.add(p.id);
    const singleMembers = [{ part: p, rot180: false, ox: 0, oy: 0 }];
    const singleUnit = {
      uid: 's:' + p.id,
      w: p.w,
      h: p.h,
      area: p.area,
      priority: prioOf(p),
      mode: p.mode,
      count: p.count,
      maxCount: p.maxCount,
      members: singleMembers,
      ...unitExtras(singleMembers),
    };

    const lay = duoFor(p, p);
    const selfDuoGood = lay
      && (lay.w + gap) * (lay.h + gap) <= 0.92 * separateArea(p, p, gap);
    if (!selfDuoGood) {
      units.push(singleUnit);
      continue;
    }

    const duoMembers = [memberOf(p, lay.a), memberOf(p, lay.b)];
    const duoUnit = {
      uid: 'd:' + p.id + ':' + p.id,
      w: lay.w,
      h: lay.h,
      area: 2 * p.area,
      priority: prioOf(p),
      mode: p.mode,
      count: 0,
      maxCount: 0,
      members: duoMembers,
      ...unitExtras(duoMembers),
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
    order = 'priority', heuristic = 'bssf', rng = null, blocked = [],
    tabsMax = 0, skeleton = null,
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
    heuristic,
    rng,
    blocked,
    parts: units.map((u) => ({
      id: u.uid,
      w: u.w,
      h: u.h,
      area: u.area,
      priority: u.priority,
      mode: u.mode,
      count: u.count,
      maxCount: u.maxCount,
      noRotate: u.noRotate,
      holes: u.holes,
    })),
  });

  // Cache per part: parsed entities + high-quality samples + per-orientation
  // data (rotated bbox min and transformed entities are per placement).
  const cache = {};
  const layerColors = {};
  const tabbedNames = [];
  const getPart = (id) => {
    if (!cache[id]) {
      const p = parts.find((q) => q.id === id);
      if (!p) throw new Error('Nepoznat part id: ' + id);
      const parsed = parseDxf(p.content);
      for (const [k, v] of Object.entries(parsed.layers || {})) {
        if (!(k in layerColors)) layerColors[k] = v;
      }
      let { entities } = parsed;
      if (wantsTabs(p, tabsMax)) {
        const t = applyTabs(entities, TAB_WIDTH);
        if (t.applied) {
          entities = t.entities;
          tabbedNames.push(p.name);
        }
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

  // "Rezanje kostura": chop lines through the empty corridors, on their own
  // layer so CypCut can sequence them last.
  let extraLines = [];
  if (skeleton && skeleton.spacing > 0 && placements.length > 0) {
    extraLines = skeletonLines(placements, sheetW, sheetH, margin, skeleton.spacing,
      Math.max(3, gap / 2), blocked);
    if (extraLines.length > 0) {
      layerColors[SKELETON_LAYER] = SKELETON_COLOR;
      for (const ln of extraLines) outEntities.push(lineEntity(ln));
    }
  }
  if (tabbedNames.length > 0) {
    notes.push('Mikro-mostići dodani: ' + tabbedNames.join(', ') + '.');
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
    freeRects: nest.freeRects,
    extraLines,
    tabsMax: tabsMax > 0 ? tabsMax : 0,
  };
}

// ---------------------------------------------------------------------------
// Skeleton chop lines
// ---------------------------------------------------------------------------

const SKELETON_LAYER = 'KOSTUR';
const SKELETON_COLOR = 8; // ACI dark grey - clearly "not a part"

function lineEntity(ln) {
  return {
    type: 'LINE', layer: SKELETON_LAYER, x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2,
  };
}

/**
 * Straight chop lines through the empty corridors of a nested sheet, every
 * `spacing` mm in both directions, so the leftover skeleton falls apart into
 * bin-sized strips. Segments keep `clear` mm from every placed part box (and
 * from keep-out zones) and run only through free space.
 */
function skeletonLines(placements, sheetW, sheetH, margin, spacing, clear, blocked) {
  const boxes = placements.map((p) => ({
    x0: p.x - clear, y0: p.y - clear, x1: p.x + p.w + clear, y1: p.y + p.h + clear,
  }));
  for (const z of blocked || []) {
    if (z && z.w > 0 && z.h > 0) boxes.push({ x0: z.x, y0: z.y, x1: z.x + z.w, y1: z.y + z.h });
  }
  const MIN_LEN = 30;
  const r1 = (n) => Math.round(n * 10) / 10;
  const lines = [];
  const cutAlong = (vertical) => {
    const span = vertical ? sheetW : sheetH; // axis we step along
    const len = vertical ? sheetH : sheetW;  // axis the line runs along
    const end = len - margin;
    for (let pos = margin + spacing; pos < span - margin - spacing / 2; pos += spacing) {
      const busy = [];
      for (const b of boxes) {
        const lo = vertical ? b.x0 : b.y0;
        const hi = vertical ? b.x1 : b.y1;
        if (pos > lo && pos < hi) busy.push(vertical ? [b.y0, b.y1] : [b.x0, b.x1]);
      }
      busy.sort((a, b) => a[0] - b[0]);
      const emit = (a, b) => {
        if (b - a < MIN_LEN) return;
        lines.push(vertical
          ? { x1: r1(pos), y1: r1(a), x2: r1(pos), y2: r1(b) }
          : { x1: r1(a), y1: r1(pos), x2: r1(b), y2: r1(pos) });
      };
      let cur = margin;
      for (const [a, b] of busy) {
        if (a > cur) emit(cur, Math.min(a, end));
        cur = Math.max(cur, b);
        if (cur >= end) break;
      }
      if (cur < end) emit(cur, end);
    }
  };
  cutAlong(true);
  cutAlong(false);
  return lines;
}

// ---------------------------------------------------------------------------
// Micro-tabs ("mikro-mostici"): tiny uncut bridges on small parts so they
// stay held in the skeleton instead of tipping up or falling through slats.
// ---------------------------------------------------------------------------

const TAB_WIDTH = 0.5; // mm of contour left uncut per tab
const CHAIN_TOL = 0.3; // mm - endpoint matching tolerance when chaining loops

function wantsTabs(part, tabsMax) {
  return tabsMax > 0 && !part.noTabs && Math.max(part.w || 0, part.h || 0) <= tabsMax;
}

/** Endpoints of an open contour entity, or null when the entity is closed / not a contour. */
function entityEnds(e) {
  const DEGR = Math.PI / 180;
  switch (e.type) {
    case 'LINE':
      return { a: [e.x1, e.y1], b: [e.x2, e.y2] };
    case 'ARC':
      return {
        a: [e.cx + e.r * Math.cos(e.a1 * DEGR), e.cy + e.r * Math.sin(e.a1 * DEGR)],
        b: [e.cx + e.r * Math.cos(e.a2 * DEGR), e.cy + e.r * Math.sin(e.a2 * DEGR)],
      };
    case 'POLYLINE': {
      if (e.closed || !e.verts || e.verts.length < 2) return null;
      const f = e.verts[0];
      const l = e.verts[e.verts.length - 1];
      return { a: [f.x, f.y], b: [l.x, l.y] };
    }
    case 'SPLINE':
    case 'ELLIPSE': {
      if (e.type === 'SPLINE' && e.closed) return null;
      if (e.type === 'ELLIPSE' && Math.abs(((e.t2 - e.t1) % (Math.PI * 2)) || (Math.PI * 2)) >= Math.PI * 2 - 1e-9) return null;
      const pts = sampleEntity(e, 1)[0] || [];
      if (pts.length < 2) return null;
      return { a: pts[0], b: pts[pts.length - 1] };
    }
    default:
      return null;
  }
}

function isClosedContour(e) {
  if (e.type === 'CIRCLE') return true;
  if (e.type === 'POLYLINE') return !!e.closed && e.verts && e.verts.length >= 3;
  if (e.type === 'SPLINE') return !!e.closed;
  if (e.type === 'ELLIPSE') return entityEnds(e) === null;
  return false;
}

/**
 * Chain contour entities into closed loops by matching endpoints. Returns
 * [{members:[{e, reversed}]}] - only loops that actually close.
 */
function chainLoops(entities) {
  const loops = [];
  const open = [];
  entities.forEach((e, idx) => {
    if (isClosedContour(e)) loops.push({ members: [{ e, reversed: false, idx }] });
    else {
      const ends = entityEnds(e);
      if (ends) open.push({ e, idx, a: ends.a, b: ends.b, used: false });
    }
  });
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= CHAIN_TOL;
  for (const start of open) {
    if (start.used) continue;
    start.used = true;
    const members = [{ e: start.e, reversed: false, idx: start.idx }];
    let cur = start.b;
    let closed = false;
    for (let guard = 0; guard < open.length; guard++) {
      if (near(cur, start.a) && members.length > 1) { closed = true; break; }
      let next = null;
      let reversed = false;
      for (const o of open) {
        if (o.used) continue;
        if (near(o.a, cur)) { next = o; reversed = false; break; }
        if (near(o.b, cur)) { next = o; reversed = true; break; }
      }
      if (!next) break;
      next.used = true;
      members.push({ e: next.e, reversed, idx: next.idx });
      cur = reversed ? next.a : next.b;
    }
    if (!closed && near(cur, start.a) && members.length > 1) closed = true;
    if (closed) loops.push({ members });
  }
  return loops;
}

/** Sampled points of a loop, in walking order (quality 8 = write quality). */
function loopPoints(loop) {
  const pts = [];
  for (const m of loop.members) {
    let p = sampleEntity(m.e, 8)[0] || [];
    if (m.reversed) p = p.slice().reverse();
    for (const q of p) {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - q[0], last[1] - q[1]) < 1e-6) continue;
      pts.push(q);
    }
  }
  if (pts.length > 1) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) pts.pop();
  }
  return pts;
}

/**
 * Replace the part's outer contour by 2-3 open polylines with `tabW` mm
 * uncut between them. Inner holes, engraving and everything else stay as
 * they are. Returns {entities, applied}.
 */
function applyTabs(entities, tabW) {
  const loops = chainLoops(entities);
  let outer = null;
  let outerPts = null;
  let outerArea = 0;
  for (const L of loops) {
    const pts = loopPoints(L);
    if (pts.length < 3) continue;
    const a = Math.abs(polygonArea(pts));
    if (a > outerArea) {
      outerArea = a;
      outer = L;
      outerPts = pts;
    }
  }
  if (!outer) return { entities, applied: false };
  const n = outerPts.length;
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(outerPts[(i + 1) % n][0] - outerPts[i][0], outerPts[(i + 1) % n][1] - outerPts[i][1]);
    seg.push(d);
    total += d;
  }
  const tabs = total < 200 ? 2 : 3;
  if (total < tabs * (tabW + 5)) return { entities, applied: false };

  const pointAt = (s) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (s <= acc + seg[i] || i === n - 1) {
        const t = seg[i] > 1e-12 ? Math.min(1, Math.max(0, (s - acc) / seg[i])) : 0;
        const p = outerPts[i];
        const q = outerPts[(i + 1) % n];
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      }
      acc += seg[i];
    }
    return outerPts[0];
  };
  // Vertex positions along the perimeter (for collecting the ones inside a span).
  const at = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { at.push(acc); acc += seg[i]; }

  const first = outer.members[0].e;
  const pieces = [];
  for (let k = 0; k < tabs; k++) {
    const s0 = ((k + 0.5) * total) / tabs + tabW / 2;         // cut starts after this tab
    const s1 = ((k + 1.5) * total) / tabs - tabW / 2;         // ...and ends before the next
    const verts = [];
    const push = (p) => {
      const last = verts[verts.length - 1];
      if (last && Math.hypot(last.x - p[0], last.y - p[1]) < 1e-6) return;
      verts.push({ x: p[0], y: p[1], bulge: 0 });
    };
    push(pointAt(s0 % total));
    // Vertices strictly inside (s0, s1), in walking order; s1 may wrap past
    // the perimeter end, which the second pass (positions + total) covers.
    for (let i = 0; i < n; i++) if (at[i] > s0 + 1e-9 && at[i] < s1 - 1e-9) push(outerPts[i]);
    for (let i = 0; i < n; i++) if (at[i] + total > s0 + 1e-9 && at[i] + total < s1 - 1e-9) push(outerPts[i]);
    push(pointAt(s1 % total));
    if (verts.length >= 2) {
      pieces.push({ type: 'POLYLINE', layer: first.layer || '0', color: first.color, closed: false, verts });
    }
  }
  const outerIdx = new Set(outer.members.map((m) => m.idx));
  const out = entities.filter((e, idx) => !outerIdx.has(idx)).concat(pieces);
  return { entities: out, applied: pieces.length === tabs };
}

// ---------------------------------------------------------------------------
// "Zasto ne stane?" and "Razmak uzivo"
// ---------------------------------------------------------------------------

/**
 * Instant unit-level answer to "how many pieces fit at gap X?" for several
 * candidate gaps (priority order, no materialization).
 * @returns [{gap, placed, unplaced, utilization}]
 */
function gapSweep(opts, gaps) {
  const out = [];
  for (const gap of gaps) {
    const { rects, membersOf } = unitRects(opts.parts || [], gap);
    const nest = nestParts({
      sheetW: opts.sheetW,
      sheetH: opts.sheetH,
      margin: opts.margin,
      gap,
      allowRotate: opts.allowRotate,
      maxTotal: opts.maxTotal,
      blocked: opts.blocked || [],
      order: 'priority',
      parts: rects,
    });
    let placed = 0;
    for (const pl of nest.placements) placed += membersOf[pl.id] || 1;
    out.push({ gap, placed, unplaced: missingMembers(nest, membersOf), utilization: nest.utilization });
  }
  return out;
}

/**
 * Plain-language data for an unplaced part: how big the largest free hole
 * is, how many mm the part misses by, and whether a slightly smaller gap
 * would have fit more. Null when everything was placed.
 */
function whyNotHint(res, opts) {
  if (!res || !Array.isArray(res.unplaced) || res.unplaced.length === 0) return null;
  const parts = opts.parts || [];
  let target = null;
  for (const u of res.unplaced) {
    const p = parts.find((q) => q.id === u.id);
    if (p && (!target || p.w * p.h > target.w * target.h)) target = p;
  }
  if (!target) return null;
  const free = (res.freeRects || [])[0] || null;
  let missing = null;
  if (free) {
    const upright = Math.max(target.w - free.w, target.h - free.h, 0);
    const turned = Math.max(target.h - free.w, target.w - free.h, 0);
    missing = Math.round(Math.min(upright, turned) * 10) / 10;
  }
  const base = unplacedTotal(res);
  const gap = Number.isFinite(opts.gap) ? opts.gap : 8;
  const cands = [];
  for (let g = Math.ceil(gap) - 1; g >= Math.max(0, gap - 5); g--) cands.push(g);
  let betterGap = null;
  if (cands.length > 0) {
    for (const s of gapSweep(opts, cands)) {
      if (s.unplaced < base) {
        betterGap = { gap: s.gap, extra: base - s.unplaced };
        break;
      }
    }
  }
  return {
    partId: target.id,
    partName: target.name,
    partW: Math.round(target.w * 10) / 10,
    partH: Math.round(target.h * 10) / 10,
    free: free ? { w: free.w, h: free.h } : null,
    missing,
    betterGap,
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

/** Deterministic 32-bit PRNG - same seed, same restart, same sheet. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unplacedTotal(res) {
  let n = 0;
  for (const u of (res && res.unplaced) || []) n += u.count || 0;
  return n;
}

/**
 * Cheap search representation: packer rectangles for the part units plus the
 * member count per unit, so unit-level nest results can be scored in the
 * same member-weighted terms generateSheet reports (a missed duo = 2 parts).
 */
function unitRects(parts, gap) {
  const { units } = buildUnits(parts, gap);
  const rects = units.map((u) => ({
    id: u.uid,
    w: u.w,
    h: u.h,
    area: u.area,
    priority: u.priority,
    mode: u.mode,
    count: u.count,
    maxCount: u.maxCount,
    noRotate: u.noRotate,
    holes: u.holes,
  }));
  const membersOf = {};
  for (const u of units) membersOf[u.uid] = u.members.length;
  return { rects, membersOf };
}

function missingMembers(nest, membersOf) {
  let missing = 0;
  for (const u of nest.unplaced) missing += (u.count || 0) * (membersOf[u.id] || 1);
  return missing;
}

/**
 * "STISNI JACE": multi-restart search over placement heuristics and
 * randomized part orders (shuffled only WITHIN the same priority, so
 * priorities still hold). Restart 0 is the exact deterministic baseline of
 * GENERIRAJ, so the dense result is never worse than the standard sheet.
 * The search scores cheap unit-level nests and materializes the full sheet
 * (DXF entities, outlines) only once, for the winner.
 *
 * @returns generateSheet result tagged {variant:'stisnuto'} or null when
 *          nothing can be placed at all.
 */
function generateDense(opts, denseOpts) {
  const {
    sheetW, sheetH, margin = 10, gap = 8, allowRotate = true,
    parts = [], maxTotal, blocked = [],
  } = opts;
  const { budgetMs = 5000, seed = 1, maxRestarts = 20000 } = denseOpts || {};

  const { rects, membersOf } = unitRects(parts, gap);
  const heuristics = ['bssf', 'baf', 'bl'];
  const pick = mulberry32((seed >>> 0) || 1);
  const deadline = Date.now() + Math.max(250, budgetMs);

  let best = null; // {heuristic, seed(0 = no shuffle), missing, utilization}
  const tryOne = (heuristic, restartSeed) => {
    const nest = nestParts({
      sheetW,
      sheetH,
      margin,
      gap,
      allowRotate,
      maxTotal,
      order: 'priority',
      heuristic,
      rng: restartSeed ? mulberry32(restartSeed) : null,
      blocked,
      parts: rects,
    });
    const missing = missingMembers(nest, membersOf);
    if (!best || missing < best.missing
      || (missing === best.missing && nest.utilization > best.utilization + 1e-9)) {
      best = { heuristic, seed: restartSeed, missing, utilization: nest.utilization };
    }
  };

  tryOne('bssf', 0); // restart 0 = the standard GENERIRAJ result
  tryOne('baf', 0);
  tryOne('bl', 0);
  let restarts = 3;
  while (Date.now() < deadline && restarts < maxRestarts) {
    tryOne(heuristics[Math.floor(pick() * heuristics.length)],
      1 + Math.floor(pick() * 0xFFFFFFFE));
    restarts += 1;
  }

  const res = generateSheet({
    ...opts,
    order: 'priority',
    heuristic: best.heuristic,
    rng: best.seed ? mulberry32(best.seed) : null,
  });
  if (res.totalPlaced === 0) return null;
  return {
    ...res, variant: 'stisnuto', variantLabel: 'Stisnuto jače', denseRestarts: restarts,
  };
}

// "Na knap" probes: tiny sheet enlargements (dW along X/sirina, dH along
// Y/duljina), smallest first, capped by the user's limit (default +10 mm).
const KNAP_BUMPS = [
  [0, 1], [1, 0], [1, 1], [0, 2], [2, 0], [2, 2], [3, 3],
  [0, 5], [5, 0], [5, 5], [8, 8], [0, 10], [10, 0], [10, 10],
];

/**
 * "Na knap": when something almost fits, try a slightly bigger sheet.
 * Probes are scored cheaply at unit level with ALL THREE fill orders (the
 * baseline is the best of all offered sheets, so beating it may need the
 * big-first or small-first strategy too); the full sheet is materialized
 * only for the winning bump+order. Returns the smallest bump that places
 * more than the best regular sheet did (fewer unplaced), tagged
 * {variant:'naknap', knapDims:{width,height}} where width = X/sirina and
 * height = Y/duljina of the enlarged sheet. Null when no small bump helps.
 */
function generateKnap(opts, baselineUnplaced, maxBump) {
  const limit = Number.isFinite(maxBump) ? maxBump : 10;
  if (!(baselineUnplaced > 0) || limit <= 0) return null;
  const {
    sheetW, sheetH, margin = 10, gap = 8, allowRotate = true,
    parts = [], maxTotal, blocked = [],
  } = opts;
  const { rects, membersOf } = unitRects(parts, gap);

  for (const [bw, bh] of KNAP_BUMPS) {
    if (bw > limit || bh > limit) continue;
    let best = null; // {order, missing, utilization}
    for (const order of ['priority', 'big', 'small']) {
      const nest = nestParts({
        sheetW: sheetW + bw,
        sheetH: sheetH + bh,
        margin,
        gap,
        allowRotate,
        maxTotal,
        order,
        blocked,
        parts: rects,
      });
      const missing = missingMembers(nest, membersOf);
      if (!best || missing < best.missing
        || (missing === best.missing && nest.utilization > best.utilization + 1e-9)) {
        best = { order, missing, utilization: nest.utilization };
      }
    }
    if (best.missing < baselineUnplaced) {
      const res = generateSheet({
        ...opts, sheetW: sheetW + bw, sheetH: sheetH + bh, order: best.order,
      });
      if (res.totalPlaced > 0) {
        return {
          ...res,
          variant: 'naknap',
          variantLabel: 'Na knap +' + String(Math.max(bw, bh) / 10).replace('.', ',') + ' cm',
          knapDims: { width: sheetW + bw, height: sheetH + bh },
          knapBump: { w: bw, h: bh },
        };
      }
    }
  }
  return null;
}

/**
 * One-stop generation for a GENERIRAJ / STISNI JACE press. Returns the
 * ordered list of sheets to offer:
 *   [stisnuto?] + [prioriteti, krupno, sitno] + [naknap?]
 * - stisnuto only when `dense` is requested AND it differs from the regular
 *   sheets (identical layouts are deduplicated);
 * - naknap only when even the best regular/dense sheet leaves something
 *   unplaced and a bump of at most `knapMax` mm fits more.
 */
function generateAll(opts, extra) {
  const { dense = false, budgetMs, seed, maxRestarts, knapMax = 10 } = extra || {};
  const out = [];
  const seen = new Set();
  const sigOf = (res) => JSON.stringify(res.placements.map((p) => [
    p.id, Math.round(p.x * 10), Math.round(p.y * 10), p.turn,
  ]).sort());
  let minUnplaced = Infinity;

  const defs = [
    { variant: 'prioriteti', variantLabel: 'Po prioritetima', order: 'priority' },
    { variant: 'krupno', variantLabel: 'Krupni komadi', order: 'big' },
    { variant: 'sitno', variantLabel: 'Sitni komadi', order: 'small' },
  ];
  for (const d of defs) {
    const res = generateSheet({ ...opts, order: d.order });
    minUnplaced = Math.min(minUnplaced, unplacedTotal(res));
    if (res.totalPlaced === 0) continue;
    const s = sigOf(res);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ ...res, variant: d.variant, variantLabel: d.variantLabel });
  }
  // "Zasto ne stane?" - explain the shortfall of the priority sheet (the
  // one the operator reads first); computed once, cheap.
  const lead = out.find((r) => r.variant === 'prioriteti') || out[0];
  if (lead && lead.unplaced.length > 0) lead.hint = whyNotHint(lead, opts);

  if (dense) {
    const dres = generateDense(opts, { budgetMs, seed, maxRestarts });
    if (dres) {
      minUnplaced = Math.min(minUnplaced, unplacedTotal(dres));
      const s = sigOf(dres);
      if (!seen.has(s)) {
        seen.add(s);
        out.unshift(dres); // best sheet first
      }
    }
  }

  if (Number.isFinite(minUnplaced) && minUnplaced > 0) {
    const knap = generateKnap(opts, minUnplaced, knapMax);
    if (knap) out.push(knap);
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
  const {
    parts = [], placements = [], sheetW, sheetH, addFrame = false,
    extraLines = [], tabsMax = 0,
  } = opts;
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
      let { entities } = parsed;
      if (wantsTabs(p, tabsMax)) {
        const t = applyTabs(entities, TAB_WIDTH);
        if (t.applied) entities = t.entities;
      }
      cache[id] = entities;
    }
    return cache[id];
  };

  const outEntities = [];
  for (const pl of placements) {
    for (const e of getEntities(pl.id)) {
      outEntities.push(transformEntity(e, { rotDeg: pl.rotDeg || 0, dx: pl.dx || 0, dy: pl.dy || 0 }));
    }
  }
  if (Array.isArray(extraLines) && extraLines.length > 0) {
    layerColors[SKELETON_LAYER] = SKELETON_COLOR;
    for (const ln of extraLines) outEntities.push(lineEntity(ln));
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
  analyzePart, generateSheet, generateVariants, generateDense, generateKnap,
  generateAll, buildSheetDxf, buildUnits, applySet, gapSweep, whyNotHint,
  skeletonLines, applyTabs, chainLoops, findHoles,
};
