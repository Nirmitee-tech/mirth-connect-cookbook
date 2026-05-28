# HL7v2 ORU Fan-Out → API + DB + Excel

> One inbound HL7v2 lab result, three independent destinations: a downstream REST API (HTTP), a Postgres table (DB), and an Excel-friendly CSV file. The textbook fan-out pattern.

## What this demonstrates

A single source message fans out to **three destinations that run in parallel and fail independently**. If the downstream API is down, the DB and CSV still succeed. If the DB is being restarted, the API and CSV still succeed.

```
   ORU^R01 over MLLP :6680
           │
           ▼
   ┌──────────────────────────────────┐
   │ Source: TCP Listener             │
   │   Source transformer:            │
   │     parse PID, OBR, OBX once,    │
   │     stash in channelMap          │
   └──────────────────────────────────┘
           │
           ├──────────────┬──────────────┐
           ▼              ▼              ▼
   ┌────────────┐ ┌──────────────┐ ┌─────────────┐
   │ Dest 1     │ │ Dest 2       │ │ Dest 3      │
   │ HTTP Send  │ │ DB Writer    │ │ File Writer │
   │ → REST API │ │ → Postgres   │ │ → CSV       │
   │            │ │              │ │             │
   │ queue:on   │ │ queue:on     │ │ queue:on    │
   │ retry:1    │ │ retry:3      │ │ retry:1     │
   │ thread:4   │ │ thread:4     │ │ thread:1    │
   └────────────┘ └──────────────┘ └─────────────┘
```

## Common real-world targets for Destination 1

Any HTTP-speaking system that needs the structured lab data:

- **Patient portal**: notify the patient their result is available
- **Notification service** (Slack / Teams / PagerDuty): alert on abnormal flags
- **Clinical data warehouse REST API**: ingest structured result
- **Downstream FHIR server**: post a DiagnosticReport
- **CRM** (e.g., Salesforce Health Cloud): update patient record
- **AI / LLM gateway**: clinical summary or auto-coding (just swap the URL + payload)

Same channel pattern — the only thing that changes between targets is the JSON payload shape and the URL.

## Why fan-out matters in healthcare integration

Every clinical message has multiple consumers:

- A **lab result** goes to the EHR chart, the analytics warehouse, the patient portal, and the QA review pipeline — that's already 4 destinations.
- An **ADT message** goes to bed management, the census board, the billing pre-auth flow, the patient portal, and the data lake — 5 destinations.
- A **claim** goes to the clearinghouse, the internal AR system, the audit log, and the data warehouse — 4 destinations.

Point-to-point integrations mean N×M connections. Fan-out through Mirth means N+M.

## Files in this recipe

| File | What it is |
|---|---|
| `transformers/source-transformer.js` | Parses ORU once, stashes fields in `channelMap` for all destinations |
| `transformers/dest1-api-payload.js` | Builds the JSON payload posted to the downstream API |
| `transformers/dest1-api-response.js` | Handles the API response, stashes `apiAckId` + `apiStatus` in `channelMap` |
| `transformers/dest2-db-write.js` | Builds the bind-variable map for the parameterized SQL INSERT |
| `transformers/dest3-excel-row.js` | Formats one RFC 4180 CSV row including the API ack columns |
| `sql/schema.sql` | Postgres `lab_results` table + indexes |
| `test/sample-oru-r01.hl7` | Sample CBC ORU with WBC high + Platelets low |
| `test/mock-api-server.py` | Local API echo server so you can test without a real downstream system |
| `test/test-fanout.sh` | End-to-end smoke test: send → verify DB row → verify CSV row |
| `build-channel.py` | **(Experimental)** Builds a `channel.xml` by stitching the JS into Mirth's XML format. See the import caveat below. |

## Quick start

### Option A — Manual import (recommended)

This is the path real Mirth teams use. The GUI handles the XStream XML quirks for you.

1. **Create the destination table:**
   ```bash
   psql -h localhost -p 5433 -U mirthdb -d mirthdb < sql/schema.sql
   ```

2. **Start the mock API server:**
   ```bash
   python3 test/mock-api-server.py
   # listens on :8089
   ```

3. **In the Mirth Administrator GUI, create the channel:**
   - **New Channel** → Name: `HL7v2 ORU Fan-Out (API + DB + Excel)`
   - **Source tab**:
     - Connector Type: **TCP Listener** (MLLP)
     - Listener Address: `0.0.0.0:6680`
     - Inbound data type: `HL7 V2.x`
     - Source Transformer: paste contents of `transformers/source-transformer.js`
   - **Destination 1 — "Downstream API"**:
     - Connector Type: **HTTP Sender**
     - URL: `http://host.docker.internal:8089/api/lab-results`
     - Method: `POST`
     - Content-Type: `application/json`
     - **Destination transformer**: paste `transformers/dest1-api-payload.js`. Use `${message.encodedData}` as the request content.
     - **Response transformer**: paste `transformers/dest1-api-response.js`
     - Queue: enabled, Retry: 1, Thread count: 4
   - **Destination 2 — "DB Write (Postgres)"**:
     - Connector Type: **Database Writer**
     - Driver: PostgreSQL
     - URL: `jdbc:postgresql://mirth-db:5432/mirthdb`
     - Username/password: `mirthdb` / `mirthdb`
     - SQL: copy the INSERT statement from `build-channel.py` (look for the `<query>` block in `build_db_destination`)
     - Destination transformer: paste `transformers/dest2-db-write.js`
     - Queue: enabled, Retry: 3, Thread count: 4
   - **Destination 3 — "Excel CSV Append"**:
     - Connector Type: **File Writer**
     - Directory: `/opt/connect/appdata`
     - File name: `lab-results.csv`
     - Append: enabled, Charset: UTF-8
     - Template: `${message.encodedData}`
     - Destination transformer: paste `transformers/dest3-excel-row.js`
     - Queue: enabled, Thread count: 1 (single writer to avoid interleaved lines)

4. **Deploy** the channel.

5. **Run the smoke test:**
   ```bash
   ./test/test-fanout.sh
   ```

### Option B — Build channel.xml from the JS files (experimental)

```bash
python3 build-channel.py > channel.xml
```

Then **Channels → Import Channel** in the Mirth Administrator and select `channel.xml`.

**Import caveat:** Mirth's XStream-based deserializer is strict about field ordering and undocumented version markers. Auto-generated XML occasionally fails to import even when structurally valid; Mirth then surfaces a misleading "A channel with that name already exists" error. If that happens, fall back to Option A (manual GUI build) — the channel.xml is still useful as a reference for the destination configurations.

The PRs that make this builder bulletproof are good first contributions to the cookbook. The pattern, the JS transformers, the schema, and the test harness are all stable — only the XML stitching is fragile.

## How the channelMap pattern works

The source transformer parses the HL7v2 message **once** and writes every extracted field to `channelMap`. Every destination transformer reads from `channelMap` instead of re-parsing the raw message. This:

1. **Halves parse cost** when there are 3+ destinations
2. **Makes destinations read-only consumers** — they consume facts, they don't decide what the facts are
3. **Centralizes "what does this message say"** in one place — if the upstream EHR changes its segment layout, fix it once

`channelMap` is per-message, automatically scoped, and cleared when the message exits the channel. No leakage, no concurrency issues.

## How each destination handles failure

Mirth's per-destination **queue** is the key. Each destination connector in this recipe has `queueEnabled=true`. That means:

- If Destination 1 (API) is timing out, messages queue **only for Destination 1**. Destinations 2 and 3 continue to flow.
- When Destination 1 recovers, the queue drains automatically.
- Retry policy is per-destination: API gets 1 retry (we want quick failure visibility), DB gets 3 (transient connection blips are normal), CSV gets 1 (append failures are usually disk-full and need human attention).

Without per-destination queues, one slow destination blocks everything. This is the foundation of resilient fan-out.

## Order dependencies and `waitForPrevious`

- **Destination 1 (API)**: `waitForPrevious=true` — must complete before D2 runs, because D2 wants to persist the API ack id in the row
- **Destination 2 (DB)**: `waitForPrevious=false` — runs in parallel with D3 once D1 completes
- **Destination 3 (CSV)**: `waitForPrevious=false` — runs in parallel with D2

If you want raw lab data persisted even when the API is unavailable (e.g., during downstream incidents), set `waitForPrevious=false` on D1 and remove the API columns from D2's INSERT.

## Production swap-ins

| Local demo | Production swap |
|---|---|
| `mock-api-server.py:8089` | Real downstream API endpoint with credentials in `configurationMap` |
| Hardcoded DB credentials in channel.xml | Pull from Vault / AWS Secrets Manager via a code template; never commit secrets |
| File Writer to local container path | Network share / S3 / SFTP target so other systems can pick it up |
| Mock always returns `200 OK` | Real API gateway with rate limiting + audit logging |

## Channel configuration knobs to tune for your environment

| Setting | Demo value | Production guidance |
|---|---|---|
| Source `port` | 6680 | Whatever port your upstream lab system targets |
| Source `processingThreads` | 1 | Increase if upstream pushes faster than Mirth can fan out |
| Destination `threadCount` | 4 (API/DB), 1 (CSV) | API/DB scale horizontally; CSV is single-writer |
| Destination `queueBufferSize` | 1000 | Increase for high-volume — but if it grows unbounded, the downstream is too slow |
| D1 `socketTimeout` | 15000ms | Tune to your downstream API's typical latency |
| D2 `retryCount` | 3 | Catches transient DB connection blips |
| D3 `outputAppend` | true | If false, every message overwrites the file (almost never what you want) |

## Things this recipe deliberately does NOT do

1. **Native .xlsx output** — would require a Java library on the Mirth classpath (Apache POI). CSV is universally Excel-compatible and avoids the dependency. If you need true .xlsx, generate CSV here and post-process with a separate worker.
2. **Idempotency beyond DB `ON CONFLICT`** — if the same message arrives twice, the DB skips it via `UNIQUE (message_id)`, but the CSV gets duplicate rows and the API is called twice. For true exactly-once, gate the whole fan-out behind a deduplication source transformer.
3. **PHI in third-party API payloads** — for HIPAA, the downstream API endpoint must be BAA-covered, or you must de-identify the payload (replace MRN, name, DOB) before sending. We send full data in the demo so you can see the flow.

## Where this fits in the cookbook

This is the canonical fan-out example. Related recipes:

- **`code-templates/circuit-breaker/`** — drop in front of D1 if your API is flaky
- **`code-templates/rate-limiter/`** — throttle D1 to stay under the downstream rate limit
- **`code-templates/phi-masking/`** — de-identify the API payload before sending
- **`docker/hospital-operations-dashboard/`** — observability view that classifies this channel as "Results" and tracks per-destination queue depth
- **`scripts/operations/interface-catalog-generator/`** — produces a documentation page for this channel showing all three destinations and their config
