/** Indexing (protocol.md §9): clone, verify against the registered key, upsert manifests, emit events. */
import { and, eq, sql } from "drizzle-orm";
import { RESERVED_SLUGS } from "../constants.js";
import type { AppContext } from "../context.js";
import { one, rows, type Tx } from "../db/client.js";
import { manifests, projects, users } from "../db/schema.js";
import { parseRepoUrl, RepoUrlError, type RepoRef } from "../lib/git.js";
import { newSecret, slugify } from "../lib/ids.js";
import { fingerprint } from "../lib/minisign.js";
import type { BodyOf, Schemas } from "../lib/openapi.js";
import { Problem, validation } from "../lib/problem.js";
import type { Principal } from "./auth.js";
import { appendEvent } from "./events.js";
import { getInstance } from "./instance.js";
import { membersOnly } from "./members.js";
import { projectById, type ProjectRow } from "./projects.js";
import { inspectRepo, readDescriptor, verifyCommit, type Inspection, type VerifiedLock } from "./repo.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function repoRef(ctx: AppContext, url: string): RepoRef {
  try {
    return parseRepoUrl(url, { allowFile: ctx.config.allowFileRepos });
  } catch (err) {
    if (err instanceof RepoUrlError) throw validation("/repo_url", err.message);
    throw err;
  }
}

const NO_ACCESS = "repository not found or you have no write access to it";

/**
 * Members-only instances can read private repositories, so preview and create must not become
 * a way to read one: the caller needs write on the repo (checked through the GitHub App) before
 * anything about it is fetched or said. Every failure reads the same, so nothing leaks.
 */
async function canRegister(ctx: AppContext, who: Principal, repo: RepoRef): Promise<boolean> {
  if (!membersOnly(ctx) || repo.scheme === "file") return true;
  if (!ctx.githubApp || !repo.github || !who.user.githubLogin) return false;
  try {
    const permission = await ctx.githubApp.permissionOf(repo.github, who.user.githubLogin);
    return permission === "admin" || permission === "write";
  } catch (err) {
    ctx.log.warn("repository permission check failed", { repo: repo.url, err });
    return false;
  }
}

/**
 * On a public instance anyone may sign in, so registering must not let someone claim another
 * person's AgentFund-ready repository: the caller needs push access to it on GitHub, asked with
 * the caller's own sign-in token (`GET /repos/{owner}/{repo}` → `permissions.push`). Admins may
 * register for anyone. Dev-login users and file:// repositories have no GitHub to ask; both exist
 * only on instances where dev login (anyone may be admin) or ALLOW_FILE_REPOS is on.
 * Members-only instances check write through the GitHub App in `canRegister` instead.
 */
export async function requirePushAccess(ctx: AppContext, who: Principal, repo: RepoRef): Promise<void> {
  if (membersOnly(ctx) || who.user.role === "admin" || repo.scheme === "file") return;
  if (ctx.config.authDevLogin && !who.user.githubLogin) return;
  const refuse = (detail: string): never => {
    throw new Problem("forbidden", detail, { errors: [{ path: "/repo_url", message: detail }] });
  };
  if (!repo.github) refuse("Only github.com repositories can be checked for push access on this instance; ask an admin to register this one for you.");
  const token = who.githubToken?.() ?? null;
  if (!token) refuse("Sign out and sign in with GitHub again, so the instance can check that you can push to this repository.");
  let res: Response;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${repo.github}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2026-03-10", "user-agent": "agentfund-server" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    ctx.log.warn("push access check failed", { repo: repo.url, err });
    return refuse("GitHub could not be reached to check your push access; try again.");
  }
  if (res.status === 401) refuse("GitHub no longer accepts your sign-in; sign out and sign in with GitHub again.");
  if (res.status === 301) refuse("This repository has moved on GitHub; register it under its current URL.");
  if (res.status === 404) refuse("GitHub does not show you this repository; check the URL.");
  if (!res.ok) {
    ctx.log.warn("push access check failed", { repo: repo.url, status: res.status });
    refuse("GitHub could not be reached to check your push access; try again.");
  }
  const { permissions } = (await res.json().catch(() => ({}))) as { permissions?: { push?: unknown } };
  if (permissions?.push !== true) {
    refuse(
      `You need push access to ${repo.github} on GitHub to register it. If it belongs to an organization that restricts OAuth apps, an owner can approve this instance's app, or an instance admin can register it for you.`,
    );
  }
}

async function registered(ctx: AppContext, repo: RepoRef): Promise<boolean> {
  return Boolean(await one<{ id: string }>(ctx.db, sql`SELECT id FROM projects WHERE repo_key = ${repo.key} AND status <> 'removed'`));
}

async function suggestSlug(ctx: AppContext, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 60)}-${i + 1}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
    if (!(await one<{ id: string }>(ctx.db, sql`SELECT id FROM projects WHERE slug = ${candidate}`))) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

export async function previewProject(ctx: AppContext, who: Principal, repoUrl: string): Promise<Schemas["ProjectPreview"]> {
  const repo = repoRef(ctx, repoUrl);
  if (!(await canRegister(ctx, who, repo))) return { ok: false, errors: [NO_ACCESS] };
  await requirePushAccess(ctx, who, repo);
  const ins = await inspectRepo(ctx.git, repo);
  const errors = [...ins.errors];
  if (await registered(ctx, repo)) errors.push("this repository is already registered on this instance");
  const v = ins.verified;
  return {
    ok: errors.length === 0,
    errors,
    ...(ins.commit ? { commit: ins.commit } : {}),
    ...(ins.baseBranch ? { base_branch: ins.baseBranch } : {}),
    ...(ins.descriptor ? { agentfund: ins.descriptor as unknown as Record<string, never>, suggested_slug: await suggestSlug(ctx, ins.descriptor.name) } : {}),
    ...(ins.pubkeyFingerprint ? { pubkey_fingerprint: ins.pubkeyFingerprint } : {}),
    ...(ins.signatureValid !== undefined ? { signature_valid: ins.signatureValid } : {}),
    ...(v
      ? {
          lock_sha256: v.lockSha256,
          token_total: v.tokenTotal,
          manifests: v.manifests.map((m) => ({ id: m.id, title: m.doc.title, path: m.path, max_tokens: m.doc.max_tokens, content_hash: m.contentHash, depends_on: m.doc.depends_on ?? [] })),
        }
      : {}),
  };
}

interface ManifestChange {
  action: "manifest.added" | "manifest.changed" | "manifest.removed";
  id: string;
  payload: Record<string, unknown>;
}

/** Brings manifest rows in line with a verified lock. Caller holds the project row lock. */
async function applyManifests(ctx: AppContext, tx: Tx, projectId: number, v: VerifiedLock): Promise<ManifestChange[]> {
  const now = ctx.clock.now();
  const existing = await tx.select().from(manifests).where(eq(manifests.projectId, projectId));
  const byId = new Map(existing.map((m) => [m.manifestId, m]));
  const changes: ManifestChange[] = [];
  for (const m of v.manifests) {
    const doc = m.doc as unknown as Record<string, unknown>;
    const fields = { path: m.path, title: m.doc.title, contentHash: m.contentHash, commit: v.commit, manifest: doc, maxTokens: m.doc.max_tokens, dependsOn: m.doc.depends_on ?? [] };
    const prev = byId.get(m.id);
    if (!prev) {
      await tx.insert(manifests).values({ projectId, manifestId: m.id, ...fields, state: "open", createdAt: now, updatedAt: now });
      changes.push({ action: "manifest.added", id: m.id, payload: { content_hash: m.contentHash, title: m.doc.title, max_tokens: m.doc.max_tokens } });
      continue;
    }
    // Merged work is history: its row is frozen. Everything else follows the lock in place;
    // an active claim keeps the commit and hash it was granted (snapshotted on the claim).
    if (prev.state === "merged") continue;
    const revived = prev.state === "failed";
    const changed = prev.contentHash !== m.contentHash;
    if (changed || revived || prev.commit !== v.commit) {
      await tx.update(manifests).set({ ...fields, ...(revived ? { state: "open" } : {}), updatedAt: changed || revived ? now : prev.updatedAt }).where(eq(manifests.id, prev.id));
    }
    if (revived) changes.push({ action: "manifest.added", id: m.id, payload: { content_hash: m.contentHash, title: m.doc.title, max_tokens: m.doc.max_tokens, restored: true } });
    else if (changed) changes.push({ action: "manifest.changed", id: m.id, payload: { from: prev.contentHash, to: m.contentHash, state: prev.state } });
  }
  const listed = new Set(v.manifests.map((m) => m.id));
  for (const prev of existing) {
    if (listed.has(prev.manifestId) || prev.state === "failed") continue;
    // Delivered and merged tasks stay as they are; open and claimed ones can no longer be worked on.
    if (prev.state === "open" || prev.state === "claimed") {
      await tx.update(manifests).set({ state: "failed", updatedAt: now }).where(eq(manifests.id, prev.id));
    }
    changes.push({ action: "manifest.removed", id: prev.manifestId, payload: { content_hash: prev.contentHash, state: prev.state } });
  }
  return changes;
}

export async function createProject(ctx: AppContext, who: Principal, body: BodyOf<"createProject">): Promise<Schemas["Project"]> {
  const repo = repoRef(ctx, body.repo_url);
  if (!(await canRegister(ctx, who, repo))) throw new Problem("repo-unverifiable", NO_ACCESS, { errors: [{ path: "/repo_url", message: NO_ACCESS }] });
  await requirePushAccess(ctx, who, repo);
  if (await registered(ctx, repo)) throw new Problem("repo-already-registered", "This repository is already registered on this instance.");
  const ins: Inspection = await inspectRepo(ctx.git, repo);
  const d = ins.descriptor;
  const v = ins.verified;
  if (ins.errors.length || !d || !v || !ins.commit || !ins.baseBranch) {
    throw new Problem("repo-unverifiable", ins.errors[0] ?? "The repository could not be verified.", { errors: ins.errors.map((message) => ({ path: "/repo_url", message })) });
  }
  const slug = body.slug ?? slugify(d.name);
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw validation("/slug", `"${slug}" is reserved or not a valid slug; choose another`);
  const instance = await getInstance(ctx.db);
  const now = ctx.clock.now();
  try {
    const id = await ctx.db.transaction(async (tx) => {
      if (await one<{ id: string }>(tx, sql`SELECT id FROM projects WHERE slug = ${slug}`)) throw new Problem("slug-taken", `The slug "${slug}" is taken.`);
      const [row] = await tx
        .insert(projects)
        .values({
          slug,
          name: d.name,
          description: d.description,
          repoUrl: repo.url,
          repoKey: repo.key,
          homepage: d.homepage ?? null,
          language: d.language ? d.language.toLowerCase() : null,
          tags: d.tags ?? [],
          status: instance.projectCreation === "approval" && who.user.role !== "admin" ? "pending" : "active",
          ciProvider: d.ci_provider,
          baseBranch: ins.baseBranch!,
          followBranch: true,
          maintainerId: who.user.id,
          pubkey: d.pubkey,
          pinnedCommit: v.commit,
          lockSha256: v.lockSha256,
          tokenGoal: body.token_goal ?? d.token_goal ?? v.tokenTotal,
          createdAt: now,
          lastIndexedAt: now,
          branchReadAt: now,
          webhookSecret: newSecret(),
        })
        .returning();
      if (!row) throw new Problem("internal", "project insert failed");
      if (who.user.role === "donor") await tx.update(users).set({ role: "maintainer" }).where(and(eq(users.id, who.user.id), eq(users.role, "donor")));
      await appendEvent(ctx, tx, {
        actor: who.user.handle,
        action: "project.created",
        projectId: row.id,
        project: slug,
        payload: { name: d.name, repo_url: repo.url, pinned_commit: v.commit, lock_sha256: v.lockSha256, pubkey_fingerprint: fingerprint(d.pubkey), status: row.status, manifests: v.manifests.length },
      });
      for (const c of await applyManifests(ctx, tx, row.id, v)) {
        await appendEvent(ctx, tx, { actor: "indexer", action: c.action, projectId: row.id, project: slug, taskId: `${slug}:${c.id}`, payload: c.payload });
      }
      return row.id;
    });
    return await projectById(ctx, id);
  } catch (err) {
    const constraint = (err as { constraint_name?: string; cause?: { constraint_name?: string } }).constraint_name ?? (err as { cause?: { constraint_name?: string } }).cause?.constraint_name;
    if (constraint === "projects_slug_key") throw new Problem("slug-taken", `The slug "${slug}" is taken.`);
    if (constraint === "projects_repo_key_live") throw new Problem("repo-already-registered", "This repository is already registered on this instance.");
    throw err;
  }
}

export interface IndexOutcome {
  ok: boolean;
  changed: boolean;
  commit?: string;
  error?: string;
}

/**
 * Indexes one project. `commit` pins an explicit commit; `head` follows the base branch even
 * when `follow_branch` is off (that is what `repin` without a commit means); otherwise the
 * target is the base-branch head only for `follow_branch` projects.
 * On failure the pin is untouched and `index_error` says why.
 */
export async function indexProject(ctx: AppContext, projectId: number, opts: { commit?: string; head?: boolean; actor?: string } = {}): Promise<IndexOutcome> {
  const actor = opts.actor ?? "indexer";
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.status === "removed") return { ok: false, changed: false, error: "project is removed" };
  const repo = parseRepoUrl(project.repoUrl, { allowFile: true });
  const wantHead = Boolean(opts.head) || (project.followBranch && !opts.commit);
  if (!opts.commit && !wantHead) return { ok: true, changed: false, commit: project.pinnedCommit };

  let target: string | undefined = opts.commit;
  let verified: VerifiedLock;
  // Taken before the fetch, so branchReadAt never claims a read later than the one that happened:
  // the dependency gate (ledger DEP_LANDED) compares merges against it.
  const checkedAt = ctx.clock.now();
  try {
    await ctx.git.fetch(repo);
    if (target) {
      if (!(await ctx.git.hasCommit(repo, target))) throw new Error(`commit ${target} not found in the repository`);
    } else {
      const head = await ctx.git.resolveBranch(repo, project.baseBranch);
      if (!head) throw new Error(`branch "${project.baseBranch}" not found`);
      target = head;
    }
    if (target === project.pinnedCommit && !project.indexError) {
      await ctx.db.update(projects).set({ lastIndexedAt: checkedAt, branchReadAt: checkedAt }).where(eq(projects.id, project.id));
      return { ok: true, changed: false, commit: target };
    }
    verified = await verifyCommit(ctx.git, repo, target, project.pubkey);
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    await recordFailure(ctx, project, target, message, actor);
    return { ok: false, changed: false, commit: target, error: message };
  }

  const commit = target;
  // Display metadata follows agentfund.yaml when it is valid; the key, repo and CI provider never do.
  const descriptor = await readDescriptor(ctx.git, repo, commit).catch(() => null);
  const changed = await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(projects).where(eq(projects.id, project.id)).for("no key update");
    if (!locked || locked.status === "removed") return false;
    const moved = locked.pinnedCommit !== commit;
    const rotated = verified.signingKey !== locked.pubkey;
    await tx
      .update(projects)
      .set({
        pinnedCommit: commit,
        lockSha256: verified.lockSha256,
        pubkey: verified.signingKey,
        lastIndexedAt: checkedAt,
        branchReadAt: checkedAt,
        indexError: null,
        indexErrorKey: null,
        ...(descriptor ? { description: descriptor.description, homepage: descriptor.homepage ?? null, language: descriptor.language ? descriptor.language.toLowerCase() : null, tags: descriptor.tags ?? [] } : {}),
      })
      .where(eq(projects.id, locked.id));
    const changes = await applyManifests(ctx, tx, locked.id, verified);
    for (const c of changes) {
      await appendEvent(ctx, tx, { actor: "indexer", action: c.action, projectId: locked.id, project: locked.slug, taskId: `${locked.slug}:${c.id}`, payload: { ...c.payload, commit } });
    }
    if (rotated) {
      await appendEvent(ctx, tx, { actor: "indexer", action: "project.key_rotated", projectId: locked.id, project: locked.slug, payload: { from: fingerprint(locked.pubkey), to: fingerprint(verified.signingKey), hops: verified.rotationHops, commit } });
    }
    if (moved) {
      await appendEvent(ctx, tx, { actor, action: "project.repinned", projectId: locked.id, project: locked.slug, payload: { from: locked.pinnedCommit, to: commit, lock_sha256: verified.lockSha256, lock_changed: locked.lockSha256 !== verified.lockSha256 } });
    }
    return moved || changes.length > 0 || rotated;
  });
  return { ok: true, changed, commit };
}

async function recordFailure(ctx: AppContext, project: ProjectRow, target: string | undefined, message: string, actor: string): Promise<void> {
  const key = `${target ?? "?"}:${message}`.slice(0, 500);
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(projects).where(eq(projects.id, project.id)).for("no key update");
    if (!locked) return;
    await tx.update(projects).set({ indexError: message, indexErrorKey: key, lastIndexedAt: ctx.clock.now() }).where(eq(projects.id, locked.id));
    // One event per distinct failure, not one per timer tick.
    if (locked.indexErrorKey !== key) {
      await appendEvent(ctx, tx, { actor, action: "project.index_failed", projectId: locked.id, project: locked.slug, payload: { commit: target ?? null, pinned_commit: locked.pinnedCommit, error: message } });
    }
  });
}

/** Timer body: every non-removed project that follows its branch, one after another. */
export async function indexAll(ctx: AppContext): Promise<void> {
  const list = await rows<{ id: string; slug: string }>(ctx.db, sql`SELECT id, slug FROM projects WHERE status <> 'removed' AND follow_branch ORDER BY last_indexed_at ASC NULLS FIRST LIMIT 200`);
  for (const p of list) {
    try {
      const out = await indexProject(ctx, Number(p.id));
      if (!out.ok) ctx.log.warn("index failed", { project: p.slug, error: out.error });
      else if (out.changed) ctx.log.info("indexed", { project: p.slug, commit: out.commit });
    } catch (err) {
      ctx.log.error("indexer crashed on project", { project: p.slug, err });
    }
  }
}

export async function repinProject(ctx: AppContext, who: Principal, project: ProjectRow, commit: string | undefined): Promise<Schemas["Project"]> {
  const out = await indexProject(ctx, project.id, commit ? { commit, actor: who.user.handle } : { head: true, actor: who.user.handle });
  if (!out.ok) throw new Problem("repo-unverifiable", out.error ?? "The repository could not be verified.", { errors: [{ path: commit ? "/commit" : "/", message: out.error ?? "verification failed" }] });
  return projectById(ctx, project.id);
}
