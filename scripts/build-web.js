'use strict';

/*
 * Builds the single-file web trial version of DinoNest: bundles the core
 * modules, the browser bridge and the (lightly patched) renderer into
 * web/dinonest-web.html. Run: node scripts/build-web.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function patch(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('patch "' + label + '" matched ' + n + ' times');
  return src.replace(from, to);
}

// ---- core modules wrapped into a tiny registry ----
function wrapModule(name, file) {
  const src = read(file).replace(/require\('\.\/(\w+)'\)/g, "__req('$1')");
  return "__mods['" + name + "'] = (function () { const module = { exports: {} };\n"
    + '(function (module) {\n' + src + '\n})(module);\n'
    + 'return module.exports; })();';
}

const bundleCore = [
  'const __mods = {};',
  'function __req(name) { return __mods[name]; }',
  wrapModule('dxf', 'src/core/dxf.js'),
  wrapModule('geometry', 'src/core/geometry.js'),
  wrapModule('nest', 'src/core/nest.js'),
  wrapModule('parts', 'src/core/parts.js'),
].join('\n');

// ---- sample parts, embedded for first-run seeding ----
const sampleFiles = {};
for (const f of fs.readdirSync(path.join(root, 'samples'))) {
  if (f.endsWith('.dxf')) sampleFiles[f] = read(path.join('samples', f));
}
const sampleConfig = [
  { file: 'nosac_L.dxf', name: 'Nosač L', priority: 1, mode: 'fixed', count: 2 },
  { file: 'prirubnica.dxf', name: 'Prirubnica', priority: 2, mode: 'fixed', count: 1 },
  { file: 'zaobljena_plocica.dxf', name: 'Zaobljena pločica', priority: 3, mode: 'fixed', count: 2 },
  { file: 'plocica_rupe.dxf', name: 'Pločica s rupama', priority: 4, mode: 'filler' },
  { file: 'kutnik_trokut.dxf', name: 'Kutnik', priority: 5, mode: 'filler' },
  { file: 'traka_utor.dxf', name: 'Traka s utorom', priority: 6, mode: 'filler' },
];
const samplesJs = 'const SAMPLE_FILES = ' + JSON.stringify(sampleFiles) + ';\n'
  + 'const SAMPLE_CONFIG = ' + JSON.stringify(sampleConfig) + ';';

// ---- renderer: HTML body ----
let html = read('src/renderer/index.html');
html = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
html = patch(html, '  <script src="app.js"></script>\n', '', 'drop script tag');
html = patch(html,
  '<button id="btnOpen" class="btn">OTVORI DXF</button>',
  '<button id="btnOpen" class="btn">💾 PREUZMI DXF</button>',
  'download button');
html = patch(html,
  '\n          <button id="btnFolder" class="btn ghost">PRIKAŽI U MAPI</button>', '',
  'drop folder button');
html = patch(html,
  '\n          <label class="check"><input id="setAutoOpen" type="checkbox"> Nakon generiranja odmah otvori DXF (SciCut)</label>', '',
  'drop autoOpen setting');
html = patch(html, '<label>SciCut program (.exe)', '<label hidden>SciCut program (.exe)', 'hide scicut path');
html = patch(html, '<label>Mapa za spremanje DXF ploča', '<label hidden>Mapa za spremanje DXF ploča', 'hide output dir');
html = patch(html, '</header>',
  '</header>\n  <div class="demo-note">Probna verzija u pregledniku — sve radi lokalno, ništa se ne šalje nikamo. '
  + 'Pravi program za Windows (s otvaranjem u SciCut-u): '
  + '<a href="https://github.com/zube23/Dino/releases/tag/v1.0.0" target="_blank" rel="noopener">preuzmi DinoNest</a>.</div>',
  'demo note');

// ---- renderer: app.js patched for the web bridge ----
let app = read('src/renderer/app.js');
app = patch(app,
  "$('btnFolder').addEventListener('click', () => {\n"
  + '  if (state.lastResult) bridge.showInFolder(state.lastResult.dxfPath);\n'
  + '});\n', '', 'drop btnFolder listener');
app = patch(app,
  "$('setAutoOpen').addEventListener('change', () => saveSettings({ autoOpen: $('setAutoOpen').checked }));\n",
  '', 'drop autoOpen listener');
app = patch(app, "  $('setAutoOpen').checked = !!s.autoOpen;\n", '', 'drop autoOpen render');
app = patch(app,
  "    const folder = el('button', 'btn small ghost', 'MAPA');\n"
  + "    folder.addEventListener('click', () => bridge.showInFolder(s.dxfPath));\n",
  '', 'drop history MAPA button');
app = patch(app, '    btns.appendChild(folder);\n', '', 'drop MAPA append');
app = patch(app,
  "const fileLine = el('div', 'files', res.dxfPath + (res.opened ? '  →  otvoreno' : ''));",
  "const fileLine = el('div', 'files', res.dxfPath);",
  'file line');

// ---- styles ----
const css = read('src/renderer/styles.css') + `
.demo-note {
  background: #1c2836;
  color: #a9bdd2;
  padding: 8px 22px;
  font-size: 14px;
  border-bottom: 1px solid var(--line);
}
.demo-note a { color: var(--accent2); font-weight: 700; }
`;

// ---- bridge ----
const bridge = read('src/web/bridge.js');

const out = `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DinoNest</title>
<style>
${css}</style>
</head>
<body>
${html}
<script>
'use strict';
${bundleCore}
${samplesJs}
${bridge}
${app}
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(root, 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'web', 'dinonest-web.html'), out, 'utf8');
console.log('written web/dinonest-web.html (' + Math.round(out.length / 1024) + ' KB)');
