#!/bin/sh
# Recipe #46 — PostgreSQL primary replication setup
# Runs once on first boot via docker-entrypoint-initdb.d
# Tested on PostgreSQL 16
# Author: Nirmitee.io | License: MIT
set -eu

echo "[pg-primary-init] creating replication role"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE ${POSTGRES_REPLICATION_USER}
        WITH REPLICATION LOGIN PASSWORD '${POSTGRES_REPLICATION_PASSWORD}';
    SELECT pg_create_physical_replication_slot('standby_slot');
EOSQL

# Allow replicator from the docker network
cat >> "$PGDATA/pg_hba.conf" <<-EOHBA
host    replication     ${POSTGRES_REPLICATION_USER}     0.0.0.0/0       md5
host    all             all                              0.0.0.0/0       md5
EOHBA

echo "[pg-primary-init] done — restart will load updated pg_hba.conf"
