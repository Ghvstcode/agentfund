-- When the base branch was last read and verified without error. A dependency unblocks its
-- dependents only once the branch was read after the dependency merged, so their claims start
-- from a commit that contains the merged work. Existing projects get the migration time: every
-- merge recorded so far counts as read, so no task that is claimable today becomes blocked.
ALTER TABLE "projects" ADD COLUMN "branch_read_at" timestamp with time zone;--> statement-breakpoint
UPDATE "projects" SET "branch_read_at" = now();
