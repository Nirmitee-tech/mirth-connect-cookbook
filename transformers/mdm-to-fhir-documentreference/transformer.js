/**
 * HL7v2 MDM^T02/T04/T08 -> FHIR R4 DocumentReference + Binary Bundle
 *
 * Maps Medical Document Management messages to a FHIR Transaction Bundle.
 *   T02 -- Original document notification + content -> current
 *   T04 -- Pre-document available                    -> preliminary
 *   T08 -- Document edit notification                -> replaces previous version
 *
 * Input segments:
 *   MSH -- trigger event
 *   EVN -- event timestamp
 *   PID -- patient
 *   TXA -- document metadata (type, status, dates, doc ID)
 *   OBX -- document content (one or more, type TX/FT/ED). Concatenated and
 *          base64-encoded into a single Binary resource.
 *
 * Output: FHIR Transaction Bundle:
 *   - Patient
 *   - Binary           (concatenated OBX content, base64)
 *   - DocumentReference linking to the Binary
 *
 * Place in: Source Connector -> Transformer -> Add Step -> JavaScript
 *
 * Tested on: Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient';
var US_CORE_DOCREF_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-documentreference';
var DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';

// === Helpers ===
function hl7DateToFhir(hl7ts) {
    if (!hl7ts) return null;
    var s = ('' + hl7ts).replace(/[^\d.+\-]/g, '');
    if (s.length < 8) return s;
    var date = s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
    if (s.length < 14) return date;
    return date + 'T' + s.substring(8, 10) + ':' + s.substring(10, 12) + ':' + s.substring(12, 14) + 'Z';
}

function uuid() { return java.util.UUID.randomUUID().toString() + ''; }

function safeGet(node, path) {
    try {
        var parts = path.split('.');
        var current = node;
        for (var i = 0; i < parts.length; i++) {
            if (current === null || current === undefined) return '';
            current = current[parts[i]];
        }
        return current === null || current === undefined ? '' : current.toString();
    } catch (e) { return ''; }
}

function asArray(node) {
    if (!node) return [];
    return (node.length !== undefined) ? node : [node];
}

// Java Base64 -- Mirth's Rhino exposes java.util.Base64. We probe by name
// so the Node-based unit tests can exercise the function via Buffer.
function base64Encode(str) {
    if (typeof java !== 'undefined' && java && java.lang && java.lang.String) {
        var bytes = new java.lang.String(str).getBytes('UTF-8');
        return java.util.Base64.getEncoder().encodeToString(bytes) + '';
    }
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(str, 'utf8').toString('base64');
    }
    throw new Error('No base64 encoder available');
}

function mapEventToStatus(eventCode) {
    var map = {
        'T02': { docStatus: 'final',        refStatus: 'current' },
        'T04': { docStatus: 'preliminary',  refStatus: 'current' },
        'T08': { docStatus: 'final',        refStatus: 'current' }   // edit -> replaces previous
    };
    return map[eventCode] || { docStatus: 'final', refStatus: 'current' };
}

function mapTxaStatus(txa17) {
    // HL7 Table 0271 (TXA-17 Document Completion Status)
    var map = {
        'DI': 'preliminary',  // Dictated
        'DO': 'preliminary',  // Documented
        'IP': 'preliminary',  // In Progress
        'AU': 'final',        // Authenticated
        'LA': 'amended',      // Legally Authenticated
        'PA': 'preliminary',  // Pre-authenticated
        'CA': 'entered-in-error', // Cancelled
        'UN': 'preliminary'   // Unknown
    };
    return map[txa17] || null;
}

// === Extract MSH ===
var triggerEvent = safeGet(msg, 'MSH.MSH\\.9.MSH\\.9\\.2');
var statusInfo = mapEventToStatus(triggerEvent);

// === Extract PID ===
var mrn       = safeGet(msg, 'PID.PID\\.3.PID\\.3\\.1');
var lastName  = safeGet(msg, 'PID.PID\\.5.PID\\.5\\.1');
var firstName = safeGet(msg, 'PID.PID\\.5.PID\\.5\\.2');
var dob       = safeGet(msg, 'PID.PID\\.7.PID\\.7\\.1');
var gender    = safeGet(msg, 'PID.PID\\.8.PID\\.8\\.1');

var genderMap = { 'M': 'male', 'F': 'female', 'O': 'other', 'U': 'unknown' };
var fhirGender = genderMap[gender] || 'unknown';
var patientId = mrn || ('PAT-' + uuid().substring(0, 8));

var patient = {
    resourceType: 'Patient',
    id: patientId,
    meta: { profile: [US_CORE_PATIENT_PROFILE] },
    identifier: [{
        use: 'usual',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
        system: FHIR_PATIENT_SYSTEM,
        value: mrn
    }],
    active: true,
    name: [{ use: 'official', family: lastName, given: firstName ? [firstName] : [] }],
    gender: fhirGender,
    birthDate: dob.length >= 8 ? dob.substring(0,4)+'-'+dob.substring(4,6)+'-'+dob.substring(6,8) : null
};

// === Extract TXA ===
var docTypeCode      = safeGet(msg, 'TXA.TXA\\.2.TXA\\.2\\.1');
var docTypeName      = safeGet(msg, 'TXA.TXA\\.2.TXA\\.2\\.2');
var docContentPresentation = safeGet(msg, 'TXA.TXA\\.3.TXA\\.3\\.1');
var docActivityDt    = safeGet(msg, 'TXA.TXA\\.4.TXA\\.4\\.1');
var docOriginationDt = safeGet(msg, 'TXA.TXA\\.6.TXA\\.6\\.1');
var docFilerLast     = safeGet(msg, 'TXA.TXA\\.9.TXA\\.9\\.2');
var docFilerFirst    = safeGet(msg, 'TXA.TXA\\.9.TXA\\.9\\.3');
var docUniqueId      = safeGet(msg, 'TXA.TXA\\.12.TXA\\.12\\.1');
var docConfidentiality = safeGet(msg, 'TXA.TXA\\.13.TXA\\.13\\.1');
var docCompletionStatus = safeGet(msg, 'TXA.TXA\\.17.TXA\\.17\\.1');

// Per-TXA override of doc status if TXA-17 set; else default by event
var docStatus = mapTxaStatus(docCompletionStatus) || statusInfo.docStatus;
var refStatus = statusInfo.refStatus;

var documentId = docUniqueId || uuid();
var documentReferenceId = 'docref-' + documentId.replace(/[^a-zA-Z0-9-]/g, '');
var binaryId = 'bin-' + documentId.replace(/[^a-zA-Z0-9-]/g, '');

// === Concatenate OBX content ===
var obxContent = '';
var obxList = asArray(msg['OBX']);
var obxTypes = [];

for (var i = 0; i < obxList.length; i++) {
    var obx = obxList[i];
    var valueType = safeGet(obx, 'OBX\\.2.OBX\\.2\\.1');
    if (valueType !== 'TX' && valueType !== 'FT' && valueType !== 'ED' && valueType !== 'ST') continue;
    obxTypes.push(valueType);

    // For TX/FT/ST, value is in OBX-5.1. For ED (encapsulated data), the
    // base64 payload is in OBX-5.5; just pass it through.
    if (valueType === 'ED') {
        var edData = safeGet(obx, 'OBX\\.5.OBX\\.5\\.5');
        if (edData) {
            obxContent += edData;
            continue;
        }
    }

    var val = safeGet(obx, 'OBX\\.5.OBX\\.5\\.1');
    if (val) {
        if (obxContent.length > 0) obxContent += '\n';
        obxContent += val;
    }
}

// Most OBX values arrive escaped (\.br\, \X0D\, etc.). Translate the common ones.
obxContent = obxContent
    .replace(/\\.br\\/g, '\n')
    .replace(/\\X0D\\/g, '\n')
    .replace(/\\X0A\\/g, '\n')
    .replace(/\\F\\/g, '|')
    .replace(/\\S\\/g, '^')
    .replace(/\\T\\/g, '&')
    .replace(/\\R\\/g, '~')
    .replace(/\\E\\/g, '\\');

var hadEdSegment = obxTypes.indexOf('ED') !== -1;
var contentType = hadEdSegment ? 'application/octet-stream' : DEFAULT_CONTENT_TYPE;
var encodedContent = hadEdSegment ? obxContent : base64Encode(obxContent);

// === Build Binary ===
var binary = {
    resourceType: 'Binary',
    id: binaryId,
    contentType: contentType,
    data: encodedContent
};

// === Build DocumentReference ===
var documentReference = {
    resourceType: 'DocumentReference',
    id: documentReferenceId,
    meta: { profile: [US_CORE_DOCREF_PROFILE] },
    masterIdentifier: { system: 'http://hospital.local/documents', value: documentId },
    identifier: [{ system: 'http://hospital.local/documents', value: documentId }],
    status: refStatus,
    docStatus: docStatus,
    type: {
        coding: [{
            system: 'http://loinc.org',
            code: docTypeCode,
            display: docTypeName
        }],
        text: docTypeName
    },
    subject: { reference: 'Patient/' + patientId },
    date: hl7DateToFhir(docActivityDt || docOriginationDt) || new Date().toISOString(),
    author: (docFilerLast || docFilerFirst) ? [{
        display: ((docFilerFirst || '') + ' ' + (docFilerLast || '')).trim()
    }] : undefined,
    securityLabel: docConfidentiality ? [{
        coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
            code: docConfidentiality
        }]
    }] : undefined,
    content: [{
        attachment: {
            contentType: contentType,
            url: 'Binary/' + binaryId,
            title: docTypeName || documentId,
            creation: hl7DateToFhir(docOriginationDt || docActivityDt)
        }
    }]
};

// T08 -> mark relatesTo (replaces) the previous version. We don't know the
// previous DocumentReference ID from this single message, so we record the
// document master identifier as the link target.
if (triggerEvent === 'T08') {
    documentReference.relatesTo = [{
        code: 'replaces',
        target: {
            identifier: { system: 'http://hospital.local/documents', value: documentId },
            display: 'Previous version of document ' + documentId
        }
    }];
}

// === Build Bundle ===
var bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: new Date().toISOString(),
    entry: [
        { resource: patient,           request: { method: 'PUT', url: 'Patient/' + patientId } },
        { resource: binary,            request: { method: 'PUT', url: 'Binary/' + binaryId } },
        { resource: documentReference, request: { method: 'PUT', url: 'DocumentReference/' + documentReferenceId } }
    ]
};

// === Channel map ===
channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('patientId', patientId);
channelMap.put('documentReferenceId', documentReferenceId);
channelMap.put('binaryId', binaryId);
channelMap.put('triggerEvent', triggerEvent);
channelMap.put('docStatus', docStatus);
channelMap.put('refStatus', refStatus);
channelMap.put('obxSegmentsConsumed', obxList.length.toString());

logger.info(
    'MDM^' + triggerEvent + ' -> FHIR DocumentReference: id=' + documentReferenceId +
    ' refStatus=' + refStatus + ' docStatus=' + docStatus +
    ' typeCode=' + docTypeCode +
    ' contentBytes=' + (encodedContent ? encodedContent.length : 0) +
    ' obxSegments=' + obxList.length
);
