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
  /**
   * @param {string} [heuristic='bssf'] placement scoring:
   *   'bssf' best short side fit, 'baf' best area fit, 'bl' bottom-left.
   */
  constructor(width, height, heuristic) {
    this.width = width;
    this.height = height;
    this.heuristic = heuristic || 'bssf';
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  _score(r, w, h) {
    const shortFit = Math.min(r.w - w, r.h - h);
    const longFit = Math.max(r.w - w, r.h - h);
    switch (this.heuristic) {
      case 'baf': return [r.w * r.h - w * h, shortFit];
      case 'bl': return [r.y, r.x];
      default: return [shortFit, longFit];
    }
  }

  /**
   * Try to place a w x h rectangle. Returns {x, y, w, h, rotated} or null.
   */
  insert(w, h, allowRotate) {
    let best = null;
    const consider = (r, pw, ph, rotated) => {
      const key = this._score(r, pw, ph);
      if (!best || key[0] < best.key[0] - EPS
        || (Math.abs(key[0] - best.key[0]) <= EPS && key[1] < best.key[1] - EPS)) {
        best = { x: r.x, y: r.y, w: pw, h: ph, rotated, key };
      }
    };
    for (const r of this.free) {
      if (w <= r.w + EPS && h <= r.h + EPS) consider(r, w, h, false);
      if (allowRotate && h <= r.w + EPS && w <= r.h + EPS && Math.abs(w - h) > EPS) {
        consider(r, h, w, true);
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

  /** Mark a rectangle (bin coords) as occupied - e.g. a keep-out zone. */
  block(rect) {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.w);
    const y1 = Math.min(this.height, rect.y + rect.h);
    if (x1 - x0 <= EPS || y1 - y0 <= EPS) return;
    this._place({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  /** Offer an extra free rectangle (bin coords) - e.g. a part's big cut-out. */
  addFree(rect) {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.w);
    const y1 = Math.min(this.height, rect.y + rect.h);
    if (x1 - x0 <= EPS || y1 - y0 <= EPS) return;
    this.free.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    this.free = this._prune(this.free);
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
 * @param {Array} [opts.blocked] keep-out rectangles in sheet coords [{x,y,w,h}]
 * @param {Array} opts.parts  [{id, w, h, area, priority, mode:'fixed'|'filler',
 *                             count, maxCount, noRotate?, holes?}]
 *   - w/h are the part's tight bounding box (pre-rotated), WITHOUT gap
 *   - count: requested count for fixed parts
 *   - maxCount: cap for filler parts (0 or missing = unlimited)
 *   - noRotate: never turn this part 90 degrees
 *   - holes: part-local rectangles inside big cut-outs, offered as free
 *     space once the part is placed
 *
 * @returns {{placements:Array, unplaced:Array, utilization:number,
 *            placedCounts:Object}}
 *   placements: [{id, x, y, rotated, w, h}] - x/y is the bottom-left corner
 *   of the part's bounding box on the sheet (sheet origin bottom-left).
 */
function nestParts(opts) {
  const {
    sheetW, sheetH, margin = 0, gap = 0,
    allowRotate = true, maxTotal = 20000, parts = [], order = 'priority',
    heuristic = 'bssf', rng = null, blocked = [],
  } = opts;

  if (!(sheetW > 0) || !(sheetH > 0)) {
    throw new Error('Dimenzije ploče moraju biti veće od nule.');
  }
  const usableW = sheetW - 2 * margin + gap;
  const usableH = sheetH - 2 * margin + gap;
  if (usableW <= gap || usableH <= gap) {
    throw new Error('Ploča je premala za zadani rub.');
  }

  const bin = new MaxRectsBin(usableW, usableH, heuristic);
  // Keep-out zones ("ne diraj": a scratched corner, a test-cut hole...) are
  // given in sheet coordinates and carved out before anything is placed.
  for (const z of blocked) {
    if (z && z.w > 0 && z.h > 0) bin.block({ x: z.x - margin, y: z.y - margin, w: z.w, h: z.h });
  }
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
  const byAreaDesc = (a, b) => (b.w * b.h) - (a.w * a.h);
  const byAreaAsc = (a, b) => (a.w * a.h) - (b.w * b.h);
  // Alternative fill orders produce the "other" sheet variants:
  //   'big'   - priorities ignored, biggest parts first
  //   'small' - fillers flood the sheet first (small parts up), fixed after
  const fixedCmp = order === 'priority' ? byPriorityThenArea : byAreaDesc;
  const fillerCmp = order === 'small' ? byAreaAsc : (order === 'big' ? byAreaDesc : byPriorityThenArea);
  const fillersFirst = order === 'small';

  // Optional randomness for the dense multi-restart search. Priorities stay
  // hard boundaries for fixed parts AND fillers: both are only shuffled
  // WITHIN the same priority group.
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  const shuffleWithinPriority = (arr) => {
    const groups = new Map();
    for (const p of arr) {
      const key = Number.isFinite(p.priority) ? p.priority : 999;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const out = [];
    for (const key of Array.from(groups.keys()).sort((a, b) => a - b)) {
      out.push(...shuffle(groups.get(key)));
    }
    return out;
  };

  const tryPlace = (part) => {
    // Per-part rotation lock (grain direction on brushed/foiled sheet).
    const node = bin.insert(part.w + gap, part.h + gap, allowRotate && !part.noRotate);
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
    // A big cut-out inside the placed part becomes free space for the parts
    // that follow (nesting inside holes). Hole rects are part-local (bbox
    // corner = origin); a 90-degree unit turn maps (x,y) -> (h - y, x).
    if (Array.isArray(part.holes)) {
      for (const hh of part.holes) {
        const r = node.rotated
          ? { x: node.x + (part.h - hh.y - hh.h), y: node.y + hh.x, w: hh.h, h: hh.w }
          : { x: node.x + hh.x, y: node.y + hh.y, w: hh.w, h: hh.h };
        // Gap on all four sides: the packer's rects carry +gap on top/right
        // only, so shift by gap and shrink by gap.
        bin.addFree({ x: r.x + gap, y: r.y + gap, w: r.w - gap, h: r.h - gap });
      }
    }
    return true;
  };

  const placeFixed = () => {
    let fixed = parts.filter((p) => p.mode !== 'filler').slice().sort(fixedCmp);
    if (rng) {
      fixed = order === 'priority' ? shuffleWithinPriority(fixed) : shuffle(fixed);
    }
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
  };

  const placeFillers = () => {
    let fillers = parts.filter((p) => p.mode === 'filler').slice().sort(fillerCmp);
    if (rng) fillers = shuffleWithinPriority(fillers);
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
  };

  if (fillersFirst) {
    placeFillers();
    placeFixed();
  } else {
    placeFixed();
    placeFillers();
  }

  // Leftover free space in sheet coordinates, sized as the biggest part
  // (without gap) that would still fit there - for the "why didn't it fit"
  // explainer. Largest first, capped to keep history entries small.
  const r1 = (n) => Math.round(n * 10) / 10;
  const freeRects = bin.free
    .map((r) => ({ x: margin + r.x, y: margin + r.y, w: r.w - gap, h: r.h - gap }))
    .filter((r) => r.w > 0.5 && r.h > 0.5)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 12)
    .map((r) => ({ x: r1(r.x), y: r1(r.y), w: r1(r.w), h: r1(r.h) }));

  return {
    placements,
    unplaced,
    utilization: placedArea / (sheetW * sheetH),
    placedCounts,
    capped,
    maxTotal,
    freeRects,
  };
}

module.exports = { MaxRectsBin, nestParts };
