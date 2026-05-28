#!/usr/bin/env bash
#
# Recipe #34 — Cron wrapper for nightly Mirth pruning + VACUUM
#
# Install:
#   sudo cp cron-template.sh /etc/cron.d/mirth-prune
#   sudo chmod 644 /etc/cron.d/mirth-prune
#
# Or as a user crontab line:
#   0 2 * * *  /opt/mirth-cookbook/scripts/operations/database-pruning/cron-template.sh
#
# Logs go to /var/log/mirth/prune.log (rotate via /etc/logrotate.d/mirth)
#
# Tested on: cron / cron.d on Debian + Alpine
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/mirth"
LOG_FILE="${LOG_DIR}/prune-$(date +%Y%m%d).log"

mkdir -p "$LOG_DIR"

# Source environment file with credentials (gitignored)
if [[ -f /etc/mirth/prune.env ]]; then
    # shellcheck disable=SC1091
    set -a; . /etc/mirth/prune.env; set +a
fi

# Lock to prevent overlap if a previous run is still going (e.g. VACUUM FULL)
LOCK="/var/run/mirth-prune.lock"
exec 9>"$LOCK" || exit 1
flock -n 9 || { echo "$(date) — previous prune still running, skipping" >>"$LOG_FILE"; exit 0; }

{
    echo "============================================================"
    echo " mirth-prune run @ $(date -u +%FT%TZ)"
    echo "============================================================"
    "$SCRIPT_DIR/prune.sh"
    echo "exit=$?"
} >>"$LOG_FILE" 2>&1

# Keep 14 days of prune logs
find "$LOG_DIR" -maxdepth 1 -name 'prune-*.log' -mtime +14 -delete
