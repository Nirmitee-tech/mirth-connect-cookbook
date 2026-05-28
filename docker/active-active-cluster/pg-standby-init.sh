#!/bin/sh
# Recipe #46 — PostgreSQL standby bootstrap via pg_basebackup
# Tested on PostgreSQL 16
# Author: Nirmitee.io | License: MIT
set -eu

PGDATA="/var/lib/postgresql/data"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "[pg-standby-init] empty data dir — performing pg_basebackup from $PRIMARY_HOST"

    # Wait until primary is reachable
    until PGPASSWORD="$REPL_PASSWORD" pg_isready -h "$PRIMARY_HOST" -U "$REPL_USER"; do
        echo "[pg-standby-init] waiting for primary..."
        sleep 2
    done

    rm -rf "${PGDATA:?}"/*

    PGPASSWORD="$REPL_PASSWORD" pg_basebackup \
        -h "$PRIMARY_HOST" \
        -D "$PGDATA" \
        -U "$REPL_USER" \
        -Fp -Xs -P -R \
        -S standby_slot

    chmod 700 "$PGDATA"
    chown -R postgres:postgres "$PGDATA"

    echo "[pg-standby-init] base backup complete — starting in standby mode"
fi

# Hand off to the real postgres entrypoint
exec docker-entrypoint.sh postgres -c hot_standby=on
