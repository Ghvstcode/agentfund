// Render the README hero banner (light + dark) and the social preview card.
//
//   node scripts/readme-brand.mjs
//
// Output (raw, 2x): docs/assets/.raw/hero-{light,dark}.png, docs/assets/.raw/social-preview.png.
// scripts/build-assets.sh optimises them into docs/assets/. Colours and fonts are the web UI's
// own (web/src/index.css): monochrome plus the single `--live` accent. Change them there first.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const require = createRequire(`${webDir}package.json`);
const { chromium } = require('playwright');
const font = (pkg, file) => pathToFileURL(`${webDir}node_modules/@fontsource-variable/${pkg}/files/${file}`).href;
const RAW = fileURLToPath(new URL('../docs/assets/.raw/', import.meta.url));

const THEMES = {
  light: { bg: '#fafafa', card: '#ffffff', fg: '#0a0a0b', muted: '#62626a', border: '#e6e6e8', track: '#ececee', live: '#bd3509', liveSoft: 'rgb(189 53 9 / 0.08)', liveLine: 'rgb(189 53 9 / 0.28)', dot: 'rgb(10 10 11 / 0.07)', shadow: '0 1px 2px rgb(10 10 11 / 0.05)' },
  dark: { bg: '#09090b', card: '#0f0f12', fg: '#f4f4f5', muted: '#a0a0ab', border: 'rgb(255 255 255 / 0.10)', track: '#1d1d21', live: '#ff6a33', liveSoft: 'rgb(255 106 51 / 0.10)', liveLine: 'rgb(255 106 51 / 0.32)', dot: 'rgb(255 255 255 / 0.055)', shadow: '0 1px 2px rgb(0 0 0 / 0.4)' },
};

const MARK = (fill, bolt, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${fill}"/><path d="M18 5 8 18h7l-1 9 10-13h-7z" fill="${bolt}"/></svg>`;

// The four ledger columns, in the UI's own words. Widths are illustrative, not data.
const LEDGER = [
  ['Pledged', 'stated intent', 100, 'track2'],
  ['Reported', 'includes failed runs', 64, 'muted'],
  ['Delivered', 'CI passed', 52, 'live'],
  ['Merged', 'PR merged', 41, 'fg'],
];

function page(t, { width, height, scale = 1, radius = 20, social = false }) {
  const px = (n) => `${n * scale}px`;
  const rows = LEDGER.map(
    ([name, note, pct, tone]) => `
      <div class="row ${tone === 'live' ? 'is-live' : ''}">
        <div class="name">${name}</div>
        <div class="bar"><i style="width:${pct}%;background:${tone === 'live' ? t.live : tone === 'fg' ? t.fg : tone === 'muted' ? t.muted : t.border}"></i></div>
        <div class="note">${note}</div>
      </div>`,
  ).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Geist; src: url("${font('geist', 'geist-latin-wght-normal.woff2')}"); font-weight: 100 900; }
    @font-face { font-family: "Geist Mono"; src: url("${font('geist-mono', 'geist-mono-latin-wght-normal.woff2')}"); font-weight: 100 900; }
    * { box-sizing: border-box; margin: 0; }
    html, body { background: transparent; }
    .frame { width: ${width}px; height: ${height}px; border-radius: ${radius}px; background: ${t.bg}; color: ${t.fg};
      border: ${social ? 0 : 1}px solid ${t.border}; position: relative; overflow: hidden;
      font-family: Geist, system-ui, sans-serif; font-feature-settings: 'ss01', 'cv11'; -webkit-font-smoothing: antialiased;
      display: grid; grid-template-columns: 1fr ${px(404)}; gap: ${px(56)}; align-items: center; padding: ${px(52)} ${px(60)}; }
    .frame::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(${t.dot} 1px, transparent 1px);
      background-size: 22px 22px; mask-image: linear-gradient(105deg, transparent 30%, #000 100%); }
    .frame > * { position: relative; }
    .brand { display: flex; align-items: center; gap: ${px(11)}; font-size: ${px(19)}; font-weight: 600; letter-spacing: -0.015em; }
    .eyebrow { margin-top: ${px(34)}; display: inline-flex; align-items: center; gap: ${px(8)}; height: ${px(28)}; padding: 0 ${px(12)};
      border-radius: 999px; background: ${t.liveSoft}; border: 1px solid ${t.liveLine}; color: ${t.live}; font-size: ${px(13.5)}; font-weight: 500; }
    .eyebrow b { width: ${px(7)}; height: ${px(7)}; border-radius: 50%; background: ${t.live}; }
    h1 { margin-top: ${px(18)}; font-size: ${px(50)}; line-height: 1.04; font-weight: 600; letter-spacing: -0.038em; }
    h1 span { color: ${t.muted}; white-space: nowrap; }
    .sub { margin-top: ${px(18)}; max-width: ${px(560)}; font-size: ${px(17)}; line-height: 1.5; color: ${t.muted}; }
    .sub strong { color: ${t.fg}; font-weight: 500; }
    .card { background: ${t.card}; border: 1px solid ${t.border}; border-radius: ${px(14)}; padding: ${px(24)} ${px(24)} ${px(20)}; box-shadow: ${t.shadow}; }
    .card h2 { font-size: ${px(12.5)}; font-weight: 500; color: ${t.muted}; display: flex; justify-content: space-between; }
    .card h2 em { font-style: normal; color: ${t.live}; }
    .row { margin-top: ${px(17)}; display: grid; grid-template-columns: ${px(84)} 1fr; column-gap: ${px(14)}; row-gap: ${px(5)}; align-items: center; }
    .name { font-family: "Geist Mono", monospace; font-size: ${px(13.5)}; font-weight: 500; }
    .bar { height: ${px(8)}; border-radius: 99px; background: ${t.track}; overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 99px; }
    .note { grid-column: 2; font-size: ${px(12)}; color: ${t.muted}; }
    .is-live .name, .is-live .note { color: ${t.live}; }
    .foot { margin-top: ${px(18)}; padding-top: ${px(14)}; border-top: 1px solid ${t.border}; font-size: ${px(12.5)}; line-height: 1.45; color: ${t.muted}; }
    .foot strong { color: ${t.fg}; font-weight: 500; }
  </style>
  <div class="frame">
    <div>
      <div class="brand">${MARK(t.fg, t.bg, 30 * scale)}AgentFund</div>
      <div class="eyebrow"><b></b>Kickstarter for LLMs</div>
      <h1>Back open source<br>with tokens, <span>not money.</span></h1>
      <p class="sub">Maintainers sign small tasks. Your agent runs them in a sandbox, on your machine, under your caps. <strong>A token counts only after CI passes.</strong></p>
    </div>
    <div class="card">
      <h2>The public ledger <em>4 columns, 1 counts</em></h2>
      ${rows}
      <p class="foot"><strong>Only delivered ranks.</strong> Burned-but-failed tokens stay visible; they never count.</p>
    </div>
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
  await tab.screenshot({ path: `${RAW}${name}.png`, omitBackground: true });
  await context.close();
  console.log(`${name}.png`);
}
try {
  for (const theme of ['light', 'dark']) {
    await renderFile(`hero-${theme}`, page(THEMES[theme], { width: 1200, height: 420 }), 1200, 420);
  }
  // GitHub's social preview: 1280x640, shown at 1x in most places, so render at 1x-equivalent scale.
  await renderFile('social-preview', page(THEMES.dark, { width: 1280, height: 640, scale: 1.28, radius: 0, social: true }), 1280, 640);
} finally {
  await browser.close();
}
