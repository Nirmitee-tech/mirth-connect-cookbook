/**
 * HL7v2 ADT Deduplicator — Drop duplicate ADT messages within a TTL window
 *
 * Use case:
 *   Epic ADT feeds frequently double-send during HA failover or interface restarts.
 *   Without dedup, downstream FHIR servers see the same admission twice.
 *
 * Strategy:
 *   Hash MSH-10 (message control ID) + PID-3 (MRN) + EVN-2 (event timestamp)
 *   Cache hash in globalChannelMap with a TTL (default 24h).
 *   On hit → filter out the message (return false from filter step).
 *
 * IMPORTANT:
 *   This uses globalChannelMap which is per-channel. For multi-channel dedup
 *   use globalMap (server-wide) — but watch memory usage at scale.
 *   For >100K messages/day dedup window, use a Redis sidecar instead.
 *
 * Place this in: Source Connector → Filter → Add Step → JavaScript
 * Return `false` to filter the message out (drop it).
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Config ===
var DEDUP_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
var MAX_CACHE_SIZE = 100000;             // Cap to prevent unbounded growth
var CACHE_KEY = 'adt_dedup_cache';        // globalChannelMap key

// === Compute message hash ===
function md5(input) {
    var md = java.security.MessageDigest.getInstance('MD5');
    var bytes = md.digest(new java.lang.String(input).getBytes('UTF-8'));
    var hex = new java.lang.StringBuilder();
    for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i] & 0xff;
        if (b < 16) hex.append('0');
        hex.append(java.lang.Integer.toHexString(b));
    }
    return hex.toString() + '';
}

// Extract the dedup signature fields from the parsed HL7v2 XML
var msgControlId = msg['MSH']['MSH.10']['MSH.10.1'].toString();
var mrn          = msg['PID']['PID.3']['PID.3.1'].toString();
var eventDt      = msg['EVN']['EVN.2']['EVN.2.1'].toString();
var triggerEvent = msg['MSH']['MSH.9']['MSH.9.2'].toString();  // e.g., A01

var signature = [msgControlId, mrn, eventDt, triggerEvent].join('|');
var hash = md5(signature);

// === Cache lookup ===
var cache = globalChannelMap.get(CACHE_KEY);
if (cache === null || cache === undefined) {
    cache = new java.util.concurrent.ConcurrentHashMap();
    globalChannelMap.put(CACHE_KEY, cache);
}

var now = java.lang.System.currentTimeMillis();
var previousTimestamp = cache.get(hash);

if (previousTimestamp !== null) {
    var ageMs = now - previousTimestamp;
    if (ageMs < DEDUP_TTL_MS) {
        // Duplicate detected — drop it
        channelMap.put('dedupResult', 'DUPLICATE');
        channelMap.put('dedupOriginalAgeMs', ageMs.toString());
        logger.info(
            'ADT DEDUP: Dropping duplicate MRN=' + mrn +
            ' MSG-ID=' + msgControlId +
            ' triggerEvent=' + triggerEvent +
            ' originalAgeMs=' + ageMs
        );
        return false;  // filter step: drop the message
    }
}

// New message — cache it
cache.put(hash, java.lang.Long.valueOf(now));
channelMap.put('dedupResult', 'NEW');

// Prune old entries if cache is too large
if (cache.size() > MAX_CACHE_SIZE) {
    var iterator = cache.entrySet().iterator();
    var removed = 0;
    while (iterator.hasNext() && removed < MAX_CACHE_SIZE / 10) {
        var entry = iterator.next();
        if ((now - entry.getValue()) > DEDUP_TTL_MS) {
            iterator.remove();
            removed++;
        }
    }
    logger.info('ADT DEDUP: Pruned ' + removed + ' expired entries from cache');
}

return true;  // not a duplicate — let the message through
