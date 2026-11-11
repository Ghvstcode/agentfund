import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../src/lib/minisign.js";
import type { Schemas } from "../src/lib/openapi.js";
import { indexAll, indexProject } from "../src/services/indexer.js";
import { sql } from "drizzle-orm";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { generateKeyPair, signRotation } from "./helpers/minisign.js";
import { manifestYaml, TestRepo } from "./helpers/repo.js";
import { claim, getProject, getTask, setupProject } from "./helpers/scenario.js";

type Project = Schemas["Project"];
type Preview = Schemas["ProjectPreview"];

let t: TestApp;
let session: string;
beforeAll(async () => {
  t = await createTestApp();
  session = await t.login("maint");
});
afterAll(async () => {
  await t.close();
});

const preview = async (repo: TestRepo) => (await t.call<Preview>("previewProject", { token: session, body: { repo_url: repo.url } })).body;
const create = (repo: TestRepo, slug: string) => t.call<Project>("createProject", { token: session, body: { repo_url: repo.url, slug } });
const events = async (slug: string) => (await t.call<Schemas["EventPage"]>("listProjectEvents", { path: { slug }, query: { limit: 100 } })).body.items;
const pid = async (slug: string) => Number(((await t.ctx.db.execute(sql`SELECT id FROM projects WHERE slug = ${slug}`)) as unknown as { id: string }[])[0]!.id);

describe("indexer: a good repo", () => {
  it("previews without persisting, then creates with manifests, hashes and the registered key", async () => {
    const repo = TestRepo.create([{ id: "0001-a", max_tokens: 2_000_000 }, { id: "0002-b", depends_on: ["0001-a"] }], { name: "Good Repo" });
    const pv = await preview(repo);
    expect(pv).toMatchObject({ ok: true, errors: [], commit: repo.head(), base_branch: "main", signature_valid: true, suggested_slug: "good-repo", token_total: 3_000_000, pubkey_fingerprint: fingerprint(repo.key.publicKey) });
    expect(pv.manifests?.map((m) => [m.id, m.path, m.depends_on])).toEqual([["0001-a", "tasks/0001-a.yaml", []], ["0002-b", "tasks/0002-b.yaml", ["0001-a"]]]);
    expect((await t.call<{ items: Project[] }>("listProjects")).body.items.find((p) => p.name === "Good Repo")).toBeUndefined();

    const res = await create(repo, "good");
    expect(res.status).toBe(201);
    const p = res.body;
    expect(p).toMatchObject({ id: "http://af.test/good", slug: "good", name: "Good Repo", status: "active", ci_provider: "generic", base_branch: "main", pinned_commit: repo.head(), pubkey: repo.key.publicKey, pubkey_fingerprint: fingerprint(repo.key.publicKey), lock_sha256: pv.lock_sha256, token_goal: 3_000_000, index_error: null, follow_branch: true, language: "python", tags: ["demo", "tests"] });
    expect(p.maintainer).toEqual({ id: "http://af.test/u/maint", handle: "maint", avatar_url: null });
    const tasks = (await t.call<{ items: Schemas["Task"][] }>("listTasks", { path: { slug: "good" } })).body.items;
    expect(tasks.map((x) => [x.id, x.state, x.claimable, x.commit, x.manifest_path])).toEqual([
      ["good:0001-a", "open", true, repo.head(), "tasks/0001-a.yaml"],
      ["good:0002-b", "open", false, repo.head(), "tasks/0002-b.yaml"],
    ]);
    expect(tasks[0]!.content_hash).toBe(pv.manifests![0]!.content_hash);
    expect(tasks[0]!.manifest).toMatchObject({ id: "0001-a", max_tokens: 2_000_000, scope: { write: ["src/**"] } });
    expect((await events("good")).map((e) => e.action).sort()).toEqual(["manifest.added", "manifest.added", "project.created"]);
    // First project makes a donor a maintainer.
    expect((await t.call<Schemas["Me"]>("getMe", { token: session })).body.role).toBe("admin"); // first user stays admin
    const second = await t.login("second");
    const repo2 = TestRepo.create([{ id: "0001-a" }], { name: "second" });
    await t.call("createProject", { token: second, body: { repo_url: repo2.url } });
    expect((await t.call<Schemas["Me"]>("getMe", { token: second })).body.role).toBe("maintainer");

    // Same repo again, or the same slug.
    expect((await create(repo, "good-again")).code).toBe("repo-already-registered");
    expect((await preview(repo)).ok).toBe(false);
    const other = TestRepo.create([{ id: "0001-a" }]);
    expect((await create(other, "good")).code).toBe("slug-taken");
    for (const reserved of ["v1", "u", "og", "auth", "admin", "donors", "maintain", "settings", "styleguide", "problems", "assets", "api", "healthz", "static", "feed", "sitemap", "robots", "favicon"]) {
      const r = await create(other, reserved);
      expect(r.status, reserved).toBe(422);
      expect(r.code).toBe("validation");
    }
    // A project whose name slugifies to a reserved word gets another suggestion, and no default slug.
    const named = TestRepo.create([{ id: "0001-a" }], { name: "Settings" });
    expect((await preview(named)).suggested_slug).toBe("settings-2");
    expect((await t.call("createProject", { token: session, body: { repo_url: named.url } })).status).toBe(422);
    expect((await t.call("createProject", { token: session, body: { repo_url: "https://localhost/x/y" } })).code).toBe("validation");
    expect((await t.call("createProject", { token: session, body: { repo_url: "ext::sh -c 'id'" } })).code).toBe("validation");
    expect((await t.call("previewProject", { token: session, body: { repo_url: "git@github.com:a/b.git" } })).status).toBe(422);
    expect((await t.call("previewProject", { body: { repo_url: repo.url } })).status).toBe(401);
  });

  it("honours a non-default base branch and a token_goal override", async () => {
    const repo = new TestRepo({ name: "trunky" });
    repo.descriptor.base_branch = "trunk";
    repo.git("checkout", "--quiet", "-b", "trunk");
    repo.writeDescriptor();
    repo.manifest({ id: "0001-a" });
    repo.signLock();
    repo.commit("on trunk");
    const res = await t.call<Project>("createProject", { token: session, body: { repo_url: repo.url, token_goal: 777 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: "trunky", base_branch: "trunk", token_goal: 777 });
  });
});

describe("indexer: rejects what does not verify", () => {
  const cases: [string, (r: TestRepo) => void, RegExp][] = [
    ["a manifest edited after signing", (r) => r.write("tasks/0001-a.yaml", manifestYaml({ id: "0001-a", prompt: "rm -rf /" })), /does not match its sha256/],
    ["a lock edited after signing", (r) => r.write("tasks/MANIFEST.lock", r.read("tasks/MANIFEST.lock").toString().replace("0001-a", "0001-a").replace(/"sha256": "(.)/, (_m, c: string) => `"sha256": "${c === "0" ? "1" : "0"}`)), /signature/],
    ["a tampered signature", (r) => r.write("tasks/MANIFEST.lock.minisig", r.read("tasks/MANIFEST.lock.minisig").toString().replace(/key:[0-9a-f]+/, "key:evil")), /signature/],
    ["a lock signed by somebody else", (r) => r.signLock({ key: generateKeyPair() }), /signature/],
    ["a legacy (non-prehashed) signature", (r) => r.signLock({ legacy: true }), /legacy/],
    ["a manifest that is not in the lock", (r) => r.manifest({ id: "0009-sneaky" }), /not listed in the lock/],
    ["a lock entry without a file", (r) => r.remove("tasks/0001-a.yaml"), /missing from the commit/],
    ["a missing signature", (r) => r.remove("tasks/MANIFEST.lock.minisig"), /minisig is missing/],
    ["YAML with an anchor", (r) => { r.write("tasks/0001-a.yaml", manifestYaml({ id: "0001-a" }).replace("verify:", "x: &a 1\nverify:")); r.signLock(); }, /anchors/],
    ["a manifest that fails the schema", (r) => { r.write("tasks/0001-a.yaml", manifestYaml({ id: "0001-a" }).replace("src/**", "../etc/**")); r.signLock(); }, /0001-a\.yaml/],
    ["an id that differs from the file name", (r) => { r.write("tasks/0001-a.yaml", manifestYaml({ id: "0001-zzz" })); r.signLock(); }, /does not match the file name/],
    ["a dependency on an unknown task", (r) => { r.manifest({ id: "0001-a", depends_on: ["0007-ghost"] }); r.signLock(); }, /unknown task/],
    ["a dependency cycle", (r) => { r.manifest({ id: "0001-a", depends_on: ["0002-b"] }); r.manifest({ id: "0002-b", depends_on: ["0001-a"] }); r.signLock(); }, /cycle/],
  ];

  it.each(cases)("on create: %s", async (_name, tamper, message) => {
    const repo = TestRepo.create([{ id: "0001-a" }]);
    tamper(repo);
    repo.commit("tamper");
    const pv = await preview(repo);
    expect(pv.ok).toBe(false);
    expect(pv.errors.join("\n")).toMatch(message);
    const res = await t.call<Schemas["Problem"]>("createProject", { token: session, body: { repo_url: repo.url } });
    expect(res.status).toBe(422);
    expect(res.code).toBe("repo-unverifiable");
    expect(res.body.detail).toMatch(message);
  });

  it("on create: no agentfund.yaml, a foreign repo_url, an unreachable repo", async () => {
    const bare = new TestRepo();
    bare.remove("agentfund.yaml");
    bare.commit("nothing");
    expect((await preview(bare)).errors.join()).toBe("no agentfund.yaml at the repo root");
    const foreign = TestRepo.create([{ id: "0001-a" }], { repoUrl: "https://github.com/someone/else" });
    expect((await preview(foreign)).errors.join()).toMatch(/is not the repository being registered/);
    expect((await create(foreign, "foreign")).code).toBe("repo-unverifiable");
    const gone = await t.call<Preview>("previewProject", { token: session, body: { repo_url: "file:///nonexistent/af-nope" } });
    expect(gone.body).toMatchObject({ ok: false });
    expect(gone.body.errors).toEqual(["repository not found or no access"]);
    const created = await t.call<Schemas["Problem"]>("createProject", { token: session, body: { repo_url: "file:///nonexistent/af-nope" } });
    expect(created.code).toBe("repo-unverifiable");
    expect(created.body.detail).toBe("repository not found or no access");
    expect(JSON.stringify(created.body)).not.toMatch(/fatal|git fetch|stderr/);
    // A base branch that is not there.
    const nobranch = TestRepo.create([{ id: "0001-a" }]);
    nobranch.descriptor.base_branch = "release";
    nobranch.writeDescriptor();
    nobranch.commit("names a missing branch");
    expect((await preview(nobranch)).errors.join()).toMatch(/^branch "release" not found/);
  });

  it.each(cases.slice(0, 7))("on re-index: %s → index_error, pin untouched", async (name, tamper, message) => {
    const slug = `tamper-${cases.findIndex((c) => c[0] === name)}`;
    const { repo, project, maintainer } = await setupProject(t, slug, [{ id: "0001-a" }, { id: "0002-b" }]);
    tamper(repo);
    const bad = repo.commit("tamper");
    const out = await indexProject(t.ctx, await pid(slug));
    expect(out).toMatchObject({ ok: false, changed: false, commit: bad });
    let p = await getProject(t, slug);
    expect(p.pinned_commit).toBe(project.pinned_commit);
    expect(p.lock_sha256).toBe(project.lock_sha256);
    expect(p.index_error).toMatch(message);
    expect((await getTask(t, slug, "0001-a")).commit).toBe(project.pinned_commit);
    expect((await t.call<{ items: Schemas["Task"][] }>("listTasks", { path: { slug } })).body.items.map((x) => x.task_id)).toEqual(["0001-a", "0002-b"]);
    // One event per distinct failure, however often the timer fires.
    await indexProject(t.ctx, await pid(slug));
    await indexAll(t.ctx);
    const failed = (await events(slug)).filter((e) => e.action === "project.index_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ commit: bad, pinned_commit: project.pinned_commit });
    // repin surfaces it as 422 repo-unverifiable.
    const repin = await t.call("repinProject", { token: maintainer, path: { slug } });
    expect(repin.status).toBe(422);
    expect(repin.code).toBe("repo-unverifiable");
    // Claims keep being served from the last good pin.
    const d = await t.donor(`${slug}-d`.slice(0, 39));
    expect((await claim(t, d.key, `${slug}:0001-a`)).commit).toBe(project.pinned_commit);
    // A fixed head clears the error.
    repo.git("reset", "--quiet", "--hard", project.pinned_commit);
    repo.write("README.md", "# fixed\n");
    const good = repo.commit("fixed");
    expect(await indexProject(t.ctx, await pid(slug))).toMatchObject({ ok: true, commit: good });
    p = await getProject(t, slug);
    expect(p).toMatchObject({ pinned_commit: good, index_error: null });
  });
});

describe("indexer: following the branch", () => {
  it("advances the pin, emits manifest added/changed/removed and project.repinned, and keeps claims on their commit", async () => {
    const { repo, project, maintainer } = await setupProject(t, "follow", [{ id: "0001-a" }, { id: "0002-b" }, { id: "0003-c" }]);
    const first = project.pinned_commit;
    const d = await t.donor("follower");
    const held = await claim(t, d.key, "follow:0002-b");
    const before = await getTask(t, "follow", "0001-a");

    repo.manifest({ id: "0001-a", prompt: "A sharper prompt." }); // changed while open
    repo.manifest({ id: "0002-b", prompt: "Changed while claimed." });
    repo.remove("tasks/0003-c.yaml"); // removed
    repo.manifest({ id: "0004-d" }); // added
    repo.signLock();
    const second = repo.commit("task set v2");

    await indexAll(t.ctx);
    const p = await getProject(t, "follow");
    expect(p.pinned_commit).toBe(second);
    expect(p.lock_sha256).not.toBe(project.lock_sha256);
    expect(p.tasks).toMatchObject({ open: 2, claimed: 1, failed: 1 });

    const a = await getTask(t, "follow", "0001-a");
    expect(a.commit).toBe(second);
    expect(a.content_hash).not.toBe(before.content_hash);
    expect(a.manifest.prompt).toBe("A sharper prompt.");
    expect(a.state).toBe("open");
    const b = await getTask(t, "follow", "0002-b");
    expect(b.state).toBe("claimed");
    expect((await getTask(t, "follow", "0003-c")).state).toBe("failed");
    expect((await getTask(t, "follow", "0004-d")).state).toBe("open");
    // The running claim still names the commit and hash it was granted.
    const mine = (await t.call<{ items: Schemas["ClaimSummary"][] }>("listMyClaims", { token: d.key, query: { active: true } })).body.items;
    expect(mine).toHaveLength(1);
    const snap = (await t.ctx.db.execute(sql`SELECT commit, content_hash FROM claims WHERE public_id = ${held.claim_id}`)) as unknown as { commit: string; content_hash: string }[];
    expect(snap[0]).toEqual({ commit: first, content_hash: held.content_hash });
    expect((await t.call("claimTask", { token: d.key, path: { task_id: "follow:0003-c" } })).code).toBe("task-not-open");

    const ev = await events("follow");
    const by = (action: string) => ev.filter((e) => e.action === action).map((e) => e.task_id);
    expect(by("manifest.changed").sort()).toEqual(["follow:0001-a", "follow:0002-b"]);
    expect(by("manifest.removed")).toEqual(["follow:0003-c"]);
    expect(by("manifest.added").sort()).toEqual(["follow:0001-a", "follow:0002-b", "follow:0003-c", "follow:0004-d"]);
    const repinned = ev.find((e) => e.action === "project.repinned");
    expect(repinned).toMatchObject({ actor: "indexer", payload: { from: first, to: second, lock_changed: true } });

    // A code-only commit moves the pin but not the lock.
    repo.write("src/x.py", "print(1)\n");
    const third = repo.commit("code only");
    await indexAll(t.ctx);
    const p3 = await getProject(t, "follow");
    expect(p3.pinned_commit).toBe(third);
    expect(p3.lock_sha256).toBe(p.lock_sha256);
    expect((await getTask(t, "follow", "0001-a")).commit).toBe(third);
    expect((await events("follow")).filter((e) => e.action.startsWith("manifest.")).length).toBe(ev.filter((e) => e.action.startsWith("manifest.")).length);

    // follow_branch off: the timer leaves the pin alone; repin moves it; an explicit commit pins it back.
    await t.call("updateProject", { token: maintainer, path: { slug: "follow" }, body: { follow_branch: false } });
    repo.write("src/y.py", "print(2)\n");
    const fourth = repo.commit("more code");
    await indexAll(t.ctx);
    expect(await indexProject(t.ctx, await pid("follow"))).toMatchObject({ ok: true, changed: false });
    expect((await getProject(t, "follow")).pinned_commit).toBe(third);
    const repin = await t.call<Project>("repinProject", { token: maintainer, path: { slug: "follow" } });
    expect(repin.status).toBe(200);
    expect(repin.body.pinned_commit).toBe(fourth);
    const back = await t.call<Project>("repinProject", { token: maintainer, path: { slug: "follow" }, body: { commit: third } });
    expect(back.body.pinned_commit).toBe(third);
    expect((await events("follow")).find((e) => e.action === "project.repinned")!.actor).toBe("follow-owner");
    expect((await t.call("repinProject", { token: maintainer, path: { slug: "follow" }, body: { commit: "f".repeat(40) } })).code).toBe("repo-unverifiable");
    expect((await t.call("repinProject", { token: maintainer, path: { slug: "follow" }, body: { commit: "nope" } })).status).toBe(422);
    const stranger = await t.login("stranger");
    expect((await t.call("repinProject", { token: stranger, path: { slug: "follow" } })).status).toBe(403);
    expect((await t.call("repinProject", { token: stranger, path: { slug: "nothing-here" } })).status).toBe(404);
  });
});

describe("indexer: key rotation", () => {
  it("accepts a lock signed by a key reached through a valid chain from the registered key, and nothing else", async () => {
    const { repo, project } = await setupProject(t, "rotate", [{ id: "0001-a" }]);
    const k0 = repo.key;
    const k1 = generateKeyPair();
    const k2 = generateKeyPair();

    // A plain key swap in agentfund.yaml (no rotation statement) is rejected.
    repo.key = k1;
    repo.writeDescriptor();
    repo.signLock();
    repo.commit("swap key without rotation");
    expect((await indexProject(t.ctx, await pid("rotate"))).ok).toBe(false);
    let p = await getProject(t, "rotate");
    expect(p).toMatchObject({ pubkey: k0.publicKey, pinned_commit: project.pinned_commit });
    expect(p.index_error).toMatch(/registered key/);

    // A rotation statement forged by the new key is rejected too.
    repo.rotations = [{ ...signRotation(k1, k1), from: k0.publicKey, to: k1.publicKey }];
    repo.signLock();
    repo.commit("forged rotation");
    expect((await indexProject(t.ctx, await pid("rotate"))).error).toMatch(/rotation 1/);

    // Proper chain K0 → K1 → K2, lock signed by K2.
    repo.key = k2;
    repo.rotations = [signRotation(k0, k1), signRotation(k1, k2)];
    repo.writeDescriptor();
    repo.signLock();
    const rotated = repo.commit("rotate twice");
    expect(await indexProject(t.ctx, await pid("rotate"))).toMatchObject({ ok: true, commit: rotated });
    p = await getProject(t, "rotate");
    expect(p).toMatchObject({ pinned_commit: rotated, pubkey: k2.publicKey, pubkey_fingerprint: fingerprint(k2.publicKey), index_error: null });
    const ev = (await events("rotate")).find((e) => e.action === "project.key_rotated");
    expect(ev?.payload).toMatchObject({ from: fingerprint(k0.publicKey), to: fingerprint(k2.publicKey), hops: 2 });

    // The registered key is now K2: the retired K0 cannot sign any more, later K2 locks keep verifying.
    repo.write("src/z.py", "1\n");
    repo.signLock({ key: k0 });
    repo.commit("old key tries again");
    expect((await indexProject(t.ctx, await pid("rotate"))).ok).toBe(false);
    repo.signLock();
    const ok = repo.commit("current key");
    expect(await indexProject(t.ctx, await pid("rotate"))).toMatchObject({ ok: true, commit: ok });
  });
});
