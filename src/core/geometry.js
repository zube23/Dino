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

module.exports = {
  rotatePoint,
  rotatePoints,
  bboxOfPoints,
  convexHull,
  polygonArea,
  minAreaRect,
  normDeg,
  simplifyPolyline,
};
