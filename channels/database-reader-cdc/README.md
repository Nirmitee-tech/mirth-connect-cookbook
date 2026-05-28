# Database Reader — CDC Polling with Persisted Watermark

Mirth Database Reader source that **polls a Postgres table for changes every 30 seconds**, with a high-watermark stored in Mirth's `configurationMap` so it survives restarts, and a 1-minute lookback window to catch late-arriving rows.

Use when you need streaming-style change capture without bringing in Debezium, Kafka Connect, or Postgres logical replication — for cases where your source DBA won't grant `REPLICATION` role but will let you `SELECT` an `updated_at` column.

## What it does

```
                  ┌────────────────────────────────────────┐
                  │            lab_results table           │
                  │  result_id │ mrn │ ... │ updated_at    │
                  └────────────────────────────────────────┘
                                    │
                                    │   every 30s:
                                    │   SELECT ... WHERE updated_at > ?
                                    │   ORDER BY updated_at, result_id
                                    │   LIMIT 500
                                    ▼
              ┌───────────────────────────────────────────┐
              │  Mirth Database Reader (this recipe)      │
              │  - reads watermark from configurationMap  │
              │  - applies 60s lookback for late commits  │
              │  - emits one Mirth message per row        │
              │  - persists new watermark on success      │
              └───────────────────────────────────────────┘
                                    │
                                    ▼
                      [ transformers / destinations ]
```

## Key properties

- **Restart-safe**: watermark in `configurationMap` is persisted to Mirth's OPTIONS table — survives JVM restart, channel redeploy, and HA failover.
- **Late-row safe**: 60-second lookback window means rows whose `updated_at` is older than the snapshot we just took (common across concurrent transactions) still get picked up next cycle.
- **Bounded batches**: `MAX_BATCH=500` ceiling prevents a noisy hour from locking the channel.
- **Stable ordering**: `(updated_at, result_id)` is the sort key — pure `updated_at` is not strictly unique under load.
- **Idempotent downstream**: pair with a dedup transformer keyed on `(mrn, accession_num)` so the lookback overlap is harmless.

## Source DDL

Lives in [sql/source-table.sql](sql/source-table.sql). The key bits:

```sql
CREATE TABLE lab_results (
    result_id     bigserial PRIMARY KEY,
    mrn           text NOT NULL,
    accession_num text UNIQUE NOT NULL,
    -- ... payload columns ...
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_results_updated_idx ON lab_results (updated_at, result_id);
-- BEFORE UPDATE trigger sets NEW.updated_at = now()
```

The index on `(updated_at, result_id)` is non-negotiable — without it your polling query degrades to a sequential scan on every cycle and you'll lock the table.

## Where to install

1. **Channel → Source → Connector type:** Database Reader
2. Configure:
   - **Driver:** `org.postgresql.Driver` (drop `postgresql-42.x.x.jar` into `custom-lib/` if missing)
   - **URL:** `${cdc.db.url}`
   - **Username/Password:** `${cdc.db.user}` / `${cdc.db.pass}`
   - **Use JavaScript:** **YES** — paste [javascript/reader.js](javascript/reader.js) into the script box
   - **Polling type:** Interval — **30000** ms (30s)
   - **Aggregate results:** unchecked (one message per row)
3. **Settings → Configuration Map:** populate:

   | Key | Default | Purpose |
   |---|---|---|
   | `cdc.db.url` | `jdbc:postgresql://localhost:5432/cdc_demo` | JDBC URL |
   | `cdc.db.user` | `mirth` | DB user |
   | `cdc.db.pass` | `changeme` | DB password |
   | `cdc.db.driver` | `org.postgresql.Driver` | JDBC driver class |
   | `cdc.table` | `lab_results` | Source table |
   | `cdc.late.window.ms` | `60000` | Lookback window for late commits |
   | `cdc.initial.backfill.hours` | `1` | On first run, how far back to backfill |
   | `cdc.max.batch` | `500` | Per-cycle row cap |
   | `cdc.watermark.key` | `cdc.watermark.lab_results` | configurationMap key for persisted watermark |

4. Deploy. The first poll cycle will backfill 1 hour; subsequent cycles only emit changes since the last watermark.

## Test

```bash
# 1) Bootstrap the schema and seed data
psql -h localhost -U mirth -d cdc_demo -f sql/source-table.sql

# 2) Deploy the channel in Mirth Administrator and watch the log:
#    Channel → Dashboard → Logs → Server Log
#    You should see (within 30 seconds):
#    CDC poll: table=lab_results lastWatermark=null effectiveBound=2026-05-28T07:30:00.000Z
#    CDC poll: emitted 3 rows. Advanced watermark → 2026-05-28T08:30:12.345Z

# 3) Insert a new row — should appear within 30 seconds
psql -h localhost -U mirth -d cdc_demo -c "
  INSERT INTO lab_results (mrn, accession_num, loinc_code, loinc_display, value_num, units)
  VALUES ('MRN-004', 'ACC-2026-004', '2951-2', 'Sodium', 138, 'mmol/L');
"

# 4) Update an existing row — touch trigger fires, poller picks it up
psql -h localhost -U mirth -d cdc_demo -c "
  UPDATE lab_results SET result_status = 'corrected', value_num = 7.4
  WHERE accession_num = 'ACC-2026-001';
"

# 5) Verify the persisted watermark survives restart:
#    Stop Mirth, start Mirth, observe that the next poll uses the saved
#    watermark (no backfill, no double-emission).

# 6) Verify late-row safety:
#    Open two psql sessions. In session A: BEGIN; INSERT a row.
#    In session B: BEGIN; INSERT a row; COMMIT.
#    Now COMMIT in A. Both inserts have updated_at values determined at
#    commit, not insert. The lookback window means A's row is picked up
#    even though its updated_at is older than the snapshot Mirth read
#    while A was still uncommitted.
```

## Watermark inspection

Watermarks are persisted in Mirth's `OPTIONS` table:

```sql
SELECT name, value FROM options WHERE name LIKE 'cdc.watermark.%';
```

In Mirth Administrator: **Settings → Configuration Map** — your watermark key is visible / editable. Manually editing it is useful for replay (set it backward in time) and for force-skipping a poison row.

## Customize

- **MS SQL / Oracle / MySQL** — swap the driver, change the timestamp formatting in the SELECT. Watch out for `TIMESTAMP WITH LOCAL TIME ZONE` vs `TIMESTAMPTZ` semantics.
- **Multiple tables in one channel** — duplicate the body of `reader.js` per table, each with its own watermark key (`cdc.watermark.<table>`).
- **Per-tenant filtering** — add `AND tenant_id = ?` to the SQL and read `cdc.tenant.id` from configurationMap.
- **Soft-delete handling** — add `OR deleted_at > ?` to the WHERE clause if your table soft-deletes. Track a separate `cdc.tombstone.watermark.<table>` key.
- **Hard-failure backoff** — wrap the `DriverManager.getConnection` call in a retry-with-cap (see `code-templates/circuit-breaker/`) so a DB outage doesn't spam the log every 30s.

## Production considerations

- **Index pressure**: `(updated_at, result_id)` will grow with the table. On hot OLTP tables, consider a `WHERE updated_at > now() - interval '30 days'` partial index.
- **Clock skew**: this script trusts the database clock. If you run Mirth on a separate host from Postgres, sync NTP, and avoid hand-setting timestamps in app code.
- **Watermark drift on empty cycles**: by design we *don't* advance the watermark when 0 rows arrive. On a quiet table this means we always re-scan the lookback window — index makes this cheap.
- **Schema evolution**: if you add columns, update the SELECT *and* the consumer. The script names columns explicitly (no `SELECT *`) to make this drift visible.
- **HA / cluster**: in a Mirth cluster the Database Reader is leader-elected — only the leader polls. The watermark in `configurationMap` is shared cluster-wide, so failover is seamless.

## Files

- [javascript/reader.js](javascript/reader.js) — the polling script
- [sql/source-table.sql](sql/source-table.sql) — sample schema, trigger, and seed
