# Rate Limiter (Token Bucket) for Mirth Connect

> Stay under FHIR API quotas and apply back-pressure to slow downstreams.

## What

A token-bucket rate limiter callable from any Mirth transformer, filter, or script. Each named bucket has a `capacity` (burst budget) and a `refillRatePerSec` (sustained rate). One token = one allowed call.

## Why

Mirth channels happily pump messages at thousands per second. Downstream APIs often can't keep up:

- Epic / Cerner FHIR APIs publish quotas (e.g. 60 req/min per app)
- Internal REST services often have a 1000 req/sec soft cap
- Outbound SMS / paging gateways throttle at 10 req/sec
- A flapping downstream needs back-pressure, not a thundering herd

Letting Mirth hammer past these limits causes 429s, IP bans, and angry phone calls. The token bucket is the standard back-pressure primitive.

## Where to Install

1. Mirth Administrator → **Code Templates** tab
2. New → **Code Template** → Type: `Function`, Context: `Channel Context`
3. Paste `code-template.js`
4. Save into a library and link to your channels

## Public API

```javascript
rateLimitAllow(bucketName, capacity, refillRatePerSec)
    // → boolean. true = token consumed. false = throttled.

rateLimitInspect(bucketName, capacity, refillRatePerSec)
    // → { tokens, capacity, refillRatePerSec }. No token consumed.

rateLimitReset(bucketName, capacity)
    // Refill the bucket to capacity. Use after a config or window change.

rateLimitAcquire(bucketName, capacity, refillRatePerSec, maxWaitMs)
    // → boolean. Blocks (sleeps) until a token is free or maxWaitMs elapses.
```

## Configuration Recipes

| Requirement                             | capacity | refillRatePerSec |
|-----------------------------------------|----------|------------------|
| 60 req/min, no burst                    | 1        | 0.0167 (1/60)    |
| 60 req/min, allow 60 burst              | 60       | 1                |
| 1000 req/sec sustained, no burst        | 1000     | 1000             |
| 1000 req/sec sustained, 5000 burst      | 5000     | 1000             |
| 10 req/sec to SMS gateway               | 10       | 10               |

## Usage — Drop Throttled Messages

In destination **Filter**:

```javascript
if (!rateLimitAllow('fhir-api-out', 60, 1)) {
    channelMap.put('THROTTLED', 'true');
    logger.warn('Throttled: fhir-api-out quota exhausted');
    return false;  // skip this destination
}
return true;
```

## Usage — Back-Pressure (Wait for Token)

In destination response transformer or a JavaScript Writer:

```javascript
// Block up to 5 seconds for a token. Beats the destination timing out.
if (!rateLimitAcquire('fhir-api-out', 60, 1, 5000)) {
    // 5s wait elapsed — give up
    throw new Error('Rate limit acquire timeout');
}

// ...proceed with the call
```

## Usage — Reroute Throttled Messages

Pair with a second destination ("Queue for later"):

```javascript
// Destination 1 (primary) filter:
if (!rateLimitAllow('fhir-api-out', 60, 1)) {
    channelMap.put('THROTTLED', 'true');
    return false;
}

// Destination 2 ("Queue Throttled") filter:
return channelMap.get('THROTTLED') === 'true';
// Destination 2 writes to JMS / Redis / DB for later replay.
```

## Usage — HTTP Sender Response Transformer (Adaptive)

Honor `429 Too Many Requests` from the downstream and pause the bucket:

```javascript
var status = parseInt(connectorMessage.getResponse().getStatus(), 10);
if (status === 429) {
    // Downstream told us to back off — empty our bucket to mirror it
    rateLimitReset('fhir-api-out', 0);
    responseStatus = QUEUED;
    responseStatusMessage = 'Throttled by downstream (429)';
}
```

## Test Method

```bash
node /Users/developer/Desktop/Projects/mirth-connect-cookbook/scripts/testing/test-rate-limiter.js
```

The bundled tests cover:

- First N calls allowed up to capacity
- N+1 throttled
- Refill timer adds tokens at the right rate
- Capacity ceiling enforced (no over-refill)
- Independent buckets don't share state
- `rateLimitAcquire` waits and eventually succeeds

## Production Considerations

- **Per-channel scope**: `globalChannelMap` is per-channel. If multiple channels call the same external API, swap `globalChannelMap` → `globalMap` in `_rlStore()` so they share one quota.
- **No persistence**: a Mirth restart resets all buckets to full. For strict quota enforcement across restarts, back the store with Redis (see `vault-integration` pattern).
- **Multi-node HA**: `globalChannelMap` and `globalMap` are NOT replicated across Mirth nodes in an HA cluster. For cluster-wide quotas, use Redis with `INCR`+`EXPIRE` or a token-bucket Lua script.
- **JSON parse cost**: each `rateLimitAllow` does one parse + one stringify. At 1000 req/sec/bucket this is ~10µs. If you push past 10k req/sec, replace the JSON serialization with a tiny Java POJO held directly in the `ConcurrentHashMap`.
- **`rateLimitAcquire` sleeps the channel thread**. That is fine for outbound destinations but never call it from a Source Connector filter — you will block the listener.

## Combining With Other Recipes

- [Circuit Breaker](../circuit-breaker/) — rate-limit first, circuit-break second. Rate limiter prevents the *cause* of cascading failures; circuit breaker contains them once they start.
- [Dead Letter Queue](../../channels/dead-letter-queue/) — route `THROTTLED` messages to DLQ for delayed replay.
- [Prometheus Metrics Exporter](../../channels/prometheus-metrics-exporter/) — expose `rateLimitInspect()` output as a gauge.

## Author

Nirmitee.io — MIT License
