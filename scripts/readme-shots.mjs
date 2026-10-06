// Capture the product screenshots and the live-counter animation used in the README.
//
//   node scripts/readme-shots.mjs
//
// Runs against `pnpm --filter web dev:mock` (started here unless :5173 already answers), so the
// data is the UI's bundled mock dataset, not a live instance; the README says so next to them.
// Raw 2x PNGs land in docs/assets/.raw/ (gitignored); scripts/build-assets.sh optimises them
// into docs/assets/shot-*.png. Playwright is resolved from web/node_modules.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium } = createRequire(`${webDir}package.json`)('playwright');

const ORIGIN = 'http://localhost:5173';
const RAW = fileURLToPath(new URL('../docs/assets/.raw/', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };

// Shots shown at half width in the README are taken in a smaller viewport so their text survives.
const GRID = { width: 1024, height: 640 };

const backDialog = (page) => page.getByRole('button', { name: /Back with tokens/ }).click();

const scrollTo = (text) => async (page) => {
  const top = await page.getByText(text, { exact: false }).first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, top - 96));
};

/** name, path, options — `auth` signs in as the mock admin, `act` runs before the shot, `clip` crops. */
const SHOTS = [
  ['discover', '/'],
  ['project', '/gridrs', { act: scrollTo('Tokens delivered') }],
  ['audit', '/gridrs/audit', { act: scrollTo('What this instance vouches for'), clip: { x: 40, y: 76, width: 640, height: 381 } }],
  ['back', '/gridrs', { auth: true, act: backDialog, viewport: GRID }],
  ['donor', '/u/ada', { clip: { x: 196, y: 68, width: 874, height: 520 } }],
];

async function ensureServer() {
  const up = () => fetch(ORIGIN).then(() => true, () => false);
  if (await up()) return null;
  const child = spawn('node', ['dev/dev-mock.mjs'], { cwd: webDir, stdio: 'ignore' });
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (await up()) return child;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('dev:mock did not start on :5173');
}

async function open(browser, path, theme, { auth = false, viewport = VIEWPORT } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
  await context.addInitScript(
    ([token, mode]) => {
      window.localStorage.setItem('agentfund.theme', mode);
      if (token) window.localStorage.setItem('agentfund.session', token);
    },
    [auth ? 'afs_mock_ada' : null, theme],
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${path}?scenario=many`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 5000 }).catch(() => undefined);
  return { context, page };
}

const server = await ensureServer();
const browser = await chromium.launch();
await mkdir(RAW, { recursive: true });

try {
  {
    for (const theme of ['light', 'dark']) {
      for (const [name, path, options = {}] of SHOTS) {
        const { context, page } = await open(browser, path, theme, options);
        if (options.act) await options.act(page);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${RAW}${name}-${theme}.png`, ...(options.clip ? { clip: options.clip } : {}) });
        await context.close();
        console.log(`${name}-${theme}.png`);
      }
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
