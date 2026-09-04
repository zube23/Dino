'use strict';

/*
 * Duo-block layout: place two part outlines (the second optionally rotated
 * 180 degrees - never mirrored) so their combined bounding box is as small
 * as possible, keeping at least `gap` between them. This is how L-profiles
 * and left/right pairs nest head-to-toe.
 *
 * The search uses column/row height profiles sampled from the outlines:
 *  - vertical stack: B above A, sliding along X; the minimal Y separation is
 *    max over overlapping columns of (topA - botB) + gap
 *  - horizontal stack: B right of A, sliding along Y, using row profiles
 * Both role orders and both B rotations are tried; the packer's own 90-degree
 * rotation of the whole block covers the remaining orientations.
 */

/**
 * Sample column/row profiles of an outline normalized to [0..w]x[0..h].
 * cell is the absolute grid size in mm.
 */
function outlineProfiles(polys, w, h, cell) {
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const top = new Array(cols).fill(-Infinity);
  const bot = new Array(cols).fill(Infinity);
  const left = new Array(rows).fill(Infinity);
  const right = new Array(rows).fill(-Infinity);
  const stamp = (x, y) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(x / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(y / cell)));
    if (y > top[c]) top[c] = y;
    if (y < bot[c]) bot[c] = y;
    if (x < left[r]) left[r] = x;
    if (x > right[r]) right[r] = x;
  };
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      if (i === 0) {
        stamp(x1, y1);
        continue;
      }
      const [x0, y0] = poly[i - 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(len / (cell / 2)));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      }
    }
  }
  return { cols, rows, cell, w, h, top, bot, left, right };
}

/** Profiles of the same outline rotated 180 degrees ((x,y) -> (w-x, h-y)). */
function rotate180Profiles(p) {
  const n = p.cols;
  const m = p.rows;
  const top = new Array(n);
  const bot = new Array(n);
  const left = new Array(m);
  const right = new Array(m);
  for (let c = 0; c < n; c++) {
    const s = n - 1 - c;
    top[c] = p.bot[s] === Infinity ? -Infinity : p.h - p.bot[s];
    bot[c] = p.top[s] === -Infinity ? Infinity : p.h - p.top[s];
  }
  for (let r = 0; r < m; r++) {
    const s = m - 1 - r;
    left[r] = p.right[s] === -Infinity ? Infinity : p.w - p.right[s];
    right[r] = p.left[s] === Infinity ? -Infinity : p.w - p.left[s];
  }
  return { cols: n, rows: m, cell: p.cell, w: p.w, h: p.h, top, bot, left, right };
}

/** B stacked above A, sliding along X. Returns best {area, layout} or null. */
function sweepVertical(A, B, gap) {
  let best = null;
  const cell = A.cell;
  const lo = -B.cols;
  const hi = A.cols;
  for (let off = lo; off <= hi; off++) {
    let need = -Infinity;
    for (let cB = 0; cB < B.cols; cB++) {
      const cA = cB + off;
      if (cA < 0 || cA >= A.cols) continue;
      if (A.top[cA] === -Infinity || B.bot[cB] === Infinity) continue;
      const d = A.top[cA] - B.bot[cB];
      if (d > need) need = d;
    }
    const xB = off * cell;
    const yB = need === -Infinity ? 0 : need + gap;
    const minX = Math.min(0, xB);
    const minY = Math.min(0, yB);
    const W = Math.max(A.w, xB + B.w) - minX;
    const H = Math.max(A.h, yB + B.h) - minY;
    const area = W * H;
    if (!best || area < best.area) {
      best = {
        area,
        w: W,
        h: H,
        aOx: -minX,
        aOy: -minY,
        bOx: xB - minX,
        bOy: yB - minY,
      };
    }
  }
  return best;
}

/** B placed right of A, sliding along Y (row profiles). */
function sweepHorizontal(A, B, gap) {
  let best = null;
  const cell = A.cell;
  const lo = -B.rows;
  const hi = A.rows;
  for (let off = lo; off <= hi; off++) {
    let need = -Infinity;
    for (let rB = 0; rB < B.rows; rB++) {
      const rA = rB + off;
      if (rA < 0 || rA >= A.rows) continue;
      if (A.right[rA] === -Infinity || B.left[rB] === Infinity) continue;
      const d = A.right[rA] - B.left[rB];
      if (d > need) need = d;
    }
    const yB = off * cell;
    const xB = need === -Infinity ? 0 : need + gap;
    const minX = Math.min(0, xB);
    const minY = Math.min(0, yB);
    const W = Math.max(A.w, xB + B.w) - minX;
    const H = Math.max(A.h, yB + B.h) - minY;
    const area = W * H;
    if (!best || area < best.area) {
      best = {
        area,
        w: W,
        h: H,
        aOx: -minX,
        aOy: -minY,
        bOx: xB - minX,
        bOy: yB - minY,
      };
    }
  }
  return best;
}

/**
 * Best duo layout for two parts.
 * @param {{w,h,outline}} a  part A (outline normalized to its bbox)
 * @param {{w,h,outline}} b  part B (may be the same object for self-pairing)
 * @param {number} gap       minimum spacing between the two parts (mm)
 * @returns {{w,h,area, a:{ox,oy,rot180}, b:{ox,oy,rot180}}}
 *   Offsets are the parts' bbox minima inside the duo box. Never null - the
 *   worst case degenerates to a side-by-side layout.
 */
function bestDuoLayout(a, b, gap) {
  const cell = Math.max(0.5, Math.min(a.w, a.h, b.w, b.h) / 48);
  const pa = outlineProfiles(a.outline, a.w, a.h, cell);
  const pb = outlineProfiles(b.outline, b.w, b.h, cell);
  const pa180 = rotate180Profiles(pa);
  const pb180 = rotate180Profiles(pb);

  let best = null;
  const consider = (res, aRot, bRot, swap) => {
    if (!res) return;
    if (best && res.area >= best.area) return;
    // When roles are swapped, res's "A" slot holds part b.
    best = {
      area: res.area,
      w: res.w,
      h: res.h,
      a: swap
        ? { ox: res.bOx, oy: res.bOy, rot180: aRot }
        : { ox: res.aOx, oy: res.aOy, rot180: aRot },
      b: swap
        ? { ox: res.aOx, oy: res.aOy, rot180: bRot }
        : { ox: res.bOx, oy: res.bOy, rot180: bRot },
    };
  };

  for (const [pB, bRot] of [[pb, false], [pb180, true]]) {
    consider(sweepVertical(pa, pB, gap), false, bRot, false);
    consider(sweepHorizontal(pa, pB, gap), false, bRot, false);
  }
  // Swapped roles (B as the base) - covers "A above B" stacks.
  for (const [pA, aRot] of [[pa, false], [pa180, true]]) {
    consider(sweepVertical(pb, pA, gap), aRot, false, true);
    consider(sweepHorizontal(pb, pA, gap), aRot, false, true);
  }
  return best;
}

/**
 * Area a duo layout must beat: the two parts packed as separate rectangles
 * (each inflated by the gap, as the packer sees them).
 */
function separateArea(a, b, gap) {
  return (a.w + gap) * (a.h + gap) + (b.w + gap) * (b.h + gap);
}

module.exports = { outlineProfiles, rotate180Profiles, bestDuoLayout, separateArea };
