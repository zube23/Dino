'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu,
} = require('electron');

const { analyzePart, generateSheet } = require('../src/core/parts');

let win = null;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const dataDir = () => app.getPath('userData');
const partsDir = () => path.join(dataDir(), 'parts');
const defaultOutputDir = () => path.join(dataDir(), 'output');
const libraryFile = () => path.join(dataDir(), 'library.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');

const DEFAULT_SETTINGS = {
  gap: 8,          // razmak između partova (mm)
  margin: 10,      // rub ploče (mm)
  allowRotate: true,
  autoOpen: true,  // odmah otvori DXF u SciCut-u / zadanoj aplikaciji
  addFrame: false, // dodaj okvir ploče u DXF (layer PLOCA)
  scicutPath: '',  // putanja do SciCut .exe (prazno = zadana aplikacija za .dxf)
  outputDir: '',   // prazno = <userData>/output
};

function ensureDirs() {
  for (const dir of [dataDir(), partsDir(), defaultOutputDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
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

function timestampName(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function publicPart(entry) {
  // Everything except heavyweight internals; content stays on disk.
  return entry;
}

ipcMain.handle('parts:list', () => {
  return loadLibrary().parts.map(publicPart);
});

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
        warnings: info.warnings,
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

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (ev, patch) => {
  const s = { ...loadSettings() };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      if (k === 'gap' || k === 'margin') {
        const n = Number(patch[k]);
        s[k] = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : s[k];
      } else if (k === 'allowRotate' || k === 'autoOpen' || k === 'addFrame') {
        s[k] = !!patch[k];
      } else {
        s[k] = String(patch[k] || '');
      }
    }
  }
  writeJson(settingsFile(), s);
  return s;
});

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

  const outDir = settings.outputDir && settings.outputDir.trim() !== ''
    ? settings.outputDir : defaultOutputDir();
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch { /* handled below on write */ }
  const now = new Date();
  const fileName = 'Ploca_' + Math.round(width) + 'x' + Math.round(height)
    + '_' + timestampName(now) + '.dxf';
  const dxfPath = path.join(outDir, fileName);
  try {
    fs.writeFileSync(dxfPath, result.dxf, 'utf8');
  } catch (e) {
    return { ok: false, message: 'Ne mogu spremiti DXF u ' + outDir + ' (' + e.message + ')' };
  }

  const history = loadHistory();
  history.sheets.unshift({
    id: newId(),
    date: now.toISOString(),
    width,
    height,
    dxfPath,
    fileName,
    summary: result.summary,
    unplaced: result.unplaced,
    utilization: Math.round(result.utilization * 1000) / 1000,
    totalPlaced: result.totalPlaced,
  });
  history.sheets = history.sheets.slice(0, 300);
  writeJson(historyFile(), history);

  let opened = false;
  let openMessage = '';
  if (settings.autoOpen) {
    const r = await openDxf(dxfPath, settings);
    opened = r.ok;
    openMessage = r.message || '';
  }

  return {
    ok: true,
    width,
    height,
    dxfPath,
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

async function openDxf(dxfPath, settings) {
  const exe = settings.scicutPath && settings.scicutPath.trim();
  if (exe) {
    if (!fs.existsSync(exe)) {
      return { ok: false, message: 'SciCut nije pronađen na: ' + exe };
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
        child.once('error', (e) => finish({ ok: false, message: 'Ne mogu pokrenuti SciCut: ' + e.message }));
        child.once('spawn', () => {
          child.unref();
          finish({ ok: true });
        });
      } catch (e) {
        finish({ ok: false, message: 'Ne mogu pokrenuti SciCut: ' + e.message });
      }
    });
  }
  const err = await shell.openPath(dxfPath);
  if (err) {
    return {
      ok: false,
      message: 'Ne mogu otvoriti DXF (' + err + '). Postavite putanju do SciCut programa u Postavkama.',
    };
  }
  return { ok: true };
}

ipcMain.handle('file:open', (ev, p) => {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.dxf') || !fs.existsSync(p)) {
    return { ok: false, message: 'Datoteka ne postoji: ' + p };
  }
  return openDxf(p, loadSettings());
});

ipcMain.handle('file:showInFolder', (ev, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('history:list', () => loadHistory().sheets);

ipcMain.handle('history:remove', (ev, id) => {
  const h = loadHistory();
  h.sheets = h.sheets.filter((s) => s.id !== id);
  writeJson(historyFile(), h);
  return true;
});

ipcMain.handle('dialog:pickExe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Odaberite SciCut program',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Programi', extensions: ['exe'] }]
      : [{ name: 'Sve datoteke', extensions: ['*'] }],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Odaberite mapu za spremanje DXF ploča',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  dataDir: dataDir(),
  outputDir: loadSettings().outputDir || defaultOutputDir(),
}));

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    autoHideMenuBar: true,
    backgroundColor: '#12161c',
    title: 'DinoNest',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.maximize();
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
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
