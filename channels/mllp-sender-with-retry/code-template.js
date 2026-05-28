/**
 * MLLP Sender — ACK Validation + Exponential Backoff Retry
 *
 * Companion code template for the MLLP Sender channel. Provides:
 *   - parseAck(response)       — extracts MSA-1, MSA-3, and ERR segments
 *   - shouldRetry(attempt, e)  — exponential backoff with cap, max retries
 *   - routeToDeadLetter(...)   — VM-router send to the "dlq-channel"
 *
 * Use case:
 *   You have a TCP/MLLP destination going to a downstream HL7 application
 *   (Epic Bridges, lab system, registry, etc.). The downstream sometimes
 *   responds AE/AR or times out. We need:
 *     - Treat AA  → success
 *     - Treat AE  → application error (retry, then DLQ)
 *     - Treat AR  → application reject (retry, then DLQ)
 *     - Treat no-ack / timeout → retry, then DLQ
 *   Backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s (capped at 5 min). Max 7 attempts.
 *
 * Place in: Settings → Code Templates → New → Function (context: Destination
 *           response transformer + Destination scripts).
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration (override via configurationMap) ===
var MLLP_RETRY_MAX_ATTEMPTS = 7;
var MLLP_RETRY_BASE_MS      = 1000;       // 1 second
var MLLP_RETRY_CAP_MS       = 5 * 60000;  // 5 minutes
var MLLP_DLQ_CHANNEL_NAME   = 'dlq-channel';

/**
 * Parse an HL7v2 ACK message and return its status.
 *
 * @param {string} response  Raw HL7v2 ACK string (with or without MLLP framing)
 * @returns {{code: string, msa3: string, errors: Array<string>}}
 *           code  = 'AA' | 'AE' | 'AR' | 'UNKNOWN'
 *           msa3  = textual reason (MSA-3)
 *           errors = array of ERR segment messages (empty if none)
 */
function parseAck(response) {
    var result = { code: 'UNKNOWN', msa3: '', errors: [] };
    if (!response) return result;

    // Strip MLLP framing chars (0x0B start, 0x1C+0x0D end) if present.
    var raw = ('' + response).replace(//g, '').replace(//g, '').trim();

    var lines = raw.split(/\r|\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var fields = line.split('|');
        if (fields[0] === 'MSA') {
            result.code = (fields[1] || '').toUpperCase();
            result.msa3 = fields[3] || '';
        } else if (fields[0] === 'ERR') {
            // ERR-3 (or ERR-1 in v2.3) commonly carries the message
            var errMsg = fields[3] || fields[1] || '';
            if (errMsg) result.errors.push(errMsg);
        }
    }
    return result;
}

/**
 * Decide whether to retry, and at what delay.
 *
 * @param {number} attemptNum  1-based attempt count of the *next* attempt
 * @param {Object} lastError   { ackCode?: string, exception?: string }
 * @returns {{retry: boolean, delayMs: number, reason: string}}
 */
function shouldRetry(attemptNum, lastError) {
    lastError = lastError || {};

    // Hard stop after N attempts
    if (attemptNum > MLLP_RETRY_MAX_ATTEMPTS) {
        return { retry: false, delayMs: 0, reason: 'max-attempts-exceeded' };
    }

    // AR (application reject) on the first try frequently means malformed
    // input — don't retry blindly; let the destination's own retry policy
    // hit DLQ once. AE (application error) is transient → retry.
    var ack = (lastError.ackCode || '').toUpperCase();
    if (ack === 'AA') {
        return { retry: false, delayMs: 0, reason: 'success-no-retry' };
    }

    // Exponential backoff: base * 2^(attempt-1), capped
    var delay = MLLP_RETRY_BASE_MS * Math.pow(2, attemptNum - 1);
    if (delay > MLLP_RETRY_CAP_MS) delay = MLLP_RETRY_CAP_MS;

    return {
        retry: true,
        delayMs: delay,
        reason: ack ? ('ack=' + ack) : (lastError.exception ? 'exception' : 'no-response')
    };
}

/**
 * Route the failed message to the DLQ channel via VM router.
 * Call this when shouldRetry() returns { retry: false } and the message
 * was not delivered successfully.
 *
 * @param {string} rawMessage     The original outbound HL7v2 message
 * @param {Object} failureContext { attempts, lastAckCode, lastError, channelId, ... }
 */
function routeToDeadLetter(rawMessage, failureContext) {
    try {
        var envelope = {
            timestamp: new Date().toISOString(),
            sourceChannel: (typeof channelId !== 'undefined') ? channelId : null,
            sourceChannelName: (typeof channelName !== 'undefined') ? channelName : null,
            failure: failureContext || {},
            originalMessage: rawMessage
        };

        // Mirth's VM router — synchronous handoff to dlq-channel
        var router = Packages.com.mirth.connect.server.userutil.VMRouter;
        if (router && router.routeMessage) {
            new router().routeMessage(MLLP_DLQ_CHANNEL_NAME, JSON.stringify(envelope));
        } else if (typeof VMRouter !== 'undefined') {
            new VMRouter().routeMessage(MLLP_DLQ_CHANNEL_NAME, JSON.stringify(envelope));
        }

        if (typeof logger !== 'undefined') {
            logger.warn('MLLP retry exhausted → routed to DLQ. Attempts=' +
                (failureContext && failureContext.attempts) +
                ' lastAck=' + (failureContext && failureContext.lastAckCode));
        }
    } catch (e) {
        if (typeof logger !== 'undefined') {
            logger.error('Failed to route to DLQ: ' + e);
        }
    }
}

// Export for Node-based unit tests (no-op inside Rhino)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseAck: parseAck, shouldRetry: shouldRetry };
}
