/**
 * Epic Bridges DFT^P03 Outbound Transformer
 *
 * Builds a DFT^P03 (Detailed Financial Transaction) message from a charge
 * list in channelMap.charges and writes the formatted HL7 to channelMap
 * as 'outboundDFT' for the TCP Sender destination.
 *
 * Input shape (channelMap.charges, JSON string):
 *   [{
 *      "patientMrn": "PAT-12345",
 *      "csn":        "V-DEMO-1",
 *      "lastName":   "Smith",
 *      "firstName":  "John",
 *      "dob":        "19850315",
 *      "gender":     "M",
 *      "visitNum":   "V-DEMO-1",
 *      "departmentCode": "ICU",
 *      "lines": [
 *         { "cptCode": "99291", "description": "Critical Care 30-74 min",
 *           "amount": "295.00", "qty": "1", "serviceDate": "20260528" }
 *      ]
 *   }]
 *
 * Tested on: Mirth Connect 4.5.2 with Epic 2024 Bridges DFT inbound
 * Author: Nirmitee.io | License: MIT
 */

function pad(s, n) {
    s = '' + (s || '');
    while (s.length < n) s = '0' + s;
    return s;
}

function ts() {
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

var chargesJson = channelMap.get('charges');
if (!chargesJson) {
    logger.error('channelMap.charges is empty - skipping DFT build');
    channelMap.put('outboundDFT', '');
    return;
}

var charges = JSON.parse(chargesJson + '');
if (!charges || charges.length === 0) {
    channelMap.put('outboundDFT', '');
    return;
}

var sendingApp = $cfg('epic.sending.app') || 'MIRTH';
var sendingFac = $cfg('epic.sending.facility') || 'HUB';
var receivingApp = $cfg('epic.receiving.app') || 'EPIC';
var receivingFac = $cfg('epic.receiving.facility') || 'BRIDGES';

var allMessages = [];

for (var i = 0; i < charges.length; i++) {
    var c = charges[i];
    var ctrlId = 'DFT' + ts() + pad(i, 3);
    var nowTs = ts();

    var msh = ['MSH', '^~\\&',
        sendingApp, sendingFac, receivingApp, receivingFac,
        nowTs, '',
        'DFT^P03^DFT_P03',
        ctrlId, 'P', '2.5.1'].join('|');

    var evn = ['EVN', 'P03', nowTs].join('|');

    var pid = ['PID', '1', '',
        escapeHL7(c.patientMrn) + '^^^EPIC^MR',
        '',
        escapeHL7(c.lastName) + '^' + escapeHL7(c.firstName),
        '', c.dob || '', c.gender || ''
    ].join('|');

    var pv1 = ['PV1', '1', 'I',
        escapeHL7(c.departmentCode || 'UNK'),
        '', '', '', '', '', '',
        '', '', '', '', '', '', '', '', '',
        escapeHL7(c.csn || c.visitNum || '')
    ].join('|');

    var ft1Lines = [];
    for (var li = 0; li < c.lines.length; li++) {
        var ln = c.lines[li];
        var ft1 = ['FT1',
            '' + (li + 1),                              // FT1-1 set id
            '',                                          // FT1-2
            'TXN' + ctrlId + pad(li, 3),                // FT1-3 transaction id
            '',                                          // FT1-4
            ln.serviceDate || nowTs.substring(0, 8),    // FT1-5 transaction date
            ln.postingDate || nowTs.substring(0, 8),    // FT1-6 posting date
            'CG',                                        // FT1-7 transaction type
            escapeHL7(ln.cptCode) + '^' + escapeHL7(ln.description) + '^CPT4',  // FT1-8 transaction code
            '',                                          // FT1-9 transaction description
            '',                                          // FT1-10 transaction description alt
            ln.qty || '1',                              // FT1-11 transaction quantity
            ln.amount,                                   // FT1-12 transaction amount extended
            ln.unitPrice || ln.amount,                  // FT1-13 transaction amount unit
            escapeHL7(c.departmentCode || 'UNK')        // FT1-14 department code
        ].join('|');
        ft1Lines.push(ft1);
    }

    var segments = [msh, evn, pid, pv1].concat(ft1Lines);
    allMessages.push(segments.join('\r') + '\r');
}

var outbound = allMessages.join('');
channelMap.put('outboundDFT', outbound);
channelMap.put('dftMessageCount', '' + charges.length);
logger.info('Built DFT^P03 messages: ' + charges.length);
