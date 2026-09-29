# AIStor Catalog UI — Design

Status: **Draft v0.1** · Scope: multi-user, secure web UI for the MinIO AIStor Tables (Iceberg REST) catalog.

---

## 1. Goals and non-goals

### Goals
1. **Real multi-user access.** Every catalog call runs as the signed-in person, under that person's MinIO identity and policies. The UI has **no shared "service account"** that could give a user more access than MinIO grants them.
2. **Secure by default.** The browser never sees MinIO access keys, STS session tokens or vended storage credentials. OWASP ASVS L2 is the baseline.
3. **Full catalog coverage.** Warehouses, namespaces (nested), tables, views, snapshots, refs, schema/partition evolution, multi-table transactions, register/unregister, and rename.
4. **Traceable.** Every change can be traced to a person: MinIO audit logs show the real user, and the UI's backend writes a correlated audit record.
5. **Built for operators.** Deploys as a stateless container, scales out, is configured with env/files, and exposes health and metrics endpoints.

### Non-goals (v1)
- Running SQL or reading table data. The UI manages metadata only; a data preview is a later phase (§11).
- Managing IAM policies. That stays in `mc admin` / the AIStor Console. The UI helps policy authors by showing ARNs, but it does not change IAM.
- Delta Sharing management.

---

## 2. API surface (what the UI consumes)

Base path: `https://<aistor>/_iceberg/v1`. Every request is **AWS SigV4-signed with service name `s3tables`**.
Warehouses are AIStor's term for AWS "table buckets". `{prefix}` in the Iceberg spec is the warehouse name.

> ⚠️ The MinIO docs site (`docs.min.io`) was not reachable from the design environment. The list below combines
> (a) facts about AIStor Tables confirmed through search, and (b) the upstream Iceberg REST OpenAPI spec. AIStor implements
> a *subset* of the Iceberg spec. Items marked **[verify]** must be checked against the AIStor API reference before implementation (§13).

### 2.1 AIStor extensions — warehouses
| Method | Path | Purpose | Policy action |
|---|---|---|---|
| POST | `/warehouses` body `{"name","upgrade-existing"}` | Create a warehouse. AIStor creates a bucket with versioning and purge-on-delete. `upgrade-existing` converts an existing bucket | `s3tables:CreateWarehouse` (alias `CreateTableBucket`) |
| GET | `/warehouses` | List warehouses | `s3tables:ListWarehouses` |
| GET | `/warehouses/{warehouse}` **[verify]** | Get warehouse details | `s3tables:GetWarehouse` / `GetTableBucket` |
| DELETE | `/warehouses/{warehouse}` **[verify]** | Delete a warehouse | `s3tables:DeleteWarehouse` **[verify]** |

### 2.2 Iceberg REST catalog (from the spec; AIStor coverage **[verify]**)
| Area | Operations |
|---|---|
| Config | `GET /config?warehouse=` |
| Namespaces | list (`?parent=`, paginated), create, load, exists (HEAD), drop, `POST …/properties` (updates/removals) |
| Tables | list, create (incl. `stage-create`), load (`?snapshots=all\|refs`), exists, **commit** (`POST …/tables/{t}` with `requirements` + `updates`), drop (`?purgeRequested=`), register, unregister, rename, metrics, `loadCredentials`, `sign` |
| Views | list, create, load, **replace** (commit), exists, drop, rename, register-view |
| Transactions | `POST /{prefix}/transactions/commit` (multi-table, atomic) |
| Scan planning | plan / fetch plan / cancel / tasks (probably **not** implemented by AIStor **[verify]**) |
| Functions | list / load (new in spec; probably not in AIStor **[verify]**) |
| OAuth | `POST /oauth/tokens`. **Not used**: AIStor uses SigV4, and this endpoint is deprecated upstream. |

Protocol details the client must handle:
- **Nested namespaces** are joined with the unit separator `0x1F` and URL-encoded as `%1F` in paths. The server may say otherwise in the `namespace-separator` value from `/config` **[verify]**.
- **Pagination** uses `pageToken` / `pageSize` on list endpoints.
- **Optimistic concurrency.** Commits carry `requirements` (`assert-current-schema-id`, `assert-ref-snapshot-id`, `assert-table-uuid`, …). A `409 CommitFailedException` must show a "someone else changed this" dialog and must not retry blindly.
- **Vended credentials.** The client requests them with the `X-Iceberg-Access-Delegation: vended-credentials` header. AIStor then returns short-lived S3 credentials limited to the table prefix. **The UI must never ask for them** (§5.4).

### 2.3 Authorization model (MinIO PBAC)
- The `s3tables:` action namespace.
- Resource ARNs:
  - `arn:aws:s3tables:::bucket/{warehouse}`
  - `arn:aws:s3tables:::bucket/{warehouse}/table/{table-uuid|*}`
  - `arn:aws:s3tables:::bucket/{warehouse}/view/{view-uuid|*}`
  - Table and view ARNs use the **stable UUID**, not the name. This matters for the UI: renames don't change access, and the UI shows the ARN so admins can write exact policies.
- Warehouse action names accept both spellings (`…Warehouse` and `…TableBucket`).
- The condition key `s3tables:SSEAlgorithm` applies to `CreateWarehouse` and `CreateTable`.

---

## 3. Architecture

```
┌──────────────┐  HTTPS, session cookie   ┌──────────────────────────┐  SigV4(s3tables), per-user STS creds  ┌──────────────┐
│ Browser SPA  │ ───────────────────────▶ │ BFF (Backend-for-Frontend)│ ───────────────────────────────────▶ │ AIStor       │
│ React + TS   │ ◀─────────────────────── │  • auth / session         │ ◀─────────────────────────────────── │ /_iceberg/v1 │
│ no secrets   │   JSON (redacted)        │  • route allow-list proxy │                                       │ STS endpoint │
└──────────────┘                          │  • SigV4 signer           │  AssumeRoleWithWebIdentity / LDAP     └──────────────┘
                                          │  • audit, rate-limit      │ ───────────────────────────────────▶
                     OIDC (auth code+PKCE)│                           │
        ┌────────────┐ ◀──────────────────┤                           │──▶ Redis (encrypted session store)
        │ IdP (OIDC) │                    └──────────────────────────┘
        └────────────┘
```

### Why a BFF instead of a browser-only SPA
A browser-only SPA would have to keep SigV4 secrets in JavaScript memory or storage, where one XSS bug can leak them. It would also need CORS opened on AIStor. The BFF:
- Keeps each user's STS credentials on the server (encrypted at rest) behind an opaque, `HttpOnly` cookie.
- Gives the browser only what it needs: redacted catalog JSON.
- Proxies only the operations the UI supports (allow-list), never arbitrary paths.
- Centralizes audit logging, rate limits and CSRF protection.

### Tech stack (proposed)
| Layer | Choice | Reason |
|---|---|---|
| Monorepo | pnpm workspaces: `apps/web`, `apps/bff`, `packages/api-types` | Frontend and backend share types |
| Types | `openapi-typescript` generated from the Iceberg spec, plus hand-written AIStor extensions | Keeps the UI in step with the spec |
| BFF | Node 22 + **Fastify**, `zod` validation, `@smithy/signature-v4`, `openid-client`, `ioredis` | Mature, fast, first-class SigV4 |
| Web | **React 19 + Vite + TypeScript**, TanStack Router and Query, shadcn/ui (Radix) + Tailwind, Monaco (read-only JSON/SQL) | Accessible primitives, typed routing, cache and invalidation |
| Tests | Vitest, Playwright e2e against a real AIStor container, and contract tests against the OpenAPI spec | |

(Go for the BFF is a reasonable alternative, since MinIO's own SDK and ecosystem are Go. The design doesn't depend on the language.)

---

## 4. Identity and multi-user model

### 4.1 Login methods (admins turn each one on in config)
1. **OIDC (recommended).** Authorization Code + PKCE with the company IdP (Keycloak, Entra ID, Okta, Dex…). The BFF receives the ID/access token and exchanges it with MinIO through **STS `AssumeRoleWithWebIdentity`**. MinIO maps claims to policies (`policy` claim or RoleARN). This gives per-user temporary credentials.
2. **LDAP/AD.** The login form posts to the BFF over TLS, and the BFF calls **STS `AssumeRoleWithLDAPIdentity`**. The password is sent once and is never stored or logged.
3. **MinIO built-in users (dev/lab only, off by default).** Access key and secret go through STS `AssumeRole` to get a short-lived session. The long-lived secret is thrown away right after the exchange.

In every case, the only credential that persists is a **short-lived STS triple** (AK/SK/session token) tied to one user. MinIO then enforces **that user's** policies on every call. Two users with different policies see different catalogs, and the UI does not need to know why.

### 4.2 Sessions
- The cookie is `__Host-aistor_sid`: `Secure; HttpOnly; SameSite=Strict; Path=/`, and holds an opaque 256-bit random ID.
- The session record in Redis holds `{sub, displayName, idp, stsCreds (AES-256-GCM encrypted, key from KMS/env), stsExpiry, refreshToken?, createdAt, lastSeen, csrfSecret, ipHash?, uaHash?}`.
- **Idle timeout** is 30 min and **absolute timeout** is 12 h (both configurable). STS `DurationSeconds` is 1 h. The BFF refreshes STS credentials quietly using the OIDC refresh token. If refresh fails, the user is sent to log in again.
- A new session ID is issued at login (no session fixation). Logout removes the server session and calls RP-initiated logout at the IdP.
- An admin can revoke a session. Because sessions are stored server-side, a revoke takes effect at once.

### 4.3 Tenancy
- **One BFF deployment can serve several AIStor clusters.** The cluster registry is **server-side config only**: an ID, a base URL, a CA bundle and an STS endpoint. The browser picks a cluster by ID and can never enter a URL, which rules out SSRF.
- Isolation inside a cluster comes from MinIO policies (warehouse per team, ARN scoping). The UI adds no second permission system. It only reflects MinIO's decisions.

---

## 5. Security controls

### 5.1 BFF as a strict, typed proxy
- The BFF has one **route table** mapping UI operations to upstream calls, e.g. `GET /api/c/:cluster/wh/:wh/ns/:ns/tables` → `GET /_iceberg/v1/{wh}/namespaces/{ns}/tables`. **There is no catch-all passthrough.**
- Path parameters are checked with `zod`. Warehouse names follow bucket-name rules. Namespace and table identifiers are limited to allowed characters and a maximum length, then re-encoded by the BFF (the `%1F` join), never concatenated as raw strings.
- Request bodies for commits and creates are checked against the Iceberg schemas before signing. Unknown fields are rejected.
- Response bodies are size-limited and streamed. Upstream request timeouts are 30 s by default.

### 5.2 Web security
- **CSRF.** `SameSite=Strict`, plus a required `X-CSRF-Token` header (a synchronizer token bound to the session) on every state-changing method, plus an `Origin`/`Sec-Fetch-Site` check.
- **CSP.** `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'`. There are no inline scripts, and Monaco workers are self-hosted.
- **Other headers.** HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` locked down, COOP/COEP.
- **Output.** React escaping only. `dangerouslySetInnerHTML` is banned by a lint rule. Catalog-supplied strings (properties, SQL, docs) count as untrusted: they render as text, and SQL shows in read-only Monaco.
- **Rate limits** are set per session and per IP, with stricter limits on login and destructive endpoints.

### 5.3 Destructive-operation safeguards
| Action | Guard |
|---|---|
| Drop warehouse | Type the name to confirm, **step-up re-authentication** (OIDC `max_age=0` / `prompt=login`), and a warning that the bucket is purged |
| Drop table with `purgeRequested=true` | Type the name, step-up re-auth, and a note that data files are deleted |
| Drop table (metadata only), drop view, drop namespace | Type the name to confirm |
| Rollback / set current snapshot, schema changes | A diff preview, then the commit is sent with `requirements` for optimistic concurrency |

### 5.4 Credential hygiene
- The BFF **never sends** `X-Iceberg-Access-Delegation` and **deletes** any `config` keys matching `s3.*`, `*secret*`, `*token*`, `*credential*` and the `storage-credentials` array from `loadTable` / `loadView` responses before sending them to the browser. This is defense in depth.
- `loadCredentials` and `sign` are **not in the route table**.
- Logs pass through a redaction layer. SigV4 headers, cookies and bodies of auth endpoints are never logged.
- TLS to AIStor always verifies certificates, with an optional per-cluster CA bundle. There is no "skip verify" flag in production builds.

### 5.5 Audit
- The BFF writes a structured audit event for every mutating call: `{ts, requestId, user.sub, user.name, cluster, action, resource (incl. UUID/ARN), outcome, upstreamStatus}`. It goes to stdout as JSON and optionally to a webhook or syslog.
- Each upstream request carries an `X-Request-Id` / `x-amz-request-id` correlation ID, so BFF events can be matched with MinIO audit logs.
- Each user can see their own recent activity in the UI. Admins, identified by an IdP group claim, can see everyone's.

### 5.6 Supply chain and runtime
- Distroless container, non-root user, read-only root filesystem.
- Lockfile pinned, SBOM (CycloneDX), `npm audit` and CodeQL in CI, and Renovate.
- Secrets (session encryption key, OIDC client secret) come only from mounted files or env. Rotation is supported through a key ring (`kid`).

---

## 6. Permission-aware UX (without a second permission system)

MinIO has no user-facing "what can I do?" API, so the UI does three things:
1. **Renders optimistically, then learns from denials.** A `403` on a resource shows an inline "No access" state that includes the needed action (for example, "requires `s3tables:ListTables` on `arn:aws:s3tables:::bucket/sales/table/*`"). The denial is cached per session and resource, so the matching buttons are disabled with a tooltip instead of failing again.
2. **Lets list filtering happen on the server.** List results already reflect what MinIO allows. The UI does not try to guess.
3. **Includes a "Copy ARN" / "Request access" helper.** On any resource, a user can copy the exact ARN and the needed action as a policy snippet. Optionally, this can open a mailto or ticket link template set by the admin.

Error mapping: `401` or an expired STS session → quiet refresh, else re-login. `403` → no-access state. `404` → not found or deleted by someone else. `409` → a conflict dialog showing the current server state compared with the user's change. `5xx` → retry for GETs only, with backoff.

---

## 7. Information architecture and screens

```
/login
/c/:cluster                                   → Warehouses
/c/:cluster/wh/:wh                            → Warehouse overview + namespace tree
/c/:cluster/wh/:wh/ns/:ns                     → Namespace (tables · views · properties)
/c/:cluster/wh/:wh/ns/:ns/t/:table/:tab       → Table (overview|schema|partitions|snapshots|refs|properties|metadata|access)
/c/:cluster/wh/:wh/ns/:ns/v/:view/:tab        → View  (overview|sql|versions|schema|properties|access)
/activity                                     → My audit trail (admins: all)
/settings                                     → Profile, session info, theme
```

### 7.1 Layout
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◧ AIStor Catalog   [cluster: prod-eu ▾]   ⌘K Search…         alice ▾  (◐)    │
├───────────────────┬──────────────────────────────────────────────────────────┤
│ WAREHOUSES        │ sales › finance › q3 › orders                             │
│ ▸ analytics       │ ┌──────────────────────────────────────────────────────┐ │
│ ▾ sales           │ │ orders   TABLE  v2  uuid 7c1e…  [Copy ARN] [⋯]       │ │
│   ▾ finance       │ ├──────────────────────────────────────────────────────┤ │
│     ▾ q3          │ │ Overview│Schema│Partitions│Snapshots│Refs│Props│JSON │ │
│       ▦ orders    │ │                                                      │ │
│       ▦ invoices  │ │  Current snapshot  8841…  2026-09-28 14:02  append   │ │
│       ◇ v_revenue │ │  Records  12.4 M   Files 312   Size 4.1 GiB           │ │
│ ▸ ml              │ │  Location s3://sales/…/orders                         │ │
│                   │ │  Format v2 · Parquet · ZSTD                           │ │
│ [+ Warehouse]     │ └──────────────────────────────────────────────────────┘ │
└───────────────────┴──────────────────────────────────────────────────────────┘
```
- The left tree loads lazily: namespaces with `?parent=`, and tables and views when a node is expanded.
- A command palette (⌘K) searches recently loaded items and jumps to a path.
- The layout is keyboard-first, meets WCAG 2.2 AA, and supports dark and light themes.

### 7.2 Key screens
| Screen | Contents | Calls |
|---|---|---|
| **Warehouses** | Card or table list: name, created, table count (lazy). Create dialog: name, "upgrade existing bucket" toggle | `GET/POST/DELETE /warehouses` |
| **Namespace** | Tabs for Tables, Views and Properties. The properties editor makes a single `updates`/`removals` commit and shows the server's `updated/removed/missing` result | namespaces + properties endpoints |
| **Table › Overview** | UUID, format version, location, current snapshot summary (from `snapshot.summary`), last updated | `loadTable` |
| **Table › Schema** | A tree of nested struct/list/map fields with field IDs, required flags and docs. A **schema-history diff** across `schemas[]`. The "Evolve schema" wizard adds, renames, widens or makes fields optional, then shows a preview. The commit uses `add-schema` + `set-current-schema` with `assert-current-schema-id` | commit |
| **Table › Partitions / Sort** | Specs and sort orders with history. Evolve wizard (`add-spec`, `set-default-spec`) | commit |
| **Table › Snapshots** | A timeline (append/overwrite/delete/replace), summary metrics per snapshot, parent chain. Actions: **rollback** (`set-snapshot-ref main` + `assert-ref-snapshot-id`) and **create branch/tag** here | `loadTable?snapshots=all`, commit |
| **Table › Refs** | Branches and tags, with retention settings (`max-ref-age-ms`, …). Create, update or remove refs | commit |
| **Table › Properties** | Key/value editor with known-property hints (e.g. `write.format.default`, `history.expire.*`). Uses `set-properties` / `remove-properties` | commit |
| **Table › Metadata** | Read-only JSON of the metadata (redacted), metadata log, and a download button | `loadTable` |
| **Table › Access** | The table ARN, sample read-only and read-write policy snippets for this table, and the actions needed for each UI operation | none (local) |
| **View** | SQL representations per dialect (read-only Monaco), version history with a diff between versions, schema, properties. Create or replace view (SQL editor + schema), rename, drop | views endpoints |
| **Create table** | Schema builder (field grid + JSON mode), partition spec builder (identity/bucket/truncate/year/month/day/hour), sort order, properties, format version | `createTable` |
| **Register table** | Metadata-location input (validated to be inside the warehouse's bucket) | `register` |
| **Batch changes** | An optional "change set" tray: stage changes across several tables and apply them atomically | `transactions/commit` |
| **Activity** | Filterable audit trail, as described in §5.5 | BFF only |

---

## 8. BFF API (browser ↔ BFF)

All routes live under `/api`, return JSON, and need a session. Mutating routes also need the CSRF header.
```
POST   /auth/login/oidc           → 302 to IdP        GET /auth/callback
POST   /auth/login/ldap           {username,password}
POST   /auth/logout               GET /auth/me        POST /auth/step-up
GET    /api/clusters
GET    /api/c/:c/warehouses                 POST …   DELETE /api/c/:c/wh/:wh  (step-up)
GET    /api/c/:c/wh/:wh/config
GET    /api/c/:c/wh/:wh/namespaces?parent=&pageToken=
POST   /api/c/:c/wh/:wh/namespaces          GET|DELETE /api/c/:c/wh/:wh/ns/:ns
POST   /api/c/:c/wh/:wh/ns/:ns/properties
GET    /api/c/:c/wh/:wh/ns/:ns/tables       POST (create)   POST …/register
GET    /api/c/:c/wh/:wh/ns/:ns/t/:t?snapshots=all|refs
POST   /api/c/:c/wh/:wh/ns/:ns/t/:t/commit  {requirements, updates}
DELETE /api/c/:c/wh/:wh/ns/:ns/t/:t?purge=  (purge ⇒ step-up)
POST   /api/c/:c/wh/:wh/tables/rename
GET|POST /api/c/:c/wh/:wh/ns/:ns/views       GET|POST|DELETE …/v/:v   POST /api/c/:c/wh/:wh/views/rename
POST   /api/c/:c/wh/:wh/transactions/commit
GET    /api/activity
GET    /healthz  /readyz  /metrics (Prometheus, served on a separate port)
```
Namespaces in BFF URLs are carried as a dot-free, URL-safe encoding of the level array (for example, base64url of a JSON array). This avoids mixing up `.` and `%1F`. The BFF turns it back into the Iceberg `%1F` form.

---

## 9. Frontend structure

```
apps/web/src
  app/            router, providers, layout, error boundaries
  features/
    auth/  warehouses/  namespaces/  tables/  views/  activity/  access-helper/
  components/     ui primitives (shadcn), DataGrid, JsonViewer, SqlViewer, DiffView, ConfirmDialog
  lib/api/        typed client (fetch + CSRF + error normalization), query keys
  lib/iceberg/    schema/type utils, spec-update builders (pure + unit-tested)
```
- **Query keys** are `[cluster, wh, 'ns', nsPath, 't', name]`. A mutation invalidates only the affected subtree.
- **Commit builders** are pure functions that turn UI intents into Iceberg `updates` + `requirements`, for example `buildRollback(table, snapshotId)`. They are unit-tested against sample metadata.
- No tokens or credentials are ever stored in `localStorage` or `sessionStorage`. Only UI preferences such as theme and tree state go there.

---

## 10. Configuration (BFF)

```yaml
server: { port: 8080, metricsPort: 9090, publicUrl: https://catalog.example.com, trustProxy: true }
session: { store: redis://…, encryptionKeys: [{kid: k1, file: /secrets/k1}], idle: 30m, absolute: 12h }
auth:
  oidc:  { enabled: true, issuer: https://idp…, clientId: aistor-ui, clientSecretFile: /secrets/oidc, scopes: [openid, profile, email, groups], adminGroup: catalog-admins }
  ldap:  { enabled: false }
  builtin: { enabled: false }   # dev only
clusters:
  - id: prod-eu
    name: Production EU
    endpoint: https://aistor.eu.example.com:9000
    region: us-east-1           # SigV4 region [verify default]
    caFile: /certs/aistor-ca.pem
    stsDurationSeconds: 3600
audit: { sink: stdout, webhookUrl: null }
```

---

## 11. Delivery plan

| Phase | Scope |
|---|---|
| **0 – Foundations** | Monorepo, CI, BFF skeleton with the SigV4 signer, OIDC + STS login, sessions, CSRF/CSP, route allow-list framework, docker-compose (AIStor + Keycloak + Redis) for development and e2e |
| **1 – Browse (read-only)** | Warehouses, namespace tree, table and view detail (all read tabs), Access/ARN helper, 403-aware UX |
| **2 – Manage** | Create/drop warehouse, namespace, table and view; properties editing; rename; register/unregister; step-up re-auth; audit trail |
| **3 – Evolve** | Schema, partition and sort evolution wizards, snapshot rollback, branch/tag management, conflict handling, multi-table change sets |
| **4 – Beyond** | Data preview (read-only, server-side via DuckDB/iceberg-rust using the user's own STS creds, row cap), table maintenance status, optional admin policy viewer, Delta Sharing |

---

## 12. Testing and threat model summary

| Threat | Mitigation |
|---|---|
| XSS steals credentials | No credentials in the browser; strict CSP; untrusted strings rendered as text |
| CSRF on destructive ops | SameSite=Strict + synchronizer token + Origin check + step-up |
| Privilege escalation through a shared UI account | None exists: each call is signed with that user's STS credentials |
| SSRF / open proxy | Cluster URLs are server config only; typed route allow-list; no passthrough |
| Vended-credential leak | Delegation header never sent; response redaction; `loadCredentials`/`sign` not routed |
| Session theft / replay | `__Host-` cookie, short idle timeout, server-side revoke, optional UA/IP binding |
| Lost updates from concurrent edits | Iceberg `requirements` + a 409 conflict UX |
| Log leakage | Redaction layer; auth bodies and signatures are never logged |

Tests: unit tests (commit builders, encoders, redaction), BFF integration tests against real AIStor with **two users on different policies** to prove isolation, Playwright e2e for the main flows, and ZAP baseline plus dependency scans in CI.

---

## 13. Open questions (to confirm against the AIStor API reference)
1. Exact warehouse endpoints and response shapes (`GET/DELETE /warehouses/{name}`, list pagination, returned fields).
2. Which Iceberg REST endpoints AIStor implements (register-view, unregister, scan planning, functions, metrics).
3. SigV4 region value AIStor expects for `s3tables` (whatever the server region is, or a fixed value?).
4. The full `s3tables:` action list, including view actions (`CreateView`, `GetView`, `DeleteView`, `UpdateView`, `RenameView`?) and namespace actions.
5. Any AIStor-specific extension endpoints beyond warehouses, such as maintenance/compaction status or metrics.
6. Namespace separator advertised by `/config`, and nesting-depth limits.
7. Whether `ListWarehouses` / `ListTables` results are filtered by policy on the server or return `403` in full.

## References
- AIStor Tables API reference: https://docs.min.io/aistor/developers/aistor-tables/aistor-tables-api/
- Controlling access to AIStor Tables: https://docs.min.io/aistor/administration/aistor-tables/aistor-tables-access/
- Apache Iceberg REST catalog OpenAPI: https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml
- MinIO STS: AssumeRoleWithWebIdentity / AssumeRoleWithLDAPIdentity
