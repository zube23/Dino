'use strict';

/* DinoNest renderer - vanilla JS, no dependencies. */

const $ = (id) => document.getElementById(id);

const state = {
  parts: [],
  partsById: {},
  settings: null,
  history: [],
  lastGeneratedId: null,
  selectedSheetId: null,
};

const bridge = window.dino;
const IS_WEB = !!(bridge && bridge.isWeb);
const CAN_DRAG = !!(bridge && bridge.canDrag);

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

function placementPolys(pl) {
  const part = state.partsById[pl.id];
  if (!part || !part.outline) return null;
  const polys = [];
  for (const poly of part.outline) {
    const out = [];
    for (const [px, py] of poly) {
      // Library outline is normalized to [0..w]x[0..h]; a rotated placement
      // turns the part 90 degrees CCW: (px,py) -> (h-py, px).
      const x = pl.rotated ? (part.h - py) : px;
      const y = pl.rotated ? px : py;
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
  }
}

// ---------------------------------------------------------------------------
// Machine view: generate + offers
// ---------------------------------------------------------------------------

async function generate() {
  if ($('btnGenerate').disabled) return; // already running (Enter bypasses the button)
  const width = parseNum($('inWidth').value);
  const height = parseNum($('inHeight').value);
  const status = $('genStatus');
  $('genWarn').hidden = true;
  status.hidden = false;
  status.className = 'status';

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    status.classList.add('err');
    status.textContent = 'Upišite duljinu i širinu ploče u milimetrima.';
    return;
  }

  const btn = $('btnGenerate');
  btn.disabled = true;
  status.textContent = 'Slažem ploču…';
  try {
    const res = await bridge.generate({ width, height });
    if (!res.ok) {
      status.classList.add('err');
      status.textContent = res.message || 'Generiranje nije uspjelo.';
      return;
    }
    status.hidden = true;
    state.lastGeneratedId = res.sheetId;
    await refreshHistory();
    renderOffers();
    selectSheet(res.sheetId);

    const msgs = [];
    if (res.unplaced && res.unplaced.length > 0) {
      msgs.push('NIJE STALO: ' + res.unplaced.map((u) => u.name + ' ×' + u.count).join(', '));
    }
    if (res.capped) {
      msgs.push('Dosegnut je sigurnosni limit od ' + (res.maxTotal || '') + ' komada — ploča možda nije potpuno popunjena.');
    }
    if (res.openMessage) msgs.push(res.openMessage);
    $('genWarn').textContent = msgs.join('  ·  ');
    $('genWarn').hidden = msgs.length === 0;
    if (res.opened) showToast('Otvoreno u CypCut-u: ' + res.fileName);
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
  const width = parseNum($('inWidth').value);
  const height = parseNum($('inHeight').value);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const tol = (state.settings && Number.isFinite(state.settings.histTol)) ? state.settings.histTol : 20;
  const matches = state.history.filter((s) => dimsMatch(s, width, height, tol));
  matches.sort((a, b) => {
    if (a.id === state.lastGeneratedId) return -1;
    if (b.id === state.lastGeneratedId) return 1;
    return new Date(b.date) - new Date(a.date);
  });
  return { width, height, tol, matches };
}

function sheetCard(entry) {
  const card = el('div', 'sheet-card');
  card.dataset.id = entry.id;
  if (entry.id === state.selectedSheetId) card.classList.add('selected');

  if (entry.id === state.lastGeneratedId) {
    card.appendChild(el('div', 'badge', 'NOVA'));
  }

  const cv = document.createElement('canvas');
  cv.width = 400;
  cv.height = 210;
  drawSheetEntry(cv, entry);
  card.appendChild(cv);

  card.appendChild(el('div', 'sc-line1', fmtMm(entry.width) + ' × ' + fmtMm(entry.height) + ' mm'));
  card.appendChild(el('div', 'sc-line2',
    entry.totalPlaced + ' kom · ' + Math.round((entry.utilization || 0) * 100) + '% · ' + fmtDateShort(entry.date)
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
  $('offersTitle').textContent = 'Ploče ~ ' + fmtMm(cur.width) + ' × ' + fmtMm(cur.height)
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
    fmtMm(entry.width) + ' × ' + fmtMm(entry.height) + ' mm · ' + entry.totalPlaced + ' kom · '
    + Math.round((entry.utilization || 0) * 100) + '%'));
  if (Array.isArray(entry.summary) && entry.summary.length) {
    stats.appendChild(el('div', '', entry.summary.map((s) => s.name + ' ×' + s.count).join('  ·  ')));
  }
  stats.appendChild(el('div', 'files', (entry.fileName || '') + ' · ' + fmtDate(entry.date)));
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
for (const id of ['inWidth', 'inHeight']) {
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
}

function showPartModal(part) {
  $('modalTitle').textContent = part.name;
  drawOutline($('modalCanvas'), part, 20);
  const info = [];
  info.push('Dimenzije: ' + fmtMm(part.w) + ' × ' + fmtMm(part.h) + ' mm · površina ' + (part.area / 100).toFixed(1) + ' cm²');
  if (part.entityCount) info.push('Učitano entiteta: ' + part.entityCount);
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

function partRow(part) {
  const row = el('div', 'part-row' + (part.enabled ? '' : ' disabled'));

  const thumb = document.createElement('canvas');
  thumb.className = 'part-thumb';
  thumb.width = 84;
  thumb.height = 62;
  thumb.title = 'Klikni za veliki pregled';
  drawOutline(thumb, part);
  thumb.addEventListener('click', () => showPartModal(part));
  row.appendChild(thumb);

  const main = el('div', 'part-main');
  const nameInput = document.createElement('input');
  nameInput.value = part.name;
  nameInput.title = 'Naziv parta';
  nameInput.addEventListener('change', () => update(part.id, { name: nameInput.value }));
  main.appendChild(nameInput);
  const dims = el('div', 'part-dims');
  dims.appendChild(document.createTextNode(fmtMm(part.w) + ' × ' + fmtMm(part.h) + ' mm · ' + (part.area / 100).toFixed(1) + ' cm²'));
  if (part.warnings && part.warnings.length) {
    dims.appendChild(document.createTextNode(' · '));
    const wlink = el('span', 'link', '⚠ ' + part.warnings.length + ' upozorenja');
    wlink.addEventListener('click', () => showPartModal(part));
    dims.appendChild(wlink);
  }
  main.appendChild(dims);
  row.appendChild(main);

  // Priority
  const prio = el('label', 'part-field');
  prio.appendChild(el('span', '', 'Prioritet (1 = prvi)'));
  const prioIn = document.createElement('input');
  prioIn.type = 'number';
  prioIn.min = '1';
  prioIn.max = '99';
  prioIn.value = part.priority;
  prioIn.addEventListener('change', () => update(part.id, { priority: prioIn.value }));
  prio.appendChild(prioIn);
  row.appendChild(prio);

  // Mode
  const mode = el('label', 'part-field');
  mode.appendChild(el('span', '', 'Način'));
  const modeSel = document.createElement('select');
  for (const [v, t] of [['fixed', 'Točan broj'], ['filler', 'Popuna']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    if (part.mode === v) o.selected = true;
    modeSel.appendChild(o);
  }
  modeSel.addEventListener('change', () => update(part.id, { mode: modeSel.value }));
  mode.appendChild(modeSel);
  row.appendChild(mode);

  // Count / maxCount
  const cnt = el('label', 'part-field');
  const isFiller = part.mode === 'filler';
  cnt.appendChild(el('span', '', isFiller ? 'Maks. (0 = koliko stane)' : 'Broj komada'));
  const cntIn = document.createElement('input');
  cntIn.type = 'number';
  cntIn.min = '0';
  cntIn.value = isFiller ? (part.maxCount || 0) : part.count;
  cntIn.addEventListener('change', () => update(part.id, isFiller ? { maxCount: cntIn.value } : { count: cntIn.value }));
  cnt.appendChild(cntIn);
  row.appendChild(cnt);

  // Enabled
  const en = el('label', 'part-field check');
  const enIn = document.createElement('input');
  enIn.type = 'checkbox';
  enIn.checked = !!part.enabled;
  enIn.addEventListener('change', () => update(part.id, { enabled: enIn.checked }));
  en.appendChild(enIn);
  en.appendChild(el('span', '', 'Uključen'));
  row.appendChild(en);

  // Delete
  const del = el('button', 'btn small danger', '✕');
  del.title = 'Obriši part';
  del.addEventListener('click', async () => {
    await bridge.removePart(part.id);
    await refreshParts();
  });
  row.appendChild(del);

  return row;
}

async function update(id, patch) {
  await bridge.updatePart(id, patch);
  await refreshParts();
}

async function refreshParts() {
  state.parts = await bridge.listParts();
  state.partsById = {};
  for (const p of state.parts) state.partsById[p.id] = p;
  renderParts();
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
    row.appendChild(el('div', 'hdims', fmtMm(s.width) + ' × ' + fmtMm(s.height) + ' mm'));
    row.appendChild(el('div', 'hsum',
      s.totalPlaced + ' kom · ' + Math.round((s.utilization || 0) * 100) + '% · '
      + (s.summary || []).map((x) => x.name + '×' + x.count).join(', ')));
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
    $('btnOpen').textContent = '💾 PREUZMI DXF';
    $('btnSave').hidden = true;
  }
  if (typeof bridge.onToast === 'function') bridge.onToast(showToast);
  state.settings = await bridge.getSettings();
  renderSettings();
  await refreshParts();
  await refreshHistory();
  renderOffers();
  try {
    const info = await bridge.appInfo();
    $('appVersion').textContent = 'v' + info.version;
  } catch { /* non-critical */ }
  $('inWidth').focus();
}

init();
