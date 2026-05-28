/**
 * Recipe #32 — HIPAA Audit Trail Channel
 *
 * SOURCE TRANSFORMER for the side-car audit channel.
 *
 * Input format (channelMap from the calling channel):
 *   The caller posts an AuditEvent envelope JSON to the Channel Reader of this
 *   channel via router.routeMessageByChannelName('AuditTrail', auditJson):
 *
 *     {
 *       "occurredAt":   "2026-05-28T12:00:00Z",
 *       "channelId":    "<sourceChannelId>",
 *       "channelName":  "ADT Ingest",
 *       "messageId":    "<sourceMessageId>",
 *       "action":       "C" | "R" | "U" | "D" | "E",
 *       "outcome":      "0" | "4" | "8" | "12",
 *       "outcomeDesc":  "OK",
 *       "userId":       "system" | "<oauth-sub>",
 *       "userRole":     "system" | "Practitioner" | "Patient",
 *       "patientId":    "MRN12345" | null,
 *       "resourceType": "HL7v2:ADT^A04" | "Patient",
 *       "resourceId":   "Patient/abc",
 *       "sourceIp":     "10.0.0.42",
 *       "detail":       { ... arbitrary, will be JSONB ... }
 *     }
 *
 * Output: populates channelMap entries consumed by the Database Writer:
 *   $('event_uuid'), $('occurred_at'), $('channel_id'), $('channel_name'),
 *   $('message_id'), $('server_id'), $('source_ip'), $('user_id'), $('user_role'),
 *   $('action'), $('outcome'), $('outcome_desc'), $('patient_id'),
 *   $('resource_type'), $('resource_id'), $('detail_json'),
 *   $('prev_hash'), $('row_hash')
 *
 * The hash chain is computed by SELECT-ing the last row's row_hash from the
 * audit_event table inside the transformer (single round-trip), then
 * sha256(payload || prev_hash) becomes the new row_hash.
 *
 * Tested on: Mirth Connect 4.5.2, PostgreSQL 16
 * Author: Nirmitee.io
 * License: MIT
 */

var MessageDigest = Packages.java.security.MessageDigest;
var DriverManager = Packages.java.sql.DriverManager;
var UUID = Packages.java.util.UUID;

function sha256Hex(s) {
    var md = MessageDigest.getInstance('SHA-256');
    var bytes = md.digest(new java.lang.String(s).getBytes('UTF-8'));
    var hex = new java.lang.StringBuilder();
    for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i] & 0xff;
        if (b < 0x10) hex.append('0');
        hex.append(java.lang.Integer.toHexString(b));
    }
    return hex.toString();
}

function getPrevHash() {
    // configurationMap stores last-emitted hash so we avoid a DB round trip
    // for every audit event. Fall back to a DB query if cold.
    var last = $gc('audit.lastHash');
    if (last) return last;

    // Single-shot recovery from DB
    var url   = configurationMap.get('audit.db.url');   // jdbc:postgresql://mirth-db:5432/mirthdb
    var user  = configurationMap.get('audit.db.user');
    var pass  = configurationMap.get('audit.db.password');
    var conn = null, stmt = null, rs = null;
    try {
        conn = DriverManager.getConnection(url, user, pass);
        stmt = conn.createStatement();
        rs = stmt.executeQuery("SELECT row_hash FROM audit.audit_event ORDER BY id DESC LIMIT 1");
        if (rs.next()) return String(rs.getString(1));
    } finally {
        if (rs)   try { rs.close();   } catch (e) {}
        if (stmt) try { stmt.close(); } catch (e) {}
        if (conn) try { conn.close(); } catch (e) {}
    }
    // Genesis row
    return new Array(65).join('0').substring(0, 64);
}

// -------- parse envelope --------
var envelope;
try {
    envelope = JSON.parse(connectorMessage.getRawData());
} catch (e) {
    throw new Error('AuditTrail: invalid envelope JSON — ' + e.message);
}

// -------- assemble row --------
var eventUuid  = String(UUID.randomUUID());
var occurredAt = envelope.occurredAt   || new Date().toISOString();
var channelId  = envelope.channelId    || 'unknown';
var channelNm  = envelope.channelName  || null;
var messageId  = envelope.messageId    || null;
var serverId   = String(configurationMap.get('server.id') || '');
var sourceIp   = envelope.sourceIp     || null;
var userId     = envelope.userId       || 'system';
var userRole   = envelope.userRole     || 'system';
var action     = envelope.action       || 'E';
var outcome    = envelope.outcome      || '0';
var outcomeD   = envelope.outcomeDesc  || null;
var patientId  = envelope.patientId    || null;
var resourceTy = envelope.resourceType || null;
var resourceId = envelope.resourceId   || null;
var detail     = envelope.detail ? JSON.stringify(envelope.detail) : null;

if (['C','R','U','D','E'].indexOf(action) === -1) {
    throw new Error('AuditTrail: invalid action code "' + action + '" (must be C/R/U/D/E)');
}

// -------- chain hash --------
var prevHash = getPrevHash();
var payload  = eventUuid
             + occurredAt
             + channelId
             + (messageId  || '')
             + userId
             + action
             + (patientId  || '')
             + (resourceTy || '')
             + (resourceId || '')
             + (detail     || '')
             + prevHash;
var rowHash = sha256Hex(payload);

// -------- populate destination map --------
channelMap.put('event_uuid',    eventUuid);
channelMap.put('occurred_at',   occurredAt);
channelMap.put('channel_id',    channelId);
channelMap.put('channel_name',  channelNm);
channelMap.put('message_id',    messageId);
channelMap.put('server_id',     serverId);
channelMap.put('source_ip',     sourceIp);
channelMap.put('user_id',       userId);
channelMap.put('user_role',     userRole);
channelMap.put('action',        action);
channelMap.put('outcome',       outcome);
channelMap.put('outcome_desc',  outcomeD);
channelMap.put('patient_id',    patientId);
channelMap.put('resource_type', resourceTy);
channelMap.put('resource_id',   resourceId);
channelMap.put('detail_json',   detail);
channelMap.put('prev_hash',     prevHash);
channelMap.put('row_hash',      rowHash);

// Cache new hash for the next event (avoids DB round trip)
$gc('audit.lastHash', rowHash);

// Optional: unit-testable export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sha256Hex: sha256Hex };
}
