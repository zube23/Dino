'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage,
} = require('electron');

const {
  analyzePart, applySet, buildSheetDxf, generateVariants,
} = require('../src/core/parts');

let win = null;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const dataDir = () => app.getPath('userData');
const partsDir = () => path.join(dataDir(), 'parts');
const tempDir = () => path.join(dataDir(), 'temp');
const libraryFile = () => path.join(dataDir(), 'library.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');
const setsFile = () => path.join(dataDir(), 'sets.json');

const DEFAULT_SETTINGS = {
  gap: 8,          // razmak između partova (mm)
  margin: 10,      // rub ploče (mm)
  histTol: 20,     // tolerancija za ponude ploča istih dimenzija (mm)
  allowRotate: true,
  autoOpen: false, // odmah otvori generiranu ploču u CypCut-u
  addFrame: false, // dodaj okvir ploče u DXF (layer PLOCA)
  scicutPath: '',  // putanja do CypCut/SciCut .exe (prazno = zadana aplikacija)
  outputDir: '',   // zadana mapa za "Spremi DXF"
  winBounds: null, // zadnja veličina/pozicija prozora
};

function ensureDirs() {
  for (const dir of [dataDir(), partsDir(), tempDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanTempDir() {
  // Sheets are materialized on demand; anything older than a week is junk.
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(tempDir())) {
      const p = path.join(tempDir(), f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* skip */ }
    }
  } catch { /* temp dir missing */ }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function loadLibrary() {
  const lib = readJson(libraryFile(), { parts: [] });
  if (!Array.isArray(lib.parts)) lib.parts = [];
  return lib;
}

function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
}

function saveSettings(s) {
  writeJson(settingsFile(), s);
}

function loadHistory() {
  const h = readJson(historyFile(), { sheets: [] });
  if (!Array.isArray(h.sheets)) h.sheets = [];
  return h;
}

function loadSets() {
  const s = readJson(setsFile(), { sets: [], activeSetId: null });
  if (!Array.isArray(s.sets)) s.sets = [];
  for (const set of s.sets) {
    if (!set.items || typeof set.items !== 'object') set.items = {};
  }
  if (s.activeSetId && !s.sets.some((x) => x.id === s.activeSetId)) s.activeSetId = null;
  return s;
}

function saveSets(s) {
  writeJson(setsFile(), s);
}

const PAIR_MIRRORED = ['priority', 'mode', 'count', 'maxCount'];

function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeName(name) {
  // Keep Unicode letters/digits so Croatian names (č, ć, š, đ, ž) survive.
  return String(name || 'part').replace(/[^\p{L}\p{N}.\-_ ]+/gu, '_').slice(0, 80);
}

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9]+$/i.test(id);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Sheet materialization: history stores only placements (a few KB); the DXF
// file is (re)created in temp/ the moment it is opened, dragged or saved.
// ---------------------------------------------------------------------------

function partsForPlacements(placements) {
  const lib = loadLibrary();
  const ids = [...new Set(placements.map((p) => p.id))];
  const parts = [];
  for (const id of ids) {
    const entry = lib.parts.find((p) => p.id === id);
    if (!entry) throw new Error('Part iz ove ploče je u međuvremenu obrisan iz biblioteke.');
    let content;
    try {
      content = fs.readFileSync(path.join(partsDir(), id + '.dxf'), 'utf8');
    } catch {
      throw new Error('Nedostaje DXF datoteka parta "' + entry.name + '".');
    }
    parts.push({ ...entry, content });
  }
  return parts;
}

function materializeSheet(entry) {
  // Legacy entries (v1.0) point at a permanently saved file.
  if (entry.dxfPath && fs.existsSync(entry.dxfPath)) return entry.dxfPath;
  if (!Array.isArray(entry.placements) || entry.placements.length === 0) {
    throw new Error('Za ovu staru ploču ne postoji ni datoteka ni zapis - generirajte je ponovno.');
  }
  ensureDirs();
  const file = path.join(tempDir(), entry.fileName || ('Ploca_' + entry.id + '.dxf'));
  if (fs.existsSync(file)) return file;
  const dxf = buildSheetDxf({
    parts: partsForPlacements(entry.placements),
    placements: entry.placements,
    sheetW: entry.width,
    sheetH: entry.height,
    addFrame: !!entry.addFrame,
  });
  fs.writeFileSync(file, dxf, 'utf8');
  return file;
}

function findSheet(id) {
  const entry = loadHistory().sheets.find((s) => s.id === id);
  if (!entry) throw new Error('Ploča ne postoji u povijesti.');
  return entry;
}

// ---------------------------------------------------------------------------
// Opening in CypCut / default DXF application
// ---------------------------------------------------------------------------

async function openDxf(dxfPath, settings) {
  const exe = settings.scicutPath && settings.scicutPath.trim();
  if (exe) {
    if (!fs.existsSync(exe)) {
      return { ok: false, message: 'CypCut nije pronađen na: ' + exe };
    }
    // spawn reports launch failures (EACCES, corrupt exe...) asynchronously
    // via the 'error' event - without a listener that would crash the app.
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      try {
        const child = spawn(exe, [dxfPath], { detached: true, stdio: 'ignore' });
        child.once('error', (e) => finish({ ok: false, message: 'Ne mogu pokrenuti CypCut: ' + e.message }));
        child.once('spawn', () => {
          child.unref();
          finish({ ok: true });
        });
      } catch (e) {
        finish({ ok: false, message: 'Ne mogu pokrenuti CypCut: ' + e.message });
      }
    });
  }
  const err = await shell.openPath(dxfPath);
  if (err) {
    return {
      ok: false,
      message: 'Ne mogu otvoriti DXF (' + err + '). Postavite putanju do CypCut programa u Postavkama.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// IPC: parts
// ---------------------------------------------------------------------------

ipcMain.handle('parts:list', () => loadLibrary().parts);

ipcMain.handle('parts:add', (ev, files) => {
  ensureDirs();
  const lib = loadLibrary();
  const added = [];
  const errors = [];
  for (const f of files || []) {
    const name = sanitizeName(f && f.name ? f.name.replace(/\.dxf$/i, '') : 'part');
    try {
      const content = String(f.content || '');
      const info = analyzePart(content);
      const id = newId();
      fs.writeFileSync(path.join(partsDir(), id + '.dxf'), content, 'utf8');
      const entry = {
        id,
        name,
        priority: 5,
        mode: 'filler', // 'filler' (default) | 'fixed'
        count: 1,
        maxCount: 0,
        pairId: null,
        enabled: true,
        preRotDeg: info.preRotDeg,
        w: Math.round(info.w * 1000) / 1000,
        h: Math.round(info.h * 1000) / 1000,
        area: Math.round(info.area * 1000) / 1000,
        outline: info.outline,
        texts: info.texts,
        warnings: info.warnings,
        entityCount: info.entityCount,
        createdAt: new Date().toISOString(),
      };
      lib.parts.push(entry);
      added.push(entry);
    } catch (e) {
      errors.push({ name, message: e && e.message ? e.message : String(e) });
    }
  }
  writeJson(libraryFile(), lib);
  return { added, errors };
});

const EDITABLE_FIELDS = new Set(['name', 'priority', 'mode', 'count', 'maxCount', 'enabled']);

function applyPartPatch(entry, patch) {
  const changed = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE_FIELDS.has(k)) continue;
    if (k === 'name') entry.name = sanitizeName(v);
    else if (k === 'mode') entry.mode = v === 'fixed' ? 'fixed' : 'filler';
    else if (k === 'enabled') entry.enabled = !!v;
    else {
      const n = Math.floor(Number(v));
      if (k === 'priority') entry.priority = Math.min(99, Math.max(1, Number.isFinite(n) ? n : 5));
      if (k === 'count') entry.count = Math.min(999, Math.max(0, Number.isFinite(n) ? n : 1));
      if (k === 'maxCount') entry.maxCount = Math.min(9999, Math.max(0, Number.isFinite(n) ? n : 0));
    }
    if (PAIR_MIRRORED.indexOf(k) !== -1) changed[k] = entry[k];
  }
  return changed;
}

ipcMain.handle('parts:update', (ev, id, patch) => {
  if (!validId(id)) throw new Error('Neispravan ID parta.');
  const lib = loadLibrary();
  const entry = lib.parts.find((p) => p.id === id);
  if (!entry) throw new Error('Part ne postoji.');
  const mirrored = applyPartPatch(entry, patch);
  // Paired parts share priority/mode/count so the pair stays consistent.
  if (entry.pairId && Object.keys(mirrored).length > 0) {
    const partner = lib.parts.find((p) => p.id === entry.pairId);
    if (partner) Object.assign(partner, mirrored);
  }
  writeJson(libraryFile(), lib);
  return entry;
});

ipcMain.handle('parts:pair', (ev, idA, idB) => {
  if (!validId(idA)) throw new Error('Neispravan ID parta.');
  const lib = loadLibrary();
  const a = lib.parts.find((p) => p.id === idA);
  if (!a) throw new Error('Part ne postoji.');
  // Unlink whatever A was paired with before.
  if (a.pairId) {
    const old = lib.parts.find((p) => p.id === a.pairId);
    if (old) old.pairId = null;
    a.pairId = null;
  }
  if (idB) {
    if (!validId(idB) || idB === idA) throw new Error('Neispravan par.');
    const b = lib.parts.find((p) => p.id === idB);
    if (!b) throw new Error('Part za uparivanje ne postoji.');
    if (b.pairId) {
      const old = lib.parts.find((p) => p.id === b.pairId);
      if (old) old.pairId = null;
    }
    a.pairId = b.id;
    b.pairId = a.id;
    // The pair shares settings - take them from the part being linked.
    for (const k of PAIR_MIRRORED) b[k] = a[k];
  }
  writeJson(libraryFile(), lib);
  return lib.parts;
});

ipcMain.handle('parts:remove', (ev, id) => {
  if (!validId(id)) throw new Error('Neispravan ID parta.');
  const lib = loadLibrary();
  const entry = lib.parts.find((p) => p.id === id);
  if (entry && entry.pairId) {
    const partner = lib.parts.find((p) => p.id === entry.pairId);
    if (partner) partner.pairId = null;
  }
  lib.parts = lib.parts.filter((p) => p.id !== id);
  writeJson(libraryFile(), lib);
  // Drop the part from every set as well.
  const sets = loadSets();
  let setsTouched = false;
  for (const s of sets.sets) {
    if (s.items[id]) {
      delete s.items[id];
      setsTouched = true;
    }
  }
  if (setsTouched) saveSets(sets);
  try {
    fs.unlinkSync(path.join(partsDir(), id + '.dxf'));
  } catch { /* already gone */ }
  return true;
});

// ---------------------------------------------------------------------------
// IPC: sets (work profiles - one active at a time)
// ---------------------------------------------------------------------------

ipcMain.handle('sets:list', () => loadSets());

ipcMain.handle('sets:create', (ev, name) => {
  const s = loadSets();
  const set = { id: newId(), name: sanitizeName(name || ('Set ' + (s.sets.length + 1))), items: {} };
  s.sets.push(set);
  s.activeSetId = set.id;
  saveSets(s);
  return s;
});

ipcMain.handle('sets:rename', (ev, id, name) => {
  const s = loadSets();
  const set = s.sets.find((x) => x.id === id);
  if (!set) throw new Error('Set ne postoji.');
  set.name = sanitizeName(name);
  saveSets(s);
  return s;
});

ipcMain.handle('sets:remove', (ev, id) => {
  const s = loadSets();
  s.sets = s.sets.filter((x) => x.id !== id);
  if (s.activeSetId === id) s.activeSetId = null;
  saveSets(s);
  return s;
});

// Only one set can be active - activating one deactivates the previous.
ipcMain.handle('sets:activate', (ev, id) => {
  const s = loadSets();
  s.activeSetId = (id && s.sets.some((x) => x.id === id)) ? id : null;
  saveSets(s);
  return s;
});

ipcMain.handle('sets:setItem', (ev, setId, partId, patch) => {
  if (!validId(partId)) throw new Error('Neispravan ID parta.');
  const s = loadSets();
  const set = s.sets.find((x) => x.id === setId);
  if (!set) throw new Error('Set ne postoji.');
  const lib = loadLibrary();
  const part = lib.parts.find((p) => p.id === partId);
  if (!part) throw new Error('Part ne postoji.');
  if (patch === null) {
    delete set.items[partId];
    if (part.pairId) delete set.items[part.pairId];
  } else {
    const base = set.items[partId]
      || { priority: part.priority, mode: part.mode, count: part.count, maxCount: part.maxCount };
    const merged = { ...base };
    for (const k of PAIR_MIRRORED) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
        const n = Math.floor(Number(patch[k]));
        if (k === 'mode') merged.mode = patch.mode === 'fixed' ? 'fixed' : 'filler';
        else if (k === 'priority') merged.priority = Math.min(99, Math.max(1, Number.isFinite(n) ? n : 5));
        else if (k === 'count') merged.count = Math.min(999, Math.max(0, Number.isFinite(n) ? n : 1));
        else if (k === 'maxCount') merged.maxCount = Math.min(9999, Math.max(0, Number.isFinite(n) ? n : 0));
      }
    }
    set.items[partId] = merged;
    // Pairs enter/leave sets together and share settings.
    if (part.pairId && lib.parts.some((p) => p.id === part.pairId)) {
      set.items[part.pairId] = { ...merged };
    }
  }
  saveSets(s);
  return s;
});

// ---------------------------------------------------------------------------
// IPC: settings
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (ev, patch) => {
  const s = { ...loadSettings() };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k === 'winBounds') continue;
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      if (k === 'gap' || k === 'margin' || k === 'histTol') {
        const n = Number(patch[k]);
        s[k] = Number.isFinite(n) ? Math.min(k === 'histTol' ? 500 : 100, Math.max(0, n)) : s[k];
      } else if (k === 'allowRotate' || k === 'autoOpen' || k === 'addFrame') {
        s[k] = !!patch[k];
      } else {
        s[k] = String(patch[k] || '');
      }
    }
  }
  saveSettings(s);
  return s;
});

// ---------------------------------------------------------------------------
// IPC: generate + sheets
// ---------------------------------------------------------------------------

ipcMain.handle('nest:generate', async (ev, req) => {
  ensureDirs();
  const width = Number(req && req.width);
  const height = Number(req && req.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, message: 'Upišite ispravnu duljinu i širinu ploče (mm).' };
  }
  if (width > 100000 || height > 100000) {
    return { ok: false, message: 'Dimenzije ploče su prevelike.' };
  }

  const settings = loadSettings();
  const lib = loadLibrary();
  const setsState = loadSets();
  const activeSet = setsState.sets.find((s) => s.id === setsState.activeSetId) || null;
  const effective = applySet(lib.parts, activeSet);
  if (effective.length === 0) {
    return {
      ok: false,
      message: activeSet
        ? 'Aktivni set "' + activeSet.name + '" je prazan. Dodajte partove u set u PRIPREMI.'
        : 'Nema uključenih partova. Dodajte ih u PRIPREMI.',
    };
  }

  const parts = [];
  for (const p of effective) {
    let content;
    try {
      content = fs.readFileSync(path.join(partsDir(), p.id + '.dxf'), 'utf8');
    } catch {
      return { ok: false, message: 'Nedostaje DXF datoteka parta "' + p.name + '".' };
    }
    parts.push({ ...p, content });
  }

  let variants;
  const t0 = Date.now();
  try {
    variants = generateVariants({
      sheetW: width,
      sheetH: height,
      margin: settings.margin,
      gap: settings.gap,
      allowRotate: settings.allowRotate,
      addFrame: settings.addFrame,
      parts,
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
  const elapsedMs = Date.now() - t0;

  if (variants.length === 0) {
    return {
      ok: false,
      message: 'Ništa ne stane na ploču ' + height + ' x ' + width + ' mm. Provjerite dimenzije i rub.',
    };
  }

  const now = new Date();
  const batch = newId();
  const stamp = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
    + '_' + pad2(now.getHours()) + '-' + pad2(now.getMinutes()) + '-' + pad2(now.getSeconds());

  const entries = [];
  const sheets = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const result = variants[vi];
    const id = newId();
    // File name reads duljina x širina (Y x X).
    const fileName = 'Ploca_' + Math.round(height) + 'x' + Math.round(width)
      + '_' + stamp + '_v' + (vi + 1) + '_' + id.slice(-4) + '.dxf';
    entries.push({
      id,
      batch,
      variant: result.variant,
      variantLabel: result.variantLabel,
      date: now.toISOString(),
      width,
      height,
      fileName,
      addFrame: !!settings.addFrame,
      setName: activeSet ? activeSet.name : null,
      placements: result.placements.map((pl) => ({
        id: pl.id,
        x: Math.round(pl.x * 1000) / 1000,
        y: Math.round(pl.y * 1000) / 1000,
        w: Math.round(pl.w * 1000) / 1000,
        h: Math.round(pl.h * 1000) / 1000,
        rotated: pl.rotated,
        turn: pl.turn,
        rotDeg: pl.rotDeg,
        dx: pl.dx,
        dy: pl.dy,
      })),
      summary: result.summary,
      unplaced: result.unplaced,
      notes: result.notes,
      utilization: Math.round(result.utilization * 1000) / 1000,
      totalPlaced: result.totalPlaced,
      capped: result.capped,
    });
    sheets.push({
      sheetId: id,
      batch,
      variant: result.variant,
      variantLabel: result.variantLabel,
      fileName,
      unplaced: result.unplaced,
      notes: result.notes,
      summary: result.summary,
      utilization: result.utilization,
      totalPlaced: result.totalPlaced,
      capped: result.capped,
      maxTotal: result.maxTotal,
    });
  }

  const history = loadHistory();
  history.sheets = entries.concat(history.sheets).slice(0, 200);
  writeJson(historyFile(), history);

  let opened = false;
  let openMessage = '';
  if (settings.autoOpen) {
    try {
      const p = materializeSheet(entries[0]);
      const r = await openDxf(p, settings);
      opened = r.ok;
      openMessage = r.message || '';
    } catch (e) {
      openMessage = e && e.message ? e.message : String(e);
    }
  }

  return {
    ok: true,
    batch,
    width,
    height,
    sheets,
    elapsedMs,
    opened,
    openMessage,
  };
});

ipcMain.handle('sheet:open', async (ev, id) => {
  try {
    const p = materializeSheet(findSheet(id));
    return openDxf(p, loadSettings());
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('sheet:saveAs', async (ev, id) => {
  let entry;
  let src;
  try {
    entry = findSheet(id);
    src = materializeSheet(entry);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
  const settings = loadSettings();
  const defDir = settings.outputDir && settings.outputDir.trim() !== ''
    ? settings.outputDir : app.getPath('documents');
  const r = await dialog.showSaveDialog(win, {
    title: 'Spremi DXF ploče',
    defaultPath: path.join(defDir, entry.fileName || 'Ploca.dxf'),
    filters: [{ name: 'DXF', extensions: ['dxf'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.copyFileSync(src, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, message: 'Ne mogu spremiti: ' + e.message };
  }
});

// Native OS drag of the sheet's DXF file (drop it straight into CypCut).
ipcMain.on('sheet:dragStart', (event, id) => {
  try {
    const p = materializeSheet(findSheet(id));
    let icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32 });
    event.sender.startDrag({ file: p, icon });
  } catch (e) {
    event.sender.send('app:toast', 'Povlačenje nije uspjelo: ' + (e && e.message ? e.message : e));
  }
});

ipcMain.handle('history:list', () => loadHistory().sheets);

ipcMain.handle('history:remove', (ev, id) => {
  const h = loadHistory();
  h.sheets = h.sheets.filter((s) => s.id !== id);
  writeJson(historyFile(), h);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: dialogs & info
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:pickExe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Odaberite CypCut program',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Programi', extensions: ['exe'] }]
      : [{ name: 'Sve datoteke', extensions: ['*'] }],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Odaberite zadanu mapu za "Spremi DXF"',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  dataDir: dataDir(),
}));

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const saved = loadSettings().winBounds;
  const opts = {
    width: 1100,
    height: 800,
    minWidth: 360,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#12161c',
    title: 'DinoNest',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    opts.width = Math.max(360, saved.width);
    opts.height = Math.max(560, saved.height);
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      opts.x = saved.x;
      opts.y = saved.y;
    }
  }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  win.on('close', () => {
    try {
      const s = loadSettings();
      s.winBounds = win.getBounds();
      saveSettings(s);
    } catch { /* not critical */ }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    ensureDirs();
    cleanTempDir();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
