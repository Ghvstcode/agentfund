import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tokens = (name: string) => bigint(name, { mode: "number" });
const id = () => bigserial("id", { mode: "number" }).primaryKey();

/** The instance's own row (id = 1): identity, generated secrets and admin-editable config. */
export const instances = pgTable("instances", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  baseUrl: text("base_url").notNull(),
  pubkey: text("pubkey").notNull(),
  secretKey: text("secret_key").notNull(),
  projectCreation: text("project_creation").notNull().default("open"),
  leaseSeconds: integer("lease_seconds").notNull().default(7200),
  newProjectMaxTokensPerTask: tokens("new_project_max_tokens_per_task").notNull().default(5_000_000),
  newProjectMaxTokensPerDay: tokens("new_project_max_tokens_per_day").notNull().default(25_000_000),
  establishedAfterMergedTasks: integer("established_after_merged_tasks").notNull().default(3),
  maxActiveClaimsPerDonor: integer("max_active_claims_per_donor").notNull().default(3),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    handle: text("handle").notNull(),
    githubId: bigint("github_id", { mode: "number" }),
    githubLogin: text("github_login"),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    role: text("role").notNull().default("donor"),
    banned: boolean("banned").notNull().default(false),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_handle_key").on(t.handle), uniqueIndex("users_github_id_key").on(t.githubId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_hash_key").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    publicId: text("public_id").notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    label: text("label").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_public_id_key").on(t.publicId), uniqueIndex("api_keys_key_hash_key").on(t.keyHash), index("api_keys_user_idx").on(t.userId)],
);

export const oauthStates = pgTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  redirect: text("redirect").notNull(),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    repoUrl: text("repo_url").notNull(),
    /** Lower-cased repo URL without `.git`, the uniqueness and webhook-matching key. */
    repoKey: text("repo_key").notNull(),
    homepage: text("homepage"),
    language: text("language"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    ciProvider: text("ci_provider").notNull(),
    baseBranch: text("base_branch").notNull().default("main"),
    followBranch: boolean("follow_branch").notNull().default(true),
    maintainerId: bigint("maintainer_id", { mode: "number" }).notNull().references(() => users.id),
    /** Registered maintainer key; only ever changes through a valid rotation chain. */
    pubkey: text("pubkey").notNull(),
    pinnedCommit: text("pinned_commit").notNull(),
    lockSha256: text("lock_sha256"),
    tokenGoal: tokens("token_goal").notNull(),
    createdAt: ts("created_at").notNull(),
    lastIndexedAt: ts("last_indexed_at"),
    /**
     * When the base branch was last read and verified without error (taken before the fetch). The
     * dependency gate compares merges with it; lastIndexedAt also counts failed attempts.
     */
    branchReadAt: ts("branch_read_at"),
    indexError: text("index_error"),
    indexErrorKey: text("index_error_key"),
    /** Per-project HMAC secret for /v1/webhooks/ci. Shared secret, so stored as-is; never in public responses. */
    webhookSecret: text("webhook_secret").notNull(),
  },
  (t) => [
    uniqueIndex("projects_slug_key").on(t.slug),
    uniqueIndex("projects_repo_key_live").on(t.repoKey).where(sql`status <> 'removed'`),
    index("projects_status_idx").on(t.status),
    index("projects_maintainer_idx").on(t.maintainerId),
  ],
);

/** One row per task manifest; carries the task state machine (protocol.md §4). */
export const manifests = pgTable(
  "manifests",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    manifestId: text("manifest_id").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    contentHash: text("content_hash").notNull(),
    commit: text("commit").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    maxTokens: tokens("max_tokens").notNull(),
    dependsOn: text("depends_on").array().notNull().default(sql`'{}'::text[]`),
    state: text("state").notNull().default("open"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("manifests_project_manifest_key").on(t.projectId, t.manifestId), index("manifests_project_state_idx").on(t.projectId, t.state)],
);

export const pledges = pgTable(
  "pledges",
  {
    id: id(),
    publicId: text("public_id").notNull(),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    tokenAmount: tokens("token_amount").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("pledges_public_id_key").on(t.publicId), index("pledges_project_idx").on(t.projectId), index("pledges_user_idx").on(t.userId)],
);

export const claims = pgTable(
  "claims",
  {
    id: id(),
    publicId: text("public_id").notNull(),
    manifestId: bigint("manifest_id", { mode: "number" }).notNull().references(() => manifests.id),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    apiKeyId: bigint("api_key_id", { mode: "number" }).references(() => apiKeys.id),
    status: text("status").notNull().default("active"),
    /** Snapshot of what was granted: the claim continues against these even if the pin moves. */
    commit: text("commit").notNull(),
    contentHash: text("content_hash").notNull(),
    maxTokens: tokens("max_tokens").notNull(),
    leaseSeconds: integer("lease_seconds").notNull(),
    claimedAt: ts("claimed_at").notNull(),
    leaseExpiresAt: ts("lease_expires_at").notNull(),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    tokensIn: tokens("tokens_in").notNull().default(0),
    tokensOut: tokens("tokens_out").notNull().default(0),
    phase: text("phase"),
    endedAt: ts("ended_at"),
  },
  (t) => [
    uniqueIndex("claims_public_id_key").on(t.publicId),
    uniqueIndex("claims_one_active_per_manifest").on(t.manifestId).where(sql`status = 'active'`),
    index("claims_active_lease_idx").on(t.leaseExpiresAt).where(sql`status = 'active'`),
    index("claims_user_idx").on(t.userId, t.claimedAt),
    index("claims_project_idx").on(t.projectId, t.claimedAt),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: id(),
    publicId: text("public_id").notNull(),
    claimId: bigint("claim_id", { mode: "number" }).notNull().references(() => claims.id),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    manifestId: bigint("manifest_id", { mode: "number" }).notNull().references(() => manifests.id),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    status: text("status").notNull(),
    tokensIn: tokens("tokens_in").notNull(),
    tokensOut: tokens("tokens_out").notNull(),
    costEstimate: doublePrecision("cost_estimate").notNull(),
    branch: text("branch"),
    prUrl: text("pr_url"),
    headSha: text("head_sha"),
    verifyExitCode: integer("verify_exit_code"),
    logDigest: text("log_digest").notNull(),
    durationSeconds: integer("duration_seconds"),
    runner: text("runner"),
    model: text("model"),
    message: text("message"),
    flaggedLate: boolean("flagged_late").notNull().default(false),
    delivery: text("delivery").notNull().default("none"),
    deliveredAt: ts("delivered_at"),
    mergedAt: ts("merged_at"),
    closedAt: ts("closed_at"),
    ciProvider: text("ci_provider"),
    ciConclusion: text("ci_conclusion"),
    ciRunUrl: text("ci_run_url"),
    ciReceivedAt: ts("ci_received_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("reports_public_id_key").on(t.publicId),
    uniqueIndex("reports_claim_key").on(t.claimId),
    index("reports_project_idx").on(t.projectId, t.createdAt),
    index("reports_user_idx").on(t.userId, t.createdAt),
    index("reports_manifest_idx").on(t.manifestId, t.createdAt),
    index("reports_branch_idx").on(t.projectId, t.branch),
    index("reports_delivery_idx").on(t.delivery).where(sql`delivery in ('pending_ci','delivered')`),
    index("reports_delivered_at_idx").on(t.deliveredAt).where(sql`delivered_at is not null`),
  ],
);

/** Tokens burned before a voluntary release: counted as reported, never anything else. */
export const burns = pgTable(
  "burns",
  {
    id: id(),
    claimId: bigint("claim_id", { mode: "number" }).notNull().references(() => claims.id),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    manifestId: bigint("manifest_id", { mode: "number" }).notNull().references(() => manifests.id),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    tokensIn: tokens("tokens_in").notNull(),
    tokensOut: tokens("tokens_out").notNull(),
    reason: text("reason"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("burns_claim_key").on(t.claimId), index("burns_project_idx").on(t.projectId), index("burns_user_idx").on(t.userId), index("burns_manifest_idx").on(t.manifestId)],
);

/** Every piece of CI / PR evidence received, matched or not; latest state per run key. */
export const ciResults = pgTable(
  "ci_results",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" }).notNull().references(() => projects.id),
    reportId: bigint("report_id", { mode: "number" }).references(() => reports.id),
    provider: text("provider").notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    runKey: text("run_key").notNull(),
    branch: text("branch"),
    headSha: text("head_sha"),
    conclusion: text("conclusion").notNull(),
    runUrl: text("run_url"),
    prUrl: text("pr_url"),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [uniqueIndex("ci_results_run_key").on(t.projectId, t.runKey), index("ci_results_sha_idx").on(t.projectId, t.headSha), index("ci_results_report_idx").on(t.reportId)],
);

/** Append-only audit log. A trigger (see the custom migration) rejects UPDATE, DELETE and TRUNCATE. */
export const events = pgTable(
  "events",
  {
    id: id(),
    publicId: text("public_id").notNull(),
    at: ts("at").notNull(),
    actor: text("actor"),
    action: text("action").notNull(),
    projectId: bigint("project_id", { mode: "number" }),
    project: text("project"),
    taskId: text("task_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    public: boolean("public").notNull().default(true),
  },
  (t) => [uniqueIndex("events_public_id_key").on(t.publicId), index("events_project_idx").on(t.projectId, t.id), index("events_action_idx").on(t.action, t.id)],
);
