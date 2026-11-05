# Next session memo

_Last updated: 2026-11-04._

## State of the repository

- **Latest release: v0.1.1** (2026-11-04), from tag `v0.1.1` on `f8012a2`.
  - Image: `ghcr.io/arturborycki/aistore-ui:0.1.1` (also `0.1`), digest
    `sha256:cf975acc23b265766959423dc9acb1ceac72416f142017e910cd4ab1cd8f1d39`,
    for amd64 and arm64.
  - Trivy finds no medium, high or critical issues. `latest` follows `main`.
  - The previous release was v0.1.0 (2026-10-09). Notes are in
    `CHANGELOG.md`.
- **`main` is protected** by the ruleset "Protect main":
  - changes must come through pull requests (no approving review required);
  - 12 required checks must pass;
  - force-pushes and deletion are blocked;
  - there is no bypass.
- No open pull requests. No Dependabot alerts.
- Open code-scanning notes are base-image ones only: `tzdata` and
  `ca-certificates` (Debian DLA-4792-1, -4845-1, -4854-1, -4867-1). They
  clear when distroless ships those updates; the 0.1.1 changelog says so.
- Dependabot security alerts and automatic security-fix PRs are enabled.
  Actions updates come as one grouped PR, and the open-PR limit is 10.
  TypeScript 7 is ignored (see Next steps).

## Done in the last sessions

- 2026-11-04:
  - Combined nine failing Dependabot PRs into #29. Each one fixed only part
    of the advisories, so the security checks failed on every one.
  - Updates in #29:
    - Go 1.26.10, go-jose 4.1.8, chi 5.5.0;
    - vite, vitest and undici;
    - a `minimatch` 11 override in the frontend;
    - Playwright 1.64.1 and axe-core 4.14.
  - Fixed what the new axe rule `label-content-name-mismatch` (WCAG 2.5.3)
    flagged: the account menu, catalog search and session revoke buttons.
  - Released v0.1.1.
  - Submitted the TrueNAS catalog PR (see below).
- 2026-10-09:
  - v0.1.0;
  - `session.keys[].generate`;
  - the catalog draft;
  - App Request truenas/apps#6035.
- Earlier:
  - columns, column statistics, the Files tab, catalog configuration, the
    theme switch;
  - TrueNAS YAML packaging (`deploy/truenas/`);
  - CI hardening;
  - endpoints only from configuration.

## TrueNAS community catalog

- **PR:** https://github.com/truenas/apps/pull/6397, from the branch
  `add-iceberg-catalog-ui` in the fork `arturborycki/apps`. It is linked from
  issue #6035 (labelled `app-request`; no maintainer reply as of 2026-11-04).
- **What was submitted:** app `iceberg-catalog-ui`, title "Iceberg Catalog UI
  (for AIStor)", category storage.
  - App version 0.1.1, pinned to its digest.
  - Template library 2.3.18. `container-utils` comes from
    `ghcr.io/truenas/containers/container-utils`.
  - Default port 30553, the next free port per `port_validation.py`. Tests
    use port 8443.
- `deploy/truenas-catalog/` mirrors what was submitted. `SUBMISSION.md` has
  the steps and how to submit updates.
- When the PR was opened, its CI was waiting for a maintainer to approve
  workflows for a first-time contributor.

## Deployments

- **TrueNAS custom YAML app** `aistor-catalog-ui` (port 30443). It pulls
  `latest`. To update it, the user runs in TrueNAS System → Shell:
  `sudo midclt call -j app.pull_images aistor-catalog-ui '{"redeploy": true}'`.
  The agent has no SSH or API access to the NAS.
- **Local workstation container** `aistor-ui-local`: HTTPS on port 443 with a
  mkcert certificate; config in the git-ignored `deploy/local/` (never commit
  it). Node tools need
  `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.

## Next steps

1. **Follow truenas/apps#6397.** Answer review comments by pushing to
   `add-iceberg-catalog-ui` in `arturborycki/apps`, and bump the app's
   `version` for each change. Once workflows are approved, check the CI
   result. Posting there acts under the user's account, so do it only when
   the user asks.
2. After a merge, TrueNAS's Renovate bot bumps the catalog image for each new
   `vX.Y.Z`. The user may then move from the custom YAML app to the catalog
   app. They're separate installs: the new one creates its own certificate
   and session key.
3. The user's TrueNAS custom app can pick up 0.1.1 now with the `midclt`
   command above (it pulls `latest`, which equals 0.1.1).
4. **TypeScript 7:** Dependabot ignores the major version, because
   typescript-eslint 8.x supports TypeScript below 6.1 only. When that
   changes, comment `@dependabot unignore typescript` and upgrade both.
5. **Housekeeping:** the user's local Go is 1.27.1, which has stdlib
   advisories. The project builds with 1.26.10 through the toolchain
   directive and Docker, so this only affects ad-hoc local tools. Suggest
   upgrading Go with Homebrew.
6. Ideas not started:
   - Redis-backed sessions;
   - a staged-create UI;
   - OIDC in the catalog app's form.

## Blockers and open questions

- The catalog merge depends on TrueNAS maintainers (review, CI approval, and
  uploading the icon and screenshots to their CDN).
- TrueNAS's validation tooling can't write files under amd64 emulation on
  Apple Silicon. Local rendering uses a plain-write shim, described in the
  PR. Final checks run in their CI.
- Stale local branches can be deleted:
  - `claude/catalog-ui-design` and `claude/deps-2026-11` (merged);
  - `claude/session-memo` and `claude/session-memo-2026-10-17` (superseded
    memos).
