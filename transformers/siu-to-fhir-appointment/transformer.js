/**
 * HL7v2 SIU^S12/S13/S14/S15 -> FHIR R4 Appointment Bundle
 *
 * Maps scheduling messages to FHIR Appointment + supporting resources.
 *   S12 -- New appointment booking          -> Appointment.status = booked
 *   S13 -- Appointment rescheduling         -> Appointment.status = booked (rescheduled)
 *   S14 -- Appointment modification         -> Appointment.status = booked
 *   S15 -- Appointment cancellation         -> Appointment.status = cancelled
 *   S17 -- Appointment deletion             -> Appointment.status = entered-in-error
 *   S26 -- Patient did not show / no-show   -> Appointment.status = noshow
 *
 * Input segments:
 *   MSH -- event type (drives status)
 *   SCH -- Scheduling activity (start/end/reason)
 *   PID -- Patient
 *   AIS -- Service information (procedure / visit type)
 *   AIG -- Resource info (practitioner)
 *   AIL -- Location
 *
 * Output: FHIR Transaction Bundle:
 *   - Patient
 *   - Practitioner    (from AIG, if present)
 *   - Location        (from AIL, if present)
 *   - Appointment
 *
 * Place in: Source Connector -> Transformer -> Add Step -> JavaScript
 *
 * Tested on: Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';
var FHIR_PRACTITIONER_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
var US_CORE_PATIENT_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient';
var US_CORE_PRACTITIONER_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner';
var US_CORE_LOCATION_PROFILE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-location';

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

function mapEventToStatus(eventCode) {
    var map = {
        'S12': 'booked',
        'S13': 'booked',
        'S14': 'booked',
        'S15': 'cancelled',
        'S16': 'cancelled',
        'S17': 'entered-in-error',
        'S18': 'cancelled',
        'S26': 'noshow'
    };
    return map[eventCode] || 'booked';
}

// === Extract MSH event ===
var triggerEvent = safeGet(msg, 'MSH.MSH\\.9.MSH\\.9\\.2');
var appointmentStatus = mapEventToStatus(triggerEvent);
var isRescheduled = (triggerEvent === 'S13');

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

// === Extract SCH ===
var placerApptId   = safeGet(msg, 'SCH.SCH\\.1.SCH\\.1\\.1');
var fillerApptId   = safeGet(msg, 'SCH.SCH\\.2.SCH\\.2\\.1');
var apptReasonCode = safeGet(msg, 'SCH.SCH\\.6.SCH\\.6\\.1');
var apptReasonText = safeGet(msg, 'SCH.SCH\\.6.SCH\\.6\\.2');
var apptTypeCode   = safeGet(msg, 'SCH.SCH\\.8.SCH\\.8\\.1');
var apptTypeText   = safeGet(msg, 'SCH.SCH\\.8.SCH\\.8\\.2');
var apptDurationStr = safeGet(msg, 'SCH.SCH\\.9.SCH\\.9\\.1');
var apptDurationUnits = safeGet(msg, 'SCH.SCH\\.10.SCH\\.10\\.1');
// SCH-11.4 = start, SCH-11.5 = end (TQ - Quantity/Timing)
var apptStartRaw = safeGet(msg, 'SCH.SCH\\.11.SCH\\.11\\.4');
var apptEndRaw   = safeGet(msg, 'SCH.SCH\\.11.SCH\\.11\\.5');

var apptId = placerApptId || fillerApptId || uuid();
var appointmentId = 'appt-' + apptId.replace(/[^a-zA-Z0-9-]/g, '');

var startIso = hl7DateToFhir(apptStartRaw);
var endIso = hl7DateToFhir(apptEndRaw);

// Compute end from start + duration if SCH-11.5 is empty
if (!endIso && startIso && apptDurationStr) {
    try {
        var minutes = parseInt(apptDurationStr, 10);
        if (apptDurationUnits === 'h') minutes = minutes * 60;
        if (apptDurationUnits === 'S' || apptDurationUnits === 's') minutes = minutes / 60;
        if (!isNaN(minutes)) {
            var startMs = new Date(startIso).getTime();
            endIso = new Date(startMs + minutes * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
    } catch (e) { /* ignore */ }
}

// === Extract AIS (Service) ===
var aisCode = safeGet(msg, 'AIS.AIS\\.3.AIS\\.3\\.1');
var aisName = safeGet(msg, 'AIS.AIS\\.3.AIS\\.3\\.2');
var aisSystem = safeGet(msg, 'AIS.AIS\\.3.AIS\\.3\\.3');

var serviceCodeSystem = (aisSystem === 'SCT' || aisSystem === 'SNOMED')
    ? 'http://snomed.info/sct'
    : 'http://hospital.local/services';

// === Extract AIG (Practitioner) ===
var practitioner = null;
var practitionerId = null;
var aig = msg['AIG'];
if (aig) {
    var aigNode = asArray(aig)[0];
    var resCode = safeGet(aigNode, 'AIG\\.3.AIG\\.3\\.1');
    var resName = safeGet(aigNode, 'AIG\\.3.AIG\\.3\\.2');
    var resType = safeGet(aigNode, 'AIG\\.4.AIG\\.4\\.1');
    if (resCode || resName) {
        practitionerId = 'prac-' + (resCode || uuid().substring(0, 8)).replace(/[^a-zA-Z0-9-]/g, '');
        practitioner = {
            resourceType: 'Practitioner',
            id: practitionerId,
            meta: { profile: [US_CORE_PRACTITIONER_PROFILE] },
            identifier: resCode ? [{
                use: 'official',
                system: FHIR_PRACTITIONER_SYSTEM,
                value: resCode
            }] : [],
            name: [{ use: 'official', text: resName || resCode }]
        };
    }
}

// === Extract AIL (Location) ===
var location = null;
var locationId = null;
var ail = msg['AIL'];
if (ail) {
    var ailNode = asArray(ail)[0];
    var locCode = safeGet(ailNode, 'AIL\\.3.AIL\\.3\\.1');
    var locName = safeGet(ailNode, 'AIL\\.3.AIL\\.3\\.2');
    var pointOfCare = safeGet(ailNode, 'AIL\\.3.AIL\\.3\\.1.AIL\\.3\\.1\\.1');
    if (locCode || locName || pointOfCare) {
        locationId = 'loc-' + ((locCode || pointOfCare || uuid().substring(0, 8))).replace(/[^a-zA-Z0-9-]/g, '');
        location = {
            resourceType: 'Location',
            id: locationId,
            meta: { profile: [US_CORE_LOCATION_PROFILE] },
            status: 'active',
            name: locName || locCode || pointOfCare,
            identifier: locCode ? [{ system: 'http://hospital.local/locations', value: locCode }] : []
        };
    }
}

// === Build Appointment ===
var appointment = {
    resourceType: 'Appointment',
    id: appointmentId,
    status: appointmentStatus,
    identifier: [
        placerApptId ? { use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PLAC' }] }, value: placerApptId } : null,
        fillerApptId ? { use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'FILL' }] }, value: fillerApptId } : null
    ].filter(function(x) { return x; }),
    serviceType: aisCode ? [{
        coding: [{ system: serviceCodeSystem, code: aisCode, display: aisName }],
        text: aisName
    }] : undefined,
    appointmentType: apptTypeCode ? {
        coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v2-0276',
            code: apptTypeCode,
            display: apptTypeText
        }],
        text: apptTypeText
    } : undefined,
    reasonCode: apptReasonCode ? [{
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0276', code: apptReasonCode, display: apptReasonText }],
        text: apptReasonText
    }] : undefined,
    start: startIso,
    end: endIso,
    participant: [
        {
            actor: { reference: 'Patient/' + patientId, display: (firstName + ' ' + lastName).trim() },
            required: 'required',
            status: appointmentStatus === 'cancelled' ? 'declined' : 'accepted'
        }
    ]
};

if (practitionerId) {
    appointment.participant.push({
        actor: { reference: 'Practitioner/' + practitionerId },
        required: 'required',
        status: 'accepted'
    });
}

if (locationId) {
    appointment.participant.push({
        actor: { reference: 'Location/' + locationId },
        required: 'required',
        status: 'accepted'
    });
}

if (isRescheduled) {
    appointment.comment = 'Rescheduled (SIU^S13)';
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

if (location) {
    bundle.entry.push({
        resource: location,
        request: { method: 'PUT', url: 'Location/' + locationId }
    });
}

bundle.entry.push({
    resource: appointment,
    request: { method: 'PUT', url: 'Appointment/' + appointmentId }
});

// === Channel map for downstream ===
channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('patientId', patientId);
channelMap.put('appointmentId', appointmentId);
channelMap.put('triggerEvent', triggerEvent);
channelMap.put('appointmentStatus', appointmentStatus);

logger.info(
    'SIU^' + triggerEvent + ' -> FHIR Appointment: id=' + appointmentId +
    ' status=' + appointmentStatus +
    ' patient=' + (firstName + ' ' + lastName).trim() +
    ' start=' + startIso + ' end=' + endIso +
    ' practitioner=' + (practitionerId || 'none') +
    ' location=' + (locationId || 'none')
);
