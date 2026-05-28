/**
 * Database Reader — CDC Polling with Persisted Watermark
 *
 * Mirth's Database Reader runs this script on a poll cycle. Each cycle:
 *
 *   1. Read the high-watermark from configurationMap['cdc.watermark'].
 *      If absent, default to NOW() − INITIAL_BACKFILL_HOURS.
 *   2. Query for rows where updated_at > (watermark − LATE_WINDOW)
 *      ORDER BY (updated_at, result_id).
 *   3. Push each row to the channel as a message (Mirth handles this
 *      via the script's return value — a Java ResultSet or List).
 *   4. Advance the watermark to MAX(updated_at) of the returned batch,
 *      MINUS LATE_WINDOW (so late-arriving rows that share a millisecond
 *      with the high-water row aren't lost).
 *   5. Persist the new watermark to configurationMap so it survives
 *      Mirth restarts.
 *
 * Why a lookback window?
 *   Postgres timestamps have microsecond resolution but commits aren't
 *   strictly time-ordered across sessions. Two transactions that
 *   "happened together" can have updated_at values that interleave
 *   relative to the snapshot you read. A 60s lookback catches them and
 *   the downstream channel just dedupes on (mrn, accession_num) — see
 *   the transformers/hl7v2-adt-deduplicator recipe for the dedup
 *   pattern.
 *
 * Source connector (Mirth Administrator → Source → Database Reader):
 *   - Driver:                org.postgresql.Driver
 *   - URL:                   jdbc:postgresql://db:5432/cdc_demo
 *   - Username / Password:   from configurationMap
 *   - Use JavaScript:        YES (this script)
 *   - Polling type:          Interval — 30000 ms (30s)
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : null;
var DB_URL    = (cfg && cfg.get('cdc.db.url'))    || 'jdbc:postgresql://localhost:5432/cdc_demo';
var DB_USER   = (cfg && cfg.get('cdc.db.user'))   || 'mirth';
var DB_PASS   = (cfg && cfg.get('cdc.db.pass'))   || 'changeme';
var DB_DRIVER = (cfg && cfg.get('cdc.db.driver')) || 'org.postgresql.Driver';
var TABLE     = (cfg && cfg.get('cdc.table'))     || 'lab_results';

// Lookback to catch late-arriving rows whose updated_at is older than the
// last watermark we computed. 1 minute is a safe default for OLTP.
var LATE_WINDOW_MS         = parseInt((cfg && cfg.get('cdc.late.window.ms')) || '60000', 10);
// On a fresh start, how far back to seed the watermark.
var INITIAL_BACKFILL_HOURS = parseInt((cfg && cfg.get('cdc.initial.backfill.hours')) || '1', 10);
// Cap per-cycle batch so a noisy spike doesn't lock the channel.
var MAX_BATCH              = parseInt((cfg && cfg.get('cdc.max.batch')) || '500', 10);
// Watermark key in configurationMap. One key per channel/table pair.
var WATERMARK_KEY          = (cfg && cfg.get('cdc.watermark.key')) || ('cdc.watermark.' + TABLE);

// =====================================================================
// HELPERS
// =====================================================================

function readWatermark() {
    if (!cfg) return null;
    var w = cfg.get(WATERMARK_KEY);
    return (w == null) ? null : ('' + w);
}

function writeWatermark(iso) {
    if (!cfg) return;
    // configurationMap.put() persists to OPTIONS table in Mirth's DB.
    cfg.put(WATERMARK_KEY, iso);
}

/**
 * ISO-8601 with milliseconds, UTC. Postgres accepts this directly as a
 * timestamptz parameter via PreparedStatement#setString -> implicit cast.
 */
function isoNow() { return new Date().toISOString(); }

function isoMinusMs(iso, ms) {
    var t = (iso == null) ? Date.now() : new Date(iso).getTime();
    return new Date(t - ms).toISOString();
}

function hoursAgoIso(h) {
    return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

// =====================================================================
// MAIN POLL CYCLE
// =====================================================================

Packages.java.lang.Class.forName(DB_DRIVER);
var conn = Packages.java.sql.DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);

// Compute query bounds
var lastWatermark   = readWatermark();
var effectiveBound  = lastWatermark
    ? isoMinusMs(lastWatermark, LATE_WINDOW_MS)
    : hoursAgoIso(INITIAL_BACKFILL_HOURS);

logger.info('CDC poll: table=' + TABLE +
    ' lastWatermark=' + lastWatermark +
    ' effectiveBound=' + effectiveBound +
    ' lateWindowMs=' + LATE_WINDOW_MS);

// SECURITY: TABLE is from configurationMap (operator-controlled), not
// from a message. Safe to interpolate. Never inline values from `msg`.
var sql =
    'SELECT result_id, mrn, accession_num, loinc_code, loinc_display, ' +
    '       value_num, value_text, units, abnormal_flag, result_status, ' +
    '       to_char(created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS created_at, ' +
    '       to_char(updated_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS updated_at ' +
    'FROM ' + TABLE + ' ' +
    'WHERE updated_at > ?::timestamptz ' +
    'ORDER BY updated_at ASC, result_id ASC ' +
    'LIMIT ?';

var ps = conn.prepareStatement(sql);
ps.setString(1, effectiveBound);
ps.setInt(2, MAX_BATCH);

var rs = ps.executeQuery();
var rowCount = 0;
var maxSeenIso = lastWatermark || effectiveBound;

// Mirth's Database Reader (JavaScript mode) expects this script to RETURN
// the ResultSet (or a Java List). Mirth iterates and emits one message
// per row. We pre-iterate here to compute the new watermark, then re-run
// the same query (cheaper) — alternatively, materialize to a List and
// return that. We do the materialize-to-list route for control.

var ResultList = Packages.com.mirth.connect.userutil.ImmutableConnectorMessage; // for type ref only
var rowsList   = new Packages.java.util.ArrayList();

while (rs.next() && rowCount < MAX_BATCH) {
    var row = new Packages.java.util.LinkedHashMap();
    row.put('result_id',     rs.getLong('result_id'));
    row.put('mrn',           rs.getString('mrn'));
    row.put('accession_num', rs.getString('accession_num'));
    row.put('loinc_code',    rs.getString('loinc_code'));
    row.put('loinc_display', rs.getString('loinc_display'));
    row.put('value_num',     rs.getString('value_num'));      // string keeps NULL distinguishable
    row.put('value_text',    rs.getString('value_text'));
    row.put('units',         rs.getString('units'));
    row.put('abnormal_flag', rs.getString('abnormal_flag'));
    row.put('result_status', rs.getString('result_status'));
    row.put('created_at',    rs.getString('created_at'));
    var updIso = rs.getString('updated_at');
    row.put('updated_at',    updIso);

    rowsList.add(row);
    rowCount++;
    if (updIso && updIso > maxSeenIso) maxSeenIso = updIso;
}

try { rs.close();   } catch (e) {}
try { ps.close();   } catch (e) {}
try { conn.close(); } catch (e) {}

// Advance watermark only if we actually saw rows. If empty cycle, leave
// the watermark alone so we still apply the lookback next time.
if (rowCount > 0) {
    writeWatermark(maxSeenIso);
    logger.info('CDC poll: emitted ' + rowCount + ' rows. Advanced watermark → ' + maxSeenIso);
} else {
    logger.info('CDC poll: 0 rows (watermark unchanged)');
}

// Surface metrics for the dashboard / monitoring channel.
if (typeof globalChannelMap !== 'undefined') {
    globalChannelMap.put('cdc.lastPoll.ts', new Date().toISOString());
    globalChannelMap.put('cdc.lastPoll.rows', rowCount);
    globalChannelMap.put('cdc.lastPoll.watermark', maxSeenIso);
}

// Mirth Database Reader JS contract: the LAST expression is treated as
// the result set. Return the materialized list.
rowsList;
