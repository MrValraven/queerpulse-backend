#!/usr/bin/env bash
#
# pg-restore.sh — guarded restore of a pg-backup.sh dump into a SCRATCH database.
#
# Refuses to restore onto a target whose database name doesn't look like a
# scratch/test target, mirroring the e2e DB-safety guard (test/db-safety.ts).
# This exists so a rehearsal can never accidentally clobber prod. To restore
# onto a real target on purpose, set RESTORE_ALLOW_ANY=1 (and be certain).
#
# Usage:
#   SCRATCH_DATABASE_URL="postgres://.../queerpulse_restore_test" \
#     ./scripts/pg-restore.sh path/to/queerpulse-YYYYMMDD-HHMMSS.dump
#
# Env:
#   SCRATCH_DATABASE_URL (required) target to restore INTO.
#   BACKUP_DECRYPT_CMD   (optional) filter to decrypt a .enc artifact, stdin->stdout
#                        (inverse of pg-backup.sh's BACKUP_ENCRYPT_CMD).
#   RESTORE_ALLOW_ANY    (optional) set to 1 to bypass the scratch-name guard.
#
# See docs/ops/backup-restore.md §4.
set -euo pipefail

dump_path="${1:-}"
if [[ -z "$dump_path" || -z "${SCRATCH_DATABASE_URL:-}" ]]; then
  echo "usage: SCRATCH_DATABASE_URL=... $0 <dump-file>" >&2
  exit 2
fi
if [[ ! -f "$dump_path" ]]; then
  echo "pg-restore: dump not found: $dump_path" >&2
  exit 2
fi
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg-restore: pg_restore not found (install postgresql-client 16+)" >&2
  exit 2
fi

# Safety guard: the target DB name must look like a scratch/test DB unless the
# operator explicitly opts out. Extract the last path segment of the URL, minus
# any ?query string.
db_name="${SCRATCH_DATABASE_URL##*/}"
db_name="${db_name%%\?*}"
if [[ "${RESTORE_ALLOW_ANY:-}" != "1" ]]; then
  case "$db_name" in
    *_test|*_restore|*restore_test|*scratch*)
      : ;; # ok, looks like a scratch target
    *)
      echo "pg-restore: refusing to restore onto '${db_name}' — it doesn't look" >&2
      echo "  like a scratch DB (expected *_test / *_restore / *scratch*)." >&2
      echo "  Set RESTORE_ALLOW_ANY=1 to override for a real recovery." >&2
      exit 1 ;;
  esac
fi

echo "pg-restore: restoring ${dump_path} -> ${db_name} ..." >&2

# --clean --if-exists makes the restore idempotent (drops objects first).
# --no-owner/--no-privileges match the dump flags. -Fc is auto-detected.
restore_flags=(--dbname="$SCRATCH_DATABASE_URL" --clean --if-exists --no-owner --no-privileges)

if [[ "$dump_path" == *.enc ]]; then
  if [[ -z "${BACKUP_DECRYPT_CMD:-}" ]]; then
    echo "pg-restore: ${dump_path} is encrypted but BACKUP_DECRYPT_CMD is unset" >&2
    exit 2
  fi
  eval "$BACKUP_DECRYPT_CMD" < "$dump_path" | pg_restore "${restore_flags[@]}"
else
  pg_restore "${restore_flags[@]}" "$dump_path"
fi

echo "pg-restore: done. Next: DATABASE_URL='${SCRATCH_DATABASE_URL}' pnpm run typeorm migration:show" >&2
