#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

encrypted_backup="${1:-}"
if [[ -z "$encrypted_backup" || ! -f "$encrypted_backup" ]]; then
  echo "Cách dùng: scripts/restore-database.sh <backup.dump.enc>" >&2
  exit 1
fi

if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "Thiếu RESTORE_DATABASE_URL." >&2
  exit 1
fi

if [[ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]]; then
  echo "Thiếu BACKUP_ENCRYPTION_PASSPHRASE." >&2
  exit 1
fi

if [[ "${ALLOW_EMPTY_DATABASE_RESTORE:-}" != "true" ]]; then
  echo "Từ chối restore: phải đặt ALLOW_EMPTY_DATABASE_RESTORE=true." >&2
  exit 1
fi

for command_name in psql pg_restore openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Thiếu công cụ bắt buộc: $command_name" >&2
    exit 1
  fi
done

checksum="$encrypted_backup.sha256"
if [[ -f "$checksum" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$encrypted_backup")" && sha256sum --check "$(basename "$checksum")")
  else
    (cd "$(dirname "$encrypted_backup")" && shasum -a 256 --check "$(basename "$checksum")")
  fi
fi

existing_tables="$(psql "$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
if [[ "$existing_tables" != "0" ]]; then
  echo "Từ chối restore: database đích không trống ($existing_tables bảng public)." >&2
  exit 1
fi

plain_backup="$(mktemp "${TMPDIR:-/tmp}/trobill-restore.XXXXXX.dump")"
cleanup() {
  rm -f "$plain_backup"
}
trap cleanup EXIT

openssl enc \
  -d \
  -aes-256-cbc \
  -pbkdf2 \
  -iter 200000 \
  -in "$encrypted_backup" \
  -out "$plain_backup" \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE

pg_restore \
  --dbname="$RESTORE_DATABASE_URL" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$plain_backup"

psql "$RESTORE_DATABASE_URL" \
  -X \
  -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/verify-restored-database.sql"

echo "Restore và kiểm tra tính toàn vẹn đã thành công."
