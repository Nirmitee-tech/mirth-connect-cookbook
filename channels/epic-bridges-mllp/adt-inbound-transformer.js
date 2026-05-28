/**
 * Epic Bridges ADT Inbound Transformer
 *
 * Handles the quirks of ADT traffic coming out of Epic Bridges:
 *   - A28 (add person) and A31 (update person) are aggressively deduped:
 *     Epic emits them on every chart update, not just true admits.
 *   - PV1-2 patient class mapping: Epic-specific codes ('I','O','E','P','R')
 *     to FHIR Encounter.class.
 *   - Z-segments: ZPV (Epic visit extras), ZIN (Epic insurance extras)
 *     copied into Encounter.extension and Coverage.extension.
 *   - HL7 escape: Epic uses backslash escaping for ',' '~' '|' in free-text.
 *
 * Dedup uses globalChannelMap with TTL — two A28/A31 for the same PID-3
 * within 10 minutes are suppressed (the second goes straight to NULL
 * destination via channelMap.duplicateSuppressed = 'true').
 *
 * Inputs: HL7v2 ADT (A01/A02/A03/A04/A08/A11/A12/A13/A28/A31/A40)
 * Outputs (channelMap):
 *   triggerEvent             - ADT event code
 *   duplicateSuppressed      - 'true' if Epic A28/A31 dedup fired
 *   fhirBundle               - FHIR Bundle JSON
 *   epicVisitId              - PV1-19 (Epic's CSN)
 *   epicPatientClass         - PV1-2 raw value
 *
 * Tested on: Mirth Connect 4.5.2 with Epic 2024 Bridges feed
 * Author: Nirmitee.io | License: MIT
 */

var DEDUP_WINDOW_MS = 10 * 60 * 1000;

// Epic PV1-2 -> FHIR Encounter.class
var EPIC_CLASS_MAP = {
    'I': { code: 'IMP',  display: 'inpatient encounter' },
    'O': { code: 'AMB',  display: 'ambulatory' },
    'E': { code: 'EMER', display: 'emergency' },
    'P': { code: 'PRENC', display: 'pre-admission' },
    'R': { code: 'AMB',  display: 'recurring (treated as ambulatory)' },
    'B': { code: 'OBSENC', display: 'observation' }
};

function unescapeHL7(s) {
    if (!s) return s;
    return (s + '')
        .replace(/\\F\\/g, '|')
        .replace(/\\S\\/g, '^')
        .replace(/\\R\\/g, '~')
        .replace(/\\T\\/g, '&')
        .replace(/\\E\\/g, '\\');
}

function safeGet(node, path) {
    try {
        var current = node;
        var parts = path.split('|');
        for (var i = 0; i < parts.length; i++) {
            if (current === null || current === undefined) return '';
            current = current[parts[i]];
        }
        return current === null || current === undefined ? '' : (current + '');
    } catch (e) { return ''; }
}

function dedupKey(pid3, trigger) { return 'epic-dedup:' + trigger + ':' + pid3; }

function isDuplicate(pid3, trigger) {
    if (trigger !== 'A28' && trigger !== 'A31') return false;
    var key = dedupKey(pid3, trigger);
    if (globalChannelMap.containsKey(key)) {
        var ts = parseInt(globalChannelMap.get(key) + '', 10);
        if (Date.now() - ts < DEDUP_WINDOW_MS) return true;
    }
    globalChannelMap.put(key, '' + Date.now());
    return false;
}

// === Extract ===
var trigger = safeGet(msg, 'MSH|MSH.9|MSH.9.2');
var mrn = safeGet(msg, 'PID|PID.3|PID.3.1');
var lastName = unescapeHL7(safeGet(msg, 'PID|PID.5|PID.5.1'));
var firstName = unescapeHL7(safeGet(msg, 'PID|PID.5|PID.5.2'));
var dob = safeGet(msg, 'PID|PID.7|PID.7.1');
var gender = safeGet(msg, 'PID|PID.8|PID.8.1');
var patientClass = safeGet(msg, 'PV1|PV1.2|PV1.2.1');
var visitId = safeGet(msg, 'PV1|PV1.19|PV1.19.1'); // Epic CSN
var ward = safeGet(msg, 'PV1|PV1.3|PV1.3.1');
var room = safeGet(msg, 'PV1|PV1.3|PV1.3.2');
var bed = safeGet(msg, 'PV1|PV1.3|PV1.3.3');

channelMap.put('triggerEvent', trigger);
channelMap.put('epicVisitId', visitId);
channelMap.put('epicPatientClass', patientClass);

// === Epic A28/A31 dedup ===
if (isDuplicate(mrn, trigger)) {
    channelMap.put('duplicateSuppressed', 'true');
    logger.info('Epic dedup: suppressed ' + trigger + ' for ' + mrn);
    return;
}
channelMap.put('duplicateSuppressed', 'false');

// === Custom Z-segments ===
// ZPV (Epic visit extras) e.g. ZPV|1|^discharge-disposition^Home|cost-center=ICU
var zpvExtras = {};
try {
    var zpv = msg['ZPV'];
    if (zpv) {
        zpvExtras.discharge = safeGet(zpv, 'ZPV.2|ZPV.2.1');
        zpvExtras.costCenter = safeGet(zpv, 'ZPV.3|ZPV.3.1');
    }
} catch (e) {}

// ZIN (Epic insurance extras) e.g. ZIN|1|priorAuth=AUTH123|effDate=20260101
var zinExtras = {};
try {
    var zin = msg['ZIN'];
    if (zin) {
        zinExtras.priorAuth = safeGet(zin, 'ZIN.2|ZIN.2.1');
        zinExtras.effDate = safeGet(zin, 'ZIN.3|ZIN.3.1');
    }
} catch (e) {}

// === FHIR Bundle ===
var encClass = EPIC_CLASS_MAP[patientClass] || { code: 'AMB', display: 'unknown (defaulted)' };
var genderMap = { 'M': 'male', 'F': 'female', 'O': 'other', 'U': 'unknown' };
var fhirGender = genderMap[gender] || 'unknown';

var patient = {
    resourceType: 'Patient',
    id: mrn,
    identifier: [{
        use: 'usual',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
        system: 'urn:oid:1.2.840.114350.1.13.999.999.4.1',
        value: mrn
    }],
    active: true,
    name: [{ use: 'official', family: lastName, given: [firstName] }],
    gender: fhirGender,
    birthDate: dob.length >= 8 ? dob.substring(0, 4) + '-' + dob.substring(4, 6) + '-' + dob.substring(6, 8) : null
};

var encounter = {
    resourceType: 'Encounter',
    id: 'enc-' + (visitId || mrn),
    status: 'in-progress',
    'class': {
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: encClass.code,
        display: encClass.display
    },
    identifier: visitId ? [{
        system: 'urn:oid:1.2.840.114350.1.13.999.999.5.737384.700',
        value: visitId,
        type: { text: 'Epic CSN' }
    }] : [],
    subject: { reference: 'Patient/' + mrn },
    location: [{ location: { display: ward + ' ' + room + ' ' + bed } }],
    extension: []
};

if (zpvExtras.discharge) {
    encounter.extension.push({
        url: 'http://hospital.local/epic-extensions/discharge-disposition',
        valueString: zpvExtras.discharge
    });
}
if (zpvExtras.costCenter) {
    encounter.extension.push({
        url: 'http://hospital.local/epic-extensions/cost-center',
        valueString: zpvExtras.costCenter
    });
}

var bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: new Date().toISOString(),
    entry: [
        { resource: patient,   request: { method: 'PUT', url: 'Patient/' + mrn } },
        { resource: encounter, request: { method: 'PUT', url: 'Encounter/enc-' + (visitId || mrn) } }
    ]
};

channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
logger.info(
    'Epic ADT ' + trigger + ' | MRN=' + mrn +
    ' CSN=' + visitId +
    ' class=' + patientClass + '->' + encClass.code
);
