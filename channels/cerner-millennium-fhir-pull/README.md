# Recipe #42 — Cerner Millennium FHIR R4 Scheduled Pull

**Description.** A JavaScript Reader transformer that polls a Cerner Code
Console FHIR R4 endpoint on a cron schedule, fetches resources modified
since the last successful run (delta sync via `_lastUpdated`), follows
`Bundle.link[rel='next']` pagination to completion, and emits a single
collection Bundle on `channelMap.payload` for the downstream destination
to ship into your warehouse / FHIR proxy / Kafka.

**Use case.** Pull new and updated patient encounters, observations, and
conditions from Cerner every 15 minutes for downstream analytics. Same
shape works for SMART-on-FHIR System-Level apps that don't want to
stand up a full FHIR server of their own.

**Requirements.**
- Mirth Connect 4.5.2+
- Cerner Code Console System Account + signed JWT bundle (Cerner's
  flavour of SMART System-Level auth)
- The cookbook's OAuth2/JWT code template loaded into this channel:
  [`/code-templates/http-sender-oauth2-jwt/`](../../code-templates/http-sender-oauth2-jwt/)
- Apache HttpClient on the JVM classpath (default Mirth)
- Configuration Map keys:
  - `cerner.tenant.id`   the tenant UUID Cerner gave you
  - `cerner.base.url`    e.g. `https://fhir-ehr.cerner.com/r4`
  - `cerner.resources`   comma list, e.g. `Patient,Encounter,Observation,Condition`
  - `cerner.page.limit`  default `50`
  - `cerner.max.pages`   default `200` (safety brake — typical pulls are <10)

**Tested on.** Mirth Connect 4.5.2 against the Cerner sandbox
(`https://fhir-myrecord.cerner.com/r4`)  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
cerner-millennium-fhir-pull/
├── README.md
└── transformer.js
```

## Where to install

1. Load the OAuth2 code template — see
   [`code-templates/http-sender-oauth2-jwt/README.md`](../../code-templates/http-sender-oauth2-jwt/README.md).
   That template exposes the helper `getCernerAccessToken()` which signs
   a JWT with your system principal's private key, posts it to the
   Cerner token endpoint, and caches the result.
2. Create a new channel with **Source = JavaScript Reader**.
3. In the Source connector, set:
   - **Polling Type** = Cron
   - **Cron expression** = `0 */15 * * * ?` (every 15 minutes)
4. Paste `transformer.js` into the Source connector's JavaScript step.
5. Add a Destination — the most common choices:
   - **HTTP Sender** pointing at your downstream FHIR server, body = `${payload}`
   - **Channel Writer** to fan out to per-resource channels
   - **Kafka Producer** using the cookbook's Kafka code template
6. Set `configurationMap.cerner.lastSync.<tenantId>` to your desired
   backfill start (e.g. `2026-01-01T00:00:00Z`). If unset, the
   transformer defaults to `now() - 24h` on first run.
7. Deploy.

## How to test

```bash
# Trigger a manual fetch (instead of waiting for the cron) via Mirth API:
curl -k -u admin:admin \
  -X POST \
  https://localhost:8443/api/channels/<channelId>/messages/_processed \
  -H 'Content-Type: application/xml' \
  -d '<com.mirth.connect.donkey.model.message.RawMessage><rawData></rawData></com.mirth.connect.donkey.model.message.RawMessage>'
```

Or wait one cron cycle and inspect the Dashboard:

- `cernerPullSince`    — the HWM the pull started from
- `cernerPullHwm`      — the new HWM (advanced to the newest
  `meta.lastUpdated` seen)
- `cernerPullSummary`  — `{ "resources": {"Patient": 4, ...}, "pages": 2, "total": 14 }`
- `payload`            — the FHIR `Bundle` of type `collection`

## Customize

- **Resource types.** Edit `cerner.resources` in the Configuration Map.
  Cerner exposes the standard US Core set plus some Cerner-specific
  ones (`Procedure`, `MedicationRequest`, `AllergyIntolerance`,
  `DocumentReference`).
- **Pagination chunk size.** Cerner caps `_count` at 50 for most
  resource types in production tenants. Push higher only after talking
  to Cerner support; otherwise leave at 50.
- **Window.** The transformer uses `_lastUpdated=ge<since>`. To use
  `_count`-only windowed pulls instead (no delta), drop the
  `&_lastUpdated=...` substring and treat `cerner.lastSync` as a
  cursor index.
- **Auth scope.** The OAuth2 template requests
  `system/Patient.read system/Encounter.read system/Observation.read
  system/Condition.read` by default. Add scopes if you add resource
  types — and re-register your System Account on Cerner's side.
- **Backfill.** Pre-seed `cerner.lastSync.<tenantId>` to a much older
  timestamp for a bulk historical load. The transformer will paginate
  through everything; you'll likely hit `cerner.max.pages` — set it
  high (1000+) for the first run, then drop back to 200.
- **Multi-tenant.** Run one channel per tenant. Each channel has its
  own `cerner.tenant.id` and its own HWM key.

## Operational notes

- **Drift.** Cerner returns resources sorted `-_lastUpdated`, but
  `meta.lastUpdated` precision is seconds, so resources updated in the
  same second can theoretically be missed across a cron boundary. The
  transformer mitigates this by advancing the HWM only to the **newest**
  `lastUpdated` actually observed in the batch — re-running picks up
  any second-tied resources the next cycle.
- **Token caching.** The `getCernerAccessToken()` helper caches the
  Bearer token in `globalMap` until 60 seconds before expiry. Avoid
  putting a fresh token-fetch on every cron tick.
- **Error handling.** Any HTTP 4xx/5xx throws — the channel will mark
  the message as ERROR. The HWM does NOT advance on error, so the next
  successful run will retry the window.
- **Idempotence.** Re-running the same window pulls the same resources;
  destinations should `PUT Resource/{id}` (upsert), not `POST`.
