/**
 * SOAP/WSDL Listener — getPatient → FHIR Patient (XML)
 *
 * Mirth's Web Service Listener exposes a JAX-WS endpoint with a generated
 * WSDL. This transformer:
 *   1. Parses the incoming SOAP envelope (already de-enveloped by Mirth
 *      into `msg` as an E4X XML object).
 *   2. Extracts patientId from <getPatientRequest><patientId>...
 *   3. Calls the backend FHIR API (FHIR server, or another Mirth channel
 *      via VMRouter) to fetch a Patient resource.
 *   4. Wraps the Patient as XML inside a <getPatientResponse> SOAP body
 *      and writes it to channelMap.responseBody.
 *   5. On error, writes a SOAP Fault envelope, not a 500-page.
 *
 * Use case:
 *   Legacy hospital portals (Java applets, .NET WinForms, classic ASP)
 *   still talk SOAP. The modern EHR runs FHIR REST. Mirth bridges both.
 *
 *   [Legacy portal] ──SOAP──► [Mirth] ──HTTP/FHIR──► [Modern EHR]
 *
 * Source connector (Mirth Administrator → Source → Web Service Listener):
 *   - Listener address: 0.0.0.0
 *   - Listener port:    8089
 *   - Service name:     PatientService
 *   - Class:            com.mirth.connect.connectors.ws.DefaultAcceptMessage
 *     (Mirth ships this — exposes a single 'acceptMessage(String)' op.
 *      For a richer WSDL, write a custom JAX-WS impl JAR. See README.)
 *
 * Place in: Channel → Source → Transformer
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// Configurable backend
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : null;
var BACKEND_FHIR_BASE = (cfg && cfg.get('backend.fhir.base')) || 'http://localhost:8089/fhir';
var BACKEND_TIMEOUT_MS = parseInt((cfg && cfg.get('backend.timeout.ms')) || '10000', 10);
var SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
var APP_NS  = 'http://nirmitee.io/ws/patient';

// =====================================================================
// HELPERS
// =====================================================================

/**
 * Extract an XML element's text content by local name, scanning the
 * SOAP body. Returns '' if not found. Works with both E4X XML objects
 * and raw XML strings (we coerce to string for robustness).
 */
function extractText(xmlStr, localName) {
    if (!xmlStr) return '';
    var s = '' + xmlStr;
    // Tolerates namespace prefixes like ns2:patientId
    var re = new RegExp('<([\\w-]+:)?' + localName + '[^>]*>([\\s\\S]*?)</([\\w-]+:)?' + localName + '>');
    var m = s.match(re);
    return m ? m[2].trim() : '';
}

/**
 * Escape text for safe insertion into XML (no double-encoding of attrs).
 */
function escXml(s) {
    return ('' + (s == null ? '' : s))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build a SOAP envelope wrapping the given body element string.
 */
function soapEnvelope(bodyInnerXml) {
    return '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soap:Envelope xmlns:soap="' + SOAP_NS + '" xmlns:p="' + APP_NS + '">' +
        '<soap:Body>' + bodyInnerXml + '</soap:Body>' +
        '</soap:Envelope>';
}

/**
 * Build a SOAP Fault envelope. faultCode is one of:
 *   'Client' (4xx-like) | 'Server' (5xx-like)
 */
function soapFault(faultCode, message, appCode) {
    var faultInner =
        '<soap:Fault>' +
            '<faultcode>soap:' + escXml(faultCode) + '</faultcode>' +
            '<faultstring>' + escXml(message) + '</faultstring>' +
            '<detail>' +
                '<p:patientFault>' +
                    '<p:code>' + escXml(appCode || faultCode) + '</p:code>' +
                    '<p:message>' + escXml(message) + '</p:message>' +
                '</p:patientFault>' +
            '</detail>' +
        '</soap:Fault>';
    return soapEnvelope(faultInner);
}

/**
 * HTTP GET against the backend FHIR server.
 * Returns {status, body} — body parsed as JSON if Content-Type allows.
 */
function fetchFhir(url) {
    var client = null, resp = null;
    try {
        var cfgBuilder = Packages.org.apache.http.client.config.RequestConfig.custom()
            .setConnectTimeout(BACKEND_TIMEOUT_MS)
            .setSocketTimeout(BACKEND_TIMEOUT_MS);
        client = Packages.org.apache.http.impl.client.HttpClients.custom()
            .setDefaultRequestConfig(cfgBuilder.build())
            .build();
        var req = new Packages.org.apache.http.client.methods.HttpGet(url);
        req.addHeader('Accept', 'application/fhir+json');
        resp = client.execute(req);
        var status = resp.getStatusLine().getStatusCode();
        var bodyStr = '' + Packages.org.apache.http.util.EntityUtils.toString(resp.getEntity(), 'UTF-8');
        var body = null;
        try { body = JSON.parse(bodyStr); } catch (e) { body = bodyStr; }
        return { status: status, body: body };
    } finally {
        try { if (resp)   resp.close();   } catch (e) {}
        try { if (client) client.close(); } catch (e) {}
    }
}

/**
 * Render a FHIR R4 Patient JSON resource as an XML fragment using the
 * official FHIR XML representation (resourceType is implicit, element
 * names match the JSON keys; values use the `value` attribute).
 *
 * This is enough for downstream SOAP consumers and avoids dragging in
 * HAPI just for serialization. For full FHIR XML fidelity (with the
 * official namespaces and extensions), use HAPI's XmlParser in a custom
 * JAR — left out here to keep the recipe dependency-free.
 */
function patientToFhirXml(p) {
    if (!p || p.resourceType !== 'Patient') return '';
    var parts = ['<Patient xmlns="http://hl7.org/fhir">'];
    parts.push('<id value="' + escXml(p.id) + '"/>');
    if (p.active !== undefined) parts.push('<active value="' + (p.active ? 'true' : 'false') + '"/>');
    if (p.identifier && p.identifier.length) {
        for (var i = 0; i < p.identifier.length; i++) {
            var idn = p.identifier[i];
            parts.push('<identifier>');
            if (idn.system) parts.push('<system value="' + escXml(idn.system) + '"/>');
            if (idn.value)  parts.push('<value value="' + escXml(idn.value) + '"/>');
            parts.push('</identifier>');
        }
    }
    if (p.name && p.name.length) {
        for (var n = 0; n < p.name.length; n++) {
            var nm = p.name[n];
            parts.push('<name>');
            if (nm.family) parts.push('<family value="' + escXml(nm.family) + '"/>');
            if (nm.given) for (var g = 0; g < nm.given.length; g++) {
                parts.push('<given value="' + escXml(nm.given[g]) + '"/>');
            }
            parts.push('</name>');
        }
    }
    if (p.gender)    parts.push('<gender value="'    + escXml(p.gender) + '"/>');
    if (p.birthDate) parts.push('<birthDate value="' + escXml(p.birthDate) + '"/>');
    parts.push('</Patient>');
    return parts.join('');
}

// =====================================================================
// MAIN
// =====================================================================

var requestXml = '' + (msg || '');
logger.info('SOAP request received (' + requestXml.length + ' bytes)');

var patientId = extractText(requestXml, 'patientId');
var responseXml;
var httpStatus = 200;

if (!patientId) {
    responseXml = soapFault('Client', 'patientId is required', 'INVALID_REQUEST');
    httpStatus = 400;
} else {
    try {
        var fhirResp = fetchFhir(BACKEND_FHIR_BASE + '/Patient/' + encodeURIComponent(patientId));

        if (fhirResp.status === 200 && fhirResp.body && fhirResp.body.resourceType === 'Patient') {
            var patientXml = patientToFhirXml(fhirResp.body);
            responseXml = soapEnvelope(
                '<p:getPatientResponse><p:patient>' + patientXml + '</p:patient></p:getPatientResponse>'
            );
            httpStatus = 200;
        } else if (fhirResp.status === 404) {
            responseXml = soapFault('Client', 'Patient ' + patientId + ' not found', 'NOT_FOUND');
            httpStatus = 404;
        } else {
            responseXml = soapFault('Server',
                'Backend returned ' + fhirResp.status,
                'BACKEND_ERROR');
            httpStatus = 502;
        }
    } catch (e) {
        logger.error('SOAP getPatient failed: ' + e);
        responseXml = soapFault('Server', 'Internal error: ' + e, 'INTERNAL_ERROR');
        httpStatus = 500;
    }
}

channelMap.put('responseBody',         responseXml);
channelMap.put('responseContentType',  'text/xml; charset=utf-8');
channelMap.put('responseStatusCode',   httpStatus);
channelMap.put('soapSummary', JSON.stringify({
    patientId: patientId,
    status: httpStatus,
    bytes: responseXml.length
}));

logger.info('SOAP getPatient(' + patientId + ') → ' + httpStatus);

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        extractText: extractText,
        soapEnvelope: soapEnvelope,
        soapFault: soapFault,
        patientToFhirXml: patientToFhirXml
    };
}
