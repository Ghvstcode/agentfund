// Capture the real project page of a running `scripts/demo.sh` instance while a worker runs:
// the counter, the ledger columns and the task board moving. Light and dark from the same session.
//
//   node scripts/readme-live.mjs <seconds> [base-url]     (default base: http://localhost:8787)
//
// Frames (8 per second) land in docs/assets/.raw/live-{light,dark}/; scripts/build-assets.sh
// turns them into docs/assets/live-{light,dark}.gif. Driven by scripts/record-demo.sh.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium } = createRequire(`${webDir}package.json`)('playwright');

const seconds = Number(process.argv[2] ?? 30);
const base = process.argv[3] ?? 'http://localhost:8787';
const RAW = fileURLToPath(new URL('../docs/assets/.raw/', import.meta.url));
const FPS = 8;
const VIEWPORT = { width: 1280, height: 1100 };
const CLIP = { x: 40, y: 232, width: 1200, height: 800 }; // the totals card and the task board

const browser = await chromium.launch();
const pages = [];
for (const theme of ['light', 'dark']) {
  const dir = `${RAW}live-${theme}/`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: theme, deviceScaleFactor: 1 });
  await context.addInitScript((mode) => window.localStorage.setItem('agentfund.theme', mode), theme);
  const page = await context.newPage();
  await page.goto(`${base}/hello`, { waitUntil: 'load' });
  pages.push({ page, dir });
}
await pages[0].page.waitForTimeout(1500);
const start = Date.now();
await writeFile(`${RAW}live-start`, `${(start / 1000).toFixed(3)}\n`); // wall clock of frame 0, for syncing with the tape
console.log('capturing');

const total = seconds * FPS;
for (let frame = 0; frame < total; frame += 1) {
  const name = `${String(frame).padStart(4, '0')}.png`;
  await Promise.all(pages.map(({ page, dir }) => page.screenshot({ path: dir + name, clip: CLIP })));
  const due = start + ((frame + 1) * 1000) / FPS;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
console.log(`${total} frames per theme in ${((Date.now() - start) / 1000).toFixed(1)}s`);
await browser.close();
