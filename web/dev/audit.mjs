// Quality gates against the production build, served the way the reference server serves it.
//
//   pnpm --filter web build && pnpm --filter web audit            Lighthouse + axe
//   pnpm --filter web audit lighthouse | axe                      one of them
//
// Lighthouse: Discover and a project page, mobile emulation, every category must reach 90.
// axe: the main pages in both themes, zero serious or critical violations.
// Reports land in dev/reports/. Exits non-zero when a gate fails.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright';
import { startMockApi } from './mock-api.mjs';

const PORT = 8788;
const ORIGIN = `http://localhost:${PORT}`;
const REPORTS = fileURLToPath(new URL('./reports/', import.meta.url));
const only = process.argv[2];
const THRESHOLD = 90;
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

const LIGHTHOUSE_PAGES = [
  ['discover', '/'],
  ['project', '/gridrs'],
];

const AXE_PAGES = [
  ['discover', '/'],
  ['project-tasks', '/gridrs'],
  ['project-task-drawer', '/gridrs/tasks/0001-csv-parser'],
  ['project-activity', '/gridrs/activity'],
  ['project-donors', '/gridrs/donors'],
  ['project-audit', '/gridrs/audit'],
  ['project-back-dialog', '/gridrs', (page) => page.getByRole('button', { name: /Back with tokens/ }).click()],
  ['donor', '/u/ada'],
  ['leaderboard', '/donors'],
  ['maintain', '/maintain'],
  ['wizard', '/maintain/new'],
  ['settings', '/settings'],
  ['admin-users', '/admin'],
  ['admin-projects', '/admin/projects'],
  ['admin-instance', '/admin/instance'],
  ['styleguide', '/styleguide'],
  ['not-found', '/no/such/page'],
];

async function runLighthouse() {
  const chrome = await launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-sandbox'] });
  let ok = true;
  try {
    for (const [name, path] of LIGHTHOUSE_PAGES) {
      const result = await lighthouse(`${ORIGIN}${path}`, { port: chrome.port, output: 'html', logLevel: 'error', onlyCategories: CATEGORIES });
      await writeFile(`${REPORTS}lighthouse-${name}.html`, result.report);
      const scores = Object.fromEntries(
        Object.entries(result.lhr.categories).map(([id, category]) => [id, Math.round((category.score ?? 0) * 100)]),
      );
      const audits = result.lhr.audits;
      console.log(
        `lighthouse ${name.padEnd(9)} ${JSON.stringify(scores)}  LCP ${audits['largest-contentful-paint'].displayValue}` +
          ` · CLS ${audits['cumulative-layout-shift'].displayValue} · TBT ${audits['total-blocking-time'].displayValue}`,
      );
      for (const [id, score] of Object.entries(scores)) {
        if (score >= THRESHOLD) continue;
        ok = false;
        const failing = result.lhr.categories[id].auditRefs
          .map((ref) => audits[ref.id])
          .filter((audit) => audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== 'informative')
          .map((audit) => audit.id);
        console.log(`  below ${THRESHOLD}: ${id} (${score}) · ${failing.join(', ')}`);
      }
      const shifts = audits['layout-shifts']?.details?.items ?? [];
      for (const shift of shifts) console.log(`  layout shift ${shift.score.toFixed(3)}: ${shift.node?.selector}`);
    }
  } finally {
    await chrome.kill();
  }
  return ok;
}

async function runAxe() {
  const browser = await chromium.launch();
  let ok = true;
  const findings = [];
  try {
    for (const theme of ['light', 'dark']) {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, colorScheme: theme });
        await context.addInitScript((mode) => {
          window.localStorage.setItem('agentfund.theme', mode);
          window.localStorage.setItem('agentfund.session', 'afs_mock_ada');
        }, theme);
        for (const [name, path, act] of AXE_PAGES) {
          const page = await context.newPage();
          await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
          await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 5000 }).catch(() => undefined);
          if (act) await act(page);
          await page.waitForTimeout(500);
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
          const blocking = violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
          const label = `${name} ${theme} ${viewport.width}px`;
          for (const violation of violations) {
            findings.push({ page: label, id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => node.target.join(' ')) });
          }
          if (blocking.length > 0) {
            ok = false;
            for (const violation of blocking) {
              console.log(`axe ${label}: ${violation.impact} ${violation.id} · ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
            }
          }
          await page.close();
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(`${REPORTS}axe.json`, JSON.stringify(findings, null, 2));
  const minor = findings.filter((finding) => !['serious', 'critical'].includes(finding.impact));
  console.log(
    `axe: ${AXE_PAGES.length} pages × 2 themes × 2 widths · ` +
      `${findings.length - minor.length} serious/critical · ${minor.length} moderate/minor` +
      (minor.length ? ` (${[...new Set(minor.map((finding) => finding.id))].join(', ')})` : ''),
  );
  return ok;
}

await mkdir(REPORTS, { recursive: true });
const server = await startMockApi({ port: PORT, dist: true });
let passed = true;
try {
  if (only !== 'axe') passed = (await runLighthouse()) && passed;
  if (only !== 'lighthouse') passed = (await runAxe()) && passed;
} finally {
  server.close();
  server.closeAllConnections();
}
process.exit(passed ? 0 : 1);
