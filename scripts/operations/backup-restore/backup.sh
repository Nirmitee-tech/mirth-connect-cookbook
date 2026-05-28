#!/usr/bin/env bash
#
# Recipe #35 — Backup/Restore Automation
# backup.sh — full Mirth backup: DB + config map + keystores + channels XML
#
# Steps:
#   1. pg_dump mirthdb (custom format, compressed)
#   2. Export channels XML via Mirth REST API
#   3. Snapshot configurationMap, code templates, alerts
#   4. Tar keystore + truststore + custom-lib
#   5. GPG-encrypt the bundle with a passphrase OR a recipient key
#   6. Upload to S3 with checksum + versioning
#
# Usage:
#   ./backup.sh --out DIR [--s3 s3://bucket/path] [--gpg-recipient EMAIL | --gpg-pass-file FILE]
#               [--mirth-host URL] [--mirth-user U] [--mirth-pass P]
#               [--pg-host H] [--pg-db DB] [--pg-user U] [--pg-pass P]
#               [--dry-run]
#
# Tested on: Mirth Connect 4.5.2, PostgreSQL 16, AWS CLI v2, GnuPG 2.4
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

DRY_RUN=0
OUT="${PWD}/mirth-backup-$(date -u +%Y%m%dT%H%M%SZ)"
S3=""
GPG_RECIPIENT=""
GPG_PASS_FILE=""

MIRTH_HOST="${MIRTH_HOST:-https://localhost:8443}"
MIRTH_USER="${MIRTH_USER:-admin}"
MIRTH_PASS="${MIRTH_PASS:-admin}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5433}"
PG_DB="${PG_DB:-mirthdb}"
PG_USER="${PG_USER:-mirthdb}"
PG_PASS="${PG_PASS:-mirthdb}"
KEYSTORE_DIR="${KEYSTORE_DIR:-/opt/connect/certs}"
CUSTOM_LIB_DIR="${CUSTOM_LIB_DIR:-/opt/connect/custom-lib}"

usage() { sed -n '2,22p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out)             OUT="$2"; shift 2 ;;
        --s3)              S3="$2"; shift 2 ;;
        --gpg-recipient)   GPG_RECIPIENT="$2"; shift 2 ;;
        --gpg-pass-file)   GPG_PASS_FILE="$2"; shift 2 ;;
        --mirth-host)      MIRTH_HOST="$2"; shift 2 ;;
        --mirth-user)      MIRTH_USER="$2"; shift 2 ;;
        --mirth-pass)      MIRTH_PASS="$2"; shift 2 ;;
        --pg-host)         PG_HOST="$2"; shift 2 ;;
        --pg-db)           PG_DB="$2"; shift 2 ;;
        --pg-user)         PG_USER="$2"; shift 2 ;;
        --pg-pass)         PG_PASS="$2"; shift 2 ;;
        --dry-run)         DRY_RUN=1; shift ;;
        -h|--help)         usage ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

run() { if [[ "$DRY_RUN" == "1" ]]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

if [[ -z "$GPG_RECIPIENT" && -z "$GPG_PASS_FILE" ]]; then
    echo "ERROR: provide --gpg-recipient EMAIL  OR  --gpg-pass-file PATH" >&2
    exit 2
fi
for tool in pg_dump curl tar gpg sha256sum; do
    command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done
if [[ -n "$S3" ]]; then command -v aws >/dev/null || { echo "missing: aws cli" >&2; exit 2; }; fi

echo "============================================================"
echo " Mirth backup -> $OUT"
echo " S3 target  : ${S3:-<none>}"
echo " Encryption : ${GPG_RECIPIENT:+recipient=$GPG_RECIPIENT}${GPG_PASS_FILE:+passfile=$GPG_PASS_FILE}"
echo " Dry-run    : $DRY_RUN"
echo "============================================================"

run "mkdir -p '$OUT'"

# --- 1. pg_dump ---------------------------------------------------------------
echo "-- pg_dump $PG_DB"
DUMP_FILE="$OUT/mirthdb.dump"
run "PGPASSWORD='$PG_PASS' pg_dump -h '$PG_HOST' -p '$PG_PORT' -U '$PG_USER' \
     -d '$PG_DB' -Fc -Z 9 -f '$DUMP_FILE'"

# --- 2. Channels XML ----------------------------------------------------------
echo "-- Exporting channels via Mirth REST"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' \
     -H 'X-Requested-With: backup.sh' -H 'Accept: application/xml' \
     '$MIRTH_HOST/api/channels' -o '$OUT/channels.xml'"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' \
     -H 'X-Requested-With: backup.sh' -H 'Accept: application/xml' \
     '$MIRTH_HOST/api/codeTemplates' -o '$OUT/codeTemplates.xml'"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' \
     -H 'X-Requested-With: backup.sh' -H 'Accept: application/xml' \
     '$MIRTH_HOST/api/alerts' -o '$OUT/alerts.xml'"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' \
     -H 'X-Requested-With: backup.sh' -H 'Accept: application/json' \
     '$MIRTH_HOST/api/server/configurationMap' -o '$OUT/configurationMap.json'"

# --- 3. Keystores + custom-lib (if reachable on this host) -------------------
if [[ -d "$KEYSTORE_DIR" ]]; then
    echo "-- Snapshotting $KEYSTORE_DIR"
    run "tar -C '$(dirname "$KEYSTORE_DIR")' -czf '$OUT/keystores.tar.gz' '$(basename "$KEYSTORE_DIR")'"
fi
if [[ -d "$CUSTOM_LIB_DIR" ]]; then
    echo "-- Snapshotting $CUSTOM_LIB_DIR"
    run "tar -C '$(dirname "$CUSTOM_LIB_DIR")' -czf '$OUT/custom-lib.tar.gz' '$(basename "$CUSTOM_LIB_DIR")'"
fi

# --- 4. Bundle + checksum -----------------------------------------------------
echo "-- Bundling"
BUNDLE="$OUT.tar"
run "tar -C '$(dirname "$OUT")' -cf '$BUNDLE' '$(basename "$OUT")'"
run "sha256sum '$BUNDLE' > '$BUNDLE.sha256'"

# --- 5. GPG encrypt -----------------------------------------------------------
echo "-- GPG encrypting"
if [[ -n "$GPG_RECIPIENT" ]]; then
    run "gpg --batch --yes --trust-model always --output '$BUNDLE.gpg' --encrypt --recipient '$GPG_RECIPIENT' '$BUNDLE'"
else
    run "gpg --batch --yes --output '$BUNDLE.gpg' --symmetric --cipher-algo AES256 --passphrase-file '$GPG_PASS_FILE' '$BUNDLE'"
fi
run "rm -f '$BUNDLE'"  # never leave the unencrypted tar on disk
run "sha256sum '$BUNDLE.gpg' > '$BUNDLE.gpg.sha256'"

# --- 6. Upload to S3 ----------------------------------------------------------
if [[ -n "$S3" ]]; then
    echo "-- Uploading $BUNDLE.gpg -> $S3"
    run "aws s3 cp '$BUNDLE.gpg'        '$S3/'  --no-progress"
    run "aws s3 cp '$BUNDLE.gpg.sha256' '$S3/'  --no-progress"
fi

# --- 7. Local cleanup --------------------------------------------------------
echo "-- Cleaning up local working dir (keeping $BUNDLE.gpg only)"
run "rm -rf '$OUT'"

echo
echo "Done.  Encrypted bundle: $BUNDLE.gpg"
[[ -n "$S3" ]] && echo "Uploaded to: $S3/$(basename "$BUNDLE").gpg"
