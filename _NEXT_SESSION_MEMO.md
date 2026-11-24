# Next session memo

_Last updated: 2026-11-24._

## State of the repository

- **Latest release: v0.2.1** (2026-11-22, security), from tag `v0.2.1` on
  `8e4f182`.
  - Image: `ghcr.io/arturborycki/aistore-ui:0.2.1` (also `0.2`), digest
    `sha256:06942d87152e782e5a4ed9acdb6bbbe465ff4cba8d138866b891002af88c107f`,
    for amd64 and arm64. Smoke-tested locally: it starts in env-only mode and
    reports `v0.2.1`.
  - Earlier releases: v0.2.0 (2026-11-05), v0.1.1 (2026-11-04), v0.1.0
    (2026-10-09). Notes are in `CHANGELOG.md`.
  - `latest` follows `main`.
- No open PRs and no Dependabot alerts after #38 (Go 1.26.11 for
  GO-2026-6859, go-jose 4.1.9, jsdom 31, Playwright 1.65; it superseded
  Dependabot #34–#37).
- **`main` is protected**:
  - changes must come through pull requests;
  - 12 required checks must pass;
  - no force-push or deletion, and no bypass;
  - auto-merge is off for the repository, so wait for the checks and then
    `gh pr merge`.
- Open code-scanning items are only Trivy *notes* for the distroless base
  image: `tzdata` and `ca-certificates` (DLA-4792-1, -4845-1, -4854-1,
  -4867-1). They clear when distroless ships the updates.
- Dependabot security alerts and automatic security-fix PRs are on. Updates
  come grouped, and the open-PR limit is 10. TypeScript 7 is ignored (see
  Next steps).
- To publish a release, `gh release create` needs the full commit SHA in
  `--target`.

## Done in the last sessions

- **2026-11-22: v0.2.1.**
  - The release itself.
  - `deploy/truenas` now pins `:0.2.1`.
  - The catalog PR is pinned to 0.2.1, with a ping on it (see below).
- **2026-11-16:**
  - #38: Go 1.26.11 and the dependency updates.
  - #39:
    - `deploy/truenas/docker-compose.yaml` now uses plain `AISTOR_UI_*`
      variables instead of an embedded YAML block. Old installs keep
      working; only the tag changes.
    - The login page showed `vv0.2.0`; fixed.
- **2026-11-05: environment variable configuration (v0.2.0).**
  - Every setting can be `AISTOR_UI_<YAML path, upper snake case>`. The
    first cluster and session key are `AISTOR_UI_CLUSTER_*` and
    `AISTOR_UI_SESSION_KEY_*`. Code: `backend/internal/config/env.go`.
  - Unknown `AISTOR_UI_*` variables fail startup. Exemptions: variables the
    file references as `${VAR}`, the `-config env:NAME` variable, and
    `AISTOR_UI_CONFIG` / `AISTOR_UI_DEBUG`.
- **Earlier:**
  - v0.1.1 and v0.1.0;
  - the catalog draft and App Request #6035;
  - columns, statistics, the Files tab, catalog configuration, the theme
    switch;
  - TrueNAS YAML packaging;
  - CI hardening;
  - endpoints only from configuration.

## TrueNAS community catalog (merged)

- **Merged 2026-11-24** by stavros-k: truenas/apps#6397 (merge commit
  `a547331`), community train.
  - App `iceberg-catalog-ui`, titled "Iceberg Catalog UI".
  - Catalog version 1.0.0, app version 0.2.1.
  - Template library 2.3.21; default port 30621.
- The maintainer finished the app themselves before merging. The details are
  in `deploy/truenas-catalog/SUBMISSION.md`. In short:
  - an explicit health check (`use_built_in` is only for custom apps);
  - `type: uri` instead of regexes;
  - one test file;
  - a generated README.
- **Updates:** Renovate there bumps the tag and digest on each `vX.Y.Z`
  release. Template or form changes need our own PR from the fork, with
  `version` bumped.
- `deploy/truenas-catalog/iceberg-catalog-ui/` is a copy of the merged app.

## Deployments

- **TrueNAS custom YAML app** `aistor-catalog-ui` (port 30443). To upgrade:
  Edit → change the image tag to `:0.2.1` → Save. If the install is on
  `:latest`, run this from System → Shell:
  `sudo midclt call -j app.pull_images aistor-catalog-ui '{"redeploy": true}'`.
  The agent has no SSH or API access to the NAS.
- **Local workstation container** `aistor-ui-local`: stopped, on an old
  build. HTTPS on 443 with mkcert; config in the git-ignored `deploy/local/`
  (never commit it). Recreate it with `ghcr.io/arturborycki/aistore-ui:0.2.1`
  if needed. Node tools need
  `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.

## Next steps

1. **Check the catalog listing.** Once TrueNAS publishes the catalog, the
   app shows under Apps → Discover Apps ("Iceberg"). When the next release
   is cut, a Renovate PR should appear on truenas/apps.
2. **Upgrade the user's TrueNAS app to 0.2.1** (the user does it; see
   Deployments). Then run a live sign-in test. The lab AIStor host wasn't
   reachable from the Mac on 2026-11-16 (no ping replies, S3 port timed out).
3. **TypeScript 7:** Dependabot ignores the major version. typescript-eslint
   8.72.1 still supports TypeScript below 6.1 only. When that changes,
   comment `@dependabot unignore typescript` and upgrade both.
4. Ideas not started:
   - Redis-backed sessions;
   - a staged-create UI;
   - an OIDC section in the catalog app's form.

## Blockers and open questions

- TrueNAS's validation image can't write files under amd64 emulation on
  Apple Silicon (`openat2`). Local rendering uses a plain-write shim; their
  CI is the final check.
- **Local workstation:**
  - `fuse-t` is at 1.2.9 (done 2026-11-22).
  - The `apps_validation` image was removed after the merge. Pull it again
    for a future template PR.
