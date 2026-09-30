# ============================================================================
# enginos-billing — prepaid credit billing (Chargebee · ClickHouse · LiteLLM)
# Run `make` or `make help` to see all targets.
# Makefile Standard: v2.1 (enwithai-release-management/docs/makefile-standard-v2.md)
# ============================================================================

SHELL := /bin/bash
.DELETE_ON_ERROR:
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

APP_NAME     := enginos-billing
REGISTRY     ?= ghcr.io/enwithai
IMAGE_NAME   ?= $(REGISTRY)/$(APP_NAME)
IMAGE_TAG    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo latest)
# The API's port is fixed in package.json (`next dev --port 4300`); it is here
# only so `make dev` can tell whether something already holds it.
API_PORT     := 4300
STUDIO_PORT  ?= 5555
VERBOSE      ?=

ifdef VERBOSE
  Q :=
else
  Q := @
endif

# ── Help ─────────────────────────────────────────────────────
.PHONY: help
help: ## Show this help
	@printf "\n\033[1m$(APP_NAME)\033[0m — available targets:\n\n"
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##"}; { \
			if ($$2 ~ /^@/) { printf "\n\033[1;33m  %s\033[0m\n", substr($$2, 2) } \
			else { printf "  \033[36m%-28s\033[0m %s\n", $$1, $$2 } \
		}'
	@printf "\n"

# ── Doctor ───────────────────────────────────────────────────
.PHONY: doctor
doctor: ## Verify dev prerequisites
	@printf "Checking prerequisites...\n"
	@command -v node >/dev/null 2>&1 && printf "  node:         %s\n" "$$(node --version)" || printf "  node:         \033[31mNOT FOUND\033[0m\n"
	@command -v npm >/dev/null 2>&1 && printf "  npm:          %s\n" "$$(npm --version)" || printf "  npm:          \033[31mNOT FOUND\033[0m\n"
	@test -d node_modules && printf "  node_modules: ✓\n" || printf "  node_modules: \033[33mMISSING (run make setup)\033[0m\n"
	@test -f .env && printf "  .env:         ✓\n" || printf "  .env:         \033[33mMISSING (run make env, then fill it in)\033[0m\n"
	@(exec 3<>/dev/tcp/127.0.0.1/6432) 2>/dev/null && printf "  PgBouncer:    :6432 ✓\n" || printf "  PgBouncer:    \033[33m:6432 not reachable (release-management: make run-local)\033[0m\n"

_setup: ##@ Setup

# ── Setup ────────────────────────────────────────────────────
.PHONY: install env setup prisma-generate

install: ## Install dependencies (npm ci)
	$(Q)npm ci

env: ## Create .env from .env.example (no-op if it exists)
	$(Q)test -f .env || { cp .env.example .env && echo ".env created from .env.example — fill in the secrets"; }

prisma-generate: ## Generate the Prisma client
	$(Q)npx prisma generate

setup: install env prisma-generate ## Full first-time setup (install + .env + Prisma client)

_dev: ##@ Development

# ── Development ──────────────────────────────────────────────
.PHONY: dev dev-api dev-worker db-studio

# All three in one terminal, each line tagged with its process. Ctrl-C stops
# all three (the trap takes the whole group down). Refuses to start while the
# API's or Studio's port is taken — usually a copy already running by hand.
dev: ## Run the API (:4300), the worker and Prisma Studio (:5555) together — Ctrl-C stops all
	$(Q)for p in $(API_PORT) $(STUDIO_PORT); do \
		if lsof -nP -iTCP:$$p -sTCP:LISTEN >/dev/null 2>&1; then \
			echo "✗ Port $$p is already in use ($$(lsof -nP -iTCP:$$p -sTCP:LISTEN | awk 'NR==2{print $$1" pid "$$2}')). Stop it first."; exit 1; \
		fi; \
	done
	$(Q)if pgrep -f "worker/hatchet-worker" >/dev/null 2>&1; then \
		echo "! A billing worker is already running (pid $$(pgrep -f 'worker/hatchet-worker' | head -1)). Two are safe but do the work twice — stop it if it is not meant to run."; \
	fi
	@printf "\033[1mStarting\033[0m API http://localhost:$(API_PORT) · worker · Prisma Studio http://localhost:$(STUDIO_PORT)  (Ctrl-C stops all)\n"
	$(Q)trap 'kill 0' INT TERM; \
		( npm run dev 2>&1 | awk '{ print "[api]    " $$0; fflush() }' ) & \
		( npm run worker 2>&1 | awk '{ print "[worker] " $$0; fflush() }' ) & \
		( npx prisma studio --browser none --port $(STUDIO_PORT) 2>&1 | awk '{ print "[studio] " $$0; fflush() }' ) & \
		wait

dev-api: ## Run only the API on :4300 (webhooks + internal routes)
	$(Q)npm run dev

dev-worker: ## Run only the Hatchet worker (usage sync, activations, daily resync)
	$(Q)npm run worker

db-studio: ## Open Prisma Studio on :5555 — billing's three tables only
	$(Q)npx prisma studio --port $(STUDIO_PORT)

_db: ##@ Database

# ── Database ─────────────────────────────────────────────────
.PHONY: db-migrate db-status

# `migrate deploy`, NEVER `migrate dev`: two migrations carry partial unique
# indexes Prisma's schema language cannot express, and `migrate dev` drops them
# as drift. Runs as DATABASE_DIRECT_URL's role (enginos_owner) — the app role
# cannot create tables.
db-migrate: ## Apply migrations (prisma migrate deploy — never migrate dev)
	$(Q)npx prisma migrate deploy

db-status: ## Show which migrations are applied
	$(Q)npx prisma migrate status

_quality: ##@ Build & quality

# ── Build & quality ──────────────────────────────────────────
.PHONY: build test test-watch typecheck lint format format-check check

build: ## Production build of the API (next build)
	$(Q)npm run build

test: ## Unit tests (vitest; no external services)
	$(Q)npm test

test-watch: ## Unit tests in watch mode
	$(Q)npm run test:watch

typecheck: ## Type-check (tsc --noEmit)
	$(Q)npm run typecheck

lint: ## No linter is configured in this repo yet
	@echo "No linter configured for $(APP_NAME) (no ESLint config yet)."

format: ## No formatter is configured in this repo yet
	@echo "No formatter configured for $(APP_NAME) (no Prettier config yet)."

format-check: ## No formatter is configured in this repo yet
	@echo "No formatter configured for $(APP_NAME) (no Prettier config yet)."

check: lint format-check typecheck test ## CI gate: lint + format-check + typecheck + test

_docker: ##@ Docker & CI

# ── Docker & CI ──────────────────────────────────────────────
.PHONY: docker-build docker-push security-scan ci

docker-build: ## No Dockerfile in this repo yet
	@echo "No Dockerfile for $(APP_NAME) yet — nothing to build."

docker-push: ## No Dockerfile in this repo yet
	@echo "No Dockerfile for $(APP_NAME) yet — nothing to push."

security-scan: ## Audit dependencies (npm audit, high and above)
	$(Q)npm audit --audit-level=high

ci: check docker-build security-scan ## Full CI: check + docker-build + security-scan

_clean: ##@ Clean

# ── Clean ────────────────────────────────────────────────────
.PHONY: clean clean-all vars

clean: ## Remove build artifacts (.next, tsbuildinfo)
	$(Q)rm -rf .next tsconfig.tsbuildinfo

clean-all: clean ## Remove build artifacts AND node_modules
	$(Q)rm -rf node_modules

vars: ## Print current variable values
	@printf "APP_NAME=%s\nIMAGE_NAME=%s\nIMAGE_TAG=%s\nAPI_PORT=%s\nSTUDIO_PORT=%s\n" \
		"$(APP_NAME)" "$(IMAGE_NAME)" "$(IMAGE_TAG)" "$(API_PORT)" "$(STUDIO_PORT)"
