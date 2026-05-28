#!/usr/bin/env bash
#
# Recipe #34 — Database Pruning + VACUUM Script
# prune.sh — runs Mirth Data Pruner trigger, then VACUUM ANALYZE on d_mm* tables
#
# Usage:
#   ./prune.sh [--dry-run] [--mirth-host HOST] [--mirth-user USER] [--mirth-pass PASS]
#              [--pg-host HOST] [--pg-db DB] [--pg-user USER] [--vacuum-mode quick|full]
#              [--retention-days N]
#
# Behavior:
#   1. Optionally calls Mirth REST API to trigger Data Pruner immediately
#   2. Runs VACUUM (ANALYZE) on Mirth's d_mm_<channelId>, d_mcm_<channelId>,
#      d_mcs_<channelId>, d_ma_<channelId>, d_mn_<channelId> tables
#   3. Reports top channels by row count
#
# --vacuum-mode quick : VACUUM ANALYZE (default, no exclusive lock)
# --vacuum-mode full  : VACUUM FULL    (rewrites table, locks; downtime only)
#
# Tested on: Mirth Connect 4.5.2, PostgreSQL 16, bash 5.x
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

DRY_RUN=0
MIRTH_HOST="${MIRTH_HOST:-https://localhost:8443}"
MIRTH_USER="${MIRTH_USER:-admin}"
MIRTH_PASS="${MIRTH_PASS:-admin}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5433}"
PG_DB="${PG_DB:-mirthdb}"
PG_USER="${PG_USER:-mirthdb}"
PG_PASS="${PG_PASS:-mirthdb}"
VACUUM_MODE="quick"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

usage() { sed -n '2,18p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)         DRY_RUN=1; shift ;;
        --mirth-host)      MIRTH_HOST="$2"; shift 2 ;;
        --mirth-user)      MIRTH_USER="$2"; shift 2 ;;
        --mirth-pass)      MIRTH_PASS="$2"; shift 2 ;;
        --pg-host)         PG_HOST="$2"; shift 2 ;;
        --pg-db)           PG_DB="$2"; shift 2 ;;
        --pg-user)         PG_USER="$2"; shift 2 ;;
        --vacuum-mode)     VACUUM_MODE="$2"; shift 2 ;;
        --retention-days)  RETENTION_DAYS="$2"; shift 2 ;;
        -h|--help)         usage ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

run() {
    if [[ "$DRY_RUN" == "1" ]]; then printf '  [dry-run] %s\n' "$*"
    else eval "$@"; fi
}

psql_q() {
    PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "$1"
}

echo "============================================================"
echo " Mirth Connect — Pruning + VACUUM"
echo " Mirth API  : $MIRTH_HOST"
echo " PostgreSQL : $PG_HOST:$PG_PORT/$PG_DB"
echo " Mode       : $VACUUM_MODE  (retention=$RETENTION_DAYS days)"
echo " Dry-run    : $DRY_RUN"
echo "============================================================"

# --- 1. Trigger Mirth Data Pruner via REST -----------------------------------
echo
echo "-- Triggering Mirth Data Pruner (POST /api/extensions/datapruner/_prune)"
CURL=(curl -sk -u "$MIRTH_USER:$MIRTH_PASS" -H "X-Requested-With: prune.sh"
      -H "Content-Type: application/xml" -H "Accept: application/json"
      -X POST "$MIRTH_HOST/api/extensions/datapruner/_prune")
if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry-run] ${CURL[*]}"
else
    if ! "${CURL[@]}" -w "\n  HTTP %{http_code}\n" --max-time 30; then
        echo "  WARN: Mirth pruner trigger failed (continuing with VACUUM)" >&2
    fi
fi

# --- 2. Diagnostics ----------------------------------------------------------
echo
echo "-- Top 10 channels by message count"
psql_q "
SELECT relname AS table_name,
       (SELECT reltuples::bigint FROM pg_class WHERE oid = c.oid) AS approx_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND relname LIKE 'd_mm%'
ORDER BY approx_rows DESC
LIMIT 10;
" | column -t -s '|'

echo
echo "-- Oldest message timestamp per top channel"
psql_q "
SELECT t.relname,
       (SELECT MIN(received_date) FROM (SELECT received_date FROM ONLY pg_catalog.pg_class) x) AS noop
FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname LIKE 'd_mm%'
LIMIT 1;
" >/dev/null || true
# Per-table oldest message (sampled — costs sequential scan, only run on demand)
for tbl in $(psql_q "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname LIKE 'd_mm_%' ORDER BY reltuples::bigint DESC LIMIT 5;"); do
    AGE=$(psql_q "SELECT to_char(MIN(received_date), 'YYYY-MM-DD HH24:MI') FROM $tbl;")
    echo "  $tbl : oldest received_date = ${AGE:-<empty>}"
done

# --- 3. VACUUM --------------------------------------------------------------
echo
echo "-- Running VACUUM on Mirth message tables ($VACUUM_MODE mode)"
TABLES=$(psql_q "
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public'
  AND relname ~ '^d_m[mcsan]_'
ORDER BY relname;
")

VACUUM_CMD="VACUUM (ANALYZE)"
[[ "$VACUUM_MODE" == "full" ]] && VACUUM_CMD="VACUUM (FULL, ANALYZE)"

for tbl in $TABLES; do
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  [dry-run] $VACUUM_CMD $tbl;"
    else
        printf '  %s ... ' "$tbl"
        PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
            -c "$VACUUM_CMD $tbl;" >/dev/null
        echo "OK"
    fi
done

# --- 4. Post-vacuum disk reclaim report -------------------------------------
echo
echo "-- Database size after VACUUM"
psql_q "SELECT pg_size_pretty(pg_database_size('$PG_DB'));"

echo
echo "Done."
