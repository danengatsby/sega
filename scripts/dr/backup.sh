#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: backup.sh [--output <path-to-backup.dump>]

Creates a PostgreSQL custom-format backup from DATABASE_URL and emits:
- .dump file
- .metadata.json file (timestamp, checksum, size, source DB)
EOF
}

require_pg_tools
ensure_dr_dirs

output_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_file="${2:-}"
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

if [[ -z "${output_file}" ]]; then
  output_file="${BACKUP_DIR}/sega-backup-$(now_utc_stamp).dump"
else
  output_file="$(resolve_path "${output_file}")"
fi

output_dir="$(dirname "${output_file}")"
mkdir -p "${output_dir}"

metadata_file="${output_file%.dump}.metadata.json"
started_at="$(now_utc_iso)"

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file "${output_file}" \
  "${POSTGRES_TOOL_URL_EFFECTIVE}"

finished_at="$(now_utc_iso)"
checksum_sha256="$(checksum_file "${output_file}")"
size_bytes="$(wc -c < "${output_file}" | tr -d '[:space:]')"
source_database="$(database_name_from_url "${POSTGRES_TOOL_URL_EFFECTIVE}")"
redacted_database_url="$(redact_database_url "${POSTGRES_TOOL_URL_EFFECTIVE}")"
backup_relative="$(path_relative_to_repo "${output_file}")"
metadata_relative="$(path_relative_to_repo "${metadata_file}")"

node - "${metadata_file}" "${started_at}" "${finished_at}" "${backup_relative}" "${checksum_sha256}" "${size_bytes}" "${source_database}" "${redacted_database_url}" <<'NODE'
const fs = require('fs');

const [
  ,
  ,
  metadataPath,
  startedAt,
  finishedAt,
  backupRelative,
  checksumSha256,
  sizeBytes,
  sourceDatabase,
  sourceDatabaseUrl,
] = process.argv;

const payload = {
  startedAt,
  finishedAt,
  backupFile: backupRelative,
  checksumSha256,
  sizeBytes: Number(sizeBytes),
  sourceDatabase,
  sourceDatabaseUrl,
};

fs.writeFileSync(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
NODE

echo "Backup created: ${backup_relative}"
echo "Metadata file: ${metadata_relative}"
echo "SHA256: ${checksum_sha256}"
echo "BACKUP_FILE=${output_file}"
echo "METADATA_FILE=${metadata_file}"
