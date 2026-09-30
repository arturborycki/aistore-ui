# AIStor Catalog UI — Design

Status: **v0.3**. Phase 0 is implemented; see the README. Checked against the AIStor Tables API Reference, 2026-09-28. · Scope: multi-user, secure web UI for the MinIO AIStor Tables (Iceberg REST) catalog.

---

## 1. Goals and non-goals

### Goals
1. **Real multi-user access.** Every catalog call runs as the signed-in person, under that person's MinIO identity and policies. The UI has **no shared "service account"** that could give a user more access than MinIO grants them.
2. **Secure by default.** The browser never sees MinIO access keys, STS session tokens or vended storage credentials. OWASP ASVS L2 is the baseline.
3. **Full catalog coverage.** Warehouses, namespaces (nested), tables, views, snapshots, refs, schema/partition evolution, multi-table transactions, register, rename, **data preview**, **maintenance** (snapshot expiry, compaction, orphan-file removal), **encryption** and **tags**.
4. **Traceable.** Every change can be traced to a person: MinIO audit logs show the real user, and the UI's backend writes a correlated audit record.
5. **Built for operators.** Deploys as a stateless container, scales out, is configured with env/files, and exposes health and metrics endpoints.

### Non-goals (v1)
- Running SQL. Reading data is limited to AIStor's built-in `PreviewTable` (at most 1000 rows).
- Managing IAM policies. That stays in `mc admin` / the AIStor Console. The UI helps policy authors by showing ARNs, but it does not change IAM.
- Delta Sharing management.

---

## 2. API surface (what the UI consumes)

Source: *AIStor Tables API Reference* (docs.min.io, snapshot 2026-09-28).
Base path: `https://<aistor>/_iceberg/v1`. Every request is **AWS SigV4-signed with service name `s3tables`**. The request carries the `Authorization`, `X-Amz-Date` and `X-Amz-Content-SHA256` headers.
Warehouses are AIStor's term for AWS "table buckets". `{prefix}` in the Iceberg spec is the warehouse name.
AIStor puts every route in one of two groups: **spec endpoints**, which `GET /config` lists in `endpoints`, and **extension endpoints**, which it serves without listing them. At startup the UI reads `endpoints` and hides features the connected server doesn't serve.

### 2.1 Iceberg REST spec endpoints (served)
| Method | Path | Operation | Action / Resource |
|---|---|---|---|
| GET | `/config` | GetConfig | — (advertises `s3.delete-enabled=false`) |
| POST | `/{wh}/namespaces` | CreateNamespace | `s3tables:CreateNamespace` · `bucket/{wh}` |
| GET | `/{wh}/namespaces` | ListNamespaces (`parent`, `search`, paging, `stats`) | `s3tables:ListNamespaces` · `bucket/{wh}` |
| GET / HEAD | `/{wh}/namespaces/{ns}` | GetNamespace / NamespaceExists | `s3tables:GetNamespace` · `bucket/{wh}` |
| DELETE | `/{wh}/namespaces/{ns}` | DeleteNamespace (must be empty) | `s3tables:DeleteNamespace` · `bucket/{wh}` |
| POST | `/{wh}/namespaces/{ns}/properties` | UpdateNamespaceProperties | `s3tables:UpdateNamespaceProperties` |
| POST | `/{wh}/namespaces/{ns}/tables` | CreateTable (`stage-create` supported) | `s3tables:CreateTable` · `bucket/{wh}/table/*` · conditions `s3tables:namespace`, `s3tables:tableName`, `s3tables:SSEAlgorithm` |
| GET | `/{wh}/namespaces/{ns}/tables` | ListTables (`search`, paging, `stats`) | `s3tables:ListTables` |
| POST | `/{wh}/namespaces/{ns}/register` | RegisterTable | [verify action] |
| GET / HEAD | `/{wh}/namespaces/{ns}/tables/{t}` | LoadTable / TableExists | `s3tables:GetTable` · `bucket/{wh}/table/*` |
| POST | `/{wh}/namespaces/{ns}/tables/{t}` | CommitTable | `s3tables:UpdateTable` |
| DELETE | `/{wh}/namespaces/{ns}/tables/{t}` | DeleteTable (`purgeRequested`, **default `true`**) | `s3tables:DeleteTable` · `bucket/{wh}/table/*` |
| POST | `/{wh}/tables/rename` | RenameTable (can move between namespaces) | `s3tables:RenameTable` |
| POST | `/{wh}/transactions/commit` | CommitMultiTableTransaction | [verify action] |
| POST | `/{wh}/namespaces/{ns}/tables/{t}/metrics` | TableMetrics | not used by the UI |
| POST / GET | `/{wh}/namespaces/{ns}/views` | CreateView / ListViews | [verify actions] |
| GET / HEAD / POST / DELETE | `/{wh}/namespaces/{ns}/views/{v}` | LoadView / ViewExists / CommitView / DropView | [verify actions] |
| POST | `/{wh}/views/rename` | RenameView | [verify action] |
| POST | `/{wh}/namespaces/{ns}/register-view` | RegisterView | [verify action] |

**Not served:** scan planning (`/plan`, `/tasks`) and table credentials (`/credentials`). Also not listed, so treated as unsupported: `unregister`, `sign`, `functions` and `oauth/tokens`.

### 2.2 AIStor extension endpoints
| Method | Path | Operation | Action |
|---|---|---|---|
| POST | `/warehouses` `{"name","upgrade-existing"}` | CreateWarehouse. Creates the bucket with versioning (can't be suspended afterwards) and purge-on-delete | `s3tables:CreateWarehouse` |
| GET | `/warehouses` (`search`, paging, `stats`) | ListWarehouses (returns only the warehouses the caller can access) | `s3tables:ListWarehouses` |
| GET | `/warehouses/{wh}` | GetWarehouse → `{name,bucket,uuid,created-at,properties}` | `s3tables:GetWarehouse` · `bucket/{wh}` |
| DELETE | `/warehouses/{wh}?preserve-bucket=` | DeleteWarehouse (must have no namespaces; `preserve-bucket` defaults to false) | `s3tables:DeleteWarehouse` · `bucket/{wh}` |
| PUT / GET / DELETE | `/warehouses/{wh}/encryption` | Put / Get / DeleteWarehouseEncryption | [verify actions] |
| GET / POST / DELETE | `/warehouses/{wh}/tags` | ListWarehouseTags / TagWarehouse / UntagWarehouse | [verify actions] |
| PUT | `/{wh}/maintenance/{type}` | PutWarehouseMaintenanceConfiguration | [verify] |
| GET | `/{wh}/maintenance` | GetWarehouseMaintenanceConfiguration | [verify] |
| PUT / DELETE | `/{wh}/namespaces/{ns}/tables/{t}/maintenance/{type}` | Put / DeleteTableMaintenanceConfiguration | [verify] |
| GET | `/{wh}/namespaces/{ns}/tables/{t}/maintenance` | GetTableMaintenanceConfiguration | [verify] |
| GET | `/{wh}/namespaces/{ns}/tables/{t}/maintenance-job-status` | GetTableMaintenanceJobStatus → per-type `status` (`Successful`, `Failed`, `Disabled`, `Not_Yet_Run`), `lastRunTimestamp`, `failureMessage`, `tableARN` | `s3tables:GetTableMaintenanceJobStatus` |
| PUT / GET | `/{wh}/namespaces/{ns}/tables/{t}/encryption` | Put / GetTableEncryption | [verify] |
| GET / POST / DELETE | `/{wh}/namespaces/{ns}/tables/{t}/tags` | ListTableTags / TagTable / UntagTable | [verify] |
| GET | `/{wh}/namespaces/{ns}/tables/{t}/snapshots` | ListTableSnapshots | [verify] |
| GET | `/{wh}/namespaces/{ns}/tables/{t}/preview?limit=` | PreviewTable. Up to 1000 rows (default 100) → `{schema:[{name,type}], rows, row_count}` | `s3tables:GetTableData` |
| GET | `/stats` | GetGlobalStats | [verify] |

The warehouse encryption, tags and maintenance routes also exist under `/buckets/{wh}/…` for AWS compatibility. The UI uses only the `/warehouses` form.
Maintenance types: `icebergSnapshotManagement`, `icebergCompaction`, `icebergUnreferencedFileRemoval`.

### 2.3 Listing: search and statistics mode (built for UIs)
- `search=`: a case-insensitive substring filter on names. It works with warehouses, namespaces and tables.
- `stats=true` switches to **index-based paging**: `page` (0-based), `page_size` (default 100, max 1000), `sort`, `sort_order` (`asc`/`desc`) and `ui_token`. Each response adds `stats: {name: {namespaces?, tables?, records, size}}` and two headers: **`X-Minio-Ui-List-Token`**, which must be passed back as `ui_token` so paging reaches the node holding the cache, and **`X-Minio-Ui-Total-Count`**.
- Sort values: warehouses `namespaces|tables|records|size`, namespaces `tables|records|size`, tables `records|size`.
- The BFF must pass those two headers through to the browser. The UI's data grids use stats mode, giving a sortable and paginated view with total counts.

### 2.4 Constraints and intentional deviations the UI must enforce
| Item | Rule |
|---|---|
| Warehouse name | 3–63 characters: lowercase letters, digits, `-` |
| Table name | 1–250 characters: lowercase letters, digits, `_` |
| Namespace | 1–10 levels. No `/` in any name |
| Properties | Each key and value at most 2 KB. Table properties can't start with `write.data.path`, and most `write.metadata.*` are unsupported |
| Create table | No custom `location`. **No default column values**. `stage-create=true` returns a draft (`metadata-location: null`) that stays hidden from list/load until its first commit |
| Views | No custom metadata location. Drop takes no purge parameter |
| **Drop table** | **`purgeRequested` defaults to `true` on AIStor. Leaving the parameter out deletes the data files.** The BFF **always sends it explicitly** (§5.3) |
| Register table | Fails if the table's data was already purged |
| Client file deletion | `/config` advertises `s3.delete-enabled=false` |

### 2.5 Authorization model (MinIO PBAC)
- Uses the `s3tables:` action namespace. Warehouse actions also accept the AWS spelling (`…TableBucket`).
- ARNs:
  - `arn:aws:s3tables:::bucket/{wh}`
  - `arn:aws:s3tables:::bucket/{wh}/table/{uuid|*}`
  - `arn:aws:s3tables:::bucket/{wh}/view/{uuid|*}`
- Table and view ARNs end in the **stable UUID**, so renames keep their access rules. `maintenance-job-status` returns the `tableARN`.
- **What this means for multi-tenancy:** namespace operations are authorized on the **warehouse** ARN, and the `s3tables:namespace` / `s3tables:tableName` condition keys narrow `CreateTable`. The cleanest isolation boundary is therefore **one warehouse per team or tenant**. Per-table grants by UUID work within that. The Access helper (§7) creates policies that follow this pattern.

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
| Repo layout | `backend/` (Go), `frontend/` (React), `e2e/` (Playwright), `deploy/` | Each part builds on its own; one container ships them together |
| BFF | **Go** (chi, aws-sdk-go-v2 SigV4 signer, go-oidc, go-redis, Prometheus client). The SPA is embedded in the same binary | One static binary in a distroless image, and the same ecosystem as MinIO |
| Web | **React 19 + Vite + TypeScript**, React Router 7, TanStack Query, Radix primitives + Tailwind v4, cmdk, Lucide | Accessible primitives, caching and invalidation, a small CSP-friendly bundle |
| Tests | Go unit and integration tests against a SigV4-verifying AIStor test double and a JWT-signing IdP; Vitest; Playwright against the in-memory AIStor test server | |


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
- **Implemented:** each session has a public handle (never the secret ID). A per-user index (`aistor-ui:sidx:<sub>` in Redis) lists a user's sessions with sign-in time, last activity, client IP and user agent. Users revoke their own sessions (one, or all others) on the Sessions page; admins list and revoke everyone's. Every revoke is audited.
- Requests with `X-Aistor-Background: 1` (the UI's periodic `/auth/me`) do not count as activity, so an unattended tab still reaches the idle timeout. `/auth/me` reports `idleExpiresAt`, `expiresAt` and `credentialsExpireAt`, and the UI warns before each one.
- LDAP and access-key sessions cannot renew STS credentials without the password. When they expire, catalog calls answer `401 CredentialsExpired` (not `SessionExpired`). The UI then asks for the password (`POST /auth/step-up`) and retries the request; the session and the page survive.

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
| Drop warehouse | Allowed only when the warehouse is empty. Type the name to confirm, **step-up re-authentication** (OIDC `max_age=0` / `prompt=login`). "Keep bucket" (`preserve-bucket=true`) is **checked by default** |
| Drop table | The BFF API has a **required** `purge` boolean with no default. The BFF **always** sends `purgeRequested=true\|false` explicitly, because AIStor's default of `true` would otherwise delete data. The dialog defaults to "Keep data files" (`false`). Choosing purge needs the typed name plus step-up re-auth |
| Drop view, drop namespace (must be empty) | Type the name to confirm |
| Change warehouse/table encryption, turn off maintenance | Confirmation dialog showing the before and after settings |
| Rollback / set current snapshot, schema changes | A diff preview, then the commit is sent with `requirements` for optimistic concurrency |

### 5.4 Credential hygiene
- The BFF **never sends** `X-Iceberg-Access-Delegation` and **deletes** any `config` keys matching `s3.*`, `*secret*`, `*token*`, `*credential*` and the `storage-credentials` array from `loadTable` / `loadView` responses before sending them to the browser. This is defense in depth.
- AIStor doesn't serve `/credentials`, and `sign` isn't in the route table either. The BFF also has no route that can reach them.
- Logs pass through a redaction layer. SigV4 headers, cookies and bodies of auth endpoints are never logged.
- TLS to AIStor always verifies certificates, with an optional per-cluster CA bundle. There is no "skip verify" flag in production builds.

### 5.5 Audit
- The BFF writes a structured audit event for every mutating call: `{ts, requestId, user.sub, user.name, cluster, action, resource (incl. UUID/ARN), outcome, upstreamStatus}`. It goes to stdout as JSON and optionally to a webhook or syslog.
- Each upstream request carries an `X-Request-Id` / `x-amz-request-id` correlation ID, so BFF events can be matched with MinIO audit logs.
- Each user can see their own recent activity in the UI. Admins, identified by an IdP group claim, can see everyone's.
- `GET /api/activity` filters the retained window (`audit.retain`) by `since`/`until` (RFC 3339), `kind`, `outcome` and `q` (text), and pages with `offset`/`limit` (≤500). The UI exports matching records as CSV and neutralises formula-like cells.
- With `audit.webhookSecret`, each webhook delivery carries `X-Aistor-Audit-Timestamp` and `X-Aistor-Audit-Signature: sha256=HMAC(secret, ts + "." + body)`. `audit.VerifySignature` is the reference check and includes a replay window.

### 5.6 Supply chain and runtime
- Distroless container, non-root user, read-only root filesystem.
- Lockfiles pinned. CI runs govulncheck, `npm audit`, CodeQL (Go and TypeScript, security-extended), a Trivy image scan (SARIF plus an SPDX SBOM; fails on fixable high/critical), a Trivy config scan of the Dockerfile, Helm and kustomize, and an OWASP ZAP baseline against the running app. Dependabot updates Go, npm, Docker and Actions.
- Login and API rate limits are shared across replicas through Redis (INCR + EXPIRE fixed windows). They fail open if Redis is down, because Redis is already required for sessions and is checked by `/readyz`.
- The OIDC client can trust a private CA (`auth.oidc.caFile`) for discovery, token exchange and refresh.
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
/c/:cluster/wh/:wh/settings/:tab             → Warehouse (encryption|tags|maintenance)
/c/:cluster/wh/:wh/ns/:ns/t/:table/:tab       → Table (overview|preview|schema|partitions|snapshots|refs|maintenance|encryption|tags|properties|metadata|access)
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
│     ▾ q3          │ │ Overview│Preview│Schema│Snapshots│Maintenance│Props│…  │ │
│       ▦ orders    │ │                                                      │ │
│       ▦ invoices  │ │  Current snapshot  8841…  2026-09-28 14:02  append   │ │
│       ◇ v_revenue │ │  Records  12.4 M   Files 312   Size 4.1 GiB           │ │
│ ▸ ml              │ │  Location s3://sales/…/orders                         │ │
│                   │ │  Format v2 · Parquet · ZSTD                           │ │
│ [+ Warehouse]     │ └──────────────────────────────────────────────────────┘ │
└───────────────────┴──────────────────────────────────────────────────────────┘
```
- The left tree loads lazily: namespaces with `?parent=`, and tables and views when a node is expanded. The filter box uses the server-side `search` parameter.
- Main-pane lists use **stats mode**. The grid keeps the `ui_token` from `X-Minio-Ui-List-Token` for the life of the query and shows the total from `X-Minio-Ui-Total-Count`.
- A command palette (⌘K) searches recently loaded items and jumps to a path.
- The layout is keyboard-first, meets WCAG 2.2 AA, and supports dark and light themes.

### 7.2 Key screens
| Screen | Contents | Calls |
|---|---|---|
| **Home / Overview** | Cluster-wide totals and top warehouses by size and records | `GET /stats`, `GET /warehouses?stats=true&sort=size` |
| **Warehouses** | Sortable, paginated grid (stats mode): name, namespaces, tables, records, size, with server-side `search`. Detail drawer: bucket, UUID, created-at, properties. Create dialog: name (validated 3–63 characters, `[a-z0-9-]`) and an "upgrade existing bucket" toggle. Warehouse settings tabs: **Encryption**, **Tags**, **Maintenance** (defaults for the warehouse) | `/warehouses*`, `/{wh}/maintenance*` |
| **Namespace** | Tabs for Tables, Views and Properties. The properties editor makes a single `updates`/`removals` commit and shows the server's `updated/removed/missing` result | namespaces + properties endpoints |
| **Table › Overview** | UUID, ARN, format version, location, current snapshot summary, last updated, and a **maintenance health** badge (worst status across job types) | `loadTable`, `maintenance-job-status` |
| **Table › Preview** | Virtualized grid of up to 1000 rows (row limit 100/500/1000), column types from the response. The permission needed is `s3tables:GetTableData`, which is separate from `GetTable`, so this tab has its own no-access state | `…/preview?limit=` |
| **Table › Maintenance** | For each type (snapshot management, compaction, unreferenced-file removal): the settings (table override or inherited from the warehouse) and the last run status, time and failure message | `…/maintenance`, `…/maintenance-job-status` |
| **Table › Encryption / Tags** | Current SSE settings and a key/value tag editor | `…/encryption`, `…/tags` |
| **Table › Schema** | A tree of nested struct/list/map fields with field IDs, required flags and docs. A **schema-history diff** across `schemas[]`. The "Evolve schema" wizard adds, renames, widens or makes fields optional, then shows a preview. The commit uses `add-schema` + `set-current-schema` with `assert-current-schema-id` | commit |
| **Table › Partitions / Sort** | Specs and sort orders with history. Evolve wizard (`add-spec`, `set-default-spec`) | commit |
| **Table › Snapshots** | A timeline (append/overwrite/delete/replace), summary metrics per snapshot, parent chain. Actions: **rollback** (`set-snapshot-ref main` + `assert-ref-snapshot-id`) and **create branch/tag** here | `…/snapshots` (fallback: `loadTable`), commit |
| **Table › Refs** | Branches and tags, with retention settings (`max-ref-age-ms`, …). Create, update or remove refs | commit |
| **Table › Properties** | Key/value editor with known-property hints (e.g. `write.format.default`, `history.expire.*`). Uses `set-properties` / `remove-properties` | commit |
| **Table › Metadata** | Read-only JSON of the metadata (redacted), metadata log, and a download button | `loadTable` |
| **Table › Access** | The table ARN, sample read-only and read-write policy snippets for this table, and the actions needed for each UI operation | none (local) |
| **View** | SQL representations per dialect (read-only Monaco), version history with a diff between versions, schema, properties. Create or replace view (SQL editor + schema), rename, drop | views endpoints |
| **Create table** | Schema builder (field grid + JSON mode), partition spec builder (identity/bucket/truncate/year/month/day/hour), sort order, properties, format version. Rules checked in the form: name `[a-z0-9_]{1,250}`, **no default values**, no location field, blocks `write.data.path*` and unsupported `write.metadata.*`, and each property at most 2 KB | `createTable` |
| **Register table / view** | Metadata-location input (validated to be inside the warehouse's bucket). The UI warns that registration fails if the data was purged | `register`, `register-view` |
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
GET    /api/stats
GET    /api/c/:c/warehouses?search=&stats=&page=&page_size=&sort=&sort_order=&ui_token=   POST …
GET    /api/c/:c/wh/:wh        DELETE /api/c/:c/wh/:wh?preserveBucket=   (step-up)
GET|PUT|DELETE /api/c/:c/wh/:wh/encryption     GET|POST|DELETE /api/c/:c/wh/:wh/tags
GET    /api/c/:c/wh/:wh/maintenance            PUT /api/c/:c/wh/:wh/maintenance/:type
GET    /api/c/:c/wh/:wh/config
GET    /api/c/:c/wh/:wh/namespaces?parent=&search=&pageToken=  (or stats-mode params)
POST   /api/c/:c/wh/:wh/namespaces          GET|DELETE /api/c/:c/wh/:wh/ns/:ns
POST   /api/c/:c/wh/:wh/ns/:ns/properties
GET    /api/c/:c/wh/:wh/ns/:ns/tables       POST (create)   POST …/register
GET    /api/c/:c/wh/:wh/ns/:ns/t/:t?snapshots=all|refs
POST   /api/c/:c/wh/:wh/ns/:ns/t/:t/commit  {requirements, updates}
DELETE /api/c/:c/wh/:wh/ns/:ns/t/:t?purge=true|false   (required; purge=true ⇒ step-up)
GET    /api/c/:c/wh/:wh/ns/:ns/t/:t/preview?limit=   (1..1000)
GET    /api/c/:c/wh/:wh/ns/:ns/t/:t/snapshots
GET    /api/c/:c/wh/:wh/ns/:ns/t/:t/maintenance       PUT|DELETE …/maintenance/:type   GET …/maintenance-job-status
GET|PUT /api/c/:c/wh/:wh/ns/:ns/t/:t/encryption   GET|POST|DELETE …/tags
POST   /api/c/:c/wh/:wh/tables/rename
GET|POST /api/c/:c/wh/:wh/ns/:ns/views       GET|POST|DELETE …/v/:v   POST …/register-view   POST /api/c/:c/wh/:wh/views/rename
POST   /api/c/:c/wh/:wh/transactions/commit
GET    /api/activity?since=&until=&kind=&outcome=&q=&offset=&limit=&scope=all
GET    /api/c/:c/search?q=&limit=      catalog-wide name search (caller's permissions, bounded walk)
GET    /api/sessions   DELETE /api/sessions/:handle   POST /api/sessions/revoke-others
GET    /api/admin/sessions   DELETE /api/admin/sessions?sub=&handle=   (admins)
GET    /healthz  /readyz  /metrics (Prometheus, served on a separate port)
```
List responses pass the `X-Minio-Ui-List-Token` and `X-Minio-Ui-Total-Count` headers through unchanged. The `:type` parameter is an enum: `icebergSnapshotManagement|icebergCompaction|icebergUnreferencedFileRemoval`.

Namespaces in BFF URLs use the Iceberg convention: each level is percent-encoded, and levels are joined with `%1F`. The BFF decodes the levels, validates each one (no `/`, `\`, control characters, `.` or `..`, at most 255 bytes, at most 10 levels) and re-encodes them for the upstream path, so no path separator can be injected.

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
    region: us-east-1           # SigV4 signing region (must match the server's configured region)
    caFile: /certs/aistor-ca.pem
    stsDurationSeconds: 3600
audit: { sink: stdout, webhookUrl: null }
```

---

## 11. Delivery plan

| Phase | Scope |
|---|---|
| **0 – Foundations** ✅ | Go backend with the SigV4 signer. OIDC, LDAP and access-key sign-in through STS; encrypted sessions; CSRF and CSP (with a nonce for runtime styles); step-up. The **complete** route allow-list with validation and redaction; audit; metrics. The UI shell, overview, warehouses and namespaces. Container, Compose, Kubernetes, CI |
| **1 – Browse** ✅ | Overview stats, warehouses/namespaces/tables grids (stats mode, search, sort), namespace tree, table and view detail (all read tabs), **data preview**, maintenance status, Access/ARN helper, 403-aware UX |
| **2 – Manage** ✅ | Create/drop warehouse, namespace, table and view (explicit-purge safeguards); properties and tags editing; rename; register table/view; step-up re-auth; audit trail |
| **3 – Evolve and operate** ✅ | Schema, partition and sort evolution wizards, snapshot rollback, branch/tag management, conflict handling, multi-table change sets, **maintenance configuration** (warehouse and table), **encryption settings** |
| **Hardening** ✅ | Time travel, snapshot expiry, row-key editing; sessions page and admin revoke; in-place re-auth on expired credentials; expiry warnings; server-side catalog search; activity filters, paging and CSV export; Redis-shared rate limits; signed audit webhook; OIDC CA; Helm chart, Ingress, Redis component; axe (WCAG 2.1 AA), responsive layout, code splitting; CodeQL, govulncheck, Trivy, ZAP, SBOM, Dependabot |
| **5 – Semantic layer** (proposed) | Apache Ossie models built from Iceberg schemas, stored in AIStor under PBAC, served as YAML/JSON: see [SEMANTIC_LAYER.md](SEMANTIC_LAYER.md) |
| **4 – Beyond** | Optional admin policy viewer or generator, Delta Sharing management, staged-create workflows, localisation |

---

## 12. Testing and threat model summary

| Threat | Mitigation |
|---|---|
| XSS steals credentials | No credentials in the browser; strict CSP; untrusted strings rendered as text |
| CSRF on destructive ops | SameSite=Strict + synchronizer token + Origin check + step-up |
| Privilege escalation through a shared UI account | None exists: each call is signed with that user's STS credentials |
| SSRF / open proxy | Cluster URLs are server config only; typed route allow-list; no passthrough |
| Vended-credential leak | `/credentials` not served by AIStor and not routed; delegation header never sent; response redaction |
| Accidental data purge | `purgeRequested` always sent explicitly; UI defaults to keep-data; purge needs step-up; e2e test checks that a drop without purge keeps the data files |
| Data exposure through preview | Preview runs with the user's own credentials and needs `s3tables:GetTableData`; the row limit is enforced by the BFF (≤1000); preview responses are never cached by the BFF or the browser (`Cache-Control: no-store`) |
| Session theft / replay | `__Host-` cookie, short idle timeout (background polls don't extend it), server-side revoke by the user or an admin from the Sessions page, device and IP shown per session |
| Brute force across replicas | Login and API rate limits shared through Redis |
| Forged audit events at the SIEM | HMAC-signed webhook deliveries with a timestamp (replay window) |
| Lost updates from concurrent edits | Iceberg `requirements` + a 409 conflict UX |
| Log leakage | Redaction layer; auth bodies and signatures are never logged |

Tests: unit tests (commit builders, encoders, redaction), BFF integration tests against real AIStor with **two users on different policies** to prove isolation, Playwright e2e for the main flows, and ZAP baseline plus dependency scans in CI.

---

## 13. Open questions (still to confirm)
The API reference answered most earlier questions. What's left:
1. Policy action names for the endpoints the reference doesn't list: views (`CreateView`, `GetView`, `UpdateView`, `DeleteView`, `RenameView`?), `RegisterTable`, multi-table transactions, encryption, tags, maintenance configuration, `ListTableSnapshots` and `GetGlobalStats`. These are probably the same as the operation names. We'll confirm them on the "Controlling Access" page or by testing against a live server.
2. Request and response bodies for the encryption, tags, maintenance-configuration, `ListTableSnapshots` and `/stats` endpoints. The reference only lists them.
3. Whether `GET /stats` only counts what the caller is allowed to see, or reports cluster-wide totals. If it's cluster-wide, it could leak information across tenants, so it may need an admin-only setting.
4. The `namespace-separator` value from `/config`. We'll test against a live server.
5. Whether a stats-mode `ui_token` is tied to the caller. The BFF keeps it per session regardless.

### Request formats assumed for the AIStor extension endpoints
The AIStor reference names these operations but does not document their bodies. The UI sends the AWS S3 Tables shapes; the backend forwards any JSON object unchanged, so aligning them with AIStor only needs a frontend change:
- `PUT …/maintenance/{type}`: `{"value": {"status": "enabled"|"disabled", "settings": {"<type>": {…}}}}`. Settings used: `targetFileSizeMB`, `minSnapshotsToKeep`, `maxSnapshotAgeHours`, `unreferencedDays`, `nonCurrentDays`.
- `PUT …/encryption`: `{"encryptionConfiguration": {"sseAlgorithm": "AES256"|"aws:kms", "kmsKeyArn": "…"}}`.
- `POST …/tags`: `{"tags": {"k": "v"}}`; `DELETE …/tags?tagKeys=k`.

## References
- AIStor Tables API reference: https://docs.min.io/aistor/developers/aistor-tables/aistor-tables-api/ (PDF snapshot 2026-09-28)
- Controlling access to AIStor Tables: https://docs.min.io/aistor/administration/aistor-tables/aistor-tables-access/
- Apache Iceberg REST catalog OpenAPI: https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml
- MinIO STS: AssumeRoleWithWebIdentity / AssumeRoleWithLDAPIdentity
