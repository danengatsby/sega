#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_URL="${ANAF_SMOKE_BASE_URL:-http://localhost:4000}"
LOG_FILE="${ANAF_SMOKE_LOG_FILE:-/tmp/sega-backend-smoke-up.log}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Building backend..."
npm run build -w backend >/dev/null

echo "Starting backend on ${API_URL}..."
(cd apps/backend && node dist/server.js) >"${LOG_FILE}" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${API_URL}/api/health" || true)"
  if [[ "${code}" == "200" ]]; then
    break
  fi
  sleep 1
done

code="$(curl -s -o /dev/null -w '%{http_code}' "${API_URL}/api/health" || true)"
if [[ "${code}" != "200" ]]; then
  echo "Backend failed to start. Log:"
  cat "${LOG_FILE}" || true
  exit 1
fi

echo "Running ANAF smoke..."
ANAF_SMOKE_BASE_URL="${API_URL}" npm run anaf:smoke -w backend

echo "ANAF smoke one-shot PASSED"
