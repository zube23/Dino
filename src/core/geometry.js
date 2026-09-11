'use strict';

/*
 * Small 2D geometry helpers: bounding boxes, convex hull, minimal-area
 * bounding rectangle (used to pre-rotate parts into their tightest
 * orientation before rectangle packing).
 */

const DEG = Math.PI / 180;

function rotatePoint(x, y, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function rotatePoints(pts, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

function bboxOfPoints(pts) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Monotone chain convex hull. Returns CCW hull without repeated last point. */
function convexHull(points) {
  const pts = points
    .slice()
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  // Dedupe
  const uniq = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Signed area of a polygon (positive = CCW). */
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Find the rotation (in degrees) that minimizes the area of the axis-aligned
 * bounding box of the given points. The optimal rectangle is aligned with
 * some edge of the convex hull, so only hull-edge angles are tested.
 * @returns {{angleDeg:number, w:number, h:number}} rotate points BY angleDeg
 *          to obtain the minimal box of size w x h.
 */
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 0) return { angleDeg: 0, w: 0, h: 0 };
  if (hull.length === 1) return { angleDeg: 0, w: 0, h: 0 };

  let best = null;
  const candidates = [];
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const edgeAngle = Math.atan2(y2 - y1, x2 - x1) / DEG;
    candidates.push(-edgeAngle);
  }
  candidates.push(0); // always consider the original orientation too
  for (const angle of candidates) {
    const rotated = rotatePoints(hull, angle);
    const bb = bboxOfPoints(rotated);
    const area = bb.w * bb.h;
    if (!best || area < best.area - 1e-9) {
      best = { area, angleDeg: normDeg(angle), w: bb.w, h: bb.h };
    }
  }
  return { angleDeg: best.angleDeg, w: best.w, h: best.h };
}

function normDeg(a) {
  let r = a % 360;
  if (r < 0) r += 360;
  return r;
}

/**
 * Douglas-Peucker polyline simplification: removes points whose removal
 * moves the curve by less than `eps`. Unlike every-Nth decimation this
 * preserves corners and detail exactly, dropping only redundant points on
 * straight-ish runs.
 */
function simplifyPolyline(pts, eps) {
  if (!Array.isArray(pts) || pts.length <= 2 || !(eps > 0)) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len < 1e-12) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        d = Math.abs(dx * (ay - py) - (ax - px) * dy) / len;
      }
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > eps) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Even-odd point-in-polygon test. `poly` may or may not repeat its first point. */
function pointInPolygon(x, y, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y)) {
      const xc = xi + ((y - yi) * (xj - xi)) / (yj - yi);
      if (x < xc) inside = !inside;
    }
  }
  return inside;
}

/**
 * Largest axis-aligned rectangle that fits inside a closed polygon (used to
 * turn a part's big cut-out into free nesting space). Grid-based: the
 * polygon is rasterized at ~1/96 of its longer side, the largest all-inside
 * block is found with the histogram method, and the result is shrunk by one
 * cell on every side so it is guaranteed to lie inside the true outline.
 * Returns {x, y, w, h} or null when nothing usable fits.
 */
function maxInscribedRect(poly, minSize) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const bb = bboxOfPoints(poly);
  if (!(bb.w > 0) || !(bb.h > 0)) return null;
  const cs = Math.max(bb.w, bb.h) / 96;
  const cols = Math.max(1, Math.ceil(bb.w / cs));
  const rows = Math.max(1, Math.ceil(bb.h / cs));
  const inside = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = bb.minY + (r + 0.5) * cs;
    for (let c = 0; c < cols; c++) {
      const x = bb.minX + (c + 0.5) * cs;
      if (pointInPolygon(x, y, poly)) inside[r * cols + c] = 1;
    }
  }
  // Maximal rectangle in a binary matrix via per-row histograms.
  const heights = new Int32Array(cols);
  let best = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = inside[r * cols + c] ? heights[c] + 1 : 0;
    const stack = [];
    for (let c = 0; c <= cols; c++) {
      const h = c < cols ? heights[c] : 0;
      let start = c;
      while (stack.length && stack[stack.length - 1].h >= h) {
        const top = stack.pop();
        const area = top.h * (c - top.start);
        if (!best || area > best.area) {
          best = { area, c0: top.start, c1: c - 1, r0: r - top.h + 1, r1: r };
        }
        start = top.start;
      }
      stack.push({ start, h });
    }
  }
  if (!best) return null;
  // One-cell safety shrink on every side.
  const x = bb.minX + (best.c0 + 1) * cs;
  const y = bb.minY + (best.r0 + 1) * cs;
  const w = (best.c1 - best.c0 - 1) * cs;
  const h = (best.r1 - best.r0 - 1) * cs;
  const min = minSize > 0 ? minSize : 0;
  if (!(w >= min) || !(h >= min) || w <= 0 || h <= 0) return null;
  const r1 = (n) => Math.round(n * 10) / 10;
  return { x: r1(x), y: r1(y), w: r1(w), h: r1(h) };
}

module.exports = {
  rotatePoint,
  rotatePoints,
  bboxOfPoints,
  convexHull,
  polygonArea,
  minAreaRect,
  normDeg,
  simplifyPolyline,
  pointInPolygon,
  maxInscribedRect,
};
