# Message Replay REST Endpoint for Mirth Connect

> Bulk-replay messages from any channel via a simple HTTP API — built for use with the [Dead Letter Queue recipe](../dead-letter-queue/).

## What

A Mirth channel that listens on `POST /replay/...` and triggers Mirth's
internal `_reprocess` API for the target channel and message(s). Wraps the
ergonomic gaps in the raw Mirth REST API:

- Token-header auth (vs Mirth's session-cookie auth which is painful from scripts)
- Path-based routing instead of JSON envelopes
- Range replay (`?fromId=X&toId=Y`)
- Replay-mode flags (transformer-only vs full re-send)

## Routes

```
POST /replay/{channelId}/{messageId}
  → replay one message in its original channel

POST /replay/{channelId}?fromId=X&toId=Y
  → range replay (inclusive bounds on Mirth's auto-increment messageId)

POST /dlq/replay/{messageId}
  → DLQ-aware route — looks up the original channel from DLQ metadata
    (see Customization section)
```

### Query Parameters

| Param              | Default | Meaning                                                    |
|--------------------|---------|------------------------------------------------------------|
| `replaceFiltered`  | `true`  | Re-run filter logic. If false, filtered destinations stay filtered. |
| `transformerOnly`  | `false` | Re-run transformer only, do NOT send to destinations. Useful for verifying a transformer fix. |
| `fromId`           | —       | Range mode: lowest messageId to include                     |
| `toId`             | —       | Range mode: highest messageId to include                    |

### Headers

| Header             | Required | Notes                                                      |
|--------------------|----------|------------------------------------------------------------|
| `X-Replay-Token`   | Yes      | Validated against `globalMap.get('replay.token')`          |
| `Content-Type`     | No       | Body is ignored                                            |

### Response

```json
{ "status": "ok", "replayed": 1, "channelId": "abc-..." }
```

Errors:

```json
{ "status": "error", "error": "missing or invalid X-Replay-Token" }
```

| HTTP | When                                |
|------|-------------------------------------|
| 200  | Replay request accepted by Mirth    |
| 400  | Malformed path or missing fromId/toId |
| 401  | Missing or wrong token              |
| 405  | Non-POST method                     |
| 502  | Mirth API returned non-2xx          |

## Where to Install

### Channel Setup

| Section            | Setting                                  |
|--------------------|------------------------------------------|
| Source Connector   | `HTTP Listener`                          |
| Listener Port      | `9101`                                   |
| Base Context Path  | `/`  (paths handled inside transformer)  |
| Source Transformer | Paste `transformer.js`                   |
| Response           | Source response — set content type `application/json`, body from `channelMap.REPLAY_BODY`, status from `channelMap.REPLAY_STATUS` |

In the source HTTP Listener Response settings:

```javascript
// Response script
responseHeaders.put('Content-Type', java.util.Arrays.asList('application/json'));
var status = channelMap.get('REPLAY_STATUS') || 200;
return ResponseFactory.getCompletedResponse(channelMap.get('REPLAY_BODY'), null, String(status));
```

### Required configurationMap

| Key                       | Value                                |
|---------------------------|--------------------------------------|
| `replay.mirth.url`        | `https://localhost:8443/api`         |
| `replay.mirth.user`       | `admin` (read-only-with-reprocess user preferred) |
| `replay.mirth.password`   | `<password>`                         |

### Required globalMap (set in deployScript)

```javascript
// Channel deployScript
globalMap.put('replay.token', java.util.UUID.randomUUID().toString());
logger.info('Replay token rotated; check globalMap');
```

Or set a fixed token from an env var / secret store at deploy time.

### Requirements

- The [apache-http-client recipe](../../code-templates/apache-http-client/) installed (uses Apache HttpClient to call Mirth's API — `java.net.URL` doesn't work on Java 17)

## Examples

```bash
TOKEN="..."

# Replay one message
curl -X POST \
  -H "X-Replay-Token: $TOKEN" \
  http://localhost:9101/replay/abc-channel-uuid/12345

# Range replay
curl -X POST \
  -H "X-Replay-Token: $TOKEN" \
  "http://localhost:9101/replay/abc-channel-uuid?fromId=10000&toId=10500"

# Transformer-only (test a fix without re-sending downstream)
curl -X POST \
  -H "X-Replay-Token: $TOKEN" \
  "http://localhost:9101/replay/abc-channel-uuid/12345?transformerOnly=true"

# Bulk replay all DLQ messages with a specific reason
curl -k -u admin:admin \
  "https://localhost:8443/api/channels/{dlq-id}/messages?metaDataColumn=DLQ_REASON&searchValue=MLLP_TIMEOUT" \
  | jq -r '.list.message[].messageId' \
  | while read mid; do
      # Get original channelId from DLQ metadata
      cid=$(curl -k -s -u admin:admin \
        "https://localhost:8443/api/channels/{dlq-id}/messages/$mid" \
        | jq -r '.message.connectorMessages[].metaDataMap.DLQ_SOURCE_CHANNEL' \
        | head -1 | cut -d'|' -f1)
      curl -X POST -H "X-Replay-Token: $TOKEN" \
        "http://localhost:9101/replay/$cid/$mid"
    done
```

## Test Method

```bash
node /Users/developer/Desktop/Projects/mirth-connect-cookbook/scripts/testing/test-replay-pathparse.js
```

The bundled tests cover path parsing for:

- `/replay/{cid}/{mid}` two-segment
- `/replay/{cid}` one-segment
- query string handling
- `/dlq/replay/{mid}` prefix
- Leading slash optional

End-to-end test:

```bash
# Send a known-good HL7 to a test channel that has 1 erroring destination
curl -X POST -d "$(cat sample-data/adt-a01.hl7)" http://mirth:6661/

# Find the errored messageId in Administrator
MID=12345

# Replay it
curl -v -X POST -H "X-Replay-Token: $TOKEN" \
  http://localhost:9101/replay/abc-channel-uuid/$MID

# Confirm the messageId now shows a fresh attempt in the Message Browser
```

## Customization

- **DLQ-aware replay**: extend `parsePath` so `/dlq/replay/{messageId}` first
  GETs the DLQ message, extracts `DLQ_SOURCE_CHANNEL` from its custom metadata,
  and replays into *that* channel instead of into `dlq`. Saves the operator from
  having to remember the source channelId.

- **Slack /replay command**: front this with a Slack slash command — `/replay
  12345 MLLP_TIMEOUT` → your bot fetches the IDs and POSTs them.

- **Replay rate limiting**: combine with the [rate-limiter code template](../../code-templates/rate-limiter/) to cap replay throughput so you don't re-trigger the original outage. Suggested: 10 replays/sec to start.

- **Audit log**: add a destination that writes every replay invocation to an
  audit channel/Kafka with: who, what messageId, what channel, when, mode.

## Production Considerations

- **`X-Replay-Token` is just a shared secret, not a real auth system**. For
  proper RBAC, front this endpoint with an API gateway (Kong, APISIX, nginx
  with OIDC) that enforces real identity, and have the gateway forward
  `X-Replay-Token` as a fixed value Mirth trusts.

- **Replay does not respect circuit breakers**. If you replay 10,000 messages
  in 30 seconds against an already-flaky downstream, you'll likely re-create
  the outage. Always replay slowly, ideally in chunks of 100 with a 30s
  pause, and watch the [Prometheus metrics](../prometheus-metrics-exporter/).

- **Idempotency matters**. Verify the destination is idempotent before bulk
  replaying — POSTing the same ADT to a registry twice could create duplicate
  patient records. For non-idempotent destinations, use `transformerOnly=true`
  first to confirm the message parses, then replay carefully.

- **Mirth's reprocess API is asynchronous**. A 200 from this endpoint means
  Mirth *accepted* the reprocess request, not that the message has been
  successfully resent. Verify via Message Browser or Prometheus counters.

## Author

Nirmitee.io — MIT License
