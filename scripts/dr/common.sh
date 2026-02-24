#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/apps/backend/dr/backups"
REPORT_DIR="${REPO_ROOT}/apps/backend/dr/reports"

DEFAULT_DATABASE_URL="postgresql://sega:sega@localhost:5434/sega_accounting?schema=public"
DATABASE_URL_EFFECTIVE="${DATABASE_URL:-${DEFAULT_DATABASE_URL}}"
POSTGRES_TOOL_URL_EFFECTIVE=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_pg_tools() {
  require_command "node"
  require_command "psql"
  require_command "pg_dump"
  require_command "pg_restore"
}

ensure_dr_dirs() {
  mkdir -p "${BACKUP_DIR}" "${REPORT_DIR}"
}

now_utc_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

now_utc_stamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

resolve_path() {
  local value="${1:?path is required}"
  if [[ "${value}" = /* ]]; then
    printf "%s\n" "${value}"
  else
    printf "%s/%s\n" "${REPO_ROOT}" "${value}"
  fi
}

path_relative_to_repo() {
  local absolute
  absolute="$(resolve_path "$1")"
  if [[ "${absolute}" == "${REPO_ROOT}/"* ]]; then
    printf "%s\n" "${absolute#${REPO_ROOT}/}"
  else
    printf "%s\n" "${absolute}"
  fi
}

database_name_from_url() {
  node -e 'const u = new URL(process.argv[1]); console.log((u.pathname || "/postgres").replace(/^\//, "") || "postgres");' "$1"
}

normalize_postgres_url() {
  node -e '
    const u = new URL(process.argv[1]);
    u.searchParams.delete("schema");
    if (![...u.searchParams.keys()].length) {
      u.search = "";
    }
    console.log(u.toString());
  ' "$1"
}

database_url_for_name() {
  local source_url="${1:?source url is required}"
  local db_name="${2:?database name is required}"
  node -e '
    const u = new URL(process.argv[1]);
    u.searchParams.delete("schema");
    if (![...u.searchParams.keys()].length) {
      u.search = "";
    }
    u.pathname = "/" + process.argv[2];
    console.log(u.toString());
  ' "${source_url}" "${db_name}"
}

redact_database_url() {
  node -e 'const u = new URL(process.argv[1]); if (u.password) u.password = "***"; console.log(u.toString());' "$1"
}

checksum_file() {
  local file_path="${1:?file path is required}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file_path}" | awk "{print \$1}"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file_path}" | awk "{print \$1}"
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${file_path}" | awk "{print \$NF}"
    return
  fi

  echo "No checksum tool available (sha256sum/shasum/openssl)." >&2
  exit 1
}

POSTGRES_TOOL_URL_EFFECTIVE="$(normalize_postgres_url "${DATABASE_URL_EFFECTIVE}")"
