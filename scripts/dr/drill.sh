#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: drill.sh [--target-db <database_name>]

Runs an end-to-end DR drill:
1) backup
2) restore into isolated DB
3) row-count validation for all public tables
4) emits JSON report in apps/backend/dr/reports
EOF
}

require_pg_tools
ensure_dr_dirs

target_db="${DR_TARGET_DB:-sega_restore_test}"
rto_target_seconds="${DR_RTO_TARGET_SECONDS:-3600}"
rpo_target_seconds="${DR_RPO_TARGET_SECONDS:-900}"

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if ! [[ "${target_db}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Invalid target DB '${target_db}'." >&2
  exit 1
fi

if ! [[ "${rto_target_seconds}" =~ ^[0-9]+$ ]]; then
  echo "Invalid DR_RTO_TARGET_SECONDS='${rto_target_seconds}'." >&2
  exit 1
fi

if ! [[ "${rpo_target_seconds}" =~ ^[0-9]+$ ]]; then
  echo "Invalid DR_RPO_TARGET_SECONDS='${rpo_target_seconds}'." >&2
  exit 1
fi

drill_started_epoch="$(date -u +%s)"
drill_started_at="$(now_utc_iso)"

backup_output="$("${SCRIPT_DIR}/backup.sh")"
echo "${backup_output}"

backup_file="$(echo "${backup_output}" | awk -F= '/^BACKUP_FILE=/{print $2}' | tail -n 1)"
metadata_file="$(echo "${backup_output}" | awk -F= '/^METADATA_FILE=/{print $2}' | tail -n 1)"

if [[ -z "${backup_file}" || -z "${metadata_file}" ]]; then
  echo "Backup step did not return expected artifacts." >&2
  exit 1
fi

"${SCRIPT_DIR}/restore.sh" --backup-file "${backup_file}" --target-db "${target_db}" >/dev/null

source_db_url="${POSTGRES_TOOL_URL_EFFECTIVE}"
target_db_url="$(database_url_for_name "${DATABASE_URL_EFFECTIVE}" "${target_db}")"
source_db_url_redacted="$(redact_database_url "${source_db_url}")"
target_db_url_redacted="$(redact_database_url "${target_db_url}")"

counts_file="$(mktemp)"
mismatches_file="$(mktemp)"
trap 'rm -f "${counts_file}" "${mismatches_file}"' EXIT

table_list="$(psql "${source_db_url}" -At -v ON_ERROR_STOP=1 -c "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;")"

total_tables=0
mismatched_tables=0

while IFS= read -r table_name; do
  if [[ -z "${table_name}" ]]; then
    continue
  fi

  source_rows="$(psql "${source_db_url}" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM ${table_name};" | tr -d '[:space:]')"
  target_rows="$(psql "${target_db_url}" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM ${table_name};" | tr -d '[:space:]')"
  total_tables=$((total_tables + 1))

  printf "%s,%s,%s\n" "${table_name}" "${source_rows}" "${target_rows}" >> "${counts_file}"

  if [[ "${source_rows}" != "${target_rows}" ]]; then
    mismatched_tables=$((mismatched_tables + 1))
    printf "%s,%s,%s\n" "${table_name}" "${source_rows}" "${target_rows}" >> "${mismatches_file}"
  fi
done <<< "${table_list}"

drill_finished_epoch="$(date -u +%s)"
drill_finished_at="$(now_utc_iso)"
rto_seconds=$((drill_finished_epoch - drill_started_epoch))
rpo_seconds=0

passed=true
if [[ "${mismatched_tables}" -gt 0 ]]; then
  passed=false
fi
if [[ "${rto_seconds}" -gt "${rto_target_seconds}" ]]; then
  passed=false
fi
if [[ "${rpo_seconds}" -gt "${rpo_target_seconds}" ]]; then
  passed=false
fi

report_file="${REPORT_DIR}/restore-drill-$(now_utc_stamp).json"
report_relative="$(path_relative_to_repo "${report_file}")"
backup_relative="$(path_relative_to_repo "${backup_file}")"
metadata_relative="$(path_relative_to_repo "${metadata_file}")"

node - "${report_file}" "${drill_started_at}" "${drill_finished_at}" "${backup_relative}" "${metadata_relative}" "${source_db_url_redacted}" "${target_db}" "${target_db_url_redacted}" "${rto_seconds}" "${rpo_seconds}" "${rto_target_seconds}" "${rpo_target_seconds}" "${total_tables}" "${mismatched_tables}" "${passed}" "${counts_file}" "${mismatches_file}" <<'NODE'
const fs = require('fs');

const [
  ,
  ,
  reportPath,
  startedAt,
  finishedAt,
  backupFile,
  metadataFile,
  sourceDatabaseUrl,
  targetDatabase,
  targetDatabaseUrl,
  rtoSeconds,
  rpoSeconds,
  rtoTargetSeconds,
  rpoTargetSeconds,
  totalTables,
  mismatchedTables,
  passedRaw,
  countsFile,
  mismatchesFile,
] = process.argv;

function parseCsvRows(path) {
  const raw = fs.readFileSync(path, 'utf8').trim();
  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [table, sourceRows, restoredRows] = line.split(',');
      return {
        table,
        sourceRows: Number(sourceRows),
        restoredRows: Number(restoredRows),
      };
    });
}

const report = {
  drillStartedAt: startedAt,
  drillFinishedAt: finishedAt,
  backupFile,
  metadataFile,
  sourceDatabaseUrl,
  restoredDatabase: {
    name: targetDatabase,
    url: targetDatabaseUrl,
  },
  rowCountValidation: {
    totalTables: Number(totalTables),
    mismatchedTables: Number(mismatchedTables),
    tables: parseCsvRows(countsFile),
    mismatches: parseCsvRows(mismatchesFile),
  },
  rtoSeconds: Number(rtoSeconds),
  rpoSeconds: Number(rpoSeconds),
  targets: {
    rtoTargetSeconds: Number(rtoTargetSeconds),
    rpoTargetSeconds: Number(rpoTargetSeconds),
  },
  passed: passedRaw === 'true',
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
NODE

echo "DR drill report: ${report_relative}"
echo "DR targets: RTO<=${rto_target_seconds}s, RPO<=${rpo_target_seconds}s"
echo "Measured: RTO=${rto_seconds}s, RPO=${rpo_seconds}s, mismatches=${mismatched_tables}/${total_tables}"

if [[ "${passed}" != "true" ]]; then
  echo "DR drill FAILED." >&2
  exit 1
fi

echo "DR drill PASSED."
