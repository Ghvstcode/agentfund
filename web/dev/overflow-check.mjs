// Sweep every page for horizontal overflow and clipped content.
//
//   pnpm --filter web exec node dev/overflow-check.mjs [width ...]     default widths: 1024 390
//
// For each page × width × theme it reports: page-level horizontal scroll, elements that stick
// out of the viewport or of the card they sit in, and text cut off without an ellipsis.
// Starts `dev:mock` itself unless something already answers on :5173. Exits 1 on findings.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ORIGIN = 'http://localhost:5173';
const widths = process.argv.slice(2).map(Number).filter(Boolean);
const WIDTHS = widths.length ? widths : [1024, 390];

const back = (page) => page.getByRole('button', { name: /Back with tokens/ }).click();
const review = async (page, repo) => {
  await page.getByLabel('Repository URL').fill(`https://github.com/example/${repo}`);
  await page.getByRole('button', { name: 'Check repository' }).click();
  await page.getByRole('heading', { name: /^Review/ }).waitFor();
};

const PAGES = [
  ['discover', '/'],
  ['project-tasks', '/gridrs'],
  ['project-task-sheet', '/gridrs/tasks/0001-csv-parser'],
  ['project-activity', '/gridrs/activity'],
  ['project-donors', '/gridrs/donors'],
  ['project-audit', '/gridrs/audit'],
  ['back-dialog', '/gridrs', back],
  ['donor', '/u/ada'],
  ['leaderboard', '/donors'],
  ['maintain', '/maintain'],
  ['maintain-webhook', '/maintain', (page) => page.getByRole('button', { name: 'CI webhook' }).first().click()],
  ['wizard', '/maintain/new'],
  ['wizard-review', '/maintain/new', (page) => review(page, 'hello-project')],
  ['wizard-invalid', '/maintain/new', (page) => review(page, 'unsigned-project')],
  ['settings', '/settings', async (page) => { await page.getByLabel('Label for a new key').fill('workstation'); await page.getByRole('button', { name: 'Create key' }).click(); await page.getByText('Copy this key now').waitFor(); }],
  ['admin-users', '/admin'],
  ['admin-projects', '/admin/projects'],
  ['admin-instance', '/admin/instance'],
  ['styleguide', '/styleguide'],
  ['not-found', '/no/such/page'],
  ['sign-in', '/maintain', null, { signedOut: true }],
  ['sign-in-dialog', '/', (page) => page.getByRole('button', { name: 'Sign in' }).click(), { signedOut: true }],
  ['command-palette', '/', async (page) => { await page.keyboard.press('Control+k'); await page.getByPlaceholder(/Jump to/).waitFor(); }],
];

/** Runs in the page. Returns human-readable findings. */
function findOverflow() {
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} "${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  };
  const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
  const insideScroller = (el) => { for (let a = el.parentElement; a; a = a.parentElement) if (scrolls(a) && a.scrollWidth > a.clientWidth) return true; return false; };
  const clipsX = (el) => /(hidden|clip)/.test(getComputedStyle(el).overflowX);
  const findings = new Set();
  const viewport = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewport + 1) findings.add(`page scrolls sideways: ${document.documentElement.scrollWidth}px wide in a ${viewport}px viewport`);

  // A sideways-scrolling region is fine for data, but not when it hides controls.
  for (const region of document.querySelectorAll('body *')) {
    if (!scrolls(region) || region.scrollWidth <= region.clientWidth + 1) continue;
    const edge = region.getBoundingClientRect().right;
    const hidden = [...region.querySelectorAll('button, a[href], select, input')].filter((control) => control.getBoundingClientRect().left >= edge - 4);
    if (hidden.length > 0) findings.add(`controls scrolled out of view in ${describe(region).slice(0, 50)}: ${describe(hidden[0])}`);
  }

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.closest('[aria-hidden="true"], .sr-only, svg')) continue;
    if (el.closest('.sr-only') || style.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (insideScroller(el)) continue;
    // Sticking out of the viewport.
    if (rect.right > viewport + 1 || rect.left < -1) {
      let clipped = false;
      for (let a = el.parentElement; a; a = a.parentElement) if (clipsX(a) && a.getBoundingClientRect().right <= viewport + 1) clipped = true;
      findings.add(`${clipped ? 'clipped at' : 'outside'} viewport: ${describe(el)}`);
      continue;
    }
    // Sticking out of the nearest bordered box (card, column, dialog).
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const box = getComputedStyle(a);
      if (parseFloat(box.borderRightWidth) === 0 && !a.matches('[role="dialog"]')) continue;
      const outer = a.getBoundingClientRect();
      if (rect.right > outer.right + 1 || rect.left < outer.left - 1) findings.add(`overflows its box: ${describe(el)} in ${describe(a).slice(0, 60)}`);
      break;
    }
    // Text cut off without an ellipsis to say so.
    // (Form fields scroll their own value; that is not clipping.)
    if (!el.matches('input, textarea, select') && el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && clipsX(el) && style.textOverflow !== 'ellipsis') {
      findings.add(`text cut off: ${describe(el)}`);
    }
  }
  return [...findings];
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
let total = 0;
try {
  for (const width of WIDTHS) {
    for (const theme of ['dark', 'light']) {
      for (const [name, path, act, options = {}] of PAGES) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
        await context.addInitScript(([mode, token]) => {
          window.localStorage.setItem('agentfund.theme', mode);
          if (token) window.localStorage.setItem('agentfund.session', token);
        }, [theme, options.signedOut ? null : 'afs_mock_ada']);
        const page = await context.newPage();
        await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 5000 }).catch(() => undefined);
        if (act) await act(page).catch((error) => console.log(`${name} ${width}px: could not act: ${error.message.split('\n')[0]}`));
        await page.waitForTimeout(900);
        const findings = await page.evaluate(findOverflow);
        // The same layout problem shows in both themes; print it once.
        if (theme === 'dark') for (const finding of findings) console.log(`${name} ${width}px · ${finding}`);
        total += theme === 'dark' ? findings.length : 0;
        await page.screenshot({ path: fileURLToPath(new URL(`./screenshots/sweep/${name}--${width}-${theme}.png`, import.meta.url)), fullPage: !/dialog|sheet|palette/.test(name) });
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(total === 0 ? `no overflow or clipping on ${PAGES.length} pages at ${WIDTHS.join(', ')}px` : `${total} findings`);
process.exit(total === 0 ? 0 : 1);
