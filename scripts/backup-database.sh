#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

if [[ -z "${BACKUP_DATABASE_URL:-}" ]]; then
  echo "Thiếu BACKUP_DATABASE_URL." >&2
  exit 1
fi

if [[ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]]; then
  echo "Thiếu BACKUP_ENCRYPTION_PASSPHRASE." >&2
  exit 1
fi

for command_name in pg_dump pg_restore openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Thiếu công cụ bắt buộc: $command_name" >&2
    exit 1
  fi
done

output_dir="${1:-backups}"
mkdir -p "$output_dir"

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
plain_backup="$output_dir/trobill-$timestamp.dump"
encrypted_backup="$plain_backup.enc"
manifest="$encrypted_backup.manifest"
checksum="$encrypted_backup.sha256"

cleanup() {
  rm -f "$plain_backup"
}
trap cleanup EXIT

echo "Bắt đầu tạo backup PostgreSQL dạng custom..."
pg_dump \
  --dbname="$BACKUP_DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$plain_backup"

pg_restore --list "$plain_backup" > "$manifest"
for required_table in users rooms settings; do
  if ! grep -Eq "TABLE DATA public ${required_table} " "$manifest"; then
    echo "Backup thiếu dữ liệu bảng lõi: $required_table" >&2
    exit 1
  fi
done

openssl enc \
  -aes-256-cbc \
  -pbkdf2 \
  -iter 200000 \
  -salt \
  -in "$plain_backup" \
  -out "$encrypted_backup" \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$(basename "$encrypted_backup")") > "$checksum"
else
  (cd "$output_dir" && shasum -a 256 "$(basename "$encrypted_backup")") > "$checksum"
fi

chmod 600 "$encrypted_backup" "$manifest" "$checksum"
echo "BACKUP_FILE=$encrypted_backup"
echo "BACKUP_MANIFEST=$manifest"
echo "BACKUP_CHECKSUM=$checksum"
