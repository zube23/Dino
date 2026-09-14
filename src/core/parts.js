'use strict';

/*
 * Part analysis (on import) and sheet generation (on "GENERIRAJ").
 * Pure functions - no filesystem access - so they are testable in plain Node
 * and reusable in a browser build later.
 */

const {
  parseDxf, writeDxf, transformEntity, sampleEntities, sampleEntity, arcSweep,
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
  const cutItems = [];
  for (const e of entities) {
    if (ENGRAVE_LAYER.test(String(e.layer || ''))) continue;
    for (const poly of sampleEntity(e, SAMPLE_QUALITY)) {
      if (poly.length === 0) continue;
      cutItems.push({
        layer: String(e.layer || '0'),
        pts: rotatePoints(poly, preRotDeg).map(([x, y]) => [round3(x - bb.minX), round3(y - bb.minY)]),
      });
    }
  }
  const holes = findHoles(cutItems);

  // The outline in the drawing's own coordinates: previews of old sheets
  // re-create the exact placement transform from it (rotDeg/dx/dy), so a
  // later rotation-lock toggle cannot change how history looks.
  const outlineRaw = polys.map((poly) => simplifyPolyline(
    poly.map(([x, y]) => [round3(x), round3(y)]),
    0.05,
  ));

  return {
    preRotDeg,
    w: bb.w,
    h: bb.h,
    area,
    outline,
    outlineRaw,
    texts,
    holes,
    warnings,
    entityCount: entities.length,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Layer names that mean "drawn on the metal, not cut through" (Croatian and
// English spellings CAD users actually type).
const ENGRAVE_LAYER = /grav|mark|engrav|te[kx]st|napis|natpis|oznak|logo|slov|etch|score|scrib|raster/i;
const HOLE_MIN = 30; // mm - a smaller window never hosts a part worth the trouble

/**
 * Big cut-outs inside a part, each reduced to the largest axis-aligned
 * rectangle that fits in it (part-local coords, bbox corner = origin).
 * Rules, on the cut geometry only:
 *  - loop nesting depth decides solid vs empty (even-odd): depth 0 is a
 *    body, depth 1 a window in it, depth 2 an island (solid) inside that
 *    window - only odd-depth loops are windows;
 *  - a window with ANY geometry inside it (island, pre-nested plate, a
 *    chain of lines) is not empty;
 *  - a window must sit on the same layer as its body: a closed loop on an
 *    unknown engraving/marking layer is drawn ON the metal, not cut out.
 */
function findHoles(items) {
  const isClosed = (p) => p.length >= 4
    && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6;
  const loops = items.filter((it) => isClosed(it.pts));
  if (loops.length < 2) return [];
  const areaOf = (it) => Math.abs(polygonArea(it.pts.slice(0, -1)));
  const contains = (o, it) => o !== it && areaOf(o) > areaOf(it)
    && pointInPolygon(it.pts[0][0], it.pts[0][1], o.pts);
  const holes = [];
  for (const it of loops) {
    if (areaOf(it) < HOLE_MIN * HOLE_MIN) continue;
    const parents = loops.filter((o) => contains(o, it));
    if (parents.length % 2 === 0) continue; // a body or an island - solid metal
    let body = null;
    for (const o of parents) if (!body || areaOf(o) < areaOf(body)) body = o;
    if (!body || body.layer !== it.layer) continue;
    const occupied = items.some((q) => q !== it && q.pts.length > 0
      && q.pts.some((pt) => pointInPolygon(pt[0], pt[1], it.pts)));
    if (occupied) continue;
    const r = maxInscribedRect(it.pts, HOLE_MIN);
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
      // A 'Tocan broj N' item in the fill set means "up to N of these",
      // never an unlimited flood; N = 0 means nothing is wanted from it.
      const cap = it.mode === 'fixed'
        ? Math.max(0, Math.floor(Number.isFinite(it.count) ? it.count : (p.count || 0)))
        : (Number.isFinite(it.maxCount) ? it.maxCount : p.maxCount);
      if (it.mode === 'fixed' && cap === 0) continue;
      out.push({
        ...p,
        enabled: true,
        mode: 'filler',
        count: 0,
        priority: maxPrio + (Number.isFinite(it.priority) ? it.priority : prioOf(p)),
        maxCount: cap,
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
    fillSet: members.every((m) => !!m.part.fromFillSet),
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
      fillSet: u.fillSet,
    })),
  });

  // Cache per part: parsed entities + high-quality samples + per-orientation
  // data (rotated bbox min and transformed entities are per placement).
  const cache = {};
  const layerColors = {};
  const tabbedNames = [];
  const tabbedIds = [];
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
          tabbedIds.push(p.id);
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
    summary.push({ id, name: (p ? p.name : id) + (p && p.fromFillSet ? ' (dopuna)' : ''), count: placedByPart[id] });
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
    // Which parts actually got tabs - stored with the sheet so regeneration
    // does not depend on the library's current dimensions.
    tabbed: tabbedIds,
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
 * from keep-out zones) and run only through free space, edge to edge.
 */
function skeletonLines(placements, sheetW, sheetH, margin, spacing, clear, blocked) { // eslint-disable-line no-unused-vars
  const boxes = placements.map((p) => ({
    x0: p.x - clear, y0: p.y - clear, x1: p.x + p.w + clear, y1: p.y + p.h + clear,
  }));
  for (const z of blocked || []) {
    if (z && z.w > 0 && z.h > 0) {
      boxes.push({ x0: z.x - clear, y0: z.y - clear, x1: z.x + z.w + clear, y1: z.y + z.h + clear });
    }
  }
  const MIN_LEN = 30;
  const r1 = (n) => Math.round(n * 10) / 10;
  const lines = [];
  const cutAlong = (vertical) => {
    const span = vertical ? sheetW : sheetH; // axis we step along
    const len = vertical ? sheetH : sheetW;  // axis the line runs along
    // Lines run edge to edge: the rim is scrap too, and a strip still held
    // by the rim is not a strip.
    const end = len;
    for (let pos = spacing; pos < span - spacing / 2; pos += spacing) {
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
      let cur = 0;
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
const CORNER_DEG = 25; // direction change that makes a vertex a corner (tabs avoid corners)
const TWO_PI = Math.PI * 2;

function wantsTabs(part, tabsMax) {
  return tabsMax > 0 && !part.noTabs && Math.max(part.w || 0, part.h || 0) <= tabsMax;
}

const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Endpoints of an open contour entity, or null when closed / not a contour. */
function entityEnds(e) {
  const DEGR = Math.PI / 180;
  switch (e.type) {
    case 'LINE':
      return { a: [e.x1, e.y1], b: [e.x2, e.y2] };
    case 'ARC':
      if (arcSweep(e.a1, e.a2) >= 360 - 1e-6) return null;
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
      if (e.type === 'ELLIPSE') {
        const sweep = Math.abs(e.t2 - e.t1);
        if (sweep >= TWO_PI - 1e-6) return null; // full ellipse (rounded 2*pi included)
      }
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
  if (e.type === 'ARC') return arcSweep(e.a1, e.a2) >= 360 - 1e-6;
  if (e.type === 'POLYLINE') {
    if (!e.closed || !e.verts) return false;
    // A closed 2-vertex polyline with bulges is the classic "circle as polyline".
    return e.verts.length >= 3 || (e.verts.length === 2 && e.verts.some((v) => Math.abs(v.bulge || 0) > 1e-9));
  }
  if (e.type === 'SPLINE') return !!e.closed;
  if (e.type === 'ELLIPSE') return entityEnds(e) === null;
  return false;
}

/**
 * Chain contour entities into closed loops by matching endpoints. Returns
 * [{members:[{e, reversed, idx}]}] - only loops that actually close.
 * Engraving/marking layers never take part; a stray line that dead-ends
 * inside the part loses to the edge that continues onward; entities of a
 * walk that fails to close are released for later walks.
 */
function chainLoops(entities) {
  const loops = [];
  const open = [];
  entities.forEach((e, idx) => {
    if (ENGRAVE_LAYER.test(String(e.layer || ''))) return;
    if (isClosedContour(e)) {
      loops.push({ members: [{ e, reversed: false, idx }] });
      return;
    }
    const ends = entityEnds(e);
    if (!ends) return;
    if (dist2(ends.a, ends.b) <= CHAIN_TOL) {
      // An open entity that returns to its start is a loop by itself
      // (closed-flag-0 polylines, arcs written 0..360 with rounding).
      loops.push({ members: [{ e, reversed: false, idx }] });
      return;
    }
    open.push({ e, idx, a: ends.a, b: ends.b, used: false });
  });
  // Number of entity ends meeting at a point (the candidate's own counts 1).
  const meets = (p) => open.reduce((n, o) => n
    + (dist2(o.a, p) <= CHAIN_TOL ? 1 : 0) + (dist2(o.b, p) <= CHAIN_TOL ? 1 : 0), 0);
  for (const start of open) {
    if (start.used) continue;
    start.used = true;
    const members = [{ e: start.e, reversed: false, idx: start.idx }];
    const taken = [start];
    let cur = start.b;
    let closed = false;
    for (let guard = 0; guard < open.length; guard++) {
      if (dist2(cur, start.a) <= CHAIN_TOL) {
        closed = true;
        break;
      }
      let next = null;
      let reversed = false;
      let bestKey = null;
      for (const o of open) {
        if (o.used) continue;
        for (const rev of [false, true]) {
          const d = dist2(rev ? o.b : o.a, cur);
          if (d > CHAIN_TOL) continue;
          const far = rev ? o.a : o.b;
          const key = [meets(far) >= 2 ? 0 : 1, d];
          if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
            bestKey = key;
            next = o;
            reversed = rev;
          }
        }
      }
      if (!next) break;
      next.used = true;
      taken.push(next);
      members.push({ e: next.e, reversed, idx: next.idx });
      cur = reversed ? next.a : next.b;
    }
    if (closed) loops.push({ members });
    else for (const o of taken) o.used = false;
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
      if (last && dist2(last, q) < 1e-6) continue;
      pts.push(q);
    }
  }
  if (pts.length > 1 && dist2(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  return pts;
}

/**
 * Replace every body contour of the part (top-level closed loops) by 2-3
 * open polylines with `tabW` mm uncut between them. Holes, engraving and
 * everything else stay as they are. Returns {entities, applied}; applied is
 * false when the outer contour could not be recognised - then the part is
 * left exactly as drawn rather than bridging a hole by mistake.
 */
function applyTabs(entities, tabW) {
  const loops = chainLoops(entities)
    .map((L) => ({ L, pts: loopPoints(L) }))
    .filter((x) => x.pts.length >= 3);
  if (loops.length === 0) return { entities, applied: false };
  const areaOf = (x) => Math.abs(polygonArea(x.pts));
  const bodies = loops.filter((x) => !loops.some((o) => o !== x && areaOf(o) > areaOf(x)
    && pointInPolygon(x.pts[0][0], x.pts[0][1], o.pts)));
  // Safety net: the bodies must span the cut geometry.
  const cutPts = [];
  for (const e of entities) {
    if (ENGRAVE_LAYER.test(String(e.layer || ''))) continue;
    for (const poly of sampleEntity(e, 1)) for (const p of poly) cutPts.push(p);
  }
  const bbAll = bboxOfPoints(cutPts);
  const bbBodies = bboxOfPoints(bodies.flatMap((b) => b.pts));
  if (bbBodies.w < 0.9 * bbAll.w - 1e-6 || bbBodies.h < 0.9 * bbAll.h - 1e-6) {
    return { entities, applied: false };
  }
  const pieces = [];
  const drop = new Set();
  for (const b of bodies) {
    const runs = splitLoop(b.pts, tabW);
    if (!runs) return { entities, applied: false }; // too small to bridge
    const first = b.L.members[0].e;
    for (const verts of runs) {
      pieces.push({ type: 'POLYLINE', layer: first.layer || '0', color: first.color, closed: false, verts });
    }
    for (const m of b.L.members) drop.add(m.idx);
  }
  if (pieces.length === 0) return { entities, applied: false };
  return { entities: entities.filter((e, idx) => !drop.has(idx)).concat(pieces), applied: true };
}

/** Distance between two positions on a ring of length `total`. */
function ringDist(a, b, total) {
  const d = Math.abs(a - b) % total;
  return Math.min(d, total - d);
}

/**
 * Split a closed ring (points in walking order, no repeated end) into open
 * runs leaving 2-3 gaps of `tabW`. Bridges avoid corners: a gap that would
 * straddle a corner moves to the middle of the nearest straight run.
 * Returns an array of vertex arrays, or null when the ring is too short.
 */
function splitLoop(ring, tabW) {
  const n = ring.length;
  const seg = [];
  const at = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    at.push(total);
    const d = dist2(ring[i], ring[(i + 1) % n]);
    seg.push(d);
    total += d;
  }
  const tabs = total < 200 ? 2 : 3;
  if (total < tabs * (tabW + 5)) return null;

  const corners = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const a1 = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = TWO_PI - d;
    if (d > (CORNER_DEG * Math.PI) / 180) corners.push(at[i]);
  }
  corners.sort((a, b) => a - b);
  const keepOut = tabW / 2 + 1.5;
  const placeTab = (s) => {
    if (corners.length === 0 || !corners.some((c) => ringDist(c, s, total) < keepOut)) return s;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = i + 1 < corners.length ? corners[i + 1] : corners[0] + total;
      if (b - a < tabW + 2 * keepOut) continue;
      const mid = ((a + b) / 2) % total;
      const d = ringDist(mid, s, total);
      if (d < bestD) {
        bestD = d;
        best = mid;
      }
    }
    return best === null ? s : best;
  };
  let tabAt = [];
  for (let k = 0; k < tabs; k++) tabAt.push(placeTab(((k + 0.5) * total) / tabs));
  tabAt.sort((a, b) => a - b);
  tabAt = tabAt.filter((v, i) => i === 0 || v - tabAt[i - 1] > tabW + 2);
  if (tabAt.length < 2) {
    tabAt = [];
    for (let k = 0; k < tabs; k++) tabAt.push(((k + 0.5) * total) / tabs);
  }

  const pointAt = (s) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (s <= acc + seg[i] + 1e-9 || i === n - 1) {
        const t = seg[i] > 1e-12 ? Math.min(1, Math.max(0, (s - acc) / seg[i])) : 0;
        const p = ring[i];
        const q = ring[(i + 1) % n];
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      }
      acc += seg[i];
    }
    return ring[0];
  };
  const runs = [];
  const m = tabAt.length;
  for (let k = 0; k < m; k++) {
    const s0 = tabAt[k] + tabW / 2;
    const s1 = (k + 1 < m ? tabAt[k + 1] : tabAt[0] + total) - tabW / 2;
    const verts = [];
    const push = (p) => {
      const last = verts[verts.length - 1];
      if (last && Math.hypot(last.x - p[0], last.y - p[1]) < 1e-6) return;
      verts.push({ x: p[0], y: p[1], bulge: 0 });
    };
    push(pointAt(s0 % total));
    for (let i = 0; i < n; i++) if (at[i] > s0 + 1e-9 && at[i] < s1 - 1e-9) push(ring[i]);
    for (let i = 0; i < n; i++) if (at[i] + total > s0 + 1e-9 && at[i] + total < s1 - 1e-9) push(ring[i]);
    push(pointAt(s1 % total));
    if (verts.length >= 2) runs.push(verts);
  }
  return runs.length >= 1 ? runs : null;
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
 * Plain-language data for an unplaced part: how big the best free hole is,
 * how many mm the part misses by, and whether a slightly smaller gap would
 * have fit more. Works on the UNIT the packer tried (a duo block for paired
 * parts) and honours the rotation lock. Null when everything was placed.
 */
function whyNotHint(res, opts) {
  if (!res || !Array.isArray(res.unplaced) || res.unplaced.length === 0) return null;
  const parts = opts.parts || [];
  const gap = Number.isFinite(opts.gap) ? opts.gap : 8;
  const allowRotate = opts.allowRotate !== false;
  const { units } = buildUnits(parts, gap);
  let target = null;
  for (const u of res.unplaced) {
    for (const c of units) {
      if (!c.members.some((m) => m.part.id === u.id)) continue;
      if (!target || c.w * c.h > target.w * target.h) target = c;
    }
  }
  if (!target) return null;
  const part = target.members[0].part;
  const canTurn = allowRotate && !target.noRotate;
  let missing = null;
  let free = null;
  for (const r of res.freeRects || []) {
    const upright = Math.max(target.w - r.w, target.h - r.h, 0);
    const turned = canTurn ? Math.max(target.h - r.w, target.w - r.h, 0) : Infinity;
    const m = Math.min(upright, turned);
    if (missing === null || m < missing) {
      missing = m;
      free = r;
    }
  }
  if (missing !== null) missing = Math.round(missing * 10) / 10;
  const base = unplacedTotal(res);
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
  const r1 = (n) => Math.round(n * 10) / 10;
  return {
    partId: part.id,
    partName: part.name + (target.members.length > 1 ? ' (u paru)' : ''),
    partW: r1(target.w),
    partH: r1(target.h),
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
    fillSet: u.fillSet,
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
 *   [stisnuto?] + [prioriteti, krupno] + [naknap?]
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

  // The "sitni komadi" (small-first) sheet was dropped in 1.5.1 - the shop
  // never picked it; the small-first order still serves the na-knap probes.
  const defs = [
    { variant: 'prioriteti', variantLabel: 'Po prioritetima', order: 'priority' },
    { variant: 'krupno', variantLabel: 'Krupni komadi', order: 'big' },
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
    extraLines = [], tabsMax = 0, tabbed = null,
  } = opts;
  const cache = {};
  const layerColors = {};
  // Entries from 1.5.0 on carry the exact list of tabbed parts; older ones
  // fall back to the threshold rule.
  const tabbedSet = Array.isArray(tabbed) ? new Set(tabbed) : null;
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
      if (tabbedSet ? tabbedSet.has(p.id) : wantsTabs(p, tabsMax)) {
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
