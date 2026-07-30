#!/usr/bin/env bash
#
# pg-backup.sh — off-provider logical backup of the QueerPulse Postgres DB.
#
# Produces a compressed pg_dump in custom format (-Fc), which pg_restore can
# restore whole or selectively. See docs/ops/backup-restore.md (P0-7 runbook).
#
# Usage:
#   DATABASE_URL="postgres://user:pass@host:5432/db" ./scripts/pg-backup.sh
#
# Env:
#   DATABASE_URL       (required) connection string to the DB to dump.
#   BACKUP_DIR         (optional) local output dir. Default: ./backups
#   BACKUP_ENCRYPT_CMD (optional) filter command to encrypt the dump, reading
#                      stdin -> stdout. e.g. "age -r <recipient>" or
#                      "gpg --encrypt --recipient ops@example.com". When set,
#                      the on-disk artifact is "<name>.dump.enc".
#   BACKUP_UPLOAD_CMD  (optional) command to push the finished artifact
#                      off-provider. It receives the artifact path as $1.
#                      e.g. BACKUP_UPLOAD_CMD='aws s3 cp "$1" s3://qp-backups/'
#                      (evaluated via `eval` with "$1" bound to the file).
#
# Exit non-zero on any failure so a scheduler (GitHub Actions / cron) can alert.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "pg-backup: DATABASE_URL is required" >&2
  exit 2
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg-backup: pg_dump not found (install postgresql-client 16+)" >&2
  exit 2
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

# Deterministic, sortable, timezone-free UTC stamp.
stamp="$(date -u +%Y%m%d-%H%M%S)"
base="$BACKUP_DIR/queerpulse-${stamp}.dump"

echo "pg-backup: dumping to ${base} ..." >&2

# -Fc custom format, -Z9 max compression, --no-owner/--no-privileges so the dump
# restores cleanly into a differently-owned scratch DB.
if [[ -n "${BACKUP_ENCRYPT_CMD:-}" ]]; then
  artifact="${base}.enc"
  pg_dump --dbname="$DATABASE_URL" -Fc -Z9 --no-owner --no-privileges \
    | eval "$BACKUP_ENCRYPT_CMD" > "$artifact"
else
  artifact="$base"
  pg_dump --dbname="$DATABASE_URL" -Fc -Z9 --no-owner --no-privileges -f "$artifact"
fi

# Fail loudly if the artifact is suspiciously tiny (a 0-table dump ~ a few KB).
size_bytes="$(wc -c < "$artifact" | tr -d ' ')"
if [[ "$size_bytes" -lt 1024 ]]; then
  echo "pg-backup: artifact is only ${size_bytes} bytes — treating as failure" >&2
  exit 1
fi
echo "pg-backup: wrote ${artifact} (${size_bytes} bytes)" >&2

if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  echo "pg-backup: uploading off-provider ..." >&2
  # shellcheck disable=SC2016  # $1 is intentionally bound below, not now.
  bash -c "$BACKUP_UPLOAD_CMD" _ "$artifact"
  echo "pg-backup: upload done" >&2
fi

# Print the path on stdout so a caller can capture it.
echo "$artifact"
