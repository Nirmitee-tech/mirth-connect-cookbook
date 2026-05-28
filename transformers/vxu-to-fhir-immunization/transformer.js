/**
 * HL7v2 VXU^V04 -> FHIR R4 Immunization Bundle
 *
 * Maps Immunization Update messages to FHIR Immunization resources -- one
 * per RXA segment. OBX segments after RXA carry education / observation /
 * adverse-reaction details and are attached to the preceding RXA's
 * Immunization.
 *
 * Input segments:
 *   MSH, PID, NK1*, PV1?, ORC, RXA, RXR?, OBX*
 *
 * Output: FHIR Transaction Bundle:
 *   - Patient
 *   - Immunization     (one per RXA)
 *
 * Code system: RXA-5 vaccine codes use CVX (CDC), mapped to
 *   http://hl7.org/fhir/sid/cvx
 *
 * Place in: Source Connector -> Transformer -> Add Step -> JavaScript
 *
 * Tested on: Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient';
var US_CORE_IMMUNIZATION_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-immunization';
var CVX_SYSTEM = 'http://hl7.org/fhir/sid/cvx';
var MVX_SYSTEM = 'http://hl7.org/fhir/sid/mvx';

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

function safeNode(node, key) {
    try {
        var v = node[key];
        return v === null || v === undefined ? null : v;
    } catch (e) { return null; }
}

function asArray(node) {
    if (!node) return [];
    return (node.length !== undefined) ? node : [node];
}

function mapCompletionStatus(rxa20) {
    // HL7 Table 0322 (Completion Status, RXA-20) -> Immunization.status
    var map = {
        'CP': 'completed',
        'RE': 'not-done',  // Refused
        'NA': 'not-done',  // Not Administered
        'PA': 'completed'  // Partially Administered
    };
    return map[rxa20] || 'completed';
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

// === Walk RXA / RXR / OBX in order ===
//
// In v2 ER7 messages, segments arrive in document order. Mirth's parser
// surfaces them as named arrays at the top level. We use the position-aware
// walker on the raw segments to associate OBX/RXR with the preceding RXA.
//
// Strategy: extract all RXA nodes and all OBX nodes; for each OBX, look at
// OBX-4 (observation sub-id) which conventionally indexes the parent RXA
// (1-based). If OBX-4 is empty, OBX is grouped with the most recent RXA.

var rxaList = asArray(msg['RXA']);
var rxrList = asArray(msg['RXR']);
var obxList = asArray(msg['OBX']);

var immunizations = [];

for (var r = 0; r < rxaList.length; r++) {
    var rxa = rxaList[r];

    var giveSubId        = safeGet(rxa, 'RXA\\.1.RXA\\.1\\.1');
    var adminSubId       = safeGet(rxa, 'RXA\\.2.RXA\\.2\\.1');
    var adminStartDt     = safeGet(rxa, 'RXA\\.3.RXA\\.3\\.1');
    var vaccineCvx       = safeGet(rxa, 'RXA\\.5.RXA\\.5\\.1');
    var vaccineName      = safeGet(rxa, 'RXA\\.5.RXA\\.5\\.2');
    var vaccineCodeSys   = safeGet(rxa, 'RXA\\.5.RXA\\.5\\.3') || 'CVX';
    var administeredAmt  = safeGet(rxa, 'RXA\\.6.RXA\\.6\\.1');
    var administeredUnit = safeGet(rxa, 'RXA\\.7.RXA\\.7\\.1');
    var lotNumber        = safeGet(rxa, 'RXA\\.15.RXA\\.15\\.1');
    var expirationDate   = safeGet(rxa, 'RXA\\.16.RXA\\.16\\.1');
    var mvxCode          = safeGet(rxa, 'RXA\\.17.RXA\\.17\\.1');
    var mvxName          = safeGet(rxa, 'RXA\\.17.RXA\\.17\\.2');
    var completionStatus = safeGet(rxa, 'RXA\\.20.RXA\\.20\\.1');
    var actionCode       = safeGet(rxa, 'RXA\\.21.RXA\\.21\\.1');

    var immunizationId = 'imm-' + (lotNumber || (giveSubId + '-' + adminSubId) || uuid().substring(0, 8))
        .replace(/[^a-zA-Z0-9-]/g, '');

    var cvxSystemUrl = (vaccineCodeSys === 'CVX' || vaccineCodeSys === 'HL70292')
        ? CVX_SYSTEM
        : 'http://hospital.local/vaccines';

    var immunization = {
        resourceType: 'Immunization',
        id: immunizationId,
        meta: { profile: [US_CORE_IMMUNIZATION_PROFILE] },
        status: mapCompletionStatus(completionStatus),
        vaccineCode: {
            coding: [{ system: cvxSystemUrl, code: vaccineCvx, display: vaccineName }],
            text: vaccineName
        },
        patient: { reference: 'Patient/' + patientId },
        occurrenceDateTime: hl7DateToFhir(adminStartDt),
        primarySource: actionCode !== 'D',
        lotNumber: lotNumber || undefined,
        expirationDate: expirationDate && expirationDate.length >= 8
            ? expirationDate.substring(0,4)+'-'+expirationDate.substring(4,6)+'-'+expirationDate.substring(6,8)
            : undefined,
        manufacturer: mvxCode ? {
            identifier: { system: MVX_SYSTEM, value: mvxCode },
            display: mvxName
        } : undefined,
        doseQuantity: administeredAmt ? {
            value: parseFloat(administeredAmt),
            unit: administeredUnit,
            system: 'http://unitsofmeasure.org',
            code: administeredUnit
        } : undefined
    };

    // === Route site (RXR) ===
    if (rxrList[r] || (rxrList.length === 1 && r === 0)) {
        var rxr = rxrList[r] || rxrList[0];
        var route = safeGet(rxr, 'RXR\\.1.RXR\\.1\\.1');
        var routeName = safeGet(rxr, 'RXR\\.1.RXR\\.1\\.2');
        var site = safeGet(rxr, 'RXR\\.2.RXR\\.2\\.1');
        var siteName = safeGet(rxr, 'RXR\\.2.RXR\\.2\\.2');
        if (route) {
            immunization.route = {
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration',
                    code: route,
                    display: routeName
                }],
                text: routeName
            };
        }
        if (site) {
            immunization.site = {
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ActSite',
                    code: site,
                    display: siteName
                }],
                text: siteName
            };
        }
    }

    // === OBX attached to this RXA ===
    var education = [];
    var reactions = [];

    for (var o = 0; o < obxList.length; o++) {
        var obx = obxList[o];
        var obxSubId = safeGet(obx, 'OBX\\.4.OBX\\.4\\.1');
        // If OBX-4 is set, use it as the 1-based parent index. Otherwise
        // we attach OBX to the RXA at the same ordinal position (best-effort).
        var matchesThisRxa = false;
        if (obxSubId) {
            if (parseInt(obxSubId, 10) === (r + 1)) matchesThisRxa = true;
        } else {
            matchesThisRxa = (rxaList.length === 1);
        }
        if (!matchesThisRxa) continue;

        var obxCode = safeGet(obx, 'OBX\\.3.OBX\\.3\\.1');
        var obxName = safeGet(obx, 'OBX\\.3.OBX\\.3\\.2');
        var obxValue = safeGet(obx, 'OBX\\.5.OBX\\.5\\.1');

        // CDC VIS publication codes 30956-7 (VIS doc type) / 69764-9 (VIS pub date)
        if (obxCode === '69764-9' || obxCode === '30956-7' || obxCode === '29768-9') {
            education.push({
                documentType: obxName || obxCode,
                publicationDate: obxCode === '29768-9' ? hl7DateToFhir(obxValue) : undefined,
                presentationDate: obxCode === '69764-9' ? hl7DateToFhir(obxValue) : undefined
            });
        } else if (obxCode === '31044-1' || (obxName && obxName.toLowerCase().indexOf('reaction') >= 0)) {
            // Adverse reaction observation -- attach as immunization.reaction
            reactions.push({
                date: hl7DateToFhir(safeGet(obx, 'OBX\\.14.OBX\\.14\\.1')) || immunization.occurrenceDateTime,
                detail: { display: obxValue },
                reported: true
            });
        }
    }

    if (education.length) immunization.education = education;
    if (reactions.length) immunization.reaction = reactions;

    immunizations.push(immunization);
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

for (var k = 0; k < immunizations.length; k++) {
    bundle.entry.push({
        resource: immunizations[k],
        request: { method: 'PUT', url: 'Immunization/' + immunizations[k].id }
    });
}

// === Channel map ===
channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('patientId', patientId);
channelMap.put('immunizationCount', immunizations.length.toString());

logger.info(
    'VXU^V04 -> FHIR Immunization: Patient=' + firstName + ' ' + lastName +
    ' immunizations=' + immunizations.length +
    ' vaccines=[' + immunizations.map(function(i){return i.vaccineCode.coding[0].code;}).join(',') + ']'
);
