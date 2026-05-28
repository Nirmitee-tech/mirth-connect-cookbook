/**
 * HL7v2 ACK Customizer — Generate AA/AE/AR ACKs with proper MSA-3, ERR segments
 *
 * Use case:
 *   Mirth's default ACK behavior often fails downstream EHR contracts because:
 *   - MSA-3 (text message) is missing or generic
 *   - ERR segments are not generated for AE/AR
 *   - MSH-9 is just "ACK" instead of "ACK^A01^ACK" (enhanced mode)
 *
 * This recipe builds a fully-conformant ACK including:
 *   - MSH segment with sending/receiving app swap
 *   - MSA with code, original message control ID, optional text
 *   - ERR segment(s) when AE/AR with diagnostic info
 *
 * Place this in: Source Connector → Response Map → set custom ACK as response
 *   OR in a Code Template called from response transformer.
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

/**
 * Build a conformant ACK message.
 * @param {string} originalMessage - the inbound HL7v2 message
 * @param {string} ackCode - "AA" (Accept), "AE" (Error), "AR" (Reject)
 * @param {string} textMessage - optional human-readable status (MSA-3)
 * @param {Array} errors - optional array of error objects for ERR segments
 *                         { severity: 'W'|'E'|'F', code: '101', text: 'Required field missing' }
 * @returns {string} ACK message ready to send back via MLLP
 */
function buildAck(originalMessage, ackCode, textMessage, errors) {
    if (!originalMessage) throw new Error('Original message required');
    ackCode = ackCode || 'AA';
    textMessage = textMessage || '';

    // Parse field separator + encoding chars (MSH-1, MSH-2)
    var fieldSep = '|';
    var compSep = '^';
    var msh = originalMessage.split(/\r|\n/)[0];
    if (msh.indexOf('MSH') !== 0) throw new Error('Not an HL7v2 message — no MSH segment');

    var mshFields = msh.split(fieldSep);
    var sendingApp = mshFields[2] || '';
    var sendingFac = mshFields[3] || '';
    var receivingApp = mshFields[4] || '';
    var receivingFac = mshFields[5] || '';
    var msgControlId = mshFields[9] || '';
    var processingId = mshFields[10] || 'P';
    var versionId = mshFields[11] || '2.5.1';
    var triggerEvent = (mshFields[8] || 'ACK').split(compSep);
    var msgType = triggerEvent[0] || 'ACK';
    var event = triggerEvent[1] || '';

    // Enhanced ACK structure: MSH-9 = ACK^<event>^ACK (HL7 2.4+)
    var ackMsgType = 'ACK' + (event ? compSep + event + compSep + 'ACK' : '');

    // Generate ISO-style HL7 timestamp (yyyymmddHHMMSS)
    var now = new java.util.Date();
    var fmt = new java.text.SimpleDateFormat('yyyyMMddHHmmss');
    fmt.setTimeZone(java.util.TimeZone.getTimeZone('UTC'));
    var ts = fmt.format(now) + '';

    // Generate ACK control ID (different from original)
    var ackControlId = 'ACK' + ts + Math.floor(Math.random() * 1000);

    // Build MSH (swap sender/receiver)
    var ackMsh = [
        'MSH',
        '^~\\&',
        receivingApp, receivingFac,       // we are now the sender
        sendingApp, sendingFac,            // they are now the receiver
        ts, '',
        ackMsgType,
        ackControlId, processingId, versionId
    ].join(fieldSep);

    // Build MSA
    var ackMsa = ['MSA', ackCode, msgControlId, textMessage].join(fieldSep);

    var lines = [ackMsh, ackMsa];

    // Build ERR segments if errors provided
    if (errors && errors.length > 0) {
        for (var i = 0; i < errors.length; i++) {
            var err = errors[i];
            // ERR-3: HL7 error code, ERR-4: severity, ERR-7: diagnostic info
            var errSegment = [
                'ERR',
                '',                                          // ERR-1 (deprecated)
                '',                                          // ERR-2 (deprecated)
                (err.code || '207') + compSep + (err.text || 'Application internal error'),
                err.severity || 'E',                         // W=Warning, E=Error, F=Fatal
                '', '',
                err.diagnostic || ''
            ].join(fieldSep);
            lines.push(errSegment);
        }
    }

    return lines.join('\r') + '\r';
}

/**
 * Convenience: success ACK
 */
function buildAckAA(originalMessage, message) {
    return buildAck(originalMessage, 'AA', message || 'Message processed successfully');
}

/**
 * Convenience: error ACK with error details
 */
function buildAckAE(originalMessage, errorCode, errorText, diagnostic) {
    return buildAck(originalMessage, 'AE', errorText || 'Application error', [{
        severity: 'E',
        code: errorCode || '207',
        text: errorText || 'Application internal error',
        diagnostic: diagnostic || ''
    }]);
}

/**
 * Convenience: rejection ACK (message was rejected, not just an error)
 */
function buildAckAR(originalMessage, reason) {
    return buildAck(originalMessage, 'AR', reason || 'Message rejected', [{
        severity: 'E',
        code: '102',
        text: 'Data type error',
        diagnostic: reason || ''
    }]);
}

/**
 * Example usage in a Source response transformer:
 *
 *   // Inside response transformer or destination connector:
 *   var ack;
 *   if (channelMap.get('validationFailed')) {
 *       ack = buildAckAE(connectorMessage.getRawData(), '101', 'Required field missing', 'PID-3 is empty');
 *   } else if (channelMap.get('businessRuleRejected')) {
 *       ack = buildAckAR(connectorMessage.getRawData(), 'Patient not on roster');
 *   } else {
 *       ack = buildAckAA(connectorMessage.getRawData(), 'Bundle persisted with 9 resources');
 *   }
 *   responseMap.put('customAck', ack);
 */
