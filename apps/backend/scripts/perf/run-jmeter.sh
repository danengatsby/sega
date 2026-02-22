#!/usr/bin/env bash
set -euo pipefail

resolve_jmeter_binary() {
  if command -v jmeter >/dev/null 2>&1; then
    command -v jmeter
    return
  fi

  local fallback="${HOME}/.local/bin/jmeter"
  if [[ -x "${fallback}" ]]; then
    echo "${fallback}"
    return
  fi

  return 1
}

JMETER_BIN="$(resolve_jmeter_binary || true)"
if [[ -z "${JMETER_BIN}" ]]; then
  echo "Missing 'jmeter'. Install it in PATH or at ${HOME}/.local/bin/jmeter."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
JMX_FILE="${BACKEND_DIR}/perf/jmeter/kpi-routes.jmx"
RESULTS_DIR="${BACKEND_DIR}/perf/results/jmeter"
JTL_FILE="${RESULTS_DIR}/kpi-routes.jtl"
REPORT_DIR="${RESULTS_DIR}/html-report"
LOG_FILE="${RESULTS_DIR}/jmeter.log"

mkdir -p "${RESULTS_DIR}"
rm -f "${JTL_FILE}"
rm -rf "${REPORT_DIR}"

BASE_URL="${PERF_BASE_URL:-http://127.0.0.1:4000}"
if [[ "${BASE_URL}" =~ ^(https?)://([^/:]+)(:([0-9]+))?(/.*)?$ ]]; then
  API_PROTOCOL="${BASH_REMATCH[1]}"
  API_HOST="${BASH_REMATCH[2]}"
  API_PORT="${BASH_REMATCH[4]:-}"
  API_BASE_PATH="${BASH_REMATCH[5]:-}"
else
  echo "Invalid PERF_BASE_URL='${BASE_URL}'. Expected format: http(s)://host[:port][/base-path]"
  exit 1
fi

if [[ -z "${API_PORT}" ]]; then
  if [[ "${API_PROTOCOL}" == "https" ]]; then
    API_PORT="443"
  else
    API_PORT="80"
  fi
fi

if [[ "${API_BASE_PATH}" == "/" ]]; then
  API_BASE_PATH=""
fi

echo "Running JMeter KPI suite against ${BASE_URL}"
"${JMETER_BIN}" \
  -n \
  -t "${JMX_FILE}" \
  -l "${JTL_FILE}" \
  -j "${LOG_FILE}" \
  -e \
  -o "${REPORT_DIR}" \
  -Jjmeter.save.saveservice.output_format=csv \
  -Jjmeter.save.saveservice.response_code=true \
  -Jjmeter.save.saveservice.successful=true \
  -Jjmeter.save.saveservice.label=true \
  -Jjmeter.save.saveservice.time=true \
  -Jjmeter.save.saveservice.thread_name=true \
  -Jjmeter.save.saveservice.response_message=true \
  -JapiProtocol="${API_PROTOCOL}" \
  -JapiHost="${API_HOST}" \
  -JapiPort="${API_PORT}" \
  -JapiBasePath="${API_BASE_PATH}" \
  -JperfEmail="${PERF_USER_EMAIL:-perf.accountant@sega.local}" \
  -JperfPassword="${PERF_USER_PASSWORD:-PerfKpi!Pass2026}" \
  -JperfThreads="${PERF_JMETER_THREADS:-8}" \
  -JperfRampUp="${PERF_JMETER_RAMP_UP:-10}" \
  -JperfLoops="${PERF_JMETER_LOOPS:-25}" \
  -JperfThinkTimeMs="${PERF_JMETER_THINK_TIME_MS:-200}" \
  -JperfConnectTimeout="${PERF_JMETER_CONNECT_TIMEOUT_MS:-5000}" \
  -JperfResponseTimeout="${PERF_JMETER_RESPONSE_TIMEOUT_MS:-15000}"

node "${BACKEND_DIR}/scripts/perf/check-jmeter-jtl.mjs" "${JTL_FILE}"

echo "JMeter KPI suite done. Results:"
echo "  JTL: ${JTL_FILE}"
echo "  Report: ${REPORT_DIR}/index.html"
