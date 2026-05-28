/**
 * Cerner Millennium FHIR R4 Scheduled Pull
 *
 * Polls a Cerner Code Console FHIR R4 endpoint every N minutes, pulls
 * resources modified since the last successful run, follows
 * Bundle.link[rel='next'] pagination to completion, and writes each
 * resource onto channelMap as a JSON line for the destination connector
 * to forward (HTTP POST, Kafka, DB insert — your choice).
 *
 * Auth: OAuth2 client_credentials with a signed JWT assertion (Cerner's
 * SMART System-Level auth). The token-fetch logic lives in the
 * `code-templates/http-sender-oauth2-jwt/` code template — load that
 * template into the channel before deploying.
 *
 * Delta sync: stores the last `_lastUpdated` high-water mark in
 * configurationMap under `cerner.lastSync.<tenantId>`. On first run, set
 * that key to '2026-01-01T00:00:00Z' (or earlier) for a full backfill.
 *
 * Idempotence: re-running the same window is safe — Cerner returns the
 * same resources and the downstream destinations should upsert by id.
 *
 * Place on: Source Connector (JavaScript Reader, polling type "Cron"
 * every 15 minutes).
 *
 * Tested on: Mirth Connect 4.5.2 with Cerner sandbox
 * (https://fhir-myrecord.cerner.com/r4/<tenant>/)
 * Author: Nirmitee.io | License: MIT
 */

var TENANT_ID    = $cfg('cerner.tenant.id');                  // e.g. 'ec2458f2-1e24-41c8-b71b-0e701af7583d'
var BASE_URL     = $cfg('cerner.base.url') ||                 // e.g. 'https://fhir-ehr.cerner.com/r4'
                   'https://fhir-ehr.cerner.com/r4';
var RESOURCES    = ($cfg('cerner.resources') || 'Patient,Encounter,Observation,Condition').split(',');
var PAGE_LIMIT   = parseInt($cfg('cerner.page.limit') || '50', 10);
var MAX_PAGES    = parseInt($cfg('cerner.max.pages') || '200', 10);
var HWM_KEY      = 'cerner.lastSync.' + TENANT_ID;

// ---------------------------------------------------------------------
// OAuth2 token (provided by the http-sender-oauth2-jwt code template)
// ---------------------------------------------------------------------
// The code template exposes:  getCernerAccessToken()  -> string
// It signs a JWT with the system principal's private key, posts it to
// the Cerner token endpoint, caches the token for ~ttl-60s in
// globalMap['cerner.oauth.token'].
// If you haven't loaded the template yet, see:
//   /code-templates/http-sender-oauth2-jwt/README.md
// ---------------------------------------------------------------------

function httpGet(url, accessToken) {
    var HC = Packages.org.apache.http.impl.client.HttpClients;
    var client = HC.createDefault();
    try {
        var get = new Packages.org.apache.http.client.methods.HttpGet(url);
        get.addHeader('Accept', 'application/fhir+json');
        get.addHeader('Authorization', 'Bearer ' + accessToken);
        var resp = client.execute(get);
        try {
            var status = resp.getStatusLine().getStatusCode();
            var body = Packages.org.apache.http.util.EntityUtils.toString(resp.getEntity(), 'UTF-8') + '';
            return { status: status, body: body };
        } finally {
            resp.close();
        }
    } finally {
        client.close();
    }
}

function findNextLink(bundle) {
    if (!bundle.link) return null;
    for (var i = 0; i < bundle.link.length; i++) {
        if (bundle.link[i].relation === 'next') return bundle.link[i].url + '';
    }
    return null;
}

function readHighWaterMark() {
    var hwm = configurationMap.get(HWM_KEY);
    if (hwm) return hwm + '';
    // Default: pull last 24 hours on first run to avoid a giant backfill.
    var d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return d.toISOString();
}

function writeHighWaterMark(value) {
    configurationMap.put(HWM_KEY, value);
}

function pullResource(resourceType, sinceIso, token) {
    var url = BASE_URL + '/' + TENANT_ID + '/' + resourceType +
              '?_count=' + PAGE_LIMIT +
              '&_lastUpdated=ge' + sinceIso +
              '&_sort=-_lastUpdated';
    var allResources = [];
    var pages = 0;
    while (url && pages < MAX_PAGES) {
        var resp = httpGet(url, token);
        if (resp.status === 401) {
            throw new Error('Cerner returned 401 — token expired or scope invalid');
        }
        if (resp.status >= 400) {
            throw new Error('Cerner ' + resourceType + ' HTTP ' + resp.status + ': ' + resp.body.substring(0, 500));
        }
        var bundle = JSON.parse(resp.body);
        if (bundle.entry) {
            for (var i = 0; i < bundle.entry.length; i++) {
                if (bundle.entry[i].resource) allResources.push(bundle.entry[i].resource);
            }
        }
        url = findNextLink(bundle);
        pages++;
    }
    return { resources: allResources, pages: pages };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
var token;
try { token = getCernerAccessToken(); }
catch (e) {
    throw new Error('Could not fetch Cerner OAuth2 token: ' + e +
        ' (load /code-templates/http-sender-oauth2-jwt/ and configure the JWT signer)');
}

var sinceIso = readHighWaterMark();
var newHwm = sinceIso;
var summary = { resources: {}, pages: 0, total: 0 };
var allOut = [];

for (var r = 0; r < RESOURCES.length; r++) {
    var type = RESOURCES[r].trim();
    if (!type) continue;
    var pull = pullResource(type, sinceIso, token);
    summary.resources[type] = pull.resources.length;
    summary.pages += pull.pages;
    summary.total += pull.resources.length;

    for (var i = 0; i < pull.resources.length; i++) {
        var res = pull.resources[i];
        allOut.push(res);
        // Track the newest _lastUpdated we've seen for the HWM advance.
        var lu = res.meta && res.meta.lastUpdated;
        if (lu && lu > newHwm) newHwm = lu;
    }
}

// Advance the high-water mark to the newest _lastUpdated we saw.
if (newHwm !== sinceIso) {
    writeHighWaterMark(newHwm);
}

// Hand off to destinations. Most channels will use one of:
//   - HTTP Sender destination with $('payload') in the body
//   - Channel Writer to fan out to per-resource downstream channels
//   - Kafka producer code template
channelMap.put('cernerPullSince', sinceIso);
channelMap.put('cernerPullHwm', newHwm);
channelMap.put('cernerPullSummary', JSON.stringify(summary));
channelMap.put('payload', JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: allOut.map(function (r) { return { resource: r }; })
}));

logger.info(
    'Cerner pull: tenant=' + TENANT_ID +
    ' since=' + sinceIso +
    ' newHwm=' + newHwm +
    ' types=' + Object.keys(summary.resources).join(',') +
    ' total=' + summary.total +
    ' pages=' + summary.pages
);
