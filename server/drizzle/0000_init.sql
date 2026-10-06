CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "burns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"claim_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"manifest_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"tokens_in" bigint NOT NULL,
	"tokens_out" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" bigint NOT NULL,
	"report_id" bigint,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"run_key" text NOT NULL,
	"branch" text,
	"head_sha" text,
	"conclusion" text NOT NULL,
	"run_url" text,
	"pr_url" text,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"manifest_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"api_key_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"commit" text NOT NULL,
	"content_hash" text NOT NULL,
	"max_tokens" bigint NOT NULL,
	"lease_seconds" integer NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"phase" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"project_id" bigint,
	"project" text,
	"task_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_url" text NOT NULL,
	"pubkey" text NOT NULL,
	"secret_key" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"project_creation" text DEFAULT 'open' NOT NULL,
	"lease_seconds" integer DEFAULT 7200 NOT NULL,
	"new_project_max_tokens_per_task" bigint DEFAULT 5000000 NOT NULL,
	"new_project_max_tokens_per_day" bigint DEFAULT 25000000 NOT NULL,
	"established_after_merged_tasks" integer DEFAULT 3 NOT NULL,
	"max_active_claims_per_donor" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manifests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" bigint NOT NULL,
	"manifest_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"commit" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"max_tokens" bigint NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"redirect" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pledges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"token_amount" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"repo_url" text NOT NULL,
	"repo_key" text NOT NULL,
	"homepage" text,
	"language" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ci_provider" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"follow_branch" boolean DEFAULT true NOT NULL,
	"maintainer_id" bigint NOT NULL,
	"pubkey" text NOT NULL,
	"pinned_commit" text NOT NULL,
	"lock_sha256" text,
	"token_goal" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"index_error" text,
	"index_error_key" text
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"claim_id" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"manifest_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" text NOT NULL,
	"tokens_in" bigint NOT NULL,
	"tokens_out" bigint NOT NULL,
	"cost_estimate" double precision NOT NULL,
	"branch" text,
	"pr_url" text,
	"head_sha" text,
	"verify_exit_code" integer,
	"log_digest" text NOT NULL,
	"duration_seconds" integer,
	"runner" text,
	"model" text,
	"message" text,
	"flagged_late" boolean DEFAULT false NOT NULL,
	"delivery" text DEFAULT 'none' NOT NULL,
	"delivered_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"ci_provider" text,
	"ci_conclusion" text,
	"ci_run_url" text,
	"ci_received_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"github_id" bigint,
	"github_login" text,
	"email" text,
	"avatar_url" text,
	"role" text DEFAULT 'donor' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_manifest_id_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_results" ADD CONSTRAINT "ci_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_results" ADD CONSTRAINT "ci_results_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_manifest_id_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_maintainer_id_users_id_fk" FOREIGN KEY ("maintainer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_manifest_id_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_public_id_key" ON "api_keys" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "burns_claim_key" ON "burns" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "burns_project_idx" ON "burns" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "burns_user_idx" ON "burns" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "burns_manifest_idx" ON "burns" USING btree ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_results_run_key" ON "ci_results" USING btree ("project_id","run_key");--> statement-breakpoint
CREATE INDEX "ci_results_sha_idx" ON "ci_results" USING btree ("project_id","head_sha");--> statement-breakpoint
CREATE INDEX "ci_results_report_idx" ON "ci_results" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_public_id_key" ON "claims" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_active_per_manifest" ON "claims" USING btree ("manifest_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "claims_active_lease_idx" ON "claims" USING btree ("lease_expires_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "claims_user_idx" ON "claims" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE INDEX "claims_project_idx" ON "claims" USING btree ("project_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_public_id_key" ON "events" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action","id");--> statement-breakpoint
CREATE UNIQUE INDEX "manifests_project_manifest_key" ON "manifests" USING btree ("project_id","manifest_id");--> statement-breakpoint
CREATE INDEX "manifests_project_state_idx" ON "manifests" USING btree ("project_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "pledges_public_id_key" ON "pledges" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "pledges_project_idx" ON "pledges" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pledges_user_idx" ON "pledges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_repo_key_live" ON "projects" USING btree ("repo_key") WHERE status <> 'removed';--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_maintainer_idx" ON "projects" USING btree ("maintainer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_public_id_key" ON "reports" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_claim_key" ON "reports" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "reports_project_idx" ON "reports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_manifest_idx" ON "reports" USING btree ("manifest_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_branch_idx" ON "reports" USING btree ("project_id","branch");--> statement-breakpoint
CREATE INDEX "reports_delivery_idx" ON "reports" USING btree ("delivery") WHERE delivery in ('pending_ci','delivered');--> statement-breakpoint
CREATE INDEX "reports_delivered_at_idx" ON "reports" USING btree ("delivered_at") WHERE delivered_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_key" ON "users" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_id_key" ON "users" USING btree ("github_id");