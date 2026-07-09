#!/usr/bin/env bash
# railway-sync-env.sh — env-sync tool shared across Noddle repos.
# Pushes secrets/config from the root .env to Railway following the DECLARATIVE
# manifest `railway.env.map` (edit the manifest, not this script). Anti-ad-hoc:
#   - only pushes variables present in the manifest (per-service allowlist)
#   - blocks infra vars (Railway provides them via fromService; local values
#     would break prod)
#   - blocks localhost values unless --force-local
#   - values travel via --stdin (never exposed in process list / shell history)
#
# Usage:  railway-sync-env.sh [--dry-run] [--only VAR] [--env production] [--deploy] [--force-local]
#   --dry-run      Print the plan, push nothing
#   --only VAR     Sync a single variable
#   --env ENV      Railway environment (default: production)
#   --deploy       Trigger a redeploy after setting (default: --skip-deploys;
#                  build-time vars are baked at build so a redeploy is REQUIRED)
#   --force-local  Allow values containing localhost/127.0.0.1 (blocked by default)
#
# Manifest `railway.env.map` (next to the root .env), one line per variable:
#   VAR_NAME  service1,service2

set -euo pipefail

ENV_FILE=".env"
MAP_FILE="railway.env.map"
RAILWAY_ENV="production"
DRY_RUN=0 ONLY="" DEPLOY=0 FORCE_LOCAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --only) ONLY="$2"; shift ;;
    --env) RAILWAY_ENV="$2"; shift ;;
    --deploy) DEPLOY=1 ;;
    --force-local) FORCE_LOCAL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -f "$ENV_FILE" ]] || { echo "❌ $ENV_FILE not found (run from the repo root)" >&2; exit 1; }
[[ -f "$MAP_FILE" ]] || { echo "❌ $MAP_FILE not found" >&2; exit 1; }
command -v railway >/dev/null || { echo "❌ Railway CLI required" >&2; exit 1; }

# Infra vars: Railway provides them via fromService/reference — never push local values.
BLOCKED='^(DATABASE_URL|REDIS_URL|PORT|RAILWAY_.*|.*_URL_SERVER|.*REDIRECT_URI.*)$'

errors=0 pushed=0
while read -r line; do
  line="${line%%#*}"                       # strip comment
  [[ -z "${line// /}" ]] && continue
  var="$(awk '{print $1}' <<<"$line")"
  services="$(awk '{print $2}' <<<"$line")"
  [[ -n "$ONLY" && "$var" != "$ONLY" ]] && continue

  if [[ "$var" =~ $BLOCKED ]]; then
    echo "⛔ $var is an infra var (fromService) — remove it from the manifest"; errors=$((errors+1)); continue
  fi
  if [[ -z "$services" ]]; then
    echo "⛔ $var is missing its service list in the manifest"; errors=$((errors+1)); continue
  fi

  # Read the value from .env (last line wins, strip surrounding quotes)
  raw="$(grep -E "^${var}=" "$ENV_FILE" | tail -1 || true)"
  if [[ -z "$raw" ]]; then
    echo "⚠️  $var is in the manifest but not in $ENV_FILE — skipping"; continue
  fi
  value="${raw#*=}"; value="${value%\"}"; value="${value#\"}"

  if [[ $FORCE_LOCAL -eq 0 && "$value" =~ (localhost|127\.0\.0\.1) ]]; then
    echo "⛔ $var contains localhost — dev value, not pushing (--force-local to override)"; errors=$((errors+1)); continue
  fi

  IFS=',' read -ra svc_arr <<<"$services"
  for svc in "${svc_arr[@]}"; do
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "DRY  $var → $svc ($RAILWAY_ENV)"
    else
      printf '%s' "$value" | railway variable set "$var" --stdin \
        --service "$svc" --environment "$RAILWAY_ENV" --skip-deploys
      echo "✅ $var → $svc"
    fi
    pushed=$((pushed+1))
  done
done < "$MAP_FILE"

if [[ $DEPLOY -eq 1 && $DRY_RUN -eq 0 ]]; then
  echo "↻ Redeploy needed to re-bake build-time variables…"
  echo "   → run the repo's deploy workflow (gh workflow run deploy) or 'railway redeploy --service <svc>'"
fi

echo "— $pushed set(s), $errors error(s) —"
exit $(( errors > 0 ? 1 : 0 ))
