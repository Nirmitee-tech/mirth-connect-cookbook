# Dead Letter Queue (DLQ) Channel

> A dedicated, replayable home for messages that failed terminal processing — searchable by source channel, failure reason, and retry count.

## What

A Mirth channel named `dlq` that:

1. Accepts messages from any source channel via `router.routeMessage('dlq', ...)` or a Channel Writer destination
2. Records the original payload exactly as received (no transformation, no encryption)
3. Stamps Mirth's custom-metadata columns (`DLQ_REASON`, `DLQ_SOURCE_CHANNEL`, `DLQ_RETRY_COUNT`) so messages are filterable in the Message Browser
4. Logs a structured warn line for log aggregators

Pair with the [Message Replay REST channel](../message-replay-rest/) to re-process DLQ messages once the downstream is healthy.

## Why

Mirth's default behavior on a destination failure is to mark the message
`ERROR` and stop. Operators then have three bad options:

1. Manually replay each errored message from the Administrator (doesn't scale)
2. Let the channel's queue retry forever (blocks the whole channel)
3. Drop and move on (data loss)

A DLQ is the standard fix: park failed messages somewhere safe, alert ops, and bulk-replay them once the root cause is fixed.

## Files

| File                     | Purpose                                                       |
|--------------------------|---------------------------------------------------------------|
| `transformer.js`         | Source transformer — normalizes the failure envelope          |
| `channel-design.md`      | Full Mirth Administrator settings, custom metadata columns, source-channel routing patterns, SQL/REST query examples |

## Where to Install

See `channel-design.md` for the exact channel settings. The short version:

1. Create channel `dlq` with a `Channel Reader` source
2. Paste `transformer.js` as the source transformer
3. Configure custom metadata columns `DLQ_REASON`, `DLQ_SOURCE_CHANNEL`, `DLQ_RETRY_COUNT`
4. Set **Store Messages: ALL** and **Encrypt Message Content: false**

## How Source Channels Route to It

The cleanest pattern: add a `Channel Writer` destination "Send to DLQ" on every channel that handles critical messages. Filter it so it only fires when previous destinations all failed:

```javascript
// Filter for "Send to DLQ" destination
var allFailed = true;
for each (var dest in destinationSet.iterator()) {
    var resp = responseMap.get(dest.getDestinationName());
    if (resp && resp.getStatus().toString() === 'SENT') {
        allFailed = false; break;
    }
}
return allFailed;
```

Map these into the Channel Writer's outgoing sourceMap:

| sourceMap key             | Mirth variable            |
|---------------------------|---------------------------|
| `DLQ_SOURCE_CHANNEL`      | `${channelId}`            |
| `DLQ_SOURCE_CHANNEL_NAME` | `${channelName}`          |
| `DLQ_SOURCE_MESSAGE_ID`   | `${messageId}`            |
| `DLQ_REASON`              | `${responseStatusMessage}`|
| `DLQ_ERROR_DETAIL`        | `${responseError}`        |
| `DLQ_RETRY_COUNT`         | (from response sendAttempts) |

Full code in `channel-design.md`.

## Replay Endpoint

The companion channel [`message-replay-rest`](../message-replay-rest/) exposes:

```
POST /dlq/replay/{messageId}
```

This calls Mirth's `/api/channels/{channelId}/messages/_reprocess` against the
**original source channel** (looked up from the stored `DLQ_SOURCE_CHANNEL`
metadata), so replay puts the message back into the channel that originally
failed it — not into the DLQ.

Single-message replay:

```bash
curl -X POST -H "X-Replay-Token: <token>" \
  http://mirth-host:9101/dlq/replay/abc-123-def
```

Bulk replay by reason:

```bash
# Get all messageIds with DLQ_REASON=MLLP_TIMEOUT
curl -k -u admin:admin \
  "https://localhost:8443/api/channels/{dlq-id}/messages?metaDataColumn=DLQ_REASON&searchValue=MLLP_TIMEOUT" \
  | jq -r '.list.message[].messageId' \
  | xargs -I{} curl -X POST -H "X-Replay-Token: <token>" \
      http://mirth-host:9101/dlq/replay/{}
```

## Test Method

```bash
# 1) Deploy dlq channel + a test source channel that always errors
# 2) Send a test HL7 to the source — confirm it ends up in dlq
# 3) Check the Mirth Administrator Message Browser → filter on dlq:
#      Metadata: DLQ_REASON = MLLP_TIMEOUT

# 4) Confirm REST search works
curl -k -u admin:admin \
  "https://localhost:8443/api/channels/{dlq-id}/messages?metaDataColumn=DLQ_REASON&searchValue=MLLP_TIMEOUT"

# 5) Replay
curl -X POST -H "X-Replay-Token: dev-token" \
  http://localhost:9101/dlq/replay/{messageId}

# 6) Confirm the message reappears in the source channel's Sent count
```

## Customization

- **Per-reason routing**: branch in the transformer by `DLQ_REASON` — page on-call for `AUTH_EXPIRED`, just email for `MLLP_TIMEOUT`.
- **TTL**: set "Days to keep messages" appropriately. 30 days is a good default; 7 days for high-volume non-clinical traffic.
- **Per-source archival**: add a JavaScript Writer destination that writes failed payloads to S3 with key `mirth-dlq/<sourceChannel>/<yyyy-mm-dd>/<messageId>.raw`.
- **Don't mirror PHI to logs**: the transformer's `logger.warn` only logs the error preview (first 200 chars). If your error details might include PHI, redact further or log only the reason tag.

## Production Considerations

- **Don't use the DLQ as a replay queue**. The DLQ is a *store*, not a *queue*. Replay should be an operator action (or a controlled scheduled job), not automatic — otherwise you'll re-trigger the failure that put it there.
- **Watch the size**. A misconfigured upstream can dump millions of messages in here. Alert on `mirth_channel_received_total{channel="dlq"}` rate (see [Prometheus Metrics Exporter](../prometheus-metrics-exporter/)).
- **Rotate metadata columns**. Mirth has a hard limit of 10 custom metadata columns per channel. If you need more dimensions, encode them into `DLQ_REASON` as `category.subcategory` strings.
- **No encryption** is intentional. If your data is sensitive enough to require Mirth's per-channel encryption, use a separate encrypted store (or rely on disk-level encryption at the database layer) — encrypted DLQ payloads can't be replayed after a key rotation.

## Author

Nirmitee.io — MIT License
