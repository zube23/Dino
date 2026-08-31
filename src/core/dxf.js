'use strict';

/*
 * Minimal, dependency-free DXF reader/writer for 2D laser-cutting profiles.
 *
 * Reading: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE/VERTEX, SPLINE, ELLIPSE,
 * POINT and INSERT (expanded from BLOCKS, uniform positive scale only).
 * Entities are normalized into a small internal model (see below).
 *
 * Writing: emits DXF R12 (AC1009) for maximum CAM compatibility. Splines and
 * ellipses are flattened to fine polylines at write time (laser CAM programs
 * generally prefer that anyway); lines, arcs, circles and polylines with
 * bulges are written natively.
 *
 * Transforms are restricted to rotation + translation + uniform positive
 * scale, so a mirrored placement is structurally impossible.
 *
 * Internal entity model (all coordinates in drawing units, angles in degrees
 * unless noted):
 *   {type:'LINE',     layer, x1,y1, x2,y2}
 *   {type:'CIRCLE',   layer, cx,cy, r}
 *   {type:'ARC',      layer, cx,cy, r, a1,a2}          // CCW from a1 to a2
 *   {type:'POLYLINE', layer, closed, verts:[{x,y,bulge}]}
 *   {type:'SPLINE',   layer, degree, closed, knots:[], weights:[],
 *                     ctrl:[{x,y}], fit:[{x,y}]}
 *   {type:'ELLIPSE',  layer, cx,cy, mx,my, ratio, t1,t2} // params in radians
 *   {type:'POINT',    layer, x,y}
 */

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

function parsePairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (codeStr === '') {
      // Tolerate stray blank lines by resyncing on the next line.
      i -= 1;
      continue;
    }
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1] === undefined ? '' : lines[i + 1].trim() });
  }
  return pairs;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isBinaryDxf(text) {
  return typeof text === 'string' && text.slice(0, 22).indexOf('AutoCAD Binary DXF') !== -1;
}

/**
 * Parse a DXF string.
 * @returns {{entities: Array, warnings: string[]}}
 */
function parseDxf(text) {
  if (isBinaryDxf(text)) {
    throw new Error('Binarni DXF nije podržan - spremite datoteku kao ASCII DXF.');
  }
  const pairs = parsePairs(text);
  const warnings = [];
  const blocks = {}; // name -> {baseX, baseY, entities}
  let entities = [];

  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'SECTION') {
      const namePair = pairs[i + 1];
      const section = namePair && namePair.code === 2 ? namePair.value : '';
      i += 2;
      if (section === 'BLOCKS') {
        i = parseBlocksSection(pairs, i, blocks, warnings);
      } else if (section === 'ENTITIES') {
        const res = parseEntityList(pairs, i, 'ENDSEC', warnings);
        entities = res.entities;
        i = res.next;
      } else {
        // Skip section
        while (i < pairs.length && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) i++;
      }
      // consume ENDSEC
      while (i < pairs.length && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) i++;
      i++;
    } else {
      i++;
    }
  }

  // Expand INSERT entities using the parsed blocks.
  const expanded = [];
  for (const e of entities) {
    if (e.type === 'INSERT') {
      expandInsert(e, blocks, expanded, warnings, 0);
    } else {
      expanded.push(e);
    }
  }
  return { entities: expanded, warnings };
}

function parseBlocksSection(pairs, i, blocks, warnings) {
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'ENDSEC') return i;
    if (p.code === 0 && p.value === 'BLOCK') {
      i++;
      let name = '';
      let baseX = 0;
      let baseY = 0;
      // Block header: codes until first entity (code 0) or ENDBLK
      while (i < pairs.length && pairs[i].code !== 0) {
        const q = pairs[i];
        if (q.code === 2) name = q.value;
        else if (q.code === 10) baseX = num(q.value);
        else if (q.code === 20) baseY = num(q.value);
        i++;
      }
      const res = parseEntityList(pairs, i, 'ENDBLK', warnings);
      i = res.next;
      // consume ENDBLK entity (skip its codes)
      if (i < pairs.length && pairs[i].code === 0 && pairs[i].value === 'ENDBLK') {
        i++;
        while (i < pairs.length && pairs[i].code !== 0) i++;
      }
      if (name) blocks[name] = { baseX, baseY, entities: res.entities };
    } else {
      i++;
    }
  }
  return i;
}

/**
 * Parse a run of entities until `0 <endMarker>`.
 * Returns {entities, next} where next points AT the end marker pair.
 */
function parseEntityList(pairs, i, endMarker, warnings) {
  const entities = [];
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && (p.value === endMarker || p.value === 'ENDSEC')) {
      return { entities, next: i };
    }
    if (p.code === 0) {
      const res = parseEntity(pairs, i, warnings);
      if (res.entity) entities.push(res.entity);
      i = res.next;
    } else {
      i++;
    }
  }
  return { entities, next: i };
}

const SKIPPED_TYPES = new Set([
  'TEXT', 'MTEXT', 'DIMENSION', 'HATCH', 'SOLID', 'ATTRIB', 'ATTDEF',
  'LEADER', 'MLEADER', 'WIPEOUT', 'IMAGE', 'VIEWPORT', 'XLINE', 'RAY',
  '3DFACE', 'REGION', 'BODY', 'TRACE', 'TOLERANCE', 'OLE2FRAME', 'ACAD_PROXY_ENTITY',
]);

function parseEntity(pairs, i, warnings) {
  const type = pairs[i].value;
  i++;
  // Collect this entity's codes (until next code 0)
  const codes = [];
  while (i < pairs.length && pairs[i].code !== 0) {
    codes.push(pairs[i]);
    i++;
  }

  const get = (code, dflt) => {
    for (const c of codes) if (c.code === code) return c.value;
    return dflt;
  };
  const layer = String(get(8, '0'));

  switch (type) {
    case 'LINE':
      return {
        entity: {
          type: 'LINE', layer,
          x1: num(get(10, 0)), y1: num(get(20, 0)),
          x2: num(get(11, 0)), y2: num(get(21, 0)),
        },
        next: i,
      };
    case 'CIRCLE':
      return {
        entity: {
          type: 'CIRCLE', layer,
          cx: num(get(10, 0)), cy: num(get(20, 0)), r: num(get(40, 0)),
        },
        next: i,
      };
    case 'ARC':
      return {
        entity: {
          type: 'ARC', layer,
          cx: num(get(10, 0)), cy: num(get(20, 0)), r: num(get(40, 0)),
          a1: num(get(50, 0)), a2: num(get(51, 0)),
        },
        next: i,
      };
    case 'LWPOLYLINE': {
      const verts = [];
      let closed = (parseInt(get(70, '0'), 10) & 1) === 1;
      let cur = null;
      for (const c of codes) {
        if (c.code === 10) {
          cur = { x: num(c.value), y: 0, bulge: 0 };
          verts.push(cur);
        } else if (c.code === 20 && cur) {
          cur.y = num(c.value);
        } else if (c.code === 42 && cur) {
          cur.bulge = num(c.value);
        }
      }
      return { entity: { type: 'POLYLINE', layer, closed, verts }, next: i };
    }
    case 'POLYLINE': {
      const flags = parseInt(get(70, '0'), 10);
      const closed = (flags & 1) === 1;
      const is3dOrMesh = (flags & (8 | 16 | 32 | 64)) !== 0;
      const verts = [];
      // Vertices follow as separate VERTEX entities until SEQEND.
      while (i < pairs.length) {
        const p = pairs[i];
        if (p.code === 0 && p.value === 'VERTEX') {
          i++;
          let x = 0; let y = 0; let bulge = 0; let vflags = 0;
          let hasX = false;
          while (i < pairs.length && pairs[i].code !== 0) {
            const c = pairs[i];
            if (c.code === 10) { x = num(c.value); hasX = true; }
            else if (c.code === 20) y = num(c.value);
            else if (c.code === 42) bulge = num(c.value);
            else if (c.code === 70) vflags = parseInt(c.value, 10) || 0;
            i++;
          }
          // Skip spline-frame control points (flag 16) - keep fitted/plain ones.
          if (hasX && (vflags & 16) === 0) verts.push({ x, y, bulge });
        } else if (p.code === 0 && p.value === 'SEQEND') {
          i++;
          while (i < pairs.length && pairs[i].code !== 0) i++;
          break;
        } else if (p.code === 0) {
          break; // malformed: next entity without SEQEND
        } else {
          i++;
        }
      }
      if (is3dOrMesh) {
        warnings.push('3D polilinija/mreža pretvorena u 2D konturu.');
      }
      return { entity: { type: 'POLYLINE', layer, closed, verts }, next: i };
    }
    case 'SPLINE': {
      const flags = parseInt(get(70, '0'), 10);
      const degree = parseInt(get(71, '3'), 10) || 3;
      const knots = [];
      const weights = [];
      const ctrl = [];
      const fit = [];
      let curCtrl = null;
      let curFit = null;
      for (const c of codes) {
        if (c.code === 40) knots.push(num(c.value));
        else if (c.code === 41) weights.push(num(c.value));
        else if (c.code === 10) { curCtrl = { x: num(c.value), y: 0 }; ctrl.push(curCtrl); }
        else if (c.code === 20 && curCtrl) curCtrl.y = num(c.value);
        else if (c.code === 11) { curFit = { x: num(c.value), y: 0 }; fit.push(curFit); }
        else if (c.code === 21 && curFit) curFit.y = num(c.value);
      }
      return {
        entity: {
          type: 'SPLINE', layer, degree,
          closed: (flags & 1) === 1,
          knots, weights, ctrl, fit,
        },
        next: i,
      };
    }
    case 'ELLIPSE':
      return {
        entity: {
          type: 'ELLIPSE', layer,
          cx: num(get(10, 0)), cy: num(get(20, 0)),
          mx: num(get(11, 0)), my: num(get(21, 0)),
          ratio: num(get(40, 1)),
          t1: num(get(41, 0)), t2: num(get(42, Math.PI * 2)),
        },
        next: i,
      };
    case 'POINT':
      return {
        entity: { type: 'POINT', layer, x: num(get(10, 0)), y: num(get(20, 0)) },
        next: i,
      };
    case 'INSERT':
      return {
        entity: {
          type: 'INSERT', layer,
          name: String(get(2, '')),
          x: num(get(10, 0)), y: num(get(20, 0)),
          sx: num(get(41, 1)), sy: num(get(42, 1)),
          rot: num(get(50, 0)),
        },
        next: i,
      };
    default:
      if (!SKIPPED_TYPES.has(type) && type !== 'VERTEX' && type !== 'SEQEND') {
        warnings.push('Nepodržan entitet preskočen: ' + type);
      } else if (SKIPPED_TYPES.has(type)) {
        warnings.push('Entitet preskočen (nije geometrija reza): ' + type);
      }
      return { entity: null, next: i };
  }
}

function expandInsert(ins, blocks, out, warnings, depth) {
  if (depth > 5) {
    warnings.push('INSERT preskočen: pregduboko ugnježđivanje blokova.');
    return;
  }
  const block = blocks[ins.name];
  if (!block) {
    warnings.push('INSERT preskočen: blok "' + ins.name + '" nije pronađen.');
    return;
  }
  const sx = ins.sx === 0 ? 1 : ins.sx;
  const sy = ins.sy === 0 ? 1 : ins.sy;
  if (sx <= 0 || sy <= 0 || Math.abs(sx - sy) > 1e-9 * Math.max(1, Math.abs(sx))) {
    warnings.push('INSERT "' + ins.name + '" preskočen: nejednoliko ili zrcalno skaliranje nije podržano.');
    return;
  }
  for (const e of block.entities) {
    if (e.type === 'INSERT') {
      // Transform the nested insert's placement, then recurse.
      const p = applyXform(e.x - block.baseX, e.y - block.baseY, sx, ins.rot, ins.x, ins.y);
      expandInsert({
        ...e,
        x: p.x,
        y: p.y,
        sx: e.sx * sx,
        sy: e.sy * sy,
        rot: e.rot + ins.rot,
      }, blocks, out, warnings, depth + 1);
    } else {
      const moved = translateEntity(cloneEntity(e), -block.baseX, -block.baseY);
      out.push(transformEntity(moved, { rotDeg: ins.rot, dx: ins.x, dy: ins.y, scale: sx }));
    }
  }
}

function applyXform(x, y, scale, rotDeg, dx, dy) {
  const a = rotDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const px = x * scale;
  const py = y * scale;
  return { x: px * c - py * s + dx, y: px * s + py * c + dy };
}

// ---------------------------------------------------------------------------
// Transforms (rigid: rotation + translation, optional uniform positive scale)
// ---------------------------------------------------------------------------

function cloneEntity(e) {
  return JSON.parse(JSON.stringify(e));
}

function translateEntity(e, dx, dy) {
  return transformEntity(e, { rotDeg: 0, dx, dy, scale: 1 });
}

/**
 * Apply p' = T + R(rotDeg) * (scale * p) to an entity. Returns a new entity.
 * scale must be > 0 - mirroring is deliberately impossible here.
 */
function transformEntity(e, { rotDeg = 0, dx = 0, dy = 0, scale = 1 }) {
  if (!(scale > 0)) throw new Error('transformEntity: scale must be positive (mirror is forbidden)');
  const xf = (x, y) => applyXform(x, y, scale, rotDeg, dx, dy);
  const out = cloneEntity(e);
  switch (e.type) {
    case 'LINE': {
      const p1 = xf(e.x1, e.y1);
      const p2 = xf(e.x2, e.y2);
      out.x1 = p1.x; out.y1 = p1.y; out.x2 = p2.x; out.y2 = p2.y;
      return out;
    }
    case 'CIRCLE': {
      const c = xf(e.cx, e.cy);
      out.cx = c.x; out.cy = c.y; out.r = e.r * scale;
      return out;
    }
    case 'ARC': {
      const c = xf(e.cx, e.cy);
      out.cx = c.x; out.cy = c.y; out.r = e.r * scale;
      out.a1 = norm360(e.a1 + rotDeg);
      out.a2 = norm360(e.a2 + rotDeg);
      return out;
    }
    case 'POLYLINE': {
      out.verts = e.verts.map((v) => {
        const p = xf(v.x, v.y);
        return { x: p.x, y: p.y, bulge: v.bulge }; // bulge invariant under rot+uniform scale
      });
      return out;
    }
    case 'SPLINE': {
      out.ctrl = e.ctrl.map((p) => xf(p.x, p.y));
      out.fit = e.fit.map((p) => xf(p.x, p.y));
      return out;
    }
    case 'ELLIPSE': {
      const c = xf(e.cx, e.cy);
      const a = rotDeg * DEG;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      out.cx = c.x; out.cy = c.y;
      out.mx = (e.mx * cs - e.my * sn) * scale;
      out.my = (e.mx * sn + e.my * cs) * scale;
      return out;
    }
    case 'POINT': {
      const p = xf(e.x, e.y);
      out.x = p.x; out.y = p.y;
      return out;
    }
    default:
      throw new Error('transformEntity: unknown entity type ' + e.type);
  }
}

function norm360(a) {
  let r = a % 360;
  if (r < 0) r += 360;
  return r;
}

// ---------------------------------------------------------------------------
// Sampling (for bounding boxes, previews and spline flattening)
// ---------------------------------------------------------------------------

/**
 * Sample an entity into one or more polylines (arrays of [x,y] points).
 * `quality` scales the point counts (1 = preview quality, 4 = write quality).
 */
function sampleEntity(e, quality = 1) {
  const q = Math.max(0.25, quality);
  switch (e.type) {
    case 'LINE':
      return [[[e.x1, e.y1], [e.x2, e.y2]]];
    case 'CIRCLE': {
      const n = Math.max(16, Math.round(32 * q));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        pts.push([e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t)]);
      }
      return [pts];
    }
    case 'ARC': {
      let a1 = e.a1 * DEG;
      let a2 = e.a2 * DEG;
      if (a2 <= a1 + 1e-12) a2 += Math.PI * 2;
      const sweep = a2 - a1;
      const n = Math.max(8, Math.round((sweep / (Math.PI * 2)) * 48 * q));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = a1 + (sweep * i) / n;
        pts.push([e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t)]);
      }
      return [pts];
    }
    case 'POLYLINE': {
      const verts = e.verts;
      if (verts.length === 0) return [];
      const pts = [[verts[0].x, verts[0].y]];
      const segCount = e.closed ? verts.length : verts.length - 1;
      for (let i = 0; i < segCount; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % verts.length];
        if (Math.abs(v1.bulge) < 1e-12) {
          pts.push([v2.x, v2.y]);
        } else {
          const arcPts = bulgeArcPoints(v1, v2, v1.bulge, q);
          for (let k = 1; k < arcPts.length; k++) pts.push(arcPts[k]);
        }
      }
      return [pts];
    }
    case 'SPLINE':
      return [sampleSpline(e, q)];
    case 'ELLIPSE': {
      let t1 = e.t1;
      let t2 = e.t2;
      if (t2 <= t1 + 1e-12) t2 += Math.PI * 2;
      const major = Math.hypot(e.mx, e.my);
      const ux = e.mx; const uy = e.my;
      const vx = -uy * e.ratio; const vy = ux * e.ratio;
      const n = Math.min(1024, Math.max(24, Math.round(((t2 - t1) / (Math.PI * 2)) * 64 * q * Math.max(1, major / 50))));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = t1 + ((t2 - t1) * i) / n;
        pts.push([
          e.cx + ux * Math.cos(t) + vx * Math.sin(t),
          e.cy + uy * Math.cos(t) + vy * Math.sin(t),
        ]);
      }
      return [pts];
    }
    case 'POINT':
      return [[[e.x, e.y]]];
    default:
      return [];
  }
}

/**
 * Points along the arc defined by two polyline vertices and a bulge value.
 * bulge = tan(includedAngle / 4); positive = CCW.
 */
function bulgeArcPoints(v1, v2, bulge, quality = 1) {
  const theta = 4 * Math.atan(bulge); // signed included angle
  const chord = Math.hypot(v2.x - v1.x, v2.y - v1.y);
  if (chord < 1e-12 || Math.abs(theta) < 1e-12) {
    return [[v1.x, v1.y], [v2.x, v2.y]];
  }
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // Center: midpoint of chord offset along the perpendicular.
  const mx = (v1.x + v2.x) / 2;
  const my = (v1.y + v2.y) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  // Perpendicular to chord direction.
  let px = -(v2.y - v1.y) / chord;
  let py = (v2.x - v1.x) / chord;
  // Minor arc (|theta| < PI): center on the left of the chord for CCW (b > 0);
  // major arc: on the right. Verified against quarter/three-quarter circles.
  const side = (Math.abs(theta) < Math.PI ? 1 : -1) * Math.sign(theta);
  const cx = mx + px * h * side;
  const cy = my + py * h * side;
  const a1 = Math.atan2(v1.y - cy, v1.x - cx);
  const n = Math.max(4, Math.round((Math.abs(theta) / (Math.PI * 2)) * 48 * Math.max(0.25, quality)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a1 + (theta * i) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  // Snap endpoints exactly.
  pts[0] = [v1.x, v1.y];
  pts[pts.length - 1] = [v2.x, v2.y];
  return pts;
}

function sampleSpline(e, quality = 1) {
  const degree = Math.max(1, e.degree || 3);
  const ctrl = e.ctrl || [];
  const knots = e.knots || [];
  const weights = (e.weights && e.weights.length === ctrl.length) ? e.weights : ctrl.map(() => 1);

  const validKnots = knots.length === ctrl.length + degree + 1 && ctrl.length > degree;
  if (!validKnots) {
    // Fallback: fit points polyline, else control polygon.
    if (e.fit && e.fit.length >= 2) return e.fit.map((p) => [p.x, p.y]);
    return ctrl.map((p) => [p.x, p.y]);
  }

  const tMin = knots[degree];
  const tMax = knots[knots.length - 1 - degree];
  const n = Math.min(2048, Math.max(24, Math.round(ctrl.length * 8 * Math.max(0.25, quality))));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = tMin + ((tMax - tMin) * i) / n;
    pts.push(deBoor(degree, ctrl, knots, weights, t));
  }
  return pts;
}

function deBoor(degree, ctrl, knots, weights, t) {
  const nCtrl = ctrl.length;
  // Find knot span k with knots[k] <= t < knots[k+1], degree <= k < nCtrl
  let k = degree;
  const hi = nCtrl - 1;
  if (t >= knots[hi + 1]) {
    k = hi;
  } else {
    while (k < hi && !(t >= knots[k] && t < knots[k + 1])) k++;
  }
  // Homogeneous de Boor
  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = k - degree + j;
    const w = weights[idx];
    d.push([ctrl[idx].x * w, ctrl[idx].y * w, w]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const idx = k - degree + j;
      const denom = knots[idx + degree - r + 1] - knots[idx];
      const alpha = denom > 1e-12 ? (t - knots[idx]) / denom : 0;
      d[j] = [
        (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
        (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
        (1 - alpha) * d[j - 1][2] + alpha * d[j][2],
      ];
    }
  }
  const w = d[degree][2];
  if (Math.abs(w) < 1e-12) return [d[degree][0], d[degree][1]];
  return [d[degree][0] / w, d[degree][1] / w];
}

/**
 * Sample all entities into polylines.
 */
function sampleEntities(entities, quality = 1) {
  const polys = [];
  for (const e of entities) {
    for (const poly of sampleEntity(e, quality)) {
      if (poly.length > 0) polys.push(poly);
    }
  }
  return polys;
}

// ---------------------------------------------------------------------------
// Writing (DXF R12 / AC1009)
// ---------------------------------------------------------------------------

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  // Avoid scientific notation and trailing zeros.
  let s = r.toFixed(6);
  s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

/**
 * Serialize entities to a DXF R12 string.
 * Splines and ellipses are flattened to polylines (chord-accurate for laser).
 */
function writeDxf(entities, opts = {}) {
  const flatten = [];
  for (const e of entities) {
    if (e.type === 'SPLINE' || e.type === 'ELLIPSE') {
      const polys = sampleEntity(e, 4);
      for (const pts of polys) {
        if (pts.length < 2) continue;
        const first = pts[0];
        const last = pts[pts.length - 1];
        const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
        const verts = (closed ? pts.slice(0, -1) : pts).map((p) => ({ x: p[0], y: p[1], bulge: 0 }));
        flatten.push({ type: 'POLYLINE', layer: e.layer || '0', closed, verts });
      }
    } else {
      flatten.push(e);
    }
  }

  // Extents
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const poly of sampleEntities(flatten, 1)) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  const layers = new Set(['0']);
  for (const e of flatten) layers.add(String(e.layer || '0'));

  const L = [];
  const push = (code, value) => { L.push(String(code)); L.push(String(value)); };

  // HEADER
  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  push(9, '$INSUNITS'); push(70, 4); // millimeters
  push(9, '$EXTMIN'); push(10, fmt(minX)); push(20, fmt(minY)); push(30, 0);
  push(9, '$EXTMAX'); push(10, fmt(maxX)); push(20, fmt(maxY)); push(30, 0);
  push(0, 'ENDSEC');

  // TABLES (layers only)
  push(0, 'SECTION'); push(2, 'TABLES');
  push(0, 'TABLE'); push(2, 'LAYER'); push(70, layers.size);
  for (const name of layers) {
    push(0, 'LAYER');
    push(2, name);
    push(70, 0);
    push(62, 7);
    push(6, 'CONTINUOUS');
  }
  push(0, 'ENDTAB');
  push(0, 'ENDSEC');

  // ENTITIES
  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const e of flatten) {
    const layer = String(e.layer || '0');
    switch (e.type) {
      case 'LINE':
        push(0, 'LINE'); push(8, layer);
        push(10, fmt(e.x1)); push(20, fmt(e.y1)); push(30, 0);
        push(11, fmt(e.x2)); push(21, fmt(e.y2)); push(31, 0);
        break;
      case 'CIRCLE':
        push(0, 'CIRCLE'); push(8, layer);
        push(10, fmt(e.cx)); push(20, fmt(e.cy)); push(30, 0);
        push(40, fmt(e.r));
        break;
      case 'ARC':
        push(0, 'ARC'); push(8, layer);
        push(10, fmt(e.cx)); push(20, fmt(e.cy)); push(30, 0);
        push(40, fmt(e.r));
        push(50, fmt(e.a1)); push(51, fmt(e.a2));
        break;
      case 'POLYLINE':
        push(0, 'POLYLINE'); push(8, layer);
        push(66, 1); push(70, e.closed ? 1 : 0);
        push(10, 0); push(20, 0); push(30, 0);
        for (const v of e.verts) {
          push(0, 'VERTEX'); push(8, layer);
          push(10, fmt(v.x)); push(20, fmt(v.y)); push(30, 0);
          if (v.bulge && Math.abs(v.bulge) > 1e-12) push(42, fmt(v.bulge));
        }
        push(0, 'SEQEND'); push(8, layer);
        break;
      case 'POINT':
        push(0, 'POINT'); push(8, layer);
        push(10, fmt(e.x)); push(20, fmt(e.y)); push(30, 0);
        break;
      default:
        break; // never happens: splines/ellipses were flattened above
    }
  }
  push(0, 'ENDSEC');
  push(0, 'EOF');

  const eol = opts.eol || '\r\n';
  return L.join(eol) + eol;
}

module.exports = {
  parseDxf,
  writeDxf,
  transformEntity,
  translateEntity,
  cloneEntity,
  sampleEntity,
  sampleEntities,
  bulgeArcPoints,
  isBinaryDxf,
  norm360,
};
