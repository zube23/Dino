/*
 * Browser bridge for the DinoNest web trial build. Implements the same
 * window.dino API the Electron preload exposes, backed by localStorage.
 * Wrapped by scripts/build-web.js together with the core modules; __req()
 * and SAMPLE_FILES/SAMPLE_CONFIG are provided by the bundle.
 */
(function () {
  const { analyzePart, buildSheetDxf, generateSheet } = __req('parts');

  // ---- storage (localStorage with in-memory fallback) ----
  const mem = {};
  function load(key, fallback) {
    try {
      const v = localStorage.getItem('dinonest.' + key);
      if (v !== null) return JSON.parse(v);
    } catch (e) { /* blocked or corrupt - fall through */ }
    return (key in mem) ? mem[key] : fallback;
  }
  function store(key, value) {
    mem[key] = value;
    try {
      localStorage.setItem('dinonest.' + key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  const DEFAULT_SETTINGS = {
    gap: 8, margin: 10, histTol: 20, allowRotate: true, autoOpen: false,
    addFrame: false, scicutPath: '', outputDir: '',
  };

  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function sanitizeName(name) {
    return String(name || 'part').replace(/[^\p{L}\p{N}.\-_ ]+/gu, '_').slice(0, 80);
  }

  function makeEntry(name, content) {
    const info = analyzePart(content);
    return {
      id: newId(),
      name: sanitizeName(name),
      priority: 5,
      mode: 'fixed',
      count: 1,
      maxCount: 0,
      enabled: true,
      preRotDeg: info.preRotDeg,
      w: Math.round(info.w * 1000) / 1000,
      h: Math.round(info.h * 1000) / 1000,
      area: Math.round(info.area * 1000) / 1000,
      outline: info.outline,
      warnings: info.warnings,
      entityCount: info.entityCount,
      createdAt: new Date().toISOString(),
      content,
    };
  }

  function getLib() {
    let lib = load('library', null);
    if (lib === null) {
      // First run: seed the trial with the sample parts so GENERIRAJ works
      // immediately.
      lib = [];
      for (const cfg of SAMPLE_CONFIG) {
        try {
          const entry = makeEntry(cfg.name, SAMPLE_FILES[cfg.file]);
          entry.priority = cfg.priority;
          entry.mode = cfg.mode;
          if (cfg.count) entry.count = cfg.count;
          lib.push(entry);
        } catch (e) { /* skip a bad sample */ }
      }
      store('library', lib);
    }
    return lib;
  }

  const pub = (p) => {
    const { content, ...rest } = p;
    return rest;
  };

  function pad2(n) { return String(n).padStart(2, '0'); }

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...load('settings', {}) };
  }

  function findSheet(id) {
    const entry = load('history', []).find((s) => s.id === id);
    if (!entry) throw new Error('Ploča ne postoji u povijesti.');
    return entry;
  }

  function sheetDxf(entry) {
    if (!Array.isArray(entry.placements) || entry.placements.length === 0) {
      throw new Error('Za ovu staru ploču nema zapisa - generirajte je ponovno.');
    }
    return buildSheetDxf({
      parts: getLib(),
      placements: entry.placements,
      sheetW: entry.width,
      sheetH: entry.height,
      addFrame: !!entry.addFrame,
    });
  }

  // ---- file download (artifact capability, else plain browser save) ----
  async function download(name, text) {
    if (window.claude && typeof window.claude.use === 'function') {
      let d = null;
      try { d = await window.claude.use('downloads'); } catch (e) { d = null; }
      if (!d) {
        return { ok: false, message: 'Preuzimanje nije dostupno u ovom pregledu — koristite Windows program.' };
      }
      try {
        // The viewer sandbox allows only certain extensions - .txt is the
        // closest fit for an ASCII DXF; the user renames it after saving.
        await d.save({ filename: name + '.txt', data: text });
        if (typeof showToast === 'function') {
          showToast('Spremljeno kao "' + name + '.txt" — nakon preuzimanja preimenujte datoteku tako da završava na .dxf.');
        }
        return { ok: true };
      } catch (e) {
        if (e && e.code === 'declined') return { ok: false, message: 'Preuzimanje otkazano.' };
        return { ok: false, message: 'Preuzimanje nije uspjelo (' + ((e && e.message) || e) + ').' };
      }
    }
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { ok: true };
  }

  // ---- the bridge ----
  window.dino = {
    isWeb: true,
    canDrag: false, // native drag-out works only in the desktop app

    listParts: async () => getLib().map(pub),

    addParts: async (files) => {
      const lib = getLib();
      const added = [];
      const errors = [];
      for (const f of files || []) {
        const name = sanitizeName(f && f.name ? f.name.replace(/\.dxf$/i, '') : 'part');
        try {
          const entry = makeEntry(name, String(f.content || ''));
          lib.push(entry);
          added.push(pub(entry));
        } catch (e) {
          errors.push({ name, message: (e && e.message) || String(e) });
        }
      }
      if (!store('library', lib) && added.length > 0) {
        errors.push({ name: 'spremanje', message: 'Nema mjesta u pregledniku - part vrijedi samo do zatvaranja kartice.' });
      }
      return { added, errors };
    },

    updatePart: async (id, patch) => {
      const lib = getLib();
      const entry = lib.find((p) => p.id === id);
      if (!entry) throw new Error('Part ne postoji.');
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'name') entry.name = sanitizeName(v);
        else if (k === 'mode') entry.mode = v === 'filler' ? 'filler' : 'fixed';
        else if (k === 'enabled') entry.enabled = !!v;
        else if (k === 'priority' || k === 'count' || k === 'maxCount') {
          const n = Math.floor(Number(v));
          if (k === 'priority') entry.priority = Math.min(99, Math.max(1, Number.isFinite(n) ? n : 5));
          if (k === 'count') entry.count = Math.min(999, Math.max(0, Number.isFinite(n) ? n : 1));
          if (k === 'maxCount') entry.maxCount = Math.min(9999, Math.max(0, Number.isFinite(n) ? n : 0));
        }
      }
      store('library', lib);
      return pub(entry);
    },

    removePart: async (id) => {
      store('library', getLib().filter((p) => p.id !== id));
      return true;
    },

    getSettings: async () => getSettings(),

    setSettings: async (patch) => {
      const s = getSettings();
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
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
      store('settings', s);
      return s;
    },

    generate: async (req) => {
      const width = Number(req && req.width);
      const height = Number(req && req.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { ok: false, message: 'Upišite ispravnu duljinu i širinu ploče (mm).' };
      }
      if (width > 100000 || height > 100000) {
        return { ok: false, message: 'Dimenzije ploče su prevelike.' };
      }
      const settings = getSettings();
      const active = getLib().filter((p) => p.enabled);
      if (active.length === 0) {
        return { ok: false, message: 'Nema uključenih partova. Dodajte ih u PRIPREMI.' };
      }
      let result;
      const t0 = performance.now();
      try {
        result = generateSheet({
          sheetW: width,
          sheetH: height,
          margin: settings.margin,
          gap: settings.gap,
          allowRotate: settings.allowRotate,
          addFrame: settings.addFrame,
          parts: active,
        });
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
      const elapsedMs = Math.round(performance.now() - t0);
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
      let history = load('history', []);
      history.unshift(entry);
      history = history.slice(0, 60);
      if (!store('history', history)) {
        history = history.slice(0, 10);
        store('history', history);
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
        opened: false,
        openMessage: '',
      };
    },

    openSheet: async (id) => {
      try {
        const entry = findSheet(id);
        return download(entry.fileName || 'Ploca.dxf', sheetDxf(entry));
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    },

    saveSheet: async (id) => window.dino.openSheet(id),
    dragSheet: () => {},

    listHistory: async () => load('history', []),
    removeHistory: async (id) => {
      store('history', load('history', []).filter((s) => s.id !== id));
      return true;
    },
    pickExe: async () => null,
    pickDir: async () => null,
    appInfo: async () => ({ version: '1.1.1 · web proba', dataDir: '' }),
  };
})();
