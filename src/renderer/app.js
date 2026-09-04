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
};

const bridge = window.dino;
const IS_WEB = !!(bridge && bridge.isWeb);
const CAN_DRAG = !!(bridge && bridge.canDrag);

const VARIANT_BADGE = {
  prioriteti: '1 · PRIORITETI',
  krupno: '2 · KRUPNO',
  sitno: '3 · SITNO',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNum(text) {
  if (typeof text !== 'string') return NaN;
  let t = text.trim();
  if (t === '') return NaN;
  // "2.000" is a Croatian thousands notation, not 2 millimeters.
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  return Number(t);
}

function fmtMm(n) {
  // No thousands grouping - the shown value must round-trip through parseNum.
  return String(Math.round(n * 10) / 10).replace('.', ',');
}

/** Sheets display as DULJINA x ŠIRINA (the machine's long side first = Y). */
function dimsText(entry) {
  return fmtMm(entry.height) + ' × ' + fmtMm(entry.width) + ' mm';
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

function drawSheetEntry(canvas, entry) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pad = Math.max(8, Math.round(W * 0.02));
  const scale = Math.min((W - 2 * pad) / entry.width, (H - 2 * pad) / entry.height);
  const ox = (W - entry.width * scale) / 2;
  const oy = (H - entry.height * scale) / 2;
  const tx = (x) => ox + x * scale;
  const ty = (y) => H - oy - y * scale; // flip Y (DXF Y is up)

  ctx.fillStyle = '#242c37';
  ctx.strokeStyle = '#5b6b7f';
  ctx.lineWidth = Math.max(1, W / 700);
  ctx.fillRect(tx(0), ty(entry.height), entry.width * scale, entry.height * scale);
  ctx.strokeRect(tx(0), ty(entry.height), entry.width * scale, entry.height * scale);

  if (!Array.isArray(entry.placements) || entry.placements.length === 0) {
    ctx.fillStyle = '#8b98a8';
    ctx.font = Math.round(W / 30) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('stara ploča — samo datoteka', W / 2, H / 2);
    return;
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

async function generate() {
  if ($('btnGenerate').disabled) return; // already running (Enter bypasses the button)
  const len = parseNum($('inLen').value);   // DULJINA -> Y (sheetH)
  const wid = parseNum($('inWid').value);   // ŠIRINA  -> X (sheetW)
  const status = $('genStatus');
  $('genWarn').hidden = true;
  status.hidden = false;
  status.className = 'status';

  if (!Number.isFinite(len) || !Number.isFinite(wid) || len <= 0 || wid <= 0) {
    status.classList.add('err');
    status.textContent = 'Upišite duljinu i širinu ploče u milimetrima.';
    return;
  }

  const btn = $('btnGenerate');
  btn.disabled = true;
  status.textContent = 'Slažem 3 varijante ploče…';
  try {
    const res = await bridge.generate({ width: wid, height: len });
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
    if (res.openMessage) {
      $('genWarn').textContent = res.openMessage;
      $('genWarn').hidden = false;
    }
    if (res.opened) showToast('Otvoreno u CypCut-u: ' + res.sheets[0].fileName);
  } catch (e) {
    status.classList.add('err');
    status.textContent = 'Greška: ' + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
}

function dimsMatch(entry, w, h, tol) {
  const close = (a, b) => Math.abs(a - b) <= tol;
  return (close(entry.width, w) && close(entry.height, h))
    || (close(entry.width, h) && close(entry.height, w));
}

function currentMatches() {
  const len = parseNum($('inLen').value);
  const wid = parseNum($('inWid').value);
  if (!Number.isFinite(len) || !Number.isFinite(wid) || len <= 0 || wid <= 0) return null;
  const tol = (state.settings && Number.isFinite(state.settings.histTol)) ? state.settings.histTol : 20;
  const matches = state.history.filter((s) => dimsMatch(s, wid, len, tol));
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

  if (entry.batch && entry.batch === state.lastBatch) {
    card.appendChild(el('div', 'badge', VARIANT_BADGE[entry.variant] || 'NOVA'));
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
  $('offersTitle').textContent = 'Ploče ~ ' + fmtMm(cur.len) + ' × ' + fmtMm(cur.wid)
    + ' mm (±' + fmtMm(cur.tol) + ' mm) — ' + cur.matches.length + ' kom';
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
  drawSheetEntry($('preview'), entry);

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

$('btnGenerate').addEventListener('click', generate);
for (const id of ['inLen', 'inWid']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat) generate();
  });
  $(id).addEventListener('input', renderOffers);
}
$('btnOpen').addEventListener('click', () => {
  if (state.selectedSheetId) openSheetFeedback(state.selectedSheetId);
});
$('btnSave').addEventListener('click', () => {
  if (state.selectedSheetId) saveSheetFeedback(state.selectedSheetId);
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
  info.push('Dimenzije: ' + fmtMm(part.w) + ' × ' + fmtMm(part.h) + ' mm · površina ' + (part.area / 100).toFixed(1) + ' cm²');
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
    b.appendChild(el('span', '', p.name + ' (' + fmtMm(p.w) + '×' + fmtMm(p.h) + ')'
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
  dims.appendChild(document.createTextNode(fmtMm(part.w) + ' × ' + fmtMm(part.h) + ' mm'));
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

  // Delete (with confirmation - a slip here would lose the drawing)
  const del = el('button', 'btn small danger', '✕');
  del.title = 'Obriši part';
  del.addEventListener('click', async () => {
    if (!window.confirm('Obrisati part "' + part.name + '" iz programa?\nOvo briše i njegov DXF iz biblioteke.')) return;
    await bridge.removePart(part.id);
    await refreshParts();
    await refreshSets();
  });
  row.appendChild(del);

  return row;
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
  $('setGap').value = String(s.gap).replace('.', ',');
  $('setMargin').value = String(s.margin).replace('.', ',');
  $('setHistTol').value = String(s.histTol).replace('.', ',');
  $('setRotate').checked = !!s.allowRotate;
  $('setAutoOpen').checked = !!s.autoOpen;
  $('setFrame').checked = !!s.addFrame;
  $('setScicut').value = s.scicutPath || '';
  $('setOutput').value = s.outputDir || '';
}

async function saveSettings(patch) {
  state.settings = await bridge.setSettings(patch);
  renderSettings();
  renderOffers(); // tolerance may have changed
}

function numSetting(id, key) {
  $(id).addEventListener('change', () => {
    const n = parseNum($(id).value);
    if (Number.isFinite(n)) saveSettings({ [key]: n });
    else renderSettings();
  });
}
numSetting('setGap', 'gap');
numSetting('setMargin', 'margin');
numSetting('setHistTol', 'histTol');
$('setRotate').addEventListener('change', () => saveSettings({ allowRotate: $('setRotate').checked }));
$('setAutoOpen').addEventListener('change', () => saveSettings({ autoOpen: $('setAutoOpen').checked }));
$('setFrame').addEventListener('change', () => saveSettings({ addFrame: $('setFrame').checked }));
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
