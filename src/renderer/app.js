'use strict';

/* DinoNest renderer - vanilla JS, no dependencies. */

const $ = (id) => document.getElementById(id);

const state = {
  parts: [],
  settings: null,
  history: [],
  lastResult: null,
};

const bridge = window.dino;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNum(text) {
  if (typeof text !== 'string') return NaN;
  const t = text.trim().replace(',', '.');
  if (t === '') return NaN;
  return Number(t);
}

function fmtMm(n) {
  return (Math.round(n * 10) / 10).toLocaleString('hr-HR');
}

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear()
    + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
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
// Machine view
// ---------------------------------------------------------------------------

async function generate() {
  const width = parseNum($('inWidth').value);
  const height = parseNum($('inHeight').value);
  const status = $('genStatus');
  $('result').hidden = true;
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
    state.lastResult = res;
    status.hidden = true;
    renderResult(res);
    await refreshHistory();
    renderPrevSheets();
  } catch (e) {
    status.classList.add('err');
    status.textContent = 'Greška: ' + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
}

function renderResult(res) {
  $('result').hidden = false;
  drawSheet($('preview'), res);

  const stats = $('stats');
  stats.innerHTML = '';
  const line1 = el('div', 'big',
    res.totalPlaced + ' kom · iskoristivost ' + Math.round(res.utilization * 100) + '%'
    + ' · ' + (res.elapsedMs < 1000 ? res.elapsedMs + ' ms' : (res.elapsedMs / 1000).toFixed(1) + ' s'));
  stats.appendChild(line1);
  const parts = res.summary.map((s) => s.name + ' ×' + s.count).join('  ·  ');
  stats.appendChild(el('div', '', parts));
  const fileLine = el('div', 'files', res.dxfPath + (res.opened ? '  →  otvoreno' : ''));
  stats.appendChild(fileLine);

  const warn = $('unplacedWarn');
  if (res.unplaced && res.unplaced.length > 0) {
    warn.hidden = false;
    warn.textContent = 'NIJE STALO: ' + res.unplaced.map((u) => u.name + ' ×' + u.count).join(', ');
  } else {
    warn.hidden = true;
  }
  if (res.openMessage) {
    warn.hidden = false;
    warn.textContent = ((warn.textContent || '') + '  ' + res.openMessage).trim();
  }
}

function drawSheet(canvas, res) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pad = 20;
  const scale = Math.min((W - 2 * pad) / res.width, (H - 2 * pad) / res.height);
  const ox = (W - res.width * scale) / 2;
  const oy = (H - res.height * scale) / 2;
  const tx = (x) => ox + x * scale;
  const ty = (y) => H - oy - y * scale; // flip Y (DXF Y is up)

  // Sheet
  ctx.fillStyle = '#242c37';
  ctx.strokeStyle = '#5b6b7f';
  ctx.lineWidth = 2;
  ctx.fillRect(tx(0), ty(res.height), res.width * scale, res.height * scale);
  ctx.strokeRect(tx(0), ty(res.height), res.width * scale, res.height * scale);

  // Parts
  for (const pl of res.placements) {
    const color = colorFor(pl.id);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (const poly of pl.outline) {
      if (poly.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(tx(poly[0][0]), ty(poly[0][1]));
      for (let i = 1; i < poly.length; i++) ctx.lineTo(tx(poly[i][0]), ty(poly[i][1]));
      ctx.stroke();
    }
  }

  // Dimension labels
  ctx.fillStyle = '#8b98a8';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(fmtMm(res.width) + ' mm', W / 2, ty(0) + 16);
  ctx.save();
  ctx.translate(tx(0) - 8, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(fmtMm(res.height) + ' mm', 0, 0);
  ctx.restore();
}

function renderPrevSheets() {
  const box = $('prevSheets');
  const width = parseNum($('inWidth').value);
  const height = parseNum($('inHeight').value);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    box.hidden = true;
    return;
  }
  const tol = 0.5;
  const matches = state.history.filter((s) => Math.abs(s.width - width) < tol && Math.abs(s.height - height) < tol);
  if (matches.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  box.appendChild(el('div', '', 'Za ' + fmtMm(width) + ' × ' + fmtMm(height)
    + ' mm već postoji ' + matches.length + ' generirana ploča:'));
  const row = el('div', 'row');
  for (const m of matches.slice(0, 4)) {
    const b = el('button', 'btn small ghost',
      fmtDate(m.date) + ' · ' + m.totalPlaced + ' kom · OTVORI');
    b.addEventListener('click', () => bridge.openFile(m.dxfPath));
    row.appendChild(b);
  }
  box.appendChild(row);
}

$('btnGenerate').addEventListener('click', generate);
for (const id of ['inWidth', 'inHeight']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') generate();
  });
  $(id).addEventListener('input', renderPrevSheets);
}
$('btnOpen').addEventListener('click', () => {
  if (state.lastResult) bridge.openFile(state.lastResult.dxfPath);
});
$('btnFolder').addEventListener('click', () => {
  if (state.lastResult) bridge.showInFolder(state.lastResult.dxfPath);
});

// ---------------------------------------------------------------------------
// Parts (prep view)
// ---------------------------------------------------------------------------

function drawThumb(canvas, part) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!part.outline || part.w <= 0 || part.h <= 0) return;
  const pad = 6;
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

function renderParts() {
  const list = $('partsList');
  list.innerHTML = '';
  if (state.parts.length === 0) {
    list.appendChild(el('div', 'empty', 'Još nema partova. Dodajte DXF datoteke iznad.'));
    return;
  }
  const sorted = state.parts.slice().sort((a, b) => (a.priority - b.priority) || (b.area - a.area));
  for (const part of sorted) {
    list.appendChild(partRow(part));
  }
}

function partRow(part) {
  const row = el('div', 'part-row' + (part.enabled ? '' : ' disabled'));

  const thumb = document.createElement('canvas');
  thumb.className = 'part-thumb';
  thumb.width = 96;
  thumb.height = 72;
  drawThumb(thumb, part);
  row.appendChild(thumb);

  const main = el('div', 'part-main');
  const nameInput = document.createElement('input');
  nameInput.value = part.name;
  nameInput.title = 'Naziv parta';
  nameInput.addEventListener('change', () => update(part.id, { name: nameInput.value }));
  main.appendChild(nameInput);
  main.appendChild(el('div', 'part-dims',
    fmtMm(part.w) + ' × ' + fmtMm(part.h) + ' mm'
    + (part.warnings && part.warnings.length ? ' · ⚠ ' + part.warnings.length + ' upozorenja' : '')));
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
  cnt.appendChild(el('span', '', isFiller ? 'Maks. kom (0 = koliko stane)' : 'Broj komada'));
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

  // Area info
  row.appendChild(el('div', 'part-dims', (part.area / 100).toFixed(1) + ' cm²'));

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
}

$('btnPickFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  await importFiles(e.target.files);
  e.target.value = '';
});

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
  $('setRotate').checked = !!s.allowRotate;
  $('setAutoOpen').checked = !!s.autoOpen;
  $('setFrame').checked = !!s.addFrame;
  $('setScicut').value = s.scicutPath || '';
  $('setOutput').value = s.outputDir || '';
}

async function saveSettings(patch) {
  state.settings = await bridge.setSettings(patch);
  renderSettings();
}

$('setGap').addEventListener('change', () => {
  const n = parseNum($('setGap').value);
  if (Number.isFinite(n)) saveSettings({ gap: n });
  else renderSettings();
});
$('setMargin').addEventListener('change', () => {
  const n = parseNum($('setMargin').value);
  if (Number.isFinite(n)) saveSettings({ margin: n });
  else renderSettings();
});
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
  for (const s of state.history.slice(0, 50)) {
    const row = el('div', 'history-row');
    row.appendChild(el('div', '', fmtDate(s.date)));
    row.appendChild(el('div', 'hdims', fmtMm(s.width) + ' × ' + fmtMm(s.height) + ' mm'));
    row.appendChild(el('div', 'hsum',
      s.totalPlaced + ' kom · ' + (s.summary || []).map((x) => x.name + '×' + x.count).join(', ')));
    row.appendChild(el('div', '', Math.round((s.utilization || 0) * 100) + '%'));
    const btns = el('div', 'hbtns');
    const open = el('button', 'btn small', 'OTVORI');
    open.addEventListener('click', () => bridge.openFile(s.dxfPath));
    const folder = el('button', 'btn small ghost', 'MAPA');
    folder.addEventListener('click', () => bridge.showInFolder(s.dxfPath));
    const del = el('button', 'btn small danger', '✕');
    del.addEventListener('click', async () => {
      await bridge.removeHistory(s.id);
      await refreshHistory();
    });
    btns.appendChild(open);
    btns.appendChild(folder);
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
  state.settings = await bridge.getSettings();
  renderSettings();
  await refreshParts();
  await refreshHistory();
  try {
    const info = await bridge.appInfo();
    $('appVersion').textContent = 'v' + info.version;
  } catch { /* non-critical */ }
  $('inWidth').focus();
}

init();
