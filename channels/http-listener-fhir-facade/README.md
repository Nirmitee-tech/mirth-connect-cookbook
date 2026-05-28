# HTTP Listener — FHIR R4 Facade over Legacy DB

Turns a single Mirth HTTP Listener channel into a small, read-mostly FHIR R4 server backed by a legacy HL7v2 database. Lets you give downstream apps (apps, portals, analytics, AI) a modern FHIR API while the legacy systems stay put.

## What it exposes

| Method | Path | Description |
|---|---|---|
| `GET` | `/fhir/metadata` | CapabilityStatement listing supported resources |
| `GET` | `/fhir/Patient/{id}` | Look up patient by MRN, return FHIR R4 `Patient` |
| `POST` | `/fhir/Patient` | Create patient (INSERT into legacy `patients` table) |
| `GET` | `/fhir/Observation?subject={id}&_count=20&_page=1` | Search observations, paginated `searchset` Bundle |

Errors return a proper FHIR R4 [OperationOutcome](https://hl7.org/fhir/R4/operationoutcome.html) — not raw HTML or plain text. Pagination uses `Bundle.link[relation=next]` so any standards-compliant FHIR client (e.g. `fhirclient`, `hapi-fhir`, `smart-on-fhir`) can iterate transparently.

## Why this pattern

The "FHIR facade" pattern is the cheapest way to get modern interoperability out of a legacy system:

- No data migration — the source of truth stays in the legacy RDBMS.
- No vendor lock-in — anything talking FHIR works (SMART apps, ChatGPT plugins, payers).
- Lower risk than ripping out the EHR layer.

Mirth is a good host because:

- The HTTP Listener handles routing, TLS, request/response shaping.
- A single transformer can fan in/out to multiple destinations (DB, file, MLLP).
- Connection pooling, retries, monitoring are built in.

## Where to install

1. **Channel → Source → Connector type:** HTTP Listener
2. Configure:
   - **Listener address:** `0.0.0.0`
   - **Listener port:** `8089`
   - **Base context path:** `/fhir`
   - **Receive timeout:** `30000`
   - **HTTP method:** check `GET`, `POST` (uncheck others)
   - **Response content type:** `application/fhir+json`
   - **Response status code:** `${responseStatusCode}` (use the channel-map variable)
   - **Response body:** `${responseBody}`
3. **Channel → Source → Transformer:** paste [transformer.js](transformer.js).
4. **Settings → Configuration Map:** add:

   | Key | Example | Purpose |
   |---|---|---|
   | `legacy.db.url` | `jdbc:postgresql://localhost:5432/legacy_hl7` | JDBC URL |
   | `legacy.db.user` | `mirth` | DB user |
   | `legacy.db.pass` | `***` | DB password |
   | `legacy.db.driver` | `org.postgresql.Driver` | Driver class |
   | `fhir.base.url` | `http://localhost:8089/fhir` | Used in `Bundle.link` and `Location` headers |
   | `fhir.page.size` | `20` | Default `_count` for search |

5. **Destinations:** can be empty (`None`) — the transformer writes the response directly via `channelMap`. Or add a Channel Writer to log to another channel for audit.
6. Deploy.

## Sample DDL (PostgreSQL)

```sql
CREATE TABLE patients (
  mrn         text PRIMARY KEY,
  first_name  text,
  last_name   text,
  birth_date  date,
  sex         char(1),
  phone       text,
  email       text
);
CREATE TABLE observations (
  obs_id          bigserial PRIMARY KEY,
  mrn             text NOT NULL REFERENCES patients(mrn),
  loinc_code      text NOT NULL,
  loinc_display   text,
  value_numeric   numeric,
  units           text,
  result_status   text DEFAULT 'final',
  observation_ts  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX observations_mrn_ts_idx ON observations (mrn, observation_ts DESC);
```

A copy is shipped under `sample-data/sql/legacy-hl7-schema.sql`.

## Test

1. **Read CapabilityStatement**:

   ```bash
   curl -s http://localhost:8089/fhir/metadata | jq .
   ```

   Expect `resourceType: "CapabilityStatement"` with two resources listed.

2. **Create a patient**:

   ```bash
   curl -s -X POST http://localhost:8089/fhir/Patient \
     -H 'Content-Type: application/fhir+json' \
     -d '{
       "resourceType": "Patient",
       "identifier": [{"system":"http://hospital.example.org/mrn","value":"MRN-12345"}],
       "name": [{"family":"Smith","given":["John"]}],
       "gender": "male",
       "birthDate": "1980-01-15"
     }'
   ```

   Expect `HTTP 201`, `Location: http://localhost:8089/fhir/Patient/MRN-12345`.

3. **Read the patient back**:

   ```bash
   curl -s http://localhost:8089/fhir/Patient/MRN-12345 | jq .
   ```

4. **Search observations** (after inserting some test rows):

   ```sql
   INSERT INTO observations (mrn, loinc_code, loinc_display, value_numeric, units)
   VALUES ('MRN-12345', '4548-4', 'HbA1c', 7.2, '%'),
          ('MRN-12345', '2345-7', 'Glucose', 142, 'mg/dL');
   ```

   ```bash
   curl -s 'http://localhost:8089/fhir/Observation?subject=Patient/MRN-12345&_count=10' | jq .
   ```

   Expect a `Bundle` with `type: "searchset"`, `total: 2`, and 2 entries.

5. **Error path** — missing patient:

   ```bash
   curl -s -o - -w 'HTTP %{http_code}\n' http://localhost:8089/fhir/Patient/UNKNOWN | jq .
   ```

   Expect `HTTP 404` and:

   ```json
   {
     "resourceType": "OperationOutcome",
     "issue": [{"severity":"error","code":"not-found","diagnostics":"Patient/UNKNOWN not found"}]
   }
   ```

6. **Pagination** — insert 50 observations, request `_count=20`, follow `Bundle.link[next]` URLs and verify totals match.

## Customize

- **Add more search params** (`name=`, `birthdate=`) — extend `handlePatientSearch()` (mirror the Observation handler, add `LIKE` / `=` clauses).
- **US Core profile**: set `Patient.meta.profile = ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient']` and add the required US Core fields (race, ethnicity extensions).
- **Auth**: front Mirth with an OAuth2 proxy (oauth2-proxy, Kong, APIM). Or add a JS preprocessor that validates the `Authorization` header against a JWKS.
- **Caching**: cache the CapabilityStatement and common patient lookups in `globalChannelMap` with a TTL — saves a DB roundtrip per request.

## Production considerations

- **Connection pooling**: `DriverManager.getConnection()` opens a fresh socket per request — fine at low RPS, dies at scale. Use HikariCP via a Mirth Database Reader code template or a Java-side pool. See `code-templates/jdbc-datasource/`.
- **TLS termination**: never expose Mirth's HTTP Listener directly to the internet. Terminate TLS at a reverse proxy and pass `X-Forwarded-*` through.
- **Rate limiting**: add a fixed-window or token-bucket limiter at the proxy. The FHIR spec encourages servers to return `429 Too Many Requests` with an `OperationOutcome`.
- **Conformance**: run [Inferno](https://inferno.healthit.gov/) ONC Standardized API tests against this endpoint to validate FHIR compliance.
- **Search by `_lastUpdated`**: legacy schemas rarely have an updated-at column. Add one or maintain a sidecar log and back-stitch it.

## Files

- [transformer.js](transformer.js) — request router, all four endpoints
- [capability-statement.json](capability-statement.json) — full CapabilityStatement (the transformer ships a minimal inline one; this file is the editable copy)
