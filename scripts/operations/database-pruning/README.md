# Recipe #34 — Database Pruning + VACUUM

> Keep `mirthdb` small, fast, and predictable. Drives the Mirth Data Pruner via REST, then VACUUMs the per-channel message tables.

## What this recipe gives you

- `prune.sh` — triggers Mirth's built-in Data Pruner, runs `VACUUM (ANALYZE)` on `d_mm*` / `d_mcm*` / `d_mcs*` / `d_ma*` / `d_mn*` tables, reports top channels and oldest messages
- `cron-template.sh` — locked, log-rotated nightly wrapper
- Tuning guidance pulled from the NextGen Connect Discourse forum (pruner batch size, archive flag, message storage modes)

## Why bother

Mirth stores **every message** plus its raw/transformed/encoded content plus connector-level state in per-channel tables prefixed `d_m{m,cm,cs,a,n}_<channelId>`. Without pruning:

- a single ADT channel doing 5/sec produces ~430k rows/day and ~13M rows/month
- the d_mm table alone exceeds the working set of any sensible buffer pool
- channel UI ("View Messages") becomes unusable
- VACUUM autovacuum thresholds never trigger because of `autovacuum_vacuum_scale_factor=0.2` against a billion-row table — dead tuples accumulate forever

A nightly prune + VACUUM ANALYZE typically reclaims 30-70% of disk and brings p95 channel UI latency from minutes back to seconds.

## Recommended NextGen Data Pruner settings

Mirth Connect Administrator -> **Settings -> Data Pruner**:

| Setting | Recommended | Why |
|---|---|---|
| Polling Type | Interval | predictable load |
| Polling Interval | nightly @ 02:00 | offpeak |
| Block Size | **99** | NextGen forum consensus — values >100 cause `IN (...)` parser limits on some JDBC drivers; 99 stays under |
| Page Size | 1000 | balance memory vs round trips |
| Archive enabled | **false** (default) | only enable if compliance requires raw retention; otherwise just emit FHIR `AuditEvent` (Recipe #32) |
| Prune events | enabled | events table grows fast and is rarely queried |
| Default content retention | 7 days | how long to keep raw + transformed + encoded payloads |
| Default metadata retention | 30 days | how long to keep the message row itself |

Per-channel overrides on **Channel Setup -> Message Storage**:
- High-volume ADT/ORU feeds: 3 days content / 14 days metadata
- Low-volume but audit-critical: keep metadata forever, content 30 days
- Side-car audit trail (Recipe #32): **production storage**, no pruning

## Where the files live

```
scripts/operations/database-pruning/
├── README.md           <-- this file
├── prune.sh            <-- one-shot prune + VACUUM with --dry-run
└── cron-template.sh    <-- nightly wrapper with flock + log rotation
```

## Setup

```bash
chmod +x scripts/operations/database-pruning/*.sh

# Stash credentials outside the repo
sudo mkdir -p /etc/mirth
sudo tee /etc/mirth/prune.env >/dev/null <<'EOF'
MIRTH_HOST=https://mirth.internal:8443
MIRTH_USER=admin
MIRTH_PASS=...
PG_HOST=mirth-db.internal
PG_PORT=5432
PG_DB=mirthdb
PG_USER=mirthdb
PG_PASS=...
EOF
sudo chmod 600 /etc/mirth/prune.env
```

## Run it

```bash
# Dry-run first to see what would be executed
./scripts/operations/database-pruning/prune.sh --dry-run

# Real run (default = VACUUM ANALYZE, no lock)
./scripts/operations/database-pruning/prune.sh

# Heavy reclaim (locks the table per VACUUM FULL — schedule a maintenance window)
./scripts/operations/database-pruning/prune.sh --vacuum-mode full
```

Sample output (real run, abbreviated):

```
============================================================
 Mirth Connect — Pruning + VACUUM
 Mirth API  : https://mirth.internal:8443
 PostgreSQL : mirth-db.internal:5432/mirthdb
 Mode       : quick  (retention=30 days)
============================================================
-- Triggering Mirth Data Pruner
  HTTP 200
-- Top 10 channels by message count
d_mm12  |  4823591
d_mm5   |  3110200
...
-- Oldest message timestamp per top channel
  d_mm12 : oldest received_date = 2026-04-29 02:00
-- Running VACUUM on Mirth message tables (quick mode)
  d_mm12 ... OK
  d_mcm12 ... OK
  ...
-- Database size after VACUUM
 4823 MB
```

## Schedule nightly

Option A — `cron.d`:

```bash
sudo tee /etc/cron.d/mirth-prune >/dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 2 * * *  root  /opt/mirth-cookbook/scripts/operations/database-pruning/cron-template.sh
EOF
```

Option B — Kubernetes CronJob (sketch):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: mirth-prune }
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: prune
            image: postgres:16-alpine
            envFrom: [{ secretRef: { name: mirth-prune-env } }]
            volumeMounts: [{ name: scripts, mountPath: /scripts }]
            command: ["/scripts/prune.sh"]
```

## Diagnostic queries (paste into `psql`)

```sql
-- Hot tables right now
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
WHERE relname LIKE 'd_m%'
ORDER BY dead_pct DESC NULLS LAST
LIMIT 10;

-- Bloat estimate (requires pgstattuple extension)
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT relname, pg_size_pretty(pg_relation_size(oid)) AS size,
       (pgstattuple(oid)).dead_tuple_percent
FROM pg_class WHERE relname LIKE 'd_mm_%' ORDER BY pg_relation_size(oid) DESC LIMIT 5;

-- Replication-safe pruning check: latest archived LSN > pruner's latest delete
SELECT pg_current_wal_lsn(), pg_last_wal_replay_lsn();
```

## When VACUUM is not enough

If `pg_database_size` doesn't shrink even after `VACUUM ANALYZE`:

1. Run `VACUUM FULL` during a maintenance window — it rewrites the heap. Locks the table; budget ~5 min per 10 GB on a SAS SSD.
2. If still huge: consider **partitioning** `d_mm_<chan>` by `received_date` (monthly). Drop old partitions instead of deleting rows.
3. As a last resort: `pg_dump --schema=public --data-only`, drop+recreate the DB, restore. Schedule as 4-hour downtime.

## Verification (syntax check)

```bash
bash -n scripts/operations/database-pruning/prune.sh && echo "syntax ok"
bash -n scripts/operations/database-pruning/cron-template.sh && echo "syntax ok"
```

## Tested on

- Mirth Connect 4.5.2
- PostgreSQL 16 alpine + Postgres 14 on Ubuntu 22.04
- bash 5.x on macOS + Debian 12

## Author / License

Author: Nirmitee.io
License: MIT
