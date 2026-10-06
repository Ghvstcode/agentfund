-- Hand-written companion to 0000: guards, search and ledger views that drizzle-kit does not model.

-- 1. The audit log is append-only.
CREATE FUNCTION af_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION af_events_append_only();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION af_events_append_only();
--> statement-breakpoint

-- 2. Every appended event is announced to all API replicas (delivered on commit).
CREATE FUNCTION af_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('agentfund', json_build_object('t', 'event', 'id', NEW.id, 'p', NEW.project_id)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION af_events_notify();
--> statement-breakpoint

-- 3. State machines are closed sets.
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'maintainer', 'donor'));
--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('pending', 'active', 'paused', 'removed'));
--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT projects_ci_provider_check CHECK (ci_provider IN ('github', 'generic'));
--> statement-breakpoint
ALTER TABLE manifests ADD CONSTRAINT manifests_state_check CHECK (state IN ('open', 'claimed', 'delivered', 'merged', 'failed'));
--> statement-breakpoint
ALTER TABLE claims ADD CONSTRAINT claims_status_check CHECK (status IN ('active', 'reported', 'released', 'expired'));
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('completed', 'failed', 'verification_failed', 'budget_exceeded', 'timeout'));
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_delivery_check CHECK (delivery IN ('none', 'pending_ci', 'ci_failed', 'delivered', 'merged', 'closed'));
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_merged_implies_delivered CHECK (merged_at IS NULL OR delivered_at IS NOT NULL);
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_late_never_delivered CHECK (NOT flagged_late OR (delivered_at IS NULL AND delivery = 'none'));
--> statement-breakpoint
ALTER TABLE pledges ADD CONSTRAINT pledges_amount_check CHECK (token_amount > 0);
--> statement-breakpoint
ALTER TABLE instances ADD CONSTRAINT instances_singleton CHECK (id = 1);
--> statement-breakpoint

-- 4. Full-text search over name, tags and description.
CREATE FUNCTION af_project_search(name text, description text, tags text[]) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A')
      || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(tags, ' '), '')), 'B')
      || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
$$;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN search tsvector GENERATED ALWAYS AS (af_project_search(name, description, tags)) STORED;
--> statement-breakpoint
CREATE INDEX projects_search_idx ON projects USING gin (search);
--> statement-breakpoint
CREATE INDEX projects_tags_idx ON projects USING gin (tags);
--> statement-breakpoint

-- 5. The ledger as a view over evidence rows. Nothing here is stored twice: every line is
--    derived from a pledge, a report, a release burn, or the CI / merge timestamps on a report.
CREATE VIEW ledger_entries AS
SELECT p.public_id AS id, 'pledge'::text AS type, p.created_at AS at, p.user_id, p.project_id,
       p.token_amount AS tokens, NULL::bigint AS manifest_id, NULL::text AS report_status,
       NULL::text AS pr_url, NULL::text AS ci_run_url, NULL::text AS branch, NULL::text AS head_sha,
       false AS flagged_late
  FROM pledges p
UNION ALL
SELECT r.public_id, 'report', r.created_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha,
       r.flagged_late
  FROM reports r
UNION ALL
SELECT c.public_id || '-burn', 'report', b.created_at, b.user_id, b.project_id,
       b.tokens_in + b.tokens_out, b.manifest_id, 'released', NULL, NULL, NULL, NULL, false
  FROM burns b JOIN claims c ON c.id = b.claim_id
UNION ALL
SELECT r.public_id || '-delivery', 'delivery', r.delivered_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha, false
  FROM reports r WHERE r.delivered_at IS NOT NULL
UNION ALL
SELECT r.public_id || '-merge', 'merge', r.merged_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha, false
  FROM reports r WHERE r.merged_at IS NOT NULL;
--> statement-breakpoint

-- Per (project, donor) standing; summed over projects for the instance leaderboard.
CREATE VIEW donor_project_standings AS
SELECT project_id, user_id,
       sum(pledged)::bigint AS pledged, sum(reported)::bigint AS reported,
       sum(delivered)::bigint AS delivered, sum(merged)::bigint AS merged,
       sum(tasks_delivered)::int AS tasks_delivered, sum(tasks_merged)::int AS tasks_merged
FROM (
  SELECT project_id, user_id, sum(token_amount) AS pledged, 0 AS reported, 0 AS delivered, 0 AS merged, 0 AS tasks_delivered, 0 AS tasks_merged
    FROM pledges GROUP BY project_id, user_id
  UNION ALL
  SELECT project_id, user_id, 0,
         coalesce(sum(tokens_in + tokens_out) FILTER (WHERE NOT flagged_late), 0),
         coalesce(sum(tokens_in + tokens_out) FILTER (WHERE delivered_at IS NOT NULL), 0),
         coalesce(sum(tokens_in + tokens_out) FILTER (WHERE merged_at IS NOT NULL), 0),
         count(DISTINCT manifest_id) FILTER (WHERE delivered_at IS NOT NULL),
         count(DISTINCT manifest_id) FILTER (WHERE merged_at IS NOT NULL)
    FROM reports GROUP BY project_id, user_id
  UNION ALL
  SELECT project_id, user_id, 0, sum(tokens_in + tokens_out), 0, 0, 0, 0
    FROM burns GROUP BY project_id, user_id
) s
GROUP BY project_id, user_id;
