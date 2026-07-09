#!/usr/bin/env bash
# railway-sync-env.sh — shared env-sync tool cho mọi repo Noddle (source of truth: noddle_artifact).
# Đẩy secrets/config từ root .env lên Railway theo manifest DECLARATIVE `railway.env.map`
# (repo con không sửa script này — chỉ sửa manifest). Chống ad-hoc:
#   - chỉ push biến có mặt trong manifest (allowlist per service)
#   - chặn infra vars (fromService trên Railway, giá trị local sẽ phá prod)
#   - chặn giá trị localhost trừ khi --force-local
#   - value đi qua --stdin (không lộ trong process list / shell history)
#
# Usage:  railway-sync-env.sh [--dry-run] [--only VAR] [--env production] [--deploy] [--force-local]
#   --dry-run      In ra kế hoạch, không push
#   --only VAR     Chỉ sync một biến
#   --env ENV      Railway environment (default: production)
#   --deploy       Trigger redeploy sau khi set (default: --skip-deploys;
#                  NEXT_PUBLIC_* bake lúc build nên đổi xong PHẢI deploy lại)
#   --force-local  Cho phép value chứa localhost/127.0.0.1 (mặc định chặn)
#
# Manifest `railway.env.map` (cạnh root .env), mỗi dòng:  VAR_NAME  service1,service2
# Xem railway.env.map.example trong thư mục này.

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

[[ -f "$ENV_FILE" ]] || { echo "❌ Không thấy $ENV_FILE (chạy từ repo root)" >&2; exit 1; }
[[ -f "$MAP_FILE" ]] || { echo "❌ Không thấy $MAP_FILE — tạo từ railway.env.map.example" >&2; exit 1; }
command -v railway >/dev/null || { echo "❌ Cần Railway CLI" >&2; exit 1; }

# Infra vars: Railway tự cấp qua fromService/reference — không bao giờ push từ local.
BLOCKED='^(DATABASE_URL|REDIS_URL|PORT|RAILWAY_.*|.*_URL_SERVER|.*REDIRECT_URI.*)$'

errors=0 pushed=0
while read -r line; do
  line="${line%%#*}"                       # strip comment
  [[ -z "${line// /}" ]] && continue
  var="$(awk '{print $1}' <<<"$line")"
  services="$(awk '{print $2}' <<<"$line")"
  [[ -n "$ONLY" && "$var" != "$ONLY" ]] && continue

  if [[ "$var" =~ $BLOCKED ]]; then
    echo "⛔ $var là infra var (fromService) — bỏ khỏi manifest"; errors=$((errors+1)); continue
  fi
  if [[ -z "$services" ]]; then
    echo "⛔ $var thiếu danh sách service trong manifest"; errors=$((errors+1)); continue
  fi

  # Đọc value từ .env (dòng cuối thắng, bỏ quote bao ngoài nếu có)
  raw="$(grep -E "^${var}=" "$ENV_FILE" | tail -1 || true)"
  if [[ -z "$raw" ]]; then
    echo "⚠️  $var có trong manifest nhưng không có trong $ENV_FILE — bỏ qua"; continue
  fi
  value="${raw#*=}"; value="${value%\"}"; value="${value#\"}"

  if [[ $FORCE_LOCAL -eq 0 && "$value" =~ (localhost|127\.0\.0\.1) ]]; then
    echo "⛔ $var chứa localhost — giá trị dev, không push (--force-local để ép)"; errors=$((errors+1)); continue
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
  echo "↻ Trigger redeploy để re-bake biến build-time…"
  # Redeploy từng service có biến vừa đổi: dùng caller workflow hoặc `railway up` per service.
  echo "   → chạy workflow deploy của repo (gh workflow run deploy) hoặc 'railway redeploy --service <svc>'"
fi

echo "— $pushed set(s), $errors lỗi —"
exit $(( errors > 0 ? 1 : 0 ))
