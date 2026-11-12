import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, isoOrNull, rows, tsParam, type Queryable } from "../db/client.js";
import { apiKeys, oauthStates, sessions, users } from "../db/schema.js";
import { isMemberLogin } from "./members.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { newApiKey, newId, newSecret, newSessionToken, sha256Hex } from "../lib/ids.js";
import type { Schemas } from "../lib/openapi.js";
import { Problem, validation } from "../lib/problem.js";

export type UserRow = typeof users.$inferSelect;
export type Role = Schemas["Role"];

export interface Principal {
  user: UserRow;
  kind: "session" | "donorKey";
  sessionId?: number;
  apiKeyId?: number;
  /** The GitHub token this session signed in with, opened on demand; null if it has none. */
  githubToken?: () => string | null;
}

export const userGlobalId = (ctx: AppContext, handle: string): string => `${ctx.config.baseUrl}/u/${handle}`;

export const toUserRef = (ctx: AppContext, u: { handle: string; avatarUrl?: string | null; avatar_url?: string | null }): Schemas["UserRef"] => ({
  id: userGlobalId(ctx, u.handle),
  handle: u.handle,
  avatar_url: u.avatarUrl ?? u.avatar_url ?? null,
});

export const toMe = (ctx: AppContext, u: UserRow): Schemas["Me"] => ({
  ...toUserRef(ctx, u),
  role: u.role as Role,
  email: u.email,
  github_login: u.githubLogin,
  banned: u.banned,
  created_at: iso(u.createdAt),
});

/** Resolves a bearer token to a principal, or null. Tokens are compared by SHA-256 hash only. */
export async function authenticate(ctx: AppContext, token: string): Promise<Principal | null> {
  const now = ctx.clock.now();
  const hash = sha256Hex(token);
  if (token.startsWith("afs_")) {
    const [row] = await ctx.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)));
    if (!row || row.session.expiresAt.getTime() <= now.getTime()) return null;
    const sealed = row.session.githubTokenSealed;
    return { user: row.user, kind: "session", sessionId: row.session.id, githubToken: () => (sealed ? openGithubToken(token, sealed) : null) };
  }
  if (token.startsWith("af_")) {
    const [row] = await ctx.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > 60_000) {
      await ctx.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id));
    }
    return { user: row.user, kind: "donorKey", apiKeyId: row.key.id };
  }
  return null;
}

/*
 * The GitHub sign-in token is kept on its session, sealed (AES-256-GCM) under a key derived from
 * the session token. The database stores only the session token's hash, so a copy of it cannot
 * open the GitHub token; it dies with the session (logout, ban, expiry).
 */
const sealKey = (sessionToken: string): Buffer => Buffer.from(hkdfSync("sha256", sessionToken, "agentfund", "session github token", 32));

export function sealGithubToken(sessionToken: string, githubToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(sessionToken), iv);
  const body = Buffer.concat([cipher.update(githubToken, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

export function openGithubToken(sessionToken: string, sealed: string): string | null {
  const [iv, body, tag] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !body || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(sessionToken), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export async function createSession(ctx: AppContext, userId: number, githubToken?: string): Promise<string> {
  const token = newSessionToken();
  const now = ctx.clock.now();
  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: sha256Hex(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.sessionTtlDays * 86_400_000),
    githubTokenSealed: githubToken ? sealGithubToken(token, githubToken) : null,
  });
  return token;
}

export async function revokeSession(ctx: AppContext, sessionId: number): Promise<void> {
  await ctx.db.update(sessions).set({ revokedAt: ctx.clock.now() }).where(eq(sessions.id, sessionId));
}

/** Role a user must hold given instance config: configured admin handles, else the first user. */
async function bootstrapRole(ctx: AppContext, q: Queryable, handle: string): Promise<Role | null> {
  if (ctx.config.adminHandles.length > 0) return ctx.config.adminHandles.includes(handle) ? "admin" : null;
  const [{ n } = { n: "0" }] = await rows<{ n: string }>(q, sql`SELECT count(*)::text AS n FROM users`);
  return n === "0" ? "admin" : null;
}

export interface GithubIdentity {
  id: number;
  login: string;
  email: string | null;
  avatarUrl: string | null;
}

async function freeHandle(q: Queryable, wanted: string): Promise<string> {
  const base = wanted.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 39) || "user";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 39 - String(i).length - 1)}-${i}`;
    const [hit] = await q.select({ id: users.id }).from(users).where(eq(users.handle, candidate));
    if (!hit) return candidate;
  }
  throw new Problem("internal", "could not allocate a handle");
}

/** Finds or creates the user for a login. Serialised so "first user is admin" has one winner. */
export async function upsertUser(ctx: AppContext, by: { handle: string } | { github: GithubIdentity }): Promise<UserRow> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4711002)`);
    const now = ctx.clock.now();
    let user: UserRow | undefined;
    if ("github" in by) {
      const g = by.github;
      [user] = await tx.select().from(users).where(eq(users.githubId, g.id));
      if (user) {
        [user] = await tx.update(users).set({ githubLogin: g.login, email: g.email ?? user.email, avatarUrl: g.avatarUrl }).where(eq(users.id, user.id)).returning();
      } else {
        const handle = await freeHandle(tx, g.login);
        const role = (await bootstrapRole(ctx, tx, handle)) ?? "donor";
        [user] = await tx.insert(users).values({ handle, githubId: g.id, githubLogin: g.login, email: g.email, avatarUrl: g.avatarUrl, role, createdAt: now }).returning();
      }
    } else {
      [user] = await tx.select().from(users).where(eq(users.handle, by.handle));
      if (!user) {
        const role = (await bootstrapRole(ctx, tx, by.handle)) ?? "donor";
        [user] = await tx.insert(users).values({ handle: by.handle, role, createdAt: now }).returning();
      }
    }
    if (!user) throw new Problem("internal", "user upsert failed");
    if (ctx.config.adminHandles.includes(user.handle) && user.role !== "admin") {
      [user] = await tx.update(users).set({ role: "admin" }).where(eq(users.id, user.id)).returning();
    }
    if (!user) throw new Problem("internal", "user upsert failed");
    if (user.banned) throw new Problem("banned", "This account is banned on this instance.");
    return user;
  });
}

export async function userByHandle(q: Queryable, handle: string): Promise<UserRow | undefined> {
  const [u] = await q.select().from(users).where(eq(users.handle, handle));
  return u;
}

/* ---- API keys ---- */

type KeyRow = typeof apiKeys.$inferSelect;
export const toApiKey = (k: KeyRow): Schemas["ApiKey"] => ({
  id: k.publicId,
  label: k.label,
  prefix: k.prefix,
  created_at: iso(k.createdAt),
  last_used_at: isoOrNull(k.lastUsedAt),
  revoked_at: isoOrNull(k.revokedAt),
});

export async function createApiKey(ctx: AppContext, userId: number, label: string): Promise<{ row: KeyRow; secret: string }> {
  const secret = newApiKey();
  const [row] = await ctx.db
    .insert(apiKeys)
    .values({ publicId: newId("key"), userId, label, prefix: secret.slice(0, 10), keyHash: sha256Hex(secret), createdAt: ctx.clock.now() })
    .returning();
  if (!row) throw new Problem("internal", "key insert failed");
  return { row, secret };
}

export async function listApiKeys(ctx: AppContext, userId: number): Promise<KeyRow[]> {
  return ctx.db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(sql`${apiKeys.id} DESC`);
}

export async function revokeApiKey(ctx: AppContext, userId: number, publicId: string): Promise<boolean> {
  const [row] = await ctx.db.select().from(apiKeys).where(and(eq(apiKeys.publicId, publicId), eq(apiKeys.userId, userId)));
  if (!row) return false;
  if (!row.revokedAt) await ctx.db.update(apiKeys).set({ revokedAt: ctx.clock.now() }).where(eq(apiKeys.id, row.id));
  return true;
}

/* ---- GitHub OAuth ---- */

export function allowedRedirect(ctx: AppContext, redirect: string | undefined): string {
  const base = new URL(ctx.config.baseUrl);
  if (!redirect) return `${ctx.config.baseUrl}/`;
  let target: URL;
  try {
    target = new URL(redirect, `${ctx.config.baseUrl}/`);
  } catch {
    throw validation("/redirect", "redirect is not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw validation("/redirect", "redirect must be http(s)");
  if (target.username || target.password) throw validation("/redirect", "redirect must not carry credentials");
  if (target.origin !== base.origin && !ctx.config.webOrigins.includes(target.origin)) {
    throw validation("/redirect", "redirect origin is not allowed by this instance");
  }
  target.hash = "";
  return target.toString();
}

export async function startGithubOauth(ctx: AppContext, redirect: string | undefined): Promise<string> {
  if (!ctx.config.githubClientId || !ctx.config.githubClientSecret) throw new Problem("not-found", "GitHub login is not configured on this instance.");
  const target = allowedRedirect(ctx, redirect);
  const state = newSecret();
  const now = ctx.clock.now();
  await ctx.db.delete(oauthStates).where(sql`${oauthStates.expiresAt} < ${tsParam(now)}`);
  await ctx.db.insert(oauthStates).values({ stateHash: sha256Hex(state), redirect: target, createdAt: now, expiresAt: new Date(now.getTime() + 600_000) });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", ctx.config.githubClientId);
  url.searchParams.set("redirect_uri", `${ctx.config.baseUrl}/v1/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

const badCallback = (detail: string) => new Problem("validation", detail, { status: 400 });

export async function finishGithubOauth(ctx: AppContext, code: string | undefined, state: string | undefined): Promise<string> {
  if (!ctx.config.githubClientId || !ctx.config.githubClientSecret) throw badCallback("GitHub login is not configured on this instance.");
  if (!code || !state) throw badCallback("code and state are required");
  // One-time state: deleting it is the check.
  const [saved] = await ctx.db.delete(oauthStates).where(eq(oauthStates.stateHash, sha256Hex(state))).returning();
  if (!saved || saved.expiresAt.getTime() <= ctx.clock.now().getTime()) throw badCallback("OAuth state is unknown or expired; start again.");

  const tokenRes = await ctx.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agentfund-server" },
    body: JSON.stringify({ client_id: ctx.config.githubClientId, client_secret: ctx.config.githubClientSecret, code, redirect_uri: `${ctx.config.baseUrl}/v1/auth/github/callback` }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown };
  if (!tokenRes.ok || typeof tokenBody.access_token !== "string") throw badCallback("GitHub rejected the authorization code.");
  const gh = { accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.access_token}`, "x-github-api-version": "2026-03-10", "user-agent": "agentfund-server" };

  const userRes = await ctx.fetch("https://api.github.com/user", { headers: gh, signal: AbortSignal.timeout(15_000) });
  const profile = (await userRes.json().catch(() => ({}))) as { id?: unknown; login?: unknown; email?: unknown; avatar_url?: unknown };
  if (!userRes.ok || typeof profile.id !== "number" || typeof profile.login !== "string") throw badCallback("Could not read the GitHub profile.");
  let email = typeof profile.email === "string" ? profile.email : null;
  if (!email) {
    const emailsRes = await ctx.fetch("https://api.github.com/user/emails", { headers: gh, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const emails: unknown = emailsRes?.ok ? await emailsRes.json().catch(() => []) : [];
    if (Array.isArray(emails)) {
      const primary = (emails as { email?: unknown; primary?: unknown; verified?: unknown }[]).find((e) => e.primary === true && e.verified === true);
      if (primary && typeof primary.email === "string") email = primary.email;
    }
  }
  if (!(await isMemberLogin(ctx, profile.login))) throw new Problem("forbidden", `This instance is for members of ${ctx.config.allowedGithubOrgs.join(", ")} on GitHub.`);
  const user = await upsertUser(ctx, { github: { id: profile.id, login: profile.login, email, avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url : null } });
  // The token (read:user user:email) stays sealed on the session, for the push check at registration.
  const session = await createSession(ctx, user.id, tokenBody.access_token);
  const target = new URL(saved.redirect);
  target.hash = `token=${session}`;
  return target.toString();
}

/* ---- admin ---- */

export async function listUsers(ctx: AppContext, opts: { q?: string; limit: number; cursor?: string }): Promise<{ items: Schemas["Me"][]; next_cursor: string | null }> {
  const c = decodeCursor(opts.cursor);
  if (c && (typeof c.i !== "number" || !Number.isSafeInteger(c.i))) throw validation("/cursor", "cursor is not valid");
  const like = opts.q ? `%${opts.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const list = await ctx.db
    .select()
    .from(users)
    .where(and(c ? sql`${users.id} > ${c.i as number}` : undefined, like ? sql`(${users.handle} LIKE ${like} OR lower(coalesce(${users.githubLogin}, '')) LIKE ${like} OR lower(coalesce(${users.email}, '')) LIKE ${like})` : undefined))
    .orderBy(users.id)
    .limit(opts.limit + 1);
  const more = list.length > opts.limit;
  const items = more ? list.slice(0, opts.limit) : list;
  return { items: items.map((u) => toMe(ctx, u)), next_cursor: more ? encodeCursor({ i: items[items.length - 1]!.id }) : null };
}

export async function updateUser(ctx: AppContext, actor: UserRow, handle: string, patch: { role?: Role; banned?: boolean }): Promise<UserRow> {
  const target = await userByHandle(ctx.db, handle);
  if (!target) throw new Problem("not-found", `No user ${handle}.`);
  if (target.id === actor.id && (patch.banned === true || (patch.role !== undefined && patch.role !== "admin"))) {
    throw validation("/", "admins cannot ban or demote themselves");
  }
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.banned !== undefined) set.banned = patch.banned;
  if (Object.keys(set).length === 0) return target;
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.update(users).set(set).where(eq(users.id, target.id)).returning();
    if (!row) throw new Problem("not-found", `No user ${handle}.`);
    if (patch.banned === true) {
      await tx.update(sessions).set({ revokedAt: ctx.clock.now() }).where(and(eq(sessions.userId, row.id), isNull(sessions.revokedAt)));
    }
    return row;
  });
}
