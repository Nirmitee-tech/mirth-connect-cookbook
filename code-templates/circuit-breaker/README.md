# Circuit Breaker for Mirth Connect

> Fail fast when a downstream FHIR API or MLLP receiver is down — don't pile up retries that will all time out.

## What

A pure-JavaScript circuit breaker for Mirth transformers and destination response scripts. Tracks failures per logical "circuit name" and rejects calls when the downstream service is unhealthy, giving it time to recover.

State machine:

```
            5 failures in 60s
   CLOSED  ───────────────────►  OPEN
     ▲                            │
     │                            │ after 30s
     │ success                    ▼
     └────────  HALF_OPEN  ◄──────┘
        failure → OPEN
```

## Why

A common Mirth failure mode: a destination FHIR API goes down, all 50 channel threads start blocking on 30-second connect timeouts, the queue swells to thousands, and every retry adds more load to the recovering service. The circuit breaker breaks this cycle:

- **Fail fast** instead of waiting for socket timeouts
- **Protect the downstream** during recovery (give it ~30s breathing room)
- **Auto-recover** once one probe succeeds — no manual intervention

## Where to Install

1. Open Mirth Administrator → **Code Templates** tab
2. New → **Code Template** → Type: `Function`, Context: `Channel Context`
3. Paste `code-template.js`
4. Save into a library (e.g. `Resilience`) and link the library to your channels
5. The four functions become callable from any transformer/script in those channels

## Public API

```javascript
circuitAllow(name)          // → boolean. false = circuit OPEN, fail fast
circuitRecordSuccess(name)  // call after a successful downstream invocation
circuitRecordFailure(name)  // call after a failed downstream invocation
circuitGetState(name)       // → { state, failures, openedAt, msUntilHalfOpen }
circuitReset(name)          // force-close (ops use)
```

## Usage — HTTP Sender Destination

In the destination's **Response Transformer**:

```javascript
var circuit = 'fhir-api-primary';

// Decide whether to even attempt the call
if (!circuitAllow(circuit)) {
    channelMap.put('CIRCUIT_OPEN', 'true');
    responseStatus = ERROR;
    responseStatusMessage = 'Circuit breaker OPEN for ' + circuit;
    return;
}

var status = parseInt(connectorMessage.getResponse().getStatus(), 10);
if (status >= 200 && status < 300) {
    circuitRecordSuccess(circuit);
} else if (status >= 500 || status === 0 /* timeout */) {
    circuitRecordFailure(circuit);
    responseStatus = ERROR;
}
```

To actually *skip* the HTTP send when the circuit is open, gate it in the destination **Filter**:

```javascript
if (!circuitAllow('fhir-api-primary')) {
    // Filter returning false drops the destination — pair with DLQ destination
    channelMap.put('CIRCUIT_OPEN', 'true');
    return false;
}
return true;
```

## Usage — MLLP Destination

MLLP Sender doesn't expose a response transformer the same way. Wrap your destination set in a `JavaScript Writer` destination instead, or use the **postprocessor** script:

```javascript
if (responseMap.containsKey('MLLP Destination')) {
    var resp = responseMap.get('MLLP Destination');
    if (resp.getStatus().toString() === 'SENT') {
        circuitRecordSuccess('lab-mllp');
    } else {
        circuitRecordFailure('lab-mllp');
    }
}
```

## Tuning

Edit `CB_CONFIG` at the top of the template, or override at runtime from a deploy script:

```javascript
// In deployScript
globalMap.put('CB_CONFIG', {
    failureThreshold: 10,        // need 10 failures to trip
    rollingWindowMs: 30000,      // measured over 30s window
    openDurationMs: 60000,       // 60s breathing room
    halfOpenMaxCalls: 1
});
```

Rule of thumb:

| Downstream                      | failureThreshold | openDurationMs |
|---------------------------------|------------------|----------------|
| Internal LIS / EHR              | 3                | 15000          |
| Cloud FHIR API (Epic/Cerner)    | 5                | 30000          |
| Public registry (ABDM, NHS)     | 10               | 60000          |

## Monitoring

Pair with the [Prometheus Metrics Exporter recipe](../../channels/prometheus-metrics-exporter/) — emit `mirth_circuit_state{circuit="fhir-api-primary",state="OPEN"} 1` by polling `circuitGetState()` from the metrics channel.

## Test Method

The logic is fully exercised by `node` outside Mirth (timestamps are mocked). The bundled test in `scripts/testing/` (or run inline) covers:

- Initial state CLOSED
- Threshold tripping to OPEN
- 30s timer → HALF_OPEN
- Success closes, failure re-opens
- Rolling window pruning
- Independent circuits don't interfere

```bash
node /Users/developer/Desktop/Projects/mirth-connect-cookbook/scripts/testing/test-circuit-breaker.js
```

## Production Considerations

- **`globalChannelMap` is per-channel**. If you want one shared circuit across multiple channels calling the same FHIR API, swap `globalChannelMap` for `globalMap` in `_cbStore()`.
- **State is in-memory only**. A Mirth restart resets all circuits to CLOSED. For multi-node Mirth HA, back the store with Redis (see `vault-integration` recipe for a Redis client pattern).
- **Don't trip on 4xx**. `400 Bad Request` from a downstream is a *message* problem, not an *infrastructure* problem. Only count 5xx, connect/socket timeouts, and `ConnectException` as circuit failures.
- **Combine with the [Dead Letter Queue recipe](../../channels/dead-letter-queue/)** — when the circuit rejects a message, route it to the DLQ for replay once the downstream recovers.

## Author

Nirmitee.io — MIT License
