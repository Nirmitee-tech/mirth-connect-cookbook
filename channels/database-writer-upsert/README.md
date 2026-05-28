# Recipe #7 — Database Writer Upsert (PostgreSQL)

Idempotent persistence of patient admissions from any HL7v2 / FHIR feed using a single `INSERT ... ON CONFLICT DO UPDATE` statement. Replaying the same message a hundred times leaves exactly one row.

## What it does

- Destination connector of type **Database Writer**, mode **JavaScript**.
- Reads `mrn`, `encounterId`, `admissionStatus`, `admissionDate` from the channel map (populated by the source transformer).
- Issues a Postgres UPSERT keyed on `mrn`.
- Updates only when the payload actually changed (`payload_hash IS DISTINCT FROM`) -- so a replayed identical message is a no-op rather than a useless `last_updated` bump.

## Why

The Database Writer's default mode emits naked INSERTs. Replaying a message to recover from a downstream outage then violates the PK constraint, or worse, silently fails. UPSERT makes the channel safe to replay -- a non-negotiable for any production HL7 feed.

## Where to install

| Where | What |
|---|---|
| **Source Connector -> Transformer** | Populate `channelMap`: `mrn`, `encounterId`, `admissionStatus`, `admissionDate` (ISO 8601). Optionally `payloadHash`. |
| **Database -> psql** | Run [sql/schema.sql](sql/schema.sql) once to create the target table + indexes. |
| **Destination Connector -> Database Writer** | Set **Use JavaScript = Yes**. Paste [javascript/writer.js](javascript/writer.js). |
| **Destination -> Database** | Driver `org.postgresql.Driver`, URL `jdbc:postgresql://host:5432/dbname`. |

## Schema

```sql
CREATE TABLE patient_admissions (
    mrn             TEXT        PRIMARY KEY,
    encounter_id    TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    admission_date  TIMESTAMPTZ NOT NULL,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload_hash    TEXT,
    source_channel  TEXT
);
```

See [sql/schema.sql](sql/schema.sql) for full DDL including indexes.

## How the SQL works

```sql
INSERT INTO patient_admissions (mrn, encounter_id, status, admission_date, last_updated, payload_hash, source_channel)
VALUES (?, ?, ?, ?::timestamptz, NOW(), ?, ?)
ON CONFLICT (mrn) DO UPDATE SET
    encounter_id   = EXCLUDED.encounter_id,
    status         = EXCLUDED.status,
    admission_date = EXCLUDED.admission_date,
    last_updated   = NOW(),
    payload_hash   = EXCLUDED.payload_hash,
    source_channel = EXCLUDED.source_channel
WHERE patient_admissions.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash;
```

- `?` placeholders bind via JDBC `PreparedStatement` -- no SQL injection, regardless of channel-map content.
- The trailing `WHERE` clause makes the UPDATE conditional. If the inbound message has the same `payload_hash` as the row already on disk, Postgres reports 0 rows affected and `last_updated` is preserved. Without this guard, every replay would needlessly bump `last_updated`.

## Test method

```bash
# 1) Create the schema
psql -h localhost -U mirth -d mirth -f sql/schema.sql

# 2) Send the same ADT^A01 message TWICE through the channel
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01

# 3) Verify exactly one row exists, with last_updated unchanged on replay
psql -h localhost -U mirth -d mirth -c \
  "SELECT mrn, encounter_id, status, last_updated FROM patient_admissions;"
#  -> exactly 1 row.  last_updated equals the FIRST insert time.

# 4) Send a *different* status for the same MRN (e.g. ADT^A03 discharge)
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A03
psql -h localhost -U mirth -d mirth -c \
  "SELECT mrn, status, last_updated FROM patient_admissions;"
#  -> still 1 row, status='discharged', last_updated NEWER than step 3.
```

Standalone syntax verification:

```bash
node -e 'const vm=require("vm");new vm.Script(require("fs").readFileSync("javascript/writer.js","utf8"));console.log("OK")'
```

Confirmed: writer.js parses cleanly, SQL block is well-formed.

## Customization

- **Different primary key**: change the `PRIMARY KEY` in `schema.sql` and the `ON CONFLICT (mrn)` clause in `writer.js` to match (e.g. composite `(mrn, encounter_id)`).
- **Always update on replay**: drop the `WHERE patient_admissions.payload_hash IS DISTINCT FROM ...` line.
- **Soft delete on discharge**: keep history with a separate `patient_admissions_history` table populated by a Postgres trigger -- this writer is then a single source of "current" state.
- **Other databases**: MySQL uses `ON DUPLICATE KEY UPDATE`, SQL Server uses `MERGE`. The JavaScript scaffold (PreparedStatement, channel-map reads, error handling) is portable.

## Tested on

Mirth Connect 4.5.2 + PostgreSQL 13/14/15 (psql client 16).

Author: Nirmitee.io | License: MIT
