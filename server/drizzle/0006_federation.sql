CREATE TABLE "assertion_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"host" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text,
	"pubkey" text NOT NULL,
	"observed_pubkey" text,
	"status" text DEFAULT 'active' NOT NULL,
	"discover" boolean DEFAULT true NOT NULL,
	"accept_identities" boolean DEFAULT false NOT NULL,
	"accepts_us" boolean,
	"added_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "remote_projects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"peer_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"repo_url" text NOT NULL,
	"language" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text NOT NULL,
	"token_goal" bigint NOT NULL,
	"totals" jsonb NOT NULL,
	"tasks" jsonb NOT NULL,
	"delivered" bigint DEFAULT 0 NOT NULL,
	"donors" integer DEFAULT 0 NOT NULL,
	"trust_tier" text DEFAULT 'new' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_standings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"peer_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"remote_handle" text NOT NULL,
	"pledged" bigint NOT NULL,
	"reported" bigint NOT NULL,
	"delivered" bigint NOT NULL,
	"merged" bigint NOT NULL,
	"tasks_delivered" integer NOT NULL,
	"tasks_merged" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "peer_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "home_id" text;--> statement-breakpoint
ALTER TABLE "remote_projects" ADD CONSTRAINT "remote_projects_peer_id_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_standings" ADD CONSTRAINT "remote_standings_peer_id_peers_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."peers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_standings" ADD CONSTRAINT "remote_standings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "peers_host_key" ON "peers" USING btree ("host");--> statement-breakpoint
CREATE UNIQUE INDEX "peers_base_url_key" ON "peers" USING btree ("base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_projects_peer_slug_key" ON "remote_projects" USING btree ("peer_id","slug");--> statement-breakpoint
CREATE INDEX "remote_projects_rank_idx" ON "remote_projects" USING btree ("delivered","id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_standings_peer_user_key" ON "remote_standings" USING btree ("peer_id","user_id");--> statement-breakpoint
CREATE INDEX "remote_standings_user_idx" ON "remote_standings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_home_id_key" ON "users" USING btree ("home_id");--> statement-breakpoint
CREATE INDEX "users_peer_idx" ON "users" USING btree ("peer_id");