# syntax=docker/dockerfile:1
# noddle — multi-stage build: React SPA (Vite) -> FastAPI runtime.
#
# Layout inside the image MIRRORS the repo (/app/backend, /app/web/dist)
# because backend/app/config.py derives paths from the backend/ package root:
# REPO_ROOT = backend/.. and frontend_path() serves web/dist when it exists.

# ---------- Stage 1: build the React SPA ----------
FROM node:20-slim AS web-build
WORKDIR /web
# Corporate-proxy support (opt-in, default = strict TLS): on networks with TLS
# interception (e.g. VIB firewall re-signing registry.npmjs.org), pass the
# proxy's root CA PEM so npm can verify the chain:
#   docker build --build-arg EXTRA_CA_CERT="$(cat corp-root-ca.pem)" .
ARG EXTRA_CA_CERT=""
# Install deps first so the layer is cached across source-only changes.
COPY web/package.json web/package-lock.json ./
RUN if [ -n "$EXTRA_CA_CERT" ]; then \
        printf '%s\n' "$EXTRA_CA_CERT" > /tmp/extra-ca.pem; \
        export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; \
    fi \
    && npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
    && test -e node_modules/.bin/vite
COPY web/ ./
RUN npm run build

# ---------- Stage 2: Python runtime ----------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Deps first (cache-friendly): picks up any change to requirements.txt
# (e.g. psycopg[binary]) automatically.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY --from=web-build /web/dist /app/web/dist

# Non-root user. backend/storage is excluded by .dockerignore, so create it
# here and hand it to the app user (the named volume inherits this ownership
# on first use; the app also mkdir -p's subdirs itself).
RUN useradd --create-home --uid 10001 noddle \
    && mkdir -p /app/backend/storage \
    && chown -R noddle:noddle /app/backend/storage
USER noddle

WORKDIR /app/backend
EXPOSE 8000
# Shell form so $PORT expands (Railway injects PORT; local compose keeps 8000).
# --proxy-headers: behind Railway's edge, request.base_url must reflect the
# real https scheme/host (OIDC redirect_uri is derived from it).
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
