'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage,
} = require('electron');

const { analyzePart, buildSheetDxf, generateSheet } = require('../src/core/parts');

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

const DEFAULT_SETTINGS = {
  gap: 8,          // razmak između partova (mm)
  margin: 10,      // rub ploče (mm)
  histTol: 20,     // tolerancija za ponude ploča istih dimenzija (mm)
  allowRotate: true,
  autoOpen: true,  // odmah otvori generiranu ploču u CypCut-u
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
        mode: 'fixed', // 'fixed' | 'filler'
        count: 1,
        maxCount: 0,
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

ipcMain.handle('parts:update', (ev, id, patch) => {
  if (!validId(id)) throw new Error('Neispravan ID parta.');
  const lib = loadLibrary();
  const entry = lib.parts.find((p) => p.id === id);
  if (!entry) throw new Error('Part ne postoji.');
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE_FIELDS.has(k)) continue;
    if (k === 'name') entry.name = sanitizeName(v);
    else if (k === 'mode') entry.mode = v === 'filler' ? 'filler' : 'fixed';
    else if (k === 'enabled') entry.enabled = !!v;
    else {
      const n = Math.floor(Number(v));
      if (k === 'priority') entry.priority = Math.min(99, Math.max(1, Number.isFinite(n) ? n : 5));
      if (k === 'count') entry.count = Math.min(999, Math.max(0, Number.isFinite(n) ? n : 1));
      if (k === 'maxCount') entry.maxCount = Math.min(9999, Math.max(0, Number.isFinite(n) ? n : 0));
    }
  }
  writeJson(libraryFile(), lib);
  return entry;
});

ipcMain.handle('parts:remove', (ev, id) => {
  if (!validId(id)) throw new Error('Neispravan ID parta.');
  const lib = loadLibrary();
  lib.parts = lib.parts.filter((p) => p.id !== id);
  writeJson(libraryFile(), lib);
  try {
    fs.unlinkSync(path.join(partsDir(), id + '.dxf'));
  } catch { /* already gone */ }
  return true;
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
  const active = lib.parts.filter((p) => p.enabled);
  if (active.length === 0) {
    return { ok: false, message: 'Nema uključenih partova. Dodajte ih u PRIPREMI.' };
  }

  const parts = [];
  for (const p of active) {
    let content;
    try {
      content = fs.readFileSync(path.join(partsDir(), p.id + '.dxf'), 'utf8');
    } catch {
      return { ok: false, message: 'Nedostaje DXF datoteka parta "' + p.name + '".' };
    }
    parts.push({ ...p, content });
  }

  let result;
  const t0 = Date.now();
  try {
    result = generateSheet({
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

  if (result.totalPlaced === 0) {
    return {
      ok: false,
      message: 'Ništa ne stane na ploču ' + width + ' x ' + height + ' mm. Provjerite dimenzije i rub.',
      unplaced: result.unplaced,
    };
  }

  const now = new Date();
  const id = newId();
  const fileName = 'Ploca_' + Math.round(width) + 'x' + Math.round(height)
    + '_' + now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
    + '_' + pad2(now.getHours()) + '-' + pad2(now.getMinutes()) + '-' + pad2(now.getSeconds())
    + '_' + id.slice(-4) + '.dxf';

  // Compact history record - no DXF file is written; it is re-created on
  // demand from these placements.
  const entry = {
    id,
    date: now.toISOString(),
    width,
    height,
    fileName,
    addFrame: !!settings.addFrame,
    placements: result.placements.map((pl) => ({
      id: pl.id,
      x: Math.round(pl.x * 1000) / 1000,
      y: Math.round(pl.y * 1000) / 1000,
      w: Math.round(pl.w * 1000) / 1000,
      h: Math.round(pl.h * 1000) / 1000,
      rotated: pl.rotated,
      rotDeg: pl.rotDeg,
      dx: pl.dx,
      dy: pl.dy,
    })),
    summary: result.summary,
    unplaced: result.unplaced,
    utilization: Math.round(result.utilization * 1000) / 1000,
    totalPlaced: result.totalPlaced,
    capped: result.capped,
  };
  const history = loadHistory();
  history.sheets.unshift(entry);
  history.sheets = history.sheets.slice(0, 200);
  writeJson(historyFile(), history);

  let opened = false;
  let openMessage = '';
  if (settings.autoOpen) {
    try {
      const p = materializeSheet(entry);
      const r = await openDxf(p, settings);
      opened = r.ok;
      openMessage = r.message || '';
    } catch (e) {
      openMessage = e && e.message ? e.message : String(e);
    }
  }

  return {
    ok: true,
    sheetId: id,
    width,
    height,
    fileName,
    placements: result.placements,
    unplaced: result.unplaced,
    summary: result.summary,
    utilization: result.utilization,
    totalPlaced: result.totalPlaced,
    capped: result.capped,
    maxTotal: result.maxTotal,
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
