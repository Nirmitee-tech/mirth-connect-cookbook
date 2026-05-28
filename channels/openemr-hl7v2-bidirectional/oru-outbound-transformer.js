/**
 * OpenEMR ORU Outbound Transformer
 *
 * Builds an ORU^R01 lab-result message tailored for OpenEMR's HL7
 * receiver. Differences from a "generic" ORU:
 *
 *   - OpenEMR matches patients on PID-2 (external_id), not PID-3.
 *     Channel must write the patient MRN to PID-2 *and* PID-3 to
 *     survive both lookup paths.
 *   - OpenEMR rejects messages whose MSH-3 / MSH-4 don't match the
 *     interface registration. Configure via the Configuration Map.
 *   - OpenEMR's HL7 module is picky about field separators in OBX-5
 *     for repeated values — use '~' (HL7 repetition) not ',' or '\n'.
 *
 * Inputs (channelMap):
 *   labResultJson - JSON object {
 *      patient: { mrn, lastName, firstName, dob, gender },
 *      order:   { orderId, code, name, codingSystem },
 *      results: [{ loinc, name, value, units, refRange, abnormalFlag }],
 *      observationDate: 'YYYYMMDDHHmmss'
 *   }
 *
 * Outputs:
 *   outboundOru   - the HL7v2 message string (template = ${outboundOru})
 *
 * Tested on: Mirth Connect 4.5.2 with OpenEMR 7.0.2 HL7 module
 * Author: Nirmitee.io | License: MIT
 */

function pad(s, n) {
    s = '' + (s || '');
    while (s.length < n) s = '0' + s;
    return s;
}

function nowTs() {
    var d = new Date();
    return d.getFullYear() +
        pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
        pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
}

function escapeHL7(s) {
    if (s === null || s === undefined) return '';
    return ('' + s)
        .replace(/\\/g, '\\E\\')
        .replace(/\|/g, '\\F\\')
        .replace(/\^/g, '\\S\\')
        .replace(/~/g,  '\\R\\')
        .replace(/&/g,  '\\T\\');
}

var data = channelMap.get('labResultJson');
if (!data) {
    logger.error('channelMap.labResultJson is empty');
    return;
}

var lab = JSON.parse(data + '');

// === Configured sender/receiver — must match OpenEMR HL7 interface ===
var sendingApp      = $cfg('openemr.sending.app')      || 'MIRTH';
var sendingFacility = $cfg('openemr.sending.facility') || 'HUB';
var receivingApp    = $cfg('openemr.receiving.app')    || 'OPENEMR';
var receivingFacility = $cfg('openemr.receiving.facility') || 'CLINIC';

var ts = nowTs();
var ctrlId = 'ORU' + ts + Math.floor(Math.random() * 1000);

// MSH
var msh = ['MSH', '^~\\&',
    sendingApp, sendingFacility, receivingApp, receivingFacility,
    ts, '', 'ORU^R01^ORU_R01', ctrlId, 'P', '2.5.1'
].join('|');

// PID — OpenEMR quirk: write MRN to BOTH PID-2 and PID-3
var p = lab.patient || {};
var mrn = p.mrn || '';
var pid = ['PID',
    '1',                                                 // PID-1 set id
    escapeHL7(mrn),                                      // PID-2 OpenEMR external_id
    escapeHL7(mrn) + '^^^' + sendingFacility + '^MR',    // PID-3 standard MRN
    '',                                                  // PID-4 alternate
    escapeHL7(p.lastName || '') + '^' + escapeHL7(p.firstName || ''),  // PID-5
    '',                                                  // PID-6
    p.dob || '',                                         // PID-7
    p.gender || ''                                       // PID-8
].join('|');

// OBR
var o = lab.order || {};
var obr = ['OBR',
    '1',                                                 // OBR-1
    escapeHL7(o.orderId || ''),                          // OBR-2 placer
    '',                                                  // OBR-3 filler
    escapeHL7(o.code || '') + '^' + escapeHL7(o.name || '') + '^' + (o.codingSystem || 'LN'),
    '', '', lab.observationDate || ts, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'F'
].join('|');

// OBX (one per result; use '~' for repeating values in OBX-5)
var obxList = [];
var results = lab.results || [];
for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var obxVal;
    if (r.value && Array.isArray(r.value)) {
        // OpenEMR-safe: '~' separator for repeated values
        obxVal = r.value.map(escapeHL7).join('~');
    } else {
        obxVal = escapeHL7(r.value);
    }
    var valueType = (r.value && Array.isArray(r.value)) ? 'ST' :
                    (isNaN(parseFloat(r.value)) ? 'ST' : 'NM');
    var obx = ['OBX',
        '' + (i + 1),                                    // OBX-1 set id
        valueType,                                       // OBX-2 value type
        escapeHL7(r.loinc) + '^' + escapeHL7(r.name) + '^LN',  // OBX-3
        '',                                              // OBX-4 sub-id
        obxVal,                                          // OBX-5 value
        escapeHL7(r.units || ''),                        // OBX-6 units
        escapeHL7(r.refRange || ''),                     // OBX-7
        escapeHL7(r.abnormalFlag || ''),                 // OBX-8
        '', '',                                          // OBX-9, OBX-10
        'F'                                              // OBX-11 status
    ].join('|');
    obxList.push(obx);
}

var oruMessage = [msh, pid, obr].concat(obxList).join('\r') + '\r';
channelMap.put('outboundOru', oruMessage);
channelMap.put('oruControlId', ctrlId);

logger.info('OpenEMR ORU outbound built: ctrlId=' + ctrlId +
            ' patient=' + mrn +
            ' order=' + (o.orderId || '?') +
            ' observations=' + results.length);
