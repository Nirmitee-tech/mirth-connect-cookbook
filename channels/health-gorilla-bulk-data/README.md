# Recipe #44 — Health Gorilla Bulk Data Pull

**Description.** Implements the FHIR Bulk Data Access ("Flat FHIR")
workflow against Health Gorilla. Initiates a `$export` for
Patient/Encounter/Observation/Condition, polls the `Content-Location`
URL every 30s until the manifest is ready, downloads each NDJSON file
from Health Gorilla's pre-signed S3 URL, parses every line, dedupes
against a 7-day in-memory cache, and ships a collection Bundle on
`channelMap.payload` for the destination connector. Tracks the last
successful `transactionTime` in `configurationMap` so subsequent runs
only pull deltas.

**Use case.** Daily delta sync of clinical data from Health Gorilla into
a downstream data lake / warehouse / FHIR server, without the operational
burden of subscribing to every per-resource event stream.

**Requirements.**
- Mirth Connect 4.5.2+
- Health Gorilla developer account with the **Bulk Data** scope enabled
- OAuth2 client credentials + the cookbook's JWT signer code template
  at [`/code-templates/http-sender-oauth2-jwt/`](../../code-templates/http-sender-oauth2-jwt/)
  exposing `getHealthGorillaAccessToken()`
- Apache HttpClient on classpath (default Mirth)
- Configuration Map keys:
  - `healthgorilla.base.url` (default `https://sandbox.healthgorilla.com/fhir/R4`)
  - `healthgorilla.export.types` (default `Patient,Encounter,Observation,Condition`)
  - `healthgorilla.poll.interval.seconds` (default `30`)
  - `healthgorilla.poll.timeout.minutes` (default `60`)

**Tested on.** Mirth Connect 4.5.2 against the Health Gorilla sandbox  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
health-gorilla-bulk-data/
├── README.md
└── transformer.js
```

## Where to install

1. Load the OAuth2 code template (see
   [code-templates/http-sender-oauth2-jwt/](../../code-templates/http-sender-oauth2-jwt/))
   and extend it with a `getHealthGorillaAccessToken()` helper. HG uses
   the standard SMART System-Level JWT assertion flow.
2. Create a channel with **Source = JavaScript Reader**, polling type
   **Cron**, schedule `0 0 * * * ?` (hourly) or `0 0 0 * * ?` (daily).
3. Paste `transformer.js` into the JavaScript step.
4. Add destinations:
   - **HTTP Sender** posting `${payload}` to your downstream FHIR
     server (the bundle is `type: collection` — many FHIR servers
     accept it as-is, otherwise switch to per-resource POSTs in a
     destination loop)
   - Or **Channel Writer** to fan out to per-resource processing channels
5. Deploy. To kick off immediately rather than wait for the cron,
   right-click the channel -> Send Message with an empty body.

## How to test

1. **First run (full backfill).** Don't set `healthgorilla.lastSince`.
   The transformer kicks off `$export` with no `_since`, which Health
   Gorilla treats as "everything ever". Expect a long-running poll
   loop on the first run — monitor `Dashboard -> Statistics`.
2. **Subsequent runs.** Inspect `channelMap.hgPullSince` and
   `hgPullNewSince` — the latter is the new HWM.
3. **Deduplication.** Re-trigger the channel manually. The second run
   will pull the same resources but `hgPullStats.duplicatesSkipped`
   should equal the resource count.
4. **Force a backfill.** From the Mirth API or another channel:
   ```javascript
   configurationMap.remove('healthgorilla.lastSince');
   ```

## What it stores on channelMap

| Key | Notes |
|---|---|
| `hgPullSince`     | The `_since` value sent to HG this run |
| `hgPullNewSince`  | The new high-water mark (manifest's `transactionTime`) |
| `hgPullStats`     | `{ files, resources, duplicatesSkipped, byType }` |
| `payload`         | Collection Bundle to forward to a downstream FHIR server |

## Customize

- **Resource types.** Edit `healthgorilla.export.types` — comma list.
  Bulk export type filtering is done by Health Gorilla server-side.
- **Poll cadence.** Match `POLL_INTERVAL` to HG's expected job latency
  (sandbox usually completes in <2 min; prod can take 15-60 min for
  large tenants).
- **Dedupe TTL.** Change `SEEN_TTL_MS` — default 7 days is enough that
  resources updated within a week of first sight are still treated as
  duplicates. Drop to 1h for aggressive re-sync semantics.
- **Multi-tenant.** Run one channel per HG tenant. Each gets its own
  `healthgorilla.lastSince.<tenantId>` key — extend the transformer to
  take the tenant id as a Configuration Map parameter.
- **Group-level export.** Replace `/Patient/$export` with
  `/Group/<groupId>/$export` to scope to a panel of patients. Update
  the `kickoffExport()` URL.
- **System-level export.** Replace with `/$export` (note: requires
  elevated HG scopes).

## Operational notes

- **Resume-on-failure.** If Mirth dies mid-download, the HWM stays at
  the previous run's value — re-running just rebuilds the same
  manifest (HG keeps it for 24h). The dedupe cache catches re-imports.
- **Manifest expiry.** Health Gorilla pre-signed S3 URLs expire in 24h.
  Don't store the manifest persistently; treat each run as a single
  atomic transaction.
- **Backpressure.** A daily run for a 100-patient tenant typically
  yields 200-1000 resources. For tenants with 100k+ patients enable
  paged downloads — split the destinations by `resource.resourceType`
  so each downstream channel queues independently.
- **Error sample.** If you see `HTTP 429 Too Many Requests` from HG,
  back off — bump `healthgorilla.poll.interval.seconds` and ask HG
  support to raise your tenant's rate limit.
