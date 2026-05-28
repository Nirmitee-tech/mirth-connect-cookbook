/**
 * US Core 6.1.0 Validation Transformer
 *
 * Reads a FHIR R4 Bundle from channelMap.fhirBundle, POSTs it to
 * tx.fhir.org/r4/$validate with the US Core 6.1.0 profile parameter,
 * parses the returned OperationOutcome, and stores the verdict back on
 * channelMap (and as a JSON object in responseMap if running in a
 * destination connector).
 *
 * Pre-flight gate: pair this in a Source or Pre-Processor step ahead of a
 * "post-to-strict-FHIR-server" destination. If validation fails you can
 * route to a DLQ instead of letting the strict server NACK you.
 *
 * Caching: keys results by SHA-256 of the canonical resource JSON for 1
 * hour using globalChannelMap. This avoids hammering tx.fhir.org for
 * idempotent traffic (the same DiagnosticReport sent twice in a minute
 * doesn't re-validate).
 *
 * Use case: pre-flight check before posting to Epic, Cerner, Health
 * Gorilla, or any other strict FHIR R4 server.
 *
 * Inputs (channelMap):
 *   fhirBundle  - JSON string of a FHIR Bundle (or single resource)
 *
 * Outputs (channelMap):
 *   validationValid     - 'true' / 'false'
 *   validationErrors    - JSON array of error issue strings
 *   validationWarnings  - JSON array of warning issue strings
 *   validationCacheHit  - 'true' / 'false'
 *
 * Tested on: Mirth Connect 4.5.2 against https://tx.fhir.org/r4
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var TX_ENDPOINT = 'https://tx.fhir.org/r4';
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|6.1.0';
var US_CORE_LAB_OBS_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab|6.1.0';
var US_CORE_DR_PROFILE      = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab|6.1.0';
var US_CORE_ENCOUNTER       = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter|6.1.0';
var US_CORE_CONDITION       = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis|6.1.0';

var CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
var HTTP_TIMEOUT_MS = 15000;

var PROFILE_BY_TYPE = {
    Patient:          US_CORE_PATIENT_PROFILE,
    Observation:      US_CORE_LAB_OBS_PROFILE,
    DiagnosticReport: US_CORE_DR_PROFILE,
    Encounter:        US_CORE_ENCOUNTER,
    Condition:        US_CORE_CONDITION
};

// === Helpers ===
function sha256Hex(text) {
    var md = java.security.MessageDigest.getInstance('SHA-256');
    var bytes = md.digest(new java.lang.String(text).getBytes('UTF-8'));
    var sb = new java.lang.StringBuilder();
    for (var i = 0; i < bytes.length; i++) {
        var hex = java.lang.Integer.toHexString(0xff & bytes[i]);
        if (hex.length() == 1) sb.append('0');
        sb.append(hex);
    }
    return sb.toString() + '';
}

function cacheGet(key) {
    if (!globalChannelMap.containsKey(key)) return null;
    var raw = globalChannelMap.get(key) + '';
    try {
        var entry = JSON.parse(raw);
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            globalChannelMap.remove(key);
            return null;
        }
        return entry.value;
    } catch (e) { return null; }
}

function cachePut(key, value) {
    globalChannelMap.put(key, JSON.stringify({ ts: Date.now(), value: value }));
}

function httpPost(url, jsonBody) {
    var HC = Packages.org.apache.http.impl.client.HttpClients;
    var RC = Packages.org.apache.http.client.config.RequestConfig;
    var cfg = RC.custom()
        .setConnectTimeout(HTTP_TIMEOUT_MS)
        .setSocketTimeout(HTTP_TIMEOUT_MS)
        .build();
    var client = HC.custom().setDefaultRequestConfig(cfg).build();
    try {
        var post = new Packages.org.apache.http.client.methods.HttpPost(url);
        post.addHeader('Accept', 'application/fhir+json');
        post.addHeader('Content-Type', 'application/fhir+json');
        post.setEntity(new Packages.org.apache.http.entity.StringEntity(jsonBody, 'UTF-8'));
        var resp = client.execute(post);
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

function parseOperationOutcome(body) {
    var errors = [];
    var warnings = [];
    var oo;
    try { oo = JSON.parse(body); }
    catch (e) { return { errors: ['invalid JSON from tx server: ' + e], warnings: [] }; }
    if (oo.resourceType !== 'OperationOutcome' || !oo.issue) {
        return { errors: ['unexpected response: ' + (oo.resourceType || 'no resourceType')], warnings: [] };
    }
    for (var i = 0; i < oo.issue.length; i++) {
        var issue = oo.issue[i];
        var severity = issue.severity || 'information';
        var loc = (issue.location && issue.location.length > 0)
            ? (' @ ' + issue.location.join(','))
            : (issue.expression ? (' @ ' + issue.expression.join(',')) : '');
        var msg = (issue.diagnostics || (issue.details && issue.details.text) || issue.code || 'issue') + loc;
        if (severity === 'fatal' || severity === 'error') errors.push(msg);
        else if (severity === 'warning') warnings.push(msg);
    }
    return { errors: errors, warnings: warnings };
}

function profileForResource(resource) {
    return PROFILE_BY_TYPE[resource.resourceType] || null;
}

function buildParameters(resource, profile) {
    var p = {
        resourceType: 'Parameters',
        parameter: [
            { name: 'resource', resource: resource },
            { name: 'mode', valueCode: 'profile' }
        ]
    };
    if (profile) p.parameter.push({ name: 'profile', valueUri: profile });
    return p;
}

function validateResource(resource) {
    var canon = JSON.stringify(resource);
    var key = 'us-core-val:' + sha256Hex(canon);
    var cached = cacheGet(key);
    if (cached) {
        cached.cacheHit = true;
        return cached;
    }
    var profile = profileForResource(resource);
    var params = buildParameters(resource, profile);
    var res;
    try {
        res = httpPost(TX_ENDPOINT + '/' + resource.resourceType + '/$validate',
                       JSON.stringify(params));
    } catch (e) {
        return { errors: ['tx server unreachable: ' + e], warnings: [], cacheHit: false };
    }
    if (res.status >= 500) {
        return { errors: ['tx server ' + res.status], warnings: [], cacheHit: false };
    }
    var parsed = parseOperationOutcome(res.body);
    parsed.cacheHit = false;
    cachePut(key, parsed);
    return parsed;
}

// === Entry point ===
var bundleStr = channelMap.get('fhirBundle');
if (!bundleStr) {
    channelMap.put('validationValid', 'false');
    channelMap.put('validationErrors', JSON.stringify(['channelMap.fhirBundle is empty']));
    channelMap.put('validationWarnings', JSON.stringify([]));
    return;
}

var input = JSON.parse(bundleStr + '');
var resources = [];
if (input.resourceType === 'Bundle' && input.entry) {
    for (var i = 0; i < input.entry.length; i++) {
        if (input.entry[i].resource) resources.push(input.entry[i].resource);
    }
} else if (input.resourceType) {
    resources.push(input);
}

var allErrors = [];
var allWarnings = [];
var cacheHits = 0;

for (var r = 0; r < resources.length; r++) {
    var verdict = validateResource(resources[r]);
    if (verdict.cacheHit) cacheHits++;
    for (var e = 0; e < verdict.errors.length; e++) {
        allErrors.push(resources[r].resourceType + '/' + (resources[r].id || '?') + ': ' + verdict.errors[e]);
    }
    for (var w = 0; w < verdict.warnings.length; w++) {
        allWarnings.push(resources[r].resourceType + '/' + (resources[r].id || '?') + ': ' + verdict.warnings[w]);
    }
}

var valid = allErrors.length === 0;
channelMap.put('validationValid', valid ? 'true' : 'false');
channelMap.put('validationErrors', JSON.stringify(allErrors));
channelMap.put('validationWarnings', JSON.stringify(allWarnings));
channelMap.put('validationCacheHit', (cacheHits === resources.length && resources.length > 0) ? 'true' : 'false');

logger.info(
    'US Core validation: ' + (valid ? 'PASS' : 'FAIL') +
    ' | resources=' + resources.length +
    ' errors=' + allErrors.length +
    ' warnings=' + allWarnings.length +
    ' cacheHits=' + cacheHits
);
