-- LedgerEntry.delivery: for `report` lines, where the report currently sits. Appended as the
-- last column so the view can be replaced in place.
CREATE OR REPLACE VIEW ledger_entries AS
SELECT p.public_id AS id, 'pledge'::text AS type, p.created_at AS at, p.user_id, p.project_id,
       p.token_amount AS tokens, NULL::bigint AS manifest_id, NULL::text AS report_status,
       NULL::text AS pr_url, NULL::text AS ci_run_url, NULL::text AS branch, NULL::text AS head_sha,
       false AS flagged_late, NULL::text AS delivery
  FROM pledges p
UNION ALL
SELECT r.public_id, 'report', r.created_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha,
       r.flagged_late, r.delivery
  FROM reports r
UNION ALL
SELECT c.public_id || '-burn', 'report', b.created_at, b.user_id, b.project_id,
       b.tokens_in + b.tokens_out, b.manifest_id, 'released', NULL, NULL, NULL, NULL, false, NULL
  FROM burns b JOIN claims c ON c.id = b.claim_id
UNION ALL
SELECT r.public_id || '-delivery', 'delivery', r.delivered_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha, false, NULL
  FROM reports r WHERE r.delivered_at IS NOT NULL
UNION ALL
SELECT r.public_id || '-merge', 'merge', r.merged_at, r.user_id, r.project_id,
       r.tokens_in + r.tokens_out, r.manifest_id, r.status, r.pr_url, r.ci_run_url, r.branch, r.head_sha, false, NULL
  FROM reports r WHERE r.merged_at IS NOT NULL;
