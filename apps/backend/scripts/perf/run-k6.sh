#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
K6_SCRIPT="${BACKEND_DIR}/perf/k6/kpi-routes.js"

resolve_k6_binary() {
  if command -v k6 >/dev/null 2>&1; then
    command -v k6
    return
  fi

  local fallback="${HOME}/.local/bin/k6"
  if [[ -x "${fallback}" ]]; then
    echo "${fallback}"
    return
  fi

  return 1
}

K6_BIN="$(resolve_k6_binary || true)"
if [[ -z "${K6_BIN}" ]]; then
  echo "Missing 'k6'. Install it in PATH or at ${HOME}/.local/bin/k6."
  exit 1
fi

if [[ -n "${K6_SUMMARY_EXPORT:-}" ]]; then
  mkdir -p "$(dirname "${K6_SUMMARY_EXPORT}")"
  exec "${K6_BIN}" run --summary-export "${K6_SUMMARY_EXPORT}" "${K6_SCRIPT}"
fi

exec "${K6_BIN}" run "${K6_SCRIPT}"
