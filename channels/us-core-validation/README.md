# Recipe #40 — US Core 6.1.0 Validation Channel

**Description.** A transformer step that takes a FHIR R4 Bundle from
`channelMap.fhirBundle`, POSTs every contained resource to
`tx.fhir.org/r4/$validate` with the matching US Core 6.1.0 profile
parameter, parses the returned `OperationOutcome`, and writes a clean
verdict (`valid`, errors[], warnings[]) back onto `channelMap`. Results
are cached by SHA-256 of the canonical resource JSON for 1 hour in
`globalChannelMap` to avoid hammering tx.fhir.org on repeat traffic.

**Use case.** Pre-flight check before posting to a strict FHIR server
(Epic, Cerner, Health Gorilla, Surescripts). If validation fails you route
to a DLQ or fix-and-retry queue instead of letting the downstream server
return an opaque 422.

**Requirements.**
- Mirth Connect 4.5.2+
- Outbound HTTPS to `tx.fhir.org` (or a self-hosted HL7 Validator)
- Apache HttpClient on the JVM classpath (default Mirth distribution
  ships it under `server-lib/`)
- An upstream transformer that has populated `channelMap.fhirBundle`
  (e.g. recipes #5, #6, #11–#14)

**Tested on.** Mirth Connect 4.5.2 with tx.fhir.org `/r4` endpoint  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
us-core-validation/
├── README.md
└── transformer.js
```

## Where to install

Paste `transformer.js` into a Transformer step on **any** channel that
already produces `channelMap.fhirBundle`. Two common placements:

1. **End of the source transformer** — emits the verdict before any
   destination runs, so you can use a filter on the destinations
   (`channelMap.get('validationValid') == 'true'`).
2. **First destination** with subsequent destinations chained behind a
   filter on `validationValid`.

## Test method

```bash
# 1. Deploy the channel into Mirth and start it.
# 2. Pipe a fixture through your upstream ADT-to-FHIR channel.
python3 scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01

# 3. Inspect the Dashboard -> channel -> Message Browser -> Channel Map.
#    You should see:
#      validationValid     = 'true' (or 'false')
#      validationErrors    = '[]'
#      validationWarnings  = '[ "Patient/123: ..." ]'
#      validationCacheHit  = 'false' on first run, 'true' on a repeat
```

To exercise the cache, send the same patient twice within an hour:
`validationCacheHit` will flip to `true` on the second pass and the
channel's average latency will drop by roughly the round-trip to tx.fhir.

## What it stores on channelMap

| Key | Type | Notes |
|---|---|---|
| `validationValid` | `'true'` / `'false'` | overall PASS/FAIL |
| `validationErrors` | JSON array of strings | one entry per fatal+error issue, prefixed with `<ResourceType>/<id>:` |
| `validationWarnings` | JSON array of strings | warnings only |
| `validationCacheHit` | `'true'` / `'false'` | true only when ALL resources hit cache |

## Customize

- **Change profile version.** Edit the five `*_PROFILE` constants at the
  top — drop the `|6.1.0` suffix for "latest" semantics or upgrade to
  7.0.0 when stable.
- **Map more resource types.** Add entries to `PROFILE_BY_TYPE`. Resources
  not in the map are validated against base R4 (no profile parameter).
- **Self-host the validator.** Change `TX_ENDPOINT` to your internal HL7
  Validator instance — for example `https://validator.internal/r4`.
  Network-air-gapped deployments must do this.
- **Cache TTL.** `CACHE_TTL_MS` defaults to 1 hour. For dev/test where
  profiles change daily, drop to 5 minutes; for high-volume prod with
  stable profiles raise to 24h.
- **Cache invalidation.** Cache key is `us-core-val:<sha256>`. Call
  `globalChannelMap.remove('us-core-val:<hash>')` from another channel to
  force re-validation, or clear all by iterating keys with
  `globalChannelMap.entrySet()`.
- **Strict mode.** Set `validationWarnings.length > 0 → fail` by adding
  one line at the bottom: `valid = valid && allWarnings.length === 0;`.

## Performance notes

- First call to tx.fhir.org: ~400-800 ms per resource.
- Cached call: <2 ms (SHA-256 + map lookup).
- The `httpPost` helper uses Apache HttpClient with a 15s connect+socket
  timeout. Raise on slow networks; the channel will block until the
  timeout elapses on every request.
- The cache stores `{ts, value}` in `globalChannelMap`, which persists
  across messages for the channel's lifetime but resets on redeploy. For
  durable caches use a database-writer destination + a database-reader
  source channel pair instead.
