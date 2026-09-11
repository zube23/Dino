/*
 * Browser bridge for the DinoNest web trial build. Implements the same
 * window.dino API the Electron preload exposes, backed by localStorage.
 * Wrapped by scripts/build-web.js together with the core modules; __req()
 * and SAMPLE_FILES/SAMPLE_CONFIG are provided by the bundle.
 */
(function () {
  const { analyzePart, applySet, buildSheetDxf, generateAll, gapSweep } = __req('parts');
  const PAIR_MIRRORED = ['priority', 'mode', 'count', 'maxCount'];

  // ---- storage (localStorage with in-memory fallback) ----
  // mem is written on every store() and is therefore always at least as
  // fresh as localStorage: when a quota-exceeded write fails, the session
  // must keep seeing the new value, not the stale persisted one.
  const mem = {};
  function load(key, fallback) {
    if (key in mem) return mem[key];
    try {
      const v = localStorage.getItem('dinonest.' + key);
      if (v !== null) return JSON.parse(v);
    } catch (e) { /* blocked or corrupt - fall through */ }
    return fallback;
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
    addFrame: false, tabsMax: 30, skeleton: false, skeletonSpacing: 400,
    scicutPath: '', outputDir: '',
  };
  const NUMERIC_SETTINGS = { gap: 100, margin: 100, histTol: 500, tabsMax: 500, skeletonSpacing: 5000 };
  const BOOL_SETTINGS = ['allowRotate', 'autoOpen', 'addFrame', 'skeleton'];
  const TRASH_DAYS = 30;

  function cmName(mm) {
    return String(Math.round(mm / 10 * 10) / 10);
  }

  function reanalyzeEntry(entry) {
    const info = analyzePart(entry.content, { lockRotation: !!entry.noRotate });
    entry.preRotDeg = info.preRotDeg;
    entry.w = Math.round(info.w * 1000) / 1000;
    entry.h = Math.round(info.h * 1000) / 1000;
    entry.area = Math.round(info.area * 1000) / 1000;
    entry.outline = info.outline;
    entry.texts = info.texts;
    entry.holes = info.holes;
    entry.warnings = info.warnings;
    entry.entityCount = info.entityCount;
  }

  function loadTrash() {
    const t = load('trash', []);
    const cutoff = Date.now() - TRASH_DAYS * 24 * 3600 * 1000;
    return (Array.isArray(t) ? t : []).filter((it) => it && it.entry
      && new Date(it.deletedAt).getTime() >= cutoff);
  }

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
      mode: 'filler',
      count: 1,
      maxCount: 0,
      pairId: null,
      enabled: true,
      noRotate: false,
      preRotDeg: info.preRotDeg,
      w: Math.round(info.w * 1000) / 1000,
      h: Math.round(info.h * 1000) / 1000,
      area: Math.round(info.area * 1000) / 1000,
      outline: info.outline,
      texts: info.texts,
      holes: info.holes,
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

  function loadSetsState() {
    const s = load('sets', { sets: [], activeSetId: null });
    if (!Array.isArray(s.sets)) s.sets = [];
    for (const set of s.sets) {
      if (!set.items || typeof set.items !== 'object') set.items = {};
    }
    if (s.activeSetId && !s.sets.some((x) => x.id === s.activeSetId)) s.activeSetId = null;
    return s;
  }

  function saveSetsState(s) {
    store('sets', s);
    return s;
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
      extraLines: entry.extraLines || [],
      tabsMax: entry.tabsMax || 0,
    });
  }

  function validDims(req) {
    const width = Number(req && req.width);
    const height = Number(req && req.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, message: 'Upišite ispravnu duljinu i širinu ploče.' };
    }
    if (width > 100000 || height > 100000) {
      return { ok: false, message: 'Dimenzije ploče su prevelike.' };
    }
    return { ok: true, width, height };
  }

  function parseZone(req) {
    if (!req || !req.zone || typeof req.zone !== 'object') return null;
    const z = {
      x: Number(req.zone.x), y: Number(req.zone.y), w: Number(req.zone.w), h: Number(req.zone.h),
    };
    if (![z.x, z.y, z.w, z.h].every(Number.isFinite) || z.w <= 0 || z.h <= 0) return null;
    const r1 = (n) => Math.round(n * 10) / 10;
    return { x: r1(z.x), y: r1(z.y), w: r1(z.w), h: r1(z.h) };
  }

  function resolveParts() {
    const settings = getSettings();
    const setsState = loadSetsState();
    const set = setsState.sets.find((x) => x.id === setsState.activeSetId) || null;
    const fillSet = set && set.fillSetId
      ? setsState.sets.find((x) => x.id === set.fillSetId) || null
      : null;
    const effective = applySet(getLib(), set, fillSet);
    if (effective.length === 0) {
      return {
        ok: false,
        message: set
          ? 'Aktivni set "' + set.name + '" je prazan. Dodajte partove u set u PRIPREMI.'
          : 'Nema uključenih partova. Dodajte ih u PRIPREMI.',
      };
    }
    return { ok: true, settings, parts: effective, set, fillSet };
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
      const mirrored = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'name') entry.name = sanitizeName(v);
        else if (k === 'mode') entry.mode = v === 'fixed' ? 'fixed' : 'filler';
        else if (k === 'enabled') entry.enabled = !!v;
        else if (k === 'noRotate') {
          const next = !!v;
          if (next !== !!entry.noRotate) {
            entry.noRotate = next;
            reanalyzeEntry(entry);
          }
        } else if (k === 'priority' || k === 'count' || k === 'maxCount') {
          const n = Math.floor(Number(v));
          if (k === 'priority') entry.priority = Math.min(99, Math.max(1, Number.isFinite(n) ? n : 5));
          if (k === 'count') entry.count = Math.min(999, Math.max(0, Number.isFinite(n) ? n : 1));
          if (k === 'maxCount') entry.maxCount = Math.min(9999, Math.max(0, Number.isFinite(n) ? n : 0));
        }
        if (PAIR_MIRRORED.indexOf(k) !== -1) mirrored[k] = entry[k];
      }
      if (entry.pairId && Object.keys(mirrored).length > 0) {
        const partner = lib.find((p) => p.id === entry.pairId);
        if (partner) Object.assign(partner, mirrored);
      }
      store('library', lib);
      return pub(entry);
    },

    pairPart: async (idA, idB) => {
      const lib = getLib();
      const a = lib.find((p) => p.id === idA);
      if (!a) throw new Error('Part ne postoji.');
      if (a.pairId) {
        const old = lib.find((p) => p.id === a.pairId);
        if (old) old.pairId = null;
        a.pairId = null;
      }
      if (idB) {
        const b = lib.find((p) => p.id === idB);
        if (!b || b.id === a.id) throw new Error('Neispravan par.');
        if (b.pairId) {
          const old = lib.find((p) => p.id === b.pairId);
          if (old) old.pairId = null;
        }
        a.pairId = b.id;
        b.pairId = a.id;
        for (const k of PAIR_MIRRORED) b[k] = a[k];
      }
      store('library', lib);
      return lib.map(pub);
    },

    removePart: async (id) => {
      const lib = getLib();
      const entry = lib.find((p) => p.id === id);
      if (entry && entry.pairId) {
        const partner = lib.find((p) => p.id === entry.pairId);
        if (partner) partner.pairId = null;
      }
      store('library', lib.filter((p) => p.id !== id));
      const sets = loadSetsState();
      for (const s of sets.sets) delete s.items[id];
      saveSetsState(sets);
      if (entry) {
        const t = loadTrash();
        t.unshift({ entry: { ...entry, pairId: null }, deletedAt: new Date().toISOString() });
        store('trash', t.slice(0, 20));
      }
      return true;
    },

    listTrash: async () => loadTrash().map((it) => ({
      id: it.entry.id,
      name: it.entry.name,
      w: it.entry.w,
      h: it.entry.h,
      outline: it.entry.outline,
      deletedAt: it.deletedAt,
    })),

    restorePart: async (id) => {
      const t = loadTrash();
      const idx = t.findIndex((it) => it.entry.id === id);
      if (idx === -1) throw new Error('Part više nije u Kanti.');
      const lib = getLib();
      if (!lib.some((p) => p.id === id)) lib.push(t[idx].entry);
      store('library', lib);
      t.splice(idx, 1);
      store('trash', t);
      return pub(lib.find((p) => p.id === id));
    },

    setSetFill: async (id, fillSetId) => {
      const s = loadSetsState();
      const set = s.sets.find((x) => x.id === id);
      if (!set) throw new Error('Set ne postoji.');
      set.fillSetId = (fillSetId && fillSetId !== id && s.sets.some((x) => x.id === fillSetId)) ? fillSetId : null;
      return saveSetsState(s);
    },

    listSets: async () => loadSetsState(),
    createSet: async (name) => {
      const s = loadSetsState();
      const set = { id: newId(), name: sanitizeName(name || ('Set ' + (s.sets.length + 1))), items: {} };
      s.sets.push(set);
      s.activeSetId = set.id;
      return saveSetsState(s);
    },
    renameSet: async (id, name) => {
      const s = loadSetsState();
      const set = s.sets.find((x) => x.id === id);
      if (set) set.name = sanitizeName(name);
      return saveSetsState(s);
    },
    removeSet: async (id) => {
      const s = loadSetsState();
      s.sets = s.sets.filter((x) => x.id !== id);
      if (s.activeSetId === id) s.activeSetId = null;
      return saveSetsState(s);
    },
    activateSet: async (id) => {
      const s = loadSetsState();
      s.activeSetId = (id && s.sets.some((x) => x.id === id)) ? id : null;
      return saveSetsState(s);
    },
    setSetItem: async (setId, partId, patch) => {
      const s = loadSetsState();
      const set = s.sets.find((x) => x.id === setId);
      if (!set) throw new Error('Set ne postoji.');
      const part = getLib().find((p) => p.id === partId);
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
        if (part.pairId) set.items[part.pairId] = { ...merged };
      }
      return saveSetsState(s);
    },

    getSettings: async () => getSettings(),

    setSettings: async (patch) => {
      const s = getSettings();
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
          if (k in NUMERIC_SETTINGS) {
            const n = Number(patch[k]);
            s[k] = Number.isFinite(n) ? Math.min(NUMERIC_SETTINGS[k], Math.max(0, n)) : s[k];
          } else if (BOOL_SETTINGS.indexOf(k) !== -1) {
            s[k] = !!patch[k];
          } else {
            s[k] = String(patch[k] || '');
          }
        }
      }
      store('settings', s);
      return s;
    },

    gapSweep: async (req) => {
      const d = validDims(req);
      if (!d.ok) return d;
      const rp = resolveParts();
      if (!rp.ok) return rp;
      const gaps = (Array.isArray(req.gaps) ? req.gaps : [])
        .map(Number).filter((g) => Number.isFinite(g) && g >= 0 && g <= 100).slice(0, 12);
      if (gaps.length === 0) return { ok: false, message: 'Nema razmaka za probu.' };
      try {
        const zone = parseZone(req);
        const rows = gapSweep({
          sheetW: d.width,
          sheetH: d.height,
          margin: rp.settings.margin,
          allowRotate: rp.settings.allowRotate,
          blocked: zone ? [zone] : [],
          parts: rp.parts,
        }, gaps);
        return { ok: true, rows };
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    },

    generate: async (req) => {
      const d = validDims(req);
      if (!d.ok) return d;
      const { width, height } = d;
      const rp = resolveParts();
      if (!rp.ok) return rp;
      const { settings, set } = rp;
      const effective = rp.parts;
      const zone = parseZone(req);
      let variants;
      const t0 = performance.now();
      try {
        variants = generateAll({
          sheetW: width,
          sheetH: height,
          margin: settings.margin,
          gap: settings.gap,
          allowRotate: settings.allowRotate,
          addFrame: settings.addFrame,
          blocked: zone ? [zone] : [],
          tabsMax: settings.tabsMax > 0 ? settings.tabsMax : 0,
          skeleton: settings.skeleton ? { spacing: settings.skeletonSpacing } : null,
          parts: effective,
        }, {
          dense: !!(req && req.dense),
          // The browser runs everything on the UI thread - keep the dense
          // search short enough that the page never feels frozen.
          budgetMs: 2500,
          seed: (Date.now() >>> 0) || 1,
          knapMax: 10,
        });
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
      const elapsedMs = Math.round(performance.now() - t0);
      if (variants.length === 0) {
        return {
          ok: false,
          message: 'Ni\u0161ta ne stane na plo\u010du ' + cmName(height) + ' \u00d7 ' + cmName(width) + ' cm. Provjerite dimenzije i rub.',
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
        const eWidth = result.knapDims ? result.knapDims.width : width;
        const eHeight = result.knapDims ? result.knapDims.height : height;
        const fileName = 'Ploca_' + cmName(eHeight) + 'x' + cmName(eWidth)
          + '_' + stamp + '_v' + (vi + 1) + '_' + id.slice(-4) + '.dxf';
        entries.push({
          id,
          batch,
          variant: result.variant,
          variantLabel: result.variantLabel,
          date: now.toISOString(),
          width: eWidth,
          height: eHeight,
          fileName,
          addFrame: !!settings.addFrame,
          setName: set ? set.name : null,
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
          zone: zone || null,
          extraLines: result.extraLines || [],
          tabsMax: result.tabsMax || 0,
          freeRects: (result.freeRects || []).slice(0, 8),
          hint: result.hint || null,
        });
        sheets.push({
          sheetId: id,
          batch,
          variant: result.variant,
          variantLabel: result.variantLabel,
          width: eWidth,
          height: eHeight,
          fileName,
          unplaced: result.unplaced,
          notes: result.notes,
          summary: result.summary,
          utilization: result.utilization,
          totalPlaced: result.totalPlaced,
          capped: result.capped,
          maxTotal: result.maxTotal,
          hint: result.hint || null,
        });
      }

      let history = load('history', []);
      history = entries.concat(history).slice(0, 60);
      if (!store('history', history)) {
        history = history.slice(0, 10);
        store('history', history);
      }

      return { ok: true, batch, width, height, sheets, elapsedMs, opened: false, openMessage: '' };
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
    appInfo: async () => ({ version: '1.5.0 · web proba', dataDir: '' }),
  };
})();
