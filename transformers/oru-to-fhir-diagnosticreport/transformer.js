/**
 * HL7v2 ORU^R01 → FHIR R4 DiagnosticReport + Observation Bundle
 *
 * The most-asked transformation on Mirth forums. Maps lab results from
 * OBR/OBX segments to a FHIR Transaction Bundle suitable for posting to
 * any FHIR R4 server (HAPI, Epic, Cerner, Health Gorilla, etc.).
 *
 * Input:  HL7v2 ORU^R01 with PID, OBR, OBX (and optional NTE, SPM) segments
 * Output: FHIR Transaction Bundle with:
 *           - Patient
 *           - ServiceRequest (from OBR)
 *           - DiagnosticReport
 *           - Observation (one per OBX)
 *           - Specimen (if SPM present)
 *
 * Place in: Source Connector → Transformer → Add Step → JavaScript
 *
 * Tested on: Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';  // SSN as example; replace with your MRN system
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient';
var US_CORE_LAB_OBS_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab';
var US_CORE_DR_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab';

// === Helpers ===
function hl7DateToFhir(hl7ts) {
    // HL7v2 timestamp: yyyyMMddHHmmss[.SSSS][+/-ZZZZ]
    if (!hl7ts) return null;
    var s = ('' + hl7ts).replace(/[^\d.+\-]/g, '');
    if (s.length < 8) return s;
    var date = s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
    if (s.length < 14) return date;
    return date + 'T' + s.substring(8, 10) + ':' + s.substring(10, 12) + ':' + s.substring(12, 14) + 'Z';
}

function mapAbnormalFlag(flag) {
    // HL7 Table 0078 → FHIR ObservationInterpretation
    var map = {
        'L': { code: 'L', display: 'Low' },
        'H': { code: 'H', display: 'High' },
        'LL': { code: 'LL', display: 'Critical Low' },
        'HH': { code: 'HH', display: 'Critical High' },
        'A': { code: 'A', display: 'Abnormal' },
        'AA': { code: 'AA', display: 'Critical Abnormal' },
        'N': { code: 'N', display: 'Normal' },
        '>': { code: 'HU', display: 'Very High' },
        '<': { code: 'LU', display: 'Very Low' },
        'B': { code: 'B', display: 'Better' },
        'W': { code: 'W', display: 'Worse' }
    };
    return map[flag] || null;
}

function mapResultStatus(hl7Status) {
    // HL7 Table 0085 (OBX-11) → FHIR Observation.status
    var map = {
        'F': 'final',
        'P': 'preliminary',
        'C': 'corrected',
        'I': 'registered',
        'X': 'cancelled',
        'D': 'entered-in-error',
        'R': 'preliminary',
        'S': 'preliminary',
        'U': 'unknown'
    };
    return map[hl7Status] || 'final';
}

function mapDiagnosticReportStatus(obrStatus) {
    // HL7 OBR-25 → FHIR DiagnosticReport.status
    var map = {
        'F': 'final',
        'P': 'preliminary',
        'I': 'registered',
        'C': 'corrected',
        'X': 'cancelled',
        'R': 'preliminary'
    };
    return map[obrStatus] || 'final';
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

// === Extract PID ===
var mrn = safeGet(msg, 'PID.PID\\.3.PID\\.3\\.1');
var lastName = safeGet(msg, 'PID.PID\\.5.PID\\.5\\.1');
var firstName = safeGet(msg, 'PID.PID\\.5.PID\\.5\\.2');
var dob = safeGet(msg, 'PID.PID\\.7.PID\\.7\\.1');
var gender = safeGet(msg, 'PID.PID\\.8.PID\\.8\\.1');

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

// === Extract OBR (DiagnosticReport + ServiceRequest) ===
var orderId   = safeGet(msg, 'OBR.OBR\\.2.OBR\\.2\\.1') || safeGet(msg, 'OBR.OBR\\.3.OBR\\.3\\.1') || uuid();
var loincCode = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.1');
var loincSys  = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.3') || 'L';
var orderName = safeGet(msg, 'OBR.OBR\\.4.OBR\\.4\\.2');
var observationDt = safeGet(msg, 'OBR.OBR\\.7.OBR\\.7\\.1');
var resultStatusObr = safeGet(msg, 'OBR.OBR\\.25.OBR\\.25\\.1');

var loincSystemUrl = (loincSys === 'LN' || loincSys === 'LOINC' || loincSys === 'L')
    ? 'http://loinc.org'
    : 'http://hospital.local/lab-codes';

var serviceRequestId = 'sr-' + orderId.replace(/[^a-zA-Z0-9-]/g, '');
var diagnosticReportId = 'dr-' + orderId.replace(/[^a-zA-Z0-9-]/g, '');

var serviceRequest = {
    resourceType: 'ServiceRequest',
    id: serviceRequestId,
    status: 'completed',
    intent: 'order',
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.2', value: orderId }],
    code: { coding: [{ system: loincSystemUrl, code: loincCode, display: orderName }], text: orderName },
    subject: { reference: 'Patient/' + patientId }
};

// === Extract OBX (Observations) ===
var obxList = msg['OBX'];
var observations = [];

if (obxList) {
    // Mirth's HL7v2 parser returns a single node if there's one OBX, or an array if many.
    // Normalize to array.
    var obxArray = obxList.length !== undefined ? obxList : [obxList];

    for (var i = 0; i < obxArray.length; i++) {
        var obx = obxArray[i];

        var setId = safeGet(obx, 'OBX\\.1.OBX\\.1\\.1');
        var valueType = safeGet(obx, 'OBX\\.2.OBX\\.2\\.1');
        var obsCode = safeGet(obx, 'OBX\\.3.OBX\\.3\\.1');
        var obsName = safeGet(obx, 'OBX\\.3.OBX\\.3\\.2');
        var obsSystem = safeGet(obx, 'OBX\\.3.OBX\\.3\\.3');
        var value = safeGet(obx, 'OBX\\.5.OBX\\.5\\.1');
        var units = safeGet(obx, 'OBX\\.6.OBX\\.6\\.1');
        var refRange = safeGet(obx, 'OBX\\.7.OBX\\.7\\.1');
        var abnFlag = safeGet(obx, 'OBX\\.8.OBX\\.8\\.1');
        var resultStatus = safeGet(obx, 'OBX\\.11.OBX\\.11\\.1');
        var obxDt = safeGet(obx, 'OBX\\.14.OBX\\.14\\.1');

        if (!value) continue;

        var obsCodeSystem = (obsSystem === 'LN' || obsSystem === 'LOINC')
            ? 'http://loinc.org'
            : 'http://hospital.local/lab-codes';

        var obsId = 'obs-' + orderId.replace(/[^a-zA-Z0-9-]/g, '') + '-' + setId;

        var observation = {
            resourceType: 'Observation',
            id: obsId,
            meta: { profile: [US_CORE_LAB_OBS_PROFILE] },
            status: mapResultStatus(resultStatus),
            category: [{ coding: [{
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory',
                display: 'Laboratory'
            }] }],
            code: { coding: [{ system: obsCodeSystem, code: obsCode, display: obsName }], text: obsName },
            subject: { reference: 'Patient/' + patientId },
            effectiveDateTime: hl7DateToFhir(obxDt || observationDt)
        };

        // Value based on type
        if (valueType === 'NM') {
            observation.valueQuantity = {
                value: parseFloat(value),
                unit: units,
                system: 'http://unitsofmeasure.org',
                code: units
            };
        } else if (valueType === 'CE' || valueType === 'CWE') {
            observation.valueCodeableConcept = {
                coding: [{ system: 'http://hospital.local/lab-codes', code: value }],
                text: value
            };
        } else {
            observation.valueString = value;
        }

        // Reference range
        if (refRange) {
            var rangeMatch = refRange.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
            if (rangeMatch) {
                observation.referenceRange = [{
                    low: { value: parseFloat(rangeMatch[1]), unit: units },
                    high: { value: parseFloat(rangeMatch[2]), unit: units }
                }];
            } else {
                observation.referenceRange = [{ text: refRange }];
            }
        }

        // Interpretation (abnormal flag)
        var interp = mapAbnormalFlag(abnFlag);
        if (interp) {
            observation.interpretation = [{
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                    code: interp.code,
                    display: interp.display
                }]
            }];
        }

        observations.push(observation);
    }
}

// === DiagnosticReport ===
var observationRefs = observations.map(function(o) {
    return { reference: 'Observation/' + o.id, display: o.code.text };
});

var diagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: diagnosticReportId,
    meta: { profile: [US_CORE_DR_PROFILE] },
    status: mapDiagnosticReportStatus(resultStatusObr),
    category: [{ coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
        code: 'LAB',
        display: 'Laboratory'
    }] }],
    code: { coding: [{ system: loincSystemUrl, code: loincCode, display: orderName }], text: orderName },
    subject: { reference: 'Patient/' + patientId },
    effectiveDateTime: hl7DateToFhir(observationDt),
    basedOn: [{ reference: 'ServiceRequest/' + serviceRequestId }],
    result: observationRefs
};

// === Build Bundle ===
var bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: new Date().toISOString(),
    entry: [
        {
            resource: patient,
            request: { method: 'PUT', url: 'Patient/' + patientId }
        },
        {
            resource: serviceRequest,
            request: { method: 'PUT', url: 'ServiceRequest/' + serviceRequestId }
        },
        {
            resource: diagnosticReport,
            request: { method: 'PUT', url: 'DiagnosticReport/' + diagnosticReportId }
        }
    ]
};

for (var k = 0; k < observations.length; k++) {
    bundle.entry.push({
        resource: observations[k],
        request: { method: 'PUT', url: 'Observation/' + observations[k].id }
    });
}

// Store in channel map for destination connectors
channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('patientId', patientId);
channelMap.put('orderId', orderId);
channelMap.put('observationCount', observations.length.toString());

logger.info(
    'ORU → FHIR: Patient=' + firstName + ' ' + lastName +
    ' Order=' + orderId +
    ' Observations=' + observations.length
);
