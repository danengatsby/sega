#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: restore.sh --backup-file <path-to-backup.dump> [--target-db <database_name>]

Restores a PostgreSQL custom-format backup into a fresh target database.
Default target database: sega_restore_test
EOF
}

require_pg_tools
ensure_dr_dirs

backup_file=""
target_db="sega_restore_test"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-file)
      backup_file="${2:-}"
      shift 2
      ;;
    --target-db)
      target_db="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${backup_file}" ]]; then
  echo "--backup-file is required." >&2
  usage >&2
  exit 1
fi

if ! [[ "${target_db}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Invalid --target-db value '${target_db}'. Use only letters, digits and underscore." >&2
  exit 1
fi

backup_file="$(resolve_path "${backup_file}")"
if [[ ! -f "${backup_file}" ]]; then
  echo "Backup file not found: ${backup_file}" >&2
  exit 1
fi

admin_database_url="$(database_url_for_name "${DATABASE_URL_EFFECTIVE}" "postgres")"
target_database_url="$(database_url_for_name "${DATABASE_URL_EFFECTIVE}" "${target_db}")"
target_database_url_redacted="$(redact_database_url "${target_database_url}")"

psql "${admin_database_url}" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${target_db}' AND pid <> pg_backend_pid();" >/dev/null
psql "${admin_database_url}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${target_db}\";" >/dev/null
psql "${admin_database_url}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${target_db}\";" >/dev/null

pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname "${target_database_url}" \
  "${backup_file}"

echo "Restore completed into database: ${target_db}"
echo "Target database URL: ${target_database_url_redacted}"
echo "TARGET_DATABASE=${target_db}"
echo "TARGET_DATABASE_URL_REDACTED=${target_database_url_redacted}"
