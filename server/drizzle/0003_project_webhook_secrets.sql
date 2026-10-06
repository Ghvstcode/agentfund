-- Per-project webhook secrets. Existing projects each get their own random secret (two v4
-- UUIDs, 244 random bits, from the built-in generator); the instance-wide generated secret
-- is gone — an operator-level secret now exists only when WEBHOOK_SECRET is set in the environment.
ALTER TABLE "projects" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
UPDATE "projects" SET "webhook_secret" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE "webhook_secret" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "webhook_secret" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "webhook_secret";
