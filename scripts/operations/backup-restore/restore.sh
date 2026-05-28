#!/usr/bin/env bash
#
# Recipe #35 — Backup/Restore Automation
# restore.sh — restores a Mirth backup bundle produced by backup.sh
#
# Steps:
#   1. Download from S3 (or use --from local path)
#   2. Verify SHA-256
#   3. GPG decrypt
#   4. Untar
#   5. Restore Postgres dump  (pg_restore -c)
#   6. Re-import channels, code templates, alerts, configurationMap via REST
#   7. Restore keystores + custom-lib (operator does mv manually unless --apply-keystores)
#
# Usage:
#   ./restore.sh --bundle s3://bucket/path/mirth-backup-XXX.tar.gpg
#                [--gpg-recipient EMAIL | --gpg-pass-file PATH]
#                [--mirth-host URL] [--pg-host H] [--pg-db DB] [--pg-user U] [--pg-pass P]
#                [--apply-keystores] [--dry-run] [--yes]
#
# DANGER: --apply-keystores will overwrite /opt/connect/certs and /opt/connect/custom-lib
#         Use only on a recovery host.
#
# Tested on: see backup.sh
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
BUNDLE=""
GPG_RECIPIENT=""
GPG_PASS_FILE=""
APPLY_KEYSTORES=0

MIRTH_HOST="${MIRTH_HOST:-https://localhost:8443}"
MIRTH_USER="${MIRTH_USER:-admin}"
MIRTH_PASS="${MIRTH_PASS:-admin}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5433}"
PG_DB="${PG_DB:-mirthdb}"
PG_USER="${PG_USER:-mirthdb}"
PG_PASS="${PG_PASS:-mirthdb}"

usage() { sed -n '2,24p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bundle)            BUNDLE="$2"; shift 2 ;;
        --gpg-recipient)     GPG_RECIPIENT="$2"; shift 2 ;;
        --gpg-pass-file)     GPG_PASS_FILE="$2"; shift 2 ;;
        --mirth-host)        MIRTH_HOST="$2"; shift 2 ;;
        --mirth-user)        MIRTH_USER="$2"; shift 2 ;;
        --mirth-pass)        MIRTH_PASS="$2"; shift 2 ;;
        --pg-host)           PG_HOST="$2"; shift 2 ;;
        --pg-db)             PG_DB="$2"; shift 2 ;;
        --pg-user)           PG_USER="$2"; shift 2 ;;
        --pg-pass)           PG_PASS="$2"; shift 2 ;;
        --apply-keystores)   APPLY_KEYSTORES=1; shift ;;
        --dry-run)           DRY_RUN=1; shift ;;
        --yes|-y)            ASSUME_YES=1; shift ;;
        -h|--help)           usage ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

run() { if [[ "$DRY_RUN" == "1" ]]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

[[ -z "$BUNDLE" ]] && { echo "ERROR: --bundle required" >&2; exit 2; }
if [[ -z "$GPG_RECIPIENT" && -z "$GPG_PASS_FILE" ]]; then
    echo "ERROR: provide --gpg-recipient or --gpg-pass-file" >&2; exit 2
fi

confirm() {
    [[ "$ASSUME_YES" == "1" ]] && return 0
    local msg="$1"; read -r -p "$msg [type YES to continue] " ans
    [[ "$ans" == "YES" ]] || { echo "Aborted." >&2; exit 1; }
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Workdir: $WORK"

# --- 1. Get bundle ----------------------------------------------------------
if [[ "$BUNDLE" =~ ^s3:// ]]; then
    echo "-- Downloading $BUNDLE"
    run "aws s3 cp '$BUNDLE'         '$WORK/'  --no-progress"
    run "aws s3 cp '$BUNDLE.sha256'  '$WORK/'  --no-progress"
    LOCAL_GPG="$WORK/$(basename "$BUNDLE")"
    SHA256="$WORK/$(basename "$BUNDLE").sha256"
else
    LOCAL_GPG="$BUNDLE"
    SHA256="$BUNDLE.sha256"
fi

# --- 2. Verify checksum -----------------------------------------------------
echo "-- Verifying SHA-256"
if [[ -f "$SHA256" ]]; then
    ( cd "$(dirname "$LOCAL_GPG")" && sha256sum -c "$(basename "$SHA256")" )
else
    echo "  WARN: no .sha256 file alongside bundle — skipping verification" >&2
fi

# --- 3. Decrypt -------------------------------------------------------------
echo "-- GPG decrypting"
LOCAL_TAR="${LOCAL_GPG%.gpg}"
if [[ -n "$GPG_RECIPIENT" ]]; then
    run "gpg --batch --yes --output '$LOCAL_TAR' --decrypt '$LOCAL_GPG'"
else
    run "gpg --batch --yes --output '$LOCAL_TAR' --decrypt --passphrase-file '$GPG_PASS_FILE' '$LOCAL_GPG'"
fi

# --- 4. Untar ---------------------------------------------------------------
echo "-- Extracting"
run "tar -C '$WORK' -xf '$LOCAL_TAR'"
EXTRACTED="$(find "$WORK" -maxdepth 1 -type d -name 'mirth-backup-*' | head -1)"
[[ -z "$EXTRACTED" && "$DRY_RUN" == "0" ]] && { echo "extracted dir not found"; exit 1; }
echo "  -> $EXTRACTED"

# --- 5. Restore Postgres ----------------------------------------------------
confirm "About to drop+restore database $PG_DB on $PG_HOST:$PG_PORT."
echo "-- Restoring Postgres dump"
run "PGPASSWORD='$PG_PASS' pg_restore -h '$PG_HOST' -p '$PG_PORT' -U '$PG_USER' \
     -d '$PG_DB' --clean --if-exists --no-owner --no-privileges \
     '$EXTRACTED/mirthdb.dump'"

# --- 6. Reimport channels via REST -----------------------------------------
echo "-- Reimporting channels"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' -H 'X-Requested-With: restore.sh' \
     -H 'Content-Type: application/xml' -X PUT \
     --data-binary @'$EXTRACTED/channels.xml' \
     '$MIRTH_HOST/api/channels?override=true' -o '$WORK/import-channels.log' -w '  HTTP %{http_code}\n'"

echo "-- Reimporting code templates"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' -H 'X-Requested-With: restore.sh' \
     -H 'Content-Type: application/xml' -X PUT \
     --data-binary @'$EXTRACTED/codeTemplates.xml' \
     '$MIRTH_HOST/api/codeTemplates?override=true' -o '$WORK/import-ct.log' -w '  HTTP %{http_code}\n'"

echo "-- Reimporting alerts"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' -H 'X-Requested-With: restore.sh' \
     -H 'Content-Type: application/xml' -X PUT \
     --data-binary @'$EXTRACTED/alerts.xml' \
     '$MIRTH_HOST/api/alerts?override=true' -o '$WORK/import-alerts.log' -w '  HTTP %{http_code}\n'"

echo "-- Reimporting configurationMap"
run "curl -sk -u '$MIRTH_USER:$MIRTH_PASS' -H 'X-Requested-With: restore.sh' \
     -H 'Content-Type: application/json' -X PUT \
     --data-binary @'$EXTRACTED/configurationMap.json' \
     '$MIRTH_HOST/api/server/configurationMap' -o '$WORK/import-cm.log' -w '  HTTP %{http_code}\n'"

# --- 7. Optional keystore overwrite ----------------------------------------
if [[ "$APPLY_KEYSTORES" == "1" ]]; then
    confirm "About to overwrite /opt/connect/certs and /opt/connect/custom-lib."
    if [[ -f "$EXTRACTED/keystores.tar.gz" ]]; then
        run "tar -C / -xzf '$EXTRACTED/keystores.tar.gz'"
    fi
    if [[ -f "$EXTRACTED/custom-lib.tar.gz" ]]; then
        run "tar -C / -xzf '$EXTRACTED/custom-lib.tar.gz'"
    fi
    echo "  Restart Mirth Connect to pick up keystores and custom-lib changes."
else
    echo
    echo "NOTE: Keystores + custom-lib NOT applied. Inspect:"
    echo "      $EXTRACTED/keystores.tar.gz"
    echo "      $EXTRACTED/custom-lib.tar.gz"
    echo "      then re-run with --apply-keystores or extract manually."
fi

echo
echo "Restore complete. Verify channels are STARTED and run a smoke message."
