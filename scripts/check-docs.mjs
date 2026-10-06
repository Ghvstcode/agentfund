// Keep the docs honest. Run through scripts/check-docs.sh (which builds the CLI first).
//
// 1. Links: every relative link and image in every Markdown file points at a file that
//    exists, and every #anchor at a heading that exists (GitHub's slug rules).
// 2. CLI: every `agentfund <subcommand> --flag` written in code (fenced or inline) names a
//    subcommand and flags that the built binary's --help actually lists.
// 3. Make: every `make <target>` / `make -C <dir> <target>` written in code exists.
//
// It checks references, not prose: a sentence can still be wrong. No dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = join(ROOT, 'worker/bin/agentfund');
const SKIP_DIRS = new Set(['node_modules', '.git', '.demo', 'dist', 'build', 'target', '.raw', 'reports', '.build', 'coverage']);
const errors = [];
const fail = (file, line, message) => errors.push(`${relative(ROOT, file)}:${line}  ${message}`);

function markdownFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

// ── Markdown structure ──────────────────────────────────────────────────────────────────
/** Splits a file into lines tagged as inside or outside a fenced code block. */
function lines(text) {
  let fence = null;
  return text.split('\n').map((raw, index) => {
    const marker = raw.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker && !fence) { fence = marker[0]; return { n: index + 1, raw, code: true, fenceLine: true }; }
    if (marker && fence === marker[0]) { fence = null; return { n: index + 1, raw, code: true, fenceLine: true }; }
    return { n: index + 1, raw, code: fence !== null };
  });
}

/** GitHub's heading → anchor rule, including -1, -2 suffixes for duplicates. */
function anchors(file) {
  const seen = new Map();
  const out = new Set();
  for (const { raw, code } of lines(readFileSync(file, 'utf8'))) {
    if (code) continue;
    const heading = raw.match(/^#{1,6}\s+(.*?)\s*#*\s*$/)?.[1];
    if (heading === undefined) continue;
    const text = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[`*_]/g, (m) => (m === '_' ? '_' : ''));
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}
const anchorCache = new Map();
const anchorsOf = (file) => anchorCache.get(file) ?? anchorCache.set(file, anchors(file)).get(file);

// ── 1. Links ────────────────────────────────────────────────────────────────────────────
function checkLinks(file) {
  const referenceTargets = [];
  for (const { n, raw, code } of lines(readFileSync(file, 'utf8'))) {
    if (code) continue;
    const prose = raw.replace(/`[^`]*`/g, ''); // links inside inline code are examples, not links
    const targets = [
      ...[...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
      ...[...prose.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]),
      ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)].map((m) => m[1]),
    ];
    for (const target of targets) referenceTargets.push([n, target]);
  }
  for (const [n, target] of referenceTargets) {
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    const [path, hash] = target.split('#');
    const resolved = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(resolved)) { fail(file, n, `broken link: ${target}`); continue; }
    if (hash && resolved.endsWith('.md') && !anchorsOf(resolved).has(hash.toLowerCase())) {
      fail(file, n, `no heading for anchor #${hash} in ${relative(ROOT, resolved)}`);
    }
  }
}

// ── 2. CLI references ───────────────────────────────────────────────────────────────────
const help = (...args) => execFileSync(BIN, [...args, '--help'], { encoding: 'utf8' });
const flagsIn = (text) => new Set([...text.matchAll(/(?:^|[\s,])(--[a-z][a-z-]*)/g)].map((m) => m[1]));
const commandsIn = (text) => {
  const block = text.split(/Available Commands:\n/)[1]?.split(/\n\n/)[0] ?? '';
  return [...block.matchAll(/^\s+([a-z][a-z-]*)\s/gm)].map((m) => m[1]);
};
const cli = new Map(); // "work" | "daemon install" → Set of flags
for (const command of commandsIn(help())) {
  const text = help(command);
  cli.set(command, flagsIn(text));
  for (const sub of commandsIn(text)) cli.set(`${command} ${sub}`, flagsIn(help(command, sub)));
}
const GLOBAL_FLAGS = flagsIn(help());

function checkCli(file) {
  for (const { n, raw, code, fenceLine } of lines(readFileSync(file, 'utf8'))) {
    if (fenceLine) continue;
    const snippets = code ? [raw] : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const snippet of snippets) {
      // One command per shell segment: stop at pipes, &&, ;, comments, and "then"-style prose.
      for (const segment of snippet.split(/\s[|;#]|&&|\s{3,}|→/)) {
        const match = segment.match(/(?:^|[\s$("'])agentfund\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?(.*)$/);
        if (!match) continue;
        const [, first, second, rest] = match;
        if (first === 'help' || first === 'completion') continue;
        if (/agentfund lock v\d/.test(segment)) continue; // the signature's trusted comment, not a command
        if (!cli.has(first)) {
          // Only complain when it is clearly meant as an invocation, not "agentfund lock v1" in output.
          if (code ? /^\s*\$?\s*agentfund\s/.test(segment) : /^agentfund\s/.test(snippet.trim())) fail(file, n, `unknown subcommand: agentfund ${first}`);
          continue;
        }
        const command = second && cli.has(`${first} ${second}`) ? `${first} ${second}` : first;
        const known = cli.get(command);
        for (const flag of flagsIn(` ${second ?? ''} ${rest}`)) {
          if (!known.has(flag) && !GLOBAL_FLAGS.has(flag)) fail(file, n, `agentfund ${command} has no flag ${flag}`);
        }
      }
    }
  }
}

// ── 3. Make targets ─────────────────────────────────────────────────────────────────────
const makeTargets = new Map();
function targetsOf(dir) {
  if (!makeTargets.has(dir)) {
    const file = join(ROOT, dir, 'Makefile');
    makeTargets.set(dir, existsSync(file) ? new Set([...readFileSync(file, 'utf8').matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1])) : null);
  }
  return makeTargets.get(dir);
}
function checkMake(file) {
  for (const { n, raw, code, fenceLine } of lines(readFileSync(file, 'utf8'))) {
    if (fenceLine) continue;
    const snippets = code ? [raw] : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const snippet of snippets) {
      for (const segment of snippet.split(/\s[|;#]|&&/)) {
        const match = segment.match(/(?:^|[\s$(])make(?:\s+-C\s+(\S+))?((?:\s+[a-z][a-z0-9-]*)*)\s*$/);
        if (!match) continue;
        const dir = match[1] ?? '.';
        // `make -C worker …` is written relative to the repo root everywhere in the docs.
        const targets = targetsOf(dir);
        if (!targets) { if (match[1]) fail(file, n, `make -C ${dir}: no Makefile there`); continue; }
        for (const target of match[2].trim().split(/\s+/).filter(Boolean)) {
          if (!targets.has(target)) fail(file, n, `make${match[1] ? ` -C ${dir}` : ''}: no target "${target}"`);
        }
      }
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────
const files = markdownFiles(ROOT);
for (const file of files) {
  checkLinks(file);
  checkCli(file);
  checkMake(file);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\ncheck-docs: ${errors.length} problem(s) in ${files.length} Markdown files`);
  process.exit(1);
}
console.log(`check-docs: ${files.length} Markdown files, ${cli.size} CLI commands — links, anchors, subcommands, flags and make targets all resolve`);
