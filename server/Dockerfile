# syntax=docker/dockerfile:1.7
# Build from the monorepo root:  docker build -f server/Dockerfile -t ghcr.io/ghvstcode/agentfund .
# One image serves the API and the built web UI.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

# ---- server dependencies (cached until the lockfile or server/package.json changes) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter ./server...

FROM deps AS server-build
COPY spec ./spec
COPY server ./server
RUN pnpm --filter ./server build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter ./server...

# ---- web UI ----
# WEB_BUILD=auto      build web/ when it has a build script; fall back to the API-only
#                     placeholder page if it is missing or does not build yet (default)
# WEB_BUILD=required  fail the image build when the web UI cannot be built (use for releases)
# WEB_BUILD=skip      never build it
FROM base AS web-build
ARG WEB_BUILD=auto
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store <<'SH'
set -eu
mkdir -p /web-dist
if [ "$WEB_BUILD" = "skip" ]; then
  echo "web: skipped (WEB_BUILD=skip)"; exit 0
fi
if [ ! -f web/package.json ] || ! grep -q '"build"' web/package.json; then
  if [ "$WEB_BUILD" = "required" ]; then echo "web: web/package.json has no build script" >&2; exit 1; fi
  echo "web: no buildable web/ package yet; the image will serve the API-only placeholder"; exit 0
fi
if (pnpm install --frozen-lockfile --filter ./web... || pnpm install --no-frozen-lockfile --filter ./web...) \
   && pnpm --filter ./web build && [ -f web/dist/index.html ]; then
  cp -R web/dist/. /web-dist/
  echo "web: built"
elif [ "$WEB_BUILD" = "required" ]; then
  echo "web: build failed" >&2; exit 1
else
  echo "web: BUILD FAILED; the image will serve the API-only placeholder" >&2
fi
SH

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data WEB_DIST=/app/web
WORKDIR /app/server
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/server/node_modules /app/server/node_modules
COPY --from=server-build /repo/server/dist ./dist
COPY --from=server-build /repo/server/spec ./spec
COPY server/drizzle ./drizzle
COPY server/package.json ./package.json
COPY --from=web-build /web-dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
