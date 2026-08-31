'use strict';

/*
 * Priority-driven sheet nesting.
 *
 * Parts are packed by their (pre-rotated, tightest) bounding rectangles using
 * the MaxRects algorithm with the Best-Short-Side-Fit heuristic - fast enough
 * to feel instant even with hundreds of parts. Rotation by 90 degrees is
 * allowed; mirroring is impossible by construction (the packer only ever
 * swaps width/height, and downstream DXF transforms are rigid rotations).
 *
 * Placement strategy, matching the shop workflow:
 *   1. "Fixed" parts: exact requested count, placed in priority order
 *      (priority 1 = highest), bigger area first within the same priority.
 *      Whatever does not fit is reported as unplaced.
 *   2. "Filler" parts: after the fixed parts, remaining space is filled
 *      greedily, again in priority order, until nothing fits any more
 *      (optionally capped per part).
 */

const EPS = 1e-7;

class MaxRectsBin {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  /**
   * Try to place a w x h rectangle. Returns {x, y, w, h, rotated} or null.
   */
  insert(w, h, allowRotate) {
    let best = null;
    for (const r of this.free) {
      if (w <= r.w + EPS && h <= r.h + EPS) {
        const shortFit = Math.min(r.w - w, r.h - h);
        const longFit = Math.max(r.w - w, r.h - h);
        if (!best || shortFit < best.shortFit - EPS
          || (Math.abs(shortFit - best.shortFit) <= EPS && longFit < best.longFit - EPS)) {
          best = { x: r.x, y: r.y, w, h, rotated: false, shortFit, longFit };
        }
      }
      if (allowRotate && h <= r.w + EPS && w <= r.h + EPS && Math.abs(w - h) > EPS) {
        const shortFit = Math.min(r.w - h, r.h - w);
        const longFit = Math.max(r.w - h, r.h - w);
        if (!best || shortFit < best.shortFit - EPS
          || (Math.abs(shortFit - best.shortFit) <= EPS && longFit < best.longFit - EPS)) {
          best = { x: r.x, y: r.y, w: h, h: w, rotated: true, shortFit, longFit };
        }
      }
    }
    if (!best) return null;
    const node = { x: best.x, y: best.y, w: best.w, h: best.h, rotated: best.rotated };
    this._place(node);
    return node;
  }

  _place(node) {
    const next = [];
    for (const r of this.free) {
      if (!this._split(r, node, next)) next.push(r);
    }
    this.free = this._prune(next);
  }

  /** Split free rect r against the placed node; push remainders into out. */
  _split(r, node, out) {
    if (node.x >= r.x + r.w - EPS || node.x + node.w <= r.x + EPS
      || node.y >= r.y + r.h - EPS || node.y + node.h <= r.y + EPS) {
      return false; // no overlap
    }
    // Left remainder
    if (node.x > r.x + EPS) {
      out.push({ x: r.x, y: r.y, w: node.x - r.x, h: r.h });
    }
    // Right remainder
    if (node.x + node.w < r.x + r.w - EPS) {
      out.push({ x: node.x + node.w, y: r.y, w: (r.x + r.w) - (node.x + node.w), h: r.h });
    }
    // Bottom remainder
    if (node.y > r.y + EPS) {
      out.push({ x: r.x, y: r.y, w: r.w, h: node.y - r.y });
    }
    // Top remainder
    if (node.y + node.h < r.y + r.h - EPS) {
      out.push({ x: r.x, y: node.y + node.h, w: r.w, h: (r.y + r.h) - (node.y + node.h) });
    }
    return true;
  }

  _prune(rects) {
    const keep = [];
    for (let i = 0; i < rects.length; i++) {
      let contained = false;
      for (let j = 0; j < rects.length && !contained; j++) {
        if (i === j) continue;
        const a = rects[i];
        const b = rects[j];
        const containsAB = a.x >= b.x - EPS && a.y >= b.y - EPS
          && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS;
        if (containsAB) {
          // On exact ties keep the lower-index rect only.
          const containsBA = b.x >= a.x - EPS && b.y >= a.y - EPS
            && b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS;
          if (!containsBA || j < i) contained = true;
        }
      }
      if (!contained) keep.push(rects[i]);
    }
    return keep;
  }
}

/**
 * Nest parts onto a sheet.
 *
 * @param {object} opts
 * @param {number} opts.sheetW  sheet length along X (mm)
 * @param {number} opts.sheetH  sheet width along Y (mm)
 * @param {number} opts.margin  clearance from the sheet edge (mm)
 * @param {number} opts.gap     minimum clearance between parts (mm)
 * @param {boolean} [opts.allowRotate=true] allow 90-degree rotation
 * @param {number} [opts.maxTotal=5000] safety cap on total placed instances
 * @param {Array} opts.parts  [{id, w, h, area, priority, mode:'fixed'|'filler',
 *                             count, maxCount}]
 *   - w/h are the part's tight bounding box (pre-rotated), WITHOUT gap
 *   - count: requested count for fixed parts
 *   - maxCount: cap for filler parts (0 or missing = unlimited)
 *
 * @returns {{placements:Array, unplaced:Array, utilization:number,
 *            placedCounts:Object}}
 *   placements: [{id, x, y, rotated, w, h}] - x/y is the bottom-left corner
 *   of the part's bounding box on the sheet (sheet origin bottom-left).
 */
function nestParts(opts) {
  const {
    sheetW, sheetH, margin = 0, gap = 0,
    allowRotate = true, maxTotal = 20000, parts = [],
  } = opts;

  if (!(sheetW > 0) || !(sheetH > 0)) {
    throw new Error('Dimenzije ploče moraju biti veće od nule.');
  }
  const usableW = sheetW - 2 * margin + gap;
  const usableH = sheetH - 2 * margin + gap;
  if (usableW <= gap || usableH <= gap) {
    throw new Error('Ploča je premala za zadani rub.');
  }

  const bin = new MaxRectsBin(usableW, usableH);
  const placements = [];
  const unplaced = [];
  const placedCounts = {};
  let placedArea = 0;
  let total = 0;
  let capped = false; // true when the safety cap cut placement short

  const byPriorityThenArea = (a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 999;
    const pb = Number.isFinite(b.priority) ? b.priority : 999;
    if (pa !== pb) return pa - pb; // 1 = highest priority
    return (b.w * b.h) - (a.w * a.h); // bigger first
  };

  const tryPlace = (part) => {
    const node = bin.insert(part.w + gap, part.h + gap, allowRotate);
    if (!node) return false;
    placements.push({
      id: part.id,
      x: margin + node.x,
      y: margin + node.y,
      rotated: node.rotated,
      w: (node.rotated ? part.h : part.w),
      h: (node.rotated ? part.w : part.h),
    });
    placedCounts[part.id] = (placedCounts[part.id] || 0) + 1;
    placedArea += Number.isFinite(part.area) && part.area > 0 ? part.area : part.w * part.h;
    total += 1;
    return true;
  };

  // 1. Fixed parts
  const fixed = parts.filter((p) => p.mode !== 'filler').slice().sort(byPriorityThenArea);
  for (const part of fixed) {
    const want = Math.max(0, Math.floor(part.count || 0));
    let missed = 0;
    for (let k = 0; k < want; k++) {
      if (total >= maxTotal) {
        capped = true;
        missed = want - k;
        break;
      }
      if (!tryPlace(part)) {
        missed = want - k;
        break;
      }
    }
    if (missed > 0) unplaced.push({ id: part.id, count: missed });
  }

  // 2. Filler parts, in priority order: fill with the most important first.
  const fillers = parts.filter((p) => p.mode === 'filler').slice().sort(byPriorityThenArea);
  for (const part of fillers) {
    const cap = part.maxCount && part.maxCount > 0 ? Math.floor(part.maxCount) : Infinity;
    let placed = placedCounts[part.id] || 0;
    while (placed < cap) {
      if (total >= maxTotal) {
        capped = true;
        break;
      }
      if (!tryPlace(part)) break;
      placed += 1;
    }
  }

  return {
    placements,
    unplaced,
    utilization: placedArea / (sheetW * sheetH),
    placedCounts,
    capped,
    maxTotal,
  };
}

module.exports = { MaxRectsBin, nestParts };
