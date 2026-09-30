# syntax=docker/dockerfile:1.7
#
# AIStor Catalog UI — single image: Go backend-for-frontend with the React SPA embedded.
# Build:  docker build -t aistor-catalog-ui --build-arg VERSION=$(git describe --tags --always) .
# Base images are build args so air-gapped builds can point at an internal mirror.
# Behind a TLS-inspecting proxy, pass its CA bundle: --secret id=extra_ca,src=/path/ca.pem

ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot

# ---- frontend
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- backend (cross-compiled for the target platform, no cgo)
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    go mod download
COPY backend/ ./
COPY --from=web /src/frontend/dist ./internal/web/dist
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/aistor-ui ./cmd/aistor-ui && \
    mkdir -p /out/data

# ---- runtime: distroless, non-root, no shell
FROM ${RUNTIME_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="AIStor Catalog UI" \
      org.opencontainers.image.description="Multi-user web UI for the MinIO AIStor Tables (Apache Iceberg) catalog" \
      org.opencontainers.image.source="https://github.com/arturborycki/aistore-ui" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/aistor-ui /usr/local/bin/aistor-ui
# Writable state (e.g. a generated self-signed certificate); a volume mounted
# here inherits the non-root ownership.
COPY --from=build --chown=65532:65532 /out/data /var/lib/aistor-ui
USER 65532:65532
EXPOSE 8080 8443 9090
# "auto" probes the metrics listener (or the main one when it is plain HTTP).
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/aistor-ui", "-healthcheck", "auto"]
ENTRYPOINT ["/usr/local/bin/aistor-ui"]
CMD ["-config", "/etc/aistor-ui/config.yaml"]
