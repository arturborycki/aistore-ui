# Semantic layer with Apache Ossie — Design

Status: **implemented** (all five steps, S1–S5). Companion to [DESIGN.md](DESIGN.md).
The notes at the end list where the implementation differs from the proposal.

The goal is to let catalog users describe **what the data means**, not only how
it is stored. That covers business names, descriptions, synonyms, keys, joins,
metrics and AI hints. Users start from the Iceberg schemas they already manage
in this UI. The result is published as **Apache Ossie** documents (YAML/JSON)
that BI tools, semantic layers and AI agents can consume.

---

## 1. Apache Ossie in one page

[Apache Ossie](https://ossie.apache.org/) (incubating, formerly *Open Semantic
Interchange*, OSI) is a vendor-neutral specification for exchanging semantic
models. The spec is in `core-spec/` of
[apache/ossie](https://github.com/apache/ossie): `spec.md`, `spec.yaml` and
`ossie-schema.json`. The current version is **`0.2.0.dev0`**; it is still
pre-1.0 and changing.

A model is one document:

| Element | Key properties |
|---|---|
| **model** (top level) | `version`, `name`, `description`, `ai_context`, `datasets[]`, `relationships[]`, `metrics[]`, `custom_extensions[]` |
| **dataset** (a logical table) | `name`, `source` (`db.schema.table` or a query), `primary_key[]`, `unique_keys[][]`, `description`, `ai_context`, `fields[]`, `custom_extensions[]` |
| **field** (row-level attribute) | `name`, `expression.dialects[]` (required), `dimension.is_time`, `label`, `description`, `datatype`, `ai_context`, `custom_extensions[]` |
| **relationship** (FK join) | `name`, `from` (many side), `to` (one side), `from_columns[]`, `to_columns[]`, `ai_context` |
| **metric** (aggregate, may span datasets) | `name`, `expression.dialects[]`, `description`, `datatype`, `ai_context` |
| **expression** | `dialects: [{dialect, expression}]`. `dialect` is one of `ANSI_SQL` (default), `SNOWFLAKE`, `DATABRICKS`, `BIGQUERY`, `TABLEAU`, `MDX`, `DAX`, `MAQL`, `SIGMA`, `THOUGHTSPOT`, `OSSIE_SQL_2026` |
| **datatype** | `String`, `Integer`, `Decimal`, `Float`, `Boolean`, `Date`, `Time`, `DateTime`, `DateTimeTz`, `Opaque` |
| **ai_context** | a string, or `{instructions, synonyms[], examples[], …}` |
| **custom_extension** | `{vendor_name, data}` (`data` is an opaque string) |

What Ossie does **not** define matters for this design: storage, access control,
versioning, and a serving API. It is an interchange format only.

---

## 2. Principles

1. **Iceberg is the source of truth for structure; Ossie adds meaning.**
   - Datasets are generated from tables, fields from columns, and datatypes from Iceberg types.
   - Users only add what Iceberg cannot express.
   - Column identity is the Iceberg **field ID**, so renames never break a model (§5).
2. **No second permission system.** Ossie documents are stored in AIStor and
   read and written with the **user's own STS credentials**, as for everything
   else. PBAC decides who may read or edit a model.
3. **Standard documents, readable without this UI.** Stored files are plain,
   schema-valid Ossie YAML. Any tool with S3 access can read them directly.
   The UI and its API are a convenience, not a gatekeeper.
4. **Safe concurrent editing**, like Iceberg commits: every save states the
   version it was based on, and a conflicting save gets 409 (it is never overwritten).
5. **Expressions are data, never executed.** The BFF validates their syntax
   and the columns they reference. It never runs them.

---

## 3. Where models live

### Decision: a dedicated S3 bucket on the same AIStor cluster

```
s3://<semantic.bucket>/<warehouse>/<ns level 1>/…/<ns level n>/<model>.ossie.yaml
e.g. s3://aistor-semantics/analytics/sales/retail.ossie.yaml
```

- **One model per file, scoped to a namespace.** Its datasets may reference
  tables anywhere in the same warehouse, because joins often cross namespaces.
  A namespace can hold several models (for example `retail`, `finance`).
- **Access** is ordinary S3 PBAC on key prefixes. Examples:
  - read: `s3:GetObject` on `arn:aws:s3:::aistor-semantics/analytics/*`
  - edit: `s3:PutObject` / `s3:DeleteObject` on the same prefix
  - list: `s3:ListBucket` with an `s3:prefix` condition

  The Access tab helper (already built for tables) generates these policy snippets.
- **History:** bucket versioning gives each save a version, and the UI shows it
  as history, diff and restore. Object Lock or retention is optional for regulated shops.
- **Concurrency:** saves use `PutObject` with `If-Match: <etag>`, or
  `If-None-Match: *` for creation. A 412 is mapped to 409 `ModelConflict`.

### Alternatives considered

| Option | Why not (as the primary store) |
|---|---|
| Iceberg table/namespace **properties** | Model-level parts (relationships, metrics) span tables; property size limits; noisy table metadata. Used only for a small **pointer** (§6.4). |
| Objects inside the **warehouse bucket** | That bucket belongs to AIStor Tables. Arbitrary objects there may be refused, and could be caught by orphan-file cleanup. |
| A **database owned by the BFF** | It would need its own authorization, backups and HA. That breaks principle 2. |
| Iceberg **views** | Views carry SQL, not semantics such as synonyms, relationships and metrics. Ossie is the right format. |

Configuration:

```yaml
semantic:
  enabled: true
  bucket: aistor-semantics        # created by the admin, with versioning enabled
  maxModelBytes: 1048576          # 1 MiB
  specVersion: "0.2.0.dev0"       # the pinned schema the BFF validates against
  sourceFormat: "{warehouse}.{namespace}.{table}"   # how `source` is written (§4.2)
```

---

## 4. From Iceberg schema to Ossie

### 4.1 Type mapping

| Iceberg | Ossie `datatype` | Default `dimension.is_time` |
|---|---|---|
| `boolean` | `Boolean` | — |
| `int`, `long` | `Integer` | — |
| `float`, `double` | `Float` | — |
| `decimal(p,s)` | `Decimal` | — |
| `date` | `Date` | true |
| `time` | `Time` | true |
| `timestamp`, `timestamp_ns` | `DateTime` | true |
| `timestamptz`, `timestamptz_ns` | `DateTimeTz` | true |
| `string`, `uuid` | `String` | — |
| `binary`, `fixed[n]`, `variant`, `geometry`, `geography`, `unknown` | `Opaque` | — |
| `struct` | not a field itself; each primitive leaf becomes a field, with a dotted expression `shipping.city` | — |
| `list`, `map` | `Opaque` field (whole value); users may add derived fields such as `cardinality(items)` | — |

The exact precision (for example `decimal(12,2)`) is kept in the field's
extension (§5), since Ossie has no precision attribute.

### 4.2 Generating a dataset from a table

| Ossie | Filled from |
|---|---|
| `name` | table name (made unique within the model) |
| `source` | `sourceFormat`, by default `{warehouse}.{ns joined by "."}.{table}`, which is how Spark, Trino and others address an Iceberg REST catalog whose catalog name equals the warehouse. The UI lets the admin set a per-warehouse alias when engines use another catalog name. |
| `primary_key` | the table's **identifier fields** (row key, editable in the schema dialog) |
| `description` | table property `comment` if set |
| `fields[]` | columns per §4.1, with `description` from the column `doc` |

Example, generated from the seeded `analytics.sales.orders` table:

```yaml
# yaml-language-server: $schema=https://…/ossie-schema.json
version: "0.2.0.dev0"
name: retail
description: Orders and customers for retail reporting
ai_context:
  instructions: Revenue is always net of returns; use net_revenue, not amount.
datasets:
  - name: orders
    source: analytics.sales.orders
    primary_key: [order_id]
    description: One row per customer order
    ai_context: { synonyms: [purchases, sales orders] }
    fields:
      - name: order_id
        expression: { dialects: [{ dialect: ANSI_SQL, expression: order_id }] }
        datatype: Integer
        description: Unique order identifier
        custom_extensions:
          - vendor_name: AISTOR_CATALOG
            data: '{"fieldId":1,"icebergType":"long"}'
      - name: order_ts
        expression: { dialects: [{ dialect: ANSI_SQL, expression: order_ts }] }
        datatype: DateTimeTz
        dimension: { is_time: true }
        custom_extensions:
          - { vendor_name: AISTOR_CATALOG, data: '{"fieldId":3,"icebergType":"timestamptz"}' }
      - name: shipping_country
        expression: { dialects: [{ dialect: ANSI_SQL, expression: shipping.country }] }
        datatype: String
        label: filter
        ai_context: { synonyms: [destination country] }
        custom_extensions:
          - { vendor_name: AISTOR_CATALOG, data: '{"fieldId":9,"icebergType":"string"}' }
    custom_extensions:
      - vendor_name: AISTOR_CATALOG
        data: '{"tableUuid":"4f0c…","warehouse":"analytics","namespace":["sales"],"table":"orders","schemaId":2}'
relationships:
  - name: orders_customer
    from: orders
    to: customers
    from_columns: [customer_id]
    to_columns: [customer_id]
metrics:
  - name: net_revenue
    description: Order amount minus returned amount
    datatype: Decimal
    expression:
      dialects:
        - dialect: ANSI_SQL
          expression: SUM(orders.amount) - COALESCE(SUM(returns.amount), 0)
```

---

## 5. Keeping models in sync with Iceberg

Ossie refers to columns by name, but in Iceberg a column can be renamed.
Each generated element therefore carries a small, spec-compliant
**`AISTOR_CATALOG` custom extension**:

- datasets record `tableUuid`, `warehouse`, `namespace`, `table` and `schemaId`;
- fields record `fieldId` and `icebergType`.

Other tools simply ignore the extension. This UI uses it to **detect drift**.
When a model is opened, and on demand, the BFF compares each dataset with the
table's current metadata:

| Drift | Detected by | Offered fix |
|---|---|---|
| Table renamed or moved | `tableUuid` found under another name | Update `source` and the extension |
| Table dropped | UUID not found | Mark the dataset broken; remove it or re-point it |
| Column renamed | same `fieldId`, new name | Rewrite `expression`, `primary_key`, relationship columns and metric references that used the old name |
| Column dropped | `fieldId` gone | Flag the field and every relationship or metric that depends on it |
| Type widened | `icebergType` changed | Update `datatype` |
| New columns | fields missing | "Add N new columns" (with docs and types) |
| Row key changed | identifier fields ≠ `primary_key` | Offer to sync |

Fixes are shown as a YAML diff and saved like any edit. Drift is also shown the
other way round: the table page's **Semantics** tab (§6.2) warns when a schema
change would break a model. The **Evolve schema** dialog lists models that use
a column before it is dropped or renamed. Because renames are fixed
automatically, it only warns.

---

## 6. UI

### 6.1 Namespace page → new **Semantic models** tab

A list of the namespace's models: name, datasets, metrics, last editor and time,
drift badge. Actions: **New model** (pick tables → generated draft), **Import
YAML** (validated, then mapped to tables by `source`), open, download,
delete (with step-up).

### 6.2 Table page → new **Semantics** tab

A column-oriented view of the same data for one table, built for the common
case of documenting a table without learning the Ossie structure:

- a grid of columns with editable business **name**, **description**, **synonyms**,
  **label**, **time dimension** and **datatype** (derived and read-only unless overridden);
- the models this table belongs to (a model picker when there are several);
- the row key and incoming and outgoing relationships, as chips.

Edits here update the table's dataset in the chosen model file.

### 6.3 Model editor (full page)

| Section | Content |
|---|---|
| **Overview** | name, description, model-level `ai_context` (instructions, example questions) |
| **Datasets** | add or remove tables; per dataset: description, synonyms, primary and unique keys, fields (the grid from §6.2), **derived fields** (expression editor) |
| **Relationships** | an ER diagram (SVG, datasets as boxes, FK arrows) and a form: from dataset + columns → to dataset + key columns. **Suggestions** come from names (`customer_id` ↔ a `customers` primary key) and from matching types. Key columns must match in count and type family |
| **Metrics** | name, description, datatype, and an SQL editor per dialect with syntax highlighting (existing `SqlView` tokenizer) and autocomplete of `dataset.field`. Referenced columns are checked live |
| **AI context** | instructions, synonyms and example questions at model, dataset, field and metric level, with a preview of the text an agent will see |
| **YAML** | the canonical document (read-only by default; an "Edit YAML" mode with server validation), download as YAML or JSON |
| **History** | object versions: who, when, diff between any two (existing `diff` view), restore |

Saving works like the Iceberg editors: a pending-changes summary, **Save**, and
a 409 conflict with a "reload and re-apply" flow. Semantic saves are separate
from Iceberg change sets; one S3 object is atomic, but it cannot join an
Iceberg transaction. That is stated in the change-set tray.

Search: the ⌘K server search (already built) also matches model, dataset,
metric and synonym names, so a user can type "revenue" and find `net_revenue`.

---

## 7. Backend

### 7.1 New package `internal/semantic`

- **Typed Go model** of the pinned spec version, decoded with `yaml.v3`.
  - Strict: unknown keys are rejected except inside `ai_context`.
  - Anchors and aliases are rejected, which prevents billion-laughs documents.
  - Size ≤ `maxModelBytes`; depth and count limits (for example ≤ 500 datasets, ≤ 2,000 fields per dataset).
- **Validation, in three layers**, returning `[{path: "datasets[2].fields[5].expression", message}]`:
  1. JSON Schema (`ossie-schema.json`, vendored at the pinned version and embedded in the binary);
  2. structure: unique names; `primary_key`, `unique_keys`, `from_columns` and `to_columns` name existing fields; relationship column counts match;
  3. **against Iceberg** (with the user's credentials): `source` resolves to a table; simple column expressions exist; datatypes are compatible.
     Metric expressions are parsed with a small ANSI SQL expression parser, only to extract `dataset.field` references; unknown references are errors.
- **Canonical serialization:** fixed key order, 2-space indentation, and a
  license-free header comment with the `$schema` hint. The same model
  always gives the same bytes, so diffs and ETags are meaningful.
- **Generator** (§4) and **drift detector** (§5), both pure functions of
  (model, table metadata) and fully unit-testable.
- **S3 object client:** the existing SigV4 signer with service `s3`, the same
  per-user STS credentials, the cluster endpoint and CA. Only four
  operations are allowed:
  - `GET`, `PUT` (with `If-Match` / `If-None-Match`) and `DELETE` on keys under the configured bucket;
  - `ListObjectsV2` / `ListObjectVersions` on prefixes.

  Keys are built from validated warehouse, namespace and model identifiers
  (the same validators as the catalog routes), so clients never send a raw key.

### 7.2 API (browser ↔ BFF)

Namespaces use the existing `%1F` encoding. All routes are behind a session, with CSRF protection on writes, audit logging and the rate limit.

```
GET    /api/c/:c/semantic/:wh/ns/:ns/models                       list (name, etag, lastModified, datasets, metrics)
POST   /api/c/:c/semantic/:wh/ns/:ns/models                       create {name, tables[]}  → generated draft, If-None-Match
GET    /api/c/:c/semantic/:wh/ns/:ns/models/:m                    model; Accept: application/json (default) | application/yaml; ETag
PUT    /api/c/:c/semantic/:wh/ns/:ns/models/:m                    save; body JSON or YAML; If-Match required → 200 {etag} | 409 | 422 {errors[]}
DELETE /api/c/:c/semantic/:wh/ns/:ns/models/:m                    step-up; If-Match
POST   /api/c/:c/semantic/validate                                 validate a body without saving (editor "check")
GET    /api/c/:c/semantic/:wh/ns/:ns/models/:m/drift              drift report + proposed patched model
GET    /api/c/:c/semantic/:wh/ns/:ns/models/:m/versions           history;  GET …/versions/:v  a past version
GET    /api/c/:c/semantic/:wh/tables/:uuid/usage                  models that use a table/columns (Semantics tab, schema dialog)
POST   /api/c/:c/semantic/generate                                 {tables[]} → dataset drafts (no save)
```

Errors reuse the existing shape. A 403 carries `X-Aistor-Action: s3:PutObject`
and the object ARN, so the UI shows exactly which permission is missing, as it
already does for catalog calls.

### 7.3 Serving models to tools and agents ("Ossie as an API")

Tools need to *read* models without a browser session. Options, in the
order we would ship them:

1. **Direct S3 (no new server surface).** Tools read
   `s3://aistor-semantics/<wh>/<ns>/<model>.ossie.yaml` with their own
   credentials. The files are canonical, schema-valid Ossie, and PBAC applies.
   This works on day one.
2. **Read-only Ossie endpoint on the BFF, bearer-token auth**, for HTTP-only consumers:
   ```
   GET /ossie/v1/models                          → index [{id, name, warehouse, namespace, url, etag}]
   GET /ossie/v1/models/{wh}/{ns}/{model}         → YAML (default) or JSON by Accept / ?format=
   ```
   - The token is an **OIDC access token from the same IdP** (a client-credentials
     service account or a user token), validated as a JWT against the IdP's JWKS.
   - The BFF exchanges it with `AssumeRoleWithWebIdentity`, as it does at login,
     and reads with those credentials, so each caller still sees only what its
     policy allows.
   - No API keys are stored in the BFF; the endpoint has its own rate limit;
     responses use `ETag` and `Cache-Control: private, no-cache`.
3. **MCP server** (later). It exposes `list_models`, `get_model` and
   `search_semantics` as tools, so agents fetch the semantic context for a question.
   It uses the same token model as (2).

---

## 8. Security

| Risk | Control |
|---|---|
| Users editing models they should not | S3 PBAC per prefix; no BFF-side ACLs; a 403 names the missing action |
| Stored XSS through descriptions or synonyms | Rendered as text only (as for all catalog strings); CSP unchanged |
| YAML bombs, huge documents | Aliases rejected, size/depth/count limits, strict typed decoding |
| Path/key injection | Keys built from validated identifiers; the object client allows only the configured bucket and 4 operations |
| Lost updates | `If-Match` ETags → 409; version history with restore |
| Prompt injection via `ai_context` into downstream agents | Shown with author and time in History; saves audited; an optional `semantic.aiContextMaxChars`; a clear "this text is given to AI agents" hint in the editor |
| Expressions running on someone's engine | The BFF never executes them; consumers run them with their own engine permissions, so Ossie grants no data access |
| Leaking table existence through models | A model only lists names its author could see. Readers of a model may learn table names without table access; documented, and prefixes can mirror warehouse/namespace policies |
| Audit | Every create, save, delete and restore is recorded (`kind: semantic`, model key, ETag before and after) and sent to the signed webhook |

---

## 9. Testing

- **Unit (Go):**
  - type mapping and generator (golden files);
  - canonical round-trip: parse → serialize → the same bytes;
  - each of the three validation layers, including the pinned `ossie-schema.json`;
  - every row of the drift table (§5);
  - the expression reference extractor.
- **Conformance:**
  - every model the UI writes validates with the upstream `validation/` tool in CI;
  - the upstream `examples/tpcds_semantic_model.yaml` imports cleanly.
- **Test server:** add an S3 object store (GET, PUT with conditional headers,
  DELETE, list, versions) to `aistortest`, with per-user PBAC on prefixes, the
  same way the catalog enforces allowed operations.
- **E2E:**
  - generate a model from two tables;
  - document columns, add a relationship from a suggestion, add a metric with autocomplete, save;
  - a second browser saves the same model and gets 409;
  - rename a column, then fix the drift from the model;
  - a read-only user can view but not save (and is told which permission is missing);
  - download YAML and check it against the schema;
  - the axe scan covers the new pages.

---

## 10. Delivery plan

| Step | Scope |
|---|---|
| **S1: Storage and API** | Config, S3 object client (signer service `s3`), typed model + schema validation + canonical YAML, CRUD/list/versions API with ETags, audit, test-server object store |
| **S2: Generate and document** | Generator, **Semantics** tab on tables, model list on namespaces, the field grid, YAML view and download |
| **S3: Model editor** | Relationships (suggestions and ER diagram), metrics editor with reference checking, AI context, history, diff, restore |
| **S4: Drift** | `AISTOR_CATALOG` extension, drift report and fixes, warnings in the Evolve schema dialog, usage API |
| **S5: Serving** | Read-only `/ossie/v1` with OIDC bearer tokens; ⌘K semantic search; then MCP |

S1–S2 are useful on their own: documented tables, published as standard Ossie files.

---

## 11. Open questions

1. **Spec stability.** Ossie is at `0.2.0.dev0`. We pin one version, embed its
   schema, and write `version` accordingly. Later we add a migration step when
   the spec moves. Which version should v1 of this feature target?
2. **Model scope.** Per namespace (proposed), per warehouse, or free-form folders?
3. **Conditional writes.** Confirm that the AIStor release in use honours
   `If-Match` / `If-None-Match` on `PutObject`. If not, fall back to comparing
   version IDs before the write, which leaves a short race window.
4. **The `source` naming convention** engines should use. Is the warehouse name
   the catalog name in our users' Spark/Trino/Dremio setups?
5. **Default dialect.** `ANSI_SQL` for everything, or also `DATABRICKS` / `OSSIE_SQL_2026`
   variants for metrics that need engine-specific functions?
6. Should a small pointer be written into Iceberg table properties
   (`ossie.models=retail`), so engines and other catalog UIs can discover models?
   It costs a table commit per change, so it is off by default.
7. The bucket name and who creates it (an admin step, or the UI when the caller may).

---

## 12. Implementation notes (differences from the proposal)

- **Serving paths include the cluster:** `/ossie/v1/models/{cluster}/{warehouse}/{namespace}/{model}`, with namespace levels joined by `%1F` (as in the UI API). The index is `/ossie/v1/models`, and the Ossie JSON Schema is public at `/ossie/v1/schema`.
- **Bearer tokens are JWTs only** (ID or access tokens from the configured issuer). The checks are signature, issuer and expiry, plus an audience in `semantic.serving.audiences` (default: the client ID). Exchanged AIStor credentials are cached per token and cluster until they expire. Rate limits are per token subject and shared through Redis when configured.
- **MCP:**
  - Stateless Streamable HTTP with JSON responses (no SSE stream).
  - Protocol revisions 2025-06-18, 2025-03-26 and 2024-11-05.
  - Read-only tools, with `structuredContent` for JSON results.
  - Foreign `Origin` headers are rejected (DNS-rebinding protection).
  - `/.well-known/oauth-protected-resource` points clients at the issuer.
- **Delete** reads the object and compares its ETag before `DELETE`, because conditional deletes are not universally supported. Saves use conditional `PutObject` (`If-Match` / `If-None-Match: *`).
- **Editors are recorded** as `x-amz-meta-aistor-ui-editor` on each version. The history view reads it with `HEAD` for the newest 30 versions. Direct S3 writers can set anything there; the audit log is authoritative.
- **Two helper endpoints** keep previews exact: `POST /semantic/render` (canonical YAML of a draft, as `{"yaml": …}`) and `POST /semantic/parse` (YAML to model, for the YAML editor and repairs).
- **Relationship suggestions** match a field to another dataset's single-column primary key by name (`customer_id`, or `id` ↔ `<dataset>_id`) and type.
- **Not implemented (open question 6):** writing a pointer property into Iceberg tables. Usage is found by scanning models (`semantic.maxScan`), which is enough for the table Semantics tab and the schema-evolution warning.
- **Upstream conformance:** the official `ossie-schema.json` and the TPC-DS example are vendored under `backend/internal/semantic/`. A unit test imports the example and checks that the canonical output round-trips.
