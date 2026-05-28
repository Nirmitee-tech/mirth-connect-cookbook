// Destination 3 transformer — format one CSV row to append to a file that
// Excel opens natively. CSV is the "Excel-friendly format you actually
// want" — pure .xlsx requires a library; CSV opens in Excel with a
// double-click, supports millions of rows, and merges cleanly across
// concurrent appenders.
//
// The File Writer destination is configured for mode=append, charsetEncoding=UTF-8,
// fileName=lab-results.csv, and uses this transformer's return value as the
// template content.

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    v = String(v);
    // RFC 4180: quote if contains comma, quote, or newline; double internal quotes.
    if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
        return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
}

var observations = JSON.parse(channelMap.get('observations'));

// Build a human-readable observation summary in one cell
var obsSummary = observations.map(function(o) {
    return o.label + '=' + o.value + (o.unit ? ' ' + o.unit : '') +
           (o.flag && o.flag !== 'N' ? '[' + o.flag + ']' : '');
}).join('; ');

var row = [
    new Date().toISOString(),                  // received_at
    channelMap.get('messageId'),
    channelMap.get('mrn'),
    channelMap.get('patientName'),
    channelMap.get('dob'),
    channelMap.get('sex'),
    channelMap.get('orderId'),
    channelMap.get('testCode'),
    channelMap.get('testName'),
    channelMap.get('orderingMD'),
    channelMap.get('hasAbnormal'),
    channelMap.get('apiStatus'),
    channelMap.get('apiAckId'),
    obsSummary
].map(csvEscape).join(',');

// Mirth's File Writer in append mode will write our template content
// verbatim followed by the line separator. We just return the row.
return row + '\n';
