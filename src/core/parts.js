'use strict';

/*
 * Part analysis (on import) and sheet generation (on "GENERIRAJ").
 * Pure functions - no filesystem access - so they are testable in plain Node
 * and reusable in a browser build later.
 */

const { parseDxf, writeDxf, transformEntity, sampleEntities } = require('./dxf');
const { minAreaRect, bboxOfPoints, rotatePoints, convexHull, polygonArea } = require('./geometry');
const { nestParts } = require('./nest');

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

  const outline = rotatedPolys.map((poly) => decimate(
    poly.map(([x, y]) => [round3(x - bb.minX), round3(y - bb.minY)]),
    120,
  ));

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
    warnings,
    entityCount: entities.length,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function decimate(pts, maxPts) {
  if (pts.length <= maxPts) return pts;
  const out = [];
  const step = (pts.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) {
    out.push(pts[Math.round(i * step)]);
  }
  return out;
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
  } = opts;

  const nest = nestParts({
    sheetW,
    sheetH,
    margin,
    gap,
    allowRotate,
    maxTotal,
    parts: parts.map((p) => ({
      id: p.id,
      w: p.w,
      h: p.h,
      area: p.area,
      priority: p.priority,
      mode: p.mode,
      count: p.count,
      maxCount: p.maxCount,
    })),
  });

  // Cache per part: parsed entities + high-quality samples + per-orientation
  // data (rotated bbox min and transformed entities are per placement).
  const cache = {};
  const getPart = (id) => {
    if (!cache[id]) {
      const p = parts.find((q) => q.id === id);
      if (!p) throw new Error('Nepoznat part id: ' + id);
      const { entities } = parseDxf(p.content);
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

  for (const pl of nest.placements) {
    const c = getPart(pl.id);
    const rotDeg = (c.part.preRotDeg || 0) + (pl.rotated ? 90 : 0);
    const or = getOrientation(pl.id, rotDeg);
    const dx = pl.x - or.bb.minX;
    const dy = pl.y - or.bb.minY;

    for (const e of c.entities) {
      outEntities.push(transformEntity(e, { rotDeg, dx, dy }));
    }

    placements.push({
      id: pl.id,
      name: c.part.name,
      x: pl.x,
      y: pl.y,
      w: pl.w,
      h: pl.h,
      rotated: pl.rotated,
      outline: or.rotated.map((poly) => decimate(
        poly.map(([x, y]) => [round3(x + dx), round3(y + dy)]),
        80,
      )),
    });
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
  for (const id of Object.keys(nest.placedCounts)) {
    const c = getPart(id);
    summary.push({ id, name: c.part.name, count: nest.placedCounts[id] });
  }
  summary.sort((a, b) => b.count - a.count);

  const unplaced = nest.unplaced.map((u) => {
    const p = parts.find((q) => q.id === u.id);
    return { id: u.id, name: p ? p.name : u.id, count: u.count };
  });

  return {
    dxf: outEntities.length > 0 ? writeDxf(outEntities) : null,
    placements,
    unplaced,
    placedCounts: nest.placedCounts,
    utilization: nest.utilization,
    totalPlaced: nest.placements.length,
    summary,
    capped: nest.capped,
    maxTotal: nest.maxTotal,
  };
}

module.exports = { analyzePart, generateSheet };
