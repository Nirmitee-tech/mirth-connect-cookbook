/**
 * HL7v2 Batch Splitter — JavaScript batch script
 *
 * Place this in: Source Connector → HL7 v2.x → Batch tab → splitType = JavaScript
 *
 * Splits BHS/BTS-framed batches OR newline-delimited multi-message files
 * into individual MSH-framed messages.
 *
 * Captures BHS metadata into sourceMap so each split message can be tagged
 * with its parent batch ID (BHS-11 batch control ID).
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// `batch` is the input string (the entire batch file content)
// `xml` is the parsed XML representation if applicable (we use raw text)

var BHS_REGEX = /^BHS\|[^\r\n]+/m;
var BTS_REGEX = /^BTS\|[^\r\n]*$/m;
var MSH_REGEX = /^MSH\|[^\r\n]+/m;

// Extract BHS metadata once (if present)
var batchControlId = '';
var batchSendingApp = '';
var bhsMatch = batch.match(/^BHS\|([^\r\n]+)/m);
if (bhsMatch) {
    var bhsFields = bhsMatch[1].split('|');
    batchSendingApp = bhsFields[1] || '';  // BHS-3 sending app
    batchControlId  = bhsFields[10] || ''; // BHS-11 batch control ID
}

// Strip BHS/BTS framing if present (we only want the MSH blocks)
var body = batch
    .replace(/^BHS\|[^\r\n]+(\r\n?|\n)/m, '')
    .replace(/^BTS\|[^\r\n]*(\r\n?|\n)?$/m, '')
    .replace(/^FHS\|[^\r\n]+(\r\n?|\n)/m, '')
    .replace(/^FTS\|[^\r\n]*(\r\n?|\n)?$/m, '');

// Split on MSH-segment boundary
var parts = body.split(/(?=^MSH\|)/m);
var messages = [];

for (var i = 0; i < parts.length; i++) {
    var part = parts[i].replace(/^\s+|\s+$/g, '');
    if (part.length === 0) continue;
    if (part.indexOf('MSH|') !== 0) continue;

    // Tag each individual message with parent batch metadata via sourceMap
    // (sourceMap is shared with destination connectors after split)
    var sourceMapEntries = {
        'batchControlId': batchControlId,
        'batchSendingApp': batchSendingApp,
        'batchPosition': (messages.length + 1).toString()
    };

    messages.push({
        message: part,
        sourceMap: sourceMapEntries
    });
}

// Return list of individual messages (Mirth iterates over the return value)
return messages.map(function(m) { return m.message; });
