/**
 * Dead Letter Queue (DLQ) Transformer for Mirth Connect (Java 17 Compatible)
 *
 * Source transformer for the dedicated "dlq" channel. Receives messages that
 * failed terminal processing in upstream channels, normalizes the failure
 * envelope, and stamps Mirth message metadata so messages are searchable and
 * replayable from the Mirth Administrator.
 *
 * INPUT CONTRACT:
 *   Upstream channels invoke `router.routeMessage('dlq', payload)` (Channel
 *   Writer destination, or scripted via VMRouter) with `sourceMap` populated
 *   with these keys:
 *     - DLQ_SOURCE_CHANNEL    UUID of the channel that failed
 *     - DLQ_SOURCE_CHANNEL_NAME  Display name (for searchability)
 *     - DLQ_SOURCE_MESSAGE_ID  Original messageId in the source channel
 *     - DLQ_REASON            Short failure tag (e.g. "MLLP_TIMEOUT")
 *     - DLQ_ERROR_DETAIL      Full stack/message
 *     - DLQ_RETRY_COUNT       Retry attempts already made
 *
 *   The message content itself is the original payload (HL7, JSON, XML, etc.).
 *
 * WHAT THIS DOES:
 *   1. Reads the failure envelope from sourceMap.
 *   2. Writes the same fields into Mirth's connectorMessage custom-metadata
 *      columns so they show up in the Message Browser's custom metadata view
 *      and are filterable via the REST API.
 *   3. Captures a timestamp.
 *   4. Logs a structured warn line for ops tooling.
 *
 * STORAGE:
 *   The "dlq" channel is configured with "Store Messages: ALWAYS" and
 *   "Encrypt Message Content: false" (so they can be replayed without keys
 *   when the source channel rebuilds).
 *
 * REPLAY:
 *   See the message-replay-rest channel — POST /dlq/replay/{messageId} will
 *   re-route the stored DLQ message back into its original source channel.
 *
 * WHERE TO INSTALL:
 *   This is the source transformer of the channel `dlq`.
 *
 * REQUIREMENTS:
 *   - "dlq" channel must declare these custom-metadata columns under
 *     Summary → Set Data Types → Message Metadata:
 *       DLQ_REASON         (string)
 *       DLQ_SOURCE_CHANNEL (string)
 *       DLQ_RETRY_COUNT    (number)
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var System = Packages.java.lang.System;

// 1) Pull fields off sourceMap (set by the upstream router)
var sourceChannelId   = String(sourceMap.get('DLQ_SOURCE_CHANNEL')      || 'UNKNOWN');
var sourceChannelName = String(sourceMap.get('DLQ_SOURCE_CHANNEL_NAME') || 'UNKNOWN');
var sourceMessageId   = String(sourceMap.get('DLQ_SOURCE_MESSAGE_ID')   || '');
var reason            = String(sourceMap.get('DLQ_REASON')              || 'UNSPECIFIED');
var errorDetail       = String(sourceMap.get('DLQ_ERROR_DETAIL')        || '');
var retryCount        = parseInt(String(sourceMap.get('DLQ_RETRY_COUNT') || '0'), 10);
var timestamp         = System.currentTimeMillis();

// 2) Stamp Mirth custom-metadata columns so it shows in Message Browser
//    These map to d_mcm.<column> in Mirth's database.
$co('DLQ_REASON', reason);
$co('DLQ_SOURCE_CHANNEL', sourceChannelId + '|' + sourceChannelName);
$co('DLQ_RETRY_COUNT', retryCount);

// 3) Stamp channelMap so destination connectors / response have full envelope
channelMap.put('DLQ_REASON', reason);
channelMap.put('DLQ_SOURCE_CHANNEL_ID', sourceChannelId);
channelMap.put('DLQ_SOURCE_CHANNEL_NAME', sourceChannelName);
channelMap.put('DLQ_SOURCE_MESSAGE_ID', sourceMessageId);
channelMap.put('DLQ_ERROR_DETAIL', errorDetail);
channelMap.put('DLQ_RETRY_COUNT', retryCount);
channelMap.put('DLQ_RECEIVED_AT', timestamp);

// 4) Structured log line so log aggregators (Loki/Splunk) can alert
logger.warn(JSON.stringify({
    event: 'dlq.message.received',
    sourceChannelId: sourceChannelId,
    sourceChannelName: sourceChannelName,
    sourceMessageId: sourceMessageId,
    reason: reason,
    retryCount: retryCount,
    dlqMessageId: String(connectorMessage.getMessageId()),
    receivedAt: timestamp,
    errorPreview: errorDetail.length > 200 ? errorDetail.substring(0, 200) + '...' : errorDetail
}));
