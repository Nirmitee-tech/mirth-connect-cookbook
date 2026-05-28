/**
 * Database Writer -- Idempotent UPSERT for patient_admissions
 *
 * Destination type: Database Writer
 * Use the JavaScript option (NOT "Use JavaScript = No"), then drop this in.
 *
 * Why JavaScript mode instead of bound SQL?
 *   - We need to pull fields out of the channelMap that were populated by
 *     the source transformer (mrn, encounterId, status, admissionDate).
 *   - The Database Writer's "Use Parameterized SQL" option doesn't expose
 *     the ON CONFLICT ... DO UPDATE syntax cleanly, so we manage the
 *     PreparedStatement ourselves -- this avoids SQL injection regardless
 *     of what's in channelMap.
 *
 * Channel map inputs (set by the upstream transformer):
 *   mrn            -- patient MRN (string)              REQUIRED
 *   encounterId    -- encounter / visit number          REQUIRED
 *   admissionStatus -- 'admitted' | 'discharged' | ...  REQUIRED
 *   admissionDate  -- ISO 8601 timestamp                REQUIRED
 *   payloadHash    -- SHA-256 of raw message            optional
 *
 * Tested on: Mirth Connect 4.5.2 + PostgreSQL 13/14/15
 * Author: Nirmitee.io | License: MIT
 */

var UPSERT_SQL =
    'INSERT INTO patient_admissions ' +
    '  (mrn, encounter_id, status, admission_date, last_updated, payload_hash, source_channel) ' +
    'VALUES (?, ?, ?, ?::timestamptz, NOW(), ?, ?) ' +
    'ON CONFLICT (mrn) DO UPDATE SET ' +
    '  encounter_id   = EXCLUDED.encounter_id, ' +
    '  status         = EXCLUDED.status, ' +
    '  admission_date = EXCLUDED.admission_date, ' +
    '  last_updated   = NOW(), ' +
    '  payload_hash   = EXCLUDED.payload_hash, ' +
    '  source_channel = EXCLUDED.source_channel ' +
    'WHERE patient_admissions.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash';

// Pull values from the channel map. Throw a clear error if any required
// field is missing -- better than silently writing NULLs.
var mrn         = $('mrn');
var encounterId = $('encounterId');
var status      = $('admissionStatus');
var admDate     = $('admissionDate');
var payloadHash = $('payloadHash') || null;
var srcChannel  = (typeof channelName !== 'undefined') ? channelName : 'unknown';

if (!mrn || !encounterId || !status || !admDate) {
    throw new Error(
        'Upsert writer: missing required channel map field. ' +
        'mrn=' + mrn + ' encounterId=' + encounterId +
        ' status=' + status + ' admissionDate=' + admDate
    );
}

// DBConn is provided by the Database Writer's "JavaScript" mode -- it's a
// live JDBC connection scoped to this message. Always close the statement.
var stmt = null;
try {
    stmt = DBConn.prepareStatement(UPSERT_SQL);
    stmt.setString(1, mrn);
    stmt.setString(2, encounterId);
    stmt.setString(3, status);
    stmt.setString(4, admDate);
    stmt.setString(5, payloadHash);
    stmt.setString(6, srcChannel);

    var affected = stmt.executeUpdate();

    // Postgres returns 1 for both INSERT and UPDATE under ON CONFLICT.
    // A 0 result here means the WHERE filter blocked the update -- i.e.
    // the payload was byte-for-byte identical, which is a successful
    // idempotent replay. Don't error.
    channelMap.put('rowsAffected', affected.toString());
    responseMap.put('database-writer-upsert', ResponseFactory.getSuccessResponse(
        'mrn=' + mrn + ' rows=' + affected
    ));

    if (typeof logger !== 'undefined') {
        logger.info(
            'UPSERT patient_admissions mrn=' + mrn +
            ' enc=' + encounterId + ' status=' + status +
            ' rowsAffected=' + affected
        );
    }
} catch (e) {
    if (typeof logger !== 'undefined') {
        logger.error('Upsert failed for mrn=' + mrn + ': ' + e);
    }
    responseMap.put('database-writer-upsert', ResponseFactory.getErrorResponse(
        'UPSERT failed: ' + e.toString()
    ));
    throw e;
} finally {
    if (stmt) {
        try { stmt.close(); } catch (ignored) {}
    }
}
