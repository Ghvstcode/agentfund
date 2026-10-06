# The handful of things you will want to run. `make` lists them.
# Each target is a thin wrapper; the command it runs is the documentation.

.DEFAULT_GOAL := help
.PHONY: help demo demo-manual demo-down dev up build test e2e check assets recording

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  make %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

demo: ## The whole loop on your machine, zero tokens: instance + signed project + a worker run
	@sh scripts/demo.sh

demo-manual: ## Same instance, but you type the worker commands yourself
	@sh scripts/demo.sh --manual

demo-down: ## Clean up after a demo that was killed rather than Ctrl-C'd
	@sh scripts/demo.sh down

dev: ## Web UI on :5173 against the built-in mock API (no Docker, no Postgres)
	pnpm install
	pnpm --filter web dev:mock

up: ## A real instance from source: API + UI + Postgres on http://localhost:8787
	docker compose up --build

build: ## Build server, web and the worker binary (worker/bin/agentfund)
	pnpm install
	pnpm -r build
	$(MAKE) -C worker build

test: ## Unit tests for every package (server tests need Docker for Postgres)
	pnpm install
	pnpm spec:check
	pnpm --filter server test
	pnpm --filter web test
	cd worker && go test ./...
	cd images/egress-proxy && cargo test --locked

e2e: ## Full acceptance loop against a mock agent: claim → sandbox → PR → CI → ledger
	sh scripts/e2e.sh

check: ## What a docs or spec change needs: schemas, OpenAPI lint, links, CLI references
	pnpm spec:check
	sh scripts/check-docs.sh

assets: ## Re-render README stills: hero, social preview, screenshots, diagrams
	python3 scripts/readme-diagrams.py
	node scripts/readme-brand.mjs
	node scripts/readme-shots.mjs
	sh scripts/build-assets.sh stills

recording: ## Re-record the README terminal GIF and the live page GIFs (needs vhs)
	sh scripts/record-demo.sh
