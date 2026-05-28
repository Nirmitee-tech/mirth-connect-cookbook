// Destination 1 response transformer — handle the API response and stash
// useful fields in channelMap for downstream destinations.
//
// Runs after the HTTP Sender receives a response from the downstream API.
// Most APIs return either:
//   - 2xx + JSON ack body  → record their event id / status
//   - 4xx                  → permanent failure, mark and continue
//   - 5xx / timeout        → transient, Mirth will retry per the queue policy
//
// We don't throw on 4xx — we record it and let DB/CSV destinations still run.
// The DB row will then carry the API ack id (or error code) for traceability.

try {
    var statusCode = parseInt(channelMap.get('responseStatusCode')) || 0;

    if (statusCode >= 200 && statusCode < 300 && responseStatus) {
        // Success — try to extract an ack id from the JSON body
        try {
            var body = JSON.parse(responseStatus);
            channelMap.put('apiAckId', String(body.id || body.eventId || body.ackId || 'no-id'));
            channelMap.put('apiStatus', 'ACK_OK');
        } catch (e) {
            channelMap.put('apiAckId', 'NO_BODY');
            channelMap.put('apiStatus', 'ACK_OK');
        }
        logger.info('API ack for ' + channelMap.get('messageId') + ': ' + channelMap.get('apiAckId'));

    } else if (statusCode >= 400 && statusCode < 500) {
        channelMap.put('apiAckId', 'HTTP_' + statusCode);
        channelMap.put('apiStatus', 'CLIENT_ERROR');
        logger.warn('API client error ' + statusCode + ' for ' + channelMap.get('messageId'));

    } else {
        // Transient (5xx / network) — leave channelMap unset so destination
        // queues retry per the per-destination retry policy.
        channelMap.put('apiAckId', 'PENDING');
        channelMap.put('apiStatus', 'RETRY');
    }

} catch (e) {
    logger.error('Response handler failed: ' + e);
    channelMap.put('apiAckId', 'PARSE_ERROR');
    channelMap.put('apiStatus', 'ERROR');
}
