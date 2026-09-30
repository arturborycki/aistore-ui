# AIStor Catalog UI

A multi-user, secure web UI for the **MinIO AIStor Tables** catalog (Apache Iceberg REST, `/_iceberg/v1`).

Everyone who signs in acts **as themselves**. The server exchanges each user's identity for their own short-lived AIStor STS credentials and signs every catalog request with them (SigV4, service `s3tables`). AIStor's own policies decide what each person can see and do, and AIStor's audit log shows the real user. The UI has no shared service account and adds no permissions of its own.

- **Backend**: Go backend-for-frontend (`backend/`). Handles OIDC, LDAP or access-key sign-in, encrypted server-side sessions, CSRF protection and step-up re-authentication. It forwards only a typed allow-list of AIStor Tables operations, validates every request, strips any storage credentials from responses, and keeps an audit trail and Prometheus metrics.
- **Frontend**: React 19, Vite, TypeScript, Tailwind v4 and Radix UI (`frontend/`). Includes an explorer tree, a command palette, server-side search, sort and pagination, light and dark themes, and a strict CSP.
- **Delivery**: one ~35 MB distroless, non-root container with the SPA embedded in the Go binary. The repo also ships Compose (AIStor, Keycloak, Redis) and Kubernetes manifests.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture and threat model, and [`docs/STYLE.md`](docs/STYLE.md) for the visual language.

## Status

**Phases 0–3 are complete.**

- **Sign-in and security:** SSO (OIDC), LDAP and access-key sign-in; encrypted sessions; step-up re-authentication for destructive actions; a typed allow-list covering every AIStor Tables endpoint.
- **Browse:** overview, warehouses, nested namespaces, table and view pages (preview, schema history, partitioning, snapshots, maintenance, metadata, access helper), explorer tree, command palette, activity log.
- **Manage:**
  - create tables with a schema builder (nested struct/list/map types, partition spec, sort order, format version, properties, request preview);
  - register existing tables and views;
  - create views (SQL per dialect, output schema) and publish new view versions;
  - rename/move and drop (keeping data by default);
  - properties editors for namespaces, tables and views;
  - warehouse and table **encryption**, **tags** and **maintenance** settings (warehouse defaults with per-table overrides).
- **Evolve and operate:**
  - **Schema evolution:** add (including nested), rename, widen (only allowed promotions), make optional, document, reorder and drop columns. Dropping a column the partition spec, sort order or row key still uses is blocked. A diff preview is shown before committing.
  - **Partition and sort-order evolution:** partition field IDs are reused as Iceberg requires, and v1 tables keep removed fields as `void`.
  - **Snapshots:** roll back `main`, create tags and branches with retention settings, edit retention, remove references.
  - **Format upgrade** (v2 → v3).
- **Safe concurrent editing:** every commit carries Iceberg requirements built from the metadata you were looking at. If someone else changed the table meanwhile, AIStor rejects the commit (409); nothing is overwritten, and the UI offers a reload.
- **Multi-table change sets:** stage edits across tables of one warehouse and apply them in **one atomic transaction** (`transactions/commit`). Staged changes survive a page reload and are dropped when you sign out.
- **64-bit safety:** snapshot IDs are parsed and sent without precision loss.

## Quick start (no AIStor needed)

The repo includes an in-memory AIStor **test server** (used by the e2e tests, never shipped). It verifies SigV4 signatures and enforces per-user permissions.

```bash
make deps          # npm ci for frontend and e2e
make dev           # test server :9000 + backend :8080 + Vite :5173
open http://localhost:5173     # alice / alice-password (full access), bob / bob-password (read-only)
```

## Full stack with AIStor + Keycloak (Docker Compose)

```bash
make compose-env   # writes deploy/compose/.env with random secrets
$EDITOR deploy/compose/.env    # set AISTOR_LICENSE
make up            # AIStor, Keycloak, Redis, catalog UI
open http://localhost:8080     # alice / bob, passwords in deploy/compose/.env
```

Keycloak puts each user into a group (`catalog-admin`, `catalog-readonly`). AIStor maps the `groups` claim to policies of the same names, which live in `deploy/compose/policies/`. Keycloak is published as `keycloak.localhost:8081`. Browsers resolve `*.localhost` to loopback, and inside the Compose network the same name is an alias of the Keycloak container, so every party sees the same issuer.

## Kubernetes

```bash
kubectl -n aistor-catalog create secret generic aistor-catalog-ui \
  --from-literal=session-key="$(openssl rand -base64 32)" \
  --from-literal=oidc-client-secret='…' --from-literal=redis-password='…'
kubectl apply -k deploy/kubernetes     # edit configmap.yaml first
```

The deployment runs 2 replicas under the `restricted` Pod Security Standard. It uses a read-only root filesystem, drops all capabilities, and has probes, a PDB and a NetworkPolicy. Replicas share sessions through Redis.

## Building the image

```bash
make image                                  # docker build -t aistor-catalog-ui:<version> .
# Behind a TLS-inspecting proxy:
make image DOCKER_BUILD_FLAGS="--secret id=extra_ca,src=/path/to/ca.pem"
```

The base images are build args (`NODE_IMAGE`, `GO_IMAGE`, `RUNTIME_IMAGE`), so you can point them at an internal mirror. CI publishes multi-arch images to `ghcr.io/<owner>/<repo>`.

## Configuration

The server reads a YAML file (`-config`, or `AISTOR_UI_CONFIG`). `${VAR}` references are expanded from the environment, and any secret can be supplied as a `*File` path instead. Start from `deploy/compose/config.yaml` or `deploy/kubernetes/configmap.yaml`.

| Key | Meaning |
|---|---|
| `server.publicUrl` | External origin. Must be https unless it is loopback. Used for cookies, CSRF origin checks and OIDC redirects |
| `server.trustProxy` | Take the client IP from `X-Forwarded-For` (for rate limits and audit) |
| `session.store` | `memory` (single replica) or `redis://` / `rediss://` URL |
| `session.keys[]` | AES-256 keys (`value` or `file`). The first key encrypts; all keys decrypt, which allows rotation |
| `session.idleTimeout` / `absoluteTimeout` / `stepUpValidFor` | Default 30m / 12h / 5m |
| `auth.oidc` | `issuer`, `clientId`, `clientSecret[File]`, `scopes`, `groupsClaim`, `usernameClaim`, `stsToken` (`id_token` or `access_token`), `discoveryUrl` (split-horizon), `endSessionRedirect`, `caFile` (PEM bundle trusted for the IdP, in addition to system roots) |
| `auth.ldap.enabled` | Directory sign-in through AIStor `AssumeRoleWithLDAPIdentity` |
| `auth.builtin.enabled` | Access-key sign-in through STS `AssumeRole`. The secret is used once and never stored. Intended for labs |
| `auth.adminGroups` / `adminUsers` | Who may see everyone's activity. This grants **no** catalog permissions |
| `clusters[]` | `id`, `name`, `endpoint`, `stsEndpoint`, `region`, `caFile`, `stsDuration`, `timeout` |
| `limits` | `requestsPerMinute` (per session), `loginPerMinute` (per IP), `maxBodyBytes`, `previewMaxRows` (≤1000) |
| `audit.webhookUrl` | POST each audit record as JSON. Records are always logged to stdout as well |
| `audit.webhookSecret[File]` | Sign webhook deliveries: `X-Aistor-Audit-Timestamp` (unix seconds) and `X-Aistor-Audit-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Receivers should reject timestamps older than a few minutes |

Operational endpoints: `/healthz`, `/readyz` (checks the session store), and `/metrics` on `server.metricsListen`.

> **LDAP and access-key sessions** cannot silently renew their AIStor credentials, because the password is not kept. Set `stsDuration` at least as long as `session.absoluteTimeout`. Otherwise users are asked to sign in again when the credentials expire. OIDC sessions renew through the refresh token.

## Development

```text
backend/            Go BFF
  cmd/aistor-ui           server entry point
  cmd/aistor-testserver   in-memory AIStor for e2e tests (not shipped)
  internal/catalog        allow-list routes, validation, redaction, proxy
  internal/server         HTTP wiring, auth handlers, middleware
  internal/aistor         SigV4 catalog client + STS
  internal/session        encrypted sessions (memory / Redis)
  internal/audit, auth, config, web (embedded SPA)
frontend/           React SPA (src/features, src/layout, src/components/ui, src/lib)
e2e/                Playwright tests
deploy/             compose/, kubernetes/, dev/
```

```bash
make test    # go vet + go test -race, eslint, tsc, vitest
make e2e     # builds everything, runs Playwright against the test server
```

When Chromium comes preinstalled (for example in CI images or sandboxes), set `CHROMIUM_PATH=/path/to/chrome` for `make e2e`.
