// Screenshot every page in every state, for design review.
//
//   pnpm --filter web screenshots              everything
//   pnpm --filter web screenshots many         one scenario
//   pnpm --filter web screenshots many project one scenario, pages whose name contains "project"
//
// Output: dev/screenshots/<scenario>/<page>--<viewport>-<theme>.png
// Starts `dev:mock` itself unless something already answers on :5173.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ORIGIN = 'http://localhost:5173';
const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url));
const [onlyScenario, onlyPage] = process.argv.slice(2);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const THEMES = ['light', 'dark'];

/** name, path, options: `auth` signs in as the mock admin, `act` runs before the shot. */
const PAGES = [
  ['discover', '/'],
  ['project-tasks', '/gridrs'],
  ['project-task-drawer', '/gridrs/tasks/0001-csv-parser'],
  ['project-activity', '/gridrs/activity'],
  ['project-donors', '/gridrs/donors'],
  ['project-audit', '/gridrs/audit'],
  ['project-back-dialog', '/gridrs', { auth: true, act: (page) => page.getByRole('button', { name: 'Back this project' }).click() }],
  ['project-back-dialog-behaviour', '/gridrs', { auth: true, act: async (page) => { await page.getByRole('button', { name: 'Back this project' }).click(); await page.getByRole('heading', { name: 'It never' }).scrollIntoViewIfNeeded(); } }],
  ['command-palette', '/', { act: async (page) => { await page.keyboard.press('Control+k'); await page.getByPlaceholder(/Jump to/).waitFor(); } }],
  ['donor', '/u/ada'],
  ['leaderboard', '/donors'],
  ['maintain', '/maintain', { auth: true }],
  ['maintain-webhook', '/maintain', { auth: true, act: (page) => page.getByRole('button', { name: 'CI webhook' }).first().click() }],
  ['maintain-signed-out', '/maintain'],
  ['wizard-repository', '/maintain/new', { auth: true }],
  ['wizard-review', '/maintain/new', { auth: true, act: (page) => reviewRepository(page, 'https://github.com/example/hello-project') }],
  ['wizard-review-invalid', '/maintain/new', { auth: true, act: (page) => reviewRepository(page, 'https://github.com/example/unsigned-project') }],
  ['settings', '/settings', { auth: true, act: createKey }],
  ['admin-users', '/admin', { auth: true }],
  ['admin-projects', '/admin/projects', { auth: true }],
  ['admin-instance', '/admin/instance', { auth: true }],
  ['styleguide', '/styleguide'],
  ['not-found', '/no/such/page'],
  ['project-not-found', '/no-such-project'],
];

/** Scenarios and which pages are worth shooting in each. */
const SCENARIOS = {
  many: () => true,
  one: (name) => ['discover', 'project-tasks', 'leaderboard', 'donor'].includes(name),
  empty: (name) => !name.startsWith('project-') && !name.startsWith('wizard-review') && name !== 'styleguide',
  loading: (name) => !/dialog|wizard|styleguide|not-found|signed-out/.test(name),
  error: (name) => !/dialog|wizard|styleguide|^not-found|signed-out/.test(name),
};

async function reviewRepository(page, url) {
  await page.getByLabel('Repository URL').fill(url);
  await page.getByRole('button', { name: 'Check repository' }).click();
  await page.getByRole('heading', { name: /^Review/ }).waitFor();
}

async function createKey(page) {
  const label = page.getByLabel('Label for a new key');
  if (!(await label.isVisible().catch(() => false))) return;
  await label.fill('workstation');
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByText('Copy this key now').waitFor({ timeout: 3000 }).catch(() => undefined);
}

async function ensureServer() {
  const up = () => fetch(ORIGIN).then(() => true, () => false);
  if (await up()) return null;
  const child = spawn('node', [fileURLToPath(new URL('./dev-mock.mjs', import.meta.url))], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await up()) return child;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('dev:mock did not start on :5173');
}

const server = await ensureServer();
const browser = await chromium.launch();
let count = 0;

try {
  for (const [scenario, wanted] of Object.entries(SCENARIOS)) {
    if (onlyScenario && scenario !== onlyScenario) continue;
    await mkdir(`${OUT}${scenario}`, { recursive: true });
    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of THEMES) {
        for (const [name, path, options = {}] of PAGES) {
          if (!wanted(name) || (onlyPage && !name.includes(onlyPage))) continue;
          const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 2 });
          await context.addInitScript(
            ([token, mode]) => {
              window.localStorage.setItem('agentfund.theme', mode);
              if (token) window.localStorage.setItem('agentfund.session', token);
            },
            [options.auth ? 'afs_mock_ada' : null, theme],
          );
          const page = await context.newPage();
          await page.goto(`${ORIGIN}${path}?scenario=${scenario}`, { waitUntil: 'load' });
          if (scenario !== 'loading') {
            await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 5000 }).catch(() => undefined);
          }
          if (options.act && scenario === 'many') await options.act(page).catch((error) => console.warn(`${name}: ${error.message}`));
          await page.waitForTimeout(scenario === 'loading' ? 500 : 900);
          await page.screenshot({ path: `${OUT}${scenario}/${name}--${viewportName}-${theme}.png`, fullPage: !/dialog|drawer|palette/.test(name) });
          await context.close();
          count += 1;
        }
      }
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(`${count} screenshots in ${OUT}`);
