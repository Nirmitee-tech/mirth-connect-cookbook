# Recipe #43 — Redox App Adapter

**Description.** Bidirectional Redox subscriber + publisher integration.
**Inbound:** receives a Redox JSON envelope on an HTTP Listener, verifies
the HMAC-SHA256 signature in `X-Verification-Token` against the shared
secret (with timestamp skew protection), maps the Redox DataModel +
EventType into a FHIR Bundle. **Outbound:** wraps an internal record in
a Redox envelope and POSTs to Redox via the channel's HTTP Sender.

**Use case.** Become a Redox app — the kind that hangs off Redox's
"DataOn-the-Go" or App Marketplace and exchanges FHIR with downstream
EHRs through Redox's HL7v2/CCDA translation layer. The same channel
handles both directions.

**Requirements.**
- Mirth Connect 4.5.2+
- A Redox **Subscriber** record (for inbound) with a shared secret
- Optionally a Redox **Publisher / Source** config (for outbound) +
  Source/Destination IDs
- Configuration Map keys:
  - `redox.subscriber.secret` — HMAC shared secret
  - `redox.subscriber.signature.header` — defaults to `X-Verification-Token`
  - `redox.subscriber.timestamp.header` — defaults to `X-Verification-Timestamp`
  - `redox.subscriber.timestamp.skew` — defaults to `300` seconds
  - `redox.source.id`, `redox.source.name`           (outbound only)
  - `redox.destination.id`, `redox.destination.name` (outbound only)

**Tested on.** Mirth Connect 4.5.2 against the Redox sandbox
(`https://api.redoxengine.com/endpoint`)  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
redox-app-adapter/
├── README.md
└── transformer.js
```

## Where to install

1. Create a new channel with **Source = HTTP Listener** on `/redox`.
2. Source -> Properties -> Response code: `200` on success, `401` on
   signature failure (set via response transformer or the default
   handler in `processInbound()` — failures throw, Mirth returns 500).
3. Paste `transformer.js` into the Source connector's JavaScript step.
4. (Outbound) Add a Destination = **HTTP Sender** pointing at
   `https://api.redoxengine.com/endpoint`, body = `${outboundRedox}`,
   header `Authorization: Bearer ${redox.access.token}`. Token-fetch
   should use the cookbook's
   [`http-sender-oauth2-jwt`](../../code-templates/http-sender-oauth2-jwt/)
   template; Redox uses a non-standard `/auth/authenticate` flow — see
   that template's README for the Redox variant.
5. Populate the Configuration Map keys.
6. Deploy.

## How to test

### Inbound (verify signature + parse)

```bash
SECRET='your-shared-secret'
BODY='{"Meta":{"DataModel":"PatientAdmin","EventType":"NewPatient","EventDateTime":"2026-05-28T12:00:00Z","Test":true,"Source":{"ID":"src-1","Name":"Acme HIS"},"Destinations":[{"ID":"dst-1","Name":"Mirth"}]},"Patient":{"Identifiers":[{"ID":"PAT-12345","IDType":"MR"}],"Demographics":{"FirstName":"John","LastName":"Smith","DOB":"1985-03-15","Sex":"Male"}}}'
TS='2026-05-28T12:00:00Z'

# Build the signature over (timestamp + body)
SIG=$(printf "%s%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST http://localhost:8081/redox \
  -H "Content-Type: application/json" \
  -H "X-Verification-Token: $SIG" \
  -H "X-Verification-Timestamp: $TS" \
  --data-raw "$BODY"
```

Inspect `channelMap`:

- `redoxEventKey`  = `PatientAdmin.NewPatient`
- `redoxSourceId`  = `src-1`
- `redoxIsTest`    = `true`
- `fhirBundle`     = `{ "resourceType": "Bundle", ... }`

### Inbound (signature failure)

Replay with the wrong secret or stale `X-Verification-Timestamp` — the
transformer throws `redox signature mismatch` (Mirth returns HTTP 500
and the message is marked ERROR — adjust the response transformer for
HTTP 401 if you prefer).

### Outbound

From any upstream channel, populate `channelMap.redoxOutboundRecord`:

```javascript
channelMap.put('redoxOutboundRecord', JSON.stringify({
  dataModel: 'PatientAdmin',
  eventType: 'NewPatient',
  body: {
    Patient: { Identifiers: [{ ID: 'PAT-12345', IDType: 'MR' }], ... },
    Visit:   { VisitNumber: 'V-1', PatientClass: 'Inpatient' }
  }
}));
```

Then route a message into this channel — `channelMap.outboundRedox`
will contain the full Redox JSON envelope ready for the HTTP Sender
destination to POST.

## Customize

- **`EVENT_TYPE_TO_FHIR`.** The default map covers PatientAdmin,
  Order.New, Results.New, Notes.New, Scheduling.*, Vitals.New. Add any
  Redox model you subscribe to. Each entry has `{ resource, verb }`
  where verb selects `POST` (new) vs `PUT` (update).
- **`mapPatient()`.** Tweak which Redox `IDType` becomes the Patient
  resource ID. Default order: `MR` -> `MRN` -> first identifier.
- **Signature scheme.** Redox subscribers fall into two camps:
  - Modern: HMAC over `timestamp + body`. We do this when
    `X-Verification-Timestamp` is present.
  - Legacy: HMAC over `body` alone. We fall through to this when no
    timestamp header is provided.
  Both share the same constant-time compare.
- **Header names.** Override `redox.subscriber.signature.header` and
  `redox.subscriber.timestamp.header` if your subscriber profile uses
  custom names.
- **Replay window.** `redox.subscriber.timestamp.skew` (seconds) — the
  default 300 (5 min) matches Redox's recommendation.
- **Response transformer.** To make Mirth return 401 on signature
  failures, wrap `processInbound()` in a `try { } catch (e) {
  responseMap.put('redoxResponse', ResponseFactory.getFailureResponse(...));
  }` block.

## Sanity check the HMAC

The transformer uses `Packages.javax.crypto.Mac` with `HmacSHA256` over
UTF-8 bytes — produces the same hex digest as Python's `hmac`:

```python
import hmac, hashlib
secret = 'shh'
body   = '{"hello":"world"}'
ts     = '2026-05-28T12:00:00Z'
sig    = hmac.new(secret.encode(), (ts+body).encode(), hashlib.sha256).hexdigest()
# -> 'ab6db08e411f2919028ff07b7995ce3003c043b470ca8dc06c66f289420fa510'
```

## Operational notes

- **Idempotence.** Redox can replay events on a subscriber failure. The
  outbound FHIR Bundle uses verb `PUT Patient/{id}` for updates and
  `POST Observation` for new entries — destinations should be ready
  for the same event id more than once.
- **Test traffic.** `envelope.Meta.Test === true` is preserved in
  `channelMap.redoxIsTest`. Use it to filter test traffic away from
  production downstream destinations.
- **Volume.** Redox subscribers receive one HTTP POST per event. For
  high-volume tenants enable `Process Batch` on the HTTP Listener with
  a JSON splitter — but verify per-batch signing semantics with Redox
  support first; current subscribers sign per-message.
