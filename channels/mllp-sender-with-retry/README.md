# Recipe #4 — MLLP Sender with ACK Validation + Exponential Retry

A production-grade pattern for the TCP/MLLP destination connector. Every Mirth integration that pushes HL7v2 downstream eventually needs this: parse the ACK, decide whether to retry, back off exponentially, and dead-letter what cannot be delivered.

## What it does

- Sends HL7v2 messages over MLLP via a TCP Sender destination.
- Response transformer parses the inbound ACK:
  - `MSA-1 = AA` → success, done.
  - `MSA-1 = AE` → application error → retry.
  - `MSA-1 = AR` → application reject → retry.
  - No response / timeout → retry.
- Retries follow exponential backoff: **1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 64s**, capped at 5 minutes.
- Maximum **7 attempts** (configurable via `configurationMap`).
- On terminal failure, the original message is wrapped with failure context and routed to the `dlq-channel` via Mirth's VMRouter for manual replay.

## Why

Mirth's built-in destination retry is fixed-interval and doesn't differentiate AA/AE/AR. It also lacks a clean dead-letter handoff. This recipe gives you:

- Real exponential backoff that respects downstream pressure.
- Per-ACK-code handling (`AE` retries, `AA` stops).
- A standardized DLQ envelope that the `dead-letter-queue` channel can consume.

## Where to install

| Where | What |
|---|---|
| **Settings -> Code Templates** | Paste [code-template.js](code-template.js). Set context to **Destination** (visible to response transformers and destination scripts). |
| **Channel -> Destinations -> TCP Sender** | Configure MLLP framing (start `0x0B`, end `0x1C 0x0D`), check **Process HL7 v2.x ACK**. |
| **Destination -> Response Transformer** | Use the exported `parseAck()` to extract the code, then drive Mirth's retry by setting `responseStatus`. |
| **Destination -> Postprocessor** | On terminal failure, call `routeToDeadLetter(rawMsg, ctx)`. |

Minimal response-transformer body:

```javascript
var ack = parseAck(response.getMessage());
channelMap.put('ackCode', ack.code);
channelMap.put('ackMsa3', ack.msa3);

if (ack.code === 'AA') {
    responseStatus = SUCCESS;
} else {
    var attempt = parseInt(channelMap.get('attemptNum') || '1', 10);
    var decision = shouldRetry(attempt, { ackCode: ack.code });
    if (decision.retry) {
        java.lang.Thread.sleep(decision.delayMs);
        responseStatus = QUEUED;
        channelMap.put('attemptNum', (attempt + 1).toString());
    } else {
        responseStatus = ERROR;
        routeToDeadLetter(connectorMessage.getEncodedData(), {
            attempts: attempt,
            lastAckCode: ack.code,
            lastError: ack.msa3
        });
    }
}
```

## Public API (code-template.js)

| Function | Signature | Returns |
|---|---|---|
| `parseAck(response)` | `string` | `{ code: 'AA'\|'AE'\|'AR'\|'UNKNOWN', msa3: string, errors: string[] }` |
| `shouldRetry(attemptNum, lastError)` | `(number, { ackCode?, exception? })` | `{ retry: bool, delayMs: number, reason: string }` |
| `routeToDeadLetter(rawMessage, ctx)` | `(string, object)` | `void` -- sends a JSON envelope to `dlq-channel`. |

## Configuration

Edit the constants at the top of `code-template.js`, or override at runtime via the `configurationMap`:

| Constant | Default | Meaning |
|---|---|---|
| `MLLP_RETRY_MAX_ATTEMPTS` | `7` | Hard cap on attempts (incl. the first). |
| `MLLP_RETRY_BASE_MS`      | `1000` | Base delay (multiplied by `2^(n-1)`). |
| `MLLP_RETRY_CAP_MS`       | `300000` | Maximum delay between attempts (5 minutes). |
| `MLLP_DLQ_CHANNEL_NAME`   | `dlq-channel` | Name of the channel that consumes DLQ entries. |

## Test method

The pure-JS logic (`parseAck`, `shouldRetry`) was verified outside Mirth by loading the template as a CommonJS module (the file exports both functions when `module.exports` is available).

Confirmed sequence on AE responses: `1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 64s`, attempt 8 returns `{ retry: false, reason: 'max-attempts-exceeded' }`. AA short-circuits to `{ retry: false, reason: 'success-no-retry' }`.

## Customization

- **Don't retry on AR**: in `shouldRetry`, short-circuit `if (ack === 'AR' && attemptNum > 1) return { retry: false }`.
- **Different DLQ channel**: change `MLLP_DLQ_CHANNEL_NAME`.
- **Jitter**: multiply `delay` by `0.5 + Math.random()` to spread retries across a fleet.

## Tested on

Mirth Connect 4.5.2 -- destination type TCP Sender with MLLP framing.

Author: Nirmitee.io | License: MIT
