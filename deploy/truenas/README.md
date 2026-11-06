# AIStor Catalog UI on TrueNAS

Runs the UI as a TrueNAS custom app (TrueNAS 24.10 "Electric Eel" or later,
which runs apps with Docker). The UI serves HTTPS itself on port 30443 and
signs users in with their AIStor access keys.

## Install

1. Open **Apps → Discover Apps → ⋮ → Install via YAML**. Name the app
   `aistor-catalog-ui`.
2. Paste [`docker-compose.yaml`](docker-compose.yaml) and edit the
   `x-settings` block at the top:

   | Setting | What to put there |
   | --- | --- |
   | `PUBLIC_URL` | The address people open, e.g. `https://truenas.local:30443`. Must be `https`. Required. |
   | `EXTRA_ORIGINS` | Other addresses of the same UI, comma separated, e.g. `https://<nas-ip>:30443`. Can be empty. |
   | `AISTOR_ENDPOINT` | The AIStor **S3 API** (not the console), e.g. `http://<aistor-host>:<s3-port>`. Required. |
   | `ADMIN_USERS` | AIStor users who may see everyone's activity, comma separated. |
   | `SEMANTIC_ENABLED`, `SEMANTIC_BUCKET` | Semantic models. The bucket must exist with versioning enabled; set `SEMANTIC_ENABLED` to `"false"` to turn them off. |

3. Save. When the app shows **Running**, open `PUBLIC_URL` in a browser.

The app does not start until `PUBLIC_URL` and `AISTOR_ENDPOINT` are set.
**Apps → aistor-catalog-ui → Logs** shows which setting is missing.

The key that encrypts sessions is created on first start and kept in the
app's volume (`session.key`), next to the certificate.

## The certificate

On first start the UI creates a self-signed certificate for `PUBLIC_URL`'s host,
the `EXTRA_ORIGINS` hosts and `localhost`. It keeps the certificate in the app's
volume, so browsers ask you to accept it only once. The app log prints the
certificate's SHA-256 fingerprint so you can compare it with what the browser
shows. The UI creates a new certificate when the host names change or the
current one is within 30 days of expiring.

To avoid the browser warning, use a certificate the browsers already trust,
e.g. one from [mkcert](https://github.com/FiloSottile/mkcert) (whose root is
installed on the clients) or from your own CA:

1. Put `cert.pem` (full chain) and `key.pem` in a dataset, e.g.
   `/mnt/tank/apps/aistor-ui/tls`, readable by UID 65532.
2. In the YAML add under `volumes:`
   `- /mnt/tank/apps/aistor-ui/tls:/etc/aistor-ui/tls:ro`, and in the
   configuration set `tlsSelfSigned: false`,
   `tlsCertFile: /etc/aistor-ui/tls/cert.pem` and
   `tlsKeyFile: /etc/aistor-ui/tls/key.pem`.

## Updating

TrueNAS shows version numbers and an Upgrade button only for catalog apps.
For an app installed from YAML, the image tag is the version. To upgrade:

1. Find the newest release on the
   [releases page](https://github.com/arturborycki/aistore-ui/releases).
2. Open **Apps → aistor-catalog-ui → Edit**, change the tag in
   `image: ghcr.io/arturborycki/aistore-ui:<version>`, and save. TrueNAS pulls
   that image and restarts the app. The certificate and session key in the
   app's volume are kept, but sessions are in memory, so users sign in again.

An install that uses the moving `latest` tag isn't offered updates. Refresh it
from **System → Shell** with
`sudo midclt call -j app.pull_images aistor-catalog-ui '{"redeploy": true}'`,
or switch it to a release tag as above.

## Notes

- Sessions are kept in memory, so restarting the app signs everyone out. For
  more than one replica, or to keep sessions across restarts, point
  `session.store` at a Redis instance (`redis://…`).
- The container runs as a non-root user with a read-only root filesystem, no
  Linux capabilities and a 1 GiB memory limit.
- The health check reads `/healthz` on the internal metrics port 9090, which is
  not published.
