# The TrueNAS community catalog app

**Status (2026-11-24):** merged into the `community` train of
[truenas/apps](https://github.com/truenas/apps) as **Iceberg Catalog UI**
(`iceberg-catalog-ui`), in
[truenas/apps#6397](https://github.com/truenas/apps/pull/6397). It shipped as
catalog version 1.0.0 with app version 0.2.1, and its default port is 30621.
The App Request was [truenas/apps#6035](https://github.com/truenas/apps/issues/6035).

`iceberg-catalog-ui/` here is a copy of the merged app (truenas/apps
`a547331`). The upstream copy is the real one; refresh this copy when it
changes.

## Updates

- **New releases:** truenas/apps runs Renovate on image tags. Each new
  `vX.Y.Z` release here becomes a PR there, which bumps the tag and digest in
  `ix_values.yaml`, `app_version`, and the catalog `version`. Nothing to do on
  our side.
- **Changes to the template or the form:** open a PR on truenas/apps from a
  branch of the fork `arturborycki/apps`, based on a fresh `upstream/master`.
  Bump `version` in `app.yaml`. Use the PR template's "App Update" section.

## What the maintainer changed before merging

The maintainer (stavros-k) made these changes and asked for these conventions:

- **Health check:** `healthcheck.use_built_in()` is only for custom apps.
  Catalog apps set an explicit test:
  `/usr/local/bin/aistor-ui -healthcheck http://127.0.0.1:<internal_metrics_port>/healthz`.
- **URL fields:** use `type: uri` instead of `valid_chars` regexes. The form
  no longer rejects a path or a trailing slash, so the app normalizes them:
  a trailing slash or path on the public URL is ignored, and extra origins
  become `scheme://host[:port]`.
- **Environment variables:** variables that come from optional answers are
  always set, possibly empty. Empty lists are ignored.
- **Tests:** only `basic-values.yaml`. Its health check already goes over
  HTTPS, so a separate HTTPS test isn't needed.
- **README and notes:** follow the other apps. The README is generated, with
  the warnings block, and there is no custom notes body.
- **Other changes:**
  - template library 2.3.21;
  - port 30621;
  - the title "Iceberg Catalog UI";
  - the screenshots on the TrueNAS CDN;
  - the changelog URL now points at the GitHub releases;
  - a declared `host_network` risk.

## Testing a change locally

Rendering needs TrueNAS's `apps_validation` image on Linux amd64. Under
emulation on Apple Silicon the image fails on the `openat2` system call, so
local rendering needs a shim that writes files the plain way. Their CI is the
final check.

```bash
./.github/scripts/ci.py --app iceberg-catalog-ui --train community --test-file basic-values.yaml
./.github/scripts/port_validation.py
```

The generated `templates/library/` is git-ignored in truenas/apps (their CI
creates it). Don't commit it.
