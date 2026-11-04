# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/). Container images are published as
`ghcr.io/arturborycki/aistore-ui:<version>`.

## [0.1.1] - 2026-11-04

Security and accessibility update. No configuration changes.

### Security

- Go 1.26.10: crypto/x509 fix, GO-2026-6809.
- go-jose 4.1.8 (CVE-2026-116587) and chi 5.5.0 (CVE-2026-114437).
- Updated vite, vitest and undici in the frontend build.
- minimatch 11.0.4 in the lint toolchain (GHSA-g3hv-75wg-m249).
- Rebuilt on the current distroless base image.

### Accessibility

- The account menu, catalog search and session revoke buttons have
  accessible names that include their visible text (WCAG 2.5.3, Label in
  Name). Voice-control users can activate them by saying what they see.

## [0.1.0] - 2026-10-09

First release.

### Catalog

- Browse and manage warehouses, namespaces, tables and views of an AIStor
  Tables (Apache Iceberg REST) catalog:
  - create, register, rename and drop;
  - evolve schemas, partitioning, sort orders and row keys;
  - maintenance, encryption and tags.
- Snapshots, branches and tags; time travel; snapshot expiry.
- Columns in the explorer tree and in table lists. A column detail panel shows:
  - the column's role (row key, partition field, sort key);
  - its schema history;
  - statistics from the data files' metrics: values, nulls, NaN, min, max and
    size on disk.
- A Files tab for any snapshot: partitions, data and delete files, and
  manifests, read from the table's manifests with the user's own credentials.
- Warehouse catalog configuration (GetConfig).
- Activity log, sessions page and catalog search.

### Semantic layer

- Apache Ossie semantic models:
  - built from catalog tables;
  - edited in the UI (datasets, relationships, metrics, YAML);
  - kept in sync with schema changes;
  - served to tools and agents through a read-only API and MCP.

### Security

- Sign-in with OIDC, LDAP or AIStor access keys, exchanged for per-user
  temporary credentials. The UI never holds a shared credential.
- Server-side encrypted sessions, CSRF protection, and re-authentication
  before destructive actions.
- A strict Content Security Policy, isolation headers (COOP, COEP, CORP) and
  rate limits.
- An audit log with optional signed webhook delivery.

### Deployment

- One non-root, distroless image for amd64 and arm64.
- Docker Compose, Kubernetes (Kustomize), Helm, and a TrueNAS app
  (Install via YAML).
- `server.tlsSelfSigned` creates and keeps a self-signed certificate.
- `session.keys[].generate` creates and keeps the session key.
- `-config env:NAME` reads the configuration from an environment variable.
- `-healthcheck auto` probes the server's own listener.
- Light, dark and system themes. WCAG 2.1 AA contrast is checked in CI.

[0.1.1]: https://github.com/arturborycki/aistore-ui/releases/tag/v0.1.1
[0.1.0]: https://github.com/arturborycki/aistore-ui/releases/tag/v0.1.0
