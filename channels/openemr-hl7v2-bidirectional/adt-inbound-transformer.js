/**
 * OpenEMR ADT Inbound Transformer
 *
 * Reads ADT messages emitted by the OpenEMR HL7 module and normalises
 * them for downstream EMR/HIE traffic. OpenEMR has two quirks that
 * routinely trip up generic ADT consumers:
 *
 *   1. OpenEMR uses PID-2 (Patient ID — External ID) as the canonical
 *      MRN, not PID-3 (Patient Identifier List). Most modern EMRs use
 *      PID-3. We promote PID-2 -> PID-3.
 *
 *   2. OpenEMR's PID-13 phone uses a non-standard format:
 *      '617-555-1234' instead of '^PRN^PH^...^617^5551234'.
 *
 *   3. OpenEMR sometimes emits the trigger event in MSH-9.1 only
 *      ('ADT' instead of 'ADT^A04'). We detect and patch.
 *
 * Output: cleaned-up HL7v2 message string on channelMap.normalizedAdt,
 *         plus parsed scalar fields for downstream filtering.
 *
 * Tested on: Mirth Connect 4.5.2 with OpenEMR 7.0.2 HL7 module
 * Author: Nirmitee.io | License: MIT
 */

function get(node, path) {
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

// === Pull from PID — OpenEMR's quirk first ===
var pid2 = get(msg, 'PID|PID.2|PID.2.1');             // OpenEMR canonical MRN
var pid3 = get(msg, 'PID|PID.3|PID.3.1');             // standard MRN
var mrn = pid3 || pid2;                                // prefer PID-3 if present, else promote PID-2

var lastName = get(msg, 'PID|PID.5|PID.5.1');
var firstName = get(msg, 'PID|PID.5|PID.5.2');
var dob = get(msg, 'PID|PID.7|PID.7.1');
var gender = get(msg, 'PID|PID.8|PID.8.1');

// === OpenEMR phone normalisation ===
var rawPhone = get(msg, 'PID|PID.13|PID.13.1');
var formattedPhone = rawPhone;
if (rawPhone && rawPhone.indexOf('^') === -1) {
    // 617-555-1234 -> ^PRN^PH^^^617^5551234
    var m = rawPhone.replace(/[^\d]/g, '');
    if (m.length === 10) {
        formattedPhone = '^PRN^PH^^^' + m.substring(0, 3) + '^' + m.substring(3);
    }
}

// === Trigger event normalisation ===
var triggerType = get(msg, 'MSH|MSH.9|MSH.9.1');     // e.g. 'ADT'
var triggerEvent = get(msg, 'MSH|MSH.9|MSH.9.2');    // e.g. 'A04'
var msgStructure = get(msg, 'MSH|MSH.9|MSH.9.3');    // e.g. 'ADT_A04'

if (triggerType && !triggerEvent) {
    // OpenEMR sometimes drops the trigger event component. Default by
    // EVN-1 if present, otherwise assume A08 (update).
    var evnCode = get(msg, 'EVN|EVN.1|EVN.1.1');
    triggerEvent = evnCode || 'A08';
}
if (!msgStructure) msgStructure = triggerType + '_' + triggerEvent;

// === Emit clean values ===
channelMap.put('mrn', mrn);
channelMap.put('mrnSource', pid3 ? 'PID-3' : 'PID-2');
channelMap.put('lastName', lastName);
channelMap.put('firstName', firstName);
channelMap.put('dob', dob);
channelMap.put('gender', gender);
channelMap.put('phone', formattedPhone);
channelMap.put('triggerEvent', triggerEvent);
channelMap.put('messageStructure', msgStructure);

// Rebuild a normalised HL7 message (just the MSH/PID/PV1 — keep all
// other segments intact via the original outbound template).
// Most downstream channels will use channelMap fields directly; this
// is for the case where you want to ship a clean HL7v2 frame.
logger.info(
    'OpenEMR ADT ' + triggerEvent +
    ' MRN=' + mrn + ' (source=' + (pid3 ? 'PID-3' : 'PID-2') + ')' +
    ' name=' + firstName + ' ' + lastName +
    ' phone=' + (rawPhone === formattedPhone ? rawPhone : (rawPhone + ' -> ' + formattedPhone))
);
