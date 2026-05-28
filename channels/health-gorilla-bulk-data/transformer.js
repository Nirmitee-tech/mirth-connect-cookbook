/**
 * Health Gorilla Bulk Data Pull
 *
 * Implements the FHIR Bulk Data Access (Flat FHIR) workflow against
 * Health Gorilla:
 *
 *   1. POST  /Patient/$export?_type=Patient,Encounter,Observation,Condition
 *            with Prefer: respond-async  -> 202 + Content-Location
 *   2. GET   <Content-Location>   poll every N seconds until 200 OK
 *   3. Parse the manifest's `output[]` -> { type, url }
 *   4. GET   each NDJSON URL (signed S3 link)
 *   5. Split on \n, emit each line into a downstream channel
 *
 * Idempotence: every resource has a stable id (Health Gorilla mints
 * one) — destinations must PUT to upsert. The transformer also tracks
 * the last successful `_since` parameter in configurationMap so the
 * next run only fetches deltas.
 *
 * Auth: OAuth2 client_credentials via the cookbook's JWT signer code
 * template at /code-templates/http-sender-oauth2-jwt/.
 *
 * Place on: Source Connector (JavaScript Reader, cron every 1 hour).
 *
 * Tested on: Mirth Connect 4.5.2 with Health Gorilla sandbox
 * Author: Nirmitee.io | License: MIT
 */

var HG_BASE        = $cfg('healthgorilla.base.url') || 'https://sandbox.healthgorilla.com/fhir/R4';
var EXPORT_TYPES   = $cfg('healthgorilla.export.types') || 'Patient,Encounter,Observation,Condition';
var POLL_INTERVAL  = parseInt($cfg('healthgorilla.poll.interval.seconds') || '30', 10) * 1000;
var POLL_TIMEOUT   = parseInt($cfg('healthgorilla.poll.timeout.minutes') || '60', 10) * 60 * 1000;
var SINCE_KEY      = 'healthgorilla.lastSince';
var SEEN_KEY_PREFIX = 'hg-seen:';
var SEEN_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // remember 7 days of resource ids

// === HTTP helpers ===
function newClient() {
    return Packages.org.apache.http.impl.client.HttpClients.createDefault();
}

function execute(client, request) {
    var resp = client.execute(request);
    var status = resp.getStatusLine().getStatusCode();
    var body = Packages.org.apache.http.util.EntityUtils.toString(resp.getEntity(), 'UTF-8') + '';
    var location = '';
    var locHdr = resp.getFirstHeader('Content-Location');
    if (locHdr) location = locHdr.getValue() + '';
    resp.close();
    return { status: status, body: body, location: location };
}

function getToken() {
    if (typeof getHealthGorillaAccessToken !== 'undefined') return getHealthGorillaAccessToken();
    throw new Error('Load /code-templates/http-sender-oauth2-jwt/ first -- need getHealthGorillaAccessToken()');
}

// === 1. Kick off $export ===
function kickoffExport(token, sinceIso) {
    var client = newClient();
    try {
        var url = HG_BASE + '/Patient/$export?_type=' + encodeURIComponent(EXPORT_TYPES);
        if (sinceIso) url += '&_since=' + encodeURIComponent(sinceIso);
        var get = new Packages.org.apache.http.client.methods.HttpGet(url);
        get.addHeader('Accept', 'application/fhir+json');
        get.addHeader('Prefer', 'respond-async');
        get.addHeader('Authorization', 'Bearer ' + token);
        var resp = execute(client, get);
        if (resp.status !== 202) {
            throw new Error('Bulk kickoff returned HTTP ' + resp.status + ': ' + resp.body.substring(0, 500));
        }
        if (!resp.location) {
            throw new Error('Bulk kickoff missing Content-Location header');
        }
        return resp.location;
    } finally {
        client.close();
    }
}

// === 2. Poll status until 200 OK ===
function pollStatus(contentLocation, token) {
    var deadline = Date.now() + POLL_TIMEOUT;
    var client = newClient();
    try {
        while (Date.now() < deadline) {
            var get = new Packages.org.apache.http.client.methods.HttpGet(contentLocation);
            get.addHeader('Authorization', 'Bearer ' + token);
            get.addHeader('Accept', 'application/json');
            var resp = execute(client, get);
            if (resp.status === 200) {
                return JSON.parse(resp.body);
            }
            if (resp.status === 202) {
                java.lang.Thread.sleep(POLL_INTERVAL);
                continue;
            }
            throw new Error('Bulk status returned HTTP ' + resp.status + ': ' + resp.body.substring(0, 500));
        }
        throw new Error('Bulk export timed out after ' + (POLL_TIMEOUT / 60000) + ' minutes');
    } finally {
        client.close();
    }
}

// === 3. Download a single NDJSON file ===
function downloadNdjson(url, token) {
    var client = newClient();
    try {
        var get = new Packages.org.apache.http.client.methods.HttpGet(url);
        // Health Gorilla S3 links are pre-signed, so omitting Authorization
        // for the S3 leg is actually safer. The current sandbox accepts
        // both — keep the header if the manifest URL is on the HG domain.
        if (url.indexOf('healthgorilla.com') !== -1) {
            get.addHeader('Authorization', 'Bearer ' + token);
        }
        var resp = execute(client, get);
        if (resp.status !== 200) {
            throw new Error('NDJSON download HTTP ' + resp.status + ' from ' + url);
        }
        return resp.body;
    } finally {
        client.close();
    }
}

// === 4. Idempotence — skip resource ids we've already processed ===
function alreadySeen(resource) {
    var key = SEEN_KEY_PREFIX + resource.resourceType + ':' + resource.id;
    if (globalChannelMap.containsKey(key)) {
        var ts = parseInt(globalChannelMap.get(key) + '', 10);
        if (Date.now() - ts < SEEN_TTL_MS) return true;
    }
    globalChannelMap.put(key, '' + Date.now());
    return false;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
var token = getToken();
var sinceIso = configurationMap.get(SINCE_KEY) || '';
var runStartIso = new Date().toISOString();

logger.info('Health Gorilla bulk pull: since=' + (sinceIso || '(none)') + ' types=' + EXPORT_TYPES);

var pollUrl = kickoffExport(token, sinceIso);
logger.info('Bulk kickoff Content-Location: ' + pollUrl);

var manifest = pollStatus(pollUrl, token);
logger.info('Bulk manifest received with ' + (manifest.output ? manifest.output.length : 0) + ' files');

// === 5. Process every file ===
var stats = { files: 0, resources: 0, duplicatesSkipped: 0, byType: {} };
var allResources = [];

if (manifest.output) {
    for (var f = 0; f < manifest.output.length; f++) {
        var file = manifest.output[f];
        var ndjson = downloadNdjson(file.url, token);
        var lines = ndjson.split('\n');
        stats.files++;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var res;
            try { res = JSON.parse(line); }
            catch (e) {
                logger.warn('NDJSON parse failed file=' + file.type + ' line=' + i + ': ' + e);
                continue;
            }
            if (alreadySeen(res)) {
                stats.duplicatesSkipped++;
                continue;
            }
            allResources.push(res);
            stats.resources++;
            stats.byType[res.resourceType] = (stats.byType[res.resourceType] || 0) + 1;
        }
    }
}

// Advance the high-water mark to this run's start time.
configurationMap.put(SINCE_KEY, manifest.transactionTime || runStartIso);

channelMap.put('hgPullSince',   sinceIso);
channelMap.put('hgPullNewSince', manifest.transactionTime || runStartIso);
channelMap.put('hgPullStats',   JSON.stringify(stats));
channelMap.put('payload', JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: allResources.map(function (r) { return { resource: r }; })
}));

logger.info('Health Gorilla pull complete: files=' + stats.files +
            ' resources=' + stats.resources +
            ' dupesSkipped=' + stats.duplicatesSkipped +
            ' byType=' + JSON.stringify(stats.byType));
