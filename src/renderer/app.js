'use strict';

/* DinoNest renderer - vanilla JS, no dependencies. */

const $ = (id) => document.getElementById(id);

const state = {
  parts: [],
  partsById: {},
  settings: null,
  history: [],
  sets: [],
  activeSetId: null,
  lastBatch: null,
  selectedSheetId: null,
  zone: null, // keep-out rectangle {x,y,w,h,sheetW,sheetH} in mm, or null
};

const bridge = window.dino;
const IS_WEB = !!(bridge && bridge.isWeb);
const CAN_DRAG = !!(bridge && bridge.canDrag);

const VARIANT_BADGE = {
  prioriteti: '1 · PRIORITETI',
  krupno: '2 · KRUPNO',
  sitno: '3 · SITNO',
  stisnuto: '★ STISNUTO',
  naknap: '⚠ NA KNAP',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The shop thinks in centimetres: every length the operator types or reads
// is cm (decimal point or comma), while the core and the DXF stay in mm.
function parseNum(text) {
  if (typeof text !== 'string') return NaN;
  const t = text.trim().replace(',', '.');
  if (t === '') return NaN;
  return Number(t);
}

/** cm typed by the operator -> mm for the core (rounded to 0.1 mm). */
function cmToMm(cm) {
  return Math.round(cm * 100) / 10;
}

/** mm from the core -> cm for display, at most 2 decimals, Croatian comma. */
function fmtCm(mm) {
  return String(Math.round(mm * 10) / 100).replace('.', ',');
}

/** Sheets display as DULJINA x ŠIRINA (the machine's long side first = Y). */
function dimsText(entry) {
  return fmtCm(entry.height) + ' × ' + fmtCm(entry.width) + ' cm';
}

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear()
    + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtDateShort(iso) {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return 'hsl(' + hue + ', 70%, 60%)';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function activeSet() {
  return state.sets.find((s) => s.id === state.activeSetId) || null;
}

/** Effective display params for a part under the active set (or globals). */
function effectiveParams(part) {
  const set = activeSet();
  if (!set) return { inSelection: !!part.enabled, ...pick(part), fromSet: false };
  const it = set.items && set.items[part.id];
  if (!it) return { inSelection: false, ...pick(part), fromSet: true };
  return {
    inSelection: true,
    priority: Number.isFinite(it.priority) ? it.priority : part.priority,
    mode: it.mode === 'fixed' ? 'fixed' : 'filler',
    count: Number.isFinite(it.count) ? it.count : part.count,
    maxCount: Number.isFinite(it.maxCount) ? it.maxCount : part.maxCount,
    fromSet: true,
  };
  function pick(p) {
    return { priority: p.priority, mode: p.mode, count: p.count, maxCount: p.maxCount };
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showView(name) {
  const stroj = name === 'stroj';
  $('viewStroj').hidden = !stroj;
  $('viewPriprema').hidden = stroj;
  $('tabStroj').classList.toggle('active', stroj);
  $('tabPriprema').classList.toggle('active', !stroj);
}

$('tabStroj').addEventListener('click', () => showView('stroj'));
$('tabPriprema').addEventListener('click', () => showView('priprema'));

// ---------------------------------------------------------------------------
// Sheet drawing (from compact placements + the part library outlines)
// ---------------------------------------------------------------------------

function turnOf(pl) {
  if (Number.isFinite(pl.turn)) return ((pl.turn % 360) + 360) % 360;
  return pl.rotated ? 90 : 0;
}

/** Map a point from part-outline coords into placement coords for a turn. */
function turnPoint(part, turn, x, y) {
  switch (turn) {
    case 90: return [part.h - y, x];
    case 180: return [part.w - x, part.h - y];
    case 270: return [y, part.w - x];
    default: return [x, y];
  }
}

function placementPolys(pl) {
  const part = state.partsById[pl.id];
  if (!part || !part.outline) return null;
  const turn = turnOf(pl);
  const polys = [];
  for (const poly of part.outline) {
    const out = [];
    for (const [px, py] of poly) {
      const [x, y] = turnPoint(part, turn, px, py);
      out.push([x + pl.x, y + pl.y]);
    }
    polys.push(out);
  }
  return polys;
}

/** Sheet-mm -> canvas-px mapping used by every sheet drawing and by zone picking. */
function previewTransform(canvas, entry) {
  const W = canvas.width;
  const H = canvas.height;
  const pad = Math.max(8, Math.round(W * 0.02));
  const scale = Math.min((W - 2 * pad) / entry.width, (H - 2 * pad) / entry.height);
  const ox = (W - entry.width * scale) / 2;
  const oy = (H - entry.height * scale) / 2;
  return {
    W, H, scale, ox, oy,
    tx: (x) => ox + x * scale,
    ty: (y) => H - oy - y * scale, // flip Y (DXF Y is up)
    fromCanvas: (px, py) => [(px - ox) / scale, (H - oy - py) / scale],
  };
}

function hatchRect(ctx, t, r, fill, stroke) {
  const x = t.tx(r.x);
  const y = t.ty(r.y + r.h);
  const w = r.w * t.scale;
  const h = r.h * t.scale;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  const step = Math.max(6, t.W / 120);
  for (let d = -h; d < w; d += step) {
    ctx.beginPath();
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, t.W / 600);
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/**
 * Draw a sheet entry. opts: {free: hatch leftover free space, liveZone: a
 * rectangle being dragged right now (sheet coords)}.
 */
function drawSheetEntry(canvas, entry, opts) {
  const o = opts || {};
  const ctx = canvas.getContext('2d');
  const t = previewTransform(canvas, entry);
  const { W, H, scale, tx, ty } = t;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#242c37';
  ctx.strokeStyle = '#5b6b7f';
  ctx.lineWidth = Math.max(1, W / 700);
  ctx.fillRect(tx(0), ty(entry.height), entry.width * scale, entry.height * scale);
  ctx.strokeRect(tx(0), ty(entry.height), entry.width * scale, entry.height * scale);

  // Keep-out zone ("ne diraj") - red hatch, stored with the entry.
  if (entry.zone && entry.zone.w > 0) hatchRect(ctx, t, entry.zone, 'rgba(255, 93, 93, 0.18)', '#ff5d5d');
  if (o.liveZone && o.liveZone.w > 0) hatchRect(ctx, t, o.liveZone, 'rgba(255, 93, 93, 0.25)', '#ff8a8a');

  if (!Array.isArray(entry.placements) || entry.placements.length === 0) {
    ctx.fillStyle = '#8b98a8';
    ctx.font = Math.round(W / 30) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('stara ploča — samo datoteka', W / 2, H / 2);
    return;
  }

  // Leftover free space (for "zasto ne stane") - blue hatch, big preview only.
  if (o.free && Array.isArray(entry.freeRects)) {
    for (const r of entry.freeRects.slice(0, 4)) {
      if (r.w * scale < 6 || r.h * scale < 6) continue;
      hatchRect(ctx, t, r, 'rgba(88, 166, 255, 0.10)', 'rgba(88, 166, 255, 0.7)');
    }
  }

  // Skeleton chop lines - thin grey dashes.
  if (Array.isArray(entry.extraLines) && entry.extraLines.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(160, 170, 185, 0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    for (const ln of entry.extraLines) {
      ctx.beginPath();
      ctx.moveTo(tx(ln.x1), ty(ln.y1));
      ctx.lineTo(tx(ln.x2), ty(ln.y2));
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const pl of entry.placements) {
    const polys = placementPolys(pl);
    ctx.strokeStyle = colorFor(pl.id);
    ctx.lineWidth = Math.max(1, W / 900);
    if (!polys) {
      // Part was deleted from the library - show its box as a dashed ghost.
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(tx(pl.x), ty(pl.y + pl.h), pl.w * scale, pl.h * scale);
      ctx.setLineDash([]);
      continue;
    }
    for (const poly of polys) {
      if (poly.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(tx(poly[0][0]), ty(poly[0][1]));
      for (let i = 1; i < poly.length; i++) ctx.lineTo(tx(poly[i][0]), ty(poly[i][1]));
      ctx.stroke();
    }
    // Engraving text markings
    const part = state.partsById[pl.id];
    if (part && part.texts && part.texts.length) {
      const turn = turnOf(pl);
      ctx.fillStyle = 'rgba(180, 195, 212, 0.85)';
      for (const t of part.texts) {
        const fontPx = (t.h || 5) * scale;
        if (fontPx < 3) continue; // unreadable at this zoom
        const [x, y] = turnPoint(part, turn, t.x, t.y);
        ctx.save();
        ctx.translate(tx(x + pl.x), ty(y + pl.y));
        ctx.rotate(-(((t.rot || 0) + turn) * Math.PI) / 180);
        ctx.font = fontPx + 'px sans-serif';
        ctx.fillText(t.s, 0, 0);
        ctx.restore();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Machine view: set switcher, generate, offers
// ---------------------------------------------------------------------------

function renderSetBar() {
  const bar = $('setBar');
  bar.innerHTML = '';
  const mk = (label, id) => {
    const b = el('button', 'chip' + ((state.activeSetId || null) === id ? ' active' : ''), label);
    b.addEventListener('click', async () => {
      const res = await bridge.activateSet(id);
      state.sets = res.sets;
      state.activeSetId = res.activeSetId;
      renderSetBar();
      renderSetsList();
      renderParts();
      showToast(id ? 'Aktivan set: ' + (activeSet() || {}).name : 'Aktivno: svi uključeni partovi');
    });
    return b;
  };
  bar.appendChild(mk('SVI', null));
  for (const s of state.sets) bar.appendChild(mk(s.name, s.id));
}

/** Typed sheet size in mm ({len: Y/duljina, wid: X/sirina}) or null. */
function typedDims() {
  const len = parseNum($('inLen').value);   // DULJINA (cm) -> Y (sheetH)
  const wid = parseNum($('inWid').value);   // ŠIRINA (cm)  -> X (sheetW)
  if (!Number.isFinite(len) || !Number.isFinite(wid) || len <= 0 || wid <= 0) return null;
  return { len: cmToMm(len), wid: cmToMm(wid) };
}

async function generate(dense) {
  if ($('btnGenerate').disabled) return; // already running (Enter bypasses the button)
  const dims = typedDims();
  const status = $('genStatus');
  status.hidden = false;
  status.className = 'status';

  if (!dims) {
    status.classList.add('err');
    status.textContent = 'Upišite duljinu i širinu ploče u centimetrima (npr. 300 i 150).';
    return; // keep the selected sheet's warnings (#genWarn) untouched
  }
  const { len, wid } = dims;
  $('genWarn').hidden = true;
  // A keep-out zone belongs to one sheet size.
  if (state.zone && (state.zone.sheetW !== wid || state.zone.sheetH !== len)) {
    state.zone = null;
    updateZoneUi();
  }

  const btn = $('btnGenerate');
  const btnD = $('btnDense');
  btn.disabled = true;
  btnD.disabled = true;
  status.textContent = dense
    ? 'Stišćem jače — tražim najgušći raspored (par sekundi)…'
    : 'Slažem varijante ploče…';
  try {
    // The web bridge nests synchronously on the UI thread (seconds for the
    // dense search) - yield once so the status and disabled buttons paint.
    if (dense || IS_WEB) await new Promise((r) => setTimeout(r, 30));
    const res = await bridge.generate({
      width: wid,
      height: len,
      dense: !!dense,
      zone: state.zone ? { x: state.zone.x, y: state.zone.y, w: state.zone.w, h: state.zone.h } : null,
    });
    if (!res.ok) {
      status.classList.add('err');
      status.textContent = res.message || 'Generiranje nije uspjelo.';
      return;
    }
    status.hidden = true;
    state.lastBatch = res.batch;
    await refreshHistory();
    renderOffers();
    if (res.sheets && res.sheets.length > 0) selectSheet(res.sheets[0].sheetId);
    // One toast for everything - sequential showToast calls would overwrite
    // each other (single #toast element).
    const toasts = [];
    if (dense && !(res.sheets || []).some((s) => s.variant === 'stisnuto')) {
      toasts.push('Gušći raspored nije pronađen — standardni je već najbolji.');
    }
    if ((res.sheets || []).some((s) => s.variant === 'naknap')) {
      toasts.push('Ponuđena je i ploča NA KNAP — malo veća, ali stane više!');
    }
    if (res.opened) toasts.push('Otvoreno u CypCut-u: ' + res.sheets[0].fileName);
    if (toasts.length > 0) showToast(toasts.join('  '));
    if (res.openMessage) {
      // Append - selectSheet may just have written NIJE STALO / NA KNAP here.
      const w = $('genWarn');
      w.textContent = (w.hidden || !w.textContent)
        ? res.openMessage
        : w.textContent + '  ·  ' + res.openMessage;
      w.hidden = false;
    }
    // Ready for the next sheet: Enter-Enter-Enter workflow without the mouse.
    // But never steal focus if the operator has meanwhile clicked elsewhere
    // (e.g. is correcting a value or editing a setting).
    const ae = document.activeElement;
    if (!ae || ae === document.body || ae.id === 'inLen' || ae.id === 'inWid'
      || ae.id === 'btnGenerate' || ae.id === 'btnDense') {
      $('inLen').focus();
      $('inLen').select();
    }
  } catch (e) {
    status.classList.add('err');
    status.textContent = 'Greška: ' + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
    btnD.disabled = false;
  }
}

function dimsMatch(entry, w, h, tol) {
  const close = (a, b) => Math.abs(a - b) <= tol;
  return (close(entry.width, w) && close(entry.height, h))
    || (close(entry.width, h) && close(entry.height, w));
}

function currentMatches() {
  const dims = typedDims();
  if (!dims) return null;
  const { len, wid } = dims;
  const tol = (state.settings && Number.isFinite(state.settings.histTol)) ? state.settings.histTol : 20;
  // Sheets from the just-generated batch always match with at least the
  // maximum na-knap bump as tolerance - otherwise a strict histTol (< 10 mm)
  // would hide the NA KNAP card the toast just announced.
  const tolFor = (s) => (s.batch && s.batch === state.lastBatch ? Math.max(tol, 12) : tol);
  const matches = state.history.filter((s) => dimsMatch(s, wid, len, tolFor(s)));
  const isNew = (s) => (s.batch && s.batch === state.lastBatch) ? 0 : 1;
  matches.sort((a, b) => {
    if (isNew(a) !== isNew(b)) return isNew(a) - isNew(b);
    if (isNew(a) === 0) return 0; // keep variant order 1,2,3
    return new Date(b.date) - new Date(a.date);
  });
  return { len, wid, tol, matches };
}

function sheetCard(entry) {
  const card = el('div', 'sheet-card');
  card.dataset.id = entry.id;
  if (entry.id === state.selectedSheetId) card.classList.add('selected');

  if (entry.variant === 'naknap') {
    // The bigger-sheet warning must survive on the card itself, whatever the
    // batch age - old naknap sheets can be dragged into CypCut without a
    // click, so the card is the only place the operator is sure to look.
    const badge = el('div', 'badge b-knap', '⚠ ' + (entry.variantLabel || 'NA KNAP').toUpperCase());
    card.appendChild(badge);
  } else if (entry.batch && entry.batch === state.lastBatch) {
    const badge = el('div', 'badge', VARIANT_BADGE[entry.variant] || 'NOVA');
    if (entry.variant === 'stisnuto') badge.classList.add('b-dense');
    card.appendChild(badge);
  }

  const cv = document.createElement('canvas');
  cv.width = 400;
  cv.height = 210;
  drawSheetEntry(cv, entry);
  card.appendChild(cv);

  card.appendChild(el('div', 'sc-line1', dimsText(entry)));
  card.appendChild(el('div', 'sc-line2',
    entry.totalPlaced + ' kom · ' + Math.round((entry.utilization || 0) * 100) + '% · ' + fmtDateShort(entry.date)
    + (entry.variantLabel && entry.batch !== state.lastBatch ? ' · ' + entry.variantLabel : '')
    + (entry.setName ? ' · ' + entry.setName : '')
    + (Array.isArray(entry.placements) && entry.placements.length ? '' : ' · stara datoteka')));

  card.addEventListener('click', () => selectSheet(entry.id));
  card.addEventListener('dblclick', () => openSheetFeedback(entry.id));
  if (CAN_DRAG) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      e.preventDefault();
      bridge.dragSheet(entry.id);
    });
  }
  return card;
}

function renderOffers() {
  const box = $('offers');
  const cur = currentMatches();
  if (!cur || cur.matches.length === 0) {
    box.hidden = true;
    if (state.selectedSheetId) {
      state.selectedSheetId = null;
      $('result').hidden = true;
    }
    return;
  }
  box.hidden = false;
  $('offersTitle').textContent = 'Ploče ~ ' + fmtCm(cur.len) + ' × ' + fmtCm(cur.wid)
    + ' cm (±' + fmtCm(cur.tol) + ' cm) — ' + cur.matches.length + ' kom';
  const wrap = $('offerCards');
  wrap.innerHTML = '';
  for (const m of cur.matches.slice(0, 12)) wrap.appendChild(sheetCard(m));
  $('dragHint').hidden = !CAN_DRAG;

  if (state.selectedSheetId && !cur.matches.some((m) => m.id === state.selectedSheetId)) {
    state.selectedSheetId = null;
    $('result').hidden = true;
  }
}

function selectSheet(id) {
  const entry = state.history.find((s) => s.id === id);
  if (!entry) return;
  state.selectedSheetId = id;
  for (const c of document.querySelectorAll('.sheet-card')) {
    c.classList.toggle('selected', c.dataset.id === id);
  }
  $('result').hidden = false;
  drawSheetEntry($('preview'), entry, { free: true });
  renderWhy(entry);
  updateZoneUi();
  if (!$('gapStrip').hidden) refreshGapStrip();

  const stats = $('stats');
  stats.innerHTML = '';
  stats.appendChild(el('div', 'big',
    dimsText(entry) + ' · ' + entry.totalPlaced + ' kom · '
    + Math.round((entry.utilization || 0) * 100) + '%'
    + (entry.variantLabel ? ' · ' + entry.variantLabel : '')));
  if (Array.isArray(entry.summary) && entry.summary.length) {
    stats.appendChild(el('div', '', entry.summary.map((s) => s.name + ' ×' + s.count).join('  ·  ')));
  }
  stats.appendChild(el('div', 'files',
    (entry.fileName || '') + ' · ' + fmtDate(entry.date) + (entry.setName ? ' · set: ' + entry.setName : '')));

  const warn = $('genWarn');
  const msgs = [];
  if (entry.variant === 'naknap') {
    msgs.push('NA KNAP: ovo je VEĆA ploča — ' + dimsText(entry) + '. Provjerite da takav lim postoji!');
  }
  if (Array.isArray(entry.unplaced) && entry.unplaced.length > 0) {
    msgs.push('NIJE STALO: ' + entry.unplaced.map((u) => u.name + ' ×' + u.count).join(', '));
  }
  if (entry.capped) msgs.push('Dosegnut je sigurnosni limit — ploča možda nije potpuno popunjena.');
  if (Array.isArray(entry.notes)) for (const n of entry.notes) msgs.push(n);
  warn.textContent = msgs.join('  ·  ');
  warn.hidden = msgs.length === 0;
}

async function openSheetFeedback(id) {
  try {
    const r = await bridge.openSheet(id);
    if (r && !r.ok && !r.canceled) showToast(r.message || 'Otvaranje nije uspjelo.');
  } catch (e) {
    showToast('Otvaranje nije uspjelo: ' + (e && e.message ? e.message : e));
  }
}

async function saveSheetFeedback(id) {
  try {
    const r = await bridge.saveSheet(id);
    if (r && r.ok && r.path) showToast('Spremljeno: ' + r.path);
    else if (r && !r.ok && !r.canceled) showToast(r.message || 'Spremanje nije uspjelo.');
  } catch (e) {
    showToast('Spremanje nije uspjelo: ' + (e && e.message ? e.message : e));
  }
}

$('btnGenerate').addEventListener('click', () => generate(false));
$('btnDense').addEventListener('click', () => generate(true));
// Enter chain, no mouse needed: DULJINA -> Enter -> ŠIRINA -> Enter -> generate.
$('inLen').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.repeat) {
    const w = $('inWid');
    w.focus();
    w.select();
  }
});
$('inWid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.repeat) generate(false);
});
for (const id of ['inLen', 'inWid']) {
  $(id).addEventListener('input', renderOffers);
}
$('btnOpen').addEventListener('click', () => {
  if (state.selectedSheetId) openSheetFeedback(state.selectedSheetId);
});
$('btnSave').addEventListener('click', () => {
  if (state.selectedSheetId) saveSheetFeedback(state.selectedSheetId);
});

// ---------------------------------------------------------------------------
// "Zasto ne stane?" explainer
// ---------------------------------------------------------------------------

function renderWhy(entry) {
  const box = $('whyBox');
  const h = entry && entry.hint;
  if (!h) {
    box.hidden = true;
    return;
  }
  const parts = [];
  parts.push('<b>ZAŠTO NE STANE?</b> ' + escapeHtml(h.partName) + ' (' + fmtCm(h.partW) + ' × ' + fmtCm(h.partH) + ' cm)');
  if (h.free) {
    parts.push('— najveća slobodna rupa na ploči je <b>' + fmtCm(h.free.w) + ' × ' + fmtCm(h.free.h) + ' cm</b>'
      + (h.missing > 0 ? ', komadu fali <b>' + fmtCm(h.missing) + ' cm</b>.' : '.'));
  } else {
    parts.push('— na ploči nema slobodnog mjesta.');
  }
  if (h.betterGap) {
    parts.push('S razmakom <b>' + fmtCm(h.betterGap.gap) + ' cm</b> umjesto '
      + fmtCm(state.settings ? state.settings.gap : 8) + ' cm stalo bi još <b>' + h.betterGap.extra + ' kom</b>'
      + ' — probaj RAZMAK UŽIVO.');
  }
  box.innerHTML = parts.join(' ');
  box.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Keep-out zone ("ZONA"): drag a rectangle on the big preview, the sheet is
// regenerated around it.
// ---------------------------------------------------------------------------

let zoning = false;
let zoneDrag = null;

function updateZoneUi() {
  $('btnZone').textContent = zoning ? '✕ ODUSTANI' : (state.zone ? '✏ NOVA ZONA' : '✏ ZONA');
  $('btnZoneClear').hidden = !state.zone;
  $('zoneHint').hidden = !zoning;
  $('preview').classList.toggle('zoning', zoning);
}

function selectedEntry() {
  return state.history.find((s) => s.id === state.selectedSheetId) || null;
}

function canvasPoint(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
}

function dragRect(entry) {
  if (!zoneDrag) return null;
  const x0 = Math.max(0, Math.min(zoneDrag.x0, zoneDrag.x1));
  const y0 = Math.max(0, Math.min(zoneDrag.y0, zoneDrag.y1));
  const x1 = Math.min(entry.width, Math.max(zoneDrag.x0, zoneDrag.x1));
  const y1 = Math.min(entry.height, Math.max(zoneDrag.y0, zoneDrag.y1));
  const r1 = (n) => Math.round(n * 10) / 10;
  return { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) };
}

$('btnZone').addEventListener('click', () => {
  zoning = !zoning;
  zoneDrag = null;
  updateZoneUi();
});
$('btnZoneClear').addEventListener('click', () => {
  state.zone = null;
  zoning = false;
  updateZoneUi();
  generate(false);
});
$('preview').addEventListener('mousedown', (e) => {
  const entry = selectedEntry();
  if (!zoning || !entry) return;
  e.preventDefault();
  const t = previewTransform($('preview'), entry);
  const [x, y] = t.fromCanvas(...canvasPoint($('preview'), e));
  zoneDrag = { x0: x, y0: y, x1: x, y1: y };
});
$('preview').addEventListener('mousemove', (e) => {
  const entry = selectedEntry();
  if (!zoneDrag || !entry) return;
  const t = previewTransform($('preview'), entry);
  const [x, y] = t.fromCanvas(...canvasPoint($('preview'), e));
  zoneDrag.x1 = x;
  zoneDrag.y1 = y;
  drawSheetEntry($('preview'), entry, { free: true, liveZone: dragRect(entry) });
});
window.addEventListener('mouseup', () => {
  const entry = selectedEntry();
  if (!zoneDrag || !entry) return;
  const r = dragRect(entry);
  zoneDrag = null;
  zoning = false;
  if (r && r.w >= 5 && r.h >= 5) {
    state.zone = { ...r, sheetW: entry.width, sheetH: entry.height };
    // The zone is in the coordinates of the sheet on screen - make the
    // inputs match it so the regenerate hits the same size.
    $('inLen').value = fmtCm(entry.height);
    $('inWid').value = fmtCm(entry.width);
    updateZoneUi();
    generate(false);
  } else {
    updateZoneUi();
    drawSheetEntry($('preview'), entry, { free: true });
  }
});

// ---------------------------------------------------------------------------
// "Razmak uzivo": live piece counts for other gaps
// ---------------------------------------------------------------------------

let gapTimer = null;

function gapContext() {
  const entry = selectedEntry();
  const dims = typedDims() || (entry ? { len: entry.height, wid: entry.width } : null);
  if (!dims) return null;
  return {
    width: dims.wid,
    height: dims.len,
    zone: state.zone ? { x: state.zone.x, y: state.zone.y, w: state.zone.w, h: state.zone.h } : null,
  };
}

async function refreshGapStrip() {
  const ctx = gapContext();
  const cur = Number($('gapRange').value);
  $('gapValue').textContent = fmtCm(cur) + ' cm → …';
  if (!ctx) return;
  const gaps = [];
  for (let g = Math.max(0, cur - 3); g <= cur + 3; g++) if (gaps.indexOf(g) === -1) gaps.push(g);
  try {
    const res = await bridge.gapSweep({ ...ctx, gaps });
    if (!res.ok) {
      $('gapValue').textContent = res.message || '';
      return;
    }
    const rows = $('gapRows');
    rows.innerHTML = '';
    const best = Math.max(...res.rows.map((r) => r.placed));
    for (const r of res.rows) {
      const chip = el('button', 'chip' + (r.placed === best ? ' best' : '') + (r.gap === cur ? ' active' : ''),
        fmtCm(r.gap) + ' cm → ' + r.placed + ' kom');
      chip.addEventListener('click', () => {
        $('gapRange').value = String(r.gap);
        refreshGapStrip();
      });
      rows.appendChild(chip);
      if (r.gap === cur) {
        $('gapValue').textContent = fmtCm(cur) + ' cm → ' + r.placed + ' kom'
          + (r.unplaced > 0 ? ' (' + r.unplaced + ' ne stane)' : '');
      }
    }
  } catch (e) {
    $('gapValue').textContent = 'Greška: ' + (e && e.message ? e.message : e);
  }
}

$('btnGap').addEventListener('click', () => {
  const strip = $('gapStrip');
  strip.hidden = !strip.hidden;
  if (!strip.hidden) {
    $('gapRange').value = String(Math.round(state.settings ? state.settings.gap : 8));
    refreshGapStrip();
  }
});
$('gapRange').addEventListener('input', () => {
  clearTimeout(gapTimer);
  gapTimer = setTimeout(refreshGapStrip, 80);
});
$('btnGapApply').addEventListener('click', async () => {
  const g = Number($('gapRange').value);
  await saveSettings({ gap: g });
  $('gapStrip').hidden = true;
  generate(false);
});

// ---------------------------------------------------------------------------
// Sets management (prep view)
// ---------------------------------------------------------------------------

function renderSetsList() {
  const list = $('setsList');
  list.innerHTML = '';
  if (state.sets.length === 0) {
    list.appendChild(el('div', 'empty',
      'Još nema setova. Set je spremljeni režim rada: koji partovi idu na ploču i s kojim prioritetima.'));
  }
  for (const s of state.sets) {
    const row = el('div', 'set-row' + (s.id === state.activeSetId ? ' active' : ''));

    const radio = el('button', 'chip' + (s.id === state.activeSetId ? ' active' : ''),
      s.id === state.activeSetId ? '● AKTIVAN' : 'aktiviraj');
    radio.addEventListener('click', async () => {
      const res = await bridge.activateSet(s.id === state.activeSetId ? null : s.id);
      state.sets = res.sets;
      state.activeSetId = res.activeSetId;
      renderSetBar();
      renderSetsList();
      renderParts();
    });
    row.appendChild(radio);

    const nameIn = document.createElement('input');
    nameIn.value = s.name;
    nameIn.title = 'Naziv seta';
    nameIn.addEventListener('change', async () => {
      const res = await bridge.renameSet(s.id, nameIn.value);
      state.sets = res.sets;
      renderSetBar();
      renderSetsList();
    });
    row.appendChild(nameIn);

    row.appendChild(el('div', 'set-count', Object.keys(s.items || {}).length + ' partova'));

    // "Dopuni iz drugog seta": leftover space goes to that set's parts.
    const fill = el('label', 'set-fill');
    fill.appendChild(el('span', '', 'dopuni iz:'));
    const sel = document.createElement('select');
    sel.title = 'Kad ovaj set ostavi prazno mjesto, popuni ga partovima odabranog seta';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— ništa —';
    sel.appendChild(none);
    for (const o of state.sets) {
      if (o.id === s.id) continue;
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      if (s.fillSetId === o.id) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      const res = await bridge.setSetFill(s.id, sel.value || null);
      state.sets = res.sets;
      renderSetsList();
    });
    fill.appendChild(sel);
    row.appendChild(fill);

    const del = el('button', 'btn small danger', '✕');
    del.title = 'Obriši set';
    del.addEventListener('click', async () => {
      if (!window.confirm('Obrisati set "' + s.name + '"? Partovi ostaju u biblioteci.')) return;
      const res = await bridge.removeSet(s.id);
      state.sets = res.sets;
      state.activeSetId = res.activeSetId;
      renderSetBar();
      renderSetsList();
      renderParts();
    });
    row.appendChild(del);

    list.appendChild(row);
  }
  $('setsHint').textContent = state.activeSetId
    ? 'Uređuješ aktivni set: kvačica "Uklj." dodaje part u set, a prioritet/način vrijede samo za ovaj set.'
    : 'Aktivno je "SVI": svi uključeni partovi sa svojim osnovnim postavkama.';
}

$('btnNewSet').addEventListener('click', async () => {
  const res = await bridge.createSet('Set ' + (state.sets.length + 1));
  state.sets = res.sets;
  state.activeSetId = res.activeSetId;
  renderSetBar();
  renderSetsList();
  renderParts();
  showToast('Novi set je stvoren i aktiviran — kvačicama odaberi partove.');
});

// ---------------------------------------------------------------------------
// Parts (prep view)
// ---------------------------------------------------------------------------

function drawOutline(canvas, part, padPx) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!part.outline || part.w <= 0 || part.h <= 0) return;
  const pad = padPx || 6;
  const scale = Math.min((W - 2 * pad) / part.w, (H - 2 * pad) / part.h);
  const ox = (W - part.w * scale) / 2;
  const oy = (H - part.h * scale) / 2;
  ctx.strokeStyle = colorFor(part.id);
  ctx.lineWidth = 1.5;
  for (const poly of part.outline) {
    if (poly.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(ox + poly[0][0] * scale, H - oy - poly[0][1] * scale);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(ox + poly[i][0] * scale, H - oy - poly[i][1] * scale);
    }
    ctx.stroke();
  }
  if (part.texts && part.texts.length) {
    ctx.fillStyle = 'rgba(180, 195, 212, 0.9)';
    for (const t of part.texts) {
      const fontPx = (t.h || 5) * scale;
      if (fontPx < 3) continue;
      ctx.save();
      ctx.translate(ox + t.x * scale, H - oy - t.y * scale);
      ctx.rotate(-((t.rot || 0) * Math.PI) / 180);
      ctx.font = fontPx + 'px sans-serif';
      ctx.fillText(t.s, 0, 0);
      ctx.restore();
    }
  }
}

function showPartModal(part) {
  $('modalTitle').textContent = part.name;
  drawOutline($('modalCanvas'), part, 20);
  const info = [];
  info.push('Dimenzije: ' + fmtCm(part.w) + ' × ' + fmtCm(part.h) + ' cm · površina ' + (part.area / 100).toFixed(1) + ' cm²');
  if (part.noRotate) info.push('Ne okreći: ostaje kako je nacrtan (samo 0° ili 180°).');
  if (Array.isArray(part.holes) && part.holes.length) {
    info.push('Velike rupe (u njih program slaže manje komade): '
      + part.holes.map((h) => fmtCm(h.w) + '×' + fmtCm(h.h) + ' cm').join(', '));
  }
  if (part.entityCount) info.push('Učitano entiteta: ' + part.entityCount);
  if (part.pairId && state.partsById[part.pairId]) {
    info.push('U paru s: ' + state.partsById[part.pairId].name + ' (uvijek idu zajedno na ploču)');
  }
  if (part.warnings && part.warnings.length) {
    info.push('Upozorenja pri uvozu:\n  – ' + part.warnings.join('\n  – '));
  }
  info.push('Ako oblik NE izgleda kao tvoj crtež, javi — pošalji taj DXF da popravimo uvoz.');
  $('modalInfo').textContent = info.join('\n');
  $('partModal').hidden = false;
}

$('modalClose').addEventListener('click', () => { $('partModal').hidden = true; });
$('partModal').addEventListener('click', (e) => {
  if (e.target === $('partModal')) $('partModal').hidden = true;
});

// Pair picker modal
let pairSourceId = null;
function openPairPicker(part) {
  pairSourceId = part.id;
  $('pairTitle').textContent = 'Upari "' + part.name + '" s…';
  const list = $('pairList');
  list.innerHTML = '';
  const others = state.parts.filter((p) => p.id !== part.id);
  if (others.length === 0) {
    list.appendChild(el('div', 'empty', 'Nema drugih partova.'));
  }
  for (const p of others) {
    const b = el('button', 'pair-option');
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 48;
    drawOutline(cv, p, 4);
    b.appendChild(cv);
    b.appendChild(el('span', '', p.name + ' (' + fmtCm(p.w) + '×' + fmtCm(p.h) + ' cm)'
      + (p.pairId ? ' — već u paru' : '')));
    b.addEventListener('click', async () => {
      $('pairModal').hidden = true;
      await bridge.pairPart(pairSourceId, p.id);
      await refreshParts();
      showToast('Upareno — idu zajedno na svaku ploču, u jednakom broju.');
    });
    list.appendChild(b);
  }
  $('pairModal').hidden = false;
}

$('pairClose').addEventListener('click', () => { $('pairModal').hidden = true; });
$('pairModal').addEventListener('click', (e) => {
  if (e.target === $('pairModal')) $('pairModal').hidden = true;
});

function renderParts() {
  const list = $('partsList');
  list.innerHTML = '';
  if (state.parts.length === 0) {
    list.appendChild(el('div', 'empty', 'Još nema partova. Dodajte DXF datoteke iznad.'));
    return;
  }
  // Keep insertion order - re-sorting on every priority change would make
  // rows jump under the cursor while editing.
  for (const part of state.parts) {
    list.appendChild(partRow(part));
  }
}

/** Persist a per-part field change - to the active set, or to the globals. */
async function updateField(part, patch) {
  const set = activeSet();
  if (set) {
    const res = await bridge.setSetItem(set.id, part.id, patch);
    state.sets = res.sets;
    state.activeSetId = res.activeSetId;
    renderSetsList();
  } else {
    await bridge.updatePart(part.id, patch);
  }
  await refreshParts();
}

function partRow(part) {
  const eff = effectiveParams(part);
  const row = el('div', 'part-row' + (eff.inSelection ? '' : ' disabled'));

  const cellMain = el('div', 'part-cell');
  const thumb = document.createElement('canvas');
  thumb.className = 'part-thumb';
  thumb.width = 84;
  thumb.height = 62;
  thumb.title = 'Klikni za veliki pregled';
  drawOutline(thumb, part);
  thumb.addEventListener('click', () => showPartModal(part));
  cellMain.appendChild(thumb);

  const main = el('div', 'part-main');
  const nameInput = document.createElement('input');
  nameInput.value = part.name;
  nameInput.title = 'Naziv parta';
  nameInput.addEventListener('change', () => bridge.updatePart(part.id, { name: nameInput.value }).then(refreshParts));
  main.appendChild(nameInput);
  const dims = el('div', 'part-dims');
  dims.appendChild(document.createTextNode(fmtCm(part.w) + ' × ' + fmtCm(part.h) + ' cm'));
  if (Array.isArray(part.holes) && part.holes.length) {
    dims.appendChild(document.createTextNode(' · ◻ rupa'));
  }
  if (part.warnings && part.warnings.length) {
    dims.appendChild(document.createTextNode(' · '));
    const wlink = el('span', 'link', '⚠ ' + part.warnings.length);
    wlink.addEventListener('click', () => showPartModal(part));
    dims.appendChild(wlink);
  }
  main.appendChild(dims);

  // Pair line: linked parts always land together, in equal counts.
  const pairLine = el('div', 'pair-line');
  if (part.pairId && state.partsById[part.pairId]) {
    pairLine.appendChild(el('span', 'pair-badge', '🔗 ' + state.partsById[part.pairId].name));
    const unlink = el('button', 'btn tiny ghost', 'odspoji');
    unlink.addEventListener('click', async () => {
      await bridge.pairPart(part.id, null);
      await refreshParts();
    });
    pairLine.appendChild(unlink);
  } else {
    const link = el('button', 'btn tiny ghost', '🔗 upari…');
    link.title = 'Upareni partovi idu uvijek zajedno na ploču (npr. lijevo i desno čelo)';
    link.addEventListener('click', () => openPairPicker(part));
    pairLine.appendChild(link);
  }
  main.appendChild(pairLine);
  cellMain.appendChild(main);
  row.appendChild(cellMain);

  const fieldsDisabled = !eff.inSelection && !!activeSet();

  // Priority
  const prio = el('label', 'part-field');
  prio.appendChild(el('span', '', 'Prioritet (1 = prvi)'));
  const prioIn = document.createElement('input');
  prioIn.type = 'number';
  prioIn.min = '1';
  prioIn.max = '99';
  prioIn.value = eff.priority;
  prioIn.disabled = fieldsDisabled;
  prioIn.addEventListener('change', () => updateField(part, { priority: prioIn.value }));
  prio.appendChild(prioIn);
  row.appendChild(prio);

  // Mode - Popuna is the default and listed first.
  const mode = el('label', 'part-field');
  mode.appendChild(el('span', '', 'Način'));
  const modeSel = document.createElement('select');
  for (const [v, t] of [['filler', 'Popuna'], ['fixed', 'Točan broj']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    if (eff.mode === v) o.selected = true;
    modeSel.appendChild(o);
  }
  modeSel.disabled = fieldsDisabled;
  modeSel.addEventListener('change', () => updateField(part, { mode: modeSel.value }));
  mode.appendChild(modeSel);
  row.appendChild(mode);

  // Count / maxCount
  const cnt = el('label', 'part-field');
  const isFiller = eff.mode === 'filler';
  cnt.appendChild(el('span', '', isFiller ? 'Maks. (0 = koliko stane)' : 'Broj komada'));
  const cntIn = document.createElement('input');
  cntIn.type = 'number';
  cntIn.min = '0';
  cntIn.value = isFiller ? (eff.maxCount || 0) : eff.count;
  cntIn.disabled = fieldsDisabled;
  cntIn.addEventListener('change', () => updateField(part, isFiller ? { maxCount: cntIn.value } : { count: cntIn.value }));
  cnt.appendChild(cntIn);
  row.appendChild(cnt);

  // Included: in the active set, or globally enabled.
  const en = el('label', 'part-field check');
  const enIn = document.createElement('input');
  enIn.type = 'checkbox';
  enIn.checked = eff.inSelection;
  enIn.addEventListener('change', async () => {
    const set = activeSet();
    if (set) {
      const res = await bridge.setSetItem(set.id, part.id, enIn.checked ? {} : null);
      state.sets = res.sets;
      renderSetsList();
      await refreshParts();
    } else {
      await bridge.updatePart(part.id, { enabled: enIn.checked });
      await refreshParts();
    }
  });
  en.appendChild(enIn);
  en.appendChild(el('span', '', 'Uklj.'));
  row.appendChild(en);

  // Rotation lock (global part property - grain direction is a fact of the drawing)
  const nr = el('label', 'part-field check');
  nr.title = 'Ne okreći: za brušeni inox/foliju — smjer ostaje kako je nacrtano (dozvoljeno samo 0° i 180°)';
  const nrIn = document.createElement('input');
  nrIn.type = 'checkbox';
  nrIn.checked = !!part.noRotate;
  nrIn.addEventListener('change', async () => {
    await bridge.updatePart(part.id, { noRotate: nrIn.checked });
    await refreshParts();
    showToast(nrIn.checked ? 'Part se više ne okreće (samo 0°/180°).' : 'Part se opet smije okretati.');
  });
  nr.appendChild(nrIn);
  nr.appendChild(el('span', '', 'Ne okr.'));
  row.appendChild(nr);

  // Delete - goes to the Kanta for 30 days, so a slip is recoverable.
  const del = el('button', 'btn small danger', '✕');
  del.title = 'Obriši part (30 dana ostaje u Kanti)';
  del.addEventListener('click', async () => {
    if (!window.confirm('Obrisati part "' + part.name + '"?\nOstaje 30 dana u Kanti odakle ga možeš vratiti.')) return;
    await bridge.removePart(part.id);
    await refreshParts();
    await refreshSets();
    await renderTrash();
  });
  row.appendChild(del);

  return row;
}

// ---------------------------------------------------------------------------
// Kanta (deleted parts, 30 days)
// ---------------------------------------------------------------------------

async function renderTrash() {
  const list = $('trashList');
  list.innerHTML = '';
  let items = [];
  try {
    items = typeof bridge.listTrash === 'function' ? await bridge.listTrash() : [];
  } catch (e) {
    items = [];
  }
  if (!items || items.length === 0) {
    list.appendChild(el('div', 'empty', 'Kanta je prazna.'));
    return;
  }
  for (const it of items) {
    const row = el('div', 'trash-row');
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 48;
    drawOutline(cv, { id: it.id, outline: it.outline, w: it.w, h: it.h }, 4);
    row.appendChild(cv);
    row.appendChild(el('div', 'tname', it.name + ' · ' + fmtCm(it.w) + ' × ' + fmtCm(it.h) + ' cm'));
    row.appendChild(el('div', 'tdate', 'obrisano ' + fmtDate(it.deletedAt)));
    const back = el('button', 'btn small', '↩ VRATI');
    back.addEventListener('click', async () => {
      try {
        await bridge.restorePart(it.id);
        await refreshParts();
        await renderTrash();
        showToast('Vraćeno iz Kante: ' + it.name);
      } catch (e) {
        showToast('Vraćanje nije uspjelo: ' + (e && e.message ? e.message : e));
      }
    });
    row.appendChild(back);
    list.appendChild(row);
  }
}

async function refreshParts() {
  state.parts = await bridge.listParts();
  state.partsById = {};
  for (const p of state.parts) state.partsById[p.id] = p;
  renderParts();
}

async function refreshSets() {
  const res = await bridge.listSets();
  state.sets = res.sets;
  state.activeSetId = res.activeSetId;
  renderSetBar();
  renderSetsList();
}

// Import
async function importFiles(fileList) {
  const files = [];
  for (const f of fileList) {
    if (!/\.dxf$/i.test(f.name)) continue;
    files.push({ name: f.name, content: await f.text() });
  }
  if (files.length === 0) return;
  const res = await bridge.addParts(files);
  const errBox = $('importErrors');
  if (res.errors && res.errors.length > 0) {
    errBox.hidden = false;
    errBox.textContent = res.errors.map((e) => e.name + ': ' + e.message).join(' · ');
  } else {
    errBox.hidden = true;
  }
  await refreshParts();
  // A fresh import usually deserves a look - open the inspector for the
  // first added part so mistakes are caught before nesting.
  if (res.added && res.added.length === 1) showPartModal(res.added[0]);
}

$('btnPickFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  await importFiles(e.target.files);
  e.target.value = '';
});

// A drop that misses the drop zone must never navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

const drop = $('dropZone');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  if (e.dataTransfer && e.dataTransfer.files) await importFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const s = state.settings;
  // Lengths are stored in mm, shown and typed in cm.
  $('setGap').value = fmtCm(s.gap);
  $('setMargin').value = fmtCm(s.margin);
  $('setHistTol').value = fmtCm(s.histTol);
  $('setTabsMax').value = fmtCm(s.tabsMax || 0);
  $('setSkeletonSpacing').value = fmtCm(s.skeletonSpacing || 400);
  $('setRotate').checked = !!s.allowRotate;
  $('setAutoOpen').checked = !!s.autoOpen;
  $('setFrame').checked = !!s.addFrame;
  $('setSkeleton').checked = !!s.skeleton;
  $('setScicut').value = s.scicutPath || '';
  $('setOutput').value = s.outputDir || '';
}

async function saveSettings(patch) {
  state.settings = await bridge.setSettings(patch);
  renderSettings();
  renderOffers(); // tolerance may have changed
}

/** A cm text field bound to a mm setting. */
function cmSetting(id, key) {
  $(id).addEventListener('change', () => {
    const n = parseNum($(id).value);
    if (Number.isFinite(n) && n >= 0) saveSettings({ [key]: cmToMm(n) });
    else renderSettings();
  });
}
cmSetting('setGap', 'gap');
cmSetting('setMargin', 'margin');
cmSetting('setHistTol', 'histTol');
cmSetting('setTabsMax', 'tabsMax');
cmSetting('setSkeletonSpacing', 'skeletonSpacing');
$('setRotate').addEventListener('change', () => saveSettings({ allowRotate: $('setRotate').checked }));
$('setAutoOpen').addEventListener('change', () => saveSettings({ autoOpen: $('setAutoOpen').checked }));
$('setFrame').addEventListener('change', () => saveSettings({ addFrame: $('setFrame').checked }));
$('setSkeleton').addEventListener('change', () => saveSettings({ skeleton: $('setSkeleton').checked }));
$('setScicut').addEventListener('change', () => saveSettings({ scicutPath: $('setScicut').value }));
$('setOutput').addEventListener('change', () => saveSettings({ outputDir: $('setOutput').value }));
$('btnPickExe').addEventListener('click', async () => {
  const p = await bridge.pickExe();
  if (p) saveSettings({ scicutPath: p });
});
$('btnPickDir').addEventListener('click', async () => {
  const p = await bridge.pickDir();
  if (p) saveSettings({ outputDir: p });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  if (state.history.length === 0) {
    list.appendChild(el('div', 'empty', 'Još nema generiranih ploča.'));
    return;
  }
  for (const s of state.history.slice(0, 60)) {
    const row = el('div', 'history-row');
    row.appendChild(el('div', 'hdate', fmtDate(s.date)));
    row.appendChild(el('div', 'hdims', dimsText(s)));
    row.appendChild(el('div', 'hsum',
      s.totalPlaced + ' kom · ' + Math.round((s.utilization || 0) * 100) + '%'
      + (s.variantLabel ? ' · ' + s.variantLabel : '')
      + ' · ' + (s.summary || []).map((x) => x.name + '×' + x.count).join(', ')));
    const btns = el('div', 'hbtns');
    const open = el('button', 'btn small', IS_WEB ? 'PREUZMI' : 'OTVORI');
    open.addEventListener('click', () => openSheetFeedback(s.id));
    btns.appendChild(open);
    if (!IS_WEB) {
      const save = el('button', 'btn small ghost', 'SPREMI');
      save.addEventListener('click', () => saveSheetFeedback(s.id));
      btns.appendChild(save);
    }
    const del = el('button', 'btn small danger', '✕');
    del.addEventListener('click', async () => {
      await bridge.removeHistory(s.id);
      await refreshHistory();
      renderOffers();
    });
    btns.appendChild(del);
    row.appendChild(btns);
    list.appendChild(row);
  }
}

async function refreshHistory() {
  state.history = await bridge.listHistory();
  renderHistory();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  if (!bridge) {
    $('noBridge').hidden = false;
    return;
  }
  if (IS_WEB) {
    $('rowScicut').hidden = true;
    $('rowOutput').hidden = true;
    $('rowAutoOpen').hidden = true;
    $('grpLaser').hidden = true;
    $('btnOpen').textContent = '💾 PREUZMI DXF';
    $('btnSave').hidden = true;
  }
  if (typeof bridge.onToast === 'function') bridge.onToast(showToast);
  state.settings = await bridge.getSettings();
  renderSettings();
  updateZoneUi();
  renderTrash();
  await refreshParts();
  await refreshSets();
  await refreshHistory();
  renderParts(); // re-render with sets state loaded
  renderOffers();
  try {
    const info = await bridge.appInfo();
    $('appVersion').textContent = 'v' + info.version;
  } catch { /* non-critical */ }
  $('inLen').focus();
}

init();
