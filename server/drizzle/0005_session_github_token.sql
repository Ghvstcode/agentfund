-- The GitHub sign-in token, kept so registration can ask GitHub whether the maintainer can push
-- to the repository. Sealed with AES-GCM under a key derived from the session token, which the
-- database holds only as a hash: a copy of the database alone cannot open it. Sessions from
-- before this migration have none; their users sign in again to register a project.
ALTER TABLE "sessions" ADD COLUMN "github_token_sealed" text;
