/**
 * FHIR R4 Bundle -> HL7v2 ADT^A01 (Reverse Mapping)
 *
 * Use case: a modern FHIR-native EHR / app needs to send patient admissions
 * to a legacy HIS that only speaks HL7v2 over MLLP. This transformer reads
 * the inbound FHIR Bundle (Patient + Encounter + optional Coverage +
 * Practitioner) and produces a fully-framed ADT^A01 message string.
 *
 * Place in: Source Connector (HTTP Listener, inbound message type = JSON)
 *           -> Transformer -> Add Step -> JavaScript.
 *
 * The transformer sets:
 *   tmp = the HL7v2 message string (so Mirth's outbound MLLP sees it)
 *   channelMap.put('hl7v2Message', ...) for downstream destinations
 *
 * Configuration constants near the top control sending app/facility,
 * MSH-9 trigger event, and field defaults.
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var SENDING_APP        = 'NIRMITEE-FHIR';
var SENDING_FACILITY   = 'NIRMITEE';
var RECEIVING_APP      = 'LEGACY-HIS';
var RECEIVING_FACILITY = 'HOSPITAL';
var HL7_VERSION        = '2.5.1';
var PROCESSING_ID      = 'P';   // P=production, D=debug, T=training
var DEFAULT_TRIGGER    = 'A01'; // overridable via channelMap('triggerEvent')

// === Helpers ===
function safe(v) { return (v === null || v === undefined) ? '' : ('' + v); }

function uuid() { return java.util.UUID.randomUUID().toString() + ''; }

function nowHl7() {
    // yyyyMMddHHmmss in UTC. We avoid Mirth's DateUtil to keep this portable
    // across test environments.
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getUTCFullYear()
        + pad(d.getUTCMonth() + 1)
        + pad(d.getUTCDate())
        + pad(d.getUTCHours())
        + pad(d.getUTCMinutes())
        + pad(d.getUTCSeconds());
}

function isoToHl7(iso) {
    if (!iso) return '';
    // Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(Z|+/-HHMM)
    var s = ('' + iso).replace(/[-:T]/g, '').replace(/Z$/, '').replace(/\.\d+/, '');
    // Strip timezone offset if present (everything after a + or - past pos 8)
    var plus = s.indexOf('+', 8);
    if (plus > 0) s = s.substring(0, plus);
    var minus = s.indexOf('-', 8);
    if (minus > 0) s = s.substring(0, minus);
    return s;
}

function genderToHl7(g) {
    var m = { 'male': 'M', 'female': 'F', 'other': 'O', 'unknown': 'U' };
    return m[(g || '').toLowerCase()] || 'U';
}

function findResource(bundle, type) {
    if (!bundle || !bundle.entry) return null;
    for (var i = 0; i < bundle.entry.length; i++) {
        var r = bundle.entry[i].resource;
        if (r && r.resourceType === type) return r;
    }
    return null;
}

function findAllResources(bundle, type) {
    var out = [];
    if (!bundle || !bundle.entry) return out;
    for (var i = 0; i < bundle.entry.length; i++) {
        var r = bundle.entry[i].resource;
        if (r && r.resourceType === type) out.push(r);
    }
    return out;
}

// Pull a resource by reference string like "Practitioner/abc-123"
function resolveReference(bundle, ref) {
    if (!ref || !bundle || !bundle.entry) return null;
    for (var i = 0; i < bundle.entry.length; i++) {
        var entry = bundle.entry[i];
        var r = entry.resource;
        if (!r) continue;
        if (entry.fullUrl === ref) return r;
        if ((r.resourceType + '/' + r.id) === ref) return r;
    }
    return null;
}

function pickIdentifier(identifiers, system) {
    if (!identifiers || !identifiers.length) return '';
    if (system) {
        for (var i = 0; i < identifiers.length; i++) {
            if (identifiers[i].system === system) return identifiers[i].value || '';
        }
    }
    return identifiers[0].value || '';
}

// === Parse inbound FHIR Bundle JSON ===
var bundle;
try {
    bundle = (typeof msg === 'string') ? JSON.parse(msg) : JSON.parse('' + msg);
} catch (e) {
    throw new Error('FHIR -> ADT: inbound message is not valid JSON: ' + e);
}

if (!bundle || bundle.resourceType !== 'Bundle') {
    throw new Error('FHIR -> ADT: expected a Bundle resource, got ' +
        (bundle ? bundle.resourceType : 'null'));
}

var patient      = findResource(bundle, 'Patient');
var encounter    = findResource(bundle, 'Encounter');
var coverage     = findResource(bundle, 'Coverage');
var practitioners = findAllResources(bundle, 'Practitioner');

if (!patient) {
    throw new Error('FHIR -> ADT: Bundle has no Patient resource');
}

// Trigger event override (channel map can set "triggerEvent" = "A03", "A04", etc.)
var triggerEvent = (typeof channelMap !== 'undefined' && channelMap.get('triggerEvent'))
    ? ('' + channelMap.get('triggerEvent'))
    : DEFAULT_TRIGGER;

var msgControlId = 'MSG' + uuid().replace(/-/g, '').substring(0, 18);
var nowTs = nowHl7();

// === Build MSH ===
var msh = [
    'MSH',
    '^~\\&',
    SENDING_APP,
    SENDING_FACILITY,
    RECEIVING_APP,
    RECEIVING_FACILITY,
    nowTs,
    '',                         // MSH-8 Security
    'ADT^' + triggerEvent + '^ADT_' + triggerEvent,
    msgControlId,
    PROCESSING_ID,
    HL7_VERSION
].join('|');

// === Build PID ===
var mrn = pickIdentifier(patient.identifier, null);
var officialName = (patient.name || []).filter(function(n){ return n.use === 'official'; })[0]
    || (patient.name || [])[0]
    || {};
var family = safe(officialName.family);
var given = (officialName.given || []).join(' ');

var dobIso = patient.birthDate || '';
var dobHl7 = dobIso ? dobIso.replace(/-/g, '') : '';

var addr = (patient.address || [])[0] || {};
var addrLine = (addr.line || []).join(' ');

var phone = '';
if (patient.telecom) {
    for (var t = 0; t < patient.telecom.length; t++) {
        if (patient.telecom[t].system === 'phone') {
            phone = patient.telecom[t].value || '';
            break;
        }
    }
}

var ethnicity = '';
var race = '';
if (patient.extension) {
    for (var x = 0; x < patient.extension.length; x++) {
        var ext = patient.extension[x];
        if (ext.url && ext.url.indexOf('us-core-race') >= 0 && ext.extension) {
            for (var y = 0; y < ext.extension.length; y++) {
                if (ext.extension[y].url === 'ombCategory' && ext.extension[y].valueCoding) {
                    race = ext.extension[y].valueCoding.code || '';
                }
            }
        }
        if (ext.url && ext.url.indexOf('us-core-ethnicity') >= 0 && ext.extension) {
            for (var z = 0; z < ext.extension.length; z++) {
                if (ext.extension[z].url === 'ombCategory' && ext.extension[z].valueCoding) {
                    ethnicity = ext.extension[z].valueCoding.code || '';
                }
            }
        }
    }
}

var pid = [
    'PID',
    '1',                                                  // PID-1 Set ID
    '',                                                   // PID-2 deprecated
    mrn + '^^^' + SENDING_FACILITY + '^MR',               // PID-3
    '',                                                   // PID-4 alternate IDs
    family + '^' + given,                                 // PID-5
    '',                                                   // PID-6 mother's maiden
    dobHl7,                                               // PID-7
    genderToHl7(patient.gender),                          // PID-8
    '',                                                   // PID-9 patient alias
    race,                                                 // PID-10
    safe(addrLine) + '^^' + safe(addr.city) + '^' + safe(addr.state) + '^' + safe(addr.postalCode) + '^' + safe(addr.country), // PID-11
    '',                                                   // PID-12 county code
    phone,                                                // PID-13 home phone
    '',                                                   // PID-14 business phone
    '',                                                   // PID-15 primary language
    safe(patient.maritalStatus && patient.maritalStatus.coding && patient.maritalStatus.coding[0] && patient.maritalStatus.coding[0].code), // PID-16
    '',                                                   // PID-17 religion
    safe(patient.id),                                     // PID-18 account number (best-effort)
    '',                                                   // PID-19 SSN
    '',                                                   // PID-20 driver's licence
    '',                                                   // PID-21 mother's identifier
    ethnicity                                             // PID-22 ethnic group
].join('|');

// === Build PV1 ===
//
// Encounter.class.code (ActCode) -> PV1-2 patient class:
//   AMB -> O (Outpatient), IMP -> I (Inpatient), EMER -> E (Emergency)
var pv1Class = 'U';
if (encounter) {
    var classCode = encounter.class && encounter.class.code;
    var classMap = { 'AMB': 'O', 'IMP': 'I', 'EMER': 'E', 'OBSENC': 'B', 'PRENC': 'P', 'SS': 'R', 'VR': 'O' };
    pv1Class = classMap[classCode] || 'U';
}

var assignedLocation = '';
if (encounter && encounter.location && encounter.location.length) {
    // FHIR Encounter.location[].location is a Reference -- best effort
    var locRef = encounter.location[0].location;
    var loc = locRef ? resolveReference(bundle, locRef.reference) : null;
    if (loc) {
        assignedLocation = safe(loc.name) + '^^^' + safe(loc.id);
    } else if (locRef && locRef.display) {
        assignedLocation = safe(locRef.display);
    }
}

var attendingDoc = '';
if (encounter && encounter.participant && encounter.participant.length) {
    for (var p = 0; p < encounter.participant.length; p++) {
        var part = encounter.participant[p];
        var typeCode = part.type && part.type[0] && part.type[0].coding && part.type[0].coding[0] && part.type[0].coding[0].code;
        if (typeCode === 'ATND' || typeCode === 'PPRF' || p === 0) {
            var pract = part.individual ? resolveReference(bundle, part.individual.reference) : null;
            if (pract) {
                var prFamily = pract.name && pract.name[0] && pract.name[0].family || '';
                var prGiven = pract.name && pract.name[0] && pract.name[0].given && pract.name[0].given.join(' ') || '';
                var prId = pickIdentifier(pract.identifier, 'http://hl7.org/fhir/sid/us-npi') || safe(pract.id);
                attendingDoc = prId + '^' + prFamily + '^' + prGiven;
                if (typeCode === 'ATND' || p === 0) break;
            } else if (part.individual && part.individual.display) {
                attendingDoc = part.individual.display;
            }
        }
    }
}

var visitNumber = encounter ? pickIdentifier(encounter.identifier, null) || safe(encounter.id) : '';
var admitDt = encounter && encounter.period && encounter.period.start ? isoToHl7(encounter.period.start) : '';
var dischargeDt = encounter && encounter.period && encounter.period.end ? isoToHl7(encounter.period.end) : '';

var pv1 = [
    'PV1',
    '1',                  // PV1-1 Set ID
    pv1Class,             // PV1-2 Patient Class
    assignedLocation,     // PV1-3 Assigned Patient Location
    '',                   // PV1-4 Admission Type
    '',                   // PV1-5 Preadmit Number
    '',                   // PV1-6 Prior Patient Location
    attendingDoc,         // PV1-7 Attending Doctor
    '',                   // PV1-8 Referring Doctor
    '',                   // PV1-9 Consulting Doctor
    '',                   // PV1-10 Hospital Service
    '',                   // PV1-11 Temporary Location
    '',                   // PV1-12 Preadmit Test Indicator
    '',                   // PV1-13 Readmission Indicator
    '',                   // PV1-14 Admit Source
    '',                   // PV1-15 Ambulatory Status
    '',                   // PV1-16 VIP Indicator
    '',                   // PV1-17 Admitting Doctor
    '',                   // PV1-18 Patient Type
    visitNumber,          // PV1-19 Visit Number
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    admitDt,              // PV1-44 Admit Date/Time
    dischargeDt           // PV1-45 Discharge Date/Time
].join('|');

// === Build IN1 (Coverage / Insurance) ===
var in1 = null;
if (coverage) {
    var payorName = '';
    if (coverage.payor && coverage.payor.length) {
        var payor = resolveReference(bundle, coverage.payor[0].reference);
        payorName = payor ? safe(payor.name) : safe(coverage.payor[0].display);
    }
    var planCode = '';
    if (coverage.class && coverage.class.length) {
        for (var c = 0; c < coverage.class.length; c++) {
            var clazz = coverage.class[c];
            var ctype = clazz.type && clazz.type.coding && clazz.type.coding[0] && clazz.type.coding[0].code;
            if (ctype === 'plan' || ctype === 'group') { planCode = safe(clazz.value); break; }
        }
    }
    in1 = [
        'IN1',
        '1',                                         // IN1-1 Set ID
        planCode,                                    // IN1-2 Insurance Plan ID
        '',                                          // IN1-3 Insurance Company ID
        payorName,                                   // IN1-4 Insurance Company Name
        '',                                          // IN1-5 Insurance Company Address
        '',                                          // IN1-6 Insurance Co Contact Person
        '',                                          // IN1-7 Insurance Co Phone
        safe(coverage.subscriberId || (coverage.subscriber && coverage.subscriber.reference)), // IN1-8 Group Number
        '',                                          // IN1-9 Group Name
        '', '', '', '', '', '', '',
        safe(coverage.subscriberId)                  // IN1-17 (varies by version; placeholder)
    ].join('|');
}

// === Assemble ===
var segments = [msh, pid, pv1];
if (in1) segments.push(in1);

var hl7 = segments.join('\r') + '\r';

// === Output ===
tmp = hl7;   // makes hl7 the outbound message body for downstream connectors
channelMap.put('hl7v2Message', hl7);
channelMap.put('messageControlId', msgControlId);
channelMap.put('triggerEvent', triggerEvent);
channelMap.put('patientMrn', mrn);
channelMap.put('encounterId', visitNumber);

logger.info(
    'FHIR -> HL7v2 ADT^' + triggerEvent + ': mrn=' + mrn +
    ' patient="' + given + ' ' + family + '"' +
    ' encounter=' + visitNumber +
    ' class=' + pv1Class +
    ' coverage=' + (coverage ? 'yes' : 'no') +
    ' msgId=' + msgControlId
);
