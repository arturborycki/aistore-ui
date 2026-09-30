# AIStor Catalog UI — developer entry points.
SHELL := /bin/bash
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE ?= aistor-catalog-ui:$(VERSION)
DOCKER_BUILD_FLAGS ?=

.PHONY: help
help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: deps
deps: ## Install frontend and e2e dependencies
	cd frontend && npm ci
	cd e2e && npm ci

.PHONY: web
web: ## Build the SPA and stage it for embedding
	cd frontend && npm run build
	rm -rf backend/internal/web/dist/assets backend/internal/web/dist/index.html
	cp -r frontend/dist/. backend/internal/web/dist/

.PHONY: build
build: web ## Build the server binary (with embedded SPA) into backend/bin
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/aistor-ui ./cmd/aistor-ui
	cd backend && go build -o bin/aistor-testserver ./cmd/aistor-testserver

.PHONY: test
test: ## Unit and integration tests (Go + frontend)
	cd backend && go vet ./... && go test -race ./...
	cd frontend && npm run lint && npm run typecheck && npm test

.PHONY: e2e
e2e: build ## Browser tests against the in-memory AIStor test server
	@set -e; \
	backend/bin/aistor-testserver -addr 127.0.0.1:9000 & ts=$$!; \
	backend/bin/aistor-ui -config deploy/dev/config.local.yaml & ui=$$!; \
	trap "kill $$ts $$ui" EXIT; sleep 1; \
	cd e2e && npx playwright test

.PHONY: e2e-live
e2e-live: ## Read-only UI walk against a running UI and real AIStor (LIVE_ACCESS_KEY, LIVE_SECRET_KEY, LIVE_CLUSTER, E2E_BASE_URL)
	cd e2e && npx playwright test -c live/playwright.config.ts

.PHONY: e2e-live-write
e2e-live-write: ## UI write tests on new uitest_* tables in a scratch namespace of a real AIStor (needs LIVE_PYTHON with pyiceberg), then clean up
	cd e2e && npx playwright test -c live/playwright.config.ts write.spec.ts; live/cleanup.sh

.PHONY: dev
dev: ## Run test server + backend + Vite dev server (http://localhost:5173)
	@cd backend && go build -o bin/aistor-testserver ./cmd/aistor-testserver
	@set -e; \
	backend/bin/aistor-testserver & ts=$$!; \
	(cd backend && go run ./cmd/aistor-ui -config ../deploy/dev/config.local.yaml) & ui=$$!; \
	trap "kill $$ts $$ui" EXIT; \
	cd frontend && npm run dev

.PHONY: image
image: ## Build the container image
	docker build $(DOCKER_BUILD_FLAGS) --build-arg VERSION=$(VERSION) -t $(IMAGE) .

.PHONY: compose-env
compose-env: ## Generate deploy/compose/.env with random secrets
	@test ! -f deploy/compose/.env || (echo "deploy/compose/.env already exists" && exit 1)
	@sed -e "s|^AISTOR_ROOT_PASSWORD=.*|AISTOR_ROOT_PASSWORD=$$(openssl rand -hex 16)|" \
	     -e "s|^KEYCLOAK_ADMIN_PASSWORD=.*|KEYCLOAK_ADMIN_PASSWORD=$$(openssl rand -hex 12)|" \
	     -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$$(openssl rand -hex 16)|" \
	     -e "s|^AISTOR_UI_SESSION_KEY=.*|AISTOR_UI_SESSION_KEY=$$(openssl rand -base64 32)|" \
	     -e "s|^AISTOR_UI_OIDC_CLIENT_SECRET=.*|AISTOR_UI_OIDC_CLIENT_SECRET=$$(openssl rand -hex 24)|" \
	     -e "s|^DEMO_ALICE_PASSWORD=.*|DEMO_ALICE_PASSWORD=$$(openssl rand -hex 6)|" \
	     -e "s|^DEMO_BOB_PASSWORD=.*|DEMO_BOB_PASSWORD=$$(openssl rand -hex 6)|" \
	     deploy/compose/.env.example > deploy/compose/.env
	@chmod 600 deploy/compose/.env
	@echo "Wrote deploy/compose/.env — set AISTOR_LICENSE, then: make up"

.PHONY: up
up: ## Start the full compose stack (AIStor + Keycloak + Redis + UI)
	docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d --build

.PHONY: down
down: ## Stop the compose stack
	docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env down
