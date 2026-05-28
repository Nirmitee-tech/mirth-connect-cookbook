/**
 * Live Terminology Server Validation via tx.fhir.org
 *
 * Calls the HL7 FHIR Public Terminology Server to validate ICD-10, SNOMED CT,
 * LOINC codes and retrieve canonical display names.
 *
 * Use case: enrich Mirth Connect transformer outputs with validated code display
 * names so downstream FHIR servers don't reject your messages on profile validation.
 *
 * REQUIREMENTS:
 *   - Apache HttpClient JARs in custom-lib/ (see ../../code-templates/apache-http-client/)
 *   - Network access from Mirth container to tx.fhir.org
 *
 * Author: Nirmitee.io | License: MIT
 */

var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
var HttpGet = Packages.org.apache.http.client.methods.HttpGet;
var EntityUtils = Packages.org.apache.http.util.EntityUtils;
var RequestConfig = Packages.org.apache.http.client.config.RequestConfig;

var TX_SERVER_BASE = 'https://tx.fhir.org/r4';
var TIMEOUT_MS = 8000;

/**
 * Validate a code against a FHIR code system.
 * @param {string} system - FHIR canonical URL (e.g. http://hl7.org/fhir/sid/icd-10-cm)
 * @param {string} code - the code to validate
 * @returns {{validated: boolean, display: string, version: string}}
 */
function validateCode(system, code) {
    var result = { validated: false, display: '', version: '' };

    if (!system || !code) return result;

    try {
        var url = TX_SERVER_BASE + '/CodeSystem/$lookup' +
                  '?system=' + java.net.URLEncoder.encode(system, 'UTF-8') +
                  '&code=' + java.net.URLEncoder.encode(code, 'UTF-8');

        var config = RequestConfig.custom()
            .setConnectTimeout(TIMEOUT_MS)
            .setSocketTimeout(TIMEOUT_MS)
            .build();

        var client = HttpClients.createDefault();
        var request = new HttpGet(url);
        request.setConfig(config);
        request.addHeader('Accept', 'application/fhir+json');

        var response = null;
        try {
            response = client.execute(request);
            var status = response.getStatusLine().getStatusCode();

            if (status === 200) {
                var body = EntityUtils.toString(response.getEntity(), 'UTF-8');
                var data = JSON.parse(body);
                var params = data.parameter || [];

                for (var i = 0; i < params.length; i++) {
                    if (params[i].name === 'display') result.display = params[i].valueString;
                    if (params[i].name === 'version') result.version = params[i].valueString;
                }
                result.validated = true;
            }
        } finally {
            if (response != null) response.close();
            client.close();
        }
    } catch (e) {
        logger.warn('TX server error for ' + system + '|' + code + ': ' + e);
    }

    return result;
}

// Convenience shortcuts
function validateICD10(code) {
    return validateCode('http://hl7.org/fhir/sid/icd-10-cm', code);
}

function validateSNOMED(code) {
    return validateCode('http://snomed.info/sct', code);
}

function validateLOINC(code) {
    return validateCode('http://loinc.org', code);
}

function validateRxNorm(code) {
    return validateCode('http://www.nlm.nih.gov/research/umls/rxnorm', code);
}

/**
 * Example usage in a Mirth transformer:
 *
 *   var dx = msg['DG1']['DG1.3']['DG1.3.1'].toString();
 *   var dxDesc = msg['DG1']['DG1.3']['DG1.3.2'].toString();
 *   var tx = validateICD10(dx);
 *
 *   // Use TX-validated display if available, fall back to HL7 description
 *   var canonicalDisplay = tx.validated ? tx.display : dxDesc;
 *
 *   var condition = {
 *       resourceType: 'Condition',
 *       code: {
 *           coding: [{
 *               system: 'http://hl7.org/fhir/sid/icd-10-cm',
 *               code: dx,
 *               display: canonicalDisplay,
 *               version: tx.version  // e.g. "2026"
 *           }],
 *           text: canonicalDisplay
 *       }
 *   };
 *
 * PRODUCTION TIPS:
 * - Cache validated codes in globalChannelMap to avoid repeated network calls
 * - Set a per-message timeout budget (TX calls should be <500ms total)
 * - Fail open: if TX server is down, use the HL7 description and log a warning
 * - Don't validate every code on every message in high-throughput channels
 *   (10K msg/sec × 200ms TX latency = 33 minutes of cumulative wait)
 */
