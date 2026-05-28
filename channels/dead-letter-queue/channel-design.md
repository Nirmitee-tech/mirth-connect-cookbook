# DLQ Channel Design

This document describes the Mirth Administrator settings the `dlq` channel needs. Use it as a checklist if you're building the channel manually instead of importing `channel.xml`.

## Channel Properties

| Setting                          | Value                                       |
|----------------------------------|---------------------------------------------|
| Name                             | `dlq`                                       |
| Initial State                    | `Started`                                   |
| Store Messages                   | `ALL — store both message content + metadata` |
| Encrypt Message Content          | `false` (so replay works after key rotation) |
| Remove content + attachments on completion | `false`                          |
| Days to keep messages            | `30` (or per your retention policy)         |
| Process messages                 | `In order — per-channel single thread` (preserves replay order) |
| Message Storage Mode             | `Production`                                |

## Source Connector

| Setting              | Value                                  |
|----------------------|----------------------------------------|
| Connector Type       | `Channel Reader`                       |
| Inbound Data Type    | `Raw`                                  |
| Outbound Data Type   | `Raw`                                  |
| Source Transformer   | Contents of `transformer.js`           |

The Channel Reader accepts messages routed from other channels via
`router.routeMessage('dlq', payload)` or a `Channel Writer` destination
targeting this channel.

## Custom Metadata Columns

Summary → Set Data Types → Message Metadata → add three columns:

| Column Name           | Type    | Indexed |
|-----------------------|---------|---------|
| `DLQ_REASON`          | STRING  | Yes     |
| `DLQ_SOURCE_CHANNEL`  | STRING  | Yes     |
| `DLQ_RETRY_COUNT`     | NUMBER  | No      |

These map to `d_mcm.<column>` in Mirth's database and appear as filterable
columns in the Mirth Administrator Message Browser. Indexing the first two
makes the REST `/messages` search fast.

## Destinations

For a vanilla DLQ, **no destinations are needed** — the message is persisted
by Mirth automatically when stored in the channel. You can optionally add:

| Destination       | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `Notify Slack`    | HTTP Sender → POST to Slack webhook with `DLQ_REASON`    |
| `Page On-Call`    | HTTP Sender → PagerDuty Events API (only for `SEV1` tags)|
| `Sink to S3`      | HTTP Sender → S3 PUT for long-term archive               |
| `Mirror to Kafka` | JavaScript Writer using `kafka-producer-helper` template |

Filter the alerting destinations on reason severity:

```javascript
// Filter for "Page On-Call"
var reason = channelMap.get('DLQ_REASON');
return reason === 'CIRCUIT_OPEN' || reason === 'AUTH_EXPIRED';
```

## Source-Channel Routing Pattern

Upstream channels send to DLQ from their **error script** (Summary → Scripts
→ Error) when a destination has exhausted retries:

```javascript
// In source channel's error script
var router = Packages.com.mirth.connect.server.userutil.VMRouter;
var r = new router();

var sourceMap = ImmutableScriptableMap ? new ImmutableScriptableMap({}) : {};
// Build the envelope
var envelope = {
    DLQ_SOURCE_CHANNEL: channelId,
    DLQ_SOURCE_CHANNEL_NAME: channelName,
    DLQ_SOURCE_MESSAGE_ID: String(messageId),
    DLQ_REASON: 'MLLP_TIMEOUT',
    DLQ_ERROR_DETAIL: errorMessage || '',
    DLQ_RETRY_COUNT: String(connectorMessage ? connectorMessage.getSendAttempts() : 0)
};

r.routeMessageByChannelId(
    'dlq-channel-uuid-here',           // resolve via configurationMap
    new RawMessage(connectorMessage.getRawData(), null, envelope)
);
```

Or, more commonly, add a **Channel Writer** destination "Send to DLQ"
that fires only on terminal error:

- Channel Writer → Target Channel ID = `dlq` (paste UUID)
- Filter:

```javascript
// Only route here when previous destinations all failed
var allFailed = true;
for each (var dest in destinationSet.iterator()) {
    if (responseMap.get(dest.getDestinationName())
            && responseMap.get(dest.getDestinationName()).getStatus().toString() === 'SENT') {
        allFailed = false;
        break;
    }
}
return allFailed;
```

- Destination Mappings — push these into the outgoing message's sourceMap
  via Channel Writer's "Channel Map" section:

```
DLQ_SOURCE_CHANNEL = ${channelId}
DLQ_SOURCE_CHANNEL_NAME = ${channelName}
DLQ_SOURCE_MESSAGE_ID = ${messageId}
DLQ_REASON = ${responseStatusMessage}
DLQ_ERROR_DETAIL = ${responseError}
DLQ_RETRY_COUNT = ${responseMap.get('Primary Destination').getSendAttempts()}
```

## Query Examples

Find all DLQ entries from a specific source channel in the last 24h:

```sql
SELECT mm.id, mm.message_id, mcm.metadata_value AS reason, mm.received_date
FROM d_mm21 mm
JOIN d_mcm21 mcm ON mm.id = mcm.message_id AND mcm.metadata_name = 'DLQ_REASON'
JOIN d_mcm21 mcm2 ON mm.id = mcm2.message_id AND mcm2.metadata_name = 'DLQ_SOURCE_CHANNEL'
WHERE mcm2.metadata_value LIKE 'CH-LAB-RESULTS%'
  AND mm.received_date > NOW() - INTERVAL '1 day'
ORDER BY mm.received_date DESC;
```

(Replace `21` with the local-channel-id of your `dlq` channel — find it in
`d_channels`.)

Or via REST:

```bash
curl -k -u admin:admin \
  "https://localhost:8443/api/channels/{dlq-channel-id}/messages?metaDataColumn=DLQ_REASON&searchValue=MLLP_TIMEOUT"
```
