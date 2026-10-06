// Mock AgentFund API for UI development. No dependencies.
//
//   node dev/mock-api.mjs            API on http://localhost:8788
//   node dev/mock-api.mjs --dist     also serve ../dist the way the reference server does
//
// Every response follows spec/openapi.yaml. Scenarios select a data set:
//   many (default) · one · empty · error · loading
// Pick one per request with `?scenario=<name>` or by prefixing the path: `/s/<name>/v1/...`.
// The SSE stream simulates workers: in_flight climbs, then delivered and merged jump.
//
// Sessions: `POST /v1/auth/dev` works for any handle; `ada` is the instance admin.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const BASE_URL = process.env.MOCK_BASE_URL ?? `http://localhost:${PORT}`;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SCENARIOS = ['many', 'one', 'empty', 'error', 'loading'];
const DAY = 86_400_000;

// ───────────────────────────── deterministic helpers ─────────────────────────────

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (rnd, length) =>
  Array.from({ length }, () => Math.floor(rnd() * 16).toString(16)).join('');
const b36 = (rnd, length) =>
  Array.from({ length }, () => Math.floor(rnd() * 36).toString(36)).join('');
const between = (rnd, lo, hi) => Math.floor(lo + rnd() * (hi - lo));
const iso = (ms) => new Date(ms).toISOString();

// ───────────────────────────── fixtures ─────────────────────────────

const HANDLES = [
  'ada', 'lin', 'grace', 'ken', 'margaret', 'dennis', 'barbara', 'edsger',
  'radia', 'tim', 'frances', 'niklaus', 'karen', 'leslie',
];

const PROJECTS = [
  ['gridrs', 'A terminal spreadsheet in Rust.', 'rust', ['tui', 'spreadsheet'], 60e6, 0.62],
  ['tinyraft', 'A readable Raft implementation with a deterministic simulator.', 'rust', ['distributed', 'consensus'], 200e6, 0.34],
  ['pgroll-lite', 'Zero-downtime Postgres schema migrations in a single binary.', 'go', ['postgres', 'migrations'], 120e6, 0.48],
  ['markdown-lsp', 'A language server for Markdown: links, headings, references.', 'typescript', ['lsp', 'editor'], 40e6, 0.81],
  ['osm-tiles', 'Vector tile renderer for OpenStreetMap extracts.', 'c++', ['maps', 'rendering'], 350e6, 0.12],
  ['quillpdf', 'Typeset PDFs from plain text without a TeX install.', 'python', ['pdf', 'typesetting'], 80e6, 0.27],
  ['hearth', 'Self-hosted home energy dashboard.', 'typescript', ['iot', 'dashboard'], 30e6, 0.55],
  ['zigzip', 'Streaming zip and tar archives in Zig.', 'zig', ['compression'], 25e6, 1.04],
  ['fernet-kt', 'Kotlin multiplatform crypto envelopes.', 'kotlin', ['crypto'], 45e6, 0.19],
  ['sqlfmt', 'An opinionated SQL formatter with stable output.', 'rust', ['sql', 'formatter'], 50e6, 0.4],
  ['aria-check', 'Accessibility linting for HTML templates.', 'typescript', ['a11y', 'lint'], 35e6, 0.07],
  ['kelp', 'A tiny static site generator in Elixir.', 'elixir', ['static-site'], 20e6, 0.66],
  ['bitplane', 'Lossless image codecs, documented line by line.', 'c', ['codec', 'images'], 150e6, 0.23],
  ['tide-calendar', 'Offline tide predictions from harmonic constants.', 'python', ['science'], 15e6, 0],
];

const TASK_TITLES = [
  ['csv-parser', 'CSV parser with quoted fields'],
  ['formula-tokenizer', 'Formula tokenizer'],
  ['cell-references', 'Resolve relative and absolute cell references'],
  ['undo-stack', 'Undo and redo stack'],
  ['column-width', 'Auto-size columns to content'],
  ['clipboard', 'Yank and paste ranges'],
  ['property-tests', 'Property tests for the parser'],
  ['error-types', 'Structured error types'],
  ['json-output', 'Add --json output to the CLI'],
  ['windows-paths', 'Handle Windows paths'],
  ['fuzz-harness', 'Fuzz harness for untrusted input'],
  ['hot-path-allocs', 'Remove allocations from the hot path'],
  ['config-loader', 'Config file loader'],
  ['man-page', 'Generate the man page'],
];

function manifestFor(index, [suffix, title], rnd, dependsOn) {
  const id = `${String(index + 1).padStart(4, '0')}-${suffix}`;
  const module = suffix.replace(/-/g, '_');
  return {
    spec_version: 1,
    id,
    title,
    prompt: [
      `Implement "${title}" in src/${module}/.`,
      '',
      'Requirements:',
      '- Keep the public API in src/lib unchanged; add new items behind it.',
      `- Cover the behaviour with tests in tests/${module}.rs, including the edge cases listed in docs/${module}.md.`,
      '- No new dependencies. No unsafe code.',
      '',
      'When you are done, run the verify command yourself and fix anything it reports.',
    ].join('\n'),
    scope: {
      write: [`src/${module}/**`, `tests/${module}.rs`],
      read: ['src/**', 'tests/**', 'docs/**', 'Cargo.toml'],
    },
    verify: `cargo test --test ${module} && cargo clippy -- -D warnings`,
    max_tokens: between(rnd, 20, 90) * 100_000,
    timeout_minutes: 60,
    depends_on: dependsOn,
    base_branch: 'main',
  };
}

function buildWorld(scenario) {
  const rnd = prng(20261006);
  const now = Date.now();
  const world = {
    scenario,
    now,
    rnd,
    users: new Map(),
    projects: [],
    tasks: [],
    pledges: [],
    reports: [],
    claims: [],
    events: [],
    apiKeys: [],
    config: {
      name: 'Commons Compute',
      description: 'Inference for open source, donated and audited in the open.',
      project_creation: 'open',
      lease_seconds: 7200,
      new_project_max_tokens_per_task: 5_000_000,
      new_project_max_tokens_per_day: 25_000_000,
      established_after_merged_tasks: 3,
      max_active_claims_per_donor: 2,
    },
    seq: 0,
  };

  const userCount = scenario === 'empty' ? 0 : scenario === 'one' ? 4 : HANDLES.length;
  HANDLES.slice(0, userCount).forEach((handle, i) => {
    world.users.set(handle, {
      handle,
      role: i === 0 ? 'admin' : i < 4 ? 'maintainer' : 'donor',
      github_login: handle,
      email: null,
      banned: false,
      created_at: iso(now - (90 - i * 3) * DAY),
    });
  });

  const projectCount = scenario === 'empty' ? 0 : scenario === 'one' ? 1 : PROJECTS.length;
  PROJECTS.slice(0, projectCount).forEach((definition, index) => seedProject(world, definition, index));
  world.events.sort((a, b) => b.at.localeCompare(a.at));
  return world;
}

function seedProject(world, [slug, description, language, tags, goal, progress], index) {
  const { rnd, now } = world;
  const handles = [...world.users.keys()];
  const maintainer = handles[index % Math.min(4, handles.length)];
  const created = now - (60 - index * 3) * DAY;
  const project = {
    slug,
    name: slug,
    description,
    repo_url: `https://github.com/example/${slug}`,
    homepage: null,
    language,
    tags,
    status: slug === 'kelp' ? 'paused' : slug === 'aria-check' ? 'pending' : 'active',
    ci_provider: 'github',
    base_branch: 'main',
    follow_branch: index % 3 !== 0,
    maintainer,
    pubkey: `RW${Buffer.from(hex(rnd, 80), 'hex').toString('base64').slice(0, 54)}`,
    pubkey_fingerprint: `SHA256:${hex(rnd, 64)}`,
    pinned_commit: hex(rnd, 40),
    lock_sha256: hex(rnd, 64),
    webhook_secret: `whsec_${hex(rnd, 40)}`,
    token_goal: goal,
    created_at: iso(created),
    last_indexed_at: iso(now - between(rnd, 1, 50) * 60_000),
    index_error:
      slug === 'fernet-kt'
        ? 'Lock signature at 9c1e4b7 does not verify against the registered key. The pin stays at the last good commit.'
        : null,
  };
  world.projects.push(project);
  event(world, created, maintainer, 'project.created', slug, null, { repo_url: project.repo_url });

  const taskCount = progress === 0 ? 5 : between(rnd, 8, TASK_TITLES.length + 1);
  const finished = Math.round(taskCount * Math.min(progress, 1) * 0.9);
  for (let i = 0; i < taskCount; i += 1) {
    const dependsOn = i > 0 && i % 4 === 3 ? [`${String(i).padStart(4, '0')}-${TASK_TITLES[i - 1][0]}`] : [];
    const manifest = manifestFor(i, TASK_TITLES[i], rnd, dependsOn);
    const task = {
      project: slug,
      task_id: manifest.id,
      title: manifest.title,
      state: 'open',
      content_hash: hex(rnd, 64),
      manifest_path: `tasks/${manifest.id}.yaml`,
      manifest,
      updated_at: iso(created),
    };
    world.tasks.push(task);
    event(world, created + 1000, 'indexer', 'manifest.added', slug, `${slug}:${manifest.id}`, {
      content_hash: task.content_hash,
    });
    if (i >= finished) continue;

    // A finished task: sometimes one failed run first, then the run that delivered.
    // The first few projects each get one delivery on a recent consecutive day from the
    // first user, so there is a donor with a streak to look at.
    const streak = i === finished - 2 && index < 6;
    const donor = streak ? handles[0] : handles[between(rnd, 0, handles.length)];
    const at = streak ? now - index * DAY - 30 * 60_000 : created + ((now - created) * (i + 1)) / (finished + 2);
    // Earlier attempts that did not stick: a failed run, a PR whose CI failed, a PR closed unmerged.
    const earlier = rnd();
    const attempt = earlier < 0.3 ? 'failed' : earlier < 0.42 ? 'ci_failed' : earlier < 0.5 ? 'closed' : null;
    if (attempt) seedReport(world, task, handles[between(rnd, 0, handles.length)], at - DAY / 2, attempt);
    const outcome =
      i < finished - 2 || (streak && index % 2 === 0) ? 'merged' : i < finished - 1 ? 'delivered' : 'pending_ci';
    seedReport(world, task, donor, at, outcome);
  }

  const pledgeCount = progress === 0 ? 0 : between(rnd, 3, 9);
  for (let i = 0; i < pledgeCount; i += 1) {
    const donor = handles[between(rnd, 0, handles.length)];
    const at = created + rnd() * (now - created);
    const amount = Math.round((goal * (0.4 + progress) * (0.5 + rnd())) / pledgeCount / 1e5) * 1e5;
    world.pledges.push({ id: `plg_${b36(rnd, 16)}`, project: slug, donor, token_amount: amount, created_at: iso(at) });
    event(world, at, donor, 'pledge.created', slug, null, { tokens: amount });
  }
}

function seedReport(world, task, donor, at, outcome) {
  const { rnd } = world;
  const ref = `${task.project}:${task.task_id}`;
  const claimId = `clm_${b36(rnd, 20)}`;
  const tokensIn = Math.round(task.manifest.max_tokens * (0.45 + rnd() * 0.4));
  const tokensOut = Math.round(tokensIn * (0.04 + rnd() * 0.05));
  const completed = outcome !== 'failed';
  const branch = `agentfund/${task.task_id}-${claimId.slice(4, 12)}`;
  const report = {
    id: `rep_${b36(rnd, 16)}`,
    claim_id: claimId,
    task_id: ref,
    project: task.project,
    donor,
    status: completed ? 'completed' : 'failed',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate: Math.round((tokensIn * 3 + tokensOut * 15) / 1e4) / 100,
    branch: completed ? branch : null,
    pr_url: completed ? `https://github.com/example/${task.project}/pull/${between(rnd, 12, 480)}` : null,
    head_sha: completed ? hex(rnd, 40) : null,
    verify_exit_code: completed ? 0 : 101,
    log_digest: hex(rnd, 64),
    duration_seconds: between(rnd, 400, 3200),
    runner: 'claude-code/2.1.0',
    model: 'claude-sonnet-4-5',
    message: completed ? null : 'verify exited 101: 2 tests failed in tests/parser.rs',
    flagged_late: false,
    delivery: completed ? outcome : 'none',
    ci: null,
    created_at: iso(at),
    delivered_at: null,
    merged_at: null,
  };
  world.reports.push(report);
  event(world, at - report.duration_seconds * 1000, donor, 'task.claimed', task.project, ref, { claim_id: claimId });
  event(world, at, donor, 'report.received', task.project, ref, {
    status: report.status,
    tokens: tokensIn + tokensOut,
  });
  task.updated_at = iso(at);
  if (!completed) return;
  task.state = 'claimed';
  if (outcome === 'pending_ci') return;
  if (outcome === 'ci_failed') {
    report.ci = { provider: 'github', conclusion: 'failure', run_url: `https://github.com/example/${task.project}/actions/runs/${between(rnd, 1e9, 9e9)}`, received_at: iso(at + 6 * 60_000) };
    task.state = 'open';
    event(world, at + 6 * 60_000, 'ci', 'ci.result', task.project, ref, { conclusion: 'failure', head_sha: report.head_sha });
    event(world, at + 6 * 60_000 + 1, 'ci', 'task.reopened', task.project, ref, { reason: 'ci_failed' });
    return;
  }
  if (outcome === 'closed') {
    markDelivered(world, report, task, at + 6 * 60_000);
    report.delivery = 'closed';
    task.state = 'open';
    event(world, at + 3_600_000, 'ci', 'task.reopened', task.project, ref, { reason: 'pr_closed' });
    return;
  }
  markDelivered(world, report, task, at + 6 * 60_000);
  if (outcome === 'merged') markMerged(world, report, task, Math.min(world.now - 60_000, at + 5 * 3_600_000));
}

function markDelivered(world, report, task, at) {
  report.delivery = 'delivered';
  report.delivered_at = iso(at);
  report.ci = {
    provider: 'github',
    conclusion: 'success',
    run_url: `https://github.com/example/${report.project}/actions/runs/${between(world.rnd, 1e9, 9e9)}`,
    received_at: iso(at),
  };
  task.state = 'delivered';
  task.updated_at = iso(at);
  const tokens = report.tokens_in + report.tokens_out;
  event(world, at, 'ci', 'ci.result', report.project, report.task_id, { conclusion: 'success', head_sha: report.head_sha });
  return event(world, at + 1, 'ci', 'task.delivered', report.project, report.task_id, { tokens, pr_url: report.pr_url });
}

function markMerged(world, report, task, at) {
  report.delivery = 'merged';
  report.merged_at = iso(at);
  task.state = 'merged';
  task.updated_at = iso(at);
  return event(world, at, 'ci', 'task.merged', report.project, report.task_id, {
    tokens: report.tokens_in + report.tokens_out,
    pr_url: report.pr_url,
  });
}

function event(world, at, actor, action, project, taskId, payload) {
  world.seq += 1;
  const record = {
    id: `evt_${String(world.seq).padStart(8, '0')}`,
    at: iso(at),
    actor,
    action,
    project,
    task_id: taskId,
    payload,
  };
  world.events.unshift(record);
  return record;
}

// ───────────────────────────── views (OpenAPI shapes) ─────────────────────────────

const userRef = (handle) => ({ id: `${BASE_URL}/u/${handle}`, handle, avatar_url: null });
const meView = (user) => ({ ...userRef(user.handle), ...user });
const tokensOf = (report) => report.tokens_in + report.tokens_out;
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

function totalsFor(world, filter) {
  const reports = world.reports.filter(filter);
  return {
    pledged: sum(world.pledges.filter(filter), (p) => p.token_amount),
    reported: sum(reports.filter((r) => !r.flagged_late), tokensOf),
    delivered: sum(reports.filter((r) => r.delivered_at), tokensOf),
    merged: sum(reports.filter((r) => r.merged_at), tokensOf),
    in_flight: sum(world.claims.filter(filter), (c) => c.tokens_so_far),
  };
}

function taskCounts(world, project) {
  const counts = { open: 0, claimed: 0, delivered: 0, merged: 0, failed: 0, claimable: 0 };
  for (const task of world.tasks) {
    if (task.project !== project.slug) continue;
    counts[task.state] += 1;
    if (isClaimable(world, task, project)) counts.claimable += 1;
  }
  return counts;
}

function blockedBy(world, task) {
  return task.manifest.depends_on.filter((dependency) => {
    const other = world.tasks.find((t) => t.project === task.project && t.task_id === dependency);
    return !other || other.state !== 'merged';
  });
}

function isClaimable(world, task, project) {
  return task.state === 'open' && project.status === 'active' && blockedBy(world, task).length === 0;
}

function standings(world, filter) {
  const rows = new Map();
  const row = (handle) => {
    if (!rows.has(handle)) {
      rows.set(handle, { ...userRef(handle), pledged: 0, reported: 0, delivered: 0, merged: 0, tasks_delivered: 0, tasks_merged: 0 });
    }
    return rows.get(handle);
  };
  for (const pledge of world.pledges.filter(filter)) row(pledge.donor).pledged += pledge.token_amount;
  for (const report of world.reports.filter(filter)) {
    const entry = row(report.donor);
    entry.reported += tokensOf(report);
    if (report.delivered_at) {
      entry.delivered += tokensOf(report);
      entry.tasks_delivered += 1;
    }
    if (report.merged_at) {
      entry.merged += tokensOf(report);
      entry.tasks_merged += 1;
    }
  }
  return [...rows.values()].sort((a, b) => b.delivered - a.delivered || a.handle.localeCompare(b.handle));
}

function projectView(world, project) {
  const inProject = (record) => record.project === project.slug;
  const weekAgo = iso(world.now - 7 * DAY);
  const reports = world.reports.filter(inProject);
  const mergedTasks = world.tasks.filter((t) => inProject(t) && t.state === 'merged').length;
  const established = mergedTasks >= world.config.established_after_merged_tasks;
  const lastEvent = world.events.find(inProject);
  const { webhook_secret: _secret, ...publicFields } = project;
  return {
    id: `${BASE_URL}/${project.slug}`,
    ...publicFields,
    maintainer: userRef(project.maintainer),
    lock_url: `${project.repo_url}/blob/${project.pinned_commit}/tasks/MANIFEST.lock`,
    commit_url: `${project.repo_url}/commit/${project.pinned_commit}`,
    totals: totalsFor(world, inProject),
    tasks: taskCounts(world, project),
    donors: standings(world, inProject).length,
    velocity_7d: sum(reports.filter((r) => r.delivered_at && r.delivered_at > weekAgo), tokensOf),
    trust: {
      tier: established ? 'established' : 'new',
      merged_tasks: mergedTasks,
      max_tokens_per_task: established ? null : world.config.new_project_max_tokens_per_task,
      max_tokens_per_day: established ? null : world.config.new_project_max_tokens_per_day,
    },
    last_activity_at: lastEvent ? lastEvent.at : null,
  };
}

function reportView(report) {
  const { delivered_at: _d, merged_at: _m, ...rest } = report;
  return { ...rest, donor: userRef(report.donor) };
}

function taskView(world, task) {
  const project = world.projects.find((p) => p.slug === task.project);
  const ref = `${task.project}:${task.task_id}`;
  const reports = world.reports.filter((r) => r.task_id === ref);
  const claim = world.claims.find((c) => c.task_id === ref);
  const latest = reports.at(-1);
  return {
    id: ref,
    task_id: task.task_id,
    project: task.project,
    title: task.title,
    state: task.state,
    content_hash: task.content_hash,
    manifest_path: task.manifest_path,
    commit: project.pinned_commit,
    manifest: task.manifest,
    depends_on: task.manifest.depends_on,
    blocked_by: blockedBy(world, task),
    claimable: isClaimable(world, task, project),
    burn: {
      tokens_in: sum(reports, (r) => r.tokens_in),
      tokens_out: sum(reports, (r) => r.tokens_out),
      total: sum(reports, tokensOf),
      runs: reports.length,
    },
    active_claim: claim
      ? {
          donor: userRef(claim.donor),
          claimed_at: claim.claimed_at,
          lease_expires_at: iso(Date.now() + world.config.lease_seconds * 1000),
          tokens_so_far: claim.tokens_so_far,
          phase: claim.phase,
        }
      : null,
    latest_report: latest ? reportView(latest) : null,
    updated_at: task.updated_at,
  };
}

function ledgerEntries(world, filter) {
  const entries = [];
  const titleOf = (ref) => world.tasks.find((t) => `${t.project}:${t.task_id}` === ref)?.title ?? null;
  for (const pledge of world.pledges.filter(filter)) {
    entries.push({
      id: pledge.id, type: 'pledge', at: pledge.created_at, donor: userRef(pledge.donor), project: pledge.project,
      tokens: pledge.token_amount, task_id: null, task_title: null, report_status: null, pr_url: null,
      ci_run_url: null, branch: null, head_sha: null,
    });
  }
  for (const report of world.reports.filter(filter)) {
    const common = {
      donor: userRef(report.donor), project: report.project, tokens: tokensOf(report), task_id: report.task_id,
      task_title: titleOf(report.task_id), report_status: report.status, pr_url: report.pr_url,
      ci_run_url: report.ci?.run_url ?? null, branch: report.branch, head_sha: report.head_sha,
    };
    entries.push({ id: `${report.id}_r`, type: 'report', at: report.created_at, ...common, delivery: report.delivery });
    if (report.delivered_at) entries.push({ id: `${report.id}_d`, type: 'delivery', at: report.delivered_at, ...common });
    if (report.merged_at) entries.push({ id: `${report.id}_m`, type: 'merge', at: report.merged_at, ...common });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function donorView(world, handle) {
  const user = world.users.get(handle);
  const mine = (record) => record.donor === handle;
  const board = standings(world, () => true);
  const standing = standings(world, mine)[0] ?? {
    ...userRef(handle), pledged: 0, reported: 0, delivered: 0, merged: 0, tasks_delivered: 0, tasks_merged: 0,
  };
  const slugs = [...new Set([...world.pledges, ...world.reports].filter(mine).map((r) => r.project))];
  const projects = slugs
    .map((slug) => {
      const totals = totalsFor(world, (r) => mine(r) && r.project === slug);
      const name = world.projects.find((p) => p.slug === slug)?.name ?? slug;
      return { slug, name, pledged: totals.pledged, delivered: totals.delivered, merged: totals.merged };
    })
    .sort((a, b) => b.delivered - a.delivered);
  const days = new Set(world.reports.filter((r) => mine(r) && r.delivered_at).map((r) => r.delivered_at.slice(0, 10)));
  let streak = 0;
  for (let day = days.has(iso(Date.now()).slice(0, 10)) ? 0 : 1; days.has(iso(Date.now() - day * DAY).slice(0, 10)); day += 1) {
    streak += 1;
  }
  const rank = board.findIndex((row) => row.handle === handle && row.delivered > 0);
  return {
    ...standing,
    github_login: user.github_login,
    joined_at: user.created_at,
    projects_backed: slugs.length,
    streak_days: streak,
    rank: rank === -1 ? null : rank + 1,
    projects,
    recent: ledgerEntries(world, (r) => mine(r)).filter((e) => e.type !== 'pledge').slice(0, 12),
  };
}

function paginate(items, query) {
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 50)));
  const offset = Number(Buffer.from(query.get('cursor') ?? '', 'base64url').toString() || 0);
  const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
  return { items: items.slice(offset, offset + limit), next_cursor: next };
}

// ───────────────────────────── live simulation + SSE ─────────────────────────────

const worlds = new Map();
const subscribers = new Set();

function worldFor(scenario) {
  const key = scenario === 'error' || scenario === 'loading' ? 'many' : scenario;
  if (!worlds.has(key)) worlds.set(key, buildWorld(key));
  return worlds.get(key);
}

function streamFrame(world, slug) {
  if (!slug) return { scope: 'instance', project: null, totals: totalsFor(world, () => true), token_goal: null, tasks: null };
  const project = world.projects.find((p) => p.slug === slug);
  return {
    scope: 'project',
    project: slug,
    totals: totalsFor(world, (r) => r.project === slug),
    token_goal: project.token_goal,
    tasks: taskCounts(world, project),
  };
}

function send(res, name, data) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(world, slug, record) {
  for (const subscriber of subscribers) {
    if (subscriber.world !== world) continue;
    if (subscriber.project && subscriber.project !== slug) continue;
    if (record) send(subscriber.res, 'event', record);
    send(subscriber.res, 'totals', streamFrame(world, subscriber.project));
  }
}

const PHASES = ['verifying', 'sandbox', 'agent', 'agent', 'agent', 'verify', 'pushing'];

/** One step of the simulated worker fleet for the first two active projects of a world. */
function tick(world) {
  const live = world.projects.filter((p) => p.status === 'active').slice(0, 2);
  const now = Date.now();
  for (const project of live) {
    const slug = project.slug;
    const claim = world.claims.find((c) => c.project === slug);
    if (claim) {
      claim.tokens_so_far += between(world.rnd, 30_000, 120_000);
      claim.phase = PHASES[Math.min(PHASES.length - 1, Math.floor((claim.tokens_so_far / claim.target) * PHASES.length))];
      if (claim.tokens_so_far >= claim.target) finishClaim(world, claim, now);
      else broadcast(world, slug, null);
      continue;
    }
    const pending = world.reports.find((r) => r.project === slug && r.delivery === 'pending_ci' && r.sim_due <= now);
    if (pending) {
      const task = world.tasks.find((t) => `${t.project}:${t.task_id}` === pending.task_id);
      broadcast(world, slug, markDelivered(world, pending, task, now));
      pending.sim_due = now + 5000;
      continue;
    }
    const delivered = world.reports.find((r) => r.project === slug && r.delivery === 'delivered' && r.sim_due <= now);
    if (delivered) {
      const task = world.tasks.find((t) => `${t.project}:${t.task_id}` === delivered.task_id);
      broadcast(world, slug, markMerged(world, delivered, task, now));
      continue;
    }
    startClaim(world, project, now);
  }
}

function startClaim(world, project, now) {
  let task = world.tasks.find((t) => t.project === project.slug && isClaimable(world, t, project));
  if (!task) {
    // Nothing left to claim: reopen the oldest merged task so the demo keeps moving.
    task = world.tasks.find((t) => t.project === project.slug && t.state === 'merged');
    if (!task) return;
    task.state = 'open';
    broadcast(world, project.slug, event(world, now, 'system', 'task.reopened', project.slug, `${project.slug}:${task.task_id}`, {}));
  }
  const handles = [...world.users.keys()];
  const donor = handles[between(world.rnd, 0, handles.length)];
  const claim = {
    claim_id: `clm_${b36(world.rnd, 20)}`,
    project: project.slug,
    task_id: `${project.slug}:${task.task_id}`,
    donor,
    claimed_at: iso(now),
    tokens_so_far: 0,
    target: Math.round(task.manifest.max_tokens * (0.35 + world.rnd() * 0.3)),
    phase: 'verifying',
  };
  world.claims.push(claim);
  task.state = 'claimed';
  task.updated_at = iso(now);
  broadcast(world, project.slug, event(world, now, donor, 'task.claimed', project.slug, claim.task_id, { claim_id: claim.claim_id }));
}

function finishClaim(world, claim, now) {
  world.claims.splice(world.claims.indexOf(claim), 1);
  const tokensOut = Math.round(claim.tokens_so_far * 0.07);
  const [, manifestId] = claim.task_id.split(':');
  const report = {
    id: `rep_${b36(world.rnd, 16)}`,
    claim_id: claim.claim_id,
    task_id: claim.task_id,
    project: claim.project,
    donor: claim.donor,
    status: 'completed',
    tokens_in: claim.tokens_so_far - tokensOut,
    tokens_out: tokensOut,
    cost_estimate: Math.round(claim.tokens_so_far / 2500) / 100,
    branch: `agentfund/${manifestId}-${claim.claim_id.slice(4, 12)}`,
    pr_url: `https://github.com/example/${claim.project}/pull/${between(world.rnd, 500, 900)}`,
    head_sha: hex(world.rnd, 40),
    verify_exit_code: 0,
    log_digest: hex(world.rnd, 64),
    duration_seconds: Math.round((now - Date.parse(claim.claimed_at)) / 1000),
    runner: 'claude-code/2.1.0',
    model: 'claude-sonnet-4-5',
    message: null,
    flagged_late: false,
    delivery: 'pending_ci',
    ci: null,
    created_at: iso(now),
    delivered_at: null,
    merged_at: null,
    sim_due: now + 4000,
  };
  world.reports.push(report);
  const record = event(world, now, claim.donor, 'report.received', claim.project, claim.task_id, {
    status: 'completed',
    tokens: claim.tokens_so_far,
  });
  broadcast(world, claim.project, record);
}

// ───────────────────────────── HTTP plumbing ─────────────────────────────

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '600',
};

class Problem extends Error {
  constructor(status, code, title, detail, errors) {
    super(title);
    Object.assign(this, { status, code, title, detail, errors });
  }
}

function json(res, status, body) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendProblem(res, problem, instance) {
  res.writeHead(problem.status, { ...CORS, 'content-type': 'application/problem+json' });
  res.end(
    JSON.stringify({
      type: `${BASE_URL}/problems/${problem.code}`,
      title: problem.title,
      status: problem.status,
      detail: problem.detail,
      instance,
      errors: problem.errors,
    }),
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Problem(422, 'validation', 'Body is not valid JSON');
  }
}

function sessionUser(world, req, { required = true, role } = {}) {
  const token = /^Bearer (afs_mock_([a-z0-9-]+))$/.exec(req.headers.authorization ?? '');
  const user = token ? world.users.get(token[2]) : undefined;
  if (!user && required) throw new Problem(401, 'unauthorized', 'Sign in required');
  if (user?.banned) throw new Problem(403, 'banned', 'This account is banned');
  if (user && role && user.role !== role) throw new Problem(403, 'forbidden', `Requires the ${role} role`);
  return user;
}

function ensureUser(world, handle) {
  if (!world.users.has(handle)) {
    world.users.set(handle, {
      handle,
      role: world.users.size === 0 || handle === 'ada' ? 'admin' : 'donor',
      github_login: null,
      email: null,
      banned: false,
      created_at: iso(Date.now()),
    });
  }
  return world.users.get(handle);
}

function findProject(world, slug, user) {
  const project = world.projects.find((p) => p.slug === slug);
  const visible =
    project && (['active', 'paused'].includes(project.status) || user?.role === 'admin' || user?.handle === project.maintainer);
  if (!visible) throw new Problem(404, 'not-found', 'No such project', `There is no project "${slug}" on this instance.`);
  return project;
}

function manageProject(world, slug, req) {
  const user = sessionUser(world, req);
  const project = findProject(world, slug, user);
  if (user.role !== 'admin' && user.handle !== project.maintainer) {
    throw new Problem(403, 'forbidden', 'Only the maintainer can change this project');
  }
  return { user, project };
}

function previewOf(repoUrl, rnd) {
  if (repoUrl.endsWith('/missing')) return { ok: false, errors: ['repository not found or not public'] };
  if (!/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repoUrl)) {
    throw new Problem(422, 'validation', 'Invalid repository URL', undefined, [
      { path: 'repo_url', message: 'Expected an https URL like https://github.com/owner/repo' },
    ]);
  }
  const name = repoUrl.split('/').at(-1).toLowerCase();
  const broken = name.includes('unsigned');
  const manifests = TASK_TITLES.slice(0, 4).map((title, i) => {
    const manifest = manifestFor(i, title, rnd, []);
    return {
      id: manifest.id,
      title: manifest.title,
      path: `tasks/${manifest.id}.yaml`,
      max_tokens: manifest.max_tokens,
      content_hash: hex(rnd, 64),
      depends_on: [],
    };
  });
  return {
    ok: !broken,
    errors: broken
      ? ['tasks/MANIFEST.lock.minisig: signature does not verify against the pubkey in agentfund.yaml', 'tasks/0003-cell-references.yaml is not listed in MANIFEST.lock']
      : [],
    commit: hex(rnd, 40),
    base_branch: 'main',
    agentfund: {
      spec_version: 1,
      name,
      description: 'A small project that carries signed task manifests.',
      repo_url: repoUrl,
      ci_provider: 'github',
      pubkey: 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
      language: 'rust',
      tags: ['example'],
      token_goal: 12_000_000,
    },
    suggested_slug: name,
    pubkey_fingerprint: `SHA256:${hex(rnd, 64)}`,
    signature_valid: !broken,
    lock_sha256: hex(rnd, 64),
    token_total: sum(manifests, (m) => m.max_tokens),
    manifests,
  };
}

// ───────────────────────────── routes ─────────────────────────────

const routes = [];
const route = (method, pattern, handler) => {
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, regex, handler });
};

route('GET', '/v1/meta', ({ world }) => ({
  app: 'AgentFund',
  name: world.config.name,
  description: world.config.description,
  version: '0.1.0-mock',
  base_url: BASE_URL,
  protocol_versions: ['v1'],
  spec_versions: [1],
  instance_pubkey: 'RWTmock0000000000000000000000000000000000000000000000000',
  capabilities: { github_oauth: true, dev_login: true, sse: true, ci_providers: ['github', 'generic'], ci_poll: true, federation: false },
  links: {
    source_url: 'https://github.com/agentfund/agentfund',
    install_command: 'git clone https://github.com/agentfund/agentfund && make -C agentfund/worker build images',
    docs_url: 'https://github.com/agentfund/agentfund/tree/main/docs',
  },
  defaults: { lease_seconds: world.config.lease_seconds, heartbeat_interval_seconds: 60 },
}));

route('GET', '/v1/stats', ({ world }) => ({
  totals: totalsFor(world, () => true),
  projects: world.projects.filter((p) => p.status === 'active').length,
  donors: standings(world, () => true).length,
  tasks_merged: world.tasks.filter((t) => t.state === 'merged').length,
  tasks_delivered: world.tasks.filter((t) => t.state === 'delivered' || t.state === 'merged').length,
}));

route('GET', '/v1/projects', ({ world, query, req }) => {
  const user = sessionUser(world, req, { required: false });
  const maintainer = query.get('maintainer');
  const own = maintainer && user?.handle === maintainer;
  const status = query.get('status') ?? 'active';
  const q = (query.get('q') ?? '').toLowerCase();
  let items = world.projects
    .filter((p) => (own ? p.status !== 'removed' : p.status === status))
    .filter((p) => !maintainer || p.maintainer === maintainer)
    .filter((p) => !q || `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(q))
    .filter((p) => !query.get('language') || p.language === query.get('language'))
    .filter((p) => !query.get('tag') || p.tags.includes(query.get('tag')))
    .map((p) => projectView(world, p));
  if (query.get('needs_donors') === 'true') items = items.filter((p) => p.tasks.claimable > 0);
  const sorters = {
    trending: (a, b) => b.velocity_7d - a.velocity_7d || b.totals.delivered - a.totals.delivered,
    recent: (a, b) => b.created_at.localeCompare(a.created_at),
    active: (a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''),
    delivered: (a, b) => b.totals.delivered - a.totals.delivered,
  };
  items.sort(sorters[query.get('sort') ?? 'trending'] ?? sorters.trending);
  return paginate(items, query);
});

route('POST', '/v1/projects/preview', ({ world, req, body }) => {
  sessionUser(world, req);
  return previewOf(String(body.repo_url ?? ''), world.rnd);
});

route('POST', '/v1/projects', ({ world, req, body }) => {
  const user = sessionUser(world, req);
  const preview = previewOf(String(body.repo_url ?? ''), world.rnd);
  if (!preview.ok) throw new Problem(422, 'repo-unverifiable', 'The repository does not verify', preview.errors.join('; '));
  const slug = body.slug ?? preview.suggested_slug;
  if (world.projects.some((p) => p.slug === slug)) {
    throw new Problem(409, 'slug-taken', 'That slug is taken', `A project called "${slug}" already exists.`);
  }
  const now = Date.now();
  const project = {
    slug,
    name: preview.agentfund.name,
    description: preview.agentfund.description,
    repo_url: body.repo_url,
    homepage: null,
    language: preview.agentfund.language,
    tags: preview.agentfund.tags,
    status: world.config.project_creation === 'approval' ? 'pending' : 'active',
    ci_provider: 'github',
    base_branch: preview.base_branch,
    follow_branch: true,
    maintainer: user.handle,
    pubkey: preview.agentfund.pubkey,
    pubkey_fingerprint: preview.pubkey_fingerprint,
    pinned_commit: preview.commit,
    lock_sha256: preview.lock_sha256,
    webhook_secret: `whsec_${hex(world.rnd, 40)}`,
    token_goal: body.token_goal ?? preview.agentfund.token_goal,
    created_at: iso(now),
    last_indexed_at: iso(now),
    index_error: null,
  };
  world.projects.unshift(project);
  if (user.role === 'donor') user.role = 'maintainer';
  preview.manifests.forEach((entry, i) => {
    world.tasks.push({
      project: slug,
      task_id: entry.id,
      title: entry.title,
      state: 'open',
      content_hash: entry.content_hash,
      manifest_path: entry.path,
      manifest: manifestFor(i, TASK_TITLES[i], world.rnd, []),
      updated_at: iso(now),
    });
  });
  broadcast(world, slug, event(world, now, user.handle, 'project.created', slug, null, { repo_url: project.repo_url }));
  return [201, projectView(world, project)];
});

route('GET', '/v1/projects/:slug', ({ world, params, req }) =>
  projectView(world, findProject(world, params.slug, sessionUser(world, req, { required: false }))),
);

route('PATCH', '/v1/projects/:slug', ({ world, params, req, body }) => {
  const { user, project } = manageProject(world, params.slug, req);
  if (body.status && body.status !== project.status) {
    project.status = body.status;
    event(world, Date.now(), user.handle, body.status === 'paused' ? 'project.paused' : 'project.resumed', project.slug, null, {});
  }
  if (body.token_goal) project.token_goal = body.token_goal;
  if (typeof body.follow_branch === 'boolean') project.follow_branch = body.follow_branch;
  broadcast(world, project.slug, null);
  return projectView(world, project);
});

route('POST', '/v1/projects/:slug/repin', ({ world, params, req, body }) => {
  const { user, project } = manageProject(world, params.slug, req);
  const previous = project.pinned_commit;
  project.pinned_commit = body.commit ?? hex(world.rnd, 40);
  project.lock_sha256 = hex(world.rnd, 64);
  project.last_indexed_at = iso(Date.now());
  project.index_error = null;
  const record = event(world, Date.now(), user.handle, 'project.repinned', project.slug, null, {
    from: previous,
    to: project.pinned_commit,
  });
  broadcast(world, project.slug, record);
  return projectView(world, project);
});

const webhookView = (project) => ({
  url: `${BASE_URL}/v1/webhooks/ci`,
  secret: project.webhook_secret,
  provider: project.ci_provider,
  content_type: 'application/json',
  events: project.ci_provider === 'github' ? ['workflow_run', 'check_suite', 'pull_request', 'push'] : [],
  ci_poll: true,
});

route('GET', '/v1/projects/:slug/webhook', ({ world, params, req }) => webhookView(manageProject(world, params.slug, req).project));

route('POST', '/v1/projects/:slug/webhook/rotate', ({ world, params, req }) => {
  const { project } = manageProject(world, params.slug, req);
  project.webhook_secret = `whsec_${hex(world.rnd, 40)}`;
  return webhookView(project);
});

route('GET', '/v1/projects/:slug/tasks', ({ world, params, query, req }) => {
  const project = findProject(world, params.slug, sessionUser(world, req, { required: false }));
  const items = world.tasks
    .filter((t) => t.project === project.slug)
    .filter((t) => !query.get('state') || t.state === query.get('state'))
    .map((t) => taskView(world, t))
    .filter((t) => query.get('claimable') !== 'true' || t.claimable);
  return paginate(items, query);
});

route('POST', '/v1/projects/:slug/pledges', ({ world, params, req, body }) => {
  const user = sessionUser(world, req);
  const project = findProject(world, params.slug, user);
  if (project.status !== 'active') throw new Problem(409, 'project-not-active', 'This project is not accepting pledges');
  if (!Number.isInteger(body.token_amount) || body.token_amount < 1) {
    throw new Problem(422, 'validation', 'Invalid amount', undefined, [{ path: 'token_amount', message: 'Must be a positive integer' }]);
  }
  const pledge = {
    id: `plg_${b36(world.rnd, 16)}`,
    project: project.slug,
    donor: user.handle,
    token_amount: body.token_amount,
    created_at: iso(Date.now()),
  };
  world.pledges.push(pledge);
  broadcast(world, project.slug, event(world, Date.now(), user.handle, 'pledge.created', project.slug, null, { tokens: pledge.token_amount }));
  return [201, { ...pledge, donor: userRef(user.handle) }];
});

route('GET', '/v1/projects/:slug/ledger', ({ world, params, query, req }) => {
  const project = findProject(world, params.slug, sessionUser(world, req, { required: false }));
  const inProject = (record) => record.project === project.slug;
  const page = paginate(ledgerEntries(world, inProject), query);
  return {
    project: project.slug,
    token_goal: project.token_goal,
    totals: totalsFor(world, inProject),
    donors: standings(world, inProject),
    entries: page.items,
    next_cursor: page.next_cursor,
  };
});

route('GET', '/v1/projects/:slug/events', ({ world, params, query, req }) => {
  const project = findProject(world, params.slug, sessionUser(world, req, { required: false }));
  return paginate(world.events.filter((e) => e.project === project.slug), query);
});

route('GET', '/v1/events', ({ world, query }) => {
  const hidden = new Set(world.projects.filter((p) => !['active', 'paused'].includes(p.status)).map((p) => p.slug));
  return paginate(world.events.filter((e) => !hidden.has(e.project)), query);
});

route('GET', '/v1/tasks/:task_id', ({ world, params, req }) => {
  const [slug, manifestId] = params.task_id.split(':');
  const project = findProject(world, slug, sessionUser(world, req, { required: false }));
  const task = world.tasks.find((t) => t.project === project.slug && t.task_id === manifestId);
  if (!task) throw new Problem(404, 'not-found', 'No such task', `There is no task "${params.task_id}".`);
  return taskView(world, task);
});

route('GET', '/v1/donors', ({ world, query }) => paginate(standings(world, () => true), query));

route('GET', '/v1/donors/:handle', ({ world, params }) => {
  if (!world.users.has(params.handle)) {
    throw new Problem(404, 'not-found', 'No such donor', `Nobody called "${params.handle}" has donated here.`);
  }
  return donorView(world, params.handle);
});

route('GET', '/v1/auth/github/start', ({ query, res }) => {
  // Stands in for the GitHub round trip: straight back to the UI as `ada`.
  res.writeHead(302, { ...CORS, location: `${query.get('redirect') ?? '/'}#token=afs_mock_ada` });
  res.end();
  return null;
});

route('POST', '/v1/auth/dev', ({ world, body }) => {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(body.handle ?? '')) {
    throw new Problem(422, 'validation', 'Invalid handle', undefined, [
      { path: 'handle', message: 'Lowercase letters, digits and dashes; at most 39 characters' },
    ]);
  }
  return { token: `afs_mock_${body.handle}`, user: meView(ensureUser(world, body.handle)) };
});

route('POST', '/v1/auth/logout', () => [204, null]);
route('GET', '/v1/me', ({ world, req }) => meView(sessionUser(world, req)));

route('GET', '/v1/me/api-keys', ({ world, req }) => {
  const user = sessionUser(world, req);
  return { items: world.apiKeys.filter((k) => k.owner === user.handle).map(({ owner: _owner, ...key }) => key) };
});

route('POST', '/v1/me/api-keys', ({ world, req, body }) => {
  const user = sessionUser(world, req);
  if (!body.label) throw new Problem(422, 'validation', 'A label is required', undefined, [{ path: 'label', message: 'Required' }]);
  const secret = `af_${b36(world.rnd, 40)}`;
  const key = {
    id: `key_${b36(world.rnd, 12)}`,
    label: body.label,
    prefix: secret.slice(0, 10),
    created_at: iso(Date.now()),
    last_used_at: null,
    revoked_at: null,
    owner: user.handle,
  };
  world.apiKeys.push(key);
  const { owner: _owner, ...view } = key;
  return [201, { ...view, key: secret }];
});

route('DELETE', '/v1/me/api-keys/:key_id', ({ world, req, params }) => {
  const user = sessionUser(world, req);
  const key = world.apiKeys.find((k) => k.id === params.key_id && k.owner === user.handle);
  if (!key) throw new Problem(404, 'not-found', 'No such key');
  key.revoked_at = iso(Date.now());
  return [204, null];
});

route('GET', '/v1/me/claims', ({ world, req, query }) => {
  const user = sessionUser(world, req);
  const active = world.claims
    .filter((c) => c.donor === user.handle)
    .map((c) => ({
      claim_id: c.claim_id,
      task_id: c.task_id,
      project: c.project,
      status: 'active',
      claimed_at: c.claimed_at,
      lease_expires_at: iso(Date.now() + world.config.lease_seconds * 1000),
      report: null,
    }));
  const reported = world.reports
    .filter((r) => r.donor === user.handle)
    .map((r) => ({
      claim_id: r.claim_id,
      task_id: r.task_id,
      project: r.project,
      status: 'reported',
      claimed_at: iso(Date.parse(r.created_at) - (r.duration_seconds ?? 0) * 1000),
      lease_expires_at: iso(Date.parse(r.created_at) + world.config.lease_seconds * 1000),
      report: reportView(r),
    }))
    .sort((a, b) => b.claimed_at.localeCompare(a.claimed_at));
  const items = query.get('active') === 'true' ? active : [...active, ...reported];
  return { items: items.slice(0, Number(query.get('limit') ?? 50)) };
});

route('GET', '/v1/admin/users', ({ world, req, query }) => {
  sessionUser(world, req, { role: 'admin' });
  const q = (query.get('q') ?? '').toLowerCase();
  return paginate([...world.users.values()].filter((u) => u.handle.includes(q)).map(meView), query);
});

route('PATCH', '/v1/admin/users/:handle', ({ world, req, params, body }) => {
  sessionUser(world, req, { role: 'admin' });
  const user = world.users.get(params.handle);
  if (!user) throw new Problem(404, 'not-found', 'No such user');
  if (body.role) user.role = body.role;
  if (typeof body.banned === 'boolean') user.banned = body.banned;
  return meView(user);
});

route('GET', '/v1/admin/projects', ({ world, req, query }) => {
  sessionUser(world, req, { role: 'admin' });
  return paginate(world.projects.map((p) => projectView(world, p)), query);
});

route('PATCH', '/v1/admin/projects/:slug', ({ world, req, params, body }) => {
  const admin = sessionUser(world, req, { role: 'admin' });
  const project = world.projects.find((p) => p.slug === params.slug);
  if (!project) throw new Problem(404, 'not-found', 'No such project');
  project.status = body.status;
  event(world, Date.now(), admin.handle, `project.${body.status}`, project.slug, null, {});
  return projectView(world, project);
});

route('GET', '/v1/admin/instance', ({ world, req }) => {
  sessionUser(world, req, { role: 'admin' });
  return world.config;
});

route('PATCH', '/v1/admin/instance', ({ world, req, body }) => {
  sessionUser(world, req, { role: 'admin' });
  Object.assign(world.config, body);
  return world.config;
});

// ───────────────────────────── server ─────────────────────────────

function openStream(world, query, req, res) {
  const project = query.get('project');
  if (project && !world.projects.some((p) => p.slug === project)) {
    return sendProblem(res, new Problem(404, 'not-found', 'No such project'), req.url);
  }
  res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const subscriber = { world, project, res };
  subscribers.add(subscriber);
  send(res, 'totals', streamFrame(world, project));
  const ping = setInterval(() => send(res, 'ping', {}), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    subscribers.delete(subscriber);
  });
}

async function handleApi(req, res, scenario, pathname, query) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const world = worldFor(scenario);
  try {
    if (scenario === 'loading' && pathname !== '/v1/meta') return; // never answers: skeletons stay up
    if (scenario === 'error' && pathname !== '/v1/meta') {
      throw new Problem(500, 'internal', 'Internal error', 'The mock is in the error scenario; every request fails.');
    }
    if (pathname === '/v1/stream') return openStream(world, query, req, res);
    for (const { method, regex, handler } of routes) {
      const match = method === req.method && regex.exec(pathname);
      if (!match) continue;
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await handler({ world, req, res, query, body, params: Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)])) });
      if (result === null) return;
      const [status, payload] = Array.isArray(result) ? result : [200, result];
      if (payload === null) {
        res.writeHead(status, CORS);
        return res.end();
      }
      return json(res, status, payload);
    }
    throw new Problem(404, 'not-found', 'Not found', `No route for ${req.method} ${pathname}`);
  } catch (error) {
    if (!(error instanceof Problem)) console.error(error);
    const problem = error instanceof Problem ? error : new Problem(500, 'internal', 'Internal error', String(error));
    sendProblem(res, problem, pathname);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png',
};

/** Serve the built SPA like the reference server: inject runtime config at the app-head marker. */
function serveDist(req, res, pathname) {
  const file = path.join(DIST, path.normalize(pathname));
  const isAsset = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile();
  const type = MIME[isAsset ? path.extname(file) : '.html'] ?? 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (isAsset && type === 'font/woff2') {
    res.writeHead(200, headers);
    return createReadStream(file).pipe(res);
  }
  let body = readFileSync(isAsset ? file : path.join(DIST, 'index.html'));
  if (!isAsset) {
    body = Buffer.from(
      body.toString().replace('<!--app-head-->', `<link rel="canonical" href="${BASE_URL}${pathname}"><script>window.__AGENTFUND__={apiBase:""}</script>`),
    );
  }
  if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
    headers['content-encoding'] = 'br';
    body = zlib.brotliCompressSync(body);
  }
  res.writeHead(200, headers);
  res.end(body);
}

export function startMockApi({ port = PORT, dist = false } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE_URL);
    const prefixed = /^\/s\/([a-z]+)(\/.*)$/.exec(url.pathname);
    const pathname = prefixed ? prefixed[2] : url.pathname;
    const requested = prefixed?.[1] ?? url.searchParams.get('scenario') ?? 'many';
    const scenario = SCENARIOS.includes(requested) ? requested : 'many';
    if (pathname.startsWith('/v1/')) return void handleApi(req, res, scenario, pathname, url.searchParams);
    if (pathname === '/healthz') return json(res, 200, { ok: true });
    if (pathname === '/feed.atom') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      return res.end(`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${worldFor(scenario).config.name}</title><id>${BASE_URL}/</id><updated>${iso(Date.now())}</updated></feed>`);
    }
    if (dist && existsSync(DIST)) return serveDist(req, res, pathname);
    sendProblem(res, new Problem(404, 'not-found', 'Not found'), pathname);
  });
  const timer = setInterval(() => worlds.forEach(tick), Number(process.env.MOCK_TICK_MS ?? 700));
  server.on('close', () => clearInterval(timer));
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv.includes('--dist');
  await startMockApi({ dist });
  console.log(`mock API on ${BASE_URL}${dist ? ' (serving dist/)' : ''} · scenarios: ${SCENARIOS.join(', ')}`);
}
