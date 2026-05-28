/**
 * HL7v2 ORM^O01 -> FHIR R4 ServiceRequest Bundle
 *
 * Maps lab / radiology / other diagnostic orders (ORM^O01) into a FHIR
 * Transaction Bundle suitable for posting to any FHIR R4 server.
 *
 * Input:  HL7v2 ORM^O01 with MSH, PID, ORC, OBR, optional SPM, optional NTE
 * Output: FHIR Transaction Bundle with:
 *           - Patient                  (PID)
 *           - Practitioner             (ORC-12 ordering provider, if present)
 *           - ServiceRequest           (ORC + OBR)
 *           - Specimen                 (SPM, if present)
 *
 * Order control (ORC-1) mapping to ServiceRequest.status:
 *   NW (new)              -> active
 *   OK (accepted)         -> active
 *   CA (cancel)           -> revoked
 *   DC (discontinue)      -> revoked
 *   CM (completed)        -> completed
 *   HD (hold)             -> on-hold
 *   RP (replace)          -> active
 *   RO (replacement-order)-> active
 *
 * Place in: Source Connector -> Transformer -> Add Step -> JavaScript
 *
 * Tested on: Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 / v2.4 inputs
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';
var FHIR_PRACTITIONER_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient';
var US_CORE_PRACTITIONER_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner';
var US_CORE_SERVICEREQUEST_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-servicerequest';

// === Helpers ===
function hl7DateToFhir(hl7ts) {
    if (!hl7ts) return null;
    var s = ('' + hl7ts).replace(/[^\d.+\-]/g, '');
    if (s.length < 8) return s;
    var date = s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
    if (s.length < 14) return date;
    return date + 'T' + s.substring(8, 10) + ':' + s.substring(10, 12) + ':' + s.substring(12, 14) + 'Z';
}

function uuid() {
    return java.util.UUID.randomUUID().toString() + '';
}

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

function mapOrcStatus(orcControl) {
    var map = {
        'NW': 'active',
        'OK': 'active',
        'CA': 'revoked',
        'DC': 'revoked',
        'CM': 'completed',
        'HD': 'on-hold',
        'RP': 'active',
        'RO': 'active',
        'XO': 'revoked',
        'XR': 'active'
    };
    return map[orcControl] || 'unknown';
}

function asArray(node) {
    if (!node) return [];
    return (node.length !== undefined) ? node : [node];
}

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

// === Extract ORC ===
var orcControl     = safeGet(msg, 'ORC.ORC\\.1.ORC\\.1\\.1');
var placerOrderNum = safeGet(msg, 'ORC.ORC\\.2.ORC\\.2\\.1');
var fillerOrderNum = safeGet(msg, 'ORC.ORC\\.3.ORC\\.3\\.1');
var orcDateTime    = safeGet(msg, 'ORC.ORC\\.9.ORC\\.9\\.1');
var ordererId      = safeGet(msg, 'ORC.ORC\\.12.ORC\\.12\\.1');
var ordererLast    = safeGet(msg, 'ORC.ORC\\.12.ORC\\.12\\.2');
var ordererFirst   = safeGet(msg, 'ORC.ORC\\.12.ORC\\.12\\.3');

// === Extract OBR ===
var obrPlacerOrder = safeGet(msg, 'OBR.OBR\\.2.OBR\\.2\\.1') || placerOrderNum;
var obrFillerOrder = safeGet(msg, 'OBR.OBR\\.3.OBR\\.3\\.1') || fillerOrderNum;
var serviceCode    = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.1');
var serviceName    = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.2');
var serviceSystem  = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.3');
var requestedDt    = safeGet(msg, 'OBR.OBR\\.6.OBR\\.6\\.1');
var observationDt  = safeGet(msg, 'OBR.OBR\\.7.OBR\\.7\\.1');
var priority       = safeGet(msg, 'OBR.OBR\\.27.OBR\\.27\\.6');
var diagnosticServSect = safeGet(msg, 'OBR.OBR\\.24.OBR\\.24\\.1');

var serviceCodeSystem = (serviceSystem === 'LN' || serviceSystem === 'LOINC' || serviceSystem === 'L')
    ? 'http://loinc.org'
    : 'http://hospital.local/lab-codes';

var orderId = obrPlacerOrder || obrFillerOrder || uuid();
var serviceRequestId = 'sr-' + orderId.replace(/[^a-zA-Z0-9-]/g, '');

// === Practitioner (ORC-12) ===
var practitioner = null;
var practitionerId = null;
if (ordererId || ordererLast) {
    practitionerId = 'prac-' + (ordererId || uuid().substring(0, 8)).replace(/[^a-zA-Z0-9-]/g, '');
    practitioner = {
        resourceType: 'Practitioner',
        id: practitionerId,
        meta: { profile: [US_CORE_PRACTITIONER_PROFILE] },
        identifier: ordererId ? [{
            use: 'official',
            system: FHIR_PRACTITIONER_SYSTEM,
            value: ordererId
        }] : [],
        name: [{
            use: 'official',
            family: ordererLast || 'Unknown',
            given: ordererFirst ? [ordererFirst] : []
        }]
    };
}

// === Map priority (OBR-27.6) -> FHIR ServiceRequest.priority ===
var priorityMap = { 'S': 'stat', 'A': 'asap', 'R': 'routine', 'P': 'urgent', 'T': 'asap' };
var fhirPriority = priorityMap[priority] || 'routine';

// === Build ServiceRequest ===
var serviceRequest = {
    resourceType: 'ServiceRequest',
    id: serviceRequestId,
    meta: { profile: [US_CORE_SERVICEREQUEST_PROFILE] },
    status: mapOrcStatus(orcControl),
    intent: 'order',
    priority: fhirPriority,
    identifier: [
        obrPlacerOrder ? { use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PLAC' }] }, value: obrPlacerOrder } : null,
        obrFillerOrder ? { use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'FILL' }] }, value: obrFillerOrder } : null
    ].filter(function(x) { return x; }),
    code: {
        coding: [{ system: serviceCodeSystem, code: serviceCode, display: serviceName }],
        text: serviceName
    },
    subject: { reference: 'Patient/' + patientId },
    authoredOn: hl7DateToFhir(orcDateTime || requestedDt),
    occurrenceDateTime: hl7DateToFhir(observationDt || requestedDt)
};

if (diagnosticServSect) {
    serviceRequest.category = [{
        coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
            code: diagnosticServSect
        }]
    }];
}

if (practitionerId) {
    serviceRequest.requester = { reference: 'Practitioner/' + practitionerId };
}

// === Extract SPM (Specimen) ===
var specimen = null;
var specimenId = null;
var spm = msg['SPM'];
if (spm) {
    var spmNode = asArray(spm)[0];
    var specimenTypeCode = safeGet(spmNode, 'SPM\\.4.SPM\\.4\\.1');
    var specimenTypeName = safeGet(spmNode, 'SPM\\.4.SPM\\.4\\.2');
    var specimenCollectDt = safeGet(spmNode, 'SPM\\.17.SPM\\.17\\.1');
    var specimenIdent = safeGet(spmNode, 'SPM\\.2.SPM\\.2\\.1.SPM\\.2\\.1\\.1');

    specimenId = 'spec-' + (specimenIdent || uuid().substring(0, 8)).replace(/[^a-zA-Z0-9-]/g, '');

    specimen = {
        resourceType: 'Specimen',
        id: specimenId,
        identifier: specimenIdent ? [{ system: 'http://hospital.local/specimens', value: specimenIdent }] : [],
        status: 'available',
        type: specimenTypeCode ? {
            coding: [{
                system: 'http://terminology.hl7.org/CodeSystem/v2-0487',
                code: specimenTypeCode,
                display: specimenTypeName
            }],
            text: specimenTypeName
        } : undefined,
        subject: { reference: 'Patient/' + patientId },
        collection: specimenCollectDt ? {
            collectedDateTime: hl7DateToFhir(specimenCollectDt)
        } : undefined
    };

    serviceRequest.specimen = [{ reference: 'Specimen/' + specimenId }];
}

// === Build Bundle ===
var bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: new Date().toISOString(),
    entry: [
        { resource: patient, request: { method: 'PUT', url: 'Patient/' + patientId } }
    ]
};

if (practitioner) {
    bundle.entry.push({
        resource: practitioner,
        request: { method: 'PUT', url: 'Practitioner/' + practitionerId }
    });
}

if (specimen) {
    bundle.entry.push({
        resource: specimen,
        request: { method: 'PUT', url: 'Specimen/' + specimenId }
    });
}

bundle.entry.push({
    resource: serviceRequest,
    request: { method: 'PUT', url: 'ServiceRequest/' + serviceRequestId }
});

// === Channel map for downstream destinations ===
channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('patientId', patientId);
channelMap.put('orderId', orderId);
channelMap.put('serviceRequestId', serviceRequestId);
channelMap.put('orcControl', orcControl);
channelMap.put('fhirStatus', serviceRequest.status);

logger.info(
    'ORM -> FHIR ServiceRequest: Patient=' + firstName + ' ' + lastName +
    ' Order=' + orderId +
    ' ORC-1=' + orcControl + '(' + serviceRequest.status + ')' +
    ' OBR-4=' + serviceCode +
    ' Specimen=' + (specimen ? specimenId : 'none')
);
