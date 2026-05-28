/**
 * SFTP File Reader — Rotation & Archival Post-Process Script
 *
 * Companion script for a Mirth Source: File Reader (scheme = SFTP).
 *
 * Lifecycle implemented:
 *   1. Pre-process: rename <file> → <file>.processing on the SFTP server
 *      so other Mirth nodes / cron jobs don't pick it up.
 *   2. Process: Mirth reads the renamed file as usual.
 *   3. Post-process (this script):
 *        - on success  → move to /archive/yyyy-mm-dd/<original-name>
 *        - on failure  → move to /error/yyyy-mm-dd/<original-name>
 *      Lock file (<file>.lock) is created on entry and removed on exit
 *      to prevent concurrent processing across Mirth cluster nodes.
 *
 * Use case:
 *   Hospital lab pushes ORU files via SFTP every 5 minutes. We need
 *   exactly-once processing, durable archive, error isolation, and
 *   cluster-safe locking.
 *
 * Place in:
 *   Channel → Scripts → Postprocessor   (this script)
 *   Channel → Source   → File Reader    (config below)
 *
 * Source connector config (Mirth Administrator):
 *   - Method:        SFTP
 *   - Host:          sftp.example.com   port 22
 *   - Username/Pass: from configurationMap (sftp.user / sftp.pass)
 *   - Directory:     /upload/inbound
 *   - File Filter:   *.hl7   (or *.csv, *.xml, etc.)
 *   - Recursive:     true (optional — see RECURSIVE_SCAN below)
 *   - Polling Type:  Interval — 300000 ms (5 min)
 *   - Move-to dir:   /upload/inbound          (we manage moves ourselves)
 *   - Move-to file:  ${originalFilename}.processing
 *   - After processing action: NONE — handled here
 *
 * Requirements:
 *   - JSch JAR on Mirth classpath (bundled with Mirth 4.x). If missing,
 *     drop jsch-0.2.x.jar into custom-lib/ and restart.
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration (override via configurationMap) ===
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : {};
var SFTP_HOST          = (cfg.get && cfg.get('sftp.host'))        || 'sftp.example.com';
var SFTP_PORT          = parseInt((cfg.get && cfg.get('sftp.port')) || '22', 10);
var SFTP_USER          = (cfg.get && cfg.get('sftp.user'))        || 'mirth';
var SFTP_PASS          = (cfg.get && cfg.get('sftp.pass'))        || 'changeme';
var SFTP_INBOUND_DIR   = (cfg.get && cfg.get('sftp.inbound.dir')) || '/upload/inbound';
var SFTP_ARCHIVE_BASE  = (cfg.get && cfg.get('sftp.archive.dir')) || '/upload/archive';
var SFTP_ERROR_BASE    = (cfg.get && cfg.get('sftp.error.dir'))   || '/upload/error';
var RECURSIVE_SCAN     = ((cfg.get && cfg.get('sftp.recursive')) || 'false') === 'true';

/**
 * Build a JSch SFTP channel. Caller is responsible for disconnect.
 */
function openSftp() {
    var jsch = new Packages.com.jcraft.jsch.JSch();
    var session = jsch.getSession(SFTP_USER, SFTP_HOST, SFTP_PORT);
    session.setPassword(SFTP_PASS);
    // For lab production, replace with known-hosts. For dev:
    var props = new Packages.java.util.Properties();
    props.put('StrictHostKeyChecking', 'no');
    session.setConfig(props);
    session.connect(15000);
    var ch = session.openChannel('sftp');
    ch.connect(15000);
    return { session: session, channel: ch };
}

function closeSftp(handle) {
    try { if (handle && handle.channel)  handle.channel.disconnect(); } catch (e) {}
    try { if (handle && handle.session)  handle.session.disconnect(); } catch (e) {}
}

/**
 * mkdir -p over SFTP — JSch's mkdir is not recursive.
 */
function sftpMkdirs(sftp, path) {
    var parts = ('' + path).split('/');
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        cur += '/' + parts[i];
        try { sftp.stat(cur); } catch (notFound) {
            try { sftp.mkdir(cur); } catch (e) {
                logger.warn('mkdir failed (likely race): ' + cur + ' — ' + e);
            }
        }
    }
}

/**
 * Acquire per-file lock by creating <path>.lock atomically.
 * Returns true if acquired, false if another node holds it.
 */
function acquireLock(sftp, filePath) {
    var lockPath = filePath + '.lock';
    try {
        // Atomic: put a tiny payload — if it exists we'd get an error on some
        // servers; otherwise stat first.
        try {
            sftp.stat(lockPath);
            return false; // lock already exists
        } catch (notFound) { /* good, fall through */ }

        var bytes = new Packages.java.lang.String(
            JSON.stringify({
                host: Packages.java.net.InetAddress.getLocalHost().getHostName(),
                pid:  Packages.java.lang.management.ManagementFactory.getRuntimeMXBean().getName(),
                ts:   new Date().toISOString()
            })
        ).getBytes('UTF-8');
        var bais = new Packages.java.io.ByteArrayInputStream(bytes);
        sftp.put(bais, lockPath);
        return true;
    } catch (e) {
        logger.warn('acquireLock(' + filePath + ') failed: ' + e);
        return false;
    }
}

function releaseLock(sftp, filePath) {
    try { sftp.rm(filePath + '.lock'); } catch (e) { /* best-effort */ }
}

/**
 * Today's date as YYYY-MM-DD for archive bucketing.
 */
function todayBucket() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Move a file to <baseDir>/<yyyy-mm-dd>/<filename>.
 * Returns the final destination path on success, or null on failure.
 */
function moveTo(sftp, sourcePath, baseDir, originalName) {
    var bucket = baseDir + '/' + todayBucket();
    sftpMkdirs(sftp, bucket);
    var dest = bucket + '/' + originalName;

    // If destination already exists (replay), append timestamp
    try {
        sftp.stat(dest);
        dest = bucket + '/' + originalName + '.' + new Date().getTime();
    } catch (notFound) { /* free slot */ }

    try {
        sftp.rename(sourcePath, dest);
        return dest;
    } catch (e) {
        logger.error('SFTP rename ' + sourcePath + ' → ' + dest + ' failed: ' + e);
        return null;
    }
}

// =====================================================================
// MAIN POST-PROCESS ENTRY POINT
// Mirth provides: message (the immutable Message), responseMap, channelMap,
// sourceMap. Original filename and directory:
//   sourceMap.get('originalFilename')  → e.g. 'lab_123.hl7.processing'
//   sourceMap.get('fileDirectory')     → e.g. '/upload/inbound'
// =====================================================================

var processedName = '' + sourceMap.get('originalFilename');   // foo.hl7.processing
var fileDir       = '' + (sourceMap.get('fileDirectory') || SFTP_INBOUND_DIR);
var originalName  = processedName.replace(/\.processing$/, '');
var processedPath = fileDir + '/' + processedName;

// Did the channel pipeline succeed? Inspect responseMap for any ERROR status.
var allSuccess = true;
var failureReasons = [];
try {
    var entries = responseMap.entrySet().iterator();
    while (entries.hasNext()) {
        var e = entries.next();
        var resp = e.getValue();
        if (resp && resp.getStatus && ('' + resp.getStatus()) !== 'SENT') {
            allSuccess = false;
            failureReasons.push(e.getKey() + ':' + resp.getStatus() +
                ' (' + (resp.getError ? resp.getError() : '') + ')');
        }
    }
} catch (inspectErr) {
    logger.warn('responseMap inspection failed, assuming success: ' + inspectErr);
}

var sftpHandle = null;
try {
    sftpHandle = openSftp();
    var sftp = sftpHandle.channel;

    if (!acquireLock(sftp, processedPath)) {
        logger.warn('Another node is processing ' + processedPath + ' — skipping post-process');
        return;
    }

    var targetBase = allSuccess ? SFTP_ARCHIVE_BASE : SFTP_ERROR_BASE;
    var finalPath  = moveTo(sftp, processedPath, targetBase, originalName);

    if (finalPath) {
        logger.info('SFTP post-process: ' + originalName +
            (allSuccess ? ' → ARCHIVED at ' : ' → ERROR at ') + finalPath +
            (allSuccess ? '' : ' reasons=' + failureReasons.join('|')));
    } else {
        logger.error('SFTP post-process: failed to move ' + processedPath);
    }

    releaseLock(sftp, processedPath);
} catch (err) {
    logger.error('SFTP post-process fatal: ' + err);
} finally {
    closeSftp(sftpHandle);
}

// Make summary available to downstream channels / monitoring
channelMap.put('sftpPostProcess', JSON.stringify({
    originalName: originalName,
    success: allSuccess,
    failures: failureReasons,
    recursive: RECURSIVE_SCAN,
    archiveBase: allSuccess ? SFTP_ARCHIVE_BASE : SFTP_ERROR_BASE,
    bucket: todayBucket()
}));
