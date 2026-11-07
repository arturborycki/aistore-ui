# Next session memo

_Last updated: 2026-11-06._

## State of the repository

- `main` is at `0de91fd`. CI and Security are green. No open pull requests
  and no Dependabot alerts.
- **Latest release: v0.2.0** (2026-11-05), from tag `v0.2.0` on `a5f832d`.
  - Image: `ghcr.io/arturborycki/aistore-ui:0.2.0` (also `0.2`), digest
    `sha256:c733099abab60fa77d6936bb9faaa4c019e967989f94bbe69a36b41ffcd654ce`,
    for amd64 and arm64.
  - Earlier releases: v0.1.1 (2026-11-04), v0.1.0 (2026-10-09). Notes are in
    `CHANGELOG.md`.
  - `latest` follows `main`.
- **`main` is protected**:
  - changes must come through pull requests;
  - 12 required checks must pass;
  - no force-push or deletion, and no bypass.
- Open code-scanning items are only Trivy *notes* for the distroless base
  image: `tzdata` and `ca-certificates` (DLA-4792-1, -4845-1, -4854-1,
  -4867-1). They clear when distroless ships the updates.
- Dependabot security alerts and automatic security-fix PRs are on. Actions
  updates come grouped, and the open-PR limit is 10. TypeScript 7 is ignored
  (see Next steps).

## Done in the last sessions

- **2026-11-05: environment variable configuration (v0.2.0).**
  - What: every setting can be `AISTOR_UI_<YAML path, upper snake case>`.
    The first cluster and session key are `AISTOR_UI_CLUSTER_*` and
    `AISTOR_UI_SESSION_KEY_*`. Variables override the file, and the file is
    optional. Code: `backend/internal/config/env.go`.
  - Unknown `AISTOR_UI_*` variables fail startup with their name.
    Exemptions: variables the file references as `${VAR}`, the
    `-config env:NAME` variable, and `AISTOR_UI_CONFIG` / `AISTOR_UI_DEBUG`.
  - Why: the TrueNAS review said a template-rendered config file is a
    non-starter because users can't modify it.
- **2026-11-05: TrueNAS YAML install.** `deploy/truenas` pins `:0.2.0`.
  TrueNAS offers versioned upgrades only for catalog apps. To upgrade a YAML
  app, edit the image tag and save. The README's wrong "Edit → Save pulls
  latest" claim is fixed.
- **2026-11-04:**
  - #29 combined nine failing Dependabot PRs: Go 1.26.10, go-jose, chi,
    vite, vitest, undici, a `minimatch` override, Playwright 1.64.1,
    axe-core 4.14;
  - WCAG 2.5.3 label-in-name fixes;
  - v0.1.1;
  - catalog PR submitted.
- **2026-10-09:** v0.1.0, the catalog draft, App Request #6035.
- **Earlier:**
  - columns, statistics, the Files tab, catalog configuration, the theme
    switch;
  - TrueNAS YAML packaging;
  - CI hardening;
  - endpoints only from configuration.

## TrueNAS community catalog (in progress)

- **PR:** https://github.com/truenas/apps/pull/6397, from the branch
  `add-iceberg-catalog-ui` in the fork `arturborycki/apps`. The head is
  `c17ae83`. It is linked from App Request #6035.
- **Review history:**
  - stavros-k (2026-11-05) on `templates/docker-compose.yaml`: rendering
    the app's config file is "a non-starter".
  - We replied on that thread (2026-11-06,
    https://github.com/truenas/apps/pull/6397#discussion_r4487768147) and
    pushed `c17ae83`: env-only configuration, pinned to
    `0.2.0@sha256:c733099a…`, and a new `access_key_sign_in` question.
- **Submitted app:**
  - app `iceberg-catalog-ui`, "Iceberg Catalog UI (for AIStor)", category
    storage;
  - catalog `version` 1.0.0 (not yet merged, so not bumped);
    `app_version` 0.2.0;
  - template library 2.3.18; default port 30553; tests use 8443.
- **Waiting on:** the maintainer's re-review, and approval of workflows for a
  first-time contributor (their CI hasn't run yet).
- `deploy/truenas-catalog/` mirrors the submission. `SUBMISSION.md` has the
  status and the process for updates.

## Deployments

- **TrueNAS custom YAML app** `aistor-catalog-ui` (port 30443). The user's
  install may still be on `:latest`. Suggested: Edit → change the image to
  `:0.2.0` → Save. Afterwards, upgrade by editing the tag. Or pull `latest`
  from System → Shell:
  `sudo midclt call -j app.pull_images aistor-catalog-ui '{"redeploy": true}'`.
  The agent has no SSH or API access to the NAS.
- **Local workstation container** `aistor-ui-local`: HTTPS on 443 with
  mkcert; config in the git-ignored `deploy/local/` (never commit it). Node
  tools need `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.

## Next steps

1. **Follow truenas/apps#6397.**
   - Check for new review comments and the CI result once workflows are
     approved.
   - Fixes: push to `add-iceberg-catalog-ui` in the fork (clone it, add
     `upstream`, branch from that).
   - Retest locally with the plain-write render shim (see `SUBMISSION.md`).
   - Posting there acts under the user's account. The user has approved
     responding to this review; ask again for anything beyond that.
2. **Next app release:**
   - add a `CHANGELOG.md` entry;
   - `gh release create vX.Y.Z` on `main` (this needs the user's OK, since
     auto mode treats it as a public surface);
   - CI publishes the images;
   - update the catalog PR's digest if it isn't merged yet, otherwise
     TrueNAS's Renovate bot does it;
   - bump the tag in `deploy/truenas/docker-compose.yaml`.
3. **TypeScript 7:** Dependabot ignores the major version, because
   typescript-eslint 8.x supports TypeScript below 6.1 only. When that
   changes, comment `@dependabot unignore typescript` and upgrade both.
4. Optional: simplify `deploy/truenas/docker-compose.yaml` to plain
   `AISTOR_UI_*` variables, without the embedded YAML. The current file
   still works and is covered by a test.
5. Ideas not started:
   - Redis-backed sessions;
   - a staged-create UI;
   - an OIDC section in the catalog app's form.

## Blockers and open questions

- The catalog merge depends on TrueNAS maintainers (re-review, CI approval,
  and the CDN upload of the icon and screenshots).
- TrueNAS's validation image can't write files under amd64 emulation on
  Apple Silicon (`openat2`). Local rendering uses a plain-write shim; their
  CI is the final check.
- The user's local Go (1.27.1) lacks stdlib security patches. Builds use
  1.26.10 through the toolchain directive and Docker. Suggest
  `brew upgrade go`.
- Stale local branches can be deleted: `claude/catalog-ui-design`,
  `claude/session-memo` and `claude/session-memo-2026-10-17`.
