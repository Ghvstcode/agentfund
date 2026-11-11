// Render the README hero banner (light + dark) and the social preview card.
//
//   node scripts/readme-brand.mjs
//
// Output (raw, 2x): docs/assets/.raw/hero-{light,dark}.png, docs/assets/.raw/social-preview.png.
// scripts/build-assets.sh optimises them into docs/assets/. Colours and fonts are the web UI's
// own (web/src/index.css): ink and paper, with green only for delivered work. Change them there first.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const require = createRequire(`${webDir}package.json`);
const { chromium } = require('playwright');
const font = (pkg, file) => pathToFileURL(`${webDir}node_modules/@fontsource-variable/${pkg}/files/${file}`).href;
const RAW = fileURLToPath(new URL('../docs/assets/.raw/', import.meta.url));

const THEMES = {
  light: { bg: '#ffffff', fg: '#0c0d0d', muted: '#5f6461', border: '#e3e6e4', ring: '#d3d7d5', reported: '#878c8a', pass: '#0fb863' },
  dark: { bg: '#09090b', fg: '#f4f4f5', muted: '#a0a0ab', border: 'rgb(255 255 255 / 0.09)', ring: 'rgb(255 255 255 / 0.2)', reported: '#6b6f6d', pass: '#22c670' },
};

// The mark (web/src/components/Mark.tsx): five tokens on a triangular lattice, the top one green.
const MARK = (t, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100"><circle cx="50" cy="21.13" r="15.4" fill="${t.pass}"/>` +
  [[33.33, 50], [66.67, 50], [16.67, 78.87], [83.33, 78.87]].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="15.4" fill="${t.fg}"/>`).join('') +
  '</svg>';

// The landing page's pyramid (web/src/components/TokenPyramid.tsx), still: top row first.
const STATES = [...Array(6).fill('delivered'), ...Array(4).fill('merged'), ...Array(6).fill('reported'), ...Array(12).fill('pledged')];
function pyramid(t, pitch) {
  const rows = 7;
  const r = pitch * 0.445;
  const rowHeight = (pitch * Math.sqrt(3)) / 2;
  const width = rows * pitch;
  const height = (rows - 1) * rowHeight + pitch;
  let index = 0;
  let circles = '';
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      const state = STATES[index++];
      const cx = width / 2 + (column - row / 2) * pitch;
      const cy = pitch / 2 + row * rowHeight;
      circles +=
        state === 'pledged'
          ? `<circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="none" stroke="${t.ring}" stroke-width="2"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${state === 'delivered' ? t.pass : state === 'merged' ? t.fg : t.reported}"/>`;
    }
  }
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${circles}</svg>`;
}

const LEGEND = [
  ['delivered', 'Delivered', 'CI passed'],
  ['merged', 'Merged', 'in main'],
  ['reported', 'Reported', 'ran, not yet proven'],
  ['pledged', 'Pledged', 'promised'],
];

function page(t, { width, height, scale = 1 }) {
  const px = (n) => `${n * scale}px`;
  const dot = (state) =>
    state === 'pledged'
      ? `border:${px(1.5)} solid ${t.ring}`
      : `background:${state === 'delivered' ? t.pass : state === 'merged' ? t.fg : t.reported}`;
  const legend = LEGEND.map(
    ([state, name, note]) => `<li><i style="${dot(state)}"></i><b>${name}</b><span>${note}</span></li>`,
  ).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Geist; src: url("${font('geist', 'geist-latin-wght-normal.woff2')}"); font-weight: 100 900; }
    @font-face { font-family: "Geist Mono"; src: url("${font('geist-mono', 'geist-mono-latin-wght-normal.woff2')}"); font-weight: 100 900; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: ${t.bg}; }
    .frame { width: ${width}px; height: ${height}px; background: ${t.bg}; color: ${t.fg}; overflow: hidden;
      font-family: Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      display: grid; grid-template-columns: 1fr auto; gap: ${px(64)}; align-items: center; padding: ${px(56)} ${px(72)}; }
    .brand { display: flex; align-items: center; gap: ${px(12)}; font-size: ${px(20)}; font-weight: 600; letter-spacing: -0.02em; }
    h1 { margin-top: ${px(40)}; font-size: ${px(64)}; line-height: 1; font-weight: 600; letter-spacing: -0.05em; }
    .sub { margin-top: ${px(22)}; max-width: ${px(520)}; font-size: ${px(18)}; line-height: 1.5; color: ${t.muted}; }
    ul { margin-top: ${px(32)}; padding-top: ${px(18)}; border-top: 1px solid ${t.fg}; list-style: none;
      display: flex; gap: ${px(26)}; font-family: "Geist Mono", monospace; font-size: ${px(12.5)}; }
    li { display: flex; align-items: center; gap: ${px(7)}; white-space: nowrap; }
    li i { width: ${px(10)}; height: ${px(10)}; border-radius: 50%; }
    li b { font-weight: 500; }
    li span { color: ${t.muted}; }
  </style>
  <div class="frame">
    <div>
      <div class="brand">${MARK(t, 28 * scale)}AgentFund</div>
      <h1>Fund software in tokens.</h1>
      <p class="sub">Maintainers sign small tasks. Backers run them with their own coding agent, in a sandbox, under their own caps. A token counts once CI passes.</p>
      <ul>${legend}</ul>
    </div>
    ${pyramid(t, 40 * scale)}
  </div>`;
}

await mkdir(RAW, { recursive: true });
const browser = await chromium.launch();
// The page is loaded from a file URL so that it may load the fonts from web/node_modules.
async function renderFile(name, html, width, height) {
  const file = `${RAW}${name}.html`;
  await writeFile(file, html);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const tab = await context.newPage();
  await tab.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(200);
  await tab.screenshot({ path: `${RAW}${name}.png` });
  await context.close();
  console.log(`${name}.png`);
}
try {
  for (const theme of ['light', 'dark']) {
    await renderFile(`hero-${theme}`, page(THEMES[theme], { width: 1200, height: 420 }), 1200, 420);
  }
  // GitHub's social preview: 1280x640, the hero's layout with more room above and below.
  await renderFile('social-preview', page(THEMES.light, { width: 1280, height: 640 }), 1280, 640);
} finally {
  await browser.close();
}
