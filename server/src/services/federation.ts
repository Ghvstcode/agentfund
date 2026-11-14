/**
 * Federation (protocol.md §14): peering, discovery, portable donor identity.
 *
 * The shape of the trust is deliberate and small:
 *   - A peer is added by an admin, who confirms its key fingerprint; the key is pinned.
 *   - Everything fetched from a peer is its own public reads. It is shown attributed to the
 *     peer and never added to a local number.
 *   - The only thing a peer can make this instance *do* is admit one of its donors, and only
 *     when the admin turned `accept_identities` on for it. An admitted donor is an ordinary
 *     donor here: same caps, same evidence rules, bannable like anyone else.
 */
import { eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, isoOrNull, num, rows, textArray, tsParam } from "../db/client.js";
import { assertionNonces, peers, remoteProjects, remoteStandings, users } from "../db/schema.js";
import { offsetOf, pageByOffset } from "../lib/cursor.js";
import { newSecret, sha256Hex } from "../lib/ids.js";
import { fingerprint, MinisignError, parsePublicKey, sign, verify } from "../lib/minisign.js";
import type { BodyOf, Schemas } from "../lib/openapi.js";
import { Problem, validation } from "../lib/problem.js";
import { createApiKey, toApiKey, toMe, userGlobalId, type Principal, type UserRow } from "./auth.js";
import { appendEvent } from "./events.js";
import { getInstance } from "./instance.js";
import { peerDonors } from "./ledger.js";

export type PeerRow = typeof peers.$inferSelect;
type Peer = Schemas["Peer"];

export const ASSERTION_TYPE = "agentfund-identity-v1";
export const ASSERTION_TTL_SECONDS = 300;
/** Longest lifetime accepted from a peer, and how far its clock may run ahead of ours. */
const ASSERTION_MAX_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_PROJECTS = 500;
const MAX_REMOTE_STANDINGS = 2000;
const PAGE = 100;

const LOCAL_HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function requireFederation(ctx: AppContext): void {
  if (!ctx.config.federation) throw new Problem("not-found", "Federation is not enabled on this instance.");
}

/* ---- base URLs ---- */

/** Canonical form of an instance base URL, the same rule BASE_URL goes through; null when unusable. */
export function normalizeBaseUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const hostOf = (baseUrl: string): string => new URL(baseUrl).host.toLowerCase();

function requireBaseUrl(input: string, field: string): string {
  const base = normalizeBaseUrl(input);
  if (!base) throw validation(field, "must be an http(s) base URL without credentials, query or fragment");
  return base;
}

/* ---- fetching from a peer: its public reads, bounded and never followed elsewhere ---- */

class PeerFetchError extends Error {}

async function fetchJson(ctx: AppContext, url: string): Promise<unknown> {
  let res: Response;
  try {
    // Redirects are refused: a peer is the URL the admin confirmed, not wherever it points today.
    res = await ctx.fetch(url, { headers: { accept: "application/json", "user-agent": "agentfund-server" }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new PeerFetchError(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new PeerFetchError(`${url} answered ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESPONSE_BYTES) throw new PeerFetchError(`${url} answered more than ${MAX_RESPONSE_BYTES} bytes`);
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new PeerFetchError(`${url} did not answer JSON`);
  }
}

interface PeerMeta {
  name: string;
  description: string;
  version: string | null;
  pubkey: string;
  federation: boolean;
}

/** Reads a peer's `/v1/meta` and checks it is the instance at that URL, with a usable key. */
async function fetchMeta(ctx: AppContext, baseUrl: string): Promise<PeerMeta> {
  const body = await fetchJson(ctx, `${baseUrl}/v1/meta`);
  if (!ctx.spec.schema("Meta")(body)) throw new PeerFetchError(`${baseUrl}/v1/meta is not an instance's metadata`);
  const meta = body as Schemas["Meta"];
  if (normalizeBaseUrl(meta.base_url) !== baseUrl) throw new PeerFetchError(`the instance at ${baseUrl} says its base URL is ${meta.base_url}; peer with that URL instead`);
  if (!meta.instance_pubkey) throw new PeerFetchError(`${baseUrl} publishes no instance key`);
  try {
    parsePublicKey(meta.instance_pubkey);
  } catch (err) {
    throw new PeerFetchError(`${baseUrl} publishes an unusable instance key: ${(err as Error).message}`);
  }
  return {
    name: meta.name.slice(0, 80) || hostOf(baseUrl),
    description: (meta.description ?? "").slice(0, 500),
    version: meta.version ? meta.version.slice(0, 40) : null,
    pubkey: meta.instance_pubkey.trim(),
    federation: meta.capabilities.federation === true,
  };
}

async function fetchPages<T>(ctx: AppContext, url: (cursor: string | null) => string, valid: (item: unknown) => boolean, max: number): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < Math.ceil(max / PAGE) && out.length < max; page++) {
    const body = (await fetchJson(ctx, url(cursor))) as { items?: unknown; next_cursor?: unknown } | null;
    if (!body || !Array.isArray(body.items)) throw new PeerFetchError(`${url(cursor)} is not a page`);
    // One malformed item does not hide the rest; it is simply not shown.
    for (const item of body.items as unknown[]) if (valid(item)) out.push(item as T);
    if (typeof body.next_cursor !== "string" || body.next_cursor === "") break;
    cursor = body.next_cursor;
  }
  return out.slice(0, max);
}

/* ---- peers ---- */

const peerRef = (p: Pick<PeerRow, "baseUrl" | "host" | "name">): Schemas["PeerRef"] => ({ base_url: p.baseUrl, host: p.host, name: p.name });

async function toPeers(ctx: AppContext, list: PeerRow[], admin: boolean): Promise<Peer[]> {
  if (list.length === 0) return [];
  const counts = await rows<{ peer_id: string; projects: string; donors: string }>(
    ctx.db,
    sql`SELECT p.id AS peer_id,
          (SELECT count(*) FROM remote_projects r WHERE r.peer_id = p.id)::text AS projects,
          (SELECT count(*) FROM users u WHERE u.peer_id = p.id)::text AS donors
        FROM peers p`,
  );
  const byId = new Map(counts.map((c) => [Number(c.peer_id), c]));
  return list.map((p) => ({
    ...peerRef(p),
    description: p.description,
    version: p.version,
    pubkey: p.pubkey,
    pubkey_fingerprint: fingerprint(p.pubkey),
    status: p.status as Peer["status"],
    discover: p.discover,
    accept_identities: p.acceptIdentities,
    accepts_us: p.acceptsUs,
    projects: num(byId.get(p.id)?.projects),
    donors: num(byId.get(p.id)?.donors),
    added_at: iso(p.addedAt),
    last_synced_at: isoOrNull(p.lastSyncedAt),
    last_error: admin ? p.lastError : null,
    observed_pubkey: admin ? p.observedPubkey : null,
    observed_pubkey_fingerprint: admin && p.observedPubkey ? fingerprint(p.observedPubkey) : null,
  }));
}

export async function listPeers(ctx: AppContext, opts: { admin: boolean }): Promise<Peer[]> {
  const list = await ctx.db.select().from(peers).where(opts.admin ? undefined : eq(peers.status, "active")).orderBy(peers.host);
  return toPeers(ctx, list, opts.admin);
}

async function peerByHost(ctx: AppContext, host: string): Promise<PeerRow> {
  const [row] = await ctx.db.select().from(peers).where(eq(peers.host, host.toLowerCase()));
  if (!row) throw new Problem("not-found", `No peer ${host}.`);
  return row;
}

async function onePeer(ctx: AppContext, id: number): Promise<Peer> {
  const [row] = await ctx.db.select().from(peers).where(eq(peers.id, id));
  if (!row) throw new Problem("not-found", "No such peer.");
  return (await toPeers(ctx, [row], true))[0]!;
}

function peerBaseUrl(ctx: AppContext, input: string): string {
  const base = requireBaseUrl(input, "/base_url");
  if (base === ctx.config.baseUrl) throw validation("/base_url", "that is this instance");
  return base;
}

export async function previewPeer(ctx: AppContext, input: string): Promise<Schemas["PeerPreview"]> {
  const base = peerBaseUrl(ctx, input);
  let meta: PeerMeta;
  try {
    meta = await fetchMeta(ctx, base);
  } catch (err) {
    if (err instanceof PeerFetchError) throw new Problem("peer-unverifiable", err.message);
    throw err;
  }
  return { base_url: base, host: hostOf(base), name: meta.name, description: meta.description, version: meta.version, pubkey: meta.pubkey, pubkey_fingerprint: fingerprint(meta.pubkey), federation: meta.federation };
}

export async function createPeer(ctx: AppContext, who: Principal, body: BodyOf<"adminCreatePeer">): Promise<Peer> {
  const preview = await previewPeer(ctx, body.base_url);
  if (!preview.federation) throw new Problem("peer-unverifiable", `${preview.base_url} does not serve federation (its capabilities.federation is off).`);
  // The key that gets pinned is the one the admin looked at, not whatever is served a moment later.
  if (preview.pubkey !== body.pubkey.trim()) {
    throw new Problem("peer-unverifiable", `${preview.base_url} publishes ${preview.pubkey_fingerprint}, not the key that was confirmed. Look it up again.`);
  }
  const row = await ctx.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(peers)
      .values({
        baseUrl: preview.base_url,
        host: preview.host,
        name: preview.name,
        description: preview.description ?? "",
        version: preview.version ?? null,
        pubkey: preview.pubkey,
        discover: body.discover ?? true,
        acceptIdentities: body.accept_identities ?? false,
        addedAt: ctx.clock.now(),
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new Problem("peer-exists", `Already peered with ${preview.host}.`);
    await appendEvent(ctx, tx, {
      actor: who.user.handle,
      action: "peer.added",
      public: false,
      payload: { host: created.host, base_url: created.baseUrl, pubkey_fingerprint: preview.pubkey_fingerprint, discover: created.discover, accept_identities: created.acceptIdentities },
    });
    return created;
  });
  await syncPeer(ctx, row);
  return onePeer(ctx, row.id);
}

export async function updatePeer(ctx: AppContext, who: Principal, host: string, patch: BodyOf<"adminUpdatePeer">): Promise<Peer> {
  const row = await peerByHost(ctx, host);
  const set: Partial<typeof peers.$inferInsert> = {};
  if (patch.pubkey !== undefined) {
    const key = patch.pubkey.trim();
    try {
      parsePublicKey(key);
    } catch (err) {
      throw validation("/pubkey", (err as MinisignError).message);
    }
    set.pubkey = key;
    set.observedPubkey = null;
    set.lastError = null;
    if (row.status === "key_mismatch") set.status = "active";
  }
  if (patch.status !== undefined) {
    if (row.status === "key_mismatch" && patch.status === "active" && patch.pubkey === undefined) {
      throw validation("/status", "this peer publishes a key other than the pinned one; pin the new key (pubkey) or remove the peer");
    }
    set.status = patch.status;
  }
  if (patch.discover !== undefined) set.discover = patch.discover;
  if (patch.accept_identities !== undefined) set.acceptIdentities = patch.accept_identities;
  if (Object.keys(set).length === 0) return onePeer(ctx, row.id);
  const updated = await ctx.db.transaction(async (tx) => {
    const [next] = await tx.update(peers).set(set).where(eq(peers.id, row.id)).returning();
    if (!next) throw new Problem("not-found", `No peer ${host}.`);
    if (!next.discover) await tx.delete(remoteProjects).where(eq(remoteProjects.peerId, next.id));
    await appendEvent(ctx, tx, {
      actor: who.user.handle,
      action: "peer.updated",
      public: false,
      payload: { host: next.host, status: next.status, discover: next.discover, accept_identities: next.acceptIdentities, pubkey_fingerprint: fingerprint(next.pubkey) },
    });
    return next;
  });
  // A re-pinned or resumed peer is worth fetching from straight away.
  if (updated.status === "active" && (row.status !== "active" || (updated.discover && !row.discover))) await syncPeer(ctx, updated);
  return onePeer(ctx, row.id);
}

export async function deletePeer(ctx: AppContext, who: Principal, host: string): Promise<void> {
  const row = await peerByHost(ctx, host);
  await ctx.db.transaction(async (tx) => {
    // Cached projects and standings go with the row. Its donors keep their history; with no
    // peer behind them their credentials stop resolving (auth.homeStillTrusted).
    await tx.delete(peers).where(eq(peers.id, row.id));
    await appendEvent(ctx, tx, { actor: who.user.handle, action: "peer.removed", public: false, payload: { host: row.host, base_url: row.baseUrl } });
  });
}

export async function syncPeerByHost(ctx: AppContext, host: string): Promise<Peer> {
  const row = await peerByHost(ctx, host);
  await syncPeer(ctx, row);
  return onePeer(ctx, row.id);
}

/* ---- sync: pull a peer's public reads ---- */

type RemoteProject = Schemas["Project"];

/** A peer's numbers are stored as it gives them, but only if they are numbers a ledger could hold. */
const tokensOk = (...values: unknown[]): boolean => values.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e15);
const countsOk = (...values: unknown[]): boolean => values.every((v) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9));

function usableProject(ctx: AppContext): (item: unknown) => boolean {
  const schema = ctx.spec.schema("Project");
  return (item) => {
    if (!schema(item)) return false;
    const p = item as RemoteProject;
    return (
      SLUG.test(p.slug) &&
      ["active", "paused"].includes(p.status) &&
      tokensOk(p.token_goal, p.totals.pledged, p.totals.reported, p.totals.delivered, p.totals.merged, p.totals.in_flight) &&
      countsOk(p.donors, p.tasks.open, p.tasks.claimed, p.tasks.delivered, p.tasks.merged, p.tasks.failed, p.tasks.claimable)
    );
  };
}

function usableStanding(ctx: AppContext): (item: unknown) => boolean {
  const schema = ctx.spec.schema("DonorStanding");
  return (item) => {
    if (!schema(item)) return false;
    const s = item as Schemas["DonorStanding"];
    return tokensOk(s.pledged, s.reported, s.delivered, s.merged) && countsOk(s.tasks_delivered, s.tasks_merged);
  };
}

async function storeProjects(ctx: AppContext, peer: PeerRow, list: RemoteProject[]): Promise<void> {
  const now = ctx.clock.now();
  const seen = new Map(list.map((p) => [p.slug, p]));
  await ctx.db.transaction(async (tx) => {
    const slugs = [...seen.keys()];
    await tx.execute(sql`DELETE FROM remote_projects WHERE peer_id = ${peer.id} AND NOT (slug = ANY(${textArray(slugs)}))`);
    for (const p of seen.values()) {
      const values = {
        name: p.name.slice(0, 200),
        description: p.description.slice(0, 1000),
        repoUrl: p.repo_url.slice(0, 2048),
        language: p.language ? p.language.slice(0, 50) : null,
        tags: (p.tags ?? []).slice(0, 10).map((t) => t.slice(0, 50)),
        status: p.status,
        tokenGoal: p.token_goal,
        totals: p.totals,
        tasks: p.tasks,
        delivered: p.totals.delivered,
        donors: p.donors,
        trustTier: p.trust.tier,
        fetchedAt: now,
      };
      await tx
        .insert(remoteProjects)
        .values({ peerId: peer.id, slug: p.slug, ...values })
        .onConflictDoUpdate({ target: [remoteProjects.peerId, remoteProjects.slug], set: values });
    }
  });
}

/** Keeps what the peer says about donors this instance vouched for: ids under our own base URL. */
async function storeStandings(ctx: AppContext, peer: PeerRow, list: Schemas["DonorStanding"][]): Promise<void> {
  const prefix = `${ctx.config.baseUrl}/u/`;
  const claimed = new Map<string, Schemas["DonorStanding"]>();
  for (const s of list) {
    if (!s.id.startsWith(prefix)) continue;
    const handle = s.id.slice(prefix.length);
    if (LOCAL_HANDLE.test(handle)) claimed.set(handle, s);
  }
  const handles = [...claimed.keys()];
  const local = handles.length ? await rows<{ id: string; handle: string }>(ctx.db, sql`SELECT id, handle FROM users WHERE home_id IS NULL AND handle = ANY(${textArray(handles)})`) : [];
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    await tx.delete(remoteStandings).where(eq(remoteStandings.peerId, peer.id));
    for (const u of local) {
      const s = claimed.get(u.handle)!;
      await tx.insert(remoteStandings).values({
        peerId: peer.id,
        userId: Number(u.id),
        remoteHandle: s.handle.slice(0, 320),
        pledged: s.pledged,
        reported: s.reported,
        delivered: s.delivered,
        merged: s.merged,
        tasksDelivered: s.tasks_delivered,
        tasksMerged: s.tasks_merged,
        fetchedAt: now,
      });
    }
  });
}

/**
 * One pull from one peer. Never throws: what went wrong is recorded on the peer row
 * (`last_error`) where the admin sees it, and the previous cache stays as it was.
 */
export async function syncPeer(ctx: AppContext, peer: PeerRow): Promise<void> {
  if (peer.status === "paused") return;
  try {
    const meta = await fetchMeta(ctx, peer.baseUrl);
    if (meta.pubkey !== peer.pubkey) {
      const detail = `publishes ${fingerprint(meta.pubkey)}, not the pinned ${fingerprint(peer.pubkey)}`;
      await ctx.db.transaction(async (tx) => {
        // `status <> 'paused'` here and below: an admin who paused the peer mid-sync stays in charge.
        await tx.update(peers).set({ status: "key_mismatch", observedPubkey: meta.pubkey, lastError: `${peer.host} ${detail}` }).where(sql`${peers.id} = ${peer.id} AND ${peers.status} <> 'paused'`);
        if (peer.status !== "key_mismatch" || peer.observedPubkey !== meta.pubkey) {
          await appendEvent(ctx, tx, { actor: "system", action: "peer.key_mismatch", public: false, payload: { host: peer.host, pinned: fingerprint(peer.pubkey), observed: fingerprint(meta.pubkey) } });
        }
      });
      ctx.log.warn("peer key mismatch", { peer: peer.host, detail });
      return;
    }
    let acceptsUs: boolean | null = null;
    if (meta.federation) {
      const theirs = (await fetchJson(ctx, `${peer.baseUrl}/v1/federation/peers`)) as { items?: unknown } | null;
      const items = Array.isArray(theirs?.items) ? (theirs.items as { base_url?: unknown; accept_identities?: unknown }[]) : [];
      acceptsUs = items.some((p) => typeof p?.base_url === "string" && normalizeBaseUrl(p.base_url) === ctx.config.baseUrl && p.accept_identities === true);
    }
    if (peer.discover) {
      const valid = usableProject(ctx);
      const active = await fetchPages<RemoteProject>(ctx, (c) => `${peer.baseUrl}/v1/projects?status=active&sort=delivered&limit=${PAGE}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`, valid, MAX_REMOTE_PROJECTS);
      await storeProjects(ctx, peer, active);
    }
    if (meta.federation) {
      const home = encodeURIComponent(ctx.config.baseUrl);
      const list = await fetchPages<Schemas["DonorStanding"]>(ctx, (c) => `${peer.baseUrl}/v1/federation/donors?home=${home}&limit=${PAGE}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`, usableStanding(ctx), MAX_REMOTE_STANDINGS);
      await storeStandings(ctx, peer, list);
    }
    await ctx.db
      .update(peers)
      .set({ name: meta.name, description: meta.description, version: meta.version, acceptsUs, status: sql`CASE WHEN ${peers.status} = 'key_mismatch' THEN 'active' ELSE ${peers.status} END`, observedPubkey: null, lastSyncedAt: ctx.clock.now(), lastError: null })
      .where(eq(peers.id, peer.id));
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (!(err instanceof PeerFetchError)) ctx.log.error("peer sync failed", { peer: peer.host, err });
    await ctx.db.update(peers).set({ lastError: message }).where(eq(peers.id, peer.id)).catch(() => undefined);
  }
}

export async function syncAll(ctx: AppContext): Promise<void> {
  if (!ctx.config.federation) return;
  const list = await ctx.db.select().from(peers).where(sql`${peers.status} <> 'paused'`).orderBy(peers.id);
  for (const peer of list) await syncPeer(ctx, peer);
  await ctx.db.delete(assertionNonces).where(sql`${assertionNonces.expiresAt} < ${tsParam(ctx.clock.now())}`);
}

/* ---- discovery reads ---- */

interface RemoteProjectRow {
  slug: string;
  name: string;
  description: string;
  repo_url: string;
  language: string | null;
  tags: string[] | null;
  status: "active" | "paused";
  token_goal: string;
  totals: Schemas["Totals"];
  tasks: Schemas["TaskCounts"];
  donors: number;
  trust_tier: "new" | "established";
  fetched_at: string;
  base_url: string;
  host: string;
  peer_name: string;
  accepts_us: boolean | null;
}

export async function listFederatedProjects(
  ctx: AppContext,
  opts: { q?: string; peer?: string; language?: string; limit: number; cursor?: string },
): Promise<{ items: Schemas["FederatedProject"][]; next_cursor: string | null }> {
  const offset = offsetOf(opts.cursor);
  const like = opts.q ? `%${opts.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const list = await rows<RemoteProjectRow>(
    ctx.db,
    sql`SELECT r.slug, r.name, r.description, r.repo_url, r.language, r.tags, r.status, r.token_goal::text AS token_goal, r.totals, r.tasks,
               r.donors, r.trust_tier, r.fetched_at, p.base_url, p.host, p.name AS peer_name, p.accepts_us
        FROM remote_projects r JOIN peers p ON p.id = r.peer_id
        WHERE p.status = 'active' AND p.discover
          ${opts.peer ? sql`AND p.host = ${opts.peer.toLowerCase()}` : sql``}
          ${opts.language ? sql`AND lower(coalesce(r.language, '')) = ${opts.language.toLowerCase()}` : sql``}
          ${like ? sql`AND (lower(r.name) LIKE ${like} OR lower(r.description) LIKE ${like} OR lower(r.slug) LIKE ${like} OR EXISTS (SELECT 1 FROM unnest(r.tags) t WHERE lower(t) LIKE ${like}))` : sql``}
        ORDER BY r.delivered DESC, r.id ASC LIMIT ${opts.limit + 1} OFFSET ${offset}`,
  );
  return pageByOffset(
    list.map((r) => ({
      id: `${r.base_url}/${r.slug}`,
      url: `${r.base_url}/${r.slug}`,
      instance: { base_url: r.base_url, host: r.host, name: r.peer_name },
      slug: r.slug,
      name: r.name,
      description: r.description,
      repo_url: r.repo_url,
      language: r.language,
      tags: r.tags ?? [],
      status: r.status,
      token_goal: num(r.token_goal),
      totals: r.totals,
      tasks: r.tasks,
      donors: r.donors,
      trust_tier: r.trust_tier,
      accepts_local_identities: r.accepts_us === true,
      fetched_at: iso(r.fetched_at),
    })),
    opts.limit,
    offset,
  );
}

/** What the instance at `home` pulls: standings here of the donors it vouched for. */
export async function listFederatedDonors(ctx: AppContext, opts: { home: string; limit: number; cursor?: string }): Promise<{ items: Schemas["DonorStanding"][]; next_cursor: string | null }> {
  const home = requireBaseUrl(opts.home, "/home");
  const [peer] = await ctx.db.select({ id: peers.id }).from(peers).where(eq(peers.baseUrl, home));
  if (!peer) {
    offsetOf(opts.cursor);
    return { items: [], next_cursor: null };
  }
  return peerDonors(ctx, peer.id, opts);
}

/** For a donor profile: what active peers report about this (local) donor. */
export async function standingsElsewhere(ctx: AppContext, userId: number): Promise<Schemas["RemoteStanding"][]> {
  const list = await rows<{ base_url: string; host: string; name: string; remote_handle: string; pledged: string; reported: string; delivered: string; merged: string; tasks_delivered: number; tasks_merged: number; fetched_at: string }>(
    ctx.db,
    sql`SELECT p.base_url, p.host, p.name, s.remote_handle, s.pledged::text, s.reported::text, s.delivered::text, s.merged::text, s.tasks_delivered, s.tasks_merged, s.fetched_at
        FROM remote_standings s JOIN peers p ON p.id = s.peer_id
        WHERE s.user_id = ${userId} AND p.status = 'active'
        ORDER BY s.delivered DESC, p.host`,
  );
  return list.map((r) => ({
    instance: { base_url: r.base_url, host: r.host, name: r.name },
    profile_url: `${r.base_url}/u/${r.remote_handle}`,
    pledged: num(r.pledged),
    reported: num(r.reported),
    delivered: num(r.delivered),
    merged: num(r.merged),
    tasks_delivered: r.tasks_delivered,
    tasks_merged: r.tasks_merged,
    fetched_at: iso(r.fetched_at),
  }));
}

/* ---- portable identity ---- */

interface Assertion {
  type: string;
  iss: string;
  sub: string;
  handle: string;
  avatar_url: string | null;
  aud: string;
  iat: string;
  exp: string;
  jti: string;
}

/** This instance vouches, for five minutes and one audience, that the caller is its user. */
export async function createAssertion(ctx: AppContext, who: Principal, audienceInput: string): Promise<{ assertion: Schemas["SignedDocument"]; expires_at: string }> {
  // Identity is not transitive: an instance vouches only for accounts that are its own.
  if (who.user.homeId !== null) throw new Problem("forbidden", "This account's home is another instance; ask that instance for the assertion.");
  const audience = requireBaseUrl(audienceInput, "/audience");
  if (audience === ctx.config.baseUrl) throw validation("/audience", "that is this instance; an assertion is for another one");
  const instance = await getInstance(ctx.db);
  const now = ctx.clock.now();
  const expires = new Date(now.getTime() + ASSERTION_TTL_SECONDS * 1000);
  const body: Assertion = {
    type: ASSERTION_TYPE,
    iss: ctx.config.baseUrl,
    sub: userGlobalId(ctx, who.user.handle),
    handle: who.user.handle,
    avatar_url: who.user.avatarUrl,
    aud: audience,
    iat: now.toISOString(),
    exp: expires.toISOString(),
    jti: newSecret(),
  };
  const payload = JSON.stringify(body);
  const key = { keyId: parsePublicKey(instance.pubkey).keyId, secretSeed: Buffer.from(instance.secretKey, "base64") };
  const signature = sign(Buffer.from(payload, "utf8"), key, `agentfund identity v1 iss:${ctx.config.baseUrl}`);
  return { assertion: { payload, signature }, expires_at: expires.toISOString() };
}

const invalid = (detail: string): Problem => new Problem("assertion-invalid", detail, { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });

function parseAssertion(payload: string): Assertion {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    throw invalid("The assertion payload is not JSON.");
  }
  const a = v as Partial<Record<keyof Assertion, unknown>> | null;
  const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
  if (!a || typeof a !== "object" || Array.isArray(a) || a.type !== ASSERTION_TYPE) throw invalid(`The payload is not an ${ASSERTION_TYPE} statement.`);
  if (!str(a.iss, 2048) || !str(a.sub, 2200) || !str(a.aud, 2048) || !str(a.iat, 40) || !str(a.exp, 40) || !str(a.jti, 128) || a.jti.length < 16) throw invalid("The assertion is missing a field.");
  if (!str(a.handle, 39) || !LOCAL_HANDLE.test(a.handle)) throw invalid("The assertion names no usable handle.");
  if (Number.isNaN(Date.parse(a.iat)) || Number.isNaN(Date.parse(a.exp))) throw invalid("The assertion's times are not dates.");
  const avatar = typeof a.avatar_url === "string" && /^https:\/\/\S{1,2000}$/.test(a.avatar_url) ? a.avatar_url : null;
  return { type: ASSERTION_TYPE, iss: a.iss, sub: a.sub, handle: a.handle, avatar_url: avatar, aud: a.aud, iat: a.iat, exp: a.exp, jti: a.jti };
}

/** Finds or creates the local row for a donor a trusted peer vouched for. Never anything but a donor. */
async function upsertFederatedUser(ctx: AppContext, peer: PeerRow, a: Assertion): Promise<UserRow> {
  return ctx.db.transaction(async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.homeId, a.sub));
    if (user) {
      if (user.banned) throw new Problem("banned", "This account is banned on this instance.");
      if (user.peerId !== peer.id || user.avatarUrl !== a.avatar_url) {
        [user] = await tx.update(users).set({ peerId: peer.id, avatarUrl: a.avatar_url }).where(eq(users.id, user.id)).returning();
      }
    } else {
      // `@` cannot appear in a local handle, so a federated one can never shadow a local account.
      const handle = `${a.handle}@${peer.host}`;
      [user] = await tx.insert(users).values({ handle, avatarUrl: a.avatar_url, role: "donor", peerId: peer.id, homeId: a.sub, createdAt: ctx.clock.now() }).onConflictDoNothing().returning();
      // Only possible when this host was peered before under another base URL (http → https, say):
      // the handle is taken by the donor that peering introduced, and is not handed to someone else.
      if (!user) throw new Problem("peer-not-trusted", `${handle} already exists here from an earlier peering of ${peer.host} under a different base URL; an admin has to resolve it.`);
      await appendEvent(ctx, tx, { actor: handle, action: "user.federated", public: false, payload: { home: peer.baseUrl, id: a.sub } });
    }
    if (!user) throw new Problem("internal", "federated user upsert failed");
    return user;
  });
}

/**
 * Admits a donor on a peer's word. Order matters: nothing in the payload is believed until
 * the signature verifies under the key pinned for the peer it names.
 */
export async function redeemAssertion(ctx: AppContext, body: BodyOf<"authFederated">): Promise<{ key: string; api_key: Schemas["ApiKey"]; user: Schemas["Me"] }> {
  const a = parseAssertion(body.assertion.payload);
  if (normalizeBaseUrl(a.aud) !== ctx.config.baseUrl) throw invalid(`The assertion is for ${a.aud}, not for this instance (${ctx.config.baseUrl}).`);
  const issuer = normalizeBaseUrl(a.iss);
  const [peer] = issuer ? await ctx.db.select().from(peers).where(eq(peers.baseUrl, issuer)) : [];
  if (!peer || peer.status !== "active" || !peer.acceptIdentities) {
    throw new Problem("peer-not-trusted", `This instance does not accept identities from ${a.iss}.`);
  }
  try {
    verify(Buffer.from(body.assertion.payload, "utf8"), body.assertion.signature, peer.pubkey);
  } catch (err) {
    if (err instanceof MinisignError) throw invalid(`The signature does not verify under the key pinned for ${peer.host}: ${err.message}.`);
    throw err;
  }
  if (a.sub !== `${peer.baseUrl}/u/${a.handle}`) throw invalid("The assertion's subject is not a user of its issuer.");
  const now = ctx.clock.now().getTime();
  const iat = Date.parse(a.iat);
  const exp = Date.parse(a.exp);
  if (exp <= now) throw invalid("The assertion has expired; request a new one.");
  if (iat > now + CLOCK_SKEW_SECONDS * 1000 || exp - iat > ASSERTION_MAX_TTL_SECONDS * 1000) throw invalid("The assertion's validity window is not acceptable.");
  // Single use: the insert is the check.
  const [fresh] = await ctx.db
    .insert(assertionNonces)
    .values({ nonceHash: sha256Hex(`${peer.baseUrl}\n${a.jti}`), expiresAt: new Date(exp + CLOCK_SKEW_SECONDS * 1000) })
    .onConflictDoNothing()
    .returning();
  if (!fresh) throw invalid("The assertion was already used; request a new one.");

  const user = await upsertFederatedUser(ctx, peer, a);
  const { row, secret } = await createApiKey(ctx, user.id, body.label ?? `federated via ${peer.host}`);
  return { key: secret, api_key: toApiKey(row), user: toMe(ctx, user) };
}
